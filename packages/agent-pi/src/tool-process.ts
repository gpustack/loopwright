import { Channel, type ChannelMessage } from './protocol.js';
import { OwnedContainer, type ContainerExit } from './containers.js';
import { canonical, object, list, integer } from './boundary.js';
import { PiFailure, refuse } from './errors.js';
import type { PiHost, PiOpenInput, PiErrorCode } from './types.js';
import type { ToolResult } from './tools.js';
export interface ToolProcessReply { readonly result: ToolResult; readonly code: PiErrorCode | null; readonly produced: number }
export interface ToolProcessPort {
  ready(): Promise<void>;
  execute(name: 'read' | 'bash', bytes: Uint8Array, read: { readonly path: string; readonly digest: string } | null, guard: () => void): Promise<ToolProcessReply>;
  close(): Promise<ContainerExit | null>;
}
/** Host-only control for a single contained native tool invocation. */
export class ToolProcess implements ToolProcessPort {
  readonly container: OwnedContainer; #channel: Channel | null = null; #closing = false; #broken = false;
  #pending: { kind: string; resolve: (value: unknown) => void; reject: (error: Error) => void } | null = null;
  #bootWork: Promise<void> | null = null;
  readonly #abort: () => void;
  constructor(readonly host: PiHost, readonly input: PiOpenInput, readonly directory: string, candidate: string, operationId: string, readonly signal: AbortSignal) {
    this.container = new OwnedContainer(host, input, directory, candidate, 'tool', operationId);
    this.#abort = () => { this.#pending?.reject(new Error('Owned tool cancelled')); this.#pending = null; this.#channel?.close(); }; signal.addEventListener('abort', this.#abort, { once: true });
  }
  #fail(): void {
    if (!this.#closing) { this.#broken = true; this.#pending?.reject(new PiFailure({ code: 'RECOVERY_REQUIRED', phase: 'tool', path: '', retryable: false, effect: 'possible', operationId: this.container.operationId, requestId: null, stateErrorCode: null })); this.#pending = null; }
  }
  #wait(kind: string): Promise<unknown> { if (this.#pending || this.#broken || this.signal.aborted) refuse('RECOVERY_REQUIRED', '', { phase: 'tool' }); const waiting = new Promise<unknown>((resolve, reject) => { this.#pending = { kind, resolve, reject }; }); void waiting.catch(() => {}); return waiting; }
  ready(): Promise<void> { if (this.#bootWork || this.#closing) refuse('SESSION_BUSY'); const work = this.#ready(); this.#bootWork = work; return work; }
  async #ready(): Promise<void> {
    this.signal.throwIfAborted(); const waiting = this.#wait('ready'), child = await this.container.start(this.signal);
    this.#channel = new Channel(this.container.nonce, child.stdout, child.stdin);
    let stderrBytes = 0; child.stderr.on('data', (bytes: Buffer) => { stderrBytes += bytes.length; if (stderrBytes > this.input.policy.limits.diagnosticBytes) this.#fail(); });
    child.once('exit', () => { if (this.#pending) this.#fail(); }); child.once('error', () => this.#fail());
    this.#channel.on('failed', () => this.#fail());
    this.#channel.on('message', (message: ChannelMessage) => { if (this.#closing) return; if (!this.#pending || message.kind !== this.#pending.kind) { this.#fail(); return; } const pending = this.#pending; this.#pending = null; pending.resolve(message.body); });
    const facts = object(await waiting, ['node', 'platform', 'architecture']);
    if (facts.node !== 'v26.13.0' || facts.platform !== 'linux' || facts.architecture !== 'arm64') refuse('RUNTIME_MISMATCH', '', { phase: 'tool' });
  }
  async execute(name: 'read' | 'bash', bytes: Uint8Array, read: { readonly path: string; readonly digest: string } | null, guard: () => void): Promise<ToolProcessReply> {
    const pending = this.#wait('tool-result');
    await this.#channel!.sendBytes('execute-tool', { name, path: read?.path ?? null, fileDigest: read?.digest ?? null, fileBytes: this.input.policy.limits.fileBytes, resultBytes: this.input.policy.limits.toolResultBytes, wallMs: this.input.policy.limits.toolWallMs }, bytes, 'binary', guard);
    const body = object(await pending, ['result', 'produced', 'code']); integer(body.produced, 0, Number.MAX_SAFE_INTEGER);
    if (body.code !== null && !['TOOL_DENIED', 'OUTPUT_LIMIT', 'CANCELLED', 'RECOVERY_REQUIRED'].includes(body.code as string)) refuse('RECOVERY_REQUIRED', '', { phase: 'tool', effect: 'possible' });
    const raw = body.result as Record<string, unknown>, keys = Object.keys(raw);
    if (!keys.includes('content') || !keys.includes('details') || keys.some(key => !['content', 'details', 'structuredContent', 'isError'].includes(key)) || Buffer.byteLength(canonical(raw)) > this.input.policy.limits.toolResultBytes) refuse('OUTPUT_LIMIT', '', { phase: 'tool', effect: 'possible' });
    const value = object(raw, keys); if (value.isError !== undefined && typeof value.isError !== 'boolean') refuse('RECOVERY_REQUIRED', '', { phase: 'tool', effect: 'possible' });
    const content = list(value.content, 16, '/content').map(item => { const block = object(item, ['type', 'text']); if (block.type !== 'text' || typeof block.text !== 'string') refuse('TOOL_DENIED', '', { phase: 'tool' }); return { type: 'text' as const, text: block.text }; });
    return { result: { ...value, content, details: value.details } as ToolResult, code: body.code as PiErrorCode | null, produced: body.produced as number };
  }
  async close(): Promise<ContainerExit | null> {
    this.#closing = true; this.signal.removeEventListener('abort', this.#abort); this.#pending?.reject(new Error('Owned tool closed')); this.#pending = null; this.#channel?.close();
    await this.#bootWork?.catch(() => {}); this.#channel?.close(); return this.container.close();
  }
}
