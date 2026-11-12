import { createHash } from 'node:crypto';
import { appendFileSync, closeSync, openSync, readFileSync } from 'node:fs';
import { chmod, mkdir, realpath, writeFile } from 'node:fs/promises';
import { basename, isAbsolute, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PI_THINKING_LEVELS, PI_WIRE_APIS, isOAuthOnlyPiProvider } from '@loopwright/agent-pi/catalog';
import {
  LOOPWRIGHT_ACTIVE_PROVIDER_TOKEN_ENV, loadPiModelsJson, resolveTaskpackModelCandidates, selectHealthyModelCandidate,
  type ParsedPiModelsJson,
} from './models-config.js';
import { validateMcpAuthConfiguration, qualifyDeploymentHostProfile } from './qualification.js';
import { authorizeRepositoryActor, compileDeclarativeTaskpack, DEFAULT_HOST_BUDGETS, loadDeclarativeTaskpack, parseCommentCommand, prepareTaskpackIntake, validateCommentGuidance } from './taskpack.js';
import { assertCleanArtifact, SecretScrubber } from './token-broker.js';
import { serializePrettyYaml } from './yaml.js';
import {
  GitHubAppError,
  type ActionDelegateOutcome, type ActionEntrypointInput, type ActionEntrypointResult, type ClockSample,
  type HostRoleSelection, type HostTaskpackBindings, type PiThinkingLevel, type PiWireApi,
  type ResolvedModelCandidate, type TaskpackCommentCommand, type TaskpackIntakeOutcome,
  type TaskpackManifest, type WrittenCompiledTaskpack,
} from './types.js';

function systemSample(): ClockSample {
  return { wallMs: Date.now(), monotonicMs: (process.hrtime.bigint() / 1_000_000n).toString() };
}

function insideRoot(path: string, root: string): boolean {
  return path === root || path.startsWith(root.endsWith(sep) ? root : root + sep);
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

/**
 * Run the complete offline-testable Action flow: qualify the host, refuse interactive MCP authentication,
 * load the target manifest, evaluate trigger intake, select a healthy model candidate (probing when >= 2
 * candidates are configured), compile, write trusted artifacts outside the checkout, scrub them, and
 * optionally delegate execution with fresh-session fallback across remaining healthy model candidates.
 */
export async function runGitHubActionEntrypoint(input: ActionEntrypointInput): Promise<ActionEntrypointResult> {
  const runtimeEnv = input.env ?? process.env;
  const storageProfile = input.storageProfile ?? 'actions-basic';
  const startSample = input.previousClockSample ?? systemSample();
  const basis = input.clockBasis ?? {
    clockEpoch: input.runId,
    created: { ...startSample },
    taskDeadlineMonotonicMs: (BigInt(startSample.monotonicMs) + BigInt(input.budgets?.wallTimeMs ?? DEFAULT_HOST_BUDGETS.wallTimeMs)).toString(),
  };
  await mkdir(input.runRoot, { recursive: true }).catch(() => undefined);
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

  const manifestPath = join(input.repositoryRoot, input.taskpackPath ?? '.loopwright/taskpack.yaml');
  let manifest: TaskpackManifest;
  try {
    manifest = await loadDeclarativeTaskpack({ manifestPath, repositoryRoot: input.repositoryRoot });
  } catch (error) {
    if (error instanceof GitHubAppError) {
      if (error.code === 'PROVIDER_OAUTH_UNSUPPORTED') {
        return { kind: 'refused', code: 'PROVIDER_OAUTH_UNSUPPORTED', reason: error.message };
      }
      return blocked('target repository manifest failed validation', 'loadDeclarativeTaskpack refused the manifest');
    }
    throw error;
  }

  const tenant = { installationId: 0, repositoryId: 0, repositoryFullName: input.repositoryFullName, taskpackId: manifest.metadata.name };
  let intake: TaskpackIntakeOutcome;
  if (eventNameIsTrigger(input.eventName)) {
    const outcome = prepareTaskpackIntake({
      mode: 'discover', tenant, baseRevision: input.baseRevision,
      records: input.upstreamRecords ?? [], targetMatrix: input.targetMatrix ?? null,
    });
    if (outcome.kind === 'discover' && outcome.disposition === 'no_change') return { kind: 'no_change', reason: outcome.reason };
    if (outcome.kind === 'discover' && outcome.disposition === 'blocked') {
      return blocked('upstream sources are unavailable', outcome.failures.map(failure => `${failure.upstreamId}: ${failure.error}`).join('; '));
    }
    intake = outcome;
  } else if (input.eventName === 'issue_comment' || input.eventName === 'pull_request_review') {
    const evaluation = evaluateCommentPayload(input.eventPayload, {
      eventName: input.eventName,
      commentPrefixes: input.commentPrefixes ?? manifest.spec.triggers.commentPrefixes,
      commentCommands: manifest.spec.triggers.commentCommands,
      operatorAllowlist: input.operatorAllowlist,
    });
    if ('ignoredReason' in evaluation) return blocked(`comment ignored: ${evaluation.ignoredReason}`);
    if ('blockedReason' in evaluation) return blocked(evaluation.blockedReason, evaluation.detail);
    const commandDigest = createHash('sha256').update(evaluation.guidance, 'utf8').digest('hex');
    if (evaluation.command === 'status') {
      intake = { kind: 'status', disposition: 'ready', summary: `status query admitted for ${input.repositoryFullName}/${manifest.metadata.name}` };
    } else if (evaluation.command === 'revise') {
      const reviseInput = {
        mode: 'revise' as const, tenant,
        command: { commandId: evaluation.commandId, headSha: evaluation.headSha, commandDigest },
        actorLogin: evaluation.login, authorAssociation: evaluation.authorAssociation,
        guidance: evaluation.guidance,
        ...(input.operatorAllowlist !== undefined ? { operatorAllowlist: input.operatorAllowlist } : {}),
      };
      const outcome = prepareTaskpackIntake(reviseInput);
      if (outcome.kind === 'revise' && outcome.disposition === 'blocked') return blocked(`revise command rejected: ${outcome.reason}`, outcome.detail);
      intake = outcome;
    } else {
      const discoverOutcome = prepareTaskpackIntake({
        mode: 'discover', tenant, baseRevision: input.baseRevision,
        records: input.upstreamRecords ?? [], targetMatrix: input.targetMatrix ?? null,
      });
      if (discoverOutcome.kind === 'discover' && discoverOutcome.disposition === 'no_change') return { kind: 'no_change', reason: discoverOutcome.reason };
      if (discoverOutcome.kind === 'discover' && discoverOutcome.disposition === 'blocked') return blocked('upstream sources are unavailable');
      intake = discoverOutcome;
    }
  } else {
    return blocked(`unsupported event ${input.eventName}`);
  }

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

  const scrubber = new SecretScrubber();
  const gateEnvName = input.credentialEnvMap?.gate ?? 'LOOPWRIGHT_GATE_SIGNING_SECRET';
  const publicationEnvName = input.credentialEnvMap?.publication ?? 'LOOPWRIGHT_PUBLICATION_SIGNING_SECRET';
  if (typeof runtimeEnv[gateEnvName] === 'string') scrubber.register(runtimeEnv[gateEnvName]!);
  if (typeof runtimeEnv[publicationEnvName] === 'string') scrubber.register(runtimeEnv[publicationEnvName]!);

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

  const makeBindings = (candidate: ResolvedModelCandidate): HostTaskpackBindings => ({
    mode: input.mode,
    repository: input.repositoryFullName,
    baseRevision: input.baseRevision,
    sourceRevision: input.sourceRevision ?? input.baseRevision,
    targetMatrix: input.targetMatrix ?? null,
    roleSelection,
    candidateIndex: candidate.manifestIndex,
    allowManifestCustomBaseUrl: input.allowManifestCustomBaseUrl,
    modelsJsonPath: input.modelsJsonPath,
    runtimeOptions: {},
    budgets: input.budgets ?? DEFAULT_HOST_BUDGETS,
    gateEndpoints: input.gateEndpoints ?? [],
    publicationEndpoint: input.publicationEndpoint ?? null,
    credentialEnvMap: {
      provider: input.credentialEnvMap?.provider !== undefined && !candidate.usesActiveTokenEnv
        ? input.credentialEnvMap.provider
        : candidate.providerEnvName,
      gate: gateEnvName,
      publication: publicationEnvName,
    },
    resourceVersion: input.resourceVersion,
    authorPrompt: input.authorPrompt,
  });

  let candidates: readonly ResolvedModelCandidate[];
  try {
    const previewBindings: HostTaskpackBindings = {
      mode: input.mode,
      repository: input.repositoryFullName,
      baseRevision: input.baseRevision,
      sourceRevision: input.sourceRevision ?? input.baseRevision,
      targetMatrix: input.targetMatrix ?? null,
      roleSelection,
      allowManifestCustomBaseUrl: input.allowManifestCustomBaseUrl,
      modelsJsonPath: input.modelsJsonPath,
      runtimeOptions: {},
      budgets: input.budgets ?? DEFAULT_HOST_BUDGETS,
      gateEndpoints: input.gateEndpoints ?? [],
      publicationEndpoint: input.publicationEndpoint ?? null,
      credentialEnvMap: {
        provider: input.credentialEnvMap?.provider ?? input.providerTokenEnv ?? 'LOOPWRIGHT_PROVIDER_TOKEN',
        gate: gateEnvName,
        publication: publicationEnvName,
      },
      resourceVersion: input.resourceVersion,
      authorPrompt: input.authorPrompt,
    };
    candidates = resolveTaskpackModelCandidates(manifest, previewBindings, {
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

  let realRunRoot: string;
  let realRepositoryRoot: string;
  const compileAndWriteCandidate = async (candidate: ResolvedModelCandidate, attemptSeq: number): Promise<WrittenCompiledTaskpack> => {
    const compiled = await compileDeclarativeTaskpack(manifest, makeBindings(candidate));
    realRunRoot ??= await realpath(input.runRoot);
    realRepositoryRoot ??= await realpath(input.repositoryRoot);
    if (insideRoot(realRunRoot, realRepositoryRoot)) {
      throw new GitHubAppError('ACTION_INPUT_INVALID', 'run root must live outside the target repository checkout');
    }
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

  if (input.dryRun === true || input.delegate === undefined) {
    return { kind: 'compiled', manifest, intake, taskpack: activeTaskpack, delegateOutcome: null };
  }

  let attemptSeq = 0;
  let lastOutcome = await invokeDelegateForCandidate(activeCandidate, activeTaskpack, input.delegate);
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
    attemptSeq += 1;
    activeTaskpack = await compileAndWriteCandidate(activeCandidate, attemptSeq);
    lastOutcome = await invokeDelegateForCandidate(activeCandidate, activeTaskpack, input.delegate);
  }

  return {
    kind: 'compiled',
    manifest,
    intake,
    taskpack: activeTaskpack,
    delegateOutcome: { ok: lastOutcome.ok, detail: scrubber.scrub(lastOutcome.detail) },
  };
}

function eventNameIsTrigger(eventName: string): boolean {
  return eventName === 'schedule' || eventName === 'workflow_dispatch' || eventName === 'repository_dispatch' || eventName === 'release';
}

/** Minimal GitHub Actions CLI shim: map INPUT_* environment variables and run the entrypoint. */
export async function runActionCli(env: NodeJS.ProcessEnv = process.env): Promise<number> {
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
  const result = await runGitHubActionEntrypoint({
    repositoryRoot,
    taskpackPath: env['INPUT_TASKPACK-PATH']?.trim() || undefined,
    repositoryFullName: env['LOOPWRIGHT_REPOSITORY'] ?? env['GITHUB_REPOSITORY'] ?? basename(repositoryRoot),
    baseRevision: env['GITHUB_SHA'] ?? 'HEAD',
    mode: mode === 'no-change' ? 'no-change' : 'candidate',
    eventName: env['INPUT_EVENT-NAME']?.trim() || env['GITHUB_EVENT_NAME'] || 'workflow_dispatch',
    eventPayload,
    runRoot: env['INPUT_RUN-ROOT']?.trim() || env['RUNNER_TEMP'] || resolve(repositoryRoot, '../.loopwright-runs'),
    runId: env['INPUT_RUN-ID']?.trim() || env['GITHUB_RUN_ID'] || 'local',
    storageProfile: storageProfile === 'durable' ? 'durable' : 'actions-basic',
    provider: env['INPUT_PROVIDER']?.trim() || undefined,
    model: env['INPUT_MODEL']?.trim() || undefined,
    thinking: thinking !== undefined && (PI_THINKING_LEVELS as readonly string[]).includes(thinking) ? thinking as PiThinkingLevel : undefined,
    api: api !== undefined && (PI_WIRE_APIS as readonly string[]).includes(api) ? api as PiWireApi : undefined,
    baseUrl: env['INPUT_BASE-URL']?.trim() || undefined,
    providerTokenEnv: env['INPUT_PROVIDER-TOKEN-ENV']?.trim() || undefined,
    modelsJsonPath: env['INPUT_MODELS-JSON']?.trim() || undefined,
    allowManifestCustomBaseUrl: env['INPUT_ALLOW-CUSTOM-BASE-URL'] === 'true',
    gateEndpoints: gateEndpointUrl ? [{ id: 'default', url: gateEndpointUrl, signingCredentialRef: 'taskpack-gate-signing' }] : undefined,
    publicationEndpoint: publicationEndpointUrl ? { id: 'default', url: publicationEndpointUrl, signingCredentialRef: 'taskpack-publication-signing' } : undefined,
    operatorAllowlist: env['LOOPWRIGHT_OPERATOR_ALLOWLIST']?.split(',').filter(entry => entry.length > 0),
    env,
    dryRun: env['INPUT_DRY-RUN'] === 'true',
  });
  const serialized = JSON.stringify(result);
  process.stdout.write(`${serialized}\n`);
  const githubOutput = env['GITHUB_OUTPUT'];
  if (typeof githubOutput === 'string' && githubOutput.length > 0) {
    appendFileSync(githubOutput, `result<<LOOPWRIGHT_EOF\n${serialized}\nLOOPWRIGHT_EOF\n`, 'utf8');
  }
  return result.kind === 'compiled' || result.kind === 'no_change' ? 0 : 1;
}

const invokedDirectly = process.argv[1] !== undefined && (() => {
  try { return resolve(process.argv[1]!) === fileURLToPath(import.meta.url); } catch { return false; }
})();
if (invokedDirectly) {
  void runActionCli().then(code => {
    process.exitCode = code;
  });
}
