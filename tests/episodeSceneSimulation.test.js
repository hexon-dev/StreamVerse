'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const scriptWriter = fs.readFileSync(path.join(__dirname, '../src/scriptWriter.js'), 'utf8');

test('episode scene location defaults do not reference the scene while it is initializing', () => {
  const rawSceneStart = scriptWriter.indexOf('const rawScene = result?.scene');
  const sceneStart = scriptWriter.indexOf('const scene = {', rawSceneStart);
  const sceneEnd = scriptWriter.indexOf('\n    };', sceneStart);

  assert.notEqual(rawSceneStart, -1, 'episode scene response normalization should exist');
  assert.notEqual(sceneStart, -1, 'normalized scene object should exist');
  assert.notEqual(sceneEnd, -1, 'normalized scene object should be closed');

  const initializer = scriptWriter.slice(sceneStart, sceneEnd);
  assert.match(initializer, /origin_location:\s*_compactLLMText\(rawScene\.origin_location \|\| rawScene\.location/);
  assert.match(initializer, /destination_location:\s*_compactLLMText\(rawScene\.destination_location \|\| rawScene\.location/);
  assert.doesNotMatch(initializer, /\bscene\.location\b/);
});