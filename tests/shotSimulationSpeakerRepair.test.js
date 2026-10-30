'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { _resolveShotSpeakerWithRepair, _validateShotSimulationSpeech } = require('../src/scriptWriter');

const CHARACTERS = [{ name: 'Mara' }, { name: 'Dev' }];
const SCENE = { scene_number: 6, characters_present: ['Mara', 'Dev'] };

// Reproduces the exact reported crash: S6/2, dialogue_intent=spoken, two visible
// characters, model returned an empty speaker, and dialogue_purpose doesn't name
// either of them -- so deterministic inference genuinely cannot resolve it alone.
const AMBIGUOUS_SHOT = () => ({
  scene_number: 6, shot_index: 2, dialogue_intent: 'spoken', speaker: '',
  dialogue_purpose: 'A tense exchange about the missing keys.',
  characters_in_shot: ['Mara', 'Dev'],
});

test('reproduces the exact reported crash: _validateShotSimulationSpeech alone cannot resolve an ambiguous two-character shot', () => {
  const result = _validateShotSimulationSpeech(AMBIGUOUS_SHOT(), SCENE, CHARACTERS);
  assert.equal(result.valid, false);
  assert.match(result.reason, /dialogue_intent=spoken requires a named speaker/);
  assert.match(result.reason, /cannot be deterministically resolved/);
});

test('_resolveShotSpeakerWithRepair: resolves the ambiguous shot via a targeted LLM repair call instead of crashing', async () => {
  const calls = [];
  const callLLM = async (system, user) => {
    calls.push({ system, user });
    return { speaker_name: 'Dev' };
  };
  const resolved = await _resolveShotSpeakerWithRepair(AMBIGUOUS_SHOT(), SCENE, CHARACTERS, {
    sceneNo: 6, shotIndex: 2, callLLM,
  });
  assert.equal(calls.length, 1, 'expected exactly one small, targeted repair call');
  assert.match(calls[0].user, /FULL CAST: \["Mara","Dev"\]/);
  assert.match(calls[0].user, /A tense exchange about the missing keys\./);
  assert.equal(resolved.speaker, 'Dev');
  assert.equal(resolved.speaker_name, 'Dev');
});

test('_resolveShotSpeakerWithRepair: a hallucinated name (not in cast) is rejected and retried, not silently accepted', async () => {
  let call = 0;
  const callLLM = async () => {
    call += 1;
    return call === 1 ? { speaker_name: 'Zorblax' } : { speaker_name: 'Mara' };
  };
  const resolved = await _resolveShotSpeakerWithRepair(AMBIGUOUS_SHOT(), SCENE, CHARACTERS, {
    sceneNo: 6, shotIndex: 2, callLLM, maxAttempts: 3,
  });
  assert.equal(call, 2, 'the hallucinated name must not be accepted on the first attempt');
  assert.equal(resolved.speaker, 'Mara');
});

test('_resolveShotSpeakerWithRepair: still throws SHOT_SIMULATION_SPEAKER_REQUIRED (not silently swallowed) if every repair attempt fails', async () => {
  const callLLM = async () => ({ speaker_name: '' });
  await assert.rejects(
    _resolveShotSpeakerWithRepair(AMBIGUOUS_SHOT(), SCENE, CHARACTERS, { sceneNo: 6, shotIndex: 2, callLLM, maxAttempts: 2 }),
    /SHOT_SIMULATION_SPEAKER_REQUIRED S6\/2.*unresolved after 2 repair attempts/
  );
});

test('_resolveShotSpeakerWithRepair: an UNambiguous single-character shot needs no repair call at all', async () => {
  let called = false;
  const callLLM = async () => { called = true; return { speaker_name: 'Mara' }; };
  const shot = { scene_number: 6, shot_index: 1, dialogue_intent: 'spoken', speaker: '', dialogue_purpose: 'greets warmly', characters_in_shot: ['Mara'] };
  const resolved = await _resolveShotSpeakerWithRepair(shot, SCENE, CHARACTERS, { sceneNo: 6, shotIndex: 1, callLLM });
  assert.equal(called, false, 'deterministic single-character inference should resolve this without any LLM call');
  assert.equal(resolved.speaker, 'Mara');
});

test('_resolveShotSpeakerWithRepair: a non-audible shot (ambient/action) is returned untouched, no repair attempted', async () => {
  let called = false;
  const callLLM = async () => { called = true; return {}; };
  const shot = { scene_number: 6, shot_index: 3, dialogue_intent: 'ambient', speaker: '', characters_in_shot: ['Mara', 'Dev'] };
  const resolved = await _resolveShotSpeakerWithRepair(shot, SCENE, CHARACTERS, { sceneNo: 6, shotIndex: 3, callLLM });
  assert.equal(called, false);
  assert.deepEqual(resolved, shot);
});
