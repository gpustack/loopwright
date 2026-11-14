import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  hasPositiveModelCost, resolveBuiltInPiCatalogModel, resolveCatalogModel, resolveProviderAuthHeaderName,
  resolveProviderDestination, validateCustomProviderConfig, validateModelCost, validateSelection,
} from '../src/catalog-api.js';
import { evaluateRawResponse } from '../src/response.js';
import { inspectRawResponse } from '../src/usage.js';

test('built-in token Pi providers (zai/glm-5.3, zai-coding-cn/glm-5.3, anthropic, openai) resolve destinations and auth headers', () => {
  const zai = validateSelection({
    provider: 'zai',
    model: 'glm-5.3',
    thinking: 'high',
    api: 'openai-completions',
  });
  const zaiCatalog = resolveBuiltInPiCatalogModel('zai', 'glm-5.3');
  assert.ok(zaiCatalog);
  assert.equal(zaiCatalog.api, 'openai-completions');
  assert.equal(resolveProviderDestination(zai), 'https://api.z.ai/api/coding/paas/v4/chat/completions');
  assert.equal(resolveProviderAuthHeaderName(zai), 'authorization');

  const zaiCn = validateSelection({
    provider: 'zai-coding-cn',
    model: 'glm-5.3',
    thinking: 'max',
    api: 'openai-completions',
  });
  assert.equal(resolveProviderDestination(zaiCn), 'https://open.bigmodel.cn/api/coding/paas/v4/chat/completions');
  assert.equal(resolveProviderAuthHeaderName(zaiCn), 'authorization');

  // zai/glm-5.3 thinkingLevelMap marks medium and xhigh null -> THINKING_UNSUPPORTED
  assert.throws(() => validateSelection({
    provider: 'zai',
    model: 'glm-5.3',
    thinking: 'medium',
    api: 'openai-completions',
  }), (err: { detail?: { code?: string }; message?: string }) => (err.detail?.code ?? err.message) === 'THINKING_UNSUPPORTED');

  // anthropic uses x-api-key unless customProvider.authHeader === true
  const anthropicModel = resolveBuiltInPiCatalogModel('anthropic', 'claude-sonnet-4-5');
  if (anthropicModel) {
    const sel = validateSelection({
      provider: 'anthropic',
      model: anthropicModel.id,
      thinking: 'high',
      api: 'anthropic-messages',
    });
    assert.equal(resolveProviderAuthHeaderName(sel), 'x-api-key');
    assert.equal(resolveProviderDestination(sel), 'https://api.anthropic.com/v1/messages?beta=true');
  }
});

test('custom compatible Pi provider validates samplingParams and zai thinkingFormat while refusing OAuth and !command', () => {
  const custom = validateSelection({
    provider: 'custom-glm',
    model: 'glm-5.3',
    thinking: 'high',
    api: 'openai-completions',
    customProvider: {
      baseUrl: 'https://llm-proxy.example.com/v1/',
      contextWindow: 204800,
      maxTokens: 32768,
      reasoning: true,
      samplingParams: { temperature: 0.6, top_p: 0.95 },
      compat: { thinkingFormat: 'zai', maxTokensField: 'max_tokens', zaiToolStream: true },
    },
  });
  const resolved = resolveCatalogModel(custom);
  assert.equal(resolved.record.contextWindow, 204800);
  assert.equal(resolveProviderDestination(custom), 'https://llm-proxy.example.com/v1/chat/completions');

  for (const oauthProvider of ['openai-codex', 'claude-code', 'gemini', 'google', 'google-gemini-cli', 'google-antigravity']) {
    assert.throws(() => validateSelection({
      provider: oauthProvider,
      model: 'glm-5.3',
      thinking: 'high',
      api: 'openai-completions',
    }), (err: { detail?: { code?: string }; message?: string }) => (err.detail?.code ?? err.message) === 'SEND_PATH_UNSUPPORTED');
  }

  assert.throws(() => validateSelection({
    provider: 'custom-glm',
    model: 'glm-5.3',
    thinking: 'high',
    api: 'openai-completions',
    customProvider: {
      baseUrl: 'https://llm-proxy.example.com/v1',
      contextWindow: 128000,
      maxTokens: 16384,
      reasoning: true,
      headers: { 'X-Custom': '!secret-tool read' },
    },
  }), (err: { detail?: { code?: string }; message?: string }) => (err.detail?.code ?? err.message) === 'SEND_PATH_UNSUPPORTED');
});

test('openai-completions and openai-responses SSE streams evaluate stop reasons, tool calls and usage', () => {
  const completionsSse = [
    'data: {"id":"chatcmpl-1","model":"glm-5.3","choices":[{"index":0,"delta":{"role":"assistant","tool_calls":[{"index":0,"id":"call_1","type":"function","function":{"name":"read","arguments":"{\\"path\\":\\"README.md\\"}"}}]},"finish_reason":null}]}',
    '',
    'data: {"id":"chatcmpl-1","model":"glm-5.3","choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}],"usage":{"prompt_tokens":120,"completion_tokens":30,"prompt_tokens_details":{"cached_tokens":20}}}',
    '',
    'data: [DONE]',
    '',
    '',
  ].join('\n');
  const bytes = Buffer.from(completionsSse, 'utf8');
  const evaluated = evaluateRawResponse(bytes, 200, 'openai-completions');
  assert.equal(evaluated.ok, true);
  if (evaluated.ok) {
    assert.equal(evaluated.toolCalls.length, 1);
    assert.equal(evaluated.toolCalls[0]?.id, 'call_1');
    assert.equal(evaluated.toolCalls[0]?.name, 'read');
  }
  const usage = inspectRawResponse(bytes, 200, 'glm-5.3', 'openai-completions', false);
  assert.equal(usage.termination, 'confirmed');
  assert.equal(usage.rawStop, 'tool_calls');
  assert.deepEqual(usage.usage.inputTokens, { provenance: 'reported', value: 120 });
  assert.deepEqual(usage.usage.outputTokens, { provenance: 'reported', value: 30 });

  const responsesSse = [
    'event: response.completed',
    'data: {"type":"response.completed","response":{"id":"resp_1","model":"gpt-5.4","status":"completed","output":[{"type":"message","content":[{"type":"output_text","text":"done"}]}],"usage":{"input_tokens":80,"output_tokens":15,"input_tokens_details":{"cached_tokens":10}}}}',
    '',
    '',
  ].join('\n');
  const respBytes = Buffer.from(responsesSse, 'utf8');
  const respEval = evaluateRawResponse(respBytes, 200, 'openai-responses');
  assert.equal(respEval.ok, true);
  const respUsage = inspectRawResponse(respBytes, 200, 'gpt-5.4', 'openai-responses', false);
  assert.equal(respUsage.termination, 'confirmed');
  assert.equal(respUsage.rawStop, 'completed');
  assert.deepEqual(respUsage.usage.inputTokens, { provenance: 'reported', value: 80 });
  assert.deepEqual(respUsage.usage.outputTokens, { provenance: 'reported', value: 15 });
});

test('built-in catalog resolves positive model cost metadata while keeping legacy github-copilot cost omitted', () => {
  const anthropic = resolveBuiltInPiCatalogModel('anthropic', 'claude-haiku-4-5', 'anthropic-messages');
  assert.ok(anthropic?.cost);
  assert.equal(hasPositiveModelCost(anthropic.cost), true);
  assert.ok(anthropic.cost.input > 0 && anthropic.cost.output > 0);

  const openai = resolveBuiltInPiCatalogModel('openai', 'gpt-4', 'openai-responses');
  assert.ok(openai?.cost);
  assert.equal(hasPositiveModelCost(openai.cost), true);
  assert.ok(openai.cost.input > 0 && openai.cost.output > 0);

  const zai = resolveBuiltInPiCatalogModel('zai', 'glm-5.3', 'openai-completions');
  assert.ok(zai?.cost);
  assert.equal(hasPositiveModelCost(zai.cost), true);

  assert.equal(hasPositiveModelCost(undefined), false);
  assert.equal(hasPositiveModelCost({ input: 0, output: 0 }), false);
  assert.equal(hasPositiveModelCost({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }), false);
  assert.equal(hasPositiveModelCost({ input: 0, output: 0, cacheRead: 0.1 }), true);

  const copilot = resolveCatalogModel({
    provider: 'github-copilot',
    model: 'claude-sonnet-5.5',
    thinking: 'xhigh',
    api: 'anthropic-messages',
  });
  assert.equal(copilot.record.cost, undefined);
});

test('validateCustomProviderConfig and validateModelCost accept bounded rates and refuse invalid cost shapes', () => {
  const valid = validateCustomProviderConfig({
    baseUrl: 'https://llm-proxy.example.com/v1',
    contextWindow: 128000,
    maxTokens: 16384,
    reasoning: true,
    cost: { input: 2.5, output: 10, cacheRead: 0.25, cacheWrite: 3.125 },
  }, '/policy/selection/customProvider');
  assert.deepEqual({ ...valid.cost }, { input: 2.5, output: 10, cacheRead: 0.25, cacheWrite: 3.125 });
  assert.equal(Object.isFrozen(valid.cost), true);
  assert.equal(Object.isFrozen(validateModelCost({ input: 1, output: 2 }, '/cost')), true);

  const selection = validateSelection({
    provider: 'custom-glm',
    model: 'glm-5.3',
    thinking: 'high',
    api: 'openai-completions',
    customProvider: {
      baseUrl: 'https://llm-proxy.example.com/v1',
      contextWindow: 128000,
      maxTokens: 16384,
      reasoning: true,
      cost: { input: 1.2, output: 4.8 },
    },
  });
  assert.deepEqual({ ...resolveCatalogModel(selection).record.cost }, { input: 1.2, output: 4.8 });

  const invalidCosts: unknown[] = [
    null,
    [],
    { input: 1 },
    { output: 1 },
    { input: -0.1, output: 1 },
    { input: 1, output: Number.NaN },
    { input: Number.POSITIVE_INFINITY, output: 1 },
    { input: -0, output: 1 },
    { input: 1, output: 1, cacheRead: -0 },
    { input: 1_000_001, output: 1 },
    { input: 1, output: 1, unknownRate: 2 },
  ];
  for (const badCost of invalidCosts) {
    assert.throws(
      () => validateModelCost(badCost, '/policy/selection/customProvider/cost'),
      (err: { detail?: { code?: string }; message?: string }) => (err.detail?.code ?? err.message) === 'INPUT_INVALID',
    );
    assert.throws(
      () => validateCustomProviderConfig({
        baseUrl: 'https://llm-proxy.example.com/v1',
        contextWindow: 128000,
        maxTokens: 16384,
        reasoning: true,
        cost: badCost,
      }, '/policy/selection/customProvider'),
      (err: { detail?: { code?: string }; message?: string }) => (err.detail?.code ?? err.message) === 'INPUT_INVALID',
    );
  }
});

test('inspectRawResponse computes estimated costMicrousd across OpenAI and Anthropic while preserving reported and unknown provenance', () => {
  // 1. OpenAI completions: cached_tokens is a subset of prompt_tokens (uncached = 120 - 20 = 100)
  // 100 * 2 + 20 * 0.5 + 30 * 10 = 200 + 10 + 300 = 510
  const completionsSse = [
    'data: {"id":"chatcmpl-1","model":"glm-5.3","choices":[{"index":0,"delta":{"role":"assistant","content":"ok"},"finish_reason":"stop"}],"usage":{"prompt_tokens":120,"completion_tokens":30,"prompt_tokens_details":{"cached_tokens":20}}}',
    '',
    'data: [DONE]',
    '',
    '',
  ].join('\n');
  const compBytes = Buffer.from(completionsSse, 'utf8');
  const compEstimated = inspectRawResponse(compBytes, 200, 'glm-5.3', 'openai-completions', false, {
    input: 2,
    output: 10,
    cacheRead: 0.5,
  });
  assert.deepEqual(compEstimated.usage.costMicrousd, { provenance: 'estimated', value: 510 });

  // Zero-rate or omitted modelCost stays unknown
  assert.deepEqual(
    inspectRawResponse(compBytes, 200, 'glm-5.3', 'openai-completions', false, { input: 0, output: 0 }).usage.costMicrousd,
    { provenance: 'unknown' },
  );
  assert.deepEqual(
    inspectRawResponse(compBytes, 200, 'glm-5.3', 'openai-completions', false).usage.costMicrousd,
    { provenance: 'unknown' },
  );

  // Explicit cost_microusd in provider usage stays reported
  const compReportedSse = [
    'data: {"id":"chatcmpl-2","model":"glm-5.3","choices":[{"index":0,"delta":{"role":"assistant","content":"ok"},"finish_reason":"stop"}],"usage":{"prompt_tokens":120,"completion_tokens":30,"cost_microusd":777}}',
    '',
    'data: [DONE]',
    '',
    '',
  ].join('\n');
  const compReported = inspectRawResponse(Buffer.from(compReportedSse, 'utf8'), 200, 'glm-5.3', 'openai-completions', false, {
    input: 2,
    output: 10,
  });
  assert.deepEqual(compReported.usage.costMicrousd, { provenance: 'reported', value: 777 });

  // 2. OpenAI responses: cached_tokens is a subset of input_tokens (uncached = 80 - 10 = 70)
  // 70 * 2.5 + 10 * 0.5 + 15 * 10 = 175 + 5 + 150 = 330
  const responsesSse = [
    'event: response.completed',
    'data: {"type":"response.completed","response":{"id":"resp_1","model":"gpt-5.4","status":"completed","output":[{"type":"message","content":[{"type":"output_text","text":"done"}]}],"usage":{"input_tokens":80,"output_tokens":15,"input_tokens_details":{"cached_tokens":10}}}}',
    '',
    '',
  ].join('\n');
  const respEstimated = inspectRawResponse(Buffer.from(responsesSse, 'utf8'), 200, 'gpt-5.4', 'openai-responses', false, {
    input: 2.5,
    output: 10,
    cacheRead: 0.5,
  });
  assert.deepEqual(respEstimated.usage.costMicrousd, { provenance: 'estimated', value: 330 });

  const respReportedSse = [
    'event: response.completed',
    'data: {"type":"response.completed","response":{"id":"resp_2","model":"gpt-5.4","status":"completed","output":[{"type":"message","content":[{"type":"output_text","text":"done"}]}],"usage":{"input_tokens":80,"output_tokens":15,"cost_microusd":999}}}',
    '',
    '',
  ].join('\n');
  const respReported = inspectRawResponse(Buffer.from(respReportedSse, 'utf8'), 200, 'gpt-5.4', 'openai-responses', false, {
    input: 2.5,
    output: 10,
  });
  assert.deepEqual(respReported.usage.costMicrousd, { provenance: 'reported', value: 999 });

  // 3. Anthropic messages: additive input_tokens (100), cache_read_input_tokens (40), cache_creation_input_tokens (20), output_tokens (10)
  // 100 * 3 + 40 * 0.3 + 20 * 3.75 + 10 * 15 = 300 + 12 + 75 + 150 = 537
  const anthropicFrames = [
    {
      type: 'message_start',
      message: {
        id: 'msg_1',
        type: 'message',
        role: 'assistant',
        model: 'claude-sonnet-4-5-20250929',
        content: [],
        usage: { input_tokens: 100, cache_read_input_tokens: 40, cache_creation_input_tokens: 20, output_tokens: 0 },
      },
    },
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'done' } },
    { type: 'content_block_stop', index: 0 },
    { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 10 } },
    { type: 'message_stop' },
  ];
  const anthBytes = Buffer.from(anthropicFrames.map(e => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join(''), 'utf8');
  const anthEstimated = inspectRawResponse(anthBytes, 200, 'claude-sonnet-4-5', 'anthropic-messages', false, {
    input: 3,
    output: 15,
    cacheRead: 0.3,
    cacheWrite: 3.75,
  });
  assert.deepEqual(anthEstimated.usage.inputTokens, { provenance: 'reported', value: 160 });
  assert.deepEqual(anthEstimated.usage.outputTokens, { provenance: 'reported', value: 10 });
  assert.deepEqual(anthEstimated.usage.costMicrousd, { provenance: 'estimated', value: 537 });

  const anthropicReportedFrames = [
    ...anthropicFrames.slice(0, 4),
    { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 10, cost_microusd: 1234 } },
    { type: 'message_stop' },
  ];
  const anthReportedBytes = Buffer.from(anthropicReportedFrames.map(e => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join(''), 'utf8');
  const anthReported = inspectRawResponse(anthReportedBytes, 200, 'claude-sonnet-4-5', 'anthropic-messages', false, {
    input: 3,
    output: 15,
  });
  assert.deepEqual(anthReported.usage.costMicrousd, { provenance: 'reported', value: 1234 });

  // OpenAI cached_tokens > prompt_tokens is clamped to prompt_tokens (50 * 0.5 + 10 * 10 = 125)
  const overCachedSse = [
    'data: {"id":"chatcmpl-clamp","model":"glm-5.3","choices":[{"index":0,"delta":{"role":"assistant","content":"ok"},"finish_reason":"stop"}],"usage":{"prompt_tokens":50,"completion_tokens":10,"prompt_tokens_details":{"cached_tokens":999}}}',
    '',
    'data: [DONE]',
    '',
    '',
  ].join('\n');
  const clamped = inspectRawResponse(Buffer.from(overCachedSse, 'utf8'), 200, 'glm-5.3', 'openai-completions', false, {
    input: 2,
    output: 10,
    cacheRead: 0.5,
  });
  assert.deepEqual(clamped.usage.costMicrousd, { provenance: 'estimated', value: 125 });

  // Malformed Anthropic cost_microusd marks response malformed
  const anthropicMalformedCostFrames = [
    ...anthropicFrames.slice(0, 4),
    { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 10, cost_microusd: 'not-an-int' } },
    { type: 'message_stop' },
  ];
  const anthMalformedBytes = Buffer.from(anthropicMalformedCostFrames.map(e => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join(''), 'utf8');
  const anthMalformed = inspectRawResponse(anthMalformedBytes, 200, 'claude-sonnet-4-5', 'anthropic-messages', false, {
    input: 3,
    output: 15,
  });
  assert.equal(anthMalformed.admission.ok, false);
  assert.deepEqual(anthMalformed.usage.costMicrousd, { provenance: 'unknown' });
});
