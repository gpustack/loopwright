import { constants } from 'node:fs';
import { open, rename, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { canonical, digest, integer, object } from './boundary.js';
import { parseBoundedJson } from './context.js';
import { sameIdentity } from './policy.js';
import { stateValue } from './admission.js';
import { PiFailure, refuse } from './errors.js';
import type { PiHost, PiOpenInput } from './types.js';
/** Retain only the last issued event number; this grants no effect or accounting authority. */
export async function eventSequence(host: PiHost, input: PiOpenInput, minimum: number): Promise<{ sequence: number; persist: (next: number) => Promise<void> }> {
  const identity = { version: 1, storeId: stateValue(host.store.inspect()).storeId, runId: input.lock.spec.runId, lockHash: input.lock.spec.lockHash, sessionId: input.sessionId, roleId: input.roleId, stepId: input.stepId };
  const path = join(host.artifactsDirectory, 'pi-events-' + digest(Buffer.from(canonical(identity))).hex + '.json'); let sequence = 0;
  try {
    const fd = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try { const stat = await fd.stat(); if (!stat.isFile() || stat.nlink !== 1 || stat.mode & 0o077 || stat.uid !== process.getuid?.() || stat.size > 2048) refuse('RECOVERY_REQUIRED'); const saved = object(parseBoundedJson(await fd.readFile('utf8')), ['identity', 'sequence']); if (!sameIdentity(saved.identity, identity)) refuse('BINDING_MISMATCH'); sequence = integer(saved.sequence, minimum, Number.MAX_SAFE_INTEGER); }
    finally { await fd.close(); }
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || minimum !== 0) { if (error instanceof PiFailure) throw error; refuse('RECOVERY_REQUIRED', '', { phase: 'restore' }); } }
  return { sequence, persist: async next => {
    if (!Number.isSafeInteger(next) || next !== sequence + 1) refuse('RECOVERY_REQUIRED');
    const temporary = path + '.' + randomBytes(16).toString('hex'), fd = await open(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
    try {
      try { await fd.writeFile(JSON.stringify({ identity, sequence: next })); await fd.sync(); } finally { await fd.close(); }
      await rename(temporary, path); const parent = await open(host.artifactsDirectory, constants.O_RDONLY | constants.O_NOFOLLOW); try { await parent.sync(); } finally { await parent.close(); } sequence = next;
    } finally { await unlink(temporary).catch(error => { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }); }
  } };
}
