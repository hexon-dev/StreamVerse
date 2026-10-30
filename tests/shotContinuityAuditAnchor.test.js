'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { sceneAnchorForStillAudit } = require('../src/shotContinuity');

test('scene first shot is not audited against its own saved anchor still', () => {
  assert.equal(
    sceneAnchorForStillAudit(
      { scene_number: 1, shot_index: 1 },
      'https://assets.example/scene-first-still.png'
    ),
    null
  );
});

test('later shots retain the scene anchor, and missing anchors are not replaced by the current still', () => {
  const anchorUrl = 'https://assets.example/scene-first-still.png';
  assert.equal(
    sceneAnchorForStillAudit({ scene_number: 1, shot_index: 2 }, anchorUrl),
    anchorUrl
  );
  assert.equal(
    sceneAnchorForStillAudit({ scene_number: 1, shot_index: 2 }, ''),
    null
  );
});