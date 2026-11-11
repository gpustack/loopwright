import { constants, existsSync } from 'node:fs';
import { createHash, randomBytes } from 'node:crypto';
import { mkdir, open, readFile, rename, unlink } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { canonical, digestEqual, unifiedFileDiff } from './schema.js';
import { entryFileBytes, loadMemoryStore, memoryDirectoryFor, projectMemoryStore } from './store.js';
import { verifyMemoryProposal } from './verifier.js';
import type { MemoryCASInput, MemoryCASRefusal, MemoryCASResult, MemoryDiagnostic, MemoryModifiedFile, MemoryProposal, SeparateMemoryPullRequestSpec } from './types.js';

const LOCK_NAME = '.cas.lock';

function refusal(code: MemoryCASRefusal['code'], diagnostics: readonly MemoryDiagnostic[], storeDigestBefore: { algorithm: 'sha256'; hex: string }): MemoryCASResult {
  return { applied: false, rebased: false, refusal: { code, diagnostics }, storeDigestBefore, storeDigestAfter: null, pullRequest: null };
}
function casConflict(path: string, detail: string): readonly MemoryDiagnostic[] {
  return [{ code: 'MEMORY_CAS_CONFLICT', path, detail }];
}
function buildPatch(directory: string, before: ReadonlyMap<string, Uint8Array>, after: ReadonlyMap<string, Uint8Array>,
  indexBefore: string | null, indexAfter: string): { patch: string; files: readonly MemoryModifiedFile[] } {
  const changed: { path: string; before: string | null; after: string }[] = [];
  for (const [id, bytes] of after) {
    const afterText = Buffer.from(bytes).toString('utf8');
    const previous = before.get(id);
    const beforeText = previous === undefined ? null : Buffer.from(previous).toString('utf8');
    if (beforeText !== afterText) changed.push({ path: `${directory}/entries/${id}.md`, before: beforeText, after: afterText });
  }
  changed.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  if (indexBefore !== indexAfter) changed.push({ path: `${directory}/index.json`, before: indexBefore, after: indexAfter });
  const files = changed.map(file => ({ path: file.path, content: file.after, sha256: createHash('sha256').update(file.after, 'utf8').digest('hex') }));
  return { patch: changed.map(file => unifiedFileDiff(file.path, file.before, file.after)).join(''), files };
}
async function stageFile(target: string, bytes: Uint8Array, nonce: string): Promise<string> {
  const temporary = `${target}.tmp-${process.pid}-${nonce}`;
  const handle = await open(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
  try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
  return temporary;
}
function touchedBy(proposal: MemoryProposal): { readonly ids: ReadonlySet<string>; readonly claimKeys: ReadonlySet<string> } {
  const ids = new Set<string>(), claimKeys = new Set<string>();
  for (const operation of proposal.operations) {
    if (operation.kind === 'upsert') { ids.add(operation.entry.id); claimKeys.add(operation.entry.claimKey); for (const id of operation.entry.supersedes) ids.add(id); }
    else ids.add(operation.entryId);
  }
  return { ids, claimKeys };
}
function deltaOf(base: { entries: readonly { id: string; claimKey: string }[]; retired: readonly { entry: { id: string; claimKey: string } }[] }, current: { entries: readonly { id: string; claimKey: string }[]; retired: readonly { entry: { id: string; claimKey: string } }[] }): { readonly ids: ReadonlySet<string>; readonly claimKeys: ReadonlySet<string> } {
  const baseById = new Map(base.entries.map(entry => [entry.id, canonical(entry)]));
  const currentById = new Map(current.entries.map(entry => [entry.id, entry]));
  const ids = new Set<string>(), claimKeys = new Set<string>();
  for (const [id, currentEntry] of currentById) {
    const baseEntry = baseById.get(id);
    if (baseEntry === undefined || baseEntry !== canonical(currentEntry)) { ids.add(id); claimKeys.add(currentEntry.claimKey); }
  }
  for (const [id, baseEntry] of baseById) {
    if (!currentById.has(id)) {
      const parsed = JSON.parse(baseEntry) as { claimKey: string };
      ids.add(id);
      claimKeys.add(parsed.claimKey);
    }
  }
  const baseRetiredIds = new Set(base.retired.map(row => row.entry.id));
  for (const row of current.retired) {
    if (baseRetiredIds.has(row.entry.id)) continue;
    ids.add(row.entry.id);
    claimKeys.add(row.entry.claimKey);
  }
  return { ids, claimKeys };
}
function overlaps(delta: { ids: ReadonlySet<string>; claimKeys: ReadonlySet<string> }, touched: { ids: ReadonlySet<string>; claimKeys: ReadonlySet<string> }): boolean {
  for (const id of touched.ids) if (delta.ids.has(id)) return true;
  for (const claimKey of touched.claimKeys) if (delta.claimKeys.has(claimKey)) return true;
  return false;
}
async function verifyAgainst(input: MemoryCASInput, proposal: MemoryProposal, patch: string, store: Awaited<ReturnType<typeof loadMemoryStore>>['index']) {
  return verifyMemoryProposal({ proposal, store, lock: input.lock, result: input.result, incident: input.incident, evidence: input.evidence,
    artifacts: input.artifacts, candidateDigest: input.candidateDigest, patch, secretValues: input.secretValues,
    memoryWritable: input.memoryWritable, protectedPaths: input.protectedPaths });
}
/**
 * Applies a verified proposal under an exclusive lockfile with optimistic compare-and-swap. All files are
 * staged as `0o600` temporaries, renamed into place with entry files first, and rolled back from recorded
 * prior bytes when any step fails. Any refusal performs zero writes to `index.json` or `entries/`.
 */
export async function applyMemoryProposalCAS(input: MemoryCASInput): Promise<MemoryCASResult> {
  const repository = resolve(input.repository);
  const loaded = await loadMemoryStore(input.repository, input.taskpack, input.proposal.repository);
  const directory = memoryDirectoryFor(input.taskpack);
  const storeDigestBefore = loaded.index.storeDigest;
  if (existsSync(join(repository, '.loopwright', 'memory', input.taskpack, LOCK_NAME))) {
    return refusal('MEMORY_CAS_CONFLICT', casConflict(`${directory}/${LOCK_NAME}`, 'another apply holds the exclusive lockfile'), storeDigestBefore);
  }
  const proposal = input.proposal;
  const fastPath = digestEqual(loaded.index.storeDigest, proposal.baseStoreDigest) && proposal.baseRevision === input.currentRevision;
  let verifyBase = loaded.index;
  if (!fastPath) {
    if (!input.allowRebase) {
      return refusal('MEMORY_CAS_CONFLICT', casConflict('/proposal/baseStoreDigest', 'store moved past the proposal base and rebasing is disallowed'), storeDigestBefore);
    }
    if (input.baseStore === null || !digestEqual(input.baseStore.storeDigest, proposal.baseStoreDigest)) {
      return refusal('MEMORY_CAS_CONFLICT', casConflict('/proposal/baseStoreDigest', 'store moved past the proposal base and the base store was not retained for a rebase'), storeDigestBefore);
    }
    verifyBase = input.baseStore;
  }
  const baseEntryFiles = fastPath ? loaded.entryFiles : new Map([...input.baseStore!.entries].map(entry => [entry.id, entryFileBytes(entry)]));
  const baseProjection = projectMemoryStore(verifyBase, proposal.operations, input.nowMs, proposal.proposalId);
  const verificationPatch = buildPatch(directory, baseEntryFiles, baseProjection.entryFiles, canonical(verifyBase), canonical(baseProjection.index)).patch;
  const verification = await verifyAgainst(input, proposal, verificationPatch, verifyBase);
  if (!verification.satisfied) {
    return refusal('MEMORY_VERIFICATION_FAILED', verification.gates.flatMap(gate => gate.diagnostics), storeDigestBefore);
  }
  let effective = proposal;
  let rebased = false;
  if (!fastPath) {
    const delta = deltaOf(input.baseStore!, loaded.index);
    if (overlaps(delta, touchedBy(proposal))) {
      return refusal('MEMORY_CAS_CONFLICT', casConflict('/proposal/operations', 'concurrent changes touch the same entry id or claim key'), storeDigestBefore);
    }
    effective = { ...proposal, baseStoreDigest: loaded.index.storeDigest, baseRevision: input.currentRevision };
    const rebasedProjection = projectMemoryStore(loaded.index, effective.operations, input.nowMs, effective.proposalId);
    const rebasedPatch = buildPatch(directory, loaded.entryFiles, rebasedProjection.entryFiles,
      existsSync(join(repository, directory, 'index.json')) ? canonical(loaded.index) : null, canonical(rebasedProjection.index));
    const rebasedVerification = await verifyAgainst(input, effective, rebasedPatch.patch, loaded.index);
    if (!rebasedVerification.satisfied) {
      return refusal('MEMORY_VERIFICATION_FAILED', rebasedVerification.gates.flatMap(gate => gate.diagnostics), storeDigestBefore);
    }
    rebased = true;
  }
  const taskpackDirectory = join(repository, '.loopwright', 'memory', input.taskpack);
  const nonce = randomBytes(6).toString('hex');
  const staged: { readonly temp: string; readonly target: string }[] = [];
  let lockCreated = false;
  try {
    await mkdir(taskpackDirectory, { recursive: true, mode: 0o700 });
    const lockHandle = await open(join(taskpackDirectory, LOCK_NAME), constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'EEXIST') return null;
      throw error;
    });
    if (lockHandle === null) {
      return refusal('MEMORY_CAS_CONFLICT', casConflict(`${directory}/${LOCK_NAME}`, 'another apply holds the exclusive lockfile'), storeDigestBefore);
    }
    lockCreated = true;
    try {
      await lockHandle.writeFile(canonical({ version: 1, pid: process.pid, nonce, proposalId: effective.proposalId,
        acquiredAtMs: input.nowMs, touchedEntryIds: [...touchedBy(effective).ids].sort() }));
      await lockHandle.sync();
    } finally { await lockHandle.close(); }
    const current = await loadMemoryStore(input.repository, input.taskpack, input.proposal.repository);
    if (!digestEqual(current.index.storeDigest, storeDigestBefore)) {
      return refusal('MEMORY_CAS_CONFLICT', casConflict(`${directory}/index.json`, 'store changed while preparing the apply'), storeDigestBefore);
    }
    const entriesDirectory = join(taskpackDirectory, 'entries');
    await mkdir(entriesDirectory, { recursive: true, mode: 0o700 });
    const projection = projectMemoryStore(current.index, effective.operations, input.nowMs, effective.proposalId);
    const indexPath = join(taskpackDirectory, 'index.json');
    const indexExistedBefore = existsSync(indexPath);
    const patch = buildPatch(directory, current.entryFiles, projection.entryFiles,
      indexExistedBefore ? canonical(current.index) : null, canonical(projection.index));
    for (const file of patch.files) {
      const target = join(repository, file.path);
      staged.push({ temp: await stageFile(target, Buffer.from(file.content, 'utf8'), nonce), target });
    }
    const rollback = new Map<string, Buffer | null>();
    for (const stage of staged) rollback.set(stage.target, existsSync(stage.target) ? await readFile(stage.target) : null);
    try {
      for (const stage of staged.filter(candidate => !candidate.target.endsWith('index.json'))) await rename(stage.temp, stage.target);
      await input.faultInjectionHook?.();
      for (const stage of staged.filter(candidate => candidate.target.endsWith('index.json'))) await rename(stage.temp, stage.target);
    } catch (error) {
      for (const [target, bytes] of rollback) {
        try {
          if (bytes === null) await unlink(target);
          else {
            const handle = await open(target, constants.O_WRONLY | constants.O_TRUNC | constants.O_NOFOLLOW, 0o600);
            try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
          }
        } catch { /* best-effort rollback of an already failing apply */ }
      }
      throw error;
    }
    const upserts = effective.operations.filter(operation => operation.kind === 'upsert');
    const retirements = effective.operations.length - upserts.length;
    const citedEvidence = [...new Set(upserts.flatMap(operation => operation.entry.evidenceRefs
      .map(reference => `${reference.artifact.name}:${reference.artifact.digest.hex}`)))].sort();
    const pullRequest: SeparateMemoryPullRequestSpec = {
      mode: 'separate_pull_request',
      branchName: `loopwright/memory/${input.taskpack}/${effective.proposalId}`,
      targetBranch: input.targetBranch,
      baseRevision: effective.baseRevision,
      title: `memory(${input.taskpack}): ${effective.proposalId}`,
      body: `Applies verified memory proposal ${effective.proposalId} from run ${effective.runId}: ${upserts.length} addition(s)/replacement(s), ${retirements} retirement(s). Cited evidence: ${citedEvidence.length > 0 ? citedEvidence.join(', ') : 'none'}.`,
      modifiedFiles: patch.files,
      patch: patch.patch,
      excludesCodeCandidatePaths: true,
    };
    return { applied: true, rebased, refusal: null, storeDigestBefore, storeDigestAfter: projection.index.storeDigest, pullRequest };
  } catch (error) {
    for (const stage of staged) await unlink(stage.temp).catch(() => undefined);
    throw error;
  } finally {
    if (lockCreated) await unlink(join(taskpackDirectory, LOCK_NAME)).catch(() => undefined);
  }
}
