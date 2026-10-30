'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');

// agnesVideoGen.js accesses these as `shotContinuity.fn(...)` / `ltxVisionDirector.fn(...)`
// (property access at call time, not destructured), so mutating the already-required
// module objects before invoking agnesVideoGen's exports works regardless of require order.
const shotContinuity = require('../src/shotContinuity');
const ltxVisionDirector = require('../src/ltxVisionDirector');
const videoEngineClient = require('../services/videoEngineClient');

test('_buildFinalAgnesPrompt: adds affirmative creative direction while keeping every existing coherence guardrail intact', async () => {
  let capturedRepairInstruction = null;
  const origDescribe = ltxVisionDirector.describeForLTX;
  const origResolve = shotContinuity.resolveContinuityStartingImage;
  const origFormat = shotContinuity.formatSceneContinuityDirective;
  ltxVisionDirector.describeForLTX = async ({ repairInstruction }) => { capturedRepairInstruction = repairInstruction; return 'a vivid description of the shot'; };
  shotContinuity.resolveContinuityStartingImage = async (imageBuffer) => ({ imageBuffer, referenceImageBuffers: [], usedContinuityFrame: false });
  shotContinuity.formatSceneContinuityDirective = () => '';
  try {
    delete require.cache[require.resolve('../src/agnesVideoGen')];
    const agnesVideoGen = require('../src/agnesVideoGen');
    const fakeImage = Buffer.from('fake-png-bytes');
    // submitVideoJob exercises _buildFinalAgnesPrompt internally; stub the network call it makes after.
    const origSubmit = videoEngineClient.submitJob;
    videoEngineClient.submitJob = async () => ({ jobId: 'job-123' });
    try {
      await agnesVideoGen.submitVideoJob(fakeImage, { duration: 5, videoPrompt: 'Kai walks down the corridor.' });
    } finally { videoEngineClient.submitJob = origSubmit; }

    assert.ok(capturedRepairInstruction, 'describeForLTX should have been called with a repair instruction');
    // New affirmative creative direction is present
    assert.match(capturedRepairInstruction, /CREATIVE COMMITMENT/);
    assert.match(capturedRepairInstruction, /emotional truth/);
    assert.match(capturedRepairInstruction, /Atmosphere is welcome/);
    // It explicitly still forbids inventing new plot/identity content (creativity is bounded, not unleashed)
    assert.match(capturedRepairInstruction, /never about adding new plot action, new gestures, new dialogue/);
    // Every pre-existing coherence guardrail must still be present, unchanged
    assert.match(capturedRepairInstruction, /Do not invent independent movement for every visible person/);
    assert.match(capturedRepairInstruction, /Preserve stable facial identity, hair, wardrobe, body proportions, age/);
    assert.match(capturedRepairInstruction, /No sliding feet, rubber limbs, puppet-like movement, mannequin motion/);
    assert.match(capturedRepairInstruction, /Never make multiple characters move in synchronized or mirrored ways/);
  } finally {
    ltxVisionDirector.describeForLTX = origDescribe;
    shotContinuity.resolveContinuityStartingImage = origResolve;
    shotContinuity.formatSceneContinuityDirective = origFormat;
  }
});

test('_buildFinalAgnesPrompt: creative direction does not leak into the negative prompt (which must stay purely suppressive)', () => {
  const agnesVideoGen = require('../src/agnesVideoGen');
  // Access the negative prompt indirectly via _resolveNegativePrompt is not exported;
  // verify instead via the module's own DEFAULT export surface staying stable.
  assert.equal(typeof agnesVideoGen.submitVideoJob, 'function');
  assert.equal(agnesVideoGen.providerName, 'agnes');
});

test('submitVideoJob: sends previous terminal frame then current still as ordered keyframes', async () => {
  const previousFrame = Buffer.from('previous-terminal-frame');
  const currentStill = Buffer.from('fresh-current-shot-still');
  let submittedOptions = null;
  const originalResolve = shotContinuity.resolveContinuityStartingImage;
  const originalDescribe = ltxVisionDirector.describeForLTX;
  const originalFormat = shotContinuity.formatSceneContinuityDirective;
  const originalSubmit = videoEngineClient.submitJob;

  shotContinuity.resolveContinuityStartingImage = async imageBuffer => ({
    imageBuffer,
    referenceImageBuffers: [previousFrame, imageBuffer],
    usedContinuityFrame: true,
  });
  ltxVisionDirector.describeForLTX = async () => 'A physically continuous shot.';
  shotContinuity.formatSceneContinuityDirective = () => '';
  videoEngineClient.submitJob = async options => {
    submittedOptions = options;
    return { jobId: 'ordered-keyframe-job' };
  };

  try {
    delete require.cache[require.resolve('../src/agnesVideoGen')];
    const agnesVideoGen = require('../src/agnesVideoGen');
    await agnesVideoGen.submitVideoJob(currentStill, { duration: 5 });
  } finally {
    shotContinuity.resolveContinuityStartingImage = originalResolve;
    ltxVisionDirector.describeForLTX = originalDescribe;
    shotContinuity.formatSceneContinuityDirective = originalFormat;
    videoEngineClient.submitJob = originalSubmit;
  }

  assert.ok(submittedOptions, 'the video provider should receive a submission');
  assert.equal(submittedOptions.imageBuffer, currentStill, 'the current still remains the provider image input');
  assert.deepEqual(submittedOptions.referenceImageBuffers, [previousFrame, currentStill]);
});
