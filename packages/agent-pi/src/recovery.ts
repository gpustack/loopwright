import { createHash } from 'node:crypto';
import { bindSubject } from '@loopwright/core';
import { stateValue } from './admission.js';
import { canonical, digest, integer, object } from './boundary.js';
import { sameIdentity } from './policy.js';
import { snapshotRow, NativeSnapshot } from './snapshot.js';
import { PiFailure, refuse } from './errors.js';
import type { PiHost, PiOpenInput } from './types.js';
/** Return a view of verified private native bytes, never an executable path or an SDK auto-resume request. */
export function recoverSnapshot(host: PiHost, input: PiOpenInput): { native: Uint8Array; sequence: number } | null {
  try { return verifySnapshot(host, input); } catch (error) { if (error instanceof PiFailure) throw new PiFailure({ ...error.detail, phase: 'restore' }); refuse('RECOVERY_REQUIRED', '/restore', { phase: 'restore' }); }
}
function verifySnapshot(host: PiHost, input: PiOpenInput): { native: Uint8Array; sequence: number } | null {
  if (!input.restore) return null;
  const restore = input.restore, recovered = stateValue(host.store.recoveryView(host.authority, { checkpointId: restore.checkpointId, availableArtifacts: [restore.workspace.ref, restore.session.ref] }), 'restore');
  const checkpoint = recovered.checkpoint, current = recovered.current;
  if ((current.clock.remainingTaskMs.safeValue ?? 0) <= 0) refuse('DEADLINE', '/restore', { phase: 'restore' });
  if (recovered.requiresReconciliation || current.clockStatus !== 'trusted' || !sameIdentity(checkpoint.workspace, restore.workspace.ref) || !sameIdentity(checkpoint.privateSession, restore.session.ref)) refuse('RECOVERY_REQUIRED', '/restore', { phase: 'restore' });
  const subject = bindSubject(input.lock, input.candidate.manifest); if (!subject.ok || !sameIdentity(subject.value, checkpoint.subject)) refuse('BINDING_MISMATCH', '/restore', { phase: 'restore' });
  const session = Buffer.from(restore.session.bytes.buffer, restore.session.bytes.byteOffset, restore.session.bytes.byteLength), newline = session.indexOf(10); if (newline < 0) refuse('RECOVERY_REQUIRED', '/restore/session', { phase: 'restore' });
  const envelope = object(snapshotRow(session.subarray(0, newline)), ['type', 'version', 'binding']);
  const binding = envelope.binding as Record<string, unknown>; const sequence = integer(binding?.sequence, 0, Number.MAX_SAFE_INTEGER);
  const expected = { version: 1, checkpointId: checkpoint.checkpointId, storeId: checkpoint.storeId, runId: checkpoint.runId, lockHash: checkpoint.lockHash, sessionId: input.sessionId, roleId: input.roleId, stepId: input.stepId,
    runtime: input.policy.runtime, policyDigest: digest(Buffer.from(canonical(input.policy))), resourcesDigest: digest(Buffer.from(canonical(input.policy.resources))), candidateDigest: checkpoint.subject.candidateDigest, clockBasis: checkpoint.clockBasis,
    accountingDigest: digest(Buffer.from(canonical({ ledger: checkpoint.ledger, requests: checkpoint.counts.requests, operations: checkpoint.counts.operations }))), sequence };
  if (envelope.type !== 'session_snapshot' || envelope.version !== 1 || !sameIdentity(binding, expected)) refuse('BINDING_MISMATCH', '/restore/session', { phase: 'restore' });
  const native = session.subarray(newline + 1), validator = new NativeSnapshot(input.policy, input.policy.limits.sessionBytes, false); validator.push(native); validator.finish();
  const workspace = restore.workspace.bytes; let offset = 0, index = 0, chunk = 0, fileBytes = 0, totalFiles = 0, ended = false, hash = createHash('sha256'); let active = false;
  while (offset < workspace.length) {
    const bytes = Buffer.from(workspace.buffer, workspace.byteOffset, workspace.byteLength), end = bytes.indexOf(10, offset); if (end < 0 || ended) refuse('RECOVERY_REQUIRED', '/restore/workspace', { phase: 'restore' });
    const row = snapshotRow(bytes.subarray(offset, end)); offset = end + 1;
    if (index++ === 0) { object(row, ['type', 'version', 'binding', 'manifest']); if (row.type !== 'workspace_snapshot' || row.version !== 1 || !sameIdentity(row.binding, binding) || !sameIdentity(row.manifest, input.candidate.manifest)) refuse('BINDING_MISMATCH', '/restore/workspace', { phase: 'restore' }); continue; }
    const ref = input.candidate.manifest.spec.entries[totalFiles], artifact = ref ? input.candidate.artifacts.find(item => item.name === ref.name) : null;
    if (row.type === 'file') { object(row, ['type', 'ref']); if (active || !ref || !sameIdentity(row.ref, ref)) refuse('RECOVERY_REQUIRED'); active = true; hash = createHash('sha256'); fileBytes = 0; chunk = 0; }
    else if (row.type === 'chunk') { object(row, ['type', 'index', 'data']); if (!active || !artifact || row.index !== chunk++ || typeof row.data !== 'string' || row.data.length > 43692) refuse('RECOVERY_REQUIRED'); const part = Buffer.from(row.data, 'base64'); if (part.length === 0 || part.length > 32768 || part.toString('base64') !== row.data || fileBytes + part.length > artifact.bytes.length || !part.equals(artifact.bytes.subarray(fileBytes, fileBytes + part.length))) refuse('RESOURCE_MISMATCH'); fileBytes += part.length; hash.update(part); }
    else if (row.type === 'file_end') { object(row, ['type', 'byteLength', 'digest']); if (!active || !ref || row.byteLength !== fileBytes || ref.byteLength !== fileBytes || row.digest !== hash.digest('hex') || row.digest !== ref.digest.hex) refuse('RESOURCE_MISMATCH'); active = false; totalFiles++; }
    else if (row.type === 'end') { object(row, ['type', 'files']); if (active || row.files !== totalFiles || totalFiles !== input.candidate.manifest.spec.entries.length) refuse('RECOVERY_REQUIRED'); ended = true; }
    else refuse('RECOVERY_REQUIRED');
  }
  if (!ended) refuse('RECOVERY_REQUIRED', '/restore/workspace', { phase: 'restore' });
  return { native, sequence };
}
