import { createHash } from 'node:crypto';
import { closeSync, constants as fsConstants, existsSync, lstatSync, openSync, readFileSync } from 'node:fs';
import { chmod, mkdir, open, realpath, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PI_THINKING_LEVELS, PI_WIRE_APIS, STANDARD_PI_PROVIDER_ENV, isOAuthOnlyPiProvider, resolveCatalogModel } from '@loopwright/agent-pi/catalog';
import { HostMcpRegistry, type ExternalMcpServerConfig } from '@loopwright/agent-pi/mcp';
import { formatDurationMs, formatTokenCount, type ReportMcpServerInfo } from '@loopwright/controller';
import { DECISION_PROVIDER_API_KEY_ENV, type DecisionTransport } from '@loopwright/decisions';
import {
  alignBaselineRevisions,
  BASELINE_CONFLICT_REASON,
  boundUtf8Lines,
  buildDefaultAuthorPrompt,
  createTaskpackDecisionPort,
  insideRoot,
  loadTaskpackSuite,
  mergeMcpServerDeclarations,
  parseBaselineAlignmentPolicy,
  parseMcpServersOverride,
  resolveBaselineAlignmentConfig,
  resolveExternalMcpConfigs,
  resolveTaskpackSuite,
  serializeActionResultSummary as taskpackSerializeActionResultSummary,
  type BaselineAlignmentOverride,
  type BaselineAlignmentResult,
  type BuildDefaultAuthorPromptOptions,
  type CreateTaskpackDecisionPortOptions,
  type LoadedTaskpackSuite,
  type LoadedTaskpackSuiteDomain,
  type ResolvedBaselineAlignmentConfig,
  type SuiteMatrixCell,
  type SuiteResolutionResult,
  type TargetMatrixCell,
} from '@loopwright/taskpack';
import {
  LOOPWRIGHT_ACTIVE_PROVIDER_TOKEN_ENV, loadPiModelsJson, resolveDefaultProviderTokenEnv, resolveTaskpackModelCandidates,
  resolveTaskpackModelSelection, selectHealthyModelCandidate,
  type ParsedPiModelsJson,
} from './models-config.js';
import { resolveActionOutputFormats, writeActionOutputSinks, type RunReportInput } from './output-format.js';
import {
  collectManifestSecretEnvNames,
  formatWorkspaceResourcesManifest,
  runTaskpackPreflight,
  type RunTaskpackPreflightResult,
} from './preflight.js';
import { startNativePullRequestPublisherServer, type NativePullRequestPublisherServer } from './publisher.js';
import { validateMcpAuthConfiguration, qualifyDeploymentHostProfile } from './qualification.js';
import { negotiateSandboxBackend, resolveEffectiveTaskpackSandboxPolicy } from './sandbox.js';
import { collectMcpReferencedEnvNames, hasAnyDeclaredGitHubTrigger, isGitHubTriggerDeclared } from './schema.js';
import {
  validateGitHubApiBaseUrl,
  verifySuiteCommentPullRequest,
  type VerifiedSuitePullRequestOwnership,
} from './suite-pr-lookup.js';
import {
  authorizeRepositoryActor, compileDeclarativeTaskpack, DEFAULT_HOST_BUDGETS,
  loadDeclarativeTaskpack, mergeTaskpackLimits, parseActionInputLimits, parseCommentCommand,
  parseLoopwrightEnvLimits, prepareTaskpackIntake, resolveTaskpackMemoryLocation, stageCompiledInstructionResources,
  validateCommentGuidance,
} from './taskpack.js';
import { assertCleanArtifact, SecretScrubber } from './token-broker.js';
import {
  createTurnkeyCycleDelegate, normalizeControllerRunId,
  startLocalCommandGateServer, validateGateToolchainPath,
  type LocalCommandGateServer, type TurnkeyCycleAttemptSummary,
} from './turnkey.js';
import { finalizeAndPublishTurnkeyMemory } from './turnkey-memory.js';
import {
  checkManagedPrMatchesDiscoveredState, COMMIT_SHA_PATTERN, DEFAULT_GIT_COMMIT_IDENTITY,
  discoverTaskpackUpstreamsV2, findOpenManagedPullRequest, isPlainRecord,
  parseOptionalGitIdentityInput, resolveGitCommitSha, resolveGitHubAuth, resolveGitHubToken,
  resolveRepositoryAndRevisions, shouldPreserveExplicitSourceRevision,
  validateGitAuthorEmail, validateGitAuthorName,
  type ManagedPullRequestInfo,
} from './upstreams.js';
import { serializePrettyYaml } from './yaml.js';
import {
  DEFAULT_LOCAL_COMMAND_GATE_ENV, GitHubAppError, LOCAL_COMMAND_GATE_ENDPOINT_ID, TASKPACK_COMMENT_COMMANDS,
  type ActionDelegateOutcome, type ActionEntrypointInput, type ActionEntrypointResult, type ClockSample,
  type ExecutionHostPolicy, type GitCommitIdentity, type HostGateEndpointPlan, type HostPublicationEndpointPlan,
  type HostRoleSelection, type HostTaskpackBindings, type PiThinkingLevel, type PiWireApi, type ResolvedModelCandidate,
  type TaskpackCommentCommand, type TaskpackIntakeOutcome, type TaskpackLimitsDeclaration,
  type TaskpackManifest, type TaskpackMcpServerDeclaration,
  type TurnkeyMemorySummary, type WrittenCompiledTaskpack,
} from './types.js';

export {
  boundUtf8Lines,
  buildDefaultAuthorPrompt,
  createTaskpackDecisionPort,
  insideRoot,
  mergeMcpServerDeclarations,
  parseMcpServersOverride,
  type BuildDefaultAuthorPromptOptions,
  type CreateTaskpackDecisionPortOptions,
};

export interface SuiteActionEntrypointResult {
  readonly kind: 'eligible' | 'deferred' | 'ignored';
  readonly disposition: 'eligible' | 'deferred' | 'ignored';
  readonly reason: string;
  readonly detail?: string | undefined;
  readonly suite: SuiteResolutionResult;
  readonly matrix: { readonly include: readonly SuiteMatrixCell[] };
}

export type TurnkeyActionEntrypointResult = ActionEntrypointResult | SuiteActionEntrypointResult;

function isSuiteActionResult(result: TurnkeyActionEntrypointResult): result is SuiteActionEntrypointResult {
  return result.kind === 'eligible' || result.kind === 'deferred' || result.kind === 'ignored';
}

export function serializeActionResultSummary(
  result: TurnkeyActionEntrypointResult,
  scrubber: SecretScrubber,
): string {
  if (isSuiteActionResult(result)) {
    const payload = {
      kind: result.kind,
      disposition: result.disposition,
      reason: result.reason,
      ...(result.detail !== undefined ? { detail: result.detail } : {}),
      suite: result.suite,
      matrix: result.matrix,
    };
    return scrubber.scrub(JSON.stringify(payload));
  }
  return taskpackSerializeActionResultSummary(result, scrubber);
}

export interface TurnkeyActionExecutionReport {
  readonly manifest: TaskpackManifest | null;
  readonly report: RunReportInput;
  readonly memory?: TurnkeyMemorySummary | undefined;
  readonly scrubber: SecretScrubber;
}

export interface TurnkeyActionEntrypointInput extends ActionEntrypointInput {
  readonly suitePath?: string | undefined;
  readonly domain?: string | undefined;
  readonly resolveSuiteOnly?: boolean | undefined;
  readonly schedule?: string | undefined;
  readonly githubOutputPath?: string | undefined;
  readonly turnkey?: boolean | undefined;
  readonly repositoryId?: number | undefined;
  readonly installationId?: number | undefined;
  readonly githubApiBaseUrl?: string | undefined;
  readonly githubToken?: string | undefined;
  readonly githubAppId?: string | number | undefined;
  readonly githubAppPrivateKey?: string | undefined;
  readonly githubAppInstallationId?: string | number | undefined;
  readonly upstreamRecordsJson?: string | undefined;
  readonly mcpServersJson?: string | undefined;
  readonly gitRemoteUrl?: string | undefined;
  readonly managedPrMatchesDiscoveredState?: boolean | undefined;
  readonly output?: string | undefined;
  readonly decisionTransport?: DecisionTransport | undefined;
  readonly decisionApiKey?: string | undefined;
  readonly progressSink?: ((line: string) => void) | undefined;
  readonly onTurnkeyReport?: ((info: TurnkeyActionExecutionReport) => void) | undefined;
}

function systemSample(): ClockSample {
  return { wallMs: Date.now(), monotonicMs: (process.hrtime.bigint() / 1_000_000n).toString() };
}

async function validateManifestCommandToolchainPaths(
  manifest: TaskpackManifest,
  repositoryRoot: string,
  allowPrivileged: boolean,
): Promise<void> {
  let realTmpRoot: string | undefined;
  for (const check of manifest.spec.verification.localChecks) {
    if (check.implementation !== 'command.v1') continue;
    const rawPaths = check.parameters?.['toolchainPaths'];
    if (!Array.isArray(rawPaths) || rawPaths.length === 0) continue;
    realTmpRoot ??= await realpath(tmpdir());
    const script = typeof check.parameters?.['script'] === 'string' ? check.parameters['script'] : '';
    const gate = {
      checkId: check.id,
      gateId: `precheck-${check.id}`,
      endpointRef: LOCAL_COMMAND_GATE_ENDPOINT_ID,
      script,
      scriptSha256: '0'.repeat(64),
      timeoutSeconds: 30,
      allowReadOnlyGitHubToken: false,
      env: [] as readonly string[],
      allowPrivileged,
    };
    for (const tp of rawPaths) {
      if (typeof tp !== 'string') continue;
      await validateGateToolchainPath(tp, gate, repositoryRoot, realTmpRoot);
    }
  }
}

function blocked(reason: string, detail?: string): ActionEntrypointResult {
  return detail === undefined ? { kind: 'blocked', reason } : { kind: 'blocked', reason, detail };
}

interface CommentEvaluation {
  readonly command: TaskpackCommentCommand;
  readonly guidance: string;
  readonly login: string;
  readonly authorAssociation: string;
  readonly commandId: number;
  readonly headSha: string;
}

export interface CommentEvaluationOptions {
  readonly eventName: string;
  readonly commentPrefixes: readonly string[];
  readonly commentCommands: readonly TaskpackCommentCommand[];
  readonly operatorAllowlist?: readonly string[] | undefined;
}

function readString(record: unknown, field: string): string | null {
  if (record === null || typeof record !== 'object' || Array.isArray(record)) return null;
  const value = (record as Record<string, unknown>)[field];
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function extractPreliminaryCommentCommand(
  payload: unknown,
  eventName: string,
  commentPrefixes: readonly string[],
): TaskpackCommentCommand | null {
  const isPullRequestReview = eventName === 'pull_request_review';
  const payloadRecord = payload !== null && typeof payload === 'object' && !Array.isArray(payload)
    ? payload as Record<string, unknown>
    : null;
  if (payloadRecord === null) return null;
  const action = typeof payloadRecord['action'] === 'string' ? payloadRecord['action'] : '';
  if (isPullRequestReview ? action !== 'submitted' : action !== 'created') return null;
  if (!isPullRequestReview && readObject(payloadRecord['issue'], 'pull_request') === null) return null;
  const containerRaw = payloadRecord['comment'] ?? payloadRecord['review'];
  const body = readString(containerRaw, 'body');
  const userObj = readObject(containerRaw, 'user');
  const login = readString(userObj, 'login');
  const association = readString(containerRaw, 'author_association');
  if (body === null || login === null || association === null) return null;
  const userType = readString(userObj, 'type');
  if (userType === 'Bot' || login.toLowerCase().endsWith('[bot]')) return null;
  return parseCommentCommand(body, commentPrefixes, TASKPACK_COMMENT_COMMANDS)?.command ?? null;
}

/**
 * Evaluate a comment/review event payload under the manifest trigger configuration. Bot authors (by
 * `user.type` or a `[bot]` login suffix), non-created/non-submitted actions, comments outside pull
 * requests, unknown prefixes, and commands outside the configured set are ignored; authorized actors with
 * valid guidance yield a bound evaluation.
 */
export function evaluateCommentPayload(payload: unknown, options: CommentEvaluationOptions): CommentEvaluation | { readonly blockedReason: string; readonly detail?: string } | { readonly ignoredReason: string } {
  const isPullRequestReview = options.eventName === 'pull_request_review';
  const payloadRecord = payload !== null && typeof payload === 'object' && !Array.isArray(payload) ? payload as Record<string, unknown> : null;
  const action = payloadRecord === null ? '' : typeof payloadRecord['action'] === 'string' ? payloadRecord['action'] : '';
  if (isPullRequestReview) {
    if (action !== 'submitted') return { ignoredReason: `review action ${action} is not submitted` };
  } else {
    if (action !== 'created') return { ignoredReason: `comment action ${action} is not created` };
  }
  const containerRaw = payloadRecord === null ? null : payloadRecord['comment'] ?? payloadRecord['review'];
  const body = readString(containerRaw, 'body');
  const login = readString(readObject(containerRaw, 'user'), 'login');
  const association = readString(containerRaw, 'author_association');
  if (body === null || login === null || association === null) return { blockedReason: 'event payload is missing comment attribution' };
  const userType = readString(readObject(containerRaw, 'user'), 'type');
  if (userType === 'Bot' || login.toLowerCase().endsWith('[bot]')) return { ignoredReason: 'comment author is a bot' };
  if (!isPullRequestReview) {
    const issue = payloadRecord === null ? null : payloadRecord['issue'];
    if (readObject(issue, 'pull_request') === null) return { ignoredReason: 'comment is not on a pull request' };
  }
  const command = parseCommentCommand(body, options.commentPrefixes, options.commentCommands);
  if (command === null) return { ignoredReason: 'comment without a configured command prefix or supported command' };
  if (!authorizeRepositoryActor(association, login, options.operatorAllowlist)) {
    return { blockedReason: `actor ${login} lacks write access (${association})` };
  }
  const guidance = validateCommentGuidance(command.guidance);
  if (!guidance.ok) return { blockedReason: 'comment guidance breaks the intake bounds', detail: guidance.detail };
  const issue = payloadRecord === null ? null : payloadRecord['issue'];
  const pullRequest = readObject(issue, 'pull_request');
  const head = readObject(pullRequest, 'head');
  const rawId = containerRaw !== null && typeof containerRaw === 'object' && !Array.isArray(containerRaw)
    ? (containerRaw as Record<string, unknown>)['id'] : undefined;
  const commentId = typeof rawId === 'number' && Number.isSafeInteger(rawId) && rawId > 0 ? rawId : 0;
  return {
    command: command.command,
    guidance: command.guidance,
    login,
    authorAssociation: association,
    commandId: commentId,
    headSha: readString(head, 'sha') ?? readString(pullRequest, 'sha') ?? `pr-${issue === null ? 'unknown' : String(readNumber(issue, 'number') ?? 'unknown')}`,
  };
}

function readObject(value: unknown, field: string): Record<string, unknown> | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  const child = (value as Record<string, unknown>)[field];
  return child !== null && typeof child === 'object' && !Array.isArray(child) ? child as Record<string, unknown> : null;
}

function readNumber(value: unknown, field: string): number | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  const number = (value as Record<string, unknown>)[field];
  return typeof number === 'number' && Number.isSafeInteger(number) ? number : null;
}

function shouldRotateModelCandidate(outcome: ActionDelegateOutcome): boolean {
  if (outcome.ok) return false;
  if (/reconcile_required|PUBLICATION_|GATE_/i.test(outcome.detail)) return false;
  if (outcome.retryableProviderFailure !== undefined) return outcome.retryableProviderFailure;
  return /PROVIDER_RESPONSE_INVALID|PROVIDER_TIMEOUT|MODEL_UNAVAILABLE|insufficient_quota|quota|rate_limit|http_402|http_429|1113/i.test(outcome.detail);
}

async function invokeDelegateForCandidate(
  candidate: ResolvedModelCandidate,
  taskpack: WrittenCompiledTaskpack,
  delegate: NonNullable<ActionEntrypointInput['delegate']>,
): Promise<ActionDelegateOutcome> {
  if (!candidate.usesActiveTokenEnv || candidate.token === undefined) {
    return delegate(taskpack);
  }
  const previous = process.env[LOOPWRIGHT_ACTIVE_PROVIDER_TOKEN_ENV];
  process.env[LOOPWRIGHT_ACTIVE_PROVIDER_TOKEN_ENV] = candidate.token;
  try {
    return await delegate(taskpack);
  } finally {
    if (previous === undefined) {
      delete process.env[LOOPWRIGHT_ACTIVE_PROVIDER_TOKEN_ENV];
    } else {
      process.env[LOOPWRIGHT_ACTIVE_PROVIDER_TOKEN_ENV] = previous;
    }
  }
}

function serializeSuiteMatrixJson(
  matrix: { readonly include: readonly SuiteMatrixCell[] },
  scrubber: SecretScrubber,
): string {
  const include = matrix.include.map(cell => {
    let normalizedMatrix: SuiteMatrixCell['matrix'];
    if (cell.matrix !== undefined) {
      if (Array.isArray(cell.matrix)) {
        normalizedMatrix = cell.matrix.map(entry => ({
          id: entry.id,
          platform: entry.platform,
          variant: entry.variant,
        }));
      } else {
        const sorted: Record<string, string | number | boolean> = {};
        for (const key of Object.keys(cell.matrix).sort()) {
          const val = (cell.matrix as Readonly<Record<string, string | number | boolean>>)[key];
          if (val !== undefined) sorted[key] = val;
        }
        normalizedMatrix = sorted;
      }
    }
    return {
      domainId: cell.domainId,
      taskpackPath: cell.taskpackPath,
      taskpackName: cell.taskpackName,
      manifestSha256: cell.manifestSha256,
      controlRoot: cell.controlRoot,
      baseRevision: cell.baseRevision,
      ...(cell.headSha !== undefined ? { headSha: cell.headSha } : {}),
      ...(cell.stage !== undefined ? { stage: cell.stage } : {}),
      ...(normalizedMatrix !== undefined ? { matrix: normalizedMatrix } : {}),
      protectedPaths: [...cell.protectedPaths],
    };
  });
  return scrubber.scrub(JSON.stringify({ include })).replace(/[\r\n]/g, ' ');
}

async function writeSuiteMatrixGithubOutput(
  githubOutputPath: string | undefined,
  matrix: { readonly include: readonly SuiteMatrixCell[] },
  scrubber: SecretScrubber,
): Promise<void> {
  if (githubOutputPath === undefined || githubOutputPath.trim().length === 0) return;
  const resolved = resolve(githubOutputPath);
  const parent = dirname(resolved);
  await mkdir(parent, { recursive: true });
  const parentStats = lstatSync(parent);
  if (parentStats.isSymbolicLink() || !parentStats.isDirectory()) {
    throw new GitHubAppError('ACTION_INPUT_INVALID', `output parent "${parent}" must be a non-symlink directory`);
  }
  const noFollow = 'O_NOFOLLOW' in fsConstants ? fsConstants.O_NOFOLLOW : 0;
  const serialized = serializeSuiteMatrixJson(matrix, scrubber);
  const payload = `matrix<<LOOPWRIGHT_EOF\n${serialized}\nLOOPWRIGHT_EOF\n`;
  const handle = await open(
    resolved,
    fsConstants.O_CREAT | fsConstants.O_APPEND | fsConstants.O_WRONLY | noFollow,
    0o600,
  );
  try {
    const stats = await handle.stat();
    if (!stats.isFile()) {
      throw new GitHubAppError('ACTION_INPUT_INVALID', `output sink "${resolved}" must be a regular file`);
    }
    await handle.writeFile(payload, 'utf8');
  } finally {
    await handle.close();
  }
}

/**
 * Run the complete offline-testable Action flow: qualify the host, refuse interactive MCP authentication,
 * load the target manifest (or multi-domain `TaskpackSuite`) under `policyProfile: 'github'`, validate
 * `spec.triggers` strictly before preflight or upstream discovery, run isolated 3-way baseline alignment
 * strictly before probing model candidates, compile, write trusted artifacts outside the checkout, scrub
 * them, and optionally delegate execution with fresh-session fallback across remaining healthy model candidates.
 */
export async function runGitHubActionEntrypoint(
  input: TurnkeyActionEntrypointInput & {
    readonly suitePath?: undefined;
    readonly resolveSuiteOnly?: false | undefined;
  },
): Promise<ActionEntrypointResult>;
export async function runGitHubActionEntrypoint(
  input: TurnkeyActionEntrypointInput,
): Promise<TurnkeyActionEntrypointResult>;
export async function runGitHubActionEntrypoint(
  input: TurnkeyActionEntrypointInput,
): Promise<TurnkeyActionEntrypointResult> {
  const entrypointStartedMs = performance.now();
  const runtimeEnv = input.env ?? process.env;
  const turnkeyScrubber = new SecretScrubber();
  const emitProgress = input.progressSink !== undefined
    ? (line: string) => { input.progressSink!(turnkeyScrubber.scrub(line)); }
    : undefined;

  let explicitLimitsOverride: TaskpackLimitsDeclaration;
  let envLimitsFallback: TaskpackLimitsDeclaration;
  let explicitGitAuthorName: string | undefined;
  let explicitGitAuthorEmail: string | undefined;
  try {
    envLimitsFallback = parseLoopwrightEnvLimits(runtimeEnv);
    const actionInputLimits = parseActionInputLimits(runtimeEnv);
    explicitLimitsOverride = mergeTaskpackLimits(actionInputLimits, input.limits);
    explicitGitAuthorName = parseOptionalGitIdentityInput(
      input.gitAuthorName,
      runtimeEnv['INPUT_GIT-AUTHOR-NAME'],
      validateGitAuthorName,
    );
    explicitGitAuthorEmail = parseOptionalGitIdentityInput(
      input.gitAuthorEmail,
      runtimeEnv['INPUT_GIT-AUTHOR-EMAIL'],
      validateGitAuthorEmail,
    );
  } catch (error) {
    if (error instanceof GitHubAppError) {
      return blocked(error.code, turnkeyScrubber.scrub(error.message));
    }
    throw error;
  }

  const storageProfile = input.storageProfile ?? 'actions-basic';
  const startSample = input.previousClockSample ?? systemSample();
  const preManifestWallSeconds = explicitLimitsOverride.wallTimeSeconds ?? envLimitsFallback.wallTimeSeconds;
  const basisWallTimeMs = preManifestWallSeconds !== undefined
    ? preManifestWallSeconds * 1000
    : (input.budgets?.wallTimeMs ?? DEFAULT_HOST_BUDGETS.wallTimeMs);
  const basis = input.clockBasis ?? {
    clockEpoch: input.runId,
    created: { ...startSample },
    taskDeadlineMonotonicMs: (BigInt(startSample.monotonicMs) + BigInt(basisWallTimeMs)).toString(),
  };
  await mkdir(input.runRoot, { recursive: true, mode: 0o700 }).catch(() => undefined);
  await chmod(input.runRoot, 0o700).catch(() => undefined);
  const qualification = await qualifyDeploymentHostProfile({
    platform: process.platform,
    arch: process.arch,
    nodeVersion: process.version,
    filesystemType: input.filesystemType ?? 'local-posix',
    storageProfile,
    clockBasis: basis,
    previousClockSample: startSample,
    currentClockSample: input.currentClockSample ?? systemSample(),
    hasVerifiedCheckpointLedger: true,
    autoResumeOnHostLossRequested: false,
    probeDirectory: input.probeDirectory ?? input.runRoot,
  });
  if (!qualification.ok) {
    return qualification.recommendedRunStatus === undefined
      ? { kind: 'refused', code: qualification.code, reason: qualification.reason }
      : { kind: 'refused', code: qualification.code, reason: qualification.reason, recommendedRunStatus: qualification.recommendedRunStatus };
  }
  const mcp = validateMcpAuthConfiguration({ servers: input.mcpServers ?? [], transportChallenge: input.mcpTransportChallenge ?? null });
  if (!mcp.ok) return { kind: 'refused', code: mcp.code, reason: mcp.reason };
  if (input.provider !== undefined && isOAuthOnlyPiProvider(input.provider)) {
    return {
      kind: 'refused',
      code: 'PROVIDER_OAUTH_UNSUPPORTED',
      reason: `Pi provider "${input.provider}" uses OAuth or CLI login, which Loopwright refuses; configure a token-authenticated Pi provider`,
    };
  }

  const hostPolicy: ExecutionHostPolicy = Object.freeze({
    policyProfile: 'github',
    allowPrivileged: input.hostPolicy?.allowPrivileged
      ?? input.allowPrivilegedExecution
      ?? (runtimeEnv['INPUT_ALLOW-PRIVILEGED-EXECUTION'] === 'true'),
    allowWorkflowWrites: input.hostPolicy?.allowWorkflowWrites
      ?? input.allowWorkflowWrites
      ?? (runtimeEnv['INPUT_ALLOW-WORKFLOW-WRITES'] === 'true'),
  });

  const effectiveSuitePath = (input.suitePath ?? runtimeEnv['INPUT_SUITE-PATH'])?.trim() || undefined;
  const effectiveDomain = (input.domain ?? runtimeEnv['INPUT_DOMAIN'])?.trim() || undefined;
  const rawResolveSuiteOnlyEnv = runtimeEnv['INPUT_RESOLVE-SUITE-ONLY']?.trim();
  let resolveSuiteOnly = false;
  if (input.resolveSuiteOnly !== undefined) {
    resolveSuiteOnly = input.resolveSuiteOnly;
  } else if (rawResolveSuiteOnlyEnv !== undefined && rawResolveSuiteOnlyEnv.length > 0) {
    if (rawResolveSuiteOnlyEnv === 'true') {
      resolveSuiteOnly = true;
    } else if (rawResolveSuiteOnlyEnv === 'false') {
      resolveSuiteOnly = false;
    } else {
      return blocked('ACTION_INPUT_INVALID', `resolve-suite-only must be "true" or "false" (received "${rawResolveSuiteOnlyEnv}")`);
    }
  }
  if (effectiveDomain !== undefined && effectiveSuitePath === undefined) {
    return blocked('ACTION_INPUT_INVALID', 'domain input requires suite-path');
  }
  if (resolveSuiteOnly && effectiveSuitePath === undefined) {
    return blocked('ACTION_INPUT_INVALID', 'resolve-suite-only requires suite-path');
  }

  const rawApiBaseUrl = input.githubApiBaseUrl?.trim() || runtimeEnv['GITHUB_API_URL']?.trim() || undefined;
  let effectiveApiBaseUrl: string | undefined;
  if (rawApiBaseUrl !== undefined) {
    try {
      effectiveApiBaseUrl = validateGitHubApiBaseUrl(rawApiBaseUrl, 'ACTION_INPUT_INVALID', '/githubApiBaseUrl');
    } catch (error) {
      if (error instanceof GitHubAppError) {
        return blocked(error.code, turnkeyScrubber.scrub(error.message));
      }
      throw error;
    }
  }
  const effectiveGithubOutputPath = input.githubOutputPath ?? runtimeEnv['GITHUB_OUTPUT'];
  const decisionApiKeyEnvs = Object.values(DECISION_PROVIDER_API_KEY_ENV).flat();

  let effectiveTaskpackPath = input.taskpackPath;
  let effectiveBaseRevision = input.baseRevision;
  let effectiveEventPayload: unknown = input.eventPayload;
  let effectiveTargetMatrix: readonly TargetMatrixCell[] | null | undefined = input.targetMatrix;
  let suiteExtraProtectedPaths: readonly string[] | undefined;
  let loadedSuite: LoadedTaskpackSuite | undefined;
  let suiteResolution: SuiteResolutionResult | undefined;
  let verifiedSuiteCommentMeta: VerifiedSuitePullRequestOwnership | undefined;

  if (effectiveSuitePath !== undefined) {
    try {
      loadedSuite = await loadTaskpackSuite({
        repositoryRoot: input.repositoryRoot,
        suitePath: effectiveSuitePath,
        policyProfile: 'github',
        hostPolicy,
        allowLoopbackHttp: input.allowManifestCustomBaseUrl === true,
      });
    } catch (error) {
      if (error instanceof GitHubAppError) {
        if (
          error.code === 'PROVIDER_OAUTH_UNSUPPORTED'
          || error.code === 'MCP_OAUTH_UNSUPPORTED'
          || error.code === 'TASKPACK_HOST_BINDING_INVALID'
          || (error.code === 'TASKPACK_SCOPE_VIOLATION' && error.path?.startsWith('/spec/execution') === true)
        ) {
          return { kind: 'refused', code: error.code, reason: error.message };
        }
        return blocked(error.code, turnkeyScrubber.scrub(error.message));
      }
      throw error;
    }

    for (const secretEnvKey of [
      'GITHUB_TOKEN',
      'GH_TOKEN',
      'INPUT_GITHUB-TOKEN',
      'INPUT_GITHUB-APP-PRIVATE-KEY',
      input.providerTokenEnv,
      input.credentialEnvMap?.provider,
      input.credentialEnvMap?.gate ?? 'LOOPWRIGHT_GATE_SIGNING_SECRET',
      input.credentialEnvMap?.publication ?? 'LOOPWRIGHT_PUBLICATION_SIGNING_SECRET',
      input.credentialEnvMap?.publicationAuth ?? 'LOOPWRIGHT_PUBLICATION_AUTH_TOKEN',
      input.credentialEnvMap?.localCommandGate ?? DEFAULT_LOCAL_COMMAND_GATE_ENV,
      ...Object.values(STANDARD_PI_PROVIDER_ENV),
      ...decisionApiKeyEnvs,
      ...loadedSuite.domains.flatMap(dom => [
        ...collectManifestSecretEnvNames(dom.manifest),
        ...collectMcpReferencedEnvNames(dom.manifest.spec.mcp?.servers),
      ]),
    ]) {
      if (typeof secretEnvKey === 'string' && secretEnvKey.length > 0) {
        const val = runtimeEnv[secretEnvKey];
        if (typeof val === 'string' && val.trim().length > 0) {
          turnkeyScrubber.register(val.trim());
        }
      }
    }
    if (typeof input.decisionApiKey === 'string' && input.decisionApiKey.trim().length > 0) {
      turnkeyScrubber.register(input.decisionApiKey.trim());
    }
    if (typeof input.githubToken === 'string' && input.githubToken.trim().length > 0) {
      turnkeyScrubber.register(input.githubToken.trim());
    }
    if (typeof input.githubAppPrivateKey === 'string' && input.githubAppPrivateKey.trim().length > 0) {
      turnkeyScrubber.register(input.githubAppPrivateKey.trim());
    }

    let suiteGithubToken: string | undefined;
    try {
      suiteGithubToken = await resolveGitHubToken({
        apiBaseUrl: effectiveApiBaseUrl,
        repositoryFullName: input.repositoryFullName,
        githubToken: input.githubToken,
        appId: input.githubAppId,
        appPrivateKey: input.githubAppPrivateKey,
        appInstallationId: input.githubAppInstallationId,
        fetchImpl: input.probeFetch,
        scrubber: turnkeyScrubber,
        env: runtimeEnv,
      });
    } catch (error) {
      if (error instanceof GitHubAppError) {
        return blocked(error.code, turnkeyScrubber.scrub(error.message));
      }
      throw error;
    }

    if (input.eventName === 'issue_comment' || input.eventName === 'pull_request_review') {
      const prLookup = await verifySuiteCommentPullRequest({
        suite: loadedSuite,
        eventName: input.eventName,
        eventPayload: input.eventPayload,
        repositoryFullName: input.repositoryFullName,
        apiBaseUrl: effectiveApiBaseUrl,
        explicitDomain: effectiveDomain,
        resolveToken: () => suiteGithubToken,
        commentPrefixes: input.commentPrefixes,
        operatorAllowlist: input.operatorAllowlist,
        fetchImpl: input.probeFetch,
        scrubber: turnkeyScrubber,
      });
      if (prLookup.kind === 'verified') {
        verifiedSuiteCommentMeta = prLookup.value;
      } else if (prLookup.kind !== 'ignored') {
        try {
          await writeSuiteMatrixGithubOutput(
            effectiveGithubOutputPath,
            { include: Object.freeze([]) },
            turnkeyScrubber,
          );
        } catch (outErr) {
          if (outErr instanceof GitHubAppError) {
            return blocked(outErr.code, turnkeyScrubber.scrub(outErr.message));
          }
          throw outErr;
        }
        const blockedReason = (prLookup.kind === 'lookup_failed' || prLookup.kind === 'metadata_unavailable')
          ? prLookup.reason
          : prLookup.code;
        return blocked(blockedReason, turnkeyScrubber.scrub(prLookup.detail));
      }
    }

    const allowOfflineStagePrCheck = input.dryRun === true
      && !resolveSuiteOnly
      && effectiveApiBaseUrl === undefined
      && input.probeFetch === undefined
      && suiteGithubToken === undefined;

    suiteResolution = await resolveTaskpackSuite({
      repositoryRoot: input.repositoryRoot,
      loadedSuite,
      suitePath: effectiveSuitePath,
      policyProfile: 'github',
      hostPolicy,
      allowLoopbackHttp: input.allowManifestCustomBaseUrl === true,
      baseRevision: input.baseRevision,
      eventName: input.eventName,
      eventPayload: input.eventPayload,
      schedule: input.schedule,
      domain: effectiveDomain,
      ...(verifiedSuiteCommentMeta !== undefined
        ? {
          prHeadRef: verifiedSuiteCommentMeta.prHeadRef,
          prBaseRef: verifiedSuiteCommentMeta.prBaseRef,
          prHeadSha: verifiedSuiteCommentMeta.prHeadSha,
          prHeadRepoFullName: input.repositoryFullName,
          prHeadRepoFork: false,
        }
        : {}),
      operatorAllowlist: input.operatorAllowlist,
      repositoryFullName: input.repositoryFullName,
      apiBaseUrl: effectiveApiBaseUrl,
      githubToken: suiteGithubToken,
      fetchImpl: input.probeFetch,
      scrubber: turnkeyScrubber,
      env: runtimeEnv,
      discoverUpstreamUpdates: !allowOfflineStagePrCheck,
      allowOfflineStagePrCheck,
    });

    if (
      input.commentPrefixes !== undefined
      && suiteResolution.comment !== undefined
      && !input.commentPrefixes.includes(suiteResolution.comment.prefix)
    ) {
      const emptyMatrix = Object.freeze({ include: Object.freeze<readonly SuiteMatrixCell[]>([]) });
      try {
        await writeSuiteMatrixGithubOutput(effectiveGithubOutputPath, emptyMatrix, turnkeyScrubber);
      } catch (outErr) {
        if (outErr instanceof GitHubAppError) {
          return blocked(outErr.code, turnkeyScrubber.scrub(outErr.message));
        }
        throw outErr;
      }
      const ignoredSuite: SuiteResolutionResult = Object.freeze({
        ...suiteResolution,
        disposition: 'ignored',
        reason: 'comment_prefix_not_configured_for_domain',
        cells: Object.freeze([]),
        eligibleCells: Object.freeze([]),
        matrix: emptyMatrix,
      });
      return {
        kind: 'ignored',
        disposition: 'ignored',
        reason: ignoredSuite.reason,
        suite: ignoredSuite,
        matrix: emptyMatrix,
      };
    }

    try {
      await writeSuiteMatrixGithubOutput(
        effectiveGithubOutputPath,
        suiteResolution.matrix,
        turnkeyScrubber,
      );
    } catch (outErr) {
      if (outErr instanceof GitHubAppError) {
        return blocked(outErr.code, turnkeyScrubber.scrub(outErr.message));
      }
      throw outErr;
    }

    if (suiteResolution.disposition === 'blocked') {
      return blocked(
        suiteResolution.code ?? suiteResolution.reason,
        suiteResolution.detail !== undefined
          ? turnkeyScrubber.scrub(suiteResolution.detail)
          : turnkeyScrubber.scrub(suiteResolution.reason),
      );
    }

    if (
      resolveSuiteOnly
      || suiteResolution.disposition === 'deferred'
      || suiteResolution.disposition === 'ignored'
    ) {
      return {
        kind: suiteResolution.disposition,
        disposition: suiteResolution.disposition,
        reason: suiteResolution.reason,
        ...(suiteResolution.detail !== undefined ? { detail: suiteResolution.detail } : {}),
        suite: suiteResolution,
        matrix: suiteResolution.matrix,
      };
    }

    const selectedCell = effectiveDomain !== undefined
      ? suiteResolution.eligibleCells.find(c => c.domainId === effectiveDomain)
      : (suiteResolution.eligibleCells.length === 1 ? suiteResolution.eligibleCells[0] : undefined);
    if (selectedCell === undefined) {
      return blocked(
        'ACTION_INPUT_INVALID',
        `suite "${loadedSuite.manifest.metadata.name}" resolved ${suiteResolution.eligibleCells.length} eligible domains (${suiteResolution.eligibleCells.map(c => c.domainId).join(', ')}); pass domain or resolve-suite-only: true`,
      );
    }
    const selectedDomain: LoadedTaskpackSuiteDomain | undefined = loadedSuite.domains.find(
      d => d.id === selectedCell.domainId,
    );
    if (selectedDomain === undefined) {
      return blocked('TASKPACK_MANIFEST_INVALID', `resolved suite domain "${selectedCell.domainId}" is missing`);
    }

    effectiveTaskpackPath = selectedDomain.taskpackPath;
    effectiveBaseRevision = selectedCell.baseRevision;
    suiteExtraProtectedPaths = selectedDomain.protectedPaths;
    if (effectiveTargetMatrix === undefined && Array.isArray(selectedDomain.matrix)) {
      effectiveTargetMatrix = selectedDomain.matrix;
    }
    if (verifiedSuiteCommentMeta !== undefined && isPlainRecord(input.eventPayload)) {
      const existingPr = isPlainRecord(input.eventPayload['pull_request']) ? input.eventPayload['pull_request'] : {};
      effectiveEventPayload = {
        ...input.eventPayload,
        pull_request: {
          ...existingPr,
          ...(verifiedSuiteCommentMeta.prNumber !== undefined ? { number: verifiedSuiteCommentMeta.prNumber } : {}),
          head: {
            ref: verifiedSuiteCommentMeta.prHeadRef,
            sha: verifiedSuiteCommentMeta.prHeadSha,
            repo: { full_name: input.repositoryFullName, fork: false },
          },
          base: {
            ref: verifiedSuiteCommentMeta.prBaseRef,
            ...(verifiedSuiteCommentMeta.prBaseSha !== undefined ? { sha: verifiedSuiteCommentMeta.prBaseSha } : {}),
            repo: { full_name: input.repositoryFullName, fork: false },
          },
        },
      };
    }
  }

  let manifest: TaskpackManifest;
  if (loadedSuite !== undefined && effectiveTaskpackPath !== undefined) {
    const boundDomain = loadedSuite.domains.find(d => d.taskpackPath === effectiveTaskpackPath);
    if (boundDomain === undefined) {
      return blocked('TASKPACK_MANIFEST_INVALID', `suite domain at "${effectiveTaskpackPath}" was not found`);
    }
    manifest = boundDomain.manifest;
  } else {
    const manifestPath = join(input.repositoryRoot, effectiveTaskpackPath ?? '.loopwright/taskpack.yaml');
    try {
      manifest = await loadDeclarativeTaskpack({
        manifestPath,
        repositoryRoot: input.repositoryRoot,
        policyProfile: 'github',
        hostPolicy,
      });
    } catch (error) {
      if (error instanceof GitHubAppError) {
        if (
          error.code === 'PROVIDER_OAUTH_UNSUPPORTED'
          || error.code === 'MCP_OAUTH_UNSUPPORTED'
          || error.code === 'TASKPACK_HOST_BINDING_INVALID'
          || (error.code === 'TASKPACK_SCOPE_VIOLATION' && error.path?.startsWith('/spec/execution') === true)
        ) {
          return { kind: 'refused', code: error.code, reason: error.message };
        }
        return blocked('target repository manifest failed validation', 'loadDeclarativeTaskpack refused the manifest');
      }
      throw error;
    }
  }

  let effectiveMcpDecls: readonly TaskpackMcpServerDeclaration[];
  try {
    const overrideMcpDecls = input.mcpServerConfigs ?? parseMcpServersOverride(
      input.mcpServersJson ?? runtimeEnv['INPUT_MCP-SERVERS'] ?? runtimeEnv['LOOPWRIGHT_MCP_SERVERS'],
      input.allowManifestCustomBaseUrl === true,
    );
    effectiveMcpDecls = mergeMcpServerDeclarations(manifest.spec.mcp?.servers, overrideMcpDecls);
  } catch (error) {
    if (error instanceof GitHubAppError) {
      if (error.code === 'MCP_OAUTH_UNSUPPORTED') {
        return { kind: 'refused', code: 'MCP_OAUTH_UNSUPPORTED', reason: error.message };
      }
      return blocked(error.code, error.message);
    }
    throw error;
  }

  resolveActionOutputFormats(input.output, manifest);

  let effectiveBaselineOverride: BaselineAlignmentOverride | undefined;
  let effectiveBaselineConfig: ResolvedBaselineAlignmentConfig;
  try {
    const rawAlignEnv = runtimeEnv['INPUT_BASELINE-ALIGNMENT']?.trim();
    effectiveBaselineOverride = input.baselineAlignment
      ?? (rawAlignEnv !== undefined && rawAlignEnv.length > 0
        ? parseBaselineAlignmentPolicy(rawAlignEnv)
        : undefined);
    effectiveBaselineConfig = resolveBaselineAlignmentConfig(
      manifest.spec.baselineAlignment,
      effectiveBaselineOverride,
    );
  } catch (error) {
    if (error instanceof GitHubAppError) {
      return blocked(error.code, turnkeyScrubber.scrub(error.message));
    }
    throw error;
  }

  // Register known host secrets onto turnkeyScrubber BEFORE any preflight script or external call runs.
  const manifestSecretEnvs = collectManifestSecretEnvNames(manifest);
  for (const secretEnvKey of [
    'GITHUB_TOKEN',
    'GH_TOKEN',
    'INPUT_GITHUB-TOKEN',
    'INPUT_GITHUB-APP-PRIVATE-KEY',
    input.providerTokenEnv,
    input.credentialEnvMap?.provider,
    input.credentialEnvMap?.gate ?? 'LOOPWRIGHT_GATE_SIGNING_SECRET',
    input.credentialEnvMap?.publication ?? 'LOOPWRIGHT_PUBLICATION_SIGNING_SECRET',
    input.credentialEnvMap?.publicationAuth ?? 'LOOPWRIGHT_PUBLICATION_AUTH_TOKEN',
    input.credentialEnvMap?.localCommandGate ?? DEFAULT_LOCAL_COMMAND_GATE_ENV,
    ...Object.values(STANDARD_PI_PROVIDER_ENV),
    ...decisionApiKeyEnvs,
    ...manifestSecretEnvs,
    ...collectMcpReferencedEnvNames(effectiveMcpDecls),
  ]) {
    if (typeof secretEnvKey === 'string' && secretEnvKey.length > 0) {
      const val = runtimeEnv[secretEnvKey];
      if (typeof val === 'string' && val.trim().length > 0) {
        turnkeyScrubber.register(val.trim());
      }
    }
  }
  if (typeof input.decisionApiKey === 'string' && input.decisionApiKey.trim().length > 0) {
    turnkeyScrubber.register(input.decisionApiKey.trim());
  }
  if (typeof input.githubToken === 'string' && input.githubToken.trim().length > 0) {
    turnkeyScrubber.register(input.githubToken.trim());
  }
  if (typeof input.githubAppPrivateKey === 'string' && input.githubAppPrivateKey.trim().length > 0) {
    turnkeyScrubber.register(input.githubAppPrivateKey.trim());
  }

  // Enforce manifest spec.triggers eligibility and comment/review actor authorization STRICTLY BEFORE running spec.preflight!
  let preEvaluatedComment: ReturnType<typeof evaluateCommentPayload> | undefined;
  if (!eventNameIsTrigger(input.eventName) && input.eventName !== 'issue_comment' && input.eventName !== 'pull_request_review') {
    if (!hasAnyDeclaredGitHubTrigger(manifest.spec.triggers)) {
      return {
        kind: 'refused',
        code: 'TASKPACK_TRIGGER_UNSUPPORTED',
        reason: `GitHub event "${input.eventName}" is not enabled in spec.triggers`,
      };
    }
    return blocked(`unsupported event ${input.eventName}`);
  }
  if (eventNameIsTrigger(input.eventName)) {
    if (!isGitHubTriggerDeclared(manifest.spec.triggers, input.eventName)) {
      return {
        kind: 'refused',
        code: 'TASKPACK_TRIGGER_UNSUPPORTED',
        reason: `GitHub event "${input.eventName}" is not enabled in spec.triggers`,
      };
    }
    if (input.eventName === 'release') {
      const releaseAction = isPlainRecord(input.eventPayload) && typeof input.eventPayload['action'] === 'string'
        ? input.eventPayload['action']
        : undefined;
      if (releaseAction !== 'published') {
        return {
          kind: 'refused',
          code: 'TASKPACK_TRIGGER_UNSUPPORTED',
          reason: releaseAction === undefined
            ? 'release event payload is missing required action "published"'
            : `release action "${releaseAction}" is not enabled in spec.triggers`,
        };
      }
    }
  }
  if (input.eventName === 'issue_comment' || input.eventName === 'pull_request_review') {
    if (!isGitHubTriggerDeclared(manifest.spec.triggers, input.eventName)) {
      return {
        kind: 'refused',
        code: 'TASKPACK_TRIGGER_UNSUPPORTED',
        reason: `GitHub event "${input.eventName}" is not enabled in spec.triggers.commentCommands`,
      };
    }
    if (suiteResolution?.comment !== undefined && verifiedSuiteCommentMeta !== undefined) {
      if (
        !isGitHubTriggerDeclared(manifest.spec.triggers, {
          eventName: input.eventName,
          commentCommand: suiteResolution.comment.command,
        })
      ) {
        return {
          kind: 'refused',
          code: 'TASKPACK_TRIGGER_UNSUPPORTED',
          reason: `comment command "${suiteResolution.comment.command}" is not enabled in spec.triggers.commentCommands`,
        };
      }
      preEvaluatedComment = {
        command: suiteResolution.comment.command,
        guidance: suiteResolution.comment.guidance,
        login: verifiedSuiteCommentMeta.login,
        authorAssociation: verifiedSuiteCommentMeta.authorAssociation,
        commandId: verifiedSuiteCommentMeta.commandId,
        headSha: verifiedSuiteCommentMeta.prHeadSha,
      };
    } else {
      const effectivePrefixes = input.commentPrefixes ?? manifest.spec.triggers.commentPrefixes;
      const preliminaryCmd = extractPreliminaryCommentCommand(input.eventPayload, input.eventName, effectivePrefixes);
      if (
        preliminaryCmd !== null
        && !isGitHubTriggerDeclared(manifest.spec.triggers, {
          eventName: input.eventName,
          commentCommand: preliminaryCmd,
        })
      ) {
        return {
          kind: 'refused',
          code: 'TASKPACK_TRIGGER_UNSUPPORTED',
          reason: `comment command "${preliminaryCmd}" is not enabled in spec.triggers.commentCommands`,
        };
      }
      preEvaluatedComment = evaluateCommentPayload(input.eventPayload, {
        eventName: input.eventName,
        commentPrefixes: effectivePrefixes,
        commentCommands: manifest.spec.triggers.commentCommands,
        operatorAllowlist: input.operatorAllowlist,
      });
      if ('ignoredReason' in preEvaluatedComment) {
        return blocked(`comment ignored: ${preEvaluatedComment.ignoredReason}`);
      }
      if ('blockedReason' in preEvaluatedComment) {
        return blocked(preEvaluatedComment.blockedReason, preEvaluatedComment.detail);
      }
    }
  }

  const turnkeyEnabled = input.turnkey === true && input.dryRun !== true;
  let effectiveRepositoryId = input.repositoryId ?? 0;
  let effectiveInstallationId = input.installationId ?? 0;
  const explicitSourceRevision = (input.sourceRevision ?? runtimeEnv['INPUT_SOURCE-REVISION'])?.trim() || undefined;
  let effectiveSourceRevision = explicitSourceRevision
    ?? verifiedSuiteCommentMeta?.prHeadSha
    ?? effectiveBaseRevision;
  let effectiveUpstreamRecords = input.upstreamRecords;
  let githubToken: string | undefined;
  let gitCommitIdentity: GitCommitIdentity = Object.freeze({
    name: explicitGitAuthorName ?? DEFAULT_GIT_COMMIT_IDENTITY.name,
    email: explicitGitAuthorEmail ?? DEFAULT_GIT_COMMIT_IDENTITY.email,
  });
  let openManagedPr: ManagedPullRequestInfo | null = null;
  let managedPrMatchesDiscoveredState = input.managedPrMatchesDiscoveredState;
  let preflightResult: RunTaskpackPreflightResult | undefined;

  try {
    if (turnkeyEnabled) {
      try {
        const effectivePolicy = resolveEffectiveTaskpackSandboxPolicy(manifest, {
          workspaceRoot: input.repositoryRoot,
          relativeTaskpackPath: effectiveTaskpackPath,
          env: runtimeEnv,
          policyProfile: 'github',
          hostPolicy,
        });
        const negotiated = negotiateSandboxBackend(effectivePolicy, {
          platform: process.platform,
          arch: process.arch,
        });
        if (input.delegate === undefined && negotiated.backendId === 'docker') {
          return blocked(
            'SANDBOX_POLICY_INVALID',
            'turnkey host-session mode runs without Docker; docker sandbox backend cannot be used when delegate is unset',
          );
        }
      } catch (error) {
        if (error instanceof GitHubAppError) {
          return blocked(error.code, error.message);
        }
        throw error;
      }

      try {
        const resolvedAuth = await resolveGitHubAuth({
          apiBaseUrl: effectiveApiBaseUrl,
          repositoryFullName: input.repositoryFullName,
          repositoryId: effectiveRepositoryId > 0 ? effectiveRepositoryId : undefined,
          githubToken: input.githubToken,
          appId: input.githubAppId,
          appPrivateKey: input.githubAppPrivateKey,
          appInstallationId: input.githubAppInstallationId,
          gitAuthorName: explicitGitAuthorName,
          gitAuthorEmail: explicitGitAuthorEmail,
          fetchImpl: input.probeFetch,
          scrubber: turnkeyScrubber,
          env: runtimeEnv,
        });
        githubToken = resolvedAuth.token;
        gitCommitIdentity = resolvedAuth.gitCommitIdentity;
        if (effectiveInstallationId <= 0 && resolvedAuth.installationId !== undefined) {
          effectiveInstallationId = resolvedAuth.installationId;
        }
        const commentCommand = preEvaluatedComment !== undefined
          && !('ignoredReason' in preEvaluatedComment)
          && !('blockedReason' in preEvaluatedComment)
          ? preEvaluatedComment.command
          : undefined;
        const preserveExplicitSourceRevision = shouldPreserveExplicitSourceRevision({
          eventName: input.eventName,
          explicitSourceRevision,
          commentCommand,
        });
        const resolvedRepo = await resolveRepositoryAndRevisions({
          repositoryRoot: input.repositoryRoot,
          repositoryFullName: input.repositoryFullName,
          baseRevision: effectiveBaseRevision,
          sourceRevision: explicitSourceRevision,
          preserveExplicitSourceRevision,
          eventName: input.eventName,
          eventPayload: effectiveEventPayload,
          apiBaseUrl: effectiveApiBaseUrl,
          githubToken,
          fetchImpl: input.probeFetch,
          scrubber: turnkeyScrubber,
          env: runtimeEnv,
        });
        effectiveRepositoryId = input.repositoryId !== undefined && input.repositoryId > 0
          ? input.repositoryId
          : resolvedRepo.repositoryId;
        effectiveBaseRevision = resolvedRepo.baseRevision;
        effectiveSourceRevision = resolvedRepo.sourceRevision;
      } catch (error) {
        if (error instanceof GitHubAppError) {
          return blocked(error.code, turnkeyScrubber.scrub(error.message));
        }
        throw error;
      }
    } else if (
      (explicitSourceRevision !== undefined || verifiedSuiteCommentMeta !== undefined)
      && existsSync(join(input.repositoryRoot, '.git'))
    ) {
      try {
        effectiveBaseRevision = await resolveGitCommitSha(input.repositoryRoot, effectiveBaseRevision);
        if (explicitSourceRevision !== undefined) {
          effectiveSourceRevision = explicitSourceRevision === input.baseRevision
            ? effectiveBaseRevision
            : await resolveGitCommitSha(input.repositoryRoot, explicitSourceRevision);
        } else if (verifiedSuiteCommentMeta !== undefined) {
          effectiveSourceRevision = verifiedSuiteCommentMeta.prHeadSha;
        }
      } catch (error) {
        if (error instanceof GitHubAppError) {
          return blocked(error.code, turnkeyScrubber.scrub(error.message));
        }
        throw error;
      }
    }

    const isStatusComment = preEvaluatedComment !== undefined
      && !('ignoredReason' in preEvaluatedComment)
      && !('blockedReason' in preEvaluatedComment)
      && preEvaluatedComment.command === 'status';

    if (manifest.spec.preflight !== undefined && !isStatusComment) {
      try {
        preflightResult = await runTaskpackPreflight({
          manifest,
          repositoryRoot: input.repositoryRoot,
          authorized: true,
          hostPolicy,
          scrubber: turnkeyScrubber,
          env: runtimeEnv,
          tempRoot: input.runRoot,
        });
      } catch (error) {
        if (error instanceof GitHubAppError) {
          if (
            error.code === 'TASKPACK_HOST_BINDING_INVALID'
            || (error.code === 'TASKPACK_SCOPE_VIOLATION' && error.path?.startsWith('/spec/execution') === true)
          ) {
            return { kind: 'refused', code: error.code, reason: turnkeyScrubber.scrub(error.message) };
          }
          return blocked(error.code, turnkeyScrubber.scrub(error.message));
        }
        throw error;
      }
      if (preflightResult.disposition === 'blocked') {
        return blocked('preflight blocked execution', preflightResult.reason ?? 'preflight returned disposition=blocked');
      }
      if (effectiveUpstreamRecords === undefined && preflightResult.upstreams.length > 0) {
        effectiveUpstreamRecords = preflightResult.upstreams;
      }
    }

    if (turnkeyEnabled) {
      if (
        effectiveUpstreamRecords === undefined
        && (input.upstreamRecordsJson !== undefined || (manifest.spec.preflight === undefined && manifest.spec.upstreams.length > 0))
      ) {
        try {
          const discovered = await discoverTaskpackUpstreamsV2(manifest, {
            repositoryRoot: input.repositoryRoot,
            apiBaseUrl: effectiveApiBaseUrl,
            githubToken,
            upstreamRecordsJson: input.upstreamRecordsJson,
            fetchImpl: input.probeFetch,
            scrubber: turnkeyScrubber,
            env: runtimeEnv,
          });
          effectiveUpstreamRecords = discovered.records;
        } catch (error) {
          if (error instanceof GitHubAppError) {
            return blocked(error.code, turnkeyScrubber.scrub(error.message));
          }
          throw error;
        }
      }

      if (
        manifest.spec.publication.mode === 'pull_request'
        && input.publicationEndpoint === undefined
        && (input.mode === 'candidate' || input.mode === 'auto')
        && (effectiveApiBaseUrl !== undefined || githubToken !== undefined)
      ) {
        try {
          openManagedPr = await findOpenManagedPullRequest({
            apiBaseUrl: effectiveApiBaseUrl,
            repositoryFullName: input.repositoryFullName,
            targetBranch: manifest.spec.publication.targetBranch,
            headBranchPrefix: manifest.spec.publication.headBranchPrefix,
            githubToken,
            fetchImpl: input.probeFetch,
            scrubber: turnkeyScrubber,
            env: runtimeEnv,
          });
        } catch (error) {
          if (error instanceof GitHubAppError) {
            return blocked(error.code, turnkeyScrubber.scrub(error.message));
          }
          throw error;
        }
      }

      if (
        managedPrMatchesDiscoveredState === undefined
        && openManagedPr !== null
        && effectiveUpstreamRecords !== undefined
        && effectiveUpstreamRecords.length > 0
      ) {
        managedPrMatchesDiscoveredState = await checkManagedPrMatchesDiscoveredState({
          repositoryRoot: input.repositoryRoot,
          repositoryFullName: input.repositoryFullName,
          manifest,
          openManagedPr,
          records: effectiveUpstreamRecords,
          apiBaseUrl: effectiveApiBaseUrl,
          githubToken,
          fetchImpl: input.probeFetch,
          scrubber: turnkeyScrubber,
          env: runtimeEnv,
        });
      }
    } else if (input.upstreamRecords === undefined && input.upstreamRecordsJson !== undefined) {
      try {
        const discovered = await discoverTaskpackUpstreamsV2(manifest, {
          repositoryRoot: input.repositoryRoot,
          upstreamRecordsJson: input.upstreamRecordsJson,
          scrubber: turnkeyScrubber,
          env: runtimeEnv,
        });
        effectiveUpstreamRecords = discovered.records;
      } catch (error) {
        if (error instanceof GitHubAppError) {
          return blocked(error.code, turnkeyScrubber.scrub(error.message));
        }
        throw error;
      }
    }

    if (effectiveUpstreamRecords !== undefined && effectiveUpstreamRecords.length > 0) {
      emitProgress?.(
        `upstreams: ${effectiveUpstreamRecords.map(r => `${r.upstreamId}=${r.status}${r.version ? `(${r.version})` : ''}`).join(', ')}`,
      );
    }

    const tenant = {
      installationId: effectiveInstallationId,
      repositoryId: effectiveRepositoryId,
      repositoryFullName: input.repositoryFullName,
      taskpackId: manifest.metadata.name,
    };
    let intake: TaskpackIntakeOutcome;
    let reviseGuidance: string | undefined;
    let autoCheckOnlyNoChangeReason: string | null = null;
    const forceDiscovery = (input.force ?? (runtimeEnv['INPUT_FORCE'] === 'true')) === true
      && (input.mode === 'candidate' || input.mode === 'auto');
    const runDiscoverIntake = (allowForce: boolean, bypassManagedPrDedupe = false) => {
      if (
        !allowForce
        && preflightResult !== undefined
        && preflightResult.disposition === 'no_change'
      ) {
        const pfReason = preflightResult.reason ?? 'preflight reported no_change';
        emitProgress?.(`intake: no_change (${pfReason})`);
        if (input.mode === 'auto') {
          autoCheckOnlyNoChangeReason = pfReason;
          return {
            ok: true as const,
            intake: {
              kind: 'discover' as const,
              disposition: 'no_change' as const,
              updates: [],
              failures: [],
              reason: pfReason,
              summary: pfReason,
              targetMatrix: effectiveTargetMatrix ?? manifest.spec.target?.matrix ?? null,
            } as TaskpackIntakeOutcome,
          };
        }
        return { ok: false as const, exit: { kind: 'no_change' as const, reason: pfReason } };
      }
      if (
        allowForce
        && preflightResult !== undefined
        && (effectiveUpstreamRecords === undefined || effectiveUpstreamRecords.length === 0)
      ) {
        return {
          ok: true as const,
          intake: {
            kind: 'discover' as const,
            disposition: 'ready' as const,
            baseRevision: effectiveBaseRevision,
            updates: [],
            targetMatrix: effectiveTargetMatrix ?? manifest.spec.target?.matrix ?? null,
          },
        };
      }
      if (
        preflightResult !== undefined
        && preflightResult.disposition === 'candidate'
        && (effectiveUpstreamRecords === undefined || effectiveUpstreamRecords.length === 0)
      ) {
        return {
          ok: true as const,
          intake: {
            kind: 'discover' as const,
            disposition: 'ready' as const,
            baseRevision: effectiveBaseRevision,
            updates: [],
            targetMatrix: effectiveTargetMatrix ?? manifest.spec.target?.matrix ?? null,
          },
        };
      }
      const outcome = prepareTaskpackIntake({
        mode: 'discover', tenant, baseRevision: effectiveBaseRevision,
        records: effectiveUpstreamRecords ?? [],
        ...(allowForce ? { force: true } : {}),
        ...(!bypassManagedPrDedupe && managedPrMatchesDiscoveredState !== undefined ? { managedPrMatchesDiscoveredState } : {}),
        targetMatrix: effectiveTargetMatrix ?? manifest.spec.target?.matrix ?? null,
      });
      if (outcome.kind === 'discover' && outcome.disposition === 'no_change') {
        emitProgress?.(`intake: no_change (${outcome.reason})`);
        if (input.mode === 'auto') {
          autoCheckOnlyNoChangeReason = outcome.reason;
          return { ok: true as const, intake: outcome };
        }
        return { ok: false as const, exit: { kind: 'no_change' as const, reason: outcome.reason } };
      }
      if (outcome.kind === 'discover' && outcome.disposition === 'blocked') {
        return {
          ok: false as const,
          exit: blocked('upstream sources are unavailable', outcome.failures.map(failure => `${failure.upstreamId}: ${failure.error}`).join('; ')),
        };
      }
      return { ok: true as const, intake: outcome };
    };
    if (eventNameIsTrigger(input.eventName)) {
      const discovered = runDiscoverIntake(forceDiscovery);
      if (!discovered.ok) return discovered.exit;
      intake = discovered.intake;
    } else if (input.eventName === 'issue_comment' || input.eventName === 'pull_request_review') {
      const evaluation = preEvaluatedComment!;
      if ('ignoredReason' in evaluation) return blocked(`comment ignored: ${evaluation.ignoredReason}`);
      if ('blockedReason' in evaluation) return blocked(evaluation.blockedReason, evaluation.detail);
      const commandDigest = createHash('sha256').update(evaluation.guidance, 'utf8').digest('hex');
      if (evaluation.command === 'status') {
        intake = { kind: 'status', disposition: 'ready', summary: `status query admitted for ${input.repositoryFullName}/${manifest.metadata.name}` };
      } else if (evaluation.command === 'revise') {
        const boundHeadSha = evaluation.headSha.startsWith('pr-') && COMMIT_SHA_PATTERN.test(effectiveSourceRevision)
          ? effectiveSourceRevision
          : evaluation.headSha;
        const reviseInput = {
          mode: 'revise' as const, tenant,
          command: { commandId: evaluation.commandId, headSha: boundHeadSha, commandDigest },
          actorLogin: evaluation.login, authorAssociation: evaluation.authorAssociation,
          guidance: evaluation.guidance,
          ...(input.operatorAllowlist !== undefined ? { operatorAllowlist: input.operatorAllowlist } : {}),
        };
        const outcome = prepareTaskpackIntake(reviseInput);
        if (outcome.kind === 'revise' && outcome.disposition === 'blocked') return blocked(`revise command rejected: ${outcome.reason}`, outcome.detail);
        reviseGuidance = evaluation.guidance;
        intake = outcome;
      } else {
        // PR comment commands follow comment-command dispatch semantics; force applies only to non-comment trigger events.
        // Explicit operator `retry` comments bypass open-PR deduplication while still settling `no_change` if no updates are available.
        const discovered = runDiscoverIntake(false, true);
        if (!discovered.ok) return discovered.exit;
        if (evaluation.guidance.trim().length > 0) {
          reviseGuidance = evaluation.guidance;
        }
        intake = discovered.intake;
      }
    } else {
      return blocked(`unsupported event ${input.eventName}`);
    }

    emitProgress?.(
      `intake: taskpack=${manifest.metadata.name} mode=${input.mode} repo=${input.repositoryFullName} base=${effectiveBaseRevision.slice(0, 12)} kind=${intake.kind}`,
    );

    let modelsConfig: ParsedPiModelsJson | undefined;
    if (input.modelsJsonPath !== undefined) {
      try {
        modelsConfig = await loadPiModelsJson(input.modelsJsonPath);
      } catch (error) {
        if (error instanceof GitHubAppError) {
          if (error.code === 'PROVIDER_OAUTH_UNSUPPORTED') {
            return { kind: 'refused', code: 'PROVIDER_OAUTH_UNSUPPORTED', reason: error.message };
          }
          return blocked(error.code, error.message);
        }
        throw error;
      }
    }

    const scrubber = turnkeyScrubber;
    const gateEnvName = input.credentialEnvMap?.gate ?? 'LOOPWRIGHT_GATE_SIGNING_SECRET';
    const publicationEnvName = input.credentialEnvMap?.publication ?? 'LOOPWRIGHT_PUBLICATION_SIGNING_SECRET';
    const publicationAuthEnvName = input.credentialEnvMap?.publicationAuth ?? 'LOOPWRIGHT_PUBLICATION_AUTH_TOKEN';
    const localCmdGateEnvName = input.credentialEnvMap?.localCommandGate ?? DEFAULT_LOCAL_COMMAND_GATE_ENV;
    if (typeof runtimeEnv[gateEnvName] === 'string') scrubber.register(runtimeEnv[gateEnvName]!);
    if (typeof runtimeEnv[publicationEnvName] === 'string') scrubber.register(runtimeEnv[publicationEnvName]!);
    if (typeof runtimeEnv[publicationAuthEnvName] === 'string') scrubber.register(runtimeEnv[publicationAuthEnvName]!);
    if (typeof runtimeEnv[localCmdGateEnvName] === 'string') scrubber.register(runtimeEnv[localCmdGateEnvName]!);

    const hasHostRoleOverrides = input.provider !== undefined
      || input.model !== undefined
      || input.thinking !== undefined
      || input.api !== undefined
      || input.baseUrl !== undefined;
    const roleSelection: HostRoleSelection | undefined = hasHostRoleOverrides
      ? {
        provider: input.provider,
        model: input.model,
        thinking: input.thinking,
        api: input.api,
        baseUrl: input.baseUrl,
      }
      : undefined;

    const isAutoNoChange = input.mode === 'auto' && autoCheckOnlyNoChangeReason !== null;
    const effectiveCompileMode: 'candidate' | 'no-change' = (input.mode === 'no-change' || isAutoNoChange)
      ? 'no-change'
      : 'candidate';

    const needsNativePublicationEndpoint = manifest.spec.publication.mode === 'pull_request'
      && input.publicationEndpoint === undefined
      && effectiveCompileMode === 'candidate';
    const DRY_RUN_PUBLICATION_SENTINEL_URL = 'http://127.0.0.1:65535/loopwright-dry-run-publication';

    let activeGateEndpoints: readonly HostGateEndpointPlan[] = input.gateEndpoints ?? [];
    let activePublicationEndpoint: HostPublicationEndpointPlan | null = input.publicationEndpoint ?? (
      input.dryRun === true && needsNativePublicationEndpoint
        ? {
          id: 'dry-run-publication',
          url: DRY_RUN_PUBLICATION_SENTINEL_URL,
          signingCredentialRef: 'taskpack-publication-signing',
        }
        : null
    );
    let mcpRegistry: HostMcpRegistry | undefined;

    let baselineAlignmentResult: BaselineAlignmentResult | undefined;
    let enableBaselineConflictGate = false;
    let extractedConflictPaths: readonly string[] | undefined;

    let trackedSourceTokenEnvNames: readonly string[] = input.providerTokenEnv !== undefined
      ? [input.providerTokenEnv]
      : [];
    const loggedMemoryWarnings = new Set<string>();
    const buildBindings = (candidate?: ResolvedModelCandidate): HostTaskpackBindings => {
      const externalMcpTools = mcpRegistry !== undefined && mcpRegistry.toolNames.length > 0
        ? mcpRegistry.toolNames
        : undefined;
      const externalMcpToolSchemas = mcpRegistry !== undefined && externalMcpTools !== undefined
        ? mcpRegistry.toolSchemasFor(externalMcpTools)
        : undefined;
      const acceptanceCheckIds = [
        ...manifest.spec.verification.localChecks.map(c => c.id),
        ...manifest.spec.verification.externalGates.map(g => g.id),
      ];
      const baseGeneratedPrompt = buildDefaultAuthorPrompt({
        mode: effectiveCompileMode,
        repositoryFullName: input.repositoryFullName,
        upstreamRecords: effectiveUpstreamRecords,
        openManagedPr,
        reviseGuidance,
        externalMcpTools,
        acceptanceCheckIds,
        runtimeEnv,
        scrubber,
      });
      const wsManifestText = preflightResult !== undefined && preflightResult.workspaceResources.length > 0
        ? formatWorkspaceResourcesManifest(preflightResult.workspaceResources, preflightResult.stagedDir, scrubber)
        : undefined;
      const authorPrompt = input.authorPrompt ?? (
        wsManifestText !== undefined && wsManifestText.length > 0
          ? `${baseGeneratedPrompt}\n\n${wsManifestText}`
          : baseGeneratedPrompt
      );
      return {
        mode: effectiveCompileMode,
        ...(isAutoNoChange ? { checkOnlyNoChange: true } : {}),
        hostPolicy,
        repository: input.repositoryFullName,
        repositoryRoot: input.repositoryRoot,
        taskpackPath: effectiveTaskpackPath,
        baseRevision: effectiveBaseRevision,
        sourceRevision: effectiveSourceRevision,
        baselineAlignment: effectiveBaselineConfig,
        ...(baselineAlignmentResult !== undefined ? { baselineAlignmentResult } : {}),
        ...(baselineAlignmentResult?.conflictResource !== null && baselineAlignmentResult?.conflictResource !== undefined
          ? { baselineConflictResource: baselineAlignmentResult.conflictResource }
          : {}),
        ...(enableBaselineConflictGate ? { enableBaselineConflictGate: true } : {}),
        upstreamRecords: effectiveUpstreamRecords,
        targetMatrix: effectiveTargetMatrix ?? manifest.spec.target?.matrix ?? null,
        roleSelection,
        ...(candidate !== undefined ? { candidateIndex: candidate.manifestIndex } : {}),
        allowManifestCustomBaseUrl: input.allowManifestCustomBaseUrl,
        modelsJsonPath: input.modelsJsonPath,
        runtimeOptions: {},
        budgets: input.budgets ?? DEFAULT_HOST_BUDGETS,
        limits: explicitLimitsOverride,
        envLimits: envLimitsFallback,
        ...(externalMcpTools !== undefined ? { externalMcpTools } : {}),
        ...(externalMcpToolSchemas !== undefined ? { externalMcpToolSchemas } : {}),
        gateEndpoints: activeGateEndpoints,
        publicationEndpoint: activePublicationEndpoint,
        credentialEnvMap: {
          provider: candidate !== undefined
            ? (input.credentialEnvMap?.provider !== undefined && !candidate.usesActiveTokenEnv
              ? input.credentialEnvMap.provider
              : candidate.providerEnvName)
            : (input.credentialEnvMap?.provider ?? input.providerTokenEnv ?? 'LOOPWRIGHT_PROVIDER_TOKEN'),
          gate: gateEnvName,
          publication: publicationEnvName,
          publicationAuth: publicationAuthEnvName,
          localCommandGate: localCmdGateEnvName,
        },
        ...(trackedSourceTokenEnvNames.length > 0 ? { sourceTokenEnvNames: trackedSourceTokenEnvNames } : {}),
        resourceVersion: input.resourceVersion,
        authorPrompt,
        preflightPromptResources: preflightResult?.promptResources,
        preflightWorkspaceResources: preflightResult?.workspaceResources,
        scrubber,
        onMemoryWarning: message => {
          if (!loggedMemoryWarnings.has(message)) {
            loggedMemoryWarnings.add(message);
            emitProgress?.(`memory: ${message}`);
          }
        },
      };
    };

    const realRunRoot = await realpath(input.runRoot);
    const realRepositoryRoot = await realpath(input.repositoryRoot);
    if (insideRoot(realRunRoot, realRepositoryRoot)) {
      throw new GitHubAppError('ACTION_INPUT_INVALID', 'run root must live outside the target repository checkout');
    }

    if (isAutoNoChange) {
      let checkOnlyCandidate: ResolvedModelCandidate | undefined;
      try {
        const resolved = resolveTaskpackModelCandidates(manifest, buildBindings(), {
          modelsConfig,
          env: runtimeEnv,
          explicitProviderTokenEnv: input.credentialEnvMap?.provider ?? input.providerTokenEnv,
          scrubber,
        });
        checkOnlyCandidate = resolved[0];
      } catch (error) {
        if (error instanceof GitHubAppError && error.code === 'PROVIDER_OAUTH_UNSUPPORTED') {
          return { kind: 'refused', code: 'PROVIDER_OAUTH_UNSUPPORTED', reason: error.message };
        }
        checkOnlyCandidate = undefined;
      }
      const ncForbiddenEnvNames = new Set<string>([
        ...Object.values(STANDARD_PI_PROVIDER_ENV),
        ...(checkOnlyCandidate !== undefined
          ? [
            checkOnlyCandidate.providerEnvName,
            ...(checkOnlyCandidate.sourceTokenEnvName !== undefined ? [checkOnlyCandidate.sourceTokenEnvName] : []),
          ]
          : []),
        ...(manifest.spec.roles?.map(role => resolveDefaultProviderTokenEnv(role.provider, { env: runtimeEnv })) ?? []),
        ...(input.providerTokenEnv !== undefined ? [input.providerTokenEnv] : []),
        ...(input.credentialEnvMap?.provider !== undefined ? [input.credentialEnvMap.provider] : []),
        gateEnvName,
        publicationEnvName,
        publicationAuthEnvName,
        localCmdGateEnvName,
        ...decisionApiKeyEnvs,
        ...manifestSecretEnvs,
        ...collectMcpReferencedEnvNames(effectiveMcpDecls),
      ]);
      trackedSourceTokenEnvNames = [...ncForbiddenEnvNames];

      let checkOnlyCompiled: Awaited<ReturnType<typeof compileDeclarativeTaskpack>>;
      try {
        checkOnlyCompiled = await compileDeclarativeTaskpack(manifest, buildBindings(checkOnlyCandidate));
      } catch (error) {
        if (error instanceof GitHubAppError) {
          if (error.code === 'PROVIDER_OAUTH_UNSUPPORTED') {
            return { kind: 'refused', code: 'PROVIDER_OAUTH_UNSUPPORTED', reason: error.message };
          }
          return blocked(error.code, error.message);
        }
        throw error;
      }
      let ncLocalGateServer: LocalCommandGateServer | undefined;
      const ncEphemeralEnv: Record<string, string> = {};
      try {
        const ncCommandGates = checkOnlyCompiled.localCommandGates ?? [];
        const hasExplicitLocalEndpoint = (input.gateEndpoints ?? []).some(plan => plan.id === LOCAL_COMMAND_GATE_ENDPOINT_ID);
        if (
          turnkeyEnabled
          && input.delegate === undefined
          && ncCommandGates.length > 0
          && !hasExplicitLocalEndpoint
        ) {
          try {
            ncLocalGateServer = await startLocalCommandGateServer({
              runRoot: realRunRoot,
              repositoryRoot: realRepositoryRoot,
              gates: ncCommandGates,
              runtimeEnv,
              readOnlyGitHubToken: githubToken,
              scrubber,
              forbiddenEnvNames: ncForbiddenEnvNames,
              checkStagedDir: preflightResult?.checkStagedDir,
              onLog: emitProgress,
            });
          } catch (error) {
            if (error instanceof GitHubAppError) {
              if (error.code === 'ACTION_INPUT_INVALID') {
                return blocked(scrubber.scrub(error.message));
              }
              return blocked(error.code, scrubber.scrub(error.message));
            }
            throw error;
          }
          activeGateEndpoints = [...activeGateEndpoints, ncLocalGateServer.endpointPlan];
          ncEphemeralEnv[localCmdGateEnvName] = ncLocalGateServer.signingSecret;
          try {
            checkOnlyCompiled = await compileDeclarativeTaskpack(manifest, buildBindings(checkOnlyCandidate));
          } catch (error) {
            if (error instanceof GitHubAppError) {
              if (error.code === 'PROVIDER_OAUTH_UNSUPPORTED') {
                return { kind: 'refused', code: 'PROVIDER_OAUTH_UNSUPPORTED', reason: error.message };
              }
              return blocked(error.code, error.message);
            }
            throw error;
          }
        }
        const trustedDirectory = join(realRunRoot, `lw-action-nc-${process.pid}-${Date.now().toString(36)}`);
        const registryDirectory = join(trustedDirectory, 'registry');
        const configDirectory = join(trustedDirectory, 'config');
        await mkdir(registryDirectory, { recursive: true });
        await mkdir(configDirectory, { recursive: true });
        await chmod(trustedDirectory, 0o700);
        await chmod(registryDirectory, 0o700);
        await chmod(configDirectory, 0o700);
        const registryPath = join(registryDirectory, 'registry.yaml');
        const configPath = join(configDirectory, 'config.yaml');
        const configBytes = Buffer.from(serializePrettyYaml(checkOnlyCompiled.config), 'utf8');
        assertCleanArtifact(checkOnlyCompiled.registryBytes, scrubber, '/registry');
        assertCleanArtifact(configBytes, scrubber, '/config');
        for (const resource of checkOnlyCompiled.instructionResources ?? []) {
          assertCleanArtifact(resource.bytes, scrubber, `/resources/${resource.id}`);
        }
        await writeFile(registryPath, checkOnlyCompiled.registryBytes, { mode: 0o600 });
        await writeFile(configPath, configBytes, { mode: 0o600 });
        await chmod(registryPath, 0o600);
        await chmod(configPath, 0o600);
        if (checkOnlyCompiled.instructionResources !== undefined && checkOnlyCompiled.instructionResources.length > 0) {
          await stageCompiledInstructionResources(registryDirectory, checkOnlyCompiled.instructionResources);
        }
        const writtenNoChange: WrittenCompiledTaskpack = {
          ...checkOnlyCompiled,
          configBytes,
          trustedDirectory,
          registryPath,
          configPath,
        };
        const ncDelegate = input.delegate ?? (turnkeyEnabled
          ? createTurnkeyCycleDelegate({
            runId: input.runId,
            repositoryRoot: realRepositoryRoot,
            runtimeEnv,
            ephemeralEnv: ncEphemeralEnv,
            scrubber,
            policyProfile: 'github',
            allowWorkflowWrites: writtenNoChange.allowWorkflowWrites,
            openHostSessionAdapter: input.openHostSessionAdapter,
            onLog: emitProgress,
          })
          : undefined);
        const ncOutcome = (input.dryRun === true || ncDelegate === undefined)
          ? null
          : await ncDelegate(writtenNoChange);
        return {
          kind: 'no_change',
          reason: autoCheckOnlyNoChangeReason!,
          taskpack: writtenNoChange,
          delegateOutcome: ncOutcome === null ? null : { ok: ncOutcome.ok, detail: scrubber.scrub(ncOutcome.detail) },
        };
      } finally {
        if (ncLocalGateServer !== undefined) {
          await ncLocalGateServer.close().catch(() => undefined);
        }
      }
    }

    // Pre-probe 3-way baseline alignment: runs STRICTLY BEFORE model candidate probing (`selectHealthyModelCandidate`)!
    if (
      input.dryRun !== true
      && effectiveCompileMode === 'candidate'
      && effectiveSourceRevision !== effectiveBaseRevision
      && (existsSync(join(realRepositoryRoot, '.git')) || effectiveBaselineConfig.policy !== 'off')
    ) {
      try {
        baselineAlignmentResult = await alignBaselineRevisions({
          repositoryRoot: realRepositoryRoot,
          baseRevision: effectiveBaseRevision,
          sourceRevision: effectiveSourceRevision,
          manifest,
          taskpackPath: effectiveTaskpackPath,
          policyProfile: 'github',
          hostPolicy,
          extraProtectedPaths: suiteExtraProtectedPaths,
          baselineAlignment: effectiveBaselineConfig,
          scrubber,
          scratchRoot: realRunRoot,
          onLog: emitProgress,
        });
      } catch (error) {
        if (error instanceof GitHubAppError) {
          return blocked(error.code, scrubber.scrub(error.message));
        }
        throw error;
      }

      if (baselineAlignmentResult.status === 'blocked') {
        const conflictDetail = scrubber.scrub(baselineAlignmentResult.detail || baselineAlignmentResult.reason);
        input.onTurnkeyReport?.({
          manifest,
          scrubber,
          report: {
            runId: normalizeControllerRunId(input.runId),
            status: 'blocked',
            reasonCode: BASELINE_CONFLICT_REASON,
            detail: conflictDetail,
            discovery: intake.kind === 'discover'
              ? { disposition: intake.disposition, ...(intake.disposition === 'ready' ? { updatesCount: intake.updates.length } : {}) }
              : null,
            scrub: text => scrubber.scrub(text),
          },
        });
        return blocked(BASELINE_CONFLICT_REASON, conflictDetail);
      }

      enableBaselineConflictGate = baselineAlignmentResult.conflictResource !== null
        || baselineAlignmentResult.disposition === 'unmerged_off';
      extractedConflictPaths = baselineAlignmentResult.conflictResource?.extractedPaths;
    }

    const roleProviderEnvNames: string[] = [];
    if (manifest.spec.roles !== undefined && manifest.spec.roles.length > 0) {
      try {
        for (const [roleIdx, role] of manifest.spec.roles.entries()) {
          const normalizedProvider = role.provider.trim().toLowerCase();
          if (isOAuthOnlyPiProvider(normalizedProvider) || normalizedProvider === 'antigravity' || normalizedProvider === 'pi-oauth') {
            throw new GitHubAppError(
              'PROVIDER_OAUTH_UNSUPPORTED',
              `Pi provider "${role.provider}" uses OAuth or CLI login, which Loopwright refuses; configure a token-authenticated Pi provider`,
              `/spec/roles/${roleIdx}/provider`,
            );
          }
          if (role.thinking !== undefined && !(PI_THINKING_LEVELS as readonly string[]).includes(role.thinking)) {
            throw new GitHubAppError(
              'TASKPACK_MANIFEST_INVALID',
              `spec.roles[].thinking must be one of ${PI_THINKING_LEVELS.join(', ')}`,
              `/spec/roles/${roleIdx}/thinking`,
            );
          }
          const roleBindings: HostTaskpackBindings = {
            ...buildBindings(),
            candidateIndex: undefined,
            roleSelection: {
              provider: role.provider,
              model: role.model,
              ...(role.thinking !== undefined ? { thinking: role.thinking as NonNullable<HostRoleSelection['thinking']> } : {}),
            },
          };
          const { selection, apiKeyEnv } = resolveTaskpackModelSelection(manifest, roleBindings, modelsConfig);
          const modelsJsonApiKeyEnv = modelsConfig?.providers.get(selection.provider)?.apiKeyEnv;
          roleProviderEnvNames.push(resolveDefaultProviderTokenEnv(selection.provider, {
            modelsJsonApiKeyEnv,
            manifestApiKeyEnv: apiKeyEnv,
            env: runtimeEnv,
          }));
        }
      } catch (error) {
        if (error instanceof GitHubAppError) {
          if (error.code === 'PROVIDER_OAUTH_UNSUPPORTED') {
            return { kind: 'refused', code: 'PROVIDER_OAUTH_UNSUPPORTED', reason: error.message };
          }
          return blocked(error.code, error.message);
        }
        throw error;
      }
    }

    let candidates: readonly ResolvedModelCandidate[];
    try {
      const firstRole = manifest.spec.roles?.[0];
      const candidateBaseBindings = (manifest.spec.models === undefined && firstRole !== undefined && roleSelection === undefined)
        ? {
          ...buildBindings(),
          roleSelection: {
            provider: firstRole.provider,
            model: firstRole.model,
            ...(firstRole.thinking !== undefined ? { thinking: firstRole.thinking as NonNullable<HostRoleSelection['thinking']> } : {}),
          },
        }
        : buildBindings();
      candidates = resolveTaskpackModelCandidates(manifest, candidateBaseBindings, {
        modelsConfig,
        env: runtimeEnv,
        explicitProviderTokenEnv: input.credentialEnvMap?.provider ?? input.providerTokenEnv,
        scrubber,
      });
    } catch (error) {
      if (error instanceof GitHubAppError) {
        if (error.code === 'PROVIDER_OAUTH_UNSUPPORTED') {
          return { kind: 'refused', code: 'PROVIDER_OAUTH_UNSUPPORTED', reason: error.message };
        }
        return blocked(error.code, error.message);
      }
      throw error;
    }

    const forbiddenCommandEnvNames = new Set<string>([
      ...candidates.flatMap(candidate => [
        candidate.providerEnvName,
        ...(candidate.sourceTokenEnvName !== undefined ? [candidate.sourceTokenEnvName] : []),
      ]),
      ...roleProviderEnvNames,
      ...(manifest.spec.roles?.map(role => resolveDefaultProviderTokenEnv(role.provider, { env: runtimeEnv })) ?? []),
      ...(input.providerTokenEnv !== undefined ? [input.providerTokenEnv] : []),
      ...(input.credentialEnvMap?.provider !== undefined ? [input.credentialEnvMap.provider] : []),
      gateEnvName,
      publicationEnvName,
      publicationAuthEnvName,
      localCmdGateEnvName,
      ...decisionApiKeyEnvs,
      ...manifestSecretEnvs,
      ...collectMcpReferencedEnvNames(effectiveMcpDecls),
    ]);
    trackedSourceTokenEnvNames = [...forbiddenCommandEnvNames];

    if (
      input.dryRun !== true
      && effectiveCompileMode === 'candidate'
      && !(input.gateEndpoints ?? []).some(plan => plan.id === LOCAL_COMMAND_GATE_ENDPOINT_ID)
    ) {
      try {
        await validateManifestCommandToolchainPaths(manifest, realRepositoryRoot, hostPolicy.allowPrivileged === true);
      } catch (error) {
        if (error instanceof GitHubAppError) {
          return blocked(error.code, scrubber.scrub(error.message));
        }
        throw error;
      }
    }

    let currentPos = 0;
    if (input.dryRun !== true && candidates.length >= 2) {
      try {
        const selected = await selectHealthyModelCandidate(candidates, {
          fetchImpl: input.probeFetch,
          totalTimeoutMs: input.probeTimeoutMs,
          scrubber,
        });
        currentPos = selected.index;
      } catch (error) {
        if (error instanceof GitHubAppError) {
          return blocked(error.code, error.message);
        }
        throw error;
      }
    }

    let localGateServer: LocalCommandGateServer | undefined;
    let publisherServer: NativePullRequestPublisherServer | undefined;
    let lastTurnkeySummary: TurnkeyCycleAttemptSummary | undefined;

    try {
      const ephemeralEnv: Record<string, string> = {};
      if (turnkeyEnabled && input.delegate === undefined) {
        if (effectiveMcpDecls.length > 0) {
          let resolvedMcpConfigs: readonly ExternalMcpServerConfig[];
          try {
            resolvedMcpConfigs = resolveExternalMcpConfigs({
              declarations: effectiveMcpDecls,
              runtimeEnv,
              githubToken,
              allowLoopbackHttp: input.allowManifestCustomBaseUrl === true,
              scrubber,
            });
          } catch (error) {
            if (error instanceof GitHubAppError) {
              if (error.code === 'MCP_AUTHENTICATION_REQUIRED') {
                return { kind: 'refused', code: 'MCP_AUTHENTICATION_REQUIRED', reason: scrubber.scrub(error.message) };
              }
              return blocked(error.code, scrubber.scrub(error.message));
            }
            throw error;
          }
          if (resolvedMcpConfigs.length > 0) {
            try {
              mcpRegistry = await HostMcpRegistry.connect(resolvedMcpConfigs, {
                untrustedRoots: [realRepositoryRoot],
                trustedPathEnv: runtimeEnv['PATH'],
                scrub: text => scrubber.scrub(text),
              });
            } catch (error) {
              const message = error instanceof Error ? error.message : String(error);
              return blocked('MCP_CONNECTION_FAILED', scrubber.scrub(message));
            }
            for (const srv of mcpRegistry.servers) {
              emitProgress?.(`mcp: connected ${srv.id} (${srv.transport}) — ${srv.toolNames.length} tools`);
            }
          }
        }

        if (needsNativePublicationEndpoint && manifest.spec.publication.mode === 'pull_request') {
          publisherServer = await startNativePullRequestPublisherServer({
            runRoot: realRunRoot,
            repositoryRoot: realRepositoryRoot,
            repositoryFullName: input.repositoryFullName,
            targetBranch: manifest.spec.publication.targetBranch,
            headBranchPrefix: manifest.spec.publication.headBranchPrefix,
            proposalPath: manifest.spec.proposal?.path,
            titleTemplate: manifest.spec.publication.titleTemplate,
            openManagedPr,
            remoteUrl: input.gitRemoteUrl,
            apiBaseUrl: effectiveApiBaseUrl,
            gitWriteToken: githubToken,
            gitCommitIdentity,
            fetchImpl: input.probeFetch,
            scrubber,
            extractedConflictPaths,
          });
          activePublicationEndpoint = publisherServer.endpointPlan;
          ephemeralEnv[publicationEnvName] = publisherServer.signingSecret;
          ephemeralEnv[publicationAuthEnvName] = publisherServer.authToken;
        }

        const hasCommandChecks = effectiveCompileMode === 'candidate'
          && (
            manifest.spec.verification.localChecks.some(check => check.implementation === 'command.v1')
            || enableBaselineConflictGate
          );
        if (hasCommandChecks) {
          let preview: Awaited<ReturnType<typeof compileDeclarativeTaskpack>>;
          try {
            preview = await compileDeclarativeTaskpack(manifest, buildBindings(candidates[currentPos]));
          } catch (error) {
            if (error instanceof GitHubAppError) {
              if (error.code === 'PROVIDER_OAUTH_UNSUPPORTED') {
                return { kind: 'refused', code: 'PROVIDER_OAUTH_UNSUPPORTED', reason: error.message };
              }
              if (error.code === 'ACTION_INPUT_INVALID') {
                return blocked(error.message);
              }
              return blocked(error.code, error.message);
            }
            throw error;
          }
          const hasExplicitLocalEndpoint = (input.gateEndpoints ?? []).some(plan => plan.id === LOCAL_COMMAND_GATE_ENDPOINT_ID);
          if (!hasExplicitLocalEndpoint) {
            try {
              localGateServer = await startLocalCommandGateServer({
                runRoot: realRunRoot,
                repositoryRoot: realRepositoryRoot,
                gates: preview.localCommandGates ?? [],
                runtimeEnv,
                readOnlyGitHubToken: githubToken,
                scrubber,
                forbiddenEnvNames: forbiddenCommandEnvNames,
                checkStagedDir: preflightResult?.checkStagedDir,
                extractedConflictPaths: preview.extractedConflictPaths ?? extractedConflictPaths,
                onLog: emitProgress,
              });
            } catch (error) {
              if (error instanceof GitHubAppError) {
                if (error.code === 'ACTION_INPUT_INVALID') {
                  return blocked(scrubber.scrub(error.message));
                }
                return blocked(error.code, scrubber.scrub(error.message));
              }
              throw error;
            }
            activeGateEndpoints = [...activeGateEndpoints, localGateServer.endpointPlan];
            ephemeralEnv[localCmdGateEnvName] = localGateServer.signingSecret;
          }
        }
      }

      const compileAndWriteCandidate = async (candidate: ResolvedModelCandidate, attemptSeq: number): Promise<WrittenCompiledTaskpack> => {
        const compiled = await compileDeclarativeTaskpack(manifest, buildBindings(candidate));
        // The controller loader adds dirname(configPath) to its trust roots and requires every trusted parent
        // directory to be 0o700, so registry and config live in separate owner-only subdirectories.
        const suffix = attemptSeq === 0 ? '' : `-fallback-${attemptSeq}`;
        const trustedDirectory = join(realRunRoot, `lw-action-${process.pid}-${Date.now().toString(36)}${suffix}`);
        const registryDirectory = join(trustedDirectory, 'registry');
        const configDirectory = join(trustedDirectory, 'config');
        await mkdir(registryDirectory, { recursive: true });
        await mkdir(configDirectory, { recursive: true });
        await chmod(trustedDirectory, 0o700);
        await chmod(registryDirectory, 0o700);
        await chmod(configDirectory, 0o700);
        const registryPath = join(registryDirectory, 'registry.yaml');
        const configPath = join(configDirectory, 'config.yaml');
        const configBytes = Buffer.from(serializePrettyYaml(compiled.config), 'utf8');
        await writeFile(registryPath, compiled.registryBytes, { mode: 0o600 });
        await writeFile(configPath, configBytes, { mode: 0o600 });
        await chmod(registryPath, 0o600);
        await chmod(configPath, 0o600);
        if (compiled.instructionResources !== undefined && compiled.instructionResources.length > 0) {
          await stageCompiledInstructionResources(registryDirectory, compiled.instructionResources);
          for (const resource of compiled.instructionResources) {
            assertCleanArtifact(resource.bytes, scrubber, `/resources/${resource.id}`);
          }
        }
        assertCleanArtifact(compiled.registryBytes, scrubber, '/registry');
        assertCleanArtifact(configBytes, scrubber, '/config');
        return {
          ...compiled, configBytes, trustedDirectory, registryPath, configPath,
        };
      };

      let activeCandidate = candidates[currentPos]!;
      let activeTaskpack: WrittenCompiledTaskpack;
      try {
        activeTaskpack = await compileAndWriteCandidate(activeCandidate, 0);
      } catch (error) {
        if (error instanceof GitHubAppError) {
          if (error.code === 'PROVIDER_OAUTH_UNSUPPORTED') {
            return { kind: 'refused', code: 'PROVIDER_OAUTH_UNSUPPORTED', reason: error.message };
          }
          if (error.code === 'ACTION_INPUT_INVALID') {
            return blocked(error.message);
          }
          return blocked(error.code, error.message);
        }
        throw error;
      }

      let activeContextWindow = resolveCatalogModel(activeCandidate.selection).record.contextWindow;
      const activeBudgets = activeTaskpack.config.spec.task.spec.budgets;
      emitProgress?.(
        `model: ${activeCandidate.selection.provider}/${activeCandidate.selection.model} (thinking=${activeCandidate.selection.thinking ?? 'off'})`
        + ` — wallTime=${formatDurationMs(activeBudgets.wallTimeMs)}, totalTokens=${formatTokenCount(activeBudgets.totalTokens)}, maxOutputTokens=${formatTokenCount(activeBudgets.perCallOutputTokens)}, contextWindow=${formatTokenCount(activeContextWindow)}`,
      );

      const decisionPort = createTaskpackDecisionPort(manifest, {
        runtimeEnv,
        apiKey: input.decisionApiKey,
        transport: input.decisionTransport,
        scrubber,
        hasPinnedRoles: (manifest.spec.roles?.length ?? 0) > 0 || hasHostRoleOverrides,
      });
      const stepMcpMetadata = mcpRegistry?.servers.map(srv => ({
        id: srv.id,
        transport: srv.transport,
        toolNames: srv.toolNames,
      }));

      const effectiveDelegate = input.delegate ?? (turnkeyEnabled
        ? createTurnkeyCycleDelegate({
          runId: input.runId,
          repositoryRoot: realRepositoryRoot,
          runtimeEnv,
          ephemeralEnv,
          scrubber,
          mcpRegistry,
          mcpServers: stepMcpMetadata,
          decisions: decisionPort,
          policyProfile: 'github',
          allowWorkflowWrites: activeTaskpack.allowWorkflowWrites,
          openHostSessionAdapter: input.openHostSessionAdapter,
          onLog: emitProgress,
          onAttemptSettled: summary => {
            lastTurnkeySummary = summary;
          },
        })
        : undefined);

      const reportMcpServers: readonly ReportMcpServerInfo[] | undefined = mcpRegistry?.servers.map((srv): ReportMcpServerInfo => ({
        id: srv.id,
        transport: srv.transport,
        toolCount: srv.toolNames.length,
        status: 'connected',
      }));

      if (input.dryRun === true || effectiveDelegate === undefined) {
        input.onTurnkeyReport?.({
          manifest,
          scrubber,
          report: {
            runId: normalizeControllerRunId(input.runId),
            status: input.dryRun === true ? 'dry_run' : 'compiled',
            discovery: intake.kind === 'discover'
              ? { disposition: intake.disposition, ...(intake.disposition === 'ready' ? { updatesCount: intake.updates.length } : {}) }
              : null,
            model: {
              provider: activeCandidate.selection.provider,
              model: activeCandidate.selection.model,
              thinking: activeCandidate.selection.thinking ?? null,
              contextWindow: activeContextWindow,
            },
            ...(reportMcpServers !== undefined && reportMcpServers.length > 0 ? { mcpServers: reportMcpServers } : {}),
            scrub: text => scrubber.scrub(text),
          },
        });
        return { kind: 'compiled', manifest, intake, taskpack: activeTaskpack, delegateOutcome: null };
      }

      let attemptSeq = 0;
      let lastOutcome = await invokeDelegateForCandidate(activeCandidate, activeTaskpack, effectiveDelegate);
      if (candidates.length === 1 && shouldRotateModelCandidate(lastOutcome)) {
        const elapsedEntrypointMs = Math.max(0, Math.round(performance.now() - entrypointStartedMs));
        const configuredWallTimeMs = activeTaskpack.config.spec.task.spec.budgets.wallTimeMs;
        const minReserveMs = Math.min(60_000, Math.floor(configuredWallTimeMs / 4));
        if (elapsedEntrypointMs + minReserveMs < configuredWallTimeMs) {
          attemptSeq += 1;
          emitProgress?.(
            `model: retrying primary candidate #${attemptSeq} after transient provider failure (${activeCandidate.selection.provider}/${activeCandidate.selection.model}, contextWindow=${formatTokenCount(activeContextWindow)})`,
          );
          activeTaskpack = await compileAndWriteCandidate(activeCandidate, attemptSeq);
          lastOutcome = await invokeDelegateForCandidate(activeCandidate, activeTaskpack, effectiveDelegate);
        }
      } else {
        while (shouldRotateModelCandidate(lastOutcome) && currentPos + 1 < candidates.length) {
          const remaining = candidates.slice(currentPos + 1);
          let nextSelected;
          try {
            nextSelected = await selectHealthyModelCandidate(remaining, {
              fetchImpl: input.probeFetch,
              totalTimeoutMs: input.probeTimeoutMs,
              forceProbe: true,
              scrubber,
            });
          } catch {
            lastOutcome = {
              ok: false,
              detail: scrubber.scrub(`${lastOutcome.detail}; remaining model fallback candidates failed readiness probe`),
            };
            break;
          }
          currentPos = currentPos + 1 + nextSelected.index;
          activeCandidate = candidates[currentPos]!;
          activeContextWindow = resolveCatalogModel(activeCandidate.selection).record.contextWindow;
          attemptSeq += 1;
          emitProgress?.(
            `model: rotating to fallback #${attemptSeq} (${activeCandidate.selection.provider}/${activeCandidate.selection.model}, contextWindow=${formatTokenCount(activeContextWindow)})`,
          );
          activeTaskpack = await compileAndWriteCandidate(activeCandidate, attemptSeq);
          lastOutcome = await invokeDelegateForCandidate(activeCandidate, activeTaskpack, effectiveDelegate);
        }
      }

      const settledRunId = lastTurnkeySummary?.attemptRunId ?? normalizeControllerRunId(input.runId);
      let memorySummary: TurnkeyMemorySummary | undefined;
      if (lastTurnkeySummary !== undefined || existsSync(join(realRunRoot, settledRunId, 'run.json'))) {
        const memoryTargetCell = effectiveTargetMatrix !== undefined
          ? (effectiveTargetMatrix !== null && effectiveTargetMatrix.length === 1 ? effectiveTargetMatrix[0]! : null)
          : undefined;
        try {
          memorySummary = await finalizeAndPublishTurnkeyMemory({
            runRoot: realRunRoot,
            runId: settledRunId,
            repositoryRoot: realRepositoryRoot,
            repositoryFullName: input.repositoryFullName,
            manifest,
            taskpackPath: effectiveTaskpackPath,
            baseRevision: effectiveBaseRevision,
            upstreamRecords: effectiveUpstreamRecords,
            ...(memoryTargetCell !== undefined ? { targetMatrix: memoryTargetCell } : {}),
            remoteUrl: input.gitRemoteUrl,
            apiBaseUrl: effectiveApiBaseUrl,
            githubToken,
            gitCommitIdentity,
            fetchImpl: input.probeFetch,
            runtimeEnv,
            scrubber,
          });
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          let fallbackDirectory = manifest.spec.memory.directory;
          try {
            fallbackDirectory = resolveTaskpackMemoryLocation(manifest, effectiveTaskpackPath).memoryDirectory;
          } catch {
            // keep declared directory when location resolution itself failed
          }
          memorySummary = Object.freeze({
            status: 'failed',
            directory: fallbackDirectory,
            proposalId: null,
            entryCount: 0,
            rebased: false,
            branchName: null,
            pullRequestUrl: null,
            pullRequestNumber: null,
            reason: scrubber.scrub(message),
          });
        }
        emitProgress?.(
          `memory: ${memorySummary.status} (${memorySummary.entryCount} entries`
          + `${memorySummary.pullRequestUrl ? `, pr=${memorySummary.pullRequestUrl}` : ''}`
          + `${memorySummary.reason ? ` — ${memorySummary.reason}` : ''})`,
        );
      }

      input.onTurnkeyReport?.({
        manifest,
        scrubber,
        ...(memorySummary !== undefined ? { memory: memorySummary } : {}),
        report: {
          runId: settledRunId,
          status: lastTurnkeySummary?.status ?? (lastOutcome.ok ? 'passed' : 'failed'),
          reasonCode: lastTurnkeySummary?.reasonCode ?? null,
          detail: !lastOutcome.ok ? (lastTurnkeySummary?.detail ?? lastOutcome.detail) : null,
          discovery: intake.kind === 'discover'
            ? { disposition: intake.disposition, ...(intake.disposition === 'ready' ? { updatesCount: intake.updates.length } : {}) }
            : null,
          checks: lastTurnkeySummary?.checks,
          model: {
            provider: activeCandidate.selection.provider,
            model: activeCandidate.selection.model,
            thinking: activeCandidate.selection.thinking ?? null,
            contextWindow: activeContextWindow,
            tokenRotations: attemptSeq,
          },
          ...(reportMcpServers !== undefined && reportMcpServers.length > 0 ? { mcpServers: reportMcpServers } : {}),
          usage: lastTurnkeySummary?.usage ?? null,
          elapsedMs: lastTurnkeySummary?.elapsedMs ?? null,
          externalUrl: lastTurnkeySummary?.externalUrl ?? null,
          ...(lastTurnkeySummary?.runEval !== undefined && lastTurnkeySummary.runEval !== null
            ? { runEval: lastTurnkeySummary.runEval }
            : {}),
          scrub: text => scrubber.scrub(text),
        },
      });

      return {
        kind: 'compiled',
        manifest,
        intake,
        taskpack: activeTaskpack,
        delegateOutcome: { ok: lastOutcome.ok, detail: scrubber.scrub(lastOutcome.detail) },
        ...(memorySummary !== undefined ? { memory: memorySummary } : {}),
      };
    } finally {
      await mcpRegistry?.close().catch(() => undefined);
      await localGateServer?.close().catch(() => undefined);
      await publisherServer?.close().catch(() => undefined);
    }
  } finally {
    await preflightResult?.cleanup().catch(() => undefined);
  }
}

function eventNameIsTrigger(eventName: string): boolean {
  return eventName === 'schedule' || eventName === 'workflow_dispatch' || eventName === 'repository_dispatch' || eventName === 'release';
}

/** Minimal GitHub Actions CLI shim: map INPUT_* environment variables and run the entrypoint. */
export async function runActionCli(
  env: NodeJS.ProcessEnv = process.env,
  options?: { readonly openHostSessionAdapter?: ActionEntrypointInput['openHostSessionAdapter'] },
): Promise<number> {
  const repositoryRoot = env['GITHUB_WORKSPACE'] ?? process.cwd();
  const eventPath = env['INPUT_EVENT-PATH'];
  let eventPayload: unknown;
  if (eventPath !== undefined && eventPath.length > 0 && isAbsolute(eventPath)) {
    try {
      const descriptor = openSync(eventPath, 'r');
      const raw = readFileSync(descriptor, 'utf8');
      closeSync(descriptor);
      eventPayload = raw.trim().length > 0 ? JSON.parse(raw) : undefined;
    } catch {
      eventPayload = undefined;
    }
  }
  const thinking = env['INPUT_THINKING']?.trim();
  const api = env['INPUT_API']?.trim();
  const storageProfile = env['INPUT_STORAGE-PROFILE'];
  const mode = env['INPUT_MODE'];
  const gateEndpointUrl = env['INPUT_GATE-ENDPOINT-URL']?.trim();
  const publicationEndpointUrl = env['INPUT_PUBLICATION-ENDPOINT-URL']?.trim();
  const dryRun = env['INPUT_DRY-RUN'] === 'true';
  const force = env['INPUT_FORCE'] === 'true';
  const inputRunId = env['INPUT_RUN-ID']?.trim() || env['GITHUB_RUN_ID'] || 'local';
  const inputOutput = env['INPUT_OUTPUT']?.trim() || undefined;
  const sourceRevision = env['INPUT_SOURCE-REVISION']?.trim() || undefined;
  const prevalidatedInputFormats = inputOutput !== undefined
    ? resolveActionOutputFormats(inputOutput, undefined)
    : undefined;

  let capturedReport: TurnkeyActionExecutionReport | undefined;

  const result = await runGitHubActionEntrypoint({
    repositoryRoot,
    suitePath: env['INPUT_SUITE-PATH']?.trim() || undefined,
    domain: env['INPUT_DOMAIN']?.trim() || undefined,
    taskpackPath: env['INPUT_TASKPACK-PATH']?.trim() || undefined,
    repositoryFullName: env['LOOPWRIGHT_REPOSITORY'] ?? env['GITHUB_REPOSITORY'] ?? basename(repositoryRoot),
    baseRevision: env['GITHUB_SHA'] ?? 'HEAD',
    sourceRevision,
    mode: mode === 'no-change' ? 'no-change' : mode === 'auto' ? 'auto' : 'candidate',
    eventName: env['INPUT_EVENT-NAME']?.trim() || env['GITHUB_EVENT_NAME'] || 'workflow_dispatch',
    eventPayload,
    runRoot: env['INPUT_RUN-ROOT']?.trim() || env['RUNNER_TEMP'] || resolve(repositoryRoot, '../.loopwright-runs'),
    runId: inputRunId,
    storageProfile: storageProfile === 'durable' ? 'durable' : 'actions-basic',
    provider: env['INPUT_PROVIDER']?.trim() || undefined,
    model: env['INPUT_MODEL']?.trim() || undefined,
    thinking: thinking !== undefined && (PI_THINKING_LEVELS as readonly string[]).includes(thinking) ? thinking as PiThinkingLevel : undefined,
    api: api !== undefined && (PI_WIRE_APIS as readonly string[]).includes(api) ? api as PiWireApi : undefined,
    baseUrl: env['INPUT_BASE-URL']?.trim() || undefined,
    providerTokenEnv: env['INPUT_PROVIDER-TOKEN-ENV']?.trim() || undefined,
    modelsJsonPath: env['INPUT_MODELS-JSON']?.trim() || undefined,
    allowManifestCustomBaseUrl: env['INPUT_ALLOW-CUSTOM-BASE-URL'] === 'true',
    allowPrivilegedExecution: env['INPUT_ALLOW-PRIVILEGED-EXECUTION'] === 'true',
    allowWorkflowWrites: env['INPUT_ALLOW-WORKFLOW-WRITES'] === 'true',
    gateEndpoints: gateEndpointUrl ? [{ id: 'default', url: gateEndpointUrl, signingCredentialRef: 'taskpack-gate-signing' }] : undefined,
    publicationEndpoint: publicationEndpointUrl ? { id: 'default', url: publicationEndpointUrl, signingCredentialRef: 'taskpack-publication-signing' } : undefined,
    operatorAllowlist: env['LOOPWRIGHT_OPERATOR_ALLOWLIST']?.split(',').filter(entry => entry.length > 0),
    env,
    dryRun,
    force,
    turnkey: !dryRun,
    githubApiBaseUrl: env['GITHUB_API_URL']?.trim() || undefined,
    githubToken: env['INPUT_GITHUB-TOKEN']?.trim() || undefined,
    githubAppId: env['INPUT_GITHUB-APP-ID']?.trim() || undefined,
    githubAppPrivateKey: env['INPUT_GITHUB-APP-PRIVATE-KEY']?.trim() || undefined,
    githubAppInstallationId: env['INPUT_GITHUB-APP-INSTALLATION-ID']?.trim() || undefined,
    gitAuthorName: env['INPUT_GIT-AUTHOR-NAME'] || undefined,
    gitAuthorEmail: env['INPUT_GIT-AUTHOR-EMAIL'] || undefined,
    upstreamRecordsJson: env['INPUT_UPSTREAM-RECORDS']?.trim() || undefined,
    mcpServersJson: env['INPUT_MCP-SERVERS']?.trim() || env['LOOPWRIGHT_MCP_SERVERS']?.trim() || undefined,
    gitRemoteUrl: env['INPUT_REMOTE-URL']?.trim() || undefined,
    output: inputOutput,
    progressSink: !dryRun
      ? (line => {
        process.stderr.write(`[loopwright] ${line}\n`);
      })
      : undefined,
    onTurnkeyReport: info => {
      capturedReport = info;
    },
    ...(options?.openHostSessionAdapter !== undefined
      ? { openHostSessionAdapter: options.openHostSessionAdapter }
      : {}),
  });

  const fallbackScrubber = capturedReport?.scrubber ?? new SecretScrubber();
  for (const key of [
    'INPUT_GITHUB-TOKEN',
    'GITHUB_TOKEN',
    'INPUT_GITHUB-APP-PRIVATE-KEY',
    'LOOPWRIGHT_GATE_SIGNING_SECRET',
    'LOOPWRIGHT_PUBLICATION_SIGNING_SECRET',
    'LOOPWRIGHT_PUBLICATION_AUTH_TOKEN',
  ]) {
    const val = env[key];
    if (typeof val === 'string' && val.length > 0) fallbackScrubber.register(val);
  }
  const serialized = serializeActionResultSummary(result, fallbackScrubber);
  process.stdout.write(`${serialized}\n`);

  const manifest = capturedReport?.manifest ?? (result.kind === 'compiled' ? result.manifest : null);
  const formats = prevalidatedInputFormats ?? resolveActionOutputFormats(undefined, manifest);
  const suiteOnly = isSuiteActionResult(result);
  const report: RunReportInput = capturedReport?.report ?? {
    runId: normalizeControllerRunId(inputRunId),
    status: isSuiteActionResult(result)
      ? result.kind
      : result.kind === 'no_change'
        ? (result.delegateOutcome?.ok === false ? 'failed' : 'no_change')
        : result.kind === 'blocked'
          ? 'blocked'
          : result.kind === 'refused'
            ? 'refused'
            : (result.delegateOutcome?.ok === false ? 'failed' : 'passed'),
    reasonCode: result.kind === 'refused'
      ? result.code
      : result.kind === 'blocked'
        ? result.reason
        : isSuiteActionResult(result)
          ? result.reason
          : null,
    detail: result.kind === 'refused'
      ? result.reason
      : result.kind === 'blocked'
        ? (result.detail ?? null)
        : isSuiteActionResult(result)
          ? (result.detail ?? result.reason)
          : result.kind === 'no_change'
            ? (result.delegateOutcome?.ok === false ? result.delegateOutcome.detail : result.reason)
            : (result.delegateOutcome?.ok === false ? result.delegateOutcome.detail : null),
    scrub: text => fallbackScrubber.scrub(text),
  };

  const memorySummary = capturedReport?.memory ?? (result.kind === 'compiled' ? result.memory : undefined);

  await writeActionOutputSinks({
    formats,
    report,
    memory: memorySummary,
    stepSummaryPath: env['GITHUB_STEP_SUMMARY'],
    githubOutputPath: env['GITHUB_OUTPUT'],
    actionResultJson: serialized,
    scrubber: fallbackScrubber,
    includeExtendedGithubOutputs: !dryRun || inputOutput !== undefined,
    alwaysLogTextSummary: !dryRun,
  });

  const executionSucceeded = suiteOnly
    || (result.kind === 'no_change'
      && (result.delegateOutcome === undefined || result.delegateOutcome === null || result.delegateOutcome.ok))
    || (result.kind === 'compiled' && (result.delegateOutcome === null || result.delegateOutcome.ok));
  return executionSucceeded ? 0 : 1;
}

const invokedDirectly = process.argv[1] !== undefined && (() => {
  try { return resolve(process.argv[1]!) === fileURLToPath(import.meta.url); } catch { return false; }
})();
if (invokedDirectly) {
  void runActionCli().then(code => {
    process.exitCode = code;
  });
}
