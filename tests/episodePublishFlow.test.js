'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const auth = require('../src/auth');

const dashboard = fs.readFileSync(path.join(__dirname, '../views/dashboard.html'), 'utf8');
const server = fs.readFileSync(path.join(__dirname, '../index.js'), 'utf8');

test('Episodes list and editor buttons use the shared admin-authenticated publish flow', () => {
  assert.match(dashboard, /data-publish-episode="\$\{esc\(ep\.id\)\}"/);
  assert.match(dashboard, /id="episodePublishBtn"/);
  assert.match(dashboard, /episodePublishBtn\?\.addEventListener\('click'/);
  assert.match(dashboard, /episodesBody'\)\?\.addEventListener\('click'/);
  assert.match(dashboard, /function publishEpisode\(episodeId\)\s*\{\s*beginEpisodePublish/);
  assert.match(dashboard, /async function publishEditedEpisode\(\)[\s\S]*?beginEpisodePublish/);
  assert.match(dashboard, /function beginEpisodePublish\([\s\S]*?requireAdminAccess\(async[\s\S]*?adminFetch\([\s\S]*?\/publish/);
  assert.match(dashboard, /window\.publishEpisode = publishEpisode/);
  assert.match(dashboard, /window\.publishEditedEpisode = publishEditedEpisode/);
});

test('episode publish API requires an admin token', () => {
  assert.match(
    server,
    /app\.post\('\/api\/episodes\/:id\/publish',\s*auth\.requireAdmin,\s*async/
  );

  const response = {
    statusCode: null,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
  };
  let continued = false;
  auth.requireAdmin({ headers: {} }, response, () => { continued = true; });
  assert.equal(response.statusCode, 401);
  assert.equal(response.body.ok, false);
  assert.equal(continued, false);

  const adminResponse = {
    statusCode: null,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
  };
  const token = auth.createAdminSessionToken();
  const request = { headers: { authorization: `Bearer ${token}` } };
  auth.requireAdmin(request, adminResponse, () => { continued = true; });
  assert.equal(continued, true);
  assert.equal(request.admin.role, 'admin');
});