import assert from 'node:assert/strict';
import { test } from 'node:test';
import { verifyNativeCompletion } from '../src/lifecycle.js';
import { PiFailure } from '../src/errors.js';
const final = { agentEnds: 2, agentSettles: 1, aborted: false, compactionEnds: 0, compacted: false, idle: true, invocations: 2, parserAcks: 2, pending: 0 };
test('two intermediate agent ends cannot substitute for the actual final native settle', () => {
  assert.throws(() => verifyNativeCompletion({ ...final, agentSettles: 0 }, 'execute'), PiFailure);
  assert.doesNotThrow(() => verifyNativeCompletion(final, 'execute'));
});
test('native settlement refuses pending, aborted, unacknowledged or non-idle work', () => {
  for (const patch of [{ pending: 1 }, { aborted: true }, { idle: false }, { parserAcks: 1 }, { invocations: 0 }, { unknown: true }]) assert.throws(() => verifyNativeCompletion({ ...final, ...patch }, 'execute'), PiFailure);
});
test('explicit compaction requires its own real successful native end event', () => {
  const compact = { ...final, agentEnds: 0, agentSettles: 0, compactionEnds: 1, compacted: true, invocations: 1, parserAcks: 1 };
  assert.doesNotThrow(() => verifyNativeCompletion(compact, 'compact')); assert.throws(() => verifyNativeCompletion({ ...compact, compacted: false }, 'compact'), PiFailure);
});
