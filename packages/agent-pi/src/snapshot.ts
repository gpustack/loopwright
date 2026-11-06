import { CURRENT_SESSION_VERSION, type FileEntry } from '@earendil-works/pi-coding-agent';
import { parseBoundedJson } from './context.js';
import { object, canonical } from './boundary.js';
import { refuse } from './errors.js';
import type { AdapterPolicy } from './types.js';
/** Private snapshot rows carry passive native data, not JSON schemas or executable loaders. */
export function snapshotRow(bytes: Uint8Array): Record<string, unknown> {
  if (bytes.length > 1048576) refuse('OUTPUT_LIMIT', '', { phase: 'restore' });
  try { const value = parseBoundedJson(new TextDecoder('utf-8', { fatal: true }).decode(bytes), { nodes: 131072, array: 8192, schemaReferences: false }); return object(value, Object.keys(value as object)); }
  catch { refuse('RECOVERY_REQUIRED', '', { phase: 'restore' }); }
}
export function rowBytes(value: unknown): Buffer {
  let bytes: Buffer; try { bytes = Buffer.from(JSON.stringify(value) + '\n'); } catch { refuse('OUTPUT_LIMIT', '', { phase: 'restore' }); }
  snapshotRow(bytes); return bytes;
}
export type SnapshotPolicy = Pick<AdapterPolicy, 'selection' | 'tools'> & { readonly limits: Pick<AdapterPolicy['limits'], 'sessionBytes'> };
/** The SDK parser skips malformed lines; the adapter instead validates every owned row and graph edge. */
export class NativeSnapshot {
  readonly #ids = new Set<string>(); readonly #entries: FileEntry[] = [];
  readonly #tools = new Set<string>();
  #header = false; #headerId = ''; #bytes = 0; #count = 0; #partial = Buffer.alloc(0); #finished = false;
  constructor(readonly policy: SnapshotPolicy, readonly maxBytes = policy.limits.sessionBytes, readonly retain = true) {}
  push(bytes: Uint8Array): void {
    if (this.#finished || (this.#bytes += bytes.byteLength) > this.maxBytes) refuse('OUTPUT_LIMIT', '', { phase: 'restore' });
    let offset = 0; const data = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    while (offset < data.length) {
      const end = data.indexOf(10, offset), part = data.subarray(offset, end < 0 ? data.length : end);
      if (this.#partial.length + part.length > 1048576) refuse('OUTPUT_LIMIT', '', { phase: 'restore' });
      this.#partial = Buffer.concat([this.#partial, part]); offset += part.length + (end < 0 ? 0 : 1); if (end < 0) break;
      this.#accept(snapshotRow(this.#partial)); this.#partial = Buffer.alloc(0);
    }
  }
  #accept(value: Record<string, unknown>): void {
    if (this.#count++ >= 8192 || typeof value.id !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(value.id) || typeof value.timestamp !== 'string' || !Number.isFinite(Date.parse(value.timestamp))) refuse('RECOVERY_REQUIRED', '', { phase: 'restore' });
    if (!this.#header) {
      const item = object(value, ['type', 'version', 'id', 'timestamp', 'cwd']);
      if (item.type !== 'session' || item.version !== CURRENT_SESSION_VERSION || item.cwd !== '/workspace/candidate') refuse('RECOVERY_REQUIRED', '', { phase: 'restore' }); this.#header = true; this.#headerId = value.id;
    } else {
      if (typeof value.type !== 'string' || !['message', 'thinking_level_change', 'model_change', 'usage', 'compaction', 'branch_summary', 'custom', 'custom_message', 'label', 'context_edit', 'session_info'].includes(value.type)
        || value.parentId !== null && (typeof value.parentId !== 'string' || !this.#ids.has(value.parentId)) || this.#ids.has(value.id) || value.id === this.#headerId) refuse('RECOVERY_REQUIRED', '', { phase: 'restore' });
      if (value.type === 'model_change' && (value.provider !== this.policy.selection.provider || value.modelId !== this.policy.selection.model) || value.type === 'thinking_level_change' && value.thinkingLevel !== this.policy.selection.thinking) refuse('BINDING_MISMATCH', '', { phase: 'restore' });
      if (value.type === 'compaction' && (typeof value.summary !== 'string' || typeof value.firstKeptEntryId !== 'string' || !this.#ids.has(value.firstKeptEntryId))) refuse('RECOVERY_REQUIRED', '', { phase: 'restore' });
      if (value.type === 'context_edit' || value.type === 'label') if (typeof value.targetId !== 'string' || !this.#ids.has(value.targetId)) refuse('RECOVERY_REQUIRED', '', { phase: 'restore' });
      if (value.type === 'message') {
        const message = value.message as Record<string, unknown>;
        if (!message || typeof message !== 'object' || !['user', 'assistant', 'toolResult', 'system'].includes(message.role as string)) refuse('RECOVERY_REQUIRED', '', { phase: 'restore' });
        if (message.role === 'toolResult') { if (typeof message.toolCallId !== 'string' || !this.#tools.delete(message.toolCallId)) refuse('RECOVERY_REQUIRED', '', { phase: 'restore' }); }
        if (message.role === 'assistant') {
          if (!Array.isArray(message.content)) refuse('RECOVERY_REQUIRED'); let calls = 0;
          for (const block of message.content as Record<string, unknown>[]) { if (!block || typeof block !== 'object') refuse('RECOVERY_REQUIRED'); if (block.type === 'toolCall') { if (typeof block.id !== 'string' || block.id.length > 256 || !block.id || typeof block.name !== 'string' || !this.policy.tools.includes(block.name) || this.#tools.has(block.id)) refuse('RECOVERY_REQUIRED'); this.#tools.add(block.id); calls++; } }
          if (message.stopReason === 'toolUse' && calls === 0 || message.stopReason === 'stop' && calls !== 0) refuse('RECOVERY_REQUIRED');
        }
        if (message.role === 'assistant' && (message.provider !== this.policy.selection.provider || message.model !== this.policy.selection.model || message.api !== this.policy.selection.api || !['stop', 'toolUse'].includes(message.stopReason as string))) refuse('BINDING_MISMATCH', '', { phase: 'restore' });
      }
      this.#ids.add(value.id);
    }
    if (this.retain) this.#entries.push(value as unknown as FileEntry);
  }
  finish(): FileEntry[] { if (!this.#header || this.#partial.length || this.#finished || this.#tools.size) refuse('RECOVERY_REQUIRED', '', { phase: 'restore' }); this.#finished = true; return this.#entries; }
}
export function sameSnapshotValue(left: unknown, right: unknown): boolean { return canonical(left) === canonical(right); }
