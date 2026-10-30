'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { validateFilmBible, DEFAULT_RANGE } = require('../src/film/filmBible');
const { MockStoryProvider } = require('../src/film/storyProvider');
const { FilmOrchestrator } = require('../src/film/orchestrator');
const P = require('../src/film/providers');
const { nextFilmId } = require('../src/film/filmRegistry');
const { tmp } = require('./helpers');

test('DEFAULT_RANGE has no upper bound', () => {
  assert.equal(DEFAULT_RANGE.min, 900);
  assert.equal(DEFAULT_RANGE.max, null);
});

test('validateFilmBible: a 45-minute film is accepted under the default (unbounded) range', async () => {
  const bible = await new MockStoryProvider().generate({ theme: 'ambition that consumes its own foundation', threat_type: 'entity', threat_seed: 'a swarm of scrap drones', threat_clock: 'before dawn' }, { runtime: 2700 });
  const q = validateFilmBible(bible, {});   // no runtimeRange override -> DEFAULT_RANGE
  assert.ok(q.valid, q.errors.join('; '));
});
test('validateFilmBible: null max is NOT silently coerced to "duration <= 0" (the exact bug class found in qc.js)', () => {
  const bible = { film_id: 'X', title: 'X', genre: 'x', logline: 'x', standalone: true, runtime_target: 3600, theme: 'a real theme here',
    concrete_threat: { name: 'a real thing', type: 'entity', physical_form: 'a visible creature made of smoke and wire', how_it_harms: 'burns anything it touches', stakes: 'the whole crew trapped below with no other way out', clock: 'before dawn', introduced_in: 'beginning', escalations: ['a', 'b'], resolution_method: 'trap it' },
    mystery: { question: 'q', answer: 'a', clues: [{ act: 'beginning', clue: 'c1' }, { act: 'development', clue: 'c2' }, { act: 'escalation', clue: 'c3' }], reveal_act: 'escalation', reveal_summary: 's' },
    acts: [{ id: 'beginning', share: 0.2, summary: 's' }, { id: 'development', share: 0.25, summary: 's' }, { id: 'escalation', share: 0.25, summary: 's' }, { id: 'climax', share: 0.15, summary: 's' }, { id: 'resolution', share: 0.15, summary: 's' }],
    characters: [{ key: 'K', name: 'K', role: 'protagonist' }], locations: [{ key: 'L', name: 'L' }],
    ending: { type: 'emotional', resolves_threat: true, resolves_mystery: true, threat_outcome: 'destroyed', mystery_answer_shown: 'x', aftermath: 'things calm down and the crew walks out into daylight together', final_image: 'a calm street' } };
  const q = validateFilmBible(bible, { runtimeRange: { min: 900, max: null } });
  assert.ok(q.valid, `a very long duration must not be rejected when max is unbounded: ${q.errors.join('; ')}`);
  assert.ok(validateFilmBible({ ...bible, runtime_target: 899 }, { runtimeRange: { min: 900, max: null } }).errors.some(e => /must be >= 900s/.test(e)), 'the floor must still be enforced');
});

test('FilmOrchestrator + finalize: a film with a 30-minute (1800s) nominal target runs end-to-end with an unbounded runtimeRange, and QC\'s runtime gate evaluates correctly rather than always-failing on a null ceiling', async () => {
  const d = tmp();
  const bible = await new MockStoryProvider().generate({ theme: 'a long night tests everyone', threat_type: 'entity', threat_seed: 'a spreading thing', threat_clock: 'by morning' }, { runtime: 1800 });
  bible.film_id = nextFilmId(d, bible.title);
  const o = new FilmOrchestrator({ dataDir: d, bible, providers: { image: new P.MockImageGenerationProvider(), video: new P.MockVideoGenerationProvider(), vision: new P.MockVisionProvider() }, options: { runtimeRange: { min: 100, max: null }, maxRefs: 6 } });
  await o.prepareAssets();
  const plan = o.plan();
  assert.ok(plan.shots.length > 0);
  const r = await o.run();
  assert.equal(r.status, 'shots_complete');
  const { finalizeFilm } = require('../src/film/finalize');
  const out = await finalizeFilm(o, { runtimeRange: { min: 100, max: null } });
  assert.ok(out.qc.gates.assembly.checks.some(c => c.name.startsWith('runtime >=')), 'the unbounded-range label should read as a floor-only check, not "within X-nulls"');
  const runtimeCheck = out.qc.gates.assembly.checks.find(c => c.name.startsWith('runtime >='));
  assert.equal(runtimeCheck.passed, true, `runtime gate must not always-fail when max is null: ${JSON.stringify(runtimeCheck)}`);
});
