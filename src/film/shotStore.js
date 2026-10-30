'use strict';
/**
 * Shot store with attempt quarantine. An approved shot is NEVER silently overwritten:
 *
 *   shots/<shot_id>/attempt_001/ attempt_002/ ...   every try, kept for debugging
 *   shots/<shot_id>/approved/                        hard links to the canonical attempt's files
 *   shots/<shot_id>/approved.json                    pointer: which attempt is canonical + sha256s
 *   shots/<shot_id>/superseded/<n>/                  previous canonical versions (explicit regenerate only)
 */
const fs = require('fs');
const path = require('path');
const { ensureDir, writeJson, readJson, sha256File, pad } = require('./util');

const CANON_FILES = ['video.mp4', 'end_frame.png', 'end_m1.png', 'end_m3.png', 'validation.json', 'generation.json', 'provider.meta.json'];

class ShotStore {
  constructor(filmDir) { this.root = ensureDir(path.join(filmDir, 'shots')); }
  dir(id) { return ensureDir(path.join(this.root, id)); }
  attemptNumbers(id) { const d = this.dir(id); return fs.readdirSync(d).filter(n => /^attempt_\d+$/.test(n)).map(n => Number(n.slice(8))).sort((a, b) => a - b); }
  nextAttempt(id) { const n = (this.attemptNumbers(id).pop() || 0) + 1; const dir = ensureDir(path.join(this.dir(id), `attempt_${pad(n)}`)); return { n, dir }; }
  attemptDir(id, n) { return path.join(this.dir(id), `attempt_${pad(n)}`); }

  approve(id, n, { supersede = false } = {}) {
    const base = this.dir(id), ptr = path.join(base, 'approved.json'), cur = readJson(ptr);
    if (cur) {
      if (!supersede) throw new Error(`refusing to overwrite approved shot ${id} (attempt ${cur.attempt}); use supersede`);
      const k = fs.existsSync(path.join(base, 'superseded')) ? fs.readdirSync(path.join(base, 'superseded')).length + 1 : 1;
      const dest = ensureDir(path.join(base, 'superseded', String(k)));
      fs.renameSync(path.join(base, 'approved'), path.join(dest, 'approved')); fs.renameSync(ptr, path.join(dest, 'approved.json'));
    }
    const src = this.attemptDir(id, n), dst = ensureDir(path.join(base, 'approved')), files = {};
    for (const f of CANON_FILES) {
      const s = path.join(src, f); if (!fs.existsSync(s)) continue;
      const d = path.join(dst, f); try { fs.linkSync(s, d); } catch { fs.copyFileSync(s, d); }
      files[f] = sha256File(d);
    }
    if (!files['video.mp4']) throw new Error(`attempt ${n} of ${id} has no video.mp4`);
    const rec = { shot_id: id, attempt: n, approved_at: new Date().toISOString(), files };
    writeJson(ptr, rec); return rec;
  }
  approvedRecord(id) { return readJson(path.join(this.dir(id), 'approved.json')); }

  /** Cheap integrity check (exists + sha256). Full decode is done at generation time, not on every resume. */
  getApproved(id) {
    const rec = this.approvedRecord(id); if (!rec) return null;
    const d = path.join(this.dir(id), 'approved');
    for (const [f, h] of Object.entries(rec.files)) { const p = path.join(d, f); if (!fs.existsSync(p) || sha256File(p) !== h) return null; }
    const p = (f) => rec.files[f] ? path.join(d, f) : null;
    return { ...rec, video: p('video.mp4'), end_frame: p('end_frame.png'), support_frames: [p('end_m1.png'), p('end_m3.png')].filter(Boolean), dir: d };
  }
}
module.exports = { ShotStore };
