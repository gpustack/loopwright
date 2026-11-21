import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import { chmod, lstat, mkdir, mkdtemp, open, readdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, isAbsolute, join, resolve } from 'node:path';
import {
  digestArtifact,
  OVERLAY_LIMITS,
  type TaskContract,
} from '@loopwright/core';
import {
  collectControlRootSiblingPaths,
  collectGitHubSiblingPaths,
  type ControlRootSiblingSet,
} from './sandbox.js';
import {
  compileScopePatterns,
  effectiveProtectedPaths,
  extractTaskpackResourcePaths,
  isAllowedCandidateWrite,
  isProtectedCandidatePath,
  normalizeCandidateRelativePath,
  pathCoveredBy,
  resolveBaselineAlignmentConfig,
  resolveManifestControlRoot,
} from './schema.js';
import { SecretScrubber } from './scrubber.js';
import {
  BASELINE_CONFLICT_REASON,
  BASELINE_CONFLICT_RESOURCE_ID,
  BASELINE_CONFLICT_RESOURCE_PATH,
  TaskpackError,
  type BaselineAlignmentOverride,
  type BaselineAlignmentResult,
  type BaselineConflictContextDocument,
  type BaselineConflictContextResource,
  type BaselineConflictHunk,
  type BaselineConflictKind,
  type CandidateScopeSnapshot,
  type CarryDeltaEntry,
  type ExecutionHostPolicy,
  type ExtractedBaselineConflictFile,
  type GitTreeEntry,
  type InspectedCandidateFile,
  type InspectedCandidateSnapshot,
  type PolicyProfile,
  type TaskpackManifest,
} from './types.js';
import {
  buildCleanGitEnv,
  COMMIT_SHA_PATTERN,
  resolveGitExecutable,
} from './upstreams.js';

export {
  BASELINE_CONFLICT_REASON,
  compileScopePatterns,
  isAllowedCandidateWrite,
  isProtectedCandidatePath,
  normalizeCandidateRelativePath,
  type BaselineAlignmentResult,
};

/**
 * Line-anchored matcher for residual Git conflict markers (`<<<<<<<`, `|||||||`, `>>>>>>>`).
 * Intentionally excludes standalone 7-character `=======` lines so Markdown/RST setext headings
 * are not falsely flagged when no conflict open/ancestor/close marker is present.
 */
export const BASELINE_CONFLICT_MARKER_PATTERN = /^(?:<{7}(?:[ \t].*)?|\|{7}(?:[ \t].*)?|>{7}(?:[ \t].*)?)\r?$/m;

export const MAX_GIT_LIST_BYTES = 16 * 1024 * 1024;
const MAX_GIT_STDOUT_BYTES = MAX_GIT_LIST_BYTES;
const MAX_GIT_STDERR_BYTES = 262_144;
const MAX_CARRY_BLOB_BYTES = 64 * 1024 * 1024;
const DEFAULT_GIT_OBJECTS_MAX_FILES = 262_144;
const DEFAULT_GIT_OBJECTS_MAX_BYTES = 4 * 1024 * 1024 * 1024;
const MAX_GIT_OBJECTS_DEPTH = 16;
const MAX_GIT_ALTERNATES_BYTES = 65_536;
const MAX_COMMON_DIR_STDOUT_BYTES = 4_096;
const MAX_OID_STDOUT_BYTES = 256;
const MAX_SIZE_STDOUT_BYTES = 128;
const MIN_BLOB_STDOUT_HEADROOM_BYTES = 1_024;
const BLOB_STDOUT_PADDING_BYTES = 64;
const GIT_VERIFY_TIMEOUT_MS = 10_000;
const GIT_SHORT_OP_TIMEOUT_MS = 15_000;
const GIT_DEFAULT_TIMEOUT_MS = 20_000;
const GIT_MERGE_TREE_TIMEOUT_MS = 30_000;
const CONFLICT_BLOB_READ_MULTIPLIER = 8;
const MIN_CONFLICT_BLOB_READ_CAP_BYTES = 1_048_576;
const MAX_CONFLICT_SUMMARY_PATHS = 8;
const CONFLICT_CONTEXT_LINES = 2;
const MAX_MERGE_FILE_EXIT_CONFLICTS = 127;
const MAX_PATH_SEGMENT_BYTES = 255;
const OID_HEX_PATTERN = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const SHA1_OID_HEX_PATTERN = /^[0-9a-f]{40}$/;
const SHA256_HEX_PATTERN = /^[0-9a-f]{64}$/;
const STREAM_CHUNK_BYTES = 1_048_576;

class BlobSizeCeilingExceededError extends TaskpackError {
  readonly actualBytes: number;
  readonly ceilingBytes: number;
  constructor(oid: string, actualBytes: number, ceilingBytes: number) {
    super('ACTION_INPUT_INVALID', `blob ${oid} (${actualBytes} bytes) exceeds ${ceilingBytes} byte ceiling`);
    this.actualBytes = actualBytes;
    this.ceilingBytes = ceilingBytes;
  }
}

export interface MergeConflictMessageRecord {
  readonly paths: readonly string[];
  readonly conflictType: string;
  readonly message: string;
}

export interface CompiledManifestScopeDetails {
  readonly policyProfile: PolicyProfile;
  readonly allowWorkflowWrites: boolean;
  readonly controlRoot: string;
  readonly manifestPath: string | undefined;
  readonly proposalPath: string | undefined;
  readonly commandScripts: readonly string[];
  readonly allManifestInstructions: readonly string[];
  readonly allManifestSkills: readonly string[];
  readonly relativeToolchainPaths: readonly string[];
  readonly githubSiblings: readonly string[];
  readonly controlRootSiblingSet: ControlRootSiblingSet;
  readonly writablePaths: readonly string[];
  readonly protectedPaths: readonly string[];
}

export interface DeriveManifestCompiledScopeOptions {
  readonly manifest: TaskpackManifest;
  readonly repositoryRoot?: string | undefined;
  readonly taskpackPath?: string | undefined;
  readonly baseRevision: string;
  readonly sourceRevision: string;
  readonly policyProfile?: PolicyProfile | undefined;
  readonly hostPolicy?: ExecutionHostPolicy | undefined;
  readonly extraProtectedPaths?: readonly string[] | undefined;
  readonly githubSiblings?: readonly string[] | undefined;
  readonly controlRootSiblingSet?: ControlRootSiblingSet | undefined;
}

export interface AlignBaselineRevisionsOptions {
  readonly repositoryRoot: string;
  readonly baseRevision: string;
  readonly sourceRevision: string;
  readonly manifest?: TaskpackManifest | undefined;
  readonly taskpackPath?: string | undefined;
  readonly policyProfile?: PolicyProfile | undefined;
  readonly hostPolicy?: ExecutionHostPolicy | undefined;
  readonly extraProtectedPaths?: readonly string[] | undefined;
  readonly scope?: CandidateScopeSnapshot | undefined;
  readonly baselineAlignment?: BaselineAlignmentOverride | undefined;
  readonly scrubber?: SecretScrubber | undefined;
  readonly scratchRoot?: string | undefined;
  readonly forceIndexFallback?: boolean | undefined;
  readonly onLog?: ((line: string) => void) | undefined;
}

export interface AssertExtractedConflictsResolvedOptions {
  readonly extractedConflictPaths: readonly string[];
  readonly snapshot: CandidateScopeSnapshot;
  readonly candidateFiles: readonly InspectedCandidateFile[];
  readonly candidateDeletedPaths?: readonly string[] | undefined;
  readonly sourceSha256ByPath?: ReadonlyMap<string, string> | undefined;
}

export interface ComputeThreeWayCarryDeltaOptions {
  readonly repositoryRoot: string;
  readonly baseRevision: string;
  readonly sourceRevision: string;
  readonly snapshot: CandidateScopeSnapshot;
  readonly baseEntries?: ReadonlyMap<string, GitTreeEntry> | undefined;
  readonly sourceEntries?: ReadonlyMap<string, GitTreeEntry> | undefined;
  readonly candidateFiles?: readonly InspectedCandidateFile[] | undefined;
  readonly candidateDeletedPaths?: readonly string[] | undefined;
  readonly extractedConflictPaths?: readonly string[] | undefined;
  readonly scratchRoot?: string | undefined;
  readonly gitEnv?: Record<string, string> | undefined;
  readonly forceIndexFallback?: boolean | undefined;
  readonly scrubber?: SecretScrubber | undefined;
  readonly onLog?: ((line: string) => void) | undefined;
}

export interface ThreeWayCarryDeltaResult {
  readonly carryRemovals: readonly string[];
  readonly carryUpdates: readonly CarryDeltaEntry[];
  readonly mergeBase: string | null;
  readonly mergedTreeOid: string | null;
  readonly resolvedConflictPaths: readonly string[];
}

export interface MergeCandidateOverlayWithCarryOptions {
  readonly repositoryRoot: string;
  readonly baseRevision: string;
  readonly sourceRevision: string;
  readonly snapshot: CandidateScopeSnapshot;
  readonly overlayFiles: readonly InspectedCandidateFile[];
  readonly candidateDeletedPaths?: readonly string[] | undefined;
  readonly carryUpdates: readonly CarryDeltaEntry[];
  readonly baseEntries?: ReadonlyMap<string, GitTreeEntry> | undefined;
  readonly sourceEntries?: ReadonlyMap<string, GitTreeEntry> | undefined;
  readonly extractedConflictPaths?: readonly string[] | undefined;
  readonly scratchRoot?: string | undefined;
  readonly scrubber?: SecretScrubber | undefined;
  readonly onLog?: ((line: string) => void) | undefined;
}

export interface EnsureCarryBlobsOptions {
  readonly repositoryRoot: string;
  readonly carryUpdates: readonly CarryDeltaEntry[];
  readonly objectFormat?: 'sha1' | 'sha256' | undefined;
  readonly gitEnv?: Record<string, string> | undefined;
}

export interface VerifyCandidateBaselinePrePublicationOptions {
  readonly repositoryRoot: string;
  readonly snapshot: InspectedCandidateSnapshot;
  readonly extractedConflictPaths?: readonly string[] | undefined;
  readonly scratchRoot?: string | undefined;
  readonly gitEnv?: Record<string, string> | undefined;
  readonly forceIndexFallback?: boolean | undefined;
  readonly scrubber?: SecretScrubber | undefined;
  readonly onLog?: ((line: string) => void) | undefined;
}

export interface VerifyCandidatePrePublicationResult extends ThreeWayCarryDeltaResult {
  readonly reconciledOverlayFiles: readonly InspectedCandidateFile[];
}

function compareLexical(a: string, b: string): number {
  if (a === b) return 0;
  return a < b ? -1 : 1;
}

function isSpecialGitTreeEntry(entry: GitTreeEntry | undefined): boolean {
  return entry?.mode === '120000' || entry?.mode === '160000';
}

/** True when `path` or any directory prefix of `path` is a symlink (`120000`) or submodule (`160000`) in either tree. */
export function hasSymlinkAtOrAbove(
  path: string,
  baseEntries: ReadonlyMap<string, GitTreeEntry>,
  sourceEntries: ReadonlyMap<string, GitTreeEntry>,
): boolean {
  if (isSpecialGitTreeEntry(baseEntries.get(path)) || isSpecialGitTreeEntry(sourceEntries.get(path))) {
    return true;
  }
  let slash = path.indexOf('/');
  while (slash !== -1) {
    const prefix = path.slice(0, slash);
    if (isSpecialGitTreeEntry(baseEntries.get(prefix)) || isSpecialGitTreeEntry(sourceEntries.get(prefix))) {
      return true;
    }
    slash = path.indexOf('/', slash + 1);
  }
  return false;
}

function normalizeGitRelativePath(raw: string): string {
  const clean = normalizeCandidateRelativePath(raw);
  for (const part of clean.split('/')) {
    if (part.toLowerCase() === '.git' || Buffer.byteLength(part, 'utf8') > MAX_PATH_SEGMENT_BYTES) {
      throw new TaskpackError('ACTION_INPUT_INVALID', `invalid path segment in "${raw}"`);
    }
  }
  if (!digestArtifact(clean, new Uint8Array()).ok) {
    throw new TaskpackError('ACTION_INPUT_INVALID', `invalid artifact path "${raw}"`);
  }
  return clean;
}

/**
 * Single source of truth deriving compiled `writablePaths`, `protectedPaths`, and control-plane
 * sibling inventories directly from a `TaskpackManifest` (shared across `alignBaselineRevisions`
 * and `compileDeclarativeTaskpack` without constructing stub `TaskContract` documents).
 */
export function deriveManifestCompiledScope(options: DeriveManifestCompiledScopeOptions): CompiledManifestScopeDetails {
  const { manifest, repositoryRoot, taskpackPath, baseRevision, sourceRevision } = options;
  const policyProfile: PolicyProfile = options.policyProfile ?? options.hostPolicy?.policyProfile ?? 'local';
  const allowWorkflowWrites = (
    policyProfile === 'github'
    && manifest.spec.execution?.capabilities.allowWorkflowWrites === true
    && options.hostPolicy?.allowWorkflowWrites === true
  );
  const { controlRoot, manifestPath } = resolveManifestControlRoot(manifest, taskpackPath);
  const proposalPath = manifest.spec.proposal?.path;
  const commandScripts = Object.freeze(manifest.spec.verification.localChecks.flatMap(check => (
    check.implementation === 'command.v1' && typeof check.parameters?.['script'] === 'string' && check.parameters['script'].length > 0
      ? [check.parameters['script']]
      : []
  )));
  const allManifestInstructions = extractTaskpackResourcePaths([
    ...(manifest.spec.instructions ?? []),
    ...(manifest.spec.roles?.flatMap(r => r.instructions ?? []) ?? []),
  ]);
  const allManifestSkills = extractTaskpackResourcePaths([
    ...(manifest.spec.skills ?? []),
    ...(manifest.spec.roles?.flatMap(r => r.skills ?? []) ?? []),
  ]);
  const relativeToolchainPaths = Object.freeze(manifest.spec.verification.localChecks.flatMap(c => {
    if (c.implementation !== 'command.v1') return [];
    const raw = c.parameters?.['toolchainPaths'];
    return Array.isArray(raw) ? raw.filter((p): p is string => typeof p === 'string' && !p.startsWith('/')) : [];
  }));
  const githubSiblings = options.githubSiblings ?? (
    policyProfile === 'github'
      ? collectGitHubSiblingPaths({
        repositoryRoot,
        gitRevisions: [sourceRevision, baseRevision],
      })
      : Object.freeze([])
  );
  const controlRootSiblingSet = options.controlRootSiblingSet ?? (
    proposalPath !== undefined
      ? collectControlRootSiblingPaths({
        repositoryRoot,
        controlRoot,
        proposalPath,
        gitRevisions: [sourceRevision, baseRevision],
      })
      : Object.freeze({ prioritySiblings: Object.freeze([]), regularSiblings: Object.freeze([]) })
  );

  const fullProtected = effectiveProtectedPaths(manifest.spec.scope.protected, {
    policyProfile,
    controlRoot,
    manifestPath,
    digestsLockfile: manifest.spec.execution?.digests.lockfile,
    instructions: allManifestInstructions.length > 0 ? allManifestInstructions : undefined,
    skills: allManifestSkills.length > 0 ? allManifestSkills : undefined,
    preflightScript: manifest.spec.preflight?.script,
    commandScripts,
    toolchainPaths: relativeToolchainPaths.length > 0 ? relativeToolchainPaths : undefined,
    proposalPath,
    extraProtectedPaths: options.extraProtectedPaths,
    priorityControlRootSiblings: controlRootSiblingSet.prioritySiblings,
    controlRootSiblings: controlRootSiblingSet.regularSiblings,
    allowWorkflowWrites,
    githubSiblings,
  });
  const exactWritable = proposalPath !== undefined && pathCoveredBy(proposalPath, controlRoot)
    ? new Set<string>([proposalPath])
    : undefined;
  const writablePaths = compileScopePatterns(manifest.spec.scope.writable, 'writable', { exactEntries: exactWritable });
  const protectedPaths = compileScopePatterns(fullProtected, 'protected');

  return Object.freeze({
    policyProfile,
    allowWorkflowWrites,
    controlRoot,
    manifestPath,
    proposalPath,
    commandScripts,
    allManifestInstructions,
    allManifestSkills,
    relativeToolchainPaths,
    githubSiblings,
    controlRootSiblingSet,
    writablePaths,
    protectedPaths,
  });
}

/** Build a validated `CandidateScopeSnapshot` (`{ writablePaths, protectedPaths }`) directly from a `TaskpackManifest`. */
export function buildScopeSnapshotFromManifest(
  options: DeriveManifestCompiledScopeOptions,
): CandidateScopeSnapshot {
  const derived = deriveManifestCompiledScope(options);
  return Object.freeze({
    writablePaths: derived.writablePaths,
    protectedPaths: derived.protectedPaths,
  });
}

/** True when `contract.spec.trustedContext.resources` stages the baseline conflict context resource. */
export function hasBaselineConflictResource(contract: TaskContract): boolean {
  return contract.spec.trustedContext.resources.some(res => res.id === BASELINE_CONFLICT_RESOURCE_ID);
}

/**
 * True when `content` contains line-anchored Git conflict markers (`<<<<<<<`, `|||||||`, `>>>>>>>`).
 * Decodes `Uint8Array` permissively so NUL bytes cannot hide conflict markers on adjacent lines,
 * while ignoring standalone 7-character `=======` Markdown/RST setext underlines.
 */
export function containsResidualGitConflictMarkers(content: string | Uint8Array): boolean {
  const text = typeof content === 'string'
    ? content
    : new TextDecoder('utf-8', { fatal: false }).decode(content);
  return BASELINE_CONFLICT_MARKER_PATTERN.test(text);
}

interface RawGitResult {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly timedOut: boolean;
  readonly stdoutOverflow: boolean;
  readonly spawnError: string | null;
  readonly stdout: Buffer;
  readonly stderr: Buffer;
}

async function runIsolatedGit(
  repositoryRoot: string,
  args: readonly string[],
  env: Record<string, string>,
  options?: {
    readonly input?: Buffer | string | undefined;
    readonly timeoutMs?: number | undefined;
    readonly maxStdoutBytes?: number | undefined;
  },
): Promise<RawGitResult> {
  const gitBin = resolveGitExecutable();
  const timeoutMs = options?.timeoutMs ?? GIT_DEFAULT_TIMEOUT_MS;
  const maxStdoutBytes = options?.maxStdoutBytes ?? MAX_GIT_STDOUT_BYTES;
  return await new Promise<RawGitResult>(resolvePromise => {
    const child = spawn(
      gitBin,
      [
        '-c', 'core.hooksPath=/dev/null',
        '-c', 'merge.renames=false',
        '-c', 'gc.auto=0',
        '-c', 'core.logAllRefUpdates=false',
        '-c', 'protocol.file.allow=never',
        '-c', 'protocol.ext.allow=never',
        '-c', 'protocol.ssh.allow=never',
        '-C', repositoryRoot,
        ...args,
      ],
      { env, stdio: ['pipe', 'pipe', 'pipe'] },
    );
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let settled = false;
    let timedOut = false;
    let stdoutOverflow = false;

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, timeoutMs);
    timer.unref?.();

    const finish = (res: RawGitResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolvePromise(res);
    };

    child.stdin.on('error', () => undefined);
    child.stdout.on('data', (chunk: Buffer) => {
      stdoutBytes += chunk.byteLength;
      if (stdoutBytes > maxStdoutBytes) {
        stdoutOverflow = true;
        child.kill('SIGKILL');
        return;
      }
      stdoutChunks.push(chunk);
    });
    child.stderr.on('data', (chunk: Buffer) => {
      if (stderrBytes >= MAX_GIT_STDERR_BYTES) return;
      const take = Math.min(chunk.byteLength, MAX_GIT_STDERR_BYTES - stderrBytes);
      stderrBytes += take;
      stderrChunks.push(chunk.subarray(0, take));
    });
    child.on('error', err => {
      finish({
        code: null,
        signal: null,
        timedOut,
        stdoutOverflow,
        spawnError: err.message,
        stdout: Buffer.concat(stdoutChunks),
        stderr: Buffer.concat(stderrChunks),
      });
    });
    child.on('close', (code, signal) => {
      finish({
        code,
        signal,
        timedOut,
        stdoutOverflow,
        spawnError: null,
        stdout: Buffer.concat(stdoutChunks),
        stderr: Buffer.concat(stderrChunks),
      });
    });

    if (options?.input !== undefined) {
      const payload = Buffer.isBuffer(options.input) ? options.input : Buffer.from(options.input, 'utf8');
      if (payload.byteLength > 0) {
        child.stdin.end(payload);
        return;
      }
    }
    child.stdin.end();
  });
}

async function execIsolatedGitChecked(
  repositoryRoot: string,
  args: readonly string[],
  env: Record<string, string>,
  options?: {
    readonly input?: Buffer | string | undefined;
    readonly timeoutMs?: number | undefined;
    readonly maxStdoutBytes?: number | undefined;
  },
): Promise<Buffer> {
  const res = await runIsolatedGit(repositoryRoot, args, env, options);
  if (res.spawnError !== null) {
    throw new TaskpackError('ACTION_INPUT_INVALID', `git ${args[0] ?? 'command'} failed to spawn: ${res.spawnError}`);
  }
  if (res.stdoutOverflow) {
    throw new TaskpackError('ACTION_INPUT_INVALID', `git ${args[0] ?? 'command'} output exceeded limit`);
  }
  if (res.timedOut) {
    throw new TaskpackError('ACTION_INPUT_INVALID', `git ${args[0] ?? 'command'} timed out`);
  }
  if (res.code !== 0 || res.signal !== null) {
    const stderrText = res.stderr.toString('utf8').trim();
    throw new TaskpackError(
      'ACTION_INPUT_INVALID',
      `git ${args[0] ?? 'command'} exited with ${String(res.code ?? res.signal)}${stderrText ? `: ${stderrText}` : ''}`,
    );
  }
  return res.stdout;
}

async function cleanupPrivateTempDir(
  privateTempDir: string,
  scrubber: SecretScrubber,
  onLog?: ((line: string) => void) | undefined,
): Promise<void> {
  const unlockDirs = async (dir: string): Promise<void> => {
    await chmod(dir, 0o700).catch(() => undefined);
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (entry.isDirectory()) {
        await unlockDirs(join(dir, entry.name));
      } else if (entry.isFile()) {
        await chmod(join(dir, entry.name), 0o600).catch(() => undefined);
      }
    }
  };
  await unlockDirs(privateTempDir).catch(() => undefined);
  try {
    await rm(privateTempDir, { recursive: true, force: true });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    onLog?.(scrubber.scrub(`baseline-align warning: failed to remove temporary directory: ${detail}`));
  }
}

async function assertObjectsDirNoSymlinks(objectsDir: string): Promise<void> {
  let seenFiles = 0;
  let totalBytes = 0;
  const walk = async (cur: string, depth: number): Promise<void> => {
    if (depth > MAX_GIT_OBJECTS_DEPTH) {
      throw new TaskpackError('ACTION_INPUT_INVALID', `.git/objects exceeds maximum directory depth ${MAX_GIT_OBJECTS_DEPTH}`);
    }
    const st = await lstat(cur);
    if (st.isSymbolicLink()) {
      throw new TaskpackError('TASKPACK_SCOPE_VIOLATION', `symbolic link "${cur}" is forbidden inside .git/objects`);
    }
    if (!st.isDirectory()) {
      throw new TaskpackError('ACTION_INPUT_INVALID', `.git/objects path "${cur}" must be a directory`);
    }
    const names = (await readdir(cur)).sort();
    for (const name of names) {
      const child = join(cur, name);
      const childStat = await lstat(child);
      if (childStat.isSymbolicLink()) {
        throw new TaskpackError('TASKPACK_SCOPE_VIOLATION', `symbolic link "${child}" is forbidden inside .git/objects`);
      }
      if (childStat.isDirectory()) {
        await walk(child, depth + 1);
      } else if (childStat.isFile()) {
        seenFiles += 1;
        totalBytes += childStat.size;
        if (seenFiles > DEFAULT_GIT_OBJECTS_MAX_FILES || totalBytes > DEFAULT_GIT_OBJECTS_MAX_BYTES) {
          throw new TaskpackError('ACTION_INPUT_INVALID', '.git/objects exceeds object file or byte ceiling');
        }
      }
    }
  };
  await walk(objectsDir, 0);
}

async function resolveReadOnlyAlternateObjectDirs(repositoryRoot: string): Promise<readonly string[]> {
  const dotGitStat = await lstat(join(repositoryRoot, '.git')).catch(() => null);
  if (dotGitStat === null || dotGitStat.isSymbolicLink()) {
    throw new TaskpackError('ACTION_INPUT_INVALID', 'repository .git must exist and must not be a symbolic link');
  }
  const cleanEnv = buildCleanGitEnv({
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: '/dev/null',
  });
  const commonDirRaw = (
    await execIsolatedGitChecked(
      repositoryRoot,
      ['rev-parse', '--path-format=absolute', '--git-common-dir'],
      cleanEnv,
      { timeoutMs: GIT_VERIFY_TIMEOUT_MS, maxStdoutBytes: MAX_COMMON_DIR_STDOUT_BYTES },
    )
  ).toString('utf8').trim();
  if (commonDirRaw.length === 0 || !isAbsolute(commonDirRaw)) {
    throw new TaskpackError('ACTION_INPUT_INVALID', 'failed to resolve repository git-common-dir');
  }
  const commonStat = await lstat(commonDirRaw);
  if (commonStat.isSymbolicLink() || !commonStat.isDirectory()) {
    throw new TaskpackError('ACTION_INPUT_INVALID', 'repository git-common-dir must be a non-symlink directory');
  }
  const hostObjectsDir = join(commonDirRaw, 'objects');
  await assertObjectsDirNoSymlinks(hostObjectsDir);
  const realHostObjects = await realpath(hostObjectsDir);
  const alternates = [realHostObjects];

  const alternatesFile = join(hostObjectsDir, 'info', 'alternates');
  const altStat = await lstat(alternatesFile).catch(() => null);
  if (altStat !== null) {
    if (altStat.isSymbolicLink() || !altStat.isFile() || altStat.size > MAX_GIT_ALTERNATES_BYTES) {
      throw new TaskpackError('ACTION_INPUT_INVALID', 'invalid .git/objects/info/alternates file');
    }
    const rawAlternates = await readFile(alternatesFile, 'utf8');
    for (const rawLine of rawAlternates.split(/\r?\n/)) {
      const trimmed = rawLine.trim();
      if (trimmed.length === 0 || trimmed.startsWith('#')) continue;
      const resolvedAlt = isAbsolute(trimmed) ? resolve(trimmed) : resolve(hostObjectsDir, trimmed);
      const st = await lstat(resolvedAlt).catch(() => null);
      if (st !== null && !st.isSymbolicLink() && st.isDirectory()) {
        alternates.push(await realpath(resolvedAlt));
      }
    }
  }
  return Object.freeze([...new Set(alternates)]);
}

/** List all Git tree entries (`ls-tree -r -z --full-tree`) at `revision` using bounded isolated Git execution. */
export async function listTreeEntriesAtRevision(
  repositoryRoot: string,
  revision: string,
  env: Record<string, string>,
): Promise<ReadonlyMap<string, GitTreeEntry>> {
  const stdout = await execIsolatedGitChecked(
    repositoryRoot,
    ['ls-tree', '-r', '-z', '--full-tree', revision],
    env,
    { maxStdoutBytes: MAX_GIT_STDOUT_BYTES, timeoutMs: GIT_MERGE_TREE_TIMEOUT_MS },
  );
  if (stdout.byteLength > 0 && stdout.at(-1) !== 0) {
    throw new TaskpackError('ACTION_INPUT_INVALID', 'git ls-tree output exceeded boundary');
  }
  const entries = new Map<string, GitTreeEntry>();
  const text = stdout.byteLength > 0 ? new TextDecoder('utf-8', { fatal: true }).decode(stdout) : '';
  for (const part of text.split('\0')) {
    if (part.length === 0) continue;
    const tabIdx = part.indexOf('\t');
    if (tabIdx <= 0) continue;
    const fields = part.slice(0, tabIdx).split(' ');
    const path = part.slice(tabIdx + 1);
    if (fields[0] !== undefined && fields[1] !== undefined && fields[2] !== undefined) {
      entries.set(path, { mode: fields[0], type: fields[1], oid: fields[2] });
    }
  }
  return entries;
}

async function readBlobSizeIsolated(
  repositoryRoot: string,
  oid: string,
  env: Record<string, string>,
): Promise<number> {
  const raw = (
    await execIsolatedGitChecked(
      repositoryRoot,
      ['cat-file', '-s', oid],
      env,
      { timeoutMs: GIT_SHORT_OP_TIMEOUT_MS, maxStdoutBytes: MAX_SIZE_STDOUT_BYTES },
    )
  ).toString('utf8').trim();
  const size = Number(raw);
  if (!Number.isSafeInteger(size) || size < 0) {
    throw new TaskpackError('ACTION_INPUT_INVALID', `invalid git blob size for ${oid}`);
  }
  return size;
}

async function readVerifiedBlobIsolated(
  repositoryRoot: string,
  oid: string,
  maxBytes: number,
  env: Record<string, string>,
): Promise<Buffer> {
  const size = await readBlobSizeIsolated(repositoryRoot, oid, env);
  if (size > maxBytes) {
    throw new BlobSizeCeilingExceededError(oid, size, maxBytes);
  }
  const bytes = await execIsolatedGitChecked(
    repositoryRoot,
    ['cat-file', 'blob', oid],
    env,
    {
      timeoutMs: GIT_MERGE_TREE_TIMEOUT_MS,
      maxStdoutBytes: Math.max(MIN_BLOB_STDOUT_HEADROOM_BYTES, size + BLOB_STDOUT_PADDING_BYTES),
    },
  );
  if (bytes.byteLength !== size) {
    throw new TaskpackError('ACTION_INPUT_INVALID', `blob ${oid} byteLength mismatch`);
  }
  const algo = oid.length === 64 ? 'sha256' : 'sha1';
  const actualOid = createHash(algo).update(`blob ${bytes.byteLength}\0`).update(bytes).digest('hex');
  if (actualOid !== oid) {
    throw new TaskpackError('ACTION_INPUT_INVALID', `blob ${oid} digest verification failed`);
  }
  return bytes;
}

async function computeBlobSha256Isolated(
  repositoryRoot: string,
  oid: string,
  env: Record<string, string>,
  maxBytes: number = OVERLAY_LIMITS.maxMaxBytes,
): Promise<{ readonly sha256: string; readonly byteLength: number }> {
  const bytes = await readVerifiedBlobIsolated(repositoryRoot, oid, maxBytes, env);
  return {
    sha256: createHash('sha256').update(bytes).digest('hex'),
    byteLength: bytes.byteLength,
  };
}

interface RawMergeProbeOutput {
  readonly clean: boolean;
  readonly mergeBase: string | null;
  readonly mergedTreeOid: string | null;
  readonly conflictPaths: readonly string[];
  readonly conflictMessages: readonly MergeConflictMessageRecord[];
  readonly conflictTextByPath: ReadonlyMap<string, Buffer>;
}

function parseMergeTreeWriteTreeOutput(stdout: Buffer, clean: boolean): {
  readonly mergedTreeOid: string;
  readonly rawConflictPaths: readonly string[];
  readonly messages: readonly MergeConflictMessageRecord[];
} {
  const decoded = new TextDecoder('utf-8', { fatal: false }).decode(stdout);
  const tokens = decoded.split('\0');
  const treeCandidate = (tokens[0] ?? '').trim();
  if (!OID_HEX_PATTERN.test(treeCandidate)) {
    throw new TaskpackError('ACTION_INPUT_INVALID', 'git merge-tree --write-tree returned an invalid tree OID');
  }
  if (clean) {
    return {
      mergedTreeOid: treeCandidate,
      rawConflictPaths: Object.freeze([]),
      messages: Object.freeze([]),
    };
  }
  const rawPaths: string[] = [];
  let cursor = 1;
  while (cursor < tokens.length && tokens[cursor] !== '') {
    rawPaths.push(tokens[cursor]!);
    cursor += 1;
  }
  if (cursor < tokens.length && tokens[cursor] === '') {
    cursor += 1;
  }
  const messages: MergeConflictMessageRecord[] = [];
  while (cursor < tokens.length && tokens[cursor] !== '') {
    const countStr = tokens[cursor]!;
    if (!/^\d+$/.test(countStr)) break;
    const pathCount = Number.parseInt(countStr, 10);
    if (!Number.isSafeInteger(pathCount) || cursor + 2 + pathCount >= tokens.length) {
      break;
    }
    const paths = tokens.slice(cursor + 1, cursor + 1 + pathCount);
    const conflictType = tokens[cursor + 1 + pathCount]!;
    const message = tokens[cursor + 2 + pathCount]!;
    if (conflictType.startsWith('CONFLICT')) {
      messages.push(Object.freeze({
        paths: Object.freeze(paths),
        conflictType,
        message,
      }));
    }
    cursor += 3 + pathCount;
  }
  return {
    mergedTreeOid: treeCandidate,
    rawConflictPaths: Object.freeze(rawPaths),
    messages: Object.freeze(messages),
  };
}

function stripCollisionSuffix(
  rawPath: string,
  baseEntries: ReadonlyMap<string, GitTreeEntry>,
  sourceEntries: ReadonlyMap<string, GitTreeEntry>,
): string {
  if (baseEntries.has(rawPath) || sourceEntries.has(rawPath)) return rawPath;
  const tildeMatch = /^(.+)~[0-9a-f]{40,64}$/.exec(rawPath);
  if (tildeMatch !== null) {
    const stripped = tildeMatch[1]!;
    if (
      baseEntries.has(stripped)
      || sourceEntries.has(stripped)
      || [...baseEntries.keys()].some(k => k.startsWith(`${stripped}/`))
      || [...sourceEntries.keys()].some(k => k.startsWith(`${stripped}/`))
    ) {
      return stripped;
    }
  }
  return rawPath;
}

async function runIndexThreeWayMergeFallback(options: {
  readonly repositoryRoot: string;
  readonly baseRevision: string;
  readonly sourceRevision: string;
  readonly mergeBase: string | null;
  readonly privateTempDir: string;
  readonly isolatedEnv: Record<string, string>;
}): Promise<RawMergeProbeOutput> {
  const { repositoryRoot, baseRevision, sourceRevision, mergeBase, privateTempDir, isolatedEnv } = options;
  const indexFile = join(privateTempDir, 'fallback-index');
  const indexEnv: Record<string, string> = {
    ...isolatedEnv,
    GIT_INDEX_FILE: indexFile,
  };
  const emptyTreeOid = (
    await execIsolatedGitChecked(repositoryRoot, ['mktree'], indexEnv, { input: '' })
  ).toString('utf8').trim();
  const baseAncestorTree = mergeBase !== null ? `${mergeBase}^{tree}` : emptyTreeOid;

  await execIsolatedGitChecked(
    repositoryRoot,
    ['read-tree', '-m', '--aggressive', baseAncestorTree, `${baseRevision}^{tree}`, `${sourceRevision}^{tree}`],
    indexEnv,
  );

  const unmergedRaw = (
    await execIsolatedGitChecked(repositoryRoot, ['ls-files', '-u', '-z'], indexEnv)
  ).toString('utf8');

  interface StageEntry {
    readonly mode: string;
    readonly oid: string;
  }
  const stagesByPath = new Map<string, Map<number, StageEntry>>();
  for (const record of unmergedRaw.split('\0')) {
    if (record.length === 0) continue;
    const tabIdx = record.indexOf('\t');
    if (tabIdx <= 0) continue;
    const meta = record.slice(0, tabIdx).split(/\s+/);
    const path = record.slice(tabIdx + 1);
    const mode = meta[0]!;
    const oid = meta[1]!;
    const stageNum = Number.parseInt(meta[2] ?? '0', 10);
    if (!stagesByPath.has(path)) {
      stagesByPath.set(path, new Map());
    }
    stagesByPath.get(path)!.set(stageNum, { mode, oid });
  }

  const conflictPaths: string[] = [];
  const conflictMessages: MergeConflictMessageRecord[] = [];
  const conflictTextByPath = new Map<string, Buffer>();
  const conflictedStage2ByPath = new Map<string, StageEntry | undefined>();
  const mergeScratchDir = join(privateTempDir, 'merge-files');
  await mkdir(mergeScratchDir, { recursive: true, mode: 0o700 });

  for (const [path, stageMap] of [...stagesByPath.entries()].sort((a, b) => compareLexical(a[0], b[0]))) {
    const s1 = stageMap.get(1);
    const s2 = stageMap.get(2);
    const s3 = stageMap.get(3);

    // Stage-1-only entry: path deleted cleanly without opposing modification -> resolved deletion!
    if (s1 !== undefined && s2 === undefined && s3 === undefined) {
      await execIsolatedGitChecked(
        repositoryRoot,
        ['update-index', '--force-remove', '-z', '--stdin'],
        indexEnv,
        { input: `${path}\0` },
      );
      continue;
    }

    const allRegular = [s1, s2, s3].every(
      s => s === undefined || s.mode === '100644' || s.mode === '100755',
    );
    if (!allRegular || (s2 === undefined && s3 === undefined)) {
      conflictPaths.push(path);
      conflictedStage2ByPath.set(path, s2);
      conflictMessages.push({
        paths: [path],
        conflictType: 'CONFLICT (special)',
        message: `CONFLICT (special): non-regular merge conflict in ${path}`,
      });
      continue;
    }
    if (s2 === undefined || s3 === undefined) {
      conflictPaths.push(path);
      conflictedStage2ByPath.set(path, s2);
      conflictMessages.push({
        paths: [path],
        conflictType: 'CONFLICT (modify/delete)',
        message: `CONFLICT (modify/delete): ${path}`,
      });
      continue;
    }

    const baseBytes = s1 !== undefined
      ? await readVerifiedBlobIsolated(repositoryRoot, s1.oid, MAX_CARRY_BLOB_BYTES, indexEnv)
      : Buffer.alloc(0);
    const targetBytes = await readVerifiedBlobIsolated(repositoryRoot, s2.oid, MAX_CARRY_BLOB_BYTES, indexEnv);
    const sourceBytes = await readVerifiedBlobIsolated(repositoryRoot, s3.oid, MAX_CARRY_BLOB_BYTES, indexEnv);

    if (baseBytes.includes(0) || targetBytes.includes(0) || sourceBytes.includes(0)) {
      conflictPaths.push(path);
      conflictedStage2ByPath.set(path, s2);
      conflictMessages.push({
        paths: [path],
        conflictType: 'CONFLICT (binary)',
        message: `CONFLICT (binary): binary merge conflict in ${path}`,
      });
      continue;
    }

    const fBase = join(mergeScratchDir, 'anc');
    const fTarget = join(mergeScratchDir, 'tgt');
    const fSource = join(mergeScratchDir, 'src');
    await writeFile(fBase, baseBytes, { mode: 0o600 });
    await writeFile(fTarget, targetBytes, { mode: 0o600 });
    await writeFile(fSource, sourceBytes, { mode: 0o600 });

    const mergeRes = await runIsolatedGit(
      repositoryRoot,
      [
        'merge-file',
        '-p',
        '-L', baseRevision,
        '-L', mergeBase ?? 'merge-base',
        '-L', sourceRevision,
        fTarget,
        fBase,
        fSource,
      ],
      indexEnv,
      { maxStdoutBytes: MAX_CARRY_BLOB_BYTES },
    );

    if (mergeRes.code === 0 && mergeRes.signal === null && !mergeRes.timedOut && !mergeRes.stdoutOverflow) {
      const mergedOid = (
        await execIsolatedGitChecked(repositoryRoot, ['hash-object', '-w', '--stdin'], indexEnv, { input: mergeRes.stdout })
      ).toString('utf8').trim();
      const mergedMode: '100644' | '100755' =
        s1?.mode === s2.mode && (s3.mode === '100644' || s3.mode === '100755')
          ? s3.mode
          : (s2.mode === '100755' ? '100755' : '100644');
      await execIsolatedGitChecked(
        repositoryRoot,
        ['update-index', '--force-remove', '-z', '--stdin'],
        indexEnv,
        { input: `${path}\0` },
      );
      await execIsolatedGitChecked(
        repositoryRoot,
        ['update-index', '-z', '--index-info'],
        indexEnv,
        { input: `${mergedMode} blob ${mergedOid}\t${path}\0` },
      );
    } else if (mergeRes.code !== null && mergeRes.code > 0 && mergeRes.code <= MAX_MERGE_FILE_EXIT_CONFLICTS) {
      conflictPaths.push(path);
      conflictedStage2ByPath.set(path, s2);
      conflictTextByPath.set(path, mergeRes.stdout);
      conflictMessages.push({
        paths: [path],
        conflictType: s1 === undefined ? 'CONFLICT (add/add)' : 'CONFLICT (contents)',
        message: `CONFLICT (content): Merge conflict in ${path}`,
      });
    } else {
      throw new TaskpackError('ACTION_INPUT_INVALID', `git merge-file failed for "${path}"`);
    }
  }

  // Always resolve remaining unmerged index entries in the private temp index so `git write-tree`
  // materializes a real merged tree preserving all clean 3-way merges and `baseRevision`-only edits/additions!
  for (const [path, s2] of conflictedStage2ByPath.entries()) {
    await execIsolatedGitChecked(
      repositoryRoot,
      ['update-index', '--force-remove', '-z', '--stdin'],
      indexEnv,
      { input: `${path}\0` },
    );
    if (s2 !== undefined && (s2.mode === '100644' || s2.mode === '100755')) {
      await runIsolatedGit(
        repositoryRoot,
        ['update-index', '-z', '--index-info'],
        indexEnv,
        { input: `${s2.mode} blob ${s2.oid}\t${path}\0` },
      );
    }
  }

  const mergedTreeOid = (
    await execIsolatedGitChecked(repositoryRoot, ['write-tree'], indexEnv)
  ).toString('utf8').trim();

  if (conflictPaths.length > 0) {
    return {
      clean: false,
      mergeBase,
      mergedTreeOid,
      conflictPaths: Object.freeze([...new Set(conflictPaths)].sort(compareLexical)),
      conflictMessages: Object.freeze(conflictMessages),
      conflictTextByPath,
    };
  }

  return {
    clean: true,
    mergeBase,
    mergedTreeOid,
    conflictPaths: Object.freeze([]),
    conflictMessages: Object.freeze([]),
    conflictTextByPath,
  };
}

async function runIsolatedThreeWayMergeProbe(options: {
  readonly repositoryRoot: string;
  readonly baseRevision: string;
  readonly sourceRevision: string;
  readonly privateTempDir: string;
  readonly isolatedEnv: Record<string, string>;
  readonly baseEntries: ReadonlyMap<string, GitTreeEntry>;
  readonly sourceEntries: ReadonlyMap<string, GitTreeEntry>;
  readonly forceIndexFallback?: boolean | undefined;
}): Promise<RawMergeProbeOutput> {
  const {
    repositoryRoot,
    baseRevision,
    sourceRevision,
    privateTempDir,
    isolatedEnv,
    baseEntries,
    sourceEntries,
    forceIndexFallback,
  } = options;

  const mbRes = await runIsolatedGit(
    repositoryRoot,
    ['merge-base', baseRevision, sourceRevision],
    isolatedEnv,
    { timeoutMs: GIT_SHORT_OP_TIMEOUT_MS, maxStdoutBytes: MAX_OID_STDOUT_BYTES },
  );
  if (mbRes.spawnError !== null || mbRes.timedOut || mbRes.stdoutOverflow || mbRes.signal !== null) {
    throw new TaskpackError(
      'ACTION_INPUT_INVALID',
      `git merge-base failed (${String(mbRes.spawnError ?? mbRes.signal ?? 'timeout/overflow')})`,
    );
  }
  const mbTrimmed = mbRes.stdout.toString('utf8').trim();
  let mergeBase: string | null;
  if (mbRes.code === 0) {
    if (!OID_HEX_PATTERN.test(mbTrimmed)) {
      throw new TaskpackError('ACTION_INPUT_INVALID', 'git merge-base returned an invalid commit OID');
    }
    mergeBase = mbTrimmed;
  } else if (mbRes.code === 1 && mbTrimmed.length === 0) {
    mergeBase = null;
  } else {
    const stderrText = mbRes.stderr.toString('utf8').trim();
    throw new TaskpackError(
      'ACTION_INPUT_INVALID',
      `git merge-base exited with ${String(mbRes.code)}${stderrText ? `: ${stderrText}` : ''}`,
    );
  }

  if (forceIndexFallback === true) {
    return await runIndexThreeWayMergeFallback({
      repositoryRoot,
      baseRevision,
      sourceRevision,
      mergeBase,
      privateTempDir,
      isolatedEnv,
    });
  }

  const mtRes = await runIsolatedGit(
    repositoryRoot,
    [
      'merge-tree',
      '--write-tree',
      '--messages',
      '--name-only',
      '--allow-unrelated-histories',
      '-z',
      baseRevision,
      sourceRevision,
    ],
    isolatedEnv,
    { timeoutMs: GIT_MERGE_TREE_TIMEOUT_MS, maxStdoutBytes: MAX_GIT_STDOUT_BYTES },
  );

  if (mtRes.code === 129 || mtRes.stderr.toString('utf8').includes('unknown option')) {
    return await runIndexThreeWayMergeFallback({
      repositoryRoot,
      baseRevision,
      sourceRevision,
      mergeBase,
      privateTempDir,
      isolatedEnv,
    });
  }
  if (mtRes.spawnError !== null || mtRes.timedOut || mtRes.stdoutOverflow || (mtRes.code !== 0 && mtRes.code !== 1)) {
    const stderrText = mtRes.stderr.toString('utf8').trim();
    throw new TaskpackError(
      'ACTION_INPUT_INVALID',
      `git merge-tree --write-tree failed (${String(mtRes.code ?? mtRes.signal)})${stderrText ? `: ${stderrText}` : ''}`,
    );
  }

  const clean = mtRes.code === 0;
  const parsed = parseMergeTreeWriteTreeOutput(mtRes.stdout, clean);
  const normalizedConflictSet = new Set<string>();
  for (const rawPath of parsed.rawConflictPaths) {
    normalizedConflictSet.add(stripCollisionSuffix(rawPath, baseEntries, sourceEntries));
  }
  for (const msg of parsed.messages) {
    for (const rawPath of msg.paths) {
      normalizedConflictSet.add(stripCollisionSuffix(rawPath, baseEntries, sourceEntries));
    }
  }
  const conflictPaths = [...normalizedConflictSet].sort(compareLexical);
  return {
    clean: clean && conflictPaths.length === 0,
    mergeBase,
    mergedTreeOid: parsed.mergedTreeOid,
    conflictPaths: Object.freeze(conflictPaths),
    conflictMessages: parsed.messages,
    conflictTextByPath: new Map(),
  };
}

function extractConflictHunksFromMergedText(
  mergedConflictText: string,
  scrubber: SecretScrubber,
  maxConflictBytes: number,
): { readonly hunks: readonly BaselineConflictHunk[]; readonly totalHunkBytes: number } | null {
  const normalized = mergedConflictText.replace(/\r\n?/g, '\n');
  const lines = normalized.split('\n');
  const hunks: BaselineConflictHunk[] = [];
  let totalHunkBytes = 0;
  let i = 0;

  while (i < lines.length) {
    const line = lines[i]!;
    if (line.startsWith('<<<<<<<')) {
      const startIdx = i;
      let endIdx = -1;
      let depth = 1;
      for (let j = i + 1; j < lines.length; j += 1) {
        const cur = lines[j]!;
        if (cur.startsWith('<<<<<<<')) {
          depth += 1;
        } else if (cur.startsWith('>>>>>>>')) {
          depth -= 1;
          if (depth === 0) {
            endIdx = j;
            break;
          }
        }
      }
      if (endIdx === -1) {
        return null;
      }
      const contextBefore = Math.max(0, startIdx - CONFLICT_CONTEXT_LINES);
      const contextAfter = Math.min(lines.length - 1, endIdx + CONFLICT_CONTEXT_LINES);
      const rawBlock = lines.slice(contextBefore, contextAfter + 1).join('\n');
      const scrubbedBlock = scrubber.scrub(rawBlock);
      scrubber.assertClean(scrubbedBlock, BASELINE_CONFLICT_RESOURCE_PATH);
      const blockBytes = Buffer.byteLength(scrubbedBlock, 'utf8');
      totalHunkBytes += blockBytes;
      if (totalHunkBytes > maxConflictBytes) {
        return null;
      }
      hunks.push(Object.freeze({
        index: hunks.length,
        startLine: contextBefore + 1,
        endLine: contextAfter + 1,
        block: scrubbedBlock,
      }));
      i = endIdx + 1;
      continue;
    }
    i += 1;
  }

  if (hunks.length === 0) return null;
  return {
    hunks: Object.freeze(hunks),
    totalHunkBytes,
  };
}

async function computeWritableCarryDeltaFromMergedTree(options: {
  readonly repositoryRoot: string;
  readonly snapshot: CandidateScopeSnapshot;
  readonly baseEntries: ReadonlyMap<string, GitTreeEntry>;
  readonly sourceEntries: ReadonlyMap<string, GitTreeEntry>;
  readonly mergedEntries: ReadonlyMap<string, GitTreeEntry>;
  readonly excludedConflictPaths: ReadonlySet<string>;
  readonly isolatedEnv: Record<string, string>;
}): Promise<{
  readonly carryRemovals: readonly string[];
  readonly carryUpdates: readonly CarryDeltaEntry[];
}> {
  const {
    repositoryRoot,
    snapshot,
    baseEntries,
    sourceEntries,
    mergedEntries,
    excludedConflictPaths,
    isolatedEnv,
  } = options;

  const carryRemovals: string[] = [];
  for (const [path, baseEntry] of [...baseEntries.entries()].sort((a, b) => compareLexical(a[0], b[0]))) {
    if (excludedConflictPaths.has(path)) continue;
    if (baseEntry.mode !== '100644' && baseEntry.mode !== '100755') continue;
    const mergedEntry = mergedEntries.get(path);
    if (mergedEntry !== undefined && (mergedEntry.mode === '100644' || mergedEntry.mode === '100755')) {
      continue;
    }
    if (!isAllowedCandidateWrite(path, snapshot)) continue;
    if (hasSymlinkAtOrAbove(path, baseEntries, sourceEntries)) continue;
    normalizeGitRelativePath(path);
    carryRemovals.push(path);
  }

  const carryUpdates: CarryDeltaEntry[] = [];
  let totalCarryBytes = 0;
  for (const [path, mergedEntry] of [...mergedEntries.entries()].sort((a, b) => compareLexical(a[0], b[0]))) {
    if (excludedConflictPaths.has(path)) continue;
    if (mergedEntry.mode !== '100644' && mergedEntry.mode !== '100755') continue;
    const baseEntry = baseEntries.get(path);
    if (baseEntry !== undefined && baseEntry.mode === mergedEntry.mode && baseEntry.oid === mergedEntry.oid) {
      continue;
    }
    if (!isAllowedCandidateWrite(path, snapshot)) continue;
    if (hasSymlinkAtOrAbove(path, baseEntries, sourceEntries)) continue;
    normalizeGitRelativePath(path);

    const sourceEntry = sourceEntries.get(path);
    if (sourceEntry !== undefined && sourceEntry.oid === mergedEntry.oid) {
      carryUpdates.push(Object.freeze({
        path,
        mode: mergedEntry.mode,
        oid: mergedEntry.oid,
      }));
      continue;
    }

    const remainingCarryBytes = MAX_CARRY_BLOB_BYTES - totalCarryBytes;
    if (remainingCarryBytes <= 0) {
      throw new TaskpackError(
        'TASKPACK_SCOPE_VIOLATION',
        `${BASELINE_CONFLICT_REASON}: synthesized 3-way carry blobs exceed aggregate ${MAX_CARRY_BLOB_BYTES} byte budget`,
        '/spec/baselineAlignment',
        { reason: BASELINE_CONFLICT_REASON },
      );
    }
    const mergedBytes = await readVerifiedBlobIsolated(
      repositoryRoot,
      mergedEntry.oid,
      remainingCarryBytes,
      isolatedEnv,
    );
    totalCarryBytes += mergedBytes.byteLength;
    const sha256 = createHash('sha256').update(mergedBytes).digest('hex');
    carryUpdates.push(Object.freeze({
      path,
      mode: mergedEntry.mode,
      oid: mergedEntry.oid,
      byteLength: mergedBytes.byteLength,
      sha256,
      bytes: mergedBytes,
    }));
  }

  return {
    carryRemovals: Object.freeze(carryRemovals),
    carryUpdates: Object.freeze(carryUpdates),
  };
}

/**
 * Run an isolated 3-way baseline alignment probe in a private temporary `GIT_OBJECT_DIRECTORY`
 * (with read-only `GIT_ALTERNATE_OBJECT_DIRECTORIES`, hooks disabled, and rename detection disabled),
 * guaranteeing ZERO new objects, ref mutations, or working-tree mutations in the host repository.
 */
export async function alignBaselineRevisions(
  options: AlignBaselineRevisionsOptions,
): Promise<BaselineAlignmentResult> {
  const policy = resolveBaselineAlignmentConfig(
    options.manifest?.spec.baselineAlignment,
    options.baselineAlignment,
  );
  const scrubber = options.scrubber ?? new SecretScrubber();
  const baseRevision = options.baseRevision.trim();
  const sourceRevision = options.sourceRevision.trim();

  if (baseRevision === sourceRevision) {
    return Object.freeze({
      disposition: 'clean',
      status: 'same_revision',
      policy,
      baseRevision,
      sourceRevision,
      mergeBase: baseRevision,
      mergedTreeOid: null,
      carryRemovals: Object.freeze([]),
      carryUpdates: Object.freeze([]),
      conflictPaths: Object.freeze([]),
      conflicts: Object.freeze([]),
      conflictResource: null,
    });
  }

  if (!COMMIT_SHA_PATTERN.test(baseRevision) && !OID_HEX_PATTERN.test(baseRevision)) {
    throw new TaskpackError('ACTION_INPUT_INVALID', `baseRevision "${baseRevision}" must be a full commit SHA`);
  }
  if (!COMMIT_SHA_PATTERN.test(sourceRevision) && !OID_HEX_PATTERN.test(sourceRevision)) {
    throw new TaskpackError('ACTION_INPUT_INVALID', `sourceRevision "${sourceRevision}" must be a full commit SHA`);
  }

  const repositoryRoot = await realpath(options.repositoryRoot);
  const alternateDirs = await resolveReadOnlyAlternateObjectDirs(repositoryRoot);
  const scratchParent = options.scratchRoot !== undefined
    ? await realpath(options.scratchRoot)
    : await realpath(tmpdir());
  const privateTempDir = await mkdtemp(join(scratchParent, 'lw-align-'));
  await chmod(privateTempDir, 0o700);
  const privateObjectsDir = join(privateTempDir, 'objects');
  await mkdir(privateObjectsDir, { mode: 0o700 });

  const isolatedEnv = buildCleanGitEnv({
    GIT_OBJECT_DIRECTORY: privateObjectsDir,
    GIT_ALTERNATE_OBJECT_DIRECTORIES: alternateDirs.join(delimiter),
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: '/dev/null',
  });

  const makeBlocked = (
    detail: string,
    mergeBase: string | null,
    conflictPaths: readonly string[],
  ): BaselineAlignmentResult => Object.freeze({
    disposition: 'blocked',
    status: 'blocked',
    reason: BASELINE_CONFLICT_REASON,
    detail: scrubber.scrub(detail),
    policy,
    baseRevision,
    sourceRevision,
    mergeBase,
    mergedTreeOid: null,
    carryRemovals: Object.freeze([]),
    carryUpdates: Object.freeze([]),
    conflictPaths: Object.freeze([...conflictPaths]),
    conflicts: Object.freeze([]),
    conflictResource: null,
  });

  try {
    await execIsolatedGitChecked(
      repositoryRoot,
      ['rev-parse', '--verify', '--end-of-options', `${baseRevision}^{commit}`],
      isolatedEnv,
      { timeoutMs: GIT_VERIFY_TIMEOUT_MS, maxStdoutBytes: MAX_OID_STDOUT_BYTES },
    );
    await execIsolatedGitChecked(
      repositoryRoot,
      ['rev-parse', '--verify', '--end-of-options', `${sourceRevision}^{commit}`],
      isolatedEnv,
      { timeoutMs: GIT_VERIFY_TIMEOUT_MS, maxStdoutBytes: MAX_OID_STDOUT_BYTES },
    );

    const scopeSnapshot = options.scope ?? (
      options.manifest !== undefined
        ? buildScopeSnapshotFromManifest({
          manifest: options.manifest,
          repositoryRoot,
          taskpackPath: options.taskpackPath,
          baseRevision,
          sourceRevision,
          policyProfile: options.policyProfile,
          hostPolicy: options.hostPolicy,
          extraProtectedPaths: options.extraProtectedPaths,
        })
        : undefined
    );

    const baseEntries = await listTreeEntriesAtRevision(repositoryRoot, baseRevision, isolatedEnv);
    const sourceEntries = await listTreeEntriesAtRevision(repositoryRoot, sourceRevision, isolatedEnv);

    const probe = await runIsolatedThreeWayMergeProbe({
      repositoryRoot,
      baseRevision,
      sourceRevision,
      privateTempDir,
      isolatedEnv,
      baseEntries,
      sourceEntries,
      forceIndexFallback: options.forceIndexFallback,
    });

    if (probe.clean && probe.mergedTreeOid !== null) {
      const mergedEntries = await listTreeEntriesAtRevision(repositoryRoot, probe.mergedTreeOid, isolatedEnv);
      const carry = scopeSnapshot !== undefined
        ? await computeWritableCarryDeltaFromMergedTree({
          repositoryRoot,
          snapshot: scopeSnapshot,
          baseEntries,
          sourceEntries,
          mergedEntries,
          excludedConflictPaths: new Set(),
          isolatedEnv,
        })
        : { carryRemovals: Object.freeze([]), carryUpdates: Object.freeze([]) };

      return Object.freeze({
        disposition: 'clean',
        status: 'merged_clean',
        policy,
        baseRevision,
        sourceRevision,
        mergeBase: probe.mergeBase,
        mergedTreeOid: probe.mergedTreeOid,
        carryRemovals: carry.carryRemovals,
        carryUpdates: carry.carryUpdates,
        conflictPaths: Object.freeze([]),
        conflicts: Object.freeze([]),
        conflictResource: null,
      });
    }

    if (policy.policy === 'off') {
      return Object.freeze({
        disposition: 'unmerged_off',
        status: 'conflicts_unmerged',
        policy,
        baseRevision,
        sourceRevision,
        mergeBase: probe.mergeBase,
        mergedTreeOid: probe.mergedTreeOid,
        carryRemovals: Object.freeze([]),
        carryUpdates: Object.freeze([]),
        conflictPaths: probe.conflictPaths,
        conflicts: Object.freeze([]),
        conflictResource: null,
      });
    }

    if (policy.policy === 'fail-fast') {
      return makeBlocked(
        `3-way baseline merge conflict between base ${baseRevision.slice(0, 12)} and source ${sourceRevision.slice(0, 12)} on ${probe.conflictPaths.length} path(s): ${probe.conflictPaths.slice(0, MAX_CONFLICT_SUMMARY_PATHS).join(', ')}`,
        probe.mergeBase,
        probe.conflictPaths,
      );
    }

    if (scopeSnapshot === undefined) {
      return makeBlocked(
        'extract-context baseline alignment requires a validated taskpack scope',
        probe.mergeBase,
        probe.conflictPaths,
      );
    }
    if (probe.conflictPaths.length > policy.maxConflictFiles) {
      return makeBlocked(
        `conflicted file count (${probe.conflictPaths.length}) exceeds maxConflictFiles (${policy.maxConflictFiles})`,
        probe.mergeBase,
        probe.conflictPaths,
      );
    }

    for (const msg of probe.conflictMessages) {
      if (
        msg.conflictType.includes('file/directory')
        || msg.conflictType.includes('submodule')
        || msg.conflictType.includes('symlink')
        || msg.conflictType.includes('distinct modes')
        || msg.conflictType.includes('binary')
        || msg.conflictType.includes('special')
      ) {
        return makeBlocked(
          `unsupported structural or binary 3-way merge conflict (${msg.conflictType})`,
          probe.mergeBase,
          probe.conflictPaths,
        );
      }
    }

    for (const rawPath of probe.conflictPaths) {
      let cleanPath: string;
      try {
        cleanPath = normalizeGitRelativePath(rawPath);
      } catch {
        return makeBlocked(
          'conflicted path failed relative path validation',
          probe.mergeBase,
          probe.conflictPaths,
        );
      }
      if (
        !isAllowedCandidateWrite(cleanPath, scopeSnapshot)
        || hasSymlinkAtOrAbove(cleanPath, baseEntries, sourceEntries)
      ) {
        return makeBlocked(
          `conflicted path "${cleanPath}" is protected or outside writable scope`,
          probe.mergeBase,
          probe.conflictPaths,
        );
      }
    }

    const mergeBaseEntries = probe.mergeBase !== null
      ? await listTreeEntriesAtRevision(repositoryRoot, probe.mergeBase, isolatedEnv)
      : new Map<string, GitTreeEntry>();
    const mergedTreeEntries = probe.mergedTreeOid !== null
      ? await listTreeEntriesAtRevision(repositoryRoot, probe.mergedTreeOid, isolatedEnv)
      : new Map<string, GitTreeEntry>();

    const perBlobReadCap = Math.max(
      policy.maxConflictBytes * CONFLICT_BLOB_READ_MULTIPLIER,
      MIN_CONFLICT_BLOB_READ_CAP_BYTES,
    );
    const extractedFiles: ExtractedBaselineConflictFile[] = [];
    let cumulativeHunkBytes = 0;

    const readOptionalConflictBlobInfo = async (
      entry: GitTreeEntry | undefined,
    ): Promise<{ readonly sha256: string | null; readonly byteLength: number } | 'ceiling_exceeded'> => {
      if (entry === undefined) return { sha256: null, byteLength: 0 };
      try {
        return await computeBlobSha256Isolated(repositoryRoot, entry.oid, isolatedEnv, perBlobReadCap);
      } catch (error) {
        if (error instanceof BlobSizeCeilingExceededError) {
          return 'ceiling_exceeded';
        }
        throw error;
      }
    };

    for (const conflictPath of probe.conflictPaths) {
      const mbEntry = mergeBaseEntries.get(conflictPath);
      const targetEntry = baseEntries.get(conflictPath);
      const sourceEntry = sourceEntries.get(conflictPath);

      if (
        (mbEntry !== undefined && mbEntry.mode !== '100644' && mbEntry.mode !== '100755')
        || (targetEntry !== undefined && targetEntry.mode !== '100644' && targetEntry.mode !== '100755')
        || (sourceEntry !== undefined && sourceEntry.mode !== '100644' && sourceEntry.mode !== '100755')
      ) {
        return makeBlocked(
          `conflicted path "${conflictPath}" has non-regular file mode`,
          probe.mergeBase,
          probe.conflictPaths,
        );
      }

      const baseInfo = await readOptionalConflictBlobInfo(mbEntry);
      const targetInfo = await readOptionalConflictBlobInfo(targetEntry);
      const sourceInfo = await readOptionalConflictBlobInfo(sourceEntry);

      if (baseInfo === 'ceiling_exceeded' || targetInfo === 'ceiling_exceeded' || sourceInfo === 'ceiling_exceeded') {
        return makeBlocked(
          `conflicted blob for "${conflictPath}" exceeds read ceiling`,
          probe.mergeBase,
          probe.conflictPaths,
        );
      }

      let conflictKind: BaselineConflictKind;
      let fileHunks: readonly BaselineConflictHunk[];
      let fileHunkBytes: number;

      if (targetEntry === undefined || sourceEntry === undefined) {
        conflictKind = targetEntry === undefined ? 'delete_modify' : 'modify_delete';
        const survivingOid = targetEntry?.oid ?? sourceEntry?.oid;
        if (survivingOid === undefined) {
          return makeBlocked(`conflicted path "${conflictPath}" missing surviving blob`, probe.mergeBase, probe.conflictPaths);
        }
        let survivingBytes: Buffer;
        try {
          survivingBytes = await readVerifiedBlobIsolated(repositoryRoot, survivingOid, perBlobReadCap, isolatedEnv);
        } catch (error) {
          if (error instanceof BlobSizeCeilingExceededError) {
            return makeBlocked(
              `conflicted blob for "${conflictPath}" exceeds read ceiling`,
              probe.mergeBase,
              probe.conflictPaths,
            );
          }
          throw error;
        }
        if (survivingBytes.includes(0)) {
          return makeBlocked(`binary conflict in "${conflictPath}" cannot be extracted`, probe.mergeBase, probe.conflictPaths);
        }
        let survivingText: string;
        try {
          survivingText = new TextDecoder('utf-8', { fatal: true }).decode(survivingBytes);
        } catch {
          return makeBlocked(`non-UTF-8 conflict in "${conflictPath}" cannot be extracted`, probe.mergeBase, probe.conflictPaths);
        }
        const rawBlock = targetEntry === undefined
          ? `<<<<<<< ${baseRevision} (deleted on target branch)\n=======\n${survivingText.replace(/\r\n?/g, '\n').trimEnd()}\n>>>>>>> ${sourceRevision}`
          : `<<<<<<< ${baseRevision}\n${survivingText.replace(/\r\n?/g, '\n').trimEnd()}\n=======\n>>>>>>> ${sourceRevision} (deleted on source branch)`;
        const scrubbedBlock = scrubber.scrub(rawBlock);
        scrubber.assertClean(scrubbedBlock, BASELINE_CONFLICT_RESOURCE_PATH);
        fileHunkBytes = Buffer.byteLength(scrubbedBlock, 'utf8');
        if (cumulativeHunkBytes + fileHunkBytes > policy.maxConflictBytes) {
          return makeBlocked(
            `extracted conflict bytes exceed maxConflictBytes (${policy.maxConflictBytes})`,
            probe.mergeBase,
            probe.conflictPaths,
          );
        }
        const lineCount = Math.max(1, survivingText.split(/\r?\n/).length);
        fileHunks = Object.freeze([
          Object.freeze({
            index: 0,
            startLine: 1,
            endLine: lineCount,
            block: scrubbedBlock,
          }),
        ]);
      } else {
        conflictKind = mbEntry === undefined ? 'add_add' : 'content';
        let rawMergedConflictBytes = probe.conflictTextByPath.get(conflictPath);
        if (rawMergedConflictBytes === undefined) {
          const mergedConflictEntry = mergedTreeEntries.get(conflictPath);
          if (mergedConflictEntry === undefined || (mergedConflictEntry.mode !== '100644' && mergedConflictEntry.mode !== '100755')) {
            return makeBlocked(
              `conflicted tree entry missing for "${conflictPath}"`,
              probe.mergeBase,
              probe.conflictPaths,
            );
          }
          try {
            rawMergedConflictBytes = await readVerifiedBlobIsolated(
              repositoryRoot,
              mergedConflictEntry.oid,
              perBlobReadCap,
              isolatedEnv,
            );
          } catch (error) {
            if (error instanceof BlobSizeCeilingExceededError) {
              return makeBlocked(
                `conflicted blob for "${conflictPath}" exceeds read ceiling`,
                probe.mergeBase,
                probe.conflictPaths,
              );
            }
            throw error;
          }
        }
        if (rawMergedConflictBytes.includes(0)) {
          return makeBlocked(
            `binary merge conflict in "${conflictPath}" cannot be extracted`,
            probe.mergeBase,
            probe.conflictPaths,
          );
        }
        let mergedConflictText: string;
        try {
          mergedConflictText = new TextDecoder('utf-8', { fatal: true }).decode(rawMergedConflictBytes);
        } catch {
          return makeBlocked(
            `non-UTF-8 merge conflict in "${conflictPath}" cannot be extracted`,
            probe.mergeBase,
            probe.conflictPaths,
          );
        }
        const extracted = extractConflictHunksFromMergedText(
          mergedConflictText,
          scrubber,
          policy.maxConflictBytes - cumulativeHunkBytes,
        );
        if (extracted === null) {
          return makeBlocked(
            `conflict hunks in "${conflictPath}" could not be extracted within maxConflictBytes (${policy.maxConflictBytes})`,
            probe.mergeBase,
            probe.conflictPaths,
          );
        }
        fileHunks = extracted.hunks;
        fileHunkBytes = extracted.totalHunkBytes;
      }

      cumulativeHunkBytes += fileHunkBytes;
      if (cumulativeHunkBytes > policy.maxConflictBytes) {
        return makeBlocked(
          `extracted conflict bytes (${cumulativeHunkBytes}) exceed maxConflictBytes (${policy.maxConflictBytes})`,
          probe.mergeBase,
          probe.conflictPaths,
        );
      }

      extractedFiles.push(Object.freeze({
        path: conflictPath,
        conflictKind,
        baseSha256: baseInfo.sha256,
        targetSha256: targetInfo.sha256,
        sourceSha256: sourceInfo.sha256,
        byteLength: fileHunkBytes,
        hunks: fileHunks,
      }));
    }

    const document: BaselineConflictContextDocument = Object.freeze({
      version: 1,
      baseRevision,
      sourceRevision,
      mergeBase: probe.mergeBase,
      conflictCount: extractedFiles.length,
      totalHunkBytes: cumulativeHunkBytes,
      conflicts: Object.freeze(extractedFiles),
    });
    const serializedJson = `${scrubber.scrub(JSON.stringify(document, null, 2))}\n`;
    scrubber.assertClean(serializedJson, BASELINE_CONFLICT_RESOURCE_PATH);
    const resourceBytes = Buffer.from(serializedJson, 'utf8');
    if (resourceBytes.byteLength > policy.maxConflictBytes) {
      return makeBlocked(
        `serialized conflict context (${resourceBytes.byteLength} bytes) exceeds maxConflictBytes (${policy.maxConflictBytes})`,
        probe.mergeBase,
        probe.conflictPaths,
      );
    }

    const sha256 = createHash('sha256').update(resourceBytes).digest('hex');
    const conflictResource: BaselineConflictContextResource = Object.freeze({
      id: BASELINE_CONFLICT_RESOURCE_ID,
      kind: 'document',
      path: BASELINE_CONFLICT_RESOURCE_PATH,
      bytes: resourceBytes,
      sha256,
      byteLength: resourceBytes.byteLength,
      document,
      extractedPaths: probe.conflictPaths,
    });

    const cleanCarry = probe.mergedTreeOid !== null
      ? await computeWritableCarryDeltaFromMergedTree({
        repositoryRoot,
        snapshot: scopeSnapshot,
        baseEntries,
        sourceEntries,
        mergedEntries: mergedTreeEntries,
        excludedConflictPaths: new Set(probe.conflictPaths),
        isolatedEnv,
      })
      : { carryRemovals: Object.freeze([]), carryUpdates: Object.freeze([]) };

    return Object.freeze({
      disposition: 'extracted',
      status: 'conflicts_extracted',
      policy,
      baseRevision,
      sourceRevision,
      mergeBase: probe.mergeBase,
      mergedTreeOid: probe.mergedTreeOid,
      carryRemovals: cleanCarry.carryRemovals,
      carryUpdates: cleanCarry.carryUpdates,
      conflictPaths: probe.conflictPaths,
      conflicts: Object.freeze(extractedFiles),
      conflictResource,
    });
  } finally {
    await cleanupPrivateTempDir(privateTempDir, scrubber, options.onLog);
  }
}

async function readCandidateFileVerifiedBytes(file: InspectedCandidateFile): Promise<{
  readonly bytes: Buffer;
  readonly sha256: string;
}> {
  if (file.kind === 'inline') {
    return {
      bytes: file.bytes,
      sha256: createHash('sha256').update(file.bytes).digest('hex'),
    };
  }
  const noFollow = 'O_NOFOLLOW' in fsConstants ? fsConstants.O_NOFOLLOW : 0;
  const before = await lstat(file.canonicalBlobPath);
  if (before.isSymbolicLink() || !before.isFile() || before.nlink !== 1 || before.size !== file.byteLength) {
    throw new TaskpackError('ACTION_INPUT_INVALID', `CAS blob for "${file.name}" failed lstat/nlink verification`);
  }
  const handle = await open(file.canonicalBlobPath, fsConstants.O_RDONLY | noFollow);
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.nlink !== 1 || stat.dev !== before.dev || stat.ino !== before.ino || stat.size !== file.byteLength) {
      throw new TaskpackError('ACTION_INPUT_INVALID', `CAS blob for "${file.name}" changed identity before conflict check`);
    }
    const chunks: Buffer[] = [];
    const hash = createHash('sha256');
    const buf = Buffer.allocUnsafe(Math.min(STREAM_CHUNK_BYTES, Math.max(1, file.byteLength)));
    let offset = 0;
    while (offset < file.byteLength) {
      const toRead = Math.min(buf.byteLength, file.byteLength - offset);
      const { bytesRead } = await handle.read(buf, 0, toRead, offset);
      if (bytesRead <= 0) break;
      const slice = Buffer.from(buf.subarray(0, bytesRead));
      hash.update(slice);
      chunks.push(slice);
      offset += bytesRead;
    }
    const sha256 = hash.digest('hex');
    if (offset !== file.byteLength || sha256 !== file.sha256) {
      throw new TaskpackError('ACTION_INPUT_INVALID', `CAS blob for "${file.name}" failed SHA-256 verification`);
    }
    return {
      bytes: Buffer.concat(chunks),
      sha256,
    };
  } finally {
    await handle.close();
  }
}

/**
 * Verify that every extracted baseline conflict path was explicitly updated or deleted by the candidate
 * and contains ZERO residual Git conflict markers (`<<<<<<<`, `|||||||`, `>>>>>>>`).
 */
export async function assertExtractedConflictsResolved(
  options: AssertExtractedConflictsResolvedOptions,
): Promise<void> {
  if (options.extractedConflictPaths.length === 0) return;

  const filesByPath = new Map<string, InspectedCandidateFile>();
  for (const file of options.candidateFiles) {
    const clean = normalizeGitRelativePath(file.name);
    filesByPath.set(clean, file);
  }
  const deletedSet = new Set<string>(
    (options.candidateDeletedPaths ?? []).map(p => normalizeGitRelativePath(p)),
  );

  for (const rawPath of options.extractedConflictPaths) {
    const conflictPath = normalizeGitRelativePath(rawPath);
    if (!isAllowedCandidateWrite(conflictPath, options.snapshot)) {
      throw new TaskpackError(
        'TASKPACK_SCOPE_VIOLATION',
        `${BASELINE_CONFLICT_REASON}: extracted conflict path "${conflictPath}" is outside writable scope`,
        '/spec/baselineAlignment',
        { reason: BASELINE_CONFLICT_REASON },
      );
    }

    const updatedFile = filesByPath.get(conflictPath);
    const wasDeleted = deletedSet.has(conflictPath) && updatedFile === undefined;
    if (wasDeleted) {
      continue;
    }
    if (updatedFile === undefined) {
      throw new TaskpackError(
        'TASKPACK_SCOPE_VIOLATION',
        `${BASELINE_CONFLICT_REASON}: unresolved baseline conflict in "${conflictPath}" (must be updated or deleted by candidate)`,
        '/spec/baselineAlignment',
        { reason: BASELINE_CONFLICT_REASON },
      );
    }

    const { bytes, sha256 } = await readCandidateFileVerifiedBytes(updatedFile);
    const originalSourceSha = options.sourceSha256ByPath?.get(conflictPath);
    if (originalSourceSha !== undefined && sha256 === originalSourceSha) {
      throw new TaskpackError(
        'TASKPACK_SCOPE_VIOLATION',
        `${BASELINE_CONFLICT_REASON}: unresolved baseline conflict in "${conflictPath}" (candidate left sourceRevision content unchanged)`,
        '/spec/baselineAlignment',
        { reason: BASELINE_CONFLICT_REASON },
      );
    }
    if (containsResidualGitConflictMarkers(bytes)) {
      throw new TaskpackError(
        'TASKPACK_SCOPE_VIOLATION',
        `${BASELINE_CONFLICT_REASON}: candidate file "${conflictPath}" still contains residual Git conflict markers`,
        '/spec/baselineAlignment',
        { reason: BASELINE_CONFLICT_REASON },
      );
    }
  }
}

/**
 * Shared 3-way carry helper for `startLocalCommandGateServer` (`@loopwright/taskpack`) and `publisher.ts`
 * (`@loopwright/github-app`): computes verified 3-way merged writable carry blobs in a private temporary
 * `GIT_OBJECT_DIRECTORY`, preserving disjoint same-file edits on `baseRevision` and `sourceRevision` while
 * failing closed on unmerged conflicts (`policy: 'off'`) or unresolved `extract-context` conflicts.
 */
export async function computeThreeWaySourceRevisionCarryDelta(
  options: ComputeThreeWayCarryDeltaOptions,
): Promise<ThreeWayCarryDeltaResult> {
  const scrubber = options.scrubber ?? new SecretScrubber();
  const baseRevision = options.baseRevision.trim();
  const sourceRevision = options.sourceRevision.trim();
  if (baseRevision === sourceRevision) {
    if (options.extractedConflictPaths !== undefined && options.extractedConflictPaths.length > 0) {
      await assertExtractedConflictsResolved({
        extractedConflictPaths: options.extractedConflictPaths,
        snapshot: options.snapshot,
        candidateFiles: options.candidateFiles ?? [],
        candidateDeletedPaths: options.candidateDeletedPaths,
      });
    }
    return Object.freeze({
      carryRemovals: Object.freeze([]),
      carryUpdates: Object.freeze([]),
      mergeBase: baseRevision,
      mergedTreeOid: null,
      resolvedConflictPaths: Object.freeze([...(options.extractedConflictPaths ?? [])]),
    });
  }

  const repositoryRoot = await realpath(options.repositoryRoot);
  const alternateDirs = await resolveReadOnlyAlternateObjectDirs(repositoryRoot);
  const scratchParent = options.scratchRoot !== undefined
    ? await realpath(options.scratchRoot)
    : await realpath(tmpdir());
  const privateTempDir = await mkdtemp(join(scratchParent, 'lw-carry3-'));
  await chmod(privateTempDir, 0o700);
  const privateObjectsDir = join(privateTempDir, 'objects');
  await mkdir(privateObjectsDir, { mode: 0o700 });

  const isolatedEnv = buildCleanGitEnv({
    GIT_OBJECT_DIRECTORY: privateObjectsDir,
    GIT_ALTERNATE_OBJECT_DIRECTORIES: alternateDirs.join(delimiter),
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: '/dev/null',
  });

  try {
    const baseEntries = options.baseEntries ?? await listTreeEntriesAtRevision(repositoryRoot, baseRevision, isolatedEnv);
    const sourceEntries = options.sourceEntries ?? await listTreeEntriesAtRevision(repositoryRoot, sourceRevision, isolatedEnv);
    const probe = await runIsolatedThreeWayMergeProbe({
      repositoryRoot,
      baseRevision,
      sourceRevision,
      privateTempDir,
      isolatedEnv,
      baseEntries,
      sourceEntries,
      forceIndexFallback: options.forceIndexFallback,
    });

    const writableConflicts = probe.conflictPaths.filter(
      path => isAllowedCandidateWrite(path, options.snapshot) && !hasSymlinkAtOrAbove(path, baseEntries, sourceEntries),
    );
    const extractContextActive =
      (options.snapshot.contract !== undefined && hasBaselineConflictResource(options.snapshot.contract))
      || (options.extractedConflictPaths !== undefined && options.extractedConflictPaths.length > 0);

    if (writableConflicts.length > 0 && !extractContextActive) {
      throw new TaskpackError(
        'TASKPACK_SCOPE_VIOLATION',
        `${BASELINE_CONFLICT_REASON}: unmerged 3-way baseline conflict on writable path(s): ${writableConflicts.slice(0, MAX_CONFLICT_SUMMARY_PATHS).join(', ')}`,
        '/spec/baselineAlignment',
        { reason: BASELINE_CONFLICT_REASON },
      );
    }

    const requiredConflictPaths = extractContextActive
      ? [...new Set([...(options.extractedConflictPaths ?? []), ...writableConflicts])].sort(compareLexical)
      : [];

    if (requiredConflictPaths.length > 0) {
      if (options.extractedConflictPaths !== undefined && options.extractedConflictPaths.length > 0) {
        const allowedExtracted = new Set(options.extractedConflictPaths);
        for (const wc of writableConflicts) {
          if (!allowedExtracted.has(wc)) {
            throw new TaskpackError(
              'TASKPACK_SCOPE_VIOLATION',
              `${BASELINE_CONFLICT_REASON}: unexpected unmerged conflict "${wc}" outside extracted conflict set`,
              '/spec/baselineAlignment',
              { reason: BASELINE_CONFLICT_REASON },
            );
          }
        }
      }
      const sourceSha256ByPath = new Map<string, string>();
      for (const path of requiredConflictPaths) {
        const srcEntry = sourceEntries.get(path);
        if (srcEntry !== undefined && (srcEntry.mode === '100644' || srcEntry.mode === '100755')) {
          const info = await computeBlobSha256Isolated(repositoryRoot, srcEntry.oid, isolatedEnv);
          sourceSha256ByPath.set(path, info.sha256);
        }
      }
      await assertExtractedConflictsResolved({
        extractedConflictPaths: requiredConflictPaths,
        snapshot: options.snapshot,
        candidateFiles: options.candidateFiles ?? [],
        candidateDeletedPaths: options.candidateDeletedPaths,
        sourceSha256ByPath,
      });
    }

    if (probe.mergedTreeOid === null) {
      throw new TaskpackError(
        'TASKPACK_SCOPE_VIOLATION',
        `${BASELINE_CONFLICT_REASON}: missing verified 3-way merged tree for baseline carry resolution`,
        '/spec/baselineAlignment',
        { reason: BASELINE_CONFLICT_REASON },
      );
    }
    const mergedEntries = await listTreeEntriesAtRevision(repositoryRoot, probe.mergedTreeOid, isolatedEnv);
    const carry = await computeWritableCarryDeltaFromMergedTree({
      repositoryRoot,
      snapshot: options.snapshot,
      baseEntries,
      sourceEntries,
      mergedEntries,
      excludedConflictPaths: new Set(probe.conflictPaths),
      isolatedEnv,
    });

    return Object.freeze({
      carryRemovals: carry.carryRemovals,
      carryUpdates: carry.carryUpdates,
      mergeBase: probe.mergeBase,
      mergedTreeOid: probe.mergedTreeOid,
      resolvedConflictPaths: Object.freeze(requiredConflictPaths),
    });
  } finally {
    await cleanupPrivateTempDir(privateTempDir, scrubber, options.onLog);
  }
}

/**
 * Reconcile candidate overlay files (authored against `sourceRevision`) with `baseRevision` and
 * 3-way merged carry blobs (`ancestor = sourceRevision`, `ours = effective 3-way merged baseline`,
 * `theirs = candidate`) in a private temporary directory with ZERO host `.git/objects` writes.
 *
 * Preserves disjoint `baseRevision` lines when the candidate edits other regions of the same file,
 * passes `extractedConflictPaths` through untouched (already reconciled by the candidate), and fails
 * closed with `reason: 'baseline_merge_conflict'` when a candidate edit or deletion conflicts with `baseRevision`.
 */
export async function mergeCandidateOverlayWithCarry(
  options: MergeCandidateOverlayWithCarryOptions,
): Promise<readonly InspectedCandidateFile[]> {
  const baseRevision = options.baseRevision.trim();
  const sourceRevision = options.sourceRevision.trim();
  const deletedList = options.candidateDeletedPaths ?? [];
  if (baseRevision === sourceRevision || (options.overlayFiles.length === 0 && deletedList.length === 0)) {
    return options.overlayFiles;
  }

  const scrubber = options.scrubber ?? new SecretScrubber();
  const extractedSet = new Set<string>(
    (options.extractedConflictPaths ?? []).map(p => normalizeGitRelativePath(p)),
  );
  const carryByPath = new Map<string, CarryDeltaEntry>(
    options.carryUpdates.map(u => [u.path, u] as const),
  );

  const repositoryRoot = await realpath(options.repositoryRoot);
  const alternateDirs = await resolveReadOnlyAlternateObjectDirs(repositoryRoot);
  const scratchParent = options.scratchRoot !== undefined
    ? await realpath(options.scratchRoot)
    : await realpath(tmpdir());
  const privateTempDir = await mkdtemp(join(scratchParent, 'lw-cand-merge-'));
  await chmod(privateTempDir, 0o700);
  const privateObjectsDir = join(privateTempDir, 'objects');
  const mergeScratchDir = join(privateTempDir, 'files');
  await mkdir(privateObjectsDir, { mode: 0o700 });
  await mkdir(mergeScratchDir, { mode: 0o700 });

  const isolatedEnv = buildCleanGitEnv({
    GIT_OBJECT_DIRECTORY: privateObjectsDir,
    GIT_ALTERNATE_OBJECT_DIRECTORIES: alternateDirs.join(delimiter),
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: '/dev/null',
  });

  try {
    const baseEntries = options.baseEntries ?? await listTreeEntriesAtRevision(repositoryRoot, baseRevision, isolatedEnv);
    const sourceEntries = options.sourceEntries ?? await listTreeEntriesAtRevision(repositoryRoot, sourceRevision, isolatedEnv);

    for (const rawDel of deletedList) {
      const delPath = normalizeGitRelativePath(rawDel);
      if (extractedSet.has(delPath)) continue;
      const srcEntry = sourceEntries.get(delPath);
      const carryEntry = carryByPath.get(delPath);
      const baseEntry = baseEntries.get(delPath);
      const effectiveTargetOid = carryEntry?.oid ?? baseEntry?.oid;
      if (srcEntry !== undefined && effectiveTargetOid !== undefined && effectiveTargetOid !== srcEntry.oid) {
        throw new TaskpackError(
          'TASKPACK_SCOPE_VIOLATION',
          `${BASELINE_CONFLICT_REASON}: candidate deletion of "${delPath}" conflicts with baseRevision modifications`,
          '/spec/baselineAlignment',
          { reason: BASELINE_CONFLICT_REASON },
        );
      }
    }

    const reconciled: InspectedCandidateFile[] = [];
    for (const file of options.overlayFiles) {
      const cleanName = normalizeGitRelativePath(file.name);
      if (extractedSet.has(cleanName)) {
        reconciled.push(file);
        continue;
      }

      const srcEntry = sourceEntries.get(cleanName);
      const baseEntry = baseEntries.get(cleanName);
      const carryEntry = carryByPath.get(cleanName);

      let oursMode: '100644' | '100755' | undefined;
      let oursOid: string | undefined;
      let oursPreloadedBytes: Uint8Array | undefined;
      if (carryEntry !== undefined) {
        oursMode = carryEntry.mode;
        oursOid = carryEntry.oid;
        oursPreloadedBytes = carryEntry.bytes;
      } else if (baseEntry !== undefined && (baseEntry.mode === '100644' || baseEntry.mode === '100755')) {
        oursMode = baseEntry.mode;
        oursOid = baseEntry.oid;
      }

      if (oursOid === undefined || oursMode === undefined) {
        if (srcEntry !== undefined) {
          const { bytes: candBytes } = await readCandidateFileVerifiedBytes(file);
          const srcBytes = (srcEntry.mode === '100644' || srcEntry.mode === '100755')
            ? await readVerifiedBlobIsolated(repositoryRoot, srcEntry.oid, MAX_CARRY_BLOB_BYTES, isolatedEnv)
            : null;
          if (srcBytes === null || !candBytes.equals(srcBytes)) {
            throw new TaskpackError(
              'TASKPACK_SCOPE_VIOLATION',
              `${BASELINE_CONFLICT_REASON}: candidate modification on "${cleanName}" conflicts with deletion on baseRevision`,
              '/spec/baselineAlignment',
              { reason: BASELINE_CONFLICT_REASON },
            );
          }
          continue;
        }
        reconciled.push(file);
        continue;
      }

      if (srcEntry !== undefined && srcEntry.oid === oursOid && srcEntry.mode === oursMode) {
        reconciled.push(file);
        continue;
      }

      const { bytes: theirsBytes } = await readCandidateFileVerifiedBytes(file);
      const oursBytes = oursPreloadedBytes !== undefined
        ? Buffer.from(oursPreloadedBytes)
        : await readVerifiedBlobIsolated(repositoryRoot, oursOid, MAX_CARRY_BLOB_BYTES, isolatedEnv);
      const ancBytes = srcEntry !== undefined && (srcEntry.mode === '100644' || srcEntry.mode === '100755')
        ? await readVerifiedBlobIsolated(repositoryRoot, srcEntry.oid, MAX_CARRY_BLOB_BYTES, isolatedEnv)
        : Buffer.alloc(0);

      const resolvedMode: '100644' | '100755' =
        file.mode !== undefined && (srcEntry === undefined || file.mode !== srcEntry.mode)
          ? file.mode
          : oursMode;

      if (oursBytes.equals(theirsBytes)) {
        reconciled.push(
          file.mode === resolvedMode
            ? file
            : {
              kind: 'inline',
              name: cleanName,
              mode: resolvedMode,
              bytes: oursBytes,
            },
        );
        continue;
      }
      if (srcEntry !== undefined && ancBytes.equals(theirsBytes)) {
        reconciled.push({
          kind: 'inline',
          name: cleanName,
          mode: resolvedMode,
          bytes: oursBytes,
        });
        continue;
      }
      if (ancBytes.includes(0) || oursBytes.includes(0) || theirsBytes.includes(0)) {
        throw new TaskpackError(
          'TASKPACK_SCOPE_VIOLATION',
          `${BASELINE_CONFLICT_REASON}: binary candidate modification on "${cleanName}" conflicts with baseRevision changes`,
          '/spec/baselineAlignment',
          { reason: BASELINE_CONFLICT_REASON },
        );
      }

      const fOurs = join(mergeScratchDir, 'ours');
      const fAnc = join(mergeScratchDir, 'anc');
      const fTheirs = join(mergeScratchDir, 'theirs');
      await writeFile(fOurs, oursBytes, { mode: 0o600 });
      await writeFile(fAnc, ancBytes, { mode: 0o600 });
      await writeFile(fTheirs, theirsBytes, { mode: 0o600 });

      const mergeRes = await runIsolatedGit(
        repositoryRoot,
        [
          'merge-file',
          '-p',
          '-L', baseRevision,
          '-L', sourceRevision,
          '-L', 'candidate',
          fOurs,
          fAnc,
          fTheirs,
        ],
        isolatedEnv,
        { maxStdoutBytes: MAX_CARRY_BLOB_BYTES },
      );

      if (mergeRes.code === 0 && mergeRes.signal === null && !mergeRes.timedOut && !mergeRes.stdoutOverflow) {
        const resolvedMode: '100644' | '100755' =
          file.mode !== undefined && (srcEntry === undefined || file.mode !== srcEntry.mode)
            ? file.mode
            : oursMode;
        reconciled.push({
          kind: 'inline',
          name: cleanName,
          mode: resolvedMode,
          bytes: mergeRes.stdout,
        });
      } else if (mergeRes.code !== null && mergeRes.code > 0 && mergeRes.code <= MAX_MERGE_FILE_EXIT_CONFLICTS) {
        throw new TaskpackError(
          'TASKPACK_SCOPE_VIOLATION',
          `${BASELINE_CONFLICT_REASON}: candidate modification on "${cleanName}" conflicts with baseRevision changes`,
          '/spec/baselineAlignment',
          { reason: BASELINE_CONFLICT_REASON },
        );
      } else {
        throw new TaskpackError(
          'ACTION_INPUT_INVALID',
          `git merge-file failed while reconciling candidate file "${cleanName}"`,
        );
      }
    }

    return Object.freeze(reconciled);
  } finally {
    await cleanupPrivateTempDir(privateTempDir, scrubber, options.onLog);
  }
}

/**
 * Write any synthesized 3-way merged carry blobs (`entry.bytes !== undefined`) into the repository's
 * Git object store right before `stageEntriesInIndex` during branch publication, verifying OID parity.
 */
export async function ensureCarryBlobsInGitObjectStore(options: EnsureCarryBlobsOptions): Promise<void> {
  const objectFormat = options.objectFormat ?? 'sha1';
  const oidPattern = objectFormat === 'sha1' ? SHA1_OID_HEX_PATTERN : SHA256_HEX_PATTERN;
  const gitEnv = options.gitEnv ?? buildCleanGitEnv({
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: '/dev/null',
  });
  for (const entry of options.carryUpdates) {
    if (entry.bytes === undefined) continue;
    const buf = Buffer.from(entry.bytes);
    const expectedOid = createHash(objectFormat).update(`blob ${buf.byteLength}\0`).update(buf).digest('hex');
    if (!oidPattern.test(entry.oid) || expectedOid !== entry.oid) {
      throw new TaskpackError('ACTION_INPUT_INVALID', `3-way carry blob OID mismatch for "${entry.path}"`);
    }
    if (entry.sha256 !== undefined) {
      const actualSha256 = createHash('sha256').update(buf).digest('hex');
      if (actualSha256 !== entry.sha256) {
        throw new TaskpackError('ACTION_INPUT_INVALID', `3-way carry blob SHA-256 mismatch for "${entry.path}"`);
      }
    }
    const writtenOid = (
      await execIsolatedGitChecked(
        options.repositoryRoot,
        ['hash-object', '-w', '--stdin'],
        gitEnv,
        { input: buf, timeoutMs: GIT_MERGE_TREE_TIMEOUT_MS, maxStdoutBytes: MAX_OID_STDOUT_BYTES },
      )
    ).toString('utf8').trim();
    if (writtenOid !== entry.oid) {
      throw new TaskpackError('ACTION_INPUT_INVALID', `git hash-object returned unexpected OID for carried "${entry.path}"`);
    }
  }
}

/**
 * Filter candidate snapshot files in classic full-snapshot mode (`baseTree === undefined`)
 * down to writable files that were actually added or modified relative to `sourceEntries`
 * (differing in Git blob OID or mode), matching v2 minimal-overlay semantics so untouched
 * `sourceRevision` files never overwrite verified 3-way merged carry blobs.
 */
export async function filterModifiedCandidateOverlayFiles(
  files: readonly InspectedCandidateFile[],
  snapshot: CandidateScopeSnapshot,
  sourceEntries: ReadonlyMap<string, GitTreeEntry>,
): Promise<readonly InspectedCandidateFile[]> {
  const modified: InspectedCandidateFile[] = [];
  for (const file of files) {
    if (!isAllowedCandidateWrite(file.name, snapshot)) continue;
    const sourceEntry = sourceEntries.get(file.name);
    if (sourceEntry !== undefined && (sourceEntry.mode === '100644' || sourceEntry.mode === '100755')) {
      const { bytes } = await readCandidateFileVerifiedBytes(file);
      const algo = sourceEntry.oid.length === 64 ? 'sha256' : 'sha1';
      const actualOid = createHash(algo)
        .update(`blob ${bytes.byteLength}\0`)
        .update(bytes)
        .digest('hex');
      const modeMatches = file.mode === undefined || file.mode === sourceEntry.mode;
      if (actualOid === sourceEntry.oid && modeMatches) {
        continue;
      }
    }
    modified.push(file);
  }
  return Object.freeze(modified);
}

/**
 * Pre-publication baseline alignment, 3-way carry computation, and candidate-overlay reconciliation
 * over an `InspectedCandidateSnapshot`. Returns both the verified 3-way carry delta (`carryRemovals`,
 * `carryUpdates`) and `reconciledOverlayFiles` ready for Git index staging.
 */
export async function verifyCandidateBaselinePrePublication(
  options: VerifyCandidateBaselinePrePublicationOptions,
): Promise<VerifyCandidatePrePublicationResult> {
  const { snapshot } = options;
  const resolvedRepoRoot = resolve(options.repositoryRoot);
  const repoStat = await lstat(resolvedRepoRoot).catch(() => null);
  if (repoStat === null || repoStat.isSymbolicLink() || !repoStat.isDirectory()) {
    throw new TaskpackError('ACTION_INPUT_INVALID', 'repositoryRoot must be an existing non-symlink directory');
  }

  let baseEntries: ReadonlyMap<string, GitTreeEntry> | undefined;
  let sourceEntries: ReadonlyMap<string, GitTreeEntry> | undefined;
  if (snapshot.sourceRevision !== snapshot.baseRevision) {
    const cleanEnv = options.gitEnv ?? buildCleanGitEnv({
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: '/dev/null',
    });
    baseEntries = await listTreeEntriesAtRevision(options.repositoryRoot, snapshot.baseRevision, cleanEnv);
    sourceEntries = await listTreeEntriesAtRevision(options.repositoryRoot, snapshot.sourceRevision, cleanEnv);
  }

  let overlayFiles: readonly InspectedCandidateFile[] = snapshot.manifest.spec.baseTree !== undefined
    ? snapshot.files
    : snapshot.files.filter(file => isAllowedCandidateWrite(file.name, snapshot));
  const deletedPaths: string[] = [];
  if (snapshot.manifest.spec.baseTree !== undefined) {
    for (const rawDel of snapshot.manifest.spec.deleted ?? []) {
      deletedPaths.push(normalizeGitRelativePath(rawDel));
    }
  } else if (snapshot.sourceRevision !== snapshot.baseRevision && baseEntries !== undefined && sourceEntries !== undefined) {
    overlayFiles = await filterModifiedCandidateOverlayFiles(snapshot.files, snapshot, sourceEntries);
    const candidateNames = new Set(snapshot.files.map(f => f.name));
    for (const [sourceName, sourceEntry] of sourceEntries.entries()) {
      if (sourceEntry.mode !== '100644' && sourceEntry.mode !== '100755') continue;
      if (
        !candidateNames.has(sourceName)
        && isAllowedCandidateWrite(sourceName, snapshot)
        && !hasSymlinkAtOrAbove(sourceName, baseEntries, sourceEntries)
      ) {
        deletedPaths.push(sourceName);
      }
    }
  }
  for (const rawRel of deletedPaths) {
    normalizeGitRelativePath(rawRel);
  }

  const carryDelta = await computeThreeWaySourceRevisionCarryDelta({
    repositoryRoot: options.repositoryRoot,
    baseRevision: snapshot.baseRevision,
    sourceRevision: snapshot.sourceRevision,
    snapshot,
    baseEntries,
    sourceEntries,
    candidateFiles: overlayFiles,
    candidateDeletedPaths: deletedPaths,
    extractedConflictPaths: options.extractedConflictPaths,
    scratchRoot: options.scratchRoot,
    gitEnv: options.gitEnv,
    forceIndexFallback: options.forceIndexFallback,
    scrubber: options.scrubber,
    onLog: options.onLog,
  });

  const reconciledOverlayFiles = await mergeCandidateOverlayWithCarry({
    repositoryRoot: options.repositoryRoot,
    baseRevision: snapshot.baseRevision,
    sourceRevision: snapshot.sourceRevision,
    snapshot,
    overlayFiles,
    candidateDeletedPaths: deletedPaths,
    carryUpdates: carryDelta.carryUpdates,
    baseEntries,
    sourceEntries,
    extractedConflictPaths: carryDelta.resolvedConflictPaths,
    scratchRoot: options.scratchRoot,
    scrubber: options.scrubber,
    onLog: options.onLog,
  });

  return Object.freeze({
    ...carryDelta,
    reconciledOverlayFiles,
  });
}
