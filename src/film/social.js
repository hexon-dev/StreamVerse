'use strict';
/**
 * Social export — separate from the film engine: the master is never shaped by a platform.
 * Produces: vertical 9:16 video (branded), cover image, caption metadata. NO upload logic here.
 */
const fs = require('fs');
const path = require('path');
const { run, ffmpegBin, probe, brandMasterFile, settings } = require('../branding');
const { ensureDir, writeJson } = require('./util');

async function exportSocial(orch, { master, raw, outDir, brandCfg = settings() }) {
  ensureDir(outDir);
  const info = await probe(master); const portrait = info.height / info.width >= 1.7;
  const video = path.join(outDir, 'social_vertical.mp4'); let method;
  if (portrait) { await run(ffmpegBin(), ['-nostdin', '-y', '-v', 'error', '-i', master, '-c', 'copy', '-movflags', '+faststart', video]); method = 'remux (already 9:16, already branded)'; }
  else {
    // Crop to 9:16 from the UNBRANDED assembly and brand the result, so the logo is never cropped away.
    const tmp = path.join(outDir, 'vertical_unbranded.mp4');
    await run(ffmpegBin(), ['-nostdin', '-y', '-v', 'error', '-i', raw, '-vf', 'crop=ih*9/16:ih,scale=1080:1920,setsar=1', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '18', '-c:a', 'copy', tmp], { timeoutMs: 60 * 60 * 1000 });
    await brandMasterFile({ inputPath: tmp, outputPath: video, cfg: brandCfg }); fs.rmSync(tmp, { force: true }); method = 'crop 9:16 + brand';
  }
  // cover: the end frame of the climax shot (most visually charged, no ending spoiler)
  const b = orch.bible; const shots = orch.plan().shots;
  const pick = shots.find(s => (s.marks || []).includes('climax')) || shots[Math.floor(shots.length / 2)];
  const a = orch.store.getApproved(pick.shot_id); const cover = path.join(outDir, 'cover.jpg');
  await run(ffmpegBin(), ['-nostdin', '-y', '-v', 'error', '-i', a.end_frame, '-vf', 'scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920', '-q:v', '2', cover]);
  const tags = [...new Set([b.genre, b.concrete_threat.type.replace('_', ' '), 'shortfilm', 'aifilm', 'streamverse'].map(t => '#' + String(t).replace(/[^a-z0-9]/gi, '').toLowerCase()))];
  const meta = { film_id: b.film_id, title: b.title, description: `${b.logline} A complete standalone film.`, theme: b.theme, hashtags: tags, duration: (await probe(video)).duration, aspect: '9:16', files: { video, cover }, cover_source_shot: pick.shot_id, method };
  writeJson(path.join(outDir, 'social.json'), meta); return meta;
}
module.exports = { exportSocial };
