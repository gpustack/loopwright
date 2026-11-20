import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { bindSubject, digestArtifactFromMetadata } from '@loopwright/core';
import { stateValue } from './admission.js';
import { canonical, digest, integer, object } from './boundary.js';
import { resolveCandidateOverlayLimits } from './candidate.js';
import { readBlobChunkAsync, verifyCasSha256DirAsync, verifyRegularFileAsync } from './cas.js';
import { sameIdentity } from './policy.js';
import { snapshotRow, NativeSnapshot } from './snapshot.js';
import { PiFailure, refuse } from './errors.js';
import type { PiCandidateArtifactInput, PiHost, PiOpenInput } from './types.js';
/** Return a view of verified private native bytes, never an executable path or an SDK auto-resume request. */
export async function recoverSnapshot(host: PiHost, input: PiOpenInput): Promise<{ native: Uint8Array; sequence: number } | null> {
  try { return await verifySnapshot(host, input); } catch (error) { if (error instanceof PiFailure) throw new PiFailure({ ...error.detail, phase: 'restore' }); refuse('RECOVERY_REQUIRED', '/restore', { phase: 'restore' }); }
}

async function verifySnapshot(host: PiHost, input: PiOpenInput): Promise<{ native: Uint8Array; sequence: number } | null> {
  if (!input.restore) return null;
  const restore = input.restore, recovered = stateValue(host.store.recoveryView(host.authority, { checkpointId: restore.checkpointId, availableArtifacts: [restore.workspace.ref, restore.session.ref] }), 'restore');
  const checkpoint = recovered.checkpoint, current = recovered.current;
  if ((current.clock.remainingTaskMs.safeValue ?? 0) <= 0) refuse('DEADLINE', '/restore', { phase: 'restore' });
  if (recovered.requiresReconciliation || current.clockStatus !== 'trusted' || !sameIdentity(checkpoint.workspace, restore.workspace.ref) || !sameIdentity(checkpoint.privateSession, restore.session.ref)) refuse('RECOVERY_REQUIRED', '/restore', { phase: 'restore' });
  const overlayLimits = resolveCandidateOverlayLimits(input.lock.spec.contract.spec.budgets.overlay);
  const subject = bindSubject(input.lock, input.candidate.manifest, { overlay: { maxFiles: overlayLimits.maxFiles, maxBytes: overlayLimits.maxBytes } }); if (!subject.ok || !sameIdentity(subject.value, checkpoint.subject)) refuse('BINDING_MISMATCH', '/restore', { phase: 'restore' });
  const session = Buffer.from(restore.session.bytes.buffer, restore.session.bytes.byteOffset, restore.session.bytes.byteLength), newline = session.indexOf(10); if (newline < 0) refuse('RECOVERY_REQUIRED', '/restore/session', { phase: 'restore' });
  const envelope = object(snapshotRow(session.subarray(0, newline)), ['type', 'version', 'binding']);
  const binding = envelope.binding as Record<string, unknown>; const sequence = integer(binding?.sequence, 0, Number.MAX_SAFE_INTEGER);
  const expected = { version: 1, checkpointId: checkpoint.checkpointId, storeId: checkpoint.storeId, runId: checkpoint.runId, lockHash: checkpoint.lockHash, sessionId: input.sessionId, roleId: input.roleId, stepId: input.stepId,
    runtime: input.policy.runtime, policyDigest: digest(Buffer.from(canonical(input.policy))), resourcesDigest: digest(Buffer.from(canonical(input.policy.resources))), candidateDigest: checkpoint.subject.candidateDigest, clockBasis: checkpoint.clockBasis,
    accountingDigest: digest(Buffer.from(canonical({ ledger: checkpoint.ledger, requests: checkpoint.counts.requests, operations: checkpoint.counts.operations }))), sequence };
  if (envelope.type !== 'session_snapshot' || envelope.version !== 1 || !sameIdentity(binding, expected)) refuse('BINDING_MISMATCH', '/restore/session', { phase: 'restore' });
  const native = session.subarray(newline + 1), validator = new NativeSnapshot(input.policy, input.policy.limits.sessionBytes, false); validator.push(native); validator.finish();

  const artifactByName = new Map<string, PiCandidateArtifactInput>(input.candidate.artifacts.map(item => [item.name, item]));
  const workspace = restore.workspace.bytes;
  const bytes = Buffer.from(workspace.buffer, workspace.byteOffset, workspace.byteLength);
  let offset = 0, index = 0, chunk = 0, fileBytes = 0, totalFiles = 0, ended = false, hash = createHash('sha256');
  let active = false;
  let snapshotMode: 'unset' | 'chunk' | 'blob_ref' = 'unset';
  let fileMode: 'none' | 'chunk' | 'blob_ref' = 'none';
  let verifiedSha256Dir: string | null = null;

  while (offset < bytes.length) {
    const end = bytes.indexOf(10, offset); if (end < 0 || ended) refuse('RECOVERY_REQUIRED', '/restore/workspace', { phase: 'restore' });
    const row = snapshotRow(bytes.subarray(offset, end)); offset = end + 1;
    if (index++ === 0) {
      object(row, ['type', 'version', 'binding', 'manifest']);
      if (row.type !== 'workspace_snapshot' || row.version !== 1 || !sameIdentity(row.binding, binding) || !sameIdentity(row.manifest, input.candidate.manifest)) refuse('BINDING_MISMATCH', '/restore/workspace', { phase: 'restore' });
      continue;
    }
    const ref = input.candidate.manifest.spec.entries[totalFiles];
    const artifact = ref ? artifactByName.get(ref.name) ?? null : null;
    if (row.type === 'file') {
      object(row, ['type', 'ref']);
      if (active || !ref || !artifact || !sameIdentity(row.ref, ref)) refuse('RECOVERY_REQUIRED');
      active = true; fileMode = 'none'; hash = createHash('sha256'); fileBytes = 0; chunk = 0;
    } else if (row.type === 'blob_ref') {
      object(row, ['type', 'ref', 'blobRef']);
      if (!active || !ref || !artifact || snapshotMode === 'chunk' || fileMode !== 'none' || !sameIdentity(row.ref, ref)) {
        refuse('RECOVERY_REQUIRED');
      }
      const expectedBlobRef = digestArtifactFromMetadata(ref.name, {
        digest: ref.digest,
        byteLength: ref.byteLength,
        uri: 'cas://sha256/' + ref.digest.hex,
      });
      if (!expectedBlobRef.ok || !sameIdentity(row.blobRef, expectedBlobRef.value)) {
        refuse('RECOVERY_REQUIRED');
      }
      if ('bytes' in artifact) {
        if (artifact.bytes.byteLength !== ref.byteLength || digest(artifact.bytes).hex !== ref.digest.hex) {
          refuse('RESOURCE_MISMATCH');
        }
      } else {
        if (artifact.byteLength !== ref.byteLength || !sameIdentity(artifact.digest, ref.digest)) {
          refuse('RESOURCE_MISMATCH');
        }
      }
      if (verifiedSha256Dir === null) {
        verifiedSha256Dir = await verifyCasSha256DirAsync(host.artifactsDirectory, '/restore/workspace');
      }
      const canonicalBlobPath = join(verifiedSha256Dir, ref.digest.hex);
      await verifyRegularFileAsync(canonicalBlobPath, {
        byteLength: ref.byteLength,
        sha256Hex: ref.digest.hex,
        requireReadOnly: true,
        structuralCode: 'RECOVERY_REQUIRED',
        contentCode: 'RESOURCE_MISMATCH',
        errorPath: '/restore/workspace',
      });
      snapshotMode = 'blob_ref';
      fileMode = 'blob_ref';
      fileBytes = ref.byteLength;
    } else if (row.type === 'chunk') {
      object(row, ['type', 'index', 'data']);
      if (!active || !artifact || snapshotMode === 'blob_ref' || fileMode === 'blob_ref' || row.index !== chunk++ || typeof row.data !== 'string' || row.data.length > 43692) {
        refuse('RECOVERY_REQUIRED');
      }
      snapshotMode = 'chunk';
      fileMode = 'chunk';
      const part = Buffer.from(row.data, 'base64');
      if (part.length === 0 || part.length > 32768 || part.toString('base64') !== row.data) {
        refuse('RESOURCE_MISMATCH');
      }
      if ('bytes' in artifact) {
        if (fileBytes + part.length > artifact.bytes.length || !part.equals(artifact.bytes.subarray(fileBytes, fileBytes + part.length))) {
          refuse('RESOURCE_MISMATCH');
        }
      } else {
        if (fileBytes + part.length > artifact.byteLength) refuse('RESOURCE_MISMATCH');
        const expectedPart = await readBlobChunkAsync(artifact.blobPath, artifact.byteLength, fileBytes, part.length);
        if (!part.equals(expectedPart)) refuse('RESOURCE_MISMATCH');
      }
      fileBytes += part.length;
      hash.update(part);
    } else if (row.type === 'file_end') {
      object(row, ['type', 'byteLength', 'digest']);
      if (!active || !ref || !artifact) refuse('RECOVERY_REQUIRED');
      if (fileMode === 'blob_ref') {
        if (row.byteLength !== ref.byteLength || row.digest !== ref.digest.hex) refuse('RESOURCE_MISMATCH');
      } else if (fileMode === 'chunk') {
        if (row.byteLength !== fileBytes || ref.byteLength !== fileBytes || row.digest !== hash.digest('hex') || row.digest !== ref.digest.hex) {
          refuse('RESOURCE_MISMATCH');
        }
      } else {
        if (snapshotMode === 'blob_ref' || ref.byteLength > 0) refuse('RECOVERY_REQUIRED');
        snapshotMode = 'chunk';
        const artifactLen = 'bytes' in artifact ? artifact.bytes.byteLength : artifact.byteLength;
        if (artifactLen !== 0 || row.byteLength !== 0 || row.digest !== hash.digest('hex') || row.digest !== ref.digest.hex) {
          refuse('RESOURCE_MISMATCH');
        }
      }
      active = false;
      fileMode = 'none';
      totalFiles++;
    } else if (row.type === 'end') {
      object(row, ['type', 'files']);
      if (active || row.files !== totalFiles || totalFiles !== input.candidate.manifest.spec.entries.length) refuse('RECOVERY_REQUIRED');
      ended = true;
    } else {
      refuse('RECOVERY_REQUIRED');
    }
  }
  if (!ended) refuse('RECOVERY_REQUIRED', '/restore/workspace', { phase: 'restore' });
  return { native, sequence };
}
