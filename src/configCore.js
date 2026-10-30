'use strict';

require('dotenv').config();

// ============================================================================
// STREAMVERSE STUDIO — CONFIGURATION
// ============================================================================

/**

* Parse a pool of secrets/URLs.
*
* Accepts:
* * comma-separated values
* * semicolon-separated values
* * newline-separated values
*
* This is useful for Replit Secrets and other environments where multiline
* values may be pasted into a single environment variable.
  */
  function parseKeyPool(envVar) {
  const val = process.env[envVar] || '';

return val
.split(/[,;\n]+/)
.map((value) => value.trim())
.filter(Boolean);
}

/**

* Normalize a Hugging Face Space URL to its real, directly-callable Gradio
* host (`https://<owner>-<space>.hf.space`).
*
* ROOT CAUSE OF THE "Cannot POST /spaces/.../gradio_api/upload" 404s:
* the Gradio HTTP API (`/gradio_api/upload`, `/gradio_api/call/...`) is only
* served by the Space's OWN subdomain (e.g. https://lightricks-ltx-2-3.hf.space).
* It is NOT served by the huggingface.co website itself — a URL like
* https://huggingface.co/spaces/Lightricks/LTX-2-3 is just the Space's
* *listing page* on huggingface.co. POSTing /gradio_api/upload there hits
* huggingface.co's own web router, which has no such route, hence the
* generic Express-style "Cannot POST ..." 404 HTML page.
*
* If LTX_SPACE_URL is ever set (directly or pasted) to the huggingface.co
* listing URL instead of the *.hf.space host, this rewrites it to the real
* endpoint so the app keeps working instead of failing every submission.
  */
  function normalizeHfSpaceUrl(rawUrl) {
  const trimmed = String(rawUrl || '').trim().replace(/\/+$/, '');
  if (!trimmed) return trimmed;

  const m = trimmed.match(
  /^https?:\/\/(?:www\.)?huggingface\.co\/spaces\/([^\/?#]+)\/([^\/?#]+)/i
  );
  if (!m) return trimmed;

  const slugify = (s) => s.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/-+/g, '-');
  const owner = slugify(m[1]);
  const name  = slugify(m[2]);
  const fixed = `https://${owner}-${name}.hf.space`;

  console.warn(
  `[Config] LTX_SPACE_URL was set to a huggingface.co Space LISTING page ` +
  `(${trimmed}), which does not serve the Gradio HTTP API and causes ` +
  `"Cannot POST /gradio_api/upload" 404s. Rewriting to the real callable ` +
  `Space host: ${fixed}. Please update the LTX_SPACE_URL secret to this ` +
  `value directly so this warning goes away.`
  );

  return fixed;
  }

/**

* Read an environment variable and warn if it is missing.
  */
  function requireEnv(key) {
  const value = process.env[key];

if (!value) {
console.warn(`[Config] WARNING: env var ${key} is not set`);
}

return value || '';
}


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
    console.warn(`[Config] Invalid CLOUDINARY_URL: ${err.message}`);
    return {};
  }
}

const cloudinaryUrlConfig = parseCloudinaryUrl(process.env.CLOUDINARY_URL);

function requireEnvAny(keys) {
  const names = Array.isArray(keys) ? keys : [keys];
  for (const key of names) {
    if (process.env[key]) return process.env[key];
  }
  console.warn(`[Config] WARNING: none of ${names.join(', ')} is set`);
  return '';
  }

// ============================================================================
// MYSQL
// ============================================================================

/**

* Detect common TLS/SSL query-string flags used by cloud MySQL providers.
*
* Supported examples:
* ?ssl=true
* ?tls=true
* ?ssl-mode=REQUIRED
* ?sslmode=require
  */
  function _needsSsl(params) {
  return (
  params.get('ssl') === 'true' ||
  params.get('tls') === 'true' ||
  (params.get('ssl-mode') || '').toUpperCase() === 'REQUIRED' ||
  (params.get('sslmode') || '').toLowerCase().startsWith('req')
  );
  }

/**

* Build MySQL connection configuration.
*
* Preferred:
* DATABASE_URL
* MYSQL_URL
*
* Fallback:
* MYSQL_HOST
* MYSQL_PORT
* MYSQL_USER
* MYSQL_PASSWORD
* MYSQL_DATABASE
  */
  function buildDbConfig() {
  const url = process.env.DATABASE_URL || process.env.MYSQL_URL || '';

if (url) {
try {
const parsed = new URL(url);

  return {
    host: parsed.hostname,
    port: parseInt(parsed.port || '3306', 10),
    user: decodeURIComponent(parsed.username),
    password: decodeURIComponent(parsed.password),
    database: parsed.pathname.replace(/^\//, ''),

    waitForConnections: true,
    connectionLimit: 5,
    queueLimit: 0,

    ...(
      _needsSsl(parsed.searchParams)
        ? {
            ssl: {
              rejectUnauthorized: false,
            },
          }
        : {}
    ),
  };
} catch (error) {
  console.warn(
    '[Config] DATABASE_URL parse failed, falling back to individual vars:',
    error.message
  );
}

}

return {
host: requireEnv('MYSQL_HOST'),
port: parseInt(process.env.MYSQL_PORT || '3306', 10),
user: requireEnv('MYSQL_USER'),
password: requireEnv('MYSQL_PASSWORD'),
database: requireEnv('MYSQL_DATABASE'),

waitForConnections: true,
connectionLimit: 5,
queueLimit: 0,

};
}

// ============================================================================
// CONFIGURATION OBJECT
// ============================================================================

const config = {
// ==========================================================================
// DATABASE
// ==========================================================================

db: buildDbConfig(),

// ==========================================================================
// LLM KEY POOLS
// ==========================================================================

// Retained but no longer consumed anywhere (scriptWriter.js/ltxVisionDirector.js/
// semanticTransitionDirector.js were all switched to Agnes AI below, after
// Mistral suspended its free tier without notice). Left defined — harmless
// if MISTRAL_KEYS is unset, and keeps the door open to re-enable Mistral as
// a fallback later without re-adding this line.
mistralKeys: parseKeyPool('MISTRAL_KEYS'),

// ==========================================================================
// AGNES AI (apihub.agnes-ai.com) — TEXT/VISION DIRECTOR MODEL
// ==========================================================================
//
// NAMING WARNING: this is a completely different product from the VIDEO
// generation "Agnes" provider used elsewhere in this codebase (video_engine/
// providers/agnes.py, src/agnesVideoGen.js, config.videoProvider==='agnes',
// env vars AGNES_API_KEY(S)). That Agnes is a video-diffusion HF-Space-style
// backend. THIS Agnes is "Agnes AI" (agnes-ai.com) — an unrelated,
// OpenAI-compatible text/vision chat-completions gateway now used as the
// scene/shot/continuity DIRECTOR model (replacing Mistral, whose free tier
// was suspended without notice). Deliberately namespaced as `agnesAi*` /
// `AGNES_AI_*` everywhere, never bare `agnes*`, specifically so the two
// never collide in an env var, a config key, or a keyHealth pool name.
//
agnesAiKeys: parseKeyPool('AGNES_AI_KEYS'),

// agnes-2.5-flash: OpenAI-compatible chat completions at
// https://apihub.agnes-ai.com/v1/chat/completions, 512K context / 65.5K max
// output, supports image_url content blocks (vision) and response_format
// json_object — the same request shape the Mistral call sites already used,
// which is exactly why this could be a same-pattern swap rather than a
// rewrite. Per Agnes AI's own docs, agnes-2.0-flash is deprecated in favor
// of 2.5; do not fall back to 2.0.
agnesAiTextModel: process.env.AGNES_AI_TEXT_MODEL || 'agnes-2.5-flash',

groqKeys: parseKeyPool('GROQ_KEYS'),

// Groq primary/fallback text model
groqModel: process.env.GROQ_MODEL || 'openai/gpt-oss-120b',

// ==========================================================================
// GOOGLE GENERATIVE AI
// ==========================================================================

googleKeys: parseKeyPool('GOOGLE_KEYS'),

// ==========================================================================
// SCRAPINGBEE
// ==========================================================================

scrapingBeeKeys: parseKeyPool('SCRAPINGBEE_KEYS'),

// ==========================================================================
// CLOUDFLARE WORKER AI
// ==========================================================================

/**

* CF_WORKER_URL may contain multiple Worker deployments.
*
* URLs are rotated when a Worker reports quota exhaustion.
  */
  cfWorkerUrls: parseKeyPool('CF_WORKER_URL'),

cfWorkerKeys: parseKeyPool('CF_WORKER_KEYS'),

// ==========================================================================
// GROQ VISION
// ==========================================================================

groqVisionModel:
process.env.GROQ_VISION_MODEL ||
'llama-3.2-11b-vision-preview',

// ==========================================================================
// MAGIC HOUR — LEGACY VIDEO PROVIDER
// ==========================================================================
//
// Retained for rollback.
//
// Set:
//   VIDEO_PROVIDER=magichour
//
// to switch back without changing application code.
//

magicHourKeys: parseKeyPool('MAGIC_HOUR_KEYS'),

magicHourPollIntervalMs:
parseInt(
process.env.MH_POLL_INTERVAL_MS || '15000',
10
),

magicHourMaxPollAttempts:
parseInt(
process.env.MH_MAX_POLL_ATTEMPTS || '60',
10
),

// ==========================================================================
// VIDEO PROVIDER
// ==========================================================================

/**

* Current production provider.
*
* Default:
* LTX
*
* Rollback:
* VIDEO_PROVIDER=magichour
  */
  videoProvider:
  (process.env.VIDEO_PROVIDER || (process.env.RENDERER_BASE_URL && process.env.RENDERER_API_KEY ? 'vanta' : 'ltx')).toLowerCase(),

// ==========================================================================
// VANTA / COMFYUI RENDERER (self-describing workflow API)
// ==========================================================================
rendererBaseUrl: process.env.RENDERER_BASE_URL || '',
rendererApiKey: process.env.RENDERER_API_KEY || '',

// ==========================================================================
// PYTHON VIDEO ENGINE (internal service — video-generation execution only)
// ==========================================================================
//
// StreamVerse's LTX/Gradio integration runs as a separate Python service
// on the same server/network. Node remains the control plane and talks to
// it only through services/videoEngineClient.js.

videoEngineHost: process.env.VIDEO_ENGINE_HOST || '127.0.0.1',

videoEnginePort: parseInt(process.env.VIDEO_ENGINE_PORT || '8000', 10),

get videoEngineUrl() {
  return process.env.VIDEO_ENGINE_URL
    || `http://${this.videoEngineHost}:${this.videoEnginePort}`;
},

// Shared secret sent as X-StreamVerse-Internal-Key on every Node → Python
// request. Never hard-code this; set STREAMVERSE_INTERNAL_KEY in env.
videoEngineInternalKey: process.env.STREAMVERSE_INTERNAL_KEY || '',

// ==========================================================================
// LTX-2.3 / HUGGING FACE
// ==========================================================================

/**

* Hugging Face access-token pool.
*
* Tokens are rotated when:
*
* * ZeroGPU quota is exhausted
* * authentication fails
* * a transient submission problem requires rotation
*
* ZeroGPU-exhausted tokens are placed into cooldown.
  */
  hfTokens: parseKeyPool('HF_TOKENS'),

/**

* Default ZeroGPU cooldown:
* 24 hours.
  */
  hfCooldownMs:
  parseInt(
  process.env.HF_COOLDOWN_MS ||
  String(24 * 60 * 60 * 1000),
  10
  ),

/**
 
* NODE-SIDE DOCUMENTATION ONLY — NOT CONSUMED BY THE ACTUAL GRADIO CALL.
*
* The real generation call now lives entirely in the Python video_engine
* (video_engine/providers/ltx.py + video_engine/config.py:HF_SPACE/LTX_API_NAME),
* which talks to the Space via gradio_client. Node only forwards a job
* request to that service — it never opens a Gradio connection itself.
* ltxSpaceUrl / ltxApiName / ltxParamOrder below are kept in sync BY HAND,
* for accurate startup-log output only (see the console.log block further
* down this file) — if you change the Space or its call contract, update
* video_engine/config.py AND these three values together, or the boot log
* will print a stale contract while the real one (Python's) has moved on.
*
* Current Space: linoyts/LTX-2-3-First-Last-Frame (first/last-frame +
* optional-audio conditioning — see video_engine/providers/ltx.py's module
* docstring for the verified param order).
  */
  ltxSpaceUrl:
  normalizeHfSpaceUrl(
  process.env.LTX_SPACE_URL ||
  'https://linoyts-ltx-2-3-first-last-frame.hf.space'
  ),

/**
 
* Matches video_engine/config.py's LTX_API_NAME default. The Space defines
* generate_video() with no explicit api_name= override in its .click()
* wiring, so Gradio auto-derives "/generate_video" from the function name.
  */
  ltxApiName:
  process.env.LTX_API_NAME ||
  '/generate_video',

/**
 
* VERIFIED against the live Space's generate_btn.click() wiring
* (fn=generate_video) and regression-tested in
* video_engine/tests/test_param_order.py:
*
* generate_video(first_image, last_image, input_audio, prompt, duration,
*                 enhance_prompt, seed, randomize_seed, height, width)
*
* IMPORTANT: `height` comes BEFORE `width`. This Space ALSO added
* first_image/last_image/input_audio ahead of the old single-image Space's
* 8-param contract (image, prompt, duration, enhance_prompt, seed,
* randomize_seed, height, width) — do not fall back to that shorter order.
  */
  ltxParamOrder:
  (
  process.env.LTX_PARAM_ORDER ||
  'first_image,last_image,input_audio,prompt,duration,enhance_prompt,seed,randomize_seed,height,width'
  )
  .split(',')
  .map((value) => value.trim())
  .filter(Boolean),

// ==========================================================================
// LTX-2.3 RESOLUTION
// ==========================================================================
//
// VERIFIED AGAINST THE LIVE LTX-2-3 SPACE.
//
// The Space defines:
//
// HIGH:
//   16:9 -> 1536 x 1024
//   9:16 -> 1024 x 1536
//   1:1  -> 1024 x 1024
//
// LOW:
//   16:9 -> 768 x 512
//   9:16 -> 512 x 768
//   1:1  -> 768 x 768
//
// StreamVerse is designed around portrait/9:16 video, therefore the
// production default is the VERIFIED HIGH-RESOLUTION portrait preset:
//
//   1024 x 1536
//
// Both dimensions are divisible by 32 as required by LTX.
//

ltxWidth:
parseInt(
process.env.LTX_WIDTH || '1024',
10
),

ltxHeight:
parseInt(
process.env.LTX_HEIGHT || '1536',
10
),

/**

* Explicit production quality flag.
*
* This documents the fact that StreamVerse should use the LTX high-resolution
* tier rather than the 512 x 768 low-resolution portrait tier.
*
* The actual Space does not expose a `high_res` parameter to generate_video;
* the High Resolution checkbox is a UI helper that changes width/height.
  */
  ltxHighResolution:
  (process.env.LTX_HIGH_RESOLUTION || 'true').toLowerCase() === 'true',

// ==========================================================================
// LTX-2.3 DURATION
// ==========================================================================

/**

* LTX provider safety contract: the configured LTX backend is capped at its
* verified maximum. Agnes does not use this field as a cap when VIDEO_PROVIDER=agnes.
  */
  ltxMinDuration:
  parseFloat(
  process.env.LTX_MIN_DURATION || '2'
  ),

ltxMaxDuration:
parseFloat(
process.env.LTX_MAX_DURATION || '10'
),

// ==========================================================================
// SHOT-TO-SHOT TRANSITION CONTRACT (first/last-frame continuity)
// ==========================================================================
//
// When a predecessor shot's terminal frame is available, both the Agnes and
// LTX-2.3 (First-Last-Frame) providers physically bridge FROM that exact
// frame INTO the freshly authored current-shot still. This window governs
// how much of the generated clip's opening is dedicated to resolving that
// bridge before the shot's own authored action takes over. Treated as a
// first-class part of every shot's generation contract, not a cosmetic
// nicety — see CONTINUITY_TRANSITION_CONTRACT in ltxVisionDirector.js and
// semanticTransitionDirector.js.
//

continuityTransitionMinSeconds:
parseFloat(
process.env.CONTINUITY_TRANSITION_MIN_SECONDS || '3'
),

continuityTransitionMaxSeconds:
parseFloat(
process.env.CONTINUITY_TRANSITION_MAX_SECONDS || '4'
),

// ==========================================================================
// LTX-2.3 SEEDING
// ==========================================================================

/**

* Keep deterministic seeds by default.
*
* The live Space itself defaults randomize_seed=true, but StreamVerse can
* supply its own seed for reproducibility.
  */
  ltxRandomizeSeed:
  (
  process.env.LTX_RANDOMIZE_SEED || 'false'
  ).toLowerCase() === 'true',

// ==========================================================================
// LTX-2.3 PROMPT ENHANCEMENT
// ==========================================================================

/**

* The live Space supports enhance_prompt, but CONFIRMED (from the Space's
* own source) to be dangerous for this pipeline: when true, generate_video()
* runs encode_prompts(..., enhance_first_prompt=True, ...) which rewrites
* the prompt internally (via its Gemma text encoder) BEFORE generation.
* That rewrite has no awareness of this pipeline's continuity contracts —
* it can silently drop or paraphrase the scene continuity bible, quoted
* dialogue lines, the transition-window directive, or match-on-action
* phasing that ltxVideoGenCore.js carefully constructs. Keep disabled by
* default; StreamVerse already builds detailed cinematic prompts and does
* not want an uncontrolled rewriting layer between authoring and rendering.
  */
  ltxEnhancePrompt:
  (
  process.env.LTX_ENHANCE_PROMPT || 'false'
  ).toLowerCase() === 'true',

// ==========================================================================
// LTX-2.3 POLLING
// ==========================================================================

ltxPollIntervalMs:
parseInt(
process.env.LTX_POLL_INTERVAL_MS || '15000',
10
),

ltxMaxPollAttempts:
parseInt(
process.env.LTX_MAX_POLL_ATTEMPTS || '80',
10
),

/**

* Maximum duration of one SSE read window.
*
* The complete LTX generation can take much longer than this.
* The poller therefore performs multiple bounded reads instead of keeping
* one connection open indefinitely.
  */
  ltxSseWindowMs:
  parseInt(
  process.env.LTX_SSE_WINDOW_MS || '25000',
  10
  ),

// ==========================================================================
// FFMPEG MICROSERVICE
// ==========================================================================

ffmpegServiceUrl:
requireEnv('FFMPEG_SERVICE_URL'),

ffmpegApiKey:
requireEnvAny(['FFMPEG_SERVICE_API_KEY', 'FFMPEG_API_KEY']),

ffmpegPollIntervalMs:
parseInt(
process.env.FFMPEG_POLL_INTERVAL_MS || '10000',
10
),

ffmpegReadyTimeoutMs:
parseInt(
process.env.FFMPEG_READY_TIMEOUT_MS || '600000',
10
),

ffmpegReadyInitialDelayMs:
parseInt(
process.env.FFMPEG_READY_INITIAL_DELAY_MS || '1000',
10
),

ffmpegReadyMaxDelayMs:
parseInt(
process.env.FFMPEG_READY_MAX_DELAY_MS || '10000',
10
),

ffmpegHealthRequestTimeoutMs:
parseInt(
process.env.FFMPEG_HEALTH_REQUEST_TIMEOUT_MS || '10000',
10
),

ffmpegMaxPollAttempts:
parseInt(
process.env.FFMPEG_MAX_POLL_ATTEMPTS || '120',
10
),

// ==========================================================================
// CLOUDINARY
// ==========================================================================

cloudinaryCloudName:
process.env.CLOUDINARY_CLOUD_NAME || cloudinaryUrlConfig.cloudName || '',

cloudinaryApiKey:
process.env.CLOUDINARY_API_KEY || cloudinaryUrlConfig.apiKey || '',

cloudinaryApiSecret:
process.env.CLOUDINARY_API_SECRET || cloudinaryUrlConfig.apiSecret || '',

cloudinaryUploadPreset:
requireEnv('CLOUDINARY_UPLOAD_PRESET'),

shotsFolderRoot:
process.env.CLOUDINARY_SHOTS_ROOT ||
'streamverse/shots',

episodeFolderRoot:
process.env.CLOUDINARY_EPISODES_ROOT ||
'streamverse/episodes',

charRefFolderRoot:
process.env.CLOUDINARY_CHARS_ROOT ||
'streamverse/characters',

// ==========================================================================
// TELEGRAM
// ==========================================================================

telegramBotToken:
requireEnv('TELEGRAM_BOT_TOKEN'),

telegramChatId:
requireEnv('TELEGRAM_CHAT_ID'),

// ==========================================================================
// DISCORD
// ==========================================================================

discordWebhookUrl:
process.env.WEBHOOK_URL ||
process.env.DISCORD_WEBHOOK_URL ||
'',

// Discord webhook file-upload ceiling. Standard servers: 10MB. Servers with
// Level 2 boost: 50MB. Default to the safe standard-tier limit; override
// with DISCORD_MAX_UPLOAD_BYTES if the target server has a boost tier.
discordMaxUploadBytes:
parseInt(
process.env.DISCORD_MAX_UPLOAD_BYTES || String(10 * 1024 * 1024),
10
),

// ==========================================================================
// CONTENT PIPELINE
// ==========================================================================

genrePool:
(
process.env.GENRE_POOL ||
'romcom,thriller,sci-fi,drama'
)
.split(',')
.map((genre) => genre.trim()),

shotsPerScene:
parseInt(
process.env.SHOTS_PER_SCENE || '3',
10
),

targetEpisodeMinSeconds:
parseInt(
process.env.TARGET_MIN_SECONDS || '300',
10
),

// Target runtime for a "series movie" (see pipeline.js isSeriesMovie / the
// VANTA standalone-film engine uses its own, separate runtimeRange in
// src/film/filmBible.js). Despite the name (kept for backward compatibility —
// it was already used as a fixed target, not actually a minimum), this is the
// single number that decides both requested runtime AND, via
// computeExpectedSceneCount below, how many scenes get written — there is no
// separate "max" and no code path clamps a longer request back down. Raised
// from the previous 1200s (20min) default to 1800s (30min); set
// MOVIE_MIN_SECONDS to any value for a longer or shorter target.
movieMinSeconds:
parseInt(
process.env.MOVIE_MIN_SECONDS || '1800',
10
),

/**
 * Scene count for a script, given its target length. Shared by scriptWriter.js
 * (simulateEpisodeStory's resolvedSceneCount fallback) and pipeline.js
 * (expectedSceneCount, used to decide whether a scene simulation is complete).
 * These two MUST stay identical — a mismatch means the pipeline would demand
 * a different scene count than the one actually requested from the writer,
 * which either loops forever regenerating or accepts an incomplete story.
 *
 * Scene count SCALES with target length; there is no flat ceiling. A movie
 * requested at 20 minutes gets the same ~20 scenes as before (this preserves
 * existing behaviour at the old default); a 30- or 45-minute film gets
 * proportionally more, rather than being stuck at a fixed count meant for a
 * 20-minute runtime.
 */
computeExpectedSceneCount({ isSeriesMovie, targetMinutes }) {
  const t = Number(targetMinutes) || 0;
  if (isSeriesMovie) return Math.max(12, Math.round(t));           // ~1 scene/minute, matches the old fixed 20-at-20min ratio
  if (t <= 2) return 8;
  if (t <= 5) return 10;
  return Math.max(12, Math.round(t * 2));                          // was a flat 12 for any episode over 5 minutes
},

// ==========================================================================
// SEASON / EPISODE LOGIC
// ==========================================================================

episodesPerSeason:
parseInt(
process.env.EPISODES_PER_SEASON || '20',
10
),

seasonsPerSeries:
parseInt(
process.env.SEASONS_PER_SERIES || '4',
10
),

// Rolling narrative horizon: how many upcoming episode trajectories are
// planned ahead of the currently produced episode.
trajectoryWindowEpisodes:
Math.max(
3,
Math.min(
5,
parseInt(process.env.TRAJECTORY_WINDOW_EPISODES || '5', 10)
)
),

// ==========================================================================
// SHOT RETRY / ABORT
// ==========================================================================

shotMaxRetries:
parseInt(
process.env.SHOT_MAX_RETRIES || '3',
10
),

shotFailAbortPct:
parseFloat(
process.env.SHOT_FAIL_ABORT_PCT || '0.5'
),

// ==========================================================================
// CHARACTER CONSISTENCY
// ==========================================================================

/**

* Number of canonical reference portraits generated per character.
*
* 1 = one canonical reference.
  */
  charRefImageCount:
  parseInt(
  process.env.CHAR_REF_IMAGE_COUNT || '1',
  10
  ),

charRefMaxRetries:
  parseInt(
  process.env.CHAR_REF_MAX_RETRIES || '5',
  10
  ),

// ==========================================================================
// APPLICATION
// ==========================================================================

port:
parseInt(
process.env.PORT || '5000',
10
),

sessionSecret:
process.env.SESSION_SECRET ||
'sv-secret',
};

// ============================================================================
// KEY ROTATION
// ============================================================================

const _keyIndexes = {};

/**

* Generic round-robin key rotation.
  */
  function getNextKey(pool, poolName) {
  if (!pool || pool.length === 0) {
  throw new Error(
  `No keys configured for pool: ${poolName}`
  );
  }

const idx =
(_keyIndexes[poolName] || 0) % pool.length;

_keyIndexes[poolName] = idx + 1;

return pool[idx];
}

// ============================================================================
// STANDARD KEY POOLS
// ============================================================================

config.getNextMistralKey = () =>
getNextKey(
config.mistralKeys,
'mistral'
);

// Same generic round-robin pool mechanism as every other provider here —
// this IS "the same key pool rotation that already exists," just pointed at
// a new pool. See the AGNES AI section above for the naming-collision note.
config.getNextAgnesAiKey = () =>
getNextKey(
config.agnesAiKeys,
'agnesAi'
);

config.getNextGroqKey = () =>
getNextKey(
config.groqKeys,
'groq'
);

config.getNextCfKey = () =>
getNextKey(
config.cfWorkerKeys,
'cf'
);

config.getNextGoogleKey = () =>
getNextKey(
config.googleKeys,
'google'
);

config.getNextScrapingBeeKey = () =>
getNextKey(
config.scrapingBeeKeys,
'scrapingbee'
);

// ============================================================================
// CLOUDFLARE WORKER URL ROTATION
// ============================================================================
//
// STICKY rotation:
// keep using the same Worker URL until it is marked exhausted.
//
// This prevents every image request from consuming another Worker deployment.
// ============================================================================

config.getNextCfUrl = () => {
const pool = config.cfWorkerUrls;

if (!pool || pool.length === 0) {
throw new Error(
'No CF Worker URLs configured'
);
}

const health =
config.keyHealth.cfurl || [];

for (let i = 0; i < pool.length; i++) {
const idx =
((_keyIndexes.cfurl || 0) + i) %
pool.length;

const url = pool[idx];
const label = maskUrl(url);

const entry = health.find(
  (item) => item.label === label
);

if (!entry || entry.status !== 'exhausted') {
  _keyIndexes.cfurl = idx;
  return url;
}

}

// Every URL is exhausted.
// Return the next URL anyway so the caller receives a usable target.
return getNextKey(
pool,
'cfurl'
);
};

// ============================================================================
// MAGIC HOUR KEY ROTATION
// ============================================================================
//
// Sticky rotation:
//
// Keep using one Magic Hour key until it is explicitly marked exhausted.
//
// 429 rate limits are temporary and therefore do NOT automatically mark the
// key permanently exhausted.
// ============================================================================

config.getNextMagicHourKey = () => {
const pool = config.magicHourKeys;

if (!pool || pool.length === 0) {
throw new Error(
'No Magic Hour keys configured'
);
}

const health =
config.keyHealth.magicHour || [];

for (let i = 0; i < pool.length; i++) {
const idx =
((_keyIndexes.magichour || 0) + i) %
pool.length;

const key = pool[idx];
const label = maskKey(key);

const entry = health.find(
  (item) => item.label === label
);

if (!entry || entry.status !== 'exhausted') {
  _keyIndexes.magichour = idx;
  return key;
}

}

return getNextKey(
pool,
'magichour'
);
};

/**

* Manually advance past the current Magic Hour key.
*
* Used for temporary rate limits or submission-level retry rotation.
  */
  config.advanceMagicHourKey = () => {
  const pool = config.magicHourKeys;

if (!pool || pool.length === 0) {
return;
}

_keyIndexes.magichour =
((_keyIndexes.magichour || 0) + 1) %
pool.length;
};

// ============================================================================
// HF / LTX-2.3 TOKEN ROTATION
// ============================================================================
//
// Sticky linear rotation:
//
//   Token 1 -> Token 1 -> Token 1
//                         |
//                         +-- ZeroGPU exhausted
//                                  |
//                                  v
//                              Token 2
//
// Exhausted tokens enter a 24-hour cooldown.
// ============================================================================

const _hfExhaustedAt = {};

/**

* Return the next healthy Hugging Face token.
*
* Tokens remain sticky until they are explicitly exhausted.
  */
  config.getNextHfToken = () => {
  const pool = config.hfTokens;

if (!pool || pool.length === 0) {
throw new Error(
'No Hugging Face tokens configured (HF_TOKENS)'
);
}

const now = Date.now();

for (let i = 0; i < pool.length; i++) {
const idx =
((_keyIndexes.hf || 0) + i) %
pool.length;

const token = pool[idx];
const label = maskKey(token);

const exhaustedAt =
  _hfExhaustedAt[label];

const stillCoolingDown =
  exhaustedAt &&
  (now - exhaustedAt) <
    config.hfCooldownMs;

if (!stillCoolingDown) {
  // Cooldown expired.
  if (exhaustedAt) {
    delete _hfExhaustedAt[label];

    config.markKeyStatus(
      'hf',
      token,
      'active'
    );
  }

  // Sticky token.
  _keyIndexes.hf = idx;

  return token;
}

}

console.warn(
'[Config] All HF tokens are within their 24h cooldown window. ' +
'Retrying the next token in the pool.'
);

return getNextKey(
pool,
'hf'
);
};

/**

* Mark a Hugging Face token as ZeroGPU exhausted.
*
* The token becomes eligible again after hfCooldownMs.
  */
  config.markHfTokenExhausted = (token) => {
  if (!token) {
  return;
  }

const label = maskKey(token);

_hfExhaustedAt[label] =
Date.now();

config.markKeyStatus(
'hf',
token,
'exhausted'
);
};

/**

* Advance past the current HF token without marking it exhausted.
*
* Used for:
* * transient network failures
* * temporary rate limits
* * submission-level retries
    */
    config.advanceHfToken = () => {
    const pool = config.hfTokens;

if (!pool || pool.length === 0) {
return;
}

_keyIndexes.hf =
((_keyIndexes.hf || 0) + 1) %
pool.length;
};

// ============================================================================
// KEY MASKING
// ============================================================================

function maskKey(key) {
if (!key || key.length < 8) {
return '***';
}

return (
key.slice(0, 4) +
'...' +
key.slice(-4)
);
}

/**

* Shorten a Cloudflare Worker URL for dashboard display.
  */
  function maskUrl(url) {
  try {
  const hostname =
  new URL(url).hostname;

  return hostname.length > 22
  ? hostname.slice(0, 19) + '…'
  : hostname;
  } catch {
  return String(url).slice(0, 22);
  }
  }

// ============================================================================
// KEY HEALTH
// ============================================================================

config.keyHealth = {
google:
config.googleKeys.map(
(key) => ({
label: maskKey(key),
status: 'active',
})
),

mistral:
config.mistralKeys.map(
(key) => ({
label: maskKey(key),
status: 'active',
})
),

agnesAi:
config.agnesAiKeys.map(
(key) => ({
label: maskKey(key),
status: 'active',
})
),

groq:
config.groqKeys.map(
(key) => ({
label: maskKey(key),
status: 'active',
})
),

magicHour:
config.magicHourKeys.map(
(key) => ({
label: maskKey(key),
status: 'active',
})
),

scrapingBee:
config.scrapingBeeKeys.map(
(key) => ({
label: maskKey(key),
status: 'active',
})
),

cfurl:
config.cfWorkerUrls.map(
(url) => ({
label: maskUrl(url),
status: 'active',
})
),

hf:
config.hfTokens.map(
(key) => ({
label: maskKey(key),
status: 'active',
})
),

discord: [
{
label: 'Webhook',
status:
config.discordWebhookUrl
? 'active'
: 'missing',
},
],
};

// ============================================================================
// KEY HEALTH STATUS UPDATE
// ============================================================================

config.markKeyStatus = (
pool,
key,
status
) => {
const label =
pool === 'cfurl'
? maskUrl(key)
: maskKey(key);

const entry =
config.keyHealth[pool]?.find(
(item) =>
item.label === label
);

if (entry) {
entry.status = status;
}
};

// ============================================================================
// LTX CONFIGURATION SANITY CHECK
// ============================================================================

if (config.videoProvider === 'ltx') {
if (
config.ltxWidth % 32 !== 0 ||
config.ltxHeight % 32 !== 0
) {
console.warn(
`[Config] WARNING: LTX resolution ` +
`${config.ltxWidth}x${config.ltxHeight} ` +
`is not divisible by 32.`
);
}

if (
config.ltxMaxDuration > 10
) {
console.warn(
`[Config] WARNING: LTX_MAX_DURATION=${config.ltxMaxDuration} ` +
`exceeds the configured verified LTX maximum. ` +
`Clamping to the LTX provider maximum.`
);

config.ltxMaxDuration = 10;

}

if (
config.ltxMinDuration < 1
) {
config.ltxMinDuration = 1;
}

if (
config.ltxMinDuration >
config.ltxMaxDuration
) {
console.warn(
'[Config] WARNING: LTX_MIN_DURATION exceeds LTX_MAX_DURATION. ' +
'Resetting minimum to 2 seconds.'
);

config.ltxMinDuration =
  Math.min(
    2,
    config.ltxMaxDuration
  );

}

console.log(
config.videoProvider === 'agnes'
  ? '[Config] Agnes production temporal configuration:'
  : '[Config] LTX-2.3 production configuration:'
);

console.log(
`  Space: ${config.ltxSpaceUrl}`
);

console.log(
`  API: ${config.ltxApiName}`
);

console.log(
`  Resolution: ${config.ltxWidth}x${config.ltxHeight}`
);

console.log(
`  High Resolution: ${config.ltxHighResolution ? 'ENABLED' : 'DISABLED'}`
);

console.log(
`  Duration: ${config.ltxMinDuration}-${config.ltxMaxDuration}s`
);

console.log(
`  Random Seed: ${config.ltxRandomizeSeed ? 'ENABLED' : 'DISABLED'}`
);

console.log(
`  Prompt Enhancement: ${config.ltxEnhancePrompt ? 'ENABLED' : 'DISABLED'}`
);

console.log(
`  Parameter Order: ${config.ltxParamOrder.join(', ')}`
);
}

// Exposed so other modules (e.g. ltxVideoGen's _getBaseUrl) can defensively
// re-normalize a URL that reaches them some other way (manual override,
// future config source, etc.) instead of only guarding the one call site above.
config.normalizeHfSpaceUrl = normalizeHfSpaceUrl;

// ============================================================================
// EXPORT
// ============================================================================

module.exports = config;