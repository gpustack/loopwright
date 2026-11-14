import { readFile, stat } from 'node:fs/promises';
import { join, isAbsolute } from 'node:path';
import { validateRuntime, sameIdentity } from './policy.js';
import { snapshot, object, freeze, id, text, digest } from './boundary.js';
import { prepareInput } from './preflight.js';
import { PiFailure, refuse, result } from './errors.js';
import { canonicalDirectory, RuntimeSession } from './session-host.js';
import { Sender } from './sender.js';
import { Execution } from './execution.js';
import { Mcp, type McpPorts } from './mcp.js';
import { eventSequence } from './event-sequence.js';
import { Events } from './events.js';
import { ExecutionLease } from './execution-lease.js';
import { ExecutionGuard } from './execution-guard.js';
import { recoverSnapshot } from './recovery.js';
import { captureCheckpoint } from './capture.js';
import { selectedCatalog } from './catalog.js';
import type { RuntimeBroker } from './provider.js';
import type { PiAdapter, PiHost, PiOpenInput, PiCapabilities, PiCommand, PiOutcome, PiResult, PiEvent, PiError } from './types.js';
import type { StateError } from '@loopwright/state';
interface Session {
  start(): Promise<PiCapabilities>;
  command(kind: 'execute' | 'compact', input: unknown): Promise<unknown>;
  close(): Promise<void>;
  capture?(sink: (bytes: Uint8Array) => Promise<void>): Promise<void>;
}
export interface LeasePort {
  release(): Promise<void>;
}
export interface FactoryPorts {
  readonly mcp?: (host: PiHost, input: PiOpenInput) => McpPorts;
  readonly sender?: (host: PiHost, input: PiOpenInput) => Sender;
  readonly lease?: (host: PiHost, input: PiOpenInput) => Promise<LeasePort>;
  readonly execution?: (host: PiHost, input: PiOpenInput, candidate: string) => Execution;
  readonly environment: (host: PiHost) => Promise<void>;
  readonly session: (host: PiHost, input: PiOpenInput, sender: RuntimeBroker, directory: string) => Session;
}
function stateFailure(error: StateError): never {
  refuse(error.commit === 'unknown' ? 'RECOVERY_REQUIRED' : (error.code.startsWith('OWNER_') || error.code === 'STALE_OWNER') ? 'AUTHORITY_REFUSED' : 'STATE_REFUSED', '', {
    phase: 'admission', retryable: error.retryable, effect: error.commit === 'unknown' ? 'possible' : 'none', stateErrorCode: error.code });
}
function cleanupFailure(error: unknown): PiError {
  return error instanceof PiFailure ? freeze({ ...error.detail, phase: 'cleanup' }) : freeze({ code: 'CLEANUP_FAILED', path: '', phase: 'cleanup', retryable: false, effect: 'none', requestId: null, operationId: null, stateErrorCode: null });
}
async function environment(host: PiHost): Promise<void> {
  try {
    await canonicalDirectory(host.directory); await canonicalDirectory(host.artifactsDirectory);
    if (!isAbsolute(host.dockerExecutable) || !(await stat(host.dockerExecutable)).isFile() || !isAbsolute(host.dockerSocket) || !(await stat(host.dockerSocket)).isSocket()) refuse('CONTAINMENT_UNAVAILABLE');
  } catch { refuse('CONTAINMENT_UNAVAILABLE'); }
}
/** Internal dependency injection only; absent from package exports. */
export async function constructAdapter(unownedHost: PiHost, input: unknown, ports: FactoryPorts): Promise<PiResult<PiAdapter>> {
  return result(async () => {
    const owned = prepareInput(input);
    const data = object(unownedHost, ['store', 'authority', 'directory', 'artifactsDirectory', 'dockerExecutable', 'dockerSocket', 'runtime', 'resolveCredential'], '/host');
    if (typeof data.resolveCredential !== 'function') refuse('INPUT_INVALID', '/host/resolveCredential');
    const runtime = validateRuntime(snapshot(data.runtime), '/host/runtime');
    if (!sameIdentity(runtime, owned.policy.runtime)) refuse('RUNTIME_MISMATCH', '/policy/runtime');
    for (const name of ['directory', 'artifactsDirectory'] as const) if (typeof data[name] !== 'string' || (/[,\r\n]/.test(data[name]) || data[name].includes('\0'))) refuse('INPUT_INVALID', '/host/' + name);
    const host: PiHost = { store: data.store as PiHost['store'], authority: freeze(snapshot(data.authority)) as unknown as PiHost['authority'],
      directory: text(data.directory, '/host/directory'), artifactsDirectory: text(data.artifactsDirectory, '/host/artifactsDirectory'),
      dockerExecutable: text(data.dockerExecutable, '/host/dockerExecutable'), dockerSocket: text(data.dockerSocket, '/host/dockerSocket'), runtime: freeze(runtime),
      resolveCredential: (data.resolveCredential as PiHost['resolveCredential']).bind(unownedHost) };
    const viewed = host.store.inspect(); if (!viewed.ok) stateFailure(viewed.error);
    const view = viewed.value;
    if (view.runId !== owned.lock.spec.runId || !sameIdentity(view.lockHash, owned.lock.spec.lockHash) || view.binding.resourceVersion !== owned.policy.resourceVersion || !view.binding.adapters.some(item => item.id === 'pi' && item.version === '0.0.0')) refuse('BINDING_MISMATCH', '/host/store');
    if (view.counts.dispatchedRequests || view.counts.unresolvedRequests || view.counts.unresolvedOperations || view.ledger.violations.length) refuse('RECOVERY_REQUIRED', '/host/store');
    if (view.clockStatus !== 'trusted' || view.owner.mode !== 'active') refuse('RECOVERY_REQUIRED', '/host/store');
    if ((view.clock.remainingTaskMs.safeValue ?? 0) <= 0) refuse('DEADLINE', '/host/store');
    const restored = recoverSnapshot(host, owned);
    if (owned.policy.mcp.names.length && !sameIdentity(digest(await readFile(new URL('./workspace-mcp.js', import.meta.url))), owned.policy.mcp.scriptDigest)) refuse('RUNTIME_MISMATCH', '/policy/mcp/scriptDigest');
    const catalog = selectedCatalog(owned); await ports.environment(host);
    const lease = await (ports.lease ? ports.lease(host, owned) : ExecutionLease.acquire(host, owned));
    let sequencing: Awaited<ReturnType<typeof eventSequence>>; try { sequencing = await eventSequence(host, owned, restored?.sequence ?? 0); } catch (error) { await lease.release(); throw error; }
    const sender = ports.sender?.(host, owned) ?? new Sender(host, owned, { fetch: globalThis.fetch, catalog });
    const candidateDirectory = join(host.directory, 'sdk-' + owned.sessionId, 'candidate');
    const execution = ports.execution ? ports.execution(host, owned, candidateDirectory) : new Execution(host, owned, candidateDirectory); sender.installTools(execution);
    const session = ports.session(host, owned, sender, join(host.directory, 'sdk-' + owned.sessionId));
    const mcp = new Mcp(host, owned, execution.candidate, code => sender.runtimeFault(code), ports.mcp?.(host, owned));
    const cleanupRoles = async () => { const results = await Promise.allSettled([execution.close(), mcp.close(), session.close()]); if (results.some(item => item.status === 'rejected')) refuse('CLEANUP_FAILED', '', { phase: 'cleanup' }); };
    sender.installMcp(mcp, () => { void stopEvents().catch(() => {}); });
    let closed = false, cleanupComplete = false, fatal: StateError | null = null; const guard = new ExecutionGuard();
    let stopEvents: () => Promise<void> = async () => { guard.revoke(); sender.cancel(); await cleanupRoles(); events.close(); };
    const events = new Events(owned, () => stopEvents(), () => { sender.cancel('EVENT_OVERFLOW'); void stopEvents().catch(() => {}); }); events.restoreSequence(sequencing.sequence, sequencing.persist); sender.installEvents((kind, fields) => events.push(kind, fields));
    let lastProgress: PiOutcome | null = null, safeCapture = restored !== null;
    let activeCommand: { outcome: PiOutcome | null } | null = null;
    const renewTimer = setInterval(() => {
      const renewed = host.store.renew(host.authority);
      if (!renewed.ok) { fatal = renewed.error; guard.revoke(); sender.cancel('AUTHORITY_REFUSED'); clearInterval(renewTimer); void (async () => { await events.push('cancellation', { code: 'AUTHORITY_REFUSED' }).catch(() => {}); await stopEvents(); })().catch(() => {}); }
    }, Math.max(250, Math.min(1000, Math.floor(view.policy.leaseMs / 3)))); renewTimer.unref();
    let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
    const scheduleDeadline = () => {
      const current = host.store.inspect(), remaining = current.ok && current.value.clockStatus === 'trusted' ? current.value.clock.remainingTaskMs.safeValue : null;
      if (remaining !== null && remaining > 0) { deadlineTimer = setTimeout(scheduleDeadline, Math.min(remaining, 2147483647)); deadlineTimer.unref(); return; }
      guard.revoke(); sender.cancel(remaining === null ? 'AUTHORITY_REFUSED' : 'DEADLINE'); clearInterval(renewTimer);
      void (async () => { await events.push('cancellation', { code: remaining === null ? 'AUTHORITY_REFUSED' : 'DEADLINE' }).catch(() => {}); await stopEvents(); })().catch(() => {});
    }; scheduleDeadline();
    let facts: PiCapabilities;
    try {
      facts = freeze(await session.start());
      if (owned.candidate.baseline) {
        await execution.candidate.captureBaselineStats();
      }
      if (fatal) stateFailure(fatal);
    }
    catch (error) { clearInterval(renewTimer); clearTimeout(deadlineTimer); await cleanupRoles(); await lease.release(); if (error instanceof PiFailure) throw error; refuse('CONTAINMENT_UNAVAILABLE'); }
    const ready = () => { if (fatal) stateFailure(fatal); if (closed) refuse('CANCELLED', '', { phase: 'session' }); };
    let shutdownWork: Promise<PiResult<{ readonly closed: true }>> | null = null;
    const shutdown = (): Promise<PiResult<{ readonly closed: true }>> => shutdownWork ??= result(async () => {
      closed = true; guard.revoke(); sender.cancel();
      try { if (!cleanupComplete) { await cleanupRoles(); cleanupComplete = true; await events.push('process_exit').catch(() => {}); } }
      catch { refuse('CLEANUP_FAILED', '', { phase: 'cleanup' }); }
      finally { clearInterval(renewTimer); clearTimeout(deadlineTimer); events.close(); }
      return Object.freeze({ closed: true as const });
    });
    const close = async (): Promise<PiResult<{ readonly closed: true }>> => {
      const stopped = await shutdown(); await guard.drain(); if (stopped.ok) return result(async () => { try { await lease.release(); } catch (error) { throw new PiFailure(cleanupFailure(error)); } return stopped.value; }); return stopped;
    };
    stopEvents = async () => { const stopped = await close(); if (!stopped.ok) refuse(stopped.error.code, stopped.error.path, stopped.error); };
    try { await events.push('resource_identity', { digest: facts.policyDigest }); }
    catch (error) { await close(); throw error; }
    const exclusive = <T>(action: () => Promise<T>, onCleanupFailure?: (value: T, error: PiError) => T): Promise<PiResult<T>> => result(async () => {
      let value: T;
      try { value = await guard.run(action); }
      catch (error) { if (closed && cleanupComplete) await lease.release(); throw error; }
      if (closed && cleanupComplete) {
        try { await lease.release(); }
        catch (error) {
          const detail = cleanupFailure(error);
          if (onCleanupFailure) return onCleanupFailure(value, detail); throw new PiFailure(detail);
        }
      }
      return value;
    });
    const dispatch = (kind: 'execute' | 'compact', command: unknown): Promise<PiResult<PiOutcome>> => exclusive(async () => {
      ready(); sender.begin(kind, command); safeCapture = false;
      const executing: { outcome: PiOutcome | null } = { outcome: null }; activeCommand = executing;
      try {
        try { await session.command(kind, command); }
        catch (error) { sender.cancel(error instanceof PiFailure ? error.detail.code : 'PROVIDER_RESPONSE_INVALID'); }
        let outcome = sender.finish();
        if (fatal) outcome = freeze({ ...outcome, status: 'recovery_required', error: outcome.error ? { ...outcome.error, stateErrorCode: outcome.error.stateErrorCode ?? fatal.code } : { code: 'AUTHORITY_REFUSED', path: '', phase: 'admission', retryable: fatal.retryable, effect: outcome.requestIds.length ? 'possible' : 'none', requestId: outcome.requestIds.at(-1) ?? null, operationId: null, stateErrorCode: fatal.code } });
        if (sender.outboundObserved) facts = freeze({ ...facts, outboundObserved: owned.policy.selection });
        try { await events.push('settled', { count: outcome.requestIds.length, code: outcome.error?.code ?? null }); }
        catch { outcome = freeze({ ...outcome, status: outcome.status === 'execution_settled' ? 'failed' : outcome.status, error: outcome.error ?? { code: 'EVENT_OVERFLOW', path: '', phase: 'session', retryable: false, effect: outcome.requestIds.length ? 'possible' : 'none', requestId: outcome.requestIds.at(-1) ?? null, operationId: null, stateErrorCode: null } }); }
        if (outcome.status !== 'execution_settled') {
          const stopped = await shutdown(); outcome = freeze({ ...outcome, status: stopped.ok ? outcome.status : 'recovery_required', localCleanup: stopped.ok ? 'complete' : 'failed', cleanupError: stopped.ok ? null : stopped.error });
        } else { safeCapture = true; outcome = freeze({ ...outcome, localCleanup: 'complete' }); }
        executing.outcome = outcome; lastProgress = outcome; return outcome;
      } finally { if (activeCommand === executing) activeCommand = null; }
    }, (outcome, error) => { lastProgress = freeze({ ...outcome, status: 'recovery_required', localCleanup: 'failed', cleanupError: error }); return lastProgress; });
    return Object.freeze({ capabilities: () => facts,
      execute: (command: PiCommand) => dispatch('execute', command), compact: (command: { readonly commandId: string }) => dispatch('compact', command),
      events: (): AsyncIterable<PiEvent> => events.iterator(),
      cancel: async (command: { readonly reason: 'operator' | 'deadline' | 'consumer_disconnected' }): Promise<PiResult<PiOutcome>> => result(async () => {
        const item = object(command, ['reason']); if (!['operator', 'deadline', 'consumer_disconnected'].includes(item.reason as string)) refuse('INPUT_INVALID');
        const active = activeCommand, progress = sender.progress(), prior = active ? null : lastProgress;
        guard.revoke(); sender.cancel(item.reason === 'deadline' ? 'DEADLINE' : 'CANCELLED'); await events.push('cancellation', { code: item.reason === 'deadline' ? 'DEADLINE' : 'CANCELLED' }).catch(() => {});
        const stopped = await close();
        const finalView = host.store.inspect(), unresolved = !finalView.ok || finalView.value.counts.unresolvedRequests > 0 || finalView.value.counts.dispatchedRequests > 0 || finalView.value.counts.unresolvedOperations > 0;
        const outcome = active ? active.outcome ?? progress : prior;
        return freeze({ ...(outcome ?? { requestIds: [], operationIds: [], providerTermination: 'none' as const, usage: 'none' as const, error: null }), status: !stopped.ok || unresolved || outcome?.providerTermination === 'unknown' ? 'recovery_required' as const : outcome?.status ?? 'cancelled' as const, localCleanup: stopped.ok ? 'complete' as const : 'failed' as const, cleanupError: stopped.ok ? null : stopped.error });
      }),
      capture: async (command: { readonly checkpointId: string }) => exclusive(async () => {
        ready(); const item = object(command, ['checkpointId']), checkpointId = id(item.checkpointId, '/checkpointId');
        if (!safeCapture) refuse('REQUEST_REFUSED', '', { phase: 'restore' }); if (!session.capture) refuse('CAPABILITY_UNSUPPORTED', '', { phase: 'restore' });
        try { return freeze(await captureCheckpoint(host, owned, execution.candidate, { capture: sink => session.capture!(sink) }, checkpointId, events.sequence, guard.signal)); }
        catch (error) { if (error instanceof PiFailure && ['RECOVERY_REQUIRED', 'BINDING_MISMATCH', 'RESOURCE_MISMATCH', 'CLEANUP_FAILED', 'OUTPUT_LIMIT'].includes(error.detail.code)) { safeCapture = false; await shutdown(); } throw error; }
      }), close });
  });
}
export function openPiAdapter(host: PiHost, input: unknown): Promise<PiResult<PiAdapter>> {
  return constructAdapter(host, input, runtimePorts);
}
/** Private ports shared with executable qualifications; absent from package exports. */
export const runtimePorts: FactoryPorts = { environment, session: (owner, owned, sender, directory) => new RuntimeSession(owner, owned, sender, directory) };
