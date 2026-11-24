import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmod, link, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  evaluateMetricThresholds,
  SecretScrubber,
  STAGE_A_STATIC_AUDIT_FAILED,
  type BucketMetricEntry,
  type HardwareDiagnostics,
  type MetricThresholdRule,
} from '@loopwright/core';
import {
  auditSealedStageAOutputs,
  canonicalJson,
  evaluateBenchmarkJob,
  HardwareRunnerError,
  MAX_STAGE_B_RESULT_BYTES,
  parseBenchmarkRequest,
  parseStageBResultEnvelope,
  probeAcceleratorHealth,
  runHardwareWorker,
  sealStageAOutputs,
  signRelayPayload,
  startRelayServer,
  verifyBenchmarkVerdictSignature,
  type AcceleratorHealthProbeResult,
  type BenchmarkRequest,
  type BenchmarkVerdict,
  type HardwareDiagnosticsSummary,
  type HardwareRunnerErrorCode,
  type LeaseGrant,
  type ProbeCommandRunner,
  type SignedBenchmarkVerdictReceipt,
  type StageAStaticAuditSpec,
  type WorkerConfig,
  type WorkerJobSettlementSummary,
} from '../src/index.js';

const CONTROLLER_SECRET = 'stage-audit-hmac-secret-0123456789abcdef';
const WORKER_TOKEN = 'stage-audit-worker-bearer-0123456789abcdef';

function sha256Hex(data: Uint8Array | string): string {
  return createHash('sha256').update(data).digest('hex');
}

/**
 * Deterministic pure-TypeScript ELF64 little-endian builder producing valid `.so`, `.o`, or `.cubin`
 * binaries with `.shstrtab`, `.strtab`, `.symtab`, optional `.dynstr`/`.dynsym`/`.dynamic` (`DT_NEEDED`),
 * and optional NVIDIA `.nv.info` (`EIATTR_REGCOUNT` `0x2f` + `EIATTR_FRAME_SIZE` `0x11`) sections.
 */
function buildTestElf64Binary(options: {
  readonly elfType?: number; // ET_REL=1 (.o), ET_EXEC=2 (.cubin), ET_DYN=3 (.so)
  readonly machine?: number; // EM_CUDA=190, EM_X86_64=62, EM_AARCH64=183
  readonly symbols?: readonly string[];
  readonly dynSymbols?: readonly string[];
  readonly dtNeeded?: readonly string[];
  readonly nvInfoRegCount?: number;
  readonly nvInfoSpillFrameBytes?: number;
}): Buffer {
  const elfType = options.elfType ?? 3;
  const machine = options.machine ?? 190; // EM_CUDA

  const buildStrTab = (items: readonly string[]): { readonly buf: Buffer; readonly offsets: readonly number[] } => {
    const parts: Buffer[] = [Buffer.from([0])];
    const offsets: number[] = [];
    let cursor = 1;
    for (const s of items) {
      offsets.push(cursor);
      const b = Buffer.from(`${s}\0`, 'utf8');
      parts.push(b);
      cursor += b.byteLength;
    }
    return { buf: Buffer.concat(parts), offsets };
  };

  const buildSymTab64 = (nameOffsets: readonly number[]): Buffer => {
    // Entry 0 is STN_UNDEF (24 zero bytes); each symbol entry in Elf64_Sym is 24 bytes.
    const buf = Buffer.alloc((1 + nameOffsets.length) * 24, 0);
    for (let i = 0; i < nameOffsets.length; i += 1) {
      const off = (i + 1) * 24;
      buf.writeUInt32LE(nameOffsets[i]!, off); // st_name
      buf.writeUInt8(0x12, off + 4); // STB_GLOBAL | STT_FUNC
      buf.writeUInt8(0, off + 5); // st_other
      buf.writeUInt16LE(0, off + 6); // st_shndx = SHN_UNDEF (imported)
    }
    return buf;
  };

  interface SectionSpec {
    readonly name: string;
    readonly shType: number;
    readonly shLink: number;
    readonly shEntSize: number;
    readonly data: Buffer;
  }

  const sections: SectionSpec[] = [];

  if (options.symbols !== undefined && options.symbols.length > 0) {
    const strTab = buildStrTab(options.symbols);
    const symTab = buildSymTab64(strTab.offsets);
    const strTabSecIdx = 1 + sections.length;
    sections.push({ name: '.strtab', shType: 3, shLink: 0, shEntSize: 0, data: strTab.buf });
    sections.push({ name: '.symtab', shType: 2, shLink: strTabSecIdx, shEntSize: 24, data: symTab });
  }

  if (
    (options.dynSymbols !== undefined && options.dynSymbols.length > 0)
    || (options.dtNeeded !== undefined && options.dtNeeded.length > 0)
  ) {
    const dynStrings = [...(options.dynSymbols ?? []), ...(options.dtNeeded ?? [])];
    const dynStr = buildStrTab(dynStrings);
    const dynSymCount = options.dynSymbols?.length ?? 0;
    const dynSymOffsets = dynStr.offsets.slice(0, dynSymCount);
    const neededOffsets = dynStr.offsets.slice(dynSymCount);
    const dynStrSecIdx = 1 + sections.length;
    sections.push({ name: '.dynstr', shType: 3, shLink: 0, shEntSize: 0, data: dynStr.buf });
    if (dynSymOffsets.length > 0) {
      sections.push({
        name: '.dynsym',
        shType: 11,
        shLink: dynStrSecIdx,
        shEntSize: 24,
        data: buildSymTab64(dynSymOffsets),
      });
    }
    if (neededOffsets.length > 0) {
      // Elf64_Dyn: { int64 d_tag; uint64 d_val } (16 bytes each) + DT_NULL terminator
      const dynBuf = Buffer.alloc((neededOffsets.length + 1) * 16, 0);
      for (let i = 0; i < neededOffsets.length; i += 1) {
        dynBuf.writeBigInt64LE(1n, i * 16); // DT_NEEDED = 1
        dynBuf.writeBigUInt64LE(BigInt(neededOffsets[i]!), i * 16 + 8);
      }
      sections.push({
        name: '.dynamic',
        shType: 6,
        shLink: dynStrSecIdx,
        shEntSize: 16,
        data: dynBuf,
      });
    }
  }

  if (options.nvInfoRegCount !== undefined || options.nvInfoSpillFrameBytes !== undefined) {
    const records: Buffer[] = [];
    if (options.nvInfoRegCount !== undefined) {
      // EIFMT_SVAL (0x04), EIATTR_REGCOUNT (0x2f), size=8, { uint32 symIdx, uint32 regCount }
      const rec = Buffer.alloc(12, 0);
      rec.writeUInt8(0x04, 0);
      rec.writeUInt8(0x2f, 1);
      rec.writeUInt16LE(8, 2);
      rec.writeUInt32LE(1, 4);
      rec.writeUInt32LE(options.nvInfoRegCount, 8);
      records.push(rec);
    }
    if (options.nvInfoSpillFrameBytes !== undefined) {
      // EIFMT_SVAL (0x04), EIATTR_FRAME_SIZE (0x11), size=8, { uint32 symIdx, uint32 frameSize }
      const rec = Buffer.alloc(12, 0);
      rec.writeUInt8(0x04, 0);
      rec.writeUInt8(0x11, 1);
      rec.writeUInt16LE(8, 2);
      rec.writeUInt32LE(1, 4);
      rec.writeUInt32LE(options.nvInfoSpillFrameBytes, 8);
      records.push(rec);
    }
    sections.push({
      name: '.nv.info',
      shType: 0x70000000, // SHT_CUDA_INFO
      shLink: 0,
      shEntSize: 0,
      data: Buffer.concat(records),
    });
  }

  const shNames = [...sections.map(s => s.name), '.shstrtab'];
  const shStrTab = buildStrTab(shNames);
  const shStrTabSecIdx = 1 + sections.length;
  sections.push({
    name: '.shstrtab',
    shType: 3,
    shLink: 0,
    shEntSize: 0,
    data: shStrTab.buf,
  });

  // Layout: [64-byte Elf64_Ehdr] [section payloads 8-byte aligned] [Elf64_Shdr table (64 bytes * (1 + sections.length))]
  const ehdr = Buffer.alloc(64, 0);
  ehdr[0] = 0x7f;
  ehdr[1] = 0x45; // 'E'
  ehdr[2] = 0x4c; // 'L'
  ehdr[3] = 0x46; // 'F'
  ehdr[4] = 2; // ELFCLASS64
  ehdr[5] = 1; // ELFDATA2LSB
  ehdr[6] = 1; // EV_CURRENT
  ehdr.writeUInt16LE(elfType, 16);
  ehdr.writeUInt16LE(machine, 18);
  ehdr.writeUInt32LE(1, 20); // e_version
  ehdr.writeUInt16LE(64, 52); // e_ehsize
  ehdr.writeUInt16LE(64, 58); // e_shentsize
  ehdr.writeUInt16LE(1 + sections.length, 60); // e_shnum
  ehdr.writeUInt16LE(shStrTabSecIdx, 62); // e_shstrndx

  const chunks: Buffer[] = [ehdr];
  const sectionOffsets: number[] = [];
  let offset = 64;
  for (const sec of sections) {
    const pad = (8 - (offset % 8)) % 8;
    if (pad > 0) {
      chunks.push(Buffer.alloc(pad, 0));
      offset += pad;
    }
    sectionOffsets.push(offset);
    chunks.push(sec.data);
    offset += sec.data.byteLength;
  }
  const shPad = (8 - (offset % 8)) % 8;
  if (shPad > 0) {
    chunks.push(Buffer.alloc(shPad, 0));
    offset += shPad;
  }
  const shoff = offset;
  ehdr.writeBigUInt64LE(BigInt(shoff), 40);

  // Null section header 0
  chunks.push(Buffer.alloc(64, 0));
  for (let i = 0; i < sections.length; i += 1) {
    const sec = sections[i]!;
    const shdr = Buffer.alloc(64, 0);
    shdr.writeUInt32LE(shStrTab.offsets[i]!, 0); // sh_name
    shdr.writeUInt32LE(sec.shType, 4); // sh_type
    shdr.writeBigUInt64LE(BigInt(sectionOffsets[i]!), 24); // sh_offset
    shdr.writeBigUInt64LE(BigInt(sec.data.byteLength), 32); // sh_size
    shdr.writeUInt32LE(sec.shLink, 40); // sh_link
    shdr.writeBigUInt64LE(1n, 48); // sh_addralign
    shdr.writeBigUInt64LE(BigInt(sec.shEntSize), 56); // sh_entsize
    chunks.push(shdr);
  }

  return Buffer.concat(chunks);
}

function makeWorkerConfig(workDir: string, heldOutWorkloadsDir: string, overrides: Partial<WorkerConfig> = {}): WorkerConfig {
  return {
    workerId: 'worker-audit-test',
    relayUrl: 'http://127.0.0.1:19999',
    workerToken: WORKER_TOKEN,
    workDir,
    heldOutWorkloadsDir,
    sandboxBackend: 'native_os',
    capabilities: {
      accelerator: 'sm_90a',
      isolationModes: ['whole_device'],
      deviceCount: 1,
      driverVersion: '550.90.07',
      workloadIds: ['decode-holdout'],
    },
    pollWaitMs: 60,
    heartbeatIntervalMs: 50,
    requestTimeoutMs: 5_000,
    stageATimeoutMs: 15_000,
    stageBTimeoutMs: 15_000,
    toolchainPaths: [join(process.execPath, '..')],
    probeMode: 'synthetic_fixture',
    ...overrides,
  };
}

function makeLeaseGrant(overrides: Partial<LeaseGrant['job']> = {}): LeaseGrant {
  const digest = { algorithm: 'sha256' as const, hex: 'a'.repeat(64) };
  return {
    relayBootId: 'boot-audit-01',
    jobId: 'job-audit-01',
    operationId: 'verify.0.check.decode-bench',
    leaseEpoch: 1,
    leaseToken: 'LEASE_TOKEN_AUDIT_SECRET_99887766',
    leaseTtlMs: 30_000,
    job: {
      operationId: 'verify.0.check.decode-bench',
      gateId: 'sm90-gate',
      checkId: 'decode-bench',
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
      heldOutWorkloadId: 'decode-holdout',
      metricThresholds: [],
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

test('types & backward parity: legacy BenchmarkRequest and SignedBenchmarkVerdictReceipt canonical hashes remain unchanged while optional audit/bucket/diagnostics parse cleanly', () => {
  const legacyReq: BenchmarkRequest = {
    version: 1,
    kind: 'benchmark_request',
    storeId: 'store-legacy',
    runId: 'run-legacy',
    lockHash: { algorithm: 'sha256', hex: '1'.repeat(64) },
    operationId: 'verify.0.check.gemm',
    dispatchId: 'disp-1',
    dispatchGeneration: 0,
    requestDigest: '2'.repeat(64),
    gateId: 'cuda-gate',
    checkId: 'gemm',
    candidateDigest: '3'.repeat(64),
    subject: {
      lockHash: { algorithm: 'sha256', hex: '1'.repeat(64) },
      contractHash: { algorithm: 'sha256', hex: '4'.repeat(64) },
      repository: 'org/repo',
      baseRevision: 'a'.repeat(40),
      sourceRevision: 'b'.repeat(40),
      candidateDigest: { algorithm: 'sha256', hex: '3'.repeat(64) },
      targetMatrixDigest: null,
    },
    targetCellId: 'sm90',
    targetHardware: {
      accelerator: 'sm_90a',
      isolationMode: 'whole_device',
      deviceCount: 1,
    },
    heldOutWorkloadId: 'wl-1',
    metricThresholds: [{ kind: 'bounds', metric: 'max_ulp', max: 1 }],
    maxPreemptions: 3,
    candidateArtifacts: { entries: [], deleted: [] },
  };

  const parsedLegacy = parseBenchmarkRequest(JSON.parse(canonicalJson(legacyReq)));
  assert.equal(canonicalJson(parsedLegacy), canonicalJson(legacyReq));
  assert.equal(Object.keys(parsedLegacy).length, 19);
  assert.equal('stageAAudit' in parsedLegacy, false);
  assert.equal('forbiddenSymbolPatterns' in parsedLegacy.targetHardware, false);
  assert.equal('bucketScope' in parsedLegacy.metricThresholds[0]!, false);

  const auditSpec: StageAStaticAuditSpec = {
    forbiddenSymbolPatterns: ['cublas', 'cudnn', 'rocblas', 'aclnn', 'at::native::'],
    maxRegisterCount: 128,
    maxLocalSpillBytes: 0,
  };
  const extendedReq = parseBenchmarkRequest({
    ...legacyReq,
    targetHardware: {
      ...legacyReq.targetHardware,
      ...auditSpec,
    },
    stageAAudit: {
      forbiddenSymbolPatterns: ['torch_cuda'],
      maxLocalSpillBytes: 0,
    },
    metricThresholds: [
      { kind: 'bounds', metric: 'max_ulp', max: 1, bucketScope: 'all_buckets' },
      { kind: 'bounds', metric: 'latency_us_p50', max: 50, bucketScope: { bucketId: 'bs1-isl4k' } },
    ],
  });
  assert.deepEqual(extendedReq.targetHardware.forbiddenSymbolPatterns, [
    'cublas',
    'cudnn',
    'rocblas',
    'aclnn',
    'at::native::',
  ]);
  assert.equal(extendedReq.targetHardware.maxRegisterCount, 128);
  assert.equal(extendedReq.targetHardware.maxLocalSpillBytes, 0);
  assert.deepEqual(extendedReq.stageAAudit?.forbiddenSymbolPatterns, ['torch_cuda']);
  assert.deepEqual(extendedReq.metricThresholds[1]?.bucketScope, { bucketId: 'bs1-isl4k' });

  // Reject glob characters in forbiddenSymbolPatterns
  assert.throws(
    () =>
      parseBenchmarkRequest({
        ...legacyReq,
        targetHardware: {
          ...legacyReq.targetHardware,
          forbiddenSymbolPatterns: ['cublas*'],
        },
      }),
    (err: unknown) => err instanceof HardwareRunnerError && err.code === 'ARTIFACT_INVALID',
  );

  // Reject combined targetHardware + stageAAudit forbiddenSymbolPatterns exceeding LIMITS.forbiddenSymbolPatterns
  assert.throws(
    () =>
      parseBenchmarkRequest({
        ...legacyReq,
        targetHardware: {
          ...legacyReq.targetHardware,
          forbiddenSymbolPatterns: Array.from({ length: 40 }, (_, i) => `hw_sym_${i}`),
        },
        stageAAudit: {
          forbiddenSymbolPatterns: Array.from({ length: 30 }, (_, i) => `audit_sym_${i}`),
        },
      }),
    (err: unknown) => err instanceof HardwareRunnerError && err.code === 'ARTIFACT_INVALID',
  );

  // Verify HardwareDiagnosticsSummary type alignment and quarantine error code typing
  const errCode: HardwareRunnerErrorCode = 'WORKER_DEVICE_QUARANTINED';
  assert.equal(errCode, 'WORKER_DEVICE_QUARANTINED');
  const diagSummary: HardwareDiagnosticsSummary = {
    boundPipeline: 'tensor_cube',
    rooflineHeadroom: 1.12,
  };
  const receipt: SignedBenchmarkVerdictReceipt = {
    version: 1,
    kind: 'benchmark_verdict',
    storeId: 's',
    runId: 'r',
    lockHash: { algorithm: 'sha256', hex: '1'.repeat(64) },
    operationId: 'op1',
    dispatchId: 'd1',
    dispatchGeneration: 0,
    gateId: 'g1',
    checkId: 'c1',
    candidateDigest: '3'.repeat(64),
    status: 'approved',
    reason: null,
    expiresAtMs: '1900000000000',
    preemptionCount: 0,
    bucketMetrics: [{ bucketId: 'bs1-isl4k', metrics: { latency_us_p50: 14.2 } }],
    hardwareDiagnostics: diagSummary,
    signature: 'f'.repeat(64),
  };
  assert.equal(receipt.hardwareDiagnostics?.boundPipeline, 'tensor_cube');
});

test('Stage A static symbol & spill audit: denies ELF64 (.so/.o/.cubin), PTX, and SASS cublasGemmEx / at::native:: / maxLocalSpillBytes: 0 with ZERO Stage B executions', async () => {
  const root = await mkdtemp(join(tmpdir(), 'lw-stagea-audit-'));
  try {
    const workDir = join(root, 'work');
    const workloadsDir = join(root, 'held_out_workloads');
    const wlDir = join(workloadsDir, 'decode-holdout');
    await mkdir(workDir, { recursive: true, mode: 0o700 });
    await mkdir(wlDir, { recursive: true, mode: 0o700 });

    const stageBRanSentinel = join(root, 'stage-b-should-never-run.flag');
    await writeFile(
      join(wlDir, 'evaluate.sh'),
      `#!${process.execPath}\nprocess.stdout.write('LOOPWRIGHT_STAGE_B_RESULT:{"status":"approved","metrics":{"latency_us":10}}\\n');\n`,
      { mode: 0o755 },
    );

    const runWithBuildPayload = async (
      outputFiles: Readonly<Record<string, Buffer>>,
      audit: StageAStaticAuditSpec,
    ) => {
      let stageBInvocations = 0;
      const fileWrites = Object.entries(outputFiles)
        .map(
          ([relName, buf]) =>
            `fs.writeFileSync(path.join(process.env.LOOPWRIGHT_STAGE_A_OUT, ${JSON.stringify(relName)}), Buffer.from(${JSON.stringify(buf.toString('base64'))}, 'base64'));`,
        )
        .join('\n');
      const buildScript = Buffer.from(
        [`#!${process.execPath}`, 'const fs = require("node:fs"), path = require("node:path");', fileWrites].join('\n'),
        'utf8',
      );
      const buildSha = sha256Hex(buildScript);
      const grant = makeLeaseGrant({
        targetHardware: {
          accelerator: 'sm_90a',
          isolationMode: 'whole_device',
          deviceCount: 1,
          ...audit,
        },
        candidateArtifacts: {
          entries: [
            {
              name: 'scripts/build.sh',
              digest: { algorithm: 'sha256', hex: buildSha },
              byteLength: buildScript.byteLength,
              mode: '100755',
            },
          ],
          deleted: [],
        },
      });

      const evaluated = await evaluateBenchmarkJob({
        config: makeWorkerConfig(workDir, workloadsDir),
        grant,
        downloadInputBlob: async (_sha, _len, onChunk) => onChunk(buildScript),
        processRunner: async input => {
          if (input.stage === 'B') {
            stageBInvocations += 1;
            await writeFile(stageBRanSentinel, 'RAN');
            return {
              exitCode: 0,
              signal: null,
              stdout: 'LOOPWRIGHT_STAGE_B_RESULT:{"status":"approved","metrics":{"latency_us":10}}\n',
              stderr: '',
              timedOut: false,
            };
          }
          // Execute Stage A build script directly into isolated stageAOutDir
          const { spawn } = await import('node:child_process');
          return await new Promise((resRun, rejRun) => {
            const child = spawn(input.command, [...input.args], { cwd: input.cwd, env: { ...input.env } });
            let out = '';
            let err = '';
            child.stdout.on('data', (c: Buffer) => { out += c.toString('utf8'); });
            child.stderr.on('data', (c: Buffer) => { err += c.toString('utf8'); });
            child.on('error', rejRun);
            child.on('close', (code, sig) =>
              resRun({ exitCode: code, signal: sig, stdout: out, stderr: err, timedOut: false }),
            );
          });
        },
      });
      try {
        return { evaluated, stageBInvocations };
      } finally {
        await evaluated.cleanup();
      }
    };

    const strictAudit: StageAStaticAuditSpec = {
      forbiddenSymbolPatterns: ['cublas', 'cudnn', 'rocblas', 'miopen', 'aclnn', 'at::native::', 'torch_cuda'],
      maxRegisterCount: 128,
      maxLocalSpillBytes: 0,
    };

    // 1. ELF64 .so importing cublasGemmEx in .dynsym -> denied BEFORE Stage B!
    const elfSoCublas = buildTestElf64Binary({
      elfType: 3,
      machine: 62,
      dynSymbols: ['cudaLaunchKernel', 'cublasGemmEx'],
    });
    const r1 = await runWithBuildPayload({ 'libkernel.so': elfSoCublas }, strictAudit);
    assert.equal(r1.stageBInvocations, 0, 'Stage B must NOT run when ELF .so links cublasGemmEx');
    assert.equal(r1.evaluated.status, 'denied');
    assert.equal(r1.evaluated.reason, STAGE_A_STATIC_AUDIT_FAILED);
    assert.equal(r1.evaluated.findings?.some(f => f.evidence.includes('cublasGemmEx')), true);

    // 2. ELF64 .o with Itanium-mangled _ZN2at6native9gemm_cudaE -> matches 'at::native::' with 0 Stage B runs!
    const elfObjAtNative = buildTestElf64Binary({
      elfType: 1,
      machine: 62,
      symbols: ['_ZN2at6native9gemm_cudaE'],
    });
    const r2 = await runWithBuildPayload({ 'dispatch.o': elfObjAtNative }, strictAudit);
    assert.equal(r2.stageBInvocations, 0);
    assert.equal(r2.evaluated.status, 'denied');
    assert.equal(r2.evaluated.reason, STAGE_A_STATIC_AUDIT_FAILED);
    assert.equal(r2.evaluated.findings?.some(f => f.evidence.includes('at::native::')), true);

    // 3. ELF64 .cubin exceeding maxLocalSpillBytes: 0 via .nv.info EIATTR_FRAME_SIZE -> denied with 0 Stage B runs!
    const elfCubinSpill = buildTestElf64Binary({
      elfType: 2,
      machine: 190,
      symbols: ['flash_decode_kernel'],
      nvInfoRegCount: 96,
      nvInfoSpillFrameBytes: 32,
    });
    const r3 = await runWithBuildPayload({ 'flash_decode.cubin': elfCubinSpill }, strictAudit);
    assert.equal(r3.stageBInvocations, 0);
    assert.equal(r3.evaluated.status, 'denied');
    assert.equal(r3.evaluated.reason, STAGE_A_STATIC_AUDIT_FAILED);
    assert.equal(r3.evaluated.findings?.some(f => /spill|32/i.test(f.evidence)), true);

    // 4. PTX (.ptx) with .extern .func cublasGemmEx AND .local spill buffer -> denied with 0 Stage B runs!
    const badPtx = Buffer.from(
      [
        '.version 8.4',
        '.target sm_90a',
        '.extern .func cublasGemmEx (.param .b64 p0);',
        '.visible .entry gemm_entry() {',
        '  .reg .b32 %r<96>;',
        '  .reg .f32 %f<48>;',
        '  .local .align 8 .b8 __local_depot0[16];',
        '  ret;',
        '}',
      ].join('\n'),
      'utf8',
    );
    const r4 = await runWithBuildPayload({ 'gemm.ptx': badPtx }, strictAudit);
    assert.equal(r4.stageBInvocations, 0);
    assert.equal(r4.evaluated.status, 'denied');
    assert.equal(r4.evaluated.reason, STAGE_A_STATIC_AUDIT_FAILED);
    assert.equal((r4.evaluated.findings?.length ?? 0) >= 2, true);

    // 5. SASS (.sass) with ptxas spill stores / Used N registers breach -> denied with 0 Stage B runs!
    const badSass = Buffer.from(
      [
        '//--------------------- .text.flash_decode --------------------------',
        '// ptxas info    : Used 160 registers, 24 bytes stack frame, 16 bytes spill stores, 16 bytes spill loads',
        '/*0000*/ MOV R1, c[0x0][0x28] ;',
        '/*0010*/ CALL.ABS.NOINC `rocblas_hgemm ;',
      ].join('\n'),
      'utf8',
    );
    const r5 = await runWithBuildPayload({ 'flash_decode.sass': badSass }, strictAudit);
    assert.equal(r5.stageBInvocations, 0);
    assert.equal(r5.evaluated.status, 'denied');
    assert.equal(r5.evaluated.reason, STAGE_A_STATIC_AUDIT_FAILED);
    assert.equal(r5.evaluated.findings?.some(f => f.evidence.includes('rocblas')), true);
    assert.equal(r5.evaluated.findings?.some(f => f.evidence.includes('160')), true);

    // 6. Clean ELF64 .cubin + clean PTX (comment mentioning cublas ignored, 64 regs, 0 spill) PASSES Stage A and runs Stage B!
    const cleanCubin = buildTestElf64Binary({
      elfType: 2,
      machine: 190,
      symbols: ['flash_decode_sm90_kernel'],
      nvInfoRegCount: 64,
      nvInfoSpillFrameBytes: 0,
    });
    const cleanPtx = Buffer.from(
      [
        '// Pure custom WGMMA kernel without cublas or cudnn fallback',
        '.version 8.4',
        '.target sm_90a',
        '.visible .entry flash_decode_sm90_kernel() {',
        '  .reg .pred %p<8>;',
        '  .reg .b32 %r<48>;',
        '  .reg .f32 %f<16>;',
        '  ret;',
        '}',
      ].join('\n'),
      'utf8',
    );
    const r6 = await runWithBuildPayload(
      { 'flash_decode.cubin': cleanCubin, 'flash_decode.ptx': cleanPtx },
      strictAudit,
    );
    assert.equal(r6.stageBInvocations, 1, 'Clean candidate must proceed to Stage B');
    assert.equal(r6.evaluated.status, 'approved');

    // 7. Direct auditSealedStageAOutputs checks O_NOFOLLOW, nlink===1, 1 MiB cap, and optional nm/cuobjdump hook
    const directOutDir = join(root, 'direct-out');
    await mkdir(directOutDir, { mode: 0o700 });
    const over1MibPtx = Buffer.alloc(1_048_577, 0x20);
    await writeFile(join(directOutDir, 'huge.ptx'), over1MibPtx, { mode: 0o600 });
    const sealedHuge = await sealStageAOutputs({
      stageAOutDir: directOutDir,
      scrubber: new SecretScrubber(),
      secretOverlapBytes: 16_384,
    });
    const hugeAudit = await auditSealedStageAOutputs({
      sealedOutputs: sealedHuge,
      auditSpec: { forbiddenSymbolPatterns: ['cublas'] },
      scrubber: new SecretScrubber(),
    });
    assert.equal(hugeAudit.passed, false);
    assert.equal(hugeAudit.findings.some(f => /1048576|1 MiB|exceeds/i.test(f.evidence)), true);

    // Optional Linux/CUDA nm + cuobjdump toolchain hook catches toolchain-reported spill/symbol and 1 MiB stdout overflow
    const toolDir = join(root, 'tool-out');
    await mkdir(toolDir, { mode: 0o700 });
    await writeFile(join(toolDir, 'kern.cubin'), cleanCubin, { mode: 0o600 });
    const sealedCleanForTool = await sealStageAOutputs({
      stageAOutDir: toolDir,
      scrubber: new SecretScrubber(),
      secretOverlapBytes: 16_384,
    });
    const cuobjdumpCaught = await auditSealedStageAOutputs({
      sealedOutputs: sealedCleanForTool,
      auditSpec: { forbiddenSymbolPatterns: ['cudnn'], maxLocalSpillBytes: 0 },
      scrubber: new SecretScrubber(),
      auditToolRunner: async tool => {
        if (tool === 'cuobjdump') {
          return {
            exitCode: 0,
            stdout: 'Function gemm:\nREG:64 STACK:16 SHARED:0 LOCAL:16\n16 bytes spill stores, 16 bytes spill loads\ncudnnConvolutionForward\n',
            stderr: '',
          };
        }
        return { exitCode: 0, stdout: '', stderr: '' };
      },
    });
    assert.equal(cuobjdumpCaught.passed, false);
    assert.equal(cuobjdumpCaught.findings.some(f => f.evidence.includes('cudnn')), true);
    assert.equal(cuobjdumpCaught.findings.some(f => f.evidence.includes('16')), true);

    const nmOverflow = await auditSealedStageAOutputs({
      sealedOutputs: sealedCleanForTool,
      auditSpec: { forbiddenSymbolPatterns: ['cublas'] },
      scrubber: new SecretScrubber(),
      auditToolRunner: async tool => {
        if (tool === 'nm') {
          throw new Error('audit tool output exceeded 1048576 bytes');
        }
        return { exitCode: 0, stdout: '', stderr: '' };
      },
    });
    assert.equal(nmOverflow.passed, false);
    assert.equal(nmOverflow.findings.some(f => /1048576|1 MiB/i.test(f.evidence)), true);

    // Symlink / hardlink tamper check on auditSealedStageAOutputs fails closed
    const tamperDir = join(root, 'tamper-out');
    await mkdir(tamperDir, { mode: 0o700 });
    const realFile = join(tamperDir, 'k.ptx');
    await writeFile(realFile, '.version 8.4\n', { mode: 0o400 });
    const hardlinkPath = join(tamperDir, 'hardlink.ptx');
    await link(realFile, hardlinkPath);
    await assert.rejects(
      () =>
        auditSealedStageAOutputs({
          sealedOutputs: [
            {
              artifact: { name: 'k.ptx', digest: { algorithm: 'sha256', hex: sha256Hex('.version 8.4\n') }, byteLength: 13 },
              sealedFilePath: realFile,
            },
          ],
          auditSpec: { forbiddenSymbolPatterns: ['cublas'] },
          scrubber: new SecretScrubber(),
        }),
      (err: unknown) => err instanceof HardwareRunnerError && err.code === 'ARTIFACT_INVALID',
    );
    // Unsupported 32-bit Mach-O .dylib fails closed instead of falling through to UTF-8 text scan
    const machO32Path = join(tamperDir, 'legacy32.dylib');
    const machO32Buf = Buffer.alloc(32, 0);
    machO32Buf.writeUInt32LE(0xfeedface, 0);
    await writeFile(machO32Path, machO32Buf, { mode: 0o400 });
    const machO32Audit = await auditSealedStageAOutputs({
      sealedOutputs: [
        {
          artifact: {
            name: 'legacy32.dylib',
            digest: { algorithm: 'sha256', hex: sha256Hex(machO32Buf) },
            byteLength: machO32Buf.byteLength,
          },
          sealedFilePath: machO32Path,
        },
      ],
      auditSpec: { forbiddenSymbolPatterns: ['cublas'] },
      scrubber: new SecretScrubber(),
    });
    assert.equal(machO32Audit.passed, false);
    assert.match(machO32Audit.findings[0]?.title ?? '', /Unsupported Mach-O/i);

    const symPath = join(tamperDir, 'sym.ptx');
    await symlink(realFile, symPath);
    await assert.rejects(
      () =>
        auditSealedStageAOutputs({
          sealedOutputs: [
            {
              artifact: { name: 'sym.ptx', digest: { algorithm: 'sha256', hex: sha256Hex('.version 8.4\n') }, byteLength: 13 },
              sealedFilePath: symPath,
            },
          ],
          auditSpec: { forbiddenSymbolPatterns: ['cublas'] },
          scrubber: new SecretScrubber(),
        }),
      (err: unknown) => err instanceof HardwareRunnerError && err.code === 'ARTIFACT_INVALID',
    );
  } finally {
    await chmod(join(root, 'direct-out'), 0o700).catch(() => {});
    await chmod(join(root, 'tool-out'), 0o700).catch(() => {});
    await rm(root, { recursive: true, force: true });
  }
});

test('Stage B 49,152-byte bucketMetrics + sanitized hardwareDiagnostics parser, secret/free-text/file-export rejection, and all_buckets threshold denial', async () => {
  const scrubber = new SecretScrubber();
  const canarySecret = 'HELDOUT_SECRET_CANARY_TOKEN_778899AABBCC';
  scrubber.register(canarySecret);

  // 1. Maximal 64-bucket Stage B envelope + hardwareDiagnostics fits comfortably under 49,152 bytes
  const sixtyFourBuckets: BucketMetricEntry[] = Array.from({ length: 64 }, (_, i) => ({
    bucketId: `bs${(i % 8) + 1}-isl${(Math.floor(i / 8) + 1) * 1024}`,
    dimensions: {
      batch_size: (i % 8) + 1,
      isl_tokens: (Math.floor(i / 8) + 1) * 1024,
      dtype: 'fp16',
    },
    metrics: {
      latency_us_p50: 18.5 + i * 0.25,
      latency_us_p95: 21.0 + i * 0.25,
      goodput_rps: 420.0,
      peak_mem_bytes: 1_048_576,
      max_ulp: 1,
      token_force_max_delta: 0.005,
    },
  }));
  const hwDiag: HardwareDiagnostics = {
    boundPipeline: 'tensor_cube',
    rooflineHeadroom: 1.14,
    achievedSolPct: 87.5,
    arithmeticIntensity: 192.4,
    occupancyPct: 75.0,
    registerCount: 96,
    sharedMemBytes: 98_304,
    localSpillBytes: 0,
    l2HitPct: 91.2,
    bankConflictPct: 1.5,
    topStallReasons: [
      { reason: 'math_pipe_throttle', pct: 48.2 },
      { reason: 'mio_throttle', pct: 12.1 },
    ],
  };

  const validEnvelopeJson = JSON.stringify({
    status: 'approved',
    metrics: { latency_us_p50: 24.0, max_ulp: 1, token_force_max_delta: 0.005 },
    bucketMetrics: sixtyFourBuckets,
    hardwareDiagnostics: hwDiag,
  });
  assert.ok(Buffer.byteLength(validEnvelopeJson, 'utf8') < MAX_STAGE_B_RESULT_BYTES);

  const parsedEnv = parseStageBResultEnvelope(`LOOPWRIGHT_STAGE_B_RESULT:${validEnvelopeJson}\n`, scrubber);
  assert.equal(parsedEnv.status, 'approved');
  assert.equal(parsedEnv.bucketMetrics?.length, 64);
  assert.equal(parsedEnv.hardwareDiagnostics?.boundPipeline, 'tensor_cube');
  assert.equal(parsedEnv.hardwareDiagnostics?.rooflineHeadroom, 1.14);

  // 2. Reject raw -0, NaN/Infinity, prototype keys, unknown keys, free-text/non-ASCII strings, secrets, and file export attempts!
  const invalidPayloads: readonly string[] = [
    // Raw -0 in bucketMetrics and hardwareDiagnostics (must fail BEFORE @loopwright/core snapshot normalizes -0!)
    '{"status":"approved","bucketMetrics":[{"bucketId":"b1","metrics":{"max_ulp":-0}}]}',
    '{"status":"approved","bucketMetrics":[{"bucketId":"b1","dimensions":{"bs":-0},"metrics":{"max_ulp":0}}]}',
    '{"status":"approved","hardwareDiagnostics":{"boundPipeline":"hbm","localSpillBytes":-0}}',
    '{"status":"approved","hardwareDiagnostics":{"boundPipeline":"hbm","topStallReasons":[{"reason":"lg_throttle","pct":-0}]}}',
    // Prototype pollution keys
    '{"status":"approved","bucketMetrics":[{"bucketId":"__proto__","metrics":{"x":1}}]}',
    '{"status":"approved","hardwareDiagnostics":{"boundPipeline":"hbm","__proto__":{}}}',
    // Free-text / spaces / non-ASCII exfiltration attempts in hardwareDiagnostics and bucketMetrics
    '{"status":"approved","hardwareDiagnostics":{"boundPipeline":"hbm","topStallReasons":[{"reason":"leaked held out prompt text","pct":10}]}}',
    '{"status":"approved","hardwareDiagnostics":{"boundPipeline":"free text pipeline"}}',
    '{"status":"approved","bucketMetrics":[{"bucketId":"b1","dimensions":{"prompt":"leaked prompt with spaces"},"metrics":{"x":1}}]}',
    '{"status":"approved","bucketMetrics":[{"bucketId":"non_ascii_\u00e9","metrics":{"x":1}}]}',
    // SecretScrubber leak (including JSON-escaped secret)
    `{"status":"approved","hardwareDiagnostics":{"boundPipeline":"hbm","topStallReasons":[{"reason":"\\u0048${canarySecret.slice(1)}","pct":10}]}}`,
    `{"status":"approved","bucketMetrics":[{"bucketId":"b1","dimensions":{"tag":"${canarySecret}"},"metrics":{"x":1}}]}`,
    // Stage B file export attempts
    '{"status":"approved","metrics":{"x":1},"outputArtifacts":[{"name":"ncu.ncu-rep","digest":{"algorithm":"sha256","hex":"' + 'a'.repeat(64) + '"},"byteLength":12}]}',
    '{"status":"approved","metrics":{"x":1},"files":["leak.bin"]}',
    // Collection ceiling breaches (> 16 metrics in bucket, > 8 dimensions in bucket)
    JSON.stringify({
      status: 'approved',
      bucketMetrics: [
        {
          bucketId: 'b1',
          metrics: Object.fromEntries(Array.from({ length: 17 }, (_, i) => [`m${i}`, i])),
        },
      ],
    }),
    JSON.stringify({
      status: 'approved',
      bucketMetrics: [
        {
          bucketId: 'b1',
          dimensions: Object.fromEntries(Array.from({ length: 9 }, (_, i) => [`d${i}`, i])),
          metrics: { m0: 1 },
        },
      ],
    }),
  ];

  for (const badPayload of invalidPayloads) {
    assert.throws(
      () => parseStageBResultEnvelope(badPayload, scrubber),
      (err: unknown) => err instanceof HardwareRunnerError && err.code === 'ARTIFACT_INVALID',
      `expected ARTIFACT_INVALID for payload: ${badPayload}`,
    );
  }

  // 3. End-to-end Relay + Worker round-trip of bucketMetrics + hardwareDiagnostics & all_buckets METRIC_THRESHOLD_FAILED
  const root = await mkdtemp(join(tmpdir(), 'lw-stageb-e2e-'));
  const casDir = join(root, 'cas');
  const workDir = join(root, 'work');
  const workloadsDir = join(root, 'workloads');
  await mkdir(workDir, { recursive: true, mode: 0o700 });
  await mkdir(join(workloadsDir, 'decode-holdout'), { recursive: true, mode: 0o700 });

  const relay = await startRelayServer({
    port: 0,
    casDir,
    controllerSigningSecret: CONTROLLER_SECRET,
    workerTokens: [WORKER_TOKEN],
    leaseTtlMs: 10_000,
    sweepIntervalMs: 250,
  });

  try {
    const stageAndEval = async (
      opId: string,
      stageBEnvelopeObj: Record<string, unknown>,
      thresholds: readonly MetricThresholdRule[],
    ): Promise<BenchmarkVerdict> => {
      await writeFile(
        join(workloadsDir, 'decode-holdout', 'evaluate.sh'),
        `#!${process.execPath}\nprocess.stdout.write('LOOPWRIGHT_STAGE_B_RESULT:' + ${JSON.stringify(JSON.stringify(stageBEnvelopeObj))} + '\\n');\n`,
        { mode: 0o755 },
      );
      const buildScript = Buffer.from(
        `#!${process.execPath}\nrequire("node:fs").writeFileSync(process.env.LOOPWRIGHT_STAGE_A_OUT + "/k.cubin", "cubin");\n`,
        'utf8',
      );
      const buildSha = sha256Hex(buildScript);
      const putSig = signRelayPayload(CONTROLLER_SECRET, `PUT\n${opId}\n${buildSha}\n${buildScript.byteLength}`);
      const putRes = await fetch(`${relay.url}/v1/benchmark/jobs/${opId}/blobs/${buildSha}`, {
        method: 'PUT',
        headers: {
          'content-type': 'application/octet-stream',
          'x-loopwright-blob-sha256': buildSha,
          'x-loopwright-blob-length': String(buildScript.byteLength),
          'x-loopwright-signature': putSig,
        },
        body: new Uint8Array(buildScript),
      });
      assert.equal(putRes.status === 200 || putRes.status === 201, true);

      const lockHex = sha256Hex(`lock:${opId}`);
      const req: BenchmarkRequest = {
        version: 1,
        kind: 'benchmark_request',
        storeId: 'store-t6',
        runId: 'run-t6',
        lockHash: { algorithm: 'sha256', hex: lockHex },
        operationId: opId,
        dispatchId: `disp-${opId}`,
        dispatchGeneration: 1,
        requestDigest: sha256Hex(`req:${opId}`),
        gateId: 'sm90-gate',
        checkId: 'decode-bench',
        candidateDigest: buildSha,
        subject: {
          lockHash: { algorithm: 'sha256', hex: lockHex },
          contractHash: { algorithm: 'sha256', hex: lockHex },
          repository: 'org/kernels',
          baseRevision: '1'.repeat(40),
          sourceRevision: '1'.repeat(40),
          candidateDigest: { algorithm: 'sha256', hex: buildSha },
          targetMatrixDigest: null,
        },
        targetCellId: 'cuda-sm90',
        targetHardware: {
          accelerator: 'sm_90a',
          isolationMode: 'whole_device',
          deviceCount: 1,
        },
        heldOutWorkloadId: 'decode-holdout',
        metricThresholds: thresholds,
        maxPreemptions: 3,
        candidateArtifacts: {
          entries: [
            {
              name: 'scripts/build.sh',
              digest: { algorithm: 'sha256', hex: buildSha },
              byteLength: buildScript.byteLength,
              mode: '100755',
            },
          ],
          deleted: [],
        },
      };
      const reqBytes = Buffer.from(canonicalJson(req), 'utf8');
      const submitRes = await fetch(`${relay.url}/v1/benchmark/jobs`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-loopwright-signature': signRelayPayload(CONTROLLER_SECRET, reqBytes),
        },
        body: new Uint8Array(reqBytes),
      });
      assert.equal(submitRes.status, 200);

      await runHardwareWorker({
        config: makeWorkerConfig(workDir, workloadsDir, { relayUrl: relay.url }),
        once: true,
        registerProcessSignalHandlers: false,
      });

      const pollRes = await fetch(`${relay.url}/v1/benchmark/jobs`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-loopwright-signature': signRelayPayload(CONTROLLER_SECRET, reqBytes),
        },
        body: new Uint8Array(reqBytes),
      });
      assert.equal(pollRes.status, 200);
      return (await pollRes.json()) as BenchmarkVerdict;
    };

    const allBucketsRules: readonly MetricThresholdRule[] = [
      { kind: 'bounds', metric: 'max_ulp', max: 1, bucketScope: 'all_buckets' },
      { kind: 'bounds', metric: 'token_force_max_delta', max: 0.02, bucketScope: 'all_buckets' },
    ];

    // 3a. Bucket 1 violates max_ulp <= 1 (max_ulp = 2.5) -> denied with METRIC_THRESHOLD_FAILED!
    const failingBuckets: readonly BucketMetricEntry[] = [
      { bucketId: 'bs1-isl4k', metrics: { latency_us_p50: 12.1, max_ulp: 0.5, token_force_max_delta: 0.008 } },
      { bucketId: 'bs16-isl8k', metrics: { latency_us_p50: 29.4, max_ulp: 2.5, token_force_max_delta: 0.015 } },
    ];
    assert.equal(evaluateMetricThresholds(allBucketsRules, { max_ulp: 0.5 }, failingBuckets), false);

    const deniedVerdict = await stageAndEval(
      'verify.0.check.bucket-fail',
      {
        status: 'approved',
        metrics: { max_ulp: 0.5, token_force_max_delta: 0.008 },
        bucketMetrics: failingBuckets,
        hardwareDiagnostics: hwDiag,
      },
      allBucketsRules,
    );
    assert.equal(deniedVerdict.status, 'denied');
    assert.equal(deniedVerdict.reason, 'METRIC_THRESHOLD_FAILED');
    assert.equal(deniedVerdict.bucketMetrics?.length, 2);
    assert.equal(deniedVerdict.hardwareDiagnostics?.boundPipeline, 'tensor_cube');

    // 3b. All buckets pass -> approved + signed receipt on disk binds bucketMetrics & hardwareDiagnostics!
    const passingBuckets: readonly BucketMetricEntry[] = [
      { bucketId: 'bs1-isl4k', dimensions: { bs: 1, isl: 4096 }, metrics: { latency_us_p50: 12.1, max_ulp: 1, token_force_max_delta: 0.01 } },
      { bucketId: 'bs16-isl8k', dimensions: { bs: 16, isl: 8192 }, metrics: { latency_us_p50: 29.4, max_ulp: 0.75, token_force_max_delta: 0.019 } },
    ];
    const approvedVerdict = await stageAndEval(
      'verify.0.check.bucket-pass',
      {
        status: 'approved',
        metrics: { latency_us_p50: 20.75 },
        bucketMetrics: passingBuckets,
        hardwareDiagnostics: hwDiag,
      },
      [
        ...allBucketsRules,
        { kind: 'bounds', metric: 'latency_us_p50', max: 35, bucketScope: { bucketId: 'bs16-isl8k' } },
      ],
    );
    assert.equal(approvedVerdict.status, 'approved');
    assert.equal(approvedVerdict.reason, null);
    assert.deepEqual(approvedVerdict.bucketMetrics, passingBuckets);
    assert.deepEqual(approvedVerdict.hardwareDiagnostics, hwDiag);

    const persistedReceipt = JSON.parse(
      await readFile(join(casDir, 'receipts', 'verify.0.check.bucket-pass.json'), 'utf8'),
    ) as SignedBenchmarkVerdictReceipt;
    assert.equal(
      verifyBenchmarkVerdictSignature(
        CONTROLLER_SECRET,
        persistedReceipt as unknown as Readonly<Record<string, unknown>>,
        persistedReceipt.signature,
      ),
      true,
    );
    assert.deepEqual(persistedReceipt.bucketMetrics, passingBuckets);
    assert.deepEqual(persistedReceipt.hardwareDiagnostics, hwDiag);
  } finally {
    await relay.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('probeAcceleratorHealth: validates RTX 4090, RX 7800 XT low-power banner, and Ascend fixtures, detecting sticky Xid/ECC/hang faults and scrubbing secrets', async () => {
  const secretToken = 'PROBE_STDERR_SECRET_TOKEN_5544332211';
  const scrubber = new SecretScrubber();
  scrubber.register(secretToken);

  // 1a. Healthy NVIDIA GeForce RTX 4090 (measured [N/A] ECC columns + 0 remapped rows)
  const rtx4090Csv = [
    '0, NVIDIA GeForce RTX 4090, GPU-bbc521eb-4a08-800b-eb2a-770a4a5b8a8c, 00000000:02:00.0, P8, Disabled, [N/A], [N/A]',
    '1, NVIDIA GeForce RTX 4090, GPU-1068d7f6-26eb-5225-371e-58ca20150673, 00000000:03:00.0, P8, Disabled, [N/A], [N/A]',
  ].join('\n');
  const rtx4090Detail = [
    'GPU 00000000:02:00.0',
    '    ECC Mode',
    '        Current                                        : Disabled',
    '    ECC Errors',
    '        Volatile',
    '            DRAM Uncorrectable                         : N/A',
    '        Channel Repair Pending                         : No',
    '        TPC Repair Pending                             : No',
    '    Remapped Rows',
    '        Uncorrectable Error                            : 0',
    '        Pending                                        : No',
    '        Remapping Failure Occurred                     : No',
  ].join('\n');

  const healthyNvidia = await probeAcceleratorHealth({
    probeMode: 'physical',
    capabilities: {
      accelerator: 'sm_89',
      isolationModes: ['whole_device'],
      deviceCount: 2,
      driverVersion: '610.43.02',
    },
    allocatedDeviceIndices: [0],
    verifyExecutable: async p => p,
    commandRunner: async (_bin, args) => {
      if (args.includes('-q')) return { exitCode: 0, stdout: rtx4090Detail, stderr: '' };
      return { exitCode: 0, stdout: rtx4090Csv, stderr: '' };
    },
    scrubber,
  });
  assert.equal(healthyNvidia.healthy, true);
  assert.equal(healthyNvidia.quarantineRequired, false);
  assert.equal(healthyNvidia.vendor, 'nvidia');

  // 1b. NVIDIA sticky Xid / GPU lost + secret in stderr -> unhealthy, quarantineRequired, secret scrubbed!
  const xidNvidia = await probeAcceleratorHealth({
    probeMode: 'physical',
    capabilities: {
      accelerator: 'sm_90a',
      isolationModes: ['whole_device'],
      deviceCount: 1,
      driverVersion: '550.90.07',
    },
    verifyExecutable: async p => p,
    commandRunner: async () => ({
      exitCode: 15,
      stdout: 'Unable to determine the device handle for GPU 0000:02:00.0: Unknown Error (Xid 79)\n',
      stderr: `NVML error context=${secretToken}\n`,
    }),
    scrubber,
  });
  assert.equal(xidNvidia.healthy, false);
  assert.equal(xidNvidia.quarantineRequired, true);
  assert.equal(xidNvidia.summary.includes(secretToken), false);
  assert.equal(JSON.stringify(xidNvidia.findings).includes(secretToken), false);

  // 1c. NVIDIA uncorrectable ECC > 0 on H100 -> quarantineRequired
  const eccNvidia = await probeAcceleratorHealth({
    probeMode: 'physical',
    capabilities: {
      accelerator: 'sm_90a',
      isolationModes: ['whole_device'],
      deviceCount: 1,
      driverVersion: '550.90.07',
    },
    verifyExecutable: async p => p,
    commandRunner: async (_bin, args) => {
      if (args.includes('-q')) return { exitCode: 0, stdout: 'Remapping Failure Occurred : Yes\n', stderr: '' };
      return {
        exitCode: 0,
        stdout: '0, NVIDIA H100 80GB HBM3, GPU-1111, 00000000:01:00.0, P0, Enabled, 3, 3\n',
        stderr: '',
      };
    },
    scrubber,
  });
  assert.equal(eccNvidia.healthy, false);
  assert.equal(eccNvidia.quarantineRequired, true);
  assert.equal(eccNvidia.faultKind, 'ecc_uncorrectable');

  // 2a. Healthy AMD Radeon RX 7800 XT (measured leading low-power WARNING line before JSON!)
  const rx7800JsonWithBanner = [
    'WARNING: AMD GPU device(s) is/are in a low-power state. Check power control/runtime_status',
    '',
    JSON.stringify({
      card0: {
        'GPU use (%)': '0',
        'Card Series': 'AMD Radeon RX 7800 XT',
        'Card Model': '0x747e',
        'GFX Version': 'gfx1101',
      },
      card1: {
        'GPU use (%)': '0',
        'Card Series': 'AMD Radeon RX 7800 XT',
        'Card Model': '0x747e',
        'GFX Version': 'gfx1101',
      },
    }),
  ].join('\n');
  const healthyRocm = await probeAcceleratorHealth({
    probeMode: 'physical',
    capabilities: {
      accelerator: 'gfx1101',
      isolationModes: ['whole_device'],
      deviceCount: 2,
      driverVersion: '6.16.13',
    },
    allocatedDeviceIndices: [0],
    verifyExecutable: async p => p,
    commandRunner: async () => ({ exitCode: 0, stdout: rx7800JsonWithBanner, stderr: '' }),
    scrubber,
  });
  assert.equal(healthyRocm.healthy, true);
  assert.equal(healthyRocm.quarantineRequired, false);
  assert.equal(healthyRocm.vendor, 'amd');

  // 2b. AMD ROCm RAS uncorrectable error / GPU hang -> quarantineRequired
  const wedgedRocm = await probeAcceleratorHealth({
    probeMode: 'physical',
    capabilities: {
      accelerator: 'gfx942',
      isolationModes: ['whole_device'],
      deviceCount: 1,
      driverVersion: '6.8.5',
    },
    verifyExecutable: async p => p,
    commandRunner: async () => ({
      exitCode: 0,
      stdout: JSON.stringify({
        card0: {
          'Card Series': 'AMD Instinct MI300X',
          'GFX Version': 'gfx942',
          'UMC Uncorrectable Error': '2',
        },
      }),
      stderr: '',
    }),
    scrubber,
  });
  assert.equal(wedgedRocm.healthy, false);
  assert.equal(wedgedRocm.quarantineRequired, true);

  // 3a. Huawei Ascend NPU healthy vs Alarm health column -> quarantineRequired
  const healthyAscendOut = [
    '+------------------------------------------------------------------------------------------------+',
    '| npu-smi 24.1.0                   Version: 24.1.0                                               |',
    '+---------------------------+---------------+----------------------------------------------------+',
    '| 0     910B3               | OK            | 92.4        38                0    / 0             |',
    '+===========================+===============+====================================================+',
  ].join('\n');
  const okAscend = await probeAcceleratorHealth({
    probeMode: 'physical',
    capabilities: {
      accelerator: 'ascend_910b',
      isolationModes: ['whole_device'],
      deviceCount: 1,
      driverVersion: '24.1.0',
    },
    verifyExecutable: async p => p,
    commandRunner: async () => ({ exitCode: 0, stdout: healthyAscendOut, stderr: '' }),
    scrubber,
  });
  assert.equal(okAscend.healthy, true);
  assert.equal(okAscend.quarantineRequired, false);

  const alarmAscend = await probeAcceleratorHealth({
    probeMode: 'physical',
    capabilities: {
      accelerator: 'ascend_910b',
      isolationModes: ['whole_device'],
      deviceCount: 1,
      driverVersion: '24.1.0',
    },
    verifyExecutable: async p => p,
    commandRunner: async () => ({
      exitCode: 0,
      stdout: healthyAscendOut.replace('| OK            |', '| Alarm         |'),
      stderr: '',
    }),
    scrubber,
  });
  assert.equal(alarmAscend.healthy, false);
  assert.equal(alarmAscend.quarantineRequired, true);

  // 4. Unresponsive / timed-out probe runner returns probe_timeout with quarantineRequired: true
  const hungRunner: ProbeCommandRunner = async () => {
    throw new HardwareRunnerError('RUNNER_SANDBOX_FAILED', 'hardware probe failed or exceeded bounds: Command timed out (ETIMEDOUT)');
  };
  const timeoutProbe = await probeAcceleratorHealth({
    probeMode: 'physical',
    capabilities: {
      accelerator: 'sm_90a',
      isolationModes: ['whole_device'],
      deviceCount: 1,
      driverVersion: '550.90.07',
    },
    verifyExecutable: async p => p,
    commandRunner: hungRunner,
    scrubber,
  });
  assert.equal(timeoutProbe.healthy, false);
  assert.equal(timeoutProbe.quarantineRequired, true);
  assert.equal(timeoutProbe.faultKind, 'probe_timeout');
});

test('worker.ts post-crash GPU quarantine: runs healthProbe after Stage B crash BEFORE :complete and throws WORKER_DEVICE_QUARANTINED before a second /v1/runner/leases:acquire', async () => {
  const root = await mkdtemp(join(tmpdir(), 'lw-worker-quarantine-'));
  const casDir = join(root, 'cas');
  const workDir = join(root, 'work');
  const workloadsDir = join(root, 'workloads');
  await mkdir(workDir, { recursive: true, mode: 0o700 });
  await mkdir(join(workloadsDir, 'decode-holdout'), { recursive: true, mode: 0o700 });

  // Stage B simulates a faulty TMA/async kernel segfault (exit 139)
  await writeFile(
    join(workloadsDir, 'decode-holdout', 'evaluate.sh'),
    '#!/bin/sh\nexit 139\n',
    { mode: 0o755 },
  );

  const relay = await startRelayServer({
    port: 0,
    casDir,
    controllerSigningSecret: CONTROLLER_SECRET,
    workerTokens: [WORKER_TOKEN],
    leaseTtlMs: 10_000,
    sweepIntervalMs: 250,
  });

  try {
    const submitJob = async (opId: string): Promise<BenchmarkRequest> => {
      const buildScript = Buffer.from(
        `#!${process.execPath}\nrequire("node:fs").writeFileSync(process.env.LOOPWRIGHT_STAGE_A_OUT + "/k.cubin", "cubin");\n`,
        'utf8',
      );
      const buildSha = sha256Hex(buildScript);
      const putSig = signRelayPayload(CONTROLLER_SECRET, `PUT\n${opId}\n${buildSha}\n${buildScript.byteLength}`);
      const putRes = await fetch(`${relay.url}/v1/benchmark/jobs/${opId}/blobs/${buildSha}`, {
        method: 'PUT',
        headers: {
          'content-type': 'application/octet-stream',
          'x-loopwright-blob-sha256': buildSha,
          'x-loopwright-blob-length': String(buildScript.byteLength),
          'x-loopwright-signature': putSig,
        },
        body: new Uint8Array(buildScript),
      });
      assert.equal(putRes.status === 200 || putRes.status === 201, true);

      const lockHex = sha256Hex(`lock:${opId}`);
      const req: BenchmarkRequest = {
        version: 1,
        kind: 'benchmark_request',
        storeId: 'store-q',
        runId: 'run-q',
        lockHash: { algorithm: 'sha256', hex: lockHex },
        operationId: opId,
        dispatchId: `disp-${opId}`,
        dispatchGeneration: 1,
        requestDigest: sha256Hex(`req:${opId}`),
        gateId: 'sm90-gate',
        checkId: 'decode-bench',
        candidateDigest: buildSha,
        subject: {
          lockHash: { algorithm: 'sha256', hex: lockHex },
          contractHash: { algorithm: 'sha256', hex: lockHex },
          repository: 'org/kernels',
          baseRevision: '1'.repeat(40),
          sourceRevision: '1'.repeat(40),
          candidateDigest: { algorithm: 'sha256', hex: buildSha },
          targetMatrixDigest: null,
        },
        targetCellId: 'cuda-sm90',
        targetHardware: {
          accelerator: 'sm_90a',
          isolationMode: 'whole_device',
          deviceCount: 1,
        },
        heldOutWorkloadId: 'decode-holdout',
        metricThresholds: [],
        maxPreemptions: 3,
        candidateArtifacts: {
          entries: [
            {
              name: 'scripts/build.sh',
              digest: { algorithm: 'sha256', hex: buildSha },
              byteLength: buildScript.byteLength,
              mode: '100755',
            },
          ],
          deleted: [],
        },
      };
      const reqBytes = Buffer.from(canonicalJson(req), 'utf8');
      const submitRes = await fetch(`${relay.url}/v1/benchmark/jobs`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-loopwright-signature': signRelayPayload(CONTROLLER_SECRET, reqBytes),
        },
        body: new Uint8Array(reqBytes),
      });
      assert.equal(submitRes.status, 200);
      return req;
    };

    const pollVerdict = async (req: BenchmarkRequest): Promise<BenchmarkVerdict> => {
      const reqBytes = Buffer.from(canonicalJson(req), 'utf8');
      const res = await fetch(`${relay.url}/v1/benchmark/jobs`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-loopwright-signature': signRelayPayload(CONTROLLER_SECRET, reqBytes),
        },
        body: new Uint8Array(reqBytes),
      });
      assert.equal(res.status, 200);
      return (await res.json()) as BenchmarkVerdict;
    };

    // Enqueue TWO jobs back-to-back in the Relay queue!
    const req1 = await submitJob('verify.0.check.crash-xid-1');
    const req2 = await submitJob('verify.1.check.healthy-victim-2');

    const events: string[] = [];
    const settlements: WorkerJobSettlementSummary[] = [];
    let leasedCount = 0;

    // Run worker in CONTINUOUS mode (once: false)! Without quarantine it would immediately acquire req2!
    await assert.rejects(
      () =>
        runHardwareWorker({
          config: makeWorkerConfig(workDir, workloadsDir, { relayUrl: relay.url }),
          once: false,
          registerProcessSignalHandlers: false,
          onLeaseAcquired: grant => {
            leasedCount += 1;
            events.push(`lease:${grant.operationId}`);
          },
          healthProbe: async (): Promise<AcceleratorHealthProbeResult> => {
            // Verify req1 is STILL pending on Relay when healthProbe executes (strictly BEFORE :complete!)
            const midVerdict = await pollVerdict(req1);
            assert.equal(midVerdict.status, 'pending', 'healthProbe must execute BEFORE reporting :complete');
            events.push('health_probe');
            return {
              healthy: false,
              quarantineRequired: true,
              probeKind: 'physical',
              vendor: 'nvidia',
              checkedDeviceIndices: [0],
              faultKind: 'xid_error',
              summary: 'Sticky NVIDIA Xid 79 detected after Stage B crash',
              findings: [
                {
                  title: 'Accelerator sticky fault detected after Stage B failure',
                  severity: 'critical',
                  evidence: 'Sticky NVIDIA Xid 79 detected after Stage B crash',
                },
              ],
            };
          },
          onJobSettled: s => {
            events.push(`settled:${s.operationId}:${s.outcome}:${s.status ?? ''}`);
            settlements.push(s);
          },
        }),
      (err: unknown) => err instanceof HardwareRunnerError && err.code === 'WORKER_DEVICE_QUARANTINED',
    );

    // Worker acquired ONLY req1, ran healthProbe BEFORE settling req1 as denied, and NEVER acquired req2!
    assert.equal(leasedCount, 1, 'quarantined worker must NEVER acquire a second job from Relay');
    assert.deepEqual(events, [
      'lease:verify.0.check.crash-xid-1',
      'health_probe',
      'settled:verify.0.check.crash-xid-1:completed:denied',
    ]);
    assert.equal(settlements.length, 1);

    const v1 = await pollVerdict(req1);
    assert.equal(v1.status, 'denied');
    assert.equal(v1.reason, 'STAGE_B_EXECUTION_FAILED');
    assert.equal(v1.findings?.some(f => f.evidence.includes('Xid 79')), true);

    const v2 = await pollVerdict(req2);
    assert.equal(v2.status, 'pending', 'second healthy job in Relay queue must remain untouched for healthy workers');

    // External host GPU loss (externalHostLoss: true) preempts req2 cleanly so it requeues while still quarantining worker!
    let externalPreemptLeases = 0;
    await assert.rejects(
      () =>
        runHardwareWorker({
          config: makeWorkerConfig(workDir, workloadsDir, { relayUrl: relay.url, workerId: 'worker-ext-loss' }),
          once: false,
          registerProcessSignalHandlers: false,
          onLeaseAcquired: () => {
            externalPreemptLeases += 1;
          },
          healthProbe: async (): Promise<AcceleratorHealthProbeResult> => ({
            healthy: false,
            quarantineRequired: true,
            probeKind: 'physical',
            vendor: 'nvidia',
            checkedDeviceIndices: [0],
            faultKind: 'device_lost',
            externalHostLoss: true,
            summary: 'No devices were found on host bus',
            findings: [
              {
                title: 'External host accelerator loss',
                severity: 'critical',
                evidence: 'No devices were found on host bus',
              },
            ],
          }),
        }),
      (err: unknown) => err instanceof HardwareRunnerError && err.code === 'WORKER_DEVICE_QUARANTINED',
    );
    assert.equal(externalPreemptLeases, 1);
    const v2AfterPreempt = await pollVerdict(req2);
    assert.equal(v2AfterPreempt.status, 'pending');
    assert.equal(v2AfterPreempt.preemptionCount, 1);
  } finally {
    await relay.close();
    await rm(root, { recursive: true, force: true });
  }
});
