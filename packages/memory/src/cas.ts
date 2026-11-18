import { constants, existsSync } from 'node:fs';
import { createHash, randomBytes } from 'node:crypto';
import { open, readFile, rename, unlink } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { Digest } from '@loopwright/core';
import { canonical, digestEqual, unifiedFileDiff } from './schema.js';
import { ensureSafeDirectoryChain, entryFileBytes, loadMemoryStore, memoryDirectoryFor, normalizeMemoryRoot, projectMemoryStore } from './store.js';
import { verifyMemoryProposal } from './verifier.js';
import type { MemoryCASInput, MemoryCASRefusal, MemoryCASResult, MemoryDiagnostic, MemoryEntry, MemoryModifiedFile, MemoryOperation, MemoryProposal, SeparateMemoryPullRequestSpec } from './types.js';

const LOCK_NAME = '.cas.lock';
const MAX_MEMORY_PR_TITLE_CODEPOINTS = 72;
const MAX_MEMORY_PR_TASKPACK_CODEPOINTS = 28;
const MAX_MEMORY_PR_TABLE_ROWS = 50;
const MAX_MEMORY_PR_ENTRY_LABEL_CODEPOINTS = 60;
const MAX_MEMORY_PR_CLAIM_CODEPOINTS = 200;
const MAX_MEMORY_PR_BODY_CODEPOINTS = 30_000;
const MAX_MEMORY_PR_CITED_ARTIFACTS = 50;
const MAX_MEMORY_PR_ARTIFACT_NAME_CODEPOINTS = 120;
const MAX_MEMORY_PR_PROVENANCE_CODEPOINTS = 6_000;

function truncateCodePoints(text: string, maxCodePoints: number): string {
  if (maxCodePoints <= 0) return '';
  const chars = Array.from(text);
  return chars.length <= maxCodePoints ? text : chars.slice(0, maxCodePoints).join('');
}

function stripMemoryControlChars(text: string): string {
  let out = '';
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    if (code === 9 || code === 10 || code === 13) {
      out += ' ';
    } else if (code <= 31 || (code >= 127 && code <= 159)) {
      continue;
    } else {
      out += text[index]!;
    }
  }
  return out;
}

function sanitizeSingleLine(text: string): string {
  return stripMemoryControlChars(text).replace(/\s+/g, ' ').trim();
}

function escapeInlineCodeText(text: string): string {
  return sanitizeSingleLine(text).replace(/`/g, '\'');
}

function escapeTableSpecials(text: string, escapeAngles: boolean): string {
  const escaped = text.replace(/\\/g, '\\\\').replace(/\|/g, '\\|');
  return escapeAngles ? escaped.replace(/</g, '&lt;').replace(/>/g, '&gt;') : escaped;
}

function escapeMarkdownTableText(text: string, maxCodePoints: number): string {
  const cleaned = sanitizeSingleLine(text);
  if (cleaned.length === 0) return '-';
  return escapeTableSpecials(truncateCodePoints(cleaned, maxCodePoints), true);
}

function formatInlineTableCode(text: string, maxCodePoints: number): string {
  const cleaned = escapeInlineCodeText(text);
  if (cleaned.length === 0) return '-';
  return `\`${escapeTableSpecials(truncateCodePoints(cleaned, maxCodePoints), false)}\``;
}

function shortEntryLabel(entry: MemoryEntry): string {
  const raw = entry.claimKey.trim().length > 0 ? entry.claimKey : entry.id;
  return truncateCodePoints(sanitizeSingleLine(raw) || entry.id, MAX_MEMORY_PR_ENTRY_LABEL_CODEPOINTS);
}

/** Build a Conventional-Commit title (`<= 72` chars) for a separate memory pull request. */
export function buildMemoryPullRequestTitle(options: {
  readonly taskpack: string;
  readonly operations: readonly MemoryOperation[];
}): string {
  const rawTaskpack = sanitizeSingleLine(options.taskpack);
  const baseTaskpack = rawTaskpack.length > 0 ? rawTaskpack : 'store';
  let upserts = 0;
  let retirements = 0;
  for (const operation of options.operations) {
    if (operation.kind === 'upsert') upserts += 1;
    else retirements += 1;
  }

  const formatTitle = (taskpackLabel: string): string => {
    if (upserts > 0 && retirements === 0) {
      return `chore(memory): record ${upserts} verified ${taskpackLabel} ${upserts === 1 ? 'entry' : 'entries'}`;
    }
    if (retirements > 0 && upserts === 0) {
      return `chore(memory): retire ${retirements} stale ${taskpackLabel} ${retirements === 1 ? 'entry' : 'entries'}`;
    }
    return `chore(memory): update ${taskpackLabel} memory (+${upserts} / -${retirements})`;
  };

  let safeTaskpack = truncateCodePoints(baseTaskpack, MAX_MEMORY_PR_TASKPACK_CODEPOINTS);
  let title = formatTitle(safeTaskpack);
  const titleLen = Array.from(title).length;
  if (titleLen > MAX_MEMORY_PR_TITLE_CODEPOINTS) {
    const excess = titleLen - MAX_MEMORY_PR_TITLE_CODEPOINTS;
    const reducedLimit = Math.max(1, Array.from(safeTaskpack).length - excess);
    safeTaskpack = truncateCodePoints(baseTaskpack, reducedLimit);
    title = formatTitle(safeTaskpack);
  }
  return truncateCodePoints(title, MAX_MEMORY_PR_TITLE_CODEPOINTS);
}

/** Build structured GitHub-Flavored Markdown PR body for a verified memory proposal. */
export function buildMemoryPullRequestBody(options: {
  readonly taskpack: string;
  readonly proposal: MemoryProposal;
  readonly storeDigestBefore: Digest;
  readonly storeDigestAfter: Digest;
  readonly rebased?: boolean;
}): string {
  const safeTaskpack = escapeInlineCodeText(options.taskpack) || 'store';
  const safeRunId = escapeInlineCodeText(options.proposal.runId) || 'run';
  const safeProposalId = escapeInlineCodeText(options.proposal.proposalId) || 'proposal';
  const safeBaseRevision = escapeInlineCodeText(options.proposal.baseRevision) || 'unknown';
  const upserts = options.proposal.operations.filter(
    (operation): operation is Extract<MemoryOperation, { readonly kind: 'upsert' }> => operation.kind === 'upsert',
  );
  const retireCount = options.proposal.operations.length - upserts.length;

  const summarySection = [
    '## Summary',
    '',
    `Updates reviewed memory for taskpack \`${safeTaskpack}\` from verified run \`${safeRunId}\` (${upserts.length} recorded, ${retireCount} retired).`,
  ].join('\n');

  const citedArtifactMap = new Map<string, { readonly name: string; readonly hex: string }>();
  for (const operation of upserts) {
    for (const ref of operation.entry.evidenceRefs) {
      const name = truncateCodePoints(escapeInlineCodeText(ref.artifact.name), MAX_MEMORY_PR_ARTIFACT_NAME_CODEPOINTS);
      const hex = sanitizeSingleLine(ref.artifact.digest.hex);
      const key = `${name}\0${hex}`;
      if (!citedArtifactMap.has(key)) {
        citedArtifactMap.set(key, { name, hex });
      }
    }
  }
  const citedArtifacts = [...citedArtifactMap.values()].sort((a, b) =>
    a.name < b.name ? -1 : a.name > b.name ? 1 : a.hex < b.hex ? -1 : a.hex > b.hex ? 1 : 0,
  );

  const provenanceLines: string[] = [
    '<details>',
    `<summary>Provenance & Evidence Receipts (${citedArtifacts.length})</summary>`,
    '',
    `- **Proposal ID**: \`${safeProposalId}\``,
    `- **Run ID**: \`${safeRunId}\``,
    `- **Base Revision**: \`${safeBaseRevision.slice(0, 12)}\` (\`${safeBaseRevision}\`)`,
    `- **Store Digest**: \`${options.storeDigestBefore.hex.slice(0, 12)}\` -> \`${options.storeDigestAfter.hex.slice(0, 12)}\``,
  ];
  if (options.rebased === true) {
    provenanceLines.push('- **Rebased**: yes');
  }
  if (citedArtifacts.length === 0) {
    provenanceLines.push('- **Cited Artifacts**: none');
  } else {
    provenanceLines.push('- **Cited Artifacts**:');
    const maxArtifactsToConsider = Math.min(citedArtifacts.length, MAX_MEMORY_PR_CITED_ARTIFACTS);
    let provenanceChars = Array.from(provenanceLines.join('\n')).length;
    const closingBudget = Array.from(`\n  - ...and ${citedArtifacts.length} additional artifact(s).\n</details>`).length;
    let shownArtifacts = 0;
    for (let index = 0; index < maxArtifactsToConsider; index += 1) {
      const artifact = citedArtifacts[index]!;
      const line = `  - \`${artifact.name}\` (\`sha256:${artifact.hex.slice(0, 16)}…\`)`;
      const lineChars = 1 + Array.from(line).length;
      if (provenanceChars + lineChars + closingBudget > MAX_MEMORY_PR_PROVENANCE_CODEPOINTS) {
        break;
      }
      provenanceLines.push(line);
      provenanceChars += lineChars;
      shownArtifacts += 1;
    }
    if (citedArtifacts.length > shownArtifacts) {
      provenanceLines.push(`  - ...and ${citedArtifacts.length - shownArtifacts} additional artifact(s).`);
    }
  }
  provenanceLines.push('</details>');
  const provenanceBlock = provenanceLines.join('\n');

  const changeLines: string[] = ['## Memory Changes', ''];
  if (options.proposal.operations.length === 0) {
    changeLines.push('_No memory operations._');
    return `${summarySection}\n\n${changeLines.join('\n')}\n\n${provenanceBlock}`;
  }

  changeLines.push('| Action | Kind | Entry | Claim / Reason | Evidence |');
  changeLines.push('| --- | --- | --- | --- | --- |');
  const reservedCodePoints = Array.from(
    `${summarySection}\n\n${changeLines.join('\n')}\n\n_...and ${options.proposal.operations.length} additional operation(s)._\n\n${provenanceBlock}`,
  ).length;
  const rowBudget = Math.max(0, MAX_MEMORY_PR_BODY_CODEPOINTS - reservedCodePoints);
  const maxOpsToShow = Math.min(options.proposal.operations.length, MAX_MEMORY_PR_TABLE_ROWS);
  let usedRowCodePoints = 0;
  let shownOpsCount = 0;

  for (let index = 0; index < maxOpsToShow; index += 1) {
    const operation = options.proposal.operations[index]!;
    let rowLine: string;
    if (operation.kind === 'upsert') {
      const action = operation.entry.supersedes.length > 0 ? 'Supersede' : 'Record';
      const kindCell = formatInlineTableCode(operation.entry.kind, 40);
      const entryCell = formatInlineTableCode(shortEntryLabel(operation.entry), MAX_MEMORY_PR_ENTRY_LABEL_CODEPOINTS);
      const claimCell = escapeMarkdownTableText(operation.entry.claim, MAX_MEMORY_PR_CLAIM_CODEPOINTS);
      const uniqueCheckIds = [...new Set(
        operation.entry.evidenceRefs
          .map(ref => sanitizeSingleLine(ref.checkId))
          .filter(id => id.length > 0),
      )].slice(0, 10);
      const evidenceCell = uniqueCheckIds.length > 0
        ? uniqueCheckIds.map(id => formatInlineTableCode(id, 60)).join(', ')
        : '-';
      rowLine = `| ${action} | ${kindCell} | ${entryCell} | ${claimCell} | ${evidenceCell} |`;
    } else {
      const entryCell = formatInlineTableCode(operation.entryId, MAX_MEMORY_PR_ENTRY_LABEL_CODEPOINTS);
      const reasonCell = escapeMarkdownTableText(operation.reason, MAX_MEMORY_PR_CLAIM_CODEPOINTS);
      rowLine = `| Retire | - | ${entryCell} | ${reasonCell} | - |`;
    }
    const rowCost = 1 + Array.from(rowLine).length;
    if (usedRowCodePoints + rowCost > rowBudget) {
      break;
    }
    changeLines.push(rowLine);
    usedRowCodePoints += rowCost;
    shownOpsCount += 1;
  }

  if (options.proposal.operations.length > shownOpsCount) {
    changeLines.push('');
    changeLines.push(`_...and ${options.proposal.operations.length - shownOpsCount} additional operation(s)._`);
  }

  return `${summarySection}\n\n${changeLines.join('\n')}\n\n${provenanceBlock}`;
}

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
async function syncDirectory(directoryPath: string): Promise<void> {
  const handle = await open(directoryPath, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try { await handle.sync(); } finally { await handle.close(); }
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
async function verifyAgainst(
  input: MemoryCASInput,
  proposal: MemoryProposal,
  patch: string,
  store: Awaited<ReturnType<typeof loadMemoryStore>>['index'],
  memoryRoot: string,
) {
  return verifyMemoryProposal({ proposal, store, lock: input.lock, result: input.result, incident: input.incident, evidence: input.evidence,
    artifacts: input.artifacts, candidateDigest: input.candidateDigest, patch, secretValues: input.secretValues,
    memoryWritable: input.memoryWritable, protectedPaths: input.protectedPaths, memoryRoot,
    exemptContractProtectedPatterns: input.exemptContractProtectedPatterns });
}
/**
 * Applies a verified proposal under an exclusive lockfile with optimistic compare-and-swap. All files are
 * staged as `0o600` temporaries, renamed into place with entry files first, and rolled back from recorded
 * prior bytes when any step fails. Any refusal performs zero writes to `index.json` or `entries/`.
 */
export async function applyMemoryProposalCAS(input: MemoryCASInput): Promise<MemoryCASResult> {
  const repository = resolve(input.repository);
  const memoryRoot = normalizeMemoryRoot(input.memoryRoot);
  const loaded = await loadMemoryStore(input.repository, input.taskpack, input.proposal.repository, memoryRoot);
  const directory = memoryDirectoryFor(input.taskpack, memoryRoot);
  const taskpackSegments = [...memoryRoot.split('/'), input.taskpack];
  const taskpackDirectory = join(repository, ...taskpackSegments);
  const storeDigestBefore = loaded.index.storeDigest;
  if (existsSync(join(taskpackDirectory, LOCK_NAME))) {
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
  const verification = await verifyAgainst(input, proposal, verificationPatch, verifyBase, memoryRoot);
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
    const rebasedVerification = await verifyAgainst(input, effective, rebasedPatch.patch, loaded.index, memoryRoot);
    if (!rebasedVerification.satisfied) {
      return refusal('MEMORY_VERIFICATION_FAILED', rebasedVerification.gates.flatMap(gate => gate.diagnostics), storeDigestBefore);
    }
    rebased = true;
  }
  const nonce = randomBytes(6).toString('hex');
  const staged: { readonly temp: string; readonly target: string }[] = [];
  let lockCreated = false;
  try {
    await ensureSafeDirectoryChain(repository, taskpackSegments);
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
    const current = await loadMemoryStore(input.repository, input.taskpack, input.proposal.repository, memoryRoot);
    if (!digestEqual(current.index.storeDigest, storeDigestBefore)) {
      return refusal('MEMORY_CAS_CONFLICT', casConflict(`${directory}/index.json`, 'store changed while preparing the apply'), storeDigestBefore);
    }
    await ensureSafeDirectoryChain(repository, [...taskpackSegments, 'entries']);
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
      const entryStages = staged.filter(candidate => !candidate.target.endsWith('index.json'));
      for (const stage of entryStages) await rename(stage.temp, stage.target);
      if (entryStages.length > 0) await syncDirectory(join(taskpackDirectory, 'entries'));
      await input.faultInjectionHook?.();
      const indexStages = staged.filter(candidate => candidate.target.endsWith('index.json'));
      for (const stage of indexStages) await rename(stage.temp, stage.target);
      if (indexStages.length > 0) await syncDirectory(taskpackDirectory);
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
    const title = buildMemoryPullRequestTitle({ taskpack: input.taskpack, operations: effective.operations });
    const body = buildMemoryPullRequestBody({
      taskpack: input.taskpack,
      proposal: effective,
      storeDigestBefore,
      storeDigestAfter: projection.index.storeDigest,
      rebased,
    });
    const pullRequest: SeparateMemoryPullRequestSpec = {
      mode: 'separate_pull_request',
      branchName: `loopwright/memory/${input.taskpack}/${effective.proposalId}`,
      targetBranch: input.targetBranch,
      baseRevision: effective.baseRevision,
      title,
      body,
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
