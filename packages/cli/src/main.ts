#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { lstat, realpath, rm } from 'node:fs/promises';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { compilePlan, formatRunReport, inspectRun, loadTrustedConfiguration, parseReportOutputFormats, readStatus, reconcileCycle, resumeCycle, runCycle, stepCancel, stepNext, stepSubmit, type ControllerDiagnostic, type CycleExecution, type InspectRunValue, type LoadedConfiguration, type ReportCheckItem, type ReportModelInfo, type ReportOutputFormat, type RunReportInput, type StepTickResult } from '@loopwright/controller';
import { GitHubAppError, openStagedTaskpackStepGate, SecretScrubber, stageTaskpackForStep, startConfiguredGitHubApp, type GitHubAppErrorCode, type StagedTaskpackStepGateHandle } from '@loopwright/github-app';
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
const HELP = `loopwright ${CLI_VERSION}\ninit --directory DIR [--force] [--json]\ncheck --config FILE --registry FILE --registry-sha256 HEX [--role-model ROLE=PROVIDER/MODEL[:THINKING]] [--json] [--output FILE]\nrun --dry-run --config FILE --registry FILE --registry-sha256 HEX [--role-model ROLE=PROVIDER/MODEL[:THINKING]] [--json] [--output FILE]\nrun --config FILE --registry FILE --registry-sha256 HEX --repo DIR --run-root DIR --run-id ID [--role-model ROLE=PROVIDER/MODEL[:THINKING]] [--json] [--output-format FORMATS] [--step-summary-file FILE]\nresume --run-root DIR --run-id ID --config FILE --registry FILE --registry-sha256 HEX --repo DIR [--role-model ROLE=PROVIDER/MODEL[:THINKING]] [--json] [--output-format FORMATS] [--step-summary-file FILE]\nstep next --run-root DIR --run-id ID (--taskpack FILE --repo DIR | --config FILE --registry FILE --registry-sha256 HEX --repo DIR | [--repo DIR]) [--role-model ROLE=PROVIDER/MODEL[:THINKING]] [--mode candidate|no-change] [--reissue-lease] [--json] [--output-format FORMATS] [--step-summary-file FILE]\nstep submit --run-root DIR --run-id ID --lease TOKEN [--submission-file FILE] [--status completed|no_change|failed|blocked] [--reason TEXT] [--json] [--output-format FORMATS] [--step-summary-file FILE]\nstep cancel --run-root DIR --run-id ID [--json] [--output-format FORMATS] [--step-summary-file FILE]\nreconcile --config FILE --registry FILE --registry-sha256 HEX --repo DIR --run-root DIR --run-id ID --receipt FILE [--json] [--output FILE] [--output-format FORMATS] [--step-summary-file FILE]\nstatus --run-root DIR --run-id ID [--json]\ninspect --run-root DIR --run-id ID [--json] [--output DIR]\nclosure [--repo DIR] [--output FILE] [--json] [--verify-failures]\napp-serve --config FILE [--repo DIR] [--json]\nConfig and registry files accept YAML (.yaml, .yml) or JSON (.json); init writes controller.draft.yaml and registry.draft.yaml.\nStatic plans do not establish execution readiness. Strict proven_bound is the default.\nJSON verification requires both complete manifests and framing to fit the 16384-byte header; selected file <=1032184 bytes.\n`;
export interface Envelope { readonly version: 1; readonly kind: 'plan' | 'event' | 'status' | 'inspection' | 'result' | 'diagnostic' | 'incident' | 'closure' | 'step'; readonly sequence: number; readonly runId: string | null; readonly data: unknown }
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
  readonly report: Omit<RunReportInput, 'runId' | 'model' | 'usage' | 'externalUrl'> & { readonly usage?: RunReportInput['usage'] };
  readonly emitDefault: () => Promise<void>;
}
async function emitOutcomeReports(input: EmitOutcomeReportInput): Promise<void> {
  const { args, runRoot, runId, json, configuration, report, emitDefault } = input;
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
    model: configuration ? primaryModelInfo(configuration) : null,
    usage: report.usage ?? inspected?.usage ?? null,
    externalUrl: inspected?.externalUrl ?? null,
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
/** Map every GitHubAppErrorCode exhaustively to its documented CLI exit code. */
export function gitHubAppExitCode(code: GitHubAppErrorCode): number {
  switch (code) {
    case 'TASKPACK_MANIFEST_INVALID':
    case 'TASKPACK_UNTRUSTED_INTERPOLATION':
    case 'TASKPACK_SCOPE_VIOLATION':
    case 'TASKPACK_HOST_BINDING_INVALID':
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
async function runStepCommand(args: Arguments, json: boolean, emit: EmitFn): Promise<number> {
  const get = (key: string) => args.values.get(key)!;
  const runId = get('run-id');
  const runRoot = resolve(get('run-root'));
  let gateHandle: StagedTaskpackStepGateHandle | null = null;
  let stagedDirToCleanOnUnadmittedFailure: string | null = null;
  try {
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
              await rm(stageCandidate, { recursive: true, force: true }).catch(() => {});
            }
          }
        }
        const staged = await stageTaskpackForStep({
          taskpackPath: get('taskpack'),
          repositoryRoot: requestedRepo,
          runRoot,
          runId,
          mode: (args.values.get('mode') as 'candidate' | 'no-change' | undefined) ?? 'candidate',
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
        : await openStagedTaskpackStepGate({ runRoot, runId });
      const gateEnvOpt = gateHandle ? { environment: gateHandle.environment } : {};
      const gatePorts = gateHandle ? { gateUrlOverrides: gateHandle.gateUrlOverrides } : {};

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
      if (err instanceof GitHubAppError) {
        const scrubber = createCliScrubber();
        const message = scrubber.scrub(err.message);
        const path = typeof err.path === 'string' && err.path.length > 0 ? scrubber.scrub(err.path) : null;
        await emit(
          'diagnostic',
          { version: 1, code: err.code, message, ...(path !== null ? { path } : {}) },
          err.code,
        );
        return gitHubAppExitCode(err.code);
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
        await rm(stagedDirToCleanOnUnadmittedFailure, { recursive: true, force: true }).catch(() => {});
      }
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
      const reconciled = await reconcileCycle({ configuration: trusted.value, runRoot: resolve(get('run-root')), runId, receipt: resolve(get('receipt')) });
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
    if (args.command === 'step') {
      runId = get('run-id');
      return await runStepCommand(args, json, emit);
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
      const execution = args.command === 'resume' ? await resumeCycle(input) : await runCycle(input);
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
