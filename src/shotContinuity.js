'use strict';

/**
 * ============================================================================
 * StreamVerse Studio — Shared Shot Continuity Module
 * ============================================================================
 *
 * Provider-agnostic first/last-frame continuity contract, shared by every
 * video backend that supports keyframe/frame conditioning (Agnes V2 keyframe
 * mode, LTX-2.3 First-Last-Frame). Originally lived only inside
 * agnesVideoGen.js; extracted so LTX gets the exact same continuity
 * guarantees instead of a parallel, drifting reimplementation.
 *
 * Contract:
 *   - `resolveContinuityStartingImage()` looks up the previous shot's exact
 *     terminal frame (if any) and returns an ORDERED reference-buffer pair
 *     [predecessor_end_frame, fresh_current_shot_still]. Order is meaningful
 *     and must never be reversed — index 0 is always the continuity anchor
 *     (keyframe / first_image), the last entry is always the settled target
 *     state (keyframe / last_image).
 *   - `retrieveContinuityFrames()` extracts the first/last frame of a
 *     just-completed clip via the shared FFmpeg service.
 *   - `persistContinuityFrames()` stores those frames keyed by
 *     episode/scene/shot so the NEXT shot (regardless of which provider
 *     generates it) can resolve its own predecessor frame.
 * ============================================================================
 */

const config = require('./config');
const db = require('./db');

const CONTINUITY_FOLDER = process.env.AGNES_CONTINUITY_FRAME_FOLDER || 'ai-movies/continuity-frames';

let _continuitySchemaReady = false;
const _continuityFrameCache = new Map();

async function ensureContinuitySchema() {
  if (_continuitySchemaReady) return;
  await db.execute(`
    CREATE TABLE IF NOT EXISTS shot_continuity_frames (
      episode_id VARCHAR(191) NOT NULL,
      scene_number INT NOT NULL,
      shot_index INT NOT NULL,
      video_url TEXT NULL,
      first_frame_url TEXT NULL,
      last_frame_url TEXT NULL,
      duration_seconds DOUBLE NULL,
      last_frame_timestamp DOUBLE NULL,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      PRIMARY KEY (episode_id, scene_number, shot_index),
      KEY idx_shot_continuity_order (episode_id, scene_number, shot_index)
    )
  `);
  _continuitySchemaReady = true;
}

async function _latestDraftEpisode() {
  return db.queryOne(`SELECT id FROM episodes WHERE status = 'draft' ORDER BY created_at DESC LIMIT 1`);
}

async function currentShotContext() {
  const episode = await _latestDraftEpisode();
  if (!episode?.id) return null;
  return db.queryOne(
    `SELECT episode_id, scene_number, shot_index, image_url, mh_job_id
       FROM shots
      WHERE episode_id = ?
        AND status IN ('pending', 'mh_submitted', 'failed')
      ORDER BY scene_number ASC, shot_index ASC
      LIMIT 1`,
    [episode.id]
  );
}

function _resolveFrameServiceCredentials() {
  const serviceUrl = String(process.env.FFMPEG_SERVICE_URL || config.ffmpegServiceUrl || '').replace(/\/+$/, '');
  const apiKey = String(
    process.env.FFMPEG_SERVICE_API_KEY ||
    config.ffmpegApiKey ||
    process.env.FFMPEG_API_KEY ||
    ''
  ).trim();
  return { serviceUrl, apiKey };
}

/**
 * Extract the exact first/last frame of a just-completed clip.
 * `label` is used only for error messages (e.g. 'AgnesVideoGen', 'LTXVideoGen').
 */
async function retrieveContinuityFrames(videoUrl, label = 'ShotContinuity') {
  const { serviceUrl, apiKey } = _resolveFrameServiceCredentials();
  if (!serviceUrl) throw new Error(`[${label}] FFMPEG_SERVICE_URL is required for shot continuity frames.`);
  if (!apiKey) throw new Error(`[${label}] No FFmpeg service API key configured. Set FFMPEG_API_KEY (existing StreamVerse secret) or FFMPEG_SERVICE_API_KEY.`);
  if (!videoUrl) throw new Error(`[${label}] Cannot extract continuity frames without a completed video URL.`);

  const cached = _continuityFrameCache.get(videoUrl);
  if (cached?.lastFrameUrl) return cached;

  let lastError = null;
  for (let attempt = 1; attempt <= 4; attempt++) {
    try {
      const response = await fetch(`${serviceUrl}/frames`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey },
        body: JSON.stringify({ videoUrl, folder: CONTINUITY_FOLDER }),
      });
      const raw = await response.text();
      let result = {};
      try { result = raw ? JSON.parse(raw) : {}; } catch (_) {}
      if (!response.ok) throw new Error(`Frame retrieval failed: ${result.error || response.statusText || `HTTP ${response.status}`}`);
      if (!result.firstFrameUrl || !result.lastFrameUrl) throw new Error('Frame retrieval response is missing firstFrameUrl or lastFrameUrl.');

      const continuity = {
        firstFrameUrl: String(result.firstFrameUrl),
        lastFrameUrl: String(result.lastFrameUrl),
        durationSeconds: Number(result.durationSeconds) || null,
        lastFrameTimestamp: Number(result.lastFrameTimestamp) || null,
      };
      _continuityFrameCache.set(videoUrl, continuity);
      return continuity;
    } catch (err) {
      lastError = err;
      if (attempt < 4) await new Promise(resolve => setTimeout(resolve, Math.min(8000, 1000 * (2 ** (attempt - 1)))));
    }
  }
  throw lastError || new Error(`[${label}] Continuity frame extraction failed.`);
}

async function persistContinuityFrames(videoUrl, continuity, jobId = null, label = 'ShotContinuity') {
  await ensureContinuitySchema();
  const current = jobId
    ? await db.queryOne(`SELECT episode_id, scene_number, shot_index, image_url FROM shots WHERE mh_job_id = ? ORDER BY updated_at DESC LIMIT 1`, [jobId])
    : await currentShotContext();
  if (!current?.episode_id) throw new Error(`[${label}] Could not identify the exact shot row for completed job continuity persistence.`);

  await db.execute(
    `INSERT INTO shot_continuity_frames
      (episode_id, scene_number, shot_index, video_url, first_frame_url, last_frame_url, duration_seconds, last_frame_timestamp)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE video_url=VALUES(video_url), first_frame_url=VALUES(first_frame_url), last_frame_url=VALUES(last_frame_url), duration_seconds=VALUES(duration_seconds), last_frame_timestamp=VALUES(last_frame_timestamp), updated_at=NOW()`,
    [current.episode_id, Number(current.scene_number), Number(current.shot_index), videoUrl, continuity.firstFrameUrl, continuity.lastFrameUrl, continuity.durationSeconds, continuity.lastFrameTimestamp]
  );
  console.log(`[${label}] Continuity frames persisted | S${current.scene_number}/idx${current.shot_index} first=${continuity.firstFrameUrl} last=${continuity.lastFrameUrl}`);
  return continuity;
}

async function downloadReferenceBuffer(url, label = 'reference frame', logPrefix = 'ShotContinuity') {
  const target = String(url || '').trim();
  if (!/^https?:\/\//i.test(target)) {
    throw new Error(`[${logPrefix}] Invalid ${label} URL`);
  }
  const response = await fetch(target);
  if (!response.ok) {
    throw new Error(`[${logPrefix}] Failed to download ${label}: HTTP ${response.status}`);
  }
  const arrayBuffer = await response.arrayBuffer();
  const buffer = Buffer.from(arrayBuffer);
  if (!buffer.length) throw new Error(`[${logPrefix}] ${label} is empty`);
  return buffer;
}

/**
 * Provider-agnostic continuity resolution shared by Agnes keyframe mode and
 * the LTX-2.3 First-Last-Frame provider. Ordered keyframe contract:
 *   [0]  = predecessor's exact terminal frame (continuity anchor / first_image)
 *   last = the freshly rendered current-shot still (settled target / last_image)
 * This pair is never reversed and the predecessor frame is never used as the
 * canvas the current still is generated FROM — only as continuity evidence.
 */
async function resolveContinuityStartingImage(imageBuffer, shotMeta = {}, logPrefix = 'ShotContinuity') {
  if (!Buffer.isBuffer(imageBuffer) || imageBuffer.length === 0) {
    throw new Error(`[${logPrefix}] Current shot image is empty.`);
  }

  const previousEndFrameUrl = String(
    shotMeta.continuityLastFrameUrl || shotMeta.visionPreviousEndFrameUrl || ''
  ).trim();

  if (!previousEndFrameUrl) {
    return {
      imageBuffer,
      referenceImageBuffers: [imageBuffer],
      usedContinuityFrame: false,
      continuityLastFrameUrl: null,
      predecessor: null,
    };
  }

  const predecessorBuffer = await downloadReferenceBuffer(
    previousEndFrameUrl,
    'previous-shot terminal frame',
    logPrefix
  );

  return {
    imageBuffer,
    referenceImageBuffers: [predecessorBuffer, imageBuffer],
    usedContinuityFrame: true,
    continuityLastFrameUrl: previousEndFrameUrl,
    predecessor: { url: previousEndFrameUrl, buffer: predecessorBuffer },
  };
}

function sceneAnchorForStillAudit(shot = {}, sceneAnchorStillUrl = '') {
  // Shot 1 is the scene anchor. On a resumed attempt, its saved still can be
  // the same asset as the current still, so comparing it against itself is not
  // a meaningful continuity test. Keep auditing identity/wardrobe against the
  // shot contract, but do not pass a scene-anchor image for this shot.
  if (Number(shot?.shot_index ?? shot?.shotIndex) === 1) return null;
  const anchorUrl = String(sceneAnchorStillUrl || '').trim();
  return anchorUrl || null;
}

/**
 * Shared transition-window contract: how much of the generated clip's
 * opening should be dedicated to physically resolving the bridge from the
 * predecessor's terminal frame into the current shot's settled still before
 * the shot's own authored action takes over. Equally binding on every
 * provider/layer that authors or renders a continuity-bridged shot.
 *
 * When `shotDurationSeconds` is supplied, the window is clamped so it never
 * claims more than ~60% of the shot's own runtime — a 3-4s window on a
 * short 2s shot would consume the ENTIRE clip and leave nothing for the
 * shot's own action, which is exactly the "throwaway lead-in" this contract
 * exists to prevent. `fitsWithRemainder` tells the caller whether the full
 * configured window actually fit, so short shots can get different wording
 * instead of an incoherent "then continue for the remainder" when there
 * isn't one.
 */
function transitionWindowSeconds(shotDurationSeconds) {
  const min = Number(config.continuityTransitionMinSeconds) || 3;
  const max = Number(config.continuityTransitionMaxSeconds) || 4;
  const duration = Number(shotDurationSeconds);

  if (!Number.isFinite(duration) || duration <= 0) {
    return { min, max, mid: (min + max) / 2, fitsWithRemainder: true };
  }

  const cappedMax = Math.min(max, Math.max(1, duration * 0.6));
  const cappedMin = Math.min(min, cappedMax);
  const round1 = (n) => Math.round(n * 10) / 10;

  return {
    min: round1(cappedMin),
    max: round1(cappedMax),
    mid: round1((cappedMin + cappedMax) / 2),
    fitsWithRemainder: cappedMax >= max, // configured window fit without capping
  };
}

/**
 * Render a scene_continuity_bible (see scriptWriter.js CONTINUITY_BIBLE_RULES)
 * into one directive string, shared verbatim by both providers so the axis
 * of action / wardrobe / active props / lighting lock a shot receives never
 * drifts between the LTX and Agnes prompt-authoring paths.
 */
function formatSceneContinuityDirective(sceneBible) {
  if (!sceneBible || typeof sceneBible !== 'object') return '';
  const trimTrailingPeriod = (s) => String(s || '').trim().replace(/\.+$/, '');
  const parts = [];
  if (sceneBible.axis_of_action) {
    parts.push(`Locked screen geography for this scene: ${trimTrailingPeriod(sceneBible.axis_of_action)}. Keep every visible character on their established screen side/eyeline unless this exact shot is an authored line-cross.`);
  }
  if (Array.isArray(sceneBible.wardrobe_lock) && sceneBible.wardrobe_lock.length) {
    parts.push(`Locked wardrobe/props-on-person for this scene: ${sceneBible.wardrobe_lock.map(w => `${w.name}: ${trimTrailingPeriod(w.state)}`).join('; ')}.`);
  }
  if (Array.isArray(sceneBible.active_props) && sceneBible.active_props.length) {
    parts.push(`Active props carried through this scene unless this shot explicitly changes them: ${sceneBible.active_props.map(p => `${p.prop}: ${trimTrailingPeriod(p.state)}`).join('; ')}.`);
  }
  if (sceneBible.lighting_lock) {
    parts.push(`Locked scene lighting: ${trimTrailingPeriod(sceneBible.lighting_lock)}.`);
  }
  if (!parts.length) return '';
  return `SCENE CONTINUITY BIBLE (applies for the WHOLE scene, not just the previous shot): ${parts.join(' ')}`;
}

module.exports = {
  ensureContinuitySchema,
  currentShotContext,
  retrieveContinuityFrames,
  persistContinuityFrames,
  downloadReferenceBuffer,
  resolveContinuityStartingImage,
  sceneAnchorForStillAudit,
  transitionWindowSeconds,
  formatSceneContinuityDirective,
};
