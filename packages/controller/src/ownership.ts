import { constants } from 'node:fs';
import { mkdir, open, lstat, rm, unlink } from 'node:fs/promises';
import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { promisify } from 'node:util';
import { join } from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import type { Digest } from '@loopwright/core';
import type { Readable, Writable } from 'node:stream';
import { canonicalComponents, readBoundedFile } from './files.js';
import { parseDocumentBytes } from './parser.js';
import { ControllerFailure, refuse, type ControllerDiagnostic } from './errors.js';
import { canonical, digestValue, hash, id, integer, record, same, text } from './schema.js';
import { GIT_ENVIRONMENT } from './git-reader.js';
const execute = promisify(execFile);
const processEnvironment = { PATH: '/usr/bin:/bin:/usr/sbin', LANG: 'C', LC_ALL: 'C' };
async function writeAll(stream: Writable, data: Uint8Array): Promise<void> {
  const chunkSize = 65_536;
  for (let offset = 0; offset < data.byteLength; offset += chunkSize) {
    const slice = data.subarray(offset, Math.min(offset + chunkSize, data.byteLength));
    if (stream.destroyed || !stream.writable) break;
    if (!stream.write(slice)) {
      await new Promise<void>((resolve, reject) => {
        const cleanup = () => { stream.off('drain', onDrain); stream.off('close', onClose); stream.off('error', onError); };
        const onDrain = () => { cleanup(); resolve(); };
        const onClose = () => { cleanup(); resolve(); };
        const onError = (err: Error) => { cleanup(); reject(err); };
        stream.once('drain', onDrain); stream.once('close', onClose); stream.once('error', onError);
      });
    }
  }
}
class BatchStreamReader {
  readonly #chunks: Buffer[] = [];
  #headOffset = 0;
  #queuedBytes = 0;
  #ended = false;
  #streamError: Error | null = null;
  #waiter: (() => void) | null = null;
  readonly #hash = createHash('sha256');
  constructor(private readonly stdout: Readable, private readonly signal: AbortSignal, private readonly isFailed: () => boolean, private readonly isTimedOut: () => boolean) {
    stdout.on('data', (part: Buffer) => {
      this.#hash.update(part);
      if (part.length > 0) {
        this.#chunks.push(part); this.#queuedBytes += part.length;
        if (this.#queuedBytes >= 4_194_304) stdout.pause();
        this.#notify();
      }
    });
    stdout.on('end', () => { this.#ended = true; this.#notify(); });
    stdout.on('error', err => { this.#streamError = err; this.#ended = true; this.#notify(); });
  }
  digest(): Digest { return { algorithm: 'sha256', hex: this.#hash.digest('hex') }; }
  #notify(): void { if (this.#waiter) { const w = this.#waiter; this.#waiter = null; w(); } }
  async #waitMore(): Promise<boolean> {
    if (this.signal.aborted) refuse('CANCELLED', '', 'execution');
    if (this.isTimedOut()) refuse('DEADLINE', '', 'execution');
    if (this.isFailed()) refuse('TARGET_MISMATCH', '', 'execution');
    if (this.#streamError) throw this.#streamError;
    if (this.#ended) return false;
    await new Promise<void>(resolve => { this.#waiter = resolve; });
    if (this.signal.aborted) refuse('CANCELLED', '', 'execution');
    if (this.isTimedOut()) refuse('DEADLINE', '', 'execution');
    if (this.isFailed()) refuse('TARGET_MISMATCH', '', 'execution');
    if (this.#streamError) throw this.#streamError;
    return this.#chunks.length > 0 || !this.#ended;
  }
  #consumeHead(n: number): void {
    this.#headOffset += n; this.#queuedBytes -= n;
    if (this.#headOffset >= this.#chunks[0]!.length) { this.#chunks.shift(); this.#headOffset = 0; }
    if (this.#queuedBytes < 1_048_576 && !this.#ended) this.stdout.resume();
  }
  async readLine(maxBytes = 256): Promise<string> {
    const parts: Buffer[] = []; let total = 0;
    for (;;) {
      if (this.#chunks.length === 0) { if (!(await this.#waitMore())) refuse('TARGET_MISMATCH', '', 'execution'); continue; }
      const head = this.#chunks[0]!, nl = head.indexOf(10, this.#headOffset);
      if (nl !== -1) {
        const piece = head.subarray(this.#headOffset, nl);
        if (total + piece.length > maxBytes) refuse('TARGET_MISMATCH', '', 'execution');
        parts.push(piece); this.#consumeHead(nl - this.#headOffset + 1);
        return Buffer.concat(parts).toString('utf8');
      }
      const piece = head.subarray(this.#headOffset);
      total += piece.length; if (total > maxBytes) refuse('TARGET_MISMATCH', '', 'execution');
      parts.push(piece); this.#consumeHead(piece.length);
    }
  }
  async streamBytes(length: number, sink: (slice: Buffer) => Promise<void>): Promise<void> {
    let remaining = length;
    while (remaining > 0) {
      if (this.#chunks.length === 0) { if (!(await this.#waitMore())) refuse('TARGET_MISMATCH', '', 'execution'); continue; }
      const head = this.#chunks[0]!, take = Math.min(remaining, head.length - this.#headOffset);
      await sink(head.subarray(this.#headOffset, this.#headOffset + take));
      this.#consumeHead(take); remaining -= take;
    }
  }
  async readExactByte(expected: number): Promise<void> {
    while (this.#chunks.length === 0) { if (!(await this.#waitMore())) refuse('TARGET_MISMATCH', '', 'execution'); }
    if (this.#chunks[0]![this.#headOffset]! !== expected) refuse('TARGET_MISMATCH', '', 'execution');
    this.#consumeHead(1);
  }
  async assertExhausted(): Promise<void> {
    while (!this.#ended) await this.#waitMore();
    if (this.#queuedBytes !== 0) refuse('TARGET_MISMATCH', '', 'execution');
  }
}
export async function processBirth(pid: number): Promise<string | null> {
  try {
    const result = await execute('/bin/ps', ['-p', String(pid), '-o', 'lstart='], { timeout: 10000, maxBuffer: 1024, env: processEnvironment });
    const birth = result.stdout.trim(); if (!birth || birth.length > 128 || result.stderr) refuse('RECOVERY_REQUIRED', '', 'recovery'); return birth;
  } catch (error) {
    const value = error as { code?: unknown; stdout?: unknown; stderr?: unknown };
    if (value.code === 1 && value.stdout === '' && value.stderr === '') return null;
    if (error instanceof ControllerFailure) throw error; refuse('RECOVERY_REQUIRED', '', 'recovery');
  }
}
export async function bootIdentity(): Promise<string> {
  if (process.platform === 'darwin' && process.arch === 'arm64') {
    const result = await execute('/usr/sbin/sysctl', ['-n', 'kern.boottime'], { timeout: 10000, maxBuffer: 1024, env: processEnvironment });
    if (!/^\{ sec = \d+, usec = \d+ \} [^\r\n]+\n$/.test(result.stdout) || result.stderr) refuse('RECOVERY_REQUIRED', '', 'recovery');
    return result.stdout.trim();
  }
  if (process.platform === 'linux' && (process.arch === 'arm64' || process.arch === 'x64')) {
    let file: Awaited<ReturnType<typeof open>> | null = null;
    try {
      file = await open('/proc/sys/kernel/random/boot_id', constants.O_RDONLY | constants.O_NOFOLLOW);
      const buffer = Buffer.alloc(64);
      const { bytesRead } = await file.read(buffer, 0, buffer.length, null);
      const raw = buffer.subarray(0, bytesRead).toString('utf8');
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\n$/.test(raw)) refuse('RECOVERY_REQUIRED', '', 'recovery');
      return raw.trim();
    } catch (error) {
      if (error instanceof ControllerFailure) throw error;
      refuse('RECOVERY_REQUIRED', '', 'recovery');
    } finally { await file?.close(); }
  }
  refuse('CAPABILITY_UNSUPPORTED', '', 'admission');
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
  async materializeGitBatch(
    repository: string,
    entries: readonly { readonly name: string; readonly mode: '100644' | '100755'; readonly oid: string; readonly byteLength: number }[],
    baselineDir: string,
    signal: AbortSignal = new AbortController().signal,
    timeoutMs = 10_000,
  ): Promise<void> {
    if (this.#active) refuse('OWNER_BUSY', '', 'execution'); this.#active = true;
    try { await this.#materializeGitBatch(repository, entries, baselineDir, signal, timeoutMs); } finally { this.#active = false; }
  }
  async #runReader<T>(
    repository: string,
    args: readonly string[],
    intentDigest: Digest,
    timeoutMs: number,
    phase: ControllerDiagnostic['phase'],
    signal: AbortSignal,
    setup: (child: ChildProcess, stop: () => void, isFailed: () => boolean, isTimedOut: () => boolean) => {
      readonly digest: (onError: boolean) => Digest;
      readonly run: (nonce: string, birth: string) => Promise<void>;
      readonly result: () => T;
    },
  ): Promise<T> {
    await this.assertCurrent();
    if (signal.aborted) refuse('CANCELLED', '', phase);
    const nonce = randomBytes(16).toString('hex');
    await this.#append({ type: 'intent', nonce, digest: intentDigest });
    this.#pending.add(nonce);
    const child = spawn(process.execPath, [fileURLToPath(new URL('./git-reader.js', import.meta.url)), nonce, JSON.stringify({ repository, args })], { env: GIT_ENVIRONMENT, cwd: this.directory, stdio: ['pipe', 'pipe', 'pipe', 'pipe'], detached: true });
    child.stdin!.on('error', () => {});
    let stderr = 0, failed = false, timedOut = false;
    const stop = () => { failed = true; if (child.pid && child.exitCode === null && child.signalCode === null) { try { process.kill(-child.pid, 'SIGKILL'); } catch { /* Exact exit is awaited below. */ } } };
    const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(resolve => { child.once('close', (code, sig) => resolve({ code, signal: sig })); child.once('error', () => resolve({ code: null, signal: null })); });
    const timer = setTimeout(() => { timedOut = true; stop(); }, timeoutMs); signal.addEventListener('abort', stop, { once: true });
    child.stderr!.on('data', (part: Buffer) => { stderr += part.length; if (stderr > 8192) stop(); });
    const session = setup(child, stop, () => failed, () => timedOut);
    try {
      const ready = await new Promise<Record<string, unknown>>((resolve, reject) => {
        let buffer = '';
        const pipe = child.stdio[3] as Readable;
        pipe.on('data', part => { buffer += part.toString(); if (buffer.length > 1024) { stop(); reject(new Error('reader')); } else if (buffer.endsWith('\n')) { try { resolve(record(parseDocumentBytes(Buffer.from(buffer), 'json'), ['version', 'nonce', 'pid'])); } catch (error) { reject(error); } } });
        void exited.then(() => reject(new Error('reader-exited')));
      });
      if (!child.pid || ready.version !== 1 || ready.nonce !== nonce || ready.pid !== child.pid) refuse('RECOVERY_REQUIRED', '', phase);
      const birth = await processBirth(child.pid);
      if (signal.aborted) refuse('CANCELLED', '', phase);
      if (timedOut) refuse('DEADLINE', '', phase);
      if (!birth) refuse('RECOVERY_REQUIRED', '', phase);
      await this.#append({ type: 'started', nonce, pid: child.pid, birth }); await this.assertCurrent();
      if (signal.aborted) refuse('CANCELLED', '', phase);
      if (this.ports.afterGitExec) {
        const replaced = new Promise<void>((resolve, reject) => { (child.stdio[3] as Readable).once('end', resolve); void exited.then(() => reject(new Error('reader-exited'))); });
        child.stdin!.write(nonce + '\n'); await replaced; await this.ports.afterGitExec({ pid: child.pid, birth, nonce });
      }
      await session.run(nonce, birth);
      const exit = await exited; clearTimeout(timer);
      await this.#append({ type: 'exit', nonce, code: exit.code, signal: exit.signal, stdoutDigest: session.digest(false) });
      this.#pending.delete(nonce);
      if (failed || exit.code !== 0 || exit.signal !== null) refuse(signal.aborted ? 'CANCELLED' : timedOut ? 'DEADLINE' : 'TARGET_MISMATCH', '', phase);
      return session.result();
    } catch (error) {
      stop(); const exit = await exited;
      if (this.#pending.has(nonce)) { await this.#append({ type: 'exit', nonce, code: exit.code, signal: exit.signal, stdoutDigest: session.digest(true) }); this.#pending.delete(nonce); }
      if (error instanceof ControllerFailure) throw error;
      refuse(signal.aborted ? 'CANCELLED' : timedOut ? 'DEADLINE' : 'TARGET_MISMATCH', '', phase);
    } finally {
      clearTimeout(timer); signal.removeEventListener('abort', stop);
    }
  }
  async #git(repository: string, args: readonly string[], maximum: number, signal: AbortSignal): Promise<Buffer> {
    integer(maximum, 1, 16_777_217);
    const intentObject = { repository, args, maximum };
    const stdout: Buffer[] = []; let bytes = 0;
    try {
      return await this.#runReader(repository, args, hash(canonical(intentObject)), 10_000, 'admission', signal, (child, stop) => {
        child.stdout!.on('data', (part: Buffer) => { bytes += part.length; if (bytes > maximum) stop(); else stdout.push(part); });
        return {
          digest: onError => hash(onError ? Buffer.concat(stdout) : Buffer.concat(stdout, bytes <= maximum ? bytes : 0)),
          run: async nonce => {
            if (!this.ports.afterGitExec) await writeAll(child.stdin!, Buffer.from(nonce + '\n'));
            child.stdin!.end();
          },
          result: () => Buffer.concat(stdout, bytes <= maximum ? bytes : 0),
        };
      });
    } catch (error) {
      if (error instanceof ControllerFailure && error.diagnostic.code === 'TARGET_MISMATCH' && bytes > maximum) {
        refuse('OUTPUT_LIMIT', '', 'admission');
      }
      throw error;
    }
  }
  async #materializeGitBatch(
    repository: string,
    entries: readonly { readonly name: string; readonly mode: '100644' | '100755'; readonly oid: string; readonly byteLength: number }[],
    baselineDir: string,
    signal: AbortSignal,
    timeoutMs: number,
  ): Promise<void> {
    await this.assertCurrent();
    if (signal.aborted) refuse('CANCELLED', '', 'execution');
    if (timeoutMs <= 0) refuse('DEADLINE', '', 'execution');
    await rm(baselineDir, { recursive: true, force: true });
    await mkdir(baselineDir, { recursive: true, mode: 0o755 });
    if (entries.length === 0) return;
    const entriesHash = createHash('sha256');
    entriesHash.update(canonical({ baselineDir }) + '\n');
    for (const entry of entries) {
      entriesHash.update(canonical({ name: entry.name, mode: entry.mode, oid: entry.oid, byteLength: entry.byteLength }) + '\n');
    }
    const args = ['cat-file', '--batch'] as const;
    const intentDigest = hash(canonical({ repository, args, entriesDigest: { algorithm: 'sha256', hex: entriesHash.digest('hex') } }));
    const effectiveTimeout = Math.min(timeoutMs, 120_000);
    await this.#runReader(repository, args, intentDigest, effectiveTimeout, 'execution', signal, (child, stop, isFailed, isTimedOut) => {
      const stream = new BatchStreamReader(child.stdout!, signal, isFailed, isTimedOut);
      return {
        digest: () => stream.digest(),
        run: async nonce => {
          const writeBatch = async () => {
            if (!this.ports.afterGitExec) await writeAll(child.stdin!, Buffer.from(nonce + '\n'));
            let chunk = ''; let count = 0;
            for (const entry of entries) {
              chunk += entry.oid + '\n'; count++;
              if (count >= 256) { await writeAll(child.stdin!, Buffer.from(chunk, 'utf8')); chunk = ''; count = 0; }
            }
            if (chunk.length > 0) await writeAll(child.stdin!, Buffer.from(chunk, 'utf8'));
            child.stdin!.end();
          };
          const readBatch = async () => {
            const createdDirs = new Set<string>(['']);
            for (const entry of entries) {
              if (signal.aborted) refuse('CANCELLED', '', 'execution');
              const header = await stream.readLine(256);
              const space1 = header.indexOf(' '), space2 = space1 === -1 ? -1 : header.indexOf(' ', space1 + 1);
              if (space1 === -1 || space2 === -1 || header.indexOf(' ', space2 + 1) !== -1) refuse('TARGET_MISMATCH', '', 'execution');
              const oid = header.slice(0, space1), kind = header.slice(space1 + 1, space2), sizeStr = header.slice(space2 + 1);
              if (oid !== entry.oid || kind !== 'blob' || !/^(?:0|[1-9][0-9]*)$/.test(sizeStr) || Number(sizeStr) !== entry.byteLength) {
                refuse('TARGET_MISMATCH', '', 'execution');
              }
              if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(entry.oid)) refuse('TARGET_MISMATCH', '', 'execution');
              const objectFormat = entry.oid.length === 64 ? 'sha256' : 'sha1';
              const blobHash = createHash(objectFormat).update(`blob ${entry.byteLength}\0`);
              const targetPath = join(baselineDir, entry.name);
              const slash = entry.name.lastIndexOf('/');
              if (slash !== -1) {
                const relDir = entry.name.slice(0, slash);
                if (!createdDirs.has(relDir)) {
                  await mkdir(join(baselineDir, relDir), { recursive: true, mode: 0o755 });
                  let pos = relDir.indexOf('/');
                  while (pos !== -1) { createdDirs.add(relDir.slice(0, pos)); pos = relDir.indexOf('/', pos + 1); }
                  createdDirs.add(relDir);
                }
              }
              const fileMode = entry.mode === '100755' ? 0o555 : 0o444;
              const descriptor = await open(targetPath, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, fileMode);
              try {
                await stream.streamBytes(entry.byteLength, async slice => {
                  blobHash.update(slice);
                  let offset = 0;
                  while (offset < slice.length) {
                    const { bytesWritten } = await descriptor.write(slice, offset, slice.length - offset);
                    if (bytesWritten <= 0) refuse('TARGET_MISMATCH', '', 'execution');
                    offset += bytesWritten;
                  }
                });
                if (blobHash.digest('hex') !== entry.oid) refuse('TARGET_MISMATCH', '', 'execution');
                await descriptor.chmod(fileMode);
              } finally {
                await descriptor.close();
              }
              await stream.readExactByte(10);
            }
            await stream.assertExhausted();
          };
          await Promise.all([
            writeBatch().catch(error => { stop(); throw error; }),
            readBatch().catch(error => { stop(); throw error; }),
          ]);
        },
        result: () => undefined,
      };
    });
  }
  async release(): Promise<void> {
    if (this.#released) return; if (this.#active || this.#pending.size || this.#heldActivities) refuse('CLEANUP_FAILED', '', 'finalization'); await this.assertCurrent();
    const bytes = await readBoundedFile(this.path, 1048576, true), archive = await open(join(this.directory, 'controller.closed.' + this.nonce + '.ndjson'), constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
    try { await archive.writeFile(bytes); await archive.sync(); } finally { await archive.close(); }
    await syncDirectory(this.directory); await this.assertCurrent();
    await this.#fd!.close(); this.#fd = null; await unlink(this.path); await syncDirectory(this.directory); this.#released = true;
  }
}
