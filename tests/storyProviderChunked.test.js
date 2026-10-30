'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { LlmStoryProvider, totalSceneTarget } = require('../src/film/storyProvider');
const { checkStory } = require('../src/film/storyQc');
const { ACTS } = require('../src/film/filmBible');

const BRIEF = { theme: 'trust is the first thing a crisis destroys', threat_type: 'phenomenon', threat_seed: 'a blackout front that moves street by street', threat_clock: 'it reaches the shelter at dawn' };

const SKELETON = {
  film_id: 'VANTA_TEST_CHUNK', title: 'The Long Night', genre: 'thriller', runtime_target: 0, logline: 'A technician and a supervisor race a spreading blackout and uncover who caused it.',
  theme: BRIEF.theme, standalone: true,
  concrete_threat: { name: 'The Blackout Front', type: 'phenomenon', physical_form: 'a moving wall of dead electronics and dark', how_it_harms: 'kills anything powered it touches', stakes: 'everyone in the shelter', clock: BRIEF.threat_clock, introduced_in: 'beginning', escalations: ['reaches the street', 'reaches the gate'], resolution_method: 'cut the main breaker' },
  mystery: { question: 'who started it', answer: 'the warden, to hide a fault', clues: [{ act: 'beginning', clue: 'a scorch mark' }, { act: 'development', clue: "the warden's card" }, { act: 'escalation', clue: 'the terminal log' }], reveal_act: 'escalation', reveal_summary: 'the warden did it' },
  acts: [{ id: 'beginning', share: 0.2, summary: 'first signs' }, { id: 'development', share: 0.25, summary: 'investigation' }, { id: 'escalation', share: 0.25, summary: 'the reveal' }, { id: 'climax', share: 0.15, summary: 'confrontation' }, { id: 'resolution', share: 0.15, summary: 'aftermath' }],
  characters: [{ key: 'KAI', name: 'Kai', role: 'protagonist', description: 'a technician', canonical: { hair: 'black hair', eyes: 'brown eyes', face: 'scar on eyebrow', body: 'lean', marks: 'scar', age_representation: 'mid-30s', wardrobe_default: 'black shirt', voice_identity: 'low', personality: 'stubborn' } },
                { key: 'NOVA', name: 'Nova', role: 'ally', description: 'a supervisor', canonical: { hair: 'silver braid', eyes: 'green eyes', face: 'sharp', body: 'tall', marks: 'none', age_representation: '40s', wardrobe_default: 'orange vest', voice_identity: 'clipped', personality: 'pragmatic' } }],
  locations: [{ key: 'RELAY', name: 'Relay', description: 'a corridor' }, { key: 'STREET', name: 'Street', description: 'a wet street' }, { key: 'GATE', name: 'Gate', description: 'a reinforced gate' }],
  props: [{ key: 'RADIO', name: 'Radio', description: 'a handheld radio' }, { key: 'CARD', name: 'Card', description: "the warden's card" }],
  visual_style: { look: 'teal and amber' }, continuity_rules: ['Kai keeps his scar'],
  ending: { type: 'emotional', resolves_threat: true, resolves_mystery: true, threat_outcome: 'destroyed', mystery_answer_shown: 'the confession plays on the terminal', aftermath: 'the lights come back on and the street is calm', final_image: 'Kai stands in the lit street at dawn' },
};

/** Fake multi-call LLM: 1 skeleton call + 5 act calls. Generates `scenesPerAct[actId]` scenes per act, each with plausible beats. Tracks every call's (system,user,maxTokens) for assertions. */
function makeFakeLLM({ scenesPerAct, failFirstAttemptOf = null } = {}) {
  const calls = []; const failedOnce = new Set();
  let sceneCounter = 1;
  const fn = async (system, user, maxTokens) => {
    calls.push({ system, user, maxTokens });
    const actMatch = /NOW WRITE ACT "(\w+)"/.exec(user);
    if (!actMatch) { const b = JSON.parse(JSON.stringify(SKELETON)); b.runtime_target = Number(/~(\d+) minutes/.exec(user)[1]) * 60; return b; }
    const actId = actMatch[1];
    if (failFirstAttemptOf === actId && !failedOnce.has(actId)) { failedOnce.add(actId); return { not: 'an array, deliberately wrong shape' }; }
    const n = scenesPerAct[actId] || 1;
    const scenes = [];
    for (let i = 0; i < n; i++) {
      const sceneNum = sceneCounter++;
      const marks = [];
      if (actId === 'beginning' && i === 0) marks.push('threat_introduced');
      if (actId === 'escalation' && i === 0) marks.push('threat_escalation');
      if (actId === 'escalation' && i === n - 1) marks.push('reveal');
      if (actId === 'climax' && i === 0) marks.push('threat_escalation');
      const beats = [{ id: `S${String(sceneNum).padStart(2, '0')}B01`, action: `Something happens in ${actId} scene ${i + 1}.`, dialogue: [], camera: 'medium', exit_dir: '', marks, characters_in_shot: ['KAI'], props_in_shot: [], uses_info: [], reveals: [], state_changes: {} }];
      if (actId === 'resolution' && i === n - 1) {
        beats.push({ id: `S${String(sceneNum).padStart(2, '0')}B02`, action: 'The threat is confirmed destroyed and the answer is shown.', dialogue: [], camera: 'wide', exit_dir: '', marks: ['threat_resolved', 'mystery_answered'], characters_in_shot: ['KAI'], props_in_shot: [], uses_info: [], reveals: [], state_changes: {} });
        beats.push({ id: `S${String(sceneNum).padStart(2, '0')}B03`, action: 'Kai stands quietly in the calm, lit street.', dialogue: [], camera: 'wide', exit_dir: '', marks: ['final_image'], characters_in_shot: ['KAI'], props_in_shot: [], uses_info: [], reveals: [], state_changes: {} });
      }
      scenes.push({ scene_id: `S${String(sceneNum).padStart(2, '0')}`, act: actId, location_key: 'RELAY', time_of_day: 'night', characters: ['KAI'], summary: `${actId} scene ${i + 1}`, beats });
    }
    return scenes;
  };
  return { fn, calls };
}

test('LlmStoryProvider: never sends a single call for the whole film -- one call per act plus one skeleton call', async () => {
  const { fn, calls } = makeFakeLLM({ scenesPerAct: { beginning: 2, development: 2, escalation: 2, climax: 1, resolution: 2 } });
  const provider = new LlmStoryProvider({ callLLM: fn, maxTokens: 6000 });
  const bible = await provider.generate(BRIEF, { runtime: 600, runtimeRange: { min: 60, max: 3600 } });
  assert.equal(calls.length, 6, 'expected exactly 1 skeleton call + 5 act calls');
  assert.ok(calls.every(c => c.maxTokens <= 6000), 'no single call should need a large token budget regardless of film length');
  const q = checkStory(bible, { runtimeRange: { min: 60, max: 3600 } });
  assert.ok(q.valid, 'assembled film must pass full validation: ' + q.errors.join('; '));
});

test('LlmStoryProvider: a 45-minute film still uses small, bounded per-call requests (this is exactly what breaks a single-call design)', async () => {
  const { fn, calls } = makeFakeLLM({ scenesPerAct: { beginning: 9, development: 11, escalation: 11, climax: 7, resolution: 7 } }); // ~45 scenes
  const provider = new LlmStoryProvider({ callLLM: fn, maxTokens: 6000 });
  const bible = await provider.generate(BRIEF, { runtime: 2700, runtimeRange: { min: 60, max: 5000 } }); // 45 minutes
  assert.equal(bible.scenes.length, 45);
  assert.equal(calls.length, 6, 'still just 6 calls no matter how long the film is');
  const q = checkStory(bible, { runtimeRange: { min: 60, max: 5000 } });
  assert.ok(q.valid, q.errors.join('; '));
  assert.equal(bible.scenes[bible.scenes.length - 1].beats.slice(-1)[0].marks[0], 'final_image');
});

test('LlmStoryProvider: a bad act is retried ON ITS OWN -- earlier accepted acts are not touched or re-sent for regeneration', async () => {
  const { fn, calls } = makeFakeLLM({ scenesPerAct: { beginning: 1, development: 1, escalation: 1, climax: 1, resolution: 2 }, failFirstAttemptOf: 'climax' });
  const provider = new LlmStoryProvider({ callLLM: fn, maxTokens: 6000 });
  const bible = await provider.generate(BRIEF, { runtime: 300, runtimeRange: { min: 60, max: 3600 } });
  assert.equal(calls.length, 7, 'skeleton + 5 acts + one extra retry for the failed act');
  assert.ok(checkStory(bible, { runtimeRange: { min: 60, max: 3600 } }).valid);
});

test('LlmStoryProvider: continuity digest sent to each act reflects the ACTUAL beats generated, not a static string', async () => {
  const { fn, calls } = makeFakeLLM({ scenesPerAct: { beginning: 1, development: 1, escalation: 1, climax: 1, resolution: 2 } });
  const provider = new LlmStoryProvider({ callLLM: fn, maxTokens: 6000 });
  await provider.generate(BRIEF, { runtime: 300, runtimeRange: { min: 60, max: 3600 } });
  const devCall = calls.find(c => /NOW WRITE ACT "development"/.test(c.user));
  assert.match(devCall.user, /STORY SO FAR:/);
  assert.doesNotMatch(devCall.user, /Nothing has happened yet/, 'by the development act, something has already happened');
  const beginningCall = calls.find(c => /NOW WRITE ACT "beginning"/.test(c.user));
  assert.match(beginningCall.user, /Nothing has happened yet/, 'the opening act has no prior state');
});

test('totalSceneTarget scales with runtime and has no ceiling', () => {
  assert.equal(totalSceneTarget(1200), 20);
  assert.ok(totalSceneTarget(2700) > totalSceneTarget(1800));
  assert.ok(totalSceneTarget(5400) > totalSceneTarget(2700), 'a 90-minute request should still get proportionally more scenes, no cap');
});
