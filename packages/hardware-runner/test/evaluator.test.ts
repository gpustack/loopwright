import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer as createNetServer } from 'node:net';
import { chmod, link, lstat, mkdir, mkdtemp, readdir, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SecretScrubber } from '@loopwright/core';
import { TRUSTED_DOCKER_PATHS } from '@loopwright/taskpack';
import {
  buildDockerStageBSeccompProfileJson,
  buildStrictLinuxBwrapArgs,
  collectHardwareProvenance,
  compileDockerSandboxCommand,
  compileStrictSocketDenySeccompBpf,
  createTwoStageEvaluator,
  decodeLwtree01Bundle,
  encodeLwtree01Bundle,
  evaluateBenchmarkJob,
  HardwareRunnerError,
  isRunnerTeardownError,
  parseStageBResultEnvelope,
  prepareStageSandboxInvocation,
  reconstructCandidateWorkspace,
  removeTreeFailClosed,
  resolveTrustedDockerExecutable,
  RunnerTeardownError,
  runSanitizedDockerRmForce,
  sealStageAOutputs,
  waitForProcessGroupExit,
  type LeaseGrant,
  type WorkerConfig,
} from '../src/index.js';

function sha256Hex(data: Uint8Array | string): string {
  return createHash('sha256').update(data).digest('hex');
}

function makeWorkerConfig(workDir: string, heldOutWorkloadsDir: string, overrides: Partial<WorkerConfig> = {}): WorkerConfig {
  return {
    workerId: 'worker-eval-test',
    relayUrl: 'http://127.0.0.1:19999',
    workerToken: 'WORKER_SUPER_SECRET_TOKEN_9988776655',
    workDir,
    heldOutWorkloadsDir,
    sandboxBackend: 'native_os',
    capabilities: {
      accelerator: 'sm_90a',
      isolationModes: ['whole_device'],
      deviceCount: 2,
      driverVersion: '550.90.07',
    },
    pollWaitMs: 100,
    heartbeatIntervalMs: 1_000,
    requestTimeoutMs: 5_000,
    stageATimeoutMs: 15_000,
    stageBTimeoutMs: 15_000,
    toolchainPaths: [],
    probeMode: 'synthetic_fixture',
    ...overrides,
  };
}

function makeLeaseGrant(overrides: Partial<LeaseGrant['job']> = {}): LeaseGrant {
  const digest = { algorithm: 'sha256' as const, hex: 'a'.repeat(64) };
  return {
    relayBootId: 'boot-eval-01',
    jobId: 'job-eval-01',
    operationId: 'verify.0.check.kernel-bench',
    leaseEpoch: 1,
    leaseToken: 'LEASE_SUPER_SECRET_TOKEN_1122334455',
    leaseTtlMs: 30_000,
    job: {
      operationId: 'verify.0.check.kernel-bench',
      gateId: 'sm90-gate',
      checkId: 'kernel-bench',
      candidateDigest: 'b'.repeat(64),
      subject: {
        lockHash: digest,
        contractHash: digest,
        repository: 'org/kernels',
        baseRevision: '1'.repeat(40),
        sourceRevision: '1'.repeat(40),
        candidateDigest: { algorithm: 'sha256', hex: 'b'.repeat(64) },
        targetMatrixDigest: digest,
      },
      targetCellId: 'cuda-sm90',
      targetHardware: {
        accelerator: 'sm_90a',
        isolationMode: 'whole_device',
        deviceCount: 1,
      },
      heldOutWorkloadId: 'gemm-4096',
      metricThresholds: [
        { kind: 'bounds', metric: 'max_abs_err', max: 1e-3 },
        { kind: 'comparative', metric: 'tflops', baselineMetric: 'baseline_tflops', operator: 'min_ratio', threshold: 1.2 },
      ],
      maxPreemptions: 3,
      preemptionCount: 0,
      candidateArtifacts: {
        entries: [],
        deleted: [],
      },
      ...overrides,
    },
  };
}

test('streaming LWTREE01 baseTreeBundle reconstruction (>1 MiB multi-chunk), digest check before decode, and temp file cleanup', async () => {
  const root = await mkdtemp(join(tmpdir(), 'lw-eval-recon-'));
  try {
    const bigBaseBlob = Buffer.alloc(1_150_000, 0x42);
    const baseBundle = encodeLwtree01Bundle([
      { name: 'README.md', mode: '100644', bytes: Buffer.from('# Base Kernel Repo\n', 'utf8') },
      { name: 'data/weights.bin', mode: '100644', bytes: bigBaseBlob },
      { name: 'legacy/remove-me.cu', mode: '100644', bytes: Buffer.from('// obsolete\n', 'utf8') },
      { name: 'scripts/build.sh', mode: '100644', bytes: Buffer.from('#!/bin/sh\necho old\n', 'utf8') },
    ]);
    const decoded = decodeLwtree01Bundle(baseBundle);
    assert.equal(decoded.length, 4);

    const newBuildScript = Buffer.from('#!/bin/sh\necho new-sm90\n', 'utf8');
    const kernelSource = Buffer.from('__global__ void gemm() {}\n', 'utf8');
    const blobs = new Map<string, Buffer>([
      [sha256Hex(baseBundle), baseBundle],
      [sha256Hex(newBuildScript), newBuildScript],
      [sha256Hex(kernelSource), kernelSource],
    ]);

    const candidateDir = join(root, 'candidate');
    await reconstructCandidateWorkspace({
      candidateDir,
      candidateArtifacts: {
        baseTree: { objectFormat: 'sha1', commitOid: '1'.repeat(40), treeOid: '2'.repeat(40) },
        baseTreeBundle: {
          digest: { algorithm: 'sha256', hex: sha256Hex(baseBundle) },
          byteLength: baseBundle.byteLength,
        },
        entries: [
          {
            name: 'scripts/build.sh',
            digest: { algorithm: 'sha256', hex: sha256Hex(newBuildScript) },
            byteLength: newBuildScript.byteLength,
            mode: '100755',
          },
          {
            name: 'src/gemm.cu',
            digest: { algorithm: 'sha256', hex: sha256Hex(kernelSource) },
            byteLength: kernelSource.byteLength,
          },
        ],
        deleted: ['legacy/remove-me.cu'],
      },
      downloadInputBlob: async (sha, _len, onChunk) => {
        const bytes = blobs.get(sha);
        assert.ok(bytes, `missing blob ${sha}`);
        // Stream in uneven 300 KiB chunks to exercise incremental file streaming without full-buffer concat
        for (let off = 0; off < bytes.byteLength; off += 307_200) {
          await onChunk(bytes.subarray(off, Math.min(bytes.byteLength, off + 307_200)));
        }
      },
    });

    // Verify temporary .lwtree-bundle-*.tmp file was unlinked before returning
    const topEntries = await readdir(candidateDir);
    assert.equal(topEntries.some(n => n.startsWith('.lwtree-bundle-')), false);

    const buildStat = await lstat(join(candidateDir, 'scripts', 'build.sh'));
    assert.equal(buildStat.mode & 0o777, 0o755);
    assert.equal((await lstat(join(candidateDir, 'data', 'weights.bin'))).size, 1_150_000);
    await assert.rejects(() => lstat(join(candidateDir, 'legacy', 'remove-me.cu')), { code: 'ENOENT' });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('two-stage OS read-allowlist + kernel socket denial + immutable workload snapshot: blocks unrelated worker credentials, sibling workloads, and Unix/IP sockets in BOTH stages', async () => {
  const root = await mkdtemp(join(tmpdir(), 'lw-eval-2stage-'));
  const outsideCredDir = await mkdtemp(join(tmpdir(), 'lw-eval-unlisted-cred-'));
  const workDir = join(root, 'work');
  const workloadsDir = join(root, 'held_out_workloads');
  const workloadPath = join(workloadsDir, 'gemm-4096');
  const siblingWorkloadPath = join(workloadsDir, 'other-secret-workload');
  await mkdir(workDir, { recursive: true, mode: 0o700 });
  await mkdir(workloadPath, { recursive: true, mode: 0o700 });
  await mkdir(siblingWorkloadPath, { recursive: true, mode: 0o700 });

  // 1. Unrelated worker-readable credential file OUTSIDE enumerated deniedReadPaths!
  const unrelatedCredFile = join(outsideCredDir, 'worker-cloud-token.txt');
  await writeFile(unrelatedCredFile, 'UNLISTED_WORKER_CLOUD_CREDENTIAL_998811', { mode: 0o600 });

  // 2. Sibling held-out workload file that Stage B must NEVER be able to read!
  const siblingSecretFile = join(siblingWorkloadPath, 'secret.txt');
  await writeFile(siblingSecretFile, 'SIBLING_WORKLOAD_SECRET_445566', { mode: 0o644 });

  // 3. Active held-out workload file (snapshotted before Stage A; live mutation during Stage A must NOT affect Stage B!)
  const privateSentinel = 'PRIVATE_HELDOUT_MATRIX_SENTINEL_DO_NOT_LEAK_774411';
  const sentinelFile = join(workloadPath, 'reference_weights.txt');
  await writeFile(sentinelFile, privateSentinel, { mode: 0o644 });

  // 4. Live host Unix domain socket to verify kernel socket denial
  const unixSockPath = join(outsideCredDir, 'host.sock');
  const unixSrv = createNetServer(sock => sock.end('PWNED'));
  await new Promise<void>(r => unixSrv.listen(unixSockPath, () => r()));

  const buildStrictSocketAndForkDenySnippet = (failBaseCode: number): string =>
    [
      'const cp = require("node:child_process"), dgram = require("node:dgram"), net = require("node:net");',
      `const base = ${failBaseCode};`,
      'const isPerm = (e) => Boolean(e && (e.code === "EPERM" || e.code === "EACCES"));',
      'if (process.platform === "darwin") {',
      '  const forkRes = cp.spawnSync("/bin/echo", ["hi"]);',
      '  if (!forkRes.error || forkRes.error.code !== "EPERM") {',
      '    console.error("macOS Seatbelt expected EPERM on fork, got:", forkRes.error, forkRes.status);',
      '    process.exit(base + 6);',
      '  }',
      '}',
      'async function assertAllSocketsBlocked() {',
      '  const udpErr = await new Promise((resolve) => {',
      '    let sock;',
      '    try { sock = dgram.createSocket("udp4"); } catch (e) { resolve(e); return; }',
      '    let done = false;',
      '    const fin = (e) => { if (!done) { done = true; try { sock.close(); } catch {} resolve(e); } };',
      '    sock.on("error", fin);',
      '    try { sock.send("x", 9, "127.0.0.1", (e) => fin(e || new Error("UDP_SEND_ALLOWED"))); } catch (e) { fin(e); }',
      '  });',
      '  if (!isPerm(udpErr)) { console.error("UDP expected EPERM/EACCES, got:", udpErr); process.exit(base + 1); }',
      '  const tcpErr = await new Promise((resolve) => {',
      '    let sock;',
      '    try { sock = net.connect({ host: "127.0.0.1", port: 9 }); } catch (e) { resolve(e); return; }',
      '    sock.on("connect", () => { sock.destroy(); resolve(new Error("TCP_CONNECT_ALLOWED")); });',
      '    sock.on("error", (e) => resolve(e));',
      '  });',
      '  if (!isPerm(tcpErr)) { console.error("TCP expected EPERM/EACCES, got:", tcpErr); process.exit(base + 2); }',
      '  const localSockPath = path.join(process.env.TMPDIR, "sandbox-socket-probe.sock");',
      '  const unixListenErr = await new Promise((resolve) => {',
      '    const srv = net.createServer();',
      '    srv.on("error", (e) => resolve(e));',
      '    try { srv.listen(localSockPath, () => { srv.close(); resolve(new Error("UNIX_LISTEN_ALLOWED")); }); } catch (e) { resolve(e); }',
      '  });',
      '  if (!isPerm(unixListenErr)) { console.error("UNIX listen expected EPERM/EACCES, got:", unixListenErr); process.exit(base + 3); }',
      `  const unixConnErr = await new Promise((resolve) => {`,
      `    let u;`,
      `    try { u = net.connect(${JSON.stringify(unixSockPath)}); } catch (e) { resolve(e); return; }`,
      `    u.on("connect", () => { u.destroy(); resolve(new Error("UNIX_CONNECT_ALLOWED")); });`,
      `    u.on("error", (e) => resolve(e));`,
      `  });`,
      '  if (!isPerm(unixConnErr)) { console.error("UNIX connect expected EPERM/EACCES, got:", unixConnErr); process.exit(base + 4); }',
      '}',
    ].join('\n');

  const stageBScript = [
    `#!${process.execPath}`,
    'const fs = require("node:fs"), path = require("node:path");',
    buildStrictSocketAndForkDenySnippet(20),
    'if (process.env.WORKER_TOKEN) process.exit(2);',
    'const cubin = fs.readFileSync(path.join(process.env.LOOPWRIGHT_STAGE_A_OUT, "gemm.cubin"), "utf8");',
    'if (!cubin.includes("COMPILED_CUBIN_SM90A")) process.exit(3);',
    // Stage B MUST read the original immutable snapshot even though Stage A mutated the live sentinelFile on host!
    'const snapWeights = fs.readFileSync(path.join(process.env.LOOPWRIGHT_HELD_OUT_WORKLOAD_DIR, "reference_weights.txt"), "utf8");',
    `if (!snapWeights.includes(${JSON.stringify(privateSentinel)})) process.exit(6);`,
    // Stage B MUST NOT read unrelated worker credential file, sibling workload, or live heldOutWorkloadsDir!
    `for (const [forbiddenPath, code] of [[${JSON.stringify(unrelatedCredFile)}, 11], [${JSON.stringify(siblingSecretFile)}, 12], [${JSON.stringify(sentinelFile)}, 13]]) {`,
    '  let leaked = false;',
    '  try { fs.readFileSync(forbiddenPath); leaked = true; } catch {}',
    '  if (leaked) process.exit(code);',
    '}',
    // Stage B MUST NOT mutate workload snapshot or sealed stage-a-out!
    'let mutatedSnap = false; try { fs.appendFileSync(path.join(process.env.LOOPWRIGHT_HELD_OUT_WORKLOAD_DIR, "reference_weights.txt"), "tamper"); mutatedSnap = true; } catch {}',
    'if (mutatedSnap) process.exit(4);',
    'let mutatedOut = false; try { fs.appendFileSync(path.join(process.env.LOOPWRIGHT_STAGE_A_OUT, "gemm.cubin"), "tamper"); mutatedOut = true; } catch {}',
    'if (mutatedOut) process.exit(5);',
    // Stage B MUST deterministically fail process-fork (macOS) and UDP, TCP, Unix listen in writable TMPDIR, and Unix connect with EPERM/EACCES!
    '(async () => {',
    '  await assertAllSocketsBlocked();',
    '  fs.writeFileSync(path.join(process.env.TMPDIR, "stage-b-leak-attempt.bin"), "STAGE_B_SCRATCH_DECOY");',
    '  process.stdout.write(\'LOOPWRIGHT_STAGE_B_RESULT:{"status":"approved","detail":"blind check passed","metrics":{"max_abs_err":0.0001,"tflops":312.5,"baseline_tflops":200.0}}\\n\');',
    '})().catch((err) => { console.error(err); process.exit(25); });',
  ].join('\n');
  await writeFile(join(workloadPath, 'evaluate.sh'), stageBScript, { mode: 0o755 });

  // Candidate Stage A build script attempts to fork, read active workload, sibling workload, AND unrelated worker cred, AND open sockets!
  const candidateBuildScript = [
    `#!${process.execPath}`,
    'const fs = require("node:fs"), path = require("node:path");',
    buildStrictSocketAndForkDenySnippet(94),
    `for (const [forbiddenPath, code] of [[${JSON.stringify(sentinelFile)}, 91], [${JSON.stringify(siblingSecretFile)}, 92], [${JSON.stringify(unrelatedCredFile)}, 93]]) {`,
    '  let leaked = false;',
    '  try { fs.readFileSync(forbiddenPath); leaked = true; } catch {}',
    '  if (leaked) process.exit(code);',
    '}',
    '(async () => {',
    '  await assertAllSocketsBlocked();',
    '  fs.writeFileSync(path.join(process.env.LOOPWRIGHT_STAGE_A_OUT, "gemm.cubin"), "ELF_COMPILED_CUBIN_SM90A\\n");',
    '  fs.writeFileSync(path.join(process.env.LOOPWRIGHT_STAGE_A_OUT, "gemm.sass"), "/* SASS sm_90a */\\n");',
    '})().catch((err) => { console.error(err); process.exit(99); });',
  ].join('\n');
  const scriptBuf = Buffer.from(candidateBuildScript, 'utf8');
  const scriptSha = sha256Hex(scriptBuf);

  const config = makeWorkerConfig(workDir, workloadsDir, {
    toolchainPaths: [join(process.execPath, '..')],
  });
  const grant = makeLeaseGrant({
    candidateArtifacts: {
      entries: [
        {
          name: 'scripts/build.sh',
          digest: { algorithm: 'sha256', hex: scriptSha },
          byteLength: scriptBuf.byteLength,
          mode: '100755',
        },
      ],
      deleted: [],
    },
  });

  try {
    const result = await evaluateBenchmarkJob({
      config,
      grant,
      downloadInputBlob: async (sha, _len, onChunk) => {
        assert.equal(sha, scriptSha);
        await onChunk(scriptBuf);
        // Simulate operator refreshing live workload on disk AFTER snapshot was taken, BEFORE Stage B starts!
        await writeFile(sentinelFile, 'MUTATED_DURING_STAGE_A_COMPILATION_0000', { mode: 0o644 });
      },
    });
    try {
      assert.equal(result.status, 'approved', `unexpected denial: ${result.reason} - ${result.detail}`);
      assert.equal(result.reason, null);
      assert.equal(result.metrics?.tflops, 312.5);
      assert.deepEqual(
        result.sealedOutputs.map(s => s.artifact.name),
        ['gemm.cubin', 'gemm.sass'],
      );
    } finally {
      await result.cleanup();
    }
  } finally {
    unixSrv.close();
    await rm(outsideCredDir, { recursive: true, force: true });
    await rm(root, { recursive: true, force: true });
  }
});

test('Stage B sanitization: numeric-only metrics, post-JSON-decode SecretScrubber scan, and supervisor-owned failure diagnostics (zero stderr leak)', async () => {
  const root = await mkdtemp(join(tmpdir(), 'lw-eval-scrub-'));
  try {
    const scrubber = new SecretScrubber();
    const workerSecret = 'WORKER_SECRET_CANARY_TOKEN_abc123XYZ789';
    scrubber.register(workerSecret);

    // 1. Binary Stage A output containing embedded secret is rejected without mutating bytes
    const outDir = join(root, 'stage-a-out');
    await mkdir(outDir, { mode: 0o700 });
    const binaryPayload = Buffer.concat([
      Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0xff, 0x00, 0xfe]),
      Buffer.from(workerSecret, 'utf8'),
      Buffer.from([0x00, 0xca, 0xfe, 0xba, 0xbe]),
    ]);
    const cubinPath = join(outDir, 'contaminated.cubin');
    await writeFile(cubinPath, binaryPayload, { mode: 0o600 });
    await assert.rejects(
      () => sealStageAOutputs({ stageAOutDir: outDir, scrubber, secretOverlapBytes: 16_384 }),
      (err: unknown) => err instanceof HardwareRunnerError && err.code === 'ARTIFACT_INVALID',
    );
    assert.equal((await readFile(cubinPath)).equals(binaryPayload), true);

    // 2. Stage B metrics MUST reject strings, booleans, null, and -0
    for (const badMetric of ['"fp16"', 'true', 'false', 'null', '-0']) {
      assert.throws(
        () => parseStageBResultEnvelope(`{"status":"approved","metrics":{"m":${badMetric}}}`, scrubber),
        (err: unknown) => err instanceof HardwareRunnerError && err.code === 'ARTIFACT_INVALID',
      );
    }

    // 3. Post-JSON-decode secret scan catches \uXXXX escaped secrets in detail, reason, metric key, and findings!
    const escapedSecret = `\\u0057${workerSecret.slice(1)}`;
    assert.equal(escapedSecret.includes(workerSecret), false);
    assert.throws(
      () => parseStageBResultEnvelope(`{"status":"denied","detail":"${escapedSecret}"}`, scrubber),
      /SecretScrubber/,
    );
    assert.throws(
      () => parseStageBResultEnvelope(`{"status":"denied","reason":"${escapedSecret}"}`, scrubber),
      /SecretScrubber/,
    );
    assert.throws(
      () =>
        parseStageBResultEnvelope(
          `{"status":"denied","findings":[{"title":"leak","severity":"high","evidence":"${escapedSecret}"}]}`,
          scrubber,
        ),
      /SecretScrubber/,
    );
    assert.throws(
      () => parseStageBResultEnvelope(`{"status":"approved","metrics":{"${escapedSecret}":1}}`, scrubber),
      /SecretScrubber/,
    );

    // 4. Non-zero Stage B exit with private held-out workload bytes on stderr NEVER leaks stderr in detail or findings!
    const workDir = join(root, 'work');
    const workloadsDir = join(root, 'workloads');
    await mkdir(workDir, { recursive: true, mode: 0o700 });
    await mkdir(join(workloadsDir, 'gemm-4096'), { recursive: true, mode: 0o700 });
    await writeFile(
      join(workloadsDir, 'gemm-4096', 'evaluate.sh'),
      '#!/bin/sh\necho "PRIVATE_WORKLOAD_GOLDEN_VECTOR_992288" >&2\nexit 42\n',
      { mode: 0o755 },
    );
    const okBuild = Buffer.from('#!/bin/sh\nprintf "cubin" > "$LOOPWRIGHT_STAGE_A_OUT/out.cubin"\n', 'utf8');
    const okSha = sha256Hex(okBuild);

    const crashRes = await evaluateBenchmarkJob({
      config: makeWorkerConfig(workDir, workloadsDir),
      grant: makeLeaseGrant({
        candidateArtifacts: {
          entries: [{ name: 'build.sh', digest: { algorithm: 'sha256', hex: okSha }, byteLength: okBuild.byteLength, mode: '100755' }],
          deleted: [],
        },
      }),
      downloadInputBlob: async (_sha, _len, onChunk) => onChunk(okBuild),
    });
    assert.equal(crashRes.status, 'denied');
    assert.equal(crashRes.reason, 'STAGE_B_EXECUTION_FAILED');
    assert.equal(crashRes.detail, 'Stage B exited with code 42');
    assert.equal(JSON.stringify(crashRes).includes('PRIVATE_WORKLOAD_GOLDEN_VECTOR_992288'), false);
    await crashRes.cleanup();

    // 5. Non-zero Stage B exit that ALSO prints a syntactically valid denied JSON envelope on stdout
    //    MUST NOT parse or forward reason, detail, or findings (prevents workload exfiltration)!
    const leakToken = 'PRIVATE_HELDOUT_WORKLOAD_STDOUT_ENVELOPE_SECRET_554433';
    await writeFile(
      join(workloadsDir, 'gemm-4096', 'evaluate.sh'),
      [
        '#!/bin/sh',
        `printf 'LOOPWRIGHT_STAGE_B_RESULT:{"status":"denied","reason":"${leakToken}_REASON","detail":"${leakToken}_DETAIL","findings":[{"title":"${leakToken}_TITLE","severity":"high","evidence":"${leakToken}_EVIDENCE"}]}\\n'`,
        'exit 1',
      ].join('\n'),
      { mode: 0o755 },
    );
    const nonZeroEnvelopeRes = await evaluateBenchmarkJob({
      config: makeWorkerConfig(workDir, workloadsDir),
      grant: makeLeaseGrant({
        candidateArtifacts: {
          entries: [{ name: 'build.sh', digest: { algorithm: 'sha256', hex: okSha }, byteLength: okBuild.byteLength, mode: '100755' }],
          deleted: [],
        },
      }),
      downloadInputBlob: async (_sha, _len, onChunk) => onChunk(okBuild),
    });
    assert.equal(nonZeroEnvelopeRes.status, 'denied');
    assert.equal(nonZeroEnvelopeRes.reason, 'STAGE_B_EXECUTION_FAILED');
    assert.equal(nonZeroEnvelopeRes.detail, 'Stage B exited with code 1');
    assert.equal(JSON.stringify(nonZeroEnvelopeRes).includes(leakToken), false);
    await nonZeroEnvelopeRes.cleanup();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('compileDockerSandboxCommand enforces --user uid:gid, disjoint socket-free mounts, ROCm renderD pinning, Stage B seccomp, and trusted docker ownership', async () => {
  const root = await mkdtemp(join(tmpdir(), 'lw-eval-docker-'));
  await chmod(root, 0o700);
  try {
    const host = {
      platform: 'linux' as const,
      arch: 'x64' as const,
      dockerExecutable: '/usr/bin/docker',
      probeExecutables: false,
    };
    const expectedUser = `${process.getuid?.() ?? 0}:${process.getgid?.() ?? 0}`;
    const seccompPath = join(root, 'stage-b-seccomp.json');
    await writeFile(seccompPath, buildDockerStageBSeccompProfileJson(), { mode: 0o400 });

    // 1. Stage B seccomp profile blocks socket & socketpair with EPERM
    const parsedSeccomp = JSON.parse(buildDockerStageBSeccompProfileJson()) as {
      defaultAction: string;
      syscalls: { names: string[]; action: string; errnoRet: number }[];
    };
    assert.equal(parsedSeccomp.defaultAction, 'SCMP_ACT_ALLOW');
    assert.equal(parsedSeccomp.syscalls[0]?.action, 'SCMP_ACT_ERRNO');
    assert.equal(parsedSeccomp.syscalls[0]?.errnoRet, 1);
    assert.equal(parsedSeccomp.syscalls[0]?.names.includes('socket'), true);
    assert.equal(parsedSeccomp.syscalls[0]?.names.includes('socketpair'), true);

    // 2. CUDA Stage A emits --user <uid>:<gid>, --gpus "device=0,1", --network none, --read-only, AND --security-opt seccomp=<profile>
    const cudaStageA = compileDockerSandboxCommand({
      stage: 'A',
      dockerImage: 'nvidia/cuda:12.6.0-devel-ubuntu24.04',
      containerName: 'lw-cuda-a',
      targetHardware: { accelerator: 'sm_90a', isolationMode: 'whole_device', deviceCount: 2 },
      candidateDir: '/var/lib/lw/job1/candidate',
      stageAOutDir: '/var/lib/lw/job1/stage-a-out',
      toolchainPaths: ['/usr/local/cuda'],
      forbiddenHostPaths: ['/var/lib/lw/held_out_workloads', '/etc/lw/ca.pem'],
      seccompProfilePath: seccompPath,
      command: '/workspace/candidate/build.sh',
      host,
    });
    const userIdx = cudaStageA.args.indexOf('--user');
    assert.equal(cudaStageA.args[userIdx + 1], expectedUser);
    const gpusIdx = cudaStageA.args.indexOf('--gpus');
    assert.equal(cudaStageA.args[gpusIdx + 1], '"device=0,1"');
    assert.equal(cudaStageA.args.includes('--init'), true);
    assert.equal(cudaStageA.args.includes('--read-only'), true);
    assert.equal(cudaStageA.args.includes(`seccomp=${seccompPath}`), true);

    // Omitting seccompProfilePath on Stage A MUST ALSO fail closed!
    assert.throws(
      () =>
        compileDockerSandboxCommand({
          stage: 'A',
          dockerImage: 'nvidia/cuda:12.6.0-devel-ubuntu24.04',
          containerName: 'lw-cuda-a-no-seccomp',
          targetHardware: { accelerator: 'sm_90a', isolationMode: 'whole_device', deviceCount: 1 },
          candidateDir: '/var/lib/lw/job1/candidate',
          stageAOutDir: '/var/lib/lw/job1/stage-a-out',
          command: '/workspace/candidate/build.sh',
          host,
        }),
      /Stage A docker sandbox requires an explicit socket-denial seccompProfilePath/,
    );

    // 3. ROCm Stage B pins ONLY /dev/kfd + allocated /dev/dri/renderD128 (NEVER /dev/dri!) + Stage B seccomp
    const rocmStageB = compileDockerSandboxCommand({
      stage: 'B',
      dockerImage: 'rocm/dev-ubuntu-24.04:6.2.4',
      containerName: 'lw-rocm-b',
      targetHardware: { accelerator: 'gfx1101', isolationMode: 'whole_device', deviceCount: 1 },
      stageAOutDir: '/var/lib/lw/job1/stage-a-out',
      workloadDir: '/var/lib/lw/job1/workload-snap',
      allocatedDeviceNodes: ['/dev/dri/renderD128'],
      seccompProfilePath: seccompPath,
      command: '/workspace/workload/evaluate.sh',
      host,
    });
    assert.equal(rocmStageB.args.includes('/dev/kfd'), true);
    assert.equal(rocmStageB.args.includes('/dev/dri/renderD128'), true);
    assert.equal(rocmStageB.args.includes('/dev/dri'), false);
    assert.equal(rocmStageB.args.includes(`seccomp=${seccompPath}`), true);

    // Rejects passing /dev/dri whole directory in allocatedDeviceNodes or omitting Stage B seccompProfilePath
    assert.throws(
      () =>
        compileDockerSandboxCommand({
          stage: 'B',
          dockerImage: 'rocm/dev-ubuntu-24.04:6.2.4',
          containerName: 'lw-rocm-bad-dri',
          targetHardware: { accelerator: 'gfx1101', isolationMode: 'whole_device', deviceCount: 1 },
          stageAOutDir: '/var/lib/lw/job1/stage-a-out',
          workloadDir: '/var/lib/lw/job1/workload-snap',
          allocatedDeviceNodes: ['/dev/dri'],
          seccompProfilePath: seccompPath,
          command: '/workspace/workload/evaluate.sh',
          host,
        }),
      /never \/dev\/dri directory/,
    );
    assert.throws(
      () =>
        compileDockerSandboxCommand({
          stage: 'B',
          dockerImage: 'nvidia/cuda:12.6.0-base',
          containerName: 'lw-missing-seccomp',
          targetHardware: { accelerator: 'sm_89', isolationMode: 'whole_device', deviceCount: 1 },
          stageAOutDir: '/var/lib/lw/job1/stage-a-out',
          workloadDir: '/var/lib/lw/job1/workload-snap',
          command: '/workspace/workload/evaluate.sh',
          host,
        }),
      /seccompProfilePath/,
    );

    // 4. Rejects toolchain mount overlapping forbidden paths (heldOutWorkloadsDir, tlsCaPath parent, /var/run)
    for (const badTc of ['/var/lib/lw/held_out_workloads', '/var/lib/lw', '/etc/lw', '/var/run', '/run', '/']) {
      assert.throws(
        () =>
          compileDockerSandboxCommand({
            stage: 'A',
            dockerImage: 'nvidia/cuda:12.6.0-base',
            containerName: 'lw-overlap-tc',
            targetHardware: { accelerator: 'sm_89', isolationMode: 'whole_device' },
            candidateDir: '/var/lib/lw/job1/candidate',
            stageAOutDir: '/var/lib/lw/job1/stage-a-out',
            toolchainPaths: [badTc],
            forbiddenHostPaths: ['/var/lib/lw/held_out_workloads', '/etc/lw/ca.pem'],
            seccompProfilePath: seccompPath,
            command: '/bin/true',
            host,
          }),
        (err: unknown) => err instanceof HardwareRunnerError && err.code === 'RUNNER_SANDBOX_FAILED',
      );
    }

    // 5. Bounded mount-tree scan rejects a toolchain directory containing ANY live Unix domain socket (even unnamed ipc.sock!)
    const socketToolchainDir = join(root, 'tc-with-socket');
    await mkdir(join(socketToolchainDir, 'bin'), { recursive: true, mode: 0o755 });
    const hiddenSockPath = join(socketToolchainDir, 'bin', 'runtime-ipc.sock');
    const sockSrv = createNetServer();
    await new Promise<void>(r => sockSrv.listen(hiddenSockPath, () => r()));
    try {
      assert.throws(
        () =>
          compileDockerSandboxCommand({
            stage: 'A',
            dockerImage: 'nvidia/cuda:12.6.0-base',
            containerName: 'lw-sock-tree',
            targetHardware: { accelerator: 'sm_89', isolationMode: 'whole_device' },
            candidateDir: '/var/lib/lw/job1/candidate',
            stageAOutDir: '/var/lib/lw/job1/stage-a-out',
            toolchainPaths: [socketToolchainDir],
            seccompProfilePath: seccompPath,
            command: '/bin/true',
            host,
          }),
        /forbidden Unix socket/,
      );
    } finally {
      sockSrv.close();
    }

    // 6. Rejects toolchain directory containing a symlink escaping into heldOutWorkloadsDir
    const symToolchainDir = join(root, 'tc-with-escape-link');
    const secretWlDir = join(root, 'private-workloads');
    await mkdir(symToolchainDir, { mode: 0o755 });
    await mkdir(secretWlDir, { mode: 0o700 });
    await symlink(secretWlDir, join(symToolchainDir, 'sneaky-link'));
    assert.throws(
      () =>
        compileDockerSandboxCommand({
          stage: 'A',
          dockerImage: 'nvidia/cuda:12.6.0-base',
          containerName: 'lw-sym-escape',
          targetHardware: { accelerator: 'sm_89', isolationMode: 'whole_device' },
          candidateDir: '/var/lib/lw/job1/candidate',
          stageAOutDir: '/var/lib/lw/job1/stage-a-out',
          toolchainPaths: [symToolchainDir],
          forbiddenHostPaths: [secretWlDir],
          seccompProfilePath: seccompPath,
          command: '/bin/true',
          host,
        }),
      /overlapping protected path/,
    );

    // 7. resolveTrustedDockerExecutable rejects untrusted paths and verifies sanitized docker rm -f environment
    assert.throws(
      () => resolveTrustedDockerExecutable({ platform: 'linux', arch: 'x64', dockerExecutable: '/tmp/evil-docker', probeExecutables: true }),
      /untrusted docker executable/,
    );
    assert.equal(TRUSTED_DOCKER_PATHS.length >= 1, true);

    const envDumpFile = join(root, 'docker-rm-env.txt');
    const mockDockerRmScript = join(root, 'mock-docker-rm.sh');
    await writeFile(
      mockDockerRmScript,
      `#!/bin/sh\nenv > "${envDumpFile}"\n`,
      { mode: 0o755 },
    );
    const prevSupervisorSecret = process.env.LW_TEST_SUPERVISOR_SECRET;
    process.env.LW_TEST_SUPERVISOR_SECRET = 'DO_NOT_INHERIT_SUPERVISOR_CREDENTIAL_8877';
    try {
      await runSanitizedDockerRmForce(mockDockerRmScript, 'lw-test-container');
    } finally {
      if (prevSupervisorSecret === undefined) delete process.env.LW_TEST_SUPERVISOR_SECRET;
      else process.env.LW_TEST_SUPERVISOR_SECRET = prevSupervisorSecret;
    }
    const dumpedEnv = await readFile(envDumpFile, 'utf8');
    assert.equal(dumpedEnv.includes('DO_NOT_INHERIT_SUPERVISOR_CREDENTIAL_8877'), false);
    assert.equal(dumpedEnv.includes('LW_TEST_SUPERVISOR_SECRET'), false);
  } finally {
    await chmod(join(root, 'stage-b-seccomp.json'), 0o600).catch(() => {});
    await rm(root, { recursive: true, force: true });
  }
});

test('linux-bwrap read allowlist (no --ro-bind / /), strict socket-deny BPF, native_os physical GPU refusal, and safe multiply-linked cleanup', async () => {
  const root = await mkdtemp(join(tmpdir(), 'lw-eval-bwrap-clean-'));
  try {
    const candDir = join(root, 'cand');
    const outDir = join(root, 'out');
    const scratch = join(root, 'scratch');
    await mkdir(candDir, { mode: 0o755 });
    await mkdir(outDir, { mode: 0o700 });
    await mkdir(scratch, { mode: 0o700 });

    // 1. Linux bwrap uses --tmpfs / + explicit minimal --ro-bind /usr /usr (NEVER --ro-bind / /!)
    const linuxPrepared = prepareStageSandboxInvocation({
      stage: 'A',
      backend: 'native_os',
      command: '/bin/sh',
      args: [join(candDir, 'build.sh')],
      cwd: candDir,
      env: { PATH: '/usr/bin:/bin' },
      timeoutMs: 5_000,
      probeMode: 'synthetic_fixture',
      nativeStageSpec: {
        stage: 'A',
        candidateDir: candDir,
        stageAOutDir: outDir,
        scratchDir: scratch,
        toolchainPaths: [],
        explicitDeniedReadPaths: ['/var/lib/lw/held_out_workloads'],
      },
      host: {
        platform: 'linux',
        arch: 'x64',
        bwrapExecutable: '/usr/bin/bwrap',
        probeExecutables: false,
      },
    });
    assert.equal(linuxPrepared.executablePath, '/usr/bin/bwrap');
    assert.equal(linuxPrepared.args.includes('--unshare-all'), true);
    assert.equal(linuxPrepared.args.includes('--unshare-pid'), true);
    assert.equal(linuxPrepared.args.includes('--die-with-parent'), true);
    assert.equal(linuxPrepared.args.includes('--seccomp'), true);
    // Verify '/' AND wholesale '/usr' AND '/usr/local/share' are NEVER bound!
    for (let i = 0; i < linuxPrepared.args.length - 2; i += 1) {
      assert.notDeepEqual(linuxPrepared.args.slice(i, i + 3), ['--ro-bind', '/', '/']);
      assert.notDeepEqual(linuxPrepared.args.slice(i, i + 3), ['--ro-bind', '/usr', '/usr']);
      assert.notDeepEqual(linuxPrepared.args.slice(i, i + 3), ['--ro-bind-try', '/usr', '/usr']);
    }
    assert.equal(linuxPrepared.args.includes('/usr/local/share'), false);
    assert.equal(Buffer.isBuffer(linuxPrepared.seccompBpf), true);
    assert.equal(compileStrictSocketDenySeccompBpf('arm64').byteLength > 0, true);
    assert.throws(() => compileStrictSocketDenySeccompBpf('riscv64'), /unsupported Linux seccomp architecture/);
    linuxPrepared.cleanup();

    // 1b. Placing heldOutWorkloadsDir or tlsCaPath under /usr/local/share/... or /etc/alternatives/... MUST be rejected by buildStrictLinuxBwrapArgs!
    for (const overlappingProtected of [
      '/usr/local/share/held-out-workloads',
      '/usr/local/share/lw/ca.pem',
      '/usr/share/loopwright/workloads',
      '/lib/loopwright/secret',
      '/etc/alternatives/lw-secret',
    ]) {
      assert.throws(
        () =>
          buildStrictLinuxBwrapArgs(
            {
              stage: 'A',
              candidateDir: candDir,
              stageAOutDir: outDir,
              scratchDir: scratch,
              toolchainPaths: [],
              explicitDeniedReadPaths: [overlappingProtected],
            },
            candDir,
            {},
            false,
          ),
        (err: unknown) => err instanceof HardwareRunnerError && err.code === 'RUNNER_SANDBOX_FAILED',
      );
      assert.throws(
        () =>
          prepareStageSandboxInvocation({
            stage: 'B',
            backend: 'native_os',
            command: '/bin/true',
            args: [],
            cwd: outDir,
            env: {},
            timeoutMs: 5_000,
            probeMode: 'synthetic_fixture',
            nativeStageSpec: {
              stage: 'B',
              stageAOutDir: outDir,
              workloadSnapshotDir: candDir,
              scratchDir: scratch,
              toolchainPaths: [],
              explicitDeniedReadPaths: [overlappingProtected],
            },
            host: { platform: 'linux', arch: 'x64', bwrapExecutable: '/usr/bin/bwrap', probeExecutables: false },
          }),
        (err: unknown) => err instanceof HardwareRunnerError && err.code === 'RUNNER_SANDBOX_FAILED',
      );
    }

    // 2. native_os with probeMode='physical' fails closed (requires docker backend for GPU device isolation!)
    assert.throws(
      () =>
        prepareStageSandboxInvocation({
          stage: 'A',
          backend: 'native_os',
          command: '/bin/true',
          args: [],
          cwd: candDir,
          env: {},
          timeoutMs: 5_000,
          probeMode: 'physical',
          nativeStageSpec: {
            stage: 'A',
            candidateDir: candDir,
            stageAOutDir: outDir,
            scratchDir: scratch,
            toolchainPaths: [],
            explicitDeniedReadPaths: [],
          },
          host: { platform: 'linux', arch: 'x64', bwrapExecutable: '/usr/bin/bwrap', probeExecutables: false },
        }),
      /docker backend is required/,
    );

    // 3. removeTreeFailClosed NEVER mutates permissions on multiply-linked regular file inodes (nlink > 1)!
    const sharedFile = join(root, 'shared-external.txt');
    await writeFile(sharedFile, 'shared-data', { mode: 0o644 });
    await chmod(sharedFile, 0o644);
    const cleanupTarget = join(root, 'to-remove');
    await mkdir(join(cleanupTarget, 'sealed-sub'), { recursive: true, mode: 0o700 });
    await link(sharedFile, join(cleanupTarget, 'sealed-sub', 'hardlinked.txt'));
    await writeFile(join(cleanupTarget, 'sealed-sub', 'sealed-file.bin'), 'sealed', { mode: 0o400 });
    await chmod(join(cleanupTarget, 'sealed-sub'), 0o500);
    await chmod(cleanupTarget, 0o500);

    await removeTreeFailClosed(cleanupTarget);
    await assert.rejects(() => lstat(cleanupTarget), { code: 'ENOENT' });
    const sharedStatAfter = await lstat(sharedFile);
    assert.equal(sharedStatAfter.mode & 0o777, 0o644);
    assert.equal(sharedStatAfter.nlink, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('evaluateBenchmarkJob handles Stage A missing entrypoint, compile failure, timeout, threshold misses, Docker orchestration, and full process-group teardown', async () => {
  const root = await mkdtemp(join(tmpdir(), 'lw-eval-flows-'));
  try {
    const workDir = join(root, 'work');
    const workloadsDir = join(root, 'workloads');
    await mkdir(workDir, { recursive: true, mode: 0o700 });
    await mkdir(join(workloadsDir, 'gemm-4096'), { recursive: true, mode: 0o700 });
    await writeFile(
      join(workloadsDir, 'gemm-4096', 'evaluate.sh'),
      'printf \'{"status":"approved","metrics":{"max_abs_err":0.0001,"tflops":300,"baseline_tflops":200}}\\n\'\n',
      { mode: 0o644 },
    );

    const evaluator = createTwoStageEvaluator();

    // 1. Missing Stage A entrypoint -> STAGE_A_ENTRYPOINT_MISSING
    const noEntryRes = await evaluator({
      config: makeWorkerConfig(workDir, workloadsDir),
      grant: makeLeaseGrant(),
      downloadInputBlob: async () => {},
    });
    assert.equal(noEntryRes.status, 'denied');
    assert.equal(noEntryRes.reason, 'STAGE_A_ENTRYPOINT_MISSING');
    await noEntryRes.cleanup();

    // 2. Stage A compile failure -> STAGE_A_COMPILE_FAILED
    const failScript = Buffer.from('#!/bin/sh\necho "nvcc error: syntax error" >&2\nexit 1\n', 'utf8');
    const failSha = sha256Hex(failScript);
    const compileFailRes = await evaluator({
      config: makeWorkerConfig(workDir, workloadsDir),
      grant: makeLeaseGrant({
        candidateArtifacts: {
          entries: [{ name: 'build.sh', digest: { algorithm: 'sha256', hex: failSha }, byteLength: failScript.byteLength, mode: '100755' }],
          deleted: [],
        },
      }),
      downloadInputBlob: async (_sha, _len, onChunk) => onChunk(failScript),
    });
    assert.equal(compileFailRes.status, 'denied');
    assert.equal(compileFailRes.reason, 'STAGE_A_COMPILE_FAILED');
    assert.match(compileFailRes.detail ?? '', /nvcc error/);
    await compileFailRes.cleanup();

    // 3. Stage A timeout kills sandboxed process before returning!
    const hangScript = Buffer.from(
      [
        `#!${process.execPath}`,
        'const fs = require("node:fs"), path = require("node:path");',
        'fs.writeFileSync(path.join(process.env.LOOPWRIGHT_STAGE_A_OUT, "stage-a.pid"), String(process.pid));',
        'setTimeout(() => {}, 30_000);',
      ].join('\n'),
      'utf8',
    );
    const hangSha = sha256Hex(hangScript);
    const timeoutRes = await evaluator({
      config: makeWorkerConfig(workDir, workloadsDir, {
        stageATimeoutMs: 180,
        toolchainPaths: [join(process.execPath, '..')],
      }),
      grant: makeLeaseGrant({
        candidateArtifacts: {
          entries: [{ name: 'build.sh', digest: { algorithm: 'sha256', hex: hangSha }, byteLength: hangScript.byteLength, mode: '100755' }],
          deleted: [],
        },
      }),
      downloadInputBlob: async (_sha, _len, onChunk) => onChunk(hangScript),
    });
    assert.equal(timeoutRes.status, 'denied');
    assert.equal(timeoutRes.reason, 'STAGE_A_TIMEOUT');
    await timeoutRes.cleanup();

    // 4. Comparative threshold miss with numeric-only metrics + structured findings
    const okBuild = Buffer.from('#!/bin/sh\nprintf "cubin" > "$LOOPWRIGHT_STAGE_A_OUT/out.cubin"\n', 'utf8');
    const okSha = sha256Hex(okBuild);
    const threshMissRes = await evaluator({
      config: makeWorkerConfig(workDir, workloadsDir),
      grant: makeLeaseGrant({
        metricThresholds: [
          { kind: 'comparative', metric: 'latency_us', baselineMetric: 'base_us', operator: 'max_ratio', threshold: 0.8 },
        ],
        candidateArtifacts: {
          entries: [{ name: 'build.sh', digest: { algorithm: 'sha256', hex: okSha }, byteLength: okBuild.byteLength, mode: '100755' }],
          deleted: [],
        },
      }),
      stageBCommand: {
        command: '/bin/sh',
        args: [
          '-c',
          'printf \'{"status":"approved","metrics":{"latency_us":95,"base_us":100},"findings":[{"title":"occupancy note","severity":"low","path":"src/gemm.cu","line":12,"evidence":"registers=128"}]}\\n\'',
        ],
      },
      downloadInputBlob: async (_sha, _len, onChunk) => onChunk(okBuild),
    });
    assert.equal(threshMissRes.status, 'denied');
    assert.equal(threshMissRes.reason, 'METRIC_THRESHOLD_FAILED');
    assert.equal((threshMissRes.findings?.length ?? 0) >= 2, true);
    await threshMissRes.cleanup();

    // 5. Docker two-stage orchestration (ROCm with allocatedDeviceNodes + Stage B seccomp file + supervisor non-disclosure)
    const dockerConfig = makeWorkerConfig(workDir, workloadsDir, {
      sandboxBackend: 'docker',
      dockerImage: 'rocm/dev-ubuntu-24.04:6.2',
      probeMode: 'physical',
      capabilities: {
        accelerator: 'gfx942',
        isolationModes: ['whole_device'],
        deviceCount: 2,
        driverVersion: '6.8.5',
      },
    });
    const rocmGrant = makeLeaseGrant({
      targetCellId: 'rocm-mi300x',
      targetHardware: { accelerator: 'gfx942', isolationMode: 'whole_device', deviceCount: 2 },
      metricThresholds: [{ kind: 'comparative', metric: 'mem_mb', baselineMetric: 'base_mb', operator: 'max_delta', threshold: 10 }],
      candidateArtifacts: {
        entries: [{ name: 'scripts/stage-a.sh', digest: { algorithm: 'sha256', hex: okSha }, byteLength: okBuild.byteLength, mode: '100755' }],
        deleted: [],
      },
    });
    const mockPhysicalProbe = async () => ({
      targetCellId: 'rocm-mi300x',
      probeKind: 'physical' as const,
      vendor: 'amd',
      deviceModel: 'AMD Instinct MI300X',
      accelerator: 'gfx942',
      isolationMode: 'whole_device' as const,
      deviceCount: 2,
      driverVersion: '6.8.5',
      runtimeVersion: '6.2.4',
      workloadDigest: { algorithm: 'sha256' as const, hex: '1'.repeat(64) },
      clockLockMode: 'locked' as const,
    });

    const dockerCrashRes = await evaluateBenchmarkJob({
      config: dockerConfig,
      grant: rocmGrant,
      allocatedDeviceNodes: ['/dev/dri/renderD128', '/dev/dri/renderD129'],
      host: { platform: 'linux', arch: 'x64', dockerExecutable: '/usr/bin/docker', probeExecutables: false },
      probe: mockPhysicalProbe,
      downloadInputBlob: async (_sha, _len, onChunk) => onChunk(okBuild),
      processRunner: async input => {
        assert.equal(input.backend, 'docker');
        assert.equal(input.dockerCompiled?.args.includes('--user'), true);
        // BOTH Stage A and Stage B Docker invocations MUST enforce socket-denial seccomp!
        assert.equal(input.dockerCompiled?.args.some(a => a.startsWith('seccomp=')), true);
        if (input.stage === 'B') {
          assert.equal(input.dockerCompiled?.args.includes('/dev/dri'), false);
          assert.equal(input.dockerCompiled?.args.includes('/dev/dri/renderD128'), true);
          return { exitCode: 139, signal: null, stdout: '', stderr: 'SECRET_WORKLOAD_DUMP_DO_NOT_LEAK', timedOut: false };
        }
        return { exitCode: 0, signal: null, stdout: '', stderr: '', timedOut: false };
      },
    });
    assert.equal(dockerCrashRes.status, 'denied');
    assert.equal(dockerCrashRes.reason, 'STAGE_B_EXECUTION_FAILED');
    assert.equal(dockerCrashRes.detail, 'Stage B exited with code 139');
    assert.equal(dockerCrashRes.detail?.includes('SECRET_WORKLOAD_DUMP'), false);
    await dockerCrashRes.cleanup();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('Docker ROCm sysfs/Ascend device validation, prepareStageSandboxInvocation bounds, sealStageAOutputs & parseStageBResultEnvelope negative paths', async () => {
  const realTmp = await realpath(tmpdir());
  const root = await mkdtemp(join(realTmp, 'lw-eval-bounds-'));
  try {
    const cDir = join(root, 'cand');
    const outDir = join(root, 'out');
    const wlDir = join(root, 'wl');
    const scratchDir = join(root, 'scratch');
    await mkdir(cDir, { recursive: true, mode: 0o700 });
    await mkdir(outDir, { recursive: true, mode: 0o700 });
    await mkdir(wlDir, { recursive: true, mode: 0o700 });
    await mkdir(scratchDir, { recursive: true, mode: 0o700 });

    // resolveTrustedDockerExecutable negative & non-probe paths
    assert.equal(
      resolveTrustedDockerExecutable({ platform: 'linux', arch: 'x64', dockerExecutable: '/usr/bin/docker', probeExecutables: false }),
      '/usr/bin/docker',
    );
    assert.throws(
      () => resolveTrustedDockerExecutable({ platform: 'linux', arch: 'x64', dockerExecutable: '/tmp/evil-docker', probeExecutables: false }),
      /untrusted docker executable/,
    );

    // Ascend NPU Docker compilation (probeExecutables: false vs probeExecutables: true missing char device)
    const seccompFile = join(root, 'seccomp.json');
    await writeFile(seccompFile, buildDockerStageBSeccompProfileJson(), { mode: 0o400 });
    const ascendCmd = compileDockerSandboxCommand({
      stage: 'A',
      dockerImage: 'cann:8.0',
      containerName: 'lw-ascend-a',
      targetHardware: { accelerator: 'ascend_910b', isolationMode: 'whole_device', deviceCount: 2 },
      candidateDir: cDir,
      stageAOutDir: outDir,
      seccompProfilePath: seccompFile,
      command: '/bin/true',
      host: { platform: 'linux', arch: 'arm64', dockerExecutable: '/usr/bin/docker', probeExecutables: false },
    });
    assert.equal(ascendCmd.args.includes('/dev/davinci0'), true);
    assert.equal(ascendCmd.args.includes('/dev/davinci1'), true);
    assert.equal(ascendCmd.args.includes('/dev/davinci_manager'), true);
    assert.equal(ascendCmd.args.includes('ASCEND_RT_VISIBLE_DEVICES=0,1'), true);
    assert.equal(ascendCmd.args.includes(`seccomp=${seccompFile}`), true);

    const fakeDev = join(root, 'fake-dev');
    const fakeSys = join(root, 'fake-sys');
    await mkdir(join(fakeDev, 'dri'), { recursive: true, mode: 0o700 });
    await mkdir(join(fakeSys, 'class', 'kfd', 'kfd', 'topology', 'nodes', '1'), { recursive: true, mode: 0o700 });
    await writeFile(join(fakeSys, 'class', 'kfd', 'kfd', 'topology', 'nodes', '1', 'properties'), 'drm_render_minor 128\n', { mode: 0o600 });
    // Regular file instead of character device at fakeDev/kfd must fail closed!
    await writeFile(join(fakeDev, 'kfd'), '', { mode: 0o600 });
    const mockDockerRoot = join(root, 'mock-docker');
    await mkdir(join(mockDockerRoot, 'usr', 'bin'), { recursive: true, mode: 0o755 });
    const mockDockerBin = join(mockDockerRoot, 'usr', 'bin', 'docker');
    await writeFile(mockDockerBin, '#!/bin/sh\n', { mode: 0o555 });
    await chmod(mockDockerBin, 0o555);
    await chmod(join(mockDockerRoot, 'usr', 'bin'), 0o555);
    await chmod(join(mockDockerRoot, 'usr'), 0o555);
    await chmod(mockDockerRoot, 0o555);

    // Invalid dockerImage / containerName / UID / deviceCount / unsupported accel / ROCm duplicate or mismatched nodes / Stage A&B dir rules
    const mockHost = { platform: 'linux' as const, arch: 'x64' as const, dockerExecutable: '/usr/bin/docker', probeExecutables: false };
    assert.throws(
      () => compileDockerSandboxCommand({ stage: 'A', dockerImage: '-bad', containerName: 'lw-ok', targetHardware: { accelerator: 'sm_90', isolationMode: 'whole_device' }, candidateDir: cDir, stageAOutDir: outDir, seccompProfilePath: seccompFile, command: '/bin/true', host: mockHost }),
      /invalid dockerImage/,
    );
    assert.throws(
      () => compileDockerSandboxCommand({ stage: 'A', dockerImage: 'cuda:12', containerName: '../bad', targetHardware: { accelerator: 'sm_90', isolationMode: 'whole_device' }, candidateDir: cDir, stageAOutDir: outDir, seccompProfilePath: seccompFile, command: '/bin/true', host: mockHost }),
      /invalid docker containerName/,
    );
    assert.throws(
      () => compileDockerSandboxCommand({ stage: 'A', dockerImage: 'cuda:12', containerName: 'lw-ok', containerUser: { uid: -1, gid: 0 }, targetHardware: { accelerator: 'sm_90', isolationMode: 'whole_device' }, candidateDir: cDir, stageAOutDir: outDir, seccompProfilePath: seccompFile, command: '/bin/true', host: mockHost }),
      /invalid container UID\/GID/,
    );
    assert.throws(
      () => compileDockerSandboxCommand({ stage: 'A', dockerImage: 'cuda:12', containerName: 'lw-ok', targetHardware: { accelerator: 'sm_90', isolationMode: 'whole_device', deviceCount: 0 }, candidateDir: cDir, stageAOutDir: outDir, seccompProfilePath: seccompFile, command: '/bin/true', host: mockHost }),
      /invalid targetHardware\.deviceCount/,
    );
    assert.throws(
      () => compileDockerSandboxCommand({ stage: 'A', dockerImage: 'cuda:12', containerName: 'lw-ok', targetHardware: { accelerator: 'tpu_v5', isolationMode: 'whole_device' }, candidateDir: cDir, stageAOutDir: outDir, seccompProfilePath: seccompFile, command: '/bin/true', host: mockHost }),
      /unsupported accelerator/,
    );
    assert.throws(
      () => compileDockerSandboxCommand({ stage: 'A', dockerImage: 'rocm:6', containerName: 'lw-ok', targetHardware: { accelerator: 'gfx942', isolationMode: 'whole_device', deviceCount: 2 }, allocatedDeviceNodes: ['/dev/dri/renderD128'], candidateDir: cDir, stageAOutDir: outDir, seccompProfilePath: seccompFile, command: '/bin/true', host: mockHost }),
      /allocatedDeviceNodes count/,
    );
    assert.throws(
      () => compileDockerSandboxCommand({ stage: 'A', dockerImage: 'rocm:6', containerName: 'lw-ok', targetHardware: { accelerator: 'gfx942', isolationMode: 'whole_device', deviceCount: 2 }, allocatedDeviceNodes: ['/dev/dri/renderD128', '/dev/dri/renderD128'], candidateDir: cDir, stageAOutDir: outDir, seccompProfilePath: seccompFile, command: '/bin/true', host: mockHost }),
      /duplicate ROCm device node/,
    );
    assert.throws(
      () => compileDockerSandboxCommand({ stage: 'A', dockerImage: 'cuda:12', containerName: 'lw-ok', targetHardware: { accelerator: 'sm_90', isolationMode: 'whole_device' }, candidateDir: cDir, workloadDir: wlDir, stageAOutDir: outDir, seccompProfilePath: seccompFile, command: '/bin/true', host: mockHost }),
      /must NEVER mount held_out_workloads/,
    );
    assert.throws(
      () => compileDockerSandboxCommand({ stage: 'B', dockerImage: 'cuda:12', containerName: 'lw-ok', targetHardware: { accelerator: 'sm_90', isolationMode: 'whole_device' }, candidateDir: cDir, workloadDir: wlDir, stageAOutDir: outDir, seccompProfilePath: seccompFile, command: '/bin/true', host: mockHost }),
      /must not mount raw Stage A candidateDir/,
    );
    assert.throws(
      () => compileDockerSandboxCommand({ stage: 'A', dockerImage: 'cuda:12', containerName: 'lw-ok', targetHardware: { accelerator: 'sm_90', isolationMode: 'whole_device' }, candidateDir: cDir, stageAOutDir: outDir, seccompProfilePath: seccompFile, env: { 'BAD-KEY': '1' }, command: '/bin/true', host: mockHost }),
      /invalid environment variable/,
    );

    // Overlapping toolchain mounts and symlink-to-protected-path inside toolchain tree fail closed
    const tcParent = join(root, 'tc-parent');
    const tcChild = join(tcParent, 'sub');
    await mkdir(tcChild, { recursive: true, mode: 0o755 });
    assert.throws(
      () => compileDockerSandboxCommand({ stage: 'A', dockerImage: 'cuda:12', containerName: 'lw-ok', targetHardware: { accelerator: 'sm_90', isolationMode: 'whole_device' }, candidateDir: cDir, stageAOutDir: outDir, seccompProfilePath: seccompFile, toolchainPaths: [tcParent, tcChild], command: '/bin/true', host: mockHost }),
      /overlapping toolchain mount/,
    );
    const tcEscape = join(root, 'tc-escape');
    await mkdir(tcEscape, { recursive: true, mode: 0o755 });
    await symlink(wlDir, join(tcEscape, 'sneaky-wl-link'));
    assert.throws(
      () => compileDockerSandboxCommand({ stage: 'A', dockerImage: 'cuda:12', containerName: 'lw-ok', targetHardware: { accelerator: 'sm_90', isolationMode: 'whole_device' }, candidateDir: cDir, stageAOutDir: outDir, seccompProfilePath: seccompFile, toolchainPaths: [tcEscape], forbiddenHostPaths: [wlDir], command: '/bin/true', host: mockHost }),
      /overlapping protected path/,
    );

    // prepareStageSandboxInvocation negative bounds
    assert.throws(
      () => prepareStageSandboxInvocation({ stage: 'A', backend: 'docker', command: '/bin/true', args: [], cwd: '/', env: {}, timeoutMs: 1_000 }),
      /missing compiled docker command/,
    );
    assert.throws(
      () => prepareStageSandboxInvocation({ stage: 'A', backend: 'native_os', command: '/bin/true', args: [], cwd: cDir, env: {}, timeoutMs: 1_000 }),
      /missing native OS stage sandbox specification/,
    );
    assert.throws(
      () =>
        prepareStageSandboxInvocation({
          stage: 'A',
          backend: 'native_os',
          command: '/bin/true',
          args: [],
          cwd: cDir,
          env: {},
          timeoutMs: 1_000,
          nativeStageSpec: { stage: 'A', candidateDir: cDir, stageAOutDir: outDir, scratchDir, toolchainPaths: [], explicitDeniedReadPaths: [] },
          host: { platform: 'win32', arch: 'x64', probeExecutables: false },
        }),
      /unsupported on platform "win32"/,
    );
    assert.throws(() => compileStrictSocketDenySeccompBpf('riscv64'), /unsupported Linux seccomp architecture/);

    // sealStageAOutputs forbidden .git, symlink, hardlink, and per-file maxBlobBytes checks
    const sealForbiddenDir = join(root, 'seal-git');
    await mkdir(join(sealForbiddenDir, '.git'), { recursive: true, mode: 0o700 });
    const scrubber = new SecretScrubber();
    await assert.rejects(
      () => sealStageAOutputs({ stageAOutDir: sealForbiddenDir, scrubber, secretOverlapBytes: 16 }),
      /forbidden directory/,
    );

    const sealSymDir = join(root, 'seal-sym');
    await mkdir(sealSymDir, { recursive: true, mode: 0o700 });
    await symlink('/etc/hosts', join(sealSymDir, 'escape.cubin'));
    await assert.rejects(
      () => sealStageAOutputs({ stageAOutDir: sealSymDir, scrubber, secretOverlapBytes: 16 }),
      /symlink/,
    );

    const sealBigDir = join(root, 'seal-big');
    await mkdir(join(sealBigDir, 'nested'), { recursive: true, mode: 0o700 });
    await writeFile(join(sealBigDir, 'nested', 'huge.cubin'), Buffer.alloc(128, 7), { mode: 0o600 });
    await assert.rejects(
      () => sealStageAOutputs({ stageAOutDir: sealBigDir, scrubber, secretOverlapBytes: 16, maxBlobBytes: 32 }),
      (err: unknown) => err instanceof HardwareRunnerError && err.code === 'PAYLOAD_TOO_LARGE',
    );
    const sealedNested = await sealStageAOutputs({ stageAOutDir: sealBigDir, scrubber, secretOverlapBytes: 16, maxBlobBytes: 1_024 });
    assert.equal(sealedNested.length, 1);
    assert.equal(sealedNested[0]!.artifact.name, 'nested/huge.cubin');
    await removeTreeFailClosed(sealBigDir);

    // parseStageBResultEnvelope bounds & findings validation
    assert.throws(
      () => parseStageBResultEnvelope('LOOPWRIGHT_STAGE_B_RESULT:{"status":"approved"}\nLOOPWRIGHT_STAGE_B_RESULT:{"status":"approved"}\n', scrubber),
      /multiple LOOPWRIGHT_STAGE_B_RESULT/,
    );
    assert.throws(
      () => parseStageBResultEnvelope(JSON.stringify({ status: 'denied', detail: 'x'.repeat(70_000) }), scrubber),
      (err: unknown) => err instanceof HardwareRunnerError && err.code === 'PAYLOAD_TOO_LARGE',
    );
    assert.throws(
      () => parseStageBResultEnvelope(JSON.stringify({ status: 'approved', reason: 'UNEXPECTED' }), scrubber),
      /must not specify non-null reason/,
    );
    const validDeniedEnv = parseStageBResultEnvelope(
      JSON.stringify({
        status: 'denied',
        reason: null,
        detail: null,
        findings: [{ title: 'Register spill', severity: 'medium', path: 'packages/k.cu', line: 42, evidence: '16 bytes spill' }],
      }),
      scrubber,
    );
    assert.equal(validDeniedEnv.reason, 'BENCHMARK_DENIED');
    assert.equal(validDeniedEnv.findings?.[0]?.line, 42);

    await chmod(mockDockerRoot, 0o700);
    await chmod(join(mockDockerRoot, 'usr'), 0o700);
    await chmod(join(mockDockerRoot, 'usr', 'bin'), 0o700);
    await chmod(join(root, 'seccomp.json'), 0o600).catch(() => {});
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('ROCm sysfs KFD/DRM discovery, probeHost char-device & seccomp checks, LWTREE01 negative invariants, Stage B linux-bwrap, Stage B timeout, and stderr overflow', async () => {
  const realTmp = await realpath(tmpdir());
  const root = await mkdtemp(join(realTmp, 'lw-eval-cov2-'));
  try {
    const cDir = join(root, 'cand');
    const outDir = join(root, 'out');
    const wlDir = join(root, 'wl');
    const scratchDir = join(root, 'scratch');
    await mkdir(cDir, { recursive: true, mode: 0o700 });
    await mkdir(outDir, { recursive: true, mode: 0o700 });
    await mkdir(wlDir, { recursive: true, mode: 0o700 });
    await mkdir(scratchDir, { recursive: true, mode: 0o700 });

    const mockDockerRoot = join(root, 'trusted-docker');
    await mkdir(join(mockDockerRoot, 'bin'), { recursive: true, mode: 0o755 });
    const mockDockerBin = join(mockDockerRoot, 'bin', 'docker');
    await writeFile(mockDockerBin, '#!/bin/sh\n', { mode: 0o555 });
    await chmod(mockDockerBin, 0o555);
    await chmod(join(mockDockerRoot, 'bin'), 0o555);
    await chmod(mockDockerRoot, 0o555);

    const probeTrueHost = {
      platform: 'linux' as const,
      arch: 'x64' as const,
      dockerExecutable: mockDockerBin,
      probeExecutables: true,
    };
    const probeFalseHost = {
      platform: 'linux' as const,
      arch: 'x64' as const,
      dockerExecutable: '/usr/bin/docker',
      probeExecutables: false,
    };

    // 1. Default resolveTrustedDockerExecutable probe across TRUSTED_DOCKER_PATHS (either finds root docker or rejects)
    try {
      const p = resolveTrustedDockerExecutable({ platform: 'linux', arch: 'x64', probeExecutables: true });
      assert.equal(TRUSTED_DOCKER_PATHS.includes(p) || p.startsWith('/'), true);
    } catch (err: unknown) {
      assert.equal(err instanceof HardwareRunnerError && err.code === 'RUNNER_SANDBOX_FAILED', true);
    }

    // 2. ROCm sysfs discovery #1: KFD topology nodes (drm_render_minor > 0)
    const stageASeccomp = join(root, 'opt-stage-a-seccomp.json');
    await writeFile(stageASeccomp, buildDockerStageBSeccompProfileJson(), { mode: 0o400 });
    const sysKfd = join(root, 'sys-kfd');
    const devKfd = join(root, 'dev-kfd');
    await mkdir(join(sysKfd, 'class', 'kfd', 'kfd', 'topology', 'nodes', '0'), { recursive: true, mode: 0o700 });
    await mkdir(join(sysKfd, 'class', 'kfd', 'kfd', 'topology', 'nodes', '1'), { recursive: true, mode: 0o700 });
    await writeFile(join(sysKfd, 'class', 'kfd', 'kfd', 'topology', 'nodes', '0', 'properties'), 'drm_render_minor 0\n', { mode: 0o600 });
    await writeFile(join(sysKfd, 'class', 'kfd', 'kfd', 'topology', 'nodes', '1', 'properties'), 'drm_render_minor 128\n', { mode: 0o600 });
    const rocmKfdCmd = compileDockerSandboxCommand({
      stage: 'A',
      dockerImage: 'rocm:6.2',
      containerName: 'lw-rocm-kfd',
      targetHardware: { accelerator: 'gfx942', isolationMode: 'whole_device', deviceCount: 1 },
      sysfsRoot: sysKfd,
      devRoot: devKfd,
      candidateDir: cDir,
      stageAOutDir: outDir,
      seccompProfilePath: stageASeccomp,
      command: '/bin/true',
      host: probeFalseHost,
    });
    assert.equal(rocmKfdCmd.args.includes(join(devKfd, 'dri', 'renderD128')), true);

    // 3. ROCm sysfs discovery #2: /sys/class/drm/renderD* vendor 0x1002 fallback (skipping 0x8086)
    const sysDrm = join(root, 'sys-drm');
    await mkdir(join(sysDrm, 'class', 'drm', 'renderD128', 'device'), { recursive: true, mode: 0o700 });
    await mkdir(join(sysDrm, 'class', 'drm', 'renderD129', 'device'), { recursive: true, mode: 0o700 });
    await writeFile(join(sysDrm, 'class', 'drm', 'renderD128', 'device', 'vendor'), '0x8086\n', { mode: 0o600 });
    await writeFile(join(sysDrm, 'class', 'drm', 'renderD129', 'device', 'vendor'), '0x1002\n', { mode: 0o600 });
    const rocmDrmCmd = compileDockerSandboxCommand({
      stage: 'A',
      dockerImage: 'rocm:6.2',
      containerName: 'lw-rocm-drm',
      targetHardware: { accelerator: 'gfx942', isolationMode: 'whole_device', deviceCount: 1 },
      sysfsRoot: sysDrm,
      devRoot: devKfd,
      candidateDir: cDir,
      stageAOutDir: outDir,
      seccompProfilePath: stageASeccomp,
      command: '/bin/true',
      host: probeFalseHost,
    });
    assert.equal(rocmDrmCmd.args.includes(join(devKfd, 'dri', 'renderD129')), true);
    assert.equal(rocmDrmCmd.args.includes(join(devKfd, 'dri', 'renderD128')), false);

    // Insufficient ROCm devices fails closed
    assert.throws(
      () =>
        compileDockerSandboxCommand({
          stage: 'A',
          dockerImage: 'rocm:6.2',
          containerName: 'lw-rocm-short',
          targetHardware: { accelerator: 'gfx942', isolationMode: 'whole_device', deviceCount: 2 },
          sysfsRoot: sysDrm,
          devRoot: devKfd,
          candidateDir: cDir,
          stageAOutDir: outDir,
          seccompProfilePath: stageASeccomp,
          command: '/bin/true',
          host: probeFalseHost,
        }),
      /unable to isolate 2 allocated ROCm renderD/,
    );

    // 4. probeExecutables: true enforces character-device checks for ROCm & Ascend + Stage A/B seccomp file existence
    await mkdir(join(devKfd, 'dri'), { recursive: true, mode: 0o700 });
    await writeFile(join(devKfd, 'kfd'), 'not-a-char-dev', { mode: 0o600 });
    await writeFile(join(devKfd, 'davinci0'), 'not-a-char-dev', { mode: 0o600 });
    assert.throws(
      () =>
        compileDockerSandboxCommand({
          stage: 'A',
          dockerImage: 'rocm:6.2',
          containerName: 'lw-rocm-nonchar',
          targetHardware: { accelerator: 'gfx942', isolationMode: 'whole_device', deviceCount: 1 },
          sysfsRoot: sysKfd,
          devRoot: devKfd,
          candidateDir: cDir,
          stageAOutDir: outDir,
          seccompProfilePath: stageASeccomp,
          command: '/bin/true',
          host: probeTrueHost,
          _testOnlyTrustedDockerRoot: mockDockerRoot,
        }),
      /must be a non-symlink character device/,
    );
    assert.throws(
      () =>
        compileDockerSandboxCommand({
          stage: 'A',
          dockerImage: 'cann:8.0',
          containerName: 'lw-ascend-nonchar',
          targetHardware: { accelerator: 'ascend_910b', isolationMode: 'whole_device', deviceCount: 1 },
          devRoot: devKfd,
          candidateDir: cDir,
          stageAOutDir: outDir,
          seccompProfilePath: stageASeccomp,
          command: '/bin/true',
          host: probeTrueHost,
          _testOnlyTrustedDockerRoot: mockDockerRoot,
        }),
      /not a character device/,
    );
    assert.throws(
      () =>
        compileDockerSandboxCommand({
          stage: 'B',
          dockerImage: 'cuda:12.4',
          containerName: 'lw-b-missing-seccomp',
          targetHardware: { accelerator: 'sm_90a', isolationMode: 'whole_device', deviceCount: 1 },
          workloadDir: wlDir,
          stageAOutDir: outDir,
          seccompProfilePath: join(root, 'missing-seccomp.json'),
          command: '/bin/true',
          host: probeTrueHost,
          _testOnlyTrustedDockerRoot: mockDockerRoot,
        }),
      /existing regular file/,
    );

    // 5. Stage B linux-bwrap preparation with toolchain + non-existent child cwd
    const bwrapStageB = prepareStageSandboxInvocation({
      stage: 'B',
      backend: 'native_os',
      command: '/bin/sh',
      args: ['/workspace/evaluate.sh'],
      cwd: join(wlDir, 'nonexistent-sub'),
      env: { LOOPWRIGHT_STAGE: 'B' },
      timeoutMs: 5_000,
      nativeStageSpec: {
        stage: 'B',
        stageAOutDir: outDir,
        workloadSnapshotDir: wlDir,
        scratchDir,
        toolchainPaths: ['/opt/rocm'],
        explicitDeniedReadPaths: [join(root, 'denied-workloads')],
      },
      host: { platform: 'linux', arch: 'arm64', bwrapExecutable: '/usr/bin/bwrap', probeExecutables: false },
    });
    assert.equal(bwrapStageB.args.includes('/opt/rocm'), true);
    assert.equal(bwrapStageB.seccompBpf !== null, true);

    // 6. LWTREE01 negative invariants + reconstructCandidateWorkspace deleted/corrupt paths
    assert.throws(() => encodeLwtree01Bundle([{ name: '', mode: '100644', bytes: Buffer.alloc(0) }]), /invalid artifact relative path/);
    assert.throws(() => encodeLwtree01Bundle([{ name: '../bad', mode: '100644', bytes: Buffer.alloc(0) }]), /disallowed artifact relative path/);
    assert.throws(() => encodeLwtree01Bundle([{ name: '.git/config', mode: '100644', bytes: Buffer.alloc(0) }]), /disallowed artifact relative path/);
    assert.throws(() => encodeLwtree01Bundle([
      { name: 'dup.cu', mode: '100644', bytes: Buffer.alloc(0) },
      { name: 'dup.cu', mode: '100644', bytes: Buffer.alloc(0) },
    ]), /duplicate LWTREE01 entry name/);
    assert.throws(() => encodeLwtree01Bundle([
      { name: 'Foo.cu', mode: '100644', bytes: Buffer.alloc(0) },
      { name: 'foo.cu', mode: '100644', bytes: Buffer.alloc(0) },
    ]), /case-colliding LWTREE01 entry path/);
    assert.throws(() => encodeLwtree01Bundle([
      { name: 'a/b', mode: '100644', bytes: Buffer.alloc(0) },
      { name: 'a/b/c', mode: '100644', bytes: Buffer.alloc(0) },
    ]), /prefix collision/);

    const validOne = encodeLwtree01Bundle([
      { name: 'a.cu', mode: '100755', bytes: Buffer.from('ok', 'utf8') },
      { name: 'b.cu', mode: '100644', bytes: Buffer.from('ok', 'utf8') },
    ]);
    assert.equal(decodeLwtree01Bundle(validOne)[0]?.mode, '100755');
    assert.throws(() => decodeLwtree01Bundle(Buffer.alloc(4)), /bundle buffer bounds/);
    assert.throws(() => decodeLwtree01Bundle(validOne, 8), /bundle buffer bounds/);
    assert.throws(() => decodeLwtree01Bundle(Buffer.from('BADMAGIC0123456789', 'utf8')), /magic header/);
    const hugeCountHdr = Buffer.from(validOne.subarray(0, 12));
    hugeCountHdr.writeUInt32BE(999_999, 8);
    assert.throws(() => decodeLwtree01Bundle(hugeCountHdr), /entry count exceeds/);
    assert.throws(() => decodeLwtree01Bundle(validOne.subarray(0, 14)), /truncated LWTREE01 path length/);
    assert.throws(() => decodeLwtree01Bundle(validOne.subarray(0, 17)), /entry framing/);
    const badUtf8 = Buffer.from(validOne);
    badUtf8[16] = 0xff;
    assert.throws(() => decodeLwtree01Bundle(badUtf8), /non-UTF8 path/);
    const badMode = Buffer.from(validOne);
    badMode[12 + 4 + 4] = 9;
    assert.throws(() => decodeLwtree01Bundle(badMode), /modeFlag/);
    const truncPayload = Buffer.from(validOne.subarray(0, validOne.byteLength - 1));
    assert.throws(() => decodeLwtree01Bundle(truncPayload), /truncated LWTREE01 entry payload/);
    assert.throws(() => decodeLwtree01Bundle(Buffer.concat([validOne, Buffer.from([0])])), /trailing bytes/);
    const rawUnsorted = Buffer.from(validOne);
    rawUnsorted[16] = 'z'.charCodeAt(0);
    assert.throws(() => decodeLwtree01Bundle(rawUnsorted), /unsorted or duplicate/);
    const rawCase = Buffer.from(encodeLwtree01Bundle([
      { name: 'A.cu', mode: '100644', bytes: Buffer.alloc(0) },
      { name: 'b.cu', mode: '100644', bytes: Buffer.alloc(0) },
    ]));
    rawCase[12 + 4 + 4 + 1 + 4 + 4] = 'a'.charCodeAt(0);
    assert.throws(() => decodeLwtree01Bundle(rawCase), /case-colliding/);
    const rawPrefix = Buffer.from(encodeLwtree01Bundle([
      { name: 'a', mode: '100644', bytes: Buffer.alloc(0) },
      { name: 'b/c', mode: '100644', bytes: Buffer.alloc(0) },
    ]));
    rawPrefix[12 + 4 + 1 + 1 + 4 + 4] = 'a'.charCodeAt(0);
    assert.throws(() => decodeLwtree01Bundle(rawPrefix), /prefix collision/);
    await removeTreeFailClosed(join(root, 'already-enoent-path'));

    const reconDir = join(root, 'recon');
    await mkdir(join(reconDir, 'keep-dir'), { recursive: true, mode: 0o755 });
    // Missing parent in deleted[] is skipped cleanly; directory in deleted[] throws ARTIFACT_INVALID
    await reconstructCandidateWorkspace({
      candidateDir: reconDir,
      candidateArtifacts: { entries: [], deleted: ['no-such-parent/file.cu'] },
      downloadInputBlob: async () => {},
    });
    await assert.rejects(
      () =>
        reconstructCandidateWorkspace({
          candidateDir: reconDir,
          candidateArtifacts: { entries: [], deleted: ['keep-dir'] },
          downloadInputBlob: async () => {},
        }),
      /targets symlink or directory/,
    );

    // 7. Stage B timeout + Stage A real OS-sandbox stderr >1 MiB overflow + Ascend visibility env
    const workDir = join(root, 'work');
    const workloadsRoot = join(root, 'workloads');
    await mkdir(workDir, { recursive: true, mode: 0o700 });
    await mkdir(join(workloadsRoot, 'gemm-4096'), { recursive: true, mode: 0o700 });
    await writeFile(join(workloadsRoot, 'gemm-4096', 'evaluate.sh'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });

    const okBuild = Buffer.from('#!/bin/sh\nexit 0\n', 'utf8');
    const okBuildSha = sha256Hex(okBuild);
    const cfg = makeWorkerConfig(workDir, workloadsRoot, {
      toolchainPaths: [join(process.execPath, '..')],
      capabilities: {
        accelerator: 'ascend_910b',
        isolationModes: ['whole_device'],
        deviceCount: 2,
        driverVersion: '24.1.0',
        workloadIds: ['gemm-4096'],
      },
    });
    const bTimeoutRes = await evaluateBenchmarkJob({
      config: cfg,
      grant: makeLeaseGrant({
        targetHardware: { accelerator: 'ascend_910b', isolationMode: 'whole_device', deviceCount: 2 },
        candidateArtifacts: {
          entries: [{ name: 'build.sh', digest: { algorithm: 'sha256', hex: okBuildSha }, byteLength: okBuild.byteLength, mode: '100755' }],
          deleted: [],
        },
      }),
      downloadInputBlob: async (_sha, _len, onChunk) => onChunk(okBuild),
      processRunner: async input => {
        if (input.stage === 'A') {
          assert.equal(input.env.ASCEND_RT_VISIBLE_DEVICES, '0,1');
          return { exitCode: 0, signal: null, stdout: '', stderr: '', timedOut: false };
        }
        return { exitCode: null, signal: 'SIGKILL', stdout: '', stderr: 'secret timeout log', timedOut: true };
      },
    });
    assert.equal(bTimeoutRes.status, 'denied');
    assert.equal(bTimeoutRes.reason, 'STAGE_B_TIMEOUT');
    await bTimeoutRes.cleanup();

    const stderrSpam = Buffer.from(
      `#!${process.execPath}\nprocess.stderr.write(Buffer.alloc(1_250_000, 0x61));\n`,
      'utf8',
    );
    const stderrSpamSha = sha256Hex(stderrSpam);
    await assert.rejects(
      () =>
        evaluateBenchmarkJob({
          config: cfg,
          grant: makeLeaseGrant({
            targetHardware: { accelerator: 'ascend_910b', isolationMode: 'whole_device', deviceCount: 2 },
            candidateArtifacts: {
              entries: [{ name: 'build.sh', digest: { algorithm: 'sha256', hex: stderrSpamSha }, byteLength: stderrSpam.byteLength, mode: '100755' }],
              deleted: [],
            },
          }),
          downloadInputBlob: async (_sha, _len, onChunk) => onChunk(stderrSpam),
        }),
      (err: unknown) => err instanceof HardwareRunnerError && err.code === 'ARTIFACT_INVALID',
    );
  } finally {
    await chmod(join(root, 'opt-stage-a-seccomp.json'), 0o600).catch(() => {});
    await chmod(join(root, 'trusted-docker'), 0o700).catch(() => {});
    await chmod(join(root, 'trusted-docker', 'bin'), 0o700).catch(() => {});
    await rm(root, { recursive: true, force: true });
  }
});

test('defaultStageProcessRunner >1 MiB stdio overflow rejection, /bin/sh Stage B fallback, signal diagnostics, and max_ratio/max_delta thresholds', async () => {
  const realTmp = await realpath(tmpdir());
  const root = await mkdtemp(join(realTmp, 'lw-eval-stdio-'));
  try {
    const workDir = join(root, 'work');
    const workloadsDir = join(root, 'held_out_workloads');
    await mkdir(workDir, { recursive: true, mode: 0o700 });
    await mkdir(join(workloadsDir, 'gemm-4096'), { recursive: true, mode: 0o700 });
    // Non-executable (0o644) evaluate.sh exercises the /bin/sh Stage B script runner!
    await writeFile(
      join(workloadsDir, 'gemm-4096', 'evaluate.sh'),
      'printf \'{"status":"approved","metrics":{"latency_ms":14.0,"base_latency_ms":10.0}}\\n\'\n',
      { mode: 0o644 },
    );

    const cfg: WorkerConfig = {
      workerId: 'w-stdio',
      relayUrl: 'http://127.0.0.1:18443',
      workerToken: 'worker-secret-token-stdio-0123456789',
      workDir,
      heldOutWorkloadsDir: workloadsDir,
      sandboxBackend: 'native_os',
      capabilities: {
        accelerator: 'sm_90a',
        isolationModes: ['whole_device'],
        deviceCount: 1,
        driverVersion: '550.90.07',
        workloadIds: ['gemm-4096'],
      },
      pollWaitMs: 100,
      heartbeatIntervalMs: 500,
      requestTimeoutMs: 5_000,
      stageATimeoutMs: 8_000,
      stageBTimeoutMs: 8_000,
      toolchainPaths: [join(process.execPath, '..')],
      probeMode: 'synthetic_fixture',
    };

    // 1. Real OS sandbox Stage A > 1 MiB stdout overflow rejects fail-closed with ARTIFACT_INVALID
    const spamScript = Buffer.from(
      `#!${process.execPath}\nprocess.stdout.write(Buffer.alloc(1_250_000, 0x61));\n`,
      'utf8',
    );
    const spamSha = sha256Hex(spamScript);
    const evaluator = createTwoStageEvaluator();
    await assert.rejects(
      () =>
        evaluator({
          config: cfg,
          grant: makeLeaseGrant({
            candidateArtifacts: {
              entries: [{ name: 'build.sh', digest: { algorithm: 'sha256', hex: spamSha }, byteLength: spamScript.byteLength, mode: '100755' }],
              deleted: [],
            },
          }),
          downloadInputBlob: async (_sha, _len, onChunk) => onChunk(spamScript),
        }),
      (err: unknown) => err instanceof HardwareRunnerError && err.code === 'ARTIFACT_INVALID',
    );

    // 2. Non-executable Stage B evaluate.sh via /bin/sh + max_ratio & max_delta threshold violations
    const okBuild = Buffer.from('#!/bin/sh\nprintf "ok" > "$LOOPWRIGHT_STAGE_A_OUT/k.cubin"\n', 'utf8');
    const okBuildSha = sha256Hex(okBuild);
    for (const rule of [
      { kind: 'comparative' as const, metric: 'latency_ms', baselineMetric: 'base_latency_ms', operator: 'max_ratio' as const, threshold: 1.1 },
      { kind: 'comparative' as const, metric: 'latency_ms', baselineMetric: 'base_latency_ms', operator: 'max_delta' as const, threshold: 2.0 },
    ]) {
      const res = await evaluator({
        config: cfg,
        grant: makeLeaseGrant({
          candidateArtifacts: {
            entries: [{ name: 'build.sh', digest: { algorithm: 'sha256', hex: okBuildSha }, byteLength: okBuild.byteLength, mode: '100755' }],
            deleted: [],
          },
          metricThresholds: [rule],
        }),
        downloadInputBlob: async (_sha, _len, onChunk) => onChunk(okBuild),
      });
      assert.equal(res.status, 'denied');
      assert.equal(res.reason, 'METRIC_THRESHOLD_FAILED');
      await res.cleanup();
    }

    // 3. Stage B signal termination + non-zero exit claiming status="approved" rejected
    const sigRes = await evaluateBenchmarkJob({
      config: cfg,
      grant: makeLeaseGrant({
        candidateArtifacts: {
          entries: [{ name: 'build.sh', digest: { algorithm: 'sha256', hex: okBuildSha }, byteLength: okBuild.byteLength, mode: '100755' }],
          deleted: [],
        },
      }),
      downloadInputBlob: async (_sha, _len, onChunk) => onChunk(okBuild),
      processRunner: async input =>
        input.stage === 'A'
          ? { exitCode: 0, signal: null, stdout: '', stderr: '', timedOut: false }
          : { exitCode: null, signal: 'SIGSEGV', stdout: 'raw workload dump', stderr: 'secret crash', timedOut: false },
    });
    assert.equal(sigRes.status, 'denied');
    assert.equal(sigRes.reason, 'STAGE_B_EXECUTION_FAILED');
    assert.equal(sigRes.detail, 'Stage B terminated by signal SIGSEGV');
    await sigRes.cleanup();

    const nonZeroClaimedApproved = await evaluateBenchmarkJob({
      config: cfg,
      grant: makeLeaseGrant({
        candidateArtifacts: {
          entries: [{ name: 'build.sh', digest: { algorithm: 'sha256', hex: okBuildSha }, byteLength: okBuild.byteLength, mode: '100755' }],
          deleted: [],
        },
      }),
      downloadInputBlob: async (_sha, _len, onChunk) => onChunk(okBuild),
      processRunner: async input =>
        input.stage === 'A'
          ? { exitCode: 0, signal: null, stdout: '', stderr: '', timedOut: false }
          : { exitCode: 1, signal: null, stdout: '{"status":"approved"}', stderr: '', timedOut: false },
    });
    assert.equal(nonZeroClaimedApproved.status, 'denied');
    assert.equal(nonZeroClaimedApproved.reason, 'STAGE_B_EXECUTION_FAILED');
    assert.equal(nonZeroClaimedApproved.detail, 'Stage B exited with code 1');
    await nonZeroClaimedApproved.cleanup();

    // 4. Positive backend-owned teardown verification:
    //    (a) runSanitizedDockerRmForce resolves on "No such container" but rejects with RunnerTeardownError on daemon failure or timeout!
    const okAbsentDocker = join(root, 'docker-rm-absent.sh');
    await writeFile(okAbsentDocker, '#!/bin/sh\necho "Error response from daemon: No such container: lw-gone" >&2\nexit 1\n', { mode: 0o755 });
    await runSanitizedDockerRmForce(okAbsentDocker, 'lw-gone');

    const failDocker = join(root, 'docker-rm-fail.sh');
    await writeFile(failDocker, '#!/bin/sh\necho "Cannot connect to the Docker daemon" >&2\nexit 1\n', { mode: 0o755 });
    await assert.rejects(
      () => runSanitizedDockerRmForce(failDocker, 'lw-stuck'),
      (err: unknown) => err instanceof RunnerTeardownError && isRunnerTeardownError(err),
    );

    const hangDocker = join(root, 'docker-rm-hang.sh');
    await writeFile(hangDocker, '#!/bin/sh\nsleep 10\n', { mode: 0o755 });
    await assert.rejects(
      () => runSanitizedDockerRmForce(hangDocker, 'lw-hang', { timeoutMs: 60 }),
      (err: unknown) => err instanceof RunnerTeardownError && isRunnerTeardownError(err),
    );

    //    (b) waitForProcessGroupExit throws RunnerTeardownError when deadline expires while group remains alive!
    await assert.rejects(
      () => waitForProcessGroupExit(999_999_991, 45, () => true),
      (err: unknown) => err instanceof RunnerTeardownError && isRunnerTeardownError(err),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('pre-spawn monotonic lease deadline recheck aborts synchronous toolchain scan before spawn, and unified ROCm allocation binds identical GPU in provenance and Docker', async () => {
  const realTmp = await realpath(tmpdir());
  const root = await mkdtemp(join(realTmp, 'lw-eval-fix3-'));
  try {
    const workDir = join(root, 'work');
    const workloadsDir = join(root, 'workloads');
    const largeTcDir = join(root, 'large-toolchain');
    await mkdir(workDir, { recursive: true, mode: 0o700 });
    await mkdir(join(workloadsDir, 'gemm-4096'), { recursive: true, mode: 0o700 });
    await mkdir(largeTcDir, { recursive: true, mode: 0o755 });
    await writeFile(
      join(workloadsDir, 'gemm-4096', 'evaluate.sh'),
      'printf \'{"status":"approved","metrics":{"max_abs_err":0.0001,"tflops":300,"baseline_tflops":200}}\\n\'\n',
      { mode: 0o644 },
    );

    // Populate >300 entries in largeTcDir so scanMountTreeForSocketsAndEscapesSync hits its periodic deadline check!
    for (let i = 0; i < 320; i += 1) {
      await writeFile(join(largeTcDir, `tool-${String(i)}.txt`), 'x', { mode: 0o644 });
    }

    const spawnedMarker = join(root, 'should-never-spawn.marker');
    const stageAScript = Buffer.from(
      `#!${process.execPath}\nconst fs = require("node:fs");\nfs.writeFileSync(process.env.LOOPWRIGHT_STAGE_A_OUT + "/ran.bin", "1");\n`,
      'utf8',
    );
    const stageASha = sha256Hex(stageAScript);

    // 1a. Monotonic clock crosses leaseDeadlineMonoMs during Stage A preparation (inside defaultStageProcessRunner):
    //     spawn MUST NEVER be invoked!
    let monoCalls = 0;
    let fakeMono = 1_000;
    const leaseDeadline = 2_000;
    await assert.rejects(
      () =>
        evaluateBenchmarkJob({
          config: makeWorkerConfig(workDir, workloadsDir, {
            toolchainPaths: [largeTcDir, join(process.execPath, '..')],
          }),
          grant: makeLeaseGrant({
            candidateArtifacts: {
              entries: [{ name: 'build.sh', digest: { algorithm: 'sha256', hex: stageASha }, byteLength: stageAScript.byteLength, mode: '100755' }],
              deleted: [],
            },
          }),
          leaseDeadlineMonoMs: leaseDeadline,
          nowMonotonicMs: () => {
            monoCalls += 1;
            // Stay below deadline during initial evaluator setup, then cross deadline during Stage A preparation scan!
            if (monoCalls >= 8) {
              fakeMono = 2_500;
            }
            return fakeMono;
          },
          downloadInputBlob: async (_sha, _len, onChunk) => onChunk(stageAScript),
        }),
      (err: unknown) => err instanceof HardwareRunnerError && err.code === 'QUEUE_LEASE_FENCED',
    );
    await assert.rejects(() => lstat(spawnedMarker), { code: 'ENOENT' });
    assert.deepEqual(await readdir(workDir), []);

    // 1b. Dynamic leaseDeadlineMonoMs shorter than stageATimeoutMs terminates running Stage A with QUEUE_LEASE_FENCED (not STAGE_A_TIMEOUT)
    const sleepStageA = Buffer.from(`#!${process.execPath}\nsetTimeout(() => {}, 10_000);\n`, 'utf8');
    const sleepSha = sha256Hex(sleepStageA);
    const basePerf = performance.now();
    await assert.rejects(
      () =>
        evaluateBenchmarkJob({
          config: makeWorkerConfig(workDir, workloadsDir, {
            stageATimeoutMs: 10_000,
            toolchainPaths: [join(process.execPath, '..')],
          }),
          grant: makeLeaseGrant({
            candidateArtifacts: {
              entries: [{ name: 'build.sh', digest: { algorithm: 'sha256', hex: sleepSha }, byteLength: sleepStageA.byteLength, mode: '100755' }],
              deleted: [],
            },
          }),
          getLeaseDeadlineMonoMs: () => basePerf + 120,
          nowMonotonicMs: () => performance.now(),
          downloadInputBlob: async (_sha, _len, onChunk) => onChunk(sleepStageA),
        }),
      (err: unknown) => err instanceof HardwareRunnerError && err.code === 'QUEUE_LEASE_FENCED',
    );

    // 2. Heterogeneous 2-GPU ROCm host:
    //    GPU 0 -> renderD128 (AMD Radeon RX 7600, gfx1102)
    //    GPU 1 -> renderD129 (AMD Instinct MI300X, gfx942)
    //    Allocating ['/dev/dri/renderD129'] MUST bind GPU 1 in BOTH provenance AND Stage A/B Docker --device flags!
    const fakeSys = join(root, 'rocm-sys');
    const fakeDev = join(root, 'rocm-dev');
    await mkdir(join(fakeSys, 'class', 'kfd', 'kfd', 'topology', 'nodes', '0'), { recursive: true, mode: 0o700 });
    await mkdir(join(fakeSys, 'class', 'kfd', 'kfd', 'topology', 'nodes', '1'), { recursive: true, mode: 0o700 });
    await mkdir(join(fakeSys, 'class', 'kfd', 'kfd', 'topology', 'nodes', '2'), { recursive: true, mode: 0o700 });
    await writeFile(join(fakeSys, 'class', 'kfd', 'kfd', 'topology', 'nodes', '0', 'properties'), 'drm_render_minor 0\n', { mode: 0o600 });
    await writeFile(join(fakeSys, 'class', 'kfd', 'kfd', 'topology', 'nodes', '1', 'properties'), 'drm_render_minor 128\n', { mode: 0o600 });
    await writeFile(join(fakeSys, 'class', 'kfd', 'kfd', 'topology', 'nodes', '2', 'properties'), 'drm_render_minor 129\n', { mode: 0o600 });

    const renderD128 = join(fakeDev, 'dri', 'renderD128');
    const renderD129 = join(fakeDev, 'dri', 'renderD129');
    const renderD199 = join(fakeDev, 'dri', 'renderD199');
    const heteroRocmSmiJson = JSON.stringify({
      card0: { 'Card series': 'AMD Radeon RX 7600', 'GFX Version': 'gfx1102', 'Performance Level': 'auto' },
      card1: { 'Card series': 'AMD Instinct MI300X', 'GFX Version': 'gfx942', 'Performance Level': 'manual' },
      system: { 'Driver version': '6.8.5', 'ROCm version': '6.2.4' },
    });

    const stageDockerArgs: string[][] = [];
    const rocmUnifiedRes = await evaluateBenchmarkJob({
      config: makeWorkerConfig(workDir, workloadsDir, {
        sandboxBackend: 'docker',
        dockerImage: 'rocm/dev-ubuntu-24.04:6.2.4',
        probeMode: 'physical',
        capabilities: {
          accelerator: 'gfx942',
          isolationModes: ['whole_device'],
          deviceCount: 2,
          driverVersion: '6.8.5',
        },
      }),
      grant: makeLeaseGrant({
        targetCellId: 'rocm-mi300x',
        targetHardware: { accelerator: 'gfx942', isolationMode: 'whole_device', deviceCount: 1 },
        metricThresholds: [],
        candidateArtifacts: {
          entries: [{ name: 'scripts/stage-a.sh', digest: { algorithm: 'sha256', hex: stageASha }, byteLength: stageAScript.byteLength, mode: '100755' }],
          deleted: [],
        },
      }),
      allocatedDeviceNodes: [renderD129],
      sysfsRoot: fakeSys,
      devRoot: fakeDev,
      host: { platform: 'linux', arch: 'x64', dockerExecutable: '/usr/bin/docker', probeExecutables: false },
      probe: opts =>
        collectHardwareProvenance({
          ...opts,
          verifyExecutable: async p => p,
          commandRunner: async () => ({ exitCode: 0, stdout: heteroRocmSmiJson, stderr: '' }),
        }),
      downloadInputBlob: async (_sha, _len, onChunk) => onChunk(stageAScript),
      processRunner: async input => {
        stageDockerArgs.push([...(input.dockerCompiled?.args ?? [])]);
        if (input.stage === 'A') {
          return { exitCode: 0, signal: null, stdout: '', stderr: '', timedOut: false };
        }
        return { exitCode: 0, signal: null, stdout: '{"status":"approved"}', stderr: '', timedOut: false };
      },
    });
    try {
      assert.equal(rocmUnifiedRes.status, 'approved');
      assert.equal(rocmUnifiedRes.hardwareProvenance?.accelerator, 'gfx942');
      assert.equal(rocmUnifiedRes.hardwareProvenance?.deviceModel, 'AMD Instinct MI300X');
      assert.equal(rocmUnifiedRes.hardwareProvenance?.clockLockMode, 'locked');
      assert.equal(stageDockerArgs.length, 2);
      for (const args of stageDockerArgs) {
        assert.equal(args.includes(renderD129), true);
        assert.equal(args.includes(renderD128), false);
      }
    } finally {
      await rocmUnifiedRes.cleanup();
    }

    // Unmappable ROCm render node fails closed before probing or launching Docker
    await assert.rejects(
      () =>
        evaluateBenchmarkJob({
          config: makeWorkerConfig(workDir, workloadsDir, {
            sandboxBackend: 'docker',
            dockerImage: 'rocm/dev-ubuntu-24.04:6.2.4',
            probeMode: 'physical',
            capabilities: {
              accelerator: 'gfx942',
              isolationModes: ['whole_device'],
              deviceCount: 2,
              driverVersion: '6.8.5',
            },
          }),
          grant: makeLeaseGrant({
            targetCellId: 'rocm-mi300x',
            targetHardware: { accelerator: 'gfx942', isolationMode: 'whole_device', deviceCount: 1 },
            candidateArtifacts: { entries: [], deleted: [] },
          }),
          allocatedDeviceNodes: [renderD199],
          sysfsRoot: fakeSys,
          devRoot: fakeDev,
          host: { platform: 'linux', arch: 'x64', dockerExecutable: '/usr/bin/docker', probeExecutables: false },
          downloadInputBlob: async () => {},
        }),
      (err: unknown) => err instanceof HardwareRunnerError && err.code === 'RUNNER_SANDBOX_FAILED',
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
