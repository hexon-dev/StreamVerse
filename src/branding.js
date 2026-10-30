'use strict';
/**
 * StreamVerse Studio — final-master branding
 *
 * Burns the StreamVerse Studio logo + name into every FINAL generated movie.
 *
 *   FFmpeg service /merge  ->  finalVideoUrl
 *        -> download -> ffmpeg overlay (video re-encoded, audio stream-copied)
 *        -> media QC (dimensions, duration, audio, logo pixels actually present)
 *        -> Cloudinary upload (chunked for large files)
 *
 * Why here and not in the FFmpeg microservice: that service lives outside this
 * repository and its /merge contract is {clips, transition}. Branding in the
 * Node process means it works with the service exactly as deployed.
 *
 * Only the final master is branded. Per-scene compiled clips and shot clips are
 * deliberately left clean so re-composition never double-brands.
 *
 * Environment (all optional):
 *   BRAND_ENABLED        default true   set "false" to skip branding entirely
 *   BRAND_REQUIRED       default true   if branding fails the episode is NOT
 *                                       published unbranded; the error propagates
 *                                       (same handling as an FFmpeg merge failure)
 *   BRAND_POSITION       top-left | top-right | bottom-left | bottom-right
 *                        default top-left (clear of TikTok's right/bottom UI)
 *   BRAND_WIDTH_PCT      logo width as fraction of frame width
 *                        default 0.40 (portrait) / 0.19 (landscape)
 *   BRAND_MARGIN_PCT     default 0.04 of frame width
 *   BRAND_OPACITY        default 0.92
 *   BRAND_LOGO_PATH      default logo/streamverse_lockup.png
 *   BRAND_CRF            default 17 (visually lossless-ish x264)
 *   BRAND_PRESET         default veryfast
 *   BRAND_TIMEOUT_MS     default 7200000 (2h)
 *   BRAND_TMP_DIR        default os.tmpdir()
 *   FFMPEG_BIN / FFPROBE_BIN   override binaries; otherwise the bundled
 *                        @ffmpeg-installer / @ffprobe-installer, then PATH
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { pipeline: streamPipeline } = require('stream/promises');

const DEFAULT_LOGO = path.join(__dirname, '..', 'logo', 'streamverse_lockup.png');
const POSITIONS = new Set(['top-left', 'top-right', 'bottom-left', 'bottom-right']);

// ─────────────────────────────────────────────────────────────────────────────
// Settings
// ─────────────────────────────────────────────────────────────────────────────

function _bool(v, dflt) {
  if (v == null || v === '') return dflt;
  return !/^(0|false|no|off)$/i.test(String(v).trim());
}
function _num(v, dflt) {
  const n = Number(v);
  return Number.isFinite(n) ? n : dflt;
}

function settings(env = process.env) {
  const position = String(env.BRAND_POSITION || 'top-left').toLowerCase();
  return {
    enabled:   _bool(env.BRAND_ENABLED, true),
    required:  _bool(env.BRAND_REQUIRED, true),
    position:  POSITIONS.has(position) ? position : 'top-left',
    widthPct:  env.BRAND_WIDTH_PCT ? _num(env.BRAND_WIDTH_PCT, null) : null,
    marginPct: _num(env.BRAND_MARGIN_PCT, 0.04),
    opacity:   Math.min(1, Math.max(0.1, _num(env.BRAND_OPACITY, 0.92))),
    logoPath:  env.BRAND_LOGO_PATH || DEFAULT_LOGO,
    crf:       Math.min(30, Math.max(10, Math.round(_num(env.BRAND_CRF, 17)))),
    preset:    env.BRAND_PRESET || 'veryfast',
    timeoutMs: _num(env.BRAND_TIMEOUT_MS, 2 * 60 * 60 * 1000),
    tmpDir:    env.BRAND_TMP_DIR || os.tmpdir(),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Binaries
// ─────────────────────────────────────────────────────────────────────────────

function _resolveBin(envKey, pkgName, fallback) {
  if (process.env[envKey]) return process.env[envKey];
  try {
    const p = require(pkgName).path;
    if (p && fs.existsSync(p)) return p;
  } catch { /* package not installed — fall through to PATH */ }
  return fallback;
}
const ffmpegBin  = () => _resolveBin('FFMPEG_BIN',  '@ffmpeg-installer/ffmpeg',   'ffmpeg');
const ffprobeBin = () => _resolveBin('FFPROBE_BIN', '@ffprobe-installer/ffprobe', 'ffprobe');

/** Run a binary, collect stdout, keep the tail of stderr for diagnostics. */
function _run(bin, args, { timeoutMs = 60000, binary = false } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    const out = [];
    let errTail = '';
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, timeoutMs);
    child.stdout.on('data', d => out.push(d));
    child.stderr.on('data', d => { errTail = (errTail + d.toString()).slice(-4000); });
    child.on('error', err => { clearTimeout(timer); reject(new Error(`[Branding] cannot run ${bin}: ${err.message}`)); });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      if (timedOut) return reject(new Error(`[Branding] ${path.basename(bin)} timed out after ${timeoutMs}ms`));
      if (code !== 0) return reject(new Error(`[Branding] ${path.basename(bin)} exited code=${code} signal=${signal} args=${JSON.stringify(args)}: ${errTail.trim().slice(-1200)}`));
      const buf = Buffer.concat(out);
      resolve(binary ? buf : buf.toString('utf8'));
    });
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Probe
// ─────────────────────────────────────────────────────────────────────────────

function _fps(r) { const [a, b] = String(r || '0/1').split('/').map(Number); return b ? Math.round((a / b) * 1000) / 1000 : 0; }

async function _probeViaFfprobe(file) {
  const json = await _run(ffprobeBin(), [
    '-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', file,
  ]);
  const info = JSON.parse(json);
  const v = (info.streams || []).find(s => s.codec_type === 'video');
  const a = (info.streams || []).find(s => s.codec_type === 'audio');
  if (!v) throw new Error(`[Branding] ${file} has no video stream`);
  const duration = Number(info.format?.duration) || Number(v.duration) || 0;
  return {
    width: Number(v.width), height: Number(v.height), duration,
    videoCodec: v.codec_name, audioCodec: a ? a.codec_name : null, hasAudio: Boolean(a),
    audioSamples: a ? Number(a.sample_rate) : null, channels: a ? Number(a.channels) : null,
    fps: _fps(v.avg_frame_rate || v.r_frame_rate), pixFmt: v.pix_fmt, profile: v.profile,
    size: Number(info.format?.size) || 0, via: 'ffprobe',
  };
}

/**
 * Fallback prober: parses `ffmpeg -i <file>` stderr (ffmpeg always prints stream info there,
 * then exits non-zero for lack of an output — that's fine, we only want the text).
 *
 * Why this exists: the bundled @ffprobe-installer binary (a 2018 static build, the newest this
 * package offers) SEGFAULTS on some otherwise-valid MPEG-TS files, e.g. the concat intermediate
 * produced during assembly (reproduced deterministically in testing). The bundled ffmpeg binary
 * decodes and reports on the exact same file without issue, so it is the fallback source of truth
 * whenever ffprobe fails outright (non-zero exit, JSON parse failure, or a crash signal).
 */
async function _probeViaFfmpegText(file) {
  let text;
  try { await _run(ffmpegBin(), ['-y', '-i', file], { timeoutMs: 60000 }); text = ''; }
  catch (e) { text = e.message; }                              // ffmpeg with no -f/output always "fails"; the info is in stderr
  const dur = /Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/.exec(text);
  const vid = /Video:\s*([a-zA-Z0-9_]+)(?:\s*\(([^)]+)\))?[^,]*,\s*([a-zA-Z0-9_]+)(?:\([^)]*\))?[^,]*,\s*(\d+)x(\d+)[^\n]*?(\d+(?:\.\d+)?)\s*fps/.exec(text);
  const aud = /Audio:\s*([a-zA-Z0-9_]+)(?:\s*\([^)]*\))?[^,]*,\s*(\d+)\s*Hz,\s*(mono|stereo|[\d.]+)/.exec(text);
  if (!dur || !vid) throw new Error(`[Branding] ffmpeg-text fallback could not parse ${file}: ${text.slice(-500)}`);
  return {
    width: Number(vid[4]), height: Number(vid[5]),
    duration: Number(dur[1]) * 3600 + Number(dur[2]) * 60 + Number(dur[3]),
    videoCodec: vid[1], audioCodec: aud ? aud[1] : null, hasAudio: Boolean(aud),
    audioSamples: aud ? Number(aud[2]) : null, channels: aud ? (aud[3] === 'mono' ? 1 : aud[3] === 'stereo' ? 2 : Math.round(Number(aud[3]))) : null,
    fps: Number(vid[6]), pixFmt: vid[3], profile: vid[2] || null,
    size: fs.existsSync(file) ? fs.statSync(file).size : 0, via: 'ffmpeg-text-fallback',
  };
}

async function probe(file) {
  try { return await _probeViaFfprobe(file); }
  catch (e) {
    console.warn(`[Branding] ffprobe failed on ${file} (${e.message.split('\n')[0].slice(0, 160)}) — falling back to ffmpeg text probe.`);
    return _probeViaFfmpegText(file);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Layout (pure — unit tested)
// ─────────────────────────────────────────────────────────────────────────────

/** Aspect ratio from the PNG IHDR header, so swapping the asset needs no code change. */
function _pngAspect(file) {
  const fd = fs.openSync(file, 'r');
  try {
    const b = Buffer.alloc(24); fs.readSync(fd, b, 0, 24, 0);
    if (b.toString('ascii', 1, 4) !== 'PNG') throw new Error(`[Branding] logo is not a PNG: ${file}`);
    return b.readUInt32BE(16) / b.readUInt32BE(20);
  } finally { fs.closeSync(fd); }
}

const _even = n => Math.max(2, Math.round(n / 2) * 2);

/**
 * Where and how big the logo goes for a given frame.
 * Portrait (9:16, the StreamVerse default) gets a larger bug than landscape.
 */
function computeLayout({ width, height }, cfg = settings(), logoAspect = 1103 / 284 /* only used when caller passes none */) {
  const portrait = height > width;
  const widthPct = cfg.widthPct != null ? cfg.widthPct : (portrait ? 0.40 : 0.19);
  const logoW = _even(width * widthPct);
  const logoH = _even(logoW / logoAspect);
  const margin = Math.round(width * cfg.marginPct);
  // Top placements sit a little lower on portrait so they clear phone status bars / TikTok header.
  const topInset = portrait ? Math.round(height * 0.045) : margin;
  const x = cfg.position.endsWith('left') ? margin : width - logoW - margin;
  const y = cfg.position.startsWith('top') ? topInset : height - logoH - (portrait ? Math.round(height * 0.06) : margin);
  return { logoW, logoH, x, y, opacity: cfg.opacity, position: cfg.position };
}

function buildFilterGraph(layout) {
  // Logo is scaled once, faded to the requested opacity, then overlaid. The
  // overlay input is a single PNG frame; overlay repeats it for the whole film.
  return (
    `[1:v]scale=${layout.logoW}:${layout.logoH}:flags=lanczos,format=rgba,` +
    `colorchannelmixer=aa=${layout.opacity}[bug];` +
    `[0:v][bug]overlay=${layout.x}:${layout.y},format=yuv420p[v]`
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Encode + verify
// ─────────────────────────────────────────────────────────────────────────────

const _COPYABLE_AUDIO = new Set(['aac', 'mp3', 'ac3', 'eac3']);

function buildEncodeArgs({ inputPath, outputPath, layout, inInfo, cfg }) {
  const args = [
    '-nostdin', '-y', '-hide_banner', '-loglevel', 'error',
    '-i', inputPath,
    '-i', cfg.logoPath,
    '-filter_complex', buildFilterGraph(layout),
    '-map', '[v]', '-map', '0:a?',
    '-c:v', 'libx264', '-preset', cfg.preset, '-crf', String(cfg.crf),
    '-pix_fmt', 'yuv420p',
  ];
  // Dialogue/music must never be touched by branding: stream-copy whenever possible.
  if (inInfo.hasAudio) {
    if (_COPYABLE_AUDIO.has(inInfo.audioCodec)) args.push('-c:a', 'copy');
    else args.push('-c:a', 'aac', '-b:a', '192k');
  }
  args.push('-map_metadata', '0', '-movflags', '+faststart', outputPath);
  return args;
}

/** Mean absolute grey difference of a crop between two files at time t. */
async function _cropDiff(fileA, fileB, t, layout) {
  const grab = file => _run(ffmpegBin(), [
    '-nostdin', '-hide_banner', '-loglevel', 'error',
    '-ss', String(t), '-i', file, '-frames:v', '1',
    '-vf', `crop=${layout.logoW}:${layout.logoH}:${layout.x}:${layout.y},scale=64:-1,format=gray`,
    '-f', 'rawvideo', '-',
  ], { binary: true });
  const [a, b] = await Promise.all([grab(fileA), grab(fileB)]);
  if (!a.length || a.length !== b.length) throw new Error('[Branding] verification frame grab failed');
  let sum = 0;
  for (let i = 0; i < a.length; i++) sum += Math.abs(a[i] - b[i]);
  return sum / a.length;
}

/**
 * Media QC on the branded output. Throws with a precise reason on failure.
 * Checks the things that actually go wrong: wrong size, truncated encode,
 * dropped audio, and — the point of the exercise — logo pixels really present.
 */
async function verifyBranded({ inputPath, outputPath, inInfo, layout }) {
  const outInfo = await probe(outputPath);
  const problems = [];
  if (outInfo.width !== inInfo.width || outInfo.height !== inInfo.height) {
    problems.push(`dimensions changed ${inInfo.width}x${inInfo.height} -> ${outInfo.width}x${outInfo.height}`);
  }
  const tol = Math.max(0.5, inInfo.duration * 0.01);
  if (Math.abs(outInfo.duration - inInfo.duration) > tol) {
    problems.push(`duration drifted ${inInfo.duration.toFixed(2)}s -> ${outInfo.duration.toFixed(2)}s (tol ${tol.toFixed(2)}s)`);
  }
  if (inInfo.hasAudio && !outInfo.hasAudio) problems.push('audio track lost');
  if (!outInfo.size) problems.push('output file is empty');

  let logoDiff = null;
  if (!problems.length) {
    const t = Math.min(1, Math.max(0, inInfo.duration / 2 - 0.1));
    logoDiff = await _cropDiff(inputPath, outputPath, t, layout);
    if (logoDiff < 3) problems.push(`logo not visible in output (crop diff ${logoDiff.toFixed(2)} < 3)`);
  }
  if (problems.length) throw new Error(`[Branding] QC failed: ${problems.join('; ')}`);
  return { outInfo, logoDiff };
}

/**
 * Burn the logo into `inputPath`, writing `outputPath`. Returns a report.
 * Pure local-file operation: no network, no Cloudinary — this is what tests call.
 */
async function brandMasterFile({ inputPath, outputPath, cfg = settings() }) {
  if (!fs.existsSync(cfg.logoPath)) throw new Error(`[Branding] logo asset not found: ${cfg.logoPath}`);
  const started = Date.now();
  const inInfo = await probe(inputPath);
  const layout = computeLayout(inInfo, cfg, _pngAspect(cfg.logoPath));
  await _run(ffmpegBin(), buildEncodeArgs({ inputPath, outputPath, layout, inInfo, cfg }), { timeoutMs: cfg.timeoutMs });
  const { outInfo, logoDiff } = await verifyBranded({ inputPath, outputPath, inInfo, layout });
  return {
    applied: true,
    layout,
    input: inInfo,
    output: outInfo,
    audioMode: inInfo.hasAudio ? (_COPYABLE_AUDIO.has(inInfo.audioCodec) ? 'stream-copy' : 'aac-reencode') : 'none',
    logoDiff,
    elapsedMs: Date.now() - started,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Download / publish
// ─────────────────────────────────────────────────────────────────────────────

async function _fetchToFile(url, dest, timeoutMs) {
  if (!/^https?:\/\//i.test(url)) {           // local path (tests / manual reruns)
    await fs.promises.copyFile(url, dest);
    return;
  }
  const axios = require('axios');
  const resp = await axios.get(url, { responseType: 'stream', timeout: 60000, maxRedirects: 5 });
  const timer = setTimeout(() => resp.data.destroy(new Error('download timeout')), timeoutMs);
  try {
    await streamPipeline(resp.data, fs.createWriteStream(dest));
  } finally {
    clearTimeout(timer);
  }
}

// One encode at a time per process: a second concurrent 18-minute x264 job on a
// small host would starve the first for no benefit.
let _queue = Promise.resolve();
function _serial(fn) {
  const run = _queue.then(fn, fn);
  _queue = run.catch(() => {});
  return run;
}

/**
 * The single entry point the pipeline uses for a finished master.
 * Replaces `cloudinary.uploadVideoFromUrl(finalVideoUrl, publicId)`.
 *
 * @returns {Promise<string>} Cloudinary secure_url of the BRANDED master.
 */
async function publishBrandedMaster(sourceUrl, publicId, { uploader, cfg = settings() } = {}) {
  const cloud = uploader || require('./cloudinary');

  if (!cfg.enabled) {
    console.warn(`[Branding] BRAND_ENABLED=false — publishing ${publicId} WITHOUT StreamVerse branding.`);
    return cloud.uploadVideoFromUrl(sourceUrl, publicId);
  }

  return _serial(async () => {
    const dir = await fs.promises.mkdtemp(path.join(cfg.tmpDir, 'sv-brand-'));
    const rawPath = path.join(dir, 'master_raw.mp4');
    const brandedPath = path.join(dir, 'master_branded.mp4');
    try {
      console.log(`[Branding] Downloading master for ${publicId}...`);
      await _fetchToFile(sourceUrl, rawPath, cfg.timeoutMs);
      console.log(`[Branding] Burning StreamVerse Studio logo into master (${cfg.position})...`);
      const report = await brandMasterFile({ inputPath: rawPath, outputPath: brandedPath, cfg });
      console.log(
        `[Branding] Branded ${report.output.width}x${report.output.height} ` +
        `${report.output.duration.toFixed(1)}s in ${(report.elapsedMs / 1000).toFixed(1)}s ` +
        `| audio=${report.audioMode} | logoDiff=${report.logoDiff.toFixed(1)}`
      );
      return await cloud.uploadVideoFile(brandedPath, publicId);
    } catch (err) {
      if (cfg.required) {
        err.message = `[Branding] Refusing to publish an unbranded master for ${publicId}: ${err.message}`;
        throw err;
      }
      console.error(`[Branding] FAILED (BRAND_REQUIRED=false) — publishing unbranded: ${err.message}`);
      return cloud.uploadVideoFromUrl(sourceUrl, publicId);
    } finally {
      fs.promises.rm(dir, { recursive: true, force: true }).catch(() => {});
    }
  });
}

/** Cheap startup / dashboard check: asset present, binaries runnable. */
async function selfCheck(cfg = settings()) {
  if (!cfg.enabled) return { ok: true, detail: 'disabled (BRAND_ENABLED=false)' };
  if (!fs.existsSync(cfg.logoPath)) throw new Error(`logo asset missing: ${cfg.logoPath}`);
  const v = (await _run(ffmpegBin(), ['-version'])).split('\n')[0];
  await _run(ffprobeBin(), ['-version']);
  return { ok: true, detail: `${v.slice(0, 40)} · logo=${path.basename(cfg.logoPath)} · ${cfg.position}` };
}

module.exports = {
  settings,
  probe,
  run: _run,
  ffmpegBin,
  ffprobeBin,
  computeLayout,
  buildFilterGraph,
  buildEncodeArgs,
  verifyBranded,
  brandMasterFile,
  publishBrandedMaster,
  selfCheck,
};
