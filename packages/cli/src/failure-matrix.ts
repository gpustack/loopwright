import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmod, lstat, mkdir, mkdtemp, readdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { promisify } from 'node:util';
import { admitTask, bindSubject, constructRunResult, digestArtifact, evaluateAcceptance, isWritablePath, validateDocument, type TaskContract, type TaskLock } from '@loopwright/core';
import { createLocalRun } from '@loopwright/state';
import type { LocalRunIdentity, RequestAdmission } from '@loopwright/state';
import type { CycleExecution, LoadedConfiguration } from '@loopwright/controller';
import { loadTrustedConfiguration, readStatus, reconcileCycle, signPayload, verifySignedPayload } from '@loopwright/controller';
import { describePiAdapterFiles, decodePiCapture, type PiCaptureDecodeInput } from '@loopwright/agent-pi';
import { DecisionBudgetTracker, DecisionError, DEFAULT_DECISION_POLICY, assertDecisionAuthorityBoundary, evaluateDecision, sanitizeDecisionState } from '@loopwright/decisions';
import type { DecisionPolicyConfig } from '@loopwright/decisions';
import { buildCompactionSummary, evaluateCompactionPolicy, restoreFromCompactionLedger, selectActiveMemory, storeDigestOf } from '@loopwright/memory';
import type { CompactionLedgerState, MemoryEntry, MemoryStoreIndex } from '@loopwright/memory';
import { compileLinuxBwrapCommand, compileMacosSeatbeltProfile, GitHubAppError, loadDeclarativeTaskpack, negotiateSandboxBackend, validateMcpAuthConfiguration, validateTaskpackManifest } from '@loopwright/github-app';
import { computeRunnerCandidateDigest, defaultCorpusRoot, startRunnerTaskpackService } from '@loopwright/taskpack-runner';
import { diagnosticExit, executionExit } from './main.js';
import type { IntegratedFailureMatrixReport, IntegratedFailureScenarioId, IntegratedFailureScenarioResult } from './closure.js';
export type { IntegratedFailureMatrixReport, IntegratedFailureScenarioId, IntegratedFailureScenarioResult };
export const INTEGRATED_FAILURE_SCENARIO_IDS: readonly IntegratedFailureScenarioId[] = Object.freeze([
  'malformed_or_conflicting_json_submission', 'forged_test_pass_without_verifier_evidence',
  'missing_provider_usage_retained_reservation', 'nested_tool_double_debit_prevention',
  'provider_and_decision_deadline_timeout', 'concurrent_owner_and_budget_exhaustion',
  'signal_interruption_and_workspace_loss', 'unknown_external_effect_reconcile_gate',
  'expired_or_stale_gate_token_rejection', 'mutated_pr_head_publication_abort',
  'stale_memory_source_exclusion', 'compaction_pending_operation_preservation',
  'untrusted_taskpack_and_oauth_boundary_refusal', 'decision_authority_escalation_refusal',
]);
export interface IntegratedFailureMatrixOptions {
  /** Injected fault overrides let negative tests force a single failing scenario. */
  readonly scenarioOverrides?: Partial<Record<IntegratedFailureScenarioId, () => IntegratedFailureScenarioResult | Promise<IntegratedFailureScenarioResult>>>;
}
type Probe = { readonly id: IntegratedFailureScenarioId; readonly run: () => Promise<IntegratedFailureScenarioResult> };
const GIT_ENV = { HOME: '/nonexistent', PATH: '/usr/bin:/bin', LANG: 'C', LC_ALL: 'C', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_TERMINAL_PROMPT: '0' };
const hexOf = (seed: string) => ({ algorithm: 'sha256' as const, hex: createHash('sha256').update(seed).digest('hex') });
function unwrap<T>(result: { readonly ok: true; readonly value: T } | { readonly ok: false; readonly errors: readonly { readonly code: string }[] } | { readonly ok: false; readonly error: { readonly code: string } }): T {
  if (result.ok) return result.value;
  throw new Error('errors' in result ? result.errors[0]?.code ?? 'REFUSED' : result.error.code);
}
function codeOf(error: unknown): string {
  if (error instanceof DecisionError || error instanceof GitHubAppError) return error.code;
  if (error instanceof Error && 'code' in error && typeof (error as { code: unknown }).code === 'string') return (error as { code: string }).code;
  return error instanceof Error ? error.name : 'SCENARIO_FAULT';
}
async function probe(id: IntegratedFailureScenarioId, run: () => Promise<IntegratedFailureScenarioResult>): Promise<IntegratedFailureScenarioResult> {
  const started = performance.now();
  try { return await run(); }
  catch (error) { return { scenarioId: id, passed: false, diagnosticCode: codeOf(error), assertions: [], elapsedMs: Math.round(performance.now() - started) }; }
}
function outcome(id: IntegratedFailureScenarioId, started: number, assertions: readonly string[], failures: readonly string[], diagnosticCode: string | null): IntegratedFailureScenarioResult {
  const recorded = [...assertions, ...failures.map(failure => `FAILED: ${failure}`)];
  return { scenarioId: id, passed: failures.length === 0, diagnosticCode: failures.length === 0 ? diagnosticCode : diagnosticCode ?? 'ASSERTION_FAILED', assertions: recorded, elapsedMs: Math.round(performance.now() - started) };
}
type Recorder = { readonly assert: (condition: boolean, claim: string) => boolean; readonly expect: (observed: string, expected: string, claim: string) => boolean; readonly claims: () => readonly string[]; readonly failed: () => readonly string[] };
function recorder(): Recorder {
  const claims: string[] = [], failed: string[] = [];
  return {
    assert: (condition, claim) => { (condition ? claims : failed).push(condition ? claim : `${claim} [condition false]`); return condition; },
    expect: (observed, expected, claim) => { (observed === expected ? claims : failed).push(observed === expected ? claim : `${claim} [observed=${observed} expected=${expected}]`); return observed === expected; },
    claims: () => claims, failed: () => failed,
  };
}
function contractFixture(totalTokens = 1000): Record<string, unknown> {
  return {
    apiVersion: 'loopwright.dev/v1alpha1', kind: 'TaskContract',
    spec: {
      goal: 'Update the pinned package', taskpack: 'package-update',
      target: { repository: 'team/repository', baseRevision: 'base-1', sourceRevision: 'source-1', matrix: null },
      scope: { writable: ['packages/**'], protected: ['packages/policy/**'] },
      roles: [{ id: 'builder', adapter: 'pi', provider: 'github-copilot', model: 'exact-model', thinking: 'high', tools: ['read'] }],
      trustedContext: { revision: 'context-1', discovery: 'disabled', resources: [] },
      budgets: { wallTimeMs: 60000, totalTokens, perCallOutputTokens: 100, maxModelCalls: 10, maxConcurrency: 2, maxFormatRepairs: 0, maxImplementationRepairs: 2, maxTransportRetries: 1,
        enforcement: { wallTime: 'hard_admission', tokens: 'soft_accounting', modelCalls: 'hard_admission', concurrency: 'hard_admission', formatRepairs: 'hard_admission', implementationRepairs: 'hard_admission', transportRetries: 'hard_admission' } },
      steps: [{ id: 'build', kind: 'agent', uses: 'package.patch', roleId: 'builder', dependsOn: [] }],
      acceptance: { required: ['tests'], checks: [{ id: 'tests', allowedEvidenceLevels: ['local_execution'] }] },
    },
  };
}
function stateIdentity(directory: string, lock: TaskLock): LocalRunIdentity {
  return { directory, storeId: 'store-1', lock, policy: { version: 1, leaseMs: 10000, cost: 'observe_only' },
    binding: { coreApiVersion: 'loopwright.dev/v1alpha1', hostVersion: 'closure-matrix', adapters: [{ id: 'pi', version: '1.5.0' }], resourceVersion: 'fixture-host', clockEpoch: 'fixture-boot' } };
}
function requestFixture(requestId = 'request-1', patch: Partial<RequestAdmission> = {}): RequestAdmission {
  return { requestId, roleId: 'builder', nodeId: 'build', attemptId: `attempt-${requestId}`, purpose: 'task', repair: 'none', transportRetryOf: null,
    requestDigest: hexOf('request'), inputUpperBound: 80, outputUpperBound: 20, totalUpperBound: 100,
    capability: { adapterId: 'pi', adapterVersion: '1.5.0', provider: 'github-copilot', model: 'exact-model', kind: 'hard_bound', coversAllBillableTokens: true, enforcesOutputBound: true },
    operationId: `op-${requestId}`, targetIdentity: 'provider/request', ...patch };
}
async function scratchDirectory(prefix: string): Promise<string> { return realpath(await mkdtemp(join(await realpath(tmpdir()), prefix))); }
async function scenarioOne(): Promise<IntegratedFailureScenarioResult> {
  const id = 'malformed_or_conflicting_json_submission', started = performance.now(), r = recorder();
  const duplicateCore = validateDocument('{"metadata":{"id":"x"},"metadata":{"id":"y"}}', 'TaskContract');
  r.expect(duplicateCore.ok ? '' : duplicateCore.errors[0]!.code, 'JSON_DUPLICATE_MEMBER', 'core refuses duplicate JSON members with JSON_DUPLICATE_MEMBER');
  const brokenCore = validateDocument('{"metadata":', 'TaskContract');
  r.expect(brokenCore.ok ? '' : brokenCore.errors[0]!.code, 'JSON_SYNTAX', 'core refuses truncated JSON with JSON_SYNTAX');
  const root = await scratchDirectory('lw-fm-json-');
  const registry = { apiVersion: 'loopwright.dev/v1alpha1', kind: 'TrustedRegistry', metadata: { name: 'operator' }, spec: { version: 1, resourceVersion: 'context-draft', handlers: [], roleProfiles: [], runtimeProfiles: [], resources: [], credentialBindings: [], environmentBindings: [] } };
  const registryBytes = Buffer.from(JSON.stringify(registry));
  const operator = join(root, 'operator'), task = join(root, 'task');
  await mkdir(operator, { mode: 0o700 }); await mkdir(task, { mode: 0o700 });
  try {
    const duplicatedRegistry = JSON.stringify(registry).replace('"spec":{', '"spec":{"version":1,');
    const duplicatedBytes = Buffer.from(duplicatedRegistry);
    await writeFile(join(operator, 'duplicated-registry.json'), duplicatedBytes, { mode: 0o600 });
    await writeFile(join(task, 'config.json'), '{"apiVersion":"loopwright.dev/v1alpha1"}', { mode: 0o600 });
    const duplicateLoaded = await loadTrustedConfiguration({ configPath: join(task, 'config.json'), registryPath: join(operator, 'duplicated-registry.json'), registrySha256: createHash('sha256').update(duplicatedBytes).digest('hex'), untrustedRoots: [task] });
    r.expect(duplicateLoaded.ok ? '' : duplicateLoaded.error.code, 'CONFIG_DUPLICATE_KEY', 'controller refuses duplicate-key JSON with CONFIG_DUPLICATE_KEY');
    await writeFile(join(operator, 'registry.json'), registryBytes, { mode: 0o600 });
    await writeFile(join(task, 'config.json'), 'definitely not json {', { mode: 0o600 });
    const syntaxLoaded = await loadTrustedConfiguration({ configPath: join(task, 'config.json'), registryPath: join(operator, 'registry.json'), registrySha256: createHash('sha256').update(registryBytes).digest('hex'), untrustedRoots: [task] });
    r.expect(syntaxLoaded.ok ? '' : syntaxLoaded.error.code, 'CONFIG_SYNTAX', 'controller refuses non-JSON configuration with CONFIG_SYNTAX');
  } finally { await rm(root, { recursive: true, force: true }); }
  return outcome(id, started, r.claims(), r.failed(), 'JSON_DUPLICATE_MEMBER');
}
function acceptanceInputs(observedStatus: 'passed' | 'failed') {
  const lock = unwrap(admitTask(contractFixture() as unknown as TaskContract, { admissionId: 'admission-1', runId: 'run-1' }));
  const candidateBytes = Buffer.from('candidate patch\n'), logBytes = Buffer.from('test output: pass\n');
  const candidateManifest = { apiVersion: 'loopwright.dev/v1alpha1', kind: 'ArtifactManifest', metadata: { id: 'candidate' }, spec: { entries: [unwrap(digestArtifact('candidate.patch', candidateBytes))] } };
  const subject = unwrap(bindSubject(lock, candidateManifest));
  const evidence = { apiVersion: 'loopwright.dev/v1alpha1', kind: 'Evidence', metadata: { id: 'observation-1' }, spec: { checkId: 'tests', observedStatus, producerId: 'host-verifier', method: 'node-test', level: 'local_execution', subject: structuredClone(subject), artifacts: [unwrap(digestArtifact('test.log', logBytes))], reason: observedStatus === 'failed' ? 'trusted command failed' : null } };
  const artifacts = [{ name: 'candidate.patch', bytes: candidateBytes }, { name: 'test.log', bytes: logBytes }];
  return { lock, candidateManifest, evidence, artifacts };
}
async function scenarioTwo(): Promise<IntegratedFailureScenarioResult> {
  const id = 'forged_test_pass_without_verifier_evidence', started = performance.now(), r = recorder();
  const forged = acceptanceInputs('failed');
  const claims = [{ checkId: 'tests', status: 'passed', evidenceId: 'observation-1' as string | null, reason: null }];
  const evaluated = evaluateAcceptance({ trusted: { expectedLock: forged.lock, candidateManifest: forged.candidateManifest, eligibleEvidence: [forged.evidence] }, claims }, forged.artifacts);
  r.expect(evaluated.ok ? '' : evaluated.errors[0]!.code, 'EVIDENCE_CONTRADICTORY', 'acceptance refuses a claimed pass over failed verifier evidence with EVIDENCE_CONTRADICTORY');
  const missing = acceptanceInputs('passed');
  const missingEvaluated = evaluateAcceptance({ trusted: { expectedLock: missing.lock, candidateManifest: missing.candidateManifest, eligibleEvidence: [] }, claims: [{ checkId: 'tests', status: 'passed', evidenceId: null, reason: null }] }, missing.artifacts);
  r.expect(missingEvaluated.ok ? 'passed' : '', 'passed', 'acceptance still evaluates; the missing-evidence check resolves blocked below');
  if (missingEvaluated.ok) r.expect(missingEvaluated.value.spec.diagnostics[0]?.code ?? '', 'EVIDENCE_MISSING', 'a claimed pass without evidence stays blocked with EVIDENCE_MISSING');
  const constructed = constructRunResult({ trusted: { expectedLock: forged.lock, candidateManifest: forged.candidateManifest, eligibleEvidence: [forged.evidence], usage: [], externalEffects: 'none', noChange: null }, candidate: { status: 'completed', checks: claims, memory: { status: 'not_requested', reason: null } } }, forged.artifacts);
  r.expect(constructed.ok ? '' : constructed.errors[0]!.code, 'EVIDENCE_CONTRADICTORY', 'run-result construction refuses a forged completed status');
  const unproven = constructRunResult({ trusted: { expectedLock: forged.lock, candidateManifest: forged.candidateManifest, eligibleEvidence: [], usage: [], externalEffects: 'none', noChange: null }, candidate: { status: 'completed', checks: [], memory: { status: 'not_requested', reason: null } } }, forged.artifacts);
  r.expect(unproven.ok ? '' : unproven.errors[0]!.code, 'RUN_ACCEPTANCE_REQUIRED', 'completed without satisfied acceptance refuses with RUN_ACCEPTANCE_REQUIRED');
  return outcome(id, started, r.claims(), r.failed(), 'EVIDENCE_CONTRADICTORY');
}
async function stateFixture(totalTokens: number) {
  const root = await scratchDirectory('lw-fm-state-');
  const lock = unwrap(admitTask(contractFixture(totalTokens) as unknown as TaskContract, { admissionId: 'admission-1', runId: 'run-1' }));
  const store = unwrap(createLocalRun(stateIdentity(join(root, 'store'), lock)));
  const owner = unwrap(store.claim({ ownerId: 'owner-a', expectedGeneration: 0, expectedRevision: 0, mode: 'active' }));
  return { root, store, owner };
}
async function scenarioThree(): Promise<IntegratedFailureScenarioResult> {
  const id = 'missing_provider_usage_retained_reservation', started = performance.now(), r = recorder();
  const tracker = new DecisionBudgetTracker({ maxInputTokens: 1000 });
  tracker.reserve(500);
  tracker.retainUnknown(500);
  r.expect(String(tracker.snapshot().unknownUsageRetained), 'true', 'decision budget retains unknown provider usage');
  const state = await stateFixture(1000);
  try {
    const reserved = unwrap(state.store.reserveRequest(state.owner.authority, requestFixture()));
    r.expect(reserved.kind, 'created', 'state reserves the provider request');
    unwrap(state.store.authorizeRequestDispatch(state.owner.authority, 'request-1'));
    unwrap(state.store.markRequestUnresolved(state.owner.authority, 'request-1', 'timeout'));
    const record = unwrap(state.store.getRequest('request-1'));
    r.expect(String(record.state), 'unresolved', 'the lost request parks unresolved');
    r.expect(String(record.unresolvedReason), 'timeout', 'the unresolved reason is timeout');
    const view = unwrap(state.store.inspect());
    r.expect(String(view.ledger.chargedTokens.decimal), '100', 'the reservation stays charged with no refund');
  } finally { state.store.close(); await rm(state.root, { recursive: true, force: true }); }
  return outcome(id, started, r.claims(), r.failed(), 'COMMIT_UNKNOWN');
}
async function scenarioFour(): Promise<IntegratedFailureScenarioResult> {
  const id = 'nested_tool_double_debit_prevention', started = performance.now(), r = recorder();
  const contract = contractFixture();
  const denied = isWritablePath(contract, 'packages/policy/secret.json');
  r.expect(String(denied.ok && denied.value), 'false', 'a protected-path tool write is blocked before execution');
  const allowed = isWritablePath(contract, 'packages/readme.md');
  r.expect(String(allowed.ok && allowed.value), 'true', 'a writable-path tool write stays admitted');
  const state = await stateFixture(1000);
  try {
    unwrap(state.store.reserveRequest(state.owner.authority, requestFixture()));
    const first = unwrap(state.store.authorizeRequestDispatch(state.owner.authority, 'request-1'));
    r.expect(String(first.kind), 'new_dispatch', 'the first dispatch authorizes one permit');
    const firstPermit = first.kind === 'new_dispatch' ? first.permit : null;
    const second = unwrap(state.store.authorizeRequestDispatch(state.owner.authority, 'request-1'));
    r.expect(String(second.kind), 'existing', 'a repeated dispatch re-issues the existing permit');
    r.expect(String(second.kind === 'existing' ? second.record.dispatch?.dispatchId : ''), String(firstPermit?.dispatchId ?? ''), 'no second generation is minted, so the parent reservation never double-debits');
    const view = unwrap(state.store.inspect());
    r.expect(String(view.ledger.chargedTokens.decimal), '100', 'the ledger charges the single attempt exactly once');
    // @loopwright/agent-pi: the frozen adapter inventory resolves, and a capture bound to a foreign
    // resource identity is refused deterministically before any execution, without Docker or network.
    const described = await describePiAdapterFiles();
    r.expect(String(described.ok), 'true', 'the frozen Pi adapter file inventory resolves');
    if (described.ok) r.assert(described.value.sdkIntegrity.length > 0 && described.value.restrictionDigest.hex.length === 64 && described.value.localMcpScriptDigest.hex.length === 64, 'the frozen adapter inventory carries sdk integrity and script digests');
    const piContract = contractFixture() as { spec: Record<string, unknown> };
    piContract.spec = { ...piContract.spec, roles: [{ id: 'builder', adapter: 'pi', provider: 'github-copilot', model: 'claude-sonnet-5.5', thinking: 'xhigh', tools: ['read'] }] };
    const piLock = unwrap(admitTask(piContract as unknown as TaskContract, { admissionId: 'admission-pi', runId: 'run-pi' }));
    const workspaceBytes = Buffer.from('workspace snapshot');
    const sessionBytes = Buffer.from('session snapshot');
    const workspaceRef = unwrap(digestArtifact('workspace.bin', workspaceBytes));
    const sessionRef = unwrap(digestArtifact('session.bin', sessionBytes));
    const policy = {
      version: 1, policyId: 'closure-matrix-policy', resourceVersion: 'fixture-host', adapterId: 'pi', adapterVersion: '0.0.0',
      runtime: { sdkIntegrity: described.ok ? described.value.sdkIntegrity : '', graphDigest: hexOf('graph'), imageDigest: 'sha256:' + 'a'.repeat(64), configDigest: described.ok ? described.value.restrictionDigest : hexOf('config'), profile: 'linux/arm64' },
      selection: { provider: 'github-copilot', model: 'claude-sonnet-5.5', thinking: 'xhigh', api: 'anthropic-messages' },
      resources: [], tools: ['read'],
      mcp: { serverId: 'workspace', scriptDigest: described.ok ? described.value.localMcpScriptDigest : hexOf('mcp'), names: [], effects: [], idleTimeoutSeconds: 1, absoluteTimeoutSeconds: 2 },
      context: { mode: 'estimated_guard', estimator: 'lw-pi-final-json-bytes-v1', proofId: null, version: 1, evidence: 'estimated', workingWindowCeiling: 98304, maxRequestBytes: 65536, serviceMargin: 32768, toolReserve: 16384, maxOutputTokens: 1024 },
      accounting: 'soft_only', retry: 'sender_only', extensions: [], privateArtifacts: true,
      limits: Object.freeze({ promptBytes: 16384, diagnosticBytes: 1024, responseBytes: 1048576, frameBytes: 65536, eventBytes: 4096, pendingResponseBytes: 262144, eventQueue: 128, eventQueueBytes: 524288, toolArgsBytes: 65536, toolResultBytes: 65536, sessionBytes: 8388608, artifactBytes: 16777216, candidateEntries: 256, fileBytes: 8388608, toolWallMs: 10000, requests: 1024, operations: 2048, checkpoints: 64 }),
    };
    const checkpoint = { formatVersion: 1, runId: piLock.spec.runId, lockHash: piLock.spec.lockHash, checkpointId: 'checkpoint-pi', storeId: 'store-1', binding: { resourceVersion: 'foreign-host' }, privateSession: sessionRef, subject: {}, clockBasis: {}, ledger: {}, counts: {} };
    const decoded = await decodePiCapture({ version: 1, lock: piLock, policy, checkpoint, sessionId: 'session-pi', roleId: 'builder', stepId: 'build',
      workspace: { ref: workspaceRef, bytes: workspaceBytes }, session: { ref: sessionRef, bytes: sessionBytes }, command: null } as unknown as PiCaptureDecodeInput);
    r.expect(String(decoded.ok ? '' : decoded.error.code), 'BINDING_MISMATCH', 'a capture bound to a foreign resource identity is refused before execution');
  } finally { state.store.close(); await rm(state.root, { recursive: true, force: true }); }
  return outcome(id, started, r.claims(), r.failed(), 'TOOL_DENIED');
}
const decisionPolicy = (): DecisionPolicyConfig => ({ ...DEFAULT_DECISION_POLICY, enabled: true, disclosurePolicy: 'repo-approved-redacted-evidence', hardDeadlineMs: 100, maxAttempts: 1 });
const hangingTransport = { async send(): Promise<never> { return new Promise<never>(() => { /* hang until the deadline aborts us. */ }); } };
async function scenarioFive(): Promise<IntegratedFailureScenarioResult> {
  const id = 'provider_and_decision_deadline_timeout', started = performance.now(), r = recorder();
  // The decision client unrefs its deadline timer so idle CLIs can exit; hold the loop open while the race runs.
  const keepAlive = setInterval(() => { /* keep the deadline race alive. */ }, 25);
  try {
    const budget = new DecisionBudgetTracker({ maxInputTokens: 1000 });
    const fallbacks: string[] = [];
    const result = await evaluateDecision({ policy: decisionPolicy(), state: { question: 'ship' }, budget, questions: [{ type: 'noul', id: 'q1', prompt: 'Proceed?' }],
      apiKey: 'fixture-decision-key', transport: hangingTransport, fallback: context => { fallbacks.push(context.fallbackReason); return 'deterministic-default'; } });
    r.expect(String(result.fallbackReason), 'deadline_exceeded', 'a hanging provider transport routes to the deterministic fallback');
    r.expect(String(result.transportCalls), '1', 'exactly one transport call was attempted');
    r.expect(String(budget.snapshot().unknownUsageRetained), 'true', 'the deadline retains unknown usage in the budget ledger');
    r.expect(fallbacks.join(','), 'deadline_exceeded', 'the fallback handler receives the deadline reason');
    let thrown: string | null = null;
    try { await evaluateDecision({ policy: decisionPolicy(), state: {}, budget: new DecisionBudgetTracker({}), questions: [{ type: 'noul', id: 'q2', prompt: 'Proceed?' }], apiKey: 'fixture-decision-key', transport: hangingTransport }); }
    catch (error) { thrown = error instanceof DecisionError ? error.code : 'WRONG_ERROR'; }
    r.expect(thrown ?? '', 'DECISION_DEADLINE_EXCEEDED', 'without a fallback the deadline surfaces DECISION_DEADLINE_EXCEEDED');
  } finally { clearInterval(keepAlive); }
  return outcome(id, started, r.claims(), r.failed(), 'DECISION_DEADLINE_EXCEEDED');
}
async function scenarioSix(): Promise<IntegratedFailureScenarioResult> {
  const id = 'concurrent_owner_and_budget_exhaustion', started = performance.now(), r = recorder();
  const state = await stateFixture(150);
  try {
    const secondOwner = state.store.claim({ ownerId: 'owner-b', expectedGeneration: 1, expectedRevision: 1, mode: 'active' });
    r.expect(String(secondOwner.ok ? '' : secondOwner.error.code), 'OWNER_HELD', 'a concurrent owner takeover refuses with OWNER_HELD');
    unwrap(state.store.reserveRequest(state.owner.authority, requestFixture('request-1')));
    const overBudget = state.store.reserveRequest(state.owner.authority, requestFixture('request-2', { inputUpperBound: 95, outputUpperBound: 70, totalUpperBound: 165 }));
    r.expect(String(overBudget.ok ? '' : overBudget.error.code), 'BUDGET_EXHAUSTED', 'exhausting the token budget refuses with BUDGET_EXHAUSTED');
    const after = unwrap(state.store.inspect());
    r.expect(String(after.ledger.chargedTokens.decimal), '100', 'the refused request leaves the ledger untouched');
  } finally { state.store.close(); await rm(state.root, { recursive: true, force: true }); }
  return outcome(id, started, r.claims(), r.failed(), 'OWNER_HELD');
}
async function scenarioSeven(): Promise<IntegratedFailureScenarioResult> {
  const id = 'signal_interruption_and_workspace_loss', started = performance.now(), r = recorder();
  const cancelled: CycleExecution = { kind: 'result', result: { spec: { status: 'cancelled' } } } as unknown as CycleExecution;
  r.expect(String(executionExit(cancelled, 'SIGINT')), '130', 'SIGINT cancellation maps to exit 130');
  r.expect(String(executionExit(cancelled, 'SIGTERM')), '143', 'SIGTERM cancellation maps to exit 143');
  r.expect(String(diagnosticExit({ version: 1, code: 'STATE_UNAVAILABLE', phase: 'execution', path: '', stateCode: null, piCode: null, effect: 'none', retryable: false })), '8', 'missing workspace maps to exit 8');
  const root = await scratchDirectory('lw-fm-signal-');
  const missingRunRoot = join(root, 'runs');
  try {
    const observed = await readStatus({ runRoot: missingRunRoot, runId: 'missing' });
    const source = observed.ok && 'source' in observed.value ? String(observed.value.source) : '';
    r.expect(source, 'unavailable', 'a missing run root reports the unavailable source');
    let directoryCreated = true;
    try { await lstat(missingRunRoot); } catch { directoryCreated = false; }
    r.expect(String(directoryCreated), 'false', 'the status probe never creates the missing directory');
  } finally { await rm(root, { recursive: true, force: true }); }
  return outcome(id, started, r.claims(), r.failed(), 'STATE_UNAVAILABLE');
}
async function scenarioEight(): Promise<IntegratedFailureScenarioResult> {
  const id = 'unknown_external_effect_reconcile_gate', started = performance.now(), r = recorder();
  const root = await scratchDirectory('lw-fm-reconcile-');
  const emptyRunRoot = join(root, 'run-root');
  await mkdir(emptyRunRoot, { mode: 0o700 });
  try {
    const missing = await reconcileCycle({ configuration: {} as LoadedConfiguration, runRoot: emptyRunRoot, runId: 'run-1', receipt: join(root, 'missing-receipt.json') });
    r.expect(String(missing.ok ? '' : missing.error.code), 'EVIDENCE_UNAVAILABLE', 'a missing publication receipt refuses reconciliation');
    const wrongKind = join(root, 'wrong-kind.json');
    await writeFile(wrongKind, JSON.stringify({ version: 1, kind: 'unrelated_document' }), { mode: 0o600 });
    const mismatched = await reconcileCycle({ configuration: {} as LoadedConfiguration, runRoot: emptyRunRoot, runId: 'run-1', receipt: wrongKind });
    r.expect(String(mismatched.ok ? '' : mismatched.error.code), 'EVIDENCE_UNAVAILABLE', 'a mismatched receipt document refuses reconciliation');
    const leftover = await readdir(emptyRunRoot);
    r.expect(String(leftover.length), '0', 'reconciliation never replays or mutates the run root');
    r.expect(String(diagnosticExit({ version: 1, code: 'RECEIPT_CONFLICT', phase: 'recovery', path: '', stateCode: null, piCode: null, effect: 'none', retryable: false })), '7', 'receipt conflict maps to the stable exit 7');
  } finally { await rm(root, { recursive: true, force: true }); }
  return outcome(id, started, r.claims(), r.failed(), 'RECEIPT_CONFLICT');
}
async function scenarioNine(): Promise<IntegratedFailureScenarioResult> {
  const id = 'expired_or_stale_gate_token_rejection', started = performance.now(), r = recorder();
  const secret = 'closure-matrix-gate-secret';
  const payload = JSON.stringify({ version: 1, kind: 'gate_verdict', status: 'approved', expiresAtMs: 1 });
  const signature = signPayload(secret, payload);
  r.expect(String(verifySignedPayload(secret, payload, signature)), 'true', 'an authentic gate token verifies');
  r.expect(String(verifySignedPayload(secret, JSON.stringify({ version: 1, kind: 'gate_verdict', status: 'denied' }), signature)), 'false', 'a tampered token body fails verification');
  r.expect(String(verifySignedPayload('other-secret', payload, signature)), 'false', 'a rotated secret fails verification');
  r.expect(String(verifySignedPayload(secret, payload, 'zz'.repeat(32))), 'false', 'a malformed signature fails verification');
  r.expect(String(verifySignedPayload(secret, payload, 'sha256=' + signature)), 'true', 'the sha256-prefixed form verifies');
  r.expect(String(diagnosticExit({ version: 1, code: 'AUTHORITY_REFUSED', phase: 'verification', path: '', stateCode: null, piCode: null, effect: 'none', retryable: false })), '7', 'stale or forged authority maps to the stable exit 7');
  return outcome(id, started, r.claims(), r.failed(), 'AUTHORITY_REFUSED');
}
const SUPPORT_TABLE = '<!-- runner-support-records:start -->\n| Backend | Runtime | Service | Variant | Engine | Plugin | Platforms | Status |\n| --- | --- | --- | --- | --- | --- | --- | --- |\n| cuda | 13.0 | vllm | - | 0.29.0 | - | linux/amd64 | prepared |\n<!-- runner-support-records:end -->\n';
const DOCKERFILE = 'ARG VLLM_VERSION=0.29.0\nARG CUDA_VERSION=13.0.1\nARG VLLM_BASE_IMAGE=vllm/vllm-openai:v${VLLM_VERSION}\nARG PYTHON_VERSION=3.12\nARG VLLM_LMCACHE_VERSION=0.5.4\nFROM ${VLLM_BASE_IMAGE} AS vllm\n';
const MATRIX = 'rules:\n  - backend: cuda\n    services: [vllm]\n    platforms: [linux/amd64]\n    args: [VLLM_VERSION=0.29.0]\n';
async function buildRunnerFixture(): Promise<{ path: string; headSha: string }> {
  const root = await mkdtemp(join(await realpath(tmpdir()), 'lw-fm-runner-repo-'));
  await chmod(root, 0o700);
  const git = promisify(execFile);
  const run = async (args: string[]) => { await git('/usr/bin/git', ['-c', 'core.hooksPath=/dev/null', ...args], { cwd: root, env: { ...GIT_ENV, HOME: root } }); };
  await run(['init', '-q', '-b', 'main']);
  await run(['config', 'user.name', 'Fixture']);
  await run(['config', 'user.email', 'fixture@example.invalid']);
  await mkdir(join(root, 'pack', 'cuda'), { recursive: true }); await mkdir(join(root, 'docs'), { recursive: true });
  await writeFile(join(root, 'pack', 'cuda', 'Dockerfile.vllm'), DOCKERFILE);
  await writeFile(join(root, 'pack', 'matrix.yaml'), MATRIX);
  await writeFile(join(root, 'README.md'), '# Runner\n[Supported runners](docs/supported-runners.md)\n');
  await writeFile(join(root, 'docs', 'support-records.md'), SUPPORT_TABLE);
  await run(['add', '.']);
  await run(['commit', '-qm', 'fixture baseline']);
  const headSha = (await git('/usr/bin/git', ['rev-parse', 'HEAD'], { cwd: root, env: { ...GIT_ENV, HOME: root } })).stdout.trim();
  return { path: root, headSha };
}
async function scenarioTen(): Promise<IntegratedFailureScenarioResult> {
  const id = 'mutated_pr_head_publication_abort', started = performance.now(), r = recorder();
  const corpusRoot = defaultCorpusRoot();
  if (corpusRoot === null) return { scenarioId: id, passed: false, diagnosticCode: 'CORPUS_ABSENT', assertions: [], elapsedMs: Math.round(performance.now() - started) };
  let fixture: { path: string; headSha: string } | null = null;
  let service: Awaited<ReturnType<typeof startRunnerTaskpackService>> | null = null;
  const gateSecret = 'closure-matrix-gate-secret', publicationSecret = 'closure-matrix-publication-secret';
  const post = async (url: string, secret: string, body: Record<string, unknown>): Promise<{ readonly status: number; readonly document: Record<string, unknown> }> => {
    const payload = Buffer.from(JSON.stringify(body));
    const response = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', 'x-loopwright-signature': signPayload(secret, payload) }, body: new Uint8Array(payload) });
    const document = JSON.parse(Buffer.from(await response.arrayBuffer()).toString('utf8')) as Record<string, unknown>;
    return { status: response.status, document };
  };
  try {
    fixture = await buildRunnerFixture();
    const proposalBytes = await readFile(join(corpusRoot, 'tests', 'auto_sync', 'fixtures', 'proposals', 'ready.json'), 'utf8');
    const proposal = JSON.parse(proposalBytes) as { identity: Record<string, unknown>; groups: Record<string, unknown>[] };
    proposal.identity.default_sha = fixture.headSha; proposal.identity.head_sha = fixture.headSha;
    const proposalJson = JSON.stringify(proposal);
    const candidateDigest = (await computeRunnerCandidateDigest({ repositorySnapshot: fixture.path, headSha: fixture.headSha, proposalJson })).digest;
    service = await startRunnerTaskpackService({ gateSecret, publicationSecret, corpusRoot, fakeRepositorySnapshot: fixture.path });
    await service.registerCandidate({ storeId: 'store-1', runId: 'run-1', candidateDigest, proposalJson,
      identity: { repository: 'example-org/runtime-runner', defaultSha: fixture.headSha, headSha: fixture.headSha, mode: 'discover', prNumber: null, commandId: null, commandDigest: null },
      repositorySnapshot: fixture.path, upstreamSources: {}, ascendPairs: {}, enginePrereleases: [], prereleasePackages: [] });
    const gate = await post(service.gateUrl, gateSecret, { version: 1, kind: 'gate_request', gateId: 'runner-candidate-validation', checkId: 'runner-candidate-validation', candidateDigest, subject: { repository: 'example-org/runtime-runner', candidateDigest }, storeId: 'store-1', runId: 'run-1', lockHash: 'a'.repeat(64), operationId: 'op.1', dispatchId: 'dispatch-1', dispatchGeneration: 1, requestDigest: 'b'.repeat(64) });
    r.expect(String(gate.document.status), 'approved', 'the registered candidate passes the frozen gate validators');
    const published = await post(service.publicationUrl, publicationSecret, { version: 1, kind: 'publication_request', storeId: 'store-1', runId: 'run-1', lockHash: 'a'.repeat(64), operationId: 'publish.1', dispatchId: 'dispatch-2', dispatchGeneration: 1, idempotencyKey: 'pub.initial', targetBranch: 'main', headBranch: 'loopwright-runner-run-1', title: 'runner: sync upstream runtime support', candidateDigest, baseRevision: fixture.headSha, sourceRevision: fixture.headSha, requestDigest: 'c'.repeat(64) });
    r.expect(String(published.document.outcome), 'succeeded', 'the initial publication lands the managed pull request');
    const prHead = await service.fakePullHeadSha(1);
    if (prHead === null) throw new Error('managed pull request head missing');
    const guidance = '/auto-sync\nPlease refine the report.';
    const commandDigest = createHash('sha256').update(Buffer.from(guidance, 'utf8')).digest('hex');
    const reviseProposal = structuredClone(proposal);
    reviseProposal.identity.default_sha = fixture.headSha; reviseProposal.identity.head_sha = prHead;
    reviseProposal.identity.mode = 'revise'; reviseProposal.identity.pr_number = 1;
    reviseProposal.identity.command_id = 99; reviseProposal.identity.command_digest = commandDigest;
    const group = reviseProposal.groups[0]!;
    (group.rows as Record<string, unknown>[])[0]!.old_engine_version = '0.30.0';
    group.patch = 'diff --git a/README.md b/README.md\n--- a/README.md\n+++ b/README.md\n@@ -1,2 +1,3 @@\n # Runner\n [Supported runners](docs/supported-runners.md)\n+Release report was reviewed.\n';
    const reviseJson = JSON.stringify(reviseProposal);
    const reviseDigest = (await computeRunnerCandidateDigest({ repositorySnapshot: fixture.path, headSha: fixture.headSha, proposalJson: reviseJson })).digest;
    await service.registerCandidate({ storeId: 'store-1', runId: 'run-revise', candidateDigest: reviseDigest, proposalJson: reviseJson,
      identity: { repository: 'example-org/runtime-runner', defaultSha: fixture.headSha, headSha: fixture.headSha, mode: 'revise', prNumber: 1, commandId: 99, commandDigest, prHeadSha: prHead },
      repositorySnapshot: fixture.path, upstreamSources: {}, ascendPairs: {}, enginePrereleases: [], prereleasePackages: [], reviseCommentBody: guidance });
    const reviseGate = await post(service.gateUrl, gateSecret, { version: 1, kind: 'gate_request', gateId: 'runner-candidate-validation', checkId: 'runner-candidate-validation', candidateDigest: reviseDigest, subject: { repository: 'example-org/runtime-runner', candidateDigest: reviseDigest }, storeId: 'store-1', runId: 'run-revise', lockHash: 'a'.repeat(64), operationId: 'op.2', dispatchId: 'dispatch-3', dispatchGeneration: 1, requestDigest: 'd'.repeat(64) });
    r.expect(String(reviseGate.document.status), 'approved', 'the pinned revise candidate passes the gate');
    await service.fakeHumanCommit('README.md', '# Human edit on PR branch\n');
    const refused = await post(service.publicationUrl, publicationSecret, { version: 1, kind: 'publication_request', storeId: 'store-1', runId: 'run-revise', lockHash: 'a'.repeat(64), operationId: 'publish.2', dispatchId: 'dispatch-4', dispatchGeneration: 1, idempotencyKey: 'pub.revise', targetBranch: 'main', headBranch: 'loopwright-runner-run-revise', title: 'runner: sync upstream runtime support', candidateDigest: reviseDigest, baseRevision: fixture.headSha, sourceRevision: fixture.headSha, requestDigest: 'e'.repeat(64) });
    r.expect(String(refused.document.outcome), 'not_executed', 'the mutated PR head aborts publication without executing');
    r.assert(String(refused.document.reason).startsWith('revise_head_changed'), 'the refusal names the moved bound head');
  } finally {
    if (service !== null) await service.close();
    if (fixture !== null) await rm(fixture.path, { recursive: true, force: true });
  }
  return outcome(id, started, r.claims(), r.failed(), 'RECEIPT_CONFLICT');
}
function memoryEntry(overrides: Partial<MemoryEntry>): MemoryEntry {
  const base: MemoryEntry = {
    version: 1, id: 'entry.alpha', claimKey: 'claim.alpha', claim: 'Stable claim text.', kind: 'fact',
    scope: { taskpack: 'demo', repository: 'org/repo', paths: ['docs/**'], targetMatrix: null },
    sourceRef: { runId: 'run.one', lockHash: hexOf('lock'), candidateDigest: hexOf('candidate') },
    sourceDigest: hexOf('source'), verifiedAtMs: 1000,
    validFor: { baseRevision: 'b'.repeat(40), sourceRevision: 'c'.repeat(40), codeFingerprint: hexOf('fingerprint'), upstreamVersions: { npm: '1.0.0' } },
    expiresAtMs: 2000, supersedes: [],
    evidenceRefs: [{ evidenceId: 'ev.one', checkId: 'check.one', level: 'local_execution', observedStatus: 'passed', artifact: { name: 'artifacts/evidence.json', digest: hexOf('artifact'), byteLength: 10 } }],
  };
  return Object.freeze({ ...base, ...overrides }) as MemoryEntry;
}
function memoryIndex(entries: readonly MemoryEntry[]): MemoryStoreIndex {
  const base = { version: 1 as const, taskpack: 'demo', repository: 'org/repo', updatedAtMs: 1500, entries: [...entries], retired: [] };
  return { ...base, storeDigest: storeDigestOf(base) };
}
const memoryContract = {
  apiVersion: 'loopwright.dev/v1alpha1', kind: 'TaskContract',
  spec: { goal: 'demo goal', taskpack: 'demo',
    target: { repository: 'org/repo', baseRevision: 'b'.repeat(40), sourceRevision: 'c'.repeat(40), matrix: null },
    scope: { writable: ['src/**'], protected: [] },
    roles: [{ id: 'coder', adapter: 'pi', provider: 'p', model: 'm', thinking: 'off', tools: [] }],
    trustedContext: { revision: 'rev', discovery: 'disabled', resources: [] },
    budgets: { wallTimeMs: 1, totalTokens: 1, perCallOutputTokens: 1, maxModelCalls: 1, maxConcurrency: 1, maxFormatRepairs: 0, maxImplementationRepairs: 0, maxTransportRetries: 0,
      enforcement: { wallTime: 'soft_accounting', tokens: 'soft_accounting', modelCalls: 'soft_accounting', concurrency: 'soft_accounting', formatRepairs: 'soft_accounting', implementationRepairs: 'soft_accounting', transportRetries: 'soft_accounting' } },
    steps: [{ id: 'work', kind: 'agent', uses: 'work', roleId: 'coder', dependsOn: [] }],
    acceptance: { required: ['check.one'], checks: [{ id: 'check.one', allowedEvidenceLevels: ['local_execution'] }] },
  },
} as unknown as import('@loopwright/core').TaskContract;
async function scenarioEleven(): Promise<IntegratedFailureScenarioResult> {
  const id = 'stale_memory_source_exclusion', started = performance.now(), r = recorder();
  const snapshot = selectActiveMemory({ store: memoryIndex([memoryEntry({ id: 'entry.valid' }), memoryEntry({ id: 'entry.expired', expiresAtMs: 1000 }), memoryEntry({ id: 'entry.stale', validFor: { baseRevision: 'b'.repeat(40), sourceRevision: 'c'.repeat(40), codeFingerprint: hexOf('other-fingerprint'), upstreamVersions: { npm: '1.0.0' } } })]),
    contract: memoryContract, nowMs: 1500, currentCodeFingerprint: hexOf('fingerprint'), currentUpstreamVersions: { npm: '1.0.0' }, targetCell: null });
  r.expect(snapshot.activeEntries.map(entry => entry.id).join(','), 'entry.valid', 'only the current review stays active');
  const reasons = new Map(snapshot.excludedEntries.map(entry => [entry.entryId, entry.reason]));
  r.expect(String(reasons.get('entry.expired')), 'expired', 'a stale TTL excludes the entry as expired');
  r.expect(String(reasons.get('entry.stale')), 'fingerprint_mismatch', 'a stale source fingerprint excludes the entry');
  return outcome(id, started, r.claims(), r.failed(), 'MEMORY_SCOPE_VIOLATION');
}
const compactionInput = (overrides: Record<string, unknown> = {}) => ({
  contextWindowTokens: 1000, nextRequestInputTokens: 700, toolResultReserveTokens: 200, maxOutputTokens: 200,
  postCompactionEstimatedTokens: 300, currentContextTokens: 800, softUtilizationThreshold: 0.8,
  recentRepeatFailureCount: 0, repeatFailureThreshold: 3, upcomingExternalWaitMs: 0, externalWaitThresholdMs: 60000,
  externalReceiptsPersisted: true, expectedReplaySavingsTokens: 500, summaryCostTokens: 10, cacheRebuildCostTokens: 10,
  unpairedToolCallIds: [] as readonly string[], sessionMemorySnapshotDigest: hexOf('snapshot'), activeMemorySnapshotDigest: hexOf('snapshot'),
  checkpointId: 'checkpoint-1', pendingOperationIds: ['op-unknown-1'] as readonly string[], advisoryDecision: null, ...overrides,
});
async function scenarioTwelve(): Promise<IntegratedFailureScenarioResult> {
  const id = 'compaction_pending_operation_preservation', started = performance.now(), r = recorder();
  const unpaired = evaluateCompactionPolicy(compactionInput({ unpairedToolCallIds: ['tool-call-7'] }));
  r.expect(unpaired.disposition, 'blocked', 'unpaired tool calls refuse compaction');
  r.expect(String(unpaired.disposition === 'blocked' ? unpaired.code : ''), 'COMPACTION_UNSAFE_BOUNDARY', 'the unsafe boundary refuses with COMPACTION_UNSAFE_BOUNDARY');
  const invalidCheckpoint = evaluateCompactionPolicy(compactionInput({ checkpointId: 'bad\u0000checkpoint' }));
  r.expect(String(invalidCheckpoint.disposition === 'blocked' ? invalidCheckpoint.code : ''), 'COMPACTION_UNSAFE_BOUNDARY', 'an invalid checkpoint reference refuses compaction');
  const safe = evaluateCompactionPolicy(compactionInput());
  r.expect(safe.disposition, 'compact_now', 'a safe boundary with a hard trigger compacts now');
  r.expect(safe.disposition === 'compact_now' ? safe.checkpoint.pendingOperationIds.join(',') : '', 'op-unknown-1', 'the unsettled operation stays pinned in the compaction checkpoint');
  const lock = unwrap(admitTask(contractFixture() as unknown as TaskContract, { admissionId: 'admission-compact', runId: 'run-compact' }));
  const pending = [{ operationId: 'op-unknown-1', kind: 'publication' as const, state: 'pending_receipt' }];
  const summaryInput = {
    lock, nonGoals: [], currentNodeId: 'build', checks: { passed: ['tests'], failed: [], blocked: [], notRun: [] },
    evidenceRefs: [], modifiedFiles: [], openIssues: [], forbiddenActions: ['force_push'], pendingExternalOperations: pending,
    ledger: { revision: 1, remainingTokens: 500, remainingModelCalls: 3, remainingWallMs: 45000 },
    nextAllowedActions: ['retry_publication'],
    memory: { store: memoryIndex([memoryEntry({ id: 'entry.valid' })]), contract: memoryContract, nowMs: 1500, currentCodeFingerprint: hexOf('fingerprint'), currentUpstreamVersions: { npm: '1.0.0' }, targetCell: null },
  };
  const built = buildCompactionSummary(summaryInput);
  r.expect(built.summary.pendingExternalOperations.map(operation => operation.operationId).join(','), 'op-unknown-1', 'the compaction summary pins the pending external operation');
  r.expect(String(built.digest.hex.length), '64', 'the summary carries a canonical digest');
  const ledger: CompactionLedgerState = { lockHash: built.summary.contractHash, writableScope: ['packages/**'], remainingTokens: 500, remainingModelCalls: 3, remainingWallMs: 45000,
    nodes: [{ id: 'build', state: 'completed' }], pendingExternalOperations: pending, activeMemorySnapshot: built.summary.activeMemorySnapshot };
  const restored = restoreFromCompactionLedger({ ledger, summary: built.summary, proposedWritableScope: ['packages/**'], proposedChecks: [{ id: 'build', state: 'completed' }], proposedBudget: { remainingTokens: 400, remainingModelCalls: 2, remainingWallMs: 40000 } });
  r.expect(String(restored.ok), 'true', 'the pinned summary restores cleanly from the ledger');
  if (restored.ok) r.expect(restored.state.pendingExternalOperations.map(operation => operation.operationId).join(','), 'op-unknown-1', 'the pending external operation replays after restore');
  const tampered = restoreFromCompactionLedger({ ledger, summary: { ...built.summary, pendingExternalOperations: [] }, proposedWritableScope: ['packages/**'], proposedChecks: [{ id: 'build', state: 'completed' }], proposedBudget: { remainingTokens: 400, remainingModelCalls: 2, remainingWallMs: 40000 } });
  r.expect(String(tampered.ok ? '' : tampered.code), 'COMPACTION_AUTHORITY_VIOLATION', 'a summary that drops the pending operation commits an authority violation');
  return outcome(id, started, r.claims(), r.failed(), 'COMPACTION_AUTHORITY_VIOLATION');
}
const VALID_MANIFEST_YAML = `apiVersion: loopwright.dev/v1alpha1
kind: Taskpack
metadata:
  name: docs-sync
spec:
  goal:
    candidate: Refresh documentation from upstream sources and pass every local check.
    noChange: Confirm the documentation needs no change and settle as no change.
  scope:
    writable:
      - docs
    protected:
      - docs/protected-notes.md
  upstreams:
    - id: engine
      kind: github-release
      source: octocat/engine
      watchedPaths:
        - docs
  proposal:
    path: docs/proposal.json
    requiredFields:
      - schema_version
      - candidates
    schemaVersion: 1
  verification:
    localChecks:
      - id: docs-proposal-json
        implementation: json-artifact.v1
    externalGates: []
  publication:
    mode: pull_request
    targetBranch: main
    headBranchPrefix: loopwright-docs-
    titleTemplate: 'docs: sync upstream documentation'
  memory:
    directory: .loopwright/memory/docs-sync
    apply: separate-pull-request
    onNoModelBudget: deterministic-observations-only
  triggers:
    schedule: true
    workflowDispatch: true
    releasePublished: false
    commentCommands:
      - retry
      - revise
      - status
`;
async function scenarioThirteen(): Promise<IntegratedFailureScenarioResult> {
  const id = 'untrusted_taskpack_and_oauth_boundary_refusal', started = performance.now(), r = recorder();
  const manifest = await loadDeclarativeTaskpack({ bytes: Buffer.from(VALID_MANIFEST_YAML, 'utf8'), format: 'yaml' });
  r.expect(String(manifest.metadata.name), 'docs-sync', 'the declarative taskpack manifest parses and validates');
  const escalated = structuredClone(manifest) as unknown as Record<string, unknown>;
  ((escalated.spec as Record<string, unknown>).scope as unknown) = { writable: ['.github/workflows', 'docs'], protected: [] };
  let scopeCode: string | null = null;
  try { validateTaskpackManifest(escalated as never); } catch (error) { scopeCode = error instanceof GitHubAppError ? error.code : 'WRONG_ERROR'; }
  r.expect(scopeCode ?? '', 'TASKPACK_SCOPE_VIOLATION', 'protected-path escalation refuses with TASKPACK_SCOPE_VIOLATION');
  for (const oauthProvider of ['github-copilot', 'openai-codex', 'claude-code', 'gemini']) {
    const withOauthModel = structuredClone(manifest) as unknown as Record<string, unknown>;
    (withOauthModel.spec as Record<string, unknown>).models = [
      { provider: 'zai', id: 'glm-5.3', thinking: 'high' },
      { provider: oauthProvider, id: 'glm-5.3', thinking: 'high' },
    ];
    let modelCode: string | null = null;
    try { validateTaskpackManifest(withOauthModel as never); } catch (error) { modelCode = error instanceof GitHubAppError ? error.code : 'WRONG_ERROR'; }
    r.expect(modelCode ?? '', 'PROVIDER_OAUTH_UNSUPPORTED', `OAuth Pi model provider "${oauthProvider}" refuses with PROVIDER_OAUTH_UNSUPPORTED`);
  }
  const oauth = validateMcpAuthConfiguration({ servers: [{ serverId: 'workspace', auth: { type: 'oauth' } }] });
  r.expect(String(oauth.ok ? '' : oauth.code), 'MCP_OAUTH_UNSUPPORTED', 'interactive OAuth configuration refuses with MCP_OAUTH_UNSUPPORTED');
  const challenge = validateMcpAuthConfiguration({ servers: [{ serverId: 'workspace' }], transportChallenge: { status: 401, wwwAuthenticate: 'Bearer realm="control-plane"' } });
  r.expect(String(challenge.ok ? '' : challenge.code), 'MCP_AUTHENTICATION_REQUIRED', 'an interactive transport challenge refuses with MCP_AUTHENTICATION_REQUIRED');
  let sandboxCode: string | null = null;
  try {
    negotiateSandboxBackend(
      { workspaceRoot: '/tmp/lw-sandbox-probe', writablePaths: ['docs'], preferredBackends: ['direct-dedicated'] },
      { platform: 'darwin', arch: 'arm64', probeExecutables: false },
    );
  } catch (error) { sandboxCode = error instanceof GitHubAppError ? error.code : 'WRONG_ERROR'; }
  r.expect(sandboxCode ?? '', 'SANDBOX_CAPABILITY_INSUFFICIENT', 'direct-dedicated sandbox without override refuses with SANDBOX_CAPABILITY_INSUFFICIENT');
  const seatbelt = compileMacosSeatbeltProfile(
    { workspaceRoot: '/tmp/lw-sandbox-probe', writablePaths: ['docs'], protectedPaths: ['docs/protected-notes.md'], networkMode: 'none' },
    { platform: 'darwin', arch: 'arm64', homeDirectory: '/var/empty', probeExecutables: false },
  );
  r.assert(seatbelt.profileText.includes('(deny file-write*)') && seatbelt.profileText.includes('(deny network*)'), 'macOS Seatbelt profile enforces write and network containment');
  const bwrap = compileLinuxBwrapCommand(
    { workspaceRoot: '/tmp/lw-sandbox-probe', writablePaths: ['docs'], protectedPaths: ['docs/protected-notes.md'], networkMode: 'none' },
    { platform: 'linux', arch: 'x64', homeDirectory: '/var/empty', probeExecutables: false },
  );
  r.assert(bwrap.args.includes('--unshare-all') && bwrap.args.includes('--ro-bind-try'), 'Linux Bubblewrap command enforces namespace isolation and read-only protected masks');
  return outcome(id, started, r.claims(), r.failed(), 'MCP_OAUTH_UNSUPPORTED');
}
async function scenarioFourteen(): Promise<IntegratedFailureScenarioResult> {
  const id = 'decision_authority_escalation_refusal', started = performance.now(), r = recorder();
  let authorityCode: string | null = null;
  try { assertDecisionAuthorityBoundary('certify_verification_evidence'); } catch (error) { authorityCode = error instanceof DecisionError ? error.code : 'WRONG_ERROR'; }
  r.expect(authorityCode ?? '', 'DECISION_AUTHORITY_VIOLATION', 'a non-delegable authority intent refuses with DECISION_AUTHORITY_VIOLATION');
  assertDecisionAuthorityBoundary('route_capability_tier');
  r.assert(true, 'a delegable intent passes the authority boundary');
  let disclosureCode: string | null = null;
  try { sanitizeDecisionState({ note: 'Bearer abcdef' }, decisionPolicy()); } catch (error) { disclosureCode = error instanceof DecisionError ? error.code : 'WRONG_ERROR'; }
  r.expect(disclosureCode ?? '', 'DECISION_DISCLOSURE_VIOLATION', 'secret-bearing state refuses with DECISION_DISCLOSURE_VIOLATION');
  let calls = 0;
  const countingTransport = { async send(): Promise<never> { calls += 1; return new Promise<never>(() => { /* unreachable: refusal precedes transport. */ }); } };
  const result = await evaluateDecision({ policy: decisionPolicy(), state: { note: 'Bearer abcdef' }, budget: new DecisionBudgetTracker({}), questions: [{ type: 'noul', id: 'q3', prompt: 'Proceed?' }], apiKey: 'fixture-decision-key', transport: countingTransport, fallback: () => 'deterministic-default' });
  r.expect(String(result.fallbackReason), 'disclosure_violation', 'secret-bearing state routes to the disclosure fallback');
  r.expect(String(calls), '0', 'no transport call ever leaves the boundary');
  r.expect(String(result.transportCalls), '0', 'the evaluation reports zero transport calls');
  return outcome(id, started, r.claims(), r.failed(), 'DECISION_AUTHORITY_VIOLATION');
}
const PROBES: readonly Probe[] = [
  { id: 'malformed_or_conflicting_json_submission', run: scenarioOne },
  { id: 'forged_test_pass_without_verifier_evidence', run: scenarioTwo },
  { id: 'missing_provider_usage_retained_reservation', run: scenarioThree },
  { id: 'nested_tool_double_debit_prevention', run: scenarioFour },
  { id: 'provider_and_decision_deadline_timeout', run: scenarioFive },
  { id: 'concurrent_owner_and_budget_exhaustion', run: scenarioSix },
  { id: 'signal_interruption_and_workspace_loss', run: scenarioSeven },
  { id: 'unknown_external_effect_reconcile_gate', run: scenarioEight },
  { id: 'expired_or_stale_gate_token_rejection', run: scenarioNine },
  { id: 'mutated_pr_head_publication_abort', run: scenarioTen },
  { id: 'stale_memory_source_exclusion', run: scenarioEleven },
  { id: 'compaction_pending_operation_preservation', run: scenarioTwelve },
  { id: 'untrusted_taskpack_and_oauth_boundary_refusal', run: scenarioThirteen },
  { id: 'decision_authority_escalation_refusal', run: scenarioFourteen },
];
/** Run all 14 cross-package failure probes in-process; deterministic, offline, and Docker-free. */
export async function runIntegratedFailureMatrix(options: IntegratedFailureMatrixOptions = {}): Promise<IntegratedFailureMatrixReport> {
  const scenarios: IntegratedFailureScenarioResult[] = [];
  for (const entry of PROBES) {
    const override = options.scenarioOverrides?.[entry.id];
    if (process.env.LW_MATRIX_DEBUG === '1') console.error('[matrix-debug] start', entry.id);
    const result = override === undefined ? await probe(entry.id, entry.run) : await override();
    if (process.env.LW_MATRIX_DEBUG === '1') console.error('[matrix-debug] done', entry.id, result.passed, result.elapsedMs + 'ms');
    scenarios.push(result);
  }
  const passed = scenarios.filter(result => result.passed).length;
  return { version: 1, total: scenarios.length, passed, failed: scenarios.length - passed, allPassed: passed === scenarios.length, scenarios };
}
