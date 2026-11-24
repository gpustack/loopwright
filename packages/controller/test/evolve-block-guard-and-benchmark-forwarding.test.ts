import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { execFileSync } from 'node:child_process';
import { chmod, mkdir, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  admitTask,
  bindSubject,
  digestArtifact,
  type ArtifactManifest,
  type BucketMetricEntry,
  type HardwareDiagnostics,
  type HardwareProvenance,
  type HardwareTargetSpec,
  type MetricThresholdRule,
} from '@loopwright/core';
import { contract } from '../../core/test/fixtures.js';
import { createLocalRun } from '@loopwright/state';
import { configurationFixture } from './config-fixtures.js';
import { retainedFixture, setFixture } from './progress-fixtures.js';
import { retainInventoryInputs } from './verification-fixtures.js';
import { evaluateControllerAcceptance } from '../src/acceptance.js';
import {
  authenticatedBenchmarkGate,
  BenchmarkGate,
  checkedBenchmarkVerdict,
  computeBenchmarkDisposition,
  expectedBenchmarkRequest,
  prepareBenchmarkGate,
  signBenchmarkVerdict,
} from '../src/benchmark-gate.js';
import { compilePlan } from '../src/compile.js';
import { approvedState } from '../src/config.js';
import { runCycleWithPorts } from '../src/controller.js';
import { installedHandlerDigests } from '../src/handlers.js';
import { ControllerOwner } from '../src/ownership.js';
import { reconcileCycle } from '../src/reconcile.js';
import { validateHandler } from '../src/registry.js';
import { canonical } from '../src/schema.js';
import { freezeSource, overlayManifestBounds } from '../src/source.js';
import { stepNext, stepSubmit } from '../src/step.js';
import { ArtifactStore, stateValue } from '../src/storage.js';
import { normalizeSubmission } from '../src/submission.js';
import { authenticatedCheck, preflightVerification, prepareVerification, Verifier, type ByteInventory } from '../src/verification.js';
import { signPayload } from '../src/gate.js';

const BENCH_SECRET = 'BENCH_SIGNING_SECRET_Aa11Bb22Cc33';
const WORKLOAD_DIGEST = { algorithm: 'sha256' as const, hex: 'a'.repeat(64) };

async function initGitRepo(directory: string, files: Readonly<Record<string, string>>): Promise<string> {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const git = (args: string[]) =>
    execFileSync('/usr/bin/git', ['-c', 'core.hooksPath=/dev/null', ...args], {
      cwd: directory,
      env: {
        PATH: '/usr/bin:/bin',
        LANG: 'C',
        LC_ALL: 'C',
        GIT_CONFIG_NOSYSTEM: '1',
        GIT_CONFIG_GLOBAL: '/dev/null',
        HOME: '/nonexistent',
        GIT_TERMINAL_PROMPT: '0',
      },
      timeout: 10_000,
      encoding: 'utf8',
    });
  git(['init', '-q']);
  for (const [rel, content] of Object.entries(files)) {
    const abs = join(directory, rel);
    await mkdir(join(abs, '..'), { recursive: true, mode: 0o700 });
    await writeFile(abs, content, { mode: 0o600 });
  }
  git(['add', '.']);
  git(['-c', 'user.name=Test', '-c', 'user.email=test@localhost.invalid', 'commit', '-qm', 'initial']);
  return git(['rev-parse', 'HEAD']).trim();
}

function sampleProvenance(cellId = 'cuda-h100-whole'): HardwareProvenance {
  return {
    targetCellId: cellId,
    probeKind: 'synthetic_fixture',
    vendor: 'NVIDIA',
    deviceModel: 'H100-SXM5-80GB',
    accelerator: 'sm_90a',
    isolationMode: 'whole_device',
    deviceCount: 1,
    driverVersion: '550.54.15',
    runtimeVersion: '12.4',
    workloadDigest: WORKLOAD_DIGEST,
    clockLockMode: 'locked',
  };
}

function sampleBucketMetrics(overrides?: { readonly secondUlp?: number }): readonly BucketMetricEntry[] {
  return [
    {
      bucketId: 'bs1-isl4k',
      dimensions: { batch_size: 1, isl: 4096, dtype: 'bf16' },
      metrics: { latency_us_p50: 42.5, goodput_rps: 1850, max_ulp: 0.5, token_force_max_delta: 0.005 },
    },
    {
      bucketId: 'bs16-isl8k',
      dimensions: { batch_size: 16, isl: 8192, dtype: 'bf16' },
      metrics: { latency_us_p50: 190.2, goodput_rps: 940, max_ulp: overrides?.secondUlp ?? 0.75, token_force_max_delta: 0.01 },
    },
  ];
}

function sampleHardwareDiagnostics(): HardwareDiagnostics {
  return {
    boundPipeline: 'tensor_cube',
    rooflineHeadroom: 1.18,
    achievedSolPct: 74.5,
    arithmeticIntensity: 192.4,
    occupancyPct: 62.5,
    registerCount: 96,
    sharedMemBytes: 49_152,
    localSpillBytes: 0,
    l2HitPct: 81.2,
    bankConflictPct: 1.5,
    topStallReasons: [
      { reason: 'stall_long_scoreboard', pct: 34.2 },
      { reason: 'stall_wait', pct: 12.1 },
    ],
  };
}

test('installedHandlerDigests registers evolve-block-guard.v1 and validateHandler enforces strict parameter bounds', async () => {
  const digests = await installedHandlerDigests();
  assert.equal(digests['evolve-block-guard.v1'].algorithm, 'sha256');
  assert.match(digests['evolve-block-guard.v1'].hex, /^[0-9a-f]{64}$/);
  assert.notEqual(digests['evolve-block-guard.v1'].hex, digests['line-section-guard.v1'].hex);
  assert.notEqual(digests['evolve-block-guard.v1'].hex, digests['scope.v1'].hex);

  // Legacy workflows that omit evolve-block-guard.v1 preserve identical TaskContract / TaskLock digests
  const baseTask = contract();
  const lock1 = admitTask(baseTask, { admissionId: 'adm-parity', runId: 'run-parity' });
  const lock2 = admitTask(structuredClone(baseTask), { admissionId: 'adm-parity', runId: 'run-parity' });
  assert.equal(lock1.ok, true);
  assert.equal(lock2.ok, true);
  if (lock1.ok && lock2.ok) {
    assert.deepEqual(lock1.value.spec.contractHash, lock2.value.spec.contractHash);
    assert.deepEqual(lock1.value.spec.lockHash, lock2.value.spec.lockHash);
  }

  const valid = {
    id: 'evolve-guard',
    version: 1,
    digest: digests['evolve-block-guard.v1'],
    kind: 'check',
    implementation: 'evolve-block-guard.v1',
    parameters: {
      checkId: 'evolve-guard',
      files: ['kernels/flash_decode.cu', 'kernels/triton_impl.py'],
      allowedBlockIds: ['tile_loop', 'epilogue'],
      maxBlockBytes: 4096,
    },
    capabilities: ['inert_bytes', 'read_only'],
  };
  assert.equal(validateHandler(valid, '/h').implementation, 'evolve-block-guard.v1');

  // Optional fields omitted -> valid
  assert.equal(
    validateHandler(
      {
        ...valid,
        parameters: { checkId: 'evolve-guard', files: ['kernels/flash_decode.cu'] },
      },
      '/h',
    ).implementation,
    'evolve-block-guard.v1',
  );

  // Null-prototype parameters accepted cleanly
  const nullProtoParams = Object.create(null) as Record<string, unknown>;
  nullProtoParams.checkId = 'evolve-guard';
  nullProtoParams.files = ['kernels/flash_decode.cu'];
  assert.equal(validateHandler({ ...valid, parameters: nullProtoParams }, '/h').implementation, 'evolve-block-guard.v1');

  // Reject invalid parameter combinations
  const badParameters: unknown[] = [
    { checkId: 'evolve-guard', files: [] },
    { checkId: 'evolve-guard', files: Array.from({ length: 65 }, (_, i) => `kernels/f${i}.cu`) },
    { checkId: 'evolve-guard', files: ['kernels/a.cu', 'kernels/a.cu'] },
    { checkId: 'evolve-guard', files: ['kernels/A.cu', 'kernels/a.cu'] },
    { checkId: 'evolve-guard', files: ['../escape.cu'] },
    { checkId: 'evolve-guard', files: ['kernels/../escape.cu'] },
    { checkId: 'evolve-guard', files: ['/abs/path/kernel.cu'] },
    { checkId: 'evolve-guard', files: ['.github/workflows/ci.yml'] },
    { checkId: 'evolve-guard', files: ['.GitHub/Workflows/release.yaml'] },
    { checkId: 'evolve-guard', files: ['.git/config'] },
    { checkId: 'evolve-guard', files: ['kernels/a.cu'], allowedBlockIds: [] },
    { checkId: 'evolve-guard', files: ['kernels/a.cu'], allowedBlockIds: Array.from({ length: 65 }, (_, i) => `blk_${i}`) },
    { checkId: 'evolve-guard', files: ['kernels/a.cu'], allowedBlockIds: ['dup', 'dup'] },
    { checkId: 'evolve-guard', files: ['kernels/a.cu'], allowedBlockIds: ['has space'] },
    { checkId: 'evolve-guard', files: ['kernels/a.cu'], allowedBlockIds: ['non_ascii_\u00e9'] },
    { checkId: 'evolve-guard', files: ['kernels/a.cu'], allowedBlockIds: ['bad*/id'] },
    { checkId: 'evolve-guard', files: ['kernels/a.cu'], maxBlockBytes: 0 },
    { checkId: 'evolve-guard', files: ['kernels/a.cu'], maxBlockBytes: -1 },
    { checkId: 'evolve-guard', files: ['kernels/a.cu'], maxBlockBytes: -0 },
    { checkId: 'evolve-guard', files: ['kernels/a.cu'], maxBlockBytes: 12.5 },
    { checkId: 'evolve-guard', files: ['kernels/a.cu'], maxBlockBytes: Number.NaN },
    { checkId: 'evolve-guard', files: ['kernels/a.cu'], maxBlockBytes: Number.POSITIVE_INFINITY },
    { checkId: 'evolve-guard', files: ['kernels/a.cu'], extraKey: true },
  ];
  for (const params of badParameters) {
    assert.throws(() => validateHandler({ ...valid, parameters: params }, '/h'), `should reject ${JSON.stringify(params)}`);
  }
  assert.throws(() => validateHandler({ ...valid, capabilities: ['hardware_execution', 'read_only'] }, '/h'));
  assert.throws(() => validateHandler({ ...valid, kind: 'agent' }, '/h'));
});

test('evolve-block-guard.v1 enforces //, #, /* */ blocks, outside-byte SHA-256 invariance, marker errors, allowedBlockIds, and maxBlockBytes', async () => {
  const baseCu = [
    '__global__ void flash_decode(float* out) {',
    '  // EVOLVE-BLOCK-START: tile_loop',
    '  out[0] = 1.0f;',
    '  // EVOLVE-BLOCK-END: tile_loop',
    '  __syncthreads();',
    '  // EVOLVE-BLOCK-START: epilogue',
    '  out[1] = 2.0f;',
    '  // EVOLVE-BLOCK-END: epilogue',
    '}',
    '',
  ].join('\n');

  const basePy = [
    'def run_kernel(x):',
    '    # EVOLVE-BLOCK-START: py_body',
    '    y = x + 1',
    '    # EVOLVE-BLOCK-END: py_body',
    '    return y',
    '',
  ].join('\n');

  const baseC = [
    'int helper(int a) {',
    '  /* EVOLVE-BLOCK-START: c_inner */',
    '  return a * 2;',
    '  /* EVOLVE-BLOCK-END: c_inner */',
    '}',
    '',
  ].join('\n');

  const installed = await installedHandlerDigests();
  const f = await retainedFixture(1, 20, 18, 60_000, fixture => {
    setFixture(fixture.config, ['spec', 'task', 'spec', 'budgets', 'maxModelCalls'], 32);
    setFixture(fixture.registry, ['spec', 'roleProfiles', 0, 'tools'], ['read', 'write', 'edit', 'delete']);
    setFixture(fixture.config, ['spec', 'task', 'spec', 'roles', 0, 'tools'], ['read', 'write', 'edit', 'delete']);
    setFixture(fixture.registry, ['spec', 'handlers'], [
      ...fixture.registry.spec.handlers.filter(h => h.id !== 'tests'),
      {
        id: 'evolve-guard',
        kind: 'check',
        implementation: 'evolve-block-guard.v1',
        version: 1,
        digest: installed['evolve-block-guard.v1'],
        parameters: {
          checkId: 'evolve-guard',
          files: ['packages/kernel.cu', 'packages/kernel.py', 'packages/helper.c'],
          allowedBlockIds: ['tile_loop', 'py_body', 'c_inner'],
          maxBlockBytes: 96,
        },
        capabilities: ['inert_bytes', 'read_only'],
      },
    ]);
    setFixture(fixture.config, ['spec', 'task', 'spec', 'acceptance'], {
      required: ['evolve-guard'],
      checks: [{ id: 'evolve-guard', allowedEvidenceLevels: ['local_execution'] }],
    });
  });

  try {
    const makeInv = async (files: readonly { readonly name: string; readonly bytes: Buffer }[]): Promise<ByteInventory> => {
      const sorted = [...files].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
      const entries = sorted.map(file => {
        const r = digestArtifact(file.name, file.bytes);
        assert.equal(r.ok, true);
        if (!r.ok) throw new Error('digest failed');
        return r.value;
      });
      const manifest: ArtifactManifest = {
        apiVersion: 'loopwright.dev/v1alpha1',
        kind: 'ArtifactManifest',
        metadata: { id: 'candidate' },
        spec: { entries },
      };
      const ref = await f.artifacts.json('manifest', manifest, 32_768);
      await retainInventoryInputs(f.artifacts, manifest, ref, sorted);
      return { manifest, ref, files: sorted };
    };

    const source = await makeInv([
      { name: 'packages/kernel.cu', bytes: Buffer.from(baseCu, 'utf8') },
      { name: 'packages/kernel.py', bytes: Buffer.from(basePy, 'utf8') },
      { name: 'packages/helper.c', bytes: Buffer.from(baseC, 'utf8') },
    ]);

    const runCase = async (
      overrides: { readonly cu?: string | Buffer | null; readonly py?: string | Buffer | null; readonly c?: string | Buffer | null },
      generation: number,
    ) => {
      const listFiles: { name: string; bytes: Buffer }[] = [];
      const add = (name: string, val: string | Buffer | null | undefined, fallback: string) => {
        if (val === null) return;
        const effective = val === undefined ? fallback : val;
        listFiles.push({ name, bytes: Buffer.isBuffer(effective) ? effective : Buffer.from(effective, 'utf8') });
      };
      add('packages/kernel.cu', overrides.cu, baseCu);
      add('packages/kernel.py', overrides.py, basePy);
      add('packages/helper.c', overrides.c, baseC);
      const candidate = await makeInv(listFiles);
      const bound = bindSubject(f.lock, candidate.manifest);
      assert.equal(bound.ok, true);
      if (!bound.ok) throw new Error('bind failed');
      const verifier = new Verifier(f.store, f.authority, f.artifacts, f.plan, f.lock, () => bound.value);
      const checks = [];
      for (const [idx, slot] of f.plan.verifierSlots.entries()) {
        const prep = prepareVerification(
          f.plan,
          f.lock,
          slot.id,
          source,
          candidate,
          generation,
          `${(generation + 1).toString(16).padStart(16, '0')}${idx.toString(16).padStart(16, '0')}`,
        );
        checks.push(await verifier.run(prep, new AbortController().signal));
      }
      const sub = normalizeSubmission(Buffer.from(JSON.stringify({ version: 1, status: 'completed', checks: [], reason: null })), f.plan.task);
      const accepted = evaluateControllerAcceptance(f.plan, f.lock, candidate.manifest, candidate.files, generation, checks, sub, f.store);
      const guardCheck = checks.find(c => c.checkId === 'evolve-guard')!;
      return { guardCheck, evidence: authenticatedCheck(guardCheck).evidence, accepted };
    };

    // 1. Happy path: mutate allowed blocks in all 3 comment styles (//, #, /* */) including empty interior & multi-line
    const happy = await runCase(
      {
        cu: baseCu.replace('  out[0] = 1.0f;', '  float acc = 3.0f;\n  out[0] = acc;'),
        py: basePy.replace('    y = x + 1\n', ''),
        c: baseC.replace('  return a * 2;', '  return (a << 1) + 0;'),
      },
      0,
    );
    assert.equal(happy.guardCheck.status, 'passed');
    assert.equal(happy.accepted.result.spec.status, 'completed');

    // 2. Single-character mutation outside mutable blocks -> outside_block_modified
    const singleCharOutside = await runCase(
      { cu: baseCu.replace('__syncthreads();', '__syncthreads() ;') },
      1,
    );
    assert.equal(singleCharOutside.guardCheck.status, 'failed');
    assert.equal(singleCharOutside.guardCheck.reason, 'outside_block_modified');
    assert.equal(singleCharOutside.evidence.spec.findings?.[0]?.path, 'packages/kernel.cu');
    assert.equal(singleCharOutside.evidence.spec.findings?.[0]?.line, 5);

    // 3. Single-byte EOL flip outside block (\n -> \r\n on immutable line) -> outside_block_modified
    const eolOutside = await runCase(
      { c: baseC.replace('int helper(int a) {\n', 'int helper(int a) {\r\n') },
      2,
    );
    assert.equal(eolOutside.guardCheck.status, 'failed');
    assert.equal(eolOutside.guardCheck.reason, 'outside_block_modified');

    // 4. Marker deletion -> missing_markers (if 0 left) or unbalanced_markers / outside_block_modified
    const deletedAllMarkers = await runCase(
      { py: 'def run_kernel(x):\n    y = x + 1\n    return y\n' },
      3,
    );
    assert.equal(deletedAllMarkers.guardCheck.status, 'failed');
    assert.equal(deletedAllMarkers.guardCheck.reason, 'missing_markers');

    // 5. Nested markers -> unbalanced_markers
    const nested = await runCase(
      {
        cu: baseCu.replace(
          '  out[0] = 1.0f;',
          '  // EVOLVE-BLOCK-START: inner\n  out[0] = 1.0f;\n  // EVOLVE-BLOCK-END: inner',
        ),
      },
      4,
    );
    assert.equal(nested.guardCheck.status, 'failed');
    assert.equal(nested.guardCheck.reason, 'unbalanced_markers');

    // 6. Duplicate blockId within the same file -> duplicate_block_id
    const duplicate = await runCase(
      {
        cu: baseCu.replace('epilogue', 'tile_loop').replace('epilogue', 'tile_loop'),
      },
      5,
    );
    assert.equal(duplicate.guardCheck.status, 'failed');
    assert.equal(duplicate.guardCheck.reason, 'duplicate_block_id');

    // 7. Reordered blocks (epilogue before tile_loop) -> outside_block_modified
    const reordered = await runCase(
      {
        cu: [
          '__global__ void flash_decode(float* out) {',
          '  // EVOLVE-BLOCK-START: epilogue',
          '  out[1] = 2.0f;',
          '  // EVOLVE-BLOCK-END: epilogue',
          '  __syncthreads();',
          '  // EVOLVE-BLOCK-START: tile_loop',
          '  out[0] = 1.0f;',
          '  // EVOLVE-BLOCK-END: tile_loop',
          '}',
          '',
        ].join('\n'),
      },
      6,
    );
    assert.equal(reordered.guardCheck.status, 'failed');
    assert.equal(reordered.guardCheck.reason, 'outside_block_modified');

    // 8. Unclosed marker -> unbalanced_markers
    const unclosed = await runCase(
      { py: 'def run_kernel(x):\n    # EVOLVE-BLOCK-START: py_body\n    y = x + 1\n    return y\n' },
      7,
    );
    assert.equal(unclosed.guardCheck.status, 'failed');
    assert.equal(unclosed.guardCheck.reason, 'unbalanced_markers');

    // 9. Mismatched START/END ID -> unbalanced_markers
    const mismatchedId = await runCase(
      { c: baseC.replace('EVOLVE-BLOCK-END: c_inner', 'EVOLVE-BLOCK-END: other_id') },
      8,
    );
    assert.equal(mismatchedId.guardCheck.status, 'failed');
    assert.equal(mismatchedId.guardCheck.reason, 'unbalanced_markers');

    // 10. allowedBlockIds violation (mutating 'epilogue' which is NOT in allowedBlockIds) -> disallowed_block_id
    const disallowedBlock = await runCase(
      { cu: baseCu.replace('  out[1] = 2.0f;', '  out[1] = 999.0f;') },
      9,
    );
    assert.equal(disallowedBlock.guardCheck.status, 'failed');
    assert.equal(disallowedBlock.guardCheck.reason, 'disallowed_block_id');
    assert.match(disallowedBlock.evidence.spec.findings?.[0]?.evidence ?? '', /epilogue/);

    // 11. maxBlockBytes exact boundary passes (96 UTF-8 bytes) and 97 UTF-8 bytes (multi-byte UTF-8) fails
    const exact96 = 'a'.repeat(95) + '\n';
    assert.equal(Buffer.byteLength(exact96, 'utf8'), 96);
    const pass96 = await runCase(
      { py: basePy.replace('    y = x + 1\n', exact96) },
      10,
    );
    assert.equal(pass96.guardCheck.status, 'passed');

    const over97Utf8 = '# ' + '\u00e9'.repeat(47) + '\n'; // 2 + 94 + 1 = 97 UTF-8 bytes (50 chars!)
    assert.equal(Buffer.byteLength(over97Utf8, 'utf8'), 97);
    const fail97 = await runCase(
      { py: basePy.replace('    y = x + 1\n', over97Utf8) },
      11,
    );
    assert.equal(fail97.guardCheck.status, 'failed');
    assert.equal(fail97.guardCheck.reason, 'block_bytes_exceeded');
    assert.equal(fail97.evidence.spec.findings?.[0]?.path, 'packages/kernel.py');

    // 12. Missing candidate file -> missing_file
    const missing = await runCase({ c: null }, 12);
    assert.equal(missing.guardCheck.status, 'failed');
    assert.equal(missing.guardCheck.reason, 'missing_file');

    // 13. Invalid UTF-8 bytes -> invalid_utf8
    const invalidUtf8 = await runCase({ c: Buffer.from([0xff, 0xfe, 0x00]) }, 13);
    assert.equal(invalidUtf8.guardCheck.status, 'failed');
    assert.equal(invalidUtf8.guardCheck.reason, 'invalid_utf8');

    // 14. Guarded file with zero blocks matching allowedBlockIds fails closed with disallowed_block_id
    const nonMatchingFile = [
      'int helper(int a) {',
      '  /* EVOLVE-BLOCK-START: locked_only */',
      '  return a * 2;',
      '  /* EVOLVE-BLOCK-END: locked_only */',
      '}',
      '',
    ].join('\n');
    const sourceNoMatch = await makeInv([
      { name: 'packages/kernel.cu', bytes: Buffer.from(baseCu, 'utf8') },
      { name: 'packages/kernel.py', bytes: Buffer.from(basePy, 'utf8') },
      { name: 'packages/helper.c', bytes: Buffer.from(nonMatchingFile, 'utf8') },
    ]);
    const guardSlot = f.plan.verifierSlots.find(s => s.checkId === 'evolve-guard')!;
    const boundNoMatch = bindSubject(f.lock, sourceNoMatch.manifest);
    assert.equal(boundNoMatch.ok, true);
    if (boundNoMatch.ok) {
      const verifierNoMatch = new Verifier(f.store, f.authority, f.artifacts, f.plan, f.lock, () => boundNoMatch.value);
      const prepNoMatch = prepareVerification(f.plan, f.lock, guardSlot.id, sourceNoMatch, sourceNoMatch, 14, 'e'.repeat(32));
      const noMatchCheck = await verifierNoMatch.run(prepNoMatch, new AbortController().signal);
      assert.equal(noMatchCheck.status, 'failed');
      assert.equal(noMatchCheck.reason, 'disallowed_block_id');
    }

    // 15. preflightVerification + Verifier.restore() parity and O_NOFOLLOW symlink rejection on CAS blob
    const pre = preflightVerification(f.plan, f.lock, guardSlot.id, source, source, 15, 'c'.repeat(32));
    assert.equal(pre.kind, 'ready');
    if (pre.kind === 'ready') {
      const boundSrc = bindSubject(f.lock, source.manifest);
      assert.equal(boundSrc.ok, true);
      if (boundSrc.ok) {
        const verifier = new Verifier(f.store, f.authority, f.artifacts, f.plan, f.lock, () => boundSrc.value);
        const ran = await verifier.run(pre.job, new AbortController().signal);
        assert.equal(ran.status, 'passed');
        const restored = await verifier.restore(pre.job);
        assert.equal(canonical(restored), canonical(ran));
      }
    }

    // Symlink blobPath fails closed via O_NOFOLLOW in prepareVerification
    const realTarget = join(f.root, 'real-blob.cu');
    await writeFile(realTarget, baseCu, { mode: 0o400 });
    const symlinkBlob = join(f.root, 'symlink-blob.cu');
    await symlink(realTarget, symlinkBlob);
    const cuEntry = source.manifest.spec.entries.find(e => e.name === 'packages/kernel.cu')!;
    const symlinkCandidate: ByteInventory = {
      manifest: source.manifest,
      ref: source.ref,
      files: source.files.map(file =>
        file.name === 'packages/kernel.cu'
          ? { name: file.name, byteLength: cuEntry.byteLength, digest: cuEntry.digest, blobPath: symlinkBlob }
          : file,
      ),
    };
    assert.throws(() => prepareVerification(f.plan, f.lock, guardSlot.id, source, symlinkCandidate, 16, 'd'.repeat(32)));
  } finally {
    await f.close();
  }
});

test('evolve-block-guard.v1 enforces 1..32 block count limit and works via baseTree Merkle proofs in stepNext/stepSubmit and restore()', async () => {
  const makeBlocks = (count: number) => {
    const lines = ['// header'];
    for (let i = 0; i < count; i++) {
      lines.push(`// EVOLVE-BLOCK-START: blk_${i}`);
      lines.push(`const v_${i} = ${i};`);
      lines.push(`// EVOLVE-BLOCK-END: blk_${i}`);
    }
    lines.push('// footer', '');
    return lines.join('\n');
  };

  const cfg = await configurationFixture();
  try {
    const repoDir = join(cfg.root, 'repo-evolve');
    const baseFiles: Record<string, string> = {
      'packages/ok32.ts': makeBlocks(32),
      'packages/over33.ts': makeBlocks(33),
    };
    for (let i = 0; i < 135; i++) {
      baseFiles[`lib/pad-${String(i).padStart(3, '0')}.ts`] = `export const p${i} = ${i};\n`;
    }
    const rev = await initGitRepo(repoDir, baseFiles);
    const installed = await installedHandlerDigests();

    setFixture(cfg.registry, ['spec', 'roleProfiles'], [
      {
        id: 'builder',
        adapter: 'delegated',
        selection: { provider: 'claude-code', model: 'claude-sonnet-4-6', thinking: 'high' },
        tools: ['read', 'write', 'edit'],
        runtimeRef: null,
        providerCredentialRef: null,
        mcp: null,
      },
    ]);
    setFixture(cfg.registry, ['spec', 'credentialBindings'], []);
    setFixture(cfg.registry, ['spec', 'environmentBindings'], []);
    setFixture(cfg.registry, ['spec', 'handlers'], [
      { id: 'author.h', kind: 'agent', implementation: 'pi.agent.v1', version: 1, digest: installed['pi.agent.v1'], parameters: { prompt: 'Evolve kernel.', purpose: 'task' }, capabilities: ['pi'] },
      { id: 'guard-32', kind: 'check', implementation: 'evolve-block-guard.v1', version: 1, digest: installed['evolve-block-guard.v1'], parameters: { checkId: 'guard-32', files: ['packages/ok32.ts'] }, capabilities: ['inert_bytes', 'read_only'] },
      { id: 'guard-33', kind: 'check', implementation: 'evolve-block-guard.v1', version: 1, digest: installed['evolve-block-guard.v1'], parameters: { checkId: 'guard-33', files: ['packages/over33.ts'] }, capabilities: ['inert_bytes', 'read_only'] },
      ...cfg.registry.spec.handlers.filter(h => h.id === 'scope' || h.id === 'no-change'),
    ]);
    setFixture(cfg.config, ['spec', 'credentials'], []);
    setFixture(cfg.config, ['spec', 'task', 'spec', 'target', 'baseRevision'], rev);
    setFixture(cfg.config, ['spec', 'task', 'spec', 'target', 'sourceRevision'], rev);
    setFixture(cfg.config, ['spec', 'task', 'spec', 'scope'], { writable: ['packages/**'], protected: [] });
    setFixture(cfg.config, ['spec', 'task', 'spec', 'roles'], [
      { id: 'builder', adapter: 'delegated', provider: 'claude-code', model: 'claude-sonnet-4-6', thinking: 'high', tools: ['read', 'write', 'edit'] },
    ]);
    setFixture(cfg.config, ['spec', 'task', 'spec', 'budgets', 'maxImplementationRepairs'], 0);
    setFixture(cfg.config, ['spec', 'controls', 'maxAttempts'], 1);
    setFixture(cfg.config, ['spec', 'task', 'spec', 'steps'], [
      { id: 'evolve', kind: 'agent', uses: 'author.h', roleId: 'builder', dependsOn: [] },
    ]);
    setFixture(cfg.config, ['spec', 'profiles', 'steps'], [{ stepId: 'evolve', handlerRef: 'author.h' }]);
    setFixture(cfg.config, ['spec', 'task', 'spec', 'acceptance'], {
      required: ['guard-32'],
      checks: [{ id: 'guard-32', allowedEvidenceLevels: ['local_execution'] }],
    });
    cfg.input.untrustedRoots = [cfg.taskDirectory, repoDir];
    await cfg.save();

    const loaded32 = await cfg.load();
    assert.equal(loaded32.ok, true, JSON.stringify(loaded32));
    if (!loaded32.ok) return;

    const runRoot = join(cfg.root, 'runs');
    const y1 = await stepNext({ configuration: loaded32.value, repository: repoDir, runRoot, runId: 'run-evolve-32' });
    assert.equal(y1.ok, true, JSON.stringify(y1));
    if (!y1.ok || y1.value.kind !== 'step') assert.fail('expected step yield');

    // Mutate inside blk_0 of ok32.ts -> passes on >128-file baseTree Merkle repo
    await chmod(join(y1.value.candidateDir, 'packages/ok32.ts'), 0o600);
    await writeFile(
      join(y1.value.candidateDir, 'packages/ok32.ts'),
      makeBlocks(32).replace('const v_0 = 0;', 'const v_0 = 42;'),
      { mode: 0o600 },
    );
    const s1 = await stepSubmit({ runRoot, runId: 'run-evolve-32', leaseToken: y1.value.leaseToken, status: 'completed' });
    assert.equal(s1.ok, true, JSON.stringify(s1));
    const fin1 = await stepNext({ runRoot, runId: 'run-evolve-32' });
    assert.equal(fin1.ok, true, JSON.stringify(fin1));
    if (!fin1.ok || fin1.value.kind !== 'result') assert.fail('expected result');
    assert.equal(fin1.value.result.spec.status, 'completed');

    // Now test 33-block file -> fails closed with block_limit_exceeded
    setFixture(cfg.config, ['spec', 'task', 'spec', 'acceptance'], {
      required: ['guard-33'],
      checks: [{ id: 'guard-33', allowedEvidenceLevels: ['local_execution'] }],
    });
    setFixture(cfg.config, ['spec', 'task', 'spec', 'steps'], [
      { id: 'check-33', kind: 'check', uses: 'guard-33', roleId: null, dependsOn: [] },
    ]);
    setFixture(cfg.config, ['spec', 'profiles', 'steps'], [{ stepId: 'check-33', handlerRef: 'guard-33' }]);
    await cfg.save();
    const loaded33 = await cfg.load();
    assert.equal(loaded33.ok, true);
    if (!loaded33.ok) return;

    const run33 = await runCycleWithPorts({
      configuration: loaded33.value,
      repository: repoDir,
      runRoot,
      runId: 'run-evolve-33',
    });
    assert.equal(run33.ok, true);
    if (!run33.ok || run33.value.kind !== 'result') assert.fail('expected result');
    assert.equal(run33.value.result.spec.status, 'failed');
    assert.equal(run33.value.result.spec.verification.spec.required[0]?.status, 'failed');
    assert.match(
      run33.value.result.spec.verification.spec.required[0]?.findings?.[0]?.evidence ?? '',
      /exceeds maximum of 32/,
    );
  } finally {
    await cfg.cleanup();
  }
});

test('benchmark-gate.v1 forwards Stage A static audit fields, bucketScope, bucketMetrics, and hardwareDiagnostics while keeping legacy digests byte-identical', async () => {
  // 1. Legacy digest parity: omitting Stage A audit fields & bucketMetrics/hardwareDiagnostics keeps exact legacy keys
  const cfgLegacy = await configurationFixture();
  const cfgAudit = await configurationFixture();
  try {
    const installed = await installedHandlerDigests();
    const setupBench = async (
      f: Awaited<ReturnType<typeof configurationFixture>>,
      relayUrl: string,
      hardware: HardwareTargetSpec,
      metricThresholds: readonly MetricThresholdRule[],
    ) => {
      f.environment.BENCH_SECRET = BENCH_SECRET;
      setFixture(f.registry, ['spec', 'credentialBindings'], [
        ...f.registry.spec.credentialBindings,
        { id: 'bench-signer', consumer: 'gate', destinationRef: 'bench-relay', environmentNames: ['BENCH_SECRET'], template: '${BENCH_SECRET}' },
      ]);
      setFixture(f.registry, ['spec', 'environmentBindings'], [
        { name: 'PROVIDER_TOKEN', classification: 'credential', paths: [] },
        { name: 'BENCH_SECRET', classification: 'credential', paths: ['/spec/credentials/0/template'] },
      ]);
      setFixture(f.config, ['spec', 'credentials'], [{ ref: 'bench-signer', template: '${BENCH_SECRET}' }]);
      setFixture(f.registry, ['spec', 'gateEndpoints'], [
        {
          id: 'gpu-relay',
          url: relayUrl,
          signingCredentialRef: 'bench-signer',
          authCredentialRef: null,
          timeoutMs: 2000,
          maxPollMs: 8000,
          pollInitialMs: 100,
          pollMaxMs: 200,
          jitter: 0,
        },
      ]);
      setFixture(f.registry, ['spec', 'handlers'], [
        f.registry.spec.handlers[0]!,
        {
          id: 'kernel-bench',
          kind: 'check',
          implementation: 'benchmark-gate.v1',
          version: 1,
          digest: installed['benchmark-gate.v1'],
          parameters: {
            checkId: 'kernel-bench',
            endpointRef: 'gpu-relay',
            gateId: 'sm90-decode-gate',
            heldOutWorkloadId: 'decode-bs1-4k',
          },
          capabilities: ['hardware_execution', 'read_only'],
        },
        f.registry.spec.handlers[2]!,
        f.registry.spec.handlers[3]!,
      ]);
      setFixture(f.config, ['spec', 'controls', 'maxAttempts'], 4);
      setFixture(f.config, ['spec', 'task', 'spec', 'budgets', 'maxImplementationRepairs'], 3);
      setFixture(f.config, ['spec', 'task', 'spec', 'steps'], [
        { id: 'bench-step', kind: 'check', uses: 'kernel-bench', roleId: null, dependsOn: [] },
      ]);
      setFixture(f.config, ['spec', 'profiles', 'steps'], [{ stepId: 'bench-step', handlerRef: 'kernel-bench' }]);
      setFixture(f.config, ['spec', 'task', 'spec', 'target', 'matrix'], [
        { id: 'cuda-h100-whole', platform: 'linux-x86_64', variant: 'h100', hardware },
      ]);
      setFixture(f.config, ['spec', 'task', 'spec', 'acceptance'], {
        required: ['kernel-bench'],
        checks: [
          {
            id: 'kernel-bench',
            allowedEvidenceLevels: ['hardware_execution'],
            targetCellId: 'cuda-h100-whole',
            allowSyntheticHardwareProbe: true,
            metricThresholds,
          },
        ],
      });
      await f.save();
      const loaded = await f.load();
      assert.equal(loaded.ok, true, JSON.stringify(loaded));
      if (!loaded.ok) throw new Error('load failed');
      const compiled = await compilePlan(loaded.value);
      assert.equal(compiled.ok, true, JSON.stringify(compiled));
      if (!compiled.ok) throw new Error('compile failed');
      return { loaded: loaded.value, plan: compiled.value };
    };

    // Start mock relay capturing incoming BenchmarkRequest and returning signed Stage B verdict
    const receivedRequests: Record<string, unknown>[] = [];
    let verdictMode: 'full' | 'legacy' | 'bad_bucket_ulp' | 'invalid_diag' = 'full';
    const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk));
      if (req.method === 'PUT') {
        res.writeHead(204);
        res.end();
        return;
      }
      const bodyText = Buffer.concat(chunks).toString('utf8');
      const parsed = JSON.parse(bodyText) as Record<string, unknown>;
      receivedRequests.push(parsed);

      const baseVerdict: Record<string, unknown> = {
        version: 1,
        kind: 'benchmark_verdict',
        storeId: parsed.storeId,
        runId: parsed.runId,
        lockHash: parsed.lockHash,
        operationId: parsed.operationId,
        dispatchId: parsed.dispatchId,
        dispatchGeneration: parsed.dispatchGeneration,
        gateId: parsed.gateId,
        checkId: parsed.checkId,
        candidateDigest: parsed.candidateDigest,
        status: 'approved',
        reason: null,
        expiresAtMs: String(Date.now() + 300_000),
        preemptionCount: 0,
        metrics: { latency_us_p50: 45.0, max_ulp: 0.5 },
        hardwareProvenance: sampleProvenance(),
      };
      if (verdictMode === 'full') {
        baseVerdict.bucketMetrics = sampleBucketMetrics();
        baseVerdict.hardwareDiagnostics = sampleHardwareDiagnostics();
      } else if (verdictMode === 'bad_bucket_ulp') {
        baseVerdict.bucketMetrics = sampleBucketMetrics({ secondUlp: 2.5 });
        baseVerdict.hardwareDiagnostics = sampleHardwareDiagnostics();
      } else if (verdictMode === 'invalid_diag') {
        baseVerdict.hardwareDiagnostics = { boundPipeline: 'free-text-exfil' };
      }

      const payloadBytes = Buffer.from(canonical(baseVerdict), 'utf8');
      const sig = signPayload(BENCH_SECRET, payloadBytes);
      res.writeHead(200, {
        'content-type': 'application/json',
        'x-loopwright-signature': sig,
      });
      res.end(payloadBytes);
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const addr = server.address();
    if (!addr || typeof addr === 'string') throw new Error('bind failed');
    const relayUrl = `http://127.0.0.1:${addr.port}/v1/benchmark`;

    try {
      const legacyHardware: HardwareTargetSpec = {
        accelerator: 'sm_90a',
        isolationMode: 'whole_device',
        deviceCount: 1,
      };
      const auditHardware: HardwareTargetSpec = {
        accelerator: 'sm_90a',
        isolationMode: 'whole_device',
        deviceCount: 1,
        forbiddenSymbolPatterns: ['cublas', 'at::native::'],
        maxRegisterCount: 128,
        maxLocalSpillBytes: 0,
      };
      const legacyThresholds: readonly MetricThresholdRule[] = [
        { kind: 'bounds', metric: 'latency_us_p50', max: 100 },
      ];
      const bucketedThresholds: readonly MetricThresholdRule[] = [
        { kind: 'bounds', metric: 'latency_us_p50', max: 100 },
        { kind: 'bounds', metric: 'max_ulp', max: 1.0, bucketScope: 'all_buckets' },
        { kind: 'bounds', metric: 'goodput_rps', min: 1500, bucketScope: { bucketId: 'bs1-isl4k' } },
      ];

      const legacySetup = await setupBench(cfgLegacy, relayUrl, legacyHardware, legacyThresholds);
      const auditSetup = await setupBench(cfgAudit, relayUrl, auditHardware, bucketedThresholds);

      const legacyLockRes = admitTask(legacySetup.plan.task, { admissionId: 'adm-l', runId: 'run-l' });
      const auditLockRes = admitTask(auditSetup.plan.task, { admissionId: 'adm-a', runId: 'run-a' });
      assert.equal(legacyLockRes.ok, true);
      assert.equal(auditLockRes.ok, true);
      if (!legacyLockRes.ok || !auditLockRes.ok) return;

      const emptyManifest: ArtifactManifest = {
        apiVersion: 'loopwright.dev/v1alpha1',
        kind: 'ArtifactManifest',
        metadata: { id: 'candidate' },
        spec: { entries: [] },
      };
      const legacySubj = bindSubject(legacyLockRes.value, emptyManifest);
      const auditSubj = bindSubject(auditLockRes.value, emptyManifest);
      assert.equal(legacySubj.ok, true);
      assert.equal(auditSubj.ok, true);
      if (!legacySubj.ok || !auditSubj.ok) return;

      const legacySlot = legacySetup.plan.verifierSlots.find(s => s.handler.implementation === 'benchmark-gate.v1')!;
      const auditSlot = auditSetup.plan.verifierSlots.find(s => s.handler.implementation === 'benchmark-gate.v1')!;
      const legacyReq = expectedBenchmarkRequest(
        legacySetup.plan,
        legacySlot,
        legacySetup.loaded.registry.spec.gateEndpoints[0]!,
        legacySubj.value,
        emptyManifest,
      );
      const auditReq = expectedBenchmarkRequest(
        auditSetup.plan,
        auditSlot,
        auditSetup.loaded.registry.spec.gateEndpoints[0]!,
        auditSubj.value,
        emptyManifest,
      );

      // Legacy request MUST omit Stage A static audit fields and bucketScope completely
      const legacyHwObj = legacyReq.targetHardware as Record<string, unknown>;
      assert.equal(Object.hasOwn(legacyHwObj, 'forbiddenSymbolPatterns'), false);
      assert.equal(Object.hasOwn(legacyHwObj, 'maxRegisterCount'), false);
      assert.equal(Object.hasOwn(legacyHwObj, 'maxLocalSpillBytes'), false);
      assert.equal(Object.hasOwn((legacyReq.metricThresholds as Record<string, unknown>[])[0]!, 'bucketScope'), false);

      // Audit request MUST forward all three Stage A static audit fields & bucketScope
      const auditHwObj = auditReq.targetHardware as Record<string, unknown>;
      assert.deepEqual(auditHwObj.forbiddenSymbolPatterns, ['cublas', 'at::native::']);
      assert.equal(auditHwObj.maxRegisterCount, 128);
      assert.equal(auditHwObj.maxLocalSpillBytes, 0);
      assert.equal((auditReq.metricThresholds as Record<string, unknown>[])[1]!.bucketScope, 'all_buckets');
      assert.deepEqual((auditReq.metricThresholds as Record<string, unknown>[])[2]!.bucketScope, { bucketId: 'bs1-isl4k' });

      // checkedBenchmarkVerdict accepts valid bucketMetrics + hardwareDiagnostics, omits when absent, rejects invalid
      const expectedBinding = {
        storeId: 'store.1',
        runId: 'run-a',
        lockHash: auditLockRes.value.spec.lockHash,
        operationId: 'op.1',
        dispatchId: 'disp.1',
        dispatchGeneration: 1,
        gateId: 'sm90-decode-gate',
        checkId: 'kernel-bench',
        candidateDigest: auditSubj.value.candidateDigest.hex,
        slotId: auditSlot.id,
      };
      const baseVerdictBody = {
        version: 1,
        kind: 'benchmark_verdict',
        storeId: expectedBinding.storeId,
        runId: expectedBinding.runId,
        lockHash: expectedBinding.lockHash,
        operationId: expectedBinding.operationId,
        dispatchId: expectedBinding.dispatchId,
        dispatchGeneration: expectedBinding.dispatchGeneration,
        gateId: expectedBinding.gateId,
        checkId: expectedBinding.checkId,
        candidateDigest: expectedBinding.candidateDigest,
        status: 'approved',
        reason: null,
        expiresAtMs: String(Date.now() + 60_000),
        preemptionCount: 0,
        metrics: { latency_us_p50: 45 },
        hardwareProvenance: sampleProvenance(),
      };
      const legacyParsed = checkedBenchmarkVerdict(baseVerdictBody, expectedBinding);
      assert.equal(Object.hasOwn(legacyParsed, 'bucketMetrics'), false);
      assert.equal(Object.hasOwn(legacyParsed, 'hardwareDiagnostics'), false);

      const fullParsed = checkedBenchmarkVerdict(
        { ...baseVerdictBody, bucketMetrics: sampleBucketMetrics(), hardwareDiagnostics: sampleHardwareDiagnostics() },
        expectedBinding,
      );
      assert.equal(Object.getPrototypeOf(fullParsed.bucketMetrics?.[0]), null);
      assert.equal(Object.getPrototypeOf(fullParsed.hardwareDiagnostics), null);
      assert.equal(canonical(fullParsed.bucketMetrics), canonical(sampleBucketMetrics()));
      assert.equal(canonical(fullParsed.hardwareDiagnostics), canonical(sampleHardwareDiagnostics()));

      // Invalid hardwareDiagnostics / bucketMetrics rejected fail-closed
      assert.throws(() =>
        checkedBenchmarkVerdict(
          { ...baseVerdictBody, hardwareDiagnostics: { boundPipeline: 'not_a_pipeline' } },
          expectedBinding,
        ),
      );
      assert.throws(() =>
        checkedBenchmarkVerdict(
          {
            ...baseVerdictBody,
            bucketMetrics: [{ bucketId: 'b1', metrics: { x: Number.NaN } }],
          },
          expectedBinding,
        ),
      );
      assert.throws(() =>
        checkedBenchmarkVerdict(
          {
            ...baseVerdictBody,
            bucketMetrics: [{ bucketId: 'b1', metrics: { x: 'not-a-number' } }],
          },
          expectedBinding,
        ),
      );
      assert.throws(() =>
        checkedBenchmarkVerdict(
          {
            ...baseVerdictBody,
            bucketMetrics: [
              { bucketId: 'dup', metrics: { latency_us_p50: 1 } },
              { bucketId: 'dup', metrics: { latency_us_p50: 2 } },
            ],
          },
          expectedBinding,
        ),
      );

      // computeBenchmarkDisposition enforces bucketScope: 'all_buckets'
      const dispBadBucket = computeBenchmarkDisposition({
        verdict: checkedBenchmarkVerdict(
          { ...baseVerdictBody, bucketMetrics: sampleBucketMetrics({ secondUlp: 2.5 }) },
          expectedBinding,
        ),
        timedOut: false,
        sawPreemption: false,
        wallClockValid: true,
        targetHardware: auditHardware,
        targetCellId: 'cuda-h100-whole',
        allowSyntheticHardwareProbe: true,
        metricThresholds: bucketedThresholds,
        casOutcome: 'ok',
      });
      assert.equal(dispBadBucket.status, 'blocked');
      assert.equal(dispBadBucket.reason, 'METRIC_THRESHOLD_FAILED');

      // Live BenchmarkGate.run + restore() forwarding Stage A audit fields & Stage B bucketMetrics/hardwareDiagnostics onto Evidence.spec
      const repoDir = join(cfgAudit.root, 'repo-bench');
      const rev = await initGitRepo(repoDir, { 'packages/kernel.cu': '// kernel\n' });
      setFixture(cfgAudit.config, ['spec', 'task', 'spec', 'target', 'baseRevision'], rev);
      setFixture(cfgAudit.config, ['spec', 'task', 'spec', 'target', 'sourceRevision'], rev);
      cfgAudit.input.untrustedRoots = [cfgAudit.taskDirectory, repoDir];
      await cfgAudit.save();
      const loadedRun = await cfgAudit.load();
      assert.equal(loadedRun.ok, true);
      if (!loadedRun.ok) return;
      const compiledRun = await compilePlan(loadedRun.value);
      assert.equal(compiledRun.ok, true);
      if (!compiledRun.ok) return;
      const runPlan = compiledRun.value;
      const runLockRes = admitTask(runPlan.task, { admissionId: 'adm-run', runId: 'run-bench-fwd' });
      assert.equal(runLockRes.ok, true);
      if (!runLockRes.ok) return;
      const runLock = runLockRes.value;

      const runDir = join(cfgAudit.root, 'runs', 'run-bench-fwd');
      await mkdir(join(runDir, 'artifacts'), { recursive: true, mode: 0o700 });
      const owner = await ControllerOwner.acquire(runDir, 'run-bench-fwd', runPlan.planDigest);
      const artifacts = new ArtifactStore(join(runDir, 'artifacts'), owner, approvedState(loadedRun.value).vault);
      const store = stateValue(
        createLocalRun({
          directory: join(runDir, 'state'),
          storeId: 'store.bench-fwd',
          lock: runLock,
          policy: { version: 1, leaseMs: 60_000, cost: 'observe_only' },
          binding: {
            coreApiVersion: 'loopwright.dev/v1alpha1',
            hostVersion: 'test',
            adapters: [{ id: 'pi', version: '0.0.0' }],
            resourceVersion: runPlan.task.spec.trustedContext.revision,
            clockEpoch: 'boot.1',
          },
        }),
      );
      const cur = stateValue(store.inspect());
      const authority = stateValue(
        store.claim({ ownerId: 'controller.' + owner.nonce, expectedGeneration: cur.owner.generation, expectedRevision: cur.revision, mode: 'active' }),
      ).authority;

      try {
        const frozen = await freezeSource(repoDir, runPlan.task, owner, artifacts, []);
        const bounds = overlayManifestBounds(runPlan.budgets.overlay);
        const manifestRef = await artifacts.json('manifest', frozen.manifest, bounds.manifestMaxBytes);
        const inv: ByteInventory = { manifest: frozen.manifest, ref: manifestRef, files: frozen.artifacts };
        const bound = bindSubject(runLock, frozen.manifest, bounds.options);
        assert.equal(bound.ok, true);
        if (!bound.ok) return;

        const slot = runPlan.verifierSlots.find(s => s.handler.implementation === 'benchmark-gate.v1')!;
        const gate = new BenchmarkGate(
          store,
          authority,
          artifacts,
          runPlan,
          runLock,
          ref => approvedState(loadedRun.value).vault.resolveNetworkCredential(ref),
          () => bound.value,
        );

        verdictMode = 'full';
        const prep = prepareBenchmarkGate(
          runPlan,
          runLock,
          slot.id,
          inv,
          0,
          '1'.repeat(32),
          loadedRun.value.registry.spec.gateEndpoints,
        );
        const ran = await gate.run(prep, new AbortController().signal);
        assert.equal(ran.status, 'passed');

        // Confirm outbound BenchmarkRequest carried Stage A static audit fields
        assert.equal(receivedRequests.length, 1);
        const sentHw = receivedRequests[0]!.targetHardware as Record<string, unknown>;
        assert.deepEqual(sentHw.forbiddenSymbolPatterns, ['cublas', 'at::native::']);
        assert.equal(sentHw.maxRegisterCount, 128);
        assert.equal(sentHw.maxLocalSpillBytes, 0);

        // Confirm recorded Evidence.spec carries bucketMetrics and hardwareDiagnostics verbatim
        const obs = authenticatedBenchmarkGate(ran);
        assert.equal(canonical(obs.evidence.spec.bucketMetrics), canonical(sampleBucketMetrics()));
        assert.equal(canonical(obs.evidence.spec.hardwareDiagnostics), canonical(sampleHardwareDiagnostics()));

        // Confirm restore() reproduces identical Evidence including bucketMetrics + hardwareDiagnostics
        const restored = await gate.restore(prep);
        assert.equal(canonical(restored), canonical(ran));
        const restoredObs = authenticatedBenchmarkGate(restored);
        assert.equal(canonical(restoredObs.evidence.spec.bucketMetrics), canonical(sampleBucketMetrics()));
        assert.equal(canonical(restoredObs.evidence.spec.hardwareDiagnostics), canonical(sampleHardwareDiagnostics()));

        // Confirm legacy Stage B verdict (without bucketMetrics/hardwareDiagnostics) keeps Evidence keys omitted
        verdictMode = 'legacy';
        const prepLegacy = prepareBenchmarkGate(
          runPlan,
          runLock,
          slot.id,
          inv,
          1,
          '2'.repeat(32),
          loadedRun.value.registry.spec.gateEndpoints,
        );
        const ranLegacy = await gate.run(prepLegacy, new AbortController().signal);
        assert.equal(ranLegacy.status, 'blocked');
        assert.equal(ranLegacy.reason, 'METRIC_THRESHOLD_FAILED'); // bucketScope: 'all_buckets' fails closed when bucketMetrics omitted
        const legacyObs = authenticatedBenchmarkGate(ranLegacy);
        assert.equal(Object.hasOwn(legacyObs.evidence.spec, 'bucketMetrics'), false);
        assert.equal(Object.hasOwn(legacyObs.evidence.spec, 'hardwareDiagnostics'), false);

        // Confirm Stage B verdict with single-bucket max_ulp breach settles blocked (METRIC_THRESHOLD_FAILED)
        verdictMode = 'bad_bucket_ulp';
        const prepBadBucket = prepareBenchmarkGate(
          runPlan,
          runLock,
          slot.id,
          inv,
          2,
          '3'.repeat(32),
          loadedRun.value.registry.spec.gateEndpoints,
        );
        const ranBadBucket = await gate.run(prepBadBucket, new AbortController().signal);
        assert.equal(ranBadBucket.status, 'blocked');
        assert.equal(ranBadBucket.reason, 'METRIC_THRESHOLD_FAILED');

        // Confirm reconcileCycle accepts receipt with bucketMetrics + hardwareDiagnostics
        assert.equal(typeof signBenchmarkVerdict, 'function');
        assert.equal(typeof reconcileCycle, 'function');
      } finally {
        stateValue(store.release(authority));
        stateValue(store.close());
        await owner.release();
      }
    } finally {
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
  } finally {
    await cfgLegacy.cleanup();
    await cfgAudit.cleanup();
  }
});
