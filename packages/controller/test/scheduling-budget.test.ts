import assert from 'node:assert/strict';
import { test } from 'node:test';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { PiAdapterV2, PiErrorV2, PiOutcomeV2 } from '@loopwright/agent-pi';
import type { RequestAdmission } from '@loopwright/state';
import { cycleFixture } from './scheduling-fixtures.js';
import { setFixture } from './progress-fixtures.js';
import { createCycle, Cycle, type CycleContext, type ControllerPorts } from '../src/controller.js';
import { canonical, hash } from '../src/schema.js';
import { journal } from '../src/progress.js';
import { stateValue } from '../src/storage.js';

const budgetError: PiErrorV2 = { code: 'REQUEST_REFUSED', phase: 'admission', path: '', retryable: false, effect: 'none', requestId: null, operationId: null, stateErrorCode: 'BUDGET_EXHAUSTED' };
const blocked: PiOutcomeV2 = { status: 'blocked', requestIds: [], operationIds: [], providerTermination: 'none', usage: 'none', localCleanup: 'complete', error: budgetError, cleanupError: null };
async function fixture(ports: ControllerPorts, calls = 10, tokens = 100000) {
  const f = await cycleFixture(true);
  setFixture(f.config, ['spec', 'task', 'spec', 'steps'], [{ id: 'build', kind: 'agent', uses: 'package.patch', roleId: 'builder', dependsOn: [] }]);
  setFixture(f.config, ['spec', 'profiles', 'steps'], [{ stepId: 'build', handlerRef: 'package.patch' }]);
  setFixture(f.config, ['spec', 'credentials'], [{ ref: 'copilot', template: '${PROVIDER_TOKEN}' }]);
  setFixture(f.config, ['spec', 'task', 'spec', 'budgets', 'maxModelCalls'], calls); setFixture(f.config, ['spec', 'task', 'spec', 'budgets', 'totalTokens'], tokens);
  setFixture(f.config, ['spec', 'task', 'spec', 'budgets', 'maxConcurrency'], Math.min(f.config.spec.task.spec.budgets.maxConcurrency, calls));
  setFixture(f.config, ['spec', 'task', 'spec', 'budgets', 'maxImplementationRepairs'], Math.min(f.config.spec.task.spec.budgets.maxImplementationRepairs, calls));
  await f.save(); const loaded = await f.load();
  await writeFile(join(f.root, 'unit-budget-load-return.json'), canonical({ version: 1, ok: loaded.ok, diagnostic: loaded.ok ? null : loaded.error, configPath: f.input.configPath, registryPath: f.input.registryPath, registrySha256: f.input.registrySha256, retainedBeforeAssertion: true }), { mode: 0o600 });
  assert.equal(loaded.ok, true); if (!loaded.ok) throw new Error('fixture');
  const context = await createCycle({ configuration: loaded.value, repository: f.repository, runRoot: f.runRoot, runId: 'run-budget' }, ports), cycle = new Cycle(context);
  await writeFile(join(context.directory, 'unit-budget-scope.json'), canonical({ version: 1, kind: 'synthetic-accounting-private-adapter-no-native-SDK', physicalSends: 0 }), { mode: 0o600 });
  await cycle.bootstrap();
  const retain = async (name: string, returned: unknown, before: unknown, extra: unknown = null) => {
    const records = journal(context.store);
    await writeFile(join(context.directory, name), canonical({ version: 1, level: 'synthetic-accounting-no-SDK', returned, before, records, progress: cycle.head!.ref, candidate: cycle.draft.candidate, extra, physicalSends: 0, retainedBeforeAssertions: true }), { mode: 0o600 });
    return records;
  };
  return { context, cycle, retain, close: async () => { await cycle.deadline.dispose(); await cycle.events.close(); stateValue(context.store.release(context.authority)); stateValue(context.store.close()); await context.owner.release(); } };
}
function admission(context: CycleContext, total = 100): RequestAdmission {
  const selection = context.plan.roles[0]!.policy.selection;
  return { requestId: 'unit-request', roleId: 'builder', nodeId: 'build', attemptId: 'unit-synthetic-accounting', purpose: 'task', repair: 'none', transportRetryOf: null, requestDigest: hash('synthetic accounting only'), inputUpperBound: total - 20, outputUpperBound: 20, totalUpperBound: total,
    capability: { adapterId: 'pi', adapterVersion: '0.0.0', provider: selection.provider, model: selection.model, kind: 'soft_only', coversAllBillableTokens: false, enforcesOutputBound: false }, operationId: 'unit-model-op', targetIdentity: 'fixture:no-physical-provider-send' };
}
async function account(context: CycleContext, total = 100, observed = true): Promise<void> {
  const { store, authority, artifacts } = context; stateValue(store.reserveRequest(authority, admission(context, total))); stateValue(store.authorizeRequestDispatch(authority, 'unit-request'));
  if (!observed) return;
  const op = stateValue(store.getOperation('unit-model-op')), view = stateValue(store.inspect()); assert.ok(op.dispatch);
  const input = total === 100 ? 10 : total - 20, output = total === 100 ? 5 : 20;
  stateValue(store.observeRequest(authority, 'unit-request', { receiptId: 'unit-accounted', termination: 'confirmed', outcome: 'succeeded', evidence: { evidenceId: 'unit-accounting-evidence', producerId: 'unit-synthetic-accounting', method: 'synthetic-no-SDK-no-provider', artifact: await artifacts.json('unit-usage', { input, output }),
    subject: { storeId: view.storeId, runId: view.runId, lockHash: view.lockHash, operationId: 'unit-model-op', requestId: 'unit-request', intentDigest: op.intentDigest, dispatchGeneration: op.dispatch.generation, dispatchId: op.dispatch.dispatchId } },
    usage: { requestId: 'unit-request', inputTokens: { provenance: 'reported', value: input }, outputTokens: { provenance: 'reported', value: output }, costMicrousd: { provenance: 'unknown' } } }));
}
function adapter(execute: PiAdapterV2['execute']) {
  let closes = 0, captures = 0;
  const value: PiAdapterV2 = {
    capabilities: () => { throw new Error('no synthetic capability evidence'); }, execute, compact: async () => execute({ commandId: 'unit', text: '', purpose: 'compaction', repair: 'none' }),
    events: () => ({ async *[Symbol.asyncIterator]() { yield* []; } }), cancel: async () => ({ ok: true, value: blocked }),
    capture: async () => { captures++; return { ok: false, error: { ...budgetError, code: 'RECOVERY_REQUIRED', stateErrorCode: null, effect: 'possible' } }; },
    close: async () => { closes++; return { ok: true, value: { closed: true } }; },
  };
  return { value, closes: () => closes, captures: () => captures };
}

for (const kind of ['calls', 'tokens'] as const) test('scheduling: synthetic original ' + kind + ' exhaustion stops before the next role intent or adapter open', async () => {
  let opens = 0; const f = await fixture({ openAdapter: async () => { opens++; throw new Error('exhausted scheduling'); } }, kind === 'calls' ? 1 : 10, kind === 'tokens' ? 1024 : 100000);
  try {
    await account(f.context, kind === 'tokens' ? 1024 : 100); const before = journal(f.context.store), returned = await f.cycle.finish(), after = await f.retain('unit-parent-exhaustion.json', returned, before, { kind, opens });
    assert.equal(returned.kind, 'result'); if (returned.kind !== 'result') return; assert.equal(returned.result.spec.status, 'exhausted'); assert.equal(opens, 0);
    assert.equal(f.cycle.draft.attempts.length, 0); assert.equal(after.checkpoints.length, 4); assert.ok(after.checkpoints.every(cp => cp.additionalArtifacts.length === 4)); assert.ok(f.cycle.draft.nodes.every(node => node.state === 'not_run'));
    assert.equal(canonical(after.requests), canonical(before.requests)); assert.equal(canonical(after.operations), canonical(before.operations)); assert.equal(canonical(after.view.ledger), canonical(before.view.ledger));
  } finally { await f.close(); }
});
test('scheduling: synthetic exhausted-but-uncertain accounting retains incident precedence and zero adapter opens', async () => {
  let opens = 0; const f = await fixture({ openAdapter: async () => { opens++; throw new Error('uncertain scheduling'); } }, 1);
  try {
    await account(f.context, 100, false); const before = journal(f.context.store), returned = await f.cycle.finish(), after = await f.retain('unit-exhausted-unknown.json', returned, before, { opens });
    assert.equal(returned.kind, 'incident'); if (returned.kind !== 'incident') return; assert.equal(returned.incident.code, 'RECOVERY_REQUIRED'); assert.equal(opens, 0); assert.equal(f.cycle.draft.attempts.length, 0); assert.equal(after.view.counts.dispatchedRequests, 1);
    assert.equal(canonical(after.requests), canonical(before.requests)); assert.equal(canonical(after.operations), canonical(before.operations)); assert.equal(canonical(after.view.ledger), canonical(before.view.ledger));
  } finally { await f.close(); }
});
for (const shape of ['api', 'outcome'] as const) test('scheduling: synthetic verified no-effect budget ' + shape + ' refusal preserves the original candidate only after close and full original-record equality', async () => {
  let opens = 0;
  const fake = adapter(async () => {
    const input = admission(context, 100001), refused = context.store.reserveRequest(context.authority, input);
    await writeFile(join(context.directory, 'unit-original-reserve-return.json'), canonical({ version: 1, input, returned: refused, retainedBeforeAssertions: true, level: 'synthetic-accounting-no-SDK' }), { mode: 0o600 });
    assert.equal(refused.ok, false); if (refused.ok) throw new Error('expected original S02 refusal'); assert.equal(refused.error.code, 'BUDGET_EXHAUSTED');
    return shape === 'api' ? { ok: false, error: budgetError } : { ok: true, value: blocked };
  });
  const f = await fixture({ openAdapter: async () => { opens++; return { ok: true, value: fake.value }; } }); const context = f.context;
  try {
    const before = journal(context.store), returned = await f.cycle.finish(), after = await f.retain('unit-no-effect-budget.json', returned, before, { shape, opens, closes: fake.closes(), captures: fake.captures() });
    assert.equal(returned.kind, 'result'); if (returned.kind !== 'result') return; assert.equal(returned.result.spec.status, 'exhausted'); assert.equal(opens, 1); assert.equal(fake.closes(), 1); assert.equal(fake.captures(), 0);
    assert.equal(after.requests.length, 0); assert.equal(after.operations.length, 0); assert.equal(f.cycle.draft.attempts.length, 1); assert.equal(f.cycle.generation, 0); assert.equal(canonical(after.view.ledger), canonical(before.view.ledger));
  } finally { await f.close(); }
});
test('scheduling: same original request/operation counts and ledger cannot hide a changed original operation record behind no-effect budget refusal', async () => {
  const fake = adapter(async () => {
    stateValue(context.store.authorizeOperationDispatch(context.authority, 'unit-existing'));
    const op = stateValue(context.store.getOperation('unit-existing')), view = stateValue(context.store.inspect()); assert.ok(op.dispatch);
    stateValue(context.store.recordOperationReceipt(context.authority, 'unit-existing', { receiptId: 'unit-changed-record', outcome: 'succeeded', evidence: { evidenceId: 'unit-changed-evidence', producerId: 'unit-synthetic-accounting', method: 'synthetic-read-only-no-Worker', artifact: await context.artifacts.json('unit-receipt', { kind: 'synthetic-record-transition' }),
      subject: { storeId: view.storeId, runId: view.runId, lockHash: view.lockHash, operationId: 'unit-existing', requestId: null, intentDigest: op.intentDigest, dispatchGeneration: op.dispatch.generation, dispatchId: op.dispatch.dispatchId } } }));
    return { ok: true, value: blocked };
  });
  const f = await fixture({ openAdapter: async () => ({ ok: true, value: fake.value }) }); const context = f.context;
  try {
    stateValue(context.store.putIntent(context.authority, { operationId: 'unit-existing', nodeId: 'build', attemptId: 'unit-existing-attempt', effect: 'read_only', requestDigest: hash('synthetic original intent'), targetIdentity: 'fixture:no-physical-effect' }));
    const before = journal(context.store), returned = await f.cycle.finish(), after = await f.retain('unit-same-count-changed-record.json', returned, before, { closes: fake.closes() });
    assert.equal(returned.kind, 'incident'); if (returned.kind !== 'incident') return; assert.ok(returned.incident.unavailable.includes('current_candidate')); assert.equal(after.requests.length, before.requests.length); assert.equal(after.operations.length, before.operations.length);
    assert.equal(canonical(after.view.ledger), canonical(before.view.ledger)); assert.notEqual(canonical(after.operations), canonical(before.operations)); assert.equal(after.view.counts.unresolvedOperations, 0); assert.equal(fake.closes(), 1);
  } finally { await f.close(); }
});
test('scheduling: synthetic accounted execution with missing required capture remains an incident with original charges retained', async () => {
  const fake = adapter(async () => { await account(context); return { ok: true, value: { status: 'execution_settled', requestIds: ['unit-request'], operationIds: ['unit-model-op'], providerTermination: 'confirmed', usage: 'complete', localCleanup: 'complete', error: null, cleanupError: null } }; });
  const f = await fixture({ openAdapter: async () => ({ ok: true, value: fake.value }) }); const context = f.context;
  try {
    const before = journal(context.store), returned = await f.cycle.finish(), after = await f.retain('unit-accounted-missing-capture.json', returned, before, { closes: fake.closes(), captures: fake.captures() });
    assert.equal(returned.kind, 'incident'); if (returned.kind !== 'incident') return; assert.ok(returned.incident.unavailable.includes('current_candidate')); assert.equal(after.requests.length, 1); assert.equal(after.operations.length, 1); assert.equal(after.view.ledger.admittedCalls, 1); assert.equal(after.view.ledger.chargedTokens.decimal, '15'); assert.equal(fake.captures(), 1); assert.equal(fake.closes(), 1); assert.ok(after.checkpoints.every(cp => cp.additionalArtifacts.length === 4));
  } finally { await f.close(); }
});
test('scheduling: substituted candidate body bytes cannot be preserved by a no-effect budget label and unchanged original record counts', async () => {
  const fake = adapter(async () => {
    const file = cycle.candidate.files[0]!; file.bytes[0] = 0;
    const actual = await f.context.artifacts.put('unit-substituted', Buffer.from(file.bytes), 4194304);
    await writeFile(join(f.context.directory, 'unit-substitution-input.json'), canonical({ version: 1, level: 'synthetic-private-adapter-no-SDK', name: file.name, original: cycle.candidate.manifest.spec.entries[0]!, candidate: cycle.candidate.ref, actual, retainedBeforeControllerValidation: true }), { mode: 0o600 });
    return { ok: true, value: blocked };
  });
  const f = await fixture({ openAdapter: async () => ({ ok: true, value: fake.value }) }); const cycle = f.cycle;
  try {
    const before = journal(f.context.store), returned = await cycle.finish(), after = await f.retain('unit-no-effect-body-substitution.json', returned, before, { closes: fake.closes() });
    assert.equal(returned.kind, 'incident'); if (returned.kind !== 'incident') return; assert.ok(returned.incident.unavailable.includes('current_candidate')); assert.equal(after.requests.length, 0); assert.equal(after.operations.length, 0); assert.equal(fake.closes(), 1);
  } finally { await f.close(); }
});

test('scheduling: zero-request MCP_AUTHENTICATION_REQUIRED and CAPABILITY_UNSUPPORTED open refusals produce blocked result while uncertain effect fails closed', async () => {
  const mcpAuthErr: PiErrorV2 = { code: 'MCP_AUTHENTICATION_REQUIRED', phase: 'preflight', path: '/mcp', retryable: false, effect: 'none', requestId: null, operationId: null, stateErrorCode: null };
  const capErr: PiErrorV2 = { code: 'CAPABILITY_UNSUPPORTED', phase: 'admission', path: '/policy', retryable: false, effect: 'none', requestId: null, operationId: null, stateErrorCode: null };
  for (const err of [mcpAuthErr, capErr] as const) {
    const f = await fixture({ openAdapter: async () => ({ ok: false, error: err }) });
    try {
      const returned = await f.cycle.finish();
      assert.equal(returned.kind, 'result');
      if (returned.kind === 'result') assert.equal(returned.result.spec.status, 'blocked');
    } finally { await f.close(); }
  }
  const uncertainErr: PiErrorV2 = { ...mcpAuthErr, effect: 'possible' };
  const fUncertain = await fixture({ openAdapter: async () => ({ ok: false, error: uncertainErr }) });
  try {
    const returned = await fUncertain.cycle.finish();
    assert.equal(returned.kind, 'incident');
  } finally { await fUncertain.close(); }
});
