import { createHash } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import { lstat, mkdir, open, readFile, readdir } from 'node:fs/promises';
import { join, relative, resolve } from 'node:path';
import type { Digest } from '@loopwright/core';
import { canonical, fail, hashDomain, hasControlCharacter, memoryIdentifierPattern, memoryStoreIndexSchema, parseEntryMarkdown, renderEntryMarkdown, storeDigestOf } from './schema.js';
import type { MemoryEntry, MemoryOperation, MemoryStoreIndex, RetiredMemoryEntry } from './types.js';

export const MEMORY_ROOT = '.loopwright/memory';
const TASKPACK_DIRECTORY_ENTRIES = ['index.json', 'entries', '.cas.lock'];
const ENTRY_STAGING_PATTERN = /^([a-z0-9][a-z0-9._-]{0,127})\.md\.tmp-[0-9]+-[0-9a-f]+$/;
export function memoryDirectoryFor(taskpack: string): string { return `${MEMORY_ROOT}/${taskpack}`; }
export function forbiddenMemoryArtifactName(name: string): boolean {
  return name.endsWith('.sqlite') || name === 'run.json' || name.startsWith('privateSession') || /checkpoint/i.test(name);
}
export function isMemoryManagedPath(taskpack: string, path: string): boolean {
  if (!memoryIdentifierPattern.test(taskpack)) return false;
  if (path.startsWith('/') || path.includes('\\')) return false;
  const segments = path.split('/');
  if (segments.some(segment => segment.length === 0)) return false;
  if (segments.includes('..') || segments.includes('.')) return false;
  if (hasControlCharacter(path)) return false;
  const directory = memoryDirectoryFor(taskpack);
  return path === directory || path.startsWith(`${directory}/`);
}
export function emptyMemoryStoreIndex(taskpack: string, repository: string, nowMs: number): MemoryStoreIndex {
  return Object.freeze({ version: 1 as const, taskpack, repository, updatedAtMs: nowMs, entries: Object.freeze([]), retired: Object.freeze([]),
    storeDigest: storeDigestOf({ version: 1, taskpack, repository, updatedAtMs: nowMs, entries: [], retired: [] }) });
}
export interface LoadedMemoryStore {
  readonly index: MemoryStoreIndex;
  readonly entryFiles: ReadonlyMap<string, Uint8Array>;
}
async function readRegularFile(path: string, label: string): Promise<Uint8Array> {
  const stats = await lstat(path);
  if (stats.isSymbolicLink()) fail('MEMORY_SCHEMA_INVALID', label, 'symbolic links are refused in the memory store');
  if (!stats.isFile()) fail('MEMORY_SCHEMA_INVALID', label, 'expected a regular file');
  const handle = await open(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  try { return await handle.readFile(); } finally { await handle.close(); }
}
async function refuseForbiddenNames(directory: string, label: string): Promise<void> {
  const names = await readdir(directory);
  for (const name of names) if (forbiddenMemoryArtifactName(name)) fail('MEMORY_SCHEMA_INVALID', `${label}/${name}`, 'forbidden artifact name in memory store');
}
export interface ActiveCasLock {
  readonly pid: number;
  readonly nonce: string;
  readonly touchedEntryIds: ReadonlySet<string>;
}
/**
 * Returns the apply lock only when it is structured and its writer process is still alive; a stale or
 * unstructured `.cas.lock` reads as `null`, so no staging tolerance is granted (R3-N-2, R3-N-3).
 */
export async function readActiveCasLock(directory: string): Promise<ActiveCasLock | null> {
  let bytes: Uint8Array;
  try { bytes = await readFile(join(directory, '.cas.lock')); } catch { return null; }
  let parsed: unknown;
  try { parsed = JSON.parse(Buffer.from(bytes).toString('utf8')); } catch { return null; }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const input = parsed as Readonly<Record<string, unknown>>;
  if (input['version'] !== 1 || typeof input['pid'] !== 'number' || !Number.isSafeInteger(input['pid']) || input['pid'] <= 0) return null;
  if (typeof input['nonce'] !== 'string' || !/^[0-9a-f]{12}$/.test(input['nonce'])) return null;
  if (!Array.isArray(input['touchedEntryIds']) || !input['touchedEntryIds'].every(id => typeof id === 'string')) return null;
  try { process.kill(input['pid'], 0); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') return null;
    if ((error as NodeJS.ErrnoException).code !== 'EPERM') return null;
  }
  return { pid: input['pid'], nonce: input['nonce'], touchedEntryIds: new Set(input['touchedEntryIds'] as readonly string[]) };
}
/** Reads `<repository>/.loopwright/memory/<taskpack>/`; a missing store reads as empty under `repositorySlug`. */
export async function loadMemoryStore(repository: string, taskpack: string, repositorySlug: string): Promise<LoadedMemoryStore> {
  if (!memoryIdentifierPattern.test(taskpack) || taskpack.length > 128) fail('MEMORY_SCHEMA_INVALID', '/taskpack', 'identifier pattern mismatch');
  const root = resolve(repository);
  const directory = join(root, '.loopwright', 'memory', taskpack);
  const rootStats = await lstat(join(root, MEMORY_ROOT)).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return null; throw error;
  });
  if (rootStats === null) return { index: emptyMemoryStoreIndex(taskpack, repositorySlug, 0), entryFiles: new Map() };
  if (rootStats.isSymbolicLink()) fail('MEMORY_SCHEMA_INVALID', MEMORY_ROOT, 'symbolic links are refused in the memory store');
  const stats = await lstat(directory).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return null; throw error;
  });
  if (stats === null) return { index: emptyMemoryStoreIndex(taskpack, repositorySlug, 0), entryFiles: new Map() };
  if (stats.isSymbolicLink()) fail('MEMORY_SCHEMA_INVALID', memoryDirectoryFor(taskpack), 'symbolic links are refused in the memory store');
  if (!stats.isDirectory()) fail('MEMORY_SCHEMA_INVALID', memoryDirectoryFor(taskpack), 'expected a directory');
  await refuseForbiddenNames(join(root, MEMORY_ROOT), MEMORY_ROOT);
  const taskpackNames = await readdir(directory);
  let activeLock = await readActiveCasLock(directory);
  for (const name of taskpackNames) {
    if (TASKPACK_DIRECTORY_ENTRIES.includes(name)) continue;
    if (activeLock !== null && name === `index.json.tmp-${activeLock.pid}-${activeLock.nonce}`) continue;
    fail('MEMORY_SCOPE_VIOLATION', `${memoryDirectoryFor(taskpack)}/${name}`, 'unexpected file in memory directory');
  }
  const entriesDirectory = join(directory, 'entries');
  const entriesStats = await lstat(entriesDirectory).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return null; throw error;
  });
  const indexBytes = await (async (): Promise<Uint8Array | null> => {
    try { return await readRegularFile(join(directory, 'index.json'), `${memoryDirectoryFor(taskpack)}/index.json`); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
  })();
  if (indexBytes === null) {
    const existing = entriesStats === null ? [] : await readdir(entriesDirectory);
    if (existing.length > 0) fail('MEMORY_SCHEMA_INVALID', `${memoryDirectoryFor(taskpack)}/index.json`, 'entry files exist without an index');
    return { index: emptyMemoryStoreIndex(taskpack, repositorySlug, 0), entryFiles: new Map() };
  }
  if (entriesStats === null) fail('MEMORY_SCHEMA_INVALID', `${memoryDirectoryFor(taskpack)}/entries`, 'entries directory missing');
  let parsedIndex: unknown;
  try { parsedIndex = JSON.parse(Buffer.from(indexBytes).toString('utf8')); } catch { fail('MEMORY_SCHEMA_INVALID', `${memoryDirectoryFor(taskpack)}/index.json`, 'index is not JSON'); }
  const index = memoryStoreIndexSchema(parsedIndex, memoryDirectoryFor(taskpack));
  if (index.taskpack !== taskpack) fail('MEMORY_SCHEMA_INVALID', `${memoryDirectoryFor(taskpack)}/index.json/taskpack`, 'index taskpack does not match directory');
  if (entriesStats!.isSymbolicLink() || !entriesStats!.isDirectory()) fail('MEMORY_SCHEMA_INVALID', `${memoryDirectoryFor(taskpack)}/entries`, 'expected a directory');
  const files = await readdir(entriesDirectory);
  const indexedIds = new Set([...index.entries.map(entry => entry.id), ...index.retired.map(row => row.entry.id)]);
  const committedBytes = (row: MemoryEntry): Uint8Array => entryFileBytes(row);
  const entryFiles = new Map<string, Uint8Array>();
  const markIndexed = (id: string, row: MemoryEntry, path: string): Promise<void> => (async () => {
    let bytes: Uint8Array;
    try {
      bytes = await readRegularFile(join(entriesDirectory, `${id}.md`), path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT' && activeLock !== null && activeLock.touchedEntryIds.has(id)) {
        entryFiles.set(id, committedBytes(row));
        return;
      }
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') fail('MEMORY_SCHEMA_INVALID', path, 'index row has no entry file');
      throw error;
    }
    const parsed = parseEntryMarkdown(bytes, path);
    if (parsed.id !== id) fail('MEMORY_SCHEMA_INVALID', path, 'entry id does not match file name');
    if (canonical(parsed) !== canonical(row)) {
      activeLock = activeLock ?? await readActiveCasLock(directory);
      if (activeLock === null || !activeLock.touchedEntryIds.has(id)) fail('MEMORY_SCHEMA_INVALID', path, 'entry file does not match index row');
      entryFiles.set(id, committedBytes(row));
      return;
    }
    entryFiles.set(id, bytes);
  })();
  for (const fileName of files) {
    const stagingMatch = ENTRY_STAGING_PATTERN.exec(fileName);
    if (stagingMatch !== null) {
      activeLock = activeLock ?? await readActiveCasLock(directory);
      const stagedId = stagingMatch[1]!;
      if (activeLock === null || !activeLock.touchedEntryIds.has(stagedId)
        || fileName !== `${stagedId}.md.tmp-${activeLock.pid}-${activeLock.nonce}`) {
        fail('MEMORY_SCOPE_VIOLATION', `${memoryDirectoryFor(taskpack)}/entries/${fileName}`, 'staging temporary outside an active apply');
      }
      continue;
    }
    if (!fileName.endsWith('.md')) fail('MEMORY_SCHEMA_INVALID', `${memoryDirectoryFor(taskpack)}/entries/${fileName}`, 'unexpected non-markdown file');
    if (forbiddenMemoryArtifactName(fileName)) fail('MEMORY_SCHEMA_INVALID', `${memoryDirectoryFor(taskpack)}/entries/${fileName}`, 'forbidden artifact name in memory store');
    const id = fileName.slice(0, -'.md'.length);
    if (!indexedIds.has(id)) {
      activeLock = activeLock ?? await readActiveCasLock(directory);
      if (activeLock === null || !activeLock.touchedEntryIds.has(id)) fail('MEMORY_SCHEMA_INVALID', `${memoryDirectoryFor(taskpack)}/entries/${fileName}`, 'entry file has no index row');
      continue;
    }
  }
  const authoritative = new Map<string, MemoryEntry>();
  for (const entry of index.entries) authoritative.set(entry.id, entry);
  for (const row of [...index.retired].reverse()) if (!authoritative.has(row.entry.id)) authoritative.set(row.entry.id, row.entry);
  await Promise.all([...authoritative].map(([id, row]) => markIndexed(id, row, `${memoryDirectoryFor(taskpack)}/entries/${id}.md`)));
  return Object.freeze({ index, entryFiles });
}

export interface CodeFingerprintEntry { readonly path: string; readonly sha256: string; readonly byteLength: number }
export function compileScopePattern(pattern: string): RegExp {
  const segments = pattern.split('/');
  let source = '';
  segments.forEach((segment, index) => {
    const last = index === segments.length - 1;
    if (segment === '**') {
      source += last ? '[^/]+(?:/[^/]+)*' : '(?:[^/]+/)*';
      return;
    }
    let piece = '';
    for (const character of segment) {
      if (character === '*') piece += '[^/]*';
      else if (character === '?') piece += '[^/]';
      else piece += character.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    }
    source += piece;
    if (!last) source += '/';
  });
  return new RegExp(`^${source}$`);
}
export function matchScopePattern(pattern: string, path: string): boolean {
  return compileScopePattern(pattern).test(path);
}
async function collectFiles(root: string, directory: string, out: string[]): Promise<void> {
  const names = await readdir(directory, { withFileTypes: true });
  for (const entry of names) {
    if (entry.isSymbolicLink()) continue;
    const full = join(directory, entry.name);
    if (entry.isDirectory()) await collectFiles(root, full, out);
    else if (entry.isFile()) out.push(relative(root, full).split('\\').join('/'));
  }
}
/** Deterministic SHA-256 over the sorted `{ path, sha256, byteLength }` manifest of the files matching `paths`. */
export async function computeCodeFingerprint(repository: string, paths: readonly string[]): Promise<Digest> {
  const root = resolve(repository);
  const all: string[] = [];
  await collectFiles(root, root, all);
  all.sort();
  const matchers = [...paths].map(compileScopePattern);
  const manifest: CodeFingerprintEntry[] = [];
  for (const path of all) {
    if (!matchers.some(matcher => matcher.test(path))) continue;
    const bytes = await readFile(join(root, path));
    manifest.push({ path, sha256: createHash('sha256').update(bytes).digest('hex'), byteLength: bytes.byteLength });
  }
  manifest.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  return hashDomain('memory-code-fingerprint', manifest);
}
export function entryFileBytes(entry: MemoryEntry): Uint8Array {
  return Buffer.from(renderEntryMarkdown(entry), 'utf8');
}
export interface ProjectedMemoryStore {
  readonly index: MemoryStoreIndex;
  readonly entryFiles: ReadonlyMap<string, Uint8Array>;
  readonly retiredRows: readonly RetiredMemoryEntry[];
}
/** Purely projects operations onto a base index; used for patch previews and atomic CAS application. */
export function projectMemoryStore(base: MemoryStoreIndex, operations: readonly MemoryOperation[], nowMs: number, proposalId: string): ProjectedMemoryStore {
  const entries = new Map<string, MemoryEntry>(base.entries.map(entry => [entry.id, entry]));
  const retiredById = new Map<string, RetiredMemoryEntry>(base.retired.map(row => [row.entry.id, row]));
  const supersededBy = new Map<string, string>();
  const handledBySupersession = new Set<string>();
  for (const operation of operations) {
    if (operation.kind !== 'upsert') continue;
    for (const id of operation.entry.supersedes) if (!supersededBy.has(id)) supersededBy.set(id, operation.entry.id);
  }
  const retire = (entry: MemoryEntry, successor: string | null): void => {
    retiredById.set(entry.id, { entry, retiredAtMs: nowMs, retiredByProposalId: proposalId, supersededByEntryId: successor });
  };
  for (const [index, operation] of operations.entries()) {
    if (operation.kind === 'upsert') {
      for (const id of operation.entry.supersedes) {
        const prior = entries.get(id);
        if (prior === undefined) continue;
        entries.delete(id);
        handledBySupersession.add(id);
        retire(prior, operation.entry.id);
      }
      entries.set(operation.entry.id, operation.entry);
      continue;
    }
    const existing = entries.get(operation.entryId);
    if (!existing) {
      if (handledBySupersession.has(operation.entryId)) continue;
      fail('MEMORY_SCHEMA_INVALID', `/operations/${index}`, `retire target ${operation.entryId} is not a projected active entry`);
    }
    entries.delete(operation.entryId);
    retire(existing, supersededBy.get(operation.entryId) ?? null);
  }
  const sorted = [...entries.values()].sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  const retiredSorted = [...retiredById.values()].sort((a, b) => a.entry.id < b.entry.id ? -1 : a.entry.id > b.entry.id ? 1 : 0);
  const baseContent = { version: 1 as const, taskpack: base.taskpack, repository: base.repository,
    updatedAtMs: operations.length === 0 ? base.updatedAtMs : nowMs, entries: sorted, retired: retiredSorted };
  const index: MemoryStoreIndex = Object.freeze({ ...baseContent, storeDigest: storeDigestOf(baseContent) });
  const entryFiles = new Map<string, Uint8Array>(sorted.map(entry => [entry.id, entryFileBytes(entry)]));
  return { index, entryFiles, retiredRows: retiredSorted };
}
export async function ensureMemoryDirectories(repository: string, taskpack: string): Promise<string> {
  const directory = join(resolve(repository), '.loopwright', 'memory', taskpack, 'entries');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  return directory;
}
