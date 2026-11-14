import { constants } from 'node:fs';
import { mkdir, open, lstat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { digestArtifact, type ArtifactRef } from '@loopwright/core';
import type { StateResult } from '@loopwright/state';
import { ControllerFailure, refuse } from './errors.js';
import { canonicalComponents, readBoundedFile, inside } from './files.js';
import { canonical, checkedRef, hash, same } from './schema.js';
export { checkedRef };
import type { ControllerOwner } from './ownership.js';
import type { CredentialVault } from './credentials.js';
export function stateValue<T>(result: StateResult<T>): T {
  if (result.ok) return result.value;
  const code = result.error.commit === 'unknown' || /CLOCK/.test(result.error.code) ? 'RECOVERY_REQUIRED' : /OWNER|AUTHORITY/.test(result.error.code) ? 'AUTHORITY_REFUSED'
    : /DEADLINE/.test(result.error.code) ? 'DEADLINE' : /BUDGET|LIMIT/.test(result.error.code) ? 'BUDGET_EXHAUSTED' : 'STATE_UNAVAILABLE';
  refuse(code, '', 'recovery', { stateCode: result.error.code, effect: result.error.commit === 'unknown' ? 'possible' : 'none', retryable: result.error.retryable });
}
export async function privateDirectory(path: string, excluded: readonly string[] = []): Promise<void> {
  if (resolve(path) !== path || excluded.some(root => inside(path, resolve(root)))) refuse('ARTIFACT_INVALID', '', 'admission');
  await mkdir(path, { recursive: true, mode: 0o700 }); await canonicalComponents(path);
  const info = await lstat(path); if (!info.isDirectory() || info.uid !== process.getuid?.() || info.mode & 0o077) refuse('ARTIFACT_INVALID', '', 'admission');
}
export interface ArtifactReader { read(ref: ArtifactRef, maximum?: number): Promise<Uint8Array> }
export async function readArtifact(directory: string, unowned: ArtifactRef, maximum = 8388608): Promise<Uint8Array> {
  const ref = checkedRef(unowned); if (ref.name.length > 128 || ref.byteLength > maximum || maximum > 67108864) refuse('ARTIFACT_INVALID', '', 'recovery');
  try {
    const bytes = await readBoundedFile(join(directory, ref.name), maximum, true), actual = digestArtifact(ref.name, bytes);
    if (!actual.ok || !same(actual.value, ref)) refuse('ARTIFACT_INVALID', '', 'recovery'); return new Uint8Array(bytes);
  } catch (error) { if (error instanceof ControllerFailure && error.diagnostic.code === 'ARTIFACT_INVALID') throw error; refuse('ARTIFACT_INVALID', '', 'recovery'); }
}
export class ArtifactStore {
  constructor(readonly directory: string, readonly owner: ControllerOwner, readonly vault: CredentialVault) {}
  async put(kind: string, bytes: Uint8Array, maximum = 8388608): Promise<ArtifactRef> {
    await this.owner.assertCurrent();
    if (!/^[a-z][a-z0-9-]{0,23}$/.test(kind) || bytes.byteLength > maximum || maximum > 67108864) refuse('OUTPUT_LIMIT', '', 'execution');
    this.vault.assertClean(bytes);
    const name = kind + '-' + hash('loopwright.dev/controller/artifact/' + kind + '/v1\0' + hash(bytes).hex).hex + '.bin';
    const ref = digestArtifact(name, bytes); if (!ref.ok) refuse('ARTIFACT_INVALID', '', 'execution');
    let file: Awaited<ReturnType<typeof open>>;
    try { file = await open(join(this.directory, name), constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      const known = await this.read(ref.value, maximum); if (!Buffer.from(known).equals(Buffer.from(bytes))) refuse('ARTIFACT_INVALID', '', 'recovery'); return ref.value;
    }
    try { await file.writeFile(bytes); await file.sync(); } finally { await file.close(); }
    const parent = await open(this.directory, constants.O_RDONLY | constants.O_NOFOLLOW); try { await parent.sync(); } finally { await parent.close(); }
    return ref.value;
  }
  json(kind: string, value: unknown, maximum = 65536): Promise<ArtifactRef> { return this.put(kind, Buffer.from(canonical(value)), maximum); }
  async read(unowned: ArtifactRef, maximum = 8388608): Promise<Uint8Array> {
    return readArtifact(this.directory, unowned, maximum);
  }
}
