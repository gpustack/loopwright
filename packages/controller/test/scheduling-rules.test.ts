import assert from 'node:assert/strict';
import { test } from 'node:test';
import { nextNode, compactionTarget, descendants } from '../src/scheduler.js';
import { failureSignature, rememberFailure, repairDisposition, formatPolicy } from '../src/repair.js';
import { retainedFixture } from './progress-fixtures.js';
import { hash } from '../src/schema.js';

test('scheduling: ready nodes are stable, failed dependencies become not_run, independent branches continue', async () => {
  const f = await retainedFixture();
  try {
    const plan = { ...f.plan, orderedDAG: [
      { ...f.plan.orderedDAG[0]!, id: 'a', dependsOn: [] }, { ...f.plan.orderedDAG[0]!, id: 'b', dependsOn: ['a'] },
      { ...f.plan.orderedDAG[0]!, id: 'c', dependsOn: [] }, { ...f.plan.orderedDAG[0]!, id: 'd', dependsOn: ['b'] },
    ] };
    assert.equal(nextNode(plan, plan.orderedDAG.map(node => ({ id: node.id, state: 'pending' })))?.id, 'a');
    const states = [{ id: 'a', state: 'failed' as const }, { id: 'b', state: 'not_run' as const }, { id: 'c', state: 'pending' as const }, { id: 'd', state: 'not_run' as const }];
    assert.equal(nextNode(plan, states)?.id, 'c'); assert.deepEqual(descendants(plan, 'a'), ['b', 'd']);
    assert.equal(nextNode(plan, states.map(node => ({ ...node, state: 'completed' as const }))), null);
  } finally { await f.close(); }
});

test('scheduling: explicit compaction selects one maximal same-role ordinary ancestor and refuses ambiguity', async () => {
  const f = await retainedFixture();
  try {
    const ordinary = { ...f.plan.orderedDAG[0]!, id: 'a', dependsOn: [] }, second = { ...ordinary, id: 'b', dependsOn: ['a'] };
    const compact = { ...ordinary, id: 'compact', dependsOn: ['b'], handler: { ...ordinary.handler, implementation: 'pi.compact.v1' as const, parameters: {} } };
    const plan = { ...f.plan, orderedDAG: [ordinary, second, compact] };
    assert.equal(compactionTarget(plan, 'compact'), 'b');
    assert.throws(() => compactionTarget({ ...plan, orderedDAG: [ordinary, { ...second, dependsOn: [] }, { ...compact, dependsOn: ['a', 'b'] }] }, 'compact'), /CAPABILITY_UNSUPPORTED/);
    assert.throws(() => compactionTarget({ ...plan, orderedDAG: [{ ...compact, dependsOn: [] }] }, 'compact'), /CAPABILITY_UNSUPPORTED/);
  } finally { await f.close(); }
});

test('scheduling: failure signatures ignore transient receipt identity and stop before a third unchanged failure', () => {
  const facts = { category: 'implementation' as const, codes: ['property_mismatch'], handler: 'json-artifact.v1', handlerVersion: 1, target: 'packages/result.json', candidate: hash('candidate'), evidence: [hash('stable-output')] };
  const signature = failureSignature(facts); assert.deepEqual(signature, failureSignature({ ...facts, codes: [...facts.codes] }));
  let failures = rememberFailure([], signature, 1, null); assert.equal(failures[0]!.count, 1);
  failures = rememberFailure(failures, signature, 1, null); assert.equal(failures[0]!.count, 2);
  assert.equal(repairDisposition('implementation', { attempts: 1, maxAttempts: 3, formatRepairs: 0, implementationRepairs: 1, maxFormatRepairs: 1, maxImplementationRepairs: 2, repeats: 2, actionable: true, uncertain: false }), 'REPEAT_FAILURE');
  assert.equal(repairDisposition('format', { attempts: 0, maxAttempts: 3, formatRepairs: 0, implementationRepairs: 0, maxFormatRepairs: 0, maxImplementationRepairs: 2, repeats: 1, actionable: true, uncertain: false }), 'BUDGET_EXHAUSTED');
  assert.equal(repairDisposition('implementation', { attempts: 1, maxAttempts: 3, formatRepairs: 0, implementationRepairs: 1, maxFormatRepairs: 1, maxImplementationRepairs: 2, repeats: 1, actionable: false, uncertain: false }), 'EVIDENCE_UNAVAILABLE');
  assert.equal(repairDisposition('implementation', { attempts: 1, maxAttempts: 3, formatRepairs: 0, implementationRepairs: 1, maxFormatRepairs: 1, maxImplementationRepairs: 2, repeats: 1, actionable: true, uncertain: true }), 'RECOVERY_REQUIRED');
  assert.equal(repairDisposition('implementation', { attempts: 1, maxAttempts: 3, formatRepairs: 0, implementationRepairs: 1, maxFormatRepairs: 1, maxImplementationRepairs: 2, repeats: 1, actionable: true, uncertain: false }), null);
  assert.notDeepEqual(signature, failureSignature({ ...facts, candidate: hash('changed') }));
});

test('scheduling: format repair keeps selection/context/limits and removes every tool and MCP grant', async () => {
  const f = await retainedFixture();
  try { const policy = formatPolicy(f.plan.roles[0]!.policy); assert.deepEqual(policy.tools, []); assert.deepEqual(policy.mcp.names, []); assert.deepEqual(policy.mcp.effects, []);
    for (const field of ['selection', 'context', 'limits', 'resources', 'runtime'] as const) assert.deepEqual(policy[field], f.plan.roles[0]!.policy[field]);
  } finally { await f.close(); }
});

test('scheduling: original S02 cutoff stops work before the reserved drain and signals revoke independently', async () => {
  const { WorkDeadline } = await import('../src/deadlines.js');
  const f = await retainedFixture();
  try {
    const external = new AbortController(), before = f.store.inspect(); assert.equal(before.ok, true); if (!before.ok) return;
    const deadline = new WorkDeadline(f.store, f.authority, 120000, external.signal);
    assert.equal(deadline.deadline.toString(), before.value.clock.basis.taskDeadlineMonotonicMs); assert.equal(deadline.deadline - deadline.cutoff, 120000n);
    deadline.assert(); let stopped = 0; deadline.onStop(async () => { stopped++; }); external.abort();
    assert.equal(deadline.abort.signal.aborted, true); assert.throws(() => deadline.assert(), /CANCELLED/); await deadline.dispose(); assert.equal(stopped, 1);
    const expired = new WorkDeadline(f.store, f.authority, 1000000000, new AbortController().signal);
    assert.equal(expired.abort.signal.aborted, true); assert.throws(() => expired.assert(), /DEADLINE/); await expired.dispose();
  } finally { await f.close(); }
});

test('scheduling: bounded deterministic finalizer preserves an already retained primary across secondary refusal', async () => {
  const { Finalizer } = await import('../src/finalize.js');
  const f = await retainedFixture();
  try {
    const finalizer = new Finalizer(f.artifacts, 5000), primary = await finalizer.put('result', { primary: 'blocked', reason: 'fixture_boundary' });
    await finalizer.put('summary', { bounded: 'a'.repeat(600000) });
    await assert.rejects(finalizer.put('observations', { bounded: 'b'.repeat(600000) }), /OUTPUT_LIMIT/);
    assert.deepEqual(JSON.parse(Buffer.from(await f.artifacts.read(primary)).toString()), { primary: 'blocked', reason: 'fixture_boundary' });
  } finally { await f.close(); }
});
