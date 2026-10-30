'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const axios = require('axios');
const config = require('../src/config');
const compiler = require('../src/compiler');

const CURRENT_CLOUD = 'ujcseiwr';
const currentShotUrl = `https://res.cloudinary.com/${CURRENT_CLOUD}/video/upload/shot.mp4`;
const currentBumperUrl = `https://res.cloudinary.com/${CURRENT_CLOUD}/video/upload/brand/outro.mp4`;
const staleBumperUrl = 'https://res.cloudinary.com/rqwxr63b/video/upload/v1786366843/tmpyx79p8o1_svgusj.mp4';

function mockFFmpeg(t) {
  const oldConfig = {
    cloudinaryCloudName: config.cloudinaryCloudName,
    ffmpegServiceUrl: config.ffmpegServiceUrl,
    ffmpegApiKey: config.ffmpegApiKey,
  };
  const oldGet = axios.get;
  const oldPost = axios.post;
  const oldWarn = console.warn;
  let postedMerge = null;
  const warnings = [];

  config.cloudinaryCloudName = CURRENT_CLOUD;
  config.ffmpegServiceUrl = 'https://ffmpeg.test';
  config.ffmpegApiKey = 'test-key';
  axios.get = async () => ({ status: 200, data: { ok: true } });
  axios.post = async (_url, body) => {
    postedMerge = body;
    return { status: 200, data: { jobId: 'merge-test-job' } };
  };
  console.warn = (...args) => warnings.push(args.join(' '));

  t.after(() => {
    config.cloudinaryCloudName = oldConfig.cloudinaryCloudName;
    config.ffmpegServiceUrl = oldConfig.ffmpegServiceUrl;
    config.ffmpegApiKey = oldConfig.ffmpegApiKey;
    axios.get = oldGet;
    axios.post = oldPost;
    console.warn = oldWarn;
  });

  return {
    get postedMerge() { return postedMerge; },
    warnings,
  };
}

test('mergeScenes drops a foreign optional bumper but keeps current-cloud sources', async t => {
  const ffmpeg = mockFFmpeg(t);
  const jobId = await compiler.mergeScenes([currentShotUrl], {
    introBumperUrl: staleBumperUrl,
    outroBumperUrl: currentBumperUrl,
  });

  assert.equal(jobId, 'merge-test-job');
  assert.deepEqual(ffmpeg.postedMerge.clips, [currentShotUrl, currentBumperUrl]);
  assert.match(ffmpeg.warnings.join('\n'), /stale optional intro bumper.*rqwxr63b/);
});

test('mergeScenes still rejects a foreign required source clip', async t => {
  mockFFmpeg(t);

  await assert.rejects(
    compiler.mergeScenes([staleBumperUrl]),
    /received a Cloudinary URL from cloud 'rqwxr63b'/
  );
});