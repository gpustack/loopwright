import { join, resolve } from 'node:path';
import { decodePiCapture } from '@loopwright/agent-pi';
import { admitTask, validateDocument } from '@loopwright/core';
import { reopenLocalRun, type Authority, type LocalRunStore } from '@loopwright/state';
import { approvedState } from './config.js';
import { compilePlan } from './compile.js';
import { ControllerFailure, refuse, result } from './errors.js';
import { ControllerOwner, bootIdentity } from './ownership.js';
import { readRetained } from './retained.js';
import { ArtifactStore, stateValue } from './storage.js';
import { restoreSource } from './source.js';
import { ProgressStore, journal, type ProgressHead } from './progress.js';
import { ControllerEvents } from './events.js';
import { Finalizer } from './finalize.js';
import { formatPolicy } from './repair.js';
import { parsePrivateJson } from './parser.js';
import { normalizeSubmission, type RetainedSubmission } from './submission.js';
import { freeze, hash, record, same } from './schema.js';
import { Verifier, prepareVerification, type ByteInventory } from './verification.js';
import { Gate, prepareGate } from './gate.js';
import { Publication, preparePublication } from './publication.js';
import { executeCycleContext, type CycleContext, type ControllerPorts, type RunCycleInput } from './controller.js';
import type { CycleExecution, ControllerIncident } from './finalize.js';

async function restoredCandidate(context: CycleContext, head: ProgressHead | null): Promise<ByteInventory> {
  if (!head || head.progress.candidate.privateSession === null) {
    if (head && (!same(head.manifest, context.source.manifest) || !same(head.progress.candidate.workspace, context.source.workspace))) refuse('RECOVERY_REQUIRED', '', 'recovery');
    return { manifest: context.source.manifest, ref: head?.progress.candidate.manifest ?? await context.artifacts.json('manifest', context.source.manifest, 32768), files: context.source.artifacts };
  }
  const attempt = [...head.progress.attempts].reverse().find(item => item.finished?.nativeCheckpointId && same(journal(context.store).checkpoints.find(cp => cp.checkpointId === item.finished!.nativeCheckpointId)?.workspace, head.progress.candidate.workspace));
  if (!attempt) refuse('RECOVERY_REQUIRED', '', 'recovery');
  const checkpoint = stateValue(context.store.getCheckpoint(attempt.finished!.nativeCheckpointId!)), originalRole = context.plan.roles.find(role => role.roleId === context.plan.orderedDAG.find(node => node.id === attempt.nodeId)!.roleId)!;
  const policy = attempt.repair === 'format' ? formatPolicy(originalRole.policy) : originalRole.policy;
  const interval = journal(context.store).requests.filter(row => row.sequence > attempt.before.requests && row.sequence <= attempt.finished!.after.requests);
  const decoded = await decodePiCapture({ version: 1, lock: context.lock, policy, checkpoint, sessionId: attempt.sessionId, roleId: originalRole.roleId, stepId: attempt.nativeStepId,
    workspace: { ref: checkpoint.workspace, bytes: await context.artifacts.read(checkpoint.workspace) }, session: { ref: checkpoint.privateSession!, bytes: await context.artifacts.read(checkpoint.privateSession!, 2097152) },
    command: attempt.purpose === 'compaction' ? null : { textDigest: hash(await context.artifacts.read(attempt.command, 16384)), requestIds: interval.map(row => row.admission.requestId) } });
  if (!decoded.ok || !same({ ...decoded.value.candidate, metadata: { id: 'candidate' }, spec: { entries: [...decoded.value.candidate.spec.entries].sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0) } }, head.manifest)) refuse('RECOVERY_REQUIRED', '', 'recovery');
  return { manifest: head.manifest, ref: head.progress.candidate.manifest, files: decoded.value.artifacts };
}
async function retainedPrimary(context: CycleContext, head: ProgressHead): Promise<CycleExecution> {
  const intent = head.progress.terminalIntent; if (!intent?.result) refuse('RECOVERY_REQUIRED', '', 'recovery');
  const raw = parsePrivateJson(await context.artifacts.read(intent.result, 1048576), 1048576);
  let complete = head.progress.stage.kind === 'terminal_observations' || head.progress.stage.kind === 'reconcile_result', observations = intent.observations;
  if (observations) await context.artifacts.read(observations, 1048576);
  const checked = validateDocument(raw, 'RunResult');
  if (!complete && checked.ok) {
    const finalizer = new Finalizer(context.artifacts, stateValue(context.store.inspect()).clock.remainingTaskMs.safeValue ?? 0);
    let events: ControllerEvents | null = null;
    try {
      events = new ControllerEvents(context.store, context.artifacts, context.onEvent, () => {}, head.progress.eventSequence, true); await events.ready();
      if (!events.hasTerminal) await events.push('terminal', null);
      let current = head;
      if (current.progress.stage.kind === 'terminal_intent') {
        finalizer.reserve(65536 + 65536 + 40960);
        current = await context.progress.publish({ ...current.progress, eventSequence: events.sequence, stage: { ...current.progress.stage, kind: 'terminal_result' } }, 'terminal.result');
      }
      const eventsRef = await events.close(); finalizer.check();
      observations = await finalizer.put('observations', { version: 1, primary: intent.result, requestedStatus: null, diagnostic: null, requestedStatusSource: 'unavailable', selectedNoChangeCheck: context.plan.noChangeEligibility.checkId,
        contradictions: [], verifierMatrix: null, verification: checked.value.spec.verification, preflightRefusals: null, events: eventsRef, cleanup: 'complete', memory: { status: 'not_requested', reason: null },
        publication: head.progress.publication.status === 'confirmed' ? { status: 'confirmed', reason: null, receipt: head.progress.publication.receipt } : head.progress.publication.status === 'failed' ? { status: 'failed', reason: 'not_executed', receipt: head.progress.publication.receipt } : head.progress.publication.status === 'unresolved' || head.progress.publication.status === 'pending' ? { status: 'unresolved', reason: 'unresolved', receipt: null } : { status: 'not_run', reason: 'disabled', receipt: null },
        unavailable: ['requestedStatus', 'contradictions', 'verifierMatrix', 'preflightRefusals'], recoveredOriginalPrimary: true });
      finalizer.reserve(65536 + 65536 + 40960);
      await context.progress.publish({ ...current.progress, eventSequence: events.sequence, stage: { ...current.progress.stage, kind: 'terminal_observations' }, terminalIntent: { ...intent, observations } }, 'terminal.observations'); complete = true;
    } catch { observations = intent.observations; }
    finally { if (events) await events.close().catch(() => {}); }
  }
  if (checked.ok) {
    if (!same(checked.value.spec.subject.lockHash, context.lock.spec.lockHash) || checked.value.spec.status !== intent.primary) refuse('RECOVERY_REQUIRED', '', 'recovery');
    return freeze({ kind: 'result', version: 1, runId: context.lock.spec.runId, result: checked.value, observations, secondary: complete ? [] : ['RECOVERY_REQUIRED'] });
  }
  const incident = record(raw, ['version', 'code', 'runId', 'lockHash', 'stage', 'knownReferences', 'unavailable', 'cleanup']);
  if (incident.version !== 1 || incident.runId !== context.lock.spec.runId || !same(incident.lockHash, context.lock.spec.lockHash) || incident.code !== intent.primary) refuse('RECOVERY_REQUIRED', '', 'recovery');
  return freeze({ kind: 'incident', version: 1, incident: incident as unknown as ControllerIncident });
}
export function resumeCycle(input: RunCycleInput) { return resumeCycleWithPorts(input); }
/** Test observation ports are private; resume has the same production execution route as run. */
export function resumeCycleWithPorts(input: RunCycleInput, ports: ControllerPorts = {}) {
  return result(async () => {
    const fields = Object.keys(input); record(input, fields);
    if (fields.some(key => !['configuration', 'repository', 'runRoot', 'runId', 'signal', 'onEvent'].includes(key)) || input.signal !== undefined && !(input.signal instanceof AbortSignal) || input.onEvent !== undefined && typeof input.onEvent !== 'function') refuse('CONFIG_SCHEMA', '', 'recovery');
    const state = approvedState(input.configuration), compiled = await compilePlan(input.configuration); if (!compiled.ok) throw new ControllerFailure(compiled.error);
    const retained = await readRetained(input), { directory, descriptor, lock } = retained, plan = compiled.value;
    const admitted = admitTask(plan.task, { admissionId: 'admission.' + hash('loopwright.dev/controller/admission/v1\0' + input.runId + '\0' + plan.planDigest.hex).hex.slice(0, 40), runId: input.runId });
    if (!admitted.ok || !same(admitted.value, lock) || !same(plan, retained.plan) || descriptor.repository !== resolve(input.repository)
      || !same(descriptor.configuration, { configPath: state.input.configPath, registryPath: state.input.registryPath, registrySha256: state.input.registrySha256 })) refuse('RECOVERY_REQUIRED', '', 'recovery');
    const expected = { directory: join(directory, 'state'), storeId: 'store.' + hash('loopwright.dev/controller/store/v1\0' + input.runId).hex.slice(0, 40), lock,
      policy: { version: 1, leaseMs: 60000, cost: 'observe_only' }, binding: { coreApiVersion: 'loopwright.dev/v1alpha1', hostVersion: 's04-controller-v1', adapters: [{ id: 'pi', version: '0.0.0' }], resourceVersion: plan.task.spec.trustedContext.revision, clockEpoch: 'boot.' + hash(await bootIdentity()).hex.slice(0, 40) } };
    if (!same(descriptor.identity, expected)) refuse('RECOVERY_REQUIRED', '', 'recovery');
    let owner: ControllerOwner | null = null, store: LocalRunStore | null = null, authority: Authority | null = null, handedOff = false;
    try {
      owner = await ControllerOwner.acquire(directory, input.runId, plan.planDigest);
      store = stateValue(reopenLocalRun(descriptor.identity)); const original = stateValue(store.inspect());
      if (original.clockStatus !== 'trusted') refuse('RECOVERY_REQUIRED', '', 'recovery');
      authority = stateValue(store.claim({ ownerId: 'controller.' + owner.nonce, expectedGeneration: original.owner.generation, expectedRevision: original.revision, mode: 'recovery' })).authority;
      const artifacts = new ArtifactStore(join(directory, 'artifacts'), owner, state.vault);
      const source = await restoreSource(resolve(input.repository), plan.task, owner, artifacts, descriptor.source, descriptor.sourceWorkspace);
      let progress = new ProgressStore(store, authority, artifacts, plan, lock, descriptor.plan, descriptor.source); const head = await progress.read();
      let context: CycleContext = { loaded: input.configuration, plan, lock, directory, source, store, authority, owner, artifacts, progress, descriptor, signal: input.signal ?? new AbortController().signal, onEvent: input.onEvent, ports };
      const candidate = await restoredCandidate(context, head);
      // A verifier proof can reconcile its original dispatch, but can never authorize a replacement Worker or request.
      if (head?.progress.stage.kind === 'verifier_pre') {
        const row = head.progress.verifierReceipts.find(item => item.generation === head!.progress.candidate.generation && item.receipt === null);
        if (row) {
          const operation = store.getOperation(row.operationId);
          if (operation.ok && operation.value.dispatch !== null) {
            const slot = plan.verifierSlots.find(item => item.id === row.slot)!, subject = head.checkpoint.subject;
            if (slot.handler.implementation === 'gate.v1') {
              const prepared = prepareGate(plan, lock, row.slot, candidate, head.progress.candidate.generation, row.producerNonce, input.configuration.registry.spec.gateEndpoints);
              await new Gate(store, authority, artifacts, plan, lock, ref => approvedState(input.configuration).vault.resolveNetworkCredential(ref), () => subject).restore(prepared);
            } else {
              const prepared = prepareVerification(plan, lock, row.slot, { manifest: source.manifest, ref: await artifacts.json('manifest', source.manifest, 32768), files: source.artifacts }, candidate, head.progress.candidate.generation, row.producerNonce);
              await new Verifier(store, authority, artifacts, plan, lock, () => subject).restore(prepared);
            }
          }
        }
      }
      // A publication operation parked at publication_pre reconciles under recovery authority: a settled live proof
      // confirms the dispatch (resume completes), an absent proof marks it unresolved (resume finishes reconcile_required).
      const publicationConfig = plan.publication;
      if (head?.progress.stage.kind === 'publication_pre' && head.progress.publication.operationId !== null && publicationConfig.mode === 'pull_request') {
        const operation = store.getOperation(head.progress.publication.operationId);
        const endpoint = input.configuration.registry.spec.publicationEndpoints.find(item => item.id === publicationConfig.endpointRef);
        if (operation.ok && operation.value.dispatch !== null && operation.value.state === 'dispatch_uncertain' && endpoint) {
          const prepared = preparePublication(plan, lock, original.storeId, endpoint, head.checkpoint.subject);
          await new Publication(store, authority, artifacts, plan, lock, ref => approvedState(input.configuration).vault.resolveNetworkCredential(ref), () => head.checkpoint.subject, descriptor.repository).restore(prepared, endpoint);
        }
      }
      const decision = progress.decision(head);
      if (decision === 'terminal') return await retainedPrimary(context, head!);
      if (input.signal?.aborted) refuse('CANCELLED', '', 'recovery');
      // No new authority implementation: release recovery claim, then claim active through S02's original CAS.
      stateValue(store.release(authority)); authority = null; const current = stateValue(store.inspect());
      authority = stateValue(store.claim({ ownerId: 'controller.' + owner.nonce, expectedGeneration: current.owner.generation, expectedRevision: current.revision, mode: 'active' })).authority;
      progress = new ProgressStore(store, authority, artifacts, plan, lock, descriptor.plan, descriptor.source);
      context = { ...context, authority, progress };
      let submission: RetainedSubmission | null = null;
      if (head?.progress.submission) {
        try { submission = { version: 1, origin: plan.orderedDAG.some(node => node.kind === 'agent') ? 'assistant' : 'controller', raw: head.progress.submission, value: normalizeSubmission(await artifacts.read(head.progress.submission, 1048576), plan.task) }; }
        catch (error) { if (!(error instanceof ControllerFailure) || error.diagnostic.code !== 'SUBMISSION_INVALID') throw error; }
      }
      handedOff = true; return await executeCycleContext(context, { head, candidate, submission, adopt: decision === 'adopt_capture' });
    } finally {
      if (!handedOff) { if (store) { if (authority) stateValue(store.release(authority)); stateValue(store.close()); } if (owner) await owner.release(); }
    }
  }, 'recovery');
}
