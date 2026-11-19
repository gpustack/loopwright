import { randomBytes } from 'node:crypto';
import { constants as fsConstants, existsSync } from 'node:fs';
import { chmod, lstat, mkdir, mkdtemp, open, readdir, readFile, realpath, rename, rm, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { validateDocument } from '@loopwright/core';
import {
  applyMemoryProposalCAS,
  canonical as canonicalMemory,
  DEFAULT_MEMORY_MAX_ENTRIES,
  DEFAULT_MEMORY_TTL_DAYS,
  digestEqual,
  finalizeRunMemory,
  isMemoryManagedPath,
  loadMemoryStore,
  MAX_MEMORY_ENTRY_FILE_BYTES,
  MAX_MEMORY_INDEX_FILE_BYTES,
  MemoryDiagnosticError,
  resolveSettledCycleContext,
  type MemoryCASResult,
  type MemoryEntry,
  type MemoryFinalizerConfig,
  type MemoryProposal,
  type MemoryStoreIndex,
  type ResolvedSettledCycleContext,
  type SeparateMemoryPullRequestSpec,
} from '@loopwright/memory';
import { sanitizeReportText } from './output-format.js';
import {
  buildUpstreamVersionsMap,
  compileScopePatterns,
  resolveManifestControlRoot,
  resolveTaskpackMemoryLocation,
} from './taskpack.js';
import { assertCleanArtifact, SecretScrubber } from './token-broker.js';
import {
  buildGitAuthEnv,
  CONTROLLER_ID_PATTERN,
  execGit,
  execGitDetailed,
  hasSymlinkAtOrAbove,
  listTreeEntriesAtRevision,
  MAX_REASON_CODEPOINTS,
  removePathsFromIndex,
  SAFE_BRANCH_PATTERN,
  stageEntriesInIndex,
  truncateCodePoints,
} from './turnkey.js';
import {
  GitHubAppError,
  PROTECTED_AUTOMATION_PATHS,
  REPOSITORY_FULL_NAME_PATTERN,
  type GitCommitIdentity,
  type TargetMatrixCell,
  type TaskpackManifest,
  type TaskpackUpstreamRecord,
  type TurnkeyMemorySummary,
} from './types.js';
import {
  buildCleanGitEnv,
  COMMIT_SHA_PATTERN,
  DEFAULT_GIT_COMMIT_IDENTITY,
  fetchBoundedText,
  findOpenMemoryPullRequest,
  isPlainRecord,
  type ManagedPullRequestInfo,
  validateGitCommitIdentity,
  validateGitRemoteSource,
} from './upstreams.js';

export interface FinalizeAndPublishTurnkeyMemoryOptions {
  readonly runRoot: string;
  readonly runId: string;
  readonly repositoryRoot: string;
  readonly repositoryFullName: string;
  readonly manifest: TaskpackManifest;
  readonly taskpackPath?: string | undefined;
  readonly baseRevision: string;
  readonly upstreamRecords?: readonly TaskpackUpstreamRecord[] | undefined;
  readonly targetMatrix?: TargetMatrixCell | null | undefined;
  readonly remoteUrl?: string | undefined;
  readonly apiBaseUrl?: string | undefined;
  readonly githubToken?: string | undefined;
  readonly gitCommitIdentity?: GitCommitIdentity | undefined;
  readonly fetchImpl?: typeof globalThis.fetch | undefined;
  readonly runtimeEnv?: NodeJS.ProcessEnv | undefined;
  readonly scrubber: SecretScrubber;
  readonly nowMs?: number | undefined;
}

const MS_PER_DAY = 24 * 60 * 60 * 1000;
const MEMORY_PUBLICATION_RECEIPT_FILE = 'memory-publication.json';
const MAX_RECEIPT_BYTES = 65_536;
const MAX_MANAGED_MEMORY_FILES = 2_049;
const MAX_MEMORY_INDEX_BLOB_BYTES = MAX_MEMORY_INDEX_FILE_BYTES;
const MAX_MEMORY_ENTRY_BLOB_BYTES = MAX_MEMORY_ENTRY_FILE_BYTES;

function buildMemoryProtectedPaths(
  manifest: TaskpackManifest,
  controlRoot: string,
  manifestPath: string | undefined,
): { readonly protectedPaths: readonly string[]; readonly compilerAutoMemoryProtected: readonly string[] } {
  const userProtectedPatterns = compileScopePatterns(manifest.spec.scope.protected, 'protected');
  const userProtectedSet = new Set<string>(userProtectedPatterns);
  const declaredCommandScripts = manifest.spec.verification.localChecks.flatMap(check =>
    check.implementation === 'command.v1' && typeof check.parameters?.['script'] === 'string' && check.parameters['script'].length > 0
      ? [check.parameters['script']]
      : [],
  );
  const protectedPaths = [
    ...new Set([
      '.github',
      '.github/**',
      ...PROTECTED_AUTOMATION_PATHS.flatMap(entry => [entry, `${entry}/**`]),
      `${controlRoot}/policies`,
      `${controlRoot}/policies/**`,
      `${controlRoot}/checks`,
      `${controlRoot}/checks/**`,
      `${controlRoot}/taskpack.yaml`,
      `${controlRoot}/taskpack.yml`,
      `${controlRoot}/taskpack.json`,
      ...(manifestPath !== undefined ? [manifestPath] : []),
      ...(manifest.spec.instructions ?? []),
      ...declaredCommandScripts,
      ...userProtectedPatterns,
    ]),
  ];
  const compilerAutoMemoryProtected = [
    `${controlRoot}/**`,
    `${controlRoot}/memory/**`,
    `${manifest.spec.memory.directory}/**`,
  ].filter(pattern => !userProtectedSet.has(pattern));
  return { protectedPaths, compilerAutoMemoryProtected };
}

interface PerRunMemoryReceipt {
  readonly version: 1;
  readonly state: 'uncertain' | 'completed';
  readonly status: 'published' | 'updated' | 'reconcile_required';
  readonly repository: string;
  readonly taskpack: string;
  readonly targetBranch: string;
  readonly directory: string;
  readonly proposalId: string;
  readonly entryCount: number;
  readonly rebased: boolean;
  readonly branchName: string;
  readonly headOid: string;
  readonly pullRequestUrl: string | null;
  readonly pullRequestNumber: number | null;
  readonly reason: string | null;
  readonly updatedAtMs: number;
}

async function resolveSafeRunDirectory(
  runRoot: string,
  runId: string,
  createIfMissing: boolean,
): Promise<string | null> {
  if (!CONTROLLER_ID_PATTERN.test(runId) || runId.length > 128) {
    throw new GitHubAppError('ACTION_INPUT_INVALID', `invalid runId "${runId}" for memory publication receipt`);
  }
  const absRoot = resolve(runRoot);
  const rootStats = await lstat(absRoot).catch((err: NodeJS.ErrnoException) => {
    if (err.code === 'ENOENT') return null;
    throw err;
  });
  if (rootStats === null) {
    if (!createIfMissing) return null;
    await mkdir(absRoot, { recursive: true, mode: 0o700 });
  } else if (rootStats.isSymbolicLink() || !rootStats.isDirectory()) {
    throw new GitHubAppError('ACTION_INPUT_INVALID', 'runRoot must be a non-symlink directory');
  }
  const runDir = join(absRoot, runId);
  const runStats = await lstat(runDir).catch((err: NodeJS.ErrnoException) => {
    if (err.code === 'ENOENT') return null;
    throw err;
  });
  if (runStats === null) {
    if (!createIfMissing) return null;
    await mkdir(runDir, { mode: 0o700 });
    return runDir;
  }
  if (runStats.isSymbolicLink() || !runStats.isDirectory()) {
    throw new GitHubAppError('ACTION_INPUT_INVALID', 'run directory must be a non-symlink directory');
  }
  return runDir;
}

async function readRegularJsonBounded(
  filePath: string,
  maxBytes: number,
  label: string,
): Promise<{ readonly exists: false } | { readonly exists: true; readonly value: unknown }> {
  const handle = await open(
    filePath,
    fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | (fsConstants.O_NONBLOCK ?? 0),
  ).catch(
    (err: NodeJS.ErrnoException) => {
      if (err.code === 'ENOENT') return null;
      throw new GitHubAppError('ACTION_INPUT_INVALID', `unable to open ${label}: ${err.code ?? err.message}`);
    },
  );
  if (handle === null) return { exists: false };
  try {
    const st = await handle.stat();
    if (!st.isFile()) {
      throw new GitHubAppError('ACTION_INPUT_INVALID', `${label} is not a regular file`);
    }
    if (st.size === 0 || st.size > maxBytes) {
      throw new GitHubAppError('ACTION_INPUT_INVALID', `corrupt ${label}; manual reconciliation required`);
    }
    const buf = Buffer.alloc(st.size);
    let offset = 0;
    while (offset < st.size) {
      const { bytesRead } = await handle.read(buf, offset, st.size - offset, offset);
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    try {
      return { exists: true, value: JSON.parse(buf.subarray(0, offset).toString('utf8')) };
    } catch {
      throw new GitHubAppError('ACTION_INPUT_INVALID', `corrupt ${label}; manual reconciliation required`);
    }
  } finally {
    await handle.close();
  }
}

function parsePerRunMemoryReceipt(parsed: unknown): PerRunMemoryReceipt {
  if (!isPlainRecord(parsed) || parsed['version'] !== 1) {
    throw new GitHubAppError('ACTION_INPUT_INVALID', 'corrupt memory publication receipt; manual reconciliation required');
  }
  const state = parsed['state'];
  const status = parsed['status'];
  const repository = parsed['repository'];
  const taskpack = parsed['taskpack'];
  const targetBranch = parsed['targetBranch'];
  const directory = parsed['directory'];
  const proposalId = parsed['proposalId'];
  const entryCount = parsed['entryCount'];
  const rebased = parsed['rebased'];
  const branchName = parsed['branchName'];
  const headOid = parsed['headOid'];
  const pullRequestUrl = parsed['pullRequestUrl'];
  const pullRequestNumber = parsed['pullRequestNumber'];
  const reason = parsed['reason'];
  const updatedAtMs = parsed['updatedAtMs'];

  if (
    (state !== 'uncertain' && state !== 'completed')
    || (status !== 'published' && status !== 'updated' && status !== 'reconcile_required')
    || typeof repository !== 'string' || repository.length === 0
    || typeof taskpack !== 'string' || taskpack.length === 0
    || typeof targetBranch !== 'string' || targetBranch.length === 0
    || typeof directory !== 'string' || directory.length === 0
    || typeof proposalId !== 'string' || proposalId.length === 0
    || typeof entryCount !== 'number' || !Number.isSafeInteger(entryCount) || entryCount < 0
    || typeof rebased !== 'boolean'
    || typeof branchName !== 'string' || branchName.length === 0
    || typeof headOid !== 'string' || !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i.test(headOid)
    || (pullRequestUrl !== null && typeof pullRequestUrl !== 'string')
    || (pullRequestNumber !== null && (typeof pullRequestNumber !== 'number' || !Number.isSafeInteger(pullRequestNumber) || pullRequestNumber <= 0))
    || (reason !== null && typeof reason !== 'string')
    || typeof updatedAtMs !== 'number' || !Number.isFinite(updatedAtMs)
  ) {
    throw new GitHubAppError('ACTION_INPUT_INVALID', 'corrupt memory publication receipt; manual reconciliation required');
  }
  if (state === 'completed' && (status === 'reconcile_required' || pullRequestUrl === null || pullRequestNumber === null)) {
    throw new GitHubAppError('ACTION_INPUT_INVALID', 'corrupt completed memory publication receipt; manual reconciliation required');
  }

  return {
    version: 1,
    state,
    status,
    repository,
    taskpack,
    targetBranch,
    directory,
    proposalId,
    entryCount,
    rebased,
    branchName,
    headOid: headOid.toLowerCase(),
    pullRequestUrl,
    pullRequestNumber,
    reason,
    updatedAtMs,
  };
}

function serializeScrubbedReceipt(receipt: PerRunMemoryReceipt, scrubber: SecretScrubber): Buffer {
  const sanitized: PerRunMemoryReceipt = {
    ...receipt,
    pullRequestUrl: receipt.pullRequestUrl !== null ? scrubber.scrub(receipt.pullRequestUrl) : null,
    reason: receipt.reason !== null
      ? truncateCodePoints(
        sanitizeReportText(receipt.reason, { scrub: text => scrubber.scrub(text), singleLine: true }),
        MAX_REASON_CODEPOINTS,
      )
      : null,
  };
  const bytes = Buffer.from(`${JSON.stringify(sanitized, null, 2)}\n`, 'utf8');
  assertCleanArtifact(bytes, scrubber, `/${MEMORY_PUBLICATION_RECEIPT_FILE}`);
  return bytes;
}

async function readPerRunMemoryReceipt(runRoot: string, runId: string): Promise<PerRunMemoryReceipt | null> {
  const runDir = await resolveSafeRunDirectory(runRoot, runId, false);
  if (runDir === null) return null;
  const raw = await readRegularJsonBounded(join(runDir, MEMORY_PUBLICATION_RECEIPT_FILE), MAX_RECEIPT_BYTES, 'memory publication receipt');
  return raw.exists ? parsePerRunMemoryReceipt(raw.value) : null;
}

async function claimPerRunMemoryReceipt(
  runRoot: string,
  runId: string,
  receipt: PerRunMemoryReceipt,
  scrubber: SecretScrubber,
): Promise<{ readonly claimed: true; readonly runDir: string } | { readonly claimed: false }> {
  const runDir = await resolveSafeRunDirectory(runRoot, runId, true);
  if (runDir === null) {
    throw new GitHubAppError('ACTION_INPUT_INVALID', 'unable to resolve run directory for memory publication receipt');
  }
  const receiptPath = join(runDir, MEMORY_PUBLICATION_RECEIPT_FILE);
  const payload = serializeScrubbedReceipt(receipt, scrubber);
  let handle;
  try {
    handle = await open(
      receiptPath,
      fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW,
      0o600,
    );
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') {
      return { claimed: false };
    }
    throw err;
  }
  try {
    await handle.writeFile(payload);
    await handle.sync();
  } catch (err) {
    await handle.close().catch(() => undefined);
    await unlink(receiptPath).catch(() => undefined);
    throw err;
  }
  await handle.close();
  return { claimed: true, runDir };
}

async function updatePerRunMemoryReceipt(
  runDir: string,
  receipt: PerRunMemoryReceipt,
  scrubber: SecretScrubber,
): Promise<void> {
  const receiptPath = join(runDir, MEMORY_PUBLICATION_RECEIPT_FILE);
  const tempPath = `${receiptPath}.tmp.${randomBytes(6).toString('hex')}`;
  const payload = serializeScrubbedReceipt(receipt, scrubber);
  const handle = await open(
    tempPath,
    fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW,
    0o600,
  );
  try {
    await handle.writeFile(payload);
    await handle.sync();
  } catch (err) {
    await handle.close().catch(() => undefined);
    await unlink(tempPath).catch(() => undefined);
    throw err;
  }
  await handle.close();
  await rename(tempPath, receiptPath);
}

function validateReceiptBindings(
  receipt: PerRunMemoryReceipt,
  expected: {
    readonly repositoryFullName: string;
    readonly taskpack: string;
    readonly targetBranch: string;
    readonly memoryDirectory: string;
    readonly memoryBranch: string;
  },
): string | null {
  if (receipt.repository.toLowerCase() !== expected.repositoryFullName.toLowerCase()) {
    return `MEMORY_SCOPE_VIOLATION: retained memory receipt repository "${receipt.repository}" does not match "${expected.repositoryFullName}"`;
  }
  if (receipt.taskpack !== expected.taskpack) {
    return `MEMORY_SCOPE_VIOLATION: retained memory receipt taskpack "${receipt.taskpack}" does not match "${expected.taskpack}"`;
  }
  if (receipt.targetBranch !== expected.targetBranch) {
    return `MEMORY_SCOPE_VIOLATION: retained memory receipt targetBranch "${receipt.targetBranch}" does not match "${expected.targetBranch}"`;
  }
  if (receipt.directory !== expected.memoryDirectory) {
    return `MEMORY_SCOPE_VIOLATION: retained memory receipt directory "${receipt.directory}" does not match "${expected.memoryDirectory}"`;
  }
  if (receipt.branchName !== expected.memoryBranch) {
    return `MEMORY_SCOPE_VIOLATION: retained memory receipt branchName "${receipt.branchName}" does not match "${expected.memoryBranch}"`;
  }
  return null;
}

async function extractOpenMemoryManagedFiles(
  cloneDir: string,
  revision: string,
  taskpack: string,
  memoryRoot: string,
  memoryDirectory: string,
  cleanGitEnv: Record<string, string>,
): Promise<readonly { readonly path: string; readonly bytes: Buffer }[]> {
  const memTree = await listTreeEntriesAtRevision(cloneDir, revision, cleanGitEnv);
  if (hasSymlinkAtOrAbove(memoryDirectory, memTree, memTree)) {
    throw new GitHubAppError('TASKPACK_SCOPE_VIOLATION', `open memory branch contains symlink at or above "${memoryDirectory}"`);
  }
  const managedEntries = [...memTree.entries()].filter(([path]) => isMemoryManagedPath(taskpack, path, memoryRoot));
  if (managedEntries.length === 0 || managedEntries.length > MAX_MANAGED_MEMORY_FILES) {
    throw new GitHubAppError(
      'ACTION_INPUT_INVALID',
      `open memory branch carries an invalid managed file count (${managedEntries.length})`,
    );
  }
  const indexRelPath = `${memoryDirectory}/index.json`;
  const files: Array<{ readonly path: string; readonly bytes: Buffer }> = [];
  for (const [path, entry] of managedEntries) {
    if (entry.type !== 'blob' || entry.mode !== '100644' || hasSymlinkAtOrAbove(path, memTree, memTree)) {
      throw new GitHubAppError('TASKPACK_SCOPE_VIOLATION', `open memory branch carries unsafe entry "${path}"`);
    }
    const maxBlobBytes = path === indexRelPath ? MAX_MEMORY_INDEX_BLOB_BYTES : MAX_MEMORY_ENTRY_BLOB_BYTES;
    const bytes = await execGit(
      cloneDir,
      ['cat-file', 'blob', entry.oid],
      { env: cleanGitEnv, maxStdoutBytes: maxBlobBytes, timeoutMs: 15_000 },
    );
    files.push({ path, bytes });
  }
  return files;
}

async function materializeMemoryFilesInClone(
  cloneDir: string,
  memoryDirectory: string,
  files: readonly { readonly path: string; readonly bytes: Buffer }[],
): Promise<void> {
  await rm(join(cloneDir, memoryDirectory), { recursive: true, force: true });
  await mkdir(join(cloneDir, memoryDirectory, 'entries'), { recursive: true, mode: 0o700 });
  for (const file of files) {
    await mkdir(dirname(join(cloneDir, file.path)), { recursive: true, mode: 0o700 });
    await writeFile(join(cloneDir, file.path), file.bytes, { mode: 0o600 });
  }
}

async function isSquashOrRebaseMergedMemoryBranch(options: {
  readonly cloneDir: string;
  readonly baseRevision: string;
  readonly currentTargetTip: string;
  readonly pinnedRemoteMemoryOid: string;
  readonly remoteRef: string;
  readonly taskpack: string;
  readonly repositoryFullName: string;
  readonly memoryRoot: string;
  readonly memoryDirectory: string;
  readonly cleanGitEnv: Record<string, string>;
}): Promise<boolean> {
  const {
    cloneDir,
    baseRevision,
    currentTargetTip,
    pinnedRemoteMemoryOid,
    remoteRef,
    taskpack,
    repositoryFullName,
    memoryRoot,
    memoryDirectory,
    cleanGitEnv,
  } = options;
  const branchBaseOid = await execGit(
    cloneDir,
    ['merge-base', pinnedRemoteMemoryOid, currentTargetTip],
    { env: cleanGitEnv, timeoutMs: 5_000 },
  ).then(buf => buf.toString('utf8').trim().toLowerCase(), () => '');
  if (!COMMIT_SHA_PATTERN.test(branchBaseOid)) {
    return false;
  }
  const diffRaw = await execGit(
    cloneDir,
    ['diff', '--name-only', branchBaseOid, pinnedRemoteMemoryOid, '--'],
    { env: cleanGitEnv, timeoutMs: 10_000 },
  ).then(buf => buf.toString('utf8'), () => '');
  const diffPaths = diffRaw.split('\n').map(line => line.trim()).filter(Boolean);
  if (diffPaths.length === 0 || diffPaths.some(path => !isMemoryManagedPath(taskpack, path, memoryRoot))) {
    return false;
  }
  try {
    await execGit(cloneDir, ['reset', '--hard', branchBaseOid], { env: cleanGitEnv, timeoutMs: 15_000 });
    await execGit(cloneDir, ['clean', '-fdx'], { env: cleanGitEnv, timeoutMs: 15_000 });
    const branchBaseStore = (await loadMemoryStore(cloneDir, taskpack, repositoryFullName, memoryRoot)).index;

    await execGit(cloneDir, ['reset', '--hard', currentTargetTip], { env: cleanGitEnv, timeoutMs: 15_000 });
    await execGit(cloneDir, ['clean', '-fdx'], { env: cleanGitEnv, timeoutMs: 15_000 });
    const targetTipStore = (await loadMemoryStore(cloneDir, taskpack, repositoryFullName, memoryRoot)).index;

    const remoteFiles = await extractOpenMemoryManagedFiles(
      cloneDir,
      remoteRef,
      taskpack,
      memoryRoot,
      memoryDirectory,
      cleanGitEnv,
    );
    await materializeMemoryFilesInClone(cloneDir, memoryDirectory, remoteFiles);
    const remoteMemStore = (await loadMemoryStore(cloneDir, taskpack, repositoryFullName, memoryRoot)).index;

    if (digestEqual(remoteMemStore.storeDigest, targetTipStore.storeDigest)) {
      return true;
    }
    if (
      remoteMemStore.entries.length === 0
      && remoteMemStore.retired.length === 0
      && branchBaseStore.entries.length === 0
      && branchBaseStore.retired.length === 0
    ) {
      return false;
    }

    const entriesEqual = (candidate: MemoryEntry | undefined, expected: MemoryEntry): boolean =>
      candidate !== undefined && canonicalMemory(candidate) === canonicalMemory(expected);

    const branchBaseById = new Map<string, (typeof branchBaseStore.entries)[number]>();
    for (const entry of branchBaseStore.entries) {
      branchBaseById.set(entry.id, entry);
    }
    const branchBaseRetiredById = new Map<string, (typeof branchBaseStore.retired)[number]>();
    for (const row of branchBaseStore.retired) {
      branchBaseRetiredById.set(row.entry.id, row);
    }
    const targetCurrentById = new Map<string, (typeof targetTipStore.entries)[number]>();
    for (const entry of targetTipStore.entries) {
      targetCurrentById.set(entry.id, entry);
    }
    const targetRetiredById = new Map<string, (typeof targetTipStore.retired)[number]>();
    for (const row of targetTipStore.retired) {
      targetRetiredById.set(row.entry.id, row);
    }
    const remoteCurrentById = new Map<string, (typeof remoteMemStore.entries)[number]>();
    for (const entry of remoteMemStore.entries) {
      remoteCurrentById.set(entry.id, entry);
    }

    let hasRemoteChanges = false;

    for (const entry of remoteMemStore.entries) {
      if (entriesEqual(branchBaseById.get(entry.id), entry)) {
        continue;
      }
      hasRemoteChanges = true;
      const exactActiveOnTarget = entriesEqual(targetCurrentById.get(entry.id), entry);
      const targetRetired = targetRetiredById.get(entry.id);
      const landedThenRetiredOnTarget =
        entriesEqual(targetRetired?.entry, entry)
        && !entriesEqual(branchBaseRetiredById.get(entry.id)?.entry, entry);
      if (!exactActiveOnTarget && !landedThenRetiredOnTarget) {
        return false;
      }
    }

    // Check entries deleted on remoteMemStore relative to branchBaseStore (direct deletion on retire/eviction).
    for (const baseEntry of branchBaseStore.entries) {
      if (remoteCurrentById.has(baseEntry.id)) continue;
      hasRemoteChanges = true;
      if (entriesEqual(targetCurrentById.get(baseEntry.id), baseEntry)) {
        return false;
      }
    }

    // Preserve legacy index.retired verification for pre-compaction memory branches.
    for (const row of remoteMemStore.retired) {
      const priorRetired = branchBaseRetiredById.get(row.entry.id);
      if (priorRetired !== undefined && canonicalMemory(priorRetired) === canonicalMemory(row)) {
        continue;
      }
      hasRemoteChanges = true;
      if (entriesEqual(targetCurrentById.get(row.entry.id), row.entry)) {
        return false;
      }
      const landedRetired = targetRetiredById.get(row.entry.id);
      if (landedRetired !== undefined) {
        const exactRetiredRecordMatch = canonicalMemory(landedRetired) === canonicalMemory(row);
        const remoteReplacement = remoteCurrentById.get(row.entry.id);
        const replacementLaterRetiredOnTarget =
          remoteReplacement !== undefined && entriesEqual(landedRetired.entry, remoteReplacement);
        if (!exactRetiredRecordMatch && !replacementLaterRetiredOnTarget) {
          return false;
        }
      } else if (targetTipStore.retired.length > 0) {
        return false;
      }
    }

    // Check legacy index.retired compaction (purging retired rows to []).
    if (branchBaseStore.retired.length > 0 && remoteMemStore.retired.length === 0) {
      hasRemoteChanges = true;
      if (targetTipStore.retired.length > 0) {
        return false;
      }
    }

    return hasRemoteChanges;
  } catch {
    return false;
  } finally {
    await execGit(cloneDir, ['reset', '--hard', baseRevision], { env: cleanGitEnv, timeoutMs: 15_000 }).catch(() => undefined);
    await execGit(cloneDir, ['clean', '-fdx'], { env: cleanGitEnv, timeoutMs: 15_000 }).catch(() => undefined);
  }
}

function validateMemoryPullRequestApiResponse(
  parsedPr: unknown,
  expected: {
    readonly repositoryFullName: string;
    readonly targetBranch: string;
    readonly memoryBranch: string;
    readonly headOid: string;
    readonly existingPrNumber: number | null;
    readonly scrubber: SecretScrubber;
  },
):
  | { readonly ok: true; readonly prNumber: number; readonly prUrl: string }
  | {
    readonly ok: false;
    readonly canConfirmViaReadOnlyGet: boolean;
    readonly prNumber: number | null;
    readonly prUrl: string | null;
    readonly reason: string;
  } {
  if (!isPlainRecord(parsedPr)) {
    return {
      ok: false,
      canConfirmViaReadOnlyGet: false,
      prNumber: null,
      prUrl: null,
      reason: 'memory pull request API returned a 2xx response without a valid JSON object',
    };
  }
  const prUrl = typeof parsedPr['html_url'] === 'string' && parsedPr['html_url'].trim().length > 0
    ? expected.scrubber.scrub(parsedPr['html_url'].trim())
    : null;
  const prNumber = typeof parsedPr['number'] === 'number'
    && Number.isSafeInteger(parsedPr['number'])
    && parsedPr['number'] > 0
    ? parsedPr['number']
    : null;
  if (prUrl === null || prNumber === null) {
    return {
      ok: false,
      canConfirmViaReadOnlyGet: false,
      prNumber: null,
      prUrl: null,
      reason: 'memory pull request API returned a 2xx response without valid JSON number and html_url',
    };
  }
  if (expected.existingPrNumber !== null && prNumber !== expected.existingPrNumber) {
    return {
      ok: false,
      canConfirmViaReadOnlyGet: false,
      prNumber,
      prUrl,
      reason: `memory pull request API returned unexpected PR number #${prNumber} (expected #${expected.existingPrNumber})`,
    };
  }
  if (parsedPr['state'] !== 'open') {
    return {
      ok: false,
      canConfirmViaReadOnlyGet: false,
      prNumber,
      prUrl,
      reason: `memory pull request API returned non-open PR state "${String(parsedPr['state'] ?? '')}"`,
    };
  }
  const head = isPlainRecord(parsedPr['head']) ? parsedPr['head'] : null;
  const base = isPlainRecord(parsedPr['base']) ? parsedPr['base'] : null;
  const headRepo = head !== null && isPlainRecord(head['repo']) ? head['repo'] : null;
  const baseRepo = base !== null && isPlainRecord(base['repo']) ? base['repo'] : null;
  const expectedRepoLower = expected.repositoryFullName.toLowerCase();

  if (
    head === null
    || head['ref'] !== expected.memoryBranch
    || headRepo === null
    || typeof headRepo['full_name'] !== 'string'
    || headRepo['full_name'].toLowerCase() !== expectedRepoLower
  ) {
    return {
      ok: false,
      canConfirmViaReadOnlyGet: false,
      prNumber,
      prUrl,
      reason: `memory pull request API response head binding did not match "${expected.repositoryFullName}:${expected.memoryBranch}"`,
    };
  }
  if (
    base === null
    || base['ref'] !== expected.targetBranch
    || baseRepo === null
    || typeof baseRepo['full_name'] !== 'string'
    || baseRepo['full_name'].toLowerCase() !== expectedRepoLower
  ) {
    return {
      ok: false,
      canConfirmViaReadOnlyGet: false,
      prNumber,
      prUrl,
      reason: `memory pull request API response base binding did not match "${expected.repositoryFullName}:${expected.targetBranch}"`,
    };
  }
  if (
    typeof headRepo['id'] === 'number'
    && typeof baseRepo['id'] === 'number'
    && headRepo['id'] !== baseRepo['id']
  ) {
    return {
      ok: false,
      canConfirmViaReadOnlyGet: false,
      prNumber,
      prUrl,
      reason: 'memory pull request API response head.repo.id did not match base.repo.id',
    };
  }
  if (typeof head['sha'] !== 'string' || !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i.test(head['sha'])) {
    return {
      ok: false,
      canConfirmViaReadOnlyGet: true,
      prNumber,
      prUrl,
      reason: 'memory pull request API response omitted a valid head.sha commit digest',
    };
  }
  if (head['sha'].toLowerCase() !== expected.headOid.toLowerCase()) {
    return {
      ok: false,
      canConfirmViaReadOnlyGet: true,
      prNumber,
      prUrl,
      reason: 'memory pull request API response head.sha did not match pushed memory commit',
    };
  }
  return { ok: true, prNumber, prUrl };
}

function validateRetainedSettledRunBindings(
  settled: Pick<ResolvedSettledCycleContext, 'lock' | 'result'> & { readonly incident?: ResolvedSettledCycleContext['incident'] },
  expected: {
    readonly runId: string;
    readonly repositoryFullName: string;
    readonly taskpack: string;
    readonly baseRevision: string;
  },
): string | null {
  if (settled.lock.spec.runId !== expected.runId) {
    return `MEMORY_SCOPE_VIOLATION: retained run lock runId "${settled.lock.spec.runId}" does not match "${expected.runId}"`;
  }
  const lockedTarget = settled.lock.spec.contract.spec.target;
  if (lockedTarget.repository !== expected.repositoryFullName) {
    return `MEMORY_SCOPE_VIOLATION: retained run repository "${lockedTarget.repository}" does not match publication repository "${expected.repositoryFullName}"`;
  }
  if (settled.lock.spec.contract.spec.taskpack !== expected.taskpack) {
    return `MEMORY_SCOPE_VIOLATION: retained run taskpack "${settled.lock.spec.contract.spec.taskpack}" does not match "${expected.taskpack}"`;
  }
  if (lockedTarget.baseRevision.toLowerCase() !== expected.baseRevision.toLowerCase()) {
    return `MEMORY_SCOPE_VIOLATION: retained run baseRevision "${lockedTarget.baseRevision}" does not match "${expected.baseRevision}"`;
  }
  if (settled.result !== null) {
    const subject = settled.result.spec.subject;
    if (
      subject.lockHash.hex !== settled.lock.spec.lockHash.hex
      || subject.contractHash.hex !== settled.lock.spec.contractHash.hex
      || subject.repository !== expected.repositoryFullName
      || subject.baseRevision.toLowerCase() !== expected.baseRevision.toLowerCase()
    ) {
      return 'MEMORY_SCOPE_VIOLATION: retained RunResult subject does not match retained TaskLock and publication target';
    }
  }
  if (settled.incident !== undefined && settled.incident !== null) {
    if (
      settled.incident.runId !== expected.runId
      || settled.incident.lockHash.algorithm !== settled.lock.spec.lockHash.algorithm
      || settled.incident.lockHash.hex !== settled.lock.spec.lockHash.hex
    ) {
      return 'MEMORY_SCOPE_VIOLATION: retained ControllerIncident does not match retained TaskLock';
    }
  }
  return null;
}

async function verifyRetainedRunDescriptorIfPresent(
  runRoot: string,
  expected: {
    readonly runId: string;
    readonly repositoryFullName: string;
    readonly taskpack: string;
    readonly baseRevision: string;
  },
): Promise<string | null> {
  const runDir = await resolveSafeRunDirectory(runRoot, expected.runId, false);
  if (runDir === null) return null;
  let rawRunJson: Awaited<ReturnType<typeof readRegularJsonBounded>>;
  try {
    rawRunJson = await readRegularJsonBounded(join(runDir, 'run.json'), 2 * 1024 * 1024, 'run.json');
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return `MEMORY_SCHEMA_INVALID: ${msg}`;
  }
  if (!rawRunJson.exists) return null;
  if (!isPlainRecord(rawRunJson.value) || !isPlainRecord(rawRunJson.value['identity'])) {
    return 'MEMORY_SCHEMA_INVALID: retained run.json carries no valid identity record';
  }
  const lockDoc = validateDocument(rawRunJson.value['identity']['lock'], 'TaskLock');
  if (!lockDoc.ok) {
    return 'MEMORY_SCHEMA_INVALID: retained run.json carries no valid TaskLock';
  }
  return validateRetainedSettledRunBindings({ lock: lockDoc.value, result: null }, expected);
}

interface ExpectedSettledRunBindings {
  readonly runId: string;
  readonly repositoryFullName: string;
  readonly taskpack: string;
  readonly baseRevision: string;
}

function scrubTurnkeyReason(raw: string, scrubber: SecretScrubber): string {
  return truncateCodePoints(
    sanitizeReportText(raw, { scrub: text => scrubber.scrub(text), singleLine: true }),
    MAX_REASON_CODEPOINTS,
  );
}

function buildEmptyMemorySummary(
  directory: string,
  status: TurnkeyMemorySummary['status'],
  reason: string | null,
  overrides?: Partial<TurnkeyMemorySummary>,
): TurnkeyMemorySummary {
  return Object.freeze({
    status,
    directory,
    proposalId: null,
    entryCount: 0,
    rebased: false,
    branchName: null,
    pullRequestUrl: null,
    pullRequestNumber: null,
    reason,
    ...overrides,
  });
}

async function verifyDescriptorAndBudgetSkip(options: {
  readonly runRoot: string;
  readonly runId: string;
  readonly repositoryRoot: string;
  readonly expectedBindings: ExpectedSettledRunBindings;
  readonly finalizerConfig: MemoryFinalizerConfig;
  readonly memoryDirectory: string;
  readonly scrubber: SecretScrubber;
}): Promise<TurnkeyMemorySummary | null> {
  const { runRoot, runId, repositoryRoot, expectedBindings, finalizerConfig, memoryDirectory, scrubber } = options;
  const earlyMismatch = await verifyRetainedRunDescriptorIfPresent(runRoot, expectedBindings);
  if (earlyMismatch !== null) {
    return buildEmptyMemorySummary(memoryDirectory, 'refused', scrubTurnkeyReason(earlyMismatch, scrubber));
  }
  if (finalizerConfig.onNoModelBudget === 'skip') {
    const skipped = await finalizeRunMemory({
      context: { kind: 'run_directory', runRoot, runId, repository: repositoryRoot },
      config: { ...finalizerConfig, onNoModelBudget: 'skip' },
    });
    return buildEmptyMemorySummary(
      memoryDirectory,
      'skipped',
      scrubber.scrub(skipped.reason ?? 'no_model_budget_skipped'),
    );
  }
  return null;
}

async function resolveVerifiedSettledRun(options: {
  readonly runRoot: string;
  readonly runId: string;
  readonly repository: string;
  readonly expectedBindings: ExpectedSettledRunBindings;
  readonly memoryDirectory: string;
  readonly scrubber: SecretScrubber;
}): Promise<
  | { readonly ok: true; readonly settled: ResolvedSettledCycleContext }
  | { readonly ok: false; readonly summary: TurnkeyMemorySummary }
> {
  const { runRoot, runId, repository, expectedBindings, memoryDirectory, scrubber } = options;
  const settled = await resolveSettledCycleContext({
    kind: 'run_directory',
    runRoot,
    runId,
    repository,
  });
  const bindingMismatch = validateRetainedSettledRunBindings(settled, expectedBindings);
  if (bindingMismatch !== null) {
    return {
      ok: false,
      summary: buildEmptyMemorySummary(memoryDirectory, 'refused', scrubTurnkeyReason(bindingMismatch, scrubber)),
    };
  }
  if (settled.result?.spec.status === 'reconcile_required') {
    return {
      ok: false,
      summary: buildEmptyMemorySummary(memoryDirectory, 'skipped', 'primary_run_reconcile_required'),
    };
  }
  return { ok: true, settled };
}

async function finalizeTurnkeyProposal(options: {
  readonly runRoot: string;
  readonly runId: string;
  readonly repository: string;
  readonly baseStore: MemoryStoreIndex;
  readonly finalizerConfig: MemoryFinalizerConfig;
  readonly memoryDirectory: string;
  readonly scrubber: SecretScrubber;
}): Promise<
  | { readonly ok: true; readonly proposal: MemoryProposal }
  | { readonly ok: false; readonly summary: TurnkeyMemorySummary; readonly proposal: MemoryProposal | null }
> {
  const { runRoot, runId, repository, baseStore, finalizerConfig, memoryDirectory, scrubber } = options;
  const finalized = await finalizeRunMemory({
    context: { kind: 'run_directory', runRoot, runId, repository },
    config: finalizerConfig,
  });
  if (finalized.status === 'unavailable' || finalized.proposal === null) {
    return {
      ok: false,
      proposal: null,
      summary: buildEmptyMemorySummary(
        memoryDirectory,
        'failed',
        scrubber.scrub(finalized.reason ?? 'memory finalization unavailable'),
      ),
    };
  }
  if (finalized.proposal.operations.length === 0 && baseStore.retired.length === 0) {
    return {
      ok: false,
      proposal: finalized.proposal,
      summary: buildEmptyMemorySummary(
        memoryDirectory,
        'no_entries',
        'no deterministic memory entries produced for this run',
        { proposalId: finalized.proposal.proposalId },
      ),
    };
  }
  return { ok: true, proposal: finalized.proposal };
}

async function applyAndValidateTurnkeyMemoryCAS(options: {
  readonly repository: string;
  readonly taskpack: string;
  readonly proposal: MemoryProposal;
  readonly settled: ResolvedSettledCycleContext;
  readonly scrubber: SecretScrubber;
  readonly manifest: TaskpackManifest;
  readonly controlRoot: string;
  readonly manifestPath: string | undefined;
  readonly memoryRoot: string;
  readonly memoryDirectory: string;
  readonly targetBranch: string;
  readonly currentRevision: string;
  readonly baseStore: MemoryStoreIndex;
  readonly nowMs: number;
  readonly maxEntries: number;
  readonly outsideScopeReason: string;
}): Promise<
  | { readonly ok: true; readonly rebased: boolean; readonly pullRequest: SeparateMemoryPullRequestSpec }
  | { readonly ok: false; readonly rebased: boolean; readonly summary: TurnkeyMemorySummary }
> {
  const {
    repository,
    taskpack,
    proposal,
    settled,
    scrubber,
    manifest,
    controlRoot,
    manifestPath,
    memoryRoot,
    memoryDirectory,
    targetBranch,
    currentRevision,
    baseStore,
    nowMs,
    maxEntries,
    outsideScopeReason,
  } = options;
  const { protectedPaths, compilerAutoMemoryProtected } = buildMemoryProtectedPaths(manifest, controlRoot, manifestPath);
  const casResult: MemoryCASResult = await applyMemoryProposalCAS({
    repository,
    taskpack,
    proposal,
    lock: settled.lock,
    result: settled.result,
    incident: settled.incident,
    evidence: settled.evidence,
    artifacts: settled.inventory,
    candidateDigest: settled.result?.spec.subject.candidateDigest ?? null,
    secretValues: scrubber.secretValues,
    memoryRoot,
    memoryWritable: [manifest.spec.memory.directory],
    protectedPaths,
    exemptContractProtectedPatterns: compilerAutoMemoryProtected,
    targetBranch,
    currentRevision,
    baseStore,
    allowRebase: true,
    nowMs,
    maxEntries,
  });
  if (!casResult.applied || casResult.pullRequest === null) {
    const diagText = casResult.refusal?.diagnostics
      .map(diag => `${diag.code} at ${diag.path}: ${diag.detail}`)
      .join('; ') ?? 'memory CAS refused proposal';
    return {
      ok: false,
      rebased: casResult.rebased,
      summary: buildEmptyMemorySummary(memoryDirectory, 'refused', scrubber.scrub(diagText), {
        proposalId: proposal.proposalId,
        rebased: casResult.rebased,
      }),
    };
  }
  if (
    casResult.pullRequest.excludesCodeCandidatePaths !== true
    || casResult.pullRequest.modifiedFiles.some(file => !isMemoryManagedPath(taskpack, file.path, memoryRoot))
  ) {
    return {
      ok: false,
      rebased: casResult.rebased,
      summary: buildEmptyMemorySummary(memoryDirectory, 'refused', outsideScopeReason, {
        proposalId: proposal.proposalId,
        rebased: casResult.rebased,
      }),
    };
  }
  if (casResult.pullRequest.modifiedFiles.length === 0) {
    return {
      ok: false,
      rebased: casResult.rebased,
      summary: buildEmptyMemorySummary(memoryDirectory, 'no_entries', 'memory store already matches proposed state', {
        proposalId: proposal.proposalId,
        rebased: casResult.rebased,
      }),
    };
  }
  return { ok: true, rebased: casResult.rebased, pullRequest: casResult.pullRequest };
}

/**
 * Fault-isolated post-settlement memory finalization, 5-gate CAS verification in an
 * isolated clone of `targetBranch`, and separate dedicated memory PR publication
 * (`loopwright/memory/<taskpack>/<targetBranch>`). Never mutates `repositoryRoot`,
 * `.git/worktrees`, primary `RunResult`, or the candidate PR branch.
 */
export async function finalizeAndPublishTurnkeyMemory(
  options: FinalizeAndPublishTurnkeyMemoryOptions,
): Promise<TurnkeyMemorySummary> {
  const scrubber = options.scrubber;
  const nowMs = options.nowMs ?? Date.now();
  let memoryDirectory = options.manifest.spec.memory.directory;
  let trackedProposalId: string | null = null;
  let trackedEntryCount = 0;
  let trackedRebased = false;
  let trackedBranchName: string | null = null;
  let trackedPrUrl: string | null = null;
  let trackedPrNumber: number | null = null;
  let mutationDispatched = false;

  try {
    const resolvedLocation = resolveTaskpackMemoryLocation(options.manifest, options.taskpackPath);
    const { controlRoot, memoryRoot } = resolvedLocation;
    memoryDirectory = resolvedLocation.memoryDirectory;
    const { manifestPath } = resolveManifestControlRoot(options.manifest, options.taskpackPath);
    const taskpack = options.manifest.metadata.name;
    const targetBranch = options.manifest.spec.publication.targetBranch;
    const memoryBranch = `loopwright/memory/${taskpack}/${targetBranch}`;
    const memoryApply = options.manifest.spec.memory.apply;
    const ttlDays = options.manifest.spec.memory.ttlDays ?? DEFAULT_MEMORY_TTL_DAYS;
    const ttlMs = ttlDays * MS_PER_DAY;
    const maxEntries = options.manifest.spec.memory.maxEntries ?? DEFAULT_MEMORY_MAX_ENTRIES;
    const checkCodeFingerprint = options.manifest.spec.memory.checkCodeFingerprint === true;
    const checkUpstreamVersions = options.manifest.spec.memory.checkUpstreamVersions === true;
    const targetMatrix = options.targetMatrix ?? null;

    if (memoryApply === 'disabled') {
      return buildEmptyMemorySummary(memoryDirectory, 'skipped', 'memory_apply_disabled');
    }

    if (!REPOSITORY_FULL_NAME_PATTERN.test(options.repositoryFullName)) {
      return buildEmptyMemorySummary(memoryDirectory, 'skipped', 'repositoryFullName is not an org/repo slug');
    }

    const expectedBindings: ExpectedSettledRunBindings = {
      runId: options.runId,
      repositoryFullName: options.repositoryFullName,
      taskpack,
      baseRevision: options.baseRevision,
    };
    const finalizerConfig: MemoryFinalizerConfig = {
      taskpack,
      memoryRoot,
      memoryWritable: [options.manifest.spec.memory.directory],
      onNoModelBudget: options.manifest.spec.memory.onNoModelBudget,
      curator: null,
      requireCuratorReview: false,
      nowMs,
      ttlMs,
      maxEntries,
      checkCodeFingerprint,
      checkUpstreamVersions,
      targetMatrix,
      upstreamVersions: buildUpstreamVersionsMap(options.upstreamRecords),
    };

    if (memoryApply === 'local-only') {
      const localBaseStore = (await loadMemoryStore(options.repositoryRoot, taskpack, options.repositoryFullName, memoryRoot)).index;
      const preSkip = await verifyDescriptorAndBudgetSkip({
        runRoot: options.runRoot,
        runId: options.runId,
        repositoryRoot: options.repositoryRoot,
        expectedBindings,
        finalizerConfig,
        memoryDirectory,
        scrubber,
      });
      if (preSkip !== null) return preSkip;

      const settledOutcome = await resolveVerifiedSettledRun({
        runRoot: options.runRoot,
        runId: options.runId,
        repository: options.repositoryRoot,
        expectedBindings,
        memoryDirectory,
        scrubber,
      });
      if (!settledOutcome.ok) return settledOutcome.summary;

      const finalizedOutcome = await finalizeTurnkeyProposal({
        runRoot: options.runRoot,
        runId: options.runId,
        repository: options.repositoryRoot,
        baseStore: localBaseStore,
        finalizerConfig,
        memoryDirectory,
        scrubber,
      });
      if (finalizedOutcome.proposal !== null) {
        trackedProposalId = finalizedOutcome.proposal.proposalId;
        trackedEntryCount = finalizedOutcome.proposal.operations.length;
      }
      if (!finalizedOutcome.ok) return finalizedOutcome.summary;

      const localCasOutcome = await applyAndValidateTurnkeyMemoryCAS({
        repository: options.repositoryRoot,
        taskpack,
        proposal: finalizedOutcome.proposal,
        settled: settledOutcome.settled,
        scrubber,
        manifest: options.manifest,
        controlRoot,
        manifestPath,
        memoryRoot,
        memoryDirectory,
        targetBranch,
        currentRevision: options.baseRevision,
        baseStore: localBaseStore,
        nowMs,
        maxEntries,
        outsideScopeReason: 'memory proposal touched paths outside the managed memory directory',
      });
      trackedRebased = localCasOutcome.rebased;
      if (!localCasOutcome.ok) return localCasOutcome.summary;

      return buildEmptyMemorySummary(memoryDirectory, 'local_only', null, {
        proposalId: finalizedOutcome.proposal.proposalId,
        entryCount: finalizedOutcome.proposal.operations.length,
        rebased: localCasOutcome.rebased,
      });
    }

    // 0. Check per-run publication receipt before any replay or external mutation.
    let existingReceipt: PerRunMemoryReceipt | null = null;
    try {
      existingReceipt = await readPerRunMemoryReceipt(options.runRoot, options.runId);
    } catch (receiptErr) {
      const msg = receiptErr instanceof Error ? receiptErr.message : String(receiptErr);
      return buildEmptyMemorySummary(memoryDirectory, 'reconcile_required', scrubTurnkeyReason(msg, scrubber), {
        branchName: memoryBranch,
      });
    }

    if (existingReceipt !== null) {
      if (existingReceipt.state === 'uncertain') {
        return Object.freeze({
          status: 'reconcile_required',
          directory: existingReceipt.directory,
          proposalId: existingReceipt.proposalId,
          entryCount: existingReceipt.entryCount,
          rebased: existingReceipt.rebased,
          branchName: existingReceipt.branchName,
          pullRequestUrl: existingReceipt.pullRequestUrl,
          pullRequestNumber: existingReceipt.pullRequestNumber,
          reason: existingReceipt.reason ?? 'memory publication outcome is uncertain from a prior attempt; reconcile before replaying',
        });
      }
      const retainedRunMismatch = await verifyRetainedRunDescriptorIfPresent(options.runRoot, expectedBindings);
      const bindingMismatchReason = validateReceiptBindings(existingReceipt, {
        repositoryFullName: options.repositoryFullName,
        taskpack,
        targetBranch,
        memoryDirectory,
        memoryBranch,
      }) ?? retainedRunMismatch;
      if (bindingMismatchReason !== null) {
        return Object.freeze({
          status: 'refused',
          directory: existingReceipt.directory,
          proposalId: existingReceipt.proposalId,
          entryCount: 0,
          rebased: existingReceipt.rebased,
          branchName: existingReceipt.branchName,
          pullRequestUrl: existingReceipt.pullRequestUrl,
          pullRequestNumber: existingReceipt.pullRequestNumber,
          reason: scrubTurnkeyReason(bindingMismatchReason, scrubber),
        });
      }
      return Object.freeze({
        status: existingReceipt.status === 'updated' ? 'updated' : 'published',
        directory: existingReceipt.directory,
        proposalId: existingReceipt.proposalId,
        entryCount: existingReceipt.entryCount,
        rebased: existingReceipt.rebased,
        branchName: existingReceipt.branchName,
        pullRequestUrl: existingReceipt.pullRequestUrl,
        pullRequestNumber: existingReceipt.pullRequestNumber,
        reason: null,
      });
    }

    // 1. Validate working-tree memory path segments on repositoryRoot before cloning so
    //    untracked or working-tree symlinks/case-aliases under custom memoryRoot are refused immediately.
    await loadMemoryStore(options.repositoryRoot, taskpack, options.repositoryFullName, memoryRoot);

    // 2. Verify retained run descriptor and respect manifest.spec.memory.onNoModelBudget === 'skip'.
    const preCloneSkip = await verifyDescriptorAndBudgetSkip({
      runRoot: options.runRoot,
      runId: options.runId,
      repositoryRoot: options.repositoryRoot,
      expectedBindings,
      finalizerConfig,
      memoryDirectory,
      scrubber,
    });
    if (preCloneSkip !== null) return preCloneSkip;

    if (!COMMIT_SHA_PATTERN.test(options.baseRevision)) {
      return buildEmptyMemorySummary(memoryDirectory, 'failed', 'baseRevision is not a 40-hex commit SHA');
    }

    const rawScratch = await mkdtemp(join(tmpdir(), 'loopwright-mem-'));
    await chmod(rawScratch, 0o700);
    const memoryScratch = await realpath(rawScratch);
    const cloneDir = join(memoryScratch, 'repo');
    const cleanGitEnv = buildCleanGitEnv();

    try {
      await execGit(
        memoryScratch,
        ['-c', 'protocol.file.allow=always', 'clone', '--shared', '--no-checkout', '--', options.repositoryRoot, cloneDir],
        { env: cleanGitEnv, timeoutMs: 25_000 },
      );
      await execGit(
        cloneDir,
        ['checkout', '--force', options.baseRevision, '--'],
        { env: cleanGitEnv, timeoutMs: 25_000 },
      );

      const settledPreOutcome = await resolveVerifiedSettledRun({
        runRoot: options.runRoot,
        runId: options.runId,
        repository: cloneDir,
        expectedBindings,
        memoryDirectory,
        scrubber,
      });
      if (!settledPreOutcome.ok) return settledPreOutcome.summary;
      const settledPre = settledPreOutcome.settled;
      const primaryRunSucceeded = settledPre.incident === null
        && settledPre.result !== null
        && (settledPre.result.spec.status === 'completed' || settledPre.result.spec.status === 'no_change');
      if (
        memoryApply === 'separate-pull-request'
        && options.manifest.spec.memory.publishOnFailure !== true
        && !primaryRunSucceeded
      ) {
        return buildEmptyMemorySummary(memoryDirectory, 'skipped', 'failure_publication_disabled');
      }

      const gitAuthEnv = buildGitAuthEnv(options.githubToken);
      let resolvedRemote: string | undefined = options.remoteUrl?.trim() || undefined;
      if (resolvedRemote === undefined) {
        const originUrl = await execGit(
          options.repositoryRoot,
          ['remote', 'get-url', '--', 'origin'],
          { env: cleanGitEnv, timeoutMs: 5_000 },
        ).then(buf => buf.toString('utf8').trim(), () => '');
        if (originUrl.length > 0) {
          resolvedRemote = originUrl;
        }
      }

      const memoryBranchSafe = SAFE_BRANCH_PATTERN.test(memoryBranch) && !memoryBranch.includes('..') && !memoryBranch.startsWith('-');
      const targetBranchSafe = SAFE_BRANCH_PATTERN.test(targetBranch) && !targetBranch.includes('..') && !targetBranch.startsWith('-');
      const apiBaseUrl = (options.apiBaseUrl?.trim() || options.runtimeEnv?.['GITHUB_API_URL']?.trim() || '').replace(/\/+$/, '');
      const hasGitHubCredentials = typeof options.githubToken === 'string' && options.githubToken.trim().length > 0;
      const publicationModeEnabled = options.manifest.spec.publication.mode === 'pull_request'
        && options.manifest.spec.memory.apply === 'separate-pull-request';
      const remotePublicationRequested = publicationModeEnabled && apiBaseUrl.length > 0 && hasGitHubCredentials;

      let protocolArgs: readonly string[] = ['-c', 'protocol.ext.allow=never', '-c', 'protocol.ssh.allow=never'];
      if (resolvedRemote !== undefined) {
        try {
          const remoteKind = validateGitRemoteSource(resolvedRemote);
          protocolArgs = remoteKind === 'local-dir'
            ? ['-c', 'protocol.file.allow=always', '-c', 'protocol.ext.allow=never', '-c', 'protocol.ssh.allow=never']
            : ['-c', 'protocol.ext.allow=never', '-c', 'protocol.ssh.allow=never'];
        } catch (remoteErr) {
          if (remotePublicationRequested) {
            const detail = remoteErr instanceof Error ? remoteErr.message : String(remoteErr);
            return Object.freeze({
              status: 'failed',
              directory: memoryDirectory,
              proposalId: null,
              entryCount: 0,
              rebased: false,
              branchName: null,
              pullRequestUrl: null,
              pullRequestNumber: null,
              reason: truncateCodePoints(
                sanitizeReportText(detail, { scrub: text => scrubber.scrub(text), singleLine: true }),
                MAX_REASON_CODEPOINTS,
              ),
            });
          }
          resolvedRemote = undefined;
        }
      }

      const canPublishRemote = remotePublicationRequested
        && memoryBranchSafe
        && resolvedRemote !== undefined;

      // Establish remote targetBranch tip before inspecting open memory PRs, pinning remote lease, or running CAS.
      // When publishing remotely, target-fetch failure MUST abort publication rather than silently falling back to baseRevision.
      let currentTargetTip = options.baseRevision;
      if (canPublishRemote && resolvedRemote !== undefined) {
        if (!targetBranchSafe) {
          return Object.freeze({
            status: 'failed',
            directory: memoryDirectory,
            proposalId: null,
            entryCount: 0,
            rebased: false,
            branchName: null,
            pullRequestUrl: null,
            pullRequestNumber: null,
            reason: `targetBranch "${targetBranch}" is not a safe git branch name`,
          });
        }
        const targetFetchRes = await execGitDetailed(
          cloneDir,
          [...protocolArgs, 'fetch', '--quiet', '--', resolvedRemote, `refs/heads/${targetBranch}:refs/remotes/target/tip`],
          { env: gitAuthEnv, timeoutMs: 15_000 },
        );
        if (
          targetFetchRes.spawnError !== null
          || targetFetchRes.stdoutOverflow
          || targetFetchRes.timedOut
          || targetFetchRes.signal !== null
          || targetFetchRes.code !== 0
        ) {
          const stderrText = targetFetchRes.stderr.toString('utf8').trim();
          return Object.freeze({
            status: 'failed',
            directory: memoryDirectory,
            proposalId: null,
            entryCount: 0,
            rebased: false,
            branchName: null,
            pullRequestUrl: null,
            pullRequestNumber: null,
            reason: truncateCodePoints(
              sanitizeReportText(
                `failed to fetch remote target branch "${targetBranch}" for memory CAS${stderrText.length > 0 ? `: ${stderrText}` : ''}`,
                { scrub: text => scrubber.scrub(text), singleLine: true },
              ),
              MAX_REASON_CODEPOINTS,
            ),
          });
        }
        const fetchedTip = (
          await execGit(cloneDir, ['rev-parse', '--verify', 'refs/remotes/target/tip^{commit}'], { env: cleanGitEnv, timeoutMs: 5_000 })
        ).toString('utf8').trim().toLowerCase();
        if (!COMMIT_SHA_PATTERN.test(fetchedTip)) {
          return Object.freeze({
            status: 'failed',
            directory: memoryDirectory,
            proposalId: null,
            entryCount: 0,
            rebased: false,
            branchName: null,
            pullRequestUrl: null,
            pullRequestNumber: null,
            reason: `remote target branch "${targetBranch}" did not resolve to a valid commit SHA`,
          });
        }
        currentTargetTip = fetchedTip;
      } else if (publicationModeEnabled && resolvedRemote !== undefined && targetBranchSafe) {
        const fetchedTip = await execGit(
          cloneDir,
          [...protocolArgs, 'fetch', '--quiet', '--', resolvedRemote, `refs/heads/${targetBranch}:refs/remotes/target/tip`],
          { env: gitAuthEnv, timeoutMs: 15_000 },
        ).then(
          async () => (await execGit(cloneDir, ['rev-parse', '--verify', 'refs/remotes/target/tip^{commit}'], { env: cleanGitEnv, timeoutMs: 5_000 })).toString('utf8').trim().toLowerCase(),
          () => '',
        );
        if (COMMIT_SHA_PATTERN.test(fetchedTip)) {
          currentTargetTip = fetchedTip;
        }
      }

      // Pin expected remote head OID ONCE before reading base store or running CAS.
      let openMemoryPr: ManagedPullRequestInfo | null = null;
      let expectedRemoteOid = '';
      let openMemoryManagedFiles: readonly { readonly path: string; readonly bytes: Buffer }[] | null = null;

      if (canPublishRemote && resolvedRemote !== undefined) {
        trackedBranchName = memoryBranch;
        const lsRemoteOut = (
          await execGit(
            cloneDir,
            [...protocolArgs, 'ls-remote', '--', resolvedRemote, `refs/heads/${memoryBranch}`],
            { env: gitAuthEnv, timeoutMs: 15_000 },
          )
        ).toString('utf8').trim();
        const pinnedRemoteMemoryOid = lsRemoteOut.length > 0
          ? (lsRemoteOut.split(/\s+/)[0] ?? '').toLowerCase()
          : '';
        if (pinnedRemoteMemoryOid.length > 0 && !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(pinnedRemoteMemoryOid)) {
          return Object.freeze({
            status: 'failed',
            directory: memoryDirectory,
            proposalId: null,
            entryCount: 0,
            rebased: false,
            branchName: memoryBranch,
            pullRequestUrl: null,
            pullRequestNumber: null,
            reason: `invalid remote OID for refs/heads/${memoryBranch}`,
          });
        }

        openMemoryPr = await findOpenMemoryPullRequest({
          apiBaseUrl,
          repositoryFullName: options.repositoryFullName,
          targetBranch,
          memoryBranch,
          githubToken: options.githubToken,
          fetchImpl: options.fetchImpl,
          scrubber,
          env: options.runtimeEnv,
        });
        trackedPrUrl = openMemoryPr?.htmlUrl ?? null;
        trackedPrNumber = openMemoryPr?.number ?? null;

        if (openMemoryPr !== null) {
          if (pinnedRemoteMemoryOid.length === 0) {
            return Object.freeze({
              status: 'refused',
              directory: memoryDirectory,
              proposalId: null,
              entryCount: 0,
              rebased: false,
              branchName: memoryBranch,
              pullRequestUrl: openMemoryPr.htmlUrl,
              pullRequestNumber: openMemoryPr.number,
              reason: `MEMORY_CAS_CONFLICT: open memory pull request #${openMemoryPr.number} branch "${memoryBranch}" is missing on remote`,
            });
          }
          if (
            openMemoryPr.headSha.length > 0
            && openMemoryPr.headSha !== '0'.repeat(40)
            && openMemoryPr.headSha.toLowerCase() !== pinnedRemoteMemoryOid
          ) {
            return Object.freeze({
              status: 'refused',
              directory: memoryDirectory,
              proposalId: null,
              entryCount: 0,
              rebased: false,
              branchName: memoryBranch,
              pullRequestUrl: openMemoryPr.htmlUrl,
              pullRequestNumber: openMemoryPr.number,
              reason: `MEMORY_CAS_CONFLICT: open memory pull request #${openMemoryPr.number} head moved concurrently`,
            });
          }

          await execGit(
            cloneDir,
            [...protocolArgs, 'fetch', '--quiet', '--', resolvedRemote, `refs/heads/${memoryBranch}:refs/remotes/memory/open`],
            { env: gitAuthEnv, timeoutMs: 15_000 },
          );
          const fetchedOpenOid = (
            await execGit(cloneDir, ['rev-parse', '--verify', 'refs/remotes/memory/open^{commit}'], { env: cleanGitEnv, timeoutMs: 5_000 })
          ).toString('utf8').trim().toLowerCase();
          if (fetchedOpenOid !== pinnedRemoteMemoryOid) {
            return Object.freeze({
              status: 'refused',
              directory: memoryDirectory,
              proposalId: null,
              entryCount: 0,
              rebased: false,
              branchName: memoryBranch,
              pullRequestUrl: openMemoryPr.htmlUrl,
              pullRequestNumber: openMemoryPr.number,
              reason: `MEMORY_CAS_CONFLICT: open memory branch "${memoryBranch}" moved while fetching`,
            });
          }
          expectedRemoteOid = pinnedRemoteMemoryOid;

          const baseRevStore = (await loadMemoryStore(cloneDir, taskpack, options.repositoryFullName, memoryRoot)).index;
          let targetTipStore = baseRevStore;
          if (currentTargetTip !== options.baseRevision) {
            await execGit(cloneDir, ['reset', '--hard', currentTargetTip], { env: cleanGitEnv, timeoutMs: 15_000 });
            await execGit(cloneDir, ['clean', '-fdx'], { env: cleanGitEnv, timeoutMs: 15_000 });
            targetTipStore = (await loadMemoryStore(cloneDir, taskpack, options.repositoryFullName, memoryRoot)).index;
            await execGit(cloneDir, ['reset', '--hard', options.baseRevision], { env: cleanGitEnv, timeoutMs: 15_000 });
            await execGit(cloneDir, ['clean', '-fdx'], { env: cleanGitEnv, timeoutMs: 15_000 });
          }

          let memPrParentStore = baseRevStore;
          const openParentOid = await execGit(
            cloneDir,
            ['rev-parse', '--verify', 'refs/remotes/memory/open^^{commit}'],
            { env: cleanGitEnv, timeoutMs: 5_000 },
          ).then(buf => buf.toString('utf8').trim().toLowerCase(), () => '');
          if (COMMIT_SHA_PATTERN.test(openParentOid) && openParentOid !== options.baseRevision) {
            await execGit(cloneDir, ['reset', '--hard', openParentOid], { env: cleanGitEnv, timeoutMs: 15_000 });
            await execGit(cloneDir, ['clean', '-fdx'], { env: cleanGitEnv, timeoutMs: 15_000 });
            memPrParentStore = (await loadMemoryStore(cloneDir, taskpack, options.repositoryFullName, memoryRoot)).index;
            await execGit(cloneDir, ['reset', '--hard', options.baseRevision], { env: cleanGitEnv, timeoutMs: 15_000 });
            await execGit(cloneDir, ['clean', '-fdx'], { env: cleanGitEnv, timeoutMs: 15_000 });
          }

          openMemoryManagedFiles = await extractOpenMemoryManagedFiles(
            cloneDir,
            'refs/remotes/memory/open',
            taskpack,
            memoryRoot,
            memoryDirectory,
            cleanGitEnv,
          );
          await materializeMemoryFilesInClone(cloneDir, memoryDirectory, openMemoryManagedFiles);
          const memPrStore = (await loadMemoryStore(cloneDir, taskpack, options.repositoryFullName, memoryRoot)).index;

          if (
            !digestEqual(memPrParentStore.storeDigest, targetTipStore.storeDigest)
            && !digestEqual(memPrStore.storeDigest, targetTipStore.storeDigest)
          ) {
            return Object.freeze({
              status: 'refused',
              directory: memoryDirectory,
              proposalId: null,
              entryCount: 0,
              rebased: false,
              branchName: memoryBranch,
              pullRequestUrl: openMemoryPr.htmlUrl,
              pullRequestNumber: openMemoryPr.number,
              reason: 'MEMORY_CAS_CONFLICT: target branch memory store diverged from open memory pull request; merge or rebase the open memory PR first',
            });
          }
        } else if (pinnedRemoteMemoryOid.length > 0) {
          await execGit(
            cloneDir,
            [...protocolArgs, 'fetch', '--quiet', '--', resolvedRemote, `refs/heads/${memoryBranch}:refs/remotes/memory/remote`],
            { env: gitAuthEnv, timeoutMs: 15_000 },
          );
          const fetchedRemoteOid = (
            await execGit(cloneDir, ['rev-parse', '--verify', 'refs/remotes/memory/remote^{commit}'], { env: cleanGitEnv, timeoutMs: 5_000 })
          ).toString('utf8').trim().toLowerCase();
          if (fetchedRemoteOid !== pinnedRemoteMemoryOid) {
            return Object.freeze({
              status: 'refused',
              directory: memoryDirectory,
              proposalId: null,
              entryCount: 0,
              rebased: false,
              branchName: memoryBranch,
              pullRequestUrl: null,
              pullRequestNumber: null,
              reason: `MEMORY_CAS_CONFLICT: remote memory branch "${memoryBranch}" moved while fetching`,
            });
          }

          const isAncestorOfTarget = await execGit(
            cloneDir,
            ['merge-base', '--is-ancestor', pinnedRemoteMemoryOid, currentTargetTip],
            { env: cleanGitEnv, timeoutMs: 5_000 },
          ).then(() => true, () => false);
          const isLandedInTarget = isAncestorOfTarget || await isSquashOrRebaseMergedMemoryBranch({
            cloneDir,
            baseRevision: options.baseRevision,
            currentTargetTip,
            pinnedRemoteMemoryOid,
            remoteRef: 'refs/remotes/memory/remote',
            taskpack,
            repositoryFullName: options.repositoryFullName,
            memoryRoot,
            memoryDirectory,
            cleanGitEnv,
          });
          if (!isLandedInTarget) {
            return Object.freeze({
              status: 'reconcile_required',
              directory: memoryDirectory,
              proposalId: null,
              entryCount: 0,
              rebased: false,
              branchName: memoryBranch,
              pullRequestUrl: null,
              pullRequestNumber: null,
              reason: `remote memory branch "${memoryBranch}" exists without an open pull request and is not merged into "${targetBranch}"; reconcile before publishing`,
            });
          }
          expectedRemoteOid = pinnedRemoteMemoryOid;
        }
      }

      const baseStore = (await loadMemoryStore(cloneDir, taskpack, options.repositoryFullName, memoryRoot)).index;
      const finalizedOutcome = await finalizeTurnkeyProposal({
        runRoot: options.runRoot,
        runId: options.runId,
        repository: cloneDir,
        baseStore,
        finalizerConfig,
        memoryDirectory,
        scrubber,
      });
      if (finalizedOutcome.proposal !== null) {
        trackedProposalId = finalizedOutcome.proposal.proposalId;
        trackedEntryCount = finalizedOutcome.proposal.operations.length;
      }
      if (!finalizedOutcome.ok) return finalizedOutcome.summary;
      const finalized = { proposal: finalizedOutcome.proposal };

      if (currentTargetTip !== options.baseRevision) {
        await execGit(cloneDir, ['reset', '--hard', currentTargetTip], { env: cleanGitEnv, timeoutMs: 15_000 });
        await execGit(cloneDir, ['clean', '-fdx'], { env: cleanGitEnv, timeoutMs: 15_000 });
        if (openMemoryManagedFiles !== null) {
          await materializeMemoryFilesInClone(cloneDir, memoryDirectory, openMemoryManagedFiles);
        }
      }

      const settled = await resolveSettledCycleContext({
        kind: 'run_directory',
        runRoot: options.runRoot,
        runId: options.runId,
        repository: cloneDir,
      });

      const casResult = await applyAndValidateTurnkeyMemoryCAS({
        repository: cloneDir,
        taskpack,
        proposal: finalized.proposal,
        settled,
        scrubber,
        manifest: options.manifest,
        controlRoot,
        manifestPath,
        memoryRoot,
        memoryDirectory,
        targetBranch,
        currentRevision: currentTargetTip,
        baseStore,
        nowMs,
        maxEntries,
        outsideScopeReason: 'memory pull request specification touched paths outside the managed memory directory',
      });
      trackedRebased = casResult.rebased;
      if (!casResult.ok) return casResult.summary;

      if (!memoryBranchSafe) {
        return Object.freeze({
          status: 'failed',
          directory: memoryDirectory,
          proposalId: finalized.proposal.proposalId,
          entryCount: finalized.proposal.operations.length,
          rebased: casResult.rebased,
          branchName: null,
          pullRequestUrl: null,
          pullRequestNumber: null,
          reason: `unsafe memory branch name "${memoryBranch}"`,
        });
      }

      if (options.manifest.spec.publication.mode !== 'pull_request') {
        return Object.freeze({
          status: 'local_only',
          directory: memoryDirectory,
          proposalId: finalized.proposal.proposalId,
          entryCount: finalized.proposal.operations.length,
          rebased: casResult.rebased,
          branchName: null,
          pullRequestUrl: null,
          pullRequestNumber: null,
          reason: 'publication.mode is disabled; remote memory branch writes skipped',
        });
      }

      if (
        options.manifest.spec.memory.apply !== 'separate-pull-request'
        || resolvedRemote === undefined
        || apiBaseUrl.length === 0
        || !hasGitHubCredentials
      ) {
        return Object.freeze({
          status: 'local_only',
          directory: memoryDirectory,
          proposalId: finalized.proposal.proposalId,
          entryCount: finalized.proposal.operations.length,
          rebased: casResult.rebased,
          branchName: memoryBranch,
          pullRequestUrl: null,
          pullRequestNumber: null,
          reason: 'GitHub credentials, API URL, or git remote unavailable for separate memory PR publication',
        });
      }

      const commitIdentity = options.gitCommitIdentity !== undefined
        ? validateGitCommitIdentity(options.gitCommitIdentity)
        : DEFAULT_GIT_COMMIT_IDENTITY;

      const memIndexFile = join(memoryScratch, 'mem-index');
      const gitClone = (
        args: readonly string[],
        extraOpts?: { readonly input?: Buffer | string | undefined; readonly timeoutMs?: number | undefined },
      ): Promise<Buffer> => execGit(cloneDir, args, { env: gitAuthEnv, ...extraOpts });
      const gitWithMemIndex = (
        args: readonly string[],
        extraOpts?: { readonly input?: Buffer | string | undefined; readonly timeoutMs?: number | undefined },
      ): Promise<Buffer> => execGit(cloneDir, args, { env: { ...gitAuthEnv, GIT_INDEX_FILE: memIndexFile }, ...extraOpts });

      const baseTreeOid = (
        await gitClone(['rev-parse', '--verify', '--end-of-options', `${currentTargetTip}^{tree}`])
      ).toString('utf8').trim();
      await gitWithMemIndex(['read-tree', `${currentTargetTip}^{tree}`]);
      const baseEntries = await listTreeEntriesAtRevision(cloneDir, currentTargetTip, cleanGitEnv);

      const existingBaseManagedPaths = [...baseEntries.keys()].filter(path => isMemoryManagedPath(taskpack, path, memoryRoot));
      for (const existingPath of existingBaseManagedPaths) {
        if (hasSymlinkAtOrAbove(existingPath, baseEntries, baseEntries)) {
          return Object.freeze({
            status: 'refused',
            directory: memoryDirectory,
            proposalId: finalized.proposal.proposalId,
            entryCount: 0,
            rebased: casResult.rebased,
            branchName: memoryBranch,
            pullRequestUrl: null,
            pullRequestNumber: null,
            reason: `refusing to overwrite symlinked memory path "${existingPath}"`,
          });
        }
      }
      await removePathsFromIndex(cloneDir, memIndexFile, existingBaseManagedPaths, gitAuthEnv);

      await loadMemoryStore(cloneDir, taskpack, options.repositoryFullName, memoryRoot);
      const postCasFiles: Array<{ readonly path: string; readonly bytes: Buffer }> = [];
      const indexRelPath = `${memoryDirectory}/index.json`;
      postCasFiles.push({ path: indexRelPath, bytes: await readFile(join(cloneDir, indexRelPath)) });
      const entriesDirAbs = join(cloneDir, memoryDirectory, 'entries');
      if (existsSync(entriesDirAbs)) {
        const entryDirents = (await readdir(entriesDirAbs, { withFileTypes: true }))
          .filter(dirent => dirent.isFile() && dirent.name.endsWith('.md'))
          .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
        for (const dirent of entryDirents) {
          const entryRelPath = `${memoryDirectory}/entries/${dirent.name}`;
          if (isMemoryManagedPath(taskpack, entryRelPath, memoryRoot)) {
            postCasFiles.push({ path: entryRelPath, bytes: await readFile(join(cloneDir, entryRelPath)) });
          }
        }
      }
      if (postCasFiles.length > MAX_MANAGED_MEMORY_FILES) {
        return Object.freeze({
          status: 'refused',
          directory: memoryDirectory,
          proposalId: finalized.proposal.proposalId,
          entryCount: 0,
          rebased: casResult.rebased,
          branchName: memoryBranch,
          pullRequestUrl: null,
          pullRequestNumber: null,
          reason: `managed memory file count (${postCasFiles.length}) exceeds supported ceiling (${MAX_MANAGED_MEMORY_FILES})`,
        });
      }

      const stagedMemoryEntries: Array<{ readonly path: string; readonly mode: '100644'; readonly oid: string }> = [];
      for (const file of postCasFiles) {
        const maxAllowedBytes = file.path === indexRelPath ? MAX_MEMORY_INDEX_BLOB_BYTES : MAX_MEMORY_ENTRY_BLOB_BYTES;
        if (file.bytes.byteLength > maxAllowedBytes) {
          return Object.freeze({
            status: 'refused',
            directory: memoryDirectory,
            proposalId: finalized.proposal.proposalId,
            entryCount: 0,
            rebased: casResult.rebased,
            branchName: memoryBranch,
            pullRequestUrl: null,
            pullRequestNumber: null,
            reason: `managed memory file "${file.path}" (${file.bytes.byteLength} bytes) exceeds supported ceiling (${maxAllowedBytes} bytes)`,
          });
        }
        if (hasSymlinkAtOrAbove(file.path, baseEntries, baseEntries)) {
          return Object.freeze({
            status: 'refused',
            directory: memoryDirectory,
            proposalId: finalized.proposal.proposalId,
            entryCount: 0,
            rebased: casResult.rebased,
            branchName: memoryBranch,
            pullRequestUrl: null,
            pullRequestNumber: null,
            reason: `refusing to overwrite symlinked memory path "${file.path}"`,
          });
        }
        assertCleanArtifact(file.bytes, scrubber, `/${file.path}`);
        const blobOid = (
          await gitClone(['hash-object', '-w', '--stdin'], { input: file.bytes })
        ).toString('utf8').trim();
        if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(blobOid)) {
          throw new GitHubAppError('ACTION_INPUT_INVALID', `git hash-object returned invalid oid for "${file.path}"`);
        }
        stagedMemoryEntries.push({ path: file.path, mode: '100644', oid: blobOid });
      }
      await stageEntriesInIndex(cloneDir, memIndexFile, stagedMemoryEntries, gitAuthEnv);

      const treeOid = (await gitWithMemIndex(['write-tree'])).toString('utf8').trim();
      if (treeOid === baseTreeOid) {
        return Object.freeze({
          status: 'no_entries',
          directory: memoryDirectory,
          proposalId: finalized.proposal.proposalId,
          entryCount: 0,
          rebased: casResult.rebased,
          branchName: memoryBranch,
          pullRequestUrl: openMemoryPr?.htmlUrl ?? null,
          pullRequestNumber: openMemoryPr?.number ?? null,
          reason: 'memory tree already matches target branch',
        });
      }

      if (openMemoryPr !== null) {
        const existingOpenTreeOid = (
          await gitClone(['rev-parse', '--verify', '--end-of-options', 'refs/remotes/memory/open^{tree}'])
        ).toString('utf8').trim();
        const existingOpenParentOid = await gitClone(
          ['rev-parse', '--verify', '--end-of-options', 'refs/remotes/memory/open^^{commit}'],
        ).then(buf => buf.toString('utf8').trim().toLowerCase(), () => '');
        if (treeOid === existingOpenTreeOid && existingOpenParentOid === currentTargetTip) {
          return Object.freeze({
            status: 'no_entries',
            directory: memoryDirectory,
            proposalId: finalized.proposal.proposalId,
            entryCount: 0,
            rebased: casResult.rebased,
            branchName: memoryBranch,
            pullRequestUrl: openMemoryPr.htmlUrl,
            pullRequestNumber: openMemoryPr.number,
            reason: 'open memory pull request already matches proposed tree',
          });
        }
      }

      const cleanInline = (value: string): string =>
        truncateCodePoints(scrubber.scrub(value).replace(/[\r\n]+/g, ' ').trim(), 72);
      const cleanTitle = cleanInline(casResult.pullRequest.title);
      const cleanBody = scrubber.scrub(casResult.pullRequest.body).replace(/\r\n?/g, '\n').trim();
      const upsertsCount = finalized.proposal.operations.filter(op => op.kind === 'upsert').length;
      const retireCount = finalized.proposal.operations.length - upsertsCount;
      const commitBody = [
        cleanInline(`- Taskpack: ${taskpack}`),
        `- Operations: ${finalized.proposal.operations.length} (${upsertsCount} upsert, ${retireCount} retire)`,
        cleanInline(`- Run: ${options.runId}`),
      ].join('\n');
      const signoffLine = `Signed-off-by: ${commitIdentity.name} <${commitIdentity.email}>`;
      const hasExactSignoff = cleanTitle === signoffLine;
      const skipCiParagraph = options.manifest.spec.memory.skipCi !== false ? '\n\n[skip ci]' : '';
      const commitMessage = hasExactSignoff
        ? `${cleanTitle}\n\n${commitBody}${skipCiParagraph}\n`
        : `${cleanTitle}\n\n${commitBody}${skipCiParagraph}\n\n${signoffLine}\n`;

      const headOid = (
        await gitClone(
          [
            '-c', `user.name=${commitIdentity.name}`,
            '-c', `user.email=${commitIdentity.email}`,
            'commit-tree',
            treeOid,
            '-p',
            currentTargetTip,
          ],
          { input: commitMessage },
        )
      ).toString('utf8').trim().toLowerCase();

      trackedBranchName = memoryBranch;
      const baseReceiptRecord = {
        version: 1 as const,
        repository: options.repositoryFullName,
        taskpack,
        targetBranch,
        directory: memoryDirectory,
        proposalId: finalized.proposal.proposalId,
        entryCount: finalized.proposal.operations.length,
        rebased: casResult.rebased,
        branchName: memoryBranch,
        headOid,
      };

      const claimed = await claimPerRunMemoryReceipt(
        options.runRoot,
        options.runId,
        {
          ...baseReceiptRecord,
          state: 'uncertain',
          status: 'reconcile_required',
          pullRequestUrl: openMemoryPr?.htmlUrl ?? null,
          pullRequestNumber: openMemoryPr?.number ?? null,
          reason: 'memory branch push in flight',
          updatedAtMs: Date.now(),
        },
        scrubber,
      );
      if (!claimed.claimed) {
        return Object.freeze({
          status: 'reconcile_required',
          directory: memoryDirectory,
          proposalId: finalized.proposal.proposalId,
          entryCount: finalized.proposal.operations.length,
          rebased: casResult.rebased,
          branchName: memoryBranch,
          pullRequestUrl: openMemoryPr?.htmlUrl ?? null,
          pullRequestNumber: openMemoryPr?.number ?? null,
          reason: 'memory publication already in flight or unresolved for this run',
        });
      }
      const { runDir } = claimed;
      mutationDispatched = true;

      const pushResult = await execGitDetailed(
        cloneDir,
        [
          ...protocolArgs,
          'push',
          '--porcelain',
          `--force-with-lease=refs/heads/${memoryBranch}:${expectedRemoteOid}`,
          '--',
          resolvedRemote,
          `${headOid}:refs/heads/${memoryBranch}`,
        ],
        { env: gitAuthEnv, timeoutMs: 25_000 },
      );

      if (
        pushResult.spawnError !== null
        || pushResult.stdoutOverflow
        || pushResult.timedOut
        || pushResult.code !== 0
        || pushResult.signal !== null
      ) {
        const expectedTargetRef = `refs/heads/${memoryBranch}`;
        const stdoutLines = pushResult.stdout.toString('utf8').split(/\r?\n/);
        let sawStaleLeaseRefRejection = false;
        let sawAnyRefUpdate = false;
        let sawDoneFooter = false;
        for (const rawLine of stdoutLines) {
          if (rawLine === 'Done') {
            sawDoneFooter = true;
            continue;
          }
          const tabParts = rawLine.split('\t');
          if (tabParts.length >= 3 && tabParts[0]!.length === 1) {
            const flag = tabParts[0]!;
            const fromTo = tabParts[1]!;
            const summary = tabParts.slice(2).join('\t').trim();
            const colonIdx = fromTo.indexOf(':');
            if (flag === ' ' || flag === '+' || flag === '-' || flag === '*' || flag === '=') {
              sawAnyRefUpdate = true;
            } else if (
              flag === '!'
              && colonIdx > 0
              && fromTo.slice(0, colonIdx).toLowerCase() === headOid
              && fromTo.slice(colonIdx + 1) === expectedTargetRef
              && /^\[rejected\]\s*\(stale info\)$/i.test(summary)
            ) {
              sawStaleLeaseRefRejection = true;
            }
          }
        }

        let verifiedNotAtHead = false;
        if (
          pushResult.spawnError === null
          && !pushResult.stdoutOverflow
          && !pushResult.timedOut
          && pushResult.signal === null
          && pushResult.code === 1
          && sawStaleLeaseRefRejection
          && sawDoneFooter
          && !sawAnyRefUpdate
        ) {
          const verifyRemote = await execGitDetailed(
            cloneDir,
            [...protocolArgs, 'ls-remote', '--', resolvedRemote, expectedTargetRef],
            { env: gitAuthEnv, timeoutMs: 10_000 },
          );
          if (
            verifyRemote.spawnError === null
            && !verifyRemote.stdoutOverflow
            && !verifyRemote.timedOut
            && verifyRemote.signal === null
            && verifyRemote.code === 0
          ) {
            const observedRemoteOid = verifyRemote.stdout.toString('utf8').trim().split(/\s+/)[0]?.toLowerCase() ?? '';
            if (observedRemoteOid !== headOid) {
              verifiedNotAtHead = true;
            }
          }
        }

        if (verifiedNotAtHead) {
          mutationDispatched = false;
          await unlink(join(runDir, MEMORY_PUBLICATION_RECEIPT_FILE)).catch(() => undefined);
          return Object.freeze({
            status: 'refused',
            directory: memoryDirectory,
            proposalId: finalized.proposal.proposalId,
            entryCount: 0,
            rebased: casResult.rebased,
            branchName: memoryBranch,
            pullRequestUrl: openMemoryPr?.htmlUrl ?? null,
            pullRequestNumber: openMemoryPr?.number ?? null,
            reason: 'MEMORY_CAS_CONFLICT: remote memory branch moved concurrently (force-with-lease rejected)',
          });
        }

        const stderrText = pushResult.stderr.toString('utf8').trim();
        const rawPushDetail = pushResult.spawnError !== null
          ? `git push failed to spawn: ${pushResult.spawnError}`
          : pushResult.stdoutOverflow
            ? 'git push output exceeded maximum buffer size'
            : pushResult.timedOut
              ? 'git push timed out after 25000ms'
              : `git push exited with ${pushResult.code ?? pushResult.signal}${stderrText.length > 0 ? `: ${stderrText}` : ''}`;
        const scrubbedPushReason = truncateCodePoints(
          sanitizeReportText(rawPushDetail, { scrub: text => scrubber.scrub(text), singleLine: true }),
          MAX_REASON_CODEPOINTS,
        );
        await updatePerRunMemoryReceipt(
          runDir,
          {
            ...baseReceiptRecord,
            state: 'uncertain',
            status: 'reconcile_required',
            pullRequestUrl: openMemoryPr?.htmlUrl ?? null,
            pullRequestNumber: openMemoryPr?.number ?? null,
            reason: scrubbedPushReason,
            updatedAtMs: Date.now(),
          },
          scrubber,
        );
        return Object.freeze({
          status: 'reconcile_required',
          directory: memoryDirectory,
          proposalId: finalized.proposal.proposalId,
          entryCount: finalized.proposal.operations.length,
          rebased: casResult.rebased,
          branchName: memoryBranch,
          pullRequestUrl: openMemoryPr?.htmlUrl ?? null,
          pullRequestNumber: openMemoryPr?.number ?? null,
          reason: scrubbedPushReason,
        });
      }

      const isUpdate = openMemoryPr !== null;
      const fetchImpl = options.fetchImpl ?? globalThis.fetch;
      const apiHeaders: Record<string, string> = {
        accept: 'application/vnd.github+json',
        'content-type': 'application/json',
        'user-agent': 'loopwright-github-app',
        authorization: `Bearer ${options.githubToken!}`,
      };
      const prEndpoint = openMemoryPr !== null
        ? `${apiBaseUrl}/repos/${options.repositoryFullName}/pulls/${openMemoryPr.number}`
        : `${apiBaseUrl}/repos/${options.repositoryFullName}/pulls`;

      let prRes: Awaited<ReturnType<typeof fetchBoundedText>>;
      try {
        prRes = await fetchBoundedText(
          prEndpoint,
          fetchImpl,
          apiHeaders,
          15_000,
          scrubber,
          {
            method: isUpdate ? 'PATCH' : 'POST',
            body: JSON.stringify(
              isUpdate
                ? { title: cleanTitle, body: cleanBody }
                : { title: cleanTitle, head: memoryBranch, base: targetBranch, body: cleanBody },
            ),
          },
        );
      } catch (transportErr) {
        const rawMsg = transportErr instanceof Error ? transportErr.message : String(transportErr);
        const transportReason = truncateCodePoints(
          sanitizeReportText(`memory pull request API transport error: ${rawMsg}`, { scrub: text => scrubber.scrub(text), singleLine: true }),
          MAX_REASON_CODEPOINTS,
        );
        await updatePerRunMemoryReceipt(
          runDir,
          {
            ...baseReceiptRecord,
            state: 'uncertain',
            status: 'reconcile_required',
            pullRequestUrl: openMemoryPr?.htmlUrl ?? null,
            pullRequestNumber: openMemoryPr?.number ?? null,
            reason: transportReason,
            updatedAtMs: Date.now(),
          },
          scrubber,
        );
        return Object.freeze({
          status: 'reconcile_required',
          directory: memoryDirectory,
          proposalId: finalized.proposal.proposalId,
          entryCount: finalized.proposal.operations.length,
          rebased: casResult.rebased,
          branchName: memoryBranch,
          pullRequestUrl: openMemoryPr?.htmlUrl ?? null,
          pullRequestNumber: openMemoryPr?.number ?? null,
          reason: transportReason,
        });
      }

      if (!prRes.ok) {
        const httpErrReason = truncateCodePoints(
          sanitizeReportText(
            `memory pull request API failed (${prRes.status}): ${prRes.text}`,
            { scrub: text => scrubber.scrub(text), singleLine: true },
          ),
          MAX_REASON_CODEPOINTS,
        );
        await updatePerRunMemoryReceipt(
          runDir,
          {
            ...baseReceiptRecord,
            state: 'uncertain',
            status: 'reconcile_required',
            pullRequestUrl: openMemoryPr?.htmlUrl ?? null,
            pullRequestNumber: openMemoryPr?.number ?? null,
            reason: httpErrReason,
            updatedAtMs: Date.now(),
          },
          scrubber,
        );
        return Object.freeze({
          status: 'reconcile_required',
          directory: memoryDirectory,
          proposalId: finalized.proposal.proposalId,
          entryCount: finalized.proposal.operations.length,
          rebased: casResult.rebased,
          branchName: memoryBranch,
          pullRequestUrl: openMemoryPr?.htmlUrl ?? null,
          pullRequestNumber: openMemoryPr?.number ?? null,
          reason: httpErrReason,
        });
      }

      let parsedPr: unknown;
      try {
        parsedPr = JSON.parse(prRes.text);
      } catch {
        parsedPr = null;
      }
      let validatedPr = validateMemoryPullRequestApiResponse(parsedPr, {
        repositoryFullName: options.repositoryFullName,
        targetBranch,
        memoryBranch,
        headOid,
        existingPrNumber: openMemoryPr?.number ?? null,
        scrubber,
      });

      if (!validatedPr.ok && validatedPr.canConfirmViaReadOnlyGet && validatedPr.prNumber !== null) {
        const confirmUrl = `${apiBaseUrl}/repos/${options.repositoryFullName}/pulls/${validatedPr.prNumber}`;
        const readHeaders: Record<string, string> = {
          accept: 'application/vnd.github+json',
          'user-agent': 'loopwright-github-app',
          authorization: `Bearer ${options.githubToken!}`,
        };
        const readRes = await fetchBoundedText(
          confirmUrl,
          fetchImpl,
          readHeaders,
          10_000,
          scrubber,
          { method: 'GET' },
        ).catch(() => null);
        if (readRes !== null && readRes.ok) {
          let parsedGetPr: unknown;
          try {
            parsedGetPr = JSON.parse(readRes.text);
          } catch {
            parsedGetPr = null;
          }
          const revalidated = validateMemoryPullRequestApiResponse(parsedGetPr, {
            repositoryFullName: options.repositoryFullName,
            targetBranch,
            memoryBranch,
            headOid,
            existingPrNumber: validatedPr.prNumber,
            scrubber,
          });
          if (revalidated.ok) {
            const checkRemote = await execGitDetailed(
              cloneDir,
              [...protocolArgs, 'ls-remote', '--', resolvedRemote, `refs/heads/${memoryBranch}`],
              { env: gitAuthEnv, timeoutMs: 10_000 },
            );
            const remoteStillMatches =
              checkRemote.spawnError === null
              && !checkRemote.stdoutOverflow
              && !checkRemote.timedOut
              && checkRemote.signal === null
              && checkRemote.code === 0
              && (checkRemote.stdout.toString('utf8').trim().split(/\s+/)[0]?.toLowerCase() ?? '') === headOid;
            if (remoteStillMatches) {
              validatedPr = revalidated;
            }
          }
        }
      }

      if (!validatedPr.ok) {
        const parseErrReason = validatedPr.reason;
        await updatePerRunMemoryReceipt(
          runDir,
          {
            ...baseReceiptRecord,
            state: 'uncertain',
            status: 'reconcile_required',
            pullRequestUrl: openMemoryPr?.htmlUrl ?? null,
            pullRequestNumber: openMemoryPr?.number ?? null,
            reason: parseErrReason,
            updatedAtMs: Date.now(),
          },
          scrubber,
        );
        return Object.freeze({
          status: 'reconcile_required',
          directory: memoryDirectory,
          proposalId: finalized.proposal.proposalId,
          entryCount: finalized.proposal.operations.length,
          rebased: casResult.rebased,
          branchName: memoryBranch,
          pullRequestUrl: openMemoryPr?.htmlUrl ?? null,
          pullRequestNumber: openMemoryPr?.number ?? null,
          reason: parseErrReason,
        });
      }

      const settledStatus = isUpdate ? 'updated' : 'published';
      await updatePerRunMemoryReceipt(
        runDir,
        {
          ...baseReceiptRecord,
          state: 'completed',
          status: settledStatus,
          pullRequestUrl: validatedPr.prUrl,
          pullRequestNumber: validatedPr.prNumber,
          reason: null,
          updatedAtMs: Date.now(),
        },
        scrubber,
      );

      return Object.freeze({
        status: settledStatus,
        directory: memoryDirectory,
        proposalId: finalized.proposal.proposalId,
        entryCount: finalized.proposal.operations.length,
        rebased: casResult.rebased,
        branchName: memoryBranch,
        pullRequestUrl: validatedPr.prUrl,
        pullRequestNumber: validatedPr.prNumber,
        reason: null,
      });
    } finally {
      await rm(memoryScratch, { recursive: true, force: true }).catch(() => undefined);
    }
  } catch (error) {
    const detail = error instanceof MemoryDiagnosticError
      ? `${error.code} at ${error.path}: ${error.detail}`
      : error instanceof Error
        ? error.message
        : String(error);
    const sanitizedReason = truncateCodePoints(
      sanitizeReportText(detail, { scrub: text => scrubber.scrub(text), singleLine: true }),
      MAX_REASON_CODEPOINTS,
    );
    if (mutationDispatched) {
      return Object.freeze({
        status: 'reconcile_required',
        directory: memoryDirectory,
        proposalId: trackedProposalId,
        entryCount: trackedEntryCount,
        rebased: trackedRebased,
        branchName: trackedBranchName,
        pullRequestUrl: trackedPrUrl,
        pullRequestNumber: trackedPrNumber,
        reason: sanitizedReason,
      });
    }
    const isRefusal = error instanceof MemoryDiagnosticError
      || (error instanceof GitHubAppError && error.code === 'TASKPACK_SCOPE_VIOLATION');
    return Object.freeze({
      status: isRefusal ? 'refused' : 'failed',
      directory: memoryDirectory,
      proposalId: trackedProposalId,
      entryCount: isRefusal ? 0 : trackedEntryCount,
      rebased: trackedRebased,
      branchName: trackedBranchName,
      pullRequestUrl: trackedPrUrl,
      pullRequestNumber: trackedPrNumber,
      reason: sanitizedReason,
    });
  }
}
