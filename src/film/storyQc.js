'use strict';
/**
 * Story QC — evaluates the SCREENPLAY (bible.scenes / beats) against the standalone,
 * concrete-threat, mystery-answered requirements. Pure function over data; used
 * (a) by the story provider to reject/repair a draft, and (b) by film QC as the
 * story gate.
 */
const { ACTS, CLIFFHANGER_RE, validateFilmBible } = require('./filmBible');

const REQUIRED_MARKS = ['threat_introduced', 'reveal', 'threat_resolved', 'mystery_answered', 'final_image'];

function flattenBeats(bible) {
  const out = [];
  for (const sc of bible.scenes || []) for (const bt of sc.beats || []) out.push({ scene: sc, beat: bt, act: sc.act, i: out.length });
  return out;
}

function checkScreenplay(bible, { minPostRevealShare = 0.15 } = {}) {
  const errors = [];
  const scenes = bible.scenes || [];
  if (!scenes.length) return { valid: false, errors: ['no scenes'] };

  // Acts present, in order
  const actIdx = scenes.map(s => ACTS.indexOf(s.act));
  if (actIdx.some(i => i < 0)) errors.push('scene with unknown act');
  for (let i = 1; i < actIdx.length; i++) if (actIdx[i] < actIdx[i - 1]) errors.push(`scene ${scenes[i].scene_id} is out of act order`);
  for (const a of ACTS) if (!scenes.some(s => s.act === a)) errors.push(`no scene in act "${a}"`);
  if (scenes[scenes.length - 1].act !== 'resolution') errors.push('final scene must be in the resolution act');

  const beats = flattenBeats(bible);
  if (!beats.length) return { valid: false, errors: [...errors, 'no beats'] };
  const first = (mark) => beats.find(b => (b.beat.marks || []).includes(mark));
  const all = (mark) => beats.filter(b => (b.beat.marks || []).includes(mark));
  for (const m of REQUIRED_MARKS) if (!first(m)) errors.push(`no beat marked "${m}"`);
  if (all('reveal').length !== 1) errors.push(`exactly one beat must be marked "reveal" (found ${all('reveal').length})`);
  if (all('threat_escalation').length < 2) errors.push('need >= 2 beats marked "threat_escalation"');

  const reveal = first('reveal'), resolved = first('threat_resolved'), answered = first('mystery_answered'), intro = first('threat_introduced');
  const finalImg = first('final_image');
  if (reveal && bible.mystery && reveal.act !== bible.mystery.reveal_act) errors.push(`reveal beat is in act "${reveal.act}" but mystery.reveal_act is "${bible.mystery.reveal_act}"`);
  if (reveal && ACTS.indexOf(reveal.act) > 3) errors.push('reveal must not occur in the resolution act');
  if (intro && ACTS.indexOf(intro.act) > 1) errors.push('threat must be introduced in beginning/development');

  if (reveal && resolved && answered) {
    if (!(resolved.i > reveal.i)) errors.push('threat_resolved must come AFTER the reveal');
    if (!(answered.i > reveal.i)) errors.push('mystery_answered must come AFTER the reveal (the ending answers it; the reveal alone is not an ending)');
    const post = (beats.length - 1 - reveal.i) / beats.length;
    if (post < minPostRevealShare) errors.push(`only ${(post * 100).toFixed(0)}% of the film follows the reveal (need >= ${minPostRevealShare * 100}%) — it would stop at the reveal`);
    if (resolved.act !== 'resolution' && resolved.act !== 'climax') errors.push('threat_resolved must be in climax or resolution');
    if (answered.act !== 'resolution' && answered.act !== 'climax') errors.push('mystery_answered must be in climax or resolution');
  }
  // Escalations must precede the resolution
  for (const e of all('threat_escalation')) if (resolved && e.i > resolved.i) errors.push('threat_escalation after threat_resolved');
  // Last beat is the final image and carries no hook language
  const last = beats[beats.length - 1];
  if (finalImg && finalImg.i !== last.i) errors.push('the final beat of the film must be the beat marked "final_image"');
  const finalText = `${last.beat.action || ''} ${(last.beat.dialogue || []).map(d => d.text).join(' ')}`;
  if (CLIFFHANGER_RE.test(finalText)) errors.push('final beat contains cliffhanger / sequel language');
  for (const b of beats) if (CLIFFHANGER_RE.test(`${b.beat.action || ''} ${(b.beat.dialogue || []).map(d => d.text).join(' ')}`)) { errors.push(`beat ${b.beat.id} contains cliffhanger / sequel language`); break; }

  // Beat ids unique
  const ids = beats.map(b => b.beat.id); if (new Set(ids).size !== ids.length) errors.push('beat ids not unique');
  return { valid: errors.length === 0, errors };
}

/**
 * Structural checks on ONE act's freshly-generated scenes, usable the moment that
 * act comes back from the LLM (before the rest of the film exists). Lets a
 * chunked/act-by-act generator retry a single bad act instead of the whole film.
 * `globalBeatIds` is a Set the caller carries across acts to catch id collisions
 * introduced by a later act reusing an earlier act's beat/scene ids.
 */
function checkActScenes(actId, scenes, bible, { isLastAct = false, requiredMarks = [], requiredCounts = {}, forbiddenMarks = [], globalBeatIds = new Set(), globalSceneIds = new Set(), priorMarkCounts = {} } = {}) {
  const errors = [];
  if (!Array.isArray(scenes) || !scenes.length) return { valid: false, errors: [`act "${actId}": no scenes returned`] };
  for (const sc of scenes) {
    if (sc.act !== actId) errors.push(`scene ${sc.scene_id}: act field is "${sc.act}", expected "${actId}"`);
    if (globalSceneIds.has(sc.scene_id)) errors.push(`scene_id "${sc.scene_id}" collides with an earlier act`);
    if (!Array.isArray(sc.beats) || !sc.beats.length) { errors.push(`scene ${sc.scene_id}: no beats`); continue; }
    for (const bt of sc.beats) {
      if (globalBeatIds.has(bt.id)) errors.push(`beat id "${bt.id}" collides with an earlier act`);
      const text = `${bt.action || ''} ${(bt.dialogue || []).map(d => d.text).join(' ')}`;
      if (CLIFFHANGER_RE.test(text)) errors.push(`beat ${bt.id}: cliffhanger / sequel language`);
      for (const m of forbiddenMarks) if ((bt.marks || []).includes(m)) errors.push(`beat ${bt.id}: mark "${m}" is not allowed in act "${actId}"`);
    }
  }
  const markCounts = {};
  for (const bt of scenes.flatMap(sc => sc.beats || [])) for (const m of bt.marks || []) markCounts[m] = (markCounts[m] || 0) + 1;
  for (const m of requiredMarks) if (!markCounts[m]) errors.push(`act "${actId}": no beat marked "${m}" (required in this act)`);
  for (const [m, min] of Object.entries(requiredCounts)) {
    const totalSoFar = (priorMarkCounts[m] || 0) + (markCounts[m] || 0);
    if (totalSoFar < min) errors.push(`need >= ${min} beat(s) marked "${m}" across the film so far (have ${totalSoFar}); add more in act "${actId}" or a later act`);
  }
  if (isLastAct) {
    const last = scenes[scenes.length - 1].beats.slice(-1)[0];
    if (!(last.marks || []).includes('final_image')) errors.push('the final beat of the whole film must be marked "final_image"');
  }
  return { valid: errors.length === 0, errors };
}


function checkStory(bible, opts = {}) {
  const b = validateFilmBible(bible, opts);
  const s = checkScreenplay(bible, opts);
  return { valid: b.valid && s.valid, errors: [...b.errors, ...s.errors], warnings: b.warnings };
}

module.exports = { checkScreenplay, checkStory, checkActScenes, flattenBeats };
