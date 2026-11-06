import { parseBoundedJson } from './context.js';
export type RawResponseResult = { readonly ok: true; readonly toolCalls: readonly { id: string; name: string }[] }
  | { readonly ok: false; readonly code: 'CONTEXT_LIMIT' | 'OUTPUT_LIMIT' | 'MODEL_FAILED'; readonly terminalComplete?: true };
/** Internal T0 raw-response admission seam; it does not settle S02 usage. */
export function evaluateRawResponse(bytes: Uint8Array, status: number): RawResponseResult {
  const fail = (code: 'CONTEXT_LIMIT' | 'OUTPUT_LIMIT' | 'MODEL_FAILED' = 'MODEL_FAILED', terminalComplete = false): RawResponseResult => ({ ok: false, code, ...(terminalComplete ? { terminalComplete: true as const } : {}) });
  try {
    if (bytes.byteLength > 1048576) return fail();
    const input = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes).replace(/\r\n/g, '\n');
    if (status !== 200) {
      const value = parseBoundedJson(input) as { error?: { type?: string; message?: string } };
      return fail(status === 400 && value?.error?.type === 'invalid_request_error' && typeof value.error.message === 'string' && value.error.message.startsWith('prompt is too long:') ? 'CONTEXT_LIMIT' : 'MODEL_FAILED');
    }
    if (!input.endsWith('\n\n')) return fail();
    let started = false, ended = false, stop: string | undefined, usage = false;
    const blocks = new Map<number, { type: string; id: string | undefined; name: string | undefined; arguments: string; closed: boolean }>();
    for (const frame of input.split('\n\n').filter(Boolean)) {
      if (ended || Buffer.byteLength(frame) > 1048576) return fail();
      const lines = frame.split('\n');
      const data = lines.filter(line => line.startsWith('data: '));
      const event = lines.filter(line => line.startsWith('event: '));
      if (data.length !== 1 || event.length !== 1 || lines.length !== 2) return fail();
      const value = parseBoundedJson(data[0]!.slice(6));
      if (!value || Array.isArray(value) || typeof value !== 'object' || value.type !== event[0]!.slice(7)) return fail();
      const item = value as Record<string, unknown>;
      switch (item.type) {
        case 'ping': if (stop) return fail(); break;
        case 'message_start': {
          if (started) return fail(); started = true;
          const message = item.message as { usage?: { input_tokens?: number } };
          if (!Number.isSafeInteger(message?.usage?.input_tokens) || message.usage!.input_tokens! < 0) return fail();
          break;
        }
        case 'content_block_start': {
          if (!started || stop || !Number.isSafeInteger(item.index) || blocks.has(item.index as number)) return fail();
          const block = item.content_block as { type: string; id?: string; name?: string; input?: unknown };
          if (!['text', 'tool_use', 'thinking', 'redacted_thinking'].includes(block?.type)) return fail();
          if (block.type === 'tool_use' && (!block.id || !block.name || JSON.stringify(block.input) !== '{}')) return fail();
          blocks.set(item.index as number, { type: block.type, id: block.id, name: block.name, arguments: '', closed: false }); break;
        }
        case 'content_block_delta': {
          const block = blocks.get(item.index as number), delta = item.delta as { type?: string; partial_json?: string };
          if (!block || block.closed || stop) return fail();
          if (delta.type === 'input_json_delta') {
            if (block.type !== 'tool_use' || typeof delta.partial_json !== 'string') return fail();
            block.arguments += delta.partial_json; if (Buffer.byteLength(block.arguments) > 65536) return fail();
          } else if (!['text_delta', 'thinking_delta', 'signature_delta'].includes(delta.type ?? '')) return fail();
          break;
        }
        case 'content_block_stop': {
          const block = blocks.get(item.index as number); if (!block || block.closed) return fail(); block.closed = true;
          if (block.type === 'tool_use') { const args = parseBoundedJson(block.arguments || '{}'); if (!args || Array.isArray(args) || typeof args !== 'object') return fail(); }
          break;
        }
        case 'message_delta': {
          if (!started || stop || [...blocks.values()].some(block => !block.closed)) return fail();
          const delta = item.delta as { stop_reason?: string }, tokens = (item.usage as { output_tokens?: number })?.output_tokens;
          if (!Number.isSafeInteger(tokens) || tokens! < 0 || typeof delta?.stop_reason !== 'string') return fail();
          stop = delta.stop_reason; usage = true; break;
        }
        case 'message_stop': if (!started || !stop || !usage) return fail(); ended = true; break;
        default: return fail();
      }
    }
    if (!ended) return fail();
    if (stop === 'model_context_window_exceeded') return fail('CONTEXT_LIMIT', true);
    if (stop === 'max_tokens') return fail('OUTPUT_LIMIT', true);
    if (['pause_turn', 'stop_sequence', 'refusal', 'sensitive'].includes(stop ?? '')) return fail('MODEL_FAILED', true);
    if (stop !== 'end_turn' && stop !== 'tool_use') return fail();
    const toolCalls = [...blocks.values()].filter(block => block.type === 'tool_use').map(block => ({ id: block.id!, name: block.name! }));
    if (new Set(toolCalls.map(call => call.id)).size !== toolCalls.length || (stop === 'tool_use') !== (toolCalls.length > 0)) return fail();
    return { ok: true, toolCalls };
  } catch { return fail(); }
}
export class TurnFailureLatch {
  #failed = false;
  #tools = new Set<string>();
  observe(result: RawResponseResult): void {
    if (!result.ok) { this.#failed = true; this.#tools.clear(); }
    else if (!this.#failed) for (const call of result.toolCalls) this.#tools.add(call.id);
  }
  canSettle(): boolean { return !this.#failed; }
  canAdmitTool(id: string): boolean { return !this.#failed && this.#tools.has(id); }
}
