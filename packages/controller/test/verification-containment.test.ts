import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { boundedWorker } from '../src/verification.js';
import { retainedFixture } from './progress-fixtures.js';
import { packetFixture } from './verification-fixtures.js';
import { canonical } from '../src/schema.js';
test('missing/different effective limit observations refuse an actual fixed Worker and await its exit', async () => {
  const f = await retainedFixture();
  try {
    const results = [];
    for (const missing of [true, false]) {
      let actual: unknown; const result = await boundedWorker(new URL('../src/verifier-worker.js', import.meta.url), packetFixture().packet(), new AbortController().signal, { limits: current => { actual = current; return missing ? undefined : { ...current, maxOldGenerationSizeMb: 32 }; } });
      const observation = { result, actual, injectedObservation: true }; results.push(observation);
      await writeFile(join(f.directory, missing ? 'worker-limits-missing-observation.json' : 'worker-limits-different-observation.json'), canonical({ version: 1, kind: 'private-observation-fault-control', coreEligible: false, ...observation }), { mode: 0o600, flag: 'wx' });
      assert.equal(result.kind, 'failed'); assert.ok(result.exit === 0 || result.exit === 1); assert.ok(result.threadId > 0); assert.equal(result.limits.oldMb, missing ? -1 : 32);
    }
    await writeFile(join(f.directory, 'worker-limit-refusals.json'), canonical({ version: 1, kind: 'private-observation-fault-control', coreEligible: false, results }), { mode: 0o600 });
  } finally { await f.close(); }
});
test('independent two-second wall timeout terminates the exact owned thread before guard release', async () => {
  const f = await retainedFixture(), done = await f.owner.holdLocalActivity(); let stopped = false;
  try {
    const pending = boundedWorker(new URL('./fixtures/verifier-containment-worker.js', import.meta.url), Uint8Array.of(0), new AbortController().signal);
    await assert.rejects(f.owner.release()); const result = await pending; stopped = true; done();
    assert.equal(result.kind, 'timeout'); assert.equal(result.exit, 1); assert.ok(result.elapsedMs >= 1900 && result.elapsedMs < 3500); assert.ok(result.threadId > 0);
    await writeFile(join(f.directory, 'worker-timeout-result.json'), canonical({ version: 1, kind: 'trusted-containment-fixture', coreEligible: false, result, ownerReleaseRefusedWhileHeld: true, stoppedBeforeRelease: true }), { mode: 0o600 });
  } finally { if (stopped) await f.close(); }
});
test('cancellation and the configured JS heap failure await actual Worker exit without an RSS claim', async () => {
  const f = await retainedFixture();
  try {
    const abort = new AbortController(), timer = setTimeout(() => abort.abort(), 50); let cancelled;
    try { cancelled = await boundedWorker(new URL('./fixtures/verifier-containment-worker.js', import.meta.url), Uint8Array.of(0), abort.signal); } finally { clearTimeout(timer); }
    assert.equal(cancelled.kind, 'cancelled'); assert.equal(cancelled.exit, 1);
    const heap = await boundedWorker(new URL('./fixtures/verifier-containment-worker.js', import.meta.url), Uint8Array.of(1), new AbortController().signal);
    assert.equal(heap.kind, 'failed'); assert.equal(heap.exit, 1); assert.equal(heap.errorCode, 'ERR_WORKER_OUT_OF_MEMORY'); assert.deepEqual(heap.limits, { oldMb: 64, youngMb: 8, stackMb: 2 });
    await writeFile(join(f.directory, 'worker-cancel-heap-result.json'), canonical({ version: 1, kind: 'trusted-containment-fixture', coreEligible: false, cancelled, heap, rssMeasured: false }), { mode: 0o600 });
  } finally { await f.close(); }
});
