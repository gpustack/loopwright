import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { constants, lstatSync, realpathSync, type Stats } from 'node:fs';
import { chmod, lstat, mkdir, open, readdir, realpath, unlink } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve, sep } from 'node:path';
import {
  LIMITS,
  SecretScrubber,
  VERIFIER_ARTIFACT_LIMITS,
  type Digest,
  type HardwareProvenance,
  type HardwareTargetSpec,
  type StructuredFinding,
} from '@loopwright/core';
import {
  assertNoSymlinkAncestors,
  hasLoneSurrogate,
  parseStrictJsonBytes,
} from './config.js';
import { MAX_CAS_CHUNK_BYTES } from './relay-server.js';
import {
  HardwareRunnerError,
  type AcceleratorFaultKind,
  type AcceleratorHealthProbeResult,
  type WorkerCapabilities,
} from './types.js';

export const TRUSTED_NVIDIA_SMI_PATHS: readonly string[] = Object.freeze([
  '/usr/bin/nvidia-smi',
  '/usr/local/bin/nvidia-smi',
  '/bin/nvidia-smi',
]);

export const TRUSTED_ROCM_SMI_PATHS: readonly string[] = Object.freeze([
  '/opt/rocm/bin/rocm-smi',
  '/usr/bin/rocm-smi',
  '/usr/local/bin/rocm-smi',
]);

export const TRUSTED_ROCMINFO_PATHS: readonly string[] = Object.freeze([
  '/opt/rocm/bin/rocminfo',
  '/usr/bin/rocminfo',
  '/usr/local/bin/rocminfo',
]);

export const TRUSTED_NPU_SMI_PATHS: readonly string[] = Object.freeze([
  '/usr/local/Ascend/driver/tools/npu-smi',
  '/usr/local/sbin/npu-smi',
  '/usr/local/bin/npu-smi',
  '/usr/bin/npu-smi',
]);

export const WORKLOAD_TREE_DOMAIN = 'loopwright.dev/held-out-workload-tree/v1' as const;

const MAX_PROBE_OUTPUT_BYTES = 262_144;
const DEFAULT_PROBE_TIMEOUT_MS = 15_000;
const WORKLOAD_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const PRINTABLE_ASCII_RE = /^[\x20-\x7E]+$/;
const CONTROL_CHAR_RE = /[\r\n\t\p{C}]/u;
const ANSI_ESC_PREFIX = String.fromCharCode(0x1b) + '[';

function stripAnsiSequences(text: string): string {
  if (!text.includes(ANSI_ESC_PREFIX)) return text;
  let out = '';
  let idx = 0;
  while (idx < text.length) {
    if (text.startsWith(ANSI_ESC_PREFIX, idx)) {
      let end = idx + 2;
      while (end < text.length && /[0-9;]/.test(text[end]!)) end += 1;
      if (end < text.length && /[A-Za-z]/.test(text[end]!)) {
        idx = end + 1;
        continue;
      }
    }
    out += text[idx]!;
    idx += 1;
  }
  return out;
}

export const ROOT_OWNED_SYSTEM_PREFIXES: readonly string[] = Object.freeze([
  '/usr/',
  '/bin/',
  '/sbin/',
  '/lib/',
  '/lib64/',
  '/opt/',
  '/etc/alternatives/',
]);

export interface ProbeCommandResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

export type ProbeCommandRunner = (
  executablePath: string,
  args: readonly string[],
  options: { readonly timeoutMs: number; readonly signal?: AbortSignal },
) => Promise<ProbeCommandResult>;

export interface ParsedAcceleratorProbe {
  readonly vendor: 'nvidia' | 'amd' | 'huawei';
  readonly deviceModel: string;
  readonly accelerator: string;
  readonly isolationMode: 'whole_device' | 'sliced';
  readonly deviceCount: number;
  readonly driverVersion: string;
  readonly runtimeVersion: string;
  readonly topology?: string;
  readonly clockLockMode: 'locked' | 'unlocked' | 'unknown';
}

export interface ComputeWorkloadDigestOptions {
  readonly maxFiles?: number;
  readonly maxFileBytes?: number;
  readonly maxTotalBytes?: number;
  readonly maxDepth?: number;
  readonly signal?: AbortSignal;
}

export interface VerifyTrustedProbeExecutableOptions {
  readonly allowRootSystemSymlink?: boolean;
  /**
   * Test-only scoped directory override allowing unit tests on non-root hosts to verify
   * regular `0o555`/`0o500` mock executables inside a private temp tree without weakening
   * `uid === 0` + non-writable parent enforcement on system paths.
   */
  readonly _testOnlyTrustedRoot?: string;
}

export interface CollectHardwareProvenanceOptions {
  readonly probeMode: 'physical' | 'synthetic_fixture';
  readonly targetCellId: string;
  readonly targetHardware?: HardwareTargetSpec;
  readonly capabilities: WorkerCapabilities;
  readonly workloadDigest: Digest;
  readonly allocatedDeviceIndices?: readonly number[];
  readonly sandboxBackend?: 'native_os' | 'docker';
  readonly measuredRuntimeVersion?: string;
  readonly executableOverrides?: {
    readonly nvidiaSmiPath?: string;
    readonly rocmSmiPath?: string;
    readonly rocminfoPath?: string;
    readonly npuSmiPath?: string;
  };
  readonly commandRunner?: ProbeCommandRunner;
  readonly verifyExecutable?: (binaryPath: string, trustedAllowlist: readonly string[]) => Promise<string>;
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
}

function compareUtf16(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function sanitizePrintableField(raw: string, fallback: string, maxLen = 128, asciiOnly = false): string {
  const collapsed = raw.replace(/[\r\n\t]+/g, ' ').replace(/\s+/g, ' ').trim();
  if (collapsed.length === 0 || hasLoneSurrogate(collapsed) || CONTROL_CHAR_RE.test(collapsed)) {
    return fallback;
  }
  const clipped = collapsed.length > maxLen ? collapsed.slice(0, maxLen).trim() : collapsed;
  if (clipped.length === 0) return fallback;
  if (asciiOnly && !PRINTABLE_ASCII_RE.test(clipped)) {
    return fallback;
  }
  return clipped;
}

function isUnderRootSystemPrefix(candidatePath: string): boolean {
  return ROOT_OWNED_SYSTEM_PREFIXES.some(
    prefix =>
      candidatePath === prefix.replace(/\/$/, '')
      || candidatePath.startsWith(prefix.endsWith('/') ? prefix : `${prefix}/`),
  );
}

function isInsideOrEqualPath(candidatePath: string, rootPath: string): boolean {
  return candidatePath === rootPath || candidatePath.startsWith(rootPath.endsWith(sep) ? rootPath : `${rootPath}${sep}`);
}

function validateCleanExecutablePathString(binaryPath: string, label: string): string {
  if (
    typeof binaryPath !== 'string'
    || binaryPath.length === 0
    || binaryPath.length > 1024
    || /[\0\r\n]/.test(binaryPath)
    || hasLoneSurrogate(binaryPath)
    || !isAbsolute(binaryPath)
  ) {
    throw new HardwareRunnerError('RUNNER_SANDBOX_FAILED', `${label} executable path must be a clean absolute path`);
  }
  return resolve(binaryPath);
}

function inspectTrustedChainSync(
  targetPath: string,
  stopAtTestRoot: string | null,
  label: string,
): { readonly leafStat: Stats; readonly hasSymlinkInChain: boolean } {
  let cursor = resolve(targetPath);
  let depth = 0;
  let leafStat: Stats | null = null;
  let hasSymlinkInChain = false;
  const hostUid = typeof process.getuid === 'function' ? process.getuid() : null;

  while (true) {
    if (++depth > 64) {
      throw new HardwareRunnerError('RUNNER_SANDBOX_FAILED', `${label} executable path exceeds directory depth limit`);
    }
    let st: Stats;
    try {
      st = lstatSync(cursor);
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') {
        throw new HardwareRunnerError('RUNNER_SANDBOX_FAILED', `${label} executable "${targetPath}" is not installed`);
      }
      throw new HardwareRunnerError('RUNNER_SANDBOX_FAILED', `failed to inspect ${label} executable "${targetPath}"`);
    }
    if (leafStat === null) {
      leafStat = st;
    } else if (!st.isSymbolicLink() && !st.isDirectory()) {
      throw new HardwareRunnerError('RUNNER_SANDBOX_FAILED', `${label} executable ancestor "${cursor}" is not a directory`);
    }

    if (st.isSymbolicLink()) {
      hasSymlinkInChain = true;
    }

    const inScopedTestTree = stopAtTestRoot !== null && isInsideOrEqualPath(cursor, stopAtTestRoot);
    if (hostUid !== null) {
      if (inScopedTestTree) {
        if (st.uid !== 0 && st.uid !== hostUid) {
          throw new HardwareRunnerError(
            'RUNNER_SANDBOX_FAILED',
            `${label} executable path component "${cursor}" has untrusted owner uid ${st.uid}`,
          );
        }
      } else if (stopAtTestRoot === null && st.uid !== 0) {
        throw new HardwareRunnerError(
          'RUNNER_SANDBOX_FAILED',
          `${label} executable path component "${cursor}" must be owned by root (uid 0)`,
        );
      }
    }

    if (stopAtTestRoot === null || inScopedTestTree) {
      if (!st.isSymbolicLink() && (st.mode & 0o022) !== 0) {
        throw new HardwareRunnerError(
          'RUNNER_SANDBOX_FAILED',
          `${label} executable path component "${cursor}" must not be group or world writable`,
        );
      }
    }

    if (stopAtTestRoot !== null && cursor === stopAtTestRoot) {
      break;
    }
    const parent = dirname(cursor);
    if (parent === cursor) break;
    cursor = parent;
  }

  return { leafStat: leafStat!, hasSymlinkInChain };
}

function assertLeafExecutableSafe(leafStat: Stats, targetPath: string, scopedTestMode: boolean, label: string): void {
  if (!leafStat.isFile() || leafStat.isSymbolicLink() || (leafStat.mode & 0o111) === 0) {
    throw new HardwareRunnerError('RUNNER_SANDBOX_FAILED', `${label} executable "${targetPath}" is not an executable regular file`);
  }
  if ((leafStat.mode & 0o022) !== 0) {
    throw new HardwareRunnerError('RUNNER_SANDBOX_FAILED', `${label} executable "${targetPath}" must not be group or world writable`);
  }
  const hostUid = typeof process.getuid === 'function' ? process.getuid() : null;
  if (hostUid !== null) {
    if (!scopedTestMode && leafStat.uid !== 0) {
      throw new HardwareRunnerError('RUNNER_SANDBOX_FAILED', `${label} executable "${targetPath}" must be owned by root (uid 0)`);
    }
    if (leafStat.uid !== 0 && (leafStat.mode & 0o200) !== 0) {
      throw new HardwareRunnerError(
        'RUNNER_SANDBOX_FAILED',
        `non-root ${label} executable "${targetPath}" must not be owner-writable (expected mode 0555 or 0500)`,
      );
    }
  }
}

/**
 * Synchronously verify that `binaryPath` is an element of `trustedAllowlist`, is owned by `uid === 0`
 * across every path component and resolved symlink target, has no group/world-writable file or parent
 * directory, and resolves to an executable regular file.
 */
export function verifyTrustedSystemExecutableSync(
  binaryPath: string,
  trustedAllowlist: readonly string[],
  options: VerifyTrustedProbeExecutableOptions = {},
  label = 'hardware probe',
): string {
  const normalized = validateCleanExecutablePathString(binaryPath, label);
  if (!trustedAllowlist.includes(normalized)) {
    throw new HardwareRunnerError(
      'RUNNER_SANDBOX_FAILED',
      `untrusted ${label} executable "${binaryPath}"`,
    );
  }

  const allowRootSymlink = options.allowRootSystemSymlink !== false;
  const scopedTestRoot = options._testOnlyTrustedRoot !== undefined ? resolve(options._testOnlyTrustedRoot) : null;
  if (scopedTestRoot !== null && !isInsideOrEqualPath(normalized, scopedTestRoot)) {
    throw new HardwareRunnerError(
      'RUNNER_SANDBOX_FAILED',
      `${label} executable "${normalized}" is outside _testOnlyTrustedRoot`,
    );
  }

  const launcherCheck = inspectTrustedChainSync(normalized, scopedTestRoot, label);
  if (launcherCheck.hasSymlinkInChain) {
    if (!allowRootSymlink || scopedTestRoot !== null) {
      throw new HardwareRunnerError('RUNNER_SANDBOX_FAILED', `${label} executable "${normalized}" must not traverse symlinks`);
    }
    if (!isUnderRootSystemPrefix(normalized)) {
      throw new HardwareRunnerError(
        'RUNNER_SANDBOX_FAILED',
        `symlinked ${label} executable "${normalized}" is outside trusted system prefixes`,
      );
    }
    let resolvedReal: string;
    try {
      resolvedReal = realpathSync(normalized);
    } catch {
      throw new HardwareRunnerError('RUNNER_SANDBOX_FAILED', `failed to resolve symlinked ${label} executable "${normalized}"`);
    }
    if (!isUnderRootSystemPrefix(resolvedReal)) {
      throw new HardwareRunnerError(
        'RUNNER_SANDBOX_FAILED',
        `${label} executable "${normalized}" resolves outside trusted system prefixes`,
      );
    }
    const targetCheck = inspectTrustedChainSync(resolvedReal, null, label);
    if (targetCheck.hasSymlinkInChain) {
      throw new HardwareRunnerError('RUNNER_SANDBOX_FAILED', `resolved ${label} executable "${resolvedReal}" still contains symlinks`);
    }
    assertLeafExecutableSafe(targetCheck.leafStat, resolvedReal, false, label);
    return resolvedReal;
  }

  if (scopedTestRoot === null && !isUnderRootSystemPrefix(normalized)) {
    throw new HardwareRunnerError(
      'RUNNER_SANDBOX_FAILED',
      `${label} executable "${normalized}" is outside trusted system prefixes`,
    );
  }
  assertLeafExecutableSafe(launcherCheck.leafStat, normalized, scopedTestRoot !== null, label);
  return normalized;
}

/**
 * Verify that `binaryPath` is an element of `trustedAllowlist`, is owned by root (`uid === 0`) across
 * both launcher path and resolved target, has no group/world-writable components, and is an executable
 * regular file.
 */
export async function verifyTrustedProbeExecutable(
  binaryPath: string,
  trustedAllowlist: readonly string[],
  options: VerifyTrustedProbeExecutableOptions = {},
): Promise<string> {
  return verifyTrustedSystemExecutableSync(binaryPath, trustedAllowlist, options, 'hardware probe');
}

async function resolveFirstTrustedProbeExecutable(
  explicitPath: string | undefined,
  trustedAllowlist: readonly string[],
  verifier: (binaryPath: string, trustedAllowlist: readonly string[]) => Promise<string>,
): Promise<string> {
  if (explicitPath !== undefined) {
    return verifier(explicitPath, trustedAllowlist);
  }
  let lastError: unknown = null;
  for (const candidate of trustedAllowlist) {
    try {
      return await verifier(candidate, trustedAllowlist);
    } catch (err: unknown) {
      lastError = err;
    }
  }
  if (lastError instanceof HardwareRunnerError) {
    throw lastError;
  }
  throw new HardwareRunnerError(
    'RUNNER_SANDBOX_FAILED',
    `none of the trusted hardware probe binaries are available (${trustedAllowlist.join(', ')})`,
  );
}

export const defaultProbeCommandRunner: ProbeCommandRunner = (
  executablePath,
  args,
  options,
): Promise<ProbeCommandResult> => {
  if (!isAbsolute(executablePath) || /[\0\r\n]/.test(executablePath)) {
    return Promise.reject(new HardwareRunnerError('RUNNER_SANDBOX_FAILED', 'probe executable must be an absolute path'));
  }
  for (const arg of args) {
    if (typeof arg !== 'string' || /[\0\r\n]/.test(arg)) {
      return Promise.reject(new HardwareRunnerError('RUNNER_SANDBOX_FAILED', 'probe argument contains forbidden characters'));
    }
  }
  if (options.signal?.aborted) {
    return Promise.reject(new HardwareRunnerError('RUNNER_SANDBOX_FAILED', 'hardware probe aborted'));
  }

  return new Promise<ProbeCommandResult>((resolvePromise, rejectPromise) => {
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
        maxBuffer: MAX_PROBE_OUTPUT_BYTES,
        killSignal: 'SIGKILL',
        windowsHide: true,
      },
      (error, stdout, stderr) => {
        options.signal?.removeEventListener('abort', onAbort);
        if (options.signal?.aborted) {
          rejectPromise(new HardwareRunnerError('RUNNER_SANDBOX_FAILED', 'hardware probe aborted'));
          return;
        }
        if (error !== null) {
          const errno = error as NodeJS.ErrnoException & { killed?: boolean; code?: string | number };
          if (errno.killed || errno.code === 'ETIMEDOUT' || errno.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') {
            rejectPromise(
              new HardwareRunnerError('RUNNER_SANDBOX_FAILED', `hardware probe failed or exceeded bounds: ${error.message}`),
            );
            return;
          }
          if (typeof errno.code === 'number') {
            resolvePromise({
              exitCode: errno.code,
              stdout: typeof stdout === 'string' ? stdout : String(stdout ?? ''),
              stderr: typeof stderr === 'string' ? stderr : String(stderr ?? ''),
            });
            return;
          }
          rejectPromise(new HardwareRunnerError('RUNNER_SANDBOX_FAILED', `hardware probe spawn error: ${error.message}`));
          return;
        }
        resolvePromise({
          exitCode: 0,
          stdout: typeof stdout === 'string' ? stdout : String(stdout ?? ''),
          stderr: typeof stderr === 'string' ? stderr : String(stderr ?? ''),
        });
      },
    );
    const onAbort = () => {
      child.kill('SIGKILL');
    };
    options.signal?.addEventListener('abort', onAbort, { once: true });
  });
};

function normalizeCudaComputeCap(rawCap: string, preferredAccelerator?: string): string {
  const trimmed = rawCap.trim().toLowerCase();
  const smMatch = /^sm_([0-9]{2,3}[a-z]?)$/.exec(trimmed);
  if (smMatch !== null) {
    return `sm_${smMatch[1]!}`;
  }
  const dottedMatch = /^([0-9]{1,2})\.([0-9])([a-z]?)$/.exec(trimmed);
  if (dottedMatch === null) {
    throw new HardwareRunnerError('RUNNER_SANDBOX_FAILED', `unable to parse CUDA compute capability "${rawCap}"`);
  }
  const baseDigits = `${dottedMatch[1]!}${dottedMatch[2]!}`;
  const explicitSuffix = dottedMatch[3]!;
  if (explicitSuffix.length > 0) {
    return `sm_${baseDigits}${explicitSuffix}`;
  }
  // Hopper (9.0 -> sm_90a) and Blackwell (10.0 -> sm_100a) expose architecture-accelerated
  // instruction targets via the 'a' suffix while nvidia-smi reports numeric major.minor.
  if (
    preferredAccelerator !== undefined
    && (baseDigits === '90' || baseDigits === '100' || baseDigits === '120')
    && preferredAccelerator === `sm_${baseDigits}a`
  ) {
    return preferredAccelerator;
  }
  return `sm_${baseDigits}`;
}

function resolveAllocatedDeviceIndices(
  requestedCount: number | undefined,
  explicitIndices: readonly number[] | undefined,
  availableIndices: ReadonlySet<number>,
  totalHostCount: number,
): readonly number[] {
  if (explicitIndices !== undefined) {
    if (explicitIndices.length < 1 || explicitIndices.length > 64) {
      throw new HardwareRunnerError('RUNNER_SANDBOX_FAILED', 'allocatedDeviceIndices must contain 1..64 device indices');
    }
    if (requestedCount !== undefined && explicitIndices.length !== requestedCount) {
      throw new HardwareRunnerError(
        'RUNNER_SANDBOX_FAILED',
        `allocatedDeviceIndices count (${explicitIndices.length}) does not match requested deviceCount (${requestedCount})`,
      );
    }
    const seen = new Set<number>();
    const validated: number[] = [];
    for (const idx of explicitIndices) {
      if (!Number.isSafeInteger(idx) || Object.is(idx, -0) || idx < 0 || idx >= 64) {
        throw new HardwareRunnerError('RUNNER_SANDBOX_FAILED', `invalid allocated device index ${String(idx)}`);
      }
      if (seen.has(idx)) {
        throw new HardwareRunnerError('RUNNER_SANDBOX_FAILED', `duplicate allocated device index ${idx}`);
      }
      if (!availableIndices.has(idx)) {
        throw new HardwareRunnerError(
          'RUNNER_SANDBOX_FAILED',
          `physical host has ${totalHostCount} devices, fewer than required or missing allocated device index ${idx}`,
        );
      }
      seen.add(idx);
      validated.push(idx);
    }
    return Object.freeze(validated);
  }

  if (requestedCount !== undefined) {
    if (!Number.isSafeInteger(requestedCount) || Object.is(requestedCount, -0) || requestedCount < 1 || requestedCount > 64) {
      throw new HardwareRunnerError('RUNNER_SANDBOX_FAILED', `invalid requested deviceCount (${String(requestedCount)})`);
    }
    if (totalHostCount < requestedCount) {
      throw new HardwareRunnerError(
        'RUNNER_SANDBOX_FAILED',
        `physical host has ${totalHostCount} devices, fewer than required ${requestedCount}`,
      );
    }
    const sortedAvailable = [...availableIndices].sort((a, b) => a - b);
    if (sortedAvailable.length < requestedCount) {
      throw new HardwareRunnerError(
        'RUNNER_SANDBOX_FAILED',
        `physical host has ${sortedAvailable.length} devices, fewer than required ${requestedCount}`,
      );
    }
    return Object.freeze(sortedAvailable.slice(0, requestedCount));
  }

  const allSorted = [...availableIndices].sort((a, b) => a - b);
  if (allSorted.length < 1 || allSorted.length > 64) {
    throw new HardwareRunnerError('RUNNER_SANDBOX_FAILED', `invalid host accelerator device count (${allSorted.length})`);
  }
  return Object.freeze(allSorted);
}

interface ParsedPeerMatrixBlock {
  readonly colIds: readonly number[];
  readonly rowsByDevice: ReadonlyMap<number, readonly string[]>;
  readonly invalid: boolean;
}

function parsePeerMatrixBlocks(
  rawText: string,
  prefixWord: 'GPU' | 'NPU',
): readonly ParsedPeerMatrixBlock[] {
  if (rawText.trim().length === 0) return [];
  const cleaned = stripAnsiSequences(rawText);
  const headerTokenPattern = new RegExp(`^${prefixWord}(\\d+)$`, 'i');
  const rowPrefixPattern = new RegExp(`^${prefixWord}(\\d+)$`, 'i');

  const blocks: {
    colIds: readonly number[];
    rowsByDevice: Map<number, readonly string[]>;
    invalid: boolean;
  }[] = [];
  let current: {
    colIds: readonly number[];
    rowsByDevice: Map<number, readonly string[]>;
    invalid: boolean;
  } | null = null;

  const tryParseHeaderColumns = (parts: readonly string[]): readonly number[] | null => {
    let startIdx = -1;
    if (parts.length >= 2 && headerTokenPattern.test(parts[0]!) && headerTokenPattern.test(parts[1]!)) {
      startIdx = 0;
    } else if (
      parts.length >= 3
      && !headerTokenPattern.test(parts[0]!)
      && headerTokenPattern.test(parts[1]!)
      && headerTokenPattern.test(parts[2]!)
    ) {
      startIdx = 1;
    }
    if (startIdx < 0) return null;

    const colIds: number[] = [];
    const seen = new Set<number>();
    let endedDeviceCols = false;
    for (let i = startIdx; i < parts.length; i += 1) {
      const hm = headerTokenPattern.exec(parts[i]!);
      if (hm !== null) {
        if (endedDeviceCols) {
          // Discontiguous device header tokens after non-device columns are ambiguous.
          return null;
        }
        const id = Number.parseInt(hm[1]!, 10);
        if (!Number.isSafeInteger(id) || id < 0 || id >= 64 || seen.has(id)) {
          return null;
        }
        seen.add(id);
        colIds.push(id);
      } else {
        endedDeviceCols = true;
      }
    }
    return colIds.length >= 2 ? colIds : null;
  };

  for (const rawLine of cleaned.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line.length === 0) continue;
    const parts = line.split(/\s+/);

    // Always inspect for a column header row BEFORE data-row matching so a trimmed
    // header like "GPU3 GPU2 GPU1 GPU0 CPU Affinity" never masquerades as data row GPU3.
    if (
      (parts.length >= 2 && headerTokenPattern.test(parts[0]!) && headerTokenPattern.test(parts[1]!))
      || (parts.length >= 3 && !headerTokenPattern.test(parts[0]!) && headerTokenPattern.test(parts[1]!) && headerTokenPattern.test(parts[2]!))
    ) {
      const parsedCols = tryParseHeaderColumns(parts);
      if (parsedCols === null) {
        if (current !== null) current.invalid = true;
        current = { colIds: [], rowsByDevice: new Map(), invalid: true };
        blocks.push(current);
      } else {
        current = { colIds: parsedCols, rowsByDevice: new Map(), invalid: false };
        blocks.push(current);
      }
      continue;
    }

    if (current === null) {
      continue;
    }

    const rowMatch = rowPrefixPattern.exec(parts[0]!);
    if (rowMatch === null || parts.length < 2) {
      continue;
    }
    const rowDevIdx = Number.parseInt(rowMatch[1]!, 10);
    if (!Number.isSafeInteger(rowDevIdx) || rowDevIdx < 0 || rowDevIdx >= 64) {
      continue;
    }
    if (current.rowsByDevice.has(rowDevIdx)) {
      current.invalid = true;
      continue;
    }
    current.rowsByDevice.set(rowDevIdx, parts.slice(1));
  }

  return blocks;
}

function extractMappedPeerMatrixTopology(
  rawText: string,
  prefixWord: 'GPU' | 'NPU',
  allocatedIndices: readonly number[],
  mapCellToken: (token: string) => string,
): string | undefined {
  const k = allocatedIndices.length;
  if (k < 2 || rawText.trim().length === 0) return undefined;
  const blocks = parsePeerMatrixBlocks(rawText, prefixWord);
  if (blocks.length === 0) return undefined;

  const expectedPairs = (k * (k - 1)) / 2;
  let resolvedTopology: string | undefined;

  for (const block of blocks) {
    if (block.invalid || block.colIds.length < k || block.rowsByDevice.size < k) {
      continue;
    }

    // Require every allocated device ID to appear unambiguously in BOTH column headers and row labels,
    // with a self-diagonal ('X' or 'SELF') confirming row/column alignment.
    let alignmentValid = true;
    for (const devIdx of allocatedIndices) {
      const selfCol = block.colIds.indexOf(devIdx);
      const selfRow = block.rowsByDevice.get(devIdx);
      if (selfCol < 0 || selfRow === undefined || selfCol >= selfRow.length) {
        alignmentValid = false;
        break;
      }
      const diag = selfRow[selfCol]?.trim().toUpperCase();
      if (diag !== 'X' && diag !== 'SELF') {
        alignmentValid = false;
        break;
      }
    }
    if (!alignmentValid) {
      continue;
    }

    const observedPairs = new Set<string>();
    const mappedTokens: string[] = [];
    let pairsValid = true;

    for (let i = 0; i < k && pairsValid; i += 1) {
      const devA = allocatedIndices[i]!;
      const rowA = block.rowsByDevice.get(devA)!;
      const colA = block.colIds.indexOf(devA);
      for (let j = i + 1; j < k; j += 1) {
        const devB = allocatedIndices[j]!;
        const rowB = block.rowsByDevice.get(devB)!;
        const colB = block.colIds.indexOf(devB);
        if (colB < 0 || colB >= rowA.length || colA < 0 || colA >= rowB.length) {
          pairsValid = false;
          break;
        }
        const tokAB = rowA[colB]?.trim() ?? '';
        const tokBA = rowB[colA]?.trim() ?? '';
        if (
          !tokAB
          || !tokBA
          || tokAB.toUpperCase() === 'X'
          || tokAB.toUpperCase() === 'SELF'
          || tokBA.toUpperCase() === 'X'
          || tokBA.toUpperCase() === 'SELF'
        ) {
          pairsValid = false;
          break;
        }
        const mappedAB = mapCellToken(tokAB);
        const mappedBA = mapCellToken(tokBA);
        if (!mappedAB || !mappedBA) {
          pairsValid = false;
          break;
        }
        observedPairs.add(`${Math.min(devA, devB)}:${Math.max(devA, devB)}`);
        mappedTokens.push(mappedAB, mappedBA);
      }
    }

    if (!pairsValid || observedPairs.size !== expectedPairs || mappedTokens.length === 0) {
      continue;
    }

    const unique = [...new Set(mappedTokens)].sort(compareUtf16);
    const candidateTopo = unique.length === 1 ? unique[0]! : unique.join('+');
    if (resolvedTopology !== undefined && resolvedTopology !== candidateTopo) {
      return undefined;
    }
    resolvedTopology = candidateTopo;
  }

  return resolvedTopology;
}

function observeNvidiaTopology(
  topoOutput: string,
  allocatedIndices: readonly number[],
): string | undefined {
  return extractMappedPeerMatrixTopology(topoOutput, 'GPU', allocatedIndices, tok => {
    const upper = tok.toUpperCase();
    if (/^NV\d+$/.test(upper)) return upper.toLowerCase();
    if (upper === 'NVB' || upper === 'NVLINK') return 'nvlink';
    if (upper === 'PIX' || upper === 'PXB' || upper === 'PHB' || upper === 'NODE' || upper === 'SYS') {
      return upper.toLowerCase();
    }
    return sanitizePrintableField(tok.toLowerCase(), '', 32, true);
  });
}

export function parseNvidiaSmiOutput(
  queryOutput: string,
  detailOutput = '',
  options: {
    readonly preferredAccelerator?: string;
    readonly topoOutput?: string;
    readonly allocatedDeviceCount?: number;
    readonly allocatedDeviceIndices?: readonly number[];
    readonly detailScopedToAllocated?: boolean;
    readonly measuredRuntimeVersion?: string;
  } = {},
): ParsedAcceleratorProbe {
  if (typeof queryOutput !== 'string' || queryOutput.trim().length === 0) {
    throw new HardwareRunnerError('RUNNER_SANDBOX_FAILED', 'empty nvidia-smi output');
  }
  const lines = queryOutput
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(line => line.length > 0);

  if (lines.length === 0 || lines.length > 64) {
    throw new HardwareRunnerError('RUNNER_SANDBOX_FAILED', 'nvidia-smi reported an invalid number of GPU rows');
  }

  const availableIndices = new Set<number>(Array.from({ length: lines.length }, (_, idx) => idx));
  const allocatedIndices = resolveAllocatedDeviceIndices(
    options.allocatedDeviceCount,
    options.allocatedDeviceIndices,
    availableIndices,
    lines.length,
  );

  let deviceModel = '';
  let accelerator = '';
  let driverVersion = '';
  let sliced = false;
  let csvRuntimeVersion: string | undefined;
  const rowClockLocks: ('locked' | 'unlocked')[] = [];

  for (const idx of allocatedIndices) {
    const line = lines[idx]!;
    const cols = line.split(',').map(part => part.trim());
    if (cols.length < 3) {
      throw new HardwareRunnerError('RUNNER_SANDBOX_FAILED', 'malformed nvidia-smi CSV row');
    }
    const rowModel = sanitizePrintableField(cols[0]!, '', 128, false);
    const rowCap = normalizeCudaComputeCap(cols[1]!, options.preferredAccelerator);
    const rowDriver = sanitizePrintableField(cols[2]!, '', 128, false);
    if (!rowModel || !rowDriver) {
      throw new HardwareRunnerError('RUNNER_SANDBOX_FAILED', 'nvidia-smi row missing GPU model or driver version');
    }
    if (!deviceModel) deviceModel = rowModel;
    if (!accelerator) {
      accelerator = rowCap;
    } else if (accelerator !== rowCap) {
      throw new HardwareRunnerError(
        'RUNNER_SANDBOX_FAILED',
        `heterogeneous CUDA compute capabilities (${accelerator} vs ${rowCap}) in single probe`,
      );
    }
    if (!driverVersion) driverVersion = rowDriver;

    const migCol = (cols[3] ?? '').toLowerCase();
    if (migCol === 'enabled' || /\bmig\b/i.test(rowModel)) {
      sliced = true;
    }
    if (cols[4] !== undefined && cols[4].length > 0 && cols[4].toLowerCase() !== 'n/a') {
      const cleanedRt = sanitizePrintableField(cols[4], '', 128, false);
      if (cleanedRt) csvRuntimeVersion ??= cleanedRt;
    }
    if (cols[5] !== undefined && cols[5].length > 0) {
      const lockVal = cols[5].toLowerCase();
      if (lockVal === 'locked' || lockVal === 'active' || lockVal === 'enabled') rowClockLocks.push('locked');
      else if (lockVal === 'unlocked' || lockVal === 'idle' || lockVal === 'disabled') rowClockLocks.push('unlocked');
    }
  }

  // Never scrape host driver "CUDA Version :" from nvidia-smi -q as container/workload runtimeVersion.
  const runtimeCandidate = options.measuredRuntimeVersion ?? csvRuntimeVersion ?? '';
  const runtimeVersion = runtimeCandidate.length > 0 ? runtimeCandidate : 'cuda-unknown';

  let clockLockMode: 'locked' | 'unlocked' | 'unknown' = 'unknown';
  if (rowClockLocks.length === allocatedIndices.length) {
    clockLockMode = rowClockLocks.every(v => v === 'locked') ? 'locked' : 'unlocked';
  } else if (rowClockLocks.includes('unlocked')) {
    clockLockMode = 'unlocked';
  } else if (
    detailOutput.trim().length > 0
    && (options.detailScopedToAllocated === true || allocatedIndices.length === lines.length)
  ) {
    if (/\bClocks\s*:\s*Unlocked\b/i.test(detailOutput)) {
      clockLockMode = 'unlocked';
    } else if (
      /Locked\s+Clocks[\s\S]{0,160}?(?:Active|Locked\s*:\s*Yes)/i.test(detailOutput)
      || /\bClocks\s*:\s*Locked\b/i.test(detailOutput)
    ) {
      clockLockMode = 'locked';
    }
  }

  const detectedTopology = observeNvidiaTopology(options.topoOutput ?? '', allocatedIndices);

  return Object.freeze({
    vendor: 'nvidia',
    deviceModel,
    accelerator,
    isolationMode: sliced ? 'sliced' : 'whole_device',
    deviceCount: allocatedIndices.length,
    driverVersion,
    runtimeVersion: sanitizePrintableField(runtimeVersion, 'cuda-unknown', 128, false),
    ...(detectedTopology !== undefined ? { topology: detectedTopology } : {}),
    clockLockMode,
  });
}

function parseRocminfoAgents(rocminfoOutput: string): {
  readonly architectures: readonly string[];
  readonly models: readonly string[];
  readonly runtimeVersion?: string;
} {
  const architectures: string[] = [];
  const models: string[] = [];
  if (!rocminfoOutput.trim().length) {
    return { architectures, models };
  }

  const runtimeMatch = /ROCm(?:\s+Runtime)?\s+Version\s*:\s*([^\r\n]+)/i.exec(rocminfoOutput);
  const blocks = rocminfoOutput.split(/\*{5,}\s*\r?\n\s*Agent\s+\d+\s*\r?\n\s*\*{5,}/i);
  const candidateBlocks = blocks.length > 1 ? blocks.slice(1) : [rocminfoOutput];

  for (const block of candidateBlocks) {
    const typeMatch = /^\s*Device Type\s*:\s*([A-Za-z0-9_-]+)/im.exec(block);
    if (typeMatch !== null && typeMatch[1]!.toUpperCase() !== 'GPU') {
      continue;
    }
    const nameMatches = [...block.matchAll(/^\s*Name\s*:\s*(gfx[0-9a-z_]+)\s*$/gim)];
    const mktMatch = /^\s*Marketing Name\s*:\s*(.+)$/im.exec(block);
    if (nameMatches.length > 0) {
      const gfx = nameMatches[0]![1]!.toLowerCase();
      architectures.push(gfx);
      const cleanModel = mktMatch !== null ? sanitizePrintableField(mktMatch[1]!, '', 128, false) : '';
      models.push(cleanModel);
    }
  }

  const runtimeVal = runtimeMatch?.[1] !== undefined
    ? sanitizePrintableField(runtimeMatch[1], '', 128, false)
    : '';
  return {
    architectures,
    models,
    ...(runtimeVal.length > 0 ? { runtimeVersion: runtimeVal } : {}),
  };
}

function observeRocmTopology(topoOutput: string, allocatedIndices: readonly number[]): string | undefined {
  if (allocatedIndices.length < 2 || topoOutput.trim().length === 0) return undefined;
  const matrixTopo = extractMappedPeerMatrixTopology(topoOutput, 'GPU', allocatedIndices, tok => {
    const upper = tok.toUpperCase();
    if (upper.startsWith('XGMI')) return 'xgmi';
    if (upper.startsWith('PCIE') || upper === 'PHB' || upper === 'PXB' || upper === 'PIX' || upper === 'SYS') {
      return 'pcie';
    }
    return '';
  });
  if (matrixTopo !== undefined) {
    return matrixTopo;
  }

  const allocatedSet = new Set<number>(allocatedIndices);
  const expectedPairs = (allocatedIndices.length * (allocatedIndices.length - 1)) / 2;
  const observedPairs = new Map<string, string>();
  const cleaned = stripAnsiSequences(topoOutput);
  const pairRe = /\bGPU\[(\d+)\]\s*-\s*GPU\[(\d+)\]\s*:\s*(?:Link\s+Type\s*:\s*)?(XGMI|PCIE)\b/gi;
  for (const m of cleaned.matchAll(pairRe)) {
    const a = Number.parseInt(m[1]!, 10);
    const b = Number.parseInt(m[2]!, 10);
    if (!allocatedSet.has(a) || !allocatedSet.has(b) || a === b) continue;
    const key = `${Math.min(a, b)}:${Math.max(a, b)}`;
    const linkType = m[3]!.toLowerCase();
    const prev = observedPairs.get(key);
    if (prev !== undefined && prev !== linkType) {
      return undefined;
    }
    observedPairs.set(key, linkType);
  }
  if (observedPairs.size !== expectedPairs) {
    return undefined;
  }
  const uniq = [...new Set(observedPairs.values())].sort(compareUtf16);
  return uniq.length === 1 ? uniq[0] : uniq.join('+');
}

interface ParsedRocmCardRecord {
  deviceModel: string;
  gfxArch: string;
  sliced: boolean;
  clockLockMode: 'locked' | 'unlocked' | 'unknown';
}

export function parseRocmSmiOutput(
  rocmSmiOutput: string,
  rocminfoOutput = '',
  options: {
    readonly topoOutput?: string;
    readonly allocatedDeviceCount?: number;
    readonly allocatedDeviceIndices?: readonly number[];
    readonly ignoreHostRuntimeVersion?: boolean;
    readonly measuredRuntimeVersion?: string;
  } = {},
): ParsedAcceleratorProbe {
  const combined = `${rocmSmiOutput}\n${rocminfoOutput}`.trim();
  if (combined.length === 0) {
    throw new HardwareRunnerError('RUNNER_SANDBOX_FAILED', 'empty rocm-smi and rocminfo output');
  }

  const rocminfo = parseRocminfoAgents(rocminfoOutput);
  const cardsByIndex = new Map<number, ParsedRocmCardRecord>();
  let driverVersion = '';
  let runtimeVersion = rocminfo.runtimeVersion ?? '';

  const getOrCreateCard = (idx: number): ParsedRocmCardRecord => {
    let rec = cardsByIndex.get(idx);
    if (!rec) {
      rec = { deviceModel: '', gfxArch: '', sliced: false, clockLockMode: 'unknown' };
      cardsByIndex.set(idx, rec);
    }
    return rec;
  };

  const trimmedSmi = rocmSmiOutput.trim();
  if (trimmedSmi.startsWith('{')) {
    const parsed = parseStrictJsonBytes(
      Buffer.from(trimmedSmi, 'utf8'),
      MAX_PROBE_OUTPUT_BYTES,
      'RUNNER_SANDBOX_FAILED',
      '/rocmSmi',
    );
    if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
      const root = parsed as Record<string, unknown>;
      for (const key of Object.keys(root).sort()) {
        if (!Object.hasOwn(root, key)) continue;
        const val = root[key];
        if (val === null || typeof val !== 'object' || Array.isArray(val)) continue;
        const entry = val as Record<string, unknown>;
        if (key === 'system') {
          for (const sysKey of Object.keys(entry)) {
            if (!Object.hasOwn(entry, sysKey) || typeof entry[sysKey] !== 'string') continue;
            const lowerKey = sysKey.toLowerCase();
            if (lowerKey.includes('driver')) {
              driverVersion = sanitizePrintableField(entry[sysKey] as string, driverVersion, 128, false);
            } else if (lowerKey.includes('rocm') || lowerKey.includes('hip')) {
              runtimeVersion = sanitizePrintableField(entry[sysKey] as string, runtimeVersion, 128, false);
            }
          }
          continue;
        }
        const cardMatch = /^(?:card|gpu)(\d+)$/i.exec(key);
        if (cardMatch !== null) {
          const cardIdx = Number.parseInt(cardMatch[1]!, 10);
          if (!Number.isSafeInteger(cardIdx) || cardIdx < 0 || cardIdx >= 64) continue;
          const card = getOrCreateCard(cardIdx);
          for (const cardKey of Object.keys(entry)) {
            if (!Object.hasOwn(entry, cardKey) || typeof entry[cardKey] !== 'string') continue;
            const rawVal = entry[cardKey] as string;
            const lowerKey = cardKey.toLowerCase();
            if (
              (!card.deviceModel || /^0x[0-9a-f]+$/i.test(card.deviceModel))
              && (lowerKey.includes('card series') || lowerKey.includes('product name') || lowerKey.includes('marketing name') || lowerKey === 'card model')
            ) {
              const candidateModel = sanitizePrintableField(rawVal, '', 128, false);
              if (candidateModel && (!/^0x[0-9a-f]+$/i.test(candidateModel) || !card.deviceModel)) {
                card.deviceModel = candidateModel;
              }
            }
            if (lowerKey.includes('gfx') || lowerKey.includes('target')) {
              const gfxMatch = /\b(gfx[0-9a-z_]+)\b/i.exec(rawVal);
              if (gfxMatch !== null && !card.gfxArch) {
                card.gfxArch = gfxMatch[1]!.toLowerCase();
              }
            }
            if (lowerKey.includes('partition') && /\b(?:cpx|tpx|qpx|dpx|spx_sliced|sliced)\b/i.test(rawVal)) {
              card.sliced = true;
            }
            if (lowerKey.includes('performance level') || lowerKey.includes('perf level')) {
              if (/\b(?:manual|locked|profile_peak)\b/i.test(rawVal)) card.clockLockMode = 'locked';
              else if (/\bauto\b/i.test(rawVal)) card.clockLockMode = 'unlocked';
            }
          }
        }
      }
    }
  } else if (trimmedSmi.length > 0) {
    for (const rawLine of trimmedSmi.split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line) continue;
      const drvMatch = /^Driver\s+version\s*:\s*(.+)$/i.exec(line);
      if (drvMatch !== null) {
        driverVersion = sanitizePrintableField(drvMatch[1]!, driverVersion, 128, false);
        continue;
      }
      const rocmVerMatch = /^ROCm\s+version\s*:\s*(.+)$/i.exec(line);
      if (rocmVerMatch !== null) {
        runtimeVersion = sanitizePrintableField(rocmVerMatch[1]!, runtimeVersion, 128, false);
        continue;
      }
      const prefixMatch = /^(?:GPU|card)\[(\d+)\]\s*:\s*(.+)$/i.exec(line);
      const cardIdx = prefixMatch !== null ? Number.parseInt(prefixMatch[1]!, 10) : 0;
      const body = prefixMatch !== null ? prefixMatch[2]! : line;
      if (prefixMatch === null && !/(?:Card Series|Product Name|Marketing Name|GFX Version|Compute Partition|Performance Level)\s*:/i.test(body)) {
        continue;
      }
      if (!Number.isSafeInteger(cardIdx) || cardIdx < 0 || cardIdx >= 64) continue;
      const card = getOrCreateCard(cardIdx);
      const inlineDrv = /^Driver\s+version\s*:\s*(.+)$/i.exec(body);
      if (inlineDrv !== null) {
        driverVersion = sanitizePrintableField(inlineDrv[1]!, driverVersion, 128, false);
      }
      const inlineRocm = /^ROCm\s+version\s*:\s*(.+)$/i.exec(body);
      if (inlineRocm !== null) {
        runtimeVersion = sanitizePrintableField(inlineRocm[1]!, runtimeVersion, 128, false);
      }
      const seriesMatch = /(?:Card Series|Card series|Product Name|Marketing Name)\s*:\s*(.+)$/i.exec(body);
      if (seriesMatch !== null && !card.deviceModel) {
        card.deviceModel = sanitizePrintableField(seriesMatch[1]!, '', 128, false);
      }
      const gfxMatch = /\b(gfx[0-9a-z_]+)\b/i.exec(body);
      if (gfxMatch !== null && !card.gfxArch) {
        card.gfxArch = gfxMatch[1]!.toLowerCase();
      }
      if (/\bCompute Partition\s*:\s*(?:CPX|TPX|QPX|DPX)\b/i.test(body)) {
        card.sliced = true;
      }
      if (/Performance Level\s*:\s*manual/i.test(body)) {
        card.clockLockMode = 'locked';
      } else if (/Performance Level\s*:\s*auto/i.test(body)) {
        card.clockLockMode = 'unlocked';
      }
    }
  }

  const availableIndices = new Set<number>();
  for (const idx of cardsByIndex.keys()) availableIndices.add(idx);
  for (let idx = 0; idx < rocminfo.architectures.length; idx += 1) availableIndices.add(idx);

  if (availableIndices.size < 1 || availableIndices.size > 64) {
    throw new HardwareRunnerError('RUNNER_SANDBOX_FAILED', 'unable to determine AMD GPU gfx architecture from rocm-smi/rocminfo');
  }

  const allocatedIndices = resolveAllocatedDeviceIndices(
    options.allocatedDeviceCount,
    options.allocatedDeviceIndices,
    availableIndices,
    availableIndices.size,
  );

  let deviceModel = '';
  let gfxArch = '';
  let sliced = false;
  const allocatedLocks: ('locked' | 'unlocked')[] = [];

  for (const idx of allocatedIndices) {
    const card = cardsByIndex.get(idx);
    const agentArch = rocminfo.architectures[idx];
    const agentModel = rocminfo.models[idx];
    const resolvedArch = card?.gfxArch || agentArch || '';
    if (!resolvedArch || !/^gfx[0-9a-z_]{1,60}$/.test(resolvedArch)) {
      throw new HardwareRunnerError('RUNNER_SANDBOX_FAILED', 'unable to determine AMD GPU gfx architecture from rocm-smi/rocminfo');
    }
    if (!gfxArch) {
      gfxArch = resolvedArch;
    } else if (gfxArch !== resolvedArch) {
      throw new HardwareRunnerError(
        'RUNNER_SANDBOX_FAILED',
        `heterogeneous ROCm GPU architectures (${gfxArch} vs ${resolvedArch}) in single probe`,
      );
    }
    const cardModel = card?.deviceModel ?? '';
    const candidateModel = (!cardModel || /^0x[0-9a-f]+$/i.test(cardModel)) && agentModel ? agentModel : cardModel;
    if (!deviceModel && candidateModel) {
      deviceModel = candidateModel;
    }
    if (card?.sliced) {
      sliced = true;
    }
    if (card?.clockLockMode === 'locked' || card?.clockLockMode === 'unlocked') {
      allocatedLocks.push(card.clockLockMode);
    }
  }

  if (!deviceModel) {
    deviceModel = `AMD ROCm GPU (${gfxArch})`;
  }
  if (!driverVersion) {
    driverVersion = 'rocm-driver-unknown';
  }
  const effectiveRuntime = options.measuredRuntimeVersion
    ?? (options.ignoreHostRuntimeVersion === true ? '' : runtimeVersion);
  const finalRuntime = effectiveRuntime || 'rocm-unknown';

  const clockLockMode: 'locked' | 'unlocked' | 'unknown' =
    allocatedLocks.length === allocatedIndices.length
      ? (allocatedLocks.every(v => v === 'locked') ? 'locked' : 'unlocked')
      : allocatedLocks.includes('unlocked')
        ? 'unlocked'
        : 'unknown';

  const detectedTopology = observeRocmTopology(options.topoOutput ?? trimmedSmi, allocatedIndices);

  return Object.freeze({
    vendor: 'amd',
    deviceModel,
    accelerator: gfxArch,
    isolationMode: sliced ? 'sliced' : 'whole_device',
    deviceCount: allocatedIndices.length,
    driverVersion: sanitizePrintableField(driverVersion, 'rocm-driver-unknown', 128, false),
    runtimeVersion: sanitizePrintableField(finalRuntime, 'rocm-unknown', 128, false),
    ...(detectedTopology !== undefined ? { topology: detectedTopology } : {}),
    clockLockMode,
  });
}

function normalizeAscendAccelerator(rawChip: string, preferredAccelerator?: string): string {
  const compact = rawChip.replace(/^ascend[\s_-]*/i, '').trim().toLowerCase();
  if (/^910b[0-9a-z]*$/.test(compact)) {
    const exact = `ascend_${compact}`;
    if (preferredAccelerator !== undefined && preferredAccelerator === exact) {
      return exact;
    }
    return 'ascend_910b';
  }
  if (/^910[a-z0-9]*$/.test(compact)) {
    return `ascend_${compact}`;
  }
  if (/^310p[0-9a-z]*$/.test(compact)) {
    return preferredAccelerator === `ascend_${compact}` ? preferredAccelerator : 'ascend_310p';
  }
  const safe = compact.replace(/[^a-z0-9_]+/g, '_').replace(/^_+|_+$/g, '');
  if (!safe) {
    throw new HardwareRunnerError('RUNNER_SANDBOX_FAILED', `unable to normalize Ascend chip name "${rawChip}"`);
  }
  return safe.startsWith('ascend_') ? safe : `ascend_${safe}`;
}

function observeAscendTopology(topoOutput: string, allocatedIndices: readonly number[]): string | undefined {
  if (allocatedIndices.length < 2 || topoOutput.trim().length === 0) return undefined;
  return extractMappedPeerMatrixTopology(topoOutput, 'NPU', allocatedIndices, tok => {
    const upper = tok.toUpperCase();
    if (upper.startsWith('HCCS')) return 'hccs';
    if (upper === 'PIX' || upper === 'PXB' || upper === 'PHB' || upper === 'SYS' || upper === 'PCIE') {
      return 'pcie';
    }
    return '';
  });
}

interface ParsedAscendNpuRecord {
  chip: string;
  sliced: boolean;
}

const ASCEND_VNPU_MARKER_RE = /\b(?:vNPU|Vir[0-9]{2})\b/i;

export function parseNpuSmiOutput(
  npuSmiOutput: string,
  options: {
    readonly preferredAccelerator?: string;
    readonly topoOutput?: string;
    readonly allocatedDeviceCount?: number;
    readonly allocatedDeviceIndices?: readonly number[];
    readonly ignoreHostRuntimeVersion?: boolean;
    readonly measuredRuntimeVersion?: string;
  } = {},
): ParsedAcceleratorProbe {
  if (typeof npuSmiOutput !== 'string' || npuSmiOutput.trim().length === 0) {
    throw new HardwareRunnerError('RUNNER_SANDBOX_FAILED', 'empty npu-smi output');
  }

  let driverVersion = '';
  const bannerVer = /(?:Version|Driver Version)\s*:\s*([0-9A-Za-z._-]+)/i.exec(npuSmiOutput);
  if (bannerVer !== null) {
    driverVersion = sanitizePrintableField(bannerVer[1]!, '', 128, false);
  }
  const cannMatch = /CANN(?:\s+Version)?\s*:\s*([0-9A-Za-z._-]+)/i.exec(npuSmiOutput);
  const cannCleaned = cannMatch !== null ? sanitizePrintableField(cannMatch[1]!, '', 120, false) : '';
  const effectiveRt = options.measuredRuntimeVersion
    ?? (options.ignoreHostRuntimeVersion === true ? '' : (cannCleaned.length > 0 ? `cann-${cannCleaned}` : ''));
  const runtimeVersion = effectiveRt.length > 0 ? effectiveRt : 'cann-unknown';

  const npuRecords = new Map<number, ParsedAscendNpuRecord>();
  let currentTableNpuIdx: number | null = null;
  let hasTableRecords = false;

  for (const rawLine of npuSmiOutput.split(/\r?\n/)) {
    const trimmed = rawLine.trim();
    if (trimmed.length === 0) continue;
    if (/^\+[-=+:|]+\+$/.test(trimmed)) {
      currentTableNpuIdx = null;
      continue;
    }
    const tableChipMatch = /^\|\s*(\d+)\s+(?:Ascend[\s_-]*)?([0-9]{3}[A-Za-z0-9_-]*)\b([^|]*)\|/i.exec(trimmed);
    if (tableChipMatch !== null) {
      const npuIdx = Number.parseInt(tableChipMatch[1]!, 10);
      if (Number.isSafeInteger(npuIdx) && npuIdx >= 0 && npuIdx < 64) {
        hasTableRecords = true;
        currentTableNpuIdx = npuIdx;
        const prev = npuRecords.get(npuIdx);
        npuRecords.set(npuIdx, {
          chip: tableChipMatch[2]!,
          sliced: (prev?.sliced ?? false) || ASCEND_VNPU_MARKER_RE.test(trimmed),
        });
      }
      continue;
    }
    if (hasTableRecords && ASCEND_VNPU_MARKER_RE.test(trimmed)) {
      const explicitRowIdx = /^\|\s*(\d+)\b/.exec(trimmed);
      if (explicitRowIdx !== null) {
        const rowIdx = Number.parseInt(explicitRowIdx[1]!, 10);
        if (currentTableNpuIdx !== null && npuRecords.has(currentTableNpuIdx)) {
          npuRecords.get(currentTableNpuIdx)!.sliced = true;
        } else if (npuRecords.has(rowIdx)) {
          npuRecords.get(rowIdx)!.sliced = true;
        }
      } else if (currentTableNpuIdx !== null && npuRecords.has(currentTableNpuIdx)) {
        npuRecords.get(currentTableNpuIdx)!.sliced = true;
      }
    }
  }

  if (npuRecords.size === 0) {
    let seqIdx = 0;
    let pendingExplicitIdx: number | null = null;
    let activeKvIdx: number | null = null;
    for (const rawLine of npuSmiOutput.split(/\r?\n/)) {
      const trimmed = rawLine.trim();
      if (trimmed.length === 0) continue;
      const idMatch = /^(?:NPU\s+ID|NPU)\s*:\s*(\d+)\s*$/i.exec(trimmed);
      if (idMatch !== null) {
        const parsedId = Number.parseInt(idMatch[1]!, 10);
        if (Number.isSafeInteger(parsedId) && parsedId >= 0 && parsedId < 64) {
          pendingExplicitIdx = parsedId;
          activeKvIdx = parsedId;
        }
        continue;
      }
      const kvChip = /Chip\s+Name\s*:\s*(?:Ascend[\s_-]*)?([0-9]{3}[A-Za-z0-9_-]*)/i.exec(trimmed);
      if (kvChip !== null) {
        const targetIdx = pendingExplicitIdx !== null && !npuRecords.has(pendingExplicitIdx)
          ? pendingExplicitIdx
          : seqIdx;
        pendingExplicitIdx = null;
        if (targetIdx >= seqIdx) {
          seqIdx = targetIdx + 1;
        }
        if (targetIdx < 64) {
          activeKvIdx = targetIdx;
          npuRecords.set(targetIdx, {
            chip: kvChip[1]!,
            sliced: ASCEND_VNPU_MARKER_RE.test(trimmed),
          });
        }
        continue;
      }
      if (ASCEND_VNPU_MARKER_RE.test(trimmed) && activeKvIdx !== null && npuRecords.has(activeKvIdx)) {
        npuRecords.get(activeKvIdx)!.sliced = true;
      }
    }
  }

  if (npuRecords.size === 0 || npuRecords.size > 64) {
    throw new HardwareRunnerError('RUNNER_SANDBOX_FAILED', 'unable to parse NPU devices from npu-smi output');
  }

  const allocatedIndices = resolveAllocatedDeviceIndices(
    options.allocatedDeviceCount,
    options.allocatedDeviceIndices,
    new Set(npuRecords.keys()),
    npuRecords.size,
  );

  const primaryChip = npuRecords.get(allocatedIndices[0]!)!.chip;
  const accelerator = normalizeAscendAccelerator(primaryChip, options.preferredAccelerator);
  let sliced = false;
  for (const idx of allocatedIndices) {
    const rec = npuRecords.get(idx)!;
    const norm = normalizeAscendAccelerator(rec.chip, options.preferredAccelerator);
    if (norm !== accelerator) {
      throw new HardwareRunnerError(
        'RUNNER_SANDBOX_FAILED',
        `heterogeneous Ascend NPU accelerators (${accelerator} vs ${norm}) in single probe`,
      );
    }
    if (rec.sliced) {
      sliced = true;
    }
  }

  const deviceModel = sanitizePrintableField(
    primaryChip.toLowerCase().startsWith('ascend') ? primaryChip : `Huawei Ascend ${primaryChip}`,
    `Huawei Ascend ${accelerator}`,
    128,
    false,
  );

  if (!driverVersion) {
    throw new HardwareRunnerError('RUNNER_SANDBOX_FAILED', 'npu-smi output missing driver version');
  }

  const detectedTopology = observeAscendTopology(options.topoOutput ?? '', allocatedIndices);

  return Object.freeze({
    vendor: 'huawei',
    deviceModel,
    accelerator,
    isolationMode: sliced ? 'sliced' : 'whole_device',
    deviceCount: allocatedIndices.length,
    driverVersion,
    runtimeVersion,
    ...(detectedTopology !== undefined ? { topology: detectedTopology } : {}),
    clockLockMode: 'unknown',
  });
}

async function streamWorkloadFileNoFollow(
  filePath: string,
  maxFileBytes: number,
  snapshotDestPath: string | null,
  signal?: AbortSignal,
): Promise<{ readonly sha256: string; readonly bytes: number }> {
  const noFollow = 'O_NOFOLLOW' in constants ? constants.O_NOFOLLOW : 0;
  const before = await lstat(filePath).catch((err: unknown) => {
    if ((err as NodeJS.ErrnoException)?.code === 'ELOOP') {
      throw new HardwareRunnerError('ARTIFACT_INVALID', 'symlink forbidden inside held_out_workloads');
    }
    throw new HardwareRunnerError('ARTIFACT_INVALID', 'failed to inspect held_out_workloads file');
  });
  if (before.isSymbolicLink() || !before.isFile()) {
    throw new HardwareRunnerError('ARTIFACT_INVALID', 'held_out_workloads entry must be a regular non-symlink file');
  }
  if (before.nlink !== 1) {
    throw new HardwareRunnerError('ARTIFACT_INVALID', 'hardlinked files are forbidden inside held_out_workloads');
  }
  if (before.size > maxFileBytes) {
    throw new HardwareRunnerError('PAYLOAD_TOO_LARGE', `held_out_workloads file exceeds ${maxFileBytes} bytes`);
  }

  let srcHandle: Awaited<ReturnType<typeof open>>;
  try {
    srcHandle = await open(filePath, constants.O_RDONLY | noFollow);
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException)?.code === 'ELOOP') {
      throw new HardwareRunnerError('ARTIFACT_INVALID', 'symlink detected while opening held_out_workloads file');
    }
    throw new HardwareRunnerError('ARTIFACT_INVALID', 'failed to open held_out_workloads file safely');
  }

  let dstHandle: Awaited<ReturnType<typeof open>> | null = null;
  let dstCreated = false;
  try {
    const opened = await srcHandle.stat();
    if (
      !opened.isFile()
      || opened.isSymbolicLink()
      || opened.nlink !== 1
      || opened.dev !== before.dev
      || opened.ino !== before.ino
      || opened.size !== before.size
    ) {
      throw new HardwareRunnerError('ARTIFACT_INVALID', 'held_out_workloads file identity changed during open');
    }

    const sealedMode = (opened.mode & 0o111) !== 0 ? 0o500 : 0o400;
    if (snapshotDestPath !== null) {
      dstHandle = await open(
        snapshotDestPath,
        constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | noFollow,
        0o600,
      );
      dstCreated = true;
    }

    const hasher = createHash('sha256');
    const chunkBuf = Buffer.allocUnsafe(Math.min(MAX_CAS_CHUNK_BYTES, Math.max(1, opened.size)));
    let offset = 0;
    while (offset < opened.size) {
      if (signal?.aborted) {
        throw new HardwareRunnerError('RUNNER_SANDBOX_FAILED', 'workload digest computation aborted');
      }
      const toRead = Math.min(chunkBuf.byteLength, opened.size - offset);
      const { bytesRead } = await srcHandle.read(chunkBuf, 0, toRead, offset);
      if (bytesRead <= 0) break;
      const slice = chunkBuf.subarray(0, bytesRead);
      hasher.update(slice);
      if (dstHandle !== null) {
        let writtenOff = 0;
        while (writtenOff < slice.byteLength) {
          const { bytesWritten } = await dstHandle.write(slice, writtenOff, slice.byteLength - writtenOff);
          if (bytesWritten <= 0) {
            throw new HardwareRunnerError('RUNNER_SANDBOX_FAILED', 'short write while snapshotting held-out workload');
          }
          writtenOff += bytesWritten;
        }
      }
      offset += bytesRead;
    }

    const extra = await srcHandle.read(chunkBuf, 0, 1, offset);
    const after = await srcHandle.stat();
    if (
      extra.bytesRead !== 0
      || offset !== opened.size
      || after.dev !== opened.dev
      || after.ino !== opened.ino
      || after.size !== opened.size
      || after.nlink !== 1
      || after.mtimeMs !== opened.mtimeMs
      || after.ctimeMs !== opened.ctimeMs
    ) {
      throw new HardwareRunnerError('ARTIFACT_INVALID', 'held_out_workloads file mutated during hashing');
    }

    if (dstHandle !== null) {
      await dstHandle.chmod(sealedMode);
      await dstHandle.sync();
      const dstStat = await dstHandle.stat();
      if (
        !dstStat.isFile()
        || dstStat.isSymbolicLink()
        || dstStat.nlink !== 1
        || dstStat.size !== offset
        || (dstStat.mode & 0o7777) !== sealedMode
      ) {
        throw new HardwareRunnerError('RUNNER_SANDBOX_FAILED', 'workload snapshot file failed mode/nlink sealing');
      }
    }

    return { sha256: hasher.digest('hex'), bytes: offset };
  } catch (err) {
    if (dstHandle !== null) {
      await dstHandle.close().catch(() => {});
      dstHandle = null;
    }
    if (dstCreated && snapshotDestPath !== null) {
      await unlink(snapshotDestPath).catch(() => {});
    }
    throw err;
  } finally {
    if (dstHandle !== null) {
      await dstHandle.close();
    }
    await srcHandle.close();
  }
}

async function processHeldOutWorkloadTree(
  heldOutWorkloadsDir: string,
  heldOutWorkloadId: string,
  snapshotDestDir: string | null,
  options: ComputeWorkloadDigestOptions = {},
): Promise<{ readonly workloadDir: string; readonly digest: Digest; readonly fileCount: number; readonly totalBytes: number }> {
  if (
    typeof heldOutWorkloadId !== 'string'
    || !WORKLOAD_ID_RE.test(heldOutWorkloadId)
    || heldOutWorkloadId === '.'
    || heldOutWorkloadId === '..'
  ) {
    throw new HardwareRunnerError('ARTIFACT_INVALID', 'invalid heldOutWorkloadId', '/heldOutWorkloadId');
  }
  const baseDir = resolve(heldOutWorkloadsDir);
  await assertNoSymlinkAncestors(baseDir, {
    checkLeaf: true,
    code: 'ARTIFACT_INVALID',
    diagPath: '/heldOutWorkloadsDir',
  });

  const workloadDir = join(baseDir, heldOutWorkloadId);
  await assertNoSymlinkAncestors(workloadDir, {
    checkLeaf: true,
    code: 'ARTIFACT_INVALID',
    diagPath: '/heldOutWorkloadId',
  });

  const noFollow = 'O_NOFOLLOW' in constants ? constants.O_NOFOLLOW : 0;
  const oDirectory = 'O_DIRECTORY' in constants ? constants.O_DIRECTORY : 0;
  let rootHandle: Awaited<ReturnType<typeof open>>;
  try {
    rootHandle = await open(workloadDir, constants.O_RDONLY | noFollow | oDirectory);
  } catch (err: unknown) {
    const code = (err as NodeJS.ErrnoException)?.code;
    if (code === 'ENOENT') {
      throw new HardwareRunnerError(
        'CONFIG_INVALID',
        `worker held-out workload "${heldOutWorkloadId}" does not exist`,
        '/heldOutWorkloadsDir',
      );
    }
    if (code === 'ELOOP' || code === 'ENOTDIR') {
      throw new HardwareRunnerError('ARTIFACT_INVALID', `held-out workload "${heldOutWorkloadId}" must be a non-symlink directory`);
    }
    throw new HardwareRunnerError('ARTIFACT_INVALID', `unable to open held-out workload "${heldOutWorkloadId}"`);
  }
  try {
    const rootStat = await rootHandle.stat();
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
      throw new HardwareRunnerError('ARTIFACT_INVALID', 'held-out workload path is not a regular directory');
    }
  } finally {
    await rootHandle.close();
  }

  let resolvedSnapRoot: string | null = null;
  const createdSnapDirs: string[] = [];
  if (snapshotDestDir !== null) {
    resolvedSnapRoot = resolve(snapshotDestDir);
    await assertNoSymlinkAncestors(resolvedSnapRoot, {
      checkLeaf: true,
      code: 'RUNNER_SANDBOX_FAILED',
      diagPath: '/workloadSnapshotDir',
    });
    await mkdir(resolvedSnapRoot, { mode: 0o700 });
    const snapStat = await lstat(resolvedSnapRoot);
    if (snapStat.isSymbolicLink() || !snapStat.isDirectory()) {
      throw new HardwareRunnerError('RUNNER_SANDBOX_FAILED', 'workloadSnapshotDir must be a non-symlink directory');
    }
  }

  const realWorkloadDir = await realpath(workloadDir);
  const maxFiles = options.maxFiles ?? 4_096;
  const maxFileBytes = options.maxFileBytes ?? VERIFIER_ARTIFACT_LIMITS.maxFileBytes;
  const maxTotalBytes = options.maxTotalBytes ?? VERIFIER_ARTIFACT_LIMITS.maxTotalBytes;
  const maxDepth = options.maxDepth ?? 32;

  const entries: { readonly relPath: string; readonly bytes: number; readonly sha256: string }[] = [];
  let totalBytes = 0;

  const isInsideRealWorkload = (candidateReal: string): boolean =>
    candidateReal === realWorkloadDir
    || candidateReal.startsWith(realWorkloadDir.endsWith(sep) ? realWorkloadDir : `${realWorkloadDir}${sep}`);

  const walk = async (currentAbs: string, relPrefix: string, currentSnapDir: string | null, depth: number): Promise<void> => {
    if (depth > maxDepth) {
      throw new HardwareRunnerError('ARTIFACT_INVALID', 'held-out workload exceeds maximum directory nesting depth');
    }
    if (options.signal?.aborted) {
      throw new HardwareRunnerError('RUNNER_SANDBOX_FAILED', 'workload digest walk aborted');
    }

    const dirHandle = await open(currentAbs, constants.O_RDONLY | noFollow | oDirectory).catch(() => {
      throw new HardwareRunnerError('ARTIFACT_INVALID', 'symlink or unreadable directory inside held_out_workloads');
    });
    await dirHandle.close();

    const dirents = await readdir(currentAbs, { withFileTypes: true });
    dirents.sort((a, b) => compareUtf16(a.name, b.name));

    for (const dirent of dirents) {
      if (dirent.isSymbolicLink()) {
        throw new HardwareRunnerError('ARTIFACT_INVALID', `symlink "${dirent.name}" is forbidden inside held_out_workloads`);
      }
      const childAbs = join(currentAbs, dirent.name);
      const childRel = relPrefix.length === 0 ? dirent.name : `${relPrefix}/${dirent.name}`;
      const st = await lstat(childAbs).catch(() => null);
      if (st === null || st.isSymbolicLink()) {
        throw new HardwareRunnerError('ARTIFACT_INVALID', `symlink or vanished entry "${childRel}" inside held_out_workloads`);
      }
      const realChild = await realpath(childAbs).catch(() => {
        throw new HardwareRunnerError('ARTIFACT_INVALID', `unable to resolve "${childRel}" inside held_out_workloads`);
      });
      if (!isInsideRealWorkload(realChild)) {
        throw new HardwareRunnerError('ARTIFACT_INVALID', `entry "${childRel}" escapes held-out workload directory`);
      }

      const childSnapPath = currentSnapDir !== null ? join(currentSnapDir, dirent.name) : null;
      if (st.isDirectory()) {
        if (childSnapPath !== null) {
          await mkdir(childSnapPath, { mode: 0o700 });
          const createdSt = await lstat(childSnapPath);
          if (createdSt.isSymbolicLink() || !createdSt.isDirectory()) {
            throw new HardwareRunnerError('RUNNER_SANDBOX_FAILED', 'symlink detected while creating workload snapshot directory');
          }
        }
        await walk(childAbs, childRel, childSnapPath, depth + 1);
        if (childSnapPath !== null) {
          createdSnapDirs.push(childSnapPath);
        }
      } else if (st.isFile()) {
        if (entries.length >= maxFiles) {
          throw new HardwareRunnerError('ARTIFACT_INVALID', `held-out workload exceeds ${maxFiles} files`);
        }
        const hashed = await streamWorkloadFileNoFollow(childAbs, maxFileBytes, childSnapPath, options.signal);
        if (hashed.bytes > maxTotalBytes - totalBytes) {
          throw new HardwareRunnerError('PAYLOAD_TOO_LARGE', `held-out workload exceeds ${maxTotalBytes} total bytes`);
        }
        totalBytes += hashed.bytes;
        entries.push({ relPath: childRel, bytes: hashed.bytes, sha256: hashed.sha256 });
      } else {
        throw new HardwareRunnerError('ARTIFACT_INVALID', `unsupported special file "${childRel}" in held_out_workloads`);
      }
    }
  };

  await walk(workloadDir, '', resolvedSnapRoot, 0);

  if (resolvedSnapRoot !== null) {
    for (const snapSubDir of createdSnapDirs) {
      await chmod(snapSubDir, 0o500);
    }
    await chmod(resolvedSnapRoot, 0o500);
  }

  entries.sort((a, b) => compareUtf16(a.relPath, b.relPath));

  const treeHasher = createHash('sha256');
  treeHasher.update(`${WORKLOAD_TREE_DOMAIN}\n`, 'utf8');
  for (const item of entries) {
    treeHasher.update(`${item.relPath}\0${item.bytes}\0${item.sha256}\n`, 'utf8');
  }

  return Object.freeze({
    workloadDir: resolvedSnapRoot ?? workloadDir,
    digest: Object.freeze({ algorithm: 'sha256' as const, hex: treeHasher.digest('hex') }),
    fileCount: entries.length,
    totalBytes,
  });
}

/**
 * Deterministically compute the SHA-256 tree digest over `<heldOutWorkloadsDir>/<heldOutWorkloadId>`
 * verifying `O_NOFOLLOW` across every ancestor, subdirectory, and file while rejecting symlinks and hardlinks.
 */
export async function computeHeldOutWorkloadDigest(
  heldOutWorkloadsDir: string,
  heldOutWorkloadId: string,
  options: ComputeWorkloadDigestOptions = {},
): Promise<{ readonly workloadDir: string; readonly digest: Digest; readonly fileCount: number; readonly totalBytes: number }> {
  return processHeldOutWorkloadTree(heldOutWorkloadsDir, heldOutWorkloadId, null, options);
}

/**
 * Atomically copy `<heldOutWorkloadsDir>/<heldOutWorkloadId>` into an immutable private `0o500`/`0o400`
 * snapshot directory while computing its deterministic SHA-256 tree digest over the exact copied bytes,
 * eliminating any TOCTOU window between Stage A compilation and Stage B blind execution.
 */
export async function snapshotHeldOutWorkload(
  heldOutWorkloadsDir: string,
  heldOutWorkloadId: string,
  snapshotDestDir: string,
  options: ComputeWorkloadDigestOptions = {},
): Promise<{ readonly snapshotDir: string; readonly digest: Digest; readonly fileCount: number; readonly totalBytes: number }> {
  const res = await processHeldOutWorkloadTree(heldOutWorkloadsDir, heldOutWorkloadId, snapshotDestDir, options);
  return Object.freeze({
    snapshotDir: res.workloadDir,
    digest: res.digest,
    fileCount: res.fileCount,
    totalBytes: res.totalBytes,
  });
}

function inferAcceleratorFamily(accelerator: string): 'nvidia' | 'amd' | 'huawei' | 'unknown' {
  const lower = accelerator.toLowerCase();
  if (lower.startsWith('sm_')) return 'nvidia';
  if (lower.startsWith('gfx')) return 'amd';
  if (lower.startsWith('ascend')) return 'huawei';
  return 'unknown';
}

/**
 * Collect authenticated `HardwareProvenance` either from deterministic `synthetic_fixture` metadata
 * (never spoofing `'physical'`) or by executing trusted host accelerator binaries (`nvidia-smi`,
 * `rocm-smi`/`rocminfo`, `npu-smi`) with `shell: false`. Never injects unobserved topology or
 * derived runtime versions on physical probes.
 */
export async function collectHardwareProvenance(
  options: CollectHardwareProvenanceOptions,
): Promise<HardwareProvenance> {
  const { capabilities, targetCellId, targetHardware, workloadDigest } = options;
  if (options.probeMode === 'synthetic_fixture') {
    const family = inferAcceleratorFamily(capabilities.accelerator);
    const vendor = family === 'unknown' ? 'synthetic' : family;
    const isolationMode = targetHardware !== undefined && capabilities.isolationModes.includes(targetHardware.isolationMode)
      ? targetHardware.isolationMode
      : capabilities.isolationModes[0]!;
    const requestedSynthetic = targetHardware?.deviceCount ?? 1;
    const allocatedDevices = Math.min(capabilities.deviceCount, Math.max(1, requestedSynthetic));
    const topology = capabilities.topology;

    const out: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
    out.targetCellId = targetCellId;
    out.probeKind = 'synthetic_fixture';
    out.vendor = vendor;
    out.deviceModel = `Loopwright Synthetic Fixture (${capabilities.accelerator})`;
    out.accelerator = capabilities.accelerator;
    out.isolationMode = isolationMode;
    out.deviceCount = allocatedDevices;
    out.driverVersion = capabilities.driverVersion;
    out.runtimeVersion = `${vendor}-synthetic-1.0`;
    if (topology !== undefined) out.topology = topology;
    out.workloadDigest = Object.freeze({ algorithm: 'sha256' as const, hex: workloadDigest.hex });
    out.clockLockMode = 'unknown';
    return Object.freeze(out as unknown as HardwareProvenance);
  }

  const timeoutMs = options.timeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS;
  const runner = options.commandRunner ?? defaultProbeCommandRunner;
  const verifier = options.verifyExecutable ?? ((binPath: string, allowlist: readonly string[]) =>
    verifyTrustedProbeExecutable(binPath, allowlist));

  const preferredAccelerator = targetHardware?.accelerator ?? capabilities.accelerator;
  // Default omitted deviceCount to 1 (matching Docker's single-device grant) so physical provenance
  // never overstates allocation or reports links across unallocated host devices.
  const effectiveAllocatedCount = targetHardware?.deviceCount ?? (options.allocatedDeviceIndices?.length ?? 1);
  if (!Number.isSafeInteger(effectiveAllocatedCount) || effectiveAllocatedCount < 1 || effectiveAllocatedCount > 64) {
    throw new HardwareRunnerError('RUNNER_SANDBOX_FAILED', `invalid targetHardware.deviceCount (${String(effectiveAllocatedCount)})`);
  }
  const explicitAllocatedIndices = options.allocatedDeviceIndices;
  const family = inferAcceleratorFamily(capabilities.accelerator);
  const runOpts = { timeoutMs, ...(options.signal !== undefined ? { signal: options.signal } : {}) };
  const ignoreHostRuntimeVersion = options.sandboxBackend === 'docker' && options.measuredRuntimeVersion === undefined;

  let probed: ParsedAcceleratorProbe;

  if (family === 'nvidia') {
    const nvidiaBin = await resolveFirstTrustedProbeExecutable(
      options.executableOverrides?.nvidiaSmiPath,
      TRUSTED_NVIDIA_SMI_PATHS,
      verifier,
    );
    const queryRes = await runner(
      nvidiaBin,
      ['--query-gpu=name,compute_cap,driver_version,mig.mode.current', '--format=csv,noheader,nounits'],
      runOpts,
    );
    if (queryRes.exitCode !== 0) {
      throw new HardwareRunnerError('RUNNER_SANDBOX_FAILED', 'nvidia-smi query command exited with non-zero status');
    }
    const targetDetailIds = explicitAllocatedIndices !== undefined
      ? explicitAllocatedIndices.join(',')
      : Array.from({ length: effectiveAllocatedCount }, (_, idx) => String(idx)).join(',');
    const detailRes = await runner(nvidiaBin, ['-i', targetDetailIds, '-q'], runOpts).catch(() => ({
      exitCode: 1,
      stdout: '',
      stderr: '',
    }));
    const topoRes = await runner(nvidiaBin, ['topo', '-m'], runOpts).catch(() => ({ exitCode: 1, stdout: '', stderr: '' }));
    probed = parseNvidiaSmiOutput(
      queryRes.stdout,
      detailRes.exitCode === 0 ? detailRes.stdout : '',
      {
        preferredAccelerator,
        topoOutput: topoRes.exitCode === 0 ? topoRes.stdout : '',
        allocatedDeviceCount: effectiveAllocatedCount,
        ...(explicitAllocatedIndices !== undefined ? { allocatedDeviceIndices: explicitAllocatedIndices } : {}),
        detailScopedToAllocated: true,
        ...(options.measuredRuntimeVersion !== undefined ? { measuredRuntimeVersion: options.measuredRuntimeVersion } : {}),
      },
    );
  } else if (family === 'amd') {
    const rocmSmiBin = await resolveFirstTrustedProbeExecutable(
      options.executableOverrides?.rocmSmiPath,
      TRUSTED_ROCM_SMI_PATHS,
      verifier,
    );
    let smiRes = await runner(rocmSmiBin, ['--showproductname', '--showdriverversion', '--json'], runOpts);
    if (smiRes.exitCode !== 0 || smiRes.stdout.trim().length === 0) {
      smiRes = await runner(rocmSmiBin, ['--showproductname', '--showdriverversion'], runOpts);
    }
    const topoRes = await runner(rocmSmiBin, ['--showtopo'], runOpts).catch(() => ({ exitCode: 1, stdout: '', stderr: '' }));
    let rocminfoOut = '';
    try {
      const rocminfoBin = await resolveFirstTrustedProbeExecutable(
        options.executableOverrides?.rocminfoPath,
        TRUSTED_ROCMINFO_PATHS,
        verifier,
      );
      const infoRes = await runner(rocminfoBin, [], runOpts);
      if (infoRes.exitCode === 0) {
        rocminfoOut = infoRes.stdout;
      }
    } catch {
      // Optional enrichment when rocm-smi already reports GFX Version.
    }
    if (smiRes.exitCode !== 0 && rocminfoOut.trim().length === 0) {
      throw new HardwareRunnerError('RUNNER_SANDBOX_FAILED', 'rocm-smi and rocminfo probes exited with non-zero status');
    }
    probed = parseRocmSmiOutput(
      smiRes.exitCode === 0 ? smiRes.stdout : '',
      rocminfoOut,
      {
        topoOutput: topoRes.exitCode === 0 ? topoRes.stdout : '',
        allocatedDeviceCount: effectiveAllocatedCount,
        ...(explicitAllocatedIndices !== undefined ? { allocatedDeviceIndices: explicitAllocatedIndices } : {}),
        ignoreHostRuntimeVersion,
        ...(options.measuredRuntimeVersion !== undefined ? { measuredRuntimeVersion: options.measuredRuntimeVersion } : {}),
      },
    );
  } else if (family === 'huawei') {
    const npuBin = await resolveFirstTrustedProbeExecutable(
      options.executableOverrides?.npuSmiPath,
      TRUSTED_NPU_SMI_PATHS,
      verifier,
    );
    const npuRes = await runner(npuBin, ['info'], runOpts);
    if (npuRes.exitCode !== 0) {
      throw new HardwareRunnerError('RUNNER_SANDBOX_FAILED', 'npu-smi info command exited with non-zero status');
    }
    const topoRes = await runner(npuBin, ['info', '-t', 'topo'], runOpts).catch(() => ({ exitCode: 1, stdout: '', stderr: '' }));
    probed = parseNpuSmiOutput(npuRes.stdout, {
      preferredAccelerator,
      topoOutput: topoRes.exitCode === 0 ? topoRes.stdout : '',
      allocatedDeviceCount: effectiveAllocatedCount,
      ...(explicitAllocatedIndices !== undefined ? { allocatedDeviceIndices: explicitAllocatedIndices } : {}),
      ignoreHostRuntimeVersion,
      ...(options.measuredRuntimeVersion !== undefined ? { measuredRuntimeVersion: options.measuredRuntimeVersion } : {}),
    });
  } else {
    throw new HardwareRunnerError(
      'RUNNER_SANDBOX_FAILED',
      `unsupported physical accelerator family for "${capabilities.accelerator}"`,
    );
  }

  const out: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  out.targetCellId = targetCellId;
  out.probeKind = 'physical';
  out.vendor = probed.vendor;
  out.deviceModel = probed.deviceModel;
  out.accelerator = probed.accelerator;
  out.isolationMode = probed.isolationMode;
  out.deviceCount = probed.deviceCount;
  out.driverVersion = probed.driverVersion;
  out.runtimeVersion = probed.runtimeVersion;
  if (probed.topology !== undefined) out.topology = probed.topology;
  out.workloadDigest = Object.freeze({ algorithm: 'sha256' as const, hex: workloadDigest.hex });
  out.clockLockMode = probed.clockLockMode;
  return Object.freeze(out as unknown as HardwareProvenance);
}

export const DEFAULT_HEALTH_PROBE_TIMEOUT_MS = 10_000;

export interface ProbeAcceleratorHealthOptions {
  readonly probeMode: 'physical' | 'synthetic_fixture';
  readonly capabilities: WorkerCapabilities;
  readonly targetHardware?: HardwareTargetSpec;
  readonly allocatedDeviceIndices?: readonly number[];
  readonly executableOverrides?: {
    readonly nvidiaSmiPath?: string;
    readonly rocmSmiPath?: string;
    readonly npuSmiPath?: string;
  };
  readonly commandRunner?: ProbeCommandRunner;
  readonly verifyExecutable?: (binaryPath: string, trustedAllowlist: readonly string[]) => Promise<string>;
  readonly scrubber?: SecretScrubber;
  readonly extraSecrets?: readonly string[];
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
}

function scrubHealthSnippet(raw: string, scrubber: SecretScrubber, maxLen = 512): string {
  const scrubbed = stripAnsiSequences(scrubber.scrub(raw))
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!scrubbed) return '';
  if (scrubbed.length <= maxLen) return scrubbed;
  return `${scrubbed.slice(0, Math.max(1, maxLen - 14))}...(truncated)`;
}

function buildHealthFinding(title: string, evidence: string, scrubber: SecretScrubber): StructuredFinding {
  const safeTitle = scrubHealthSnippet(title, scrubber, LIMITS.findingTitle) || 'Accelerator health fault';
  const safeEvidence = scrubHealthSnippet(evidence, scrubber, LIMITS.findingEvidence) || safeTitle;
  const out: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  out.title = safeTitle;
  out.severity = 'critical';
  out.evidence = safeEvidence;
  return Object.freeze(out as unknown as StructuredFinding);
}

function buildUnhealthyProbeResult(options: {
  readonly probeKind: 'physical' | 'synthetic_fixture';
  readonly vendor: 'nvidia' | 'amd' | 'huawei' | 'synthetic';
  readonly checkedDeviceIndices: readonly number[];
  readonly faultKind: AcceleratorFaultKind;
  readonly externalHostLoss?: boolean;
  readonly title: string;
  readonly detail: string;
  readonly scrubber: SecretScrubber;
}): AcceleratorHealthProbeResult {
  const safeSummary =
    scrubHealthSnippet(options.detail, options.scrubber, 512)
    || `Accelerator health check failed (${options.faultKind})`;
  const finding = buildHealthFinding(options.title, safeSummary, options.scrubber);
  const out: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  out.healthy = false;
  out.quarantineRequired = true;
  out.probeKind = options.probeKind;
  out.vendor = options.vendor;
  out.checkedDeviceIndices = Object.freeze([...options.checkedDeviceIndices]);
  out.faultKind = options.faultKind;
  if (options.externalHostLoss === true) {
    out.externalHostLoss = true;
  }
  out.summary = safeSummary;
  out.findings = Object.freeze([finding]);
  return Object.freeze(out as unknown as AcceleratorHealthProbeResult);
}

function parseOptionalNonNegativeCounter(raw: string): number | null {
  const cleaned = raw.trim().replace(/^\[|\]$/g, '').trim();
  if (
    cleaned.length === 0
    || /^(?:n\/a|not\s+supported|disabled|none|unknown|-)$/i.test(cleaned)
  ) {
    return null;
  }
  const m = /^(\d+)\b/.exec(cleaned);
  if (m === null) return null;
  const n = Number.parseInt(m[1]!, 10);
  return Number.isSafeInteger(n) && n >= 0 ? n : null;
}

function classifyFailedProbeOutput(
  vendor: 'nvidia' | 'amd' | 'huawei',
  combinedOutput: string,
): { readonly faultKind: AcceleratorFaultKind; readonly externalHostLoss: boolean } {
  const cleaned = stripAnsiSequences(combinedOutput);
  if (/\bxid\b/i.test(cleaned)) {
    return { faultKind: 'xid_error', externalHostLoss: false };
  }
  if (
    /no devices were found|driver.*not loaded|failed to initialize nvml|no amd gpus|no npu/i.test(cleaned)
  ) {
    return { faultKind: 'device_lost', externalHostLoss: true };
  }
  if (/gpu is lost|fallen off the bus|unable to determine the device handle/i.test(cleaned)) {
    return { faultKind: 'device_lost', externalHostLoss: false };
  }
  if (/gpu requires reset|reset required|gpu reset|gpu hang|gpu recovery|wedged/i.test(cleaned)) {
    return { faultKind: 'gpu_reset_required', externalHostLoss: false };
  }
  if (/uncorrectable|double\s+bit\s+ecc|remapping\s+failure/i.test(cleaned)) {
    return { faultKind: 'ecc_uncorrectable', externalHostLoss: false };
  }
  void vendor;
  return { faultKind: 'probe_failed', externalHostLoss: false };
}

export function parseNvidiaHealthOutput(
  queryOutput: string,
  detailOutput: string,
  checkedDeviceIndices: readonly number[],
  scrubber: SecretScrubber,
): AcceleratorHealthProbeResult {
  const combined = `${queryOutput}\n${detailOutput}`;
  if (/\bxid\b[:\s#-]*\d*/i.test(combined) && /\bxid\b/i.test(combined)) {
    return buildUnhealthyProbeResult({
      probeKind: 'physical',
      vendor: 'nvidia',
      checkedDeviceIndices,
      faultKind: 'xid_error',
      title: 'NVIDIA sticky Xid fault detected',
      detail: combined,
      scrubber,
    });
  }
  if (/gpu is lost|fallen off the bus|unable to determine the device handle/i.test(combined)) {
    return buildUnhealthyProbeResult({
      probeKind: 'physical',
      vendor: 'nvidia',
      checkedDeviceIndices,
      faultKind: 'device_lost',
      title: 'NVIDIA GPU lost on bus',
      detail: combined,
      scrubber,
    });
  }
  if (/no devices were found|failed to initialize nvml/i.test(combined)) {
    return buildUnhealthyProbeResult({
      probeKind: 'physical',
      vendor: 'nvidia',
      checkedDeviceIndices,
      faultKind: 'device_lost',
      externalHostLoss: true,
      title: 'NVIDIA host devices unavailable',
      detail: combined,
      scrubber,
    });
  }
  if (/gpu requires reset|reset required/i.test(combined)) {
    return buildUnhealthyProbeResult({
      probeKind: 'physical',
      vendor: 'nvidia',
      checkedDeviceIndices,
      faultKind: 'gpu_reset_required',
      title: 'NVIDIA GPU requires reset',
      detail: combined,
      scrubber,
    });
  }

  const lines = stripAnsiSequences(queryOutput)
    .split(/\r?\n/)
    .map(l => l.trim())
    .filter(l => l.length > 0);
  if (lines.length === 0) {
    return buildUnhealthyProbeResult({
      probeKind: 'physical',
      vendor: 'nvidia',
      checkedDeviceIndices,
      faultKind: 'probe_failed',
      title: 'Empty nvidia-smi health output',
      detail: 'nvidia-smi returned empty GPU health output',
      scrubber,
    });
  }

  const rowsByIndex = new Map<number, readonly string[]>();
  lines.forEach((line, positionalIdx) => {
    const cols = line.split(',').map(c => c.trim());
    const parsedIdx = /^\d+$/.test(cols[0] ?? '') ? Number.parseInt(cols[0]!, 10) : positionalIdx;
    rowsByIndex.set(parsedIdx, cols);
  });

  for (const idx of checkedDeviceIndices) {
    const row = rowsByIndex.get(idx);
    if (row === undefined) {
      return buildUnhealthyProbeResult({
        probeKind: 'physical',
        vendor: 'nvidia',
        checkedDeviceIndices,
        faultKind: 'device_lost',
        title: `NVIDIA GPU ${idx} missing from health query`,
        detail: `Allocated GPU index ${idx} was not reported by nvidia-smi`,
        scrubber,
      });
    }
    if (row.some(col => /\b(?:err!|unknown error|gpu is lost)\b/i.test(col))) {
      return buildUnhealthyProbeResult({
        probeKind: 'physical',
        vendor: 'nvidia',
        checkedDeviceIndices,
        faultKind: 'health_degraded',
        title: `NVIDIA GPU ${idx} reported error state`,
        detail: row.join(', '),
        scrubber,
      });
    }
    // Columns 6 and 7 are ecc.errors.uncorrected.volatile.total and aggregate.total when present;
    // on GeForce SKUs (e.g. RTX 4090) these report "[N/A]", which is healthy.
    for (const colIdx of [6, 7]) {
      if (colIdx < row.length) {
        const count = parseOptionalNonNegativeCounter(row[colIdx]!);
        if (count !== null && count > 0) {
          return buildUnhealthyProbeResult({
            probeKind: 'physical',
            vendor: 'nvidia',
            checkedDeviceIndices,
            faultKind: 'ecc_uncorrectable',
            title: `NVIDIA GPU ${idx} uncorrectable ECC error`,
            detail: `GPU ${idx} reported ${count} uncorrectable ECC error(s)`,
            scrubber,
          });
        }
      }
    }
  }

  if (detailOutput.trim().length > 0) {
    const cleanedDetail = stripAnsiSequences(detailOutput);
    if (/Remapping\s+Failure\s+Occurred\s*:\s*Yes/i.test(cleanedDetail)) {
      return buildUnhealthyProbeResult({
        probeKind: 'physical',
        vendor: 'nvidia',
        checkedDeviceIndices,
        faultKind: 'ecc_uncorrectable',
        title: 'NVIDIA HBM/GDDR row remapping failure',
        detail: 'nvidia-smi reported Remapping Failure Occurred: Yes',
        scrubber,
      });
    }
    if (/(?:Channel|TPC)\s+Repair\s+Pending\s*:\s*Yes|Unrepairable\s+Memory\s*:\s*Yes|Pending\s+Page\s+Blacklist\s*:\s*Yes/i.test(cleanedDetail)) {
      return buildUnhealthyProbeResult({
        probeKind: 'physical',
        vendor: 'nvidia',
        checkedDeviceIndices,
        faultKind: 'ecc_uncorrectable',
        title: 'NVIDIA memory repair/blacklist pending or unrepairable',
        detail: cleanedDetail,
        scrubber,
      });
    }
    for (const m of cleanedDetail.matchAll(
      /^\s*(?:SRAM\s+Uncorrectable[^\r\n:]*|DRAM\s+Uncorrectable|Double\s+Bit\s+ECC|Uncorrectable\s+Error)\s*:\s*([^\r\n]+)$/gim,
    )) {
      // Ignore "Inactive Uncorrectable Error" historical counters when active Uncorrectable Error is 0;
      // the regex anchors at start of line whitespace so "Inactive Uncorrectable Error" does not match.
      const cnt = parseOptionalNonNegativeCounter(m[1]!);
      if (cnt !== null && cnt > 0) {
        return buildUnhealthyProbeResult({
          probeKind: 'physical',
          vendor: 'nvidia',
          checkedDeviceIndices,
          faultKind: 'ecc_uncorrectable',
          title: 'NVIDIA uncorrectable memory error counter > 0',
          detail: `${m[0]!.trim()}`,
          scrubber,
        });
      }
    }
  }

  return Object.freeze({
    healthy: true,
    quarantineRequired: false,
    probeKind: 'physical',
    vendor: 'nvidia',
    checkedDeviceIndices: Object.freeze([...checkedDeviceIndices]),
    summary: `NVIDIA GPU health OK (${checkedDeviceIndices.join(',')})`,
    findings: Object.freeze([]),
  });
}

export function parseRocmHealthOutput(
  rocmOutput: string,
  checkedDeviceIndices: readonly number[],
  scrubber: SecretScrubber,
): AcceleratorHealthProbeResult {
  const cleaned = stripAnsiSequences(rocmOutput);
  if (cleaned.trim().length === 0) {
    return buildUnhealthyProbeResult({
      probeKind: 'physical',
      vendor: 'amd',
      checkedDeviceIndices,
      faultKind: 'probe_failed',
      title: 'Empty rocm-smi health output',
      detail: 'rocm-smi returned empty health output',
      scrubber,
    });
  }
  if (/no amd gpus specified|no amd gpus found/i.test(cleaned)) {
    return buildUnhealthyProbeResult({
      probeKind: 'physical',
      vendor: 'amd',
      checkedDeviceIndices,
      faultKind: 'device_lost',
      externalHostLoss: true,
      title: 'AMD ROCm GPUs unavailable on host',
      detail: cleaned,
      scrubber,
    });
  }
  if (/\b(?:gpu\s+hang|gpu\s+reset|gpu\s+recovery|device\s+lost|wedged|ras\s+fatal)\b/i.test(cleaned)) {
    return buildUnhealthyProbeResult({
      probeKind: 'physical',
      vendor: 'amd',
      checkedDeviceIndices,
      faultKind: 'gpu_reset_required',
      title: 'AMD ROCm GPU reset or hang detected',
      detail: cleaned,
      scrubber,
    });
  }

  // Real rocm-smi --json on Radeon GPUs in runtime PM can emit leading "WARNING: AMD GPU device(s) is/are in a low-power state..."
  // lines on stdout before the JSON payload `{...}`. Extract the JSON object cleanly after any non-JSON preamble.
  const firstBrace = cleaned.indexOf('{');
  const lastBrace = cleaned.lastIndexOf('}');
  if (firstBrace !== -1 && lastBrace > firstBrace) {
    const jsonSlice = cleaned.slice(firstBrace, lastBrace + 1);
    let parsed: unknown;
    try {
      parsed = parseStrictJsonBytes(
        Buffer.from(jsonSlice, 'utf8'),
        MAX_PROBE_OUTPUT_BYTES,
        'RUNNER_SANDBOX_FAILED',
        '/rocmHealth',
      );
    } catch {
      parsed = null;
    }
    if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
      const root = parsed as Readonly<Record<string, unknown>>;
      const inspectCardFaults = (node: unknown, cardIdx: number, keyPath: string): AcceleratorHealthProbeResult | null => {
        if (node === null || node === undefined) return null;
        if (typeof node === 'string' || typeof node === 'number') {
          const textVal = String(node);
          const lowerPath = keyPath.toLowerCase();
          if (
            (lowerPath.includes('uncorrectable') || /(?:^|[/._ -])ue$/i.test(lowerPath) || lowerPath.includes('unreservable'))
          ) {
            const cnt = parseOptionalNonNegativeCounter(textVal);
            if (cnt !== null && cnt > 0) {
              return buildUnhealthyProbeResult({
                probeKind: 'physical',
                vendor: 'amd',
                checkedDeviceIndices,
                faultKind: 'ecc_uncorrectable',
                title: `AMD GPU ${cardIdx} RAS/ECC uncorrectable error`,
                detail: `card${cardIdx} ${keyPath}=${textVal}`,
                scrubber,
              });
            }
          }
          if (/\b(?:gpu\s+hang|gpu\s+reset|wedged|unresponsive|err!|fatal)\b/i.test(textVal)) {
            return buildUnhealthyProbeResult({
              probeKind: 'physical',
              vendor: 'amd',
              checkedDeviceIndices,
              faultKind: 'gpu_reset_required',
              title: `AMD GPU ${cardIdx} degraded state`,
              detail: `card${cardIdx} ${keyPath}=${textVal}`,
              scrubber,
            });
          }
          return null;
        }
        if (typeof node === 'object' && !Array.isArray(node)) {
          const rec = node as Readonly<Record<string, unknown>>;
          for (const k of Object.keys(rec).sort()) {
            if (!Object.hasOwn(rec, k)) continue;
            const sub = inspectCardFaults(rec[k], cardIdx, keyPath ? `${keyPath}.${k}` : k);
            if (sub !== null) return sub;
          }
        }
        return null;
      };

      for (const idx of checkedDeviceIndices) {
        const cardObj = Object.hasOwn(root, `card${idx}`)
          ? root[`card${idx}`]
          : Object.hasOwn(root, `gpu${idx}`)
            ? root[`gpu${idx}`]
            : undefined;
        if (cardObj === undefined || cardObj === null || typeof cardObj !== 'object') {
          return buildUnhealthyProbeResult({
            probeKind: 'physical',
            vendor: 'amd',
            checkedDeviceIndices,
            faultKind: 'device_lost',
            title: `AMD GPU ${idx} missing from rocm-smi JSON`,
            detail: `Expected card${idx} in rocm-smi JSON output`,
            scrubber,
          });
        }
        const fault = inspectCardFaults(cardObj, idx, '');
        if (fault !== null) return fault;
      }

      return Object.freeze({
        healthy: true,
        quarantineRequired: false,
        probeKind: 'physical',
        vendor: 'amd',
        checkedDeviceIndices: Object.freeze([...checkedDeviceIndices]),
        summary: `AMD ROCm GPU health OK (${checkedDeviceIndices.join(',')})`,
        findings: Object.freeze([]),
      });
    }
  }

  // Plain-text rocm-smi fallback: check allocated GPU presence and RAS uncorrectable error counts
  const seenGpus = new Set<number>();
  for (const rawLine of cleaned.split(/\r?\n/)) {
    const line = rawLine.trim();
    const gpuMatch = /^(?:GPU|card)\[(\d+)\]/i.exec(line);
    if (gpuMatch !== null) {
      seenGpus.add(Number.parseInt(gpuMatch[1]!, 10));
    }
    const ueKv = /Uncorrectable\s+Error[s]?\s*:\s*(\d+)/i.exec(line);
    if (ueKv !== null && Number.parseInt(ueKv[1]!, 10) > 0) {
      return buildUnhealthyProbeResult({
        probeKind: 'physical',
        vendor: 'amd',
        checkedDeviceIndices,
        faultKind: 'ecc_uncorrectable',
        title: 'AMD ROCm RAS uncorrectable error',
        detail: line,
        scrubber,
      });
    }
    // RAS table row: <Block> <Status> <Correctable> <Uncorrectable>
    const rasRow = /^[A-Za-z0-9_]+\s+(?:ENABLED|ACTIVE|OK)\s+(\d+)\s+(\d+)\s*$/i.exec(line);
    if (rasRow !== null && Number.parseInt(rasRow[2]!, 10) > 0) {
      return buildUnhealthyProbeResult({
        probeKind: 'physical',
        vendor: 'amd',
        checkedDeviceIndices,
        faultKind: 'ecc_uncorrectable',
        title: 'AMD ROCm RAS block uncorrectable error',
        detail: line,
        scrubber,
      });
    }
  }

  for (const idx of checkedDeviceIndices) {
    if (!seenGpus.has(idx)) {
      return buildUnhealthyProbeResult({
        probeKind: 'physical',
        vendor: 'amd',
        checkedDeviceIndices,
        faultKind: 'device_lost',
        title: `AMD GPU ${idx} missing from rocm-smi output`,
        detail: `GPU[${idx}] not present in rocm-smi health output`,
        scrubber,
      });
    }
  }

  return Object.freeze({
    healthy: true,
    quarantineRequired: false,
    probeKind: 'physical',
    vendor: 'amd',
    checkedDeviceIndices: Object.freeze([...checkedDeviceIndices]),
    summary: `AMD ROCm GPU health OK (${checkedDeviceIndices.join(',')})`,
    findings: Object.freeze([]),
  });
}

export function parseNpuHealthOutput(
  npuOutput: string,
  checkedDeviceIndices: readonly number[],
  scrubber: SecretScrubber,
): AcceleratorHealthProbeResult {
  const cleaned = stripAnsiSequences(npuOutput);
  if (cleaned.trim().length === 0) {
    return buildUnhealthyProbeResult({
      probeKind: 'physical',
      vendor: 'huawei',
      checkedDeviceIndices,
      faultKind: 'probe_failed',
      title: 'Empty npu-smi health output',
      detail: 'npu-smi returned empty output',
      scrubber,
    });
  }
  if (/no npu|device not found/i.test(cleaned)) {
    return buildUnhealthyProbeResult({
      probeKind: 'physical',
      vendor: 'huawei',
      checkedDeviceIndices,
      faultKind: 'device_lost',
      externalHostLoss: true,
      title: 'Ascend NPU unavailable on host',
      detail: cleaned,
      scrubber,
    });
  }

  const healthByIndex = new Map<number, string>();
  let activeKvIdx: number | null = null;
  for (const rawLine of cleaned.split(/\r?\n/)) {
    const trimmed = rawLine.trim();
    if (!trimmed) continue;
    // Table row: | 0     910B3               | OK            | 92.4 ... |
    const tableRow = /^\|\s*(\d+)\s+(?:Ascend[\s_-]*)?[0-9]{3}[A-Za-z0-9_-]*\s*\|\s*([A-Za-z0-9_-]+)\s*\|/i.exec(trimmed);
    if (tableRow !== null) {
      const idx = Number.parseInt(tableRow[1]!, 10);
      healthByIndex.set(idx, tableRow[2]!);
      continue;
    }
    const kvId = /^(?:NPU\s+ID|NPU)\s*:\s*(\d+)\s*$/i.exec(trimmed);
    if (kvId !== null) {
      activeKvIdx = Number.parseInt(kvId[1]!, 10);
      continue;
    }
    const kvHealth = /^Health(?:\s+Status)?\s*:\s*([A-Za-z0-9_-]+)\s*$/i.exec(trimmed);
    if (kvHealth !== null) {
      const targetIdx = activeKvIdx ?? 0;
      healthByIndex.set(targetIdx, kvHealth[1]!);
      continue;
    }
    const kvEcc = /(?:Uncorrectable|Double\s+Bit)[^\r\n:]*:\s*(\d+)/i.exec(trimmed);
    if (kvEcc !== null && Number.parseInt(kvEcc[1]!, 10) > 0) {
      return buildUnhealthyProbeResult({
        probeKind: 'physical',
        vendor: 'huawei',
        checkedDeviceIndices,
        faultKind: 'ecc_uncorrectable',
        title: 'Ascend NPU uncorrectable ECC fault',
        detail: trimmed,
        scrubber,
      });
    }
  }

  for (const idx of checkedDeviceIndices) {
    const health = healthByIndex.get(idx);
    if (health === undefined) {
      return buildUnhealthyProbeResult({
        probeKind: 'physical',
        vendor: 'huawei',
        checkedDeviceIndices,
        faultKind: 'device_lost',
        title: `Ascend NPU ${idx} missing from npu-smi info`,
        detail: `Allocated NPU ${idx} missing from npu-smi health output`,
        scrubber,
      });
    }
    if (health.toUpperCase() !== 'OK') {
      return buildUnhealthyProbeResult({
        probeKind: 'physical',
        vendor: 'huawei',
        checkedDeviceIndices,
        faultKind: 'health_degraded',
        title: `Ascend NPU ${idx} reported non-OK health (${health})`,
        detail: `NPU ${idx} health status is "${health}"`,
        scrubber,
      });
    }
  }

  return Object.freeze({
    healthy: true,
    quarantineRequired: false,
    probeKind: 'physical',
    vendor: 'huawei',
    checkedDeviceIndices: Object.freeze([...checkedDeviceIndices]),
    summary: `Ascend NPU health OK (${checkedDeviceIndices.join(',')})`,
    findings: Object.freeze([]),
  });
}

/**
 * Execute an out-of-band trusted host accelerator health probe (`nvidia-smi`, `rocm-smi`, `npu-smi`)
 * to detect sticky GPU/NPU faults (`Xid`, uncorrectable ECC, row-remap failure, GPU reset/hang, or
 * unresponsive device) after a Stage B timeout, crash signal, or non-zero exit.
 *
 * Always scrubs probe outputs through `SecretScrubber` and returns a structured
 * `AcceleratorHealthProbeResult` (`quarantineRequired: true` on any unresponsive or degraded state).
 */
export async function probeAcceleratorHealth(
  options: ProbeAcceleratorHealthOptions,
): Promise<AcceleratorHealthProbeResult> {
  const scrubber = options.scrubber ?? new SecretScrubber();
  if (options.extraSecrets !== undefined) {
    for (const sec of options.extraSecrets) {
      if (typeof sec === 'string' && sec.length > 0) {
        scrubber.register(sec);
      }
    }
  }

  const family = inferAcceleratorFamily(options.capabilities.accelerator);
  const requestedCount = options.targetHardware?.deviceCount ?? (options.allocatedDeviceIndices?.length ?? 1);
  const safeCount = Math.min(Math.max(1, requestedCount), Math.max(1, options.capabilities.deviceCount));
  const checkedDeviceIndices: readonly number[] = options.allocatedDeviceIndices !== undefined && options.allocatedDeviceIndices.length > 0
    ? Object.freeze([...options.allocatedDeviceIndices])
    : Object.freeze(Array.from({ length: safeCount }, (_, i) => i));

  if (options.probeMode === 'synthetic_fixture' && options.commandRunner === undefined) {
    const syntheticVendor = family === 'unknown' ? 'synthetic' : family;
    return Object.freeze({
      healthy: true,
      quarantineRequired: false,
      probeKind: 'synthetic_fixture',
      vendor: syntheticVendor,
      checkedDeviceIndices,
      summary: `Synthetic accelerator fixture healthy (${options.capabilities.accelerator})`,
      findings: Object.freeze([]),
    });
  }

  if (family === 'unknown') {
    return buildUnhealthyProbeResult({
      probeKind: options.probeMode,
      vendor: 'synthetic',
      checkedDeviceIndices,
      faultKind: 'probe_failed',
      title: 'Unsupported accelerator family for physical health probe',
      detail: `Unsupported accelerator "${options.capabilities.accelerator}"`,
      scrubber,
    });
  }

  const timeoutMs = options.timeoutMs ?? DEFAULT_HEALTH_PROBE_TIMEOUT_MS;
  const runner = options.commandRunner ?? defaultProbeCommandRunner;
  const verifier = options.verifyExecutable ?? ((binPath: string, allowlist: readonly string[]) =>
    verifyTrustedProbeExecutable(binPath, allowlist));
  const runOpts = { timeoutMs, ...(options.signal !== undefined ? { signal: options.signal } : {}) };

  try {
    if (family === 'nvidia') {
      const nvidiaBin = await resolveFirstTrustedProbeExecutable(
        options.executableOverrides?.nvidiaSmiPath,
        TRUSTED_NVIDIA_SMI_PATHS,
        verifier,
      );
      const queryRes = await runner(
        nvidiaBin,
        [
          '--query-gpu=index,name,uuid,pci.bus_id,pstate,ecc.mode.current,ecc.errors.uncorrected.volatile.total,ecc.errors.uncorrected.aggregate.total',
          '--format=csv,noheader,nounits',
        ],
        runOpts,
      );
      if (queryRes.exitCode !== 0) {
        const combined = `${queryRes.stdout}\n${queryRes.stderr}`;
        const classified = classifyFailedProbeOutput('nvidia', combined);
        return buildUnhealthyProbeResult({
          probeKind: options.probeMode,
          vendor: 'nvidia',
          checkedDeviceIndices,
          faultKind: classified.faultKind,
          externalHostLoss: classified.externalHostLoss,
          title: `nvidia-smi health query failed (exit ${queryRes.exitCode})`,
          detail: combined || `nvidia-smi exited with status ${queryRes.exitCode}`,
          scrubber,
        });
      }
      const targetIdsCsv = checkedDeviceIndices.join(',');
      let detailRes = await runner(
        nvidiaBin,
        ['-i', targetIdsCsv, '-q', '-d', 'ECC,PAGE_RETIREMENT,ROW_REMAPPER'],
        runOpts,
      );
      if (
        detailRes.exitCode !== 0
        && /failed to parse --display\/-d flags/i.test(`${detailRes.stdout}\n${detailRes.stderr}`)
      ) {
        detailRes = await runner(nvidiaBin, ['-i', targetIdsCsv, '-q'], runOpts);
      }
      if (detailRes.exitCode !== 0) {
        const combined = `${detailRes.stdout}\n${detailRes.stderr}`;
        const classified = classifyFailedProbeOutput('nvidia', combined);
        return buildUnhealthyProbeResult({
          probeKind: options.probeMode,
          vendor: 'nvidia',
          checkedDeviceIndices,
          faultKind: classified.faultKind,
          externalHostLoss: classified.externalHostLoss,
          title: `nvidia-smi detail health query failed (exit ${detailRes.exitCode})`,
          detail: combined || `nvidia-smi -q exited with status ${detailRes.exitCode}`,
          scrubber,
        });
      }
      return parseNvidiaHealthOutput(queryRes.stdout, detailRes.stdout, checkedDeviceIndices, scrubber);
    }

    if (family === 'amd') {
      const rocmBin = await resolveFirstTrustedProbeExecutable(
        options.executableOverrides?.rocmSmiPath,
        TRUSTED_ROCM_SMI_PATHS,
        verifier,
      );
      let smiRes = await runner(
        rocmBin,
        ['--showproductname', '--showuse', '--showrasinfo', 'all', '--showretiredpages', '--json'],
        runOpts,
      );
      if (
        smiRes.exitCode !== 0
        && /unrecognized arguments/i.test(`${smiRes.stdout}\n${smiRes.stderr}`)
      ) {
        smiRes = await runner(rocmBin, ['--showproductname', '--showuse', '--json'], runOpts);
      }
      if (smiRes.exitCode !== 0) {
        const combined = `${smiRes.stdout}\n${smiRes.stderr}`;
        const classified = classifyFailedProbeOutput('amd', combined);
        return buildUnhealthyProbeResult({
          probeKind: options.probeMode,
          vendor: 'amd',
          checkedDeviceIndices,
          faultKind: classified.faultKind,
          externalHostLoss: classified.externalHostLoss,
          title: `rocm-smi health query failed (exit ${smiRes.exitCode})`,
          detail: combined || `rocm-smi exited with status ${smiRes.exitCode}`,
          scrubber,
        });
      }
      return parseRocmHealthOutput(smiRes.stdout, checkedDeviceIndices, scrubber);
    }

    const npuBin = await resolveFirstTrustedProbeExecutable(
      options.executableOverrides?.npuSmiPath,
      TRUSTED_NPU_SMI_PATHS,
      verifier,
    );
    const npuRes = await runner(npuBin, ['info'], runOpts);
    if (npuRes.exitCode !== 0) {
      const combined = `${npuRes.stdout}\n${npuRes.stderr}`;
      const classified = classifyFailedProbeOutput('huawei', combined);
      return buildUnhealthyProbeResult({
        probeKind: options.probeMode,
        vendor: 'huawei',
        checkedDeviceIndices,
        faultKind: classified.faultKind,
        externalHostLoss: classified.externalHostLoss,
        title: `npu-smi health query failed (exit ${npuRes.exitCode})`,
        detail: combined || `npu-smi info exited with status ${npuRes.exitCode}`,
        scrubber,
      });
    }
    return parseNpuHealthOutput(npuRes.stdout, checkedDeviceIndices, scrubber);
  } catch (err: unknown) {
    const rawMsg = err instanceof Error ? err.message : String(err);
    const isTimeout = /timed?\s*out|exceeded bounds|ETIMEDOUT/i.test(rawMsg);
    return buildUnhealthyProbeResult({
      probeKind: options.probeMode,
      vendor: family,
      checkedDeviceIndices,
      faultKind: isTimeout ? 'probe_timeout' : 'probe_failed',
      title: isTimeout ? 'Accelerator health probe timed out (device unresponsive)' : 'Accelerator health probe failed',
      detail: rawMsg,
      scrubber,
    });
  }
}
