import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { parseJsonRpcMessage, type JsonRpcMessage } from '@earendil-works/pi-mcp';
import type { DispatchPermit, OperationRecord } from '@loopwright/state';
import { digestArtifact, type ArtifactRef } from '@loopwright/core';
import { canonical, digest, object } from './boundary.js';
import { parseBoundedJson } from './context.js';
import { Candidate } from './candidate.js';
import { McpProcess, type McpProcessPort } from './mcp-process.js';
import { guardLocalOperation, recordLocalOperation } from './operation.js';
import { stateValue } from './admission.js';
import { PiFailure, refuse } from './errors.js';
import type { PiHost, PiOpenInput, PiErrorCode } from './types.js';
import type { ToolIdentity } from './tools.js';
export interface McpIdentity extends ToolIdentity { readonly parentRequestId: string }
interface Pending {
  readonly key: string; readonly message: JsonRpcMessage; readonly reply: (message: JsonRpcMessage) => Promise<void>;
  readonly identity: McpIdentity | null; readonly signal: AbortSignal; readonly abort: () => void;
  readonly operation: OperationRecord | null; readonly permit: DispatchPermit | null;
  readonly expected: { readonly path: string; readonly digest: string } | null;
  timer: ReturnType<typeof setTimeout>; idle: ReturnType<typeof setTimeout>; progress: number; sent: boolean; ended: boolean;
}
const rpcKey = (id: unknown): string => { if (typeof id !== 'string' && (typeof id !== 'number' || !Number.isSafeInteger(id)) || typeof id === 'string' && (id.length < 1 || id.length > 128)) refuse('MCP_FAILED', '', { phase: 'tool' }); return typeof id + ':' + String(id); };
export interface McpPorts { readonly process: () => McpProcessPort }
/** Native MCP JSON-RPC is data. Only a bound owner-approved call can dispatch a candidate read. */
export class Mcp {
  readonly #pending = new Map<string, Pending>(); readonly #used = new Set<string>(); readonly #abort = new AbortController();
  #responseBytes = 0; readonly #receiving = new Set<Promise<void>>();
  readonly #process: McpProcessPort; #ready: Promise<void> | null = null; #closed = false; #failed = false; #closing: Promise<void> | null = null;
  constructor(readonly host: PiHost, readonly input: PiOpenInput, readonly candidate: Candidate, readonly fault: (code: PiErrorCode) => void, ports?: McpPorts) {
    this.#process = ports?.process() ?? new McpProcess(host, input, join(host.directory, 'mcp-' + input.sessionId), candidate.root);
    this.#process.on('message', message => {
      const bytes = Buffer.byteLength(canonical(message)); if (this.#responseBytes + bytes > input.policy.limits.pendingResponseBytes || this.#receiving.size >= 32) { this.#fail('OUTPUT_LIMIT'); return; } this.#responseBytes += bytes;
      const work = this.#receive(message).catch(error => this.#fail(error instanceof PiFailure ? error.detail.code : 'MCP_FAILED')).finally(() => { this.#responseBytes -= bytes; this.#receiving.delete(work); }); this.#receiving.add(work);
    });
    this.#process.on('failed', () => this.#fail('MCP_FAILED'));
  }
  #fail(code: PiErrorCode): void {
    if (this.#failed || this.#closed) return; this.#failed = true; this.#abort.abort();
    for (const pending of this.#pending.values()) { clearTimeout(pending.timer); clearTimeout(pending.idle); pending.signal.removeEventListener('abort', pending.abort); if (pending.operation) this.host.store.markOperationUnresolved(this.host.authority, pending.operation.intent.operationId, 'connection_lost'); }
    this.#pending.clear(); this.fault(code); void this.#process.close().catch(() => { this.fault('CLEANUP_FAILED'); });
  }
  async send(identity: McpIdentity | null, bytes: Uint8Array, signal: AbortSignal, reply: (message: JsonRpcMessage) => Promise<void>, onOperation: (id: string) => void | Promise<void>): Promise<void> {
    if (!this.input.policy.mcp.names.length || this.#closed || this.#failed || signal.aborted || bytes.length > 65536 || this.#pending.size >= 32 || this.#used.size >= this.input.policy.limits.operations) refuse('MCP_FAILED', '', { phase: 'tool' });
    let value: JsonRpcMessage; try { value = parseJsonRpcMessage(parseBoundedJson(new TextDecoder('utf-8', { fatal: true }).decode(bytes))); } catch { refuse('MCP_FAILED', '', { phase: 'tool' }); }
    if (!('method' in value)) refuse('MCP_FAILED', '', { phase: 'tool' });
    const allowed = ['initialize', 'tools/list', 'tools/call', 'notifications/initialized', 'notifications/cancelled']; if (!allowed.includes(value.method)) refuse('TOOL_DENIED', '', { phase: 'tool' });
    if (!('id' in value) && value.method === 'notifications/cancelled') { this.cancel((value.params as { requestId?: unknown } | undefined)?.requestId); return; }
    if (!('id' in value) && value.method !== 'notifications/initialized' || 'id' in value && value.method.startsWith('notifications/')) refuse('MCP_FAILED', '', { phase: 'tool' });
    this.#ready ??= this.#process.ready(AbortSignal.any([this.#abort.signal, AbortSignal.timeout(10000)])); await this.#ready;
    if (!('id' in value)) {
      const current = () => { signal.throwIfAborted(); if (this.#failed || this.#closed) refuse('MCP_FAILED', '', { phase: 'tool' }); stateValue(this.host.store.renew(this.host.authority), 'tool'); };
      await this.#process.send(value, current, { identity: null, operation: null, permit: null, before: null, signal, assertCurrent: current, receive: message => this.#receive(message) }); return;
    }
    const key = rpcKey(value.id); if (this.#used.has(key)) refuse('MCP_FAILED', '', { phase: 'tool' }); this.#used.add(key);
    let operation: OperationRecord | null = null, permit: DispatchPermit | null = null, expected: Pending['expected'] = null, before: ArtifactRef | null = null;
    if (value.method === 'tools/call') {
      if (!identity || identity.name !== 'mcp__workspace__read_file' || !this.input.policy.mcp.names.includes(identity.name)) refuse('TOOL_DENIED', '', { phase: 'tool' });
      const params = object(value.params, Object.keys(value.params ?? {})); if (Object.keys(params).some(name => !['name', 'arguments', '_meta'].includes(name)) || params.name !== 'read_file') refuse('TOOL_DENIED', '', { phase: 'tool' });
      const args = object(params.arguments, ['path']); if (typeof args.path !== 'string') refuse('TOOL_DENIED', '', { phase: 'tool' });
      const file = await this.candidate.checkRead(args.path); expected = { path: file.path, digest: file.ref.digest.hex }; before = file.ref;
      const view = stateValue(this.host.store.inspect(), 'tool'); if (view.counts.operations >= this.input.policy.limits.operations) refuse('OUTPUT_LIMIT', '', { phase: 'tool' });
      const operationId = 'tool-' + digest(Buffer.from(canonical({ sessionId: this.input.sessionId, parent: identity.parentRequestId, callId: identity.callId, name: identity.name }))).hex.slice(0, 32), existing = this.host.store.getOperation(operationId);
      if (existing.ok) refuse('RECOVERY_REQUIRED', '', { phase: 'tool' }); if (existing.error.code !== 'RECORD_NOT_FOUND') stateValue(existing, 'tool');
      await onOperation(operationId);
      const intent = { operationId, nodeId: this.input.stepId, attemptId: 'mcp-attempt-' + randomBytes(12).toString('hex'), effect: 'read_only' as const, targetIdentity: 'candidate:' + file.path,
        requestDigest: digest(Buffer.from('loopwright.dev/pi-mcp/v1\0' + canonical({ identity: { ...identity, slot: digest(Buffer.from(identity.slot)) }, wire: value, before: file.ref, policy: digest(Buffer.from(canonical(this.input.policy))), runtime: this.input.policy.runtime, lock: this.input.lock.spec.lockHash }))) };
      const created = stateValue(this.host.store.putIntent(this.host.authority, intent), 'tool'); if (created.kind !== 'created') refuse('RECOVERY_REQUIRED', '', { phase: 'tool' });
      const granted = stateValue(this.host.store.authorizeOperationDispatch(this.host.authority, operationId), 'tool'); if (granted.kind !== 'new_dispatch') refuse('RECOVERY_REQUIRED', '', { phase: 'tool' }); operation = granted.record; permit = granted.permit;
    } else if (identity) refuse('TOOL_DENIED', '', { phase: 'tool' });
    const view = stateValue(this.host.store.inspect(), 'tool'), remaining = view.clock.remainingTaskMs.safeValue; if (!remaining || remaining <= 0) refuse('DEADLINE', '', { phase: 'tool' });
    const absolute = Math.min(remaining, this.input.policy.mcp.absoluteTimeoutSeconds * 1000), idle = this.input.policy.mcp.idleTimeoutSeconds * 1000;
    const pending: Pending = { key, message: value, reply, identity, signal, operation, permit, expected, sent: false, ended: false, progress: 0,
      abort: () => this.#fail('CANCELLED'), timer: setTimeout(() => this.#fail('DEADLINE'), absolute), idle: setTimeout(() => this.#fail('MCP_FAILED'), idle) };
    this.#pending.set(key, pending); signal.addEventListener('abort', pending.abort, { once: true });
    const current = () => { if (signal.aborted || this.#closed || this.#failed) refuse('MCP_FAILED', '', { phase: 'tool' }); if (operation && permit) guardLocalOperation(this.host, operation, permit, signal, this.#closed); else stateValue(this.host.store.renew(this.host.authority), 'tool'); };
    try { await this.#process.send(value, () => { if (pending.sent) refuse('MCP_FAILED', '', { phase: 'tool' }); current(); pending.sent = true; },
      { identity, operation, permit, before, signal, assertCurrent: current, receive: message => this.#receive(message) }); }
    catch (error) { this.#fail(error instanceof PiFailure ? error.detail.code : 'MCP_FAILED'); throw error; }
  }
  async #receive(message: JsonRpcMessage): Promise<void> {
    if (this.#closed || this.#failed) return;
    if ('method' in message) {
      if (message.method !== 'notifications/progress' || 'id' in message) refuse('MCP_FAILED', '', { phase: 'tool' });
      const params = object(message.params, Object.keys(message.params ?? {})), token = params.progressToken;
      const matches = [...this.#pending.values()].filter(pending => ((pending.message as { params?: { _meta?: { progressToken?: unknown } } }).params?._meta?.progressToken) === token && token !== undefined);
      if (matches.length !== 1) refuse('MCP_FAILED', '', { phase: 'tool' }); const pending = matches[0]!, bytes = Buffer.byteLength(canonical(message));
      if (pending.ended || bytes > 4096 || (pending.progress += bytes) > 65536) refuse('OUTPUT_LIMIT', '', { phase: 'tool' });
      clearTimeout(pending.idle); pending.idle = setTimeout(() => this.#fail('MCP_FAILED'), this.input.policy.mcp.idleTimeoutSeconds * 1000); await pending.reply(message); return;
    }
    const pending = this.#pending.get(rpcKey(message.id)); if (!pending || !pending.sent || pending.ended) refuse('MCP_FAILED', '', { phase: 'tool' }); pending.ended = true; clearTimeout(pending.idle); clearTimeout(pending.timer); pending.signal.removeEventListener('abort', pending.abort);
    const bytes = Buffer.byteLength(canonical(message)); if (bytes > this.input.policy.limits.toolResultBytes) refuse('OUTPUT_LIMIT', '', { phase: 'tool' });
    if (pending.operation) {
      let outcome: 'succeeded' | 'failed' = 'failed';
      if ('result' in message) {
        const result = object(message.result, Object.keys(message.result as object));
        if (!result.isError) {
          const content = result.content as { type: string; text: string }[]; if (!Array.isArray(content) || content.length !== 1 || content[0]?.type !== 'text' || typeof content[0].text !== 'string') refuse('MCP_FAILED', '', { phase: 'tool' });
          const ref = digestArtifact(pending.expected!.path, Buffer.from(content[0].text)); if (!ref.ok || ref.value.digest.hex !== pending.expected!.digest) refuse('PAYLOAD_MISMATCH', '', { phase: 'tool' }); outcome = 'succeeded';
        }
      }
      await recordLocalOperation(this.host, pending.operation, outcome, { parentRequestId: pending.identity!.parentRequestId, parentCallId: pending.identity!.parentId, callId: pending.identity!.callId, tool: pending.identity!.name, target: pending.operation.intent.targetIdentity, resultDigest: digest(Buffer.from(canonical(message))), rpcId: message.id });
    }
    this.#pending.delete(pending.key); await pending.reply(message);
  }
  cancel(id: unknown): void { const key = rpcKey(id); if (this.#pending.has(key)) this.#fail('CANCELLED'); else if (!this.#used.has(key)) this.#fail('MCP_FAILED'); }
  close(): Promise<void> { if (this.#closing) return this.#closing; this.#closed = true; this.#abort.abort(); for (const pending of this.#pending.values()) { clearTimeout(pending.timer); clearTimeout(pending.idle); pending.signal.removeEventListener('abort', pending.abort); if (pending.operation) this.host.store.markOperationUnresolved(this.host.authority, pending.operation.intent.operationId, 'cancellation'); } this.#pending.clear(); this.#closing = this.#process.close().then(async () => { await Promise.allSettled([...this.#receiving]); }); return this.#closing; }
}
