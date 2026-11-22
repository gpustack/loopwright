import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import {
  compilePlan,
  loadTrustedConfiguration,
  stepNext,
  stepSubmit,
  type ControllerIncident,
} from '@loopwright/controller';
import { admitTask, bindSubject, digestArtifact, validateDocument } from '@loopwright/core';
import { loadMemoryStore } from '@loopwright/memory';
import {
  collectHostCredentialEnvNames,
  collectHostGateCredentialEnvNames,
  compileDeclarativeTaskpack,
  createTaskpackDecisionPort,
  DEFAULT_HOST_BUDGETS,
  DEFAULT_LOCAL_COMMAND_GATE_ENV,
  finalizeLocalTurnkeyMemory,
  loadPiModelsJson,
  LOCAL_COMMAND_GATE_ENDPOINT_ID,
  openStagedTaskpackStepGate,
  parseTaskpackManifest,
  projectMemoryTargetMatrixCell,
  resolveExternalMcpConfigs,
  resolveTaskpackModelCandidates,
  runTaskpackPreflight,
  SecretScrubber,
  serializePrettyYaml,
  stageCompiledInstructionResources,
  stageTaskpackForStep,
  TaskpackError,
  validateTaskpackV2Manifest,
  type HostGateEndpointPlan,
  type Json,
  type TargetMatrixCell,
} from '../src/index.js';

const BASE_SHA = 'a'.repeat(40);

async function withTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const base = await realpath(tmpdir());
  const dir = await mkdtemp(join(base, 'lw-tp-bench-gate-'));
  try {
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function makeHardwareManifestObject(overrides: {
  readonly targetMatrix?: unknown;
  readonly externalGates?: unknown;
  readonly memory?: unknown;
} = {}): Record<string, unknown> {
  return {
    apiVersion: 'loopwright.dev/v1alpha1',
    kind: 'Taskpack',
    metadata: { name: 'kernel-bench' },
    spec: {
      goal: {
        candidate: 'Optimize CUDA kernel within Roofline and latency bounds.',
        noChange: 'Confirm no kernel changes needed.',
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
              },
            },
          ],
      },
      verification: {
        localChecks: [],
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
              maxPreemptions: 3,
              allowSyntheticHardwareProbe: true,
              metricThresholds: [
                { kind: 'bounds', metric: 'latency_ms', min: 0, max: 12.5 },
                {
                  kind: 'comparative',
                  metric: 'throughput_tflops',
                  baselineMetric: 'baseline_tflops',
                  operator: 'min_ratio',
                  threshold: 1.15,
                },
                {
                  kind: 'comparative',
                  metric: 'max_abs_error',
                  baselineMetric: 'baseline_error',
                  operator: 'max_delta',
                  threshold: 0.001,
                },
              ],
            },
          ],
      },
      ...(overrides.memory !== undefined ? { memory: overrides.memory } : {}),
    },
  };
}

function expectManifestInvalid(fn: () => unknown, expectedPath?: string): void {
  assert.throws(
    fn,
    (err: unknown) => {
      if (!(err instanceof TaskpackError)) return false;
      if (err.code !== 'TASKPACK_MANIFEST_INVALID') return false;
      if (expectedPath !== undefined && err.path !== expectedPath) return false;
      return true;
    },
  );
}

describe('benchmark-gate.v1 and hardware target.matrix compilation', () => {
  it('compiles hardware target.matrix cells and host-bound benchmark-gate.v1 through controller compilePlan', async () => {
    await withTempDir(async dir => {
      const repoRoot = join(dir, 'repo');
      const runRoot = join(dir, 'runs');
      await mkdir(join(repoRoot, 'src'), { recursive: true });
      await mkdir(runRoot, { recursive: true, mode: 0o700 });
      await writeFile(join(repoRoot, 'src', 'kernel.cu'), '// kernel\n', 'utf8');

      const yamlText = serializePrettyYaml(makeHardwareManifestObject());
      const manifest = parseTaskpackManifest(yamlText);
      const cell = manifest.spec.target?.matrix?.[0];
      assert.deepEqual(cell, {
        id: 'h100-sxm',
        platform: 'linux/amd64',
        variant: 'cuda12',
        hardware: {
          accelerator: 'sm_90a',
          isolationMode: 'whole_device',
          deviceCount: 1,
          driverConstraint: '>=550.54',
          topology: 'nvlink',
        },
      });

      const hostGateEndpoint: HostGateEndpointPlan = {
        id: 'bench-relay',
        url: 'http://127.0.0.1:41999/v1/benchmark/jobs',
        signingCredentialRef: 'bench-signing',
        authCredentialRef: 'bench-auth',
        timeoutMs: 60_000,
        maxPollMs: 300_000,
        pollInitialMs: 250,
        pollMaxMs: 5_000,
        jitter: 100,
      };

      for (const executionMode of ['pi', 'delegated'] as const) {
        const compiled = await compileDeclarativeTaskpack(manifest, {
          mode: 'candidate',
          executionMode,
          repository: 'local/kernel-repo',
          repositoryRoot: repoRoot,
          baseRevision: BASE_SHA,
          sourceRevision: BASE_SHA,
          budgets: DEFAULT_HOST_BUDGETS,
          gateEndpoints: [hostGateEndpoint],
          credentialEnvMap: {
            ...(executionMode === 'pi' ? { provider: 'OPENAI_API_KEY' } : {}),
            gate: 'BENCH_SIGNING_SECRET',
            byCredentialRef: { 'bench-auth': 'BENCH_AUTH_TOKEN' },
          },
        });

        const compiledTask = compiled.config.spec.task;
        assert.deepEqual(JSON.parse(JSON.stringify(compiledTask.spec.target.matrix)), [
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
            },
          },
        ]);
        const check = compiledTask.spec.acceptance.checks.find(c => c.id === 'bench-h100');
        assert.ok(check);
        assert.deepEqual(check.allowedEvidenceLevels, ['hardware_execution']);
        assert.equal(check.targetCellId, 'h100-sxm');
        assert.equal(check.allowSyntheticHardwareProbe, true);
        assert.equal(check.metricThresholds?.length, 3);

        const handler = compiled.registry.spec.handlers.find(h => h.id === 'bench-h100');
        assert.ok(handler);
        assert.equal(handler.implementation, 'benchmark-gate.v1');
        assert.deepEqual(handler.capabilities, ['hardware_execution', 'read_only']);
        assert.deepEqual(handler.parameters, {
          checkId: 'bench-h100',
          endpointRef: 'bench-relay',
          gateId: 'Roofline Gate v1',
          heldOutWorkloadId: 'kernel.matmul.v1',
          maxPreemptions: 3,
        });

        const trustedDir = join(runRoot, `trusted-${executionMode}`);
        const regDir = join(trustedDir, 'registry');
        const cfgDir = join(trustedDir, 'config');
        await mkdir(regDir, { recursive: true, mode: 0o700 });
        await mkdir(cfgDir, { recursive: true, mode: 0o700 });
        await chmod(trustedDir, 0o700);
        const regPath = join(regDir, 'registry.yaml');
        const cfgPath = join(cfgDir, 'config.yaml');
        await writeFile(regPath, compiled.registryBytes, { mode: 0o600 });
        await writeFile(cfgPath, serializePrettyYaml(compiled.config), { mode: 0o600 });
        await stageCompiledInstructionResources(regDir, compiled.instructionResources);

        const prevOai = process.env['OPENAI_API_KEY'];
        const prevSign = process.env['BENCH_SIGNING_SECRET'];
        const prevAuth = process.env['BENCH_AUTH_TOKEN'];
        process.env['OPENAI_API_KEY'] = 'sk-test-token-12345';
        process.env['BENCH_SIGNING_SECRET'] = 'bench-signing-secret-12345';
        process.env['BENCH_AUTH_TOKEN'] = 'bench-auth-token-12345';
        try {
          const loaded = await loadTrustedConfiguration({
            configPath: cfgPath,
            registryPath: regPath,
            registrySha256: compiled.registrySha256,
            untrustedRoots: [repoRoot],
          });
          assert.equal(loaded.ok, true, loaded.ok ? '' : JSON.stringify(loaded.error));
          if (loaded.ok) {
            const plan = await compilePlan(loaded.value);
            assert.equal(plan.ok, true, plan.ok ? '' : JSON.stringify(plan.error));
            if (plan.ok) {
              const slot = plan.value.verifierSlots.find(s => s.checkId === 'bench-h100');
              assert.ok(slot);
              assert.equal(slot.handler.implementation, 'benchmark-gate.v1');
              assert.deepEqual(
                plan.value.evidenceNeeds.find(e => e.checkId === 'bench-h100'),
                { checkId: 'bench-h100', levels: ['hardware_execution'] },
              );
            }
          }
        } finally {
          if (prevOai === undefined) delete process.env['OPENAI_API_KEY']; else process.env['OPENAI_API_KEY'] = prevOai;
          if (prevSign === undefined) delete process.env['BENCH_SIGNING_SECRET']; else process.env['BENCH_SIGNING_SECRET'] = prevSign;
          if (prevAuth === undefined) delete process.env['BENCH_AUTH_TOKEN']; else process.env['BENCH_AUTH_TOKEN'] = prevAuth;
        }
      }
    });
  });

  it('omits unset optional fields on minimal hardware cells and benchmark-gate.v1 checks while passing compilePlan', async () => {
    await withTempDir(async dir => {
      const repoRoot = join(dir, 'repo');
      const runRoot = join(dir, 'runs');
      await mkdir(join(repoRoot, 'src'), { recursive: true });
      await mkdir(runRoot, { recursive: true, mode: 0o700 });

      const manifest = validateTaskpackV2Manifest(
        makeHardwareManifestObject({
          targetMatrix: [
            {
              id: 'mi300x',
              platform: 'linux/amd64',
              variant: 'rocm6',
              hardware: {
                accelerator: 'gfx942',
                isolationMode: 'sliced',
              },
            },
          ],
          externalGates: [
            {
              id: 'bench-rocm',
              implementation: 'benchmark-gate.v1',
              gateId: 'rocm-gate',
              endpointId: 'bench-relay',
              required: true,
              targetCellId: 'mi300x',
              heldOutWorkloadId: 'gemm.v1',
            },
          ],
        }) as Json,
      );

      assert.deepEqual(Object.keys(manifest.spec.target!.matrix![0]!.hardware!), ['accelerator', 'isolationMode']);
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
            url: 'http://127.0.0.1:42000/v1/benchmark/jobs',
            signingCredentialRef: 'bench-signing',
            authCredentialRef: null,
          },
        ],
        credentialEnvMap: { gate: 'BENCH_SIGNING_SECRET' },
      });

      const handler = compiled.registry.spec.handlers.find(h => h.id === 'bench-rocm');
      assert.ok(handler);
      assert.deepEqual(Object.keys(handler.parameters).sort(), ['checkId', 'endpointRef', 'gateId', 'heldOutWorkloadId']);
      const check = compiled.config.spec.task.spec.acceptance.checks.find(c => c.id === 'bench-rocm');
      assert.ok(check);
      assert.deepEqual(Object.keys(check).sort(), ['allowedEvidenceLevels', 'id', 'targetCellId']);

      const regDir = join(runRoot, 'reg');
      const cfgDir = join(runRoot, 'cfg');
      await mkdir(regDir, { recursive: true, mode: 0o700 });
      await mkdir(cfgDir, { recursive: true, mode: 0o700 });
      await chmod(runRoot, 0o700);
      const regPath = join(regDir, 'registry.yaml');
      const cfgPath = join(cfgDir, 'config.yaml');
      await writeFile(regPath, compiled.registryBytes, { mode: 0o600 });
      await writeFile(cfgPath, serializePrettyYaml(compiled.config), { mode: 0o600 });

      const prevSign = process.env['BENCH_SIGNING_SECRET'];
      process.env['BENCH_SIGNING_SECRET'] = 'bench-signing-secret-12345';
      try {
        const loaded = await loadTrustedConfiguration({
          configPath: cfgPath,
          registryPath: regPath,
          registrySha256: compiled.registrySha256,
          untrustedRoots: [repoRoot],
        });
        assert.equal(loaded.ok, true, loaded.ok ? '' : JSON.stringify(loaded.error));
        if (loaded.ok) {
          const plan = await compilePlan(loaded.value);
          assert.equal(plan.ok, true, plan.ok ? '' : JSON.stringify(plan.error));
        }
      } finally {
        if (prevSign === undefined) delete process.env['BENCH_SIGNING_SECRET']; else process.env['BENCH_SIGNING_SECRET'] = prevSign;
      }
    });
  });

  it('preserves byte-identical canonical JSON and digests for legacy { id, platform, variant } cells', async () => {
    const legacyManifest = validateTaskpackV2Manifest({
      apiVersion: 'loopwright.dev/v1alpha1',
      kind: 'Taskpack',
      metadata: { name: 'legacy-matrix' },
      spec: {
        goal: { candidate: 'Update src.', noChange: 'No change.' },
        scope: { writable: ['src/**'], protected: [] },
        target: {
          matrix: [{ id: 'linux-x64', platform: 'linux/amd64', variant: 'default' }],
        },
        verification: {
          localChecks: [{ id: 'nc', implementation: 'no-change.v1' }],
          externalGates: [
            {
              id: 'legacy-gate',
              gateId: 'verify-build',
              endpointId: 'ci-gate',
              required: true,
              url: 'https://gate.example.test/verify',
              signingCredentialRef: 'LEGACY_GATE_SECRET',
            },
          ],
        },
      },
    } as Json);

    assert.deepEqual(Object.keys(legacyManifest.spec.target!.matrix![0]!), ['id', 'platform', 'variant']);
    assert.equal(Object.hasOwn(legacyManifest.spec.verification.externalGates[0]!, 'implementation'), false);

    const compiled = await compileDeclarativeTaskpack(legacyManifest, {
      mode: 'candidate',
      executionMode: 'delegated',
      repository: 'local/legacy-repo',
      baseRevision: BASE_SHA,
      sourceRevision: BASE_SHA,
      budgets: DEFAULT_HOST_BUDGETS,
    });

    const compiledCell = compiled.config.spec.task.spec.target.matrix![0]!;
    assert.deepEqual(Object.keys(compiledCell), ['id', 'platform', 'variant']);
    assert.equal(
      JSON.stringify(compiledCell),
      JSON.stringify({ id: 'linux-x64', platform: 'linux/amd64', variant: 'default' }),
    );

    const lock = admitTask(compiled.config.spec.task, { admissionId: 'adm-1', runId: 'run-1' });
    assert.equal(lock.ok, true);
    if (lock.ok) {
      assert.equal(lock.value.spec.contractHash.hex, 'b54c3904d9b0029ecec0df32dd44d09871736ba323ec6862a372e091a731b72e');
      assert.equal(lock.value.spec.lockHash.hex, '79aa805a37ebd9b4404622a46e43b09fa35b9b76f7b4199a8f835f56bdb23f37');
      const emptyManifest = {
        apiVersion: 'loopwright.dev/v1alpha1',
        kind: 'ArtifactManifest',
        metadata: { id: 'candidate-1' },
        spec: { entries: [] },
      };
      const subj = bindSubject(lock.value, emptyManifest);
      assert.equal(subj.ok, true);
      if (subj.ok) {
        assert.equal(subj.value.targetMatrixDigest?.hex, 'da1c8c1829347358e2cf04365c39cdf8bb939887ec6c803a13ff83af2cc14e99');
      }
    }
  });

  it('forbids manifest-level url, signingCredentialRef, and authCredentialRef overrides on benchmark-gate.v1', async () => {
    const baseGate = (makeHardwareManifestObject().spec as Record<string, unknown>)['verification'] as {
      externalGates: Record<string, unknown>[];
    };
    const validGate = baseGate.externalGates[0]!;

    for (const [field, value] of [
      ['url', 'https://attacker.example/steal'],
      ['url', null],
      ['signingCredentialRef', 'ATTACKER_SIGN_SECRET'],
      ['signingCredentialRef', 'custom-signer'],
      ['authCredentialRef', 'ATTACKER_AUTH_TOKEN'],
      ['authCredentialRef', null],
    ] as const) {
      expectManifestInvalid(
        () => validateTaskpackV2Manifest(
          makeHardwareManifestObject({
            externalGates: [{ ...validGate, [field]: value }],
          }) as Json,
          { allowLoopbackHttp: true },
        ),
        `/spec/verification/externalGates/0/${field}`,
      );
    }

    // Missing host gateEndpoints binding must fail closed in compileDeclarativeTaskpack
    const validManifest = validateTaskpackV2Manifest(makeHardwareManifestObject() as Json);
    await assert.rejects(
      () => compileDeclarativeTaskpack(validManifest, {
        mode: 'candidate',
        executionMode: 'delegated',
        repository: 'local/kernel-repo',
        baseRevision: BASE_SHA,
        sourceRevision: BASE_SHA,
        budgets: DEFAULT_HOST_BUDGETS,
      }),
      (err: unknown) => err instanceof TaskpackError && err.code === 'TASKPACK_HOST_BINDING_INVALID',
    );

    // Defense-in-depth: forged manifest object with url on benchmark-gate.v1 is rejected by compiler
    const forgedManifest = {
      ...validManifest,
      spec: {
        ...validManifest.spec,
        verification: {
          ...validManifest.spec.verification,
          externalGates: [
            {
              ...validManifest.spec.verification.externalGates[0]!,
              url: 'https://evil.example/steal',
            },
          ],
        },
      },
    };
    await assert.rejects(
      () => compileDeclarativeTaskpack(forgedManifest, {
        mode: 'candidate',
        executionMode: 'delegated',
        repository: 'local/kernel-repo',
        baseRevision: BASE_SHA,
        sourceRevision: BASE_SHA,
        budgets: DEFAULT_HOST_BUDGETS,
        gateEndpoints: [
          {
            id: 'bench-relay',
            url: 'https://trusted-relay.example/v1/benchmark/jobs',
            signingCredentialRef: 'bench-signing',
            authCredentialRef: null,
          },
        ],
        credentialEnvMap: { gate: 'BENCH_SIGNING_SECRET' },
      }),
      (err: unknown) => err instanceof TaskpackError && err.code === 'TASKPACK_MANIFEST_INVALID',
    );

    // Endpoint-aliasing attack: sibling gate.v1 cannot override url on benchmark-gate.v1 endpointId
    const aliasedManifest = validateTaskpackV2Manifest(
      makeHardwareManifestObject({
        externalGates: [
          validGate,
          {
            id: 'sneaky-alias',
            gateId: 'alias-gate',
            endpointId: 'bench-relay',
            required: false,
            url: 'https://evil.example/redirect',
          },
        ],
      }) as Json,
    );
    await assert.rejects(
      () => compileDeclarativeTaskpack(aliasedManifest, {
        mode: 'candidate',
        executionMode: 'delegated',
        repository: 'local/kernel-repo',
        baseRevision: BASE_SHA,
        sourceRevision: BASE_SHA,
        budgets: DEFAULT_HOST_BUDGETS,
        gateEndpoints: [
          {
            id: 'bench-relay',
            url: 'https://trusted-relay.example/v1/benchmark/jobs',
            signingCredentialRef: 'bench-signing',
            authCredentialRef: null,
          },
        ],
        credentialEnvMap: { gate: 'BENCH_SIGNING_SECRET' },
      }),
      (err: unknown) => err instanceof TaskpackError && err.code === 'TASKPACK_MANIFEST_INVALID',
    );
  });

  it('rejects invalid hardware cells, benchmark-gate.v1 parameters, thresholds, -0, surrogates, and hardware fields on gate.v1', () => {
    const validGate = ((makeHardwareManifestObject().spec as Record<string, unknown>)['verification'] as {
      externalGates: Record<string, unknown>[];
    }).externalGates[0]!;

    // Hardware cell rejections
    const badHardwareSpecs: unknown[] = [
      { accelerator: '', isolationMode: 'whole_device' },
      { accelerator: ' sm_90a', isolationMode: 'whole_device' },
      { accelerator: 'sm_90\u00e9', isolationMode: 'whole_device' },
      { accelerator: 'a'.repeat(65), isolationMode: 'whole_device' },
      { accelerator: 'sm_90a', isolationMode: 'shared' },
      { accelerator: 'sm_90a', isolationMode: 'whole_device', deviceCount: 0 },
      { accelerator: 'sm_90a', isolationMode: 'whole_device', deviceCount: 65 },
      { accelerator: 'sm_90a', isolationMode: 'whole_device', deviceCount: 1.5 },
      { accelerator: 'sm_90a', isolationMode: 'whole_device', deviceCount: -0 },
      { accelerator: 'sm_90a', isolationMode: 'whole_device', driverConstraint: '>=550.bad' },
      { accelerator: 'sm_90a', isolationMode: 'whole_device', driverConstraint: '550\uD800' },
      { accelerator: 'sm_90a', isolationMode: 'whole_device', topology: 'nvlink\uDC00' },
      { accelerator: 'sm_90a', isolationMode: 'whole_device', extra: true },
    ];
    for (const hardware of badHardwareSpecs) {
      expectManifestInvalid(() => validateTaskpackV2Manifest(
        makeHardwareManifestObject({
          targetMatrix: [{ id: 'h100-sxm', platform: 'linux/amd64', variant: 'cuda12', hardware }],
        }) as Json,
      ));
    }

    // Missing or non-hardware targetCellId
    expectManifestInvalid(
      () => validateTaskpackV2Manifest(
        makeHardwareManifestObject({
          targetMatrix: [{ id: 'cpu-only', platform: 'linux/amd64', variant: 'default' }],
          externalGates: [{ ...validGate, targetCellId: 'cpu-only' }],
        }) as Json,
      ),
      '/spec/verification/externalGates/0/targetCellId',
    );
    expectManifestInvalid(
      () => validateTaskpackV2Manifest(
        makeHardwareManifestObject({
          externalGates: [{ ...validGate, targetCellId: 'non-existent' }],
        }) as Json,
      ),
      '/spec/verification/externalGates/0/targetCellId',
    );
    expectManifestInvalid(
      () => validateTaskpackV2Manifest(
        makeHardwareManifestObject({
          targetMatrix: null,
          externalGates: [validGate],
        }) as Json,
      ),
      '/spec/verification/externalGates/0/targetCellId',
    );

    // Invalid gateId, heldOutWorkloadId, maxPreemptions, allowSyntheticHardwareProbe, implementation
    expectManifestInvalid(
      () => validateTaskpackV2Manifest(makeHardwareManifestObject({ externalGates: [{ ...validGate, gateId: 'gate\u00e9' }] }) as Json),
      '/spec/verification/externalGates/0/gateId',
    );
    expectManifestInvalid(
      () => validateTaskpackV2Manifest(makeHardwareManifestObject({ externalGates: [{ ...validGate, gateId: ' leading' }] }) as Json),
      '/spec/verification/externalGates/0/gateId',
    );
    expectManifestInvalid(
      () => validateTaskpackV2Manifest(makeHardwareManifestObject({ externalGates: [{ ...validGate, heldOutWorkloadId: 'INVALID_UPPER' }] }) as Json),
      '/spec/verification/externalGates/0/heldOutWorkloadId',
    );
    for (const badPreemptions of [-1, 17, 1.5, -0, '3']) {
      expectManifestInvalid(
        () => validateTaskpackV2Manifest(makeHardwareManifestObject({ externalGates: [{ ...validGate, maxPreemptions: badPreemptions }] }) as Json),
        '/spec/verification/externalGates/0/maxPreemptions',
      );
    }
    expectManifestInvalid(
      () => validateTaskpackV2Manifest(makeHardwareManifestObject({ externalGates: [{ ...validGate, allowSyntheticHardwareProbe: 'true' }] }) as Json),
      '/spec/verification/externalGates/0/allowSyntheticHardwareProbe',
    );
    expectManifestInvalid(
      () => validateTaskpackV2Manifest(makeHardwareManifestObject({ externalGates: [{ ...validGate, implementation: 'unknown.v1' }] }) as Json),
      '/spec/verification/externalGates/0/implementation',
    );

    // Invalid metricThresholds
    const badThresholds: unknown[] = [
      [{ kind: 'bounds', metric: 'latency_ms' }],
      [{ kind: 'bounds', metric: 'latency_ms', min: 10, max: 5 }],
      [{ kind: 'bounds', metric: 'latency_ms', min: -0 }],
      [{ kind: 'bounds', metric: 'latency_ms', max: Number.NaN }],
      [{ kind: 'bounds', metric: 'latency_ms', max: Number.POSITIVE_INFINITY }],
      [{ kind: 'bounds', metric: 'latency_ms', max: 5, extra: 1 }],
      [{ kind: 'comparative', metric: 'speedup', baselineMetric: 'base', operator: 'min_ratio', threshold: Number.NaN }],
      [{ kind: 'comparative', metric: 'speedup', baselineMetric: 'base', operator: 'max_ratio', threshold: Number.POSITIVE_INFINITY }],
      [{ kind: 'comparative', metric: 'speedup', baselineMetric: 'base', operator: 'max_delta', threshold: -0 }],
      [{ kind: 'comparative', metric: 'speedup', baselineMetric: 'base', operator: 'bad_op', threshold: 1 }],
      [{ kind: 'comparative', metric: '123bad', baselineMetric: 'base', operator: 'max_delta', threshold: 1 }],
      [{ kind: 'other', metric: 'x', max: 1 }],
      Array.from({ length: 33 }, (_, i) => ({ kind: 'bounds', metric: `m_${i}`, max: 10 })),
    ];
    for (const metricThresholds of badThresholds) {
      expectManifestInvalid(() => validateTaskpackV2Manifest(
        makeHardwareManifestObject({
          externalGates: [{ ...validGate, metricThresholds }],
        }) as Json,
      ));
    }

    // Disallow hardware-only fields on gate.v1 (both implicit and explicit)
    for (const implPatch of [{}, { implementation: 'gate.v1' }] as const) {
      for (const hwField of [
        { targetCellId: 'h100-sxm' },
        { heldOutWorkloadId: 'kernel.matmul.v1' },
        { maxPreemptions: 2 },
        { allowSyntheticHardwareProbe: true },
        { metricThresholds: [{ kind: 'bounds', metric: 'latency_ms', max: 10 }] },
      ]) {
        expectManifestInvalid(() => validateTaskpackV2Manifest(
          makeHardwareManifestObject({
            externalGates: [
              {
                id: 'legacy-gate',
                gateId: 'verify-build',
                endpointId: 'ci-gate',
                required: true,
                ...implPatch,
                ...hwField,
              },
            ],
          }) as Json,
        ));
      }
    }
  });

  it('projects hardware-bearing TargetMatrixCell to { id, platform, variant } in local turnkey-memory and active memory selection', async () => {
    const hwCell: TargetMatrixCell = {
      id: 'h100-sxm',
      platform: 'linux/amd64',
      variant: 'cuda12',
      hardware: {
        accelerator: 'sm_90a',
        isolationMode: 'whole_device',
        deviceCount: 1,
      },
    };
    const projected = projectMemoryTargetMatrixCell(hwCell);
    assert.deepEqual(projected, { id: 'h100-sxm', platform: 'linux/amd64', variant: 'cuda12' });
    assert.equal(Object.hasOwn(projected!, 'hardware'), false);
    assert.equal(projectMemoryTargetMatrixCell(null), null);
    assert.equal(projectMemoryTargetMatrixCell(undefined), null);

    await withTempDir(async dir => {
      const repoRoot = join(dir, 'repo');
      const runRoot = join(dir, 'runs');
      await mkdir(join(repoRoot, 'src'), { recursive: true });
      await mkdir(runRoot, { recursive: true, mode: 0o700 });
      await writeFile(join(repoRoot, 'src', 'kernel.cu'), '// kernel\n', 'utf8');

      const manifest = validateTaskpackV2Manifest(
        makeHardwareManifestObject({
          memory: {
            directory: '.loopwright/memory/kernel-bench',
            apply: 'local-only',
            onNoModelBudget: 'deterministic-observations-only',
          },
        }) as Json,
      );

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
            url: 'http://127.0.0.1:42001/v1/benchmark/jobs',
            signingCredentialRef: 'bench-signing',
            authCredentialRef: null,
          },
        ],
        credentialEnvMap: { gate: 'BENCH_SIGNING_SECRET' },
      });

      const runId = 'run-hw-mem-local-1';
      const locked = admitTask(compiled.config.spec.task, { admissionId: 'adm-hw-1', runId });
      assert.equal(locked.ok, true);
      if (!locked.ok) throw new Error('admitTask failed');

      const runDir = join(runRoot, runId);
      const artifactsDir = join(runDir, 'artifacts');
      await mkdir(artifactsDir, { recursive: true, mode: 0o700 });
      await writeFile(join(runDir, 'run.json'), JSON.stringify({ version: 1, identity: { lock: locked.value } }), 'utf8');

      const planBytes = Buffer.from(JSON.stringify({ stage: 'execution', note: 'preempted' }), 'utf8');
      const planRef = digestArtifact('plan-incident.bin', planBytes);
      assert.equal(planRef.ok, true);
      if (!planRef.ok) throw new Error('digestArtifact failed');
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

      const scrubber = new SecretScrubber();
      const summary = await finalizeLocalTurnkeyMemory({
        runRoot,
        runId,
        repositoryRoot: repoRoot,
        repositoryFullName: 'local/kernel-repo',
        manifest,
        baseRevision: BASE_SHA,
        targetMatrix: hwCell,
        scrubber,
      });

      assert.equal(summary.status, 'local_only', summary.reason ?? '');
      assert.equal(summary.entryCount, 1);

      const store = await loadMemoryStore(repoRoot, 'kernel-bench', 'local/kernel-repo', '.loopwright/memory');
      assert.equal(store.index.entries.length, 1);
      assert.deepEqual(store.index.entries[0]?.scope.targetMatrix, {
        id: 'h100-sxm',
        platform: 'linux/amd64',
        variant: 'cuda12',
      });

      // Re-compiling with populated memory store exercises selectActiveMemory against the hardware cell
      const recompiled = await compileDeclarativeTaskpack(manifest, {
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
            url: 'http://127.0.0.1:42001/v1/benchmark/jobs',
            signingCredentialRef: 'bench-signing',
            authCredentialRef: null,
          },
        ],
        credentialEnvMap: { gate: 'BENCH_SIGNING_SECRET' },
      });
      assert.equal(recompiled.activeMemory?.activeEntryCount, 1);
    });
  });

  it('enforces cross-endpoint credential isolation, legacy publication precedence, incomplete hostPlan rejection, explicit false/empty preservation, and core ratio parity', async () => {
    const baseGate = ((makeHardwareManifestObject().spec as Record<string, unknown>)['verification'] as {
      externalGates: Record<string, unknown>[];
    }).externalGates[0]!;

    // 1. Negative finite comparative ratio threshold (-0.25) matches @loopwright/core parity
    const ratioManifest = validateTaskpackV2Manifest(
      makeHardwareManifestObject({
        externalGates: [
          {
            ...baseGate,
            allowSyntheticHardwareProbe: false,
            metricThresholds: [
              {
                kind: 'comparative',
                metric: 'signed_score',
                baselineMetric: 'baseline_score',
                operator: 'max_ratio',
                threshold: -0.25,
              },
            ],
          },
        ],
      }) as Json,
    );
    const ratioCompiled = await compileDeclarativeTaskpack(ratioManifest, {
      mode: 'candidate',
      executionMode: 'delegated',
      repository: 'local/kernel-repo',
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
      credentialEnvMap: { byCredentialRef: { 'bench-signing': 'CUSTOM_H100_KEY' } },
    });
    assert.equal(validateDocument(ratioCompiled.config.spec.task, 'TaskContract').ok, true);
    const ratioCheck = ratioCompiled.config.spec.task.spec.acceptance.checks.find(c => c.id === 'bench-h100');
    assert.ok(ratioCheck);
    assert.equal(ratioCheck.allowSyntheticHardwareProbe, false);
    assert.equal(ratioCheck.metricThresholds?.[0]?.kind, 'comparative');

    // 2. Explicit empty metricThresholds: [] and allowSyntheticHardwareProbe: false are preserved
    const emptyThresholdsManifest = validateTaskpackV2Manifest(
      makeHardwareManifestObject({
        externalGates: [{ ...baseGate, allowSyntheticHardwareProbe: false, metricThresholds: [] }],
      }) as Json,
    );
    const emptyCompiled = await compileDeclarativeTaskpack(emptyThresholdsManifest, {
      mode: 'candidate',
      executionMode: 'delegated',
      repository: 'local/kernel-repo',
      baseRevision: BASE_SHA,
      sourceRevision: BASE_SHA,
      budgets: DEFAULT_HOST_BUDGETS,
      gateEndpoints: [
        {
          id: 'bench-relay',
          url: 'http://127.0.0.1:42011/v1/benchmark/jobs',
          signingCredentialRef: 'bench-signing',
          authCredentialRef: null,
        },
      ],
      credentialEnvMap: { gate: 'BENCH_SIGNING_SECRET' },
    });
    const emptyCheck = emptyCompiled.config.spec.task.spec.acceptance.checks.find(c => c.id === 'bench-h100');
    assert.ok(emptyCheck);
    assert.equal(Object.hasOwn(emptyCheck, 'allowSyntheticHardwareProbe'), true);
    assert.equal(emptyCheck.allowSyntheticHardwareProbe, false);
    assert.equal(Object.hasOwn(emptyCheck, 'metricThresholds'), true);
    assert.deepEqual(emptyCheck.metricThresholds, []);

    // 3. Cross-endpoint benchmark credential collision rejected in BOTH declaration orders (by ID and by env)
    const benchHostPlan: HostGateEndpointPlan = {
      id: 'bench-relay',
      url: 'http://127.0.0.1:42012/v1/benchmark/jobs',
      signingCredentialRef: 'bench-signing',
      authCredentialRef: 'bench-auth',
    };
    const collisionGates: readonly Record<string, unknown>[] = [
      {
        id: 'other-by-id',
        gateId: 'other-gate',
        endpointId: 'other-endpoint',
        required: false,
        url: 'https://other.example.test/gate',
        signingCredentialRef: 'bench-signing',
      },
      {
        id: 'other-by-env',
        gateId: 'other-gate',
        endpointId: 'other-endpoint',
        required: false,
        url: 'https://other.example.test/gate',
        signingCredentialRef: 'CUSTOM_H100_KEY',
      },
      {
        id: 'other-by-auth-id',
        gateId: 'other-gate',
        endpointId: 'other-endpoint',
        required: false,
        url: 'https://other.example.test/gate',
        signingCredentialRef: 'OTHER_GATE_SECRET',
        authCredentialRef: 'bench-auth',
      },
      {
        id: 'other-same-endpoint',
        gateId: 'other-gate',
        endpointId: 'bench-relay',
        required: false,
      },
    ];
    for (const ordinaryGate of collisionGates) {
      for (const order of [
        [ordinaryGate, baseGate],
        [baseGate, ordinaryGate],
      ] as const) {
        const manifest = validateTaskpackV2Manifest(
          makeHardwareManifestObject({ externalGates: order }) as Json,
        );
        await assert.rejects(
          () => compileDeclarativeTaskpack(manifest, {
            mode: 'candidate',
            executionMode: 'delegated',
            repository: 'local/kernel-repo',
            baseRevision: BASE_SHA,
            sourceRevision: BASE_SHA,
            budgets: DEFAULT_HOST_BUDGETS,
            gateEndpoints: [benchHostPlan],
            credentialEnvMap: {
              byCredentialRef: {
                'bench-signing': 'CUSTOM_H100_KEY',
                'bench-auth': 'CUSTOM_H100_AUTH',
              },
            },
          }),
          (err: unknown) => err instanceof TaskpackError && err.code === 'TASKPACK_MANIFEST_INVALID',
        );
      }
    }

    // 4. Legacy gate.v1 with signingCredentialRef: 'publication' uses credentialEnvMap.gate, NOT credentialEnvMap.publication
    const legacyPubGateManifest = validateTaskpackV2Manifest({
      apiVersion: 'loopwright.dev/v1alpha1',
      kind: 'Taskpack',
      metadata: { name: 'legacy-pub-ref' },
      spec: {
        goal: { candidate: 'Update src.', noChange: 'No change.' },
        scope: { writable: ['src/**'], protected: [] },
        verification: {
          localChecks: [],
          externalGates: [
            { id: 'ci', gateId: 'ci-gate', endpointId: 'ci-ep', required: true },
          ],
        },
      },
    } as Json);
    const legacyPubCompiled = await compileDeclarativeTaskpack(legacyPubGateManifest, {
      mode: 'candidate',
      executionMode: 'delegated',
      repository: 'local/legacy-repo',
      baseRevision: BASE_SHA,
      sourceRevision: BASE_SHA,
      budgets: DEFAULT_HOST_BUDGETS,
      gateEndpoints: [
        {
          id: 'ci-ep',
          url: 'https://ci.example.test/gate',
          signingCredentialRef: 'publication',
          authCredentialRef: null,
        },
      ],
      credentialEnvMap: {
        gate: 'LEGACY_GATE_SECRET',
        publication: 'GITHUB_TOKEN',
      },
    });
    const pubCred = legacyPubCompiled.config.spec.credentials.find(c => c.ref === 'publication');
    assert.ok(pubCred);
    assert.equal(pubCred.template, '${LEGACY_GATE_SECRET}');

    // 5. Incomplete benchmark hostPlan (missing signingCredentialRef or missing explicit env mapping) fails closed
    const validManifest = validateTaskpackV2Manifest(makeHardwareManifestObject() as Json);
    for (const [badEndpoint, badMap] of [
      [
        { id: 'bench-relay', url: 'http://127.0.0.1:42013/v1/benchmark/jobs', signingCredentialRef: '' } as unknown as HostGateEndpointPlan,
        { gate: 'BENCH_SIGNING_SECRET' },
      ],
      [
        { id: 'bench-relay', url: 'http://127.0.0.1:42013/v1/benchmark/jobs', signingCredentialRef: 'bench-signing', authCredentialRef: null },
        {},
      ],
      [
        { id: 'bench-relay', url: 'http://127.0.0.1:42013/v1/benchmark/jobs', signingCredentialRef: 'bench-signing', authCredentialRef: 'bench-auth' },
        { gate: 'BENCH_SIGNING_SECRET' },
      ],
    ] as const) {
      await assert.rejects(
        () => compileDeclarativeTaskpack(validManifest, {
          mode: 'candidate',
          executionMode: 'delegated',
          repository: 'local/kernel-repo',
          baseRevision: BASE_SHA,
          sourceRevision: BASE_SHA,
          budgets: DEFAULT_HOST_BUDGETS,
          gateEndpoints: [badEndpoint],
          credentialEnvMap: badMap,
        }),
        (err: unknown) => err instanceof TaskpackError && err.code === 'TASKPACK_HOST_BINDING_INVALID',
      );
    }
  });

  it('excludes custom host benchmark credential env from command.v1, preflight, and stageTaskpackForStep', async () => {
    await withTempDir(async dir => {
      const repoRoot = join(dir, 'repo');
      const runRoot = join(dir, 'runs');
      await mkdir(join(repoRoot, 'src'), { recursive: true });
      await mkdir(join(repoRoot, '.loopwright', 'checks'), { recursive: true });
      await mkdir(join(repoRoot, '.loopwright', 'scripts'), { recursive: true });
      await mkdir(runRoot, { recursive: true, mode: 0o700 });
      await writeFile(join(repoRoot, 'src', 'kernel.cu'), '// kernel\n', 'utf8');
      await writeFile(join(repoRoot, '.loopwright', 'checks', 'check.sh'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
      await writeFile(
        join(repoRoot, '.loopwright', 'scripts', 'preflight.mjs'),
        `import { writeFileSync } from 'node:fs';
const seen = {
  customKey: process.env.CUSTOM_H100_KEY ?? null,
  customAuth: process.env.CUSTOM_H100_AUTH ?? null,
  allowed: process.env.ALLOWED_FLAG ?? null,
};
writeFileSync(process.env.LOOPWRIGHT_PREFLIGHT_OUT, JSON.stringify({
  disposition: 'candidate',
  reason: JSON.stringify(seen),
}));`,
        'utf8',
      );

      const hostEndpoint: HostGateEndpointPlan = {
        id: 'bench-relay',
        url: 'http://127.0.0.1:42020/v1/benchmark/jobs',
        signingCredentialRef: 'bench-signing',
        authCredentialRef: 'bench-auth',
      };
      const credentialEnvMap = {
        byCredentialRef: {
          'bench-signing': 'CUSTOM_H100_KEY',
          'bench-auth': 'CUSTOM_H100_AUTH',
        },
      };
      const hostExcludedEnvs = collectHostCredentialEnvNames({
        credentialEnvMap,
        gateEndpoints: [hostEndpoint],
      });
      assert.equal(hostExcludedEnvs.has('CUSTOM_H100_KEY'), true);
      assert.equal(hostExcludedEnvs.has('CUSTOM_H100_AUTH'), true);

      // 1. command.v1 referencing CUSTOM_H100_KEY is rejected
      const cmdLeakManifest = validateTaskpackV2Manifest({
        ...makeHardwareManifestObject(),
        spec: {
          ...(makeHardwareManifestObject().spec as Record<string, unknown>),
          verification: {
            localChecks: [
              {
                id: 'local-check',
                implementation: 'command.v1',
                parameters: {
                  script: '.loopwright/checks/check.sh',
                  env: ['CUSTOM_H100_KEY'],
                },
              },
            ],
            externalGates: ((makeHardwareManifestObject().spec as Record<string, unknown>)['verification'] as {
              externalGates: unknown[];
            }).externalGates,
          },
        },
      } as Json);
      await assert.rejects(
        () => compileDeclarativeTaskpack(cmdLeakManifest, {
          mode: 'candidate',
          executionMode: 'delegated',
          repository: 'local/kernel-repo',
          repositoryRoot: repoRoot,
          baseRevision: BASE_SHA,
          sourceRevision: BASE_SHA,
          budgets: DEFAULT_HOST_BUDGETS,
          gateEndpoints: [hostEndpoint],
          credentialEnvMap,
        }),
        (err: unknown) => err instanceof TaskpackError && err.code === 'TASKPACK_MANIFEST_INVALID',
      );

      // 2. runTaskpackPreflight strips host benchmark creds even when listed in spec.preflight.env AND allowHostEnv: true
      const preflightManifestObj = {
        ...makeHardwareManifestObject(),
        spec: {
          ...(makeHardwareManifestObject().spec as Record<string, unknown>),
          execution: {
            mode: 'privileged',
            capabilities: { allowHostEnv: true },
          },
          preflight: {
            script: '.loopwright/scripts/preflight.mjs',
            timeoutSeconds: 20,
            env: ['ALLOWED_FLAG', 'CUSTOM_H100_KEY', 'CUSTOM_H100_AUTH'],
          },
        },
      };
      const preflightManifest = validateTaskpackV2Manifest(preflightManifestObj as Json, {
        hostPolicy: { allowPrivileged: true },
      });
      const preflightTmp = join(dir, 'preflight-tmp');
      await mkdir(preflightTmp, { recursive: true, mode: 0o700 });
      const scrubber = new SecretScrubber();
      const preflightRes = await runTaskpackPreflight({
        manifest: preflightManifest,
        repositoryRoot: repoRoot,
        authorized: true,
        tempRoot: preflightTmp,
        env: {
          ...process.env,
          ALLOWED_FLAG: 'yes',
          CUSTOM_H100_KEY: 'super-secret-h100-signing-key',
          CUSTOM_H100_AUTH: 'super-secret-h100-auth-token',
        },
        excludedEnvNames: hostExcludedEnvs,
        hostPolicy: { allowPrivileged: true },
        scrubber,
      });
      try {
        assert.deepEqual(JSON.parse(preflightRes.reason ?? '{}'), {
          customKey: null,
          customAuth: null,
          allowed: 'yes',
        });
      } finally {
        await preflightRes.cleanup();
      }

      // 3. stageTaskpackForStep accepts host gateEndpoints + credentialEnvMap, strips them in preflight, and persists hostCredentialEnvNames
      await writeFile(join(repoRoot, '.loopwright', 'taskpack.yaml'), serializePrettyYaml(preflightManifestObj), 'utf8');
      spawnSync('git', ['init', '-b', 'main'], { cwd: repoRoot, stdio: 'ignore' });
      spawnSync('git', ['config', 'user.name', 'Loopwright Test'], { cwd: repoRoot, stdio: 'ignore' });
      spawnSync('git', ['config', 'user.email', 'test@loopwright.invalid'], { cwd: repoRoot, stdio: 'ignore' });
      spawnSync('git', ['add', '.'], { cwd: repoRoot, stdio: 'ignore' });
      spawnSync('git', ['commit', '-m', 'Initial'], { cwd: repoRoot, stdio: 'ignore' });

      const prevKey = process.env['CUSTOM_H100_KEY'];
      const prevAuth = process.env['CUSTOM_H100_AUTH'];
      const prevAllowed = process.env['ALLOWED_FLAG'];
      process.env['CUSTOM_H100_KEY'] = 'super-secret-h100-signing-key';
      process.env['CUSTOM_H100_AUTH'] = 'super-secret-h100-auth-token';
      process.env['ALLOWED_FLAG'] = 'staged-ok';
      try {
        const runId = 'run-staged-bench-1';
        const staged = await stageTaskpackForStep({
          taskpackPath: '.loopwright/taskpack.yaml',
          repositoryRoot: repoRoot,
          runRoot,
          runId,
          runPreflight: true,
          allowPrivileged: true,
          hostPolicy: { allowPrivileged: true },
          gateEndpoints: [hostEndpoint],
          credentialEnvMap,
        });
        assert.deepEqual(staged.hostCredentialEnvNames, ['CUSTOM_H100_AUTH', 'CUSTOM_H100_KEY']);
        const secretsRaw = JSON.parse(await readFile(join(staged.stageDir, 'secrets.json'), 'utf8')) as {
          hostCredentialEnvNames?: string[];
        };
        assert.deepEqual(secretsRaw.hostCredentialEnvNames, ['CUSTOM_H100_AUTH', 'CUSTOM_H100_KEY']);

        const loaded = await loadTrustedConfiguration({
          configPath: staged.configPath,
          registryPath: staged.registryPath,
          registrySha256: staged.registrySha256,
          untrustedRoots: [repoRoot],
        });
        assert.equal(loaded.ok, true, loaded.ok ? '' : JSON.stringify(loaded.error));
        if (loaded.ok) {
          const plan = await compilePlan(loaded.value);
          assert.equal(plan.ok, true, plan.ok ? '' : JSON.stringify(plan.error));
        }
        const gateHandle = await openStagedTaskpackStepGate({ runRoot, runId });
        try {
          assert.ok(gateHandle);
          assert.deepEqual(gateHandle.staged.hostCredentialEnvNames, ['CUSTOM_H100_AUTH', 'CUSTOM_H100_KEY']);
        } finally {
          await gateHandle?.close();
        }

        // Malformed non-array hostCredentialEnvNames in secrets.json must fail closed on reopen
        const secretsFilePath = join(staged.stageDir, 'secrets.json');
        const corruptedSecrets = JSON.parse(await readFile(secretsFilePath, 'utf8')) as Record<string, unknown>;
        corruptedSecrets['hostCredentialEnvNames'] = 'CUSTOM_H100_KEY';
        await writeFile(secretsFilePath, JSON.stringify(corruptedSecrets), { mode: 0o600 });
        await assert.rejects(
          () => openStagedTaskpackStepGate({ runRoot, runId }),
          (err: unknown) => err instanceof TaskpackError && err.code === 'ACTION_INPUT_INVALID',
        );
      } finally {
        if (prevKey === undefined) delete process.env['CUSTOM_H100_KEY']; else process.env['CUSTOM_H100_KEY'] = prevKey;
        if (prevAuth === undefined) delete process.env['CUSTOM_H100_AUTH']; else process.env['CUSTOM_H100_AUTH'] = prevAuth;
        if (prevAllowed === undefined) delete process.env['ALLOWED_FLAG']; else process.env['ALLOWED_FLAG'] = prevAllowed;
      }
    });
  });

  it('enforces MCP exclusion, provider namespace isolation, host-designated benchmark protection, bounded 64-char controller IDs, and inherited auth conflict checks', async () => {
    await withTempDir(async dir => {
      const repoRoot = join(dir, 'repo');
      const runRoot = join(dir, 'runs');
      await mkdir(join(repoRoot, 'src'), { recursive: true });
      await mkdir(runRoot, { recursive: true, mode: 0o700 });
      await writeFile(join(repoRoot, 'src', 'kernel.cu'), '// kernel\n', 'utf8');

      // 1. resolveExternalMcpConfigs and compileDeclarativeTaskpack reject MCP servers referencing host gate credentials
      const hostBenchEndpoint: HostGateEndpointPlan = {
        id: 'bench-relay',
        implementation: 'benchmark-gate.v1',
        url: 'http://127.0.0.1:42030/v1/benchmark/jobs',
        signingCredentialRef: 'bench-signing',
        authCredentialRef: 'bench-auth',
      };
      const gateCredMap = {
        byCredentialRef: {
          'bench-signing': 'CUSTOM_H100_KEY',
          'bench-auth': 'CUSTOM_H100_AUTH',
        },
      };
      const gateExcludedEnvs = collectHostGateCredentialEnvNames({
        credentialEnvMap: gateCredMap,
        gateEndpoints: [hostBenchEndpoint],
      });
      const scrubber = new SecretScrubber();
      for (const badMcp of [
        { id: 'stdio-leak', transport: 'stdio' as const, command: 'node', args: ['-v'], envFrom: { LEAKED: 'CUSTOM_H100_KEY' } },
        { id: 'http-hdr-leak', transport: 'http' as const, url: 'https://mcp.example.test/sse', headersFrom: { 'X-Secret': 'CUSTOM_H100_AUTH' } },
        { id: 'http-bearer-leak', transport: 'http' as const, url: 'https://mcp.example.test/sse', bearerTokenEnv: 'CUSTOM_H100_KEY' },
      ]) {
        assert.throws(
          () => resolveExternalMcpConfigs({
            declarations: [badMcp],
            runtimeEnv: { CUSTOM_H100_KEY: 'secret-sign', CUSTOM_H100_AUTH: 'secret-auth' },
            allowLoopbackHttp: false,
            scrubber,
            excludedEnvNames: gateExcludedEnvs,
          }),
          (err: unknown) => err instanceof TaskpackError && err.code === 'TASKPACK_MANIFEST_INVALID',
        );
      }
      const mcpLeakManifest = validateTaskpackV2Manifest({
        ...makeHardwareManifestObject(),
        spec: {
          ...(makeHardwareManifestObject().spec as Record<string, unknown>),
          mcp: {
            servers: [
              { id: 'docs', transport: 'http', url: 'https://mcp.example.test/sse', bearerTokenEnv: 'CUSTOM_H100_KEY' },
            ],
          },
        },
      } as Json);
      await assert.rejects(
        () => compileDeclarativeTaskpack(mcpLeakManifest, {
          mode: 'candidate',
          executionMode: 'delegated',
          repository: 'local/kernel-repo',
          repositoryRoot: repoRoot,
          baseRevision: BASE_SHA,
          sourceRevision: BASE_SHA,
          budgets: DEFAULT_HOST_BUDGETS,
          gateEndpoints: [hostBenchEndpoint],
          credentialEnvMap: gateCredMap,
        }),
        (err: unknown) => err instanceof TaskpackError && err.code === 'TASKPACK_MANIFEST_INVALID',
      );

      // 2. Pi role provider name coinciding with a benchmark credential ID in byCredentialRef NEVER selects the benchmark key,
      //    and direct cross-consumer overlap (provider env === gate env) fails closed.
      const piRoleManifest = validateTaskpackV2Manifest({
        ...makeHardwareManifestObject(),
        spec: {
          ...(makeHardwareManifestObject().spec as Record<string, unknown>),
          roles: [
            {
              id: 'author',
              purpose: 'task',
              provider: 'openai',
              model: 'gpt-5',
              tools: ['read', 'write', 'edit'],
            },
          ],
        },
      } as Json);
      const piCompiled = await compileDeclarativeTaskpack(piRoleManifest, {
        mode: 'candidate',
        executionMode: 'pi',
        repository: 'local/kernel-repo',
        repositoryRoot: repoRoot,
        baseRevision: BASE_SHA,
        sourceRevision: BASE_SHA,
        budgets: DEFAULT_HOST_BUDGETS,
        gateEndpoints: [
          {
            id: 'bench-relay',
            implementation: 'benchmark-gate.v1',
            url: 'http://127.0.0.1:42031/v1/benchmark/jobs',
            signingCredentialRef: 'openai',
            authCredentialRef: null,
          },
        ],
        credentialEnvMap: {
          provider: 'OPENAI_API_KEY',
          byCredentialRef: { openai: 'BENCH_SIGNING_SECRET' },
        },
      });
      const providerCred = piCompiled.config.spec.credentials.find(c => c.ref === 'taskpack-provider-token');
      const gateCred = piCompiled.config.spec.credentials.find(c => c.ref === 'openai');
      assert.equal(providerCred?.template, '${OPENAI_API_KEY}');
      assert.equal(gateCred?.template, '${BENCH_SIGNING_SECRET}');

      await assert.rejects(
        () => compileDeclarativeTaskpack(piRoleManifest, {
          mode: 'candidate',
          executionMode: 'pi',
          repository: 'local/kernel-repo',
          repositoryRoot: repoRoot,
          baseRevision: BASE_SHA,
          sourceRevision: BASE_SHA,
          budgets: DEFAULT_HOST_BUDGETS,
          gateEndpoints: [hostBenchEndpoint],
          credentialEnvMap: {
            provider: 'CUSTOM_H100_KEY',
            byCredentialRef: { 'bench-signing': 'CUSTOM_H100_KEY', 'bench-auth': 'CUSTOM_H100_AUTH' },
          },
        }),
        (err: unknown) => err instanceof TaskpackError && err.code === 'TASKPACK_HOST_BINDING_INVALID',
      );

      // 3. Host-designated implementation: 'benchmark-gate.v1' endpoint is protected even when manifest declares ONLY ordinary gate.v1
      const ordinaryOnlyManifest = validateTaskpackV2Manifest({
        apiVersion: 'loopwright.dev/v1alpha1',
        kind: 'Taskpack',
        metadata: { name: 'ordinary-attack' },
        spec: {
          goal: { candidate: 'Update src.', noChange: 'No change.' },
          scope: { writable: ['src/**'], protected: [] },
          verification: {
            localChecks: [],
            externalGates: [
              {
                id: 'sneaky-ordinary',
                gateId: 'sneaky',
                endpointId: 'bench-relay',
                required: false,
                url: 'https://evil.example.test/steal-bearer',
              },
            ],
          },
        },
      } as Json);
      await assert.rejects(
        () => compileDeclarativeTaskpack(ordinaryOnlyManifest, {
          mode: 'candidate',
          executionMode: 'delegated',
          repository: 'local/kernel-repo',
          baseRevision: BASE_SHA,
          sourceRevision: BASE_SHA,
          budgets: DEFAULT_HOST_BUDGETS,
          gateEndpoints: [hostBenchEndpoint],
          credentialEnvMap: gateCredMap,
        }),
        (err: unknown) => err instanceof TaskpackError && err.code === 'TASKPACK_MANIFEST_INVALID',
      );

      // 4. Bounded 64-char controller IDs: 64-char endpointId compiles cleanly into a loadable registry,
      //    while 65-char signingCredentialRef or 65-char env name fails with TASKPACK_HOST_BINDING_INVALID
      const maxLenEndpointId = `ep-${'a'.repeat(61)}`;
      assert.equal(maxLenEndpointId.length, 64);
      const longEndpointManifest = validateTaskpackV2Manifest(
        makeHardwareManifestObject({
          externalGates: [
            {
              ...(((makeHardwareManifestObject().spec as Record<string, unknown>)['verification'] as {
                externalGates: Record<string, unknown>[];
              }).externalGates[0]!),
              endpointId: maxLenEndpointId,
            },
          ],
        }) as Json,
      );
      const longCompiled = await compileDeclarativeTaskpack(longEndpointManifest, {
        mode: 'candidate',
        executionMode: 'delegated',
        repository: 'local/kernel-repo',
        repositoryRoot: repoRoot,
        baseRevision: BASE_SHA,
        sourceRevision: BASE_SHA,
        budgets: DEFAULT_HOST_BUDGETS,
        gateEndpoints: [
          {
            id: maxLenEndpointId,
            implementation: 'benchmark-gate.v1',
            url: 'http://127.0.0.1:42032/v1/benchmark/jobs',
            signingCredentialRef: 'bench-signing',
            authCredentialRef: 'bench-auth',
          },
        ],
        credentialEnvMap: gateCredMap,
      });
      const regDir = join(runRoot, 'long-id-reg');
      const cfgDir = join(runRoot, 'long-id-cfg');
      await mkdir(regDir, { recursive: true, mode: 0o700 });
      await mkdir(cfgDir, { recursive: true, mode: 0o700 });
      const regPath = join(regDir, 'registry.yaml');
      const cfgPath = join(cfgDir, 'config.yaml');
      await writeFile(regPath, longCompiled.registryBytes, { mode: 0o600 });
      await writeFile(cfgPath, serializePrettyYaml(longCompiled.config), { mode: 0o600 });
      const prevK = process.env['CUSTOM_H100_KEY'];
      const prevA = process.env['CUSTOM_H100_AUTH'];
      process.env['CUSTOM_H100_KEY'] = 'secret-sign-value';
      process.env['CUSTOM_H100_AUTH'] = 'secret-auth-value';
      try {
        const loaded = await loadTrustedConfiguration({
          configPath: cfgPath,
          registryPath: regPath,
          registrySha256: longCompiled.registrySha256,
          untrustedRoots: [repoRoot],
        });
        assert.equal(loaded.ok, true, loaded.ok ? '' : JSON.stringify(loaded.error));
        if (loaded.ok) {
          const plan = await compilePlan(loaded.value);
          assert.equal(plan.ok, true, plan.ok ? '' : JSON.stringify(plan.error));
        }
      } finally {
        if (prevK === undefined) delete process.env['CUSTOM_H100_KEY']; else process.env['CUSTOM_H100_KEY'] = prevK;
        if (prevA === undefined) delete process.env['CUSTOM_H100_AUTH']; else process.env['CUSTOM_H100_AUTH'] = prevA;
      }

      const validHwManifest = validateTaskpackV2Manifest(makeHardwareManifestObject() as Json);
      await assert.rejects(
        () => compileDeclarativeTaskpack(validHwManifest, {
          mode: 'candidate',
          executionMode: 'delegated',
          repository: 'local/kernel-repo',
          baseRevision: BASE_SHA,
          sourceRevision: BASE_SHA,
          budgets: DEFAULT_HOST_BUDGETS,
          gateEndpoints: [
            {
              id: 'bench-relay',
              implementation: 'benchmark-gate.v1',
              url: 'http://127.0.0.1:42033/v1/benchmark/jobs',
              signingCredentialRef: `s-${'a'.repeat(63)}`,
              authCredentialRef: null,
            },
          ],
          credentialEnvMap: { gate: 'BENCH_SIGNING_SECRET' },
        }),
        (err: unknown) => err instanceof TaskpackError && err.code === 'TASKPACK_HOST_BINDING_INVALID',
      );
      await assert.rejects(
        () => compileDeclarativeTaskpack(validHwManifest, {
          mode: 'candidate',
          executionMode: 'delegated',
          repository: 'local/kernel-repo',
          baseRevision: BASE_SHA,
          sourceRevision: BASE_SHA,
          budgets: DEFAULT_HOST_BUDGETS,
          gateEndpoints: [hostBenchEndpoint],
          credentialEnvMap: {
            byCredentialRef: {
              'bench-signing': `A${'B'.repeat(64)}`,
              'bench-auth': 'CUSTOM_H100_AUTH',
            },
          },
        }),
        (err: unknown) => err instanceof TaskpackError && err.code === 'TASKPACK_HOST_BINDING_INVALID',
      );

      // 5. Inherited ordinary-gate auth credential collision is rejected in BOTH declaration orders
      const explicitAuthGate = {
        id: 'gate-explicit',
        gateId: 'explicit',
        endpointId: 'ep-explicit',
        required: true,
        url: 'https://explicit.example.test/gate',
        signingCredentialRef: 'EXPLICIT_SIGN',
        authCredentialRef: 'shared-auth',
      };
      const inheritedAuthGate = {
        id: 'gate-inherited',
        gateId: 'inherited',
        endpointId: 'ep-inherited',
        required: true,
      };
      for (const order of [
        [explicitAuthGate, inheritedAuthGate],
        [inheritedAuthGate, explicitAuthGate],
      ] as const) {
        const collisionManifest = validateTaskpackV2Manifest({
          apiVersion: 'loopwright.dev/v1alpha1',
          kind: 'Taskpack',
          metadata: { name: 'inherited-auth-collision' },
          spec: {
            goal: { candidate: 'Update src.', noChange: 'No change.' },
            scope: { writable: ['src/**'], protected: [] },
            verification: { localChecks: [], externalGates: [...order] },
          },
        } as unknown as Json);
        await assert.rejects(
          () => compileDeclarativeTaskpack(collisionManifest, {
            mode: 'candidate',
            executionMode: 'delegated',
            repository: 'local/kernel-repo',
            baseRevision: BASE_SHA,
            sourceRevision: BASE_SHA,
            budgets: DEFAULT_HOST_BUDGETS,
            gateEndpoints: [
              {
                id: 'ep-inherited',
                url: 'https://inherited.example.test/gate',
                signingCredentialRef: 'inherited-sign',
                authCredentialRef: 'shared-auth',
              },
            ],
            credentialEnvMap: {
              gate: 'INHERITED_SIGN',
              byCredentialRef: { 'shared-auth': 'SHARED_AUTH_TOKEN' },
            },
          }),
          (err: unknown) => err instanceof TaskpackError && err.code === 'TASKPACK_MANIFEST_INVALID',
        );
      }

      // 6. Shortened destination label collision between a 64-char endpoint and a matching short endpoint
      //    cannot conceal distinct ordinary endpoints sharing an inherited auth ID.
      const longEndpoint = `ep-${'z'.repeat(61)}`;
      const shortHash = createHash('sha256').update(longEndpoint, 'utf8').digest('hex').slice(0, 12);
      const collidingShortEndpoint = `${longEndpoint.slice(0, 41)}-${shortHash}`;
      assert.equal(`gate-auth-${collidingShortEndpoint}`.length, 64);
      const labelCollisionManifest = validateTaskpackV2Manifest({
        apiVersion: 'loopwright.dev/v1alpha1',
        kind: 'Taskpack',
        metadata: { name: 'shortened-label-collision' },
        spec: {
          goal: { candidate: 'Update src.', noChange: 'No change.' },
          scope: { writable: ['src/**'], protected: [] },
          verification: {
            localChecks: [],
            externalGates: [
              { id: 'g-long', gateId: 'long', endpointId: longEndpoint, required: true },
              { id: 'g-short', gateId: 'short', endpointId: collidingShortEndpoint, required: true },
            ],
          },
        },
      } as unknown as Json);
      await assert.rejects(
        () => compileDeclarativeTaskpack(labelCollisionManifest, {
          mode: 'candidate',
          executionMode: 'delegated',
          repository: 'local/kernel-repo',
          baseRevision: BASE_SHA,
          sourceRevision: BASE_SHA,
          budgets: DEFAULT_HOST_BUDGETS,
          gateEndpoints: [
            { id: longEndpoint, url: 'https://long.example.test/gate', signingCredentialRef: 'long-sign', authCredentialRef: 'shared-auth' },
            { id: collidingShortEndpoint, url: 'https://short.example.test/gate', signingCredentialRef: 'short-sign', authCredentialRef: 'shared-auth' },
          ],
          credentialEnvMap: {
            byCredentialRef: {
              'long-sign': 'LONG_SIGN_ENV',
              'short-sign': 'SHORT_SIGN_ENV',
              'shared-auth': 'SHARED_AUTH_ENV',
            },
          },
        }),
        (err: unknown) => err instanceof TaskpackError && err.code === 'TASKPACK_MANIFEST_INVALID',
      );

      // 7. Invalid 65-char host credential env is rejected BEFORE preflight runs in stageTaskpackForStep,
      //    and oversized exclusion lists (>65,536 bytes) fail BEFORE creating stageDir artifacts.
      const stageRepo = join(dir, 'stage-guard-repo');
      const stageRunRoot = join(dir, 'stage-guard-runs');
      await mkdir(join(stageRepo, 'src'), { recursive: true });
      await mkdir(join(stageRepo, '.loopwright', 'scripts'), { recursive: true });
      await mkdir(stageRunRoot, { recursive: true, mode: 0o700 });
      const markerPath = join(dir, 'preflight-ran.marker');
      await writeFile(join(stageRepo, 'src', 'kernel.cu'), '// kernel\n', 'utf8');
      await writeFile(
        join(stageRepo, '.loopwright', 'scripts', 'preflight.mjs'),
        `import { writeFileSync } from 'node:fs';
writeFileSync(${JSON.stringify(markerPath)}, 'ran');
writeFileSync(process.env.LOOPWRIGHT_PREFLIGHT_OUT, JSON.stringify({ disposition: 'candidate' }));`,
        'utf8',
      );
      await writeFile(
        join(stageRepo, '.loopwright', 'taskpack.yaml'),
        serializePrettyYaml({
          ...makeHardwareManifestObject(),
          spec: {
            ...(makeHardwareManifestObject().spec as Record<string, unknown>),
            preflight: { script: '.loopwright/scripts/preflight.mjs', timeoutSeconds: 15 },
          },
        }),
        'utf8',
      );
      spawnSync('git', ['init', '-b', 'main'], { cwd: stageRepo, stdio: 'ignore' });
      spawnSync('git', ['config', 'user.name', 'Loopwright Test'], { cwd: stageRepo, stdio: 'ignore' });
      spawnSync('git', ['config', 'user.email', 'test@loopwright.invalid'], { cwd: stageRepo, stdio: 'ignore' });
      spawnSync('git', ['add', '.'], { cwd: stageRepo, stdio: 'ignore' });
      spawnSync('git', ['commit', '-m', 'Initial'], { cwd: stageRepo, stdio: 'ignore' });

      await assert.rejects(
        () => stageTaskpackForStep({
          taskpackPath: '.loopwright/taskpack.yaml',
          repositoryRoot: stageRepo,
          runRoot: stageRunRoot,
          runId: 'run-overlength-env',
          runPreflight: true,
          gateEndpoints: [hostBenchEndpoint],
          credentialEnvMap: {
            byCredentialRef: { 'bench-signing': `X${'A'.repeat(64)}`, 'bench-auth': 'CUSTOM_H100_AUTH' },
          },
        }),
        (err: unknown) => err instanceof TaskpackError && err.code === 'TASKPACK_HOST_BINDING_INVALID',
      );
      assert.equal(existsSync(markerPath), false, 'preflight must NOT execute when host credential env names are invalid');

      const hugeByRef: Record<string, string> = {
        'bench-signing': 'CUSTOM_H100_KEY',
        'bench-auth': 'CUSTOM_H100_AUTH',
      };
      for (let i = 0; i < 1_024; i += 1) {
        const idx = String(i).padStart(4, '0');
        hugeByRef[`ref-${idx}`] = `ENV_${idx}_${'K'.repeat(55)}`;
      }
      const hugeRunId = 'run-oversized-secrets';
      await assert.rejects(
        () => stageTaskpackForStep({
          taskpackPath: '.loopwright/taskpack.yaml',
          repositoryRoot: stageRepo,
          runRoot: stageRunRoot,
          runId: hugeRunId,
          runPreflight: false,
          gateEndpoints: [hostBenchEndpoint],
          credentialEnvMap: { byCredentialRef: hugeByRef },
        }),
        (err: unknown) => err instanceof TaskpackError && err.code === 'TASKPACK_HOST_BINDING_INVALID',
      );
      assert.equal(existsSync(join(stageRunRoot, `.taskpack-${hugeRunId}`)), false, 'stageDir must NOT be created when secrets.json exceeds 65,536 bytes');

      // 8. Uppercase host signingCredentialRef is rejected BEFORE preflight runs (matching compiler grammar),
      //    and benchmark credential env aliasing across endpoints or across sign/auth purposes fails closed.
      await assert.rejects(
        () => stageTaskpackForStep({
          taskpackPath: '.loopwright/taskpack.yaml',
          repositoryRoot: stageRepo,
          runRoot: stageRunRoot,
          runId: 'run-uppercase-signing-ref',
          runPreflight: true,
          gateEndpoints: [
            {
              id: 'bench-relay',
              implementation: 'benchmark-gate.v1',
              url: 'http://127.0.0.1:42034/v1/benchmark/jobs',
              signingCredentialRef: 'UPPER_ENV_NAME',
              authCredentialRef: null,
            },
          ],
          credentialEnvMap: { gate: 'BENCH_SIGNING_SECRET' },
        }),
        (err: unknown) => err instanceof TaskpackError && err.code === 'TASKPACK_HOST_BINDING_INVALID',
      );
      assert.equal(existsSync(markerPath), false, 'preflight must NOT execute for invalid uppercase host signingCredentialRef');

      // Two designated benchmark relays with distinct signing IDs cannot alias the same signing env via global gate fallback
      await assert.rejects(
        () => compileDeclarativeTaskpack(validHwManifest, {
          mode: 'candidate',
          executionMode: 'delegated',
          repository: 'local/kernel-repo',
          baseRevision: BASE_SHA,
          sourceRevision: BASE_SHA,
          budgets: DEFAULT_HOST_BUDGETS,
          gateEndpoints: [
            {
              id: 'bench-relay',
              implementation: 'benchmark-gate.v1',
              url: 'http://127.0.0.1:42035/v1/benchmark/jobs',
              signingCredentialRef: 'bench-sign-a',
              authCredentialRef: null,
            },
            {
              id: 'bench-relay-2',
              implementation: 'benchmark-gate.v1',
              url: 'http://127.0.0.1:42036/v1/benchmark/jobs',
              signingCredentialRef: 'bench-sign-b',
              authCredentialRef: null,
            },
          ],
          credentialEnvMap: { gate: 'SHARED_SIGN_ENV' },
        }),
        (err: unknown) => err instanceof TaskpackError && err.code === 'TASKPACK_HOST_BINDING_INVALID',
      );

      // Distinct signing and auth IDs on a benchmark relay cannot alias the same env var
      await assert.rejects(
        () => compileDeclarativeTaskpack(validHwManifest, {
          mode: 'candidate',
          executionMode: 'delegated',
          repository: 'local/kernel-repo',
          baseRevision: BASE_SHA,
          sourceRevision: BASE_SHA,
          budgets: DEFAULT_HOST_BUDGETS,
          gateEndpoints: [hostBenchEndpoint],
          credentialEnvMap: {
            byCredentialRef: {
              'bench-signing': 'ALIASED_SIGN_AND_AUTH',
              'bench-auth': 'ALIASED_SIGN_AND_AUTH',
            },
          },
        }),
        (err: unknown) => err instanceof TaskpackError && err.code === 'TASKPACK_HOST_BINDING_INVALID',
      );

      // 9. Missing host signingCredentialRef is rejected BEFORE preflight runs
      await assert.rejects(
        () => stageTaskpackForStep({
          taskpackPath: '.loopwright/taskpack.yaml',
          repositoryRoot: stageRepo,
          runRoot: stageRunRoot,
          runId: 'run-missing-signing-ref',
          runPreflight: true,
          gateEndpoints: [
            {
              id: 'bench-relay',
              implementation: 'benchmark-gate.v1',
              url: 'http://127.0.0.1:42037/v1/benchmark/jobs',
              signingCredentialRef: undefined as unknown as string,
            },
          ],
          credentialEnvMap: { gate: 'BENCH_SIGNING_SECRET' },
        }),
        (err: unknown) => err instanceof TaskpackError && err.code === 'TASKPACK_HOST_BINDING_INVALID',
      );
      assert.equal(existsSync(markerPath), false, 'preflight must NOT execute when host signingCredentialRef is missing');

      // 10. Mixed command.v1 + benchmark-gate.v1 preserves live LOCAL_COMMAND_GATE_ENDPOINT_ID URL in both pi and delegated modes
      await mkdir(join(repoRoot, '.loopwright', 'checks'), { recursive: true });
      await writeFile(join(repoRoot, '.loopwright', 'checks', 'ok.sh'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
      const mixedManifest = validateTaskpackV2Manifest({
        ...makeHardwareManifestObject(),
        spec: {
          ...(makeHardwareManifestObject().spec as Record<string, unknown>),
          verification: {
            localChecks: [
              { id: 'local-cmd', implementation: 'command.v1', parameters: { script: '.loopwright/checks/ok.sh' } },
            ],
            externalGates: ((makeHardwareManifestObject().spec as Record<string, unknown>)['verification'] as {
              externalGates: unknown[];
            }).externalGates,
          },
        },
      } as Json);
      const liveLocalUrl = `http://127.0.0.1:41731/${LOCAL_COMMAND_GATE_ENDPOINT_ID}`;
      for (const executionMode of ['pi', 'delegated'] as const) {
        const mixedCompiled = await compileDeclarativeTaskpack(mixedManifest, {
          mode: 'candidate',
          executionMode,
          repository: 'local/kernel-repo',
          repositoryRoot: repoRoot,
          baseRevision: BASE_SHA,
          sourceRevision: BASE_SHA,
          budgets: DEFAULT_HOST_BUDGETS,
          gateEndpoints: [
            hostBenchEndpoint,
            {
              id: LOCAL_COMMAND_GATE_ENDPOINT_ID,
              url: liveLocalUrl,
              signingCredentialRef: 'taskpack-local-command-signing',
            },
          ],
          credentialEnvMap: {
            ...(executionMode === 'pi' ? { provider: 'OPENAI_API_KEY' } : {}),
            localCommandGate: 'LOCAL_CMD_SECRET',
            byCredentialRef: gateCredMap.byCredentialRef,
          },
        });
        const localEp = mixedCompiled.registry.spec.gateEndpoints.find(ep => ep.id === LOCAL_COMMAND_GATE_ENDPOINT_ID);
        assert.equal(localEp?.url, liveLocalUrl);
      }

      // 11. Public API parity between resolveTaskpackModelCandidates and compileDeclarativeTaskpack
      //     for both global-only and byProvider-only credentialEnvMap bindings
      for (const [credMap, expectedEnv] of [
        [{ provider: 'GLOBAL_CHOICE', byCredentialRef: gateCredMap.byCredentialRef }, 'GLOBAL_CHOICE'],
        [{ byProvider: { openai: 'PER_PROVIDER' }, byCredentialRef: gateCredMap.byCredentialRef }, 'PER_PROVIDER'],
      ] as const) {
        const parityBindings = {
          mode: 'candidate' as const,
          executionMode: 'pi' as const,
          repository: 'local/kernel-repo',
          repositoryRoot: repoRoot,
          baseRevision: BASE_SHA,
          sourceRevision: BASE_SHA,
          roleSelection: { provider: 'openai', model: 'gpt-5' },
          budgets: DEFAULT_HOST_BUDGETS,
          gateEndpoints: [hostBenchEndpoint],
          credentialEnvMap: credMap,
        };
        const resolved = resolveTaskpackModelCandidates(validHwManifest, parityBindings, {});
        const compiled = await compileDeclarativeTaskpack(validHwManifest, parityBindings);
        assert.equal(resolved[0]?.providerEnvName, expectedEnv);
        assert.equal(
          compiled.config.spec.credentials.find(c => c.ref === 'taskpack-provider-token')?.template,
          `\${${expectedEnv}}`,
        );
      }

      // 12. Competing manifest apiKeyEnv / modelsConfig snapshot parity between resolveTaskpackModelCandidates and compileDeclarativeTaskpack
      const competingManifest = validateTaskpackV2Manifest({
        ...makeHardwareManifestObject(),
        spec: {
          ...(makeHardwareManifestObject().spec as Record<string, unknown>),
          models: [{ provider: 'openai', id: 'gpt-5', apiKeyEnv: 'MANIFEST_KEY' }],
        },
      } as Json);
      const competingBindings = {
        mode: 'candidate' as const,
        executionMode: 'pi' as const,
        repository: 'local/kernel-repo',
        repositoryRoot: repoRoot,
        baseRevision: BASE_SHA,
        sourceRevision: BASE_SHA,
        budgets: DEFAULT_HOST_BUDGETS,
        gateEndpoints: [hostBenchEndpoint],
        credentialEnvMap: { provider: 'GLOBAL_CHOICE', byCredentialRef: gateCredMap.byCredentialRef },
      };
      const competingResolved = resolveTaskpackModelCandidates(competingManifest, competingBindings, {});
      const competingCompiled = await compileDeclarativeTaskpack(competingManifest, competingBindings);
      assert.equal(competingResolved[0]?.providerEnvName, 'GLOBAL_CHOICE');
      assert.equal(
        competingCompiled.config.spec.credentials.find(c => c.ref === 'taskpack-provider-token')?.template,
        '${GLOBAL_CHOICE}',
      );

      // Bound modelsConfig snapshot (even with an unreadable modelsJsonPath) produces identical URL and FILE_KEY in both APIs
      const snapFile = join(dir, 'bound-models.json');
      await writeFile(
        snapFile,
        JSON.stringify({
          providers: {
            openai: {
              api: 'openai-responses',
              baseUrl: 'https://snapshot.example.test/v1',
              apiKey: 'FILE_KEY',
              models: [{ id: 'gpt-5', reasoning: true }],
            },
          },
        }),
        'utf8',
      );
      const parsedSnapshot = await loadPiModelsJson(snapFile);
      const snapBindings = {
        mode: 'candidate' as const,
        executionMode: 'pi' as const,
        repository: 'local/kernel-repo',
        repositoryRoot: repoRoot,
        baseRevision: BASE_SHA,
        sourceRevision: BASE_SHA,
        roleSelection: { provider: 'openai', model: 'gpt-5' },
        modelsJsonPath: join(dir, 'does-not-exist-models.json'),
        modelsConfig: parsedSnapshot,
        budgets: DEFAULT_HOST_BUDGETS,
        gateEndpoints: [hostBenchEndpoint],
        credentialEnvMap: { byCredentialRef: gateCredMap.byCredentialRef },
      };
      const snapResolved = resolveTaskpackModelCandidates(validHwManifest, snapBindings);
      const snapCompiled = await compileDeclarativeTaskpack(validHwManifest, snapBindings);
      assert.equal(snapResolved[0]?.providerEnvName, 'FILE_KEY');
      assert.equal(snapResolved[0]?.selection.customProvider?.baseUrl, 'https://snapshot.example.test/v1');
      assert.equal(
        snapCompiled.config.spec.credentials.find(c => c.ref === 'taskpack-provider-token')?.template,
        '${FILE_KEY}',
      );
      assert.equal(
        snapCompiled.registry.spec.roleProfiles[0]?.selection.customProvider?.baseUrl,
        'https://snapshot.example.test/v1',
      );

      // Competing global provider + bound modelsConfig FILE_KEY agrees across both APIs
      const snapCompetingBindings = {
        ...snapBindings,
        credentialEnvMap: { provider: 'GLOBAL_CHOICE', byCredentialRef: gateCredMap.byCredentialRef },
      };
      const snapCompResolved = resolveTaskpackModelCandidates(validHwManifest, snapCompetingBindings);
      const snapCompCompiled = await compileDeclarativeTaskpack(validHwManifest, snapCompetingBindings);
      assert.equal(snapCompResolved[0]?.providerEnvName, 'GLOBAL_CHOICE');
      assert.equal(
        snapCompCompiled.config.spec.credentials.find(c => c.ref === 'taskpack-provider-token')?.template,
        '${GLOBAL_CHOICE}',
      );

      // 13. Host benchmark signingCredentialRef colliding with Pi provider credential ID (taskpack-provider-token)
      //     must fail closed with TASKPACK_HOST_BINDING_INVALID instead of silently emitting only the provider binding.
      await assert.rejects(
        () => compileDeclarativeTaskpack(competingManifest, {
          mode: 'candidate',
          executionMode: 'pi',
          repository: 'local/kernel-repo',
          repositoryRoot: repoRoot,
          baseRevision: BASE_SHA,
          sourceRevision: BASE_SHA,
          budgets: DEFAULT_HOST_BUDGETS,
          gateEndpoints: [
            {
              id: 'bench-relay',
              implementation: 'benchmark-gate.v1',
              url: 'http://127.0.0.1:42038/v1/benchmark/jobs',
              signingCredentialRef: 'taskpack-provider-token',
              authCredentialRef: null,
            },
          ],
          credentialEnvMap: {
            gate: 'BENCH_SIGN',
          },
        }),
        (err: unknown) => err instanceof TaskpackError && err.code === 'TASKPACK_HOST_BINDING_INVALID',
      );

      // 14. Delegated benchmark-only staging rejects LOOPWRIGHT_LOCAL_GATE_SECRET collision before staging,
      //     while a distinct host signing env resolves to the real host secret via openStagedTaskpackStepGate.
      const benchOnlyRepo = join(dir, 'bench-only-stage-repo');
      const benchOnlyRunRoot = join(dir, 'bench-only-stage-runs');
      await mkdir(join(benchOnlyRepo, 'src'), { recursive: true });
      await mkdir(join(benchOnlyRepo, '.loopwright'), { recursive: true });
      await mkdir(benchOnlyRunRoot, { recursive: true, mode: 0o700 });
      await writeFile(join(benchOnlyRepo, 'src', 'kernel.cu'), '// kernel\n', 'utf8');
      await writeFile(
        join(benchOnlyRepo, '.loopwright', 'taskpack.yaml'),
        serializePrettyYaml(makeHardwareManifestObject()),
        'utf8',
      );
      spawnSync('git', ['init', '-b', 'main'], { cwd: benchOnlyRepo, stdio: 'ignore' });
      spawnSync('git', ['config', 'user.name', 'Loopwright Test'], { cwd: benchOnlyRepo, stdio: 'ignore' });
      spawnSync('git', ['config', 'user.email', 'test@loopwright.invalid'], { cwd: benchOnlyRepo, stdio: 'ignore' });
      spawnSync('git', ['add', '.'], { cwd: benchOnlyRepo, stdio: 'ignore' });
      spawnSync('git', ['commit', '-m', 'Initial'], { cwd: benchOnlyRepo, stdio: 'ignore' });

      const collisionRunId = 'run-bench-local-env-collision';
      await assert.rejects(
        () => stageTaskpackForStep({
          taskpackPath: '.loopwright/taskpack.yaml',
          repositoryRoot: benchOnlyRepo,
          runRoot: benchOnlyRunRoot,
          runId: collisionRunId,
          gateEndpoints: [
            {
              id: 'bench-relay',
              implementation: 'benchmark-gate.v1',
              url: 'http://127.0.0.1:42039/v1/benchmark/jobs',
              signingCredentialRef: 'relay-sign',
              authCredentialRef: null,
            },
          ],
          credentialEnvMap: { gate: DEFAULT_LOCAL_COMMAND_GATE_ENV },
        }),
        (err: unknown) => err instanceof TaskpackError && err.code === 'TASKPACK_HOST_BINDING_INVALID',
      );
      assert.equal(existsSync(join(benchOnlyRunRoot, `.taskpack-${collisionRunId}`)), false);

      // Distinct-name control stages cleanly and resolves real host secret (not generated local secret)
      const distinctRunId = 'run-bench-distinct-env-ok';
      const stagedDistinct = await stageTaskpackForStep({
        taskpackPath: '.loopwright/taskpack.yaml',
        repositoryRoot: benchOnlyRepo,
        runRoot: benchOnlyRunRoot,
        runId: distinctRunId,
        runtimeEnv: { ...process.env, REAL_HOST_RELAY_SIGN: 'real-host-relay-secret-value' },
        gateEndpoints: [
          {
            id: 'bench-relay',
            implementation: 'benchmark-gate.v1',
            url: 'http://127.0.0.1:42039/v1/benchmark/jobs',
            signingCredentialRef: 'relay-sign',
            authCredentialRef: null,
          },
        ],
        credentialEnvMap: { gate: 'REAL_HOST_RELAY_SIGN' },
      });
      const openedDistinct = await openStagedTaskpackStepGate({
        runRoot: benchOnlyRunRoot,
        runId: distinctRunId,
        runtimeEnv: { ...process.env, REAL_HOST_RELAY_SIGN: 'real-host-relay-secret-value' },
      });
      try {
        assert.ok(openedDistinct);
        assert.equal(openedDistinct.environment('REAL_HOST_RELAY_SIGN'), 'real-host-relay-secret-value');
        assert.equal(openedDistinct.environment(DEFAULT_LOCAL_COMMAND_GATE_ENV), stagedDistinct.signingSecret);
        assert.notEqual(openedDistinct.environment('REAL_HOST_RELAY_SIGN'), stagedDistinct.signingSecret);
      } finally {
        await openedDistinct?.close();
      }

      // 15. Shared byCredentialRef assigning LOOPWRIGHT_LOCAL_GATE_SECRET only to taskpack-local-command-signing
      //     (and REAL_HOST_RELAY_SIGN to relay-sign) MUST NOT be falsely rejected during staging.
      const sharedMapRunId = 'run-bench-shared-local-map-ok';
      const stagedSharedMap = await stageTaskpackForStep({
        taskpackPath: '.loopwright/taskpack.yaml',
        repositoryRoot: benchOnlyRepo,
        runRoot: benchOnlyRunRoot,
        runId: sharedMapRunId,
        runtimeEnv: { ...process.env, REAL_HOST_RELAY_SIGN: 'real-host-relay-secret-value' },
        gateEndpoints: [
          {
            id: 'bench-relay',
            implementation: 'benchmark-gate.v1',
            url: 'http://127.0.0.1:42039/v1/benchmark/jobs',
            signingCredentialRef: 'relay-sign',
            authCredentialRef: null,
          },
        ],
        credentialEnvMap: {
          byCredentialRef: {
            'taskpack-local-command-signing': DEFAULT_LOCAL_COMMAND_GATE_ENV,
            'relay-sign': 'REAL_HOST_RELAY_SIGN',
          },
        },
      });
      assert.ok(stagedSharedMap.hostCredentialEnvNames?.includes(DEFAULT_LOCAL_COMMAND_GATE_ENV));
      assert.ok(stagedSharedMap.hostCredentialEnvNames?.includes('REAL_HOST_RELAY_SIGN'));

      // 16. Mixed benchmark + ordinary gate.v1 with manifest signing override and unused global gate fallback
      //     equal to LOOPWRIGHT_LOCAL_GATE_SECRET must stage cleanly (only active emitted templates are checked).
      const mixedOrdinaryOverrideManifest = makeHardwareManifestObject({
        externalGates: [
          ...(((makeHardwareManifestObject().spec as Record<string, unknown>)['verification'] as {
            externalGates: Record<string, unknown>[];
          }).externalGates),
          {
            id: 'ci-ordinary',
            gateId: 'ci-gate',
            endpointId: 'ci-ep',
            required: true,
            signingCredentialRef: 'CI_SIGNING_KEY',
          },
        ],
      });
      await writeFile(
        join(benchOnlyRepo, '.loopwright', 'taskpack.yaml'),
        serializePrettyYaml(mixedOrdinaryOverrideManifest),
        'utf8',
      );
      const mixedOverrideRunId = 'run-bench-ordinary-override-ok';
      const stagedMixedOverride = await stageTaskpackForStep({
        taskpackPath: '.loopwright/taskpack.yaml',
        repositoryRoot: benchOnlyRepo,
        runRoot: benchOnlyRunRoot,
        runId: mixedOverrideRunId,
        runtimeEnv: {
          ...process.env,
          BENCH_SIGNING_KEY: 'bench-signing-real',
          CI_SIGNING_KEY: 'ci-signing-real',
        },
        gateEndpoints: [
          {
            id: 'bench-relay',
            implementation: 'benchmark-gate.v1',
            url: 'http://127.0.0.1:42039/v1/benchmark/jobs',
            signingCredentialRef: 'relay-sign',
            authCredentialRef: null,
          },
          {
            id: 'ci-ep',
            url: 'https://ci.example.test/gate',
            signingCredentialRef: 'ci-sign',
            authCredentialRef: null,
          },
        ],
        credentialEnvMap: {
          gate: DEFAULT_LOCAL_COMMAND_GATE_ENV,
          byCredentialRef: { 'relay-sign': 'BENCH_SIGNING_KEY' },
        },
      });
      assert.ok(stagedMixedOverride.hostCredentialEnvNames?.includes('BENCH_SIGNING_KEY'));
      assert.ok(stagedMixedOverride.hostCredentialEnvNames?.includes(DEFAULT_LOCAL_COMMAND_GATE_ENV));
    });
  });

  it('rejects active publisher credential collisions while allowing unused publicationAuth on signing-only publishers', async () => {
    await withTempDir(async dir => {
      const repoRoot = join(dir, 'repo');
      await mkdir(join(repoRoot, 'src'), { recursive: true });
      await writeFile(join(repoRoot, 'src', 'kernel.cu'), '// kernel\n', 'utf8');

      const prBenchManifest = validateTaskpackV2Manifest({
        ...makeHardwareManifestObject(),
        spec: {
          ...(makeHardwareManifestObject().spec as Record<string, unknown>),
          publication: {
            mode: 'pull_request',
            targetBranch: 'main',
            headBranchPrefix: 'loopwright/',
            titleTemplate: 'perf: optimize kernel',
          },
        },
      } as Json);
      const prEndpointWithAuth = {
        id: 'native-pub',
        url: 'http://127.0.0.1:42099/publish',
        signingCredentialRef: 'taskpack-publication-signing',
        authCredentialRef: 'taskpack-publication-auth',
      };
      for (const badCredMap of [
        {
          provider: 'OPENAI_API_KEY',
          publication: 'LOOPWRIGHT_PUBLICATION_SIGNING_SECRET',
          publicationAuth: 'LOOPWRIGHT_PUBLICATION_AUTH_TOKEN',
          byCredentialRef: { 'relay-sign': 'LOOPWRIGHT_PUBLICATION_SIGNING_SECRET' },
        },
        {
          provider: 'OPENAI_API_KEY',
          publication: 'LOOPWRIGHT_PUBLICATION_SIGNING_SECRET',
          publicationAuth: 'LOOPWRIGHT_PUBLICATION_AUTH_TOKEN',
          byCredentialRef: {
            'relay-sign': 'CUSTOM_BENCH_SIGN',
            'relay-auth': 'LOOPWRIGHT_PUBLICATION_AUTH_TOKEN',
          },
        },
      ] as const) {
        await assert.rejects(
          () => compileDeclarativeTaskpack(prBenchManifest, {
            mode: 'candidate',
            executionMode: 'pi',
            repository: 'local/kernel-repo',
            repositoryRoot: repoRoot,
            baseRevision: BASE_SHA,
            sourceRevision: BASE_SHA,
            budgets: DEFAULT_HOST_BUDGETS,
            publicationEndpoint: prEndpointWithAuth,
            gateEndpoints: [
              {
                id: 'bench-relay',
                implementation: 'benchmark-gate.v1',
                url: 'http://127.0.0.1:42039/v1/benchmark/jobs',
                signingCredentialRef: 'relay-sign',
                authCredentialRef: 'relay-auth' in badCredMap.byCredentialRef ? 'relay-auth' : null,
              },
            ],
            credentialEnvMap: badCredMap,
          }),
          (err: unknown) => err instanceof TaskpackError && err.code === 'TASKPACK_HOST_BINDING_INVALID',
        );
      }

      // Distinct publication vs benchmark envs compile cleanly
      const prDistinctCompiled = await compileDeclarativeTaskpack(prBenchManifest, {
        mode: 'candidate',
        executionMode: 'pi',
        repository: 'local/kernel-repo',
        repositoryRoot: repoRoot,
        baseRevision: BASE_SHA,
        sourceRevision: BASE_SHA,
        budgets: DEFAULT_HOST_BUDGETS,
        publicationEndpoint: prEndpointWithAuth,
        gateEndpoints: [
          {
            id: 'bench-relay',
            implementation: 'benchmark-gate.v1',
            url: 'http://127.0.0.1:42039/v1/benchmark/jobs',
            signingCredentialRef: 'relay-sign',
            authCredentialRef: 'relay-auth',
          },
        ],
        credentialEnvMap: {
          provider: 'OPENAI_API_KEY',
          publication: 'LOOPWRIGHT_PUBLICATION_SIGNING_SECRET',
          publicationAuth: 'LOOPWRIGHT_PUBLICATION_AUTH_TOKEN',
          byCredentialRef: { 'relay-sign': 'CUSTOM_BENCH_SIGN', 'relay-auth': 'CUSTOM_BENCH_AUTH' },
        },
      });
      assert.equal(prDistinctCompiled.config.spec.credentials.find(c => c.ref === 'relay-sign')?.template, '${CUSTOM_BENCH_SIGN}');
      assert.equal(prDistinctCompiled.config.spec.credentials.find(c => c.ref === 'relay-auth')?.template, '${CUSTOM_BENCH_AUTH}');
      assert.equal(
        prDistinctCompiled.config.spec.credentials.find(c => c.ref === 'taskpack-publication-signing')?.template,
        '${LOOPWRIGHT_PUBLICATION_SIGNING_SECRET}',
      );

      // Signing-only external publisher (no authCredentialRef) must NOT reserve unused publicationAuth
      const signingOnlyCompiled = await compileDeclarativeTaskpack(prBenchManifest, {
        mode: 'candidate',
        executionMode: 'delegated',
        repository: 'local/kernel-repo',
        repositoryRoot: repoRoot,
        baseRevision: BASE_SHA,
        sourceRevision: BASE_SHA,
        budgets: DEFAULT_HOST_BUDGETS,
        publicationEndpoint: {
          id: 'ext-pub-sign-only',
          url: 'https://publisher.example.test/publish',
          signingCredentialRef: 'taskpack-publication-signing',
          authCredentialRef: null,
        },
        gateEndpoints: [
          {
            id: 'bench-relay',
            implementation: 'benchmark-gate.v1',
            url: 'http://127.0.0.1:42039/v1/benchmark/jobs',
            signingCredentialRef: 'relay-sign',
            authCredentialRef: null,
          },
        ],
        credentialEnvMap: {
          publication: 'PUB_SIGN_KEY',
          publicationAuth: 'HOST_SPARE',
          byCredentialRef: { 'relay-sign': 'HOST_SPARE' },
        },
      });
      assert.equal(signingOnlyCompiled.config.spec.credentials.length, 2);
      assert.equal(signingOnlyCompiled.config.spec.credentials.find(c => c.ref === 'relay-sign')?.template, '${HOST_SPARE}');
      assert.equal(
        signingOnlyCompiled.config.spec.credentials.find(c => c.ref === 'taskpack-publication-signing')?.template,
        '${PUB_SIGN_KEY}',
      );
    });
  });

  it('rejects decision provider credential overlap with benchmark relay keys while allowing distinct decision credentials', async () => {
    const decisionManifest = validateTaskpackV2Manifest({
      ...makeHardwareManifestObject(),
      spec: {
        ...(makeHardwareManifestObject().spec as Record<string, unknown>),
        decisions: {
          enabled: true,
          provider: 'typesafe-jev',
        },
      },
    } as Json);

    // 1. Compile-time refusal when benchmark relay signing or auth env collides with TYPESAFE_API_KEY
    for (const badCredMap of [
      { byCredentialRef: { 'relay-sign': 'TYPESAFE_API_KEY' } },
      { byCredentialRef: { 'relay-sign': 'CUSTOM_BENCH_SIGN', 'relay-auth': 'TYPESAFE_API_KEY' } },
    ] as const) {
      await assert.rejects(
        () => compileDeclarativeTaskpack(decisionManifest, {
          mode: 'candidate',
          executionMode: 'delegated',
          repository: 'local/kernel-repo',
          baseRevision: BASE_SHA,
          sourceRevision: BASE_SHA,
          budgets: DEFAULT_HOST_BUDGETS,
          gateEndpoints: [
            {
              id: 'bench-relay',
              implementation: 'benchmark-gate.v1',
              url: 'http://127.0.0.1:42039/v1/benchmark/jobs',
              signingCredentialRef: 'relay-sign',
              authCredentialRef: 'relay-auth' in badCredMap.byCredentialRef ? 'relay-auth' : null,
            },
          ],
          credentialEnvMap: badCredMap,
        }),
        (err: unknown) => err instanceof TaskpackError && err.code === 'TASKPACK_HOST_BINDING_INVALID',
      );
    }

    // 2. Runtime createTaskpackDecisionPort refusal when excludedEnvNames contains TYPESAFE_API_KEY
    //    and apiKey is omitted, null, empty, or whitespace-only (never reads the excluded env)
    let readExcludedEnv = false;
    const trapEnv = Object.defineProperty({}, 'TYPESAFE_API_KEY', {
      enumerable: true,
      get() {
        readExcludedEnv = true;
        return 'relay-signing-secret-must-not-leak';
      },
    }) as NodeJS.ProcessEnv;
    for (const absentKey of [undefined, null as unknown as string, '', '   '] as const) {
      assert.throws(
        () => createTaskpackDecisionPort(decisionManifest, {
          runtimeEnv: trapEnv,
          apiKey: absentKey,
          excludedEnvNames: ['TYPESAFE_API_KEY'],
        }),
        (err: unknown) => err instanceof TaskpackError && err.code === 'TASKPACK_HOST_BINDING_INVALID',
      );
    }
    assert.equal(readExcludedEnv, false, 'excluded decision env must never be read for absent, null, empty, or whitespace apiKey');

    // 3. Distinct benchmark signing env + distinct decision credential succeeds at both compile time and runtime,
    //    and delegated stage + reopen with inactive publicationAuth='TYPESAFE_API_KEY' succeeds cleanly.
    const distinctCompiled = await compileDeclarativeTaskpack(decisionManifest, {
      mode: 'candidate',
      executionMode: 'delegated',
      repository: 'local/kernel-repo',
      baseRevision: BASE_SHA,
      sourceRevision: BASE_SHA,
      budgets: DEFAULT_HOST_BUDGETS,
      gateEndpoints: [
        {
          id: 'bench-relay',
          implementation: 'benchmark-gate.v1',
          url: 'http://127.0.0.1:42039/v1/benchmark/jobs',
          signingCredentialRef: 'relay-sign',
          authCredentialRef: null,
        },
      ],
      credentialEnvMap: { byCredentialRef: { 'relay-sign': 'CUSTOM_BENCH_SIGN' } },
    });
    assert.equal(distinctCompiled.config.spec.credentials.find(c => c.ref === 'relay-sign')?.template, '${CUSTOM_BENCH_SIGN}');

    const portWithDistinctEnv = createTaskpackDecisionPort(decisionManifest, {
      runtimeEnv: { TYPESAFE_API_KEY: 'distinct-jev-api-key', CUSTOM_BENCH_SIGN: 'relay-signing-secret' },
      excludedEnvNames: ['CUSTOM_BENCH_SIGN'],
    });
    assert.ok(portWithDistinctEnv);

    const portWithExplicitKey = createTaskpackDecisionPort(decisionManifest, {
      runtimeEnv: { TYPESAFE_API_KEY: 'relay-signing-secret' },
      apiKey: 'explicit-distinct-decision-key',
      excludedEnvNames: ['TYPESAFE_API_KEY'],
    });
    assert.ok(portWithExplicitKey);

    await withTempDir(async dir => {
      const stageRepo = join(dir, 'decision-stage-repo');
      const stageRunRoot = join(dir, 'decision-stage-runs');
      await mkdir(join(stageRepo, 'src'), { recursive: true });
      await mkdir(join(stageRepo, '.loopwright'), { recursive: true });
      await mkdir(stageRunRoot, { recursive: true, mode: 0o700 });
      await writeFile(join(stageRepo, 'src', 'kernel.cu'), '// kernel\n', 'utf8');
      await writeFile(
        join(stageRepo, '.loopwright', 'taskpack.yaml'),
        serializePrettyYaml({
          ...makeHardwareManifestObject(),
          spec: {
            ...(makeHardwareManifestObject().spec as Record<string, unknown>),
            publication: { mode: 'disabled' },
            decisions: { enabled: true, provider: 'typesafe-jev' },
          },
        }),
        'utf8',
      );
      spawnSync('git', ['init', '-b', 'main'], { cwd: stageRepo, stdio: 'ignore' });
      spawnSync('git', ['config', 'user.name', 'Loopwright Test'], { cwd: stageRepo, stdio: 'ignore' });
      spawnSync('git', ['config', 'user.email', 'test@loopwright.invalid'], { cwd: stageRepo, stdio: 'ignore' });
      spawnSync('git', ['add', '.'], { cwd: stageRepo, stdio: 'ignore' });
      spawnSync('git', ['commit', '-m', 'Initial'], { cwd: stageRepo, stdio: 'ignore' });

      const runId = 'run-decision-inactive-pubauth';
      const staged = await stageTaskpackForStep({
        taskpackPath: '.loopwright/taskpack.yaml',
        repositoryRoot: stageRepo,
        runRoot: stageRunRoot,
        runId,
        runtimeEnv: { ...process.env, RELAY_KEY: 'relay-secret', TYPESAFE_API_KEY: 'jev-secret' },
        gateEndpoints: [
          {
            id: 'bench-relay',
            implementation: 'benchmark-gate.v1',
            url: 'http://127.0.0.1:42039/v1/benchmark/jobs',
            signingCredentialRef: 'relay-sign',
            authCredentialRef: null,
          },
        ],
        credentialEnvMap: {
          publicationAuth: 'TYPESAFE_API_KEY',
          byCredentialRef: { 'relay-sign': 'RELAY_KEY' },
        },
      });
      assert.deepEqual(staged.hostGateCredentialEnvNames, ['RELAY_KEY']);
      assert.equal(staged.hostCredentialEnvNames?.includes('TYPESAFE_API_KEY'), true);

      const reopened = await openStagedTaskpackStepGate({
        runRoot: stageRunRoot,
        runId,
        runtimeEnv: { ...process.env, RELAY_KEY: 'relay-secret', TYPESAFE_API_KEY: 'jev-secret' },
      });
      try {
        assert.ok(reopened);
        assert.ok(reopened.decisions, 'decision port must construct when TYPESAFE_API_KEY is only in unused publicationAuth');
      } finally {
        await reopened?.close();
      }
    });
  });

  it('rejects GITHUB_TOKEN and GH_TOKEN as benchmark relay credentials and skips excluded gate envs when reading readOnlyGitHubToken', async () => {
    const manifest = validateTaskpackV2Manifest(makeHardwareManifestObject() as Json);
    for (const badCredMap of [
      { byCredentialRef: { 'relay-sign': 'GITHUB_TOKEN' } },
      { byCredentialRef: { 'relay-sign': 'GH_TOKEN' } },
      { byCredentialRef: { 'relay-sign': 'CUSTOM_BENCH_SIGN', 'relay-auth': 'GITHUB_TOKEN' } },
      { byCredentialRef: { 'relay-sign': 'CUSTOM_BENCH_SIGN', 'relay-auth': 'GH_TOKEN' } },
    ] as const) {
      await assert.rejects(
        () => compileDeclarativeTaskpack(manifest, {
          mode: 'candidate',
          executionMode: 'delegated',
          repository: 'local/kernel-repo',
          baseRevision: BASE_SHA,
          sourceRevision: BASE_SHA,
          budgets: DEFAULT_HOST_BUDGETS,
          gateEndpoints: [
            {
              id: 'bench-relay',
              implementation: 'benchmark-gate.v1',
              url: 'http://127.0.0.1:42039/v1/benchmark/jobs',
              signingCredentialRef: 'relay-sign',
              authCredentialRef: 'relay-auth' in badCredMap.byCredentialRef ? 'relay-auth' : null,
            },
          ],
          credentialEnvMap: badCredMap,
        }),
        (err: unknown) => err instanceof TaskpackError && err.code === 'TASKPACK_HOST_BINDING_INVALID',
      );
    }

    // Defense-in-depth in openStagedTaskpackStepGate: excluded hostGateCredentialEnvNames must never
    // be forwarded as readOnlyGitHubToken to a local command.v1 gate with allowReadOnlyGitHubToken: true.
    await withTempDir(async dir => {
      const stageRepo = join(dir, 'gh-token-stage-repo');
      const stageRunRoot = join(dir, 'gh-token-stage-runs');
      await mkdir(join(stageRepo, 'src'), { recursive: true });
      await mkdir(join(stageRepo, '.loopwright', 'checks'), { recursive: true });
      await mkdir(stageRunRoot, { recursive: true, mode: 0o700 });
      await writeFile(join(stageRepo, 'src', 'app.txt'), 'v1\n', 'utf8');
      const checkScriptPath = join(stageRepo, '.loopwright', 'checks', 'check-gh.sh');
      await writeFile(
        checkScriptPath,
        '#!/bin/sh\nif [ -n "${GITHUB_TOKEN:-}" ]; then exit 1; fi\nexit 0\n',
        'utf8',
      );
      await chmod(checkScriptPath, 0o755);
      await writeFile(
        join(stageRepo, '.loopwright', 'taskpack.yaml'),
        serializePrettyYaml({
          apiVersion: 'loopwright.dev/v1alpha1',
          kind: 'Taskpack',
          metadata: { name: 'gh-token-isolation' },
          spec: {
            goal: {
              candidate: 'Update src/app.txt.',
              noChange: 'Confirm no change needed.',
            },
            scope: {
              writable: ['src/**'],
              protected: [],
            },
            publication: { mode: 'disabled' },
            verification: {
              localChecks: [
                {
                  id: 'assert-no-gh-token',
                  implementation: 'command.v1',
                  parameters: {
                    script: '.loopwright/checks/check-gh.sh',
                    allowReadOnlyGitHubToken: true,
                    timeoutSeconds: 20,
                  },
                },
              ],
              externalGates: [],
            },
          },
        }),
        'utf8',
      );
      spawnSync('git', ['init', '-b', 'main'], { cwd: stageRepo, stdio: 'ignore' });
      spawnSync('git', ['config', 'user.name', 'Loopwright Test'], { cwd: stageRepo, stdio: 'ignore' });
      spawnSync('git', ['config', 'user.email', 'test@loopwright.invalid'], { cwd: stageRepo, stdio: 'ignore' });
      spawnSync('git', ['add', '.'], { cwd: stageRepo, stdio: 'ignore' });
      spawnSync('git', ['commit', '-m', 'Initial'], { cwd: stageRepo, stdio: 'ignore' });

      const runId = 'run-gh-token-excluded';
      const staged = await stageTaskpackForStep({
        taskpackPath: '.loopwright/taskpack.yaml',
        repositoryRoot: stageRepo,
        runRoot: stageRunRoot,
        runId,
        runtimeEnv: {},
      });

      // Simulate a staged secrets.json where GITHUB_TOKEN and GH_TOKEN are listed as excluded host gate envs
      const secretsPath = join(stageRunRoot, `.taskpack-${runId}`, 'secrets.json');
      const secretsDoc = JSON.parse(await readFile(secretsPath, 'utf8')) as Record<string, unknown>;
      secretsDoc['hostGateCredentialEnvNames'] = ['GITHUB_TOKEN', 'GH_TOKEN'];
      await writeFile(secretsPath, `${JSON.stringify(secretsDoc, null, 2)}\n`, { mode: 0o600 });

      const cleanEnv: NodeJS.ProcessEnv = { ...process.env };
      delete cleanEnv['INPUT_GITHUB-TOKEN'];
      cleanEnv['GITHUB_TOKEN'] = 'benchmark-relay-signing-secret';
      cleanEnv['GH_TOKEN'] = 'benchmark-relay-auth-secret';

      const gateHandle = await openStagedTaskpackStepGate({
        runRoot: stageRunRoot,
        runId,
        runtimeEnv: cleanEnv,
      });
      assert.ok(gateHandle !== null);
      try {
        const prevGateSecret = process.env[DEFAULT_LOCAL_COMMAND_GATE_ENV];
        process.env[DEFAULT_LOCAL_COMMAND_GATE_ENV] = gateHandle.environment(DEFAULT_LOCAL_COMMAND_GATE_ENV);
        let loadedCfg: Awaited<ReturnType<typeof loadTrustedConfiguration>>;
        try {
          loadedCfg = await loadTrustedConfiguration({
            configPath: staged.configPath,
            registryPath: staged.registryPath,
            registrySha256: staged.registrySha256,
            untrustedRoots: [stageRepo],
          });
        } finally {
          if (prevGateSecret === undefined) {
            delete process.env[DEFAULT_LOCAL_COMMAND_GATE_ENV];
          } else {
            process.env[DEFAULT_LOCAL_COMMAND_GATE_ENV] = prevGateSecret;
          }
        }
        assert.equal(loadedCfg.ok, true, loadedCfg.ok ? '' : JSON.stringify(loadedCfg.error));
        if (!loadedCfg.ok) return;

        const next = await stepNext(
          {
            configuration: loadedCfg.value,
            repository: stageRepo,
            runRoot: stageRunRoot,
            runId,
            policyProfile: gateHandle.policyProfile,
            environment: gateHandle.environment,
          },
          gateHandle.ports,
        );
        assert.equal(next.ok, true, next.ok ? '' : JSON.stringify(next.error));
        if (!next.ok) return;
        assert.equal(next.value.kind, 'step');
        if (next.value.kind !== 'step') return;

        await writeFile(join(next.value.candidateDir, 'src', 'app.txt'), 'v2\n', 'utf8');
        const sub = await stepSubmit(
          {
            runRoot: stageRunRoot,
            runId,
            leaseToken: next.value.leaseToken,
            status: 'completed',
            reason: 'Updated src/app.txt.',
            environment: gateHandle.environment,
          },
          gateHandle.ports,
        );
        assert.equal(sub.ok, true, sub.ok ? '' : JSON.stringify(sub.error));
        if (!sub.ok) return;
        assert.equal(sub.value.kind, 'result');
        if (sub.value.kind !== 'result') return;
        assert.equal(sub.value.result.spec.status, 'completed');
      } finally {
        await gateHandle.close();
      }
    });
  });

  it('rejects reserved GitHub token envs on ordinary gate.v1 credentials', async () => {
    await withTempDir(async dir => {
      const repoRoot = join(dir, 'repo');
      await mkdir(join(repoRoot, 'src'), { recursive: true });
      await writeFile(join(repoRoot, 'src', 'app.txt'), 'v1\n', 'utf8');

      const ordinaryGateManifest = parseTaskpackManifest(
        serializePrettyYaml({
          apiVersion: 'loopwright.dev/v1alpha1',
          kind: 'Taskpack',
          metadata: { name: 'ordinary-gate-gh-guard' },
          spec: {
            goal: { candidate: 'Update app', noChange: 'Confirm clean' },
            scope: { writable: ['src/**'] },
            verification: {
              localChecks: [],
              externalGates: [
                {
                  id: 'gate-a',
                  gateId: 'gate-a',
                  endpointId: 'ep-a',
                  implementation: 'gate.v1',
                  required: true,
                  url: 'https://gate-a.example.test/v1/gate',
                  signingCredentialRef: 'ordinary-gate-signing',
                },
              ],
            },
          },
        }),
        { policyProfile: 'local' },
      );

      for (const forbidden of ['GITHUB_TOKEN', 'GH_TOKEN']) {
        await assert.rejects(
          () => compileDeclarativeTaskpack(ordinaryGateManifest, {
            mode: 'candidate',
            executionMode: 'pi',
            repository: 'local/ordinary-gate-repo',
            repositoryRoot: repoRoot,
            baseRevision: BASE_SHA,
            sourceRevision: BASE_SHA,
            budgets: DEFAULT_HOST_BUDGETS,
            credentialEnvMap: { byCredentialRef: { 'ordinary-gate-signing': forbidden } },
          }),
          (err: unknown) => err instanceof TaskpackError && err.code === 'TASKPACK_HOST_BINDING_INVALID',
        );
      }
    });
  });
});
