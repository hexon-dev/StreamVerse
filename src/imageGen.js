'use strict';
/**
 * StreamVerse Image Generation Router
 *
 * All image generation — shots, character portraits, scene images — is routed
 * exclusively through the Cloudflare Worker AI endpoint.
 *
 * CFSafetyRefusalError is re-thrown immediately so the caller (pipeline) can
 * rewrite the prompt instead of retrying the same flagged text.
 */
const config     = require('./config');
const cfImageGen = require('./cfImageGen');
const vantaImageGen = require('./vantaImageGen');
const { CFSafetyRefusalError } = cfImageGen;

async function generateImage(prompt, referenceImageUrls = [], seed = null, negativePrompt = null, characterMap = [], generationOptions = {}) {
  if (process.env.RENDERER_BASE_URL && process.env.RENDERER_API_KEY && process.env.IMAGE_RENDERER !== 'cloudflare') {
    return vantaImageGen.generateImage(prompt, referenceImageUrls, seed, negativePrompt, characterMap, generationOptions);
  }

  if (config.cfWorkerUrls.length === 0 || config.cfWorkerKeys.length === 0) {
    throw new Error('[ImageGen] No image generation backend configured. Set RENDERER_BASE_URL + RENDERER_API_KEY for VANTA or CF_WORKER_URL + CF_WORKER_KEYS for Cloudflare fallback.');
  }

  return cfImageGen.generateImage(prompt, referenceImageUrls, seed, negativePrompt, characterMap, generationOptions);
}

module.exports = { generateImage, CFSafetyRefusalError };
