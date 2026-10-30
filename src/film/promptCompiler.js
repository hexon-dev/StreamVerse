'use strict';
/**
 * Shot request compiler: turns (shot spec + continuity state + assets + previous end frame)
 * into ONE provider request. Only references relevant to this shot are attached (capped),
 * the previous shot's ACTUAL end frame is the primary visual handoff (also used as the start
 * image), and dialogue is carried verbatim — compaction never touches it.
 */
const fs = require('fs');
const path = require('path');
const { slug, sha256, stableStringify } = require('./util');

const DIALOGUE_HEAD = 'DIALOGUE (verbatim; speak exactly these words, do not paraphrase, add or remove words):';
const dialogueBlock = (lines) => lines.length ? `${DIALOGUE_HEAD}\n${lines.map(l => `[${l.speaker}] "${l.text}"`).join('\n')}` : '';

/** Parse the dialogue back out of a compiled prompt (used to prove nothing was altered in transit). */
function extractDialogueFromPrompt(prompt) {
  const i = prompt.indexOf(DIALOGUE_HEAD); if (i < 0) return [];
  return prompt.slice(i + DIALOGUE_HEAD.length).split('\n').map(l => /^\[([^\]]+)\] "([\s\S]*)"$/.exec(l.trim())).filter(Boolean).map(m => ({ speaker: m[1], text: m[2] }));
}

function compileShotRequest({ shot, before, after, bible, assets, previous, adjustments = [], attempt, outDir, generationDuration, maxRefs = 6, maxPromptChars = 3800 }) {
  const { registry, ids } = assets;
  const adj = new Set(adjustments);
  const boosted = adjustments.some(a => a.endsWith('_boost') || a === 'motion_context');
  const cap = boosted ? maxRefs + 3 : maxRefs;
  const chars = shot.characters.map(k => bible.characters.find(c => c.key === k)).filter(Boolean);

  // ---- references in priority order ---------------------------------------------------------------
  const tiers = [];
  const prevEnd = previous && previous.end_frame;
  if (prevEnd) tiers.push({ p: 0, kind: 'previous_end_frame', file: prevEnd });
  const characters = chars.map(c => ({ key: c.key, character_id: ids.characters[c.key], files: [] }));
  chars.forEach((c, i) => {
    const id = ids.characters[c.key];
    const m = registry.refPath('character', id, 'master_reference'); if (m) { tiers.push({ p: 1, kind: 'character', ci: i, role: 'master_reference', file: m }); }
  });
  const loc = registry.refPath('location', shot.location_id, 'reference'); if (loc) tiers.push({ p: 2, kind: 'location', file: loc });
  chars.forEach((c, i) => {
    const id = ids.characters[c.key]; const w = after.characters[c.key] && after.characters[c.key].wardrobe;
    const changed = w && w !== c.canonical.wardrobe_default;
    if (changed || adj.has('wardrobe_ref_boost')) { const wr = registry.refPath('character', id, `wardrobe_${slug(w).slice(0, 40)}`); if (wr) tiers.push({ p: adj.has('wardrobe_ref_boost') ? 1.5 : 3, kind: 'character', ci: i, role: 'wardrobe', file: wr }); }
  });
  const props = [];
  for (const k of shot.props_in_shot || []) { const f = registry.refPath('prop', ids.props[k], 'reference'); if (f) { props.push({ prop_id: ids.props[k], key: k, path: f }); tiers.push({ p: adj.has('prop_ref_boost') ? 1.6 : 4, kind: 'prop', pi: props.length - 1, file: f }); } }
  if (adj.has('identity_boost')) chars.forEach((c, i) => { for (const role of ['front', 'three_quarter']) { const f = registry.refPath('character', ids.characters[c.key], role); if (f) tiers.push({ p: 1.4, kind: 'character', ci: i, role, file: f }); } });
  if (adj.has('location_ref_boost') && loc) tiers.push({ p: 1.7, kind: 'location_dup', file: loc });   // (kept: same file, flagged for weight by the provider adapter)
  const supportFrames = [];
  if ((shot.motion_critical || adj.has('motion_context')) && previous && previous.support_frames) for (const f of previous.support_frames) if (f) tiers.push({ p: 5, kind: 'support', file: f });
  tiers.sort((a, b) => a.p - b.p);
  const kept = tiers.slice(0, cap), dropped = tiers.slice(cap).map(t => `${t.kind}:${path.basename(t.file)}`);
  let location = null;
  for (const t of kept) {
    if (t.kind === 'character') characters[t.ci].files.push({ role: t.role, path: t.file });
    else if (t.kind === 'location' || t.kind === 'location_dup') location = { location_id: shot.location_id, path: t.file, weight: t.kind === 'location_dup' ? 'high' : 'normal' };
    else if (t.kind === 'support') supportFrames.push(t.file);
  }
  const keptProps = kept.filter(t => t.kind === 'prop').map(t => props[t.pi]);

  // ---- prompt text -----------------------------------------------------------------------------------
  const sec = {};
  sec.STYLE = `STYLE: ${typeof shot.visual_style === 'object' ? Object.values(shot.visual_style).join('; ') : shot.visual_style}. Cinematic, photorealistic.`;
  sec.LOCATION = `LOCATION: ${shot.location_key}, ${after.environment.time_of_day}, ${after.environment.lighting}.`;
  sec.CHARACTERS = 'CHARACTERS (match reference images; current state below):\n' + chars.map(c => {
    const st = after.characters[c.key]; const k = c.canonical;
    return `- ${c.name}: ${k.hair}, ${k.eyes}, ${k.face}${k.marks && k.marks !== 'none' ? `, ${k.marks}` : ''}. Wearing: ${st.wardrobe}.${st.injuries.length ? ` Injuries: ${st.injuries.join(', ')}.` : ''}${st.holding.length ? ` Holding: ${st.holding.join(', ')}.` : ''}`;
  }).join('\n');
  const pr = Object.entries(after.props).filter(([k]) => (shot.props_in_shot || []).includes(k)).map(([k, p]) => `${k}: ${p.held ? `held by ${p.owner}` : p.location ? `at ${p.location}` : 'in scene'}`);
  if (pr.length) sec.PROPS = `PROPS: ${pr.join('; ')}.`;
  sec.OPENING = `OPENING (${shot.opening_transition.type}): ${shot.opening_transition.instruction}${previous && previous.end_frame ? ' The first frame must continue from the provided previous end frame.' : ''}`;
  sec.ACTION = `ACTION: ${shot.action}`;
  sec.CAMERA = `CAMERA: ${shot.camera}.`;
  sec.END = `END STATE: ${shot.end_frame_transition.instruction}`;
  sec.CONTINUITY = 'CONTINUITY: ' + shot.continuity_requirements.filter(r => r.kind === 'keep').map(r => r.text).join(' | ');
  const lines = [];
  const first = chars[0] && after.characters[chars[0].key];
  if (adj.has('identity_boost')) lines.push('IDENTITY LOCK: ' + chars.map(c => `${c.name} must match the reference portraits exactly (${c.canonical.hair}; ${c.canonical.eyes}; ${c.canonical.face}).`).join(' '));
  if (adj.has('wardrobe_explicit')) lines.push('WARDROBE LOCK: ' + chars.map(c => `${c.name} wears ${after.characters[c.key].wardrobe}, unchanged from the previous shot.`).join(' '));
  if (adj.has('injury_explicit')) lines.push('INJURIES: ' + chars.map(c => `${c.name} ${after.characters[c.key].injuries.length ? 'still shows ' + after.characters[c.key].injuries.join(', ') : 'has no injuries'}.`).join(' '));
  if (adj.has('prop_state_explicit')) lines.push('PROP STATE: ' + (pr.join('; ') || 'no props'));
  if (adj.has('lighting_explicit')) lines.push(`LIGHTING LOCK: ${after.environment.lighting}; no change in time of day.`);
  if (adj.has('transition_explicit')) lines.push(`TRANSITION LOCK: ${shot.opening_transition.instruction} The first frame must match the previous end frame; keep screen direction.`);
  if (lines.length) sec.RETRY = 'CORRECTIONS FOR THIS ATTEMPT:\n' + lines.join('\n');
  const dlg = dialogueBlock(shot.dialogue);

  const order = ['STYLE', 'LOCATION', 'CHARACTERS', 'PROPS', 'OPENING', 'ACTION', 'CAMERA', 'END', 'CONTINUITY', 'RETRY'];
  const droppable = ['CONTINUITY', 'STYLE', 'CAMERA'];   // compaction order; dialogue + action + retry lines never dropped
  const render = () => order.filter(k => sec[k]).map(k => sec[k]).concat(dlg ? [dlg] : []).join('\n\n');
  let prompt = render(), compacted = [];
  for (const k of droppable) { if (prompt.length <= maxPromptChars) break; delete sec[k]; compacted.push(k); prompt = render(); }

  const req = {
    shot_id: shot.shot_id, previous_shot_id: shot.previous_shot_id, attempt, duration: generationDuration,
    prompt, prompt_compacted: compacted, dialogue_lines: shot.dialogue, dialogue_sha256: sha256(stableStringify(shot.dialogue)),
    references: { characters, location, props: keptProps, previous_end_frame: prevEnd || null, support_frames: supportFrames },
    references_dropped: dropped, start_image: prevEnd || null,
    expected_state: null, adjustments, out_dir: outDir,
  };
  return req;
}

module.exports = { compileShotRequest, extractDialogueFromPrompt, dialogueBlock, DIALOGUE_HEAD };
