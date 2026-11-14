import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { Digest } from '@loopwright/core';
import { canonical, digest, freeze } from './boundary.js';
import { refuse } from './errors.js';
import type { PiModelCost, PiModelSelection, PiOpenInput, PiThinkingLevel, PiWireApi } from './types.js';

export const LEGACY_COPILOT_DESTINATION = 'https://api.individual.githubcopilot.com/v1/messages?beta=true';

export const PI_WIRE_APIS: readonly PiWireApi[] = Object.freeze([
  'anthropic-messages',
  'openai-completions',
  'openai-responses',
] as const);

export const PI_THINKING_LEVELS: readonly PiThinkingLevel[] = Object.freeze([
  'off',
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
] as const);

/**
 * Interactive OAuth / CLI-subscription providers in Pi that Loopwright refuses on user configuration surfaces.
 * Loopwright supports token/API-key authentication exclusively.
 */
export const PI_OAUTH_ONLY_PROVIDERS: readonly string[] = Object.freeze([
  'github-copilot',
  'openai-codex',
  'claude-code',
  'gemini',
  'google',
  'gemini-cli',
  'google-gemini-cli',
  'google-antigravity',
]);

const DISALLOWED_ADAPTER_OAUTH_PROVIDERS = new Set([
  'openai-codex',
  'claude-code',
  'gemini',
  'google',
  'gemini-cli',
  'google-gemini-cli',
  'google-antigravity',
]);

/** Standard Pi environment variables for built-in token-authenticated providers. */
export const STANDARD_PI_PROVIDER_ENV: Readonly<Record<string, string>> = Object.freeze({
  anthropic: 'ANTHROPIC_API_KEY',
  openai: 'OPENAI_API_KEY',
  zai: 'ZAI_API_KEY',
  'zai-coding-cn': 'ZAI_CODING_CN_API_KEY',
  openrouter: 'OPENROUTER_API_KEY',
  deepseek: 'DEEPSEEK_API_KEY',
  'qwen-token-plan': 'QWEN_TOKEN_PLAN_API_KEY',
  'qwen-token-plan-cn': 'QWEN_TOKEN_PLAN_CN_API_KEY',
  'qwen-token-plan-individual': 'QWEN_TOKEN_PLAN_API_KEY',
  fireworks: 'FIREWORKS_API_KEY',
  together: 'TOGETHER_API_KEY',
  baseten: 'BASETEN_API_KEY',
  nvidia: 'NVIDIA_API_KEY',
  groq: 'GROQ_API_KEY',
  cerebras: 'CEREBRAS_API_KEY',
  mistral: 'MISTRAL_API_KEY',
  xai: 'XAI_API_KEY',
  huggingface: 'HF_TOKEN',
  minimax: 'MINIMAX_API_KEY',
  'minimax-cn': 'MINIMAX_CN_API_KEY',
  moonshotai: 'MOONSHOT_API_KEY',
  'moonshotai-cn': 'MOONSHOT_API_KEY',
  'kimi-coding': 'KIMI_API_KEY',
  opencode: 'OPENCODE_API_KEY',
  'opencode-go': 'OPENCODE_API_KEY',
  'vercel-ai-gateway': 'AI_GATEWAY_API_KEY',
  xiaomi: 'XIAOMI_API_KEY',
  'xiaomi-token-plan-cn': 'XIAOMI_TOKEN_PLAN_CN_API_KEY',
  'xiaomi-token-plan-sg': 'XIAOMI_TOKEN_PLAN_SGP_API_KEY',
  'xiaomi-token-plan-sgp': 'XIAOMI_TOKEN_PLAN_SGP_API_KEY',
  'xiaomi-token-plan-ams': 'XIAOMI_TOKEN_PLAN_AMS_API_KEY',
  'ant-ling': 'ANT_LING_API_KEY',
});

export function isOAuthOnlyPiProvider(provider: string): boolean {
  return PI_OAUTH_ONLY_PROVIDERS.includes(provider.trim().toLowerCase());
}

export interface CatalogModelRecord {
  readonly id: string;
  readonly api: PiWireApi;
  readonly provider: string;
  readonly baseUrl: string;
  readonly reasoning: boolean;
  readonly contextWindow: number;
  readonly maxTokens: number;
  readonly thinkingLevelMap?: Readonly<Record<string, string | null>>;
  readonly cost?: PiModelCost;
}

export function hasPositiveModelCost(cost: PiModelCost | undefined): cost is PiModelCost {
  return cost !== undefined && (cost.input > 0 || cost.output > 0 || (cost.cacheRead ?? 0) > 0 || (cost.cacheWrite ?? 0) > 0);
}

function isNonNegativeRate(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1_000_000 && !Object.is(value, -0);
}

function extractBuiltInModelCost(raw: unknown): PiModelCost | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const item = raw as Record<string, unknown>;
  if (!isNonNegativeRate(item.input) || !isNonNegativeRate(item.output)) return undefined;
  if (item.cacheRead !== undefined && !isNonNegativeRate(item.cacheRead)) return undefined;
  if (item.cacheWrite !== undefined && !isNonNegativeRate(item.cacheWrite)) return undefined;
  return freeze({
    input: item.input,
    output: item.output,
    ...(item.cacheRead !== undefined ? { cacheRead: item.cacheRead } : {}),
    ...(item.cacheWrite !== undefined ? { cacheWrite: item.cacheWrite } : {}),
  });
}

export interface CatalogIdentity {
  readonly contextWindow: number;
  readonly digest: Digest;
}

export function validateProviderBaseUrl(raw: unknown, path: string): string {
  if (typeof raw !== 'string' || raw.length < 8 || raw.length > 2048 || /[\0\r\n\s]/.test(raw)) {
    refuse('INPUT_INVALID', path);
  }
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    refuse('INPUT_INVALID', path);
  }
  if (url.username || url.password || url.hash || url.search) refuse('INPUT_INVALID', path);
  const loopback = url.protocol === 'http:' && (url.hostname === '127.0.0.1' || url.hostname === '[::1]') && url.port !== '';
  if (url.protocol !== 'https:' && !loopback) refuse('SEND_PATH_UNSUPPORTED', path);
  return raw;
}

function validateThinkingAgainstModel(thinking: string, model: CatalogModelRecord): void {
  if (!(PI_THINKING_LEVELS as readonly string[]).includes(thinking)) {
    refuse('THINKING_UNSUPPORTED', '/policy/selection/thinking');
  }
  if (!model.reasoning) {
    if (thinking !== 'off') refuse('THINKING_UNSUPPORTED', '/policy/selection/thinking');
    return;
  }
  if (model.thinkingLevelMap) {
    if (Object.hasOwn(model.thinkingLevelMap, thinking)) {
      if (model.thinkingLevelMap[thinking] === null) {
        refuse('THINKING_UNSUPPORTED', '/policy/selection/thinking');
      }
      return;
    }
    if (!['off', 'minimal', 'low', 'medium', 'high'].includes(thinking)) {
      refuse('THINKING_UNSUPPORTED', '/policy/selection/thinking');
    }
    return;
  }
  if (!['off', 'minimal', 'low', 'medium', 'high', 'xhigh'].includes(thinking)) {
    refuse('THINKING_UNSUPPORTED', '/policy/selection/thinking');
  }
}

export function resolveBuiltInPiCatalogModel(provider: string, modelId: string, api?: string): CatalogModelRecord | null {
  if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(provider)) return null;
  const filePath = fileURLToPath(new URL(`./providers/data/${provider}.json`, import.meta.resolve('@earendil-works/pi-ai')));
  if (!existsSync(filePath)) return null;
  const data = JSON.parse(readFileSync(filePath, 'utf8')) as Record<string, Record<string, {
    id?: string;
    api?: string;
    provider?: string;
    baseUrl?: string;
    reasoning?: boolean;
    contextWindow?: number;
    maxTokens?: number;
    thinkingLevelMap?: Record<string, string | null>;
    cost?: unknown;
  }>>;
  const apis = api !== undefined ? [api] : PI_WIRE_APIS;
  for (const candidateApi of apis) {
    const entry = data[candidateApi]?.['chat:' + modelId];
    if (!entry || entry.id !== modelId || entry.api !== candidateApi || entry.provider !== provider || typeof entry.baseUrl !== 'string') {
      continue;
    }
    if (!Number.isSafeInteger(entry.contextWindow) || (entry.contextWindow ?? 0) <= 0 || !Number.isSafeInteger(entry.maxTokens) || (entry.maxTokens ?? 0) <= 0) {
      continue;
    }
    const cost = extractBuiltInModelCost(entry.cost);
    return {
      id: entry.id,
      api: entry.api as PiWireApi,
      provider: entry.provider,
      baseUrl: entry.baseUrl,
      reasoning: Boolean(entry.reasoning),
      contextWindow: entry.contextWindow!,
      maxTokens: entry.maxTokens!,
      ...(entry.thinkingLevelMap ? { thinkingLevelMap: entry.thinkingLevelMap } : {}),
      ...(cost ? { cost } : {}),
    };
  }
  return null;
}

export function resolveCatalogModel(selection: PiModelSelection): { readonly record: CatalogModelRecord; readonly rawForDigest: unknown } {
  if (DISALLOWED_ADAPTER_OAUTH_PROVIDERS.has(selection.provider)) {
    refuse('SEND_PATH_UNSUPPORTED', '/policy/selection');
  }
  if (!(PI_WIRE_APIS as readonly string[]).includes(selection.api)) {
    refuse('SEND_PATH_UNSUPPORTED', '/policy/selection');
  }

  // Preserve exact legacy internal S03/S04 behavior for github-copilot fixtures without customProvider.
  if (selection.provider === 'github-copilot' && !selection.customProvider) {
    if (selection.api !== 'anthropic-messages') refuse('SEND_PATH_UNSUPPORTED', '/policy/selection');
    const data = JSON.parse(readFileSync(new URL('./providers/data/github-copilot.json', import.meta.resolve('@earendil-works/pi-ai')), 'utf8')) as Record<string, Record<string, {
      api: string; provider: string; id: string; baseUrl: string; reasoning?: boolean; contextWindow: number; maxTokens: number; thinkingLevelMap: Record<string, string | null>;
    }>>;
    const model = data['anthropic-messages']?.['chat:' + selection.model];
    if (!model || model.id !== selection.model || model.api !== selection.api || model.provider !== selection.provider || (selection.model !== 'claude-sonnet-5.5' && selection.model !== 'claude-opus-5.5')) {
      refuse('MODEL_UNAVAILABLE', '/policy/selection/model');
    }
    const expectedThinking = selection.model === 'claude-sonnet-5.5' ? 'xhigh' : 'high';
    if (selection.thinking !== expectedThinking || model.thinkingLevelMap[selection.thinking] !== selection.thinking) {
      refuse('THINKING_UNSUPPORTED', '/policy/selection/thinking');
    }
    return {
      record: {
        id: model.id,
        api: 'anthropic-messages',
        provider: model.provider,
        baseUrl: model.baseUrl,
        reasoning: Boolean(model.reasoning),
        contextWindow: model.contextWindow,
        maxTokens: model.maxTokens,
        thinkingLevelMap: model.thinkingLevelMap,
      },
      rawForDigest: model,
    };
  }

  if (selection.provider === 'github-copilot') {
    refuse('SEND_PATH_UNSUPPORTED', '/policy/selection');
  }

  if (selection.customProvider) {
    const cp = selection.customProvider;
    validateProviderBaseUrl(cp.baseUrl, '/policy/selection/customProvider/baseUrl');
    const record: CatalogModelRecord = {
      id: selection.model,
      api: selection.api,
      provider: selection.provider,
      baseUrl: cp.baseUrl,
      reasoning: cp.reasoning,
      contextWindow: cp.contextWindow,
      maxTokens: cp.maxTokens,
      ...(cp.thinkingLevelMap ? { thinkingLevelMap: cp.thinkingLevelMap } : {}),
      ...(cp.cost ? { cost: cp.cost } : {}),
    };
    validateThinkingAgainstModel(selection.thinking, record);
    return { record, rawForDigest: { provider: selection.provider, model: selection.model, api: selection.api, customProvider: cp } };
  }

  const filePath = /^[a-z0-9][a-z0-9-]{0,63}$/.test(selection.provider)
    ? fileURLToPath(new URL(`./providers/data/${selection.provider}.json`, import.meta.resolve('@earendil-works/pi-ai')))
    : '';
  if (!filePath || !existsSync(filePath)) {
    refuse('MODEL_UNAVAILABLE', '/policy/selection/model');
  }
  const data = JSON.parse(readFileSync(filePath, 'utf8')) as Record<string, Record<string, Record<string, unknown>>>;
  const rawModel = data[selection.api]?.['chat:' + selection.model];
  const resolved = resolveBuiltInPiCatalogModel(selection.provider, selection.model, selection.api);
  if (!rawModel || !resolved) {
    refuse('MODEL_UNAVAILABLE', '/policy/selection/model');
  }
  validateProviderBaseUrl(resolved.baseUrl, '/policy/selection');
  validateThinkingAgainstModel(selection.thinking, resolved);
  return { record: resolved, rawForDigest: rawModel };
}

export function resolveProviderDestination(selection: PiModelSelection): string {
  if (selection.provider === 'github-copilot' && !selection.customProvider) {
    return LEGACY_COPILOT_DESTINATION;
  }
  const { record } = resolveCatalogModel(selection);
  const base = record.baseUrl.replace(/\/+$/, '');
  switch (selection.api) {
    case 'openai-completions':
      return `${base}/chat/completions`;
    case 'openai-responses':
      return `${base}/responses`;
    case 'anthropic-messages':
      return `${base.endsWith('/v1') ? base : `${base}/v1`}/messages?beta=true`;
  }
}

export function resolveProviderAuthHeaderName(selection: PiModelSelection): 'authorization' | 'x-api-key' {
  if (selection.api === 'anthropic-messages' && selection.provider !== 'github-copilot' && selection.customProvider?.authHeader !== true) {
    return 'x-api-key';
  }
  return 'authorization';
}

/** Read the selected pinned artifact once per construction, then retain its validated window and identity. */
export function selectedCatalog(input: PiOpenInput): CatalogIdentity {
  const { record, rawForDigest } = resolveCatalogModel(input.policy.selection);
  if (
    !Number.isSafeInteger(record.contextWindow) ||
    record.contextWindow <= 0 ||
    record.maxTokens < input.policy.context.maxOutputTokens ||
    Math.min(record.contextWindow, input.policy.context.workingWindowCeiling) <
      input.policy.context.serviceMargin + input.policy.context.toolReserve + input.policy.context.maxOutputTokens
  ) {
    refuse('CONTEXT_UNSAFE', '/policy/context');
  }
  return freeze({ contextWindow: record.contextWindow, digest: digest(Buffer.from(canonical(rawForDigest))) });
}
