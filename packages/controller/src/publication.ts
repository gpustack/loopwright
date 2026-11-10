import { execFileSync } from 'node:child_process';
import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { join } from 'node:path';
import { validateDocument, type Digest, type Subject, type TaskLock, type ArtifactRef } from '@loopwright/core';
import type { Authority, DispatchPermit, LocalRunStore, OperationReceipt } from '@loopwright/state';
import { ArtifactStore, checkedRef, stateValue } from './storage.js';
import { readBoundedFile } from './files.js';
import { GIT_ENVIRONMENT } from './git-reader.js';
import { canonical, freeze, hash, record, same, text } from './schema.js';
import { parsePrivateJson } from './parser.js';
import { ControllerFailure, refuse } from './errors.js';
import { signPayload, verifySignedPayload } from './gate.js';
import type { PublicationEndpoint, CompiledPlan } from './types.js';
/** One deterministic publication identity per run; the idempotency key is stable across replays and controllers. */
export function publicationOperationId(runId: string, lockHash: Digest): string { return 'publish.' + hash('loopwright.dev/controller/publication-op/v1\0' + canonical({ runId, lockHash })).hex.slice(0, 40); }
export interface PreparedPublication { readonly version: 1; readonly operationId: string; readonly idempotencyKey: string; readonly requestDigest: Digest; readonly title: string; readonly headBranch: string }
interface PublicationPreparation { readonly subject: Subject }
const preparations = new WeakMap<PreparedPublication, PublicationPreparation>();
/** Pure preparation: no intent, permit, timer, credential or network operation. */
export function preparePublication(plan: CompiledPlan, lock: TaskLock, storeId: string, endpoint: PublicationEndpoint, subject: Subject): PreparedPublication {
  if (!same(plan.task, lock.spec.contract) || plan.publication.mode !== 'pull_request') refuse('ARTIFACT_INVALID', '', 'execution');
  const operationId = publicationOperationId(lock.spec.runId, lock.spec.lockHash);
  const idempotencyKey = 'pub.' + hash('loopwright.dev/publication/v1\0' + canonical({ storeId, runId: lock.spec.runId, lockHash: lock.spec.lockHash, candidateDigest: subject.candidateDigest, targetBranch: plan.publication.targetBranch, operationId })).hex.slice(0, 40);
  const headBranch = plan.publication.headBranchPrefix + lock.spec.runId;
  const title = plan.publication.titleTemplate
    .replace(/\$\{lockHash\}/g, lock.spec.lockHash.hex.slice(0, 12)).replace(/\$\{repository\}/g, plan.task.spec.target.repository)
    .replace(/\$\{runId\}/g, lock.spec.runId).replace(/\$\{candidateDigest\}/g, subject.candidateDigest.hex.slice(0, 12));
  const requestDigest = hash('loopwright.dev/controller/publication-request/v1\0' + canonical({ planDigest: plan.planDigest, endpoint: endpoint.id, idempotencyKey, candidateDigest: subject.candidateDigest, targetBranch: plan.publication.targetBranch, headBranch, title }));
  const prepared: PreparedPublication = freeze({ version: 1, operationId, idempotencyKey, requestDigest, title, headBranch });
  preparations.set(prepared, { subject }); return prepared;
}
export type PublicationResult = { readonly kind: 'settled'; readonly outcome: 'succeeded' | 'not_executed'; readonly receiptRef: ArtifactRef; readonly receipt: OperationReceipt }
  | { readonly kind: 'unresolved'; readonly reason: 'timeout' | 'connection_lost' };
export interface PublicationReceiptExpectation { readonly storeId: string; readonly runId: string; readonly lockHash: Digest; readonly operationId: string; readonly dispatchId: string; readonly dispatchGeneration: number; readonly idempotencyKey: string; readonly candidateDigest: string }
/** Single receipt validator for live responses, restore, and operator reconciliation. */
export function verifyPublicationReceipt(raw: unknown, expected: PublicationReceiptExpectation): { readonly outcome: 'succeeded' | 'not_executed' | 'failed'; readonly externalUrl: string | null; readonly reason: string | null } | null {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const hasCandidate = Object.hasOwn(raw as object, 'candidateDigest');
  let value: Record<string, unknown>;
  try { value = record(raw, ['version', 'kind', 'storeId', 'runId', 'lockHash', 'operationId', 'dispatchId', 'dispatchGeneration', 'idempotencyKey', 'outcome', 'externalUrl', 'reason', ...(hasCandidate ? ['candidateDigest' as const] : [])]); }
  catch { return null; }
  const binding = { version: 1, kind: 'publication_receipt', storeId: expected.storeId, runId: expected.runId, lockHash: expected.lockHash, operationId: expected.operationId, dispatchId: expected.dispatchId, dispatchGeneration: expected.dispatchGeneration, idempotencyKey: expected.idempotencyKey };
  if (!same(value, { ...binding, outcome: value.outcome, externalUrl: value.externalUrl, reason: value.reason, ...(hasCandidate ? { candidateDigest: value.candidateDigest } : {}) })) return null;
  if (!['succeeded', 'not_executed', 'failed'].includes(text(value.outcome))) return null;
  if (hasCandidate && value.candidateDigest !== expected.candidateDigest) return null;
  if (value.externalUrl !== null && (typeof value.externalUrl !== 'string' || value.externalUrl.length > 512)) return null;
  if (value.reason !== null && (typeof value.reason !== 'string' || value.reason.length > 256)) return null;
  return { outcome: text(value.outcome) as 'succeeded' | 'not_executed' | 'failed', externalUrl: value.externalUrl as string | null, reason: value.reason as string | null };
}
function headRevision(repository: string): string {
  try { return execFileSync('/usr/bin/git', ['-c', 'core.hooksPath=/dev/null', 'rev-parse', 'HEAD'], { cwd: repository, env: { ...GIT_ENVIRONMENT, HOME: '/nonexistent', GIT_CONFIG_GLOBAL: '/dev/null', GIT_TERMINAL_PROMPT: '0' }, timeout: 5000, encoding: 'utf8' }).trim(); }
  catch { return ''; }
}
export { headRevision };
/** Controlled external_write publisher; intent-before-dispatch with the same receipt discipline as gates. */
export class Publication {
  constructor(readonly store: LocalRunStore, readonly authority: Authority, readonly artifacts: ArtifactStore, readonly plan: CompiledPlan, readonly lock: TaskLock,
    readonly resolveCredential: (ref: string) => string, readonly currentSubject: () => Subject, readonly repository: string) {}
  #identity() {
    const view = stateValue(this.store.inspect());
    if (view.storeId !== this.authority.storeId || view.runId !== this.lock.spec.runId || !same(view.lockHash, this.lock.spec.lockHash)
      || this.artifacts.owner.runId !== view.runId || !same(this.artifacts.owner.planDigest, this.plan.planDigest)) refuse('AUTHORITY_REFUSED', '', 'execution'); return view;
  }
  async #marker(operationId: string, kind: 'binding' | 'proof', value: unknown): Promise<void> {
    await this.artifacts.owner.assertCurrent(); const name = 'publication-producer-' + hash(operationId).hex + '.' + kind + '.json', path = join(this.artifacts.directory, name), bytes = Buffer.from(canonical(value));
    if (bytes.byteLength > 1048576) refuse('OUTPUT_LIMIT', '', 'execution'); this.artifacts.vault.assertClean(bytes);
    let file: Awaited<ReturnType<typeof open>>;
    try { file = await open(path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST' || !Buffer.from(await readBoundedFile(path, 1048576, true)).equals(bytes)) refuse('RECOVERY_REQUIRED', '', 'execution'); return; }
    try { await file.writeFile(bytes); await file.sync(); } finally { await file.close(); }
  }
  #permit(permit: DispatchPermit, expected: Subject, target: string): void {
    stateValue(this.store.renew(this.authority)); const view = stateValue(this.store.inspect()), operation = stateValue(this.store.getOperation(permit.operationId));
    if (!same(this.currentSubject(), expected) || permit.generation !== this.authority.generation || permit.clockEpoch !== view.clock.basis.clockEpoch
      || view.storeId !== permit.storeId || view.runId !== permit.runId || !same(view.lockHash, permit.lockHash)
      || BigInt(view.clock.sampledNow.monotonicMs) >= BigInt(permit.notAfterMonotonicMs)
      || operation.state !== 'dispatch_uncertain' || operation.dispatch?.dispatchId !== permit.dispatchId || operation.intent.targetIdentity !== target) refuse('AUTHORITY_REFUSED', '', 'execution');
  }
  #checkedReceipt(bytes: Uint8Array, expected: PublicationReceiptExpectation, secret: string, signature: string): 'succeeded' | 'not_executed' | 'failed' | null {
    if (!signature || !verifySignedPayload(secret, bytes, signature)) return null;
    let parsed: unknown; try { parsed = parsePrivateJson(Buffer.from(bytes), 65536); } catch { return null; }
    const checked = verifyPublicationReceipt(parsed, expected);
    return checked && checked.outcome !== 'failed' ? checked.outcome : checked ? 'failed' : null;
  }
  /** Eligibility is checked by the cycle; this sends the signed publication request once and settles the receipt. */
  async run(prepared: PreparedPublication, endpoint: PublicationEndpoint, signal: AbortSignal): Promise<PublicationResult> {
    const data = preparations.get(prepared); if (!data) refuse('EVIDENCE_UNAVAILABLE', '', 'execution');
    signal.throwIfAborted(); await this.artifacts.owner.assertCurrent(); if (!same(this.currentSubject(), data.subject)) refuse('ARTIFACT_INVALID', '', 'execution');
    const done = await this.artifacts.owner.holdLocalActivity();
    try {
      const target = 'publication:' + this.lock.spec.runId + ':' + data.subject.candidateDigest.hex;
      const before = this.#identity(); if (before.owner.mode !== 'active') refuse('AUTHORITY_REFUSED', '', 'execution');
      if (before.counts.dispatchedRequests || before.counts.unresolvedRequests || before.counts.unresolvedOperations || before.ledger.violations.length) refuse('RECOVERY_REQUIRED', '', 'execution');
      const targetRevisions = [this.plan.task.spec.target.baseRevision, this.plan.task.spec.target.sourceRevision];
      if (!targetRevisions.includes(headRevision(this.repository))) refuse('TARGET_MISMATCH', '', 'execution');
      stateValue(this.store.putIntent(this.authority, { operationId: prepared.operationId, nodeId: this.plan.orderedDAG[0]!.id, attemptId: prepared.idempotencyKey, effect: 'external_write', requestDigest: prepared.requestDigest, targetIdentity: target }));
      stateValue(this.store.renew(this.authority));
      const dispatched = stateValue(this.store.authorizeOperationDispatch(this.authority, prepared.operationId)); if (dispatched.kind !== 'new_dispatch') refuse('RECOVERY_REQUIRED', '', 'execution'); const permit = dispatched.permit;
      const operation = stateValue(this.store.getOperation(prepared.operationId));
      const request: Record<string, unknown> = { version: 1, kind: 'publication_request', storeId: before.storeId, runId: before.runId, lockHash: before.lockHash, operationId: prepared.operationId, dispatchId: permit.dispatchId, dispatchGeneration: permit.generation, idempotencyKey: prepared.idempotencyKey, targetBranch: this.plan.publication.mode === 'pull_request' ? this.plan.publication.targetBranch : '', headBranch: prepared.headBranch, title: prepared.title, candidateDigest: data.subject.candidateDigest.hex, baseRevision: this.plan.task.spec.target.baseRevision, sourceRevision: this.plan.task.spec.target.sourceRevision, requestDigest: prepared.requestDigest.hex };
      const binding = { storeId: before.storeId, runId: before.runId, lockHash: before.lockHash, operationId: prepared.operationId, dispatchId: permit.dispatchId, dispatchGeneration: permit.generation, idempotencyKey: prepared.idempotencyKey };
      const expectation: PublicationReceiptExpectation = { ...binding, candidateDigest: data.subject.candidateDigest.hex };
      await this.#marker(prepared.operationId, 'binding', { version: 1, planDigest: this.plan.planDigest, operationId: prepared.operationId, requestDigest: prepared.requestDigest, requestBytesDigest: hash(Buffer.from(canonical(request))).hex, intentDigest: operation.intentDigest, subject: data.subject, endpoint: endpoint.id,
        dispatchReceipt: { generation: permit.generation, dispatchId: permit.dispatchId, revision: permit.authorizedRevision, clockEpoch: permit.clockEpoch } });
      const secret = this.resolveCredential(endpoint.signingCredentialRef), body = Buffer.from(canonical(request));
      const headers: Record<string, string> = { 'content-type': 'application/json', 'x-loopwright-signature': signPayload(secret, body) };
      if (endpoint.authCredentialRef !== null) headers.authorization = 'Bearer ' + this.resolveCredential(endpoint.authCredentialRef);
      // The POST timeout is clamped to the permit lease and the remaining task window, mirroring Gate.run's poll clamp.
      const startMono = BigInt(stateValue(this.store.inspect()).clock.sampledNow.monotonicMs);
      const permitCapMono = BigInt(permit.notAfterMonotonicMs) > 2000n ? BigInt(permit.notAfterMonotonicMs) - 2000n : BigInt(permit.notAfterMonotonicMs);
      const drain = BigInt(this.plan.controls.drainReserveMs);
      const taskCapMono = BigInt(before.clock.basis.taskDeadlineMonotonicMs) > drain + 2000n ? BigInt(before.clock.basis.taskDeadlineMonotonicMs) - drain - 2000n : BigInt(before.clock.basis.taskDeadlineMonotonicMs);
      const deadlineMono = permitCapMono < taskCapMono ? permitCapMono : taskCapMono;
      let responseBytes: Uint8Array | null = null, signature: string | null = null, outcome: 'succeeded' | 'not_executed' | null = null, reason: 'timeout' | 'connection_lost' = 'timeout';
      if (startMono < deadlineMono) try {
        const response = await fetch(endpoint.url, { method: 'POST', headers, body: new Uint8Array(body), redirect: 'error', signal: AbortSignal.any([signal, AbortSignal.timeout(Math.max(50, Math.min(endpoint.timeoutMs, Number(deadlineMono - startMono))))]) });
        if (response.status === 200 && (response.headers.get('content-type') ?? '').startsWith('application/json')) {
          const bytes = new Uint8Array(await response.arrayBuffer());
          if (bytes.byteLength <= 65536) {
            const header = response.headers.get('x-loopwright-signature') ?? '';
            const checked = this.#checkedReceipt(bytes, expectation, secret, header);
            if (checked !== null && targetRevisions.includes(headRevision(this.repository))) {
              responseBytes = bytes; signature = header;
              if (checked !== 'failed') outcome = checked; else reason = 'connection_lost';
            }
          }
        }
      } catch (error) { reason = signal.aborted || (error as Error).name === 'TimeoutError' || (error as Error).name === 'AbortError' ? 'timeout' : 'connection_lost'; }
      // A body that only finished arriving after the permit expired must not settle; it reconciles as unresolved instead.
      stateValue(this.store.renew(this.authority));
      const view = stateValue(this.store.inspect());
      if (outcome !== null && (!same(this.currentSubject(), data.subject) || permit.generation !== this.authority.generation || permit.clockEpoch !== view.clock.basis.clockEpoch || BigInt(view.clock.sampledNow.monotonicMs) >= BigInt(permit.notAfterMonotonicMs))) { outcome = null; responseBytes = null; signature = null; reason = 'timeout'; }
      const suffix = hash(prepared.operationId + '\0' + prepared.idempotencyKey).hex.slice(0, 40);
      const output = await this.artifacts.json('publication-output', { version: 1, binding: { planDigest: this.plan.planDigest, operationId: prepared.operationId, idempotencyKey: prepared.idempotencyKey, endpoint: endpoint.id, subject: data.subject, requestDigest: prepared.requestDigest }, observation: { transport: outcome ? 'completed' : reason }, outcome: outcome ?? null, responseBytes: responseBytes ? Buffer.from(responseBytes).toString('base64') : null, responseSignature: signature }, 65536);
      if (outcome === null) {
        await this.#marker(prepared.operationId, 'proof', { version: 1, output, receipt: null, evidence: null });
        stateValue(this.store.markOperationUnresolved(this.authority, prepared.operationId, reason));
        return freeze({ kind: 'unresolved', reason });
      }
      const evidenceResult = validateDocument({ apiVersion: 'loopwright.dev/v1alpha1', kind: 'Evidence', metadata: { id: 'evidence.' + suffix }, spec: { checkId: 'publication', observedStatus: 'passed', producerId: 'loopwright.publisher.v1', method: 'publish_external', level: 'external_service', subject: data.subject, artifacts: [output], reason: null } }, 'Evidence');
      if (!evidenceResult.ok) refuse('RECOVERY_REQUIRED', '', 'execution');
      const receipt: OperationReceipt = { receiptId: 'receipt.' + suffix, outcome,
        evidence: { evidenceId: 'receipt-evidence.' + suffix, producerId: 'loopwright.publisher.v1', method: 'publish_external',
          subject: { storeId: view.storeId, runId: view.runId, lockHash: view.lockHash, operationId: prepared.operationId, requestId: null, intentDigest: operation.intentDigest, dispatchGeneration: permit.generation, dispatchId: permit.dispatchId }, artifact: output } };
      const receiptRef = await this.artifacts.json('publication-receipt', receipt, 65536);
      await this.#marker(prepared.operationId, 'proof', { version: 1, output, receipt: receiptRef, evidence: evidenceResult.value });
      this.#permit(permit, data.subject, target); stateValue(this.store.recordOperationReceipt(this.authority, prepared.operationId, receipt));
      return freeze({ kind: 'settled', outcome, receiptRef, receipt: freeze(receipt) });
    } finally { done(); }
  }
  /** Original private producer proof only; retained response bytes are re-authenticated against the configured secret. */
  async restore(prepared: PreparedPublication, endpoint: PublicationEndpoint): Promise<PublicationResult> {
    const data = preparations.get(prepared); if (!data) refuse('EVIDENCE_UNAVAILABLE', '', 'recovery');
    const operation = stateValue(this.store.getOperation(prepared.operationId)), view = this.#identity(), dispatch = operation.dispatch;
    if (!dispatch || view.clockStatus !== 'trusted' || operation.intent.effect !== 'external_write' || operation.linkedRequestId !== null || !same(operation.intent.requestDigest, prepared.requestDigest)
      || operation.intent.attemptId !== prepared.idempotencyKey
      || operation.intent.targetIdentity !== 'publication:' + this.lock.spec.runId + ':' + data.subject.candidateDigest.hex) refuse('RECOVERY_REQUIRED', '', 'recovery');
    const prefix = join(this.artifacts.directory, 'publication-producer-' + hash(prepared.operationId).hex);
    let bindingBytes: Buffer;
    try { bindingBytes = await readBoundedFile(prefix + '.binding.json', 1048576, true); }
    catch (error) { if (error instanceof ControllerFailure && error.diagnostic.code === 'REGISTRY_UNTRUSTED') refuse('RECOVERY_REQUIRED', '', 'recovery'); throw error; }
    const binding = record(parsePrivateJson(bindingBytes, 1048576), ['version', 'planDigest', 'operationId', 'requestDigest', 'requestBytesDigest', 'intentDigest', 'subject', 'endpoint', 'dispatchReceipt']);
    const receiptBinding = record(binding.dispatchReceipt, ['generation', 'dispatchId', 'revision', 'clockEpoch']);
    if (receiptBinding.generation !== dispatch.generation || receiptBinding.dispatchId !== dispatch.dispatchId || receiptBinding.revision !== dispatch.revision || receiptBinding.clockEpoch !== view.clock.basis.clockEpoch) refuse('RECOVERY_REQUIRED', '', 'recovery');
    const request: Record<string, unknown> = { version: 1, kind: 'publication_request', storeId: view.storeId, runId: view.runId, lockHash: view.lockHash, operationId: prepared.operationId, dispatchId: dispatch.dispatchId, dispatchGeneration: dispatch.generation, idempotencyKey: prepared.idempotencyKey, targetBranch: this.plan.publication.mode === 'pull_request' ? this.plan.publication.targetBranch : '', headBranch: prepared.headBranch, title: prepared.title, candidateDigest: data.subject.candidateDigest.hex, baseRevision: this.plan.task.spec.target.baseRevision, sourceRevision: this.plan.task.spec.target.sourceRevision, requestDigest: prepared.requestDigest.hex };
    if (binding.version !== 1 || !same(binding.planDigest, this.plan.planDigest) || binding.operationId !== prepared.operationId || !same(binding.requestDigest, prepared.requestDigest)
      || !same(binding.requestBytesDigest, hash(Buffer.from(canonical(request))).hex) || !same(binding.intentDigest, operation.intentDigest) || binding.endpoint !== endpoint.id || !same(binding.subject, data.subject)
      || !same(binding.dispatchReceipt, { generation: dispatch.generation, dispatchId: dispatch.dispatchId, revision: dispatch.revision, clockEpoch: view.clock.basis.clockEpoch })) refuse('RECOVERY_REQUIRED', '', 'recovery');
    if (operation.state === 'unresolved') return freeze({ kind: 'unresolved', reason: 'connection_lost' });
    let proofBytes: Buffer;
    try { proofBytes = await readBoundedFile(prefix + '.proof.json', 1048576, true); }
    catch (error) {
      if (error instanceof ControllerFailure && error.diagnostic.code === 'REGISTRY_UNTRUSTED' && operation.state === 'dispatch_uncertain') {
        await this.artifacts.owner.assertCurrent(); if (!same(this.currentSubject(), data.subject)) refuse('RECOVERY_REQUIRED', '', 'recovery'); stateValue(this.store.renew(this.authority));
        const output = await this.artifacts.json('publication-output', { version: 1, binding: { planDigest: this.plan.planDigest, operationId: prepared.operationId, idempotencyKey: prepared.idempotencyKey, endpoint: endpoint.id, subject: data.subject, requestDigest: prepared.requestDigest }, observation: { transport: 'connection_lost' }, outcome: null, responseBytes: null, responseSignature: null }, 65536);
        await this.#marker(prepared.operationId, 'proof', { version: 1, output, receipt: null, evidence: null });
        stateValue(this.store.markOperationUnresolved(this.authority, prepared.operationId, 'connection_lost'));
        return freeze({ kind: 'unresolved', reason: 'connection_lost' });
      }
      if (error instanceof ControllerFailure && error.diagnostic.code === 'REGISTRY_UNTRUSTED') refuse('RECOVERY_REQUIRED', '', 'recovery');
      throw error;
    }
    const proof = record(parsePrivateJson(proofBytes, 1048576), ['version', 'output', 'receipt', 'evidence']);
    const output = checkedRef(proof.output);
    if (proof.receipt === null && operation.state === 'dispatch_uncertain') {
      // The proof was written unresolved (timeout / connection_lost) right before markOperationUnresolved — the crash
      // window between the two writes. Re-derive the reason from the saved observation and finish the demotion.
      const savedUnresolved = record(parsePrivateJson(await this.artifacts.read(output, 65536), 65536), ['version', 'binding', 'observation', 'outcome', 'responseBytes', 'responseSignature']);
      const transport = record(savedUnresolved.observation, ['transport']).transport;
      const reason: 'timeout' | 'connection_lost' = transport === 'timeout' ? 'timeout' : 'connection_lost';
      await this.artifacts.owner.assertCurrent(); if (!same(this.currentSubject(), data.subject)) refuse('RECOVERY_REQUIRED', '', 'recovery'); stateValue(this.store.renew(this.authority));
      stateValue(this.store.markOperationUnresolved(this.authority, prepared.operationId, reason));
      return freeze({ kind: 'unresolved', reason });
    }
    const receiptRef = checkedRef(proof.receipt);
    const saved = record(parsePrivateJson(await this.artifacts.read(output, 65536), 65536), ['version', 'binding', 'observation', 'outcome', 'responseBytes', 'responseSignature']);
    if (saved.version !== 1 || saved.outcome !== 'succeeded' && saved.outcome !== 'not_executed' || typeof saved.responseBytes !== 'string' || typeof saved.responseSignature !== 'string') refuse('RECOVERY_REQUIRED', '', 'recovery');
    const responseBytes = Buffer.from(saved.responseBytes, 'base64');
    if (!verifySignedPayload(this.resolveCredential(endpoint.signingCredentialRef), responseBytes, saved.responseSignature)) refuse('EVIDENCE_UNAVAILABLE', '', 'recovery');
    const expected = { storeId: view.storeId, runId: view.runId, lockHash: view.lockHash, operationId: prepared.operationId, dispatchId: dispatch.dispatchId, dispatchGeneration: dispatch.generation, idempotencyKey: prepared.idempotencyKey, candidateDigest: data.subject.candidateDigest.hex };
    const checked = verifyPublicationReceipt(parsePrivateJson(responseBytes, 65536), expected);
    if (!checked || checked.outcome !== saved.outcome) refuse('RECOVERY_REQUIRED', '', 'recovery');
    const suffix = hash(prepared.operationId + '\0' + prepared.idempotencyKey).hex.slice(0, 40);
    const rebuilt: OperationReceipt = { receiptId: 'receipt.' + suffix, outcome: saved.outcome as 'succeeded' | 'not_executed',
      evidence: { evidenceId: 'receipt-evidence.' + suffix, producerId: 'loopwright.publisher.v1', method: 'publish_external',
        subject: { storeId: view.storeId, runId: view.runId, lockHash: view.lockHash, operationId: prepared.operationId, requestId: null, intentDigest: operation.intentDigest, dispatchGeneration: dispatch.generation, dispatchId: dispatch.dispatchId }, artifact: output } };
    if (!same(parsePrivateJson(await this.artifacts.read(receiptRef, 65536), 65536), rebuilt)) refuse('RECOVERY_REQUIRED', '', 'recovery');
    await this.artifacts.owner.assertCurrent(); if (!same(this.currentSubject(), data.subject)) refuse('RECOVERY_REQUIRED', '', 'recovery'); stateValue(this.store.renew(this.authority));
    if (operation.state === 'confirmed') { if (!same(operation.reconciliation ?? operation.initialReceipt, rebuilt)) refuse('RECOVERY_REQUIRED', '', 'recovery'); }
    else stateValue(this.store.reconcileOperation(this.authority, prepared.operationId, rebuilt));
    const outcome = rebuilt.outcome as 'succeeded' | 'not_executed';
    return freeze({ kind: 'settled', outcome, receiptRef, receipt: freeze(rebuilt) });
  }
}
