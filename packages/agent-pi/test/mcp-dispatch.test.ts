import assert from 'node:assert/strict';
import { test } from 'node:test';
import { EventEmitter } from 'node:events';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { admitTask } from '@loopwright/core';
import type { JsonRpcMessage } from '@earendil-works/pi-mcp';
import { Candidate } from '../src/candidate.js';
import { Mcp } from '../src/mcp.js';
import { PiFailure } from '../src/errors.js';
import { requestFixture, stateGood } from './request-fixtures.js';
import { sessionInput } from './session-fixtures.js';
class Pipe extends EventEmitter {
  readonly sent: JsonRpcMessage[] = []; closed = false;
  async ready(): Promise<void> {}
  async send(message: JsonRpcMessage, guard: () => void): Promise<void> { guard(); this.sent.push(message); queueMicrotask(() => { if ('id' in message) this.emit('message', { jsonrpc: '2.0', id: message.id, result: { content: [{ type: 'text', text: 'export const value = 1;\n' }] } }); }); }
  async close(): Promise<null> { this.closed = true; return null; }
}
async function fixture() {
  const input = () => { const base = sessionInput(), task = { ...base.lock.spec.contract, spec: { ...base.lock.spec.contract.spec, roles: base.lock.spec.contract.spec.roles.map(role => ({ ...role, tools: ['mcp__workspace__read_file'] })) } }, lock = admitTask(task, { admissionId: 'admission-1', runId: 'run-1' }); assert.equal(lock.ok, true); if (!lock.ok) throw new Error('fixture lock'); return { ...base, lock: lock.value, policy: { ...base.policy, tools: ['mcp__workspace__read_file'], mcp: { ...base.policy.mcp, names: ['mcp__workspace__read_file'], effects: ['read_only' as const] } } }; };
  const f = await requestFixture(undefined, input), candidate = join(f.directory, 'candidate');
  for (const artifact of f.input.candidate.artifacts) { await mkdir(join(candidate, artifact.name, '..'), { recursive: true }); await writeFile(join(candidate, artifact.name), artifact.bytes, { mode: 0o444 }); }
  const pipe = new Pipe(), faults: string[] = [], mcp = new Mcp(f.host, f.input, new Candidate(candidate, f.input), code => faults.push(code), { process: () => pipe });
  return { ...f, pipe, mcp, faults };
}
const identity = { invocation: 1, slot: 'owner-slot', callId: 'code-root/1', name: 'mcp__workspace__read_file', parentId: 'code-root', parentRequestId: 'req-parent' };
const bytes = Buffer.from(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'read_file', arguments: { path: 'packages/example.ts' } } }));
test('MCP final bytes use a new original S02 read permission and receipt before parser reply', async () => {
  const f = await fixture(), operations: string[] = []; let replied!: () => void; const reply = new Promise<void>(resolve => { replied = resolve; });
  try {
    await f.mcp.send(identity, bytes, new AbortController().signal, async () => { assert.equal(stateGood(f.host.store.getOperation(operations[0]!)).state, 'confirmed'); replied(); }, id => { operations.push(id); }); await reply;
    assert.equal(f.pipe.sent.length, 1); assert.equal(f.faults.length, 0); assert.equal(stateGood(f.host.store.getOperation(operations[0]!)).intent.effect, 'read_only');
    await assert.rejects(f.mcp.send(identity, bytes, new AbortController().signal, async () => {}, () => {}), PiFailure); assert.equal(f.pipe.sent.length, 1);
  } finally { await f.mcp.close(); await f.cleanup(); }
});
test('owner replaced after MCP authorization emits no actual pipe command', async () => {
  const f = await fixture(), original = f.host.store.authorizeOperationDispatch.bind(f.host.store);
  f.host.store.authorizeOperationDispatch = (authority, id) => { const result = original(authority, id); if (result.ok && result.value.kind === 'new_dispatch') { stateGood(f.host.store.release(authority)); const view = stateGood(f.host.store.inspect()); stateGood(f.host.store.claim({ ownerId: 'replacement', expectedGeneration: view.owner.generation, expectedRevision: view.revision, mode: 'active' })); } return result; };
  try { await assert.rejects(f.mcp.send(identity, bytes, new AbortController().signal, async () => {}, () => {}), error => error instanceof PiFailure && error.detail.stateErrorCode === 'STALE_OWNER'); assert.equal(f.pipe.sent.length, 0); assert.equal(stateGood(f.host.store.inspect()).counts.unresolvedOperations, 1); }
  finally { await f.mcp.close(); await f.cleanup(); }
});

test('wrong MCP names and changed read bytes never receive an owner reply', async () => {
  const f = await fixture();
  try {
    await assert.rejects(f.mcp.send({ ...identity, name: 'mcp__workspace__read_file_extra' }, bytes, new AbortController().signal, async () => {}, () => {}), PiFailure); assert.equal(f.pipe.sent.length, 0); assert.equal(stateGood(f.host.store.inspect()).counts.operations, 0);
    const changedPipe = new Pipe(); changedPipe.send = async (message, guard) => { guard(); changedPipe.sent.push(message); queueMicrotask(() => { if ('id' in message) changedPipe.emit('message', { jsonrpc: '2.0', id: message.id, result: { content: [{ type: 'text', text: 'CHANGED_AFTER_DISPATCH' }] } }); }); };
    let fault!: () => void; const failed = new Promise<void>(resolve => { fault = resolve; }), mcp = new Mcp(f.host, f.input, f.mcp.candidate, code => { f.faults.push(code); fault(); }, { process: () => changedPipe }); let replied = false;
    try { await mcp.send(identity, bytes, new AbortController().signal, async () => { replied = true; }, () => {}); await failed; assert.equal(replied, false); assert.ok(f.faults.includes('PAYLOAD_MISMATCH')); assert.equal(stateGood(f.host.store.inspect()).counts.unresolvedOperations, 1); }
    finally { await mcp.close(); }
  } finally { await f.mcp.close(); await f.cleanup(); }
});
