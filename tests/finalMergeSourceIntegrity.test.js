'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const compilerSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'compiler.js'), 'utf8');

test('final merge does not resolve supplied shot URLs through persisted scene_state', () => {
  assert.doesNotMatch(
    compilerSource,
    /const\s+resolvedClips\s*=\s*await\s+_resolveCompiledSceneSources\(clips\)/,
    'final merge must not replace validated inputs with persisted scene_state URLs'
  );
  assert.match(compilerSource, /const\s+sourceClips\s*=\s*_sourceClips\(clips\)/);
  assert.match(compilerSource, /\.\.\.sourceClips/);
});

test('the previous failing temporary Cloudinary URL cannot be reintroduced by the final merge resolver', () => {
  assert.doesNotMatch(compilerSource, /_resolveCompiledSceneSources\(clips\)/);
  assert.doesNotMatch(compilerSource, /SELECT scene_state FROM episodes/);
});
