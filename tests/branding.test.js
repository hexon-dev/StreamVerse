'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs'); const path = require('path');
const branding = require('../src/branding');
const { makeClip, audioMd5, tmp } = require('./helpers');

const cfg = (over = {}) => ({ ...branding.settings({}), ...over });

test('layout: portrait 720x1280 top-left is in-bounds with even logo size', () => {
  const l = branding.computeLayout({ width: 720, height: 1280 }, cfg());
  assert.equal(l.logoW % 2, 0); assert.equal(l.logoH % 2, 0);
  assert.ok(l.x >= 0 && l.y >= 0 && l.x + l.logoW <= 720 && l.y + l.logoH <= 1280);
  assert.ok(l.logoW / 720 > 0.38 && l.logoW / 720 < 0.42);   // portrait default ~34%
  assert.ok(l.x < 720 / 2 && l.y < 1280 / 2);              // top-left
});
test('layout: landscape logo is proportionally smaller; all four corners stay in bounds', () => {
  for (const position of ['top-left', 'top-right', 'bottom-left', 'bottom-right']) {
    for (const [width, height] of [[1920, 1080], [1080, 1920], [720, 1280], [1280, 720]]) {
      const l = branding.computeLayout({ width, height }, cfg({ position }));
      assert.ok(l.x >= 0 && l.y >= 0 && l.x + l.logoW <= width && l.y + l.logoH <= height, `${position} ${width}x${height}`);
    }
  }
  assert.ok(branding.computeLayout({ width: 1920, height: 1080 }, cfg()).logoW / 1920 < 0.2);
});
test('settings: defaults are branded + required; env parsing', () => {
  const d = branding.settings({});
  assert.equal(d.enabled, true); assert.equal(d.required, true); assert.equal(d.position, 'top-left');
  const o = branding.settings({ BRAND_ENABLED: 'false', BRAND_POSITION: 'nonsense', BRAND_OPACITY: '5' });
  assert.equal(o.enabled, false); assert.equal(o.position, 'top-left'); assert.equal(o.opacity, 1);
});

test('brandMasterFile: real encode — logo present, audio bit-identical, geometry/duration kept', async () => {
  const d = tmp(); const inp = makeClip(path.join(d, 'in.mp4')); const out = path.join(d, 'out.mp4');
  const rep = await branding.brandMasterFile({ inputPath: inp, outputPath: out, cfg: cfg() });
  assert.equal(rep.applied, true);
  assert.equal(rep.audioMode, 'stream-copy');
  assert.equal(audioMd5(inp), audioMd5(out), 'audio must be untouched');
  assert.equal(rep.output.width, 720); assert.equal(rep.output.height, 1280);
  assert.ok(Math.abs(rep.output.duration - rep.input.duration) < 0.3);
  assert.ok(rep.logoDiff > 3, 'logo pixels visible: ' + rep.logoDiff);
  fs.writeFileSync(path.join(d, 'ok'), '1'); process.env.SV_TEST_OUT = out;
});
test('brandMasterFile: video with no audio and landscape frame', async () => {
  const d = tmp(); const inp = makeClip(path.join(d, 'in.mp4'), { w: 1280, h: 720, audio: false, secs: 3 });
  const rep = await branding.brandMasterFile({ inputPath: inp, outputPath: path.join(d, 'o.mp4'), cfg: cfg() });
  assert.equal(rep.audioMode, 'none'); assert.equal(rep.output.hasAudio, false);
});
test('brandMasterFile: non-mp4-copyable audio is re-encoded to AAC, not dropped', async () => {
  const d = tmp(); const inp = makeClip(path.join(d, 'in.mkv'), { secs: 3, acodec: 'pcm_s16le' });
  const rep = await branding.brandMasterFile({ inputPath: inp, outputPath: path.join(d, 'o.mp4'), cfg: cfg() });
  assert.equal(rep.audioMode, 'aac-reencode'); assert.ok(rep.output.hasAudio); assert.equal(rep.output.audioCodec, 'aac');
});
test('verifyBranded: catches an UNBRANDED file (QC actually evaluates output)', async () => {
  const d = tmp(); const inp = makeClip(path.join(d, 'in.mp4'), { secs: 3 });
  const info = await branding.probe(inp); const layout = branding.computeLayout(info, cfg());
  await assert.rejects(branding.verifyBranded({ inputPath: inp, outputPath: inp, inInfo: info, layout }), /logo not visible/);
});
test('brandMasterFile: missing logo asset fails loudly', async () => {
  const d = tmp(); const inp = makeClip(path.join(d, 'in.mp4'), { secs: 2 });
  await assert.rejects(branding.brandMasterFile({ inputPath: inp, outputPath: path.join(d, 'o.mp4'), cfg: cfg({ logoPath: '/nope.png' }) }), /logo asset not found/);
});

// ── publishBrandedMaster: policy behaviour with a fake uploader ──────────────
function fakeUploader() {
  const calls = { file: [], url: [] };
  return {
    calls,
    uploadVideoFile: async (f, id) => { calls.file.push({ f, id, existed: fs.existsSync(f), size: fs.statSync(f).size }); return 'https://cdn/branded.mp4'; },
    uploadVideoFromUrl: async (u, id) => { calls.url.push({ u, id }); return 'https://cdn/raw.mp4'; },
  };
}
test('publish: success uploads the BRANDED file, never the raw URL, and cleans temp dir', async () => {
  const d = tmp(); const inp = makeClip(path.join(d, 'src.mp4'), { secs: 3 }); const up = fakeUploader();
  const url = await branding.publishBrandedMaster(inp, 'ep/1', { uploader: up, cfg: cfg({ tmpDir: d }) });
  assert.equal(url, 'https://cdn/branded.mp4'); assert.equal(up.calls.url.length, 0);
  assert.equal(up.calls.file.length, 1); assert.ok(up.calls.file[0].existed && up.calls.file[0].size > 1000);
  await new Promise(r => setTimeout(r, 100));
  assert.deepEqual(fs.readdirSync(d).filter(n => n.startsWith('sv-brand-')), []);
});
test('publish: BRAND_REQUIRED=true + failure => throws, nothing unbranded uploaded', async () => {
  const d = tmp(); const bad = path.join(d, 'bad.mp4'); fs.writeFileSync(bad, 'not a video'); const up = fakeUploader();
  await assert.rejects(branding.publishBrandedMaster(bad, 'ep/2', { uploader: up, cfg: cfg({ tmpDir: d }) }), /Refusing to publish an unbranded master/);
  assert.equal(up.calls.url.length + up.calls.file.length, 0);
});
test('publish: BRAND_REQUIRED=false falls back to raw upload; BRAND_ENABLED=false skips', async () => {
  const d = tmp(); const bad = path.join(d, 'bad.mp4'); fs.writeFileSync(bad, 'not a video');
  let up = fakeUploader();
  assert.equal(await branding.publishBrandedMaster(bad, 'x', { uploader: up, cfg: cfg({ tmpDir: d, required: false }) }), 'https://cdn/raw.mp4');
  up = fakeUploader();
  await branding.publishBrandedMaster(bad, 'x', { uploader: up, cfg: cfg({ enabled: false }) });
  assert.equal(up.calls.url.length, 1);
});
test('selfCheck passes with bundled binaries + logo', async () => {
  const r = await branding.selfCheck(cfg()); assert.equal(r.ok, true);
});
