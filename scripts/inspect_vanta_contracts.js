#!/usr/bin/env node
'use strict';

const vanta = require('../src/vantaRendererClient');

(async () => {
  const snapshot = await vanta.inspectContracts({ refresh: true });
  console.log(JSON.stringify({
    baseUrl: vanta.baseUrl,
    workflowIds: snapshot.workflows.map(w => w.id),
    workflows: snapshot.contracts.map(({ registry, contract }) => ({
      id: registry.id,
      version: registry.version,
      type: registry.type,
      provider: registry.provider,
      comfy_workflow: registry.comfy_workflow,
      capabilities: registry.capabilities || [],
      requiredInputs: contract?.contract?.input?.required || contract?.input?.required || [],
      inputProperties: Object.keys(contract?.contract?.input?.properties || contract?.input?.properties || {}),
      contract,
    })),
    discovery: snapshot.discovery,
  }, null, 2));
})().catch(err => {
  console.error(`[VANTA CONTRACT CHECK FAILED] ${err.message}`);
  process.exitCode = 1;
});
