import { existsSync } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { digestArtifact, identifyManifest, validateDocument, type ArtifactRef, type Digest, type Evidence, type RunResult, type TaskLock } from '@loopwright/core';
import type { ControllerIncident } from '@loopwright/controller';
import { canonical, fail, hashDomain, incidentReferenceDigest, MemoryDiagnosticError, memoryProposalSchema, syntheticIncidentArtifact, unifiedFileDiff } from './schema.js';
import { computeCodeFingerprint, loadMemoryStore, memoryDirectoryFor, projectMemoryStore } from './store.js';
import type { MemoryBudgetLedger, MemoryCuratorRequest, MemoryEntry, MemoryEvidenceRef, MemoryFinalizerInput, MemoryFinalizerOutcome, MemoryOperation, MemoryProposal, SettledCycleContext } from './types.js';

const PROOF_FILE_LIMIT = 256;
const ARTIFACT_BYTES_LIMIT = 8_388_608;
const FACT_STATUSES = ['completed', 'no_change'] as const;
const OBSERVATION_STATUSES = ['failed', 'blocked', 'exhausted', 'expired', 'cancelled', 'reconcile_required'] as const;
const INCIDENT_EVIDENCE_ID = 'evidence.incident';
const INCIDENT_CHECK_ID = 'incident';

type Inventory = Map<string, { readonly byteLength: number; readonly digest: Digest }>;
function addInventory(inventory: Inventory, reference: ArtifactRef): void {
  if (!inventory.has(reference.name)) inventory.set(reference.name, { byteLength: reference.byteLength, digest: reference.digest });
}
interface RetainedArtifact { readonly reference: ArtifactRef; readonly bytes: Uint8Array }
async function readArtifactFile(directory: string, name: string): Promise<RetainedArtifact> {
  const path = join(directory, name);
  const bytes = await readFile(path);
  if (bytes.byteLength > ARTIFACT_BYTES_LIMIT) fail('MEMORY_SCHEMA_INVALID', path, 'retained artifact exceeds the byte bound');
  const digest = digestArtifact(name, bytes);
  if (!digest.ok) fail('MEMORY_SCHEMA_INVALID', path, 'retained artifact digest refused');
  return { reference: digest.value, bytes };
}
async function findArtifacts(directory: string, prefix: string): Promise<readonly RetainedArtifact[]> {
  const names = (await readdir(directory)).filter(name => name.startsWith(prefix) && name.endsWith('.bin')).sort();
  return Promise.all(names.map(name => readArtifactFile(directory, name)));
}
function evidenceFromProofs(proof: unknown): Evidence | null {
  if (proof === null || typeof proof !== 'object') return null;
  const candidate = (proof as Readonly<Record<string, unknown>>)['evidence'];
  const document = validateDocument(candidate, 'Evidence');
  return document.ok ? document.value : null;
}
async function resolveSettlement(context: SettledCycleContext): Promise<{
  readonly repository: string; readonly lock: TaskLock; readonly result: RunResult | null; readonly incident: ControllerIncident | null;
  readonly ledger: MemoryBudgetLedger; readonly candidateManifest: readonly ArtifactRef[]; readonly evidence: readonly Evidence[];
  readonly inventory: Inventory;
}> {
  if (context.kind === 'summary') {
    const summary = context.summary;
    const inventory: Inventory = new Map();
    for (const reference of [...summary.candidateManifest, ...summary.artifacts]) addInventory(inventory, reference);
    for (const document of summary.evidence) for (const reference of document.spec.artifacts) addInventory(inventory, reference);
    if (summary.incident !== null) addInventory(inventory, summary.incident.knownReferences[0] ?? syntheticIncidentArtifact(summary.incident));
    return { repository: context.repository, lock: summary.lock, result: summary.result, incident: summary.incident,
      ledger: summary.ledger, candidateManifest: summary.candidateManifest, evidence: summary.evidence, inventory };
  }
  const root = resolve(context.runRoot), directory = join(root, context.runId);
  const runJson = await readFile(join(directory, 'run.json'), 'utf8');
  const descriptor = JSON.parse(runJson) as { readonly identity?: { readonly lock?: unknown } };
  const lock = validateDocument(descriptor.identity?.lock, 'TaskLock');
  if (!lock.ok) fail('MEMORY_SCHEMA_INVALID', 'run.json/identity/lock', 'retained run descriptor carries no valid TaskLock');
  const artifacts = join(directory, 'artifacts');
  const results = await findArtifacts(artifacts, 'result-');
  if (results.length !== 1) fail('MEMORY_SCHEMA_INVALID', 'artifacts/result', `expected exactly one retained result artifact, found ${results.length}`);
  const result = validateDocument(JSON.parse(Buffer.from(results[0]!.bytes).toString('utf8')), 'RunResult');
  if (!result.ok) fail('MEMORY_SCHEMA_INVALID', 'artifacts/result', 'retained result artifact is not a RunResult');
  let candidateManifest: readonly ArtifactRef[] = [];
  for (const retained of await findArtifacts(artifacts, 'manifest-')) {
    const identified = identifyManifest(retained.bytes);
    if (identified.ok && identified.value.digest.hex === result.value.spec.subject.candidateDigest.hex) candidateManifest = identified.value.manifest.spec.entries;
  }
  const inventory: Inventory = new Map();
  addInventory(inventory, results[0]!.reference);
  for (const reference of candidateManifest) addInventory(inventory, reference);
  for (const retained of await findArtifacts(artifacts, 'observations-')) addInventory(inventory, retained.reference);
  const evidence: Evidence[] = [];
  const proofFiles = (await readdir(directory, { withFileTypes: true, recursive: true })).filter(entry => entry.isFile() && entry.name.endsWith('.proof.json'));
  for (const entry of proofFiles.slice(0, PROOF_FILE_LIMIT)) {
    const proof = JSON.parse(await readFile(join(entry.parentPath, entry.name), 'utf8')) as unknown;
    const document = evidenceFromProofs(proof);
    if (document !== null) { evidence.push(document); for (const reference of document.spec.artifacts) addInventory(inventory, reference); }
  }
  const ledger = context.ledger ?? { revision: 0, remainingTokens: 0, remainingModelCalls: 0, remainingWallMs: 0 };
  return { repository: context.repository, lock: lock.value, result: result.value, incident: null, ledger, candidateManifest, evidence, inventory };
}
function evidenceRefFor(row: { readonly checkId: string; readonly status: string; readonly evidenceId: string | null }, evidence: readonly Evidence[]): MemoryEvidenceRef | null {
  const document = row.evidenceId === null ? undefined : evidence.find(candidate => candidate.metadata.id === row.evidenceId);
  if (!document) return null;
  const artifact = document.spec.artifacts[0];
  if (!artifact) return null;
  return { evidenceId: document.metadata.id, checkId: row.checkId, level: document.spec.level, observedStatus: row.status as MemoryEvidenceRef['observedStatus'], artifact };
}
function boundedClaim(text: string): string {
  const bytes = Buffer.from(text, 'utf8');
  if (bytes.byteLength <= 2048) return text;
  let cut = 2048;
  while (cut > 0 && (bytes[cut]! & 0xC0) === 0x80) cut--;
  return bytes.subarray(0, cut).toString('utf8');
}
/**
 * Settled-outcome memory finalizer. Treats the primary RunResult/VerificationResult as frozen inputs,
 * never invokes the curator without remaining budget, and confines every fault to the outcome.
 */
export async function finalizeRunMemory(input: MemoryFinalizerInput): Promise<MemoryFinalizerOutcome> {
  try {
    const { config } = input;
    const settled = await resolveSettlement(input.context);
    const contract = settled.lock.spec.contract, runId = settled.lock.spec.runId;
    const fingerprint = await computeCodeFingerprint(settled.repository, contract.spec.scope.writable);
    const candidateDigest = settled.result !== null ? settled.result.spec.subject.candidateDigest : settled.incident === null ? null : incidentReferenceDigest(settled.incident);
    if (candidateDigest === null) fail('MEMORY_SCHEMA_INVALID', '/context', 'settled context carries neither a result nor an incident');
    const loaded = await loadMemoryStore(settled.repository, config.taskpack, contract.spec.target.repository);
    const baseRevision = contract.spec.target.baseRevision;
    const validity = { baseRevision, sourceRevision: contract.spec.target.sourceRevision, codeFingerprint: fingerprint, upstreamVersions: config.upstreamVersions };
    const sourceRef = { runId, lockHash: settled.lock.spec.lockHash, candidateDigest };
    const sourceDigest = hashDomain('memory-source', sourceRef);
    const boundedToken = (raw: string): string => {
      const sanitized = raw.toLowerCase().replace(/[^a-z0-9._-]/g, '-');
      if (sanitized.length <= 40) return sanitized;
      return `${sanitized.slice(0, 24)}-${hashDomain('memory-run-token-v1', raw).hex.slice(0, 12)}`;
    };
    const runToken = boundedToken(runId);
    const priorSameClaim = (claimKey: string): readonly string[] =>
      [...new Set(loaded.index.entries.filter(candidate => candidate.claimKey === claimKey).map(candidate => candidate.id))].sort();
    const buildEntry = (id: string, claimKey: string, claim: string, kind: MemoryEntry['kind'], refs: readonly MemoryEvidenceRef[]): MemoryEntry =>
      ({ version: 1, id, claimKey, claim: boundedClaim(claim), kind, scope: { taskpack: config.taskpack, repository: contract.spec.target.repository,
        paths: [...contract.spec.scope.writable], targetMatrix: null }, sourceRef, sourceDigest, verifiedAtMs: config.nowMs,
        validFor: validity, expiresAtMs: config.nowMs + config.ttlMs, supersedes: priorSameClaim(claimKey), evidenceRefs: refs });
    const deterministicEntries: MemoryEntry[] = [];
    const rows = settled.result === null ? [] : [...settled.result.spec.verification.spec.required, ...settled.result.spec.verification.spec.optional];
    if (settled.result !== null && FACT_STATUSES.includes(settled.result.spec.status as (typeof FACT_STATUSES)[number])) {
      for (const row of rows.filter(row => row.status === 'passed')) {
        const reference = evidenceRefFor(row, settled.evidence);
        if (reference === null) continue;
        deterministicEntries.push(buildEntry(`entry.${runToken}.check.${boundedToken(row.checkId)}`, `claim.check.${row.checkId}`,
          `Check ${row.checkId} passed on run ${runId} with ${reference.level} evidence.`, 'fact', [reference]));
      }
    } else if (settled.result !== null && OBSERVATION_STATUSES.includes(settled.result.spec.status as (typeof OBSERVATION_STATUSES)[number])) {
      for (const row of rows.filter(row => row.status !== 'passed')) {
        const reference = evidenceRefFor(row, settled.evidence);
        if (reference === null) continue;
        deterministicEntries.push(buildEntry(`entry.${runToken}.check.${boundedToken(row.checkId)}`, `claim.check.${row.checkId}`,
          `Check ${row.checkId} ended ${row.status} on run ${runId} (${row.reason}${row.detail === null ? '' : `: ${row.detail}`}).`,
          'failure_observation', [reference]));
      }
    }
    if (settled.result === null && settled.incident !== null) {
      const incident = settled.incident, artifact = incident.knownReferences[0] ?? syntheticIncidentArtifact(incident);
      deterministicEntries.push(buildEntry(`entry.${runToken}.incident`, `claim.incident.${runId}`,
        `Run ${runId} settled as incident ${incident.code} at stage ${incident.stage}; cleanup ${incident.cleanup}.`,
        'failure_observation', [{ evidenceId: INCIDENT_EVIDENCE_ID, checkId: INCIDENT_CHECK_ID, level: 'local_execution', observedStatus: 'not_run', artifact }]));
    }
    const status = settled.result !== null ? settled.result.spec.status : 'reconcile_required';
    const budgetBlocked = ['exhausted', 'expired', 'cancelled', 'reconcile_required'].includes(status)
      || settled.ledger.remainingTokens <= 0 || settled.ledger.remainingModelCalls <= 0 || settled.ledger.remainingWallMs <= 0;
    const curator = config.curator ?? null;
    let operations: readonly MemoryOperation[] = deterministicEntries.map(entry => ({ kind: 'upsert' as const, entry }));
    let outcomeStatus: MemoryFinalizerOutcome['status'] = 'proposed';
    let reason: string | null = null;
    const proposalIdBase = `${runId}.${loaded.index.storeDigest.hex.slice(0, 24)}`;
    const assemble = (operations: readonly MemoryOperation[], proposalId: string): MemoryProposal => memoryProposalSchema({ version: 1, proposalId: `proposal.${proposalId}`,
      taskpack: config.taskpack, repository: contract.spec.target.repository, baseRevision, baseStoreDigest: loaded.index.storeDigest,
      createdAtMs: config.nowMs, runId, lockHash: settled.lock.spec.lockHash, operations }, '/proposal');
    if (curator === null || budgetBlocked) {
      if (config.requireCuratorReview === true) { outcomeStatus = 'pending'; reason = 'no_model_budget_deterministic_only'; }
    } else {
      const request: MemoryCuratorRequest = { lock: settled.lock, result: settled.result, incident: settled.incident,
        verification: settled.result?.spec.verification ?? null, candidateManifest: settled.candidateManifest, store: loaded.index,
        deterministicEntries, nowMs: config.nowMs, ttlMs: config.ttlMs, upstreamVersions: config.upstreamVersions };
      const timeoutMs = typeof config.curatorTimeoutMs === 'number' && Number.isFinite(config.curatorTimeoutMs) && config.curatorTimeoutMs > 0
        ? config.curatorTimeoutMs
        : Math.min(5000, Math.max(1, settled.ledger.remainingWallMs));
      let timer: NodeJS.Timeout | undefined;
      try {
        const curated = await Promise.race([
          curator.curate(request),
          new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('timeout')), timeoutMs); }),
        ]);
        operations = assemble(curated, proposalIdBase).operations;
      } catch (error) {
        return { status: 'unavailable', reason: `curator_fault: ${error instanceof Error ? error.message.slice(0, 256) : 'unknown fault'}`,
          deterministicEntries, proposal: null, proposalDigest: null, patch: null };
      } finally {
        if (timer !== undefined) clearTimeout(timer);
      }
    }
    const proposal = assemble(operations, proposalIdBase);
    const directory = memoryDirectoryFor(config.taskpack);
    const projected = projectMemoryStore(loaded.index, operations, config.nowMs, proposal.proposalId);
    const changed: { readonly path: string; readonly before: string | null; readonly after: string }[] = [];
    const indexBefore = canonical(loaded.index), indexAfter = canonical(projected.index);
    if (indexBefore !== indexAfter) {
      const indexExisted = existsSync(join(resolve(settled.repository), directory, 'index.json'));
      changed.push({ path: `${directory}/index.json`, before: indexExisted ? indexBefore : null, after: indexAfter });
    }
    for (const [id, bytes] of projected.entryFiles) {
      const after = Buffer.from(bytes).toString('utf8');
      const beforeBytes = loaded.entryFiles.get(id);
      const before = beforeBytes === undefined ? null : Buffer.from(beforeBytes).toString('utf8');
      if (before !== after) changed.push({ path: `${directory}/entries/${id}.md`, before, after });
    }
    changed.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
    const patch = changed.map(file => unifiedFileDiff(file.path, file.before, file.after)).join('');
    return { status: outcomeStatus, reason, deterministicEntries, proposal, proposalDigest: hashDomain('memory-proposal', proposal), patch };
  } catch (error) {
    const detail = error instanceof MemoryDiagnosticError ? `${error.code} at ${error.path}: ${error.detail}` : error instanceof Error ? error.message : 'unknown fault';
    return { status: 'unavailable', reason: `finalizer_fault: ${detail.slice(0, 256)}`, deterministicEntries: [], proposal: null, proposalDigest: null, patch: null };
  }
}
