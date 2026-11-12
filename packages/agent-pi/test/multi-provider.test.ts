import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  resolveBuiltInPiCatalogModel, resolveCatalogModel, resolveProviderAuthHeaderName,
  resolveProviderDestination, validateSelection,
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
