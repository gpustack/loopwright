import { execFile, spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import {
  constants,
  existsSync,
  lstatSync,
  readdirSync,
  readFileSync,
  realpathSync,
  statSync,
} from 'node:fs';
import { chmod, lstat, mkdir, open, readdir, realpath, rmdir, unlink } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve, sep } from 'node:path';
import type { Writable } from 'node:stream';
import { types } from 'node:util';
import {
  isVerifierNamespacePath,
  LIMITS,
  SecretScrubber,
  STAGE_A_STATIC_AUDIT_FAILED,
  validateBucketMetrics,
  validateHardwareDiagnostics,
  validateRelativePath,
  VERIFIER_ARTIFACT_LIMITS,
  type BucketMetricEntry,
  type FindingSeverity,
  type HardwareDiagnostics,
  type HardwareProvenance,
  type HardwareTargetSpec,
  type MetricThresholdRule,
  type MetricsMap,
  type MetricValue,
  type StructuredFinding,
} from '@loopwright/core';
import {
  LANDLOCK_BOOTSTRAP_SCRIPT,
  negotiateSandboxBackend,
  SECCOMP_BLOCKED_SYSCALLS,
  TaskpackError,
  TRUSTED_DOCKER_PATHS,
  type SandboxHostEnvironment,
  type SandboxPolicyInput,
} from '@loopwright/taskpack';
import {
  assertNoSymlinkAncestors,
  canonicalJson,
  expectNullProtoRecord,
  hasLoneSurrogate,
  parseStrictJsonBytes,
} from './config.js';
import {
  collectHardwareProvenance,
  snapshotHeldOutWorkload,
  verifyTrustedSystemExecutableSync,
  type CollectHardwareProvenanceOptions,
} from './provenance.js';
import {
  computeSecretScanOverlapBytes,
  EMPTY_SHA256_HEX,
  MAX_CAS_CHUNK_BYTES,
} from './relay-server.js';
import {
  HardwareRunnerError,
  type BenchmarkCandidateArtifacts,
  type BenchmarkOutputArtifact,
  type LeaseGrant,
  type StageAStaticAuditSpec,
  type WorkerConfig,
} from './types.js';

export const LWTREE01_MAGIC = 'LWTREE01' as const;
const BASE_TREE_BUNDLE_MAGIC = Buffer.from(LWTREE01_MAGIC, 'ascii');

// Cap Stage B stdout JSON envelope at 48 KiB so the worker's `:complete` control body
// (envelope + hardwareProvenance + outputArtifacts + lease credentials) stays within 64 KiB.
export const MAX_STAGE_B_RESULT_BYTES = 49_152;
export const MAX_STAGE_STDIO_BYTES = 1_048_576;
export const MAX_STAGE_A_AUDIT_SCAN_BYTES = 1_048_576;
export const STAGE_B_RESULT_MARKER_PREFIX = 'LOOPWRIGHT_STAGE_B_RESULT:' as const;

export const TRUSTED_NM_PATHS: readonly string[] = Object.freeze([
  '/usr/bin/nm',
  '/usr/local/bin/nm',
  '/bin/nm',
]);

export const TRUSTED_CUOBJDUMP_PATHS: readonly string[] = Object.freeze([
  '/usr/local/cuda/bin/cuobjdump',
  '/usr/bin/cuobjdump',
  '/usr/local/bin/cuobjdump',
]);

export class RunnerTeardownError extends HardwareRunnerError {
  readonly teardownFailed = true as const;
  readonly reasonCode = 'RUNNER_TEARDOWN_FAILED' as const;

  constructor(message: string, options?: ErrorOptions) {
    super('RUNNER_SANDBOX_FAILED', message, undefined, options);
    this.name = 'RunnerTeardownError';
  }
}

export function isRunnerTeardownError(err: unknown): boolean {
  return (
    err instanceof RunnerTeardownError
    || (err instanceof Error && (err as { readonly teardownFailed?: unknown }).teardownFailed === true)
  );
}

export const STAGE_A_CANDIDATE_ENTRYPOINTS: readonly string[] = Object.freeze([
  'benchmark/stage-a.sh',
  'scripts/stage-a.sh',
  'scripts/build.sh',
  'packages/build.sh',
  'build.sh',
]);

export const STAGE_B_WORKLOAD_ENTRYPOINTS: readonly string[] = Object.freeze([
  'stage-b.sh',
  'evaluate.sh',
  'benchmark.sh',
  'run.sh',
]);

const PRINTABLE_ASCII_RE = /^[\x20-\x7E]+$/;
const METRIC_KEY_RE = /^[A-Za-z_][A-Za-z0-9._-]*$/;
const FORBIDDEN_METRIC_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
const STAGE_B_ENVELOPE_KEYS: ReadonlySet<string> = new Set([
  'status',
  'reason',
  'detail',
  'metrics',
  'findings',
  'bucketMetrics',
  'hardwareDiagnostics',
]);
const FINDING_KEYS: ReadonlySet<string> = new Set(['title', 'severity', 'path', 'line', 'evidence']);

const MAX_TOOLCHAIN_SCAN_ENTRIES = 262_144;
const MAX_TOOLCHAIN_SCAN_DEPTH = 32;
const FORBIDDEN_MOUNT_ROOTS: readonly string[] = Object.freeze([
  '/',
  '/run',
  '/var/run',
  '/private/var/run',
  '/dev',
  '/proc',
  '/sys',
  '/tmp',
  '/private/tmp',
]);

// Linux x64 and arm64 syscall numbers for strict kernel-boundary socket + dangerous syscall denial.
const STRICT_SECCOMP_BLOCKED_X64: readonly number[] = Object.freeze([
  101, 246, 320, 165, 166, 155, 321, 298, 323, 250, 248, 249, 425, 426, 427,
  41,  // socket
  53,  // socketpair
  42,  // connect
  49,  // bind
  50,  // listen
  43,  // accept
  288, // accept4
]);

const STRICT_SECCOMP_BLOCKED_ARM64: readonly number[] = Object.freeze([
  117, 104, 294, 40, 39, 41, 280, 241, 282, 219, 217, 218, 425, 426, 427,
  198, // socket
  199, // socketpair
  203, // connect
  200, // bind
  201, // listen
  202, // accept
  242, // accept4
]);

export interface DecodedLwtreeEntry {
  readonly name: string;
  readonly mode: '100644' | '100755';
  readonly bytes: Uint8Array;
}

export interface SealedStageAArtifact {
  readonly artifact: BenchmarkOutputArtifact;
  readonly sealedFilePath: string;
}

export interface StageBResultEnvelope {
  readonly status: 'approved' | 'denied';
  readonly reason: string | null;
  readonly detail?: string | null;
  readonly metrics?: MetricsMap;
  readonly findings?: readonly StructuredFinding[];
  readonly bucketMetrics?: readonly BucketMetricEntry[];
  readonly hardwareDiagnostics?: HardwareDiagnostics;
}

export interface StageBFailureMetadata {
  readonly timedOut: boolean;
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
}

export type StageAAuditToolRunner = (
  tool: 'nm' | 'cuobjdump',
  executablePath: string,
  args: readonly string[],
  options: { readonly timeoutMs: number; readonly maxOutputBytes: number; readonly signal?: AbortSignal },
) => Promise<{ readonly exitCode: number; readonly stdout: string; readonly stderr: string }>;

export interface AuditSealedStageAOutputsOptions {
  readonly sealedOutputs: readonly SealedStageAArtifact[];
  readonly auditSpec: StageAStaticAuditSpec;
  readonly scrubber: SecretScrubber;
  readonly toolchainPaths?: readonly string[];
  readonly maxScanBytes?: number;
  readonly auditToolRunner?: StageAAuditToolRunner;
  readonly enableHostAuditTools?: boolean;
  readonly signal?: AbortSignal;
}

export interface StageAStaticAuditResult {
  readonly passed: boolean;
  readonly findings: readonly StructuredFinding[];
}

export interface DockerSandboxCompileInput {
  readonly stage: 'A' | 'B';
  readonly dockerImage: string;
  readonly containerName: string;
  readonly targetHardware: HardwareTargetSpec;
  readonly candidateDir?: string;
  readonly stageAOutDir: string;
  readonly workloadDir?: string;
  readonly toolchainPaths?: readonly string[];
  readonly forbiddenHostPaths?: readonly string[];
  readonly allocatedDeviceNodes?: readonly string[];
  readonly allocatedDeviceIndices?: readonly number[];
  readonly seccompProfilePath?: string;
  readonly containerUser?: { readonly uid: number; readonly gid: number };
  readonly sysfsRoot?: string;
  readonly devRoot?: string;
  readonly command: string;
  readonly args?: readonly string[];
  readonly cwd?: string;
  readonly env?: Readonly<Record<string, string>>;
  readonly host?: SandboxHostEnvironment;
  readonly signal?: AbortSignal;
  readonly leaseDeadlineMonoMs?: number;
  readonly getLeaseDeadlineMonoMs?: () => number;
  readonly nowMonotonicMs?: () => number;
  readonly _testOnlyTrustedDockerRoot?: string;
}

export interface CompiledDockerSandboxCommand {
  readonly executablePath: string;
  readonly containerName: string;
  readonly args: readonly string[];
}

export interface EvaluatedJobCleanupOptions {
  readonly preserveSealedOutputs?: boolean;
}

export interface EvaluatedBenchmarkJob {
  readonly status: 'approved' | 'denied';
  readonly reason: string | null;
  readonly detail?: string | null;
  readonly metrics?: MetricsMap;
  readonly findings?: readonly StructuredFinding[];
  readonly hardwareProvenance?: HardwareProvenance;
  readonly bucketMetrics?: readonly BucketMetricEntry[];
  readonly hardwareDiagnostics?: HardwareDiagnostics;
  readonly stageBFailure?: StageBFailureMetadata;
  readonly sealedOutputs: readonly SealedStageAArtifact[];
  cleanup(options?: EvaluatedJobCleanupOptions): Promise<void>;
}

export type BlobStreamDownloader = (
  sha256: string,
  expectedByteLength: number,
  onChunk: (chunk: Uint8Array) => Promise<void>,
) => Promise<void>;

export interface NativeTwoStageSandboxSpec {
  readonly stage: 'A' | 'B';
  readonly candidateDir?: string;
  readonly stageAOutDir: string;
  readonly workloadSnapshotDir?: string;
  readonly scratchDir: string;
  readonly toolchainPaths: readonly string[];
  readonly explicitDeniedReadPaths: readonly string[];
  readonly probeMode?: 'physical' | 'synthetic_fixture';
}

export interface StageProcessExecutionInput {
  readonly stage: 'A' | 'B';
  readonly backend: 'native_os' | 'docker';
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly env: Readonly<Record<string, string>>;
  readonly timeoutMs: number;
  readonly signal?: AbortSignal;
  readonly leaseDeadlineMonoMs?: number;
  readonly getLeaseDeadlineMonoMs?: () => number;
  readonly nowMonotonicMs?: () => number;
  readonly probeMode?: 'physical' | 'synthetic_fixture';
  readonly nativeStageSpec?: NativeTwoStageSandboxSpec;
  readonly dockerCompiled?: CompiledDockerSandboxCommand;
  readonly host?: SandboxHostEnvironment;
}

export interface StageProcessExecutionResult {
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly timedOut: boolean;
}

export interface EvaluateBenchmarkJobOptions {
  readonly config: WorkerConfig;
  readonly grant: LeaseGrant;
  readonly downloadInputBlob: BlobStreamDownloader;
  readonly signal?: AbortSignal;
  readonly leaseDeadlineMonoMs?: number;
  readonly getLeaseDeadlineMonoMs?: () => number;
  readonly nowMonotonicMs?: () => number;
  readonly maxBlobBytes?: number;
  readonly extraSecrets?: readonly string[];
  readonly host?: SandboxHostEnvironment;
  readonly allocatedDeviceNodes?: readonly string[];
  readonly allocatedDeviceIndices?: readonly number[];
  readonly sysfsRoot?: string;
  readonly devRoot?: string;
  readonly stageACommand?: { readonly command: string; readonly args?: readonly string[] };
  readonly stageBCommand?: { readonly command: string; readonly args?: readonly string[] };
  readonly probe?: (options: CollectHardwareProvenanceOptions) => Promise<HardwareProvenance>;
  readonly processRunner?: (input: StageProcessExecutionInput) => Promise<StageProcessExecutionResult>;
  readonly auditToolRunner?: StageAAuditToolRunner;
  readonly enableHostAuditTools?: boolean;
  readonly _testOnlyTrustedDockerRoot?: string;
}

export type BenchmarkJobEvaluator = (options: EvaluateBenchmarkJobOptions) => Promise<EvaluatedBenchmarkJob>;

function compareUtf16(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function pathsOverlap(pathA: string, pathB: string): boolean {
  if (pathA === pathB) return true;
  const prefixA = pathA === '/' ? '/' : `${pathA}${sep}`;
  const prefixB = pathB === '/' ? '/' : `${pathB}${sep}`;
  return pathA.startsWith(prefixB) || pathB.startsWith(prefixA);
}

function canonicalOrResolvedSync(rawPath: string): readonly string[] {
  const resolved = resolve(rawPath);
  const out = new Set<string>([resolved]);
  try {
    out.add(realpathSync(resolved));
  } catch {
    // Also canonicalize closest existing ancestor so non-existent leaf paths under /var -> /private/var match.
    let cur = dirname(resolved);
    const tail: string[] = [resolved.slice(cur.length).replace(/^[/\\]+/, '')];
    while (cur !== dirname(cur)) {
      try {
        const realParent = realpathSync(cur);
        out.add(join(realParent, ...tail.reverse()));
        break;
      } catch {
        const prev = cur;
        cur = dirname(cur);
        tail.push(prev.slice(cur.length).replace(/^[/\\]+/, ''));
      }
    }
  }
  return [...out];
}

function validateSafeRelativeArtifactPath(rawName: string, diagPath: string): string {
  if (typeof rawName !== 'string' || rawName.length < 1 || rawName.length > LIMITS.path || hasLoneSurrogate(rawName)) {
    throw new HardwareRunnerError('ARTIFACT_INVALID', 'invalid artifact relative path', diagPath);
  }
  const validated = validateRelativePath(rawName);
  if (
    !validated.ok
    || validated.value !== rawName
    || isVerifierNamespacePath(rawName)
    || rawName.split('/').some(seg => seg.toLowerCase() === '.git' || Buffer.byteLength(seg, 'utf8') > 255)
  ) {
    throw new HardwareRunnerError('ARTIFACT_INVALID', `disallowed artifact relative path "${rawName}"`, diagPath);
  }
  return rawName;
}

/**
 * Deterministic `LWTREE01` binary base-tree bundle encoder.
 */
export function encodeLwtree01Bundle(entries: readonly DecodedLwtreeEntry[]): Buffer {
  if (entries.length > LIMITS.baselineEntries) {
    throw new HardwareRunnerError('PAYLOAD_TOO_LARGE', 'LWTREE01 entry count exceeds baselineEntries limit');
  }
  const sorted = [...entries].sort((a, b) => compareUtf16(a.name, b.name));
  const seenFolded = new Set<string>();
  const parts: Buffer[] = [];
  const header = Buffer.allocUnsafe(12);
  BASE_TREE_BUNDLE_MAGIC.copy(header, 0);
  header.writeUInt32BE(sorted.length, 8);
  parts.push(header);

  let prevName: string | null = null;
  for (const item of sorted) {
    validateSafeRelativeArtifactPath(item.name, '/baseTreeBundle');
    if (prevName !== null && compareUtf16(prevName, item.name) >= 0) {
      throw new HardwareRunnerError('ARTIFACT_INVALID', 'duplicate LWTREE01 entry name');
    }
    prevName = item.name;
    const folded = item.name.normalize('NFC').toLowerCase();
    if (seenFolded.has(folded)) {
      throw new HardwareRunnerError('ARTIFACT_INVALID', 'case-colliding LWTREE01 entry path');
    }
    seenFolded.add(folded);

    const pathBuf = Buffer.from(item.name, 'utf8');
    const prefix = Buffer.allocUnsafe(4 + pathBuf.byteLength + 1 + 4);
    prefix.writeUInt32BE(pathBuf.byteLength, 0);
    pathBuf.copy(prefix, 4);
    prefix[4 + pathBuf.byteLength] = item.mode === '100755' ? 1 : 0;
    prefix.writeUInt32BE(item.bytes.byteLength, 4 + pathBuf.byteLength + 1);
    parts.push(prefix, Buffer.from(item.bytes));
  }

  for (const folded of seenFolded) {
    let slash = folded.indexOf('/');
    while (slash !== -1) {
      if (seenFolded.has(folded.slice(0, slash))) {
        throw new HardwareRunnerError('ARTIFACT_INVALID', 'file/directory prefix collision in LWTREE01 bundle');
      }
      slash = folded.indexOf('/', slash + 1);
    }
  }
  return Buffer.concat(parts);
}

/**
 * Bounded deterministic `LWTREE01` binary base-tree bundle decoder matching `@loopwright/controller`.
 */
export function decodeLwtree01Bundle(
  bytes: Uint8Array,
  maxBytes: number = VERIFIER_ARTIFACT_LIMITS.maxFileBytes,
): readonly DecodedLwtreeEntry[] {
  if (
    !(bytes instanceof Uint8Array)
    || types.isProxy(bytes)
    || types.isSharedArrayBuffer(bytes.buffer)
    || bytes.byteLength < 12
    || bytes.byteLength > maxBytes
  ) {
    throw new HardwareRunnerError('ARTIFACT_INVALID', 'invalid LWTREE01 bundle buffer bounds', '/baseTreeBundle');
  }
  if (!Buffer.from(bytes.buffer, bytes.byteOffset, 8).equals(BASE_TREE_BUNDLE_MAGIC)) {
    throw new HardwareRunnerError('ARTIFACT_INVALID', 'invalid LWTREE01 bundle magic header', '/baseTreeBundle');
  }

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const count = view.getUint32(8, false);
  if (count > LIMITS.baselineEntries) {
    throw new HardwareRunnerError('ARTIFACT_INVALID', 'LWTREE01 entry count exceeds maximum', '/baseTreeBundle');
  }

  const decoder = new TextDecoder('utf-8', { fatal: true });
  const entries: DecodedLwtreeEntry[] = [];
  const seenFolded = new Set<string>();
  let prevName: string | null = null;
  let offset = 12;

  for (let idx = 0; idx < count; idx += 1) {
    if (offset + 4 > bytes.byteLength) {
      throw new HardwareRunnerError('ARTIFACT_INVALID', 'truncated LWTREE01 path length', '/baseTreeBundle');
    }
    const pathLen = view.getUint32(offset, false);
    offset += 4;
    if (pathLen < 1 || pathLen > 4096 || offset + pathLen + 5 > bytes.byteLength) {
      throw new HardwareRunnerError('ARTIFACT_INVALID', 'invalid LWTREE01 entry framing', '/baseTreeBundle');
    }
    let name: string;
    try {
      name = decoder.decode(bytes.subarray(offset, offset + pathLen));
    } catch {
      throw new HardwareRunnerError('ARTIFACT_INVALID', 'non-UTF8 path in LWTREE01 bundle', '/baseTreeBundle');
    }
    offset += pathLen;

    validateSafeRelativeArtifactPath(name, `/baseTreeBundle/${idx}`);
    if (prevName !== null && compareUtf16(prevName, name) >= 0) {
      throw new HardwareRunnerError('ARTIFACT_INVALID', 'unsorted or duplicate LWTREE01 entry path', `/baseTreeBundle/${idx}`);
    }
    prevName = name;
    const folded = name.normalize('NFC').toLowerCase();
    if (seenFolded.has(folded)) {
      throw new HardwareRunnerError('ARTIFACT_INVALID', 'case-colliding LWTREE01 entry path', `/baseTreeBundle/${idx}`);
    }
    seenFolded.add(folded);

    const modeFlag = bytes[offset]!;
    offset += 1;
    if (modeFlag !== 0 && modeFlag !== 1) {
      throw new HardwareRunnerError('ARTIFACT_INVALID', 'invalid LWTREE01 modeFlag byte', `/baseTreeBundle/${idx}`);
    }

    const contentLen = view.getUint32(offset, false);
    offset += 4;
    if (contentLen > bytes.byteLength - offset) {
      throw new HardwareRunnerError('ARTIFACT_INVALID', 'truncated LWTREE01 entry payload', `/baseTreeBundle/${idx}`);
    }
    const content = bytes.slice(offset, offset + contentLen);
    offset += contentLen;

    entries.push(
      Object.freeze({
        name,
        mode: modeFlag === 1 ? '100755' : '100644',
        bytes: content,
      }),
    );
  }

  if (offset !== bytes.byteLength) {
    throw new HardwareRunnerError('ARTIFACT_INVALID', 'trailing bytes in LWTREE01 bundle', '/baseTreeBundle');
  }
  for (const folded of seenFolded) {
    let slash = folded.indexOf('/');
    while (slash !== -1) {
      if (seenFolded.has(folded.slice(0, slash))) {
        throw new HardwareRunnerError('ARTIFACT_INVALID', 'file/directory prefix collision in LWTREE01 bundle', '/baseTreeBundle');
      }
      slash = folded.indexOf('/', slash + 1);
    }
  }
  return Object.freeze(entries);
}

async function readExactFromHandle(
  handle: Awaited<ReturnType<typeof open>>,
  target: Buffer,
  length: number,
  fileOffset: number,
): Promise<void> {
  let filled = 0;
  while (filled < length) {
    const { bytesRead } = await handle.read(target, filled, length - filled, fileOffset + filled);
    if (bytesRead <= 0) {
      throw new HardwareRunnerError('ARTIFACT_INVALID', 'unexpected EOF while decoding LWTREE01 bundle', '/baseTreeBundle');
    }
    filled += bytesRead;
  }
}

async function writeAllToHandle(handle: Awaited<ReturnType<typeof open>>, bytes: Uint8Array): Promise<void> {
  let offset = 0;
  while (offset < bytes.byteLength) {
    const slice = bytes.subarray(offset, Math.min(bytes.byteLength, offset + MAX_CAS_CHUNK_BYTES));
    let sliceOffset = 0;
    while (sliceOffset < slice.byteLength) {
      const { bytesWritten } = await handle.write(slice, sliceOffset, slice.byteLength - sliceOffset);
      if (bytesWritten <= 0) {
        throw new HardwareRunnerError('RUNNER_SANDBOX_FAILED', 'short write while materializing candidate file');
      }
      sliceOffset += bytesWritten;
    }
    offset += slice.byteLength;
  }
}

async function ensureSafeSubdirectories(rootDir: string, relFilePath: string): Promise<string> {
  const segments = relFilePath.split('/');
  let cursor = rootDir;
  for (let i = 0; i < segments.length - 1; i += 1) {
    cursor = join(cursor, segments[i]!);
    const st = await lstat(cursor).catch((err: unknown) => {
      if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') return null;
      throw err;
    });
    if (st === null) {
      await mkdir(cursor, { mode: 0o755 });
      const created = await lstat(cursor);
      if (created.isSymbolicLink() || !created.isDirectory()) {
        throw new HardwareRunnerError('ARTIFACT_INVALID', 'symlink encountered while creating candidate directory');
      }
    } else if (st.isSymbolicLink() || !st.isDirectory()) {
      throw new HardwareRunnerError('ARTIFACT_INVALID', `file/directory collision or symlink at "${segments.slice(0, i + 1).join('/')}"`);
    }
  }
  return join(cursor, segments[segments.length - 1]!);
}

async function writeVerifiedFileNoFollow(
  rootDir: string,
  relPath: string,
  mode: '100644' | '100755',
  writer: (handle: Awaited<ReturnType<typeof open>>) => Promise<void>,
): Promise<void> {
  const targetAbs = await ensureSafeSubdirectories(rootDir, relPath);
  const existing = await lstat(targetAbs).catch((err: unknown) => {
    if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') return null;
    throw err;
  });
  if (existing !== null) {
    if (existing.isSymbolicLink() || !existing.isFile()) {
      throw new HardwareRunnerError('ARTIFACT_INVALID', `cannot overwrite symlink or directory at "${relPath}"`);
    }
    await unlink(targetAbs);
  }

  const noFollow = 'O_NOFOLLOW' in constants ? constants.O_NOFOLLOW : 0;
  const targetMode = mode === '100755' ? 0o755 : 0o644;
  const handle = await open(
    targetAbs,
    constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | noFollow,
    0o600,
  );
  try {
    await writer(handle);
    await handle.chmod(targetMode);
    const after = await handle.stat();
    if (!after.isFile() || after.isSymbolicLink() || after.nlink !== 1 || (after.mode & 0o777) !== targetMode) {
      throw new HardwareRunnerError('ARTIFACT_INVALID', `materialized candidate file "${relPath}" failed mode/nlink verification`);
    }
  } catch (err) {
    await handle.close().catch(() => {});
    await unlink(targetAbs).catch(() => {});
    throw err;
  }
  await handle.close();
}

async function decodeAndMaterializeLwtree01FromHandle(options: {
  readonly bundleHandle: Awaited<ReturnType<typeof open>>;
  readonly totalBytes: number;
  readonly maxBytes: number;
  readonly candidateDir: string;
  readonly signal?: AbortSignal;
}): Promise<void> {
  const { bundleHandle, totalBytes, maxBytes, candidateDir, signal } = options;
  if (totalBytes < 12 || totalBytes > maxBytes) {
    throw new HardwareRunnerError('ARTIFACT_INVALID', 'invalid LWTREE01 bundle buffer bounds', '/baseTreeBundle');
  }
  const headerBuf = Buffer.allocUnsafe(4105);
  await readExactFromHandle(bundleHandle, headerBuf, 12, 0);
  if (!headerBuf.subarray(0, 8).equals(BASE_TREE_BUNDLE_MAGIC)) {
    throw new HardwareRunnerError('ARTIFACT_INVALID', 'invalid LWTREE01 bundle magic header', '/baseTreeBundle');
  }
  const count = headerBuf.readUInt32BE(8);
  if (count > LIMITS.baselineEntries) {
    throw new HardwareRunnerError('ARTIFACT_INVALID', 'LWTREE01 entry count exceeds maximum', '/baseTreeBundle');
  }

  const decoder = new TextDecoder('utf-8', { fatal: true });
  const entryMeta: {
    readonly name: string;
    readonly mode: '100644' | '100755';
    readonly payloadOffset: number;
    readonly contentLen: number;
  }[] = [];
  const seenFolded = new Set<string>();
  let prevName: string | null = null;
  let offset = 12;

  // Pass 1: Validate all headers, ordering, collisions, and exact EOF without buffering file contents in RAM.
  for (let idx = 0; idx < count; idx += 1) {
    if (signal?.aborted) {
      throw new HardwareRunnerError('RUNNER_SANDBOX_FAILED', 'workspace reconstruction aborted');
    }
    if (offset + 4 > totalBytes) {
      throw new HardwareRunnerError('ARTIFACT_INVALID', 'truncated LWTREE01 path length', '/baseTreeBundle');
    }
    await readExactFromHandle(bundleHandle, headerBuf, 4, offset);
    const pathLen = headerBuf.readUInt32BE(0);
    offset += 4;
    if (pathLen < 1 || pathLen > 4096 || offset + pathLen + 5 > totalBytes) {
      throw new HardwareRunnerError('ARTIFACT_INVALID', 'invalid LWTREE01 entry framing', '/baseTreeBundle');
    }
    await readExactFromHandle(bundleHandle, headerBuf, pathLen + 5, offset);
    let name: string;
    try {
      name = decoder.decode(headerBuf.subarray(0, pathLen));
    } catch {
      throw new HardwareRunnerError('ARTIFACT_INVALID', 'non-UTF8 path in LWTREE01 bundle', '/baseTreeBundle');
    }
    validateSafeRelativeArtifactPath(name, `/baseTreeBundle/${idx}`);
    if (prevName !== null && compareUtf16(prevName, name) >= 0) {
      throw new HardwareRunnerError('ARTIFACT_INVALID', 'unsorted or duplicate LWTREE01 entry path', `/baseTreeBundle/${idx}`);
    }
    prevName = name;
    const folded = name.normalize('NFC').toLowerCase();
    if (seenFolded.has(folded)) {
      throw new HardwareRunnerError('ARTIFACT_INVALID', 'case-colliding LWTREE01 entry path', `/baseTreeBundle/${idx}`);
    }
    seenFolded.add(folded);

    const modeFlag = headerBuf[pathLen]!;
    if (modeFlag !== 0 && modeFlag !== 1) {
      throw new HardwareRunnerError('ARTIFACT_INVALID', 'invalid LWTREE01 modeFlag byte', `/baseTreeBundle/${idx}`);
    }
    const contentLen = headerBuf.readUInt32BE(pathLen + 1);
    const payloadOffset = offset + pathLen + 5;
    if (contentLen > totalBytes - payloadOffset) {
      throw new HardwareRunnerError('ARTIFACT_INVALID', 'truncated LWTREE01 entry payload', `/baseTreeBundle/${idx}`);
    }
    offset = payloadOffset + contentLen;
    entryMeta.push({
      name,
      mode: modeFlag === 1 ? '100755' : '100644',
      payloadOffset,
      contentLen,
    });
  }

  if (offset !== totalBytes) {
    throw new HardwareRunnerError('ARTIFACT_INVALID', 'trailing bytes in LWTREE01 bundle', '/baseTreeBundle');
  }
  for (const folded of seenFolded) {
    let slash = folded.indexOf('/');
    while (slash !== -1) {
      if (seenFolded.has(folded.slice(0, slash))) {
        throw new HardwareRunnerError('ARTIFACT_INVALID', 'file/directory prefix collision in LWTREE01 bundle', '/baseTreeBundle');
      }
      slash = folded.indexOf('/', slash + 1);
    }
  }

  // Pass 2: Materialize each entry using a single reusable <= 1 MiB copy buffer.
  const copyBuf = Buffer.allocUnsafe(MAX_CAS_CHUNK_BYTES);
  for (const item of entryMeta) {
    if (signal?.aborted) {
      throw new HardwareRunnerError('RUNNER_SANDBOX_FAILED', 'workspace reconstruction aborted');
    }
    await writeVerifiedFileNoFollow(candidateDir, item.name, item.mode, async dstHandle => {
      let remaining = item.contentLen;
      let readPos = item.payloadOffset;
      while (remaining > 0) {
        if (signal?.aborted) {
          throw new HardwareRunnerError('RUNNER_SANDBOX_FAILED', 'workspace reconstruction aborted');
        }
        const step = Math.min(copyBuf.byteLength, remaining);
        await readExactFromHandle(bundleHandle, copyBuf, step, readPos);
        await writeAllToHandle(dstHandle, copyBuf.subarray(0, step));
        readPos += step;
        remaining -= step;
      }
    });
  }
}

/**
 * Reconstruct the frozen candidate workspace inside `candidateDir` (`O_NOFOLLOW` verified) from
 * optional `LWTREE01` `baseTreeBundle` (streamed into a verified private file without full-buffer
 * RAM retention), `entries[]` CAS blobs, and `deleted[]` tombstones.
 */
export async function reconstructCandidateWorkspace(options: {
  readonly candidateDir: string;
  readonly candidateArtifacts: BenchmarkCandidateArtifacts;
  readonly downloadInputBlob: BlobStreamDownloader;
  readonly maxBlobBytes?: number;
  readonly signal?: AbortSignal;
}): Promise<void> {
  const { candidateDir, candidateArtifacts, downloadInputBlob } = options;
  const maxBlobBytes = options.maxBlobBytes ?? VERIFIER_ARTIFACT_LIMITS.maxFileBytes;
  const resolvedCandDir = resolve(candidateDir);
  await assertNoSymlinkAncestors(resolvedCandDir, {
    checkLeaf: true,
    code: 'RUNNER_SANDBOX_FAILED',
    diagPath: '/candidateDir',
  });
  await mkdir(resolvedCandDir, { recursive: true, mode: 0o755 });
  const dirStat = await lstat(resolvedCandDir);
  if (dirStat.isSymbolicLink() || !dirStat.isDirectory()) {
    throw new HardwareRunnerError('RUNNER_SANDBOX_FAILED', 'candidateDir must be a non-symlink directory');
  }

  if (candidateArtifacts.baseTreeBundle !== undefined) {
    const bundleMeta = candidateArtifacts.baseTreeBundle;
    if (bundleMeta.byteLength > maxBlobBytes) {
      throw new HardwareRunnerError('PAYLOAD_TOO_LARGE', 'baseTreeBundle exceeds maxBlobBytes');
    }
    const noFollow = 'O_NOFOLLOW' in constants ? constants.O_NOFOLLOW : 0;
    const tmpBundlePath = join(resolvedCandDir, `.lwtree-bundle-${randomBytes(12).toString('hex')}.tmp`);
    const bundleHandle = await open(
      tmpBundlePath,
      constants.O_CREAT | constants.O_EXCL | constants.O_RDWR | noFollow,
      0o600,
    );
    let primaryBundleErr: unknown = null;
    try {
      const createdSt = await bundleHandle.stat();
      if (!createdSt.isFile() || createdSt.isSymbolicLink() || createdSt.nlink !== 1) {
        throw new HardwareRunnerError('RUNNER_SANDBOX_FAILED', 'temporary baseTreeBundle file failed identity check');
      }
      let received = 0;
      const bundleHasher = createHash('sha256');
      await downloadInputBlob(bundleMeta.digest.hex, bundleMeta.byteLength, async slice => {
        if (options.signal?.aborted) {
          throw new HardwareRunnerError('RUNNER_SANDBOX_FAILED', 'workspace reconstruction aborted');
        }
        received += slice.byteLength;
        if (received > bundleMeta.byteLength || received > maxBlobBytes) {
          throw new HardwareRunnerError('ARTIFACT_INVALID', 'baseTreeBundle stream exceeded declared byteLength');
        }
        for (let off = 0; off < slice.byteLength; off += MAX_CAS_CHUNK_BYTES) {
          const sub = slice.subarray(off, Math.min(slice.byteLength, off + MAX_CAS_CHUNK_BYTES));
          bundleHasher.update(sub);
          await writeAllToHandle(bundleHandle, sub);
        }
      });
      if (received !== bundleMeta.byteLength || bundleHasher.digest('hex') !== bundleMeta.digest.hex) {
        throw new HardwareRunnerError('ARTIFACT_INVALID', 'baseTreeBundle failed sha256 or byteLength verification');
      }
      const verifiedSt = await bundleHandle.stat();
      if (verifiedSt.dev !== createdSt.dev || verifiedSt.ino !== createdSt.ino || verifiedSt.size !== received || verifiedSt.nlink !== 1) {
        throw new HardwareRunnerError('ARTIFACT_INVALID', 'temporary baseTreeBundle file mutated before decoding');
      }
      await decodeAndMaterializeLwtree01FromHandle({
        bundleHandle,
        totalBytes: received,
        maxBytes: maxBlobBytes,
        candidateDir: resolvedCandDir,
        ...(options.signal !== undefined ? { signal: options.signal } : {}),
      });
    } catch (err: unknown) {
      primaryBundleErr = err;
    } finally {
      await bundleHandle.close().catch(() => {});
    }

    let bundleCleanupErr: unknown = null;
    try {
      await unlink(tmpBundlePath).catch((err: unknown) => {
        if ((err as NodeJS.ErrnoException)?.code !== 'ENOENT') throw err;
      });
      const lingering = await lstat(tmpBundlePath).catch((err: unknown) => {
        if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') return null;
        throw err;
      });
      if (lingering !== null) {
        throw new HardwareRunnerError('RUNNER_SANDBOX_FAILED', 'failed to remove temporary baseTreeBundle file');
      }
    } catch (err: unknown) {
      bundleCleanupErr = err;
    }
    if (primaryBundleErr !== null) throw primaryBundleErr;
    if (bundleCleanupErr !== null) throw bundleCleanupErr;
  }

  for (const entry of candidateArtifacts.entries) {
    if (options.signal?.aborted) {
      throw new HardwareRunnerError('RUNNER_SANDBOX_FAILED', 'workspace reconstruction aborted');
    }
    const relName = validateSafeRelativeArtifactPath(entry.name, '/candidateArtifacts/entries');
    if (entry.byteLength > maxBlobBytes) {
      throw new HardwareRunnerError('PAYLOAD_TOO_LARGE', `candidate entry "${relName}" exceeds maxBlobBytes`);
    }
    if ((entry.byteLength === 0) !== (entry.digest.hex === EMPTY_SHA256_HEX)) {
      throw new HardwareRunnerError('ARTIFACT_INVALID', `candidate entry "${relName}" empty digest mismatch`);
    }
    const mode = entry.mode === '100755' ? '100755' : '100644';
    await writeVerifiedFileNoFollow(resolvedCandDir, relName, mode, async handle => {
      const hasher = createHash('sha256');
      let written = 0;
      await downloadInputBlob(entry.digest.hex, entry.byteLength, async slice => {
        if (options.signal?.aborted) {
          throw new HardwareRunnerError('RUNNER_SANDBOX_FAILED', 'workspace reconstruction aborted');
        }
        written += slice.byteLength;
        if (written > entry.byteLength || written > maxBlobBytes) {
          throw new HardwareRunnerError('ARTIFACT_INVALID', `candidate entry "${relName}" exceeded declared byteLength`);
        }
        hasher.update(slice);
        await writeAllToHandle(handle, slice);
      });
      if (written !== entry.byteLength || hasher.digest('hex') !== entry.digest.hex) {
        throw new HardwareRunnerError('ARTIFACT_INVALID', `candidate entry "${relName}" failed sha256 or byteLength check`);
      }
    });
  }

  for (const rawDel of candidateArtifacts.deleted) {
    const relDel = validateSafeRelativeArtifactPath(rawDel, '/candidateArtifacts/deleted');
    const segments = relDel.split('/');
    let cursor = resolvedCandDir;
    let missingParent = false;
    for (let i = 0; i < segments.length - 1; i += 1) {
      cursor = join(cursor, segments[i]!);
      const st = await lstat(cursor).catch((err: unknown) => {
        if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') return null;
        throw err;
      });
      if (st === null) {
        missingParent = true;
        break;
      }
      if (st.isSymbolicLink() || !st.isDirectory()) {
        throw new HardwareRunnerError('ARTIFACT_INVALID', `deleted path "${relDel}" traverses symlink or non-directory`);
      }
    }
    if (missingParent) continue;
    const leafPath = join(cursor, segments[segments.length - 1]!);
    const leafStat = await lstat(leafPath).catch((err: unknown) => {
      if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') return null;
      throw err;
    });
    if (leafStat === null) continue;
    if (leafStat.isSymbolicLink() || !leafStat.isFile()) {
      throw new HardwareRunnerError('ARTIFACT_INVALID', `deleted path "${relDel}" targets symlink or directory`);
    }
    await unlink(leafPath);
  }
}

interface MonotonicDeadlineChecker {
  readonly getDeadlineMonoMs: () => number;
  readonly nowMonotonicMs: () => number;
}

function resolveMonotonicDeadlineChecker(options: {
  readonly leaseDeadlineMonoMs?: number;
  readonly getLeaseDeadlineMonoMs?: () => number;
  readonly nowMonotonicMs?: () => number;
}): MonotonicDeadlineChecker | undefined {
  if (options.getLeaseDeadlineMonoMs === undefined && options.leaseDeadlineMonoMs === undefined) {
    return undefined;
  }
  const fixedDeadline = options.leaseDeadlineMonoMs;
  const getDeadlineMonoMs = options.getLeaseDeadlineMonoMs ?? (() => fixedDeadline!);
  const nowMonotonicMs = options.nowMonotonicMs ?? (() => performance.now());
  return { getDeadlineMonoMs, nowMonotonicMs };
}

function assertLeaseDeadlineNotExpired(
  checker: MonotonicDeadlineChecker | undefined,
  contextLabel: string,
  signal?: AbortSignal,
): void {
  if (checker !== undefined && checker.nowMonotonicMs() >= checker.getDeadlineMonoMs()) {
    throw new HardwareRunnerError('QUEUE_LEASE_FENCED', `local lease authority expired (${contextLabel})`);
  }
  if (signal?.aborted) {
    throw new HardwareRunnerError('RUNNER_SANDBOX_FAILED', `${contextLabel} aborted`);
  }
}

function isDockerSocketPath(p: string): boolean {
  const lower = p.toLowerCase();
  return lower.includes('docker.sock') || lower.includes('podman.sock') || lower.includes('containerd.sock');
}

function scanMountTreeForSocketsAndEscapesSync(
  canonicalMountRoot: string,
  forbiddenCanonicalRoots: readonly string[],
  deadlineChecker?: MonotonicDeadlineChecker,
  signal?: AbortSignal,
): void {
  assertLeaseDeadlineNotExpired(deadlineChecker, 'toolchain mount scan', signal);
  let scannedEntries = 0;
  const rootStat = lstatSync(canonicalMountRoot);
  if (rootStat.isSocket() || isDockerSocketPath(canonicalMountRoot)) {
    throw new HardwareRunnerError('RUNNER_SANDBOX_FAILED', `toolchain mount "${canonicalMountRoot}" must not be a socket`);
  }
  if (!rootStat.isDirectory() && !rootStat.isFile()) {
    throw new HardwareRunnerError('RUNNER_SANDBOX_FAILED', `toolchain mount "${canonicalMountRoot}" must be a directory or regular file`);
  }
  if (rootStat.isFile()) {
    return;
  }

  const walk = (dirPath: string, depth: number): void => {
    assertLeaseDeadlineNotExpired(deadlineChecker, 'toolchain mount scan', signal);
    if (depth > MAX_TOOLCHAIN_SCAN_DEPTH) {
      throw new HardwareRunnerError('RUNNER_SANDBOX_FAILED', `toolchain mount "${canonicalMountRoot}" exceeds scan depth limit`);
    }
    let dirents;
    try {
      dirents = readdirSync(dirPath, { withFileTypes: true });
    } catch {
      throw new HardwareRunnerError('RUNNER_SANDBOX_FAILED', `unable to inspect toolchain mount directory "${dirPath}"`);
    }
    for (const dirent of dirents) {
      scannedEntries += 1;
      if ((scannedEntries & 0xff) === 0) {
        assertLeaseDeadlineNotExpired(deadlineChecker, 'toolchain mount scan', signal);
      }
      if (scannedEntries > MAX_TOOLCHAIN_SCAN_ENTRIES) {
        throw new HardwareRunnerError(
          'RUNNER_SANDBOX_FAILED',
          `toolchain mount "${canonicalMountRoot}" exceeds ${MAX_TOOLCHAIN_SCAN_ENTRIES} scanned entries`,
        );
      }
      const entryPath = join(dirPath, dirent.name);
      if (isDockerSocketPath(entryPath) || dirent.isSocket()) {
        throw new HardwareRunnerError(
          'RUNNER_SANDBOX_FAILED',
          `toolchain mount "${canonicalMountRoot}" contains forbidden Unix socket "${entryPath}"`,
        );
      }
      if (dirent.isSymbolicLink()) {
        let resolvedLinkTarget: string;
        try {
          resolvedLinkTarget = realpathSync(entryPath);
        } catch {
          continue;
        }
        if (isDockerSocketPath(resolvedLinkTarget)) {
          throw new HardwareRunnerError(
            'RUNNER_SANDBOX_FAILED',
            `toolchain mount "${canonicalMountRoot}" contains symlink to container socket`,
          );
        }
        const targetStat = statSync(resolvedLinkTarget, { throwIfNoEntry: false });
        if (targetStat?.isSocket()) {
          throw new HardwareRunnerError(
            'RUNNER_SANDBOX_FAILED',
            `toolchain mount "${canonicalMountRoot}" contains symlink to Unix socket "${resolvedLinkTarget}"`,
          );
        }
        for (const forbidden of forbiddenCanonicalRoots) {
          if (pathsOverlap(resolvedLinkTarget, forbidden)) {
            throw new HardwareRunnerError(
              'RUNNER_SANDBOX_FAILED',
              `toolchain mount "${canonicalMountRoot}" contains symlink overlapping protected path "${forbidden}"`,
            );
          }
        }
        continue;
      }
      if (dirent.isDirectory()) {
        walk(entryPath, depth + 1);
        continue;
      }
      if (!dirent.isFile()) {
        const st = lstatSync(entryPath);
        if (st.isSocket()) {
          throw new HardwareRunnerError(
            'RUNNER_SANDBOX_FAILED',
            `toolchain mount "${canonicalMountRoot}" contains forbidden Unix socket "${entryPath}"`,
          );
        }
      }
    }
  };

  walk(canonicalMountRoot, 0);
  assertLeaseDeadlineNotExpired(deadlineChecker, 'toolchain mount scan', signal);
}

function validateAndCanonicalizeToolchainMountsSync(options: {
  readonly toolchainPaths: readonly string[];
  readonly forbiddenPaths: readonly string[];
  readonly requireExistingOnDisk: boolean;
  readonly deadlineChecker?: MonotonicDeadlineChecker;
  readonly signal?: AbortSignal;
}): readonly string[] {
  assertLeaseDeadlineNotExpired(options.deadlineChecker, 'toolchain mount validation', options.signal);
  const forbiddenExpanded = new Set<string>(FORBIDDEN_MOUNT_ROOTS);
  for (const fp of options.forbiddenPaths) {
    for (const v of canonicalOrResolvedSync(fp)) {
      forbiddenExpanded.add(v);
    }
  }
  const nonRootForbidden = [...forbiddenExpanded].filter(p => p !== '/');

  const canonicalToolchains: string[] = [];
  for (const rawTc of options.toolchainPaths) {
    assertLeaseDeadlineNotExpired(options.deadlineChecker, 'toolchain mount validation', options.signal);
    if (typeof rawTc !== 'string' || !isAbsolute(rawTc) || /[\0\r\n,"]/.test(rawTc) || hasLoneSurrogate(rawTc)) {
      throw new HardwareRunnerError('RUNNER_SANDBOX_FAILED', `invalid toolchain mount path "${String(rawTc)}"`);
    }
    if (isDockerSocketPath(rawTc)) {
      throw new HardwareRunnerError('RUNNER_SANDBOX_FAILED', 'mounting container runtime sockets is forbidden');
    }
    const resolvedTc = resolve(rawTc);
    if (FORBIDDEN_MOUNT_ROOTS.includes(resolvedTc)) {
      throw new HardwareRunnerError('RUNNER_SANDBOX_FAILED', `forbidden system root toolchain mount "${resolvedTc}"`);
    }

    const existsOnDisk = existsSync(resolvedTc);
    if (options.requireExistingOnDisk && !existsOnDisk) {
      throw new HardwareRunnerError('RUNNER_SANDBOX_FAILED', `configured toolchain path "${resolvedTc}" does not exist`);
    }

    const candidateVariants = canonicalOrResolvedSync(resolvedTc);
    const canonicalTc = existsOnDisk ? realpathSync(resolvedTc) : resolvedTc;
    if (FORBIDDEN_MOUNT_ROOTS.includes(canonicalTc)) {
      throw new HardwareRunnerError('RUNNER_SANDBOX_FAILED', `forbidden canonical toolchain mount "${canonicalTc}"`);
    }

    for (const variant of candidateVariants) {
      for (const forbidden of nonRootForbidden) {
        if (pathsOverlap(variant, forbidden)) {
          throw new HardwareRunnerError(
            'RUNNER_SANDBOX_FAILED',
            `toolchain mount "${rawTc}" overlaps protected or job-private path "${forbidden}"`,
          );
        }
      }
    }

    for (const prior of canonicalToolchains) {
      if (pathsOverlap(canonicalTc, prior)) {
        throw new HardwareRunnerError(
          'RUNNER_SANDBOX_FAILED',
          `overlapping toolchain mount paths "${canonicalTc}" and "${prior}" are forbidden`,
        );
      }
    }

    if (existsOnDisk) {
      scanMountTreeForSocketsAndEscapesSync(
        canonicalTc,
        nonRootForbidden,
        options.deadlineChecker,
        options.signal,
      );
    }
    canonicalToolchains.push(canonicalTc);
  }
  return Object.freeze(canonicalToolchains);
}

export function resolveTrustedDockerExecutable(
  host?: SandboxHostEnvironment,
  testOnlyTrustedRoot?: string,
): string {
  const probe = host?.probeExecutables ?? true;
  const verifyOpts = testOnlyTrustedRoot !== undefined ? { _testOnlyTrustedRoot: testOnlyTrustedRoot } : {};
  if (host?.dockerExecutable !== undefined) {
    const resolvedExplicit = resolve(host.dockerExecutable);
    const effectiveAllowlist =
      testOnlyTrustedRoot !== undefined
        ? [...TRUSTED_DOCKER_PATHS, resolvedExplicit]
        : TRUSTED_DOCKER_PATHS;
    if (!effectiveAllowlist.includes(resolvedExplicit)) {
      throw new HardwareRunnerError(
        'RUNNER_SANDBOX_FAILED',
        `untrusted docker executable "${host.dockerExecutable}"`,
      );
    }
    if (!probe && testOnlyTrustedRoot === undefined) {
      return resolvedExplicit;
    }
    return verifyTrustedSystemExecutableSync(resolvedExplicit, effectiveAllowlist, verifyOpts, 'docker');
  }
  if (!probe) {
    return TRUSTED_DOCKER_PATHS[0]!;
  }
  let lastErr: unknown = null;
  for (const candidate of TRUSTED_DOCKER_PATHS) {
    try {
      return verifyTrustedSystemExecutableSync(candidate, TRUSTED_DOCKER_PATHS, verifyOpts, 'docker');
    } catch (err: unknown) {
      lastErr = err;
    }
  }
  if (lastErr instanceof HardwareRunnerError) {
    throw lastErr;
  }
  throw new HardwareRunnerError('RUNNER_SANDBOX_FAILED', 'no trusted root-owned docker executable found on worker host');
}

function buildVisibleDevicesCsv(deviceCount: number): string {
  return Array.from({ length: deviceCount }, (_, idx) => String(idx)).join(',');
}

function validateExplicitDeviceIndices(
  explicitIndices: readonly number[],
  expectedCount: number,
  maxUpperExclusive = 64,
): readonly number[] {
  if (explicitIndices.length !== expectedCount) {
    throw new HardwareRunnerError(
      'RUNNER_SANDBOX_FAILED',
      `allocatedDeviceIndices count (${explicitIndices.length}) must equal deviceCount (${expectedCount})`,
    );
  }
  const seen = new Set<number>();
  const out: number[] = [];
  for (const idx of explicitIndices) {
    if (!Number.isSafeInteger(idx) || Object.is(idx, -0) || idx < 0 || idx >= maxUpperExclusive) {
      throw new HardwareRunnerError('RUNNER_SANDBOX_FAILED', `invalid allocated device index ${String(idx)}`);
    }
    if (seen.has(idx)) {
      throw new HardwareRunnerError('RUNNER_SANDBOX_FAILED', `duplicate allocated device index ${idx}`);
    }
    seen.add(idx);
    out.push(idx);
  }
  return Object.freeze(out);
}

function discoverHostRocmRenderMinorsSync(sysfsRoot: string): readonly number[] {
  const renderNodeRe = /^renderD([0-9]{1,6})$/;
  const discoveredMinors: number[] = [];

  // 1. Prefer KFD topology GPU nodes (drm_render_minor > 0), ordered by KFD node ID.
  const kfdNodesDir = join(sysfsRoot, 'class', 'kfd', 'kfd', 'topology', 'nodes');
  if (existsSync(kfdNodesDir)) {
    const nodeIds = readdirSync(kfdNodesDir)
      .filter(n => /^[0-9]+$/.test(n))
      .map(n => Number.parseInt(n, 10))
      .sort((a, b) => a - b);
    for (const id of nodeIds) {
      try {
        const props = readFileSync(join(kfdNodesDir, String(id), 'properties'), 'utf8');
        const m = /^drm_render_minor\s+([1-9][0-9]*)\s*$/m.exec(props);
        if (m !== null) {
          discoveredMinors.push(Number.parseInt(m[1]!, 10));
        }
      } catch {
        // Ignore unreadable topology node entry.
      }
    }
  }

  // 2. Fallback to /sys/class/drm/renderD* filtered to AMD vendor 0x1002.
  if (discoveredMinors.length === 0) {
    const sysDrmDir = join(sysfsRoot, 'class', 'drm');
    if (existsSync(sysDrmDir)) {
      const candidates = readdirSync(sysDrmDir)
        .map(name => renderNodeRe.exec(name))
        .filter((m): m is RegExpExecArray => m !== null)
        .map(m => Number.parseInt(m[1]!, 10))
        .sort((a, b) => a - b);
      for (const minor of candidates) {
        try {
          const vendor = readFileSync(join(sysDrmDir, `renderD${minor}`, 'device', 'vendor'), 'utf8').trim().toLowerCase();
          if (vendor === '0x1002') {
            discoveredMinors.push(minor);
          }
        } catch {
          // Ignore non-PCIe or unreadable DRM entry.
        }
      }
    }
  }

  return [...new Set(discoveredMinors)];
}

function resolveAllocatedRocmDevicesSync(options: {
  readonly deviceCount: number;
  readonly explicitNodes?: readonly string[];
  readonly explicitIndices?: readonly number[];
  readonly sysfsRoot?: string;
  readonly devRoot?: string;
  readonly verifyCharDevices: boolean;
  readonly requireIndexMapping?: boolean;
}): {
  readonly kfdPath: string;
  readonly renderNodes: readonly string[];
  readonly groupArgs: readonly string[];
  readonly deviceIndices?: readonly number[];
} {
  const devRoot = resolve(options.devRoot ?? '/dev');
  const sysfsRoot = resolve(options.sysfsRoot ?? '/sys');
  const kfdPath = join(devRoot, 'kfd');
  const renderNodeRe = /^renderD([0-9]{1,6})$/;
  const groupSet = new Set<string>();

  const assertCharDevice = (p: string): void => {
    let st;
    try {
      st = lstatSync(p);
    } catch {
      throw new HardwareRunnerError('RUNNER_SANDBOX_FAILED', `required ROCm device node "${p}" does not exist`);
    }
    if (st.isSymbolicLink() || !st.isCharacterDevice()) {
      throw new HardwareRunnerError('RUNNER_SANDBOX_FAILED', `ROCm device node "${p}" must be a non-symlink character device`);
    }
    if (st.gid > 0) {
      groupSet.add(String(st.gid));
    }
  };

  const uniqueMinors = discoverHostRocmRenderMinorsSync(sysfsRoot);

  if (options.explicitNodes !== undefined) {
    if (options.explicitNodes.length !== options.deviceCount) {
      throw new HardwareRunnerError(
        'RUNNER_SANDBOX_FAILED',
        `allocatedDeviceNodes count (${options.explicitNodes.length}) must equal deviceCount (${options.deviceCount})`,
      );
    }
    const seen = new Set<string>();
    const validated: string[] = [];
    const parsedMinors: number[] = [];
    for (const rawNode of options.explicitNodes) {
      if (typeof rawNode !== 'string' || !isAbsolute(rawNode) || /[\0\r\n,"]/.test(rawNode)) {
        throw new HardwareRunnerError('RUNNER_SANDBOX_FAILED', `invalid ROCm device node "${String(rawNode)}"`);
      }
      const resolvedNode = resolve(rawNode);
      const expectedDriDir = join(devRoot, 'dri');
      const leafName = resolvedNode.slice(expectedDriDir.length + 1);
      const minorMatch = renderNodeRe.exec(leafName);
      if (dirname(resolvedNode) !== expectedDriDir || minorMatch === null) {
        throw new HardwareRunnerError(
          'RUNNER_SANDBOX_FAILED',
          `ROCm device node "${rawNode}" must be an individual ${expectedDriDir}/renderD<N> node (never /dev/dri directory)`,
        );
      }
      if (seen.has(resolvedNode)) {
        throw new HardwareRunnerError('RUNNER_SANDBOX_FAILED', `duplicate ROCm device node "${resolvedNode}"`);
      }
      seen.add(resolvedNode);
      if (options.verifyCharDevices) {
        assertCharDevice(resolvedNode);
      }
      validated.push(resolvedNode);
      parsedMinors.push(Number.parseInt(minorMatch[1]!, 10));
    }

    let resolvedIndices: readonly number[] | undefined;
    if (uniqueMinors.length > 0) {
      const mapped = parsedMinors.map((minor, pos) => {
        const gpuIdx = uniqueMinors.indexOf(minor);
        if (gpuIdx < 0) {
          throw new HardwareRunnerError(
            'RUNNER_SANDBOX_FAILED',
            `allocated ROCm device node "${validated[pos]!}" could not be mapped to an AMD GPU in sysfs/KFD`,
          );
        }
        return gpuIdx;
      });
      if (options.explicitIndices !== undefined) {
        const checkedExplicit = validateExplicitDeviceIndices(options.explicitIndices, options.deviceCount, uniqueMinors.length);
        for (let i = 0; i < mapped.length; i += 1) {
          if (mapped[i] !== checkedExplicit[i]) {
            throw new HardwareRunnerError(
              'RUNNER_SANDBOX_FAILED',
              `allocatedDeviceNodes "${validated[i]!}" (GPU ${mapped[i]!}) conflicts with allocatedDeviceIndices (${checkedExplicit[i]!})`,
            );
          }
        }
      }
      resolvedIndices = Object.freeze(mapped);
    } else if (options.explicitIndices !== undefined) {
      resolvedIndices = validateExplicitDeviceIndices(options.explicitIndices, options.deviceCount, 64);
    } else if (options.requireIndexMapping === true) {
      throw new HardwareRunnerError(
        'RUNNER_SANDBOX_FAILED',
        'unable to map allocatedDeviceNodes to physical ROCm GPU indices via sysfs/KFD',
      );
    }

    if (options.verifyCharDevices) {
      assertCharDevice(kfdPath);
    } else {
      groupSet.add('video');
      groupSet.add('render');
    }
    const groupArgs: string[] = [];
    for (const grp of groupSet) {
      groupArgs.push('--group-add', grp);
    }
    return {
      kfdPath,
      renderNodes: validated,
      groupArgs,
      ...(resolvedIndices !== undefined ? { deviceIndices: resolvedIndices } : {}),
    };
  }

  if (options.verifyCharDevices) {
    assertCharDevice(kfdPath);
  }

  if (uniqueMinors.length < options.deviceCount) {
    throw new HardwareRunnerError(
      'RUNNER_SANDBOX_FAILED',
      `unable to isolate ${options.deviceCount} allocated ROCm renderD device node(s) on host (found ${uniqueMinors.length})`,
    );
  }

  const chosenIndices = options.explicitIndices !== undefined
    ? validateExplicitDeviceIndices(options.explicitIndices, options.deviceCount, uniqueMinors.length)
    : Object.freeze(Array.from({ length: options.deviceCount }, (_, idx) => idx));

  const renderNodes = chosenIndices.map(gpuIdx => {
    const minor = uniqueMinors[gpuIdx]!;
    const nodePath = join(devRoot, 'dri', `renderD${minor}`);
    if (options.verifyCharDevices) {
      assertCharDevice(nodePath);
    }
    return nodePath;
  });

  if (groupSet.size === 0) {
    groupSet.add('video');
    groupSet.add('render');
  }
  const groupArgs: string[] = [];
  for (const grp of groupSet) {
    groupArgs.push('--group-add', grp);
  }
  return { kfdPath, renderNodes, groupArgs, deviceIndices: chosenIndices };
}

/**
 * Deterministic Docker Stage B seccomp JSON profile denying `socket`, `socketpair`, `connect`,
 * `bind`, `listen`, `accept`, `accept4`, and privileged kernel syscalls with `EPERM` (`errnoRet: 1`).
 */
export function buildDockerStageBSeccompProfileJson(): string {
  const blockedNames = [
    ...SECCOMP_BLOCKED_SYSCALLS,
    'acct',
    'add_key',
    'clock_adjtime',
    'clock_settime',
    'delete_module',
    'finit_module',
    'init_module',
    'ioperm',
    'iopl',
    'kcmp',
    'lookup_dcookie',
    'move_pages',
    'name_to_handle_at',
    'open_by_handle_at',
    'personality',
    'process_vm_readv',
    'process_vm_writev',
    'quotactl',
    'reboot',
    'request_key',
    'setns',
    'settimeofday',
    'swapon',
    'swapoff',
    'syslog',
    'unshare',
    'uselib',
    'socket',
    'socketpair',
    'connect',
    'bind',
    'listen',
    'accept',
    'accept4',
  ];
  const uniqueNames = [...new Set(blockedNames)].sort(compareUtf16);
  return JSON.stringify({
    defaultAction: 'SCMP_ACT_ALLOW',
    syscalls: [
      {
        names: uniqueNames,
        action: 'SCMP_ACT_ERRNO',
        errnoRet: 1,
      },
    ],
  });
}

/**
 * Compile deterministic classic BPF `struct sock_filter` binary (`bwrap --seccomp <fd>`)
 * denying `socket`, `socketpair`, `connect`, `bind`, `listen`, `accept`, `accept4`, x32 ABI,
 * and all `SECCOMP_BLOCKED_SYSCALLS` at the Linux kernel boundary (`EPERM`).
 */
export function compileStrictSocketDenySeccompBpf(arch: string): Buffer {
  let auditArch: number;
  let blockedNrs: readonly number[];
  let blockX32Abi: boolean;
  if (arch === 'x64') {
    auditArch = 0xc000003e;
    blockedNrs = STRICT_SECCOMP_BLOCKED_X64;
    blockX32Abi = true;
  } else if (arch === 'arm64') {
    auditArch = 0xc00000b7;
    blockedNrs = STRICT_SECCOMP_BLOCKED_ARM64;
    blockX32Abi = false;
  } else {
    throw new HardwareRunnerError(
      'RUNNER_SANDBOX_FAILED',
      `unsupported Linux seccomp architecture "${arch}"`,
    );
  }

  const instructions: readonly (readonly [number, number, number, number])[] = [
    [0x20, 0, 0, 4],
    [0x15, 1, 0, auditArch],
    [0x06, 0, 0, 0x00050001],
    [0x20, 0, 0, 0],
    ...(blockX32Abi ? ([[0x35, blockedNrs.length + 1, 0, 0x40000000]] as const) : []),
    ...blockedNrs.map((nr, i): readonly [number, number, number, number] => [
      0x15,
      blockedNrs.length - i,
      0,
      nr,
    ]),
    [0x06, 0, 0, 0x7fff0000],
    [0x06, 0, 0, 0x00050001],
  ];

  const buf = Buffer.alloc(instructions.length * 8);
  for (let idx = 0; idx < instructions.length; idx += 1) {
    const [code, jt, jf, k] = instructions[idx]!;
    const off = idx * 8;
    buf.writeUInt16LE(code, off);
    buf.writeUInt8(jt, off + 2);
    buf.writeUInt8(jf, off + 3);
    buf.writeUInt32LE(k >>> 0, off + 4);
  }
  return buf;
}

/**
 * Compile hardened `docker run` arguments with `--network none`, `--read-only`, `--user <uid>:<gid>`,
 * disjoint socket-free mount trees, Stage B socket-denial seccomp, and exact allocated GPU/NPU devices.
 */
export function compileDockerSandboxCommand(input: DockerSandboxCompileInput): CompiledDockerSandboxCommand {
  const executablePath = resolveTrustedDockerExecutable(input.host, input._testOnlyTrustedDockerRoot);
  const probeHost = input.host?.probeExecutables ?? true;
  if (
    typeof input.dockerImage !== 'string'
    || input.dockerImage.length < 1
    || input.dockerImage.length > 256
    || input.dockerImage.startsWith('-')
    || /\s/.test(input.dockerImage)
    || !PRINTABLE_ASCII_RE.test(input.dockerImage)
  ) {
    throw new HardwareRunnerError('RUNNER_SANDBOX_FAILED', 'invalid dockerImage for hardware sandbox');
  }
  if (
    typeof input.containerName !== 'string'
    || !/^[A-Za-z0-9][A-Za-z0-9_.-]{1,120}$/.test(input.containerName)
  ) {
    throw new HardwareRunnerError('RUNNER_SANDBOX_FAILED', 'invalid docker containerName');
  }

  const stagePaths = [
    input.stageAOutDir,
    ...(input.candidateDir !== undefined ? [input.candidateDir] : []),
    ...(input.workloadDir !== undefined ? [input.workloadDir] : []),
  ];
  for (const p of stagePaths) {
    if (typeof p !== 'string' || !isAbsolute(p) || /[\0\r\n,"]/.test(p)) {
      throw new HardwareRunnerError('RUNNER_SANDBOX_FAILED', `invalid host mount path "${String(p)}" for docker sandbox`);
    }
    if (isDockerSocketPath(p)) {
      throw new HardwareRunnerError('RUNNER_SANDBOX_FAILED', 'mounting docker/container runtime sockets into candidate sandboxes is forbidden');
    }
  }

  const deadlineChecker = resolveMonotonicDeadlineChecker(input);
  const canonicalToolchains = validateAndCanonicalizeToolchainMountsSync({
    toolchainPaths: input.toolchainPaths ?? [],
    forbiddenPaths: [...stagePaths, ...(input.forbiddenHostPaths ?? [])],
    requireExistingOnDisk: probeHost,
    ...(deadlineChecker !== undefined ? { deadlineChecker } : {}),
    ...(input.signal !== undefined ? { signal: input.signal } : {}),
  });

  for (const arg of [input.command, ...(input.args ?? [])]) {
    if (typeof arg !== 'string' || /[\0\r\n]/.test(arg)) {
      throw new HardwareRunnerError('RUNNER_SANDBOX_FAILED', 'invalid command argument for docker sandbox');
    }
  }

  const uid = input.containerUser?.uid ?? (typeof process.getuid === 'function' ? process.getuid() : 0);
  const gid = input.containerUser?.gid ?? (typeof process.getgid === 'function' ? process.getgid() : 0);
  if (
    !Number.isSafeInteger(uid) || uid < 0 || uid > 4_294_967_294
    || !Number.isSafeInteger(gid) || gid < 0 || gid > 4_294_967_294
  ) {
    throw new HardwareRunnerError('RUNNER_SANDBOX_FAILED', 'invalid container UID/GID for docker sandbox');
  }

  const deviceCount = input.targetHardware.deviceCount ?? 1;
  if (!Number.isSafeInteger(deviceCount) || deviceCount < 1 || deviceCount > 64) {
    throw new HardwareRunnerError('RUNNER_SANDBOX_FAILED', 'invalid targetHardware.deviceCount for docker sandbox');
  }
  const visibleCsv = buildVisibleDevicesCsv(deviceCount);
  const accel = input.targetHardware.accelerator.toLowerCase();

  const gpuArgs: string[] = [];
  if (accel.startsWith('sm_')) {
    const selectedCuda = input.allocatedDeviceIndices !== undefined
      ? validateExplicitDeviceIndices(input.allocatedDeviceIndices, deviceCount, 64)
      : Array.from({ length: deviceCount }, (_, idx) => idx);
    const selectedCsv = selectedCuda.map(String).join(',');
    const gpuSpec = selectedCuda.length === 1 ? `device=${selectedCuda[0]!}` : `"device=${selectedCsv}"`;
    gpuArgs.push('--gpus', gpuSpec);
    gpuArgs.push('-e', `CUDA_VISIBLE_DEVICES=${visibleCsv}`);
  } else if (accel.startsWith('gfx')) {
    const rocmDevices = resolveAllocatedRocmDevicesSync({
      deviceCount,
      ...(input.allocatedDeviceNodes !== undefined ? { explicitNodes: input.allocatedDeviceNodes } : {}),
      ...(input.allocatedDeviceIndices !== undefined ? { explicitIndices: input.allocatedDeviceIndices } : {}),
      ...(input.sysfsRoot !== undefined ? { sysfsRoot: input.sysfsRoot } : {}),
      ...(input.devRoot !== undefined ? { devRoot: input.devRoot } : {}),
      verifyCharDevices: probeHost,
    });
    gpuArgs.push('--device', rocmDevices.kfdPath);
    for (const renderNode of rocmDevices.renderNodes) {
      gpuArgs.push('--device', renderNode);
    }
    gpuArgs.push(...rocmDevices.groupArgs);
    gpuArgs.push('-e', `ROCR_VISIBLE_DEVICES=${visibleCsv}`, '-e', `HIP_VISIBLE_DEVICES=${visibleCsv}`);
  } else if (accel.startsWith('ascend')) {
    const devRoot = resolve(input.devRoot ?? '/dev');
    const selectedAscend = input.allocatedDeviceIndices !== undefined
      ? validateExplicitDeviceIndices(input.allocatedDeviceIndices, deviceCount, 64)
      : Array.from({ length: deviceCount }, (_, idx) => idx);
    const ascendNodes = [
      ...selectedAscend.map(idx => join(devRoot, `davinci${idx}`)),
      join(devRoot, 'davinci_manager'),
      join(devRoot, 'devmm_svm'),
      join(devRoot, 'hisi_hdc'),
    ];
    if (probeHost) {
      for (const devNode of ascendNodes) {
        let st;
        try {
          st = lstatSync(devNode);
        } catch {
          throw new HardwareRunnerError('RUNNER_SANDBOX_FAILED', `required Ascend device node "${devNode}" does not exist`);
        }
        if (st.isSymbolicLink() || !st.isCharacterDevice()) {
          throw new HardwareRunnerError('RUNNER_SANDBOX_FAILED', `Ascend device node "${devNode}" is not a character device`);
        }
      }
    }
    for (const devNode of ascendNodes) {
      gpuArgs.push('--device', devNode);
    }
    gpuArgs.push('-e', `ASCEND_RT_VISIBLE_DEVICES=${visibleCsv}`);
  } else {
    throw new HardwareRunnerError(
      'RUNNER_SANDBOX_FAILED',
      `unsupported accelerator "${input.targetHardware.accelerator}" for docker GPU isolation`,
    );
  }

  const securityArgs: string[] = ['--security-opt', 'no-new-privileges:true'];
  if (
    typeof input.seccompProfilePath !== 'string'
    || !isAbsolute(input.seccompProfilePath)
    || /[\0\r\n,"]/.test(input.seccompProfilePath)
  ) {
    throw new HardwareRunnerError(
      'RUNNER_SANDBOX_FAILED',
      `Stage ${input.stage} docker sandbox requires an explicit socket-denial seccompProfilePath`,
    );
  }
  const resolvedSeccomp = resolve(input.seccompProfilePath);
  if (probeHost) {
    const st = lstatSync(resolvedSeccomp, { throwIfNoEntry: false });
    if (!st || st.isSymbolicLink() || !st.isFile()) {
      throw new HardwareRunnerError(
        'RUNNER_SANDBOX_FAILED',
        `Stage ${input.stage} seccomp profile must be an existing regular file`,
      );
    }
  }
  securityArgs.push('--security-opt', `seccomp=${resolvedSeccomp}`);

  const mountArgs: string[] = [];
  if (input.stage === 'A') {
    if (input.candidateDir === undefined) {
      throw new HardwareRunnerError('RUNNER_SANDBOX_FAILED', 'Stage A docker sandbox requires candidateDir');
    }
    if (input.workloadDir !== undefined) {
      throw new HardwareRunnerError('RUNNER_SANDBOX_FAILED', 'Stage A docker sandbox must NEVER mount held_out_workloads');
    }
    mountArgs.push('--mount', `type=bind,src=${resolve(input.candidateDir)},dst=/workspace/candidate,readonly`);
    mountArgs.push('--mount', `type=bind,src=${resolve(input.stageAOutDir)},dst=/workspace/stage-a-out`);
  } else {
    if (input.workloadDir === undefined) {
      throw new HardwareRunnerError('RUNNER_SANDBOX_FAILED', 'Stage B docker sandbox requires workloadDir');
    }
    if (input.candidateDir !== undefined) {
      throw new HardwareRunnerError('RUNNER_SANDBOX_FAILED', 'Stage B docker sandbox must not mount raw Stage A candidateDir');
    }
    mountArgs.push('--mount', `type=bind,src=${resolve(input.stageAOutDir)},dst=/workspace/stage-a-out,readonly`);
    mountArgs.push('--mount', `type=bind,src=${resolve(input.workloadDir)},dst=/workspace/workload,readonly`);
  }

  for (const resolvedTc of canonicalToolchains) {
    mountArgs.push('--mount', `type=bind,src=${resolvedTc},dst=${resolvedTc},readonly`);
  }

  const workdir = input.cwd ?? (input.stage === 'A' ? '/workspace/candidate' : '/workspace/workload');
  const envArgs: string[] = [];
  const mergedEnv: Record<string, string> = {
    HOME: '/scratch',
    TMPDIR: '/scratch',
    LANG: 'C.UTF-8',
    TERM: 'dumb',
    ...(input.env ?? {}),
  };
  for (const key of Object.keys(mergedEnv).sort()) {
    const val = mergedEnv[key]!;
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) || /[\0\r\n]/.test(val)) {
      throw new HardwareRunnerError('RUNNER_SANDBOX_FAILED', `invalid environment variable "${key}" for docker sandbox`);
    }
    envArgs.push('-e', `${key}=${val}`);
  }

  const args: string[] = [
    'run',
    '--rm',
    '--name', input.containerName,
    '--init',
    '--user', `${uid}:${gid}`,
    '--network', 'none',
    '--read-only',
    ...securityArgs,
    '--cap-drop', 'ALL',
    '--pids-limit', '512',
    '--ipc', 'private',
    '--tmpfs', '/scratch:rw,exec,nosuid,nodev,mode=1777,size=268435456',
    '--tmpfs', '/tmp:rw,nosuid,nodev,size=268435456',
    ...gpuArgs,
    ...mountArgs,
    ...envArgs,
    '--workdir', workdir,
    input.dockerImage,
    input.command,
    ...(input.args ?? []),
  ];

  return Object.freeze({
    executablePath,
    containerName: input.containerName,
    args: Object.freeze(args),
  });
}

function escapeSbplLiteral(p: string): string {
  if (/[\0\r\n"\\]/.test(p)) {
    throw new HardwareRunnerError('RUNNER_SANDBOX_FAILED', `unsafe path character for seatbelt profile "${p}"`);
  }
  return p;
}

function canonicalizeExistingOrParentSync(rawPath: string): string {
  const resolved = resolve(rawPath);
  try {
    return realpathSync(resolved);
  } catch {
    const parent = dirname(resolved);
    if (parent !== resolved) {
      try {
        return join(realpathSync(parent), resolved.slice(parent.length).replace(/^[/\\]+/, ''));
      } catch {
        return resolved;
      }
    }
    return resolved;
  }
}

function buildStrictSeatbeltStageProfile(spec: NativeTwoStageSandboxSpec): string {
  const stageAOutReal = canonicalizeExistingOrParentSync(spec.stageAOutDir);
  const scratchReal = canonicalizeExistingOrParentSync(spec.scratchDir);
  const candidateReal = spec.candidateDir !== undefined ? canonicalizeExistingOrParentSync(spec.candidateDir) : null;
  const workloadSnapReal = spec.workloadSnapshotDir !== undefined ? canonicalizeExistingOrParentSync(spec.workloadSnapshotDir) : null;

  if (spec.stage === 'A' && (candidateReal === null || workloadSnapReal !== null)) {
    throw new HardwareRunnerError('RUNNER_SANDBOX_FAILED', 'invalid Stage A native sandbox directory specification');
  }
  if (spec.stage === 'B' && (workloadSnapReal === null || candidateReal !== null)) {
    throw new HardwareRunnerError('RUNNER_SANDBOX_FAILED', 'invalid Stage B native sandbox directory specification');
  }

  const readSubpaths = new Set<string>([
    '/usr/bin',
    '/bin',
    '/sbin',
    '/usr/sbin',
    '/private/var/db/dyld',
    '/private/var/select',
    stageAOutReal,
    scratchReal,
  ]);
  const execMapSubpaths = new Set<string>([
    '/usr/bin',
    '/bin',
    '/sbin',
    '/usr/sbin',
    stageAOutReal,
    scratchReal,
  ]);

  if (candidateReal !== null) {
    readSubpaths.add(candidateReal);
    execMapSubpaths.add(candidateReal);
  }
  if (workloadSnapReal !== null) {
    readSubpaths.add(workloadSnapReal);
    execMapSubpaths.add(workloadSnapReal);
  }

  let allowHomebrewRuntime = false;
  for (const tc of spec.toolchainPaths) {
    const realTc = canonicalizeExistingOrParentSync(tc);
    readSubpaths.add(realTc);
    execMapSubpaths.add(realTc);
    if (realTc === '/opt/homebrew' || realTc.startsWith('/opt/homebrew/')) {
      allowHomebrewRuntime = true;
    }
  }
  if (allowHomebrewRuntime) {
    for (const hb of ['/opt/homebrew/Cellar', '/opt/homebrew/opt', '/opt/homebrew/lib', '/opt/homebrew/bin']) {
      readSubpaths.add(hb);
      execMapSubpaths.add(hb);
    }
  }

  const metadataLiterals = new Set<string>(['/', '/private', '/private/var', '/private/var/select', '/private/var/select/sh']);
  for (const p of readSubpaths) {
    let cur = dirname(p);
    while (cur && cur !== '/') {
      metadataLiterals.add(cur);
      const next = dirname(cur);
      if (next === cur) break;
      cur = next;
    }
  }

  const deniedExpanded = new Set<string>();
  for (const dp of spec.explicitDeniedReadPaths) {
    for (const v of canonicalOrResolvedSync(dp)) {
      deniedExpanded.add(v);
    }
  }

  const writableSubpaths = spec.stage === 'A'
    ? [stageAOutReal, scratchReal]
    : [scratchReal];

  const lines: string[] = [
    '(version 1)',
    '(deny default)',
    '(import "system.sb")',
    '(allow process-exec)',
    '(deny process-fork)',
    '(allow dynamic-code-generation)',
    '(allow process-info* (target same-sandbox))',
    '(allow signal (target same-sandbox))',
    '(allow file-map-executable',
    ...[...execMapSubpaths].sort(compareUtf16).map(p => `  (subpath "${escapeSbplLiteral(p)}")`),
    ')',
    '(allow file-read-metadata',
    ...[...metadataLiterals].sort(compareUtf16).map(p => `  (literal "${escapeSbplLiteral(p)}")`),
    ...(allowHomebrewRuntime ? ['  (subpath "/opt/homebrew")'] : []),
    ')',
    '(allow file-read*',
    ...[...readSubpaths].sort(compareUtf16).map(p => `  (subpath "${escapeSbplLiteral(p)}")`),
    ...(allowHomebrewRuntime ? ['  (regex #"^/opt/homebrew/etc/openssl")'] : []),
    ')',
    '(deny file-write*)',
    '(allow file-write*',
    '  (literal "/dev/null")',
    '  (literal "/dev/zero")',
    '  (literal "/dev/dtracehelper")',
    ...writableSubpaths.sort(compareUtf16).map(p => `  (subpath "${escapeSbplLiteral(p)}")`),
    ')',
  ];

  if (deniedExpanded.size > 0) {
    lines.push('(deny file-read*');
    for (const dp of [...deniedExpanded].sort(compareUtf16)) {
      lines.push(`  (subpath "${escapeSbplLiteral(dp)}")`);
    }
    lines.push(')');
  }

  lines.push('(deny network*)');
  return `${lines.join('\n')}\n`;
}

export const LINUX_BWRAP_IMPLICIT_RUNTIME_ROOTS: readonly string[] = Object.freeze([
  '/usr',
  '/bin',
  '/sbin',
  '/lib',
  '/lib32',
  '/lib64',
  '/etc/ld.so.cache',
  '/etc/ld.so.conf',
  '/etc/ld.so.conf.d',
  '/etc/alternatives',
]);

const LINUX_BWRAP_NARROW_USR_SUBPATHS: readonly string[] = Object.freeze([
  '/usr/bin',
  '/usr/sbin',
  '/usr/lib',
  '/usr/lib32',
  '/usr/lib64',
  '/usr/libexec',
  '/usr/include',
  '/usr/share',
  '/usr/x86_64-linux-gnu',
  '/usr/aarch64-linux-gnu',
  '/usr/local/bin',
  '/usr/local/lib',
  '/usr/local/lib64',
  '/usr/local/include',
]);

export function buildStrictLinuxBwrapArgs(
  spec: NativeTwoStageSandboxSpec,
  cwd: string,
  env: Readonly<Record<string, string>>,
  probeExecutables: boolean,
): readonly string[] {
  const stageAOutReal = canonicalizeExistingOrParentSync(spec.stageAOutDir);
  const scratchReal = canonicalizeExistingOrParentSync(spec.scratchDir);
  const candidateReal = spec.candidateDir !== undefined ? canonicalizeExistingOrParentSync(spec.candidateDir) : null;
  const workloadSnapReal = spec.workloadSnapshotDir !== undefined ? canonicalizeExistingOrParentSync(spec.workloadSnapshotDir) : null;

  if (spec.stage === 'A' && (candidateReal === null || workloadSnapReal !== null)) {
    throw new HardwareRunnerError('RUNNER_SANDBOX_FAILED', 'invalid Stage A linux-bwrap directory specification');
  }
  if (spec.stage === 'B' && (workloadSnapReal === null || candidateReal !== null)) {
    throw new HardwareRunnerError('RUNNER_SANDBOX_FAILED', 'invalid Stage B linux-bwrap directory specification');
  }

  // Reject ANY overlap (equal, ancestor, or descendant) between implicit runtime bind trees
  // (including /usr such as /usr/local/share/held-out) and protected or stage-private paths!
  const implicitVariants = new Set<string>();
  for (const rtRoot of LINUX_BWRAP_IMPLICIT_RUNTIME_ROOTS) {
    for (const v of canonicalOrResolvedSync(rtRoot)) {
      if (v !== '/') implicitVariants.add(v);
    }
  }
  const nonOverlappingPaths = [
    ...spec.explicitDeniedReadPaths,
    spec.stageAOutDir,
    spec.scratchDir,
    ...(spec.candidateDir !== undefined ? [spec.candidateDir] : []),
    ...(spec.workloadSnapshotDir !== undefined ? [spec.workloadSnapshotDir] : []),
  ];
  for (const rawProtected of nonOverlappingPaths) {
    for (const pv of canonicalOrResolvedSync(rawProtected)) {
      for (const iv of implicitVariants) {
        if (pathsOverlap(iv, pv)) {
          throw new HardwareRunnerError(
            'RUNNER_SANDBOX_FAILED',
            `linux-bwrap implicit runtime bind "${iv}" overlaps protected or job path "${pv}"`,
          );
        }
      }
    }
  }

  const args: string[] = [
    '--unshare-all',
    '--unshare-pid',
    '--die-with-parent',
    '--new-session',
    '--tmpfs', '/',
    '--proc', '/proc',
    '--dev', '/dev',
    '--tmpfs', '/tmp',
  ];

  // Bind only narrow system runtime subpaths (never wholesale /usr or /usr/local/share).
  for (const usrSub of LINUX_BWRAP_NARROW_USR_SUBPATHS) {
    if (!probeExecutables || existsSync(usrSub)) {
      args.push('--ro-bind-try', usrSub, usrSub);
    }
  }

  const optionalSystemRo = [
    '/bin',
    '/sbin',
    '/lib',
    '/lib32',
    '/lib64',
    '/etc/ld.so.cache',
    '/etc/ld.so.conf',
    '/etc/ld.so.conf.d',
    '/etc/alternatives',
    '/etc/ssl/openssl.cnf',
    '/etc/ssl/certs',
    '/etc/ca-certificates',
    '/etc/pki/ca-trust',
    '/etc/pki/tls/certs',
    '/etc/pki/tls/cacerts',
    '/etc/pki/tls/openssl.cnf',
  ];
  for (const sysPath of optionalSystemRo) {
    if (!probeExecutables || existsSync(sysPath)) {
      args.push('--ro-bind-try', sysPath, sysPath);
    }
  }

  for (const tc of spec.toolchainPaths) {
    const realTc = canonicalizeExistingOrParentSync(tc);
    args.push('--ro-bind', realTc, realTc);
  }

  if (spec.stage === 'A') {
    args.push('--ro-bind', candidateReal!, candidateReal!);
    args.push('--bind', stageAOutReal, stageAOutReal);
    args.push('--bind', scratchReal, scratchReal);
  } else {
    args.push('--ro-bind', stageAOutReal, stageAOutReal);
    args.push('--ro-bind', workloadSnapReal!, workloadSnapReal!);
    args.push('--bind', scratchReal, scratchReal);
  }

  const canonicalCwd = canonicalizeExistingOrParentSync(cwd);
  args.push('--chdir', canonicalCwd, '--clearenv');

  const safeEnv: Record<string, string> = {
    HOME: scratchReal,
    TMPDIR: scratchReal,
    PATH: '/usr/local/bin:/usr/bin:/bin',
    LANG: 'C.UTF-8',
    TERM: 'dumb',
    ...env,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_TERMINAL_PROMPT: '0',
  };
  for (const key of Object.keys(safeEnv).sort(compareUtf16)) {
    const val = safeEnv[key]!;
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) || /[\0\r\n]/.test(val)) {
      throw new HardwareRunnerError('RUNNER_SANDBOX_FAILED', `invalid environment variable "${key}" for linux-bwrap`);
    }
    args.push('--setenv', key, val);
  }

  return Object.freeze(args);
}

const LINUX_LANDLOCK_POSITIVE_READ_ROOTS: readonly string[] = Object.freeze([
  ...LINUX_BWRAP_NARROW_USR_SUBPATHS,
  '/bin',
  '/sbin',
  '/lib',
  '/lib32',
  '/lib64',
  '/etc/ld.so.cache',
  '/etc/ld.so.conf',
  '/etc/ld.so.conf.d',
  '/etc/alternatives',
  '/etc/ssl/openssl.cnf',
  '/etc/ssl/certs',
  '/etc/ca-certificates',
  '/etc/pki/ca-trust',
  '/etc/pki/tls/certs',
  '/etc/pki/tls/cacerts',
  '/etc/pki/tls/openssl.cnf',
  '/etc/localtime',
  '/proc/cpuinfo',
  '/proc/meminfo',
  '/proc/stat',
  '/proc/version',
  '/proc/sys/kernel/random',
  '/dev/urandom',
  '/sys/devices/system/cpu',
]);

export function buildStrictLinuxLandlockConfig(
  spec: NativeTwoStageSandboxSpec,
  cwd: string,
  env: Readonly<Record<string, string>>,
): string {
  const stageAOutReal = canonicalizeExistingOrParentSync(spec.stageAOutDir);
  const scratchReal = canonicalizeExistingOrParentSync(spec.scratchDir);
  const candidateReal = spec.candidateDir !== undefined ? canonicalizeExistingOrParentSync(spec.candidateDir) : null;
  const workloadSnapReal = spec.workloadSnapshotDir !== undefined ? canonicalizeExistingOrParentSync(spec.workloadSnapshotDir) : null;

  if (spec.stage === 'A' && (candidateReal === null || workloadSnapReal !== null)) {
    throw new HardwareRunnerError('RUNNER_SANDBOX_FAILED', 'invalid Stage A linux-landlock directory specification');
  }
  if (spec.stage === 'B' && (workloadSnapReal === null || candidateReal !== null)) {
    throw new HardwareRunnerError('RUNNER_SANDBOX_FAILED', 'invalid Stage B linux-landlock directory specification');
  }

  const implicitVariants = new Set<string>();
  for (const rtRoot of LINUX_BWRAP_IMPLICIT_RUNTIME_ROOTS) {
    for (const v of canonicalOrResolvedSync(rtRoot)) {
      if (v !== '/') implicitVariants.add(v);
    }
  }
  const nonOverlappingPaths = [
    ...spec.explicitDeniedReadPaths,
    spec.stageAOutDir,
    spec.scratchDir,
    ...(spec.candidateDir !== undefined ? [spec.candidateDir] : []),
    ...(spec.workloadSnapshotDir !== undefined ? [spec.workloadSnapshotDir] : []),
  ];
  for (const rawProtected of nonOverlappingPaths) {
    for (const pv of canonicalOrResolvedSync(rawProtected)) {
      for (const iv of implicitVariants) {
        if (pathsOverlap(iv, pv)) {
          throw new HardwareRunnerError(
            'RUNNER_SANDBOX_FAILED',
            `linux-landlock implicit runtime bind "${iv}" overlaps protected or job path "${pv}"`,
          );
        }
      }
    }
  }

  const allowedReadOnlyPaths: string[] = [];
  for (const tc of spec.toolchainPaths) {
    allowedReadOnlyPaths.push(canonicalizeExistingOrParentSync(tc));
  }
  const writablePaths: string[] = [];
  if (spec.stage === 'A') {
    allowedReadOnlyPaths.push(candidateReal!);
    writablePaths.push(stageAOutReal, scratchReal);
  } else {
    allowedReadOnlyPaths.push(stageAOutReal, workloadSnapReal!);
    writablePaths.push(scratchReal);
  }

  const deniedReadPaths = new Set<string>();
  for (const dp of spec.explicitDeniedReadPaths) {
    for (const v of canonicalOrResolvedSync(dp)) {
      deniedReadPaths.add(v);
    }
  }

  const safeEnv: Record<string, string> = {
    HOME: scratchReal,
    TMPDIR: scratchReal,
    PATH: '/usr/local/bin:/usr/bin:/bin',
    LANG: 'C.UTF-8',
    TERM: 'dumb',
    ...env,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_TERMINAL_PROMPT: '0',
  };
  for (const key of Object.keys(safeEnv).sort(compareUtf16)) {
    const val = safeEnv[key]!;
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) || /[\0\r\n]/.test(val)) {
      throw new HardwareRunnerError('RUNNER_SANDBOX_FAILED', `invalid environment variable "${key}" for linux-landlock`);
    }
  }

  const canonicalCwd = canonicalizeExistingOrParentSync(cwd);
  return JSON.stringify({
    workspaceRoot: canonicalCwd,
    positiveReadRoots: [...LINUX_LANDLOCK_POSITIVE_READ_ROOTS],
    writablePaths,
    exactWritableFiles: [],
    protectedPaths: [],
    deniedReadPaths: [...deniedReadPaths].sort(compareUtf16),
    allowedReadOnlyPaths: [...new Set(allowedReadOnlyPaths)].sort(compareUtf16),
    networkMode: 'none',
    blockAllSockets: true,
    cwd: canonicalCwd,
    env: safeEnv,
  });
}

export interface PreparedStageSandboxInvocation {
  readonly executablePath: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly seccompBpf: Buffer | null;
  readonly dockerCleanupInfo: { readonly executablePath: string; readonly containerName: string } | null;
  cleanup(): void;
}

export function prepareStageSandboxInvocation(input: StageProcessExecutionInput): PreparedStageSandboxInvocation {
  if (input.backend === 'docker') {
    if (input.dockerCompiled === undefined) {
      throw new HardwareRunnerError('RUNNER_SANDBOX_FAILED', 'missing compiled docker command');
    }
    return Object.freeze({
      executablePath: input.dockerCompiled.executablePath,
      args: input.dockerCompiled.args,
      cwd: '/',
      seccompBpf: null,
      dockerCleanupInfo: Object.freeze({
        executablePath: input.dockerCompiled.executablePath,
        containerName: input.dockerCompiled.containerName,
      }),
      cleanup: () => undefined,
    });
  }

  const effectiveProbeMode = input.probeMode ?? input.nativeStageSpec?.probeMode;
  if (effectiveProbeMode === 'physical') {
    throw new HardwareRunnerError(
      'RUNNER_SANDBOX_FAILED',
      'native_os sandbox backend cannot enforce isolated physical accelerator device allocation; docker backend is required',
    );
  }

  const stageSpec = input.nativeStageSpec;
  if (stageSpec === undefined) {
    throw new HardwareRunnerError('RUNNER_SANDBOX_FAILED', 'missing native OS stage sandbox specification');
  }

  const platform = input.host?.platform ?? process.platform;
  const arch = input.host?.arch ?? process.arch;
  const preferredBackends = platform === 'darwin'
    ? (['macos-seatbelt'] as const)
    : platform === 'linux'
      ? (['linux-bwrap', 'linux-landlock'] as const)
      : [];
  if (preferredBackends.length === 0) {
    throw new HardwareRunnerError(
      'RUNNER_SANDBOX_FAILED',
      `native_os sandbox backend is unsupported on platform "${platform}"`,
    );
  }

  const probePolicy: SandboxPolicyInput = {
    workspaceRoot: resolve(stageSpec.scratchDir),
    writablePaths: ['work'],
    networkMode: 'none',
    preferredBackends,
  };

  let negotiated;
  try {
    negotiated = negotiateSandboxBackend(probePolicy, input.host);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : 'sandbox negotiation failed';
    throw new HardwareRunnerError('RUNNER_SANDBOX_FAILED', msg);
  }

  const deadlineChecker = resolveMonotonicDeadlineChecker(input);
  assertLeaseDeadlineNotExpired(deadlineChecker, `Stage ${input.stage} sandbox preparation`, input.signal);

  const probeExecutables = input.host?.probeExecutables ?? true;
  const canonicalToolchains = validateAndCanonicalizeToolchainMountsSync({
    toolchainPaths: stageSpec.toolchainPaths,
    forbiddenPaths: [
      stageSpec.stageAOutDir,
      stageSpec.scratchDir,
      ...(stageSpec.candidateDir !== undefined ? [stageSpec.candidateDir] : []),
      ...(stageSpec.workloadSnapshotDir !== undefined ? [stageSpec.workloadSnapshotDir] : []),
      ...stageSpec.explicitDeniedReadPaths,
    ],
    requireExistingOnDisk: probeExecutables,
    ...(deadlineChecker !== undefined ? { deadlineChecker } : {}),
    ...(input.signal !== undefined ? { signal: input.signal } : {}),
  });

  const normalizedSpec: NativeTwoStageSandboxSpec = {
    ...stageSpec,
    toolchainPaths: canonicalToolchains,
  };

  if (negotiated.backendId === 'macos-seatbelt') {
    const profileText = buildStrictSeatbeltStageProfile(normalizedSpec);
    const canonicalCwd = canonicalizeExistingOrParentSync(input.cwd);
    return Object.freeze({
      executablePath: negotiated.executablePath!,
      args: Object.freeze(['-p', profileText, '--', input.command, ...input.args]),
      cwd: canonicalCwd,
      seccompBpf: null,
      dockerCleanupInfo: null,
      cleanup: () => undefined,
    });
  }

  if (negotiated.backendId === 'linux-bwrap') {
    const bwrapArgs = buildStrictLinuxBwrapArgs(normalizedSpec, input.cwd, input.env, probeExecutables);
    const seccompBpf = compileStrictSocketDenySeccompBpf(arch);
    return Object.freeze({
      executablePath: negotiated.executablePath!,
      args: Object.freeze([...bwrapArgs, '--seccomp', '3', '--', input.command, ...input.args]),
      cwd: '/',
      seccompBpf,
      dockerCleanupInfo: null,
      cleanup: () => undefined,
    });
  }

  if (negotiated.backendId === 'linux-landlock') {
    const landlockConfig = buildStrictLinuxLandlockConfig(normalizedSpec, input.cwd, input.env);
    return Object.freeze({
      executablePath: negotiated.executablePath!,
      args: Object.freeze(['-I', '-S', '-B', '-c', LANDLOCK_BOOTSTRAP_SCRIPT, landlockConfig, input.command, ...input.args]),
      cwd: '/',
      seccompBpf: null,
      dockerCleanupInfo: null,
      cleanup: () => undefined,
    });
  }

  throw new HardwareRunnerError(
    'RUNNER_SANDBOX_FAILED',
    `unexpected negotiated native sandbox backend "${negotiated.backendId}"`,
  );
}

const SANITIZED_DOCKER_CLEANUP_ENV: Readonly<Record<string, string>> = Object.freeze({
  PATH: '/usr/local/bin:/usr/bin:/bin',
  LANG: 'C',
  LC_ALL: 'C',
});

export function runSanitizedDockerRmForce(
  executablePath: string,
  containerName: string,
  options: { readonly timeoutMs?: number } = {},
): Promise<void> {
  const timeoutMs = options.timeoutMs ?? 10_000;
  return new Promise<void>((resolveRm, rejectRm) => {
    execFile(
      executablePath,
      ['rm', '-f', containerName],
      {
        shell: false,
        cwd: '/',
        env: { ...SANITIZED_DOCKER_CLEANUP_ENV },
        timeout: timeoutMs,
        maxBuffer: 65_536,
        killSignal: 'SIGKILL',
        windowsHide: true,
      },
      (error, stdout, stderr) => {
        if (error !== null) {
          const errno = error as NodeJS.ErrnoException & { killed?: boolean; code?: number | string; signal?: NodeJS.Signals | null };
          const combined = `${String(stderr ?? '')}\n${String(stdout ?? '')}`;
          if (
            !errno.killed
            && errno.code !== 'ETIMEDOUT'
            && errno.signal == null
            && typeof errno.code === 'number'
            && /no such container/i.test(combined)
          ) {
            resolveRm();
            return;
          }
          rejectRm(
            new RunnerTeardownError(
              `docker rm -f "${containerName}" failed to confirm container teardown: ${error.message}`,
            ),
          );
          return;
        }
        resolveRm();
      },
    );
  });
}

function isProcessGroupAlive(pgid: number): boolean {
  if (pgid <= 0) return false;
  try {
    process.kill(-pgid, 0);
    return true;
  } catch (err: unknown) {
    return (err as NodeJS.ErrnoException)?.code === 'EPERM';
  }
}

export async function waitForProcessGroupExit(
  pgid: number,
  maxWaitMs = 2_000,
  probeGroupAlive: (groupId: number) => boolean = isProcessGroupAlive,
): Promise<void> {
  if (pgid <= 0) return;
  const deadline = performance.now() + maxWaitMs;
  while (probeGroupAlive(pgid) && performance.now() < deadline) {
    try {
      process.kill(-pgid, 'SIGKILL');
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException)?.code === 'ESRCH' && !probeGroupAlive(pgid)) {
        break;
      }
    }
    await new Promise<void>(r => {
      const t = setTimeout(r, 15);
      t.unref();
    });
  }
  if (probeGroupAlive(pgid)) {
    throw new RunnerTeardownError(
      `process group ${pgid} remained alive after ${maxWaitMs}ms SIGKILL teardown`,
    );
  }
}

async function defaultStageProcessRunner(input: StageProcessExecutionInput): Promise<StageProcessExecutionResult> {
  const deadlineChecker = resolveMonotonicDeadlineChecker(input);
  assertLeaseDeadlineNotExpired(deadlineChecker, `Stage ${input.stage} pre-prepare`, input.signal);
  if (!Number.isSafeInteger(input.timeoutMs) || input.timeoutMs < 50 || input.timeoutMs > 3_600_000) {
    throw new HardwareRunnerError('CONFIG_INVALID', `Stage ${input.stage} timeoutMs out of bounds`);
  }

  const prepared = prepareStageSandboxInvocation(input);
  try {
    // Recheck monotonic lease deadline and abort signal IMMEDIATELY BEFORE spawn(...) so
    // synchronous mount-tree scanning or sandbox compilation can NEVER launch a stage past expiry!
    assertLeaseDeadlineNotExpired(deadlineChecker, `Stage ${input.stage} pre-spawn`, input.signal);

    const { executablePath: spawnExecutable, args: spawnArgs, cwd: spawnCwd, seccompBpf, dockerCleanupInfo } = prepared;
    return await new Promise<StageProcessExecutionResult>((resolveRun, rejectRun) => {
      const child = spawn(spawnExecutable, [...spawnArgs], {
        cwd: spawnCwd,
        env: { ...input.env },
        stdio: seccompBpf !== null ? ['pipe', 'pipe', 'pipe', 'pipe'] : ['pipe', 'pipe', 'pipe'],
        detached: true,
      });

      const childPgid = child.pid ?? 0;

      if (seccompBpf !== null) {
        const seccompPipe = child.stdio[3] as Writable | null | undefined;
        if (seccompPipe !== null && seccompPipe !== undefined) {
          seccompPipe.on('error', () => undefined);
          seccompPipe.end(seccompBpf);
        }
      }
      child.stdin.on('error', () => undefined);
      child.stdin.end();
      child.stdout.on('error', () => undefined);
      child.stderr.on('error', () => undefined);

      let forceKillTimer: ReturnType<typeof setTimeout> | null = null;
      let leaseDeadlineTimer: ReturnType<typeof setTimeout> | null = null;
      let activeDockerRm: Promise<void> | null = null;
      let terminationRequested = false;
      let leaseExpired = false;
      let overflowError: HardwareRunnerError | null = null;
      let stdoutClosed = false;
      let stderrClosed = false;
      let onStdioStreamClosed: (() => void) | null = null;

      const markStdoutClosed = (): void => {
        if (!stdoutClosed) {
          stdoutClosed = true;
          onStdioStreamClosed?.();
        }
      };
      const markStderrClosed = (): void => {
        if (!stderrClosed) {
          stderrClosed = true;
          onStdioStreamClosed?.();
        }
      };
      child.stdout.once('end', markStdoutClosed);
      child.stdout.once('close', markStdoutClosed);
      child.stderr.once('end', markStderrClosed);
      child.stderr.once('close', markStderrClosed);

      const triggerDockerRm = (): Promise<void> => {
        if (dockerCleanupInfo === null) return Promise.resolve();
        if (activeDockerRm === null) {
          activeDockerRm = runSanitizedDockerRmForce(
            dockerCleanupInfo.executablePath,
            dockerCleanupInfo.containerName,
          ).finally(() => {
            activeDockerRm = null;
          });
        }
        return activeDockerRm;
      };

      const signalProcessGroup = (sig: NodeJS.Signals): void => {
        try {
          if (childPgid > 0) {
            process.kill(-childPgid, sig);
          } else {
            child.kill(sig);
          }
        } catch {
          try {
            child.kill(sig);
          } catch {
            // Child already exited.
          }
        }
      };

      const terminateNow = (immediateKill = false): void => {
        terminationRequested = true;
        child.stdout.destroy();
        child.stderr.destroy();
        onStdioStreamClosed?.();
        signalProcessGroup(immediateKill ? 'SIGKILL' : 'SIGTERM');
        void triggerDockerRm().catch(() => {});
        if (!immediateKill && forceKillTimer === null) {
          forceKillTimer = setTimeout(() => {
            if (!settled) {
              signalProcessGroup('SIGKILL');
              void triggerDockerRm().catch(() => {});
            }
          }, 150);
          forceKillTimer.unref();
        }
      };

      const stdoutChunks: Buffer[] = [];
      const stderrChunks: Buffer[] = [];
      let stdoutBytes = 0;
      let stderrBytes = 0;
      let timedOut = false;
      let settled = false;

      const armLeaseDeadlineTimer = (): void => {
        if (deadlineChecker === undefined || settled || terminationRequested) return;
        if (leaseDeadlineTimer !== null) {
          clearTimeout(leaseDeadlineTimer);
          leaseDeadlineTimer = null;
        }
        const remMs = deadlineChecker.getDeadlineMonoMs() - deadlineChecker.nowMonotonicMs();
        if (remMs <= 0) {
          leaseExpired = true;
          terminateNow(false);
          return;
        }
        const waitMs = Math.min(input.timeoutMs, Math.max(1, Math.ceil(remMs)));
        leaseDeadlineTimer = setTimeout(() => {
          leaseDeadlineTimer = null;
          if (settled || terminationRequested) return;
          if (deadlineChecker.nowMonotonicMs() >= deadlineChecker.getDeadlineMonoMs()) {
            leaseExpired = true;
            terminateNow(false);
          } else {
            armLeaseDeadlineTimer();
          }
        }, waitMs);
        leaseDeadlineTimer.unref();
      };

      const finishAfterTeardown = async (
        exitCode: number | null,
        exitSignal: NodeJS.Signals | null,
        err?: Error,
      ): Promise<void> => {
        if (settled) return;
        settled = true;
        clearTimeout(timeoutTimer);
        if (leaseDeadlineTimer !== null) clearTimeout(leaseDeadlineTimer);
        if (forceKillTimer !== null) clearTimeout(forceKillTimer);
        input.signal?.removeEventListener('abort', onExternalAbort);
        child.stdout.destroy();
        child.stderr.destroy();

        let teardownErr: RunnerTeardownError | null = null;
        try {
          signalProcessGroup('SIGKILL');
          await waitForProcessGroupExit(childPgid);
          if (activeDockerRm !== null) {
            await activeDockerRm.catch(() => {});
          }
          if (
            dockerCleanupInfo !== null
            && (terminationRequested || timedOut || leaseExpired || err !== undefined || exitCode !== 0 || exitSignal !== null)
          ) {
            await runSanitizedDockerRmForce(dockerCleanupInfo.executablePath, dockerCleanupInfo.containerName);
          }
        } catch (tdErr: unknown) {
          teardownErr = tdErr instanceof RunnerTeardownError
            ? tdErr
            : new RunnerTeardownError(tdErr instanceof Error ? tdErr.message : String(tdErr));
        }

        const leaseFenceErr =
          leaseExpired || (deadlineChecker !== undefined && deadlineChecker.nowMonotonicMs() >= deadlineChecker.getDeadlineMonoMs())
            ? new HardwareRunnerError('QUEUE_LEASE_FENCED', `Stage ${input.stage} lease authority expired`)
            : undefined;

        const effectiveErr = teardownErr ?? err ?? overflowError ?? leaseFenceErr ?? (
          input.signal?.aborted
            ? new HardwareRunnerError('RUNNER_SANDBOX_FAILED', `Stage ${input.stage} aborted`)
            : undefined
        );
        if (effectiveErr !== undefined) {
          rejectRun(effectiveErr);
          return;
        }
        resolveRun({
          exitCode,
          signal: exitSignal,
          stdout: Buffer.concat(stdoutChunks, stdoutBytes).toString('utf8'),
          stderr: Buffer.concat(stderrChunks, stderrBytes).toString('utf8'),
          timedOut,
        });
      };

      const onExternalAbort = (): void => {
        terminateNow(false);
      };
      if (input.signal?.aborted) {
        terminateNow(false);
      } else {
        input.signal?.addEventListener('abort', onExternalAbort, { once: true });
      }

      armLeaseDeadlineTimer();

      const timeoutTimer = setTimeout(() => {
        timedOut = true;
        terminateNow(false);
      }, input.timeoutMs);
      timeoutTimer.unref();

      child.on('error', err => {
        const mapped = err instanceof TaskpackError
          ? new HardwareRunnerError('RUNNER_SANDBOX_FAILED', err.message)
          : new HardwareRunnerError('RUNNER_SANDBOX_FAILED', `failed to spawn sandboxed process: ${err.message}`);
        void finishAfterTeardown(null, null, mapped);
      });

      child.stdout.on('data', (chunk: Buffer) => {
        if (overflowError !== null) return;
        if (stdoutBytes + chunk.byteLength > MAX_STAGE_STDIO_BYTES) {
          overflowError = new HardwareRunnerError(
            'ARTIFACT_INVALID',
            `Stage ${input.stage} stdout exceeded ${MAX_STAGE_STDIO_BYTES} bytes`,
          );
          terminateNow(true);
          return;
        }
        stdoutChunks.push(chunk);
        stdoutBytes += chunk.byteLength;
      });

      child.stderr.on('data', (chunk: Buffer) => {
        if (overflowError !== null) return;
        if (stderrBytes + chunk.byteLength > MAX_STAGE_STDIO_BYTES) {
          overflowError = new HardwareRunnerError(
            'ARTIFACT_INVALID',
            `Stage ${input.stage} stderr exceeded ${MAX_STAGE_STDIO_BYTES} bytes`,
          );
          terminateNow(true);
          return;
        }
        stderrChunks.push(chunk);
        stderrBytes += chunk.byteLength;
      });

      // Listen on 'exit' (NEVER 'close'!) so a leaked stdio descriptor cannot delay teardown!
      child.once('exit', (code, exitSignal) => {
        void (async () => {
          if (
            !terminationRequested
            && !timedOut
            && !leaseExpired
            && overflowError === null
            && (!stdoutClosed || !stderrClosed)
          ) {
            await new Promise<void>(resolveDrain => {
              const checkDone = (): void => {
                if ((stdoutClosed && stderrClosed) || terminationRequested || overflowError !== null) {
                  clearTimeout(drainCap);
                  onStdioStreamClosed = null;
                  resolveDrain();
                }
              };
              const drainCap = setTimeout(() => {
                onStdioStreamClosed = null;
                resolveDrain();
              }, 150);
              drainCap.unref();
              onStdioStreamClosed = checkDone;
              checkDone();
            });
          }
          await finishAfterTeardown(code, exitSignal);
        })();
      });
    });
  } finally {
    prepared.cleanup();
  }
}

/**
 * Walk `stageAOutDir` with `O_NOFOLLOW`, reject symlinks/hardlinks/secrets/budget violations without
 * mutating bytes, seal every output file `0o400` + `fsync`, and lock directories `0o500`.
 */
export async function sealStageAOutputs(options: {
  readonly stageAOutDir: string;
  readonly scrubber: SecretScrubber;
  readonly secretOverlapBytes: number;
  readonly maxBlobBytes?: number;
  readonly signal?: AbortSignal;
}): Promise<readonly SealedStageAArtifact[]> {
  const { stageAOutDir, scrubber, secretOverlapBytes } = options;
  const perFileMax = Math.min(
    options.maxBlobBytes ?? VERIFIER_ARTIFACT_LIMITS.maxFileBytes,
    VERIFIER_ARTIFACT_LIMITS.maxFileBytes,
  );
  await assertNoSymlinkAncestors(stageAOutDir, {
    checkLeaf: true,
    code: 'ARTIFACT_INVALID',
    diagPath: '/stageAOutDir',
  });

  const noFollow = 'O_NOFOLLOW' in constants ? constants.O_NOFOLLOW : 0;
  const oDirectory = 'O_DIRECTORY' in constants ? constants.O_DIRECTORY : 0;
  const realRoot = await realpath(stageAOutDir);
  const dirsToSeal: string[] = [];
  const seenFolded = new Set<string>();
  const sealed: SealedStageAArtifact[] = [];
  let totalBytes = 0;

  const isInsideOutRoot = (candidateReal: string): boolean =>
    candidateReal === realRoot
    || candidateReal.startsWith(realRoot.endsWith(sep) ? realRoot : `${realRoot}${sep}`);

  const walk = async (absDir: string, relPrefix: string, depth: number): Promise<void> => {
    if (depth > 32) {
      throw new HardwareRunnerError('ARTIFACT_INVALID', 'Stage A output directory exceeds maximum nesting depth');
    }
    const dirHandle = await open(absDir, constants.O_RDONLY | noFollow | oDirectory).catch(() => {
      throw new HardwareRunnerError('ARTIFACT_INVALID', 'symlink or invalid directory in Stage A output');
    });
    await dirHandle.close();

    const dirents = await readdir(absDir, { withFileTypes: true });
    dirents.sort((a, b) => compareUtf16(a.name, b.name));

    for (const dirent of dirents) {
      if (options.signal?.aborted) {
        throw new HardwareRunnerError('RUNNER_SANDBOX_FAILED', 'Stage A output sealing aborted');
      }
      const childAbs = join(absDir, dirent.name);
      const childRel = relPrefix.length === 0 ? dirent.name : `${relPrefix}/${dirent.name}`;
      if (dirent.isSymbolicLink()) {
        throw new HardwareRunnerError('ARTIFACT_INVALID', `symlink "${childRel}" is forbidden in Stage A outputs`);
      }
      const st = await lstat(childAbs).catch(() => null);
      if (st === null || st.isSymbolicLink()) {
        throw new HardwareRunnerError('ARTIFACT_INVALID', `symlink or vanished entry "${childRel}" in Stage A outputs`);
      }
      const realChild = await realpath(childAbs).catch(() => {
        throw new HardwareRunnerError('ARTIFACT_INVALID', `unable to resolve Stage A output "${childRel}"`);
      });
      if (!isInsideOutRoot(realChild)) {
        throw new HardwareRunnerError('ARTIFACT_INVALID', `Stage A output "${childRel}" escapes stage-a-out`);
      }

      if (st.isDirectory()) {
        if (dirent.name.toLowerCase() === '.git' || dirent.name.toLowerCase() === '.loopwright-verifier') {
          throw new HardwareRunnerError('ARTIFACT_INVALID', `forbidden directory "${childRel}" in Stage A outputs`);
        }
        await walk(childAbs, childRel, depth + 1);
        dirsToSeal.push(childAbs);
      } else if (st.isFile()) {
        validateSafeRelativeArtifactPath(childRel, '/outputArtifacts');
        const folded = childRel.normalize('NFC').toLowerCase();
        if (seenFolded.has(folded)) {
          throw new HardwareRunnerError('ARTIFACT_INVALID', `case-colliding Stage A output "${childRel}"`);
        }
        seenFolded.add(folded);

        if (sealed.length >= VERIFIER_ARTIFACT_LIMITS.maxFilesPerSlot) {
          throw new HardwareRunnerError(
            'ARTIFACT_INVALID',
            `Stage A outputs exceed maximum of ${VERIFIER_ARTIFACT_LIMITS.maxFilesPerSlot} files`,
          );
        }
        if (st.nlink !== 1) {
          throw new HardwareRunnerError('ARTIFACT_INVALID', `hardlinked file "${childRel}" is forbidden in Stage A outputs`);
        }
        if (st.size > perFileMax) {
          throw new HardwareRunnerError('PAYLOAD_TOO_LARGE', `Stage A output "${childRel}" exceeds per-file byte limit`);
        }
        if (st.size > VERIFIER_ARTIFACT_LIMITS.maxTotalBytes - totalBytes) {
          throw new HardwareRunnerError('PAYLOAD_TOO_LARGE', 'Stage A outputs exceed aggregate verifier byte budget');
        }

        const fh = await open(childAbs, constants.O_RDONLY | noFollow);
        let hexDigest: string;
        let byteLength: number;
        try {
          const opened = await fh.stat();
          if (
            !opened.isFile()
            || opened.isSymbolicLink()
            || opened.nlink !== 1
            || opened.dev !== st.dev
            || opened.ino !== st.ino
            || opened.size !== st.size
          ) {
            throw new HardwareRunnerError('ARTIFACT_INVALID', `Stage A output "${childRel}" mutated while opening`);
          }

          const hasher = createHash('sha256');
          let scanTail: Buffer = Buffer.alloc(0);
          const buf = Buffer.allocUnsafe(Math.min(MAX_CAS_CHUNK_BYTES, Math.max(1, opened.size)));
          let offset = 0;

          while (offset < opened.size) {
            if (options.signal?.aborted) {
              throw new HardwareRunnerError('RUNNER_SANDBOX_FAILED', 'Stage A output sealing aborted');
            }
            const maxStep = Math.max(1, MAX_CAS_CHUNK_BYTES - scanTail.byteLength);
            const toRead = Math.min(maxStep, buf.byteLength, opened.size - offset);
            const { bytesRead } = await fh.read(buf, 0, toRead, offset);
            if (bytesRead <= 0) break;
            const slice = buf.subarray(0, bytesRead);
            const windowBuf = scanTail.byteLength === 0 ? slice : Buffer.concat([scanTail, slice]);
            if (
              scrubber.containsSecret(windowBuf.toString('latin1'))
              || scrubber.containsSecret(windowBuf.toString('utf8'))
            ) {
              throw new HardwareRunnerError(
                'ARTIFACT_INVALID',
                `Stage A output "${childRel}" rejected by SecretScrubber`,
              );
            }
            scanTail = windowBuf.byteLength > secretOverlapBytes
              ? Buffer.from(windowBuf.subarray(windowBuf.byteLength - secretOverlapBytes))
              : Buffer.from(windowBuf);
            hasher.update(slice);
            offset += bytesRead;
          }

          const extra = await fh.read(buf, 0, 1, offset);
          if (extra.bytesRead !== 0 || offset !== opened.size) {
            throw new HardwareRunnerError('ARTIFACT_INVALID', `Stage A output "${childRel}" changed size during hashing`);
          }

          await fh.chmod(0o400);
          await fh.sync();
          const sealedStat = await fh.stat();
          if (
            sealedStat.dev !== opened.dev
            || sealedStat.ino !== opened.ino
            || sealedStat.size !== opened.size
            || sealedStat.nlink !== 1
            || (sealedStat.mode & 0o7777) !== 0o400
          ) {
            throw new HardwareRunnerError('ARTIFACT_INVALID', `failed to seal Stage A output "${childRel}" to 0o400`);
          }
          hexDigest = hasher.digest('hex');
          byteLength = offset;
        } finally {
          await fh.close();
        }

        totalBytes += byteLength;
        sealed.push(
          Object.freeze({
            artifact: Object.freeze({
              name: childRel,
              digest: Object.freeze({ algorithm: 'sha256' as const, hex: hexDigest }),
              byteLength,
            }),
            sealedFilePath: childAbs,
          }),
        );
      } else {
        throw new HardwareRunnerError('ARTIFACT_INVALID', `unsupported non-regular file "${childRel}" in Stage A outputs`);
      }
    }
  };

  await walk(stageAOutDir, '', 0);
  for (const subDir of dirsToSeal) {
    await chmod(subDir, 0o500);
  }
  await chmod(stageAOutDir, 0o500);

  sealed.sort((a, b) => compareUtf16(a.artifact.name, b.artifact.name));
  return Object.freeze(sealed);
}

const AUDIT_BINARY_EXT_RE = /\.(?:so(?:\.[0-9]+)*|o|cubin|fatbin|elf|hsaco|dylib)$/i;
const AUDIT_TEXT_EXT_RE = /\.(?:ptx|sass|s|asm|isa|log|rpt|report|txt|json)$/i;
const FORBIDDEN_AUDIT_GLOB_RE = /[*?[\]]/;

function resolveEffectiveStageAAuditSpec(
  targetHardware: HardwareTargetSpec,
  explicitAudit: StageAStaticAuditSpec | undefined,
): StageAStaticAuditSpec | null {
  const mergedPatterns: string[] = [];
  const seen = new Set<string>();
  for (const list of [targetHardware.forbiddenSymbolPatterns, explicitAudit?.forbiddenSymbolPatterns]) {
    if (list === undefined) continue;
    for (const pat of list) {
      if (!seen.has(pat)) {
        seen.add(pat);
        mergedPatterns.push(pat);
      }
    }
  }
  if (mergedPatterns.length > LIMITS.forbiddenSymbolPatterns) {
    throw new HardwareRunnerError(
      'ARTIFACT_INVALID',
      `combined forbiddenSymbolPatterns exceeds ${LIMITS.forbiddenSymbolPatterns}`,
      '/stageAAudit/forbiddenSymbolPatterns',
    );
  }

  let maxRegisterCount: number | undefined;
  if (targetHardware.maxRegisterCount !== undefined && explicitAudit?.maxRegisterCount !== undefined) {
    maxRegisterCount = Math.min(targetHardware.maxRegisterCount, explicitAudit.maxRegisterCount);
  } else {
    maxRegisterCount = targetHardware.maxRegisterCount ?? explicitAudit?.maxRegisterCount;
  }

  let maxLocalSpillBytes: number | undefined;
  if (targetHardware.maxLocalSpillBytes !== undefined && explicitAudit?.maxLocalSpillBytes !== undefined) {
    maxLocalSpillBytes = Math.min(targetHardware.maxLocalSpillBytes, explicitAudit.maxLocalSpillBytes);
  } else {
    maxLocalSpillBytes = targetHardware.maxLocalSpillBytes ?? explicitAudit?.maxLocalSpillBytes;
  }

  if (mergedPatterns.length === 0 && maxRegisterCount === undefined && maxLocalSpillBytes === undefined) {
    return null;
  }

  return Object.freeze({
    ...(mergedPatterns.length > 0 ? { forbiddenSymbolPatterns: Object.freeze(mergedPatterns) } : {}),
    ...(maxRegisterCount !== undefined ? { maxRegisterCount } : {}),
    ...(maxLocalSpillBytes !== undefined ? { maxLocalSpillBytes } : {}),
  });
}

function validateAuditSpecInputs(spec: StageAStaticAuditSpec): void {
  if (spec.forbiddenSymbolPatterns !== undefined) {
    if (!Array.isArray(spec.forbiddenSymbolPatterns) || spec.forbiddenSymbolPatterns.length > LIMITS.forbiddenSymbolPatterns) {
      throw new HardwareRunnerError(
        'CONFIG_INVALID',
        `forbiddenSymbolPatterns must contain 0..${LIMITS.forbiddenSymbolPatterns} entries`,
        '/stageAAudit/forbiddenSymbolPatterns',
      );
    }
    const seen = new Set<string>();
    for (const pat of spec.forbiddenSymbolPatterns) {
      if (
        typeof pat !== 'string'
        || pat.length < 1
        || pat.length > LIMITS.forbiddenSymbolPattern
        || pat.trim() !== pat
        || !PRINTABLE_ASCII_RE.test(pat)
        || FORBIDDEN_AUDIT_GLOB_RE.test(pat)
      ) {
        throw new HardwareRunnerError(
          'CONFIG_INVALID',
          'invalid or glob-containing pattern in forbiddenSymbolPatterns',
          '/stageAAudit/forbiddenSymbolPatterns',
        );
      }
      if (seen.has(pat)) {
        throw new HardwareRunnerError('CONFIG_INVALID', 'duplicate pattern in forbiddenSymbolPatterns');
      }
      seen.add(pat);
    }
  }
  if (
    spec.maxRegisterCount !== undefined
    && (!Number.isSafeInteger(spec.maxRegisterCount) || Object.is(spec.maxRegisterCount, -0) || spec.maxRegisterCount < 0)
  ) {
    throw new HardwareRunnerError('CONFIG_INVALID', 'invalid maxRegisterCount', '/stageAAudit/maxRegisterCount');
  }
  if (
    spec.maxLocalSpillBytes !== undefined
    && (!Number.isSafeInteger(spec.maxLocalSpillBytes) || Object.is(spec.maxLocalSpillBytes, -0) || spec.maxLocalSpillBytes < 0)
  ) {
    throw new HardwareRunnerError('CONFIG_INVALID', 'invalid maxLocalSpillBytes', '/stageAAudit/maxLocalSpillBytes');
  }
}

/**
 * Deterministically decode length-prefixed Itanium C++ `_Z...` mangled identifiers (and leading
 * Mach-O underscores) into `ns::name` forms so `forbiddenSymbolPatterns` such as `'at::native::'`
 * match mangled symbols (`_ZN2at6native9gemm_cudaE`) offline with zero external `c++filt` dependency.
 */
function expandDemangledSymbolForms(rawSymbol: string): readonly string[] {
  const out = new Set<string>([rawSymbol]);
  const stripped = rawSymbol.startsWith('__Z') ? rawSymbol.slice(1) : rawSymbol;
  if (rawSymbol.startsWith('_') && !rawSymbol.startsWith('_Z')) {
    out.add(rawSymbol.slice(1));
  }
  if (!stripped.startsWith('_Z')) {
    return [...out];
  }

  let cursor = 2;
  if (stripped[cursor] === 'L') cursor += 1;
  if (stripped[cursor] === 'N') {
    cursor += 1;
    while (cursor < stripped.length && (stripped[cursor] === 'K' || stripped[cursor] === 'V' || stripped[cursor] === 'r')) {
      cursor += 1;
    }
    const parts: string[] = [];
    while (cursor < stripped.length && stripped[cursor] !== 'E') {
      if (stripped[cursor] === 'I') {
        // Skip template argument list `<...>` balanced on I..E if nested
        let depth = 1;
        cursor += 1;
        while (cursor < stripped.length && depth > 0) {
          if (stripped[cursor] === 'I') depth += 1;
          else if (stripped[cursor] === 'E') depth -= 1;
          cursor += 1;
        }
        continue;
      }
      let numEnd = cursor;
      while (numEnd < stripped.length && stripped.charCodeAt(numEnd) >= 48 && stripped.charCodeAt(numEnd) <= 57) {
        numEnd += 1;
      }
      if (numEnd === cursor) break;
      const segLen = Number.parseInt(stripped.slice(cursor, numEnd), 10);
      if (!Number.isSafeInteger(segLen) || segLen <= 0 || numEnd + segLen > stripped.length) break;
      parts.push(stripped.slice(numEnd, numEnd + segLen));
      cursor = numEnd + segLen;
    }
    if (parts.length > 0) {
      const joined = parts.join('::');
      out.add(joined);
      out.add(`${joined}::`);
    }
  } else {
    let numEnd = cursor;
    while (numEnd < stripped.length && stripped.charCodeAt(numEnd) >= 48 && stripped.charCodeAt(numEnd) <= 57) {
      numEnd += 1;
    }
    if (numEnd > cursor) {
      const segLen = Number.parseInt(stripped.slice(cursor, numEnd), 10);
      if (Number.isSafeInteger(segLen) && segLen > 0 && numEnd + segLen <= stripped.length) {
        out.add(stripped.slice(numEnd, numEnd + segLen));
      }
    }
  }
  return [...out];
}

function readNullTerminatedCString(strTab: Buffer, startOffset: number): string {
  if (startOffset < 0 || startOffset >= strTab.byteLength) return '';
  const end = strTab.indexOf(0, startOffset);
  const sliceEnd = end === -1 ? Math.min(strTab.byteLength, startOffset + 512) : Math.min(end, startOffset + 512);
  if (sliceEnd <= startOffset) return '';
  return strTab.subarray(startOffset, sliceEnd).toString('utf8');
}

interface ParsedArtifactStaticInfo {
  readonly symbols: readonly string[];
  readonly maxRegisters: number | null;
  readonly maxSpillBytes: number | null;
  readonly embeddedTexts: readonly string[];
  readonly scanError: string | null;
}

async function parseElfFromHandle(
  fh: Awaited<ReturnType<typeof open>>,
  fileSize: number,
  maxScanBytes: number,
): Promise<ParsedArtifactStaticInfo> {
  if (fileSize < 52) {
    return { symbols: [], maxRegisters: null, maxSpillBytes: null, embeddedTexts: [], scanError: 'truncated ELF header (< 52 bytes)' };
  }
  const hdrLen = Math.min(64, fileSize);
  const ehdr = Buffer.allocUnsafe(hdrLen);
  await readExactFromHandle(fh, ehdr, hdrLen, 0);

  const eiClass = ehdr[4]!; // 1 = 32-bit, 2 = 64-bit
  const eiData = ehdr[5]!; // 1 = little-endian, 2 = big-endian
  if ((eiClass !== 1 && eiClass !== 2) || (eiData !== 1 && eiData !== 2)) {
    return { symbols: [], maxRegisters: null, maxSpillBytes: null, embeddedTexts: [], scanError: 'unsupported ELF class or endianness' };
  }
  const is64 = eiClass === 2;
  const isLE = eiData === 1;
  if (is64 && fileSize < 64) {
    return { symbols: [], maxRegisters: null, maxSpillBytes: null, embeddedTexts: [], scanError: 'truncated ELF64 header (< 64 bytes)' };
  }

  const readU16 = (buf: Buffer, off: number): number => (isLE ? buf.readUInt16LE(off) : buf.readUInt16BE(off));
  const readU32 = (buf: Buffer, off: number): number => (isLE ? buf.readUInt32LE(off) : buf.readUInt32BE(off));
  const readU64AsSafeNumber = (buf: Buffer, off: number): number | null => {
    const v = isLE ? buf.readBigUInt64LE(off) : buf.readBigUInt64BE(off);
    if (v > BigInt(Number.MAX_SAFE_INTEGER)) return null;
    return Number(v);
  };

  const shOff = is64 ? readU64AsSafeNumber(ehdr, 40) : readU32(ehdr, 32);
  const shEntSize = readU16(ehdr, is64 ? 58 : 46);
  let shNum = readU16(ehdr, is64 ? 60 : 48);
  let shStrNdx = readU16(ehdr, is64 ? 62 : 50);

  if (shOff === null || shOff === 0 || shEntSize < (is64 ? 64 : 40)) {
    return {
      symbols: [],
      maxRegisters: null,
      maxSpillBytes: null,
      embeddedTexts: [],
      scanError: 'ELF binary is missing a valid section header table for static symbol audit',
    };
  }

  let scannedBytes = hdrLen;
  if (shNum === 0 && shOff + shEntSize <= fileSize) {
    const sh0 = Buffer.allocUnsafe(shEntSize);
    await readExactFromHandle(fh, sh0, shEntSize, shOff);
    scannedBytes += shEntSize;
    const extNum = is64 ? readU64AsSafeNumber(sh0, 32) : readU32(sh0, 20);
    if (extNum === null || extNum < 1 || extNum > 4096) {
      return { symbols: [], maxRegisters: null, maxSpillBytes: null, embeddedTexts: [], scanError: 'invalid extended ELF section count' };
    }
    shNum = extNum;
    if (shStrNdx === 0xffff) {
      shStrNdx = readU32(sh0, is64 ? 40 : 24);
    }
  }

  if (shNum < 1 || shNum > 4096) {
    return { symbols: [], maxRegisters: null, maxSpillBytes: null, embeddedTexts: [], scanError: 'ELF section header count out of bounds' };
  }
  const shTableBytes = shNum * shEntSize;
  if (shOff + shTableBytes > fileSize) {
    return { symbols: [], maxRegisters: null, maxSpillBytes: null, embeddedTexts: [], scanError: 'ELF section header table exceeds file size' };
  }
  if (scannedBytes + shTableBytes > maxScanBytes) {
    return {
      symbols: [],
      maxRegisters: null,
      maxSpillBytes: null,
      embeddedTexts: [],
      scanError: `ELF section header table exceeds ${maxScanBytes}-byte Stage A static audit scan cap`,
    };
  }

  const shTableBuf = Buffer.allocUnsafe(shTableBytes);
  await readExactFromHandle(fh, shTableBuf, shTableBytes, shOff);
  scannedBytes += shTableBytes;

  interface ElfSectionHeader {
    readonly nameOffset: number;
    readonly shType: number;
    readonly shOffset: number;
    readonly shSize: number;
    readonly shLink: number;
    readonly shInfo: number;
    readonly shEntSize: number;
  }

  const headers: ElfSectionHeader[] = [];
  for (let idx = 0; idx < shNum; idx += 1) {
    const base = idx * shEntSize;
    const nameOffset = readU32(shTableBuf, base);
    const shType = readU32(shTableBuf, base + 4);
    const secOff = is64 ? readU64AsSafeNumber(shTableBuf, base + 24) : readU32(shTableBuf, base + 16);
    const secSize = is64 ? readU64AsSafeNumber(shTableBuf, base + 32) : readU32(shTableBuf, base + 20);
    const shLink = readU32(shTableBuf, base + 40 - (is64 ? 0 : 16));
    const shInfo = readU32(shTableBuf, base + 44 - (is64 ? 0 : 16));
    const secEntSize = is64 ? readU64AsSafeNumber(shTableBuf, base + 56) : readU32(shTableBuf, base + 36);
    if (secOff === null || secSize === null || secEntSize === null) {
      return { symbols: [], maxRegisters: null, maxSpillBytes: null, embeddedTexts: [], scanError: 'ELF section size overflow' };
    }
    if (shType !== 0 && shType !== 8 && secSize > 0 && secOff + secSize > fileSize) {
      return { symbols: [], maxRegisters: null, maxSpillBytes: null, embeddedTexts: [], scanError: 'ELF section payload exceeds file size' };
    }
    headers.push({
      nameOffset,
      shType,
      shOffset: secOff,
      shSize: secSize,
      shLink,
      shInfo,
      shEntSize: secEntSize,
    });
  }

  const cachedSections = new Map<number, Buffer>();
  const readSectionBounded = async (secIdx: number): Promise<Buffer | null> => {
    const existing = cachedSections.get(secIdx);
    if (existing !== undefined) return existing;
    const sec = headers[secIdx];
    if (!sec || sec.shType === 0 || sec.shType === 8 || sec.shSize === 0) {
      return Buffer.alloc(0);
    }
    if (sec.shSize > maxScanBytes - scannedBytes) {
      return null;
    }
    const buf = Buffer.allocUnsafe(sec.shSize);
    await readExactFromHandle(fh, buf, sec.shSize, sec.shOffset);
    scannedBytes += sec.shSize;
    cachedSections.set(secIdx, buf);
    return buf;
  };

  let shStrBuf: Buffer = Buffer.alloc(0);
  if (shStrNdx > 0 && shStrNdx < headers.length) {
    const loaded = await readSectionBounded(shStrNdx);
    if (loaded === null) {
      return {
        symbols: [],
        maxRegisters: null,
        maxSpillBytes: null,
        embeddedTexts: [],
        scanError: `ELF .shstrtab exceeds ${maxScanBytes}-byte Stage A static audit scan cap`,
      };
    }
    shStrBuf = loaded;
  }

  const symbols = new Set<string>();
  const embeddedTexts: string[] = [];
  let maxRegisters: number | null = null;
  let maxSpillBytes: number | null = null;

  for (let idx = 1; idx < headers.length; idx += 1) {
    const sec = headers[idx]!;
    const secName = shStrBuf.byteLength > 0 ? readNullTerminatedCString(shStrBuf, sec.nameOffset) : '';

    // SHT_SYMTAB (2) or SHT_DYNSYM (11)
    if (sec.shType === 2 || sec.shType === 11) {
      const symBuf = await readSectionBounded(idx);
      const strBuf = sec.shLink > 0 && sec.shLink < headers.length ? await readSectionBounded(sec.shLink) : Buffer.alloc(0);
      if (symBuf === null || strBuf === null) {
        return {
          symbols: [],
          maxRegisters: null,
          maxSpillBytes: null,
          embeddedTexts: [],
          scanError: `ELF symbol/string table exceeds ${maxScanBytes}-byte Stage A static audit scan cap`,
        };
      }
      const entSize = sec.shEntSize >= (is64 ? 24 : 16) ? sec.shEntSize : (is64 ? 24 : 16);
      for (let off = 0; off + entSize <= symBuf.byteLength; off += entSize) {
        const stName = readU32(symBuf, off);
        if (stName > 0 && stName < strBuf.byteLength) {
          const symName = readNullTerminatedCString(strBuf, stName);
          if (symName.length > 0) {
            symbols.add(symName);
          }
        }
      }
      continue;
    }

    // SHT_DYNAMIC (6): inspect DT_NEEDED (d_tag === 1) shared library names
    if (sec.shType === 6 && sec.shLink > 0 && sec.shLink < headers.length) {
      const dynBuf = await readSectionBounded(idx);
      const dynStrBuf = await readSectionBounded(sec.shLink);
      if (dynBuf === null || dynStrBuf === null) {
        return {
          symbols: [],
          maxRegisters: null,
          maxSpillBytes: null,
          embeddedTexts: [],
          scanError: `ELF .dynamic table exceeds ${maxScanBytes}-byte Stage A static audit scan cap`,
        };
      }
      const entSize = sec.shEntSize >= (is64 ? 16 : 8) ? sec.shEntSize : (is64 ? 16 : 8);
      for (let off = 0; off + entSize <= dynBuf.byteLength; off += entSize) {
        const tag = is64 ? readU64AsSafeNumber(dynBuf, off) : readU32(dynBuf, off);
        if (tag === 0) break;
        if (tag === 1) {
          const valOff = is64 ? readU64AsSafeNumber(dynBuf, off + 8) : readU32(dynBuf, off + 4);
          if (valOff !== null && valOff > 0 && valOff < dynStrBuf.byteLength) {
            const neededLib = readNullTerminatedCString(dynStrBuf, valOff);
            if (neededLib.length > 0) {
              symbols.add(neededLib);
            }
          }
        }
      }
      continue;
    }

    // NVIDIA cubin .nv.info / .nv.info.<kernel> sections (SHT_CUDA_INFO = 0x70000000)
    if (secName === '.nv.info' || secName.startsWith('.nv.info.') || sec.shType === 0x70000000) {
      const nvBuf = await readSectionBounded(idx);
      if (nvBuf === null) {
        return {
          symbols: [],
          maxRegisters: null,
          maxSpillBytes: null,
          embeddedTexts: [],
          scanError: `ELF .nv.info metadata exceeds ${maxScanBytes}-byte Stage A static audit scan cap`,
        };
      }
      let pos = 0;
      while (pos + 4 <= nvBuf.byteLength) {
        const fmt = nvBuf[pos]!;
        const attr = nvBuf[pos + 1]!;
        if (fmt === 0x01 || fmt === 0x02) {
          pos += 4;
          continue;
        }
        if (fmt === 0x03) {
          const hVal = readU16(nvBuf, pos + 2);
          if (attr === 0x1b || attr === 0x2f) {
            maxRegisters = Math.max(maxRegisters ?? 0, hVal);
          }
          pos += 4;
          continue;
        }
        if (fmt === 0x04) {
          const payloadSize = readU16(nvBuf, pos + 2);
          const nextPos = pos + 4 + payloadSize;
          if (nextPos > nvBuf.byteLength) break;
          if (attr === 0x2f) {
            const regVal = payloadSize >= 8
              ? readU32(nvBuf, pos + 8)
              : payloadSize >= 4
                ? readU32(nvBuf, pos + 4)
                : 0;
            maxRegisters = Math.max(maxRegisters ?? 0, regVal);
          } else if (attr === 0x11) {
            const frameVal = payloadSize >= 8
              ? readU32(nvBuf, pos + 8)
              : payloadSize >= 4
                ? readU32(nvBuf, pos + 4)
                : 0;
            maxSpillBytes = Math.max(maxSpillBytes ?? 0, frameVal);
          }
          const alignedStep = (4 + payloadSize + 3) & ~3;
          pos += Math.max(4, alignedStep);
          continue;
        }
        break;
      }
      continue;
    }

    // Older cubin per-kernel .nv.local.<kernel> section sh_size directly measures local spill/frame bytes!
    if (secName.startsWith('.nv.local.')) {
      maxSpillBytes = Math.max(maxSpillBytes ?? 0, sec.shSize);
      continue;
    }

    // Embedded PTX sections inside host fatbin ELF — fail closed when scan budget is exceeded
    if ((secName.includes('ptx') || secName === '.nv_fatbin') && sec.shSize > 0) {
      if (sec.shSize > maxScanBytes - scannedBytes) {
        return {
          symbols: [],
          maxRegisters: null,
          maxSpillBytes: null,
          embeddedTexts: [],
          scanError: `ELF embedded PTX section "${secName}" (${sec.shSize} bytes) exceeds remaining ${maxScanBytes}-byte Stage A static audit scan cap`,
        };
      }
      const embBuf = await readSectionBounded(idx);
      if (embBuf === null) {
        return {
          symbols: [],
          maxRegisters: null,
          maxSpillBytes: null,
          embeddedTexts: [],
          scanError: `ELF embedded PTX section "${secName}" exceeded ${maxScanBytes}-byte Stage A static audit scan cap`,
        };
      }
      if (embBuf.byteLength > 0) {
        embeddedTexts.push(embBuf.toString('latin1'));
      }
    }
  }

  return {
    symbols: [...symbols],
    maxRegisters,
    maxSpillBytes,
    embeddedTexts,
    scanError: null,
  };
}

async function parseMachO64FromHandle(
  fh: Awaited<ReturnType<typeof open>>,
  fileSize: number,
  maxScanBytes: number,
): Promise<ParsedArtifactStaticInfo> {
  if (fileSize < 32 || fileSize > maxScanBytes) {
    return {
      symbols: [],
      maxRegisters: null,
      maxSpillBytes: null,
      embeddedTexts: [],
      scanError: fileSize > maxScanBytes
        ? `Mach-O binary exceeds ${maxScanBytes}-byte Stage A static audit scan cap`
        : 'truncated Mach-O header',
    };
  }
  const buf = Buffer.allocUnsafe(fileSize);
  await readExactFromHandle(fh, buf, fileSize, 0);
  const magic = buf.readUInt32LE(0);
  const isLE = magic === 0xfeedfacf;
  const readU32 = (off: number): number => (isLE ? buf.readUInt32LE(off) : buf.readUInt32BE(off));
  const ncmds = readU32(16);
  const sizeofcmds = readU32(20);
  if (ncmds > 2048 || 32 + sizeofcmds > fileSize) {
    return { symbols: [], maxRegisters: null, maxSpillBytes: null, embeddedTexts: [], scanError: 'malformed Mach-O load commands' };
  }
  const symbols = new Set<string>();
  let cmdOff = 32;
  for (let i = 0; i < ncmds && cmdOff + 8 <= 32 + sizeofcmds; i += 1) {
    const cmd = readU32(cmdOff);
    const cmdsize = readU32(cmdOff + 4);
    if (cmdsize < 8 || cmdOff + cmdsize > fileSize) break;
    // LC_SYMTAB = 0x2
    if (cmd === 0x2 && cmdsize >= 24) {
      const symoff = readU32(cmdOff + 8);
      const nsyms = readU32(cmdOff + 12);
      const stroff = readU32(cmdOff + 16);
      const strsize = readU32(cmdOff + 20);
      if (symoff + nsyms * 16 <= fileSize && stroff + strsize <= fileSize && nsyms <= 131_072) {
        const strSlice = buf.subarray(stroff, stroff + strsize);
        for (let s = 0; s < nsyms; s += 1) {
          const nStrx = readU32(symoff + s * 16);
          if (nStrx > 0 && nStrx < strSlice.byteLength) {
            const name = readNullTerminatedCString(strSlice, nStrx);
            if (name.length > 0) symbols.add(name);
          }
        }
      }
    }
    cmdOff += cmdsize;
  }
  return { symbols: [...symbols], maxRegisters: null, maxSpillBytes: null, embeddedTexts: [], scanError: null };
}

function stripCAndAsmComments(source: string): string {
  // Remove /* ... */ block comments and // ... line comments while preserving newlines.
  return source
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/\/\/[^\r\n]*/g, '');
}

function parseTextAndPtxStaticInfo(rawText: string, fileName: string): {
  readonly tokensAndLines: readonly string[];
  readonly maxRegisters: number | null;
  readonly maxSpillBytes: number | null;
} {
  let maxRegisters: number | null = null;
  let maxSpillBytes: number | null = null;
  const lowerName = fileName.toLowerCase();

  // 1. Parse compiler/ptxas/cuobjdump/assembler resource metrics across full text (including header comments).
  for (const m of rawText.matchAll(/\bUsed\s+(\d+)\s+registers\b/gi)) {
    const n = Number.parseInt(m[1]!, 10);
    if (Number.isSafeInteger(n) && n >= 0) maxRegisters = Math.max(maxRegisters ?? 0, n);
  }
  for (const m of rawText.matchAll(/\b(?:registerCount|register_count|vgpr_count)\s*[:=]\s*(\d+)\b/gi)) {
    const n = Number.parseInt(m[1]!, 10);
    if (Number.isSafeInteger(n) && n >= 0) maxRegisters = Math.max(maxRegisters ?? 0, n);
  }
  for (const m of rawText.matchAll(/\bREG\s*:\s*(\d+)\b/g)) {
    const n = Number.parseInt(m[1]!, 10);
    if (Number.isSafeInteger(n) && n >= 0) maxRegisters = Math.max(maxRegisters ?? 0, n);
  }
  for (const m of rawText.matchAll(/\b(\d+)\s+bytes\s+spill\s+(?:stores|loads)\b/gi)) {
    const n = Number.parseInt(m[1]!, 10);
    if (Number.isSafeInteger(n) && n >= 0) maxSpillBytes = Math.max(maxSpillBytes ?? 0, n);
  }
  for (const m of rawText.matchAll(/\b(\d+)\s+bytes\s+lmem\b/gi)) {
    const n = Number.parseInt(m[1]!, 10);
    if (Number.isSafeInteger(n) && n >= 0) maxSpillBytes = Math.max(maxSpillBytes ?? 0, n);
  }
  for (const m of rawText.matchAll(/\b(?:lmem|localSpillBytes|local_spill_bytes|spill_bytes)\s*[:=]\s*(\d+)\b/gi)) {
    const n = Number.parseInt(m[1]!, 10);
    if (Number.isSafeInteger(n) && n >= 0) maxSpillBytes = Math.max(maxSpillBytes ?? 0, n);
  }

  // 2. Strip comments before scanning code tokens/directives and PTX .reg / .local declarations.
  const codeOnly = stripCAndAsmComments(rawText);

  if (lowerName.endsWith('.ptx') || /\.version\s+\d+\.\d+/.test(codeOnly)) {
    // Split by `.entry` / `.func` definitions so per-kernel register and local spill budgets are measured accurately.
    const kernelScopes = codeOnly.split(/(?=\.(?:visible\s+|extern\s+|weak\s+)*(?:entry|func)\b)/g);
    for (const scope of kernelScopes) {
      let scopeRegs = 0;
      let sawRegs = false;
      for (const regMatch of scope.matchAll(/\.reg\s+(?:\.align\s+\d+\s+)?(\.[A-Za-z0-9_]+)\s+([^;]+);/g)) {
        const regType = regMatch[1]!.toLowerCase();
        if (regType === '.pred') continue;
        const declList = regMatch[2]!;
        const paramRange = /<(\d+)>/.exec(declList);
        if (paramRange !== null) {
          const count = Number.parseInt(paramRange[1]!, 10);
          if (Number.isSafeInteger(count) && count >= 0) {
            scopeRegs += count;
            sawRegs = true;
          }
        } else {
          const count = declList.split(',').map(s => s.trim()).filter(Boolean).length;
          if (count > 0) {
            scopeRegs += count;
            sawRegs = true;
          }
        }
      }
      if (sawRegs) {
        maxRegisters = Math.max(maxRegisters ?? 0, scopeRegs);
      }

      let scopeLocalBytes = 0;
      let sawLocal = false;
      for (const locMatch of scope.matchAll(
        /\.local\s+(?:\.align\s+\d+\s+)?\.(?:b|u|s|f)(8|16|32|64|128)(?:x(\d+))?\s+([^;]+);/g,
      )) {
        const bitWidth = Number.parseInt(locMatch[1]!, 10);
        const vecWidth = locMatch[2] !== undefined ? Number.parseInt(locMatch[2], 10) : 1;
        const elemBytes = (bitWidth / 8) * vecWidth;
        const decls = locMatch[3]!.split(',').map(s => s.trim()).filter(Boolean);
        for (const decl of decls) {
          const arrMatch = /\[(\d+)\]/.exec(decl);
          const count = arrMatch !== null ? Number.parseInt(arrMatch[1]!, 10) : 1;
          if (Number.isSafeInteger(count) && count > 0) {
            scopeLocalBytes += elemBytes * count;
            sawLocal = true;
          }
        }
      }
      if (sawLocal) {
        maxSpillBytes = Math.max(maxSpillBytes ?? 0, scopeLocalBytes);
      }
    }
  }

  // Structured JSON resource metadata support
  if (lowerName.endsWith('.json')) {
    try {
      const parsedJson = parseStrictJsonBytes(
        Buffer.from(rawText, 'utf8'),
        MAX_STAGE_A_AUDIT_SCAN_BYTES,
        'ARTIFACT_INVALID',
        '/resourceJson',
      );
      const jsonSymbols: string[] = [];
      const walkJson = (node: unknown, depth: number): void => {
        if (depth > 16 || node === null || typeof node !== 'object') return;
        if (Array.isArray(node)) {
          for (const item of node) walkJson(item, depth + 1);
          return;
        }
        const rec = node as Readonly<Record<string, unknown>>;
        for (const key of Object.keys(rec)) {
          if (!Object.hasOwn(rec, key)) continue;
          const val = rec[key];
          if (
            (key === 'registerCount' || key === 'registers' || key === 'num_regs')
            && typeof val === 'number'
            && Number.isSafeInteger(val)
            && val >= 0
          ) {
            maxRegisters = Math.max(maxRegisters ?? 0, val);
          } else if (
            (key === 'localSpillBytes' || key === 'spillBytes' || key === 'lmemBytes')
            && typeof val === 'number'
            && Number.isSafeInteger(val)
            && val >= 0
          ) {
            maxSpillBytes = Math.max(maxSpillBytes ?? 0, val);
          } else if (key === 'symbols' && Array.isArray(val)) {
            for (const s of val) {
              if (typeof s === 'string') jsonSymbols.push(s);
            }
          } else {
            walkJson(val, depth + 1);
          }
        }
      };
      walkJson(parsedJson, 0);
      if (jsonSymbols.length > 0) {
        return {
          tokensAndLines: jsonSymbols,
          maxRegisters,
          maxSpillBytes,
        };
      }
    } catch {
      // Non-JSON or malformed JSON falls through to line/token text scan.
    }
  }

  const tokensAndLines: string[] = [];
  for (const rawLine of codeOnly.split(/\r?\n/)) {
    const trimmed = rawLine.trim();
    if (trimmed.length === 0) continue;
    tokensAndLines.push(trimmed);
    for (const tokMatch of trimmed.matchAll(/[A-Za-z_$][A-Za-z0-9_$:@.]*/g)) {
      tokensAndLines.push(tokMatch[0]!);
    }
  }

  return { tokensAndLines, maxRegisters, maxSpillBytes };
}

const defaultStageAAuditToolRunner: StageAAuditToolRunner = (
  _tool,
  executablePath,
  args,
  options,
): Promise<{ readonly exitCode: number; readonly stdout: string; readonly stderr: string }> => {
  return new Promise((resolveCmd, rejectCmd) => {
    const child = execFile(
      executablePath,
      [...args],
      {
        shell: false,
        cwd: '/',
        env: {
          PATH: '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
          LANG: 'C',
          LC_ALL: 'C',
        },
        timeout: options.timeoutMs,
        maxBuffer: options.maxOutputBytes,
        killSignal: 'SIGKILL',
        windowsHide: true,
      },
      (error, stdout, stderr) => {
        options.signal?.removeEventListener('abort', onAbort);
        if (error !== null) {
          const errno = error as NodeJS.ErrnoException & { code?: string | number; killed?: boolean };
          if (errno.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') {
            rejectCmd(new Error(`audit tool output exceeded ${options.maxOutputBytes} bytes`));
            return;
          }
          if (errno.killed || errno.code === 'ETIMEDOUT') {
            rejectCmd(new Error('audit tool timed out'));
            return;
          }
          if (typeof errno.code === 'number') {
            resolveCmd({ exitCode: errno.code, stdout: String(stdout ?? ''), stderr: String(stderr ?? '') });
            return;
          }
          rejectCmd(error);
          return;
        }
        resolveCmd({ exitCode: 0, stdout: String(stdout ?? ''), stderr: String(stderr ?? '') });
      },
    );
    const onAbort = () => child.kill('SIGKILL');
    options.signal?.addEventListener('abort', onAbort, { once: true });
  });
};

function resolveOptionalTrustedAuditTool(
  baseAllowlist: readonly string[],
  toolchainPaths: readonly string[],
  binaryName: 'nm' | 'cuobjdump',
): string | null {
  const candidates: string[] = [...baseAllowlist];
  for (const tc of toolchainPaths) {
    candidates.push(join(tc, 'bin', binaryName), join(tc, binaryName));
  }
  const uniqueCandidates = [...new Set(candidates.map(p => resolve(p)))];
  for (const cand of uniqueCandidates) {
    try {
      return verifyTrustedSystemExecutableSync(cand, uniqueCandidates, {}, `Stage A ${binaryName}`);
    } catch {
      // Optional host tool not installed or not root-owned.
    }
  }
  return null;
}

/**
 * Deterministically audit sealed Stage A outputs (`.so`, `.o`, `.cubin`, `.ptx`, `.sass`, and
 * resource reports) using `O_NOFOLLOW`, `nlink === 1`, bounded `<= 1 MiB` reads, pure-TypeScript
 * ELF/Mach-O/PTX/SASS parsers, and optional root-owned `nm`/`cuobjdump` inspection on Linux/CUDA hosts.
 */
export async function auditSealedStageAOutputs(
  options: AuditSealedStageAOutputsOptions,
): Promise<StageAStaticAuditResult> {
  const { sealedOutputs, auditSpec, scrubber } = options;
  validateAuditSpecInputs(auditSpec);

  const patterns = auditSpec.forbiddenSymbolPatterns ?? [];
  const hasRules =
    patterns.length > 0
    || auditSpec.maxRegisterCount !== undefined
    || auditSpec.maxLocalSpillBytes !== undefined;
  if (!hasRules || sealedOutputs.length === 0) {
    return Object.freeze({ passed: true, findings: Object.freeze([]) });
  }

  const maxScanBytes = options.maxScanBytes ?? MAX_STAGE_A_AUDIT_SCAN_BYTES;
  const noFollow = 'O_NOFOLLOW' in constants ? constants.O_NOFOLLOW : 0;
  const findings: StructuredFinding[] = [];

  const pushAuditFinding = (title: string, relPath: string, evidence: string): void => {
    if (findings.length >= LIMITS.findings) return;
    const safeTitle = boundDiagnosticSnippet(title, scrubber, LIMITS.findingTitle) || 'Stage A static audit violation';
    const safeEvidence = boundDiagnosticSnippet(evidence, scrubber, LIMITS.findingEvidence) || STAGE_A_STATIC_AUDIT_FAILED;
    const built: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
    built.title = safeTitle;
    built.severity = 'high';
    built.path = relPath;
    built.evidence = safeEvidence;
    findings.push(Object.freeze(built as unknown as StructuredFinding));
  };

  const useHostTools = options.auditToolRunner !== undefined
    || (options.enableHostAuditTools ?? process.platform === 'linux');
  const toolRunner = options.auditToolRunner ?? defaultStageAAuditToolRunner;
  const tcPaths = options.toolchainPaths ?? [];
  const resolvedNm = useHostTools
    ? (options.auditToolRunner !== undefined ? '/usr/bin/nm' : resolveOptionalTrustedAuditTool(TRUSTED_NM_PATHS, tcPaths, 'nm'))
    : null;
  const resolvedCuobjdump = useHostTools
    ? (
        options.auditToolRunner !== undefined
          ? '/usr/local/cuda/bin/cuobjdump'
          : resolveOptionalTrustedAuditTool(TRUSTED_CUOBJDUMP_PATHS, tcPaths, 'cuobjdump')
      )
    : null;

  for (const item of sealedOutputs) {
    if (options.signal?.aborted) {
      throw new HardwareRunnerError('RUNNER_SANDBOX_FAILED', 'Stage A static audit aborted');
    }
    const relName = validateSafeRelativeArtifactPath(item.artifact.name, '/outputArtifacts');
    await assertNoSymlinkAncestors(item.sealedFilePath, {
      checkLeaf: true,
      code: 'ARTIFACT_INVALID',
      diagPath: `/outputArtifacts/${relName}`,
    });

    const preStat = await lstat(item.sealedFilePath).catch(() => null);
    if (preStat === null || preStat.isSymbolicLink() || !preStat.isFile() || preStat.nlink !== 1) {
      throw new HardwareRunnerError(
        'ARTIFACT_INVALID',
        `Stage A output "${relName}" failed O_NOFOLLOW/nlink===1 verification before static audit`,
      );
    }

    const fh = await open(item.sealedFilePath, constants.O_RDONLY | noFollow).catch(() => {
      throw new HardwareRunnerError('ARTIFACT_INVALID', `unable to open sealed Stage A output "${relName}" with O_NOFOLLOW`);
    });

    let isElf: boolean;
    let parsedInfo: ParsedArtifactStaticInfo | null = null;
    let textContent: string | null = null;

    try {
      const st = await fh.stat();
      if (
        !st.isFile()
        || st.isSymbolicLink()
        || st.nlink !== 1
        || st.dev !== preStat.dev
        || st.ino !== preStat.ino
        || st.size !== item.artifact.byteLength
      ) {
        throw new HardwareRunnerError('ARTIFACT_INVALID', `sealed Stage A output "${relName}" mutated before static audit`);
      }
      const fileSize = st.size;
      if (fileSize === 0) continue;

      const magicLen = Math.min(8, fileSize);
      const magicHeader = Buffer.allocUnsafe(magicLen);
      await readExactFromHandle(fh, magicHeader, magicLen, 0);

      isElf =
        magicLen >= 4
        && magicHeader[0] === 0x7f
        && magicHeader[1] === 0x45
        && magicHeader[2] === 0x4c
        && magicHeader[3] === 0x46;
      const magic32 = magicLen >= 4 ? magicHeader.readUInt32LE(0) : 0;
      const isMachO64 = magicLen >= 4 && (magic32 === 0xfeedfacf || magic32 === 0xcffaedfe);

      const shouldInspectAsBinary = isElf || isMachO64 || AUDIT_BINARY_EXT_RE.test(relName);
      const shouldInspectAsText = !isElf && !isMachO64 && (AUDIT_TEXT_EXT_RE.test(relName) || AUDIT_BINARY_EXT_RE.test(relName));

      if (!shouldInspectAsBinary && !shouldInspectAsText) {
        continue;
      }

      if (isElf) {
        parsedInfo = await parseElfFromHandle(fh, fileSize, maxScanBytes);
      } else if (isMachO64) {
        parsedInfo = await parseMachO64FromHandle(fh, fileSize, maxScanBytes);
      } else {
        if (fileSize > maxScanBytes) {
          pushAuditFinding(
            'Stage A output exceeds static audit 1 MiB scan limit',
            relName,
            `File "${relName}" (${fileSize} bytes) exceeds ${maxScanBytes}-byte (1 MiB) Stage A static audit scan cap`,
          );
          continue;
        }
        const rawBuf = Buffer.allocUnsafe(fileSize);
        await readExactFromHandle(fh, rawBuf, fileSize, 0);
        textContent = rawBuf.toString('utf8');
      }
    } finally {
      await fh.close();
    }

    if (parsedInfo !== null) {
      if (parsedInfo.scanError !== null) {
        pushAuditFinding(
          'Stage A binary failed static audit inspection',
          relName,
          `File "${relName}": ${parsedInfo.scanError}`,
        );
        continue;
      }

      const candidateSymbols = new Set<string>(parsedInfo.symbols);
      let maxRegisters = parsedInfo.maxRegisters;
      let maxSpillBytes = parsedInfo.maxSpillBytes;

      for (const emb of parsedInfo.embeddedTexts) {
        const embParsed = parseTextAndPtxStaticInfo(emb, `${relName}.ptx`);
        for (const t of embParsed.tokensAndLines) candidateSymbols.add(t);
        if (embParsed.maxRegisters !== null) maxRegisters = Math.max(maxRegisters ?? 0, embParsed.maxRegisters);
        if (embParsed.maxSpillBytes !== null) maxSpillBytes = Math.max(maxSpillBytes ?? 0, embParsed.maxSpillBytes);
      }

      const verifySealedInodeUnchanged = async (toolLabel: string): Promise<boolean> => {
        try {
          const recheck = await lstat(item.sealedFilePath);
          if (
            !recheck.isFile()
            || recheck.isSymbolicLink()
            || recheck.nlink !== 1
            || recheck.dev !== preStat.dev
            || recheck.ino !== preStat.ino
            || recheck.size !== item.artifact.byteLength
          ) {
            pushAuditFinding(
              `Stage A file mutated before ${toolLabel} static audit`,
              relName,
              `File "${relName}" inode or size changed between sealed read and ${toolLabel} invocation`,
            );
            return false;
          }
          return true;
        } catch (statErr: unknown) {
          pushAuditFinding(
            `Stage A file unavailable before ${toolLabel} static audit`,
            relName,
            `File "${relName}" lstat failed before ${toolLabel}: ${statErr instanceof Error ? statErr.message : String(statErr)}`,
          );
          return false;
        }
      };

      // Optional root-owned Linux/CUDA host toolchain inspection (`nm` / `cuobjdump`, 1 MiB stdout cap)
      if (isElf && resolvedNm !== null) {
        for (const nmFlags of [['-a', item.sealedFilePath], ['-D', item.sealedFilePath]]) {
          if (!(await verifySealedInodeUnchanged('nm'))) break;
          try {
            const nmRes = await toolRunner('nm', resolvedNm, nmFlags, {
              timeoutMs: 10_000,
              maxOutputBytes: maxScanBytes,
              ...(options.signal !== undefined ? { signal: options.signal } : {}),
            });
            if (nmRes.exitCode === 0 && nmRes.stdout.length > 0) {
              for (const line of nmRes.stdout.split(/\r?\n/)) {
                const symPart = line.trim().split(/\s+/).pop();
                if (symPart) candidateSymbols.add(symPart);
              }
            }
          } catch (toolErr: unknown) {
            const msg = toolErr instanceof Error ? toolErr.message : String(toolErr);
            const title = msg.includes('exceeded')
              ? 'Stage A nm output exceeded 1 MiB static audit cap'
              : 'Stage A nm static audit invocation failed';
            pushAuditFinding(title, relName, `File "${relName}": ${msg}`);
          }
        }
      }

      if (isElf && resolvedCuobjdump !== null && /\.(?:cubin|fatbin|so|o)$/i.test(relName)) {
        if (await verifySealedInodeUnchanged('cuobjdump')) {
          try {
            const cuRes = await toolRunner(
              'cuobjdump',
              resolvedCuobjdump,
              ['--dump-resource-usage', '--dump-elf-symbols', item.sealedFilePath],
              {
                timeoutMs: 10_000,
                maxOutputBytes: maxScanBytes,
                ...(options.signal !== undefined ? { signal: options.signal } : {}),
              },
            );
            if (cuRes.exitCode === 0 && cuRes.stdout.length > 0) {
              const cuParsed = parseTextAndPtxStaticInfo(cuRes.stdout, `${relName}.sass`);
              for (const tok of cuParsed.tokensAndLines) candidateSymbols.add(tok);
              if (cuParsed.maxRegisters !== null) maxRegisters = Math.max(maxRegisters ?? 0, cuParsed.maxRegisters);
              if (cuParsed.maxSpillBytes !== null) maxSpillBytes = Math.max(maxSpillBytes ?? 0, cuParsed.maxSpillBytes);
            }
          } catch (toolErr: unknown) {
            const msg = toolErr instanceof Error ? toolErr.message : String(toolErr);
            const title = msg.includes('exceeded')
              ? 'Stage A cuobjdump output exceeded 1 MiB static audit cap'
              : 'Stage A cuobjdump static audit invocation failed';
            pushAuditFinding(title, relName, `File "${relName}": ${msg}`);
          }
        }
      }

      if (patterns.length > 0) {
        const matchedPairs = new Set<string>();
        for (const rawSym of candidateSymbols) {
          const expanded = expandDemangledSymbolForms(rawSym);
          for (const pat of patterns) {
            if (expanded.some(form => form.includes(pat))) {
              const pairKey = `${pat}\0${rawSym}`;
              if (!matchedPairs.has(pairKey)) {
                matchedPairs.add(pairKey);
                pushAuditFinding(
                  `Forbidden symbol pattern "${pat}" in Stage A binary`,
                  relName,
                  `File "${relName}" matched forbidden symbol pattern "${pat}" on symbol "${rawSym}"`,
                );
              }
            }
          }
        }
      }

      if (auditSpec.maxRegisterCount !== undefined && maxRegisters !== null && maxRegisters > auditSpec.maxRegisterCount) {
        pushAuditFinding(
          'Stage A kernel exceeded maxRegisterCount ceiling',
          relName,
          `File "${relName}" uses ${maxRegisters} registers (maxRegisterCount=${auditSpec.maxRegisterCount})`,
        );
      }

      if (auditSpec.maxLocalSpillBytes !== undefined && maxSpillBytes !== null && maxSpillBytes > auditSpec.maxLocalSpillBytes) {
        pushAuditFinding(
          'Stage A kernel exceeded maxLocalSpillBytes ceiling',
          relName,
          `File "${relName}" has ${maxSpillBytes} local spill/frame bytes (maxLocalSpillBytes=${auditSpec.maxLocalSpillBytes})`,
        );
      }
      continue;
    }

    if (textContent !== null) {
      const parsedText = parseTextAndPtxStaticInfo(textContent, relName);
      if (patterns.length > 0) {
        const reportedPatterns = new Set<string>();
        for (const tokenOrLine of parsedText.tokensAndLines) {
          const forms = tokenOrLine.includes('_Z') ? expandDemangledSymbolForms(tokenOrLine) : [tokenOrLine];
          for (const pat of patterns) {
            if (!reportedPatterns.has(pat) && forms.some(f => f.includes(pat))) {
              reportedPatterns.add(pat);
              pushAuditFinding(
                `Forbidden symbol pattern "${pat}" in Stage A output`,
                relName,
                `File "${relName}" matched forbidden symbol pattern "${pat}" in "${tokenOrLine.slice(0, 160)}"`,
              );
            }
          }
        }
      }

      if (
        auditSpec.maxRegisterCount !== undefined
        && parsedText.maxRegisters !== null
        && parsedText.maxRegisters > auditSpec.maxRegisterCount
      ) {
        pushAuditFinding(
          'Stage A output exceeded maxRegisterCount ceiling',
          relName,
          `File "${relName}" uses ${parsedText.maxRegisters} registers (maxRegisterCount=${auditSpec.maxRegisterCount})`,
        );
      }

      if (
        auditSpec.maxLocalSpillBytes !== undefined
        && parsedText.maxSpillBytes !== null
        && parsedText.maxSpillBytes > auditSpec.maxLocalSpillBytes
      ) {
        pushAuditFinding(
          'Stage A output exceeded maxLocalSpillBytes ceiling',
          relName,
          `File "${relName}" has ${parsedText.maxSpillBytes} local spill bytes (maxLocalSpillBytes=${auditSpec.maxLocalSpillBytes})`,
        );
      }
    }
  }

  return Object.freeze({
    passed: findings.length === 0,
    findings: Object.freeze(findings),
  });
}

function assertNoDecodedSecret(value: string, scrubber: SecretScrubber): void {
  if (scrubber.containsSecret(value)) {
    throw new HardwareRunnerError('ARTIFACT_INVALID', 'Stage B result envelope rejected by SecretScrubber');
  }
}

function parseEnvelopeMetrics(raw: unknown, scrubber: SecretScrubber): MetricsMap {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new HardwareRunnerError('ARTIFACT_INVALID', 'Stage B metrics must be an object', '/metrics');
  }
  const rec = raw as Record<string, unknown>;
  const keys = Object.keys(rec).sort();
  if (keys.length > LIMITS.metricEntries) {
    throw new HardwareRunnerError('ARTIFACT_INVALID', 'Stage B metrics exceeds maximum entries', '/metrics');
  }
  const out: Record<string, MetricValue> = Object.create(null) as Record<string, MetricValue>;
  for (let idx = 0; idx < keys.length; idx += 1) {
    const key = keys[idx]!;
    if (!Object.hasOwn(rec, key)) continue;
    assertNoDecodedSecret(key, scrubber);
    if (key.length < 1 || key.length > LIMITS.metricKey || FORBIDDEN_METRIC_KEYS.has(key) || !METRIC_KEY_RE.test(key)) {
      throw new HardwareRunnerError('ARTIFACT_INVALID', `invalid Stage B metric key at index ${idx}`, '/metrics');
    }
    const val = rec[key];
    if (typeof val !== 'number' || !Number.isFinite(val) || Object.is(val, -0)) {
      throw new HardwareRunnerError('ARTIFACT_INVALID', `Stage B metric "${key}" must be a finite numeric value`, `/metrics/${key}`);
    }
    out[key] = val;
  }
  return Object.freeze(out);
}

function parseEnvelopeFindings(raw: unknown, scrubber: SecretScrubber): readonly StructuredFinding[] {
  if (!Array.isArray(raw) || raw.length > LIMITS.findings) {
    throw new HardwareRunnerError('ARTIFACT_INVALID', 'Stage B findings must be a bounded array', '/findings');
  }
  const out: StructuredFinding[] = raw.map((item, idx) => {
    const fPath = `/findings/${idx}`;
    const obj = expectNullProtoRecord(item, FINDING_KEYS, ['title', 'severity', 'evidence'], 'ARTIFACT_INVALID', fPath);
    if (typeof obj.title !== 'string' || obj.title.length < 1 || obj.title.length > LIMITS.findingTitle || hasLoneSurrogate(obj.title)) {
      throw new HardwareRunnerError('ARTIFACT_INVALID', 'invalid Stage B finding title', `${fPath}/title`);
    }
    assertNoDecodedSecret(obj.title, scrubber);
    if (obj.severity !== 'critical' && obj.severity !== 'high' && obj.severity !== 'medium' && obj.severity !== 'low') {
      throw new HardwareRunnerError('ARTIFACT_INVALID', 'invalid Stage B finding severity', `${fPath}/severity`);
    }
    const severity: FindingSeverity = obj.severity;
    if (typeof obj.evidence !== 'string' || obj.evidence.length < 1 || obj.evidence.length > LIMITS.findingEvidence || hasLoneSurrogate(obj.evidence)) {
      throw new HardwareRunnerError('ARTIFACT_INVALID', 'invalid Stage B finding evidence', `${fPath}/evidence`);
    }
    assertNoDecodedSecret(obj.evidence, scrubber);
    let relPath: string | null | undefined;
    if (Object.hasOwn(obj, 'path')) {
      if (obj.path === null) {
        relPath = null;
      } else if (typeof obj.path === 'string') {
        assertNoDecodedSecret(obj.path, scrubber);
        const v = validateRelativePath(obj.path);
        if (!v.ok) {
          throw new HardwareRunnerError('ARTIFACT_INVALID', 'invalid Stage B finding path', `${fPath}/path`);
        }
        relPath = v.value;
      } else {
        throw new HardwareRunnerError('ARTIFACT_INVALID', 'invalid Stage B finding path type', `${fPath}/path`);
      }
    }
    let line: number | null | undefined;
    if (Object.hasOwn(obj, 'line')) {
      if (obj.line === null) {
        line = null;
      } else if (typeof obj.line === 'number' && Number.isSafeInteger(obj.line) && !Object.is(obj.line, -0) && obj.line >= 1) {
        line = obj.line;
      } else {
        throw new HardwareRunnerError('ARTIFACT_INVALID', 'invalid Stage B finding line', `${fPath}/line`);
      }
    }

    const built: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
    built.title = obj.title;
    built.severity = severity;
    if (relPath !== undefined) built.path = relPath;
    if (line !== undefined) built.line = line;
    built.evidence = obj.evidence;
    return Object.freeze(built as unknown as StructuredFinding);
  });
  return Object.freeze(out);
}

function assertNoRawInvalidStageBNumbers(value: unknown, path: string, depth = 0): void {
  if (depth > 32) {
    throw new HardwareRunnerError('ARTIFACT_INVALID', 'Stage B structure exceeds maximum depth', path);
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || Object.is(value, -0)) {
      throw new HardwareRunnerError('ARTIFACT_INVALID', 'Stage B numeric value must be finite and not -0', path);
    }
    return;
  }
  if (typeof value === 'string') {
    if (hasLoneSurrogate(value)) {
      throw new HardwareRunnerError('ARTIFACT_INVALID', 'Stage B string contains lone UTF-16 surrogate', path);
    }
    return;
  }
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i += 1) {
      assertNoRawInvalidStageBNumbers(value[i], `${path}/${i}`, depth + 1);
    }
    return;
  }
  if (value !== null && typeof value === 'object') {
    const rec = value as Readonly<Record<string, unknown>>;
    for (const key of Reflect.ownKeys(rec)) {
      if (typeof key !== 'string' || FORBIDDEN_METRIC_KEYS.has(key) || hasLoneSurrogate(key)) {
        throw new HardwareRunnerError('ARTIFACT_INVALID', 'forbidden key in Stage B result envelope', path);
      }
      assertNoRawInvalidStageBNumbers(rec[key], `${path}/${key}`, depth + 1);
    }
  }
}

function parseEnvelopeBucketMetrics(raw: unknown, scrubber: SecretScrubber): readonly BucketMetricEntry[] {
  assertNoRawInvalidStageBNumbers(raw, '/stageB/bucketMetrics');
  const validated = validateBucketMetrics(raw, scrubber);
  if (!validated.ok) {
    const first = validated.errors[0];
    throw new HardwareRunnerError(
      'ARTIFACT_INVALID',
      `invalid Stage B bucketMetrics (${first?.code ?? 'INVALID'})`,
      first?.path ? `/stageB/bucketMetrics${first.path}` : '/stageB/bucketMetrics',
    );
  }
  return validated.value;
}

function parseEnvelopeHardwareDiagnostics(raw: unknown, scrubber: SecretScrubber): HardwareDiagnostics {
  assertNoRawInvalidStageBNumbers(raw, '/stageB/hardwareDiagnostics');
  const validated = validateHardwareDiagnostics(raw, scrubber);
  if (!validated.ok) {
    const first = validated.errors[0];
    throw new HardwareRunnerError(
      'ARTIFACT_INVALID',
      `invalid Stage B hardwareDiagnostics (${first?.code ?? 'INVALID'})`,
      first?.path ? `/stageB/hardwareDiagnostics${first.path}` : '/stageB/hardwareDiagnostics',
    );
  }
  return validated.value;
}

/**
 * Parse and validate the bounded (`<= 48 KiB`) Stage B JSON result envelope into null-prototype
 * structures, accepting ONLY finite numeric metrics, bounded `bucketMetrics`, and closed-enum
 * sanitized `hardwareDiagnostics` while scanning all decoded strings/keys with `SecretScrubber`.
 */
export function parseStageBResultEnvelope(
  rawStdout: string,
  scrubber: SecretScrubber,
): StageBResultEnvelope {
  if (typeof rawStdout !== 'string') {
    throw new HardwareRunnerError('ARTIFACT_INVALID', 'Stage B stdout must be a string');
  }
  const lines = rawStdout.split(/\r?\n/);
  const markerLines = lines.filter(line => line.startsWith(STAGE_B_RESULT_MARKER_PREFIX));
  let jsonCandidate: string;
  if (markerLines.length > 1) {
    throw new HardwareRunnerError('ARTIFACT_INVALID', 'multiple LOOPWRIGHT_STAGE_B_RESULT markers in Stage B stdout');
  }
  if (markerLines.length === 1) {
    jsonCandidate = markerLines[0]!.slice(STAGE_B_RESULT_MARKER_PREFIX.length).trim();
  } else {
    jsonCandidate = rawStdout.trim();
  }

  const rawBytes = Buffer.from(jsonCandidate, 'utf8');
  if (rawBytes.byteLength === 0) {
    throw new HardwareRunnerError('ARTIFACT_INVALID', 'empty Stage B JSON result envelope');
  }
  if (rawBytes.byteLength > MAX_STAGE_B_RESULT_BYTES) {
    throw new HardwareRunnerError('PAYLOAD_TOO_LARGE', `Stage B result envelope exceeds ${MAX_STAGE_B_RESULT_BYTES} bytes`);
  }
  assertNoDecodedSecret(jsonCandidate, scrubber);

  const parsed = parseStrictJsonBytes(rawBytes, MAX_STAGE_B_RESULT_BYTES, 'ARTIFACT_INVALID', '/stageB');
  const obj = expectNullProtoRecord(parsed, STAGE_B_ENVELOPE_KEYS, ['status'], 'ARTIFACT_INVALID', '/stageB');
  if (obj.status !== 'approved' && obj.status !== 'denied') {
    throw new HardwareRunnerError('ARTIFACT_INVALID', 'Stage B status must be "approved" or "denied"', '/stageB/status');
  }

  let reason: string | null;
  if (Object.hasOwn(obj, 'reason')) {
    if (obj.reason === null) {
      reason = obj.status === 'approved' ? null : 'BENCHMARK_DENIED';
    } else if (typeof obj.reason === 'string' && obj.reason.length >= 1 && obj.reason.length <= 256 && !hasLoneSurrogate(obj.reason)) {
      assertNoDecodedSecret(obj.reason, scrubber);
      if (obj.status === 'approved') {
        throw new HardwareRunnerError('ARTIFACT_INVALID', 'Stage B approved envelope must not specify non-null reason', '/stageB/reason');
      }
      reason = obj.reason;
    } else {
      throw new HardwareRunnerError('ARTIFACT_INVALID', 'invalid Stage B reason string', '/stageB/reason');
    }
  } else {
    reason = obj.status === 'approved' ? null : 'BENCHMARK_DENIED';
  }

  let detail: string | null | undefined;
  if (Object.hasOwn(obj, 'detail')) {
    if (obj.detail === null) {
      detail = null;
    } else if (typeof obj.detail === 'string' && obj.detail.length >= 1 && obj.detail.length <= LIMITS.string && !hasLoneSurrogate(obj.detail)) {
      assertNoDecodedSecret(obj.detail, scrubber);
      detail = obj.detail;
    } else {
      throw new HardwareRunnerError('ARTIFACT_INVALID', 'invalid Stage B detail field', '/stageB/detail');
    }
  }

  const metrics = Object.hasOwn(obj, 'metrics') ? parseEnvelopeMetrics(obj.metrics, scrubber) : undefined;
  const findings = Object.hasOwn(obj, 'findings') ? parseEnvelopeFindings(obj.findings, scrubber) : undefined;
  const bucketMetrics = Object.hasOwn(obj, 'bucketMetrics')
    ? parseEnvelopeBucketMetrics(obj.bucketMetrics, scrubber)
    : undefined;
  const hardwareDiagnostics = Object.hasOwn(obj, 'hardwareDiagnostics')
    ? parseEnvelopeHardwareDiagnostics(obj.hardwareDiagnostics, scrubber)
    : undefined;

  const out: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  out.status = obj.status;
  out.reason = reason;
  if (detail !== undefined) out.detail = detail;
  if (metrics !== undefined) out.metrics = metrics;
  if (findings !== undefined) out.findings = findings;
  if (bucketMetrics !== undefined) out.bucketMetrics = bucketMetrics;
  if (hardwareDiagnostics !== undefined) out.hardwareDiagnostics = hardwareDiagnostics;
  assertNoDecodedSecret(canonicalJson(out), scrubber);
  return Object.freeze(out as unknown as StageBResultEnvelope);
}

function readFiniteMetricValue(metrics: MetricsMap, key: string): number | undefined {
  if (!Object.hasOwn(metrics, key)) return undefined;
  const val = metrics[key];
  if (typeof val !== 'number' || !Number.isFinite(val)) return undefined;
  return Object.is(val, -0) ? 0 : val;
}

function checkSingleScopeMetricRule(
  rule: MetricThresholdRule,
  metrics: MetricsMap,
  scopePrefix: string,
): string | null {
  const observed = readFiniteMetricValue(metrics, rule.metric);
  if (observed === undefined) {
    return `${scopePrefix}missing numeric metric "${rule.metric}"`;
  }
  if (rule.kind === 'bounds') {
    if (rule.min !== undefined && observed < rule.min) {
      return `${scopePrefix}metric "${rule.metric}" (${observed}) is below min ${rule.min}`;
    }
    if (rule.max !== undefined && observed > rule.max) {
      return `${scopePrefix}metric "${rule.metric}" (${observed}) exceeds max ${rule.max}`;
    }
    return null;
  }
  const baseline = readFiniteMetricValue(metrics, rule.baselineMetric);
  if (baseline === undefined) {
    return `${scopePrefix}missing numeric baseline metric "${rule.baselineMetric}"`;
  }
  if (rule.operator === 'min_ratio') {
    if (!(baseline > 0) || observed / baseline < rule.threshold) {
      return `${scopePrefix}comparative ratio ${rule.metric}/${rule.baselineMetric} failed min_ratio ${rule.threshold}`;
    }
  } else if (rule.operator === 'max_ratio') {
    if (!(baseline > 0) || observed / baseline > rule.threshold) {
      return `${scopePrefix}comparative ratio ${rule.metric}/${rule.baselineMetric} failed max_ratio ${rule.threshold}`;
    }
  } else if (observed - baseline > rule.threshold) {
    return `${scopePrefix}comparative delta ${rule.metric}-${rule.baselineMetric} failed max_delta ${rule.threshold}`;
  }
  return null;
}

function checkMetricThresholds(
  rules: readonly MetricThresholdRule[],
  metrics: MetricsMap | undefined,
  bucketMetrics?: readonly BucketMetricEntry[],
): string | null {
  if (rules.length === 0) return null;
  for (const rule of rules) {
    const scope = rule.bucketScope ?? 'aggregate';
    if (scope === 'aggregate') {
      if (metrics === undefined) {
        return 'required quantitative metrics map is missing from Stage B output';
      }
      const err = checkSingleScopeMetricRule(rule, metrics, '');
      if (err !== null) return err;
      continue;
    }
    if (bucketMetrics === undefined || bucketMetrics.length === 0) {
      return 'required bucketMetrics list is missing from Stage B output for bucket-scoped threshold rule';
    }
    if (scope === 'all_buckets') {
      for (const bucket of bucketMetrics) {
        const err = checkSingleScopeMetricRule(rule, bucket.metrics, `bucket "${bucket.bucketId}": `);
        if (err !== null) return err;
      }
      continue;
    }
    const targetBucket = bucketMetrics.find(entry => entry.bucketId === scope.bucketId);
    if (targetBucket === undefined) {
      return `target bucket "${scope.bucketId}" is missing from Stage B bucketMetrics`;
    }
    const err = checkSingleScopeMetricRule(rule, targetBucket.metrics, `bucket "${targetBucket.bucketId}": `);
    if (err !== null) return err;
  }
  return null;
}

/**
 * Recursively remove a directory or file tree fail-closed without ever calling `chmod` on regular
 * files (preserving multiply linked inode permissions), restoring `0o700` on directories only so
 * sealed entries can be unlinked, propagating removal errors, and verifying `ENOENT` on completion.
 */
export async function removeTreeFailClosed(targetPath: string): Promise<void> {
  const resolved = resolve(targetPath);
  const removeNode = async (current: string, depth: number): Promise<void> => {
    if (depth > 64) {
      throw new RunnerTeardownError(`cleanup path "${resolved}" exceeds maximum nesting depth`);
    }
    let st;
    try {
      st = await lstat(current);
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') return;
      throw new RunnerTeardownError(
        `failed to inspect path "${current}" during cleanup: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    if (st.isSymbolicLink() || !st.isDirectory()) {
      // NEVER chmod regular files (which could mutate a multiply linked inode); unlink directory entry directly.
      try {
        await unlink(current);
      } catch (err: unknown) {
        if ((err as NodeJS.ErrnoException)?.code !== 'ENOENT') {
          throw new RunnerTeardownError(
            `failed to unlink "${current}" during cleanup: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }
      return;
    }

    if ((st.mode & 0o700) !== 0o700) {
      try {
        await chmod(current, 0o700);
      } catch (err: unknown) {
        throw new RunnerTeardownError(
          `failed to restore directory permissions on "${current}" during cleanup: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

    let entries;
    try {
      entries = await readdir(current);
    } catch (err: unknown) {
      throw new RunnerTeardownError(
        `failed to list directory "${current}" during cleanup: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    for (const name of entries) {
      await removeNode(join(current, name), depth + 1);
    }

    try {
      await rmdir(current);
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException)?.code !== 'ENOENT') {
        throw new RunnerTeardownError(
          `failed to remove directory "${current}" during cleanup: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
  };

  await removeNode(resolved, 0);

  const postStat = await lstat(resolved).catch((err: unknown) => {
    if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') return null;
    throw new RunnerTeardownError(
      `failed to verify removal of "${resolved}": ${err instanceof Error ? err.message : String(err)}`,
    );
  });
  if (postStat !== null) {
    throw new RunnerTeardownError(`cleanup verification failed: "${resolved}" still exists`);
  }
}

async function discoverStageACandidateScript(candidateDir: string): Promise<string | null> {
  for (const rel of STAGE_A_CANDIDATE_ENTRYPOINTS) {
    const abs = join(candidateDir, ...rel.split('/'));
    const st = await lstat(abs).catch(() => null);
    if (st !== null && !st.isSymbolicLink() && st.isFile() && (st.mode & 0o111) !== 0) {
      return rel;
    }
  }
  return null;
}

async function discoverStageBWorkloadScript(
  workloadDir: string,
): Promise<{ readonly relPath: string; readonly directExec: boolean }> {
  for (const rel of STAGE_B_WORKLOAD_ENTRYPOINTS) {
    const abs = join(workloadDir, ...rel.split('/'));
    const st = await lstat(abs).catch(() => null);
    if (st !== null && !st.isSymbolicLink() && st.isFile()) {
      return { relPath: rel, directExec: (st.mode & 0o111) !== 0 };
    }
  }
  throw new HardwareRunnerError(
    'CONFIG_INVALID',
    `worker held-out workload is missing a trusted Stage B entrypoint (${STAGE_B_WORKLOAD_ENTRYPOINTS.join(', ')})`,
    '/heldOutWorkloadsDir',
  );
}

function buildSanitizedPathEnv(toolchainPaths: readonly string[], isDocker: boolean): string {
  const defaults = isDocker
    ? ['/usr/local/nvidia/bin', '/usr/local/cuda/bin', '/opt/rocm/bin', '/usr/local/bin', '/usr/bin', '/bin']
    : ['/usr/local/cuda/bin', '/opt/rocm/bin', '/usr/local/bin', '/usr/bin', '/bin'];
  return [...toolchainPaths, ...defaults].join(':');
}

function buildDeviceVisibilityEnv(targetHardware: HardwareTargetSpec): Record<string, string> {
  const count = targetHardware.deviceCount ?? 1;
  const csv = buildVisibleDevicesCsv(count);
  const accel = targetHardware.accelerator.toLowerCase();
  if (accel.startsWith('sm_')) return { CUDA_VISIBLE_DEVICES: csv };
  if (accel.startsWith('gfx')) return { ROCR_VISIBLE_DEVICES: csv, HIP_VISIBLE_DEVICES: csv };
  if (accel.startsWith('ascend')) return { ASCEND_RT_VISIBLE_DEVICES: csv };
  return {};
}

function boundDiagnosticSnippet(text: string, scrubber: SecretScrubber, maxChars: number = LIMITS.findingEvidence): string {
  const scrubbed = scrubber.scrub(text).trim();
  if (!scrubbed) return '';
  if (scrubbed.length <= maxChars) return scrubbed;
  const suffix = '...(truncated)';
  if (maxChars <= suffix.length) {
    let end = Math.max(0, maxChars);
    if (end > 0) {
      const lastCode = scrubbed.charCodeAt(end - 1);
      if (lastCode >= 0xd800 && lastCode <= 0xdbff) end -= 1;
    }
    return scrubbed.slice(0, end);
  }
  let end = maxChars - suffix.length;
  if (end > 0) {
    const lastCode = scrubbed.charCodeAt(end - 1);
    if (lastCode >= 0xd800 && lastCode <= 0xdbff) end -= 1;
  }
  return `${scrubbed.slice(0, end)}${suffix}`;
}

function buildSupervisorStageBFailureDiag(result: StageProcessExecutionResult): string {
  if (result.exitCode !== null) {
    return `Stage B exited with code ${String(result.exitCode)}`;
  }
  if (result.signal !== null) {
    return `Stage B terminated by signal ${result.signal}`;
  }
  return 'Stage B execution failed';
}

async function writePrivateSeccompProfileFile(filePath: string): Promise<void> {
  const noFollow = 'O_NOFOLLOW' in constants ? constants.O_NOFOLLOW : 0;
  const fh = await open(
    filePath,
    constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | noFollow,
    0o600,
  );
  try {
    const jsonBytes = Buffer.from(buildDockerStageBSeccompProfileJson(), 'utf8');
    await writeAllToHandle(fh, jsonBytes);
    await fh.chmod(0o400);
    await fh.sync();
  } finally {
    await fh.close();
  }
}

/**
 * Execute the full two-stage zero-trust blind evaluation for a leased hardware benchmark job:
 * - Snapshots `held_out_workloads/<id>` into an immutable `0o500`/`0o400` private job snapshot before Stage A.
 * - Stage A: isolated compile on frozen candidate tree WITHOUT `held_out_workloads`, sealing `.cubin`/`.o`/`.sass` outputs `0o400`.
 * - Stage B: isolated blind correctness + benchmark with ONLY the single immutable workload snapshot and sealed `stage-a-out/` read-only, kernel socket denial, and ZERO exported files or raw stderr disclosure.
 */
export async function evaluateBenchmarkJob(options: EvaluateBenchmarkJobOptions): Promise<EvaluatedBenchmarkJob> {
  const { config, grant } = options;
  const { job } = grant;
  const processRunner = options.processRunner ?? defaultStageProcessRunner;
  const probeCollector = options.probe ?? collectHardwareProvenance;

  if (config.sandboxBackend === 'native_os' && config.probeMode === 'physical') {
    throw new HardwareRunnerError(
      'RUNNER_SANDBOX_FAILED',
      'native_os sandbox backend cannot enforce isolated physical accelerator device allocation; docker backend is required',
    );
  }

  const resolvedWorkDir = resolve(config.workDir);
  const resolvedWorkloadsDir = resolve(config.heldOutWorkloadsDir);
  const resolvedTlsCa = config.tlsCaPath !== undefined ? resolve(config.tlsCaPath) : undefined;
  if (pathsOverlap(resolvedWorkDir, resolvedWorkloadsDir)) {
    throw new HardwareRunnerError(
      'CONFIG_INVALID',
      'workDir and heldOutWorkloadsDir must be disjoint directories',
      '/heldOutWorkloadsDir',
    );
  }
  if (resolvedTlsCa !== undefined && (pathsOverlap(resolvedWorkDir, resolvedTlsCa) || pathsOverlap(resolvedWorkloadsDir, resolvedTlsCa))) {
    throw new HardwareRunnerError(
      'CONFIG_INVALID',
      'tlsCaPath must be disjoint from workDir and heldOutWorkloadsDir',
      '/tlsCaPath',
    );
  }

  await assertNoSymlinkAncestors(resolvedWorkDir, {
    checkLeaf: true,
    code: 'CONFIG_INVALID',
    diagPath: '/workDir',
  });
  await mkdir(resolvedWorkDir, { recursive: true, mode: 0o700 });
  const workDirStat = await lstat(resolvedWorkDir);
  if (workDirStat.isSymbolicLink() || !workDirStat.isDirectory()) {
    throw new HardwareRunnerError('CONFIG_INVALID', 'workDir must be a non-symlink directory', '/workDir');
  }
  await chmod(resolvedWorkDir, 0o700);

  for (const tcPath of config.toolchainPaths) {
    if (isDockerSocketPath(tcPath)) {
      throw new HardwareRunnerError('RUNNER_SANDBOX_FAILED', 'toolchainPaths must not reference container sockets');
    }
    await assertNoSymlinkAncestors(tcPath, {
      checkLeaf: true,
      code: 'CONFIG_INVALID',
      diagPath: '/toolchainPaths',
    });
  }

  const deadlineChecker = resolveMonotonicDeadlineChecker(options);
  assertLeaseDeadlineNotExpired(deadlineChecker, 'evaluator entry', options.signal);

  const baseForbiddenHostPaths = [
    resolvedWorkDir,
    resolvedWorkloadsDir,
    ...(resolvedTlsCa !== undefined ? [resolvedTlsCa] : []),
  ];
  const probeHostExecutables = options.host?.probeExecutables ?? true;
  const canonicalToolchainPaths = validateAndCanonicalizeToolchainMountsSync({
    toolchainPaths: config.toolchainPaths,
    forbiddenPaths: baseForbiddenHostPaths,
    requireExistingOnDisk: probeHostExecutables,
    ...(deadlineChecker !== undefined ? { deadlineChecker } : {}),
    ...(options.signal !== undefined ? { signal: options.signal } : {}),
  });

  // Register worker secrets and lease tokens into SecretScrubber; NEVER pass secrets into sandbox env!
  const scrubber = new SecretScrubber();
  const registeredSecrets: string[] = [config.workerToken, grant.leaseToken, ...(options.extraSecrets ?? [])];
  for (const sec of registeredSecrets) {
    if (typeof sec === 'string' && sec.length > 0) {
      scrubber.register(sec);
    }
  }
  const secretOverlapBytes = computeSecretScanOverlapBytes(registeredSecrets);

  const supervisorDir = join(resolvedWorkDir, `job-${grant.jobId.replace(/[^A-Za-z0-9_.-]/g, '_')}-ep${grant.leaseEpoch}-${randomBytes(6).toString('hex')}`);
  const jobRoot = supervisorDir;
  const internalSupervisorDir = join(jobRoot, 'supervisor');
  const workloadSnapshotDir = join(internalSupervisorDir, 'workload-snapshot');
  const stageARoot = join(jobRoot, 'stage-a');
  const candidateDir = join(stageARoot, 'candidate');
  const stageAOutDir = join(stageARoot, 'stage-a-out');
  const stageAScratchDir = join(stageARoot, 'scratch');
  const stageBRoot = join(jobRoot, 'stage-b');
  const stageBScratchDir = join(stageBRoot, 'scratch');

  await mkdir(jobRoot, { mode: 0o700 });

  let keepJobRootForUpload = false;
  let cleanedUpJobRoot = false;
  let sealedOutputs: readonly SealedStageAArtifact[] = Object.freeze([]);
  const cleanupJobRoot = async (cleanupOpts?: EvaluatedJobCleanupOptions): Promise<void> => {
    if (cleanedUpJobRoot) return;
    if (cleanupOpts?.preserveSealedOutputs === true && sealedOutputs.length > 0) {
      await removeTreeFailClosed(internalSupervisorDir);
      await removeTreeFailClosed(stageBRoot);
      await removeTreeFailClosed(candidateDir);
      await removeTreeFailClosed(stageAScratchDir);
      return;
    }
    await removeTreeFailClosed(jobRoot);
    cleanedUpJobRoot = true;
  };

  let primaryEvalErr: unknown;
  let finalCleanupErr: unknown = null;
  try {
    // Cleanup ownership is active immediately after mkdir(jobRoot) — BEFORE subdirectory creation!
    assertLeaseDeadlineNotExpired(deadlineChecker, 'jobRoot setup', options.signal);
    await assertNoSymlinkAncestors(jobRoot, { checkLeaf: true, code: 'RUNNER_SANDBOX_FAILED', diagPath: '/workDir' });

    await mkdir(internalSupervisorDir, { mode: 0o700 });
    await mkdir(stageARoot, { mode: 0o700 });
    await mkdir(candidateDir, { mode: 0o755 });
    await mkdir(stageAOutDir, { mode: 0o700 });
    await mkdir(stageAScratchDir, { mode: 0o700 });

    // Snapshot worker-owned held_out_workloads/<id> BEFORE Stage A starts.
    // Classify any worker-owned workload missing/corrupt error as worker infrastructure (NEVER candidate denial!).
    assertLeaseDeadlineNotExpired(deadlineChecker, 'held-out workload snapshot', options.signal);
    let workloadSnapshot: Awaited<ReturnType<typeof snapshotHeldOutWorkload>>;
    try {
      workloadSnapshot = await snapshotHeldOutWorkload(
        resolvedWorkloadsDir,
        job.heldOutWorkloadId,
        workloadSnapshotDir,
        options.signal !== undefined ? { signal: options.signal } : {},
      );
    } catch (wlErr: unknown) {
      if (isRunnerTeardownError(wlErr)) throw wlErr;
      if (wlErr instanceof HardwareRunnerError && wlErr.code === 'QUEUE_LEASE_FENCED') throw wlErr;
      if (options.signal?.aborted) {
        throw new HardwareRunnerError('RUNNER_SANDBOX_FAILED', 'held-out workload snapshot aborted');
      }
      if (wlErr instanceof HardwareRunnerError && (wlErr.code === 'CONFIG_INVALID' || wlErr.code === 'RUNNER_SANDBOX_FAILED')) {
        throw wlErr;
      }
      throw new HardwareRunnerError(
        'CONFIG_INVALID',
        wlErr instanceof Error ? wlErr.message : 'failed to snapshot worker held-out workload',
        '/heldOutWorkloadsDir',
        { cause: wlErr },
      );
    }

    const isDocker = config.sandboxBackend === 'docker';
    const targetDeviceCount = job.targetHardware.deviceCount ?? 1;
    const isRocmTarget = job.targetHardware.accelerator.toLowerCase().startsWith('gfx');

    // Resolve allocated device identity ONCE so both physical provenance and Docker stages bind identical GPU(s)!
    let resolvedRocmNodes: readonly string[] | undefined = options.allocatedDeviceNodes;
    let resolvedDeviceIndices: readonly number[] | undefined = options.allocatedDeviceIndices;
    if (isRocmTarget && (isDocker || options.allocatedDeviceNodes !== undefined || options.allocatedDeviceIndices !== undefined)) {
      const requireRocmIndexMapping =
        config.probeMode === 'physical'
        && (probeHostExecutables || options.sysfsRoot !== undefined || options.probe === undefined);
      const rocmAllocation = resolveAllocatedRocmDevicesSync({
        deviceCount: targetDeviceCount,
        ...(options.allocatedDeviceNodes !== undefined ? { explicitNodes: options.allocatedDeviceNodes } : {}),
        ...(options.allocatedDeviceIndices !== undefined ? { explicitIndices: options.allocatedDeviceIndices } : {}),
        ...(options.sysfsRoot !== undefined ? { sysfsRoot: options.sysfsRoot } : {}),
        ...(options.devRoot !== undefined ? { devRoot: options.devRoot } : {}),
        verifyCharDevices: isDocker && probeHostExecutables,
        requireIndexMapping: requireRocmIndexMapping,
      });
      resolvedRocmNodes = rocmAllocation.renderNodes;
      if (rocmAllocation.deviceIndices !== undefined) {
        resolvedDeviceIndices = rocmAllocation.deviceIndices;
      }
    } else if (resolvedDeviceIndices !== undefined) {
      resolvedDeviceIndices = validateExplicitDeviceIndices(resolvedDeviceIndices, targetDeviceCount, 64);
    }

    assertLeaseDeadlineNotExpired(deadlineChecker, 'hardware provenance probe', options.signal);
    const hardwareProvenance = await probeCollector({
      probeMode: config.probeMode,
      targetCellId: job.targetCellId,
      targetHardware: job.targetHardware,
      capabilities: config.capabilities,
      workloadDigest: workloadSnapshot.digest,
      sandboxBackend: config.sandboxBackend,
      ...(resolvedDeviceIndices !== undefined ? { allocatedDeviceIndices: resolvedDeviceIndices } : {}),
      ...(options.signal !== undefined ? { signal: options.signal } : {}),
    });

    assertLeaseDeadlineNotExpired(deadlineChecker, 'candidate workspace reconstruction', options.signal);
    await reconstructCandidateWorkspace({
      candidateDir,
      candidateArtifacts: job.candidateArtifacts,
      downloadInputBlob: options.downloadInputBlob,
      ...(options.maxBlobBytes !== undefined ? { maxBlobBytes: options.maxBlobBytes } : {}),
      ...(options.signal !== undefined ? { signal: options.signal } : {}),
    });

    const pathEnv = buildSanitizedPathEnv(canonicalToolchainPaths, isDocker);
    const deviceVisEnv = buildDeviceVisibilityEnv(job.targetHardware);
    const dockerSeccompPath = join(internalSupervisorDir, 'docker-seccomp.json');
    if (isDocker) {
      await writePrivateSeccompProfileFile(dockerSeccompPath);
    }

    const deadlineInputFields = {
      ...(options.leaseDeadlineMonoMs !== undefined ? { leaseDeadlineMonoMs: options.leaseDeadlineMonoMs } : {}),
      ...(options.getLeaseDeadlineMonoMs !== undefined ? { getLeaseDeadlineMonoMs: options.getLeaseDeadlineMonoMs } : {}),
      ...(options.nowMonotonicMs !== undefined ? { nowMonotonicMs: options.nowMonotonicMs } : {}),
    };

    // -------------------------------------------------------------------------
    // Stage A: Candidate Compile (NO held_out_workloads or snapshot access!)
    // -------------------------------------------------------------------------
    let stageACmd: string;
    let stageAArgs: readonly string[];
    if (options.stageACommand !== undefined) {
      stageACmd = options.stageACommand.command;
      stageAArgs = options.stageACommand.args ?? [];
    } else {
      const discoveredRel = await discoverStageACandidateScript(candidateDir);
      if (discoveredRel === null) {
        await removeTreeFailClosed(internalSupervisorDir);
        await removeTreeFailClosed(stageARoot);
        const deniedNoEntry: EvaluatedBenchmarkJob = {
          status: 'denied',
          reason: 'STAGE_A_ENTRYPOINT_MISSING',
          detail: `No executable Stage A build script found (${STAGE_A_CANDIDATE_ENTRYPOINTS.join(', ')})`,
          findings: Object.freeze([
            Object.freeze({
              title: 'Missing executable Stage A build script',
              severity: 'high' as const,
              evidence: `Expected an executable build script at one of: ${STAGE_A_CANDIDATE_ENTRYPOINTS.join(', ')}`,
            }),
          ]),
          hardwareProvenance,
          sealedOutputs: Object.freeze([]),
          cleanup: cleanupJobRoot,
        };
        keepJobRootForUpload = true;
        return deniedNoEntry;
      }
      stageACmd = isDocker ? `/workspace/candidate/${discoveredRel}` : join(candidateDir, ...discoveredRel.split('/'));
      stageAArgs = [];
    }

    const stageAEnv: Record<string, string> = {
      PATH: pathEnv,
      HOME: isDocker ? '/scratch' : stageAScratchDir,
      TMPDIR: isDocker ? '/scratch' : stageAScratchDir,
      LANG: 'C.UTF-8',
      TERM: 'dumb',
      LOOPWRIGHT_STAGE: 'A',
      LOOPWRIGHT_CANDIDATE_DIR: isDocker ? '/workspace/candidate' : candidateDir,
      LOOPWRIGHT_STAGE_A_OUT: isDocker ? '/workspace/stage-a-out' : stageAOutDir,
      LOOPWRIGHT_TARGET_CELL_ID: job.targetCellId,
      LOOPWRIGHT_TARGET_ACCELERATOR: job.targetHardware.accelerator,
      ...deviceVisEnv,
    };

    const stageADeniedReadPaths = [
      resolvedWorkloadsDir,
      internalSupervisorDir,
      ...(resolvedTlsCa !== undefined ? [resolvedTlsCa] : []),
    ];

    const stageANativeSpec: NativeTwoStageSandboxSpec | undefined = isDocker
      ? undefined
      : {
          stage: 'A',
          candidateDir,
          stageAOutDir,
          scratchDir: stageAScratchDir,
          toolchainPaths: canonicalToolchainPaths,
          explicitDeniedReadPaths: stageADeniedReadPaths,
          probeMode: config.probeMode,
        };

    assertLeaseDeadlineNotExpired(deadlineChecker, 'Stage A launch preparation', options.signal);
    const stageADockerCompiled = isDocker
      ? compileDockerSandboxCommand({
          stage: 'A',
          dockerImage: config.dockerImage!,
          containerName: `lw-stage-a-${randomBytes(6).toString('hex')}`,
          targetHardware: job.targetHardware,
          candidateDir,
          stageAOutDir,
          toolchainPaths: canonicalToolchainPaths,
          forbiddenHostPaths: baseForbiddenHostPaths,
          seccompProfilePath: dockerSeccompPath,
          ...(resolvedRocmNodes !== undefined ? { allocatedDeviceNodes: resolvedRocmNodes } : {}),
          ...(resolvedDeviceIndices !== undefined ? { allocatedDeviceIndices: resolvedDeviceIndices } : {}),
          ...(options.sysfsRoot !== undefined ? { sysfsRoot: options.sysfsRoot } : {}),
          ...(options.devRoot !== undefined ? { devRoot: options.devRoot } : {}),
          command: stageACmd,
          args: stageAArgs,
          cwd: '/workspace/candidate',
          env: stageAEnv,
          ...(options.host !== undefined ? { host: options.host } : {}),
          ...(options.signal !== undefined ? { signal: options.signal } : {}),
          ...deadlineInputFields,
          ...(options._testOnlyTrustedDockerRoot !== undefined
            ? { _testOnlyTrustedDockerRoot: options._testOnlyTrustedDockerRoot }
            : {}),
        })
      : undefined;

    const stageAResult = await processRunner({
      stage: 'A',
      backend: config.sandboxBackend,
      command: stageACmd,
      args: stageAArgs,
      cwd: isDocker ? '/workspace/candidate' : candidateDir,
      env: stageAEnv,
      timeoutMs: config.stageATimeoutMs,
      probeMode: config.probeMode,
      ...(options.signal !== undefined ? { signal: options.signal } : {}),
      ...deadlineInputFields,
      ...(stageANativeSpec !== undefined ? { nativeStageSpec: stageANativeSpec } : {}),
      ...(stageADockerCompiled !== undefined ? { dockerCompiled: stageADockerCompiled } : {}),
      ...(options.host !== undefined ? { host: options.host } : {}),
    });

    if (stageAResult.timedOut || stageAResult.exitCode !== 0 || stageAResult.signal !== null) {
      await removeTreeFailClosed(internalSupervisorDir);
      await removeTreeFailClosed(stageARoot);
      const reason = stageAResult.timedOut ? 'STAGE_A_TIMEOUT' : 'STAGE_A_COMPILE_FAILED';
      const diag = boundDiagnosticSnippet(
        stageAResult.stderr || stageAResult.stdout || `Stage A exited with code ${String(stageAResult.exitCode)}`,
        scrubber,
      );
      keepJobRootForUpload = true;
      return Object.freeze({
        status: 'denied',
        reason,
        detail: diag || reason,
        findings: Object.freeze([
          Object.freeze({
            title: stageAResult.timedOut ? 'Stage A compilation timed out' : 'Stage A compilation failed',
            severity: 'high' as const,
            evidence: diag || reason,
          }),
        ]),
        hardwareProvenance,
        sealedOutputs: Object.freeze([]),
        cleanup: cleanupJobRoot,
      });
    }

    // Seal Stage A outputs (O_NOFOLLOW, nlink === 1, <= 64 files, SecretScrubber, 0o400) BEFORE Stage B starts!
    assertLeaseDeadlineNotExpired(deadlineChecker, 'Stage A output sealing', options.signal);
    sealedOutputs = await sealStageAOutputs({
      stageAOutDir,
      scrubber,
      secretOverlapBytes,
      ...(options.maxBlobBytes !== undefined ? { maxBlobBytes: options.maxBlobBytes } : {}),
      ...(options.signal !== undefined ? { signal: options.signal } : {}),
    });

    // Stage A Static Symbol & Spill Audit: inspect sealed outputs BEFORE mounting held_out_workloads or launching Stage B!
    const effectiveAuditSpec = resolveEffectiveStageAAuditSpec(job.targetHardware, job.stageAAudit);
    if (effectiveAuditSpec !== null) {
      assertLeaseDeadlineNotExpired(deadlineChecker, 'Stage A static symbol/spill audit', options.signal);
      const auditResult = await auditSealedStageAOutputs({
        sealedOutputs,
        auditSpec: effectiveAuditSpec,
        scrubber,
        toolchainPaths: canonicalToolchainPaths,
        ...(options.auditToolRunner !== undefined ? { auditToolRunner: options.auditToolRunner } : {}),
        ...(options.enableHostAuditTools !== undefined ? { enableHostAuditTools: options.enableHostAuditTools } : {}),
        ...(options.signal !== undefined ? { signal: options.signal } : {}),
      });
      if (!auditResult.passed) {
        sealedOutputs = Object.freeze([]);
        await removeTreeFailClosed(internalSupervisorDir);
        await removeTreeFailClosed(stageARoot);
        const primaryEvidence = auditResult.findings[0]?.evidence ?? STAGE_A_STATIC_AUDIT_FAILED;
        keepJobRootForUpload = true;
        return Object.freeze({
          status: 'denied',
          reason: STAGE_A_STATIC_AUDIT_FAILED,
          detail: primaryEvidence,
          findings: auditResult.findings,
          hardwareProvenance,
          sealedOutputs: Object.freeze([]),
          cleanup: cleanupJobRoot,
        });
      }
    }

    // Fail-closed removal + ENOENT verification of Stage A candidate source & scratch before Stage B begins!
    await removeTreeFailClosed(candidateDir);
    await removeTreeFailClosed(stageAScratchDir);

    // -------------------------------------------------------------------------
    // Stage B: Blind Correctness & Benchmark (immutable workload snapshot
    //          read-only, kernel socket denial, ZERO exported files!)
    // -------------------------------------------------------------------------
    await mkdir(stageBRoot, { mode: 0o700 });
    await mkdir(stageBScratchDir, { mode: 0o700 });

    let stageBResult: StageProcessExecutionResult | null = null;
    let stageBExecErr: unknown = null;
    try {
      let stageBCmd: string;
      let stageBArgs: readonly string[];
      if (options.stageBCommand !== undefined) {
        stageBCmd = options.stageBCommand.command;
        stageBArgs = options.stageBCommand.args ?? [];
      } else {
        const discoveredB = await discoverStageBWorkloadScript(workloadSnapshot.snapshotDir);
        const scriptInSandbox = isDocker
          ? `/workspace/workload/${discoveredB.relPath}`
          : join(workloadSnapshot.snapshotDir, ...discoveredB.relPath.split('/'));
        if (discoveredB.directExec) {
          stageBCmd = scriptInSandbox;
          stageBArgs = [];
        } else {
          stageBCmd = '/bin/sh';
          stageBArgs = [scriptInSandbox];
        }
      }

      const stageBEnv: Record<string, string> = {
        PATH: pathEnv,
        HOME: isDocker ? '/scratch' : stageBScratchDir,
        TMPDIR: isDocker ? '/scratch' : stageBScratchDir,
        LANG: 'C.UTF-8',
        TERM: 'dumb',
        LOOPWRIGHT_STAGE: 'B',
        LOOPWRIGHT_STAGE_A_OUT: isDocker ? '/workspace/stage-a-out' : stageAOutDir,
        LOOPWRIGHT_HELD_OUT_WORKLOAD_DIR: isDocker ? '/workspace/workload' : workloadSnapshot.snapshotDir,
        LOOPWRIGHT_HELD_OUT_WORKLOAD_ID: job.heldOutWorkloadId,
        LOOPWRIGHT_TARGET_CELL_ID: job.targetCellId,
        LOOPWRIGHT_TARGET_ACCELERATOR: job.targetHardware.accelerator,
        ...deviceVisEnv,
      };

      // Deny the entire live heldOutWorkloadsDir (including sibling workloads!) in Stage B;
      // Stage B may ONLY read its private immutable workloadSnapshotDir!
      const stageBDeniedPaths = [
        resolvedWorkloadsDir,
        ...(resolvedTlsCa !== undefined ? [resolvedTlsCa] : []),
      ];

      const stageBNativeSpec: NativeTwoStageSandboxSpec | undefined = isDocker
        ? undefined
        : {
            stage: 'B',
            stageAOutDir,
            workloadSnapshotDir: workloadSnapshot.snapshotDir,
            scratchDir: stageBScratchDir,
            toolchainPaths: canonicalToolchainPaths,
            explicitDeniedReadPaths: stageBDeniedPaths,
            probeMode: config.probeMode,
          };

      assertLeaseDeadlineNotExpired(deadlineChecker, 'Stage B launch preparation', options.signal);
      const stageBDockerCompiled = isDocker
        ? compileDockerSandboxCommand({
            stage: 'B',
            dockerImage: config.dockerImage!,
            containerName: `lw-stage-b-${randomBytes(6).toString('hex')}`,
            targetHardware: job.targetHardware,
            stageAOutDir,
            workloadDir: workloadSnapshot.snapshotDir,
            toolchainPaths: canonicalToolchainPaths,
            forbiddenHostPaths: baseForbiddenHostPaths,
            seccompProfilePath: dockerSeccompPath,
            ...(resolvedRocmNodes !== undefined ? { allocatedDeviceNodes: resolvedRocmNodes } : {}),
            ...(resolvedDeviceIndices !== undefined ? { allocatedDeviceIndices: resolvedDeviceIndices } : {}),
            ...(options.sysfsRoot !== undefined ? { sysfsRoot: options.sysfsRoot } : {}),
            ...(options.devRoot !== undefined ? { devRoot: options.devRoot } : {}),
            command: stageBCmd,
            args: stageBArgs,
            cwd: '/workspace/workload',
            env: stageBEnv,
            ...(options.host !== undefined ? { host: options.host } : {}),
            ...(options.signal !== undefined ? { signal: options.signal } : {}),
            ...deadlineInputFields,
            ...(options._testOnlyTrustedDockerRoot !== undefined
              ? { _testOnlyTrustedDockerRoot: options._testOnlyTrustedDockerRoot }
              : {}),
          })
        : undefined;

      stageBResult = await processRunner({
        stage: 'B',
        backend: config.sandboxBackend,
        command: stageBCmd,
        args: stageBArgs,
        cwd: isDocker ? '/workspace/workload' : workloadSnapshot.snapshotDir,
        env: stageBEnv,
        timeoutMs: config.stageBTimeoutMs,
        probeMode: config.probeMode,
        ...(options.signal !== undefined ? { signal: options.signal } : {}),
        ...deadlineInputFields,
        ...(stageBNativeSpec !== undefined ? { nativeStageSpec: stageBNativeSpec } : {}),
        ...(stageBDockerCompiled !== undefined ? { dockerCompiled: stageBDockerCompiled } : {}),
        ...(options.host !== undefined ? { host: options.host } : {}),
      });
    } catch (err: unknown) {
      stageBExecErr = err;
    }

    // Export ZERO files from Stage B! Fail-closed removal + ENOENT verification of Stage B scratch and workload snapshot!
    let stageBCleanupErr: unknown = null;
    try {
      await removeTreeFailClosed(stageBRoot);
    } catch (err: unknown) {
      stageBCleanupErr = err;
    }
    try {
      await removeTreeFailClosed(internalSupervisorDir);
    } catch (err: unknown) {
      stageBCleanupErr ??= err;
    }
    if (isRunnerTeardownError(stageBExecErr)) {
      throw stageBExecErr;
    }
    if (stageBCleanupErr !== null) {
      throw stageBCleanupErr;
    }
    if (stageBExecErr !== null) {
      throw stageBExecErr;
    }
    if (stageBResult === null) {
      throw new HardwareRunnerError('RUNNER_SANDBOX_FAILED', 'Stage B produced no execution result');
    }

    if (stageBResult.timedOut) {
      keepJobRootForUpload = true;
      return Object.freeze({
        status: 'denied',
        reason: 'STAGE_B_TIMEOUT',
        detail: `Stage B benchmark timed out after ${config.stageBTimeoutMs}ms`,
        findings: Object.freeze([
          Object.freeze({
            title: 'Stage B blind benchmark timed out',
            severity: 'high' as const,
            evidence: `Stage B exceeded ${config.stageBTimeoutMs}ms`,
          }),
        ]),
        hardwareProvenance,
        stageBFailure: Object.freeze({
          timedOut: true,
          exitCode: stageBResult.exitCode,
          signal: stageBResult.signal,
        }),
        sealedOutputs,
        cleanup: cleanupJobRoot,
      });
    }

    // Check nonzero exit or signal STRICTLY BEFORE parsing Stage B stdout so a failing or crashed
    // Stage B process can NEVER exfiltrate private held-out workload text via a denied JSON envelope!
    if (stageBResult.exitCode !== 0 || stageBResult.signal !== null) {
      const supervisorDiag = buildSupervisorStageBFailureDiag(stageBResult);
      keepJobRootForUpload = true;
      return Object.freeze({
        status: 'denied',
        reason: 'STAGE_B_EXECUTION_FAILED',
        detail: supervisorDiag,
        findings: Object.freeze([
          Object.freeze({
            title: 'Stage B blind evaluation failed',
            severity: 'high' as const,
            evidence: supervisorDiag,
          }),
        ]),
        hardwareProvenance,
        stageBFailure: Object.freeze({
          timedOut: false,
          exitCode: stageBResult.exitCode,
          signal: stageBResult.signal,
        }),
        sealedOutputs,
        cleanup: cleanupJobRoot,
      });
    }

    const envelope = parseStageBResultEnvelope(stageBResult.stdout, scrubber);

    let finalStatus = envelope.status;
    let finalReason = envelope.reason;
    let finalDetail = envelope.detail;
    let finalFindings = envelope.findings;

    if (finalStatus === 'approved') {
      const thresholdViolation = checkMetricThresholds(
        job.metricThresholds,
        envelope.metrics,
        envelope.bucketMetrics,
      );
      if (thresholdViolation !== null) {
        finalStatus = 'denied';
        finalReason = 'METRIC_THRESHOLD_FAILED';
        finalDetail = finalDetail ?? thresholdViolation;
        const thresholdFinding: StructuredFinding = Object.freeze({
          title: 'Quantitative metric threshold not met',
          severity: 'high' as const,
          evidence: thresholdViolation,
        });
        const existing = finalFindings ?? [];
        finalFindings = Object.freeze([
          ...existing.slice(0, Math.max(0, LIMITS.findings - 1)),
          thresholdFinding,
        ]);
      }
    }

    keepJobRootForUpload = true;
    return Object.freeze({
      status: finalStatus,
      reason: finalReason,
      ...(finalDetail !== undefined ? { detail: finalDetail } : {}),
      ...(envelope.metrics !== undefined ? { metrics: envelope.metrics } : {}),
      ...(finalFindings !== undefined ? { findings: finalFindings } : {}),
      ...(envelope.bucketMetrics !== undefined ? { bucketMetrics: envelope.bucketMetrics } : {}),
      ...(envelope.hardwareDiagnostics !== undefined ? { hardwareDiagnostics: envelope.hardwareDiagnostics } : {}),
      hardwareProvenance,
      sealedOutputs,
      cleanup: cleanupJobRoot,
    });
  } catch (err: unknown) {
    primaryEvalErr = err;
  } finally {
    if (!keepJobRootForUpload) {
      try {
        await cleanupJobRoot();
      } catch (cleanErr: unknown) {
        finalCleanupErr = cleanErr instanceof RunnerTeardownError
          ? cleanErr
          : new RunnerTeardownError(
              cleanErr instanceof Error ? cleanErr.message : 'failed to roll back jobRoot during cleanup',
              { cause: cleanErr },
            );
      }
    }
  }
  if (isRunnerTeardownError(primaryEvalErr)) {
    throw primaryEvalErr;
  }
  if (finalCleanupErr !== null) {
    throw finalCleanupErr;
  }
  throw primaryEvalErr;
}

export function createTwoStageEvaluator(
  defaults: Omit<EvaluateBenchmarkJobOptions, 'config' | 'grant' | 'downloadInputBlob' | 'signal'> = {},
): BenchmarkJobEvaluator {
  return options =>
    evaluateBenchmarkJob({
      ...defaults,
      ...options,
    });
}
