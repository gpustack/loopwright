import assert from 'node:assert/strict';
import { execFile, execFileSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';
import { SecretScrubber, type ArtifactRef } from '@loopwright/core';
import {
  auditSealedStageAOutputs,
  canonicalJson,
  collectHardwareProvenance,
  probeAcceleratorHealth,
  removeTreeFailClosed,
  sealStageAOutputs,
  signRelayPayload,
  type ProbeCommandRunner,
} from '@loopwright/hardware-runner';
import {
  exportEvolutionBundle,
  runEvolutionCampaign,
  verifyEvolutionBundle,
} from '../src/index.js';

const execFileAsync = promisify(execFile);

function sha256(bytes: Uint8Array | string) {
  return { algorithm: 'sha256' as const, hex: createHash('sha256').update(bytes).digest('hex') };
}

function makeSshProbeRunner(sshTarget: string): ProbeCommandRunner {
  return async (binaryPath, args, opts) => {
    const remoteCmd = [binaryPath, ...args]
      .map(tok => `'${tok.replace(/'/g, `'\\''`)}'`)
      .join(' ');
    try {
      const { stdout, stderr } = await execFileAsync(
        'ssh',
        ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', sshTarget, remoteCmd],
        {
          timeout: opts.timeoutMs,
          maxBuffer: 4 * 1024 * 1024,
          ...(opts.signal !== undefined ? { signal: opts.signal } : {}),
        },
      );
      return { stdout, stderr, exitCode: 0 };
    } catch (err: unknown) {
      const e = err as { code?: unknown; stdout?: string; stderr?: string; message?: string };
      return {
        exitCode: typeof e.code === 'number' ? e.code : 1,
        stdout: e.stdout ?? '',
        stderr: e.stderr ?? e.message ?? 'ssh probe failed',
      };
    }
  };
}

async function remoteWhichOptional(sshHost: string, bin: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync(
      'ssh',
      ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', sshHost, `command -v ${bin}`],
      { timeout: 10_000 },
    );
    const trimmed = stdout.trim();
    return trimmed.length > 0 ? trimmed : null;
  } catch {
    return null;
  }
}

async function runHostLivePhysicalCampaign(options: {
  readonly vendor: 'nvidia' | 'amd';
  readonly sshHost: string;
  readonly expectedAccelerator: string;
}): Promise<void> {
  const { vendor, sshHost, expectedAccelerator } = options;
  const isCuda = vendor === 'nvidia';
  const sshRunner = makeSshProbeRunner(sshHost);
  const scrubber = new SecretScrubber();
  const hmacSecret = `live-gpu-hmac-${randomBytes(16).toString('hex')}`;
  scrubber.register(hmacSecret);

  const smiPath = await remoteWhichOptional(sshHost, isCuda ? 'nvidia-smi' : 'rocm-smi');
  assert.ok(smiPath !== null, `expected ${isCuda ? 'nvidia-smi' : 'rocm-smi'} on ${sshHost}`);

  const workloadDigest = sha256(`live-gpu-workload:${vendor}:${sshHost}`);
  const capabilities = {
    accelerator: expectedAccelerator,
    isolationModes: ['whole_device'] as const,
    deviceCount: 1,
    driverVersion: '0.0.0',
    workloadIds: ['live-vec-scale-holdout'],
  };

  // 1. Live physical hardware provenance + post-crash health probe over SSH
  const provenance = await collectHardwareProvenance({
    probeMode: 'physical',
    targetCellId: `live-${vendor}-cell`,
    capabilities,
    workloadDigest,
    executableOverrides: isCuda ? { nvidiaSmiPath: smiPath } : { rocmSmiPath: smiPath },
    commandRunner: sshRunner,
    verifyExecutable: async p => p,
  });
  assert.equal(provenance.probeKind, 'physical');
  assert.equal(provenance.vendor, vendor);

  const health = await probeAcceleratorHealth({
    probeMode: 'physical',
    capabilities: {
      ...capabilities,
      driverVersion: provenance.driverVersion,
    },
    executableOverrides: isCuda ? { nvidiaSmiPath: smiPath } : { rocmSmiPath: smiPath },
    commandRunner: sshRunner,
    verifyExecutable: async p => p,
    scrubber,
  });
  assert.equal(health.healthy, true, `unhealthy ${vendor} host ${sshHost}: ${health.summary}`);
  assert.equal(health.quarantineRequired, false);

  const tempDir = mkdtempSync(join(realpathSync(tmpdir()), `evo-live-${vendor}-`));
  try {
    // 2. Produce real Stage A binary/PTX artifact (using remote nvcc/hipcc if present, else valid PTX),
    //    seal it (0o400/0o500), and verify Stage A static symbol audit!
    const nvccPath = isCuda ? await remoteWhichOptional(sshHost, 'nvcc') : null;
    const hipccPath = !isCuda ? await remoteWhichOptional(sshHost, 'hipcc') : null;

    let stageABlobName = 'vec_scale.ptx';
    let stageABlobBytes: Buffer;
    if (isCuda && nvccPath !== null) {
      const { stdout: ptxText } = await execFileAsync(
        'ssh',
        [
          '-o',
          'BatchMode=yes',
          sshHost,
          'tmp=$(mktemp -d) && printf \'extern "C" __global__ void vec_scale(float* x, float s) { int i = blockIdx.x * blockDim.x + threadIdx.x; x[i] *= s; }\\n\' > "$tmp/k.cu" && nvcc -ptx "$tmp/k.cu" -o "$tmp/k.ptx" && cat "$tmp/k.ptx" && rm -rf "$tmp"',
        ],
        { timeout: 30_000, maxBuffer: 8 * 1024 * 1024 },
      );
      stageABlobName = 'vec_scale.ptx';
      stageABlobBytes = Buffer.from(ptxText, 'utf8');
    } else if (!isCuda && hipccPath !== null) {
      const { stdout: hsacoB64 } = await execFileAsync(
        'ssh',
        [
          '-o',
          'BatchMode=yes',
          sshHost,
          'tmp=$(mktemp -d) && printf \'#include <hip/hip_runtime.h>\\nextern "C" __global__ void vec_scale(float* x, float s) { int i = blockIdx.x * blockDim.x + threadIdx.x; x[i] *= s; }\\n\' > "$tmp/k.cpp" && hipcc --genco "$tmp/k.cpp" -o "$tmp/k.hsaco" && base64 < "$tmp/k.hsaco" && rm -rf "$tmp"',
        ],
        { timeout: 45_000, maxBuffer: 8 * 1024 * 1024 },
      );
      stageABlobName = 'vec_scale.hsaco';
      stageABlobBytes = Buffer.from(hsacoB64.replace(/\s+/g, ''), 'base64');
    } else {
      stageABlobName = 'vec_scale.ptx';
      stageABlobBytes = Buffer.from(
        [
          '.version 7.0',
          '.target sm_80',
          '.address_size 64',
          '.visible .entry vec_scale() {',
          '  .reg .b32 %r<16>;',
          '  ret;',
          '}',
          '',
        ].join('\n'),
        'utf8',
      );
    }

    const stageACheckDir = join(tempDir, 'stage-a-audit-check');
    mkdirSync(stageACheckDir, { recursive: true, mode: 0o700 });
    writeFileSync(join(stageACheckDir, stageABlobName), stageABlobBytes);
    const sealed = await sealStageAOutputs({
      stageAOutDir: stageACheckDir,
      scrubber,
      secretOverlapBytes: 64,
    });
    assert.equal(sealed.length, 1);
    const auditRes = await auditSealedStageAOutputs({
      sealedOutputs: sealed,
      auditSpec: {
        forbiddenSymbolPatterns: isCuda ? ['cublas', 'cudnn'] : ['rocblas', 'miopen'],
        maxRegisterCount: 64,
        maxLocalSpillBytes: 0,
      },
      scrubber,
    });
    assert.equal(auditRes.passed, true, `Stage A static audit failed: ${JSON.stringify(auditRes.findings)}`);

    // 3. Run 2-generation evolutionary campaign with real physical provenance & HMAC receipts,
    //    then export & verify evolution-bundle.v1 (oci-layout) WITHOUT allowSyntheticProbe!
    const repoDir = join(tempDir, 'repo');
    mkdirSync(join(repoDir, '.loopwright'), { recursive: true, mode: 0o700 });
    mkdirSync(join(repoDir, 'src', 'kernels'), { recursive: true, mode: 0o700 });

    const baselineKernel = [
      'extern "C" __global__ void vec_scale(float* x, float s) {',
      '// EVOLVE-BLOCK-START: body',
      '  int i = blockIdx.x * blockDim.x + threadIdx.x;',
      '  x[i] = x[i] * s;',
      '// EVOLVE-BLOCK-END: body',
      '}',
      '',
    ].join('\n');

    const taskpackYaml = [
      'apiVersion: loopwright.dev/v1alpha1',
      'kind: Taskpack',
      'metadata:',
      `  name: live-${vendor}-smoke`,
      'spec:',
      '  goal:',
      '    candidate: Optimize vec_scale kernel inside EVOLVE-BLOCK.',
      '    noChange: No change.',
      '  target:',
      '    matrix:',
      `      - id: live-${vendor}-cell`,
      '        platform: linux/amd64',
      `        variant: ${vendor}`,
      '        hardware:',
      `          accelerator: ${provenance.accelerator}`,
      '          isolationMode: whole_device',
      '          deviceCount: 1',
      `          driverConstraint: ">=${provenance.driverVersion}"`,
      '          forbiddenSymbolPatterns:',
      `            - ${isCuda ? 'cublas' : 'rocblas'}`,
      '  scope:',
      '    writable: [src/kernels/**]',
      '    protected: [scripts/**]',
      '  models:',
      '    - provider: anthropic',
      '      id: claude-sonnet-4-6',
      '      thinking: medium',
      '  roles:',
      '    - id: mutator',
      '      provider: anthropic',
      '      model: claude-sonnet-4-6',
      '      purpose: task',
      '      tools: [read, write, edit, bash]',
      '      prompt: Optimize vec_scale.cu inside EVOLVE-BLOCK.',
      '  verification:',
      '    localChecks:',
      '      - id: evolve-guard',
      '        implementation: evolve-block-guard.v1',
      '        parameters:',
      '          files: [src/kernels/vec_scale.cu]',
      '    externalGates:',
      '      - id: gpu-bench',
      '        implementation: benchmark-gate.v1',
      '        endpointId: hw-relay',
      '        gateId: live-gpu-bench',
      '        required: true',
      `        targetCellId: live-${vendor}-cell`,
      '        heldOutWorkloadId: live-vec-scale-holdout',
      '        allowSyntheticHardwareProbe: false',
      '        metricThresholds:',
      '          - kind: bounds',
      '            metric: max_ulp',
      '            max: 1',
      '  publication:',
      '    mode: disabled',
      '',
    ].join('\n');

    const campaignYaml = [
      'apiVersion: loopwright.dev/v1alpha1',
      'kind: EvolutionCampaign',
      'metadata:',
      `  name: live-${vendor}-campaign`,
      'spec:',
      '  taskpack: .loopwright/taskpack.yaml',
      `  targetCellId: live-${vendor}-cell`,
      '  stages:',
      '    mode: single-target',
      '  population:',
      '    islands: 1',
      '    migrationIntervalGenerations: 2',
      '    maxMigrationElites: 1',
      '    nicheAxes:',
      '      - id: bound_pipeline',
      '        kind: enum',
      '        values: [hbm, tensor_cube]',
      '  sampling:',
      '    noveltyDecayLambda: 1.0',
      '    mutationWeights:',
      '      diff_tune: 0.5',
      '      full_rewrite: 0.5',
      '      crossover: 0.0',
      '    maxCrossoversPerPrompt: 1',
      '  objectives:',
      '    - metric: latency_us_p50',
      '      direction: minimize',
      '  budgets:',
      '    maxGenerations: 2',
      '    maxEvaluations: 2',
      '    maxConcurrentEvaluations: 1',
      '    scratchpadIntervalGenerations: 2',
      '',
    ].join('\n');

    writeFileSync(join(repoDir, '.loopwright', 'taskpack.yaml'), taskpackYaml, 'utf8');
    writeFileSync(join(repoDir, 'src', 'kernels', 'vec_scale.cu'), baselineKernel, 'utf8');

    const gitEnv = {
      PATH: '/usr/bin:/bin',
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_AUTHOR_NAME: 'Loopwright Live GPU',
      GIT_AUTHOR_EMAIL: 'gpu@loopwright.dev',
      GIT_COMMITTER_NAME: 'Loopwright Live GPU',
      GIT_COMMITTER_EMAIL: 'gpu@loopwright.dev',
    };
    execFileSync('/usr/bin/git', ['init', '-b', 'main'], { cwd: repoDir, env: gitEnv, stdio: 'ignore' });
    execFileSync('/usr/bin/git', ['add', '.'], { cwd: repoDir, env: gitEnv, stdio: 'ignore' });
    execFileSync('/usr/bin/git', ['commit', '-m', 'Baseline live GPU kernel'], { cwd: repoDir, env: gitEnv, stdio: 'ignore' });
    const baseRevision = execFileSync('/usr/bin/git', ['rev-parse', 'HEAD'], { cwd: repoDir, env: gitEnv, encoding: 'utf8' }).trim();

    const campaignRoot = join(tempDir, 'campaign');
    const bundleOutDir = join(tempDir, 'live-bundle-oci');
    const blobDigest = sha256(readFileSync(join(stageACheckDir, stageABlobName)));
    let evalSeq = 0;

    const campaignRes = await runEvolutionCampaign({
      campaignRoot,
      campaignId: `camp-live-${vendor}`,
      manifest: campaignYaml,
      repositoryRoot: repoDir,
      baseRevision,
      autoExport: false,
      allowSyntheticProbe: false,
      receiptSigningSecret: hmacSecret,
      scrubber,
      evaluator: async proposal => {
        evalSeq += 1;
        const latencyUs = evalSeq === 1 ? 26.0 : 18.5;
        const outputArtifacts: readonly ArtifactRef[] = [{
          name: stageABlobName,
          digest: blobDigest,
          byteLength: stageABlobBytes.byteLength,
          mediaType: 'application/octet-stream',
        }];
        const lockHash = sha256(`live-lock:${proposal.individualId}`);
        const verdictBody = {
          version: 1,
          kind: 'benchmark_verdict',
          storeId: `live-${vendor}-store`,
          runId: proposal.individualId,
          operationId: `verify.0.check.gpu-bench.${evalSeq}`,
          dispatchId: `disp-${evalSeq}`,
          dispatchGeneration: 1,
          gateId: 'live-gpu-bench',
          checkId: 'gpu-bench',
          candidateDigest: blobDigest.hex,
          expiresAtMs: String(Date.now() + 3_600_000),
          preemptionCount: 0,
          lockHash,
          status: 'approved',
          reason: null,
          metrics: { latency_us_p50: latencyUs, max_ulp: 0 },
          bucketMetrics: [{
            bucketId: 'live-vec-scale-holdout',
            dimensions: { unroll: evalSeq === 1 ? 1 : 4 },
            metrics: { latency_us_p50: latencyUs, max_ulp: 0 },
          }],
          hardwareDiagnostics: {
            boundPipeline: 'hbm' as const,
            occupancyPct: 75,
            rooflineHeadroom: evalSeq === 1 ? 1.35 : 1.12,
          },
          hardwareProvenance: provenance,
          outputArtifacts,
        };
        const sig = signRelayPayload(hmacSecret, canonicalJson(verdictBody)).replace(/^sha256=/, '');
        const rawVerdictReceiptBytes = Buffer.from(`${canonicalJson({ ...verdictBody, signature: sig })}\n`, 'utf8');

        return {
          status: 'passed',
          failureReason: null,
          codeSlice: `// EVOLVE-BLOCK-START: body\n  // gen=${evalSeq}\n// EVOLVE-BLOCK-END: body\n`,
          metrics: { latency_us_p50: latencyUs, max_ulp: 0 },
          bucketMetrics: verdictBody.bucketMetrics,
          hardwareDiagnostics: verdictBody.hardwareDiagnostics,
          hardwareProvenance: provenance,
          outputArtifacts,
          stageABlobs: [{
            name: stageABlobName,
            bytes: stageABlobBytes,
            digest: blobDigest,
            byteLength: stageABlobBytes.byteLength,
            mediaType: 'application/octet-stream',
          }],
          rawVerdictReceiptBytes,
          evidenceDigest: sha256(`ev:${proposal.individualId}`),
          childRunRelPath: `runs/${proposal.individualId}`,
        };
      },
    });

    try {
      assert.equal(campaignRes.campaign.status, 'completed');
      assert.ok(campaignRes.paretoFrontier.length >= 1);

      const exported = await exportEvolutionBundle({
        store: campaignRes.store,
        campaignId: campaignRes.campaign.campaignId,
        outputDir: bundleOutDir,
        format: 'oci-layout',
        allowSyntheticProbe: false,
        receiptSigningSecret: hmacSecret,
        scrubber,
      });
      assert.ok(exported.exportedIndividualIds.length >= 1);

      const verified = await verifyEvolutionBundle({
        bundleDir: bundleOutDir,
        allowSyntheticProbe: false,
        receiptSigningSecret: hmacSecret,
        scrubber,
      });
      assert.equal(verified.format, 'oci-layout');
      assert.equal(verified.manifest.compatibility.accelerator, provenance.accelerator);
      assert.equal(verified.manifest.compatibility.driverConstraint, `>=${provenance.driverVersion}`);
      assert.ok(verified.receiptCount >= 1);
    } finally {
      await campaignRes.store.close();
    }
  } finally {
    await removeTreeFailClosed(tempDir);
  }
}

test('live-gpu-smoke: physical CUDA/ROCm SSH probe, Stage A PTX/ELF static audit, 2-gen campaign, and physical bundle export', async t => {
  const cudaHost = process.env['LOOPWRIGHT_CUDA_SSH_HOST']?.trim();
  const rocmHost = process.env['LOOPWRIGHT_ROCM_SSH_HOST']?.trim();

  if (!cudaHost && !rocmHost) {
    t.skip('Skipping live physical GPU smoke test: set LOOPWRIGHT_CUDA_SSH_HOST or LOOPWRIGHT_ROCM_SSH_HOST to enable.');
    return;
  }

  if (cudaHost) {
    await runHostLivePhysicalCampaign({
      vendor: 'nvidia',
      sshHost: cudaHost,
      expectedAccelerator: process.env['LOOPWRIGHT_CUDA_ACCELERATOR']?.trim() || 'sm_89',
    });
  }

  if (rocmHost) {
    await runHostLivePhysicalCampaign({
      vendor: 'amd',
      sshHost: rocmHost,
      expectedAccelerator: process.env['LOOPWRIGHT_ROCM_ACCELERATOR']?.trim() || 'gfx1101',
    });
  }
});
