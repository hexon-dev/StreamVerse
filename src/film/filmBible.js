'use strict';
/**
 * Film Bible — the parent context for every scene and shot of ONE standalone film.
 *
 * HARD RULES (product requirement, enforced here and re-checked by film QC):
 *   1. STANDALONE. One film, beginning to end, in a single episode. No cliffhanger,
 *      no "next episode", no sequel bait. Recurring VANTA IP may appear but the film
 *      must be understandable and complete on its own.
 *   2. Every generation has a THEME and a CONCRETE THREAT (a perceivable thing/person/
 *      event with stakes and a clock — not an abstraction like "fear" or "loneliness").
 *   3. The MYSTERY is ANSWERED, not merely revealed. The reveal happens no later than
 *      the climax, and a real resolution act follows in which the threat's outcome is
 *      shown on screen and the answer is confirmed. A film that stops at the reveal
 *      is rejected.
 */
const ACTS = ['beginning', 'development', 'escalation', 'climax', 'resolution'];
const THREAT_TYPES = ['entity', 'person', 'phenomenon', 'device', 'disaster', 'hazard_place', 'organization'];
const THREAT_OUTCOMES = ['destroyed', 'contained', 'escaped', 'defeated', 'neutralised', 'paid_for'];
const ENDING_TYPES = ['twist', 'emotional', 'tragic', 'hopeful', 'ambiguous_tone', 'shocking'];
const ABSTRACT_ONLY = new Set(['fear', 'loneliness', 'grief', 'darkness', 'guilt', 'doubt', 'time', 'regret', 'sadness',
  'anxiety', 'evil', 'society', 'memory', 'death', 'the unknown', 'madness', 'hate', 'love', 'truth', 'silence', 'the past']);
const CLIFFHANGER_RE = /to be continued|next (episode|chapter|season|film|time)|sequel|part (two|2|ii)\b|cliffhanger|coming soon|will return|(is|was|it'?s?) (n('|o)t|far from) over|it['’]s only (just )?beginning|this (is|was) only the (beginning|start)|the (beginning|start) of something|tune in|stay tuned|\bfor now\b\.?\s*$/i;

const DEFAULT_RANGE = { min: 900, max: null };            // >= 15 minutes; no upper bound by default
const nonEmpty = (v) => typeof v === 'string' && v.trim().length > 0;
const words = (s) => String(s || '').trim().split(/\s+/).filter(Boolean).length;

/**
 * @returns {{valid:boolean, errors:string[], warnings:string[]}}
 */
function validateFilmBible(b, { runtimeRange = DEFAULT_RANGE } = {}) {
  const errors = [], warnings = [];
  const err = (m) => errors.push(m);
  if (!b || typeof b !== 'object') return { valid: false, errors: ['bible is not an object'], warnings };

  if (!nonEmpty(b.film_id)) err('film_id missing');
  if (!nonEmpty(b.title)) err('title missing');
  if (!nonEmpty(b.genre)) err('genre missing');
  if (!nonEmpty(b.logline)) err('logline missing');
  if (b.standalone !== true) err('standalone must be true (single complete film, not an episode of a series)');
  const hasMax = runtimeRange.max != null;
  if (!(b.runtime_target >= runtimeRange.min && (!hasMax || b.runtime_target <= runtimeRange.max))) {
    err(`runtime_target ${b.runtime_target}s ${hasMax ? `outside ${runtimeRange.min}-${runtimeRange.max}s` : `must be >= ${runtimeRange.min}s`}`);
  }

  // Theme
  if (!nonEmpty(b.theme) || words(b.theme) < 2) err('theme missing (a stated idea the film explores, not one word)');

  // Concrete threat
  const t = b.concrete_threat;
  if (!t || typeof t !== 'object') err('concrete_threat missing');
  else {
    if (!nonEmpty(t.name)) err('concrete_threat.name missing');
    else if (ABSTRACT_ONLY.has(t.name.trim().toLowerCase())) err(`concrete_threat.name "${t.name}" is an abstraction, not a concrete threat`);
    if (!THREAT_TYPES.includes(t.type)) err(`concrete_threat.type must be one of ${THREAT_TYPES.join('|')}`);
    if (words(t.physical_form) < 6) err('concrete_threat.physical_form must describe something perceivable on screen (>= 6 words)');
    if (words(t.how_it_harms) < 4) err('concrete_threat.how_it_harms missing');
    if (words(t.stakes) < 4) err('concrete_threat.stakes missing');
    if (!nonEmpty(t.clock)) err('concrete_threat.clock missing (what makes it urgent)');
    if (!ACTS.includes(t.introduced_in)) err('concrete_threat.introduced_in must be an act id');
    else if (ACTS.indexOf(t.introduced_in) > 1) err('concrete_threat must be introduced by the development act at the latest');
    if (!Array.isArray(t.escalations) || t.escalations.length < 2) err('concrete_threat.escalations needs >= 2 steps');
    if (!nonEmpty(t.resolution_method)) err('concrete_threat.resolution_method missing');
  }

  // Mystery
  const m = b.mystery;
  if (!m || typeof m !== 'object') err('mystery missing');
  else {
    if (!nonEmpty(m.question)) err('mystery.question missing');
    if (!nonEmpty(m.answer)) err('mystery.answer missing');
    if (!Array.isArray(m.clues) || m.clues.length < 3) err('mystery.clues needs >= 3');
    else {
      const actsWithClues = new Set(m.clues.map(c => c.act));
      if (actsWithClues.size < 2) err('mystery.clues must be spread over >= 2 acts');
      for (const c of m.clues) if (!ACTS.includes(c.act) || !nonEmpty(c.clue)) err('every clue needs {act, clue}');
    }
    if (!ACTS.includes(m.reveal_act)) err('mystery.reveal_act must be an act id');
    else if (!['escalation', 'climax'].includes(m.reveal_act)) err('mystery.reveal_act must be escalation or climax — a reveal in the resolution act (or earlier than escalation) breaks the structure');
    if (!nonEmpty(m.reveal_summary)) err('mystery.reveal_summary missing');
  }

  // Acts
  if (!Array.isArray(b.acts) || b.acts.length !== 5 || b.acts.some((a, i) => a.id !== ACTS[i])) {
    err(`acts must be exactly ${ACTS.join(' > ')} in order`);
  } else {
    const sum = b.acts.reduce((s, a) => s + (Number(a.share) || 0), 0);
    if (sum < 0.98 || sum > 1.02) err(`act shares sum to ${sum.toFixed(2)}, expected 1.0`);
    const res = b.acts[4];
    if (!(res.share >= 0.10)) err('resolution act must have >= 10% of runtime (the ending has to actually resolve, not stop at the reveal)');
    if (b.acts.some(a => !nonEmpty(a.summary))) err('every act needs a summary');
  }

  // Ending
  const e = b.ending;
  if (!e || typeof e !== 'object') err('ending missing');
  else {
    if (!ENDING_TYPES.includes(e.type)) err(`ending.type must be one of ${ENDING_TYPES.join('|')}`);
    if (e.resolves_threat !== true) err('ending.resolves_threat must be true');
    if (e.resolves_mystery !== true) err('ending.resolves_mystery must be true');
    if (!THREAT_OUTCOMES.includes(e.threat_outcome)) err(`ending.threat_outcome must be one of ${THREAT_OUTCOMES.join('|')}`);
    if (!nonEmpty(e.mystery_answer_shown) ) err('ending.mystery_answer_shown missing (how the answer is confirmed on screen after the reveal)');
    if (words(e.aftermath) < 6) err('ending.aftermath missing (show the world after the threat)');
    if (!nonEmpty(e.final_image)) err('ending.final_image missing');
    for (const k of ['aftermath', 'final_image', 'mystery_answer_shown']) if (CLIFFHANGER_RE.test(e[k] || '')) err(`ending.${k} contains cliffhanger / sequel language`);
  }
  for (const k of ['logline', 'title']) if (CLIFFHANGER_RE.test(b[k] || '')) err(`${k} contains cliffhanger / sequel language`);
  if (b.next_episode || b.next_hook || b.season || b.episode_number) err('bible carries series fields (next_episode/next_hook/season/episode_number) — films are standalone');

  // Cast / places
  if (!Array.isArray(b.characters) || b.characters.length < 1) err('characters missing');
  else if (!b.characters.some(c => c.role === 'protagonist')) err('no protagonist');
  if (!Array.isArray(b.locations) || b.locations.length < 1) err('locations missing');
  if (!b.visual_style || typeof b.visual_style !== 'object') warnings.push('visual_style missing');
  if (!Array.isArray(b.continuity_rules) || !b.continuity_rules.length) warnings.push('continuity_rules empty');

  return { valid: errors.length === 0, errors, warnings };
}

/** Prevent accidental mutation of validated bibles downstream. */
function freezeBible(b) {
  const f = (o) => { if (o && typeof o === 'object' && !Object.isFrozen(o)) { Object.freeze(o); Object.values(o).forEach(f); } return o; };
  return f(b);
}

module.exports = { ACTS, THREAT_TYPES, THREAT_OUTCOMES, ENDING_TYPES, DEFAULT_RANGE, CLIFFHANGER_RE, validateFilmBible, freezeBible };
