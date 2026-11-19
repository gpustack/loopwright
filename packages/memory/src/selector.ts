import type { TaskContract } from '@loopwright/core';
import { digestEqual, fail, hashDomain } from './schema.js';
import type { ActiveMemorySnapshot, ExcludedMemoryEntry, MemoryEntry, MemoryEntryKind, MemorySelectorInput, MemoryTrustedResource } from './types.js';

const RENDERED_MARKDOWN_LIMIT_BYTES = 262_144;
const RESOURCE_ID_PREFIX = 'memory.';
const RESOURCE_ID_LIMIT = 64;

const SELECTION_KIND_PRIORITY: Readonly<Record<MemoryEntryKind, number>> = {
  invariant: 0,
  failure_observation: 1,
  fact: 2,
};

function byId(a: MemoryEntry, b: MemoryEntry): number { return a.id < b.id ? -1 : a.id > b.id ? 1 : 0; }
function bySelectionPriority(a: MemoryEntry, b: MemoryEntry): number {
  const kindDiff = SELECTION_KIND_PRIORITY[a.kind] - SELECTION_KIND_PRIORITY[b.kind];
  if (kindDiff !== 0) return kindDiff;
  if (a.verifiedAtMs !== b.verifiedAtMs) return b.verifiedAtMs - a.verifiedAtMs;
  return byId(a, b);
}
function matrixMatches(entry: MemoryEntry, targetCell: MemorySelectorInput['targetCell']): boolean {
  if (entry.scope.targetMatrix === null || targetCell === null) return true;
  return entry.scope.targetMatrix.id === targetCell.id && entry.scope.targetMatrix.platform === targetCell.platform
    && entry.scope.targetMatrix.variant === targetCell.variant;
}
function exclusion(entry: MemoryEntry, reason: ExcludedMemoryEntry['reason'], detail: string): ExcludedMemoryEntry {
  return { entryId: entry.id, claimKey: entry.claimKey, reason, detail };
}
/** Non-supersession validity: the checks every entry must pass before it may supersede others (N3). */
function ownExclusion(
  entry: MemoryEntry,
  contract: TaskContract,
  currentCodeFingerprint: MemorySelectorInput['currentCodeFingerprint'],
  currentUpstreamVersions: MemorySelectorInput['currentUpstreamVersions'],
  targetCell: MemorySelectorInput['targetCell'],
): ExcludedMemoryEntry | null {
  if (
    currentCodeFingerprint != null
    && !digestEqual(entry.validFor.codeFingerprint, currentCodeFingerprint)
  ) {
    return exclusion(entry, 'fingerprint_mismatch', `entry fingerprint ${entry.validFor.codeFingerprint.hex} != current ${currentCodeFingerprint.hex}`);
  }
  if (currentUpstreamVersions != null) {
    const drifted = Object.keys(entry.validFor.upstreamVersions).filter(
      key => entry.validFor.upstreamVersions[key] !== currentUpstreamVersions[key],
    );
    if (drifted.length > 0) {
      return exclusion(entry, 'upstream_version_changed', `pinned upstream changed: ${drifted.slice(0, 4).join(', ')}`);
    }
  }
  if (entry.scope.taskpack !== contract.spec.taskpack || entry.scope.repository !== contract.spec.target.repository || !matrixMatches(entry, targetCell)) {
    return exclusion(entry, 'scope_mismatch', 'entry scope does not match contract taskpack, repository, or target cell');
  }
  const hasPassed = entry.evidenceRefs.some(reference => reference.observedStatus === 'passed');
  const hasFailed = entry.evidenceRefs.some(reference => reference.observedStatus === 'failed');
  if ((entry.kind === 'fact' || entry.kind === 'invariant') && (!hasPassed || hasFailed)) {
    return exclusion(entry, 'unverified_claim', 'fact or invariant without a passed evidence reference or with a failed one');
  }
  if (entry.kind === 'fact' && entry.evidenceRefs.some(reference => reference.observedStatus === 'not_run' || reference.observedStatus === 'blocked')) {
    return exclusion(entry, 'hardware_or_gate_unproven', 'fact cites a not_run or blocked check as compatibility evidence');
  }
  return null;
}
function sanitizeRenderedClaim(claim: string): string {
  const withoutTags = claim.replace(/<\/?(?:active_memory|system)>/gi, '');
  return withoutTags
    .split(/\r\n|\r|\n/)
    .map(line => line
      .replace(/===[ \t]+(.*?)[ \t]+===/g, '== $1 ==')
      .replace(/^([ \t]*)===[ \t]+/, '$1== ')
      .replace(/^([ \t]*)(REQUIRED|NEVER|SYSTEM):/, '$1[$2]'))
    .join(' ');
}
function renderMarkdown(taskpack: string, activeEntries: readonly MemoryEntry[]): string {
  const facts = activeEntries.filter(entry => entry.kind !== 'failure_observation');
  const failures = activeEntries.filter(entry => entry.kind === 'failure_observation');
  const lines = [`# Active memory: ${taskpack}`, '', '## Verified Facts'];
  for (const entry of facts) {
    lines.push(`- ${entry.kind === 'invariant' ? '[invariant] ' : ''}${entry.id} (${entry.claimKey}): ${sanitizeRenderedClaim(entry.claim)}`);
  }
  lines.push('', '## Failure Observations');
  for (const entry of failures) {
    lines.push(`- ${entry.id} (${entry.claimKey}): ${sanitizeRenderedClaim(entry.claim)}`);
  }
  lines.push('');
  return lines.join('\n');
}
/** Excludes expired, superseded, drifted, and unproven entries; the returned snapshot is immutable. */
export function selectActiveMemory(input: MemorySelectorInput): ActiveMemorySnapshot {
  const { store, contract, nowMs, currentCodeFingerprint, currentUpstreamVersions, targetCell } = input;
  const indexed = [...store.entries].sort(byId);
  const currentEntryIds = new Set(indexed.map(entry => entry.id));
  const retiredOnly = store.retired.map(row => row.entry).filter(entry => !currentEntryIds.has(entry.id));
  const invalid = new Map<string, ExcludedMemoryEntry>();
  for (const entry of indexed) {
    const reason = ownExclusion(entry, contract, currentCodeFingerprint, currentUpstreamVersions, targetCell);
    if (reason !== null) invalid.set(entry.id, reason);
  }
  const validSuccessorIds = new Set(indexed.filter(entry => !invalid.has(entry.id) && nowMs < entry.expiresAtMs).map(entry => entry.id));
  const supersededIds = new Set(indexed.flatMap(entry => validSuccessorIds.has(entry.id) ? entry.supersedes : []));
  const validEntries: MemoryEntry[] = [];
  const excludedEntries: ExcludedMemoryEntry[] = [];
  for (const entry of indexed) {
    if (nowMs >= entry.expiresAtMs) {
      excludedEntries.push(exclusion(entry, 'expired', `expiresAtMs ${entry.expiresAtMs} has passed`));
      continue;
    }
    if (supersededIds.has(entry.id)) {
      excludedEntries.push(exclusion(entry, 'superseded', 'a valid active entry lists this id in supersedes'));
      continue;
    }
    const prior = invalid.get(entry.id);
    if (prior !== undefined) { excludedEntries.push(prior); continue; }
    validEntries.push(entry);
  }
  for (const entry of retiredOnly) {
    excludedEntries.push(exclusion(entry, 'superseded', 'entry resides in index.retired'));
  }

  let kept = [...validEntries].sort(bySelectionPriority);
  if (input.maxEntries !== undefined && Number.isFinite(input.maxEntries)) {
    kept = kept.slice(0, Math.max(0, Math.trunc(input.maxEntries)));
  }
  const effectiveMaxBytes = input.maxBytes !== undefined && Number.isFinite(input.maxBytes)
    ? Math.max(0, Math.min(RENDERED_MARKDOWN_LIMIT_BYTES, Math.trunc(input.maxBytes)))
    : RENDERED_MARKDOWN_LIMIT_BYTES;

  let activeEntries = [...kept].sort(byId);
  let renderedMarkdown = renderMarkdown(store.taskpack, activeEntries);
  if (Buffer.byteLength(renderedMarkdown, 'utf8') > effectiveMaxBytes && kept.length > 0) {
    let low = 0;
    let high = kept.length - 1;
    while (low < high) {
      const mid = Math.ceil((low + high) / 2);
      const candidateSorted = kept.slice(0, mid).sort(byId);
      if (Buffer.byteLength(renderMarkdown(store.taskpack, candidateSorted), 'utf8') <= effectiveMaxBytes) {
        low = mid;
      } else {
        high = mid - 1;
      }
    }
    kept = kept.slice(0, low);
    activeEntries = [...kept].sort(byId);
    renderedMarkdown = renderMarkdown(store.taskpack, activeEntries);
  }

  const snapshot: ActiveMemorySnapshot = Object.freeze({ version: 1, taskpack: store.taskpack, repository: store.repository, evaluatedAtMs: nowMs,
    activeEntries: Object.freeze(activeEntries), excludedEntries: Object.freeze(excludedEntries), renderedMarkdown,
    snapshotDigest: hashDomain('memory-active-snapshot', { version: 1, taskpack: store.taskpack, repository: store.repository,
      activeEntries, excluded: excludedEntries.map(row => ({ entryId: row.entryId, claimKey: row.claimKey, reason: row.reason })) }) });
  return snapshot;
}
export function memorySnapshotResourceId(snapshot: ActiveMemorySnapshot): string {
  const suffix = snapshot.taskpack.slice(0, RESOURCE_ID_LIMIT - RESOURCE_ID_PREFIX.length).replace(/[._-]+$/g, '');
  return `${RESOURCE_ID_PREFIX}${suffix.length > 0 ? suffix : 'taskpack'}`;
}
export function bindMemorySnapshotToResource(snapshot: ActiveMemorySnapshot, relativePath: string): MemoryTrustedResource {
  if (relativePath.startsWith('/') || relativePath.split('/').includes('..') || relativePath.length === 0) fail('MEMORY_SCHEMA_INVALID', '/relativePath', 'resource path must stay repo-relative');
  return { id: memorySnapshotResourceId(snapshot), kind: 'document', path: relativePath, digest: { ...snapshot.snapshotDigest } };
}
export function memorySnapshotBindingMatches(contract: TaskContract, snapshot: ActiveMemorySnapshot): boolean {
  const id = memorySnapshotResourceId(snapshot);
  const resource = contract.spec.trustedContext.resources.find(candidate => candidate.id === id);
  return resource !== undefined && digestEqual(resource.digest, snapshot.snapshotDigest);
}
