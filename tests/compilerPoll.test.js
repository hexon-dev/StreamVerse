'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const axios = require('axios');
const config = require('../src/config');
const compiler = require('../src/compiler');

function httpError(status, data, extra = {}) {
  const error = new Error(`Request failed with status code ${status}`);
  error.response = { status, data };
  error.config = { headers: { 'x-api-key': 'must-not-appear-in-errors' }, ...extra };
  return error;
}

test('pollFFmpegJob retries transient server errors and reports persistent errors safely', async () => {
  const originalGet = axios.get;
  const originalInterval = config.ffmpegPollIntervalMs;
  const originalMaxAttempts = config.ffmpegMaxPollAttempts;
  const originalApiKey = config.ffmpegApiKey;

  config.ffmpegPollIntervalMs = 0;
  config.ffmpegMaxPollAttempts = 10;
  config.ffmpegApiKey = 'test-ffmpeg-key'; // _ffmpegHeaders() throws before any request if this is empty -- without it, every case below fails on "authentication key is missing" instead of exercising retry behavior

  try {
    let calls = 0;
    axios.get = async () => {
      calls += 1;
      if (calls === 1) throw httpError(500, { detail: 'temporary status failure' });
      return { data: { status: 'complete', url: 'https://example.test/final.mp4' } };
    };

    assert.equal(
      await compiler.pollFFmpegJob('transient-job'),
      'https://example.test/final.mp4'
    );
    assert.equal(calls, 2, 'one transient 500 should be retried');

    calls = 0;
    axios.get = async () => {
      calls += 1;
      throw httpError(500, { detail: 'persistent status failure' });
    };
    await assert.rejects(
      compiler.pollFFmpegJob('persistent-job'),
      error => {
        assert.match(error.message, /HTTP 500:.*persistent status failure/);
        assert.match(error.message, /3 consecutive times/);
        assert.doesNotMatch(error.message, /must-not-appear-in-errors/);
        return true;
      }
    );
    assert.equal(calls, 3, 'persistent server failures must stop after three consecutive polls');

    calls = 0;
    axios.get = async () => {
      calls += 1;
      throw httpError(404, { detail: 'job not found' });
    };
    await assert.rejects(
      compiler.pollFFmpegJob('missing-job'),
      /HTTP 404.*job not found/
    );
    assert.equal(calls, 1, 'client errors should fail fast instead of being retried');
  } finally {
    axios.get = originalGet;
    config.ffmpegPollIntervalMs = originalInterval;
    config.ffmpegMaxPollAttempts = originalMaxAttempts;
    config.ffmpegApiKey = originalApiKey;
  }
});