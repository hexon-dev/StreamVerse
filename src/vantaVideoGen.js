'use strict';
const axios = require('axios');
const vanta = require('./vantaRendererClient');

async function submitVideoJob(imageBuffer, shotMeta = {}) {
  const refs = Array.isArray(shotMeta.referenceImageBuffers)
    ? shotMeta.referenceImageBuffers.filter(Buffer.isBuffer)
    : [];
  if (!refs.length && Buffer.isBuffer(imageBuffer)) refs.push(imageBuffer);

  const prompt = String(
    shotMeta?.motionParams?.videoPrompt ||
    shotMeta?.videoPrompt ||
    shotMeta?.imagePrompt ||
    shotMeta?.prompt ||
    ''
  ).trim();
  if (!prompt) throw new Error('[VANTA Video] No video prompt supplied.');

  const result = await vanta.renderVideo({
    imageBuffer,
    referenceImageBuffers: refs,
    prompt,
    negativePrompt: shotMeta.negativePrompt || shotMeta.vantaNegativePrompt || null,
    seed: Number.isFinite(Number(shotMeta.seed)) ? Math.floor(Number(shotMeta.seed)) : null,
    duration: Number(shotMeta.duration) || undefined,
    width: Number(shotMeta.width) || undefined,
    height: Number(shotMeta.height) || undefined,
    extra: {
      motion_level: shotMeta.motionLevel,
      shot_pacing_type: shotMeta.shotPacingType,
      lip_sync: !!shotMeta?.motionParams?.lipSync,
    },
  });
  return { jobId: result.jobId, apiKey: 'vanta', workflowId: result.workflowId };
}

async function pollVideoJob(jobId) {
  const result = await vanta.poll(jobId);
  if (!result.url) throw new Error(`[VANTA Video] Job ${jobId} completed without a usable video URL.`);
  return result.url;
}

async function retrieveContinuityFrames(videoUrl) {
  // Continuity extraction remains the FFmpeg service responsibility.
  const config = require('./config');
  const key = process.env.FFMPEG_SERVICE_API_KEY || process.env.FFMPEG_API_KEY || config.ffmpegApiKey;
  const serviceUrl = String(process.env.FFMPEG_SERVICE_URL || config.ffmpegServiceUrl || '').replace(/\/+$/, '');
  if (!serviceUrl || !key) throw new Error('[VANTA Video] FFmpeg continuity service credentials are missing.');
  const response = await axios.post(`${serviceUrl}/frames`, { videoUrl }, {
    headers: { 'Content-Type': 'application/json', 'x-api-key': key },
    timeout: 60000,
  });
  return response.data;
}

module.exports = { submitVideoJob, pollVideoJob, retrieveContinuityFrames };
