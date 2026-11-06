import assert from 'node:assert/strict';
import { test } from 'node:test';
import { NativeSnapshot, rowBytes, snapshotRow } from '../src/snapshot.js';
import { sessionInput } from './session-fixtures.js';
import { PiFailure } from '../src/errors.js';
const header = { type: 'session', version: 3, id: 'native-session', timestamp: '2026-11-05T00:00:00.000Z', cwd: '/workspace/candidate' };
const user = { type: 'message', id: 'entry-1', parentId: null, timestamp: header.timestamp, message: { role: 'user', content: 'literal task' } };
const assistant = { type: 'message', id: 'entry-2', parentId: 'entry-1', timestamp: header.timestamp, message: { role: 'assistant', model: 'claude-sonnet-5.5', provider: 'github-copilot', api: 'anthropic-messages', content: [{ type: 'text', text: 'DONE' }], stopReason: 'stop', usage: { cost: { total: 0.000123 } } } };
test('private native rows survive chunk boundaries without narrowing the aggregate session limit', () => {
  const native = new NativeSnapshot(sessionInput().policy), long = { ...user, message: { role: 'user', content: 'X'.repeat(70000) } }, bytes = Buffer.concat([rowBytes(header), rowBytes(long), rowBytes(assistant)]);
  for (let offset = 0; offset < bytes.length; offset += 997) native.push(bytes.subarray(offset, offset + 997));
  const entries = native.finish(); assert.equal(entries.length, 3); assert.equal((entries[1] as typeof long).message.content.length, 70000); assert.equal((entries[2] as typeof assistant).message.usage.cost.total, 0.000123);
});
test('native snapshot rejects duplicate IDs, absent graph parents and changed model or thinking identity', () => {
  for (const bad of [{ ...user, parentId: 'missing' }, { ...user, type: 'model_change', provider: 'other', modelId: 'claude-sonnet-5.5' }, { ...user, type: 'thinking_level_change', thinkingLevel: 'low' }]) { const native = new NativeSnapshot(sessionInput().policy); native.push(rowBytes(header)); assert.throws(() => native.push(rowBytes(bad)), PiFailure); }
  const native = new NativeSnapshot(sessionInput().policy); native.push(rowBytes(header)); native.push(rowBytes(user)); assert.throws(() => native.push(rowBytes(user)), PiFailure);
});
test('native snapshot rejects row/aggregate overflow, malformed and truncated JSON rather than skipping it', () => {
  assert.throws(() => snapshotRow(Buffer.from('{"type":"session","type":"message"}')), PiFailure);
  assert.throws(() => rowBytes({ text: 'X'.repeat(1048576) }), PiFailure);
  const native = new NativeSnapshot(sessionInput().policy, 64); assert.throws(() => native.push(rowBytes(header)), PiFailure);
  const partial = new NativeSnapshot(sessionInput().policy); partial.push(rowBytes(header)); partial.push(Buffer.from('{"type":')); assert.throws(() => partial.finish(), PiFailure);
});
test('a private native snapshot never seals incomplete or unmatched tool call/result state', () => {
  const call = { ...assistant, message: { ...assistant.message, stopReason: 'toolUse', content: [{ type: 'toolCall', id: 'call-1', name: 'read', arguments: { path: 'packages/example.ts' } }] } };
  const pending = new NativeSnapshot(sessionInput().policy); pending.push(Buffer.concat([rowBytes(header), rowBytes(user), rowBytes(call)])); assert.throws(() => pending.finish(), PiFailure);
  const bad = new NativeSnapshot(sessionInput().policy); bad.push(rowBytes(header)); assert.throws(() => bad.push(rowBytes({ type: 'message', id: 'result', parentId: null, timestamp: header.timestamp, message: { role: 'toolResult', toolCallId: 'unknown', content: [] } })), PiFailure);
  const complete = new NativeSnapshot(sessionInput().policy); complete.push(Buffer.concat([rowBytes(header), rowBytes(user), rowBytes(call), rowBytes({ type: 'message', id: 'result', parentId: call.id, timestamp: header.timestamp, message: { role: 'toolResult', toolCallId: 'call-1', content: [] } })])); assert.equal(complete.finish().length, 4);
});
