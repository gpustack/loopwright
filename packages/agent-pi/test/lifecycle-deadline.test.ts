import assert from 'node:assert/strict';
import { test } from 'node:test';
import { scheduleDeadline, type DeadlineClock } from '../src/deadline.js';
function simulated() {
  let now = 0, ordinal = 0; const tasks = new Map<number, { at: number; callback: () => void }>(), delays: number[] = [];
  const clock: DeadlineClock = { set: (callback, ms) => { delays.push(ms); tasks.set(++ordinal, { at: now + ms, callback }); return ordinal; }, clear: id => { tasks.delete(id as number); } };
  const tick = (ms: number) => { const end = now + ms; for (;;) { const next = [...tasks].sort((a, b) => a[1].at - b[1].at)[0]; if (!next || next[1].at > end) break; now = next[1].at; tasks.delete(next[0]); next[1].callback(); } now = end; };
  return { clock, tick, delays, pending: () => tasks.size, now: () => now };
}
test('simulated two 50-second sends fit the original command deadline without a 90-second whole-turn cap', () => {
  const f = simulated(), originalDeadline = 200000; let expired = false;
  const stop = scheduleDeadline(() => originalDeadline - f.now(), () => { expired = true; }, f.clock);
  f.tick(50000); assert.equal(expired, false); // First simulated provider completion.
  f.tick(50000); assert.equal(expired, false); // Second simulated provider completion; each is below90seconds.
  stop(); assert.equal(f.pending(), 0); f.tick(200000); assert.equal(expired, false);
});
test('simulated original task deadline is never renewed and large waits rearm within Node timer bounds', () => {
  const f = simulated(), originalDeadline = 2147483647 + 1234; let expired = 0;
  scheduleDeadline(() => originalDeadline - f.now(), () => { expired++; }, f.clock);
  f.tick(2147483647); assert.equal(expired, 0); assert.deepEqual(f.delays, [2147483647, 1234]);
  f.tick(1234); assert.equal(expired, 1); assert.equal(f.pending(), 0);
});
