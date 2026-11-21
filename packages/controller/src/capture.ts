import { decodePiCapture, type PiAdapterV2, type PiOutcomeV2 } from '@loopwright/agent-pi';
import {
  OVERLAY_LIMITS,
  bindSubject,
  digestArtifact,
  digestArtifactFromMetadata,
  identifyManifest,
  isWritablePath,
  type ArtifactManifest,
  type ArtifactRef,
  type TaskContract,
  type TaskLock,
} from '@loopwright/core';
import type { Authority, CheckpointRecord, LocalRunStore } from '@loopwright/state';
import {
  ArtifactStore,
  resolveCanonicalCasBlobPath,
  stateValue,
  streamVerifiedCasBlob,
  type ArtifactReader,
} from './storage.js';
import { canonical, hash, integer, isRecord, list, record, same, text } from './schema.js';
import { parsePrivateJson } from './parser.js';
import { journal, phaseCheckpointId } from './progress.js';
import { formatPolicy } from './repair.js';
import { refuse, type ControllerDiagnostic } from './errors.js';
import {
  assertCanonicalMinimalOverlay,
  canonicalizeCandidateManifest,
  compareUtf16,
  isHostProtectedPath,
  overlayManifestBounds,
  type FrozenSource,
  type HostPathProtectionOptions,
} from './source.js';
import type {
  CandidateFileEntry,
  CasCandidateFile,
  CompiledPlan,
  ControllerAttempt,
  PlannedRole,
  RawCandidateFile,
} from './types.js';

export interface CapturedRole {
  readonly checkpointId: string;
  readonly outcome: ArtifactRef;
  readonly originalManifest: ArtifactRef;
  readonly manifest: ArtifactRef;
  readonly digest: import('@loopwright/core').Digest;
  readonly workspace: ArtifactRef;
  readonly session: ArtifactRef | null;
  readonly submission: ArtifactRef | null;
  readonly artifacts: readonly CandidateFileEntry[];
}

export interface DelegatedCaptureOverlayEntryV1 {
  readonly name: string;
  readonly mode: '100644' | '100755';
  readonly bodyBase64: string;
}

export interface DelegatedCapturePayloadV1 {
  readonly format: 'delegated-capture.v1';
  readonly version: 1;
  readonly baseRevision: string;
  readonly sourceRevision: string;
  readonly overlay: readonly DelegatedCaptureOverlayEntryV1[];
  readonly deleted: readonly string[];
  readonly assistantText: string | null;
  readonly status: 'completed' | 'no_change' | 'failed' | 'blocked';
  readonly reason: string | null;
}

export interface DelegatedCaptureOverlayEntryV2 {
  readonly name: string;
  readonly mode: '100644' | '100755';
  readonly sha256: string;
  readonly byteLength: number;
  readonly blobRef: ArtifactRef;
}

export interface DelegatedCapturePayloadV2 {
  readonly format: 'delegated-capture.v2';
  readonly version: 2;
  readonly baseRevision: string;
  readonly sourceRevision: string;
  readonly overlay: readonly DelegatedCaptureOverlayEntryV2[];
  readonly deleted: readonly string[];
  readonly assistantText: string | null;
  readonly status: 'completed' | 'no_change' | 'failed' | 'blocked';
  readonly reason: string | null;
}

export type DelegatedCapturePayload = DelegatedCapturePayloadV1 | DelegatedCapturePayloadV2;

export function nativeSessionId(runId: string, roleId: string, stepId: string, policy: PlannedRole['policy'], reworkEpoch = 0): string {
  const payload = reworkEpoch > 0 ? { runId, roleId, stepId, policy, reworkEpoch } : { runId, roleId, stepId, policy };
  return 'session.' + hash('loopwright.dev/controller/session/v1\0' + canonical(payload)).hex.slice(0, 40);
}

function parseValidatedV2OverlayEntry(
  item: unknown,
  maxFileBytes: number,
  fail: () => never,
): { readonly overlayEntry: DelegatedCaptureOverlayEntryV2; readonly manifestEntry: ArtifactRef } {
  let entry: Record<string, unknown>;
  try {
    entry = record(item, ['name', 'mode', 'sha256', 'byteLength', 'blobRef']);
  } catch {
    return fail();
  }
  const name = text(entry.name, '', 4096);
  const mode = text(entry.mode);
  const sha256 = text(entry.sha256, '', 64);
  if (
    (mode !== '100644' && mode !== '100755') ||
    !/^[0-9a-f]{64}$/.test(sha256) ||
    typeof entry.byteLength !== 'number' ||
    !Number.isSafeInteger(entry.byteLength) ||
    Object.is(entry.byteLength, -0) ||
    entry.byteLength < 0 ||
    entry.byteLength > Math.min(maxFileBytes, OVERLAY_LIMITS.maxMaxBytes) ||
    !isRecord(entry.blobRef)
  ) {
    return fail();
  }
  const byteLength = integer(entry.byteLength, 0, Math.min(maxFileBytes, OVERLAY_LIMITS.maxMaxBytes));
  const expectedUri = 'cas://sha256/' + sha256;
  const expectedBlobRef = digestArtifactFromMetadata(name, {
    digest: { algorithm: 'sha256', hex: sha256 },
    byteLength,
    uri: expectedUri,
  });
  const expectedManifestEntry = digestArtifactFromMetadata(name, {
    digest: { algorithm: 'sha256', hex: sha256 },
    byteLength,
  });
  if (
    !expectedBlobRef.ok ||
    !expectedManifestEntry.ok ||
    !same(entry.blobRef, expectedBlobRef.value)
  ) {
    return fail();
  }
  return {
    overlayEntry: {
      name,
      mode,
      sha256,
      byteLength,
      blobRef: expectedBlobRef.value,
    },
    manifestEntry: expectedManifestEntry.value,
  };
}

export async function decodeDelegatedWorkspace(
  workspaceBytes: Uint8Array,
  expectedManifest: ArtifactManifest,
  lock: TaskLock,
  phase: ControllerDiagnostic['phase'] = 'recovery',
  artifactsDirectory?: string,
): Promise<{
  readonly candidate: ArtifactManifest;
  readonly artifacts: readonly CandidateFileEntry[];
  readonly submission: Uint8Array | null;
  readonly payload: DelegatedCapturePayload;
}> {
  const fail = (): never => refuse(phase === 'inspection' ? 'ARTIFACT_INVALID' : 'RECOVERY_REQUIRED', '', phase);
  const bounds = overlayManifestBounds(lock.spec.contract.spec.budgets.overlay);
  const maxJsonBytes = Math.max(bounds.v2WorkspaceJsonMaxBytes, bounds.workspaceMaxBytes);
  if (workspaceBytes.byteLength > maxJsonBytes) return fail();
  let raw: unknown;
  try {
    raw = parsePrivateJson(Buffer.from(workspaceBytes), maxJsonBytes, bounds.collectionLimit);
  } catch {
    return fail();
  }
  let doc: Record<string, unknown>;
  try {
    doc = record(raw, ['format', 'version', 'baseRevision', 'sourceRevision', 'overlay', 'deleted', 'assistantText', 'status', 'reason']);
  } catch {
    return fail();
  }
  if (
    text(doc.baseRevision) !== lock.spec.contract.spec.target.baseRevision ||
    text(doc.sourceRevision) !== lock.spec.contract.spec.target.sourceRevision ||
    !['completed', 'no_change', 'failed', 'blocked'].includes(text(doc.status)) ||
    (doc.reason !== null && typeof doc.reason !== 'string') ||
    (doc.assistantText !== null && typeof doc.assistantText !== 'string')
  ) {
    return fail();
  }
  const deleted = list(doc.deleted, '', bounds.maxFiles).map(item => text(item, '', 4096));
  if (!same([...deleted].sort(compareUtf16), deleted) || new Set(deleted).size !== deleted.length) return fail();

  if (doc.format === 'delegated-capture.v2' && doc.version === 2) {
    if (workspaceBytes.byteLength > bounds.v2WorkspaceJsonMaxBytes || !artifactsDirectory) return fail();
    const overlayRaw = list(doc.overlay, '', bounds.maxFiles);
    const overlay: DelegatedCaptureOverlayEntryV2[] = [];
    const artifacts: CasCandidateFile[] = [];
    const entries: ArtifactRef[] = [];
    let totalBytes = 0;
    for (const item of overlayRaw) {
      const { overlayEntry, manifestEntry } = parseValidatedV2OverlayEntry(item, bounds.perFileMaxBytes, fail);
      if ((totalBytes += overlayEntry.byteLength) > bounds.maxBytes) return fail();
      let blobPath: string;
      try {
        blobPath = await resolveCanonicalCasBlobPath(artifactsDirectory, overlayEntry.sha256, undefined, phase);
        await streamVerifiedCasBlob(
          artifactsDirectory,
          {
            name: overlayEntry.name,
            sha256: overlayEntry.sha256,
            byteLength: overlayEntry.byteLength,
            uri: 'cas://sha256/' + overlayEntry.sha256,
            path: blobPath,
            blobRef: overlayEntry.blobRef,
          },
          undefined,
          phase,
        );
      } catch {
        return fail();
      }
      overlay.push(overlayEntry);
      artifacts.push({
        name: overlayEntry.name,
        byteLength: overlayEntry.byteLength,
        digest: manifestEntry.digest,
        blobPath,
        mode: overlayEntry.mode,
      });
      entries.push(manifestEntry);
    }
    if (!same([...overlay.map(o => o.name)].sort(compareUtf16), overlay.map(o => o.name)) || new Set(overlay.map(o => o.name)).size !== overlay.length) {
      return fail();
    }
    const draftManifest = expectedManifest.spec.baseTree !== undefined
      ? { apiVersion: 'loopwright.dev/v1alpha1' as const, kind: 'ArtifactManifest' as const, metadata: { id: 'candidate' }, spec: { baseTree: expectedManifest.spec.baseTree, entries, deleted } }
      : { apiVersion: 'loopwright.dev/v1alpha1' as const, kind: 'ArtifactManifest' as const, metadata: { id: 'candidate' }, spec: { entries } };
    const identified = identifyManifest(draftManifest, bounds.options);
    if (!identified.ok || !same(canonicalizeCandidateManifest(identified.value.manifest), expectedManifest)) return fail();
    const assistantText = doc.assistantText as string | null;
    const submission = assistantText === null ? null : new Uint8Array(Buffer.from(assistantText, 'utf8'));
    return {
      candidate: identified.value.manifest,
      artifacts,
      submission,
      payload: {
        format: 'delegated-capture.v2',
        version: 2,
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

  if (doc.format !== 'delegated-capture.v1' || doc.version !== 1 || workspaceBytes.byteLength > bounds.workspaceMaxBytes) {
    return fail();
  }
  const overlayRaw = list(doc.overlay, '', bounds.maxFiles);
  const maxBase64Length = Math.min(100_663_296, Math.ceil((bounds.perFileMaxBytes * 4) / 3) + 4);
  const overlay: DelegatedCaptureOverlayEntryV1[] = [];
  const artifacts: RawCandidateFile[] = [];
  const entries: ArtifactRef[] = [];
  let totalBytes = 0;
  for (const item of overlayRaw) {
    let entry: Record<string, unknown>;
    try {
      entry = record(item, ['name', 'mode', 'bodyBase64']);
    } catch {
      return fail();
    }
    const name = text(entry.name, '', 4096), mode = text(entry.mode), bodyBase64 = text(entry.bodyBase64, '', maxBase64Length);
    if (mode !== '100644' && mode !== '100755') return fail();
    const bytes = new Uint8Array(Buffer.from(bodyBase64, 'base64'));
    if (Buffer.from(bytes).toString('base64') !== bodyBase64 || bytes.byteLength > bounds.perFileMaxBytes || (totalBytes += bytes.byteLength) > bounds.maxBytes) return fail();
    const ref = digestArtifact(name, bytes);
    if (!ref.ok) return fail();
    overlay.push({ name, mode, bodyBase64 });
    artifacts.push({ name, bytes, mode });
    entries.push(ref.value);
  }
  if (!same([...overlay.map(o => o.name)].sort(compareUtf16), overlay.map(o => o.name)) || new Set(overlay.map(o => o.name)).size !== overlay.length) return fail();
  const draftManifest = expectedManifest.spec.baseTree !== undefined
    ? { apiVersion: 'loopwright.dev/v1alpha1' as const, kind: 'ArtifactManifest' as const, metadata: { id: 'candidate' }, spec: { baseTree: expectedManifest.spec.baseTree, entries, deleted } }
    : { apiVersion: 'loopwright.dev/v1alpha1' as const, kind: 'ArtifactManifest' as const, metadata: { id: 'candidate' }, spec: { entries } };
  const identified = identifyManifest(draftManifest, bounds.options);
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

async function assertCandidateArtifactsClean(
  artifacts: ArtifactStore,
  entries: readonly CandidateFileEntry[],
  phase: ControllerDiagnostic['phase'],
): Promise<void> {
  for (const entry of entries) {
    if ('bytes' in entry) {
      artifacts.vault.assertClean(entry.bytes);
    } else {
      const checker = artifacts.vault.createStreamChecker();
      try {
        await streamVerifiedCasBlob(
          artifacts.directory,
          {
            name: entry.name,
            sha256: entry.digest.hex,
            byteLength: entry.byteLength,
            uri: 'cas://sha256/' + entry.digest.hex,
            path: entry.blobPath,
          },
          chunk => {
            checker.push(chunk);
          },
          phase,
        );
        checker.finish();
      } finally {
        checker.finish();
      }
    }
  }
}

export async function decodeCandidateCapture(input: {
  readonly artifacts: ArtifactReader;
  readonly artifactsDirectory?: string;
  readonly source?: FrozenSource;
  readonly lock: TaskLock;
  readonly plan: CompiledPlan;
  readonly checkpoint: CheckpointRecord;
  readonly attempt: ControllerAttempt;
  readonly expectedManifest: ArtifactManifest;
  readonly requestIds: readonly string[];
  readonly phase: ControllerDiagnostic['phase'];
}): Promise<{
  readonly candidate: ArtifactManifest;
  readonly artifacts: readonly CandidateFileEntry[];
  readonly submission: Uint8Array | null;
  readonly delegatedPayload?: DelegatedCapturePayload;
}> {
  const { artifacts, lock, plan, checkpoint, attempt, expectedManifest, requestIds, phase } = input;
  const effectiveArtifactsDir = artifacts instanceof ArtifactStore ? artifacts.directory : input.artifactsDirectory;
  const bounds = overlayManifestBounds(lock.spec.contract.spec.budgets.overlay);
  const maxWsBytes = Math.max(8_388_608, bounds.v2WorkspaceJsonMaxBytes, bounds.workspaceMaxBytes);
  const workspaceBytes = await artifacts.read(checkpoint.workspace, maxWsBytes);
  let peek: unknown = null;
  if (workspaceBytes.byteLength <= maxWsBytes) {
    try { peek = parsePrivateJson(Buffer.from(workspaceBytes), maxWsBytes, bounds.collectionLimit); } catch { peek = null; }
  }
  if (
    isRecord(peek) &&
    (peek.format === 'delegated-capture.v1' || peek.format === 'delegated-capture.v2')
  ) {
    const decoded = await decodeDelegatedWorkspace(workspaceBytes, expectedManifest, lock, phase, effectiveArtifactsDir);
    if (artifacts instanceof ArtifactStore) {
      await assertCandidateArtifactsClean(artifacts, decoded.artifacts, phase);
    }
    return {
      candidate: decoded.candidate,
      artifacts: decoded.artifacts,
      submission: decoded.submission,
      delegatedPayload: decoded.payload,
    };
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
    ...(effectiveArtifactsDir !== undefined ? { artifactsDirectory: effectiveArtifactsDir } : {}),
    includeArtifactBytes: false,
  });
  if (!decoded.ok || !same(canonicalizeCandidateManifest(decoded.value.candidate), expectedManifest)) {
    refuse(phase === 'inspection' ? 'ARTIFACT_INVALID' : 'RECOVERY_REQUIRED', '', phase);
  }
  const baselineModes: ReadonlyMap<string, '100644' | '100755'> | undefined =
    input.source && input.source.version === 2
      ? new Map((input.source.baselineEntries ?? []).map(e => [e.name, e.mode]))
      : undefined;
  const rawCandidateArtifacts: readonly CandidateFileEntry[] =
    decoded.value.blobArtifacts.length > 0 ? decoded.value.blobArtifacts : decoded.value.artifacts;
  const candidateArtifacts: readonly CandidateFileEntry[] =
    baselineModes !== undefined
      ? rawCandidateArtifacts.map(item => {
          const baseMode = baselineModes.get(item.name);
          return baseMode === '100755' ? { ...item, mode: '100755' as const } : item;
        })
      : input.source?.version === 1
        ? rawCandidateArtifacts.map(item => ({ ...item, mode: '100644' as const }))
        : rawCandidateArtifacts;
  if (artifacts instanceof ArtifactStore) {
    await assertCandidateArtifactsClean(artifacts, candidateArtifacts, phase);
  }
  return {
    candidate: decoded.value.candidate,
    artifacts: candidateArtifacts,
    submission: decoded.value.submission,
  };
}

function assertNoUnauthorizedModeMutations(
  candidateFiles: readonly CandidateFileEntry[],
  overlayEntries: readonly { readonly name: string; readonly mode: '100644' | '100755' }[],
  source: FrozenSource,
  task: TaskContract,
  hostProtection: boolean | HostPathProtectionOptions,
  phase: ControllerDiagnostic['phase'],
): void {
  const baselineModeByPath = new Map<string, '100644' | '100755'>(
    source.version === 2
      ? (source.baselineEntries ?? []).map(entry => [entry.name, entry.mode])
      : source.artifacts.map(entry => [entry.name, entry.mode ?? '100644']),
  );
  const overlayModeByPath = new Map<string, '100644' | '100755'>(
    overlayEntries.map(entry => [entry.name, entry.mode]),
  );
  for (const file of candidateFiles) {
    const fileMode = (!('bytes' in file) ? file.mode : undefined) ?? overlayModeByPath.get(file.name);
    const baselineMode = baselineModeByPath.get(file.name);
    if (fileMode !== undefined && baselineMode !== undefined && fileMode !== baselineMode) {
      if (isHostProtectedPath(file.name, hostProtection)) {
        refuse('ARTIFACT_INVALID', '', phase);
      }
      const writable = isWritablePath(task, file.name);
      if (!writable.ok || !writable.value) {
        refuse('ARTIFACT_INVALID', '', phase);
      }
    }
  }
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
    readonly candidateFiles: readonly CandidateFileEntry[];
    readonly payload: DelegatedCapturePayload;
    readonly submissionBytes: Uint8Array | null;
  },
  hostProtection: boolean | HostPathProtectionOptions = false,
): Promise<CapturedRole> {
  const bounds = overlayManifestBounds(lock.spec.contract.spec.budgets.overlay);
  const checkpointId = phaseCheckpointId(lock.spec.runId, 'role.' + attempt.ordinal + '.native');
  const canonicalManifest = identifyManifest(canonicalizeCandidateManifest(input.candidateManifest), bounds.options);
  if (!canonicalManifest.ok || Buffer.byteLength(canonical(canonicalManifest.value.manifest)) > bounds.manifestMaxBytes) refuse('OUTPUT_LIMIT', '', 'execution');
  await assertCanonicalMinimalOverlay(canonicalManifest.value.manifest, input.candidateFiles, source, 'execution');
  assertNoHostProtectedMutations(canonicalManifest.value.manifest, input.candidateFiles, source, hostProtection, 'execution');
  assertNoUnauthorizedModeMutations(input.candidateFiles, input.payload.overlay, source, lock.spec.contract, hostProtection, 'execution');
  const wsMaxBytes = input.payload.version === 2 ? bounds.v2WorkspaceJsonMaxBytes : bounds.workspaceMaxBytes;
  const workspace = await artifacts.json('workspace', input.payload, wsMaxBytes);
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
  const originalManifest = await artifacts.json('native-manifest', canonicalManifest.value.manifest, bounds.manifestMaxBytes);
  const manifest = await artifacts.json('manifest', canonicalManifest.value.manifest, bounds.manifestMaxBytes);
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
  hostProtection: boolean | HostPathProtectionOptions = false,
): Promise<CapturedRole> {
  const checkpointId = phaseCheckpointId(lock.spec.runId, 'role.' + attempt.ordinal + '.native'), records = journal(store);
  const checkpoint = records.checkpoints.find(item => item.checkpointId === checkpointId);
  if (!checkpoint || checkpoint.additionalArtifacts.length || checkpoint.privateSession !== null || records.view.clockStatus !== 'trusted'
    || records.view.counts.dispatchedRequests || records.view.counts.unresolvedRequests || records.view.counts.unresolvedOperations || records.view.ledger.violations.length
    || checkpoint.counts.requests !== attempt.before.requests || checkpoint.counts.operations !== attempt.before.operations
    || checkpoint.counts.requests !== records.view.counts.requests || checkpoint.counts.operations !== records.view.counts.operations
    || !same(checkpoint.clockBasis, records.view.clock.basis) || attempt.finished !== null) refuse('RECOVERY_REQUIRED', '', 'recovery');
  const bounds = overlayManifestBounds(lock.spec.contract.spec.budgets.overlay);
  const maxWsBytes = Math.max(8_388_608, bounds.v2WorkspaceJsonMaxBytes, bounds.workspaceMaxBytes);
  const workspaceBytes = await artifacts.read(checkpoint.workspace, maxWsBytes);
  let raw: unknown;
  try { raw = parsePrivateJson(Buffer.from(workspaceBytes), maxWsBytes, bounds.collectionLimit); } catch { refuse('RECOVERY_REQUIRED', '', 'recovery'); }
  const doc = record(raw, ['format', 'version', 'baseRevision', 'sourceRevision', 'overlay', 'deleted', 'assistantText', 'status', 'reason']);
  const overlayRaw = list(doc.overlay, '', bounds.maxFiles);
  const entries: ArtifactRef[] = [];
  if (doc.format === 'delegated-capture.v2' && doc.version === 2) {
    if (workspaceBytes.byteLength > bounds.v2WorkspaceJsonMaxBytes) refuse('RECOVERY_REQUIRED', '', 'recovery');
    for (const item of overlayRaw) {
      const parsed = parseValidatedV2OverlayEntry(item, bounds.perFileMaxBytes, () => refuse('RECOVERY_REQUIRED', '', 'recovery'));
      entries.push(parsed.manifestEntry);
    }
  } else if (doc.format === 'delegated-capture.v1' && doc.version === 1) {
    if (workspaceBytes.byteLength > bounds.workspaceMaxBytes) refuse('RECOVERY_REQUIRED', '', 'recovery');
    const maxBase64Length = Math.min(100_663_296, Math.ceil((bounds.perFileMaxBytes * 4) / 3) + 4);
    for (const item of overlayRaw) {
      const entry = record(item, ['name', 'mode', 'bodyBase64']);
      const bytes = new Uint8Array(Buffer.from(text(entry.bodyBase64, '', maxBase64Length), 'base64'));
      if (bytes.byteLength > bounds.perFileMaxBytes) refuse('RECOVERY_REQUIRED', '', 'recovery');
      const ref = digestArtifact(text(entry.name, '', 4096), bytes);
      if (!ref.ok) refuse('RECOVERY_REQUIRED', '', 'recovery');
      entries.push(ref.value);
    }
  } else {
    refuse('RECOVERY_REQUIRED', '', 'recovery');
  }
  const deleted = list(doc.deleted, '', bounds.maxFiles).map(item => text(item, '', 4096));
  const draftManifest = source.version === 2
    ? { apiVersion: 'loopwright.dev/v1alpha1' as const, kind: 'ArtifactManifest' as const, metadata: { id: 'candidate' }, spec: { baseTree: source.manifest.spec.baseTree!, entries, deleted } }
    : { apiVersion: 'loopwright.dev/v1alpha1' as const, kind: 'ArtifactManifest' as const, metadata: { id: 'candidate' }, spec: { entries } };
  const identified = identifyManifest(draftManifest, bounds.options);
  if (!identified.ok) refuse('RECOVERY_REQUIRED', '', 'recovery');
  const canonicalManifest = identifyManifest(canonicalizeCandidateManifest(identified.value.manifest), bounds.options);
  if (!canonicalManifest.ok) refuse('RECOVERY_REQUIRED', '', 'recovery');
  const bound = bindSubject(lock, canonicalManifest.value.manifest, bounds.options);
  if (!bound.ok || !same(bound.value, checkpoint.subject)) refuse('RECOVERY_REQUIRED', '', 'recovery');
  const decoded = await decodeDelegatedWorkspace(workspaceBytes, canonicalManifest.value.manifest, lock, 'recovery', artifacts.directory);
  await assertCandidateArtifactsClean(artifacts, decoded.artifacts, 'recovery');
  await assertCanonicalMinimalOverlay(canonicalManifest.value.manifest, decoded.artifacts, source, 'recovery');
  assertNoHostProtectedMutations(canonicalManifest.value.manifest, decoded.artifacts, source, hostProtection, 'recovery');
  assertNoUnauthorizedModeMutations(decoded.artifacts, decoded.payload.overlay, source, lock.spec.contract, hostProtection, 'recovery');
  const originalManifest = await artifacts.json('native-manifest', canonicalManifest.value.manifest, bounds.manifestMaxBytes);
  const manifest = await artifacts.json('manifest', canonicalManifest.value.manifest, bounds.manifestMaxBytes);
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

export function assertNoHostProtectedMutations(
  manifest: ArtifactManifest,
  files: readonly CandidateFileEntry[],
  source: FrozenSource,
  hostProtection: boolean | HostPathProtectionOptions,
  phase: ControllerDiagnostic['phase'] = 'execution',
): void {
  const code: ControllerDiagnostic['code'] = 'ARTIFACT_INVALID';
  for (const deletedPath of manifest.spec.deleted ?? []) {
    if (isHostProtectedPath(deletedPath, hostProtection)) {
      refuse(code, '', phase);
    }
  }
  if (source.version === 2) {
    for (const file of files) {
      if (isHostProtectedPath(file.name, hostProtection)) {
        refuse(code, '', phase);
      }
    }
    return;
  }
  const baselineByPath = new Map(
    source.artifacts.map(item => [item.name, { bytes: item.bytes, mode: item.mode ?? ('100644' as const) }]),
  );
  const present = new Set<string>();
  for (const file of files) {
    present.add(file.name);
    const baseEntry = baselineByPath.get(file.name);
    const bytesChangedOrAdded =
      baseEntry === undefined
        ? true
        : 'bytes' in file
          ? !Buffer.from(baseEntry.bytes).equals(Buffer.from(file.bytes))
          : baseEntry.bytes.byteLength !== file.byteLength || hash(baseEntry.bytes).hex !== file.digest.hex;
    const modeChanged =
      baseEntry !== undefined && !('bytes' in file) && file.mode !== undefined && file.mode !== baseEntry.mode;
    if ((bytesChangedOrAdded || modeChanged) && isHostProtectedPath(file.name, hostProtection)) {
      refuse(code, '', phase);
    }
  }
  for (const base of source.artifacts) {
    if (!present.has(base.name) && isHostProtectedPath(base.name, hostProtection)) {
      refuse(code, '', phase);
    }
  }
}

/** Only the production adapter handle can create its native checkpoint; controller checkpoints use a distinct ID. */
export async function captureRole(
  adapter: PiAdapterV2,
  store: LocalRunStore,
  artifacts: ArtifactStore,
  lock: TaskLock,
  role: PlannedRole,
  attempt: ControllerAttempt,
  outcome: PiOutcomeV2,
  source: FrozenSource,
  hostProtection: boolean | HostPathProtectionOptions = false,
): Promise<CapturedRole> {
  const checkpointId = phaseCheckpointId(lock.spec.runId, 'role.' + attempt.ordinal + '.native');
  const mcpBlocked = outcome.status === 'blocked' && outcome.error?.code === 'MCP_AUTHENTICATION_REQUIRED';
  if ((outcome.status !== 'execution_settled' && !mcpBlocked) || outcome.providerTermination !== 'confirmed' || outcome.usage !== 'complete') refuse('RECOVERY_REQUIRED', '', 'execution');
  const captured = await adapter.capture({ checkpointId }); if (!captured.ok) refuse('RECOVERY_REQUIRED', '', 'execution', { piCode: captured.error.code, effect: captured.error.effect });
  const checkpoint = stateValue(store.getCheckpoint(checkpointId));
  if (checkpoint.additionalArtifacts.length || !same(checkpoint.workspace, captured.value.workspace) || !same(checkpoint.privateSession, captured.value.session)) refuse('RECOVERY_REQUIRED', '', 'execution');
  return adoptRoleCapture(store, artifacts, lock, role, attempt, outcome.requestIds, source, hostProtection);
}

/** Adopt an original S02 capture without creating an adapter, dispatch permit, request or replacement native ID. */
export async function adoptRoleCapture(
  store: LocalRunStore,
  artifacts: ArtifactStore,
  lock: TaskLock,
  role: PlannedRole,
  attempt: ControllerAttempt,
  expectedRequests: readonly string[] | undefined,
  source: FrozenSource,
  hostProtection: boolean | HostPathProtectionOptions = false,
): Promise<CapturedRole> {
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
  const bounds = overlayManifestBounds(lock.spec.contract.spec.budgets.overlay);
  const decoded = await decodePiCapture({
    version: 1,
    lock,
    policy: role.policy,
    checkpoint,
    sessionId: attempt.sessionId,
    roleId: role.roleId,
    stepId: attempt.nativeStepId,
    workspace: { ref: checkpoint.workspace, bytes: await artifacts.read(checkpoint.workspace, Math.max(8_388_608, bounds.v2WorkspaceJsonMaxBytes, bounds.workspaceMaxBytes)) },
    session: { ref: checkpoint.privateSession, bytes: await artifacts.read(checkpoint.privateSession, 67108864) },
    command: attempt.purpose === 'compaction' ? null : { textDigest: hash(command), requestIds },
    artifactsDirectory: artifacts.directory,
    includeArtifactBytes: false,
  });
  if (!decoded.ok) refuse('RECOVERY_REQUIRED', '', 'execution', { piCode: decoded.error.code });
  const canonicalManifest = identifyManifest(canonicalizeCandidateManifest(decoded.value.candidate), bounds.options);
  if (!canonicalManifest.ok || Buffer.byteLength(canonical(canonicalManifest.value.manifest)) > bounds.manifestMaxBytes) refuse('OUTPUT_LIMIT', '', 'execution');
  const baselineModes =
    source.version === 2
      ? new Map<string, '100644' | '100755'>((source.baselineEntries ?? []).map(e => [e.name, e.mode]))
      : undefined;
  const rawCandidateArtifacts: readonly CandidateFileEntry[] =
    decoded.value.blobArtifacts.length > 0 ? decoded.value.blobArtifacts : decoded.value.artifacts;
  const candidateArtifacts: readonly CandidateFileEntry[] =
    baselineModes !== undefined
      ? rawCandidateArtifacts.map(item =>
          baselineModes.get(item.name) === '100755' ? { ...item, mode: '100755' as const } : item,
        )
      : rawCandidateArtifacts.map(item => ({ ...item, mode: '100644' as const }));
  await assertCandidateArtifactsClean(artifacts, candidateArtifacts, 'execution');
  await assertCanonicalMinimalOverlay(canonicalManifest.value.manifest, candidateArtifacts, source, 'execution');
  assertNoHostProtectedMutations(canonicalManifest.value.manifest, candidateArtifacts, source, hostProtection);
  const originalManifest = await artifacts.json('native-manifest', decoded.value.candidate, bounds.manifestMaxBytes), manifest = await artifacts.json('manifest', canonicalManifest.value.manifest, bounds.manifestMaxBytes);
  const submission = decoded.value.submission === null ? null : await artifacts.put('submission', decoded.value.submission, 1048576);
  const wrapper = await artifacts.json('role-outcome', { version: 1, attemptId: attempt.id, command: attempt.command, roleId: role.roleId, nodeId: attempt.nodeId, stepId: attempt.nativeStepId, sessionId: attempt.sessionId, checkpointId,
    originalManifest, manifest, workspace: checkpoint.workspace, session: checkpoint.privateSession, submission, journal: { requestIds, operationIds } }, 4194304);
  return { checkpointId, outcome: wrapper, originalManifest, manifest, digest: canonicalManifest.value.digest, workspace: checkpoint.workspace, session: checkpoint.privateSession, submission, artifacts: candidateArtifacts };
}
