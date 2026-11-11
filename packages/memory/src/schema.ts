import { createHash } from 'node:crypto';
import type { ArtifactRef, Digest } from '@loopwright/core';
import type { ControllerIncident } from '@loopwright/controller';
import type { MemoryDiagnostic, MemoryErrorCode, MemoryEntry, MemoryEvidenceRef, MemoryOperation, MemoryProposal, MemoryStoreIndex, RetiredMemoryEntry } from './types.js';

export class MemoryDiagnosticError extends Error {
  constructor(readonly code: MemoryErrorCode, readonly path: string, readonly detail: string) { super(`${code} at ${path}: ${detail}`); }
}
export function fail(code: MemoryErrorCode, path: string, detail: string): never { throw new MemoryDiagnosticError(code, path, detail); }
export function diagnostic(error: unknown): MemoryDiagnostic {
  if (error instanceof MemoryDiagnosticError) return { code: error.code, path: error.path, detail: error.detail };
  return { code: 'MEMORY_SCHEMA_INVALID', path: '', detail: error instanceof Error ? error.message : 'unknown fault' };
}
export function digestEqual(a: Digest, b: Digest): boolean { return a.algorithm === b.algorithm && a.hex === b.hex; }

// Only validated, owned values reach this serializer; it never sees caller-owned trees.
export function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  const record = value as Readonly<Record<string, unknown>>;
  return '{' + Object.keys(record).sort().map(key => JSON.stringify(key) + ':' + canonical(record[key])).join(',') + '}';
}
export function hashDomain(domain: string, value: unknown): Digest {
  return { algorithm: 'sha256', hex: createHash('sha256').update(`loopwright.dev/memory/${domain}/v1alpha1\0`, 'utf8').update(canonical(value), 'utf8').digest('hex') };
}
export function digestBytes(bytes: Uint8Array): Digest {
  return { algorithm: 'sha256', hex: createHash('sha256').update(bytes).digest('hex') };
}
export function incidentReferenceDigest(incident: ControllerIncident): Digest {
  return hashDomain('memory-incident', incident);
}
export function syntheticIncidentArtifact(incident: ControllerIncident): ArtifactRef {
  return { name: `incidents/${incident.runId}.json`, digest: incidentReferenceDigest(incident), byteLength: Buffer.byteLength(canonical(incident), 'utf8') };
}

export const MEMORY_STORE_DIGEST_DOMAIN = 'memory-store-index';
export function storeDigestOf(index: Omit<MemoryStoreIndex, 'storeDigest'>): Digest {
  return hashDomain(MEMORY_STORE_DIGEST_DOMAIN, { version: index.version, taskpack: index.taskpack, repository: index.repository,
    updatedAtMs: index.updatedAtMs, entries: index.entries, retired: index.retired });
}

export const memoryIdentifierPattern = /^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/;
export function hasControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index++) {
    const unit = value.charCodeAt(index);
    if (unit <= 8 || unit === 11 || unit === 12 || (unit >= 14 && unit <= 31) || unit === 127) return true;
  }
  return false;
}
const revisionPattern = /^[A-Za-z0-9][A-Za-z0-9._:/-]*$/;

function objectShape(value: unknown, path: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) fail('MEMORY_SCHEMA_INVALID', path, 'expected object');
  return value as Record<string, unknown>;
}
function field(input: Record<string, unknown>, keys: readonly string[], path: string): void {
  for (const key of keys) if (!Object.hasOwn(input, key)) fail('MEMORY_SCHEMA_INVALID', `${path}/${key}`, 'field required');
  for (const key of Object.keys(input)) if (!keys.includes(key)) fail('MEMORY_SCHEMA_INVALID', `${path}/${key}`, 'unknown field');
}
function text(value: unknown, path: string, min: number, max: number): string {
  if (typeof value !== 'string') fail('MEMORY_SCHEMA_INVALID', path, 'expected string');
  if (value.length < min || value.length > max) fail('MEMORY_SCHEMA_INVALID', path, `length ${value.length} outside ${min}..${max}`);
  return value;
}
function integer(value: unknown, path: string, min: number): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || Object.is(value, -0) || value < min) fail('MEMORY_SCHEMA_INVALID', path, 'expected safe integer above minimum');
  return value;
}
function digestShape(value: unknown, path: string): Digest {
  const input = objectShape(value, path);
  field(input, ['algorithm', 'hex'], path);
  if (input['algorithm'] !== 'sha256') fail('MEMORY_SCHEMA_INVALID', `${path}/algorithm`, 'unsupported algorithm');
  const hex = text(input['hex'], `${path}/hex`, 64, 64);
  if (!/^[0-9a-f]{64}$/.test(hex)) fail('MEMORY_SCHEMA_INVALID', `${path}/hex`, 'expected lower-case sha256 hex');
  return { algorithm: 'sha256', hex };
}
function identifier(value: unknown, path: string, max: number): string {
  const name = text(value, path, 1, max);
  if (!memoryIdentifierPattern.test(name)) fail('MEMORY_SCHEMA_INVALID', path, 'identifier pattern mismatch');
  return name;
}
function revision(value: unknown, path: string): string {
  const name = text(value, path, 1, 128);
  if (!revisionPattern.test(name)) fail('MEMORY_SCHEMA_INVALID', path, 'revision pattern mismatch');
  return name;
}
/** Repository identifiers are `org/repo` slugs like `acme/widget`; host paths and single segments never persist. */
const repositorySlugPattern = /^[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)+$/;
function repositorySlug(value: unknown, path: string): string {
  const name = text(value, path, 1, 256);
  if (!repositorySlugPattern.test(name) || name.includes('\\') || name.split('/').includes('.') || name.split('/').includes('..')) {
    fail('MEMORY_SCHEMA_INVALID', path, 'repository must be an org/repo slug, not a filesystem path');
  }
  return name;
}
function memoryClaim(value: unknown, path: string): string {
  const claim = text(value, path, 1, 2048);
  const bytes = Buffer.byteLength(claim, 'utf8');
  if (bytes > 2048) fail('MEMORY_SCHEMA_INVALID', path, `byte length ${bytes} outside 1..2048`);
  if (hasControlCharacter(claim)) fail('MEMORY_SCHEMA_INVALID', path, 'control character in claim');
  return claim;
}
function scopePattern(value: unknown, path: string): string {
  const pattern = text(value, path, 1, 1024);
  if (pattern.startsWith('/') || pattern.includes('\\') || pattern.split('/').includes('..')) fail('MEMORY_SCHEMA_INVALID', path, 'pattern must stay repo-relative');
  if (hasControlCharacter(pattern)) fail('MEMORY_SCHEMA_INVALID', path, 'control character in pattern');
  return pattern;
}
function sortedUnique(value: unknown, path: string, min: number, max: number, maxItemLength: number): readonly string[] {
  if (!Array.isArray(value) || value.length < min || value.length > max) fail('MEMORY_SCHEMA_INVALID', path, `array length outside ${min}..${max}`);
  const items = value.map((item, index) => text(item, `${path}/${index}`, 1, maxItemLength));
  const sorted = [...items].sort();
  for (let index = 1; index < sorted.length; index++) {
    if (sorted[index] === sorted[index - 1]) fail('MEMORY_SCHEMA_INVALID', `${path}/${index}`, 'duplicate item');
    if (sorted[index]! < sorted[index - 1]!) fail('MEMORY_SCHEMA_INVALID', path, 'items must be sorted');
  }
  return items;
}
function versionsMap(value: unknown, path: string): Readonly<Record<string, string>> {
  const input = objectShape(value, path);
  const keys = Object.keys(input);
  if (keys.length > 128) fail('MEMORY_SCHEMA_INVALID', path, 'too many pinned upstreams');
  const output: Record<string, string> = Object.create(null);
  for (const key of keys) output[key] = text(input[key], `${path}/${key}`, 1, 256);
  return Object.freeze(output);
}
const EVIDENCE_LEVELS = ['static_inspection', 'synthetic_fixture', 'local_execution', 'external_service', 'hardware_execution'] as const;
const CHECK_STATUSES = ['passed', 'failed', 'blocked', 'not_run'] as const;
function artifactRef(value: unknown, path: string): ArtifactRef {
  const input = objectShape(value, path);
  field(input, ['name', 'digest', 'byteLength'], path);
  const name = text(input['name'], `${path}/name`, 1, 1024);
  if (name.startsWith('/') || name.split('/').includes('..')) fail('MEMORY_SCHEMA_INVALID', `${path}/name`, 'artifact name must stay relative');
  return { name, digest: digestShape(input['digest'], `${path}/digest`), byteLength: integer(input['byteLength'], `${path}/byteLength`, 0) };
}
function evidenceRef(value: unknown, path: string): MemoryEvidenceRef {
  const input = objectShape(value, path);
  field(input, ['evidenceId', 'checkId', 'level', 'observedStatus', 'artifact'], path);
  const level = text(input['level'], `${path}/level`, 1, 64);
  if (!EVIDENCE_LEVELS.includes(level as (typeof EVIDENCE_LEVELS)[number])) fail('MEMORY_SCHEMA_INVALID', `${path}/level`, 'unknown evidence level');
  const observedStatus = text(input['observedStatus'], `${path}/observedStatus`, 1, 16);
  if (!CHECK_STATUSES.includes(observedStatus as (typeof CHECK_STATUSES)[number])) fail('MEMORY_SCHEMA_INVALID', `${path}/observedStatus`, 'unknown check status');
  return { evidenceId: identifier(input['evidenceId'], `${path}/evidenceId`, 128), checkId: identifier(input['checkId'], `${path}/checkId`, 128),
    level: level as (typeof EVIDENCE_LEVELS)[number], observedStatus: observedStatus as (typeof CHECK_STATUSES)[number], artifact: artifactRef(input['artifact'], `${path}/artifact`) };
}
function targetMatrix(value: unknown, path: string): MemoryEntry['scope']['targetMatrix'] {
  if (value === null) return null;
  const input = objectShape(value, path);
  field(input, ['id', 'platform', 'variant'], path);
  return { id: identifier(input['id'], `${path}/id`, 128), platform: text(input['platform'], `${path}/platform`, 1, 128), variant: text(input['variant'], `${path}/variant`, 1, 128) };
}
const ENTRY_KINDS = ['fact', 'failure_observation', 'invariant'] as const;
export function memoryEntrySchema(value: unknown, path = ''): MemoryEntry {
  const input = objectShape(value, path);
  field(input, ['version', 'id', 'claimKey', 'claim', 'kind', 'scope', 'sourceRef', 'sourceDigest', 'verifiedAtMs', 'validFor', 'expiresAtMs', 'supersedes', 'evidenceRefs'], path);
  if (input['version'] !== 1) fail('MEMORY_SCHEMA_INVALID', `${path}/version`, 'unsupported version');
  const kind = text(input['kind'], `${path}/kind`, 1, 32);
  if (!ENTRY_KINDS.includes(kind as (typeof ENTRY_KINDS)[number])) fail('MEMORY_SCHEMA_INVALID', `${path}/kind`, 'unknown entry kind');
  const scope = objectShape(input['scope'], `${path}/scope`);
  field(scope, ['taskpack', 'repository', 'paths', 'targetMatrix'], `${path}/scope`);
  const sourceRef = objectShape(input['sourceRef'], `${path}/sourceRef`);
  field(sourceRef, ['runId', 'lockHash', 'candidateDigest'], `${path}/sourceRef`);
  const validFor = objectShape(input['validFor'], `${path}/validFor`);
  field(validFor, ['baseRevision', 'sourceRevision', 'codeFingerprint', 'upstreamVersions'], `${path}/validFor`);
  const verifiedAtMs = integer(input['verifiedAtMs'], `${path}/verifiedAtMs`, 0);
  const expiresAtMs = integer(input['expiresAtMs'], `${path}/expiresAtMs`, 1);
  if (expiresAtMs <= verifiedAtMs) fail('MEMORY_SCHEMA_INVALID', `${path}/expiresAtMs`, 'expiresAtMs must exceed verifiedAtMs');
  const paths = sortedUnique(scope['paths'], `${path}/scope/paths`, 1, 32, 1024);
  const entry: MemoryEntry = { version: 1, id: identifier(input['id'], `${path}/id`, 128), claimKey: identifier(input['claimKey'], `${path}/claimKey`, 128),
    claim: memoryClaim(input['claim'], `${path}/claim`), kind: kind as (typeof ENTRY_KINDS)[number],
    scope: { taskpack: identifier(scope['taskpack'], `${path}/scope/taskpack`, 128), repository: repositorySlug(scope['repository'], `${path}/scope/repository`),
      paths: paths.map((item, index) => scopePattern(item, `${path}/scope/paths/${index}`)),
      targetMatrix: targetMatrix(scope['targetMatrix'], `${path}/scope/targetMatrix`) },
    sourceRef: { runId: identifier(sourceRef['runId'], `${path}/sourceRef/runId`, 128), lockHash: digestShape(sourceRef['lockHash'], `${path}/sourceRef/lockHash`),
      candidateDigest: digestShape(sourceRef['candidateDigest'], `${path}/sourceRef/candidateDigest`) },
    sourceDigest: digestShape(input['sourceDigest'], `${path}/sourceDigest`), verifiedAtMs,
    validFor: { baseRevision: revision(validFor['baseRevision'], `${path}/validFor/baseRevision`), sourceRevision: revision(validFor['sourceRevision'], `${path}/validFor/sourceRevision`),
      codeFingerprint: digestShape(validFor['codeFingerprint'], `${path}/validFor/codeFingerprint`), upstreamVersions: versionsMap(validFor['upstreamVersions'], `${path}/validFor/upstreamVersions`) },
    expiresAtMs, supersedes: sortedUnique(input['supersedes'], `${path}/supersedes`, 0, 32, 128),
    evidenceRefs: (() => { if (!Array.isArray(input['evidenceRefs']) || input['evidenceRefs'].length < 1 || input['evidenceRefs'].length > 16) fail('MEMORY_SCHEMA_INVALID', `${path}/evidenceRefs`, 'array length outside 1..16');
      return input['evidenceRefs'].map((item, index) => evidenceRef(item, `${path}/evidenceRefs/${index}`)); })() };
  return Object.freeze(entry);
}
function retiredEntry(value: unknown, path: string): RetiredMemoryEntry {
  const input = objectShape(value, path);
  field(input, ['entry', 'retiredAtMs', 'retiredByProposalId', 'supersededByEntryId'], path);
  return { entry: memoryEntrySchema(input['entry'], `${path}/entry`), retiredAtMs: integer(input['retiredAtMs'], `${path}/retiredAtMs`, 0),
    retiredByProposalId: identifier(input['retiredByProposalId'], `${path}/retiredByProposalId`, 128),
    supersededByEntryId: input['supersededByEntryId'] === null ? null : identifier(input['supersededByEntryId'], `${path}/supersededByEntryId`, 128) };
}
export function memoryStoreIndexSchema(value: unknown, path = ''): MemoryStoreIndex {
  const input = objectShape(value, path);
  field(input, ['version', 'taskpack', 'repository', 'updatedAtMs', 'entries', 'retired', 'storeDigest'], path);
  if (input['version'] !== 1) fail('MEMORY_SCHEMA_INVALID', `${path}/version`, 'unsupported version');
  if (!Array.isArray(input['entries']) || input['entries'].length > 1024) fail('MEMORY_SCHEMA_INVALID', `${path}/entries`, 'array length outside 0..1024');
  if (!Array.isArray(input['retired']) || input['retired'].length > 1024) fail('MEMORY_SCHEMA_INVALID', `${path}/retired`, 'array length outside 0..1024');
  const base = { version: 1 as const, taskpack: identifier(input['taskpack'], `${path}/taskpack`, 128), repository: repositorySlug(input['repository'], `${path}/repository`),
    updatedAtMs: integer(input['updatedAtMs'], `${path}/updatedAtMs`, 0),
    entries: input['entries'].map((item, index) => memoryEntrySchema(item, `${path}/entries/${index}`)),
    retired: input['retired'].map((item, index) => retiredEntry(item, `${path}/retired/${index}`)) };
  const entryIds = new Set<string>();
  for (const [index, entry] of base.entries.entries()) {
    if (entryIds.has(entry.id)) fail('MEMORY_SCHEMA_INVALID', `${path}/entries/${index}`, `duplicate entry id ${entry.id}`);
    entryIds.add(entry.id);
  }
  const retiredIds = new Set<string>();
  for (const [index, row] of base.retired.entries()) {
    if (retiredIds.has(row.entry.id)) fail('MEMORY_SCHEMA_INVALID', `${path}/retired/${index}`, `duplicate retired entry id ${row.entry.id}`);
    retiredIds.add(row.entry.id);
  }
  const index: MemoryStoreIndex = Object.freeze({ ...base, storeDigest: digestShape(input['storeDigest'], `${path}/storeDigest`) });
  if (!digestEqual(index.storeDigest, storeDigestOf(base))) fail('MEMORY_SCHEMA_INVALID', `${path}/storeDigest`, 'store digest does not match index content');
  return index;
}
function operationSchema(value: unknown, path: string): MemoryOperation {
  const input = objectShape(value, path);
  if (input['kind'] === 'retire') {
    field(input, ['kind', 'entryId', 'reason'], path);
    return { kind: 'retire', entryId: identifier(input['entryId'], `${path}/entryId`, 128), reason: memoryClaim(input['reason'], `${path}/reason`) };
  }
  if (input['kind'] !== 'upsert') fail('MEMORY_SCHEMA_INVALID', `${path}/kind`, 'unknown operation kind');
  field(input, ['kind', 'entry'], path);
  return { kind: 'upsert', entry: memoryEntrySchema(input['entry'], `${path}/entry`) };
}
export function memoryProposalSchema(value: unknown, path = ''): MemoryProposal {
  const input = objectShape(value, path);
  field(input, ['version', 'proposalId', 'taskpack', 'repository', 'baseRevision', 'baseStoreDigest', 'createdAtMs', 'runId', 'lockHash', 'operations'], path);
  if (input['version'] !== 1) fail('MEMORY_SCHEMA_INVALID', `${path}/version`, 'unsupported version');
  if (!Array.isArray(input['operations']) || input['operations'].length > 256) fail('MEMORY_SCHEMA_INVALID', `${path}/operations`, 'array length outside 0..256');
  return Object.freeze({ version: 1 as const, proposalId: identifier(input['proposalId'], `${path}/proposalId`, 128),
    taskpack: identifier(input['taskpack'], `${path}/taskpack`, 128), repository: repositorySlug(input['repository'], `${path}/repository`),
    baseRevision: revision(input['baseRevision'], `${path}/baseRevision`), baseStoreDigest: digestShape(input['baseStoreDigest'], `${path}/baseStoreDigest`),
    createdAtMs: integer(input['createdAtMs'], `${path}/createdAtMs`, 0), runId: identifier(input['runId'], `${path}/runId`, 128),
    lockHash: digestShape(input['lockHash'], `${path}/lockHash`),
    operations: input['operations'].map((item, index) => operationSchema(item, `${path}/operations/${index}`)) });
}

export const MEMORY_ENTRY_HEADER_FENCE = '---';
export function renderEntryMarkdown(entry: MemoryEntry): string {
  return `${MEMORY_ENTRY_HEADER_FENCE}\n${canonical(entry)}\n${MEMORY_ENTRY_HEADER_FENCE}\n\n${entry.claim}\n`;
}
function splitLines(content: string): readonly string[] {
  if (content.length === 0) return [];
  const lines = content.split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  return lines;
}
/** Git-style unified diff over repo-relative text files; `before === null` means a new file. */
type DiffOp = { readonly kind: ' ' | '-' | '+'; readonly text: string };
function editScript(a: readonly string[], b: readonly string[]): readonly DiffOp[] {
  const m = a.length, n = b.length;
  const table: number[][] = Array.from({ length: m + 1 }, () => new Array<number>(n + 1).fill(0) as number[]);
  for (let i = m - 1; i >= 0; i--) for (let j = n - 1; j >= 0; j--)
    table[i]![j] = a[i] === b[j] ? table[i + 1]![j + 1]! + 1 : Math.max(table[i + 1]![j]!, table[i]![j + 1]!);
  const ops: DiffOp[] = [];
  let i = 0, j = 0;
  while (i < m && j < n) {
    if (a[i] === b[j]) { ops.push({ kind: ' ', text: a[i]! }); i++; j++; }
    else if (table[i + 1]![j]! >= table[i]![j + 1]!) { ops.push({ kind: '-', text: a[i]! }); i++; }
    else { ops.push({ kind: '+', text: b[j]! }); j++; }
  }
  while (i < m) { ops.push({ kind: '-', text: a[i]! }); i++; }
  while (j < n) { ops.push({ kind: '+', text: b[j]! }); j++; }
  return ops;
}
export function unifiedFileDiff(path: string, before: string | null, after: string, context = 3): string {
  const a = splitLines(before ?? ''), b = splitLines(after);
  if (before !== null && a.length === b.length && a.every((line, index) => line === b[index])) return '';
  const ops = editScript(a, b);
  const changed = ops.map(op => op.kind !== ' ');
  const hunks: string[] = [];
  let index = 0;
  while (index < ops.length) {
    if (!changed[index]) { index++; continue; }
    let end = index;
    while (end + 1 < ops.length && (changed[end + 1] || changed.slice(end + 1, Math.min(ops.length, end + 1 + 2 * context + 1)).some(Boolean))) end++;
    const from = Math.max(0, index - context), to = Math.min(ops.length, end + 1 + context);
    let oldStart = 1, newStart = 1;
    for (let k = 0; k < from; k++) { if (ops[k]!.kind !== '+') oldStart++; if (ops[k]!.kind !== '-') newStart++; }
    let oldCount = 0, newCount = 0;
    for (let k = from; k < to; k++) { if (ops[k]!.kind !== '+') oldCount++; if (ops[k]!.kind !== '-') newCount++; }
    const oldStartNumber = oldCount === 0 ? 0 : oldStart, newStartNumber = newCount === 0 ? 0 : newStart;
    const lines = [`@@ -${oldStartNumber},${oldCount} +${newStartNumber},${newCount} @@`];
    for (let k = from; k < to; k++) lines.push(ops[k]!.kind + ops[k]!.text);
    hunks.push(lines.join('\n'));
    index = to;
  }
  if (hunks.length === 0) return '';
  const header = before === null ? `--- /dev/null\n+++ b/${path}\n` : `--- a/${path}\n+++ b/${path}\n`;
  return header + hunks.join('\n') + '\n';
}
export function parseEntryMarkdown(bytes: Uint8Array, path = ''): MemoryEntry {
  const content = Buffer.from(bytes).toString('utf8');
  if (!content.startsWith(`${MEMORY_ENTRY_HEADER_FENCE}\n`)) fail('MEMORY_SCHEMA_INVALID', path, 'missing header fence');
  const headerStart = MEMORY_ENTRY_HEADER_FENCE.length + 1;
  const closing = content.indexOf(`\n${MEMORY_ENTRY_HEADER_FENCE}\n`, headerStart);
  if (closing < 0) fail('MEMORY_SCHEMA_INVALID', path, 'missing closing fence');
  const rawHeader = content.slice(headerStart, closing);
  let parsed: unknown;
  try { parsed = JSON.parse(rawHeader); } catch { fail('MEMORY_SCHEMA_INVALID', `${path}/header`, 'header is not JSON'); }
  const entry = memoryEntrySchema(parsed, `${path}/header`);
  if (canonical(entry) !== rawHeader) fail('MEMORY_SCHEMA_INVALID', `${path}/header`, 'header is not canonical');
  const claim = content.slice(closing + MEMORY_ENTRY_HEADER_FENCE.length + 2).replace(/^\n+/, '').replace(/\n$/, '');
  if (claim !== entry.claim) fail('MEMORY_SCHEMA_INVALID', `${path}/claim`, 'body does not match entry claim');
  return entry;
}
