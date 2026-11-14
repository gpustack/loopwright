import { resolve } from 'node:path';
import {
  PI_OAUTH_ONLY_PROVIDERS, PI_THINKING_LEVELS, PI_WIRE_APIS, STANDARD_PI_PROVIDER_ENV,
  isOAuthOnlyPiProvider, resolveBuiltInPiCatalogModel, resolveProviderAuthHeaderName, resolveProviderDestination,
  validateCustomProviderConfig, validateProviderBaseUrl, validateSelection,
} from '@loopwright/agent-pi/catalog';
import { SecretScrubber } from './token-broker.js';
import { readBoundedRegularFile } from './yaml.js';
import {
  GitHubAppError, MAX_EXPANDED_MODEL_CANDIDATES, MAX_TASKPACK_MODEL_CANDIDATES, TASKPACK_MANIFEST_BYTES,
  type HostTaskpackBindings, type ModelCandidateProbeAttempt, type ModelCandidateSelectionResult,
  type PiCustomModelCompat, type PiCustomProviderConfig, type PiModelCost, type PiModelSelection, type PiSamplingParams,
  type PiThinkingLevel, type PiWireApi, type ResolvedModelCandidate, type TaskpackManifest,
  type TaskpackModelDeclaration,
} from './types.js';

const PROVIDER_ID_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const ENV_NAME_PATTERN = /^[A-Z][A-Z0-9_]*$/;
const VAULT_TOKEN_PATTERN = /^[A-Za-z0-9._~+/-]+=*$/;
const ENV_INTERPOLATION_PATTERN = /^(?:\$\{([A-Z][A-Z0-9_]*)\}|\$([A-Z][A-Z0-9_]*)|([A-Z][A-Z0-9_]*))$/;
const FORBIDDEN_HEADER_NAMES = new Set([
  'authorization', 'x-api-key', 'api-key', 'x-goog-api-key', 'cookie', 'proxy-authorization', 'host', 'content-length',
]);
const SAMPLING_KEYS = ['temperature', 'top_p', 'top_k', 'min_p', 'presence_penalty', 'repetition_penalty'] as const;
const COMPAT_BOOLEAN_KEYS = [
  'supportsStore', 'supportsDeveloperRole', 'supportsReasoningEffort', 'supportsUsageInStreaming',
  'requiresToolResultName', 'requiresAssistantAfterToolResult', 'requiresThinkingAsText',
  'supportsStrictMode', 'zaiToolStream',
] as const;
const COMPAT_ALL_KEYS = [...COMPAT_BOOLEAN_KEYS, 'maxTokensField', 'thinkingFormat'] as const;
const THINKING_FORMATS = ['openai', 'zai', 'qwen', 'qwen-chat-template', 'openrouter', 'deepseek'] as const;
const MODEL_COST_KEYS = ['input', 'output', 'cacheRead', 'cacheWrite'] as const;
const PROBE_MAX_RESPONSE_BYTES = 65_536;
const DEFAULT_PROBE_TOTAL_TIMEOUT_MS = 30_000;
const DEFAULT_PROBE_CANDIDATE_TIMEOUT_MS = 15_000;

export const DEFAULT_PI_PROVIDER = 'zai' as const;
export const DEFAULT_PI_MODEL = 'glm-5.3' as const;
export const DEFAULT_PI_THINKING: PiThinkingLevel = 'high';
export const LOOPWRIGHT_ACTIVE_PROVIDER_TOKEN_ENV = 'LOOPWRIGHT_ACTIVE_PROVIDER_TOKEN' as const;

function isOneOf<T extends string>(list: readonly T[], value: unknown): value is T {
  return typeof value === 'string' && list.some(item => item === value);
}

function errorCode(err: unknown): string {
  return err !== null && typeof err === 'object' && 'code' in err ? String(err.code) : '';
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto: unknown = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function manifestInvalid(message: string, path: string): never {
  throw new GitHubAppError('TASKPACK_MANIFEST_INVALID', message, path);
}

function oauthUnsupported(message: string, path: string | null = null): never {
  throw new GitHubAppError('PROVIDER_OAUTH_UNSUPPORTED', message, path);
}

function bindingInvalid(message: string, path: string | null = null): never {
  throw new GitHubAppError('TASKPACK_HOST_BINDING_INVALID', message, path);
}

function validateSamplingObject(
  raw: unknown,
  path: string,
  fail: (msg: string, p: string) => never,
): PiSamplingParams {
  if (!isPlainRecord(raw)) fail('samplingParams must be an object', path);
  const out: { -readonly [K in keyof PiSamplingParams]: PiSamplingParams[K] } = {};
  for (const [key, val] of Object.entries(raw)) {
    if (!isOneOf(SAMPLING_KEYS, key)) fail(`unknown sampling parameter "${key}"`, `${path}/${key}`);
    if (typeof val !== 'number' || !Number.isFinite(val) || Object.is(val, -0)) {
      fail(`sampling parameter "${key}" must be a finite number`, `${path}/${key}`);
    }
    if (key === 'top_k') {
      if (!Number.isSafeInteger(val) || val < 0 || val > 100_000) fail('top_k must be an integer in [0, 100000]', `${path}/${key}`);
    } else if (val < -4 || val > 4) {
      fail(`sampling parameter "${key}" must be within [-4, 4]`, `${path}/${key}`);
    }
    out[key] = val;
  }
  return Object.freeze(out);
}

function validateCompatObject(
  raw: unknown,
  path: string,
  fail: (msg: string, p: string) => never,
): PiCustomModelCompat {
  if (!isPlainRecord(raw)) fail('compat must be an object', path);
  const out: { -readonly [K in keyof PiCustomModelCompat]: PiCustomModelCompat[K] } = {};
  for (const [key, val] of Object.entries(raw)) {
    if (!isOneOf(COMPAT_ALL_KEYS, key)) fail(`unknown compat field "${key}"`, `${path}/${key}`);
    if (isOneOf(COMPAT_BOOLEAN_KEYS, key)) {
      if (typeof val !== 'boolean') fail(`compat.${key} must be a boolean`, `${path}/${key}`);
      out[key] = val;
    } else if (key === 'maxTokensField') {
      if (val !== 'max_completion_tokens' && val !== 'max_tokens') {
        fail('compat.maxTokensField must be "max_completion_tokens" or "max_tokens"', `${path}/${key}`);
      }
      out.maxTokensField = val;
    } else if (key === 'thinkingFormat') {
      if (!isOneOf(THINKING_FORMATS, val)) {
        fail(`compat.thinkingFormat must be one of ${THINKING_FORMATS.join(', ')}`, `${path}/${key}`);
      }
      out.thinkingFormat = val;
    }
  }
  return Object.freeze(out);
}

function validateHeadersObject(
  raw: unknown,
  path: string,
  fail: (msg: string, p: string) => never,
): Readonly<Record<string, string>> {
  if (!isPlainRecord(raw)) fail('headers must be an object', path);
  const entries = Object.entries(raw);
  if (entries.length > 32) fail('headers may contain at most 32 entries', path);
  const out: Record<string, string> = {};
  for (const [key, val] of entries) {
    const lower = key.toLowerCase();
    if (!/^[A-Za-z0-9-]{1,128}$/.test(key) || FORBIDDEN_HEADER_NAMES.has(lower)) {
      fail(`header "${key}" is forbidden or invalid; pass credentials via environment bindings only`, `${path}/${key}`);
    }
    if (typeof val !== 'string' || val.length > 1024 || /[\0\r\n]/.test(val)) {
      fail(`header "${key}" must be a single-line string of at most 1024 characters`, `${path}/${key}`);
    }
    if (val.startsWith('!')) {
      oauthUnsupported(`shell command header resolvers (!command) are unsupported on "${key}"`, `${path}/${key}`);
    }
    out[key] = val;
  }
  return Object.freeze(out);
}

function validateThinkingLevelMapObject(
  raw: unknown,
  path: string,
  fail: (msg: string, p: string) => never,
): Readonly<Record<string, string | null>> {
  if (!isPlainRecord(raw)) fail('thinkingLevelMap must be an object', path);
  const out: Record<string, string | null> = {};
  for (const [key, val] of Object.entries(raw)) {
    if (!isOneOf(PI_THINKING_LEVELS, key)) {
      fail(`thinkingLevelMap key "${key}" must be a valid Pi thinking level`, `${path}/${key}`);
    }
    if (val !== null && (typeof val !== 'string' || val.length < 1 || val.length > 64 || /\s/.test(val))) {
      fail(`thinkingLevelMap["${key}"] must be null or a non-empty token`, `${path}/${key}`);
    }
    out[key] = val;
  }
  return Object.freeze(out);
}

function validateSamplingByThinkingObject(
  raw: unknown,
  path: string,
  fail: (msg: string, p: string) => never,
): Readonly<Record<string, PiSamplingParams>> {
  if (!isPlainRecord(raw)) fail('samplingParamsByThinkingLevel must be an object', path);
  const out: Record<string, PiSamplingParams> = {};
  for (const [key, val] of Object.entries(raw)) {
    if (!isOneOf(PI_THINKING_LEVELS, key)) {
      fail(`samplingParamsByThinkingLevel key "${key}" must be a valid Pi thinking level`, `${path}/${key}`);
    }
    out[key] = validateSamplingObject(val, `${path}/${key}`, fail);
  }
  return Object.freeze(out);
}

function validateModelCostObject(
  raw: unknown,
  path: string,
  fail: (msg: string, p: string) => never,
): PiModelCost {
  if (!isPlainRecord(raw)) fail('cost must be an object', path);
  for (const key of Object.keys(raw)) {
    if (!isOneOf(MODEL_COST_KEYS, key)) {
      fail(`unknown cost field "${key}"`, `${path}/${key}`);
    }
  }
  if (!Object.hasOwn(raw, 'input') || !Object.hasOwn(raw, 'output')) {
    fail('cost must include required "input" and "output" rates', path);
  }
  const out: { input: number; output: number; cacheRead?: number; cacheWrite?: number } = { input: 0, output: 0 };
  for (const key of MODEL_COST_KEYS) {
    if (!Object.hasOwn(raw, key)) continue;
    const val = raw[key];
    if (typeof val !== 'number' || !Number.isFinite(val) || Object.is(val, -0) || val < 0 || val > 1_000_000) {
      fail(`cost.${key} must be a finite number in [0, 1000000]`, `${path}/${key}`);
    }
    out[key] = val;
  }
  return Object.freeze(out);
}

/** Validate a single entry inside `spec.models` in `.loopwright/taskpack.yaml`. */
export function validateTaskpackModelDeclaration(raw: unknown, path = '/spec/models/0'): TaskpackModelDeclaration {
  if (!isPlainRecord(raw)) manifestInvalid('spec.models entry must be an object', path);
  if (Object.hasOwn(raw, 'oauth')) {
    oauthUnsupported('OAuth model authentication is unsupported; configure a token-based Pi provider', `${path}/oauth`);
  }
  if (Object.hasOwn(raw, 'apiKey')) {
    manifestInvalid('literal apiKey is forbidden in taskpack.yaml; use apiKeyEnv with an environment variable name', `${path}/apiKey`);
  }
  const allowed = [
    'provider', 'id', 'thinking', 'api', 'apiKeyEnv', 'baseUrl', 'authHeader', 'headers',
    'contextWindow', 'maxTokens', 'reasoning', 'thinkingLevelMap', 'samplingParams',
    'samplingParamsByThinkingLevel', 'compat', 'cost',
  ];
  for (const key of Object.keys(raw)) {
    if (!allowed.includes(key)) manifestInvalid(`unknown field "${key}" in spec.models entry`, `${path}/${key}`);
  }
  const provider = raw['provider'];
  if (typeof provider !== 'string' || !PROVIDER_ID_PATTERN.test(provider) || provider.includes('..')) {
    manifestInvalid('spec.models[].provider must be a lowercase Pi provider identifier', `${path}/provider`);
  }
  if (isOAuthOnlyPiProvider(provider)) {
    oauthUnsupported(
      `Pi provider "${provider}" uses OAuth or CLI login (${PI_OAUTH_ONLY_PROVIDERS.join(', ')}), which Loopwright refuses; use a token-authenticated Pi provider`,
      `${path}/provider`,
    );
  }
  const id = raw['id'];
  if (typeof id !== 'string' || id.length < 1 || id.length > 128 || /[\s\0\r\n]/.test(id)) {
    manifestInvalid('spec.models[].id must be a non-empty model identifier of at most 128 characters', `${path}/id`);
  }
  const result: {
    provider: string;
    id: string;
    thinking?: PiThinkingLevel;
    api?: PiWireApi;
    apiKeyEnv?: string;
    baseUrl?: string;
    authHeader?: boolean;
    headers?: Readonly<Record<string, string>>;
    contextWindow?: number;
    maxTokens?: number;
    reasoning?: boolean;
    thinkingLevelMap?: Readonly<Record<string, string | null>>;
    samplingParams?: PiSamplingParams;
    samplingParamsByThinkingLevel?: Readonly<Record<string, PiSamplingParams>>;
    compat?: PiCustomModelCompat;
    cost?: PiModelCost;
  } = { provider, id };

  if (raw['thinking'] !== undefined) {
    if (!isOneOf(PI_THINKING_LEVELS, raw['thinking'])) {
      manifestInvalid(`spec.models[].thinking must be one of ${PI_THINKING_LEVELS.join(', ')}`, `${path}/thinking`);
    }
    result.thinking = raw['thinking'];
  }
  if (raw['api'] !== undefined) {
    if (!isOneOf(PI_WIRE_APIS, raw['api'])) {
      manifestInvalid(`spec.models[].api must be one of ${PI_WIRE_APIS.join(', ')}`, `${path}/api`);
    }
    result.api = raw['api'];
  }
  if (raw['apiKeyEnv'] !== undefined) {
    if (typeof raw['apiKeyEnv'] !== 'string') {
      manifestInvalid('spec.models[].apiKeyEnv must be an environment variable name matching [A-Z][A-Z0-9_]*', `${path}/apiKeyEnv`);
    }
    if (raw['apiKeyEnv'].startsWith('!')) {
      oauthUnsupported('shell command credential resolvers (!command) are unsupported', `${path}/apiKeyEnv`);
    }
    if (!ENV_NAME_PATTERN.test(raw['apiKeyEnv'])) {
      manifestInvalid('spec.models[].apiKeyEnv must match [A-Z][A-Z0-9_]*', `${path}/apiKeyEnv`);
    }
    result.apiKeyEnv = raw['apiKeyEnv'];
  }
  if (raw['baseUrl'] !== undefined) {
    try {
      result.baseUrl = validateProviderBaseUrl(raw['baseUrl'], `${path}/baseUrl`);
    } catch {
      manifestInvalid('spec.models[].baseUrl must be an https:// URL (or explicit-port http://127.0.0.1 loopback URL) without query, hash, or credentials', `${path}/baseUrl`);
    }
  }
  if (raw['authHeader'] !== undefined) {
    if (typeof raw['authHeader'] !== 'boolean') manifestInvalid('spec.models[].authHeader must be a boolean', `${path}/authHeader`);
    result.authHeader = raw['authHeader'];
  }
  if (raw['headers'] !== undefined) {
    result.headers = validateHeadersObject(raw['headers'], `${path}/headers`, manifestInvalid);
  }
  if (raw['contextWindow'] !== undefined) {
    const cw = raw['contextWindow'];
    if (typeof cw !== 'number' || !Number.isSafeInteger(cw) || cw < 1024 || cw > 10_000_000) {
      manifestInvalid('spec.models[].contextWindow must be an integer in [1024, 10000000]', `${path}/contextWindow`);
    }
    result.contextWindow = cw;
  }
  if (raw['maxTokens'] !== undefined) {
    const mt = raw['maxTokens'];
    if (typeof mt !== 'number' || !Number.isSafeInteger(mt) || mt < 1 || mt > 1_048_576) {
      manifestInvalid('spec.models[].maxTokens must be an integer in [1, 1048576]', `${path}/maxTokens`);
    }
    result.maxTokens = mt;
  }
  if (raw['reasoning'] !== undefined) {
    if (typeof raw['reasoning'] !== 'boolean') manifestInvalid('spec.models[].reasoning must be a boolean', `${path}/reasoning`);
    result.reasoning = raw['reasoning'];
  }
  if (raw['thinkingLevelMap'] !== undefined) {
    result.thinkingLevelMap = validateThinkingLevelMapObject(raw['thinkingLevelMap'], `${path}/thinkingLevelMap`, manifestInvalid);
  }
  if (raw['samplingParams'] !== undefined) {
    result.samplingParams = validateSamplingObject(raw['samplingParams'], `${path}/samplingParams`, manifestInvalid);
  }
  if (raw['samplingParamsByThinkingLevel'] !== undefined) {
    result.samplingParamsByThinkingLevel = validateSamplingByThinkingObject(raw['samplingParamsByThinkingLevel'], `${path}/samplingParamsByThinkingLevel`, manifestInvalid);
  }
  if (raw['compat'] !== undefined) {
    result.compat = validateCompatObject(raw['compat'], `${path}/compat`, manifestInvalid);
  }
  if (raw['cost'] !== undefined) {
    result.cost = validateModelCostObject(raw['cost'], `${path}/cost`, manifestInvalid);
  }
  return Object.freeze(result);
}

/** Validate `spec.models` (`1..8` ordered model candidates) inside `.loopwright/taskpack.yaml`. */
export function validateTaskpackModelsDeclaration(raw: unknown, path = '/spec/models'): readonly TaskpackModelDeclaration[] {
  if (!Array.isArray(raw) || raw.length < 1 || raw.length > MAX_TASKPACK_MODEL_CANDIDATES) {
    manifestInvalid(`spec.models must be an array of 1..${MAX_TASKPACK_MODEL_CANDIDATES} model entries`, path);
  }
  return Object.freeze(raw.map((entry, idx) => validateTaskpackModelDeclaration(entry, `${path}/${idx}`)));
}

// ---------------------------------------------------------------------------
// Pi models.json loader (aligned with @earendil-works/pi-coding-agent models.json)
// ---------------------------------------------------------------------------

export interface ParsedPiModelEntry {
  readonly id: string;
  readonly api?: PiWireApi;
  readonly baseUrl?: string;
  readonly reasoning?: boolean;
  readonly thinkingLevelMap?: Readonly<Record<string, string | null>>;
  readonly contextWindow?: number;
  readonly maxTokens?: number;
  readonly samplingParams?: PiSamplingParams;
  readonly samplingParamsByThinkingLevel?: Readonly<Record<string, PiSamplingParams>>;
  readonly headers?: Readonly<Record<string, string>>;
  readonly compat?: PiCustomModelCompat;
  readonly cost?: PiModelCost;
}

export interface ParsedPiProviderEntry {
  readonly id: string;
  readonly baseUrl?: string;
  readonly api?: PiWireApi;
  readonly apiKeyEnv?: string;
  readonly authHeader?: boolean;
  readonly headers?: Readonly<Record<string, string>>;
  readonly compat?: PiCustomModelCompat;
  readonly models: ReadonlyMap<string, ParsedPiModelEntry>;
  readonly modelOverrides: ReadonlyMap<string, Omit<ParsedPiModelEntry, 'id'>>;
}

export interface ParsedPiModelsJson {
  readonly providers: ReadonlyMap<string, ParsedPiProviderEntry>;
}

function parseModelOverrideFields(raw: Record<string, unknown>, path: string): Omit<ParsedPiModelEntry, 'id'> {
  const out: {
    api?: PiWireApi;
    baseUrl?: string;
    reasoning?: boolean;
    thinkingLevelMap?: Readonly<Record<string, string | null>>;
    contextWindow?: number;
    maxTokens?: number;
    samplingParams?: PiSamplingParams;
    samplingParamsByThinkingLevel?: Readonly<Record<string, PiSamplingParams>>;
    headers?: Readonly<Record<string, string>>;
    compat?: PiCustomModelCompat;
    cost?: PiModelCost;
  } = {};
  if (raw['api'] !== undefined) {
    if (!isOneOf(PI_WIRE_APIS, raw['api'])) {
      bindingInvalid(`models.json api must be one of ${PI_WIRE_APIS.join(', ')}`, `${path}/api`);
    }
    out.api = raw['api'];
  }
  if (raw['baseUrl'] !== undefined) {
    try { out.baseUrl = validateProviderBaseUrl(raw['baseUrl'], `${path}/baseUrl`); }
    catch { bindingInvalid('models.json baseUrl must be a valid https:// or loopback URL without query or credentials', `${path}/baseUrl`); }
  }
  if (raw['reasoning'] !== undefined) {
    if (typeof raw['reasoning'] !== 'boolean') bindingInvalid('models.json reasoning must be a boolean', `${path}/reasoning`);
    out.reasoning = raw['reasoning'];
  }
  if (raw['thinkingLevelMap'] !== undefined) {
    out.thinkingLevelMap = validateThinkingLevelMapObject(raw['thinkingLevelMap'], `${path}/thinkingLevelMap`, bindingInvalid);
  }
  if (raw['contextWindow'] !== undefined) {
    const cw = raw['contextWindow'];
    if (typeof cw !== 'number' || !Number.isSafeInteger(cw) || cw < 1024 || cw > 10_000_000) {
      bindingInvalid('models.json contextWindow must be an integer in [1024, 10000000]', `${path}/contextWindow`);
    }
    out.contextWindow = cw;
  }
  if (raw['maxTokens'] !== undefined) {
    const mt = raw['maxTokens'];
    if (typeof mt !== 'number' || !Number.isSafeInteger(mt) || mt < 1 || mt > 1_048_576) {
      bindingInvalid('models.json maxTokens must be an integer in [1, 1048576]', `${path}/maxTokens`);
    }
    out.maxTokens = mt;
  }
  if (raw['samplingParams'] !== undefined) {
    out.samplingParams = validateSamplingObject(raw['samplingParams'], `${path}/samplingParams`, bindingInvalid);
  }
  if (raw['samplingParamsByThinkingLevel'] !== undefined) {
    out.samplingParamsByThinkingLevel = validateSamplingByThinkingObject(raw['samplingParamsByThinkingLevel'], `${path}/samplingParamsByThinkingLevel`, bindingInvalid);
  }
  if (raw['headers'] !== undefined) {
    out.headers = validateHeadersObject(raw['headers'], `${path}/headers`, bindingInvalid);
  }
  if (raw['compat'] !== undefined) {
    out.compat = validateCompatObject(raw['compat'], `${path}/compat`, bindingInvalid);
  }
  if (raw['cost'] !== undefined) {
    out.cost = validateModelCostObject(raw['cost'], `${path}/cost`, bindingInvalid);
  }
  return Object.freeze(out);
}

/** Parse a Pi `models.json` document while enforcing token-only auth and Loopwright send-path boundaries. */
export function parsePiModelsJson(bytes: Uint8Array): ParsedPiModelsJson {
  if (bytes.byteLength > TASKPACK_MANIFEST_BYTES) {
    bindingInvalid(`models.json exceeds ${TASKPACK_MANIFEST_BYTES} bytes`, '/');
  }
  let text: string;
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
  catch { bindingInvalid('models.json is not valid UTF-8', '/'); }
  let parsed: unknown;
  try { parsed = JSON.parse(text); }
  catch { bindingInvalid('models.json is not valid JSON', '/'); }
  if (!isPlainRecord(parsed)) bindingInvalid('models.json root must be an object', '/');
  for (const rootKey of Object.keys(parsed)) {
    if (rootKey !== '$schema' && rootKey !== 'providers') {
      bindingInvalid(`unknown top-level field "${rootKey}" in models.json`, `/${rootKey}`);
    }
  }
  const providersRaw = parsed['providers'];
  if (!isPlainRecord(providersRaw)) bindingInvalid('models.json must contain a "providers" object', '/providers');
  const providers = new Map<string, ParsedPiProviderEntry>();
  for (const [providerId, entryRaw] of Object.entries(providersRaw)) {
    const pPath = `/providers/${providerId}`;
    if (!PROVIDER_ID_PATTERN.test(providerId) || providerId.includes('..')) {
      bindingInvalid(`invalid provider id "${providerId}" in models.json`, pPath);
    }
    if (isOAuthOnlyPiProvider(providerId)) {
      oauthUnsupported(`Pi provider "${providerId}" uses OAuth or CLI login, which Loopwright refuses`, pPath);
    }
    if (!isPlainRecord(entryRaw)) bindingInvalid('provider entry must be an object', pPath);
    if (entryRaw['oauth'] !== undefined) {
      oauthUnsupported(`models.json provider "${providerId}" declares OAuth login, which Loopwright refuses`, `${pPath}/oauth`);
    }
    const allowedProviderKeys = ['name', 'baseUrl', 'apiKey', 'api', 'headers', 'compat', 'authHeader', 'models', 'modelOverrides'];
    for (const k of Object.keys(entryRaw)) {
      if (!allowedProviderKeys.includes(k)) bindingInvalid(`unknown field "${k}" in models.json provider "${providerId}"`, `${pPath}/${k}`);
    }
    const entry: {
      id: string;
      baseUrl?: string;
      api?: PiWireApi;
      apiKeyEnv?: string;
      authHeader?: boolean;
      headers?: Readonly<Record<string, string>>;
      compat?: PiCustomModelCompat;
      models: Map<string, ParsedPiModelEntry>;
      modelOverrides: Map<string, Omit<ParsedPiModelEntry, 'id'>>;
    } = { id: providerId, models: new Map(), modelOverrides: new Map() };

    if (entryRaw['baseUrl'] !== undefined) {
      try { entry.baseUrl = validateProviderBaseUrl(entryRaw['baseUrl'], `${pPath}/baseUrl`); }
      catch { bindingInvalid(`invalid baseUrl in models.json provider "${providerId}"`, `${pPath}/baseUrl`); }
    }
    if (entryRaw['api'] !== undefined) {
      if (!isOneOf(PI_WIRE_APIS, entryRaw['api'])) {
        bindingInvalid(`models.json provider "${providerId}" api must be one of ${PI_WIRE_APIS.join(', ')}`, `${pPath}/api`);
      }
      entry.api = entryRaw['api'];
    }
    if (entryRaw['apiKey'] !== undefined) {
      if (typeof entryRaw['apiKey'] !== 'string') bindingInvalid('models.json apiKey must be a string', `${pPath}/apiKey`);
      if (entryRaw['apiKey'].startsWith('!')) {
        oauthUnsupported(`shell command apiKey resolvers (!command) in models.json are unsupported`, `${pPath}/apiKey`);
      }
      const match = ENV_INTERPOLATION_PATTERN.exec(entryRaw['apiKey']);
      const envName = match?.[1] ?? match?.[2] ?? match?.[3];
      if (!envName) {
        bindingInvalid(
          'models.json apiKey in Loopwright must reference an uppercase environment variable ($ENV_VAR, ${ENV_VAR}, or ENV_VAR), never a literal secret',
          `${pPath}/apiKey`,
        );
      }
      entry.apiKeyEnv = envName;
    }
    if (entryRaw['authHeader'] !== undefined) {
      if (typeof entryRaw['authHeader'] !== 'boolean') bindingInvalid('models.json authHeader must be a boolean', `${pPath}/authHeader`);
      entry.authHeader = entryRaw['authHeader'];
    }
    if (entryRaw['headers'] !== undefined) {
      entry.headers = validateHeadersObject(entryRaw['headers'], `${pPath}/headers`, bindingInvalid);
    }
    if (entryRaw['compat'] !== undefined) {
      entry.compat = validateCompatObject(entryRaw['compat'], `${pPath}/compat`, bindingInvalid);
    }
    if (entryRaw['models'] !== undefined) {
      if (!Array.isArray(entryRaw['models']) || entryRaw['models'].length > 128) {
        bindingInvalid('models.json models must be an array of at most 128 entries', `${pPath}/models`);
      }
      for (const [idx, mRaw] of entryRaw['models'].entries()) {
        const mPath = `${pPath}/models/${idx}`;
        if (!isPlainRecord(mRaw)) bindingInvalid('model entry must be an object', mPath);
        const mId = mRaw['id'];
        if (typeof mId !== 'string' || mId.length < 1 || mId.length > 128 || /[\s\0\r\n]/.test(mId)) {
          bindingInvalid('model id must be a non-empty string without whitespace', `${mPath}/id`);
        }
        const overrides = parseModelOverrideFields(mRaw, mPath);
        entry.models.set(mId, Object.freeze({ id: mId, ...overrides }));
      }
    }
    if (entryRaw['modelOverrides'] !== undefined) {
      if (!isPlainRecord(entryRaw['modelOverrides'])) bindingInvalid('modelOverrides must be an object', `${pPath}/modelOverrides`);
      for (const [mId, oRaw] of Object.entries(entryRaw['modelOverrides'])) {
        const oPath = `${pPath}/modelOverrides/${mId}`;
        if (!isPlainRecord(oRaw)) bindingInvalid('modelOverride entry must be an object', oPath);
        entry.modelOverrides.set(mId, parseModelOverrideFields(oRaw, oPath));
      }
    }
    providers.set(providerId, Object.freeze(entry));
  }
  return Object.freeze({ providers });
}

export async function loadPiModelsJson(filePath: string): Promise<ParsedPiModelsJson> {
  const resolved = resolve(filePath);
  const bytes = await readBoundedRegularFile(resolved, TASKPACK_MANIFEST_BYTES, message => bindingInvalid(`models.json unreadable: ${message}`, '/'));
  return parsePiModelsJson(bytes);
}

// ---------------------------------------------------------------------------
// Candidate resolution, comma-separated token expansion, and readiness probing
// ---------------------------------------------------------------------------

export function resolveDefaultProviderTokenEnv(
  provider: string,
  options: {
    readonly explicitEnv?: string | undefined;
    readonly modelsJsonApiKeyEnv?: string | undefined;
    readonly manifestApiKeyEnv?: string | undefined;
    readonly env?: NodeJS.ProcessEnv | undefined;
  } = {},
): string {
  if (options.explicitEnv !== undefined) return options.explicitEnv;
  if (options.modelsJsonApiKeyEnv !== undefined) return options.modelsJsonApiKeyEnv;
  if (options.manifestApiKeyEnv !== undefined) return options.manifestApiKeyEnv;
  const standardEnv = STANDARD_PI_PROVIDER_ENV[provider];
  if (standardEnv !== undefined && options.env !== undefined) {
    const hasStandard = typeof options.env[standardEnv] === 'string' && options.env[standardEnv]!.length > 0;
    const hasGeneric = typeof options.env['LOOPWRIGHT_PROVIDER_TOKEN'] === 'string' && options.env['LOOPWRIGHT_PROVIDER_TOKEN']!.length > 0;
    if (hasStandard && !hasGeneric) return standardEnv;
  }
  return 'LOOPWRIGHT_PROVIDER_TOKEN';
}

/**
 * Split a raw provider token environment variable into ordered deduplicated tokens.
 * Supports comma-separated token pools (`tok1,tok2`), validates vault-safe token characters,
 * and registers every token into `scrubber` immediately.
 */
export function splitProviderTokens(
  rawValue: string | undefined,
  envName: string,
  scrubber?: SecretScrubber,
): readonly string[] {
  if (rawValue === undefined || rawValue.trim().length === 0) return Object.freeze([]);
  const seen = new Set<string>();
  const tokens: string[] = [];
  for (const part of rawValue.split(',')) {
    const trimmed = part.trim();
    if (trimmed.length === 0) continue;
    if (trimmed.length > 4096 || !VAULT_TOKEN_PATTERN.test(trimmed)) {
      scrubber?.register(trimmed);
      bindingInvalid(`provider token in environment variable "${envName}" contains invalid characters or exceeds 4096 bytes`, `/credentials/${envName}`);
    }
    scrubber?.register(trimmed);
    if (!seen.has(trimmed)) {
      seen.add(trimmed);
      tokens.push(trimmed);
    }
  }
  return Object.freeze(tokens);
}

function resolveSingleModelEntry(
  manifestModel: TaskpackModelDeclaration | undefined,
  manifestIndex: number,
  bindings: HostTaskpackBindings,
  modelsConfig: ParsedPiModelsJson | undefined,
  applyHostRoleOverrides: boolean,
): { readonly selection: PiModelSelection; readonly apiKeyEnv?: string } {
  const hostRole = applyHostRoleOverrides ? bindings.roleSelection : undefined;
  const entryPath = `/spec/models/${manifestIndex}`;
  const provider = hostRole?.provider ?? manifestModel?.provider ?? DEFAULT_PI_PROVIDER;
  if (!PROVIDER_ID_PATTERN.test(provider) || provider.includes('..')) {
    bindingInvalid(`invalid Pi provider identifier "${provider}"`, '/roleSelection/provider');
  }
  if (isOAuthOnlyPiProvider(provider)) {
    oauthUnsupported(
      `Pi provider "${provider}" uses OAuth or CLI login (${PI_OAUTH_ONLY_PROVIDERS.join(', ')}), which Loopwright refuses; configure a token-based Pi provider`,
      '/roleSelection/provider',
    );
  }
  const modelsProvider = modelsConfig?.providers.get(provider);
  const manifestMatchesProvider = manifestModel !== undefined && manifestModel.provider === provider;
  const effectiveManifest = manifestMatchesProvider ? manifestModel : undefined;

  const model = hostRole?.model
    ?? effectiveManifest?.id
    ?? (provider === 'zai' || provider === 'zai-coding-cn' ? DEFAULT_PI_MODEL : undefined);
  if (model === undefined || model.length < 1 || model.length > 128 || /[\s\0\r\n]/.test(model)) {
    bindingInvalid(`model identifier is required for Pi provider "${provider}"`, '/roleSelection/model');
  }

  const modelsEntry = modelsProvider?.models.get(model);
  const modelsOverride = modelsProvider?.modelOverrides.get(model);

  if (
    effectiveManifest?.baseUrl !== undefined &&
    hostRole?.customProvider?.baseUrl === undefined &&
    hostRole?.baseUrl === undefined &&
    modelsEntry?.baseUrl === undefined &&
    modelsOverride?.baseUrl === undefined &&
    modelsProvider?.baseUrl === undefined &&
    bindings.allowManifestCustomBaseUrl !== true
  ) {
    bindingInvalid(
      'manifest spec.models[].baseUrl requires allowManifestCustomBaseUrl (or host base-url / models.json) so untrusted manifests cannot redirect provider credentials',
      `${entryPath}/baseUrl`,
    );
  }

  const explicitApi = hostRole?.api
    ?? modelsEntry?.api
    ?? modelsOverride?.api
    ?? modelsProvider?.api
    ?? effectiveManifest?.api;
  const builtIn = explicitApi === undefined
    ? resolveBuiltInPiCatalogModel(provider, model)
    : resolveBuiltInPiCatalogModel(provider, model, explicitApi);
  const api: PiWireApi | undefined = explicitApi ?? builtIn?.api;
  if (api === undefined) {
    bindingInvalid(
      `Pi model "${provider}/${model}" is not in the built-in Pi catalog; specify api (${PI_WIRE_APIS.join(', ')}) and baseUrl via custom provider configuration or models.json`,
      '/roleSelection/api',
    );
  }

  const hostCustom = hostRole?.customProvider;
  const mergedBaseUrl = hostCustom?.baseUrl
    ?? hostRole?.baseUrl
    ?? modelsEntry?.baseUrl
    ?? modelsOverride?.baseUrl
    ?? modelsProvider?.baseUrl
    ?? effectiveManifest?.baseUrl;
  const mergedAuthHeader = hostCustom?.authHeader ?? modelsProvider?.authHeader ?? effectiveManifest?.authHeader;
  const mergedHeaders = (() => {
    const parts = [modelsProvider?.headers, effectiveManifest?.headers, modelsOverride?.headers, modelsEntry?.headers, hostCustom?.headers]
      .filter((item): item is Readonly<Record<string, string>> => item !== undefined);
    if (parts.length === 0) return undefined;
    const merged: Record<string, string> = {};
    for (const part of parts) Object.assign(merged, part);
    return Object.freeze(merged);
  })();
  const mergedCompat = (() => {
    const parts = [modelsProvider?.compat, effectiveManifest?.compat, modelsOverride?.compat, modelsEntry?.compat, hostCustom?.compat]
      .filter((item): item is PiCustomModelCompat => item !== undefined);
    if (parts.length === 0) return undefined;
    const merged: { -readonly [K in keyof PiCustomModelCompat]: PiCustomModelCompat[K] } = {};
    for (const part of parts) Object.assign(merged, part);
    return Object.freeze(merged);
  })();
  const mergedContextWindow = hostCustom?.contextWindow
    ?? modelsEntry?.contextWindow
    ?? modelsOverride?.contextWindow
    ?? effectiveManifest?.contextWindow;
  const mergedMaxTokens = hostCustom?.maxTokens
    ?? modelsEntry?.maxTokens
    ?? modelsOverride?.maxTokens
    ?? effectiveManifest?.maxTokens;
  const mergedReasoning = hostCustom?.reasoning
    ?? modelsEntry?.reasoning
    ?? modelsOverride?.reasoning
    ?? effectiveManifest?.reasoning;
  const mergedThinkingMap = hostCustom?.thinkingLevelMap
    ?? modelsEntry?.thinkingLevelMap
    ?? modelsOverride?.thinkingLevelMap
    ?? effectiveManifest?.thinkingLevelMap;
  const mergedSampling = hostCustom?.samplingParams
    ?? modelsEntry?.samplingParams
    ?? modelsOverride?.samplingParams
    ?? effectiveManifest?.samplingParams;
  const mergedSamplingByThinking = hostCustom?.samplingParamsByThinkingLevel
    ?? modelsEntry?.samplingParamsByThinkingLevel
    ?? modelsOverride?.samplingParamsByThinkingLevel
    ?? effectiveManifest?.samplingParamsByThinkingLevel;
  const mergedCost = hostCustom?.cost
    ?? modelsEntry?.cost
    ?? modelsOverride?.cost
    ?? effectiveManifest?.cost;

  const hasCustomOverrides = builtIn === null
    || mergedBaseUrl !== undefined
    || mergedAuthHeader !== undefined
    || mergedHeaders !== undefined
    || mergedCompat !== undefined
    || mergedContextWindow !== undefined
    || mergedMaxTokens !== undefined
    || mergedReasoning !== undefined
    || mergedThinkingMap !== undefined
    || mergedSampling !== undefined
    || mergedSamplingByThinking !== undefined
    || mergedCost !== undefined;

  const requestedThinking = hostRole?.thinking ?? effectiveManifest?.thinking;
  const effectiveReasoning = mergedReasoning ?? builtIn?.reasoning ?? (requestedThinking !== undefined ? requestedThinking !== 'off' : true);
  const thinking: PiThinkingLevel = requestedThinking ?? (effectiveReasoning ? DEFAULT_PI_THINKING : 'off');

  let customProvider: PiCustomProviderConfig | undefined;
  if (hasCustomOverrides) {
    const baseUrl = mergedBaseUrl ?? builtIn?.baseUrl;
    if (baseUrl === undefined) {
      bindingInvalid(`custom Pi provider "${provider}/${model}" requires baseUrl`, '/roleSelection/customProvider/baseUrl');
    }
    const rawCustom: {
      baseUrl: string;
      authHeader?: boolean;
      headers?: Readonly<Record<string, string>>;
      contextWindow: number;
      maxTokens: number;
      reasoning: boolean;
      thinkingLevelMap?: Readonly<Record<string, string | null>>;
      samplingParams?: PiSamplingParams;
      samplingParamsByThinkingLevel?: Readonly<Record<string, PiSamplingParams>>;
      compat?: PiCustomModelCompat;
      cost?: PiModelCost;
    } = {
      baseUrl,
      contextWindow: mergedContextWindow ?? builtIn?.contextWindow ?? 128_000,
      maxTokens: mergedMaxTokens ?? builtIn?.maxTokens ?? 16_384,
      reasoning: effectiveReasoning,
    };
    if (mergedAuthHeader !== undefined) rawCustom.authHeader = mergedAuthHeader;
    if (mergedHeaders !== undefined) rawCustom.headers = mergedHeaders;
    const effectiveMap = mergedThinkingMap ?? builtIn?.thinkingLevelMap;
    if (effectiveMap !== undefined) rawCustom.thinkingLevelMap = effectiveMap;
    if (mergedSampling !== undefined) rawCustom.samplingParams = mergedSampling;
    if (mergedSamplingByThinking !== undefined) rawCustom.samplingParamsByThinkingLevel = mergedSamplingByThinking;
    if (mergedCompat !== undefined) rawCustom.compat = mergedCompat;
    const effectiveCost = mergedCost ?? builtIn?.cost;
    if (effectiveCost !== undefined) rawCustom.cost = effectiveCost;
    try {
      customProvider = validateCustomProviderConfig(rawCustom, '/roleSelection/customProvider');
    } catch (err) {
      const code = errorCode(err);
      if (code === 'SEND_PATH_UNSUPPORTED') oauthUnsupported('custom Pi provider configuration uses an unsupported credential or send path', '/roleSelection/customProvider');
      bindingInvalid('custom Pi provider configuration failed validation', '/roleSelection/customProvider');
    }
  }

  const candidateSelection: PiModelSelection = customProvider === undefined
    ? { provider, model, thinking, api }
    : { provider, model, thinking, api, customProvider };

  try {
    validateSelection(candidateSelection, '/roleSelection');
  } catch (err) {
    const code = errorCode(err);
    if (code === 'SEND_PATH_UNSUPPORTED') {
      oauthUnsupported(`Pi selection "${provider}/${model}" uses an unsupported OAuth or non-fenced send path`, '/roleSelection');
    }
    bindingInvalid(`Pi selection "${provider}/${model}" (thinking="${thinking}", api="${api}") is unsupported: ${code || 'invalid'}`, '/roleSelection');
  }

  const apiKeyEnv = modelsProvider?.apiKeyEnv ?? effectiveManifest?.apiKeyEnv;
  return apiKeyEnv === undefined ? { selection: candidateSelection } : { selection: candidateSelection, apiKeyEnv };
}

export interface ResolveModelCandidatesOptions {
  readonly modelsConfig?: ParsedPiModelsJson | undefined;
  readonly env?: NodeJS.ProcessEnv | undefined;
  readonly explicitProviderTokenEnv?: string | undefined;
  readonly scrubber?: SecretScrubber | undefined;
}

/**
 * Validate every declared entry in `manifest.spec.models` and expand comma-separated token pools
 * into an ordered list of `ResolvedModelCandidate` items.
 */
export function resolveTaskpackModelCandidates(
  manifest: TaskpackManifest,
  bindings: HostTaskpackBindings,
  options: ResolveModelCandidatesOptions = {},
): readonly ResolvedModelCandidate[] {
  const manifestModels = manifest.spec.models;
  const hostRole = bindings.roleSelection;
  const hostPinsProviderOrModel = hostRole?.provider !== undefined || hostRole?.model !== undefined;

  // Always statically validate all manifest entries so invalid fallback entries fail closed immediately.
  const validatedManifestEntries = manifestModels === undefined
    ? []
    : manifestModels.map((entry, idx) => resolveSingleModelEntry(entry, idx, bindings, options.modelsConfig, false));

  let baseEntries: { readonly manifestIndex: number; readonly selection: PiModelSelection; readonly apiKeyEnv?: string }[];
  if (hostPinsProviderOrModel) {
    const matchingIdx = manifestModels?.findIndex(m => m.provider === (hostRole?.provider ?? m.provider)) ?? -1;
    const matchedEntry = matchingIdx >= 0 ? manifestModels![matchingIdx] : manifestModels?.[0];
    const resolved = resolveSingleModelEntry(matchedEntry, Math.max(0, matchingIdx), bindings, options.modelsConfig, true);
    baseEntries = [{ manifestIndex: Math.max(0, matchingIdx), ...resolved }];
  } else if (manifestModels !== undefined && manifestModels.length > 0) {
    baseEntries = manifestModels.map((entry, idx) => {
      const resolved = hostRole !== undefined
        ? resolveSingleModelEntry(entry, idx, bindings, options.modelsConfig, true)
        : validatedManifestEntries[idx]!;
      return { manifestIndex: idx, ...resolved };
    });
  } else {
    const resolved = resolveSingleModelEntry(undefined, 0, bindings, options.modelsConfig, true);
    baseEntries = [{ manifestIndex: 0, ...resolved }];
  }

  const expanded: ResolvedModelCandidate[] = [];
  for (const base of baseEntries) {
    const modelsJsonApiKeyEnv = options.modelsConfig?.providers.get(base.selection.provider)?.apiKeyEnv;
    const sourceEnvName = resolveDefaultProviderTokenEnv(base.selection.provider, {
      explicitEnv: options.explicitProviderTokenEnv,
      modelsJsonApiKeyEnv,
      manifestApiKeyEnv: base.apiKeyEnv,
      env: options.env,
    });
    const tokens = options.env === undefined
      ? []
      : splitProviderTokens(options.env[sourceEnvName], sourceEnvName, options.scrubber);

    if (tokens.length <= 1) {
      if (expanded.length >= MAX_EXPANDED_MODEL_CANDIDATES) {
        bindingInvalid(`expanded model candidates exceed limit of ${MAX_EXPANDED_MODEL_CANDIDATES}`, '/spec/models');
      }
      expanded.push(Object.freeze({
        index: expanded.length,
        manifestIndex: base.manifestIndex,
        selection: base.selection,
        ...(base.apiKeyEnv !== undefined ? { apiKeyEnv: base.apiKeyEnv } : {}),
        providerEnvName: sourceEnvName,
        ...(tokens[0] !== undefined ? { token: tokens[0] } : {}),
        usesActiveTokenEnv: false,
      }));
    } else {
      for (const token of tokens) {
        if (expanded.length >= MAX_EXPANDED_MODEL_CANDIDATES) {
          bindingInvalid(`expanded model candidates exceed limit of ${MAX_EXPANDED_MODEL_CANDIDATES}`, '/spec/models');
        }
        expanded.push(Object.freeze({
          index: expanded.length,
          manifestIndex: base.manifestIndex,
          selection: base.selection,
          ...(base.apiKeyEnv !== undefined ? { apiKeyEnv: base.apiKeyEnv } : {}),
          providerEnvName: LOOPWRIGHT_ACTIVE_PROVIDER_TOKEN_ENV,
          sourceTokenEnvName: sourceEnvName,
          token,
          usesActiveTokenEnv: true,
        }));
      }
    }
  }
  return Object.freeze(expanded);
}

/** Resolve a single model selection (defaults to index `bindings.candidateIndex ?? 0`) after validating all `spec.models` entries. */
export function resolveTaskpackModelSelection(
  manifest: TaskpackManifest,
  bindings: HostTaskpackBindings,
  modelsConfig?: ParsedPiModelsJson,
): { readonly selection: PiModelSelection; readonly apiKeyEnv?: string } {
  const candidates = resolveTaskpackModelCandidates(manifest, bindings, { modelsConfig });
  const idx = bindings.candidateIndex ?? 0;
  if (!Number.isSafeInteger(idx) || idx < 0 || idx >= candidates.length) {
    bindingInvalid(`candidateIndex ${String(idx)} is out of range for ${candidates.length} resolved model candidate(s)`, '/candidateIndex');
  }
  const chosen = candidates[idx]!;
  return chosen.apiKeyEnv === undefined
    ? { selection: chosen.selection }
    : { selection: chosen.selection, apiKeyEnv: chosen.apiKeyEnv };
}

export interface ProbeModelCandidateOptions {
  readonly fetchImpl?: typeof globalThis.fetch | undefined;
  readonly timeoutMs?: number | undefined;
  readonly scrubber?: SecretScrubber | undefined;
}

async function readBoundedProbeText(response: Response, maxBytes: number): Promise<string> {
  if (!response.body) return '';
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => undefined);
        return new TextDecoder('utf-8', { fatal: false }).decode(Buffer.concat(chunks).subarray(0, maxBytes));
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  return new TextDecoder('utf-8', { fatal: false }).decode(Buffer.concat(chunks));
}

function buildProbePayload(selection: PiModelSelection): Record<string, unknown> {
  if (selection.api === 'anthropic-messages') {
    return { model: selection.model, max_tokens: 1, messages: [{ role: 'user', content: 'Reply OK.' }] };
  }
  if (selection.api === 'openai-responses') {
    return { model: selection.model, max_output_tokens: 16, input: 'Reply OK.' };
  }
  const maxTokensField = selection.customProvider?.compat?.maxTokensField ?? 'max_tokens';
  return {
    model: selection.model,
    stream: false,
    messages: [{ role: 'user', content: 'Reply OK.' }],
    [maxTokensField]: 1,
  };
}

function isHealthyProbeBody(bodyText: string, contentType: string, api: PiWireApi): { readonly ok: boolean; readonly reason: string } {
  const trimmed = bodyText.trim();
  if (trimmed.length === 0) return { ok: false, reason: 'empty_response_body' };
  if (contentType.toLowerCase().includes('text/event-stream') || trimmed.startsWith('data:') || trimmed.startsWith('event:')) {
    if (/"error"\s*:/.test(trimmed) && !/"error"\s*:\s*null/.test(trimmed)) {
      return { ok: false, reason: 'sse_error_payload' };
    }
    if (trimmed.includes('"choices"') || trimmed.includes('"message_start"') || trimmed.includes('"response.completed"') || trimmed.includes('"output"')) {
      return { ok: true, reason: 'ok' };
    }
    return { ok: false, reason: 'sse_missing_completion' };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return { ok: false, reason: 'invalid_json_response' };
  }
  if (!isPlainRecord(parsed)) return { ok: false, reason: 'non_object_response' };
  if (parsed['error'] !== undefined && parsed['error'] !== null) {
    const errObj = isPlainRecord(parsed['error']) ? parsed['error'] : null;
    const code = errObj && (typeof errObj['code'] === 'string' || typeof errObj['code'] === 'number') ? String(errObj['code']) : 'error';
    return { ok: false, reason: `provider_error_${code}` };
  }
  if (api === 'anthropic-messages') {
    return Array.isArray(parsed['content']) && parsed['content'].length > 0
      ? { ok: true, reason: 'ok' }
      : { ok: false, reason: 'missing_anthropic_content' };
  }
  if (api === 'openai-responses') {
    return (Array.isArray(parsed['output']) && parsed['output'].length > 0) || typeof parsed['output_text'] === 'string'
      ? { ok: true, reason: 'ok' }
      : { ok: false, reason: 'missing_responses_output' };
  }
  return Array.isArray(parsed['choices']) && parsed['choices'].length > 0
    ? { ok: true, reason: 'ok' }
    : { ok: false, reason: 'missing_chat_choices' };
}

/**
 * Send a minimal `max_tokens=1` readiness probe (`redirect: 'error'`) to verify that a candidate
 * provider and token have live quota and return a valid completion structure.
 */
export async function probeModelCandidate(
  candidate: ResolvedModelCandidate,
  token: string,
  options: ProbeModelCandidateOptions = {},
): Promise<ModelCandidateProbeAttempt> {
  const scrubber = options.scrubber ?? new SecretScrubber();
  scrubber.register(token);
  const fetchFn = options.fetchImpl ?? globalThis.fetch;
  const timeoutMs = Math.max(50, Math.min(30_000, options.timeoutMs ?? DEFAULT_PROBE_CANDIDATE_TIMEOUT_MS));
  const { selection } = candidate;
  const url = resolveProviderDestination(selection);
  const authHeader = resolveProviderAuthHeaderName(selection);
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    accept: 'application/json',
    ...(selection.api === 'anthropic-messages' ? { 'anthropic-version': '2023-06-01' } : {}),
    ...(selection.customProvider?.headers ?? {}),
    [authHeader]: authHeader === 'x-api-key' ? token : `Bearer ${token}`,
  };

  let response: Response;
  try {
    response = await fetchFn(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(buildProbePayload(selection)),
      redirect: 'error',
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    const rawMsg = err instanceof Error ? err.message : 'network_error';
    return Object.freeze({
      index: candidate.index,
      provider: selection.provider,
      model: selection.model,
      api: selection.api,
      ok: false,
      status: null,
      reason: scrubber.scrub(rawMsg).slice(0, 160),
    });
  }

  const bodyText = await readBoundedProbeText(response, PROBE_MAX_RESPONSE_BYTES).catch(() => '');
  if (response.status !== 200) {
    let reason = `http_${response.status}`;
    try {
      const parsed = JSON.parse(bodyText) as unknown;
      if (isPlainRecord(parsed) && isPlainRecord(parsed['error'])) {
        const code = parsed['error']['code'] ?? parsed['error']['type'];
        if (typeof code === 'string' || typeof code === 'number') reason = `http_${response.status}_${String(code)}`;
      }
    } catch {
      // Keep status-based reason when error payload is non-JSON.
    }
    return Object.freeze({
      index: candidate.index,
      provider: selection.provider,
      model: selection.model,
      api: selection.api,
      ok: false,
      status: response.status,
      reason: scrubber.scrub(reason).slice(0, 160),
    });
  }

  const contentType = response.headers.get('content-type') ?? 'application/json';
  const bodyCheck = isHealthyProbeBody(bodyText, contentType, selection.api);
  return Object.freeze({
    index: candidate.index,
    provider: selection.provider,
    model: selection.model,
    api: selection.api,
    ok: bodyCheck.ok,
    status: response.status,
    reason: scrubber.scrub(bodyCheck.reason).slice(0, 160),
  });
}

export interface SelectHealthyModelCandidateOptions {
  readonly fetchImpl?: typeof globalThis.fetch | undefined;
  readonly totalTimeoutMs?: number | undefined;
  readonly perCandidateTimeoutMs?: number | undefined;
  readonly forceProbe?: boolean | undefined;
  readonly scrubber?: SecretScrubber | undefined;
  readonly nowMs?: (() => number) | undefined;
}

/**
 * Select a healthy model candidate in priority order:
 * - Fast path: when only 1 candidate exists (and `forceProbe` is not set), returns immediately with zero network overhead.
 * - Multi-candidate path: probes candidates in order with a `max_tokens=1` request (`<= 15s` per candidate, `<= 30s` total)
 *   and returns the first candidate with live quota and a valid completion response.
 */
export async function selectHealthyModelCandidate(
  candidates: readonly ResolvedModelCandidate[],
  options: SelectHealthyModelCandidateOptions = {},
): Promise<ModelCandidateSelectionResult> {
  if (candidates.length === 0) {
    bindingInvalid('at least one model candidate is required', '/spec/models');
  }
  if (candidates.length === 1 && options.forceProbe !== true) {
    return Object.freeze({
      selected: candidates[0]!,
      index: 0,
      probed: false,
      attempts: Object.freeze([]),
    });
  }

  const scrubber = options.scrubber ?? new SecretScrubber();
  const nowMs = options.nowMs ?? (() => Date.now());
  const totalBudgetMs = Math.max(100, Math.min(60_000, options.totalTimeoutMs ?? DEFAULT_PROBE_TOTAL_TIMEOUT_MS));
  const perCandidateMs = Math.max(50, Math.min(30_000, options.perCandidateTimeoutMs ?? DEFAULT_PROBE_CANDIDATE_TIMEOUT_MS));
  const deadlineMs = nowMs() + totalBudgetMs;
  const attempts: ModelCandidateProbeAttempt[] = [];

  for (const [pos, candidate] of candidates.entries()) {
    const remainingMs = deadlineMs - nowMs();
    if (remainingMs <= 0) {
      attempts.push(Object.freeze({
        index: candidate.index,
        provider: candidate.selection.provider,
        model: candidate.selection.model,
        api: candidate.selection.api,
        ok: false,
        status: null,
        reason: 'probe_budget_exhausted',
      }));
      break;
    }
    if (candidate.token === undefined || candidate.token.length === 0) {
      attempts.push(Object.freeze({
        index: candidate.index,
        provider: candidate.selection.provider,
        model: candidate.selection.model,
        api: candidate.selection.api,
        ok: false,
        status: null,
        reason: 'missing_token',
      }));
      continue;
    }
    const attempt = await probeModelCandidate(candidate, candidate.token, {
      fetchImpl: options.fetchImpl,
      timeoutMs: Math.min(perCandidateMs, remainingMs),
      scrubber,
    });
    attempts.push(attempt);
    if (attempt.ok) {
      return Object.freeze({
        selected: candidate,
        index: pos,
        probed: true,
        attempts: Object.freeze(attempts),
      });
    }
  }

  const summary = attempts.map(a => `#${a.index} ${a.provider}/${a.model}: ${a.reason}`).join('; ');
  bindingInvalid(scrubber.scrub(`no model candidate passed readiness probe (${summary})`), '/spec/models');
}
