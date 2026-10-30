'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const config = require('../src/config');
const { _compactSceneBeatPlan } = require('../src/scriptWriter');

test('computeExpectedSceneCount: preserves old fixed behaviour at the old default (20min movie -> 20 scenes)', () => {
  assert.equal(config.computeExpectedSceneCount({ isSeriesMovie: true, targetMinutes: 20 }), 20);
});
test('computeExpectedSceneCount: scales for longer movies instead of a flat ceiling', () => {
  assert.equal(config.computeExpectedSceneCount({ isSeriesMovie: true, targetMinutes: 30 }), 30);
  assert.equal(config.computeExpectedSceneCount({ isSeriesMovie: true, targetMinutes: 45 }), 45);
  assert.ok(config.computeExpectedSceneCount({ isSeriesMovie: true, targetMinutes: 60 }) > config.computeExpectedSceneCount({ isSeriesMovie: true, targetMinutes: 45 }));
});
test('computeExpectedSceneCount: regular short episodes unchanged at existing tiers', () => {
  assert.equal(config.computeExpectedSceneCount({ isSeriesMovie: false, targetMinutes: 2 }), 8);
  assert.equal(config.computeExpectedSceneCount({ isSeriesMovie: false, targetMinutes: 5 }), 10);
});
test('computeExpectedSceneCount: episodes over 5 minutes scale instead of flatlining at 12', () => {
  const at6 = config.computeExpectedSceneCount({ isSeriesMovie: false, targetMinutes: 6 });
  const at20 = config.computeExpectedSceneCount({ isSeriesMovie: false, targetMinutes: 20 });
  assert.ok(at20 > at6, `expected scene count to grow with runtime, got ${at6} then ${at20}`);
});
test('movieMinSeconds default is 1800s (30 minutes), not the old 1200s (20 minutes) ceiling', () => {
  assert.equal(config.movieMinSeconds, 1800);
});

test('_compactSceneBeatPlan: EVERY scene survives, including the ending, for a long (45-scene) film', () => {
  const scenes = Array.from({ length: 45 }, (_, i) => ({
    scene_number: i + 1, purpose: `purpose of scene ${i + 1} `.repeat(20), opening_state: 'x'.repeat(200),
    causal_event: 'y'.repeat(200), character_state_changes: ['a'.repeat(100)], environment_state_changes: ['b'.repeat(100)],
    dialogue_intent: 'z'.repeat(200), closing_state: 'w'.repeat(200), handoff_to_next_scene: 'v'.repeat(200),
  }));
  const compact = _compactSceneBeatPlan(scenes);
  assert.equal(compact.length, 45, 'no scene should be dropped, regardless of story length');
  assert.equal(compact[compact.length - 1].scene_number, 45, 'the final scene (the ending) must be present');
  const rawSize = JSON.stringify(scenes).length;
  const compactSize = JSON.stringify(compact).length;
  assert.ok(compactSize < rawSize * 0.5, `expected substantial compaction, raw=${rawSize} compact=${compactSize}`);
});
test('_compactSceneBeatPlan: a short plan is not over-compacted (full detail kept when it already fits)', () => {
  const scenes = [{ scene_number: 1, purpose: 'a short purpose', opening_state: 'calm', causal_event: 'a small thing happens', closing_state: 'tense', handoff_to_next_scene: 'walks off' }];
  const compact = _compactSceneBeatPlan(scenes);
  assert.equal(compact[0].purpose, 'a short purpose', 'short text should not be truncated when the budget is not a constraint');
});
test('_compactSceneBeatPlan: empty/missing plan returns empty array, never throws', () => {
  assert.deepEqual(_compactSceneBeatPlan(null), []);
  assert.deepEqual(_compactSceneBeatPlan([]), []);
  assert.deepEqual(_compactSceneBeatPlan(undefined), []);
});
