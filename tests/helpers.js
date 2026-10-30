'use strict';
const { spawnSync } = require('child_process');
const fs = require('fs'); const os = require('os'); const path = require('path');

function bin() { try { return require('@ffmpeg-installer/ffmpeg').path; } catch { return 'ffmpeg'; } }
function tmp() { return fs.mkdtempSync(path.join(os.tmpdir(), 'svtest-')); }

/** Synthetic clip: moving test pattern + 440 Hz tone. */
function makeClip(file, { w = 720, h = 1280, secs = 6, audio = true, acodec = 'aac' } = {}) {
  const args = ['-y', '-loglevel', 'error', '-f', 'lavfi', '-i', `testsrc2=size=${w}x${h}:rate=24`];
  if (audio) args.push('-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=44100');
  args.push('-t', String(secs), '-c:v', 'libx264', '-pix_fmt', 'yuv420p');
  if (audio) args.push('-c:a', acodec, '-shortest');
  args.push(file);
  const r = spawnSync(bin(), args);
  if (r.status !== 0) throw new Error('makeClip failed: ' + r.stderr);
  return file;
}
function audioMd5(file) {
  const r = spawnSync(bin(), ['-loglevel', 'error', '-i', file, '-map', '0:a', '-c', 'copy', '-f', 'md5', '-']);
  return r.stdout.toString().trim();
}
module.exports = { makeClip, audioMd5, tmp, bin };
