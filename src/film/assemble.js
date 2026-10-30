'use strict';
/**
 * FFmpeg assembly of APPROVED shots into the master.
 *
 *  - Stream-copy concat whenever every clip shares the same codec parameters (fast, lossless).
 *  - Only clips that differ (size/fps/pix_fmt/audio layout, or missing audio) are normalised.
 *  - Scene boundaries get a short dip-to-black by re-encoding ONLY the two edge clips.
 *  - The concat intermediate is MPEG-TS (in-band SPS/PPS), so mixing a normalised/faded clip with
 *    copied ones cannot break decoders; the mandatory branding pass then produces the final MP4.
 *  - Optional music bed / loudness normalisation touch audio only (video is copied).
 *  - EVERY master is branded (StreamVerse Studio logo + name) — assembly refuses to skip it unless
 *    BRAND_ENABLED=false is set explicitly (and QC then fails the branding check).
 */
const fs = require('fs');
const path = require('path');
const { run, ffmpegBin, probe, brandMasterFile, settings } = require('../branding');
const { ensureDir, sha256File } = require('./util');
const frames = require('./frames');

const sigOf = (i) => [i.width, i.height, i.fps, i.videoCodec, i.profile, i.pixFmt, i.audioCodec, i.audioSamples, i.channels].join('|');
const most = (arr) => { const m = new Map(); arr.forEach(a => m.set(a, (m.get(a) || 0) + 1)); return [...m.entries()].sort((a, b) => b[1] - a[1])[0][0]; };

async function normalizeClip(src, dst, ref) {
  const info = await probe(src);
  const args = ['-nostdin', '-y', '-v', 'error', '-i', src];
  if (!info.hasAudio) args.push('-f', 'lavfi', '-i', `anullsrc=r=${ref.audioSamples || 44100}:cl=${(ref.channels || 2) === 1 ? 'mono' : 'stereo'}`);
  args.push('-vf', `scale=${ref.width}:${ref.height}:force_original_aspect_ratio=decrease,pad=${ref.width}:${ref.height}:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=${ref.fps},format=${ref.pixFmt || 'yuv420p'}`,
    '-af', `aresample=${ref.audioSamples || 44100}`, '-ac', String(ref.channels || 2),
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '17', '-c:a', 'aac', '-b:a', '192k');
  if (!info.hasAudio) args.push('-map', '0:v:0', '-map', '1:a:0', '-shortest');
  args.push(dst);
  await run(ffmpegBin(), args, { timeoutMs: 20 * 60 * 1000 }); return dst;
}

async function fadeClip(src, dst, { fadeIn, fadeOut, dur = 0.35 }, ref) {
  const info = await probe(src); const vf = [], af = [];
  if (fadeIn) { vf.push(`fade=t=in:st=0:d=${dur}`); af.push(`afade=t=in:st=0:d=${dur}`); }
  if (fadeOut) { const st = Math.max(0, info.duration - dur); vf.push(`fade=t=out:st=${st.toFixed(3)}:d=${dur}`); af.push(`afade=t=out:st=${st.toFixed(3)}:d=${dur}`); }
  const args = ['-nostdin', '-y', '-v', 'error', '-i', src, '-vf', vf.join(','), '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '17', '-pix_fmt', ref.pixFmt || 'yuv420p'];
  if (info.hasAudio) args.push('-af', af.join(','), '-c:a', 'aac', '-b:a', '192k'); else args.push('-an');
  args.push(dst); await run(ffmpegBin(), args, { timeoutMs: 20 * 60 * 1000 }); return dst;
}

/**
 * @param orch FilmOrchestrator (only reads plan + approved files)
 * @returns {{raw:string, master:string, report:object}}
 */
async function assembleMaster(orch, { outDir, sceneFades = true, music = null, normalizeLoudness = false, brandCfg = settings() } = {}) {
  const { shots, scenes } = orch.plan();
  ensureDir(outDir); const work = ensureDir(path.join(outDir, 'work'));
  const clips = shots.map(s => { const a = orch.store.getApproved(s.shot_id); if (!a) throw new Error(`cannot assemble: ${s.shot_id} has no approved output`); return { shot: s, file: a.video }; });
  const infos = await Promise.all(clips.map(c => probe(c.file)));
  const ref = infos.find(i => sigOf(i) === most(infos.filter(i => i.hasAudio).map(sigOf))) || infos[0];
  const report = { shots: shots.map(s => s.shot_id), normalized: [], faded: [], concat: 'stream_copy', per_shot_duration: infos.map(i => i.duration) };

  // 1) normalise only what differs
  for (let i = 0; i < clips.length; i++) {
    if (sigOf(infos[i]) !== sigOf(ref) || !infos[i].hasAudio) {
      const dst = path.join(work, `norm_${i}.mp4`); await normalizeClip(clips[i].file, dst, ref); clips[i].file = dst; report.normalized.push(clips[i].shot.shot_id); report.concat = 'mixed';
    }
  }
  // 2) dip-to-black at scene boundaries: only the two edge clips are re-encoded
  if (sceneFades) {
    const fadeOut = new Set(), fadeIn = new Set();
    clips.forEach((c, i) => { if (i > 0 && c.shot.opening_transition.type === 'scene_boundary') { fadeIn.add(i); fadeOut.add(i - 1); } });
    const edge = new Set([...fadeIn, ...fadeOut]);
    for (const i of edge) { const dst = path.join(work, `fade_${i}.mp4`); await fadeClip(clips[i].file, dst, { fadeIn: fadeIn.has(i), fadeOut: fadeOut.has(i) }, ref); clips[i].file = dst; report.faded.push(clips[i].shot.shot_id); }
    if (edge.size) report.concat = 'mixed';
  }
  // 3) concat -> MPEG-TS (stream copy)
  const list = path.join(work, 'concat.txt');
  fs.writeFileSync(list, clips.map(c => `file '${c.file.replace(/'/g, "'\\''")}'`).join('\n'));
  let raw = path.join(work, 'concat.ts');
  await run(ffmpegBin(), ['-nostdin', '-y', '-v', 'error', '-f', 'concat', '-safe', '0', '-i', list, '-c', 'copy', '-f', 'mpegts', raw], { timeoutMs: 30 * 60 * 1000 });
  // 4) optional audio-only processing (video copied)
  if (music || normalizeLoudness) {
    const out = path.join(work, 'audio_mix.ts'); const a = ['-nostdin', '-y', '-v', 'error', '-i', raw];
    let filter;
    if (music) { a.push('-stream_loop', '-1', '-i', music.path); filter = `[1:a]volume=${music.gain ?? 0.18}[m];[0:a][m]amix=inputs=2:duration=first:dropout_transition=0,volume=2${normalizeLoudness ? ',loudnorm=I=-16:TP=-1.5:LRA=11' : ''}[a]`; a.push('-filter_complex', filter, '-map', '0:v', '-map', '[a]'); }
    else a.push('-af', 'loudnorm=I=-16:TP=-1.5:LRA=11', '-map', '0:v', '-map', '0:a');
    a.push('-c:v', 'copy', '-c:a', 'aac', '-b:a', '192k', '-f', 'mpegts', out);
    await run(ffmpegBin(), a, { timeoutMs: 30 * 60 * 1000 }); raw = out; report.audio_processing = { music: !!music, loudnorm: normalizeLoudness };
  }
  const rawInfo = await frames.verifyDecodable(raw);
  const expected = infos.reduce((t, i) => t + i.duration, 0);
  report.raw = { duration: rawInfo.duration, expected_sum: expected, drift: rawInfo.duration - expected };
  // 5) MANDATORY branding -> final MP4
  const master = path.join(outDir, 'master.mp4');
  if (!brandCfg.enabled) throw new Error('BRAND_ENABLED=false: refusing to produce a master without StreamVerse branding');
  const b = await brandMasterFile({ inputPath: raw, outputPath: master, cfg: brandCfg });
  report.branding = { applied: b.applied, logoDiff: b.logoDiff, layout: b.layout, audioMode: b.audioMode, elapsedMs: b.elapsedMs };
  report.master = { ...b.output, sha256: sha256File(master) };
  return { raw, master, report };
}

module.exports = { assembleMaster, normalizeClip, fadeClip, sigOf };
