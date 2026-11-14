import { realpath, lstat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { digestArtifact, identifyManifest, type ArtifactManifest, type ArtifactRef, type TaskContract } from '@loopwright/core';
import { canonicalComponents } from './files.js';
import { canonical, hash, same, record, list, text } from './schema.js';
import { refuse } from './errors.js';
import type { ControllerOwner } from './ownership.js';
import { checkedRef, type ArtifactStore, type ArtifactReader } from './storage.js';
import { parsePrivateJson } from './parser.js';
export interface FrozenSource {
  readonly version: 1; readonly repository: string; readonly directory: string; readonly baseObject: string; readonly sourceObject: string;
  readonly manifest: ArtifactManifest; readonly inventory: ArtifactRef; readonly workspace: ArtifactRef;
  readonly artifacts: readonly { readonly name: string; readonly bytes: Uint8Array }[];
}
const decoded = (value: Buffer): string => { try { return new TextDecoder('utf-8', { fatal: true }).decode(value); } catch { refuse('TARGET_MISMATCH', '', 'admission'); } };
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
async function object(owner: ControllerOwner, directory: string, revision: string): Promise<string> {
  const value = decoded(await owner.git(directory, ['rev-parse', '--verify', '--end-of-options', revision + '^{commit}'], 256)).trim();
  if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(value)) refuse('TARGET_MISMATCH', '', 'admission'); return value;
}
export async function freezeSource(repository: string, task: TaskContract, owner: ControllerOwner, store: ArtifactStore): Promise<FrozenSource> {
  const directory = resolve(repository); await canonicalComponents(directory);
  const info = await lstat(directory); if (!info.isDirectory() || info.uid !== process.getuid?.() || await realpath(directory) !== directory) refuse('TARGET_MISMATCH', '', 'admission');
  const top = decoded(await owner.git(directory, ['rev-parse', '--show-toplevel'], 4096)).trim();
  if (top !== directory) refuse('TARGET_MISMATCH', '', 'admission');
  const baseObject = await object(owner, directory, task.spec.target.baseRevision), sourceObject = await object(owner, directory, task.spec.target.sourceRevision);
  const tree = await owner.git(directory, ['ls-tree', '-rz', '--full-tree', sourceObject], 1048576), rows = tree.length ? decoded(tree).split('\0').slice(0, -1) : [];
  if (tree.length && tree.at(-1) !== 0) refuse('CONFIG_LIMIT', '', 'admission');
  const filteredRows = rows.filter(row => {
    const symlinkMatch = /^120000 blob ([0-9a-f]{40}|[0-9a-f]{64})\t(.+)$/.exec(row);
    if (!symlinkMatch) return true;
    const name = symlinkMatch[2]!;
    if (name.split('/').some(segment => segment.toLowerCase() === '.git' || segment.length > 255) || !digestArtifact(name, new Uint8Array()).ok) {
      return true;
    }
    return !isProtectedByScope(name, task.spec.scope.protected);
  });
  if (filteredRows.length > 256) refuse('CONFIG_LIMIT', '', 'admission');
  const descriptions = filteredRows.map(row => {
    const match = /^(100644|100755) blob ([0-9a-f]{40}|[0-9a-f]{64})\t(.+)$/.exec(row);
    if (!match || match[3]!.split('/').some(segment => segment.toLowerCase() === '.git' || segment.length > 255) || !digestArtifact(match[3], new Uint8Array()).ok) refuse('CAPABILITY_UNSUPPORTED', '', 'admission');
    return { name: match[3]!, mode: match[1]!, oid: match[2]! };
  }).sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
  const names = new Set(descriptions.map(item => item.name.toLowerCase())); if (names.size !== descriptions.length) refuse('ARTIFACT_INVALID', '', 'admission');
  const topology = identifyManifest({ apiVersion: 'loopwright.dev/v1alpha1', kind: 'ArtifactManifest', metadata: { id: 'source' }, spec: { entries: descriptions.map(item => ({ name: item.name, digest: hash(''), byteLength: 0 })) } });
  if (!topology.ok) refuse('ARTIFACT_INVALID', '', 'admission');
  // All topology is checked before any candidate body is materialized.
  const files = [], entries = []; let total = 0;
  for (const description of descriptions) {
    const encoded = decoded(await owner.git(directory, ['cat-file', '-s', description.oid], 64)).trim();
    if (!/^(?:0|[1-9][0-9]{0,9})$/.test(encoded)) refuse('TARGET_MISMATCH', '', 'admission');
    const size = Number(encoded); total += size; if (total > 4194304) refuse('CONFIG_LIMIT', '', 'admission');
    const bytes = await owner.git(directory, ['cat-file', 'blob', description.oid], size + 1); if (bytes.byteLength !== size) refuse('TARGET_MISMATCH', '', 'admission');
    const ref = digestArtifact(description.name, bytes); if (!ref.ok) refuse('ARTIFACT_INVALID', '', 'admission');
    const artifact = await store.put('source-file', bytes); files.push({ name: description.name, bytes: new Uint8Array(bytes) }); entries.push({ ...description, ref: ref.value, artifact });
  }
  const identified = identifyManifest({ apiVersion: 'loopwright.dev/v1alpha1', kind: 'ArtifactManifest', metadata: { id: 'candidate' }, spec: { entries: entries.map(item => item.ref) } });
  if (!identified.ok || Buffer.byteLength(canonical(identified.value.manifest)) > 32768) refuse('CONFIG_LIMIT', '', 'admission');
  const manifest = identified.value.manifest, manifestRef = await store.json('manifest', manifest, 32768);
  const inventory = await store.json('source', { version: 1, repository: task.spec.target.repository, directory, baseObject, sourceObject, manifest: manifestRef, entries }, 262144);
  const workspace = await store.json('workspace', { version: 1, format: 'controller-passive-workspace', inventory, manifest: manifestRef }, 65536);
  return { version: 1, repository: task.spec.target.repository, directory, baseObject, sourceObject, manifest, inventory, workspace, artifacts: files };
}
export async function verifySource(source: FrozenSource, task: TaskContract, owner: ControllerOwner): Promise<void> {
  if (!same([source.baseObject, source.sourceObject], [await object(owner, source.directory, task.spec.target.baseRevision), await object(owner, source.directory, task.spec.target.sourceRevision)])) refuse('TARGET_MISMATCH', '', 'execution');
}
/** Reopen the original frozen bytes, then re-resolve its exact declared refs. No replacement inventory is created. */
export async function restoreSource(repository: string, task: TaskContract, owner: ControllerOwner, reader: ArtifactReader, inventory: ArtifactRef, workspace: ArtifactRef): Promise<FrozenSource> {
  const value = record(parsePrivateJson(await reader.read(inventory, 262144), 262144), ['version', 'repository', 'directory', 'baseObject', 'sourceObject', 'manifest', 'entries']);
  const directory = resolve(repository);
  if (value.version !== 1 || value.repository !== task.spec.target.repository || value.directory !== directory
    || !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(text(value.baseObject)) || !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(text(value.sourceObject))) refuse('TARGET_MISMATCH', '', 'recovery');
  await canonicalComponents(directory); const info = await lstat(directory);
  if (!info.isDirectory() || info.uid !== process.getuid?.() || await realpath(directory) !== directory) refuse('TARGET_MISMATCH', '', 'recovery');
  const manifestRef = checkedRef(value.manifest), identified = identifyManifest(parsePrivateJson(await reader.read(manifestRef, 32768), 32768));
  if (!identified.ok || identified.value.manifest.metadata.id !== 'candidate') refuse('ARTIFACT_INVALID', '', 'recovery');
  const entries = list(value.entries, '', 256).map(item => record(item, ['name', 'mode', 'oid', 'ref', 'artifact'])), artifacts = []; let total = 0;
  if (!same(entries.map(entry => entry.ref), identified.value.manifest.spec.entries) || !same([...entries].sort((a, b) => text(a.name) < text(b.name) ? -1 : text(a.name) > text(b.name) ? 1 : 0), entries)) refuse('ARTIFACT_INVALID', '', 'recovery');
  const names = new Set<string>();
  for (const entry of entries) {
    const name = text(entry.name, '', 4096), ref = checkedRef(entry.ref), artifact = checkedRef(entry.artifact);
    if (name !== ref.name || !['100644', '100755'].includes(text(entry.mode)) || !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(text(entry.oid))
      || name.split('/').some(segment => segment.toLowerCase() === '.git' || segment.length > 255) || names.has(name.toLowerCase()) || (total += ref.byteLength) > 4194304) refuse('ARTIFACT_INVALID', '', 'recovery');
    names.add(name.toLowerCase()); const bytes = await reader.read(artifact, 4194304), actual = digestArtifact(name, bytes);
    if (!actual.ok || !same(actual.value, ref)) refuse('ARTIFACT_INVALID', '', 'recovery'); artifacts.push({ name, bytes: new Uint8Array(bytes) });
  }
  if (!same(parsePrivateJson(await reader.read(workspace, 65536), 65536), { version: 1, format: 'controller-passive-workspace', inventory, manifest: manifestRef })) refuse('ARTIFACT_INVALID', '', 'recovery');
  const source: FrozenSource = { version: 1, repository: task.spec.target.repository, directory, baseObject: text(value.baseObject), sourceObject: text(value.sourceObject), manifest: identified.value.manifest, inventory, workspace, artifacts };
  await verifySource(source, task, owner); return source;
}
