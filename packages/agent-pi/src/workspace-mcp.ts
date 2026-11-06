import { constants } from 'node:fs';
import { open, lstat, realpath } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { digestArtifact } from '@loopwright/core';
import { parseJsonRpcMessage, type JsonRpcMessage } from '@earendil-works/pi-mcp';
import { parseBoundedJson } from './context.js';
import { object, canonical } from './boundary.js';
import { PiFailure, refuse } from './errors.js';
export const WORKSPACE_TOOL = Object.freeze({ name: 'read_file', description: 'Read one bounded regular UTF-8 candidate file. No symlinks or host paths.', inputSchema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'], additionalProperties: false }, annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } });
export async function readWorkspace(root: string, path: string, maxBytes: number): Promise<string> {
  if (typeof path !== 'string' || !digestArtifact(path, new Uint8Array()).ok || path.split('/').some(segment => segment.length > 255) || !Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > 65536) refuse('TOOL_DENIED', '', { phase: 'tool' });
  const checkDirectory = async (directory: string) => { const info = await lstat(directory); if (!info.isDirectory() || info.isSymbolicLink() || await realpath(directory) !== resolve(directory)) refuse('TOOL_DENIED', '', { phase: 'tool' }); };
  await checkDirectory(root); let parent = root;
  for (const part of path.split('/').slice(0, -1)) { parent = join(parent, part); await checkDirectory(parent); }
  const file = join(root, path), before = await lstat(file);
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1) refuse('TOOL_DENIED', '', { phase: 'tool' });
  if (before.size > maxBytes) refuse('OUTPUT_LIMIT', '', { phase: 'tool' });
  const fd = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = await fd.stat(); if (!info.isFile() || info.nlink !== 1 || info.dev !== before.dev || info.ino !== before.ino) refuse('TOOL_DENIED', '', { phase: 'tool' }); if (info.size > maxBytes) refuse('OUTPUT_LIMIT', '', { phase: 'tool' });
    const bytes = Buffer.alloc(info.size + 1); let offset = 0;
    while (offset < bytes.length) { const next = await fd.read(bytes, offset, bytes.length - offset, offset); if (!next.bytesRead) break; offset += next.bytesRead; }
    if (offset !== info.size) refuse('RECOVERY_REQUIRED', '', { phase: 'tool' }); return new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, offset));
  } finally { await fd.close(); }
}
/** Constructor injection is used only by separate qualification entrypoints, never by policy JSON. */
export interface WorkspaceServerPorts {
  readonly call?: (name: string, args: Record<string, unknown>, progress: (value: unknown) => Promise<void>) => Promise<unknown>;
  readonly tools?: readonly unknown[];
}
export function runWorkspaceServer(ports: WorkspaceServerPorts = {}): void {
  let buffer = Buffer.alloc(0), pending = 0, initialized = false, ready = false, ended = false;
  let tail = Promise.resolve();
  const fail = () => { ended = true; process.exitCode = 1; process.stdin.destroy(); process.stdout.end(); };
  const send = async (value: unknown): Promise<void> => {
    const line = canonical(value) + '\n'; if (Buffer.byteLength(line) > 65536 || process.stdout.writableLength + Buffer.byteLength(line) > 262144) throw new Error('Owned MCP output bound');
    await new Promise<void>((resolve, reject) => process.stdout.write(line, error => error ? reject(error) : resolve()));
  };
  async function request(value: JsonRpcMessage): Promise<void> {
    if (!('method' in value)) throw new Error('Owned MCP request only');
    if (!('id' in value)) { if (value.method === 'notifications/initialized' && initialized) ready = true; else if (value.method !== 'notifications/cancelled') throw new Error('Owned MCP notification'); return; }
    const reply = (result: unknown) => send({ jsonrpc: '2.0', id: value.id, result });
    if (value.method === 'initialize' && !initialized) { initialized = true; await reply({ protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'loopwright-workspace', version: '1' } }); return; }
    if (!ready) throw new Error('Owned MCP initialization required');
    if (value.method === 'tools/list') { await reply({ tools: ports.tools ?? [WORKSPACE_TOOL] }); return; }
    if (value.method !== 'tools/call') { await send({ jsonrpc: '2.0', id: value.id, error: { code: -32601, message: 'MCP_FAILED' } }); return; }
    let result: unknown;
    try {
      const keys = Object.keys(value.params ?? {}), params = object(value.params, keys); if (keys.some(key => !['name', 'arguments', '_meta'].includes(key)) || typeof params.name !== 'string') refuse('TOOL_DENIED', '', { phase: 'tool' });
      const args = object(params.arguments, ['path']); if (typeof args.path !== 'string') refuse('TOOL_DENIED', '', { phase: 'tool' });
      const token = (params._meta as { progressToken?: unknown } | undefined)?.progressToken;
      const progress = (data: unknown) => send({ jsonrpc: '2.0', method: 'notifications/progress', params: { progressToken: token, ...(data as Record<string, unknown>) } });
      if (ports.call) result = await ports.call(params.name, args, progress);
      else { if (params.name !== 'read_file') refuse('TOOL_DENIED', '', { phase: 'tool' }); result = { content: [{ type: 'text', text: await readWorkspace('/workspace/candidate', args.path, 65536) }] }; }
      if (Buffer.byteLength(canonical({ jsonrpc: '2.0', id: value.id, result })) + 1 > 65536) refuse('OUTPUT_LIMIT', '', { phase: 'tool' });
    } catch (error) { const code = error instanceof PiFailure ? error.detail.code : 'MCP_FAILED'; result = { isError: true, content: [{ type: 'text', text: code }] }; }
    await reply(result);
  }
  process.stdin.on('data', (chunk: Buffer) => {
    if (ended) return;
    try {
      let offset = 0;
      while (offset < chunk.length) {
        const end = chunk.indexOf(10, offset), bytes = chunk.subarray(offset, end < 0 ? chunk.length : end); if (buffer.length + bytes.length > 65536) throw new Error('Owned MCP input bound');
        buffer = Buffer.concat([buffer, bytes]); offset += bytes.length + (end < 0 ? 0 : 1); if (end < 0) break;
        const message = parseJsonRpcMessage(parseBoundedJson(new TextDecoder('utf-8', { fatal: true }).decode(buffer))); buffer = Buffer.alloc(0); if (++pending > 32) throw new Error('Owned MCP request queue');
        tail = tail.then(() => request(message)).finally(() => { pending--; }); void tail.catch(fail);
      }
    } catch { fail(); }
  });
  process.stdin.once('end', () => { ended = true; void tail.finally(() => { process.stdout.end(); process.stdin.destroy(); }); });
  process.stdin.once('error', fail); process.stdout.once('error', fail);
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) runWorkspaceServer();
