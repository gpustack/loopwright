import assert from 'node:assert/strict';
import { admitTask } from '@loopwright/core';
import { test } from 'node:test';
import { prepareInput } from '../src/preflight.js';
import { sessionInput } from './session-fixtures.js';
import { PiFailure } from '../src/errors.js';
test('role, step and model identities refuse before any session effect', () => {
  const source = sessionInput();
  for (const patch of [{ roleId: 'other' }, { stepId: 'other' }, { policy: { ...source.policy, selection: { ...source.policy.selection, model: 'other' } } }]) {
    assert.throws(() => prepareInput({ ...source, ...patch }), error => error instanceof PiFailure && error.detail.effect === 'none');
  }
});
test('strict default and hard-token routes refuse before model/container startup', () => {
  const source = sessionInput(), context: Record<string, unknown> = { ...source.policy.context }; delete context.mode;
  assert.throws(() => prepareInput({ ...source, policy: { ...source.policy, context } }), error => error instanceof PiFailure && error.detail.code === 'CONTEXT_UNSAFE');
  const contract = structuredClone(source.lock.spec.contract); (contract.spec.budgets.enforcement as { tokens: string }).tokens = 'hard_admission';
  const locked = admitTask(contract, { admissionId: source.lock.metadata.id, runId: source.lock.spec.runId }); assert.equal(locked.ok, true); if (!locked.ok) return;
  assert.throws(() => prepareInput({ ...source, lock: locked.value }), error => error instanceof PiFailure && error.detail.code === 'CAPABILITY_UNSUPPORTED');
});
test('owned input cannot be mutated and artifact bytes have no caller aliases', () => {
  const source = sessionInput(), result = prepareInput(source);
  source.candidate.artifacts[0]!.bytes[0] = 0;
  assert.notEqual(result.candidate.artifacts[0]!.bytes[0], 0);
  assert.ok(Object.isFrozen(result.policy));
});
test('accessors and proxies are rejected without running caller code', () => {
  let touched = 0; const source = sessionInput();
  const getter = { ...source }; Object.defineProperty(getter, 'policy', { enumerable: true, get: () => { touched++; throw new Error('caller getter'); } });
  const proxy = new Proxy(source, { ownKeys: () => { touched++; throw new Error('caller trap'); } });
  assert.throws(() => prepareInput(getter), PiFailure); assert.throws(() => prepareInput(proxy), PiFailure); assert.equal(touched, 0);
});
test('typed artifact views reject shared memory and ignore caller byte getters', () => {
  const source = sessionInput(); let touched = 0;
  Object.defineProperty(source.candidate.artifacts[0]!.bytes, 'byteLength', { get: () => { touched++; throw new Error('caller byte getter'); } });
  assert.ok(prepareInput(source)); assert.equal(touched, 0);
  const shared = sessionInput(); const candidate = { ...shared.candidate, artifacts: [{ name: shared.candidate.artifacts[0]!.name, bytes: new Uint8Array(new SharedArrayBuffer(4)) }] };
  assert.throws(() => prepareInput({ ...shared, candidate }), PiFailure);
});
test('unauthorized plugins, tools, destination fields and widened limits refuse', () => {
  const source = sessionInput();
  for (const policy of [
    { ...source.policy, extensions: ['@monotykamary/pi-retry'] },
    { ...source.policy, tools: ['mcp__workspace__denied_write'] },
    { ...source.policy, mcp: { ...source.policy.mcp, url: 'https://forbidden.invalid' } },
    { ...source.policy, limits: { ...source.policy.limits, responseBytes: 1048577 } },
  ]) assert.throws(() => prepareInput({ ...source, policy }), PiFailure);
});
test('candidate revision, inventory and content digests bind the owned bytes', () => {
  const source = sessionInput();
  assert.throws(() => prepareInput({ ...source, candidate: { ...source.candidate, baseRevision: 'other' } }), PiFailure);
  source.candidate.artifacts[0]!.bytes[0] = 0; assert.throws(() => prepareInput(source), PiFailure);
});

test('unsupported smaller fixed transport caps fail before startup instead of being ignored', () => {
  const source = sessionInput(); for (const limits of [{ ...source.policy.limits, frameBytes: 32768 }, { ...source.policy.limits, pendingResponseBytes: 131072 }, { ...source.policy.limits, diagnosticBytes: 32 }]) assert.throws(() => prepareInput({ ...source, policy: { ...source.policy, limits } }), error => error instanceof PiFailure && error.detail.code === 'CAPABILITY_UNSUPPORTED');
});
