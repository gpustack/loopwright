import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, link, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { digestArtifactFromMetadata, matchesHardwareTarget, validateDocument } from '@loopwright/core';
import {
  collectHardwareProvenance,
  computeHeldOutWorkloadDigest,
  defaultProbeCommandRunner,
  HardwareRunnerError,
  parseNpuSmiOutput,
  parseNvidiaSmiOutput,
  parseRocmSmiOutput,
  snapshotHeldOutWorkload,
  TRUSTED_NVIDIA_SMI_PATHS,
  verifyTrustedProbeExecutable,
  verifyTrustedSystemExecutableSync,
  type ProbeCommandRunner,
} from '../src/index.js';

test('parseNvidiaSmiOutput parses CUDA GPUs, sm_89 / sm_90a Hopper capabilities, MIG slicing, measured topo -m matrix, and honest unknown runtime/topology', () => {
  const rtx4090 = parseNvidiaSmiOutput(
    'NVIDIA GeForce RTX 4090, 8.9, 550.120, N/A\n',
    'Driver Version: 550.120\nCUDA Version: 12.4\nClocks: Locked\n',
  );
  assert.equal(rtx4090.vendor, 'nvidia');
  assert.equal(rtx4090.deviceModel, 'NVIDIA GeForce RTX 4090');
  assert.equal(rtx4090.accelerator, 'sm_89');
  assert.equal(rtx4090.isolationMode, 'whole_device');
  assert.equal(rtx4090.deviceCount, 1);
  assert.equal(rtx4090.driverVersion, '550.120');
  // Host nvidia-smi -q "CUDA Version:" is a driver cap, never container/workload runtimeVersion
  assert.equal(rtx4090.runtimeVersion, 'cuda-unknown');
  assert.equal(rtx4090.topology, undefined);
  assert.equal(rtx4090.clockLockMode, 'locked');

  const topoMatrixNv18 = [
    '        GPU0    GPU1    CPU Affinity',
    'GPU0     X      NV18    0-47',
    'GPU1    NV18     X      48-95',
  ].join('\n');
  const h100 = parseNvidiaSmiOutput(
    [
      'NVIDIA H100 80GB HBM3, 9.0, 550.90.07, Disabled',
      'NVIDIA H100 80GB HBM3, 9.0, 550.90.07, Disabled',
    ].join('\n'),
    'CUDA Version                          : 12.6\n',
    { preferredAccelerator: 'sm_90a', topoOutput: topoMatrixNv18, allocatedDeviceCount: 2 },
  );
  assert.equal(h100.accelerator, 'sm_90a');
  assert.equal(h100.deviceCount, 2);
  assert.equal(h100.isolationMode, 'whole_device');
  assert.equal(h100.runtimeVersion, 'cuda-unknown');
  assert.equal(h100.topology, 'nv18');

  // Unobserved CUDA version stays cuda-unknown (never derived from driverVersion)
  const rtxUnknownRt = parseNvidiaSmiOutput(
    'NVIDIA GeForce RTX 4090, 8.9, 550.120, Disabled\n',
    '',
    { preferredAccelerator: 'sm_90a' },
  );
  assert.equal(rtxUnknownRt.accelerator, 'sm_89');
  assert.equal(rtxUnknownRt.runtimeVersion, 'cuda-unknown');
  assert.equal(rtxUnknownRt.topology, undefined);

  const migSliced = parseNvidiaSmiOutput(
    'NVIDIA A100-SXM4-80GB, 8.0, 535.161.08, Enabled, cuda-12.2, unlocked\n',
  );
  assert.equal(migSliced.accelerator, 'sm_80');
  assert.equal(migSliced.isolationMode, 'sliced');
  assert.equal(migSliced.runtimeVersion, 'cuda-12.2');
  assert.equal(migSliced.clockLockMode, 'unlocked');

  assert.throws(() => parseNvidiaSmiOutput(''), { name: 'HardwareRunnerError' });
  assert.throws(
    () =>
      parseNvidiaSmiOutput(
        'NVIDIA H100, 9.0, 550.90.07, Disabled\nNVIDIA RTX 4090, 8.9, 550.90.07, Disabled\n',
      ),
    /heterogeneous CUDA compute capabilities/,
  );
});

test('parseRocmSmiOutput and parseNpuSmiOutput measure real topology and never fabricate runtime/driver versions from each other', () => {
  const jsonSmi = JSON.stringify({
    card0: {
      'Card series': 'AMD Radeon RX 7800 XT',
      'Card model': '0x747e',
      'Performance Level': 'manual',
    },
    system: {
      'Driver version': '6.8.5',
      'ROCm version': '6.2.4',
    },
  });
  const rocminfo = [
    '*******',
    'Agent 1',
    '*******',
    '  Name:                    AMD EPYC 9654 96-Core Processor',
    '  Device Type:             CPU',
    '*******',
    'Agent 2',
    '*******',
    '  Name:                    gfx1101',
    '  Marketing Name:          AMD Radeon RX 7800 XT',
    '  Device Type:             GPU',
  ].join('\n');

  const rx7800 = parseRocmSmiOutput(jsonSmi, rocminfo);
  assert.equal(rx7800.vendor, 'amd');
  assert.equal(rx7800.accelerator, 'gfx1101');
  assert.equal(rx7800.deviceModel, 'AMD Radeon RX 7800 XT');
  assert.equal(rx7800.deviceCount, 1);
  assert.equal(rx7800.driverVersion, '6.8.5');
  assert.equal(rx7800.runtimeVersion, '6.2.4');
  assert.equal(rx7800.topology, undefined);
  assert.equal(rx7800.clockLockMode, 'locked');

  // Missing ROCm runtime version stays 'rocm-unknown' instead of copying kernel driver version '6.8.5'
  const rocmNoRuntime = parseRocmSmiOutput(
    'GPU[0] : Card Series: AMD Instinct MI300X\nGPU[0] : GFX Version: gfx942\nDriver version: 6.8.5\n',
    '',
  );
  assert.equal(rocmNoRuntime.driverVersion, '6.8.5');
  assert.equal(rocmNoRuntime.runtimeVersion, 'rocm-unknown');
  assert.equal(rocmNoRuntime.topology, undefined);

  // Measured XGMI topology from rocm-smi --showtopo
  const mi300Text = [
    'GPU[0] : Card Series: AMD Instinct MI300X',
    'GPU[0] : GFX Version: gfx942',
    'GPU[0] : Compute Partition: CPX',
    'GPU[1] : Card Series: AMD Instinct MI300X',
    'GPU[1] : GFX Version: gfx942',
    'Driver version: 6.7.0',
    'ROCm version: 6.2.0',
  ].join('\n');
  const rocmTopo = [
    '        GPU0    GPU1',
    'GPU0    X       XGMI',
    'GPU1    XGMI    X',
  ].join('\n');
  const mi300 = parseRocmSmiOutput(mi300Text, '', { topoOutput: rocmTopo, allocatedDeviceCount: 2 });
  assert.equal(mi300.accelerator, 'gfx942');
  assert.equal(mi300.deviceCount, 2);
  assert.equal(mi300.isolationMode, 'sliced');
  assert.equal(mi300.topology, 'xgmi');

  // Ascend NPU: measured HCCS matrix vs unobserved CANN version ('cann-unknown', never 'cann-23.0.3')
  const tableOut = [
    '+------------------------------------------------------------------------------------------------+',
    '| npu-smi 24.1.0                   Version: 24.1.0                                               |',
    '| CANN Version: 8.0.RC3                                                                          |',
    '+---------------------------+---------------+----------------------------------------------------+',
    '| 0     910B3               | OK            | 92.4        38                0    / 0             |',
    '| 1     910B3               | OK            | 90.1        37                0    / 0             |',
    '+===========================+===============+====================================================+',
  ].join('\n');
  const npuTopo = '        NPU0    NPU1\nNPU0    X       HCCS\nNPU1    HCCS    X\n';
  const ascend = parseNpuSmiOutput(tableOut, { topoOutput: npuTopo, allocatedDeviceCount: 2 });
  assert.equal(ascend.vendor, 'huawei');
  assert.equal(ascend.accelerator, 'ascend_910b');
  assert.equal(ascend.deviceCount, 2);
  assert.equal(ascend.driverVersion, '24.1.0');
  assert.equal(ascend.runtimeVersion, 'cann-8.0.RC3');
  assert.equal(ascend.topology, 'hccs');

  const slicedKv = [
    'Driver Version : 23.0.3',
    'Chip Name : Ascend 910B2',
    'vNPU : Vir04',
  ].join('\n');
  const vnpu = parseNpuSmiOutput(slicedKv);
  assert.equal(vnpu.accelerator, 'ascend_910b');
  assert.equal(vnpu.isolationMode, 'sliced');
  assert.equal(vnpu.runtimeVersion, 'cann-unknown');
  assert.equal(vnpu.topology, undefined);
});

test('verifyTrustedProbeExecutable enforces uid===0 + non-writable parents on system paths and rejects owner-writable or writable-parent binaries', async () => {
  // 1. Real root-owned OS binary (/bin/sh) passes production verification with zero test overrides
  const realSh = await verifyTrustedProbeExecutable('/bin/sh', ['/bin/sh']);
  assert.equal(realSh.length > 0, true);

  const dir = await mkdtemp(join(tmpdir(), 'lw-prov-exec-'));
  await chmod(dir, 0o700);
  try {
    const fakeBin = join(dir, 'nvidia-smi');
    await writeFile(fakeBin, '#!/bin/sh\necho ok\n', { mode: 0o500 });
    await chmod(fakeBin, 0o500);

    // 2. Rejects path outside TRUSTED_NVIDIA_SMI_PATHS
    await assert.rejects(
      () => verifyTrustedProbeExecutable(fakeBin, TRUSTED_NVIDIA_SMI_PATHS),
      (err: unknown) => err instanceof HardwareRunnerError && err.code === 'RUNNER_SANDBOX_FAILED',
    );

    // 3. Production mode (no _testOnlyTrustedRoot) rejects non-root / temp-dir binary even if in allowlist!
    await assert.rejects(
      () => verifyTrustedProbeExecutable(fakeBin, [fakeBin]),
      (err: unknown) => err instanceof HardwareRunnerError && err.code === 'RUNNER_SANDBOX_FAILED',
    );

    // 4. Rejects owner-writable (0o755) non-root executable even inside _testOnlyTrustedRoot
    const ownerWritableBin = join(dir, 'owner-writable-smi');
    await writeFile(ownerWritableBin, '#!/bin/sh\necho ok\n', { mode: 0o755 });
    await chmod(ownerWritableBin, 0o755);
    assert.throws(
      () => verifyTrustedSystemExecutableSync(ownerWritableBin, [ownerWritableBin], { _testOnlyTrustedRoot: dir }),
      /owner-writable/,
    );

    // 5. Rejects group/world-writable parent directory even when binary itself is 0o500
    const badParent = join(dir, 'writable-parent');
    await mkdir(badParent, { mode: 0o775 });
    await chmod(badParent, 0o775);
    const childBin = join(badParent, 'smi');
    await writeFile(childBin, '#!/bin/sh\necho ok\n', { mode: 0o500 });
    await chmod(childBin, 0o500);
    await assert.rejects(
      () => verifyTrustedProbeExecutable(childBin, [childBin], { _testOnlyTrustedRoot: dir }),
      /group or world writable/,
    );

    // 6. Rejects symlinks
    const linkBin = join(dir, 'symlink-smi');
    await symlink(fakeBin, linkBin);
    await assert.rejects(
      () => verifyTrustedProbeExecutable(linkBin, [linkBin], { _testOnlyTrustedRoot: dir }),
      (err: unknown) => err instanceof HardwareRunnerError && err.code === 'RUNNER_SANDBOX_FAILED',
    );

    // 7. Rejects non-executable regular file
    const nonExecBin = join(dir, 'nonexec-smi');
    await writeFile(nonExecBin, 'plain text\n', { mode: 0o400 });
    await chmod(nonExecBin, 0o400);
    await assert.rejects(
      () => verifyTrustedProbeExecutable(nonExecBin, [nonExecBin], { _testOnlyTrustedRoot: dir }),
      (err: unknown) => err instanceof HardwareRunnerError && err.code === 'RUNNER_SANDBOX_FAILED',
    );

    // 8. Accepts sealed 0o500 regular file inside 0o700 _testOnlyTrustedRoot
    const verified = await verifyTrustedProbeExecutable(fakeBin, [fakeBin], {
      allowRootSystemSymlink: false,
      _testOnlyTrustedRoot: dir,
    });
    assert.equal(verified, fakeBin);
  } finally {
    await chmod(dir, 0o700).catch(() => {});
    await rm(dir, { recursive: true, force: true });
  }
});

test('computeHeldOutWorkloadDigest and snapshotHeldOutWorkload enforce O_NOFOLLOW and isolate immutable snapshot from live edits', async () => {
  const root = await mkdtemp(join(tmpdir(), 'lw-prov-workload-'));
  try {
    const workloadsA = join(root, 'workloads-a');
    const workloadsB = join(root, 'workloads-b');
    await mkdir(join(workloadsA, 'gemm-4096', 'inputs'), { recursive: true, mode: 0o700 });
    await mkdir(join(workloadsB, 'gemm-4096', 'inputs'), { recursive: true, mode: 0o700 });

    await writeFile(join(workloadsA, 'gemm-4096', 'evaluate.sh'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    await writeFile(join(workloadsA, 'gemm-4096', 'inputs', 'matrix.bin'), Buffer.from([1, 2, 3, 4, 5]), { mode: 0o600 });

    await writeFile(join(workloadsB, 'gemm-4096', 'inputs', 'matrix.bin'), Buffer.from([1, 2, 3, 4, 5]), { mode: 0o600 });
    await writeFile(join(workloadsB, 'gemm-4096', 'evaluate.sh'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });

    const digestA = await computeHeldOutWorkloadDigest(workloadsA, 'gemm-4096');
    const snapDir = join(root, 'snap-a');
    const snapped = await snapshotHeldOutWorkload(workloadsA, 'gemm-4096', snapDir);
    assert.equal(snapped.digest.hex, digestA.digest.hex);
    assert.equal(snapped.fileCount, 2);

    // Mutate live workloadsA AFTER snapshotting -> snapshot retains exact hashed bytes!
    await writeFile(join(workloadsA, 'gemm-4096', 'inputs', 'matrix.bin'), Buffer.from([9, 9, 9]), { mode: 0o600 });
    assert.deepEqual(
      await readFile(join(snapDir, 'inputs', 'matrix.bin')),
      Buffer.from([1, 2, 3, 4, 5]),
    );

    // Rejects symlink and hardlink inside held_out_workloads/<id>
    const secretOutside = join(root, 'outside-secret.txt');
    await writeFile(secretOutside, 'TOP_SECRET', 'utf8');
    await symlink(secretOutside, join(workloadsB, 'gemm-4096', 'inputs', 'escape.bin'));
    await assert.rejects(
      () => computeHeldOutWorkloadDigest(workloadsB, 'gemm-4096'),
      (err: unknown) => err instanceof HardwareRunnerError && err.code === 'ARTIFACT_INVALID',
    );
    await rm(join(workloadsB, 'gemm-4096', 'inputs', 'escape.bin'));

    await link(secretOutside, join(workloadsB, 'gemm-4096', 'inputs', 'hardlink.bin'));
    await assert.rejects(
      () => snapshotHeldOutWorkload(workloadsB, 'gemm-4096', join(root, 'snap-fail')),
      (err: unknown) => err instanceof HardwareRunnerError && err.code === 'ARTIFACT_INVALID',
    );
    await rm(join(workloadsB, 'gemm-4096', 'inputs', 'hardlink.bin'));

    const symlinkWorkloadsRoot = join(root, 'symlink-workloads');
    await symlink(workloadsA, symlinkWorkloadsRoot);
    await assert.rejects(
      () => computeHeldOutWorkloadDigest(symlinkWorkloadsRoot, 'gemm-4096'),
      (err: unknown) => err instanceof HardwareRunnerError && err.code === 'ARTIFACT_INVALID',
    );

    await assert.rejects(
      () => computeHeldOutWorkloadDigest(workloadsA, '../workloads-a'),
      (err: unknown) => err instanceof HardwareRunnerError && err.code === 'ARTIFACT_INVALID',
    );
  } finally {
    await chmod(join(root, 'snap-a', 'inputs'), 0o700).catch(() => {});
    await chmod(join(root, 'snap-a'), 0o700).catch(() => {});
    await rm(root, { recursive: true, force: true });
  }
});

test('collectHardwareProvenance never injects configured topology into physical probes so topology-constrained checks block honestly', async () => {
  const workloadDigest = { algorithm: 'sha256' as const, hex: 'a'.repeat(64) };

  const syntheticProv = await collectHardwareProvenance({
    probeMode: 'synthetic_fixture',
    targetCellId: 'cuda-sm90',
    targetHardware: {
      accelerator: 'sm_90a',
      isolationMode: 'whole_device',
      deviceCount: 1,
      driverConstraint: '>=550.54',
    },
    capabilities: {
      accelerator: 'sm_90a',
      isolationModes: ['whole_device', 'sliced'],
      deviceCount: 4,
      driverVersion: '550.90.07',
      topology: 'nvlink',
    },
    workloadDigest,
  });
  assert.equal(syntheticProv.probeKind, 'synthetic_fixture');
  assert.equal(
    matchesHardwareTarget(
      { accelerator: 'sm_90a', isolationMode: 'whole_device', deviceCount: 1, driverConstraint: '>=550.54' },
      'cuda-sm90',
      false,
      syntheticProv,
    ),
    false,
  );

  // Physical probe where config claims topology: 'nvlink-forged', while nvidia-smi does NOT observe topology!
  const mockRunner: ProbeCommandRunner = async (bin, args) => {
    if (bin.endsWith('nvidia-smi')) {
      if (args.includes('topo')) {
        return { exitCode: 1, stdout: '', stderr: 'topo unsupported' };
      }
      if (args.includes('-q')) {
        return { exitCode: 0, stdout: 'CUDA Version : 12.6\nClocks: Locked\n', stderr: '' };
      }
      return { exitCode: 0, stdout: 'NVIDIA H100 80GB HBM3, 9.0, 550.90.07, Disabled\n', stderr: '' };
    }
    if (bin.endsWith('rocm-smi')) {
      if (args.includes('--showtopo')) {
        return { exitCode: 0, stdout: 'GPU[0] - GPU[1] : XGMI\n', stderr: '' };
      }
      return {
        exitCode: 0,
        stdout: JSON.stringify({
          card0: { 'Card series': 'AMD Instinct MI300X', 'GFX Version': 'gfx942' },
          card1: { 'Card series': 'AMD Instinct MI300X', 'GFX Version': 'gfx942' },
          system: { 'Driver version': '6.8.5', 'ROCm version': '6.2.4' },
        }),
        stderr: '',
      };
    }
    if (bin.endsWith('npu-smi')) {
      if (args.includes('topo')) {
        return { exitCode: 1, stdout: '', stderr: '' };
      }
      return {
        exitCode: 0,
        stdout: 'Version: 24.1.0\nChip Name : Ascend 910B3\n',
        stderr: '',
      };
    }
    return { exitCode: 1, stdout: '', stderr: 'not found' };
  };

  const cudaPhysical = await collectHardwareProvenance({
    probeMode: 'physical',
    targetCellId: 'cuda-sm90',
    targetHardware: {
      accelerator: 'sm_90a',
      isolationMode: 'whole_device',
      deviceCount: 1,
      topology: 'nvlink-forged',
    },
    capabilities: {
      accelerator: 'sm_90a',
      isolationModes: ['whole_device'],
      deviceCount: 1,
      driverVersion: '550.90.07',
      topology: 'nvlink-forged',
    },
    workloadDigest,
    verifyExecutable: async binPath => binPath,
    commandRunner: mockRunner,
  });
  assert.equal(cudaPhysical.probeKind, 'physical');
  assert.equal(cudaPhysical.topology, undefined);
  // Topology-constrained check blocks honestly because probe did not observe topology!
  assert.equal(
    matchesHardwareTarget(
      { accelerator: 'sm_90a', isolationMode: 'whole_device', deviceCount: 1, topology: 'nvlink-forged' },
      'cuda-sm90',
      false,
      cudaPhysical,
    ),
    false,
  );

  // ROCm with measured 2-GPU --showtopo reports observed 'xgmi'
  const rocmPhysical = await collectHardwareProvenance({
    probeMode: 'physical',
    targetCellId: 'rocm-mi300x',
    targetHardware: { accelerator: 'gfx942', isolationMode: 'whole_device', deviceCount: 2, topology: 'xgmi' },
    capabilities: {
      accelerator: 'gfx942',
      isolationModes: ['whole_device'],
      deviceCount: 2,
      driverVersion: '6.8.5',
      topology: 'forged-other',
    },
    workloadDigest,
    verifyExecutable: async binPath => binPath,
    commandRunner: mockRunner,
  });
  assert.equal(rocmPhysical.topology, 'xgmi');

  // Ascend without CANN Version or topo reports runtimeVersion='cann-unknown' and topology=undefined
  const ascendPhysical = await collectHardwareProvenance({
    probeMode: 'physical',
    targetCellId: 'npu-910b',
    targetHardware: { accelerator: 'ascend_910b', isolationMode: 'whole_device', deviceCount: 1 },
    capabilities: {
      accelerator: 'ascend_910b',
      isolationModes: ['whole_device'],
      deviceCount: 1,
      driverVersion: '24.1.0',
      topology: 'hccs-forged',
    },
    workloadDigest,
    verifyExecutable: async binPath => binPath,
    commandRunner: mockRunner,
  });
  assert.equal(ascendPhysical.runtimeVersion, 'cann-unknown');
  assert.equal(ascendPhysical.topology, undefined);

  const verifierRefRes = digestArtifactFromMetadata('.loopwright-verifier/check.kernel-bench/gemm.cubin', {
    digest: workloadDigest,
    byteLength: 1024,
    uri: `cas://sha256/${workloadDigest.hex}`,
  });
  assert.equal(verifierRefRes.ok, true);
  if (!verifierRefRes.ok) return;

  const evidenceCheck = validateDocument(
    JSON.parse(
      JSON.stringify({
        apiVersion: 'loopwright.dev/v1alpha1',
        kind: 'Evidence',
        metadata: { id: 'ev-hw-1' },
        spec: {
          checkId: 'kernel-bench',
          observedStatus: 'passed',
          producerId: 'benchmark-gate',
          method: 'benchmark-gate',
          level: 'hardware_execution',
          subject: {
            lockHash: workloadDigest,
            contractHash: workloadDigest,
            repository: 'org/repo',
            baseRevision: '1'.repeat(40),
            sourceRevision: '1'.repeat(40),
            candidateDigest: workloadDigest,
            targetMatrixDigest: workloadDigest,
          },
          artifacts: [verifierRefRes.value],
          reason: null,
          hardwareProvenance: cudaPhysical,
        },
      }),
    ),
    'Evidence',
  );
  assert.equal(evidenceCheck.ok, true, JSON.stringify(evidenceCheck));
});

test('defaultProbeCommandRunner enforces shell=false, absolute paths, bounded timeout/abort, and probe negative bounds', async () => {
  const echoRes = await defaultProbeCommandRunner('/bin/echo', ['probe-ok', '$(uname)'], { timeoutMs: 5_000 });
  assert.equal(echoRes.exitCode, 0);
  assert.equal(echoRes.stdout.trim(), 'probe-ok $(uname)');

  const falseRes = await defaultProbeCommandRunner('/usr/bin/false', [], { timeoutMs: 5_000 });
  assert.equal(falseRes.exitCode !== 0, true);

  await assert.rejects(
    () => defaultProbeCommandRunner('nvidia-smi', [], { timeoutMs: 1_000 }),
    (err: unknown) => err instanceof HardwareRunnerError && err.code === 'RUNNER_SANDBOX_FAILED',
  );
  await assert.rejects(
    () => defaultProbeCommandRunner('/bin/echo', ['bad\narg'], { timeoutMs: 1_000 }),
    (err: unknown) => err instanceof HardwareRunnerError && err.code === 'RUNNER_SANDBOX_FAILED',
  );
  await assert.rejects(
    () => defaultProbeCommandRunner('/bin/sleep', ['10'], { timeoutMs: 80 }),
    (err: unknown) => err instanceof HardwareRunnerError && err.code === 'RUNNER_SANDBOX_FAILED',
  );

  const abortCtrl = new AbortController();
  setTimeout(() => abortCtrl.abort(), 40);
  await assert.rejects(
    () => defaultProbeCommandRunner('/bin/sleep', ['10'], { timeoutMs: 5_000, signal: abortCtrl.signal }),
    (err: unknown) => err instanceof HardwareRunnerError && err.code === 'RUNNER_SANDBOX_FAILED',
  );

  const ascend310p = parseNpuSmiOutput('Version: 24.1.0\nChip Name: Ascend 310P3\n');
  assert.equal(ascend310p.accelerator, 'ascend_310p');
  assert.throws(() => parseNpuSmiOutput('Chip Name: 910B3\n'), /missing driver version/);

  const rocmJsonSliced = parseRocmSmiOutput(
    JSON.stringify({
      card0: { 'Card series': 'AMD Instinct MI300X', 'GFX Version': 'gfx942', 'Compute Partition': 'CPX', 'Performance Level': 'auto' },
    }),
  );
  assert.equal(rocmJsonSliced.isolationMode, 'sliced');
  assert.equal(rocmJsonSliced.clockLockMode, 'unlocked');
  assert.equal(rocmJsonSliced.driverVersion, 'rocm-driver-unknown');
  assert.equal(rocmJsonSliced.runtimeVersion, 'rocm-unknown');

  assert.throws(
    () =>
      parseRocmSmiOutput(
        '',
        [
          '*******\nAgent 1\n*******\n  Device Type: GPU\n  Name: gfx942\n',
          '*******\nAgent 2\n*******\n  Device Type: GPU\n  Name: gfx1101\n',
        ].join('\n'),
      ),
    /heterogeneous ROCm GPU architectures/,
  );
  assert.throws(() => parseRocmSmiOutput('GPU[0] : Card Series: Unknown\n', ''), /unable to determine AMD GPU gfx/);
  assert.throws(() => parseNpuSmiOutput('   '), /empty npu-smi output/);
  assert.throws(
    () => parseNpuSmiOutput('Version: 24.1.0\nChip Name: Ascend 910B3\nChip Name: Ascend 310P3\n'),
    /heterogeneous Ascend NPU/,
  );

  const workloadDigest = { algorithm: 'sha256' as const, hex: 'b'.repeat(64) };
  await assert.rejects(
    () =>
      collectHardwareProvenance({
        probeMode: 'physical',
        targetCellId: 'tpu-cell',
        capabilities: {
          accelerator: 'tpu_v5p',
          isolationModes: ['whole_device'],
          deviceCount: 1,
          driverVersion: '1.0',
        },
        workloadDigest,
      }),
    /unsupported physical accelerator family/,
  );

  await assert.rejects(
    () =>
      collectHardwareProvenance({
        probeMode: 'physical',
        targetCellId: 'cuda-4gpu',
        targetHardware: { accelerator: 'sm_90a', isolationMode: 'whole_device', deviceCount: 4 },
        capabilities: {
          accelerator: 'sm_90a',
          isolationModes: ['whole_device'],
          deviceCount: 4,
          driverVersion: '550.90.07',
        },
        workloadDigest,
        verifyExecutable: async p => p,
        commandRunner: async () => ({
          exitCode: 0,
          stdout: 'NVIDIA H100, 9.0, 550.90.07, Disabled\n',
          stderr: '',
        }),
      }),
    /fewer than required 4/,
  );

  // Workload limits and non-zero probe exits fail closed
  const root = await mkdtemp(join(tmpdir(), 'lw-prov-limits-'));
  try {
    const wlRoot = join(root, 'workloads');
    await mkdir(join(wlRoot, 'w1', 'a', 'b'), { recursive: true, mode: 0o700 });
    await writeFile(join(wlRoot, 'w1', 'f1.bin'), Buffer.alloc(64, 1), { mode: 0o600 });
    await writeFile(join(wlRoot, 'w1', 'a', 'b', 'f2.bin'), Buffer.alloc(64, 2), { mode: 0o600 });
    await writeFile(join(wlRoot, 'not-a-dir'), 'file', { mode: 0o600 });

    await assert.rejects(
      () => computeHeldOutWorkloadDigest(wlRoot, 'missing-workload'),
      (err: unknown) => err instanceof HardwareRunnerError && err.code === 'CONFIG_INVALID',
    );
    await assert.rejects(
      () => computeHeldOutWorkloadDigest(wlRoot, 'not-a-dir'),
      (err: unknown) => err instanceof HardwareRunnerError && err.code === 'ARTIFACT_INVALID',
    );
    await assert.rejects(
      () => computeHeldOutWorkloadDigest(wlRoot, 'w1', { maxFiles: 1 }),
      (err: unknown) => err instanceof HardwareRunnerError && err.code === 'ARTIFACT_INVALID',
    );
    await assert.rejects(
      () => computeHeldOutWorkloadDigest(wlRoot, 'w1', { maxFileBytes: 16 }),
      (err: unknown) => err instanceof HardwareRunnerError && err.code === 'PAYLOAD_TOO_LARGE',
    );
    await assert.rejects(
      () => computeHeldOutWorkloadDigest(wlRoot, 'w1', { maxTotalBytes: 80 }),
      (err: unknown) => err instanceof HardwareRunnerError && err.code === 'PAYLOAD_TOO_LARGE',
    );
    await assert.rejects(
      () => computeHeldOutWorkloadDigest(wlRoot, 'w1', { maxDepth: 1 }),
      (err: unknown) => err instanceof HardwareRunnerError && err.code === 'ARTIFACT_INVALID',
    );
    const aborted = new AbortController();
    aborted.abort();
    await assert.rejects(
      () => computeHeldOutWorkloadDigest(wlRoot, 'w1', { signal: aborted.signal }),
      (err: unknown) => err instanceof HardwareRunnerError && err.code === 'RUNNER_SANDBOX_FAILED',
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }

  for (const accel of ['sm_90a', 'gfx942', 'ascend_910b']) {
    await assert.rejects(
      () =>
        collectHardwareProvenance({
          probeMode: 'physical',
          targetCellId: `cell-${accel}`,
          capabilities: {
            accelerator: accel,
            isolationModes: ['whole_device'],
            deviceCount: 1,
            driverVersion: '1.0.0',
          },
          workloadDigest,
          verifyExecutable: async p => p,
          commandRunner: async () => ({ exitCode: 127, stdout: '', stderr: 'driver error' }),
        }),
      (err: unknown) => err instanceof HardwareRunnerError && err.code === 'RUNNER_SANDBOX_FAILED',
    );
  }
});

test('ANSI stripping in ROCm output, Ascend HCCS/PCIe topology matrix, trusted executable symlink/missing guards, and snapshot rollback', async () => {
  const ansiRocm = parseRocmSmiOutput(
    '',
    '*******\nAgent 1\n*******\n  Device Type: GPU\n  Marketing Name: AMD Instinct MI300X\n  Name: gfx942\n' +
      '*******\nAgent 2\n*******\n  Device Type: GPU\n  Marketing Name: AMD Instinct MI300X\n  Name: gfx942\n',
    {
      topoOutput: '       GPU0   GPU1\nGPU0   \u001b[32mX\u001b[0m      \u001b[36mPCIE\u001b[0m\nGPU1   \u001b[36mPCIE\u001b[0m   \u001b[32mX\u001b[0m\n',
      allocatedDeviceCount: 2,
    },
  );
  assert.equal(ansiRocm.accelerator, 'gfx942');
  assert.equal(ansiRocm.deviceModel, 'AMD Instinct MI300X');
  assert.equal(ansiRocm.topology, 'pcie');
  assert.equal(ansiRocm.driverVersion, 'rocm-driver-unknown');
  assert.equal(ansiRocm.runtimeVersion, 'rocm-unknown');

  const textRocm = parseRocmSmiOutput(
    'GPU[0] : Card Series: AMD Instinct MI300X\n' +
      'GPU[0] : GFX Version: gfx942\n' +
      'GPU[0] : Driver version: 6.10.5\n' +
      'GPU[0] : ROCm version: 6.2.4\n' +
      'GPU[0] : Compute Partition: CPX\n' +
      'GPU[0] : Performance Level: manual\n',
    '',
  );
  assert.equal(textRocm.driverVersion, '6.10.5');
  assert.equal(textRocm.runtimeVersion, '6.2.4');
  assert.equal(textRocm.isolationMode, 'sliced');
  assert.equal(textRocm.clockLockMode, 'locked');

  const unlockedCuda = parseNvidiaSmiOutput(
    'NVIDIA A100-SXM4-80GB, sm_80, 550.54.15, Disabled\n',
    'CUDA Version: 12.4\nClocks: Unlocked\nNVLink: Active\n',
  );
  assert.equal(unlockedCuda.accelerator, 'sm_80');
  assert.equal(unlockedCuda.clockLockMode, 'unlocked');
  assert.equal(unlockedCuda.runtimeVersion, 'cuda-unknown');
  assert.equal(unlockedCuda.topology, undefined);
  assert.throws(() => parseNvidiaSmiOutput(''), /invalid number|empty/i);
  assert.throws(() => parseNvidiaSmiOutput('only-two, fields\n'), /malformed nvidia-smi CSV row/);
  assert.throws(() => parseNvidiaSmiOutput('GPU, bad_cap, 550.1, N/A\n'), /unable to parse CUDA compute capability/);
  assert.throws(() => parseRocmSmiOutput('', ''), /empty rocm-smi and rocminfo/);

  const hccsNpu = parseNpuSmiOutput(
    'Version: 24.1.rc2\nCANN Version: 8.0.RC2\n| 0 Ascend 910B4 |\n| 1 Ascend 910B4 |\nvNPU: Vir04\n',
    {
      preferredAccelerator: 'ascend_910b4',
      topoOutput: '      NPU0  NPU1\nNPU0  X     HCCS\nNPU1  HCCS  X\n',
      allocatedDeviceCount: 2,
    },
  );
  assert.equal(hccsNpu.accelerator, 'ascend_910b4');
  assert.equal(hccsNpu.runtimeVersion, 'cann-8.0.RC2');
  assert.equal(hccsNpu.isolationMode, 'sliced');
  assert.equal(hccsNpu.topology, 'hccs');

  const pcieNpu = parseNpuSmiOutput(
    'Version: 24.1.0\nChip Name: Ascend 920A\nChip Name: Ascend 920A\n',
    {
      topoOutput: '      NPU0  NPU1\nNPU0  X     PIX\nNPU1  PIX   X\n',
      allocatedDeviceCount: 2,
    },
  );
  assert.equal(pcieNpu.accelerator, 'ascend_920a');
  assert.equal(pcieNpu.topology, 'pcie');

  const root = await mkdtemp(join(tmpdir(), 'lw-prov-extra-'));
  try {
    const trustedDir = join(root, 'bin');
    await mkdir(trustedDir, { recursive: true, mode: 0o755 });
    const nonExec = join(trustedDir, 'non-exec');
    await writeFile(nonExec, '#!/bin/sh\n', { mode: 0o444 });
    await chmod(nonExec, 0o444);
    const validExec = join(trustedDir, 'valid-exec');
    await writeFile(validExec, '#!/bin/sh\n', { mode: 0o555 });
    await chmod(validExec, 0o555);
    const symExec = join(trustedDir, 'sym-exec');
    await symlink(validExec, symExec);
    await chmod(trustedDir, 0o555);

    // Relative / control-char executable rejected
    await assert.rejects(
      () => verifyTrustedProbeExecutable('relative/bin', ['relative/bin']),
      (err: unknown) => err instanceof HardwareRunnerError && err.code === 'RUNNER_SANDBOX_FAILED',
    );
    // Outside _testOnlyTrustedRoot rejected
    await assert.rejects(
      () => verifyTrustedProbeExecutable('/usr/bin/false', ['/usr/bin/false'], { _testOnlyTrustedRoot: trustedDir }),
      /outside _testOnlyTrustedRoot/,
    );
    // Missing binary rejected
    const missingBin = join(trustedDir, 'missing');
    await assert.rejects(
      () => verifyTrustedProbeExecutable(missingBin, [missingBin], { _testOnlyTrustedRoot: trustedDir }),
      /not installed/,
    );
    // Non-executable regular file rejected
    await assert.rejects(
      () => verifyTrustedProbeExecutable(nonExec, [nonExec], { _testOnlyTrustedRoot: trustedDir }),
      /not an executable regular file/,
    );
    // Symlink inside _testOnlyTrustedRoot rejected
    await assert.rejects(
      () => verifyTrustedProbeExecutable(symExec, [symExec], { _testOnlyTrustedRoot: trustedDir }),
      /must not traverse symlinks/,
    );

    // Snapshot rollback on hardlinked file inside workload
    await chmod(trustedDir, 0o700);
    const wlRoot = join(root, 'workloads');
    await mkdir(join(wlRoot, 'bad-wl'), { recursive: true, mode: 0o700 });
    const orig = join(wlRoot, 'bad-wl', 'a.bin');
    const hard = join(root, 'outside-link.bin');
    await writeFile(orig, 'secret-data', { mode: 0o600 });
    await link(orig, hard);

    const snapTarget = join(root, 'snap-out');
    await assert.rejects(
      () => snapshotHeldOutWorkload(wlRoot, 'bad-wl', snapTarget),
      (err: unknown) => err instanceof HardwareRunnerError && err.code === 'ARTIFACT_INVALID',
    );
    // Invalid workloadId rejected
    await assert.rejects(
      () => snapshotHeldOutWorkload(wlRoot, '../escape', snapTarget),
      (err: unknown) => err instanceof HardwareRunnerError && err.code === 'ARTIFACT_INVALID',
    );
  } finally {
    await chmod(join(root, 'bin'), 0o700).catch(() => {});
    await rm(root, { recursive: true, force: true });
  }
});

test('physical provenance binds strictly to allocated device IDs, defaults omitted deviceCount to 1, requires complete k*(k-1)/2 pair coverage, and never falls back to host-wide NVLink detail text', async () => {
  const workloadDigest = { algorithm: 'sha256' as const, hex: 'e'.repeat(64) };

  // 1. Multi-GPU CUDA host (GPU0=H100 whole_device, GPU1=H100 whole_device, GPU2=RTX4090 MIG/different arch):
  //    When targetHardware omits deviceCount, provenance MUST default to 1 device (GPU0), ignore GPU2's
  //    different arch & MIG state, ignore GPU0<->GPU1 NV18 link, and never fall back to host -q NVLink text!
  const multiGpuCsv = [
    'NVIDIA H100 80GB HBM3, 9.0, 550.90.07, Disabled',
    'NVIDIA H100 80GB HBM3, 9.0, 550.90.07, Disabled',
    'NVIDIA RTX 4090, 8.9, 550.90.07, Enabled',
  ].join('\n');
  const multiGpuTopo = [
    '        GPU0    GPU1    GPU2',
    'GPU0     X      NV18    SYS',
    'GPU1    NV18     X      SYS',
    'GPU2    SYS     SYS      X',
  ].join('\n');

  const singleDefaultCuda = await collectHardwareProvenance({
    probeMode: 'physical',
    targetCellId: 'cuda-default-1',
    targetHardware: { accelerator: 'sm_90a', isolationMode: 'whole_device' },
    capabilities: {
      accelerator: 'sm_90a',
      isolationModes: ['whole_device'],
      deviceCount: 3,
      driverVersion: '550.90.07',
    },
    workloadDigest,
    sandboxBackend: 'docker',
    verifyExecutable: async p => p,
    commandRunner: async (_bin, args) => {
      if (args.includes('topo')) return { exitCode: 0, stdout: multiGpuTopo, stderr: '' };
      if (args.includes('-q')) return { exitCode: 0, stdout: 'CUDA Version : 12.6\nNVLink : Active (NV18)\nClocks: Locked\n', stderr: '' };
      return { exitCode: 0, stdout: multiGpuCsv, stderr: '' };
    },
  });
  assert.equal(singleDefaultCuda.deviceCount, 1);
  assert.equal(singleDefaultCuda.accelerator, 'sm_90a');
  assert.equal(singleDefaultCuda.isolationMode, 'whole_device');
  assert.equal(singleDefaultCuda.runtimeVersion, 'cuda-unknown');
  assert.equal(singleDefaultCuda.topology, undefined);

  // 2. CUDA 2-GPU allocation with missing peer matrix MUST NOT fall back to host-wide NVLink detail text!
  const cuda2MissingMatrix = parseNvidiaSmiOutput(
    'NVIDIA H100 80GB HBM3, 9.0, 550.90.07, Disabled\nNVIDIA H100 80GB HBM3, 9.0, 550.90.07, Disabled\n',
    'NVLink: Active\nNV18 900 GB/s\nCUDA Version: 12.6\n',
    { preferredAccelerator: 'sm_90a', topoOutput: '', allocatedDeviceIndices: [0, 1] },
  );
  assert.equal(cuda2MissingMatrix.topology, undefined);
  assert.equal(cuda2MissingMatrix.runtimeVersion, 'cuda-unknown');

  // 3. Explicit non-contiguous allocatedDeviceIndices [0, 2] extracts ONLY the (GPU0, GPU2) link ('sys'), ignoring NV18 on GPU0-GPU1!
  const cudaNonContig = parseNvidiaSmiOutput(
    [
      'NVIDIA H100 80GB HBM3, 9.0, 550.90.07, Disabled',
      'NVIDIA H100 80GB HBM3, 9.0, 550.90.07, Disabled',
      'NVIDIA H100 80GB HBM3, 9.0, 550.90.07, Disabled',
    ].join('\n'),
    '',
    { preferredAccelerator: 'sm_90a', topoOutput: multiGpuTopo, allocatedDeviceIndices: [0, 2] },
  );
  assert.equal(cudaNonContig.deviceCount, 2);
  assert.equal(cudaNonContig.topology, 'sys');

  // 4. ROCm 3-GPU allocation requires ALL 3 unordered pairs (0:1, 0:2, 1:2); observing only 1 pair MUST leave topology undefined!
  const rocm3CardsJson = JSON.stringify({
    card0: { 'Card series': 'AMD Instinct MI300X', 'GFX Version': 'gfx942' },
    card1: { 'Card series': 'AMD Instinct MI300X', 'GFX Version': 'gfx942' },
    card2: { 'Card series': 'AMD Instinct MI300X', 'GFX Version': 'gfx942' },
    card3: { 'Card series': 'AMD Radeon Pro', 'GFX Version': 'gfx1100', 'Compute Partition': 'CPX' },
    system: { 'Driver version': '6.8.5', 'ROCm version': '6.2.4' },
  });
  const partialRocm3 = parseRocmSmiOutput(rocm3CardsJson, '', {
    topoOutput: 'GPU[0] - GPU[1] : XGMI\n',
    allocatedDeviceIndices: [0, 1, 2],
  });
  assert.equal(partialRocm3.deviceCount, 3);
  assert.equal(partialRocm3.accelerator, 'gfx942');
  assert.equal(partialRocm3.isolationMode, 'whole_device');
  assert.equal(partialRocm3.topology, undefined);

  const completeRocm3 = parseRocmSmiOutput(rocm3CardsJson, '', {
    topoOutput: [
      'GPU[0] - GPU[1] : XGMI',
      'GPU[0] - GPU[2] : XGMI',
      'GPU[1] - GPU[2] : XGMI',
      'GPU[2] - GPU[3] : PCIE',
    ].join('\n'),
    allocatedDeviceIndices: [0, 1, 2],
    ignoreHostRuntimeVersion: true,
  });
  assert.equal(completeRocm3.deviceCount, 3);
  assert.equal(completeRocm3.topology, 'xgmi');
  assert.equal(completeRocm3.runtimeVersion, 'rocm-unknown');
});

test('reordered topology column headers (GPU3 GPU2 GPU1 GPU0) map strictly by header identity and Ascend isolationMode scopes strictly to allocated NPU records', () => {
  // 1. 4-GPU nvidia-smi topo -m with reordered labeled columns (GPU3 GPU2 GPU1 GPU0):
  //    Devices 0 and 1 have SYS link, while unallocated pairs have NV18.
  const reorderedNvidiaTopo = [
    '        GPU3    GPU2    GPU1    GPU0    CPU Affinity    NUMA Affinity',
    'GPU0    NV18    NV18    SYS      X      0-23            0',
    'GPU1    NV18    NV18     X      SYS     24-47           0',
    'GPU2    SYS      X      NV18    NV18    48-71           1',
    'GPU3     X      SYS     NV18    NV18    72-95           1',
  ].join('\n');
  const fourGpuCsv = [
    'NVIDIA H100 80GB HBM3, 9.0, 550.90.07, Disabled',
    'NVIDIA H100 80GB HBM3, 9.0, 550.90.07, Disabled',
    'NVIDIA H100 80GB HBM3, 9.0, 550.90.07, Disabled',
    'NVIDIA H100 80GB HBM3, 9.0, 550.90.07, Disabled',
  ].join('\n');

  const reorderedCuda = parseNvidiaSmiOutput(fourGpuCsv, '', {
    preferredAccelerator: 'sm_90a',
    topoOutput: reorderedNvidiaTopo,
    allocatedDeviceIndices: [0, 1],
  });
  assert.equal(reorderedCuda.deviceCount, 2);
  assert.equal(reorderedCuda.topology, 'sys');

  // Reordered ROCm matrix (GPU3 GPU2 GPU1 GPU0) where (0, 1) is PCIE and others are XGMI
  const reorderedRocmTopo = [
    '        GPU3    GPU2    GPU1    GPU0',
    'GPU0    XGMI    XGMI    PCIE     X',
    'GPU1    XGMI    XGMI     X      PCIE',
    'GPU2    PCIE     X      XGMI    XGMI',
    'GPU3     X      PCIE    XGMI    XGMI',
  ].join('\n');
  const fourRocmJson = JSON.stringify({
    card0: { 'Card series': 'AMD Instinct MI300X', 'GFX Version': 'gfx942' },
    card1: { 'Card series': 'AMD Instinct MI300X', 'GFX Version': 'gfx942' },
    card2: { 'Card series': 'AMD Instinct MI300X', 'GFX Version': 'gfx942' },
    card3: { 'Card series': 'AMD Instinct MI300X', 'GFX Version': 'gfx942' },
    system: { 'Driver version': '6.8.5', 'ROCm version': '6.2.4' },
  });
  const reorderedRocm = parseRocmSmiOutput(fourRocmJson, '', {
    topoOutput: reorderedRocmTopo,
    allocatedDeviceIndices: [0, 1],
  });
  assert.equal(reorderedRocm.topology, 'pcie');

  // Headerless or duplicate-column matrix NEVER falls back to positional index
  const headerlessTopo = ['GPU0  X     NV18', 'GPU1  NV18  X'].join('\n');
  const headerlessCuda = parseNvidiaSmiOutput(fourGpuCsv, '', {
    topoOutput: headerlessTopo,
    allocatedDeviceIndices: [0, 1],
  });
  assert.equal(headerlessCuda.topology, undefined);

  const duplicateColTopo = ['      GPU0  GPU0', 'GPU0   X    NV18', 'GPU1  NV18   X'].join('\n');
  const dupColCuda = parseNvidiaSmiOutput(fourGpuCsv, '', {
    topoOutput: duplicateColTopo,
    allocatedDeviceIndices: [0, 1],
  });
  assert.equal(dupColCuda.topology, undefined);

  // 2. 2-NPU Ascend output where NPU 0 is whole_device and ONLY NPU 1 has a vNPU marker:
  //    Allocating [0] MUST report isolationMode === 'whole_device' (never 'sliced' from unallocated NPU 1)!
  const twoNpuTable = [
    '+------------------------------------------------------------------------------------------------+',
    '| npu-smi 24.1.0                   Version: 24.1.0                                               |',
    '| CANN Version: 8.0.RC3                                                                          |',
    '+---------------------------+---------------+----------------------------------------------------+',
    '| 0     910B3               | OK            | 92.4        38                0    / 0             |',
    '| 0     0                   | 0000:C1:00.0  | 0           1024 / 65536                           |',
    '+---------------------------+---------------+----------------------------------------------------+',
    '| 1     910B3               | OK            | 90.1        37                0    / 0             |',
    '| 1     0     Vir04         | 0000:81:00.0  | 0           512  / 16384      vNPU                 |',
    '+===========================+===============+====================================================+',
  ].join('\n');

  const npu0Whole = parseNpuSmiOutput(twoNpuTable, { allocatedDeviceIndices: [0] });
  assert.equal(npu0Whole.deviceCount, 1);
  assert.equal(npu0Whole.isolationMode, 'whole_device');

  const npu1Sliced = parseNpuSmiOutput(twoNpuTable, { allocatedDeviceIndices: [1] });
  assert.equal(npu1Sliced.deviceCount, 1);
  assert.equal(npu1Sliced.isolationMode, 'sliced');

  const twoNpuKv = [
    'Driver Version : 24.1.0',
    'NPU ID : 0',
    'Chip Name : Ascend 910B3',
    'NPU ID : 1',
    'Chip Name : Ascend 910B3',
    'vNPU : Vir04',
  ].join('\n');
  assert.equal(parseNpuSmiOutput(twoNpuKv, { allocatedDeviceIndices: [0] }).isolationMode, 'whole_device');
  assert.equal(parseNpuSmiOutput(twoNpuKv, { allocatedDeviceIndices: [1] }).isolationMode, 'sliced');
});
