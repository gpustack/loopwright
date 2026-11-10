import { createHmac, timingSafeEqual } from 'node:crypto';
import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { join } from 'node:path';
import { bindSubject, validateDocument, type Digest, type Evidence, type Subject, type TaskLock } from '@loopwright/core';
import type { Authority, DispatchPermit, LocalRunStore, OperationReceipt, RunView, OperationRecord } from '@loopwright/state';
import { ArtifactStore, checkedRef, stateValue } from './storage.js';
import { readBoundedFile } from './files.js';
import { canonical, freeze, hash, integer, record, same, text } from './schema.js';
import { parsePrivateJson } from './parser.js';
import { ControllerFailure, refuse } from './errors.js';
import { verifierOperationId } from './progress.js';
import type { GateEndpoint, CompiledPlan, VerifierSlot } from './types.js';
import type { ByteInventory, VerifiedCheck } from './verification.js';
/** Exactly one HMAC verifier for gates, publication, and reconciliation; comparison is constant time. */
export function verifySignedPayload(secret: string, payload: Uint8Array | string, expectedHex: string): boolean {
  const hex = expectedHex.startsWith('sha256=') ? expectedHex.slice(7) : expectedHex;
  if (!/^[0-9a-f]{64}$/.test(hex)) return false;
  const expected = Buffer.from(hex, 'hex'), observed = createHmac('sha256', secret).update(payload).digest();
  return expected.length === observed.length && timingSafeEqual(expected, observed);
}
export function signPayload(secret: string, payload: Uint8Array | string): string { return createHmac('sha256', secret).update(payload).digest('hex'); }
export interface GateWaitDetail { readonly operationId: string; readonly gateId: string; readonly elapsedMs: number; readonly nextPollMs: number; readonly deadlineMs: number }
export interface PreparedGate { readonly version: 1; readonly slotId: string; readonly generation: number; readonly operationId: string; readonly producerNonce: string; readonly requestDigest: Digest }
interface GatePreparation { readonly slot: VerifierSlot; readonly endpoint: GateEndpoint; readonly subject: Subject; readonly candidateDigest: Digest; readonly candidateBytes: number }
const preparations = new WeakMap<PreparedGate, GatePreparation>();
interface GateObservation { readonly evidence: Evidence; readonly subject: Subject; readonly outputBytes: Uint8Array; readonly receipt: OperationReceipt; readonly planDigest: Digest; readonly requestDigest: Digest;
  readonly header: { readonly handlerDigest: Digest; readonly handler: 'gate.v1'; readonly candidate: { readonly ref: { readonly digest: Digest; readonly byteLength: number } } } }
const observations = new WeakMap<VerifiedCheck, GateObservation>();
export function authenticatedGate(value: VerifiedCheck): GateObservation { const trusted = observations.get(value); if (!trusted) refuse('EVIDENCE_UNAVAILABLE', '', 'verification'); return trusted; }
const verdictStatuses = ['pending', 'approved', 'denied', 'expired'] as const;
type Verdict = { readonly status: (typeof verdictStatuses)[number]; readonly reason: string | null; readonly expiresAtMs: string };
type RoundTrip = { readonly kind: 'verdict'; readonly verdict: Verdict; readonly responseBytes: Uint8Array; readonly signature: string } | { readonly kind: 'invalid' } | { readonly kind: 'network' };
type Disposition = { readonly status: VerifiedCheck['status']; readonly reason: string | null; readonly method: string };
const RESPONSE_BYTES = 16384;
function expectedRequest(slot: VerifierSlot, endpoint: GateEndpoint, subject: Subject): Record<string, unknown> {
  const parameters = record(slot.handler.parameters, ['checkId', 'endpointRef', 'gateId']);
  if (parameters.endpointRef !== endpoint.id) refuse('ARTIFACT_INVALID', '', 'verification');
  return { version: 1, kind: 'gate_request', gateId: text(parameters.gateId, '', 128), checkId: slot.checkId, candidateDigest: subject.candidateDigest.hex, subject };
}
function checkedVerdict(raw: unknown, expected: Record<string, unknown>): Verdict {
  const value = record(raw, ['version', 'kind', 'storeId', 'runId', 'lockHash', 'operationId', 'dispatchId', 'dispatchGeneration', 'gateId', 'checkId', 'candidateDigest', 'status', 'reason', 'expiresAtMs']);
  const binding = { version: 1, kind: 'gate_verdict', storeId: expected.storeId, runId: expected.runId, lockHash: expected.lockHash, operationId: expected.operationId, dispatchId: expected.dispatchId, dispatchGeneration: expected.dispatchGeneration, gateId: expected.gateId, checkId: expected.checkId, candidateDigest: expected.candidateDigest };
  if (!same(value, { ...binding, status: value.status, reason: value.reason, expiresAtMs: value.expiresAtMs }) || !verdictStatuses.includes(value.status as never)) refuse('ARTIFACT_INVALID', '', 'verification');
  if (value.reason !== null && (value.status === 'pending' || typeof value.reason !== 'string' || value.reason.length > 256)) refuse('ARTIFACT_INVALID', '', 'verification');
  if (value.status === 'pending' && value.reason !== null) refuse('ARTIFACT_INVALID', '', 'verification');
  if (!/^(?:0|[1-9][0-9]{0,17})$/.test(text(value.expiresAtMs, '', 19))) refuse('ARTIFACT_INVALID', '', 'verification');
  return { status: value.status as Verdict['status'], reason: value.reason as string | null, expiresAtMs: value.expiresAtMs as string };
}
function disposition(verdict: Verdict | null, timeout: boolean): Disposition {
  if (!verdict) return timeout ? { status: 'blocked', reason: 'GATE_TIMEOUT', method: 'gate_transport' } : { status: 'blocked', reason: 'EVIDENCE_UNAVAILABLE', method: 'gate_transport' };
  if (verdict.status === 'approved') return { status: 'passed', reason: null, method: 'verify_external_gate' };
  if (verdict.status === 'denied') return { status: 'failed', reason: 'gate_denied', method: 'verify_external_gate' };
  return { status: 'blocked', reason: 'EVIDENCE_UNAVAILABLE', method: 'verify_external_gate' };
}
function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms), abort = () => { clearTimeout(timer); reject(new ControllerFailure({ version: 1, code: 'CANCELLED', phase: 'verification', path: '', stateCode: null, piCode: null, effect: 'none', retryable: false })); };
    signal.addEventListener('abort', abort, { once: true });
  });
}
/** Authenticated external gate client; follows the Verifier intent/permit/receipt discipline with signed HTTP instead of a Worker. */
export class Gate {
  constructor(readonly store: LocalRunStore, readonly authority: Authority, readonly artifacts: ArtifactStore, readonly plan: CompiledPlan, readonly lock: TaskLock,
    readonly resolveCredential: (ref: string) => string, readonly currentSubject: () => Subject, readonly onWait: ((detail: GateWaitDetail) => Promise<void>) | null = null) {}
  #identity() {
    const view = stateValue(this.store.inspect());
    if (view.storeId !== this.authority.storeId || view.runId !== this.lock.spec.runId || !same(view.lockHash, this.lock.spec.lockHash)
      || this.artifacts.owner.runId !== view.runId || !same(this.artifacts.owner.planDigest, this.plan.planDigest)) refuse('AUTHORITY_REFUSED', '', 'verification'); return view;
  }
  #permit(permit: DispatchPermit, expected: Subject, target: string): void {
    stateValue(this.store.renew(this.authority)); const view = stateValue(this.store.inspect()), operation = stateValue(this.store.getOperation(permit.operationId));
    if (!same(this.currentSubject(), expected) || permit.generation !== this.authority.generation || permit.clockEpoch !== view.clock.basis.clockEpoch
      || view.storeId !== permit.storeId || view.runId !== permit.runId || !same(view.lockHash, permit.lockHash)
      || BigInt(view.clock.sampledNow.monotonicMs) >= BigInt(permit.notAfterMonotonicMs) || BigInt(view.clock.sampledNow.monotonicMs) >= BigInt(view.clock.basis.taskDeadlineMonotonicMs)
      || operation.state !== 'dispatch_uncertain' || operation.dispatch?.dispatchId !== permit.dispatchId || operation.intent.targetIdentity !== target) refuse('AUTHORITY_REFUSED', '', 'verification');
  }
  async #marker(operationId: string, nonce: string, kind: 'binding' | 'proof', value: unknown): Promise<void> {
    await this.artifacts.owner.assertCurrent(); const name = 'gate-producer-' + hash(operationId + '\0' + nonce).hex + '.' + kind + '.json', path = join(this.artifacts.directory, name), bytes = Buffer.from(canonical(value));
    if (bytes.byteLength > 1048576) refuse('OUTPUT_LIMIT', '', 'verification'); this.artifacts.vault.assertClean(bytes);
    let file: Awaited<ReturnType<typeof open>>;
    try { file = await open(path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST' || !Buffer.from(await readBoundedFile(path, 1048576, true)).equals(bytes)) refuse('RECOVERY_REQUIRED', '', 'verification'); return; }
    try { await file.writeFile(bytes); await file.sync(); } finally { await file.close(); }
  }
  async #roundTrip(endpoint: GateEndpoint, secret: string, request: Record<string, unknown>, permit: DispatchPermit, signal: AbortSignal, binding: Record<string, unknown>, timeoutMs: number): Promise<RoundTrip> {
    const body = Buffer.from(canonical(request)), headers: Record<string, string> = { 'content-type': 'application/json', 'x-loopwright-signature': signPayload(secret, body) };
    if (endpoint.authCredentialRef !== null) headers.authorization = 'Bearer ' + this.resolveCredential(endpoint.authCredentialRef);
    const composed = AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]);
    let bytes: Uint8Array, signature: string;
    try {
      const response = await fetch(endpoint.url, { method: 'POST', headers, body: new Uint8Array(body), redirect: 'error', signal: composed });
      if (response.status !== 200 || !(response.headers.get('content-type') ?? '').startsWith('application/json')) return { kind: 'invalid' };
      bytes = new Uint8Array(await response.arrayBuffer());
      signature = response.headers.get('x-loopwright-signature') ?? '';
    } catch { return { kind: 'network' }; }
    if (bytes.byteLength > RESPONSE_BYTES || !verifySignedPayload(secret, bytes, signature)) return { kind: 'invalid' };
    try {
      const verdict = checkedVerdict(parsePrivateJson(Buffer.from(bytes), RESPONSE_BYTES), binding);
      return { kind: 'verdict', verdict, responseBytes: bytes, signature };
    } catch { return { kind: 'invalid' }; }
  }
  async run(job: PreparedGate, signal: AbortSignal): Promise<VerifiedCheck> {
    const data = preparations.get(job); if (!data || this.plan.verifierSlots.find(slot => slot.id === job.slotId) !== data.slot) refuse('EVIDENCE_UNAVAILABLE', '', 'verification');
    signal.throwIfAborted(); await this.artifacts.owner.assertCurrent(); if (!same(this.currentSubject(), data.subject)) refuse('ARTIFACT_INVALID', '', 'verification');
    const done = await this.artifacts.owner.holdLocalActivity();
    try {
      const target = 'gate:' + job.slotId + ':' + job.generation + ':' + data.subject.candidateDigest.hex;
      const before = this.#identity(); if (before.owner.mode !== 'active') refuse('AUTHORITY_REFUSED', '', 'verification');
      if (before.counts.dispatchedRequests || before.counts.unresolvedRequests || before.counts.unresolvedOperations || before.ledger.violations.length) refuse('RECOVERY_REQUIRED', '', 'verification');
      stateValue(this.store.putIntent(this.authority, { operationId: job.operationId, nodeId: this.plan.orderedDAG[0]!.id, attemptId: 'job.' + hash(job.operationId + '\0' + job.producerNonce).hex.slice(0, 40), effect: 'read_only', requestDigest: job.requestDigest, targetIdentity: target }));
      const dispatched = stateValue(this.store.authorizeOperationDispatch(this.authority, job.operationId)); if (dispatched.kind !== 'new_dispatch') refuse('RECOVERY_REQUIRED', '', 'verification'); const permit = dispatched.permit;
      const request: Record<string, unknown> = { ...expectedRequest(data.slot, data.endpoint, data.subject), storeId: before.storeId, runId: before.runId, lockHash: before.lockHash, operationId: job.operationId, dispatchId: permit.dispatchId, dispatchGeneration: permit.generation, requestDigest: job.requestDigest.hex };
      const requestBytesDigest = hash(Buffer.from(canonical(request))).hex, intentDigest = stateValue(this.store.getOperation(job.operationId)).intentDigest;
      await this.#marker(job.operationId, job.producerNonce, 'binding', { version: 1, planDigest: this.plan.planDigest, operationId: job.operationId, producerNonce: job.producerNonce, requestDigest: job.requestDigest, requestBytesDigest, intentDigest, subject: data.subject, generation: job.generation, endpoint: data.endpoint.id,
        dispatchReceipt: { generation: permit.generation, dispatchId: permit.dispatchId, revision: permit.authorizedRevision, clockEpoch: permit.clockEpoch } });
      const secret = this.resolveCredential(data.endpoint.signingCredentialRef), started = performance.now();
      const startMono = BigInt(before.clock.sampledNow.monotonicMs), maxPollMono = startMono + BigInt(data.endpoint.maxPollMs);
      const permitCapMono = BigInt(permit.notAfterMonotonicMs) > 2000n ? BigInt(permit.notAfterMonotonicMs) - 2000n : BigInt(permit.notAfterMonotonicMs);
      const drain = BigInt(this.plan.controls.drainReserveMs);
      const taskCapMono = BigInt(before.clock.basis.taskDeadlineMonotonicMs) > drain + 2000n ? BigInt(before.clock.basis.taskDeadlineMonotonicMs) - drain - 2000n : BigInt(before.clock.basis.taskDeadlineMonotonicMs);
      const pollDeadlineMono = [maxPollMono, permitCapMono, taskCapMono].reduce((a, b) => a < b ? a : b), deadlineMs = Math.max(0, Number(pollDeadlineMono - startMono));
      let attempts = 0, outcome: RoundTrip = { kind: 'network' }, timedOut = false;
      for (;;) {
        this.#permit(permit, data.subject, target);
        const preMono = BigInt(stateValue(this.store.inspect()).clock.sampledNow.monotonicMs), preElapsed = Math.ceil(performance.now() - started);
        if (preMono >= pollDeadlineMono || preElapsed >= data.endpoint.maxPollMs) { timedOut = true; break; }
        outcome = await this.#roundTrip(data.endpoint, secret, request, permit, signal, { storeId: before.storeId, runId: before.runId, lockHash: before.lockHash, operationId: job.operationId, dispatchId: permit.dispatchId, dispatchGeneration: permit.generation, gateId: String(request.gateId), checkId: String(request.checkId), candidateDigest: String(request.candidateDigest) }, Math.max(50, Math.min(data.endpoint.timeoutMs, Number(pollDeadlineMono - preMono))));
        attempts++;
        if (outcome.kind === 'verdict' && outcome.verdict.status !== 'pending' || outcome.kind === 'invalid') break;
        const view = stateValue(this.store.inspect()), nowMono = BigInt(view.clock.sampledNow.monotonicMs), elapsed = Math.ceil(performance.now() - started);
        if (signal.aborted || nowMono >= pollDeadlineMono || elapsed >= data.endpoint.maxPollMs) { timedOut = true; break; }
        const exponential = Math.min(data.endpoint.pollMaxMs, data.endpoint.pollInitialMs * 2 ** Math.min(30, attempts - 1));
        const jitterSeed = data.endpoint.jitter ? parseInt(hash('loopwright.dev/controller/gate-jitter/v1\0' + canonical({ operationId: job.operationId, attempt: attempts })).hex.slice(0, 8), 16) : 0;
        const delay = Math.min(exponential + (data.endpoint.jitter ? jitterSeed % (data.endpoint.jitter + 1) : 0), Number(pollDeadlineMono - nowMono), data.endpoint.maxPollMs - elapsed);
        if (delay <= 0) { timedOut = true; break; }
        if (this.onWait) await this.onWait({ operationId: job.operationId, gateId: String(request.gateId), elapsedMs: elapsed, nextPollMs: delay, deadlineMs });
        await sleep(delay, signal);
      }
      let verdict: Verdict | null = outcome.kind === 'verdict' ? outcome.verdict : null;
      if (verdict && verdict.status === 'approved') {
        const view = stateValue(this.store.inspect()), wall = BigInt(view.clock.sampledNow.wallMs);
        if (BigInt(verdict.expiresAtMs) < wall || BigInt(verdict.expiresAtMs) > wall + 86400000n) verdict = null;
      }
      const dispositioned = disposition(verdict, timedOut), view = stateValue(this.store.inspect()), suffix = hash(job.operationId + '\0' + job.producerNonce).hex.slice(0, 40);
      const retained = outcome.kind === 'verdict' && verdict !== null ? outcome : null;
      const output = await this.artifacts.json('gate-output', { version: 1, binding: { planDigest: this.plan.planDigest, operationId: job.operationId, producerNonce: job.producerNonce, generation: job.generation, endpoint: data.endpoint.id, subject: data.subject, requestBytesDigest },
        observation: { attempts, elapsedMs: Math.ceil(performance.now() - started), transport: timedOut ? 'deadline' : 'completed' }, verdict, responseBytes: retained ? Buffer.from(retained.responseBytes).toString('base64') : null, responseSignature: retained?.signature ?? null, disposition: dispositioned }, 65536);
      const evidenceResult = validateDocument({ apiVersion: 'loopwright.dev/v1alpha1', kind: 'Evidence', metadata: { id: 'evidence.' + suffix }, spec: { checkId: data.slot.checkId, observedStatus: dispositioned.status, producerId: 'loopwright.gate-verifier.v1', method: dispositioned.method, level: 'external_service', subject: data.subject, artifacts: [output], reason: dispositioned.reason } }, 'Evidence');
      if (!evidenceResult.ok) refuse('RECOVERY_REQUIRED', '', 'verification');
      const receipt: OperationReceipt = { receiptId: 'receipt.' + suffix, outcome: dispositioned.method === 'verify_external_gate' ? 'succeeded' : 'failed',
        evidence: { evidenceId: 'receipt-evidence.' + suffix, producerId: 'loopwright.gate-verifier.v1', method: dispositioned.method,
          subject: { storeId: view.storeId, runId: view.runId, lockHash: view.lockHash, operationId: job.operationId, requestId: null, intentDigest, dispatchGeneration: permit.generation, dispatchId: permit.dispatchId }, artifact: output } };
      const receiptRef = await this.artifacts.json('gate-receipt', receipt, 65536);
      await this.#marker(job.operationId, job.producerNonce, 'proof', { version: 1, output, receipt: receiptRef, evidence: evidenceResult.value });
      this.#permit(permit, data.subject, target); stateValue(this.store.recordOperationReceipt(this.authority, job.operationId, receipt));
      const value: VerifiedCheck = freeze({ slotId: job.slotId, checkId: data.slot.checkId, generation: job.generation, operationId: job.operationId, producerNonce: job.producerNonce, status: dispositioned.status, reason: dispositioned.reason, output, receipt: receiptRef });
      observations.set(value, { evidence: freeze(evidenceResult.value), subject: data.subject, outputBytes: await this.artifacts.read(output, 65536), receipt: freeze(receipt), planDigest: this.plan.planDigest, requestDigest: job.requestDigest,
        header: { handlerDigest: data.slot.handler.digest, handler: 'gate.v1', candidate: { ref: { digest: data.candidateDigest, byteLength: data.candidateBytes } } } }); return value;
    } finally { done(); }
  }
  /** Original private producer proof only; the retained response bytes are re-authenticated against the configured secret. */
  async restore(job: PreparedGate): Promise<VerifiedCheck> {
    const data = preparations.get(job); if (!data || this.plan.verifierSlots.find(slot => slot.id === job.slotId) !== data.slot) refuse('EVIDENCE_UNAVAILABLE', '', 'recovery');
    await this.artifacts.owner.assertCurrent(); if (!same(this.currentSubject(), data.subject)) refuse('RECOVERY_REQUIRED', '', 'recovery');
    const operation = stateValue(this.store.getOperation(job.operationId)), view = this.#identity(), dispatch = operation.dispatch, attemptId = 'job.' + hash(job.operationId + '\0' + job.producerNonce).hex.slice(0, 40);
    if (!dispatch || view.clockStatus !== 'trusted' || operation.intent.effect !== 'read_only' || operation.linkedRequestId !== null || !same(operation.intent.requestDigest, job.requestDigest)
      || operation.intent.attemptId !== attemptId || operation.intent.nodeId !== this.plan.orderedDAG[0]!.id
      || operation.intent.targetIdentity !== 'gate:' + job.slotId + ':' + job.generation + ':' + data.subject.candidateDigest.hex) refuse('RECOVERY_REQUIRED', '', 'recovery');
    const prefix = join(this.artifacts.directory, 'gate-producer-' + hash(job.operationId + '\0' + job.producerNonce).hex);
    let bindingBytes: Buffer;
    try { bindingBytes = await readBoundedFile(prefix + '.binding.json', 1048576, true); }
    catch (error) { if (error instanceof ControllerFailure && error.diagnostic.code === 'REGISTRY_UNTRUSTED') refuse('RECOVERY_REQUIRED', '', 'recovery'); throw error; }
    const binding = record(parsePrivateJson(bindingBytes, 1048576), ['version', 'planDigest', 'operationId', 'producerNonce', 'requestDigest', 'requestBytesDigest', 'intentDigest', 'subject', 'generation', 'endpoint', 'dispatchReceipt']);
    let proofBytes: Buffer;
    try { proofBytes = await readBoundedFile(prefix + '.proof.json', 1048576, true); }
    catch (error) {
      if (error instanceof ControllerFailure && error.diagnostic.code === 'REGISTRY_UNTRUSTED' && operation.state === 'dispatch_uncertain')
        return await this.#settleTimeout(job, data, bindingBytes, view, dispatch, operation.intentDigest);
      if (error instanceof ControllerFailure && error.diagnostic.code === 'REGISTRY_UNTRUSTED') refuse('RECOVERY_REQUIRED', '', 'recovery');
      throw error;
    }
    const receiptBinding = record(binding.dispatchReceipt, ['generation', 'dispatchId', 'revision', 'clockEpoch']);
    if (receiptBinding.generation !== dispatch.generation || receiptBinding.dispatchId !== dispatch.dispatchId || receiptBinding.revision !== dispatch.revision || receiptBinding.clockEpoch !== view.clock.basis.clockEpoch) refuse('RECOVERY_REQUIRED', '', 'recovery');
    const request: Record<string, unknown> = { ...expectedRequest(data.slot, data.endpoint, data.subject), storeId: view.storeId, runId: view.runId, lockHash: view.lockHash, operationId: job.operationId, dispatchId: dispatch.dispatchId, dispatchGeneration: dispatch.generation, requestDigest: job.requestDigest.hex };
    const requestBytesDigest = hash(Buffer.from(canonical(request))).hex;
    if (binding.version !== 1 || !same(binding.planDigest, this.plan.planDigest) || binding.operationId !== job.operationId || binding.producerNonce !== job.producerNonce || binding.generation !== job.generation
      || !same(binding.subject, data.subject) || !same(binding.requestDigest, job.requestDigest) || !same(binding.intentDigest, operation.intentDigest) || binding.endpoint !== data.endpoint.id
      || !same(binding.requestBytesDigest, requestBytesDigest) || !same(binding.dispatchReceipt, { generation: dispatch.generation, dispatchId: dispatch.dispatchId, revision: dispatch.revision, clockEpoch: view.clock.basis.clockEpoch })) refuse('RECOVERY_REQUIRED', '', 'recovery');
    const proof = record(parsePrivateJson(proofBytes, 1048576), ['version', 'output', 'receipt', 'evidence']);
    const output = checkedRef(proof.output), receiptRef = checkedRef(proof.receipt), outputBytes = await this.artifacts.read(output, 65536);
    const saved = record(parsePrivateJson(Buffer.from(outputBytes), 65536), ['version', 'binding', 'observation', 'verdict', 'responseBytes', 'responseSignature', 'disposition']);
    const savedBinding = record(saved.binding, ['planDigest', 'operationId', 'producerNonce', 'generation', 'endpoint', 'subject', 'requestBytesDigest']);
    if (saved.version !== 1 || !same(savedBinding, { planDigest: this.plan.planDigest, operationId: job.operationId, producerNonce: job.producerNonce, generation: job.generation, endpoint: data.endpoint.id, subject: data.subject, requestBytesDigest })) refuse('RECOVERY_REQUIRED', '', 'recovery');
    const observation = record(saved.observation, ['attempts', 'elapsedMs', 'transport']); integer(observation.attempts, 1, 65536); integer(observation.elapsedMs, 0, Number.MAX_SAFE_INTEGER);
    if (!['completed', 'deadline'].includes(text(observation.transport))) refuse('RECOVERY_REQUIRED', '', 'recovery');
    let verdict: Verdict | null = null;
    if (saved.verdict !== null && typeof saved.responseBytes === 'string' && typeof saved.responseSignature === 'string') {
      const responseBytes = Buffer.from(saved.responseBytes, 'base64'); if (responseBytes.byteLength > RESPONSE_BYTES) refuse('RECOVERY_REQUIRED', '', 'recovery');
      const secret = this.resolveCredential(data.endpoint.signingCredentialRef);
      if (!verifySignedPayload(secret, responseBytes, saved.responseSignature)) refuse('EVIDENCE_UNAVAILABLE', '', 'recovery');
      const expected = { storeId: view.storeId, runId: view.runId, lockHash: view.lockHash, operationId: job.operationId, dispatchId: dispatch.dispatchId, dispatchGeneration: dispatch.generation, gateId: String(request.gateId), checkId: String(request.checkId), candidateDigest: String(request.candidateDigest) };
      const parsed = checkedVerdict(parsePrivateJson(responseBytes, RESPONSE_BYTES), expected);
      if (!same(saved.verdict, { status: parsed.status, reason: parsed.reason, expiresAtMs: parsed.expiresAtMs })) refuse('RECOVERY_REQUIRED', '', 'recovery');
      verdict = parsed;
    }
    const dispositioned = disposition(verdict, observation.transport === 'deadline');
    if (!same(saved.disposition, dispositioned)) refuse('RECOVERY_REQUIRED', '', 'recovery');
    const suffix = hash(job.operationId + '\0' + job.producerNonce).hex.slice(0, 40);
    const evidence = validateDocument({ apiVersion: 'loopwright.dev/v1alpha1', kind: 'Evidence', metadata: { id: 'evidence.' + suffix }, spec: { checkId: data.slot.checkId, observedStatus: dispositioned.status, producerId: 'loopwright.gate-verifier.v1', method: dispositioned.method, level: 'external_service', subject: data.subject, artifacts: [output], reason: dispositioned.reason } }, 'Evidence');
    if (!evidence.ok || !same(evidence.value, proof.evidence)) refuse('RECOVERY_REQUIRED', '', 'recovery');
    const receipt: OperationReceipt = { receiptId: 'receipt.' + suffix, outcome: dispositioned.method === 'verify_external_gate' ? 'succeeded' : 'failed',
      evidence: { evidenceId: 'receipt-evidence.' + suffix, producerId: 'loopwright.gate-verifier.v1', method: dispositioned.method,
        subject: { storeId: view.storeId, runId: view.runId, lockHash: view.lockHash, operationId: job.operationId, requestId: null, intentDigest: operation.intentDigest, dispatchGeneration: dispatch.generation, dispatchId: dispatch.dispatchId }, artifact: output } };
    if (!same(parsePrivateJson(await this.artifacts.read(receiptRef, 65536), 65536), receipt)) refuse('RECOVERY_REQUIRED', '', 'recovery');
    await this.artifacts.owner.assertCurrent(); if (!same(this.currentSubject(), data.subject)) refuse('RECOVERY_REQUIRED', '', 'recovery'); stateValue(this.store.renew(this.authority));
    if (operation.state === 'confirmed') { if (!same(operation.reconciliation ?? operation.initialReceipt, receipt)) refuse('RECOVERY_REQUIRED', '', 'recovery'); }
    else stateValue(this.store.reconcileOperation(this.authority, job.operationId, receipt));
    const value: VerifiedCheck = freeze({ slotId: job.slotId, checkId: data.slot.checkId, generation: job.generation, operationId: job.operationId, producerNonce: job.producerNonce, status: dispositioned.status, reason: dispositioned.reason, output, receipt: receiptRef });
    observations.set(value, { evidence: freeze(evidence.value), subject: data.subject, outputBytes, receipt: freeze(receipt), planDigest: this.plan.planDigest, requestDigest: job.requestDigest,
      header: { handlerDigest: data.slot.handler.digest, handler: 'gate.v1', candidate: { ref: { digest: data.candidateDigest, byteLength: data.candidateBytes } } } }); return value;
  }
  /** Read-only gate operations interrupted without a verdict settle fail-closed; a replacement request is never sent. */
  async #settleTimeout(job: PreparedGate, data: GatePreparation, bindingBytes: Buffer, view: RunView, dispatch: NonNullable<OperationRecord['dispatch']>, intentDigest: Digest): Promise<VerifiedCheck> {
    await this.artifacts.owner.assertCurrent(); if (!same(this.currentSubject(), data.subject)) refuse('RECOVERY_REQUIRED', '', 'recovery'); stateValue(this.store.renew(this.authority));
    const binding = record(parsePrivateJson(bindingBytes, 1048576), ['version', 'planDigest', 'operationId', 'producerNonce', 'requestDigest', 'requestBytesDigest', 'intentDigest', 'subject', 'generation', 'endpoint', 'dispatchReceipt']);
    const request: Record<string, unknown> = { ...expectedRequest(data.slot, data.endpoint, data.subject), storeId: view.storeId, runId: view.runId, lockHash: view.lockHash, operationId: job.operationId, dispatchId: dispatch.dispatchId, dispatchGeneration: dispatch.generation, requestDigest: job.requestDigest.hex };
    const requestBytesDigest = hash(Buffer.from(canonical(request))).hex, receiptBinding = record(binding.dispatchReceipt, ['generation', 'dispatchId', 'revision', 'clockEpoch']);
    if (receiptBinding.generation !== dispatch.generation || receiptBinding.dispatchId !== dispatch.dispatchId || receiptBinding.revision !== dispatch.revision || receiptBinding.clockEpoch !== view.clock.basis.clockEpoch
      || binding.version !== 1 || !same(binding.planDigest, this.plan.planDigest) || binding.operationId !== job.operationId || binding.producerNonce !== job.producerNonce || binding.generation !== job.generation
      || !same(binding.subject, data.subject) || !same(binding.requestDigest, job.requestDigest) || !same(binding.intentDigest, intentDigest) || binding.endpoint !== data.endpoint.id
      || !same(binding.requestBytesDigest, requestBytesDigest) || !same(binding.dispatchReceipt, { generation: dispatch.generation, dispatchId: dispatch.dispatchId, revision: dispatch.revision, clockEpoch: view.clock.basis.clockEpoch })) refuse('RECOVERY_REQUIRED', '', 'recovery');
    const dispositioned: Disposition = { status: 'blocked', reason: 'GATE_TIMEOUT', method: 'gate_transport' }, suffix = hash(job.operationId + '\0' + job.producerNonce).hex.slice(0, 40);
    const output = await this.artifacts.json('gate-output', { version: 1, binding: { planDigest: this.plan.planDigest, operationId: job.operationId, producerNonce: job.producerNonce, generation: job.generation, endpoint: data.endpoint.id, subject: data.subject, requestBytesDigest },
      observation: { attempts: 1, elapsedMs: 0, transport: 'deadline' }, verdict: null, responseBytes: null, responseSignature: null, disposition: dispositioned }, 65536);
    const evidenceResult = validateDocument({ apiVersion: 'loopwright.dev/v1alpha1', kind: 'Evidence', metadata: { id: 'evidence.' + suffix }, spec: { checkId: data.slot.checkId, observedStatus: 'blocked', producerId: 'loopwright.gate-verifier.v1', method: 'gate_transport', level: 'external_service', subject: data.subject, artifacts: [output], reason: 'GATE_TIMEOUT' } }, 'Evidence');
    if (!evidenceResult.ok) refuse('RECOVERY_REQUIRED', '', 'recovery');
    const receipt: OperationReceipt = { receiptId: 'receipt.' + suffix, outcome: 'failed',
      evidence: { evidenceId: 'receipt-evidence.' + suffix, producerId: 'loopwright.gate-verifier.v1', method: 'gate_transport',
        subject: { storeId: view.storeId, runId: view.runId, lockHash: view.lockHash, operationId: job.operationId, requestId: null, intentDigest: binding.intentDigest as Digest, dispatchGeneration: dispatch.generation, dispatchId: dispatch.dispatchId }, artifact: output } };
    const receiptRef = await this.artifacts.json('gate-receipt', receipt, 65536);
    await this.#marker(job.operationId, job.producerNonce, 'proof', { version: 1, output, receipt: receiptRef, evidence: evidenceResult.value });
    stateValue(this.store.reconcileOperation(this.authority, job.operationId, receipt));
    const value: VerifiedCheck = freeze({ slotId: job.slotId, checkId: data.slot.checkId, generation: job.generation, operationId: job.operationId, producerNonce: job.producerNonce, status: 'blocked', reason: 'GATE_TIMEOUT', output, receipt: receiptRef });
    observations.set(value, { evidence: freeze(evidenceResult.value), subject: data.subject, outputBytes: await this.artifacts.read(output, 65536), receipt: freeze(receipt), planDigest: this.plan.planDigest, requestDigest: job.requestDigest,
      header: { handlerDigest: data.slot.handler.digest, handler: 'gate.v1', candidate: { ref: { digest: data.candidateDigest, byteLength: data.candidateBytes } } } }); return value;
  }
}
/** Pure preparation: no intent, permit, timer, credential or network operation. */
export function prepareGate(plan: CompiledPlan, lock: TaskLock, slotId: string, candidate: ByteInventory, generation: number, producerNonce: string, gateEndpoints: readonly GateEndpoint[]): PreparedGate {
  if (!same(plan.task, lock.spec.contract) || !/^[a-f0-9]{32}$/.test(producerNonce)) refuse('ARTIFACT_INVALID', '', 'verification'); integer(generation, 0, plan.capacity.V - 1);
  const slot = plan.verifierSlots.find(item => item.id === slotId); if (!slot || slot.handler.implementation !== 'gate.v1' || slot.handler.kind !== 'check') refuse('CAPABILITY_UNSUPPORTED', '', 'verification');
  const subject = bindSubject(lock, candidate.manifest); if (!subject.ok) refuse('ARTIFACT_INVALID', '', 'verification');
  const endpoint = gateEndpoints.find(item => item.id === slot.handler.parameters.endpointRef);
  if (!endpoint) refuse('CONFIG_REFERENCE', '/registry/spec/gateEndpoints', 'verification');
  const parameters = record(slot.handler.parameters, ['checkId', 'endpointRef', 'gateId']);
  const requestDigest = hash('loopwright.dev/controller/gate-request/v1\0' + canonical({ planDigest: plan.planDigest, slotId, generation, gateId: parameters.gateId, checkId: slot.checkId, subject: subject.value, producerNonce }));
  const value: PreparedGate = freeze({ version: 1, slotId, generation, operationId: verifierOperationId(lock.spec.runId, slotId, generation), producerNonce, requestDigest });
  preparations.set(value, { slot, endpoint, subject: subject.value, candidateDigest: hash(canonical(candidate.manifest)), candidateBytes: Buffer.byteLength(canonical(candidate.manifest)) }); return value;
}
