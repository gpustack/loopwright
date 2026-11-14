import { decodePiCapture, type PiAdapterV2, type PiOutcomeV2 } from '@loopwright/agent-pi';
import { identifyManifest, type ArtifactRef, type TaskLock } from '@loopwright/core';
import type { LocalRunStore } from '@loopwright/state';
import { stateValue, type ArtifactStore } from './storage.js';
import { canonical, hash, same } from './schema.js';
import { journal, phaseCheckpointId } from './progress.js';
import { refuse } from './errors.js';
import { assertCanonicalMinimalOverlay, canonicalizeCandidateManifest, type FrozenSource } from './source.js';
import type { ControllerAttempt, PlannedRole } from './types.js';
export interface CapturedRole {
  readonly checkpointId: string; readonly outcome: ArtifactRef; readonly originalManifest: ArtifactRef;
  readonly manifest: ArtifactRef; readonly digest: import('@loopwright/core').Digest;
  readonly workspace: ArtifactRef; readonly session: ArtifactRef; readonly submission: ArtifactRef | null;
  readonly artifacts: readonly { readonly name: string; readonly bytes: Uint8Array }[];
}
export function nativeSessionId(runId: string, roleId: string, stepId: string, policy: PlannedRole['policy']): string {
  return 'session.' + hash('loopwright.dev/controller/session/v1\0' + canonical({ runId, roleId, stepId, policy })).hex.slice(0, 40);
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
  const command = await artifacts.read(attempt.command, 16384);
  const decoded = await decodePiCapture({ version: 1, lock, policy: role.policy, checkpoint, sessionId: attempt.sessionId, roleId: role.roleId, stepId: attempt.nativeStepId,
    workspace: { ref: checkpoint.workspace, bytes: await artifacts.read(checkpoint.workspace) }, session: { ref: checkpoint.privateSession, bytes: await artifacts.read(checkpoint.privateSession, 2097152) },
    command: attempt.purpose === 'compaction' ? null : { textDigest: hash(command), requestIds } });
  if (!decoded.ok) refuse('RECOVERY_REQUIRED', '', 'execution', { piCode: decoded.error.code });
  const canonicalManifest = identifyManifest(canonicalizeCandidateManifest(decoded.value.candidate));
  if (!canonicalManifest.ok || Buffer.byteLength(canonical(canonicalManifest.value.manifest)) > 32768) refuse('OUTPUT_LIMIT', '', 'execution');
  assertCanonicalMinimalOverlay(canonicalManifest.value.manifest, decoded.value.artifacts, source, 'execution');
  const originalManifest = await artifacts.json('native-manifest', decoded.value.candidate, 32768), manifest = await artifacts.json('manifest', canonicalManifest.value.manifest, 32768);
  const submission = decoded.value.submission === null ? null : await artifacts.put('submission', decoded.value.submission, 1048576);
  const wrapper = await artifacts.json('role-outcome', { version: 1, attemptId: attempt.id, command: attempt.command, roleId: role.roleId, nodeId: attempt.nodeId, stepId: attempt.nativeStepId, sessionId: attempt.sessionId, checkpointId,
    originalManifest, manifest, workspace: checkpoint.workspace, session: checkpoint.privateSession, submission, journal: { requestIds, operationIds } }, 1048576);
  return { checkpointId, outcome: wrapper, originalManifest, manifest, digest: canonicalManifest.value.digest, workspace: checkpoint.workspace, session: checkpoint.privateSession, submission, artifacts: decoded.value.artifacts };
}
