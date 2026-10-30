'use strict';
const axios = require('axios');
const config = require('./config');

function _ffmpegHeaders() {
  const apiKey = String(config.ffmpegApiKey || '').trim();
  if (!apiKey) {
    throw new Error('[Compiler] FFmpeg authentication key is missing. Set FFMPEG_SERVICE_API_KEY (preferred) or FFMPEG_API_KEY to the same secret configured by the FFmpeg service.');
  }
  return {
    'x-api-key': apiKey,
    'Content-Type': 'application/json',
  };
}

/**
 * Final-master source integrity.
 *
 * The caller owns source selection. In particular, the production pipeline
 * validates the authoritative shot rows immediately before the final master
 * merge. Never replace those URLs with persisted scene_state here: scene_state
 * is a preview/cache boundary and may contain an older compiled asset.
 */
function _sourceClips(clips) {
  return (clips || [])
    .map(c => typeof c === 'string' ? c : c?.url)
    .filter(Boolean);
}

/**
 * Wait until the FFmpeg service is actually reachable and its HTTP server is
 * responding to /health. This is readiness-based rather than sleep-based:
 * waking a Replit service can take an unpredictable amount of time, so a
 * fixed "wake and wait N seconds" is never used as proof of availability.
 */
async function waitForFFmpeg({
  // These four config keys were referenced but never defined, which made the
  // timeout `undefined` => `timeoutMs > 0` false => an infinite health loop when
  // the service was down. Always bounded now (config value, else safe default).
  timeoutMs = Number(config.ffmpegReadyTimeoutMs) || 600000,
  initialDelayMs = Number(config.ffmpegReadyInitialDelayMs) || 1000,
  maxDelayMs = Number(config.ffmpegReadyMaxDelayMs) || 10000,
} = {}) {
  if (!config.ffmpegServiceUrl) {
    throw new Error('[Compiler] FFMPEG_SERVICE_URL is not set — cannot reach the FFmpeg service.');
  }
  const startedAt = Date.now();
  let delayMs = Math.max(0, Number(initialDelayMs) || 0);
  let attempt = 0;
  let lastError = null;

  while (true) {
    attempt += 1;

    try {
      const resp = await axios.get(config.ffmpegServiceUrl + '/health', {
        headers: _ffmpegHeaders(),
        timeout: Math.min(30000, Math.max(3000, Number(config.ffmpegHealthRequestTimeoutMs) || 10000)),
        validateStatus: () => true,
      });

      const d = resp.data;
      const healthy = d?.ok === true || /^(ok|healthy|ready|up)$/i.test(String(d?.status || ''));
      if (resp.status >= 200 && resp.status < 300 && healthy) {
        // /health is public; probe an authenticated endpoint before readiness.
        const authProbe = await axios.get(config.ffmpegServiceUrl + '/effects', {
          headers: _ffmpegHeaders(),
          timeout: Math.min(15000, Math.max(3000, Number(config.ffmpegHealthRequestTimeoutMs) || 10000)),
          validateStatus: () => true,
        });
        if (authProbe.status === 401) {
          throw new Error(
            '[Compiler] FFmpeg service health is reachable, but authenticated access is rejected (HTTP 401). ' +
            'Set FFMPEG_SERVICE_API_KEY in StreamVerse to exactly the same secret accepted by the FFmpeg service (API_KEY/FFMPEG_SERVICE_API_KEY/FFMPEG_API_KEY).'
          );
        }
        if (authProbe.status < 200 || authProbe.status >= 300) {
          throw new Error(`FFmpeg authenticated probe returned HTTP ${authProbe.status}`);
        }
        const elapsedMs = Date.now() - startedAt;
        console.log(`[Compiler] FFmpeg ready + authenticated after ${elapsedMs}ms (health attempt ${attempt}).`);
        return resp.data;
      }

      lastError = new Error(`FFmpeg health returned HTTP ${resp.status}`);
    } catch (err) {
      lastError = err;
    }

    const elapsedMs = Date.now() - startedAt;
    if (timeoutMs > 0 && elapsedMs >= timeoutMs) {
      throw new Error(
        `[Compiler] FFmpeg service did not become ready within ${timeoutMs}ms. ` +
        `Last health error: ${lastError?.message || 'unknown error'}`
      );
    }

    console.log(
      `[Compiler] FFmpeg not ready yet (attempt ${attempt}, elapsed ${elapsedMs}ms). ` +
      `Retrying health check in ${delayMs}ms...`
    );

    if (delayMs > 0) await sleep(delayMs);
    delayMs = Math.min(
      Math.max(0, Number(maxDelayMs) || 5000),
      Math.max(250, delayMs > 0 ? delayMs * 1.5 : 250)
    );
  }
}

/**
 * Compatibility wrapper retained for callers that explicitly wake the service.
 * It now waits for an actual successful health response instead of treating a
 * single request or a fixed delay as proof that FFmpeg is ready.
 */
async function wakeFFmpeg() {
  try {
    await waitForFFmpeg();
    console.log('[Compiler] FFmpeg service is ready.');
    return true;
  } catch (err) {
    console.warn('[Compiler] FFmpeg readiness check failed:', err.message);
    return false;
  }
}

// Only "cut" is used now — all visual effects come from Magic Hour's video
// generation. The FFmpeg service is used solely for basic concatenation and
// simple fade transitions during merge.
const VALID_LAYOUTS = new Set(['cut']);
const LAYOUT_FALLBACK_MAP = {
  dissolve: 'cut',
  fade:     'cut',
  crossfade:'cut',
  wipe:     'cut',
  overlay:  'cut',
  split:    'cut',
  zoom:     'cut',
  grid4:    'cut',
  triptych: 'cut',
  pip:      'cut',
};

function resolveLayout(raw) {
  if (!raw) return 'cut';
  const lower = String(raw).toLowerCase();
  if (VALID_LAYOUTS.has(lower)) return lower;
  const mapped = LAYOUT_FALLBACK_MAP[lower];
  if (mapped) {
    console.log(`[Compiler] Layout "${raw}" mapped to "${mapped}" (effects handled by Magic Hour)`);
    return 'cut';
  }
  console.warn(`[Compiler] Unknown layout "${raw}" — defaulting to "cut"`);
  return 'cut';
}

// Only safe transitions that the FFmpeg service can apply during a basic
// concat merge. These are simple cross-fades that don't require complex
// filter chains.
const SAFE_TRANSITIONS = new Set([
  'fade', 'fadeblack', 'fadewhite', 'dissolve',
]);

function _assertNoForeignCloudinaryUrls(clips, context) {
  const currentCloud = String(config.cloudinaryCloudName || '').trim();
  if (!currentCloud) return;
  for (const clip of clips || []) {
    const url = typeof clip === 'string' ? clip : clip?.url;
    if (!url || !/^https?:\/\//i.test(String(url))) continue;
    try {
      const parsed = new URL(String(url));
      const parts = parsed.pathname.split('/').filter(Boolean);
      if (parsed.hostname === 'res.cloudinary.com' && parts[0] && parts[0] !== currentCloud) {
        throw new Error(
          `[Compiler] ${context} received a Cloudinary URL from cloud '${parts[0]}' but StreamVerse is configured for '${currentCloud}'. ` +
          `Refusing to send the foreign/stale asset to FFmpeg.`
        );
      }
    } catch (err) {
      if (err.message.startsWith('[Compiler]')) throw err;
    }
  }
}

function _filterForeignOptionalBumper(url, label) {
  const value = String(url || '').trim();
  if (!value) return null;

  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    return value;
  }

  if (parsed.hostname !== 'res.cloudinary.com') return value;
  const sourceCloud = parsed.pathname.split('/').filter(Boolean)[0] || '';
  const currentCloud = String(config.cloudinaryCloudName || '').trim();
  if (sourceCloud && sourceCloud !== currentCloud) {
    console.warn(
      `[Compiler] Ignoring stale optional ${label} bumper from Cloudinary cloud '${sourceCloud}'; ` +
      `StreamVerse is configured for '${currentCloud || '(missing)'}'.`
    );
    return null;
  }
  return value;
}

function resolveTransition(raw) {
  if (!raw) return null;
  const lower = String(raw).toLowerCase();
  if (SAFE_TRANSITIONS.has(lower)) return lower;
  // Map complex transitions to simple fade
  console.log(`[Compiler] Transition "${raw}" simplified to "fade" (complex transitions disabled to prevent corruption)`);
  return 'fade';
}

/**
 * Submit a scene composition job to the FFmpeg microservice.
 *
 * Only plain clip URLs are sent — no per-clip motion/colorGrade/overlays.
 * Shot-to-shot semantic handoffs are authored in the director shot fields
 * (end_frame_transition / next_shot_continuity) and are realized by the generated
 * end/start visual states; FFmpeg remains a simple concatenation layer.
 * All visual effects are handled by Magic Hour's video generation.
 * The FFmpeg service only does basic concatenation ("cut" layout).
 *
 * Returns jobId.
 */
async function composeScene(clips, composition = 'cut', sceneEffects = {}) {
  const layout = resolveLayout(composition);

  const clipPayload = (clips || [])
    .map(c => {
      if (typeof c === 'string') return c;
      if (!c?.url) return null;
      return c.url;
    })
    .filter(Boolean);

  if (!clipPayload.length) {
    throw new Error('[Compiler] composeScene called with no valid clips');
  }

  _assertNoForeignCloudinaryUrls(clipPayload, 'composeScene');
  await waitForFFmpeg();

  const body = { clips: clipPayload, layout };

  if (layout === 'cut' && sceneEffects.transition) {
    const safeTransition = resolveTransition(sceneEffects.transition);
    if (safeTransition) {
      body.transition = safeTransition;
      if (sceneEffects.transitionDuration != null) {
        body.transitionDuration = sceneEffects.transitionDuration;
      }
    }
  }

  const resp = await axios.post(
    config.ffmpegServiceUrl + '/compose',
    body,
    { headers: _ffmpegHeaders(), timeout: 30000 }
  );
  if (!resp.data?.jobId) {
    throw new Error(`[Compiler] /compose bad response: ${JSON.stringify(resp.data)}`);
  }
  return resp.data.jobId;
}

/**
 * Submit a final episode/master merge job to the FFmpeg microservice.
 *
 * IMPORTANT: the supplied clip list is authoritative. Do not consult or
 * replace it with persisted episode.scene_state. The production final-master
 * path deliberately supplies the exact, freshly validated original shot URLs
 * so an old compiled scene/temporary Cloudinary URL cannot re-enter /merge.
 * Recompile callers that intentionally pass scene URLs also pass through this
 * same boundary unchanged.
 */
async function mergeScenes(clips, { introBumperUrl, outroBumperUrl, ...mergeEffects } = {}) {
  const sourceClips = _sourceClips(clips);
  const safeIntroBumperUrl = _filterForeignOptionalBumper(introBumperUrl, 'intro');
  const safeOutroBumperUrl = _filterForeignOptionalBumper(outroBumperUrl, 'outro');
  const mergeClips = [
    ...(safeIntroBumperUrl ? [safeIntroBumperUrl] : []),
    ...sourceClips,
    ...(safeOutroBumperUrl ? [safeOutroBumperUrl] : []),
  ].filter(Boolean);

  if (!mergeClips.length) {
    throw new Error('[Compiler] mergeScenes called with no valid scene sources');
  }

  _assertNoForeignCloudinaryUrls(mergeClips, 'mergeScenes');
  await waitForFFmpeg();

  const body = { clips: mergeClips };

  if (mergeEffects.transition) {
    const safeTransition = resolveTransition(mergeEffects.transition);
    if (safeTransition) {
      body.transition = safeTransition;
      if (mergeEffects.transitionDuration != null) {
        body.transitionDuration = mergeEffects.transitionDuration;
      }
    }
  }

  const resp = await axios.post(
    config.ffmpegServiceUrl + '/merge',
    body,
    { headers: _ffmpegHeaders(), timeout: 30000 }
  );
  if (!resp.data?.jobId) {
    throw new Error(`[Compiler] /merge bad response: ${JSON.stringify(resp.data)}`);
  }
  return resp.data.jobId;
}

/**
 * Poll an FFmpeg job until it returns a download URL.
 * Uses /status/:id — the single-job status endpoint on the FFmpeg service.
 * Returns the final video URL on success.
 */
async function pollFFmpegJob(jobId) {
  const maxAttempts = config.ffmpegMaxPollAttempts;
  const intervalMs  = config.ffmpegPollIntervalMs;
  const maxConsecutiveServerErrors = 3;
  let consecutiveServerErrors = 0;
  let lastServerError = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    await sleep(intervalMs);
    let resp;
    try {
      resp = await axios.get(
        `${config.ffmpegServiceUrl}/status/${jobId}`,
        { headers: _ffmpegHeaders(), timeout: 20000 }
      );
      consecutiveServerErrors = 0;
      lastServerError = null;
    } catch (err) {
      const status = Number(err?.response?.status);
      const responseBody = err?.response?.data;
      let responseDetail = '';
      if (responseBody !== undefined) {
        try {
          responseDetail = typeof responseBody === 'string'
            ? responseBody
            : JSON.stringify(responseBody);
        } catch {
          responseDetail = String(responseBody);
        }
      }

      const detail = responseDetail || err?.message || 'no response detail';
      if (status >= 500 && status <= 599) {
        consecutiveServerErrors += 1;
        lastServerError = `HTTP ${status}: ${detail}`;
        if (consecutiveServerErrors >= maxConsecutiveServerErrors) {
          throw new Error(
            `[Compiler] FFmpeg status endpoint returned ${lastServerError} ` +
            `${consecutiveServerErrors} consecutive times for job ${jobId}.`
          );
        }
        console.warn(
          `[Compiler] FFmpeg status poll received ${lastServerError}; ` +
          `retrying (${consecutiveServerErrors}/${maxConsecutiveServerErrors - 1} consecutive server errors, ` +
          `poll ${attempt}/${maxAttempts}).`
        );
        continue;
      }

      const statusText = Number.isFinite(status) && status > 0 ? `HTTP ${status}` : 'request error';
      throw new Error(
        `[Compiler] FFmpeg status poll for job ${jobId} failed (${statusText}): ${detail}`
      );
    }

    const job = resp.data;
    if (job.status === 'complete' || job.status === 'done') {
      const url = job.url || job.output_url || job.download_url;
      if (!url) throw new Error(`[Compiler] FFmpeg job complete but no URL: ${JSON.stringify(job)}`);
      return url;
    }
    if (['error', 'failed'].includes(job.status)) {
      const stage = job.step ? ` at step \"${job.step}\"` : '';
      throw new Error(`[Compiler] FFmpeg job ${jobId} failed${stage}: ${job.error || JSON.stringify(job)}`);
    }
    console.log(`[Compiler] FFmpeg job ${jobId} status=${job.status} (${attempt}/${maxAttempts})`);
  }
  const recentServerError = lastServerError ? ` Last status-endpoint error: ${lastServerError}` : '';
  throw new Error(
    `[Compiler] FFmpeg job ${jobId} timed out after ${maxAttempts} polling attempts.` +
    recentServerError
  );
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function composeSceneSmartAndWait(clips, composition = 'cut', sceneEffects = {}) {
  const plainClips = (clips || [])
    .map(c => (typeof c === 'string' ? c : c?.url))
    .filter(Boolean);

  if (plainClips.length === 1) {
    console.log('[Compiler] Scene has a single shot — skipping FFmpeg compilation, using the clip directly.');
    return plainClips[0];
  }

  const jobId = await composeScene(clips, composition, sceneEffects);
  return pollFFmpegJob(jobId);
}

module.exports = {
  wakeFFmpeg,
  waitForFFmpeg,
  composeScene,
  mergeScenes,
  pollFFmpegJob,
  composeSceneSmartAndWait,
};
