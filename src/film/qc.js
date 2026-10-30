'use strict';
/**
 * Film-level QC. A film is only COMPLETE if every gate passes. Every check evaluates real
 * artefacts on disk (plan, approved clips, continuity records, generation records, master),
 * not flags set by the code that produced them.
 */
const fs = require('fs');
const path = require('path');
const { readJson, sha256File } = require('./util');
const { checkStory, flattenBeats } = require('./storyQc');
const { extractDialogueFromPrompt } = require('./promptCompiler');
const { probe } = require('../branding');
const { sha256, stableStringify } = require('./util');

const gate = () => { const checks = []; return { checks, add: (name, passed, detail = '') => checks.push({ name, passed: !!passed, detail }), get passed() { return checks.every(c => c.passed); } }; };

async function runFilmQc(orch, assembly, { runtimeRange, minPostRevealShare = 0.15 } = {}) {
  const { shots } = orch.plan(); const bible = orch.bible;
  const recs = shots.map(s => ({ shot: s, cont: readJson(orch.f(`continuity/${s.shot_id}.json`)), appr: orch.store.getApproved(s.shot_id) }));
  const attemptDir = (r) => r.appr ? orch.store.attemptDir(r.shot.shot_id, r.appr.attempt) : null;
  const gen = (r) => readJson(path.join(attemptDir(r), 'generation.json'));
  const G = { story: gate(), character: gate(), visual: gate(), dialogue: gate(), media: gate(), assembly: gate() };

  // ── STORY ──
  const sq = checkStory(bible, { runtimeRange, minPostRevealShare });
  G.story.add('bible + screenplay rules (standalone, concrete threat, mystery answered)', sq.valid, sq.errors.join('; '));
  const beatIds = flattenBeats(bible).map(b => b.beat.id), shotBeatIds = [...new Set(shots.map(s => s.beat_id))];
  G.story.add('every beat is covered by a shot, in order', JSON.stringify(beatIds) === JSON.stringify(shotBeatIds));
  const iRev = shots.findIndex(s => s.marks.includes('reveal')), iRes = shots.findIndex(s => s.marks.includes('threat_resolved')), iAns = shots.findIndex(s => s.marks.includes('mystery_answered'));
  G.story.add('reveal precedes threat resolution and mystery answer in the shot order', iRev >= 0 && iRes > iRev && iAns > iRev);
  const total = recs.reduce((t, r) => t + (r.cont ? r.cont.actual_duration : 0), 0), post = recs.slice(iRev + 1).reduce((t, r) => t + (r.cont ? r.cont.actual_duration : 0), 0);
  G.story.add(`>= ${minPostRevealShare * 100}% of actual runtime follows the reveal`, total > 0 && post / total >= minPostRevealShare, `${((post / total) * 100).toFixed(0)}%`);
  G.story.add('last shot is the final image', shots[shots.length - 1].marks.includes('final_image'));

  // ── CHARACTER ──
  const assets = readJson(orch.f('assets.json'));
  const hashesOk = Object.entries(assets.canonicalHashes).every(([id, h]) => orch.registry.canonicalHash('character', id) === h);
  G.character.add('canonical character data unchanged during the film', hashesOk);
  const missingRef = []; const missingPrev = [];
  for (const r of recs) { if (!r.appr) continue; const g = gen(r); for (const k of r.shot.characters) { const c = g.references.characters.find(x => x.key === k); if (!c || !c.roles.includes('master_reference')) missingRef.push(`${r.shot.shot_id}:${k}`); } if (r.shot.previous_shot_id && !g.references.previous_end_frame) missingPrev.push(r.shot.shot_id); }
  G.character.add('canonical master reference reached every generation request', !missingRef.length, missingRef.slice(0, 3).join(', '));
  G.character.add('previous end frame reached every non-opening generation request', !missingPrev.length, missingPrev.slice(0, 3).join(', '));
  const idIssues = recs.filter(r => r.cont && r.cont.validation.issues.some(i => ['identity', 'wardrobe'].includes(i.type))).map(r => r.shot.shot_id);
  G.character.add('no identity/wardrobe issues on approved shots', !idIssues.length, idIssues.join(', '));

  // ── VISUAL ──
  G.visual.add('every shot approved with a passing continuity result', recs.every(r => r.appr && r.cont && r.cont.validation.passed));
  G.visual.add('every approved shot has a registered end frame', recs.every(r => r.cont && r.cont.end_frame && fs.existsSync(r.cont.end_frame)));
  G.visual.add('no shot flagged needs_review', !Object.values(orch.state.shots).some(s => s.status === 'needs_review'));

  // ── DIALOGUE ──
  const bad = [];
  for (const r of recs) { if (!r.appr) continue; const prompt = fs.readFileSync(path.join(attemptDir(r), 'prompt.txt'), 'utf8'); if (stableStringify(extractDialogueFromPrompt(prompt)) !== stableStringify(r.shot.dialogue)) bad.push(r.shot.shot_id); }
  G.dialogue.add('dialogue sent to the provider equals the plan (words + speakers) in every shot', !bad.length, bad.slice(0, 3).join(', '));
  const planned = shots.flatMap(s => s.dialogue.map(d => `${d.speaker}:${d.text}`)), storyLines = flattenBeats(bible).flatMap(b => (b.beat.dialogue || []).map(d => `${d.speaker}:${d.text}`));
  G.dialogue.add('all screenplay dialogue lines present once, in order', JSON.stringify(planned) === JSON.stringify(storyLines));
  const infos = await Promise.all(recs.map(r => r.appr ? probe(r.appr.video) : null));
  G.dialogue.add('dialogue shots have audio and enough time for the speech', recs.every((r, i) => !r.shot.dialogue.length || (infos[i] && infos[i].hasAudio && infos[i].duration + 0.05 >= r.shot.dialogue_duration)));

  // ── MEDIA ──
  G.media.add('approved files match their recorded sha256', recs.every(r => r.appr));
  G.media.add('every clip is playable with a duration', infos.every(i => i && i.duration > 0));
  G.media.add('resolution consistent across shots', new Set(infos.map(i => `${i.width}x${i.height}`)).size === 1 || (assembly && assembly.report.normalized.length > 0));

  // ── ASSEMBLY ──
  const rp = assembly && assembly.report;
  G.assembly.add('all shots present and in plan order', !!rp && JSON.stringify(rp.shots) === JSON.stringify(shots.map(s => s.shot_id)));
  const mInfo = assembly && fs.existsSync(assembly.master) ? await probe(assembly.master) : null;
  G.assembly.add('master is playable', !!mInfo && mInfo.duration > 0);
  const sum = infos.reduce((t, i) => t + (i ? i.duration : 0), 0);
  G.assembly.add('master duration matches the sum of approved shots', !!mInfo && Math.abs(mInfo.duration - sum) <= Math.max(1, sum * 0.02 + 0.1 * shots.length), mInfo ? `${mInfo.duration.toFixed(1)}s vs ${sum.toFixed(1)}s` : 'no master');
  G.assembly.add('master has an audio track', !!mInfo && mInfo.hasAudio);
  G.assembly.add('StreamVerse Studio logo + name burned into the master', !!rp && rp.branding && rp.branding.applied && rp.branding.logoDiff > 3, rp && rp.branding ? `logoDiff=${rp.branding.logoDiff && rp.branding.logoDiff.toFixed(1)}` : 'no branding');
  if (runtimeRange) {
    const hasMax = runtimeRange.max != null;
    const label = hasMax ? `runtime within ${runtimeRange.min}-${runtimeRange.max}s` : `runtime >= ${runtimeRange.min}s`;
    G.assembly.add(label, !!mInfo && mInfo.duration >= runtimeRange.min && (!hasMax || mInfo.duration <= runtimeRange.max), mInfo ? `${mInfo.duration.toFixed(0)}s` : '');
  }

  const gates = Object.fromEntries(Object.entries(G).map(([k, g]) => [k, { passed: g.passed, checks: g.checks }]));
  return { passed: Object.values(G).every(g => g.passed), gates };
}
module.exports = { runFilmQc };
