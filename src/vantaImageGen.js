'use strict';
const vanta = require('./vantaRendererClient');

async function generateImage(prompt, referenceImageUrls = [], seed = null, negativePrompt = null, characterMap = [], generationOptions = {}) {
  const axios = require('axios');
  const buffers = [];
  for (const url of (referenceImageUrls || []).slice(0, 8)) {
    const response = await axios.get(url, { responseType: 'arraybuffer', timeout: 30000 });
    buffers.push(Buffer.from(response.data));
  }
  return vanta.renderImage({
    prompt,
    referenceImageBuffers: buffers,
    seed,
    negativePrompt,
    width: Number(generationOptions.width || 1024),
    height: Number(generationOptions.height || 1536),
    generationMode: generationOptions.generationMode === 'environment'
      ? 'environment'
      : generationOptions.generationMode === 'character'
        ? 'character'
        : 'scene',
    extra: {
      ...(characterMap?.length ? { characters: characterMap } : {}),
      ...(generationOptions?.extra || {}),
    },
  });
}

module.exports = { generateImage };
