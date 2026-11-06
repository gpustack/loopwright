import { createReadTool, createBashTool, createLocalBashOperations } from '@earendil-works/pi-coding-agent';
import { constants } from 'node:fs';
import { open, lstat } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { Channel, type ChannelMessage } from './protocol.js';
import { parseBoundedJson } from './context.js';
import { canonical, digest, integer } from './boundary.js';
import { PiFailure, refuse } from './errors.js';
import type { ToolResult } from './tools.js';
import type { AgentToolResult } from '@earendil-works/pi-agent-core';
function textResult(value: AgentToolResult<unknown>): ToolResult {
  return { content: value.content.map(block => { if (block.type !== 'text') refuse('TOOL_DENIED'); return { type: 'text', text: block.text }; }),
    details: value.details ?? null, ...(value.isError ? { isError: true } : {}), ...(value.structuredContent === undefined ? {} : { structuredContent: value.structuredContent }) };
}
/** Separate Linux role. It can return tool data, never ask for model sends or host candidate commits. */
export function runToolWorker(nonce: string): void {
  const channel = new Channel(nonce, process.stdin, process.stdout), cancel = new AbortController(); let used = false, complete = false;
  const stop = () => { cancel.abort(); channel.close(); process.stdin.destroy(); };
  channel.on('failed', () => { cancel.abort(); process.exitCode = complete ? 0 : 1; process.stdin.destroy(); });
  async function handle(message: ChannelMessage): Promise<void> {
    if (message.kind === 'close') { stop(); return; }
    if (message.kind !== 'execute-tool' || used) throw new Error('Unsupported tool command'); used = true;
    const envelope = message.body as { metadata: { name: string; path: string | null; fileDigest: string | null; fileBytes: number; resultBytes: number; wallMs: number }; bytes: Uint8Array }, meta = envelope.metadata;
    integer(meta.fileBytes, 1, 8388608); integer(meta.resultBytes, 1, 65536); integer(meta.wallMs, 1, 10000);
    if (envelope.bytes.length > 65536) refuse('OUTPUT_LIMIT');
    const args = parseBoundedJson(new TextDecoder('utf-8', { fatal: true }).decode(envelope.bytes)) as Record<string, unknown>;
    let result: ToolResult, produced = 0, overflow = false, code: string | null = null;
    try {
      if (meta.name === 'read') {
        if (typeof meta.path !== 'string' || !meta.path || !/^(?:[A-Za-z0-9._-]+\/)*[A-Za-z0-9._-]+$/.test(meta.path) || meta.path.split('/').some(part => part === '.' || part === '..')) refuse('TOOL_DENIED');
        const expected = '/workspace/candidate/' + meta.path;
        const check = async (path: string) => { if (path !== expected) refuse('TOOL_DENIED'); const info = await lstat(path); if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.size > meta.fileBytes) refuse('TOOL_DENIED'); };
        const read = createReadTool('/workspace/candidate', { autoResizeImages: false, operations: { access: check, detectImageMimeType: async () => null, readFile: async path => {
          await check(path); const fd = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
          try { const info = await fd.stat(); if (!info.isFile() || info.nlink !== 1 || info.size > meta.fileBytes) refuse('TOOL_DENIED'); const bytes = Buffer.alloc(info.size + 1); let offset = 0;
            while (offset < bytes.length) { const next = await fd.read(bytes, offset, bytes.length - offset, offset); if (!next.bytesRead) break; offset += next.bytesRead; }
            const data = bytes.subarray(0, offset); if (offset !== info.size || digest(data).hex !== meta.fileDigest) refuse('RECOVERY_REQUIRED'); new TextDecoder('utf-8', { fatal: true }).decode(data); return data;
          } finally { await fd.close(); }
        } } });
        result = textResult(await read.execute('owned-read', { ...args, path: meta.path } as Parameters<typeof read.execute>[1], cancel.signal));
      } else if (meta.name === 'bash') {
        const native = createLocalBashOperations({ shellPath: '/bin/bash' }), output = new AbortController();
        const bash = createBashTool('/scratch', { exposeSessionEnvironment: false, shellPath: '/bin/bash', operations: { exec: async (command, cwd, options) => {
          if (cwd !== '/scratch') refuse('TOOL_DENIED');
          const signal = AbortSignal.any([cancel.signal, output.signal, ...(options.signal ? [options.signal] : [])]);
          return native.exec(command, cwd, { ...options, signal, timeout: meta.wallMs / 1000, onData: bytes => { produced += bytes.length; if (produced > meta.resultBytes) { overflow = true; output.abort(); return; } options.onData(bytes); } });
        } } });
        result = textResult(await bash.execute('owned-bash', args as Parameters<typeof bash.execute>[1], cancel.signal));
      } else refuse('TOOL_DENIED');
      if (overflow || Buffer.byteLength(canonical(result)) > meta.resultBytes || result.content.some(item => item.type !== 'text')) refuse('OUTPUT_LIMIT');
    } catch (error) {
      code = overflow ? 'OUTPUT_LIMIT' : cancel.signal.aborted ? 'CANCELLED' : error instanceof PiFailure ? error.detail.code : 'TOOL_DENIED';
      result = { content: [{ type: 'text', text: code }], isError: true, details: null };
    }
    complete = true;
    await channel.send('tool-result', { result, produced, code });
  }
  channel.on('message', (message: ChannelMessage) => { void handle(message).catch(() => { cancel.abort(); process.exitCode = 1; process.stdin.destroy(); }); });
  void channel.send('ready', { platform: process.platform, architecture: process.arch, node: process.version }).catch(stop);
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) runToolWorker(process.argv[2] ?? '');
