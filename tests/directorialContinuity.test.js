'use strict';
/**
 * Migrated from src/smoke_test.js (2026-09), which was a real, working smoke test
 * for directorialOrchestrator.js + constraintEnforcer.js but was never wired into
 * anything -- not package.json's test script, not start.sh, nothing. It could only
 * ever be run by someone manually typing `node src/smoke_test.js`, which nobody was
 * doing, so a real regression here could have sat undetected indefinitely. Moving
 * it into the automated suite (npm test) gives it the coverage it was clearly meant
 * to have. Verified passing against current code before this migration.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const orchestrator = require('../src/directorialOrchestrator');
const constraintEnforcer = require('../src/constraintEnforcer');

test('directorial continuity: travel trajectory (depart/in_transit/arrive) and origin-location retention until arrival', () => {
  const scene1 = {
    scene_number: 1, location: 'Apartment',
    shots: [{ scene_number: 1, shot_index: 1, characters_in_shot: ['Mara'], start_state: 'Mara stands in the apartment with the keys.', end_state: 'Mara reaches the car door outside.' }],
  };
  const scene2 = {
    scene_number: 2, location: 'Hospital', origin_location: 'Apartment', destination_location: 'Hospital', location_transition: 'travel', travel_mode: 'drive',
    shots: [
      { scene_number: 2, shot_index: 1, characters_in_shot: ['Mara'] },
      { scene_number: 2, shot_index: 2, characters_in_shot: ['Mara'] },
      { scene_number: 2, shot_index: 3, characters_in_shot: ['Mara'] },
    ],
  };
  const simulation = orchestrator.applyToShotSimulation({ shots: [...scene1.shots, ...scene2.shots] }, [scene1, scene2], { season: 1, episode: 1 });
  const travelShots = simulation.shots.filter(s => s.scene_number === 2);

  assert.deepEqual(travelShots.map(s => s.travel_stage), ['depart', 'in_transit', 'arrive']);
  assert.equal(travelShots[0]._director_state.world.location, 'Apartment');
  assert.equal(travelShots[1]._director_state.world.location, 'Apartment');
  assert.equal(travelShots[2]._director_state.world.location, 'Hospital');

  const mismatch = { ...travelShots[1], travel_stage: 'none' };
  const violations = constraintEnforcer._validateDirectorialState(mismatch, travelShots[0]);
  assert.ok(violations.some(v => v.type === 'directorial_state' && v.severity === 'high'), 'expected contradictory travel state to be rejected');
});

test('directorial continuity: a verified previous-frame bridge permits the settled destination still', () => {
  const previous = {
    scene_number: 2,
    shot_index: 1,
    _director_state: { world: { location: 'Apartment' } },
  };
  const current = {
    scene_number: 2,
    shot_index: 2,
    travel_stage: 'in_transit',
    start_state: 'Mara is already at the Hospital, inside the destination.',
    _director_state: {
      travel: {
        stage: 'in_transit',
        origin: 'Apartment',
        destination: 'Hospital',
        mode: 'drive',
        route_beat: 'The car crosses the final city block.',
      },
      world: { location: 'Apartment' },
      spatial: { blocking: [] },
    },
    _semantic_transition_plan: {
      transition_required: true,
      physical_bridge: 'Mara drives from the apartment to the hospital entrance.',
      target_opening_state: 'Mara stands at the hospital entrance.',
      teleport_risk: 0,
      source: { previous_shot: '2/1', current_shot: '2/2' },
    },
  };

  const violations = constraintEnforcer._validateDirectorialState(current, previous);
  assert.ok(!violations.some(v => v.type === 'teleport'), 'the verified first/last-frame bridge should permit the destination target still');
});

test('directorial continuity: a corrected active prompt takes precedence over stale scripted state', () => {
  const current = {
    scene_number: 2,
    shot_index: 2,
    travel_stage: 'in_transit',
    start_state: 'Mara is already at the Hospital, inside the destination.',
    _director_state: {
      travel: {
        stage: 'in_transit',
        origin: 'Apartment',
        destination: 'Hospital',
        mode: 'drive',
        route_beat: 'The car crosses the final city block.',
      },
      world: { location: 'Apartment' },
      spatial: { blocking: [] },
    },
  };

  const violations = constraintEnforcer._validateDirectorialState(
    current,
    null,
    'Mara remains in the car on the final city block, still approaching the hospital.'
  );
  assert.ok(!violations.some(v => v.type === 'teleport'), 'a repaired prompt should not be rejected using an older start_state');
});

test('directorial continuity: missing scene directive is restored before prompt validation', () => {
  const shot = {
    _continuity_directive: 'Keep Mara on frame left and retain the apartment key in her right hand.',
  };
  const prompt = constraintEnforcer.ensureContinuityDirectiveInPrompt(
    'Mara holds the key in a quiet apartment.',
    shot
  );

  assert.match(prompt, /Scene State continuity:/);
  assert.ok(prompt.includes(shot._continuity_directive));
  assert.deepEqual(constraintEnforcer._validateDirectiveCompliance(shot, prompt), []);
});
