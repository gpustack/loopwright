import { createMcpExtension, createCodemodeExtension, type ExtensionFactory } from '@earendil-works/pi-coding-agent';
import type { McpTransport, JsonRpcMessage, McpTransportSendOptions } from '@earendil-works/pi-mcp';
import { EventEmitter } from 'node:events';
import { canonical } from './boundary.js';
import { toolArgumentsDigest } from './usage.js';
import type { AdapterPolicy } from './types.js';
import type { ToolIdentity } from './tools.js';
import type { Channel } from './protocol.js';
/** An actual native client transport over the existing inherited owner channel. */
export class OwnerMcpTransport implements McpTransport {
  readonly #events = new EventEmitter(); #closed = false; readonly #proposals: { identity: ToolIdentity; digest: string }[] = [];
  constructor(readonly channel: Channel, readonly fail: () => void) {}
  admit(identity: ToolIdentity, args: unknown): void { if (this.#closed || this.#proposals.length >= 32) throw new Error('MCP proposal bound'); this.#proposals.push({ identity, digest: canonical(toolArgumentsDigest(args)) }); }
  async start(): Promise<void> { if (this.#closed) throw new Error('Closed MCP transport'); }
  async send(message: JsonRpcMessage, options?: McpTransportSendOptions): Promise<void> {
    if (this.#closed || options?.signal?.aborted) throw new Error('Closed MCP request');
    let identity: ToolIdentity | null = null;
    if ('method' in message && message.method === 'tools/call') {
      const params = message.params as { name?: unknown; arguments?: unknown }, fingerprint = canonical(toolArgumentsDigest(params.arguments));
      const index = this.#proposals.findIndex(proposal => proposal.identity.name === 'mcp__workspace__' + String(params.name) && proposal.digest === fingerprint);
      if (index < 0) { this.fail(); throw new Error('No bound MCP proposal'); } identity = this.#proposals.splice(index, 1)[0]!.identity;
    }
    const abort = () => { if ('id' in message) void this.channel.send('mcp-cancel', { id: message.id }).catch(this.fail); };
    options?.signal?.addEventListener('abort', abort, { once: true });
    // The native client aborts this send signal after either its final response or cancellation.
    const bytes = Buffer.from(canonical(message)); if (bytes.length > 65536) { this.fail(); throw new Error('MCP frame bound'); }
    await this.channel.sendBytes('mcp', { identity }, bytes);
  }
  receive(message: JsonRpcMessage): void { if (!this.#closed) this.#events.emit('message', message); }
  refused(): void { if (!this.#closed) { this.#events.emit('failed', new Error('Owner refused MCP')); this.#events.emit('closed'); this.#closed = true; } }
  async close(): Promise<void> { if (this.#closed) return; this.#closed = true; this.#proposals.length = 0; this.#events.emit('closed'); await this.channel.send('mcp-close', null); }
  onMessage(listener: (message: JsonRpcMessage) => void): () => void { this.#events.on('message', listener); return () => { this.#events.off('message', listener); }; }
  onError(listener: (error: Error) => void): () => void { this.#events.on('failed', listener); return () => { this.#events.off('failed', listener); }; }
  onClose(listener: () => void): () => void { this.#events.on('closed', listener); return () => { this.#events.off('closed', listener); }; }
}
export function nativeMcpFactories(policy: Pick<AdapterPolicy, 'tools' | 'mcp'>, transport: OwnerMcpTransport): readonly { name: 'loopwright-mcp' | 'loopwright-codemode'; factory: ExtensionFactory }[] {
  const mcp = createMcpExtension({ loadConfig: () => ({ errors: [], autoEnableCodemode: false, servers: policy.mcp.names.length ? [{ name: 'workspace', source: '/tmp/loopwright-owned-mcp-config', scope: 'extension', config: { command: 'owner-stdio-only', timeout: policy.mcp.idleTimeoutSeconds, exposure: 'hidden', toolExposure: { read_file: 'direct' }, description: 'Bounded read-only candidate files' } }] : [] }),
    createTransport: (entry, cwd, auth) => { if (entry.name !== 'workspace' || cwd !== '/workspace/candidate' || auth !== undefined) throw new Error('Unapproved MCP transport'); return transport; },
    logPath: '/tmp/loopwright-mcp.log', updateConfig: () => { throw new Error('Frozen MCP configuration'); }, openUrl: () => { throw new Error('MCP authentication unsupported'); }, startupWaitMs: 10000 });
  return [{ name: 'loopwright-mcp', factory: mcp }, { name: 'loopwright-codemode', factory: createCodemodeExtension({ models: false }) }];
}
