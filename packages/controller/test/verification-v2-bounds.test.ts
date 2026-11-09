import assert from 'node:assert/strict';
import { test } from 'node:test';
import { lstat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { retainedFixture } from './progress-fixtures.js';
import { cycleFixture } from './scheduling-fixtures.js';
import { runCycleWithPorts } from '../src/controller.js';
import { JSON_FILE_BYTES } from '../src/verifier-protocol.js';
import { canonical, hash } from '../src/schema.js';
import type { ControllerProgress } from '../src/types.js';

test('v2 initial known oversize fails before S02 creation or adapter open and retains its complete frozen input', async () => {
  const original = Buffer.concat([Buffer.from('{"ok":true}'), Buffer.alloc(JSON_FILE_BYTES - 10, 32)]), f = await cycleFixture(true, original); let opens = 0;
  const runId = 'run-initial-oversize', result = await runCycleWithPorts({ configuration: f.loaded, repository: f.repository, runRoot: f.runRoot, runId }, { openAdapter: async () => { opens++; throw new Error('no initial dispatch'); } });
  assert.equal(result.ok, false); if (result.ok) return; assert.equal(result.error.code, 'OUTPUT_LIMIT'); assert.equal(opens, 0);
  const directory = join(f.runRoot, runId), absent = async (path: string) => lstat(path).then(() => false, (error: NodeJS.ErrnoException) => error.code === 'ENOENT');
  assert.equal(await absent(join(directory, 'state')), true); assert.equal(await absent(join(directory, 'run.json')), true); assert.equal(await absent(join(directory, 'controller.owner.ndjson')), true);
  await writeFile(join(directory, 'initial-oversize-proof.json'), canonical({ version: 1, result, originalBytes: original.byteLength, originalDigest: hash(original), originalPath: join(f.repository, 'result.json'), opens, stateCreated: false, nativeExecution: false }), { mode: 0o600 });
});

test('v2 conservative refusal row envelopes fit unchanged progress/index/checkpoint bounds for every admitted capacity shape', async () => {
  const f = await retainedFixture();
  try {
    // Pure codec upper envelopes only: these invented rows are NEVER published, branded, or accepted as evidence.
    const long = 'x'.repeat(64), ref = { name: 'x'.repeat(128), digest: hash('codec-envelope'), byteLength: 8388608 }, digest = hash('codec-envelope');
    const subject = { lockHash: digest, contractHash: digest, repository: 'x'.repeat(256), baseRevision: 'x'.repeat(128), sourceRevision: 'x'.repeat(128), candidateDigest: digest, targetMatrixDigest: null };
    const before = { requests: 1024, operations: 2048 }, measurements: { A: number; V: number; C: number; J: number; D: number; progressBytes: number; indexBytes: number; indexEntries: number }[] = [];
    for (let A = 1; A <= 16; A++) for (let V = 1; V <= A + 1; V++) for (let C = 2; C <= 16; C++) {
      const J = C * V, D = 4 + 3 * A + 2 * J; if (D > 64) continue;
      const attempts = Array.from({ length: A }, (_, index) => ({ ordinal: index + 1, id: long, nodeId: long, nativeStepId: long, sessionId: long, purpose: 'compaction' as const, repair: 'implementation' as const, command: ref, before, finished: { after: before, outcome: ref, nativeCheckpointId: long } }));
      const capacity = { ...f.plan.capacity, A, V, C, J, D }, consumed = Array.from({ length: D }, () => 'x'.repeat(64));
      const verifierRefusals = Array.from({ length: J }, (_, index) => ({ slot: 'check.' + long, generation: Math.floor(index / C), prospectiveOperationId: long, producerNonce: 'a'.repeat(32), subject, record: { ...ref, byteLength: 65536 } }));
      const progress: ControllerProgress = { ...f.draft, sequence: D, previous: ref, runId: long, stage: { kind: 'terminal_observations', phase: long, capacity, consumed, watermarks: before },
        nodes: Array.from({ length: 16 }, () => ({ id: long, state: 'completed' })), attempts, nativeCheckpoints: attempts.map(attempt => ({ attemptId: long, checkpointId: long, outcome: attempt.finished.outcome })), submission: ref,
        candidate: { manifest: ref, digest, generation: V - 1, workspace: ref, privateSession: ref }, failures: Array.from({ length: 16 }, () => ({ signature: digest, count: 2, generation: 16, evidence: ref })), verifierRefusals, verifierReceipts: [], eventSequence: Number.MAX_SAFE_INTEGER,
        terminalIntent: { primary: long, result: ref, observations: ref } };
      const progressBytes = Buffer.byteLength(canonical(progress)); assert.ok(progressBytes <= 65536, canonical({ A, V, C, J, D, progressBytes }));
      // Two physical refs per job is a conservative index bound; a refusal contributes only one.
      const entries = Array.from({ length: 2 * J + A + 4 }, () => ({ id: 'check.' + long + '.16.receipt', kind: 'verifier-receipt', ref }));
      assert.ok(entries.every(entry => Buffer.byteLength(canonical(entry)) <= 768 && Buffer.byteLength(canonical(entry.ref)) <= 512));
      const indexBytes = Buffer.byteLength(canonical({ version: 1, runId: long, entries })); assert.ok(indexBytes <= 65536);
      measurements.push({ A, V, C, J, D, progressBytes, indexBytes, indexEntries: entries.length });
    }
    // Full 32 KiB manifest plus six maximum private refs, identifier, field framing and existing 1 KiB margin.
    const checkpointBound = 32768 + Buffer.byteLength(canonical({ checkpointId: long, workspace: ref, privateSession: ref, additionalArtifacts: [ref, ref, ref, ref], candidateManifest: null })) + 1024;
    assert.ok(checkpointBound <= 40960); assert.equal(Math.max(...measurements.map(row => row.J)), 28); assert.ok(measurements.some(row => row.D === 64));
    await writeFile(join(f.directory, 'v2-codec-envelope-proof.json'), canonical({ version: 1, kind: 'conservative-codec-upper-envelope-only', authoritativeRows: false, checkpointBound, rows: measurements, maximumProgressBytes: Math.max(...measurements.map(row => row.progressBytes)), maximumIndexBytes: Math.max(...measurements.map(row => row.indexBytes)), checkpointCount: 0, modelCalls: 0 }), { mode: 0o600 });
  } finally { await f.close(); }
});
