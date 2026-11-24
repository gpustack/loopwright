import { constants } from 'node:fs';
import { lstat, open, realpath, rename } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
import { reopenLocalRun, type Authority, type LocalRunStore, type OperationReceipt } from '@loopwright/state';
import { VERIFIER_ARTIFACT_LIMITS, validateDocument, type ArtifactManifest, type ArtifactRef, type Evidence, type Subject } from '@loopwright/core';
import { approvedState, loadConfiguration } from './config.js';
import { compilePlan } from './compile.js';
import { ControllerFailure, refuse, result } from './errors.js';
import { ControllerOwner } from './ownership.js';
import { admitRetainedRun, readRetained, validatePortPolicyFields, validatePortsAgainstHostPolicy } from './retained.js';
import { resumeCycleWithPorts } from './recovery.js';
import { verifierProofPaths } from './verification.js';
import { overlayManifestBounds, restoreSource } from './source.js';
import { ArtifactStore, checkedRef, overwriteAtomicMarker, publishAtomicMarker, stateValue } from './storage.js';
import { readBoundedFile } from './files.js';
import { ProgressStore, journal, phaseCheckpointId, validateProgress } from './progress.js';
import { parsePrivateJson } from './parser.js';
import { canonical, freeze, hash, isRecord, list, record, same, text } from './schema.js';
import type { ControllerPorts } from './controller.js';
import { preparePublication, verifyPublicationReceipt } from './publication.js';
import { checkedGateVerdict, GATE_OUTPUT_BYTES, RESPONSE_BYTES, stripVerdictSignature, validateGateUrlOverrides, verifyGateSignature, verifySignedPayload, type GateVerdict } from './gate.js';
import {
  BENCHMARK_OUTPUT_BYTES,
  BENCHMARK_RESPONSE_BYTES,
  checkedBenchmarkVerdict,
  checkedVerifierArtifactRef,
  collectPriorGenerationVerifierBudget,
  computeBenchmarkDisposition,
  createRateLimitedProgress,
  expectedBenchmarkOutputArtifactRef,
  expectedBenchmarkRequest,
  isPreemptedBenchmarkVerdict,
  pullBenchmarkOutputBlobs,
  resolveBenchmarkBaseUrl,
  resolveBenchmarkSlotMetadata,
  sealBenchmarkBaseTreeBundle,
  shouldPullBenchmarkOutputs,
  validateStoredBenchmarkProof,
  type BenchmarkVerdict,
} from './benchmark-gate.js';
import type { LoadedConfiguration } from './types.js';
export interface ReconcileCycleInput { readonly configuration: LoadedConfiguration; readonly runRoot: string; readonly runId: string; readonly receipt: string; readonly signal?: AbortSignal }
export type ReconcileExecution =
  | { readonly kind: 'settled'; readonly version: 1; readonly runId: string; readonly status: 'completed' | 'failed' | 'blocked'; readonly outcome: 'succeeded' | 'not_executed'; readonly externalEffects: 'confirmed' | 'none'; readonly receipt: OperationReceipt }
  | { readonly kind: 'unresolved'; readonly version: 1; readonly runId: string; readonly reason: string };
const RECEIPT_BYTES = RESPONSE_BYTES + 256;
/** Operator receipt files may live anywhere private enough for the operator; ancestor symlinks such as /tmp -> /private/tmp canonicalize, the file itself never links. */
async function readReceiptFile(path: string): Promise<Buffer> {
  const rawTarget = resolve(text(path));
  let target: string;
  try {
    const stats = await lstat(rawTarget);
    if (!stats.isFile() || stats.isSymbolicLink() || stats.size > RECEIPT_BYTES) refuse('EVIDENCE_UNAVAILABLE', '/receipt', 'recovery');
    target = join(await realpath(dirname(rawTarget)), basename(rawTarget));
  } catch (error) { if (error instanceof ControllerFailure) throw error; refuse('EVIDENCE_UNAVAILABLE', '/receipt', 'recovery'); }
  try { return await readBoundedFile(target, RECEIPT_BYTES, false); }
  catch { refuse('EVIDENCE_UNAVAILABLE', '/receipt', 'recovery'); }
}
/** Explicit operator reconciliation for interrupted or unproven external effects; never re-dispatches the external request. */
export function reconcileCycle(input: ReconcileCycleInput, ports: ControllerPorts = {}) {
  return result(async (): Promise<ReconcileExecution> => {
    const fields = Object.keys(input); record(input, fields);
    if (fields.some(key => !['configuration', 'runRoot', 'runId', 'receipt', 'signal'].includes(key)) || input.signal !== undefined && !(input.signal instanceof AbortSignal)) refuse('CONFIG_SCHEMA', '', 'recovery');
    validateGateUrlOverrides(ports.gateUrlOverrides, 'recovery');
    validatePortPolicyFields(ports, 'recovery');
    const receiptBytes = await readReceiptFile(input.receipt);
    let raw: unknown; try { raw = parsePrivateJson(receiptBytes, RECEIPT_BYTES); } catch { refuse('EVIDENCE_UNAVAILABLE', '/receipt', 'recovery'); }
    const kind = typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>).kind : null;
    if (kind !== 'publication_receipt' && kind !== 'gate_verdict' && kind !== 'benchmark_verdict') refuse('EVIDENCE_UNAVAILABLE', '/receipt', 'recovery');
    let effectiveConfig = input.configuration;
    let state = approvedState(effectiveConfig);
    try {
      const retained = await readRetained({ runRoot: input.runRoot, runId: input.runId });
      if (retained.descriptor.configuration.roleModelOverrides !== undefined && state.input.roleModelOverrides === undefined) {
        const reloaded = await loadConfiguration({ ...state.input, roleModelOverrides: retained.descriptor.configuration.roleModelOverrides }, { environment: state.environment });
        if (reloaded.ok) { effectiveConfig = reloaded.value; state = approvedState(effectiveConfig); }
      }
    } catch { /* admit() below will validate retained run and report the canonical diagnostic */ }
    validateGateUrlOverrides(ports.gateUrlOverrides, 'recovery', effectiveConfig.registry.spec.gateEndpoints);
    const compiled = await compilePlan(effectiveConfig);
    if (!compiled.ok) refuse('RECOVERY_REQUIRED', '', 'recovery');
    const plan = compiled.value;
    if (kind === 'gate_verdict') return await reconcileGate({ ...input, configuration: effectiveConfig }, state, plan, receiptBytes, ports);
    if (kind === 'benchmark_verdict') return await reconcileBenchmarkGate({ ...input, configuration: effectiveConfig }, state, plan, receiptBytes, ports);
    if (plan.publication.mode !== 'pull_request') refuse('EVIDENCE_UNAVAILABLE', '/receipt', 'recovery');
    return await reconcilePublication({ ...input, configuration: effectiveConfig }, state, plan, raw, ports);
  }, 'recovery');
}
/** Shared retained-run admission for both reconciliation paths. */
async function admit(input: ReconcileCycleInput, plan: import('./types.js').CompiledPlan, ports: ControllerPorts) {
  const admitted = await admitRetainedRun({ runRoot: input.runRoot, runId: input.runId, configuration: input.configuration, environment: approvedState(input.configuration).environment, phase: 'recovery' });
  if (!same(plan, admitted.plan)) refuse('RECOVERY_REQUIRED', '', 'recovery');
  const effectivePorts = validatePortsAgainstHostPolicy(ports, admitted.hostPolicy, 'recovery');
  return { ...admitted, effectivePorts };
}
async function reconcileGate(input: ReconcileCycleInput, state: ReturnType<typeof approvedState>, plan: import('./types.js').CompiledPlan, receiptBytes: Buffer, ports: ControllerPorts) {
  const { directory, descriptor, lock, effectivePorts } = await admit(input, plan, ports);
  let owner: ControllerOwner | null = null, store: LocalRunStore | null = null, authority: Authority | null = null;
  let primaryFailed = false;
  try {
    owner = await ControllerOwner.acquire(directory, input.runId, plan.planDigest);
    store = stateValue(reopenLocalRun(descriptor.identity)); const original = stateValue(store.inspect());
    if (original.clockStatus !== 'trusted') refuse('RECOVERY_REQUIRED', '', 'recovery');
    authority = stateValue(store.claim({ ownerId: 'controller.' + owner.nonce, expectedGeneration: original.owner.generation, expectedRevision: original.revision, mode: 'recovery' })).authority;
    const artifacts = new ArtifactStore(join(directory, 'artifacts'), owner, state.vault);
    await artifacts.cleanCasTempFiles();
    const progress = new ProgressStore(store, authority, artifacts, plan, lock, descriptor.plan, descriptor.source), head = await progress.read();
    const rawReceipt = parsePrivateJson(receiptBytes, 65_792);
    if (!isRecord(rawReceipt)) refuse('EVIDENCE_UNAVAILABLE', '/receipt', 'recovery');
    const optionalVerdictKeys = (['detail', 'metrics', 'findings', 'retryablePreemption'] as const).filter(
      key => Object.hasOwn(rawReceipt, key) && rawReceipt[key] !== undefined,
    );
    let file: Record<string, unknown>;
    try {
      file = record(rawReceipt, [
        'version', 'kind', 'storeId', 'runId', 'lockHash', 'operationId', 'dispatchId', 'dispatchGeneration',
        'gateId', 'checkId', 'candidateDigest', 'status', 'reason', 'expiresAtMs', 'signature',
        ...optionalVerdictKeys,
      ], '/receipt');
    } catch {
      refuse('EVIDENCE_UNAVAILABLE', '/receipt', 'recovery');
    }
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
    const body = stripVerdictSignature(file);
    let parsedVerdict: GateVerdict;
    try {
      parsedVerdict = checkedGateVerdict(body, {
        storeId: original.storeId,
        runId: lock.spec.runId,
        lockHash: lock.spec.lockHash,
        operationId: row.operationId,
        dispatchId: dispatch.dispatchId,
        dispatchGeneration: dispatch.generation,
        gateId: (slot.handler.parameters as Record<string, unknown>).gateId,
        checkId: slot.checkId,
        candidateDigest: subject.candidateDigest.hex,
      });
    } catch {
      refuse('EVIDENCE_UNAVAILABLE', '/receipt', 'recovery');
    }
    if (
      parsedVerdict.status === 'pending'
      || parsedVerdict.status === 'approved' && (BigInt(parsedVerdict.expiresAtMs) < BigInt(original.clock.sampledNow.wallMs) || BigInt(parsedVerdict.expiresAtMs) > BigInt(original.clock.sampledNow.wallMs) + 86400000n)
      || Buffer.byteLength(canonical(body)) > RESPONSE_BYTES
      || typeof file.signature !== 'string'
      || !verifyGateSignature(state.vault.resolveNetworkCredential(endpoint.signingCredentialRef), file, file.signature)
    ) {
      refuse('EVIDENCE_UNAVAILABLE', '/receipt', 'recovery');
    }
    const status = parsedVerdict.status;
    const preemptionField = parsedVerdict.retryablePreemption !== undefined ? { retryablePreemption: parsedVerdict.retryablePreemption } : {};
    const dispositioned = status === 'approved'
      ? { status: 'passed' as const, reason: null, method: 'verify_external_gate', ...preemptionField }
      : status === 'denied'
        ? { status: 'failed' as const, reason: 'gate_denied', method: 'verify_external_gate', ...preemptionField }
        : { status: 'blocked' as const, reason: 'EVIDENCE_UNAVAILABLE', method: 'verify_external_gate', ...preemptionField };
    const nonce = row.producerNonce, prefix = join(artifacts.directory, 'gate-producer-' + hash(row.operationId + '\0' + nonce).hex);
    let settledReceipt: OperationReceipt | null = null;
    if (operation.state === 'confirmed') {
      settledReceipt = operation.reconciliation ?? operation.initialReceipt;
      if (!settledReceipt) refuse('RECOVERY_REQUIRED', '/gate', 'recovery');
      const savedOutput = record(parsePrivateJson(await artifacts.read(settledReceipt.evidence.artifact, GATE_OUTPUT_BYTES), GATE_OUTPUT_BYTES), ['version', 'binding', 'observation', 'verdict', 'responseBytes', 'responseSignature', 'disposition']);
      if (savedOutput.verdict === null) refuse('RECOVERY_REQUIRED', '/gate', 'recovery');
      if (!same(savedOutput.verdict, parsedVerdict)) refuse('RECEIPT_CONFLICT', '/receipt', 'recovery');
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
        observation: { attempts: 1, elapsedMs: 0, transport: 'completed' }, verdict: parsedVerdict, responseBytes: Buffer.from(canonical(body)).toString('base64'), responseSignature: text(file.signature), disposition: dispositioned }, GATE_OUTPUT_BYTES);
      const evidenceSpec = {
        checkId: slot.checkId,
        observedStatus: dispositioned.status,
        producerId: 'loopwright.gate-verifier.v1',
        method: dispositioned.method,
        level: 'external_service' as const,
        subject,
        artifacts: [output],
        reason: dispositioned.reason,
        ...(Object.hasOwn(parsedVerdict, 'detail') ? { detail: parsedVerdict.detail } : {}),
        ...(parsedVerdict.metrics !== undefined ? { metrics: parsedVerdict.metrics } : {}),
        ...(parsedVerdict.findings !== undefined ? { findings: parsedVerdict.findings } : {}),
      };
      const evidenceResult = validateDocument({ apiVersion: 'loopwright.dev/v1alpha1', kind: 'Evidence', metadata: { id: 'evidence.' + suffix }, spec: evidenceSpec }, 'Evidence');
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
    const execution = await resumeCycleWithPorts({ configuration: input.configuration, repository: descriptor.repository, runRoot: input.runRoot, runId: input.runId, ...(input.signal ? { signal: input.signal } : {}) }, effectivePorts);
    if (!execution.ok && execution.error.code === 'CAPABILITY_UNSUPPORTED') {
      return freeze({ kind: 'unresolved', version: 1, runId: lock.spec.runId, reason: 'delegated_step_required' }) as ReconcileExecution;
    }
    if (!execution.ok || execution.value.kind !== 'result') refuse('RECOVERY_REQUIRED', '', 'recovery');
    if (execution.value.result.spec.status === 'reconcile_required') return freeze({ kind: 'unresolved', version: 1, runId: lock.spec.runId, reason: 'remaining_unresolved_work' }) as ReconcileExecution;
    const receipt = settledReceipt as OperationReceipt;
    return freeze({ kind: 'settled', version: 1, runId: lock.spec.runId, status: execution.value.result.spec.status === 'completed' ? 'completed' : execution.value.result.spec.status === 'failed' ? 'failed' : 'blocked', outcome: receipt.outcome === 'succeeded' ? 'succeeded' : 'not_executed', externalEffects: execution.value.result.spec.externalEffects === 'confirmed' ? 'confirmed' : 'none', receipt: freeze(receipt) }) as ReconcileExecution;
  } catch (error) {
    primaryFailed = true;
    throw error;
  } finally {
    await releaseReconcileHandles(store, authority, owner, primaryFailed);
  }
}
async function releaseReconcileHandles(
  store: LocalRunStore | null,
  authority: Authority | null,
  owner: ControllerOwner | null,
  suppressError: boolean,
): Promise<void> {
  let firstError: unknown = null;
  const capture = (err: unknown) => {
    if (firstError === null) firstError = err;
  };
  if (store) {
    if (authority) {
      try {
        stateValue(store.release(authority));
      } catch (err) {
        capture(err);
      }
    }
    try {
      stateValue(store.close());
    } catch (err) {
      capture(err);
    }
  }
  if (owner) {
    try {
      await owner.release();
    } catch (err) {
      capture(err);
    }
  }
  if (!suppressError && firstError !== null) {
    throw firstError;
  }
}
async function writeMarker(path: string, value: unknown, vault: { assertClean: (value: Uint8Array | string | object) => void }): Promise<void> {
  await publishAtomicMarker(path, value, vault, 'recovery');
}
async function reconcileBenchmarkGate(
  input: ReconcileCycleInput,
  state: ReturnType<typeof approvedState>,
  plan: import('./types.js').CompiledPlan,
  receiptBytes: Buffer,
  ports: ControllerPorts,
) {
  const { directory, descriptor, lock, effectivePorts } = await admit(input, plan, ports);
  let owner: ControllerOwner | null = null, store: LocalRunStore | null = null, authority: Authority | null = null;
  let primaryFailed = false;
  try {
    owner = await ControllerOwner.acquire(directory, input.runId, plan.planDigest);
    store = stateValue(reopenLocalRun(descriptor.identity));
    const original = stateValue(store.inspect());
    if (original.clockStatus !== 'trusted') refuse('RECOVERY_REQUIRED', '', 'recovery');
    authority = stateValue(
      store.claim({
        ownerId: 'controller.' + owner.nonce,
        expectedGeneration: original.owner.generation,
        expectedRevision: original.revision,
        mode: 'recovery',
      }),
    ).authority;
    const artifacts = new ArtifactStore(join(directory, 'artifacts'), owner, state.vault);
    await artifacts.cleanCasTempFiles();
    const progress = new ProgressStore(store, authority, artifacts, plan, lock, descriptor.plan, descriptor.source);
    const head = await progress.read();
    const rawReceipt = parsePrivateJson(receiptBytes, RECEIPT_BYTES);
    if (!isRecord(rawReceipt)) refuse('EVIDENCE_UNAVAILABLE', '/receipt', 'recovery');
    const optionalVerdictKeys = (
      [
        'retryablePreemption',
        'detail',
        'metrics',
        'findings',
        'hardwareProvenance',
        'bucketMetrics',
        'hardwareDiagnostics',
        'outputArtifacts',
      ] as const
    ).filter(key => Object.hasOwn(rawReceipt, key) && rawReceipt[key] !== undefined);
    let file: Record<string, unknown>;
    try {
      file = record(
        rawReceipt,
        [
          'version',
          'kind',
          'storeId',
          'runId',
          'lockHash',
          'operationId',
          'dispatchId',
          'dispatchGeneration',
          'gateId',
          'checkId',
          'candidateDigest',
          'status',
          'reason',
          'expiresAtMs',
          'preemptionCount',
          'signature',
          ...optionalVerdictKeys,
        ],
        '/receipt',
      );
    } catch {
      refuse('EVIDENCE_UNAVAILABLE', '/receipt', 'recovery');
    }

    if (!head) refuse('RECOVERY_REQUIRED', '/gate', 'recovery');
    const receiptOpId = text(file.operationId, '/receipt', 128);
    if (receiptOpId.length < 1) refuse('EVIDENCE_UNAVAILABLE', '/receipt', 'recovery');

    // Resolve the receipt's operationId directly from retained verifierReceipts first so replaying an earlier slot
    // or candidate generation never collides with a later active row.
    const row = head.progress.verifierReceipts.find(item => item.operationId === receiptOpId) ?? null;
    if (!row) {
      const hasAnyBenchmarkRow = head.progress.verifierReceipts.some(
        item => plan.verifierSlots.find(s => s.id === item.slot)?.handler.implementation === 'benchmark-gate.v1',
      );
      if (hasAnyBenchmarkRow) refuse('EVIDENCE_UNAVAILABLE', '/receipt', 'recovery');
      refuse('RECOVERY_REQUIRED', '/gate', 'recovery');
    }
    const slot = plan.verifierSlots.find(item => item.id === row.slot) ?? null;
    if (!slot || slot.handler.implementation !== 'benchmark-gate.v1') {
      refuse('RECOVERY_REQUIRED', '/gate', 'recovery');
    }
    const ordinal = plan.verifierSlots.findIndex(item => item.id === slot.id);
    if (ordinal < 0) refuse('RECOVERY_REQUIRED', '/gate', 'recovery');

    const meta = resolveBenchmarkSlotMetadata(plan, slot);
    const endpoint = input.configuration.registry.spec.gateEndpoints.find(item => item.id === meta.endpointRef);
    if (!endpoint) refuse('RECOVERY_REQUIRED', '/gate', 'recovery');
    const operation = stateValue(store.getOperation(row.operationId));
    const dispatch = operation.dispatch;
    if (!dispatch || (operation.state !== 'dispatch_uncertain' && operation.state !== 'confirmed')) {
      refuse('RECOVERY_REQUIRED', '/gate', 'recovery');
    }

    // Bind validation and replay to this operation's own retained candidate generation checkpoint, subject, and manifest.
    const storeJournal = journal(store);
    const preCheckpointId = phaseCheckpointId(lock.spec.runId, `verify.${String(row.generation)}.${String(ordinal)}.pre`);
    const rowCheckpoint = storeJournal.checkpoints.find(cp => cp.checkpointId === preCheckpointId) ?? null;
    let subject: Subject;
    let rowManifest: ArtifactManifest;
    let rowWorkspaceRef: ArtifactRef;
    if (rowCheckpoint) {
      subject = rowCheckpoint.subject;
      if (row.generation === head.progress.candidate.generation && same(subject, head.checkpoint.subject)) {
        rowManifest = head.manifest;
        rowWorkspaceRef = head.progress.candidate.workspace;
      } else {
        const wide = plan.capacity.D > 64;
        const pMaxBytes = wide ? 262_144 : 65_536;
        const pColLimit = wide ? 1024 : 256;
        const rowProgressRef = rowCheckpoint.additionalArtifacts[0];
        if (!rowProgressRef) refuse('RECOVERY_REQUIRED', '/gate', 'recovery');
        const rowProgress = validateProgress(
          parsePrivateJson(await artifacts.read(rowProgressRef, pMaxBytes), pMaxBytes, pColLimit),
          plan,
          lock,
        );
        rowManifest = await progress.manifest(rowProgress.candidate.manifest);
        rowWorkspaceRef = rowProgress.candidate.workspace;
      }
    } else if (row.generation === head.progress.candidate.generation) {
      subject = head.checkpoint.subject;
      rowManifest = head.manifest;
      rowWorkspaceRef = head.progress.candidate.workspace;
    } else {
      refuse('RECOVERY_REQUIRED', '/gate', 'recovery');
    }

    const secret = state.vault.resolveNetworkCredential(endpoint.signingCredentialRef);
    const bearerToken = endpoint.authCredentialRef !== null ? state.vault.resolveNetworkCredential(endpoint.authCredentialRef) : null;
    const extraSecrets = [secret, ...(bearerToken !== null ? [bearerToken] : [])];
    const body = stripVerdictSignature(file);
    const bodyCanonicalBytes = Buffer.from(canonical(body), 'utf8');
    if (
      typeof file.signature !== 'string'
      || bodyCanonicalBytes.byteLength > BENCHMARK_RESPONSE_BYTES
      || !verifyGateSignature(secret, file, file.signature)
    ) {
      refuse('EVIDENCE_UNAVAILABLE', '/receipt', 'recovery');
    }

    let parsedVerdict: BenchmarkVerdict;
    try {
      parsedVerdict = checkedBenchmarkVerdict(body, {
        storeId: original.storeId,
        runId: lock.spec.runId,
        lockHash: lock.spec.lockHash,
        operationId: row.operationId,
        dispatchId: dispatch.dispatchId,
        dispatchGeneration: dispatch.generation,
        gateId: meta.gateId,
        checkId: slot.checkId,
        candidateDigest: subject.candidateDigest.hex,
        slotId: slot.id,
      });
    } catch {
      refuse('EVIDENCE_UNAVAILABLE', '/receipt', 'recovery');
    }
    if (parsedVerdict.status === 'pending') {
      refuse('EVIDENCE_UNAVAILABLE', '/receipt', 'recovery');
    }

    const nonce = row.producerNonce;
    const prefix = join(artifacts.directory, 'benchmark-producer-' + hash(row.operationId + '\0' + nonce).hex);
    const effectiveSignal = input.signal ?? new AbortController().signal;
    if (effectiveSignal.aborted) refuse('CANCELLED', '', 'recovery');
    let settledReceipt: OperationReceipt | null = null;
    const wasAlreadyConfirmed = operation.state === 'confirmed';

    if (wasAlreadyConfirmed) {
      settledReceipt = operation.reconciliation ?? operation.initialReceipt;
      if (!settledReceipt) refuse('RECOVERY_REQUIRED', '/gate', 'recovery');
      const savedOutput = record(
        parsePrivateJson(await artifacts.read(settledReceipt.evidence.artifact, BENCHMARK_OUTPUT_BYTES), BENCHMARK_OUTPUT_BYTES),
        ['version', 'binding', 'observation', 'verdict', 'responseBytes', 'responseSignature', 'verifierArtifacts', 'disposition'],
      );
      if (savedOutput.verdict === null) refuse('RECOVERY_REQUIRED', '/gate', 'recovery');
      if (!same(savedOutput.verdict, parsedVerdict)) refuse('RECEIPT_CONFLICT', '/receipt', 'recovery');
      const savedVerifierRefsRaw = list(savedOutput.verifierArtifacts, '', VERIFIER_ARTIFACT_LIMITS.maxFilesPerSlot);
      const expectedOutputs = parsedVerdict.outputArtifacts ?? [];
      const savedDispositionStatus = isRecord(savedOutput.disposition) ? savedOutput.disposition.status : undefined;
      if (savedVerifierRefsRaw.length > 0 || (expectedOutputs.length > 0 && savedDispositionStatus === 'passed')) {
        if (savedVerifierRefsRaw.length !== expectedOutputs.length) refuse('RECOVERY_REQUIRED', '/gate', 'recovery');
        const replayProgress = createRateLimitedProgress(() => {
          if (effectiveSignal.aborted) refuse('CANCELLED', '', 'recovery');
          stateValue(store!.renew(authority!));
        }, 1_000);
        for (let idx = 0; idx < savedVerifierRefsRaw.length; idx++) {
          const ref = checkedVerifierArtifactRef(savedVerifierRefsRaw[idx], 'recovery');
          const expOut = expectedOutputs[idx]!;
          if (!same(ref, expectedBenchmarkOutputArtifactRef(slot.id, expOut, 'recovery'))) {
            refuse('RECOVERY_REQUIRED', '/gate', 'recovery');
          }
          const verified = await artifacts.verifyOrReuseVerifierCasBlob({
            logicalName: ref.name,
            expectedSha256: ref.digest.hex,
            expectedByteLength: ref.byteLength,
            mediaType: expOut.mediaType,
            maxBytes: VERIFIER_ARTIFACT_LIMITS.maxFileBytes,
            phase: 'recovery',
            extraSecrets,
            signal: effectiveSignal,
            onProgress: replayProgress,
          });
          if (!verified || !same(verified.blobRef, ref)) refuse('RECOVERY_REQUIRED', '/gate', 'recovery');
        }
      }
      if ((head.progress.stage.kind.startsWith('terminal') || head.progress.stage.kind === 'reconcile_result') && head.progress.terminalIntent?.result) {
        let raw: unknown;
        try {
          raw = parsePrivateJson(await artifacts.read(head.progress.terminalIntent.result, 1_048_576), 1_048_576);
        } catch {
          refuse('RECOVERY_REQUIRED', '', 'recovery');
        }
        const terminalResult = validateDocument(raw, 'RunResult');
        if (!terminalResult.ok) refuse('RECOVERY_REQUIRED', '', 'recovery');
        const runStatus = terminalResult.value.spec.status;
        if (runStatus === 'reconcile_required') {
          return freeze({ kind: 'unresolved', version: 1, runId: lock.spec.runId, reason: 'remaining_unresolved_work' }) as ReconcileExecution;
        }
        return freeze({
          kind: 'settled',
          version: 1,
          runId: lock.spec.runId,
          status: runStatus === 'completed' ? 'completed' : runStatus === 'failed' ? 'failed' : 'blocked',
          outcome: settledReceipt.outcome === 'succeeded' ? 'succeeded' : 'not_executed',
          externalEffects: terminalResult.value.spec.externalEffects === 'confirmed' ? 'confirmed' : 'none',
          receipt: freeze(settledReceipt),
        }) as ReconcileExecution;
      }
      // If another operation is currently dispatch_uncertain/unresolved, another verifier slot has an unfinished
      // verifier_pre checkpoint row (even before putIntent), or a delegated role attempt is unfinished, return
      // unresolved without calling resumeCycleWithPorts (which would advance/dispatch or timeout sibling work).
      const hasOtherUnresolvedOps = storeJournal.operations.some(
        op => op.intent.operationId !== row.operationId && (op.state === 'dispatch_uncertain' || op.state === 'unresolved'),
      );
      const hasOtherPendingVerifier =
        head.progress.verifierReceipts.some(item => item.operationId !== row.operationId && item.receipt === null)
        || (head.progress.stage.kind === 'verifier_pre'
          && head.progress.stage.phase !== `verify.${String(row.generation)}.${String(ordinal)}.pre`);
      if (hasOtherUnresolvedOps || hasOtherPendingVerifier) {
        return freeze({ kind: 'unresolved', version: 1, runId: lock.spec.runId, reason: 'remaining_unresolved_work' }) as ReconcileExecution;
      }
      const activeAttempt = head.progress.attempts.at(-1);
      if (activeAttempt && activeAttempt.finished === null) {
        return freeze({ kind: 'unresolved', version: 1, runId: lock.spec.runId, reason: 'delegated_step_required' }) as ReconcileExecution;
      }
    } else {
      let bindingBytes: Buffer;
      try {
        bindingBytes = await readBoundedFile(prefix + '.binding.json', 1_048_576, true, 0o600);
      } catch (error) {
        if (error instanceof ControllerFailure && error.diagnostic.code === 'REGISTRY_UNTRUSTED') {
          refuse('RECOVERY_REQUIRED', '/gate', 'recovery');
        }
        throw error;
      }
      const binding = record(parsePrivateJson(bindingBytes, 1_048_576), [
        'version',
        'planDigest',
        'operationId',
        'producerNonce',
        'requestDigest',
        'requestBytesDigest',
        'intentDigest',
        'subject',
        'generation',
        'endpoint',
        'dispatchReceipt',
      ]);

      let baseTreeBundle: Awaited<ReturnType<typeof sealBenchmarkBaseTreeBundle>>;
      const entryModes = new Map<string, '100644' | '100755'>();
      if (rowManifest.spec.baseTree !== undefined || rowManifest.spec.entries.length > 0) {
        const jsonPaths = verifierProofPaths(plan.verifierSlots);
        const source = await restoreSource(
          descriptor.repository,
          plan.task,
          owner,
          artifacts,
          descriptor.source,
          descriptor.sourceWorkspace,
          jsonPaths,
        );
        if (source.version === 2) {
          for (const item of source.baselineEntries ?? []) entryModes.set(item.name, item.mode);
          if (rowManifest.spec.baseTree !== undefined) {
            const bundleProgress = createRateLimitedProgress(() => {
              if (effectiveSignal.aborted) refuse('CANCELLED', '', 'recovery');
              stateValue(store!.renew(authority!));
            }, 1_000);
            baseTreeBundle = await sealBenchmarkBaseTreeBundle(
              source,
              rowManifest,
              artifacts,
              owner,
              effectiveSignal,
              bundleProgress,
            );
          }
        } else {
          for (const item of source.artifacts) entryModes.set(item.name, item.mode ?? '100644');
        }
        if (rowManifest.spec.entries.length > 0 && !same(rowWorkspaceRef, descriptor.sourceWorkspace)) {
          const bounds = overlayManifestBounds(plan.budgets.overlay);
          const maxWsBytes = Math.max(8_388_608, bounds.v2WorkspaceJsonMaxBytes, bounds.workspaceMaxBytes);
          const wsBytes = await artifacts.read(rowWorkspaceRef, maxWsBytes);
          let isDelegatedWorkspace = false;
          try {
            const parsedWs = parsePrivateJson(Buffer.from(wsBytes), maxWsBytes, bounds.collectionLimit);
            if (
              isRecord(parsedWs)
              && (parsedWs.format === 'delegated-capture.v1' || parsedWs.format === 'delegated-capture.v2')
              && Array.isArray(parsedWs.overlay)
            ) {
              isDelegatedWorkspace = true;
              for (const ov of parsedWs.overlay) {
                if (isRecord(ov) && typeof ov.name === 'string' && (ov.mode === '100644' || ov.mode === '100755')) {
                  entryModes.set(ov.name, ov.mode);
                }
              }
            }
          } catch (error) {
            if (!(error instanceof ControllerFailure && (error.diagnostic.code === 'CONFIG_SYNTAX' || error.diagnostic.code === 'ARTIFACT_INVALID'))) {
              throw error;
            }
            // Native Pi capture (non-JSON workspace; parsePrivateJson wraps non-JSON syntax errors as ARTIFACT_INVALID).
          }
          if (!isDelegatedWorkspace && source.version === 1) {
            // Native Pi classic (v1) materializes every file as 0o444 (100644) and capture records explicit 100644.
            for (const entry of rowManifest.spec.entries) {
              entryModes.set(entry.name, '100644');
            }
          }
        }
      }

      const request: Record<string, unknown> = {
        ...expectedBenchmarkRequest(plan, slot, endpoint, subject, rowManifest, baseTreeBundle, entryModes),
        storeId: original.storeId,
        runId: lock.spec.runId,
        lockHash: lock.spec.lockHash,
        operationId: row.operationId,
        dispatchId: dispatch.dispatchId,
        dispatchGeneration: dispatch.generation,
        requestDigest: operation.intent.requestDigest.hex,
      };
      const requestBytesDigest = hash(Buffer.from(canonical(request))).hex;
      if (
        binding.version !== 1
        || !same(binding.planDigest, plan.planDigest)
        || binding.operationId !== row.operationId
        || binding.producerNonce !== nonce
        || binding.generation !== row.generation
        || !same(binding.subject, subject)
        || !same(binding.requestDigest, operation.intent.requestDigest)
        || !same(binding.intentDigest, operation.intentDigest)
        || binding.endpoint !== endpoint.id
        || !same(binding.requestBytesDigest, requestBytesDigest)
        || !same(binding.dispatchReceipt, {
          generation: dispatch.generation,
          dispatchId: dispatch.dispatchId,
          revision: dispatch.revision,
          clockEpoch: original.clock.basis.clockEpoch,
        })
      ) {
        refuse('RECOVERY_REQUIRED', '/gate', 'recovery');
      }

      const priorBudget = await collectPriorGenerationVerifierBudget(
        plan,
        artifacts,
        row.generation,
        slot.id,
        undefined,
        head.progress.verifierReceipts,
      );

      const buildBenchmarkSettlement = async (settlement: {
        readonly disposition: ReturnType<typeof computeBenchmarkDisposition>;
        readonly observation: {
          readonly attempts: number;
          readonly elapsedMs: number;
          readonly transport: string;
          readonly sawPreemption: boolean;
          readonly wallClockValid: boolean;
          readonly casOutcome: string;
        };
        readonly responseBytes: string | null;
        readonly responseSignature: string | null;
        readonly verifierArtifacts: readonly ArtifactRef[];
      }): Promise<{
        readonly output: ArtifactRef;
        readonly evidence: Evidence;
        readonly receipt: OperationReceipt;
        readonly receiptRef: ArtifactRef;
      }> => {
        const suffix = hash(row.operationId + '\0' + nonce).hex.slice(0, 40);
        const output = await artifacts.json(
          'benchmark-output',
          {
            version: 1,
            binding: {
              planDigest: plan.planDigest,
              operationId: row.operationId,
              producerNonce: nonce,
              generation: row.generation,
              endpoint: endpoint.id,
              subject,
              requestBytesDigest,
            },
            observation: settlement.observation,
            verdict: parsedVerdict,
            responseBytes: settlement.responseBytes,
            responseSignature: settlement.responseSignature,
            verifierArtifacts: settlement.verifierArtifacts,
            disposition: settlement.disposition,
          },
          BENCHMARK_OUTPUT_BYTES,
        );
        const evidenceSpec = {
          checkId: slot.checkId,
          observedStatus: settlement.disposition.status,
          producerId: 'loopwright.benchmark-gate.v1',
          method: settlement.disposition.method,
          level: 'hardware_execution' as const,
          subject,
          artifacts: [output, ...settlement.verifierArtifacts],
          reason: settlement.disposition.reason,
          ...(Object.hasOwn(parsedVerdict, 'detail') ? { detail: parsedVerdict.detail } : {}),
          ...(parsedVerdict.metrics !== undefined ? { metrics: parsedVerdict.metrics } : {}),
          ...(parsedVerdict.findings !== undefined ? { findings: parsedVerdict.findings } : {}),
          ...(parsedVerdict.hardwareProvenance !== undefined ? { hardwareProvenance: parsedVerdict.hardwareProvenance } : {}),
          ...(parsedVerdict.bucketMetrics !== undefined ? { bucketMetrics: parsedVerdict.bucketMetrics } : {}),
          ...(parsedVerdict.hardwareDiagnostics !== undefined ? { hardwareDiagnostics: parsedVerdict.hardwareDiagnostics } : {}),
        };
        const evidenceResult = validateDocument(
          { apiVersion: 'loopwright.dev/v1alpha1', kind: 'Evidence', metadata: { id: 'evidence.' + suffix }, spec: evidenceSpec },
          'Evidence',
        );
        if (!evidenceResult.ok) refuse('RECOVERY_REQUIRED', '/gate', 'recovery');
        const receipt: OperationReceipt = {
          receiptId: 'receipt.' + suffix,
          outcome: settlement.disposition.method === 'benchmark-gate.v1' ? 'succeeded' : 'failed',
          evidence: {
            evidenceId: 'receipt-evidence.' + suffix,
            producerId: 'loopwright.benchmark-gate.v1',
            method: settlement.disposition.method,
            subject: {
              storeId: original.storeId,
              runId: lock.spec.runId,
              lockHash: lock.spec.lockHash,
              operationId: row.operationId,
              requestId: null,
              intentDigest: operation.intentDigest,
              dispatchGeneration: dispatch.generation,
              dispatchId: dispatch.dispatchId,
            },
            artifact: output,
          },
        };
        const receiptRef = await artifacts.json('benchmark-receipt', receipt, 65_536);
        return { output, evidence: evidenceResult.value, receipt, receiptRef };
      };

      const proofPath = prefix + '.proof.json';
      let proofExists = false;
      try {
        await lstat(proofPath);
        proofExists = true;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
          refuse('RECOVERY_REQUIRED', '/gate', 'recovery');
        }
      }

      let useFreshReconcile = !proofExists;
      let overwriteExistingProvisionalProof = false;
      if (proofExists) {
        let proofBytes: Buffer;
        try {
          proofBytes = await readBoundedFile(proofPath, 1_048_576, true, 0o600);
        } catch {
          refuse('RECOVERY_REQUIRED', '/gate', 'recovery');
        }
        const proofVerifyProgress = createRateLimitedProgress(() => {
          if (effectiveSignal.aborted) refuse('CANCELLED', '', 'recovery');
          stateValue(store!.renew(authority!));
        }, 1_000);
        const validated = await validateStoredBenchmarkProof({
          proofBytes,
          artifacts,
          plan,
          slot,
          endpoint,
          targetHardware: meta.targetHardware,
          targetCellId: meta.targetCellId,
          allowSyntheticHardwareProbe: meta.allowSyntheticHardwareProbe,
          metricThresholds: meta.metricThresholds,
          view: original,
          operation,
          dispatch,
          operationId: row.operationId,
          producerNonce: nonce,
          generation: row.generation,
          subject,
          request,
          requestBytesDigest,
          secret,
          bearerToken,
          priorBudget,
          signal: effectiveSignal,
          onProgress: proofVerifyProgress,
          allowInvalidLocalCasSettlement: true,
        });
        const isProvisionalTimeoutProof =
          validated.verdict === null
          && validated.observation.transport === 'deadline'
          && validated.observation.casOutcome === 'gate_timeout';
        if (isProvisionalTimeoutProof) {
          // A prior #settleTimeout wrote a provisional timeout .proof.json but was cancelled/crashed before
          // confirming SQLite (operation is still dispatch_uncertain). Let the verified signed receipt
          // supersede the provisional timeout proof via normal fresh-receipt reconciliation.
          useFreshReconcile = true;
          overwriteExistingProvisionalProof = true;
        } else {
          if (validated.verdict === null) refuse('RECOVERY_REQUIRED', '/gate', 'recovery');
          if (!same(validated.verdict, parsedVerdict)) refuse('RECEIPT_CONFLICT', '/receipt', 'recovery');
          if (effectiveSignal?.aborted) refuse('CANCELLED', '', 'recovery');
          stateValue(store.renew(authority));
          const postValidateView = stateValue(store.inspect());
          const postValidateWallMs = BigInt(postValidateView.clock.sampledNow.wallMs);
          const currentlyFresh =
            parsedVerdict.status !== 'approved'
            || (BigInt(parsedVerdict.expiresAtMs) >= postValidateWallMs
              && BigInt(parsedVerdict.expiresAtMs) <= postValidateWallMs + 86_400_000n);

          if (validated.localCasInvalid) {
            // Local CAS blob referenced by an unconfirmed proof is missing or invalid: settle the operation as
            // blocked / ARTIFACT_INVALID with empty verifier refs instead of stranding dispatch_uncertain.
            const invalidWallClockValid = validated.observation.wallClockValid && currentlyFresh;
            const invalidDisposition = computeBenchmarkDisposition({
              verdict: parsedVerdict,
              timedOut: validated.observation.transport === 'deadline',
              sawPreemption: validated.observation.sawPreemption,
              wallClockValid: invalidWallClockValid,
              targetHardware: meta.targetHardware,
              targetCellId: meta.targetCellId,
              allowSyntheticHardwareProbe: meta.allowSyntheticHardwareProbe,
              metricThresholds: meta.metricThresholds,
              casOutcome: 'artifact_invalid',
            });
            const builtInvalid = await buildBenchmarkSettlement({
              disposition: invalidDisposition,
              observation: {
                attempts: validated.observation.attempts,
                elapsedMs: validated.observation.elapsedMs,
                transport: validated.observation.transport,
                sawPreemption: validated.observation.sawPreemption,
                wallClockValid: invalidWallClockValid,
                casOutcome: 'artifact_invalid',
              },
              responseBytes: validated.responseBytesBase64,
              responseSignature: validated.responseSignature,
              verifierArtifacts: [],
            });
            settledReceipt = builtInvalid.receipt;
            await overwriteAtomicMarker(
              proofPath,
              { version: 1, output: builtInvalid.output, receipt: builtInvalid.receiptRef, evidence: builtInvalid.evidence },
              state.vault,
              'recovery',
            );
            if (effectiveSignal?.aborted) refuse('CANCELLED', '', 'recovery');
            stateValue(store.renew(authority));
            const finalBlockedView = stateValue(store.inspect());
            if (finalBlockedView.clockStatus !== 'trusted') refuse('RECOVERY_REQUIRED', '/gate', 'recovery');
            if (effectiveSignal.aborted) refuse('CANCELLED', '', 'recovery');
            stateValue(store.reconcileOperation(authority, row.operationId, settledReceipt));
          } else {
            // Operation still needs first SQLite confirmation: apply current-time expiresAtMs freshness admission
            // AFTER lease renewal and proof + CAS validation, with ZERO intervening durable writes before confirmation.
            if (!currentlyFresh) {
              refuse('EVIDENCE_UNAVAILABLE', '/receipt', 'recovery');
            }
            if (effectiveSignal.aborted) refuse('CANCELLED', '', 'recovery');
            settledReceipt = validated.receipt;
            stateValue(store.reconcileOperation(authority, row.operationId, settledReceipt));
          }
        }
      }
      if (useFreshReconcile) {
        // Freshness admission strictly for first settlement (never blocks idempotent replay or valid existing proof).
        const initialWallMs = BigInt(original.clock.sampledNow.wallMs);
        if (
          parsedVerdict.status === 'approved'
          && (BigInt(parsedVerdict.expiresAtMs) < initialWallMs || BigInt(parsedVerdict.expiresAtMs) > initialWallMs + 86_400_000n)
        ) {
          refuse('EVIDENCE_UNAVAILABLE', '/receipt', 'recovery');
        }

        // Lock signed receipt identity atomically before any CAS retrieval so transient CAS transport failures remain
        // retryable with the exact same signed receipt while conflicting replacement verdicts refuse RECEIPT_CONFLICT.
        const commitmentPath = prefix + '.reconcile-receipt.json';
        const bodyDigest = hash(bodyCanonicalBytes).hex;
        let hasCommitment = false;
        try {
          await lstat(commitmentPath);
          hasCommitment = true;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
            refuse('RECOVERY_REQUIRED', '/gate', 'recovery');
          }
        }
        if (hasCommitment) {
          let rawCommitBytes: Buffer;
          try {
            rawCommitBytes = await readBoundedFile(commitmentPath, 1_048_576, true, 0o600);
          } catch {
            refuse('RECOVERY_REQUIRED', '/gate', 'recovery');
          }
          const committed = record(parsePrivateJson(rawCommitBytes, 1_048_576), [
            'version',
            'operationId',
            'dispatchId',
            'dispatchGeneration',
            'verdict',
            'bodyDigest',
          ]);
          if (
            committed.version !== 1
            || committed.operationId !== row.operationId
            || committed.dispatchId !== dispatch.dispatchId
            || committed.dispatchGeneration !== dispatch.generation
          ) {
            refuse('RECOVERY_REQUIRED', '/gate', 'recovery');
          }
          if (!same(committed.verdict, parsedVerdict) || committed.bodyDigest !== bodyDigest) {
            refuse('RECEIPT_CONFLICT', '/receipt', 'recovery');
          }
        } else {
          await publishAtomicMarker(
            commitmentPath,
            {
              version: 1,
              operationId: row.operationId,
              dispatchId: dispatch.dispatchId,
              dispatchGeneration: dispatch.generation,
              verdict: parsedVerdict,
              bodyDigest,
            },
            state.vault,
            'recovery',
          );
        }

        const reconcileStarted = performance.now();
        const reconcileStartMono = BigInt(original.clock.sampledNow.monotonicMs);
        const reconcileBudgetMs = Math.max(endpoint.timeoutMs, endpoint.maxPollMs);
        const reconcileDeadlineMono = reconcileStartMono + BigInt(reconcileBudgetMs);

        const isPastReconcileDeadline = (): boolean => {
          const nowMono = BigInt(stateValue(store!.inspect()).clock.sampledNow.monotonicMs);
          const elapsed = Math.ceil(performance.now() - reconcileStarted);
          return nowMono >= reconcileDeadlineMono || elapsed >= reconcileBudgetMs;
        };

        const resolveReconcileTimeoutMs = (): number | null => {
          const nowMono = BigInt(stateValue(store!.inspect()).clock.sampledNow.monotonicMs);
          const elapsed = Math.ceil(performance.now() - reconcileStarted);
          const remMono = Number(reconcileDeadlineMono - nowMono);
          const remElapsed = reconcileBudgetMs - elapsed;
          const windowMs = Math.min(endpoint.timeoutMs, remMono, remElapsed);
          return windowMs <= 0 ? null : windowMs;
        };

        const shouldPull = shouldPullBenchmarkOutputs({
          verdict: parsedVerdict,
          wallClockValid: true,
          targetHardware: meta.targetHardware,
          targetCellId: meta.targetCellId,
          allowSyntheticHardwareProbe: meta.allowSyntheticHardwareProbe,
          metricThresholds: meta.metricThresholds,
        });

        let casOutcome: 'ok' | 'artifact_invalid' | 'evidence_unavailable' | 'gate_timeout' = 'ok';
        let verifierCasRefs: readonly ArtifactRef[] = freeze([]);
        if (shouldPull && parsedVerdict.outputArtifacts) {
          const proposedFiles = parsedVerdict.outputArtifacts.length;
          const proposedBytes = parsedVerdict.outputArtifacts.reduce((sum, item) => sum + item.byteLength, 0);
          if (
            priorBudget.files + proposedFiles > VERIFIER_ARTIFACT_LIMITS.maxTotalFiles
            || proposedBytes > VERIFIER_ARTIFACT_LIMITS.maxTotalBytes - priorBudget.bytes
          ) {
            casOutcome = 'artifact_invalid';
          } else {
            const baseUrl = resolveBenchmarkBaseUrl(endpoint, effectivePorts.gateUrlOverrides, 'recovery');
            const pulled = await pullBenchmarkOutputBlobs({
              baseUrl,
              operationId: row.operationId,
              slotId: slot.id,
              secret,
              bearerToken,
              outputArtifacts: parsedVerdict.outputArtifacts,
              artifacts,
              signal: effectiveSignal,
              resolveTimeoutMs: resolveReconcileTimeoutMs,
              onBeforeEach: () => {
                stateValue(store!.renew(authority!));
              },
              reuseLocalFirst: true,
              phase: 'recovery',
            });
            if (!pulled.ok) {
              casOutcome = pulled.casOutcome;
            } else if (isPastReconcileDeadline()) {
              casOutcome = 'gate_timeout';
            } else {
              verifierCasRefs = pulled.refs;
            }
          }
        }

        // Transient CAS transport unavailability leaves SQLite dispatch_uncertain (with receipt commitment locked)
        // so retrying the exact same signed receipt succeeds once transport recovers.
        if (casOutcome === 'evidence_unavailable' || casOutcome === 'gate_timeout') {
          refuse('EVIDENCE_UNAVAILABLE', '/receipt', 'recovery');
        }

        // Re-sample wall-clock freshness immediately before first settlement (after any CAS retrieval).
        const postPullView = stateValue(store.inspect());
        const postPullWallMs = BigInt(postPullView.clock.sampledNow.wallMs);
        const wallClockValid =
          parsedVerdict.status !== 'approved'
          || (BigInt(parsedVerdict.expiresAtMs) >= postPullWallMs
            && BigInt(parsedVerdict.expiresAtMs) <= postPullWallMs + 86_400_000n);

        const sawPreemption = parsedVerdict.preemptionCount > 0 || isPreemptedBenchmarkVerdict(parsedVerdict);
        const dispositioned = computeBenchmarkDisposition({
          verdict: parsedVerdict,
          timedOut: false,
          sawPreemption,
          wallClockValid,
          targetHardware: meta.targetHardware,
          targetCellId: meta.targetCellId,
          allowSyntheticHardwareProbe: meta.allowSyntheticHardwareProbe,
          metricThresholds: meta.metricThresholds,
          casOutcome,
        });
        const retainOutputs =
          casOutcome === 'ok'
          && shouldPullBenchmarkOutputs({
            verdict: parsedVerdict,
            wallClockValid,
            targetHardware: meta.targetHardware,
            targetCellId: meta.targetCellId,
            allowSyntheticHardwareProbe: meta.allowSyntheticHardwareProbe,
            metricThresholds: meta.metricThresholds,
          });
        const effectiveRefs = retainOutputs ? verifierCasRefs : freeze([]);

        const builtFresh = await buildBenchmarkSettlement({
          disposition: dispositioned,
          observation: {
            attempts: 1,
            elapsedMs: Math.ceil(performance.now() - reconcileStarted),
            transport: 'completed',
            sawPreemption,
            wallClockValid,
            casOutcome,
          },
          responseBytes: bodyCanonicalBytes.toString('base64'),
          responseSignature: text(file.signature),
          verifierArtifacts: effectiveRefs,
        });
        settledReceipt = builtFresh.receipt;
        if (overwriteExistingProvisionalProof) {
          await overwriteAtomicMarker(
            prefix + '.proof.json',
            { version: 1, output: builtFresh.output, receipt: builtFresh.receiptRef, evidence: builtFresh.evidence },
            state.vault,
            'recovery',
          );
        } else {
          await writeMarker(prefix + '.proof.json', { version: 1, output: builtFresh.output, receipt: builtFresh.receiptRef, evidence: builtFresh.evidence }, state.vault);
        }
        if (effectiveSignal?.aborted) refuse('CANCELLED', '', 'recovery');
        stateValue(store.renew(authority));

        // Recheck signed expiresAtMs after durable proof persistence, right at first SQLite confirmation.
        const confirmView = stateValue(store.inspect());
        const confirmWallMs = BigInt(confirmView.clock.sampledNow.wallMs);
        const confirmFresh =
          parsedVerdict.status !== 'approved'
          || (BigInt(parsedVerdict.expiresAtMs) >= confirmWallMs
            && BigInt(parsedVerdict.expiresAtMs) <= confirmWallMs + 86_400_000n);
        if (wallClockValid && !confirmFresh) {
          const expiredDisposition = computeBenchmarkDisposition({
            verdict: parsedVerdict,
            timedOut: false,
            sawPreemption,
            wallClockValid: false,
            targetHardware: meta.targetHardware,
            targetCellId: meta.targetCellId,
            allowSyntheticHardwareProbe: meta.allowSyntheticHardwareProbe,
            metricThresholds: meta.metricThresholds,
            casOutcome,
          });
          const builtExpired = await buildBenchmarkSettlement({
            disposition: expiredDisposition,
            observation: {
              attempts: 1,
              elapsedMs: Math.ceil(performance.now() - reconcileStarted),
              transport: 'completed',
              sawPreemption,
              wallClockValid: false,
              casOutcome,
            },
            responseBytes: bodyCanonicalBytes.toString('base64'),
            responseSignature: text(file.signature),
            verifierArtifacts: [],
          });
          settledReceipt = builtExpired.receipt;
          await overwriteAtomicMarker(
            prefix + '.proof.json',
            { version: 1, output: builtExpired.output, receipt: builtExpired.receiptRef, evidence: builtExpired.evidence },
            state.vault,
            'recovery',
          );
          if (effectiveSignal?.aborted) refuse('CANCELLED', '', 'recovery');
          stateValue(store.renew(authority));
          const finalExpiredView = stateValue(store.inspect());
          if (finalExpiredView.clockStatus !== 'trusted') refuse('RECOVERY_REQUIRED', '/gate', 'recovery');
          if (effectiveSignal.aborted) refuse('CANCELLED', '', 'recovery');
        }

        stateValue(store.reconcileOperation(authority, row.operationId, settledReceipt));
      }
    }

    // Check if other operations remain unresolved in the store or another verifier slot has an unfinished
    // pre-checkpoint row before invoking resumeCycleWithPorts.
    const postJournal = journal(store);
    const remainingUnresolvedOps = postJournal.operations.some(
      op => op.intent.operationId !== row.operationId && (op.state === 'dispatch_uncertain' || op.state === 'unresolved'),
    );
    const remainingPendingVerifier = head.progress.verifierReceipts.some(
      item => item.operationId !== row.operationId && item.receipt === null,
    );
    if (remainingUnresolvedOps || remainingPendingVerifier) {
      return freeze({ kind: 'unresolved', version: 1, runId: lock.spec.runId, reason: 'remaining_unresolved_work' }) as ReconcileExecution;
    }

    stateValue(store.release(authority)); authority = null;
    stateValue(store.close()); store = null;
    await owner.release(); owner = null;
    const execution = await resumeCycleWithPorts(
      {
        configuration: input.configuration,
        repository: descriptor.repository,
        runRoot: input.runRoot,
        runId: input.runId,
        ...(input.signal ? { signal: input.signal } : {}),
      },
      effectivePorts,
    );
    if (!execution.ok && execution.error.code === 'CAPABILITY_UNSUPPORTED') {
      return freeze({ kind: 'unresolved', version: 1, runId: lock.spec.runId, reason: 'delegated_step_required' }) as ReconcileExecution;
    }
    if (!execution.ok || execution.value.kind !== 'result') refuse('RECOVERY_REQUIRED', '', 'recovery');
    if (execution.value.result.spec.status === 'reconcile_required') {
      return freeze({ kind: 'unresolved', version: 1, runId: lock.spec.runId, reason: 'remaining_unresolved_work' }) as ReconcileExecution;
    }
    const receipt = settledReceipt as OperationReceipt;
    return freeze({
      kind: 'settled',
      version: 1,
      runId: lock.spec.runId,
      status:
        execution.value.result.spec.status === 'completed'
          ? 'completed'
          : execution.value.result.spec.status === 'failed'
            ? 'failed'
            : 'blocked',
      outcome: receipt.outcome === 'succeeded' ? 'succeeded' : 'not_executed',
      externalEffects: execution.value.result.spec.externalEffects === 'confirmed' ? 'confirmed' : 'none',
      receipt: freeze(receipt),
    }) as ReconcileExecution;
  } catch (error) {
    primaryFailed = true;
    throw error;
  } finally {
    await releaseReconcileHandles(store, authority, owner, primaryFailed);
  }
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
async function reconcilePublication(input: ReconcileCycleInput, state: ReturnType<typeof approvedState>, plan: import('./types.js').CompiledPlan, raw: unknown, ports: ControllerPorts) {
  const publication = plan.publication;
  if (publication.mode !== 'pull_request') refuse('EVIDENCE_UNAVAILABLE', '/receipt', 'recovery');
  const { directory, descriptor, lock, effectivePorts } = await admit(input, plan, ports);
  let owner: ControllerOwner | null = null, store: LocalRunStore | null = null, authority: Authority | null = null;
  let primaryFailed = false;
  try {
    owner = await ControllerOwner.acquire(directory, input.runId, plan.planDigest);
    store = stateValue(reopenLocalRun(descriptor.identity)); const original = stateValue(store.inspect());
    if (original.clockStatus !== 'trusted') refuse('RECOVERY_REQUIRED', '', 'recovery');
    authority = stateValue(store.claim({ ownerId: 'controller.' + owner.nonce, expectedGeneration: original.owner.generation, expectedRevision: original.revision, mode: 'recovery' })).authority;
    const artifacts = new ArtifactStore(join(directory, 'artifacts'), owner, state.vault);
    await artifacts.cleanCasTempFiles();
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
    const body = stripVerdictSignature(file);
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
      const execution = await resumeCycleWithPorts({ configuration: input.configuration, repository: descriptor.repository, runRoot: input.runRoot, runId: input.runId, ...(input.signal ? { signal: input.signal } : {}) }, effectivePorts);
      if (!execution.ok || execution.value.kind !== 'result') refuse('RECOVERY_REQUIRED', '', 'recovery');
      const status = execution.value.result.spec.status;
      if (status === 'reconcile_required') return freeze({ kind: 'unresolved', version: 1, runId: lock.spec.runId, reason: 'remaining_unresolved_work' }) as ReconcileExecution;
      return freeze({ kind: 'settled', version: 1, runId: lock.spec.runId, status: status === 'completed' ? 'completed' : status === 'failed' ? 'failed' : 'blocked', outcome, externalEffects: execution.value.result.spec.externalEffects === 'confirmed' ? 'confirmed' : 'none', receipt: freeze(receipt) }) as ReconcileExecution;
    }
    if (executionStatus.status === 'reconcile_required') return freeze({ kind: 'unresolved', version: 1, runId: lock.spec.runId, reason: 'remaining_unresolved_work' }) as ReconcileExecution;
    if (executionStatus.status === 'incident_retained') return freeze({ kind: 'unresolved', version: 1, runId: lock.spec.runId, reason: 'incident_retained' }) as ReconcileExecution;
    return freeze({ kind: 'settled', version: 1, runId: lock.spec.runId, status: executionStatus.status === 'completed' ? 'completed' : 'failed', outcome, externalEffects: executionStatus.fx as 'confirmed' | 'none', receipt: freeze(receipt) }) as ReconcileExecution;
  } catch (error) {
    primaryFailed = true;
    throw error;
  } finally {
    await releaseReconcileHandles(store, authority, owner, primaryFailed);
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
