import { constants } from 'node:fs';
import { lstat, open, mkdir, realpath, readdir, rename, unlink } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
import { digestArtifact, isWritablePath, type ArtifactRef, type ArtifactManifest } from '@loopwright/core';
import { canonical, freeze, object, list } from './boundary.js';
import { refuse } from './errors.js';
import type { PiOpenInput } from './types.js';
export interface CandidateChange { readonly path: string; readonly before: ArtifactRef | null; readonly after: ArtifactRef }
const absent = (error: unknown): boolean => (error as NodeJS.ErrnoException).code === 'ENOENT';
function artifact(path: string, bytes: Uint8Array): ArtifactRef { const value = digestArtifact(path, bytes); if (!value.ok) refuse('TOOL_DENIED', '/path', { phase: 'tool' }); return value.value; }
/** One trusted mutation owner; containers have only a read-only mount of this directory. */
export class Candidate {
  readonly #files: Map<string, ArtifactRef>;
  readonly #changes = new WeakMap<CandidateChange, Buffer>(); readonly #used = new WeakSet<CandidateChange>();
  #total: number;
  constructor(readonly root: string, readonly input: PiOpenInput) {
    this.#files = new Map(input.candidate.manifest.spec.entries.map(entry => [entry.name, freeze(structuredClone(entry))]));
    this.#total = [...this.#files.values()].reduce((total, value) => total + value.byteLength, 0);
  }
  normalize(raw: string): string {
    if (typeof raw !== 'string') refuse('TOOL_DENIED', '/path', { phase: 'tool' });
    const name = raw.startsWith('/workspace/candidate/') ? raw.slice('/workspace/candidate/'.length) : raw;
    artifact(name, new Uint8Array()); return name;
  }
  #writable(name: string): void {
    const contract = this.input.lock.spec.contract, allowed = isWritablePath(contract, name);
    // Retain core glob semantics and add conservative protection for aliases on case-insensitive hosts.
    const protectedOnly = { ...contract, spec: { ...contract.spec, scope: { writable: ['**'], protected: contract.spec.scope.protected.map(pattern => pattern.toLowerCase()) } } };
    const folded = isWritablePath(protectedOnly, name.toLowerCase());
    if (!allowed.ok || !allowed.value || !folded.ok || !folded.value) refuse('TOOL_DENIED', '/path', { phase: 'tool' });
  }
  #directoryProtected(name: string): void {
    const contract = this.input.lock.spec.contract;
    const projected = { ...contract, spec: { ...contract.spec, scope: { writable: ['**'], protected: contract.spec.scope.protected.map(pattern => pattern.toLowerCase()) } } };
    const allowed = isWritablePath(projected, name.toLowerCase()); if (!allowed.ok || !allowed.value) refuse('TOOL_DENIED', '/path', { phase: 'tool' });
  }
  async #directory(path: string): Promise<void> {
    const value = await lstat(path);
    if (!value.isDirectory() || value.isSymbolicLink() || value.uid !== process.getuid?.() || value.mode & 0o022 || await realpath(path) !== resolve(path)) refuse('TOOL_DENIED', '/path', { phase: 'tool' });
  }
  async #entry(parent: string, segment: string): Promise<boolean> {
    const entries = await readdir(parent); if (entries.length > this.input.policy.limits.candidateEntries + 1) refuse('OUTPUT_LIMIT', '/candidate', { phase: 'tool' });
    const found = entries.find(value => value.toLowerCase() === segment.toLowerCase()); if (found && found !== segment) refuse('TOOL_DENIED', '/path', { phase: 'tool' });
    if (found) return true;
    try { await lstat(join(parent, segment)); } catch (error) { if (absent(error)) return false; throw error; }
    refuse('TOOL_DENIED', '/path', { phase: 'tool' });
  }
  async #parent(name: string, create: boolean, guard: () => void = () => {}): Promise<string | null> {
    await this.#directory(this.root); let parent = this.root, prefix = '';
    for (const segment of name.split('/').slice(0, -1)) {
      prefix = prefix ? prefix + '/' + segment : segment; const path = join(parent, segment);
      if (!await this.#entry(parent, segment)) {
        if (!create) return null;
        this.#directoryProtected(prefix); guard(); await mkdir(path, { mode: 0o755 });
      }
      await this.#directory(path); parent = path;
    }
    return parent;
  }
  async #current(name: string): Promise<Buffer | null> {
    const parent = await this.#parent(name, false), known = this.#files.get(name);
    if (parent === null || !await this.#entry(parent, name.split('/').at(-1)!)) { if (known) refuse('RECOVERY_REQUIRED', '/candidate', { phase: 'tool' }); return null; }
    const path = join(this.root, name), info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.uid !== process.getuid?.() || info.size > this.input.policy.limits.fileBytes) refuse('TOOL_DENIED', '/path', { phase: 'tool' });
    if (!known) refuse('RECOVERY_REQUIRED', '/candidate', { phase: 'tool' });
    const descriptor = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const current = await descriptor.stat(); if (!current.isFile() || current.nlink !== 1 || current.dev !== info.dev || current.ino !== info.ino || current.size > this.input.policy.limits.fileBytes) refuse('TOOL_DENIED', '/path', { phase: 'tool' });
      const bytes = await descriptor.readFile(); if (canonical(artifact(name, bytes)) !== canonical(known)) refuse('RECOVERY_REQUIRED', '/candidate', { phase: 'tool' }); return bytes;
    } finally { await descriptor.close(); }
  }
  async checkRead(raw: string): Promise<{ readonly path: string; readonly ref: ArtifactRef }> {
    const path = this.normalize(raw), bytes = await this.#current(path); if (!bytes) refuse('TOOL_DENIED', '/path', { phase: 'tool' }); return freeze({ path, ref: artifact(path, bytes) });
  }
  #prepare(path: string, before: Buffer | null, bytes: Buffer): CandidateChange {
    const after = artifact(path, bytes), old = before === null ? null : artifact(path, before), limits = this.input.policy.limits;
    const capacity = limits.artifactBytes - limits.sessionBytes - this.input.resources.reduce((total, item) => total + item.bytes.length, 0);
    if (bytes.length > limits.fileBytes || this.#total - (old?.byteLength ?? 0) + bytes.length > capacity || !old && this.#files.size >= limits.candidateEntries) refuse('OUTPUT_LIMIT', '/candidate', { phase: 'tool' });
    const change = freeze({ path, before: old, after }); this.#changes.set(change, bytes); return change;
  }
  async prepareWrite(raw: string, content: string): Promise<CandidateChange> {
    const path = this.normalize(raw); this.#writable(path);
    if (typeof content !== 'string' || new TextDecoder('utf-8', { fatal: true }).decode(Buffer.from(content)) !== content) refuse('TOOL_DENIED', '/content', { phase: 'tool' });
    return this.#prepare(path, await this.#current(path), Buffer.from(content));
  }
  async prepareEdit(raw: string, input: unknown): Promise<CandidateChange> {
    const path = this.normalize(raw); this.#writable(path); const before = await this.#current(path); if (!before) refuse('TOOL_DENIED', '/path', { phase: 'tool' });
    let text: string; try { text = new TextDecoder('utf-8', { fatal: true }).decode(before); } catch { refuse('TOOL_DENIED', '/edits', { phase: 'tool' }); }
    const ranges = list(input, 32, '/edits').map(value => {
      const entry = object(value, ['oldText', 'newText'], '/edits');
      if (typeof entry.oldText !== 'string' || !entry.oldText || typeof entry.newText !== 'string' || Buffer.from(entry.newText).toString('utf8') !== entry.newText) refuse('TOOL_DENIED', '/edits', { phase: 'tool' });
      const index = text.indexOf(entry.oldText); if (index < 0 || text.indexOf(entry.oldText, index + 1) >= 0) refuse('TOOL_DENIED', '/edits', { phase: 'tool' });
      return { start: index, end: index + entry.oldText.length, replacement: entry.newText };
    }).sort((a, b) => a.start - b.start);
    if (!ranges.length || ranges.some((range, index) => index > 0 && ranges[index - 1]!.end > range.start)) refuse('TOOL_DENIED', '/edits', { phase: 'tool' });
    let offset = 0, result = ''; for (const range of ranges) { result += text.slice(offset, range.start) + range.replacement; offset = range.end; } result += text.slice(offset);
    return this.#prepare(path, before, Buffer.from(result));
  }
  async commit(change: CandidateChange, guard: () => void): Promise<ArtifactRef> {
    const bytes = this.#changes.get(change); if (!bytes || this.#used.has(change)) refuse('TOOL_DENIED', '/operation', { phase: 'tool' }); this.#used.add(change);
    this.#writable(change.path); const parent = await this.#parent(change.path, true, guard); if (!parent) refuse('TOOL_DENIED', '/path', { phase: 'tool' });
    const current = await this.#current(change.path), before = current === null ? null : artifact(change.path, current);
    if (canonical(before) !== canonical(change.before)) refuse('RECOVERY_REQUIRED', '/candidate', { phase: 'tool' });
    const temporary = join(parent, '.lw-write-' + randomBytes(16).toString('hex')); guard();
    const descriptor = await open(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o444);
    try {
      try { await descriptor.writeFile(bytes); await descriptor.sync(); } finally { await descriptor.close(); }
      await this.#parent(change.path, false); const latest = await this.#current(change.path);
      if (canonical(latest === null ? null : artifact(change.path, latest)) !== canonical(change.before)) refuse('RECOVERY_REQUIRED', '/candidate', { phase: 'tool' });
      guard(); await rename(temporary, join(this.root, change.path));
      const directory = await open(parent, constants.O_RDONLY | constants.O_NOFOLLOW); try { await directory.sync(); } finally { await directory.close(); }
      this.#total += bytes.length - (change.before?.byteLength ?? 0); this.#files.set(change.path, change.after); return change.after;
    } finally { await unlink(temporary).catch(error => { if (!absent(error)) throw error; }); }
  }
  async manifest(): Promise<ArtifactManifest> {
    const seen: string[] = [];
    const visit = async (parent: string, prefix: string): Promise<void> => {
      await this.#directory(parent);
      const entries = await readdir(parent); if (entries.length > this.input.policy.limits.candidateEntries) refuse('OUTPUT_LIMIT', '/candidate');
      for (const entry of entries) {
        const name = prefix ? prefix + '/' + entry : entry, info = await lstat(join(parent, entry)); this.normalize(name);
        if (info.isSymbolicLink()) refuse('RECOVERY_REQUIRED', '/candidate');
        if (info.isDirectory()) await visit(join(parent, entry), name);
        else { if (!this.#files.has(name)) refuse('RECOVERY_REQUIRED', '/candidate'); await this.#current(name); seen.push(name); }
      }
    };
    await visit(this.root, ''); if (seen.length !== this.#files.size) refuse('RECOVERY_REQUIRED', '/candidate');
    return freeze({ apiVersion: 'loopwright.dev/v1alpha1', kind: 'ArtifactManifest', metadata: { id: 'candidate' }, spec: { entries: [...this.#files.values()].sort((a, b) => a.name.localeCompare(b.name, 'en')) } });
  }
}
