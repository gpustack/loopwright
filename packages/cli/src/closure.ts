import { lstat, realpath } from 'node:fs/promises';
import { join } from 'node:path';
/** Diagnostic codes carried by closure matrix refusals; exit mapping in main.ts stays deterministic. */
export const CLOSURE_FALSIFICATION_FORBIDDEN = 'CLOSURE_FALSIFICATION_FORBIDDEN';
export const CLOSURE_EVIDENCE_MISSING = 'CLOSURE_EVIDENCE_MISSING';
export const CLOSURE_EVIDENCE_UNTRUSTED = 'CLOSURE_EVIDENCE_UNTRUSTED';
export type ClosureDiagnosticCode = typeof CLOSURE_FALSIFICATION_FORBIDDEN | typeof CLOSURE_EVIDENCE_MISSING | typeof CLOSURE_EVIDENCE_UNTRUSTED | 'CAPABILITY_UNSUPPORTED';
export type ClosureCapabilityId =
  | 'exclusive-owner-and-unknown-usage' | 'frozen-runner-parity-corpus' | 'frozen-sdk-and-resource-inventory'
  | 'external-name-and-repair-cap-controls' | 'contract-adversarial-review-coverage' | 'duplicate-json-pointer-rejection'
  | 'immutable-elapsed-clock-basis' | 'qualified-host-clock-and-storage-profile' | 'state-interface-and-sqlite-limits'
  | 'admission-error-precedence' | 'pre-send-context-bound-and-estimated-guard' | 'digest-pinned-runtime-image-availability'
  | 'trusted-config-interpolation-and-mcp-token' | 'mcp-nested-deadline-and-limits-accounting' | 'retained-store-clock-drift-and-reopen-guard'
  | 'controller-recovery-cancellation-and-cli-surface' | 'external-build-and-accelerator-matrix' | 'remote-host-loss-and-durable-wake'
  | 'interactive-mcp-oauth-browser-flow' | 'deployed-github-app-and-webhook-ingress' | 'live-provider-billing-and-effort-attestation'
  | 'reviewed-memory-and-cas-compaction' | 'system-one-decision-routing-and-benchmark';
export type ClosureDisposition = 'closed_local' | 'deferred_owned' | 'blocked_external';
export type ClosureEvidenceLevel = 'unit_and_integration' | 'controlled_local_qualification' | 'frozen_offline_parity' | 'unprovisioned_external';
export type ClosureOwnerPackage = '@loopwright/core' | '@loopwright/state' | '@loopwright/agent-pi' | '@loopwright/controller' | '@loopwright/cli'
  | '@loopwright/taskpack-runner' | '@loopwright/memory' | '@loopwright/github-app' | '@loopwright/decisions';
export type ClosureSubsystem = string;
export interface ClosureCapabilityEntry {
  readonly id: ClosureCapabilityId;
  readonly title: string;
  readonly subsystem: ClosureSubsystem;
  readonly ownerPackage: ClosureOwnerPackage;
  readonly disposition: ClosureDisposition;
  readonly verificationStatus: 'passed' | 'failed' | 'blocked' | 'not_run';
  readonly evidenceLevel: ClosureEvidenceLevel;
  readonly closureCriterion: string;
  readonly residualBoundary: string;
  readonly unlockPrerequisite: string | null;
  readonly evidencePaths: readonly string[];
}
/** Hash-bound operator proof that an unprovisioned external gate was qualified in its target environment. */
export interface ExternalQualificationReceipt {
  readonly capabilityId: ClosureCapabilityId;
  readonly targetEnvironment: string;
  readonly artifactSha256: string;
  readonly verifierSignature: string;
  readonly issuedAtMs: number;
}
export type IntegratedFailureScenarioId =
  | 'malformed_or_conflicting_json_submission' | 'forged_test_pass_without_verifier_evidence'
  | 'missing_provider_usage_retained_reservation' | 'nested_tool_double_debit_prevention'
  | 'provider_and_decision_deadline_timeout' | 'concurrent_owner_and_budget_exhaustion'
  | 'signal_interruption_and_workspace_loss' | 'unknown_external_effect_reconcile_gate'
  | 'expired_or_stale_gate_token_rejection' | 'mutated_pr_head_publication_abort'
  | 'stale_memory_source_exclusion' | 'compaction_pending_operation_preservation'
  | 'untrusted_taskpack_and_oauth_boundary_refusal' | 'decision_authority_escalation_refusal';
export interface IntegratedFailureScenarioResult {
  readonly scenarioId: IntegratedFailureScenarioId;
  readonly passed: boolean;
  readonly diagnosticCode: string | null;
  readonly assertions: readonly string[];
  readonly elapsedMs: number;
}
export interface IntegratedFailureMatrixReport {
  readonly version: 1;
  readonly total: number;
  readonly passed: number;
  readonly failed: number;
  readonly allPassed: boolean;
  readonly scenarios: readonly IntegratedFailureScenarioResult[];
}
export interface ClosureEvidenceFailure { readonly capabilityId: ClosureCapabilityId | null; readonly path: string; readonly code: typeof CLOSURE_EVIDENCE_MISSING | typeof CLOSURE_EVIDENCE_UNTRUSTED; readonly detail: string }
export interface ClosureIntegrityReport { readonly ok: boolean; readonly checkedFiles: number; readonly failures: readonly ClosureEvidenceFailure[] }
export interface ClosureDiagnostic { readonly code: ClosureDiagnosticCode; readonly capabilityId: ClosureCapabilityId | null; readonly path: string; readonly detail: string }
export interface ClosureEvaluationOptions {
  readonly repoRoot?: string;
  readonly verifyFailures?: boolean;
  readonly entries?: readonly ClosureCapabilityEntry[];
  readonly receipts?: readonly ExternalQualificationReceipt[];
  /** Injected by callers that can run the cross-package harness; absent leaves `failureMatrix` null. */
  readonly runFailureMatrix?: () => IntegratedFailureMatrixReport | Promise<IntegratedFailureMatrixReport>;
}
export interface ClosureMatrixReport {
  readonly version: 1;
  readonly integrity: ClosureIntegrityReport;
  readonly falsificationDetected: boolean;
  readonly diagnostics: readonly ClosureDiagnostic[];
  readonly summary: { readonly total: number; readonly closedLocal: number; readonly deferredOwned: number; readonly blockedExternal: number; readonly unprovisionedExternal: number; readonly passed: number };
  readonly failureMatrix: IntegratedFailureMatrixReport | null;
}
const DISPOSITIONS: readonly ClosureDisposition[] = ['closed_local', 'deferred_owned', 'blocked_external'];
const EVIDENCE_LEVELS: readonly ClosureEvidenceLevel[] = ['unit_and_integration', 'controlled_local_qualification', 'frozen_offline_parity', 'unprovisioned_external'];
const STATUSES: readonly ClosureCapabilityEntry['verificationStatus'][] = ['passed', 'failed', 'blocked', 'not_run'];
const OWNER_PACKAGES: readonly ClosureOwnerPackage[] = ['@loopwright/core', '@loopwright/state', '@loopwright/agent-pi', '@loopwright/controller', '@loopwright/cli', '@loopwright/taskpack-runner', '@loopwright/memory', '@loopwright/github-app', '@loopwright/decisions'];
function text(value: unknown): string { return typeof value === 'string' ? value : ''; }
function entryShapeErrors(entry: ClosureCapabilityEntry, path: string): ClosureDiagnostic[] {
  const errors: ClosureDiagnostic[] = [];
  const requireText = (field: keyof ClosureCapabilityEntry, minimum: number): void => {
    if (text(entry[field]).length < minimum) errors.push({ code: 'CAPABILITY_UNSUPPORTED', capabilityId: entry.id, path: `${path}/${field}`, detail: 'must be a non-empty string' });
  };
  if (!DISPOSITIONS.includes(entry.disposition)) errors.push({ code: 'CAPABILITY_UNSUPPORTED', capabilityId: entry.id, path: `${path}/disposition`, detail: 'unknown disposition' });
  if (!EVIDENCE_LEVELS.includes(entry.evidenceLevel)) errors.push({ code: 'CAPABILITY_UNSUPPORTED', capabilityId: entry.id, path: `${path}/evidenceLevel`, detail: 'unknown evidence level' });
  if (!STATUSES.includes(entry.verificationStatus)) errors.push({ code: 'CAPABILITY_UNSUPPORTED', capabilityId: entry.id, path: `${path}/verificationStatus`, detail: 'unknown verification status' });
  if (!OWNER_PACKAGES.includes(entry.ownerPackage)) errors.push({ code: 'CAPABILITY_UNSUPPORTED', capabilityId: entry.id, path: `${path}/ownerPackage`, detail: 'unknown owner package' });
  requireText('title', 1); requireText('closureCriterion', 1); requireText('residualBoundary', 1); requireText('subsystem', 1);
  if (!Array.isArray(entry.evidencePaths) || entry.evidencePaths.length < 1) errors.push({ code: 'CAPABILITY_UNSUPPORTED', capabilityId: entry.id, path: `${path}/evidencePaths`, detail: 'must list at least one relative path' });
  else for (const candidate of entry.evidencePaths) if (!isRelativeEvidencePath(candidate)) errors.push({ code: 'CAPABILITY_UNSUPPORTED', capabilityId: entry.id, path: `${path}/evidencePaths`, detail: `"${candidate}" is not a repository-relative path` });
  const needsUnlock = entry.disposition !== 'closed_local' || entry.verificationStatus !== 'passed';
  if (needsUnlock && (entry.unlockPrerequisite === null || entry.unlockPrerequisite.trim().length === 0)) errors.push({ code: 'CAPABILITY_UNSUPPORTED', capabilityId: entry.id, path: `${path}/unlockPrerequisite`, detail: 'non-passed rows must name an unlock prerequisite' });
  if (!needsUnlock && entry.unlockPrerequisite !== null) errors.push({ code: 'CAPABILITY_UNSUPPORTED', capabilityId: entry.id, path: `${path}/unlockPrerequisite`, detail: 'passed closed rows must not name an unlock prerequisite' });
  if (entry.disposition === 'closed_local' && entry.verificationStatus !== 'passed') errors.push({ code: 'CAPABILITY_UNSUPPORTED', capabilityId: entry.id, path: `${path}/verificationStatus`, detail: 'closed_local rows must be passed' });
  return errors;
}
function isRelativeEvidencePath(candidate: string): boolean {
  if (candidate.length === 0 || candidate.startsWith('/') || candidate.includes('\\')) return false;
  return candidate.split('/').every(segment => segment.length > 0 && segment !== '.' && segment !== '..');
}
function freezeEntries(entries: readonly ClosureCapabilityEntry[]): readonly ClosureCapabilityEntry[] {
  return Object.freeze(entries.map(entry => Object.freeze({ ...entry, evidencePaths: Object.freeze([...entry.evidencePaths]) })));
}
function ledgerEntry(entry: ClosureCapabilityEntry): ClosureCapabilityEntry {
  const errors = entryShapeErrors(entry, '/ledger');
  if (errors.length > 0) throw new Error(`CLOSURE_LEDGER_INVALID: ${errors.map(error => `${error.path} ${error.detail}`).join('; ')}`);
  return entry;
}
const CLOSED = (id: ClosureCapabilityId, title: string, subsystem: ClosureSubsystem, ownerPackage: ClosureOwnerPackage, evidenceLevel: ClosureEvidenceLevel, criterion: string, residual: string, evidencePaths: readonly string[]): ClosureCapabilityEntry =>
  ledgerEntry({ id, title, subsystem, ownerPackage, disposition: 'closed_local', verificationStatus: 'passed', evidenceLevel, closureCriterion: criterion, residualBoundary: residual, unlockPrerequisite: null, evidencePaths });
const EXTERNAL = (id: ClosureCapabilityId, title: string, subsystem: ClosureSubsystem, ownerPackage: ClosureOwnerPackage, disposition: ClosureDisposition, status: ClosureCapabilityEntry['verificationStatus'], criterion: string, residual: string, unlock: string, evidencePaths: readonly string[]): ClosureCapabilityEntry =>
  ledgerEntry({ id, title, subsystem, ownerPackage, disposition, verificationStatus: status, evidenceLevel: 'unprovisioned_external', closureCriterion: criterion, residualBoundary: residual, unlockPrerequisite: unlock, evidencePaths });
/** The frozen 23-row Capability Closure Ledger; every evidence path is a committed repository file. */
export const CLOSURE_CAPABILITY_LEDGER: readonly ClosureCapabilityEntry[] = freezeEntries([
  CLOSED('exclusive-owner-and-unknown-usage', 'Exclusive owner fencing and unknown-usage retention', 'controller-execution', '@loopwright/controller', 'controlled_local_qualification',
    'A single active owner survives recovery and every unknown-outcome dispatch retains its reservation until reconciled.',
    'Recovery beyond the retained local store requires an operator-supplied receipt.', ['packages/controller/src/ownership.ts', 'packages/controller/test/progress-ownership.test.ts']),
  CLOSED('frozen-runner-parity-corpus', 'Frozen offline runner parity corpus', 'runner-parity', '@loopwright/taskpack-runner', 'frozen_offline_parity',
    'The vendored offline corpus reproduces legacy scenario outcomes with digest-pinned manifests.',
    'Live upstream acquisition and real pull requests stay outside the frozen corpus.', ['packages/taskpack-runner/src/corpus.ts', 'packages/taskpack-runner/vendor/runner-auto-sync/manifest.json']),
  CLOSED('frozen-sdk-and-resource-inventory', 'Frozen Pi SDK and resource inventory', 'pi-sdk-inventory', '@loopwright/agent-pi', 'controlled_local_qualification',
    'The pinned Pi SDK graph and adapter resource inventory digest-match the installed lockfile.',
    'Upstream SDK releases require requalification before admission.', ['packages/agent-pi/src/descriptor.ts', 'packages/agent-pi/src/catalog.ts', 'packages/agent-pi/qualification/absence.test.mjs']),
  CLOSED('external-name-and-repair-cap-controls', 'External name and repair cap controls', 'core-contract-limits', '@loopwright/core', 'unit_and_integration',
    'External names, repair caps, and identifier validation enforce the documented limits.',
    'Provider-side behavior beyond the parsed contract is out of scope.', ['packages/core/src/limits.ts', 'packages/core/test/contracts.test.ts']),
  CLOSED('contract-adversarial-review-coverage', 'Contract adversarial review coverage', 'core-contract-review', '@loopwright/core', 'unit_and_integration',
    'Adversarial review coverage proves contract refusals for malformed and conflicting documents.',
    'New document kinds extend the matrix through the follow-on contract suite.', ['packages/core/test/integration.test.ts', 'packages/core/test/acceptance.test.ts']),
  CLOSED('duplicate-json-pointer-rejection', 'Duplicate JSON member rejection', 'core-json-boundary', '@loopwright/core', 'unit_and_integration',
    'Duplicate JSON members are rejected before document validation runs.',
    'Duplicate semantics in foreign configuration formats stay out of scope.', ['packages/core/src/boundary.ts', 'packages/core/test/boundary.test.ts']),
  CLOSED('immutable-elapsed-clock-basis', 'Immutable elapsed clock basis', 'state-clock', '@loopwright/state', 'unit_and_integration',
    'Elapsed time derives from an immutable monotonic basis with bounded drift.',
    'Wall-clock alignment to external time authorities is out of scope.', ['packages/state/src/clock.ts', 'packages/state/test/clock.test.ts']),
  CLOSED('qualified-host-clock-and-storage-profile', 'Qualified host clock and storage profile', 'host-qualification', '@loopwright/github-app', 'unit_and_integration',
    'Host qualification refuses unqualified filesystems, unqualified platforms, and drifting clocks.',
    'Deployed host qualification requires the deployed control plane.', ['packages/github-app/src/qualification.ts', 'packages/github-app/test/token-broker-qualification.test.ts']),
  CLOSED('state-interface-and-sqlite-limits', 'State interface and SQLite limits', 'state-store-interface', '@loopwright/state', 'unit_and_integration',
    'The retained store interface honors SQLite limits for pages, records, and reopen.',
    'Non-SQLite storage engines are out of scope.', ['packages/state/src/store.ts', 'packages/state/src/connection.ts', 'packages/state/test/store.test.ts']),
  CLOSED('admission-error-precedence', 'Admission error precedence', 'state-admission', '@loopwright/state', 'unit_and_integration',
    'Admission refusals surface the highest-precedence documented error code.',
    'Provider-side admission errors are out of scope.', ['packages/state/src/admission.ts', 'packages/state/src/errors.ts', 'packages/state/test/admission.test.ts']),
  CLOSED('pre-send-context-bound-and-estimated-guard', 'Pre-send context bound and estimated guard', 'pi-context-guard', '@loopwright/agent-pi', 'controlled_local_qualification',
    'Pre-send context stays inside the estimated guard with explicit operator opt-in.',
    'Live provider context windows require the qualified runtime image.', ['packages/agent-pi/src/context.ts', 'packages/agent-pi/src/admission.ts']),
  CLOSED('digest-pinned-runtime-image-availability', 'Digest-pinned runtime image availability', 'pi-runtime-image', '@loopwright/agent-pi', 'controlled_local_qualification',
    'The runtime image is digest-pinned and its absence is refused before dispatch.',
    'Image availability inside the deployed registry stays an external gate.', ['packages/agent-pi/src/containers.ts', 'packages/agent-pi/qualification/docker-socket.test.mjs']),
  CLOSED('trusted-config-interpolation-and-mcp-token', 'Trusted configuration interpolation and MCP token custody', 'controller-config-trust', '@loopwright/controller', 'controlled_local_qualification',
    'Configuration interpolation keeps MCP tokens inside credential bindings and out of compiled plans.',
    'External secret stores are out of scope.', ['packages/controller/src/interpolation.ts', 'packages/controller/src/credentials.ts']),
  CLOSED('mcp-nested-deadline-and-limits-accounting', 'Nested MCP deadline and limits accounting', 'pi-mcp-accounting', '@loopwright/agent-pi', 'controlled_local_qualification',
    'Nested MCP deadlines and limits charge exactly once against the parent reservation.',
    'Nested accounting for non-MCP extensions stays out of scope.', ['packages/agent-pi/src/deadline.ts', 'packages/agent-pi/src/broker-channel.ts']),
  CLOSED('retained-store-clock-drift-and-reopen-guard', 'Retained store clock drift and reopen guard', 'state-retention', '@loopwright/state', 'unit_and_integration',
    'Reopen refuses drifted clocks and incomplete retained stores.',
    'Cross-host store migration is out of scope.', ['packages/state/src/connection.ts', 'packages/state/src/clock.ts']),
  CLOSED('controller-recovery-cancellation-and-cli-surface', 'Controller recovery, cancellation, and CLI surface', 'cli-recovery-surface', '@loopwright/cli', 'controlled_local_qualification',
    'Recovery, cancellation exits, and the CLI surface keep the documented exit codes.',
    'Remote operator consoles are out of scope.', ['packages/cli/src/main.ts', 'packages/cli/src/arguments.ts', 'packages/cli/test/arguments.test.ts', 'packages/controller/src/recovery.ts']),
  EXTERNAL('external-build-and-accelerator-matrix', 'External build and accelerator matrix', 'external-build-matrix', '@loopwright/controller', 'blocked_external', 'blocked',
    'A qualified external build host must reproduce the accelerator matrix with attestations.',
    'No local host can close the multi-architecture accelerator matrix.',
    'Provision a multi-architecture build host with physical accelerators and attach a hash-bound qualification receipt.', ['docs/pi-runtime-evaluation.md']),
  EXTERNAL('remote-host-loss-and-durable-wake', 'Remote host loss and durable wake', 'remote-durability', '@loopwright/state', 'blocked_external', 'not_run',
    'A remote host loss with durable wake must retain fenced state across the outage.',
    'Local crash tests park owned children; remote loss stays unprovisioned.',
    'Provision a remote host with durable storage and run the wake qualification against it.', ['docs/state.md']),
  EXTERNAL('interactive-mcp-oauth-browser-flow', 'Interactive MCP OAuth browser flow', 'interactive-oauth', '@loopwright/github-app', 'deferred_owned', 'blocked',
    'Interactive browser OAuth flows are refused pre-admission and stay deferred.',
    'No browser, loopback listener, or anonymous fallback exists in the control plane.',
    'Approve an interactive OAuth qualification plan with a bound browser harness receipt.', ['packages/github-app/src/qualification.ts']),
  EXTERNAL('deployed-github-app-and-webhook-ingress', 'Deployed GitHub App and webhook ingress', 'deployed-ingress', '@loopwright/github-app', 'blocked_external', 'not_run',
    'Deployed GitHub App webhook ingress must verify signatures under the deployed control plane.',
    'The loopback service double cannot prove deployed ingress.',
    'Deploy the GitHub App control plane with a reachable webhook endpoint and attach the deployment receipt.', ['packages/github-app/src/webhook.ts', 'docs/github-app.md']),
  EXTERNAL('live-provider-billing-and-effort-attestation', 'Live provider billing and effort attestation', 'provider-attestation', '@loopwright/agent-pi', 'deferred_owned', 'not_run',
    'Live provider billing and effort attestation require provider-side statements.',
    'Local accounting proves bounds, not provider billing.',
    'Attach a provider billing attestation covering the qualified model matrix.', ['packages/core/src/usage.ts', 'docs/pi-runtime-evaluation.md']),
  CLOSED('reviewed-memory-and-cas-compaction', 'Reviewed memory and CAS compaction', 'memory-compaction', '@loopwright/memory', 'unit_and_integration',
    'Reviewed memory proposals verify, apply under CAS, and compact only past safe boundaries.',
    'Cross-repository memory federation is out of scope.', ['packages/memory/src/compaction.ts', 'packages/memory/src/cas.ts', 'packages/memory/test/compaction.test.ts']),
  CLOSED('system-one-decision-routing-and-benchmark', 'System-One decision routing and benchmark', 'decision-routing', '@loopwright/decisions', 'unit_and_integration',
    'Decision authority boundaries refuse non-delegable intents and the controlled benchmark pins routing quality.',
    'Live provider routing quality beyond the frozen benchmark corpus stays unmeasured.', ['packages/decisions/src/router.ts', 'packages/decisions/src/benchmark.ts', 'packages/decisions/test/benchmark.test.ts']),
]);
function receiptErrors(receipt: ExternalQualificationReceipt): string | null {
  if (typeof receipt.capabilityId !== 'string' || receipt.capabilityId.length === 0) return 'receipt names no capability';
  if (text(receipt.targetEnvironment).trim().length === 0) return 'receipt targetEnvironment must be a non-empty string';
  if (!/^[0-9a-f]{64}$/.test(receipt.artifactSha256)) return 'receipt artifactSha256 must match ^[0-9a-f]{64}$';
  if (!/^[0-9a-f]{64,}$/.test(receipt.verifierSignature)) return 'receipt verifierSignature must match ^[0-9a-f]{64,}$';
  if (!Number.isSafeInteger(receipt.issuedAtMs) || receipt.issuedAtMs <= 0) return 'receipt issuedAtMs must be a positive integer';
  return null;
}
/** Verify every ledger evidence path resolves to a committed regular file inside the repository root. */
export async function verifyClosureLedgerIntegrity(repoRoot: string, entries: readonly ClosureCapabilityEntry[] = CLOSURE_CAPABILITY_LEDGER): Promise<ClosureIntegrityReport> {
  const failures: ClosureEvidenceFailure[] = [];
  let checkedFiles = 0;
  let root: string;
  try {
    root = await realpath(repoRoot);
    const rootStats = await lstat(root);
    if (!rootStats.isDirectory()) throw new Error('not a directory');
  } catch {
    return { ok: false, checkedFiles: 0, failures: [{ capabilityId: null, path: '.', code: CLOSURE_EVIDENCE_UNTRUSTED, detail: 'repository root is missing or not a real directory' }] };
  }
  try { await lstat(join(root, '.github', 'workflows')); failures.push({ capabilityId: null, path: '.github/workflows', code: CLOSURE_EVIDENCE_UNTRUSTED, detail: '.github/workflows must not exist in the audited repository root' }); }
  catch { /* absent workflows directory is required. */ }
  for (const entry of entries) for (const candidate of entry.evidencePaths) {
    if (!isRelativeEvidencePath(candidate)) { failures.push({ capabilityId: entry.id, path: candidate, code: CLOSURE_EVIDENCE_UNTRUSTED, detail: 'path must be relative without dot-dot segments' }); continue; }
    let stats;
    try { stats = await lstat(join(root, candidate)); }
    catch { failures.push({ capabilityId: entry.id, path: candidate, code: CLOSURE_EVIDENCE_MISSING, detail: 'evidence file is missing' }); continue; }
    if (stats.isSymbolicLink() || !stats.isFile()) { failures.push({ capabilityId: entry.id, path: candidate, code: CLOSURE_EVIDENCE_UNTRUSTED, detail: 'evidence must be a regular file without symlinks' }); continue; }
    try {
      const resolved = await realpath(join(root, candidate));
      if (resolved !== join(root, candidate)) throw new Error('escapes the repository root through an intermediate symlink');
    } catch { failures.push({ capabilityId: entry.id, path: candidate, code: CLOSURE_EVIDENCE_UNTRUSTED, detail: 'evidence path escapes the repository root or traverses a symlink' }); continue; }
    checkedFiles += 1;
  }
  return { ok: failures.length === 0, checkedFiles, failures };
}
function receiptFor(receipts: readonly ExternalQualificationReceipt[] | undefined, id: ClosureCapabilityId): ExternalQualificationReceipt | undefined {
  return receipts?.find(receipt => receipt.capabilityId === id);
}
/** Evaluate the closure matrix: shape invariants, the non-falsification guard, optional repository evidence integrity, and the optional failure matrix. */
export async function evaluateClosureMatrix(options: ClosureEvaluationOptions = {}): Promise<ClosureMatrixReport> {
  const entries = options.entries ?? CLOSURE_CAPABILITY_LEDGER;
  const diagnostics: ClosureDiagnostic[] = [];
  let falsificationDetected = false;
  const seen = new Set<string>();
  for (const [index, entry] of entries.entries()) {
    const path = `/entries/${index}`;
    if (seen.has(entry.id)) { diagnostics.push({ code: 'CAPABILITY_UNSUPPORTED', capabilityId: entry.id, path: `${path}/id`, detail: 'duplicate capability id' }); continue; }
    seen.add(entry.id);
    diagnostics.push(...entryShapeErrors(entry, path));
    if (entry.evidenceLevel === 'unprovisioned_external' && (entry.disposition === 'closed_local' || entry.verificationStatus === 'passed')) {
      const receipt = receiptFor(options.receipts, entry.id);
      const invalid = receipt === undefined ? 'no qualification receipt supplied for an unprovisioned external upgrade' : receiptErrors(receipt);
      if (invalid !== null) { falsificationDetected = true; diagnostics.push({ code: CLOSURE_FALSIFICATION_FORBIDDEN, capabilityId: entry.id, path: `${path}/disposition`, detail: invalid }); }
    }
  }
  const integrity = options.repoRoot === undefined
    ? { ok: true, checkedFiles: 0, failures: [] as readonly ClosureEvidenceFailure[] }
    : await verifyClosureLedgerIntegrity(options.repoRoot, entries);
  const failureMatrix = options.verifyFailures === true
    ? await (options.runFailureMatrix !== undefined ? options.runFailureMatrix() : (await import('./failure-matrix.js')).runIntegratedFailureMatrix())
    : null;
  const summary = {
    total: entries.length,
    closedLocal: entries.filter(entry => entry.disposition === 'closed_local').length,
    deferredOwned: entries.filter(entry => entry.disposition === 'deferred_owned').length,
    blockedExternal: entries.filter(entry => entry.disposition === 'blocked_external').length,
    unprovisionedExternal: entries.filter(entry => entry.evidenceLevel === 'unprovisioned_external').length,
    passed: entries.filter(entry => entry.verificationStatus === 'passed').length,
  };
  return { version: 1, integrity, falsificationDetected, diagnostics, summary, failureMatrix };
}
