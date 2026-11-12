#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { compilePlan, loadTrustedConfiguration, runCycle, resumeCycle, reconcileCycle, readStatus, inspectRun, type ControllerDiagnostic, type CycleExecution } from '@loopwright/controller';
import { startConfiguredGitHubApp } from '@loopwright/github-app';
import { parseArguments, UsageError } from './arguments.js';
import { initDraft, writeOutput } from './draft.js';
import { evaluateClosureMatrix, CLOSURE_FALSIFICATION_FORBIDDEN, type ClosureMatrixReport } from './closure.js';
function resolveCliVersion(): string {
  try {
    const raw = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version?: unknown };
    if (typeof raw.version === 'string' && raw.version.length > 0) return raw.version;
  } catch { /* fallback */ }
  return '0.0.0';
}
const CLI_VERSION = resolveCliVersion();
const HELP = `loopwright ${CLI_VERSION}\ninit --directory DIR [--force] [--json]\ncheck --config FILE --registry FILE --registry-sha256 HEX [--json] [--output FILE]\nrun --dry-run --config FILE --registry FILE --registry-sha256 HEX [--json] [--output FILE]\nrun --config FILE --registry FILE --registry-sha256 HEX --repo DIR --run-root DIR --run-id ID [--json]\nresume --run-root DIR --run-id ID --config FILE --registry FILE --registry-sha256 HEX --repo DIR [--json]\nreconcile --config FILE --registry FILE --registry-sha256 HEX --repo DIR --run-root DIR --run-id ID --receipt FILE [--json] [--output FILE]\nstatus --run-root DIR --run-id ID [--json]\ninspect --run-root DIR --run-id ID [--json] [--output DIR]\nclosure [--repo DIR] [--output FILE] [--json] [--verify-failures]\napp-serve --config FILE [--repo DIR] [--json]\nConfig and registry files accept YAML (.yaml, .yml) or JSON (.json); init writes controller.draft.yaml and registry.draft.yaml.\nStatic plans do not establish execution readiness. Strict proven_bound is the default.\nJSON verification requires both complete manifests and framing to fit the 16384-byte header; selected file <=1032184 bytes.\n`;
export interface Envelope { readonly version: 1; readonly kind: 'plan' | 'event' | 'status' | 'inspection' | 'result' | 'diagnostic' | 'incident' | 'closure'; readonly sequence: number; readonly runId: string | null; readonly data: unknown }
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
          const message = err instanceof Error ? err.message : code;
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
      await emit('result', reconciled.value, reconciled.value.kind === 'settled' ? 'reconciled: ' + reconciled.value.status : 'unresolved: ' + reconciled.value.reason);
      return reconciled.value.kind === 'settled' ? reconciled.value.status === 'completed' ? 0 : reconciled.value.status === 'blocked' ? 3 : 4 : 7;
    }
    const loaded = await loadTrustedConfiguration({ configPath: resolve(get('config')), registryPath: resolve(get('registry')), registrySha256: get('registry-sha256'), untrustedRoots: args.values.has('repo') ? [resolve(get('repo'))] : [] });
    if (!loaded.ok) { await emit('diagnostic', loaded.error, loaded.error.code); return diagnosticExit(loaded.error); }
    if (args.command === 'check' || args.flags.has('dry-run')) {
      const compiled = await compilePlan(loaded.value); if (!compiled.ok) { await emit('diagnostic', compiled.error, compiled.error.code); return diagnosticExit(compiled.error); }
      if (output !== undefined) await writeOutput(output, Buffer.from(encoded(compiled.value) + '\n'));
      await emit('plan', compiled.value, 'Plan checked; admission not performed; execution readiness not checked.'); return 0;
    }
    runId = get('run-id'); const abort = new AbortController(); let caughtSignal: string | null = null;
    const interrupt = () => { caughtSignal ??= 'SIGINT'; abort.abort(); }, terminate = () => { caughtSignal ??= 'SIGTERM'; abort.abort(); };
    process.on('SIGINT', interrupt); process.on('SIGTERM', terminate);
    try {
      const input = { configuration: loaded.value, repository: resolve(get('repo')), runRoot: resolve(get('run-root')), runId, signal: abort.signal,
        onEvent: async (event: unknown) => { if (json) await emit('event', event); else process.stderr.write('progress\n'); } };
      const execution = args.command === 'resume' ? await resumeCycle(input) : await runCycle(input);
      if (!execution.ok) { await emit('diagnostic', execution.error, execution.error.code); return diagnosticExit(execution.error); }
      if (execution.value.kind === 'incident') await emit('incident', execution.value.incident, execution.value.incident.code);
      else await emit('result', execution.value, execution.value.result.spec.status);
      return executionExit(execution.value, caughtSignal);
    } finally { process.off('SIGINT', interrupt); process.off('SIGTERM', terminate); }
  } catch (error) {
    const code = error instanceof UsageError ? 'CLI_USAGE' : 'CLI_UNAVAILABLE';
    await emit('diagnostic', { version: 1, code }, code); return error instanceof UsageError ? 2 : 8;
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main(process.argv.slice(2)).then(code => { process.exitCode = code; }, () => { process.exitCode = 8; });
}
