import assert from 'node:assert/strict';
import { test } from 'node:test';
import { assessFinalRequestContext, checkRequestBytes, type ContextPolicy } from '../src/context.js';
const selection = { modelId: 'claude-sonnet-5.5', effort: 'xhigh', tools: ['read'], contextWindow: 1000000, perCallOutputTokens: 1024 };
const policy: ContextPolicy = { mode: 'estimated_guard' };
const body = (content = 'hello') => ({ model: selection.modelId, messages: [{ role: 'user', content }], max_tokens: 1024,
  thinking: { type: 'adaptive' }, output_config: { effort: 'xhigh' }, stream: true });
const encode = (value: unknown) => Buffer.from(JSON.stringify(value));
function sized(bytes: number): Buffer { const empty = encode(body('')); return encode(body('x'.repeat(bytes - empty.byteLength))); }
test('default proven_bound and explicit strict mode refuse without a live proof', () => {
  assert.equal(assessFinalRequestContext(encode(body()), {}, selection).ok, false);
  assert.equal(assessFinalRequestContext(encode(body()), { mode: 'proven_bound' }, selection).ok, false);
});
test('explicit estimate admits the inclusive finalized-byte boundary and refuses its next byte', () => {
  const allowed = assessFinalRequestContext(sized(48128), policy, selection);
  assert.equal(allowed.ok, true); if (!allowed.ok) return;
  assert.equal(allowed.value.inputReservation, 80896); assert.equal(allowed.value.totalReservation, 81920);
  assert.equal(allowed.value.provenance, 'estimated'); assert.equal(allowed.value.contextFit, 'unproven');
  assert.equal(assessFinalRequestContext(sized(48129), policy, selection).ok, false);
});
test('transport bytes have an independent inclusive ceiling', () => {
  assert.equal(checkRequestBytes(sized(65536)), true); assert.equal(checkRequestBytes(sized(65537)), false);
});
test('input is covered after final system/tool/signature/multibyte serialization', () => {
  const value = { ...body('你好'), system: [{ type: 'text', text: 'frozen', cache_control: { type: 'ephemeral', ttl: '5m' } }],
    tools: [{ name: 'read', description: 'inspect', eager_input_streaming: true, input_schema: { type: 'object', properties: {} } }] };
  const bytes = encode(value), result = assessFinalRequestContext(bytes, policy, selection);
  assert.equal(result.ok, true); if (!result.ok) return;
  assert.equal(result.value.bodyBytes, bytes.byteLength);
  const changed = assessFinalRequestContext(encode({ ...value, system: 'changed' }), policy, selection);
  assert.equal(changed.ok, true); if (changed.ok) assert.notEqual(result.value.bodyDigest, changed.value.bodyDigest);
});
test('malformed, duplicate, unknown and mismatched final bodies refuse', () => {
  const invalid = [Buffer.from('{"model":"a","model":"b"}'), Buffer.from([0xff]), Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), encode(body())]), Buffer.from('\u00a0' + JSON.stringify(body())), encode({ ...body(), images: [] }),
    encode({ ...body(), model: 'other' }), encode({ ...body(), max_tokens: 1025 }), encode({ ...body(), stream: false }),
    encode({ ...body(), messages: [{ role: 'user', content: [{ type: 'image', source: {} }] }] }),
    encode({ ...body(), tools: [{ name: 'denied', input_schema: {} }] })];
  for (const value of invalid) assert.equal(assessFinalRequestContext(value, policy, selection).ok, false);
});
test('a caller can tighten the estimate but cannot widen or corrupt the profile', () => {
  for (const value of [{ workingWindowCeiling: 98305 }, { serviceMargin: 1 }, { toolReserve: 1 }, { maxRequestBytes: 65537 },
    { maxOutputTokens: 1025 }, { serviceMargin: Number.MAX_SAFE_INTEGER }]) {
    assert.equal(assessFinalRequestContext(encode(body()), { ...policy, ...value }, selection).ok, false);
  }
  assert.equal(assessFinalRequestContext(encode(body()), { ...policy, workingWindowCeiling: 10 }, selection).ok, false);
});
