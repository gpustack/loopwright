import { Worker } from 'node:worker_threads';
import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { bindSubject, digestArtifact, validateDocument, type ArtifactManifest, type ArtifactRef, type Digest, type Evidence, type Subject, type TaskLock } from '@loopwright/core';
import type { Authority, DispatchPermit, LocalRunStore, OperationReceipt } from '@loopwright/state';
import { ArtifactStore, checkedRef, stateValue } from './storage.js';
import { readBoundedFile } from './files.js';
import { descriptor, encodeInventory, encodePacket, fileHash, ownedBytes, packetSize, checkedHeader, HEADER_BYTES, PACKET_BYTES, type VerifierHeader, type VerifierReply, type ByteHandler } from './verifier-protocol.js';
import { canonical, freeze, hash, integer, list, record, same, text } from './schema.js';
import { parsePrivateJson } from './parser.js';
import { ControllerFailure, refuse } from './errors.js';
import { verifierOperationId, phaseCheckpointId, ProgressStore, validateProgress, journal } from './progress.js';
import { sizeJob, VerifierSizingFailure, checkedRefusalRecord, type RefusalRecord } from './refusal-record.js';
import type { CompiledPlan, VerifierSlot, VerifierRefusalRow } from './types.js';
export interface ByteInventory { readonly manifest: ArtifactManifest; readonly ref: ArtifactRef; readonly files: readonly { readonly name: string; readonly bytes: Uint8Array }[] }
export interface PreparedVerification { readonly version: 1; readonly slotId: string; readonly generation: number; readonly operationId: string; readonly producerNonce: string; readonly packetBytes: number; readonly requestDigest: import('@loopwright/core').Digest }
interface Prepared { readonly header: VerifierHeader; readonly payload: Uint8Array; readonly slot: VerifierSlot }
const preparedJobs = new WeakMap<PreparedVerification, Prepared>();
function inventoryBytes(input: ByteInventory): ReadonlyMap<string, Uint8Array> {
  descriptor(input.manifest, input.ref);
  if (input.files.length !== input.manifest.spec.entries.length || input.files.length > 256 || new Set(input.files.map(file => file.name)).size !== input.files.length) refuse('ARTIFACT_INVALID', '', 'verification');
  let total = 0; const files = new Map<string, Uint8Array>();
  for (const entry of input.manifest.spec.entries) {
    const file = input.files.find(file => file.name === entry.name); if (!file || (total += entry.byteLength) > 4194304) refuse('ARTIFACT_INVALID', '', 'verification');
    const bytes = ownedBytes(file.bytes, 4194304); if (bytes.byteLength !== entry.byteLength || !same(fileHash(bytes), entry.digest)) refuse('ARTIFACT_INVALID', '', 'verification'); files.set(entry.name, bytes);
  }
  return files;
}
/** Pure byte preflight: no owner, state intent, Worker, timer, credential or network operation. */
export function prepareVerification(plan: CompiledPlan, lock: TaskLock, slotId: string, source: ByteInventory, candidate: ByteInventory, generation: number, producerNonce: string): PreparedVerification {
  if (!same(plan.task, lock.spec.contract) || !/^[a-f0-9]{32}$/.test(producerNonce)) refuse('ARTIFACT_INVALID', '', 'verification'); integer(generation, 0, plan.capacity.V - 1);
  const slot = plan.verifierSlots.find(slot => slot.id === slotId); if (!slot || slot.handler.kind !== 'check') refuse('CAPABILITY_UNSUPPORTED', '', 'verification');
  inventoryBytes(source); const files = inventoryBytes(candidate), subject = bindSubject(lock, candidate.manifest); if (!subject.ok) refuse('ARTIFACT_INVALID', '', 'verification');
  const operationId = verifierOperationId(lock.spec.runId, slotId, generation), handler = slot.handler.implementation as ByteHandler;
  let parameters: VerifierHeader['parameters'], payload: Uint8Array;
  if (handler === 'json-artifact.v1') {
    const path = text(slot.handler.parameters.path), expected = candidate.manifest.spec.entries.find(entry => entry.name === path) ?? null;
    parameters = { path, expected, required: slot.handler.parameters.required, equals: slot.handler.parameters.equals, sourceManifest: source.manifest, candidateManifest: candidate.manifest } as unknown as VerifierHeader['parameters'];
    payload = new Uint8Array(0); // Allocate the selected body only after complete header/file sizing below.
  } else {
    if (!['scope.v1', 'no-change.v1'].includes(handler)) refuse('CAPABILITY_UNSUPPORTED', '', 'verification');
    parameters = handler === 'scope.v1' ? { contract: plan.task } as unknown as VerifierHeader['parameters'] : {};
    const first = encodeInventory(source.manifest), second = encodeInventory(candidate.manifest); payload = new Uint8Array(first.byteLength + second.byteLength); payload.set(first); payload.set(second, first.byteLength);
  }
  const header = checkedHeader({ version: 1, jobId: 'job.' + hash(operationId + '\0' + producerNonce).hex.slice(0, 40), handler, handlerVersion: 1, handlerDigest: slot.handler.digest, checkId: slot.checkId, producerNonce, operationId, dispatchId: 'unbound', generation, subject: subject.value,
    source: descriptor(source.manifest, source.ref), candidate: descriptor(candidate.manifest, candidate.ref), parameters, payloadKind: handler === 'json-artifact.v1' ? 'json' : 'inventories' });
  const selected = handler === 'json-artifact.v1' ? files.get(text(slot.handler.parameters.path)) : undefined;
  sizeJob(header, handler === 'json-artifact.v1' ? 4 + (selected?.byteLength ?? 0) : payload.byteLength, handler === 'json-artifact.v1' ? selected?.byteLength ?? 0 : null);
  if (handler === 'json-artifact.v1') { payload = new Uint8Array(4 + (selected?.byteLength ?? 0)); new DataView(payload.buffer).setUint32(0, selected?.byteLength ?? 0); if (selected) payload.set(selected, 4); }
  const packetBytes = packetSize(header, payload.byteLength), requestDigest = hash('loopwright.dev/controller/verifier-request/v1\0' + canonical({ planDigest: plan.planDigest, header, payloadDigest: hash(payload) }));
  const sealed = freeze(checkedHeader(parsePrivateJson(Buffer.from(canonical(header)), HEADER_BYTES)));
  const value: PreparedVerification = freeze({ version: 1, slotId, generation, operationId, producerNonce, packetBytes, requestDigest }); preparedJobs.set(value, { header: sealed, payload, slot }); return value;
}
export interface PreparedRefusal { readonly slotId: string; readonly generation: number; readonly prospectiveOperationId: string; readonly producerNonce: string }
interface RefusalPreparation { readonly value: RefusalRecord; readonly plan: CompiledPlan; readonly source: ByteInventory; readonly candidate: ByteInventory; readonly slot: VerifierSlot }
const refusalPreparations = new WeakMap<PreparedRefusal, RefusalPreparation>();
/** Ready jobs keep the original API. Only the dedicated pure sizing exception can create a negative preparation. */
export function preflightVerification(plan: CompiledPlan, lock: TaskLock, slotId: string, source: ByteInventory, candidate: ByteInventory, generation: number, producerNonce: string): { readonly kind: 'ready'; readonly job: PreparedVerification } | { readonly kind: 'refused'; readonly prepared: PreparedRefusal } {
  const { planDigest, ...unsigned } = plan;
  if (!same(hash('loopwright.dev/controller/plan/v1\0' + canonical(unsigned)), planDigest) || !validateDocument(lock, 'TaskLock').ok) refuse('ARTIFACT_INVALID', '', 'verification');
  const slot = plan.verifierSlots.find(slot => slot.id === slotId); if (!slot || slot.handler.kind !== 'check') refuse('CAPABILITY_UNSUPPORTED', '', 'verification');
  const parameters = slot.handler.parameters;
  if (slot.handler.implementation === 'json-artifact.v1') {
    record(parameters, ['checkId', 'path', 'required', 'equals']);
    if (parameters.checkId !== slot.checkId || !digestArtifact(text(parameters.path), new Uint8Array()).ok) refuse('CAPABILITY_UNSUPPORTED', '', 'verification');
    const required = list(parameters.required, '', 128).map(value => text(value, '', 128));
    if (new Set(required).size !== required.length || parameters.equals === null || typeof parameters.equals !== 'object' || Array.isArray(parameters.equals)) refuse('CAPABILITY_UNSUPPORTED', '', 'verification');
    const equals = record(parameters.equals, Object.keys(parameters.equals)); if (Object.keys(equals).length > 128 || Object.values(equals).some(value => value !== null && !['string', 'boolean', 'number'].includes(typeof value) || typeof value === 'number' && !Number.isSafeInteger(value))) refuse('CAPABILITY_UNSUPPORTED', '', 'verification');
  } else {
    record(parameters, ['checkId']);
    if (!['scope.v1', 'no-change.v1'].includes(slot.handler.implementation) || parameters.checkId !== (slot.implicit === null ? slot.checkId : null)) refuse('CAPABILITY_UNSUPPORTED', '', 'verification');
  }
  try { return { kind: 'ready', job: prepareVerification(plan, lock, slotId, source, candidate, generation, producerNonce) }; }
  catch (error) {
    if (!(error instanceof VerifierSizingFailure)) throw error;
    const slot = plan.verifierSlots.find(slot => slot.id === slotId)!, subject = bindSubject(lock, candidate.manifest); if (!subject.ok) refuse('ARTIFACT_INVALID', '', 'verification');
    const prospectiveOperationId = verifierOperationId(lock.spec.runId, slotId, generation), value: RefusalRecord = freeze({ version: 1, kind: 'controller_preflight_refusal', planDigest, handlerDigest: slot.handler.digest, slotId, checkId: slot.checkId, generation, prospectiveOperationId, producerNonce, subject: subject.value,
      source: descriptor(source.manifest, source.ref), candidate: descriptor(candidate.manifest, candidate.ref), code: 'OUTPUT_LIMIT', limits: error.sizing });
    const prepared: PreparedRefusal = freeze({ slotId, generation, prospectiveOperationId, producerNonce });
    refusalPreparations.set(prepared, { value: freeze(parsePrivateJson(Buffer.from(canonical(value)), 65536) as unknown as RefusalRecord), plan, source, candidate, slot }); return { kind: 'refused', prepared };
  }
}
export interface PreflightRefusal { readonly slotId: string; readonly checkId: string; readonly generation: number; readonly prospectiveOperationId: string; readonly producerNonce: string; readonly status: 'blocked'; readonly reason: string; readonly record: ArtifactRef }
interface AuthenticatedRefusal { readonly value: RefusalRecord; readonly row: VerifierRefusalRow; readonly storeId: string; readonly clockBasis: import('@loopwright/state').ClockBasis }
const refusalObservations = new WeakMap<PreflightRefusal, AuthenticatedRefusal>();
export function authenticatedRefusal(input: PreflightRefusal): AuthenticatedRefusal { const value = refusalObservations.get(input); if (!value) refuse('EVIDENCE_UNAVAILABLE', '', 'verification'); return value; }

export interface WorkerObservation { readonly kind: 'reply' | 'timeout' | 'cancelled' | 'failed'; readonly reply: Uint8Array | null; readonly threadId: number; readonly exit: number; readonly errorCode: 'ERR_WORKER_OUT_OF_MEMORY' | 'WORKER_ERROR' | null; readonly limits: { readonly oldMb: number; readonly youngMb: number; readonly stackMb: number }; readonly elapsedMs: number }
export interface WorkerObservationPorts { readonly limits?: (actual: Worker['resourceLimits']) => Worker['resourceLimits'] }
/** Private containment primitive. Production always supplies the fixed verifier module, never a task/config path. */
export function boundedWorker(module: URL, packet: Uint8Array<ArrayBuffer>, signal: AbortSignal, ports: WorkerObservationPorts = {}): Promise<WorkerObservation> {
  signal.throwIfAborted(); const started = performance.now(), worker = new Worker(module, { workerData: packet, transferList: [packet.buffer], env: {}, execArgv: [], resourceLimits: { maxOldGenerationSizeMb: 64, maxYoungGenerationSizeMb: 8, stackSizeMb: 2 } });
  const threadId = worker.threadId; let limits = { oldMb: worker.resourceLimits?.maxOldGenerationSizeMb ?? -1, youngMb: worker.resourceLimits?.maxYoungGenerationSizeMb ?? -1, stackMb: worker.resourceLimits?.stackSizeMb ?? -1 };
  let reply: Uint8Array | null = null, count = 0, kind: WorkerObservation['kind'] = 'reply', invalid = false, errorCode: WorkerObservation['errorCode'] = null;
  return new Promise((resolve, reject) => {
    let stopTimer: NodeJS.Timeout | null = null, finished = false;
    const stop = (next: WorkerObservation['kind']) => {
      if (finished || stopTimer) return; kind = next;
      stopTimer = setTimeout(() => { if (!finished) { finished = true; clearTimeout(timer); signal.removeEventListener('abort', abort); reject(new ControllerFailure({ version: 1, code: 'CLEANUP_FAILED', phase: 'verification', path: '', stateCode: null, piCode: null, effect: 'possible', retryable: false })); } }, 1000);
      void worker.terminate().catch(() => { /* Exact exit or cleanup timeout decides; no replacement Worker. */ });
    };
    const abort = () => stop('cancelled'), timer = setTimeout(() => stop('timeout'), 2000); signal.addEventListener('abort', abort, { once: true });
    worker.on('message', (raw: unknown) => { if (++count !== 1 || !(raw instanceof Uint8Array) || raw.byteLength > 65536 || raw.buffer instanceof SharedArrayBuffer) { invalid = true; stop('failed'); } else reply = ownedBytes(raw, 65536); });
    worker.once('error', (error: Error & { code?: string }) => { errorCode = error.code === 'ERR_WORKER_OUT_OF_MEMORY' ? error.code : 'WORKER_ERROR'; if (kind === 'reply') kind = 'failed'; });
    worker.once('exit', exit => {
      if (finished) return; finished = true; clearTimeout(timer); if (stopTimer) clearTimeout(stopTimer); signal.removeEventListener('abort', abort);
      if (exit !== 0 && kind === 'reply' || invalid || count !== 1 && kind === 'reply') kind = 'failed';
      resolve({ kind, reply, threadId, exit, errorCode, limits, elapsedMs: performance.now() - started });
    });
    if (ports.limits) {
      try { const observed = ports.limits(worker.resourceLimits); limits = { oldMb: observed?.maxOldGenerationSizeMb ?? -1, youngMb: observed?.maxYoungGenerationSizeMb ?? -1, stackMb: observed?.stackSizeMb ?? -1 }; }
      catch { invalid = true; stop('failed'); }
    }
    if (limits.oldMb !== 64 || limits.youngMb !== 8 || limits.stackMb !== 2) stop('failed'); else if (signal.aborted) abort();
  });
}
export interface VerifiedCheck { readonly slotId: string; readonly checkId: string; readonly generation: number; readonly operationId: string; readonly producerNonce: string; readonly status: 'passed' | 'failed' | 'blocked'; readonly reason: string | null; readonly output: ArtifactRef; readonly receipt: ArtifactRef }
interface AuthenticatedCheck { readonly evidence: Evidence; readonly subject: Subject; readonly outputBytes: Uint8Array; readonly receipt: OperationReceipt; readonly header: VerifierHeader;
  readonly planDigest: import('@loopwright/core').Digest; readonly requestDigest: import('@loopwright/core').Digest }
const observations = new WeakMap<VerifiedCheck, AuthenticatedCheck>();
export function authenticatedCheck(value: VerifiedCheck): AuthenticatedCheck { const trusted = observations.get(value); if (!trusted) refuse('EVIDENCE_UNAVAILABLE', '', 'verification'); return trusted; }
interface Disposition { readonly status: VerifiedCheck['status']; readonly reason: string | null; readonly method: string; readonly response: unknown }
function checkedReply(input: unknown, header: VerifierHeader, packetDigest: Digest): Disposition {
  const raw = record(input, ['version', 'jobId', 'handler', 'handlerDigest', 'checkId', 'producerNonce', 'operationId', 'dispatchId', 'generation', 'subject', 'packetDigest', 'status', 'reason', 'method', 'allocationBytes']);
  const expected = { version: 1, jobId: header.jobId, handler: header.handler, handlerDigest: header.handlerDigest, checkId: header.checkId, producerNonce: header.producerNonce, operationId: header.operationId, dispatchId: header.dispatchId, generation: header.generation, subject: header.subject, packetDigest };
  const binding = Object.fromEntries(Object.keys(expected).map(key => [key, raw[key]]));
  if (!same(binding, expected) || !['passed', 'failed'].includes(text(raw.status)) || (raw.status === 'passed') !== (raw.reason === null)
    || raw.method !== { 'scope.v1': 'verify_scope', 'no-change.v1': 'verify_no_change', 'json-artifact.v1': 'verify_json' }[header.handler]) refuse('RECOVERY_REQUIRED', '', 'verification');
  integer(raw.allocationBytes, 0, 8388608); if (raw.reason !== null && !['outside_scope', 'candidate_changed', 'missing_file', 'invalid_json', 'property_missing', 'property_mismatch'].includes(text(raw.reason))) refuse('RECOVERY_REQUIRED', '', 'verification');
  return { status: raw.status as VerifierReply['status'], reason: raw.reason as string | null, method: text(raw.method), response: raw };
}
/** Private fault observations; absent from public exports and every config schema. No replacement producer. */
export interface VerificationPorts { readonly beforeWorker?: (packet: Uint8Array) => void; readonly afterReply?: (reply: Uint8Array) => Uint8Array; readonly afterReceiptBytes?: () => void }
const verifierModule = new URL('./verifier-worker.js', import.meta.url);
export class Verifier {
  constructor(readonly store: LocalRunStore, readonly authority: Authority, readonly artifacts: ArtifactStore, readonly plan: CompiledPlan, readonly lock: TaskLock,
    readonly currentSubject: () => Subject, readonly ports: VerificationPorts = {}) {}
  #identity() {
    const view = stateValue(this.store.inspect());
    if (view.storeId !== this.authority.storeId || view.runId !== this.lock.spec.runId || !same(view.lockHash, this.lock.spec.lockHash)
      || this.artifacts.owner.runId !== view.runId || !same(this.artifacts.owner.planDigest, this.plan.planDigest)) refuse('AUTHORITY_REFUSED', '', 'verification'); return view;
  }
  #operationAbsent(operationId: string): void {
    const result = this.store.getOperation(operationId); if (result.ok || result.error.code !== 'RECORD_NOT_FOUND') refuse('RECOVERY_REQUIRED', '', 'verification');
  }
  async #refusalContext(prepared: PreparedRefusal) {
    const data = refusalPreparations.get(prepared);
    if (!data || data.plan !== this.plan || this.plan.verifierSlots.find(slot => slot.id === prepared.slotId) !== data.slot) refuse('EVIDENCE_UNAVAILABLE', '', 'verification');
    const repeated = preflightVerification(this.plan, this.lock, prepared.slotId, data.source, data.candidate, prepared.generation, prepared.producerNonce);
    if (repeated.kind !== 'refused' || !same(refusalPreparations.get(repeated.prepared)!.value, data.value)) refuse('RECOVERY_REQUIRED', '', 'verification');
    await this.artifacts.owner.assertCurrent(); stateValue(this.store.renew(this.authority)); const view = this.#identity();
    if (view.clockStatus !== 'trusted' || view.owner.ownerId !== this.authority.ownerId || view.owner.generation !== this.authority.generation || view.counts.dispatchedRequests || view.counts.unresolvedRequests || view.counts.unresolvedOperations || view.ledger.violations.length || !same(this.currentSubject(), data.value.subject)) refuse('RECOVERY_REQUIRED', '', 'verification');
    this.#operationAbsent(prepared.prospectiveOperationId);
    for (const input of [data.source, data.candidate]) if (!Buffer.from(await this.artifacts.read(input.ref, 32768)).equals(Buffer.from(canonical(input.manifest)))) refuse('ARTIFACT_INVALID', '', 'verification');
    const records = journal(this.store), latest = records.checkpoints.filter(cp => cp.additionalArtifacts.length === 4).at(-1); if (!latest) refuse('RECOVERY_REQUIRED', '', 'verification');
    const progress = new ProgressStore(this.store, this.authority, this.artifacts, this.plan, this.lock, latest.additionalArtifacts[2]!, latest.additionalArtifacts[3]!), head = await progress.read();
    const source = parsePrivateJson(await this.artifacts.read(progress.sourceRef, 262144), 262144) as Record<string, unknown>;
    if (!head || head.progress.candidate.generation !== prepared.generation || !same(head.checkpoint.subject, data.value.subject) || !same(head.progress.candidate.manifest, data.candidate.ref) || !same(source.manifest, data.source.ref)) refuse('RECOVERY_REQUIRED', '', 'verification');
    await this.artifacts.owner.assertCurrent(); stateValue(this.store.renew(this.authority)); this.#operationAbsent(prepared.prospectiveOperationId);
    if (!same(this.currentSubject(), data.value.subject)) refuse('RECOVERY_REQUIRED', '', 'verification'); const finalView = this.#identity();
    if (finalView.clockStatus !== 'trusted' || finalView.owner.ownerId !== this.authority.ownerId || finalView.owner.generation !== this.authority.generation || finalView.counts.dispatchedRequests || finalView.counts.unresolvedRequests || finalView.counts.unresolvedOperations || finalView.ledger.violations.length) refuse('RECOVERY_REQUIRED', '', 'verification');
    return { data, progress, head, view: finalView };
  }
  /** Durable negative bytes only; neither this row nor an orphan file can authorize acceptance. */
  async storeRefusal(prepared: PreparedRefusal): Promise<VerifierRefusalRow> {
    const { data, view } = await this.#refusalContext(prepared); if (view.owner.mode !== 'active') refuse('AUTHORITY_REFUSED', '', 'verification');
    const ref = await this.artifacts.json('verifier-refusal', data.value, 65536); this.#operationAbsent(prepared.prospectiveOperationId);
    return freeze({ slot: prepared.slotId, generation: prepared.generation, prospectiveOperationId: prepared.prospectiveOperationId, producerNonce: prepared.producerNonce, subject: data.value.subject, record: ref });
  }
  /** Validate an existing pre anchor without granting a negative observation or allocating a new slot. */
  async validateStoredRefusal(prepared: PreparedRefusal, row: VerifierRefusalRow): Promise<void> {
    const { data, head } = await this.#refusalContext(prepared), original = head.progress.verifierRefusals.find(item => item.slot === prepared.slotId && item.generation === prepared.generation);
    if (!same(original, row)) refuse('RECOVERY_REQUIRED', '', 'recovery');
    const value = checkedRefusalRecord(parsePrivateJson(await this.artifacts.read(row.record, 65536), 65536), this.plan, this.lock, row);
    if (!same(value, data.value)) refuse('RECOVERY_REQUIRED', '', 'recovery');
  }
  /** Original pre/post anchors plus pure size reproduction; no Worker, operation intent, receipt or permit. */
  async restoreRefusal(prepared: PreparedRefusal, row: VerifierRefusalRow): Promise<PreflightRefusal> {
    await this.validateStoredRefusal(prepared, row); const { data, head, view } = await this.#refusalContext(prepared), ordinal = this.plan.verifierSlots.findIndex(slot => slot.id === prepared.slotId), phase = 'verify.' + prepared.generation + '.' + ordinal;
    const pre = stateValue(this.store.getCheckpoint(phaseCheckpointId(this.lock.spec.runId, phase + '.pre'))), post = stateValue(this.store.getCheckpoint(phaseCheckpointId(this.lock.spec.runId, phase + '.post')));
    if (post.sequence !== pre.sequence + 1 || pre.counts.requests !== post.counts.requests || pre.counts.operations !== post.counts.operations || !same(pre.ledger, post.ledger)
      || !same(pre.clockBasis, view.clock.basis) || !same(post.clockBasis, view.clock.basis) || !same(pre.subject, data.value.subject) || !same(post.subject, data.value.subject)
      || !head.progress.stage.consumed.includes(phase + '.pre') || !head.progress.stage.consumed.includes(phase + '.post')) refuse('RECOVERY_REQUIRED', '', 'recovery');
    for (const [checkpoint, suffix] of [[pre, 'pre'], [post, 'post']] as const) {
      if (checkpoint.additionalArtifacts.length !== 4 || !same(checkpoint.additionalArtifacts.slice(2), head.checkpoint.additionalArtifacts.slice(2))) refuse('RECOVERY_REQUIRED', '', 'recovery');
      const progress = validateProgress(parsePrivateJson(await this.artifacts.read(checkpoint.additionalArtifacts[0]!, 65536), 65536), this.plan, this.lock);
      if (progress.stage.phase !== phase + '.' + suffix || !same(progress.verifierRefusals.find(item => item.slot === row.slot && item.generation === row.generation), row)) refuse('RECOVERY_REQUIRED', '', 'recovery');
    }
    this.#operationAbsent(row.prospectiveOperationId);
    const value: PreflightRefusal = freeze({ slotId: row.slot, checkId: data.slot.checkId, generation: row.generation, prospectiveOperationId: row.prospectiveOperationId, producerNonce: row.producerNonce, status: 'blocked', reason: 'verifier_' + data.value.limits.reason, record: row.record });
    refusalObservations.set(value, { value: data.value, row, storeId: view.storeId, clockBasis: view.clock.basis }); return value;
  }
  #permit(permit: DispatchPermit, expected: Subject, target: string): void {
    stateValue(this.store.renew(this.authority)); const view = stateValue(this.store.inspect()), operation = stateValue(this.store.getOperation(permit.operationId));
    if (!same(this.currentSubject(), expected) || view.clockStatus !== 'trusted' || view.owner.mode !== 'active' || view.owner.ownerId !== this.authority.ownerId || view.owner.generation !== this.authority.generation
      || permit.generation !== this.authority.generation || permit.clockEpoch !== view.clock.basis.clockEpoch || view.storeId !== permit.storeId || view.runId !== permit.runId || !same(view.lockHash, permit.lockHash)
      || BigInt(view.clock.sampledNow.monotonicMs) >= BigInt(permit.notAfterMonotonicMs) || BigInt(view.clock.sampledNow.monotonicMs) >= BigInt(view.clock.basis.taskDeadlineMonotonicMs)
      || operation.state !== 'dispatch_uncertain' || operation.dispatch?.dispatchId !== permit.dispatchId || operation.intent.targetIdentity !== target) refuse('AUTHORITY_REFUSED', '', 'verification');
  }
  async #marker(operationId: string, nonce: string, kind: 'binding' | 'proof', value: unknown): Promise<void> {
    await this.artifacts.owner.assertCurrent(); const name = 'producer-' + hash(operationId + '\0' + nonce).hex + '.' + kind + '.json', path = join(this.artifacts.directory, name), bytes = Buffer.from(canonical(value));
    if (bytes.byteLength > 1048576) refuse('OUTPUT_LIMIT', '', 'verification'); this.artifacts.vault.assertClean(bytes);
    let file: Awaited<ReturnType<typeof open>>;
    try { file = await open(path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST' || !Buffer.from(await readBoundedFile(path, 1048576, true)).equals(bytes)) refuse('RECOVERY_REQUIRED', '', 'verification'); return; }
    try { await file.writeFile(bytes); await file.sync(); } finally { await file.close(); }
    const parent = await open(this.artifacts.directory, constants.O_RDONLY | constants.O_NOFOLLOW); try { await parent.sync(); } finally { await parent.close(); }
  }
  async run(job: PreparedVerification, signal: AbortSignal): Promise<VerifiedCheck> {
    const prepared = preparedJobs.get(job); if (!prepared || this.plan.verifierSlots.find(slot => slot.id === job.slotId) !== prepared.slot) refuse('EVIDENCE_UNAVAILABLE', '', 'verification');
    signal.throwIfAborted(); await this.artifacts.owner.assertCurrent(); if (!same(this.currentSubject(), prepared.header.subject)) refuse('ARTIFACT_INVALID', '', 'verification');
    const done = await this.artifacts.owner.holdLocalActivity(); let closed = true;
    try {
      const target = 'verifier:' + job.slotId + ':' + job.generation + ':' + prepared.header.subject.candidateDigest.hex;
      const before = this.#identity(); if (before.owner.mode !== 'active') refuse('AUTHORITY_REFUSED', '', 'verification');
      if (before.counts.dispatchedRequests || before.counts.unresolvedRequests || before.counts.unresolvedOperations || before.ledger.violations.length) refuse('RECOVERY_REQUIRED', '', 'verification');
      stateValue(this.store.putIntent(this.authority, { operationId: job.operationId, nodeId: this.plan.orderedDAG[0]!.id, attemptId: prepared.header.jobId, effect: 'read_only', requestDigest: job.requestDigest, targetIdentity: target }));
      const dispatched = stateValue(this.store.authorizeOperationDispatch(this.authority, job.operationId)); if (dispatched.kind !== 'new_dispatch') refuse('RECOVERY_REQUIRED', '', 'verification'); const permit = dispatched.permit;
      const header = { ...prepared.header, dispatchId: permit.dispatchId }, packet = encodePacket(header, prepared.payload), packetDigest = hash(packet), jobRef = await this.artifacts.put('verifier-job', packet, PACKET_BYTES);
      const moduleDigest = hash(await readBoundedFile(fileURLToPath(verifierModule), 1048576, false)), operation = stateValue(this.store.getOperation(job.operationId));
      await this.#marker(job.operationId, job.producerNonce, 'binding', { version: 1, planDigest: this.plan.planDigest, operationId: job.operationId, producerNonce: job.producerNonce, requestDigest: job.requestDigest, intentDigest: operation.intentDigest, subject: header.subject, generation: job.generation, job: jobRef, packetDigest, moduleDigest,
        dispatchReceipt: { generation: permit.generation, dispatchId: permit.dispatchId, revision: permit.authorizedRevision, clockEpoch: permit.clockEpoch } });
      this.ports.beforeWorker?.(packet); signal.throwIfAborted(); await this.artifacts.owner.assertCurrent(); this.#permit(permit, header.subject, target);
      const running = boundedWorker(verifierModule, packet, signal); closed = false; const observed = await running; closed = true;
      this.#permit(permit, header.subject, target);
      let status: VerifiedCheck['status'], reason: string | null, method: string, response: unknown;
      if (observed.kind === 'reply' && observed.reply) {
        const replyBytes = this.ports.afterReply?.(observed.reply) ?? observed.reply, checked = checkedReply(parsePrivateJson(replyBytes, 65536), header, packetDigest);
        ({ status, reason, method, response } = checked);
      } else { status = 'blocked'; reason = 'worker_' + observed.kind; method = 'worker_runtime'; response = { version: 1, status, reason }; }
      const output = await this.artifacts.json('verifier-output', { version: 1, binding: header, packetDigest, moduleDigest, observation: { kind: observed.kind, threadId: observed.threadId, exit: observed.exit, errorCode: observed.errorCode, limits: observed.limits, elapsedMs: Math.ceil(observed.elapsedMs) }, response }, 65536);
      const suffix = hash(job.operationId + '\0' + job.producerNonce).hex.slice(0, 40), evidenceResult = validateDocument({ apiVersion: 'loopwright.dev/v1alpha1', kind: 'Evidence', metadata: { id: 'evidence.' + suffix }, spec: { checkId: prepared.slot.checkId, observedStatus: status, producerId: 'loopwright.byte-verifier.v1', method, level: 'local_execution', subject: header.subject, artifacts: [output], reason } }, 'Evidence');
      if (!evidenceResult.ok) refuse('RECOVERY_REQUIRED', '', 'verification');
      const current = stateValue(this.store.inspect()), receipt: OperationReceipt = { receiptId: 'receipt.' + suffix, outcome: observed.kind === 'reply' ? 'succeeded' : 'failed', evidence: { evidenceId: 'receipt-evidence.' + suffix, producerId: 'loopwright.byte-verifier.v1', method,
        subject: { storeId: current.storeId, runId: current.runId, lockHash: current.lockHash, operationId: job.operationId, requestId: null, intentDigest: operation.intentDigest, dispatchGeneration: permit.generation, dispatchId: permit.dispatchId }, artifact: output } };
      const receiptRef = await this.artifacts.json('verifier-receipt', receipt, 65536);
      await this.#marker(job.operationId, job.producerNonce, 'proof', { version: 1, job: jobRef, output, receipt: receiptRef, evidence: evidenceResult.value }); this.ports.afterReceiptBytes?.();
      this.#permit(permit, header.subject, target); stateValue(this.store.recordOperationReceipt(this.authority, job.operationId, receipt));
      const value: VerifiedCheck = freeze({ slotId: job.slotId, checkId: prepared.slot.checkId, generation: job.generation, operationId: job.operationId, producerNonce: job.producerNonce, status, reason, output, receipt: receiptRef });
      observations.set(value, { evidence: freeze(evidenceResult.value), subject: header.subject, outputBytes: await this.artifacts.read(output, 65536), receipt: freeze(receipt), header: freeze(header), planDigest: this.plan.planDigest, requestDigest: job.requestDigest }); return value;
    } finally { if (closed) done(); }
  }
  /** Original private producer proof only. No Worker, new intent, permit reconstruction or transport retry. */
  async restore(job: PreparedVerification): Promise<VerifiedCheck> {
    const prepared = preparedJobs.get(job); if (!prepared || this.plan.verifierSlots.find(slot => slot.id === job.slotId) !== prepared.slot) refuse('EVIDENCE_UNAVAILABLE', '', 'recovery');
    await this.artifacts.owner.assertCurrent(); if (!same(this.currentSubject(), prepared.header.subject)) refuse('RECOVERY_REQUIRED', '', 'recovery');
    const operation = stateValue(this.store.getOperation(job.operationId)), view = this.#identity(), dispatch = operation.dispatch;
    if (!dispatch || view.clockStatus !== 'trusted' || operation.intent.effect !== 'read_only' || operation.linkedRequestId !== null || !same(operation.intent.requestDigest, job.requestDigest)
      || operation.intent.attemptId !== prepared.header.jobId || operation.intent.nodeId !== this.plan.orderedDAG[0]!.id
      || operation.intent.targetIdentity !== 'verifier:' + job.slotId + ':' + job.generation + ':' + prepared.header.subject.candidateDigest.hex) refuse('RECOVERY_REQUIRED', '', 'recovery');
    const prefix = join(this.artifacts.directory, 'producer-' + hash(job.operationId + '\0' + job.producerNonce).hex);
    const binding = record(parsePrivateJson(await readBoundedFile(prefix + '.binding.json', 1048576, true), 1048576), ['version', 'planDigest', 'operationId', 'producerNonce', 'requestDigest', 'intentDigest', 'subject', 'generation', 'job', 'packetDigest', 'moduleDigest', 'dispatchReceipt']);
    const proof = record(parsePrivateJson(await readBoundedFile(prefix + '.proof.json', 1048576, true), 1048576), ['version', 'job', 'output', 'receipt', 'evidence']);
    const receiptBinding = record(binding.dispatchReceipt, ['generation', 'dispatchId', 'revision', 'clockEpoch']);
    // Receipt identity only: no persisted dispatch capability, owner token or permit expiry.
    if (receiptBinding.generation !== dispatch.generation || receiptBinding.dispatchId !== dispatch.dispatchId || receiptBinding.revision !== dispatch.revision || receiptBinding.clockEpoch !== view.clock.basis.clockEpoch) refuse('RECOVERY_REQUIRED', '', 'recovery');
    const header = freeze({ ...prepared.header, dispatchId: dispatch.dispatchId }), expectedPacket = encodePacket(header, prepared.payload), packetDigest = hash(expectedPacket), jobRef = checkedRef(binding.job);
    const moduleDigest = hash(await readBoundedFile(fileURLToPath(verifierModule), 1048576, false));
    if (binding.version !== 1 || proof.version !== 1 || !same(binding.planDigest, this.plan.planDigest) || binding.operationId !== job.operationId || binding.producerNonce !== job.producerNonce || binding.generation !== job.generation || !same(binding.subject, header.subject)
      || !same(binding.requestDigest, job.requestDigest) || !same(binding.intentDigest, operation.intentDigest) || !same(binding.packetDigest, packetDigest) || !same(binding.moduleDigest, moduleDigest) || !same(binding.job, proof.job)
      || !Buffer.from(await this.artifacts.read(jobRef, PACKET_BYTES)).equals(Buffer.from(expectedPacket))) refuse('RECOVERY_REQUIRED', '', 'recovery');
    const output = checkedRef(proof.output), receiptRef = checkedRef(proof.receipt), outputBytes = await this.artifacts.read(output, 65536);
    const saved = record(parsePrivateJson(outputBytes, 65536), ['version', 'binding', 'packetDigest', 'moduleDigest', 'observation', 'response']);
    const observed = record(saved.observation, ['kind', 'threadId', 'exit', 'errorCode', 'limits', 'elapsedMs']);
    integer(observed.threadId, 1, Number.MAX_SAFE_INTEGER); integer(observed.exit, 0, 255); integer(observed.elapsedMs, 0, Number.MAX_SAFE_INTEGER);
    if (saved.version !== 1 || !same(saved.binding, header) || !same(saved.packetDigest, packetDigest) || !same(saved.moduleDigest, moduleDigest) || !['reply', 'timeout', 'cancelled', 'failed'].includes(text(observed.kind))
      || observed.errorCode !== null && !['ERR_WORKER_OUT_OF_MEMORY', 'WORKER_ERROR'].includes(text(observed.errorCode))) refuse('RECOVERY_REQUIRED', '', 'recovery');
    let disposition: Disposition;
    if (observed.kind === 'reply') {
      if (observed.exit !== 0 || observed.errorCode !== null || !same(observed.limits, { oldMb: 64, youngMb: 8, stackMb: 2 })) refuse('RECOVERY_REQUIRED', '', 'recovery');
      disposition = checkedReply(saved.response, header, packetDigest);
    } else {
      const response = { version: 1, status: 'blocked', reason: 'worker_' + observed.kind }; if (!same(saved.response, response)) refuse('RECOVERY_REQUIRED', '', 'recovery');
      disposition = { status: 'blocked', reason: response.reason, method: 'worker_runtime', response };
    }
    const suffix = hash(job.operationId + '\0' + job.producerNonce).hex.slice(0, 40);
    const evidence = validateDocument({ apiVersion: 'loopwright.dev/v1alpha1', kind: 'Evidence', metadata: { id: 'evidence.' + suffix }, spec: { checkId: prepared.slot.checkId, observedStatus: disposition.status, producerId: 'loopwright.byte-verifier.v1', method: disposition.method, level: 'local_execution', subject: header.subject, artifacts: [output], reason: disposition.reason } }, 'Evidence');
    if (!evidence.ok || !same(evidence.value, proof.evidence)) refuse('RECOVERY_REQUIRED', '', 'recovery');
    const receipt: OperationReceipt = { receiptId: 'receipt.' + suffix, outcome: observed.kind === 'reply' ? 'succeeded' : 'failed', evidence: { evidenceId: 'receipt-evidence.' + suffix, producerId: 'loopwright.byte-verifier.v1', method: disposition.method,
      subject: { storeId: view.storeId, runId: view.runId, lockHash: view.lockHash, operationId: job.operationId, requestId: null, intentDigest: operation.intentDigest, dispatchGeneration: dispatch.generation, dispatchId: dispatch.dispatchId }, artifact: output } };
    if (!same(parsePrivateJson(await this.artifacts.read(receiptRef, 65536), 65536), receipt)) refuse('RECOVERY_REQUIRED', '', 'recovery');
    await this.artifacts.owner.assertCurrent(); if (!same(this.currentSubject(), header.subject)) refuse('RECOVERY_REQUIRED', '', 'recovery'); stateValue(this.store.renew(this.authority));
    if (operation.state === 'confirmed') { if (!same(operation.reconciliation ?? operation.initialReceipt, receipt)) refuse('RECOVERY_REQUIRED', '', 'recovery'); }
    else stateValue(this.store.reconcileOperation(this.authority, job.operationId, receipt));
    const value: VerifiedCheck = freeze({ slotId: job.slotId, checkId: prepared.slot.checkId, generation: job.generation, operationId: job.operationId, producerNonce: job.producerNonce, status: disposition.status, reason: disposition.reason, output, receipt: receiptRef });
    observations.set(value, { evidence: freeze(evidence.value), subject: header.subject, outputBytes, receipt: freeze(receipt), header, planDigest: this.plan.planDigest, requestDigest: job.requestDigest }); return value;
  }
}
