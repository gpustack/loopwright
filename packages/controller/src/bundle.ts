import { constants } from 'node:fs';
import { mkdir, open, lstat } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { digestArtifact, type ArtifactRef, type Digest } from '@loopwright/core';
import { canonicalComponents, inside } from './files.js';
import { refuse } from './errors.js';
import { canonical, freeze, text } from './schema.js';
export interface ExportEntry { readonly name: string; readonly presence: 'present' | 'absent' | 'not_run'; readonly ref: ArtifactRef | null; readonly reason: string | null }
export interface ExportManifest { readonly version: 1; readonly runId: string; readonly lockHash: Digest; readonly entries: readonly ExportEntry[] }
export class PublicBundle {
  readonly entries: ExportEntry[] = []; readonly files = new Map<string, Uint8Array>(); #bytes = 0;
  constructor(readonly runId: string, readonly lockHash: Digest) {}
  add(name: string, bytes: Uint8Array): void {
    const ref = digestArtifact(name, bytes); if (!ref.ok || bytes.byteLength > 8388608 || this.#bytes + bytes.byteLength > 16777216 || this.entries.length >= 253 || this.entries.some(row => row.name === name)) refuse('OUTPUT_LIMIT', '', 'inspection');
    this.#bytes += bytes.byteLength; this.files.set(name, new Uint8Array(bytes)); this.entries.push({ name, presence: 'present', ref: ref.value, reason: null });
  }
  json(name: string, value: unknown): void { this.add(name, Buffer.from(canonical(value))); }
  absent(name: string, reason = 'EVIDENCE_UNAVAILABLE', presence: 'absent' | 'not_run' = 'absent'): void {
    if (this.entries.length >= 256 || this.entries.some(row => row.name === name)) refuse('OUTPUT_LIMIT', '', 'inspection');
    this.entries.push({ name, presence, ref: null, reason });
  }
  manifest(): ExportManifest { return freeze({ version: 1, runId: this.runId, lockHash: this.lockHash, entries: [...this.entries] }); }
  async write(destination: string, privateRun: string): Promise<void> {
    const directory = resolve(text(destination));
    if (inside(directory, privateRun) || inside(privateRun, directory)) refuse('ARTIFACT_INVALID', '', 'inspection');
    await canonicalComponents(dirname(directory)); await mkdir(directory, { mode: 0o700 }); await canonicalComponents(directory);
    const original = await lstat(directory);
    for (const [name, bytes] of [...this.files, ['manifest.json', Buffer.from(canonical(this.manifest()))] as const]) {
      if (name.includes('/') || name.includes('\\')) refuse('ARTIFACT_INVALID', '', 'inspection');
      const current = await lstat(directory); if (current.ino !== original.ino || current.dev !== original.dev) refuse('ARTIFACT_INVALID', '', 'inspection');
      const file = await open(join(directory, name), constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
      try { await file.writeFile(bytes); await file.sync(); } finally { await file.close(); }
    }
    const parent = await open(directory, constants.O_RDONLY | constants.O_NOFOLLOW); try { await parent.sync(); } finally { await parent.close(); }
  }
}
