'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { _resolveShotSpeechWithRepair, _enforceShotSpeechMetadata } = require('../src/scriptWriter');

const CHARACTERS = [{ name: 'Mara' }, { name: 'Dev' }];
const SCENE = { scene_number: 6, characters_present: ['Mara', 'Dev'] };

test('reproduces SPEECH_SPEAKER_REQUIRED: ambiguous two-character audible shot with no quoted-name resolution', () => {
  const shot = { tts_mode: 'spoken', dialogue_or_action: '"We need to leave now."', characters_in_shot: ['Mara', 'Dev'] };
  assert.throws(() => _enforceShotSpeechMetadata(shot, SCENE, CHARACTERS), /SPEECH_SPEAKER_REQUIRED/);
});

test('reproduces SPEECH_CONTRACT_FAILED: spoken mode but no quoted text at all', () => {
  const shot = { tts_mode: 'spoken', dialogue_or_action: 'Mara says something urgent.', characters_in_shot: ['Mara'] };
  assert.throws(() => _enforceShotSpeechMetadata(shot, SCENE, CHARACTERS), /SPEECH_CONTRACT_FAILED/);
});

test('reproduces SPEAKER_TURN_CONTRACT_FAILED: two known speakers (via staging), two quotes, no per-quote attribution', () => {
  const shot = { tts_mode: 'spoken', dialogue_or_action: '"We need to leave now." "Not without the keys."', characters_in_shot: ['Mara', 'Dev'], character_staging: [{ name: 'Mara', speaking: true }, { name: 'Dev', speaking: true }] };
  assert.throws(() => _enforceShotSpeechMetadata(shot, SCENE, CHARACTERS), /SPEAKER_TURN_CONTRACT_FAILED/);
});

test('_resolveShotSpeechWithRepair: repairs SPEECH_SPEAKER_REQUIRED via a targeted call instead of crashing', async () => {
  const shot = { tts_mode: 'spoken', dialogue_or_action: '"We need to leave now."', characters_in_shot: ['Mara', 'Dev'] };
  const calls = [];
  const callLLM = async (sys, user) => { calls.push(user); return { speaker_name: 'Dev' }; };
  const resolved = await _resolveShotSpeechWithRepair(shot, SCENE, CHARACTERS, { sceneNo: 6, shotIndex: 2, callLLM });
  assert.equal(calls.length, 1);
  assert.match(calls[0], /audible dialogue exists but no deterministic named speaker/);
  assert.equal(resolved.speaker_name, 'Dev');
});

test('_resolveShotSpeechWithRepair: repairs SPEECH_CONTRACT_FAILED by supplying corrected dialogue_or_action', async () => {
  const shot = { tts_mode: 'spoken', dialogue_or_action: 'Mara says something urgent.', characters_in_shot: ['Mara'] };
  const callLLM = async () => ({ dialogue_or_action: 'MARA: "We have to go right now."' });
  const resolved = await _resolveShotSpeechWithRepair(shot, SCENE, CHARACTERS, { sceneNo: 6, shotIndex: 1, callLLM });
  assert.equal(resolved.speaker_name, 'Mara');
  assert.match(resolved.dialogue_or_action, /We have to go right now/);
});

test('_resolveShotSpeechWithRepair: repairs SPEAKER_TURN_CONTRACT_FAILED via an ordered speakers_in_shot list', async () => {
  const shot = { tts_mode: 'spoken', dialogue_or_action: '"We need to leave now." "Not without the keys."', characters_in_shot: ['Mara', 'Dev'], character_staging: [{ name: 'Mara', speaking: true }, { name: 'Dev', speaking: true }] };
  const callLLM = async () => ({ speakers_in_shot: ['Mara', 'Dev'] });
  const resolved = await _resolveShotSpeechWithRepair(shot, SCENE, CHARACTERS, { sceneNo: 6, shotIndex: 4, callLLM });
  assert.deepEqual(resolved.speakers_in_shot, ['Mara', 'Dev']);
});

test('_resolveShotSpeechWithRepair: enumerates long dialogue and preserves one speaker entry per utterance', async () => {
  const cast = [{ name: 'Silas Reeves' }, { name: 'Elara Vance' }];
  const scene = { scene_number: 5, characters_present: cast.map(character => character.name) };
  const utterances = Array.from({ length: 11 }, (_, index) => `"Line ${index + 1}."`);
  const expectedSpeakers = [
    'Silas Reeves', 'Elara Vance', 'Elara Vance', 'Silas Reeves', 'Elara Vance',
    'Silas Reeves', 'Silas Reeves', 'Elara Vance', 'Silas Reeves', 'Elara Vance',
    'Silas Reeves',
  ];
  let repairPrompt = '';
  const callLLM = async (_system, user) => {
    repairPrompt = user;
    return { speakers_in_shot: expectedSpeakers };
  };
  const shot = {
    tts_mode: 'spoken',
    dialogue_or_action: utterances.join(' '),
    characters_in_shot: cast.map(character => character.name),
    character_staging: cast.map(character => ({ name: character.name, speaking: true })),
  };

  const resolved = await _resolveShotSpeechWithRepair(shot, scene, cast, {
    sceneNo: 5, shotIndex: 1, callLLM,
  });

  assert.match(repairPrompt, /EXACT TURN OWNERSHIP TASK: This shot contains 11 quoted utterances/);
  assert.match(repairPrompt, /11\./, 'repair prompt should enumerate all quoted turns');
  assert.match(repairPrompt, /Repeated names are required/);
  assert.deepEqual(resolved.speakers_in_shot, expectedSpeakers);
  assert.equal((resolved.dialogue_or_action.match(/(?:Silas Reeves|Elara Vance):/g) || []).length, 11);

  const revalidated = _enforceShotSpeechMetadata(resolved, scene, cast, { hardFail: false });
  assert.equal(revalidated.valid, true);
  assert.deepEqual(revalidated.shot.speakers_in_shot, expectedSpeakers);
});

test('_resolveShotSpeechWithRepair: a hallucinated name is rejected and retried, not silently accepted', async () => {
  const shot = { tts_mode: 'spoken', dialogue_or_action: '"We need to leave now."', characters_in_shot: ['Mara', 'Dev'] };
  let call = 0;
  const callLLM = async () => { call += 1; return call === 1 ? { speaker_name: 'Zorblax' } : { speaker_name: 'Mara' }; };
  const resolved = await _resolveShotSpeechWithRepair(shot, SCENE, CHARACTERS, { sceneNo: 6, shotIndex: 2, callLLM, maxAttempts: 3 });
  assert.equal(call, 2);
  assert.equal(resolved.speaker_name, 'Mara');
});

test('_resolveShotSpeechWithRepair: still throws (not silently swallowed) if every repair attempt fails, preserving the original error type', async () => {
  const shot = { tts_mode: 'spoken', dialogue_or_action: '"We need to leave now."', characters_in_shot: ['Mara', 'Dev'] };
  const callLLM = async () => ({});
  await assert.rejects(
    _resolveShotSpeechWithRepair(shot, SCENE, CHARACTERS, { sceneNo: 6, shotIndex: 2, callLLM, maxAttempts: 2 }),
    /SPEECH_SPEAKER_REQUIRED: audible dialogue exists but no deterministic named speaker.*unresolved after 2 repair attempts/
  );
});

test('_resolveShotSpeechWithRepair: an already-valid shot needs no repair call at all', async () => {
  let called = false;
  const callLLM = async () => { called = true; return {}; };
  const shot = { tts_mode: 'spoken', dialogue_or_action: '"Hello there."', characters_in_shot: ['Mara'] };
  const resolved = await _resolveShotSpeechWithRepair(shot, SCENE, CHARACTERS, { sceneNo: 6, shotIndex: 1, callLLM });
  assert.equal(called, false);
  assert.equal(resolved.speaker_name, 'Mara');
});

test('_resolveShotSpeechWithRepair: a non-audible shot passes through untouched, no repair attempted', async () => {
  let called = false;
  const callLLM = async () => { called = true; return {}; };
  const shot = { tts_mode: 'ambient', characters_in_shot: ['Mara', 'Dev'] };
  const resolved = await _resolveShotSpeechWithRepair(shot, SCENE, CHARACTERS, { sceneNo: 6, shotIndex: 3, callLLM });
  assert.equal(called, false);
  assert.deepEqual(resolved, shot);
});
