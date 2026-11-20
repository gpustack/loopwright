import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { chmod, link, lstat, mkdir, mkdtemp, open, readFile, realpath, rm, symlink, truncate, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  OVERLAY_LIMITS,
  admitTask,
  bindSubject,
  digestArtifact,
  digestArtifactFromMetadata,
  type ArtifactManifest,
  type ArtifactRef,
  type Result,
} from '@loopwright/core';
import { createLocalRun, type CheckpointRecord, type StateResult } from '@loopwright/state';
import { contract } from '../../core/test/fixtures.js';
import { canonical } from '../src/boundary.js';
import { Candidate, gitBlobOid, materializeCandidateDirectory, setDirectoryTreeMode } from '../src/candidate.js';
import { captureBinding, captureCheckpoint } from '../src/capture.js';
import { decodePiCapture } from '../src/decode-capture.js';
import { PiFailure } from '../src/errors.js';
import { MAX_LIMITS } from '../src/policy.js';
import { prepareInput } from '../src/preflight.js';
import { recoverSnapshot } from '../src/recovery.js';
import { PREAMBLE_IDENTITY } from '../src/resources.js';
import { rowBytes } from '../src/snapshot.js';
import type { PiCandidateBlobArtifact, PiHost, PiOpenInput } from '../src/types.js';
import { daemonFixture } from './daemon-fixtures.js';
import { sessionInput } from './session-fixtures.js';

function coreGood<T>(value: Result<T>): T {
  assert.equal(value.ok, true, JSON.stringify(value));
  if (!value.ok) throw new Error('core fixture failed');
  return value.value;
}

function stateGood<T>(value: StateResult<T>): T {
  assert.equal(value.ok, true, JSON.stringify(value));
  if (!value.ok) throw new Error('state fixture failed');
  return value.value;
}

async function createStreamedFile(
  filePath: string,
  totalBytes: number,
  fillByte: number,
  mode = 0o400,
): Promise<{ readonly sha256Hex: string; readonly gitSha1Oid: string; readonly byteLength: number }> {
  const chunk = Buffer.alloc(65_536, fillByte);
  const sha = createHash('sha256');
  const git = createHash('sha1').update(`blob ${totalBytes}\0`);
  const handle = await open(filePath, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
  try {
    let remaining = totalBytes;
    while (remaining > 0) {
      const slice = remaining >= chunk.length ? chunk : chunk.subarray(0, remaining);
      await handle.write(slice, 0, slice.length);
      sha.update(slice);
      git.update(slice);
      remaining -= slice.length;
    }
    await handle.chmod(mode);
    await handle.sync();
  } finally {
    await handle.close();
  }
  return {
    sha256Hex: sha.digest('hex'),
    gitSha1Oid: git.digest('hex'),
    byteLength: totalBytes,
  };
}

function makeLockWithOverlay(maxBytes: number) {
  const task = contract();
  task.spec.roles[0]!.model = 'claude-sonnet-5.5';
  task.spec.roles[0]!.thinking = 'xhigh';
  task.spec.roles[0]!.tools = ['read', 'write', 'delete'];
  task.spec.budgets.wallTimeMs = 60_000;
  task.spec.budgets.totalTokens = 1_000_000;
  task.spec.budgets.perCallOutputTokens = 1_024;
  (task.spec.budgets as unknown as { overlay?: { maxFiles: number; maxBytes: number } }).overlay = {
    maxFiles: 128,
    maxBytes,
  };
  return coreGood(admitTask(task, { admissionId: 'admission-cas-1', runId: 'run-cas-1' }));
}

async function createRunHost(directory: string, input: PiOpenInput) {
  const runtimeDir = join(directory, 'runtime');
  const artifactsDir = join(directory, 'artifacts');
  await mkdir(runtimeDir, { recursive: true, mode: 0o700 });
  await mkdir(artifactsDir, { recursive: true, mode: 0o700 });
  const daemon = daemonFixture(directory);
  const store = stateGood(createLocalRun({
    directory: join(directory, 'state'),
    storeId: 'store-cas-1',
    lock: input.lock,
    policy: { version: 1, leaseMs: 10_000, cost: 'observe_only' },
    binding: {
      coreApiVersion: 'loopwright.dev/v1alpha1',
      hostVersion: 'test',
      adapters: [{ id: 'pi', version: '0.0.0' }],
      resourceVersion: input.policy.resourceVersion,
      clockEpoch: 'boot-cas-1',
    },
  }));
  const view = stateGood(store.inspect());
  const claimed = stateGood(store.claim({
    ownerId: 'owner-cas-1',
    expectedGeneration: view.owner.generation,
    expectedRevision: view.revision,
    mode: 'active',
  }));
  const host: PiHost = {
    store,
    authority: claimed.authority,
    directory: runtimeDir,
    artifactsDirectory: artifactsDir,
    dockerExecutable: daemon.dockerExecutable,
    dockerSocket: daemon.dockerSocket,
    runtime: input.policy.runtime,
    resolveCredential: async () => ({ bearerToken: 'SYNTHETIC_HOST_SECRET' }),
  };
  return { host, store, runtimeDir, artifactsDir };
}

test('MAX_LIMITS raises fileBytes and artifactBytes to 16 GiB while keeping prompt, tool, and session caps strict', () => {
  assert.equal(MAX_LIMITS.fileBytes, OVERLAY_LIMITS.maxMaxBytes);
  assert.equal(MAX_LIMITS.artifactBytes, OVERLAY_LIMITS.maxMaxBytes);
  assert.equal(MAX_LIMITS.fileBytes, 17_179_869_184);
  assert.equal(MAX_LIMITS.artifactBytes, 17_179_869_184);
  assert.equal(MAX_LIMITS.promptBytes, 1_048_576);
  assert.equal(MAX_LIMITS.toolArgsBytes, 4_194_304);
  assert.equal(MAX_LIMITS.toolResultBytes, 4_194_304);
  assert.equal(MAX_LIMITS.sessionBytes, 67_108_864);

  const source = sessionInput();
  assert.ok(prepareInput({
    ...source,
    policy: {
      ...source.policy,
      limits: {
        ...source.policy.limits,
        fileBytes: 17_179_869_184,
        artifactBytes: 17_179_869_184,
      },
    },
  }));

  for (const [key, overLimit] of [
    ['promptBytes', 1_048_577],
    ['toolArgsBytes', 4_194_305],
    ['toolResultBytes', 4_194_305],
    ['sessionBytes', 67_108_865],
    ['fileBytes', 17_179_869_185],
    ['artifactBytes', 17_179_869_185],
  ] as const) {
    assert.throws(
      () => prepareInput({
        ...source,
        policy: { ...source.policy, limits: { ...source.policy.limits, [key]: overLimit } },
      }),
      err => err instanceof PiFailure && err.detail.code === 'INPUT_INVALID',
      `expected ${key}=${overLimit} to be refused`,
    );
  }
});

test('PiCandidateBlobArtifact (> 64 MiB) round-trips preflight, materialize, captureCheckpoint (blob_ref), decodePiCapture, and recoverSnapshot', async () => {
  const dir = await mkdtemp(join(await realpath(tmpdir()), 'loopwright-cas-large-'));
  const largeSize = 68 * 1024 * 1024; // 68 MiB (> 64 MiB raw Uint8Array ceiling)
  const sourceBlobPath = join(dir, 'large-source.blob');
  try {
    const streamed = await createStreamedFile(sourceBlobPath, largeSize, 0x5a, 0o400);
    const largeRef = coreGood(digestArtifactFromMetadata('packages/large.bin', {
      digest: { algorithm: 'sha256', hex: streamed.sha256Hex },
      byteLength: largeSize,
    }));
    const smallBytes = Buffer.from('export const small = true;\n');
    const smallRef = coreGood(digestArtifact('packages/small.ts', smallBytes));

    const base = sessionInput();
    const lock = makeLockWithOverlay(256 * 1024 * 1024);
    const stagingBaseline = join(dir, 'baseline');
    const baseSmallBytes = Buffer.from('export const small = false;\n');
    await mkdir(join(stagingBaseline, 'packages'), { recursive: true, mode: 0o755 });
    await writeFile(join(stagingBaseline, 'packages/small.ts'), baseSmallBytes, { mode: 0o444 });

    const blobDescriptor: PiCandidateBlobArtifact = {
      name: 'packages/large.bin',
      byteLength: largeSize,
      digest: { algorithm: 'sha256', hex: streamed.sha256Hex },
      blobPath: sourceBlobPath,
    };

    const manifest: ArtifactManifest = {
      apiVersion: 'loopwright.dev/v1alpha1',
      kind: 'ArtifactManifest',
      metadata: { id: 'candidate' },
      spec: {
        baseTree: {
          objectFormat: 'sha1',
          commitOid: 'a'.repeat(40),
          treeOid: 'b'.repeat(40),
        },
        entries: [largeRef, smallRef],
        deleted: [],
      },
    };

    const rawInput: PiOpenInput = {
      ...base,
      lock,
      policy: {
        ...base.policy,
        tools: ['read', 'write', 'delete'],
        resources: [PREAMBLE_IDENTITY],
        limits: MAX_LIMITS,
      },
      candidate: {
        manifest,
        baseRevision: lock.spec.contract.spec.target.baseRevision,
        sourceRevision: lock.spec.contract.spec.target.sourceRevision,
        artifacts: [blobDescriptor, { name: 'packages/small.ts', bytes: smallBytes }],
        baseline: {
          directory: stagingBaseline,
          entries: [
            {
              name: 'packages/small.ts',
              mode: '100644',
              oid: gitBlobOid('sha1', baseSmallBytes),
              byteLength: baseSmallBytes.byteLength,
            },
          ],
        },
      },
      resources: [],
      restore: null,
    };

    const prepared = prepareInput(rawInput);
    assert.equal(prepared.candidate.artifacts.length, 2);

    const { host, store, runtimeDir, artifactsDir } = await createRunHost(dir, prepared);
    const candidateDir = join(runtimeDir, 'sdk-session-1', 'candidate');
    await mkdir(join(runtimeDir, 'sdk-session-1'), { recursive: true, mode: 0o700 });
    try {
      await materializeCandidateDirectory(candidateDir, prepared);
      const candidate = new Candidate(candidateDir, prepared);
      await candidate.captureBaselineStats();

      const checked = await candidate.checkRead('packages/large.bin');
      assert.equal(checked.ref.byteLength, largeSize);
      assert.equal(checked.ref.digest.hex, streamed.sha256Hex);

      const liveManifest = await candidate.manifest();
      assert.equal(liveManifest.spec.entries.length, 2);

      const timestamp = '2026-11-20T00:00:00.000Z';
      const capture = await captureCheckpoint(
        host,
        prepared,
        candidate,
        {
          capture: async sink => {
            await sink(rowBytes({ type: 'session', version: 3, id: 'native-cas-1', cwd: '/workspace/candidate', timestamp }));
          },
        },
        'checkpoint-cas-1',
        1,
        new AbortController().signal,
      );

      // Idempotent capture works on > 64 MiB overlay without allocating whole-file Buffer
      const captureAgain = await captureCheckpoint(
        host,
        prepared,
        candidate,
        { capture: async () => { throw new Error('idempotent capture must not re-stream session'); } },
        'checkpoint-cas-1',
        1,
        new AbortController().signal,
      );
      assert.equal(canonical(captureAgain.workspace), canonical(capture.workspace));

      // Verify CAS blob permissions (0o400) and nlink === 1
      const casLargePath = join(artifactsDir, 'blobs', 'sha256', streamed.sha256Hex);
      const casSmallPath = join(artifactsDir, 'blobs', 'sha256', smallRef.digest.hex);
      const casLargeStat = await lstat(casLargePath);
      assert.equal(casLargeStat.isFile(), true);
      assert.equal(casLargeStat.isSymbolicLink(), false);
      assert.equal(casLargeStat.nlink, 1);
      assert.equal(casLargeStat.mode & 0o777, 0o400);
      assert.equal(casLargeStat.size, largeSize);

      // Verify .workspace.ndjson emits blob_ref rows with cas://sha256/<hex> and zero chunk rows
      const workspaceBytes = await readFile(join(artifactsDir, capture.workspace.name));
      const sessionBytes = await readFile(join(artifactsDir, capture.session.name));
      const wsRows = workspaceBytes.toString('utf8').trimEnd().split('\n').map(line => JSON.parse(line) as Record<string, unknown>);
      const blobRefRows = wsRows.filter(row => row.type === 'blob_ref');
      assert.equal(blobRefRows.length, 2);
      assert.equal(wsRows.some(row => row.type === 'chunk'), false);
      assert.equal((blobRefRows[0]!.blobRef as ArtifactRef).uri, `cas://sha256/${streamed.sha256Hex}`);
      assert.equal((blobRefRows[1]!.blobRef as ArtifactRef).uri, `cas://sha256/${smallRef.digest.hex}`);

      const checkpointRecord = stateGood(store.getCheckpoint('checkpoint-cas-1'));

      // decodePiCapture without artifactsDirectory refuses INPUT_INVALID for blob_ref snapshot
      const missingDirDecoded = await decodePiCapture({
        version: 1,
        lock: prepared.lock,
        policy: prepared.policy,
        checkpoint: checkpointRecord,
        sessionId: prepared.sessionId,
        roleId: prepared.roleId,
        stepId: prepared.stepId,
        workspace: { ref: capture.workspace, bytes: workspaceBytes },
        session: { ref: capture.session, bytes: sessionBytes },
        command: null,
      });
      assert.equal(missingDirDecoded.ok, false);
      if (!missingDirDecoded.ok) {
        assert.equal(missingDirDecoded.error.code, 'INPUT_INVALID');
      }

      // decodePiCapture with > 64 MiB file decodes cleanly with blobArtifacts populated and artifacts: []
      const decodedLarge = await decodePiCapture({
        version: 1,
        lock: prepared.lock,
        policy: prepared.policy,
        checkpoint: checkpointRecord,
        sessionId: prepared.sessionId,
        roleId: prepared.roleId,
        stepId: prepared.stepId,
        workspace: { ref: capture.workspace, bytes: workspaceBytes },
        session: { ref: capture.session, bytes: sessionBytes },
        command: null,
        artifactsDirectory: artifactsDir,
      });
      assert.equal(decodedLarge.ok, true, JSON.stringify(decodedLarge));
      if (!decodedLarge.ok) throw new Error('expected decodePiCapture to succeed');
      assert.equal(decodedLarge.value.artifacts.length, 0);
      assert.equal(decodedLarge.value.blobArtifacts.length, 2);
      assert.equal(decodedLarge.value.blobArtifacts[0]!.blobPath, casLargePath);
      assert.equal(decodedLarge.value.blobArtifacts[0]!.byteLength, largeSize);
      assert.equal(decodedLarge.value.blobArtifacts[1]!.blobPath, casSmallPath);

      // recoverSnapshot succeeds with CAS blob descriptors
      const recovered = recoverSnapshot(host, {
        ...prepared,
        candidate: {
          ...prepared.candidate,
          artifacts: decodedLarge.value.blobArtifacts,
        },
        restore: {
          checkpointId: 'checkpoint-cas-1',
          workspace: { ref: capture.workspace, bytes: workspaceBytes },
          session: { ref: capture.session, bytes: sessionBytes },
        },
      });
      assert.ok(recovered !== null);
      assert.equal(recovered.sequence, 1);
    } finally {
      store.close();
      await setDirectoryTreeMode(candidateDir, 0o755).catch(() => {});
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('decodePiCapture respects includeArtifactBytes and rejects legacy/v2 corruption, mixed rows, duplicate blob_ref, and tampered CAS blobs', async () => {
  const dir = await mkdtemp(join(await realpath(tmpdir()), 'loopwright-cas-neg-'));
  try {
    const fileBytes = Buffer.from('export const value = 42;\n');
    const fileRef = coreGood(digestArtifact('packages/example.ts', fileBytes));
    const base = sessionInput();
    const input: PiOpenInput = {
      ...base,
      candidate: {
        ...base.candidate,
        manifest: {
          apiVersion: 'loopwright.dev/v1alpha1',
          kind: 'ArtifactManifest',
          metadata: { id: 'candidate' },
          spec: { entries: [fileRef] },
        },
        artifacts: [{ name: 'packages/example.ts', bytes: fileBytes }],
      },
    };
    const prepared = prepareInput(input);
    const { host, store, runtimeDir, artifactsDir } = await createRunHost(dir, prepared);
    const candidateDir = join(runtimeDir, 'sdk-session-1', 'candidate');
    await mkdir(join(runtimeDir, 'sdk-session-1'), { recursive: true, mode: 0o700 });
    try {
      await materializeCandidateDirectory(candidateDir, prepared);
      const candidate = new Candidate(candidateDir, prepared);
      const timestamp = '2026-11-20T00:00:00.000Z';
      const capture = await captureCheckpoint(
        host,
        prepared,
        candidate,
        {
          capture: async sink => {
            await sink(rowBytes({ type: 'session', version: 3, id: 'native-cas-neg', cwd: '/workspace/candidate', timestamp }));
          },
        },
        'checkpoint-neg-1',
        1,
        new AbortController().signal,
      );
      const checkpoint = stateGood(store.getCheckpoint('checkpoint-neg-1'));
      const wsBytes = await readFile(join(artifactsDir, capture.workspace.name));
      const sessBytes = await readFile(join(artifactsDir, capture.session.name));

      // includeArtifactBytes omitted -> both artifacts and blobArtifacts populated for <= 64 MiB
      const withBytes = await decodePiCapture({
        version: 1,
        lock: prepared.lock,
        policy: prepared.policy,
        checkpoint,
        sessionId: prepared.sessionId,
        roleId: prepared.roleId,
        stepId: prepared.stepId,
        workspace: { ref: capture.workspace, bytes: wsBytes },
        session: { ref: capture.session, bytes: sessBytes },
        command: null,
        artifactsDirectory: artifactsDir,
      });
      assert.equal(withBytes.ok, true, JSON.stringify(withBytes));
      if (!withBytes.ok) throw new Error('expected decode ok');
      assert.equal(withBytes.value.artifacts.length, 1);
      assert.deepEqual(Buffer.from(withBytes.value.artifacts[0]!.bytes), fileBytes);
      assert.equal(withBytes.value.blobArtifacts.length, 1);

      // includeArtifactBytes: false -> artifacts is empty while blobArtifacts is populated
      const withoutBytes = await decodePiCapture({
        version: 1,
        lock: prepared.lock,
        policy: prepared.policy,
        checkpoint,
        sessionId: prepared.sessionId,
        roleId: prepared.roleId,
        stepId: prepared.stepId,
        workspace: { ref: capture.workspace, bytes: wsBytes },
        session: { ref: capture.session, bytes: sessBytes },
        command: null,
        artifactsDirectory: artifactsDir,
        includeArtifactBytes: false,
      });
      assert.equal(withoutBytes.ok, true, JSON.stringify(withoutBytes));
      if (!withoutBytes.ok) throw new Error('expected decode ok');
      assert.equal(withoutBytes.value.artifacts.length, 0);
      assert.equal(withoutBytes.value.blobArtifacts.length, 1);

      // Helper to build synthetic workspace.ndjson for row-format tests
      const binding = captureBinding(host, prepared, capture.candidate, 'checkpoint-synth', 1);
      const synthSessionBytes = Buffer.concat([
        rowBytes({ type: 'session_snapshot', version: 1, binding }),
        rowBytes({ type: 'session', version: 3, id: 'native-synth', cwd: '/workspace/candidate', timestamp }),
      ]);
      const synthSessionRef = coreGood(digestArtifact('pi-checkpoints/checkpoint-synth.session.ndjson', synthSessionBytes));
      const makeSynthRecord = (wsRef: ArtifactRef): CheckpointRecord => ({
        ...checkpoint,
        checkpointId: 'checkpoint-synth',
        workspace: wsRef,
        privateSession: synthSessionRef,
      });

      // Legacy v1 { type: 'chunk' } decodes cleanly without artifactsDirectory and recovers cleanly
      const legacyWsBytes = Buffer.concat([
        rowBytes({ type: 'workspace_snapshot', version: 1, binding, manifest: capture.candidate }),
        rowBytes({ type: 'file', ref: fileRef }),
        rowBytes({ type: 'chunk', index: 0, data: fileBytes.toString('base64') }),
        rowBytes({ type: 'file_end', byteLength: fileRef.byteLength, digest: fileRef.digest.hex }),
        rowBytes({ type: 'end', files: 1 }),
      ]);
      const legacyWsRef = coreGood(digestArtifact('pi-checkpoints/checkpoint-synth.workspace.ndjson', legacyWsBytes));
      const legacyDecoded = await decodePiCapture({
        version: 1,
        lock: prepared.lock,
        policy: prepared.policy,
        checkpoint: makeSynthRecord(legacyWsRef),
        sessionId: prepared.sessionId,
        roleId: prepared.roleId,
        stepId: prepared.stepId,
        workspace: { ref: legacyWsRef, bytes: legacyWsBytes },
        session: { ref: synthSessionRef, bytes: synthSessionBytes },
        command: null,
      });
      assert.equal(legacyDecoded.ok, true, JSON.stringify(legacyDecoded));
      if (!legacyDecoded.ok) throw new Error('expected legacy v1 decode ok');
      assert.equal(legacyDecoded.value.blobArtifacts.length, 0);
      assert.equal(legacyDecoded.value.artifacts.length, 1);
      assert.deepEqual(Buffer.from(legacyDecoded.value.artifacts[0]!.bytes), fileBytes);

      // Write synthetic legacy v1 checkpoint to store and verify recoverSnapshot succeeds on legacy chunk format
      const legacyNow = stateGood(store.inspect());
      stateGood(store.writeCheckpoint(host.authority, {
        checkpointId: 'checkpoint-synth',
        expectedRevision: legacyNow.revision,
        candidateManifest: capture.candidate,
        workspace: legacyWsRef,
        privateSession: synthSessionRef,
        additionalArtifacts: [],
      }));
      const legacyRecovered = recoverSnapshot(host, {
        ...prepared,
        restore: {
          checkpointId: 'checkpoint-synth',
          workspace: { ref: legacyWsRef, bytes: legacyWsBytes },
          session: { ref: synthSessionRef, bytes: synthSessionBytes },
        },
      });
      assert.ok(legacyRecovered !== null);
      assert.equal(legacyRecovered.sequence, 1);

      // Mixed blob_ref + chunk ACROSS two files in the same .workspace.ndjson fails closed with RECOVERY_REQUIRED
      const secondBytes = Buffer.from('export const second = 2;\n');
      const secondRef = coreGood(digestArtifact('packages/second.ts', secondBytes));
      const secondCasPath = join(artifactsDir, 'blobs', 'sha256', secondRef.digest.hex);
      await writeFile(secondCasPath, secondBytes, { mode: 0o400 });
      const twoManifest: ArtifactManifest = {
        apiVersion: 'loopwright.dev/v1alpha1',
        kind: 'ArtifactManifest',
        metadata: { id: 'candidate' },
        spec: { entries: [fileRef, secondRef] },
      };
      const twoBinding = captureBinding(host, prepared, twoManifest, 'checkpoint-two', 1);
      const twoSubject = coreGood(bindSubject(prepared.lock, twoManifest));
      const twoSessBytes = Buffer.concat([
        rowBytes({ type: 'session_snapshot', version: 1, binding: twoBinding }),
        rowBytes({ type: 'session', version: 3, id: 'native-two', cwd: '/workspace/candidate', timestamp }),
      ]);
      const twoSessRef = coreGood(digestArtifact('pi-checkpoints/checkpoint-two.session.ndjson', twoSessBytes));
      const firstBlobRef = coreGood(digestArtifactFromMetadata(fileRef.name, {
        digest: fileRef.digest,
        byteLength: fileRef.byteLength,
        uri: `cas://sha256/${fileRef.digest.hex}`,
      }));
      const secondBlobRef = coreGood(digestArtifactFromMetadata(secondRef.name, {
        digest: secondRef.digest,
        byteLength: secondRef.byteLength,
        uri: `cas://sha256/${secondRef.digest.hex}`,
      }));
      for (const mixedCrossBytes of [
        Buffer.concat([
          rowBytes({ type: 'workspace_snapshot', version: 1, binding: twoBinding, manifest: twoManifest }),
          rowBytes({ type: 'file', ref: fileRef }),
          rowBytes({ type: 'blob_ref', ref: fileRef, blobRef: firstBlobRef }),
          rowBytes({ type: 'file_end', byteLength: fileRef.byteLength, digest: fileRef.digest.hex }),
          rowBytes({ type: 'file', ref: secondRef }),
          rowBytes({ type: 'chunk', index: 0, data: secondBytes.toString('base64') }),
          rowBytes({ type: 'file_end', byteLength: secondRef.byteLength, digest: secondRef.digest.hex }),
          rowBytes({ type: 'end', files: 2 }),
        ]),
        Buffer.concat([
          rowBytes({ type: 'workspace_snapshot', version: 1, binding: twoBinding, manifest: twoManifest }),
          rowBytes({ type: 'file', ref: fileRef }),
          rowBytes({ type: 'chunk', index: 0, data: fileBytes.toString('base64') }),
          rowBytes({ type: 'file_end', byteLength: fileRef.byteLength, digest: fileRef.digest.hex }),
          rowBytes({ type: 'file', ref: secondRef }),
          rowBytes({ type: 'blob_ref', ref: secondRef, blobRef: secondBlobRef }),
          rowBytes({ type: 'file_end', byteLength: secondRef.byteLength, digest: secondRef.digest.hex }),
          rowBytes({ type: 'end', files: 2 }),
        ]),
      ]) {
        const mixedWsRef = coreGood(digestArtifact('pi-checkpoints/checkpoint-two.workspace.ndjson', mixedCrossBytes));
        const mixedRecord: CheckpointRecord = {
          ...checkpoint,
          checkpointId: 'checkpoint-two',
          subject: twoSubject,
          workspace: mixedWsRef,
          privateSession: twoSessRef,
        };
        const res = await decodePiCapture({
          version: 1,
          lock: prepared.lock,
          policy: prepared.policy,
          checkpoint: mixedRecord,
          sessionId: prepared.sessionId,
          roleId: prepared.roleId,
          stepId: prepared.stepId,
          workspace: { ref: mixedWsRef, bytes: mixedCrossBytes },
          session: { ref: twoSessRef, bytes: twoSessBytes },
          command: null,
          artifactsDirectory: artifactsDir,
        });
        assert.equal(res.ok, false);
        if (!res.ok) assert.equal(res.error.code, 'RECOVERY_REQUIRED');
      }

      // Malformed row combinations must fail closed with RECOVERY_REQUIRED
      const blobRef = coreGood(digestArtifactFromMetadata(fileRef.name, {
        digest: fileRef.digest,
        byteLength: fileRef.byteLength,
        uri: `cas://sha256/${fileRef.digest.hex}`,
      }));
      const badRowSets: readonly Buffer[] = [
        // Mixed blob_ref + chunk within same file
        Buffer.concat([
          rowBytes({ type: 'workspace_snapshot', version: 1, binding, manifest: capture.candidate }),
          rowBytes({ type: 'file', ref: fileRef }),
          rowBytes({ type: 'blob_ref', ref: fileRef, blobRef }),
          rowBytes({ type: 'chunk', index: 0, data: fileBytes.toString('base64') }),
          rowBytes({ type: 'file_end', byteLength: fileRef.byteLength, digest: fileRef.digest.hex }),
          rowBytes({ type: 'end', files: 1 }),
        ]),
        // Mixed chunk + blob_ref within same file
        Buffer.concat([
          rowBytes({ type: 'workspace_snapshot', version: 1, binding, manifest: capture.candidate }),
          rowBytes({ type: 'file', ref: fileRef }),
          rowBytes({ type: 'chunk', index: 0, data: fileBytes.toString('base64') }),
          rowBytes({ type: 'blob_ref', ref: fileRef, blobRef }),
          rowBytes({ type: 'file_end', byteLength: fileRef.byteLength, digest: fileRef.digest.hex }),
          rowBytes({ type: 'end', files: 1 }),
        ]),
        // Duplicate blob_ref
        Buffer.concat([
          rowBytes({ type: 'workspace_snapshot', version: 1, binding, manifest: capture.candidate }),
          rowBytes({ type: 'file', ref: fileRef }),
          rowBytes({ type: 'blob_ref', ref: fileRef, blobRef }),
          rowBytes({ type: 'blob_ref', ref: fileRef, blobRef }),
          rowBytes({ type: 'file_end', byteLength: fileRef.byteLength, digest: fileRef.digest.hex }),
          rowBytes({ type: 'end', files: 1 }),
        ]),
        // Missing blob_ref before file_end
        Buffer.concat([
          rowBytes({ type: 'workspace_snapshot', version: 1, binding, manifest: capture.candidate }),
          rowBytes({ type: 'file', ref: fileRef }),
          rowBytes({ type: 'file_end', byteLength: fileRef.byteLength, digest: fileRef.digest.hex }),
          rowBytes({ type: 'end', files: 1 }),
        ]),
      ];

      for (const badWsBytes of badRowSets) {
        const badWsRef = coreGood(digestArtifact('pi-checkpoints/checkpoint-synth.workspace.ndjson', badWsBytes));
        const res = await decodePiCapture({
          version: 1,
          lock: prepared.lock,
          policy: prepared.policy,
          checkpoint: makeSynthRecord(badWsRef),
          sessionId: prepared.sessionId,
          roleId: prepared.roleId,
          stepId: prepared.stepId,
          workspace: { ref: badWsRef, bytes: badWsBytes },
          session: { ref: synthSessionRef, bytes: synthSessionBytes },
          command: null,
          artifactsDirectory: artifactsDir,
        });
        assert.equal(res.ok, false);
        if (!res.ok) assert.equal(res.error.code, 'RECOVERY_REQUIRED');
      }

      // Tampered CAS blobs: hardlinked, writable, corrupted, truncated, symlinked
      const casPath = join(artifactsDir, 'blobs', 'sha256', fileRef.digest.hex);
      const restoreCasBlob = async () => {
        await unlink(casPath).catch(() => {});
        await writeFile(casPath, fileBytes, { mode: 0o400 });
        await chmod(casPath, 0o400);
      };

      // 1. Hardlinked CAS blob (nlink > 1)
      const aliasPath = join(dir, 'hardlink-alias');
      await link(casPath, aliasPath);
      const hardlinkDecoded = await decodePiCapture({
        version: 1, lock: prepared.lock, policy: prepared.policy, checkpoint,
        sessionId: prepared.sessionId, roleId: prepared.roleId, stepId: prepared.stepId,
        workspace: { ref: capture.workspace, bytes: wsBytes }, session: { ref: capture.session, bytes: sessBytes },
        command: null, artifactsDirectory: artifactsDir,
      });
      assert.equal(hardlinkDecoded.ok, false);
      if (!hardlinkDecoded.ok) assert.ok(hardlinkDecoded.error.code === 'RECOVERY_REQUIRED' || hardlinkDecoded.error.code === 'RESOURCE_MISMATCH');
      assert.throws(
        () => recoverSnapshot(host, {
          ...prepared,
          restore: { checkpointId: 'checkpoint-neg-1', workspace: { ref: capture.workspace, bytes: wsBytes }, session: { ref: capture.session, bytes: sessBytes } },
        }),
        err => err instanceof PiFailure && (err.detail.code === 'RECOVERY_REQUIRED' || err.detail.code === 'RESOURCE_MISMATCH'),
      );
      await unlink(aliasPath);

      // 2. Writable CAS blob (mode 0o600)
      await chmod(casPath, 0o600);
      const writableDecoded = await decodePiCapture({
        version: 1, lock: prepared.lock, policy: prepared.policy, checkpoint,
        sessionId: prepared.sessionId, roleId: prepared.roleId, stepId: prepared.stepId,
        workspace: { ref: capture.workspace, bytes: wsBytes }, session: { ref: capture.session, bytes: sessBytes },
        command: null, artifactsDirectory: artifactsDir,
      });
      assert.equal(writableDecoded.ok, false);
      if (!writableDecoded.ok) assert.equal(writableDecoded.error.code, 'RECOVERY_REQUIRED');
      await chmod(casPath, 0o400);

      // 3. Corrupted CAS blob (same length, different byte)
      await chmod(casPath, 0o600);
      await writeFile(casPath, Buffer.from('export const value = 99;\n'));
      await chmod(casPath, 0o400);
      const corruptDecoded = await decodePiCapture({
        version: 1, lock: prepared.lock, policy: prepared.policy, checkpoint,
        sessionId: prepared.sessionId, roleId: prepared.roleId, stepId: prepared.stepId,
        workspace: { ref: capture.workspace, bytes: wsBytes }, session: { ref: capture.session, bytes: sessBytes },
        command: null, artifactsDirectory: artifactsDir,
      });
      assert.equal(corruptDecoded.ok, false);
      if (!corruptDecoded.ok) assert.equal(corruptDecoded.error.code, 'RESOURCE_MISMATCH');
      await restoreCasBlob();

      // 4. Truncated CAS blob
      await chmod(casPath, 0o600);
      await truncate(casPath, 5);
      await chmod(casPath, 0o400);
      const truncDecoded = await decodePiCapture({
        version: 1, lock: prepared.lock, policy: prepared.policy, checkpoint,
        sessionId: prepared.sessionId, roleId: prepared.roleId, stepId: prepared.stepId,
        workspace: { ref: capture.workspace, bytes: wsBytes }, session: { ref: capture.session, bytes: sessBytes },
        command: null, artifactsDirectory: artifactsDir,
      });
      assert.equal(truncDecoded.ok, false);
      if (!truncDecoded.ok) assert.ok(truncDecoded.error.code === 'RESOURCE_MISMATCH' || truncDecoded.error.code === 'RECOVERY_REQUIRED');
      await restoreCasBlob();

      // 5. Symlinked CAS blob
      const targetBlob = join(dir, 'symlink-target');
      await writeFile(targetBlob, fileBytes, { mode: 0o400 });
      await unlink(casPath);
      await symlink(targetBlob, casPath);
      const symDecoded = await decodePiCapture({
        version: 1, lock: prepared.lock, policy: prepared.policy, checkpoint,
        sessionId: prepared.sessionId, roleId: prepared.roleId, stepId: prepared.stepId,
        workspace: { ref: capture.workspace, bytes: wsBytes }, session: { ref: capture.session, bytes: sessBytes },
        command: null, artifactsDirectory: artifactsDir,
      });
      assert.equal(symDecoded.ok, false);
      if (!symDecoded.ok) assert.equal(symDecoded.error.code, 'RECOVERY_REQUIRED');
    } finally {
      store.close();
      await setDirectoryTreeMode(candidateDir, 0o755).catch(() => {});
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('prepareInput rejects ambiguous bytes+blobPath (including null-prototype), symlinked/hardlinked/corrupted blobPath, and baseline-identical blob OID', async () => {
  const dir = await mkdtemp(join(await realpath(tmpdir()), 'loopwright-preflight-cas-'));
  try {
    const fileBytes = Buffer.from('export const value = 1;\n');
    const fileRef = coreGood(digestArtifact('packages/example.ts', fileBytes));
    const blobPath = join(dir, 'good.blob');
    await writeFile(blobPath, fileBytes, { mode: 0o400 });

    const base = sessionInput();

    // Ambiguous object with both bytes and blobPath (plain and null-prototype)
    for (const ambiguous of [
      { name: 'packages/example.ts', bytes: fileBytes, byteLength: fileBytes.byteLength, digest: fileRef.digest, blobPath },
      Object.assign(Object.create(null) as Record<string, unknown>, {
        name: 'packages/example.ts',
        bytes: fileBytes,
        byteLength: fileBytes.byteLength,
        digest: fileRef.digest,
        blobPath,
      }),
    ]) {
      assert.throws(
        () => prepareInput({ ...base, candidate: { ...base.candidate, artifacts: [ambiguous] } }),
        err => err instanceof PiFailure && err.detail.code === 'INPUT_INVALID',
      );
    }

    // Relative / NUL / newline blobPath
    for (const badPath of ['relative/blob', join(dir, 'bad\0blob'), join(dir, 'bad\nblob')]) {
      assert.throws(
        () => prepareInput({
          ...base,
          candidate: {
            ...base.candidate,
            artifacts: [{ name: 'packages/example.ts', byteLength: fileBytes.byteLength, digest: fileRef.digest, blobPath: badPath }],
          },
        }),
        err => err instanceof PiFailure && err.detail.code === 'INPUT_INVALID',
      );
    }

    // Symlinked blobPath
    const symBlob = join(dir, 'sym.blob');
    await symlink(blobPath, symBlob);
    assert.throws(
      () => prepareInput({
        ...base,
        candidate: {
          ...base.candidate,
          artifacts: [{ name: 'packages/example.ts', byteLength: fileBytes.byteLength, digest: fileRef.digest, blobPath: symBlob }],
        },
      }),
      err => err instanceof PiFailure && (err.detail.code === 'RESOURCE_MISMATCH' || err.detail.code === 'RECOVERY_REQUIRED'),
    );

    // Hardlinked blobPath
    const hardBlob = join(dir, 'hard.blob');
    await link(blobPath, hardBlob);
    assert.throws(
      () => prepareInput({
        ...base,
        candidate: {
          ...base.candidate,
          artifacts: [{ name: 'packages/example.ts', byteLength: fileBytes.byteLength, digest: fileRef.digest, blobPath }],
        },
      }),
      err => err instanceof PiFailure && (err.detail.code === 'RESOURCE_MISMATCH' || err.detail.code === 'RECOVERY_REQUIRED'),
    );
    await unlink(hardBlob);

    // Overlay blobPath identical to baseline Git blob OID fails with RESOURCE_MISMATCH
    const overlayManifest: ArtifactManifest = {
      apiVersion: 'loopwright.dev/v1alpha1',
      kind: 'ArtifactManifest',
      metadata: { id: 'candidate' },
      spec: {
        baseTree: { objectFormat: 'sha1', commitOid: 'a'.repeat(40), treeOid: 'b'.repeat(40) },
        entries: [fileRef],
        deleted: [],
      },
    };
    assert.throws(
      () => prepareInput({
        ...base,
        candidate: {
          ...base.candidate,
          manifest: overlayManifest,
          artifacts: [{ name: 'packages/example.ts', byteLength: fileBytes.byteLength, digest: fileRef.digest, blobPath }],
          baseline: {
            directory: dir,
            entries: [{ name: 'packages/example.ts', mode: '100644', oid: gitBlobOid('sha1', fileBytes), byteLength: fileBytes.byteLength }],
          },
        },
      }),
      err => err instanceof PiFailure && err.detail.code === 'RESOURCE_MISMATCH',
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
