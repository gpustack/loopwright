import assert from 'node:assert/strict';
import { test } from 'node:test';
import { evaluateRawResponse, TurnFailureLatch } from '../src/response.js';
function wire(reason: string, args = '{"path":"allowed.txt"}', complete = true): Buffer {
  const frames = [
    { type: 'message_start', message: { usage: { input_tokens: 4 } } },
    { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'call', name: 'read', input: {} } },
    { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: args } },
    { type: 'content_block_stop', index: 0 },
    { type: 'message_delta', delta: { stop_reason: reason }, usage: { output_tokens: 2 } },
    ...(complete ? [{ type: 'message_stop' }] : []),
  ];
  return Buffer.from(frames.map(frame => `event: ${frame.type}\ndata: ${JSON.stringify(frame)}\n\n`).join(''));
}
test('only complete raw tool_use permits its exact root identity', () => {
  const result = evaluateRawResponse(wire('tool_use'), 200); assert.equal(result.ok, true);
  const latch = new TurnFailureLatch(); latch.observe(result); assert.equal(latch.canAdmitTool('call'), true); assert.equal(latch.canAdmitTool('forged'), false);
});
test('failure latch denies effects and cannot be cleared by later settlement', () => {
  for (const reason of ['pause_turn', 'stop_sequence', 'max_tokens', 'model_context_window_exceeded', 'unknown']) {
    const latch = new TurnFailureLatch(); latch.observe(evaluateRawResponse(wire(reason), 200));
    latch.observe({ ok: true, toolCalls: [{ id: 'call', name: 'read' }] });
    assert.equal(latch.canSettle(), false); assert.equal(latch.canAdmitTool('call'), false);
  }
});
test('EOF, malformed and duplicate/incomplete arguments refuse root effects', () => {
  for (const bytes of [wire('tool_use', '{}', false), wire('tool_use', '{"path":'), wire('tool_use', '{"path":1,"path":2}'), Buffer.from('data: {broken\n\n')]) {
    assert.equal(evaluateRawResponse(bytes, 200).ok, false);
  }
  assert.equal(evaluateRawResponse(wire('tool_use'), 500).ok, false);
  assert.equal(evaluateRawResponse(wire('tool_use', '{}').subarray(0, -1), 200).ok, false);
});
