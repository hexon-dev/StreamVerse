'use strict';
/** Small deterministic helpers shared by the film engine. No external deps. */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const sha256 = (bufOrStr) => crypto.createHash('sha256').update(bufOrStr).digest('hex');
const sha256File = (file) => sha256(fs.readFileSync(file));
const slug = (s) => String(s).toUpperCase().replace(/[^A-Z0-9]+/g, '-').replace(/^-+|-+$/g, '');
const pad = (n, w = 3) => String(n).padStart(w, '0');

function ensureDir(d) { fs.mkdirSync(d, { recursive: true }); return d; }

/** Atomic JSON write: never leaves a half-written state file after a crash. */
function writeJson(file, obj) {
  ensureDir(path.dirname(file));
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2));
  fs.renameSync(tmp, file);
}
function readJson(file, dflt = null) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { if (e.code === 'ENOENT') return dflt; throw e; }
}

/** Stable JSON (sorted keys) so hashes of canonical data are reproducible. */
function stableStringify(v) {
  if (Array.isArray(v)) return '[' + v.map(stableStringify).join(',') + ']';
  if (v && typeof v === 'object') return '{' + Object.keys(v).sort().map(k => JSON.stringify(k) + ':' + stableStringify(v[k])).join(',') + '}';
  return JSON.stringify(v);
}
const deepClone = (o) => (o === undefined ? undefined : JSON.parse(JSON.stringify(o)));

/** mulberry32 — seedable RNG so "random" production choices are reproducible. */
function rng(seed) {
  let a = (typeof seed === 'number' ? seed : parseInt(sha256(String(seed)).slice(0, 8), 16)) >>> 0;
  return () => { a |= 0; a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

/** Bounded concurrency for INDEPENDENT work only (assets). Order of results preserved. */
async function mapLimit(items, limit, fn) {
  const out = new Array(items.length); let next = 0;
  const worker = async () => { while (true) { const i = next++; if (i >= items.length) return; out[i] = await fn(items[i], i); } };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker));
  return out;
}

/** Append-only structured event log (one JSON object per line). */
class EventLog {
  constructor(file) { this.file = file; ensureDir(path.dirname(file)); }
  emit(type, data = {}) {
    const rec = { t: new Date().toISOString(), type, ...data };
    fs.appendFileSync(this.file, JSON.stringify(rec) + '\n');
    return rec;
  }
  read() { try { return fs.readFileSync(this.file, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)); } catch { return []; } }
}

module.exports = { sha256, sha256File, slug, pad, ensureDir, writeJson, readJson, stableStringify, deepClone, rng, mapLimit, EventLog };
