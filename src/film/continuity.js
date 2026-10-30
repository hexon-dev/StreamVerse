'use strict';
/**
 * Continuity ledger — lightweight structured state, NOT a world simulation.
 * One immutable snapshot per shot; each beat may declare deliberate changes
 * (wardrobe, injuries, prop movement, known info...). Nothing else changes silently.
 */
const { deepClone } = require('./util');

function initialLedger(bible, ids) {
  const st = { characters: {}, environment: {}, props: {}, camera: { position: null, orientation: null, movement: 'static', framing: 'medium' },
    story: { scene_id: null, objective: null, known_info: [], recent_event: null, unresolved_conflict: bible.mystery && bible.mystery.question, threat_level: 0 },
    audio: { speaker: null, dialogue_state: 'none', ambient: null, music: 'none', sound_bridge: null }, lighting: { look: null } };
  for (const c of bible.characters) st.characters[c.key] = { character_id: ids.characters[c.key], wardrobe: c.canonical.wardrobe_default, injuries: [], position: null, facing: null, emotion: 'neutral', action: null, holding: [] };
  for (const p of bible.props || []) st.props[p.key] = { prop_id: ids.props[p.key], owner: null, location: null, held: false, open: false, damaged: false, present: false };
  return st;
}

/** state_before + a beat/shot -> state_after (pure). */
function applyShot(before, shot, scene) {
  const s = deepClone(before);
  if (scene && s.environment.location_id !== scene.location_id) {
    s.environment = { location_id: scene.location_id, time_of_day: scene.time_of_day, weather: scene.weather || 'clear', lighting: scene.lighting || `${scene.time_of_day} light`, condition: 'intact' };
  } else if (scene) { s.environment.time_of_day = scene.time_of_day; }
  s.story.scene_id = shot.scene_id;
  const ch = (shot.state_changes && shot.state_changes.characters) || {};
  for (const key of shot.characters) if (s.characters[key]) { s.characters[key].action = shot.action; s.characters[key].facing = shot.exit_dir ? `toward frame ${shot.exit_dir}` : s.characters[key].facing; }
  for (const [k, v] of Object.entries(ch)) if (s.characters[k]) Object.assign(s.characters[k], v);
  const pr = (shot.state_changes && shot.state_changes.props) || {};
  for (const [k, v] of Object.entries(pr)) if (s.props[k]) Object.assign(s.props[k], v);
  for (const k of shot.props_in_shot || []) if (s.props[k]) s.props[k].present = true;
  for (const [k, p] of Object.entries(s.props)) { if (p.held && p.owner && s.characters[p.owner]) { const h = s.characters[p.owner].holding; if (!h.includes(k)) h.push(k); } }
  for (const c of Object.values(s.characters)) c.holding = c.holding.filter(k => s.props[k] && s.props[k].held && s.props[k].owner && s.characters[s.props[k].owner] === c);
  const env = (shot.state_changes && shot.state_changes.environment) || {}; Object.assign(s.environment, env);
  const story = (shot.state_changes && shot.state_changes.story) || {};
  for (const [k, v] of Object.entries(story)) { if (k === 'known_info_add') for (const i of v) { if (!s.story.known_info.includes(i)) s.story.known_info.push(i); } else s.story[k] = v; }
  for (const i of shot.reveals || []) if (!s.story.known_info.includes(i)) s.story.known_info.push(i);
  s.story.recent_event = shot.action;
  s.camera = { ...s.camera, movement: shot.camera || s.camera.movement };
  const spk = (shot.dialogue || [])[0];
  s.audio = { ...s.audio, speaker: spk ? spk.speaker : null, dialogue_state: spk ? 'speaking' : 'none' };
  return s;
}

/** What a correct rendering of the END of this shot looks like (schema shared with vision observations). */
function expectedObservation(after, shot) {
  const chars = {};
  for (const k of shot.characters) { const c = after.characters[k]; if (c) chars[k] = { identity_match: 1, wardrobe: c.wardrobe, injuries: c.injuries.slice(), facing: c.facing, holding: c.holding.slice() }; }
  const props = {};
  for (const [k, p] of Object.entries(after.props)) if ((shot.props_in_shot || []).includes(k) || p.held) props[k] = { present: p.present || p.held, held: p.held, owner: p.owner };
  return { characters: chars, props, location_id: after.environment.location_id, time_of_day: after.environment.time_of_day, lighting: after.environment.lighting, camera: { transition_intentional: true } };
}

module.exports = { initialLedger, applyShot, expectedObservation };
