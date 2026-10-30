'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  _buildIntent,
  _resolveDialogueBeatsForIntent,
} = require('../src/ltxVisionDirector');

const CHARACTERS = [
  { name: 'Silas Reeves' },
  { name: 'Bank Witness' },
];

const BEATS = [
  { speaker: 'Silas Reeves', line: 'You do not have access to the records?' },
  { speaker: 'Bank Witness', line: 'I have access to my own files.' },
  { speaker: 'Silas Reeves', line: 'What about the March transfer?' },
  { speaker: 'Bank Witness', line: 'I cannot speak to the full history.' },
  { speaker: 'Silas Reeves', line: 'Do you recognize your signature?' },
  { speaker: 'Bank Witness', line: 'Yes.' },
];

test('LTX vision requires every authoritative dialogue turn, not only a stale dialogue_or_action quote', () => {
  const intent = _buildIntent({
    shot: {
      dialogue_or_action: '"You do not have access to the records?"',
      authoritativeDialogueBeats: BEATS,
      characters_in_shot: CHARACTERS.map(character => character.name),
    },
    scene: {},
  });

  const resolved = _resolveDialogueBeatsForIntent(intent, CHARACTERS);

  assert.equal(resolved.source, 'authoritative-dialogue-registry');
  assert.deepEqual(
    resolved.beats.map(({ speaker, line }) => ({ speaker, line })),
    BEATS
  );
});

test('complete explicit speaker labels override stale ownership while preserving the authoritative turn order', () => {
  const labelledDialogue = BEATS
    .map(({ speaker, line }) => `${speaker}: "${line}"`)
    .join('\n');
  const staleRegistry = BEATS.map(beat => ({
    ...beat,
    speaker: 'Silas Reeves',
  }));
  const intent = _buildIntent({
    shot: {
      dialogue_or_action: labelledDialogue,
      authoritativeDialogueBeats: staleRegistry,
      characters_in_shot: CHARACTERS.map(character => character.name),
    },
    scene: {},
  });

  const resolved = _resolveDialogueBeatsForIntent(intent, CHARACTERS);

  assert.equal(resolved.source, 'explicit-labelled-dialogue');
  assert.deepEqual(
    resolved.beats.map(({ speaker, line }) => ({ speaker, line })),
    BEATS
  );
});