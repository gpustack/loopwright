import { bindSubject, identifyManifest, type ArtifactManifest, type ArtifactRef, type TaskLock } from '@loopwright/core';
import type { Authority, CheckpointRecord, LocalRunStore, OperationRecord, Page, PageCursor, RequestRecord } from '@loopwright/state';
import { canonical, freeze, hash, integer, list, record, same, text, digestValue } from './schema.js';
import { parsePrivateJson } from './parser.js';
import { ControllerFailure, refuse } from './errors.js';
import { stateValue, checkedRef, ArtifactStore, type ArtifactReader } from './storage.js';
import { checkedRefusalRecord, checkedRefusalSubject, refusalSubject } from './refusal-record.js';
import type { CheckpointCapacity, CompiledPlan, ControllerProgress, ReceiptIndex } from './types.js';

export function phaseCheckpointId(runId: string, phase: string): string {
  return (phase.endsWith('.native') ? 'pi.' : 'controller.') + hash('loopwright.dev/controller/checkpoint/v1\0' + canonical({ runId, phase })).hex.slice(0, 40);
}
export function phaseSchedule(capacity: CheckpointCapacity): readonly string[] {
  const phases = ['bootstrap'];
  for (let attempt = 1; attempt <= capacity.A; attempt++) for (const suffix of ['pre', 'native', 'post']) phases.push('role.' + attempt + '.' + suffix);
  for (let generation = 0; generation < capacity.V; generation++) for (let slot = 0; slot < capacity.C; slot++) for (const suffix of ['pre', 'post']) phases.push('verify.' + generation + '.' + slot + '.' + suffix);
  phases.push('terminal.intent', 'terminal.result', 'terminal.observations');
  if (phases.length !== capacity.D) refuse('ARTIFACT_INVALID', '', 'recovery'); return phases;
}
export function stableId(runId: string, nodeId: string, purpose: string, repair: string, ordinal: number): string {
  return 'attempt.' + hash('loopwright.dev/controller/attempt/v1\0' + canonical({ runId, nodeId, purpose, repair, ordinal })).hex.slice(0, 40);
}
export function verifierOperationId(runId: string, slot: string, generation: number): string { return 'verify.' + hash('loopwright.dev/controller/verifier/v1\0' + canonical({ runId, slot, generation })).hex.slice(0, 40); }
/** Synchronous page walk: no renewal can interleave in this process; every collection shares one revision. */
export function journal(store: LocalRunStore) {
  const walk = <T>(reader: (input: { limit: number; cursor: PageCursor | null }) => import('@loopwright/state').StateResult<Page<T>>): { revision: number; items: T[] } => {
    let cursor: PageCursor | null = null, revision = -1; const items: T[] = [];
    do {
      const page: Page<T> = stateValue(reader({ limit: 100, cursor }));
      if (revision !== -1 && revision !== page.revision) refuse('RECOVERY_REQUIRED', '', 'recovery'); revision = page.revision; items.push(...page.items); cursor = page.next;
      if (items.length > 2048) refuse('OUTPUT_LIMIT', '', 'recovery');
    } while (cursor !== null);
    return { revision, items };
  };
  const requests = walk<RequestRecord>(input => store.listRequests(input)), operations = walk<OperationRecord>(input => store.listOperations(input)), checkpoints = walk<CheckpointRecord>(input => store.listCheckpoints(input));
  const view = stateValue(store.inspect());
  if ([requests.revision, operations.revision, checkpoints.revision].some(revision => revision !== view.revision)) refuse('RECOVERY_REQUIRED', '', 'recovery');
  return { view, requests: requests.items, operations: operations.items, checkpoints: checkpoints.items };
}
function watermarks(raw: unknown): void { const value = record(raw, ['requests', 'operations']); integer(value.requests, 0, 1024); integer(value.operations, 0, 2048); }
function checkedProgress(raw: unknown, plan: CompiledPlan, lock: TaskLock): ControllerProgress {
  const value = record(raw, ['version', 'runId', 'lockHash', 'sequence', 'previous', 'stage', 'nodes', 'attempts', 'nativeCheckpoints', 'submission', 'candidate', 'failures', 'verifierReceipts', 'verifierRefusals', 'eventSequence', 'terminalIntent']);
  if (value.version !== 2 || value.runId !== lock.spec.runId || !same(value.lockHash, lock.spec.lockHash)) refuse('RECOVERY_REQUIRED', '', 'recovery');
  integer(value.sequence, 1, 64); integer(value.eventSequence, 0, Number.MAX_SAFE_INTEGER); if (value.previous !== null) checkedRef(value.previous); if (value.submission !== null) checkedRef(value.submission);
  const stage = record(value.stage, ['kind', 'phase', 'capacity', 'consumed', 'watermarks']);
  const kinds = ['bootstrap', 'role_pre', 'role_post', 'verifier_pre', 'verifier_post', 'terminal_intent', 'terminal_result', 'terminal_observations'];
  if (!kinds.includes(text(stage.kind)) || !same(stage.capacity, plan.capacity)) refuse('RECOVERY_REQUIRED', '', 'recovery'); watermarks(stage.watermarks);
  const schedule = phaseSchedule(plan.capacity), consumed = list(stage.consumed, '', 64).map(item => text(item, '', 64));
  if (!schedule.includes(text(stage.phase)) || consumed.at(-1) !== stage.phase || consumed.length !== value.sequence || new Set(consumed).size !== consumed.length || consumed.some(phase => !schedule.includes(phase))) refuse('RECOVERY_REQUIRED', '', 'recovery');
  const phase = text(stage.phase), expectedKind = phase === 'bootstrap' ? 'bootstrap' : phase.startsWith('role.') ? phase.endsWith('.pre') ? 'role_pre' : 'role_post'
    : phase.startsWith('verify.') ? phase.endsWith('.pre') ? 'verifier_pre' : 'verifier_post' : phase.replace('.', '_');
  if (phase.endsWith('.native') || stage.kind !== expectedKind || consumed[0] !== 'bootstrap') refuse('RECOVERY_REQUIRED', '', 'recovery');
  const nodes = list(value.nodes, '', 16).map(node => record(node, ['id', 'state']));
  if (nodes.length !== plan.orderedDAG.length || new Set(nodes.map(node => node.id)).size !== nodes.length || nodes.some(node => !plan.orderedDAG.some(item => item.id === node.id) || !['pending', 'running', 'completed', 'failed', 'blocked', 'not_run'].includes(text(node.state)))) refuse('RECOVERY_REQUIRED', '', 'recovery');
  const attempts = list(value.attempts, '', 16);
  if (attempts.length > plan.capacity.A) refuse('ATTEMPT_LIMIT', '', 'recovery');
  for (const [index, rawAttempt] of attempts.entries()) {
    const attempt = record(rawAttempt, ['ordinal', 'id', 'nodeId', 'nativeStepId', 'sessionId', 'purpose', 'repair', 'command', 'before', 'finished']);
    if (attempt.ordinal !== index + 1 || !plan.orderedDAG.some(node => node.id === attempt.nodeId && node.kind === 'agent') || !['task', 'reviewer', 'compaction'].includes(text(attempt.purpose)) || !['none', 'format', 'implementation'].includes(text(attempt.repair))
      || attempt.id !== stableId(lock.spec.runId, text(attempt.nodeId), text(attempt.purpose), text(attempt.repair), index + 1)) refuse('RECOVERY_REQUIRED', '', 'recovery');
    const node = plan.orderedDAG.find(node => node.id === attempt.nodeId)!, nativeStep = plan.orderedDAG.find(node => node.id === attempt.nativeStepId);
    if (!nativeStep || nativeStep.kind !== 'agent' || nativeStep.roleId !== node.roleId || !/^[a-z][a-z0-9._-]{0,63}$/.test(text(attempt.sessionId))) refuse('RECOVERY_REQUIRED', '', 'recovery');
    checkedRef(attempt.command); watermarks(attempt.before);
    if (attempt.finished !== null) { const finished = record(attempt.finished, ['after', 'outcome', 'nativeCheckpointId']); watermarks(finished.after); checkedRef(finished.outcome); if (finished.nativeCheckpointId !== null && finished.nativeCheckpointId !== phaseCheckpointId(lock.spec.runId, 'role.' + (index + 1) + '.native')) refuse('RECOVERY_REQUIRED', '', 'recovery'); }
    else if (index !== attempts.length - 1) refuse('RECOVERY_REQUIRED', '', 'recovery');
  }
  const typedAttempts = attempts as unknown as ControllerProgress['attempts'];
  const ordinary = typedAttempts.filter(attempt => attempt.repair === 'none' && attempt.purpose !== 'compaction');
  if (new Set(ordinary.map(attempt => attempt.nodeId)).size !== ordinary.length || typedAttempts.filter(attempt => attempt.repair === 'implementation').length > plan.budgets.maxImplementationRepairs
    || typedAttempts.filter(attempt => attempt.repair === 'format').length > plan.budgets.maxFormatRepairs) refuse('RECOVERY_REQUIRED', '', 'recovery');
  if (phase.startsWith('role.')) {
    const ordinal = Number(phase.split('.')[1]), attempt = typedAttempts.at(-1);
    if (!attempt || attempt.ordinal !== ordinal || phase.endsWith('.pre') !== (attempt.finished === null) || phase.endsWith('.post') && !consumed.includes('role.' + ordinal + '.pre')) refuse('RECOVERY_REQUIRED', '', 'recovery');
  }
  const candidate = record(value.candidate, ['manifest', 'digest', 'generation', 'workspace', 'privateSession']); checkedRef(candidate.manifest); digestValue(candidate.digest); checkedRef(candidate.workspace); if (candidate.privateSession !== null) checkedRef(candidate.privateSession); integer(candidate.generation, 0, plan.capacity.V - 1);
  const native = list(value.nativeCheckpoints, '', plan.capacity.A).map(item => record(item, ['attemptId', 'checkpointId', 'outcome']));
  if (new Set(native.map(item => item.checkpointId)).size !== native.length) refuse('RECOVERY_REQUIRED', '', 'recovery');
  for (const item of native) {
    const attempt = typedAttempts.find(attempt => attempt.id === item.attemptId);
    if (!attempt || attempt.finished === null || item.checkpointId !== phaseCheckpointId(lock.spec.runId, 'role.' + attempt.ordinal + '.native') || attempt.finished.nativeCheckpointId !== item.checkpointId || !same(attempt.finished.outcome, item.outcome)) refuse('RECOVERY_REQUIRED', '', 'recovery'); checkedRef(item.outcome);
  }
  if (native.length !== typedAttempts.filter(attempt => attempt.finished !== null && attempt.finished.nativeCheckpointId !== null).length) refuse('RECOVERY_REQUIRED', '', 'recovery');
  const failures = list(value.failures, '', 16).map(rawFailure => record(rawFailure, ['signature', 'count', 'generation', 'evidence']));
  for (const failure of failures) { digestValue(failure.signature); integer(failure.count, 1, 2); integer(failure.generation, 0, plan.capacity.V - 1); if (failure.evidence !== null) checkedRef(failure.evidence); }
  if (new Set(failures.map(failure => canonical(failure.signature))).size !== failures.length) refuse('RECOVERY_REQUIRED', '', 'recovery');
  const receipts = list(value.verifierReceipts, '', plan.capacity.J).map(item => record(item, ['slot', 'generation', 'operationId', 'producerNonce', 'output', 'receipt']));
  if (new Set(receipts.map(item => item.slot + ':' + item.generation)).size !== receipts.length) refuse('RECOVERY_REQUIRED', '', 'recovery');
  for (const item of receipts) {
    if (!plan.verifierSlots.some(slot => slot.id === item.slot)) refuse('RECOVERY_REQUIRED', '', 'recovery'); integer(item.generation, 0, plan.capacity.V - 1);
    if (item.operationId !== verifierOperationId(lock.spec.runId, text(item.slot), item.generation as number) || !/^[a-f0-9]{32}$/.test(text(item.producerNonce)) || (item.output === null) !== (item.receipt === null)) refuse('RECOVERY_REQUIRED', '', 'recovery');
    if (item.output !== null) checkedRef(item.output); if (item.receipt !== null) checkedRef(item.receipt);
  }
  const refusals = list(value.verifierRefusals, '', plan.capacity.J).map(item => record(item, ['slot', 'generation', 'prospectiveOperationId', 'producerNonce', 'subject', 'record']));
  if (receipts.length + refusals.length > plan.capacity.J || new Set([...receipts, ...refusals].map(item => item.slot + ':' + item.generation)).size !== receipts.length + refusals.length) refuse('RECOVERY_REQUIRED', '', 'recovery');
  for (const item of refusals) {
    if (!plan.verifierSlots.some(slot => slot.id === item.slot)) refuse('RECOVERY_REQUIRED', '', 'recovery'); integer(item.generation, 0, candidate.generation as number);
    if (item.prospectiveOperationId !== verifierOperationId(lock.spec.runId, text(item.slot), item.generation as number) || !/^[a-f0-9]{32}$/.test(text(item.producerNonce)) || checkedRef(item.record).byteLength > 65536) refuse('RECOVERY_REQUIRED', '', 'recovery');
    checkedRefusalSubject(item.subject, lock);
  }
  if (phase.startsWith('verify.')) {
    const [, generation, ordinal] = phase.split('.'), slot = plan.verifierSlots[Number(ordinal)]!;
    const receipt = receipts.find(item => item.slot === slot.id && item.generation === Number(generation)), refusal = refusals.find(item => item.slot === slot.id && item.generation === Number(generation));
    if (Number(generation) !== candidate.generation || !receipt && !refusal || phase.endsWith('.post') && (receipt?.receipt === null || !consumed.includes('verify.' + generation + '.' + ordinal + '.pre'))) refuse('RECOVERY_REQUIRED', '', 'recovery');
  }
  if (value.terminalIntent !== null) { const terminal = record(value.terminalIntent, ['primary', 'result', 'observations']); text(terminal.primary, '', 64); if (terminal.result !== null) checkedRef(terminal.result); if (terminal.observations !== null) checkedRef(terminal.observations); }
  return raw as ControllerProgress;
}
export function validateProgress(raw: unknown, plan: CompiledPlan, lock: TaskLock): ControllerProgress {
  try { return checkedProgress(raw, plan, lock); }
  catch (error) {
    if (error instanceof ControllerFailure && ['RECOVERY_REQUIRED', 'ARTIFACT_INVALID', 'ATTEMPT_LIMIT', 'OUTPUT_LIMIT'].includes(error.diagnostic.code)) throw error;
    refuse('RECOVERY_REQUIRED', '', 'recovery');
  }
}
function extension(previous: ControllerProgress | null, current: ControllerProgress, plan: CompiledPlan): void {
  if (!previous) { if (current.stage.phase !== 'bootstrap' || current.previous !== null || current.attempts.length || current.verifierRefusals.length || current.candidate.generation !== 0) refuse('RECOVERY_REQUIRED', '', 'recovery'); return; }
  if (current.sequence <= previous.sequence || current.attempts.length < previous.attempts.length || current.eventSequence < previous.eventSequence || !same(current.stage.consumed.slice(0, previous.stage.consumed.length), previous.stage.consumed)) refuse('RECOVERY_REQUIRED', '', 'recovery');
  for (const [index, prior] of previous.attempts.entries()) {
    const next = current.attempts[index]!;
    if (!same({ ...prior, finished: null }, { ...next, finished: null }) || prior.finished !== null && !same(prior, next)) refuse('RECOVERY_REQUIRED', '', 'recovery');
  }
  const changed = !same(previous.candidate.digest, current.candidate.digest);
  if (current.candidate.generation !== previous.candidate.generation + (changed ? 1 : 0)) refuse('RECOVERY_REQUIRED', '', 'recovery');
  if (changed && (current.stage.kind !== 'role_post' || current.attempts.at(-1)?.repair === 'format' || current.attempts.at(-1)?.purpose === 'compaction')) refuse('RECOVERY_REQUIRED', '', 'recovery');
  if (current.verifierReceipts.length < previous.verifierReceipts.length || !same(current.nativeCheckpoints.slice(0, previous.nativeCheckpoints.length), previous.nativeCheckpoints)) refuse('RECOVERY_REQUIRED', '', 'recovery');
  for (const [index, prior] of previous.verifierReceipts.entries()) {
    const next = current.verifierReceipts[index]!;
    if (!same({ ...prior, output: null, receipt: null }, { ...next, output: null, receipt: null }) || prior.receipt !== null && !same(prior, next)) refuse('RECOVERY_REQUIRED', '', 'recovery');
  }
  if (current.verifierRefusals.length < previous.verifierRefusals.length || !same(current.verifierRefusals.slice(0, previous.verifierRefusals.length), previous.verifierRefusals)) refuse('RECOVERY_REQUIRED', '', 'recovery');
  for (const row of current.verifierRefusals.slice(previous.verifierRefusals.length)) {
    const ordinal = plan.verifierSlots.findIndex(slot => slot.id === row.slot);
    if (current.stage.kind !== 'verifier_pre' || current.stage.phase !== 'verify.' + row.generation + '.' + ordinal + '.pre' || row.generation !== current.candidate.generation) refuse('RECOVERY_REQUIRED', '', 'recovery');
  }
  for (const failure of previous.failures) {
    const retained = current.failures.find(item => same(item.signature, failure.signature));
    if (!retained || retained.count < failure.count || retained.generation !== failure.generation) refuse('RECOVERY_REQUIRED', '', 'recovery');
  }
}
export interface ProgressHead { readonly checkpoint: CheckpointRecord; readonly ref: ArtifactRef; readonly progress: ControllerProgress; readonly index: ReceiptIndex; readonly manifest: ArtifactManifest }
export class ProgressStore {
  constructor(readonly store: LocalRunStore, readonly authority: Authority | null, readonly artifacts: ArtifactReader, readonly plan: CompiledPlan, readonly lock: TaskLock, readonly planRef: ArtifactRef, readonly sourceRef: ArtifactRef) {}
  async manifest(ref: ArtifactRef): Promise<ArtifactManifest> {
    const identified = identifyManifest(parsePrivateJson(await this.artifacts.read(ref, 32768), 32768));
    if (!identified.ok) refuse('ARTIFACT_INVALID', '', 'recovery');
    const manifest = identified.value.manifest;
    if (manifest.metadata.id !== 'candidate' || !same([...manifest.spec.entries].sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0), manifest.spec.entries)) refuse('ARTIFACT_INVALID', '', 'recovery'); return manifest;
  }
  async read(): Promise<ProgressHead | null> {
    if (!same(parsePrivateJson(await this.artifacts.read(this.planRef, 1048576), 1048576), this.plan)) refuse('RECOVERY_REQUIRED', '', 'recovery');
    const verified = new Set<string>(), wrappers = new Set<string>(), manifests = new Map<string, ArtifactManifest>(), negativeAnchors = new Set<string>();
    const verify = async (ref: ArtifactRef, maximum = 8388608): Promise<void> => {
      if (ref.byteLength > maximum) refuse('ARTIFACT_INVALID', '', 'recovery');
      const key = canonical(ref); if (!verified.has(key)) { await this.artifacts.read(ref, maximum); verified.add(key); }
    };
    const before = journal(this.store), schedule = phaseSchedule(this.plan.capacity), emitted: string[] = []; let head: ProgressHead | null = null;
    for (const checkpoint of before.checkpoints) {
      const phase = schedule.find(phase => phaseCheckpointId(this.lock.spec.runId, phase) === checkpoint.checkpointId);
      if (!phase || emitted.includes(phase) || !same(checkpoint.clockBasis, before.view.clock.basis)) refuse('RECOVERY_REQUIRED', '', 'recovery'); emitted.push(phase);
      if (phase.endsWith('.native')) {
        if (checkpoint.additionalArtifacts.length !== 0 || checkpoint.privateSession === null || !emitted.includes(phase.replace('.native', '.pre'))) refuse('RECOVERY_REQUIRED', '', 'recovery');
        await verify(checkpoint.workspace); await verify(checkpoint.privateSession, 2097152); continue;
      }
      if (checkpoint.additionalArtifacts.length !== 4 || !same(checkpoint.additionalArtifacts.slice(2), [this.planRef, this.sourceRef])) refuse('RECOVERY_REQUIRED', '', 'recovery');
      const ref = checkpoint.additionalArtifacts[0]!, progress = validateProgress(parsePrivateJson(await this.artifacts.read(ref, 65536), 65536), this.plan, this.lock);
      const manifestKey = canonical(progress.candidate.manifest);
      let manifest = manifests.get(manifestKey); if (!manifest) { manifest = await this.manifest(progress.candidate.manifest); manifests.set(manifestKey, manifest); }
      const subject = bindSubject(this.lock, manifest);
      if (!subject.ok || !same(subject.value, checkpoint.subject) || !same(progress.candidate.digest, subject.value.candidateDigest) || progress.sequence !== checkpoint.sequence
        || !same(progress.stage.consumed, emitted) || !same(progress.stage.watermarks, { requests: checkpoint.counts.requests, operations: checkpoint.counts.operations })
        || !same(progress.candidate.workspace, checkpoint.workspace) || !same(progress.candidate.privateSession, checkpoint.privateSession) || !same(progress.previous, head?.ref ?? null)) refuse('RECOVERY_REQUIRED', '', 'recovery');
      extension(head?.progress ?? null, progress, this.plan);
      for (const row of progress.verifierRefusals) {
        const key = row.slot + ':' + row.generation; if (negativeAnchors.has(key)) continue;
        const ordinal = this.plan.verifierSlots.findIndex(slot => slot.id === row.slot);
        if (phase !== 'verify.' + row.generation + '.' + ordinal + '.pre' || !same(row.subject, checkpoint.subject)) refuse('RECOVERY_REQUIRED', '', 'recovery');
        const source = parsePrivateJson(await this.artifacts.read(this.sourceRef, 262144), 262144) as Record<string, unknown>, sourceManifestRef = checkedRef(source.manifest), sourceManifest = await this.manifest(sourceManifestRef);
        const value = checkedRefusalRecord(parsePrivateJson(await this.artifacts.read(row.record, 65536), 65536), this.plan, this.lock, row);
        refusalSubject(this.lock, manifest, row, value, sourceManifestRef, progress.candidate.manifest, sourceManifest);
        const absent = this.store.getOperation(row.prospectiveOperationId);
        if (absent.ok || absent.error.code !== 'RECORD_NOT_FOUND') refuse('RECOVERY_REQUIRED', '', 'recovery'); negativeAnchors.add(key);
      }
      const index = await this.index(progress);
      const actualIndex = parsePrivateJson(await this.artifacts.read(checkpoint.additionalArtifacts[1]!, 65536), 65536);
      if (!same(index, actualIndex)) refuse('RECOVERY_REQUIRED', '', 'recovery');
      await verify(checkpoint.workspace); if (checkpoint.privateSession) await verify(checkpoint.privateSession, 2097152);
      for (const entry of index.entries) await verify(entry.ref);
      for (const attempt of progress.attempts) {
        await verify(attempt.command, 16384); if (!attempt.finished) continue;
        await verify(attempt.finished.outcome, 1048576); const wrapperKey = attempt.id + '\0' + canonical(attempt.finished.outcome);
        if (attempt.finished.nativeCheckpointId === null || wrappers.has(wrapperKey)) continue;
        const wrapper = record(parsePrivateJson(await this.artifacts.read(attempt.finished.outcome, 1048576), 1048576, 2048), ['version', 'attemptId', 'command', 'roleId', 'nodeId', 'stepId', 'sessionId', 'checkpointId', 'originalManifest', 'manifest', 'workspace', 'session', 'submission', 'journal']);
        const native = before.checkpoints.find(cp => cp.checkpointId === attempt.finished!.nativeCheckpointId), node = this.plan.orderedDAG.find(node => node.id === attempt.nodeId)!;
        if (!native || native.sequence > checkpoint.sequence || !same(attempt.finished.after, { requests: native.counts.requests, operations: native.counts.operations }) || wrapper.version !== 1 || wrapper.attemptId !== attempt.id || wrapper.nodeId !== attempt.nodeId || wrapper.roleId !== node.roleId
          || wrapper.stepId !== attempt.nativeStepId || wrapper.sessionId !== attempt.sessionId || wrapper.checkpointId !== native.checkpointId || !same(wrapper.command, attempt.command)
          || !same(wrapper.workspace, native.workspace) || !same(wrapper.session, native.privateSession)) refuse('RECOVERY_REQUIRED', '', 'recovery');
        const originalRef = checkedRef(wrapper.originalManifest), manifestRef = checkedRef(wrapper.manifest);
        const original = identifyManifest(parsePrivateJson(await this.artifacts.read(originalRef, 32768), 32768)), canonicalManifest = await this.manifest(manifestRef);
        if (!original.ok) refuse('ARTIFACT_INVALID', '', 'recovery'); const originalSubject = bindSubject(this.lock, original.value.manifest);
        if (!originalSubject.ok || !same(originalSubject.value, native.subject) || !same(canonicalManifest, { ...original.value.manifest, metadata: { id: 'candidate' }, spec: { entries: [...original.value.manifest.spec.entries].sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0) } })) refuse('RECOVERY_REQUIRED', '', 'recovery');
        if (wrapper.submission !== null) await verify(checkedRef(wrapper.submission), 1048576);
        const interval = record(wrapper.journal, ['requestIds', 'operationIds']);
        if (!same(interval.requestIds, before.requests.filter(item => item.sequence > attempt.before.requests && item.sequence <= native.counts.requests).map(item => item.admission.requestId))
          || !same(interval.operationIds, before.operations.filter(item => item.sequence > attempt.before.operations && item.sequence <= native.counts.operations).map(item => item.intent.operationId))) refuse('RECOVERY_REQUIRED', '', 'recovery');
        wrappers.add(wrapperKey);
      }
      if (progress.submission) await verify(progress.submission, 1048576);
      head = { checkpoint, ref, progress, index, manifest };
    }
    const after = journal(this.store);
    if (after.view.counts.checkpoints !== before.view.counts.checkpoints || after.view.counts.requests !== before.view.counts.requests || after.view.counts.operations !== before.view.counts.operations) refuse('RECOVERY_REQUIRED', '', 'recovery');
    return head;
  }
  async index(progress: ControllerProgress): Promise<ReceiptIndex> {
    const entries: ReceiptIndex['entries'][number][] = [{ id: 'plan', kind: 'plan', ref: this.planRef }, { id: 'source', kind: 'source', ref: this.sourceRef }];
    for (const attempt of progress.attempts) if (attempt.finished) entries.push({ id: attempt.id, kind: 'role', ref: attempt.finished.outcome });
    for (const item of progress.verifierReceipts) { if (item.output && item.receipt) entries.push({ id: item.slot + '.' + item.generation + '.output', kind: 'verifier-output', ref: item.output }, { id: item.slot + '.' + item.generation + '.receipt', kind: 'verifier-receipt', ref: item.receipt }); }
    for (const row of progress.verifierRefusals) entries.push({ id: row.slot + '.' + row.generation + '.refusal', kind: 'preflight-refusal', ref: row.record });
    if (progress.terminalIntent?.result) entries.push({ id: 'result', kind: 'result', ref: progress.terminalIntent.result });
    if (progress.terminalIntent?.observations) entries.push({ id: 'observations', kind: 'observations', ref: progress.terminalIntent.observations });
    if (entries.length > 2 * this.plan.capacity.J + this.plan.capacity.A + 4 || entries.some(entry => Buffer.byteLength(canonical(entry)) > 768 || Buffer.byteLength(canonical(entry.ref)) > 512)) refuse('OUTPUT_LIMIT', '', 'execution');
    return { version: 1, runId: this.lock.spec.runId, entries };
  }
  async publish(draft: Omit<ControllerProgress, 'sequence' | 'previous' | 'stage'> & { readonly stage: Omit<ControllerProgress['stage'], 'consumed' | 'watermarks'> }, phase: string,
    afterCommit?: (checkpoint: CheckpointRecord) => void): Promise<ProgressHead> {
    const artifacts = this.artifacts, authority = this.authority;
    if (!(artifacts instanceof ArtifactStore) || authority === null) refuse('AUTHORITY_REFUSED', '', 'execution');
    await artifacts.owner.assertCurrent(); stateValue(this.store.renew(authority));
    const known = await this.read(), records = journal(this.store), schedule = phaseSchedule(this.plan.capacity), checkpointId = phaseCheckpointId(this.lock.spec.runId, phase);
    if (!schedule.includes(phase) || phase.endsWith('.native')) refuse('RECOVERY_REQUIRED', '', 'execution');
    const existing = records.checkpoints.find(item => item.checkpointId === checkpointId);
    if (existing) {
      if (!known || known.checkpoint.checkpointId !== checkpointId || !same(known.progress, { ...draft, sequence: known.progress.sequence, previous: known.progress.previous,
        stage: { ...draft.stage, phase, consumed: known.progress.stage.consumed, watermarks: known.progress.stage.watermarks } })) refuse('RECOVERY_REQUIRED', '', 'recovery'); return known;
    }
    const consumed = records.checkpoints.map(cp => schedule.find(item => phaseCheckpointId(this.lock.spec.runId, item) === cp.checkpointId)!);
    const progress = freeze({ ...draft, sequence: records.view.counts.checkpoints + 1, previous: known?.ref ?? null,
      stage: { ...draft.stage, phase, consumed: [...consumed, phase], watermarks: { requests: records.view.counts.requests, operations: records.view.counts.operations } } });
    validateProgress(progress, this.plan, this.lock); extension(known?.progress ?? null, progress, this.plan);
    const manifest = await this.manifest(progress.candidate.manifest), index = await this.index(progress), ref = await artifacts.json('progress', progress, 65536), indexRef = await artifacts.json('index', index, 65536);
    const input = { checkpointId, candidateManifest: manifest, workspace: progress.candidate.workspace, privateSession: progress.candidate.privateSession, additionalArtifacts: [ref, indexRef, this.planRef, this.sourceRef] };
    if (Buffer.byteLength(canonical(input)) + 1024 > 40960) refuse('OUTPUT_LIMIT', '', 'execution');
    const current = stateValue(this.store.inspect());
    if (current.counts.checkpoints !== records.view.counts.checkpoints || current.counts.requests !== records.view.counts.requests || current.counts.operations !== records.view.counts.operations) refuse('RECOVERY_REQUIRED', '', 'recovery');
    const committed = stateValue(this.store.writeCheckpoint(authority, { ...input, expectedRevision: current.revision })).record;
    afterCommit?.(committed);
    return { checkpoint: committed, ref, progress, index, manifest };
  }
  decision(head: ProgressHead | null): 'not_started' | 'safe' | 'adopt_capture' | 'terminal' {
    const records = journal(this.store), view = records.view;
    if (view.clockStatus !== 'trusted' || view.counts.dispatchedRequests || view.counts.unresolvedRequests || view.counts.unresolvedOperations || view.ledger.violations.length) refuse('RECOVERY_REQUIRED', '', 'recovery');
    if (!head) { if (view.counts.requests || view.counts.operations || view.counts.checkpoints) refuse('RECOVERY_REQUIRED', '', 'recovery'); return 'not_started'; }
    if (head.progress.stage.kind.startsWith('terminal')) {
      if (view.counts.requests !== head.progress.stage.watermarks.requests || view.counts.operations !== head.progress.stage.watermarks.operations) refuse('RECOVERY_REQUIRED', '', 'recovery');
      return 'terminal';
    }
    const active = head.progress.attempts.at(-1);
    if (active && active.finished === null) {
      const nativeId = phaseCheckpointId(this.lock.spec.runId, 'role.' + active.ordinal + '.native');
      const captured = records.checkpoints.find(cp => cp.checkpointId === nativeId);
      if (captured) return 'adopt_capture';
      if (view.counts.requests !== active.before.requests || view.counts.operations !== active.before.operations) refuse('RECOVERY_REQUIRED', '', 'recovery');
      return 'safe';
    }
    if (head.progress.stage.kind === 'verifier_pre') {
      const row = head.progress.verifierReceipts.find(item => item.generation === head.progress.candidate.generation && item.receipt === null);
      const additions = records.operations.filter(item => item.sequence > head.progress.stage.watermarks.operations);
      if (row && view.counts.requests === head.progress.stage.watermarks.requests && additions.length <= 1
        && additions.every(item => item.intent.operationId === row.operationId && item.state === 'confirmed' && item.intent.effect === 'read_only')) return 'safe';
    }
    if (view.counts.requests !== head.progress.stage.watermarks.requests || view.counts.operations !== head.progress.stage.watermarks.operations) refuse('RECOVERY_REQUIRED', '', 'recovery');
    return 'safe';
  }
}
