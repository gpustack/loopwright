import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import {
  compilePlan,
  installedHandlerDigests,
  loadTrustedConfiguration,
  type ControllerIncident,
} from '@loopwright/controller';
import { admitTask, digestArtifact, validateDocument } from '@loopwright/core';
import {
  canonical,
  loadMemoryStore,
  renderEntryMarkdown,
  serializeMemoryStoreIndex,
  storeDigestOf,
  type MemoryEntry,
  type MemoryStoreIndex,
} from '@loopwright/memory';
import {
  compileDeclarativeTaskpack,
  DEFAULT_HOST_BUDGETS,
  finalizeLocalTurnkeyMemory,
  projectMemoryHardwareScope,
  SecretScrubber,
  serializePrettyYaml,
  stageCompiledInstructionResources,
  TaskpackError,
  validateTaskpackManifest,
  validateTaskpackV2Manifest,
  type Json,
  type TargetMatrixCell,
} from '../src/index.js';

const BASE_SHA = 'b'.repeat(40);
const ZERO_DIGEST = { algorithm: 'sha256' as const, hex: '0'.repeat(64) };
const ARTIFACT_DIGEST = { algorithm: 'sha256' as const, hex: 'c'.repeat(64) };

async function withTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const base = await realpath(tmpdir());
  const dir = await mkdtemp(join(base, 'lw-tp-evo-t8-'));
  try {
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function makeEvolutionManifestObject(overrides: {
  readonly targetMatrix?: unknown;
  readonly localChecks?: unknown;
  readonly externalGates?: unknown;
  readonly memory?: unknown;
} = {}): Record<string, unknown> {
  return {
    apiVersion: 'loopwright.dev/v1alpha1',
    kind: 'Taskpack',
    metadata: { name: 'evo-kernel' },
    spec: {
      goal: {
        candidate: 'Optimize CUDA kernel inside EVOLVE-BLOCK regions.',
        noChange: 'No kernel change needed.',
      },
      scope: {
        writable: ['src/**'],
        protected: [],
      },
      target: {
        matrix: overrides.targetMatrix !== undefined
          ? overrides.targetMatrix
          : [
            {
              id: 'h100-sxm',
              platform: 'linux/amd64',
              variant: 'cuda12',
              hardware: {
                accelerator: 'sm_90a',
                isolationMode: 'whole_device',
                deviceCount: 1,
                driverConstraint: '>=550.54',
                topology: 'nvlink',
                forbiddenSymbolPatterns: ['cublas', 'at::native::'],
                maxRegisterCount: 128,
                maxLocalSpillBytes: 0,
              },
            },
          ],
      },
      verification: {
        localChecks: overrides.localChecks !== undefined
          ? overrides.localChecks
          : [
            {
              id: 'evolve-guard',
              implementation: 'evolve-block-guard.v1',
              parameters: {
                files: ['src/kernel.cu'],
                allowedBlockIds: ['gemm_main'],
                maxBlockBytes: 8192,
              },
            },
          ],
        externalGates: overrides.externalGates !== undefined
          ? overrides.externalGates
          : [
            {
              id: 'bench-h100',
              implementation: 'benchmark-gate.v1',
              gateId: 'Roofline Gate v1',
              endpointId: 'bench-relay',
              required: true,
              targetCellId: 'h100-sxm',
              heldOutWorkloadId: 'kernel.matmul.v1',
              maxPreemptions: 2,
              allowSyntheticHardwareProbe: true,
              metricThresholds: [
                { kind: 'bounds', metric: 'max_ulp', max: 1, bucketScope: 'all_buckets' },
                { kind: 'bounds', metric: 'latency_us_p50', max: 250, bucketScope: { bucketId: 'bs1-isl4k' } },
                {
                  kind: 'comparative',
                  metric: 'goodput_rps',
                  baselineMetric: 'baseline_goodput_rps',
                  operator: 'min_ratio',
                  threshold: 1.1,
                  bucketScope: 'aggregate',
                },
              ],
            },
          ],
      },
      publication: { mode: 'disabled' },
      memory: overrides.memory !== undefined
        ? overrides.memory
        : {
          directory: '.loopwright/memory/evo-kernel',
          apply: 'local-only',
          onNoModelBudget: 'deterministic-observations-only',
        },
      triggers: {
        schedule: false,
        workflowDispatch: true,
        releasePublished: false,
        commentCommands: [],
      },
    },
  };
}

function makeMemoryEntry(overrides: {
  readonly id: string;
  readonly claimKey: string;
  readonly claim: string;
  readonly hardwareScope?: { readonly accelerator: string; readonly driverConstraint?: string };
  readonly targetMatrix?: { readonly id: string; readonly platform: string; readonly variant: string } | null;
  readonly level?: 'local_execution' | 'hardware_execution';
}): MemoryEntry {
  const scope = overrides.hardwareScope !== undefined
    ? {
      taskpack: 'evo-kernel',
      repository: 'local/kernel-repo',
      paths: ['src/**'],
      targetMatrix: overrides.targetMatrix ?? null,
      hardwareScope: overrides.hardwareScope,
    }
    : {
      taskpack: 'evo-kernel',
      repository: 'local/kernel-repo',
      paths: ['src/**'],
      targetMatrix: overrides.targetMatrix ?? null,
    };
  return Object.freeze({
    version: 1,
    id: overrides.id,
    claimKey: overrides.claimKey,
    claim: overrides.claim,
    kind: 'fact',
    scope,
    sourceRef: {
      runId: 'run-seed-1',
      lockHash: ZERO_DIGEST,
      candidateDigest: ZERO_DIGEST,
    },
    sourceDigest: ARTIFACT_DIGEST,
    verifiedAtMs: 1_700_000_000_000,
    validFor: {
      baseRevision: BASE_SHA,
      sourceRevision: BASE_SHA,
      codeFingerprint: ZERO_DIGEST,
      upstreamVersions: {},
    },
    expiresAtMs: 1_900_000_000_000,
    supersedes: [],
    evidenceRefs: [
      {
        evidenceId: `ev-${overrides.id}`,
        checkId: 'bench-h100',
        level: overrides.level ?? (overrides.hardwareScope !== undefined ? 'hardware_execution' : 'local_execution'),
        observedStatus: 'passed' as const,
        artifact: {
          name: `evidence-${overrides.id}.json`,
          digest: ARTIFACT_DIGEST,
          byteLength: 128,
        },
      },
    ],
  });
}

describe('evolve-block-guard.v1, Stage A static audit, bucketScope, and hardwareScope memory', () => {
  it('validates and compiles evolve-block-guard.v1, Stage A static audit fields, and bucketScope through controller compilePlan', async () => {
    await withTempDir(async dir => {
      const repoRoot = join(dir, 'repo');
      await mkdir(join(repoRoot, 'src'), { recursive: true });
      await writeFile(
        join(repoRoot, 'src', 'kernel.cu'),
        '// EVOLVE-BLOCK-START: gemm_main\n__global__ void gemm() {}\n// EVOLVE-BLOCK-END: gemm_main\n',
        'utf8',
      );

      const manifest = validateTaskpackV2Manifest(makeEvolutionManifestObject() as Json);
      const compiled = await compileDeclarativeTaskpack(manifest, {
        mode: 'candidate',
        executionMode: 'delegated',
        repository: 'local/kernel-repo',
        repositoryRoot: repoRoot,
        baseRevision: BASE_SHA,
        sourceRevision: BASE_SHA,
        budgets: DEFAULT_HOST_BUDGETS,
        gateEndpoints: [
          {
            id: 'bench-relay',
            url: 'http://127.0.0.1:42010/v1/benchmark/jobs',
            signingCredentialRef: 'bench-signing',
            authCredentialRef: null,
          },
        ],
        credentialEnvMap: { gate: 'BENCH_SIGNING_SECRET' },
      });

      const installed = await installedHandlerDigests();
      const guardHandler = compiled.registry.spec.handlers.find(h => h.id === 'evolve-guard');
      assert.ok(guardHandler, 'expected evolve-block-guard.v1 handler in TrustedRegistry');
      assert.equal(guardHandler.implementation, 'evolve-block-guard.v1');
      assert.deepEqual(guardHandler.digest, installed['evolve-block-guard.v1']);
      assert.deepEqual(guardHandler.parameters, {
        checkId: 'evolve-guard',
        files: ['src/kernel.cu'],
        allowedBlockIds: ['gemm_main'],
        maxBlockBytes: 8192,
      });

      const compiledHardware = compiled.config.spec.task.spec.target.matrix?.[0]?.hardware;
      assert.deepEqual({ ...compiledHardware }, {
        accelerator: 'sm_90a',
        isolationMode: 'whole_device',
        deviceCount: 1,
        driverConstraint: '>=550.54',
        topology: 'nvlink',
        forbiddenSymbolPatterns: ['cublas', 'at::native::'],
        maxRegisterCount: 128,
        maxLocalSpillBytes: 0,
      });

      const compiledBenchCheck = compiled.config.spec.task.spec.acceptance.checks.find(c => c.id === 'bench-h100');
      assert.deepEqual(
        JSON.parse(JSON.stringify(compiledBenchCheck?.metricThresholds)),
        [
          { kind: 'bounds', metric: 'max_ulp', max: 1, bucketScope: 'all_buckets' },
          { kind: 'bounds', metric: 'latency_us_p50', max: 250, bucketScope: { bucketId: 'bs1-isl4k' } },
          {
            kind: 'comparative',
            metric: 'goodput_rps',
            baselineMetric: 'baseline_goodput_rps',
            operator: 'min_ratio',
            threshold: 1.1,
            bucketScope: 'aggregate',
          },
        ],
      );

      const trustedDir = join(dir, 'trusted');
      const regDir = join(trustedDir, 'registry');
      const cfgDir = join(trustedDir, 'config');
      await mkdir(regDir, { recursive: true, mode: 0o700 });
      await mkdir(cfgDir, { recursive: true, mode: 0o700 });
      await chmod(trustedDir, 0o700);
      const regPath = join(regDir, 'registry.yaml');
      const cfgPath = join(cfgDir, 'config.yaml');
      await writeFile(regPath, compiled.registryBytes, { mode: 0o600 });
      await writeFile(cfgPath, serializePrettyYaml(compiled.config), { mode: 0o600 });
      await stageCompiledInstructionResources(regDir, compiled.instructionResources ?? []);

      const prevSign = process.env['BENCH_SIGNING_SECRET'];
      process.env['BENCH_SIGNING_SECRET'] = 'bench-signing-secret-t8';
      try {
        const trusted = await loadTrustedConfiguration({
          configPath: cfgPath,
          registryPath: regPath,
          registrySha256: compiled.registrySha256,
          untrustedRoots: [repoRoot],
        });
        assert.equal(trusted.ok, true, trusted.ok ? '' : JSON.stringify(trusted.error));
        if (!trusted.ok) return;
        const plan = await compilePlan(trusted.value);
        assert.equal(plan.ok, true, plan.ok ? '' : JSON.stringify(plan.error));
        if (plan.ok) {
          const evolveSlot = plan.value.verifierSlots.find(s => s.checkId === 'evolve-guard');
          assert.ok(evolveSlot, 'expected evolve-block-guard.v1 verifier slot in CompiledPlan');
          assert.equal(evolveSlot.handler.implementation, 'evolve-block-guard.v1');
        }
      } finally {
        if (prevSign === undefined) delete process.env['BENCH_SIGNING_SECRET'];
        else process.env['BENCH_SIGNING_SECRET'] = prevSign;
      }
    });
  });

  it('rejects invalid evolve-block-guard.v1, Stage A audit fields, and bucketScope declarations fail-closed', () => {
    const assertInvalid = (raw: Record<string, unknown>, message: string): void => {
      assert.throws(
        () => validateTaskpackV2Manifest(raw as Json),
        (err: unknown) => err instanceof TaskpackError && err.code === 'TASKPACK_MANIFEST_INVALID',
        message,
      );
    };

    // evolve-block-guard.v1 invalid cases
    assertInvalid(
      makeEvolutionManifestObject({
        localChecks: [{ id: 'g', implementation: 'evolve-block-guard.v1', parameters: { files: [] } }],
      }),
      'empty files must fail',
    );
    assertInvalid(
      makeEvolutionManifestObject({
        localChecks: [{ id: 'g', implementation: 'evolve-block-guard.v1', parameters: { files: ['../escape.cu'] } }],
      }),
      'parent traversal must fail',
    );
    assertInvalid(
      makeEvolutionManifestObject({
        localChecks: [{ id: 'g', implementation: 'evolve-block-guard.v1', parameters: { files: ['.github/workflows/ci.yml'] } }],
      }),
      '.github/workflows/ path must fail',
    );
    assertInvalid(
      makeEvolutionManifestObject({
        localChecks: [{ id: 'g', implementation: 'evolve-block-guard.v1', parameters: { files: ['src/Kernel.cu', 'src/kernel.cu'] } }],
      }),
      'case-folded duplicate files must fail',
    );
    assertInvalid(
      makeEvolutionManifestObject({
        localChecks: [{
          id: 'g',
          implementation: 'evolve-block-guard.v1',
          parameters: { files: ['src/kernel.cu'], allowedBlockIds: [] },
        }],
      }),
      'empty allowedBlockIds must fail',
    );
    assertInvalid(
      makeEvolutionManifestObject({
        localChecks: [{
          id: 'g',
          implementation: 'evolve-block-guard.v1',
          parameters: { files: ['src/kernel.cu'], allowedBlockIds: ['bad/*id'] },
        }],
      }),
      'invalid block id must fail',
    );
    assertInvalid(
      makeEvolutionManifestObject({
        localChecks: [{
          id: 'g',
          implementation: 'evolve-block-guard.v1',
          parameters: { files: ['src/kernel.cu'], maxBlockBytes: 0 },
        }],
      }),
      'zero maxBlockBytes must fail',
    );
    assertInvalid(
      makeEvolutionManifestObject({
        localChecks: [{
          id: 'g',
          implementation: 'evolve-block-guard.v1',
          parameters: { files: ['src/kernel.cu'], maxBlockBytes: -0 },
        }],
      }),
      '-0 maxBlockBytes must fail',
    );
    assertInvalid(
      makeEvolutionManifestObject({
        localChecks: [{
          id: 'g',
          implementation: 'evolve-block-guard.v1',
          parameters: { files: ['src/kernel.cu'], extra: true },
        }],
      }),
      'unknown parameter key must fail',
    );

    // Stage A static audit invalid cases
    assertInvalid(
      makeEvolutionManifestObject({
        localChecks: [],
        targetMatrix: [{
          id: 'h100-sxm',
          platform: 'linux/amd64',
          variant: 'cuda12',
          hardware: {
            accelerator: 'sm_90a',
            isolationMode: 'whole_device',
            forbiddenSymbolPatterns: ['cublas*'],
          },
        }],
      }),
      'glob in forbiddenSymbolPatterns must fail',
    );
    assertInvalid(
      makeEvolutionManifestObject({
        localChecks: [],
        targetMatrix: [{
          id: 'h100-sxm',
          platform: 'linux/amd64',
          variant: 'cuda12',
          hardware: {
            accelerator: 'sm_90a',
            isolationMode: 'whole_device',
            forbiddenSymbolPatterns: ['cublas', 'cublas'],
          },
        }],
      }),
      'duplicate forbiddenSymbolPatterns must fail',
    );
    assertInvalid(
      makeEvolutionManifestObject({
        localChecks: [],
        targetMatrix: [{
          id: 'h100-sxm',
          platform: 'linux/amd64',
          variant: 'cuda12',
          hardware: {
            accelerator: 'sm_90a',
            isolationMode: 'whole_device',
            maxRegisterCount: -1,
          },
        }],
      }),
      'negative maxRegisterCount must fail',
    );
    assertInvalid(
      makeEvolutionManifestObject({
        localChecks: [],
        targetMatrix: [{
          id: 'h100-sxm',
          platform: 'linux/amd64',
          variant: 'cuda12',
          hardware: {
            accelerator: 'sm_90a',
            isolationMode: 'whole_device',
            maxLocalSpillBytes: 1.5,
          },
        }],
      }),
      'non-integer maxLocalSpillBytes must fail',
    );

    // bucketScope invalid cases
    assertInvalid(
      makeEvolutionManifestObject({
        localChecks: [],
        externalGates: [{
          id: 'bench-h100',
          implementation: 'benchmark-gate.v1',
          gateId: 'Roofline Gate v1',
          endpointId: 'bench-relay',
          required: true,
          targetCellId: 'h100-sxm',
          heldOutWorkloadId: 'kernel.matmul.v1',
          metricThresholds: [{ kind: 'bounds', metric: 'max_ulp', max: 1, bucketScope: 'some_buckets' }],
        }],
      }),
      'unknown bucketScope string must fail',
    );
    assertInvalid(
      makeEvolutionManifestObject({
        localChecks: [],
        externalGates: [{
          id: 'bench-h100',
          implementation: 'benchmark-gate.v1',
          gateId: 'Roofline Gate v1',
          endpointId: 'bench-relay',
          required: true,
          targetCellId: 'h100-sxm',
          heldOutWorkloadId: 'kernel.matmul.v1',
          metricThresholds: [{ kind: 'bounds', metric: 'max_ulp', max: 1, bucketScope: { bucketId: '__proto__' } }],
        }],
      }),
      'prototype bucketId must fail',
    );

    // Legacy v1 manifest rejects evolve-block-guard.v1
    const legacyManifest = {
      ...makeEvolutionManifestObject({ externalGates: [] }),
      spec: {
        ...(makeEvolutionManifestObject({ externalGates: [] }).spec as Record<string, unknown>),
        proposal: { path: 'src/proposal.json', requiredFields: ['ok'], schemaVersion: 1 },
      },
    };
    assert.throws(
      () => validateTaskpackManifest(legacyManifest as Json),
      (err: unknown) => err instanceof TaskpackError && err.code === 'TASKPACK_MANIFEST_INVALID',
      'legacy v1 manifest must reject evolve-block-guard.v1',
    );
  });

  it('omits unset optional fields and preserves byte-identical TaskContract and TaskLock canonical digests', async () => {
    await withTempDir(async dir => {
      const repoRoot = join(dir, 'repo');
      await mkdir(join(repoRoot, 'src'), { recursive: true });
      await writeFile(join(repoRoot, 'src', 'kernel.cu'), '// kernel\n', 'utf8');

      const legacyHardwareManifest = validateTaskpackV2Manifest(
        makeEvolutionManifestObject({
          localChecks: [],
          targetMatrix: [{
            id: 'h100-sxm',
            platform: 'linux/amd64',
            variant: 'cuda12',
            hardware: {
              accelerator: 'sm_90a',
              isolationMode: 'whole_device',
              deviceCount: 1,
            },
          }],
          externalGates: [{
            id: 'bench-h100',
            implementation: 'benchmark-gate.v1',
            gateId: 'Roofline Gate v1',
            endpointId: 'bench-relay',
            required: true,
            targetCellId: 'h100-sxm',
            heldOutWorkloadId: 'kernel.matmul.v1',
            metricThresholds: [
              { kind: 'bounds', metric: 'latency_ms', max: 10 },
            ],
          }],
        }) as Json,
      );

      const compiled = await compileDeclarativeTaskpack(legacyHardwareManifest, {
        mode: 'candidate',
        executionMode: 'delegated',
        repository: 'local/kernel-repo',
        repositoryRoot: repoRoot,
        baseRevision: BASE_SHA,
        sourceRevision: BASE_SHA,
        budgets: DEFAULT_HOST_BUDGETS,
        gateEndpoints: [
          {
            id: 'bench-relay',
            url: 'http://127.0.0.1:42010/v1/benchmark/jobs',
            signingCredentialRef: 'bench-signing',
            authCredentialRef: null,
          },
        ],
        credentialEnvMap: { gate: 'BENCH_SIGNING_SECRET' },
      });

      const hw = compiled.config.spec.task.spec.target.matrix?.[0]?.hardware as unknown as Record<string, unknown>;
      assert.equal(Object.hasOwn(hw, 'forbiddenSymbolPatterns'), false);
      assert.equal(Object.hasOwn(hw, 'maxRegisterCount'), false);
      assert.equal(Object.hasOwn(hw, 'maxLocalSpillBytes'), false);
      const threshold = compiled.config.spec.task.spec.acceptance.checks.find(c => c.id === 'bench-h100')
        ?.metricThresholds?.[0] as unknown as Record<string, unknown>;
      assert.equal(Object.hasOwn(threshold, 'bucketScope'), false);

      // Compare canonical TaskContract & TaskLock digests against a fresh copy stripped of any optional keys
      const clonedContract = JSON.parse(JSON.stringify(compiled.config.spec.task)) as Json;
      const revalidated = validateDocument(clonedContract, 'TaskContract');
      assert.equal(revalidated.ok, true);
      if (!revalidated.ok) return;
      assert.equal(canonical(compiled.config.spec.task), canonical(revalidated.value));
      const lockA = admitTask(compiled.config.spec.task, { admissionId: 'adm-parity', runId: 'run-parity' });
      const lockB = admitTask(revalidated.value, { admissionId: 'adm-parity', runId: 'run-parity' });
      assert.equal(lockA.ok && lockB.ok, true);
      if (lockA.ok && lockB.ok) {
        assert.equal(lockA.value.spec.contractHash.hex, lockB.value.spec.contractHash.hex);
        assert.equal(lockA.value.spec.lockHash.hex, lockB.value.spec.lockHash.hex);
      }
    });
  });

  it('projects hardwareScope for memory selection (sm_89 isolates sm_100a and ascend_910b) and local finalization', async () => {
    const sm89Cell: TargetMatrixCell = {
      id: 'l40s-sm89',
      platform: 'linux/amd64',
      variant: 'cuda12',
      hardware: {
        accelerator: 'sm_89',
        isolationMode: 'whole_device',
        deviceCount: 1,
        driverConstraint: '>=550.54',
      },
    };
    const sm89NoDriverCell: TargetMatrixCell = {
      id: 'l40s-sm89',
      platform: 'linux/amd64',
      variant: 'cuda12',
      hardware: {
        accelerator: 'sm_89',
        isolationMode: 'whole_device',
      },
    };
    const legacyCell: TargetMatrixCell = {
      id: 'cpu-x64',
      platform: 'linux/amd64',
      variant: 'default',
    };

    assert.deepEqual(projectMemoryHardwareScope(sm89Cell), {
      accelerator: 'sm_89',
      driverConstraint: '>=550.54',
    });
    const noDriverScope = projectMemoryHardwareScope(sm89NoDriverCell);
    assert.deepEqual(noDriverScope, { accelerator: 'sm_89' });
    assert.equal(Object.hasOwn(noDriverScope as unknown as Record<string, unknown>, 'driverConstraint'), false);
    assert.equal(projectMemoryHardwareScope(legacyCell), undefined);
    assert.equal(projectMemoryHardwareScope(null), undefined);
    assert.equal(projectMemoryHardwareScope(undefined), undefined);

    await withTempDir(async dir => {
      const repoRoot = join(dir, 'repo');
      const runRoot = join(dir, 'runs');
      await mkdir(join(repoRoot, 'src'), { recursive: true });
      await mkdir(runRoot, { recursive: true, mode: 0o700 });
      await writeFile(join(repoRoot, 'src', 'kernel.cu'), '// kernel\n', 'utf8');

      // Seed memory store with: unscoped entry, sm_89 matching entry, sm_100a entry, ascend_910b entry, and mismatched driver entry
      const entries: MemoryEntry[] = [
        makeMemoryEntry({
          id: 'mem-unscoped',
          claimKey: 'unscoped.rule',
          claim: 'Shared repo invariant applies to all accelerators.',
        }),
        makeMemoryEntry({
          id: 'mem-sm89-match',
          claimKey: 'sm89.shared-mem',
          claim: 'sm_89 favors 48 KiB shared memory tiling.',
          hardwareScope: { accelerator: 'sm_89', driverConstraint: '>=550.54' },
        }),
        makeMemoryEntry({
          id: 'mem-sm100a-foreign',
          claimKey: 'sm100a.tmem',
          claim: 'sm_100a tensor memory pipeline rule.',
          hardwareScope: { accelerator: 'sm_100a', driverConstraint: '>=570.0' },
        }),
        makeMemoryEntry({
          id: 'mem-ascend-foreign',
          claimKey: 'ascend.ub',
          claim: 'ascend_910b unified buffer tiling rule.',
          hardwareScope: { accelerator: 'ascend_910b' },
        }),
        makeMemoryEntry({
          id: 'mem-sm89-driver-mismatch',
          claimKey: 'sm89.driver-old',
          claim: 'sm_89 legacy driver workaround.',
          hardwareScope: { accelerator: 'sm_89', driverConstraint: '>=535.0' },
        }),
      ];
      const baseIndex: Omit<MemoryStoreIndex, 'storeDigest'> = {
        version: 1,
        taskpack: 'evo-kernel',
        repository: 'local/kernel-repo',
        updatedAtMs: 1_700_000_000_000,
        entries,
        retired: [],
      };
      const seededIndex: MemoryStoreIndex = Object.freeze({
        ...baseIndex,
        storeDigest: storeDigestOf(baseIndex),
      });
      const memDir = join(repoRoot, '.loopwright', 'memory', 'evo-kernel');
      const entriesDir = join(memDir, 'entries');
      await mkdir(entriesDir, { recursive: true });
      await writeFile(join(memDir, 'index.json'), serializeMemoryStoreIndex(seededIndex), 'utf8');
      for (const entry of entries) {
        await writeFile(join(entriesDir, `${entry.id}.md`), renderEntryMarkdown(entry), 'utf8');
      }

      const sm89Manifest = validateTaskpackV2Manifest(
        makeEvolutionManifestObject({
          localChecks: [],
          targetMatrix: [sm89Cell],
          externalGates: [{
            id: 'bench-sm89',
            implementation: 'benchmark-gate.v1',
            gateId: 'Roofline Gate v1',
            endpointId: 'bench-relay',
            required: true,
            targetCellId: 'l40s-sm89',
            heldOutWorkloadId: 'kernel.matmul.v1',
          }],
        }) as Json,
      );

      const compiled = await compileDeclarativeTaskpack(sm89Manifest, {
        mode: 'candidate',
        executionMode: 'delegated',
        repository: 'local/kernel-repo',
        repositoryRoot: repoRoot,
        baseRevision: BASE_SHA,
        sourceRevision: BASE_SHA,
        nowMs: 1_700_000_010_000,
        budgets: DEFAULT_HOST_BUDGETS,
        gateEndpoints: [
          {
            id: 'bench-relay',
            url: 'http://127.0.0.1:42010/v1/benchmark/jobs',
            signingCredentialRef: 'bench-signing',
            authCredentialRef: null,
          },
        ],
        credentialEnvMap: { gate: 'BENCH_SIGNING_SECRET' },
      });

      assert.equal(compiled.activeMemory?.activeEntryCount, 2, JSON.stringify(compiled.activeMemory));
      assert.equal(compiled.activeMemory?.excludedEntryCount, 3, JSON.stringify(compiled.activeMemory));
      const memResource = (compiled.instructionResources ?? []).find(r => r.id.startsWith('memory.'));
      assert.ok(memResource, 'expected staged active memory resource');
      const rendered = memResource.bytes.toString('utf8');
      assert.match(rendered, /mem-unscoped/);
      assert.match(rendered, /mem-sm89-match/);
      assert.doesNotMatch(rendered, /mem-sm100a-foreign/);
      assert.doesNotMatch(rendered, /mem-ascend-foreign/);
      assert.doesNotMatch(rendered, /mem-sm89-driver-mismatch/);

      // Finalize a local-only run with sm89Cell and verify persisted entry carries hardwareScope
      const runId = 'run-sm89-hw-scope-1';
      const locked = admitTask(compiled.config.spec.task, { admissionId: 'adm-sm89-1', runId });
      assert.equal(locked.ok, true);
      if (!locked.ok) return;
      const runDir = join(runRoot, runId);
      const artifactsDir = join(runDir, 'artifacts');
      await mkdir(artifactsDir, { recursive: true, mode: 0o700 });
      await writeFile(join(runDir, 'run.json'), JSON.stringify({ version: 1, identity: { lock: locked.value } }), 'utf8');
      const planBytes = Buffer.from(JSON.stringify({ stage: 'execution', note: 'sm89 timeout' }), 'utf8');
      const planRef = digestArtifact('plan-incident.bin', planBytes);
      assert.equal(planRef.ok, true);
      if (!planRef.ok) return;
      await writeFile(join(artifactsDir, planRef.value.name), planBytes);
      const incident: ControllerIncident = {
        version: 1,
        code: 'DEADLINE',
        runId,
        lockHash: locked.value.spec.lockHash,
        stage: 'execution',
        knownReferences: [planRef.value],
        unavailable: ['candidate'],
        cleanup: 'complete',
      };
      await writeFile(join(artifactsDir, `incident-${runId}.bin`), JSON.stringify(incident), 'utf8');

      const summary = await finalizeLocalTurnkeyMemory({
        runRoot,
        runId,
        repositoryRoot: repoRoot,
        repositoryFullName: 'local/kernel-repo',
        manifest: sm89Manifest,
        baseRevision: BASE_SHA,
        targetMatrix: sm89Cell,
        nowMs: 1_700_000_020_000,
        scrubber: new SecretScrubber(),
      });
      assert.equal(summary.status, 'local_only', summary.reason ?? '');
      const reloaded = await loadMemoryStore(repoRoot, 'evo-kernel', 'local/kernel-repo', '.loopwright/memory');
      const incidentEntry = reloaded.index.entries.find(e => e.sourceRef.runId === runId);
      assert.ok(incidentEntry, 'expected persisted incident memory entry');
      assert.deepEqual({ ...incidentEntry.scope.hardwareScope }, {
        accelerator: 'sm_89',
        driverConstraint: '>=550.54',
      });
    });
  });
});
