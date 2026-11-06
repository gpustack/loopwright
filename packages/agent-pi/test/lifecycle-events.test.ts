import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Events } from '../src/events.js';
import { PiFailure } from '../src/errors.js';
import { sessionInput } from './session-fixtures.js';
function fixture() {
  const base = sessionInput(), input = { ...base, policy: { ...base.policy, limits: { ...base.policy.limits, eventQueue: 2, eventQueueBytes: 4096 } } };
  let overflow = 0, disconnected = 0; const events = new Events(input, async () => { disconnected++; }, () => { overflow++; }); return { events, overflow: () => overflow, disconnected: () => disconnected };
}
test('a slow event consumer can drain finite backpressure without losing order', async () => {
  const f = fixture(); await f.events.push('request_start', { requestId: 'req-1' }); await f.events.push('request_receipt', { requestId: 'req-1' });
  const waiting = f.events.push('tool_start', { operationId: 'tool-1' }), iterator = f.events.iterator()[Symbol.asyncIterator]();
  const first = await iterator.next(); await waiting; const second = await iterator.next(), third = await iterator.next();
  assert.deepEqual([first.value?.sequence, second.value?.sequence, third.value?.sequence], [1, 2, 3]); assert.equal(third.value?.kind, 'tool_start'); assert.equal(f.overflow(), 0); assert.ok(f.events.highWaterEvents <= 2); assert.ok(f.events.highWaterBytes <= 4096); f.events.close(); assert.equal((await iterator.next()).done, true);
});
test('event overflow preserves queued transitions then exposes an explicit terminal failure', async () => {
  const f = fixture(); await f.events.push('request_start'); await f.events.push('request_receipt');
  await assert.rejects(f.events.push('settled'), error => error instanceof PiFailure && error.detail.code === 'EVENT_OVERFLOW'); assert.equal(f.overflow(), 1);
  const iterator = f.events.iterator()[Symbol.asyncIterator](); assert.equal((await iterator.next()).value?.kind, 'request_start'); assert.equal((await iterator.next()).value?.kind, 'request_receipt'); await assert.rejects(iterator.next(), PiFailure);
  await assert.rejects(f.events.push('settled'), PiFailure); assert.equal(f.overflow(), 1); f.events.close();
});
test('an explicit event consumer disconnect revokes its producer and calls cancellation once', async () => {
  const f = fixture(), iterator = f.events.iterator()[Symbol.asyncIterator](); const waiting = iterator.next(); await iterator.return!(); assert.equal((await waiting).done, true); assert.equal(f.disconnected(), 1); await assert.rejects(f.events.push('request_start')); assert.throws(() => f.events.iterator(), PiFailure);
});
