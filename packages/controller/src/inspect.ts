import { reopenLocalRun, type LocalRunStore, type RunView } from '@loopwright/state';
import { decodePiCapture } from '@loopwright/agent-pi';
import { aggregateUsage, digestArtifact, validateDocument, type RequestUsage, type UsageSummary } from '@loopwright/core';
import { result, refuse, type ControllerResult } from './errors.js';
import { readRetained, type RetainedRunInput } from './retained.js';
import { ProgressStore, journal, type ProgressHead } from './progress.js';
import { stateValue, checkedRef } from './storage.js';
import { parsePrivateJson } from './parser.js';
import { freeze, hash, id, list, record, same } from './schema.js';
import { canonicalizeCandidateManifest } from './source.js';
import { formatPolicy } from './repair.js';
import { PublicBundle, type ExportManifest } from './bundle.js';
const isRecord = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
export type CurrentState = Pick<RunView, 'revision' | 'clockStatus' | 'counts' | 'ledger' | 'clock'>;
export interface RunStatus {
  readonly runId: string; readonly source: 'current' | 'retained' | 'unavailable'; readonly stage: string | null; readonly status: string | null;
  readonly currentState: CurrentState | null; readonly checkpoint: string | null; readonly cleanup: 'complete' | 'pending' | 'failed' | null; readonly unavailable: readonly string[];
}
const unavailable = (runId: string): RunStatus => freeze({ runId, source: 'unavailable', stage: null, status: null, currentState: null, checkpoint: null, cleanup: null, unavailable: ['stage', 'status', 'currentState', 'checkpoint', 'cleanup'] });
async function snapshot(input: RetainedRunInput) {
  const retained = await readRetained(input); let store: LocalRunStore | null = null;
  try {
    store = stateValue(reopenLocalRun(retained.descriptor.identity));
    const progress = new ProgressStore(store, null, retained.artifacts, retained.plan, retained.lock, retained.descriptor.plan, retained.descriptor.source);
    const head = await progress.read(), records = journal(store);
    let observed: Record<string, unknown> | null = null, primary: unknown = null;
    if (head?.progress.terminalIntent?.result) primary = parsePrivateJson(await retained.artifacts.read(head.progress.terminalIntent.result, 1048576), 1048576);
    if (head?.progress.terminalIntent?.observations) observed = parsePrivateJson(await retained.artifacts.read(head.progress.terminalIntent.observations, 1048576), 1048576) as Record<string, unknown>;
    const facts = records.view; let valid = facts.clockStatus === 'trusted', decision: ReturnType<typeof progress.decision> | null = null;
    try { decision = progress.decision(head); } catch { valid = false; }
    const status: RunStatus = freeze({ runId: input.runId, source: valid ? 'current' : 'retained', stage: head?.progress.stage.kind ?? 'not_started', status: valid ? head?.progress.terminalIntent?.primary ?? (decision === 'reconcile_required' ? 'reconcile_required' : 'in_progress') : null,
      currentState: { revision: facts.revision, clockStatus: facts.clockStatus, counts: facts.counts, ledger: facts.ledger, clock: facts.clock }, checkpoint: head?.checkpoint.checkpointId ?? null,
      cleanup: observed && ['complete', 'pending', 'failed'].includes(String(observed.cleanup)) ? observed.cleanup as RunStatus['cleanup'] : null,
      unavailable: [...(valid ? [] : ['status']), ...(observed ? [] : ['cleanup'])] });
    return { ...retained, head, records, status, observed, primary };
  } finally { if (store) stateValue(store.close()); }
}
/** Owner-free, credential-free current observation; unavailable facts are explicit data. */
export function readStatus(input: RetainedRunInput) {
  return result(async () => {
    record(input, ['runRoot', 'runId']); const runId = id(input.runId);
    try { return (await snapshot(input)).status; } catch { return unavailable(runId); }
  }, 'inspection');
}
type Snapshot = Awaited<ReturnType<typeof snapshot>>;
async function candidateFiles(saved: Snapshot, head: ProgressHead) {
  if (head.progress.candidate.privateSession === null) {
    const rawSource = parsePrivateJson(await saved.artifacts.read(saved.descriptor.source, 262144), 262144);
    const sourceVersion = isRecord(rawSource) ? rawSource.version : undefined;
    if (sourceVersion === 2) {
      record(rawSource, ['version', 'repository', 'directory', 'baseObject', 'sourceObject', 'baseTree', 'manifest', 'sourceTree', 'entryCount']);
      if (head.manifest.spec.entries.length !== 0 || head.manifest.spec.baseTree === undefined) refuse('ARTIFACT_INVALID', '', 'inspection');
      return [];
    }
    const source = record(rawSource, ['version', 'repository', 'directory', 'baseObject', 'sourceObject', 'manifest', 'entries']);
    const files = []; let total = 0;
    for (const raw of list(source.entries, '', 256)) {
      const entry = record(raw, ['name', 'mode', 'oid', 'ref', 'artifact']), ref = checkedRef(entry.ref), bytes = await saved.artifacts.read(checkedRef(entry.artifact), 4194304), actual = digestArtifact(ref.name, bytes);
      if (!actual.ok || !same(actual.value, ref) || (total += bytes.length) > 4194304) refuse('ARTIFACT_INVALID', '', 'inspection'); files.push({ name: ref.name, bytes });
    }
    if (!same(head.manifest.spec.entries, list(source.entries, '', 256).map(raw => (raw as Record<string, unknown>).ref))) refuse('ARTIFACT_INVALID', '', 'inspection'); return files;
  }
  const attempt = [...head.progress.attempts].reverse().find(item => item.finished?.nativeCheckpointId && same(saved.records.checkpoints.find(cp => cp.checkpointId === item.finished!.nativeCheckpointId)?.workspace, head.progress.candidate.workspace));
  if (!attempt) refuse('EVIDENCE_UNAVAILABLE', '', 'inspection');
  const checkpoint = saved.records.checkpoints.find(cp => cp.checkpointId === attempt.finished!.nativeCheckpointId)!, role = saved.plan.roles.find(role => role.roleId === saved.plan.orderedDAG.find(node => node.id === attempt.nodeId)!.roleId)!;
  const decoded = await decodePiCapture({ version: 1, lock: saved.lock, policy: attempt.repair === 'format' ? formatPolicy(role.policy) : role.policy, checkpoint, sessionId: attempt.sessionId, roleId: role.roleId, stepId: attempt.nativeStepId,
    workspace: { ref: checkpoint.workspace, bytes: await saved.artifacts.read(checkpoint.workspace) }, session: { ref: checkpoint.privateSession!, bytes: await saved.artifacts.read(checkpoint.privateSession!, 67108864) },
    command: attempt.purpose === 'compaction' ? null : { textDigest: hash(await saved.artifacts.read(attempt.command, 1048576)), requestIds: saved.records.requests.filter(row => row.sequence > attempt.before.requests && row.sequence <= attempt.finished!.after.requests).map(row => row.admission.requestId) } });
  if (!decoded.ok || !same(canonicalizeCandidateManifest(decoded.value.candidate), head.manifest)) refuse('ARTIFACT_INVALID', '', 'inspection'); return decoded.value.artifacts;
}
export interface InspectRunInput extends RetainedRunInput { readonly output?: string }
export interface InspectRunValue {
  readonly status: RunStatus;
  readonly manifest: ExportManifest | null;
  readonly usage: UsageSummary | null;
  readonly externalUrl: string | null;
}
export function inspectRun(input: InspectRunInput): Promise<ControllerResult<InspectRunValue>> {
  return result(async (): Promise<InspectRunValue> => {
    const fields = Object.keys(input); record(input, fields); if (fields.some(key => !['runRoot', 'runId', 'output'].includes(key))) refuse('CONFIG_SCHEMA', '', 'inspection');
    const runId = id(input.runId); let saved: Awaited<ReturnType<typeof snapshot>>;
    try { saved = await snapshot(input); } catch { return freeze({ status: unavailable(runId), manifest: null, usage: null, externalUrl: null }); }
    const bundle = new PublicBundle(runId, saved.lock.spec.lockHash), { head, primary, observed } = saved;
    bundle.json('task.lock.json', saved.lock); bundle.json('plan.json', saved.plan);
    if (head) {
      try { const files = await candidateFiles(saved, head); bundle.json('candidate.files.json', { version: 1, manifest: head.manifest, files: files.map(file => ({ name: file.name, encoding: 'base64', body: Buffer.from(file.bytes).toString('base64') })) }); }
      catch { bundle.absent('candidate.files.json'); }
    } else bundle.absent('candidate.files.json');
    const validResult = validateDocument(primary, 'RunResult');
    let usage: UsageSummary | null = null;
    if (validResult.ok && same(validResult.value.spec.subject.lockHash, saved.lock.spec.lockHash)) {
      bundle.json('result.json', validResult.value); bundle.add('result.md', Buffer.from('Run ' + runId + '\nStatus: ' + validResult.value.spec.status + '\n'));
      usage = validResult.value.spec.usage;
    } else {
      bundle.absent('result.json'); bundle.absent('result.md');
      const requestUsages: RequestUsage[] = [];
      for (const row of saved.records.requests) {
        const obs = row.resolution?.kind === 'terminal_usage' ? row.resolution.observation : row.initialObservation;
        if (obs?.usage != null) {
          requestUsages.push(obs.usage);
        } else {
          requestUsages.push({
            requestId: row.admission.requestId,
            inputTokens: { provenance: 'unknown' },
            outputTokens: { provenance: 'unknown' },
            costMicrousd: { provenance: 'unknown' },
          });
        }
      }
      const aggregated = aggregateUsage(requestUsages);
      if (aggregated.ok) usage = aggregated.value;
    }
    if (observed?.verification) bundle.json('verification.json', observed.verification); else bundle.absent('verification.json');
    if (observed?.events) {
      try { bundle.add('events.jsonl', await saved.artifacts.read(checkedRef(observed.events), 4194304)); } catch { bundle.absent('events.jsonl'); }
    } else bundle.absent('events.jsonl');
    bundle.json('usage.json', { version: 1, ledger: saved.records.view.ledger, requests: saved.records.requests.map(row => ({ requestId: row.admission.requestId, state: row.state, usage: (row.resolution?.kind === 'terminal_usage' ? row.resolution.observation : row.initialObservation)?.usage ?? null })), summary: usage });
    bundle.json('checkpoint.manifest.json', { version: 1, runId, lockHash: saved.lock.spec.lockHash, checkpoints: saved.records.checkpoints.map(cp => ({ checkpointId: cp.checkpointId, sequence: cp.sequence, subject: cp.subject, artifacts: cp.additionalArtifacts })) });
    for (const name of ['review.json', 'memory.json']) bundle.absent(name, 'outside_scope', 'not_run');
    let externalUrl: string | null = null;
    const publication = head?.progress.publication, externalWrite = saved.records.operations.find(item => item.intent.effect === 'external_write');
    const journalReceipt = externalWrite && externalWrite.state === 'confirmed' ? externalWrite.reconciliation ?? externalWrite.initialReceipt : null;
    let publicationPayload: { readonly status: string; readonly operationId: string | null; readonly receipt: unknown } | null = null;
    if (externalWrite && journalReceipt) {
      publicationPayload = { status: journalReceipt.outcome === 'succeeded' ? 'confirmed' : 'failed', operationId: externalWrite.intent.operationId, receipt: journalReceipt };
    } else if (publication && publication.receipt !== null && ['confirmed', 'failed'].includes(publication.status)) {
      try {
        const parsedReceipt = parsePrivateJson(await saved.artifacts.read(publication.receipt, 65536), 65536);
        publicationPayload = { status: publication.status, operationId: publication.operationId, receipt: parsedReceipt };
      } catch {
        publicationPayload = null;
      }
    }
    if (publicationPayload) {
      const receiptRecord = isRecord(publicationPayload.receipt) ? publicationPayload.receipt : null;
      const evidenceRecord = receiptRecord && isRecord(receiptRecord.evidence) ? receiptRecord.evidence : null;
      if (publicationPayload.status === 'confirmed' && evidenceRecord && evidenceRecord.artifact !== undefined) {
        try {
          const rawArtifact = await saved.artifacts.read(checkedRef(evidenceRecord.artifact), 65536);
          const parsedArtifact = parsePrivateJson(Buffer.from(rawArtifact), 65536);
          if (isRecord(parsedArtifact) && typeof parsedArtifact.responseBytes === 'string') {
            const parsedResponse = parsePrivateJson(Buffer.from(parsedArtifact.responseBytes, 'base64'), 65536);
            if (isRecord(parsedResponse) && typeof parsedResponse.externalUrl === 'string' && parsedResponse.externalUrl.length > 0 && parsedResponse.externalUrl.length <= 512) {
              try {
                const parsedUrl = new URL(parsedResponse.externalUrl);
                if (parsedUrl.protocol === 'https:' && parsedUrl.username === '' && parsedUrl.password === '') {
                  externalUrl = parsedResponse.externalUrl;
                }
              } catch {
                externalUrl = null;
              }
            }
          }
        } catch {
          externalUrl = null;
        }
      }
      try { bundle.json('publication.json', { version: 1, runId, lockHash: saved.lock.spec.lockHash, status: publicationPayload.status, operationId: publicationPayload.operationId, receipt: publicationPayload.receipt, externalUrl }); }
      catch { bundle.absent('publication.json'); }
    } else if (publication && publication.receipt !== null && ['confirmed', 'failed'].includes(publication.status)) {
      bundle.absent('publication.json');
    } else bundle.absent('publication.json', saved.plan.publication.mode === 'disabled' ? 'disabled' : 'ineligible', 'not_run');
    if (input.output !== undefined) await bundle.write(input.output, saved.directory);
    return freeze({ status: saved.status, manifest: bundle.manifest(), usage, externalUrl });
  }, 'inspection');
}
