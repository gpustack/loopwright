import { mkdir, open } from 'node:fs/promises';
import { constants } from 'node:fs';
import { join, resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
import { openPiAdapterV2, type PiAdapterV2, type PiHostV2, type PiOpenInputV2, type PiOutcomeV2 } from '@loopwright/agent-pi';
import { admitTask, bindSubject, identifyManifest, type ArtifactRef, type TaskLock } from '@loopwright/core';
import { createLocalRun, type Authority, type LocalRunIdentity, type LocalRunStore } from '@loopwright/state';
import { approvedState } from './config.js';
import { compilePlan } from './compile.js';
import { ControllerFailure, refuse, result, type ControllerDiagnostic } from './errors.js';
import { privateDirectory, ArtifactStore, checkedRef, stateValue } from './storage.js';
import { ControllerOwner, bootIdentity } from './ownership.js';
import { freezeSource, materializeBaseline, verifySource, type FrozenSource } from './source.js';
import { ProgressStore, stableId, journal, type ProgressHead } from './progress.js';
import { captureRole, adoptRoleCapture, nativeSessionId, type CapturedRole } from './capture.js';
import { retainSubmission, normalizeSubmission, type Submission, type RetainedSubmission } from './submission.js';
import { prepareVerification, preflightVerification, Verifier, authenticatedCheck, type PreflightRefusal, type VerifiedCheck, type ByteInventory, type PreparedVerification } from './verification.js';
import { prepareGate, Gate, authenticatedGate, type PreparedGate } from './gate.js';
import { preparePublication, Publication, headRevision, type PreparedPublication } from './publication.js';
import { evaluateControllerAcceptance, type AcceptanceObservation } from './acceptance.js';
import { nextNode, descendants, compactionTarget } from './scheduler.js';
import { failureSignature, rememberFailure, repairDisposition, formatPolicy, formatPrompt } from './repair.js';
import { WorkDeadline } from './deadlines.js';
import { observeParentExhaustion, schedulingSnapshot, isNoEffectBudgetRefusal } from './budget-observations.js';
import { ControllerEvents, type ControllerEvent } from './events.js';
import { Finalizer, incident, type ControllerIncident, type CycleExecution } from './finalize.js';
import { canonical, freeze, hash, id, record, same, text } from './schema.js';
import { parsePrivateJson } from './parser.js';
import type { CompiledPlan, ControllerAttempt, ControllerProgress, LoadedConfiguration, PlannedRole } from './types.js';

export interface RunCycleInput { readonly configuration: LoadedConfiguration; readonly repository: string; readonly runRoot: string; readonly runId: string; readonly signal?: AbortSignal; readonly onEvent?: (event: ControllerEvent) => Promise<void> }
export interface RunDescriptor {
  readonly version: 1; readonly identity: LocalRunIdentity; readonly plan: ArtifactRef; readonly source: ArtifactRef; readonly sourceWorkspace: ArtifactRef;
  readonly configuration: { readonly configPath: string; readonly registryPath: string; readonly registrySha256: string }; readonly repository: string;
}
/** Trusted local observations only, absent from root exports and all configuration/CLI fields. */
export interface ControllerPorts {
  readonly openAdapter?: (host: PiHostV2, input: PiOpenInputV2) => ReturnType<typeof openPiAdapterV2>;
  readonly afterCheckpoint?: (phase: string, head: ProgressHead) => Promise<void>;
}
export interface CycleContext {
  readonly loaded: LoadedConfiguration; readonly plan: CompiledPlan; readonly lock: TaskLock; readonly directory: string; readonly source: FrozenSource;
  readonly store: LocalRunStore; readonly authority: Authority; readonly owner: ControllerOwner; readonly artifacts: ArtifactStore; readonly progress: ProgressStore; readonly descriptor: RunDescriptor;
  readonly signal: AbortSignal; readonly onEvent: RunCycleInput['onEvent']; readonly ports: ControllerPorts;
}
type Draft = Omit<ControllerProgress, 'sequence' | 'previous' | 'stage'> & { readonly stage: Omit<ControllerProgress['stage'], 'consumed' | 'watermarks'> };
const isRecord = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const safeDiagnostic = (error: unknown, phase: ControllerDiagnostic['phase']): ControllerDiagnostic => error instanceof ControllerFailure ? error.diagnostic : { version: 1, code: 'STATE_UNAVAILABLE', phase, path: '', stateCode: null, piCode: null, effect: 'possible', retryable: false };
async function exclusiveJson(path: string, value: unknown): Promise<void> {
  const bytes = Buffer.from(canonical(value)); if (bytes.length > 1048576) refuse('OUTPUT_LIMIT', '', 'admission');
  const file = await open(path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600); try { await file.writeFile(bytes); await file.sync(); } finally { await file.close(); }
  const parent = await open(resolve(path, '..'), constants.O_RDONLY | constants.O_NOFOLLOW); try { await parent.sync(); } finally { await parent.close(); }
}
export async function createCycle(input: RunCycleInput, ports: ControllerPorts): Promise<CycleContext> {
  const state = approvedState(input.configuration), compiled = await compilePlan(input.configuration); if (!compiled.ok) throw new ControllerFailure(compiled.error); const plan = compiled.value;
  const runId = id(input.runId), root = resolve(text(input.runRoot)), repository = resolve(text(input.repository)), directory = join(root, runId);
  const excluded = [repository, process.cwd(), ...state.input.untrustedRoots];
  await privateDirectory(root, excluded);
  try { await mkdir(directory, { mode: 0o700 }); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'EEXIST') refuse('OWNER_BUSY', '', 'admission'); throw error; }
  let owner: ControllerOwner | null = null, store: LocalRunStore | null = null;
  try {
    owner = await ControllerOwner.acquire(directory, runId, plan.planDigest); const artifactDirectory = join(directory, 'artifacts'); await privateDirectory(artifactDirectory);
    const artifacts = new ArtifactStore(artifactDirectory, owner, state.vault);
    const jsonPaths = plan.verifierSlots.filter(slot => slot.handler.implementation === 'json-artifact.v1').map(slot => text(slot.handler.parameters.path));
    const source = await freezeSource(repository, plan.task, owner, artifacts, jsonPaths);
    const admitted = admitTask(plan.task, { admissionId: 'admission.' + hash('loopwright.dev/controller/admission/v1\0' + runId + '\0' + plan.planDigest.hex).hex.slice(0, 40), runId });
    if (!admitted.ok) refuse('CONFIG_SCHEMA', '/spec/task', 'admission'); const lock = admitted.value, manifest = await artifacts.json('manifest', source.manifest, 32768);
    const initial: ByteInventory = { manifest: source.manifest, ref: manifest, files: source.artifacts, baselineProofs: source.baselineProofs };
    // Core identity is pure; complete byte preflight still precedes S02 create/claim and every initial dispatch.
    for (const slot of plan.verifierSlots) if (slot.handler.implementation !== 'gate.v1') prepareVerification(plan, lock, slot.id, initial, initial, 0, randomBytes(16).toString('hex'));
    const planRef = await artifacts.json('plan', plan, 1048576), lockRef = await artifacts.json('task-lock', lock, 1048576);
    const identity: LocalRunIdentity = { directory: join(directory, 'state'), storeId: 'store.' + hash('loopwright.dev/controller/store/v1\0' + runId).hex.slice(0, 40), lock,
      policy: { version: 1, leaseMs: 60000, cost: 'observe_only' }, binding: { coreApiVersion: 'loopwright.dev/v1alpha1', hostVersion: 's04-controller-v1', adapters: [{ id: 'pi', version: '0.0.0' }],
        resourceVersion: plan.task.spec.trustedContext.revision, clockEpoch: 'boot.' + hash(await bootIdentity()).hex.slice(0, 40) } };
    const descriptor: RunDescriptor = { version: 1, identity, plan: planRef, source: source.inventory, sourceWorkspace: source.workspace,
      configuration: { configPath: state.input.configPath, registryPath: state.input.registryPath, registrySha256: state.input.registrySha256 }, repository };
    state.vault.assertClean(descriptor); await exclusiveJson(join(directory, 'run.json'), descriptor);
    store = stateValue(createLocalRun(identity)); const current = stateValue(store.inspect()), authority = stateValue(store.claim({ ownerId: 'controller.' + owner.nonce, expectedGeneration: current.owner.generation, expectedRevision: current.revision, mode: 'active' })).authority;
    const progress = new ProgressStore(store, authority, artifacts, plan, lock, planRef, source.inventory);
    // lockRef is private provenance; source/plan remain the four-ref checkpoint roots.
    await artifacts.json('admission', { version: 1, lock: lockRef, source: source.inventory, plan: planRef }, 65536);
    return { loaded: input.configuration, plan, lock, directory, source, store, authority, owner, artifacts, progress, descriptor, signal: input.signal ?? new AbortController().signal, onEvent: input.onEvent, ports };
  } catch (error) { if (store) stateValue(store.close()); if (owner) await owner.release(); throw error; }
}
export class Cycle {
  head: ProgressHead | null; candidate: ByteInventory; submission: RetainedSubmission | null = null; readonly checks = new Map<string, VerifiedCheck>(); readonly refusals = new Map<string, PreflightRefusal>();
  readonly deadline: WorkDeadline; readonly events: ControllerEvents; readonly verifier: Verifier; readonly gate: Gate; readonly publisher: Publication;
  #activeAdapter: PiAdapterV2 | null = null; #candidateKnown = true; #cleanup: ControllerIncident['cleanup'] = 'complete';
  #publicationObservation: { readonly status: 'not_run' | 'confirmed' | 'failed' | 'unresolved'; readonly reason: string | null; readonly receipt: ArtifactRef | null } = { status: 'not_run', reason: 'disabled', receipt: null };
  constructor(readonly context: CycleContext, head: ProgressHead | null = null, candidate?: ByteInventory, readonly resumeAdoption?: boolean) {
    this.head = head; this.candidate = candidate ?? { manifest: context.source.manifest, ref: { name: '', digest: hash(''), byteLength: 0 }, files: context.source.artifacts, baselineProofs: context.source.baselineProofs };
    this.deadline = new WorkDeadline(context.store, context.authority, context.plan.controls.drainReserveMs, context.signal);
    this.events = new ControllerEvents(context.store, context.artifacts, context.onEvent, () => this.deadline.stop('OUTPUT_LIMIT'), head?.progress.eventSequence ?? 0);
    this.verifier = new Verifier(context.store, context.authority, context.artifacts, context.plan, context.lock, () => { const bound = bindSubject(context.lock, this.candidate.manifest); if (!bound.ok) refuse('ARTIFACT_INVALID', '', 'verification'); return bound.value; });
    this.gate = new Gate(context.store, context.authority, context.artifacts, context.plan, context.lock, ref => approvedState(context.loaded).vault.resolveNetworkCredential(ref),
      () => { const bound = bindSubject(context.lock, this.candidate.manifest); if (!bound.ok) refuse('ARTIFACT_INVALID', '', 'verification'); return bound.value; },
      detail => this.events.push('gate_waiting', null, null, null, [], detail));
    this.publisher = new Publication(context.store, context.authority, context.artifacts, context.plan, context.lock, ref => approvedState(context.loaded).vault.resolveNetworkCredential(ref),
      () => { const bound = bindSubject(context.lock, this.candidate.manifest); if (!bound.ok) refuse('ARTIFACT_INVALID', '', 'verification'); return bound.value; }, context.descriptor.repository);
    if (head && head.progress.publication.status !== 'idle') {
      const prior = head.progress.publication;
      this.#publicationObservation = prior.status === 'confirmed' ? { status: 'confirmed', reason: null, receipt: prior.receipt }
        : prior.status === 'failed' ? { status: 'failed', reason: 'not_executed', receipt: prior.receipt } : { status: 'unresolved', reason: 'unresolved', receipt: null };
    }
  }
  get generation(): number { return this.head?.progress.candidate.generation ?? 0; }
  get draft(): Draft {
    if (!this.head) refuse('RECOVERY_REQUIRED', '', 'execution'); return { ...this.head.progress, eventSequence: this.events.sequence };
  }
  async publish(draft: Draft, phase: string): Promise<void> {
    this.head = await this.context.progress.publish({ ...draft, eventSequence: this.events.sequence }, phase);
    await this.context.ports.afterCheckpoint?.(phase, this.head);
  }
  async bootstrap(): Promise<void> {
    const { plan, lock, source, artifacts } = this.context;
    const manifest = await artifacts.json('manifest', source.manifest, 32768); this.candidate = { manifest: source.manifest, ref: manifest, files: source.artifacts, baselineProofs: source.baselineProofs };
    const bound = bindSubject(lock, source.manifest); if (!bound.ok) refuse('ARTIFACT_INVALID', '', 'admission');
    await this.events.push('admission', null);
    await this.publish({ version: 2, runId: lock.spec.runId, lockHash: lock.spec.lockHash, stage: { kind: 'bootstrap', phase: 'bootstrap', capacity: plan.capacity },
      nodes: plan.orderedDAG.map(node => ({ id: node.id, state: 'pending' })), attempts: [], nativeCheckpoints: [], submission: null, publication: { status: 'idle', operationId: null, receipt: null },
      candidate: { manifest, digest: bound.value.candidateDigest, generation: 0, workspace: source.workspace, privateSession: null }, failures: [], verifierReceipts: [], verifierRefusals: [], eventSequence: this.events.sequence, terminalIntent: null }, 'bootstrap');
  }
  async guard(): Promise<void> { this.deadline.assert(); await this.context.owner.assertCurrent(); await verifySource(this.context.source, this.context.plan.task, this.context.owner); this.deadline.assert(); }
  async runVerifier(slotId: string): Promise<VerifiedCheck | PreflightRefusal> {
    const { plan, lock, artifacts } = this.context, existing = this.head!.progress.verifierReceipts.find(item => item.slot === slotId && item.generation === this.generation);
    const negative = this.head!.progress.verifierRefusals.find(item => item.slot === slotId && item.generation === this.generation);
    if (negative) {
      const known = this.refusals.get(slotId + ':' + this.generation); if (known) return known;
      const source = { manifest: this.context.source.manifest, ref: await artifacts.json('manifest', this.context.source.manifest, 32768), files: this.context.source.artifacts, baselineProofs: this.context.source.baselineProofs };
      const prepared = preflightVerification(plan, lock, slotId, source, this.candidate, this.generation, negative.producerNonce); if (prepared.kind !== 'refused') refuse('RECOVERY_REQUIRED', '', 'recovery');
      await this.verifier.validateStoredRefusal(prepared.prepared, negative);
      const ordinal = plan.verifierSlots.findIndex(slot => slot.id === slotId), phase = 'verify.' + this.generation + '.' + ordinal;
      if (!this.head!.progress.stage.consumed.includes(phase + '.post')) {
        if (this.draft.stage.phase !== phase + '.pre') refuse('RECOVERY_REQUIRED', '', 'recovery');
        await this.publish({ ...this.draft, stage: { ...this.draft.stage, kind: 'verifier_post' }, nodes: this.nodeDispositions(this.draft.nodes, this.generation, { slotId, status: 'blocked' }) }, phase + '.post');
      }
      const restored = await this.verifier.restoreRefusal(prepared.prepared, negative); this.refusals.set(slotId + ':' + this.generation, restored); return restored;
    }
    if (existing) {
      const key = slotId + ':' + this.generation, known = this.checks.get(key); if (known) return known;
      const gateSlot = plan.verifierSlots.find(item => item.id === slotId)!.handler.implementation === 'gate.v1';
      const job = gateSlot
        ? prepareGate(plan, lock, slotId, this.candidate, this.generation, existing.producerNonce, this.context.loaded.registry.spec.gateEndpoints)
        : prepareVerification(plan, lock, slotId, { manifest: this.context.source.manifest, ref: await artifacts.json('manifest', this.context.source.manifest, 32768), files: this.context.source.artifacts, baselineProofs: this.context.source.baselineProofs }, this.candidate, this.generation, existing.producerNonce);
      const operation = this.context.store.getOperation(job.operationId);
      const restored = !operation.ok && operation.error.code === 'RECORD_NOT_FOUND' && existing.receipt === null
        ? await (gateSlot ? this.gate.run(job as PreparedGate, this.deadline.abort.signal) : this.verifier.run(job as PreparedVerification, this.deadline.abort.signal))
        : await (gateSlot ? this.gate.restore(job as PreparedGate) : this.verifier.restore(job as PreparedVerification));
      if (existing.receipt !== null && (!same(existing.receipt, restored.receipt) || !same(existing.output, restored.output))) refuse('RECOVERY_REQUIRED', '', 'recovery');
      this.checks.set(key, restored);
      const ordinal = plan.verifierSlots.findIndex(slot => slot.id === slotId), phase = 'verify.' + this.generation + '.' + ordinal;
      if (!this.head!.progress.stage.consumed.includes(phase + '.post')) {
        if (this.draft.stage.phase !== phase + '.pre') refuse('RECOVERY_REQUIRED', '', 'recovery');
        let failures = this.draft.failures;
        if (restored.status === 'failed') {
          const slot = plan.verifierSlots[ordinal]!, trusted = gateSlot ? authenticatedGate(restored) : authenticatedCheck(restored), stable = hash(canonical({ slot: slot.id, handler: slot.handler.digest, reason: restored.reason, method: trusted.evidence.spec.method, parameters: slot.handler.parameters }));
          failures = rememberFailure(failures, failureSignature({ category: 'implementation', codes: [restored.reason!], handler: slot.handler.implementation, handlerVersion: 1, target: typeof slot.handler.parameters.path === 'string' ? slot.handler.parameters.path : slot.id, candidate: trusted.subject.candidateDigest, evidence: [stable] }), this.generation, restored.output);
        }
        await this.publish({ ...this.draft, failures, stage: { ...this.draft.stage, kind: 'verifier_post' },
          verifierReceipts: this.draft.verifierReceipts.map(item => item.slot === slotId && item.generation === this.generation ? { ...item, output: restored.output, receipt: restored.receipt } : item),
          nodes: this.nodeDispositions(this.draft.nodes, this.generation) }, phase + '.post');
      }
      return restored;
    }
    if (this.draft.failures.length >= 16) refuse('OUTPUT_LIMIT', '', 'verification');
    await this.guard(); const ordinal = plan.verifierSlots.findIndex(slot => slot.id === slotId); if (ordinal < 0) refuse('EVIDENCE_UNAVAILABLE', '', 'verification');
    const nonce = randomBytes(16).toString('hex'), source = { manifest: this.context.source.manifest, ref: await artifacts.json('manifest', this.context.source.manifest, 32768), files: this.context.source.artifacts, baselineProofs: this.context.source.baselineProofs };
    const gateSlot = plan.verifierSlots[ordinal]!.handler.implementation === 'gate.v1';
    const sized = gateSlot ? null : preflightVerification(plan, lock, slotId, source, this.candidate, this.generation, nonce), phase = 'verify.' + this.generation + '.' + ordinal;
    if (sized && sized.kind === 'refused') {
      const row = await this.verifier.storeRefusal(sized.prepared); await this.events.push('verification', 'OUTPUT_LIMIT');
      await this.publish({ ...this.draft, stage: { ...this.draft.stage, kind: 'verifier_pre' }, verifierRefusals: [...this.draft.verifierRefusals, row] }, phase + '.pre');
      await this.publish({ ...this.draft, stage: { ...this.draft.stage, kind: 'verifier_post' }, nodes: this.nodeDispositions(this.draft.nodes, this.generation, { slotId, status: 'blocked' }) }, phase + '.post');
      const checked = await this.verifier.restoreRefusal(sized.prepared, row); this.refusals.set(slotId + ':' + this.generation, checked); return checked;
    }
    const job: PreparedVerification | PreparedGate = gateSlot
      ? prepareGate(plan, lock, slotId, this.candidate, this.generation, nonce, this.context.loaded.registry.spec.gateEndpoints)
      : sized!.job;
    await this.events.push('verification', null);
    await this.publish({ ...this.draft, stage: { ...this.draft.stage, kind: 'verifier_pre' }, verifierReceipts: [...this.draft.verifierReceipts, { slot: slotId, generation: this.generation, operationId: job.operationId, producerNonce: nonce, output: null, receipt: null }] }, phase + '.pre');
    this.deadline.assert(); const checked = await (gateSlot ? this.gate.run(job as PreparedGate, this.deadline.abort.signal) : this.verifier.run(job as PreparedVerification, this.deadline.abort.signal)); this.checks.set(slotId + ':' + this.generation, checked);
    let draft: Draft = { ...this.draft, stage: { ...this.draft.stage, kind: 'verifier_post' as const }, verifierReceipts: this.draft.verifierReceipts.map(item => item.slot === slotId && item.generation === this.generation ? { ...item, output: checked.output, receipt: checked.receipt } : item) };
    if (checked.status === 'failed') {
      const slot = plan.verifierSlots[ordinal]!, trusted = gateSlot ? authenticatedGate(checked) : authenticatedCheck(checked), stable = hash(canonical({ slot: slot.id, handler: slot.handler.digest, reason: checked.reason, method: trusted.evidence.spec.method, parameters: slot.handler.parameters }));
      const signature = failureSignature({ category: 'implementation', codes: [checked.reason!], handler: slot.handler.implementation, handlerVersion: 1, target: typeof slot.handler.parameters.path === 'string' ? slot.handler.parameters.path : slot.id, candidate: trusted.subject.candidateDigest, evidence: [stable] });
      draft = { ...draft, failures: rememberFailure(draft.failures, signature, this.generation, checked.output) };
    }
    draft = { ...draft, nodes: this.nodeDispositions(draft.nodes, this.generation) };
    await this.publish(draft, phase + '.post'); return checked;
  }
  nodeDispositions(input: ControllerProgress['nodes'], generation: number, pendingRefusal?: { readonly slotId: string; readonly status: 'blocked' }): ControllerProgress['nodes'] {
    const nodes = input.map(item => ({ ...item })), { plan } = this.context;
    for (const node of plan.orderedDAG) {
      const state = nodes.find(item => item.id === node.id)!;
      if (node.kind !== 'check' || state.state === 'not_run' || !node.dependsOn.every(parent => nodes.find(item => item.id === parent)?.state === 'completed')) continue;
      const slot = plan.verifierSlots.find(slot => slot.handler.id === node.handler.id), checked = slot ? this.checks.get(slot.id + ':' + generation) ?? this.refusals.get(slot.id + ':' + generation) ?? (pendingRefusal?.slotId === slot.id ? pendingRefusal : undefined) : undefined;
      if (!checked) continue; state.state = checked.status === 'passed' ? 'completed' : checked.status;
      if (checked.status !== 'passed') for (const id of descendants(plan, node.id)) { const child = nodes.find(item => item.id === id)!; if (child.state === 'pending') child.state = 'not_run'; }
    }
    return nodes;
  }
  async captureSubmission(captured: CapturedRole, repair: ControllerAttempt['repair'], originalSubmission: ArtifactRef | null): Promise<RetainedSubmission | null> {
    const { artifacts, plan } = this.context;
    if (repair === 'format') {
      if (!captured.submission || !originalSubmission) refuse('RECOVERY_REQUIRED', '', 'execution');
      const rawBytes = await artifacts.read(captured.submission, 1048576), raw = await artifacts.put('submission', rawBytes, 1048576);
      await artifacts.json('format-lineage', { version: 1, original: originalSubmission, repaired: raw, candidate: captured.digest, attemptId: this.draft.attempts.at(-1)!.id }, 65536);
      return { version: 1, origin: 'assistant', raw, value: normalizeSubmission(rawBytes, plan.task) };
    }
    return retainSubmission(captured, plan.controls.submission, plan.task, artifacts);
  }
  async completeCapture(attempt: ControllerAttempt, captured: CapturedRole): Promise<ControllerDiagnostic['code'] | null> {
    const { plan, store, artifacts } = this.context, { nodeId, repair, purpose, ordinal, id: commandId } = attempt;
    const oldDigest = this.draft.candidate.digest, originalSubmission = this.draft.submission;
    const manifest = await this.context.progress.manifest(captured.manifest), changed = !same(captured.digest, oldDigest), generation = this.generation + (changed ? 1 : 0);
      if (generation >= plan.capacity.V) refuse('ATTEMPT_LIMIT', '', 'execution');
      this.candidate = { manifest, ref: captured.manifest, files: captured.artifacts }; this.#candidateKnown = true;
      let submission = this.submission, failure: ControllerDiagnostic['code'] | null = null, failedRaw: ArtifactRef | null = null;
      try { if (purpose !== 'compaction') submission = await this.captureSubmission(captured, repair, originalSubmission); }
      catch (error) { if (error instanceof ControllerFailure && ['SUBMISSION_INVALID', 'SUBMISSION_AMBIGUOUS'].includes(error.diagnostic.code)) failure = error.diagnostic.code; else throw error; }
      if (failure) {
        submission = null; const selected = plan.controls.submission.path === null ? undefined : captured.artifacts.find(file => file.name === plan.controls.submission.path)?.bytes;
        failedRaw = repair === 'format' || selected === undefined ? captured.submission : await artifacts.put('submission', selected, 1048576);
      }
      this.submission = submission;
      const after = stateValue(store.inspect()).counts;
      let draft: Draft = { ...this.draft, stage: { ...this.draft.stage, kind: 'role_post' }, attempts: this.draft.attempts.map(item => item.id === commandId ? { ...item, finished: { after: { requests: after.requests, operations: after.operations }, outcome: captured.outcome, nativeCheckpointId: captured.checkpointId } } : item),
        nativeCheckpoints: [...this.draft.nativeCheckpoints, { attemptId: commandId, checkpointId: captured.checkpointId, outcome: captured.outcome }], submission: failure ? failedRaw : submission?.raw ?? null,
        candidate: { manifest: captured.manifest, digest: captured.digest, generation, workspace: captured.workspace, privateSession: captured.session }, nodes: this.draft.nodes.map(item => item.id === nodeId ? { ...item, state: failure ? 'failed' : 'completed' } : item) };
      if (failure) {
        const signature = failureSignature({ category: 'format', codes: [failure], handler: 'submission.v1', handlerVersion: 1, target: nodeId, candidate: captured.digest, evidence: [failedRaw?.digest ?? hash('missing_submission')] });
        draft = { ...draft, failures: rememberFailure(draft.failures, signature, generation, failedRaw) };
      }
      if (repair === 'implementation' && !changed) {
        const requiredOutputs = this.currentChecks().filter(check => check.status === 'failed' && plan.task.spec.acceptance.required.includes(check.checkId)).map(check => check.output);
        draft = { ...draft, failures: draft.failures.map(item => item.evidence && requiredOutputs.some(output => same(item.evidence, output)) ? { ...item, count: Math.min(2, item.count + 1) } : item) };
      }
      if (changed) draft = { ...draft, nodes: draft.nodes.map(item => plan.orderedDAG.find(node => node.id === item.id)!.kind === 'check' && item.state !== 'not_run' ? { ...item, state: 'pending' } : item) };
      draft = { ...draft, nodes: this.nodeDispositions(draft.nodes, generation) };
      await this.publish(draft, 'role.' + ordinal + '.post'); return failure;
  }
  async role(nodeId: string, repair: ControllerAttempt['repair'] = 'none', prompt?: string, retained?: ControllerAttempt): Promise<void> {
    await this.guard(); const { plan, lock, store, artifacts, authority, loaded, directory } = this.context;
    observeParentExhaustion(this.deadline.assert(), lock);
    const node = plan.orderedDAG.find(node => node.id === nodeId); if (!node || node.kind !== 'agent') refuse('CAPABILITY_UNSUPPORTED', '', 'execution');
    if (!retained && this.draft.attempts.length >= plan.capacity.A) refuse('ATTEMPT_LIMIT', '', 'execution');
    const originalRole = plan.roles.find(role => role.roleId === node.roleId)!;
    const role: PlannedRole = repair === 'format' ? { ...originalRole, policy: formatPolicy(originalRole.policy) } : originalRole;
    const purpose = node.handler.implementation === 'pi.compact.v1' ? 'compaction' : node.handler.parameters.purpose === 'review' ? 'reviewer' : 'task';
    const nativeStepId = purpose === 'compaction' ? compactionTarget(plan, nodeId) : nodeId, ordinal = retained?.ordinal ?? this.draft.attempts.length + 1;
    const commandId = stableId(lock.spec.runId, nodeId, purpose, repair, ordinal), sessionId = nativeSessionId(lock.spec.runId, role.roleId, nativeStepId, role.policy);
    const configured = purpose === 'compaction' ? '' : text(loaded.registry.spec.handlers.find(handler => handler.id === node.handler.id)?.parameters.prompt);
    if (purpose !== 'compaction' && node.handler.parameters.prompt !== '[private command sha256:' + hash(configured).hex + ']') refuse('RECOVERY_REQUIRED', '', 'execution');
    const commandText = retained ? new TextDecoder('utf-8', { fatal: true }).decode(await artifacts.read(retained.command, 16384)) : prompt ?? configured;
    const command = await artifacts.put('command', Buffer.from(commandText), Math.min(16384, role.policy.limits.promptBytes));
    const originalSubmission = this.draft.submission, before = journal(store).view.counts, oldDigest = this.draft.candidate.digest;
    const originalState = await schedulingSnapshot(store, authority, lock, artifacts, this.candidate, this.draft.candidate);
    observeParentExhaustion(this.deadline.assert(), lock);
    const attempt: ControllerAttempt = retained ?? { ordinal, id: commandId, nodeId, nativeStepId, sessionId, purpose, repair, command, before: { requests: before.requests, operations: before.operations }, finished: null };
    if (retained) {
      if (!same(retained, { ...attempt, command, id: commandId, sessionId, nativeStepId, nodeId, purpose, repair }) || !same(this.draft.attempts.at(-1), retained) || retained.finished !== null) refuse('RECOVERY_REQUIRED', '', 'recovery');
    } else {
    if (repair === 'format') await artifacts.json('format-intent', { version: 1, attemptId: commandId, original: originalSubmission, schema: 'submission.v1', candidate: oldDigest, output: 'new_assistant_representation' }, 65536);
    await this.events.push(repair === 'none' ? 'role' : 'repair', null, nodeId, commandId);
    await this.publish({ ...this.draft, stage: { ...this.draft.stage, kind: 'role_pre' }, attempts: [...this.draft.attempts, attempt], nodes: this.draft.nodes.map(item => item.id === nodeId ? { ...item, state: 'running' } : item) }, 'role.' + ordinal + '.pre');
    }
    let restore: PiOpenInputV2['restore'] = null, nativeManifest = this.candidate.manifest;
    if (purpose === 'compaction' || repair === 'implementation') {
      const prior = this.draft.attempts.slice(0, -1).filter(item => item.nativeStepId === nativeStepId && item.sessionId === sessionId && item.finished?.nativeCheckpointId).at(-1);
      if (prior) {
        const wrapper = parsePrivateJson(await artifacts.read(prior.finished!.outcome, 1048576), 1048576) as Record<string, unknown>;
        const checkpoint = stateValue(store.getCheckpoint(prior.finished!.nativeCheckpointId!));
        if (same(checkpoint.subject.candidateDigest, this.draft.candidate.digest)) {
          const identified = identifyManifest(parsePrivateJson(await artifacts.read(checkedRef(wrapper.originalManifest), 32768), 32768)); if (!identified.ok) refuse('RECOVERY_REQUIRED', '', 'recovery'); nativeManifest = identified.value.manifest;
          restore = { checkpointId: checkpoint.checkpointId, workspace: { ref: checkpoint.workspace, bytes: await artifacts.read(checkpoint.workspace) }, session: { ref: checkpoint.privateSession!, bytes: await artifacts.read(checkpoint.privateSession!, 2097152) } };
        }
      }
      if (purpose === 'compaction' && restore === null) refuse('CAPABILITY_UNSUPPORTED', '', 'execution');
    }
    const hostDirectory = join(directory, 'runtime', commandId); await privateDirectory(hostDirectory);
    let baseline: PiOpenInputV2['candidate']['baseline'];
    if (this.context.source.version === 2) {
      const baselineDirectory = join(hostDirectory, 'baseline');
      await materializeBaseline(this.context.source, baselineDirectory, this.context.owner, this.deadline);
      baseline = { directory: baselineDirectory, entries: this.context.source.baselineEntries ?? [] };
    }
    const host: PiHostV2 = { store, authority, directory: hostDirectory, artifactsDirectory: artifacts.directory, dockerExecutable: role.runtime.dockerExecutable, dockerSocket: role.runtime.dockerSocket, runtime: role.runtime.identity,
      ...approvedState(loaded).vault.bind({ runId: lock.spec.runId, roleId: role.roleId, stepId: nativeStepId, providerCredentialRef: role.providerCredentialRef, selection: role.policy.selection, mcp: role.policy.mcp }) };
    const input: PiOpenInputV2 = { version: 2, lock, roleId: role.roleId, stepId: nativeStepId, sessionId, policy: role.policy, candidate: { manifest: nativeManifest, baseRevision: plan.task.spec.target.baseRevision, sourceRevision: plan.task.spec.target.sourceRevision, artifacts: this.candidate.files, ...(baseline ? { baseline } : {}) }, resources: approvedState(loaded).resources, restore };
    const release = await this.context.owner.holdLocalActivity(); let noEffectMcpAuth = false;
let cleanupKnown = false, reader: Promise<void> | null = null, nativeOutcome: ArtifactRef | null = null; let structureFailure: ControllerDiagnostic['code'] | null;
    let noEffectBudget = false;
    const closeLocal = async (): Promise<void> => {
      this.deadline.onStop(null);
      if (this.#activeAdapter) { const active = this.#activeAdapter; this.#activeAdapter = null; const closed = await active.close(); cleanupKnown = closed.ok; if (!closed.ok) this.#cleanup = 'failed'; }
      if (reader) { const draining = reader; reader = null; try { await draining; } catch { cleanupKnown = false; this.#cleanup = 'failed'; this.deadline.stop('OUTPUT_LIMIT'); } }
    };
    try {
      this.deadline.assert(); const opened = await (this.context.ports.openAdapter ?? openPiAdapterV2)(host, input);
      if (!opened.ok) { cleanupKnown = opened.error.code !== 'CLEANUP_FAILED'; noEffectBudget = isNoEffectBudgetRefusal(opened.error); if (opened.error.effect !== 'none' || !cleanupKnown) this.#candidateKnown = false; refuse(opened.error.code === 'MCP_AUTHENTICATION_REQUIRED' ? 'MCP_AUTHENTICATION_REQUIRED' : 'CAPABILITY_UNSUPPORTED', '', 'execution', { piCode: opened.error.code, stateCode: opened.error.stateErrorCode, effect: opened.error.effect }); }
      const adapter = opened.value; this.#activeAdapter = adapter;
      this.deadline.onStop(async reason => { const stopped = await adapter.cancel({ reason: reason === 'DEADLINE' ? 'deadline' : reason === 'CANCELLED' ? 'operator' : 'consumer_disconnected' }); if (!stopped.ok || stopped.value.localCleanup !== 'complete') refuse('CLEANUP_FAILED', '', 'finalization'); });
      reader = (async () => { for await (const event of adapter.events()) { await this.events.push('role', null, nodeId, commandId); if (event.kind === 'request_uncertain') this.deadline.stop('AUTHORITY_REFUSED'); } })().catch(() => { this.deadline.stop('OUTPUT_LIMIT'); });
      // Opening/management is bounded, then the original work cutoff is checked again before the only command call.
      this.deadline.assert(); this.#candidateKnown = false;
      const executed = purpose === 'compaction' ? await adapter.compact({ commandId }) : await adapter.execute({ commandId, text: commandText, purpose, repair });
      if (!executed.ok) { noEffectBudget = isNoEffectBudgetRefusal(executed.error);
        if (executed.error.code === 'MCP_AUTHENTICATION_REQUIRED' && executed.error.effect === 'none') noEffectMcpAuth = true;
        refuse('RECOVERY_REQUIRED', '', 'execution', { piCode: executed.error.code, stateCode: executed.error.stateErrorCode, effect: executed.error.effect }); }
      const outcome: PiOutcomeV2 = executed.value; nativeOutcome = await artifacts.json('native-outcome', { version: 1, attemptId: commandId, outcome }, 65536);
      noEffectBudget = outcome.error !== null && isNoEffectBudgetRefusal(outcome.error) && outcome.requestIds.length === 0 && outcome.operationIds.length === 0
        && outcome.providerTermination === 'none' && outcome.usage === 'none' && outcome.localCleanup === 'complete' && outcome.cleanupError === null;
      noEffectMcpAuth = outcome.error?.code === 'MCP_AUTHENTICATION_REQUIRED' && outcome.error?.effect === 'none' && outcome.requestIds.length === 0 && outcome.operationIds.length === 0
        && outcome.providerTermination === 'none' && outcome.usage === 'none' && outcome.localCleanup === 'complete' && outcome.cleanupError === null;
      if (outcome.status === 'blocked' && outcome.error?.code === 'MCP_AUTHENTICATION_REQUIRED' && outcome.providerTermination === 'confirmed' && outcome.usage === 'complete' && outcome.localCleanup === 'complete' && outcome.cleanupError === null) {
        this.deadline.assert(); const captured = await captureRole(adapter, store, artifacts, lock, role, attempt, outcome, this.context.source); structureFailure = await this.completeCapture(attempt, captured); refuse('MCP_AUTHENTICATION_REQUIRED', '', 'execution', { piCode: 'MCP_AUTHENTICATION_REQUIRED', effect: outcome.error.effect }); }
      if (outcome.status !== 'execution_settled' || outcome.providerTermination !== 'confirmed' || outcome.usage !== 'complete') refuse('RECOVERY_REQUIRED', '', 'execution', { piCode: outcome.error?.code ?? null, effect: outcome.error?.effect ?? 'possible' });
      this.deadline.assert(); const captured = await captureRole(adapter, store, artifacts, lock, role, attempt, outcome, this.context.source);
      if ((repair === 'format' || purpose === 'compaction') && !same(captured.digest, oldDigest)) refuse('CAPABILITY_UNSUPPORTED', '', 'execution', { effect: 'confirmed' });
      structureFailure = await this.completeCapture(attempt, captured);
    } catch (error) {
      let failure = error;
      if (noEffectBudget || noEffectMcpAuth) {
        this.#candidateKnown = false;
        await closeLocal();
        if (cleanupKnown && this.deadline.reason === null) {
          const afterState = await schedulingSnapshot(store, authority, lock, artifacts, this.candidate, this.draft.candidate);
          if (same(originalState, afterState)) { this.#candidateKnown = true; failure = new ControllerFailure({ ...safeDiagnostic(failure, 'execution'), code: noEffectMcpAuth ? 'MCP_AUTHENTICATION_REQUIRED' : 'BUDGET_EXHAUSTED', stateCode: noEffectMcpAuth ? null : 'BUDGET_EXHAUSTED', piCode: noEffectMcpAuth ? 'MCP_AUTHENTICATION_REQUIRED' : null, effect: 'none' }); }
          else this.#candidateKnown = false;
        } else this.#candidateKnown = false;
      }
      if (this.head?.progress.attempts.at(-1)?.id === commandId && this.head.progress.attempts.at(-1)!.finished === null) {
        const diagnostic = safeDiagnostic(failure, 'execution'), after = stateValue(store.inspect()).counts;
        const outcome = await artifacts.json('role-refusal', { version: 1, attemptId: commandId, command, diagnostic, nativeOutcome, currentCandidate: this.#candidateKnown ? this.draft.candidate.manifest : null, unavailable: this.#candidateKnown ? [] : ['current_candidate', 'submission'], localCleanup: cleanupKnown ? 'complete' : 'pending' }, 65536);
        await this.publish({ ...this.draft, stage: { ...this.draft.stage, kind: 'role_post' }, attempts: this.draft.attempts.map(item => item.id === commandId ? { ...item, finished: { after: { requests: after.requests, operations: after.operations }, outcome, nativeCheckpointId: null } } : item), nodes: this.draft.nodes.map(item => item.id === nodeId ? { ...item, state: 'failed' } : descendants(plan, nodeId).includes(item.id) && item.state === 'pending' ? { ...item, state: 'not_run' } : item) }, 'role.' + ordinal + '.post');
      }
      throw failure;
    } finally {
      await closeLocal();
      if (cleanupKnown) release(); else if (this.#cleanup === 'complete') this.#cleanup = 'pending';
    }
    if (structureFailure === 'SUBMISSION_AMBIGUOUS') refuse(structureFailure, '', 'verification');
    if (structureFailure === 'SUBMISSION_INVALID') await this.repairFormat(nodeId);
  }
  async resumeAttempt(adopt: boolean): Promise<void> {
    const attempt = this.draft.attempts.at(-1); if (!attempt || attempt.finished !== null) return;
    if (!adopt) { await this.role(attempt.nodeId, attempt.repair, undefined, attempt); return; }
    const original = this.context.plan.roles.find(role => role.roleId === this.context.plan.orderedDAG.find(node => node.id === attempt.nodeId)!.roleId)!;
    const role = attempt.repair === 'format' ? { ...original, policy: formatPolicy(original.policy) } : original;
    const captured = await adoptRoleCapture(this.context.store, this.context.artifacts, this.context.lock, role, attempt, undefined, this.context.source);
    const failure = await this.completeCapture(attempt, captured);
    if (failure === 'SUBMISSION_AMBIGUOUS') refuse(failure, '', 'verification');
    if (failure === 'SUBMISSION_INVALID') await this.repairFormat(attempt.nodeId);
  }
  repairBound(kind: 'format' | 'implementation', actionable: boolean, repeats?: number): void {
    const view = this.deadline.assert(), { plan } = this.context;
    const latest = this.draft.failures.at(-1), refusal = repairDisposition(kind, { attempts: this.draft.attempts.length, maxAttempts: plan.capacity.A,
      formatRepairs: view.ledger.formatRepairs, implementationRepairs: view.ledger.implementationRepairs, maxFormatRepairs: plan.budgets.maxFormatRepairs, maxImplementationRepairs: plan.budgets.maxImplementationRepairs,
      repeats: repeats ?? latest?.count ?? 0, actionable, uncertain: view.clockStatus !== 'trusted' || Boolean(view.counts.dispatchedRequests || view.counts.unresolvedRequests || view.counts.unresolvedOperations || view.ledger.violations.length) });
    if (refusal) refuse(refusal, '', 'execution');
  }
  async repairFormat(nodeId: string): Promise<void> {
    const raw = this.draft.submission; this.repairBound('format', raw !== null);
    if (!raw) refuse('EVIDENCE_UNAVAILABLE', '', 'verification');
    const prompt = formatPrompt(await this.context.artifacts.read(raw, 1048576)); await this.role(nodeId, 'format', prompt);
  }
  currentChecks(): readonly VerifiedCheck[] { return [...this.checks.values()].filter(check => check.generation === this.generation); }
  currentRefusals(): readonly PreflightRefusal[] { return [...this.refusals.values()].filter(item => item.generation === this.generation); }
  async verifyEligible(): Promise<void> {
    for (const slot of this.context.plan.verifierSlots) {
      const nodes = this.context.plan.orderedDAG.filter(node => node.kind === 'check' && node.handler.id === slot.handler.id);
      if (nodes.some(node => this.draft.nodes.find(item => item.id === node.id)?.state !== 'completed')) continue;
      await this.runVerifier(slot.id);
    }
  }
  async graph(): Promise<void> {
    const { plan } = this.context;
    for (;;) {
      const node = nextNode(plan, this.draft.nodes); if (!node) break;
      if (node.kind === 'agent') await this.role(node.id);
      else {
        const slot = plan.verifierSlots.find(slot => slot.handler.id === node.handler.id); if (!slot) refuse('CAPABILITY_UNSUPPORTED', '', 'verification');
        const checked = await this.runVerifier(slot.id), state = checked.status === 'passed' ? 'completed' : checked.status;
        // Node disposition is part of the same predefined post-job boundary, never an extra checkpoint.
        if (this.draft.nodes.find(item => item.id === node.id)!.state !== state) refuse('RECOVERY_REQUIRED', '', 'execution');
      }
    }
    await this.verifyEligible();
  }
  async implementationRepair(): Promise<boolean> {
    const { plan } = this.context; if (plan.budgets.maxImplementationRepairs === 0) return false;
    const checks = this.currentChecks(), required = plan.verifierSlots.filter(slot => slot.implicit === null && plan.task.spec.acceptance.required.includes(slot.checkId));
    const failed = checks.filter(check => check.status === 'failed' && required.some(slot => slot.id === check.slotId));
    if (!failed.length || this.submission?.value.status === 'no_change' && !plan.noChangeEligibility.available) return false;
    const allAvailable = required.every(slot => checks.some(check => check.slotId === slot.id && check.status !== 'blocked'));
    if (!allAvailable || checks.some(check => plan.verifierSlots.find(slot => slot.id === check.slotId)!.implicit === 'scope' && check.status !== 'passed')) return false;
    const prior = this.draft.attempts.filter(attempt => attempt.purpose === 'task' && attempt.repair !== 'format' && attempt.finished?.nativeCheckpointId && plan.roles.find(role => role.roleId === plan.orderedDAG.find(node => node.id === attempt.nodeId)!.roleId)!.policy.tools.some(tool => tool === 'write' || tool === 'edit' || tool === 'delete')).at(-1);
    const target = prior?.nodeId, node = plan.orderedDAG.find(node => node.id === target), role = plan.roles.find(role => role.roleId === node?.roleId);
    if (!node || !role?.policy.tools.some(tool => tool === 'write' || tool === 'edit' || tool === 'delete')) return false;
    this.repairBound('implementation', true, Math.max(0, ...this.draft.failures.filter(item => failed.some(check => same(check.output, item.evidence))).map(item => item.count)));
    const candidateDigest = this.draft.candidate.digest;
    const findings: {
      checkId: string;
      handler: typeof plan.verifierSlots[number]['handler']['implementation'];
      code: string | null;
      detail?: string;
      parameters: typeof plan.verifierSlots[number]['handler']['parameters'];
      candidate: typeof candidateDigest;
    }[] = failed.map(check => {
      const slot = plan.verifierSlots.find(slot => slot.id === check.slotId)!;
      let detail: string | undefined;
      if (slot.handler.implementation === 'gate.v1') {
        const trusted = authenticatedGate(check);
        try {
          const parsed = parsePrivateJson(Buffer.from(trusted.outputBytes), 65536);
          const verdict = isRecord(parsed) && isRecord(parsed.verdict) ? parsed.verdict : null;
          if (verdict && typeof verdict.reason === 'string' && verdict.reason.length > 0) {
            detail = Array.from(verdict.reason).slice(0, 256).join('');
          }
        } catch {
          // Malformed gate payload must not crash failure repair; fall back to default detail.
        }
      }
      return {
        checkId: check.checkId,
        handler: slot.handler.implementation,
        code: check.reason,
        ...(detail !== undefined ? { detail } : {}),
        parameters: slot.handler.parameters,
        candidate: candidateDigest,
      };
    });
    const maxPromptBytes = Math.min(16384, role.policy.limits.promptBytes);
    const prefix = 'Repair only the admitted writable candidate to satisfy these authenticated current-candidate findings. Return the complete structured submission; evidence claims will be independently checked. Findings:\n';
    let prompt = prefix + canonical(findings);
    if (Buffer.byteLength(prompt, 'utf8') > maxPromptBytes) {
      for (let index = findings.length - 1; index >= 0 && Buffer.byteLength(prompt, 'utf8') > maxPromptBytes; index--) {
        if (findings[index]!.detail !== undefined) {
          delete findings[index]!.detail;
          prompt = prefix + canonical(findings);
        }
      }
      while (findings.length > 1 && Buffer.byteLength(prompt, 'utf8') > maxPromptBytes) {
        findings.pop();
        prompt = prefix + canonical(findings);
      }
    }
    await this.role(target!, 'implementation', prompt); return true;
  }
  async execute(): Promise<AcceptanceObservation> {
    if (!this.head) await this.bootstrap();
    else {
      if (this.head.progress.attempts.at(-1)?.finished === null) await this.resumeAttempt(this.resumeAdoption === true);
      const retained = [...this.head.progress.verifierReceipts, ...this.head.progress.verifierRefusals].filter(row => row.generation === this.generation);
      for (const row of retained) await this.runVerifier(row.slot);
      const attempt = this.draft.attempts.at(-1);
      if (attempt?.finished?.nativeCheckpointId === null) {
        const refusal = record(parsePrivateJson(await this.context.artifacts.read(attempt.finished.outcome, 65536), 65536), ['version', 'attemptId', 'command', 'diagnostic', 'nativeOutcome', 'currentCandidate', 'unavailable', 'localCleanup']);
        if (!same(refusal.currentCandidate, this.draft.candidate.manifest) || refusal.localCleanup !== 'complete') refuse('RECOVERY_REQUIRED', '', 'recovery');
        const diagnostic = refusal.diagnostic as unknown as ControllerDiagnostic;
        if (['BUDGET_EXHAUSTED', 'CAPABILITY_UNSUPPORTED', 'MCP_AUTHENTICATION_REQUIRED'].includes(diagnostic.code) && diagnostic.effect === 'none') refuse(diagnostic.code, '', 'execution');
        refuse('RECOVERY_REQUIRED', '', 'recovery');
      }
      if (attempt?.finished?.nativeCheckpointId && this.submission === null && attempt.purpose !== 'compaction' && this.draft.nodes.find(node => node.id === attempt.nodeId)?.state === 'failed') await this.repairFormat(attempt.nodeId);
    }
    await this.graph();
    for (;;) {
      if (!this.submission) {
        // Check-only graphs have no model submission. This is an explicitly trusted requested completed evaluation,
        // with zero submitted claims; every pass still requires independently dispatched eligible evidence.
        if (this.context.plan.orderedDAG.some(node => node.kind === 'agent')) refuse('EVIDENCE_UNAVAILABLE', '', 'verification');
        const value: Submission = { version: 1, status: 'completed', checks: [], reason: null }, raw = await this.context.artifacts.json('submission', value, 1048576);
        this.submission = { version: 1, origin: 'controller', raw, value };
      }
      const acceptance = evaluateControllerAcceptance(this.context.plan, this.context.lock, this.candidate.manifest, this.candidate.files, this.generation, this.currentChecks(), this.submission.value, this.context.store, null, this.draft.nodes.every(node => node.state === 'completed'), this.currentRefusals());
      if (acceptance.result.spec.status === 'failed' && await this.implementationRepair()) { await this.graph(); continue; }
      return acceptance.result.spec.status === 'completed' ? await this.publishBoundary(acceptance) : acceptance;
    }
  }
  async publishBoundary(acceptance: AcceptanceObservation): Promise<AcceptanceObservation> {
    const { plan, lock, store, loaded } = this.context, publication = plan.publication;
    if (publication.mode !== 'pull_request' || ['confirmed', 'failed', 'unresolved'].includes(this.draft.publication.status)) return acceptance;
    const view = stateValue(store.inspect()), endpoint = loaded.registry.spec.publicationEndpoints.find(item => item.id === publication.endpointRef);
    if (!endpoint) refuse('CONFIG_REFERENCE', '/spec/publication', 'execution');
    const subject = (() => { const bound = bindSubject(lock, this.candidate.manifest); if (!bound.ok) refuse('ARTIFACT_INVALID', '', 'execution'); return bound.value; })();
    const scope = acceptance.verifierMatrix.find(row => row.implicit === 'scope');
    const head = headRevision(this.context.descriptor.repository);
    if (![plan.task.spec.target.baseRevision, plan.task.spec.target.sourceRevision].includes(head)) refuse('TARGET_MISMATCH', '', 'execution');
    if (this.draft.publication.status !== 'pending') {
      const eligible = this.draft.nodes.every(node => node.state === 'completed') && scope?.status === 'passed'
        && view.clockStatus === 'trusted' && !view.counts.dispatchedRequests && !view.counts.unresolvedRequests && !view.counts.unresolvedOperations && !view.ledger.violations.length
        && this.submission !== null && this.submission.value.status === 'completed'
        && same(this.draft.candidate.digest, subject.candidateDigest);
      if (!eligible) { this.#publicationObservation = { status: 'not_run', reason: 'ineligible', receipt: null }; return acceptance; }
    }
    const prepared: PreparedPublication = preparePublication(plan, lock, view.storeId, endpoint, subject);
    const operation = store.getOperation(prepared.operationId);
    await this.events.push('publication', null);
    if (!this.head?.progress.stage.consumed.includes('publication.pre')) await this.publish({ ...this.draft, stage: { ...this.draft.stage, kind: 'publication_pre' }, publication: { status: 'pending', operationId: prepared.operationId, receipt: null } }, 'publication.pre');
    this.deadline.assert();
    const result = !operation.ok && operation.error.code === 'RECORD_NOT_FOUND'
      ? await this.publisher.run(prepared, endpoint, this.deadline.abort.signal)
      : await this.publisher.restore(prepared, endpoint);
    if (result.kind === 'settled') {
      this.#publicationObservation = result.outcome === 'succeeded'
        ? { status: 'confirmed', reason: null, receipt: result.receiptRef }
        : { status: 'failed', reason: 'not_executed', receipt: result.receiptRef };
      await this.publish({ ...this.draft, stage: { ...this.draft.stage, kind: 'publication_post' }, publication: { status: result.outcome === 'succeeded' ? 'confirmed' : 'failed', operationId: prepared.operationId, receipt: result.receiptRef } }, 'publication.post');
    } else {
      this.#publicationObservation = { status: 'unresolved', reason: result.reason, receipt: null };
      await this.publish({ ...this.draft, stage: { ...this.draft.stage, kind: 'publication_post' }, publication: { status: 'unresolved', operationId: prepared.operationId, receipt: null } }, 'publication.post');
    }
    return evaluateControllerAcceptance(plan, lock, this.candidate.manifest, this.candidate.files, this.generation, this.currentChecks(), this.submission!.value, store, null, this.draft.nodes.every(node => node.state === 'completed'), this.currentRefusals());
  }
  async terminal(primary: AcceptanceObservation | ControllerIncident): Promise<CycleExecution> {
    const { store, artifacts, lock } = this.context, secondary: ControllerDiagnostic['code'][] = [];
    const accepted = 'result' in primary, status = accepted ? primary.result.spec.status : primary.code;
    let observations: ArtifactRef | null = null, primaryRef: ArtifactRef | null = null, admitted = false;
    const current = stateValue(store.inspect()), finalizer = new Finalizer(artifacts, current.clock.remainingTaskMs.safeValue ?? 0);
    const checkpoint = async (kind: 'terminal_intent' | 'terminal_result' | 'terminal_observations', phase: string): Promise<void> => {
      // Worst-case logical progress, receipt index and checkpoint framing; no extra allowance is granted.
      finalizer.reserve(65536 + 65536 + 40960);
      const stopped = accepted && ['exhausted', 'expired', 'cancelled'].includes(primary.result.spec.status);
      await this.publish({ ...this.draft, stage: { ...this.draft.stage, kind }, nodes: this.draft.nodes.map(node => stopped && node.state === 'pending' ? { ...node, state: 'not_run' } : node), terminalIntent: { primary: status, result: primaryRef, observations } }, phase); finalizer.check();
    };
    try {
      primaryRef = await finalizer.put(accepted ? 'result' : 'incident', accepted ? primary.result : primary);
      await checkpoint('terminal_intent', 'terminal.intent'); admitted = true;
      await this.events.push('terminal', accepted ? null : primary.code);
      await checkpoint('terminal_result', 'terminal.result');
      // Event bytes were already synced during work. Sealing is no-overwrite metadata, not a final body rewrite.
      const eventsRef = await this.events.close(); finalizer.check();
      observations = await finalizer.put('observations', { version: 1, primary: primaryRef, requestedStatus: accepted ? primary.requestedStatus : null, diagnostic: accepted ? primary.diagnostic : primary.code,
        requestedStatusSource: this.submission === null ? 'unavailable' : this.submission.origin === 'controller' ? 'controller_check_only' : 'captured_submission', selectedNoChangeCheck: accepted ? primary.selectedNoChangeCheck : this.context.plan.noChangeEligibility.checkId, contradictions: accepted ? primary.contradictions : [], verifierMatrix: accepted ? primary.verifierMatrix : null,
        verification: accepted ? primary.verification : null, preflightRefusals: accepted ? primary.preflightRefusals : null, events: eventsRef, cleanup: this.#cleanup, memory: { status: 'not_requested', reason: null }, publication: this.#publicationObservation });
      await checkpoint('terminal_observations', 'terminal.observations');
    } catch (error) { secondary.push(safeDiagnostic(error, 'finalization').code); }
    finally { try { await this.events.close(); } catch { secondary.push('CLEANUP_FAILED'); this.#cleanup = 'pending'; } }
    if (!admitted) return freeze({ kind: 'incident', version: 1, incident: incident({ version: 1, code: 'RECOVERY_REQUIRED', phase: 'finalization', path: '', stateCode: null, piCode: null, effect: 'possible', retryable: false }, lock.spec.runId, lock.spec.lockHash, [this.context.descriptor.plan, this.context.source.inventory, ...(primaryRef ? [primaryRef] : [])], ['terminal_admission'], this.#cleanup) });
    if (accepted) return freeze({ kind: 'result', version: 1, runId: lock.spec.runId, result: primary.result, observations, secondary });
    return freeze({ kind: 'incident', version: 1, incident: primary });
  }
  async finish(): Promise<CycleExecution> {
    let primary: AcceptanceObservation | ControllerIncident;
    try { primary = await this.execute(); }
    catch (error) {
      const diagnostic = safeDiagnostic(error, 'execution');
      const facts = this.context.store.inspect();
      const certain = facts.ok && facts.value.clockStatus === 'trusted' && !facts.value.counts.dispatchedRequests && !facts.value.counts.unresolvedRequests && !facts.value.counts.unresolvedOperations && !facts.value.ledger.violations.length;
      if (this.#candidateKnown && facts.ok && (['DEADLINE', 'CANCELLED', 'BUDGET_EXHAUSTED', 'ATTEMPT_LIMIT', 'REPEAT_FAILURE'].includes(diagnostic.code) || (certain && ['CAPABILITY_UNSUPPORTED', 'MCP_AUTHENTICATION_REQUIRED', 'EVIDENCE_UNAVAILABLE', 'SUBMISSION_AMBIGUOUS', 'SUBMISSION_INVALID'].includes(diagnostic.code)))) {
        const forced = diagnostic.code === 'DEADLINE' ? 'expired' : diagnostic.code === 'CANCELLED' ? 'cancelled' : ['SUBMISSION_AMBIGUOUS', 'SUBMISSION_INVALID'].includes(diagnostic.code) ? 'failed' : ['CAPABILITY_UNSUPPORTED', 'MCP_AUTHENTICATION_REQUIRED', 'EVIDENCE_UNAVAILABLE'].includes(diagnostic.code) ? 'blocked' : 'exhausted';
        const forcedDiagnostic = ['CAPABILITY_UNSUPPORTED', 'MCP_AUTHENTICATION_REQUIRED', 'EVIDENCE_UNAVAILABLE', 'SUBMISSION_AMBIGUOUS', 'SUBMISSION_INVALID'].includes(diagnostic.code) ? diagnostic.code : null;
        try { primary = evaluateControllerAcceptance(this.context.plan, this.context.lock, this.candidate.manifest, this.candidate.files, this.generation, this.currentChecks(), this.submission?.value ?? null, this.context.store, forced, this.draft.nodes.every(node => node.state === 'completed'), this.currentRefusals(), forcedDiagnostic); }
        catch { primary = incident(diagnostic, this.context.lock.spec.runId, this.context.lock.spec.lockHash, [this.context.descriptor.plan, this.context.source.inventory], ['authoritative_result'], this.#cleanup); }
      } else primary = incident(diagnostic, this.context.lock.spec.runId, this.context.lock.spec.lockHash, [this.context.descriptor.plan, this.context.source.inventory], this.#candidateKnown ? ['authoritative_result'] : ['current_candidate', 'submission', 'authoritative_result'], this.#cleanup);
    }
    try { await this.deadline.dispose(); } catch { this.#cleanup = 'failed'; }
    if (this.#cleanup !== 'complete' && 'result' in primary) primary = incident({ version: 1, code: 'CLEANUP_FAILED', phase: 'finalization', path: '', stateCode: null, piCode: null, effect: 'possible', retryable: false }, this.context.lock.spec.runId, this.context.lock.spec.lockHash, [this.context.descriptor.plan, this.context.source.inventory], ['local_cleanup'], this.#cleanup);
    return this.terminal(primary);
  }
}
export async function executeCycleContext(context: CycleContext, restored?: { readonly head: ProgressHead | null; readonly candidate: ByteInventory; readonly submission: RetainedSubmission | null; readonly adopt: boolean }): Promise<CycleExecution> {
  let execution: CycleExecution;
  try {
    const cycle = new Cycle(context, restored?.head, restored?.candidate, restored?.adopt);
    cycle.submission = restored?.submission ?? null;
    execution = await cycle.finish();
  }
  catch (error) { execution = { kind: 'incident', version: 1, incident: incident(safeDiagnostic(error, 'execution'), context.lock.spec.runId, context.lock.spec.lockHash, [context.descriptor.plan, context.source.inventory], ['authoritative_result'], 'pending') }; }
  let cleanup: boolean;
  try { const released = context.store.release(context.authority); const closed = context.store.close(); cleanup = released.ok && closed.ok; if (cleanup) await context.owner.release(); } catch { cleanup = false; }
  if (!cleanup) return { kind: 'incident', version: 1, incident: incident({ version: 1, code: 'CLEANUP_FAILED', phase: 'finalization', path: '', stateCode: null, piCode: null, effect: 'possible', retryable: false }, context.lock.spec.runId, context.lock.spec.lockHash, [context.descriptor.plan, context.source.inventory], ['owner_release', 'authoritative_cleanup'], 'pending') };
  return execution;
}
export function runCycle(input: RunCycleInput) { return runCycleWithPorts(input); }
export function runCycleWithPorts(input: RunCycleInput, ports: ControllerPorts = {}) {
  return result(async () => {
    const fields = Object.keys(input); record(input, fields);
    if (fields.some(key => !['configuration', 'repository', 'runRoot', 'runId', 'signal', 'onEvent'].includes(key))) refuse('CONFIG_SCHEMA', '', 'admission');
    if (input.onEvent !== undefined && typeof input.onEvent !== 'function' || input.signal !== undefined && !(input.signal instanceof AbortSignal)) refuse('CONFIG_SCHEMA', '', 'admission');
    if (input.signal?.aborted) refuse('CANCELLED', '', 'admission');
    const context = await createCycle(input, ports); return executeCycleContext(context);
  }, 'admission');
}
