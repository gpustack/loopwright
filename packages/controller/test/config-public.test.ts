import test from 'node:test';
import assert from 'node:assert/strict';
import { loadTrustedConfiguration, compilePlan } from '@loopwright/controller';
import { configurationFixture, TOKEN } from './config-fixtures.js';
test('public installed loader and compiler use only the approved launching environment and return no authority', async () => {
  const f = await configurationFixture(), previous = process.env.PROVIDER_TOKEN;
  try {
    process.env.PROVIDER_TOKEN = TOKEN;
    const loaded = await loadTrustedConfiguration(f.input); assert.equal(loaded.ok, true); if (!loaded.ok) return;
    const compiled = await compilePlan(loaded.value); assert.equal(compiled.ok, true); if (!compiled.ok) return;
    assert.equal(compiled.value.admission, 'not_performed'); assert.equal(compiled.value.runId, null); assert.equal(compiled.value.lock, null);
    assert.equal(compiled.value.effectfulReadiness, 'not_checked'); assert.ok(!JSON.stringify({ loaded, compiled }).includes(TOKEN));
  } finally {
    if (previous === undefined) delete process.env.PROVIDER_TOKEN; else process.env.PROVIDER_TOKEN = previous;
    await f.cleanup();
  }
});

test('public plans retain command digests while withholding private role prompt bytes', async () => {
  const f = await configurationFixture(), previous = process.env.PROVIDER_TOKEN;
  try {
    const privatePrompt = 'PRIVATE_ROLE_COMMAND_DO_NOT_RENDER_96f71';
    const handler = f.registry.spec.handlers.find(handler => handler.implementation === 'pi.agent.v1')!;
    (handler.parameters as Record<string, unknown>).prompt = privatePrompt;
    await f.save(); process.env.PROVIDER_TOKEN = TOKEN;
    const loaded = await loadTrustedConfiguration(f.input); assert.ok(loaded.ok); if (!loaded.ok) return;
    const plan = await compilePlan(loaded.value); assert.ok(plan.ok, JSON.stringify(plan)); if (!plan.ok) return;
    assert.equal(JSON.stringify(plan.value).includes(privatePrompt), false);
    assert.match(String(plan.value.orderedDAG[0]!.handler.parameters.prompt), /^\[private command sha256:[a-f0-9]{64}\]$/);
  } finally { if (previous === undefined) delete process.env.PROVIDER_TOKEN; else process.env.PROVIDER_TOKEN = previous; await f.cleanup(); }
});
