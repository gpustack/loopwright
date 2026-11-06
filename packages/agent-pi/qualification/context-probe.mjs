/* global Buffer, console, process */
import assert from 'node:assert/strict';
import { assessFinalRequestContext as assess, checkRequestBytes } from '../dist/context.js';
export function contextProbe() {
  const selection = { modelId: 'claude-sonnet-5.5', effort: 'xhigh', tools: ['read'], contextWindow: 1000000, perCallOutputTokens: 1024 };
  const base = { model: selection.modelId, messages: [{ role: 'user', content: '' }], thinking: { type: 'adaptive' }, output_config: { effort: 'xhigh' }, stream: true, max_tokens: 1024 };
  const bytes = n => Buffer.from(JSON.stringify({ ...base, messages: [{ role: 'user', content: 'x'.repeat(n - Buffer.byteLength(JSON.stringify(base))) }] }));
  assert.equal(assess(bytes(300), {}, selection).ok, false); assert.equal(assess(bytes(300), { mode: 'proven_bound' }, selection).ok, false);
  assert.equal(assess(bytes(48128), { mode: 'estimated_guard' }, selection).ok, true); assert.equal(assess(bytes(48129), { mode: 'estimated_guard' }, selection).ok, false);
  assert.equal(checkRequestBytes(bytes(65536)), true); assert.equal(checkRequestBytes(bytes(65537)), false);
  return { status: 'passed', defaultMode: 'refused', inclusiveBodyBytes: 48128, nextByte: 'refused', transportByteCeiling: 65536, contextFit: 'unproven' };
}
if (import.meta.url === `file://${process.argv[1]}`) console.log(JSON.stringify(contextProbe(), null, 2));
