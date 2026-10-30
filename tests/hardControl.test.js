'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const hc = require('../src/hardControlLayers');

test('face-lock pseudo-embedding is gone: no shot can be rejected by it', () => {
  const reg = hc.buildFaceLockRegistry([{ name: 'KAI', visual_anchor: 'black hair, scar' }, { name: 'NOVA' }]);
  assert.equal(reg.size, 2); assert.equal(reg.get('kai').anchor, 'black hair, scar');
  for (let i = 0; i < 500; i++) {
    const r = hc.validateFaceLock({ characters_in_shot: ['KAI'], image_prompt: 'take ' + i, _shot_seed: i }, reg);
    assert.equal(r.passed, true); assert.equal(r.directive, '');
  }
  assert.equal(hc._cosineSimilarity, undefined); assert.equal(hc._generateFaceEmbedding, undefined);
});
test('no render pass enables the face-lock check any more', () => {
  for (const p of ['draft', 'refine', 'final', 'bogus']) assert.equal(hc.getPassValidationConfig(p).checkFaceLock, false);
});
test('applyHardControlLayers still attaches pose/scene-graph metadata', () => {
  const script = { scenes: [{ scene_number: 1, shots: [{ shot_index: 1, characters_in_shot: ['KAI'] }] }] };
  const out = hc.applyHardControlLayers(script, [{ name: 'KAI' }]);
  assert.equal(out.script.scenes[0].shots[0]._render_pass, 'draft');
  assert.equal(out.script.scenes[0].shots[0]._hard_control.faceLock[0].hasReference, true);
});
