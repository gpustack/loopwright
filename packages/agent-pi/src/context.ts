import { createHash } from 'node:crypto';
export interface ContextPolicy {
  readonly mode?: 'proven_bound' | 'estimated_guard';
  readonly maxRequestBytes?: number;
  readonly serviceMargin?: number;
  readonly toolReserve?: number;
  readonly workingWindowCeiling?: number;
  readonly maxOutputTokens?: number;
}
export interface ContextSelection {
  readonly modelId: string;
  readonly effort: string;
  readonly tools: readonly string[];
  readonly contextWindow: number;
  readonly perCallOutputTokens: number;
  readonly provider?: string;
  readonly api?: 'anthropic-messages' | 'openai-completions' | 'openai-responses';
}
export interface ContextAssessment {
  readonly mode: 'estimated_guard';
  readonly estimator: 'lw-pi-final-json-bytes-v1';
  readonly version: 1;
  readonly provenance: 'estimated';
  readonly contextFit: 'unproven';
  readonly bodyBytes: number;
  readonly inputReservation: number;
  readonly outputReservation: number;
  readonly totalReservation: number;
  readonly serviceMargin: number;
  readonly toolReserve: number;
  readonly workingWindow: number;
  readonly bodyDigest: string;
  readonly withinByteLimit: boolean; readonly withinWindow: boolean; readonly coverage: 'complete' | 'unsupported';
}
export type ContextResult = { readonly ok: true; readonly value: ContextAssessment }
  | { readonly ok: false; readonly code: 'CONTEXT_UNSAFE'; readonly assessment?: ContextAssessment };
type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
function unsafe(): never { throw new Error('Unsupported context'); }
function record(value: Json | undefined): { [key: string]: Json } {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) unsafe();
  return value;
}
function exact(value: Json | undefined, keys: readonly string[]): { [key: string]: Json } {
  const result = record(value);
  if (Object.keys(result).some(key => !keys.includes(key))) unsafe();
  return result;
}
function text(value: Json | undefined): string { if (typeof value !== 'string') unsafe(); return value; }
function array(value: Json | undefined): Json[] { if (!Array.isArray(value)) unsafe(); return value; }
function integer(value: number, min: number, max = Number.MAX_SAFE_INTEGER): number {
  if (!Number.isSafeInteger(value) || value < min || value > max || Object.is(value, -0)) unsafe();
  return value;
}
/** Parse bounded JSON without losing duplicate keys or following schema references. */
export function parseBoundedJson(input: string, limits: { readonly nodes?: number; readonly array?: number; readonly properties?: number; readonly schemaReferences?: boolean } = {}): Json {
  let index = 0, nodes = 0;
  const space = () => { while (/[ \t\r\n]/.test(input[index] ?? '') && index < input.length) index++; };
  const string = (): string => {
    const start = index++;
    while (index < input.length) {
      const char = input[index++];
      if (char === '\\') { index++; continue; }
      if (char !== '"') continue;
      const value = JSON.parse(input.slice(start, index)) as string;
      for (let i = 0; i < value.length; i++) {
        const unit = value.charCodeAt(i);
        if (unit >= 0xd800 && unit <= 0xdbff) {
          const next = value.charCodeAt(++i); if (!(next >= 0xdc00 && next <= 0xdfff)) unsafe();
        } else if (unit >= 0xdc00 && unit <= 0xdfff) unsafe();
      }
      return value;
    }
    return unsafe();
  };
  const value = (depth: number): Json => {
    if (++nodes > (limits.nodes ?? 8192) || depth > 32) unsafe(); space();
    const char = input[index];
    if (char === '"') return string();
    if (char === '{') {
      index++; space(); const object: { [key: string]: Json } = Object.create(null) as { [key: string]: Json };
      if (input[index] === '}') { index++; return object; }
      let properties = 0;
      while (index < input.length) {
        space(); if (input[index] !== '"' || ++properties > (limits.properties ?? 256)) unsafe(); const key = string();
        if (Object.hasOwn(object, key)) unsafe(); space(); if (input[index++] !== ':') unsafe();
        object[key] = value(depth + 1);
        if (limits.schemaReferences !== false && key === '$ref' && (typeof object[key] !== 'string' || !object[key].startsWith('#'))) unsafe();
        space(); const end = input[index++]; if (end === '}') return object; if (end !== ',') unsafe();
      }
      return unsafe();
    }
    if (char === '[') {
      index++; space(); const items: Json[] = []; if (input[index] === ']') { index++; return items; }
      while (index < input.length) {
        if (items.length >= (limits.array ?? 128)) unsafe(); items.push(value(depth + 1)); space();
        const end = input[index++]; if (end === ']') return items; if (end !== ',') unsafe();
      }
      return unsafe();
    }
    for (const [literal, result] of [['true', true], ['false', false], ['null', null]] as const) {
      if (input.startsWith(literal, index)) { index += literal.length; return result; }
    }
    const token = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/.exec(input.slice(index))?.[0];
    if (!token) unsafe(); index += token.length; const number = Number(token);
    if (!Number.isFinite(number) || Math.abs(number) > Number.MAX_SAFE_INTEGER) unsafe(); return number;
  };
  const result = value(0); space(); if (index !== input.length) unsafe(); return result;
}
function cache(value: Json | undefined): void {
  if (value === undefined) return;
  const item = exact(value, ['type', 'ttl']);
  if (item.type !== 'ephemeral' || item.ttl !== undefined && item.ttl !== '5m' && item.ttl !== '1h') unsafe();
}
function validateBody(value: Json, selection: ContextSelection, output: number): void {
  const body = exact(value, ['model', 'messages', 'system', 'tools', 'tool_choice', 'thinking', 'output_config', 'max_tokens', 'stream']);
  if (body.model !== selection.modelId || body.max_tokens !== output || body.stream !== true) unsafe();
  const thinking = exact(body.thinking, ['type', 'display']);
  if (thinking.type !== 'adaptive' || thinking.display !== undefined && thinking.display !== 'summarized' && thinking.display !== 'omitted') unsafe();
  const effort = exact(body.output_config, ['effort']); if (effort.effort !== selection.effort) unsafe();
  if (body.tool_choice !== undefined) {
    const choice = exact(body.tool_choice, ['type', 'disable_parallel_tool_use']);
    if (choice.type !== 'auto' || choice.disable_parallel_tool_use !== undefined && typeof choice.disable_parallel_tool_use !== 'boolean') unsafe();
  }
  const textBlock = (block: Json) => {
    const item = exact(block, ['type', 'text', 'cache_control']); if (item.type !== 'text') unsafe(); text(item.text); cache(item.cache_control);
  };
  if (body.system !== undefined) { if (typeof body.system !== 'string') array(body.system).forEach(textBlock); }
  const definitions = new Set<string>();
  for (const tool of body.tools === undefined ? [] : array(body.tools)) {
    const item = exact(tool, ['name', 'description', 'input_schema', 'cache_control', 'eager_input_streaming', 'strict']);
    const name = text(item.name); if (!selection.tools.includes(name) || definitions.has(name)) unsafe(); definitions.add(name);
    record(item.input_schema); if (item.description !== undefined) text(item.description); cache(item.cache_control);
    for (const flag of ['eager_input_streaming', 'strict']) if (item[flag] !== undefined && typeof item[flag] !== 'boolean') unsafe();
  }
  const pending = new Set<string>(), calls = new Set<string>();
  for (const message of array(body.messages)) {
    const item = exact(message, ['role', 'content']); const role = text(item.role);
    if (!['user', 'assistant', 'system'].includes(role) || pending.size && role !== 'user') unsafe();
    if (typeof item.content === 'string') { if (pending.size) unsafe(); continue; }
    for (const block of array(item.content)) {
      const data = record(block);
      switch (data.type) {
        case 'text': textBlock(block); break;
        case 'thinking': {
          const part = exact(block, ['type', 'thinking', 'signature']); if (role !== 'assistant') unsafe(); text(part.thinking); text(part.signature); break;
        }
        case 'redacted_thinking': {
          const part = exact(block, ['type', 'data']); if (role !== 'assistant') unsafe(); text(part.data); break;
        }
        case 'tool_use': {
          const part = exact(block, ['type', 'id', 'name', 'input']); const id = text(part.id), name = text(part.name);
          if (role !== 'assistant' || !id || !selection.tools.includes(name) || calls.has(id)) unsafe(); record(part.input); calls.add(id); pending.add(id); break;
        }
        case 'tool_result': {
          const part = exact(block, ['type', 'tool_use_id', 'content', 'is_error', 'cache_control']); const id = text(part.tool_use_id);
          if (role !== 'user' || !pending.delete(id) || part.is_error !== undefined && typeof part.is_error !== 'boolean') unsafe();
          if (typeof part.content !== 'string') array(part.content).forEach(textBlock); cache(part.cache_control); break;
        }
        default: unsafe();
      }
    }
    if (role === 'user' && pending.size) unsafe();
  }
  if (pending.size) unsafe();
}
function validateTokenProviderBody(value: Json, selection: ContextSelection, output: number): number {
  const body = record(value);
  if (body.model !== selection.modelId || body.stream !== true) unsafe();
  if (selection.api === 'anthropic-messages') {
    if (typeof body.max_tokens !== 'number') unsafe();
    const effectiveOutput = integer(body.max_tokens, 1, output);
    const definitions = new Set<string>();
    for (const tool of body.tools === undefined ? [] : array(body.tools)) {
      const item = record(tool);
      const name = text(item.name);
      if (!selection.tools.includes(name) || definitions.has(name)) unsafe();
      definitions.add(name);
      record(item.input_schema);
    }
    if (!Array.isArray(body.messages) || body.messages.length === 0) unsafe();
    return effectiveOutput;
  }
  if (selection.api === 'openai-completions') {
    if (body.max_tokens !== undefined && body.max_completion_tokens !== undefined && body.max_tokens !== body.max_completion_tokens) unsafe();
    const cap = body.max_tokens ?? body.max_completion_tokens;
    if (typeof cap !== 'number') unsafe();
    const effectiveOutput = integer(cap, 1, output);
    const definitions = new Set<string>();
    for (const tool of body.tools === undefined ? [] : array(body.tools)) {
      const item = record(tool);
      if (item.type !== 'function') unsafe();
      const fn = record(item.function);
      const name = text(fn.name);
      if (!selection.tools.includes(name) || definitions.has(name)) unsafe();
      definitions.add(name);
      record(fn.parameters);
    }
    if (!Array.isArray(body.messages) || body.messages.length === 0) unsafe();
    return effectiveOutput;
  }
  if (selection.api === 'openai-responses') {
    let effectiveOutput = output;
    if (body.max_output_tokens !== undefined) {
      if (typeof body.max_output_tokens !== 'number') unsafe();
      effectiveOutput = integer(body.max_output_tokens, 1, output);
    }
    const definitions = new Set<string>();
    for (const tool of body.tools === undefined ? [] : array(body.tools)) {
      const item = record(tool);
      if (item.type !== 'function') unsafe();
      const name = text(item.name);
      if (!selection.tools.includes(name) || definitions.has(name)) unsafe();
      definitions.add(name);
      record(item.parameters);
    }
    if (!Array.isArray(body.input) || body.input.length === 0) unsafe();
    return effectiveOutput;
  }
  unsafe();
}
export function checkRequestBytes(bytes: Uint8Array, maxBytes = 65536): boolean {
  if (!(bytes instanceof Uint8Array) || bytes.buffer instanceof SharedArrayBuffer) return false;
  return maxBytes === 65536 ? bytes.byteLength <= 65536 : bytes.byteLength <= maxBytes;
}
export function assessFinalRequestContext(bytes: Uint8Array, policy: ContextPolicy, selection: ContextSelection): ContextResult {
  let assessment: ContextAssessment | undefined;
  try {
    const ceiling = integer(policy.maxRequestBytes ?? 65536, 1, 16777216);
    if (policy.mode !== 'estimated_guard' || !checkRequestBytes(bytes, ceiling)) unsafe();
    const margin = integer(policy.serviceMargin ?? 32768, 32768), reserve = integer(policy.toolReserve ?? 16384, 16384);
    const window = Math.min(integer(selection.contextWindow, 1), integer(policy.workingWindowCeiling ?? 98304, 1, 16777216));
    const output = Math.min(integer(selection.perCallOutputTokens, 1), integer(policy.maxOutputTokens ?? 1024, 1, 262144));
    const owned = Uint8Array.prototype.slice.call(bytes) as Uint8Array;
    const input = integer(owned.byteLength + margin, 1), total = integer(input + output, 1);
    assessment = { mode: 'estimated_guard', estimator: 'lw-pi-final-json-bytes-v1', version: 1, provenance: 'estimated', contextFit: 'unproven', bodyBytes: owned.byteLength, inputReservation: input, outputReservation: output, totalReservation: total, serviceMargin: margin, toolReserve: reserve, workingWindow: window, bodyDigest: createHash('sha256').update('loopwright.dev/pi-context/v1\0').update(owned).digest('hex'), withinByteLimit: owned.byteLength <= ceiling, withinWindow: integer(total + reserve, 1) <= window, coverage: 'unsupported' };
    const parsed = parseBoundedJson(new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(owned), { nodes: 1048576, array: 16384, properties: 1024 });
    const isLegacyCopilot = (!selection.api || selection.api === 'anthropic-messages') && (!selection.provider || selection.provider === 'github-copilot');
    if (isLegacyCopilot) {
      validateBody(parsed, selection, output);
      assessment = { ...assessment, coverage: 'complete' };
    } else {
      const effectiveOutput = validateTokenProviderBody(parsed, selection, output);
      const effectiveTotal = integer(input + effectiveOutput, 1);
      assessment = {
        ...assessment,
        outputReservation: effectiveOutput,
        totalReservation: effectiveTotal,
        withinWindow: integer(effectiveTotal + reserve, 1) <= window,
        coverage: 'complete',
      };
    }
    if (!assessment.withinByteLimit || !assessment.withinWindow) unsafe();
    return { ok: true, value: assessment };
  } catch { return assessment ? { ok: false, code: 'CONTEXT_UNSAFE', assessment } : { ok: false, code: 'CONTEXT_UNSAFE' }; }
}
