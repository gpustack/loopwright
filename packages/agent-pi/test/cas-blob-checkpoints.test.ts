import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { constants, promises as fsPromises } from 'node:fs';
import { chmod, link, lstat, mkdir, mkdtemp, open, readdir, readFile, realpath, rm, symlink, truncate, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mock, test } from 'node:test';
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
import { canonical, digest } from '../src/boundary.js';
import { constructAdapter, type FactoryPorts } from '../src/adapter.js';
import { constructAdapterV2 } from '../src/adapter-v2.js';
import { Candidate, gitBlobOid, materializeCandidateDirectory, setDirectoryTreeMode } from '../src/candidate.js';
import { captureBinding, captureCheckpoint } from '../src/capture.js';
import { decodePiCapture } from '../src/decode-capture.js';
import { PiFailure } from '../src/errors.js';
import { MAX_LIMITS } from '../src/policy.js';
import { CAS_CHUNK_BYTES, ensureCasSha256Dir, publishCandidateFileToCas, streamCopyVerifiedBlob } from '../src/cas.js';
import { prepareInput } from '../src/preflight.js';
import { PROVIDER_DESTINATION } from '../src/provider.js';
import { recoverSnapshot } from '../src/recovery.js';
import { PREAMBLE_IDENTITY, systemPrompt } from '../src/resources.js';
import { Sender } from '../src/sender.js';
import { rowBytes } from '../src/snapshot.js';
import type { PiCandidateBlobArtifact, PiCapabilities, PiHost, PiOpenInput } from '../src/types.js';
import type { PiHostV2, PiOpenInputV2 } from '../src/types-v2.js';
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

async function makeCasTempDir(): Promise<string> {
  const baseTmp = process.platform === 'darwin' ? '/tmp' : tmpdir();
  return mkdtemp(join(await realpath(baseTmp), 'lw-cas-'));
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

test('MAX_LIMITS raises fileBytes and artifactBytes to 16 GiB, candidateEntries to 16,384, and CAS_CHUNK_BYTES to 1 MiB while keeping prompt, tool, and session caps strict', () => {
  assert.equal(CAS_CHUNK_BYTES, 1_048_576);
  assert.equal(MAX_LIMITS.candidateEntries, 16_384);
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
        candidateEntries: 16_384,
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
    ['candidateEntries', 16_385],
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

  assert.throws(
    () => prepareInput({
      ...source,
      candidate: {
        ...source.candidate,
        artifacts: new Array<unknown>(16_385).fill({ name: 'a.ts', bytes: new Uint8Array(0) }) as unknown as typeof source.candidate.artifacts,
      },
    }),
    err => err instanceof PiFailure && err.detail.code === 'INPUT_INVALID',
  );
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
      const recovered = await recoverSnapshot(host, {
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
      const legacyRecovered = await recoverSnapshot(host, {
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
      await assert.rejects(
        recoverSnapshot(host, {
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

test('streamCopyVerifiedBlob supports CoW reflink projection and 1 MiB streaming fallback (disableReflink: true) while preserving nlink===1 and refusing EEXIST/mismatch', async () => {
  const dir = await mkdtemp(join(await realpath(tmpdir()), 'loopwright-cas-reflink-'));
  try {
    const size = CAS_CHUNK_BYTES * 2 + 137;
    const srcBlob = join(dir, 'src.blob');
    const created = await createStreamedFile(srcBlob, size, 0x3c, 0o400);

    // 1. Default CoW reflink path
    const reflinkTarget = join(dir, 'projected-reflink.bin');
    await streamCopyVerifiedBlob(srcBlob, reflinkTarget, { byteLength: size, sha256Hex: created.sha256Hex }, 0o444);
    const reflinkStat = await lstat(reflinkTarget);
    assert.equal(reflinkStat.isFile(), true);
    assert.equal(reflinkStat.isSymbolicLink(), false);
    assert.equal(reflinkStat.nlink, 1);
    assert.equal(reflinkStat.mode & 0o777, 0o444);
    assert.equal(reflinkStat.size, size);

    // 2. Forced 1 MiB streaming fallback (disableReflink: true)
    const fallbackTarget = join(dir, 'projected-fallback.bin');
    await streamCopyVerifiedBlob(
      srcBlob,
      fallbackTarget,
      { byteLength: size, sha256Hex: created.sha256Hex },
      0o555,
      { disableReflink: true },
    );
    const fallbackStat = await lstat(fallbackTarget);
    assert.equal(fallbackStat.nlink, 1);
    assert.equal(fallbackStat.mode & 0o777, 0o555);
    assert.equal(fallbackStat.size, size);
    assert.equal(createHash('sha256').update(await readFile(fallbackTarget)).digest('hex'), created.sha256Hex);

    // 3. Pre-existing targetPath fails closed without deleting existing file
    const existingTarget = join(dir, 'existing.bin');
    await writeFile(existingTarget, 'keep-me', { mode: 0o600 });
    await assert.rejects(
      streamCopyVerifiedBlob(srcBlob, existingTarget, { byteLength: size, sha256Hex: created.sha256Hex }, 0o444),
      err => err instanceof PiFailure && err.detail.code === 'RECOVERY_REQUIRED',
    );
    assert.equal(await readFile(existingTarget, 'utf8'), 'keep-me');

    // 4. SHA-256 mismatch unlinks target and refuses RESOURCE_MISMATCH
    const mismatchTarget = join(dir, 'mismatch.bin');
    await assert.rejects(
      streamCopyVerifiedBlob(srcBlob, mismatchTarget, { byteLength: size, sha256Hex: '0'.repeat(64) }, 0o444),
      err => err instanceof PiFailure && err.detail.code === 'RESOURCE_MISMATCH',
    );
    await assert.rejects(lstat(mismatchTarget), (err: NodeJS.ErrnoException) => err.code === 'ENOENT');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('publishCandidateFileToCas and captureCheckpoint stream-check fresh ingestion and EEXIST dedup hits before accepting CAS blobs', async () => {
  const dir = await makeCasTempDir();
  try {
    const artifactsDir = join(dir, 'artifacts');
    await mkdir(artifactsDir, { recursive: true, mode: 0o700 });
    const sha256Dir = await ensureCasSha256Dir(artifactsDir);

    const secretPayload = Buffer.from('token=ghp_0123456789abcdefghij0123456789\n', 'utf8');
    const secretHex = createHash('sha256').update(secretPayload).digest('hex');
    const secretSrc = join(dir, 'secret.txt');
    await writeFile(secretSrc, secretPayload, { mode: 0o600 });

    const makeRejectingChecker = (needle: string) => () => {
      let acc = '';
      return {
        push: (chunk: Uint8Array) => {
          acc += Buffer.from(chunk).toString('latin1');
          if (acc.includes(needle)) throw new Error('SECRET_DETECTED');
        },
        finish: () => {
          acc = '';
        },
      };
    };

    // 1. Fresh ingestion rejects BEFORE linking <hex> and cleans up .tmp-*
    await assert.rejects(
      publishCandidateFileToCas(
        secretSrc,
        sha256Dir,
        { byteLength: secretPayload.byteLength, sha256Hex: secretHex },
        new AbortController().signal,
        makeRejectingChecker('ghp_0123456789abcdefghij0123456789'),
      ),
      /SECRET_DETECTED/,
    );
    await assert.rejects(lstat(join(sha256Dir, secretHex)), (err: NodeJS.ErrnoException) => err.code === 'ENOENT');

    // 2. Even without a custom checker, publishCandidateFileToCas runs the built-in checker on BOTH fresh write AND EEXIST dedup!
    await assert.rejects(
      publishCandidateFileToCas(
        secretSrc,
        sha256Dir,
        { byteLength: secretPayload.byteLength, sha256Hex: secretHex },
        new AbortController().signal,
      ),
      err => err instanceof PiFailure && err.detail.code === 'CONTEXT_UNSAFE',
    );
    await assert.rejects(lstat(join(sha256Dir, secretHex)), (err: NodeJS.ErrnoException) => err.code === 'ENOENT');

    // Pre-populate CAS blob directly on disk to test EEXIST dedup checks (built-in and custom)
    await writeFile(join(sha256Dir, secretHex), secretPayload, { mode: 0o400 });
    await chmod(join(sha256Dir, secretHex), 0o400);
    assert.equal((await lstat(join(sha256Dir, secretHex))).isFile(), true);

    await assert.rejects(
      publishCandidateFileToCas(
        secretSrc,
        sha256Dir,
        { byteLength: secretPayload.byteLength, sha256Hex: secretHex },
        new AbortController().signal,
      ),
      err => err instanceof PiFailure && err.detail.code === 'CONTEXT_UNSAFE',
    );

    let checkerCalls = 0;
    const dedupOnlyReject = () => {
      checkerCalls += 1;
      const callNum = checkerCalls;
      return {
        push: (chunk: Uint8Array) => {
          if (callNum >= 2 && Buffer.from(chunk).toString('latin1').includes('ghp_0123456789abcdefghij0123456789')) {
            throw new Error('DEDUP_SECRET_DETECTED');
          }
        },
        finish: () => {},
      };
    };
    await assert.rejects(
      publishCandidateFileToCas(
        secretSrc,
        sha256Dir,
        { byteLength: secretPayload.byteLength, sha256Hex: secretHex },
        new AbortController().signal,
        dedupOnlyReject,
      ),
      /DEDUP_SECRET_DETECTED/,
    );
    assert.equal(checkerCalls, 2);

    // 3. captureCheckpoint forwards host.createCandidateStreamChecker and rejects before persisting <hex>
    const base = sessionInput();
    const lock = makeLockWithOverlay(16 * 1024 * 1024);
    const leakedRef = coreGood(digestArtifact('packages/leaked.ts', secretPayload));
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
        manifest: {
          apiVersion: 'loopwright.dev/v1alpha1',
          kind: 'ArtifactManifest',
          metadata: { id: 'candidate' },
          spec: { entries: [leakedRef] },
        },
        baseRevision: lock.spec.contract.spec.target.baseRevision,
        sourceRevision: lock.spec.contract.spec.target.sourceRevision,
        artifacts: [{ name: 'packages/leaked.ts', bytes: secretPayload }],
      },
      resources: [],
      restore: null,
    };
    const prepared = prepareInput(rawInput);
    const runDir = join(dir, 'run-capture');
    await mkdir(runDir, { recursive: true, mode: 0o700 });
    const { host, store, runtimeDir, artifactsDir: runArtifactsDir } = await createRunHost(runDir, prepared);
    const candidateDir = join(runtimeDir, 'sdk-session-scrub', 'candidate');
    await mkdir(join(runtimeDir, 'sdk-session-scrub'), { recursive: true, mode: 0o700 });
    try {
      await materializeCandidateDirectory(candidateDir, prepared);
      const candidate = new Candidate(candidateDir, prepared);
      const guardedHost: PiHost = {
        ...host,
        createCandidateStreamChecker: makeRejectingChecker('ghp_0123456789abcdefghij0123456789'),
      };
      await assert.rejects(
        captureCheckpoint(
          guardedHost,
          prepared,
          candidate,
          {
            capture: async sink => {
              await sink(rowBytes({ type: 'session', version: 3, id: 'native-scrub-1', cwd: '/workspace/candidate', timestamp: '2026-11-20T00:00:00.000Z' }));
            },
          },
          'checkpoint-scrub-1',
          1,
          new AbortController().signal,
        ),
        /SECRET_DETECTED/,
      );
      await assert.rejects(
        lstat(join(runArtifactsDir, 'blobs', 'sha256', secretHex)),
        (err: NodeJS.ErrnoException) => err.code === 'ENOENT',
      );
    } finally {
      store.close();
      await setDirectoryTreeMode(candidateDir, 0o755).catch(() => {});
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('R2-5: public Pi v1/v2 adapters without host.createCandidateStreamChecker reject generic tokens and resolved bearer credentials on fresh capture and EEXIST dedup', async () => {
  const dir = await makeCasTempDir();
  try {
    const resolvedToken = 'CustomAdapterSecret+Bearer9876543210==';
    const genericToken = 'ghp_0123456789abcdefghij0123456789';
    const sseBody = [
      { type: 'message_start', message: { id: 'fixture', role: 'assistant', model: 'claude-sonnet-5.5', content: [], usage: { input_tokens: 4, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } } },
      { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'DONE' } },
      { type: 'content_block_stop', index: 0 },
      { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 2 } },
      { type: 'message_stop' },
    ].map(frame => `event: ${frame.type}\ndata: ${JSON.stringify(frame)}\n\n`).join('');

    const makeAdapterPorts = (): FactoryPorts => ({
      environment: async () => {},
      sender: (owner, owned) => new Sender(owner, owned, {
        fetch: async () => new Response(sseBody, { status: 200, headers: { 'content-type': 'text/event-stream' } }),
      }),
      session: (_owner, owned, broker, sessionDir) => ({
        start: async (): Promise<PiCapabilities> => {
          await mkdir(sessionDir, { recursive: true, mode: 0o700 });
          await materializeCandidateDirectory(join(sessionDir, 'candidate'), owned);
          return {
            version: 1,
            policyDigest: digest(Buffer.from(canonical(owned.policy))),
            runtime: owned.policy.runtime,
            requested: owned.policy.selection,
            catalogSupported: owned.policy.selection,
            sessionEffective: owned.policy.selection,
            outboundObserved: null,
            resources: owned.policy.resources,
            accounting: 'soft_only',
            contextFit: 'unproven',
            defaultMode: 'proven_bound',
            liveProvenBoundAvailable: false,
            optInMode: 'estimated_guard',
            contextEstimator: { id: 'lw-pi-final-json-bytes-v1', version: 1, provenance: 'estimated' },
            toolExecution: { candidate: 'read_only', candidateWrites: 'mediated', scratch: 'per_call' },
          };
        },
        command: async () => {
          const grant = await broker.invoke({ invocation: 1, ...owned.policy.selection });
          await broker.send(
            {
              invocation: 1,
              slot: grant.slot,
              method: 'POST',
              url: PROVIDER_DESTINATION,
              headers: {
                'content-type': 'application/json',
                'anthropic-version': '2023-06-01',
                'x-initiator': 'user',
                'openai-intent': 'conversation-edits',
              },
            },
            Buffer.from(JSON.stringify({
              model: owned.policy.selection.model,
              system: [{ type: 'text', text: systemPrompt(owned) + '\n\n<cwd>\n/workspace/candidate\n</cwd>' }],
              messages: [{ role: 'user', content: 'literal task' }],
              stream: true,
              max_tokens: 1024,
              thinking: { type: 'adaptive' },
              output_config: { effort: 'xhigh' },
            })),
          );
          await broker.parsed({
            invocation: 1,
            slot: grant.slot,
            stopReason: 'stop',
            rawStopReason: 'end_turn',
            usage: { input: 4, output: 2, cacheRead: 0, cacheWrite: 0 },
            toolCalls: [],
          });
        },
        capture: async sink => {
          const ts = '2026-11-20T00:00:00.000Z';
          await sink(rowBytes({ type: 'session', version: 3, id: 's-builtin', cwd: '/workspace/candidate', timestamp: ts }));
          await sink(rowBytes({ type: 'message', id: 'u1', parentId: null, timestamp: ts, message: { role: 'user', content: 'literal task' } }));
          await sink(rowBytes({ type: 'message', id: 'a1', parentId: 'u1', timestamp: ts, message: { role: 'assistant', ...owned.policy.selection, content: [{ type: 'text', text: 'DONE' }], stopReason: 'stop' } }));
        },
        close: async () => {},
      }),
    });

    const runCase = async (
      name: string,
      payload: Buffer,
      useV2: boolean,
      prePopulateCas: boolean,
    ) => {
      const subDir = join(dir, name);
      await mkdir(subDir, { recursive: true, mode: 0o700 });
      const base = sessionInput();
      const lock = makeLockWithOverlay(16 * 1024 * 1024);
      const fileRef = coreGood(digestArtifact('packages/leak.ts', payload));
      const v1Input: PiOpenInput = {
        ...base,
        lock,
        policy: {
          ...base.policy,
          tools: ['read', 'write', 'delete'],
          resources: [PREAMBLE_IDENTITY],
          limits: MAX_LIMITS,
        },
        candidate: {
          manifest: {
            apiVersion: 'loopwright.dev/v1alpha1',
            kind: 'ArtifactManifest',
            metadata: { id: 'candidate' },
            spec: { entries: [fileRef] },
          },
          baseRevision: lock.spec.contract.spec.target.baseRevision,
          sourceRevision: lock.spec.contract.spec.target.sourceRevision,
          artifacts: [{ name: 'packages/leak.ts', bytes: payload }],
        },
        resources: [],
        restore: null,
      };
      const prepared = prepareInput(v1Input);
      const { host, store, artifactsDir } = await createRunHost(subDir, prepared);
      // Notice: host omits createCandidateStreamChecker completely!
      const bareHost: PiHost = {
        ...host,
        resolveCredential: async () => ({ bearerToken: resolvedToken }),
      };
      const shaHex = createHash('sha256').update(payload).digest('hex');
      if (prePopulateCas) {
        const shaDir = await ensureCasSha256Dir(artifactsDir);
        await writeFile(join(shaDir, shaHex), payload, { mode: 0o400 });
        await chmod(join(shaDir, shaHex), 0o400);
      }

      const ports = makeAdapterPorts();
      const opened = useV2
        ? await constructAdapterV2(
            {
              ...bareHost,
              resolveMcpCredential: async () => ({ bearerToken: resolvedToken }),
            } as PiHostV2,
            {
              ...v1Input,
              version: 2,
              policy: { ...v1Input.policy, version: 2 },
            } as unknown as PiOpenInputV2,
            ports,
          )
        : await constructAdapter(bareHost, v1Input, ports);
      assert.equal(opened.ok, true, JSON.stringify(opened));
      if (!opened.ok) {
        store.close();
        return;
      }
      try {
        // Real execute() resolves bearer credential through Sender -> host.resolveCredential and settles execution
        const execRes = await opened.value.execute({ commandId: 'cmd-1', text: 'literal task', purpose: 'task', repair: 'none' });
        assert.equal(execRes.ok, true, JSON.stringify(execRes));
        if (execRes.ok) {
          assert.equal(execRes.value.status, 'execution_settled', JSON.stringify(execRes.value));
        }
        const capRes = await opened.value.capture({ checkpointId: 'cp-scrub-1' });
        assert.equal(capRes.ok, false, `expected ${name} to refuse secret leak`);
        if (!capRes.ok) {
          assert.equal(capRes.error.code, 'CONTEXT_UNSAFE', JSON.stringify(capRes.error));
        }
        if (!prePopulateCas) {
          await assert.rejects(
            lstat(join(artifactsDir, 'blobs', 'sha256', shaHex)),
            (err: NodeJS.ErrnoException) => err.code === 'ENOENT',
          );
        }
      } finally {
        await opened.value.close();
        store.close();
        await setDirectoryTreeMode(subDir, 0o755).catch(() => {});
      }
    };

    // 1. Generic token rejected by v1 and v2 without host.createCandidateStreamChecker (fresh & EEXIST)
    const genericBody = Buffer.from(`export const k = "${genericToken}";\n`, 'utf8');
    await runCase('v1-generic-fresh', genericBody, false, false);
    await runCase('v2-generic-fresh', genericBody, true, false);
    await runCase('v1-generic-eexist', genericBody, false, true);

    // 2. Resolved bearer credential (raw and base64) rejected by v1 and v2 without host.createCandidateStreamChecker (fresh & EEXIST)
    const resolvedBody = Buffer.from(`export const b = "${Buffer.from(resolvedToken, 'utf8').toString('base64')}";\n`, 'utf8');
    await runCase('v1-resolved-fresh', resolvedBody, false, false);
    await runCase('v2-resolved-fresh', resolvedBody, true, false);
    await runCase('v2-resolved-eexist', resolvedBody, true, true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('R2-14: constructAdapter / prepareInput strictly binds CAS blobPath beneath <host.artifactsDirectory>/blobs/sha256/<hex> and requires read-only single-link files', async () => {
  const dir = await mkdtemp(join(await realpath(tmpdir()), 'loopwright-pi-cas-bind-'));
  try {
    const fileBytes = Buffer.from('export const bound = 1;\n', 'utf8');
    const fileRef = coreGood(digestArtifact('packages/example.ts', fileBytes));
    const base = sessionInput();
    const basePrepared = prepareInput(base);
    const { host, store, artifactsDir } = await createRunHost(dir, basePrepared);
    const shaDir = await ensureCasSha256Dir(artifactsDir);

    // Create a valid sealed 0o400 blob in ANOTHER directory outside host.artifactsDirectory
    const externalArtifacts = join(dir, 'other-run-artifacts');
    await mkdir(externalArtifacts, { recursive: true, mode: 0o700 });
    const externalShaDir = await ensureCasSha256Dir(externalArtifacts);
    const externalBlobPath = join(externalShaDir, fileRef.digest.hex);
    await writeFile(externalBlobPath, fileBytes, { mode: 0o400 });
    await chmod(externalBlobPath, 0o400);

    const makeBlobInput = (blobPath: string): PiOpenInput => ({
      ...base,
      candidate: {
        ...base.candidate,
        manifest: {
          apiVersion: 'loopwright.dev/v1alpha1',
          kind: 'ArtifactManifest',
          metadata: { id: 'candidate' },
          spec: { entries: [fileRef] },
        },
        artifacts: [{ name: 'packages/example.ts', byteLength: fileBytes.byteLength, digest: fileRef.digest, blobPath }],
      },
    });

    const stubPorts: FactoryPorts = {
      environment: async () => {},
      session: (_h, owned) => ({
        start: async () => ({
          version: 1,
          policyDigest: digest(Buffer.from(canonical(owned.policy))),
          runtime: owned.policy.runtime,
          requested: owned.policy.selection,
          catalogSupported: owned.policy.selection,
          sessionEffective: owned.policy.selection,
          outboundObserved: null,
          resources: owned.policy.resources,
          accounting: 'soft_only',
          contextFit: 'unproven',
          defaultMode: 'proven_bound',
          liveProvenBoundAvailable: false,
          optInMode: 'estimated_guard',
          contextEstimator: { id: 'lw-pi-final-json-bytes-v1', version: 1, provenance: 'estimated' },
          toolExecution: { candidate: 'read_only', candidateWrites: 'mediated', scratch: 'per_call' },
        }),
        command: async () => {},
        close: async () => {},
      }),
    };

    try {
      // 1. Sealed blob in another directory is refused with RESOURCE_MISMATCH at /candidate/artifacts/blobPath
      const externalOpened = await constructAdapter(host, makeBlobInput(externalBlobPath), stubPorts);
      assert.equal(externalOpened.ok, false);
      if (!externalOpened.ok) {
        assert.equal(externalOpened.error.code, 'RESOURCE_MISMATCH');
        assert.equal(externalOpened.error.path, '/candidate/artifacts/blobPath');
      }

      // 2. Writable (0o600) blob inside host.artifactsDirectory/blobs/sha256/<hex> is refused with RESOURCE_MISMATCH
      const localBlobPath = join(shaDir, fileRef.digest.hex);
      await writeFile(localBlobPath, fileBytes, { mode: 0o600 });
      await chmod(localBlobPath, 0o600);
      const writableOpened = await constructAdapter(host, makeBlobInput(localBlobPath), stubPorts);
      assert.equal(writableOpened.ok, false);
      if (!writableOpened.ok) {
        assert.equal(writableOpened.error.code, 'RESOURCE_MISMATCH');
      }

      // 3. Sealed 0o400 single-link blob inside host.artifactsDirectory/blobs/sha256/<hex> is admitted and bound to canonical expectedBlobPath
      await chmod(localBlobPath, 0o400);
      const preparedBound = prepareInput(makeBlobInput(localBlobPath), artifactsDir);
      const firstArtifact = preparedBound.candidate.artifacts[0]!;
      assert.equal('blobPath' in firstArtifact, true);
      if ('blobPath' in firstArtifact) {
        assert.equal(firstArtifact.blobPath, join(await realpath(artifactsDir), 'blobs', 'sha256', fileRef.digest.hex));
      }
      const validOpened = await constructAdapter(host, makeBlobInput(localBlobPath), stubPorts);
      assert.equal(validOpened.ok, true, JSON.stringify(validOpened));
      if (validOpened.ok) {
        await validOpened.value.close();
      }
    } finally {
      store.close();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('R2-9: wide flat directory checkpoint capture (512 sibling files) avoids O(N^2) readdir calls via scoped capture-pass cache', async () => {
  const dir = await mkdtemp(join(await realpath(tmpdir()), 'loopwright-pi-wide-readdir-'));
  try {
    const fileCount = 512;
    const base = sessionInput();
    const task = contract();
    task.spec.roles[0]!.model = 'claude-sonnet-5.5';
    task.spec.roles[0]!.thinking = 'xhigh';
    task.spec.roles[0]!.tools = ['read', 'write', 'delete'];
    task.spec.budgets.wallTimeMs = 60_000;
    task.spec.budgets.totalTokens = 1_000_000;
    task.spec.budgets.perCallOutputTokens = 1_024;
    (task.spec.budgets as unknown as { overlay?: { maxFiles: number; maxBytes: number } }).overlay = {
      maxFiles: 1024,
      maxBytes: 16 * 1024 * 1024,
    };
    const lock = coreGood(admitTask(task, { admissionId: 'admission-wide-1', runId: 'run-wide-1' }));

    const entries: ArtifactRef[] = [];
    const artifacts: { readonly name: string; readonly bytes: Uint8Array }[] = [];
    for (let i = 0; i < fileCount; i++) {
      const name = `packages/item-${String(i).padStart(4, '0')}.txt`;
      const bytes = Buffer.from(`content-${i}\n`, 'utf8');
      entries.push(coreGood(digestArtifact(name, bytes)));
      artifacts.push({ name, bytes });
    }
    const baselineDir = join(dir, 'empty-baseline');
    await mkdir(baselineDir, { recursive: true, mode: 0o700 });
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
        manifest: {
          apiVersion: 'loopwright.dev/v1alpha1',
          kind: 'ArtifactManifest',
          metadata: { id: 'candidate' },
          spec: {
            baseTree: { objectFormat: 'sha1', commitOid: 'a'.repeat(40), treeOid: 'b'.repeat(40) },
            entries,
            deleted: [],
          },
        },
        baseRevision: lock.spec.contract.spec.target.baseRevision,
        sourceRevision: lock.spec.contract.spec.target.sourceRevision,
        artifacts,
        baseline: {
          directory: baselineDir,
          entries: [],
        },
      },
      resources: [],
      restore: null,
    };
    const prepared = prepareInput(rawInput);
    const { host, store, runtimeDir } = await createRunHost(dir, prepared);
    const candidateDir = join(runtimeDir, 'sdk-wide-1', 'candidate');
    await mkdir(join(runtimeDir, 'sdk-wide-1'), { recursive: true, mode: 0o700 });
    try {
      await materializeCandidateDirectory(candidateDir, prepared);
      const candidate = new Candidate(candidateDir, prepared);

      const readdirCounts = new Map<string, number>();
      const origReaddir = fsPromises.readdir.bind(fsPromises);
      const spy = mock.method(fsPromises, 'readdir', async (targetPath: Parameters<typeof fsPromises.readdir>[0], options?: Parameters<typeof fsPromises.readdir>[1]) => {
        const key = String(targetPath);
        readdirCounts.set(key, (readdirCounts.get(key) ?? 0) + 1);
        return options === undefined ? origReaddir(targetPath) : origReaddir(targetPath, options as never);
      });
      try {
        const capture = await captureCheckpoint(
          host,
          prepared,
          candidate,
          {
            capture: async sink => {
              await sink(rowBytes({ type: 'session', version: 3, id: 'native-wide-1', cwd: '/workspace/candidate', timestamp: '2026-11-20T00:00:00.000Z' }));
            },
          },
          'checkpoint-wide-1',
          1,
          new AbortController().signal,
        );
        assert.equal(capture.candidate.spec.entries.length, fileCount);
        const packagesDir = join(candidateDir, 'packages');
        assert.equal(readdirCounts.get(candidateDir), 1, `expected 1 readdir on root, got ${readdirCounts.get(candidateDir)}`);
        assert.equal(readdirCounts.get(packagesDir), 1, `expected 1 readdir on packages/, got ${readdirCounts.get(packagesDir)}`);

        // Outside capture pass, cache MUST be cleared so live tool reads re-read the directory fresh
        await candidate.checkRead('packages/item-0000.txt');
        assert.equal(readdirCounts.get(packagesDir), 2);
      } finally {
        spy.mock.restore();
      }
    } finally {
      store.close();
      await setDirectoryTreeMode(candidateDir, 0o755).catch(() => {});
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('R3-15: openPiAdapter admission and checkpoint recovery verify multi-chunk CAS blobs asynchronously without starving event loop timers', async () => {
  const dir = await mkdtemp(join(await realpath(tmpdir()), 'loopwright-pi-r3-15-async-'));
  try {
    const blobBytes = Buffer.alloc(CAS_CHUNK_BYTES * 8 + 777, 0x3b);
    blobBytes[0] = 0x10;
    blobBytes[CAS_CHUNK_BYTES * 4] = 0x20;
    blobBytes[blobBytes.byteLength - 1] = 0x30;
    const blobRef = coreGood(digestArtifact('packages/large-async.bin', blobBytes));

    const task = contract();
    task.spec.roles[0]!.model = 'claude-sonnet-5.5';
    task.spec.roles[0]!.thinking = 'xhigh';
    task.spec.roles[0]!.tools = ['read', 'write', 'delete'];
    task.spec.budgets.wallTimeMs = 60_000;
    task.spec.budgets.totalTokens = 1_000_000;
    task.spec.budgets.perCallOutputTokens = 1_024;
    (task.spec.budgets as unknown as { overlay?: { maxFiles: number; maxBytes: number } }).overlay = {
      maxFiles: 128,
      maxBytes: 32 * 1024 * 1024,
    };
    const lock = coreGood(admitTask(task, { admissionId: 'admission-r3-15', runId: 'run-r3-15' }));
    const base = sessionInput();
    const manifest: ArtifactManifest = {
      apiVersion: 'loopwright.dev/v1alpha1',
      kind: 'ArtifactManifest',
      metadata: { id: 'candidate' },
      spec: { entries: [blobRef] },
    };

    const seedPrepared = prepareInput({
      ...base,
      lock,
      policy: { ...base.policy, tools: ['read', 'write', 'delete'], resources: [PREAMBLE_IDENTITY], limits: MAX_LIMITS },
      candidate: {
        manifest: { apiVersion: 'loopwright.dev/v1alpha1', kind: 'ArtifactManifest', metadata: { id: 'candidate' }, spec: { entries: [] } },
        baseRevision: lock.spec.contract.spec.target.baseRevision,
        sourceRevision: lock.spec.contract.spec.target.sourceRevision,
        artifacts: [],
      },
      resources: [],
      restore: null,
    });
    const { host, store, artifactsDir } = await createRunHost(dir, seedPrepared);
    const shaDir = await ensureCasSha256Dir(artifactsDir);
    const casBlobPath = join(shaDir, blobRef.digest.hex);
    await writeFile(casBlobPath, blobBytes, { mode: 0o400 });
    await chmod(casBlobPath, 0o400);

    const blobOpenInput: PiOpenInput = {
      ...base,
      lock,
      policy: { ...base.policy, tools: ['read', 'write', 'delete'], resources: [PREAMBLE_IDENTITY], limits: MAX_LIMITS },
      candidate: {
        manifest,
        baseRevision: lock.spec.contract.spec.target.baseRevision,
        sourceRevision: lock.spec.contract.spec.target.sourceRevision,
        artifacts: [{ name: 'packages/large-async.bin', byteLength: blobBytes.byteLength, digest: blobRef.digest, blobPath: casBlobPath }],
      },
      resources: [],
      restore: null,
    };

    const stubPorts: FactoryPorts = {
      environment: async () => {},
      session: (_h, owned) => ({
        start: async () => ({
          version: 1,
          policyDigest: digest(Buffer.from(canonical(owned.policy))),
          runtime: owned.policy.runtime,
          requested: owned.policy.selection,
          catalogSupported: owned.policy.selection,
          sessionEffective: owned.policy.selection,
          outboundObserved: null,
          resources: owned.policy.resources,
          accounting: 'soft_only',
          contextFit: 'unproven',
          defaultMode: 'proven_bound',
          liveProvenBoundAvailable: false,
          optInMode: 'estimated_guard',
          contextEstimator: { id: 'lw-pi-final-json-bytes-v1', version: 1, provenance: 'estimated' },
          toolExecution: { candidate: 'read_only', candidateWrites: 'mediated', scratch: 'per_call' },
        }),
        command: async () => {},
        close: async () => {},
      }),
    };

    const countLoopTurnsDuring = async <T>(work: () => Promise<T>): Promise<{ readonly value: T; readonly ticks: number }> => {
      let ticks = 0;
      let active = true;
      let immediateHandle: NodeJS.Immediate | undefined;
      const tick = () => {
        if (!active) return;
        ticks++;
        immediateHandle = setImmediate(tick);
      };
      immediateHandle = setImmediate(tick);
      try {
        const value = await work();
        return { value, ticks };
      } finally {
        active = false;
        if (immediateHandle !== undefined) clearImmediate(immediateHandle);
      }
    };

    try {
      // 1. Admission via constructAdapter yields to the event loop while asynchronously hashing 8+ 1 MiB chunks
      const admitted = await countLoopTurnsDuring(() => constructAdapter(host, blobOpenInput, stubPorts));
      assert.equal(admitted.value.ok, true, JSON.stringify(admitted.value));
      assert.ok(admitted.ticks > 0, `expected event-loop ticks during async admission, got ${admitted.ticks}`);
      if (admitted.value.ok) {
        await admitted.value.value.close();
      }

      // 2. Checkpoint recovery via recoverSnapshot yields to the event loop while asynchronously verifying blob_ref CAS blob
      const timestamp = '2026-11-20T00:00:00.000Z';
      const preparedForBinding = prepareInput(blobOpenInput, artifactsDir);
      const binding = captureBinding(host, preparedForBinding, manifest, 'checkpoint-r3-15', 1);
      const sessBytes = Buffer.concat([
        rowBytes({ type: 'session_snapshot', version: 1, binding }),
        rowBytes({ type: 'session', version: 3, id: 'native-r3-15', cwd: '/workspace/candidate', timestamp }),
      ]);
      const sessRef = coreGood(digestArtifact('pi-checkpoints/checkpoint-r3-15.session.ndjson', sessBytes));
      const casBlobRef = coreGood(digestArtifactFromMetadata(blobRef.name, {
        digest: blobRef.digest,
        byteLength: blobRef.byteLength,
        uri: `cas://sha256/${blobRef.digest.hex}`,
      }));
      const wsBytes = Buffer.concat([
        rowBytes({ type: 'workspace_snapshot', version: 1, binding, manifest }),
        rowBytes({ type: 'file', ref: blobRef }),
        rowBytes({ type: 'blob_ref', ref: blobRef, blobRef: casBlobRef }),
        rowBytes({ type: 'file_end', byteLength: blobRef.byteLength, digest: blobRef.digest.hex }),
        rowBytes({ type: 'end', files: 1 }),
      ]);
      const wsRef = coreGood(digestArtifact('pi-checkpoints/checkpoint-r3-15.workspace.ndjson', wsBytes));
      const now = stateGood(store.inspect());
      stateGood(store.writeCheckpoint(host.authority, {
        checkpointId: 'checkpoint-r3-15',
        expectedRevision: now.revision,
        candidateManifest: manifest,
        workspace: wsRef,
        privateSession: sessRef,
        additionalArtifacts: [],
      }));

      const recovered = await countLoopTurnsDuring(() =>
        recoverSnapshot(host, {
          ...preparedForBinding,
          restore: {
            checkpointId: 'checkpoint-r3-15',
            workspace: { ref: wsRef, bytes: wsBytes },
            session: { ref: sessRef, bytes: sessBytes },
          },
        }),
      );
      assert.ok(recovered.value !== null);
      assert.equal(recovered.value.sequence, 1);
      assert.ok(recovered.ticks > 0, `expected event-loop ticks during async recoverSnapshot, got ${recovered.ticks}`);
    } finally {
      store.close();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('R3-20: 8 concurrent publishCandidateFileToCas calls for identical content settle EEXIST cleanly with single nlink===1 0o400 blob and zero .tmp residue', async () => {
  const dir = await mkdtemp(join(await realpath(tmpdir()), 'loopwright-pi-r3-20-race-'));
  try {
    const artifactsDir = join(dir, 'artifacts');
    await mkdir(artifactsDir, { recursive: true, mode: 0o700 });
    const shaDir = await ensureCasSha256Dir(artifactsDir);

    const payload = Buffer.alloc(CAS_CHUNK_BYTES + 4096, 0x6c);
    payload[0] = 0xaa;
    payload[payload.byteLength - 1] = 0xbb;
    const expectedHex = createHash('sha256').update(payload).digest('hex');

    const sources = await Promise.all(
      Array.from({ length: 8 }, async (_, idx) => {
        const srcPath = join(dir, `source-${idx}.bin`);
        await writeFile(srcPath, payload, { mode: 0o600 });
        return srcPath;
      }),
    );

    const ac = new AbortController();
    const publishedPaths = await Promise.all(
      sources.map(srcPath =>
        publishCandidateFileToCas(
          srcPath,
          shaDir,
          { byteLength: payload.byteLength, sha256Hex: expectedHex },
          ac.signal,
        ),
      ),
    );

    const expectedFinalPath = join(shaDir, expectedHex);
    for (const path of publishedPaths) {
      assert.equal(path, expectedFinalPath);
    }

    const finalStat = await lstat(expectedFinalPath);
    assert.equal(finalStat.isSymbolicLink(), false);
    assert.equal(finalStat.isFile(), true);
    assert.equal(finalStat.nlink, 1);
    assert.equal(finalStat.mode & 0o777, 0o400);
    assert.equal(finalStat.size, payload.byteLength);

    const entries = await readdir(shaDir);
    assert.deepEqual(entries, [expectedHex]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('R4-9: constructAdapter and constructAdapterV2 capture and freeze caller baseline and host synchronously before the first await', async () => {
  const dir = await mkdtemp(join(await realpath(tmpdir()), 'loopwright-pi-r4-9-freeze-'));
  try {
    const blobBytes = Buffer.alloc(CAS_CHUNK_BYTES * 2 + 512, 0x4d);
    blobBytes[0] = 0x01;
    blobBytes[blobBytes.byteLength - 1] = 0xfe;
    const blobRef = coreGood(digestArtifact('packages/edited.bin', blobBytes));
    const baseSmallBytes = Buffer.from('export const untouched = true;\n', 'utf8');

    const lock = makeLockWithOverlay(32 * 1024 * 1024);
    const base = sessionInput();
    const manifest: ArtifactManifest = {
      apiVersion: 'loopwright.dev/v1alpha1',
      kind: 'ArtifactManifest',
      metadata: { id: 'candidate' },
      spec: {
        baseTree: { objectFormat: 'sha1', commitOid: 'a'.repeat(40), treeOid: 'b'.repeat(40) },
        entries: [blobRef],
        deleted: [],
      },
    };

    const originalBaselineDirV1 = join(dir, 'baseline-original-v1');
    const originalBaselineDirV2 = join(dir, 'baseline-original-v2');
    const mutatedBaselineDir = join(dir, 'baseline-mutated');
    const mutatedArtifactsDir = join(dir, 'artifacts-mutated');
    for (const baseDir of [originalBaselineDirV1, originalBaselineDirV2]) {
      await mkdir(join(baseDir, 'packages'), { recursive: true, mode: 0o700 });
      await writeFile(join(baseDir, 'packages', 'base.ts'), baseSmallBytes, { mode: 0o444 });
    }
    await mkdir(mutatedBaselineDir, { recursive: true, mode: 0o700 });
    await mkdir(mutatedArtifactsDir, { recursive: true, mode: 0o700 });

    const seedPrepared = prepareInput({
      ...base,
      lock,
      policy: { ...base.policy, tools: ['read', 'write', 'delete'], resources: [PREAMBLE_IDENTITY], limits: MAX_LIMITS },
      candidate: {
        manifest: { apiVersion: 'loopwright.dev/v1alpha1', kind: 'ArtifactManifest', metadata: { id: 'candidate' }, spec: { entries: [] } },
        baseRevision: lock.spec.contract.spec.target.baseRevision,
        sourceRevision: lock.spec.contract.spec.target.sourceRevision,
        artifacts: [],
      },
      resources: [],
      restore: null,
    });
    const { host, store, runtimeDir, artifactsDir } = await createRunHost(dir, seedPrepared);
    const shaDir = await ensureCasSha256Dir(artifactsDir);
    const casBlobPath = join(shaDir, blobRef.digest.hex);
    await writeFile(casBlobPath, blobBytes, { mode: 0o400 });
    await chmod(casBlobPath, 0o400);

    const makeMutableInput = (sessionId: string, baselineDir: string) => {
      const entries = [
        {
          name: 'packages/base.ts',
          mode: '100644' as const,
          oid: gitBlobOid('sha1', baseSmallBytes),
          byteLength: baseSmallBytes.byteLength,
        },
      ];
      const baseline = { directory: baselineDir, entries };
      const input = {
        ...base,
        sessionId,
        lock,
        policy: { ...base.policy, tools: ['read', 'write', 'delete'], resources: [PREAMBLE_IDENTITY], limits: MAX_LIMITS },
        candidate: {
          manifest,
          baseRevision: lock.spec.contract.spec.target.baseRevision,
          sourceRevision: lock.spec.contract.spec.target.sourceRevision,
          artifacts: [{ name: 'packages/edited.bin', byteLength: blobBytes.byteLength, digest: blobRef.digest, blobPath: casBlobPath }],
          baseline,
        },
        resources: [],
        restore: null,
      };
      return { input, baseline, entries };
    };

    try {
      // 1. V1 constructAdapter: mutating host.artifactsDirectory and input.candidate.baseline immediately after call
      //    (while async CAS verification is in flight) has zero effect on the owned host or owned baseline.
      let observedEnvArtifactsDir = '';
      let observedSessionArtifactsDir = '';
      let observedSessionBaselineDir = '';
      let observedSessionBaselineCount = -1;
      const v1Ports: FactoryPorts = {
        environment: async capturedHost => {
          observedEnvArtifactsDir = capturedHost.artifactsDirectory;
        },
        session: (capturedHost, owned, _broker, sessionDir) => {
          observedSessionArtifactsDir = capturedHost.artifactsDirectory;
          observedSessionBaselineDir = owned.candidate.baseline?.directory ?? '';
          observedSessionBaselineCount = owned.candidate.baseline?.entries.length ?? -1;
          return {
            start: async () => {
              await mkdir(sessionDir, { recursive: true, mode: 0o700 });
              await materializeCandidateDirectory(join(sessionDir, 'candidate'), owned);
              return {
                version: 1,
                policyDigest: digest(Buffer.from(canonical(owned.policy))),
                runtime: owned.policy.runtime,
                requested: owned.policy.selection,
                catalogSupported: owned.policy.selection,
                sessionEffective: owned.policy.selection,
                outboundObserved: null,
                resources: owned.policy.resources,
                accounting: 'soft_only',
                contextFit: 'unproven',
                defaultMode: 'proven_bound',
                liveProvenBoundAvailable: false,
                optInMode: 'estimated_guard',
                contextEstimator: { id: 'lw-pi-final-json-bytes-v1', version: 1, provenance: 'estimated' },
                toolExecution: { candidate: 'read_only', candidateWrites: 'mediated', scratch: 'per_call' },
              };
            },
            command: async () => {},
            close: async () => {},
          };
        },
      };

      const mutableHostV1: { -readonly [K in keyof PiHost]: PiHost[K] } = { ...host };
      const v1Case = makeMutableInput('session-r4-9-v1', originalBaselineDirV1);
      const v1Promise = constructAdapter(mutableHostV1, v1Case.input, v1Ports);
      // Synchronously mutate caller-owned host & baseline BEFORE the first await resumes!
      mutableHostV1.artifactsDirectory = mutatedArtifactsDir;
      v1Case.baseline.directory = mutatedBaselineDir;
      v1Case.entries.push({
        name: 'packages/injected.ts',
        mode: '100644',
        oid: 'c'.repeat(40),
        byteLength: 1,
      });

      const v1Opened = await v1Promise;
      assert.equal(v1Opened.ok, true, JSON.stringify(v1Opened));
      assert.equal(observedEnvArtifactsDir, artifactsDir);
      assert.equal(observedSessionArtifactsDir, artifactsDir);
      assert.equal(observedSessionBaselineDir, originalBaselineDirV1);
      assert.equal(observedSessionBaselineCount, 1);
      assert.equal(
        await readFile(join(runtimeDir, 'sdk-session-r4-9-v1', 'candidate', 'packages', 'base.ts'), 'utf8'),
        baseSmallBytes.toString('utf8'),
      );
      if (v1Opened.ok) {
        await v1Opened.value.close();
      }

      // 2. V2 constructAdapterV2: mutating host.artifactsDirectory and input.candidate.baseline immediately after call
      //    (before effectivePolicyV2 and CAS verification resolve) also has zero effect.
      observedEnvArtifactsDir = '';
      observedSessionArtifactsDir = '';
      observedSessionBaselineDir = '';
      observedSessionBaselineCount = -1;
      const mutableHostV2: { -readonly [K in keyof PiHostV2]: PiHostV2[K] } = {
        ...host,
        resolveMcpCredential: async () => ({ bearerToken: 'SYNTHETIC_MCP_SECRET' }),
      };
      const v2Case = makeMutableInput('session-r4-9-v2', originalBaselineDirV2);
      const v2Input = {
        ...v2Case.input,
        version: 2 as const,
        policy: { ...v2Case.input.policy, version: 2 as const },
      };
      const v2Promise = constructAdapterV2(mutableHostV2, v2Input, v1Ports);
      mutableHostV2.artifactsDirectory = mutatedArtifactsDir;
      v2Case.baseline.directory = mutatedBaselineDir;
      v2Case.entries.push({
        name: 'packages/injected-v2.ts',
        mode: '100644',
        oid: 'd'.repeat(40),
        byteLength: 1,
      });

      const v2Opened = await v2Promise;
      assert.equal(v2Opened.ok, true, JSON.stringify(v2Opened));
      assert.equal(observedEnvArtifactsDir, artifactsDir);
      assert.equal(observedSessionArtifactsDir, artifactsDir);
      assert.equal(observedSessionBaselineDir, originalBaselineDirV2);
      assert.equal(observedSessionBaselineCount, 1);
      assert.equal(
        await readFile(join(runtimeDir, 'sdk-session-r4-9-v2', 'candidate', 'packages', 'base.ts'), 'utf8'),
        baseSmallBytes.toString('utf8'),
      );
      if (v2Opened.ok) {
        await v2Opened.value.close();
      }

      // 3. Getters returning different values on 1st vs 2nd read on host.artifactsDirectory or baseline.directory
      //    are rejected synchronously with INPUT_INVALID and 0 invocations!
      let hostGetterCalls = 0;
      const getterHost = { ...host };
      Object.defineProperty(getterHost, 'artifactsDirectory', {
        enumerable: true,
        configurable: true,
        get: () => {
          hostGetterCalls += 1;
          return hostGetterCalls === 1 ? artifactsDir : mutatedArtifactsDir;
        },
      });
      const getterHostRes = await constructAdapter(getterHost, makeMutableInput('session-r4-9-g1', originalBaselineDirV1).input, v1Ports);
      assert.equal(getterHostRes.ok, false);
      if (!getterHostRes.ok) {
        assert.equal(getterHostRes.error.code, 'INPUT_INVALID');
        assert.equal(getterHostRes.error.path, '/host/artifactsDirectory');
      }
      assert.equal(hostGetterCalls, 0);

      let hostV2GetterCalls = 0;
      const getterHostV2 = {
        ...host,
        resolveMcpCredential: async () => ({ bearerToken: 'SYNTHETIC_MCP_SECRET' }),
      };
      Object.defineProperty(getterHostV2, 'artifactsDirectory', {
        enumerable: true,
        configurable: true,
        get: () => {
          hostV2GetterCalls += 1;
          return hostV2GetterCalls === 1 ? artifactsDir : mutatedArtifactsDir;
        },
      });
      const getterV2Case = makeMutableInput('session-r4-9-g2', originalBaselineDirV1);
      const getterHostV2Res = await constructAdapterV2(
        getterHostV2 as PiHostV2,
        { ...getterV2Case.input, version: 2, policy: { ...getterV2Case.input.policy, version: 2 } },
        v1Ports,
      );
      assert.equal(getterHostV2Res.ok, false);
      if (!getterHostV2Res.ok) {
        assert.equal(getterHostV2Res.error.code, 'INPUT_INVALID');
      }
      assert.equal(hostV2GetterCalls, 0);

      let baselineGetterCalls = 0;
      const getterBaselineCase = makeMutableInput('session-r4-9-g3', originalBaselineDirV1);
      Object.defineProperty(getterBaselineCase.baseline, 'directory', {
        enumerable: true,
        configurable: true,
        get: () => {
          baselineGetterCalls += 1;
          return baselineGetterCalls === 1 ? originalBaselineDirV1 : mutatedBaselineDir;
        },
      });
      const getterBaselineRes = await constructAdapter(host, getterBaselineCase.input, v1Ports);
      assert.equal(getterBaselineRes.ok, false);
      if (!getterBaselineRes.ok) {
        assert.equal(getterBaselineRes.error.code, 'INPUT_INVALID');
        assert.equal(getterBaselineRes.error.path, '/candidate/baseline/directory');
      }
      assert.equal(baselineGetterCalls, 0);
    } finally {
      store.close();
      await setDirectoryTreeMode(runtimeDir, 0o755).catch(() => {});
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('R5-10: streamCopyVerifiedBlob binds staging, verification, fchmod, and link to one owned descriptor with zero pathname chmod calls', async () => {
  const dir = await mkdtemp(join(await realpath(tmpdir()), 'loopwright-pi-r5-10-'));
  try {
    const size = CAS_CHUNK_BYTES + 4096;
    const srcBlob = join(dir, 'src.blob');
    const created = await createStreamedFile(srcBlob, size, 0x5c, 0o400);
    const srcStat = await lstat(srcBlob);

    const chmodSpy = mock.method(fsPromises, 'chmod', () => {
      throw new Error('pathname chmod must not be called by streamCopyVerifiedBlob');
    });
    try {
      for (const targetMode of [0o400, 0o444, 0o555] as const) {
        const destPath = join(dir, `projected-${targetMode.toString(8)}.bin`);
        await streamCopyVerifiedBlob(
          srcBlob,
          destPath,
          { byteLength: size, sha256Hex: created.sha256Hex },
          targetMode,
        );
        const destStat = await lstat(destPath);
        assert.equal(destStat.isFile(), true);
        assert.equal(destStat.isSymbolicLink(), false);
        assert.equal(destStat.nlink, 1);
        assert.notEqual(destStat.ino, srcStat.ino);
        assert.equal(destStat.mode & 0o777, targetMode);
        assert.equal(createHash('sha256').update(await readFile(destPath)).digest('hex'), created.sha256Hex);
      }

      // Pre-existing EEXIST target keeps exact mode, inode, and content untouched.
      const existingPath = join(dir, 'existing-r5-10.bin');
      await writeFile(existingPath, 'keep-existing-pi-r5-10', { mode: 0o600 });
      const existingBefore = await lstat(existingPath);
      await assert.rejects(
        streamCopyVerifiedBlob(srcBlob, existingPath, { byteLength: size, sha256Hex: created.sha256Hex }, 0o444),
        err => err instanceof PiFailure && err.detail.code === 'RECOVERY_REQUIRED',
      );
      const existingAfter = await lstat(existingPath);
      assert.equal(existingAfter.ino, existingBefore.ino);
      assert.equal(existingAfter.mode & 0o777, existingBefore.mode & 0o777);
      assert.equal(await readFile(existingPath, 'utf8'), 'keep-existing-pi-r5-10');

      // Writable source blob is refused (sealed CAS blobs must be read-only).
      const writableSrc = join(dir, 'writable-src.blob');
      const writableCreated = await createStreamedFile(writableSrc, 512, 0x2a, 0o600);
      await assert.rejects(
        streamCopyVerifiedBlob(writableSrc, join(dir, 'from-writable.bin'), { byteLength: 512, sha256Hex: writableCreated.sha256Hex }, 0o444),
        err => err instanceof PiFailure && err.detail.code === 'RECOVERY_REQUIRED',
      );

      assert.equal(chmodSpy.mock.callCount(), 0);
      const remainingEntries = await readdir(dir);
      assert.equal(remainingEntries.some(name => name.startsWith('.lw-stage-')), false);
    } finally {
      chmodSpy.mock.restore();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
