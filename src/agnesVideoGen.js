'use strict';

/**
 * StreamVerse Studio — Agnes Video V2.0 image-to-video integration.
 *
 * Agnes sequential shots use two ordered visual keyframes:
 *   1) the exact terminal frame of the previous shot;
 *   2) a freshly constructed current-shot still produced from the authored target
 *      state plus canonical scene/character references.
 * The predecessor frame is continuity evidence and keyframe A, never the canvas
 * used to construct keyframe B. Agnes V2 keyframe mode then creates the physical
 * A -> B bridge while the Vision Director reads the same pair for motion direction.
 */

const config = require('./config');
const videoEngineClient = require('../services/videoEngineClient');
const ltxVisionDirector = require('./ltxVisionDirector');
const shotContinuity = require('./shotContinuity');

const DEFAULT_MIN_DURATION = 1;
const DEFAULT_MAX_DURATION = 18;
const DEFAULT_WIDTH = 1024;
const DEFAULT_HEIGHT = 1536;
const DEFAULT_NEGATIVE_PROMPT = [
  // Text / overlay suppression
  'garbled text','gibberish','misspelled words','distorted lettering','unreadable text',
  'random symbols','subtitles','captions','closed captions','dialogue captions',
  'text overlays','UI overlays','title cards','watermarks','logos','extra typography',
  'floating text','duplicated text','malformed signs','malformed labels','screen text',
  'extra written words','on-screen graphics','words appearing from nowhere',
  // Character identity / morphology suppression
  'character morphing','face morphing','identity drift','identity swapping','face swapping',
  'hybrid faces','merged faces','duplicated faces','age drift','age changing','body-shape drift',
  'hairstyle changes','hair color changes','skin-tone drift','wardrobe changes','costume changes',
  'extra people','duplicate people','vanishing characters','character cloning','character replacement',
  // Anatomy / temporal artifact suppression
  'extra arms','extra legs','extra hands','extra fingers','missing fingers','fused fingers',
  'fused hands','malformed hands','rubbery limbs','stretched limbs','warped anatomy',
  'deformed face','melted facial features','distorted teeth','crossed eyes','eye drift',
  'wandering eyes','unnatural blinking','random mouth movement','mouth deformation','teeth popping',
  'lip-sync drift','wrong-character lip-sync','ghosting','temporal smear','double exposure',
  'frame flicker','texture swimming','background warping','geometry drift','object duplication',
  'prop morphing','floating props','disappearing props','phantom objects',
  // Artificial-performance suppression
  'robotic movement','mechanical movement','puppet-like motion','mannequin movement',
  'rubber-like motion','sliding feet','foot skating','weightless motion','teleporting',
  'instant pose changes','unmotivated gestures','synchronized character motion',
  'identical reactions','random secondary-character motion','random background activity',
  'camera jitter','unmotivated camera shake','excessive zoom','excessive camera movement',
  'motion blur','smearing','low-detail faces',
].join(', ');
function _positive(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function _resolveDuration(shotMeta = {}) {
  const requested = Number(shotMeta.duration);
  const duration = Number.isFinite(requested) ? requested : DEFAULT_MIN_DURATION;
  // Agnes owns an 18-second ceiling. Ignore legacy AGNES_MAX_DURATION values.
  const maxDuration = DEFAULT_MAX_DURATION;
  return Math.min(maxDuration, Math.max(DEFAULT_MIN_DURATION, duration));
}

function _resolveDimensions(shotMeta = {}) {
  return {
    width: Math.floor(_positive(shotMeta.width, _positive(process.env.AGNES_WIDTH, DEFAULT_WIDTH))),
    height: Math.floor(_positive(shotMeta.height, _positive(process.env.AGNES_HEIGHT, DEFAULT_HEIGHT))),
  };
}

function _resolveNegativePrompt(shotMeta = {}) {
  return String(
    shotMeta.negativePrompt ||
    shotMeta.agnesNegativePrompt ||
    process.env.AGNES_NEGATIVE_PROMPT ||
    DEFAULT_NEGATIVE_PROMPT
  ).trim();
}

// Schema/frame-extraction/persistence and predecessor-frame resolution now
// live in shotContinuity.js, shared with the LTX-2.3 First-Last-Frame
// provider so both backends honor the exact same continuity contract.
async function _resolveAgnesStartingImage(imageBuffer, shotMeta = {}) {
  // Agnes keyframe order is semantically meaningful: A = predecessor, B =
  // freshly rendered current opening still. shotContinuity guarantees this
  // ordering already; never reverse it here.
  return shotContinuity.resolveContinuityStartingImage(imageBuffer, shotMeta, 'AgnesVideoGen');
}

async function retrieveContinuityFrames(videoUrl) {
  return shotContinuity.retrieveContinuityFrames(videoUrl, 'AgnesVideoGen');
}

async function _persistContinuityFrames(videoUrl, continuity, jobId = null) {
  return shotContinuity.persistContinuityFrames(videoUrl, continuity, jobId, 'AgnesVideoGen');
}

async function _buildFinalAgnesPrompt(imageBuffer, shotMeta = {}, continuity = {}) {
  const authoredIntent = String(shotMeta._agnesPromptOverride || shotMeta.agnesPrompt || shotMeta.videoPrompt || '').trim();
  const visionContext = shotMeta.visionContext || {};
  const shot = { ...(visionContext.shot || {}), ...shotMeta };
  if (authoredIntent) {
    shot.ltx_shot_description = authoredIntent;
    shot.shot_description = shot.shot_description || authoredIntent;
    shot.authored_ltx_intent = authoredIntent;
  }

  // Scene continuity bible — same shared directive text LTX receives, so
  // axis of action / wardrobe / active props / lighting stay identical
  // regardless of which provider is selected. See shotContinuity.js.
  const sceneContinuityDirective = shotContinuity.formatSceneContinuityDirective(shotMeta.sceneContinuityBible);
  if (sceneContinuityDirective) {
    shot.scene_continuity_directive = sceneContinuityDirective;
  }

  const continuityInstruction = continuity.usedContinuityFrame
    ? 'KEYFRAME CONTINUITY CONTRACT: keyframe A is the exact previous-shot terminal frame; keyframe B is the freshly constructed current-shot still. The pair defines a physical A-to-B transition. Use the director-specified bridge to connect the states; never teleport, reset, mirror, swap, replace, clone, age, or morph characters. Keyframe B is a settled target state, not an in-between frame.'
      + (shotMeta.motionPhaseAtCut
          ? ` MATCH ON ACTION: keyframe A was captured mid-motion at this exact phase — "${shotMeta.motionPhaseAtCut}". Continue that motion from that precise phase; do not restart the gesture from rest.`
          : '')
    : 'The supplied image is the authoritative authored opening still for this shot. Begin from that exact visual state. Do not redesign the composition, replace characters, or invent new identities.';

  const behaviorGuardrail = [
    'CHARACTER PERFORMANCE GUARDRAILS: perform only movement that is explicitly present in the authored shot intent or necessary for the exact dialogue beat.',
    'Do not invent independent movement for every visible person. Silent listeners and background people may remain mostly still; use only small natural reactions when they are explicitly supported by the shot.',
    'Never make multiple characters move in synchronized or mirrored ways unless the story explicitly requires coordination.',
    'Preserve stable facial identity, hair, wardrobe, body proportions, age, skin/features, and spatial identity throughout the shot.',
    'Do not introduce spontaneous smiles, blinks, head turns, hand gestures, eye darts, mouth movements, prop interactions, or background activity merely to make the frame feel alive.',
    'CREATIVE COMMITMENT: within those limits, fully commit to and richly render exactly what IS authored. Give the specified action genuine emotional truth and natural performance nuance rather than a flat or robotic reading of it. Atmosphere is welcome and encouraged: lighting mood, environmental motion consistent with the scene (drifting smoke, dust, rain, wind moving hair or loose fabric, practical light flicker) and a considered, purposeful camera move all serve the shot as written. This is about depth and craft in performing the authored moment, never about adding new plot action, new gestures, new dialogue, or anything not already specified.',
    'Maintain grounded weight, foot contact and believable body mechanics. No sliding feet, rubber limbs, puppet-like movement, mannequin motion, or sudden pose snaps.',
    continuity.usedContinuityFrame
      ? 'The two ordered keyframes are the continuity anchors. The transition must be physically plausible and causally connect their geometry; never invent a third arbitrary starting composition.'
      : 'The current still is settled and authoritative. Do not create an artificial transition from an invented pose; start exactly from the supplied pixels and evolve only the authored action.',
  ].join(' ');

  const dialogueInstruction = /(?:dialogue|speaker|speaking|"|“|”|tts_mode)/i.test(String(shot.dialogue_or_action || shot.videoPrompt || shot.agnesPrompt || ''))
    ? 'This is a live-action conversational performance. Preserve exact speaker attribution, let the correct speaker visibly articulate the words, and give listening characters natural reactive facial and body performance without inventing extra dialogue.'
    : '';

  const result = await ltxVisionDirector.describeForLTX({
    imageBuffer,
    imageMime: visionContext.imageMime || 'image/png',
    shot,
    scene: visionContext.scene || {},
    characters: visionContext.characters || [],
    repairInstruction: `${continuityInstruction}${dialogueInstruction ? ` ${dialogueInstruction}` : ''} ${behaviorGuardrail}`,
  });
  const finalPrompt = String(result || '').trim();
  if (!finalPrompt) throw new Error('[AgnesVideoGen] Vision Director returned an empty final Agnes prompt');

  const providerPrompt = `${continuityInstruction} ${behaviorGuardrail} ${dialogueInstruction ? `${dialogueInstruction} ` : ''}${finalPrompt}`.trim();

  // Persist the EXACT string that will be passed to the Agnes HTTP request.
  // This is intentionally after all Vision Director/continuity composition.
  if (typeof shotMeta._promptCapture === 'function') {
    try {
      await shotMeta._promptCapture(providerPrompt);
    } catch (captureErr) {
      console.warn(`[AgnesVideoGen] Exact prompt persistence failed (non-fatal): ${captureErr.message}`);
    }
  }

  console.log('[AgnesVideoGen] FINAL VISION-DIRECTOR PROMPT:');
  console.log(providerPrompt);
  return providerPrompt;
}

class AgnesGenerationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'AgnesGenerationError';
    Error.captureStackTrace?.(this, AgnesGenerationError);
  }
}

async function submitVideoJob(imageBuffer, shotMeta = {}) {
  if (!Buffer.isBuffer(imageBuffer) || imageBuffer.length === 0) throw new AgnesGenerationError('[AgnesVideoGen] submitVideoJob received an empty image buffer.');

  let startingImage;
  try {
    startingImage = await _resolveAgnesStartingImage(imageBuffer, shotMeta);
  } catch (err) {
    if (err instanceof AgnesGenerationError) throw err;
    throw new AgnesGenerationError(`[AgnesVideoGen] Failed to resolve shot continuity start frame: ${err.message}`);
  }

  const prompt = await _buildFinalAgnesPrompt(startingImage.imageBuffer, shotMeta, startingImage);
  const duration = _resolveDuration(shotMeta);
  const { width, height } = _resolveDimensions(shotMeta);
  const negativePrompt = _resolveNegativePrompt(shotMeta);
  const seed = Number.isFinite(Number(shotMeta.seed)) ? Math.floor(Number(shotMeta.seed)) : null;

  try {
    const { jobId } = await videoEngineClient.submitJob({
      provider: 'agnes',
      imageBuffer: startingImage.imageBuffer,
      referenceImageBuffers: startingImage.referenceImageBuffers,
      prompt,
      duration,
      width,
      height,
      seed,
      negativePrompt,
      randomizeSeed: false,
      enhancePrompt: false,
    });
    console.log(
      startingImage.usedContinuityFrame
        ? '[AgnesVideoGen] Agnes keyframes submitted in order: [previous_end_frame, fresh_current_shot_still].'
        : '[AgnesVideoGen] Agnes I2V starting from the fresh current-shot still (single keyframe).'
    );
    return { jobId, apiKey: '... (redacted)' };
  } catch (err) {
    throw err instanceof AgnesGenerationError ? err : new AgnesGenerationError(`[AgnesVideoGen] Submission failed: ${err.message}`);
  }
}

async function pollVideoJob(jobId) {
  const result = await videoEngineClient.pollJob(jobId);
  const videoUrl = typeof result === 'string'
    ? result.trim()
    : String(result?.video_url || result?.videoUrl || result?.url || '').trim();

  if (!videoUrl) {
    throw new AgnesGenerationError(
      `[AgnesVideoGen] Job ${jobId} completed without a usable video_url`
    );
  }

  const continuity = await retrieveContinuityFrames(videoUrl);
  await _persistContinuityFrames(videoUrl, continuity, jobId);

  // Provider contract: pollVideoJob() returns the finished video URL, not the
  // transport/job response object. The pipeline passes this value directly to
  // Cloudinary's uploadVideoFromUrl(). Returning the whole object here causes
  // Cloudinary to receive "[object Object]" as its source URL.
  return videoUrl;
}

module.exports = {
  submitVideoJob,
  pollVideoJob,
  retrieveContinuityFrames,
  AgnesGenerationError,
  providerName: 'agnes',
};
