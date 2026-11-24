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

test('loadTrustedConfiguration with explicit environment resolves strictly from environment without reading or mutating process.env', async () => {
  const f = await configurationFixture();
  const previous = process.env.PROVIDER_TOKEN;
  const hostSentinel = 'S04_HOST_PROCESS_ENV_SENTINEL_Xx11Yy22';
  const isolatedToken = 'S04_ISOLATED_ENV_CANARY_Zz33Ww44';
  try {
    process.env.PROVIDER_TOKEN = hostSentinel;
    const lookedUp: string[] = [];
    const loaded = await loadTrustedConfiguration({
      ...f.input,
      environment: name => {
        lookedUp.push(name);
        return name === 'PROVIDER_TOKEN' ? isolatedToken : undefined;
      },
    });
    assert.equal(loaded.ok, true, loaded.ok ? '' : JSON.stringify(loaded.error));
    if (!loaded.ok) return;
    assert.deepEqual(lookedUp, ['PROVIDER_TOKEN']);
    assert.equal(process.env.PROVIDER_TOKEN, hostSentinel);
    const compiled = await compilePlan(loaded.value);
    assert.equal(compiled.ok, true);
    assert.ok(!JSON.stringify({ loaded, compiled }).includes(isolatedToken));
    assert.ok(!JSON.stringify({ loaded, compiled }).includes(hostSentinel));

    // When custom environment returns undefined, loadTrustedConfiguration MUST NOT fall back to process.env.
    const missing = await loadTrustedConfiguration({
      ...f.input,
      environment: () => undefined,
    });
    assert.equal(missing.ok, false);
    if (!missing.ok) assert.equal(missing.error.code, 'CONFIG_ENV_MISSING');
    assert.equal(process.env.PROVIDER_TOKEN, hostSentinel);

    // Null-prototype input with custom environment is accepted; invalid or accessor environment is refused.
    const nullProtoInput = Object.assign(Object.create(null) as Record<string, unknown>, {
      ...f.input,
      environment: (name: string) => (name === 'PROVIDER_TOKEN' ? isolatedToken : undefined),
    }) as Parameters<typeof loadTrustedConfiguration>[0];
    const nullProtoLoaded = await loadTrustedConfiguration(nullProtoInput);
    assert.equal(nullProtoLoaded.ok, true, nullProtoLoaded.ok ? '' : JSON.stringify(nullProtoLoaded.error));

    const badEnv = await loadTrustedConfiguration({
      ...f.input,
      environment: 'not-a-function' as unknown as (name: string) => string | undefined,
    });
    assert.equal(badEnv.ok, false);
    if (!badEnv.ok) {
      assert.equal(badEnv.error.code, 'CONFIG_SCHEMA');
    }

    const getterInput = { ...f.input };
    Object.defineProperty(getterInput, 'environment', {
      enumerable: true,
      get: () => () => isolatedToken,
    });
    const getterRes = await loadTrustedConfiguration(getterInput as Parameters<typeof loadTrustedConfiguration>[0]);
    assert.equal(getterRes.ok, false);
    if (!getterRes.ok) {
      assert.equal(getterRes.error.code, 'CONFIG_SCHEMA');
    }
  } finally {
    if (previous === undefined) delete process.env.PROVIDER_TOKEN; else process.env.PROVIDER_TOKEN = previous;
    await f.cleanup();
  }
});
