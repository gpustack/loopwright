import { constants } from 'node:fs';
import { open, mkdir, realpath, link, unlink } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
import { digestArtifact, type ArtifactRef } from '@loopwright/core';
import { canonical } from './boundary.js';
import { refuse } from './errors.js';
/** Immutable small metadata only; provider content and credentials never enter receipt files. */
export async function publishReceipt(directory: string, requestId: string, phase: 'context' | 'raw' | 'final', metadata: unknown): Promise<ArtifactRef> {
  if (!/^[a-z][a-z0-9-]{0,63}$/.test(requestId)) refuse('INPUT_INVALID');
  const bytes = Buffer.from(canonical(metadata)); if (bytes.length > 4096) refuse('OUTPUT_LIMIT', '', { phase: 'dispatch', effect: 'possible' });
  const parent = join(directory, 'pi-receipts'); await mkdir(parent, { recursive: true, mode: 0o700 });
  if (await realpath(parent) !== resolve(parent)) refuse('RECOVERY_REQUIRED', '', { phase: 'dispatch', effect: 'possible' });
  const name = requestId + '-' + phase + '.json', path = join(parent, name), temporary = path + '.tmp-' + randomBytes(8).toString('hex');
  const descriptor = await open(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
  try { await descriptor.writeFile(bytes); await descriptor.sync(); } finally { await descriptor.close(); }
  try {
    try { await link(temporary, path); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      const current = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        const info = await current.stat(); if (!info.isFile() || info.size !== bytes.length || info.size > 4096) refuse('RECOVERY_REQUIRED', '', { phase: 'dispatch', effect: 'possible' });
        const existing = Buffer.alloc(info.size); const read = await current.read(existing, 0, info.size, 0);
        if (read.bytesRead !== bytes.length || !existing.equals(bytes)) refuse('RECOVERY_REQUIRED', '', { phase: 'dispatch', effect: 'possible' });
      } finally { await current.close(); }
    }
  } finally { await unlink(temporary); }
  const parentDescriptor = await open(parent, constants.O_RDONLY); try { await parentDescriptor.sync(); } finally { await parentDescriptor.close(); }
  const artifact = digestArtifact('pi-receipts/' + name, bytes); if (!artifact.ok) refuse('RECOVERY_REQUIRED', '', { phase: 'dispatch', effect: 'possible' }); return artifact.value;
}
