import { decodePiCapture, type PiAdapterV2, type PiOutcomeV2 } from '@loopwright/agent-pi';
import { bindSubject, digestArtifact, identifyManifest, type ArtifactManifest, type ArtifactRef, type TaskLock } from '@loopwright/core';
import type { Authority, CheckpointRecord, LocalRunStore } from '@loopwright/state';
import { stateValue, type ArtifactReader, type ArtifactStore } from './storage.js';
import { canonical, hash, list, record, same, text } from './schema.js';
import { parsePrivateJson } from './parser.js';
import { journal, phaseCheckpointId } from './progress.js';
import { formatPolicy } from './repair.js';
import { refuse, type ControllerDiagnostic } from './errors.js';
import { assertCanonicalMinimalOverlay, canonicalizeCandidateManifest, compareUtf16, type FrozenSource } from './source.js';
import type { CompiledPlan, ControllerAttempt, PlannedRole } from './types.js';
export interface CapturedRole {
  readonly checkpointId: string; readonly outcome: ArtifactRef; readonly originalManifest: ArtifactRef;
  readonly manifest: ArtifactRef; readonly digest: import('@loopwright/core').Digest;
  readonly workspace: ArtifactRef; readonly session: ArtifactRef | null; readonly submission: ArtifactRef | null;
  readonly artifacts: readonly { readonly name: string; readonly bytes: Uint8Array }[];
}
export interface DelegatedCapturePayload {
  readonly format: 'delegated-capture.v1';
  readonly version: 1;
  readonly baseRevision: string;
  readonly sourceRevision: string;
  readonly overlay: readonly { readonly name: string; readonly mode: '100644' | '100755'; readonly bodyBase64: string }[];
  readonly deleted: readonly string[];
  readonly assistantText: string | null;
  readonly status: 'completed' | 'no_change' | 'failed' | 'blocked';
  readonly reason: string | null;
}
export function nativeSessionId(runId: string, roleId: string, stepId: string, policy: PlannedRole['policy']): string {
  return 'session.' + hash('loopwright.dev/controller/session/v1\0' + canonical({ runId, roleId, stepId, policy })).hex.slice(0, 40);
}
export function decodeDelegatedWorkspace(
  workspaceBytes: Uint8Array,
  expectedManifest: ArtifactManifest,
  lock: TaskLock,
  phase: ControllerDiagnostic['phase'] = 'recovery',
): {
  readonly candidate: ArtifactManifest;
  readonly artifacts: readonly { readonly name: string; readonly bytes: Uint8Array }[];
  readonly submission: Uint8Array | null;
  readonly payload: DelegatedCapturePayload;
} {
  const fail = () => refuse(phase === 'inspection' ? 'ARTIFACT_INVALID' : 'RECOVERY_REQUIRED', '', phase);
  let raw: unknown;
  try { raw = parsePrivateJson(Buffer.from(workspaceBytes), 8_388_608); } catch { return fail(); }
  const doc = record(raw, ['format', 'version', 'baseRevision', 'sourceRevision', 'overlay', 'deleted', 'assistantText', 'status', 'reason']);
  if (doc.format !== 'delegated-capture.v1' || doc.version !== 1
    || text(doc.baseRevision) !== lock.spec.contract.spec.target.baseRevision
    || text(doc.sourceRevision) !== lock.spec.contract.spec.target.sourceRevision
    || !['completed', 'no_change', 'failed', 'blocked'].includes(text(doc.status))
    || doc.reason !== null && typeof doc.reason !== 'string'
    || doc.assistantText !== null && typeof doc.assistantText !== 'string') return fail();
  const deleted = list(doc.deleted, '', 4096).map(item => text(item, '', 4096));
  if (!same([...deleted].sort(compareUtf16), deleted) || new Set(deleted).size !== deleted.length) return fail();
  const overlayRaw = list(doc.overlay, '', 256);
  const overlay: { readonly name: string; readonly mode: '100644' | '100755'; readonly bodyBase64: string }[] = [];
  const artifacts: { readonly name: string; readonly bytes: Uint8Array }[] = [];
  const entries: ArtifactRef[] = [];
  let totalBytes = 0;
  for (const item of overlayRaw) {
    const entry = record(item, ['name', 'mode', 'bodyBase64']);
    const name = text(entry.name, '', 4096), mode = text(entry.mode), bodyBase64 = text(entry.bodyBase64, '', 2_097_152);
    if (mode !== '100644' && mode !== '100755') return fail();
    const bytes = new Uint8Array(Buffer.from(bodyBase64, 'base64'));
    if (Buffer.from(bytes).toString('base64') !== bodyBase64 || bytes.byteLength > 1_048_576 || (totalBytes += bytes.byteLength) > 4_194_304) return fail();
    const ref = digestArtifact(name, bytes);
    if (!ref.ok) return fail();
    overlay.push({ name, mode, bodyBase64 });
    artifacts.push({ name, bytes });
    entries.push(ref.value);
  }
  if (!same([...overlay.map(o => o.name)].sort(compareUtf16), overlay.map(o => o.name)) || new Set(overlay.map(o => o.name)).size !== overlay.length) return fail();
  const draftManifest = expectedManifest.spec.baseTree !== undefined
    ? { apiVersion: 'loopwright.dev/v1alpha1' as const, kind: 'ArtifactManifest' as const, metadata: { id: 'candidate' }, spec: { baseTree: expectedManifest.spec.baseTree, entries, deleted } }
    : { apiVersion: 'loopwright.dev/v1alpha1' as const, kind: 'ArtifactManifest' as const, metadata: { id: 'candidate' }, spec: { entries } };
  const identified = identifyManifest(draftManifest);
  if (!identified.ok || !same(canonicalizeCandidateManifest(identified.value.manifest), expectedManifest)) return fail();
  const assistantText = doc.assistantText as string | null;
  const submission = assistantText === null ? null : new Uint8Array(Buffer.from(assistantText, 'utf8'));
  return {
    candidate: identified.value.manifest,
    artifacts,
    submission,
    payload: {
      format: 'delegated-capture.v1',
      version: 1,
      baseRevision: text(doc.baseRevision),
      sourceRevision: text(doc.sourceRevision),
      overlay,
      deleted,
      assistantText,
      status: doc.status as DelegatedCapturePayload['status'],
      reason: doc.reason as string | null,
    },
  };
}
export async function decodeCandidateCapture(input: {
  readonly artifacts: ArtifactReader;
  readonly lock: TaskLock;
  readonly plan: CompiledPlan;
  readonly checkpoint: CheckpointRecord;
  readonly attempt: ControllerAttempt;
  readonly expectedManifest: ArtifactManifest;
  readonly requestIds: readonly string[];
  readonly phase: ControllerDiagnostic['phase'];
}): Promise<{
  readonly candidate: ArtifactManifest;
  readonly artifacts: readonly { readonly name: string; readonly bytes: Uint8Array }[];
  readonly submission: Uint8Array | null;
}> {
  const { artifacts, lock, plan, checkpoint, attempt, expectedManifest, requestIds, phase } = input;
  const workspaceBytes = await artifacts.read(checkpoint.workspace);
  let peek: unknown = null;
  if (workspaceBytes.byteLength <= 8_388_608) {
    try { peek = parsePrivateJson(Buffer.from(workspaceBytes), 8_388_608); } catch { peek = null; }
  }
  if (peek !== null && typeof peek === 'object' && !Array.isArray(peek) && (peek as Record<string, unknown>).format === 'delegated-capture.v1') {
    const decoded = decodeDelegatedWorkspace(workspaceBytes, expectedManifest, lock, phase);
    return { candidate: decoded.candidate, artifacts: decoded.artifacts, submission: decoded.submission };
  }
  if (checkpoint.privateSession === null) refuse(phase === 'inspection' ? 'ARTIFACT_INVALID' : 'RECOVERY_REQUIRED', '', phase);
  const originalRole = plan.roles.find(role => role.roleId === plan.orderedDAG.find(node => node.id === attempt.nodeId)!.roleId)!;
  const policy = attempt.repair === 'format' ? formatPolicy(originalRole.policy) : originalRole.policy;
  const decoded = await decodePiCapture({
    version: 1,
    lock,
    policy,
    checkpoint,
    sessionId: attempt.sessionId,
    roleId: originalRole.roleId,
    stepId: attempt.nativeStepId,
    workspace: { ref: checkpoint.workspace, bytes: workspaceBytes },
    session: { ref: checkpoint.privateSession, bytes: await artifacts.read(checkpoint.privateSession, 67_108_864) },
    command: attempt.purpose === 'compaction' ? null : { textDigest: hash(await artifacts.read(attempt.command, 1_048_576)), requestIds },
  });
  if (!decoded.ok || !same(canonicalizeCandidateManifest(decoded.value.candidate), expectedManifest)) {
    refuse(phase === 'inspection' ? 'ARTIFACT_INVALID' : 'RECOVERY_REQUIRED', '', phase);
  }
  return { candidate: decoded.value.candidate, artifacts: decoded.value.artifacts, submission: decoded.value.submission };
}
export async function captureDelegatedRole(
  store: LocalRunStore,
  authority: Authority,
  artifacts: ArtifactStore,
  lock: TaskLock,
  role: PlannedRole,
  attempt: ControllerAttempt,
  source: FrozenSource,
  input: {
    readonly candidateManifest: ArtifactManifest;
    readonly candidateFiles: readonly { readonly name: string; readonly bytes: Uint8Array }[];
    readonly payload: DelegatedCapturePayload;
    readonly submissionBytes: Uint8Array | null;
  },
): Promise<CapturedRole> {
  const checkpointId = phaseCheckpointId(lock.spec.runId, 'role.' + attempt.ordinal + '.native');
  const canonicalManifest = identifyManifest(canonicalizeCandidateManifest(input.candidateManifest));
  if (!canonicalManifest.ok || Buffer.byteLength(canonical(canonicalManifest.value.manifest)) > 32_768) refuse('OUTPUT_LIMIT', '', 'execution');
  assertCanonicalMinimalOverlay(canonicalManifest.value.manifest, input.candidateFiles, source, 'execution');
  const workspace = await artifacts.json('workspace', input.payload, 8_388_608);
  const current = stateValue(store.inspect());
  if (current.counts.requests !== attempt.before.requests || current.counts.operations !== attempt.before.operations) refuse('RECOVERY_REQUIRED', '', 'execution');
  stateValue(store.writeCheckpoint(authority, {
    checkpointId,
    expectedRevision: current.revision,
    candidateManifest: canonicalManifest.value.manifest,
    workspace,
    privateSession: null,
    additionalArtifacts: [],
  }));
  const originalManifest = await artifacts.json('native-manifest', canonicalManifest.value.manifest, 32_768);
  const manifest = await artifacts.json('manifest', canonicalManifest.value.manifest, 32_768);
  const submission = input.submissionBytes === null ? null : await artifacts.put('submission', input.submissionBytes, 1_048_576);
  const wrapper = await artifacts.json('role-outcome', {
    version: 1,
    attemptId: attempt.id,
    command: attempt.command,
    roleId: role.roleId,
    nodeId: attempt.nodeId,
    stepId: attempt.nativeStepId,
    sessionId: attempt.sessionId,
    checkpointId,
    originalManifest,
    manifest,
    workspace,
    session: null,
    submission,
    journal: { requestIds: [], operationIds: [] },
  }, 1_048_576);
  return {
    checkpointId,
    outcome: wrapper,
    originalManifest,
    manifest,
    digest: canonicalManifest.value.digest,
    workspace,
    session: null,
    submission,
    artifacts: input.candidateFiles,
  };
}
export async function adoptDelegatedCapture(
  store: LocalRunStore,
  artifacts: ArtifactStore,
  lock: TaskLock,
  role: PlannedRole,
  attempt: ControllerAttempt,
  source: FrozenSource,
): Promise<CapturedRole> {
  const checkpointId = phaseCheckpointId(lock.spec.runId, 'role.' + attempt.ordinal + '.native'), records = journal(store);
  const checkpoint = records.checkpoints.find(item => item.checkpointId === checkpointId);
  if (!checkpoint || checkpoint.additionalArtifacts.length || checkpoint.privateSession !== null || records.view.clockStatus !== 'trusted'
    || records.view.counts.dispatchedRequests || records.view.counts.unresolvedRequests || records.view.counts.unresolvedOperations || records.view.ledger.violations.length
    || checkpoint.counts.requests !== attempt.before.requests || checkpoint.counts.operations !== attempt.before.operations
    || checkpoint.counts.requests !== records.view.counts.requests || checkpoint.counts.operations !== records.view.counts.operations
    || !same(checkpoint.clockBasis, records.view.clock.basis) || attempt.finished !== null) refuse('RECOVERY_REQUIRED', '', 'recovery');
  const workspaceBytes = await artifacts.read(checkpoint.workspace, 8_388_608);
  let raw: unknown;
  try { raw = parsePrivateJson(Buffer.from(workspaceBytes), 8_388_608); } catch { refuse('RECOVERY_REQUIRED', '', 'recovery'); }
  const doc = record(raw, ['format', 'version', 'baseRevision', 'sourceRevision', 'overlay', 'deleted', 'assistantText', 'status', 'reason']);
  const overlayRaw = list(doc.overlay, '', 256);
  const entries: ArtifactRef[] = [];
  for (const item of overlayRaw) {
    const entry = record(item, ['name', 'mode', 'bodyBase64']);
    const bytes = new Uint8Array(Buffer.from(text(entry.bodyBase64, '', 2_097_152), 'base64'));
    const ref = digestArtifact(text(entry.name, '', 4096), bytes);
    if (!ref.ok) refuse('RECOVERY_REQUIRED', '', 'recovery');
    entries.push(ref.value);
  }
  const deleted = list(doc.deleted, '', 4096).map(item => text(item, '', 4096));
  const draftManifest = source.version === 2
    ? { apiVersion: 'loopwright.dev/v1alpha1' as const, kind: 'ArtifactManifest' as const, metadata: { id: 'candidate' }, spec: { baseTree: source.manifest.spec.baseTree!, entries, deleted } }
    : { apiVersion: 'loopwright.dev/v1alpha1' as const, kind: 'ArtifactManifest' as const, metadata: { id: 'candidate' }, spec: { entries } };
  const identified = identifyManifest(draftManifest);
  if (!identified.ok) refuse('RECOVERY_REQUIRED', '', 'recovery');
  const canonicalManifest = identifyManifest(canonicalizeCandidateManifest(identified.value.manifest));
  if (!canonicalManifest.ok) refuse('RECOVERY_REQUIRED', '', 'recovery');
  const bound = bindSubject(lock, canonicalManifest.value.manifest);
  if (!bound.ok || !same(bound.value, checkpoint.subject)) refuse('RECOVERY_REQUIRED', '', 'recovery');
  const decoded = decodeDelegatedWorkspace(workspaceBytes, canonicalManifest.value.manifest, lock, 'recovery');
  assertCanonicalMinimalOverlay(canonicalManifest.value.manifest, decoded.artifacts, source, 'recovery');
  const originalManifest = await artifacts.json('native-manifest', canonicalManifest.value.manifest, 32_768);
  const manifest = await artifacts.json('manifest', canonicalManifest.value.manifest, 32_768);
  const submission = decoded.submission === null ? null : await artifacts.put('submission', decoded.submission, 1_048_576);
  const wrapper = await artifacts.json('role-outcome', {
    version: 1,
    attemptId: attempt.id,
    command: attempt.command,
    roleId: role.roleId,
    nodeId: attempt.nodeId,
    stepId: attempt.nativeStepId,
    sessionId: attempt.sessionId,
    checkpointId,
    originalManifest,
    manifest,
    workspace: checkpoint.workspace,
    session: null,
    submission,
    journal: { requestIds: [], operationIds: [] },
  }, 1_048_576);
  return {
    checkpointId,
    outcome: wrapper,
    originalManifest,
    manifest,
    digest: canonicalManifest.value.digest,
    workspace: checkpoint.workspace,
    session: null,
    submission,
    artifacts: decoded.artifacts,
  };
}
/** Only the production adapter handle can create its native checkpoint; controller checkpoints use a distinct ID. */
export async function captureRole(adapter: PiAdapterV2, store: LocalRunStore, artifacts: ArtifactStore, lock: TaskLock, role: PlannedRole,
  attempt: ControllerAttempt, outcome: PiOutcomeV2, source: FrozenSource): Promise<CapturedRole> {
  const checkpointId = phaseCheckpointId(lock.spec.runId, 'role.' + attempt.ordinal + '.native');
  const mcpBlocked = outcome.status === 'blocked' && outcome.error?.code === 'MCP_AUTHENTICATION_REQUIRED';
  if ((outcome.status !== 'execution_settled' && !mcpBlocked) || outcome.providerTermination !== 'confirmed' || outcome.usage !== 'complete') refuse('RECOVERY_REQUIRED', '', 'execution');
  const captured = await adapter.capture({ checkpointId }); if (!captured.ok) refuse('RECOVERY_REQUIRED', '', 'execution', { piCode: captured.error.code, effect: captured.error.effect });
  const checkpoint = stateValue(store.getCheckpoint(checkpointId));
  if (checkpoint.additionalArtifacts.length || !same(checkpoint.workspace, captured.value.workspace) || !same(checkpoint.privateSession, captured.value.session)) refuse('RECOVERY_REQUIRED', '', 'execution');
  return adoptRoleCapture(store, artifacts, lock, role, attempt, outcome.requestIds, source);
}
/** Adopt an original S02 capture without creating an adapter, dispatch permit, request or replacement native ID. */
export async function adoptRoleCapture(store: LocalRunStore, artifacts: ArtifactStore, lock: TaskLock, role: PlannedRole,
  attempt: ControllerAttempt, expectedRequests: readonly string[] | undefined, source: FrozenSource): Promise<CapturedRole> {
  const checkpointId = phaseCheckpointId(lock.spec.runId, 'role.' + attempt.ordinal + '.native'), records = journal(store);
  const checkpoint = records.checkpoints.find(item => item.checkpointId === checkpointId);
  if (!checkpoint || checkpoint.additionalArtifacts.length || checkpoint.privateSession === null || records.view.clockStatus !== 'trusted'
    || records.view.counts.dispatchedRequests || records.view.counts.unresolvedRequests || records.view.counts.unresolvedOperations || records.view.ledger.violations.length
    || checkpoint.counts.requests !== records.view.counts.requests || checkpoint.counts.operations !== records.view.counts.operations
    || !same(checkpoint.clockBasis, records.view.clock.basis) || attempt.finished !== null) refuse('RECOVERY_REQUIRED', '', 'recovery');
  const requests = records.requests.filter(item => item.sequence > attempt.before.requests && item.sequence <= checkpoint.counts.requests);
  const operations = records.operations.filter(item => item.sequence > attempt.before.operations && item.sequence <= checkpoint.counts.operations);
  for (const item of requests) {
    const observed = item.resolution?.kind === 'terminal_usage' ? item.resolution.observation : item.initialObservation;
    if (item.state !== 'observed' || observed?.termination !== 'confirmed' || observed.outcome === null || item.admission.roleId !== role.roleId
      || item.admission.nodeId !== attempt.nativeStepId || item.admission.purpose !== attempt.purpose || item.admission.repair !== attempt.repair) refuse('RECOVERY_REQUIRED', '', 'recovery');
  }
  const requestIds = requests.map(item => item.admission.requestId), operationIds = operations.map(item => item.intent.operationId);
  const lastRequest = requests.at(-1), lastObservation = lastRequest?.resolution?.kind === 'terminal_usage' ? lastRequest.resolution.observation : lastRequest?.initialObservation;
  if (!requests.length || lastObservation?.outcome !== 'succeeded' || expectedRequests !== undefined && !same(expectedRequests, requestIds)
    || operations.some(item => item.state !== 'confirmed' || item.intent.nodeId !== attempt.nativeStepId || item.intent.effect === 'external_write'
      || item.linkedRequestId !== null && !requestIds.includes(item.linkedRequestId))) refuse('RECOVERY_REQUIRED', '', 'recovery');
  const command = await artifacts.read(attempt.command, 1048576);
  const decoded = await decodePiCapture({ version: 1, lock, policy: role.policy, checkpoint, sessionId: attempt.sessionId, roleId: role.roleId, stepId: attempt.nativeStepId,
    workspace: { ref: checkpoint.workspace, bytes: await artifacts.read(checkpoint.workspace) }, session: { ref: checkpoint.privateSession, bytes: await artifacts.read(checkpoint.privateSession, 67108864) },
    command: attempt.purpose === 'compaction' ? null : { textDigest: hash(command), requestIds } });
  if (!decoded.ok) refuse('RECOVERY_REQUIRED', '', 'execution', { piCode: decoded.error.code });
  const canonicalManifest = identifyManifest(canonicalizeCandidateManifest(decoded.value.candidate));
  if (!canonicalManifest.ok || Buffer.byteLength(canonical(canonicalManifest.value.manifest)) > 32768) refuse('OUTPUT_LIMIT', '', 'execution');
  assertCanonicalMinimalOverlay(canonicalManifest.value.manifest, decoded.value.artifacts, source, 'execution');
  const originalManifest = await artifacts.json('native-manifest', decoded.value.candidate, 32768), manifest = await artifacts.json('manifest', canonicalManifest.value.manifest, 32768);
  const submission = decoded.value.submission === null ? null : await artifacts.put('submission', decoded.value.submission, 1048576);
  const wrapper = await artifacts.json('role-outcome', { version: 1, attemptId: attempt.id, command: attempt.command, roleId: role.roleId, nodeId: attempt.nodeId, stepId: attempt.nativeStepId, sessionId: attempt.sessionId, checkpointId,
    originalManifest, manifest, workspace: checkpoint.workspace, session: checkpoint.privateSession, submission, journal: { requestIds, operationIds } }, 4194304);
  return { checkpointId, outcome: wrapper, originalManifest, manifest, digest: canonicalManifest.value.digest, workspace: checkpoint.workspace, session: checkpoint.privateSession, submission, artifacts: decoded.value.artifacts };
}
