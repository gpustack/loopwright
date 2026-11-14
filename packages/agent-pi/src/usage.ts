import type { Quantity, RequestUsage, Digest } from '@loopwright/core';
import { hasPositiveModelCost } from './catalog.js';
import { parseBoundedJson } from './context.js';
import { evaluateRawResponse, type RawResponseResult } from './response.js';
import { canonical, digest } from './boundary.js';
import type { PiModelCost, PiWireApi } from './types.js';
export interface RawToolCall { readonly id: string; readonly name: string; readonly argumentsDigest: Digest }
export interface RawInspection {
  readonly termination: 'confirmed' | 'unknown'; readonly rawStop: string | null; readonly responseDigest: Digest;
  readonly usage: Omit<RequestUsage, 'requestId'>; readonly admission: RawResponseResult; readonly toolCalls: readonly RawToolCall[];
}
const unknown = (): Quantity => ({ provenance: 'unknown' });
const number = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0 && !Object.is(value, -0);
export function toolArgumentsDigest(value: unknown): Digest { return digest(Buffer.from('loopwright.dev/tool-arguments/v1\0' + canonical(value))); }

function estimateOpenAiCost(totalInputTokens: number, cachedTokens: number, outputTokens: number, modelCost: PiModelCost): Quantity {
  const clampedCached = Math.min(Math.max(0, cachedTokens), totalInputTokens);
  const uncachedInput = Math.max(0, totalInputTokens - clampedCached);
  const cacheReadRate = modelCost.cacheRead ?? modelCost.input;
  const estimated = Math.round(uncachedInput * modelCost.input + clampedCached * cacheReadRate + outputTokens * modelCost.output);
  return Number.isSafeInteger(estimated) && estimated >= 0 ? { provenance: 'estimated', value: estimated } : unknown();
}

function inspectOpenAiCompletions(bytes: Uint8Array, source: string, status: number, admission: RawResponseResult, modelCost?: PiModelCost): RawInspection {
  let termination: RawInspection['termination'] = 'unknown';
  let rawStop: string | null = null;
  const usage: { inputTokens: Quantity; outputTokens: Quantity; costMicrousd: Quantity } = { inputTokens: unknown(), outputTokens: unknown(), costMicrousd: unknown() };
  const toolCalls: RawToolCall[] = [];
  const result = (): RawInspection => ({ termination, rawStop, responseDigest: digest(bytes), usage, admission, toolCalls });

  if (status !== 200) {
    const parsed = parseBoundedJson(source) as { error?: { message?: unknown } };
    if (parsed && typeof parsed.error === 'object' && parsed.error !== null && [400, 401, 403, 404, 429].includes(status)) {
      termination = 'confirmed';
    }
    return result();
  }

  const normalized = source.replace(/\r\n/g, '\n');
  if (!normalized.endsWith('\n\n')) return result();
  let done = false;
  let promptTokens: number | null = null;
  let completionTokens: number | null = null;
  let cachedTokens = 0;
  let reportedCostMicrousd: number | null = null;
  const calls = new Map<number, { id: string; name: string; arguments: string }>();

  for (const frame of normalized.split('\n\n').filter(Boolean)) {
    const dataLines = frame.split('\n').filter(line => !line.startsWith(':'));
    if (dataLines.length === 0) continue;
    const payload = dataLines.map(line => line.slice(6)).join('\n').trim();
    if (payload === '[DONE]') { done = true; continue; }
    const chunk = parseBoundedJson(payload) as {
      choices?: { finish_reason?: string | null; delta?: { tool_calls?: { index?: number; id?: string; function?: { name?: string; arguments?: string } }[] } }[];
      usage?: { prompt_tokens?: unknown; completion_tokens?: unknown; cost_microusd?: unknown; prompt_tokens_details?: { cached_tokens?: unknown } | null } | null;
    };
    for (const choice of chunk.choices ?? []) {
      if (typeof choice.finish_reason === 'string' && choice.finish_reason.length > 0) rawStop = choice.finish_reason;
      for (const tc of choice.delta?.tool_calls ?? []) {
        if (number(tc.index)) {
          const existing = calls.get(tc.index) ?? { id: '', name: '', arguments: '' };
          if (typeof tc.id === 'string' && tc.id.length > 0) existing.id = tc.id;
          if (typeof tc.function?.name === 'string' && tc.function.name.length > 0) existing.name += tc.function.name;
          if (typeof tc.function?.arguments === 'string') existing.arguments += tc.function.arguments;
          calls.set(tc.index, existing);
        }
      }
    }
    if (chunk.usage && typeof chunk.usage === 'object') {
      if (number(chunk.usage.prompt_tokens)) promptTokens = chunk.usage.prompt_tokens;
      if (number(chunk.usage.completion_tokens)) completionTokens = chunk.usage.completion_tokens;
      if (number(chunk.usage.cost_microusd)) reportedCostMicrousd = chunk.usage.cost_microusd;
      const details = chunk.usage.prompt_tokens_details;
      if (details && typeof details === 'object' && !Array.isArray(details) && number(details.cached_tokens)) {
        cachedTokens = details.cached_tokens;
      }
    }
  }

  if (done && rawStop && ['stop', 'tool_calls', 'length', 'content_filter', 'network_error'].includes(rawStop) && (admission.ok || admission.terminalComplete === true)) {
    termination = 'confirmed';
    if (promptTokens !== null) usage.inputTokens = { provenance: 'reported', value: promptTokens };
    if (completionTokens !== null) usage.outputTokens = { provenance: 'reported', value: completionTokens };
    if (reportedCostMicrousd !== null) {
      usage.costMicrousd = { provenance: 'reported', value: reportedCostMicrousd };
    } else if (
      usage.inputTokens.provenance === 'reported' &&
      usage.outputTokens.provenance === 'reported' &&
      hasPositiveModelCost(modelCost)
    ) {
      usage.costMicrousd = estimateOpenAiCost(usage.inputTokens.value, cachedTokens, usage.outputTokens.value, modelCost);
    }
  }
  if (admission.ok) {
    for (const [, entry] of [...calls.entries()].sort((a, b) => a[0] - b[0])) {
      toolCalls.push({ id: entry.id, name: entry.name, argumentsDigest: toolArgumentsDigest(parseBoundedJson(entry.arguments || '{}')) });
    }
  }
  return result();
}

function inspectOpenAiResponses(bytes: Uint8Array, source: string, status: number, admission: RawResponseResult, modelCost?: PiModelCost): RawInspection {
  let termination: RawInspection['termination'] = 'unknown';
  let rawStop: string | null = null;
  const usage: { inputTokens: Quantity; outputTokens: Quantity; costMicrousd: Quantity } = { inputTokens: unknown(), outputTokens: unknown(), costMicrousd: unknown() };
  const toolCalls: RawToolCall[] = [];
  const result = (): RawInspection => ({ termination, rawStop, responseDigest: digest(bytes), usage, admission, toolCalls });

  if (status !== 200) {
    const parsed = parseBoundedJson(source) as { error?: unknown };
    if (parsed && typeof parsed.error === 'object' && parsed.error !== null && [400, 401, 403, 404, 429].includes(status)) {
      termination = 'confirmed';
    }
    return result();
  }

  const normalized = source.replace(/\r\n/g, '\n');
  if (!normalized.endsWith('\n\n')) return result();
  for (const frame of normalized.split('\n\n').filter(Boolean)) {
    const dataLine = frame.split('\n').find(line => line.startsWith('data: '));
    if (!dataLine) continue;
    const payload = dataLine.slice(6).trim();
    if (payload === '[DONE]') continue;
    const item = parseBoundedJson(payload) as {
      type?: string;
      response?: {
        status?: string;
        usage?: { input_tokens?: unknown; output_tokens?: unknown; cost_microusd?: unknown; input_tokens_details?: { cached_tokens?: unknown } | null };
        output?: { type?: string; call_id?: string; id?: string; name?: string; arguments?: string }[];
      };
    };
    if (item.type === 'response.completed' || item.type === 'response.incomplete' || item.type === 'response.failed') {
      rawStop = item.response?.status ?? item.type;
      if (admission.ok || admission.terminalComplete === true) {
        termination = 'confirmed';
        const respUsage = item.response?.usage;
        if (number(respUsage?.input_tokens)) usage.inputTokens = { provenance: 'reported', value: respUsage.input_tokens };
        if (number(respUsage?.output_tokens)) usage.outputTokens = { provenance: 'reported', value: respUsage.output_tokens };
        if (number(respUsage?.cost_microusd)) {
          usage.costMicrousd = { provenance: 'reported', value: respUsage.cost_microusd };
        } else if (
          usage.inputTokens.provenance === 'reported' &&
          usage.outputTokens.provenance === 'reported' &&
          hasPositiveModelCost(modelCost)
        ) {
          const details = respUsage?.input_tokens_details;
          const cachedTokens = details && typeof details === 'object' && !Array.isArray(details) && number(details.cached_tokens)
            ? details.cached_tokens
            : 0;
          usage.costMicrousd = estimateOpenAiCost(usage.inputTokens.value, cachedTokens, usage.outputTokens.value, modelCost);
        }
      }
      if (admission.ok && item.type === 'response.completed') {
        for (const out of item.response?.output ?? []) {
          if (out.type === 'function_call') {
            toolCalls.push({
              id: out.call_id ?? out.id ?? '',
              name: out.name ?? '',
              argumentsDigest: toolArgumentsDigest(parseBoundedJson(out.arguments || '{}')),
            });
          }
        }
      }
    }
  }
  return result();
}

export function inspectRawResponse(
  bytes: Uint8Array,
  status: number,
  model: string,
  api: PiWireApi = 'anthropic-messages',
  strictModelMatch = true,
  modelCost?: PiModelCost,
): RawInspection {
  let admission = evaluateRawResponse(bytes, status, api);
  let termination: RawInspection['termination'] = 'unknown', rawStop: string | null = null;
  const usage: { inputTokens: Quantity; outputTokens: Quantity; costMicrousd: Quantity } = { inputTokens: unknown(), outputTokens: unknown(), costMicrousd: unknown() };
  const toolCalls: RawToolCall[] = [], result = (): RawInspection => ({ termination, rawStop, responseDigest: digest(bytes), usage, admission, toolCalls });
  try {
    if (bytes.byteLength > 1048576) return result();
    const source = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
    if (api === 'openai-completions') return inspectOpenAiCompletions(bytes, source, status, admission, modelCost);
    if (api === 'openai-responses') return inspectOpenAiResponses(bytes, source, status, admission, modelCost);
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
      if (Object.hasOwn(counts, 'cost_microusd')) {
        if (number(counts.cost_microusd)) final.cost_microusd = counts.cost_microusd;
        else malformed = true;
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
        const modelMatches = strictModelMatch ? message?.model === model : typeof message?.model === 'string' && (message.model === model || message.model.startsWith(model + '-'));
        if (!modelMatches || message.role !== 'assistant' || !Array.isArray(message.content) || message.content.length) throw new Error('response identity'); update(message.usage, false);
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
      if (number(final.cost_microusd)) {
        usage.costMicrousd = { provenance: 'reported', value: final.cost_microusd };
      } else if (
        usage.inputTokens.provenance === 'reported' &&
        usage.outputTokens.provenance === 'reported' &&
        hasPositiveModelCost(modelCost)
      ) {
        const uncachedInput = final.input_tokens as number;
        const cacheRead = final.cache_read_input_tokens as number;
        const cacheWrite = final.cache_creation_input_tokens as number;
        const outputTokens = final.output_tokens as number;
        const cacheReadRate = modelCost.cacheRead ?? modelCost.input;
        const cacheWriteRate = modelCost.cacheWrite ?? modelCost.input;
        const estimated = Math.round(
          uncachedInput * modelCost.input +
          cacheRead * cacheReadRate +
          cacheWrite * cacheWriteRate +
          outputTokens * modelCost.output,
        );
        if (Number.isSafeInteger(estimated) && estimated >= 0) {
          usage.costMicrousd = { provenance: 'estimated', value: estimated };
        }
      }
    }
    if (malformed) admission = { ok: false, code: 'MODEL_FAILED' };
    if (admission.ok) for (const block of blocks.values()) toolCalls.push({ id: block.id, name: block.name, argumentsDigest: toolArgumentsDigest(parseBoundedJson(block.arguments || '{}')) });
    return result();
  } catch { admission = { ok: false, code: 'MODEL_FAILED' }; termination = 'unknown'; usage.inputTokens = unknown(); usage.outputTokens = unknown(); usage.costMicrousd = unknown(); return result(); }
}
