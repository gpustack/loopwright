import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { admitTask, bindSubject, digestArtifact, type ArtifactManifest, type OverlayLimitsInput, type Result } from '@loopwright/core';
import { createLocalRun, type CheckpointRecord, type StateResult } from '@loopwright/state';
import { contract } from '../../core/test/fixtures.js';
import { canonical, digest } from '../src/boundary.js';
import { Candidate, materializeCandidateDirectory, setDirectoryTreeMode } from '../src/candidate.js';
import { captureBinding, captureCheckpoint } from '../src/capture.js';
import { decodePiCapture } from '../src/decode-capture.js';
import { PiFailure } from '../src/errors.js';
import { MAX_LIMITS } from '../src/policy.js';
import { prepareInput } from '../src/preflight.js';
import { PREAMBLE_IDENTITY } from '../src/resources.js';
import { rowBytes } from '../src/snapshot.js';
import type { PiHost, PiOpenInput } from '../src/types.js';
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

function makeOverlayLock(overlay?: OverlayLimitsInput) {
  const task = contract();
  task.spec.roles[0]!.model = 'claude-sonnet-5.5';
  task.spec.roles[0]!.thinking = 'xhigh';
  task.spec.roles[0]!.tools = ['read', 'write', 'delete'];
  task.spec.budgets.wallTimeMs = 60_000;
  task.spec.budgets.totalTokens = 1_000_000;
  task.spec.budgets.perCallOutputTokens = 1_024;
  if (overlay !== undefined) {
    (task.spec.budgets as unknown as { overlay?: OverlayLimitsInput }).overlay = overlay;
  }
  return coreGood(admitTask(task, { admissionId: 'admission-ov-1', runId: 'run-ov-1' }));
}

async function createOverlayWorkspace(options: {
  readonly overlay?: OverlayLimitsInput | undefined;
  readonly baselineCount?: number;
}) {
  const directory = await mkdtemp(join(await realpath(tmpdir()), 'loopwright-wide-overlay-'));
  const root = join(directory, 'candidate');
  const baseCount = options.baselineCount ?? 2;
  const baseFiles = Array.from({ length: baseCount }, (_, idx) => ({
    name: `packages/base-${String(idx).padStart(4, '0')}.ts`,
    content: `export const base = ${idx};\n`,
    mode: '100644' as const,
  }));
  const baselineEntries = baseFiles.map(file => {
    const bytes = Buffer.from(file.content);
    return {
      name: file.name,
      mode: file.mode,
      oid: createHash('sha1').update(`blob ${bytes.byteLength}\0`).update(bytes).digest('hex'),
      byteLength: bytes.byteLength,
    };
  });
  for (const file of baseFiles) {
    const target = join(root, file.name);
    await mkdir(join(target, '..'), { recursive: true, mode: 0o755 });
    await writeFile(target, file.content);
    await chmod(target, 0o444);
  }

  const baseInput = sessionInput();
  const lock = makeOverlayLock(options.overlay);
  const input: PiOpenInput = {
    ...baseInput,
    lock,
    policy: {
      ...baseInput.policy,
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
          baseTree: {
            objectFormat: 'sha1',
            commitOid: 'a'.repeat(40),
            treeOid: 'b'.repeat(40),
          },
          entries: [],
          deleted: [],
        },
      },
      baseRevision: lock.spec.contract.spec.target.baseRevision,
      sourceRevision: lock.spec.contract.spec.target.sourceRevision,
      artifacts: [],
      baseline: { directory: root, entries: baselineEntries },
    },
    resources: [],
    restore: null,
  };
  const candidate = new Candidate(root, input);
  return {
    directory,
    root,
    lock,
    input,
    candidate,
    cleanup: () => rm(directory, { recursive: true, force: true }),
  };
}

test('Candidate with budgets.overlay { maxFiles: 512, maxBytes: 16_777_216 } writes 512 files (> 4 MiB) cleanly and fails closed at 513 files or > 16 MiB', async () => {
  const f = await createOverlayWorkspace({
    overlay: { maxFiles: 512, maxBytes: 16_777_216 },
    baselineCount: 513,
  });
  try {
    // Write 512 new files, with first file > 4 MiB (5 MiB) to exceed default 4 MiB cap
    const fiveMiB = 'x'.repeat(5 * 1024 * 1024);
    const first = await f.candidate.prepareWrite('packages/gen-000.ts', fiveMiB);
    await f.candidate.commit(first, () => {});

    for (let i = 1; i < 512; i++) {
      const change = await f.candidate.prepareWrite(`packages/gen-${String(i).padStart(3, '0')}.ts`, `export const v = ${i};\n`);
      await f.candidate.commit(change, () => {});
    }

    const manifest = await f.candidate.manifest();
    assert.equal(manifest.spec.entries.length, 512);
    assert.ok(Buffer.byteLength(canonical(manifest)) > 32_768, '512-entry manifest exceeds legacy 32 KiB cap');

    // 513th file fails closed with OUTPUT_LIMIT
    await assert.rejects(
      f.candidate.prepareWrite('packages/gen-512.ts', 'overflow'),
      err => err instanceof PiFailure && err.detail.code === 'OUTPUT_LIMIT',
    );

    // Overwriting an existing overlay entry to exceed 16_777_216 total bytes fails closed with OUTPUT_LIMIT
    await assert.rejects(
      f.candidate.prepareWrite('packages/gen-001.ts', 'z'.repeat(12 * 1024 * 1024)),
      err => err instanceof PiFailure && err.detail.code === 'OUTPUT_LIMIT',
    );

    // Deleting 512 baseline files succeeds, 513th fails closed with OUTPUT_LIMIT
    for (let i = 0; i < 512; i++) {
      const del = await f.candidate.prepareDelete(`packages/base-${String(i).padStart(4, '0')}.ts`);
      await f.candidate.commit(del, () => {});
    }
    await assert.rejects(
      f.candidate.prepareDelete('packages/base-0512.ts'),
      err => err instanceof PiFailure && err.detail.code === 'OUTPUT_LIMIT',
    );
  } finally {
    await f.cleanup();
  }
});

test('prepareInput, captureCheckpoint, and decodePiCapture support 512-file / >4 MiB overlay and fail closed when limits are exceeded', async () => {
  const f = await createOverlayWorkspace({
    overlay: { maxFiles: 512, maxBytes: 16_777_216 },
    baselineCount: 2,
  });
  try {
    // Stage 512 overlay files (total > 4 MiB)
    const entries = [];
    const artifacts: { name: string; bytes: Uint8Array }[] = [];
    for (let i = 0; i < 512; i++) {
      const name = `packages/ov-${String(i).padStart(3, '0')}.ts`;
      const content = i === 0 ? 'A'.repeat(4_500_000) : `export const idx = ${i};\n`;
      const bytes = Buffer.from(content, 'utf8');
      entries.push(coreGood(digestArtifact(name, bytes)));
      artifacts.push({ name, bytes });
    }
    const wideManifest: ArtifactManifest = {
      apiVersion: 'loopwright.dev/v1alpha1',
      kind: 'ArtifactManifest',
      metadata: { id: 'candidate' },
      spec: {
        baseTree: {
          objectFormat: 'sha1',
          commitOid: 'a'.repeat(40),
          treeOid: 'b'.repeat(40),
        },
        entries,
        deleted: [],
      },
    };

    const wideInput: PiOpenInput = {
      ...f.input,
      candidate: {
        ...f.input.candidate,
        manifest: wideManifest,
        artifacts,
      },
    };

    // 1. prepareInput accepts the 512-file / >4 MiB overlay
    const prepared = prepareInput(wideInput);
    assert.equal(prepared.candidate.manifest.spec.entries.length, 512);

    // 2. prepareInput rejects the same 512-file overlay when budgets.overlay is unset (default 128 files / 4 MiB)
    const defaultLock = makeOverlayLock(undefined);
    assert.throws(
      () => prepareInput({ ...wideInput, lock: defaultLock }),
      err => err instanceof PiFailure && (err.detail.code === 'INPUT_INVALID' || err.detail.code === 'OUTPUT_LIMIT'),
    );

    // 3. captureCheckpoint + decodePiCapture round-trip the 512-file / >4 MiB overlay cleanly
    const runtimeDir = join(f.directory, 'runtime');
    const artifactsDir = join(f.directory, 'artifacts');
    const candidateDir = join(runtimeDir, 'sdk-session-1', 'candidate');
    await mkdir(join(runtimeDir, 'sdk-session-1'), { recursive: true, mode: 0o700 });
    await mkdir(artifactsDir, { recursive: true, mode: 0o700 });
    await materializeCandidateDirectory(candidateDir, prepared);
    const daemon = daemonFixture(f.directory);
    const store = stateGood(createLocalRun({
      directory: join(f.directory, 'state'),
      storeId: 'store-ov-1',
      lock: prepared.lock,
      policy: { version: 1, leaseMs: 60_000, cost: 'observe_only' },
      binding: {
        coreApiVersion: 'loopwright.dev/v1alpha1',
        hostVersion: 'test',
        adapters: [{ id: 'pi', version: '0.0.0' }],
        resourceVersion: prepared.policy.resourceVersion,
        clockEpoch: 'boot-ov-1',
      },
    }));

    try {
      const view = stateGood(store.inspect());
      const claimed = stateGood(store.claim({
        ownerId: 'owner-ov-1',
        expectedGeneration: view.owner.generation,
        expectedRevision: view.revision,
        mode: 'active',
      }));

      // Intercept writeCheckpoint in test harness since @loopwright/state checkpoint wide-overlay persistence lands in sibling T2.
      let capturedRecord: CheckpointRecord | undefined;
      const wrappedStore: PiHost['store'] = new Proxy(store, {
        get(target, prop, receiver) {
          if (prop === 'writeCheckpoint') {
            return (_authority: unknown, input: { checkpointId: string; candidateManifest: ArtifactManifest; workspace: typeof wideManifest.spec.entries[number]; privateSession: typeof wideManifest.spec.entries[number]; additionalArtifacts: readonly typeof wideManifest.spec.entries[number][] }) => {
              const now = stateGood(target.inspect());
              const subject = coreGood(bindSubject(prepared.lock, input.candidateManifest, { overlay: { maxFiles: 512, maxBytes: 16_777_216 } }));
              const nextRecord: CheckpointRecord = {
                sequence: 1,
                checkpointId: input.checkpointId,
                inputDigest: digest(Buffer.from('test-checkpoint-input')),
                subject,
                workspace: input.workspace,
                privateSession: input.privateSession,
                additionalArtifacts: input.additionalArtifacts,
                storeId: now.storeId,
                runId: now.runId,
                lockHash: now.lockHash,
                binding: now.binding,
                formatVersion: 1,
                generation: now.owner.generation,
                publishedRevision: now.revision + 1,
                startedAtMs: 0,
                deadlineMs: 60_000,
                clockBasis: now.clock.basis,
                clockSample: now.clock.sampledNow,
                ledger: now.ledger,
                ledgerRoot: digest(Buffer.from('test-ledger-root')),
                counts: { ...now.counts, checkpoints: 1 },
              };
              capturedRecord = nextRecord;
              return { ok: true, value: { created: true, record: nextRecord } };
            };
          }
          const value = Reflect.get(target, prop, receiver);
          return typeof value === 'function' ? value.bind(target) : value;
        },
      });

      const host: PiHost = {
        store: wrappedStore,
        authority: claimed.authority,
        directory: runtimeDir,
        artifactsDirectory: artifactsDir,
        dockerExecutable: daemon.dockerExecutable,
        dockerSocket: daemon.dockerSocket,
        runtime: prepared.policy.runtime,
        resolveCredential: async () => ({ bearerToken: 'SYNTHETIC_HOST_SECRET' }),
      };

      const candidate = new Candidate(candidateDir, prepared);
      await candidate.captureBaselineStats();
      const timestamp = '2026-11-19T00:00:00.000Z';
      const capture = await captureCheckpoint(
        host,
        prepared,
        candidate,
        {
          capture: async sink => {
            await sink(rowBytes({ type: 'session', version: 3, id: 'native-wide-1', cwd: '/workspace/candidate', timestamp }));
          },
        },
        'checkpoint-wide-1',
        1,
        new AbortController().signal,
      );
      assert.equal(capture.candidate.spec.entries.length, 512);
      if (!capturedRecord) throw new Error('Expected captured checkpoint record');
      const baseRecord: CheckpointRecord = capturedRecord;

      const workspaceBytes = await readFile(join(artifactsDir, capture.workspace.name));
      const sessionBytes = await readFile(join(artifactsDir, capture.session.name));

      const decoded = await decodePiCapture({
        version: 1,
        lock: prepared.lock,
        policy: prepared.policy,
        checkpoint: baseRecord,
        sessionId: prepared.sessionId,
        roleId: prepared.roleId,
        stepId: prepared.stepId,
        workspace: { ref: capture.workspace, bytes: workspaceBytes },
        session: { ref: capture.session, bytes: sessionBytes },
        command: null,
        artifactsDirectory: artifactsDir,
      });
      assert.equal(decoded.ok, true, JSON.stringify(decoded));
      if (!decoded.ok) throw new Error('decodePiCapture failed');
      assert.equal(decoded.value.candidate.spec.entries.length, 512);
      assert.equal(decoded.value.artifacts.length, 512);
      assert.equal(decoded.value.artifacts[0]!.bytes.byteLength, 4_500_000);

      // 4. Decoding the same 512-file (>4 MiB) overlay against a tighter lock (maxBytes: 4_194_304) fails closed with OUTPUT_LIMIT
      const tightLock = makeOverlayLock({ maxFiles: 512, maxBytes: 4_194_304 });
      const tightSubject = coreGood(bindSubject(tightLock, capture.candidate, { overlay: { maxFiles: 512, maxBytes: 4_194_304 } }));
      const tightBinding = {
        ...captureBinding(host, { ...prepared, lock: tightLock }, capture.candidate, 'checkpoint-tight-1', 1),
        lockHash: tightLock.spec.lockHash,
      };
      const tightSessionBytes = Buffer.concat([
        rowBytes({ type: 'session_snapshot', version: 1, binding: tightBinding }),
        rowBytes({ type: 'session', version: 3, id: 'native-wide-1', cwd: '/workspace/candidate', timestamp }),
      ]);
      const tightWorkspaceRows = workspaceBytes.subarray(workspaceBytes.indexOf(10) + 1);
      const tightWorkspaceBytes = Buffer.concat([
        rowBytes({ type: 'workspace_snapshot', version: 1, binding: tightBinding, manifest: capture.candidate }),
        tightWorkspaceRows,
      ]);
      const tightWsRef = coreGood(digestArtifact('pi-checkpoints/checkpoint-tight-1.workspace.ndjson', tightWorkspaceBytes));
      const tightSessRef = coreGood(digestArtifact('pi-checkpoints/checkpoint-tight-1.session.ndjson', tightSessionBytes));
      const tightRecord: CheckpointRecord = {
        ...baseRecord,
        checkpointId: 'checkpoint-tight-1',
        runId: tightLock.spec.runId,
        lockHash: tightLock.spec.lockHash,
        subject: tightSubject,
        workspace: tightWsRef,
        privateSession: tightSessRef,
      };
      const tightDecoded = await decodePiCapture({
        version: 1,
        lock: tightLock,
        policy: prepared.policy,
        checkpoint: tightRecord,
        sessionId: prepared.sessionId,
        roleId: prepared.roleId,
        stepId: prepared.stepId,
        workspace: { ref: tightWsRef, bytes: tightWorkspaceBytes },
        session: { ref: tightSessRef, bytes: tightSessionBytes },
        command: null,
      });
      assert.equal(tightDecoded.ok, false);
      if (!tightDecoded.ok) {
        assert.equal(tightDecoded.error.code, 'OUTPUT_LIMIT');
      }

      // 5. Decoding a 512-file overlay against default unset budgets.overlay (128 maxFiles) fails closed with RECOVERY_REQUIRED
      const defaultSubject = structuredClone({ ...tightSubject, lockHash: defaultLock.spec.lockHash, contractHash: defaultLock.spec.contractHash });
      const defaultBinding = structuredClone({ ...tightBinding, checkpointId: 'checkpoint-default-1', lockHash: defaultLock.spec.lockHash });
      const defaultSessionBytes = Buffer.concat([
        rowBytes({ type: 'session_snapshot', version: 1, binding: defaultBinding }),
        rowBytes({ type: 'session', version: 3, id: 'native-wide-1', cwd: '/workspace/candidate', timestamp }),
      ]);
      const defaultWorkspaceBytes = Buffer.concat([
        rowBytes({ type: 'workspace_snapshot', version: 1, binding: defaultBinding, manifest: capture.candidate }),
        tightWorkspaceRows,
      ]);
      const defaultWsRef = coreGood(digestArtifact('pi-checkpoints/checkpoint-default-1.workspace.ndjson', defaultWorkspaceBytes));
      const defaultSessRef = coreGood(digestArtifact('pi-checkpoints/checkpoint-default-1.session.ndjson', defaultSessionBytes));
      const defaultRecord: CheckpointRecord = {
        ...structuredClone(baseRecord),
        checkpointId: 'checkpoint-default-1',
        runId: defaultLock.spec.runId,
        lockHash: structuredClone(defaultLock.spec.lockHash),
        subject: defaultSubject,
        workspace: defaultWsRef,
        privateSession: defaultSessRef,
      };
      const defaultDecoded = await decodePiCapture({
        version: 1,
        lock: defaultLock,
        policy: prepared.policy,
        checkpoint: defaultRecord,
        sessionId: prepared.sessionId,
        roleId: prepared.roleId,
        stepId: prepared.stepId,
        workspace: { ref: defaultWsRef, bytes: defaultWorkspaceBytes },
        session: { ref: defaultSessRef, bytes: defaultSessionBytes },
        command: null,
      });
      assert.equal(defaultDecoded.ok, false);
      if (!defaultDecoded.ok) {
        assert.equal(defaultDecoded.error.code, 'RECOVERY_REQUIRED');
      }
    } finally {
      store.close();
      await setDirectoryTreeMode(candidateDir, 0o755).catch(() => {});
    }
  } finally {
    await f.cleanup();
  }
});

test('Candidate with unset budgets.overlay preserves default 128-file and 4 MiB caps', async () => {
  const f = await createOverlayWorkspace({ overlay: undefined, baselineCount: 2 });
  try {
    await assert.rejects(
      f.candidate.prepareWrite('packages/too-big.ts', 'a'.repeat(4_194_305)),
      err => err instanceof PiFailure && err.detail.code === 'OUTPUT_LIMIT',
    );
    for (let i = 0; i < 128; i++) {
      const c = await f.candidate.prepareWrite(`packages/d-${String(i).padStart(3, '0')}.ts`, 'ok');
      await f.candidate.commit(c, () => {});
    }
    await assert.rejects(
      f.candidate.prepareWrite('packages/d-128.ts', 'overflow'),
      err => err instanceof PiFailure && err.detail.code === 'OUTPUT_LIMIT',
    );
  } finally {
    await f.cleanup();
  }
});

test('Candidate and captureCheckpoint enforce Math.min(overlay.maxFiles, policy.limits.candidateEntries) with OUTPUT_LIMIT', async () => {
  const f = await createOverlayWorkspace({
    overlay: { maxFiles: 512, maxBytes: 16_777_216 },
    baselineCount: 2,
  });
  try {
    const tightPolicyInput: PiOpenInput = {
      ...f.input,
      policy: {
        ...f.input.policy,
        limits: {
          ...f.input.policy.limits,
          candidateEntries: 10,
        },
      },
    };
    const tightCandidate = new Candidate(f.root, tightPolicyInput);
    for (let i = 0; i < 10; i++) {
      const c = await tightCandidate.prepareWrite(`packages/cap-${String(i).padStart(2, '0')}.ts`, `export const n = ${i};\n`);
      await tightCandidate.commit(c, () => {});
    }
    const manifest = await tightCandidate.manifest();
    assert.equal(manifest.spec.entries.length, 10);

    // 11th entry exceeds policy.limits.candidateEntries (10 < 512) and fails closed with OUTPUT_LIMIT
    await assert.rejects(
      tightCandidate.prepareWrite('packages/cap-10.ts', 'overflow'),
      err => err instanceof PiFailure && err.detail.code === 'OUTPUT_LIMIT',
    );

    // captureCheckpoint also fails closed with OUTPUT_LIMIT if manifest.spec.entries.length > policy.limits.candidateEntries
    const runtimeDir = join(f.directory, 'runtime-tight');
    const artifactsDir = join(f.directory, 'artifacts-tight');
    await mkdir(runtimeDir, { recursive: true, mode: 0o700 });
    await mkdir(artifactsDir, { recursive: true, mode: 0o700 });
    const daemon = daemonFixture(f.directory);
    const store = stateGood(createLocalRun({
      directory: join(f.directory, 'state-tight'),
      storeId: 'store-tight-cap',
      lock: tightPolicyInput.lock,
      policy: { version: 1, leaseMs: 60_000, cost: 'observe_only' },
      binding: {
        coreApiVersion: 'loopwright.dev/v1alpha1',
        hostVersion: 'test',
        adapters: [{ id: 'pi', version: '0.0.0' }],
        resourceVersion: tightPolicyInput.policy.resourceVersion,
        clockEpoch: 'boot-tight-cap',
      },
    }));
    try {
      const view = stateGood(store.inspect());
      const claimed = stateGood(store.claim({
        ownerId: 'owner-tight-cap',
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
        runtime: tightPolicyInput.policy.runtime,
        resolveCredential: async () => ({ bearerToken: 'SYNTHETIC_HOST_SECRET' }),
      };
      const stricterCaptureInput: PiOpenInput = {
        ...tightPolicyInput,
        policy: {
          ...tightPolicyInput.policy,
          limits: {
            ...tightPolicyInput.policy.limits,
            candidateEntries: 5,
          },
        },
      };
      await assert.rejects(
        captureCheckpoint(
          host,
          stricterCaptureInput,
          tightCandidate,
          { capture: async () => {} },
          'cp-tight-cap-1',
          1,
          new AbortController().signal,
        ),
        err => err instanceof PiFailure && err.detail.code === 'OUTPUT_LIMIT',
      );
    } finally {
      store.close();
    }
  } finally {
    await f.cleanup();
  }
});
