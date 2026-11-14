import { writeFileSync } from 'node:fs';
import { execFile, spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, writeFile, mkdir, realpath, stat } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { Channel, type ChannelMessage } from './protocol.js';
import { canonical, digest, freeze } from './boundary.js';
import { PiFailure, refuse } from './errors.js';
import { sameIdentity } from './policy.js';
import { profileIdentity, verifyRestrictions, restrictedArguments } from './runtime-profile.js';
export { profileIdentity } from './runtime-profile.js';
import { systemPrompt } from './resources.js';
import { receiveBrokerMessage } from './broker-channel.js';
import { stateValue } from './admission.js';
import { materializeCandidateDirectory, setDirectoryTreeMode } from './candidate.js';
import { isAbsentContainer } from './docker-absence.js';
import { registerChild, exitChild, registerAttach } from './execution-lease.js';
import { recoverSnapshot } from './recovery.js';
import { SnapshotTransfer } from './snapshot-transfer.js';
import { verifyNativeCompletion } from './lifecycle.js';
import { scheduleDeadline } from './deadline.js';
import type { RuntimeBroker } from './provider.js';
import type { PiHost, PiOpenInput, PiCapabilities } from './types.js';
const exec = promisify(execFile);
export async function canonicalDirectory(path: string): Promise<string> {
  try { const canonicalPath = await realpath(path), info = await stat(path); if (canonicalPath !== resolve(path) || !info.isDirectory() || info.uid !== process.getuid?.()) refuse('INPUT_INVALID'); return canonicalPath; }
  catch { refuse('INPUT_INVALID'); }
}
/** Internal constructor. The public factory supplies only its real state-aware sender. */
export class RuntimeSession {
  readonly nonce = randomBytes(16).toString('hex');
  readonly name = 'lw-pi-' + this.nonce;
  #id: string | null = null; #process: ChildProcessWithoutNullStreams | null = null; #channel: Channel | null = null;
  #bootWork: Promise<PiCapabilities> | null = null;
  #seccomp = ''; #snapshots: SnapshotTransfer | null = null;
  #creationAttempted = false;
  #closing: Promise<void> | null = null;
  #exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }> | null = null;
  #closed = false; #cleanupComplete = false; #failed = false; #pending: { kind: string; resolve: (value: unknown) => void; reject: (error: Error) => void } | null = null;
  constructor(readonly host: PiHost, readonly input: PiOpenInput, readonly broker: RuntimeBroker, readonly directory: string) {}
  async docker(args: readonly string[]): Promise<string> {
    const output = await exec(this.host.dockerExecutable, ['--config', join(this.directory, 'docker-client'), '--host', 'unix://' + this.host.dockerSocket, ...args], { timeout: 10000, maxBuffer: 1048576, env: { PATH: '/usr/local/bin:/usr/bin:/bin', HOME: this.directory, LANG: 'C.UTF-8' } }); return output.stdout;
  }
  async inspect(identity: string): Promise<Record<string, unknown>> { return JSON.parse(await this.docker(['inspect', identity]))[0] as Record<string, unknown>; }
  start(): Promise<PiCapabilities> {
    if (this.#bootWork || this.#closed) refuse('SESSION_BUSY'); const work = this.#boot(); this.#bootWork = work;
    return work.catch(async error => { await this.close(); throw error; });
  }
  async #boot(): Promise<PiCapabilities> {
      if (!sameIdentity(await profileIdentity(), this.input.policy.runtime.configDigest)) refuse('RUNTIME_MISMATCH', '/policy/runtime/configDigest');
      this.#seccomp = canonical(JSON.parse(await readFile(new URL('../runtime/seccomp.json', import.meta.url), 'utf8')));
      const lockBytes = await readFile(new URL('../../../package-lock.json', import.meta.url));
      if (!sameIdentity(digest(lockBytes), this.input.policy.runtime.graphDigest)) refuse('RUNTIME_MISMATCH', '/policy/runtime/graphDigest');
      const image = JSON.parse(await this.docker(['image', 'inspect', this.input.policy.runtime.imageDigest]))[0];
      if (image.Id !== this.input.policy.runtime.imageDigest || image.Os !== 'linux' || image.Architecture !== 'arm64' || image.Config.User !== '1000:1000' || !sameIdentity(image.Config.Entrypoint, ['node'])) refuse('RUNTIME_MISMATCH', '/policy/runtime/imageDigest');
      await mkdir(this.directory, { mode: 0o700 });
      await materializeCandidateDirectory(join(this.directory, 'candidate'), this.input);
      const labels = { 'org.loopwright.generation': String(this.host.authority.generation), 'org.loopwright.run': this.input.lock.spec.runId, 'org.loopwright.session': this.input.sessionId, 'org.loopwright.nonce': this.nonce };
      await writeFile(join(this.directory, 'container-intent.json'), JSON.stringify({ version: 1, name: this.name, nonce: this.nonce, labels, image: this.input.policy.runtime.imageDigest }), { flag: 'wx', mode: 0o600 });
      const args = restrictedArguments(this.name, labels, join(this.directory, 'candidate'), this.input.policy.runtime.imageDigest, 'sdk', this.nonce);
      await registerChild(this.host, { name: this.name, nonce: this.nonce, labels, image: this.input.policy.runtime.imageDigest }); this.#creationAttempted = true;
      if (this.#closed) refuse('CANCELLED');
      this.#id = (await this.docker(args)).trim(); if (!/^[a-f0-9]{64}$/.test(this.#id)) refuse('CONTAINMENT_MISMATCH');
      await writeFile(join(this.directory, 'container-id.json'), JSON.stringify({ id: this.#id, nonce: this.nonce }), { flag: 'wx', mode: 0o600 });
      const inspected = await this.inspect(this.#id); await writeFile(join(this.directory, 'inspect.json'), JSON.stringify(inspected), { mode: 0o600 }); this.#verify(inspected); if (this.#closed) refuse('CANCELLED');
      const child = spawn(this.host.dockerExecutable, ['--config', join(this.directory, 'docker-client'), '--host', 'unix://' + this.host.dockerSocket, 'start', '--attach', '--interactive', this.#id], { stdio: ['pipe', 'pipe', 'pipe'], env: { PATH: '/usr/local/bin:/usr/bin:/bin', HOME: this.directory, LANG: 'C.UTF-8' } });
      this.#process = child; this.#exited = new Promise(resolve => { child.once('exit', (code, signal) => resolve({ code, signal })); child.once('error', () => { this.#fail(); resolve({ code: null, signal: null }); }); });
      const diagnosticLimit = this.input.policy.limits.diagnosticBytes, retainedLimit = Math.floor((diagnosticLimit - 64) * 3 / 4); let stderrBytes = 0, retained = Buffer.alloc(0);
      child.stderr.on('data', (data: Buffer) => {
        stderrBytes += data.length; const keep = Math.min(data.length, Math.max(0, retainedLimit - retained.length)); if (keep) retained = Buffer.concat([retained, data.subarray(0, keep)]);
        try { if (this.input.policy.privateArtifacts) writeFileSync(join(this.directory, 'private-sdk-stderr'), JSON.stringify({ encoding: 'base64', truncated: stderrBytes > retained.length, data: retained.toString('base64') }) + '\n', { mode: 0o600 }); } catch { this.#fail(); }
        if (stderrBytes > diagnosticLimit) { this.broker.runtimeFault?.('OUTPUT_LIMIT'); this.#fail(); }
      });
      this.#channel = new Channel(this.nonce, child.stdout, child.stdin); this.#snapshots = new SnapshotTransfer(this.#channel); this.#channel.on('failed', () => this.#fail());
      this.#channel.on('message', (message: ChannelMessage) => { void this.#receive(message).catch(() => this.#fail()); });
      await registerAttach(this.host, this.nonce, child.pid);
      const restored = recoverSnapshot(this.host, this.input);
      if (restored) {
        const accepted = this.#wait('restore-ready'); await this.#channel.send('restore-start', { selection: this.input.policy.selection, toolNames: this.input.policy.tools, sessionBytes: this.input.policy.limits.sessionBytes }); await accepted;
        async function* chunks() { yield restored!.native; } const complete = this.#wait('restore-complete', 90000); await this.#snapshots.send(1, chunks(), this.input.policy.limits.sessionBytes); await complete;
      }
      const ready = this.#wait('ready'); const [, response] = await Promise.all([this.#channel.send('init', { selection: this.input.policy.selection, systemPrompt: systemPrompt(this.input), toolNames: this.input.policy.tools, mcp: this.input.policy.mcp, toolResultBytes: this.input.policy.limits.toolResultBytes, sessionBytes: this.input.policy.limits.sessionBytes, outputTokens: Math.min(this.input.lock.spec.contract.spec.budgets.perCallOutputTokens, this.input.policy.context.maxOutputTokens) }), ready]);
      const facts = response as { selection: unknown; thinkingLevel: unknown; node: unknown; platform: unknown; architecture: unknown };
      if (!sameIdentity(facts.selection, this.input.policy.selection) || facts.thinkingLevel !== this.input.policy.selection.thinking || facts.node !== 'v26.13.0' || facts.platform !== 'linux' || facts.architecture !== 'arm64') refuse('RUNTIME_MISMATCH');
      return freeze({ version: 1, policyDigest: digest(Buffer.from(canonical(this.input.policy))), runtime: this.input.policy.runtime,
        requested: this.input.policy.selection, catalogSupported: structuredClone(this.input.policy.selection), sessionEffective: structuredClone(this.input.policy.selection), outboundObserved: null,
        resources: this.input.policy.resources, accounting: 'soft_only', contextFit: 'unproven', defaultMode: 'proven_bound', liveProvenBoundAvailable: false, optInMode: 'estimated_guard', contextEstimator: { id: 'lw-pi-final-json-bytes-v1', version: 1, provenance: 'estimated' }, toolExecution: { candidate: 'read_only', candidateWrites: 'mediated', scratch: 'per_call' } });
  }
  #verifyOwnership(value: Record<string, unknown>): void {
    const config = value.Config as { Labels: Record<string, string> };
    if (value.Id !== this.#id || value.Image !== this.input.policy.runtime.imageDigest || value.Name !== '/' + this.name || config.Labels['org.loopwright.generation'] !== String(this.host.authority.generation) || config.Labels['org.loopwright.nonce'] !== this.nonce || config.Labels['org.loopwright.run'] !== this.input.lock.spec.runId || config.Labels['org.loopwright.session'] !== this.input.sessionId) refuse('CONTAINMENT_MISMATCH');
  }
  #verify(value: Record<string, unknown>): void {
    this.#verifyOwnership(value);
    verifyRestrictions(value, join(this.directory, 'candidate'), this.#seccomp);
  }
  #wait(kind: string, timeoutMs = 10000, remaining?: () => number | null): Promise<unknown> {
    if (this.#pending) refuse('SESSION_BUSY', '', { phase: 'session' }); if (this.#failed) refuse('RECOVERY_REQUIRED', '', { phase: 'session' });
    return new Promise((resolve, reject) => { let stop = () => {}; const expires = performance.now() + timeoutMs;
      this.#pending = { kind, resolve: value => { stop(); this.#pending = null; resolve(value); }, reject: error => { stop(); this.#pending = null; reject(error); } };
      stop = scheduleDeadline(remaining ?? (() => expires - performance.now()), () => { this.#pending = null; reject(new PiFailure({ code: 'DEADLINE', path: '', phase: 'session', retryable: false, effect: 'possible', requestId: null, operationId: null, stateErrorCode: null })); this.#fail(); }); });
  }
  async #receive(message: ChannelMessage): Promise<void> {
    if (this.#closed) throw new Error('Closed SDK channel');
    if (await this.#snapshots!.receive(message)) return;
    if (await receiveBrokerMessage(this.#channel!, this.broker, message)) return;
    if (message.kind === 'refused') { this.#snapshots?.close(); const body = message.body as { code?: string }; const code = body.code === 'MODEL_UNAVAILABLE' || body.code === 'THINKING_UNSUPPORTED' ? body.code : 'PROVIDER_RESPONSE_INVALID'; this.#pending?.reject(new PiFailure({ code, path: '/policy/selection', phase: 'session', retryable: false, effect: 'none', requestId: null, operationId: null, stateErrorCode: null })); return; }
    if (!this.#pending || message.kind !== this.#pending.kind) throw new Error('Unrequested SDK result'); this.#pending.resolve(message.body);
  }
  #fail(): void { if (!this.#closed) { this.#failed = true; this.#snapshots?.close(); this.#pending?.reject(new Error('SDK channel failed')); } }
  async command(kind: 'execute' | 'compact', body: unknown): Promise<unknown> {
    if (this.#closed || !this.#channel) refuse('CANCELLED', '', { phase: 'session' });
    const view = stateValue(this.host.store.inspect(), 'session'), remaining = view.clock.remainingTaskMs.safeValue;
    if (remaining === null || remaining <= 0) refuse('DEADLINE', '', { phase: 'session' });
    const pending = this.#wait('settled', undefined, () => { const current = this.host.store.inspect(); return current.ok && current.value.clockStatus === 'trusted' ? current.value.clock.remainingTaskMs.safeValue : null; });
    const [, response] = await Promise.all([this.#channel.send(kind, body), pending]); verifyNativeCompletion((response as { native?: unknown }).native, kind); return response;
  }
  async capture(sink: (bytes: Uint8Array) => Promise<void>): Promise<void> {
    if (this.#closed || !this.#channel || !this.#snapshots) refuse('CANCELLED');
    const view = stateValue(this.host.store.inspect(), 'restore'), remaining = view.clock.remainingTaskMs.safeValue; if (remaining === null || remaining <= 0) refuse('DEADLINE');
    const expected = this.#snapshots.expect(sink, this.input.policy.limits.sessionBytes, Math.min(90000, remaining));
    try { await this.#channel.send('capture', { query: expected.query }); await expected.done; } catch (error) { this.#snapshots.close(); if (error instanceof PiFailure && error.detail.code !== 'INPUT_INVALID') throw error; refuse('RECOVERY_REQUIRED', '', { phase: 'restore' }); }
  }
  close(): Promise<void> {
    if (this.#closing) return this.#closing;
    const attempt = this.#cleanup(); this.#closing = attempt; void attempt.then(() => { this.#closing = null; }, () => { this.#closing = null; }); return attempt;
  }
  async #cleanup(): Promise<void> {
    if (this.#cleanupComplete) return; this.#closed = true; this.#snapshots?.close(); this.#pending?.reject(new Error('closed')); await this.#bootWork?.catch(() => {});
    try {
      try {
        if (this.#channel) { try { await this.#channel.send('close', null); } catch { /* exact engine cleanup follows */ } this.#channel.close(); }
        if (this.#exited) { let timer: ReturnType<typeof setTimeout> | undefined; try { await Promise.race([this.#exited, new Promise(resolve => { timer = setTimeout(resolve, 2000); })]); } finally { clearTimeout(timer); } }
        if (!this.#creationAttempted) { this.#cleanupComplete = true; return; }
        const identity = this.#id ?? this.name;
        let inspected: Record<string, unknown>;
        try { inspected = await this.inspect(identity); } catch (error) { if (this.#id === null && this.#process === null && isAbsentContainer(identity, error)) { await exitChild(this.host, this.nonce); this.#cleanupComplete = true; return; } throw error; }
        const id = inspected.Id as string; this.#id = id; this.#verifyOwnership(inspected);
        if ((inspected.State as { Running: boolean }).Running) await this.docker(['kill', id]);
        const stopped = await this.inspect(id); this.#verifyOwnership(stopped); if ((stopped.State as { Running: boolean; ExitCode: number }).Running || !Number.isInteger((stopped.State as { ExitCode: number }).ExitCode)) refuse('CLEANUP_FAILED', '', { phase: 'cleanup' });
        await this.docker(['rm', id]);
        try { await this.inspect(id); refuse('CLEANUP_FAILED'); } catch (error) { if (!isAbsentContainer(id, error)) throw error; }
        await writeFile(join(this.directory, 'cleanup.json'), JSON.stringify({ id, nonce: this.nonce, removed: true, absenceConfirmed: true, state: stopped.State }), { mode: 0o600 });
      } finally {
        this.#process?.stdin.destroy(); this.#process?.stdout.destroy(); this.#process?.stderr.destroy();
        if (this.#process?.exitCode === null && this.#process.signalCode === null) this.#process.kill('SIGKILL');
        if (this.#exited) { let timer: ReturnType<typeof setTimeout> | undefined; try {
          const exit = await Promise.race([this.#exited, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('Docker CLI cleanup deadline')), 2000); })]);
          await writeFile(join(this.directory, 'cli-exit.json'), JSON.stringify(exit), { mode: 0o600 });
        } finally { clearTimeout(timer); } }
      }
      await exitChild(this.host, this.nonce); this.#cleanupComplete = true;
    } finally {
      await setDirectoryTreeMode(join(this.directory, 'candidate'), 0o755).catch(() => {});
    }
  }
}
