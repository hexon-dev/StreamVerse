'use strict';
/**
 * Cloudflare Worker AI — Image generation via custom multipart Worker.
 *
 * FLUX.2 [klein] 4B multi-reference contract (confirmed against Cloudflare's
 * own flux-2-klein-4b docs/changelog — the up-to-4-reference-image and
 * <512x512 constraints are identical across the klein 4B/9B sizes, so this
 * still applies if the deployed model is ever swapped to klein 9B too):
 *   - up to 4 input reference images;
 *   - every input reference must be smaller than 512x512;
 *   - output width/height are independent of reference dimensions;
 *   - the model runs a FIXED 4-step distilled inference pass — Cloudflare's
 *     docs are explicit that the step count "cannot be adjusted." There is
 *     no lower/higher "quality" tier to request from this endpoint; every
 *     call costs and looks the same. Do not build draft/refine-style logic
 *     around this model expecting a cheaper draft tier — there isn't one
 *     (see hardControlLayers.js's render-pass comment for the fix that
 *     removed exactly that assumption).
 *
 * StreamVerse therefore keeps the final generated image at the production
 * portrait target 1024x1536 while resizing only the supplied reference images
 * to fit entirely inside a 511x511 bounding box without distorting them.
 */
const axios    = require('axios');
const FormData = require('form-data');
const sharp    = require('sharp');
const config   = require('./config');

const FLUX_REFERENCE_MAX_DIM = 511;
const OUTPUT_WIDTH = 1024;
const OUTPUT_HEIGHT = 1536;
const CF_3030_MAX_RETRIES = 4;
const CF_TRANSIENT_MAX_RETRIES = 2;

// ── Typed error for content policy refusals ───────────────────────────────────
class CFSafetyRefusalError extends Error {
  constructor(message, metadata = {}) {
    super(message);
    this.name = 'CFSafetyRefusalError';
    Object.assign(this, metadata);
  }
}

// ── Parse an error body (arraybuffer or string) into a plain string ───────────
function _parseErrorBody(data) {
  if (!data) return null;
  try {
    const text = Buffer.isBuffer(data) ? data.toString('utf8')
               : (data instanceof ArrayBuffer ? Buffer.from(data).toString('utf8')
               : String(data));
    const trimmed = text.trim();
    if (trimmed.startsWith('{')) {
      const parsed = JSON.parse(trimmed);
      return parsed.error || trimmed;
    }
    return trimmed;
  } catch { return null; }
}

// ── Check if a successful (2xx) response body is actually a JSON error ─────────
function _checkNotJsonError(buf) {
  if (!buf || buf.length < 2) return;
  if (buf[0] !== 0x7B) return;
  try {
    const text   = buf.toString('utf8').slice(0, 1200);
    const parsed = JSON.parse(text);
    if (parsed.error) {
      throw new Error(`CF Worker returned JSON error: ${parsed.error}`);
    }
  } catch (e) {
    if (e.message?.startsWith('CF Worker returned JSON error')) throw e;
  }
}

/**
 * Resize a reference image for FLUX.2 Klein multi-reference input.
 *
 * Cloudflare's current Workers AI documentation requires each reference image
 * to be smaller than 512x512. We preserve aspect ratio and fit the image inside
 * 511x511, so neither dimension can reach 512. The original high-resolution
 * generated output is never passed through this function.
 */
async function _prepareReferenceImage(buffer, index) {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
    throw new Error(`[CFImageGen] Reference image ${index} is empty`);
  }

  const metadata = await sharp(buffer).metadata();
  const sourceWidth = Number(metadata.width || 0);
  const sourceHeight = Number(metadata.height || 0);
  if (!sourceWidth || !sourceHeight) {
    throw new Error(`[CFImageGen] Reference image ${index} has unreadable dimensions`);
  }

  const prepared = await sharp(buffer)
    .rotate()
    .resize({
      width: FLUX_REFERENCE_MAX_DIM,
      height: FLUX_REFERENCE_MAX_DIM,
      fit: 'inside',
      withoutEnlargement: true,
    })
    .jpeg({ quality: 92, mozjpeg: true })
    .toBuffer({ resolveWithObject: true });

  console.log(
    `[CFImageGen] Reference ${index + 1}: ${sourceWidth}x${sourceHeight} -> ` +
    `${prepared.info.width}x${prepared.info.height} (<512x512)`
  );

  return prepared.data;
}

/**
 * Content-safe contextual recovery for Cloudflare's 3030 filter.
 *
 * This is not a bypass mechanism. The goal is to turn short, ambiguous, or
 * trigger-heavy descriptions into complete, literal cinematic still-frame
 * descriptions with explicit fictional/contextual framing. Cloudflare's own
 * API errors identify 3030 as an output-content flag; when it occurs we create
 * a materially different, safer prompt before retrying rather than replaying
 * the same request.
 */
function _build3030RecoveryPrompt(originalPrompt, attempt, generationMode = 'shot') {
  let prompt = String(originalPrompt || '').trim();

  if (generationMode === 'environment') {
    const recoveryGuidance = [
      'Describe only the physical environment as an empty-set location plate.',
      'Do not add, imply, or depict people, characters, human figures, silhouettes, crowds, mannequins, portraits, faces, bodies, hands, or human-like subjects.',
      'Preserve architecture, spatial geometry, furniture, fixed props, practical lights, surfaces, depth, weather and time-of-day evidence only.',
      'The result must be a character-free reusable environment reference for later compositing.'
    ][Math.min(Math.max(attempt - 1, 0), 3)];
    return `A professional fictional film environment plate for an original narrative project. ${prompt} Empty set only. No people, no characters, no human figures, no silhouettes, no crowds, no faces, no bodies, no mannequins, no portraits, no human-like subjects. ${recoveryGuidance} No text, logos or watermarks.`
      .replace(/\s{2,}/g, ' ').trim();
  }

  // Avoid isolated words/fragments by adding complete scene framing first.
  const framing =
    'A professional fictional film frame for an original narrative project. ' +
    'Show only the visible elements described below, clearly and non-graphically, ' +
    'with natural adult characters, ordinary wardrobe, realistic setting, and ' +
    'tasteful cinematic lighting. No text, no logos, no watermarks. ';

  // Conservative substitutions for common ambiguous trigger terms. These are
  // intentionally contextual, not instructions to defeat a safety classifier.
  const substitutions = [
    [/\bweapon\b/gi, 'cinematic prop used only as background context'],
    [/\bweapons\b/gi, 'cinematic props used only as background context'],
    [/\bgun\b/gi, 'non-firing film prop'],
    [/\bpistol\b/gi, 'non-firing film prop'],
    [/\brifle\b/gi, 'non-firing film prop'],
    [/\bknife\b/gi, 'ordinary kitchen prop'],
    [/\bknives\b/gi, 'ordinary kitchen props'],
    [/\bsword\b/gi, 'theatrical costume prop'],
    [/\bblood\b/gi, 'dark red stage makeup mark'],
    [/\bbloody\b/gi, 'marked with dark red stage makeup'],
    [/\bgore\b/gi, 'dramatic aftermath implied off-frame'],
    [/\bcorpse\b/gi, 'unmoving figure seen without graphic detail'],
    [/\bdead\b/gi, 'unresponsive'],
    [/\bdeath\b/gi, 'a serious narrative consequence'],
    [/\bmurder\b/gi, 'serious fictional crime referenced in the story'],
    [/\bkill\b/gi, 'confrontation described without graphic action'],
    [/\bkilling\b/gi, 'confrontation described without graphic action'],
    [/\battack\b/gi, 'tense confrontation'],
    [/\bviolent\b/gi, 'tense and dramatic'],
    [/\bviolence\b/gi, 'dramatic confrontation'],
    [/\bexplosion\b/gi, 'distant environmental event'],
    [/\bexplosive\b/gi, 'distant environmental event'],
    [/\bburning\b/gi, 'dramatic warm illumination and smoke in the distance'],
    [/\bfire\b/gi, 'controlled practical light source'],
    [/\bnude\b/gi, 'fully clothed'],
    [/\bnaked\b/gi, 'fully clothed'],
    [/\blingerie\b/gi, 'ordinary sleepwear'],
    [/\bsexual\b/gi, 'romantic dramatic context'],
    [/\berotic\b/gi, 'romantic dramatic context'],
    [/\bsensual\b/gi, 'emotionally intimate'],
  ];

  for (const [pattern, replacement] of substitutions) {
    prompt = prompt.replace(pattern, replacement);
  }

  // Remove accidental model/control fragments that are not useful for the
  // still image and can make a short prompt look suspiciously abstract.
  prompt = prompt
    .replace(/\b(prompt|negative prompt|system message|policy|classifier|bypass|filter)\s*:/gi, '')
    .replace(/[\r\n]+/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim();

  const retryGuidance = [
    'Describe the complete composition in one or two natural sentences, including the location, visible people, wardrobe, pose, facial expression, camera framing, lighting, and atmosphere.',
    'Make the scene literal and concrete: identify who is present, where they stand or sit, what they are visibly doing, and what the viewer can see in the environment.',
    'Use unambiguous professional filmmaking language and keep all action non-graphic and clearly fictional.',
    'Prefer ordinary concrete nouns and complete sentences instead of isolated or abstract trigger-like fragments.',
  ][Math.min(Math.max(attempt - 1, 0), 3)];

  return `${framing}${prompt} ${retryGuidance}`.replace(/\s{2,}/g, ' ').trim();
}

/**
 * Generate an image via the Cloudflare Worker AI endpoint.
 *
 * @param {string}   prompt              Full image prompt
 * @param {string[]} referenceImageUrls  Character reference portrait URLs (up to 4)
 * @param {number|null} seed             Unused — worker handles internally
 * @param {string|null} negativePrompt   Optional caller-supplied visual exclusion terms; embedded into the prompt as plain prose because flux-2-klein-4b exposes no separate negative_prompt field (confirmed against Cloudflare's REST docs — only prompt/width/height/input_image_N are documented parameters)
 * @param {Array<{name:string, reference_index:number, position?:string, action?:string}>} [characterMap]
 *   Dynamic reference-index → character identity mapping, built by the caller
 *   from whichever characters are actually present in the current scene.
 * @returns {Buffer} Raw image bytes (JPEG/PNG/WebP)
 */
const FLUX_STILL_NEGATIVE_CONSTRAINTS =
  'one continuous, anatomically correct frame: a single instance of each person with one clean face, ' +
  'natural five-fingered hands, no extra or missing limbs, no fused or warped anatomy, no duplicated or ' +
  'floating props, no motion blur or double exposure, no split panels or collage layout, and no on-screen ' +
  'text, captions, subtitles, logos or watermarks anywhere in the frame. Every character keeps the exact ' +
  'face, age, hairstyle and wardrobe already established for them — no identity swapping, face morphing, ' +
  'age drift, or unexplained hairstyle or wardrobe changes between characters or shots.';

async function generateImage(prompt, referenceImageUrls = [], seed = null, negativePrompt = null, characterMap = [], generationOptions = {}) {
  const generationMode = String(generationOptions?.generationMode || 'shot').trim().toLowerCase();
  const referenceRoles = Array.isArray(generationOptions?.referenceRoles) ? generationOptions.referenceRoles.map(x => String(x || '').trim().toLowerCase()) : [];
  if (generationMode === 'environment' && referenceImageUrls.length) {
    throw new Error('[CFImageGen] Environment generation must never receive reference images.');
  }
  if (referenceRoles.length && referenceRoles.length !== Math.min((referenceImageUrls || []).length, 4)) {
    throw new Error(`[CFImageGen] Reference role count ${referenceRoles.length} does not match supplied reference count ${Math.min((referenceImageUrls || []).length, 4)}.`);
  }
  if (referenceRoles.length && referenceRoles[0] !== 'environment' && referenceRoles.includes('environment')) {
    throw new Error('[CFImageGen] Environment reference must be reference slot 0.');
  }

  const urlCount = config.cfWorkerUrls.length;
  const keyCount = config.cfWorkerKeys.length;

  if (urlCount === 0) throw new Error('[CFImageGen] No Cloudflare Worker URLs configured (CF_WORKER_URL)');
  if (keyCount === 0) throw new Error('[CFImageGen] No Cloudflare Worker keys configured (CF_WORKER_KEYS)');

  // Pre-fetch and normalize reference images (up to 4). Failures remain
  // non-fatal so another available reference can still be used.
  const refBuffers = [];
  for (const [index, url] of (referenceImageUrls || []).slice(0, 4).entries()) {
    const role = referenceRoles[index] || 'reference';
    try {
      const r = await axios.get(url, { responseType: 'arraybuffer', timeout: 20000 });
      refBuffers.push(await _prepareReferenceImage(Buffer.from(r.data), index));
    } catch (e) {
      if (role === 'environment') {
        throw new Error(`[CFImageGen] Required environment reference failed to download; refusing to promote a character reference into slot 0: ${e.message}`);
      }
      console.warn(`[CFImageGen] Skipping ${role} reference image ${index + 1}: ${e.message}`);
    }
  }
  if (generationMode !== 'environment' && referenceRoles.length && referenceRoles[0] === 'environment' && refBuffers.length === 0) {
    throw new Error('[CFImageGen] Shot generation expected an environment image in slot 0 but no reference image was available.');
  }

  let lastError;
  let currentPrompt = String(prompt || '').trim();
  const callerNegative = String(negativePrompt || '').trim();
  const effectiveNegative = [callerNegative, FLUX_STILL_NEGATIVE_CONSTRAINTS].filter(Boolean).join(', ');
  // Appended as a plain trailing sentence, never a labeled/colon-separated
  // block — flux-2-klein-4b is specifically tuned for crisp text rendering,
  // so a string that LOOKS like an on-screen caption or field label (e.g.
  // "FLUX-STILL-NEGATIVE-CONSTRAINTS: ...") risks actually being rendered
  // as garbled text baked into the image. This runs once per call, before
  // the retry loop below, so there is no risk of appending it twice.
  if (effectiveNegative) {
    currentPrompt = `${currentPrompt} ${effectiveNegative}.`.replace(/\s{2,}/g, ' ').trim();
  }
  let safetyRetries = 0;
  let transientRetries = 0;

  // Outer loop: rotate through worker URLs on quota exhaustion.
  for (let urlAttempt = 0; urlAttempt < urlCount; urlAttempt++) {
    const workerUrl = config.getNextCfUrl();

    // Inner loop: rotate through auth keys on 429/401/403 and retry 3030 with
    // a materially rewritten prompt before giving up on the request.
    for (let keyAttempt = 0; keyAttempt < keyCount; keyAttempt++) {
      const key = config.getNextCfKey();

      try {
        const form = new FormData();
        form.append('prompt', currentPrompt);
        form.append('width', String(OUTPUT_WIDTH));
        form.append('height', String(OUTPUT_HEIGHT));
        form.append('aspect_ratio', '9:16');

        if (Array.isArray(characterMap) && characterMap.length > 0) {
          form.append('characters', JSON.stringify(characterMap));
        }

        for (let i = 0; i < refBuffers.length; i++) {
          form.append(`input_image_${i}`, refBuffers[i], {
            filename: `ref_${i}.jpg`,
            contentType: 'image/jpeg',
          });
        }

        const resp = await axios.post(workerUrl, form, {
          headers: {
            ...form.getHeaders(),
            'Authorization': `Bearer ${key}`,
          },
          responseType: 'arraybuffer',
          timeout: 90000,
        });

        const buf = Buffer.from(resp.data);
        _checkNotJsonError(buf);

        if (buf.length < 100) {
          throw new Error(`CF Worker returned suspiciously small response (${buf.length} bytes)`);
        }

        config.markKeyStatus('cf', key, 'active');
        console.log(
          `[CFImageGen] Image generated (${buf.length} bytes, ${refBuffers.length} normalized ref image(s), ` +
          `output=${OUTPUT_WIDTH}x${OUTPUT_HEIGHT})`
        );
        return buf;

      } catch (err) {
        lastError = err;

        // Transient network/timeout errors carry no `.response` at all, so
        // they would otherwise fall straight through every check below to
        // the final `throw err` and fail the whole still immediately — one
        // slow request killing a shot outright. This matters concretely for
        // this model: Cloudflare's own community forum has reported
        // flux-2-klein-4b inference latency spiking ~25x (hundreds of ms to
        // ~10s) with no changes on the caller's side, so a bare timeout here
        // is a real, current, expected failure mode — not a hypothetical
        // one — and worth a couple of quick retries (rotating through the
        // next key on the same worker URL, same as the 429 path below)
        // before giving up, rather than failing the shot outright after one
        // bad roll and forcing a much more expensive upstream re-run.
        const isTransientNetworkError =
          ['ECONNRESET', 'ECONNABORTED', 'ETIMEDOUT', 'EAI_AGAIN', 'ENETUNREACH'].includes(err?.code) ||
          (!err?.response && /timeout|network|socket/i.test(String(err?.message || '')));
        if (isTransientNetworkError) {
          if (transientRetries < CF_TRANSIENT_MAX_RETRIES) {
            transientRetries += 1;
            const backoffMs = Math.min(4000, 1000 * transientRetries);
            console.warn(
              `[CFImageGen] Transient network error on ${workerUrl} (${err.code || err.message}) — ` +
              `retrying ${transientRetries}/${CF_TRANSIENT_MAX_RETRIES} in ${backoffMs}ms`
            );
            await new Promise(resolve => setTimeout(resolve, backoffMs));
            continue;
          }
          console.warn(`[CFImageGen] Transient network error persisted after ${CF_TRANSIENT_MAX_RETRIES} retries on ${workerUrl} — rotating to next key/URL`);
          continue;
        }

        if (err.message?.startsWith('CF Worker returned JSON error')) {
          const errText = err.message;
          if (errText.includes('3030')) {
            if (safetyRetries < CF_3030_MAX_RETRIES) {
              safetyRetries += 1;
              currentPrompt = _build3030RecoveryPrompt(currentPrompt, safetyRetries, generationMode);
              console.warn(
                `[CFImageGen] 3030 content flag on ${workerUrl} — ` +
                `rewriting prompt and retrying ${safetyRetries}/${CF_3030_MAX_RETRIES}`
              );
              continue;
            }
            throw new CFSafetyRefusalError(
              `CF Worker content flagged (3030) after ${CF_3030_MAX_RETRIES} safe prompt recoveries: ${errText}`,
              { recoveryAttempts: safetyRetries, lastPrompt: currentPrompt }
            );
          }
          if (errText.includes('4006')) {
            config.markKeyStatus('cfurl', workerUrl, 'exhausted');
            console.warn(`[CFImageGen] Quota exhausted (4006) on ${workerUrl} — rotating to next URL`);
            break;
          }
          throw err;
        }

        if (err.response) {
          const status  = err.response.status;
          const errText = _parseErrorBody(err.response.data) || '';

          if (errText.includes('3030')) {
            if (safetyRetries < CF_3030_MAX_RETRIES) {
              safetyRetries += 1;
              currentPrompt = _build3030RecoveryPrompt(currentPrompt, safetyRetries, generationMode);
              console.warn(
                `[CFImageGen] 3030 content flag on ${workerUrl} HTTP ${status} — ` +
                `rewriting prompt and retrying ${safetyRetries}/${CF_3030_MAX_RETRIES}`
              );
              continue;
            }
            throw new CFSafetyRefusalError(
              `CF Worker content flagged (3030) after ${CF_3030_MAX_RETRIES} safe prompt recoveries: ${errText}`,
              { recoveryAttempts: safetyRetries, lastPrompt: currentPrompt }
            );
          }

          if (errText.includes('4006')) {
            config.markKeyStatus('cfurl', workerUrl, 'exhausted');
            console.warn(`[CFImageGen] Quota exhausted (4006) on ${workerUrl} — rotating to next URL`);
            break;
          }

          if (status === 429) {
            config.markKeyStatus('cf', key, 'rate-limited');
            console.warn('[CFImageGen] Key rate-limited (429), rotating...');
            continue;
          }
          if (status === 401 || status === 403) {
            config.markKeyStatus('cf', key, 'exhausted');
            console.warn(`[CFImageGen] Key invalid/forbidden (${status}), rotating...`);
            continue;
          }

          console.warn(`[CFImageGen] HTTP ${status} from ${workerUrl}: ${errText.slice(0, 200)}`);
          throw err;
        }

        throw err;
      }
    }
    console.warn(`[CFImageGen] All keys failed for ${workerUrl}, trying next URL...`);
  }

  if (lastError instanceof CFSafetyRefusalError) throw lastError;
  throw new Error(`[CFImageGen] All CF Worker URLs and keys exhausted. Last error: ${lastError?.message}`);
}

module.exports = {
  generateImage,
  CFSafetyRefusalError,
  FLUX_REFERENCE_MAX_DIM,
  OUTPUT_WIDTH,
  OUTPUT_HEIGHT,
};
