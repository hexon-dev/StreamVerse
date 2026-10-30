const test = require('node:test');
const assert = require('node:assert/strict');
const vanta = require('../src/vantaRendererClient');

test('normalizeBaseUrl removes supplied health endpoint and trailing slash', () => {
  assert.equal(vanta.normalizeBaseUrl('https://example.replit.app/api/vanta/v1/health/'), 'https://example.replit.app/api/vanta/v1');
});

test('selectWorkflow prefers image character workflows for character purpose', () => {
  const chosen = vanta.selectWorkflow([
    { id: 'scene_render', type: 'image', name: 'Scene Render', capabilities: ['scene'] },
    { id: 'character_master', type: 'image', name: 'VANTA Character Master', capabilities: ['canonical_character_reference', 'identity_anchor'] },
  ], 'character', { referenceCount: 0, requiresPrompt: true });
  assert.equal(chosen.id, 'character_master');
});

test('selectWorkflow prefers video workflow for video purpose', () => {
  const chosen = vanta.selectWorkflow([
    { id: 'scene_render', type: 'image', name: 'Scene Render' },
    { id: 'shot_video', type: 'video', name: 'First Last Frame Video', capabilities: ['first_last_frame', 'temporal'] },
  ], 'video', { referenceCount: 2, requiresPrompt: true });
  assert.equal(chosen.id, 'shot_video');
});

test('schemaProperties reads the VANTA contract input schema', () => {
  assert.deepEqual(Object.keys(vanta.schemaProperties({ contract: { input: { properties: { prompt: { type: 'string' }, width: { type: 'integer' } } } } })), ['prompt', 'width']);
});

test('extractArtifactUrl finds VANTA nested output urls', () => {
  assert.equal(vanta.extractArtifactUrl({ result: { artifacts: [{ file: { url: 'https://example.com/out.mp4' } }] } }), 'https://example.com/out.mp4');
});

test('collectTransportHints recognizes discovery transport vocabulary', () => {
  const hints = vanta.collectTransportHints({ image_input_transport: ['url', 'data_url'] });
  assert.ok(hints.includes('url'));
  assert.ok(hints.includes('data_url'));
});

test('encodeImageForProperty uses a URL when the contract names a URL field', async () => {
  const url = await vanta.encodeImageForProperty({
    propertyName: 'reference_image_url',
    schema: { type: 'string', format: 'uri' },
    buffer: Buffer.from([1, 2, 3]),
    uploadedUrl: 'https://cdn.example.com/ref.jpg',
    discovery: {},
  });
  assert.equal(url, 'https://cdn.example.com/ref.jpg');
});

test('encodeImageForProperty uses base64 transport when discovery only exposes base64', async () => {
  const encoded = await vanta.encodeImageForProperty({
    propertyName: 'image',
    schema: { type: 'string' },
    buffer: Buffer.from('abc'),
    uploadedUrl: 'https://cdn.example.com/ref.jpg',
    discovery: { image_input_transport: ['base64'] },
  });
  assert.equal(encoded, Buffer.from('abc').toString('base64'));
});
