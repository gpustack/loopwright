import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { admitTask } from '@loopwright/core';
import { Execution, type AdmittedToolIdentity } from '../src/execution.js';
import { PiFailure } from '../src/errors.js';
import { requestFixture, stateGood } from './request-fixtures.js';
import { sessionInput } from './session-fixtures.js';
import { contract } from '../../core/test/fixtures.js';
function input() {
  const base = sessionInput(), task = contract(); task.spec.roles[0]!.model = 'claude-sonnet-5.5'; task.spec.roles[0]!.thinking = 'xhigh'; task.spec.roles[0]!.tools = ['read', 'bash', 'write', 'edit'];
  task.spec.budgets.wallTimeMs = 60000; task.spec.budgets.totalTokens = 1000000; task.spec.budgets.perCallOutputTokens = 1024;
  const lock = admitTask(task, { admissionId: 'admission-1', runId: 'run-1' }); assert.equal(lock.ok, true); if (!lock.ok) throw new Error('fixture lock');
  return { ...base, lock: lock.value, policy: { ...base.policy, tools: ['read', 'bash', 'write', 'edit'] } };
}
async function fixture() {
  const f = await requestFixture(undefined, input), candidate = join(f.directory, 'candidate');
  for (const file of f.input.candidate.artifacts) { await mkdir(join(candidate, file.name, '..'), { recursive: true }); await writeFile(join(candidate, file.name), file.bytes, { mode: 0o444 }); }
  const actor = () => new Execution(f.host, f.input, candidate, { process: () => { throw new Error('Host mutations must not run an interpreter'); } });
  return { ...f, candidate, actor };
}
const identity: AdmittedToolIdentity = { invocation: 1, slot: 'owner-local-slot', callId: 'call-1', name: 'write', parentId: null, parentRequestId: 'req-parent' };
test('owner write/edit uses actual S02 intents, original dispatches and bound final receipts', async () => {
  const f = await fixture(), execution = f.actor(), operations: string[] = [], signal = new AbortController();
  try {
    const write = await execution.invoke(identity, Buffer.from(JSON.stringify({ path: 'packages/new.ts', content: 'const value = 1;\n' })), signal.signal, id => operations.push(id)); assert.equal(write.isError, undefined);
    await execution.invoke({ ...identity, callId: 'call-2', name: 'edit' }, Buffer.from(JSON.stringify({ path: 'packages/new.ts', edits: [{ oldText: '1', newText: '2' }] })), signal.signal, id => operations.push(id));
    assert.equal(await readFile(join(f.candidate, 'packages/new.ts'), 'utf8'), 'const value = 2;\n'); assert.equal(f.physical(), 0); assert.equal(operations.length, 2);
    for (const id of operations) { const record = stateGood(f.host.store.getOperation(id)); assert.equal(record.state, 'confirmed'); assert.equal(record.intent.effect, 'local_write'); assert.equal(record.initialReceipt?.outcome, 'succeeded'); assert.equal(record.initialReceipt?.evidence.subject.operationId, id); assert.equal(record.initialReceipt?.evidence.subject.dispatchId, record.dispatch?.dispatchId); assert.equal(record.initialReceipt?.evidence.subject.requestId, null); }
  } finally { await execution.close(); await f.cleanup(); }
});
test('protected paths deny before any local operation or file is created', async () => {
  const f = await fixture(), execution = f.actor();
  try { await assert.rejects(execution.invoke(identity, Buffer.from(JSON.stringify({ path: 'packages/policy/new.ts', content: 'DENIED' })), new AbortController().signal, () => { throw new Error('no intent allowed'); }), PiFailure); assert.equal(stateGood(f.host.store.inspect()).counts.operations, 0); await assert.rejects(readFile(join(f.candidate, 'packages/policy/new.ts'))); }
  finally { await execution.close(); await f.cleanup(); }
});
test('a saved standalone dispatch never becomes a new host write permission', async () => {
  const f = await fixture(), first = f.actor(), second = f.actor(), bytes = Buffer.from(JSON.stringify({ path: 'packages/example.ts', content: 'export const value = 1;\n' }));
  try { await first.invoke(identity, bytes, new AbortController().signal, () => {}); await assert.rejects(second.invoke(identity, bytes, new AbortController().signal, () => {}), error => error instanceof PiFailure && error.detail.code === 'RECOVERY_REQUIRED'); assert.equal(stateGood(f.host.store.inspect()).counts.operations, 1); }
  finally { await first.close(); await second.close(); await f.cleanup(); }
});
test('owner replacement after operation authorization prevents the actual atomic file effect', async () => {
  const f = await fixture(), execution = f.actor(), original = f.host.store.authorizeOperationDispatch.bind(f.host.store);
  f.host.store.authorizeOperationDispatch = (authority, id) => {
    const result = original(authority, id); if (result.ok && result.value.kind === 'new_dispatch') { stateGood(f.host.store.release(authority)); const view = stateGood(f.host.store.inspect()); stateGood(f.host.store.claim({ ownerId: 'replacement', expectedGeneration: view.owner.generation, expectedRevision: view.revision, mode: 'active' })); } return result;
  };
  try { await assert.rejects(execution.invoke(identity, Buffer.from(JSON.stringify({ path: 'packages/new.ts', content: 'DENIED' })), new AbortController().signal, () => {}), error => error instanceof PiFailure && error.detail.stateErrorCode === 'STALE_OWNER'); await assert.rejects(readFile(join(f.candidate, 'packages/new.ts'))); assert.equal(stateGood(f.host.store.inspect()).counts.unresolvedOperations, 1); }
  finally { await execution.close(); await f.cleanup(); }
});

test('final executor revalidates bytes after an admitted native tool_call hook', async () => {
  const f = await fixture(), execution = f.actor(), originalArgs = { path: 'packages/new.ts', content: 'AUTHORIZED' };
  const { Sender } = await import('../src/sender.js'), { systemPrompt } = await import('../src/resources.js'), { PROVIDER_DESTINATION } = await import('../src/provider.js'), { toolArgumentsDigest } = await import('../src/usage.js');
  const frames = [{ type: 'message_start', message: { id: 'fixture', role: 'assistant', model: 'claude-sonnet-5.5', content: [], usage: { input_tokens: 4, output_tokens: 0 } } },
    { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'call-1', name: 'write', input: {} } },
    { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: JSON.stringify(originalArgs) } }, { type: 'content_block_stop', index: 0 },
    { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 2 } }, { type: 'message_stop' }];
  const response = frames.map(frame => `event: ${frame.type}\ndata: ${JSON.stringify(frame)}\n\n`).join('');
  const sender = new Sender(f.host, f.input, { fetch: async () => new Response(response, { headers: { 'content-type': 'text/event-stream' } }) }); sender.installTools(execution);
  sender.begin('execute', { commandId: 'command-1', text: 'literal task', purpose: 'task', repair: 'none' });
  try {
    const grant = await sender.invoke({ invocation: 1, ...f.input.policy.selection }), tool = { invocation: 1, slot: grant.slot, callId: 'call-1', name: 'write', parentId: null };
    const bytes = Buffer.from(JSON.stringify({ model: 'claude-sonnet-5.5', system: [{ type: 'text', text: systemPrompt(f.input) + '\n\n<cwd>\n/workspace/candidate\n</cwd>' }], messages: [{ role: 'user', content: 'literal task' }], max_tokens: 1024, thinking: { type: 'adaptive' }, output_config: { effort: 'xhigh' }, stream: true }));
    await sender.send({ invocation: 1, slot: grant.slot, url: PROVIDER_DESTINATION, method: 'POST', headers: { 'content-type': 'application/json', 'anthropic-version': '2023-06-01', 'x-initiator': 'user', 'openai-intent': 'conversation-edits' } }, bytes);
    await sender.parsed({ invocation: 1, slot: grant.slot, stopReason: 'toolUse', rawStopReason: 'tool_use', usage: { input: 4, output: 2, cacheRead: 0, cacheWrite: 0 }, toolCalls: [{ id: 'call-1', name: 'write', argumentsDigest: toolArgumentsDigest(originalArgs) }] });
    assert.equal(await sender.rootTool({ ...tool, argumentsDigest: toolArgumentsDigest(originalArgs) }), true);
    await assert.rejects(sender.tool(tool, Buffer.from(JSON.stringify({ ...originalArgs, content: 'MUTATED_AFTER_HOOK' }))), error => error instanceof PiFailure && error.detail.code === 'TOOL_DENIED');
    await assert.rejects(readFile(join(f.candidate, 'packages/new.ts'))); assert.equal(stateGood(f.host.store.inspect()).counts.operations, 1);
  } finally { sender.cancel(); await execution.close(); await f.cleanup(); }
});
