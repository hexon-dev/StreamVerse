'use strict';
/**
 * IP registry + canonical references.
 *
 *   ip/registry.json                                  id sequence + index
 *   ip/characters/VANTA-CHAR-KAI-001/character.json    CANONICAL data (never mutated by a film)
 *                                    master_reference.png front.png three_quarter.png side.png full_body.png
 *                                    expressions/ wardrobe/ poses/
 *   ip/locations/VANTA-LOC-...-NNN/{location.json,reference.png}
 *   ip/props/VANTA-PROP-...-NNN/{prop.json,reference.png}
 *
 * Canonical (must stay stable) vs film state (changes during a film) is enforced: films get a
 * frozen copy of canonical data; only `IpRegistry.updateCanonical` can change it, and it records
 * a revision. Reuse: ensureX with an existing key returns the SAME id and refs.
 */
const fs = require('fs');
const path = require('path');
const { slug, pad, ensureDir, writeJson, readJson, sha256File, stableStringify, sha256, mapLimit } = require('./util');

const TYPES = { character: { code: 'CHAR', dir: 'characters', file: 'character.json' }, location: { code: 'LOC', dir: 'locations', file: 'location.json' }, prop: { code: 'PROP', dir: 'props', file: 'prop.json' } };
const CHAR_VIEWS = ['front', 'three_quarter', 'side', 'full_body'];

class IpRegistry {
  constructor(root) { this.root = ensureDir(root); this.indexFile = path.join(root, 'registry.json'); }
  _index() { return readJson(this.indexFile, { seq: {}, items: {} }); }
  _dir(type, id) { return path.join(this.root, TYPES[type].dir, id); }

  /** Get-or-create. Same (type,key) always yields the same id. */
  ensure(type, key, canonical) {
    const idx = this._index(); const k = `${type}:${slug(key)}`;
    if (idx.items[k]) return this.get(type, idx.items[k]);
    idx.seq[type] = (idx.seq[type] || 0) + 1;
    const id = `VANTA-${TYPES[type].code}-${slug(key)}-${pad(idx.seq[type])}`;
    idx.items[k] = id; writeJson(this.indexFile, idx);
    const dir = ensureDir(this._dir(type, id));
    const data = { [`${type}_id`]: id, key: slug(key), revision: 1, ...canonical, references: {} };
    writeJson(path.join(dir, TYPES[type].file), data);
    return { id, dir, data };
  }
  get(type, id) { const dir = this._dir(type, id); return { id, dir, data: readJson(path.join(dir, TYPES[type].file)) }; }
  find(type, key) { const id = this._index().items[`${type}:${slug(key)}`]; return id ? this.get(type, id) : null; }
  list(type) { const idx = this._index(); return Object.entries(idx.items).filter(([k]) => k.startsWith(type + ':')).map(([, id]) => this.get(type, id)); }

  /** The ONLY way canonical data changes. Bumps revision. */
  updateCanonical(type, id, patch) {
    const { dir, data } = this.get(type, id);
    const next = { ...data, ...patch, references: data.references, revision: data.revision + 1 };
    writeJson(path.join(dir, TYPES[type].file), next); return next;
  }
  _setRef(type, id, name, file) {
    const { dir, data } = this.get(type, id);
    data.references[name] = { path: path.relative(dir, file), sha256: sha256File(file) };
    writeJson(path.join(dir, TYPES[type].file), data);
  }
  /** Hash of the canonical fields only (excludes references + revision). */
  canonicalHash(type, id) { const { data } = this.get(type, id); const { references, revision, ...canon } = data; return sha256(stableStringify(canon)); }
  refPath(type, id, name) { const { dir, data } = this.get(type, id); const r = data.references[name]; if (!r) return null; const p = path.join(dir, r.path); return fs.existsSync(p) ? p : null; }
}

const characterPrompt = (c, view) => {
  const k = c.canonical || c;
  return `${view.replace('_', ' ')} view of ${c.name}: ${c.description || ''}. ${k.age_representation || ''}. Hair: ${k.hair}. Eyes: ${k.eyes}. Face: ${k.face}. Body: ${k.body}. Distinguishing marks: ${k.marks}. Wearing: ${k.wardrobe_default}. Neutral background, consistent identity.`;
};

class AssetPipeline {
  constructor({ registry, image, concurrency = 3, log = () => {} }) { Object.assign(this, { registry, image, concurrency, log }); }

  async _gen(kind, key, prompt, out, referenceImages = []) {
    if (fs.existsSync(out) && fs.statSync(out).size > 100) return { path: out, cached: true };   // cache reuse
    const r = await this.image.generate({ kind, key, prompt, referenceImages, out }); return { path: r.path, cached: false };
  }

  /** master first (identity anchor), then the other views conditioned on it, in parallel. */
  async ensureCharacter(ch) {
    const { id, dir } = this.registry.ensure('character', ch.key, { name: ch.name, role: ch.role, description: ch.description, canonical: ch.canonical });
    const master = await this._gen('character_master', ch.key, characterPrompt(ch, 'master portrait'), path.join(dir, 'master_reference.png'));
    this.registry._setRef('character', id, 'master_reference', master.path);
    const views = await mapLimit(CHAR_VIEWS, this.concurrency, (v) => this._gen(`character_${v}`, ch.key, characterPrompt(ch, v), path.join(dir, `${v}.png`), [master.path]));
    CHAR_VIEWS.forEach((v, i) => this.registry._setRef('character', id, v, views[i].path));
    return { id, generated: [master, ...views].filter(x => !x.cached).length };
  }
  async ensureExpression(charId, ch, expression) {
    const { dir } = this.registry.get('character', charId); const master = this.registry.refPath('character', charId, 'master_reference');
    const r = await this._gen('character_expression', ch.key, `${characterPrompt(ch, 'close')} Expression: ${expression}.`, path.join(dir, 'expressions', `${slug(expression)}.png`), [master]);
    this.registry._setRef('character', charId, `expression_${slug(expression)}`, r.path); return r.path;
  }
  async ensureWardrobe(charId, ch, wardrobeText) {
    const { dir } = this.registry.get('character', charId); const master = this.registry.refPath('character', charId, 'master_reference');
    const name = slug(wardrobeText).slice(0, 40);
    const r = await this._gen('character_wardrobe', ch.key, `${ch.name} full body wearing: ${wardrobeText}. Same face and body as reference.`, path.join(dir, 'wardrobe', `${name}.png`), [master]);
    this.registry._setRef('character', charId, `wardrobe_${name}`, r.path); return { name, path: r.path };
  }
  async ensureLocation(loc) {
    const { id, dir } = this.registry.ensure('location', loc.key, { name: loc.name, description: loc.description });
    const r = await this._gen('location', loc.key, `${loc.name}: ${loc.description}. Establishing reference, no people.`, path.join(dir, 'reference.png'));
    this.registry._setRef('location', id, 'reference', r.path); return { id, generated: r.cached ? 0 : 1 };
  }
  async ensureProp(prop) {
    const { id, dir } = this.registry.ensure('prop', prop.key, { name: prop.name, description: prop.description });
    const r = await this._gen('prop', prop.key, `${prop.name}: ${prop.description}. Isolated on neutral background.`, path.join(dir, 'reference.png'));
    this.registry._setRef('prop', id, 'reference', r.path); return { id, generated: r.cached ? 0 : 1 };
  }

  /** Characters/locations/props are independent of one another -> bounded parallelism is safe here. */
  async ensureAll(bible) {
    const map = { characters: {}, locations: {}, props: {} }; let generated = 0;
    const jobs = [
      ...bible.characters.map(c => ({ t: 'characters', k: c.key, f: () => this.ensureCharacter(c) })),
      ...bible.locations.map(l => ({ t: 'locations', k: l.key, f: () => this.ensureLocation(l) })),
      ...(bible.props || []).map(p => ({ t: 'props', k: p.key, f: () => this.ensureProp(p) })),
    ];
    const res = await mapLimit(jobs, this.concurrency, j => j.f());
    jobs.forEach((j, i) => { map[j.t][j.k] = res[i].id; generated += res[i].generated; });
    return { ids: map, generated };
  }
}

module.exports = { IpRegistry, AssetPipeline, CHAR_VIEWS, TYPES };
