import { types } from 'node:util';
import { createHash } from 'node:crypto';
import { bindSubject, digestArtifact, validateDocument, type ArtifactManifest, type ArtifactRef, type Digest, type TaskLock } from '@loopwright/core';
import type { CheckpointRecord } from '@loopwright/state';
import type { AdapterPolicy, PiResult } from './types.js';
import { canonical, digest, freeze, id, integer, object, snapshot } from './boundary.js';
import { result, refuse } from './errors.js';
import { sameIdentity, validateDigest, validatePolicy } from './policy.js';
import { NativeSnapshot, snapshotRow } from './snapshot.js';
import { effectivePolicyV2 } from './policy-v2.js';
import type { AdapterPolicyV2 } from './types-v2.js';

export interface PiCaptureDecodeInput {
  readonly version: 1;
  readonly lock: TaskLock;
  readonly policy: AdapterPolicy | AdapterPolicyV2;
  readonly checkpoint: CheckpointRecord;
  readonly sessionId: string;
  readonly roleId: string;
  readonly stepId: string;
  readonly workspace: { readonly ref: ArtifactRef; readonly bytes: Uint8Array };
  readonly session: { readonly ref: ArtifactRef; readonly bytes: Uint8Array };
  readonly command: null | { readonly textDigest: Digest; readonly requestIds: readonly string[] };
}
export interface PiDecodedCapture {
  readonly candidate: ArtifactManifest;
  readonly artifacts: readonly { readonly name: string; readonly bytes: Uint8Array }[];
  readonly submission: Uint8Array | null;
  readonly nativeLeafId: string | null;
}

function bytes(input: unknown, ref: ArtifactRef, max: number): Buffer {
  if (!ArrayBuffer.isView(input) || types.isProxy(input) || ![Uint8Array.prototype, Buffer.prototype].includes(Object.getPrototypeOf(input))) refuse('INPUT_INVALID');
  const prototype = Object.getPrototypeOf(Uint8Array.prototype) as object;
  const get = (name: string): unknown => Object.getOwnPropertyDescriptor(prototype, name)!.get!.call(input);
  const buffer = get('buffer') as ArrayBuffer;
  const length = get('byteLength') as number, offset = get('byteOffset') as number;
  if (types.isSharedArrayBuffer(buffer) || length > max || length !== ref.byteLength) refuse('OUTPUT_LIMIT');
  const owned = Buffer.from(Buffer.from(buffer, offset, length));
  const actual = digestArtifact(ref.name, owned);
  if (!actual.ok || !sameIdentity(actual.value, ref)) refuse('RESOURCE_MISMATCH');
  return owned;
}

function rows(input: Buffer): Record<string, unknown>[] {
  const output: Record<string, unknown>[] = [];
  let offset = 0;
  while (offset < input.length) {
    const end = input.indexOf(10, offset);
    if (end < 0 || output.length >= 8192) refuse('RECOVERY_REQUIRED');
    output.push(snapshotRow(input.subarray(offset, end)));
    offset = end + 1;
  }
  if (!output.length) refuse('RECOVERY_REQUIRED');
  return output;
}

/** Passive bytes only. The caller obtains the checkpoint and expected command from current trusted state. */
export function decodePiCapture(input: PiCaptureDecodeInput): Promise<PiResult<PiDecodedCapture>> {
  return result(async () => {
    const top = object(input, ['version', 'lock', 'policy', 'checkpoint', 'sessionId', 'roleId', 'stepId', 'workspace', 'session', 'command']);
    if (top.version !== 1) refuse('INPUT_INVALID');
    const checked = validateDocument(snapshot(top.lock), 'TaskLock');
    if (!checked.ok) refuse('INPUT_INVALID', '/lock');
    const lock = checked.value;
    const rawPolicy = snapshot(top.policy) as unknown as AdapterPolicy | AdapterPolicyV2;
    const rawWorkspace = object(top.workspace, ['ref', 'bytes']), rawSession = object(top.session, ['ref', 'bytes']);
    const ownedWorkspace = bytes(rawWorkspace.bytes, snapshot(rawWorkspace.ref) as unknown as ArtifactRef, 8388608);
    const ownedSession = bytes(rawSession.bytes, snapshot(rawSession.ref) as unknown as ArtifactRef, 8388608);
    const policy = rawPolicy.version === 2 ? (await effectivePolicyV2(rawPolicy)).native : validatePolicy(snapshot(rawPolicy));
    const checkpoint = snapshot(top.checkpoint) as unknown as CheckpointRecord;
    const sessionId = id(top.sessionId), roleId = id(top.roleId), stepId = id(top.stepId);
    const role = lock.spec.contract.spec.roles.find(item => item.id === roleId);
    const step = lock.spec.contract.spec.steps.find(item => item.id === stepId);
    if (!role || !step || step.kind !== 'agent' || step.roleId !== roleId || role.adapter !== 'pi'
      || role.provider !== policy.selection.provider || role.model !== policy.selection.model || role.thinking !== policy.selection.thinking
      || policy.tools.some(name => !role.tools.includes(name))) refuse('BINDING_MISMATCH');
    if (checkpoint.formatVersion !== 1 || checkpoint.runId !== lock.spec.runId || !sameIdentity(checkpoint.lockHash, lock.spec.lockHash)
      || checkpoint.binding.resourceVersion !== policy.resourceVersion || checkpoint.privateSession === null) refuse('BINDING_MISMATCH');
    const workspace = object(top.workspace, ['ref', 'bytes']), session = object(top.session, ['ref', 'bytes']);
    const workspaceRef = snapshot(workspace.ref) as unknown as ArtifactRef, sessionRef = snapshot(session.ref) as unknown as ArtifactRef;
    if (!sameIdentity(workspaceRef, checkpoint.workspace) || !sameIdentity(sessionRef, checkpoint.privateSession)) refuse('BINDING_MISMATCH');
    const workspaceBytes = ownedWorkspace, sessionBytes = ownedSession;
    if (workspaceBytes.length > policy.limits.fileBytes || sessionBytes.length > Math.min(policy.limits.fileBytes, policy.limits.sessionBytes)) refuse('OUTPUT_LIMIT');
    if (workspaceBytes.length + sessionBytes.length > policy.limits.artifactBytes) refuse('OUTPUT_LIMIT');
    const newline = sessionBytes.indexOf(10);
    if (newline < 0) refuse('RECOVERY_REQUIRED');
    const envelope = object(snapshotRow(sessionBytes.subarray(0, newline)), ['type', 'version', 'binding']);
    const binding = envelope.binding as Record<string, unknown>;
    const expected = { version: 1, checkpointId: checkpoint.checkpointId, storeId: checkpoint.storeId, runId: checkpoint.runId,
      lockHash: checkpoint.lockHash, sessionId, roleId, stepId, runtime: policy.runtime, policyDigest: digest(Buffer.from(canonical(policy))),
      resourcesDigest: digest(Buffer.from(canonical(policy.resources))), candidateDigest: checkpoint.subject.candidateDigest,
      clockBasis: checkpoint.clockBasis, accountingDigest: digest(Buffer.from(canonical({ ledger: checkpoint.ledger, requests: checkpoint.counts.requests, operations: checkpoint.counts.operations }))),
      sequence: integer(binding?.sequence, 0, Number.MAX_SAFE_INTEGER) };
    if (envelope.type !== 'session_snapshot' || envelope.version !== 1 || !sameIdentity(binding, expected)) refuse('BINDING_MISMATCH');
    const native = new NativeSnapshot(policy);
    native.push(sessionBytes.subarray(newline + 1));
    const entries = native.finish();
    const workspaceRows = rows(workspaceBytes), header = object(workspaceRows[0], ['type', 'version', 'binding', 'manifest']);
    if (header.type !== 'workspace_snapshot' || header.version !== 1 || !sameIdentity(header.binding, binding)) refuse('BINDING_MISMATCH');
    const manifest = validateDocument(header.manifest, 'ArtifactManifest');
    if (!manifest.ok || Buffer.byteLength(canonical(manifest.value)) > 32768 || manifest.value.spec.entries.length > policy.limits.candidateEntries) refuse('RECOVERY_REQUIRED');
    if (manifest.value.spec.baseTree !== undefined && manifest.value.spec.entries.reduce((sum, entry) => sum + entry.byteLength, 0) > 4_194_304) refuse('OUTPUT_LIMIT');
    const subject = bindSubject(lock, manifest.value);
    if (!subject.ok || !sameIdentity(subject.value, checkpoint.subject)) refuse('BINDING_MISMATCH');
    const artifacts: { name: string; bytes: Uint8Array }[] = [];
    let index = 1, total = workspaceBytes.length + sessionBytes.length;
    for (const ref of manifest.value.spec.entries) {
      const start = object(workspaceRows[index++], ['type', 'ref']);
      if (start.type !== 'file' || !sameIdentity(start.ref, ref) || ref.byteLength > policy.limits.fileBytes) refuse('RECOVERY_REQUIRED');
      total += ref.byteLength;
      if (total > policy.limits.artifactBytes) refuse('OUTPUT_LIMIT');
      const chunks: Buffer[] = [], hash = createHash('sha256');
      let chunkIndex = 0, length = 0;
      while (workspaceRows[index]?.type === 'chunk') {
        const chunk = object(workspaceRows[index++], ['type', 'index', 'data']);
        if (chunk.index !== chunkIndex++ || typeof chunk.data !== 'string' || chunk.data.length > 43692) refuse('RECOVERY_REQUIRED');
        const part = Buffer.from(chunk.data, 'base64');
        if (!part.length || part.length > 32768 || part.toString('base64') !== chunk.data || (length += part.length) > ref.byteLength) refuse('RESOURCE_MISMATCH');
        chunks.push(part); hash.update(part);
      }
      const end = object(workspaceRows[index++], ['type', 'byteLength', 'digest']);
      if (end.type !== 'file_end' || end.byteLength !== length || length !== ref.byteLength || end.digest !== hash.digest('hex') || end.digest !== ref.digest.hex) refuse('RESOURCE_MISMATCH');
      artifacts.push({ name: ref.name, bytes: Buffer.concat(chunks, length) });
    }
    const end = object(workspaceRows[index++], ['type', 'files']);
    if (end.type !== 'end' || end.files !== artifacts.length || index !== workspaceRows.length) refuse('RECOVERY_REQUIRED');
    let leaf: string | null = null, user: Record<string, unknown> | null = null, assistant: Record<string, unknown> | null = null;
    for (const raw of entries) {
      const entry = raw as unknown as Record<string, unknown>;
      if (entry.type === 'session') continue;
      // A branched native history needs an explicit active-leaf format; this passive v1 reader refuses it.
      if (entry.parentId !== leaf) refuse('CAPABILITY_UNSUPPORTED', '/session/branch');
      leaf = entry.id as string;
      if (entry.type !== 'message') continue;
      const message = entry.message as Record<string, unknown>;
      if (message.role === 'user') { user = message; assistant = null; }
      else if (message.role === 'assistant' && user) assistant = message;
    }
    let submission: Uint8Array | null = null;
    if (top.command !== null) {
      const command = object(top.command, ['textDigest', 'requestIds']); validateDigest(command.textDigest, '/command/textDigest');
      if (!Array.isArray(command.requestIds) || command.requestIds.length < 1 || command.requestIds.length > policy.limits.requests
        || command.requestIds.length > checkpoint.counts.observedRequests || new Set(command.requestIds).size !== command.requestIds.length) refuse('BINDING_MISMATCH');
      for (const requestId of command.requestIds) id(requestId);
      if (!user || !assistant || assistant.stopReason !== 'stop') refuse('RECOVERY_REQUIRED', '/command');
      const text = typeof user.content === 'string' ? user.content : textBlocks(user.content, true);
      if (!sameIdentity(digest(Buffer.from(text)), command.textDigest)) refuse('BINDING_MISMATCH', '/command');
      submission = Buffer.from(textBlocks(assistant.content, false));
      if (submission.length > policy.limits.responseBytes) refuse('OUTPUT_LIMIT');
    }
    return freeze({ candidate: manifest.value, artifacts, submission, nativeLeafId: leaf });
  });
}

function textBlocks(value: unknown, onlyText: boolean): string {
  if (!Array.isArray(value)) refuse('RECOVERY_REQUIRED');
  let output = '';
  for (const block of value as Record<string, unknown>[]) {
    if (!block || typeof block !== 'object') refuse('RECOVERY_REQUIRED');
    if (block.type === 'text') { if (typeof block.text !== 'string') refuse('RECOVERY_REQUIRED'); output += block.text; }
    else if (onlyText) refuse('CAPABILITY_UNSUPPORTED');
  }
  return output;
}
