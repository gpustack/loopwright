import { constants } from 'node:fs';
import { open, lstat, realpath, unlink, mkdir } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { join, resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
import { canonical, digest, object } from './boundary.js';
import { parseBoundedJson } from './context.js';
import { sameIdentity } from './policy.js';
import { stateValue } from './admission.js';
import { refuse } from './errors.js';
import type { PiHost, PiOpenInput } from './types.js';
import { selectedDaemon, verifiedDaemon, type DaemonBinding } from './daemon.js';
const exec = promisify(execFile), leases = new WeakMap<PiHost, ExecutionLease>();
export interface ChildIntent { name: string; nonce: string; labels: Readonly<Record<string, string>>; image: string }
const environment = { PATH: '/usr/bin:/bin:/usr/sbin', LANG: 'C' };
async function birth(pid: number): Promise<string | null> {
  try { const result = await exec('/bin/ps', ['-p', String(pid), '-o', 'lstart='], { timeout: 2000, maxBuffer: 1024, env: environment }); const value = result.stdout.trim(); if (!value || value.length > 128 || result.stderr) refuse('RECOVERY_REQUIRED'); return value; }
  catch (error) { const value = error as { code?: unknown; stdout?: unknown; stderr?: unknown }; if (value.code === 1 && value.stdout === '' && value.stderr === '') return null; throw error; }
}
async function boot(): Promise<string> { const result = await exec('/usr/sbin/sysctl', ['-n', 'kern.boottime'], { timeout: 2000, maxBuffer: 1024, env: environment }); if (!/^\{ sec = \d+, usec = \d+ \} [^\r\n]+\n$/.test(result.stdout) || result.stderr) refuse('RECOVERY_REQUIRED'); return result.stdout.trim(); }
/** Lifetime exclusion is separate from S02 authority. Only verified owner death can begin orphan recovery. */
export class ExecutionLease {
  #fd: Awaited<ReturnType<typeof open>> | null = null; #tail = Promise.resolve(); #released = false; #releasing: Promise<void> | null = null;
  #daemon: DaemonBinding | null = null;
  readonly #children = new Map<string, ChildIntent>(); readonly token = randomBytes(16).toString('hex'); readonly path: string;
  private constructor(readonly host: PiHost, readonly input: PiOpenInput) { this.path = join(host.artifactsDirectory, 'pi-execution-' + digest(Buffer.from(canonical({ storeId: stateValue(host.store.inspect()).storeId, runId: input.lock.spec.runId }))).hex + '.ndjson'); }
  static async acquire(host: PiHost, input: PiOpenInput): Promise<ExecutionLease> {
    const root = await lstat(host.artifactsDirectory); if (!root.isDirectory() || root.isSymbolicLink() || root.uid !== process.getuid?.() || root.mode & 0o022 || await realpath(host.artifactsDirectory) !== resolve(host.artifactsDirectory)) refuse('INPUT_INVALID');
    const lease = new ExecutionLease(host, input), born = await birth(process.pid), bootIdentity = await boot(); if (!born) refuse('RECOVERY_REQUIRED');
    try { lease.#fd = await open(lease.path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      // Recovery itself has exclusion. A crash here remains blocked for explicit safe intervention.
      let recovery: Awaited<ReturnType<typeof open>>;
      try { recovery = await open(lease.path + '.recovery', constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600); } catch { refuse('SESSION_BUSY'); }
      try { await lease.#recover(bootIdentity); lease.#fd = await open(lease.path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600); }
      finally { await recovery.close(); await unlink(lease.path + '.recovery'); }
    }
    try {
      if (!lease.#daemon) {
        try { lease.#daemon = await selectedDaemon(host); }
        catch { refuse('CONTAINMENT_UNAVAILABLE', '', { phase: 'preflight' }); }
      }
      const view = stateValue(host.store.inspect()); stateValue(host.store.renew(host.authority));
      await lease.#append({ type: 'owner', version: 2, daemon: lease.#daemon, token: lease.token, pid: process.pid, birth: born, boot: bootIdentity, authority: host.authority, storeId: view.storeId, runId: view.runId, lockHash: view.lockHash, clockBasis: view.clock.basis });
      await lease.#syncParent(); leases.set(host, lease); return lease;
    } catch (error) { await lease.#fd?.close(); lease.#fd = null; await unlink(lease.path); throw error; }
  }
  async #syncParent(): Promise<void> { const fd = await open(this.host.artifactsDirectory, constants.O_RDONLY | constants.O_NOFOLLOW); try { await fd.sync(); } finally { await fd.close(); } }
  async #append(value: unknown): Promise<void> { if (!this.#fd || this.#released) refuse('RECOVERY_REQUIRED'); const bytes = Buffer.from(JSON.stringify(value) + '\n'); if ((await this.#fd.stat()).size + bytes.length > 2097152) refuse('OUTPUT_LIMIT'); await this.#fd.writeFile(bytes); await this.#fd.sync(); }
  async #recover(bootIdentity: string): Promise<void> {
    const fd = await open(this.path, constants.O_RDONLY | constants.O_NOFOLLOW); let rows: Record<string, unknown>[], inode: number;
    try {
      const stat = await fd.stat(); inode = stat.ino; if (!stat.isFile() || stat.uid !== process.getuid?.() || stat.mode & 0o077 || stat.nlink !== 1 || stat.size > 2097152) refuse('RECOVERY_REQUIRED');
      const content = await fd.readFile('utf8'); if (!content.endsWith('\n')) refuse('RECOVERY_REQUIRED'); rows = content.slice(0, -1).split('\n').map(row => parseBoundedJson(row) as Record<string, unknown>);
    } finally { await fd.close(); }
    const first = rows[0]; if (!first || first.version !== 2) refuse('RECOVERY_REQUIRED');
    try { object(first, ['type', 'version', 'daemon', 'token', 'pid', 'birth', 'boot', 'authority', 'storeId', 'runId', 'lockHash', 'clockBasis']); } catch { refuse('RECOVERY_REQUIRED'); }
    const daemon = await verifiedDaemon(this.host, first.daemon);
    const view = stateValue(this.host.store.inspect());
    if (first.type !== 'owner' || !Number.isSafeInteger(first.pid) || (first.pid as number) < 1 || typeof first.birth !== 'string' || typeof first.token !== 'string' || !/^[a-f0-9]{32}$/.test(first.token) || first.boot !== bootIdentity || first.storeId !== view.storeId || first.runId !== view.runId || !sameIdentity(first.lockHash, view.lockHash) || !sameIdentity(first.clockBasis, view.clock.basis)) refuse('RECOVERY_REQUIRED');
    const authority = object(first.authority, ['storeId', 'runId', 'lockHash', 'ownerId', 'generation', 'nonce']); if (authority.storeId !== view.storeId || authority.runId !== view.runId || !sameIdentity(authority.lockHash, view.lockHash) || !Number.isSafeInteger(authority.generation) || (authority.generation as number) > this.host.authority.generation) refuse('RECOVERY_REQUIRED');
    const currentBirth = await birth(first.pid as number); if (currentBirth !== null) refuse(currentBirth === first.birth ? 'SESSION_BUSY' : 'RECOVERY_REQUIRED');
    try { process.kill(first.pid as number, 0); refuse('RECOVERY_REQUIRED'); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error; }
    const intents = new Map<string, ChildIntent>(), attaches = new Map<string, { pid: number; birth: string }>(), receipts: unknown[] = [];
    for (const row of rows.slice(1)) {
      if (row.type === 'child') { const item = object(row, ['type', 'name', 'nonce', 'labels', 'image']); if (typeof item.name !== 'string' || !/^lw-pi-(?:(?:tool|mcp)-)?[a-f0-9]{32}$/.test(item.name) || typeof item.nonce !== 'string' || !/^[a-f0-9]{32}$/.test(item.nonce) || typeof item.image !== 'string' || !/^sha256:[a-f0-9]{64}$/.test(item.image)) refuse('RECOVERY_REQUIRED'); const labels = item.labels as Record<string, string>; if (!labels || labels['org.loopwright.run'] !== view.runId || labels['org.loopwright.nonce'] !== item.nonce || labels['org.loopwright.generation'] !== String(authority.generation) || intents.has(item.nonce)) refuse('RECOVERY_REQUIRED'); intents.set(item.nonce, item as unknown as ChildIntent); }
      else if (row.type === 'attach') { object(row, ['type', 'nonce', 'pid', 'birth']); if (typeof row.nonce !== 'string' || !intents.has(row.nonce) || attaches.has(row.nonce) || !Number.isSafeInteger(row.pid) || (row.pid as number) < 1 || typeof row.birth !== 'string' || !row.birth) refuse('RECOVERY_REQUIRED'); attaches.set(row.nonce, { pid: row.pid as number, birth: row.birth }); }
      else if (row.type === 'exit') { object(row, ['type', 'nonce']); if (typeof row.nonce !== 'string' || !intents.delete(row.nonce)) refuse('RECOVERY_REQUIRED'); attaches.delete(row.nonce); }
      else refuse('RECOVERY_REQUIRED');
    }
    // Endpoint/identity refusals leave S02 untouched; authenticate current authority only after those pure checks.
    stateValue(this.host.store.renew(this.host.authority));
    // No name prefix or daemon-wide cleanup: each fsynced nonce intent predates its sole create.
    const config = join(this.host.directory, 'recovery-docker-client'); await mkdir(config, { recursive: true, mode: 0o700 });
    const docker = async (args: string[]) => (await exec(this.host.dockerExecutable, ['--config', config, '--host', 'unix://' + daemon.socket, ...args], { timeout: 10000, maxBuffer: 1048576, env: { ...environment, HOME: this.host.directory } })).stdout;
    const waitAttach = async (nonce: string) => {
      const attach = attaches.get(nonce); if (!attach) return null;
      const deadline = performance.now() + 2000;
      for (;;) {
        const current = await birth(attach.pid); if (current === null) { try { process.kill(attach.pid, 0); refuse('RECOVERY_REQUIRED'); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') refuse('RECOVERY_REQUIRED'); } return { pid: attach.pid, birth: attach.birth, deathConfirmed: true }; }
        if (current !== attach.birth || performance.now() >= deadline) refuse('CLEANUP_FAILED'); await new Promise(resolve => setTimeout(resolve, 50));
      }
    };
    for (const intent of intents.values()) {
      if (!attaches.has(intent.nonce)) refuse('RECOVERY_REQUIRED');
      let inspected: Record<string, unknown>;
      try { inspected = JSON.parse(await docker(['inspect', intent.name]))[0]; }
      catch (error) { const failure = error as { code?: unknown; stdout?: unknown; stderr?: unknown }; if (failure.code === 1 && typeof failure.stdout === 'string' && ['', '[]'].includes(failure.stdout.trim()) && typeof failure.stderr === 'string' && new RegExp('^error: no such (?:object|container): ' + intent.name + '\\s*$', 'i').test(failure.stderr)) { receipts.push({ name: intent.name, nonce: intent.nonce, absent: true, cli: await waitAttach(intent.nonce) }); continue; } throw error; }
      const id = inspected.Id as string; if (!/^[a-f0-9]{64}$/.test(id) || inspected.Name !== '/' + intent.name || inspected.Image !== intent.image || !sameIdentity((inspected.Config as { Labels: unknown }).Labels, intent.labels)) refuse('CLEANUP_FAILED');
      if ((inspected.State as { Running: boolean }).Running) await docker(['kill', id]); const stopped = JSON.parse(await docker(['inspect', id]))[0]; if (stopped.State.Running || !Number.isInteger(stopped.State.ExitCode)) refuse('CLEANUP_FAILED'); await docker(['rm', id]);
      try { await docker(['inspect', id]); refuse('CLEANUP_FAILED'); } catch (error) { const value = error as { code?: unknown; stdout?: unknown; stderr?: unknown }; if (value.code !== 1 || typeof value.stdout !== 'string' || !['', '[]'].includes(value.stdout.trim()) || typeof value.stderr !== 'string' || !new RegExp('^error: no such (?:object|container): ' + id + '\\s*$', 'i').test(value.stderr)) throw error; }
      receipts.push({ id, name: intent.name, nonce: intent.nonce, removed: true, exitCode: stopped.State.ExitCode, absenceConfirmed: true, cli: await waitAttach(intent.nonce) });
    }
    const record = await open(join(this.host.artifactsDirectory, 'pi-recovery-' + first.token + '.json'), constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600); try { await record.writeFile(JSON.stringify({ version: 1, priorPid: first.pid, priorBirth: first.birth, boot: first.boot, deathConfirmed: true, receipts })); await record.sync(); } finally { await record.close(); }
    const now = await lstat(this.path); if (now.ino !== inode || now.nlink !== 1) refuse('RECOVERY_REQUIRED'); await unlink(this.path); await this.#syncParent();
    this.#daemon = daemon;
  }
  register(intent: ChildIntent): Promise<void> {
    const next = this.#tail.then(async () => { stateValue(this.host.store.renew(this.host.authority)); if (this.#children.has(intent.nonce)) refuse('RECOVERY_REQUIRED'); await this.#append({ type: 'child', ...intent }); this.#children.set(intent.nonce, intent); }); this.#tail = next.catch(() => {}); return next;
  }
  attach(nonce: string, pid: number): Promise<void> { const next = this.#tail.then(async () => { if (!this.#children.has(nonce)) refuse('RECOVERY_REQUIRED'); const born = await birth(pid); if (!born) refuse('RECOVERY_REQUIRED'); await this.#append({ type: 'attach', nonce, pid, birth: born }); }); this.#tail = next.catch(() => {}); return next; }
  exit(nonce: string): Promise<void> { const next = this.#tail.then(async () => { if (!this.#children.has(nonce)) refuse('RECOVERY_REQUIRED'); await this.#append({ type: 'exit', nonce }); this.#children.delete(nonce); }); this.#tail = next.catch(() => {}); return next; }
  release(): Promise<void> { return this.#releasing ??= this.#release(); }
  async #release(): Promise<void> {
    await this.#tail; if (this.#released) return; if (this.#children.size || !this.#fd) refuse('CLEANUP_FAILED');
    const stat = await this.#fd.stat(), current = await lstat(this.path); if (current.ino !== stat.ino || current.nlink !== 1) refuse('RECOVERY_REQUIRED'); await this.#fd.close(); this.#fd = null; await unlink(this.path); await this.#syncParent(); this.#released = true; leases.delete(this.host);
  }
}
export async function registerChild(host: PiHost, intent: ChildIntent): Promise<void> { await leases.get(host)?.register(intent); }
export async function exitChild(host: PiHost, nonce: string): Promise<void> { await leases.get(host)?.exit(nonce); }

export async function registerAttach(host: PiHost, nonce: string, pid: number | undefined): Promise<void> { const lease = leases.get(host); if (lease) { if (!pid) refuse('RECOVERY_REQUIRED'); await lease.attach(nonce, pid); } }
