import { constants as fsConstants } from 'node:fs';
import { lstat, mkdir, open } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { validateDocument } from '@loopwright/core';
import {
  applyMemoryProposalCAS,
  DEFAULT_MEMORY_MAX_ENTRIES,
  DEFAULT_MEMORY_TTL_DAYS,
  finalizeRunMemory,
  isMemoryManagedPath,
  loadMemoryStore,
  MemoryDiagnosticError,
  resolveSettledCycleContext,
  type MemoryCASResult,
  type MemoryFinalizerConfig,
  type MemoryProposal,
  type MemoryStoreIndex,
  type ResolvedSettledCycleContext,
  type SeparateMemoryPullRequestSpec,
} from '@loopwright/memory';
import { sanitizeReportText } from './output-format.js';
import { extractTaskpackResourcePaths, resolveManifestControlRoot } from './schema.js';
import { SecretScrubber } from './scrubber.js';
import {
  compileScopePatterns,
  resolveTaskpackMemoryLocation,
} from './taskpack.js';
import {
  CONTROLLER_ID_PATTERN,
  MAX_REASON_CODEPOINTS,
  truncateCodePoints,
} from './turnkey.js';
import {
  GITHUB_PROTECTED_AUTOMATION_PATHS,
  LOCAL_PROTECTED_AUTOMATION_PATHS,
  TaskpackError,
  type PolicyProfile,
  type TargetMatrixCell,
  type TaskpackManifest,
  type TaskpackUpstreamRecord,
  type TurnkeyMemorySummary,
} from './types.js';
import {
  buildUpstreamMemoryVersions,
  COMMIT_SHA_PATTERN,
  isPlainRecord,
  type UpstreamAcquisitionRecord,
} from './upstreams.js';

export interface FinalizeLocalTurnkeyMemoryOptions {
  readonly runRoot: string;
  readonly runId: string;
  readonly repositoryRoot: string;
  readonly repositoryFullName?: string | undefined;
  readonly manifest: TaskpackManifest;
  readonly taskpackPath?: string | undefined;
  readonly baseRevision: string;
  readonly policyProfile?: PolicyProfile | undefined;
  readonly upstreamRecords?: readonly TaskpackUpstreamRecord[] | undefined;
  readonly targetMatrix?: TargetMatrixCell | null | undefined;
  readonly scrubber: SecretScrubber;
  readonly nowMs?: number | undefined;
  readonly separatePullRequestFinalizer?: (() => Promise<TurnkeyMemorySummary>) | undefined;
}

export interface ExpectedSettledRunBindings {
  readonly runId: string;
  readonly repositoryFullName: string;
  readonly taskpack: string;
  readonly baseRevision: string;
}

const MS_PER_DAY = 24 * 60 * 60 * 1000;

export function buildMemoryProtectedPaths(
  manifest: TaskpackManifest,
  controlRoot: string,
  manifestPath: string | undefined,
  options?: {
    readonly policyProfile?: PolicyProfile | undefined;
  },
): { readonly protectedPaths: readonly string[]; readonly compilerAutoMemoryProtected: readonly string[] } {
  const policyProfile: PolicyProfile = options?.policyProfile ?? 'local';
  const baseAutomationPaths = policyProfile === 'github'
    ? GITHUB_PROTECTED_AUTOMATION_PATHS
    : LOCAL_PROTECTED_AUTOMATION_PATHS;
  const userProtectedPatterns = compileScopePatterns(manifest.spec.scope.protected, 'protected');
  const userProtectedSet = new Set<string>(userProtectedPatterns);
  const declaredCommandScripts = manifest.spec.verification.localChecks.flatMap(check =>
    check.implementation === 'command.v1' && typeof check.parameters?.['script'] === 'string' && check.parameters['script'].length > 0
      ? [check.parameters['script']]
      : [],
  );
  const allInstructions = extractTaskpackResourcePaths([
    ...(manifest.spec.instructions ?? []),
    ...(manifest.spec.roles?.flatMap(r => r.instructions ?? []) ?? []),
  ]);
  const allSkills = extractTaskpackResourcePaths([
    ...(manifest.spec.skills ?? []),
    ...(manifest.spec.roles?.flatMap(r => r.skills ?? []) ?? []),
  ]);
  const protectedPaths = [
    ...new Set([
      ...baseAutomationPaths.flatMap(entry => [entry, `${entry}/**`]),
      `${controlRoot}/policies`,
      `${controlRoot}/policies/**`,
      `${controlRoot}/checks`,
      `${controlRoot}/checks/**`,
      `${controlRoot}/taskpack.yaml`,
      `${controlRoot}/taskpack.yml`,
      `${controlRoot}/taskpack.json`,
      ...(manifestPath !== undefined ? [manifestPath] : []),
      ...(manifest.spec.execution?.digests.lockfile !== undefined ? [manifest.spec.execution.digests.lockfile] : []),
      ...(manifest.spec.preflight?.script !== undefined ? [manifest.spec.preflight.script] : []),
      ...allInstructions,
      ...allSkills,
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

export async function resolveSafeRunDirectory(
  runRoot: string,
  runId: string,
  createIfMissing: boolean,
): Promise<string | null> {
  if (!CONTROLLER_ID_PATTERN.test(runId) || runId.length > 128) {
    throw new TaskpackError('ACTION_INPUT_INVALID', `invalid runId "${runId}" for memory finalization`);
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
    throw new TaskpackError('ACTION_INPUT_INVALID', 'runRoot must be a non-symlink directory');
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
    throw new TaskpackError('ACTION_INPUT_INVALID', 'run directory must be a non-symlink directory');
  }
  return runDir;
}

export async function readRegularJsonBounded(
  filePath: string,
  maxBytes: number,
  label: string,
): Promise<{ readonly exists: false } | { readonly exists: true; readonly value: unknown }> {
  const noFollow = 'O_NOFOLLOW' in fsConstants ? fsConstants.O_NOFOLLOW : 0;
  const nonBlock = 'O_NONBLOCK' in fsConstants ? fsConstants.O_NONBLOCK : 0;
  const handle = await open(
    filePath,
    fsConstants.O_RDONLY | noFollow | nonBlock,
  ).catch(
    (err: NodeJS.ErrnoException) => {
      if (err.code === 'ENOENT') return null;
      throw new TaskpackError('ACTION_INPUT_INVALID', `unable to open ${label}: ${err.code ?? err.message}`);
    },
  );
  if (handle === null) return { exists: false };
  try {
    const st = await handle.stat();
    if (!st.isFile()) {
      throw new TaskpackError('ACTION_INPUT_INVALID', `${label} is not a regular file`);
    }
    if (st.size === 0 || st.size > maxBytes) {
      throw new TaskpackError('ACTION_INPUT_INVALID', `corrupt ${label}; manual reconciliation required`);
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
      throw new TaskpackError('ACTION_INPUT_INVALID', `corrupt ${label}; manual reconciliation required`);
    }
  } finally {
    await handle.close();
  }
}

export function validateRetainedSettledRunBindings(
  settled: Pick<ResolvedSettledCycleContext, 'lock' | 'result'> & { readonly incident?: ResolvedSettledCycleContext['incident'] },
  expected: ExpectedSettledRunBindings,
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

export async function verifyRetainedRunDescriptorIfPresent(
  runRoot: string,
  expected: ExpectedSettledRunBindings,
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

export function scrubTurnkeyReason(raw: string, scrubber: SecretScrubber): string {
  return truncateCodePoints(
    sanitizeReportText(raw, { scrub: text => scrubber.scrub(text), singleLine: true }),
    MAX_REASON_CODEPOINTS,
  );
}

export function buildEmptyMemorySummary(
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

export async function verifyDescriptorAndBudgetSkip(options: {
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

export async function resolveVerifiedSettledRun(options: {
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

export async function finalizeTurnkeyProposal(options: {
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

export async function applyAndValidateTurnkeyMemoryCAS(options: {
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
  readonly policyProfile?: PolicyProfile | undefined;
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
    policyProfile,
  } = options;
  const { protectedPaths, compilerAutoMemoryProtected } = buildMemoryProtectedPaths(
    manifest,
    controlRoot,
    manifestPath,
    { policyProfile },
  );
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
 * Local post-settlement memory finalization (`disabled` and `local-only` with neutral protected paths).
 * Refuses `apply: 'separate-pull-request'` with `TASKPACK_HOST_BINDING_INVALID` unless delegated
 * to `@loopwright/github-app` via `separatePullRequestFinalizer`.
 */
export async function finalizeLocalTurnkeyMemory(
  options: FinalizeLocalTurnkeyMemoryOptions,
): Promise<TurnkeyMemorySummary> {
  const memoryApply = options.manifest.spec.memory.apply;
  if (memoryApply === 'separate-pull-request') {
    if (options.separatePullRequestFinalizer !== undefined) {
      return await options.separatePullRequestFinalizer();
    }
    throw new TaskpackError(
      'TASKPACK_HOST_BINDING_INVALID',
      'memory.apply "separate-pull-request" requires a GitHub pull-request memory publisher (@loopwright/github-app)',
      '/spec/memory/apply',
    );
  }

  const scrubber = options.scrubber;
  const nowMs = options.nowMs ?? Date.now();
  const policyProfile: PolicyProfile = options.policyProfile ?? 'local';
  const repositoryFullName = options.repositoryFullName?.trim() || 'local/repo';
  let memoryDirectory = options.manifest.spec.memory.directory;
  let trackedProposalId: string | null = null;
  let trackedEntryCount = 0;
  let trackedRebased = false;

  try {
    const resolvedLocation = resolveTaskpackMemoryLocation(options.manifest, options.taskpackPath);
    const { controlRoot, memoryRoot } = resolvedLocation;
    memoryDirectory = resolvedLocation.memoryDirectory;
    const { manifestPath } = resolveManifestControlRoot(options.manifest, options.taskpackPath);

    if (memoryApply === 'disabled') {
      return buildEmptyMemorySummary(memoryDirectory, 'skipped', 'memory_apply_disabled');
    }

    if (!COMMIT_SHA_PATTERN.test(options.baseRevision)) {
      return buildEmptyMemorySummary(memoryDirectory, 'failed', 'baseRevision is not a 40-hex commit SHA');
    }

    const taskpack = options.manifest.metadata.name;
    const targetBranch = options.manifest.spec.publication.targetBranch ?? 'main';
    const ttlDays = options.manifest.spec.memory.ttlDays ?? DEFAULT_MEMORY_TTL_DAYS;
    const ttlMs = ttlDays * MS_PER_DAY;
    const maxEntries = options.manifest.spec.memory.maxEntries ?? DEFAULT_MEMORY_MAX_ENTRIES;
    const checkCodeFingerprint = options.manifest.spec.memory.checkCodeFingerprint === true;
    const checkUpstreamVersions = options.manifest.spec.memory.checkUpstreamVersions === true;
    const manifestMatrix = options.manifest.spec.target?.matrix;
    const targetMatrix = options.targetMatrix !== undefined
      ? options.targetMatrix
      : (manifestMatrix !== undefined && manifestMatrix !== null && manifestMatrix.length === 1 ? manifestMatrix[0]! : null);

    const expectedBindings: ExpectedSettledRunBindings = {
      runId: options.runId,
      repositoryFullName,
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
      upstreamVersions: buildUpstreamMemoryVersions(options.upstreamRecords as readonly UpstreamAcquisitionRecord[] | undefined),
    };

    const localBaseStore = (await loadMemoryStore(options.repositoryRoot, taskpack, repositoryFullName, memoryRoot)).index;
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
      policyProfile,
    });
    trackedRebased = localCasOutcome.rebased;
    if (!localCasOutcome.ok) return localCasOutcome.summary;

    return buildEmptyMemorySummary(memoryDirectory, 'local_only', null, {
      proposalId: finalizedOutcome.proposal.proposalId,
      entryCount: finalizedOutcome.proposal.operations.length,
      rebased: localCasOutcome.rebased,
    });
  } catch (error) {
    const detail = error instanceof MemoryDiagnosticError
      ? `${error.code} at ${error.path}: ${error.detail}`
      : error instanceof Error
        ? error.message
        : String(error);
    const sanitizedReason = scrubTurnkeyReason(detail, scrubber);
    const isRefusal = error instanceof MemoryDiagnosticError
      || (error instanceof TaskpackError && error.code === 'TASKPACK_SCOPE_VIOLATION');
    return Object.freeze({
      status: isRefusal ? 'refused' : 'failed',
      directory: memoryDirectory,
      proposalId: trackedProposalId,
      entryCount: isRefusal ? 0 : trackedEntryCount,
      rebased: trackedRebased,
      branchName: null,
      pullRequestUrl: null,
      pullRequestNumber: null,
      reason: sanitizedReason,
    });
  }
}
