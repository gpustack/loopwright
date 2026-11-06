import { execFile, spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, writeFile, mkdir, realpath, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
import { canonical, digest } from './boundary.js';
import { sameIdentity } from './policy.js';
import { profileIdentity, restrictedArguments, verifyRestrictions } from './runtime-profile.js';
import { registerChild, exitChild, registerAttach } from './execution-lease.js';
import { isAbsentContainer } from './docker-absence.js';
import { refuse } from './errors.js';
import type { PiHost, PiOpenInput } from './types.js';
const execute = promisify(execFile);
export interface ContainerExit { readonly id: string; readonly exitCode: number; readonly removed: true; readonly cli: { readonly code: number | null; readonly signal: NodeJS.Signals | null } }
/** One role, one exact image/nonce, no model-controlled mounts, entrypoints or environment. */
export class OwnedContainer {
  readonly nonce = randomBytes(16).toString('hex');
  readonly name: string;
  readonly labels: Readonly<Record<string, string>>;
  #id: string | null = null; #attempted = false; #child: ChildProcessWithoutNullStreams | null = null;
  #exit: Promise<{ code: number | null; signal: NodeJS.Signals | null }> | null = null;
  #closed: Promise<ContainerExit | null> | null = null; #receipt: ContainerExit | null = null;
  constructor(readonly host: PiHost, readonly input: PiOpenInput, readonly directory: string, readonly candidate: string, readonly role: 'tool' | 'mcp', readonly operationId: string) {
    this.name = 'lw-pi-' + role + '-' + this.nonce;
    this.labels = Object.freeze({ 'org.loopwright.generation': String(host.authority.generation), 'org.loopwright.run': input.lock.spec.runId, 'org.loopwright.session': input.sessionId, 'org.loopwright.nonce': this.nonce, 'org.loopwright.role': role, 'org.loopwright.operation': operationId });
  }
  async docker(args: readonly string[]): Promise<string> {
    const value = await execute(this.host.dockerExecutable, ['--config', join(this.directory, 'docker-client'), '--host', 'unix://' + this.host.dockerSocket, ...args],
      { timeout: 10000, maxBuffer: 1048576, env: { PATH: '/usr/local/bin:/usr/bin:/bin', HOME: this.directory, LANG: 'C.UTF-8' } }); return value.stdout;
  }
  async inspect(id: string): Promise<Record<string, unknown>> { return JSON.parse(await this.docker(['inspect', id]))[0] as Record<string, unknown>; }
  #ownership(value: Record<string, unknown>): void {
    const config = value.Config as { Labels: Record<string, string> };
    if (value.Id !== this.#id || value.Name !== '/' + this.name || value.Image !== this.input.policy.runtime.imageDigest || !sameIdentity(config.Labels, this.labels)) refuse('CONTAINMENT_MISMATCH', '', { phase: 'tool' });
  }
  async start(signal: AbortSignal): Promise<ChildProcessWithoutNullStreams> {
    if (this.#attempted || this.#closed) refuse('SESSION_BUSY', '', { phase: 'tool' }); signal.throwIfAborted();
    if (!sameIdentity(await profileIdentity(), this.input.policy.runtime.configDigest) || !sameIdentity(digest(await readFile(new URL('../../../package-lock.json', import.meta.url))), this.input.policy.runtime.graphDigest)) refuse('RUNTIME_MISMATCH', '', { phase: 'tool' });
    if (await realpath(this.candidate) !== resolve(this.candidate) || !(await stat(this.candidate)).isDirectory()) refuse('CONTAINMENT_MISMATCH', '', { phase: 'tool' });
    const image = JSON.parse(await this.docker(['image', 'inspect', this.input.policy.runtime.imageDigest]))[0];
    if (image.Id !== this.input.policy.runtime.imageDigest || image.Os !== 'linux' || image.Architecture !== 'arm64' || image.Config.User !== '1000:1000' || !sameIdentity(image.Config.Entrypoint, ['node'])) refuse('RUNTIME_MISMATCH', '', { phase: 'tool' });
    await mkdir(this.directory, { mode: 0o700 });
    await writeFile(join(this.directory, 'container-intent.json'), JSON.stringify({ name: this.name, nonce: this.nonce, labels: this.labels, image: this.input.policy.runtime.imageDigest }), { flag: 'wx', mode: 0o600 });
    await registerChild(this.host, { name: this.name, nonce: this.nonce, labels: this.labels, image: this.input.policy.runtime.imageDigest });
    this.#attempted = true; signal.throwIfAborted();
    this.#id = (await this.docker(restrictedArguments(this.name, this.labels, this.candidate, this.input.policy.runtime.imageDigest, this.role, this.nonce))).trim();
    if (!/^[a-f0-9]{64}$/.test(this.#id)) refuse('CONTAINMENT_MISMATCH', '', { phase: 'tool' });
    await writeFile(join(this.directory, 'container-id.json'), JSON.stringify({ id: this.#id, nonce: this.nonce }), { flag: 'wx', mode: 0o600 });
    const inspected = await this.inspect(this.#id); this.#ownership(inspected);
    verifyRestrictions(inspected, this.candidate, canonical(JSON.parse(await readFile(new URL('../runtime/seccomp.json', import.meta.url), 'utf8'))));
    await writeFile(join(this.directory, 'inspect.json'), JSON.stringify(inspected), { mode: 0o600 }); signal.throwIfAborted();
    const child = spawn(this.host.dockerExecutable, ['--config', join(this.directory, 'docker-client'), '--host', 'unix://' + this.host.dockerSocket, 'start', '--attach', '--interactive', this.#id],
      { stdio: ['pipe', 'pipe', 'pipe'], env: { PATH: '/usr/local/bin:/usr/bin:/bin', HOME: this.directory, LANG: 'C.UTF-8' } });
    this.#child = child; this.#exit = new Promise(resolve => { child.once('exit', (code, signal) => resolve({ code, signal })); child.once('error', () => resolve({ code: null, signal: null })); }); await registerAttach(this.host, this.nonce, child.pid); return child;
  }
  close(): Promise<ContainerExit | null> {
    if (this.#receipt) return Promise.resolve(this.#receipt); if (this.#closed) return this.#closed;
    const close = this.#cleanup(); this.#closed = close; void close.catch(() => { this.#closed = null; }); return close;
  }
  async #cleanup(): Promise<ContainerExit | null> {
    try {
      this.#child?.stdin.end();
      if (this.#exit) { let timer: ReturnType<typeof setTimeout> | undefined; try { await Promise.race([this.#exit, new Promise(resolve => { timer = setTimeout(resolve, 2000); })]); } finally { clearTimeout(timer); } }
      if (!this.#attempted) return null;
      const identity = this.#id ?? this.name; let value: Record<string, unknown>;
      try { value = await this.inspect(identity); }
      catch (error) { if (isAbsentContainer(identity, error) && this.#id === null) { await exitChild(this.host, this.nonce); return null; } throw error; }
      this.#id = value.Id as string; this.#ownership(value);
      if ((value.State as { Running: boolean }).Running) await this.docker(['kill', this.#id]);
      const stopped = await this.inspect(this.#id), state = stopped.State as { Running: boolean; ExitCode: number }; this.#ownership(stopped);
      if (state.Running || !Number.isInteger(state.ExitCode)) refuse('CLEANUP_FAILED', '', { phase: 'cleanup', effect: 'possible' });
      await this.docker(['rm', this.#id]);
      try { await this.inspect(this.#id); refuse('CLEANUP_FAILED', '', { phase: 'cleanup', effect: 'possible' }); } catch (error) { if (!isAbsentContainer(this.#id, error)) throw error; }
      const cli = this.#exit ? await this.#waitExit() : { code: null, signal: null };
      const receipt: ContainerExit = { id: this.#id, exitCode: state.ExitCode, removed: true, cli }; await writeFile(join(this.directory, 'cleanup.json'), JSON.stringify(receipt), { mode: 0o600 }); await exitChild(this.host, this.nonce); this.#receipt = receipt; return receipt;
    } finally {
      this.#child?.stdin.destroy(); this.#child?.stdout.destroy(); this.#child?.stderr.destroy();
      if (this.#child?.exitCode === null && this.#child.signalCode === null) this.#child.kill('SIGKILL');
      if (this.#exit) await this.#waitExit();
    }
  }
  async #waitExit(): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try { return await Promise.race([this.#exit!, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('Owned attach exit unavailable')), 2000); })]); }
    finally { clearTimeout(timer); }
  }
}
