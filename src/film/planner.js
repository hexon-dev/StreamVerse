'use strict';
/**
 * Scene + shot planner (continuity-first). Deterministic: same bible + ids => same plan.
 *
 * Every shot answers: where are we / who / what do they look like / what just happened /
 * what happens now / what must stay consistent / what changes / where does it end /
 * what must the next shot inherit — and states HOW it opens relative to the previous shot.
 *
 * Duration management: duration_target is clamped to the provider window (default = the
 * existing LTX limits, 2-10 s). Dialogue is NEVER truncated: if a beat's speech does not fit
 * one shot it is split across consecutive shots (existing StreamVerse rule: adapt duration
 * within limits rather than cut speech). Speech length uses the existing
 * ttsGen.estimateSpokenDuration.
 */
const { pad, sha256, stableStringify } = require('./util');

function spokenSeconds(lines) {
  const { estimateSpokenDuration } = require('../ttsGen');
  return lines.reduce((s, l) => s + estimateSpokenDuration(l.text), 0);
}
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const r1 = (v) => Math.round(v * 10) / 10;

function limitsFromEnv() {
  return { minShot: Number(process.env.LTX_MIN_DURATION) || 2, maxShot: Math.min(10, Number(process.env.LTX_MAX_DURATION) || 10) };
}

/** Opening transition derived from what the previous shot actually ended on. */
function openingTransition({ prev, shot, sceneChanged, first, scene }) {
  if (first) return { type: 'fade_in', instruction: `Open on an establishing view of ${scene.location_key} (${scene.time_of_day}) before the characters.`, inherits: [] };
  if (sceneChanged) return { type: 'scene_boundary', instruction: `Cut to ${scene.location_key}, ${scene.time_of_day}. Establish the new location and lighting before the characters; do not carry over the previous composition.`, inherits: ['story state', 'character wardrobe', 'injuries', 'held props'] };
  const dir = prev.exit_dir;
  const who = prev.characters.join(' and ');
  const move = dir ? `${who} was moving toward frame ${dir}; begin with that movement continuing toward frame ${dir}` : `begin from the previous end frame's exact composition and continue the action`;
  return { type: 'continuous', instruction: `Previous shot: ${prev.action} Now: ${move}. Keep camera momentum (${prev.camera || 'unchanged'}), same eyelines and prop positions.`, inherits: ['position', 'facing', 'camera momentum', 'held props', 'lighting'] };
}

function endFrameTransition({ shot, next }) {
  if (!next) return { type: 'hold', instruction: 'Hold on the final composition; this is the last shot of the film.' };
  if (shot.exit_dir) return { type: 'exit_frame', instruction: `End with ${shot.characters.join(' and ')} still moving toward frame ${shot.exit_dir} so the next shot can continue the movement.` };
  return { type: 'settle', instruction: 'End on a stable, readable composition with characters, props and lighting clearly visible.' };
}

function shotQuestions(shot, scene, prev) {
  return {
    where: `${scene.location_key}, ${scene.time_of_day}`,
    who: shot.characters.join(', '),
    look: 'see continuity_requirements (canonical + current wardrobe/injuries)',
    just_happened: prev ? prev.action : 'nothing yet (film opening)',
    now: shot.action,
    must_remain: shot.continuity_requirements.filter(x => x.kind !== 'change').map(x => x.text),
    changes: shot.continuity_requirements.filter(x => x.kind === 'change').map(x => x.text),
    ends: shot.end_frame_transition.instruction,
    next_inherits: ['final frame', 'character positions', 'held props', 'wardrobe', 'injuries', 'lighting'],
  };
}

function planFilm(bible, ids, opts = {}) {
  // NOT `{ ...limitsFromEnv(), ...opts }`: if a caller passes {minShot: undefined} (e.g. because
  // it forwards an options object that simply never set minShot), object spread makes that
  // explicit `undefined` OVERWRITE the env default, silently producing NaN shot durations across
  // the whole plan. Reproduced in testing at a real ~960s runtime (short test runtimes happened
  // to mask it because they weren't clamp-sensitive in the same way). Per-key `??` fallback can't
  // have that failure mode.
  const envLimits = limitsFromEnv();
  const minShot = opts.minShot ?? envLimits.minShot;
  const maxShot = opts.maxShot ?? envLimits.maxShot;
  const dialoguePad = opts.dialoguePad != null ? opts.dialoguePad : 1.0;
  const filmKey = bible.film_id.toLowerCase();
  const warnings = [];

  // beats per act -> per-beat time budget
  const beatsInAct = {}; for (const sc of bible.scenes) beatsInAct[sc.act] = (beatsInAct[sc.act] || 0) + sc.beats.length;
  const actShare = Object.fromEntries(bible.acts.map(a => [a.id, a.share]));

  const scenes = [], shots = [];
  let prev = null, sceneNo = 0;
  const locId = (key) => ids.locations[key];
  for (const sc of bible.scenes) {
    sceneNo++;
    const scene = { scene_id: `${filmKey}_scene_${pad(sceneNo)}`, source_scene_id: sc.scene_id, scene_no: sceneNo, act: sc.act, location_key: sc.location_key, location_id: locId(sc.location_key), time_of_day: sc.time_of_day, summary: sc.summary, characters: sc.characters, shot_ids: [] };
    scenes.push(scene);
    let shotNo = 0;
    for (const bt of sc.beats) {
      const target = (bible.runtime_target * actShare[sc.act]) / beatsInAct[sc.act];
      const lines = bt.dialogue || [];
      // Split dialogue across shots so nothing is ever truncated
      const groups = []; let cur = [], curDur = 0;
      for (const l of lines) {
        const d = spokenSeconds([l]);
        if (cur.length && curDur + d + dialoguePad > maxShot) { groups.push(cur); cur = []; curDur = 0; }
        cur.push(l); curDur += d;
      }
      if (cur.length || !groups.length) groups.push(cur);
      const perShotTarget = target / groups.length;
      groups.forEach((g, gi) => {
        shotNo++;
        const last = gi === groups.length - 1;
        const dd = spokenSeconds(g);
        const need = Math.max(perShotTarget, g.length ? dd + dialoguePad : 0);
        if (g.length && dd + dialoguePad > maxShot) warnings.push(`${bt.id}: dialogue needs ${r1(dd + dialoguePad)}s > max ${maxShot}s; kept whole (never truncated)`);
        const duration_target = r1(clamp(need, minShot, maxShot));
        const shot = {
          shot_id: `${filmKey}_scene_${pad(sceneNo)}_shot_${pad(shotNo)}`,
          film_id: bible.film_id, scene_id: scene.scene_id, beat_id: bt.id, part: groups.length > 1 ? `${gi + 1}/${groups.length}` : null,
          index: shots.length, previous_shot_id: prev ? prev.shot_id : null,
          purpose: (bt.marks || []).join(',') || (last ? 'story beat' : 'continuation'),
          characters: bt.characters_in_shot && bt.characters_in_shot.length ? bt.characters_in_shot : sc.characters,
          location_key: sc.location_key, location_id: locId(sc.location_key), time_of_day: sc.time_of_day, act: sc.act,
          action: gi === 0 ? bt.action : `(continues) ${bt.action}`,
          dialogue: g, dialogue_sha256: sha256(stableStringify(g)),
          camera: bt.camera || 'medium', exit_dir: last ? (bt.exit_dir || '') : '',
          props_in_shot: bt.props_in_shot || [], uses_info: bt.uses_info || [], reveals: last ? (bt.reveals || []) : [],
          marks: last ? (bt.marks || []) : [], state_changes: last ? (bt.state_changes || {}) : {},
          duration_target, dialogue_duration: r1(dd), generation_duration: duration_target, actual_duration: null,
          visual_style: bible.visual_style,
        };
        const sceneChanged = !prev || prev.scene_id !== shot.scene_id;
        shot.opening_transition = openingTransition({ prev, shot, sceneChanged: sceneChanged && !!prev, first: !prev, scene });
        shot.motion_critical = shot.opening_transition.type === 'continuous' && !!(prev && (prev.exit_dir || /track|pan|follow|dolly|handheld/i.test(prev.camera || '')));
        shot.continuity_requirements = [
          ...shot.characters.map(k => ({ kind: 'keep', text: `${k}: canonical face/hair/body from reference; current wardrobe & injuries from state` })),
          ...(shot.props_in_shot || []).map(k => ({ kind: 'keep', text: `prop ${k}: use current state (holder/location)` })),
          { kind: 'keep', text: `location ${sc.location_key}, ${sc.time_of_day} lighting stays consistent` },
          ...Object.entries((shot.state_changes.characters) || {}).map(([k, v]) => ({ kind: 'change', text: `${k} changes: ${JSON.stringify(v)}` })),
          ...Object.entries((shot.state_changes.props) || {}).map(([k, v]) => ({ kind: 'change', text: `prop ${k} changes: ${JSON.stringify(v)}` })),
        ];
        scene.shot_ids.push(shot.shot_id); shots.push(shot); prev = shot;
      });
    }
  }
  // second pass: end-frame transitions need the next shot; questions need both neighbours
  shots.forEach((s, i) => {
    s.next_shot_id = shots[i + 1] ? shots[i + 1].shot_id : null;
    s.end_frame_transition = endFrameTransition({ shot: s, next: shots[i + 1] });
    s.questions = shotQuestions(s, scenes.find(x => x.scene_id === s.scene_id), i ? shots[i - 1] : null);
  });
  const planned_runtime = r1(shots.reduce((t, s) => t + s.duration_target, 0));
  if (Math.abs(planned_runtime - bible.runtime_target) / bible.runtime_target > 0.2) warnings.push(`planned runtime ${planned_runtime}s is >20% off target ${bible.runtime_target}s`);
  return { scenes, shots, planned_runtime, warnings, limits: { minShot, maxShot } };
}

module.exports = { planFilm, openingTransition, endFrameTransition };
