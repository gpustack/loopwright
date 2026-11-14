import { constants } from 'node:fs';
import { lstat, open, realpath, rename } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
import { reopenLocalRun, type Authority, type LocalRunStore, type OperationReceipt } from '@loopwright/state';
import { admitTask, validateDocument } from '@loopwright/core';
import { approvedState } from './config.js';
import { compilePlan } from './compile.js';
import { ControllerFailure, refuse, result } from './errors.js';
import { ControllerOwner, bootIdentity } from './ownership.js';
import { readRetained } from './retained.js';
import { resumeCycleWithPorts } from './recovery.js';
import { ArtifactStore, checkedRef, stateValue } from './storage.js';
import { readBoundedFile } from './files.js';
import { ProgressStore } from './progress.js';
import { parsePrivateJson } from './parser.js';
import { canonical, freeze, hash, record, same, text } from './schema.js';
import { preparePublication, verifyPublicationReceipt } from './publication.js';
import { verifySignedPayload } from './gate.js';
import { resolveStoreLeaseMs } from './controller.js';
import type { LoadedConfiguration } from './types.js';
export interface ReconcileCycleInput { readonly configuration: LoadedConfiguration; readonly runRoot: string; readonly runId: string; readonly receipt: string; readonly signal?: AbortSignal }
export type ReconcileExecution =
  | { readonly kind: 'settled'; readonly version: 1; readonly runId: string; readonly status: 'completed' | 'failed' | 'blocked'; readonly outcome: 'succeeded' | 'not_executed'; readonly externalEffects: 'confirmed' | 'none'; readonly receipt: OperationReceipt }
  | { readonly kind: 'unresolved'; readonly version: 1; readonly runId: string; readonly reason: string };
/** Operator receipt files may live anywhere private enough for the operator; ancestor symlinks such as /tmp -> /private/tmp canonicalize, the file itself never links. */
async function readReceiptFile(path: string): Promise<Buffer> {
  const rawTarget = resolve(text(path));
  let target: string;
  try {
    const stats = await lstat(rawTarget);
    if (!stats.isFile() || stats.isSymbolicLink() || stats.size > 65536) refuse('EVIDENCE_UNAVAILABLE', '/receipt', 'recovery');
    target = join(await realpath(dirname(rawTarget)), basename(rawTarget));
  } catch (error) { if (error instanceof ControllerFailure) throw error; refuse('EVIDENCE_UNAVAILABLE', '/receipt', 'recovery'); }
  try { return await readBoundedFile(target, 65536, false); }
  catch { refuse('EVIDENCE_UNAVAILABLE', '/receipt', 'recovery'); }
}
function signedBodyOf(file: Record<string, unknown>): Record<string, unknown> {
  const body = { ...file }; delete body.signature; return body;
}
/** Explicit operator reconciliation for interrupted or unproven external effects; never re-dispatches the external request. */
export function reconcileCycle(input: ReconcileCycleInput) {
  return result(async (): Promise<ReconcileExecution> => {
    const fields = Object.keys(input); record(input, fields);
    if (fields.some(key => !['configuration', 'runRoot', 'runId', 'receipt', 'signal'].includes(key)) || input.signal !== undefined && !(input.signal instanceof AbortSignal)) refuse('CONFIG_SCHEMA', '', 'recovery');
    const receiptBytes = await readReceiptFile(input.receipt);
    let raw: unknown; try { raw = parsePrivateJson(receiptBytes, 65536); } catch { refuse('EVIDENCE_UNAVAILABLE', '/receipt', 'recovery'); }
    const kind = typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>).kind : null;
    if (kind !== 'publication_receipt' && kind !== 'gate_verdict') refuse('EVIDENCE_UNAVAILABLE', '/receipt', 'recovery');
    const state = approvedState(input.configuration), compiled = await compilePlan(input.configuration);
    if (!compiled.ok) refuse('RECOVERY_REQUIRED', '', 'recovery');
    const plan = compiled.value;
    if (kind === 'gate_verdict') return await reconcileGate(input, state, plan, receiptBytes);
    if (plan.publication.mode !== 'pull_request') refuse('EVIDENCE_UNAVAILABLE', '/receipt', 'recovery');
    return await reconcilePublication(input, state, plan, raw);
  }, 'recovery');
}
/** Shared retained-run admission for both reconciliation paths. */
async function admit(input: ReconcileCycleInput, plan: import('./types.js').CompiledPlan) {
  const retained = await readRetained({ runRoot: input.runRoot, runId: input.runId }), { directory, descriptor, lock } = retained;
  const state = approvedState(input.configuration);
  const admitted = admitTask(plan.task, { admissionId: 'admission.' + hash('loopwright.dev/controller/admission/v1\0' + input.runId + '\0' + plan.planDigest.hex).hex.slice(0, 40), runId: input.runId });
  if (!admitted.ok || !same(admitted.value, lock) || !same(plan, retained.plan)
    || !same(descriptor.configuration, { configPath: state.input.configPath, registryPath: state.input.registryPath, registrySha256: state.input.registrySha256 })) refuse('RECOVERY_REQUIRED', '', 'recovery');
  const expected = { directory: join(directory, 'state'), storeId: 'store.' + hash('loopwright.dev/controller/store/v1\0' + input.runId).hex.slice(0, 40), lock,
    policy: { version: 1, leaseMs: resolveStoreLeaseMs(input.configuration, plan), cost: 'observe_only' }, binding: { coreApiVersion: 'loopwright.dev/v1alpha1', hostVersion: 's04-controller-v1', adapters: [{ id: 'pi', version: '0.0.0' }], resourceVersion: plan.task.spec.trustedContext.revision, clockEpoch: 'boot.' + hash(await bootIdentity()).hex.slice(0, 40) } };
  if (!same(descriptor.identity, expected)) refuse('RECOVERY_REQUIRED', '', 'recovery');
  return { retained, directory, descriptor, lock, state };
}
async function reconcileGate(input: ReconcileCycleInput, state: ReturnType<typeof approvedState>, plan: import('./types.js').CompiledPlan, receiptBytes: Buffer) {
  const { directory, descriptor, lock } = await admit(input, plan);
  let owner: ControllerOwner | null = null, store: LocalRunStore | null = null, authority: Authority | null = null;
  try {
    owner = await ControllerOwner.acquire(directory, input.runId, plan.planDigest);
    store = stateValue(reopenLocalRun(descriptor.identity)); const original = stateValue(store.inspect());
    if (original.clockStatus !== 'trusted') refuse('RECOVERY_REQUIRED', '', 'recovery');
    authority = stateValue(store.claim({ ownerId: 'controller.' + owner.nonce, expectedGeneration: original.owner.generation, expectedRevision: original.revision, mode: 'recovery' })).authority;
    const artifacts = new ArtifactStore(join(directory, 'artifacts'), owner, state.vault);
    const progress = new ProgressStore(store, authority, artifacts, plan, lock, descriptor.plan, descriptor.source), head = await progress.read();
    const file = record(parsePrivateJson(receiptBytes, 65536), ['version', 'kind', 'storeId', 'runId', 'lockHash', 'operationId', 'dispatchId', 'dispatchGeneration', 'gateId', 'checkId', 'candidateDigest', 'status', 'reason', 'expiresAtMs', 'signature']);
    // The active verifier_pre row is checked first, so a tampered operationId while parked fails at /receipt; after
    // resume (or a prior reconcile) the receipt locates its reconciled gate row for idempotent replay.
    const activeRow = head?.progress.stage.kind === 'verifier_pre'
      ? head.progress.verifierReceipts.find(item => item.receipt === null && item.generation === head.progress.candidate.generation) ?? null
      : null;
    const row = activeRow ?? head?.progress.verifierReceipts.find(item => item.operationId === text(file.operationId, '/receipt', 128)) ?? null;
    const slot = row ? plan.verifierSlots.find(item => item.id === row.slot) : null;
    if (!head || !row || !slot || slot.handler.implementation !== 'gate.v1') refuse('RECOVERY_REQUIRED', '/gate', 'recovery');
    const endpoint = input.configuration.registry.spec.gateEndpoints.find(item => item.id === (slot.handler.parameters as Record<string, unknown>).endpointRef);
    if (!endpoint) refuse('RECOVERY_REQUIRED', '/gate', 'recovery');
    const operation = stateValue(store.getOperation(row.operationId)), dispatch = operation.dispatch;
    if (!dispatch || operation.state !== 'dispatch_uncertain' && operation.state !== 'confirmed') refuse('RECOVERY_REQUIRED', '/gate', 'recovery');
    const subject = head.checkpoint.subject;
    const body = signedBodyOf(file);
    if (file.version !== 1 || !same(body, { version: 1, kind: 'gate_verdict', storeId: original.storeId, runId: lock.spec.runId, lockHash: lock.spec.lockHash, operationId: row.operationId, dispatchId: dispatch.dispatchId, dispatchGeneration: dispatch.generation, gateId: (slot.handler.parameters as Record<string, unknown>).gateId, checkId: slot.checkId, candidateDigest: subject.candidateDigest.hex, status: file.status, reason: file.reason, expiresAtMs: file.expiresAtMs })
      || !['approved', 'denied', 'expired'].includes(text(file.status))
      || file.reason !== null && (typeof file.reason !== 'string' || (file.reason as string).length > 256)
      || !/^(?:0|[1-9][0-9]{0,17})$/.test(text(file.expiresAtMs))
      || text(file.status) === 'approved' && (BigInt(text(file.expiresAtMs)) < BigInt(original.clock.sampledNow.wallMs) || BigInt(text(file.expiresAtMs)) > BigInt(original.clock.sampledNow.wallMs) + 86400000n)
      || Buffer.byteLength(canonical(body)) > 16384
      || !verifySignedPayload(state.vault.resolveNetworkCredential(endpoint.signingCredentialRef), canonical(body), text(file.signature))) refuse('EVIDENCE_UNAVAILABLE', '/receipt', 'recovery');
    const status = text(file.status) as 'approved' | 'denied' | 'expired';
    const dispositioned = status === 'approved' ? { status: 'passed', reason: null, method: 'verify_external_gate' } : status === 'denied' ? { status: 'failed', reason: 'gate_denied', method: 'verify_external_gate' } : { status: 'blocked', reason: 'EVIDENCE_UNAVAILABLE', method: 'verify_external_gate' };
    const nonce = row.producerNonce, prefix = join(artifacts.directory, 'gate-producer-' + hash(row.operationId + '\0' + nonce).hex);
    let settledReceipt: OperationReceipt | null = null;
    if (operation.state === 'confirmed') {
      settledReceipt = operation.reconciliation ?? operation.initialReceipt;
      if (!settledReceipt) refuse('RECOVERY_REQUIRED', '/gate', 'recovery');
      const savedOutput = record(parsePrivateJson(await artifacts.read(settledReceipt.evidence.artifact, 65536), 65536), ['version', 'binding', 'observation', 'verdict', 'responseBytes', 'responseSignature', 'disposition']);
      if (savedOutput.verdict === null) refuse('RECOVERY_REQUIRED', '/gate', 'recovery');
      if (!same(savedOutput.verdict, { status, reason: file.reason, expiresAtMs: file.expiresAtMs })) refuse('RECEIPT_CONFLICT', '/receipt', 'recovery');
      if (head.progress.stage.kind.startsWith('terminal') && head.progress.terminalIntent?.result) {
        let raw: unknown; try { raw = parsePrivateJson(await artifacts.read(head.progress.terminalIntent.result, 1048576), 1048576); } catch { refuse('RECOVERY_REQUIRED', '', 'recovery'); }
        const terminalResult = validateDocument(raw, 'RunResult'); if (!terminalResult.ok) refuse('RECOVERY_REQUIRED', '', 'recovery');
        const runStatus = terminalResult.value.spec.status;
        if (runStatus === 'reconcile_required') return freeze({ kind: 'unresolved', version: 1, runId: lock.spec.runId, reason: 'remaining_unresolved_work' }) as ReconcileExecution;
        return freeze({ kind: 'settled', version: 1, runId: lock.spec.runId, status: runStatus === 'completed' ? 'completed' : runStatus === 'failed' ? 'failed' : 'blocked', outcome: settledReceipt.outcome === 'succeeded' ? 'succeeded' : 'not_executed', externalEffects: terminalResult.value.spec.externalEffects === 'confirmed' ? 'confirmed' : 'none', receipt: freeze(settledReceipt) }) as ReconcileExecution;
      }
    } else {
      const request: Record<string, unknown> = { ...{ version: 1, kind: 'gate_request', gateId: (slot.handler.parameters as Record<string, unknown>).gateId, checkId: slot.checkId, candidateDigest: subject.candidateDigest.hex, subject }, storeId: original.storeId, runId: lock.spec.runId, lockHash: lock.spec.lockHash, operationId: row.operationId, dispatchId: dispatch.dispatchId, dispatchGeneration: dispatch.generation, requestDigest: operation.intent.requestDigest.hex };
      const requestBytesDigest = hash(Buffer.from(canonical(request))).hex;
      const suffix = hash(row.operationId + '\0' + nonce).hex.slice(0, 40);
      const output = await artifacts.json('gate-output', { version: 1, binding: { planDigest: plan.planDigest, operationId: row.operationId, producerNonce: nonce, generation: row.generation, endpoint: endpoint.id, subject, requestBytesDigest },
        observation: { attempts: 1, elapsedMs: 0, transport: 'completed' }, verdict: { status, reason: file.reason, expiresAtMs: file.expiresAtMs }, responseBytes: Buffer.from(canonical(body)).toString('base64'), responseSignature: text(file.signature), disposition: dispositioned }, 65536);
      const evidenceResult = validateDocument({ apiVersion: 'loopwright.dev/v1alpha1', kind: 'Evidence', metadata: { id: 'evidence.' + suffix }, spec: { checkId: slot.checkId, observedStatus: dispositioned.status, producerId: 'loopwright.gate-verifier.v1', method: dispositioned.method, level: 'external_service', subject, artifacts: [output], reason: dispositioned.reason } }, 'Evidence');
      if (!evidenceResult.ok) refuse('RECOVERY_REQUIRED', '/gate', 'recovery');
      settledReceipt = { receiptId: 'receipt.' + suffix, outcome: dispositioned.method === 'verify_external_gate' ? 'succeeded' : 'failed',
        evidence: { evidenceId: 'receipt-evidence.' + suffix, producerId: 'loopwright.gate-verifier.v1', method: dispositioned.method,
          subject: { storeId: original.storeId, runId: lock.spec.runId, lockHash: lock.spec.lockHash, operationId: row.operationId, requestId: null, intentDigest: operation.intentDigest, dispatchGeneration: dispatch.generation, dispatchId: dispatch.dispatchId }, artifact: output } };
      const receiptRef = await artifacts.json('gate-receipt', settledReceipt, 65536);
      await writeMarker(prefix + '.proof.json', { version: 1, output, receipt: receiptRef, evidence: evidenceResult.value }, state.vault);
      stateValue(store.reconcileOperation(authority, row.operationId, settledReceipt));
    }
    // resumeCycleWithPorts re-acquires the owner and reopens the store; release everything first so it never hits OWNER_BUSY.
    stateValue(store.release(authority)); authority = null;
    stateValue(store.close()); store = null;
    await owner.release(); owner = null;
    const execution = await resumeCycleWithPorts({ configuration: input.configuration, repository: descriptor.repository, runRoot: input.runRoot, runId: input.runId });
    if (!execution.ok || execution.value.kind !== 'result') refuse('RECOVERY_REQUIRED', '', 'recovery');
    if (execution.value.result.spec.status === 'reconcile_required') return freeze({ kind: 'unresolved', version: 1, runId: lock.spec.runId, reason: 'remaining_unresolved_work' }) as ReconcileExecution;
    const receipt = settledReceipt as OperationReceipt;
    return freeze({ kind: 'settled', version: 1, runId: lock.spec.runId, status: execution.value.result.spec.status === 'completed' ? 'completed' : execution.value.result.spec.status === 'failed' ? 'failed' : 'blocked', outcome: receipt.outcome === 'succeeded' ? 'succeeded' : 'not_executed', externalEffects: execution.value.result.spec.externalEffects === 'confirmed' ? 'confirmed' : 'none', receipt: freeze(receipt) }) as ReconcileExecution;
  } finally {
    if (store) { if (authority) stateValue(store.release(authority)); stateValue(store.close()); }
    if (owner) await owner.release();
  }
}
async function writeMarker(path: string, value: unknown, vault: { assertClean: (value: Uint8Array | string | object) => void }): Promise<void> {
  const bytes = Buffer.from(canonical(value)); if (bytes.byteLength > 1048576) refuse('OUTPUT_LIMIT', '', 'recovery'); vault.assertClean(bytes);
  let file: Awaited<ReturnType<typeof open>>;
  try { file = await open(path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST' || !Buffer.from(await readBoundedFile(path, 1048576, true)).equals(bytes)) refuse('RECOVERY_REQUIRED', '', 'recovery'); return; }
  try { await file.writeFile(bytes); await file.sync(); } finally { await file.close(); }
}
/** Replaces a proof marker that only carried an unresolved observation; a settled proof with different bytes refuses. */
async function replaceMarker(path: string, value: unknown, vault: { assertClean: (value: Uint8Array | string | object) => void }): Promise<void> {
  const bytes = Buffer.from(canonical(value)); if (bytes.byteLength > 1048576) refuse('OUTPUT_LIMIT', '', 'recovery'); vault.assertClean(bytes);
  let existing: Buffer | undefined;
  try { existing = Buffer.from(await readBoundedFile(path, 1048576, true)); } catch { existing = undefined; }
  if (existing && existing.equals(bytes)) return;
  if (existing) {
    let prior: { receipt?: unknown } | undefined;
    try { prior = parsePrivateJson(existing, 1048576) as { receipt?: unknown }; } catch { prior = undefined; }
    if (prior && prior.receipt !== null && prior.receipt !== undefined) refuse('RECOVERY_REQUIRED', '', 'recovery');
  }
  const temp = path + '.' + randomBytes(6).toString('hex') + '.tmp';
  const file = await open(temp, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
  try { await file.writeFile(bytes); await file.sync(); } finally { await file.close(); }
  await rename(temp, path);
}
async function reconcilePublication(input: ReconcileCycleInput, state: ReturnType<typeof approvedState>, plan: import('./types.js').CompiledPlan, raw: unknown) {
  const publication = plan.publication;
  if (publication.mode !== 'pull_request') refuse('EVIDENCE_UNAVAILABLE', '/receipt', 'recovery');
  const { directory, descriptor, lock } = await admit(input, plan);
  let owner: ControllerOwner | null = null, store: LocalRunStore | null = null, authority: Authority | null = null;
  try {
    owner = await ControllerOwner.acquire(directory, input.runId, plan.planDigest);
    store = stateValue(reopenLocalRun(descriptor.identity)); const original = stateValue(store.inspect());
    if (original.clockStatus !== 'trusted') refuse('RECOVERY_REQUIRED', '', 'recovery');
    authority = stateValue(store.claim({ ownerId: 'controller.' + owner.nonce, expectedGeneration: original.owner.generation, expectedRevision: original.revision, mode: 'recovery' })).authority;
    const artifacts = new ArtifactStore(join(directory, 'artifacts'), owner, state.vault);
    const progress = new ProgressStore(store, authority, artifacts, plan, lock, descriptor.plan, descriptor.source), head = await progress.read();
    const pending = head?.progress.publication;
    if (!head || !pending || pending.status === 'idle' || pending.operationId === null) refuse('RECOVERY_REQUIRED', '/publication', 'recovery');
    const operation = stateValue(store.getOperation(pending.operationId)), subject = head.checkpoint.subject;
    if (operation.intent.effect !== 'external_write' || operation.intent.targetIdentity !== 'publication:' + lock.spec.runId + ':' + subject.candidateDigest.hex) refuse('RECOVERY_REQUIRED', '/publication', 'recovery');
    const endpoint = input.configuration.registry.spec.publicationEndpoints.find(item => item.id === publication.endpointRef);
    if (!endpoint) refuse('RECOVERY_REQUIRED', '/publication', 'recovery');
    const prepared = preparePublication(plan, lock, original.storeId, endpoint, subject);
    if (operation.intent.attemptId !== prepared.idempotencyKey || !same(operation.intent.requestDigest, prepared.requestDigest) || operation.intent.nodeId !== plan.orderedDAG[0]!.id || !operation.dispatch) refuse('RECOVERY_REQUIRED', '/publication', 'recovery');
    const hasCandidate = typeof raw === 'object' && raw !== null && Object.hasOwn(raw, 'candidateDigest');
    const file = record(raw, ['version', 'kind', 'storeId', 'runId', 'lockHash', 'operationId', 'dispatchId', 'dispatchGeneration', 'idempotencyKey', 'outcome', 'externalUrl', 'reason', 'signature', ...(hasCandidate ? ['candidateDigest' as const] : [])]);
    const body = signedBodyOf(file);
    const checked = verifyPublicationReceipt(body, { storeId: original.storeId, runId: lock.spec.runId, lockHash: lock.spec.lockHash, operationId: pending.operationId, dispatchId: operation.dispatch.dispatchId, dispatchGeneration: operation.dispatch.generation, idempotencyKey: prepared.idempotencyKey, candidateDigest: subject.candidateDigest.hex });
    if (!checked || checked.outcome === 'failed'
      || !verifySignedPayload(state.vault.resolveNetworkCredential(endpoint.signingCredentialRef), canonical(body), text(file.signature))) refuse('EVIDENCE_UNAVAILABLE', '/receipt', 'recovery');
    const outcome = checked.outcome === 'succeeded' ? 'succeeded' as const : 'not_executed' as const;
    const prefix = join(artifacts.directory, 'publication-producer-' + hash(pending.operationId).hex);
    let binding: Record<string, unknown> | null = null;
    try { binding = record(parsePrivateJson(await readBoundedFile(prefix + '.binding.json', 1048576, true), 1048576), ['version', 'planDigest', 'operationId', 'requestDigest', 'requestBytesDigest', 'intentDigest', 'subject', 'endpoint', 'dispatchReceipt']); }
    catch (error) { if (error instanceof ControllerFailure && error.diagnostic.code === 'REGISTRY_UNTRUSTED') refuse('RECOVERY_REQUIRED', '', 'recovery'); throw error; }
    if (binding.version !== 1 || binding.operationId !== pending.operationId || !same(binding.intentDigest, operation.intentDigest) || binding.endpoint !== endpoint.id) refuse('RECOVERY_REQUIRED', '', 'recovery');
    let outputRef: import('@loopwright/core').ArtifactRef;
    let receiptRef: import('@loopwright/core').ArtifactRef;
    // Reuse the settled proof pair only when both halves are present; an unresolved proof (receipt: null) never
    // carries the settled verdict, so the settled output and receipt are written fresh below.
    const settledProof = await (async () => { try { const parsed = record(parsePrivateJson(await readBoundedFile(prefix + '.proof.json', 1048576, true), 1048576), ['version', 'output', 'receipt', 'evidence']); return parsed.output !== null && parsed.receipt !== null ? { output: checkedRef(parsed.output), receiptRef: checkedRef(parsed.receipt) } : null; } catch { return null; } })();
    const suffix = hash(pending.operationId + '\0' + prepared.idempotencyKey).hex.slice(0, 40);
    const receipt: OperationReceipt = { receiptId: 'receipt.' + suffix, outcome,
      evidence: { evidenceId: 'receipt-evidence.' + suffix, producerId: 'loopwright.publisher.v1', method: 'publish_external',
        subject: { storeId: original.storeId, runId: lock.spec.runId, lockHash: lock.spec.lockHash, operationId: pending.operationId, requestId: null, intentDigest: operation.intentDigest, dispatchGeneration: operation.dispatch.generation, dispatchId: operation.dispatch.dispatchId }, artifact: null as unknown as import('@loopwright/core').ArtifactRef } };
    if (operation.state === 'confirmed') {
      const settledReceipt = operation.reconciliation ?? operation.initialReceipt;
      if (!settledReceipt || settledReceipt.receiptId !== receipt.receiptId || settledReceipt.outcome !== receipt.outcome || !same(settledReceipt.evidence.subject, receipt.evidence.subject)) refuse('RECEIPT_CONFLICT', '/receipt', 'recovery');
      // The settled output must carry exactly the operator receipt body, byte for byte, or this is a conflict.
      const savedOutput = record(parsePrivateJson(await artifacts.read(settledReceipt.evidence.artifact, 65536), 65536), ['version', 'binding', 'observation', 'outcome', 'responseBytes', 'responseSignature']);
      if (!same(parsePrivateJson(Buffer.from(text(savedOutput.responseBytes), 'base64'), 65536), body)) refuse('RECEIPT_CONFLICT', '/receipt', 'recovery');
      outputRef = settledReceipt.evidence.artifact;
      receiptRef = settledProof ? settledProof.receiptRef : settledReceipt.evidence.artifact;
      (receipt.evidence as { artifact: import('@loopwright/core').ArtifactRef }).artifact = outputRef;
    } else if (settledProof) {
      // The on-disk proof already carries the settled live evidence (crash between .proof.json and recordOperationReceipt);
      // it is validated and adopted as-is — the live evidence field is never rewritten.
      const savedOutput = record(parsePrivateJson(await artifacts.read(settledProof.output, 65536), 65536), ['version', 'binding', 'observation', 'outcome', 'responseBytes', 'responseSignature']);
      const savedBytes = Buffer.from(text(savedOutput.responseBytes), 'base64');
      const savedChecked = savedOutput.version === 1 && (savedOutput.outcome === 'succeeded' || savedOutput.outcome === 'not_executed')
        ? verifyPublicationReceipt(parsePrivateJson(savedBytes, 65536), { storeId: original.storeId, runId: lock.spec.runId, lockHash: lock.spec.lockHash, operationId: pending.operationId, dispatchId: operation.dispatch!.dispatchId, dispatchGeneration: operation.dispatch!.generation, idempotencyKey: prepared.idempotencyKey, candidateDigest: subject.candidateDigest.hex }) : null;
      if (!savedChecked || savedChecked.outcome === 'failed'
        || !verifySignedPayload(state.vault.resolveNetworkCredential(endpoint.signingCredentialRef), savedBytes, text(savedOutput.responseSignature))) refuse('RECOVERY_REQUIRED', '', 'recovery');
      if (!same(parsePrivateJson(savedBytes, 65536), body)) refuse('RECEIPT_CONFLICT', '/receipt', 'recovery');
      outputRef = settledProof.output;
      (receipt.evidence as { artifact: import('@loopwright/core').ArtifactRef }).artifact = outputRef;
      receiptRef = settledProof.receiptRef;
      if (!same(parsePrivateJson(await artifacts.read(settledProof.receiptRef, 65536), 65536), receipt)) refuse('RECOVERY_REQUIRED', '', 'recovery');
      stateValue(store.reconcileOperation(authority, pending.operationId, receipt));
    } else {
      outputRef = await artifacts.json('publication-output', { version: 1, binding: { planDigest: plan.planDigest, operationId: pending.operationId, idempotencyKey: prepared.idempotencyKey, endpoint: endpoint.id, subject, requestDigest: prepared.requestDigest }, observation: { transport: 'completed' }, outcome, responseBytes: Buffer.from(canonical(body)).toString('base64'), responseSignature: text(file.signature) }, 65536);
      (receipt.evidence as { artifact: import('@loopwright/core').ArtifactRef }).artifact = outputRef;
      receiptRef = await artifacts.json('publication-receipt', receipt, 65536);
      await replaceMarker(prefix + '.proof.json', { version: 1, output: outputRef, receipt: receiptRef, evidence: null }, state.vault);
      stateValue(store.reconcileOperation(authority, pending.operationId, receipt));
    }
    const executionStatus = await publishReconcileOutcome(store, owner, artifacts, plan, lock, descriptor, head, authority, outcome, pending.operationId, receiptRef);
    if (executionStatus.authority !== null) authority = executionStatus.authority;
    if (executionStatus.status === null) {
      // resumeCycleWithPorts re-acquires the owner and reopens the store; release everything first so it never hits OWNER_BUSY.
      stateValue(store.release(authority)); authority = null;
      stateValue(store.close()); store = null;
      await owner.release(); owner = null;
      const execution = await resumeCycleWithPorts({ configuration: input.configuration, repository: descriptor.repository, runRoot: input.runRoot, runId: input.runId });
      if (!execution.ok || execution.value.kind !== 'result') refuse('RECOVERY_REQUIRED', '', 'recovery');
      const status = execution.value.result.spec.status;
      if (status === 'reconcile_required') return freeze({ kind: 'unresolved', version: 1, runId: lock.spec.runId, reason: 'remaining_unresolved_work' }) as ReconcileExecution;
      return freeze({ kind: 'settled', version: 1, runId: lock.spec.runId, status: status === 'completed' ? 'completed' : status === 'failed' ? 'failed' : 'blocked', outcome, externalEffects: execution.value.result.spec.externalEffects === 'confirmed' ? 'confirmed' : 'none', receipt: freeze(receipt) }) as ReconcileExecution;
    }
    if (executionStatus.status === 'reconcile_required') return freeze({ kind: 'unresolved', version: 1, runId: lock.spec.runId, reason: 'remaining_unresolved_work' }) as ReconcileExecution;
    if (executionStatus.status === 'incident_retained') return freeze({ kind: 'unresolved', version: 1, runId: lock.spec.runId, reason: 'incident_retained' }) as ReconcileExecution;
    return freeze({ kind: 'settled', version: 1, runId: lock.spec.runId, status: executionStatus.status === 'completed' ? 'completed' : 'failed', outcome, externalEffects: executionStatus.fx as 'confirmed' | 'none', receipt: freeze(receipt) }) as ReconcileExecution;
  } finally {
    if (store) { if (authority) stateValue(store.release(authority)); stateValue(store.close()); }
    if (owner) await owner.release();
  }
}
/** Supersedes a retained reconcile_required terminal result in place when the run has already terminalized. */
async function publishReconcileOutcome(store: LocalRunStore, owner: ControllerOwner, artifacts: ArtifactStore, plan: import('./types.js').CompiledPlan, lock: import('@loopwright/core').TaskLock,
  descriptor: import('./controller.js').RunDescriptor, head: import('./progress.js').ProgressHead, authority: Authority, outcome: 'succeeded' | 'not_executed', operationId: string, receiptRef: import('@loopwright/core').ArtifactRef): Promise<{ readonly status: 'completed' | 'failed' | 'reconcile_required' | 'incident_retained' | null; readonly fx: 'confirmed' | 'none' | 'unknown'; readonly authority: Authority | null }> {
  const prior = head.progress.terminalIntent;
  if (head.progress.stage.kind !== 'reconcile_result' && (head.progress.stage.kind.startsWith('terminal') || prior !== null && prior.primary === 'reconcile_required')) {
    if (!prior?.result) refuse('RECOVERY_REQUIRED', '', 'recovery');
    let raw: unknown; try { raw = parsePrivateJson(await artifacts.read(prior.result, 1048576), 1048576); } catch { refuse('RECOVERY_REQUIRED', '', 'recovery'); }
    const priorResult = validateDocument(raw, 'RunResult');
    if (!priorResult.ok) {
      // An immutable incident primary is never overwritten: the verified receipt lands in the journal and in the
      // reconcile.result observations (exported as publication.json), while the run stays unresolved incident_retained.
      const incidentDoc = record(raw, ['version', 'code', 'runId', 'lockHash', 'stage', 'knownReferences', 'unavailable', 'cleanup']);
      if (incidentDoc.version !== 1 || incidentDoc.runId !== lock.spec.runId || !same(incidentDoc.lockHash, lock.spec.lockHash) || incidentDoc.code !== prior.primary) refuse('RECOVERY_REQUIRED', '', 'recovery');
      const current = stateValue(store.inspect());
      const stillUnresolved = current.counts.dispatchedRequests > 0 || current.counts.unresolvedRequests > 0 || current.counts.unresolvedOperations > 0 || current.ledger.violations.length > 0;
      if (!stillUnresolved && head.progress.stage.kind.startsWith('terminal') && head.progress.publication.status === (outcome === 'succeeded' ? 'confirmed' : 'failed')) return { status: 'incident_retained', fx: 'unknown', authority: null };
      let observations: Record<string, unknown> | null = null;
      if (prior.observations) { try { observations = parsePrivateJson(await artifacts.read(prior.observations, 1048576), 1048576) as Record<string, unknown>; } catch { observations = null; } }
      const observationsRef = await artifacts.json('observations', { ...(observations ?? { version: 1, events: null }), primary: prior.result, publication: stillUnresolved ? { status: 'unresolved', reason: 'remaining_unresolved_work', receipt: null } : { status: outcome === 'succeeded' ? 'confirmed' : 'failed', reason: outcome === 'succeeded' ? null : 'not_executed', receipt: receiptRef } }, 1048576);
      stateValue(store.release(authority));
      const claimed = stateValue(store.inspect());
      const active = stateValue(store.claim({ ownerId: 'controller.' + owner.nonce, expectedGeneration: claimed.owner.generation, expectedRevision: claimed.revision, mode: 'active' })).authority;
      try {
        const progress = new ProgressStore(store, active, artifacts, plan, lock, descriptor.plan, descriptor.source);
        await progress.publish({ ...head.progress, stage: { ...head.progress.stage, kind: 'reconcile_result' }, publication: { status: outcome === 'succeeded' ? 'confirmed' : 'failed', operationId, receipt: receiptRef }, terminalIntent: { primary: prior.primary, result: prior.result, observations: observationsRef } }, 'reconcile.result');
      } finally { stateValue(store.release(active)); }
      const currentAfter = stateValue(store.inspect());
      const restored = stateValue(store.claim({ ownerId: 'controller.' + owner.nonce, expectedGeneration: currentAfter.owner.generation, expectedRevision: currentAfter.revision, mode: 'recovery' })).authority;
      return { status: stillUnresolved ? 'reconcile_required' : 'incident_retained', fx: 'unknown', authority: restored };
    }
    const current = stateValue(store.inspect());
    const stillUnresolved = current.counts.dispatchedRequests > 0 || current.counts.unresolvedRequests > 0 || current.counts.unresolvedOperations > 0 || current.ledger.violations.length > 0;
    const status = stillUnresolved ? 'reconcile_required' as const : outcome === 'succeeded' ? 'completed' as const : 'failed' as const;
    const fx = stillUnresolved ? 'unknown' as const : outcome === 'succeeded' ? 'confirmed' as const : 'none' as const;
    // An already-settled terminal run that matches this receipt reports the settled outcome without a redundant checkpoint.
    if (!stillUnresolved && head.progress.stage.kind.startsWith('terminal') && prior !== null && prior.primary === status
      && head.progress.publication.status === (outcome === 'succeeded' ? 'confirmed' : 'failed')) return { status, fx, authority: null };
    const updated = validateDocument({ ...(raw as object), spec: { ...(raw as { spec: Record<string, unknown> }).spec, status, externalEffects: fx } }, 'RunResult');
    if (!updated.ok) refuse('RECOVERY_REQUIRED', '', 'recovery');
    const primaryRef = await artifacts.json('result', updated.value, 1048576);
    let observations: Record<string, unknown> | null = null;
    if (prior.observations) { try { observations = parsePrivateJson(await artifacts.read(prior.observations, 1048576), 1048576) as Record<string, unknown>; } catch { observations = null; } }
    const observationsRef = await artifacts.json('observations', { ...(observations ?? { version: 1, events: null }), primary: primaryRef, publication: stillUnresolved ? { status: 'unresolved', reason: 'remaining_unresolved_work', receipt: null } : { status: outcome === 'succeeded' ? 'confirmed' : 'failed', reason: outcome === 'succeeded' ? null : 'not_executed', receipt: receiptRef } }, 1048576);
    stateValue(store.release(authority));
    const claimed = stateValue(store.inspect());
    const active = stateValue(store.claim({ ownerId: 'controller.' + owner.nonce, expectedGeneration: claimed.owner.generation, expectedRevision: claimed.revision, mode: 'active' })).authority;
    try {
      const progress = new ProgressStore(store, active, artifacts, plan, lock, descriptor.plan, descriptor.source);
      await progress.publish({ ...head.progress, stage: { ...head.progress.stage, kind: 'reconcile_result' }, publication: { status: outcome === 'succeeded' ? 'confirmed' : 'failed', operationId, receipt: receiptRef }, terminalIntent: { primary: status, result: primaryRef, observations: observationsRef } }, 'reconcile.result');
    } finally { stateValue(store.release(active)); }
    const currentAfter = stateValue(store.inspect());
    const restored = stateValue(store.claim({ ownerId: 'controller.' + owner.nonce, expectedGeneration: currentAfter.owner.generation, expectedRevision: currentAfter.revision, mode: 'recovery' })).authority;
    return { status, fx, authority: restored };
  }
  if (head.progress.stage.kind === 'reconcile_result') return await stillUnresolvedView(store, outcome, head, artifacts);
  return { status: null, fx: 'none', authority: null };
}
async function stillUnresolvedView(store: LocalRunStore, outcome: 'succeeded' | 'not_executed', head: import('./progress.js').ProgressHead, artifacts: ArtifactStore): Promise<{ readonly status: 'completed' | 'failed' | 'reconcile_required' | 'incident_retained' | null; readonly fx: 'confirmed' | 'none' | 'unknown'; readonly authority: null }> {
  const current = stateValue(store.inspect());
  const stillUnresolved = current.counts.dispatchedRequests > 0 || current.counts.unresolvedRequests > 0 || current.counts.unresolvedOperations > 0 || current.ledger.violations.length > 0;
  if (!stillUnresolved && head.progress.terminalIntent?.result) {
    let raw: unknown; try { raw = parsePrivateJson(await artifacts.read(head.progress.terminalIntent.result, 1048576), 1048576); } catch { refuse('RECOVERY_REQUIRED', '', 'recovery'); }
    if (!validateDocument(raw, 'RunResult').ok) return { status: 'incident_retained', fx: 'unknown', authority: null };
  }
  return { status: stillUnresolved ? 'reconcile_required' : outcome === 'succeeded' ? 'completed' : 'failed', fx: stillUnresolved ? 'unknown' : outcome === 'succeeded' ? 'confirmed' : 'none', authority: null };
}
