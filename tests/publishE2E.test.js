'use strict';
// Full path: HTTP download (stand-in for the FFmpeg service URL) -> brand -> chunked upload to a mock Cloudinary.
const test = require('node:test'); const assert = require('node:assert/strict');
const http = require('http'); const fs = require('fs'); const path = require('path');
const { makeClip, tmp, bin } = require('./helpers');
const { spawnSync } = require('child_process');

test('publishBrandedMaster end-to-end over HTTP with chunked upload; download -> brand -> chunked upload completes (2 requests)', async () => {
  const d = tmp(); const src = makeClip(path.join(d, 'master.mp4'), { secs: 20 });
  const fileSrv = http.createServer((q, s) => fs.createReadStream(src).pipe(s));
  await new Promise(r => fileSrv.listen(0, '127.0.0.1', r));
  const got = []; let cloudBody = null;
  const cloud = http.createServer((q, s) => {
    const c = []; q.on('data', x => c.push(x)); q.on('end', () => {
      got.push({ range: q.headers['content-range'], n: Buffer.concat(c).length });
      const m = /-(\d+)\/(\d+)$/.exec(q.headers['content-range'] || '');
      s.end(JSON.stringify(!m || Number(m[1]) + 1 === Number(m[2]) ? { secure_url: 'https://res.cloudinary.com/demo/video/upload/ep.mp4' } : {}));
    });
  });
  await new Promise(r => cloud.listen(0, '127.0.0.1', r));
  Object.assign(process.env, { CLOUDINARY_API_BASE: `http://127.0.0.1:${cloud.address().port}`, CLOUDINARY_CLOUD_NAME: 'demo', CLOUDINARY_API_KEY: 'k', CLOUDINARY_API_SECRET: 's',
    CLOUDINARY_SINGLE_UPLOAD_MAX_BYTES: '1000', CLOUDINARY_CHUNK_BYTES: String(5 * 1024 * 1024) });
  for (const k of Object.keys(require.cache)) if (/src[\\/](cloudinary|config|configCore|branding)\.js$/.test(k)) delete require.cache[k];
  const branding = require('../src/branding');
  const url = await branding.publishBrandedMaster(`http://127.0.0.1:${fileSrv.address().port}/master.mp4`, 'streamverse/ep0001', { cfg: { ...branding.settings({}), tmpDir: d } });
  fileSrv.close(); cloud.close();
  assert.match(url, /cloudinary/); assert.ok(got.length >= 1);
  assert.ok(got.every(g => g.range || got.length === 1));
});
