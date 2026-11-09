import { EventEmitter } from 'node:events';
import { parseJsonRpcMessage, type JsonRpcMessage } from '@earendil-works/pi-mcp';
import { OwnedContainer, type ContainerExit } from './containers.js';
import { canonical } from './boundary.js';
import { parseBoundedJson } from './context.js';
import { refuse } from './errors.js';
import type { PiHost, PiOpenInput } from './types.js';
import type { ArtifactRef } from '@loopwright/core';
import type { DispatchPermit, OperationRecord } from '@loopwright/state';
import type { ToolIdentity } from './tools.js';
export interface McpDispatchContext {
  readonly identity: (ToolIdentity & { readonly parentRequestId: string }) | null;
  readonly operation: OperationRecord | null;
  readonly permit: DispatchPermit | null;
  readonly before: ArtifactRef | null;
  readonly signal: AbortSignal;
  readonly assertCurrent: () => void;
  readonly receive: (message: JsonRpcMessage) => Promise<void>;
}
export interface McpProcessPort {
  on(event: 'message', listener: (message: JsonRpcMessage) => void): this;
  on(event: 'failed', listener: () => void): this;
  ready(signal: AbortSignal): Promise<void>;
  send(message: JsonRpcMessage, guard: () => void, context?: McpDispatchContext): Promise<void>;
  close(): Promise<ContainerExit | null>;
}
/** Raw stdio JSON-RPC belongs only to the separate, owned, read-only MCP role. */
export class McpProcess extends EventEmitter implements McpProcessPort {
  readonly container: OwnedContainer; #input = Buffer.alloc(0); #closed = false; #failed = false; #ready: Promise<void> | null = null;
  #child: Awaited<ReturnType<OwnedContainer['start']>> | null = null; #tail = Promise.resolve(); #pending = 0; #queuedBytes = 0;
  constructor(host: PiHost, readonly input: PiOpenInput, directory: string, candidate: string) { super(); this.container = new OwnedContainer(host, input, directory, candidate, 'mcp', 'mcp-workspace'); }
  #fail(): void { if (!this.#closed && !this.#failed) { this.#failed = true; this.emit('failed'); } }
  ready(signal: AbortSignal): Promise<void> {
    if (this.#ready) return this.#ready;
    const started = (async () => {
      const child = await this.container.start(signal); this.#child = child;
      let stderr = 0; child.stderr.on('data', (bytes: Buffer) => { stderr += bytes.length; if (stderr > this.input.policy.limits.diagnosticBytes) this.#fail(); });
      child.once('exit', () => this.#fail()); child.once('error', () => this.#fail()); child.stdout.once('end', () => this.#fail()); child.stdout.once('error', () => this.#fail()); child.stdin.once('error', () => this.#fail());
      child.stdout.on('data', (chunk: Buffer) => {
        if (this.#closed || this.#failed) return;
        try {
          let offset = 0;
          while (offset < chunk.length) {
            const end = chunk.indexOf(10, offset), bytes = chunk.subarray(offset, end < 0 ? chunk.length : end);
            if (this.#input.length + bytes.length > 65536) throw new Error('MCP frame bound');
            this.#input = Buffer.concat([this.#input, bytes]); offset += bytes.length + (end < 0 ? 0 : 1); if (end < 0) break;
            const message = parseJsonRpcMessage(parseBoundedJson(new TextDecoder('utf-8', { fatal: true }).decode(this.#input))); this.#input = Buffer.alloc(0); this.emit('message', message);
          }
        } catch { this.#fail(); }
      });
    })(); this.#ready = started; return started;
  }
  async send(message: JsonRpcMessage, guard: () => void): Promise<void> {
    if (this.#closed || this.#failed || !this.#child || this.#pending >= 32) refuse('MCP_FAILED', '', { phase: 'tool' });
    const bytes = Buffer.from(canonical(message) + '\n'); if (bytes.length > 65536 || this.#queuedBytes + bytes.length > this.input.policy.limits.pendingResponseBytes) refuse('OUTPUT_LIMIT', '', { phase: 'tool' }); this.#pending++; this.#queuedBytes += bytes.length;
    const sent = this.#tail.then(async () => {
      if (this.#closed || this.#failed || this.#child!.stdin.writableLength + bytes.length > 262144) refuse('MCP_FAILED', '', { phase: 'tool' });
      guard(); await new Promise<void>((resolve, reject) => this.#child!.stdin.write(bytes, error => error ? reject(error) : resolve()));
    }); this.#tail = sent.catch(() => {}); try { await sent; } finally { this.#pending--; this.#queuedBytes -= bytes.length; }
  }
  async close(): Promise<ContainerExit | null> { this.#closed = true; await this.#ready?.catch(() => {}); return this.container.close(); }
}
