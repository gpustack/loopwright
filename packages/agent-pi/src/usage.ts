import type { Quantity, RequestUsage, Digest } from '@loopwright/core';
import { parseBoundedJson } from './context.js';
import { evaluateRawResponse, type RawResponseResult } from './response.js';
import { canonical, digest } from './boundary.js';
export interface RawToolCall { readonly id: string; readonly name: string; readonly argumentsDigest: Digest }
export interface RawInspection {
  readonly termination: 'confirmed' | 'unknown'; readonly rawStop: string | null; readonly responseDigest: Digest;
  readonly usage: Omit<RequestUsage, 'requestId'>; readonly admission: RawResponseResult; readonly toolCalls: readonly RawToolCall[];
}
const unknown = (): Quantity => ({ provenance: 'unknown' });
const number = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0 && !Object.is(value, -0);
export function toolArgumentsDigest(value: unknown): Digest { return digest(Buffer.from('loopwright.dev/tool-arguments/v1\0' + canonical(value))); }
export function inspectRawResponse(bytes: Uint8Array, status: number, model: string): RawInspection {
  let admission = evaluateRawResponse(bytes, status);
  let termination: RawInspection['termination'] = 'unknown', rawStop: string | null = null;
  const usage: { inputTokens: Quantity; outputTokens: Quantity; costMicrousd: Quantity } = { inputTokens: unknown(), outputTokens: unknown(), costMicrousd: unknown() };
  const toolCalls: RawToolCall[] = [], result = (): RawInspection => ({ termination, rawStop, responseDigest: digest(bytes), usage, admission, toolCalls });
  try {
    if (bytes.byteLength > 1048576) return result();
    const source = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
    if (status !== 200) {
      const error = parseBoundedJson(source) as { type?: unknown; error?: { type?: unknown } };
      const expected: Record<number, string> = { 400: 'invalid_request_error', 401: 'authentication_error', 403: 'permission_error', 404: 'not_found_error', 429: 'rate_limit_error' };
      if (error?.type === 'error' && error.error?.type === expected[status] && expected[status]) termination = 'confirmed'; return result();
    }
    const normalized = source.replace(/\r\n/g, '\n'); if (!normalized.endsWith('\n\n')) return result();
    const final: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
    let started = false, stopped = false, deltas = 0, malformed = false, finalOutput = false;
    const blocks = new Map<number, { id: string; name: string; arguments: string }>();
    const update = (value: unknown, finalDelta: boolean) => {
      if (!value || typeof value !== 'object' || Array.isArray(value)) { malformed = true; return; }
      const counts = value as Record<string, unknown>;
      for (const field of ['input_tokens', 'cache_read_input_tokens', 'cache_creation_input_tokens', 'output_tokens']) {
        if (Object.hasOwn(counts, field)) { final[field] = counts[field]; if (!number(counts[field])) malformed = true; if (finalDelta && field === 'output_tokens') finalOutput = true; }
      }
      if (counts.cache_creation && typeof counts.cache_creation === 'object') {
        const breakdown = counts.cache_creation as Record<string, unknown>, a = breakdown.ephemeral_5m_input_tokens, b = breakdown.ephemeral_1h_input_tokens;
        if (a !== undefined && !number(a) || b !== undefined && !number(b) || number(a) && number(b) && number(counts.cache_creation_input_tokens) && a + b !== counts.cache_creation_input_tokens) malformed = true;
      }
    };
    for (const frame of normalized.split('\n\n').filter(Boolean)) {
      if (Buffer.byteLength(frame) > 1048576 || stopped) throw new Error('unsupported frame');
      const lines = frame.split('\n'); if (lines.length !== 2 || !lines[0]!.startsWith('event: ') || !lines[1]!.startsWith('data: ')) throw new Error('unsupported frame');
      const event = parseBoundedJson(lines[1]!.slice(6)) as Record<string, unknown>;
      if (!event || event.type !== lines[0]!.slice(7)) throw new Error('event mismatch');
      if (event.type === 'message_start') {
        if (started) throw new Error('duplicate start'); started = true; const message = event.message as Record<string, unknown>;
        if (message?.model !== model || message.role !== 'assistant' || !Array.isArray(message.content) || message.content.length) throw new Error('response identity'); update(message.usage, false);
      } else if (event.type === 'message_delta') {
        if (!started || ++deltas !== 1) throw new Error('delta'); rawStop = (event.delta as { stop_reason?: unknown })?.stop_reason as string;
        if (typeof rawStop !== 'string') throw new Error('stop'); update(event.usage, true);
      } else if (event.type === 'message_stop') { if (!started || deltas !== 1) throw new Error('stop ordering'); stopped = true; }
      else if (event.type === 'content_block_start') {
        const block = event.content_block as Record<string, unknown>;
        if (block?.type === 'tool_use') { if (typeof block.id !== 'string' || typeof block.name !== 'string' || !number(event.index) || blocks.has(event.index)) throw new Error('tool identity'); blocks.set(event.index, { id: block.id, name: block.name, arguments: '' }); }
      } else if (event.type === 'content_block_delta') {
        const delta = event.delta as { type?: unknown; partial_json?: unknown };
        if (delta?.type === 'input_json_delta') { const block = blocks.get(event.index as number); if (!block || typeof delta.partial_json !== 'string') throw new Error('tool arguments'); block.arguments += delta.partial_json; if (Buffer.byteLength(block.arguments) > 65536) throw new Error('arguments limit'); }
      } else if (!['content_block_stop', 'ping'].includes(event.type as string)) throw new Error('unknown event');
    }
    const knownStops = ['end_turn', 'tool_use', 'max_tokens', 'model_context_window_exceeded', 'pause_turn', 'stop_sequence', 'refusal', 'sensitive'];
    if (stopped && rawStop && knownStops.includes(rawStop) && (admission.ok || admission.terminalComplete === true)) termination = 'confirmed';
    if (termination === 'confirmed' && !malformed) {
      const fields = ['input_tokens', 'cache_read_input_tokens', 'cache_creation_input_tokens'];
      if (fields.every(field => number(final[field]))) {
        const sum = fields.reduce((total, field) => total + (final[field] as number), 0); if (Number.isSafeInteger(sum)) usage.inputTokens = { provenance: 'reported', value: sum };
      }
      if (finalOutput && number(final.output_tokens)) usage.outputTokens = { provenance: 'reported', value: final.output_tokens };
    }
    if (malformed) admission = { ok: false, code: 'MODEL_FAILED' };
    if (admission.ok) for (const block of blocks.values()) toolCalls.push({ id: block.id, name: block.name, argumentsDigest: toolArgumentsDigest(parseBoundedJson(block.arguments || '{}')) });
    return result();
  } catch { admission = { ok: false, code: 'MODEL_FAILED' }; termination = 'unknown'; usage.inputTokens = unknown(); usage.outputTokens = unknown(); return result(); }
}
