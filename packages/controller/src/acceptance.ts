import { createHash } from 'node:crypto';
import { closeSync, constants, fstatSync, lstatSync, openSync } from 'node:fs';
import { lstat, open } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import {
  VERIFIER_ARTIFACT_LIMITS,
  bindSubject,
  constructRunResult,
  evaluateAcceptance,
  isVerifierNamespacePath,
  parseVerifierArtifactPath,
  type ArtifactManifest,
  type ArtifactRef,
  type Evidence,
  type RequestUsage,
  type ResolvedArtifactInput,
  type RunResult,
  type RunStatus,
  type SubmittedCheck,
  type TaskLock,
  type VerificationResult,
} from '@loopwright/core';
import type { LocalRunStore } from '@loopwright/state';
import { authenticatedCheck, authenticatedRefusal, type PreflightRefusal, type VerifiedCheck } from './verification.js';
import { authenticatedGate } from './gate.js';
import { authenticatedBenchmarkGate } from './benchmark-gate.js';
import { STREAM_CHUNK_BYTES, inside } from './files.js';
import { journal } from './progress.js';
import { canonical, freeze, hash, same } from './schema.js';
import { ControllerFailure, refuse } from './errors.js';
import type { ControllerDiagnostic } from './errors.js';
import type { CandidateFileEntry, CompiledPlan } from './types.js';
import type { Submission } from './submission.js';

const EMPTY_SHA256_HEX = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';

interface PreverifiedCasStamp {
  readonly artifactsDir: string;
  readonly slotId: string;
  readonly name: string;
  readonly byteLength: number;
  readonly sha256: string;
  readonly dev: number;
  readonly ino: number;
  readonly mtimeMs: number;
  readonly ctimeMs: number;
}

export interface PreverifiedVerifierArtifacts {
  readonly version: 1;
}

export interface VerifyControllerVerifierCasOptions {
  readonly signal?: AbortSignal | undefined;
  readonly checkAuthority?: (() => Promise<void> | void) | undefined;
}

const preverifiedTokens = new WeakMap<PreverifiedVerifierArtifacts, ReadonlyMap<string, PreverifiedCasStamp>>();

function cancelledVerification(): ControllerFailure {
  return new ControllerFailure({
    version: 1,
    code: 'CANCELLED',
    phase: 'verification',
    path: '',
    stateCode: null,
    piCode: null,
    effect: 'none',
    retryable: false,
  });
}

function validateVerifierRefAndPath(
  artifactsDir: string,
  slotId: string,
  ref: ArtifactRef,
): string {
  if (!isVerifierNamespacePath(ref.name)) refuse('ARTIFACT_INVALID', '', 'verification');
  const parsed = parseVerifierArtifactPath(ref.name);
  if (
    parsed === null
    || parsed.slotId !== slotId
    || ref.digest.algorithm !== 'sha256'
    || !/^[0-9a-f]{64}$/.test(ref.digest.hex)
    || !Number.isSafeInteger(ref.byteLength)
    || Object.is(ref.byteLength, -0)
    || ref.byteLength < 0
    || ref.byteLength > VERIFIER_ARTIFACT_LIMITS.maxFileBytes
    || (ref.byteLength === 0) !== (ref.digest.hex === EMPTY_SHA256_HEX)
    || ref.uri !== 'cas://sha256/' + ref.digest.hex
  ) {
    refuse('ARTIFACT_INVALID', '', 'verification');
  }
  if (
    typeof artifactsDir !== 'string'
    || !isAbsolute(artifactsDir)
    || resolve(artifactsDir) !== artifactsDir
  ) {
    refuse('ARTIFACT_INVALID', '', 'verification');
  }
  const blobPath = join(artifactsDir, 'blobs', 'sha256', ref.digest.hex);
  if (!inside(blobPath, artifactsDir) || blobPath === artifactsDir) {
    refuse('ARTIFACT_INVALID', '', 'verification');
  }
  return blobPath;
}

function verifyCanonicalPathSync(artifactsDir: string, blobPath: string): void {
  let current = blobPath;
  for (let depth = 0; depth < 128; depth++) {
    let st: ReturnType<typeof lstatSync>;
    try {
      st = lstatSync(current);
    } catch {
      refuse('ARTIFACT_INVALID', '', 'verification');
    }
    if (st.isSymbolicLink()) refuse('ARTIFACT_INVALID', '', 'verification');
    if (current === artifactsDir) break;
    const parent = dirname(current);
    if (parent === current) refuse('ARTIFACT_INVALID', '', 'verification');
    current = parent;
  }
}

async function verifyCanonicalPathAsync(artifactsDir: string, blobPath: string): Promise<void> {
  let current = blobPath;
  for (let depth = 0; depth < 128; depth++) {
    let st: Awaited<ReturnType<typeof lstat>>;
    try {
      st = await lstat(current);
    } catch {
      refuse('ARTIFACT_INVALID', '', 'verification');
    }
    if (st.isSymbolicLink()) refuse('ARTIFACT_INVALID', '', 'verification');
    if (current === artifactsDir) break;
    const parent = dirname(current);
    if (parent === current) refuse('ARTIFACT_INVALID', '', 'verification');
    current = parent;
  }
}

async function verifyLocalVerifierCasDescriptorAsync(
  artifactsDir: string,
  slotId: string,
  ref: ArtifactRef,
  options?: VerifyControllerVerifierCasOptions,
): Promise<PreverifiedCasStamp> {
  if (options?.checkAuthority) await options.checkAuthority();
  if (options?.signal?.aborted) throw cancelledVerification();

  const blobPath = validateVerifierRefAndPath(artifactsDir, slotId, ref);
  await verifyCanonicalPathAsync(artifactsDir, blobPath);

  let before: Awaited<ReturnType<typeof lstat>>;
  try {
    before = await lstat(blobPath);
  } catch {
    refuse('ARTIFACT_INVALID', '', 'verification');
  }
  if (
    before.isSymbolicLink()
    || !before.isFile()
    || before.nlink !== 1
    || before.uid !== process.getuid?.()
    || (before.mode & 0o7777) !== 0o400
    || before.size !== ref.byteLength
  ) {
    refuse('ARTIFACT_INVALID', '', 'verification');
  }

  let handle: Awaited<ReturnType<typeof open>>;
  try {
    handle = await open(blobPath, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch {
    refuse('ARTIFACT_INVALID', '', 'verification');
  }
  try {
    const info = await handle.stat();
    if (
      !info.isFile()
      || info.nlink !== 1
      || info.dev !== before.dev
      || info.ino !== before.ino
      || info.uid !== process.getuid?.()
      || info.size !== ref.byteLength
      || (info.mode & 0o7777) !== 0o400
    ) {
      refuse('ARTIFACT_INVALID', '', 'verification');
    }
    const sha = createHash('sha256');
    const chunkBuf = Buffer.allocUnsafe(Math.min(STREAM_CHUNK_BYTES, Math.max(1, info.size)));
    let offset = 0;
    while (offset < info.size) {
      if (options?.checkAuthority) await options.checkAuthority();
      if (options?.signal?.aborted) throw cancelledVerification();
      const toRead = Math.min(chunkBuf.byteLength, info.size - offset);
      const { bytesRead } = await handle.read(chunkBuf, 0, toRead, offset);
      if (bytesRead <= 0) break;
      sha.update(chunkBuf.subarray(0, bytesRead));
      offset += bytesRead;
    }
    if (options?.checkAuthority) await options.checkAuthority();
    if (options?.signal?.aborted) throw cancelledVerification();

    const probe = Buffer.allocUnsafe(1);
    const { bytesRead: extra } = await handle.read(probe, 0, 1, offset);
    const after = await handle.stat();
    if (
      extra !== 0
      || offset !== info.size
      || !after.isFile()
      || after.nlink !== 1
      || after.dev !== info.dev
      || after.ino !== info.ino
      || after.uid !== process.getuid?.()
      || after.size !== info.size
      || after.mtimeMs !== info.mtimeMs
      || after.ctimeMs !== info.ctimeMs
      || (after.mode & 0o7777) !== 0o400
      || sha.digest('hex') !== ref.digest.hex
    ) {
      refuse('ARTIFACT_INVALID', '', 'verification');
    }
    return freeze({
      artifactsDir,
      slotId,
      name: ref.name,
      byteLength: ref.byteLength,
      sha256: ref.digest.hex,
      dev: after.dev,
      ino: after.ino,
      mtimeMs: after.mtimeMs,
      ctimeMs: after.ctimeMs,
    });
  } finally {
    await handle.close();
  }
}

function stampKey(operationId: string, ref: ArtifactRef): string {
  return `${operationId}\0${ref.name}\0${ref.digest.hex}\0${String(ref.byteLength)}`;
}

/**
 * Awaited, cancellable <= 1 MiB streaming verifier CAS hash pass run before pure acceptance evaluation
 * so multi-MiB / GiB hardware outputs never block the controller event loop.
 */
export async function verifyControllerVerifierCasDescriptors(
  plan: CompiledPlan,
  checks: readonly VerifiedCheck[],
  options?: VerifyControllerVerifierCasOptions,
): Promise<PreverifiedVerifierArtifacts> {
  const allStamps = new Map<string, PreverifiedCasStamp>();
  for (const checked of checks) {
    const slot = plan.verifierSlots.find(item => item.id === checked.slotId);
    if (!slot || slot.handler.implementation !== 'benchmark-gate.v1') continue;
    const bmObs = authenticatedBenchmarkGate(checked);
    if (!same(bmObs.evidence.spec.artifacts, [checked.output, ...bmObs.verifierArtifacts])) {
      refuse('EVIDENCE_UNAVAILABLE', '', 'verification');
    }
    for (const verifierRef of bmObs.verifierArtifacts) {
      const stamp = await verifyLocalVerifierCasDescriptorAsync(
        bmObs.artifactsDirectory,
        slot.id,
        verifierRef,
        options,
      );
      const key = stampKey(checked.operationId, verifierRef);
      allStamps.set(key, stamp);
    }
  }
  const token: PreverifiedVerifierArtifacts = freeze({ version: 1 });
  preverifiedTokens.set(token, allStamps);
  return token;
}

function verifyPreverifiedCasStampSync(
  stamp: PreverifiedCasStamp,
  artifactsDir: string,
  slotId: string,
  ref: ArtifactRef,
): { readonly name: string; readonly byteLength: number; readonly digest: { readonly algorithm: 'sha256'; readonly hex: string } } {
  const blobPath = validateVerifierRefAndPath(artifactsDir, slotId, ref);
  if (
    stamp.artifactsDir !== artifactsDir
    || stamp.slotId !== slotId
    || stamp.name !== ref.name
    || stamp.byteLength !== ref.byteLength
    || stamp.sha256 !== ref.digest.hex
  ) {
    refuse('ARTIFACT_INVALID', '', 'verification');
  }
  verifyCanonicalPathSync(artifactsDir, blobPath);
  let before: ReturnType<typeof lstatSync>;
  try {
    before = lstatSync(blobPath);
  } catch {
    refuse('ARTIFACT_INVALID', '', 'verification');
  }
  if (
    before.isSymbolicLink()
    || !before.isFile()
    || before.nlink !== 1
    || before.uid !== process.getuid?.()
    || (before.mode & 0o7777) !== 0o400
    || before.size !== stamp.byteLength
    || before.dev !== stamp.dev
    || before.ino !== stamp.ino
    || before.mtimeMs !== stamp.mtimeMs
    || before.ctimeMs !== stamp.ctimeMs
  ) {
    refuse('ARTIFACT_INVALID', '', 'verification');
  }
  let fd: number;
  try {
    fd = openSync(blobPath, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch {
    refuse('ARTIFACT_INVALID', '', 'verification');
  }
  try {
    const info = fstatSync(fd);
    if (
      !info.isFile()
      || info.nlink !== 1
      || info.uid !== process.getuid?.()
      || (info.mode & 0o7777) !== 0o400
      || info.size !== stamp.byteLength
      || info.dev !== stamp.dev
      || info.ino !== stamp.ino
      || info.mtimeMs !== stamp.mtimeMs
      || info.ctimeMs !== stamp.ctimeMs
    ) {
      refuse('ARTIFACT_INVALID', '', 'verification');
    }
  } finally {
    closeSync(fd);
  }
  return {
    name: ref.name,
    byteLength: ref.byteLength,
    digest: { algorithm: 'sha256', hex: ref.digest.hex },
  };
}
export interface AcceptanceObservation {
  readonly result: RunResult; readonly verification: VerificationResult; readonly requestedStatus: Submission['status'] | null; readonly diagnostic: ControllerDiagnostic['code'] | null;
  readonly preflightRefusals: readonly { readonly origin: 'controller_preflight'; readonly slotId: string; readonly checkId: string; readonly generation: number; readonly code: 'OUTPUT_LIMIT'; readonly record: import('@loopwright/core').ArtifactRef; readonly limits: import('./refusal-record.js').SizingDescription }[];
  readonly selectedNoChangeCheck: string | null; readonly contradictions: readonly string[];
  readonly verifierMatrix: readonly { readonly slotId: string; readonly checkId: string; readonly status: 'passed' | 'failed' | 'blocked' | 'not_run'; readonly reason: string | null; readonly implicit: 'scope' | 'no_change' | null }[];
}
/** Core inputs are JSON-owned here so shared immutable source refs cannot create input aliases. */
const tree = (input: unknown): unknown => JSON.parse(canonical(input));
export function evaluateControllerAcceptance(plan: CompiledPlan, lock: TaskLock, candidate: ArtifactManifest, candidateFiles: readonly (ResolvedArtifactInput | CandidateFileEntry)[], generation: number,
  checks: readonly VerifiedCheck[], submission: Submission | null, store: LocalRunStore, forced: 'reconcile_required' | 'expired' | 'cancelled' | 'exhausted' | 'blocked' | 'failed' | null = null, graphComplete = true, refusals: readonly PreflightRefusal[] = [], forcedDiagnostic: ControllerDiagnostic['code'] | null = null, preverified?: PreverifiedVerifierArtifacts): AcceptanceObservation {
  if (!same(plan.task, lock.spec.contract)) refuse('ARTIFACT_INVALID', '', 'verification');
  let authenticatedStamps: ReadonlyMap<string, PreverifiedCasStamp> | undefined;
  if (preverified !== undefined) {
    authenticatedStamps = preverifiedTokens.get(preverified);
    if (!authenticatedStamps) refuse('EVIDENCE_UNAVAILABLE', '', 'verification');
  }
  const overlayOpts = lock.spec.contract.spec.budgets.overlay ? { overlay: lock.spec.contract.spec.budgets.overlay } : undefined;
  const bound = bindSubject(lock, candidate, overlayOpts); if (!bound.ok) refuse('ARTIFACT_INVALID', '', 'verification'); const subject = bound.value, records = journal(store);
  const eligible: Evidence[] = [], artifacts: ResolvedArtifactInput[] = candidateFiles.map(file =>
    'bytes' in file
      ? { name: file.name, bytes: file.bytes }
      : { name: file.name, byteLength: file.byteLength, digest: { algorithm: file.digest.algorithm, hex: file.digest.hex } },
  ), bySlot = new Map<string, VerifiedCheck>();
  for (const checked of checks) {
    const slot = plan.verifierSlots.find(item => item.id === checked.slotId);
    const impl = slot?.handler.implementation;
    const original = impl === 'gate.v1'
      ? authenticatedGate(checked)
      : impl === 'benchmark-gate.v1'
        ? authenticatedBenchmarkGate(checked)
        : authenticatedCheck(checked);
    const operation = records.operations.find(item => item.intent.operationId === checked.operationId);
    const expectedProducer = impl === 'gate.v1'
      ? 'loopwright.gate-verifier.v1'
      : impl === 'benchmark-gate.v1'
        ? 'loopwright.benchmark-gate.v1'
        : 'loopwright.byte-verifier.v1';
    if (
      !slot
      || bySlot.has(slot.id)
      || checked.generation !== generation
      || checked.checkId !== slot.checkId
      || !same(original.subject, subject)
      || !same(original.evidence.spec.subject, subject)
      || original.evidence.spec.observedStatus !== checked.status
      || original.evidence.spec.checkId !== slot.checkId
      || original.evidence.spec.producerId !== expectedProducer
      || (impl === 'benchmark-gate.v1' && original.evidence.spec.level !== 'hardware_execution')
      || !same(original.planDigest, plan.planDigest)
      || !same(original.header.handlerDigest, slot.handler.digest)
      || original.header.handler !== slot.handler.implementation
      || !same(original.header.candidate.ref.digest, hash(canonical(candidate)))
      || original.header.candidate.ref.byteLength !== Buffer.byteLength(canonical(candidate))
      || !operation
      || operation.state !== 'confirmed'
      || !same(operation.intent.requestDigest, original.requestDigest)
      || !same(operation.reconciliation ?? operation.initialReceipt, original.receipt)
      || !same(original.receipt.evidence.artifact, checked.output)
    ) {
      refuse('EVIDENCE_UNAVAILABLE', '', 'verification');
    }
    bySlot.set(slot.id, checked);
    artifacts.push({ name: checked.output.name, bytes: original.outputBytes });
    if (impl === 'benchmark-gate.v1') {
      const bmObs = authenticatedBenchmarkGate(checked);
      if (!same(bmObs.evidence.spec.artifacts, [checked.output, ...bmObs.verifierArtifacts])) {
        refuse('EVIDENCE_UNAVAILABLE', '', 'verification');
      }
      for (const verifierRef of bmObs.verifierArtifacts) {
        if (!authenticatedStamps) {
          refuse('EVIDENCE_UNAVAILABLE', '', 'verification');
        }
        const key = stampKey(checked.operationId, verifierRef);
        const stamp = authenticatedStamps.get(key);
        if (!stamp) {
          refuse('EVIDENCE_UNAVAILABLE', '', 'verification');
        }
        artifacts.push(verifyPreverifiedCasStampSync(stamp, bmObs.artifactsDirectory, slot.id, verifierRef));
      }
    }
    if (slot.implicit === null) eligible.push(original.evidence);
  }
  const negativeBySlot = new Map<string, PreflightRefusal>();
  const negativeObservations: AcceptanceObservation['preflightRefusals'][number][] = [];
  for (const refusal of refusals) {
    const original = authenticatedRefusal(refusal), slot = plan.verifierSlots.find(slot => slot.id === refusal.slotId), operation = store.getOperation(refusal.prospectiveOperationId);
    if (!slot || bySlot.has(slot.id) || negativeBySlot.has(slot.id) || refusal.status !== 'blocked' || refusal.generation !== generation || refusal.checkId !== slot.checkId || original.storeId !== records.view.storeId
      || !same(original.clockBasis, records.view.clock.basis) || !same(original.value.subject, subject) || !same(original.value.planDigest, plan.planDigest) || !same(original.value.handlerDigest, slot.handler.digest)
      || original.value.generation !== generation || original.value.prospectiveOperationId !== refusal.prospectiveOperationId || original.value.producerNonce !== refusal.producerNonce || !same(original.row.record, refusal.record)
      || original.value.candidate.ref.byteLength !== Buffer.byteLength(canonical(candidate)) || !same(original.value.candidate.ref.digest, hash(canonical(candidate))) || operation.ok || operation.error.code !== 'RECORD_NOT_FOUND') refuse('EVIDENCE_UNAVAILABLE', '', 'verification');
    negativeBySlot.set(slot.id, refusal); negativeObservations.push({ origin: 'controller_preflight', slotId: slot.id, checkId: slot.checkId, generation, code: 'OUTPUT_LIMIT', record: refusal.record, limits: original.value.limits });
  }
  const matrix = plan.verifierSlots.map(slot => { const value = bySlot.get(slot.id) ?? negativeBySlot.get(slot.id); return { slotId: slot.id, checkId: slot.checkId, status: value?.status ?? 'not_run' as const, reason: value?.reason ?? (value ? null : 'verifier_not_run'), implicit: slot.implicit }; });
  const claims: SubmittedCheck[] = plan.task.spec.acceptance.checks.map(check => {
    const slot = plan.verifierSlots.find(slot => slot.implicit === null && slot.checkId === check.id)!, verified = bySlot.get(slot.id);
    const negative = negativeBySlot.get(slot.id); if (negative) return { checkId: check.id, status: 'blocked', evidenceId: null, reason: negative.reason };
    if (!verified) return { checkId: check.id, status: 'not_run', evidenceId: null, reason: 'verifier_not_run' };
    const evidence = slot.handler.implementation === 'gate.v1'
      ? authenticatedGate(verified).evidence
      : slot.handler.implementation === 'benchmark-gate.v1'
        ? authenticatedBenchmarkGate(verified).evidence
        : authenticatedCheck(verified).evidence;
    return {
      checkId: check.id,
      status: verified.status,
      evidenceId: evidence.metadata.id,
      reason: verified.reason,
      ...(Object.hasOwn(evidence.spec, 'detail') && evidence.spec.detail !== undefined ? { detail: evidence.spec.detail } : {}),
      ...(evidence.spec.metrics !== undefined ? { metrics: evidence.spec.metrics } : {}),
      ...(evidence.spec.findings !== undefined ? { findings: evidence.spec.findings } : {}),
    };
  });
  const contradictions = (submission?.checks ?? []).filter(claim => claim.status === 'passed' && claims.some(actual => actual.checkId === claim.checkId && actual.status === 'failed')).map(claim => claim.checkId);
  const input = { trusted: { expectedLock: lock, candidateManifest: candidate, eligibleEvidence: eligible }, claims }, evaluated = evaluateAcceptance(tree(input), artifacts, overlayOpts);
  if (!evaluated.ok) refuse('RECOVERY_REQUIRED', '', 'verification');
  const selected = [...plan.task.spec.acceptance.required].sort().find(id => plan.task.spec.acceptance.checks.find(check => check.id === id)!.allowedEvidenceLevels.includes('local_execution')
    && plan.verifierSlots.some(slot => slot.implicit === null && slot.checkId === id && slot.handler.implementation === 'no-change.v1')) ?? null;
  if (selected !== plan.noChangeEligibility.checkId) refuse('RECOVERY_REQUIRED', '', 'verification');
  const selectedSlot = plan.verifierSlots.find(slot => slot.implicit === null && slot.checkId === selected), proof = selectedSlot ? bySlot.get(selectedSlot.id) : undefined;
  const scope = matrix.find(row => row.implicit === 'scope')!, equality = matrix.find(row => row.implicit === 'no_change')!;
  const noChangeProof = proof && proof.status === 'passed' && authenticatedCheck(proof).evidence.spec.method === 'verify_no_change' ? authenticatedCheck(proof).evidence : null;
  const missingNoChange = submission?.status === 'no_change' && (selected === null || noChangeProof === null || equality.status !== 'passed');
  const unknown = records.view.clockStatus !== 'trusted' || records.view.counts.dispatchedRequests || records.view.counts.unresolvedRequests || records.view.counts.unresolvedOperations || records.view.ledger.violations.length;
  let status: RunStatus;
  if (unknown) status = 'reconcile_required';
  else if (BigInt(records.view.clock.sampledNow.monotonicMs) >= BigInt(records.view.clock.basis.taskDeadlineMonotonicMs)) status = 'expired';
  else if (forced) status = forced;
  else if (evaluated.value.spec.required.some(row => row.status === 'failed') || scope.status === 'failed' || submission?.status === 'failed' || submission?.status === 'no_change' && equality.status === 'failed') status = 'failed';
  else if (!graphComplete || !evaluated.value.spec.satisfied || scope.status !== 'passed' || missingNoChange || submission?.status === 'blocked') status = 'blocked';
  else status = submission?.status ?? 'blocked';
  const usage: RequestUsage[] = [];
  for (const item of records.requests) {
    if (item.dispatch === null && (item.state === 'released' || item.state === 'reserved')) continue;
    const observed = item.resolution?.kind === 'terminal_usage' ? item.resolution.observation : item.initialObservation;
    usage.push(observed?.usage ?? { requestId: item.admission.requestId, inputTokens: { provenance: 'unknown' }, outputTokens: { provenance: 'unknown' }, costMicrousd: { provenance: 'unknown' } });
  }
  const external = records.operations.filter(item => item.intent.effect === 'external_write');
  let externalEffects: 'none' | 'possible' | 'confirmed' | 'unknown' = 'none', publicationNotExecuted = false;
  for (const item of external) {
    const receipt = item.reconciliation ?? item.initialReceipt;
    if (item.state === 'dispatch_uncertain' || item.state === 'unresolved') externalEffects = 'unknown';
    else if (receipt?.outcome === 'succeeded') externalEffects = 'confirmed';
    else if (receipt?.outcome === 'not_executed') publicationNotExecuted = true;
    else if (receipt?.outcome === 'failed') externalEffects = 'unknown';
  }
  if (externalEffects === 'unknown') status = 'reconcile_required';
  else if (publicationNotExecuted) status = 'failed';
  const draft = { trusted: { ...input.trusted, usage, externalEffects, noChange: status === 'no_change' ? { checkId: selected!, evidenceId: noChangeProof!.metadata.id, reason: 'candidate_equals_source' } : null },
    candidate: { status, checks: claims, memory: { status: 'not_requested', reason: null } } };
  const result = constructRunResult(tree(draft), artifacts, overlayOpts); if (!result.ok) refuse('RECOVERY_REQUIRED', '', 'verification');
  return freeze({ result: result.value, verification: evaluated.value, requestedStatus: submission?.status ?? null, diagnostic: forcedDiagnostic ?? (missingNoChange ? 'EVIDENCE_UNAVAILABLE' : null), selectedNoChangeCheck: selected, contradictions, verifierMatrix: matrix, preflightRefusals: negativeObservations });
}
