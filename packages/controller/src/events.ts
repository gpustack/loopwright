import { constants } from 'node:fs';
import { open, link, unlink, lstat } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import type { ArtifactRef, Digest } from '@loopwright/core';
import type { LocalRunStore } from '@loopwright/state';
import { CODES, refuse, type ControllerDiagnostic } from './errors.js';
import { canonical, freeze, hash, id, integer, record, same, text } from './schema.js';
import { checkedRef, stateValue, type ArtifactStore } from './storage.js';
import { readBoundedFile } from './files.js';
import { parsePrivateJson } from './parser.js';
export interface ControllerEvent {
  readonly version: 1; readonly sequence: number; readonly runId: string; readonly lockHash: Digest;
  readonly nodeId: string | null; readonly attemptId: string | null; readonly stage: 'admission' | 'waiting' | 'role' | 'verification' | 'repair' | 'drain' | 'terminal' | 'gate_waiting' | 'publication';
  readonly code: string | null; readonly budget: { readonly admittedCalls: number; readonly formatRepairs: number; readonly implementationRepairs: number; readonly transportRetries: number; readonly chargedTokens: string; readonly remainingTokens: string };
  readonly deadlineMonotonicMs: string; readonly references: readonly ArtifactRef[];
  readonly gate: null | { readonly operationId: string; readonly gateId: string; readonly elapsedMs: number; readonly nextPollMs: number; readonly deadlineMs: number };
}
/** Append public-safe observations during work. Finalization seals the same inode without copying its body. */
export class ControllerEvents {
  #sequence: number; #bytes = 0; #queued = 0; #queueBytes = 0; #failed = false; #closed = false; #terminal = false;
  #tail: Promise<void> = Promise.resolve(); readonly #heartbeat: NodeJS.Timeout; readonly #hash = createHash('sha256');
  #file: Awaited<ReturnType<typeof open>> | null = null; #initializationFailed = false; #release: (() => void) | null = null; #sealing: Promise<ArtifactRef> | null = null;
  readonly #path: string; readonly #ready: Promise<void>;
  constructor(readonly store: LocalRunStore, readonly artifacts: ArtifactStore, readonly sink: ((event: ControllerEvent) => Promise<void>) | undefined, readonly stop: () => void, sequence = 0, readonly terminalRecovery = false) {
    this.#sequence = integer(sequence, 0, Number.MAX_SAFE_INTEGER); this.#path = join(artifacts.directory, 'controller-events.open');
    this.#ready = this.#initialize(sequence).catch(() => { this.#initializationFailed = true; this.#failed = true; this.stop(); });
    this.#heartbeat = setInterval(() => { void this.push('waiting', null).catch(() => this.stop()); }, 30000); this.#heartbeat.unref();
  }
  async #initialize(sequence: number): Promise<void> {
    await this.artifacts.owner.assertCurrent(); this.#release = await this.artifacts.owner.holdLocalActivity();
    let file: Awaited<ReturnType<typeof open>>;
    try {
      if (sequence > 0) { try { await lstat(this.#path); } catch { refuse('RECOVERY_REQUIRED', '', 'recovery'); } }
      file = await open(this.#path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_APPEND | constants.O_NOFOLLOW, 0o600);
    }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      const before = await lstat(this.#path), bytes = await readBoundedFile(this.#path, 4194304, true), view = stateValue(this.store.inspect());
      this.artifacts.vault.assertClean(bytes); if (bytes.length && bytes.at(-1) !== 10) refuse('RECOVERY_REQUIRED', '', 'recovery');
      let count = 0;
      for (const line of bytes.length ? bytes.subarray(0, -1).toString().split('\n') : []) {
        const row0: unknown = parsePrivateJson(Buffer.from(line), 4096), hasGate = Object.hasOwn(row0 as object, 'gate'), row = record(row0, ['version', 'sequence', 'runId', 'lockHash', 'nodeId', 'attemptId', 'stage', 'code', 'budget', 'deadlineMonotonicMs', 'references', ...(hasGate ? ['gate' as const] : [])]);
        if (Buffer.byteLength(line) + 1 > 4096 || canonical(row) !== line || row.version !== 1 || row.sequence !== ++count || row.runId !== view.runId || !same(row.lockHash, view.lockHash)
          || row.deadlineMonotonicMs !== view.clock.basis.taskDeadlineMonotonicMs || !['admission', 'waiting', 'role', 'verification', 'repair', 'drain', 'terminal', 'gate_waiting', 'publication'].includes(text(row.stage)) || this.#terminal || row.stage === 'terminal' && !this.terminalRecovery
          || row.code !== null && !CODES.includes(row.code as ControllerDiagnostic['code'])) refuse('RECOVERY_REQUIRED', '', 'recovery');
        if (row.nodeId !== null) id(row.nodeId); if (row.attemptId !== null) id(row.attemptId);
        if (row.stage === 'terminal') this.#terminal = true;
        if (row.gate !== null && row.gate !== undefined) { const detail = record(row.gate, ['operationId', 'gateId', 'elapsedMs', 'nextPollMs', 'deadlineMs']); id(detail.operationId); text(detail.gateId, '', 128); integer(detail.elapsedMs, 0, Number.MAX_SAFE_INTEGER); integer(detail.nextPollMs, 0, 600000); integer(detail.deadlineMs, 0, Number.MAX_SAFE_INTEGER); }
        const budget = record(row.budget, ['admittedCalls', 'formatRepairs', 'implementationRepairs', 'transportRetries', 'chargedTokens', 'remainingTokens']);
        for (const key of ['admittedCalls', 'formatRepairs', 'implementationRepairs', 'transportRetries']) integer(budget[key], 0, 1024);
        for (const key of ['chargedTokens', 'remainingTokens']) if (!/^(?:0|[1-9][0-9]{0,39})$/.test(text(budget[key]))) refuse('RECOVERY_REQUIRED', '', 'recovery');
        if (!Array.isArray(row.references) || row.references.length > 16) refuse('RECOVERY_REQUIRED', '', 'recovery'); row.references.forEach(checkedRef);
      }
      if (count < sequence || bytes.length > 4190208) refuse('RECOVERY_REQUIRED', '', 'recovery'); this.#sequence = count; this.#bytes = bytes.length; this.#hash.update(bytes);
      file = await open(this.#path, constants.O_WRONLY | constants.O_APPEND | constants.O_NOFOLLOW);
      const current = await file.stat(); if (current.dev !== before.dev || current.ino !== before.ino || current.size !== bytes.length || current.nlink !== 1 || current.mode & 0o077) { await file.close(); refuse('RECOVERY_REQUIRED', '', 'recovery'); }
    }
    this.#file = file;
    const parent = await open(this.artifacts.directory, constants.O_RDONLY | constants.O_NOFOLLOW); try { await parent.sync(); } finally { await parent.close(); }
  }
  async ready(): Promise<void> { await this.#ready; if (this.#initializationFailed) refuse('RECOVERY_REQUIRED', '', 'recovery'); }
  get hasTerminal(): boolean { return this.#terminal; }
  get sequence(): number { return this.#sequence; }
  async push(stage: ControllerEvent['stage'], code: ControllerDiagnostic['code'] | null, nodeId: string | null = null, attemptId: string | null = null, refs: readonly ArtifactRef[] = [], gate: ControllerEvent['gate'] = null): Promise<void> {
    await this.#ready;
    if (this.#initializationFailed || this.#closed || this.#failed && stage !== 'terminal' || stage === 'terminal' && this.#terminal) refuse('OUTPUT_LIMIT', '', 'execution');
    const view = stateValue(this.store.inspect()), ledger = view.ledger;
    const event: ControllerEvent = freeze({ version: 1, sequence: this.#sequence + 1, runId: id(view.runId), lockHash: view.lockHash, nodeId: nodeId === null ? null : id(nodeId), attemptId: attemptId === null ? null : id(attemptId), stage, code,
      budget: { admittedCalls: ledger.admittedCalls, formatRepairs: ledger.formatRepairs, implementationRepairs: ledger.implementationRepairs, transportRetries: ledger.transportRetries, chargedTokens: ledger.chargedTokens.decimal, remainingTokens: ledger.remainingTokens.decimal },
      deadlineMonotonicMs: view.clock.basis.taskDeadlineMonotonicMs, references: refs.map(checkedRef), gate });
    const bytes = Buffer.from(canonical(event) + '\n'); this.artifacts.vault.assertClean(bytes);
    const terminal = stage === 'terminal', fail = () => { this.#failed = true; this.stop(); refuse('OUTPUT_LIMIT', '', 'execution'); };
    if (bytes.length > 4096 || refs.length > 16 || this.#queued >= (terminal ? 128 : 127) || this.#queueBytes + bytes.length > (terminal ? 524288 : 520192) || this.#bytes + bytes.length > (terminal ? 4194304 : 4190208)) return fail();
    this.#sequence++; this.#terminal ||= terminal; this.#bytes += bytes.length; this.#queued++; this.#queueBytes += bytes.length;
    const work = this.#tail.then(async () => {
      await this.artifacts.owner.assertCurrent(); const held = await this.#file!.stat(), path = await lstat(this.#path);
      if (held.dev !== path.dev || held.ino !== path.ino || held.nlink !== 1 || path.mode & 0o077) refuse('ARTIFACT_INVALID', '', 'execution');
      await this.#file!.writeFile(bytes); await this.#file!.sync(); this.#hash.update(bytes);
      if (!this.sink || this.#failed) return; let timer: NodeJS.Timeout;
      try { await Promise.race([this.sink(event), new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('backpressure')), 1000); })]); }
      catch { this.#failed = true; this.stop(); refuse('OUTPUT_LIMIT', '', 'execution'); }
      finally { clearTimeout(timer!); }
    }).catch(error => { this.#failed = true; this.stop(); throw error; }).finally(() => { this.#queued--; this.#queueBytes -= bytes.length; });
    this.#tail = work.catch(() => {}); return work;
  }
  close(): Promise<ArtifactRef> { return this.#sealing ??= this.#seal(); }
  async #seal(): Promise<ArtifactRef> {
    clearInterval(this.#heartbeat); this.#closed = true; await this.#ready; await this.#tail;
    if (this.#initializationFailed || !this.#file) refuse('RECOVERY_REQUIRED', '', 'finalization');
    await this.#file.sync(); const info = await this.#file.stat(); await this.#file.close(); this.#file = null;
    if (info.size !== this.#bytes || info.nlink !== 1) refuse('RECOVERY_REQUIRED', '', 'finalization');
    const digest: Digest = { algorithm: 'sha256', hex: this.#hash.digest('hex') }, name = 'events-' + hash('loopwright.dev/controller/artifact/events/v1\0' + digest.hex).hex + '.bin';
    const ref: ArtifactRef = { name, digest, byteLength: this.#bytes }, target = join(this.artifacts.directory, name);
    // link is no-overwrite; the original is removed only after the new exact inode is proven.
    await this.artifacts.owner.assertCurrent(); await link(this.#path, target); const sealed = await lstat(target);
    if (sealed.ino !== info.ino || sealed.dev !== info.dev || sealed.nlink !== 2) refuse('RECOVERY_REQUIRED', '', 'finalization'); await unlink(this.#path);
    const parent = await open(this.artifacts.directory, constants.O_RDONLY | constants.O_NOFOLLOW); try { await parent.sync(); } finally { await parent.close(); }
    await this.artifacts.read(ref, 4194304); this.#release?.(); this.#release = null; return ref;
  }
}
