import assert from 'node:assert/strict';
import { test } from 'node:test';
import { inspectRawResponse } from '../src/usage.js';
function wire(patch: { cache?: boolean; output?: boolean; reason?: string; final?: boolean; input?: number } = {}): Buffer {
  const usage = { input_tokens: patch.input ?? 4, ...(patch.cache === false ? {} : { cache_read_input_tokens: 2, cache_creation_input_tokens: 3 }), output_tokens: 0 };
  const events = [{ type: 'message_start', message: { id: 'msg', type: 'message', role: 'assistant', model: 'claude-sonnet-5.5', content: [], usage } },
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }, { type: 'content_block_stop', index: 0 },
    { type: 'message_delta', delta: { stop_reason: patch.reason ?? 'end_turn' }, usage: patch.output === false ? {} : { output_tokens: 2 } }, ...(patch.final === false ? [] : [{ type: 'message_stop' }])];
  return Buffer.from(events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(''));
}
test('raw usage adds cache input once and never adds reasoning or totalTokens again', () => {
  const inspected = inspectRawResponse(wire(), 200, 'claude-sonnet-5.5'); assert.equal(inspected.termination, 'confirmed'); assert.equal(inspected.admission.ok, true);
  assert.deepEqual(inspected.usage.inputTokens, { provenance: 'reported', value: 9 }); assert.deepEqual(inspected.usage.outputTokens, { provenance: 'reported', value: 2 }); assert.deepEqual(inspected.usage.costMicrousd, { provenance: 'unknown' });
  const crlf = Buffer.from(wire().toString().replace(/\n/g, '\r\n')); assert.equal(inspectRawResponse(crlf, 200, 'claude-sonnet-5.5').admission.ok, true);
});
test('missing cache/output and interrupted or invalid counters stay unknown', () => {
  assert.deepEqual(inspectRawResponse(wire({ cache: false }), 200, 'claude-sonnet-5.5').usage.inputTokens, { provenance: 'unknown' });
  assert.deepEqual(inspectRawResponse(wire({ output: false }), 200, 'claude-sonnet-5.5').usage.outputTokens, { provenance: 'unknown' });
  for (const bytes of [wire({ final: false }), wire({ input: -1 })]) { const value = inspectRawResponse(bytes, 200, 'claude-sonnet-5.5'); assert.equal(value.admission.ok, false); assert.deepEqual(value.usage.inputTokens, { provenance: 'unknown' }); }
});
test('known context/length failures can settle raw counts while execution still fails', () => {
  for (const reason of ['model_context_window_exceeded', 'max_tokens', 'pause_turn', 'stop_sequence']) {
    const value = inspectRawResponse(wire({ reason }), 200, 'claude-sonnet-5.5'); assert.equal(value.admission.ok, false); assert.equal(value.termination, 'confirmed'); assert.deepEqual(value.usage.inputTokens, { provenance: 'reported', value: 9 });
  }
  const value = inspectRawResponse(wire({ reason: 'future_unknown' }), 200, 'claude-sonnet-5.5'); assert.equal(value.termination, 'unknown'); assert.deepEqual(value.usage.inputTokens, { provenance: 'unknown' });
});
test('terminal HTTP errors never manufacture zero usage or non-execution refunds', () => {
  const bytes = Buffer.from(JSON.stringify({ type: 'error', error: { type: 'rate_limit_error' } }));
  const value = inspectRawResponse(bytes, 429, 'claude-sonnet-5.5'); assert.equal(value.termination, 'confirmed'); assert.equal(value.admission.ok, false); assert.deepEqual(value.usage.inputTokens, { provenance: 'unknown' }); assert.deepEqual(value.usage.outputTokens, { provenance: 'unknown' });
});
test('provider event and total response bounds are distinct from private protocol frames', () => {
  const input = wire().toString().replace('"text":""', '"text":' + JSON.stringify('x'.repeat(2_000_000)));
  assert.equal(inspectRawResponse(Buffer.from(input), 200, 'claude-sonnet-5.5').admission.ok, true);
  assert.equal(inspectRawResponse(Buffer.from(input + 'x'.repeat(67_108_864)), 200, 'claude-sonnet-5.5').admission.ok, false);
});
