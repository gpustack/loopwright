import { realpath, lstat } from 'node:fs/promises';
import { resolve } from 'node:path';
import {
  LIMITS,
  digestArtifact,
  identifyManifest,
  type ArtifactManifest,
  type ArtifactRef,
  type BaseTreeAnchor,
  type TaskContract,
} from '@loopwright/core';
import type { PiBaselineEntry } from '@loopwright/agent-pi';
import { canonicalComponents } from './files.js';
import { canonical, hash, integer, list, record, same, text } from './schema.js';
import { ControllerFailure, refuse, type ControllerDiagnostic } from './errors.js';
import {
  canonicalizeCandidateManifest,
  compareUtf16,
  gitObjectOid,
  parseGitTreeEntries,
  type ParsedGitTreeEntry,
} from './git-objects.js';
import type { ControllerOwner } from './ownership.js';
import { checkedRef, type ArtifactStore, type ArtifactReader } from './storage.js';
import { parsePrivateJson } from './parser.js';
import type { WorkDeadline } from './deadlines.js';

export { canonicalizeCandidateManifest, compareUtf16, gitObjectOid, parseGitTreeEntries, type ParsedGitTreeEntry };

export interface BaselineMerkleProof {
  readonly mode: '100644' | '100755';
  readonly oid: string;
  readonly byteLength: number;
  readonly trees: readonly Uint8Array[];
  readonly blob: Uint8Array;
  readonly treeCount?: number;
  readonly treeProofBytes?: number;
}

export interface FrozenSource {
  readonly version: 1 | 2;
  readonly repository: string;
  readonly directory: string;
  readonly baseObject: string;
  readonly sourceObject: string;
  readonly manifest: ArtifactManifest;
  readonly inventory: ArtifactRef;
  readonly workspace: ArtifactRef;
  readonly artifacts: readonly { readonly name: string; readonly bytes: Uint8Array }[];
  readonly baselineEntries?: readonly PiBaselineEntry[];
  readonly sourceTree?: ArtifactRef;
  readonly baselineProofs?: Readonly<Record<string, BaselineMerkleProof>>;
}

const decoded = (value: Buffer): string => {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(value);
  } catch {
    refuse('TARGET_MISMATCH', '', 'admission');
  }
};

// Must stay in lockstep with `matches()` in `@loopwright/core` (`packages/core/src/scope.ts`).
function matchesScopePattern(pattern: string, name: string): boolean {
  if (pattern === '**') return true;
  if (!pattern.endsWith('/**')) return pattern === name;
  const prefix = pattern.slice(0, -3);
  return name === prefix || name.startsWith(`${prefix}/`);
}

function isProtectedByScope(name: string, protectedPatterns: readonly string[]): boolean {
  return protectedPatterns.some(pattern => matchesScopePattern(pattern, name));
}

function isValidGitArtifactName(name: string): boolean {
  return !name.split('/').some(segment => segment.toLowerCase() === '.git' || Buffer.byteLength(segment, 'utf8') > 255)
    && digestArtifact(name, new Uint8Array()).ok;
}

function assertNoPathCollisions(names: readonly string[], code: ControllerDiagnostic['code'], phase: ControllerDiagnostic['phase']): void {
  const seenNorm = new Set<string>();
  for (const name of names) {
    const norm = name.normalize('NFC').toLowerCase();
    if (seenNorm.has(norm)) refuse(code, '', phase);
    seenNorm.add(norm);
  }
  for (const norm of seenNorm) {
    let slash = norm.indexOf('/');
    while (slash !== -1) {
      if (seenNorm.has(norm.slice(0, slash))) refuse(code, '', phase);
      slash = norm.indexOf('/', slash + 1);
    }
  }
}

async function object(owner: ControllerOwner, directory: string, revision: string): Promise<string> {
  const value = decoded(await owner.git(directory, ['rev-parse', '--verify', '--end-of-options', revision + '^{commit}'], 256)).trim();
  if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(value)) refuse('TARGET_MISMATCH', '', 'admission');
  return value;
}

async function treeObject(owner: ControllerOwner, directory: string, commitOid: string, objectFormat: 'sha1' | 'sha256'): Promise<string> {
  const value = decoded(await owner.git(directory, ['rev-parse', '--verify', '--end-of-options', commitOid + '^{tree}'], 256)).trim();
  const pattern = objectFormat === 'sha1' ? /^[0-9a-f]{40}$/ : /^[0-9a-f]{64}$/;
  if (!pattern.test(value)) refuse('TARGET_MISMATCH', '', 'admission');
  return value;
}

export async function resolveBaselineMerkleProofs(
  directory: string,
  owner: ControllerOwner,
  baseTree: BaseTreeAnchor,
  baselineEntries: readonly PiBaselineEntry[],
  jsonPaths: readonly string[],
): Promise<Readonly<Record<string, BaselineMerkleProof>> | undefined> {
  if (jsonPaths.length === 0) return undefined;
  const byPath = new Map(baselineEntries.map(entry => [entry.name, entry]));
  const oidByteLength: 20 | 32 = baseTree.objectFormat === 'sha1' ? 20 : 32;
  const proofs = Object.create(null) as Record<string, BaselineMerkleProof>;
  let found = 0;

  for (const path of new Set(jsonPaths)) {
    const entry = byPath.get(path);
    if (!entry) continue;
    const segments = path.split('/');
    if (segments.length > 16) {
      proofs[path] = {
        mode: entry.mode,
        oid: entry.oid,
        byteLength: entry.byteLength,
        trees: [],
        blob: new Uint8Array(0),
        treeCount: segments.length,
      };
      found++;
      continue;
    }

    let currentTreeOid = baseTree.treeOid;
    const trees: Uint8Array[] = [];
    let totalTreeBytes = 0;
    let oversizeTreeBytes: number | undefined;

    for (let i = 0; i < segments.length; i++) {
      const seg = segments[i]!;
      const encodedTreeSize = decoded(await owner.git(directory, ['cat-file', '-s', currentTreeOid], 64)).trim();
      if (!/^(?:0|[1-9][0-9]{0,9})$/.test(encodedTreeSize)) refuse('TARGET_MISMATCH', '', 'admission');
      const treeSize = Number(encodedTreeSize);
      if (totalTreeBytes + treeSize > 262_144) {
        oversizeTreeBytes = totalTreeBytes + treeSize;
        break;
      }
      totalTreeBytes += treeSize;

      const rawTree = await owner.git(directory, ['cat-file', 'tree', currentTreeOid], 262_145);
      const treeBytes = new Uint8Array(rawTree);
      if (treeBytes.byteLength !== treeSize || gitObjectOid(baseTree.objectFormat, 'tree', treeBytes) !== currentTreeOid) {
        refuse('TARGET_MISMATCH', '', 'admission');
      }
      const treeEntries = parseGitTreeEntries(treeBytes, oidByteLength, 'admission', 'TARGET_MISMATCH');
      const matched = treeEntries.find(item => item.name === seg);
      if (!matched) refuse('TARGET_MISMATCH', '', 'admission');
      trees.push(treeBytes);
      if (i < segments.length - 1) {
        if (matched.mode !== '40000' && matched.mode !== '040000') refuse('TARGET_MISMATCH', '', 'admission');
        currentTreeOid = matched.oid;
      } else {
        if (matched.mode !== entry.mode || matched.oid !== entry.oid) refuse('TARGET_MISMATCH', '', 'admission');
      }
    }

    if (oversizeTreeBytes !== undefined) {
      proofs[path] = {
        mode: entry.mode,
        oid: entry.oid,
        byteLength: entry.byteLength,
        trees: [],
        blob: new Uint8Array(0),
        treeCount: segments.length,
        treeProofBytes: oversizeTreeBytes,
      };
      found++;
      continue;
    }

    if (entry.byteLength > 4_194_304) {
      proofs[path] = {
        mode: entry.mode,
        oid: entry.oid,
        byteLength: entry.byteLength,
        trees,
        blob: new Uint8Array(0),
      };
      found++;
      continue;
    }

    const rawBlob = await owner.git(directory, ['cat-file', 'blob', entry.oid], entry.byteLength + 1);
    const blobBytes = new Uint8Array(rawBlob);
    if (blobBytes.byteLength !== entry.byteLength || gitObjectOid(baseTree.objectFormat, 'blob', blobBytes) !== entry.oid) {
      refuse('TARGET_MISMATCH', '', 'admission');
    }
    proofs[path] = { mode: entry.mode, oid: entry.oid, byteLength: entry.byteLength, trees, blob: blobBytes };
    found++;
  }

  return found > 0 ? proofs : undefined;
}

export function parseSourceTree(
  bytes: Uint8Array,
  objectFormat: 'sha1' | 'sha256',
  phase: 'admission' | 'recovery' = 'recovery',
): readonly PiBaselineEntry[] {
  if (bytes.byteLength > 8_388_608) refuse(phase === 'admission' ? 'CONFIG_LIMIT' : 'ARTIFACT_INVALID', '', phase);
  if (bytes.byteLength === 0) return [];
  if (bytes.at(-1) !== 10) refuse('ARTIFACT_INVALID', '', phase);
  let rawText: string;
  try {
    rawText = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    refuse('ARTIFACT_INVALID', '', phase);
  }
  const lines = rawText.slice(0, -1).split('\n');
  if (lines.length > LIMITS.baselineEntries) refuse('ARTIFACT_INVALID', '', phase);
  const oidPattern = objectFormat === 'sha1' ? /^[0-9a-f]{40}$/ : /^[0-9a-f]{64}$/;
  const entries: PiBaselineEntry[] = [];
  let prevName: string | null = null;

  for (const line of lines) {
    const parts = line.split('\t');
    if (parts.length !== 4) refuse('ARTIFACT_INVALID', '', phase);
    const [mode, oid, sizeStr, jsonName] = parts as [string, string, string, string];
    if (mode !== '100644' && mode !== '100755') refuse('ARTIFACT_INVALID', '', phase);
    if (!oidPattern.test(oid)) refuse('ARTIFACT_INVALID', '', phase);
    if (!/^(?:0|[1-9][0-9]*)$/.test(sizeStr)) refuse('ARTIFACT_INVALID', '', phase);
    const byteLength = Number(sizeStr);
    if (!Number.isSafeInteger(byteLength) || byteLength < 0) refuse('ARTIFACT_INVALID', '', phase);
    let parsedName: unknown;
    try {
      parsedName = JSON.parse(jsonName);
    } catch {
      refuse('ARTIFACT_INVALID', '', phase);
    }
    if (typeof parsedName !== 'string' || !isValidGitArtifactName(parsedName)) refuse('ARTIFACT_INVALID', '', phase);
    if (prevName !== null && prevName >= parsedName) refuse('ARTIFACT_INVALID', '', phase);
    prevName = parsedName;
    entries.push(Object.freeze({ name: parsedName, mode, oid, byteLength }));
  }

  assertNoPathCollisions(entries.map(item => item.name), 'ARTIFACT_INVALID', phase);
  return Object.freeze(entries);
}

export function assertCanonicalMinimalOverlay(
  candidateManifest: ArtifactManifest,
  candidateFiles: readonly { readonly name: string; readonly bytes: Uint8Array }[],
  source: FrozenSource,
  phase: 'execution' | 'recovery' = 'execution',
): void {
  if (source.version === 1) {
    if (candidateManifest.spec.baseTree !== undefined || candidateManifest.spec.deleted !== undefined) {
      refuse('RECOVERY_REQUIRED', '', phase);
    }
    return;
  }
  const sourceBaseTree = source.manifest.spec.baseTree;
  if (
    candidateManifest.spec.baseTree === undefined
    || candidateManifest.spec.deleted === undefined
    || sourceBaseTree === undefined
    || !same(candidateManifest.spec.baseTree, sourceBaseTree)
  ) {
    refuse('RECOVERY_REQUIRED', '', phase);
  }
  const baselineByPath = new Map((source.baselineEntries ?? []).map(entry => [entry.name, entry]));
  for (const deletedPath of candidateManifest.spec.deleted) {
    if (!baselineByPath.has(deletedPath)) refuse('RECOVERY_REQUIRED', '', phase);
  }
  if (candidateFiles.length !== candidateManifest.spec.entries.length) {
    refuse('RECOVERY_REQUIRED', '', phase);
  }
  const filesByPath = new Map<string, Uint8Array>();
  for (const file of candidateFiles) {
    if (filesByPath.has(file.name)) refuse('RECOVERY_REQUIRED', '', phase);
    filesByPath.set(file.name, file.bytes);
  }
  const deletedSet = new Set(candidateManifest.spec.deleted);
  const survivingBaselineNorms = new Set<string>();
  const survivingBaselineDirs = new Set<string>();
  for (const basePath of baselineByPath.keys()) {
    if (deletedSet.has(basePath)) continue;
    const norm = basePath.normalize('NFC').toLowerCase();
    survivingBaselineNorms.add(norm);
    let slash = norm.indexOf('/');
    while (slash !== -1) {
      survivingBaselineDirs.add(norm.slice(0, slash));
      slash = norm.indexOf('/', slash + 1);
    }
  }
  for (const entry of candidateManifest.spec.entries) {
    const bytes = filesByPath.get(entry.name);
    if (!bytes) refuse('RECOVERY_REQUIRED', '', phase);
    const actual = digestArtifact(entry.name, bytes);
    if (!actual.ok || !same(actual.value, entry)) refuse('RECOVERY_REQUIRED', '', phase);
    const baselineEntry = baselineByPath.get(entry.name);
    if (baselineEntry !== undefined) {
      if (deletedSet.has(entry.name)) refuse('RECOVERY_REQUIRED', '', phase);
      if (gitObjectOid(sourceBaseTree.objectFormat, 'blob', bytes) === baselineEntry.oid) {
        refuse('RECOVERY_REQUIRED', '', phase);
      }
    } else {
      const norm = entry.name.normalize('NFC').toLowerCase();
      if (survivingBaselineNorms.has(norm) || survivingBaselineDirs.has(norm)) {
        refuse('RECOVERY_REQUIRED', '', phase);
      }
      let slash = norm.indexOf('/');
      while (slash !== -1) {
        if (survivingBaselineNorms.has(norm.slice(0, slash))) refuse('RECOVERY_REQUIRED', '', phase);
        slash = norm.indexOf('/', slash + 1);
      }
    }
  }
}

export async function materializeBaseline(
  source: FrozenSource,
  baselineDir: string,
  owner: ControllerOwner,
  deadline: WorkDeadline | AbortSignal,
): Promise<void> {
  if (source.version !== 2) refuse('ARTIFACT_INVALID', '', 'execution');
  if (deadline instanceof AbortSignal) {
    if (deadline.aborted) refuse('CANCELLED', '', 'execution');
    await owner.materializeGitBatch(source.directory, source.baselineEntries ?? [], baselineDir, deadline, 120_000);
    return;
  }
  const view = deadline.assert();
  const remainingMs = Number(BigInt(view.clock.basis.taskDeadlineMonotonicMs) - BigInt(view.clock.sampledNow.monotonicMs));
  if (remainingMs <= 0) refuse('DEADLINE', '', 'execution');
  try {
    await owner.materializeGitBatch(source.directory, source.baselineEntries ?? [], baselineDir, deadline.abort.signal, Math.min(remainingMs, 120_000));
  } catch (error) {
    if (error instanceof ControllerFailure && error.diagnostic.code === 'CANCELLED' && deadline.reason !== null) {
      refuse(deadline.reason, '', 'execution');
    }
    throw error;
  }
}

export async function freezeSource(
  repository: string,
  task: TaskContract,
  owner: ControllerOwner,
  store: ArtifactStore,
  jsonPaths: readonly string[] = [],
): Promise<FrozenSource> {
  const directory = resolve(repository);
  await canonicalComponents(directory);
  const info = await lstat(directory);
  if (!info.isDirectory() || info.uid !== process.getuid?.() || await realpath(directory) !== directory) {
    refuse('TARGET_MISMATCH', '', 'admission');
  }
  const top = decoded(await owner.git(directory, ['rev-parse', '--show-toplevel'], 4096)).trim();
  if (top !== directory) refuse('TARGET_MISMATCH', '', 'admission');
  const baseObject = await object(owner, directory, task.spec.target.baseRevision);
  const sourceObject = await object(owner, directory, task.spec.target.sourceRevision);

  let tree: Buffer;
  try {
    tree = await owner.git(directory, ['ls-tree', '-r', '-l', '-z', '--full-tree', sourceObject], 16_777_216);
  } catch (error) {
    if (error instanceof ControllerFailure && error.diagnostic.code === 'OUTPUT_LIMIT') {
      refuse('CONFIG_LIMIT', '', 'admission');
    }
    throw error;
  }
  if (tree.length && tree.at(-1) !== 0) refuse('CONFIG_LIMIT', '', 'admission');
  let treeText: string;
  try {
    treeText = tree.length ? new TextDecoder('utf-8', { fatal: true }).decode(tree) : '';
  } catch {
    refuse('CAPABILITY_UNSUPPORTED', '', 'admission');
  }
  const rows = treeText ? treeText.split('\0').slice(0, -1) : [];

  const descriptions: PiBaselineEntry[] = [];
  for (const row of rows) {
    const symlinkMatch = /^120000 blob ([0-9a-f]{40}|[0-9a-f]{64}) +[0-9-]+\t(.+)$/s.exec(row);
    const gitlinkMatch = /^160000 commit ([0-9a-f]{40}|[0-9a-f]{64}) +-\t(.+)$/s.exec(row);
    const special = symlinkMatch ?? gitlinkMatch;
    if (special) {
      const name = special[2]!;
      if (!isValidGitArtifactName(name) || !isProtectedByScope(name, task.spec.scope.protected)) {
        refuse('CAPABILITY_UNSUPPORTED', '', 'admission');
      }
      continue;
    }
    const match = /^(100644|100755) blob ([0-9a-f]{40}|[0-9a-f]{64}) +([0-9]+)\t(.+)$/s.exec(row);
    if (!match) refuse('CAPABILITY_UNSUPPORTED', '', 'admission');
    const mode = match[1] as '100644' | '100755';
    const oid = match[2]!;
    const sizeStr = match[3]!;
    const name = match[4]!;
    if (!/^(?:0|[1-9][0-9]*)$/.test(sizeStr)) refuse('CAPABILITY_UNSUPPORTED', '', 'admission');
    const byteLength = Number(sizeStr);
    if (!Number.isSafeInteger(byteLength) || byteLength < 0 || !isValidGitArtifactName(name)) {
      refuse('CAPABILITY_UNSUPPORTED', '', 'admission');
    }
    descriptions.push({ name, mode, oid, byteLength });
  }

  if (descriptions.length > LIMITS.baselineEntries) refuse('CONFIG_LIMIT', '', 'admission');
  descriptions.sort((a, b) => compareUtf16(a.name, b.name));
  assertNoPathCollisions(descriptions.map(item => item.name), 'CAPABILITY_UNSUPPORTED', 'admission');
  // All topology is checked before any 5th git call or candidate body is materialized.

  const MANIFEST_JSON_LIMIT = 32_768;
  const INVENTORY_JSON_LIMIT = 262_144;
  const totalBytes = descriptions.reduce((sum, item) => sum + item.byteLength, 0);
  let useClassic = false;
  if (descriptions.length <= 128 && totalBytes <= 4_194_304) {
    const freshDummyDigest = () => ({ algorithm: 'sha256' as const, hex: '0'.repeat(64) });
    const sizingRefs = descriptions.map(description => ({
      name: description.name,
      byteLength: description.byteLength,
      digest: freshDummyDigest(),
    }));
    const sizingIdentified = identifyManifest({
      apiVersion: 'loopwright.dev/v1alpha1',
      kind: 'ArtifactManifest',
      metadata: { id: 'candidate' },
      spec: { entries: sizingRefs },
    });
    if (sizingIdentified.ok) {
      const sizingManifestBytes = Buffer.byteLength(canonical(sizingIdentified.value.manifest), 'utf8');
      if (sizingManifestBytes <= MANIFEST_JSON_LIMIT) {
        const sizingInventory = {
          version: 1,
          repository: task.spec.target.repository,
          directory,
          baseObject,
          sourceObject,
          manifest: {
            name: 'manifest-' + '0'.repeat(64) + '.bin',
            byteLength: sizingManifestBytes,
            digest: freshDummyDigest(),
          },
          entries: descriptions.map((description, index) => ({
            name: description.name,
            mode: description.mode,
            oid: description.oid,
            ref: {
              name: description.name,
              byteLength: description.byteLength,
              digest: freshDummyDigest(),
            },
            artifact: {
              name: `source-file-${index.toString(16).padStart(64, '0')}.bin`,
              byteLength: description.byteLength,
              digest: freshDummyDigest(),
            },
          })),
        };
        useClassic = Buffer.byteLength(canonical(sizingInventory), 'utf8') <= INVENTORY_JSON_LIMIT;
      }
    }
  }

  if (useClassic) {
    const files: { readonly name: string; readonly bytes: Uint8Array }[] = [];
    const prospectiveEntries: { readonly name: string; readonly mode: string; readonly oid: string; readonly ref: ArtifactRef; readonly artifact: ArtifactRef }[] = [];
    let total = 0;
    for (const description of descriptions) {
      const encoded = decoded(await owner.git(directory, ['cat-file', '-s', description.oid], 64)).trim();
      if (!/^(?:0|[1-9][0-9]{0,9})$/.test(encoded)) refuse('TARGET_MISMATCH', '', 'admission');
      const size = Number(encoded);
      total += size;
      if (size !== description.byteLength || total > 4_194_304) refuse('TARGET_MISMATCH', '', 'admission');
      const bytes = await owner.git(directory, ['cat-file', 'blob', description.oid], size + 1);
      if (bytes.byteLength !== size) refuse('TARGET_MISMATCH', '', 'admission');
      const ref = digestArtifact(description.name, bytes);
      if (!ref.ok) refuse('ARTIFACT_INVALID', '', 'admission');
      const artifactName = 'source-file-' + hash('loopwright.dev/controller/artifact/source-file/v1\0' + hash(bytes).hex).hex + '.bin';
      const artifactRef = digestArtifact(artifactName, bytes);
      if (!artifactRef.ok) refuse('ARTIFACT_INVALID', '', 'admission');
      files.push({ name: description.name, bytes: new Uint8Array(bytes) });
      prospectiveEntries.push({ name: description.name, mode: description.mode, oid: description.oid, ref: ref.value, artifact: artifactRef.value });
    }
    const identified = identifyManifest({
      apiVersion: 'loopwright.dev/v1alpha1',
      kind: 'ArtifactManifest',
      metadata: { id: 'candidate' },
      spec: { entries: prospectiveEntries.map(item => item.ref) },
    });
    if (identified.ok) {
      const manifestBytes = Buffer.from(canonical(identified.value.manifest));
      if (manifestBytes.byteLength <= MANIFEST_JSON_LIMIT) {
        const manifestName = 'manifest-' + hash('loopwright.dev/controller/artifact/manifest/v1\0' + hash(manifestBytes).hex).hex + '.bin';
        const prospectiveManifestRef = digestArtifact(manifestName, manifestBytes);
        if (prospectiveManifestRef.ok) {
          const prospectiveInventory = {
            version: 1,
            repository: task.spec.target.repository,
            directory,
            baseObject,
            sourceObject,
            manifest: prospectiveManifestRef.value,
            entries: prospectiveEntries,
          };
          if (Buffer.byteLength(canonical(prospectiveInventory)) <= INVENTORY_JSON_LIMIT) {
            const entries = [];
            for (let i = 0; i < files.length; i++) {
              const artifact = await store.put('source-file', files[i]!.bytes);
              entries.push({ ...prospectiveEntries[i]!, artifact });
            }
            const manifest = identified.value.manifest;
            const manifestRef = await store.json('manifest', manifest, MANIFEST_JSON_LIMIT);
            const inventory = await store.json('source', { version: 1, repository: task.spec.target.repository, directory, baseObject, sourceObject, manifest: manifestRef, entries }, INVENTORY_JSON_LIMIT);
            const workspace = await store.json('workspace', { version: 1, format: 'controller-passive-workspace', inventory, manifest: manifestRef }, 65_536);
            return { version: 1, repository: task.spec.target.repository, directory, baseObject, sourceObject, manifest, inventory, workspace, artifacts: files };
          }
        }
      }
    }
  }

  // tree_overlay mode (version: 2): zero source-file CAS blob copies.
  const objectFormatRaw = decoded(await owner.git(directory, ['rev-parse', '--show-object-format'], 64)).trim();
  if (objectFormatRaw !== 'sha1' && objectFormatRaw !== 'sha256') refuse('CAPABILITY_UNSUPPORTED', '', 'admission');
  const objectFormat = objectFormatRaw;
  const treeOid = await treeObject(owner, directory, sourceObject, objectFormat);
  const oidPattern = objectFormat === 'sha1' ? /^[0-9a-f]{40}$/ : /^[0-9a-f]{64}$/;
  if (!oidPattern.test(sourceObject) || descriptions.some(item => !oidPattern.test(item.oid))) {
    refuse('CAPABILITY_UNSUPPORTED', '', 'admission');
  }
  const baseTree: BaseTreeAnchor = { objectFormat, commitOid: sourceObject, treeOid };
  const sourceTreeBytes = Buffer.from(
    descriptions.map(item => `${item.mode}\t${item.oid}\t${item.byteLength}\t${JSON.stringify(item.name)}\n`).join(''),
    'utf8',
  );
  if (sourceTreeBytes.byteLength > 8_388_608) refuse('CONFIG_LIMIT', '', 'admission');
  const sourceTreeRef = await store.put('source-tree', sourceTreeBytes, 8_388_608);

  const identified = identifyManifest({
    apiVersion: 'loopwright.dev/v1alpha1',
    kind: 'ArtifactManifest',
    metadata: { id: 'candidate' },
    spec: { baseTree, entries: [], deleted: [] },
  });
  if (!identified.ok) refuse('ARTIFACT_INVALID', '', 'admission');
  const manifest = identified.value.manifest;
  const manifestRef = await store.json('manifest', manifest, 32_768);
  const inventory = await store.json('source', {
    version: 2,
    repository: task.spec.target.repository,
    directory,
    baseObject,
    sourceObject,
    baseTree,
    manifest: manifestRef,
    sourceTree: sourceTreeRef,
    entryCount: descriptions.length,
  }, 262_144);
  const workspace = await store.json('workspace', {
    version: 1,
    format: 'controller-passive-workspace',
    inventory,
    manifest: manifestRef,
  }, 65_536);
  const baselineProofs = await resolveBaselineMerkleProofs(directory, owner, baseTree, descriptions, jsonPaths);
  return {
    version: 2,
    repository: task.spec.target.repository,
    directory,
    baseObject,
    sourceObject,
    manifest,
    inventory,
    workspace,
    artifacts: [],
    baselineEntries: Object.freeze(descriptions),
    sourceTree: sourceTreeRef,
    ...(baselineProofs ? { baselineProofs } : {}),
  };
}

export async function verifySource(source: FrozenSource, task: TaskContract, owner: ControllerOwner): Promise<void> {
  if (!same([source.baseObject, source.sourceObject], [await object(owner, source.directory, task.spec.target.baseRevision), await object(owner, source.directory, task.spec.target.sourceRevision)])) {
    refuse('TARGET_MISMATCH', '', 'execution');
  }
  if (source.version === 2 || source.manifest.spec.baseTree !== undefined) {
    const baseTree = source.manifest.spec.baseTree;
    if (!baseTree || baseTree.commitOid !== source.sourceObject) refuse('TARGET_MISMATCH', '', 'execution');
    const actualTreeOid = await treeObject(owner, source.directory, source.sourceObject, baseTree.objectFormat);
    if (actualTreeOid !== baseTree.treeOid) refuse('TARGET_MISMATCH', '', 'execution');
  }
}

/** Reopen the original frozen bytes, then re-resolve its exact declared refs. No replacement inventory is created. */
export async function restoreSource(
  repository: string,
  task: TaskContract,
  owner: ControllerOwner,
  reader: ArtifactReader,
  inventory: ArtifactRef,
  workspace: ArtifactRef,
  jsonPaths: readonly string[] = [],
): Promise<FrozenSource> {
  const raw = parsePrivateJson(await reader.read(inventory, 262_144), 262_144);
  const directory = resolve(repository);
  const rawVersion = raw !== null && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>).version : undefined;

  if (rawVersion === 1) {
    const value = record(raw, ['version', 'repository', 'directory', 'baseObject', 'sourceObject', 'manifest', 'entries']);
    if (
      value.repository !== task.spec.target.repository
      || value.directory !== directory
      || !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(text(value.baseObject))
      || !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(text(value.sourceObject))
    ) {
      refuse('TARGET_MISMATCH', '', 'recovery');
    }
    await canonicalComponents(directory);
    const info = await lstat(directory);
    if (!info.isDirectory() || info.uid !== process.getuid?.() || await realpath(directory) !== directory) {
      refuse('TARGET_MISMATCH', '', 'recovery');
    }
    const manifestRef = checkedRef(value.manifest);
    const identified = identifyManifest(parsePrivateJson(await reader.read(manifestRef, 32_768), 32_768));
    if (!identified.ok || identified.value.manifest.metadata.id !== 'candidate' || identified.value.manifest.spec.baseTree !== undefined) {
      refuse('ARTIFACT_INVALID', '', 'recovery');
    }
    const entries = list(value.entries, '', 256).map(item => record(item, ['name', 'mode', 'oid', 'ref', 'artifact']));
    const artifacts = [];
    let total = 0;
    if (
      !same(entries.map(entry => entry.ref), identified.value.manifest.spec.entries)
      || !same([...entries].sort((a, b) => compareUtf16(text(a.name), text(b.name))), entries)
    ) {
      refuse('ARTIFACT_INVALID', '', 'recovery');
    }
    const names = new Set<string>();
    for (const entry of entries) {
      const name = text(entry.name, '', 4096), ref = checkedRef(entry.ref), artifact = checkedRef(entry.artifact);
      if (
        name !== ref.name
        || !['100644', '100755'].includes(text(entry.mode))
        || !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(text(entry.oid))
        || name.split('/').some(segment => segment.toLowerCase() === '.git' || segment.length > 255)
        || names.has(name.toLowerCase())
        || (total += ref.byteLength) > 4_194_304
      ) {
        refuse('ARTIFACT_INVALID', '', 'recovery');
      }
      names.add(name.toLowerCase());
      const bytes = await reader.read(artifact, 4_194_304), actual = digestArtifact(name, bytes);
      if (!actual.ok || !same(actual.value, ref)) refuse('ARTIFACT_INVALID', '', 'recovery');
      artifacts.push({ name, bytes: new Uint8Array(bytes) });
    }
    if (!same(parsePrivateJson(await reader.read(workspace, 65_536), 65_536), { version: 1, format: 'controller-passive-workspace', inventory, manifest: manifestRef })) {
      refuse('ARTIFACT_INVALID', '', 'recovery');
    }
    const source: FrozenSource = {
      version: 1,
      repository: task.spec.target.repository,
      directory,
      baseObject: text(value.baseObject),
      sourceObject: text(value.sourceObject),
      manifest: identified.value.manifest,
      inventory,
      workspace,
      artifacts,
    };
    await verifySource(source, task, owner);
    return source;
  }

  if (rawVersion === 2) {
    const value = record(raw, ['version', 'repository', 'directory', 'baseObject', 'sourceObject', 'baseTree', 'manifest', 'sourceTree', 'entryCount']);
    if (
      value.repository !== task.spec.target.repository
      || value.directory !== directory
      || !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(text(value.baseObject))
      || !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(text(value.sourceObject))
    ) {
      refuse('TARGET_MISMATCH', '', 'recovery');
    }
    await canonicalComponents(directory);
    const info = await lstat(directory);
    if (!info.isDirectory() || info.uid !== process.getuid?.() || await realpath(directory) !== directory) {
      refuse('TARGET_MISMATCH', '', 'recovery');
    }
    const manifestRef = checkedRef(value.manifest);
    const identified = identifyManifest(parsePrivateJson(await reader.read(manifestRef, 32_768), 32_768));
    if (
      !identified.ok
      || identified.value.manifest.metadata.id !== 'candidate'
      || identified.value.manifest.spec.baseTree === undefined
      || !same(identified.value.manifest.spec.baseTree, value.baseTree)
      || identified.value.manifest.spec.entries.length !== 0
      || identified.value.manifest.spec.deleted.length !== 0
    ) {
      refuse('ARTIFACT_INVALID', '', 'recovery');
    }
    const baseTree = identified.value.manifest.spec.baseTree;
    const sourceTreeRef = checkedRef(value.sourceTree);
    const sourceTreeBytes = await reader.read(sourceTreeRef, 8_388_608);
    const baselineEntries = parseSourceTree(sourceTreeBytes, baseTree.objectFormat, 'recovery');
    if (baselineEntries.length !== integer(value.entryCount, 0, LIMITS.baselineEntries)) {
      refuse('ARTIFACT_INVALID', '', 'recovery');
    }
    if (!same(parsePrivateJson(await reader.read(workspace, 65_536), 65_536), { version: 1, format: 'controller-passive-workspace', inventory, manifest: manifestRef })) {
      refuse('ARTIFACT_INVALID', '', 'recovery');
    }
    const source: FrozenSource = {
      version: 2,
      repository: task.spec.target.repository,
      directory,
      baseObject: text(value.baseObject),
      sourceObject: text(value.sourceObject),
      manifest: identified.value.manifest,
      inventory,
      workspace,
      artifacts: [],
      baselineEntries,
      sourceTree: sourceTreeRef,
    };
    await verifySource(source, task, owner);
    const baselineProofs = await resolveBaselineMerkleProofs(directory, owner, baseTree, baselineEntries, jsonPaths);
    return baselineProofs ? { ...source, baselineProofs } : source;
  }

  refuse('TARGET_MISMATCH', '', 'recovery');
}
