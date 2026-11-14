import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import type { ArtifactManifest } from '@loopwright/core';
import { bindSubject } from '@loopwright/core';
import { ArtifactWriter } from './artifacts.js';
import { Candidate } from './candidate.js';
import { NativeSnapshot, rowBytes } from './snapshot.js';
import { canonical, digest } from './boundary.js';
import { stateValue } from './admission.js';
import { recoverSnapshot } from './recovery.js';
import { sameIdentity } from './policy.js';
import { refuse } from './errors.js';
import type { PiCapture, PiHost, PiOpenInput } from './types.js';
export interface NativeCaptureSource { capture(sink: (bytes: Uint8Array) => Promise<void>): Promise<void> }
export function captureBinding(host: PiHost, input: PiOpenInput, manifest: ArtifactManifest, checkpointId: string, sequence: number) {
  const view = stateValue(host.store.inspect(), 'restore'), subject = bindSubject(input.lock, manifest); if (!subject.ok) refuse('RECOVERY_REQUIRED', '', { phase: 'restore' });
  return { version: 1, checkpointId, storeId: view.storeId, runId: view.runId, lockHash: view.lockHash, sessionId: input.sessionId, roleId: input.roleId, stepId: input.stepId,
    runtime: input.policy.runtime, policyDigest: digest(Buffer.from(canonical(input.policy))), resourcesDigest: digest(Buffer.from(canonical(input.policy.resources))), candidateDigest: subject.value.candidateDigest,
    clockBasis: view.clock.basis, accountingDigest: digest(Buffer.from(canonical({ ledger: view.ledger, requests: view.counts.requests, operations: view.counts.operations }))), sequence };
}
export async function captureCheckpoint(host: PiHost, input: PiOpenInput, candidate: Candidate, source: NativeCaptureSource, checkpointId: string, sequence: number, signal: AbortSignal): Promise<PiCapture> {
  if (!input.policy.privateArtifacts) refuse('CAPABILITY_UNSUPPORTED', '', { phase: 'restore' });
  stateValue(host.store.renew(host.authority), 'restore'); const before = stateValue(host.store.inspect(), 'restore');
  if ((before.clock.remainingTaskMs.safeValue ?? 0) <= 0) refuse('DEADLINE', '', { phase: 'restore' });
  if (before.clockStatus !== 'trusted' || before.counts.dispatchedRequests || before.counts.unresolvedRequests || before.counts.unresolvedOperations || before.ledger.violations.length) refuse('RECOVERY_REQUIRED', '', { phase: 'restore' });
  const existing = host.store.getCheckpoint(checkpointId);
  if (existing.ok) {
    const checkpoint = existing.value; if (!checkpoint.privateSession) refuse('RECOVERY_REQUIRED');
    const read = async (ref: import('@loopwright/core').ArtifactRef) => {
      if (ref.byteLength > input.policy.limits.fileBytes) refuse('OUTPUT_LIMIT');
      const fd = await open(join(host.artifactsDirectory, ref.name), constants.O_RDONLY | constants.O_NOFOLLOW);
      try { const stat = await fd.stat(); if (!stat.isFile() || stat.nlink !== 1 || stat.uid !== process.getuid?.() || stat.mode & 0o077 || stat.size !== ref.byteLength) refuse('RECOVERY_REQUIRED'); const bytes = await fd.readFile(); if (bytes.length !== ref.byteLength || !sameIdentity(digest(bytes), ref.digest)) refuse('RESOURCE_MISMATCH'); return bytes; } finally { await fd.close(); }
    };
    const manifest = await candidate.manifest(), workspaceBytes = await read(checkpoint.workspace), sessionBytes = await read(checkpoint.privateSession);
    recoverSnapshot(host, { ...input, candidate: { ...input.candidate, ...(input.candidate.baseline ? { baseline: input.candidate.baseline } : {}), manifest, artifacts: await Promise.all(manifest.spec.entries.map(async ref => { const fd = await open(join(candidate.root, ref.name), constants.O_RDONLY | constants.O_NOFOLLOW); try { return { name: ref.name, bytes: await fd.readFile() }; } finally { await fd.close(); } })) }, restore: { checkpointId, workspace: { ref: checkpoint.workspace, bytes: workspaceBytes }, session: { ref: checkpoint.privateSession, bytes: sessionBytes } } });
    return { checkpointId, candidate: manifest, workspace: checkpoint.workspace, session: checkpoint.privateSession };
  }
  if (existing.error.code !== 'RECORD_NOT_FOUND') stateValue(existing, 'restore');
  if (before.counts.checkpoints >= input.policy.limits.checkpoints) refuse('OUTPUT_LIMIT', '', { phase: 'restore' });
  const manifest = await candidate.manifest(), binding = captureBinding(host, input, manifest, checkpointId, sequence);
  // Conservatively include both logical candidate bytes and the encoded workspace artifact in headroom.
  const baseline = manifest.spec.entries.reduce((sum, entry) => sum + entry.byteLength, 0) + input.resources.reduce((sum, resource) => sum + resource.bytes.byteLength, 0);
  const remaining = input.policy.limits.artifactBytes - baseline; if (remaining <= 0 || Buffer.byteLength(canonical(manifest)) > 32768) refuse('OUTPUT_LIMIT', '', { phase: 'restore' });
  const session = new ArtifactWriter(host.artifactsDirectory, 'pi-checkpoints/' + checkpointId + '.session.ndjson', Math.min(input.policy.limits.sessionBytes, input.policy.limits.fileBytes, remaining), signal);
  let workspace: ArtifactWriter | null = null;
  try {
    await session.start(); await session.append(rowBytes({ type: 'session_snapshot', version: 1, binding }));
    const native = new NativeSnapshot(input.policy, input.policy.limits.sessionBytes, false);
    await source.capture(async bytes => { native.push(bytes); await session.append(bytes); }); native.finish(); const sessionRef = await session.finish();
    const workspaceMax = Math.min(input.policy.limits.fileBytes, remaining - sessionRef.byteLength); if (workspaceMax <= 0) refuse('OUTPUT_LIMIT', '', { phase: 'restore' });
    workspace = new ArtifactWriter(host.artifactsDirectory, 'pi-checkpoints/' + checkpointId + '.workspace.ndjson', workspaceMax, signal); await workspace.start();
    await workspace.append(rowBytes({ type: 'workspace_snapshot', version: 1, binding, manifest }));
    for (const ref of manifest.spec.entries) {
      const checked = await candidate.checkRead(ref.name); if (!sameIdentity(checked.ref, ref)) refuse('RECOVERY_REQUIRED', '', { phase: 'restore' });
      await workspace.append(rowBytes({ type: 'file', ref })); const descriptor = await open(join(candidate.root, ref.name), constants.O_RDONLY | constants.O_NOFOLLOW), hash = createHash('sha256'); let bytes = 0, index = 0;
      try {
        const stat = await descriptor.stat(); if (!stat.isFile() || stat.nlink !== 1 || stat.size !== ref.byteLength) refuse('RECOVERY_REQUIRED', '', { phase: 'restore' });
        const buffer = Buffer.alloc(32768);
        for (;;) { const part = await descriptor.read(buffer, 0, buffer.length, bytes); if (!part.bytesRead) break; const chunk = buffer.subarray(0, part.bytesRead); bytes += chunk.length; if (bytes > ref.byteLength) refuse('RECOVERY_REQUIRED', '', { phase: 'restore' }); hash.update(chunk); await workspace.append(rowBytes({ type: 'chunk', index: index++, data: chunk.toString('base64') })); }
      } finally { await descriptor.close(); }
      const hex = hash.digest('hex'); if (bytes !== ref.byteLength || hex !== ref.digest.hex) refuse('RECOVERY_REQUIRED', '', { phase: 'restore' }); await workspace.append(rowBytes({ type: 'file_end', byteLength: bytes, digest: hex }));
    }
    await workspace.append(rowBytes({ type: 'end', files: manifest.spec.entries.length })); const workspaceRef = await workspace.finish();
    if (signal.aborted) refuse('CANCELLED', '', { phase: 'restore' }); stateValue(host.store.renew(host.authority), 'restore'); const now = stateValue(host.store.inspect(), 'restore');
    if ((now.clock.remainingTaskMs.safeValue ?? 0) <= 0) refuse('DEADLINE', '', { phase: 'restore' });
    if (now.clockStatus !== 'trusted' || !sameIdentity(digest(Buffer.from(canonical({ ledger: now.ledger, requests: now.counts.requests, operations: now.counts.operations }))), binding.accountingDigest) || now.counts.dispatchedRequests || now.counts.unresolvedRequests || now.counts.unresolvedOperations || now.ledger.violations.length) refuse('RECOVERY_REQUIRED', '', { phase: 'restore' });
    stateValue(host.store.writeCheckpoint(host.authority, { checkpointId, expectedRevision: now.revision, candidateManifest: manifest, workspace: workspaceRef, privateSession: sessionRef, additionalArtifacts: [] }), 'restore');
    return { checkpointId, candidate: manifest, workspace: workspaceRef, session: sessionRef };
  } finally { await session.close(); await workspace?.close(); }
}
