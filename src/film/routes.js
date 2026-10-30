'use strict';
/**
 * VANTA AI Film Studio — HTTP surface, mounted under /api/films.
 *
 * Every generation-triggering endpoint follows the existing StreamVerse convention
 * (see /api/generate-shot in index.js): validate, kick off the work in the
 * background, return immediately. All real state lives in FilmOrchestrator's on-disk
 * state (films/<id>/state.json + events.jsonl), so the dashboard polls GET /api/films/:id
 * rather than holding a request open, and a server restart loses no progress.
 *
 * Production video/image/vision providers are injected via `getProviders()` (a function,
 * not a static object) so this module never hard-codes a vendor; until real LTX-2.3 image
 * and vision providers are wired in (see AUDIT.md "not done"), it defaults to the mocks
 * so the endpoints are usable end-to-end for wiring/dashboard work today.
 */
const path = require('path');
const fs = require('fs');
const { FilmOrchestrator } = require('./orchestrator');
const { LlmStoryProvider, MockStoryProvider } = require('./storyProvider');
const { pickFreshBrief, BriefHistory } = require('./freshBrief');
const { finalizeFilm } = require('./finalize');
const { readJson } = require('./util');
const { nextFilmId } = require('./filmRegistry');

function buildRouter({ express, dataDir, getProviders, runtimeRange = { min: 900, max: null }, callLLM }) {
  const router = express.Router();
  const briefHistory = new BriefHistory(path.join(dataDir, 'brief_history.json'));
  const filmsDir = path.join(dataDir, 'films');
  const running = new Map();                                   // film_id -> { orch, promise } (in THIS process only; state on disk is the source of truth)

  const storyProvider = () => (callLLM ? new LlmStoryProvider({ callLLM }) : new MockStoryProvider());
  const loadOrch = (filmId) => {
    const bible = readJson(path.join(filmsDir, filmId, 'bible.json'));
    if (!bible) return null;
    return new FilmOrchestrator({ dataDir, bible, providers: getProviders(), options: { runtimeRange } });
  };

  router.get('/', (req, res) => {
    if (!fs.existsSync(filmsDir)) return res.json({ films: [] });
    const films = fs.readdirSync(filmsDir).map(id => { try { return loadOrch(id).summary(); } catch (e) { return { film_id: id, status: 'error', error: e.message }; } });
    res.json({ films });
  });

  router.post('/', async (req, res) => {
    try {
      const { theme, threatType, threatSeed, threatClock, runtime, seed } = req.body || {};
      const brief = (theme && threatSeed)
        ? { theme, threat_type: threatType || 'entity', threat_seed: threatSeed, threat_clock: threatClock || 'time is short' }
        : pickFreshBrief({ history: briefHistory.all(), seed });
      const bible = await storyProvider().generate(brief, { runtime: runtime || 1080, runtimeRange });
      bible.film_id = nextFilmId(dataDir, bible.title);       // never trust the story provider's own id (mock's is a constant; an LLM's could collide too)
      briefHistory.record(brief, bible.film_id);
      const orch = new FilmOrchestrator({ dataDir, bible, providers: getProviders(), options: { runtimeRange } });
      await orch.prepareAssets(); const plan = orch.plan();
      res.status(201).json({ ok: true, film_id: bible.film_id, brief, shots: plan.shots.length, planned_runtime: plan.planned_runtime, warnings: plan.warnings });
    } catch (err) { console.error('[Films] create failed:', err.message); res.status(422).json({ ok: false, error: err.message, errors: err.errors }); }
  });

  router.get('/:id', (req, res) => {
    const orch = loadOrch(req.params.id); if (!orch) return res.status(404).json({ ok: false, error: 'not found' });
    res.json(orch.summary());
  });

  router.get('/:id/events', (req, res) => {
    const orch = loadOrch(req.params.id); if (!orch) return res.status(404).json({ ok: false, error: 'not found' });
    const since = Number(req.query.since) || 0;
    res.json({ events: orch.events.read().slice(since) });
  });

  router.post('/:id/generate', (req, res) => {
    const orch = loadOrch(req.params.id); if (!orch) return res.status(404).json({ ok: false, error: 'not found' });
    if (running.has(orch.bible.film_id)) return res.status(409).json({ ok: false, error: 'already generating', status: orch.summary().status });
    const p = orch.run()
      .then(() => finalizeFilm(orch, { runtimeRange }))
      .catch(err => console.error(`[Films] ${orch.bible.film_id} generation stopped:`, err.message))
      .finally(() => running.delete(orch.bible.film_id));
    running.set(orch.bible.film_id, { orch, promise: p });
    res.status(202).json({ ok: true, status: 'started', film_id: orch.bible.film_id });
  });

  router.post('/:id/shots/:shotId/regenerate', async (req, res) => {
    const orch = loadOrch(req.params.id); if (!orch) return res.status(404).json({ ok: false, error: 'not found' });
    if (running.has(orch.bible.film_id)) return res.status(409).json({ ok: false, error: 'film is currently generating' });
    try { await orch.regenerateShot(req.params.shotId); res.json({ ok: true, summary: orch.summary() }); }
    catch (err) { res.status(422).json({ ok: false, error: err.message }); }
  });

  router.post('/:id/finalize', (req, res) => {
    const orch = loadOrch(req.params.id); if (!orch) return res.status(404).json({ ok: false, error: 'not found' });
    finalizeFilm(orch, { runtimeRange }).catch(err => console.error(`[Films] ${orch.bible.film_id} finalize failed:`, err.message));
    res.status(202).json({ ok: true, status: 'finalizing' });
  });

  return router;
}

module.exports = { buildRouter };
