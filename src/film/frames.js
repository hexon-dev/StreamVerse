'use strict';
/**
 * Frame / media primitives on top of FFmpeg. These are the deterministic pieces of
 * the continuity handoff: verify a clip is decodable, measure its real duration,
 * extract the final USABLE frame (skipping a fade-to-black tail), and grab support
 * frames when motion context matters.
 */
const fs = require('fs');
const path = require('path');
const { run, ffmpegBin, probe } = require('../branding');

async function verifyDecodable(file) {
  if (!fs.existsSync(file) || fs.statSync(file).size < 100) throw new Error(`video missing or empty: ${file}`);
  // Full decode to the null muxer: any corruption makes ffmpeg exit non-zero.
  await run(ffmpegBin(), ['-nostdin', '-v', 'error', '-xerror', '-i', file, '-f', 'null', '-'], { timeoutMs: 5 * 60 * 1000 });
  const info = await probe(file);
  if (!(info.duration > 0)) throw new Error(`video has no duration: ${file}`);
  return info;
}

/** Tiny grey thumbnails of the last `tailSec` seconds: array of mean luma per frame. */
async function _tailLuma(file, tailSec) {
  // -vsync 0 (passthrough) in BOTH passes: without it ffmpeg's cfr logic can duplicate a frame in one pass
  // and not the other, so the frame index found here would not exist in the extraction pass.
  const buf = await run(ffmpegBin(), ['-nostdin', '-v', 'error', '-sseof', String(-tailSec), '-i', file, '-an', '-vsync', '0',
    '-vf', 'scale=8:8,format=gray', '-f', 'rawvideo', '-'], { binary: true, timeoutMs: 120000 });
  const n = Math.floor(buf.length / 64), out = [];
  for (let i = 0; i < n; i++) { let s = 0; for (let j = 0; j < 64; j++) s += buf[i * 64 + j]; out.push(s / 64); }
  return out;
}

/**
 * Final usable frame. "Usable" = not a fade-to-black/blank tail frame: if the very last frame is
 * near-black we step back to the last frame with real picture content. Returns metadata so callers
 * (and QC) can see whether a fallback was needed.
 */
async function extractEndFrame(video, outPng, { duration, tailSec = 1.5, minLuma = 4 } = {}) {
  fs.mkdirSync(path.dirname(outPng), { recursive: true });
  const tail = Math.min(tailSec, Math.max(0.3, (duration || tailSec)));
  const luma = await _tailLuma(video, tail);
  if (!luma.length) throw new Error(`could not decode tail of ${video}`);
  let idx = luma.length - 1;
  while (idx > 0 && luma[idx] < minLuma) idx--;
  const ok = () => fs.existsSync(outPng) && fs.statSync(outPng).size >= 100;
  fs.rmSync(outPng, { force: true });
  await run(ffmpegBin(), ['-nostdin', '-y', '-v', 'error', '-sseof', String(-tail), '-i', video, '-an', '-vsync', '0',
    '-vf', `select=eq(n\\,${idx})`, '-frames:v', '1', '-update', '1', outPng], { timeoutMs: 120000 });
  let method = 'select';
  if (!ok()) {
    // Safety net: keep overwriting one file with every tail frame; the last write is the final frame.
    method = 'last-frame-fallback';
    await run(ffmpegBin(), ['-nostdin', '-y', '-v', 'error', '-sseof', String(-tail), '-i', video, '-an', '-vsync', '0', '-update', '1', outPng], { timeoutMs: 120000 });
  }
  if (!ok()) throw new Error(`end-frame extraction produced nothing for ${video}`);
  return { path: outPng, frameIndexInTail: idx, framesInTail: luma.length, usedFallback: idx !== luma.length - 1, method, lumaMean: luma[idx] };
}

/** Frame `secBeforeEnd` seconds before the end (support frame for motion context). */
async function extractFrameBeforeEnd(video, outPng, secBeforeEnd, duration) {
  if (!(duration > secBeforeEnd + 0.1)) return null;                     // clip too short: skip, do not fabricate
  fs.mkdirSync(path.dirname(outPng), { recursive: true });
  await run(ffmpegBin(), ['-nostdin', '-y', '-v', 'error', '-ss', String(Math.max(0, duration - secBeforeEnd)), '-i', video, '-an', '-frames:v', '1', outPng], { timeoutMs: 60000 });
  return fs.existsSync(outPng) ? outPng : null;
}

async function extractFirstFrame(video, outPng) {
  fs.mkdirSync(path.dirname(outPng), { recursive: true });
  await run(ffmpegBin(), ['-nostdin', '-y', '-v', 'error', '-i', video, '-an', '-frames:v', '1', outPng], { timeoutMs: 60000 });
  return outPng;
}

/** Mean absolute grey difference (0-255) between two images, 32px thumbnails. Cheap similarity probe. */
async function imageDiff(a, b) {
  const grab = (f) => run(ffmpegBin(), ['-nostdin', '-v', 'error', '-i', f, '-vf', 'scale=32:32,format=gray', '-frames:v', '1', '-f', 'rawvideo', '-'], { binary: true });
  const [x, y] = await Promise.all([grab(a), grab(b)]);
  let s = 0; for (let i = 0; i < x.length; i++) s += Math.abs(x[i] - y[i]);
  return s / x.length;
}

module.exports = { verifyDecodable, extractEndFrame, extractFrameBeforeEnd, extractFirstFrame, imageDiff, probe };
