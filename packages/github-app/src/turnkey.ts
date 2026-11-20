import {
  executeTurnkeyCycle as taskpackExecuteTurnkeyCycle,
  type ActionDelegateOutcome,
  type ExecuteTurnkeyActionCycleOptions,
  type TurnkeyCycleAttemptSummary,
  type TurnkeyCycleDelegateOptions,
  type TurnkeyMemorySummary,
  type WrittenCompiledTaskpack,
} from '@loopwright/taskpack';

export {
  applyCarryDeltaToEffectiveBaseline,
  buildCommandScriptInvocation,
  buildGitAuthEnv,
  CANONICAL_TASKPACK_STEP_GATE_URL,
  computeAllowedSourceRevisionCarryDelta,
  CONTROLLER_ID_PATTERN,
  copyDirectoryTreeReadOnly,
  EXCLUDED_READ_ONLY_GIT_TOP_LEVEL,
  execGit,
  execGitDetailed,
  executeTurnkeyCycle,
  formatHostSessionProgressLog,
  hasSymlinkAtOrAbove,
  inspectAndVerifyCandidate,
  isAllowedCandidateWrite,
  isProtectedCandidatePath,
  isRetryablePerRequestTimeout,
  listBaselineRegularEntries,
  listTreeEntriesAtRevision,
  makeAttemptRunId,
  makeTreeReadOnly,
  makeTreeWritableForCleanup,
  MAX_GIT_LIST_BYTES,
  MAX_REASON_CODEPOINTS,
  normalizeCandidateRelativePath,
  normalizeControllerRunId,
  openStagedTaskpackStepGate,
  removePathsFromIndex,
  SAFE_BRANCH_PATTERN,
  SANITIZED_READ_ONLY_GIT_CONFIG,
  stageEntriesInIndex,
  stageReadOnlyGitForCommandCheck,
  stageSanitizedReadOnlyGitDir,
  stageTaskpackForStep,
  startLocalCommandGateServer,
  truncateCodePoints,
  validateGateToolchainPath,
  verifyBaseTreeAnchor,
  verifyGitObjectsTreeNoSymlinks,
  type BaselineRegularEntry,
  type BuildCommandScriptInvocationOptions,
  type CarryDeltaEntry,
  type CommandScriptInvocation,
  type DetailedGitResult,
  type ExecGitOptions,
  type ExecuteTurnkeyActionCycleOptions,
  type ExecuteTurnkeyCycleOptions,
  type GitTreeEntry,
  type InspectedCandidateFile,
  type InspectedCandidateSnapshot,
  type LocalCommandGateServer,
  type LocalCommandGateServerOptions,
  type OpenStagedTaskpackStepGateOptions,
  type ReadOnlyGitObjectsBind,
  type StagedTaskpackForStep,
  type StagedTaskpackStepGateHandle,
  type StageReadOnlyGitOptions,
  type StageTaskpackForStepOptions,
  type TurnkeyCycleAttemptSummary,
  type TurnkeyCycleDelegateOptions,
} from '@loopwright/taskpack';

export {
  buildNativePullRequestBody,
  startNativePullRequestPublisherServer,
  type NativePullRequestPublisherOptions,
  type NativePullRequestPublisherServer,
} from './publisher.js';

/**
 * Execute one GitHub Action turnkey Controller cycle attempt (`policyProfile: 'github'` by default),
 * preserving PR #30 `circuitBreakerLimits` and `LOOPWRIGHT_MAX_TURNS` / `LOOPWRIGHT_MAX_REPAIR_TURNS` overrides.
 */
export async function executeTurnkeyActionCycle(
  options: ExecuteTurnkeyActionCycleOptions,
): Promise<TurnkeyCycleAttemptSummary & { readonly outcome: ActionDelegateOutcome; readonly memory?: TurnkeyMemorySummary | undefined }> {
  return taskpackExecuteTurnkeyCycle({
    ...options,
    policyProfile: options.policyProfile ?? options.taskpack.policyProfile ?? 'github',
  });
}

/**
 * Create a delegate function suitable for `runGitHubActionEntrypoint` that
 * executes isolated per-attempt Controller cycles (`runId`, `runId-a1`, ...) under `'github'` policy profile.
 */
export function createTurnkeyCycleDelegate(
  options: TurnkeyCycleDelegateOptions,
): (taskpack: WrittenCompiledTaskpack) => Promise<ActionDelegateOutcome> {
  let nextAttemptSeq = 0;
  return async (taskpack: WrittenCompiledTaskpack): Promise<ActionDelegateOutcome> => {
    const attemptSeq = nextAttemptSeq++;
    const result = await executeTurnkeyActionCycle({
      ...options,
      taskpack,
      attemptSeq,
    });
    return result.outcome;
  };
}
