'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');

/** Fresh require with the given env vars, so module-load-time config constants pick up test values. */
function freshClient(env) {
  Object.assign(process.env, {
    RENDERER_BASE_URL: '', RENDERER_API_KEY: 'test-key',
    RENDERER_HEALTH_TTL_MS: '200', RENDERER_HEALTH_WAIT_TIMEOUT_MS: '1500',
    RENDERER_HEALTH_POLL_INTERVAL_MS: '100', RENDERER_HEALTH_PROBE_TIMEOUT_MS: '500',
    ...env,
  });
  delete require.cache[require.resolve('../src/vantaRendererClient')];
  return require('../src/vantaRendererClient');
}

/** A mock renderer: request log for ordering assertions, and a scriptable /health that can simulate a cold start. */
function startMockRenderer({ healthFailuresBeforeOk = 0, alwaysUnhealthy = false } = {}) {
  const log = [];
  let healthCalls = 0;
  const srv = http.createServer((req, res) => {
    log.push(req.url);
    if (req.url === '/health') {
      healthCalls += 1;
      if (alwaysUnhealthy || healthCalls <= healthFailuresBeforeOk) {
        res.statusCode = 404; return res.end('cold');
      }
      res.setHeader('content-type', 'application/json');
      return res.end(JSON.stringify({ service: 'VANTA', status: 'ok' }));
    }
    if (req.url === '/discovery') { res.setHeader('content-type', 'application/json'); return res.end(JSON.stringify({ input_type_catalog: {} })); }
    if (req.url === '/workflows') { res.setHeader('content-type', 'application/json'); return res.end(JSON.stringify({ workflows: [{ id: 'wf1', type: 'video' }] })); }
    res.statusCode = 404; res.end('not found');
  });
  return new Promise(resolve => srv.listen(0, '127.0.0.1', () => resolve({ srv, log, base: `http://127.0.0.1:${srv.address().port}`, healthCallCount: () => healthCalls })));
}

test('ensureRendererAwake: retries through cold-start 404s and succeeds once the instance wakes up', async () => {
  const { srv, base, healthCallCount } = await startMockRenderer({ healthFailuresBeforeOk: 3 });
  try {
    const client = freshClient({ RENDERER_BASE_URL: base });
    await client.ensureRendererAwake();
    assert.equal(healthCallCount(), 4, 'expected 3 failed attempts then 1 success');
  } finally { srv.close(); }
});

test('ensureRendererAwake: gives up with a clear error after exhausting the wait budget on a never-waking instance', async () => {
  const { srv, base } = await startMockRenderer({ alwaysUnhealthy: true });
  try {
    const client = freshClient({ RENDERER_BASE_URL: base, RENDERER_HEALTH_WAIT_TIMEOUT_MS: '400', RENDERER_HEALTH_POLL_INTERVAL_MS: '100' });
    await assert.rejects(client.ensureRendererAwake(), /did not become healthy within 400ms/);
  } finally { srv.close(); }
});

test('ensureRendererAwake: caches a confirmed-healthy result -- a second call within the TTL does not hit /health again', async () => {
  const { srv, base, healthCallCount } = await startMockRenderer({ healthFailuresBeforeOk: 0 });
  try {
    const client = freshClient({ RENDERER_BASE_URL: base, RENDERER_HEALTH_TTL_MS: '5000' });
    await client.ensureRendererAwake();
    await client.ensureRendererAwake();
    assert.equal(healthCallCount(), 1, 'the second call should be served from the TTL cache, not hit the network again');
  } finally { srv.close(); }
});

test('ensureRendererAwake: force:true bypasses the TTL cache', async () => {
  const { srv, base, healthCallCount } = await startMockRenderer({ healthFailuresBeforeOk: 0 });
  try {
    const client = freshClient({ RENDERER_BASE_URL: base, RENDERER_HEALTH_TTL_MS: '5000' });
    await client.ensureRendererAwake();
    await client.ensureRendererAwake({ force: true });
    assert.equal(healthCallCount(), 2);
  } finally { srv.close(); }
});

test('getDiscovery / listWorkflows: /health is called FIRST, before any discovery/workflow request', async () => {
  const { srv, base, log } = await startMockRenderer({ healthFailuresBeforeOk: 0 });
  try {
    const client = freshClient({ RENDERER_BASE_URL: base });
    await client.getDiscovery();
    await client.listWorkflows();
    assert.equal(log[0], '/health', 'the very first request must be the health check, not /discovery');
    assert.equal(log[1], '/discovery');
    // second call's health check should be cache-served (within TTL), so /workflows should be the very next network hit
    assert.equal(log[2], '/workflows');
  } finally { srv.close(); }
});

test('getDiscovery: cold instance (404s a few times) still succeeds once awake, with discovery correctly following the wake sequence', async () => {
  const { srv, base, log } = await startMockRenderer({ healthFailuresBeforeOk: 2 });
  try {
    const client = freshClient({ RENDERER_BASE_URL: base });
    const discovery = await client.getDiscovery();
    assert.deepEqual(discovery, { input_type_catalog: {} });
    assert.equal(log.filter(u => u === '/health').length, 3, 'two failed health checks then one success');
    assert.equal(log[log.length - 1], '/discovery', 'discovery must only be requested after health confirms awake');
  } finally { srv.close(); }
});

test('listWorkflows: a cache hit needs no health check at all (never touches the network)', async () => {
  const { srv, base, log } = await startMockRenderer();
  try {
    const client = freshClient({ RENDERER_BASE_URL: base, RENDERER_DISCOVERY_TTL_MS: '5000' });
    await client.listWorkflows();
    const countAfterFirst = log.length;
    await client.listWorkflows();
    assert.equal(log.length, countAfterFirst, 'a served-from-cache workflow list must not touch the network, including /health');
  } finally { srv.close(); }
});

test('ensureRendererAwake: refuses to run at all if RENDERER_BASE_URL is not configured', async () => {
  const client = freshClient({ RENDERER_BASE_URL: '' });
  await assert.rejects(client.ensureRendererAwake(), /RENDERER_BASE_URL is not configured/);
});
