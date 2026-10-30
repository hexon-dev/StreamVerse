'use strict';
/**
 * Story providers. The LLM invents the film; deterministic code validates it.
 *
 *   LlmStoryProvider  - generates the film ACT BY ACT, not as one giant JSON blob.
 *                        A single-call "write the whole film" design cannot scale:
 *                        every real LLM API caps a single response's output size,
 *                        so once a film is long enough (more scenes/beats than one
 *                        response can hold) the JSON comes back truncated, fails
 *                        validation, and retries the exact same oversized request —
 *                        an unwinnable loop that gets WORSE the longer the film is,
 *                        i.e. exactly backwards for "no cap on runtime". Generating
 *                        one act at a time keeps every individual call small and
 *                        bounded regardless of total film length, and a bad act can
 *                        be retried on its own instead of regenerating everything.
 *                        Continuity across acts is carried by a state digest built
 *                        from the ACTUAL beats generated so far (src/film/continuity.js
 *                        replayed over the real scenes), not a separate summary the
 *                        LLM could drift from.
 *   MockStoryProvider - deterministic valid film for tests / dry runs.
 */
const { checkStory, checkActScenes } = require('./storyQc');
const { ACTS } = require('./filmBible');
const { initialLedger, applyShot } = require('./continuity');
const { pad } = require('./util');

// Scene density: ~1 scene per minute of runtime, matching the ratio already used
// elsewhere in this codebase (configCore.js computeExpectedSceneCount) for the same
// kind of movie-length content — kept consistent rather than inventing a new ratio.
// No ceiling: a 45-minute film simply asks for ~45 scenes, split across 5 act-calls.
function totalSceneTarget(runtimeSeconds) {
  return Math.max(7, Math.round(runtimeSeconds / 60));
}
function sceneCountForAct(bible, actId, total) {
  const act = bible.acts.find(a => a.id === actId);
  const share = act ? act.share : 1 / ACTS.length;
  return Math.max(1, Math.round(total * share));
}

/** What must / must not appear in a given act, derived from the skeleton the LLM already committed to. */
function actRequirements(bible, actId) {
  const required = [], forbidden = [], counts = {};
  const introducedAt = ACTS.indexOf(bible.concrete_threat?.introduced_in || 'beginning');
  if (ACTS.indexOf(actId) === introducedAt) required.push('threat_introduced');
  if (actId === bible.mystery?.reveal_act) required.push('reveal'); else forbidden.push('reveal');
  if (actId === 'resolution') counts.threat_escalation = 2;   // checked cumulatively via priorMarkCounts once the whole film's beats are known
  if (actId === 'resolution') required.push('threat_resolved', 'mystery_answered', 'final_image');
  else forbidden.push('threat_resolved', 'mystery_answered', 'final_image');
  return { required, forbidden, counts };
}

/** Compact, human-readable snapshot of where the story actually stands, built from the real generated beats (never a separately-written, driftable summary). */
function stateDigest(bible, scenesSoFar) {
  if (!scenesSoFar.length) return 'Nothing has happened yet — this is the opening of the film.';
  const stubIds = { characters: {}, locations: {}, props: {} };
  let state = initialLedger(bible, stubIds);
  for (const sc of scenesSoFar) for (const bt of sc.beats) state = applyShot(state, { ...bt, characters: bt.characters_in_shot || [], scene_id: sc.scene_id }, sc);
  const chars = Object.entries(state.characters).map(([k, c]) => `${k}: wearing ${c.wardrobe}${c.injuries.length ? `, injuries: ${c.injuries.join(', ')}` : ''}${c.holding.length ? `, holding: ${c.holding.join(', ')}` : ''}`).join('; ');
  const props = Object.entries(state.props).filter(([, p]) => p.present || p.held).map(([k, p]) => `${k}: ${p.held ? `held by ${p.owner}` : `at ${p.location || 'last seen location'}`}`).join('; ') || 'none notable';
  const last = scenesSoFar[scenesSoFar.length - 1];
  return [
    `Last location: ${state.environment.location_id || last.location_key}, ${state.environment.time_of_day}.`,
    `Characters: ${chars}.`,
    `Props in play: ${props}.`,
    `Known to characters so far: ${state.story.known_info.join(', ') || 'nothing established yet'}.`,
    `Threat level so far: ${state.story.threat_level}.`,
    `Most recent event: ${state.story.recent_event}`,
  ].join('\n');
}

function buildSkeletonPrompt(brief, { runtime = 1080, revealAct = 'escalation' } = {}) {
  const system = [
    'You are the head writer of VANTA / StreamVerse Studios. You write ONE complete standalone short film.',
    'It is NOT an episode. There is no series, no season, no sequel. The film must be understandable and finished on its own.',
    'Return ONLY JSON.',
  ].join(' ');
  const user = `Plan a standalone film (~${Math.round(runtime / 60)} minutes) — the FILM BIBLE ONLY. Do not write scenes yet; that comes next, act by act.

THEME (must be explored, not just mentioned): ${brief.theme}
CONCRETE THREAT (type: ${brief.threat_type}): ${brief.threat_seed}. Clock: ${brief.threat_clock}.
The threat must be a perceivable thing, person or event with a physical form on screen, real stakes, and rising escalations.
Never use an abstraction (fear, grief, loneliness...) as the threat.

STRUCTURE (mandatory): five acts in order: beginning, development, escalation, climax, resolution, with "share" fractions of total runtime summing to 1.0 (resolution >= 0.10).
The MYSTERY must be revealed in the "${revealAct}" act and then ANSWERED in the ending — plan clues spread across at least two different acts, and be specific about how the ending confirms the answer on screen. No cliffhanger, no "to be continued", no hook for another film anywhere, including in the ending fields.
Be genuinely inventive: give this film a distinct voice, a specific world, and characters with concrete, unusual detail rather than generic archetypes. Avoid reusing common tropes verbatim — surprise within the required structure.

JSON schema (exactly this shape, no scenes field):
{ "film_id":"", "title":"", "genre":"", "runtime_target":${runtime}, "logline":"", "theme":"", "standalone":true,
  "concrete_threat":{"name":"","type":"${brief.threat_type}","physical_form":"","how_it_harms":"","stakes":"","clock":"","introduced_in":"beginning|development","escalations":["",""],"resolution_method":""},
  "mystery":{"question":"","answer":"","clues":[{"act":"","clue":""}],"reveal_act":"${revealAct}","reveal_summary":""},
  "acts":[{"id":"beginning","share":0.2,"summary":""},{"id":"development","share":0.25,"summary":""},{"id":"escalation","share":0.25,"summary":""},{"id":"climax","share":0.15,"summary":""},{"id":"resolution","share":0.15,"summary":""}],
  "characters":[{"key":"","name":"","role":"protagonist|antagonist|ally|supporting","description":"","canonical":{"hair":"","eyes":"","face":"","body":"","marks":"","age_representation":"","wardrobe_default":"","voice_identity":"","personality":""}}],
  "locations":[{"key":"","name":"","description":""}],
  "props":[{"key":"","name":"","description":""}],
  "visual_style":{}, "continuity_rules":[""],
  "ending":{"type":"twist|emotional|tragic|hopeful|ambiguous_tone|shocking","resolves_threat":true,"resolves_mystery":true,"threat_outcome":"destroyed|contained|escaped|defeated|neutralised|paid_for","mystery_answer_shown":"","aftermath":"","final_image":""}
}`;
  return { system, user };
}

function buildActPrompt(bible, actId, { sceneCount, startSceneNumber, isLastAct, requirements }) {
  const filmKey = bible.film_id;
  const act = bible.acts.find(a => a.id === actId);
  const priorScenes = (bible.scenes || []).filter(s => ACTS.indexOf(s.act) < ACTS.indexOf(actId));
  const system = 'You are the head writer of VANTA / StreamVerse Studios, continuing a film you already planned. Return ONLY JSON: a single array of scene objects for the requested act.';
  const clues = (bible.mystery.clues || []).filter(c => c.act === actId);
  const user = `FILM: "${bible.title}" — ${bible.logline}
THEME: ${bible.theme}
THREAT: ${bible.concrete_threat.name} (${bible.concrete_threat.physical_form}). Clock: ${bible.concrete_threat.clock}.
MYSTERY: ${bible.mystery.question}
CHARACTERS: ${bible.characters.map(c => `${c.key} (${c.name}, ${c.role}): ${c.canonical.hair}, ${c.canonical.eyes}, wears ${c.canonical.wardrobe_default} by default, voice: ${c.canonical.voice_identity}, personality: ${c.canonical.personality}`).join(' | ')}
LOCATIONS: ${bible.locations.map(l => `${l.key} (${l.name}): ${l.description}`).join(' | ')}
PROPS: ${bible.props.map(p => `${p.key} (${p.name}): ${p.description}`).join(' | ') || 'none defined'}

STORY SO FAR:
${stateDigest(bible, priorScenes)}

NOW WRITE ACT "${actId}" — ${act.summary}
This act should have about ${sceneCount} scene(s), numbered starting at S${pad(startSceneNumber)}, each with 1-3 beats.
${clues.length ? `Weave in these clues as something a character notices or finds: ${clues.map(c => c.clue).join('; ')}.` : ''}
${requirements.required.length ? `At least one beat in THIS act must carry the mark: ${requirements.required.join(', ')}.` : ''}
${requirements.counts.threat_escalation ? `Across the WHOLE film so far (all acts up to and including this one), there must be at least ${requirements.counts.threat_escalation} beats marked "threat_escalation" in total -- add one now if the running total is still short.` : ''}
${requirements.forbidden.length ? `Do NOT use these marks in this act: ${requirements.forbidden.join(', ')}.` : ''}
${isLastAct ? 'This is the FINAL act. The very last beat of the very last scene must be marked "final_image" and must show the world after the threat, with no cliffhanger or sequel language. Confirm the mystery\'s answer on screen (mark a beat "mystery_answered") and show the threat dealt with (mark a beat "threat_resolved").' : ''}
Keep continuity with the state above: characters keep their established wardrobe/injuries/held props unless a beat explicitly changes them; nobody acts on information they have not yet learned (use "uses_info" only for entries already known, from state_changes.story.known_info_add in a prior beat or this act's own earlier beats).
Give this act a genuinely creative, specific texture — concrete sensory detail, distinct character voice in dialogue, and inventive staging — while keeping the plot mechanics exactly as planned above.

Return ONLY a JSON array (no wrapper object) of scenes in this exact shape:
[{"scene_id":"S${pad(startSceneNumber)}","act":"${actId}","location_key":"","time_of_day":"","characters":[""],"summary":"","beats":[{"id":"S${pad(startSceneNumber)}B01","action":"","dialogue":[{"speaker":"","text":""}],"camera":"","exit_dir":"","marks":[],"characters_in_shot":[""],"props_in_shot":[""],"uses_info":[],"reveals":[],"state_changes":{"characters":{},"props":{},"environment":{},"story":{}}}]}]`;
  return { system, user };
}

class LlmStoryProvider {
  constructor({ callLLM, maxAttempts = 3, maxTokens = 6000, log = () => {} }) { Object.assign(this, { callLLM, maxAttempts, maxTokens, log }); }

  async _generateSkeleton(brief, opts) {
    let { system, user } = buildSkeletonPrompt(brief, opts);
    let lastErrors;
    for (let attempt = 1; attempt <= this.maxAttempts; attempt++) {
      const bible = await this.callLLM(system, user, this.maxTokens, { useStream: false });
      bible.scenes = [];                                    // not written yet; keeps validateFilmBible's shape expectations happy
      const { validateFilmBible } = require('./filmBible');
      const q = validateFilmBible(bible, opts);
      if (q.valid) return bible;
      lastErrors = q.errors;
      this.log(`[Story] skeleton attempt ${attempt} rejected: ${q.errors.slice(0, 5).join(' | ')}`);
      user = `${user}\n\nYOUR PREVIOUS DRAFT WAS REJECTED. Fix every problem and return the complete JSON again:\n- ${q.errors.join('\n- ')}`;
    }
    const e = new Error(`Film Bible (skeleton) failed validation after ${this.maxAttempts} attempts: ${lastErrors.slice(0, 6).join('; ')}`); e.errors = lastErrors; throw e;
  }

  async _generateAct(bible, actId, ctx) {
    const requirements = actRequirements(bible, actId);
    let { system, user } = buildActPrompt(bible, actId, { ...ctx, requirements });
    let lastErrors;
    for (let attempt = 1; attempt <= this.maxAttempts; attempt++) {
      const scenes = await this.callLLM(system, user, this.maxTokens, { useStream: false });
      const arr = Array.isArray(scenes) ? scenes : Array.isArray(scenes?.scenes) ? scenes.scenes : null;
      const q = arr ? checkActScenes(actId, arr, bible, { isLastAct: ctx.isLastAct, requiredMarks: requirements.required, requiredCounts: requirements.counts, forbiddenMarks: requirements.forbidden, globalBeatIds: ctx.globalBeatIds, globalSceneIds: ctx.globalSceneIds, priorMarkCounts: ctx.globalMarkCounts })
                    : { valid: false, errors: [`act "${actId}": response was not a JSON array of scenes`] };
      if (q.valid) return arr;
      lastErrors = q.errors;
      this.log(`[Story] act "${actId}" attempt ${attempt} rejected: ${q.errors.slice(0, 5).join(' | ')}`);
      user = `${user}\n\nYOUR PREVIOUS DRAFT WAS REJECTED. Fix every problem and return the complete JSON array again:\n- ${q.errors.join('\n- ')}`;
    }
    const e = new Error(`Act "${actId}" failed validation after ${this.maxAttempts} attempts: ${lastErrors.slice(0, 6).join('; ')}`); e.errors = lastErrors; throw e;
  }

  async generate(brief, { runtime = 1080, revealAct = 'escalation', runtimeRange } = {}) {
    const bible = await this._generateSkeleton(brief, { runtime, revealAct, runtimeRange });
    const total = totalSceneTarget(runtime);
    bible.scenes = [];
    const globalBeatIds = new Set(), globalSceneIds = new Set();
    const globalMarkCounts = {};
    let sceneNumber = 1;
    for (let i = 0; i < ACTS.length; i++) {
      const actId = ACTS[i];
      const sceneCount = sceneCountForAct(bible, actId, total);
      const scenes = await this._generateAct(bible, actId, { sceneCount, startSceneNumber: sceneNumber, isLastAct: i === ACTS.length - 1, globalBeatIds, globalSceneIds, globalMarkCounts });
      for (const sc of scenes) { globalSceneIds.add(sc.scene_id); for (const bt of sc.beats) { globalBeatIds.add(bt.id); for (const m of bt.marks || []) globalMarkCounts[m] = (globalMarkCounts[m] || 0) + 1; } }
      bible.scenes.push(...scenes);
      sceneNumber += scenes.length;
      this.log(`[Story] act "${actId}" complete: ${scenes.length} scene(s), ${bible.scenes.length} total so far`);
    }
    // Final whole-film safety net: catches cross-act invariants (post-reveal share,
    // resolution runtime share) that only make sense once the full timeline exists.
    const q = checkStory(bible, { runtimeRange });
    if (!q.valid) {
      const e = new Error(`Assembled film failed final validation: ${q.errors.slice(0, 8).join('; ')}`); e.errors = q.errors; throw e;
    }
    bible.brief = brief;
    return bible;
  }
}

/** Deterministic, valid film. `runtime` in seconds (tests use short runtimes). */
class MockStoryProvider {
  async generate(brief, { runtime = 1080, revealAct = 'escalation', filmId = 'VANTA_FILM_MOCK' } = {}) {
    const B = (id, action, extra = {}) => ({ id, action, dialogue: [], camera: 'medium tracking', exit_dir: '', marks: [], characters_in_shot: ['KAI'], props_in_shot: [], uses_info: [], reveals: [], state_changes: {}, ...extra });
    const scenes = [
      { scene_id: 'S01', act: 'beginning', location_key: 'RELAY', time_of_day: 'dusk', characters: ['KAI'], summary: 'Kai works the relay; the first signs of the threat appear.', beats: [
        B('S01B01', 'Kai walks the relay corridor, radio on his belt, toward frame right.', { exit_dir: 'right', props_in_shot: ['RADIO'], state_changes: { props: { RADIO: { owner: 'KAI', held: true } } } }),
        B('S01B02', `Kai notices ${brief.threat_seed} for the first time.`, { marks: ['threat_introduced'], reveals: ['first_sighting'], state_changes: { story: { threat_level: 1, known_info_add: ['first_sighting'] } } })] },
      { scene_id: 'S02', act: 'beginning', location_key: 'RELAY', time_of_day: 'dusk', characters: ['KAI', 'NOVA'], summary: 'Nova arrives and doubts him.', beats: [
        B('S02B01', 'Nova enters from the left; Kai turns to face her.', { characters_in_shot: ['KAI', 'NOVA'], dialogue: [{ speaker: 'NOVA', text: 'You called the whole shift in for a rumour?' }] }),
        B('S02B02', 'Kai shows Nova the scorch mark on the wall.', { characters_in_shot: ['KAI', 'NOVA'], dialogue: [{ speaker: 'KAI', text: 'It is not a rumour. It is a clock.' }], state_changes: { story: { known_info_add: ['the_clock'] } } })] },
      { scene_id: 'S03', act: 'development', location_key: 'STREET', time_of_day: 'night', characters: ['KAI', 'NOVA'], summary: 'They investigate the street.', beats: [
        B('S03B01', 'Kai and Nova cross the street; Kai pulls on a grey work jacket.', { characters_in_shot: ['KAI', 'NOVA'], state_changes: { characters: { KAI: { wardrobe: 'grey work jacket over black shirt' } } } }),
        B('S03B02', 'Nova finds the warden\'s access card in the gutter.', { characters_in_shot: ['NOVA'], props_in_shot: ['CARD'], reveals: ['warden_card'], state_changes: { props: { CARD: { owner: 'NOVA', held: true } }, story: { known_info_add: ['warden_card'] } } })] },
      { scene_id: 'S04', act: 'development', location_key: 'STREET', time_of_day: 'night', characters: ['KAI', 'NOVA'], summary: 'The threat forces a choice.', beats: [
        B('S04B01', 'The threat surges; Kai is cut on the cheek and drops the radio.', { characters_in_shot: ['KAI', 'NOVA'], marks: ['threat_escalation'], props_in_shot: ['RADIO'], state_changes: { characters: { KAI: { injuries: ['cut on left cheek'] } }, props: { RADIO: { owner: null, held: false, location: 'street gutter' } }, story: { threat_level: 2 } } }),
        B('S04B02', 'Nova hauls Kai to his feet and they run toward the gate.', { characters_in_shot: ['KAI', 'NOVA'], exit_dir: 'left' })] },
      { scene_id: 'S05', act: 'escalation', location_key: 'GATE', time_of_day: 'night', characters: ['KAI', 'NOVA'], summary: 'At the gate, the mystery breaks open.', beats: [
        B('S05B01', 'The gate terminal lights up; the threat presses closer.', { characters_in_shot: ['KAI', 'NOVA'], marks: ['threat_escalation'], state_changes: { story: { threat_level: 3 } } }),
        B('S05B02', 'Kai scans the warden\'s card: the warden started the failure to hide a fault.', { characters_in_shot: ['KAI', 'NOVA'], marks: revealAct === 'escalation' ? ['reveal'] : [], uses_info: ['warden_card'], dialogue: [{ speaker: 'KAI', text: 'The warden did this. He hid the fault.' }], reveals: ['culprit'], state_changes: { story: { known_info_add: ['culprit'] } } })] },
      { scene_id: 'S06', act: 'climax', location_key: 'GATE', time_of_day: 'night', characters: ['KAI', 'NOVA'], summary: 'The confrontation with the threat.', beats: [
        B('S06B01', 'Kai overrides the terminal while the threat batters the gate.', { characters_in_shot: ['KAI', 'NOVA'], uses_info: ['culprit'] }),
        B('S06B02', 'Nova cuts the main breaker; the threat collapses into dust.', { characters_in_shot: ['NOVA', 'KAI'], marks: ['climax'], state_changes: { story: { threat_level: 0 } } })] },
      { scene_id: 'S07', act: 'resolution', location_key: 'RELAY', time_of_day: 'dawn', characters: ['KAI', 'NOVA'], summary: 'The threat is gone; the truth is confirmed.', beats: [
        B('S07B01', 'At dawn the threat is confirmed destroyed; the warden\'s confession plays on the terminal.', { characters_in_shot: ['KAI', 'NOVA'], marks: ['threat_resolved', 'mystery_answered'], dialogue: [{ speaker: 'NOVA', text: 'It was him all along, and now it is over.' }] }),
        B('S07B02', 'Kai picks up the radio and looks out over the quiet, lit street.', { characters_in_shot: ['KAI'], marks: ['final_image'], props_in_shot: ['RADIO'], state_changes: { props: { RADIO: { owner: 'KAI', held: true } } } })] },
    ];
    return {
      film_id: filmId, title: 'THE LAST RELAY', genre: 'thriller', runtime_target: runtime, standalone: true,
      logline: 'A relay technician races a spreading failure and uncovers who caused it.', theme: brief.theme,
      concrete_threat: { name: 'The Blackout Front', type: brief.threat_type, physical_form: `${brief.threat_seed}, visible as a moving wall of dark`, how_it_harms: 'kills every powered system it touches', stakes: 'the last shelter and everyone inside it', clock: brief.threat_clock, introduced_in: 'beginning', escalations: ['it reaches the street', 'it reaches the gate'], resolution_method: 'cut the main breaker so it has nothing to feed on' },
      mystery: { question: 'Who started the failure, and why?', answer: 'The warden, to hide a fault he was responsible for.', clues: [{ act: 'beginning', clue: 'a scorch mark on the wall' }, { act: 'development', clue: "the warden's card in the gutter" }, { act: 'escalation', clue: 'the terminal log' }], reveal_act: revealAct, reveal_summary: 'The warden triggered the failure to hide a fault.' },
      acts: [{ id: 'beginning', share: 0.2, summary: 'The first sign.' }, { id: 'development', share: 0.25, summary: 'Investigation.' }, { id: 'escalation', share: 0.25, summary: 'The reveal.' }, { id: 'climax', share: 0.15, summary: 'Confrontation.' }, { id: 'resolution', share: 0.15, summary: 'Outcome.' }],
      characters: [
        { key: 'KAI', name: 'Kai', role: 'protagonist', description: 'A relay technician in his thirties.', canonical: { hair: 'short black hair', eyes: 'brown eyes', face: 'narrow face, scar through the left eyebrow', body: 'lean build', marks: 'scar on left eyebrow', age_representation: 'mid thirties', wardrobe_default: 'black utility shirt and dark trousers', voice_identity: 'low, measured', personality: 'careful, stubborn' } },
        { key: 'NOVA', name: 'Nova', role: 'ally', description: 'A shift supervisor.', canonical: { hair: 'silver braid', eyes: 'green eyes', face: 'sharp cheekbones', body: 'tall, athletic', marks: 'none', age_representation: 'early forties', wardrobe_default: 'orange supervisor vest over grey coverall', voice_identity: 'clipped, warm', personality: 'pragmatic' } }],
      locations: [{ key: 'RELAY', name: 'Relay Corridor', description: 'A long steel corridor with amber lights.' }, { key: 'STREET', name: 'Lower Street', description: 'A wet street beneath the relay.' }, { key: 'GATE', name: 'Shelter Gate', description: 'A reinforced gate with a control terminal.' }],
      props: [{ key: 'RADIO', name: 'Radio', description: 'Yellow handheld radio.' }, { key: 'CARD', name: "Warden's Card", description: 'A white access card with a red stripe.' }],
      visual_style: { look: 'cinematic, cool teal shadows, amber practicals', aspect: '9:16' },
      continuity_rules: ['Kai keeps the scar on his left eyebrow', 'Wardrobe only changes when a beat records it'],
      ending: { type: 'emotional', resolves_threat: true, resolves_mystery: true, threat_outcome: 'destroyed', mystery_answer_shown: "The warden's confession plays on the terminal.", aftermath: 'The street lights come back on and people step outside.', final_image: 'Kai stands in the lit street holding the radio at dawn.' },
      scenes,
    };
  }
}

module.exports = { buildSkeletonPrompt, buildActPrompt, totalSceneTarget, sceneCountForAct, actRequirements, stateDigest, LlmStoryProvider, MockStoryProvider };
