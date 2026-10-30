'use strict';
/**
 * Fresh brief selection: every generation gets a NEW theme and a NEW concrete threat.
 * Deterministic (seeded) and history-aware, so consecutive films never repeat a theme,
 * and threat *types* rotate. The brief is the input to story generation; the LLM
 * supplies the creative detail, this module guarantees variety and concreteness.
 */
const path = require('path');
const { rng, readJson, writeJson, slug } = require('./util');

const THEMES = [
  'trust is the first thing a crisis destroys', 'what we owe the people we abandon', 'progress that quietly erases someone',
  'the price of keeping a promise', 'inherited guilt and who pays for it', 'loyalty tested by survival',
  'the comfort of a lie versus the cost of the truth', 'grief that refuses to stay buried', 'ambition that consumes its own foundation',
  'community fractures under pressure', 'a second chance that demands a sacrifice', 'the harm done by well-meant secrets',
  'technology that keeps its promises too literally', 'reconciliation after an unforgivable act', 'courage measured by what you give up',
  'memory as evidence and as weapon', 'isolation that turns into solidarity', 'the debt a place holds over its people',
];
const THREATS = [
  { type: 'entity',       seeds: ['a thing in the flooded lower levels that mimics voices', 'a swarm-intelligence made of scrap drones'] , clock: 'it reaches the sealed doors at dawn' },
  { type: 'person',       seeds: ['a former safety inspector who has decided the building must not be saved', 'a courier carrying something he intends to release at midnight'], clock: 'the deadline he gave them expires at midnight' },
  { type: 'phenomenon',   seeds: ['a blackout front that moves street by street and kills anything electronic', 'a fog that erases anything it covers from memory'], clock: 'the front reaches the last shelter in one hour' },
  { type: 'device',       seeds: ['an automated dam release scheduled to run regardless of who is below', 'a sealed cargo unit counting down to a pressure failure'], clock: 'the countdown ends in ninety minutes' },
  { type: 'disaster',     seeds: ['a chain of failing structures collapsing towards the town centre', 'a wildfire driven towards the only evacuation road'], clock: 'the road closes when the fire crests the ridge' },
  { type: 'hazard_place', seeds: ['a sinking transit tunnel that fills a section at a time', 'an orbital habitat losing air ring by ring'], clock: 'the last airtight ring seals in two hours' },
  { type: 'organization', seeds: ['a private crew paid to erase every witness of an accident', 'a debt-collection syndicate that arrives in force at nightfall'], clock: 'they arrive at nightfall' },
];

function pickFreshBrief({ history = [], seed, avoidLast = 12 } = {}) {
  const r = rng(seed == null ? Date.now() : seed);
  const recent = history.slice(-avoidLast);
  const usedThemes = new Set(recent.map(h => h.theme));
  const recentTypes = history.slice(-3).map(h => h.threat_type);
  let themes = THEMES.filter(t => !usedThemes.has(t)); if (!themes.length) themes = THEMES.filter(t => t !== (history[history.length - 1] || {}).theme);
  let threats = THREATS.filter(t => !recentTypes.includes(t.type)); if (!threats.length) threats = THREATS;
  const theme = themes[Math.floor(r() * themes.length)];
  const th = threats[Math.floor(r() * threats.length)];
  const seedText = th.seeds[Math.floor(r() * th.seeds.length)];
  return { theme, threat_type: th.type, threat_seed: seedText, threat_clock: th.clock, seed: seed == null ? null : seed };
}

class BriefHistory {
  constructor(file) { this.file = file; }
  all() { return readJson(this.file, []); }
  record(brief, film_id) { const h = this.all(); h.push({ film_id, theme: brief.theme, threat_type: brief.threat_type, threat_seed: brief.threat_seed, at: new Date().toISOString() }); writeJson(this.file, h); return h; }
}

module.exports = { THEMES, THREATS, pickFreshBrief, BriefHistory };
