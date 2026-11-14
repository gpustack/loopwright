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
test('a caller can tighten or configure explicit policy bounds within hard ceilings, while out-of-range values refuse', () => {
  for (const value of [{ workingWindowCeiling: 16777217 }, { serviceMargin: 1 }, { toolReserve: 1 }, { maxRequestBytes: 16777217 },
    { maxOutputTokens: 262145 }, { serviceMargin: Number.MAX_SAFE_INTEGER }]) {
    assert.equal(assessFinalRequestContext(encode(body()), { ...policy, ...value }, selection).ok, false);
  }
  assert.equal(assessFinalRequestContext(encode(body()), { ...policy, workingWindowCeiling: 10 }, selection).ok, false);

  const raisedSelection = { ...selection, perCallOutputTokens: 32768 };
  const raisedPolicy: ContextPolicy = { mode: 'estimated_guard', workingWindowCeiling: 8388608, maxRequestBytes: 8388608, maxOutputTokens: 32768 };
  const multiTurnMessages = Array.from({ length: 160 }, (_, idx) => ({
    role: idx % 2 === 0 ? 'user' : 'assistant',
    content: idx === 0 ? 'x'.repeat(100000) : `turn-${idx}`,
  }));
  const largeBody = encode({ ...body(), max_tokens: 32768, messages: multiTurnMessages });
  assert.ok(largeBody.byteLength > 100000);
  const admitted = assessFinalRequestContext(largeBody, raisedPolicy, raisedSelection);
  assert.equal(admitted.ok, true);
  assert.equal(assessFinalRequestContext(largeBody, { ...raisedPolicy, maxRequestBytes: 90000 }, raisedSelection).ok, false);
});
test('token-provider body validation accepts pi-ai clamped max_tokens (1..output) and bounds outputReservation while preserving legacy copilot strictness', () => {
  // Legacy copilot still requires exact max_tokens === output
  assert.equal(assessFinalRequestContext(encode({ ...body(), max_tokens: 512 }), policy, selection).ok, false);

  const tokenPolicy: ContextPolicy = {
    mode: 'estimated_guard',
    workingWindowCeiling: 128000,
    maxRequestBytes: 128000,
    maxOutputTokens: 16384,
  };

  // 1. openai-completions with clamped max_tokens / max_completion_tokens
  const completionsSelection = {
    modelId: 'glm-5.3',
    effort: 'high',
    tools: ['read'],
    contextWindow: 128000,
    perCallOutputTokens: 16384,
    provider: 'custom-glm',
    api: 'openai-completions' as const,
  };
  // Body of ~66 KB would exceed 128K if outputReservation stayed 16384 (66000 + 32768 + 16384 + 16384 = 131536 > 128000),
  // but fits when pi-ai clampMaxTokensToContext clamps outbound max_tokens to 4096 (66000 + 32768 + 4096 + 16384 = 119248 <= 128000).
  const clampedCompletions = assessFinalRequestContext(encode({
    model: 'glm-5.3',
    stream: true,
    max_tokens: 4096,
    tools: [{ type: 'function', function: { name: 'read', parameters: { type: 'object' } } }],
    messages: [{ role: 'user', content: 'x'.repeat(66000) }],
  }), tokenPolicy, completionsSelection);
  assert.equal(clampedCompletions.ok, true);
  if (clampedCompletions.ok) {
    assert.equal(clampedCompletions.value.outputReservation, 4096);
    assert.equal(clampedCompletions.value.withinWindow, true);
    assert.equal(clampedCompletions.value.coverage, 'complete');
  }

  const clampedMaxCompletion = assessFinalRequestContext(encode({
    model: 'glm-5.3',
    stream: true,
    max_completion_tokens: 1,
    messages: [{ role: 'user', content: 'hi' }],
  }), tokenPolicy, completionsSelection);
  assert.equal(clampedMaxCompletion.ok, true);
  if (clampedMaxCompletion.ok) assert.equal(clampedMaxCompletion.value.outputReservation, 1);

  for (const invalidCap of [
    { max_tokens: 0 },
    { max_tokens: -1 },
    { max_tokens: 16385 },
    { max_tokens: 1024.5 },
    { max_tokens: 4096, max_completion_tokens: 8192 },
    {},
  ]) {
    assert.equal(assessFinalRequestContext(encode({
      model: 'glm-5.3',
      stream: true,
      messages: [{ role: 'user', content: 'hi' }],
      ...invalidCap,
    }), tokenPolicy, completionsSelection).ok, false);
  }

  // 2. anthropic-messages (non-copilot provider) with clamped max_tokens
  const anthropicSelection = {
    modelId: 'claude-sonnet-4-5',
    effort: 'high',
    tools: ['read'],
    contextWindow: 128000,
    perCallOutputTokens: 16384,
    provider: 'anthropic',
    api: 'anthropic-messages' as const,
  };
  const clampedAnthropic = assessFinalRequestContext(encode({
    model: 'claude-sonnet-4-5',
    stream: true,
    max_tokens: 2048,
    messages: [{ role: 'user', content: 'hi' }],
  }), tokenPolicy, anthropicSelection);
  assert.equal(clampedAnthropic.ok, true);
  if (clampedAnthropic.ok) assert.equal(clampedAnthropic.value.outputReservation, 2048);
  assert.equal(assessFinalRequestContext(encode({
    model: 'claude-sonnet-4-5',
    stream: true,
    max_tokens: 0,
    messages: [{ role: 'user', content: 'hi' }],
  }), tokenPolicy, anthropicSelection).ok, false);
  assert.equal(assessFinalRequestContext(encode({
    model: 'claude-sonnet-4-5',
    stream: true,
    max_tokens: 16385,
    messages: [{ role: 'user', content: 'hi' }],
  }), tokenPolicy, anthropicSelection).ok, false);

  // 3. openai-responses with clamped or omitted max_output_tokens
  const responsesSelection = {
    modelId: 'gpt-5.4',
    effort: 'high',
    tools: ['read'],
    contextWindow: 128000,
    perCallOutputTokens: 16384,
    provider: 'openai',
    api: 'openai-responses' as const,
  };
  const clampedResponses = assessFinalRequestContext(encode({
    model: 'gpt-5.4',
    stream: true,
    max_output_tokens: 1024,
    input: [{ role: 'user', content: 'hi' }],
  }), tokenPolicy, responsesSelection);
  assert.equal(clampedResponses.ok, true);
  if (clampedResponses.ok) assert.equal(clampedResponses.value.outputReservation, 1024);

  const omittedResponses = assessFinalRequestContext(encode({
    model: 'gpt-5.4',
    stream: true,
    input: [{ role: 'user', content: 'hi' }],
  }), tokenPolicy, responsesSelection);
  assert.equal(omittedResponses.ok, true);
  if (omittedResponses.ok) assert.equal(omittedResponses.value.outputReservation, 16384);

  assert.equal(assessFinalRequestContext(encode({
    model: 'gpt-5.4',
    stream: true,
    max_output_tokens: 0,
    input: [{ role: 'user', content: 'hi' }],
  }), tokenPolicy, responsesSelection).ok, false);
  assert.equal(assessFinalRequestContext(encode({
    model: 'gpt-5.4',
    stream: true,
    max_output_tokens: 16385,
    input: [{ role: 'user', content: 'hi' }],
  }), tokenPolicy, responsesSelection).ok, false);
});
