/* global Buffer, URL, console */
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAgentSession, createExtensionRuntime, ModelRuntime, SessionManager, SettingsManager } from '@earendil-works/pi-coding-agent';
import { evaluateRawResponse, TurnFailureLatch } from '../dist/response.js';
import { assessFinalRequestContext } from '../dist/context.js';

function events(reason = 'end_turn', incomplete = false, variant = '') {
  const data = [
    ['message_start', { type: 'message_start', message: { id: 'msg_fixture', type: 'message', role: 'assistant', model: 'claude-sonnet-5.5', content: [], usage: { input_tokens: 4, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, output_tokens: 0 } } }],
    ['content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }],
    ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'OK' } }],
    ['content_block_stop', { type: 'content_block_stop', index: 0 }],
    ['message_delta', { type: 'message_delta', delta: { stop_reason: reason, stop_sequence: null }, usage: { output_tokens: 2 } }],
    ...(!incomplete ? [['message_stop', { type: 'message_stop' }]] : []),
  ];
  if (variant === 'incomplete-tool' || variant === 'complete-tool') { data.splice(1, 3, ['content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'call_fixture', name: 'read', input: {} } }], ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: variant === 'complete-tool' ? '{"path":"allowed.txt"}' : '{"path":' } }], ['content_block_stop', { type: 'content_block_stop', index: 0 }]); }
  if (variant === 'malformed') return 'event: message_start\ndata: {broken\n\n';
  if (variant === 'truncated') return 'event: message_start\ndata: {"type":';
  return data.map(([type, value]) => `event: ${type}\ndata: ${JSON.stringify(value)}\n\n`).join('');
}
export async function sdkProbe() {
  const directory = await mkdtemp(join(tmpdir(), 'loopwright-s03-sdk-'));
  let behavior = { status: 200, reason: 'end_turn', incomplete: false }, physical = 0, slots = 0, deniedSecond = 0;
  const captures = [], outcomes = [], sessions = [], rawResponses = [];
  const server = http.createServer(async (req, res) => {
    let bytes = 0;
    for await (const chunk of req) { bytes += chunk.length; if (bytes > 65536) { res.writeHead(413).end(); return; } }
    physical++;
    res.writeHead(behavior.status, { 'content-type': behavior.status === 200 ? 'text/event-stream' : 'application/json', 'request-id': 'owned-fixture' });
    const raw = behavior.status === 200 ? events(behavior.reason, behavior.incomplete, behavior.variant) : JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message: 'prompt is too long: controlled fixture' } });
    rawResponses.push({ status: behavior.status, bytes: Buffer.from(raw) }); res.end(raw);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const endpoint = `http://127.0.0.1:${server.address().port}/v1/messages`;
  const stored = new Map([['github-copilot', { type: 'api_key', key: 'non-secret-fixture-placeholder' }]]);
  const credentials = { read: async id => stored.get(id), list: async () => [...stored].map(([providerId, value]) => ({ providerId, type: value.type })),
    modify: async (id, fn) => { const value = await fn(stored.get(id)); if (value) stored.set(id, value); return stored.get(id); }, delete: async id => { stored.delete(id); } };
  try {
    const runtime = await ModelRuntime.create({ credentials, modelsPath: null, refreshOnCreate: false, allowModelNetwork: false });
    const model = runtime.getModel('github-copilot', 'claude-sonnet-5.5'); assert.ok(model);
    const selection = { modelId: model.id, effort: 'xhigh', tools: [], contextWindow: model.contextWindow, perCallOutputTokens: 1024 };
    const invoke = (selectedModel, context, options = {}, providerRetries = 0, contextPolicy = { mode: 'estimated_guard' }) => {
      let used = false;
      const fetch = async (url, init) => {
        if (used) { deniedSecond++; throw new Error('one-use fixture fetch slot consumed'); }
        used = true; slots++;
        const bytes = Buffer.from(init.body); const assessment = assessFinalRequestContext(bytes, contextPolicy, { ...selection, tools: ['read'] });
        captures.push({ body: JSON.parse(bytes.toString()), assessment });
        if (!assessment.ok) throw new Error('CONTEXT_UNSAFE at actual final serializer');
        const headers = { 'content-type': 'application/json' };
        assert.equal(new URL(url).pathname, '/v1/messages');
        return globalThis.fetch(endpoint, { method: 'POST', headers, body: bytes, signal: options.signal });
      };
      return runtime.streamSimple(selectedModel, context, { ...options, fetch, apiKey: 'non-secret-fixture-placeholder', env: {}, reasoning: 'xhigh', maxTokens: 1024, cacheRetention: 'short', maxRetries: providerRetries });
    };
    const loader = { getExtensions: () => ({ extensions: [], errors: [], runtime: createExtensionRuntime() }),
      getSkills: () => ({ skills: [], diagnostics: [] }), getPrompts: () => ({ prompts: [], diagnostics: [] }), getThemes: () => ({ themes: [], diagnostics: [] }),
      getAgentsFiles: () => ({ agentsFiles: [] }), getSystemPrompt: () => 'T0_FROZEN_CONTEXT', getSystemPromptSource: () => undefined,
      getAppendSystemPrompt: () => [], getAppendSystemPromptSources: () => [], extendResources: () => { throw new Error('frozen'); }, reload: async () => {} };
    const manager = SessionManager.inMemory(directory);
    const settings = SettingsManager.inMemory({ retry: { enabled: false, maxRetries: 0, provider: { maxRetries: 0 } }, cacheWarming: 'off', compaction: { enabled: false, keepRecentTokens: 1, reserveTokens: 1024 } });
    const { session } = await createAgentSession({ cwd: directory, agentDir: directory, modelRuntime: runtime, model, thinkingLevel: 'xhigh', tools: [], resourceLoader: loader, sessionManager: manager, settingsManager: settings });
    sessions.push(session); session.agent.streamFunction = (m, c, o) => invoke(m, c, o);
    await session.prompt('hello fixture'); await session.prompt('second fixture');
    assert.ok(captures[0].assessment.ok, JSON.stringify(captures[0].body));
    assert.ok(JSON.stringify(captures[0].body).includes('T0_FROZEN_CONTEXT'));
    const beforeCompact = physical; await session.compact(); assert.ok(physical > beforeCompact, 'actual explicit compaction must reach the same fetch gate');
    const history = { tools: [{ name: 'read', description: 'bounded read', parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'], additionalProperties: false } }], messages: [
      { role: 'system', content: 'LEADING_FROZEN', timestamp: 1 }, { role: 'user', content: 'call read', timestamp: 2 },
      { role: 'assistant', content: [{ type: 'thinking', thinking: 'private synthetic thought', thinkingSignature: 'synthetic_signature' }, { type: 'toolCall', id: 'history_call', name: 'read', arguments: { path: 'allowed.txt' } }], api: model.api, provider: model.provider, model: model.id, stopReason: 'toolUse', timestamp: 3, usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } },
      { role: 'toolResult', toolCallId: 'history_call', toolName: 'read', content: [{ type: 'text', text: 'ALLOWED_OK' }], isError: false, timestamp: 4 },
      { role: 'system', content: 'MID_CONVERSATION_FROZEN', timestamp: 5 }, { role: 'user', content: 'continue', timestamp: 6 } ] };
    await invoke(model, history).result(); const serializedHistory = captures.at(-1).body;
    assert.ok(serializedHistory.tools.length); assert.ok(JSON.stringify(serializedHistory).includes('MID_CONVERSATION_FROZEN'));
    assert.ok(JSON.stringify(serializedHistory).includes('tool_result')); assert.ok(JSON.stringify(serializedHistory).includes('synthetic_signature'));
    const context = { messages: [{ role: 'user', content: 'controlled', timestamp: Date.now() }] };
    const strictBefore = physical; await invoke(model, context, {}, 0, {}).result(); assert.equal(physical, strictBefore);
    behavior = { status: 200, reason: 'tool_use', variant: 'complete-tool' };
    const completeAnswer = await invoke(model, context).result(); assert.equal(completeAnswer.stopReason, 'toolUse');
    const completeRaw = rawResponses.at(-1), completeResult = evaluateRawResponse(completeRaw.bytes, 200); assert.equal(completeResult.ok, true);
    const completeLatch = new TurnFailureLatch(); completeLatch.observe(completeResult); assert.equal(completeLatch.canAdmitTool('call_fixture'), true);
    for (const reason of ['end_turn', 'model_context_window_exceeded', 'max_tokens', 'pause_turn', 'stop_sequence', 'unknown_fixture_stop']) {
      behavior = { status: 200, reason, incomplete: false }; const before = physical;
      const answer = await invoke(model, context).result();
      assert.equal(physical - before, 1); const raw = rawResponses.at(-1); const admitted = evaluateRawResponse(raw.bytes, raw.status);
      const latch = new TurnFailureLatch(); latch.observe(admitted); latch.observe({ ok: true, toolCalls: [] });
      if (reason !== 'end_turn') { assert.equal(admitted.ok, false); assert.equal(latch.canSettle(), false); }
      outcomes.push({ rawStop: reason, actualParserStop: answer.stopReason, ownerAdmission: admitted, error: answer.errorMessage ?? null });
      if (['model_context_window_exceeded', 'unknown_fixture_stop'].includes(reason)) assert.equal(answer.stopReason, 'error');
      if (reason === 'pause_turn') assert.equal(answer.stopReason, 'stop');
    }
    for (const variant of ['eof', 'malformed', 'truncated', 'incomplete-tool']) {
      behavior = { status: 200, reason: variant === 'incomplete-tool' ? 'tool_use' : 'end_turn', incomplete: variant === 'eof', variant };
      const before = physical; const answer = await invoke(model, context).result(); assert.equal(physical - before, 1);
      const raw = rawResponses.at(-1), result = evaluateRawResponse(raw.bytes, raw.status); assert.equal(result.ok, false);
      const latch = new TurnFailureLatch(); latch.observe(result); latch.observe({ ok: true, toolCalls: [] }); assert.equal(latch.canAdmitTool('call_fixture'), false); assert.equal(latch.canSettle(), false);
      outcomes.push({ variant, actualParserStop: answer.stopReason, ownerAdmission: result });
    }
    behavior = { status: 400, reason: 'end_turn', incomplete: false }; const errorBefore = physical;
    const rejected = await invoke(model, context).result(); assert.equal(rejected.stopReason, 'error'); assert.equal(physical - errorBefore, 1); assert.deepEqual(evaluateRawResponse(rawResponses.at(-1).bytes, 400), { ok: false, code: 'CONTEXT_LIMIT' });
    behavior = { status: 500, reason: 'end_turn', incomplete: false }; const retryBefore = physical;
    await invoke(model, context, {}, 1).result(); assert.equal(physical - retryBefore, 1); assert.ok(deniedSecond >= 1);
    return { level: 'actual SDK/session/serializer/parser plus controlled local HTTP; no live provider or containment', physicalRequests: physical,
      nodeVersion: globalThis.process.version, architecture: globalThis.process.arch, platform: globalThis.process.platform, logicalSlots: slots, deniedSecond, compactionRequests: beforeCompact < physical, outcomes, finalBodyKeys: Object.keys(captures[0].body),
      toolHistoryBodyKeys: Object.keys(serializedHistory), eagerToolStreaming: serializedHistory.tools[0].eager_input_streaming ?? null, midConversationSystemObserved: true, strictDefaultPhysicalSends: 0, completeRawToolAdmitted: true, cacheControlObserved: JSON.stringify(captures).includes('cache_control'), guardRefusals: captures.filter(item => !item.assessment.ok).length };
  } finally {
    for (const session of sessions) { await session.abort(); session.dispose(); }
    server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await rm(directory, { recursive: true, force: true });
  }
}
if (import.meta.url === `file://${globalThis.process.argv[1]}`) {
  console.log(JSON.stringify(await sdkProbe(), null, 2));
}
