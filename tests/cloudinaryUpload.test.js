'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http'); const fs = require('fs'); const path = require('path'); const crypto = require('crypto');
const { tmp } = require('./helpers');

/** Minimal multipart parser: returns {fields, file(Buffer)} */
function parseMultipart(body, contentType) {
  const boundary = '--' + /boundary=([^;]+)/.exec(contentType)[1];
  const fields = {}; let file = null; let pos = body.indexOf(boundary);
  while (pos !== -1) {
    const next = body.indexOf(boundary, pos + boundary.length); if (next === -1) break;
    const part = body.subarray(pos + boundary.length + 2, next - 2);
    const hEnd = part.indexOf('\r\n\r\n'); const head = part.subarray(0, hEnd).toString(); const data = part.subarray(hEnd + 4);
    const name = /name="([^"]+)"/.exec(head)[1];
    if (name === 'file') file = Buffer.from(data); else fields[name] = data.toString();
    pos = next;
  }
  return { fields, file };
}

function startServer(handler) {
  const reqs = [];
  const srv = http.createServer((req, res) => {
    const chunks = []; req.on('data', c => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks); const parsed = parseMultipart(body, req.headers['content-type']);
      const rec = { headers: req.headers, ...parsed, url: req.url }; reqs.push(rec);
      handler(rec, reqs.length, res);
    });
  });
  return new Promise(r => srv.listen(0, '127.0.0.1', () => r({ srv, reqs, base: `http://127.0.0.1:${srv.address().port}` })));
}

function loadCloudinary(base, env = {}) {
  Object.assign(process.env, { CLOUDINARY_CLOUD_NAME: 'demo', CLOUDINARY_API_KEY: 'k', CLOUDINARY_API_SECRET: 'secret', CLOUDINARY_API_BASE: base, ...env });
  for (const k of Object.keys(require.cache)) if (/src[\\/](cloudinary|config|configCore)\.js$/.test(k)) delete require.cache[k];
  return require('../src/cloudinary');
}

test('single-request upload for small files; signature is valid', async () => {
  const d = tmp(); const f = path.join(d, 'a.mp4'); fs.writeFileSync(f, crypto.randomBytes(300000));
  const { srv, reqs, base } = await startServer((r, n, res) => res.end(JSON.stringify({ secure_url: 'https://cdn/x.mp4' })));
  const c = loadCloudinary(base);
  assert.equal(await c.uploadVideoFile(f, 'streamverse/ep0001'), 'https://cdn/x.mp4');
  srv.close();
  assert.equal(reqs.length, 1); assert.ok(!reqs[0].headers['content-range']);
  assert.ok(reqs[0].file.equals(fs.readFileSync(f)));
  const { fields } = reqs[0];
  const toSign = `overwrite=true&public_id=streamverse/ep0001&timestamp=${fields.timestamp}`;
  assert.equal(fields.signature, crypto.createHash('sha1').update(toSign + process.env.CLOUDINARY_API_SECRET).digest('hex'));
});

test('chunked upload: contiguous Content-Range, same upload id, bytes reassemble exactly, transient 503 retried', async () => {
  const d = tmp(); const f = path.join(d, 'big.mp4'); const data = crypto.randomBytes(12 * 1024 * 1024 + 123); fs.writeFileSync(f, data);
  let failedOnce = false;
  const { srv, reqs, base } = await startServer((r, n, res) => {
    if (n === 2 && !failedOnce) { failedOnce = true; res.statusCode = 503; return res.end('{}'); }
    const last = /-(\d+)\/(\d+)$/.exec(r.headers['content-range']); const done = Number(last[1]) + 1 === Number(last[2]);
    res.end(JSON.stringify(done ? { secure_url: 'https://cdn/big.mp4' } : { done: false }));
  });
  const c = loadCloudinary(base, { CLOUDINARY_SINGLE_UPLOAD_MAX_BYTES: String(1024 * 1024), CLOUDINARY_CHUNK_BYTES: String(5 * 1024 * 1024) });
  const t0 = Date.now(); const url = await c.uploadVideoFile(f, 'streamverse/ep0002'); srv.close();
  assert.equal(url, 'https://cdn/big.mp4');
  const ok = reqs.filter(r => r.file && r.headers['content-range']);
  const ids = new Set(ok.map(r => r.headers['x-unique-upload-id'])); assert.equal(ids.size, 1);
  const good = reqs.filter((r, i) => !(i === 1)); // drop the 503'd attempt
  let expectStart = 0; const parts = [];
  for (const r of good) {
    const [, s, e, tot] = /bytes (\d+)-(\d+)\/(\d+)/.exec(r.headers['content-range']).map(Number);
    assert.equal(s, expectStart); assert.equal(tot, data.length); assert.equal(r.file.length, e - s + 1);
    parts.push(r.file); expectStart = e + 1;
  }
  assert.equal(expectStart, data.length); assert.ok(Buffer.concat(parts).equals(data));
  assert.equal(good.length, 3); assert.ok(Date.now() - t0 >= 900, 'backoff applied');
});

test('empty file is refused before any request', async () => {
  const d = tmp(); const f = path.join(d, 'e.mp4'); fs.writeFileSync(f, '');
  const c = loadCloudinary('http://127.0.0.1:1');
  await assert.rejects(c.uploadVideoFile(f, 'x'), /empty file/);
});
