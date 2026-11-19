import { createHash } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import { lstat, mkdir, open, readFile, readdir } from 'node:fs/promises';
import { join, relative, resolve } from 'node:path';
import type { Digest } from '@loopwright/core';
import { canonical, fail, hashDomain, hasControlCharacter, memoryIdentifierPattern, memoryStoreIndexSchema, parseEntryMarkdown, renderEntryMarkdown, storeDigestOf } from './schema.js';
import {
  DEFAULT_MEMORY_MAX_ENTRIES,
  DEFAULT_MEMORY_MAX_PROMPT_BYTES,
  DEFAULT_MEMORY_MAX_PROMPT_ENTRIES,
  DEFAULT_MEMORY_TTL_DAYS,
  DEFAULT_MEMORY_TTL_MS,
  MAX_MEMORY_ENTRY_FILE_BYTES,
  MAX_MEMORY_INDEX_FILE_BYTES,
  type MemoryEntry,
  type MemoryEntryKind,
  type MemoryOperation,
  type MemoryStoreIndex,
  type RetiredMemoryEntry,
} from './types.js';

export {
  DEFAULT_MEMORY_MAX_ENTRIES,
  DEFAULT_MEMORY_MAX_PROMPT_BYTES,
  DEFAULT_MEMORY_MAX_PROMPT_ENTRIES,
  DEFAULT_MEMORY_TTL_DAYS,
  DEFAULT_MEMORY_TTL_MS,
  MAX_MEMORY_ENTRY_FILE_BYTES,
  MAX_MEMORY_INDEX_FILE_BYTES,
};

export const MEMORY_ROOT = '.loopwright/memory';
const TASKPACK_DIRECTORY_ENTRIES = ['index.json', 'entries', '.cas.lock'];
const ENTRY_STAGING_PATTERN = /^([a-z0-9][a-z0-9._-]{0,127})\.md\.tmp-[0-9]+-[0-9a-f]+$/;
const RESERVED_SEGMENT_PATTERN = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i;

function validateSafeSegment(
  segment: string,
  pathLabel: string,
  options?: { readonly rejectReservedDeviceNames?: boolean },
): void {
  if (
    typeof segment !== 'string'
    || segment.length === 0
    || segment.length > 128
    || segment === '.'
    || segment === '..'
    || segment.endsWith('.')
    || segment.includes('/')
    || segment.includes('\\')
    || hasControlCharacter(segment)
  ) {
    fail('MEMORY_SCHEMA_INVALID', pathLabel, 'memoryRoot contains an invalid path segment');
  }
  const lower = segment.toLowerCase();
  const reservedRejected = options?.rejectReservedDeviceNames === true && RESERVED_SEGMENT_PATTERN.test(segment);
  if (lower === '.git' || lower === '.github' || reservedRejected || !/^[A-Za-z0-9._-]+$/.test(segment)) {
    fail('MEMORY_SCHEMA_INVALID', pathLabel, `memoryRoot segment ${segment} is forbidden`);
  }
}

async function assertNoCaseAliasSibling(parentDir: string, segment: string, relLabel: string): Promise<boolean> {
  const entries = await readdir(parentDir);
  const foldedSegment = segment.normalize('NFC').toLowerCase();
  let exactExists = false;
  for (const name of entries) {
    if (name === segment) {
      exactExists = true;
      continue;
    }
    if (name.normalize('NFC').toLowerCase() === foldedSegment) {
      fail('MEMORY_SCOPE_VIOLATION', relLabel, `path segment ${segment} aliases existing entry ${name} with different case`);
    }
  }
  return exactExists;
}

export function normalizeMemoryRoot(memoryRoot: string = MEMORY_ROOT): string {
  if (typeof memoryRoot !== 'string' || memoryRoot.length === 0 || memoryRoot.length > 256) {
    fail('MEMORY_SCHEMA_INVALID', '/memoryRoot', 'memoryRoot must be a non-empty repo-relative path up to 256 characters');
  }
  if (memoryRoot.startsWith('/') || memoryRoot.endsWith('/') || memoryRoot.includes('\\') || hasControlCharacter(memoryRoot)) {
    fail('MEMORY_SCHEMA_INVALID', '/memoryRoot', 'memoryRoot must be a normalized repo-relative POSIX path');
  }
  const segments = memoryRoot.split('/');
  if (segments.length > 16) fail('MEMORY_SCHEMA_INVALID', '/memoryRoot', 'memoryRoot exceeds maximum segment depth');
  for (const segment of segments) {
    validateSafeSegment(segment, '/memoryRoot', { rejectReservedDeviceNames: true });
  }
  const lowerRoot = memoryRoot.toLowerCase();
  if (lowerRoot === '.loopwright/policies' || lowerRoot.startsWith('.loopwright/policies/')) {
    fail('MEMORY_SCOPE_VIOLATION', '/memoryRoot', 'memoryRoot cannot target protected .loopwright/policies area');
  }
  return memoryRoot;
}

export function memoryDirectoryFor(taskpack: string, memoryRoot: string = MEMORY_ROOT): string {
  const normalizedRoot = normalizeMemoryRoot(memoryRoot);
  return `${normalizedRoot}/${taskpack}`;
}
export function forbiddenMemoryArtifactName(name: string): boolean {
  return name.endsWith('.sqlite') || name === 'run.json' || name.startsWith('privateSession') || /checkpoint/i.test(name);
}
export function isMemoryManagedPath(taskpack: string, path: string, memoryRoot: string = MEMORY_ROOT): boolean {
  if (!memoryIdentifierPattern.test(taskpack) || taskpack.length > 128) return false;
  if (path.startsWith('/') || path.includes('\\')) return false;
  const segments = path.split('/');
  if (segments.some(segment => segment.length === 0)) return false;
  if (segments.includes('..') || segments.includes('.')) return false;
  if (hasControlCharacter(path)) return false;
  let directory: string;
  try { directory = memoryDirectoryFor(taskpack, memoryRoot); } catch { return false; }
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
async function readRegularFile(path: string, label: string, maxBytes: number): Promise<Uint8Array> {
  const stats = await lstat(path);
  if (stats.isSymbolicLink()) fail('MEMORY_SCHEMA_INVALID', label, 'symbolic links are refused in the memory store');
  if (!stats.isFile()) fail('MEMORY_SCHEMA_INVALID', label, 'expected a regular file');
  if (stats.size > maxBytes) fail('MEMORY_SCHEMA_INVALID', label, 'memory file exceeds maximum byte bound');
  let handle: Awaited<ReturnType<typeof open>> | null = null;
  try {
    handle = await open(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    const fdStats = await handle.stat();
    if (!fdStats.isFile()) fail('MEMORY_SCHEMA_INVALID', label, 'expected a regular file');
    if (fdStats.size > maxBytes) fail('MEMORY_SCHEMA_INVALID', label, 'memory file exceeds maximum byte bound');
    const bytes = await handle.readFile();
    if (bytes.byteLength > maxBytes) fail('MEMORY_SCHEMA_INVALID', label, 'memory file exceeds maximum byte bound');
    return bytes;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ELOOP') {
      fail('MEMORY_SCHEMA_INVALID', label, 'symbolic links are refused in the memory store');
    }
    throw error;
  } finally {
    if (handle !== null) await handle.close();
  }
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
/** Reads `<repository>/<memoryRoot>/<taskpack>/`; a missing store reads as empty under `repositorySlug`. */
export async function loadMemoryStore(
  repository: string,
  taskpack: string,
  repositorySlug: string,
  memoryRoot: string = MEMORY_ROOT,
): Promise<LoadedMemoryStore> {
  if (!memoryIdentifierPattern.test(taskpack) || taskpack.length > 128) fail('MEMORY_SCHEMA_INVALID', '/taskpack', 'identifier pattern mismatch');
  const normalizedRoot = normalizeMemoryRoot(memoryRoot);
  const dirLabel = memoryDirectoryFor(taskpack, normalizedRoot);
  const root = resolve(repository);
  const repoStats = await lstat(root).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
  if (repoStats === null) return { index: emptyMemoryStoreIndex(taskpack, repositorySlug, 0), entryFiles: new Map() };
  if (repoStats.isSymbolicLink()) fail('MEMORY_SCHEMA_INVALID', '/repository', 'symbolic links are refused in the memory store');
  if (!repoStats.isDirectory()) fail('MEMORY_SCHEMA_INVALID', '/repository', 'expected a directory');
  let cursor = root;
  let relCursor = '';
  for (const segment of normalizedRoot.split('/')) {
    const parentDir = cursor;
    cursor = join(cursor, segment);
    relCursor = relCursor.length === 0 ? segment : `${relCursor}/${segment}`;
    const exactExists = await assertNoCaseAliasSibling(parentDir, segment, relCursor);
    if (!exactExists) return { index: emptyMemoryStoreIndex(taskpack, repositorySlug, 0), entryFiles: new Map() };
    const segStats = await lstat(cursor).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return null;
      throw error;
    });
    if (segStats === null) return { index: emptyMemoryStoreIndex(taskpack, repositorySlug, 0), entryFiles: new Map() };
    if (segStats.isSymbolicLink()) fail('MEMORY_SCHEMA_INVALID', relCursor, 'symbolic links are refused in the memory store');
    if (!segStats.isDirectory()) fail('MEMORY_SCHEMA_INVALID', relCursor, 'expected a directory');
  }
  const memoryRootDir = cursor;
  const directory = join(memoryRootDir, taskpack);
  const taskpackExists = await assertNoCaseAliasSibling(memoryRootDir, taskpack, dirLabel);
  if (!taskpackExists) return { index: emptyMemoryStoreIndex(taskpack, repositorySlug, 0), entryFiles: new Map() };
  const stats = await lstat(directory).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return null; throw error;
  });
  if (stats === null) return { index: emptyMemoryStoreIndex(taskpack, repositorySlug, 0), entryFiles: new Map() };
  if (stats.isSymbolicLink()) fail('MEMORY_SCHEMA_INVALID', dirLabel, 'symbolic links are refused in the memory store');
  if (!stats.isDirectory()) fail('MEMORY_SCHEMA_INVALID', dirLabel, 'expected a directory');
  await refuseForbiddenNames(memoryRootDir, normalizedRoot);
  const taskpackNames = await readdir(directory);
  let activeLock = await readActiveCasLock(directory);
  for (const name of taskpackNames) {
    if (TASKPACK_DIRECTORY_ENTRIES.includes(name)) continue;
    if (activeLock !== null && name === `index.json.tmp-${activeLock.pid}-${activeLock.nonce}`) continue;
    fail('MEMORY_SCOPE_VIOLATION', `${dirLabel}/${name}`, 'unexpected file in memory directory');
  }
  const entriesDirectory = join(directory, 'entries');
  const entriesStats = await lstat(entriesDirectory).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return null; throw error;
  });
  const indexBytes = await (async (): Promise<Uint8Array | null> => {
    try { return await readRegularFile(join(directory, 'index.json'), `${dirLabel}/index.json`, MAX_MEMORY_INDEX_FILE_BYTES); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
  })();
  if (indexBytes === null) {
    if (entriesStats !== null && (entriesStats.isSymbolicLink() || !entriesStats.isDirectory())) {
      fail('MEMORY_SCHEMA_INVALID', `${dirLabel}/entries`, 'expected a directory');
    }
    const existing = entriesStats === null ? [] : await readdir(entriesDirectory);
    if (existing.length > 0) fail('MEMORY_SCHEMA_INVALID', `${dirLabel}/index.json`, 'entry files exist without an index');
    return { index: emptyMemoryStoreIndex(taskpack, repositorySlug, 0), entryFiles: new Map() };
  }
  let parsedIndex: unknown;
  try { parsedIndex = JSON.parse(Buffer.from(indexBytes).toString('utf8')); } catch { fail('MEMORY_SCHEMA_INVALID', `${dirLabel}/index.json`, 'index is not JSON'); }
  const index = memoryStoreIndexSchema(parsedIndex, dirLabel);
  if (index.taskpack !== taskpack) fail('MEMORY_SCHEMA_INVALID', `${dirLabel}/index.json/taskpack`, 'index taskpack does not match directory');
  if (entriesStats === null) {
    if (index.entries.length === 0) {
      return Object.freeze({ index, entryFiles: new Map() });
    }
    fail('MEMORY_SCHEMA_INVALID', `${dirLabel}/entries`, 'entries directory missing');
  }
  if (entriesStats.isSymbolicLink() || !entriesStats.isDirectory()) fail('MEMORY_SCHEMA_INVALID', `${dirLabel}/entries`, 'expected a directory');
  const files = await readdir(entriesDirectory);
  const activeById = new Map<string, MemoryEntry>(index.entries.map(entry => [entry.id, entry]));
  const retiredIds = new Set<string>(index.retired.map(row => row.entry.id));
  const indexedIds = new Set<string>([...activeById.keys(), ...retiredIds]);
  const committedBytes = (row: MemoryEntry): Uint8Array => entryFileBytes(row);
  const entryFiles = new Map<string, Uint8Array>();
  const markActiveIndexed = (id: string, row: MemoryEntry, path: string): Promise<void> => (async () => {
    let bytes: Uint8Array;
    try {
      bytes = await readRegularFile(join(entriesDirectory, `${id}.md`), path, MAX_MEMORY_ENTRY_FILE_BYTES);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        activeLock = activeLock ?? await readActiveCasLock(directory);
        if (activeLock !== null && activeLock.touchedEntryIds.has(id)) {
          entryFiles.set(id, committedBytes(row));
          return;
        }
        fail('MEMORY_SCHEMA_INVALID', path, 'index row has no entry file');
      }
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
  const markLegacyRetired = (id: string, path: string): Promise<void> => (async () => {
    try {
      const bytes = await readRegularFile(join(entriesDirectory, `${id}.md`), path, MAX_MEMORY_ENTRY_FILE_BYTES);
      entryFiles.set(id, bytes);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw error;
    }
  })();
  for (const fileName of files) {
    const stagingMatch = ENTRY_STAGING_PATTERN.exec(fileName);
    if (stagingMatch !== null) {
      activeLock = activeLock ?? await readActiveCasLock(directory);
      const stagedId = stagingMatch[1]!;
      if (activeLock === null || !activeLock.touchedEntryIds.has(stagedId)
        || fileName !== `${stagedId}.md.tmp-${activeLock.pid}-${activeLock.nonce}`) {
        fail('MEMORY_SCOPE_VIOLATION', `${dirLabel}/entries/${fileName}`, 'staging temporary outside an active apply');
      }
      continue;
    }
    if (!fileName.endsWith('.md')) fail('MEMORY_SCHEMA_INVALID', `${dirLabel}/entries/${fileName}`, 'unexpected non-markdown file');
    if (forbiddenMemoryArtifactName(fileName)) fail('MEMORY_SCHEMA_INVALID', `${dirLabel}/entries/${fileName}`, 'forbidden artifact name in memory store');
    const id = fileName.slice(0, -'.md'.length);
    if (!indexedIds.has(id)) {
      activeLock = activeLock ?? await readActiveCasLock(directory);
      if (activeLock === null || !activeLock.touchedEntryIds.has(id)) fail('MEMORY_SCHEMA_INVALID', `${dirLabel}/entries/${fileName}`, 'entry file has no index row');
      continue;
    }
  }
  const legacyRetiredOnlyIds = [...retiredIds].filter(id => !activeById.has(id));
  await Promise.all([
    ...[...activeById].map(([id, row]) => markActiveIndexed(id, row, `${dirLabel}/entries/${id}.md`)),
    ...legacyRetiredOnlyIds.map(id => markLegacyRetired(id, `${dirLabel}/entries/${id}.md`)),
  ]);
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
    if (entry.name === '.git' && directory === root) continue;
    if (entry.isSymbolicLink()) continue;
    const full = join(directory, entry.name);
    if (entry.isDirectory()) await collectFiles(root, full, out);
    else if (entry.isFile()) out.push(relative(root, full).split('\\').join('/'));
  }
}
/** Deterministic SHA-256 over the sorted `{ path, sha256, byteLength }` manifest of the files matching `paths` outside `memoryRoot`. */
export async function computeCodeFingerprint(
  repository: string,
  paths: readonly string[],
  memoryRoot: string = MEMORY_ROOT,
): Promise<Digest> {
  const root = resolve(repository);
  const normalizedMemoryRoot = normalizeMemoryRoot(memoryRoot);
  const memoryRootPrefix = `${normalizedMemoryRoot}/`;
  const all: string[] = [];
  await collectFiles(root, root, all);
  all.sort();
  const matchers = [...paths].map(compileScopePattern);
  const manifest: CodeFingerprintEntry[] = [];
  for (const path of all) {
    if (path === normalizedMemoryRoot || path.startsWith(memoryRootPrefix)) continue;
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
const EVICTION_KIND_PRIORITY: Readonly<Record<MemoryEntryKind, number>> = {
  failure_observation: 0,
  fact: 1,
  invariant: 2,
};
export function clampMemoryMaxEntries(maxEntries: number | undefined): number {
  if (maxEntries === undefined || !Number.isFinite(maxEntries)) return DEFAULT_MEMORY_MAX_ENTRIES;
  return Math.min(1024, Math.max(1, Math.trunc(maxEntries)));
}
export function compareEntriesForEviction(a: MemoryEntry, b: MemoryEntry): number {
  const kindDiff = EVICTION_KIND_PRIORITY[a.kind] - EVICTION_KIND_PRIORITY[b.kind];
  if (kindDiff !== 0) return kindDiff;
  if (a.verifiedAtMs !== b.verifiedAtMs) return a.verifiedAtMs - b.verifiedAtMs;
  if (a.expiresAtMs !== b.expiresAtMs) return a.expiresAtMs - b.expiresAtMs;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}
export interface ProjectedMemoryStore {
  readonly index: MemoryStoreIndex;
  readonly entryFiles: ReadonlyMap<string, Uint8Array>;
  readonly retiredRows: readonly RetiredMemoryEntry[];
}
/** Purely projects operations onto a base index; used for patch previews and atomic CAS application. */
export function projectMemoryStore(
  base: MemoryStoreIndex,
  operations: readonly MemoryOperation[],
  nowMs: number,
  proposalId: string,
  options?: { readonly maxEntries?: number | undefined },
): ProjectedMemoryStore {
  void proposalId;
  const entries = new Map<string, MemoryEntry>(base.entries.map(entry => [entry.id, entry]));
  const handledBySupersession = new Set<string>();
  for (const [index, operation] of operations.entries()) {
    if (operation.kind === 'upsert') {
      for (const id of operation.entry.supersedes) {
        if (entries.delete(id)) handledBySupersession.add(id);
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
  }
  const effectiveMaxEntries = clampMemoryMaxEntries(options?.maxEntries);
  let evicted = false;
  if (entries.size > effectiveMaxEntries) {
    const evictionOrder = [...entries.values()].sort(compareEntriesForEviction);
    const excessCount = entries.size - effectiveMaxEntries;
    for (let i = 0; i < excessCount; i += 1) {
      entries.delete(evictionOrder[i]!.id);
    }
    evicted = true;
  }
  const sorted = [...entries.values()].sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  const mutated = operations.length > 0 || base.retired.length > 0 || evicted;
  const retired: readonly RetiredMemoryEntry[] = Object.freeze([]);
  const baseContent = {
    version: 1 as const,
    taskpack: base.taskpack,
    repository: base.repository,
    updatedAtMs: mutated ? nowMs : base.updatedAtMs,
    entries: Object.freeze(sorted),
    retired,
  };
  const index: MemoryStoreIndex = Object.freeze({ ...baseContent, storeDigest: storeDigestOf(baseContent) });
  const entryFiles = new Map<string, Uint8Array>(sorted.map(entry => [entry.id, entryFileBytes(entry)]));
  return { index, entryFiles, retiredRows: retired };
}
export async function ensureSafeDirectoryChain(repository: string, segments: readonly string[]): Promise<string> {
  if (!Array.isArray(segments) || segments.length === 0 || segments.length > 18) {
    fail('MEMORY_SCHEMA_INVALID', '/segments', 'segments length outside 1..18');
  }
  const root = resolve(repository);
  const repoStats = await lstat(root);
  if (repoStats.isSymbolicLink()) fail('MEMORY_SCHEMA_INVALID', '/repository', 'symbolic links are refused in the memory store');
  if (!repoStats.isDirectory()) fail('MEMORY_SCHEMA_INVALID', '/repository', 'expected a directory');
  let cursor = root;
  let relCursor = '';
  for (const segment of segments) {
    validateSafeSegment(segment, '/segments');
    const parentDir = cursor;
    cursor = join(cursor, segment);
    relCursor = relCursor.length === 0 ? segment : `${relCursor}/${segment}`;
    const lowerPrefix = relCursor.toLowerCase();
    if (lowerPrefix === '.loopwright/policies' || lowerPrefix.startsWith('.loopwright/policies/')) {
      fail('MEMORY_SCOPE_VIOLATION', relCursor, 'directory chain cannot target protected .loopwright/policies area');
    }
    const exactExists = await assertNoCaseAliasSibling(parentDir, segment, relCursor);
    let stats = exactExists
      ? await lstat(cursor).catch((error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT') return null;
        throw error;
      })
      : null;
    if (stats === null) {
      await mkdir(cursor, { mode: 0o700 }).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== 'EEXIST') throw error;
      });
      await assertNoCaseAliasSibling(parentDir, segment, relCursor);
      stats = await lstat(cursor);
    }
    if (stats.isSymbolicLink()) fail('MEMORY_SCHEMA_INVALID', relCursor, 'symbolic links are refused in the memory store');
    if (!stats.isDirectory()) fail('MEMORY_SCHEMA_INVALID', relCursor, 'expected a directory');
  }
  return cursor;
}
export async function ensureMemoryDirectories(
  repository: string,
  taskpack: string,
  memoryRoot: string = MEMORY_ROOT,
): Promise<string> {
  if (!memoryIdentifierPattern.test(taskpack) || taskpack.length > 128) fail('MEMORY_SCHEMA_INVALID', '/taskpack', 'identifier pattern mismatch');
  const normalizedRoot = normalizeMemoryRoot(memoryRoot);
  return ensureSafeDirectoryChain(repository, [...normalizedRoot.split('/'), taskpack, 'entries']);
}
