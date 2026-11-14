import { readFile } from 'node:fs/promises';
import { object, text, canonical } from './boundary.js';
import { LEGACY_COPILOT_DESTINATION, resolveProviderDestination } from './catalog.js';
import { refuse } from './errors.js';
import { systemPrompt } from './resources.js';
import type { PiModelSelection, PiOpenInput } from './types.js';
import type { RawToolCall } from './usage.js';
import type { ToolIdentity, ToolResult } from './tools.js';
import type { JsonRpcMessage } from '@earendil-works/pi-mcp';
// Retained constant for pinned S03/S04 test fixtures.
export const PROVIDER_DESTINATION = LEGACY_COPILOT_DESTINATION;
export interface InvocationIdentity { readonly invocation: number; readonly provider: string; readonly model: string; readonly api: string; readonly thinking: string }
export interface FetchIdentity { readonly invocation: number; readonly slot: string; readonly method: string; readonly url: string; readonly headers: Readonly<Record<string, string>> }
export interface ParsedCandidate {
  readonly invocation: number; readonly slot: string; readonly stopReason: string; readonly rawStopReason: string | null;
  readonly usage: { readonly input: number; readonly output: number; readonly cacheRead: number; readonly cacheWrite: number };
  readonly toolCalls: readonly RawToolCall[];
}
export interface RuntimeReply { readonly status: number; readonly headers: Readonly<Record<string, string>>; readonly bytes: Uint8Array }
export interface ToolAuthorization extends ToolIdentity { readonly argumentsDigest: unknown; readonly argumentsBytes?: Uint8Array }
export interface RuntimeBroker {
  invoke(identity: InvocationIdentity): Promise<{ readonly slot: string }>;
  send(identity: FetchIdentity, bytes: Uint8Array): Promise<RuntimeReply>;
  parsed(candidate: ParsedCandidate): Promise<void>;
  rootTool(input: ToolAuthorization): Promise<boolean>;
  guardRootTool?(identity: ToolIdentity): void;
  tool?(identity: ToolIdentity, bytes: Uint8Array): Promise<ToolResult>;
  cancelTool?(identity: ToolIdentity): void;
  nativeResult?(identity: ToolIdentity, bytes: Uint8Array): Promise<void>;
  mcp?(identity: ToolIdentity | null, bytes: Uint8Array, reply: (message: JsonRpcMessage) => Promise<void>): Promise<void>;
  cancelMcp?(id: unknown): void;
  closeMcp?(): Promise<void>;
  runtimeFault?(code: 'OUTPUT_LIMIT' | 'MCP_FAILED'): void;
}
const fixedHeaders: Readonly<Record<string, string>> = Object.freeze({
  accept: 'application/json', 'content-type': 'application/json', 'anthropic-version': '2023-06-01',
  'anthropic-dangerous-direct-browser-access': 'true', 'user-agent': 'GitHubCopilotChat/0.35.0',
  'editor-version': 'vscode/1.107.0', 'editor-plugin-version': 'copilot-chat/0.35.0', 'copilot-integration-id': 'vscode-chat', 'openai-intent': 'conversation-edits',
});
const FORBIDDEN_FETCH_HEADERS = new Set(['authorization', 'x-api-key', 'api-key', 'x-goog-api-key', 'cookie', 'proxy-authorization']);

export function semanticHeaders(identity: FetchIdentity, selection?: PiModelSelection): Readonly<Record<string, string>> {
  const isLegacyCopilot = !selection || (selection.provider === 'github-copilot' && !selection.customProvider);
  const expectedDestination = isLegacyCopilot ? PROVIDER_DESTINATION : resolveProviderDestination(selection);
  if (identity.method !== 'POST' || identity.url !== expectedDestination) refuse('SEND_PATH_UNSUPPORTED', '', { phase: 'admission' });
  if (!identity.headers || typeof identity.headers !== 'object' || Array.isArray(identity.headers)) refuse('PAYLOAD_MISMATCH');
  const keys = Object.keys(identity.headers); if (keys.length > 64) refuse('PAYLOAD_MISMATCH');
  const output: Record<string, string> = Object.create(null) as Record<string, string>;

  if (isLegacyCopilot) {
    for (const name of keys) {
      const value = identity.headers[name]; if (name !== name.toLowerCase() || !/^[a-z0-9-]{1,128}$/.test(name) || typeof value !== 'string' || value.length > 4096 || /[\r\n]/.test(value)) refuse('PAYLOAD_MISMATCH');
      if (name.startsWith('x-stainless-')) { if (name === 'x-stainless-retry-count' && value !== '0') refuse('SEND_PATH_UNSUPPORTED'); continue; }
      if (name === 'content-length' || name === 'accept-encoding' || name === 'connection') continue;
      if (name === 'x-initiator') { if (value !== 'user' && value !== 'agent') refuse('PAYLOAD_MISMATCH'); output[name] = value; continue; }
      if (name === 'anthropic-beta') {
        if (value !== 'fine-grained-tool-streaming-2025-05-14') refuse('SEND_PATH_UNSUPPORTED'); output[name] = value; continue;
      }
      if (fixedHeaders[name] !== value) refuse('PAYLOAD_MISMATCH'); output[name] = value;
    }
    for (const name of ['content-type', 'anthropic-version', 'x-initiator', 'openai-intent']) if (!output[name]) refuse('PAYLOAD_MISMATCH');
    return Object.freeze(output);
  }

  for (const name of keys) {
    const value = identity.headers[name];
    if (name !== name.toLowerCase() || !/^[a-z0-9-]{1,128}$/.test(name) || typeof value !== 'string' || value.length > 4096 || /[\r\n]/.test(value)) {
      refuse('PAYLOAD_MISMATCH');
    }
    if (FORBIDDEN_FETCH_HEADERS.has(name)) refuse('PAYLOAD_MISMATCH');
    if (name.startsWith('x-stainless-')) {
      if (name === 'x-stainless-retry-count' && value !== '0') refuse('SEND_PATH_UNSUPPORTED');
      continue;
    }
    if (name === 'content-length' || name === 'accept-encoding' || name === 'connection') continue;
    output[name] = value;
  }
  if (!output['content-type']?.startsWith('application/json') || !output['accept']) refuse('PAYLOAD_MISMATCH');
  return Object.freeze(output);
}

let summarizationPrompt: Promise<string> | undefined;
async function frozenSummarizationPrompt(): Promise<string> {
  summarizationPrompt ??= (async () => {
    const source = await readFile(new URL('./core/compaction/utils.js', import.meta.resolve('@earendil-works/pi-coding-agent')), 'utf8');
    const value = /export const SUMMARIZATION_SYSTEM_PROMPT = `([^`]+)`;/.exec(source)?.[1];
    if (!value || value.includes('${') || value.includes('\\')) refuse('RUNTIME_MISMATCH'); return value;
  })(); return summarizationPrompt;
}

function extractTextContent(value: unknown): string {
  if (typeof value === 'string') return value;
  if (!Array.isArray(value)) refuse('RESOURCE_MISMATCH');
  return value.map(item => text((item as { text?: unknown }).text)).join('\n\n');
}

/** Checks runtime-owned prompt text as well as resource identity; caller content cannot select this branch. */
export async function validateRequestResources(bytes: Uint8Array, input: PiOpenInput, kind: 'execute' | 'compact'): Promise<void> {
  const body = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as Record<string, unknown>;
  const api = input.policy.selection.api;
  const preamble = systemPrompt(input);
  const expectedExecutePrompt = preamble + '\n\n<cwd>\n/workspace/candidate\n</cwd>';
  const allowedUpdates = [
    expectedExecutePrompt,
    `Updated system prompt section "preamble":\n\n${preamble}`,
    'Updated system prompt section "cwd":\n\n<cwd>\n/workspace/candidate\n</cwd>',
  ];

  if (api === 'anthropic-messages') {
    const prompt = extractTextContent(body.system);
    if (kind === 'compact') {
      if (prompt !== await frozenSummarizationPrompt() || Array.isArray(body.tools) && body.tools.length) refuse('RESOURCE_MISMATCH', '/request/system');
    } else {
      if (prompt !== expectedExecutePrompt) refuse('RESOURCE_MISMATCH', '/request/system');
      for (const message of body.messages as { role: string; content: unknown }[]) if (message.role === 'system') {
        const update = extractTextContent(message.content);
        if (!allowedUpdates.includes(update)) refuse('RESOURCE_MISMATCH', '/request/messages');
      }
    }
    return;
  }

  if (api === 'openai-completions') {
    if (!Array.isArray(body.messages) || body.messages.length === 0) refuse('RESOURCE_MISMATCH', '/request/messages');
    const messages = body.messages as { role?: unknown; content?: unknown }[];
    const first = messages[0];
    if (!first || (first.role !== 'system' && first.role !== 'developer')) refuse('RESOURCE_MISMATCH', '/request/messages');
    const prompt = extractTextContent(first.content);
    if (kind === 'compact') {
      if (prompt !== await frozenSummarizationPrompt() || Array.isArray(body.tools) && body.tools.length) refuse('RESOURCE_MISMATCH', '/request/messages');
    } else {
      if (prompt !== expectedExecutePrompt) refuse('RESOURCE_MISMATCH', '/request/messages');
      for (const message of messages.slice(1)) {
        if (message.role === 'system' || message.role === 'developer') {
          const update = extractTextContent(message.content);
          if (!allowedUpdates.includes(update)) refuse('RESOURCE_MISMATCH', '/request/messages');
        }
      }
    }
    return;
  }

  if (api === 'openai-responses') {
    const prompt = typeof body.instructions === 'string'
      ? body.instructions
      : Array.isArray(body.input) && body.input.length > 0 && ['system', 'developer'].includes(String((body.input[0] as { role?: unknown })?.role))
        ? extractTextContent((body.input[0] as { content?: unknown }).content)
        : null;
    if (prompt === null) refuse('RESOURCE_MISMATCH', '/request/instructions');
    if (kind === 'compact') {
      if (prompt !== await frozenSummarizationPrompt() || Array.isArray(body.tools) && body.tools.length) refuse('RESOURCE_MISMATCH', '/request/instructions');
    } else if (prompt !== expectedExecutePrompt) {
      refuse('RESOURCE_MISMATCH', '/request/instructions');
    }
    return;
  }

  refuse('SEND_PATH_UNSUPPORTED');
}

export function validateInvocation(value: unknown, expected: PiOpenInput['policy']['selection']): InvocationIdentity {
  const input = object(value, ['invocation', 'provider', 'model', 'api', 'thinking']);
  const expectedBase = { provider: expected.provider, model: expected.model, api: expected.api, thinking: expected.thinking };
  if (!Number.isSafeInteger(input.invocation) || (input.invocation as number) < 1 || canonical({ provider: input.provider, model: input.model, api: input.api, thinking: input.thinking }) !== canonical(expectedBase)) {
    refuse('SEND_PATH_UNSUPPORTED');
  }
  return input as unknown as InvocationIdentity;
}

export async function boundedResponse(response: Response, maxBytes: number, signal: AbortSignal): Promise<Uint8Array> {
  const reader = response.body?.getReader(); if (!reader) return new Uint8Array(0);
  const chunks: Uint8Array[] = []; let offset = 0;
  const abort = () => { void reader.cancel().catch(() => {}); }; signal.addEventListener('abort', abort, { once: true });
  try {
    for (;;) {
      signal.throwIfAborted(); const part = await reader.read(); if (part.done) break;
      if (offset + part.value.byteLength > maxBytes) { await reader.cancel(); refuse('OUTPUT_LIMIT', '', { phase: 'dispatch', effect: 'possible' }); }
      const copy = new Uint8Array(part.value.byteLength); copy.set(part.value);
      chunks.push(copy); offset += copy.byteLength;
    }
    signal.throwIfAborted();
    if (chunks.length === 0) return new Uint8Array(0);
    if (chunks.length === 1) return chunks[0]!;
    const out = new Uint8Array(offset);
    let cursor = 0;
    for (const chunk of chunks) { out.set(chunk, cursor); cursor += chunk.byteLength; }
    return out;
  } finally { signal.removeEventListener('abort', abort); reader.releaseLock(); }
}
