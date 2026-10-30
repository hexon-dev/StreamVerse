'use strict';
/**
 * FilmOrchestrator — deterministic production control. AI providers create content;
 * this class owns IDs, ordering, state files, frames, durations, validation, retries, resume.
 *
 *   prepareAssets -> plan -> for each shot IN ORDER:
 *      load previous end frame + refs + ledger -> compile -> generate -> verify decodable
 *      -> extract end frame -> observe -> validate -> (approve | targeted retry)
 *
 * Shots are strictly sequential (each depends on the previous end frame). Only independent
 * asset generation runs in parallel (bounded).
 */
const fs = require('fs');
const path = require('path');
const { ensureDir, writeJson, readJson, sha256, stableStringify, EventLog, deepClone } = require('./util');
const { IpRegistry, AssetPipeline } = require('./ip');
const { planFilm } = require('./planner');
const { initialLedger, applyShot, expectedObservation } = require('./continuity');
const { compileShotRequest } = require('./promptCompiler');
const { validateShot, adjustmentsFor } = require('./validator');
const { ShotStore } = require('./shotStore');
const frames = require('./frames');
const { checkStory } = require('./storyQc');

class ShotFailedError extends Error { constructor(id, issues) { super(`shot ${id} failed after all attempts: ${issues.map(i => i.type).join(',')}`); this.shot_id = id; this.issues = issues; } }

class FilmOrchestrator {
  constructor({ dataDir, bible, providers, options = {}, log }) {
    this.bible = bible; this.providers = providers;
    // Strip undefined-valued keys from `options` first: a caller (routes.js does this) that
    // builds its options object conditionally can easily end up passing e.g. {minShot: undefined}
    // rather than omitting the key entirely, and `{...defaults, ...options}` lets an explicit
    // undefined silently overwrite a good default (see planner.js planFilm for the bug this
    // caused in production: NaN shot durations at real runtimes). `runtimeRange` is the one
    // legitimate exception -- undefined there means "no runtime-range check", not "use a default".
    const cleanOptions = Object.fromEntries(Object.entries(options).filter(([k, v]) => v !== undefined || k === 'runtimeRange'));
    this.opt = { maxAttempts: 3, maxRefs: 6, extraDurationStep: 1.0, runtimeRange: undefined, assetConcurrency: 3, ...cleanOptions };
    this.filmDir = ensureDir(path.join(dataDir, 'films', bible.film_id));
    this.registry = new IpRegistry(path.join(dataDir, 'ip'));
    this.store = new ShotStore(this.filmDir);
    this.events = new EventLog(path.join(this.filmDir, 'events.jsonl'));
    this.log = log || (() => {});
    this.f = (n) => path.join(this.filmDir, n);
    this.state = readJson(this.f('state.json')) || { film_id: bible.film_id, status: 'created', phase: 'created', shots: {}, paused_reason: null };
    this.bibleSha = sha256(stableStringify({ ...bible, brief: undefined }));
    if (this.state.bible_sha && this.state.bible_sha !== this.bibleSha) throw new Error('bible changed since this film was started; refusing to continue (start a new film_id)');
    this.state.bible_sha = this.bibleSha;
    this.assets = readJson(this.f('assets.json'));
    this.planData = readJson(this.f('plan.json'));
    this.head = null;
    writeJson(this.f('bible.json'), bible);
  }
  _save(patch = {}) { Object.assign(this.state, patch, { updated_at: new Date().toISOString() }); writeJson(this.f('state.json'), this.state); }
  _emit(type, data) { this.events.emit(type, { film_id: this.bible.film_id, ...data }); }

  // ── stage 1: story gate + canonical assets ───────────────────────────────────────────────
  async prepareAssets() {
    const q = checkStory(this.bible, { runtimeRange: this.opt.runtimeRange });
    if (!q.valid) { this._save({ status: 'failed', phase: 'story', paused_reason: q.errors.join('; ') }); this._emit('story_rejected', { errors: q.errors }); throw new Error(`story rejected: ${q.errors.join('; ')}`); }
    const pipe = new AssetPipeline({ registry: this.registry, image: this.providers.image, concurrency: this.opt.assetConcurrency, log: this.log });
    const { ids, generated } = await pipe.ensureAll(this.bible);
    // film-specific wardrobe references for deliberate wardrobe changes (independent -> parallel)
    const wardrobeJobs = [];
    for (const sc of this.bible.scenes) for (const bt of sc.beats) for (const [k, v] of Object.entries((bt.state_changes || {}).characters || {})) if (v.wardrobe) wardrobeJobs.push({ k, w: v.wardrobe });
    const uniq = [...new Map(wardrobeJobs.map(j => [`${j.k}|${j.w}`, j])).values()];
    const { mapLimit } = require('./util');
    await mapLimit(uniq, this.opt.assetConcurrency, (j) => pipe.ensureWardrobe(ids.characters[j.k], this.bible.characters.find(c => c.key === j.k), j.w));
    const canonicalHashes = Object.fromEntries(Object.entries(ids.characters).map(([k, id]) => [id, this.registry.canonicalHash('character', id)]));
    this.assets = { ids, canonicalHashes, generated };
    writeJson(this.f('assets.json'), this.assets);
    this._save({ phase: 'assets', status: 'assets_ready' }); this._emit('assets_ready', { generated, ids });
    return this.assets;
  }

  // ── stage 2: plan ─────────────────────────────────────────────────────────────────────────
  plan() {
    if (!this.assets) throw new Error('prepareAssets() first');
    if (this.planData) return this.planData;                                     // idempotent / resume-safe
    const p = planFilm(this.bible, this.assets.ids, { minShot: this.opt.minShot, maxShot: this.opt.maxShot });
    this.planData = p; writeJson(this.f('plan.json'), p);
    for (const s of p.shots) this.state.shots[s.shot_id] = this.state.shots[s.shot_id] || { status: 'pending', attempts: 0, approved_attempt: null, retry_reasons: [] };
    this._save({ phase: 'planned', status: 'planned' }); this._emit('plan_ready', { shots: p.shots.length, planned_runtime: p.planned_runtime, warnings: p.warnings });
    return p;
  }

  _ledgerBefore(index) {
    if (index === 0) return initialLedger(this.bible, this.assets.ids);
    const prevId = this.planData.shots[index - 1].shot_id;
    const rec = readJson(this.f(`continuity/${prevId}.json`));
    if (!rec) throw new Error(`no continuity record for ${prevId}: previous shot is not approved`);
    return rec.state_after;
  }
  _previousHandoff(index) {
    if (index === 0) return null;
    const a = this.store.getApproved(this.planData.shots[index - 1].shot_id);
    if (!a) throw new Error(`previous shot ${this.planData.shots[index - 1].shot_id} has no valid approved output`);
    return { shot_id: a.shot_id, end_frame: a.end_frame, support_frames: a.support_frames };
  }

  // ── stage 3: the shot loop ─────────────────────────────────────────────────────────────────
  async run() {
    this.plan();
    this._save({ status: 'generating', phase: 'generating', paused_reason: null });
    for (const shot of this.planData.shots) {
      const st = this.state.shots[shot.shot_id];
      if (st.status === 'approved') {
        if (this.store.getApproved(shot.shot_id) && readJson(this.f(`continuity/${shot.shot_id}.json`))) { this._emit('shot_skipped_resume', { shot_id: shot.shot_id }); continue; }
        this._emit('approved_invalid', { shot_id: shot.shot_id }); st.status = 'pending';
      }
      try { await this.generateShot(shot); }
      catch (e) { this._save({ status: 'paused', paused_reason: e.message }); this._emit('film_paused', { shot_id: shot.shot_id, reason: e.message }); throw e; }
    }
    this._save({ status: 'shots_complete', phase: 'shots_complete' }); this._emit('all_shots_approved', {});
    return this.summary();
  }

  async generateShot(shot, { supersede = false } = {}) {
    const st = this.state.shots[shot.shot_id]; const idx = shot.index;
    const scene = this.planData.scenes.find(s => s.scene_id === shot.scene_id);
    const before = this._ledgerBefore(idx), after = applyShot(before, shot, scene);
    const previous = this._previousHandoff(idx);
    const expected = expectedObservation(after, shot);
    st.status = 'generating'; this._save({ current_shot: shot.shot_id }); this._emit('shot_started', { shot_id: shot.shot_id, scene_id: shot.scene_id, previous_frame: previous && previous.end_frame });

    let adjustments = [], issues = [], lastAttemptNo = 0;
    for (let k = 1; k <= this.opt.maxAttempts; k++) {
      const { n, dir } = this.store.nextAttempt(shot.shot_id); lastAttemptNo = n;
      const genDur = adjustments.includes('extend_duration') ? Math.min(this.planData.limits.maxShot, shot.duration_target + this.opt.extraDurationStep * k) : shot.duration_target;
      const req = compileShotRequest({ shot, before, after, bible: this.bible, assets: { registry: this.registry, ids: this.assets.ids }, previous, adjustments, attempt: n, outDir: dir, generationDuration: genDur, maxRefs: this.opt.maxRefs });
      req.expected_state = expected;
      st.attempts++; this._save();
      this._emit('attempt_started', { shot_id: shot.shot_id, attempt: n, duration: genDur, adjustments, previous_frame: req.references.previous_end_frame, refs: [...req.references.characters.flatMap(c => c.files.map(f => `${c.key}:${f.role}`)), req.references.location ? 'location' : null, ...req.references.props.map(p => `prop:${p.key}`)].filter(Boolean), refs_dropped: req.references_dropped });
      const T = {}; const t = () => Date.now(); let t0 = t();
      let gen; try { gen = await this.providers.video.generate(req); } catch (e) { gen = null; this._emit('provider_error', { shot_id: shot.shot_id, attempt: n, error: e.message }); }
      T.generate = t() - t0; t0 = t();
      let clip = null, endInfo = null, obs = null;
      if (gen) {
        try {
          clip = await frames.verifyDecodable(gen.video_path);
          [endInfo] = await Promise.all([frames.extractEndFrame(gen.video_path, path.join(dir, 'end_frame.png'), { duration: clip.duration })]);
          T.verify_extract = t() - t0; t0 = t();
          if (shot.motion_critical || adjustments.includes('motion_context')) {
            await Promise.all([[1, 'end_m1.png'], [3, 'end_m3.png']].map(([s, f]) => frames.extractFrameBeforeEnd(gen.video_path, path.join(dir, f), s, clip.duration)));
          }
          obs = await this.providers.vision.observe({ clip_dir: dir, frames: { end: endInfo.path }, previous_end_frame: previous && previous.end_frame, expected });
          T.vision = t() - t0;
        } catch (e) { clip = null; this._emit('media_error', { shot_id: shot.shot_id, attempt: n, error: e.message }); }
      }
      const result = validateShot({ shot, before, request: req, clip, observation: obs, expected });
      issues = result.issues;
      writeJson(path.join(dir, 'validation.json'), result);
      writeJson(path.join(dir, 'generation.json'), { shot_id: shot.shot_id, attempt: n, duration_target: shot.duration_target, dialogue_duration: shot.dialogue_duration, generation_duration: genDur, actual_duration: clip && clip.duration, adjustments, previous_end_frame: req.references.previous_end_frame, refs_dropped: req.references_dropped, references: { characters: req.references.characters.map(c => ({ key: c.key, character_id: c.character_id, roles: c.files.map(f => f.role) })), location: req.references.location && req.references.location.location_id, props: req.references.props.map(p => p.key), previous_end_frame: req.references.previous_end_frame, support_frames: req.references.support_frames.length, start_image: req.start_image }, end_frame: endInfo, timings_ms: T, prompt_sha256: sha256(req.prompt) });
      fs.writeFileSync(path.join(dir, 'prompt.txt'), req.prompt);
      this._emit('attempt_result', { shot_id: shot.shot_id, attempt: n, passed: result.passed, issues: result.issues.map(i => ({ type: i.type, severity: i.severity, message: i.message })), actual_duration: clip && clip.duration, timings_ms: T });
      if (result.passed) {
        const rec = this.store.approve(shot.shot_id, n, { supersede });
        const A = this.store.getApproved(shot.shot_id);
        writeJson(this.f(`continuity/${shot.shot_id}.json`), {
          shot_id: shot.shot_id, previous_shot_id: shot.previous_shot_id, duration_target: shot.duration_target, actual_duration: clip.duration,
          character_state: after.characters, environment_state: after.environment, prop_state: after.props, camera_state: after.camera, lighting_state: after.lighting, story_state: after.story, audio_state: after.audio,
          state_before: before, state_after: after, previous_end_frame: previous && previous.end_frame, end_frame: A.end_frame, support_frames: A.support_frames, validation: result,
        });
        Object.assign(st, { status: 'approved', approved_attempt: n, last_issues: [], actual_duration: clip.duration });
        this._save(); this._emit('shot_approved', { shot_id: shot.shot_id, attempt: n, end_frame: A.end_frame });
        return rec;
      }
      const hard = issues.find(i => !i.retryable);
      st.retry_reasons.push({ attempt: n, issues: issues.map(i => i.type) }); st.last_issues = issues;
      if (hard) break;                                                          // plan defect: retrying video cannot fix it
      adjustments = adjustmentsFor(issues, adjustments);                        // TARGETED change to the inputs
      this._emit('retry_planned', { shot_id: shot.shot_id, after_attempt: n, reasons: issues.map(i => i.type), adjustments });
    }
    st.status = 'failed'; this._save({ paused_reason: `shot ${shot.shot_id} failed` });
    this._emit('shot_failed', { shot_id: shot.shot_id, attempts: lastAttemptNo, issues: issues.map(i => ({ type: i.type, message: i.message })) });
    throw new ShotFailedError(shot.shot_id, issues);
  }

  /** Targeted regeneration of ONE shot. Neighbours untouched; previous approved end frame + state reused. */
  async regenerateShot(shotId) {
    this.plan(); const shot = this.planData.shots.find(s => s.shot_id === shotId); if (!shot) throw new Error(`unknown shot ${shotId}`);
    const old = this.store.getApproved(shotId); const oldEnd = old && old.end_frame ? path.join(this.filmDir, 'tmp_old_end.png') : null;
    if (oldEnd) fs.copyFileSync(old.end_frame, oldEnd);
    this._emit('regenerate_requested', { shot_id: shotId });
    await this.generateShot(shot, { supersede: !!old });
    const next = this.planData.shots[shot.index + 1];
    if (oldEnd && next && this.state.shots[next.shot_id].status === 'approved') {
      const d = await frames.imageDiff(oldEnd, this.store.getApproved(shotId).end_frame);
      if (d > 6) { this.state.shots[next.shot_id].status = 'needs_review'; this._save(); this._emit('next_shot_needs_review', { shot_id: next.shot_id, end_frame_diff: d }); }
    }
    if (oldEnd) fs.rmSync(oldEnd, { force: true });
  }

  summary() {
    const shots = (this.planData ? this.planData.shots : []).map(s => {
      const st = this.state.shots[s.shot_id] || {}; const c = readJson(this.f(`continuity/${s.shot_id}.json`)); const a = this.store.approvedRecord(s.shot_id);
      return { shot_id: s.shot_id, scene_id: s.scene_id, index: s.index, status: st.status, attempts: st.attempts, duration_target: s.duration_target, actual_duration: st.actual_duration || null, previous_frame: c && c.previous_end_frame, end_frame: c && c.end_frame, continuity_passed: c ? c.validation.passed : null, retry_reasons: st.retry_reasons || [], last_issues: (st.last_issues || []).map(i => ({ type: i.type, message: i.message })), approved_attempt: a && a.attempt };
    });
    const done = shots.filter(s => s.status === 'approved').length;
    return { film_id: this.bible.film_id, title: this.bible.title, status: this.state.status, phase: this.state.phase, paused_reason: this.state.paused_reason, shots_total: shots.length, shots_approved: done, progress: shots.length ? done / shots.length : 0, shots };
  }
}

module.exports = { FilmOrchestrator, ShotFailedError };
