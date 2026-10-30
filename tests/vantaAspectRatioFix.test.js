'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { reduceAspectRatio, closestEnumAspect, buildInputs } = require('../src/vantaRendererClient');
const LIVE = require('./fixtures/vantaLiveContracts');
const DISCOVERY = require('./fixtures/vantaLiveDiscovery.json');

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');
const wf = (id) => LIVE.find(w => w.id === id);

test('reduceAspectRatio: reproduces the exact reported case -- 1024x1536 (this pipeline\'s real target) reduces to "2:3", not "9:16"', () => {
  const r = reduceAspectRatio(1024, 1536);
  assert.equal(r.ratio, '2:3');
  assert.ok(Math.abs(r.value - 2 / 3) < 1e-9);
});
test('reduceAspectRatio: reduces arbitrary dimensions via GCD, not just the special-cased 1024x1536 pair', () => {
  assert.equal(reduceAspectRatio(1000, 1500).ratio, '2:3');
  assert.equal(reduceAspectRatio(1920, 1080).ratio, '16:9');
  assert.equal(reduceAspectRatio(768, 1365).ratio, '256:455'); // odd dims: correctly reduced, not silently wrong
});
test('reduceAspectRatio: invalid/missing input returns null rather than throwing', () => {
  assert.equal(reduceAspectRatio(0, 100), null);
  assert.equal(reduceAspectRatio(null, null), null);
  assert.equal(reduceAspectRatio(undefined, 100), null);
});

test('closestEnumAspect: 2:3 (0.667) against the real video enum correctly picks "3:4" (0.75), not "9:16" (0.5625) -- the actual previously-hardcoded wrong value', () => {
  const enumValues = ['auto', '16:9', '9:16', '1:1', '4:3', '3:4', '21:9'];
  const picked = closestEnumAspect(enumValues, 2 / 3);
  assert.equal(picked, '3:4');
});
test('closestEnumAspect: an exact match in the enum is picked exactly, distance zero', () => {
  assert.equal(closestEnumAspect(['16:9', '9:16', '1:1'], 16 / 9), '16:9');
});
test('closestEnumAspect: "auto" and unparseable entries are skipped without throwing', () => {
  assert.equal(closestEnumAspect(['auto', '16:9'], 16 / 9), '16:9');
});

test('buildInputs: character_master (no aspect_ratio enum) gets exact "2:3" for a 1024x1536 request -- reproduces and confirms the fix for the reported live crash', async () => {
  const inputs = await buildInputs({ contract: wf('character_master'), discovery: DISCOVERY, purpose: 'character', prompt: 'p', seed: 1, referenceImages: [png], width: 1024, height: 1536 });
  assert.equal(inputs.aspect_ratio, '2:3');
});
test('buildInputs: scene_composer (no aspect_ratio enum) also gets exact "2:3", not the schema\'s own "16:9" default and not the old hardcoded "9:16"', async () => {
  const inputs = await buildInputs({ contract: wf('scene_composer'), discovery: DISCOVERY, purpose: 'scene', prompt: 'p', seed: 1, referenceImages: [png, png], width: 1024, height: 1536 });
  assert.equal(inputs.aspect_ratio, '2:3');
});
test('buildInputs: a video workflow (aspect_ratio IS enum-constrained) gets a legal enum value, never a bare "2:3" that would be rejected', async () => {
  const cloud = require('../src/cloudinary');
  const orig = cloud.uploadImageFromUrl;
  cloud.uploadImageFromUrl = async (_d, id) => `https://res.cloudinary.com/demo/image/upload/${id}.png`;
  try {
    const inputs = await buildInputs({ contract: wf('first_last_frame'), discovery: DISCOVERY, purpose: 'video', prompt: 'p', seed: 1, firstImageBuffer: png, lastImageBuffer: png, width: 1024, height: 1536 });
    const enumValues = wf('first_last_frame').contract.input.properties.aspect_ratio.enum;
    assert.ok(enumValues.includes(inputs.aspect_ratio), `expected an enum-legal value, got "${inputs.aspect_ratio}"`);
    assert.equal(inputs.aspect_ratio, '3:4');
  } finally { cloud.uploadImageFromUrl = orig; }
});
test('buildInputs: no width/height supplied -> the workflow schema\'s own declared default is used, untouched by the aspect_ratio fix', async () => {
  const inputs = await buildInputs({ contract: wf('character_master'), discovery: DISCOVERY, purpose: 'character', prompt: 'p', seed: 1, referenceImages: [png] });
  assert.equal(inputs.aspect_ratio, '3:4', "character_master's own schema default, unrelated to the fix");
});
