'use strict';
/**
 * Provider interfaces + MOCK implementations. Production video generation is LTX-2.3
 * (existing StreamVerse integration); the orchestrator only ever talks to these
 * interfaces, so the whole pipeline is testable without spending generation credits.
 *
 *  VideoGenerationProvider.generate(req) -> { video_path, meta }
 *  ImageGenerationProvider.generate(req) -> { path }
 *  VisionProvider.observe(req)           -> observation (same schema the validator compares)
 */
const fs = require('fs');
const path = require('path');
const { run, ffmpegBin } = require('../branding');
const { sha256, sha256File, ensureDir, writeJson, readJson } = require('./util');

const hex6 = (s) => sha256(s).slice(0, 6);

class VideoGenerationProvider { async generate() { throw new Error('not implemented'); } }
class ImageGenerationProvider { async generate() { throw new Error('not implemented'); } }
class VisionProvider { async observe() { throw new Error('not implemented'); } }

class MockImageGenerationProvider extends ImageGenerationProvider {
  constructor() { super(); this.calls = []; }
  async generate({ prompt, kind, key, referenceImages = [], out, width = 512, height = 512 }) {
    ensureDir(path.dirname(out));
    await run(ffmpegBin(), ['-nostdin', '-y', '-v', 'error', '-f', 'lavfi', '-i', `color=c=0x${hex6(`${kind}:${key}:${prompt}`)}:s=${width}x${height}:d=1`, '-frames:v', '1', out]);
    this.calls.push({ kind, key, out, prompt, referenceImages: referenceImages.slice() });
    return { path: out };
  }
}

/**
 * Mock video provider. Renders a real, decodable MP4 (colour field + moving box + tone).
 * If `start_image` is supplied (the previous shot's end frame) the first 0.5 s shows THAT image,
 * so shot N genuinely begins on shot N-1's last frame — the handoff is observable in pixels.
 * It also writes a sidecar `.meta.json` recording (a) exactly which reference files it received,
 * and (b) the state it "drew". `faults(req)` may return overrides to simulate bad generations.
 */
class MockVideoGenerationProvider extends VideoGenerationProvider {
  constructor({ faults = () => null, width = 320, height = 568, fps = 24, withAudio = true, failDecode = () => false } = {}) {
    super(); Object.assign(this, { faults, width, height, fps, withAudio, failDecode }); this.calls = [];
  }
  async generate(req) {
    const { shot_id, attempt, duration, out_dir } = req;
    ensureDir(out_dir);
    const video = path.join(out_dir, 'video.mp4');
    const { width: W, height: H, fps } = this;
    const dur = Math.max(0.6, Number(duration));
    const head = req.start_image ? 0.5 : 0;
    const color = hex6(`${shot_id}:${attempt}`);
    const inputs = [], graph = [];
    let n = 0;
    if (head) { inputs.push('-loop', '1', '-t', String(head), '-i', req.start_image); graph.push(`[${n}:v]scale=${W}:${H},setsar=1,fps=${fps},format=yuv420p[a]`); n++; }
    graph.push(`color=c=0x${color}:s=${W}x${H}:r=${fps}:d=${(dur - head).toFixed(3)},drawbox=x='mod(t*60\\,${W - 50})':y=${Math.round(H / 2)}:w=50:h=50:color=white:t=fill,format=yuv420p[b]`);
    graph.push(head ? '[a][b]concat=n=2:v=1:a=0[v]' : '[b]null[v]');
    const args = ['-nostdin', '-y', '-v', 'error', ...inputs, '-filter_complex', graph.join(';')];
    if (this.withAudio) { args.push('-f', 'lavfi', '-i', `sine=frequency=${300 + (parseInt(color.slice(0, 2), 16) % 300)}:sample_rate=44100:duration=${dur.toFixed(3)}`); }
    args.push('-map', '[v]'); if (this.withAudio) args.push('-map', `${n + 0}:a`.replace(`${n}:a`, `${inputs.length ? 1 : 0}:a`));
    args.push('-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-r', String(fps), '-t', dur.toFixed(3));
    if (this.withAudio) args.push('-c:a', 'aac', '-shortest');
    args.push(video);
    await run(ffmpegBin(), args, { timeoutMs: 120000 });
    if (this.failDecode(req)) fs.truncateSync(video, Math.floor(fs.statSync(video).size / 3));   // simulate corruption

    const refs = [];
    const add = (kind, key, p) => { if (p && fs.existsSync(p)) refs.push({ kind, key, path: p, sha256: sha256File(p) }); };
    for (const c of req.references.characters || []) for (const f of c.files) add(`character:${f.role}`, c.character_id, f.path);
    if (req.references.location) add('location', req.references.location.location_id, req.references.location.path);
    for (const p of req.references.props || []) add('prop', p.prop_id, p.path);
    add('previous_end_frame', req.previous_shot_id, req.references.previous_end_frame);
    for (const f of req.references.support_frames || []) add('support_frame', req.previous_shot_id, f);
    add('start_image', shot_id, req.start_image);

    const expected = req.expected_state;
    const rendered = JSON.parse(JSON.stringify(expected));
    const fault = this.faults(req, { refs });
    if (fault) for (const [k, v] of Object.entries(fault)) rendered[k] = v;
    const meta = { shot_id, attempt, duration: dur, refs_received: refs, prompt_sha256: sha256(req.prompt), dialogue_in_prompt: req.dialogue_lines, adjustments: req.adjustments || [], rendered, fault: fault ? Object.keys(fault) : [] };
    writeJson(path.join(out_dir, 'provider.meta.json'), meta);
    this.calls.push({ shot_id, attempt, refs: refs.map(r => `${r.kind}:${r.key}`), adjustments: req.adjustments || [] });
    return { video_path: video, meta };
  }
}

/** Mock vision: "looks" at the clip by reading what the mock renderer recorded. */
class MockVisionProvider extends VisionProvider {
  async observe({ clip_dir }) {
    const m = readJson(path.join(clip_dir, 'provider.meta.json'));
    if (!m) throw new Error('mock vision: no provider.meta.json');
    return { source: 'mock', ...m.rendered };
  }
}

module.exports = { VideoGenerationProvider, ImageGenerationProvider, VisionProvider, MockImageGenerationProvider, MockVideoGenerationProvider, MockVisionProvider };
