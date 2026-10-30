'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { planFilm } = require('../src/film/planner');
const { FilmOrchestrator } = require('../src/film/orchestrator');
const { MockStoryProvider } = require('../src/film/storyProvider');
const { pickFreshBrief } = require('../src/film/freshBrief');
const { nextFilmId } = require('../src/film/filmRegistry');
const P = require('../src/film/providers');
const { tmp } = require('./helpers');

test('planFilm: omitting minShot/maxShot (as real callers do) never produces NaN durations', async () => {
  const bible = await new MockStoryProvider().generate({ theme: 't', threat_type: 'entity', threat_seed: 's', threat_clock: 'c' }, { runtime: 960 });
  const ids = { characters: { KAI: 'C1', NOVA: 'C2' }, locations: { RELAY: 'L1', STREET: 'L2', GATE: 'L3' }, props: { RADIO: 'P1', CARD: 'P2' } };
  const p = planFilm(bible, ids, {});                      // exactly what routes.js passes: no minShot/maxShot keys at all
  assert.ok(p.shots.length > 0);
  assert.ok(p.shots.every(s => Number.isFinite(s.duration_target) && s.duration_target > 0), 'every shot must have a finite positive duration');
  assert.ok(Number.isFinite(p.planned_runtime));
  assert.deepEqual(p.limits, { minShot: 2, maxShot: 10 }, 'falls back to LTX env defaults');
});
test('planFilm: an explicit {minShot: undefined} (the exact shape that broke in production) still falls back correctly', () => {
  const bible = { film_id: 'VANTA_TEST_001', runtime_target: 100, acts: [{ id: 'beginning', share: 1 }], scenes: [{ scene_id: 'S1', act: 'beginning', location_key: 'X', time_of_day: 'day', characters: ['K'], beats: [{ id: 'B1', action: 'a', characters_in_shot: ['K'] }] }] };
  const p = planFilm(bible, { characters: {}, locations: { X: 'L1' }, props: {} }, { minShot: undefined, maxShot: undefined });
  assert.ok(Number.isFinite(p.shots[0].duration_target));
});
test('FilmOrchestrator: constructing with no minShot/maxShot option (routes.js call shape) produces a finite plan at a real 900-1200s runtime', async () => {
  const d = tmp();
  const bible = await new MockStoryProvider().generate(pickFreshBrief({ seed: 3 }), { runtime: 960, runtimeRange: { min: 900, max: 1200 } });
  bible.film_id = nextFilmId(d, bible.title);
  const o = new FilmOrchestrator({ dataDir: d, bible, providers: { image: new P.MockImageGenerationProvider(), video: new P.MockVideoGenerationProvider(), vision: new P.MockVisionProvider() }, options: { runtimeRange: { min: 900, max: 1200 } } });
  await o.prepareAssets();
  const plan = o.plan();
  assert.ok(plan.shots.every(s => Number.isFinite(s.duration_target)));
  const r = await o.run();
  assert.equal(r.status, 'shots_complete');
});
test('FilmOrchestrator: an explicit-undefined option key never silently disables a numeric default (maxAttempts)', () => {
  const d = tmp();
  const bible = { film_id: 'X', runtime_target: 60, acts: [], scenes: [], characters: [], locations: [] };
  const o = new FilmOrchestrator({ dataDir: d, bible, providers: {}, options: { maxAttempts: undefined, runtimeRange: { min: 1, max: 999 } } });
  assert.equal(o.opt.maxAttempts, 3, 'an omitted-via-undefined option must keep its default, not become undefined/NaN');
});
