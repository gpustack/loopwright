import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import type { DispatchPermit, OperationIntent, OperationRecord, Page, PageCursor } from '@loopwright/state';
import { Candidate, type CandidateChange } from './candidate.js';
import { ToolProcess, type ToolProcessPort, type ToolProcessReply } from './tool-process.js';
import { parseBoundedJson } from './context.js';
import { canonical, digest, object, integer, freeze } from './boundary.js';
import { stateValue } from './admission.js';
import { PiFailure, refuse } from './errors.js';
import { guardLocalOperation, recordLocalOperation } from './operation.js';
import { isExternalMcpToolName } from './external-mcp.js';
import type { PiHost, PiOpenInput } from './types.js';
import { clampToolResultBytes, type ToolExecutor, type ToolIdentity, type ToolResult } from './tools.js';
export interface AdmittedToolIdentity extends ToolIdentity { readonly parentRequestId: string; readonly nativeParentAdmitted?: true }
export interface ExternalMcpExecutorPort {
  hasTool(name: string): boolean;
  targetIdentityFor(name: string): string | null;
  callTool(
    name: string,
    args: Readonly<Record<string, unknown>>,
    options: { readonly signal?: AbortSignal | undefined; readonly maxResultBytes: number },
  ): Promise<ToolResult>;
}
export interface ExecutionPorts {
  readonly process: (operationId: string, signal: AbortSignal) => ToolProcessPort;
  readonly mcpExecutor?: ExternalMcpExecutorPort | undefined;
  readonly softScopeErrors?: boolean | undefined;
}
/** Serial owner mutations and one disposable tool container at a time. Scratch never promotes itself. */
export class Execution implements ToolExecutor {
  readonly candidate: Candidate; readonly #abort = new AbortController();
  #pending = 0; #closed = false; #unresolved = false; #tail: Promise<void> = Promise.resolve(); #active: ToolProcessPort | null = null;
  readonly #seen = new Set<string>(); readonly #ports: ExecutionPorts; readonly #softScopeErrors: boolean;
  constructor(readonly host: PiHost, readonly input: PiOpenInput, candidate: string, ports?: ExecutionPorts) {
    this.candidate = new Candidate(candidate, input);
    this.#ports = ports ?? { process: (operationId, signal) => new ToolProcess(host, input, join(host.directory, 'tool-' + operationId), candidate, operationId, signal) };
    this.#softScopeErrors = ports?.softScopeErrors === true;
  }
  invoke(identity: AdmittedToolIdentity, bytes: Uint8Array, signal: AbortSignal, onOperation: (id: string) => void): Promise<ToolResult> {
    if (this.#closed || this.#pending >= 32 || this.#seen.size >= this.input.policy.limits.operations) refuse('OUTPUT_LIMIT', '', { phase: 'tool' });
    const allowedLocal = ['read', 'bash', 'write', 'edit', 'delete'].includes(identity.name);
    const allowedExternalMcp = isExternalMcpToolName(identity.name) && this.#ports.mcpExecutor?.hasTool(identity.name) === true;
    if (!this.input.policy.tools.includes(identity.name) || (!allowedLocal && !allowedExternalMcp) || identity.parentId !== null && identity.nativeParentAdmitted !== true) refuse('TOOL_DENIED', '', { phase: 'tool' });
    if (bytes.byteLength > this.input.policy.limits.toolArgsBytes) refuse('OUTPUT_LIMIT', '', { phase: 'tool' });
    const ownedBytes = Buffer.from(bytes), args = this.#arguments(identity.name, ownedBytes);
    const operationId = 'tool-' + digest(Buffer.from(canonical({ runId: this.input.lock.spec.runId, sessionId: this.input.sessionId, parent: identity.parentRequestId, invocation: identity.invocation, callId: identity.callId, name: identity.name }))).hex.slice(0, 32);
    if (this.#seen.has(operationId)) refuse('RECOVERY_REQUIRED', '', { phase: 'tool', operationId }); this.#seen.add(operationId); this.#pending++;
    const combined = AbortSignal.any([signal, this.#abort.signal]);
    const action = this.#tail.then(() => this.#run(identity, operationId, args, ownedBytes, combined, onOperation));
    this.#tail = action.then(() => {}, () => {});
    return action.finally(() => { this.#pending--; });
  }
  #arguments(name: string, bytes: Uint8Array): Record<string, unknown> {
    let value: unknown; try { value = parseBoundedJson(new TextDecoder('utf-8', { fatal: true }).decode(bytes), { nodes: 262144, array: 4096, properties: 512 }); } catch { refuse('TOOL_DENIED', '/arguments', { phase: 'tool' }); }
    if (!value || typeof value !== 'object' || Array.isArray(value)) refuse('TOOL_DENIED', '/arguments', { phase: 'tool' });
    const keys = Object.keys(value);
    if (isExternalMcpToolName(name)) {
      return object(value, keys);
    }
    if (name === 'edit') {
      const isArrayForm = keys.every(key => key === 'path' || key === 'edits') && keys.includes('edits');
      const isShorthandForm = !keys.includes('edits')
        && keys.every(key => key === 'path' || key === 'oldText' || key === 'newText')
        && keys.includes('oldText')
        && keys.includes('newText');
      if (!isArrayForm && !isShorthandForm) refuse('TOOL_DENIED', '/arguments', { phase: 'tool' });
      const args = object(value, keys);
      if (typeof args.path !== 'string' || !args.path) refuse('TOOL_DENIED', '/path', { phase: 'tool' });
      if (isShorthandForm) {
        if (typeof args.oldText !== 'string' || typeof args.newText !== 'string') {
          refuse('TOOL_DENIED', '/arguments', { phase: 'tool' });
        }
        return { path: args.path, edits: [{ oldText: args.oldText, newText: args.newText }] };
      }
      if (!Array.isArray(args.edits)) refuse('TOOL_DENIED', '/arguments', { phase: 'tool' });
      return args;
    }
    const allowed = name === 'read' ? ['path', 'offset', 'limit'] : name === 'bash' ? ['command', 'timeout'] : name === 'write' ? ['path', 'content'] : ['path'];
    if (keys.some(key => !allowed.includes(key))) refuse('TOOL_DENIED', '/arguments', { phase: 'tool' });
    const args = object(value, keys); if (name === 'bash') {
      if (typeof args.command !== 'string' || !args.command || args.command.includes('\0')) refuse('TOOL_DENIED', '/command', { phase: 'tool' });
      const maxTimeoutSec = Math.max(60, Math.ceil(this.input.policy.limits.toolWallMs / 1000));
      if (args.timeout !== undefined) integer(args.timeout, 1, maxTimeoutSec, '/timeout');
    } else {
      if (typeof args.path !== 'string' || !args.path) refuse('TOOL_DENIED', '/path', { phase: 'tool' });
      if (name === 'write' && typeof args.content !== 'string') refuse('TOOL_DENIED', '/arguments', { phase: 'tool' });
      if (name === 'read') for (const key of ['offset', 'limit']) if (args[key] !== undefined) integer(args[key], 1, Number.MAX_SAFE_INTEGER, '/' + key);
    }
    return args;
  }
  #guard(record: OperationRecord, permit: DispatchPermit, signal: AbortSignal): void {
    guardLocalOperation(this.host, record, permit, signal, this.#closed);
  }
  async #run(identity: AdmittedToolIdentity, operationId: string, args: Record<string, unknown>, bytes: Uint8Array, signal: AbortSignal, onOperation: (id: string) => void): Promise<ToolResult> {
    signal.throwIfAborted();
    if (this.#unresolved) refuse('RECOVERY_REQUIRED', '', { phase: 'tool', operationId });
    const view = stateValue(this.host.store.inspect(), 'tool'); stateValue(this.host.store.renew(this.host.authority), 'tool');
    if (view.counts.unresolvedOperations > 0) {
      let cursor: PageCursor | null = null;
      do {
        const page: Page<OperationRecord> = stateValue(this.host.store.listOperations({ limit: 100, cursor }), 'tool');
        if (page.items.some(item => item.state === 'unresolved')) {
          this.#unresolved = true;
          refuse('RECOVERY_REQUIRED', '', { phase: 'tool', operationId });
        }
        cursor = page.next;
      } while (cursor !== null);
    }
    const existing = this.host.store.getOperation(operationId); if (existing.ok) refuse('RECOVERY_REQUIRED', '', { phase: 'tool', operationId }); if (existing.error.code !== 'RECORD_NOT_FOUND') stateValue(existing, 'tool');
    if (view.counts.operations >= this.input.policy.limits.operations) refuse('OUTPUT_LIMIT', '', { phase: 'tool' });
    const remaining = view.clock.remainingTaskMs.safeValue; if (remaining === null || remaining <= 0) refuse('DEADLINE', '', { phase: 'tool' });
    const timeout = AbortSignal.timeout(Math.min(remaining, this.input.policy.limits.toolWallMs)), combined = AbortSignal.any([signal, timeout]);
    let change: CandidateChange | null = null, read: { path: string; digest: string } | null = null, softError: { readonly targetPath: string; readonly message: string } | null = null;
    if (identity.name === 'read') {
      const inspected = await this.candidate.inspectReadTarget(args.path as string);
      if (inspected.kind === 'error') softError = inspected;
      else read = { path: inspected.path, digest: inspected.ref.digest.hex };
    } else if (identity.name === 'write') {
      if (this.#softScopeErrors) {
        const prepared = await this.candidate.tryPrepareWrite(args.path as string, args.content as string, { softScopeError: true });
        if (prepared.kind === 'error') softError = prepared;
        else change = prepared.change;
      } else {
        change = await this.candidate.prepareWrite(args.path as string, args.content as string);
      }
    } else if (identity.name === 'edit') {
      const prepared = await this.candidate.tryPrepareEdit(args.path as string, args.edits, { softScopeError: this.#softScopeErrors });
      if (prepared.kind === 'error') softError = prepared;
      else change = prepared.change;
    } else if (identity.name === 'delete') {
      const prepared = await this.candidate.tryPrepareDelete(args.path as string, { softScopeError: this.#softScopeErrors });
      if (prepared.kind === 'error') softError = prepared;
      else change = prepared.change;
    }
    const isExternalMcp = isExternalMcpToolName(identity.name);
    let process: ToolProcessPort | null = null, authorized: OperationRecord | null = null, effect = false, cleanup = true;
    let result: ToolResult = { content: [], details: null }, failure: unknown = null, container: Awaited<ReturnType<ToolProcessPort['close']>> = null;
    try {
      if (!softError && (identity.name === 'read' || identity.name === 'bash')) { process = this.#ports.process(operationId, combined); this.#active = process; await process.ready(); }
      combined.throwIfAborted();
      const targetIdentity = isExternalMcp
        ? (this.#ports.mcpExecutor?.targetIdentityFor(identity.name) ?? ('mcp:' + identity.name))
        : identity.name === 'bash'
          ? 'scratch:' + this.input.sessionId
          : 'candidate:' + (softError?.targetPath ?? change?.path ?? read!.path);
      const requestDigest = digest(Buffer.from('loopwright.dev/pi-tool/v1\0' + canonical({ identity: { ...identity, slot: digest(Buffer.from(identity.slot)) }, argumentsDigest: digest(bytes), lock: this.input.lock.spec.lockHash, policy: digest(Buffer.from(canonical(this.input.policy))), runtime: this.input.policy.runtime, targetIdentity, before: change?.before ?? null, after: change?.after ?? null, ...(change?.deleted ? { deleted: true } : {}) })));
      const intent: OperationIntent = { operationId, nodeId: this.input.stepId, attemptId: 'tool-attempt-' + randomBytes(12).toString('hex'), effect: (identity.name === 'read' || isExternalMcp || softError !== null) ? 'read_only' : 'local_write', requestDigest, targetIdentity };
      onOperation(operationId); const written = stateValue(this.host.store.putIntent(this.host.authority, intent), 'tool');
      if (written.kind !== 'created') refuse('RECOVERY_REQUIRED', '', { phase: 'tool', operationId });
      const dispatch = stateValue(this.host.store.authorizeOperationDispatch(this.host.authority, operationId), 'tool'); if (dispatch.kind !== 'new_dispatch') refuse('RECOVERY_REQUIRED', '', { phase: 'tool', operationId }); authorized = dispatch.record;
      const guard = () => { this.#guard(dispatch.record, dispatch.permit, combined); effect = true; };
      if (softError) {
        guard();
        result = clampToolResultBytes(
          { content: [{ type: 'text', text: softError.message }], isError: true, details: null },
          this.input.policy.limits.toolResultBytes,
          { tool: 'read' },
        );
      } else if (change) {
        const ref = await this.candidate.commit(change, guard);
        result = change.deleted || ref === null
          ? { content: [{ type: 'text', text: 'Deleted scoped candidate file: ' + change.path }], details: { operationId, deleted: change.path } }
          : { content: [{ type: 'text', text: 'Committed scoped candidate change: ' + ref.name }], details: { operationId, artifact: ref } };
      } else if (isExternalMcp) {
        guard();
        const rawMcp = await this.#ports.mcpExecutor!.callTool(identity.name, args, {
          signal: combined,
          maxResultBytes: this.input.policy.limits.toolResultBytes,
        });
        result = clampToolResultBytes(rawMcp, this.input.policy.limits.toolResultBytes, { tool: 'bash' });
      } else {
        const reply: ToolProcessReply = await process!.execute(identity.name as 'read' | 'bash', bytes, read, guard); result = reply.result;
        if (reply.code !== null) refuse(reply.code, '', { phase: 'tool', effect: effect ? 'possible' : 'none', operationId });
      }
    } catch (error) { failure = error; }
    finally {
      if (process) { try { container = await process.close(); } catch (error) { cleanup = false; failure = error; } }
      this.#active = null;
    }
    if (failure && change && effect) {
      cleanup = false;
    }
    if (authorized && cleanup) {
      if (container && container.exitCode !== 0) failure ??= new Error('Owned worker exited unsuccessfully');
      const outcome = failure ? effect ? 'failed' : 'not_executed' : result.isError ? 'failed' : 'succeeded';
      try { await this.#record(authorized, identity, outcome, change, result, container); }
      catch (error) { failure = error; cleanup = false; }
    }
    if (failure) {
      if (authorized && !cleanup) {
        this.#unresolved = true;
        this.host.store.markOperationUnresolved(this.host.authority, operationId, combined.aborted ? 'cancellation' : 'connection_lost');
      }
      if (change && effect) refuse('RECOVERY_REQUIRED', '', { phase: 'tool', effect: 'possible', operationId, stateErrorCode: failure instanceof PiFailure ? failure.detail.stateErrorCode : null });
      if (failure instanceof PiFailure && cleanup) throw new PiFailure({ ...failure.detail, effect: effect ? 'possible' : failure.detail.effect, operationId });
      refuse(!cleanup ? 'RECOVERY_REQUIRED' : combined.aborted ? 'CANCELLED' : 'TOOL_DENIED', '', { phase: 'tool', effect: effect ? 'possible' : 'none', operationId, stateErrorCode: failure instanceof PiFailure ? failure.detail.stateErrorCode : null });
    }
    const wrapped = freeze({ ...result, details: { operationId, native: result.details } });
    if (Buffer.byteLength(canonical(wrapped)) > this.input.policy.limits.toolResultBytes) refuse('OUTPUT_LIMIT', '', { phase: 'tool', operationId });
    return wrapped;
  }
  async #record(record: OperationRecord, identity: AdmittedToolIdentity, outcome: 'succeeded' | 'failed' | 'not_executed', change: CandidateChange | null, result: ToolResult, container: Awaited<ReturnType<ToolProcessPort['close']>>): Promise<void> {
    await recordLocalOperation(this.host, record, outcome, { parentRequestId: identity.parentRequestId, parentCallId: identity.parentId, callId: identity.callId, tool: identity.name, target: record.intent.targetIdentity,
      before: change?.before?.digest ?? null, after: outcome === 'succeeded' ? change?.after ?? null : null, deleted: outcome === 'succeeded' && change?.deleted === true, resultDigest: digest(Buffer.from(canonical(result))), container });
  }
  async close(): Promise<void> { this.#closed = true; this.#abort.abort(); try { if (this.#active) await this.#active.close(); } finally { await this.#tail; } }
}
