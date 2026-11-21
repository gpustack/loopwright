import { lstat } from 'node:fs/promises';
import { join } from 'node:path';
import { reopenLocalRun, type LocalRunStore, type RunView } from '@loopwright/state';
import { aggregateUsage, digestArtifact, validateDocument, type ArtifactManifest, type RequestUsage, type UsageSummary } from '@loopwright/core';
import { result, refuse, type ControllerResult } from './errors.js';
import { readRetained, type RetainedRunInput } from './retained.js';
import { ProgressStore, journal, type ProgressHead } from './progress.js';
import { decodeCandidateCapture } from './capture.js';
import { countDelegatedBudgets } from './budget-observations.js';
import { parseSourceTree } from './source.js';
import { resolveCanonicalCasBlobPath, stateValue, checkedRef, streamVerifiedCasBlob } from './storage.js';
import { parsePrivateJson } from './parser.js';
import { freeze, id, isRecord, list, record, same, text } from './schema.js';
import { PublicBundle, type ExportManifest } from './bundle.js';
import type { RawCandidateFile } from './types.js';

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
    const delegated = head ? countDelegatedBudgets(retained.plan, head.progress.attempts) : { modelCalls: 0, formatRepairs: 0, implementationRepairs: 0 };
    const effectiveLedger = {
      ...facts.ledger,
      admittedCalls: facts.ledger.admittedCalls + delegated.modelCalls,
      formatRepairs: facts.ledger.formatRepairs + delegated.formatRepairs,
      implementationRepairs: facts.ledger.implementationRepairs + delegated.implementationRepairs,
    };
    const status: RunStatus = freeze({ runId: input.runId, source: valid ? 'current' : 'retained', stage: head?.progress.stage.kind ?? 'not_started', status: valid ? head?.progress.terminalIntent?.primary ?? (decision === 'reconcile_required' ? 'reconcile_required' : 'in_progress') : null,
      currentState: { revision: facts.revision, clockStatus: facts.clockStatus, counts: facts.counts, ledger: effectiveLedger, clock: facts.clock }, checkpoint: head?.checkpoint.checkpointId ?? null,
      cleanup: observed && ['complete', 'pending', 'failed'].includes(String(observed.cleanup)) ? observed.cleanup as RunStatus['cleanup'] : null,
      unavailable: [...(valid ? [] : ['status']), ...(observed ? [] : ['cleanup'])] });
    return { ...retained, head, records, status, observed, primary, effectiveLedger };
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

interface ExportedCandidateFileV2 {
  readonly name: string;
  readonly mode: '100644' | '100755';
  readonly sha256: string;
  readonly byteLength: number;
  readonly uri: string;
  readonly blobPath: string;
}

type CandidateFilesDocument =
  | {
      readonly version: 2;
      readonly manifest: ArtifactManifest;
      readonly files: readonly ExportedCandidateFileV2[];
    }
  | {
      readonly version: 1;
      readonly manifest: ArtifactManifest;
      readonly files: readonly { readonly name: string; readonly encoding: 'base64'; readonly body: string }[];
    };

async function readBaselineModes(saved: Snapshot): Promise<Map<string, '100644' | '100755'>> {
  const modes = new Map<string, '100644' | '100755'>();
  const rawSource = parsePrivateJson(await saved.artifacts.read(saved.descriptor.source, 262_144), 262_144);
  const sourceVersion = isRecord(rawSource) ? rawSource.version : undefined;
  if (sourceVersion === 2) {
    const src = record(rawSource, ['version', 'repository', 'directory', 'baseObject', 'sourceObject', 'baseTree', 'manifest', 'sourceTree', 'entryCount']);
    const baseTree = record(src.baseTree, ['objectFormat', 'commitOid', 'treeOid']);
    const objectFormat = baseTree.objectFormat === 'sha256' ? 'sha256' : 'sha1';
    const treeBytes = await saved.artifacts.read(checkedRef(src.sourceTree), 8_388_608);
    for (const entry of parseSourceTree(treeBytes, objectFormat, 'recovery')) {
      modes.set(entry.name, entry.mode);
    }
    return modes;
  }
  const src = record(rawSource, ['version', 'repository', 'directory', 'baseObject', 'sourceObject', 'manifest', 'entries']);
  for (const rawEntry of list(src.entries, '', 256)) {
    const entry = record(rawEntry, ['name', 'mode', 'oid', 'ref', 'artifact']);
    const mode = text(entry.mode);
    if (mode === '100644' || mode === '100755') {
      modes.set(text(entry.name), mode);
    }
  }
  return modes;
}

async function verifyAndBuildV2Files(
  artifactsDir: string,
  manifest: ArtifactManifest,
  baselineModes: ReadonlyMap<string, '100644' | '100755'>,
  overlayModes: ReadonlyMap<string, '100644' | '100755'>,
): Promise<readonly ExportedCandidateFileV2[]> {
  const out: ExportedCandidateFileV2[] = [];
  for (const entry of manifest.spec.entries) {
    const sha256 = entry.digest.hex;
    const uri = 'cas://sha256/' + sha256;
    const blobPath = await resolveCanonicalCasBlobPath(artifactsDir, sha256, undefined, 'inspection');
    await streamVerifiedCasBlob(
      artifactsDir,
      {
        name: entry.name,
        sha256,
        byteLength: entry.byteLength,
        uri,
        path: blobPath,
      },
      undefined,
      'inspection',
    );
    const mode = overlayModes.get(entry.name) ?? baselineModes.get(entry.name) ?? '100644';
    out.push({
      name: entry.name,
      mode,
      sha256,
      byteLength: entry.byteLength,
      uri,
      blobPath,
    });
  }
  return out;
}

async function hasCasSha256Dir(artifactsDir: string): Promise<boolean> {
  try {
    const st = await lstat(join(artifactsDir, 'blobs', 'sha256'));
    if (st.isSymbolicLink() || !st.isDirectory()) refuse('ARTIFACT_INVALID', '', 'inspection');
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

async function candidateFilesDocument(saved: Snapshot, head: ProgressHead): Promise<CandidateFilesDocument> {
  const artifactsDir = join(saved.directory, 'artifacts');
  const baselineModes = await readBaselineModes(saved);

  if (same(head.progress.candidate.workspace, saved.descriptor.sourceWorkspace)) {
    const rawSource = parsePrivateJson(await saved.artifacts.read(saved.descriptor.source, 262144), 262144);
    const sourceVersion = isRecord(rawSource) ? rawSource.version : undefined;
    if (sourceVersion === 2) {
      record(rawSource, ['version', 'repository', 'directory', 'baseObject', 'sourceObject', 'baseTree', 'manifest', 'sourceTree', 'entryCount']);
      if (head.manifest.spec.entries.length !== 0 || head.manifest.spec.baseTree === undefined) refuse('ARTIFACT_INVALID', '', 'inspection');
      return { version: 2, manifest: head.manifest, files: [] };
    }
    const source = record(rawSource, ['version', 'repository', 'directory', 'baseObject', 'sourceObject', 'manifest', 'entries']);
    const files: RawCandidateFile[] = [];
    let total = 0;
    for (const raw of list(source.entries, '', 256)) {
      const entry = record(raw, ['name', 'mode', 'oid', 'ref', 'artifact']), ref = checkedRef(entry.ref), bytes = await saved.artifacts.read(checkedRef(entry.artifact), 4194304), actual = digestArtifact(ref.name, bytes);
      if (!actual.ok || !same(actual.value, ref) || (total += bytes.length) > 4194304) refuse('ARTIFACT_INVALID', '', 'inspection');
      files.push({ name: ref.name, bytes });
    }
    if (!same(head.manifest.spec.entries, list(source.entries, '', 256).map(raw => (raw as Record<string, unknown>).ref))) {
      refuse('ARTIFACT_INVALID', '', 'inspection');
    }
    if (files.length === 0 || await hasCasSha256Dir(artifactsDir)) {
      const v2Files = await verifyAndBuildV2Files(artifactsDir, head.manifest, baselineModes, new Map());
      return { version: 2, manifest: head.manifest, files: v2Files };
    }
    return {
      version: 1,
      manifest: head.manifest,
      files: files.map(file => ({ name: file.name, encoding: 'base64', body: Buffer.from(file.bytes).toString('base64') })),
    };
  }

  const attempt = [...head.progress.attempts].reverse().find(item => item.finished?.nativeCheckpointId && same(saved.records.checkpoints.find(cp => cp.checkpointId === item.finished!.nativeCheckpointId)?.workspace, head.progress.candidate.workspace));
  if (!attempt) refuse('EVIDENCE_UNAVAILABLE', '', 'inspection');
  const checkpoint = saved.records.checkpoints.find(cp => cp.checkpointId === attempt.finished!.nativeCheckpointId)!;
  const decoded = await decodeCandidateCapture({
    artifacts: saved.artifacts,
    artifactsDirectory: artifactsDir,
    lock: saved.lock,
    plan: saved.plan,
    checkpoint,
    attempt,
    expectedManifest: head.manifest,
    requestIds: saved.records.requests.filter(row => row.sequence > attempt.before.requests && row.sequence <= attempt.finished!.after.requests).map(row => row.admission.requestId),
    phase: 'inspection',
  });

  const overlayModes = new Map<string, '100644' | '100755'>();
  if (decoded.delegatedPayload) {
    for (const item of decoded.delegatedPayload.overlay) {
      overlayModes.set(item.name, item.mode);
    }
  }
  for (const item of decoded.artifacts) {
    if (!('bytes' in item) && item.mode !== undefined) {
      overlayModes.set(item.name, item.mode);
    }
  }

  const isExplicitV2 = decoded.delegatedPayload?.version === 2 || decoded.artifacts.some(item => 'blobPath' in item);
  const isEmptyNonLegacyV1 = head.manifest.spec.entries.length === 0 && decoded.delegatedPayload?.version !== 1;
  if (isExplicitV2 || isEmptyNonLegacyV1) {
    const v2Files = await verifyAndBuildV2Files(artifactsDir, head.manifest, baselineModes, overlayModes);
    return { version: 2, manifest: head.manifest, files: v2Files };
  }

  // Legacy v1 capture (`delegated-capture.v1` or synthetic Pi `chunk` snapshot):
  // If CAS blobs exist for every entry on disk, verify and emit v2; if any entry lacks a CAS blob, emit v1 fallback.
  if (await hasCasSha256Dir(artifactsDir)) {
    let allCasBlobsPresent = head.manifest.spec.entries.length > 0;
    for (const entry of head.manifest.spec.entries) {
      const exists = await lstat(join(artifactsDir, 'blobs', 'sha256', entry.digest.hex)).then(() => true, () => false);
      if (!exists) {
        allCasBlobsPresent = false;
        break;
      }
    }
    if (allCasBlobsPresent) {
      const v2Files = await verifyAndBuildV2Files(artifactsDir, head.manifest, baselineModes, overlayModes);
      return { version: 2, manifest: head.manifest, files: v2Files };
    }
  }

  return {
    version: 1,
    manifest: head.manifest,
    files: decoded.artifacts.map(file => {
      if (!('bytes' in file)) refuse('ARTIFACT_INVALID', '', 'inspection');
      return { name: file.name, encoding: 'base64' as const, body: Buffer.from(file.bytes).toString('base64') };
    }),
  };
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
      try { bundle.json('candidate.files.json', await candidateFilesDocument(saved, head)); }
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
    bundle.json('usage.json', { version: 1, ledger: saved.effectiveLedger, requests: saved.records.requests.map(row => ({ requestId: row.admission.requestId, state: row.state, usage: (row.resolution?.kind === 'terminal_usage' ? row.resolution.observation : row.initialObservation)?.usage ?? null })), summary: usage });
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
