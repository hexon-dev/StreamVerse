import express from "express";
import axios from "axios";
import fs from "fs";
import os from "os";
import path from "path";
import { spawn } from "child_process";
import { v4 as uuidv4 } from "uuid";
import { v2 as cloudinary } from "cloudinary";
import pLimit from "p-limit";

// ================= CONFIG =================
const PORT = process.env.PORT || 3000;
const API_KEYS = [
  process.env.API_KEY,
  process.env.FFMPEG_SERVICE_API_KEY,
  process.env.FFMPEG_API_KEY,
].map(v => String(v || '').trim()).filter(Boolean);
const API_KEY = API_KEYS[0] || '';

function parseCloudinaryUrl(raw) {
  const value = String(raw || '').trim();
  if (!value || !value.startsWith('cloudinary://')) return {};
  try {
    const parsed = new URL(value);
    return {
      cloudName: decodeURIComponent(parsed.hostname || ''),
      apiKey: decodeURIComponent(parsed.username || ''),
      apiSecret: decodeURIComponent(parsed.password || ''),
    };
  } catch (err) {
    console.warn(`[FFmpegService] Invalid CLOUDINARY_URL: ${err.message}`);
    return {};
  }
}

const cloudinaryUrlConfig = parseCloudinaryUrl(process.env.CLOUDINARY_URL);
const CLOUDINARY_CONFIG = {
  cloudName: String(process.env.CLOUDINARY_CLOUD_NAME || cloudinaryUrlConfig.cloudName || '').trim(),
  apiKey: String(process.env.CLOUDINARY_API_KEY || cloudinaryUrlConfig.apiKey || '').trim(),
  apiSecret: String(process.env.CLOUDINARY_API_SECRET || cloudinaryUrlConfig.apiSecret || '').trim(),
};
const CLOUDINARY_CONFIGURED = Boolean(
  CLOUDINARY_CONFIG.cloudName && CLOUDINARY_CONFIG.apiKey && CLOUDINARY_CONFIG.apiSecret
);

const MAX_CLIPS = 90;

// ✅ MEMORY FIX: this was 2. Two concurrent jobs means two full ffmpeg
// pipelines (normalize + effects + compose, each its own ffmpeg process)
// running at once, which roughly doubles peak RSS. On a small Render
// instance that's very likely what's tipping you into OOM. Default to
// running jobs one at a time; bump via env if you upgrade the instance.
const MAX_CONCURRENT_JOBS = parseInt(process.env.MAX_CONCURRENT_JOBS || "1", 10);

// ✅ MEMORY FIX: fewer simultaneous downloads = less concurrent disk-write
// buffering and fewer open sockets/streams at once.
const DOWNLOAD_CONCURRENCY = parseInt(process.env.DOWNLOAD_CONCURRENCY || "2", 10);

// Maximum time without a progress timestamp before an FFmpeg process is
// considered stuck. Long but active encodes are allowed to finish.
const FFMPEG_TIMEOUT = parseInt(process.env.FFMPEG_TIMEOUT || "1200000", 10);

// ================= QUALITY / DELIVERY =================
// Keep the native LTX vertical master size by default.
// LTX portrait shots in the studio are generated at 1024x1536.
// The old service hard-downscaled them to 480x854 before composition,
// permanently throwing away detail. Override only when you intentionally
// want a smaller delivery master.
const OUTPUT_WIDTH = parseInt(process.env.OUTPUT_WIDTH || "1024", 10);
const OUTPUT_HEIGHT = parseInt(process.env.OUTPUT_HEIGHT || "1536", 10);
const OUTPUT_FPS = parseInt(process.env.OUTPUT_FPS || "30", 10);

// CRF controls visual quality; the x264 preset mainly controls how much CPU
// is spent finding compression savings. Keeping CRF 18 means ultrafast does
// not intentionally reduce visual quality, though it can produce larger files.
// Use VIDEO_PRESET=fast/medium when file size matters more than render speed.
const VIDEO_CRF = parseInt(process.env.VIDEO_CRF || "18", 10);
const VIDEO_PRESET = process.env.VIDEO_PRESET || "ultrafast";
// Transitions used to encode once per clip. They now encode once total, so
// veryfast gives materially smaller files than ultrafast without adding much
// wall-clock time to the one-pass transition render.
const TRANSITION_VIDEO_PRESET = process.env.TRANSITION_VIDEO_PRESET || "veryfast";

// Preserve encoder look-ahead/reference frames enough to avoid the very
// aggressive low-memory settings used by the old service. FFMPEG_THREADS
// still limits total process threading for small Render instances.
const X264_QUALITY_PARAMS = process.env.X264_QUALITY_PARAMS ||
  (VIDEO_PRESET === "ultrafast"
    ? "rc-lookahead=0:ref=1:bframes=0"
    : "rc-lookahead=12:ref=3:bframes=2");

const USE_GPU = process.env.USE_GPU === "true";

// Keep this configurable for small memory-constrained deployments, but do not
// default to one thread: that makes every fallback normalization/compose encode
// unnecessarily slow. Zero delegates the thread count to FFmpeg, and jobs are
// serialized by default so encodes do not compete with another job.
const FFMPEG_THREADS = parseInt(process.env.FFMPEG_THREADS || "0", 10);

// ✅ IMPORTANT (read this): os.tmpdir() usually resolves to /tmp. On many
// container platforms -- Render included, depending on plan/runtime --
// /tmp is a tmpfs mount, meaning it's backed by RAM, not disk. If that's
// the case here, every downloaded clip + every normalized/effect/compose
// intermediate file is *also* counting against your memory limit, on top
// of ffmpeg's own working memory. That would explain OOM specifically
// during "stitching" (many clips × multiple copies of each on disk at
// once). Set TMP_DIR to a real persistent disk mount (Render lets you
// attach one in the dashboard) to rule this out / fix it for good.
const TMP_ROOT = process.env.TMP_DIR || os.tmpdir();

// ✅ MEMORY FIX (leak, not spike): the in-memory `jobs` Map never had
// anything removed from it, so on a long-running instance it grows
// forever and slowly eats RAM until something (maybe this) tips you over.
// Finished jobs are now swept out after JOB_TTL_MS.
const JOB_TTL_MS = parseInt(process.env.JOB_TTL_MS || String(60 * 60 * 1000), 10); // 1h

// Cloudinary's plain `upload_stream` is a single non-chunked multipart
// request, capped at 100MB on most plans. Chunked upload (upload_large)
// streams the file in CLOUDINARY_CHUNK_SIZE-byte pieces instead.
const CLOUDINARY_CHUNK_SIZE = parseInt(process.env.CLOUDINARY_CHUNK_SIZE || "20000000", 10); // 20MB default
const CLOUDINARY_UPLOAD_TIMEOUT = parseInt(process.env.CLOUDINARY_UPLOAD_TIMEOUT || "600000", 10); // 10 min
const CLOUDINARY_MAX_FILE_SIZE = 100 * 1024 * 1024;
// Leave room below Cloudinary's hard limit for multipart/container overhead.
const CLOUDINARY_TARGET_FILE_SIZE = parseInt(
  process.env.CLOUDINARY_TARGET_FILE_SIZE || String(98 * 1024 * 1024),
  10
);
const UPLOAD_FALLBACK_CRF = parseInt(process.env.UPLOAD_FALLBACK_CRF || "18", 10);
const UPLOAD_VIDEO_PRESET = process.env.UPLOAD_VIDEO_PRESET || "ultrafast";

// Ken Burns zoom rate for the "zoom" composition layout.
const ZOOM_RATE = 0.0015;
const ZOOM_MAX = 1.5;

// PIP box sizing/positioning for the "overlay" composition layout.
const OVERLAY_SCALE = 0.35;
const OVERLAY_MARGIN = 24;

if (!API_KEYS.length) {
  console.error("❌ Missing FFmpeg service API key. Set API_KEY, FFMPEG_SERVICE_API_KEY, or FFMPEG_API_KEY.");
  process.exit(1);
}
if (!CLOUDINARY_CONFIGURED) {
  console.error("❌ Missing Cloudinary configuration. Set CLOUDINARY_CLOUD_NAME, CLOUDINARY_API_KEY, and CLOUDINARY_API_SECRET on the external FFmpeg service.");
  process.exit(1);
}

// ================= CLOUDINARY =================
cloudinary.config({
  cloud_name: CLOUDINARY_CONFIG.cloudName,
  api_key: CLOUDINARY_CONFIG.apiKey,
  api_secret: CLOUDINARY_CONFIG.apiSecret,
});

// ================= APP =================
const app = express();
app.use(express.json({ limit: "10mb" }));

// ================= JOB STORE =================
const jobs = new Map();

// ✅ MEMORY FIX: periodic sweep of completed/failed jobs older than
// JOB_TTL_MS so the Map doesn't grow unbounded over the service's uptime.
setInterval(() => {
  const now = Date.now();
  for (const [id, job] of jobs.entries()) {
    if (
      (job.status === "done" || job.status === "failed") &&
      job._completedAt &&
      now - job._completedAt > JOB_TTL_MS
    ) {
      jobs.delete(id);
    }
  }
}, 5 * 60 * 1000);

// ================= RATE LIMIT =================
const requestCounts = new Map();
setInterval(() => requestCounts.clear(), 60000);

app.use((req, res, next) => {
  const ip = req.ip;
  const count = requestCounts.get(ip) || 0;

  if (count > 30) {
    return res.status(429).json({ error: "Rate limit exceeded" });
  }

  requestCounts.set(ip, count + 1);
  next();
});

// ================= AUTH =================
const auth = (req, res, next) => {
  const provided = String(req.headers["x-api-key"] || "").trim();
  if (!provided || !API_KEYS.includes(provided)) {
    return res.status(401).json({ error: "Unauthorized", code: "FFMPEG_AUTH_MISMATCH" });
  }
  next();
};

// ================= QUEUE =================
const jobLimit = pLimit(MAX_CONCURRENT_JOBS);

// ================= LOGGER =================
const log = (msg, data = {}) => {
  console.log(JSON.stringify({
    msg,
    ...data,
    time: new Date().toISOString()
  }));
};

// ================= WEBHOOK SAFE SENDER =================
const sendWebhook = async (url, payload) => {
  if (!url) return;
  try {
    await axios.post(url, payload, { timeout: 10000 });
  } catch (err) {
    log("webhook_failed", { error: err.message });
  }
};

// ================= HELPERS =================
const updateJob = (id, patch) => {
  const job = jobs.get(id);
  if (!job) return;
  const updated = { ...job, ...patch };
  jobs.set(id, updated);
  return updated;
};

const getErrorMessage = (error) => {
  if (typeof error === "string") return error;
  const responseData = error?.response?.data;
  if (typeof responseData === "string") return responseData;
  if (responseData && typeof responseData === "object") {
    const message = responseData.message ??
      responseData.error?.message ??
      responseData.error;
    if (typeof message === "string") return message;
  }
  return typeof error?.message === "string" ? error.message : "Job failed";
};

const publicJob = (job) => {
  if (!job) return job;
  return {
    ...job,
    ...(Object.hasOwn(job, "error") ? { error: getErrorMessage(job.error) } : {})
  };
};

const extractTrailingNumber = (str) => {
  const match = str.match(/(\d+)/g);
  return match ? parseInt(match.pop(), 10) : Number.MAX_SAFE_INTEGER;
};

const normalizeUrl = (url) => {
  if (url.includes("player.cloudinary.com")) {
    const match = url.match(/public_id=([^&]+)/);
    if (!match) return url;

    return `https://res.cloudinary.com/${CLOUDINARY_CONFIG.cloudName}/video/upload/${match[1]}.mp4`;
  }
  return url;
};

// ================= DOWNLOAD =================
const downloadFile = async (url, outputPath) => {
  const cleanUrl = normalizeUrl(url);

  try {
    const res = await axios({
      method: "GET",
      url: cleanUrl,
      responseType: "stream",
      timeout: 60000,
      validateStatus: s => s < 400
    });

    await new Promise((resolve, reject) => {
      const writer = fs.createWriteStream(outputPath);
      res.data.pipe(writer);
      writer.on("finish", resolve);
      writer.on("error", reject);
    });
  } catch (err) {
    const status = Number(err?.response?.status);
    let host = 'unknown';
    let pathname = '/';
    try {
      const u = new URL(cleanUrl);
      host = u.host;
      pathname = u.pathname || '/';
    } catch (_) {}
    throw new Error(
      `[FFmpegService] Source download failed${status ? ` HTTP ${status}` : ''} for ${host}${pathname}: ${err?.message || 'request failed'}`
    );
  }

  if (!fs.existsSync(outputPath) || fs.statSync(outputPath).size === 0) {
    throw new Error(`[FFmpegService] Source download produced an empty file for ${outputPath}`);
  }
};

// ================= FFMPEG =================
// ✅ MEMORY FIX: every ffmpeg invocation now gets a global "-threads N"
// cap injected right after "-y" (before any -i), which bounds both decode
// and filter-graph thread pools, not just the encoder.
const withThreadCap = (args) => ["-y", "-threads", String(FFMPEG_THREADS), ...args.filter(a => a !== "-y")];

const runFFmpeg = (rawArgs, jobId, webhook) => {
  const args = withThreadCap(rawArgs);
  return new Promise((resolve, reject) => {
    const ffmpeg = spawn("ffmpeg", args);

    // ✅ DIAGNOSTIC FIX: a SIGKILL from our own FFMPEG_TIMEOUT and a
    // SIGKILL from the OS OOM killer look identical on close (code: null,
    // signal: "SIGKILL") -- there was no way to tell them apart from the
    // logs. `timedOut` disambiguates: if it's true, this was our timeout;
    // if close still reports SIGKILL/null with timedOut false, that's a
    // strong signal it was killed externally (most likely OOM).
    let timedOut = false;
    let lastProgress = null;
    let timeout;

    const killForInactivity = () => {
      timedOut = true;
      log("ffmpeg_timeout_killing", {
        jobId,
        timeoutMs: FFMPEG_TIMEOUT,
        lastProgress,
        output: rawArgs[rawArgs.length - 1]
      });
      ffmpeg.kill("SIGKILL");
    };
    const resetTimeout = () => {
      clearTimeout(timeout);
      timeout = setTimeout(killForInactivity, FFMPEG_TIMEOUT);
    };
    resetTimeout();

    ffmpeg.stderr.on("data", async (d) => {
      const output = d.toString();
      log("ffmpeg", { output });

      const timeMatch = output.match(/time=(\d+:\d+:\d+\.\d+)/);
      if (timeMatch) {
        const progress = timeMatch[1];
        lastProgress = progress;
        resetTimeout();

        updateJob(jobId, { progress });

        await sendWebhook(webhook, {
          jobId,
          status: "processing",
          progress
        });
      }
    });

    ffmpeg.on("close", (code, signal) => {
      clearTimeout(timeout);

      if (timedOut) {
        log("ffmpeg_failed_timeout", {
          jobId,
          timeoutMs: FFMPEG_TIMEOUT,
          lastProgress,
          output: rawArgs[rawArgs.length - 1]
        });
        return reject(new Error(`FFmpeg timeout after ${FFMPEG_TIMEOUT}ms (last progress: ${lastProgress || "none"})`));
      }

      if (code !== 0) {
        // code: null + signal: "SIGKILL"/"SIGTERM" here (with timedOut
        // false) most likely means something outside this process killed
        // it -- on Render that's almost always the OOM killer.
        log("ffmpeg_failed", { code, signal, lastProgress, likelyOOM: code === null && !!signal });
        return reject(new Error(`FFmpeg exit code=${code} signal=${signal || "none"}`));
      }
      resolve();
    });

    ffmpeg.on("error", err => {
      clearTimeout(timeout);
      reject(err);
    });
  });
};

const getDuration = (file) => {
  return new Promise((resolve, reject) => {
    const ffprobe = spawn("ffprobe", [
      "-v", "error",
      "-show_entries", "format=duration",
      "-of", "default=noprint_wrappers=1:nokey=1",
      file
    ]);

    let out = "";
    ffprobe.stdout.on("data", d => { out += d.toString(); });
    ffprobe.on("close", code => {
      const val = parseFloat(out.trim());
      if (code !== 0 || Number.isNaN(val)) {
        return reject(new Error(`ffprobe failed for ${file} (exit ${code})`));
      }
      resolve(val);
    });
    ffprobe.on("error", reject);
  });
};

const hasAudioStream = (file) => {
  return new Promise((resolve) => {
    const ffprobe = spawn("ffprobe", [
      "-v", "error",
      "-select_streams", "a",
      "-show_entries", "stream=codec_type",
      "-of", "default=noprint_wrappers=1:nokey=1",
      file
    ]);

    let out = "";
    ffprobe.stdout.on("data", d => { out += d.toString(); });
    ffprobe.on("close", () => resolve(out.trim() === "audio"));
    ffprobe.on("error", () => resolve(false));
  });
};

// ✅ Shared encode-arg builder so the thread cap + low-memory x264 params
// live in exactly one place instead of being repeated (and easy to forget)
// across every compose/effects function.
//
// ✅ PLAYBACK FIX: added "-pix_fmt yuv420p" to BOTH the CPU and GPU
// branches. Without it, ffmpeg picks the pixel format closest to
// whatever the *input* happens to be. If any source clip is 10-bit
// or 4:2:2/4:4:4 chroma (common from AI video generators and some
// screen recorders), libx264 will silently encode as High 4:4:4
// Predictive or High 10 Profile instead of standard High/Main/Baseline.
// Those profiles are NOT supported by Chrome/Safari's MP4 decoder --
// the file is valid and plays fine in ffplay/VLC, but the browser
// throws a generic "media playback aborted... corruption" error.
// Forcing yuv420p here means every encode step in the pipeline
// (normalize, per-clip effects, xfade transitions, filter_complex
// composes, final effects) always outputs browser-safe 8-bit 4:2:0,
// which also makes the concat-demuxer "-c copy" fast path safe --
// every normalized clip is now guaranteed to share the same chroma
// format going in, so stream-copying them together can't produce a
// file with mismatched profiles baked into one container.
const videoEncodeArgs = (preset = VIDEO_PRESET, { includeCrf = true } = {}) => {
  if (USE_GPU) {
    return [
      "-c:v", "h264_nvenc",
      "-preset", process.env.NVENC_PRESET || "p4",
      "-cq", String(process.env.NVENC_CQ || "19"),
      "-pix_fmt", "yuv420p"
    ];
  }
  const args = [
    "-c:v", "libx264",
    "-preset", preset,
    "-pix_fmt", "yuv420p",
    "-x264-params", X264_QUALITY_PARAMS
  ];
  if (includeCrf) args.splice(4, 0, "-crf", String(VIDEO_CRF));
  return args;
};

// ================= NORMALIZE =================
const normalizeClip = async (input, output, jobId, webhook) => {
  const hasAudio = await hasAudioStream(input);

  const args = ["-i", input];

  if (!hasAudio) {
    args.push(
      "-f", "lavfi",
      "-i", "anullsrc=channel_layout=stereo:sample_rate=44100",
      "-shortest"
    );
  }

  args.push(
    "-vf", `scale=${OUTPUT_WIDTH}:${OUTPUT_HEIGHT}:force_original_aspect_ratio=decrease:flags=lanczos,pad=${OUTPUT_WIDTH}:${OUTPUT_HEIGHT}:(ow-iw)/2:(oh-ih)/2:color=black,fps=${OUTPUT_FPS}`,
    ...videoEncodeArgs(),
    "-c:a", "aac",
    "-ar", "44100",
    "-ac", "2",
    output
  );

  await runFFmpeg(args, jobId, webhook);
};

// ================= CONCAT (fast path) =================
// ✅ MEMORY FIX: this is the single biggest change. Every clip passed to
// a compose step has already been through normalizeClip with IDENTICAL
// codec/resolution/fps/audio settings. That means for a plain hard-cut
// with no transition and no per-clip effects, we don't need to decode
// and re-encode anything at all -- the concat *demuxer* can just splice
// the already-encoded bitstreams together with "-c copy". The old
// filter_complex concat had to keep every single input's decoder open
// simultaneously to feed the filter graph, so peak memory scaled with
// clip count (50 clips = 50 open decoders). This fast path's memory
// footprint is flat regardless of how many clips are in the job.
//
// Now that videoEncodeArgs() forces yuv420p on every input to this
// function, this stream-copy is also playback-safe: there's no risk of
// splicing together clips with different chroma subsampling/profile
// baked in from normalization.
const concatDemuxerCopy = async (normalized, outputPath, jobId, webhook) => {
  const listFile = `${outputPath}.concat.txt`;
  const listContent = normalized
    .map(f => `file '${path.resolve(f).replace(/'/g, "'\\''")}'`)
    .join("\n");
  fs.writeFileSync(listFile, listContent);

  try {
    await runFFmpeg([
      "-f", "concat",
      "-safe", "0",
      "-i", listFile,
      "-c", "copy",
      "-movflags", "+faststart",
      outputPath
    ], jobId, webhook);
  } finally {
    fs.rmSync(listFile, { force: true });
  }
};

// A plain cut with no effects does not need normalization first. Try the
// original downloads directly: when their streams are concat-compatible this
// avoids decoding and re-encoding every clip (the dominant cost of a merge).
// The caller keeps the downloads until this attempt completes so an
// incompatible set can safely fall back to the normal pipeline.
const tryDirectConcat = async (sourceFiles, outputPath, jobId, webhook) => {
  if (sourceFiles.length < 2) return false;

  try {
    await concatDemuxerCopy(sourceFiles, outputPath, jobId, webhook);
    log("direct_concat_succeeded", { jobId, clips: sourceFiles.length });
    return true;
  } catch (err) {
    log("direct_concat_incompatible_falling_back_to_normalize", {
      jobId,
      clips: sourceFiles.length,
      error: err.message
    });
    fs.rmSync(outputPath, { force: true });
    return false;
  }
};

// ================= COMPOSITION LAYOUTS =================
const composeCut = async (normalized, outputPath, jobId, webhook) => {
  if (normalized.length === 1) {
    fs.copyFileSync(normalized[0], outputPath);
    return;
  }

  try {
    await concatDemuxerCopy(normalized, outputPath, jobId, webhook);
    return;
  } catch (err) {
    // Falls back to the old decode+re-encode path only if stream-copy
    // concat fails (e.g. a clip slipped through with mismatched params).
    log("concat_demuxer_failed_falling_back_to_filter_complex", { error: err.message });
  }

  const filter =
    normalized.map((_, i) => `[${i}:v:0][${i}:a:0]`).join("") +
    `concat=n=${normalized.length}:v=1:a=1[outv][outa]`;

  await runFFmpeg([
    ...normalized.flatMap(c => ["-i", c]),
    "-filter_complex", filter,
    "-map", "[outv]",
    "-map", "[outa]",
    ...videoEncodeArgs(),
    "-c:a", "aac",
    outputPath
  ], jobId, webhook);
};

const composeOverlay = async (normalized, outputPath, jobId, webhook) => {
  const [base, ...overlays] = normalized;

  if (overlays.length === 0) {
    fs.copyFileSync(base, outputPath);
    return;
  }

  const baseDuration = await getDuration(base);
  const segDuration = baseDuration / overlays.length;
  const boxW = Math.round(OUTPUT_WIDTH * OVERLAY_SCALE);
  const boxH = Math.round(OUTPUT_HEIGHT * OVERLAY_SCALE);
  const x = OUTPUT_WIDTH - boxW - OVERLAY_MARGIN;
  const y = OUTPUT_HEIGHT - boxH - OVERLAY_MARGIN;

  const inputs = ["-i", base, ...overlays.flatMap(c => ["-i", c])];

  const scaleFilters = overlays
    .map((_, i) => `[${i + 1}:v]scale=${boxW}:${boxH}[ov${i}]`)
    .join(";");

  const overlaySteps = overlays
    .map((_, i) => {
      const start = (i * segDuration).toFixed(3);
      const end = ((i + 1) * segDuration).toFixed(3);
      const inLabel = i === 0 ? "[0:v]" : `[tmp${i - 1}]`;
      const outLabel = i === overlays.length - 1 ? "[outv]" : `[tmp${i}]`;
      return `${inLabel}[ov${i}]overlay=${x}:${y}:enable='between(t,${start},${end})'${outLabel}`;
    })
    .join(";");

  const filter = `${scaleFilters};${overlaySteps}`;

  await runFFmpeg([
    ...inputs,
    "-filter_complex", filter,
    "-map", "[outv]",
    "-map", "0:a:0",
    "-t", baseDuration.toFixed(3),
    ...videoEncodeArgs(),
    "-c:a", "aac",
    outputPath
  ], jobId, webhook);
};

const composeSplit = async (normalized, outputPath, jobId, webhook) => {
  const [top, bottom] = normalized;
  const halfH = Math.floor(OUTPUT_HEIGHT / 2);

  const filter =
    `[0:v]scale=${OUTPUT_WIDTH}:${halfH}[top];` +
    `[1:v]scale=${OUTPUT_WIDTH}:${halfH}[bottom];` +
    `[top][bottom]vstack=inputs=2[outv];` +
    `[0:a][1:a]amix=inputs=2:duration=shortest:dropout_transition=0[outa]`;

  await runFFmpeg([
    "-i", top,
    "-i", bottom,
    "-filter_complex", filter,
    "-map", "[outv]",
    "-map", "[outa]",
    ...videoEncodeArgs(),
    "-c:a", "aac",
    outputPath
  ], jobId, webhook);
};

const composeZoom = async (normalized, outputPath, jobId, webhook) => {
  if (normalized.length > 1) {
    log("zoom_layout_extra_clips_ignored", { extraCount: normalized.length - 1 });
  }

  const clip = normalized[0];
  const duration = await getDuration(clip);
  const frames = Math.max(1, Math.round(duration * OUTPUT_FPS));

  const filter =
    `zoompan=z='min(zoom+${ZOOM_RATE},${ZOOM_MAX})':d=${frames}:` +
    `x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':` +
    `s=${OUTPUT_WIDTH}x${OUTPUT_HEIGHT}:fps=${OUTPUT_FPS}`;

  await runFFmpeg([
    "-i", clip,
    "-vf", filter,
    "-map", "0:a:0",
    ...videoEncodeArgs(),
    "-c:a", "aac",
    outputPath
  ], jobId, webhook);
};

// ============================================================
// ================= STUDIO EFFECTS CATALOG ====================
// ============================================================
const TRANSITIONS = [
  "fade", "fadeblack", "fadewhite", "distance",
  "wipeleft", "wiperight", "wipeup", "wipedown",
  "slideleft", "slideright", "slideup", "slidedown",
  "smoothleft", "smoothright", "smoothup", "smoothdown",
  "circlecrop", "rectcrop", "circleopen", "circleclose",
  "vertopen", "vertclose", "horzopen", "horzclose",
  "dissolve", "pixelize",
  "diagtl", "diagtr", "diagbl", "diagbr",
  "hlslice", "hrslice", "vuslice", "vdslice",
  "hblur", "fadegrays",
  "wipetl", "wipetr", "wipebl", "wipebr",
  "squeezeh", "squeezev", "zoomin",
  "hlwind", "hrwind", "vuwind", "vdwind",
  "coverleft", "coverright", "coverup", "coverdown",
  "revealleft", "revealright", "revealup", "revealdown"
];

const MOTION_EFFECTS = {
  zoom_in: (dur) => {
    const frames = Math.max(1, Math.round(dur * OUTPUT_FPS));
    return { vf: `zoompan=z='min(zoom+${ZOOM_RATE},${ZOOM_MAX})':d=${frames}:x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':s=${OUTPUT_WIDTH}x${OUTPUT_HEIGHT}:fps=${OUTPUT_FPS}` };
  },
  zoom_out: (dur) => {
    const frames = Math.max(1, Math.round(dur * OUTPUT_FPS));
    return { vf: `zoompan=z='if(eq(on,0),${ZOOM_MAX},max(zoom-${ZOOM_RATE},1))':d=${frames}:x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':s=${OUTPUT_WIDTH}x${OUTPUT_HEIGHT}:fps=${OUTPUT_FPS}` };
  },
  kenburns_left: (dur) => ({
    vf: `scale=${Math.round(OUTPUT_WIDTH * 1.15)}:${Math.round(OUTPUT_HEIGHT * 1.15)},crop=${OUTPUT_WIDTH}:${OUTPUT_HEIGHT}:x='(iw-ow)*(1-t/${Math.max(dur, 0.1).toFixed(3)})':y='(ih-oh)/2'`
  }),
  kenburns_right: (dur) => ({
    vf: `scale=${Math.round(OUTPUT_WIDTH * 1.15)}:${Math.round(OUTPUT_HEIGHT * 1.15)},crop=${OUTPUT_WIDTH}:${OUTPUT_HEIGHT}:x='(iw-ow)*(t/${Math.max(dur, 0.1).toFixed(3)})':y='(ih-oh)/2'`
  }),
  pan_left: (dur) => ({
    vf: `scale=${Math.round(OUTPUT_WIDTH * 1.12)}:${OUTPUT_HEIGHT},crop=${OUTPUT_WIDTH}:${OUTPUT_HEIGHT}:x='(iw-ow)*(1-t/${Math.max(dur, 0.1).toFixed(3)})':y=0`
  }),
  pan_right: (dur) => ({
    vf: `scale=${Math.round(OUTPUT_WIDTH * 1.12)}:${OUTPUT_HEIGHT},crop=${OUTPUT_WIDTH}:${OUTPUT_HEIGHT}:x='(iw-ow)*(t/${Math.max(dur, 0.1).toFixed(3)})':y=0`
  }),
  pan_up: (dur) => ({
    vf: `scale=${OUTPUT_WIDTH}:${Math.round(OUTPUT_HEIGHT * 1.12)},crop=${OUTPUT_WIDTH}:${OUTPUT_HEIGHT}:x=0:y='(ih-oh)*(1-t/${Math.max(dur, 0.1).toFixed(3)})'`
  }),
  pan_down: (dur) => ({
    vf: `scale=${OUTPUT_WIDTH}:${Math.round(OUTPUT_HEIGHT * 1.12)},crop=${OUTPUT_WIDTH}:${OUTPUT_HEIGHT}:x=0:y='(ih-oh)*(t/${Math.max(dur, 0.1).toFixed(3)})'`
  }),
  shake_handheld: () => ({
    vf: `scale=${OUTPUT_WIDTH + 24}:${OUTPUT_HEIGHT + 24},crop=${OUTPUT_WIDTH}:${OUTPUT_HEIGHT}:x='12+6*sin(2*PI*t*2)':y='12+6*cos(2*PI*t*1.7)'`
  }),
  rotate_slight: () => ({
    vf: `rotate='(2*PI/180)*sin(2*PI*t/4)':ow=iw:oh=ih:fillcolor=black`
  }),
  dutch_angle_left: () => ({
    vf: `rotate=-6*PI/180:ow=iw:oh=ih:fillcolor=black`
  }),
  dutch_angle_right: () => ({
    vf: `rotate=6*PI/180:ow=iw:oh=ih:fillcolor=black`
  }),
  slow_motion_2x: () => ({
    vf: `setpts=2.0*PTS`, af: `atempo=0.5`
  }),
  slow_motion_4x: () => ({
    vf: `setpts=4.0*PTS`, af: `atempo=0.5,atempo=0.5`
  }),
  fast_forward_2x: () => ({
    vf: `setpts=0.5*PTS`, af: `atempo=2.0`
  }),
  fast_forward_4x: () => ({
    vf: `setpts=0.25*PTS`, af: `atempo=2.0,atempo=2.0`
  }),
  reverse_clip: () => ({
    vf: `reverse`, af: `areverse`
  }),
  mirror_flip: () => ({ vf: `hflip` }),
  vertical_flip: () => ({ vf: `vflip` })
};

const COLOR_GRADES = {
  cinematic_teal_orange: `colorbalance=rs=-0.12:gs=0.03:bs=0.15:rm=-0.06:bm=0.1:rh=0.08:bh=-0.05,eq=contrast=1.12:saturation=1.1`,
  noir_bw: `hue=s=0,eq=contrast=1.3:brightness=-0.02`,
  sepia_vintage: `colorchannelmixer=.393:.769:.189:0:.349:.686:.168:0:.272:.534:.131`,
  bleach_bypass: `eq=saturation=0.4:contrast=1.3`,
  high_contrast: `eq=contrast=1.5`,
  desaturated: `eq=saturation=0.3`,
  warm_golden: `colorbalance=rm=0.15:gm=0.05:bm=-0.1`,
  cool_blue: `colorbalance=bm=0.2:rm=-0.1`,
  vintage_curve: `curves=preset=vintage`,
  cross_process: `curves=preset=cross_process`,
  strong_contrast: `curves=preset=strong_contrast`,
  negative: `curves=preset=negative`,
  color_negative: `curves=preset=color_negative`,
  darker: `curves=preset=darker`,
  lighter: `curves=preset=lighter`,
  linear_contrast: `curves=preset=linear_contrast`,
  medium_contrast: `curves=preset=medium_contrast`,
  increase_contrast: `curves=preset=increase_contrast`,
  dreamy_soft: `gblur=sigma=1.5,eq=brightness=0.04:contrast=0.95`,
  moody_dark: `eq=brightness=-0.08:contrast=1.2:saturation=0.7`,
  technicolor: `eq=saturation=1.8:contrast=1.2`,
  infrared_look: `colorchannelmixer=0:0:1:0:0:1:0:0:1:0:0:0`,
  matrix_green: `colorchannelmixer=0.1:0.9:0:0:0:0.9:0.1:0:0.1:0:0.8:0`,
  faded_polaroid: `curves=preset=vintage,eq=contrast=0.9:brightness=0.05`,
  sunset_glow: `colorbalance=rm=0.2:gm=0.05,eq=brightness=0.03`,
  horror_green: `colorbalance=gm=0.3:rm=-0.2,eq=contrast=1.15`
};

const OVERLAY_EFFECTS = {
  vignette_dark: `vignette=PI/4`,
  film_grain: `noise=alls=20:allf=t+u`,
  dust_scratches: `noise=alls=8:allf=t+u`,
  vhs_overlay: `noise=alls=10:allf=t,rgbashift=rh=1:bh=-1`,
  scanlines: `drawgrid=width=iw:height=4:thickness=1:color=black@0.25`,
  letterbox_cinematic: `drawbox=x=0:y=0:w=iw:h=ih*0.12:color=black@1:t=fill,drawbox=x=0:y=ih*0.88:w=iw:h=ih*0.12:color=black@1:t=fill`,
  chromatic_aberration: `rgbashift=rh=2:bh=-2`,
  light_leak_warm: `vignette=PI/6:mode=backward,eq=brightness=0.03:saturation=1.1`
};

const escapeDrawtext = (text) =>
  String(text).replace(/\\/g, "\\\\").replace(/:/g, "\\:").replace(/'/g, "\\'");

const buildDrawText = ({ text, position = "bottom", fontSize = 36, fontColor = "white" }) => {
  const safe = escapeDrawtext(text);
  const yExpr =
    position === "top" ? "40" :
    position === "center" ? "(h-text_h)/2" :
    "h-text_h-40";
  return `drawtext=text='${safe}':fontcolor=${fontColor}:fontsize=${fontSize}:box=1:boxcolor=black@0.5:boxborderw=10:x=(w-text_w)/2:y=${yExpr}`;
};

const buildEffectFilterChain = (spec, duration) => {
  const vfParts = [];
  const afParts = [];

  if (spec?.motion) {
    const fn = MOTION_EFFECTS[spec.motion];
    if (fn) {
      const { vf, af } = fn(duration);
      if (vf) vfParts.push(vf);
      if (af) afParts.push(af);
    } else {
      log("unknown_motion_effect_skipped", { name: spec.motion });
    }
  }

  if (spec?.colorGrade) {
    const grade = COLOR_GRADES[spec.colorGrade];
    if (grade) vfParts.push(grade);
    else log("unknown_color_grade_skipped", { name: spec.colorGrade });
  }

  if (Array.isArray(spec?.overlays)) {
    for (const name of spec.overlays) {
      const ov = OVERLAY_EFFECTS[name];
      if (ov) vfParts.push(ov);
      else log("unknown_overlay_skipped", { name });
    }
  }

  return { vf: vfParts.join(","), af: afParts.join(",") };
};

const applyClipEffects = async (input, output, spec, jobId, webhook) => {
  const hasEffects = spec && (spec.motion || spec.colorGrade || (spec.overlays && spec.overlays.length));
  if (!hasEffects) {
    fs.copyFileSync(input, output);
    return;
  }

  const duration = await getDuration(input);
  const { vf, af } = buildEffectFilterChain(spec, duration);

  const args = ["-i", input];
  if (vf) args.push("-vf", vf);
  args.push(...videoEncodeArgs());
  if (af) {
    args.push("-af", af, "-c:a", "aac");
  } else {
    args.push("-c:a", "copy");
  }
  args.push(output);

  await runFFmpeg(args, jobId, webhook);
};

// A transition is rendered in one filter graph and one encode. The old
// pairwise implementation encoded clip 1+2, then encoded that result with
// clip 3, and so on. Besides being slow, that repeatedly re-compressed the
// accumulated video and could make output size grow dramatically.
const composeCutTransition = async (normalized, outputPath, jobId, webhook, transitionName, transitionDuration) => {
  if (normalized.length === 1) {
    fs.copyFileSync(normalized[0], outputPath);
    return;
  }

  const durations = await Promise.all(normalized.map(getDuration));
  const requestedDuration = Number(transitionDuration) || 0.5;
  const transitionDurations = durations.slice(1).map((duration, i) =>
    Math.max(0.1, Math.min(requestedDuration, durations[i], duration) / 2)
  );

  let elapsed = durations[0];
  let videoLabel = "[0:v]";
  let audioLabel = "[0:a]";
  const filters = [];

  for (let i = 1; i < normalized.length; i++) {
    const td = transitionDurations[i - 1];
    const nextVideoLabel = `[xfv${i}]`;
    const nextAudioLabel = `[xfa${i}]`;
    const offset = Math.max(0, elapsed - td);

    filters.push(
      `${videoLabel}[${i}:v]xfade=transition=${transitionName}:duration=${td.toFixed(3)}:offset=${offset.toFixed(3)}${nextVideoLabel}`,
      `${audioLabel}[${i}:a]acrossfade=d=${td.toFixed(3)}${nextAudioLabel}`
    );

    videoLabel = nextVideoLabel;
    audioLabel = nextAudioLabel;
    elapsed += durations[i] - td;
  }

  await runFFmpeg([
    ...normalized.flatMap(c => ["-i", c]),
    "-filter_complex", filters.join(";"),
    "-map", videoLabel,
    "-map", audioLabel,
    ...videoEncodeArgs(TRANSITION_VIDEO_PRESET),
    "-c:a", "aac",
    outputPath
  ], jobId, webhook);
};

const composeCutOrTransition = async (normalized, outputPath, jobId, webhook, opts = {}) => {
  if (opts.transition && TRANSITIONS.includes(opts.transition) && normalized.length > 1) {
    return composeCutTransition(normalized, outputPath, jobId, webhook, opts.transition, opts.transitionDuration);
  }
  return composeCut(normalized, outputPath, jobId, webhook);
};

const composeGrid4 = async (normalized, outputPath, jobId, webhook) => {
  const halfW = Math.floor(OUTPUT_WIDTH / 2);
  const halfH = Math.floor(OUTPUT_HEIGHT / 2);

  const filter =
    `[0:v]scale=${halfW}:${halfH}[tl];` +
    `[1:v]scale=${halfW}:${halfH}[tr];` +
    `[2:v]scale=${halfW}:${halfH}[bl];` +
    `[3:v]scale=${halfW}:${halfH}[br];` +
    `[tl][tr]hstack=inputs=2[top];` +
    `[bl][br]hstack=inputs=2[bottom];` +
    `[top][bottom]vstack=inputs=2[outv];` +
    `[0:a][1:a][2:a][3:a]amix=inputs=4:duration=shortest:dropout_transition=0[outa]`;

  await runFFmpeg([
    ...normalized.slice(0, 4).flatMap(c => ["-i", c]),
    "-filter_complex", filter,
    "-map", "[outv]",
    "-map", "[outa]",
    ...videoEncodeArgs(),
    "-c:a", "aac",
    outputPath
  ], jobId, webhook);
};

const composeTriptych = async (normalized, outputPath, jobId, webhook) => {
  const colW = Math.floor(OUTPUT_WIDTH / 3);

  const filter =
    `[0:v]scale=${colW}:${OUTPUT_HEIGHT}[a];` +
    `[1:v]scale=${colW}:${OUTPUT_HEIGHT}[b];` +
    `[2:v]scale=${OUTPUT_WIDTH - colW * 2}:${OUTPUT_HEIGHT}[c];` +
    `[a][b][c]hstack=inputs=3[outv];` +
    `[0:a][1:a][2:a]amix=inputs=3:duration=shortest:dropout_transition=0[outa]`;

  await runFFmpeg([
    ...normalized.slice(0, 3).flatMap(c => ["-i", c]),
    "-filter_complex", filter,
    "-map", "[outv]",
    "-map", "[outa]",
    ...videoEncodeArgs(),
    "-c:a", "aac",
    outputPath
  ], jobId, webhook);
};

const composePipCustom = async (normalized, outputPath, jobId, webhook, opts = {}) => {
  const [base, pip] = normalized;
  const scale = opts.pipScale || OVERLAY_SCALE;
  const boxW = Math.round(OUTPUT_WIDTH * scale);
  const boxH = Math.round(OUTPUT_HEIGHT * scale);
  const corner = opts.pipCorner || "bottom-right";

  const positions = {
    "top-left": [OVERLAY_MARGIN, OVERLAY_MARGIN],
    "top-right": [OUTPUT_WIDTH - boxW - OVERLAY_MARGIN, OVERLAY_MARGIN],
    "bottom-left": [OVERLAY_MARGIN, OUTPUT_HEIGHT - boxH - OVERLAY_MARGIN],
    "bottom-right": [OUTPUT_WIDTH - boxW - OVERLAY_MARGIN, OUTPUT_HEIGHT - boxH - OVERLAY_MARGIN],
    "center": [Math.round((OUTPUT_WIDTH - boxW) / 2), Math.round((OUTPUT_HEIGHT - boxH) / 2)]
  };
  const [x, y] = positions[corner] || positions["bottom-right"];

  const useAmix = !!opts.pipAudio;
  const filter = useAmix
    ? `[1:v]scale=${boxW}:${boxH}[pv];[0:v][pv]overlay=${x}:${y}[outv];[0:a][1:a]amix=inputs=2:duration=first:dropout_transition=0[outa]`
    : `[1:v]scale=${boxW}:${boxH}[pv];[0:v][pv]overlay=${x}:${y}[outv]`;

  await runFFmpeg([
    "-i", base,
    "-i", pip,
    "-filter_complex", filter,
    "-map", "[outv]",
    "-map", useAmix ? "[outa]" : "0:a",
    ...videoEncodeArgs(),
    "-c:a", "aac",
    outputPath
  ], jobId, webhook);
};

const buildFinalFilterChain = (opts = {}) => {
  const vfParts = [];
  if (opts.finalColorGrade && COLOR_GRADES[opts.finalColorGrade]) {
    vfParts.push(COLOR_GRADES[opts.finalColorGrade]);
  } else if (opts.finalColorGrade) {
    log("unknown_final_color_grade_skipped", { name: opts.finalColorGrade });
  }
  if (Array.isArray(opts.finalOverlays)) {
    for (const name of opts.finalOverlays) {
      const ov = OVERLAY_EFFECTS[name];
      if (ov) vfParts.push(ov);
      else log("unknown_final_overlay_skipped", { name });
    }
  }
  if (opts.textOverlay?.text) {
    vfParts.push(buildDrawText(opts.textOverlay));
  }
  return vfParts.join(",");
};

const applyFinalEffects = async (input, output, opts, jobId, webhook) => {
  const chain = buildFinalFilterChain(opts);
  if (!chain) {
    // Intermediate files skip faststart; do one cheap final remux instead of
    // relocating the MP4 metadata after every pipeline stage.
    await runFFmpeg([
      "-i", input,
      "-c", "copy",
      "-movflags", "+faststart",
      output
    ], jobId, webhook);
    return;
  }
  await runFFmpeg([
    "-i", input,
    "-vf", chain,
    ...videoEncodeArgs(),
    "-c:a", "copy",
    "-movflags", "+faststart",
    output
  ], jobId, webhook);
};

const resolveComposer = (layout, clipCount, opts = {}) => {
  switch (layout) {
    case "split":
      if (clipCount !== 2) {
        log("split_layout_wrong_clip_count_falling_back_to_cut", { clipCount });
        return { fn: (n, o, j, w) => composeCutOrTransition(n, o, j, w, opts), usedLayout: "cut" };
      }
      return { fn: composeSplit, usedLayout: "split" };
    case "overlay":
      return { fn: composeOverlay, usedLayout: "overlay" };
    case "zoom":
      return { fn: composeZoom, usedLayout: "zoom" };
    case "grid4":
      if (clipCount !== 4) {
        log("grid4_layout_wrong_clip_count_falling_back_to_cut", { clipCount });
        return { fn: (n, o, j, w) => composeCutOrTransition(n, o, j, w, opts), usedLayout: "cut" };
      }
      return { fn: composeGrid4, usedLayout: "grid4" };
    case "triptych":
      if (clipCount !== 3) {
        log("triptych_layout_wrong_clip_count_falling_back_to_cut", { clipCount });
        return { fn: (n, o, j, w) => composeCutOrTransition(n, o, j, w, opts), usedLayout: "cut" };
      }
      return { fn: composeTriptych, usedLayout: "triptych" };
    case "pip":
      if (clipCount !== 2) {
        log("pip_layout_wrong_clip_count_falling_back_to_cut", { clipCount });
        return { fn: (n, o, j, w) => composeCutOrTransition(n, o, j, w, opts), usedLayout: "cut" };
      }
      return { fn: (n, o, j, w) => composePipCustom(n, o, j, w, opts), usedLayout: "pip" };
    case "cut":
    default:
      return { fn: (n, o, j, w) => composeCutOrTransition(n, o, j, w, opts), usedLayout: "cut" };
  }
};

const LAYOUTS = ["cut", "overlay", "split", "zoom", "grid4", "triptych", "pip"];

const parseClipEntry = (entry) => {
  if (typeof entry === "string") return { url: entry, effects: null };
  return {
    url: entry.url,
    effects: {
      motion: entry.motion || null,
      colorGrade: entry.colorGrade || null,
      overlays: Array.isArray(entry.overlays) ? entry.overlays : []
    }
  };
};

// ================= CLOUDINARY UPLOAD =================
const uploadToCloudinary = (outputPath, uploadFolder) => {
  return new Promise((resolve, reject) => {
    if (!CLOUDINARY_CONFIGURED) {
      return reject(new Error('[FFmpegService] Cloudinary is not configured on the external FFmpeg service.'));
    }
    if (!fs.existsSync(outputPath)) {
      return reject(new Error(`Upload source missing: ${outputPath}`));
    }
    const size = fs.statSync(outputPath).size;
    if (size === 0) {
      return reject(new Error(`Upload source is empty: ${outputPath}`));
    }

    log("cloudinary_upload_start", { path: outputPath, sizeBytes: size, folder: uploadFolder });

    cloudinary.uploader.upload_large(
      outputPath,
      {
        resource_type: "video",
        folder: uploadFolder,
        chunk_size: CLOUDINARY_CHUNK_SIZE,
        timeout: CLOUDINARY_UPLOAD_TIMEOUT
      },
      (err, result) => {
        if (err) {
          log("cloudinary_upload_failed", {
            error: err.message,
            http_code: err.http_code,
            name: err.name,
            configured: CLOUDINARY_CONFIGURED
          });
          const httpCode = err?.http_code || err?.response?.status;
          return reject(new Error(
            `[FFmpegService] Cloudinary upload failed${httpCode ? ` HTTP ${httpCode}` : ''}: ${err?.message || 'request failed'}`
          ));
        }
        log("cloudinary_upload_done", { url: result.secure_url, bytes: result.bytes });
        resolve(result);
      }
    );
  });
};

const uploadImageToCloudinary = (imagePath, uploadFolder, publicId) => {
  return new Promise((resolve, reject) => {
    cloudinary.uploader.upload(
      imagePath,
      {
        resource_type: "image",
        folder: uploadFolder,
        public_id: publicId,
        overwrite: true
      },
      (err, result) => {
        if (err) return reject(err);
        resolve(result);
      }
    );
  });
};

const extractVideoFrames = async (videoPath, outputDir, jobId) => {
  const duration = await getDuration(videoPath);
  const firstFramePath = path.join(outputDir, "first.jpg");
  const lastFramePath = path.join(outputDir, "last.jpg");

  // The first frame is decoded from the beginning. For the last frame, seek
  // into the final second, reverse that short tail, and select its first
  // frame. This avoids decoding the entire video while returning the actual
  // ending image rather than the first frame after the seek point.
  await runFFmpeg([
    "-i", videoPath,
    "-vf", "select=eq(n\\,0)",
    "-frames:v", "1",
    "-q:v", "2",
    firstFramePath
  ], jobId);

  await runFFmpeg([
    "-sseof", "-1",
    "-i", videoPath,
    "-vf", "reverse,select=eq(n\\,0)",
    "-frames:v", "1",
    "-q:v", "2",
    lastFramePath
  ], jobId);

  return {
    firstFramePath,
    lastFramePath,
    duration,
    lastFrameTimestamp: Math.max(0, duration - 1)
  };
};

const getFileSize = file => fs.statSync(file).size;

// Direct stream-copy merges can preserve the sum of the source bitrates and
// exceed Cloudinary's 100 MB limit. Re-encode only when necessary. The first
// pass keeps the same CRF/resolution/FPS, but uses a better compression preset
// than the ultrafast delivery encoder. A bitrate-capped second pass is only
// used when that still cannot fit under the hard limit.
const prepareUploadFile = async (inputPath, tempDir, jobId, webhook) => {
  const inputSize = getFileSize(inputPath);
  if (inputSize <= CLOUDINARY_TARGET_FILE_SIZE) return inputPath;

  const compressedPath = path.join(tempDir, "upload-compressed.mp4");
  updateJob(jobId, { step: "compressing_for_upload" });
  log("upload_size_limit_reencode_start", {
    jobId,
    inputBytes: inputSize,
    targetBytes: CLOUDINARY_TARGET_FILE_SIZE,
    maxBytes: CLOUDINARY_MAX_FILE_SIZE,
    crf: UPLOAD_FALLBACK_CRF
  });

  await runFFmpeg([
    "-i", inputPath,
    ...videoEncodeArgs(UPLOAD_VIDEO_PRESET, { includeCrf: false }),
    "-crf", String(UPLOAD_FALLBACK_CRF),
    "-c:a", "aac",
    "-b:a", "128k",
    "-movflags", "+faststart",
    compressedPath
  ], jobId, webhook);

  let compressedSize = getFileSize(compressedPath);
  if (compressedSize <= CLOUDINARY_TARGET_FILE_SIZE) {
    log("upload_size_limit_reencode_done", { jobId, outputBytes: compressedSize });
    return compressedPath;
  }

  // A constrained bitrate provides a deterministic upper bound. Reserve
  // audio/container room and target 98 MB rather than the 100 MB hard limit.
  const duration = await getDuration(inputPath);
  const targetVideoBitrate = Math.max(
    100000,
    Math.floor((CLOUDINARY_TARGET_FILE_SIZE * 8) / duration) - 160000
  );
  const cappedPath = path.join(tempDir, "upload-capped.mp4");
  log("upload_size_limit_bitrate_cap_start", {
    jobId,
    durationSeconds: duration,
    targetVideoBitrate
  });

  await runFFmpeg([
    "-i", inputPath,
    ...videoEncodeArgs(UPLOAD_VIDEO_PRESET, { includeCrf: false }),
    "-b:v", String(targetVideoBitrate),
    "-maxrate", String(targetVideoBitrate),
    "-bufsize", String(targetVideoBitrate * 2),
    "-c:a", "aac",
    "-b:a", "128k",
    "-movflags", "+faststart",
    cappedPath
  ], jobId, webhook);

  compressedSize = getFileSize(cappedPath);
  if (compressedSize > CLOUDINARY_MAX_FILE_SIZE) {
    throw new Error(`Unable to reduce output below Cloudinary's 100 MB limit (got ${compressedSize} bytes)`);
  }

  log("upload_size_limit_bitrate_cap_done", { jobId, outputBytes: compressedSize });
  return cappedPath;
};

// ================= SHARED JOB PIPELINE =================
const runClipJob = ({
  requestId,
  clips,
  webhook,
  minClips,
  maxClips,
  sortClips,
  composerFor,
  uploadFolder,
  opts = {},
  allowDirectConcat = false
}) => {
  jobLimit(async () => {
    let tempDir;

    try {
      await sendWebhook(webhook, { jobId: requestId, status: "started" });
      updateJob(requestId, { status: "processing" });

      if (!clips || clips.length < minClips) {
        throw new Error(`Need at least ${minClips} clip(s)`);
      }
      if (clips.length > maxClips) throw new Error("Too many clips");

      const parsed = clips.map(parseClipEntry);
      const ordered = sortClips
        ? [...parsed].sort((a, b) => extractTrailingNumber(a.url) - extractTrailingNumber(b.url))
        : parsed;

      tempDir = path.join(TMP_ROOT, requestId);
      fs.mkdirSync(tempDir, { recursive: true });

      // ================= DOWNLOAD =================
      updateJob(requestId, { step: "downloading" });
      const dlLimit = pLimit(DOWNLOAD_CONCURRENCY);
      const localClips = await Promise.all(
        ordered.map((clip, i) =>
          dlLimit(async () => {
            const file = path.join(tempDir, `clip_${i}.mp4`);
            await downloadFile(clip.url, file);
            return file;
          })
        )
      );

      const composedPath = path.join(tempDir, "composed.mp4");
      let normalized = [];
      let usedLayout;
      let composedDirectly = false;

      const hasClipEffects = ordered.some(clip => {
        const effects = clip.effects;
        return effects && (
          effects.motion ||
          effects.colorGrade ||
          (Array.isArray(effects.overlays) && effects.overlays.length > 0)
        );
      });
      const hasFinalEffects =
        opts.finalColorGrade ||
        (Array.isArray(opts.finalOverlays) && opts.finalOverlays.length > 0) ||
        opts.textOverlay?.text;

      // ================= DIRECT STREAM-COPY MERGE =================
      // This is the fast path for the common merge/cut case. It preserves
      // the downloaded source files until concat succeeds so fallback remains
      // safe when inputs differ in codec, dimensions, timestamps, or audio.
      if (allowDirectConcat && !hasClipEffects && !hasFinalEffects && !opts.transition) {
        updateJob(requestId, { step: "merging_stream_copy" });
        composedDirectly = await tryDirectConcat(localClips, composedPath, requestId, webhook);
        if (composedDirectly) usedLayout = "cut";
      }

      if (!composedDirectly) {
        updateJob(requestId, { step: "normalizing" });

        // ================= NORMALIZE =================
        // Delete each source clip after normalization to keep disk/RAM usage
        // bounded on platforms where the temp directory is memory-backed.
        const normalizedRaw = [];
        for (let i = 0; i < localClips.length; i++) {
          const out = path.join(tempDir, `norm_${i}.mp4`);
          await normalizeClip(localClips[i], out, requestId, webhook);
          fs.rmSync(localClips[i], { force: true });
          normalizedRaw.push(out);
        }

        // ================= PER-CLIP EFFECTS =================
        updateJob(requestId, { step: "applying_effects" });
        for (let i = 0; i < normalizedRaw.length; i++) {
          const out = path.join(tempDir, `fx_${i}.mp4`);
          await applyClipEffects(normalizedRaw[i], out, ordered[i].effects, requestId, webhook);
          fs.rmSync(normalizedRaw[i], { force: true });
          normalized.push(out);
        }

        updateJob(requestId, { step: "composing" });

        // ================= COMPOSE =================
        const { fn: composeFn, usedLayout: layoutUsed } = composerFor(normalized.length);
        usedLayout = layoutUsed;
        await composeFn(normalized, composedPath, requestId, webhook);
        for (const f of normalized) fs.rmSync(f, { force: true });
      } else {
        for (const f of localClips) fs.rmSync(f, { force: true });
      }

      // ================= FINAL EFFECTS =================
      updateJob(requestId, { step: "finalizing" });
      const outputPath = path.join(tempDir, "output.mp4");
      await applyFinalEffects(composedPath, outputPath, opts, requestId, webhook);
      fs.rmSync(composedPath, { force: true });

      updateJob(requestId, { step: "uploading" });

      // ================= SIZE-AWARE CLOUDINARY UPLOAD =================
      // Avoid spending up to the full upload timeout on a file Cloudinary
      // will reject immediately because it is over the 100 MB limit.
      const uploadPath = await prepareUploadFile(outputPath, tempDir, requestId, webhook);
      const upload = await uploadToCloudinary(uploadPath, uploadFolder);

      fs.rmSync(tempDir, { recursive: true, force: true });

      const result = {
        jobId: requestId,
        status: "done",
        url: upload.secure_url,
        duration: upload.duration,
        bytes: upload.bytes,
        layout: usedLayout,
        _completedAt: Date.now()
      };

      jobs.set(requestId, { ...jobs.get(requestId), ...result });
      await sendWebhook(webhook, result);

    } catch (err) {
      const failedJob = jobs.get(requestId);
      const step = failedJob?.step || 'unknown';
      const failPayload = {
        jobId: requestId,
        status: "failed",
        step,
        error: `[${step}] ${getErrorMessage(err)}`,
        _completedAt: Date.now()
      };

      jobs.set(requestId, { ...jobs.get(requestId), ...failPayload });
      await sendWebhook(webhook, failPayload);

      if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });
};

// ================= ROUTES =================
app.get("/", (_, res) => res.send("FFmpeg service running 🚀"));
app.get("/health", (_, res) => res.json({ ok: true }));

app.get("/status/:id", auth, (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) return res.status(404).json({ error: "Not found" });
  res.json(publicJob(job));
});

app.get("/jobs", auth, (_, res) => {
  res.json([...jobs.values()].map(publicJob));
});

app.get("/effects", auth, (_, res) => {
  res.json({
    layouts: LAYOUTS,
    transitions: TRANSITIONS,
    motionEffects: Object.keys(MOTION_EFFECTS),
    colorGrades: Object.keys(COLOR_GRADES),
    overlays: Object.keys(OVERLAY_EFFECTS)
  });
});

app.get("/diagnostics", auth, (_, res) => {
  res.json({
    ok: true,
    ffmpegAuthConfigured: API_KEYS.length > 0,
    cloudinaryConfigured: CLOUDINARY_CONFIGURED,
    cloudinary: {
      cloudNameConfigured: Boolean(CLOUDINARY_CONFIG.cloudName),
      apiKeyConfigured: Boolean(CLOUDINARY_CONFIG.apiKey),
      apiSecretConfigured: Boolean(CLOUDINARY_CONFIG.apiSecret)
    }
  });
});

// ================= CONTINUITY FRAMES =================
// Returns hosted still images that a video generator can use as visual
// references for the next shot. The source video is deleted after extraction;
// only the Cloudinary image assets remain.
app.post("/frames", auth, async (req, res) => {
  const requestId = uuidv4();
  const videoUrl = req.body?.videoUrl || req.body?.url;

  if (!videoUrl || typeof videoUrl !== "string") {
    return res.status(400).json({ error: "videoUrl is required" });
  }

  const tempDir = path.join(TMP_ROOT, `frames-${requestId}`);
  const videoPath = path.join(tempDir, "source.mp4");
  const frameDir = path.join(tempDir, "frames");
  const folder = typeof req.body?.folder === "string" && req.body.folder.trim()
    ? req.body.folder.trim()
    : "ai-movies/continuity-frames";

  try {
    fs.mkdirSync(frameDir, { recursive: true });
    await downloadFile(videoUrl, videoPath);
    const frames = await extractVideoFrames(videoPath, frameDir, requestId);
    const publicPrefix = `continuity-${requestId}`;
    const [first, last] = await Promise.all([
      uploadImageToCloudinary(frames.firstFramePath, folder, `${publicPrefix}-first`),
      uploadImageToCloudinary(frames.lastFramePath, folder, `${publicPrefix}-last`)
    ]);

    log("continuity_frames_done", {
      jobId: requestId,
      durationSeconds: frames.duration,
      folder
    });

    res.json({
      jobId: requestId,
      durationSeconds: frames.duration,
      firstFrameUrl: first.secure_url,
      lastFrameUrl: last.secure_url,
      firstFramePublicId: first.public_id,
      lastFramePublicId: last.public_id,
      lastFrameTimestamp: frames.lastFrameTimestamp
    });
  } catch (err) {
    log("continuity_frames_failed", { jobId: requestId, error: err.message });
    res.status(500).json({ error: err.message });
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

// ================= MERGE =================
app.post("/merge", auth, (req, res) => {
  const requestId = uuidv4();
  jobs.set(requestId, { id: requestId, status: "queued", progress: 0 });

  const { clips, webhook, transition, transitionDuration, finalColorGrade, finalOverlays, textOverlay } = req.body;

  if (transition && !TRANSITIONS.includes(transition)) {
    jobs.set(requestId, { id: requestId, status: "failed", error: `Unknown transition '${transition}'` });
    return res.status(400).json({ error: "Invalid transition" });
  }

  const opts = { transition, transitionDuration, finalColorGrade, finalOverlays, textOverlay };

  runClipJob({
    requestId,
    clips,
    webhook,
    minClips: 2,
    maxClips: MAX_CLIPS,
    sortClips: true,
    composerFor: (clipCount) => resolveComposer("cut", clipCount, opts),
    uploadFolder: "ai-movies/episodes",
    opts,
    allowDirectConcat: true
  });

  res.json({ jobId: requestId, statusUrl: `/status/${requestId}` });
});

// ================= COMPOSE =================
app.post("/compose", auth, (req, res) => {
  const requestId = uuidv4();
  jobs.set(requestId, { id: requestId, status: "queued", progress: 0 });

  const {
    clips, webhook,
    transition, transitionDuration,
    pipCorner, pipScale, pipAudio,
    finalColorGrade, finalOverlays, textOverlay
  } = req.body;
  const layout = (req.body.layout || "cut").toLowerCase();

  if (!LAYOUTS.includes(layout)) {
    jobs.set(requestId, {
      id: requestId,
      status: "failed",
      error: `Unknown layout '${layout}'. Expected one of: ${LAYOUTS.join(", ")}.`
    });
    return res.status(400).json({ error: "Invalid layout" });
  }

  if (transition && !TRANSITIONS.includes(transition)) {
    jobs.set(requestId, { id: requestId, status: "failed", error: `Unknown transition '${transition}'` });
    return res.status(400).json({ error: "Invalid transition" });
  }

  const opts = { transition, transitionDuration, pipCorner, pipScale, pipAudio, finalColorGrade, finalOverlays, textOverlay };

  const minClipsByLayout = { zoom: 1, split: 2, pip: 2, grid4: 4, triptych: 3, overlay: 2, cut: 2 };

  runClipJob({
    requestId,
    clips,
    webhook,
    minClips: minClipsByLayout[layout] ?? 2,
    maxClips: MAX_CLIPS,
    sortClips: true,
    composerFor: (clipCount) => resolveComposer(layout, clipCount, opts),
    uploadFolder: "ai-movies/scenes",
    opts,
    allowDirectConcat: layout === "cut"
  });

  res.json({ jobId: requestId, statusUrl: `/status/${requestId}` });
});

// ================= START =================
app.listen(PORT, () => {
  console.log(
    `🚀 Server running on port ${PORT} ` +
    `(MAX_CONCURRENT_JOBS=${MAX_CONCURRENT_JOBS}, ` +
    `FFMPEG_THREADS=${FFMPEG_THREADS}, TMP_ROOT=${TMP_ROOT}, ` +
    `OUTPUT=${OUTPUT_WIDTH}x${OUTPUT_HEIGHT}@${OUTPUT_FPS}, ` +
    `VIDEO_CRF=${VIDEO_CRF}, VIDEO_PRESET=${VIDEO_PRESET})`
  );
});
