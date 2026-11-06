import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readdirSync, linkSync } from 'node:fs';
import { join } from 'node:path';
import { constructAdapter } from '../src/adapter.js';
import { Sender } from '../src/sender.js';
import { canonical, digest } from '../src/boundary.js';
import { systemPrompt } from '../src/resources.js';
import { PROVIDER_DESTINATION } from '../src/provider.js';
import type { PiAdapter, PiCapabilities } from '../src/types.js';
import { requestFixture, stateGood } from './request-fixtures.js';
// Failed-cleanup fixtures deliberately retain their live owner handles until this test process exits.
const retainedCleanupFaults: PiAdapter[] = [];
function stream(reason: string): string {
  return [{ type: 'message_start', message: { id: 'fixture', role: 'assistant', model: 'claude-sonnet-5.5', content: [], usage: { input_tokens: 4, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } } },
    { type: 'message_delta', delta: { stop_reason: reason }, usage: { output_tokens: 2 } }, { type: 'message_stop' }]
    .map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join('');
}
async function fixture(mode: 'length' | 'unknown' | 'cancel' | 'cleanup' | 'lease-cleanup' | 'settled' | 'later-cancel' | 'completion-race') {
  const f = await requestFixture(call => mode === 'unknown' ? { status: 503, body: '{}', headers: { 'content-type': 'application/json' } } : { status: 200, body: (mode === 'cancel' || mode === 'later-cancel' && call === 2) ? stream('end_turn').split('event: message_stop')[0]! : stream(call === 2 ? 'max_tokens' : 'end_turn') }, undefined, 10000);
  let started!: () => void, stop!: () => void; const entered = new Promise<void>(resolve => { started = resolve; }), stopped = new Promise<void>(resolve => { stop = resolve; });
  let invocationSequence = 0, commands = 0;
  const opened = await constructAdapter(f.host, f.input, { environment: async () => {}, sender: (host, input) => new Sender(host, input, { fetch: (_url, init) => globalThis.fetch(f.destination, init) }),
    session: (_host, input, broker) => ({
      start: async (): Promise<PiCapabilities> => ({ version: 1, policyDigest: digest(Buffer.from(canonical(input.policy))), runtime: input.policy.runtime, requested: input.policy.selection, catalogSupported: input.policy.selection, sessionEffective: input.policy.selection, outboundObserved: null, resources: input.policy.resources, accounting: 'soft_only', contextFit: 'unproven', defaultMode: 'proven_bound', liveProvenBoundAvailable: false, optInMode: 'estimated_guard', contextEstimator: { id: 'lw-pi-final-json-bytes-v1', version: 1, provenance: 'estimated' }, toolExecution: { candidate: 'read_only', candidateWrites: 'mediated', scratch: 'per_call' } }),
      command: async () => {
        commands++;
        for (let count = 0; count < (mode === 'length' || mode === 'cleanup' || mode === 'lease-cleanup' ? 2 : 1); count++) {
          const invocation = ++invocationSequence;
          const grant = await broker.invoke({ invocation, ...input.policy.selection });
          const body = Buffer.from(JSON.stringify({ model: input.policy.selection.model, system: [{ type: 'text', text: systemPrompt(input) + '\n\n<cwd>\n/workspace/candidate\n</cwd>' }], messages: [{ role: 'user', content: 'literal fixture' }], max_tokens: 1024, thinking: { type: 'adaptive' }, output_config: { effort: 'xhigh' }, stream: true }));
          await broker.send({ invocation, slot: grant.slot, method: 'POST', url: PROVIDER_DESTINATION, headers: { 'content-type': 'application/json', 'anthropic-version': '2023-06-01', 'x-initiator': 'user', 'openai-intent': 'conversation-edits' } }, body);
          if (mode === 'cancel' || mode === 'later-cancel' && commands === 2) { started(); await stopped; return; }
          await broker.parsed({ invocation, slot: grant.slot, stopReason: mode === 'unknown' ? 'error' : ['length', 'cleanup', 'lease-cleanup'].includes(mode) && invocation === 2 ? 'length' : 'stop', rawStopReason: ['length', 'cleanup', 'lease-cleanup'].includes(mode) && invocation === 2 ? 'max_tokens' : 'end_turn', usage: { input: 4, output: 2, cacheRead: 0, cacheWrite: 0 }, toolCalls: [] });
          if (mode === 'completion-race') { started(); await stopped; }
        }
      }, close: async () => { stop(); if (mode === 'cleanup') throw new Error('synthetic cleanup failure'); if (mode === 'lease-cleanup') { const name = readdirSync(f.host.artifactsDirectory).find(name => name.startsWith('pi-execution-')); assert.ok(name); linkSync(join(f.host.artifactsDirectory, name), join(f.directory, 'guard-extra-link')); } },
    }) });
  assert.equal(opened.ok, true); if (!opened.ok) throw new Error('fixture open');
  return { ...f, adapter: opened.value, entered, complete: () => stop() };
}
test('a failed admitted turn retains both requests, complete usage and OUTPUT_LIMIT at the public boundary', async () => {
  const f = await fixture('length');
  try {
    const result = await f.adapter.execute({ commandId: 'two-sends', text: 'literal', purpose: 'task', repair: 'none' });
    assert.equal(result.ok, true); if (!result.ok) throw new Error('execution facts lost');
    assert.equal(result.value.status, 'failed'); assert.equal(result.value.requestIds.length, 2); assert.equal(result.value.operationIds.length, 2);
    assert.equal(result.value.providerTermination, 'confirmed'); assert.equal(result.value.usage, 'complete'); assert.equal(result.value.localCleanup, 'complete');
    assert.equal((result.value as unknown as { error: { code: string } }).error.code, 'OUTPUT_LIMIT');
    const repeat = await f.adapter.execute({ commandId: 'no-replay', text: 'literal', purpose: 'task', repair: 'none' }); assert.equal(repeat.ok, false); assert.equal(f.physical(), 2);
  } finally { await f.adapter.close(); await f.cleanup(); }
});
test('unknown provider termination retains its request and charge in a recovery outcome', async () => {
  const f = await fixture('unknown');
  try { const result = await f.adapter.execute({ commandId: 'unknown', text: 'literal', purpose: 'task', repair: 'none' }); assert.equal(result.ok, true); if (!result.ok) throw new Error('execution facts lost'); assert.equal(result.value.status, 'recovery_required'); assert.equal(result.value.requestIds.length, 1); assert.equal(result.value.providerTermination, 'unknown'); assert.equal(result.value.usage, 'incomplete'); assert.equal(result.value.localCleanup, 'complete'); assert.equal(stateGood(f.host.store.inspect()).ledger.heldSlots, 1); }
  finally { await f.adapter.close(); await f.cleanup(); }
});
test('cancellation preserves active request facts after command drain', async () => {
  const f = await fixture('cancel');
  try { const running = f.adapter.execute({ commandId: 'cancelled', text: 'literal', purpose: 'task', repair: 'none' }); await f.entered; const cancelled = await f.adapter.cancel({ reason: 'operator' }), result = await running; assert.equal(cancelled.ok, true); assert.equal(result.ok, true); if (!cancelled.ok || !result.ok) throw new Error('execution facts lost'); assert.equal(cancelled.value.status, 'recovery_required'); assert.deepEqual(cancelled.value.requestIds, result.value.requestIds); assert.equal(cancelled.value.requestIds.length, 1); assert.equal(cancelled.value.providerTermination, 'unknown'); assert.equal(cancelled.value.localCleanup, 'complete'); assert.equal(f.physical(), 1); }
  finally { await f.adapter.close(); await f.cleanup(); }
});
test('cleanup failure cannot overwrite the original execution cause or claim complete cleanup', async () => {
  const f = await fixture('cleanup'); retainedCleanupFaults.push(f.adapter);
  try { const result = await f.adapter.execute({ commandId: 'cleanup-failure', text: 'literal', purpose: 'task', repair: 'none' }); assert.equal(result.ok, true); if (!result.ok) throw new Error('execution facts lost'); assert.equal(result.value.status, 'recovery_required'); assert.equal(result.value.requestIds.length, 2); assert.equal(result.value.localCleanup, 'failed'); const facts = result.value as unknown as { error: { code: string }; cleanupError: { code: string } }; assert.equal(facts.error.code, 'OUTPUT_LIMIT'); assert.equal(facts.cleanupError.code, 'CLEANUP_FAILED'); assert.equal((await f.adapter.close()).ok, false); }
  finally { await f.cleanup(); }
});
test('post-drain execution-guard release failure still returns the original execution facts', async () => {
  const f = await fixture('lease-cleanup'); retainedCleanupFaults.push(f.adapter);
  try { const result = await f.adapter.execute({ commandId: 'guard-release-failure', text: 'literal', purpose: 'task', repair: 'none' }); assert.equal(result.ok, true); if (!result.ok) throw new Error('execution facts lost'); assert.equal(result.value.status, 'recovery_required'); assert.equal(result.value.requestIds.length, 2); assert.equal(result.value.error?.code, 'OUTPUT_LIMIT'); assert.equal(result.value.providerTermination, 'confirmed'); assert.equal(result.value.usage, 'complete'); assert.equal(result.value.localCleanup, 'failed'); assert.equal(result.value.cleanupError?.code, 'RECOVERY_REQUIRED'); assert.equal(result.value.cleanupError.phase, 'cleanup'); const closed = await f.adapter.close(); assert.equal(closed.ok, false); if (!closed.ok) assert.equal(closed.error.phase, 'cleanup'); }
  finally { await f.cleanup(); }
});

for (const mode of ['settled', 'length'] as const) test('idle repeated cancel preserves the prior ' + mode + ' status and execution facts', async () => {
  const f = await fixture(mode);
  try {
    const execution = await f.adapter.execute({ commandId: 'terminal', text: 'literal', purpose: 'task', repair: 'none' }); assert.equal(execution.ok, true); if (!execution.ok) throw Error('missing outcome');
    assert.equal(execution.value.status, mode === 'settled' ? 'execution_settled' : 'failed');
    for (let call = 0; call < 2; call++) { const result = await f.adapter.cancel({ reason: 'operator' }); assert.equal(result.ok, true); if (!result.ok) throw Error('missing cancel'); assert.deepEqual(result.value, execution.value); }
  } finally { await f.adapter.close(); await f.cleanup(); }
});
test('cancelling a later active turn and repeating it never returns the earlier settled request', async () => {
  const f = await fixture('later-cancel');
  try {
    const first = await f.adapter.execute({ commandId: 'first', text: 'literal', purpose: 'task', repair: 'none' }); assert.equal(first.ok, true); if (!first.ok) throw Error('first missing'); assert.equal(first.value.status, 'execution_settled');
    const second = f.adapter.execute({ commandId: 'second', text: 'literal', purpose: 'task', repair: 'none' }); await f.entered;
    const cancelled = await f.adapter.cancel({ reason: 'operator' }), execution = await second; assert.equal(cancelled.ok, true); assert.equal(execution.ok, true); if (!cancelled.ok || !execution.ok) throw Error('second missing');
    assert.equal(cancelled.value.status, 'recovery_required'); assert.equal(cancelled.value.requestIds.length, 1); assert.deepEqual(cancelled.value.requestIds, execution.value.requestIds); assert.notDeepEqual(cancelled.value.requestIds, first.value.requestIds); assert.equal(cancelled.value.providerTermination, 'unknown'); assert.equal(cancelled.value.usage, 'incomplete');
    const repeat = await f.adapter.cancel({ reason: 'operator' }); assert.equal(repeat.ok, true); if (repeat.ok) assert.deepEqual(repeat.value, cancelled.value); assert.equal(f.physical(), 2);
  } finally { await f.adapter.close(); await f.cleanup(); }
});
test('completion and cancellation in the same bounded microtask interval preserve the interrupted command facts', async () => {
  const f = await fixture('completion-race');
  try {
    const running = f.adapter.execute({ commandId: 'race', text: 'literal', purpose: 'task', repair: 'none' }); await f.entered; f.complete();
    const cancelled = await f.adapter.cancel({ reason: 'operator' }), outcome = await running; assert.equal(cancelled.ok, true); assert.equal(outcome.ok, true); if (!cancelled.ok || !outcome.ok) throw Error('race missing');
    assert.equal(cancelled.value.status, 'cancelled'); assert.deepEqual(cancelled.value.requestIds, outcome.value.requestIds); assert.equal(cancelled.value.requestIds.length, 1); assert.equal(cancelled.value.providerTermination, 'confirmed'); assert.equal(cancelled.value.usage, 'complete'); assert.equal(cancelled.value.error?.code, 'CANCELLED');
    const repeat = await f.adapter.cancel({ reason: 'operator' }); assert.equal(repeat.ok, true); if (repeat.ok) assert.deepEqual(repeat.value, cancelled.value);
  } finally { await f.adapter.close(); await f.cleanup(); }
});
