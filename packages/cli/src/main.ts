#!/usr/bin/env node
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { chmod, lstat, mkdir, mkdtemp, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { STANDARD_PI_PROVIDER_ENV } from '@loopwright/agent-pi/catalog';
import { HostMcpRegistry } from '@loopwright/agent-pi/mcp';
import { compilePlan, formatRunReport, inspectRun, loadTrustedConfiguration, parseReportOutputFormats, readStatus, reconcileCycle, resumeCycle, resumeCycleWithPorts, runCycle, runCycleWithPorts, stepCancel, stepNext, stepSubmit, type ControllerDiagnostic, type ControllerPorts, type CycleExecution, type InspectRunValue, type LoadedConfiguration, type ReportCheckItem, type ReportModelInfo, type ReportOutputFormat, type RoleModelOverride, type RunReportInput, type StepTickResult } from '@loopwright/controller';
import { alignBaselineRevisions, assertCleanArtifact, BASELINE_CONFLICT_REASON, buildDefaultAuthorPrompt, checkTaskpackSuite, collectManifestSecretEnvNames, collectMcpReferencedEnvNames, compileDeclarativeTaskpack, computeTaskpackDigests, createTaskpackDecisionPort, DEFAULT_HOST_BUDGETS, DEFAULT_LOCAL_COMMAND_GATE_ENV, discoverTaskpackUpstreamsV2, evaluateUpstreamIntakeDisposition, executeTurnkeyCycle, finalizeLocalTurnkeyMemory, formatWorkspaceResourcesManifest, insideRoot, loadDeclarativeTaskpack, loadPiModelsJson, LOOPWRIGHT_ACTIVE_PROVIDER_TOKEN_ENV, normalizeRelativePath, openStagedTaskpackStepGate, parseActionInputLimits, parseAllowedHostMounts, parseBaselineAlignmentPolicy, parseLoopwrightEnvLimits, REPOSITORY_FULL_NAME_PATTERN, resolveDefaultProviderTokenEnv, resolveDigestLockfilePath, resolveExternalMcpConfigs, resolveRepositoryAndRevisions, resolveTaskpackModelCandidates, resolveTaskpackModelSelection, resolveTaskpackSuite, runTaskpackPreflight, SecretScrubber, selectHealthyModelCandidate, serializePrettyYaml, stageCompiledInstructionResources, stageTaskpackForStep, startLocalCommandGateServer, TaskpackError, validateGateToolchainPath, verifyDigestLockfile, writeDigestLockfile, type BaselineAlignmentOverride, type BaselineAlignmentResult, type CompiledTaskpack, type ExecutionHostPolicy, type HostGateEndpointPlan, type HostRoleSelection, type HostTaskpackBindings, type LoadedTaskpackSuite, type LocalCommandGateServer, type ParsedPiModelsJson, type PiThinkingLevel, type ResolvedModelCandidate, type RunTaskpackPreflightResult, type StagedTaskpackStepGateHandle, type SuiteResolutionResult, type TaskpackErrorCode, type TaskpackManifest, type TaskpackUpstreamRecord, type TurnkeyCycleAttemptSummary, type WrittenCompiledTaskpack } from '@loopwright/taskpack';
import { parseArguments, UsageError, type Arguments } from './arguments.js';
import { appendStepSummary, initDraft, writeOutput } from './draft.js';
import { evaluateClosureMatrix, CLOSURE_FALSIFICATION_FORBIDDEN, type ClosureMatrixReport } from './closure.js';
function resolveCliVersion(): string {
  try {
    const raw = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version?: unknown };
    if (typeof raw.version === 'string' && raw.version.length > 0) return raw.version;
  } catch { /* fallback */ }
  return '0.0.0';
}
const CLI_VERSION = resolveCliVersion();
const HELP = `loopwright ${CLI_VERSION}\ninit --directory DIR [--force] [--json]\ncheck --config FILE --registry FILE --registry-sha256 HEX [--role-model ROLE=PROVIDER/MODEL[:THINKING]] [--json] [--output FILE]\nrun --dry-run --config FILE --registry FILE --registry-sha256 HEX [--role-model ROLE=PROVIDER/MODEL[:THINKING]] [--json] [--output FILE]\nrun --config FILE --registry FILE --registry-sha256 HEX --repo DIR --run-root DIR --run-id ID [--role-model ROLE=PROVIDER/MODEL[:THINKING]] [--allow-privileged] [--allow-workflow-writes] [--json] [--output-format FORMATS] [--step-summary-file FILE]\nrun --dry-run --taskpack FILE --repo DIR [--mode candidate|no-change|auto] [--baseline-alignment off|fail-fast|extract-context] [--source-revision REV] [--role-model ROLE=PROVIDER/MODEL[:THINKING]] [--allow-privileged] [--allow-workflow-writes] [--allow-host-mounts PATHS] [--json] [--output FILE]\nrun --taskpack FILE --repo DIR --run-root DIR --run-id ID [--mode candidate|no-change|auto] [--baseline-alignment off|fail-fast|extract-context] [--source-revision REV] [--role-model ROLE=PROVIDER/MODEL[:THINKING]] [--allow-privileged] [--allow-workflow-writes] [--allow-host-mounts PATHS] [--json] [--output-format FORMATS] [--step-summary-file FILE]\nresume --run-root DIR --run-id ID --config FILE --registry FILE --registry-sha256 HEX --repo DIR [--role-model ROLE=PROVIDER/MODEL[:THINKING]] [--allow-privileged] [--allow-workflow-writes] [--json] [--output-format FORMATS] [--step-summary-file FILE]\nstep next --run-root DIR --run-id ID (--taskpack FILE --repo DIR | --config FILE --registry FILE --registry-sha256 HEX --repo DIR | [--repo DIR]) [--role-model ROLE=PROVIDER/MODEL[:THINKING]] [--mode candidate|no-change] [--baseline-alignment off|fail-fast|extract-context] [--source-revision REV] [--reissue-lease] [--allow-privileged] [--allow-workflow-writes] [--allow-host-mounts PATHS] [--json] [--output-format FORMATS] [--step-summary-file FILE]\nstep submit --run-root DIR --run-id ID --lease TOKEN [--submission-file FILE] [--status completed|no_change|failed|blocked] [--reason TEXT] [--allow-privileged] [--allow-workflow-writes] [--allow-host-mounts PATHS] [--json] [--output-format FORMATS] [--step-summary-file FILE]\nstep cancel --run-root DIR --run-id ID [--json] [--output-format FORMATS] [--step-summary-file FILE]\ndigest sync --taskpack FILE [--repo DIR] [--check] [--json]\nsuite check --suite FILE [--repo DIR] [--verify-digests] [--json]\nsuite resolve --suite FILE [--repo DIR] [--event NAME] [--schedule KEY] [--comment-body TEXT] [--pr-head-ref REF] [--pr-base-ref REF] [--domain ID] [--json]\nreconcile --config FILE --registry FILE --registry-sha256 HEX --repo DIR --run-root DIR --run-id ID --receipt FILE [--allow-workflow-writes] [--json] [--output FILE] [--output-format FORMATS] [--step-summary-file FILE]\nstatus --run-root DIR --run-id ID [--json]\ninspect --run-root DIR --run-id ID [--json] [--output DIR]\nclosure [--repo DIR] [--output FILE] [--json] [--verify-failures]\napp-serve --config FILE [--repo DIR] [--json]\nConfig and registry files accept YAML (.yaml, .yml) or JSON (.json); init writes controller.draft.yaml and registry.draft.yaml.\nStatic plans do not establish execution readiness. Strict proven_bound is the default.\nJSON verification requires both complete manifests and framing to fit the 16384-byte header; selected file <=1032184 bytes.\n`;
export interface Envelope { readonly version: 1; readonly kind: 'plan' | 'event' | 'status' | 'inspection' | 'result' | 'diagnostic' | 'incident' | 'closure' | 'step' | 'digest' | 'suite'; readonly sequence: number; readonly runId: string | null; readonly data: unknown }
export function encoded(value: unknown): string {
  return JSON.stringify(value).replace(/[\u007f-\u009f\u2028\u2029<>&]/g, char => '\\u' + char.charCodeAt(0).toString(16).padStart(4, '0')).replace(/::/g, '\\u003a\\u003a');
}
async function stdout(value: string): Promise<void> {
  if (Buffer.byteLength(value) > 1048576) throw new Error('CLI_OUTPUT_LIMIT');
  await new Promise<void>((done, reject) => { const timer = setTimeout(() => reject(new Error('CLI_BACKPRESSURE')), 1000); process.stdout.write(value, error => { clearTimeout(timer); if (error) reject(error); else done(); }); });
}
async function stderr(value: string): Promise<void> {
  if (Buffer.byteLength(value) > 1048576) throw new Error('CLI_OUTPUT_LIMIT');
  await new Promise<void>((done, reject) => { const timer = setTimeout(() => reject(new Error('CLI_BACKPRESSURE')), 1000); process.stderr.write(value, error => { clearTimeout(timer); if (error) reject(error); else done(); }); });
}
export function diagnosticExit(error: ControllerDiagnostic): number {
  if (error.code === 'RECOVERY_REQUIRED' || error.code === 'AUTHORITY_REFUSED' || error.code === 'OWNER_BUSY' || error.code === 'RECEIPT_CONFLICT') return 7;
  if (error.code === 'CAPABILITY_UNSUPPORTED' || error.code === 'MCP_AUTHENTICATION_REQUIRED') return 3;
  if (error.code === 'BUDGET_EXHAUSTED' || error.code === 'ATTEMPT_LIMIT' || error.code === 'REPEAT_FAILURE') return 5;
  if (error.code === 'DEADLINE') return 6;
  if (['STATE_UNAVAILABLE', 'CLEANUP_FAILED', 'ARTIFACT_INVALID', 'OUTPUT_LIMIT'].includes(error.code)) return 8;
  return ['admission', 'compile', 'configuration'].includes(error.phase) ? 2 : 4;
}
export function executionExit(value: CycleExecution, signal: string | null): number {
  if (value.kind === 'incident') return value.incident.code === 'RECOVERY_REQUIRED' ? 7 : 8;
  switch (value.result.spec.status) {
    case 'completed': case 'no_change': return 0;
    case 'blocked': return 3;
    case 'failed': return 4;
    case 'exhausted': return 5;
    case 'expired': return 6;
    case 'reconcile_required': return 7;
    case 'cancelled': return signal === 'SIGTERM' ? 143 : 130;
  }
}
export function closureExitCode(report: ClosureMatrixReport, verifyFailures: boolean): number {
  if (report.falsificationDetected || report.diagnostics.some(diagnostic => diagnostic.code === CLOSURE_FALSIFICATION_FORBIDDEN || diagnostic.code === 'CAPABILITY_UNSUPPORTED')) return 3;
  if (!report.integrity.ok) return 8;
  if (verifyFailures && (report.failureMatrix === null || !report.failureMatrix.allPassed)) return 4;
  return report.summary.closedLocal === 18 && report.summary.unprovisionedExternal === 5 ? 0 : 3;
}
async function queryInspection(runRoot: string, runId: string): Promise<InspectRunValue | null> {
  try {
    const inspected = await inspectRun({ runRoot, runId });
    return inspected.ok ? inspected.value : null;
  } catch {
    return null;
  }
}
function primaryModelInfo(configuration: LoadedConfiguration): ReportModelInfo | null {
  const firstRole = configuration.configuration.spec.task.spec.roles[0];
  return firstRole ? { provider: firstRole.provider, model: firstRole.model, thinking: firstRole.thinking } : null;
}
interface EmitOutcomeReportInput {
  readonly args: Arguments;
  readonly runRoot: string;
  readonly runId: string;
  readonly json: boolean;
  readonly configuration?: LoadedConfiguration;
  readonly model?: ReportModelInfo | null;
  readonly report: Omit<RunReportInput, 'runId' | 'model' | 'usage' | 'externalUrl'> & { readonly usage?: RunReportInput['usage'] };
  readonly emitDefault: () => Promise<void>;
}
async function emitOutcomeReports(input: EmitOutcomeReportInput): Promise<void> {
  const { args, runRoot, runId, json, configuration, model, report, emitDefault } = input;
  const outputFormats: readonly ReportOutputFormat[] = args.values.has('output-format')
    ? parseReportOutputFormats(args.values.get('output-format'))
    : [];
  const rawSummaryFile = args.values.get('step-summary-file')
    ?? (outputFormats.includes('github-step-summary') ? process.env['GITHUB_STEP_SUMMARY'] : undefined);
  const stepSummaryFile = rawSummaryFile !== undefined && rawSummaryFile.trim().length > 0 ? rawSummaryFile : undefined;
  if (outputFormats.length === 0 && stepSummaryFile === undefined) {
    await emitDefault();
    return;
  }
  const inspected = await queryInspection(runRoot, runId);
  const reportInput: RunReportInput = {
    runId,
    status: report.status,
    reasonCode: report.reasonCode ?? null,
    phase: report.phase ?? inspected?.status.stage ?? null,
    checks: report.checks ?? [],
    model: model !== undefined ? model : (configuration ? primaryModelInfo(configuration) : null),
    usage: report.usage ?? inspected?.usage ?? null,
    externalUrl: inspected?.externalUrl ?? null,
    runEval: report.runEval ?? inspected?.runEval ?? null,
  };
  if (stepSummaryFile !== undefined) {
    const summaryMd = formatRunReport(reportInput, 'github-step-summary') + '\n';
    await appendStepSummary(stepSummaryFile, Buffer.from(summaryMd, 'utf8'));
  }
  if (json || outputFormats.length === 0) {
    await emitDefault();
    return;
  }
  const stdoutFormats = outputFormats.filter(fmt => !(fmt === 'github-step-summary' && stepSummaryFile !== undefined));
  if (stdoutFormats.length === 0) {
    await emitDefault();
    return;
  }
  for (const fmt of stdoutFormats) {
    await stdout(formatRunReport(reportInput, fmt) + '\n');
  }
}
type EmitFn = (kind: Envelope['kind'], data: unknown, summary?: string) => Promise<void>;
async function emitExecutionOutcome(
  args: Arguments,
  runRoot: string,
  runId: string,
  json: boolean,
  outcome: CycleExecution,
  configuration: LoadedConfiguration | undefined,
  emit: EmitFn,
): Promise<void> {
  await emitOutcomeReports({
    args,
    runRoot,
    runId,
    json,
    ...(configuration !== undefined ? { configuration } : {}),
    report: outcome.kind === 'incident'
      ? { status: 'incident', reasonCode: outcome.incident.code, phase: outcome.incident.stage, checks: [] }
      : {
          status: outcome.result.spec.status,
          reasonCode: outcome.result.spec.verification.spec.diagnostics[0]?.code ?? null,
          phase: null,
          checks: [...outcome.result.spec.verification.spec.required, ...outcome.result.spec.verification.spec.optional].map(
            (row): ReportCheckItem => ({ checkId: row.checkId, status: row.status, code: row.reason, detail: row.detail }),
          ),
          usage: outcome.result.spec.usage,
        },
    emitDefault: () => outcome.kind === 'incident'
      ? emit('incident', outcome.incident, outcome.incident.code)
      : emit('result', outcome, outcome.result.spec.status),
  });
}
/** Map every TaskpackErrorCode exhaustively to its documented CLI exit code. */
export function taskpackExitCode(code: TaskpackErrorCode, reason?: string | null): number {
  if (reason === BASELINE_CONFLICT_REASON) return 3;
  switch (code) {
    case 'TASKPACK_MANIFEST_INVALID':
    case 'TASKPACK_UNTRUSTED_INTERPOLATION':
    case 'TASKPACK_SCOPE_VIOLATION':
    case 'TASKPACK_HOST_BINDING_INVALID':
    case 'TASKPACK_TRIGGER_UNSUPPORTED':
    case 'SANDBOX_POLICY_INVALID':
    case 'GITHUB_APP_CONFIG_INVALID':
    case 'TOKEN_BROKER_CONFIG_INVALID':
    case 'ACTION_INPUT_INVALID':
    case 'TENANT_IDENTITY_INVALID':
    case 'WEBHOOK_GUIDANCE_INVALID':
    case 'WEBHOOK_DELIVERY_INVALID':
      return 2;
    case 'PROVIDER_OAUTH_UNSUPPORTED':
    case 'SANDBOX_BACKEND_UNAVAILABLE':
    case 'SANDBOX_CAPABILITY_INSUFFICIENT':
    case 'MCP_OAUTH_UNSUPPORTED':
    case 'MCP_AUTHENTICATION_REQUIRED':
    case 'HOST_PROFILE_UNQUALIFIED':
    case 'WEBHOOK_ACTOR_UNAUTHORIZED':
    case 'WEBHOOK_SIGNATURE_INVALID':
    case 'TENANT_BOUNDARY_VIOLATION':
    case 'TENANT_INSTALLATION_REVOKED':
    case 'TOKEN_SCOPE_VIOLATION':
      return 3;
    case 'SANDBOX_EXECUTION_FAILED':
      return 4;
    case 'QUEUE_CAPACITY_EXCEEDED':
      return 5;
    case 'TOKEN_TTL_EXCEEDED':
      return 6;
    case 'HOST_CLOCK_UNTRUSTED':
    case 'QUEUE_LEASE_FENCED':
    case 'WEBHOOK_DELIVERY_CONFLICT':
      return 7;
    case 'STORAGE_PROFILE_INSUFFICIENT':
    case 'TOKEN_SECRET_LEAK_DETECTED':
    case 'SERVICE_FAULT':
    case 'QUEUE_STATE_INVALID':
    case 'WEBHOOK_PAYLOAD_TOO_LARGE':
      return 8;
    default: {
      const _exhaustive: never = code;
      return _exhaustive;
    }
  }
}
export { taskpackExitCode as gitHubAppExitCode };
function createCliScrubber(extraKeys: readonly string[] = []): SecretScrubber {
  const scrubber = new SecretScrubber();
  for (const key of ['GITHUB_TOKEN', 'GH_TOKEN', 'INPUT_GITHUB-TOKEN', 'INPUT_GITHUB-APP-PRIVATE-KEY', ...extraKeys]) {
    const value = process.env[key];
    if (typeof value === 'string' && value.length > 0) scrubber.register(value);
  }
  return scrubber;
}
async function canonicalPath(target: string): Promise<string> {
  const resolved = resolve(target);
  return await realpath(resolved).catch(() => resolved);
}
function isInsidePathRoot(target: string, root: string): boolean {
  return target === root || target.startsWith(root.endsWith(sep) ? root : `${root}${sep}`);
}
async function removeStagedDirSafely(dirPath: string): Promise<void> {
  const restoreDirs = async (target: string): Promise<void> => {
    const st = await lstat(target).catch(() => null);
    if (st === null || st.isSymbolicLink() || !st.isDirectory()) return;
    await chmod(target, 0o700).catch(() => {});
    const entries = await readdir(target, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (entry.isDirectory()) {
        await restoreDirs(join(target, entry.name));
      }
    }
  };
  await restoreDirs(dirPath);
  await rm(dirPath, { recursive: true, force: true }).catch(() => {});
}
async function inspectExistingDisjointRunRoot(resolvedRunRoot: string, requestedRepo: string): Promise<{
  readonly exists: boolean;
  readonly prospectiveRunRoot: string | null;
  readonly disjoint: boolean;
}> {
  let anc = resolvedRunRoot;
  let ancStat: Awaited<ReturnType<typeof lstat>>;
  for (;;) {
    try {
      ancStat = await lstat(anc);
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        return { exists: false, prospectiveRunRoot: null, disjoint: false };
      }
      const parent = dirname(anc);
      if (parent === anc) {
        return { exists: false, prospectiveRunRoot: null, disjoint: false };
      }
      anc = parent;
    }
  }
  const exists = anc === resolvedRunRoot;
  if (exists && (ancStat.isSymbolicLink() || !ancStat.isDirectory())) {
    return { exists: false, prospectiveRunRoot: null, disjoint: false };
  }
  if (!exists && !ancStat.isDirectory() && !ancStat.isSymbolicLink()) {
    return { exists: false, prospectiveRunRoot: null, disjoint: false };
  }
  let realAnc: string;
  try {
    realAnc = await realpath(anc);
    const realAncStat = await lstat(realAnc);
    if (!realAncStat.isDirectory()) {
      return { exists: false, prospectiveRunRoot: null, disjoint: false };
    }
  } catch {
    return { exists: false, prospectiveRunRoot: null, disjoint: false };
  }
  const prospectiveRunRoot = exists ? realAnc : resolve(realAnc, relative(anc, resolvedRunRoot));
  const disjoint = !isInsidePathRoot(prospectiveRunRoot, requestedRepo)
    && !isInsidePathRoot(requestedRepo, prospectiveRunRoot);
  return { exists, prospectiveRunRoot, disjoint };
}
async function withSignalAbort<T>(
  fn: (signal: AbortSignal, getCaughtSignal: () => string | null) => Promise<T>,
): Promise<T> {
  const abort = new AbortController();
  let caughtSignal: string | null = null;
  const interrupt = () => { caughtSignal ??= 'SIGINT'; abort.abort(); };
  const terminate = () => { caughtSignal ??= 'SIGTERM'; abort.abort(); };
  process.on('SIGINT', interrupt);
  process.on('SIGTERM', terminate);
  try {
    return await fn(abort.signal, () => caughtSignal);
  } finally {
    process.off('SIGINT', interrupt);
    process.off('SIGTERM', terminate);
  }
}
async function resolveRepoRelativeControlPath(
  rawPath: string,
  rawRepoRoot: string,
  repoRoot: string,
  label: string,
): Promise<string> {
  if (!isAbsolute(rawPath)) {
    return normalizeRelativePath(rawPath.replace(/\\/g, '/'), '/');
  }
  const absManifest = resolve(rawPath);
  const relFromRaw = relative(rawRepoRoot, absManifest);
  if (relFromRaw.length > 0 && relFromRaw !== '..' && !relFromRaw.startsWith(`..${sep}`) && !isAbsolute(relFromRaw)) {
    return normalizeRelativePath(relFromRaw.split(sep).join('/'), '/');
  }
  const relFromReal = relative(repoRoot, absManifest);
  if (relFromReal.length > 0 && relFromReal !== '..' && !relFromReal.startsWith(`..${sep}`) && !isAbsolute(relFromReal)) {
    return normalizeRelativePath(relFromReal.split(sep).join('/'), '/');
  }
  let ancestor = dirname(absManifest);
  let prev = '';
  while (ancestor !== prev) {
    const realAncestor = await realpath(ancestor).catch(() => null);
    if (realAncestor === repoRoot) {
      const relFromAncestor = relative(ancestor, absManifest);
      if (relFromAncestor.length > 0 && relFromAncestor !== '..' && !relFromAncestor.startsWith(`..${sep}`) && !isAbsolute(relFromAncestor)) {
        return normalizeRelativePath(relFromAncestor.split(sep).join('/'), '/');
      }
      break;
    }
    prev = ancestor;
    ancestor = dirname(ancestor);
  }
  throw new TaskpackError('TASKPACK_MANIFEST_INVALID', `${label} escapes the repository root`, '/');
}
async function resolveRepoRelativeTaskpackPath(
  rawTaskpack: string,
  rawRepoRoot: string,
  repoRoot: string,
): Promise<string> {
  return await resolveRepoRelativeControlPath(rawTaskpack, rawRepoRoot, repoRoot, 'taskpack manifest');
}
function parseTaskpackAlignmentArgs(args: Arguments): {
  readonly baselineAlignment?: BaselineAlignmentOverride | undefined;
  readonly sourceRevision?: string | undefined;
} {
  const baselineAlignment = args.values.has('baseline-alignment')
    ? parseBaselineAlignmentPolicy(args.values.get('baseline-alignment')!, '/baselineAlignment')
    : undefined;
  const rawSourceRevision = args.values.get('source-revision')?.trim();
  const sourceRevision = rawSourceRevision !== undefined && rawSourceRevision.length > 0 ? rawSourceRevision : undefined;
  return {
    ...(baselineAlignment !== undefined ? { baselineAlignment } : {}),
    ...(sourceRevision !== undefined ? { sourceRevision } : {}),
  };
}
async function emitTaskpackError(err: TaskpackError, emit: EmitFn, scrubber?: SecretScrubber): Promise<number> {
  const effectiveScrubber = scrubber ?? createCliScrubber();
  const message = effectiveScrubber.scrub(err.message);
  const path = typeof err.path === 'string' && err.path.length > 0 ? effectiveScrubber.scrub(err.path) : null;
  const reason = typeof err.reason === 'string' && err.reason.length > 0 ? effectiveScrubber.scrub(err.reason) : null;
  await emit(
    'diagnostic',
    { version: 1, code: err.code, ...(reason !== null ? { reason } : {}), message, ...(path !== null ? { path } : {}) },
    reason !== null ? `${err.code}: ${reason}` : err.code,
  );
  return taskpackExitCode(err.code, err.reason);
}
async function runSuiteCommand(args: Arguments, emit: EmitFn): Promise<number> {
  const rawRepoRoot = resolve(args.values.has('repo') ? args.values.get('repo')! : process.cwd());
  const repoRoot = await canonicalPath(rawRepoRoot);
  const scrubber = createCliScrubber();
  try {
    const suitePath = await resolveRepoRelativeControlPath(args.values.get('suite')!, rawRepoRoot, repoRoot, 'suite manifest');
    if (args.suiteAction === 'check') {
      const verifyDigests = args.flags.has('verify-digests');
      const loaded: LoadedTaskpackSuite = await checkTaskpackSuite({
        repositoryRoot: repoRoot,
        suitePath,
        policyProfile: 'local',
        enforceHostAuthority: false,
        verifyDigests,
      });
      const payload = {
        version: 1,
        action: 'check',
        ok: true,
        verifyDigests,
        suiteName: scrubber.scrub(loaded.manifest.metadata.name),
        suitePath: scrubber.scrub(loaded.suitePath),
        controlRoot: scrubber.scrub(loaded.controlRoot),
        suiteSha256: loaded.suiteSha256,
        stageOrder: loaded.stageOrder,
        suiteProtectedPaths: loaded.suiteProtectedPaths,
        domains: loaded.domains.map(domain => ({
          id: domain.id,
          taskpackPath: scrubber.scrub(domain.taskpackPath),
          taskpackName: scrubber.scrub(domain.taskpackName),
          manifestSha256: domain.manifestSha256,
          controlRoot: scrubber.scrub(domain.controlRoot),
          enabled: domain.enabled,
          ...(domain.stage !== undefined ? { stage: domain.stage } : {}),
          ...(domain.schedules !== undefined ? { schedules: domain.schedules } : {}),
          ...(domain.matrix !== undefined ? { matrix: domain.matrix } : {}),
        })),
      };
      const summary = scrubber.scrub(
        `suite check: ok (${loaded.domains.length} domains, ${loaded.stageOrder.length} stages, sha256:${loaded.suiteSha256.slice(0, 12)})`,
      );
      await emit('suite', payload, summary);
      return 0;
    }

    const githubToken = process.env['GITHUB_TOKEN']?.trim() || process.env['GH_TOKEN']?.trim() || undefined;
    const rawLoopwrightRepo = process.env['LOOPWRIGHT_REPOSITORY']?.trim();
    const rawGithubWorkspace = process.env['GITHUB_WORKSPACE']?.trim();
    let matchesGithubWorkspace = false;
    if (rawGithubWorkspace !== undefined && rawGithubWorkspace.length > 0) {
      const realGithubWorkspace = await realpath(rawGithubWorkspace).catch(() => null);
      matchesGithubWorkspace = realGithubWorkspace === repoRoot;
    }
    const hasExplicitLoopwrightRepo = rawLoopwrightRepo !== undefined && rawLoopwrightRepo.length > 0;
    const rawRepoFullName = hasExplicitLoopwrightRepo
      ? rawLoopwrightRepo
      : (matchesGithubWorkspace ? process.env['GITHUB_REPOSITORY']?.trim() : undefined);
    const repositoryFullName = rawRepoFullName !== undefined && REPOSITORY_FULL_NAME_PATTERN.test(rawRepoFullName)
      ? rawRepoFullName
      : undefined;
    const suiteEnv: NodeJS.ProcessEnv = (!hasExplicitLoopwrightRepo && matchesGithubWorkspace)
      ? process.env
      : { ...process.env, GITHUB_REPOSITORY: undefined };
    const resolution: SuiteResolutionResult = await resolveTaskpackSuite({
      repositoryRoot: repoRoot,
      suitePath,
      baseRevision: 'HEAD',
      ...(repositoryFullName !== undefined ? { repositoryFullName } : {}),
      ...(args.values.has('event') ? { eventName: args.values.get('event') } : {}),
      ...(args.values.has('schedule') ? { schedule: args.values.get('schedule') } : {}),
      ...(args.values.has('comment-body') ? { commentBody: args.values.get('comment-body') } : {}),
      ...(args.values.has('pr-head-ref') ? { prHeadRef: args.values.get('pr-head-ref') } : {}),
      ...(args.values.has('pr-base-ref') ? { prBaseRef: args.values.get('pr-base-ref') } : {}),
      ...(args.values.has('domain') ? { domain: args.values.get('domain') } : {}),
      ...(githubToken !== undefined ? { githubToken } : {}),
      discoverUpstreamUpdates: true,
      scrubber,
      env: suiteEnv,
    });
    const scrubbedComment = resolution.comment !== undefined
      ? Object.freeze({
        ...resolution.comment,
        guidance: scrubber.scrub(resolution.comment.guidance),
      })
      : undefined;
    const payload = {
      version: 1,
      action: 'resolve',
      ...resolution,
      ...(scrubbedComment !== undefined ? { comment: scrubbedComment } : {}),
    };
    const cellSummary = resolution.cells.map(cell => `${cell.domainId}:${cell.disposition}:${cell.reason}`).join(', ');
    const detailSuffix = resolution.detail !== undefined ? ` detail=${resolution.detail}` : '';
    const summary = scrubber.scrub(
      `suite resolve: disposition=${resolution.disposition} reason=${resolution.reason} matrix=${resolution.matrix.include.length} cells=[${cellSummary}]${detailSuffix}`,
    );
    await emit('suite', payload, summary);
    switch (resolution.disposition) {
      case 'eligible':
      case 'deferred':
      case 'ignored':
        return 0;
      case 'blocked':
        if (resolution.code === undefined || resolution.code === 'TASKPACK_SCOPE_VIOLATION') {
          return 3;
        }
        return taskpackExitCode(resolution.code);
      default: {
        const _exhaustive: never = resolution.disposition;
        return _exhaustive;
      }
    }
  } catch (err) {
    if (err instanceof TaskpackError) {
      return await emitTaskpackError(err, emit, scrubber);
    }
    throw err;
  }
}
async function runDigestCommand(args: Arguments, emit: EmitFn): Promise<number> {
  const rawRepoRoot = resolve(args.values.has('repo') ? args.values.get('repo')! : process.cwd());
  const repoRoot = await canonicalPath(rawRepoRoot);
  const checkOnly = args.flags.has('check');
  try {
    const manifestPath = await resolveRepoRelativeTaskpackPath(args.values.get('taskpack')!, rawRepoRoot, repoRoot);
    const manifest = await loadDeclarativeTaskpack({
      manifestPath,
      repositoryRoot: repoRoot,
      policyProfile: 'local',
      enforceHostAuthority: false,
    });
    const lockfilePath = resolveDigestLockfilePath(manifest, manifest.controlRoot);
    if (checkOnly) {
      const verified = await verifyDigestLockfile(repoRoot, manifest, manifest.controlRoot, lockfilePath);
      if (verified.ok) {
        await emit(
          'digest',
          {
            version: 1,
            action: 'sync',
            check: true,
            ok: true,
            taskpack: manifest.metadata.name,
            lockfilePath: verified.lockfilePath,
            entries: verified.computed.entries,
          },
          `digest sync --check: ok (${verified.computed.entries.length} entries in ${verified.lockfilePath})`,
        );
        return 0;
      }
      const scrubbedReason = createCliScrubber().scrub(verified.reason);
      await emit(
        'diagnostic',
        {
          version: 1,
          code: 'DIGEST_LOCKFILE_DRIFT',
          message: scrubbedReason,
          lockfilePath: verified.lockfilePath,
          taskpack: manifest.metadata.name,
          drifts: verified.drifts,
        },
        scrubbedReason,
      );
      return 4;
    }
    const lockfile = await computeTaskpackDigests(repoRoot, manifest, manifest.controlRoot);
    await writeDigestLockfile(repoRoot, lockfilePath, lockfile);
    await emit(
      'digest',
      {
        version: 1,
        action: 'sync',
        check: false,
        ok: true,
        taskpack: manifest.metadata.name,
        lockfilePath,
        entries: lockfile.entries,
      },
      `digest sync: wrote ${lockfile.entries.length} entries to ${lockfilePath}`,
    );
    return 0;
  } catch (err) {
    if (err instanceof TaskpackError) {
      return await emitTaskpackError(err, emit);
    }
    throw err;
  }
}
async function runStepCommand(args: Arguments, json: boolean, emit: EmitFn): Promise<number> {
  const get = (key: string) => args.values.get(key)!;
  const runId = get('run-id');
  const runRoot = resolve(get('run-root'));
  const allowPrivileged = args.flags.has('allow-privileged');
  const allowWorkflowWrites = args.flags.has('allow-workflow-writes');
  let gateHandle: StagedTaskpackStepGateHandle | null = null;
  let stagedDirToCleanOnUnadmittedFailure: string | null = null;
  try {
    const allowedHostMounts = parseAllowedHostMounts(args.values.get('allow-host-mounts'), '--allow-host-mounts');
    const stepHostPolicy: ExecutionHostPolicy = {
      policyProfile: 'local',
      allowPrivileged,
      allowWorkflowWrites,
      allowedHostMounts,
    };
    let loadedConfiguration: LoadedConfiguration | undefined;
    let resolvedRepo: string | undefined;
    let stepped: Awaited<ReturnType<typeof stepNext>> | Awaited<ReturnType<typeof stepCancel>>;
    let caughtSignal: string | null = null;
    try {
      const overrideOpt = args.roleModelOverrides ? { roleModelOverrides: args.roleModelOverrides } : {};
      if (args.stepAction === 'next' && args.values.has('taskpack')) {
        const requestedRepo = await canonicalPath(get('repo'));
        const preflightRunRoot = await inspectExistingDisjointRunRoot(runRoot, requestedRepo);
        let hadRunDir = false;
        if (preflightRunRoot.exists && preflightRunRoot.disjoint && preflightRunRoot.prospectiveRunRoot !== null) {
          const runDirPath = join(preflightRunRoot.prospectiveRunRoot, runId);
          hadRunDir = await lstat(runDirPath).then(() => true, () => false);
          if (!hadRunDir) {
            const stageCandidate = join(preflightRunRoot.prospectiveRunRoot, `.taskpack-${runId}`);
            const stageStat = await lstat(stageCandidate).catch(() => null);
            if (
              stageStat !== null
              && !stageStat.isSymbolicLink()
              && stageStat.isDirectory()
              && !isInsidePathRoot(requestedRepo, stageCandidate)
            ) {
              await removeStagedDirSafely(stageCandidate);
            }
          }
        }
        const { baselineAlignment, sourceRevision } = parseTaskpackAlignmentArgs(args);
        const staged = await stageTaskpackForStep({
          taskpackPath: get('taskpack'),
          repositoryRoot: requestedRepo,
          runRoot,
          runId,
          mode: (args.values.get('mode') as 'candidate' | 'no-change' | undefined) ?? 'candidate',
          ...(baselineAlignment !== undefined ? { baselineAlignment } : {}),
          ...(sourceRevision !== undefined ? { sourceRevision } : {}),
          policyProfile: 'local',
          allowPrivileged,
          allowWorkflowWrites,
          allowedHostMounts,
          hostPolicy: stepHostPolicy,
          runPreflight: true,
          runtimeEnv: process.env,
        });
        if (!hadRunDir) stagedDirToCleanOnUnadmittedFailure = staged.stageDir;
        const prevSecret = Object.hasOwn(process.env, staged.signingEnvName)
          ? process.env[staged.signingEnvName]
          : undefined;
        process.env[staged.signingEnvName] = staged.signingSecret;
        let loaded;
        try {
          loaded = await loadTrustedConfiguration({
            configPath: staged.configPath,
            registryPath: staged.registryPath,
            registrySha256: staged.registrySha256,
            untrustedRoots: [requestedRepo, ...(requestedRepo !== staged.repositoryRoot ? [staged.repositoryRoot] : [])],
            ...overrideOpt,
          });
        } finally {
          if (prevSecret === undefined) delete process.env[staged.signingEnvName];
          else process.env[staged.signingEnvName] = prevSecret;
        }
        if (!loaded.ok) {
          await emit('diagnostic', loaded.error, loaded.error.code);
          return diagnosticExit(loaded.error);
        }
        loadedConfiguration = loaded.value;
        resolvedRepo = requestedRepo;
      } else if (args.stepAction === 'next' && args.values.has('config')) {
        resolvedRepo = resolve(get('repo'));
        const loaded = await loadTrustedConfiguration({
          configPath: resolve(get('config')),
          registryPath: resolve(get('registry')),
          registrySha256: get('registry-sha256'),
          untrustedRoots: [resolvedRepo],
          ...overrideOpt,
        });
        if (!loaded.ok) {
          await emit('diagnostic', loaded.error, loaded.error.code);
          return diagnosticExit(loaded.error);
        }
        loadedConfiguration = loaded.value;
      }

      gateHandle = args.stepAction === 'next' && args.values.has('config')
        ? null
        : await openStagedTaskpackStepGate({ runRoot, runId, hostPolicy: stepHostPolicy, runtimeEnv: process.env });
      const gateEnvOpt = gateHandle ? { environment: gateHandle.environment } : {};
      const basePorts: ControllerPorts = gateHandle
        ? (gateHandle.ports ?? {
            gateUrlOverrides: gateHandle.gateUrlOverrides,
            ...(gateHandle.allowWorkflowWrites !== undefined ? { allowWorkflowWrites: gateHandle.allowWorkflowWrites } : {}),
            ...(gateHandle.roleMcpServers !== undefined ? { roleMcpServers: gateHandle.roleMcpServers } : {}),
            ...(gateHandle.mcpServers !== undefined ? { mcpServers: gateHandle.mcpServers } : {}),
            ...(gateHandle.decisions !== undefined ? { decisions: gateHandle.decisions } : {}),
          })
        : {};
      const gatePorts: ControllerPorts = allowWorkflowWrites && gateHandle === null
        ? { ...basePorts, allowWorkflowWrites: true }
        : basePorts;

      if (args.stepAction === 'next') {
        const modeOpt = args.values.has('mode') ? { mode: get('mode') as 'candidate' | 'no-change' } : {};
        const reissueOpt = args.flags.has('reissue-lease') ? { reissueLease: true } : {};
        if (resolvedRepo === undefined && args.values.has('repo')) {
          resolvedRepo = gateHandle !== null ? await canonicalPath(get('repo')) : resolve(get('repo'));
        }
        ({ stepped, caughtSignal } = await withSignalAbort(async (signal, getSignal) => ({
          stepped: await stepNext(
            {
              ...(loadedConfiguration ? { configuration: loadedConfiguration } : {}),
              ...(resolvedRepo !== undefined ? { repository: resolvedRepo } : {}),
              runRoot,
              runId,
              ...modeOpt,
              ...reissueOpt,
              ...gateEnvOpt,
              signal,
            },
            gatePorts,
          ),
          caughtSignal: getSignal(),
        })));
      } else if (args.stepAction === 'submit') {
        ({ stepped, caughtSignal } = await withSignalAbort(async (signal, getSignal) => ({
          stepped: await stepSubmit(
            {
              runRoot,
              runId,
              leaseToken: get('lease'),
              ...(args.values.has('submission-file') ? { submissionFile: resolve(get('submission-file')) } : {}),
              ...(args.values.has('status') ? { status: get('status') as 'completed' | 'no_change' | 'failed' | 'blocked' } : {}),
              ...(args.values.has('reason') ? { reason: get('reason') } : {}),
              ...gateEnvOpt,
              signal,
            },
            gatePorts,
          ),
          caughtSignal: getSignal(),
        })));
      } else {
        stepped = await stepCancel({ runRoot, runId, ...gateEnvOpt }, gatePorts);
      }
    } catch (err) {
      if (err instanceof TaskpackError) {
        return await emitTaskpackError(err, emit);
      }
      throw err;
    }

    if (!stepped.ok) {
      await emit('diagnostic', stepped.error, stepped.error.code);
      if (stepped.error.code === 'CANCELLED' && caughtSignal !== null) {
        return caughtSignal === 'SIGTERM' ? 143 : 130;
      }
      return diagnosticExit(stepped.error);
    }
    const value: StepTickResult = stepped.value;
    if (value.kind === 'step') {
      await emit('step', value, `awaiting_role: ${value.roleId} (${value.attemptId})`);
      return 0;
    }
    await emitExecutionOutcome(args, runRoot, runId, json, value, loadedConfiguration, emit);
    return executionExit(value, caughtSignal);
  } finally {
    await gateHandle?.close();
    if (stagedDirToCleanOnUnadmittedFailure !== null) {
      const hasRunDirNow = await lstat(join(dirname(stagedDirToCleanOnUnadmittedFailure), runId)).then(() => true, () => false);
      if (!hasRunDirNow) {
        await removeStagedDirSafely(stagedDirToCleanOnUnadmittedFailure);
      }
    }
  }
}
const DRY_RUN_PUBLICATION_SENTINEL_URL = 'http://127.0.0.1:65535/loopwright-dry-run-publication';
function applyTaskpackRoleModelOverrides(
  manifest: TaskpackManifest,
  overrides: readonly RoleModelOverride[] | undefined,
): { readonly manifest: TaskpackManifest; readonly roleSelection?: HostRoleSelection } {
  if (overrides === undefined || overrides.length === 0) {
    return { manifest };
  }
  const declaredRoles = manifest.spec.roles;
  if (declaredRoles !== undefined && declaredRoles.length > 0) {
    const byId = new Map<string, RoleModelOverride>();
    const knownIds = new Set(declaredRoles.map(role => role.id));
    for (const override of overrides) {
      if (!knownIds.has(override.roleId)) {
        throw new TaskpackError(
          'ACTION_INPUT_INVALID',
          `unknown --role-model role "${override.roleId}"`,
          '/roleModelOverrides',
        );
      }
      byId.set(override.roleId, override);
    }
    const updatedRoles = declaredRoles.map(role => {
      const override = byId.get(role.id);
      if (override === undefined) return role;
      const { models: _unusedModels, ...roleBase } = role;
      void _unusedModels;
      return {
        ...roleBase,
        provider: override.provider,
        model: override.model,
        ...(override.thinking !== undefined ? { thinking: override.thinking } : {}),
      };
    });
    return {
      manifest: {
        ...manifest,
        spec: {
          ...manifest.spec,
          roles: updatedRoles,
        },
      },
    };
  }
  let seenAuthor = false;
  for (const override of overrides) {
    if (override.roleId !== 'author') {
      throw new TaskpackError(
        'ACTION_INPUT_INVALID',
        `unknown --role-model role "${override.roleId}"`,
        '/roleModelOverrides',
      );
    }
    if (seenAuthor) {
      throw new TaskpackError(
        'ACTION_INPUT_INVALID',
        'duplicate --role-model override for role "author"',
        '/roleModelOverrides',
      );
    }
    seenAuthor = true;
  }
  const authorOverride = overrides[0]!;
  return {
    manifest,
    roleSelection: {
      provider: authorOverride.provider,
      model: authorOverride.model,
      ...(authorOverride.thinking !== undefined ? { thinking: authorOverride.thinking as PiThinkingLevel } : {}),
    },
  };
}
function turnkeySummaryExit(summary: TurnkeyCycleAttemptSummary, signal: string | null): number {
  switch (summary.status) {
    case 'completed':
    case 'no_change':
      return 0;
    case 'blocked':
      return 3;
    case 'exhausted':
      return 5;
    case 'expired':
      return 6;
    case 'reconcile_required':
      return 7;
    case 'cancelled':
      return signal === 'SIGTERM' ? 143 : 130;
    default:
      break;
  }
  switch (summary.reasonCode) {
    case 'RECOVERY_REQUIRED':
    case 'AUTHORITY_REFUSED':
    case 'OWNER_BUSY':
    case 'RECEIPT_CONFLICT':
      return 7;
    case 'CAPABILITY_UNSUPPORTED':
    case 'MCP_AUTHENTICATION_REQUIRED':
      return 3;
    case 'BUDGET_EXHAUSTED':
    case 'ATTEMPT_LIMIT':
    case 'REPEAT_FAILURE':
      return 5;
    case 'DEADLINE':
      return 6;
    case 'CANCELLED':
      return signal === 'SIGTERM' ? 143 : 130;
    case 'STATE_UNAVAILABLE':
    case 'CLEANUP_FAILED':
    case 'ARTIFACT_INVALID':
    case 'OUTPUT_LIMIT':
      return 8;
    default:
      return 4;
  }
}
async function writeCompiledTaskpackDir(
  trustedDirectory: string,
  compiled: CompiledTaskpack,
  scrubber: SecretScrubber,
): Promise<WrittenCompiledTaskpack> {
  const registryDirectory = join(trustedDirectory, 'registry');
  const configDirectory = join(trustedDirectory, 'config');
  await mkdir(registryDirectory, { recursive: true, mode: 0o700 });
  await mkdir(configDirectory, { recursive: true, mode: 0o700 });
  await chmod(trustedDirectory, 0o700);
  await chmod(registryDirectory, 0o700);
  await chmod(configDirectory, 0o700);
  const registryPath = join(registryDirectory, 'registry.yaml');
  const configPath = join(configDirectory, 'config.yaml');
  const configBytes = Buffer.from(serializePrettyYaml(compiled.config), 'utf8');
  assertCleanArtifact(compiled.registryBytes, scrubber, '/registry');
  assertCleanArtifact(configBytes, scrubber, '/config');
  for (const resource of compiled.instructionResources ?? []) {
    assertCleanArtifact(resource.bytes, scrubber, `/resources/${resource.id}`);
  }
  await writeFile(registryPath, compiled.registryBytes, { mode: 0o600 });
  await writeFile(configPath, configBytes, { mode: 0o600 });
  await chmod(registryPath, 0o600);
  await chmod(configPath, 0o600);
  if (compiled.instructionResources !== undefined && compiled.instructionResources.length > 0) {
    await stageCompiledInstructionResources(registryDirectory, compiled.instructionResources);
  }
  return {
    ...compiled,
    configBytes,
    trustedDirectory,
    registryPath,
    configPath,
  };
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
      endpointRef: 'loopwright-local-command' as const,
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

async function runTaskpackCommand(args: Arguments, json: boolean, emit: EmitFn): Promise<number> {
  const get = (key: string) => args.values.get(key)!;
  const dryRun = args.flags.has('dry-run');
  const allowPrivileged = args.flags.has('allow-privileged');
  const allowWorkflowWrites = args.flags.has('allow-workflow-writes');
  const output = args.values.get('output');
  const scrubber = createCliScrubber();
  let localGateServer: LocalCommandGateServer | undefined;
  let mcpRegistry: HostMcpRegistry | undefined;
  let preflightResult: RunTaskpackPreflightResult | undefined;
  try {
    const rawRepoRoot = resolve(get('repo'));
    let repoRoot: string;
    try {
      repoRoot = await realpath(rawRepoRoot);
      const repoStat = await lstat(repoRoot);
      if (!repoStat.isDirectory()) {
        throw new TaskpackError('ACTION_INPUT_INVALID', 'repositoryRoot must exist');
      }
    } catch (err) {
      if (err instanceof TaskpackError) throw err;
      throw new TaskpackError('ACTION_INPUT_INVALID', 'repositoryRoot must exist');
    }

    const allowedHostMounts = parseAllowedHostMounts(args.values.get('allow-host-mounts'), '--allow-host-mounts');
    const relativeTaskpackPath = await resolveRepoRelativeTaskpackPath(get('taskpack'), rawRepoRoot, repoRoot);
    const hostPolicy: ExecutionHostPolicy = {
      policyProfile: 'local',
      allowPrivileged,
      allowWorkflowWrites,
      allowedHostMounts,
    };
    const rawManifest = await loadDeclarativeTaskpack({
      manifestPath: relativeTaskpackPath,
      repositoryRoot: repoRoot,
      policyProfile: 'local',
      hostPolicy,
    });

    if (!dryRun) {
      if (rawManifest.spec.publication.mode === 'pull_request') {
        throw new TaskpackError(
          'TASKPACK_HOST_BINDING_INVALID',
          'local CLI "loopwright run --taskpack" has no GitHub pull-request publisher bound; set spec.publication.mode to "disabled" or run via GitHub Action/App',
          '/spec/publication/mode',
        );
      }
      if (rawManifest.spec.memory.apply === 'separate-pull-request') {
        throw new TaskpackError(
          'TASKPACK_HOST_BINDING_INVALID',
          'local CLI "loopwright run --taskpack" has no GitHub pull-request memory publisher bound; set spec.memory.apply to "local-only" or "disabled"',
          '/spec/memory/apply',
        );
      }
    }

    const { manifest, roleSelection } = applyTaskpackRoleModelOverrides(rawManifest, args.roleModelOverrides);
    const manifestSecretEnvs = collectManifestSecretEnvNames(manifest);
    for (const envName of manifestSecretEnvs) {
      const val = process.env[envName];
      if (typeof val === 'string' && val.length > 0) scrubber.register(val);
    }

    const { baselineAlignment, sourceRevision: explicitSourceRevision } = parseTaskpackAlignmentArgs(args);

    const envRepo = process.env['LOOPWRIGHT_REPOSITORY']?.trim();
    const repositoryFullName = envRepo !== undefined && REPOSITORY_FULL_NAME_PATTERN.test(envRepo)
      ? envRepo
      : 'local/repo';
    const resolvedRepo = await resolveRepositoryAndRevisions({
      repositoryRoot: repoRoot,
      repositoryFullName,
      baseRevision: 'HEAD',
      ...(explicitSourceRevision !== undefined
        ? { sourceRevision: explicitSourceRevision, preserveExplicitSourceRevision: true }
        : {}),
      eventName: 'workflow_dispatch',
      scrubber,
    });

    const modelsJsonPath = process.env['LOOPWRIGHT_MODELS_JSON']?.trim() || undefined;
    const modelsConfig: ParsedPiModelsJson | undefined = modelsJsonPath !== undefined
      ? await loadPiModelsJson(modelsJsonPath)
      : undefined;
    const allowManifestCustomBaseUrl = process.env['LOOPWRIGHT_ALLOW_MANIFEST_CUSTOM_BASE_URL'] === 'true';
    const envLimits = parseLoopwrightEnvLimits(process.env);
    const actionInputLimits = parseActionInputLimits(process.env);
    const requestedMode = (args.values.get('mode') as 'candidate' | 'no-change' | 'auto' | undefined) ?? 'auto';

    if (dryRun) {
      const effectiveDryRunMode: 'candidate' | 'no-change' = requestedMode === 'no-change' ? 'no-change' : 'candidate';
      const defaultProviderEnv = roleSelection?.provider !== undefined
        ? resolveDefaultProviderTokenEnv(roleSelection.provider, {
            modelsJsonApiKeyEnv: modelsConfig?.providers.get(roleSelection.provider)?.apiKeyEnv,
            env: process.env,
          })
        : manifest.spec.models !== undefined && manifest.spec.models.length > 0
          ? (manifest.spec.models[0]!.apiKeyEnv ?? resolveDefaultProviderTokenEnv(manifest.spec.models[0]!.provider, {
              modelsJsonApiKeyEnv: modelsConfig?.providers.get(manifest.spec.models[0]!.provider)?.apiKeyEnv,
              env: process.env,
            }))
          : 'LOOPWRIGHT_PROVIDER_TOKEN';
      const dryRunBindings: HostTaskpackBindings = {
        mode: effectiveDryRunMode,
        hostPolicy,
        repository: repositoryFullName,
        repositoryRoot: repoRoot,
        taskpackPath: relativeTaskpackPath,
        baseRevision: resolvedRepo.baseRevision,
        sourceRevision: resolvedRepo.sourceRevision,
        ...(baselineAlignment !== undefined ? { baselineAlignment } : {}),
        targetMatrix: manifest.spec.target?.matrix ?? null,
        ...(roleSelection !== undefined ? { roleSelection } : {}),
        allowManifestCustomBaseUrl,
        modelsJsonPath,
        budgets: DEFAULT_HOST_BUDGETS,
        limits: actionInputLimits,
        envLimits,
        publicationEndpoint: effectiveDryRunMode === 'candidate' && manifest.spec.publication.mode === 'pull_request'
          ? {
              id: 'dry-run-publication',
              url: DRY_RUN_PUBLICATION_SENTINEL_URL,
              signingCredentialRef: 'taskpack-publication-signing',
            }
          : null,
        credentialEnvMap: {
          provider: defaultProviderEnv,
          gate: 'LOOPWRIGHT_GATE_SIGNING_SECRET',
          publication: 'LOOPWRIGHT_PUBLICATION_SIGNING_SECRET',
          publicationAuth: 'LOOPWRIGHT_PUBLICATION_AUTH_TOKEN',
          localCommandGate: DEFAULT_LOCAL_COMMAND_GATE_ENV,
        },
        scrubber,
      };
      const compiled = await compileDeclarativeTaskpack(manifest, dryRunBindings);
      const dryRunRoot = await realpath(await mkdtemp(join(tmpdir(), 'loopwright-dryrun-')));
      const savedEnv = new Map<string, string | undefined>();
      try {
        const written = await writeCompiledTaskpackDir(dryRunRoot, compiled, scrubber);
        for (const binding of compiled.registry.spec.environmentBindings) {
          if (binding.classification === 'credential' && process.env[binding.name] === undefined) {
            savedEnv.set(binding.name, undefined);
            process.env[binding.name] = `dry-run-${randomBytes(8).toString('hex')}`;
          }
        }
        const loaded = await loadTrustedConfiguration({
          configPath: written.configPath,
          registryPath: written.registryPath,
          registrySha256: written.registrySha256,
          untrustedRoots: [repoRoot],
        });
        if (!loaded.ok) {
          await emit('diagnostic', loaded.error, loaded.error.code);
          return diagnosticExit(loaded.error);
        }
        const plan = await compilePlan(loaded.value);
        if (!plan.ok) {
          await emit('diagnostic', plan.error, plan.error.code);
          return diagnosticExit(plan.error);
        }
        if (output !== undefined) await writeOutput(output, Buffer.from(encoded(plan.value) + '\n'));
        await emit('plan', plan.value, 'Plan checked; admission not performed; execution readiness not checked.');
        return 0;
      } finally {
        for (const [key, prior] of savedEnv.entries()) {
          if (prior === undefined) delete process.env[key];
          else process.env[key] = prior;
        }
        await removeStagedDirSafely(dryRunRoot);
      }
    }

    const runId = get('run-id');
    const resolvedRunRoot = resolve(get('run-root'));
    const preflightRootCheck = await inspectExistingDisjointRunRoot(resolvedRunRoot, repoRoot);
    if (preflightRootCheck.prospectiveRunRoot === null || !preflightRootCheck.disjoint) {
      throw new TaskpackError('ACTION_INPUT_INVALID', 'runRoot must be a non-symlink directory outside the target repository checkout');
    }
    await mkdir(resolvedRunRoot, { recursive: true, mode: 0o700 });
    const runRootStat = await lstat(resolvedRunRoot);
    if (runRootStat.isSymbolicLink() || !runRootStat.isDirectory()) {
      throw new TaskpackError('ACTION_INPUT_INVALID', 'runRoot must be a non-symlink directory');
    }
    await chmod(resolvedRunRoot, 0o700);
    const realRunRoot = await realpath(resolvedRunRoot);
    if (insideRoot(realRunRoot, repoRoot) || insideRoot(repoRoot, realRunRoot)) {
      throw new TaskpackError('ACTION_INPUT_INVALID', 'runRoot must live outside the target repository checkout');
    }

    let upstreamRecords: readonly TaskpackUpstreamRecord[] = [];
    let autoNoChangeReason: string | null = null;
    if (manifest.spec.preflight !== undefined) {
      const preflightRun = await withSignalAbort(async (signal, getCaughtSignal) => ({
        result: await runTaskpackPreflight({
          manifest,
          repositoryRoot: repoRoot,
          authorized: true,
          hostPolicy,
          env: process.env,
          scrubber,
          tempRoot: realRunRoot,
          signal,
        }),
        caughtSignal: getCaughtSignal(),
      }));
      preflightResult = preflightRun.result;
      if (preflightRun.caughtSignal !== null) {
        return preflightRun.caughtSignal === 'SIGTERM' ? 143 : 130;
      }
      if (preflightResult.disposition === 'blocked') {
        const rawReason = preflightResult.reason?.trim();
        const message = rawReason !== undefined && rawReason.length > 0
          ? `preflight blocked: ${rawReason}`
          : 'preflight blocked: blocked by preflight';
        throw new TaskpackError('ACTION_INPUT_INVALID', scrubber.scrub(message));
      }
      if (requestedMode === 'auto' && preflightResult.disposition === 'no_change') {
        autoNoChangeReason = preflightResult.reason ?? 'preflight returned no_change';
      }
      upstreamRecords = preflightResult.upstreams;
    }

    if (manifest.spec.upstreams.length > 0 && upstreamRecords.length === 0) {
      const discovered = await discoverTaskpackUpstreamsV2(manifest, {
        repositoryRoot: repoRoot,
        scrubber,
        env: process.env,
      });
      upstreamRecords = discovered.records;
      if (requestedMode === 'auto' && autoNoChangeReason === null) {
        const intakeDisp = evaluateUpstreamIntakeDisposition(discovered.records);
        if (intakeDisp.disposition === 'blocked') {
          throw new TaskpackError('ACTION_INPUT_INVALID', scrubber.scrub(intakeDisp.reason));
        }
        if (intakeDisp.disposition === 'no_change') {
          autoNoChangeReason = intakeDisp.reason;
        }
      }
    }

    const isAutoNoChange = requestedMode === 'auto' && autoNoChangeReason !== null;
    const effectiveMode: 'candidate' | 'no-change' = (requestedMode === 'no-change' || isAutoNoChange)
      ? 'no-change'
      : 'candidate';

    let baselineAlignmentResult: BaselineAlignmentResult | undefined;
    if (effectiveMode === 'candidate' && resolvedRepo.sourceRevision !== resolvedRepo.baseRevision) {
      baselineAlignmentResult = await alignBaselineRevisions({
        repositoryRoot: repoRoot,
        baseRevision: resolvedRepo.baseRevision,
        sourceRevision: resolvedRepo.sourceRevision,
        manifest,
        taskpackPath: relativeTaskpackPath,
        policyProfile: 'local',
        hostPolicy,
        ...(baselineAlignment !== undefined ? { baselineAlignment } : {}),
        scrubber,
        scratchRoot: realRunRoot,
      });
      if (baselineAlignmentResult.status === 'blocked') {
        throw new TaskpackError(
          'TASKPACK_SCOPE_VIOLATION',
          baselineAlignmentResult.detail,
          '/spec/baselineAlignment',
          { reason: baselineAlignmentResult.reason },
        );
      }
    }
    const enableBaselineConflictGate = effectiveMode === 'candidate'
      && baselineAlignmentResult !== undefined
      && (baselineAlignmentResult.conflictResource !== null || baselineAlignmentResult.disposition === 'unmerged_off');

    let activeGateEndpoints: readonly HostGateEndpointPlan[] = [];
    let trackedSourceTokenEnvNames: readonly string[] = [];
    const buildBindings = (candidate?: ResolvedModelCandidate): HostTaskpackBindings => {
      const externalMcpTools = mcpRegistry !== undefined && mcpRegistry.toolNames.length > 0
        ? mcpRegistry.toolNames
        : undefined;
      const externalMcpToolSchemas = mcpRegistry !== undefined && externalMcpTools !== undefined
        ? mcpRegistry.toolSchemasFor(externalMcpTools)
        : undefined;
      const acceptanceCheckIds = [
        ...manifest.spec.verification.localChecks.map(check => check.id),
        ...manifest.spec.verification.externalGates.map(gate => gate.id),
      ];
      const basePrompt = buildDefaultAuthorPrompt({
        mode: effectiveMode,
        repositoryFullName,
        upstreamRecords,
        externalMcpTools,
        acceptanceCheckIds,
        runtimeEnv: process.env,
        scrubber,
      });
      const wsManifestText = preflightResult !== undefined && preflightResult.workspaceResources.length > 0
        ? formatWorkspaceResourcesManifest(preflightResult.workspaceResources, preflightResult.stagedDir, scrubber)
        : undefined;
      const authorPrompt = wsManifestText !== undefined && wsManifestText.length > 0
        ? `${basePrompt}\n\n${wsManifestText}`
        : basePrompt;
      return {
        mode: effectiveMode,
        ...(isAutoNoChange ? { checkOnlyNoChange: true } : {}),
        hostPolicy,
        repository: repositoryFullName,
        repositoryRoot: repoRoot,
        taskpackPath: relativeTaskpackPath,
        baseRevision: resolvedRepo.baseRevision,
        sourceRevision: resolvedRepo.sourceRevision,
        ...(baselineAlignment !== undefined ? { baselineAlignment } : {}),
        ...(baselineAlignmentResult !== undefined ? { baselineAlignmentResult } : {}),
        ...(baselineAlignmentResult?.conflictResource != null ? { baselineConflictResource: baselineAlignmentResult.conflictResource } : {}),
        ...(enableBaselineConflictGate ? { enableBaselineConflictGate: true } : {}),
        upstreamRecords,
        targetMatrix: manifest.spec.target?.matrix ?? null,
        ...(roleSelection !== undefined ? { roleSelection } : {}),
        ...(candidate !== undefined && roleSelection === undefined ? { candidateIndex: candidate.manifestIndex } : {}),
        allowManifestCustomBaseUrl,
        modelsJsonPath,
        budgets: DEFAULT_HOST_BUDGETS,
        limits: actionInputLimits,
        envLimits,
        ...(externalMcpTools !== undefined ? { externalMcpTools } : {}),
        ...(externalMcpToolSchemas !== undefined ? { externalMcpToolSchemas } : {}),
        gateEndpoints: activeGateEndpoints,
        publicationEndpoint: null,
        credentialEnvMap: {
          provider: candidate !== undefined
            ? candidate.providerEnvName
            : (roleSelection?.provider !== undefined
                ? resolveDefaultProviderTokenEnv(roleSelection.provider, {
                    modelsJsonApiKeyEnv: modelsConfig?.providers.get(roleSelection.provider)?.apiKeyEnv,
                    env: process.env,
                  })
                : 'LOOPWRIGHT_PROVIDER_TOKEN'),
          gate: 'LOOPWRIGHT_GATE_SIGNING_SECRET',
          publication: 'LOOPWRIGHT_PUBLICATION_SIGNING_SECRET',
          publicationAuth: 'LOOPWRIGHT_PUBLICATION_AUTH_TOKEN',
          localCommandGate: DEFAULT_LOCAL_COMMAND_GATE_ENV,
        },
        ...(trackedSourceTokenEnvNames.length > 0 ? { sourceTokenEnvNames: trackedSourceTokenEnvNames } : {}),
        authorPrompt,
        preflightPromptResources: preflightResult?.promptResources,
        preflightWorkspaceResources: preflightResult?.workspaceResources,
        scrubber,
      };
    };

    const roleProviderEnvNames: string[] = [];
    if (!isAutoNoChange && manifest.spec.roles !== undefined && manifest.spec.roles.length > 0) {
      for (const role of manifest.spec.roles) {
        const roleBindings: HostTaskpackBindings = {
          ...buildBindings(),
          candidateIndex: undefined,
          roleSelection: {
            provider: role.provider,
            model: role.model,
            ...(role.thinking !== undefined ? { thinking: role.thinking as PiThinkingLevel } : {}),
          },
        };
        const { selection, apiKeyEnv } = resolveTaskpackModelSelection(manifest, roleBindings, modelsConfig);
        const modelsJsonApiKeyEnv = modelsConfig?.providers.get(selection.provider)?.apiKeyEnv;
        roleProviderEnvNames.push(resolveDefaultProviderTokenEnv(selection.provider, {
          modelsJsonApiKeyEnv,
          manifestApiKeyEnv: apiKeyEnv,
          env: process.env,
        }));
      }
    }

    let activeCandidate: ResolvedModelCandidate | undefined;
    if (isAutoNoChange) {
      try {
        const ncCandidates = resolveTaskpackModelCandidates(manifest, buildBindings(), {
          modelsConfig,
          env: process.env,
          scrubber,
        });
        activeCandidate = ncCandidates[0];
      } catch (err) {
        if (err instanceof TaskpackError && err.code === 'PROVIDER_OAUTH_UNSUPPORTED') throw err;
        activeCandidate = undefined;
      }
    } else {
      if (effectiveMode === 'candidate') {
        await validateManifestCommandToolchainPaths(manifest, repoRoot, hostPolicy.allowPrivileged === true);
      }
      const firstRole = manifest.spec.roles?.[0];
      const candidateBaseBindings = (manifest.spec.models === undefined && firstRole !== undefined && roleSelection === undefined)
        ? {
            ...buildBindings(),
            roleSelection: {
              provider: firstRole.provider,
              model: firstRole.model,
              ...(firstRole.thinking !== undefined ? { thinking: firstRole.thinking as PiThinkingLevel } : {}),
            },
          }
        : buildBindings();
      const candidates = resolveTaskpackModelCandidates(manifest, candidateBaseBindings, {
        modelsConfig,
        env: process.env,
        scrubber,
      });
      if (candidates.length >= 2) {
        const selected = await selectHealthyModelCandidate(candidates, { scrubber });
        activeCandidate = candidates[selected.index];
      } else {
        activeCandidate = candidates[0];
      }
    }

    const effectiveMcpDecls = manifest.spec.mcp?.servers ?? [];
    const forbiddenCommandEnvNames = new Set<string>([
      ...Object.values(STANDARD_PI_PROVIDER_ENV),
      ...(activeCandidate !== undefined
        ? [
            activeCandidate.providerEnvName,
            ...(activeCandidate.sourceTokenEnvName !== undefined ? [activeCandidate.sourceTokenEnvName] : []),
          ]
        : []),
      ...roleProviderEnvNames,
      ...(manifest.spec.roles?.map(role => resolveDefaultProviderTokenEnv(role.provider, { env: process.env })) ?? []),
      'LOOPWRIGHT_GATE_SIGNING_SECRET',
      'LOOPWRIGHT_PUBLICATION_SIGNING_SECRET',
      'LOOPWRIGHT_PUBLICATION_AUTH_TOKEN',
      DEFAULT_LOCAL_COMMAND_GATE_ENV,
      ...manifestSecretEnvs,
      ...collectMcpReferencedEnvNames(effectiveMcpDecls),
    ]);
    trackedSourceTokenEnvNames = [...forbiddenCommandEnvNames];

    if (!isAutoNoChange && effectiveMcpDecls.length > 0) {
      const resolvedMcpConfigs = resolveExternalMcpConfigs({
        declarations: effectiveMcpDecls,
        runtimeEnv: process.env,
        allowLoopbackHttp: allowManifestCustomBaseUrl,
        scrubber,
      });
      if (resolvedMcpConfigs.length > 0) {
        mcpRegistry = await HostMcpRegistry.connect(resolvedMcpConfigs, {
          untrustedRoots: [repoRoot],
          trustedPathEnv: process.env['PATH'],
          scrub: text => scrubber.scrub(text),
        });
      }
    }

    const ephemeralEnv: Record<string, string> = {};
    if (activeCandidate !== undefined && activeCandidate.usesActiveTokenEnv && activeCandidate.token !== undefined) {
      ephemeralEnv[LOOPWRIGHT_ACTIVE_PROVIDER_TOKEN_ENV] = activeCandidate.token;
      scrubber.register(activeCandidate.token);
    }

    let compiled = await compileDeclarativeTaskpack(manifest, buildBindings(activeCandidate));
    const localCommandGates = compiled.localCommandGates ?? [];
    if (localCommandGates.length > 0) {
      const extractedConflictPaths = compiled.extractedConflictPaths
        ?? baselineAlignmentResult?.conflictResource?.extractedPaths;
      localGateServer = await startLocalCommandGateServer({
        runRoot: realRunRoot,
        repositoryRoot: repoRoot,
        gates: localCommandGates,
        hostPolicy,
        runtimeEnv: process.env,
        scrubber,
        forbiddenEnvNames: forbiddenCommandEnvNames,
        checkStagedDir: preflightResult?.checkStagedDir,
        ...(extractedConflictPaths !== undefined ? { extractedConflictPaths } : {}),
      });
      activeGateEndpoints = [localGateServer.endpointPlan];
      ephemeralEnv[DEFAULT_LOCAL_COMMAND_GATE_ENV] = localGateServer.signingSecret;
      compiled = await compileDeclarativeTaskpack(manifest, buildBindings(activeCandidate));
    }

    const trustedDirectory = join(realRunRoot, `lw-cli-${runId}-${process.pid}-${Date.now().toString(36)}`);
    const writtenTaskpack = await writeCompiledTaskpackDir(trustedDirectory, compiled, scrubber);
    const decisionPort = createTaskpackDecisionPort(manifest, {
      runtimeEnv: process.env,
      scrubber,
      hasPinnedRoles: (manifest.spec.roles?.length ?? 0) > 0 || (args.roleModelOverrides?.length ?? 0) > 0,
    });
    const stepMcpMetadata = mcpRegistry?.servers.map(srv => ({
      id: srv.id,
      transport: srv.transport,
      toolNames: srv.toolNames,
    }));

    const { cycleSummary, caughtSignal } = await withSignalAbort(async (signal, getSignal) => ({
      cycleSummary: await executeTurnkeyCycle({
        runId,
        attemptSeq: 0,
        repositoryRoot: repoRoot,
        taskpack: writtenTaskpack,
        runtimeEnv: process.env,
        ephemeralEnv,
        scrubber,
        ...(mcpRegistry !== undefined ? { mcpRegistry } : {}),
        ...(stepMcpMetadata !== undefined ? { mcpServers: stepMcpMetadata } : {}),
        decisions: decisionPort,
        policyProfile: 'local',
        allowWorkflowWrites: writtenTaskpack.allowWorkflowWrites,
        signal,
        memoryFinalizer: async ({ runRoot: settledRunRoot, runId: settledRunId }) =>
          await finalizeLocalTurnkeyMemory({
            runRoot: settledRunRoot,
            runId: settledRunId,
            repositoryRoot: repoRoot,
            repositoryFullName,
            manifest,
            taskpackPath: relativeTaskpackPath,
            baseRevision: resolvedRepo.baseRevision,
            policyProfile: 'local',
            upstreamRecords,
            scrubber,
          }),
      }),
      caughtSignal: getSignal(),
    }));

    const firstRole = writtenTaskpack.config.spec.task.spec.roles[0];
    const primaryModel: ReportModelInfo | null = firstRole
      ? { provider: firstRole.provider, model: firstRole.model, thinking: firstRole.thinking }
      : null;

    await emitOutcomeReports({
      args,
      runRoot: realRunRoot,
      runId: cycleSummary.attemptRunId,
      json,
      model: primaryModel,
      report: {
        status: cycleSummary.status,
        reasonCode: cycleSummary.reasonCode,
        phase: null,
        checks: cycleSummary.checks,
        usage: cycleSummary.usage,
        runEval: cycleSummary.runEval ?? null,
      },
      emitDefault: () => emit('result', cycleSummary, cycleSummary.status),
    });
    return turnkeySummaryExit(cycleSummary, caughtSignal);
  } catch (err) {
    if (err instanceof TaskpackError) {
      return await emitTaskpackError(err, emit, scrubber);
    }
    throw err;
  } finally {
    if (localGateServer !== undefined) {
      await localGateServer.close().catch(() => {});
    }
    if (mcpRegistry !== undefined) {
      await mcpRegistry.close().catch(() => {});
    }
    if (preflightResult?.stagedDir) {
      await removeStagedDirSafely(preflightResult.stagedDir);
    }
    if (preflightResult?.checkStagedDir && preflightResult.checkStagedDir !== preflightResult.stagedDir) {
      await removeStagedDirSafely(preflightResult.checkStagedDir);
    }
  }
}
export async function main(argv: readonly string[]): Promise<number> {
  if (argv.length === 1 && argv[0] === '--help') { await stdout(HELP); return 0; }
  if (argv.length === 1 && argv[0] === '--version') { await stdout(`${CLI_VERSION}\n`); return 0; }
  let sequence = 0, runId: string | null = null, json = argv.includes('--json');
  const emit = async (kind: Envelope['kind'], data: unknown, summary?: string) => { const envelope: Envelope = { version: 1, kind, sequence: ++sequence, runId, data }; if (!json && kind === 'diagnostic') { await stderr(encoded(summary ?? kind) + '\n'); return; } await stdout(json ? encoded(envelope) + '\n' : encoded(summary ?? kind) + '\n'); };
  try {
    const args = parseArguments(argv), get = (key: string) => args.values.get(key)!, output = args.values.get('output'); json = args.flags.has('json');
    if (args.command === 'init') { await initDraft(get('directory'), args.flags.has('force')); await emit('status', { runId: null, source: 'unavailable', stage: 'draft', status: 'unsupported', currentState: null, checkpoint: null, cleanup: null, unavailable: ['currentState', 'checkpoint', 'cleanup'] }, 'Draft written; execution readiness unsupported.'); return 0; }
    if (args.command === 'closure') {
      const { runIntegratedFailureMatrix } = await import('./failure-matrix.js');
      const report = await evaluateClosureMatrix({ repoRoot: resolve(args.values.has('repo') ? get('repo') : process.cwd()), verifyFailures: args.flags.has('verify-failures'), runFailureMatrix: () => runIntegratedFailureMatrix() });
      if (args.values.has('output')) await writeOutput(resolve(get('output')), Buffer.from(encoded(report) + '\n'));
      const matrix = report.failureMatrix === null ? '' : `; failure matrix ${report.failureMatrix.passed}/${report.failureMatrix.total} passed`;
      await emit('closure', report, `closure: ${report.summary.closedLocal} closed local, ${report.summary.unprovisionedExternal} unprovisioned external; integrity ${report.integrity.ok ? 'ok' : 'failed'}; ${report.falsificationDetected ? 'falsification detected' : 'no falsification'}${matrix}`);
      return closureExitCode(report, args.flags.has('verify-failures'));
    }
    if (args.command === 'app-serve') {
      let handle;
      try {
        const { startConfiguredGitHubApp } = await import('@loopwright/github-app');
        handle = await startConfiguredGitHubApp(resolve(get('config')), {
          env: process.env,
          repoRoot: args.values.has('repo') ? resolve(get('repo')) : undefined,
        });
      } catch (err) {
        if (err !== null && typeof err === 'object' && 'code' in err && typeof (err as { code: unknown }).code === 'string') {
          const code = (err as { code: string }).code;
          const rawMessage = err instanceof Error ? err.message : code;
          const message = createCliScrubber(['GITHUB_WEBHOOK_SECRET', 'GITHUB_APP_PRIVATE_KEY']).scrub(rawMessage);
          await emit('diagnostic', { version: 1, code, message }, code);
          return 2;
        }
        throw err;
      }
      await emit('status', { host: handle.host, port: handle.port, url: handle.url, webhookPath: handle.webhookPath }, `listening: ${handle.url}${handle.webhookPath}`);
      const caughtSignal = await new Promise<'SIGINT' | 'SIGTERM'>(resolveSignal => {
        const onSigint = () => { process.off('SIGINT', onSigint); process.off('SIGTERM', onSigterm); resolveSignal('SIGINT'); };
        const onSigterm = () => { process.off('SIGINT', onSigint); process.off('SIGTERM', onSigterm); resolveSignal('SIGTERM'); };
        process.on('SIGINT', onSigint);
        process.on('SIGTERM', onSigterm);
      });
      await handle.close();
      return caughtSignal === 'SIGTERM' ? 143 : 130;
    }
    if (args.command === 'status' || args.command === 'inspect') {
      runId = get('run-id'); const input = { runRoot: get('run-root'), runId };
      const observed = args.command === 'status' ? await readStatus(input) : await inspectRun({ ...input, ...(output === undefined ? {} : { output }) });
      if (!observed.ok) { await emit('diagnostic', observed.error, observed.error.code); return diagnosticExit(observed.error); }
      const status = 'manifest' in observed.value ? observed.value.status! : observed.value;
      await emit(args.command === 'status' ? 'status' : 'inspection', observed.value, 'source' in status ? status.source + ': ' + status.status : 'inspection'); return 'source' in status && status.source === 'unavailable' ? 8 : 0;
    }
    if (args.command === 'reconcile') {
      runId = get('run-id');
      const trusted = await loadTrustedConfiguration({ configPath: resolve(get('config')), registryPath: resolve(get('registry')), registrySha256: get('registry-sha256'), untrustedRoots: [resolve(get('repo'))] });
      if (!trusted.ok) { await emit('diagnostic', trusted.error, trusted.error.code); return diagnosticExit(trusted.error); }
      const reconcilePorts: ControllerPorts | undefined = args.flags.has('allow-workflow-writes')
        ? { allowWorkflowWrites: true }
        : undefined;
      const reconciled = await reconcileCycle(
        { configuration: trusted.value, runRoot: resolve(get('run-root')), runId, receipt: resolve(get('receipt')) },
        reconcilePorts,
      );
      if (!reconciled.ok) { await emit('diagnostic', reconciled.error, reconciled.error.code); return diagnosticExit(reconciled.error); }
      if (args.values.has('output')) await writeOutput(resolve(get('output')), Buffer.from(encoded(reconciled.value)));
      await emitOutcomeReports({
        args,
        runRoot: resolve(get('run-root')),
        runId,
        json,
        configuration: trusted.value,
        report: reconciled.value.kind === 'settled'
          ? { status: reconciled.value.status, reasonCode: null, phase: null, checks: [] }
          : { status: 'unresolved', reasonCode: reconciled.value.reason, phase: null, checks: [] },
        emitDefault: () => emit('result', reconciled.value, reconciled.value.kind === 'settled' ? 'reconciled: ' + reconciled.value.status : 'unresolved: ' + reconciled.value.reason),
      });
      return reconciled.value.kind === 'settled' ? reconciled.value.status === 'completed' ? 0 : reconciled.value.status === 'blocked' ? 3 : 4 : 7;
    }
    if (args.command === 'digest') {
      return await runDigestCommand(args, emit);
    }
    if (args.command === 'suite') {
      return await runSuiteCommand(args, emit);
    }
    if (args.command === 'step') {
      runId = get('run-id');
      return await runStepCommand(args, json, emit);
    }
    if (args.command === 'run' && args.values.has('taskpack')) {
      if (!args.flags.has('dry-run')) runId = get('run-id');
      return await runTaskpackCommand(args, json, emit);
    }
    const loaded = await loadTrustedConfiguration({
      configPath: resolve(get('config')),
      registryPath: resolve(get('registry')),
      registrySha256: get('registry-sha256'),
      untrustedRoots: args.values.has('repo') ? [resolve(get('repo'))] : [],
      ...(args.roleModelOverrides ? { roleModelOverrides: args.roleModelOverrides } : {}),
    });
    if (!loaded.ok) { await emit('diagnostic', loaded.error, loaded.error.code); return diagnosticExit(loaded.error); }
    if (args.command === 'check' || args.flags.has('dry-run')) {
      const compiled = await compilePlan(loaded.value); if (!compiled.ok) { await emit('diagnostic', compiled.error, compiled.error.code); return diagnosticExit(compiled.error); }
      if (output !== undefined) await writeOutput(output, Buffer.from(encoded(compiled.value) + '\n'));
      await emit('plan', compiled.value, 'Plan checked; admission not performed; execution readiness not checked.'); return 0;
    }
    const targetRunId = get('run-id');
    runId = targetRunId;
    return await withSignalAbort(async (signal, getSignal) => {
      const input = {
        configuration: loaded.value, repository: resolve(get('repo')), runRoot: resolve(get('run-root')), runId: targetRunId, signal,
        onEvent: async (event: unknown) => { if (json) await emit('event', event); else process.stderr.write('progress\n'); },
      };
      const ports: ControllerPorts | undefined = args.flags.has('allow-workflow-writes')
        ? { allowWorkflowWrites: true }
        : undefined;
      const execution = args.command === 'resume'
        ? (ports ? await resumeCycleWithPorts(input, ports) : await resumeCycle(input))
        : (ports ? await runCycleWithPorts(input, ports) : await runCycle(input));
      if (!execution.ok) { await emit('diagnostic', execution.error, execution.error.code); return diagnosticExit(execution.error); }
      await emitExecutionOutcome(args, resolve(get('run-root')), targetRunId, json, execution.value, loaded.value, emit);
      return executionExit(execution.value, getSignal());
    });
  } catch (error) {
    const code = error instanceof UsageError ? 'CLI_USAGE' : 'CLI_UNAVAILABLE';
    await emit('diagnostic', { version: 1, code }, code); return error instanceof UsageError ? 2 : 8;
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main(process.argv.slice(2)).then(code => { process.exitCode = code; }, () => { process.exitCode = 8; });
}
