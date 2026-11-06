import assert from 'node:assert/strict';
import { test } from 'node:test';
import { constructAdapter } from '../src/adapter.js';
import { Sender } from '../src/sender.js';
import { canonical, digest } from '../src/boundary.js';
import { systemPrompt } from '../src/resources.js';
import { PROVIDER_DESTINATION, type RuntimeBroker } from '../src/provider.js';
import type { PiCapabilities, PiHost, PiOpenInput } from '../src/types.js';
import { requestFixture, stateGood } from './request-fixtures.js';
const stream = () => [{ type: 'message_start', message: { id: 'fixture', type: 'message', role: 'assistant', model: 'claude-sonnet-5.5', content: [], usage: { input_tokens: 4, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } } },
  { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }, { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'OK' } }, { type: 'content_block_stop', index: 0 },
  { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 2 } }, { type: 'message_stop' }].map(frame => `event: ${frame.type}\ndata: ${JSON.stringify(frame)}\n\n`).join('');
test('public command uses the same production owner sender and preserves final persistent accounting', async () => {
  const f = await requestFixture(() => ({ status: 200, body: stream() }), undefined, 10000); let adapter;
  try {
    const opened = await constructAdapter(f.host, f.input, {
      environment: async () => {},
      // Only the isolated SDK transport/parser is replaced here; the actual Sender and S02 are used.
      ...{ sender: (host: PiHost, input: PiOpenInput) => new Sender(host, input, { fetch: (_url, options) => globalThis.fetch(f.destination, options) }) },
      session: (_host, owned, candidate) => ({
        start: async (): Promise<PiCapabilities> => ({ version: 1, policyDigest: digest(Buffer.from(canonical(owned.policy))), runtime: owned.policy.runtime, requested: owned.policy.selection, catalogSupported: owned.policy.selection, sessionEffective: owned.policy.selection, outboundObserved: null,
          resources: owned.policy.resources, accounting: 'soft_only', contextFit: 'unproven', defaultMode: 'proven_bound', liveProvenBoundAvailable: false, optInMode: 'estimated_guard', contextEstimator: { id: 'lw-pi-final-json-bytes-v1', version: 1, provenance: 'estimated' }, toolExecution: { candidate: 'read_only', candidateWrites: 'mediated', scratch: 'per_call' } }),
        command: async (_kind, value) => {
          const broker = candidate as unknown as RuntimeBroker, slot = await broker.invoke({ invocation: 1, ...owned.policy.selection });
          const bytes = Buffer.from(JSON.stringify({ model: 'claude-sonnet-5.5', system: [{ type: 'text', text: systemPrompt(owned) + '\n\n<cwd>\n/workspace/candidate\n</cwd>' }], messages: [{ role: 'user', content: (value as { text: string }).text }], max_tokens: 1024, thinking: { type: 'adaptive' }, output_config: { effort: 'xhigh' }, stream: true }));
          await broker.send({ invocation: 1, slot: slot.slot, method: 'POST', url: PROVIDER_DESTINATION, headers: { 'content-type': 'application/json', 'anthropic-version': '2023-06-01', 'x-initiator': 'user', 'openai-intent': 'conversation-edits' } }, bytes);
          await broker.parsed({ invocation: 1, slot: slot.slot, stopReason: 'stop', rawStopReason: 'end_turn', usage: { input: 4, output: 2, cacheRead: 0, cacheWrite: 0 }, toolCalls: [] }); return { stopReason: 'stop' };
        }, close: async () => {},
      }),
    });
    assert.equal(opened.ok, true); if (!opened.ok) return; adapter = opened.value;
    const outcome = await adapter.execute({ commandId: 'public-command', text: 'literal owner command', purpose: 'task', repair: 'none' });
    assert.equal(outcome.ok, true); if (outcome.ok) { assert.equal(outcome.value.status, 'execution_settled'); assert.equal(outcome.value.requestIds.length, 1); }
    assert.equal(f.physical(), 1); const view = stateGood(f.host.store.inspect()); assert.equal(view.ledger.reportedTokens.decimal, '6'); assert.equal(view.ledger.heldSlots, 0);
    assert.equal(canonical(adapter.capabilities().outboundObserved), canonical(f.input.policy.selection));
  } finally { await adapter?.close(); await f.cleanup(); }
});
