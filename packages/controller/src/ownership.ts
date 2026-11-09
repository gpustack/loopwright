import { constants } from 'node:fs';
import { open, lstat, unlink } from 'node:fs/promises';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import type { Digest } from '@loopwright/core';
import type { Readable } from 'node:stream';
import { canonicalComponents, readBoundedFile } from './files.js';
import { parseDocumentBytes } from './parser.js';
import { ControllerFailure, refuse } from './errors.js';
import { canonical, digestValue, hash, id, integer, record, same, text } from './schema.js';
import { GIT_ENVIRONMENT } from './git-reader.js';
const execute = promisify(execFile);
const processEnvironment = { PATH: '/usr/bin:/bin:/usr/sbin', LANG: 'C', LC_ALL: 'C' };
export async function processBirth(pid: number): Promise<string | null> {
  try {
    const result = await execute('/bin/ps', ['-p', String(pid), '-o', 'lstart='], { timeout: 2000, maxBuffer: 1024, env: processEnvironment });
    const birth = result.stdout.trim(); if (!birth || birth.length > 128 || result.stderr) refuse('RECOVERY_REQUIRED', '', 'recovery'); return birth;
  } catch (error) {
    const value = error as { code?: unknown; stdout?: unknown; stderr?: unknown };
    if (value.code === 1 && value.stdout === '' && value.stderr === '') return null;
    if (error instanceof ControllerFailure) throw error; refuse('RECOVERY_REQUIRED', '', 'recovery');
  }
}
export async function bootIdentity(): Promise<string> {
  if (process.platform !== 'darwin' || process.arch !== 'arm64') refuse('CAPABILITY_UNSUPPORTED', '', 'admission');
  const result = await execute('/usr/sbin/sysctl', ['-n', 'kern.boottime'], { timeout: 2000, maxBuffer: 1024, env: processEnvironment });
  if (!/^\{ sec = \d+, usec = \d+ \} [^\r\n]+\n$/.test(result.stdout) || result.stderr) refuse('RECOVERY_REQUIRED', '', 'recovery'); return result.stdout.trim();
}
async function syncDirectory(path: string): Promise<void> { const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW); try { await file.sync(); } finally { await file.close(); } }
/** Private observation port; never accepted by configuration or exported at the package root. */
export interface OwnershipPorts { readonly afterGitExec?: (identity: { readonly pid: number; readonly birth: string; readonly nonce: string }) => Promise<void> }
export class ControllerOwner {
  readonly nonce = randomBytes(16).toString('hex'); readonly path: string;
  #fd: Awaited<ReturnType<typeof open>> | null = null; #released = false; #active = false; #rows = 0; #heldActivities = 0;
  readonly #pending = new Set<string>();
  private constructor(readonly directory: string, readonly runId: string, readonly planDigest: Digest, readonly ports: OwnershipPorts) { this.path = join(directory, 'controller.owner.ndjson'); }
  static async acquire(directory: string, runId: string, planDigest: Digest, ports: OwnershipPorts = {}): Promise<ControllerOwner> {
    id(runId); digestValue(planDigest); await canonicalComponents(directory);
    const info = await lstat(directory); if (!info.isDirectory() || info.uid !== process.getuid?.() || info.mode & 0o077) refuse('ARTIFACT_INVALID', '', 'admission');
    const owner = new ControllerOwner(directory, runId, planDigest, ports), birth = await processBirth(process.pid), boot = await bootIdentity();
    if (!birth) refuse('RECOVERY_REQUIRED', '', 'recovery');
    try { owner.#fd = await open(owner.path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      let recovery: Awaited<ReturnType<typeof open>>;
      try { recovery = await open(owner.path + '.recovery', constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600); }
      catch { refuse('OWNER_BUSY', '', 'recovery'); }
      let completed = false, knownBusy = false;
      try {
        await recovery.writeFile(canonical({ version: 1, pid: process.pid, birth, boot, nonce: owner.nonce, runId, planDigest }) + '\n'); await recovery.sync(); await syncDirectory(directory);
        const priorFile = await lstat(owner.path), bytes = await readBoundedFile(owner.path, 1048576, true);
        if (!bytes.length || bytes.at(-1) !== 10) refuse('RECOVERY_REQUIRED', '', 'recovery');
        const lines = bytes.toString().slice(0, -1).split('\n'); if (lines.length > 4096) refuse('RECOVERY_REQUIRED', '', 'recovery');
        const prior = record(parseDocumentBytes(Buffer.from(lines[0]!), 'json'), ['type', 'version', 'pid', 'birth', 'boot', 'nonce', 'runId', 'planDigest']);
        if (prior.type !== 'owner' || prior.version !== 1 || prior.boot !== boot || prior.runId !== runId || !same(prior.planDigest, planDigest)
          || !/^[a-f0-9]{32}$/.test(text(prior.nonce))) refuse('RECOVERY_REQUIRED', '', 'recovery');
        const priorPid = integer(prior.pid, 1, Number.MAX_SAFE_INTEGER), priorBirth = text(prior.birth, '', 128), observed = await processBirth(priorPid);
        if (observed !== null) { knownBusy = observed === priorBirth; refuse(knownBusy ? 'OWNER_BUSY' : 'RECOVERY_REQUIRED', '', 'recovery'); }
        try { process.kill(priorPid, 0); refuse('RECOVERY_REQUIRED', '', 'recovery'); } catch (failure) { if ((failure as NodeJS.ErrnoException).code !== 'ESRCH') throw failure; }
        const pending = new Set<string>();
        for (const line of lines.slice(1)) {
          const row = parseDocumentBytes(Buffer.from(line), 'json') as Record<string, unknown>;
          if (row.type === 'intent') { record(row, ['type', 'nonce', 'digest']); const nonce = text(row.nonce); if (!/^[a-f0-9]{32}$/.test(nonce) || pending.has(nonce)) refuse('RECOVERY_REQUIRED', '', 'recovery'); digestValue(row.digest); pending.add(nonce); }
          else if (row.type === 'started') { record(row, ['type', 'nonce', 'pid', 'birth']); if (!pending.has(text(row.nonce))) refuse('RECOVERY_REQUIRED', '', 'recovery'); integer(row.pid, 1, Number.MAX_SAFE_INTEGER); text(row.birth); }
          else if (row.type === 'exit') { record(row, ['type', 'nonce', 'code', 'signal', 'stdoutDigest']); if (!pending.delete(text(row.nonce))) refuse('RECOVERY_REQUIRED', '', 'recovery'); digestValue(row.stdoutDigest); }
          else refuse('RECOVERY_REQUIRED', '', 'recovery');
        }
        // An unfinished local reader has no authenticated result. Keep its owner/recovery records; do not replay it.
        if (pending.size) refuse('RECOVERY_REQUIRED', '', 'recovery');
        const audit = await open(join(directory, 'controller.recovered.' + prior.nonce + '.json'), 'wx', 0o600);
        try { await audit.writeFile(canonical({ version: 1, prior: { pid: priorPid, birth: priorBirth, nonce: prior.nonce }, boot, deathConfirmed: true, activeReaders: 0 })); await audit.sync(); } finally { await audit.close(); }
        const currentFile = await lstat(owner.path);
        if (priorFile.ino !== currentFile.ino || priorFile.dev !== currentFile.dev || !same(hash(bytes), hash(await readBoundedFile(owner.path, 1048576, true)))) refuse('RECOVERY_REQUIRED', '', 'recovery');
        await unlink(owner.path); await syncDirectory(directory);
        owner.#fd = await open(owner.path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600); completed = true;
      } finally { await recovery.close(); if (completed || knownBusy) { await unlink(owner.path + '.recovery'); await syncDirectory(directory); } }
    }
    await owner.#append({ type: 'owner', version: 1, pid: process.pid, birth, boot, nonce: owner.nonce, runId, planDigest }); await syncDirectory(directory); return owner;
  }
  async assertCurrent(): Promise<void> {
    if (!this.#fd || this.#released) refuse('AUTHORITY_REFUSED', '', 'execution');
    await canonicalComponents(this.directory);
    const held = await this.#fd.stat(), current = await lstat(this.path);
    if (held.ino !== current.ino || held.dev !== current.dev || current.nlink !== 1 || current.uid !== process.getuid?.() || current.mode & 0o077) refuse('AUTHORITY_REFUSED', '', 'execution');
  }
  async #append(value: unknown): Promise<void> {
    if (!this.#fd || this.#released || ++this.#rows > 4096) refuse('RECOVERY_REQUIRED', '', 'recovery');
    const bytes = Buffer.from(canonical(value) + '\n'); if ((await this.#fd.stat()).size + bytes.byteLength > 1048576) refuse('OUTPUT_LIMIT', '', 'execution');
    await this.#fd.writeFile(bytes); await this.#fd.sync();
  }
  /** A local Worker is part of this guarded process; release only after its exact exit is confirmed. */
  async holdLocalActivity(): Promise<() => void> {
    await this.assertCurrent(); this.#heldActivities++; let released = false;
    return () => { if (!released) { released = true; this.#heldActivities--; } };
  }
  async git(repository: string, args: readonly string[], maximum: number, signal: AbortSignal = new AbortController().signal): Promise<Buffer> {
    if (this.#active) refuse('OWNER_BUSY', '', 'execution'); this.#active = true;
    try { return await this.#git(repository, args, maximum, signal); } finally { this.#active = false; }
  }
  async #git(repository: string, args: readonly string[], maximum: number, signal: AbortSignal): Promise<Buffer> {
    await this.assertCurrent(); signal.throwIfAborted(); integer(maximum, 1, 8388609);
    const nonce = randomBytes(16).toString('hex'); await this.#append({ type: 'intent', nonce, digest: hash(canonical({ repository, args, maximum })) });
    this.#pending.add(nonce);
    const child = spawn(process.execPath, [fileURLToPath(new URL('./git-reader.js', import.meta.url)), nonce, JSON.stringify({ repository, args })], { env: GIT_ENVIRONMENT, cwd: this.directory, stdio: ['pipe', 'pipe', 'pipe', 'pipe'], detached: true });
    const stdout: Buffer[] = []; let bytes = 0, stderr = 0, failed = false;
    const stop = () => { failed = true; if (child.pid && child.exitCode === null && child.signalCode === null) { try { process.kill(-child.pid, 'SIGKILL'); } catch { /* Exact exit is awaited below. */ } } };
    const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(resolve => { child.once('close', (code, signal) => resolve({ code, signal })); child.once('error', () => resolve({ code: null, signal: null })); });
    const timer = setTimeout(stop, 10000); signal.addEventListener('abort', stop, { once: true });
    child.stdout!.on('data', (part: Buffer) => { bytes += part.length; if (bytes > maximum) stop(); else stdout.push(part); });
    child.stderr!.on('data', (part: Buffer) => { stderr += part.length; if (stderr > 8192) stop(); });
    try {
      const ready = await new Promise<Record<string, unknown>>((resolve, reject) => {
        let buffer = '';
        const pipe = child.stdio[3] as Readable;
        pipe.on('data', part => { buffer += part.toString(); if (buffer.length > 1024) { stop(); reject(new Error('reader')); } else if (buffer.endsWith('\n')) { try { resolve(record(parseDocumentBytes(Buffer.from(buffer), 'json'), ['version', 'nonce', 'pid'])); } catch (error) { reject(error); } } });
        void exited.then(() => reject(new Error('reader-exited')));
      });
      if (!child.pid || ready.version !== 1 || ready.nonce !== nonce || ready.pid !== child.pid) refuse('RECOVERY_REQUIRED', '', 'admission');
      const birth = await processBirth(child.pid); if (!birth) refuse('RECOVERY_REQUIRED', '', 'admission');
      await this.#append({ type: 'started', nonce, pid: child.pid, birth }); await this.assertCurrent(); signal.throwIfAborted();
      if (this.ports.afterGitExec) {
        const replaced = new Promise<void>((resolve, reject) => { (child.stdio[3] as Readable).once('end', resolve); void exited.then(() => reject(new Error('reader-exited'))); });
        child.stdin!.write(nonce + '\n'); await replaced; await this.ports.afterGitExec({ pid: child.pid, birth, nonce }); child.stdin!.end();
      } else child.stdin!.end(nonce + '\n');
      const exit = await exited; clearTimeout(timer);
      const output = Buffer.concat(stdout, bytes <= maximum ? bytes : 0);
      await this.#append({ type: 'exit', nonce, code: exit.code, signal: exit.signal, stdoutDigest: hash(output) });
      this.#pending.delete(nonce);
      if (failed || exit.code !== 0 || exit.signal !== null) refuse(signal.aborted ? 'CANCELLED' : bytes > maximum ? 'OUTPUT_LIMIT' : 'TARGET_MISMATCH', '', 'admission');
      return output;
    } catch (error) {
      stop(); const exit = await exited;
      if (this.#pending.has(nonce)) { await this.#append({ type: 'exit', nonce, code: exit.code, signal: exit.signal, stdoutDigest: hash(Buffer.concat(stdout)) }); this.#pending.delete(nonce); }
      if (error instanceof ControllerFailure) throw error; refuse('TARGET_MISMATCH', '', 'admission');
    }
    finally { clearTimeout(timer!); signal.removeEventListener('abort', stop); }
  }
  async release(): Promise<void> {
    if (this.#released) return; if (this.#active || this.#pending.size || this.#heldActivities) refuse('CLEANUP_FAILED', '', 'finalization'); await this.assertCurrent();
    const bytes = await readBoundedFile(this.path, 1048576, true), archive = await open(join(this.directory, 'controller.closed.' + this.nonce + '.ndjson'), constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
    try { await archive.writeFile(bytes); await archive.sync(); } finally { await archive.close(); }
    await syncDirectory(this.directory); await this.assertCurrent();
    await this.#fd!.close(); this.#fd = null; await unlink(this.path); await syncDirectory(this.directory); this.#released = true;
  }
}
