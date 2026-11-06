import assert from 'node:assert/strict';
import { test } from 'node:test';
import { admitTask } from '@loopwright/core';
import { Sender } from '../src/sender.js';
import { toolArgumentsDigest } from '../src/usage.js';
import { systemPrompt } from '../src/resources.js';
import { PROVIDER_DESTINATION } from '../src/provider.js';
import { requestFixture } from './request-fixtures.js';
import { sessionInput } from './session-fixtures.js';
const code = { code: 'text(await tools.read({path:"packages/example.ts"}));' };
function input() { const value = sessionInput(), task = { ...value.lock.spec.contract, spec: { ...value.lock.spec.contract.spec, roles: value.lock.spec.contract.spec.roles.map(role => ({ ...role, tools: ['read', 'codemode'] })) } }; const lock = admitTask(task, { runId: 'run-1', admissionId: 'admission-1' }); assert.equal(lock.ok, true); if (!lock.ok) throw new Error('fixture lock'); return { ...value, lock: lock.value, policy: { ...value.policy, tools: ['read', 'codemode'] } }; }
export async function admittedCode() {
  const frames = [{ type: 'message_start', message: { id: 'fixture', role: 'assistant', model: 'claude-sonnet-5.5', content: [], usage: { input_tokens: 4, output_tokens: 0 } } }, { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'code-root', name: 'codemode', input: {} } }, { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: JSON.stringify(code) } }, { type: 'content_block_stop', index: 0 }, { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 2 } }, { type: 'message_stop' }];
  const f = await requestFixture(() => ({ status: 200, body: frames.map(frame => `event: ${frame.type}\ndata: ${JSON.stringify(frame)}\n\n`).join('') }), input), sender = new Sender(f.host, f.input, { fetch: (_url, init) => globalThis.fetch(f.destination, init) });
  sender.begin('execute', { commandId: 'code-1', text: 'literal code task', purpose: 'task', repair: 'none' }); const grant = await sender.invoke({ invocation: 1, ...f.input.policy.selection });
  await sender.send({ invocation: 1, slot: grant.slot, method: 'POST', url: PROVIDER_DESTINATION, headers: { 'content-type': 'application/json', 'anthropic-version': '2023-06-01', 'x-initiator': 'user', 'openai-intent': 'conversation-edits' } }, Buffer.from(JSON.stringify({ model: 'claude-sonnet-5.5', system: [{ type: 'text', text: systemPrompt(f.input) + '\n\n<cwd>\n/workspace/candidate\n</cwd>' }], messages: [{ role: 'user', content: 'literal code task' }], stream: true, max_tokens: 1024, thinking: { type: 'adaptive' }, output_config: { effort: 'xhigh' } })));
  await sender.parsed({ invocation: 1, slot: grant.slot, stopReason: 'toolUse', rawStopReason: 'tool_use', usage: { input: 4, output: 2, cacheRead: 0, cacheWrite: 0 }, toolCalls: [{ id: 'code-root', name: 'codemode', argumentsDigest: toolArgumentsDigest(code) }] });
  return { ...f, sender, root: { invocation: 1, slot: grant.slot, callId: 'code-root', name: 'codemode', argumentsDigest: toolArgumentsDigest(code), parentId: null } };
}
test('a complete admitted native codemode root can authorize a bounded nested role tool', async () => {
  const f = await admittedCode();
  try { assert.equal(await f.sender.rootTool(f.root), true); assert.equal(await f.sender.rootTool({ ...f.root, callId: 'code-root/1', name: 'read', argumentsDigest: toolArgumentsDigest({ path: 'packages/example.ts' }), parentId: 'code-root' }), true); assert.equal(await f.sender.rootTool({ ...f.root, callId: 'code-root/2', name: 'write', argumentsDigest: toolArgumentsDigest({ path: 'packages/new.ts', content: 'DENIED' }), parentId: 'code-root' }), false); }
  finally { f.sender.cancel(); await f.cleanup(); }
});

test('nested identity and arguments do not outlive or replace their actual native root', async () => {
  const f = await admittedCode(), nested = { ...f.root, callId: 'code-root/1', name: 'read', parentId: 'code-root', argumentsDigest: toolArgumentsDigest({ path: 'packages/example.ts' }) };
  try {
    assert.equal(await f.sender.rootTool(nested), false); assert.equal(await f.sender.rootTool(f.root), true); assert.equal(await f.sender.rootTool(nested), true);
    assert.equal(await f.sender.rootTool({ ...nested, argumentsDigest: toolArgumentsDigest({ path: 'packages/other.ts' }) }), false);
    assert.equal(await f.sender.rootTool({ ...nested, parentId: 'unrelated-root' }), false);
    await f.sender.nativeResult(f.root, Buffer.from(JSON.stringify({ argumentsDigest: f.root.argumentsDigest, result: { content: [{ type: 'text', text: 'PURE_VM_RESULT' }], details: null, isError: false } })));
    assert.equal(await f.sender.rootTool(nested), false); assert.equal(await f.sender.rootTool(f.root), false);
  } finally { f.sender.cancel(); await f.cleanup(); }
});
