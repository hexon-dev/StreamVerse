'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');

process.env.CLOUDINARY_CLOUD_NAME = 'currentcloud';
process.env.CLOUDINARY_API_KEY = 'k';
process.env.CLOUDINARY_API_SECRET = 'secret';
for (const k of Object.keys(require.cache)) {
  if (/src[\\/](cloudinary|config|configCore)\.js$/.test(k)) delete require.cache[k];
}
const cloudinary = require('../src/cloudinary');

const publicId = 'streamverse/shots/storyline-1/ep0007/scene_02/shot_03';

test('accepts the exact current-cloud stable shot URL', () => {
  const url = `https://res.cloudinary.com/currentcloud/video/upload/v1787000000/${publicId}.mp4`;
  assert.equal(cloudinary.isCurrentCloudinaryVideoUrl(url), true);
  assert.equal(cloudinary.isAuthoritativeShotVideoUrl(url, publicId), true);
});

test('rejects a foreign Cloudinary cloud even when the public id looks plausible', () => {
  const url = `https://res.cloudinary.com/rqwxr63b/video/upload/v1786366843/${publicId}.mp4`;
  assert.equal(cloudinary.isCurrentCloudinaryVideoUrl(url), false);
  assert.equal(cloudinary.isAuthoritativeShotVideoUrl(url, publicId), false);
});

test('rejects temporary renderer Cloudinary assets', () => {
  const url = 'https://res.cloudinary.com/rqwxr63b/video/upload/v1786366843/tmpyx79p8o1_svgusj.mp4';
  assert.equal(cloudinary.isAuthoritativeShotVideoUrl(url, publicId), false);
});

test('builds delivery URLs from the configured env cloud', () => {
  assert.equal(
    cloudinary.cloudinaryVideoDeliveryUrl(publicId),
    `https://res.cloudinary.com/currentcloud/video/upload/${publicId}.mp4`
  );
});
