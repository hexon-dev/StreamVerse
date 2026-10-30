'use strict';
/**
 * Allocates a guaranteed-unique film_id, independent of whatever a story provider
 * (mock or real LLM) happens to put in its JSON output.
 *
 * This matters because identity/ordering is exactly the kind of thing the spec says
 * deterministic software must own, not generated content (see AUDIT.md / prompt
 * principle: "AI decides story/visuals; deterministic software controls IDs").
 * A story LLM can be prompted to produce a film_id, but nothing stops two responses
 * from reusing one (a mock provider's fixed default id is the trivial case; a real
 * LLM repeating a catchy title-derived slug is the realistic one). Orchestrator
 * refuses to let a second, different bible reuse an existing film_id — correct
 * tamper protection — so an ID collision would otherwise make every film after the
 * first fail with "bible changed since this film was started" (reproduced in testing).
 *
 * Counter file: <dataDir>/film_seq.json — single process/single disk, same assumption
 * as the rest of this engine (see AUDIT.md storage note).
 */
const path = require('path');
const fs = require('fs');
const { readJson, writeJson, pad, slug } = require('./util');

function nextFilmId(dataDir, title) {
  const file = path.join(dataDir, 'film_seq.json');
  const seq = readJson(file, { n: 0 });
  seq.n += 1; writeJson(file, seq);
  const parts = title ? slug(title).split('-').filter(Boolean).slice(0, 3) : [];
  const base = parts.length ? parts.join('-') : 'FILM';
  const id = `VANTA_${base}_${pad(seq.n, 3)}`;
  // Guard against an on-disk collision from a previous manual run / restored backup.
  if (fs.existsSync(path.join(dataDir, 'films', id))) return nextFilmId(dataDir, `${title || ''}X`);
  return id;
}

module.exports = { nextFilmId };
