'use strict';
/**
 * Contract shapes captured from the LIVE VANTA service (contract_version 1.3,
 * GET /api/vanta/v1/workflows, 2026-09-27). Reduced to the fields the client
 * actually consumes: id/type/provider/capabilities/selection_rules, and each
 * input property's type, required flag, default, enum and constraints.
 *
 * Why this exists: the original client tests used hand-written mock contracts
 * with generic field names (reference_images, first_frame...). The real
 * contract uses named slots (reference_1, character_a, location,
 * shot_start_frame...), so mocked tests passed while the live service was
 * being sent text-only requests. Tests should run against the real shapes.
 */
const IMG = { type: 'image', transport: { kind: 'image_reference', accepted: [{ format: 'http_url' }, { format: 'data_uri_base64' }, { format: 'base64_object' }, { format: 'url_object' }] } };
const img = (description, extra = {}) => ({ ...IMG, description, ...extra });

const wf = (id, type, provider, capabilities, use_when, do_not_use_when, required, properties, extra = {}) => ({
  id, version: '1.0', name: id, type, provider, capabilities, comfy_workflow: `${id}.json`,
  selection_rules: { use_when, do_not_use_when },
  contract: { input: { type: 'object', required, properties } }, ...extra,
});

const QUALITY_IMG = { type: 'string', enum: ['1K', '2K', '3K', '4K'], default: '2K' };
const QUALITY_VID = { type: 'string', enum: ['480P', '720P', '1080P', '1K', '2K'], default: '720P' };
const ASPECT_VID = { type: 'string', default: '16:9', enum: ['auto', '16:9', '9:16', '1:1', '4:3', '3:4', '21:9'] };
const SEED = { type: 'integer', default: 0, constraints: { minimum: 0, maximum: 2147483647 } };

module.exports = [
  wf('character_master', 'image', 'Agnes', ['canonical_character_reference', 'identity_anchor', 'optional_reference_composition'],
    ['Create or refresh a canonical character identity image that downstream shots can reference.'], ['A moving video clip is required.'],
    ['prompt'], {
      prompt: { type: 'string' }, reference_1: img('r1'), reference_2: img('r2'), reference_3: img('r3'), reference_4: img('r4'),
      quality: QUALITY_IMG, aspect_ratio: { type: 'string', default: '3:4' }, seed: SEED,
    }),
  wf('scene_composer', 'image', 'Agnes', ['multi_character_composition', 'location_reference', 'wardrobe_or_prop_reference', 'visual_scene_generation'],
    ['Compose a scene image using zero or more character, location, wardrobe, prop or style references.'], ['The required output is video rather than a still frame.'],
    ['prompt'], {
      prompt: { type: 'string' }, character_a: img('a'), character_b: img('b'), location: img('loc'), wardrobe_or_prop: img('w'),
      quality: QUALITY_IMG, aspect_ratio: { type: 'string', default: '16:9' }, seed: SEED,
    }),
  wf('continuity_reconstructor', 'image', 'Agnes', ['previous_frame_anchor', 'character_identity_reanchor', 'location_reference', 'shot_continuity_reconstruction'],
    ["Generate the next shot's frame while explicitly preserving the prior shot's visual state."], ['No previous frame or continuity anchor exists.'],
    ['prompt', 'previous_end_frame'], {
      prompt: { type: 'string' }, previous_end_frame: img('prev', { required: true }), character_a: img('a'), character_b: img('b'), current_location: img('loc'),
      quality: QUALITY_IMG, aspect_ratio: { type: 'string', default: '16:9' }, seed: SEED,
    }),
  wf('agnes_reference_video', 'video', 'Agnes', ['reference_video', 'image_to_video', 'multi_reference_video', 'motion_generation'],
    ['A shot image exists and should be animated with optional supporting references.'], ['Both exact first and target last frames must be prescribed; use first_last_frame.'],
    ['prompt', 'shot_start_frame'], {
      prompt: { type: 'string' }, shot_start_frame: img('start', { required: true }), character_a: img('a'), character_b: img('b'), location: img('loc'),
      wardrobe_or_prop: img('w'), style_or_previous_frame: img('style'),
      quality: QUALITY_VID, aspect_ratio: ASPECT_VID, duration: { type: 'integer', default: 8, constraints: { minimum: 4, maximum: 12 } }, seed: SEED,
    }),
  wf('first_last_frame', 'video', 'Agnes', ['first_frame_conditioning', 'last_frame_conditioning', 'keyframe_interpolation', 'temporal_transition'],
    ['Both opening and target ending visual states are known.'], ['Only one frame is known; use a one-frame/reference video workflow.'],
    ['prompt', 'first_frame', 'last_frame'], {
      prompt: { type: 'string' }, first_frame: img('first', { required: true }), last_frame: img('last', { required: true }),
      quality: QUALITY_VID, aspect_ratio: ASPECT_VID, duration: { type: 'integer', default: 8, constraints: { minimum: 4, maximum: 12 } }, seed: SEED,
    }),
  wf('ltx_first_last_frame', 'video', 'LTX-2.3 / Hugging Face Space', ['first_frame_conditioning', 'last_frame_conditioning', 'temporal_transition', 'LTX23_video_generation', 'HF_token_rotation'],
    ['Both start and target end frames are available and LTX-2.3 should render the transition.'], ['Only a still image is required or no endpoint frames are available.'],
    ['prompt', 'first_frame', 'last_frame'], {
      prompt: { type: 'string' }, first_frame: img('first', { required: true }), last_frame: img('last', { required: true }),
      duration: { type: 'number', default: 8.0, constraints: { minimum: 1.0, maximum: 10.0 } }, enhance_prompt: { type: 'boolean', default: false },
      seed: { type: 'integer', default: 42, constraints: { minimum: 0, maximum: 2147483647 } }, randomize_seed: { type: 'boolean', default: false },
      width: { type: 'integer', default: 1536, constraints: { minimum: 256, maximum: 4096 } }, height: { type: 'integer', default: 1024, constraints: { minimum: 256, maximum: 4096 } },
    }),
  wf('cloudflare_klein_multi_reference', 'image', 'Cloudflare Workers AI', ['multi_character_reference', 'multi_reference_editing', 'identity_preservation', 'cloudflare_workers_ai_retry_classification'],
    ['A still image requires up to four reference images and the Cloudflare-hosted FLUX.2 Klein 9B multi-reference model is available.'], ['Exact first/last-frame video conditioning is required.', 'More than four references must be passed in one generation request.'],
    ['prompt', 'worker_url'], {
      prompt: { type: 'string' }, reference_1: img('r1'), reference_2: img('r2'), reference_3: img('r3'), reference_4: img('r4'),
      character_mapping: { type: 'string' }, worker_url: { type: 'string' }, max_retries: { type: 'integer', default: 3 }, seed: SEED,
      width: { type: 'integer', default: 768, constraints: { minimum: 256, maximum: 4096 } }, height: { type: 'integer', default: 1365, constraints: { minimum: 256, maximum: 4096 } },
    }),
];
