import { createHash } from 'node:crypto';
import { closeSync, openSync, readFileSync } from 'node:fs';
import { chmod, mkdir, realpath, writeFile } from 'node:fs/promises';
import { basename, isAbsolute, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateMcpAuthConfiguration, qualifyDeploymentHostProfile } from './qualification.js';
import { authorizeRepositoryActor, compileDeclarativeTaskpack, DEFAULT_HOST_BUDGETS, loadDeclarativeTaskpack, parseCommentCommand, prepareTaskpackIntake, validateCommentGuidance } from './taskpack.js';
import { assertCleanArtifact, SecretScrubber } from './token-broker.js';
import {
  GitHubAppError,
  type ActionEntrypointInput, type ActionEntrypointResult, type ClockSample, type HostTaskpackBindings,
  type TaskpackCommentCommand, type TaskpackIntakeOutcome, type WrittenCompiledTaskpack,
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

/**
 * Run the complete offline-testable Action flow: qualify the host, refuse interactive MCP authentication,
 * load the target manifest, evaluate trigger intake, compile, write trusted artifacts outside the checkout,
 * scrub them, and optionally delegate execution.
 */
export async function runGitHubActionEntrypoint(input: ActionEntrypointInput): Promise<ActionEntrypointResult> {
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

  const manifestPath = join(input.repositoryRoot, input.taskpackPath ?? '.loopwright/taskpack.yaml');
  const manifest = await loadDeclarativeTaskpack({ manifestPath, repositoryRoot: input.repositoryRoot })
    .catch((error: unknown) => error instanceof GitHubAppError ? null : Promise.reject(error));
  if (manifest === null) return blocked('target repository manifest failed validation', 'loadDeclarativeTaskpack refused the manifest');

  const tenant = { installationId: 0, repositoryId: 0, repositoryFullName: input.repositoryFullName, taskpackId: manifest.metadata.id };
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
      intake = { kind: 'status', disposition: 'ready', summary: `status query admitted for ${input.repositoryFullName}/${manifest.metadata.id}` };
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

  const bindings: HostTaskpackBindings = {
    mode: input.mode,
    repository: input.repositoryFullName,
    baseRevision: input.baseRevision,
    sourceRevision: input.sourceRevision ?? input.baseRevision,
    targetMatrix: input.targetMatrix ?? null,
    roleSelection: {
      provider: input.provider ?? 'github-copilot',
      model: input.model ?? 'claude-sonnet-5.5',
      thinking: input.thinking ?? 'xhigh',
    },
    runtimeOptions: {},
    budgets: input.budgets ?? DEFAULT_HOST_BUDGETS,
    gateEndpoints: input.gateEndpoints ?? [],
    publicationEndpoint: input.publicationEndpoint ?? null,
    credentialEnvMap: input.credentialEnvMap ?? {
      provider: 'LOOPWRIGHT_PROVIDER_TOKEN',
      gate: 'LOOPWRIGHT_GATE_SIGNING_SECRET',
      publication: 'LOOPWRIGHT_PUBLICATION_SIGNING_SECRET',
    },
    resourceVersion: input.resourceVersion,
    authorPrompt: input.authorPrompt,
  };

  let compiled;
  try {
    compiled = await compileDeclarativeTaskpack(manifest, bindings);
  } catch (error) {
    if (error instanceof GitHubAppError) return blocked(error.code, error.message);
    throw error;
  }

  const realRunRoot = await realpath(input.runRoot);
  const realRepositoryRoot = await realpath(input.repositoryRoot);
  if (insideRoot(realRunRoot, realRepositoryRoot)) return blocked('run root must live outside the target repository checkout');
  // The controller loader adds dirname(configPath) to its trust roots and requires every trusted parent
  // directory to be 0o700, so registry and config live in separate owner-only subdirectories.
  const trustedDirectory = join(realRunRoot, `lw-action-${process.pid}-${Date.now().toString(36)}`);
  const registryDirectory = join(trustedDirectory, 'registry');
  const configDirectory = join(trustedDirectory, 'config');
  await mkdir(registryDirectory, { recursive: true });
  await mkdir(configDirectory, { recursive: true });
  await chmod(trustedDirectory, 0o700);
  await chmod(registryDirectory, 0o700);
  await chmod(configDirectory, 0o700);
  const registryPath = join(registryDirectory, 'registry.json');
  const configPath = join(configDirectory, 'config.json');
  const configBytes = Buffer.from(JSON.stringify(compiled.config));
  await writeFile(registryPath, compiled.registryBytes, { mode: 0o600 });
  await writeFile(configPath, configBytes, { mode: 0o600 });
  await chmod(registryPath, 0o600);
  await chmod(configPath, 0o600);
  const scrubber = new SecretScrubber();
  assertCleanArtifact(compiled.registryBytes, scrubber, '/registry');
  assertCleanArtifact(configBytes, scrubber, '/config');
  const taskpack: WrittenCompiledTaskpack = {
    ...compiled, configBytes, trustedDirectory, registryPath, configPath,
  };
  const delegateOutcome = input.dryRun === true || input.delegate === undefined
    ? null
    : await input.delegate(taskpack).then(outcome => ({ ok: outcome.ok, detail: outcome.detail }));
  return { kind: 'compiled', manifest, intake, taskpack, delegateOutcome };
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
  const thinking = env['INPUT_THINKING'];
  const storageProfile = env['INPUT_STORAGE-PROFILE'];
  const mode = env['INPUT_MODE'];
  const result = await runGitHubActionEntrypoint({
    repositoryRoot,
    taskpackPath: env['INPUT_TASKPACK-PATH'],
    repositoryFullName: env['LOOPWRIGHT_REPOSITORY'] ?? env['GITHUB_REPOSITORY'] ?? basename(repositoryRoot),
    baseRevision: env['GITHUB_SHA'] ?? 'HEAD',
    mode: mode === 'no-change' ? 'no-change' : 'candidate',
    eventName: env['INPUT_EVENT-NAME'] ?? env['GITHUB_EVENT_NAME'] ?? 'workflow_dispatch',
    eventPayload,
    runRoot: env['INPUT_RUN-ROOT'] ?? env['RUNNER_TEMP'] ?? resolve(repositoryRoot, '../.loopwright-runs'),
    runId: env['INPUT_RUN-ID'] ?? env['GITHUB_RUN_ID'] ?? 'local',
    storageProfile: storageProfile === 'durable' ? 'durable' : 'actions-basic',
    provider: env['INPUT_PROVIDER'],
    model: env['INPUT_MODEL'],
    thinking: thinking === 'minimal' || thinking === 'low' || thinking === 'medium' || thinking === 'high' || thinking === 'xhigh' ? thinking : undefined,
    operatorAllowlist: env['LOOPWRIGHT_OPERATOR_ALLOWLIST']?.split(',').filter(entry => entry.length > 0),
    dryRun: env['INPUT_DRY-RUN'] === 'true',
  });
  process.stdout.write(`${JSON.stringify(result)}\n`);
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
