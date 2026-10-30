'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');

function bootApp(dbMock) {
  Object.assign(process.env, { SESSION_SECRET: 'test-secret-123' });
  for (const k of Object.keys(require.cache)) if (/proj[\\/](index\.js|src)/.test(k) || /theirs[\\/](index\.js|src)/.test(k)) delete require.cache[k];
  const db = require('../src/db');
  Object.assign(db, dbMock);
  const { app } = require('../index.js');
  return http.createServer(app);
}
function get(server, path) {
  return new Promise((resolve, reject) => {
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      require('http').get(`http://127.0.0.1:${port}${path}`, res => {
        let body = ''; res.on('data', c => body += c);
        res.on('end', () => { server.close(); resolve(JSON.parse(body)); });
      }).on('error', err => { server.close(); reject(err); });
    });
  });
}

test('/api/drafts: no query that includes scene_state also has an ORDER BY (the exact pattern that caused "Out of sort memory")', async () => {
  const calls = [];
  const server = bootApp({
    query: async (sql, params) => {
      calls.push(sql);
      if (/FROM episodes e WHERE e\.status = 'draft' ORDER BY/.test(sql)) return [{ id: 'ep-2' }, { id: 'ep-1' }];
      if (/scene_state/.test(sql)) {
        assert.doesNotMatch(sql, /ORDER BY/, 'a query selecting scene_state must never also ORDER BY');
        // returned deliberately OUT of order, to prove the JS re-sort (not SQL) establishes the final order
        return [
          { id: 'ep-1', episode_number: 1, season_number: 1, paused_reason: null, created_at: new Date('2026-01-01'), scene_state: '{}', scene_count: 2, shot_count: 4, show_title: 'Show', genre: 'drama' },
          { id: 'ep-2', episode_number: 2, season_number: 1, paused_reason: 'x', created_at: new Date('2026-01-02'), scene_state: '{"1":true}', scene_count: 2, shot_count: 4, show_title: 'Show', genre: 'drama' },
        ];
      }
      if (/FROM shots WHERE episode_id IN/.test(sql)) return [];
      throw new Error('unexpected query: ' + sql);
    },
  });
  const body = await get(server, '/api/drafts');
  assert.equal(body.ok, true);
  assert.deepEqual(body.drafts.map(d => d.id), ['ep-2', 'ep-1'], 'output order must match the narrow id-query order, not the hydration query\'s row order');
  assert.match(calls.find(c => /FROM episodes e WHERE e\.status = 'draft' ORDER BY/.test(c)), /LIMIT 100/, 'the previously-missing LIMIT must now be present');
});

test('/api/drafts: no draft episodes returns an empty list without attempting a hydration query at all', async () => {
  let hydrationCalled = false;
  const server = bootApp({ query: async (sql) => { if (/scene_state/.test(sql)) hydrationCalled = true; return []; } });
  const body = await get(server, '/api/drafts');
  assert.deepEqual(body.drafts, []);
  assert.equal(hydrationCalled, false);
});

test('/api/drafts/shots: no query selects last_prompt with an ORDER BY, and final shot ordering matches (scene_number, shot_index) even when the DB returns rows scrambled', async () => {
  const calls = [];
  const server = bootApp({
    queryOne: async (sql, params) => {
      calls.push(sql);
      if (/FROM episodes e WHERE e\.status = 'draft' ORDER BY/.test(sql)) { assert.doesNotMatch(sql, /scene_state/); return { id: 'ep-1' }; }
      if (/WHERE e\.id = \?/.test(sql)) return { id: 'ep-1', episode_number: 1, season_number: 1, scene_state: '{"2":"url-a"}', show_title: 'Show', genre: 'drama' };
      throw new Error('unexpected queryOne: ' + sql);
    },
    query: async (sql, params) => {
      calls.push(sql);
      assert.doesNotMatch(sql, /ORDER BY/, 'the shots query must never sort last_prompt in SQL');
      return [
        { scene_number: 2, shot_index: 2, status: 'done', clip_url: 'c22', clip_duration: 5, image_url: null, last_error: null, last_prompt: 'p', failure_reason: null, enabled: 1, trim_start: null, trim_end: null, editorial_url: null, edit_revision: 0 },
        { scene_number: 1, shot_index: 2, status: 'done', clip_url: 'c12', clip_duration: 5, image_url: null, last_error: null, last_prompt: 'p', failure_reason: null, enabled: 1, trim_start: null, trim_end: null, editorial_url: null, edit_revision: 0 },
        { scene_number: 1, shot_index: 1, status: 'done', clip_url: 'c11', clip_duration: 5, image_url: null, last_error: null, last_prompt: 'p', failure_reason: null, enabled: 1, trim_start: null, trim_end: null, editorial_url: null, edit_revision: 0 },
      ];
    },
  });
  const body = await get(server, '/api/drafts/shots');
  assert.equal(body.ok, true);
  assert.deepEqual(body.scenes.map(s => s.sceneNumber), [1, 2]);
  assert.deepEqual(body.scenes[0].shots.map(s => s.shotIndex), [1, 2], 'shots within a scene must stay in shot_index order despite the DB returning them scrambled');
  assert.equal(body.scenes[1].compiledUrl, 'url-a');
});

test('/api/drafts/shots: no draft at all returns an empty result without a second query', async () => {
  let secondCalled = false;
  const server = bootApp({ queryOne: async (sql) => { if (secondCalled) throw new Error('should not reach a second queryOne'); secondCalled = true; return null; } });
  const body = await get(server, '/api/drafts/shots');
  assert.deepEqual(body, { ok: true, scenes: [], episode: null });
});
