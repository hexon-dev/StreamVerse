'use strict';
/**
 * Continuity validator. Deterministic comparison of (a) what the shot SHOULD show at its end
 * (continuity ledger) against (b) an OBSERVATION of what was generated (VisionProvider), plus
 * cheap metadata checks. Returns structured issues; each issue type maps to a targeted retry.
 * Deliberately NOT a world simulation: practical checks for obvious cinematic failures only.
 */
const { extractDialogueFromPrompt } = require('./promptCompiler');
const { sha256, stableStringify } = require('./util');

const tokens = (s) => new Set(String(s || '').toLowerCase().split(/[^a-z0-9]+/).filter(w => w.length > 2));
function overlap(expected, observed) { const e = tokens(expected); if (!e.size) return 1; const o = tokens(observed); let n = 0; for (const t of e) if (o.has(t)) n++; return n / e.size; }

/** issue type -> cumulative targeted retry adjustments (never a blind retry) */
const STRATEGIES = {
  identity: ['identity_boost'], wardrobe: ['wardrobe_ref_boost', 'wardrobe_explicit'], physical_state: ['injury_explicit'],
  prop: ['prop_ref_boost', 'prop_state_explicit'], environment: ['location_ref_boost'], lighting: ['lighting_explicit', 'location_ref_boost'],
  spatial: ['motion_context', 'transition_explicit'], camera: ['motion_context', 'transition_explicit'],
  dialogue_timing: ['extend_duration'], media: ['regenerate_plain'],
};
const NON_RETRYABLE = new Set(['dialogue_integrity', 'narrative']);          // plan/prompt defects: regenerating video cannot fix them

function adjustmentsFor(issues, existing = []) {
  const out = new Set(existing);
  for (const i of issues) for (const a of (STRATEGIES[i.type] || [])) out.add(a);
  return [...out];
}

function validateShot({ shot, before, request, clip, observation, expected, plannedTolerance = 0.25 }) {
  const issues = [];
  const add = (type, severity, message, extra = {}) => issues.push({ type, severity, message, retryable: !NON_RETRYABLE.has(type), ...extra });

  // --- dialogue integrity (what was actually SENT must equal the plan, word for word) --------------------
  const sent = extractDialogueFromPrompt(request.prompt);
  if (stableStringify(sent) !== stableStringify(shot.dialogue) || request.dialogue_sha256 !== shot.dialogue_sha256) {
    add('dialogue_integrity', 'high', 'dialogue in the compiled request differs from the approved plan');
  }
  // --- narrative: nobody acts on information they have not learned yet -----------------------------------
  for (const info of shot.uses_info || []) if (!before.story.known_info.includes(info)) add('narrative', 'high', `shot uses "${info}" before it has been learned`);
  // --- media / timing ---------------------------------------------------------------------------------
  if (!clip || !(clip.duration > 0)) add('media', 'high', 'clip not decodable');
  else {
    const need = (shot.dialogue_duration || 0);
    if (shot.dialogue.length && clip.duration + 0.05 < need) add('dialogue_timing', 'high', `clip ${clip.duration.toFixed(1)}s is shorter than the speech (${need}s)`);
    if (Math.abs(clip.duration - request.duration) > Math.max(0.75, request.duration * plannedTolerance)) add('media', 'medium', `duration ${clip.duration.toFixed(1)}s vs requested ${request.duration}s`);
    if (shot.dialogue.length && !clip.hasAudio) add('media', 'high', 'dialogue shot has no audio track');
  }
  if (!observation) return finish(issues);

  // --- identity / appearance / wardrobe / physical state ------------------------------------------------
  for (const [k, exp] of Object.entries(expected.characters)) {
    const obs = observation.characters && observation.characters[k];
    if (!obs) { add('identity', 'high', `${k} not found in the generated shot`, { character: k }); continue; }
    if ((obs.identity_match ?? 1) < 0.8) add('identity', 'high', `${k} does not match the canonical reference (score ${obs.identity_match})`, { character: k });
    if (overlap(exp.wardrobe, obs.wardrobe) < 0.6) add('wardrobe', 'high', `${k} wardrobe differs: expected "${exp.wardrobe}", saw "${obs.wardrobe}"`, { character: k });
    for (const inj of exp.injuries) if (!(obs.injuries || []).some(o => overlap(inj, o) >= 0.6)) add('physical_state', 'high', `${k} lost injury "${inj}"`, { character: k });
    if (exp.facing && obs.facing && overlap(exp.facing, obs.facing) < 0.5) add('spatial', 'medium', `${k} facing/heading differs: expected "${exp.facing}", saw "${obs.facing}"`, { character: k });
  }
  // --- props ----------------------------------------------------------------------------------------
  for (const [k, exp] of Object.entries(expected.props)) {
    const obs = observation.props && observation.props[k];
    if (exp.present && !(obs && obs.present)) add('prop', 'high', `prop ${k} is missing`, { prop: k });
    else if (exp.present && obs && exp.held !== obs.held) add('prop', 'medium', `prop ${k} held-state differs (expected ${exp.held}, saw ${obs.held})`, { prop: k });
    else if (!exp.present && obs && obs.present) add('prop', 'medium', `prop ${k} appeared unexpectedly`, { prop: k });
  }
  // --- environment / lighting / camera --------------------------------------------------------------
  if (observation.location_id && observation.location_id !== expected.location_id) add('environment', 'high', `location changed: expected ${expected.location_id}, saw ${observation.location_id}`);
  if (observation.lighting && overlap(expected.lighting, observation.lighting) < 0.5) add('lighting', 'medium', `lighting jumped: expected "${expected.lighting}", saw "${observation.lighting}"`);
  if (observation.camera && observation.camera.transition_intentional === false) add('camera', 'medium', 'camera transition looks unintentional (composition restarted)');
  return finish(issues);
}
function finish(issues) { return { passed: !issues.some(i => i.severity === 'high' || i.severity === 'medium'), issues }; }

module.exports = { validateShot, adjustmentsFor, STRATEGIES, overlap };
