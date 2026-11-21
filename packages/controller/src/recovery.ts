import { join, resolve } from 'node:path';
import { validateDocument } from '@loopwright/core';
import { reopenLocalRun, type Authority, type LocalRunStore } from '@loopwright/state';
import { approvedState } from './config.js';
import { ControllerFailure, refuse, result } from './errors.js';
import { ControllerOwner } from './ownership.js';
import {
  admitRetainedRun,
  effectiveRunHostPolicy,
  hostProtectionFromPolicy,
  validatePortPolicyFields,
  validatePortsAgainstHostPolicy,
} from './retained.js';
import { ArtifactStore, stateValue } from './storage.js';
import { assertCanonicalMinimalOverlay, overlayManifestBounds, restoreSource } from './source.js';
import { ProgressStore, journal, type ProgressHead } from './progress.js';
import { assertNoHostProtectedMutations, decodeCandidateCapture } from './capture.js';
import { ControllerEvents } from './events.js';
import { Finalizer, type ControllerIncident } from './finalize.js';
import { parsePrivateJson } from './parser.js';
import { boundFindingsForObservations, hydrateStepVerdicts, normalizeSubmission, type RetainedSubmission } from './submission.js';
import { freeze, record, same, text } from './schema.js';
import { Verifier, prepareVerification, type ByteInventory } from './verification.js';
import { Gate, GATE_OUTPUT_BYTES, prepareGate, validateGateUrlOverrides } from './gate.js';
import { Publication, preparePublication } from './publication.js';
import { countDelegatedBudgets } from './budget-observations.js';
import { executeCycleContext, isHaltedByVerdict, type CycleContext, type ControllerPorts, type RunCycleInput } from './controller.js';
import type { CycleExecution, PlannedRole } from './types.js';

export async function restoredCandidate(context: CycleContext, head: ProgressHead | null): Promise<ByteInventory> {
  if (!head || same(head.progress.candidate.workspace, context.source.workspace)) {
    if (head && (!same(head.manifest, context.source.manifest) || !same(head.progress.candidate.workspace, context.source.workspace) || head.progress.candidate.privateSession !== null)) refuse('RECOVERY_REQUIRED', '', 'recovery');
    const bounds = overlayManifestBounds(context.plan.budgets.overlay);
    return { manifest: context.source.manifest, ref: head?.progress.candidate.manifest ?? await context.artifacts.json('manifest', context.source.manifest, bounds.manifestMaxBytes), files: context.source.artifacts, baselineProofs: context.source.baselineProofs };
  }
  const attempt = [...head.progress.attempts].reverse().find(item => item.finished?.nativeCheckpointId && same(journal(context.store).checkpoints.find(cp => cp.checkpointId === item.finished!.nativeCheckpointId)?.workspace, head.progress.candidate.workspace));
  if (!attempt) refuse('RECOVERY_REQUIRED', '', 'recovery');
  const checkpoint = stateValue(context.store.getCheckpoint(attempt.finished!.nativeCheckpointId!));
  const interval = journal(context.store).requests.filter(row => row.sequence > attempt.before.requests && row.sequence <= attempt.finished!.after.requests);
  const decoded = await decodeCandidateCapture({
    artifacts: context.artifacts,
    artifactsDirectory: context.artifacts.directory,
    lock: context.lock,
    plan: context.plan,
    checkpoint,
    attempt,
    expectedManifest: head.manifest,
    requestIds: interval.map(row => row.admission.requestId),
    phase: 'recovery',
  });
  await assertCanonicalMinimalOverlay(head.manifest, decoded.artifacts, context.source, 'recovery');
  const effectivePolicy = effectiveRunHostPolicy(context.descriptor);
  assertNoHostProtectedMutations(head.manifest, decoded.artifacts, context.source, hostProtectionFromPolicy(effectivePolicy), 'recovery');
  return { manifest: head.manifest, ref: head.progress.candidate.manifest, files: decoded.artifacts, baselineProofs: context.source.baselineProofs };
}
export async function retainedPrimary(context: CycleContext, head: ProgressHead): Promise<CycleExecution> {
  const intent = head.progress.terminalIntent; if (!intent?.result) refuse('RECOVERY_REQUIRED', '', 'recovery');
  const raw = parsePrivateJson(await context.artifacts.read(intent.result, 1048576), 1048576);
  let complete = head.progress.stage.kind === 'terminal_observations' || head.progress.stage.kind === 'reconcile_result', observations = intent.observations;
  if (observations) await context.artifacts.read(observations, 1048576);
  const checked = validateDocument(raw, 'RunResult');
  const storedVerdicts = head.progress.stepVerdicts ?? [];
  const finalVerdicts = checked.ok ? await hydrateStepVerdicts(context.artifacts, storedVerdicts).catch(() => []) : [];
  const finalFindings = finalVerdicts.flatMap(item => item.verdict.findings);
  if (!complete && checked.ok) {
    const finalizer = new Finalizer(context.artifacts, Math.max(stateValue(context.store.inspect()).clock.remainingTaskMs.safeValue ?? 0, 15000));
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
      const boundedFindings = boundFindingsForObservations(finalFindings);
      observations = await finalizer.put('observations', { version: 1, primary: intent.result, requestedStatus: null, diagnostic: null, requestedStatusSource: 'unavailable', selectedNoChangeCheck: context.plan.noChangeEligibility.checkId,
        contradictions: [], verifierMatrix: null, verification: checked.value.spec.verification, preflightRefusals: null, events: eventsRef, cleanup: 'complete', memory: { status: 'not_requested', reason: null },
        publication: head.progress.publication.status === 'confirmed' ? { status: 'confirmed', reason: null, receipt: head.progress.publication.receipt } : head.progress.publication.status === 'failed' ? { status: 'failed', reason: 'not_executed', receipt: head.progress.publication.receipt } : head.progress.publication.status === 'unresolved' || head.progress.publication.status === 'pending' ? { status: 'unresolved', reason: 'unresolved', receipt: null } : { status: 'not_run', reason: 'disabled', receipt: null },
        ...(storedVerdicts.length > 0 ? { stepVerdicts: storedVerdicts } : {}),
        ...(boundedFindings.findings.length > 0 ? { findings: boundedFindings.findings } : {}),
        ...(boundedFindings.findingsTruncated ? { findingsTruncated: true, totalFindingsCount: boundedFindings.totalFindingsCount } : {}),
        unavailable: ['requestedStatus', 'contradictions', 'verifierMatrix', 'preflightRefusals'], recoveredOriginalPrimary: true });
      finalizer.reserve(65536 + 65536 + 40960);
      await context.progress.publish({ ...current.progress, eventSequence: events.sequence, stage: { ...current.progress.stage, kind: 'terminal_observations' }, terminalIntent: { ...intent, observations } }, 'terminal.observations'); complete = true;
    } catch { observations = intent.observations; }
    finally { if (events) await events.close().catch(() => {}); }
  }
  if (checked.ok) {
    if (!same(checked.value.spec.subject.lockHash, context.lock.spec.lockHash) || checked.value.spec.status !== intent.primary) refuse('RECOVERY_REQUIRED', '', 'recovery');
    return freeze({
      kind: 'result',
      version: 1,
      runId: context.lock.spec.runId,
      result: checked.value,
      observations,
      secondary: complete ? [] : ['RECOVERY_REQUIRED'],
      ...(finalFindings.length > 0 ? { findings: freeze(finalFindings) } : {}),
      ...(finalVerdicts.length > 0 ? { stepVerdicts: freeze([...finalVerdicts]) } : {}),
    });
  }
  const incident = record(raw, ['version', 'code', 'runId', 'lockHash', 'stage', 'knownReferences', 'unavailable', 'cleanup']);
  if (incident.version !== 1 || incident.runId !== context.lock.spec.runId || !same(incident.lockHash, context.lock.spec.lockHash) || incident.code !== intent.primary) refuse('RECOVERY_REQUIRED', '', 'recovery');
  return freeze({ kind: 'incident', version: 1, incident: incident as unknown as ControllerIncident });
}
export async function reconcileInterruptedOperations(context: CycleContext, head: ProgressHead | null, candidate: ByteInventory, storeId: string): Promise<void> {
  const { plan, lock, store, authority, artifacts, loaded, source, descriptor, ports } = context;
  if (head?.progress.stage.kind === 'verifier_pre') {
    const row = head.progress.verifierReceipts.find(item => item.generation === head.progress.candidate.generation && item.receipt === null);
    if (row) {
      const operation = store.getOperation(row.operationId);
      if (operation.ok && operation.value.dispatch !== null) {
        const slot = plan.verifierSlots.find(item => item.id === row.slot)!, subject = head.checkpoint.subject;
        if (slot.handler.implementation === 'gate.v1') {
          const prepared = prepareGate(plan, lock, row.slot, candidate, head.progress.candidate.generation, row.producerNonce, loaded.registry.spec.gateEndpoints);
          await new Gate(store, authority, artifacts, plan, lock, ref => approvedState(loaded).vault.resolveNetworkCredential(ref), () => subject, null, ports.gateUrlOverrides).restore(prepared);
        } else {
          const bounds = overlayManifestBounds(plan.budgets.overlay);
          const prepared = prepareVerification(plan, lock, row.slot, { manifest: source.manifest, ref: await artifacts.json('manifest', source.manifest, bounds.manifestMaxBytes), files: source.artifacts, ...(source.baselineProofs ? { baselineProofs: source.baselineProofs } : {}) }, candidate, head.progress.candidate.generation, row.producerNonce);
          await new Verifier(store, authority, artifacts, plan, lock, () => subject).restore(prepared);
        }
      }
    }
  }
  const publicationConfig = plan.publication;
  if (head?.progress.stage.kind === 'publication_pre' && head.progress.publication.operationId !== null && publicationConfig.mode === 'pull_request') {
    const operation = store.getOperation(head.progress.publication.operationId);
    const endpoint = loaded.registry.spec.publicationEndpoints.find(item => item.id === publicationConfig.endpointRef);
    if (operation.ok && operation.value.dispatch !== null && operation.value.state === 'dispatch_uncertain' && endpoint) {
      const prepared = preparePublication(plan, lock, storeId, endpoint, head.checkpoint.subject);
      await new Publication(store, authority, artifacts, plan, lock, ref => approvedState(loaded).vault.resolveNetworkCredential(ref), () => head.checkpoint.subject, descriptor.repository).restore(prepared, endpoint);
    }
  }
}
export function resumeCycle(input: RunCycleInput) { return resumeCycleWithPorts(input); }
/** Test observation ports are private; resume has the same production execution route as run. */
export function resumeCycleWithPorts(input: RunCycleInput, ports: ControllerPorts = {}) {
  return result(async () => {
    const fields = Object.keys(input); record(input, fields);
    if (fields.some(key => !['configuration', 'repository', 'runRoot', 'runId', 'signal', 'onEvent'].includes(key)) || input.signal !== undefined && !(input.signal instanceof AbortSignal) || input.onEvent !== undefined && typeof input.onEvent !== 'function') refuse('CONFIG_SCHEMA', '', 'recovery');
    validateGateUrlOverrides(ports.gateUrlOverrides, 'recovery');
    validatePortPolicyFields(ports, 'recovery');
    const { directory, descriptor, hostPolicy, lock, effectiveConfig, state, plan } = await admitRetainedRun({
      runRoot: input.runRoot,
      runId: input.runId,
      configuration: input.configuration,
      repository: input.repository,
      phase: 'recovery',
    });
    const effectivePorts = validatePortsAgainstHostPolicy(ports, hostPolicy, 'recovery');
    validateGateUrlOverrides(effectivePorts.gateUrlOverrides, 'recovery', effectiveConfig.registry.spec.gateEndpoints);
    let owner: ControllerOwner | null = null, store: LocalRunStore | null = null, authority: Authority | null = null, handedOff = false;
    try {
      owner = await ControllerOwner.acquire(directory, input.runId, plan.planDigest);
      store = stateValue(reopenLocalRun(descriptor.identity)); const original = stateValue(store.inspect());
      if (original.clockStatus !== 'trusted') refuse('RECOVERY_REQUIRED', '', 'recovery');
      authority = stateValue(store.claim({ ownerId: 'controller.' + owner.nonce, expectedGeneration: original.owner.generation, expectedRevision: original.revision, mode: 'recovery' })).authority;
      const artifacts = new ArtifactStore(join(directory, 'artifacts'), owner, state.vault);
      await artifacts.cleanCasTempFiles();
      const jsonPaths = [...new Set(plan.verifierSlots.filter(slot => ['json-artifact.v1', 'json-keys-guard.v1', 'line-section-guard.v1'].includes(slot.handler.implementation)).map(slot => text(slot.handler.parameters.path)))];
      const source = await restoreSource(resolve(input.repository), plan.task, owner, artifacts, descriptor.source, descriptor.sourceWorkspace, jsonPaths);
      let progress = new ProgressStore(store, authority, artifacts, plan, lock, descriptor.plan, descriptor.source); const head = await progress.read();
      let context: CycleContext = { loaded: effectiveConfig, plan, lock, directory, source, store, authority, owner, artifacts, progress, descriptor, signal: input.signal ?? new AbortController().signal, onEvent: input.onEvent, ports: effectivePorts };
      const candidate = await restoredCandidate(context, head);
      await reconcileInterruptedOperations(context, head, candidate, original.storeId);
      const decision = progress.decision(head);
      if (decision === 'terminal') return await retainedPrimary(context, head!);
      let submission: RetainedSubmission | null = null;
      if (head?.progress.submission) {
        try { submission = { version: 1, origin: plan.orderedDAG.some(node => node.kind === 'agent') ? 'assistant' : 'controller', raw: head.progress.submission, value: normalizeSubmission(await artifacts.read(head.progress.submission, 1048576), plan.task) }; }
        catch (error) { if (!(error instanceof ControllerFailure) || error.diagnostic.code !== 'SUBMISSION_INVALID') throw error; }
      }
      const isDelegatedNode = (nodeId: string): boolean => {
        const dagNode = plan.orderedDAG.find(item => item.id === nodeId);
        const role = dagNode?.roleId ? plan.roles.find(item => item.roleId === dagNode.roleId) : undefined;
        return dagNode?.kind === 'agent' && role?.adapter === 'delegated';
      };
      const isMutatingRole = (role: PlannedRole): boolean =>
        role.policy.tools.some(tool => tool === 'write' || tool === 'edit' || tool === 'delete' || tool === 'bash');
      const activeNodes = head ? head.progress.nodes : plan.orderedDAG.map(node => ({ id: node.id, state: 'pending' as const }));
      const attempts = head?.progress.attempts ?? [];
      const lastAttempt = attempts.at(-1);
      const unfinishedDelegated = lastAttempt !== undefined && lastAttempt.finished === null && isDelegatedNode(lastAttempt.nodeId);
      const reachableDelegated = activeNodes.some(node => (node.state === 'pending' || node.state === 'running') && isDelegatedNode(node.id));
      const formatRepairDelegated = Boolean(lastAttempt?.finished?.nativeCheckpointId)
        && !isHaltedByVerdict(head?.progress)
        && lastAttempt!.purpose !== 'compaction'
        && activeNodes.find(node => node.id === lastAttempt!.nodeId)?.state === 'failed'
        && isDelegatedNode(lastAttempt!.nodeId);
      let implRepairDelegated = false;
      const priorMutatingTask = attempts
        .filter(attempt => {
          if (attempt.purpose !== 'task' || attempt.repair === 'format' || !attempt.finished?.nativeCheckpointId) return false;
          const dagNode = plan.orderedDAG.find(item => item.id === attempt.nodeId);
          const role = dagNode?.roleId ? plan.roles.find(item => item.roleId === dagNode.roleId) : undefined;
          return role !== undefined && isMutatingRole(role);
        })
        .at(-1);
      if (priorMutatingTask && isDelegatedNode(priorMutatingTask.nodeId) && plan.budgets.maxImplementationRepairs > 0) {
        const delegatedCounts = countDelegatedBudgets(plan, attempts);
        if (
          attempts.length < plan.capacity.A
          && original.ledger.implementationRepairs + delegatedCounts.implementationRepairs < plan.budgets.maxImplementationRepairs
        ) {
          const generation = head?.progress.candidate.generation ?? 0;
          const requiredExplicitSlots = plan.verifierSlots.filter(
            slot => slot.implicit === null && plan.task.spec.acceptance.required.includes(slot.checkId),
          );
          let allRequiredPassed = head !== null;
          for (const slot of requiredExplicitSlots) {
            if (!allRequiredPassed) break;
            if (head!.progress.verifierRefusals.some(row => row.slot === slot.id && row.generation === generation)) {
              allRequiredPassed = false;
              break;
            }
            const receiptRow = head!.progress.verifierReceipts.find(row => row.slot === slot.id && row.generation === generation);
            if (!receiptRow) {
              allRequiredPassed = false;
              break;
            }
            const op = store.getOperation(receiptRow.operationId);
            const settledReceipt = op.ok && op.value.state === 'confirmed'
              ? (op.value.reconciliation ?? op.value.initialReceipt)
              : null;
            if (!settledReceipt) {
              allRequiredPassed = false;
              break;
            }
            try {
              const outCap = slot.handler.implementation === 'gate.v1' ? GATE_OUTPUT_BYTES : 65536;
              const rawOut = parsePrivateJson(await artifacts.read(settledReceipt.evidence.artifact, outCap), outCap) as Record<string, unknown>;
              const status = slot.handler.implementation === 'gate.v1'
                ? (rawOut.disposition as Record<string, unknown> | undefined)?.status
                : (rawOut.response as Record<string, unknown> | undefined)?.status;
              if (status !== 'passed') {
                allRequiredPassed = false;
                break;
              }
            } catch {
              allRequiredPassed = false;
              break;
            }
          }
          if (!allRequiredPassed) implRepairDelegated = true;
        }
      }
      if (unfinishedDelegated || reachableDelegated || formatRepairDelegated || implRepairDelegated) {
        refuse('CAPABILITY_UNSUPPORTED', '/spec/profiles/roles', 'recovery');
      }
      if (input.signal?.aborted) refuse('CANCELLED', '', 'recovery');
      // No new authority implementation: release recovery claim, then claim active through S02's original CAS.
      stateValue(store.release(authority)); authority = null; const current = stateValue(store.inspect());
      authority = stateValue(store.claim({ ownerId: 'controller.' + owner.nonce, expectedGeneration: current.owner.generation, expectedRevision: current.revision, mode: 'active' })).authority;
      progress = new ProgressStore(store, authority, artifacts, plan, lock, descriptor.plan, descriptor.source);
      context = { ...context, authority, progress };
      handedOff = true; return await executeCycleContext(context, { head, candidate, submission, adopt: decision === 'adopt_capture' });
    } finally {
      if (!handedOff) { if (store) { if (authority) stateValue(store.release(authority)); stateValue(store.close()); } if (owner) await owner.release(); }
    }
  }, 'recovery');
}
