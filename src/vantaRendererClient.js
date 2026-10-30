'use strict';

/**
 * VANTA renderer client.
 *
 * The renderer is a self-describing ComfyUI control plane. We deliberately do
 * not hard-code ComfyUI node IDs, workflow filenames, image field names, or
 * transport encodings. The client discovers:
 *   1. /discovery      -> supported transport conventions
 *   2. /workflows      -> current workflow IDs
 *   3. /workflows/:id  -> the selected workflow's exact input contract
 * and only then constructs { inputs: ... } for the job endpoint.
 */
const axios = require('axios');
const cloudinary = require('./cloudinary');
const config = require('./config');

function normalizeBaseUrl(raw) {
  let value = String(raw || '').trim().replace(/\/+$/, '');
  if (!value) return '';
  value = value.replace(/\/health$/i, '');
  value = value.replace(/\/capabilities$/i, '');
  value = value.replace(/\/openapi\.json$/i, '');
  value = value.replace(/\/workflows$/i, '');
  value = value.replace(/\/discovery$/i, '');
  return value;
}

const BASE_URL = normalizeBaseUrl(process.env.RENDERER_BASE_URL || '');
const API_KEY = String(process.env.RENDERER_API_KEY || '').trim();
const REQUEST_TIMEOUT = Number(process.env.RENDERER_REQUEST_TIMEOUT_MS || 30000);
const POLL_INTERVAL = Number(process.env.RENDERER_POLL_INTERVAL_MS || 5000);
const MAX_POLL_ATTEMPTS = Number(process.env.RENDERER_MAX_POLL_ATTEMPTS || 240);
const DISCOVERY_TTL_MS = Number(process.env.RENDERER_DISCOVERY_TTL_MS || 60000);

// Replit instances (like the one RENDERER_BASE_URL points at) spin down after
// a period of inactivity. The FIRST request that reaches a sleeping instance
// typically comes back 404/502/503 -- or just hangs -- while the container
// wakes up; that is not a real error about the API contract, but it looks
// exactly like one if we don't check for it first.
const HEALTH_TTL_MS = Number(process.env.RENDERER_HEALTH_TTL_MS || 30000);           // how long a confirmed-awake result is trusted before re-checking
const HEALTH_WAIT_TIMEOUT_MS = Number(process.env.RENDERER_HEALTH_WAIT_TIMEOUT_MS || 90000); // total budget to wait for a cold instance to wake up
const HEALTH_POLL_INTERVAL_MS = Number(process.env.RENDERER_HEALTH_POLL_INTERVAL_MS || 3000);
const HEALTH_PROBE_TIMEOUT_MS = Number(process.env.RENDERER_HEALTH_PROBE_TIMEOUT_MS || 10000); // short per-attempt timeout so one slow probe can't eat the whole wait budget

const client = axios.create({
  baseURL: BASE_URL,
  timeout: REQUEST_TIMEOUT,
  headers: API_KEY ? { Authorization: `Bearer ${API_KEY}` } : {},
});

let contractCache = null;
let contractCacheAt = 0;
let lastHealthyAt = 0;

/**
 * Confirms the renderer is actually awake and answering, retrying through
 * whatever transient failure a waking instance produces, BEFORE any
 * discovery/workflow/job call is made. Cached for HEALTH_TTL_MS so a burst of
 * calls doesn't repeat the full wait for each one -- but every real
 * request-making function below calls this first regardless, so no call path
 * (current or future) can accidentally skip the check.
 *
 * Deliberately tolerant during the wait: a 404, a 5xx, a timeout, or a
 * connection error are all treated the same way (keep retrying) since a
 * sleeping instance can produce any of them depending on exactly which layer
 * of Replit's proxy answers before the container is back up. Only exhausting
 * the full wait budget is treated as a real, reportable failure.
 */
async function ensureRendererAwake({ force = false } = {}) {
  if (!BASE_URL) throw new Error('[VANTA] RENDERER_BASE_URL is not configured.');
  if (!force && lastHealthyAt && Date.now() - lastHealthyAt < HEALTH_TTL_MS) return;

  const deadline = Date.now() + HEALTH_WAIT_TIMEOUT_MS;
  let attempt = 0;
  let lastErr = null;
  for (;;) {
    attempt += 1;
    try {
      const resp = await client.get('/health', { timeout: HEALTH_PROBE_TIMEOUT_MS });
      if (resp.status >= 200 && resp.status < 300) {
        if (attempt > 1) {
          console.log(`[VANTA] Renderer is awake (confirmed after ${attempt} health check attempt(s)).`);
        }
        lastHealthyAt = Date.now();
        return;
      }
      lastErr = new Error(`unexpected health status ${resp.status}`);
    } catch (err) {
      lastErr = err;
    }
    if (attempt === 1) {
      console.log(
        '[VANTA] Renderer did not answer /health on the first try -- it may be asleep ' +
        '(Replit instances spin down when idle). Waiting for it to wake up...'
      );
    }
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      throw new Error(
        `[VANTA] Renderer did not become healthy within ${HEALTH_WAIT_TIMEOUT_MS}ms ` +
        `(${attempt} attempt(s)). Last error: ${lastErr?.message || 'unknown'}`
      );
    }
    await new Promise(resolve => setTimeout(resolve, Math.min(HEALTH_POLL_INTERVAL_MS, remaining)));
  }
}

function assertConfigured() {
  if (!BASE_URL) throw new Error('[VANTA] RENDERER_BASE_URL is not configured.');
  if (!API_KEY) throw new Error('[VANTA] RENDERER_API_KEY is not configured.');
}

function responseError(prefix, err) {
  const status = err?.response?.status;
  const data = err?.response?.data;
  let detail = err?.message || 'request failed';
  if (data !== undefined) {
    try { detail = typeof data === 'string' ? data : JSON.stringify(data); } catch (_) { detail = String(data); }
  }
  return new Error(`${prefix}${status ? ` HTTP ${status}` : ''}: ${detail}`);
}

async function getDiscovery() {
  assertConfigured();
  await ensureRendererAwake();
  try {
    const resp = await client.get('/discovery');
    return resp.data || {};
  } catch (err) {
    throw responseError('[VANTA] Discovery request failed', err);
  }
}

async function listWorkflows({ refresh = false } = {}) {
  assertConfigured();
  if (!refresh && contractCache && Date.now() - contractCacheAt < DISCOVERY_TTL_MS) {
    return contractCache.workflows.slice();
  }
  await ensureRendererAwake();
  try {
    const resp = await client.get('/workflows');
    const workflows = Array.isArray(resp.data?.workflows) ? resp.data.workflows : [];
    if (!workflows.length) throw new Error('Renderer returned an empty workflow registry.');
    contractCache = { workflows };
    contractCacheAt = Date.now();
    return workflows.slice();
  } catch (err) {
    throw responseError('[VANTA] Workflow discovery failed', err);
  }
}

async function getWorkflowContract(workflowId) {
  assertConfigured();
  const id = encodeURIComponent(String(workflowId || '').trim());
  if (!id) throw new Error('[VANTA] workflowId is required.');
  await ensureRendererAwake();
  try {
    const resp = await client.get(`/workflows/${id}`);
    return resp.data?.workflow || resp.data || {};
  } catch (err) {
    throw responseError(`[VANTA] Workflow contract lookup failed for ${workflowId}`, err);
  }
}

async function inspectContracts({ refresh = false } = {}) {
  const [discovery, workflows] = await Promise.all([
    getDiscovery(),
    listWorkflows({ refresh }),
  ]);
  const contracts = [];
  for (const workflow of workflows) {
    const id = workflow?.id;
    if (!id) continue;
    contracts.push({ registry: workflow, contract: await getWorkflowContract(id) });
  }
  return { discovery, workflows, contracts };
}

function flattenStrings(value, out = []) {
  if (typeof value === 'string') out.push(value.toLowerCase());
  else if (Array.isArray(value)) for (const item of value) flattenStrings(item, out);
  else if (value && typeof value === 'object') for (const item of Object.values(value)) flattenStrings(item, out);
  return out;
}

function findPathValues(root, wantedKeys) {
  const found = [];
  const wanted = new Set(wantedKeys.map(k => k.toLowerCase()));
  function walk(node, path) {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) {
      node.forEach((v, i) => walk(v, `${path}[${i}]`));
      return;
    }
    for (const [key, value] of Object.entries(node)) {
      const nextPath = path ? `${path}.${key}` : key;
      if (wanted.has(key.toLowerCase())) found.push({ path: nextPath, key, value });
      walk(value, nextPath);
    }
  }
  walk(root, '');
  return found;
}

function extractInputSchema(contract) {
  return contract?.contract?.input || contract?.input || contract?.schema?.input || null;
}

function schemaProperties(contract) {
  const schema = extractInputSchema(contract);
  return schema?.properties && typeof schema.properties === 'object' ? schema.properties : {};
}

function collectTransportHints(discovery) {
  const hints = flattenStrings(discovery);
  const names = new Set();
  for (const hint of hints) {
    if (/data[_-]?url|data url/.test(hint)) names.add('data_url');
    if (/base64|inline[_ -]?base64|encoded/.test(hint)) names.add('base64');
    if (/url|uri|remote/.test(hint)) names.add('url');
    if (/multipart|binary|upload/.test(hint)) names.add('binary');
    if (/cloudinary/.test(hint)) names.add('cloudinary_url');
  }
  return [...names];
}

function semanticScore(workflow, purpose, requirements = {}) {
  const text = [
    workflow?.id,
    workflow?.name,
    workflow?.type,
    workflow?.provider,
    workflow?.comfy_workflow,
    ...(workflow?.capabilities || []),
    ...(workflow?.selection_rules?.use_when || []),
    ...(workflow?.selection_rules?.do_not_use_when || []),
  ].filter(Boolean).join(' ').toLowerCase();

  let score = 0;
  const positive = {
    character: ['character', 'identity', 'canonical', 'portrait', 'reference'],
    environment: ['background', 'environment', 'location', 'empty set', 'plate'],
    scene: ['scene', 'shot', 'composition', 'still', 'image'],
    video: ['video', 'temporal', 'motion', 'first last', 'keyframe', 'i2v'],
    continuity_video: ['first last', 'keyframe', 'continuity', 'temporal'],
  }[purpose] || [purpose];
  for (const token of positive || []) if (text.includes(token)) score += 5;

  const type = String(workflow?.type || '').toLowerCase();
  if (purpose === 'video') score += type === 'video' ? 25 : -20;
  else score += type === 'image' ? 20 : -10;

  if (requirements.referenceCount > 0 && /reference|image/.test(text)) score += 4;
  if (requirements.requiresPrompt && text.includes('prompt')) score += 2;
  return score;
}

function selectWorkflow(workflows, purpose, requirements = {}) {
  const isVideoPurpose = purpose === 'video' || purpose === 'continuity_video';
  const candidates = workflows
    .filter(Boolean)
    .filter(w => isVideoPurpose
      ? String(w.type || '').toLowerCase() === 'video'
      : String(w.type || '').toLowerCase() === 'image')
    .map(w => ({ workflow: w, score: semanticScore(w, purpose, requirements) }))
    .sort((a, b) => b.score - a.score);

  if (!candidates.length) {
    throw new Error(`[VANTA] No ${purpose} workflow exists in the discovered registry.`);
  }
  return candidates[0].workflow;
}

function findProperty(properties, aliases, { required = false } = {}) {
  const entries = Object.entries(properties || {});
  for (const alias of aliases) {
    const exact = entries.find(([key]) => key.toLowerCase() === alias.toLowerCase());
    if (exact) return exact[0];
  }
  for (const alias of aliases) {
    const partial = entries.find(([key]) => key.toLowerCase().includes(alias.toLowerCase()));
    if (partial) return partial[0];
  }
  if (required) throw new Error(`[VANTA] Workflow contract has no compatible input field for: ${aliases.join(', ')}`);
  return null;
}

function schemaAcceptsString(schema) {
  return schema?.type === 'string' || !schema?.type;
}

function isUrlLikeProperty(name, schema) {
  const n = String(name || '').toLowerCase();
  return /url|uri|path|file/.test(n) || schema?.format === 'uri' || schema?.format === 'uri-reference';
}

function toDataUrl(buffer, mime = 'image/jpeg') {
  return `data:${mime};base64,${Buffer.from(buffer).toString('base64')}`;
}

async function uploadImageBuffer(buffer, jobId, suffix) {
  if (!Buffer.isBuffer(buffer) || !buffer.length) throw new Error('[VANTA] Cannot upload an empty image buffer.');
  const mime = detectMime(buffer);
  const publicId = `${config.shotsFolderRoot}/tmp/vanta_input_${jobId}_${suffix}`;
  return cloudinary.uploadImageFromUrl(toDataUrl(buffer, mime), publicId);
}

function detectMime(buf) {
  if (!buf || buf.length < 12) return 'image/png';
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4E && buf[3] === 0x47) return 'image/png';
  if (buf[0] === 0xFF && buf[1] === 0xD8 && buf[2] === 0xFF) return 'image/jpeg';
  if (buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46 && buf[8] === 0x57 && buf[9] === 0x45 && buf[10] === 0x42 && buf[11] === 0x50) return 'image/webp';
  return 'image/png';
}

function requiredInputNames(contract) {
  return new Set(extractInputSchema(contract)?.required || []);
}

/**
 * Encode one image according to the discovered property schema and transport
 * hints. URL transport is preferred because the VANTA API is JSON-based; data
 * URLs/base64 are used only when the discovered contract calls for them.
 */
async function encodeImageForProperty({ propertyName, schema, buffer, uploadedUrl, discovery }) {
  const hints = collectTransportHints(discovery);
  const schemaType = schema?.type;
  if (schemaType === 'array') {
    return [await encodeImageForProperty({ propertyName, schema: schema.items || {}, buffer, uploadedUrl, discovery })];
  }
  if (schemaType === 'object') {
    const properties = schema.properties || {};
    const urlKey = Object.keys(properties).find(k => /url|uri|path/i.test(k));
    const dataKey = Object.keys(properties).find(k => /data|base64|content/i.test(k));
    const typeKey = Object.keys(properties).find(k => /mime|content[_-]?type/i.test(k));
    const out = {};
    if (urlKey && uploadedUrl) out[urlKey] = uploadedUrl;
    else if (dataKey) out[dataKey] = toDataUrl(buffer, detectMime(buffer));
    if (typeKey) out[typeKey] = detectMime(buffer);
    return out;
  }

  if (isUrlLikeProperty(propertyName, schema) && uploadedUrl) return uploadedUrl;
  if (hints.includes('url') || hints.includes('cloudinary_url')) return uploadedUrl || toDataUrl(buffer, detectMime(buffer));
  if (hints.includes('data_url')) return toDataUrl(buffer, detectMime(buffer));
  if (hints.includes('base64')) return Buffer.from(buffer).toString('base64');
  if (schemaAcceptsString(schema)) return uploadedUrl || toDataUrl(buffer, detectMime(buffer));
  throw new Error(`[VANTA] Cannot encode image input ${propertyName}: contract/discovery exposes no compatible JSON transport.`);
}

/** Reduces width/height to a simplified "W:H" ratio string, e.g. 1024x1536 -> "2:3". */
function reduceAspectRatio(width, height) {
  const w = Math.round(Number(width));
  const h = Math.round(Number(height));
  if (!w || !h || !Number.isFinite(w) || !Number.isFinite(h)) return null;
  const gcd = (a, b) => (b === 0 ? a : gcd(b, a % b));
  const g = gcd(w, h) || 1;
  return { ratio: `${w / g}:${h / g}`, value: w / h };
}

/** Picks the closest allowed value from a workflow's aspect_ratio enum by numeric distance, e.g. for a 0.667 target against ["16:9","9:16","1:1","4:3","3:4","21:9"] this correctly picks "3:4" (0.75), not "9:16" (0.5625). */
function closestEnumAspect(enumValues, targetValue) {
  const parse = (s) => {
    const [a, b] = String(s).split(':').map(Number);
    return a && b ? a / b : null;
  };
  let best = null, bestDist = Infinity;
  for (const opt of enumValues || []) {
    const v = parse(opt);
    if (v == null) continue;
    const d = Math.abs(v - targetValue);
    if (d < bestDist) { bestDist = d; best = opt; }
  }
  return best;
}

function setScalarInput(inputs, properties, required, aliases, value) {
  const key = findProperty(properties, aliases, { required: required && value != null });
  if (key && value != null) inputs[key] = value;
  return key;
}

async function buildInputs({ contract, discovery, purpose, prompt, negativePrompt, seed, width, height, referenceImages = [], firstImageBuffer = null, lastImageBuffer = null, duration = null, extra = {} }) {
  const properties = schemaProperties(contract);
  const required = requiredInputNames(contract);
  const inputs = {};

  setScalarInput(inputs, properties, required.has('prompt'), ['prompt', 'positive_prompt', 'text'], prompt);
  if (negativePrompt) setScalarInput(inputs, properties, required.has('negative_prompt'), ['negative_prompt', 'negativePrompt', 'negative'], negativePrompt);
  if (seed != null) setScalarInput(inputs, properties, required.has('seed'), ['seed', 'random_seed', 'randomSeed'], seed);
  if (width != null) setScalarInput(inputs, properties, required.has('width'), ['width', 'output_width', 'image_width'], width);
  if (height != null) setScalarInput(inputs, properties, required.has('height'), ['height', 'output_height', 'image_height'], height);
  if (duration != null) setScalarInput(inputs, properties, required.has('duration'), ['duration', 'seconds', 'end_seconds', 'video_duration'], duration);
  if (width != null && height != null) {
    const key = findProperty(properties, ['aspect_ratio', 'aspectRatio'], { required: required.has('aspect_ratio') });
    if (key) {
      const reduced = reduceAspectRatio(width, height);
      if (reduced) {
        const schema = properties[key];
        const value = Array.isArray(schema?.enum) ? (closestEnumAspect(schema.enum, reduced.value) || schema.enum[0]) : reduced.ratio;
        if (value) inputs[key] = value;
      }
    }
  }

  if (purpose !== 'environment' && referenceImages.length) {
    const refKey = findProperty(properties, ['reference_images', 'reference_image_urls', 'references', 'input_images', 'images', 'reference_image', 'image'], { required: false });
    if (refKey) {
      const schema = properties[refKey];
      const cloudinaryUrls = [];
      for (let i = 0; i < referenceImages.length; i++) {
        const upload = await uploadImageBuffer(referenceImages[i], `${Date.now()}`, `ref_${i}`);
        cloudinaryUrls.push(upload);
      }
      if (schema?.type === 'array') {
        const maxItems = Number.isFinite(Number(schema.maxItems)) ? Number(schema.maxItems) : referenceImages.length;
        const minItems = Number.isFinite(Number(schema.minItems)) ? Number(schema.minItems) : 0;
        if (referenceImages.length < minItems) {
          throw new Error(`[VANTA] Workflow requires at least ${minItems} reference image(s) for ${refKey}, but only ${referenceImages.length} were supplied.`);
        }
        const useCount = Math.min(referenceImages.length, maxItems);
        inputs[refKey] = [];
        for (let i = 0; i < useCount; i++) {
          inputs[refKey].push(await encodeImageForProperty({ propertyName: refKey, schema: schema.items || {}, buffer: referenceImages[i], uploadedUrl: cloudinaryUrls[i], discovery }));
        }
      } else {
        inputs[refKey] = await encodeImageForProperty({ propertyName: refKey, schema, buffer: referenceImages[referenceImages.length - 1], uploadedUrl: cloudinaryUrls[cloudinaryUrls.length - 1], discovery });
      }

      // ComfyUI-oriented contracts may expose fixed slots such as
      // input_image_0/input_image_1 rather than an array. Populate those slots
      // from the same discovered transport rules, in stable input order.
      const numberedImageKeys = Object.keys(properties)
        .filter(key => /^(?:input_)?image[_-]?\d+$|^reference[_-]?image[_-]?\d+$/i.test(key))
        .sort((a, b) => Number(a.match(/\d+$/)?.[0] || 0) - Number(b.match(/\d+$/)?.[0] || 0));
      for (let i = 0; i < Math.min(numberedImageKeys.length, referenceImages.length); i++) {
        const key = numberedImageKeys[i];
        if (inputs[key] !== undefined) continue;
        inputs[key] = await encodeImageForProperty({ propertyName: key, schema: properties[key], buffer: referenceImages[i], uploadedUrl: cloudinaryUrls[i], discovery });
      }
    }
  }

  if (firstImageBuffer) {
    const key = findProperty(properties, ['first_image', 'first_frame', 'start_image', 'start_frame', 'image_a', 'keyframe_a'], { required: false });
    if (key) {
      const upload = await uploadImageBuffer(firstImageBuffer, `${Date.now()}`, 'first');
      inputs[key] = await encodeImageForProperty({ propertyName: key, schema: properties[key], buffer: firstImageBuffer, uploadedUrl: upload, discovery });
    }
  }

  if (lastImageBuffer) {
    const key = findProperty(properties, ['last_image', 'last_frame', 'end_image', 'end_frame', 'image_b', 'keyframe_b'], { required: false });
    if (key) {
      const upload = await uploadImageBuffer(lastImageBuffer, `${Date.now()}`, 'last');
      inputs[key] = await encodeImageForProperty({ propertyName: key, schema: properties[key], buffer: lastImageBuffer, uploadedUrl: upload, discovery });
    }
    const slot1 = Object.keys(properties).find(key => /^(?:input_)?image[_-]?1$|^reference[_-]?image[_-]?1$/i.test(key));
    if (slot1 && inputs[slot1] === undefined) {
      const upload = await uploadImageBuffer(lastImageBuffer, `${Date.now()}`, 'last_slot');
      inputs[slot1] = await encodeImageForProperty({ propertyName: slot1, schema: properties[slot1], buffer: lastImageBuffer, uploadedUrl: upload, discovery });
    }
  }

  // Supply contract defaults where they exist. This is not model-specific
  // guessing: the workflow itself owns the declared default.
  for (const [key, schema] of Object.entries(properties)) {
    if (inputs[key] !== undefined || schema?.default === undefined) continue;
    inputs[key] = schema.default;
  }

  for (const [key, value] of Object.entries(extra || {})) {
    const exact = findProperty(properties, [key], { required: false });
    if (exact) inputs[exact] = value;
  }

  // A strict final required-field check catches mismatches before a paid render
  // job is created. This is the important contract guardrail.
  const missing = [...required].filter(key => inputs[key] === undefined || inputs[key] === null || inputs[key] === '');
  if (missing.length) {
    throw new Error(`[VANTA] Contract validation would fail before submission. Missing inputs: ${missing.join(', ')}. Workflow=${contract.id || contract.workflow_id || purpose}`);
  }
  return inputs;
}

async function createJob(workflowId, inputs) {
  assertConfigured();
  await ensureRendererAwake();
  try {
    const resp = await client.post(`/workflows/${encodeURIComponent(workflowId)}/jobs`, { inputs });
    const job = resp.data || {};
    const jobId = job.job_id || job.id;
    if (!jobId) throw new Error(`Renderer accepted no job id: ${JSON.stringify(job)}`);
    return job;
  } catch (err) {
    throw responseError(`[VANTA] Job submission failed for workflow ${workflowId}`, err);
  }
}

async function getJob(jobId) {
  assertConfigured();
  await ensureRendererAwake();
  try {
    const resp = await client.get(`/jobs/${encodeURIComponent(jobId)}`);
    return resp.data || {};
  } catch (err) {
    throw responseError(`[VANTA] Job status lookup failed for ${jobId}`, err);
  }
}

async function getResult(jobId) {
  assertConfigured();
  await ensureRendererAwake();
  try {
    const resp = await client.get(`/jobs/${encodeURIComponent(jobId)}/result`);
    return resp.data || {};
  } catch (err) {
    throw responseError(`[VANTA] Job result lookup failed for ${jobId}`, err);
  }
}

async function cancelJob(jobId) {
  assertConfigured();
  await ensureRendererAwake();
  const resp = await client.post(`/jobs/${encodeURIComponent(jobId)}/cancel`);
  return resp.data || {};
}

function extractArtifactUrl(value, seen = new Set()) {
  if (!value || seen.has(value)) return null;
  if (typeof value === 'string' && /^https?:\/\//i.test(value)) return value;
  if (typeof value !== 'object') return null;
  seen.add(value);
  const directKeys = ['video_url', 'videoUrl', 'image_url', 'imageUrl', 'url', 'download_url', 'downloadUrl', 'output_url', 'outputUrl', 'file_url', 'fileUrl'];
  for (const key of directKeys) {
    if (typeof value[key] === 'string' && /^https?:\/\//i.test(value[key])) return value[key];
  }
  for (const nestedValue of Object.values(value)) {
    if (Array.isArray(nestedValue)) {
      for (const item of nestedValue) {
        const url = extractArtifactUrl(item, seen);
        if (url) return url;
      }
    } else if (nestedValue && typeof nestedValue === 'object') {
      const url = extractArtifactUrl(nestedValue, seen);
      if (url) return url;
    }
  }
  return null;
}

async function poll(jobId, { intervalMs = POLL_INTERVAL, maxAttempts = MAX_POLL_ATTEMPTS } = {}) {
  let last = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    last = await getJob(jobId);
    const status = String(last.status || last.state || '').toLowerCase();
    if (['completed', 'complete', 'done', 'succeeded', 'success'].includes(status)) {
      const result = await getResult(jobId);
      return { job: last, result, url: extractArtifactUrl(result) || extractArtifactUrl(last) };
    }
    if (['failed', 'error', 'cancelled', 'canceled'].includes(status)) {
      throw new Error(`[VANTA] Job ${jobId} failed: ${JSON.stringify(last.error || last)}`);
    }
    await new Promise(resolve => setTimeout(resolve, intervalMs));
  }
  throw new Error(`[VANTA] Job ${jobId} did not complete after ${maxAttempts} polling attempts. Last state: ${JSON.stringify(last)}`);
}

async function renderImage({ prompt, referenceImageBuffers = [], negativePrompt = null, seed = null, width = 1024, height = 1536, generationMode = 'shot', extra = {} } = {}) {
  const [discovery, workflows] = await Promise.all([getDiscovery(), listWorkflows()]);
  const purpose = generationMode === 'environment' ? 'environment' : generationMode === 'character' ? 'character' : 'scene';
  const workflow = selectWorkflow(workflows, purpose, { referenceCount: referenceImageBuffers.length, requiresPrompt: true });
  const contract = await getWorkflowContract(workflow.id);
  const inputs = await buildInputs({
    contract,
    discovery,
    purpose,
    prompt,
    negativePrompt,
    seed,
    width,
    height,
    referenceImages: referenceImageBuffers,
    extra,
  });
  const submitted = await createJob(workflow.id, inputs);
  const jobId = submitted.job_id || submitted.id;
  const completed = await poll(jobId);
  if (!completed.url) throw new Error(`[VANTA] Image workflow ${workflow.id} completed without a usable image URL.`);
  const imageResp = await axios.get(completed.url, { responseType: 'arraybuffer', timeout: 60000 });
  return Buffer.from(imageResp.data);
}

async function renderVideo({ imageBuffer, referenceImageBuffers = [], prompt, negativePrompt = null, seed = null, duration, width, height, extra = {} } = {}) {
  const [discovery, workflows] = await Promise.all([getDiscovery(), listWorkflows()]);
  const videoPurpose = refsCount(referenceImageBuffers, imageBuffer) > 1 ? 'continuity_video' : 'video';
  const workflow = selectWorkflow(workflows, videoPurpose, { referenceCount: referenceImageBuffers.length, requiresPrompt: true });
  const contract = await getWorkflowContract(workflow.id);
  const refs = referenceImageBuffers.length ? referenceImageBuffers : (imageBuffer ? [imageBuffer] : []);
  const inputs = await buildInputs({
    contract,
    discovery,
    purpose: 'video',
    prompt,
    negativePrompt,
    seed,
    width,
    height,
    referenceImages: refs,
    firstImageBuffer: refs[0] || null,
    lastImageBuffer: refs.length > 1 ? refs[refs.length - 1] : null,
    duration,
    extra,
  });
  const submitted = await createJob(workflow.id, inputs);
  return { jobId: submitted.job_id || submitted.id, workflowId: workflow.id };
}

function resetCache() { contractCache = null; contractCacheAt = 0; lastHealthyAt = 0; }

module.exports = {
  normalizeBaseUrl,
  ensureRendererAwake,
  reduceAspectRatio,
  closestEnumAspect,
  getDiscovery,
  listWorkflows,
  getWorkflowContract,
  inspectContracts,
  selectWorkflow,
  schemaProperties,
  buildInputs,
  encodeImageForProperty,
  collectTransportHints,
  createJob,
  getJob,
  getResult,
  cancelJob,
  poll,
  extractArtifactUrl,
  renderImage,
  renderVideo,
  resetCache,
  configured: () => Boolean(BASE_URL && API_KEY),
  baseUrl: BASE_URL,
};
