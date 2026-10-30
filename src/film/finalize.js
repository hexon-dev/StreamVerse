'use strict';
const path = require('path');
const { writeJson } = require('./util');
const { assembleMaster } = require('./assemble');
const { exportSocial } = require('./social');
const { runFilmQc } = require('./qc');

/** assemble -> brand -> social -> QC. The film is COMPLETE only if QC passes. */
async function finalizeFilm(orch, { runtimeRange, brandCfg, music, normalizeLoudness, sceneFades = true } = {}) {
  const out = path.join(orch.filmDir, 'out');
  orch._save({ status: 'assembling', phase: 'assembly' }); orch._emit('assembly_started', {});
  const assembly = await assembleMaster(orch, { outDir: out, brandCfg, music, normalizeLoudness, sceneFades });
  const social = await exportSocial(orch, { master: assembly.master, raw: assembly.raw, outDir: path.join(out, 'social'), brandCfg });
  orch._save({ status: 'qc', phase: 'qc' });
  const qc = await runFilmQc(orch, assembly, { runtimeRange });
  writeJson(orch.f('qc.json'), qc); writeJson(orch.f('assembly.json'), assembly.report);
  orch._emit('qc_result', { passed: qc.passed, failed: Object.entries(qc.gates).filter(([, g]) => !g.passed).map(([k]) => k) });
  orch._save({ status: qc.passed ? 'complete' : 'qc_failed', phase: qc.passed ? 'complete' : 'qc', master: assembly.master, social: social.files });
  if (qc.passed) orch._emit('film_complete', { master: assembly.master });
  return { assembly, social, qc };
}
module.exports = { finalizeFilm };
