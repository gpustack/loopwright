import { createHash, randomBytes } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open, readdir, realpath, rename, unlink } from 'node:fs/promises';
import { dirname, join, posix, resolve, sep } from 'node:path';
import {
  TaskpackError,
  type TaskpackDigestDrift,
  type TaskpackDigestLockfile,
  type TaskpackDigestLockfileEntry,
  type TaskpackDigestTarget,
  type TaskpackDigestVerificationResult,
  type TaskpackManifest,
  type TaskpackV2Manifest,
} from './types.js';
import { IDENTIFIER_PATTERN, normalizeRelativePath, parseJsonSubset, tryNormalizeRelativePath } from './schema.js';

export const DIGEST_STREAM_CHUNK_BYTES = 1_048_576;
export const DIGEST_MAX_FILE_BYTES = 16 * 1024 * 1024;
export const DIGEST_MAX_TREE_FILES = 1_024;
export const DIGEST_MAX_TREE_BYTES = 64 * 1024 * 1024;
export const DIGEST_MAX_TREE_DEPTH = 32;
export const DIGEST_LOCKFILE_MAX_BYTES = 262_144;
export const DIGEST_LOCKFILE_MAX_ENTRIES = 512;

const SHA256_HEX_PATTERN = /^[0-9a-f]{64}$/;
const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

export interface DirectoryTreeFileDigest {
  readonly path: string;
  readonly sha256: string;
  readonly bytes: number;
}

export interface DirectoryTreeDigestResult {
  readonly digest: string;
  readonly files: readonly DirectoryTreeFileDigest[];
}

export interface DigestLimitsOptions {
  readonly maxFileBytes?: number | undefined;
  readonly maxTreeFiles?: number | undefined;
  readonly maxTreeBytes?: number | undefined;
  readonly maxTreeDepth?: number | undefined;
}

function compareCodePoint(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function isContainedInRoot(candidate: string, realRoot: string): boolean {
  if (candidate === realRoot) return true;
  const prefix = realRoot.endsWith(sep) ? realRoot : `${realRoot}${sep}`;
  return candidate.startsWith(prefix);
}

async function resolveSafeRepoRoot(repoRoot: string): Promise<{ resolvedRoot: string; realRoot: string }> {
  const resolvedRoot = resolve(repoRoot);
  const rootStat = await lstat(resolvedRoot).catch(() => null);
  if (rootStat === null || rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
    throw new TaskpackError('TASKPACK_MANIFEST_INVALID', 'repository root must be an existing non-symlink directory', '/');
  }
  const realRoot = await realpath(resolvedRoot).catch(() => {
    throw new TaskpackError('TASKPACK_MANIFEST_INVALID', 'repository root cannot be resolved', '/');
  });
  return { resolvedRoot, realRoot };
}

async function resolveExistingSafeSubpath(
  repoRoot: string,
  relPath: string,
  diagPath: string,
): Promise<{ fullPath: string; realRoot: string; realFullPath: string }> {
  const normalized = normalizeRelativePath(relPath, diagPath);
  const { resolvedRoot, realRoot } = await resolveSafeRepoRoot(repoRoot);
  const segments = normalized.split('/');
  let current = resolvedRoot;
  for (const segment of segments) {
    current = join(current, segment);
    const st = await lstat(current).catch(() => null);
    if (st === null) {
      throw new TaskpackError('TASKPACK_MANIFEST_INVALID', `path "${normalized}" does not exist`, diagPath);
    }
    if (st.isSymbolicLink()) {
      throw new TaskpackError('TASKPACK_SCOPE_VIOLATION', `path "${normalized}" must not traverse or target symbolic links`, diagPath);
    }
  }
  const realFullPath = await realpath(current).catch(() => {
    throw new TaskpackError('TASKPACK_MANIFEST_INVALID', `path "${normalized}" cannot be resolved`, diagPath);
  });
  if (!isContainedInRoot(realFullPath, realRoot)) {
    throw new TaskpackError('TASKPACK_SCOPE_VIOLATION', `path "${normalized}" escapes repository root`, diagPath);
  }
  return { fullPath: current, realRoot, realFullPath };
}

/**
 * Stream a regular non-symlink, non-hardlinked (`nlink === 1`) file in `64 KiB` chunks
 * through `O_RDONLY | O_NOFOLLOW` into SHA-256 with pre/post `fstat` stability checks.
 */
async function hashStreamedRegularFile(
  fullPath: string,
  maxFileBytes: number,
  diagPath: string,
): Promise<{ sha256: string; bytes: number }> {
  let before;
  try {
    before = await lstat(fullPath);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | null)?.code;
    if (code === 'ELOOP') {
      throw new TaskpackError('TASKPACK_SCOPE_VIOLATION', `${diagPath}: symbolic link traversal is forbidden`, diagPath);
    }
    throw new TaskpackError('TASKPACK_MANIFEST_INVALID', `${diagPath}: file does not exist or cannot be inspected`, diagPath);
  }
  if (before.isSymbolicLink()) {
    throw new TaskpackError('TASKPACK_SCOPE_VIOLATION', `${diagPath}: file must not be a symbolic link`, diagPath);
  }
  if (!before.isFile()) {
    throw new TaskpackError('TASKPACK_MANIFEST_INVALID', `${diagPath}: path must be a regular file`, diagPath);
  }
  if (before.nlink !== 1) {
    throw new TaskpackError('TASKPACK_SCOPE_VIOLATION', `${diagPath}: hardlinked file (nlink=${before.nlink}) is forbidden`, diagPath);
  }
  if (before.size > maxFileBytes) {
    throw new TaskpackError('TASKPACK_MANIFEST_INVALID', `${diagPath}: file exceeds ${maxFileBytes} bytes`, diagPath);
  }

  const noFollow = 'O_NOFOLLOW' in constants ? constants.O_NOFOLLOW : 0;
  let handle;
  try {
    handle = await open(fullPath, constants.O_RDONLY | noFollow);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | null)?.code;
    if (code === 'ELOOP') {
      throw new TaskpackError('TASKPACK_SCOPE_VIOLATION', `${diagPath}: symbolic link detected while opening file`, diagPath);
    }
    throw new TaskpackError('TASKPACK_MANIFEST_INVALID', `${diagPath}: file could not be opened`, diagPath);
  }

  try {
    const info = await handle.stat();
    if (!info.isFile() || info.nlink !== 1 || info.dev !== before.dev || info.ino !== before.ino) {
      throw new TaskpackError('TASKPACK_SCOPE_VIOLATION', `${diagPath}: file identity or link count changed while opening`, diagPath);
    }
    if (info.size !== before.size || info.size > maxFileBytes) {
      throw new TaskpackError('TASKPACK_MANIFEST_INVALID', `${diagPath}: file changed size while loading or exceeds ${maxFileBytes} bytes`, diagPath);
    }

    const hash = createHash('sha256');
    const chunk = Buffer.allocUnsafe(Math.min(DIGEST_STREAM_CHUNK_BYTES, Math.max(1, info.size)));
    let offset = 0;
    while (offset < info.size) {
      const toRead = Math.min(chunk.byteLength, info.size - offset);
      const { bytesRead } = await handle.read(chunk, 0, toRead, offset);
      if (bytesRead <= 0) break;
      hash.update(chunk.subarray(0, bytesRead));
      offset += bytesRead;
    }
    // Probe one byte past expected EOF to catch concurrent file growth.
    const extra = await handle.read(chunk, 0, 1, offset);
    const after = await handle.stat();
    if (
      extra.bytesRead !== 0
      || offset !== info.size
      || after.size !== info.size
      || after.nlink !== 1
      || after.dev !== info.dev
      || after.ino !== info.ino
      || after.mtimeMs !== info.mtimeMs
      || after.ctimeMs !== info.ctimeMs
    ) {
      throw new TaskpackError('TASKPACK_MANIFEST_INVALID', `${diagPath}: file mutated while hashing`, diagPath);
    }
    return { sha256: hash.digest('hex'), bytes: offset };
  } finally {
    await handle.close();
  }
}

/** Bounded control-file reader used exclusively for small `digests.lock.json` documents. */
async function readBoundedControlFile(fullPath: string, maxBytes: number, diagPath: string): Promise<Buffer> {
  let before;
  try {
    before = await lstat(fullPath);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | null)?.code;
    if (code === 'ELOOP') {
      throw new TaskpackError('TASKPACK_SCOPE_VIOLATION', `${diagPath}: symbolic link traversal is forbidden`, diagPath);
    }
    throw new TaskpackError('TASKPACK_MANIFEST_INVALID', `${diagPath}: file does not exist or cannot be inspected`, diagPath);
  }
  if (before.isSymbolicLink()) {
    throw new TaskpackError('TASKPACK_SCOPE_VIOLATION', `${diagPath}: file must not be a symbolic link`, diagPath);
  }
  if (!before.isFile()) {
    throw new TaskpackError('TASKPACK_MANIFEST_INVALID', `${diagPath}: path must be a regular file`, diagPath);
  }
  if (before.nlink !== 1) {
    throw new TaskpackError('TASKPACK_SCOPE_VIOLATION', `${diagPath}: hardlinked file (nlink=${before.nlink}) is forbidden`, diagPath);
  }
  if (before.size > maxBytes) {
    throw new TaskpackError('TASKPACK_MANIFEST_INVALID', `${diagPath}: file exceeds ${maxBytes} bytes`, diagPath);
  }
  const noFollow = 'O_NOFOLLOW' in constants ? constants.O_NOFOLLOW : 0;
  let handle;
  try {
    handle = await open(fullPath, constants.O_RDONLY | noFollow);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | null)?.code;
    if (code === 'ELOOP') {
      throw new TaskpackError('TASKPACK_SCOPE_VIOLATION', `${diagPath}: symbolic link detected while opening file`, diagPath);
    }
    throw new TaskpackError('TASKPACK_MANIFEST_INVALID', `${diagPath}: file could not be opened`, diagPath);
  }
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.nlink !== 1 || info.dev !== before.dev || info.ino !== before.ino) {
      throw new TaskpackError('TASKPACK_SCOPE_VIOLATION', `${diagPath}: file identity or link count changed while opening`, diagPath);
    }
    if (info.size !== before.size || info.size > maxBytes) {
      throw new TaskpackError('TASKPACK_MANIFEST_INVALID', `${diagPath}: file changed size while loading or exceeds ${maxBytes} bytes`, diagPath);
    }
    const buf = Buffer.alloc(info.size + 1);
    let size = 0;
    while (size < buf.length) {
      const read = await handle.read(buf, size, buf.length - size, size);
      if (!read.bytesRead) break;
      size += read.bytesRead;
    }
    if (size !== info.size) {
      throw new TaskpackError('TASKPACK_MANIFEST_INVALID', `${diagPath}: file changed while loading`, diagPath);
    }
    return buf.subarray(0, size);
  } finally {
    await handle.close();
  }
}

/**
 * Compute the lowercase SHA-256 hex digest of a single regular file inside `repoRoot`
 * by streaming `64 KiB` chunks with `O_NOFOLLOW` and `nlink === 1`.
 */
export async function computeFileDigest(
  repoRoot: string,
  relPath: string,
  options: Pick<DigestLimitsOptions, 'maxFileBytes'> = {},
): Promise<string> {
  const normalized = normalizeRelativePath(relPath, relPath);
  const maxFileBytes = options.maxFileBytes ?? DIGEST_MAX_FILE_BYTES;
  const { fullPath } = await resolveExistingSafeSubpath(repoRoot, normalized, normalized);
  const { sha256 } = await hashStreamedRegularFile(fullPath, maxFileBytes, normalized);
  return sha256;
}

/**
 * Deterministically walk a directory inside `repoRoot` and compute a whole-tree SHA-256 digest
 * covering every nested regular file's relative POSIX path, byte length, and content SHA-256.
 * Rejects any symlink, hardlink (`nlink !== 1`), escape outside `repoRoot`, special file, or bound violation.
 */
export async function computeDirectoryTreeDigest(
  repoRoot: string,
  relDir: string,
  options: DigestLimitsOptions = {},
): Promise<DirectoryTreeDigestResult> {
  const normalized = normalizeRelativePath(relDir, relDir);
  const maxFileBytes = options.maxFileBytes ?? DIGEST_MAX_FILE_BYTES;
  const maxTreeFiles = options.maxTreeFiles ?? DIGEST_MAX_TREE_FILES;
  const maxTreeBytes = options.maxTreeBytes ?? DIGEST_MAX_TREE_BYTES;
  const maxTreeDepth = options.maxTreeDepth ?? DIGEST_MAX_TREE_DEPTH;

  const { fullPath, realRoot } = await resolveExistingSafeSubpath(repoRoot, normalized, normalized);
  const dirStat = await lstat(fullPath).catch(() => null);
  if (dirStat === null || dirStat.isSymbolicLink() || !dirStat.isDirectory()) {
    throw new TaskpackError('TASKPACK_MANIFEST_INVALID', `directory "${normalized}" must be a non-symlink directory`, normalized);
  }

  const files: DirectoryTreeFileDigest[] = [];
  let totalBytes = 0;

  const walk = async (absDir: string, relPrefix: string, depth: number): Promise<void> => {
    if (depth > maxTreeDepth) {
      throw new TaskpackError('TASKPACK_MANIFEST_INVALID', `directory "${normalized}" exceeds maximum nesting depth ${maxTreeDepth}`, normalized);
    }
    const entries = await readdir(absDir, { withFileTypes: true });
    entries.sort((a, b) => compareCodePoint(a.name, b.name));

    for (const entry of entries) {
      const childAbs = join(absDir, entry.name);
      const childRel = relPrefix.length === 0 ? entry.name : `${relPrefix}/${entry.name}`;
      const diagPath = `${normalized}/${childRel}`;

      if (entry.isSymbolicLink()) {
        throw new TaskpackError('TASKPACK_SCOPE_VIOLATION', `symlink "${diagPath}" is forbidden inside hashed directory "${normalized}"`, diagPath);
      }
      const st = await lstat(childAbs).catch(() => null);
      if (st === null) {
        throw new TaskpackError('TASKPACK_MANIFEST_INVALID', `entry "${diagPath}" disappeared while hashing`, diagPath);
      }
      if (st.isSymbolicLink()) {
        throw new TaskpackError('TASKPACK_SCOPE_VIOLATION', `symlink "${diagPath}" is forbidden inside hashed directory "${normalized}"`, diagPath);
      }

      if (st.isDirectory()) {
        const realChild = await realpath(childAbs).catch(() => {
          throw new TaskpackError('TASKPACK_MANIFEST_INVALID', `directory "${diagPath}" cannot be resolved`, diagPath);
        });
        if (!isContainedInRoot(realChild, realRoot)) {
          throw new TaskpackError('TASKPACK_SCOPE_VIOLATION', `directory "${diagPath}" escapes repository root`, diagPath);
        }
        await walk(childAbs, childRel, depth + 1);
      } else if (st.isFile()) {
        if (st.nlink !== 1) {
          throw new TaskpackError('TASKPACK_SCOPE_VIOLATION', `hardlinked file "${diagPath}" (nlink=${st.nlink}) is forbidden inside hashed directory "${normalized}"`, diagPath);
        }
        if (files.length >= maxTreeFiles) {
          throw new TaskpackError('TASKPACK_MANIFEST_INVALID', `directory "${normalized}" exceeds ${maxTreeFiles} files`, diagPath);
        }
        if (st.size > maxFileBytes || totalBytes + st.size > maxTreeBytes) {
          throw new TaskpackError('TASKPACK_MANIFEST_INVALID', `directory "${normalized}" exceeds byte limit ${maxTreeBytes}`, diagPath);
        }
        const realChild = await realpath(childAbs).catch(() => {
          throw new TaskpackError('TASKPACK_MANIFEST_INVALID', `file "${diagPath}" cannot be resolved`, diagPath);
        });
        if (!isContainedInRoot(realChild, realRoot)) {
          throw new TaskpackError('TASKPACK_SCOPE_VIOLATION', `file "${diagPath}" escapes repository root`, diagPath);
        }
        const hashed = await hashStreamedRegularFile(childAbs, maxFileBytes, diagPath);
        totalBytes += hashed.bytes;
        if (totalBytes > maxTreeBytes) {
          throw new TaskpackError('TASKPACK_MANIFEST_INVALID', `directory "${normalized}" exceeds byte limit ${maxTreeBytes}`, diagPath);
        }
        files.push(Object.freeze({
          path: childRel,
          sha256: hashed.sha256,
          bytes: hashed.bytes,
        }));
      } else {
        throw new TaskpackError('TASKPACK_MANIFEST_INVALID', `unsupported non-regular entry "${diagPath}" inside hashed directory`, diagPath);
      }
    }
  };

  await walk(fullPath, '', 0);
  files.sort((a, b) => compareCodePoint(a.path, b.path));

  const treeHash = createHash('sha256');
  treeHash.update('loopwright.dev/digests/tree/v1\n', 'utf8');
  for (const file of files) {
    treeHash.update(`${file.path}\0${file.bytes}\0${file.sha256}\n`, 'utf8');
  }
  return Object.freeze({
    digest: treeHash.digest('hex'),
    files: Object.freeze(files),
  });
}

/** Resolve the repo-relative lockfile path for a taskpack manifest. */
export function resolveDigestLockfilePath(
  taskpack: TaskpackManifest | TaskpackV2Manifest,
  controlRoot?: string,
): string {
  const effectiveControlRoot = normalizeRelativePath(controlRoot ?? taskpack.controlRoot ?? '.loopwright', '/');
  const declared = taskpack.spec.execution?.digests.lockfile;
  if (declared !== undefined) {
    return normalizeRelativePath(declared, '/spec/execution/digests/lockfile');
  }
  return `${effectiveControlRoot}/digests.lock.json`;
}

/**
 * Collect all deterministic runtime-hashed files and check-script parent directories referenced
 * by a Taskpack 2.0 manifest (`preflight.script`, `command.v1` parent directories, top-level and
 * per-role `instructions` and `skills`).
 */
export function collectTaskpackDigestTargets(
  taskpack: TaskpackManifest | TaskpackV2Manifest,
  controlRoot?: string,
): readonly TaskpackDigestTarget[] {
  if (controlRoot !== undefined) {
    normalizeRelativePath(controlRoot, '/');
  }
  const seen = new Map<string, TaskpackDigestTarget>();
  const addTarget = (relPath: string, kind: 'file' | 'directory', diagPath: string): void => {
    const normalized = normalizeRelativePath(relPath, diagPath);
    const key = `${kind}:${normalized}`;
    if (!seen.has(key)) {
      seen.set(key, Object.freeze({ path: normalized, kind }));
    }
  };

  if (taskpack.spec.preflight !== undefined) {
    addTarget(taskpack.spec.preflight.script, 'file', '/spec/preflight/script');
  }

  for (const [idx, check] of taskpack.spec.verification.localChecks.entries()) {
    if (check.implementation !== 'command.v1') continue;
    const rawScript = check.parameters?.['script'];
    if (typeof rawScript !== 'string' || rawScript.length === 0) continue;
    const scriptPath = normalizeRelativePath(rawScript, `/spec/verification/localChecks/${idx}/parameters/script`);
    const parent = posix.dirname(scriptPath);
    if (parent === '.' || parent === '') {
      addTarget(scriptPath, 'file', `/spec/verification/localChecks/${idx}/parameters/script`);
    } else {
      addTarget(parent, 'directory', `/spec/verification/localChecks/${idx}/parameters/script`);
    }
  }

  for (const [idx, instruction] of (taskpack.spec.instructions ?? []).entries()) {
    addTarget(instruction, 'file', `/spec/instructions/${idx}`);
  }
  for (const [idx, skill] of (taskpack.spec.skills ?? []).entries()) {
    addTarget(skill, 'file', `/spec/skills/${idx}`);
  }

  for (const [rIdx, role] of (taskpack.spec.roles ?? []).entries()) {
    for (const [iIdx, instruction] of (role.instructions ?? []).entries()) {
      addTarget(instruction, 'file', `/spec/roles/${rIdx}/instructions/${iIdx}`);
    }
    for (const [sIdx, skill] of (role.skills ?? []).entries()) {
      addTarget(skill, 'file', `/spec/roles/${rIdx}/skills/${sIdx}`);
    }
  }

  const targets = [...seen.values()];
  targets.sort((a, b) => compareCodePoint(a.path, b.path) || compareCodePoint(a.kind, b.kind));
  return Object.freeze(targets);
}

/**
 * Compute a canonical deterministic `TaskpackDigestLockfile` for every tracked file and
 * mounted check directory declared by `taskpack`.
 */
export async function computeTaskpackDigests(
  repoRoot: string,
  taskpack: TaskpackManifest | TaskpackV2Manifest,
  controlRoot?: string,
  options: DigestLimitsOptions = {},
): Promise<TaskpackDigestLockfile> {
  const maxFileBytes = options.maxFileBytes ?? DIGEST_MAX_FILE_BYTES;
  for (const [idx, check] of taskpack.spec.verification.localChecks.entries()) {
    if (check.implementation !== 'command.v1') continue;
    const rawScript = check.parameters?.['script'];
    if (typeof rawScript !== 'string' || rawScript.length === 0) continue;
    const diagPath = `/spec/verification/localChecks/${idx}/parameters/script`;
    const scriptPath = normalizeRelativePath(rawScript, diagPath);
    const { fullPath } = await resolveExistingSafeSubpath(repoRoot, scriptPath, diagPath);
    await hashStreamedRegularFile(fullPath, maxFileBytes, scriptPath);
  }
  const targets = collectTaskpackDigestTargets(taskpack, controlRoot);
  const entries: TaskpackDigestLockfileEntry[] = [];
  for (const target of targets) {
    if (target.kind === 'directory') {
      const tree = await computeDirectoryTreeDigest(repoRoot, target.path, options);
      entries.push(Object.freeze({ path: target.path, kind: 'directory', sha256: tree.digest }));
    } else {
      const sha256 = await computeFileDigest(repoRoot, target.path, options);
      entries.push(Object.freeze({ path: target.path, kind: 'file', sha256 }));
    }
  }
  entries.sort((a, b) => compareCodePoint(a.path, b.path) || compareCodePoint(a.kind, b.kind));
  return Object.freeze({
    version: 1,
    taskpack: taskpack.metadata.name,
    entries: Object.freeze(entries),
  });
}

function validateLockfileObject(raw: unknown, diagPath: string): TaskpackDigestLockfile {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new TaskpackError('TASKPACK_MANIFEST_INVALID', 'digest lockfile must be a JSON object', diagPath);
  }
  const proto: unknown = Object.getPrototypeOf(raw);
  if (proto !== Object.prototype && proto !== null) {
    throw new TaskpackError('TASKPACK_MANIFEST_INVALID', 'digest lockfile must be a plain object', diagPath);
  }
  const record = raw as Record<string, unknown>;
  const allowedTop = new Set(['version', 'taskpack', 'entries']);
  for (const key of Object.keys(record)) {
    if (FORBIDDEN_KEYS.has(key) || !allowedTop.has(key)) {
      throw new TaskpackError('TASKPACK_MANIFEST_INVALID', `unknown digest lockfile field "${key}"`, diagPath);
    }
  }
  if (record['version'] !== 1) {
    throw new TaskpackError('TASKPACK_MANIFEST_INVALID', 'digest lockfile version must be 1', `${diagPath}/version`);
  }
  const taskpackName = record['taskpack'];
  if (typeof taskpackName !== 'string' || !IDENTIFIER_PATTERN.test(taskpackName)) {
    throw new TaskpackError('TASKPACK_MANIFEST_INVALID', 'digest lockfile taskpack must be a valid identifier', `${diagPath}/taskpack`);
  }
  const rawEntries = record['entries'];
  if (!Array.isArray(rawEntries) || rawEntries.length > DIGEST_LOCKFILE_MAX_ENTRIES) {
    throw new TaskpackError('TASKPACK_MANIFEST_INVALID', `digest lockfile entries must be an array of 0..${DIGEST_LOCKFILE_MAX_ENTRIES} items`, `${diagPath}/entries`);
  }
  const seen = new Set<string>();
  const entries: TaskpackDigestLockfileEntry[] = [];
  const allowedEntryKeys = new Set(['path', 'kind', 'sha256']);
  for (const [idx, item] of rawEntries.entries()) {
    const itemPath = `${diagPath}/entries/${idx}`;
    if (item === null || typeof item !== 'object' || Array.isArray(item)) {
      throw new TaskpackError('TASKPACK_MANIFEST_INVALID', 'digest lockfile entry must be an object', itemPath);
    }
    const itemProto: unknown = Object.getPrototypeOf(item);
    if (itemProto !== Object.prototype && itemProto !== null) {
      throw new TaskpackError('TASKPACK_MANIFEST_INVALID', 'digest lockfile entry must be a plain object', itemPath);
    }
    const entryRec = item as Record<string, unknown>;
    for (const key of Object.keys(entryRec)) {
      if (FORBIDDEN_KEYS.has(key) || !allowedEntryKeys.has(key)) {
        throw new TaskpackError('TASKPACK_MANIFEST_INVALID', `unknown digest lockfile entry field "${key}"`, itemPath);
      }
    }
    const entryPath = normalizeRelativePath(entryRec['path'], `${itemPath}/path`);
    const kind = entryRec['kind'];
    if (kind !== 'file' && kind !== 'directory') {
      throw new TaskpackError('TASKPACK_MANIFEST_INVALID', 'digest lockfile entry kind must be "file" or "directory"', `${itemPath}/kind`);
    }
    const sha256 = entryRec['sha256'];
    if (typeof sha256 !== 'string' || !SHA256_HEX_PATTERN.test(sha256)) {
      throw new TaskpackError('TASKPACK_MANIFEST_INVALID', 'digest lockfile entry sha256 must be a 64-character lowercase hex digest', `${itemPath}/sha256`);
    }
    const dedupeKey = `${kind}:${entryPath}`;
    if (seen.has(dedupeKey)) {
      throw new TaskpackError('TASKPACK_MANIFEST_INVALID', `duplicate digest lockfile entry "${entryPath}" (${kind})`, itemPath);
    }
    seen.add(dedupeKey);
    entries.push(Object.freeze({ path: entryPath, kind, sha256 }));
  }
  entries.sort((a, b) => compareCodePoint(a.path, b.path) || compareCodePoint(a.kind, b.kind));
  return Object.freeze({
    version: 1,
    taskpack: taskpackName,
    entries: Object.freeze(entries),
  });
}

/** Read and strictly validate `digests.lock.json` from inside `repoRoot`. */
export async function readDigestLockfile(repoRoot: string, lockfilePath: string): Promise<TaskpackDigestLockfile> {
  const normalized = normalizeRelativePath(lockfilePath, lockfilePath);
  const { fullPath } = await resolveExistingSafeSubpath(repoRoot, normalized, normalized);
  const bytes = await readBoundedControlFile(fullPath, DIGEST_LOCKFILE_MAX_BYTES, normalized);
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw new TaskpackError('TASKPACK_MANIFEST_INVALID', `digest lockfile "${normalized}" is not valid UTF-8`, normalized);
  }
  const parsed = parseJsonSubset(text, {
    maxNodes: DIGEST_LOCKFILE_MAX_ENTRIES * 8,
    maxDepth: 8,
    maxCollection: DIGEST_LOCKFILE_MAX_ENTRIES,
    maxString: DIGEST_LOCKFILE_MAX_BYTES,
    diagPath: normalized,
  });
  return validateLockfileObject(parsed, normalized);
}

/** Atomically write a canonical deterministic `digests.lock.json` inside `repoRoot`, refusing symlink traversal. */
export async function writeDigestLockfile(
  repoRoot: string,
  lockfilePath: string,
  lockfile: TaskpackDigestLockfile,
): Promise<void> {
  const normalized = normalizeRelativePath(lockfilePath, lockfilePath);
  const canonical = validateLockfileObject(lockfile, normalized);
  const { resolvedRoot, realRoot } = await resolveSafeRepoRoot(repoRoot);

  const segments = normalized.split('/');
  const parentSegments = segments.slice(0, -1);
  let current = resolvedRoot;
  for (const segment of parentSegments) {
    current = join(current, segment);
    const st = await lstat(current).catch(() => null);
    if (st !== null) {
      if (st.isSymbolicLink()) {
        throw new TaskpackError('TASKPACK_SCOPE_VIOLATION', `lockfile parent "${normalized}" traverses a symbolic link`, normalized);
      }
      if (!st.isDirectory()) {
        throw new TaskpackError('TASKPACK_MANIFEST_INVALID', `lockfile parent "${normalized}" is not a directory`, normalized);
      }
      const realCurrent = await realpath(current).catch(() => {
        throw new TaskpackError('TASKPACK_MANIFEST_INVALID', `lockfile parent "${normalized}" cannot be resolved`, normalized);
      });
      if (!isContainedInRoot(realCurrent, realRoot)) {
        throw new TaskpackError('TASKPACK_SCOPE_VIOLATION', `lockfile parent "${normalized}" escapes repository root`, normalized);
      }
    } else {
      try {
        await mkdir(current, { mode: 0o755 });
      } catch (error) {
        const code = (error as NodeJS.ErrnoException | null)?.code;
        if (code === 'ELOOP') {
          throw new TaskpackError('TASKPACK_SCOPE_VIOLATION', `lockfile parent "${normalized}" traverses a symbolic link`, normalized);
        }
        const detail = error instanceof Error ? error.message : String(error);
        throw new TaskpackError('TASKPACK_MANIFEST_INVALID', `failed to create lockfile parent directory for "${normalized}": ${detail}`, normalized);
      }
    }
  }

  const targetFullPath = join(resolvedRoot, ...segments);
  const existing = await lstat(targetFullPath).catch(() => null);
  if (existing !== null) {
    if (existing.isSymbolicLink()) {
      throw new TaskpackError('TASKPACK_SCOPE_VIOLATION', `lockfile target "${normalized}" must not be a symbolic link`, normalized);
    }
    if (!existing.isFile()) {
      throw new TaskpackError('TASKPACK_MANIFEST_INVALID', `lockfile target "${normalized}" must be a regular file`, normalized);
    }
    const realExisting = await realpath(targetFullPath).catch(() => {
      throw new TaskpackError('TASKPACK_MANIFEST_INVALID', `lockfile target "${normalized}" cannot be resolved`, normalized);
    });
    if (!isContainedInRoot(realExisting, realRoot)) {
      throw new TaskpackError('TASKPACK_SCOPE_VIOLATION', `lockfile target "${normalized}" escapes repository root`, normalized);
    }
  }

  const serialized = `${JSON.stringify(canonical, null, 2)}\n`;
  if (Buffer.byteLength(serialized, 'utf8') > DIGEST_LOCKFILE_MAX_BYTES) {
    throw new TaskpackError('TASKPACK_MANIFEST_INVALID', `serialized digest lockfile exceeds ${DIGEST_LOCKFILE_MAX_BYTES} bytes`, normalized);
  }

  const parentDir = dirname(targetFullPath);
  const tempPath = join(parentDir, `.digests-lock-${randomBytes(8).toString('hex')}.tmp`);
  const noFollow = 'O_NOFOLLOW' in constants ? constants.O_NOFOLLOW : 0;
  try {
    const handle = await open(tempPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | noFollow, 0o644);
    try {
      await handle.writeFile(serialized, 'utf8');
    } finally {
      await handle.close();
    }
    await rename(tempPath, targetFullPath);
  } catch (error) {
    await unlink(tempPath).catch(() => undefined);
    if (error instanceof TaskpackError) throw error;
    const code = (error as NodeJS.ErrnoException | null)?.code;
    if (code === 'ELOOP') {
      throw new TaskpackError('TASKPACK_SCOPE_VIOLATION', `lockfile target "${normalized}" must not traverse or target symbolic links`, normalized);
    }
    const detail = error instanceof Error ? error.message : String(error);
    throw new TaskpackError('TASKPACK_MANIFEST_INVALID', `failed to atomically write digest lockfile "${normalized}": ${detail}`, normalized);
  }
}

function formatDigestRemediationHint(taskpack: TaskpackManifest | TaskpackV2Manifest): string {
  let manifestTarget = '<taskpack.yaml>';
  if (typeof taskpack.manifestPath === 'string' && taskpack.manifestPath.trim().length > 0) {
    const cleaned = taskpack.manifestPath.trim().replaceAll('\\', '/').replace(/^(?:\.\/)+/, '');
    const normalized = tryNormalizeRelativePath(cleaned);
    if (normalized !== undefined) {
      manifestTarget = normalized;
    }
  }
  return `\nRun "loopwright digest sync --taskpack ${manifestTarget} --repo ." to refresh the lockfile.`;
}

/**
 * Verify that `digests.lock.json` matches every tracked file and mounted check directory for `taskpack`.
 * Fails closed with clear diagnostic details naming every drifted, missing, or extra file or directory.
 */
export async function verifyDigestLockfile(
  repoRoot: string,
  taskpack: TaskpackManifest | TaskpackV2Manifest,
  controlRoot?: string,
  lockfilePath?: string,
  options: DigestLimitsOptions = {},
): Promise<TaskpackDigestVerificationResult> {
  const effectiveLockfilePath = lockfilePath !== undefined
    ? normalizeRelativePath(lockfilePath, lockfilePath)
    : resolveDigestLockfilePath(taskpack, controlRoot);
  const remediationHint = formatDigestRemediationHint(taskpack);

  let expected: TaskpackDigestLockfile;
  try {
    expected = await readDigestLockfile(repoRoot, effectiveLockfilePath);
  } catch (error) {
    if (error instanceof TaskpackError && error.code === 'TASKPACK_SCOPE_VIOLATION') {
      throw error;
    }
    const detail = error instanceof Error ? error.message : String(error);
    return Object.freeze({
      ok: false,
      lockfilePath: effectiveLockfilePath,
      reason: `digest lockfile "${effectiveLockfilePath}" could not be loaded: ${detail}${remediationHint}`,
      drifts: Object.freeze([]),
      computed: null,
      expected: null,
    });
  }

  let computed: TaskpackDigestLockfile;
  try {
    computed = await computeTaskpackDigests(repoRoot, taskpack, controlRoot, options);
  } catch (error) {
    if (error instanceof TaskpackError && error.code === 'TASKPACK_SCOPE_VIOLATION') {
      throw error;
    }
    const detail = error instanceof Error ? error.message : String(error);
    return Object.freeze({
      ok: false,
      lockfilePath: effectiveLockfilePath,
      reason: `failed to compute runtime digests for "${taskpack.metadata.name}": ${detail}${remediationHint}`,
      drifts: Object.freeze([]),
      computed: null,
      expected,
    });
  }

  if (expected.taskpack !== computed.taskpack) {
    return Object.freeze({
      ok: false,
      lockfilePath: effectiveLockfilePath,
      reason: `digest lockfile "${effectiveLockfilePath}" targets taskpack "${expected.taskpack}", expected "${computed.taskpack}"${remediationHint}`,
      drifts: Object.freeze([]),
      computed,
      expected,
    });
  }

  const expectedMap = new Map<string, TaskpackDigestLockfileEntry>();
  for (const entry of expected.entries) {
    expectedMap.set(`${entry.kind}:${entry.path}`, entry);
  }
  const computedMap = new Map<string, TaskpackDigestLockfileEntry>();
  for (const entry of computed.entries) {
    computedMap.set(`${entry.kind}:${entry.path}`, entry);
  }

  const drifts: TaskpackDigestDrift[] = [];
  for (const [key, actual] of computedMap.entries()) {
    const exp = expectedMap.get(key);
    if (exp === undefined) {
      drifts.push(Object.freeze({
        path: actual.path,
        kind: actual.kind,
        status: 'missing',
        expectedSha256: null,
        actualSha256: actual.sha256,
      }));
    } else if (exp.sha256 !== actual.sha256) {
      drifts.push(Object.freeze({
        path: actual.path,
        kind: actual.kind,
        status: 'drifted',
        expectedSha256: exp.sha256,
        actualSha256: actual.sha256,
      }));
    }
  }
  for (const [key, exp] of expectedMap.entries()) {
    if (!computedMap.has(key)) {
      drifts.push(Object.freeze({
        path: exp.path,
        kind: exp.kind,
        status: 'extra',
        expectedSha256: exp.sha256,
        actualSha256: null,
      }));
    }
  }

  if (drifts.length === 0) {
    return Object.freeze({
      ok: true,
      lockfilePath: effectiveLockfilePath,
      computed,
      expected,
    });
  }

  drifts.sort((a, b) => compareCodePoint(a.path, b.path) || compareCodePoint(a.kind, b.kind));
  const summaryParts = drifts.map(d => {
    if (d.status === 'drifted') {
      return `drifted ${d.kind} "${d.path}" (expected ${d.expectedSha256?.slice(0, 12)}, actual ${d.actualSha256?.slice(0, 12)})`;
    }
    if (d.status === 'missing') {
      return `missing ${d.kind} "${d.path}" from lockfile`;
    }
    return `extra ${d.kind} "${d.path}" in lockfile`;
  });

  return Object.freeze({
    ok: false,
    lockfilePath: effectiveLockfilePath,
    reason: `digest lockfile "${effectiveLockfilePath}" failed verification: ${summaryParts.join('; ')}${remediationHint}`,
    drifts: Object.freeze(drifts),
    computed,
    expected,
  });
}

/**
 * Convenience fail-closed guard that verifies `digests.lock.json` and throws
 * `TaskpackError('TASKPACK_MANIFEST_INVALID', ...)` naming every drift when verification fails.
 */
export async function assertDigestLockfileVerified(
  repoRoot: string,
  taskpack: TaskpackManifest | TaskpackV2Manifest,
  controlRoot?: string,
  lockfilePath?: string,
  options: DigestLimitsOptions = {},
): Promise<TaskpackDigestLockfile> {
  const result = await verifyDigestLockfile(repoRoot, taskpack, controlRoot, lockfilePath, options);
  if (!result.ok) {
    throw new TaskpackError('TASKPACK_MANIFEST_INVALID', result.reason, result.lockfilePath);
  }
  return result.computed;
}
