import { constants, existsSync } from 'node:fs';
import { chmod, lstat, open, mkdir, realpath, readdir, rename, rmdir, unlink, writeFile } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import { randomBytes, createHash } from 'node:crypto';
import { LIMITS, digestArtifact, isWritablePath, type ArtifactRef, type ArtifactManifest } from '@loopwright/core';
import { canonical, freeze, object, list } from './boundary.js';
import { refuse, PiFailure } from './errors.js';
import type { PiBaselineEntry, PiCandidateBaseline, PiOpenInput } from './types.js';

export interface CandidateChange {
  readonly path: string;
  readonly before: ArtifactRef | null;
  readonly after: ArtifactRef | null;
  readonly deleted?: boolean;
}

export type CandidateReadInspection =
  | { readonly kind: 'file'; readonly path: string; readonly ref: ArtifactRef }
  | { readonly kind: 'error'; readonly targetPath: string; readonly message: string };

export type CandidateMutationPreparation =
  | { readonly kind: 'change'; readonly change: CandidateChange }
  | { readonly kind: 'error'; readonly targetPath: string; readonly message: string };

export interface BaselineStatFingerprint {
  readonly mode: number;
  readonly size: number;
  readonly dev: number;
  readonly ino: number;
  readonly mtimeNs: bigint;
}

const OVERLAY_MAX_BYTES = 4_194_304;
const OVERLAY_MANIFEST_MAX_BYTES = 32_768;

export function gitBlobOid(objectFormat: 'sha1' | 'sha256', bytes: Uint8Array): string {
  return createHash(objectFormat).update(`blob ${bytes.byteLength}\0`).update(bytes).digest('hex');
}

const absent = (error: unknown): boolean => (error as NodeJS.ErrnoException).code === 'ENOENT';
const dirNotEmpty = (error: unknown): boolean => {
  const code = (error as NodeJS.ErrnoException).code;
  return code === 'ENOTEMPTY' || code === 'EEXIST';
};

function artifact(path: string, bytes: Uint8Array): ArtifactRef {
  const value = digestArtifact(path, bytes);
  if (!value.ok) refuse('TOOL_DENIED', '/path', { phase: 'tool' });
  return value.value;
}

function compareUtf16(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function normalizePathKey(path: string): string {
  return path.normalize('NFC').toLowerCase();
}

function isPrefixCollision(aNorm: string, bNorm: string): boolean {
  return aNorm.startsWith(bNorm + '/') || bNorm.startsWith(aNorm + '/');
}

function fingerprintFromStat(info: import('node:fs').BigIntStats): BaselineStatFingerprint {
  return {
    mode: Number(info.mode),
    size: Number(info.size),
    dev: Number(info.dev),
    ino: Number(info.ino),
    mtimeNs: info.mtimeNs,
  };
}

function sameFingerprint(a: BaselineStatFingerprint, b: BaselineStatFingerprint): boolean {
  return a.mode === b.mode && a.size === b.size && a.dev === b.dev && a.ino === b.ino && a.mtimeNs === b.mtimeNs;
}

type ExpectedOverlayFile =
  | { readonly kind: 'artifact'; readonly byteLength: number; readonly mode: number }
  | { readonly kind: 'baseline'; readonly entry: PiBaselineEntry };

const preBootBaselineStats = new WeakMap<PiCandidateBaseline, { readonly root: string; readonly stats: ReadonlyMap<string, BaselineStatFingerprint> }>();

function verifyUntouchedBaselineStat(info: import('node:fs').BigIntStats, entry: PiBaselineEntry): BaselineStatFingerprint {
  const expectedMode = entry.mode === '100755' ? 0o555 : 0o444;
  if (
    !info.isFile()
    || info.isSymbolicLink()
    || Number(info.nlink) !== 1
    || Number(info.uid) !== (process.getuid?.() ?? Number(info.uid))
    || Number(info.size) !== entry.byteLength
    || (Number(info.mode) & 0o777) !== expectedMode
  ) {
    refuse('RECOVERY_REQUIRED', '/candidate');
  }
  return fingerprintFromStat(info);
}

async function scanOverlayTree(
  root: string,
  expectedFiles: ReadonlyMap<string, ExpectedOverlayFile>,
): Promise<Map<string, BaselineStatFingerprint>> {
  const stats = new Map<string, BaselineStatFingerprint>();
  const seen = new Set<string>();
  const visit = async (dir: string, prefix: string): Promise<void> => {
    const dirInfo = await lstat(dir, { bigint: true });
    if (!dirInfo.isDirectory() || dirInfo.isSymbolicLink() || Number(dirInfo.uid) !== (process.getuid?.() ?? Number(dirInfo.uid))) {
      refuse('RECOVERY_REQUIRED', '/candidate');
    }
    const entries = await readdir(dir);
    for (const entry of entries) {
      const name = prefix ? prefix + '/' + entry : entry;
      const fullPath = join(dir, entry);
      const info = await lstat(fullPath, { bigint: true });
      if (info.isSymbolicLink()) refuse('RECOVERY_REQUIRED', '/candidate');
      if (info.isDirectory()) {
        await visit(fullPath, name);
        continue;
      }
      if (!info.isFile()) refuse('RECOVERY_REQUIRED', '/candidate');
      const expected = expectedFiles.get(name);
      if (!expected) refuse('RECOVERY_REQUIRED', '/candidate');
      seen.add(name);
      if (expected.kind === 'artifact') {
        if (
          Number(info.nlink) !== 1
          || Number(info.uid) !== (process.getuid?.() ?? Number(info.uid))
          || Number(info.size) !== expected.byteLength
          || (Number(info.mode) & 0o777) !== expected.mode
        ) {
          refuse('RECOVERY_REQUIRED', '/candidate');
        }
      } else {
        stats.set(name, verifyUntouchedBaselineStat(info, expected.entry));
      }
    }
  };
  await visit(root, '');
  if (seen.size !== expectedFiles.size) {
    refuse('RECOVERY_REQUIRED', '/candidate');
  }
  return stats;
}

/** Prune empty ancestor subdirectories created/emptied below `root`, never touching `root` itself. */
export async function pruneEmptyDirectories(root: string, filePath: string, onPrune?: (dir: string) => void): Promise<ReadonlySet<string>> {
  const pruned = new Set<string>();
  const segments = filePath.split('/').slice(0, -1);
  for (let i = segments.length; i >= 1; i--) {
    const dirPath = join(root, ...segments.slice(0, i));
    try {
      await rmdir(dirPath);
      const resolved = resolve(dirPath);
      pruned.add(resolved);
      onPrune?.(resolved);
    } catch (error) {
      if (dirNotEmpty(error)) break;
      if (absent(error)) continue;
      throw error;
    }
  }
  return pruned;
}

/** Recursively lock (`0o555` bottom-up) or unlock (`0o755` top-down) a real directory tree without following symlinks. */
export async function setDirectoryTreeMode(dir: string, mode: number): Promise<void> {
  const info = await lstat(dir);
  if (!info.isDirectory() || info.isSymbolicLink()) refuse('RECOVERY_REQUIRED');
  if (mode & 0o200) {
    await chmod(dir, mode);
  }
  const entries = await readdir(dir);
  for (const entry of entries) {
    const childPath = join(dir, entry);
    const childInfo = await lstat(childPath);
    if (childInfo.isSymbolicLink()) refuse('RECOVERY_REQUIRED');
    if (childInfo.isDirectory()) {
      await setDirectoryTreeMode(childPath, mode);
    }
  }
  if (!(mode & 0o200)) {
    await chmod(dir, mode);
  }
}

/** Materialize candidate directory from classic artifacts or a staged `tree_overlay` baseline, locking dirs to `0o555`. */
export async function materializeCandidateDirectory(candidateDir: string, input: PiOpenInput): Promise<void> {
  const baseline = input.candidate.baseline;
  const manifest = input.candidate.manifest;
  if (!baseline) {
    await mkdir(candidateDir, { mode: 0o755 });
    for (const file of input.candidate.artifacts) {
      const path = join(candidateDir, file.name);
      await mkdir(resolve(path, '..'), { recursive: true, mode: 0o755 });
      await writeFile(path, file.bytes, { flag: 'wx', mode: 0o444 });
      await chmod(path, 0o444);
    }
    await setDirectoryTreeMode(candidateDir, 0o555);
    return;
  }

  const baseInfo = await lstat(baseline.directory);
  if (!baseInfo.isDirectory() || baseInfo.isSymbolicLink()) refuse('RECOVERY_REQUIRED', '/candidate');
  await rename(baseline.directory, candidateDir);
  await setDirectoryTreeMode(candidateDir, 0o755);

  const baselineMap = new Map(baseline.entries.map(entry => [entry.name, entry]));
  const deletedSet = new Set(manifest.spec.deleted ?? []);
  const artifactMap = new Map(input.candidate.artifacts.map(file => [file.name, file]));

  for (const deletedPath of deletedSet) {
    const deletedTarget = join(candidateDir, deletedPath);
    const deletedInfo = await lstat(deletedTarget).catch(() => null);
    if (!deletedInfo || !deletedInfo.isFile() || deletedInfo.isSymbolicLink()) {
      refuse('RECOVERY_REQUIRED', '/candidate');
    }
    await unlink(deletedTarget);
    await pruneEmptyDirectories(candidateDir, deletedPath);
  }

  for (const file of input.candidate.artifacts) {
    const targetPath = join(candidateDir, file.name);
    const parent = resolve(targetPath, '..');
    await mkdir(parent, { recursive: true, mode: 0o755 });
    const targetMode = baselineMap.get(file.name)?.mode === '100755' ? 0o555 : 0o444;
    const temporary = join(parent, '.lw-init-' + randomBytes(12).toString('hex'));
    await writeFile(temporary, file.bytes, { flag: 'wx', mode: targetMode });
    await chmod(temporary, targetMode);
    await rename(temporary, targetPath);
  }

  const expectedFiles = new Map<string, ExpectedOverlayFile>();
  for (const entry of baseline.entries) {
    if (deletedSet.has(entry.name) || artifactMap.has(entry.name)) continue;
    expectedFiles.set(entry.name, { kind: 'baseline', entry });
  }
  for (const file of input.candidate.artifacts) {
    const mode = baselineMap.get(file.name)?.mode === '100755' ? 0o555 : 0o444;
    expectedFiles.set(file.name, { kind: 'artifact', byteLength: file.bytes.byteLength, mode });
  }

  await scanOverlayTree(candidateDir, expectedFiles);
  await setDirectoryTreeMode(candidateDir, 0o555);

  const preBootStats = new Map<string, BaselineStatFingerprint>();
  for (const [name, expected] of expectedFiles) {
    if (expected.kind !== 'baseline') continue;
    const info = await lstat(join(candidateDir, name), { bigint: true });
    preBootStats.set(name, verifyUntouchedBaselineStat(info, expected.entry));
  }
  preBootBaselineStats.set(baseline, { root: resolve(candidateDir), stats: preBootStats });
}

/** One trusted mutation owner; containers have only a read-only mount of this directory. */
export class Candidate {
  readonly #isOverlay: boolean;
  readonly #objectFormat: 'sha1' | 'sha256' | null;
  readonly #files: Map<string, ArtifactRef>;
  readonly #deleted: Set<string>;
  readonly #baseline: Map<string, PiBaselineEntry>;
  readonly #baselineNorm = new Map<string, string>();
  readonly #baselineStats = new Map<string, BaselineStatFingerprint>();
  readonly #verifiedBaseline = new Set<string>();
  #baselineStatsCaptured = false;
  readonly #lastPrunedDirectories = new Set<string>();
  readonly #changes = new WeakMap<CandidateChange, Buffer>();
  readonly #deleteChanges = new WeakSet<CandidateChange>();
  readonly #used = new WeakSet<CandidateChange>();
  #total: number;

  constructor(readonly root: string, readonly input: PiOpenInput) {
    const baseTree = input.candidate.manifest.spec.baseTree;
    this.#isOverlay = baseTree !== undefined;
    this.#objectFormat = baseTree?.objectFormat ?? null;
    this.#files = new Map(input.candidate.manifest.spec.entries.map(entry => [entry.name, freeze(structuredClone(entry))]));
    this.#deleted = new Set(input.candidate.manifest.spec.deleted ?? []);
    this.#baseline = new Map((input.candidate.baseline?.entries ?? []).map(entry => [entry.name, entry]));
    for (const entry of this.#baseline.values()) {
      this.#baselineNorm.set(normalizePathKey(entry.name), entry.name);
    }
    this.#total = [...this.#files.values()].reduce((total, value) => total + value.byteLength, 0);
  }

  #activeBaselineDirs(): ReadonlySet<string> {
    const dirs = new Set<string>();
    for (const name of this.#baseline.keys()) {
      if (this.#deleted.has(name)) continue;
      const norm = normalizePathKey(name);
      let slash = norm.indexOf('/');
      while (slash !== -1) {
        dirs.add(norm.slice(0, slash));
        slash = norm.indexOf('/', slash + 1);
      }
    }
    return dirs;
  }

  clearLastPrunedDirectories(): void {
    this.#lastPrunedDirectories.clear();
  }

  consumeLastPrunedDirectories(): ReadonlySet<string> {
    const copy = new Set(this.#lastPrunedDirectories);
    this.#lastPrunedDirectories.clear();
    return copy;
  }

  assertWritable(name: string): void {
    this.#writable(name);
  }

  isWritable(name: string): boolean {
    const contract = this.input.lock.spec.contract, allowed = isWritablePath(contract, name);
    // Retain core glob semantics and add conservative protection for aliases on case-insensitive hosts.
    const protectedOnly = { ...contract, spec: { ...contract.spec, scope: { writable: ['**'], protected: contract.spec.scope.protected.map(pattern => pattern.toLowerCase()) } } };
    const folded = isWritablePath(protectedOnly, name.toLowerCase());
    return Boolean(allowed.ok && allowed.value && folded.ok && folded.value);
  }

  #scopeDeniedError(verb: 'write' | 'edit' | 'delete', path: string): CandidateMutationPreparation {
    const scope = this.input.lock.spec.contract.spec.scope;
    const writableList = scope.writable.length > 0 ? scope.writable.join(', ') : '(none)';
    const protectedList = scope.protected.length > 0 ? scope.protected.join(', ') : '(none)';
    return freeze({
      kind: 'error' as const,
      targetPath: path,
      message: `Cannot ${verb} ${path}: path is outside writable scope (writable: ${writableList}; protected: ${protectedList}).`,
    });
  }

  #hasTopLevelCandidateEntry(): boolean {
    for (const key of this.#files.keys()) {
      if (key === 'candidate' || key.startsWith('candidate/')) return true;
    }
    if (!this.#deleted.has('candidate') && this.#baseline.has('candidate')) {
      return true;
    }
    if (this.#activeBaselineDirs().has('candidate')) {
      return true;
    }
    if (this.root.length > 0 && existsSync(join(this.root, 'candidate'))) {
      return true;
    }
    return false;
  }

  #matchSiblingToolScratchCandidate(raw: string, requireTrailingSlash: boolean): string | null {
    if (this.root.length === 0) return null;
    const resolvedRoot = resolve(this.root);
    const parentDir = resolve(resolvedRoot, '..');
    const bases = [parentDir];
    if (basename(parentDir) === 'sdk-' + this.input.sessionId) {
      bases.push(resolve(parentDir, '..'));
    }
    for (const base of bases) {
      const toolPrefix = base === '/' ? '/tool-' : base + '/tool-';
      if (!raw.startsWith(toolPrefix)) continue;
      const rest = raw.slice(toolPrefix.length);
      const slashIdx = rest.indexOf('/');
      if (slashIdx <= 0) continue;
      const seg = rest.slice(0, slashIdx);
      if (seg === '.' || seg === '..' || seg.includes('\0')) continue;
      const afterSeg = rest.slice(slashIdx);
      if (afterSeg.startsWith('/scratch/candidate/')) {
        return afterSeg.slice('/scratch/candidate/'.length);
      }
      if (!requireTrailingSlash && afterSeg === '/scratch/candidate') {
        return '';
      }
    }
    return null;
  }

  #stripCandidateRootPrefix(raw: string): { readonly rest: string; readonly stripped: boolean } {
    if (raw.startsWith('/workspace/candidate/')) {
      return { rest: raw.slice('/workspace/candidate/'.length), stripped: true };
    }
    if (raw.startsWith('/scratch/candidate/')) {
      return { rest: raw.slice('/scratch/candidate/'.length), stripped: true };
    }
    if (this.root.length > 0) {
      const rootPrefix = resolve(this.root) + '/';
      if (raw.startsWith(rootPrefix)) {
        return { rest: raw.slice(rootPrefix.length), stripped: true };
      }
      const scratchRel = this.#matchSiblingToolScratchCandidate(raw, true);
      if (scratchRel !== null) {
        return { rest: scratchRel, stripped: true };
      }
    }
    return { rest: raw, stripped: false };
  }

  #isRootCandidateDirectoryAlias(raw: string): boolean {
    if (
      raw === '.'
      || raw === './'
      || raw === '/workspace/candidate'
      || raw === '/workspace/candidate/'
      || raw === '/scratch/candidate'
      || raw === '/scratch/candidate/'
    ) {
      return true;
    }
    if (this.root.length > 0) {
      const resolvedRoot = resolve(this.root);
      if (raw === resolvedRoot || raw === resolvedRoot + '/') {
        return true;
      }
      if (this.#matchSiblingToolScratchCandidate(raw, false) === '') {
        return true;
      }
    }
    if (
      (raw === 'candidate' || raw === './candidate' || raw === 'candidate/' || raw === './candidate/')
      && !this.#hasTopLevelCandidateEntry()
    ) {
      return true;
    }
    return false;
  }

  async captureBaselineStats(): Promise<void> {
    if (!this.#isOverlay) return;
    this.#baselineStats.clear();
    const baseline = this.input.candidate.baseline;
    const preBoot = baseline ? preBootBaselineStats.get(baseline) : undefined;
    if (preBoot && preBoot.root === resolve(this.root)) {
      for (const [name, fingerprint] of preBoot.stats) {
        this.#baselineStats.set(name, fingerprint);
      }
      this.#baselineStatsCaptured = true;
      return;
    }
    const expectedFiles = new Map<string, ExpectedOverlayFile>();
    for (const [name, entry] of this.#baseline) {
      if (this.#files.has(name) || this.#deleted.has(name)) continue;
      expectedFiles.set(name, { kind: 'baseline', entry });
    }
    for (const [name, ref] of this.#files) {
      const mode = this.#baseline.get(name)?.mode === '100755' ? 0o555 : 0o444;
      expectedFiles.set(name, { kind: 'artifact', byteLength: ref.byteLength, mode });
    }
    const scanned = await scanOverlayTree(this.root, expectedFiles);
    for (const [name, fingerprint] of scanned) {
      this.#baselineStats.set(name, fingerprint);
    }
    this.#baselineStatsCaptured = true;
  }

  normalize(raw: string): string {
    if (typeof raw !== 'string') refuse('TOOL_DENIED', '/path', { phase: 'tool' });
    const { rest, stripped } = this.#stripCandidateRootPrefix(raw);
    let name = rest;
    while (name.startsWith('./')) {
      name = name.slice(2);
    }
    if (!stripped && name.startsWith('candidate/') && !this.#hasTopLevelCandidateEntry()) {
      name = name.slice('candidate/'.length);
      while (name.startsWith('./')) {
        name = name.slice(2);
      }
    }
    artifact(name, new Uint8Array());
    for (const segment of name.split('/')) {
      if (segment.toLowerCase() === '.git' || Buffer.byteLength(segment, 'utf8') > 255) {
        refuse('TOOL_DENIED', '/path', { phase: 'tool' });
      }
    }
    return name;
  }

  #writable(name: string): void {
    if (!this.isWritable(name)) refuse('TOOL_DENIED', '/path', { phase: 'tool' });
  }

  #directoryProtected(name: string): void {
    const contract = this.input.lock.spec.contract;
    const projected = { ...contract, spec: { ...contract.spec, scope: { writable: ['**'], protected: contract.spec.scope.protected.map(pattern => pattern.toLowerCase()) } } };
    const allowed = isWritablePath(projected, name.toLowerCase());
    if (!allowed.ok || !allowed.value) refuse('TOOL_DENIED', '/path', { phase: 'tool' });
  }

  #checkWriteCollisions(path: string): void {
    const norm = normalizePathKey(path);
    for (const existing of this.#files.keys()) {
      if (existing === path) continue;
      const existingNorm = normalizePathKey(existing);
      if (existingNorm === norm || isPrefixCollision(existingNorm, norm)) {
        refuse('TOOL_DENIED', '/path', { phase: 'tool' });
      }
    }
    if (!this.#isOverlay) return;

    for (const deleted of this.#deleted) {
      if (deleted === path) continue;
      const deletedNorm = normalizePathKey(deleted);
      if (deletedNorm === norm || isPrefixCollision(deletedNorm, norm)) {
        refuse('TOOL_DENIED', '/path', { phase: 'tool' });
      }
    }

    const baseExact = this.#baselineNorm.get(norm);
    if (baseExact !== undefined && baseExact !== path) {
      refuse('TOOL_DENIED', '/path', { phase: 'tool' });
    }
    if (this.#activeBaselineDirs().has(norm)) {
      refuse('TOOL_DENIED', '/path', { phase: 'tool' });
    }
    let slash = norm.indexOf('/');
    while (slash !== -1) {
      if (this.#baselineNorm.has(norm.slice(0, slash))) {
        refuse('TOOL_DENIED', '/path', { phase: 'tool' });
      }
      slash = norm.indexOf('/', slash + 1);
    }
  }

  #dirEntryLimit(includeTemp: boolean): number {
    const baseLimit = this.#isOverlay
      ? LIMITS.baselineEntries + LIMITS.overlayEntries
      : this.input.policy.limits.candidateEntries;
    return includeTemp ? baseLimit + 1 : baseLimit;
  }

  #buildOverlayManifest(entriesMap: ReadonlyMap<string, ArtifactRef>, deletedSet: ReadonlySet<string>): ArtifactManifest {
    const entries = [...entriesMap.values()].sort((a, b) => compareUtf16(a.name, b.name));
    const deleted = [...deletedSet].sort(compareUtf16);
    return {
      apiVersion: 'loopwright.dev/v1alpha1',
      kind: 'ArtifactManifest',
      metadata: { id: 'candidate' },
      spec: {
        baseTree: this.input.candidate.manifest.spec.baseTree!,
        entries,
        deleted,
      },
    };
  }

  async #directory(path: string): Promise<void> {
    const value = await lstat(path);
    if (!value.isDirectory() || value.isSymbolicLink() || value.uid !== process.getuid?.() || value.mode & 0o022 || await realpath(path) !== resolve(path)) {
      refuse('TOOL_DENIED', '/path', { phase: 'tool' });
    }
  }

  async #entry(parent: string, segment: string): Promise<boolean> {
    const entries = await readdir(parent);
    if (entries.length > this.#dirEntryLimit(true)) refuse('OUTPUT_LIMIT', '/candidate', { phase: 'tool' });
    const found = entries.find(value => value.toLowerCase() === segment.toLowerCase());
    if (found && found !== segment) refuse('TOOL_DENIED', '/path', { phase: 'tool' });
    if (found) return true;
    try { await lstat(join(parent, segment)); } catch (error) { if (absent(error)) return false; throw error; }
    refuse('TOOL_DENIED', '/path', { phase: 'tool' });
  }

  async #parent(name: string, create: boolean, guard: () => void = () => {}, onCreateDir?: (dir: string) => void): Promise<string | null> {
    await this.#directory(this.root);
    let parent = this.root, prefix = '';
    for (const segment of name.split('/').slice(0, -1)) {
      prefix = prefix ? prefix + '/' + segment : segment;
      const path = join(parent, segment);
      if (!await this.#entry(parent, segment)) {
        if (!create) return null;
        this.#directoryProtected(prefix);
        guard();
        await mkdir(path, { mode: 0o755 });
        onCreateDir?.(path);
      }
      await this.#directory(path);
      parent = path;
    }
    return parent;
  }

  async #current(name: string): Promise<Buffer | null> {
    const parent = await this.#parent(name, false);
    const knownOverlay = this.#files.get(name);
    const baseEntry = this.#isOverlay && !this.#deleted.has(name) ? this.#baseline.get(name) : undefined;
    const isKnown = knownOverlay !== undefined || baseEntry !== undefined;

    if (parent === null || !await this.#entry(parent, name.split('/').at(-1)!)) {
      if (isKnown) refuse('RECOVERY_REQUIRED', '/candidate', { phase: 'tool' });
      return null;
    }
    const path = join(this.root, name);
    const info = await lstat(path, { bigint: true });
    if (
      !info.isFile()
      || info.isSymbolicLink()
      || Number(info.nlink) !== 1
      || Number(info.uid) !== process.getuid?.()
      || Number(info.size) > this.input.policy.limits.fileBytes
      || (baseEntry !== undefined && baseEntry.byteLength > this.input.policy.limits.fileBytes)
    ) {
      refuse('TOOL_DENIED', '/path', { phase: 'tool' });
    }
    if (!isKnown) refuse('RECOVERY_REQUIRED', '/candidate', { phase: 'tool' });

    const descriptor = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const current = await descriptor.stat({ bigint: true });
      if (!current.isFile() || Number(current.nlink) !== 1 || current.dev !== info.dev || current.ino !== info.ino || Number(current.size) > this.input.policy.limits.fileBytes) {
        refuse('TOOL_DENIED', '/path', { phase: 'tool' });
      }
      const bytes = await descriptor.readFile();
      if (knownOverlay !== undefined) {
        if (canonical(artifact(name, bytes)) !== canonical(knownOverlay)) refuse('RECOVERY_REQUIRED', '/candidate', { phase: 'tool' });
        return bytes;
      }
      const expected = baseEntry!;
      const expectedStat = this.#baselineStats.get(name);
      const currentFingerprint = verifyUntouchedBaselineStat(info, expected);
      if (!sameFingerprint(currentFingerprint, fingerprintFromStat(current))) {
        refuse('RECOVERY_REQUIRED', '/candidate', { phase: 'tool' });
      }
      if (expectedStat && !sameFingerprint(expectedStat, currentFingerprint)) {
        refuse('RECOVERY_REQUIRED', '/candidate', { phase: 'tool' });
      }
      if (!expectedStat || !this.#verifiedBaseline.has(name)) {
        if (bytes.length !== expected.byteLength || gitBlobOid(this.#objectFormat!, bytes) !== expected.oid) {
          refuse('RECOVERY_REQUIRED', '/candidate', { phase: 'tool' });
        }
        if (!expectedStat) {
          if (this.#baselineStatsCaptured) refuse('RECOVERY_REQUIRED', '/candidate', { phase: 'tool' });
          this.#baselineStats.set(name, currentFingerprint);
        }
        this.#verifiedBaseline.add(name);
      }
      return bytes;
    } finally {
      await descriptor.close();
    }
  }

  async #listDirectoryEntries(dirPath: string): Promise<string> {
    await this.#directory(dirPath);
    const entries = await readdir(dirPath);
    if (entries.length > this.#dirEntryLimit(false)) refuse('OUTPUT_LIMIT', '/candidate', { phase: 'tool' });
    const visible = entries.filter(entry => entry.toLowerCase() !== '.git').sort(compareUtf16);
    const shown = visible.slice(0, 200);
    const formatted: string[] = [];
    for (const entry of shown) {
      const childInfo = await lstat(join(dirPath, entry));
      if (childInfo.isSymbolicLink()) refuse('TOOL_DENIED', '/path', { phase: 'tool' });
      formatted.push(childInfo.isDirectory() ? entry + '/' : entry);
    }
    if (visible.length > shown.length) {
      formatted.push(`... (${visible.length - shown.length} more entries)`);
    }
    return formatted.length > 0 ? formatted.join('\n') : '(empty directory)';
  }

  async checkRead(raw: string): Promise<{ readonly path: string; readonly ref: ArtifactRef }> {
    const path = this.normalize(raw), bytes = await this.#current(path);
    if (!bytes) refuse('TOOL_DENIED', '/path', { phase: 'tool' });
    return freeze({ path, ref: artifact(path, bytes) });
  }

  async inspectReadTarget(raw: string): Promise<CandidateReadInspection> {
    if (typeof raw !== 'string') refuse('TOOL_DENIED', '/path', { phase: 'tool' });
    if (this.#isRootCandidateDirectoryAlias(raw)) {
      const listing = await this.#listDirectoryEntries(this.root);
      return freeze({
        kind: 'error' as const,
        targetPath: '.',
        message: `Path "." is a directory, not a file. Entries:\n${listing}`,
      });
    }
    const hadTrailingSlash = raw.length > 1 && raw.endsWith('/') && !raw.endsWith('//');
    const path = this.normalize(hadTrailingSlash ? raw.slice(0, -1) : raw);
    const knownOverlay = this.#files.get(path);
    const baseEntry = this.#isOverlay && !this.#deleted.has(path) ? this.#baseline.get(path) : undefined;
    const isKnown = knownOverlay !== undefined || baseEntry !== undefined;
    const parent = await this.#parent(path, false);
    const leaf = path.split('/').at(-1)!;
    if (parent === null || !await this.#entry(parent, leaf)) {
      if (isKnown) refuse('RECOVERY_REQUIRED', '/candidate', { phase: 'tool' });
      return freeze({ kind: 'error' as const, targetPath: path, message: `File not found: ${path}` });
    }
    const fullPath = join(this.root, path);
    const info = await lstat(fullPath, { bigint: true });
    if (info.isSymbolicLink() || Number(info.uid) !== process.getuid?.()) {
      refuse('TOOL_DENIED', '/path', { phase: 'tool' });
    }
    if (info.isDirectory()) {
      if (isKnown) refuse('RECOVERY_REQUIRED', '/candidate', { phase: 'tool' });
      const listing = await this.#listDirectoryEntries(fullPath);
      return freeze({
        kind: 'error' as const,
        targetPath: path,
        message: `Path "${path}" is a directory, not a file. Entries:\n${listing}`,
      });
    }
    if (hadTrailingSlash) {
      return freeze({
        kind: 'error' as const,
        targetPath: path,
        message: `Path "${path}" is a file, not a directory.`,
      });
    }
    const checked = await this.checkRead(path);
    return freeze({ kind: 'file' as const, path: checked.path, ref: checked.ref });
  }

  #prepare(path: string, before: Buffer | null, bytes: Buffer): CandidateChange {
    this.#checkWriteCollisions(path);
    const after = artifact(path, bytes), old = before === null ? null : artifact(path, before), limits = this.input.policy.limits;
    const capacity = limits.artifactBytes - limits.sessionBytes - this.input.resources.reduce((total, item) => total + item.bytes.length, 0);
    if (bytes.length > limits.fileBytes) refuse('OUTPUT_LIMIT', '/candidate', { phase: 'tool' });

    if (!this.#isOverlay) {
      if (this.#total - (old?.byteLength ?? 0) + bytes.length > capacity || !old && this.#files.size >= limits.candidateEntries) {
        refuse('OUTPUT_LIMIT', '/candidate', { phase: 'tool' });
      }
    } else {
      const baseEntry = this.#baseline.get(path);
      const revertsToBaseline = baseEntry !== undefined && gitBlobOid(this.#objectFormat!, bytes) === baseEntry.oid;
      const prevOverlayBytes = this.#overlayByteLength(path);
      const nextOverlayBytes = revertsToBaseline ? 0 : bytes.length;
      const projectedTotal = this.#total - prevOverlayBytes + nextOverlayBytes;
      if (projectedTotal > OVERLAY_MAX_BYTES || projectedTotal > capacity) {
        refuse('OUTPUT_LIMIT', '/candidate', { phase: 'tool' });
      }
      const addsOverlayEntry = !revertsToBaseline && !this.#files.has(path);
      if (addsOverlayEntry && this.#files.size >= LIMITS.overlayEntries) {
        refuse('OUTPUT_LIMIT', '/candidate', { phase: 'tool' });
      }
      const nextOverlay = new Map(this.#files);
      const nextDeleted = new Set(this.#deleted);
      nextDeleted.delete(path);
      if (revertsToBaseline) nextOverlay.delete(path);
      else nextOverlay.set(path, after);
      const projectedManifest = this.#buildOverlayManifest(nextOverlay, nextDeleted);
      if (Buffer.byteLength(canonical(projectedManifest)) > OVERLAY_MANIFEST_MAX_BYTES) {
        refuse('OUTPUT_LIMIT', '/candidate', { phase: 'tool' });
      }
    }

    const change = freeze({ path, before: old, after });
    this.#changes.set(change, bytes);
    return change;
  }

  #overlayByteLength(path: string): number {
    return this.#files.get(path)?.byteLength ?? 0;
  }

  async prepareWrite(raw: string, content: string): Promise<CandidateChange> {
    const path = this.normalize(raw);
    this.#writable(path);
    if (typeof content !== 'string' || new TextDecoder('utf-8', { fatal: true }).decode(Buffer.from(content)) !== content) {
      refuse('TOOL_DENIED', '/content', { phase: 'tool' });
    }
    return this.#prepare(path, await this.#current(path), Buffer.from(content));
  }

  async prepareEdit(raw: string, input: unknown): Promise<CandidateChange> {
    const path = this.normalize(raw);
    this.#writable(path);
    const before = await this.#current(path);
    if (!before) refuse('TOOL_DENIED', '/path', { phase: 'tool' });
    let text: string;
    try { text = new TextDecoder('utf-8', { fatal: true }).decode(before); } catch { refuse('TOOL_DENIED', '/edits', { phase: 'tool' }); }
    const ranges = list(input, 32, '/edits').map(value => {
      const entry = object(value, ['oldText', 'newText'], '/edits');
      if (typeof entry.oldText !== 'string' || !entry.oldText || typeof entry.newText !== 'string' || Buffer.from(entry.newText).toString('utf8') !== entry.newText) {
        refuse('TOOL_DENIED', '/edits', { phase: 'tool' });
      }
      const index = text.indexOf(entry.oldText);
      if (index < 0 || text.indexOf(entry.oldText, index + 1) >= 0) refuse('TOOL_DENIED', '/edits', { phase: 'tool' });
      return { start: index, end: index + entry.oldText.length, replacement: entry.newText };
    }).sort((a, b) => a.start - b.start);
    if (!ranges.length || ranges.some((range, index) => index > 0 && ranges[index - 1]!.end > range.start)) {
      refuse('TOOL_DENIED', '/edits', { phase: 'tool' });
    }
    let offset = 0, result = '';
    for (const range of ranges) {
      result += text.slice(offset, range.start) + range.replacement;
      offset = range.end;
    }
    result += text.slice(offset);
    return this.#prepare(path, before, Buffer.from(result));
  }

  async prepareDelete(raw: string): Promise<CandidateChange> {
    const path = this.normalize(raw);
    this.#writable(path);
    const before = await this.#current(path);
    if (!before) refuse('TOOL_DENIED', '/path', { phase: 'tool' });
    const old = artifact(path, before);

    if (this.#isOverlay && this.#baseline.has(path)) {
      const nextOverlay = new Map(this.#files);
      nextOverlay.delete(path);
      const nextDeleted = new Set(this.#deleted);
      nextDeleted.add(path);
      if (nextDeleted.size > LIMITS.overlayEntries) {
        refuse('OUTPUT_LIMIT', '/candidate', { phase: 'tool' });
      }
      const projectedManifest = this.#buildOverlayManifest(nextOverlay, nextDeleted);
      if (Buffer.byteLength(canonical(projectedManifest)) > OVERLAY_MANIFEST_MAX_BYTES) {
        refuse('OUTPUT_LIMIT', '/candidate', { phase: 'tool' });
      }
    }

    const change = freeze({ path, before: old, after: null, deleted: true });
    this.#deleteChanges.add(change);
    return change;
  }

  async tryPrepareWrite(
    raw: string,
    content: string,
    options?: { readonly softScopeError?: boolean | undefined },
  ): Promise<CandidateMutationPreparation> {
    if (typeof content !== 'string' || new TextDecoder('utf-8', { fatal: true }).decode(Buffer.from(content)) !== content) {
      refuse('TOOL_DENIED', '/content', { phase: 'tool' });
    }
    const hadTrailingSlash = typeof raw === 'string' && raw.length > 1 && raw.endsWith('/') && !raw.endsWith('//');
    const path = this.normalize(hadTrailingSlash ? raw.slice(0, -1) : raw);
    if (!this.isWritable(path)) {
      if (options?.softScopeError) return this.#scopeDeniedError('write', path);
      refuse('TOOL_DENIED', '/path', { phase: 'tool' });
    }
    if (!options?.softScopeError) {
      if (hadTrailingSlash) refuse('TOOL_DENIED', '/path', { phase: 'tool' });
      return freeze({ kind: 'change' as const, change: await this.prepareWrite(path, content) });
    }
    const knownOverlay = this.#files.get(path);
    const baseEntry = this.#isOverlay && !this.#deleted.has(path) ? this.#baseline.get(path) : undefined;
    const isKnown = knownOverlay !== undefined || baseEntry !== undefined;
    const parent = await this.#parent(path, false);
    const leaf = path.split('/').at(-1)!;
    if (parent !== null && await this.#entry(parent, leaf)) {
      const targetStat = await lstat(join(this.root, path));
      if (!targetStat.isSymbolicLink() && targetStat.isDirectory()) {
        if (isKnown) refuse('RECOVERY_REQUIRED', '/candidate', { phase: 'tool' });
        return freeze({
          kind: 'error' as const,
          targetPath: path,
          message: `Cannot write ${path}: path is a directory, not a file.`,
        });
      }
    }
    if (hadTrailingSlash) {
      return freeze({
        kind: 'error' as const,
        targetPath: path,
        message: `Cannot write ${path}: path is a directory, not a file.`,
      });
    }
    return freeze({ kind: 'change' as const, change: this.#prepare(path, await this.#current(path), Buffer.from(content)) });
  }

  async tryPrepareEdit(
    raw: string,
    input: unknown,
    options?: { readonly softScopeError?: boolean | undefined },
  ): Promise<CandidateMutationPreparation> {
    const hadTrailingSlash = typeof raw === 'string' && raw.length > 1 && raw.endsWith('/') && !raw.endsWith('//');
    const path = this.normalize(hadTrailingSlash ? raw.slice(0, -1) : raw);
    const items = list(input, 32, '/edits');
    const validatedEntries = items.map(value => {
      const entry = object(value, ['oldText', 'newText'], '/edits');
      if (typeof entry.oldText !== 'string' || typeof entry.newText !== 'string' || Buffer.from(entry.newText).toString('utf8') !== entry.newText) {
        refuse('TOOL_DENIED', '/edits', { phase: 'tool' });
      }
      return { oldText: entry.oldText, newText: entry.newText };
    });
    if (!this.isWritable(path)) {
      if (options?.softScopeError) return this.#scopeDeniedError('edit', path);
      refuse('TOOL_DENIED', '/path', { phase: 'tool' });
    }
    const knownOverlay = this.#files.get(path);
    const baseEntry = this.#isOverlay && !this.#deleted.has(path) ? this.#baseline.get(path) : undefined;
    const isKnown = knownOverlay !== undefined || baseEntry !== undefined;
    const parent = await this.#parent(path, false);
    const leaf = path.split('/').at(-1)!;
    if (parent === null || !await this.#entry(parent, leaf)) {
      if (isKnown) refuse('RECOVERY_REQUIRED', '/candidate', { phase: 'tool' });
      return freeze({
        kind: 'error' as const,
        targetPath: path,
        message: `Cannot edit ${path}: file does not exist (use write to create new files).`,
      });
    }
    const targetStat = await lstat(join(this.root, path));
    if (!targetStat.isSymbolicLink() && targetStat.isDirectory()) {
      if (isKnown) refuse('RECOVERY_REQUIRED', '/candidate', { phase: 'tool' });
      return freeze({
        kind: 'error' as const,
        targetPath: path,
        message: `Cannot edit ${path}: path is a directory, not a file.`,
      });
    }
    if (hadTrailingSlash) {
      return freeze({
        kind: 'error' as const,
        targetPath: path,
        message: `Cannot edit ${path}: trailing slash is not allowed for file paths.`,
      });
    }
    const before = await this.#current(path);
    if (!before) {
      return freeze({
        kind: 'error' as const,
        targetPath: path,
        message: `Cannot edit ${path}: file does not exist (use write to create new files).`,
      });
    }
    let text: string;
    try {
      text = new TextDecoder('utf-8', { fatal: true }).decode(before);
    } catch {
      return freeze({
        kind: 'error' as const,
        targetPath: path,
        message: `Cannot edit ${path}: file is not valid UTF-8 text.`,
      });
    }
    if (validatedEntries.length === 0) {
      return freeze({
        kind: 'error' as const,
        targetPath: path,
        message: `Edit failed on ${path}: edits list must not be empty.`,
      });
    }
    const ranges: { start: number; end: number; replacement: string }[] = [];
    for (const [editIndex, entry] of validatedEntries.entries()) {
      if (entry.oldText.length === 0) {
        return freeze({
          kind: 'error' as const,
          targetPath: path,
          message: `Edit failed on ${path}: edits[${editIndex}].oldText must not be empty.`,
        });
      }
      const index = text.indexOf(entry.oldText);
      if (index < 0) {
        return freeze({
          kind: 'error' as const,
          targetPath: path,
          message: `Edit failed on ${path}: edits[${editIndex}].oldText was not found in the file. Read the target lines and retry with exact text.`,
        });
      }
      if (text.indexOf(entry.oldText, index + 1) >= 0) {
        return freeze({
          kind: 'error' as const,
          targetPath: path,
          message: `Edit failed on ${path}: edits[${editIndex}].oldText matched multiple locations. Include more surrounding lines so oldText is unique.`,
        });
      }
      ranges.push({ start: index, end: index + entry.oldText.length, replacement: entry.newText });
    }
    ranges.sort((a, b) => a.start - b.start);
    if (ranges.some((range, index) => index > 0 && ranges[index - 1]!.end > range.start)) {
      return freeze({
        kind: 'error' as const,
        targetPath: path,
        message: `Edit failed on ${path}: multiple edits overlap. Merge overlapping edits and retry.`,
      });
    }
    let offset = 0;
    let result = '';
    for (const range of ranges) {
      result += text.slice(offset, range.start) + range.replacement;
      offset = range.end;
    }
    result += text.slice(offset);
    return freeze({ kind: 'change' as const, change: this.#prepare(path, before, Buffer.from(result)) });
  }

  async tryPrepareDelete(
    raw: string,
    options?: { readonly softScopeError?: boolean | undefined },
  ): Promise<CandidateMutationPreparation> {
    const hadTrailingSlash = typeof raw === 'string' && raw.length > 1 && raw.endsWith('/') && !raw.endsWith('//');
    const path = this.normalize(hadTrailingSlash ? raw.slice(0, -1) : raw);
    if (!this.isWritable(path)) {
      if (options?.softScopeError) return this.#scopeDeniedError('delete', path);
      refuse('TOOL_DENIED', '/path', { phase: 'tool' });
    }
    const knownOverlay = this.#files.get(path);
    const baseEntry = this.#isOverlay && !this.#deleted.has(path) ? this.#baseline.get(path) : undefined;
    const isKnown = knownOverlay !== undefined || baseEntry !== undefined;
    const parent = await this.#parent(path, false);
    const leaf = path.split('/').at(-1)!;
    if (parent === null || !await this.#entry(parent, leaf)) {
      if (isKnown) refuse('RECOVERY_REQUIRED', '/candidate', { phase: 'tool' });
      return freeze({
        kind: 'error' as const,
        targetPath: path,
        message: `Cannot delete ${path}: file does not exist.`,
      });
    }
    const targetStat = await lstat(join(this.root, path));
    if (!targetStat.isSymbolicLink() && targetStat.isDirectory()) {
      if (isKnown) refuse('RECOVERY_REQUIRED', '/candidate', { phase: 'tool' });
      return freeze({
        kind: 'error' as const,
        targetPath: path,
        message: `Cannot delete ${path}: path is a directory, not a file.`,
      });
    }
    if (hadTrailingSlash) {
      return freeze({
        kind: 'error' as const,
        targetPath: path,
        message: `Cannot delete ${path}: trailing slash is not allowed for file paths.`,
      });
    }
    return freeze({ kind: 'change' as const, change: await this.prepareDelete(path) });
  }

  async #withUnlockedAncestors<T>(
    relPath: string,
    isDelete: boolean,
    fn: (hooks: { readonly onCreateDir: (dir: string) => void; readonly onPruneDir: (dir: string) => void }) => Promise<T>,
  ): Promise<T> {
    // Unlock existing canonical ancestors root-to-leaf inside try, then relock unlocked/created directories leaf-to-root afterward.
    const unlocked: string[] = [];
    const createdDirs: string[] = [];
    const prunedDirs = new Set<string>();
    let result!: T;
    let opFailed = false;
    let opError: unknown;
    try {
      const segments = relPath.split('/').slice(0, -1);
      let currentDir = this.root;
      for (let i = 0; i <= segments.length; i++) {
        if (i > 0) currentDir = join(currentDir, segments[i - 1]!);
        let info;
        try {
          info = await lstat(currentDir);
        } catch (error) {
          if (absent(error)) break;
          throw error;
        }
        if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== process.getuid?.() || (info.mode & 0o022) !== 0 || await realpath(currentDir) !== resolve(currentDir)) {
          // Stop unlocking at non-canonical or unexpected ancestor; inner checks refuse while the leaf-to-root relock loop restores any unlocked ancestors.
          break;
        }
        if ((info.mode & 0o200) === 0) {
          await chmod(currentDir, 0o755);
          unlocked.push(currentDir);
        }
      }
      result = await fn({
        onCreateDir: dir => { if (unlocked.length > 0) createdDirs.push(dir); },
        onPruneDir: dir => { prunedDirs.add(dir); },
      });
    } catch (error) {
      opFailed = true;
      opError = error;
    }

    let relockError: unknown = null;
    const toRelock = [...unlocked, ...createdDirs];
    for (let i = toRelock.length - 1; i >= 0; i--) {
      const dir = toRelock[i]!;
      try {
        await chmod(dir, 0o555);
        const verified = await lstat(dir);
        if (!verified.isDirectory() || verified.isSymbolicLink() || (verified.mode & 0o777) !== 0o555) {
          relockError ??= new PiFailure({ code: 'RECOVERY_REQUIRED', path: '/candidate', phase: 'tool', retryable: false, effect: 'possible', requestId: null, operationId: null, stateErrorCode: null });
        }
      } catch (error) {
        if (isDelete && dir !== this.root && prunedDirs.has(resolve(dir)) && absent(error)) continue;
        relockError ??= error;
      }
    }
    if (opFailed) throw opError;
    if (relockError !== null) throw relockError;
    return result;
  }

  async commit(change: CandidateChange, guard: () => void): Promise<ArtifactRef | null> {
    const isDelete = this.#deleteChanges.has(change);
    const bytes = this.#changes.get(change);
    if ((!isDelete && !bytes) || this.#used.has(change)) refuse('TOOL_DENIED', '/operation', { phase: 'tool' });
    this.#used.add(change);
    const path = this.normalize(change.path);
    this.#writable(path);

    if (isDelete) {
      this.#lastPrunedDirectories.clear();
      return this.#withUnlockedAncestors(path, true, async ({ onPruneDir }) => {
        const parent = await this.#parent(path, false);
        if (!parent) refuse('TOOL_DENIED', '/path', { phase: 'tool' });
        const current = await this.#current(path), before = current === null ? null : artifact(path, current);
        if (canonical(before) !== canonical(change.before)) refuse('RECOVERY_REQUIRED', '/candidate', { phase: 'tool' });
        guard();
        const targetPath = join(this.root, path);
        await unlink(targetPath);
        await pruneEmptyDirectories(this.root, path, dir => {
          this.#lastPrunedDirectories.add(dir);
          onPruneDir(dir);
        });
        await this.#syncDeepestSurvivingDirectory(path);
        const prevOverlayBytes = this.#overlayByteLength(path);
        this.#total -= prevOverlayBytes;
        this.#files.delete(path);
        this.#baselineStats.delete(path);
        this.#verifiedBaseline.delete(path);
        if (this.#isOverlay && this.#baseline.has(path)) {
          this.#deleted.add(path);
        }
        return null;
      });
    }

    const writeBytes = bytes!;
    return this.#withUnlockedAncestors(path, false, async ({ onCreateDir }) => {
      const parent = await this.#parent(path, true, guard, onCreateDir);
      if (!parent) refuse('TOOL_DENIED', '/path', { phase: 'tool' });
      const current = await this.#current(path), before = current === null ? null : artifact(path, current);
      if (canonical(before) !== canonical(change.before)) refuse('RECOVERY_REQUIRED', '/candidate', { phase: 'tool' });
      const baseEntry = this.#baseline.get(path);
      const fileMode = baseEntry?.mode === '100755' ? 0o555 : 0o444;
      const temporary = join(parent, '.lw-write-' + randomBytes(16).toString('hex'));
      guard();
      const descriptor = await open(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, fileMode);
      try {
        try {
          await descriptor.writeFile(writeBytes);
          await descriptor.chmod(fileMode);
          await descriptor.sync();
        } finally {
          await descriptor.close();
        }
        await this.#parent(path, false);
        const latest = await this.#current(path);
        if (canonical(latest === null ? null : artifact(path, latest)) !== canonical(change.before)) {
          refuse('RECOVERY_REQUIRED', '/candidate', { phase: 'tool' });
        }
        guard();
        const targetPath = join(this.root, path);
        await rename(temporary, targetPath);
        const directory = await open(parent, constants.O_RDONLY | constants.O_NOFOLLOW);
        try { await directory.sync(); } finally { await directory.close(); }

        const prevOverlayBytes = this.#overlayByteLength(path);
        if (this.#isOverlay) {
          this.#deleted.delete(path);
          const revertsToBaseline = baseEntry !== undefined && gitBlobOid(this.#objectFormat!, writeBytes) === baseEntry.oid;
          if (revertsToBaseline) {
            this.#total -= prevOverlayBytes;
            this.#files.delete(path);
            const info = await lstat(targetPath, { bigint: true });
            this.#baselineStats.set(path, fingerprintFromStat(info));
            this.#verifiedBaseline.add(path);
          } else {
            this.#total += writeBytes.length - prevOverlayBytes;
            this.#files.set(path, change.after!);
            this.#baselineStats.delete(path);
            this.#verifiedBaseline.delete(path);
          }
        } else {
          this.#total += writeBytes.length - prevOverlayBytes;
          this.#files.set(path, change.after!);
        }
        return change.after!;
      } finally {
        await unlink(temporary).catch(error => { if (!absent(error)) throw error; });
      }
    });
  }

  async #syncDeepestSurvivingDirectory(filePath: string): Promise<void> {
    const segments = filePath.split('/').slice(0, -1);
    for (let i = segments.length; i >= 0; i--) {
      const dirPath = i === 0 ? this.root : join(this.root, ...segments.slice(0, i));
      try {
        const dir = await open(dirPath, constants.O_RDONLY | constants.O_NOFOLLOW);
        try { await dir.sync(); } finally { await dir.close(); }
        return;
      } catch (error) {
        if (absent(error) && i > 0) continue;
        throw error;
      }
    }
  }

  async manifest(): Promise<ArtifactManifest> {
    let seenOverlay = 0;
    let seenBaseline = 0;
    const visit = async (parent: string, prefix: string): Promise<void> => {
      await this.#directory(parent);
      const entries = await readdir(parent);
      if (entries.length > this.#dirEntryLimit(false)) refuse('OUTPUT_LIMIT', '/candidate');
      for (const entry of entries) {
        const name = prefix ? prefix + '/' + entry : entry;
        const fullPath = join(parent, entry);
        const info = await lstat(fullPath, { bigint: true });
        this.normalize(name);
        if (info.isSymbolicLink()) refuse('RECOVERY_REQUIRED', '/candidate');
        if (info.isDirectory()) {
          await visit(fullPath, name);
          continue;
        }
        if (this.#files.has(name)) {
          await this.#current(name);
          seenOverlay++;
          continue;
        }
        if (this.#isOverlay && !this.#deleted.has(name)) {
          const baseEntry = this.#baseline.get(name);
          if (baseEntry) {
            const currentFingerprint = verifyUntouchedBaselineStat(info, baseEntry);
            const recorded = this.#baselineStats.get(name);
            if (recorded) {
              if (!sameFingerprint(recorded, currentFingerprint)) refuse('RECOVERY_REQUIRED', '/candidate');
            } else {
              if (this.#baselineStatsCaptured) refuse('RECOVERY_REQUIRED', '/candidate');
              await this.#current(name);
            }
            seenBaseline++;
            continue;
          }
        }
        refuse('RECOVERY_REQUIRED', '/candidate');
      }
    };
    await visit(this.root, '');

    let expectedBaseline = 0;
    if (this.#isOverlay) {
      for (const name of this.#baseline.keys()) {
        if (!this.#files.has(name) && !this.#deleted.has(name)) expectedBaseline++;
      }
    }
    if (seenOverlay !== this.#files.size || seenBaseline !== expectedBaseline) {
      refuse('RECOVERY_REQUIRED', '/candidate');
    }

    if (this.#isOverlay) {
      const manifest = this.#buildOverlayManifest(this.#files, this.#deleted);
      if (manifest.spec.entries.length > LIMITS.overlayEntries || (manifest.spec.deleted?.length ?? 0) > LIMITS.overlayEntries || this.#total > OVERLAY_MAX_BYTES || Buffer.byteLength(canonical(manifest)) > OVERLAY_MANIFEST_MAX_BYTES) {
        refuse('OUTPUT_LIMIT', '/candidate');
      }
      return freeze(manifest);
    }

    const entries = [...this.#files.values()].sort((a, b) => compareUtf16(a.name, b.name));
    return freeze({ apiVersion: 'loopwright.dev/v1alpha1', kind: 'ArtifactManifest', metadata: { id: 'candidate' }, spec: { entries } });
  }
}
