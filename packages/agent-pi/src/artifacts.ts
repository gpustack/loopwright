import { constants } from 'node:fs';
import { open, lstat, mkdir, realpath, link, unlink } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import type { ArtifactRef } from '@loopwright/core';
import { refuse } from './errors.js';
/** New immutable internal artifacts publish through a synced temporary inode and no-overwrite link. */
export class ArtifactWriter {
  readonly #hash = createHash('sha256'); #bytes = 0; #file: Awaited<ReturnType<typeof open>> | null = null; #finished = false;
  readonly temporary: string;
  constructor(readonly root: string, readonly name: string, readonly maxBytes: number, readonly signal: AbortSignal) { this.temporary = join(root, 'pi-checkpoints', '.capture-' + randomBytes(16).toString('hex')); }
  async start(): Promise<void> {
    const info = await lstat(this.root); if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== process.getuid?.() || info.mode & 0o022 || await realpath(this.root) !== resolve(this.root)) refuse('INPUT_INVALID', '', { phase: 'restore' });
    if (!/^pi-checkpoints\/[a-z0-9._-]+\.(?:workspace|session)\.ndjson$/.test(this.name)) refuse('INPUT_INVALID', '', { phase: 'restore' });
    try { await mkdir(join(this.root, 'pi-checkpoints'), { mode: 0o700 }); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
    const parent = await lstat(join(this.root, 'pi-checkpoints')); if (!parent.isDirectory() || parent.isSymbolicLink() || parent.uid !== process.getuid?.() || parent.mode & 0o077) refuse('INPUT_INVALID', '', { phase: 'restore' });
    this.#file = await open(this.temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
  }
  async append(bytes: Uint8Array): Promise<void> {
    if (this.signal.aborted) refuse('CANCELLED', '', { phase: 'restore' });
    if (!this.#file || this.#finished || this.#bytes + bytes.byteLength > this.maxBytes) refuse('OUTPUT_LIMIT', '', { phase: 'restore' });
    await this.#file.writeFile(bytes); this.#hash.update(bytes); this.#bytes += bytes.byteLength;
  }
  async finish(): Promise<ArtifactRef> {
    if (!this.#file || this.#finished || this.signal.aborted) refuse(this.signal.aborted ? 'CANCELLED' : 'RECOVERY_REQUIRED', '', { phase: 'restore' });
    await this.#file.sync(); await this.#file.close(); this.#file = null;
    if (this.signal.aborted) refuse('CANCELLED', '', { phase: 'restore' });
    await link(this.temporary, join(this.root, this.name)); await unlink(this.temporary);
    const parent = await open(join(this.root, 'pi-checkpoints'), constants.O_RDONLY | constants.O_NOFOLLOW); try { await parent.sync(); } finally { await parent.close(); }
    this.#finished = true; return { name: this.name, byteLength: this.#bytes, digest: { algorithm: 'sha256', hex: this.#hash.digest('hex') } };
  }
  async close(): Promise<void> { if (this.#file) { await this.#file.close(); this.#file = null; } await unlink(this.temporary).catch(error => { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }); }
}
