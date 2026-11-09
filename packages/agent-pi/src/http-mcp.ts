import { EventEmitter } from 'node:events';
import http from 'node:http';
import https from 'node:https';
import { checkServerIdentity, rootCertificates } from 'node:tls';
import { isIP } from 'node:net';
import { randomBytes } from 'node:crypto';
import { StreamableHttpTransport, parseJsonRpcMessage, type JsonRpcMessage } from '@earendil-works/pi-mcp';
import type { DispatchPermit, OperationRecord } from '@loopwright/state';
import { canonical, digest, object } from './boundary.js';
import { parseBoundedJson } from './context.js';
import { stateValue } from './admission.js';
import { guardLocalOperation, recordLocalOperation } from './operation.js';
import { sameIdentity } from './policy.js';
import { validateHttpEndpoint } from './policy-v2.js';
import { WORKSPACE_TOOL } from './workspace-mcp.js';
import { PiFailure } from './errors.js';
import type { McpDispatchContext, McpProcessPort } from './mcp-process.js';
import type { PiHost, PiOpenInput } from './types.js';
import type { HttpMcpPolicy, McpCredentialBinding, PiErrorV2, PiHostV2 } from './types-v2.js';

/** Private qualification ports. Public factories supply no trust/connection override. */
export interface HttpMcpPorts {
  readonly ca?: readonly string[];
  readonly selectAddress?: (approved: readonly string[]) => string;
  readonly observeDial?: (address: string) => void;
  readonly beforeWrite?: (context: McpDispatchContext) => void;
  readonly observePeer?: (actual: string | undefined) => string | undefined;
}
export class HttpMcpFailure extends Error {
  constructor(readonly detail: PiErrorV2, readonly authStatus: number | null = null) { super(detail.code); }
}
function failure(code: PiErrorV2['code'], effect: PiErrorV2['effect'] = 'possible', authStatus: number | null = null): HttpMcpFailure {
  return new HttpMcpFailure({ code, path: '/policy/mcp', phase: 'tool', retryable: false, effect,
    requestId: null, operationId: null, stateErrorCode: null }, authStatus);
}
const key = (value: JsonRpcMessage): string => 'id' in value ? typeof value.id + ':' + String(value.id) : 'notification:' + value.method;
interface Exchange {
  readonly message: JsonRpcMessage;
  readonly context: McpDispatchContext;
  readonly guard: () => void;
  readonly operation: OperationRecord;
  readonly permit: DispatchPermit;
  readonly management: boolean;
  readonly signal: AbortSignal;
  posted: boolean;
  received: boolean;
  recorded: boolean;
  delivery: Promise<void> | null;
}

/** The native HTTP transport is host-side; the SDK still uses its real owner-mediated MCP client. */
export class HttpMcpProcess extends EventEmitter implements McpProcessPort {
  readonly #transport: StreamableHttpTransport;
  readonly #pending = new Map<string, Exchange>();
  readonly #used = new Set<string>();
  readonly #sending = new Set<Promise<void>>();
  readonly #connections = new Set<Promise<void>>();
  readonly #abort = new AbortController();
  readonly #instance = randomBytes(16).toString('hex');
  #tail = Promise.resolve();
  #closed = false;
  #failed = false;
  #closing: Promise<null> | null = null;
  constructor(readonly host: PiHost, readonly input: PiOpenInput, readonly policy: HttpMcpPolicy,
    readonly resolveCredential: PiHostV2['resolveMcpCredential'], readonly onFailure: (error: PiErrorV2) => void,
    readonly ports: HttpMcpPorts = {}) {
    super();
    validateHttpEndpoint(policy.endpoint, policy.approvedAddresses);
    this.#transport = new StreamableHttpTransport({ url: policy.endpoint, openGetStream: false, maxMessageBytes: 65536,
      reconnect: { maxRetries: 0 }, fetch: (url, options) => this.#fetch(url, options) });
    this.#transport.onMessage(message => {
      const exchange = this.#pending.get(key(message));
      if (!exchange || exchange.received || !exchange.posted) { this.#fault(failure('MCP_FAILED')); return; }
      exchange.received = true;
      exchange.delivery = this.#receive(message, exchange);
      void exchange.delivery.catch(error => this.#fault(error));
    });
    this.#transport.onError(error => this.#fault(error));
  }
  #fault(error: unknown): void {
    if (this.#closed || this.#failed) return;
    this.#failed = true;
    this.onFailure(error instanceof HttpMcpFailure ? error.detail : failure('MCP_FAILED').detail);
  }
  async ready(signal: AbortSignal): Promise<void> { signal.throwIfAborted(); if (this.#closed || this.#failed) throw failure('MCP_FAILED'); await this.#transport.start(); }
  #check(exchange: Exchange): void {
    if (this.#closed || this.#failed || exchange.signal.aborted) throw failure('CANCELLED', exchange.posted ? 'possible' : 'none');
    exchange.context.assertCurrent();
    guardLocalOperation(this.host, exchange.operation, exchange.permit, exchange.signal, this.#closed);
    if (exchange.operation.intent.effect !== 'read_only' || exchange.operation.intent.nodeId !== this.input.stepId) throw failure('TOOL_DENIED', 'none');
    const identity = exchange.context.identity;
    if (!identity) { if (!exchange.management || exchange.operation.intent.targetIdentity !== this.policy.endpoint) throw failure('TOOL_DENIED', 'none'); return; }
    if (identity.name !== 'mcp__workspace__read_file' || !this.policy.names.includes(identity.name) || !exchange.context.before) throw failure('TOOL_DENIED', 'none');
    if (exchange.operation.intent.targetIdentity !== 'candidate:' + exchange.context.before.name) throw failure('TOOL_DENIED', 'none');
    const parent = stateValue(this.host.store.getRequest(identity.parentRequestId), 'tool');
    if (parent.state !== 'observed' || parent.initialObservation?.termination !== 'confirmed' || parent.initialObservation.outcome !== 'succeeded'
      || parent.admission.roleId !== this.input.roleId || parent.admission.nodeId !== this.input.stepId) throw failure('TOOL_DENIED', 'none');
    const expected = digest(Buffer.from('loopwright.dev/pi-mcp/v1\0' + canonical({ identity: { ...identity, slot: digest(Buffer.from(identity.slot)) },
      wire: exchange.message, before: exchange.context.before, policy: digest(Buffer.from(canonical(this.input.policy))), runtime: this.input.policy.runtime, lock: this.input.lock.spec.lockHash })));
    if (!sameIdentity(exchange.operation.intent.requestDigest, expected)) throw failure('PAYLOAD_MISMATCH', 'none');
  }
  send(message: JsonRpcMessage, guard: () => void, context?: McpDispatchContext): Promise<void> {
    const work = this.#tail.then(() => this.#send(message, guard, context));
    this.#tail = work.catch(() => {}); this.#sending.add(work);
    void work.then(() => this.#sending.delete(work), () => this.#sending.delete(work));
    return work;
  }
  async #send(message: JsonRpcMessage, guard: () => void, context?: McpDispatchContext): Promise<void> {
    if (!context || this.#closed || this.#failed || this.#pending.size >= 32 || this.#used.size >= this.input.policy.limits.operations
      || !('method' in message) || !['initialize', 'tools/list', 'tools/call', 'notifications/initialized'].includes(message.method)) throw failure('MCP_FAILED', 'none');
    const rpcKey = key(message);
    if (this.#used.has(rpcKey)) throw failure('RECOVERY_REQUIRED', 'none');
    this.#used.add(rpcKey); context.assertCurrent();
    const management = message.method !== 'tools/call';
    let operation = context.operation, permit = context.permit;
    if (management) {
      if (context.identity || operation || permit) throw failure('TOOL_DENIED', 'none');
      const operationId = 'mcp-http-' + digest(Buffer.from(canonical({ instance: this.#instance, session: this.input.sessionId, message }))).hex.slice(0, 40);
      const intent = { operationId, nodeId: this.input.stepId, attemptId: 'mcp-http-' + this.#instance, effect: 'read_only' as const,
        requestDigest: digest(Buffer.from(canonical({ message, policy: this.policy, lock: this.input.lock.spec.lockHash }))), targetIdentity: this.policy.endpoint };
      const created = stateValue(this.host.store.putIntent(this.host.authority, intent), 'tool');
      if (created.kind !== 'created') throw failure('RECOVERY_REQUIRED', 'none');
      const granted = stateValue(this.host.store.authorizeOperationDispatch(this.host.authority, operationId), 'tool');
      if (granted.kind !== 'new_dispatch') throw failure('RECOVERY_REQUIRED', 'none');
      operation = granted.record; permit = granted.permit;
    }
    if (!operation || !permit) throw failure('TOOL_DENIED', 'none');
    const signal = AbortSignal.any([context.signal, this.#abort.signal, AbortSignal.timeout(this.policy.absoluteTimeoutSeconds * 1000)]);
    const exchange: Exchange = { message, context, guard, operation, permit, management, signal, posted: false, received: false, recorded: false, delivery: null };
    this.#pending.set(rpcKey, exchange);
    try {
      this.#check(exchange);
      await this.#transport.send(message, { signal });
      if (exchange.delivery) await exchange.delivery;
      if (!('id' in message)) { await recordLocalOperation(this.host, operation, 'succeeded', { transport: 'sessionless-http-json-v1', method: message.method, endpoint: this.policy.endpoint }); exchange.recorded = true; }
      else if (!exchange.received) throw failure('MCP_FAILED');
    } catch (error) {
      const detail = error instanceof HttpMcpFailure ? error : error instanceof PiFailure ? new HttpMcpFailure(error.detail) : failure(signal.aborted ? 'CANCELLED' : 'MCP_FAILED', exchange.posted ? 'possible' : 'none');
      this.onFailure(detail.detail);
      if (!exchange.recorded) {
        if (detail.authStatus !== null && 'id' in message && !management) {
          await context.receive({ jsonrpc: '2.0', id: message.id, error: { code: -32001, message: 'MCP_AUTHENTICATION_REQUIRED' } }); exchange.recorded = true;
        } else if (!exchange.posted || detail.authStatus !== null) {
          await recordLocalOperation(this.host, operation, exchange.posted ? 'failed' : 'not_executed', { transport: 'sessionless-http-json-v1', code: detail.detail.code, status: detail.authStatus }); exchange.recorded = true;
        } else this.host.store.markOperationUnresolved(this.host.authority, operation.intent.operationId, signal.aborted ? 'cancellation' : 'connection_lost');
      }
      this.#failed = true; this.#abort.abort(); throw detail;
    } finally { this.#pending.delete(rpcKey); }
  }
  async #receive(message: JsonRpcMessage, exchange: Exchange): Promise<void> {
    if ('method' in message) throw failure('MCP_TRANSPORT_UNSUPPORTED');
    if ('result' in message && 'method' in exchange.message) {
      if (exchange.message.method === 'initialize') {
        const init = object(message.result, ['protocolVersion', 'capabilities', 'serverInfo']);
        if (init.protocolVersion !== '2025-06-18' || canonical(init.capabilities) !== '{"tools":{}}') throw failure('MCP_TRANSPORT_UNSUPPORTED');
        const info = object(init.serverInfo, ['name', 'version']);
        if (typeof info.name !== 'string' || info.name.length > 64 || typeof info.version !== 'string' || info.version.length > 32) throw failure('MCP_FAILED');
        this.#transport.setProtocolVersion(init.protocolVersion);
      }
      if (exchange.message.method === 'tools/list' && canonical(message.result) !== canonical({ tools: [WORKSPACE_TOOL] })) throw failure('MCP_TRANSPORT_UNSUPPORTED');
    }
    if (exchange.management) {
      await recordLocalOperation(this.host, exchange.operation, 'error' in message ? 'failed' : 'succeeded', {
        transport: 'sessionless-http-json-v1', endpoint: this.policy.endpoint, resultDigest: digest(Buffer.from(canonical(message))),
      }); exchange.recorded = true;
    }
    await exchange.context.receive(message);
    if (!exchange.management) exchange.recorded = true;
  }
  async #token(exchange: Exchange): Promise<string> {
    this.#check(exchange);
    const parent = exchange.context.identity ? stateValue(this.host.store.getRequest(exchange.context.identity.parentRequestId), 'tool') : null;
    const signal = AbortSignal.any([exchange.signal, AbortSignal.timeout(1000)]);
    signal.throwIfAborted();
    const binding: McpCredentialBinding = { serverId: 'workspace', transport: this.policy.transport, destinationRef: this.policy.destinationRef,
      endpoint: this.policy.endpoint, method: 'POST', credentialRef: this.policy.credentialRef, runId: this.input.lock.spec.runId, roleId: this.input.roleId,
      stepId: this.input.stepId, purpose: parent?.admission.purpose ?? null, parentRequestId: parent?.admission.requestId ?? null,
      managementOperationId: exchange.management ? exchange.operation.intent.operationId : null, notAfterMonotonicMs: exchange.permit.notAfterMonotonicMs, signal };
    const value = await new Promise<unknown>((resolve, reject) => {
      const abort = () => reject(failure('MCP_AUTHENTICATION_REQUIRED', 'none'));
      signal.addEventListener('abort', abort, { once: true });
      Promise.resolve().then(() => this.resolveCredential(binding)).then(resolve, () => reject(failure('MCP_AUTHENTICATION_REQUIRED', 'none'))).finally(() => signal.removeEventListener('abort', abort));
    });
    signal.throwIfAborted(); this.#check(exchange);
    const fields = object(value, ['bearerToken']);
    if (typeof fields.bearerToken !== 'string' || fields.bearerToken.length > 4096 || !/^[A-Za-z0-9._~+/-]+=*$/.test(fields.bearerToken)) throw failure('MCP_AUTHENTICATION_REQUIRED', 'none');
    return fields.bearerToken;
  }
  async #fetch(url: string | URL | Request, options?: RequestInit): Promise<Response> {
    const target = url instanceof Request ? url.url : String(url);
    if (target !== this.policy.endpoint || options?.method !== 'POST' || typeof options.body !== 'string' || Buffer.byteLength(options.body) > 65536) throw failure('MCP_TRANSPORT_UNSUPPORTED', 'none');
    const body = Buffer.from(options.body), message = parseJsonRpcMessage(parseBoundedJson(body.toString()));
    const exchange = this.#pending.get(key(message));
    if (!exchange || canonical(message) !== canonical(exchange.message) || exchange.posted) throw failure('PAYLOAD_MISMATCH', 'none');
    const endpoint = validateHttpEndpoint(target, this.policy.approvedAddresses);
    const address = this.ports.selectAddress?.(this.policy.approvedAddresses) ?? this.policy.approvedAddresses[0]!;
    if (!this.policy.approvedAddresses.includes(address)) throw failure('TOOL_DENIED', 'none');
    const token = await this.#token(exchange);
    const headers = new Headers(options.headers);
    for (const [name, value] of headers) if (!['accept', 'content-type', 'mcp-protocol-version'].includes(name) || /[\r\n]/.test(value)) throw failure('MCP_TRANSPORT_UNSUPPORTED', 'none');
    this.#check(exchange);
    const signal = AbortSignal.any([exchange.signal, ...(options.signal ? [options.signal] : [])]);
    return this.#request(endpoint, address, headers, body, token, signal, exchange);
  }
  #request(endpoint: URL, address: string, headers: Headers, body: Buffer, token: string, signal: AbortSignal, exchange: Exchange): Promise<Response> {
    return new Promise((resolve, reject) => {
      this.ports.observeDial?.(address);
      let ended = false, idle: ReturnType<typeof setTimeout>;
      const fail = (error: unknown) => { if (ended) return; ended = true; clearTimeout(idle); request.destroy(); reject(error instanceof HttpMcpFailure ? error : error instanceof PiFailure ? new HttpMcpFailure(error.detail) : failure(signal.aborted ? 'CANCELLED' : 'MCP_FAILED', exchange.posted ? 'possible' : 'none')); };
      const rearm = () => { clearTimeout(idle); idle = setTimeout(() => fail(failure('DEADLINE')), this.policy.idleTimeoutSeconds * 1000); };
      const request = (endpoint.protocol === 'https:' ? https : http).request({ protocol: endpoint.protocol, hostname: endpoint.hostname, port: endpoint.port,
        path: endpoint.pathname, method: 'POST', agent: false, family: isIP(address), maxHeaderSize: 8192, signal,
        lookup: (_hostname, _options, callback) => callback(null, address, isIP(address)), headers: Object.fromEntries(headers),
        ...(endpoint.protocol === 'https:' ? { rejectUnauthorized: true, servername: endpoint.hostname, checkServerIdentity,
          ca: this.ports.ca ? [...this.ports.ca] : [...rootCertificates] } : {}) }, response => {
        const status = response.statusCode;
        rearm();
        if (status === 401 || status === 403) { response.destroy(); fail(failure('MCP_AUTHENTICATION_REQUIRED', 'confirmed', status)); return; }
        if (status !== 200 && status !== 202 || response.headers['mcp-session-id'] || response.headers.location
          || status === 200 && response.headers['content-type']?.split(';')[0]?.trim() !== 'application/json') {
          response.destroy(); fail(failure('MCP_TRANSPORT_UNSUPPORTED')); return;
        }
        const chunks: Buffer[] = []; let size = 0;
        response.on('data', (part: Buffer) => { rearm(); if ((size += part.length) > 65536) { response.destroy(); fail(failure('OUTPUT_LIMIT')); } else chunks.push(part); });
        response.on('error', fail);
        response.on('end', () => {
          try {
            if (ended) return;
            const bytes = Buffer.concat(chunks, size);
            const decoded = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
            const forms = new Set([token, JSON.stringify(token).slice(1, -1), encodeURIComponent(token), Buffer.from(token).toString('base64')]);
            if ([...forms].some(value => decoded.includes(value))) { fail(failure('MCP_FAILED')); return; }
            if (status === 202 && bytes.length) { fail(failure('MCP_TRANSPORT_UNSUPPORTED')); return; }
            if (status === 200) {
              const parsed = parseJsonRpcMessage(parseBoundedJson(decoded));
              if ('method' in parsed || !('id' in exchange.message) || key(parsed) !== key(exchange.message)) { fail(failure('PAYLOAD_MISMATCH')); return; }
            }
            const reply = new Response(status === 202 ? null : bytes, { status: status, headers: status === 200 ? { 'content-type': 'application/json' } : {} });
            ended = true; clearTimeout(idle); resolve(reply);
          } catch (error) { fail(error); }
        });
      });
      const disconnected = new Promise<void>(resolve => request.once('close', resolve));
      this.#connections.add(disconnected); void disconnected.then(() => this.#connections.delete(disconnected));
      request.on('error', fail); rearm();
      request.once('socket', socket => {
        socket.once(endpoint.protocol === 'https:' ? 'secureConnect' : 'connect', () => {
          try {
            const peer = this.ports.observePeer ? this.ports.observePeer(socket.remoteAddress) : socket.remoteAddress;
            if (!this.policy.approvedAddresses.includes(peer ?? '')) throw failure('TOOL_DENIED', 'none');
            this.ports.beforeWrite?.(exchange.context); this.#check(exchange); exchange.guard();
            request.setHeader('authorization', 'Bearer ' + token); exchange.posted = true; request.end(body);
          } catch (error) { fail(error); }
        });
      });
    });
  }
  close(): Promise<null> {
    return this.#closing ??= (async () => {
      this.#closed = true; this.#abort.abort(); await this.#transport.close();
      let timer: ReturnType<typeof setTimeout> | undefined;
      try { await Promise.race([Promise.allSettled([...this.#sending, ...this.#connections]), new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(failure('CLEANUP_FAILED')), 1000); })]); }
      finally { clearTimeout(timer); }
      return null;
    })();
  }
}
