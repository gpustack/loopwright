import type { PiCustomModelCompat, PiCustomProviderConfig, PiLimits, PiModelCost, PiModelSelection, PiSamplingParams } from './types.js';
export const MAX_LIMITS: PiLimits = Object.freeze({ promptBytes: 16384, diagnosticBytes: 1024, responseBytes: 1048576,
  frameBytes: 65536, eventBytes: 4096, pendingResponseBytes: 262144, eventQueue: 128, eventQueueBytes: 524288,
  toolArgsBytes: 65536, toolResultBytes: 65536, sessionBytes: 8388608, artifactBytes: 16777216, candidateEntries: 256,
  fileBytes: 8388608, toolWallMs: 10000, requests: 1024, operations: 2048, checkpoints: 64 });
import { canonical, freeze, id, integer, object, text, type Json } from './boundary.js';
import { PI_THINKING_LEVELS, PI_WIRE_APIS, resolveCatalogModel, validateProviderBaseUrl } from './catalog.js';
import { refuse } from './errors.js';
import type { AdapterPolicy, ResourceIdentity, RuntimeIdentity } from './types.js';
export const SDK_INTEGRITY = 'sha512-xNDZ5kqowO6Z03FS2gwAkPEGk1ssxVcYKQ6qZId84mFEvwACvvyc2l0vAMOS+c5zvxLRMLBE9r4y44IGYkMJaQ==';
function exactValue(value: unknown, expected: unknown, path: string): void { if (value !== expected) refuse('INPUT_INVALID', path); }
export function validateDigest(value: unknown, path: string): void {
  const item = object(value, ['algorithm', 'hex'], path); exactValue(item.algorithm, 'sha256', path);
  if (typeof item.hex !== 'string' || !/^[a-f0-9]{64}$/.test(item.hex)) refuse('INPUT_INVALID', path);
}
export function validateRuntime(value: unknown, path = '/policy/runtime'): RuntimeIdentity {
  const item = object(value, ['sdkIntegrity', 'graphDigest', 'imageDigest', 'configDigest', 'profile'], path);
  if (item.sdkIntegrity !== SDK_INTEGRITY || item.profile !== 'linux/arm64') refuse('RUNTIME_UNSUPPORTED', path);
  if (typeof item.imageDigest !== 'string' || !/^sha256:[a-f0-9]{64}$/.test(item.imageDigest)) refuse('INPUT_INVALID', path + '/imageDigest');
  validateDigest(item.graphDigest, path + '/graphDigest'); validateDigest(item.configDigest, path + '/configDigest');
  return item as unknown as RuntimeIdentity;
}
export function validateResource(value: unknown, path: string): ResourceIdentity {
  const item = object(value, ['id', 'kind', 'path', 'digest'], path); id(item.id, path + '/id');
  if (!['instruction', 'skill', 'document'].includes(item.kind as string)) refuse('INPUT_INVALID', path + '/kind');
  text(item.path, path + '/path', 1024); validateDigest(item.digest, path + '/digest'); return item as unknown as ResourceIdentity;
}

const SAMPLING_KEYS = ['temperature', 'top_p', 'top_k', 'min_p', 'presence_penalty', 'repetition_penalty'] as const;
const COMPAT_BOOLEAN_KEYS = [
  'supportsStore', 'supportsDeveloperRole', 'supportsReasoningEffort', 'supportsUsageInStreaming',
  'requiresToolResultName', 'requiresAssistantAfterToolResult', 'requiresThinkingAsText',
  'supportsStrictMode', 'zaiToolStream',
] as const;
const COMPAT_ALL_KEYS = [...COMPAT_BOOLEAN_KEYS, 'maxTokensField', 'thinkingFormat'] as const;
const THINKING_FORMATS = ['openai', 'zai', 'qwen', 'qwen-chat-template', 'openrouter', 'deepseek'] as const;
const MODEL_COST_KEYS = ['input', 'output', 'cacheRead', 'cacheWrite'] as const;
const FORBIDDEN_HEADER_NAMES = new Set(['authorization', 'x-api-key', 'api-key', 'x-goog-api-key', 'cookie', 'proxy-authorization', 'host', 'content-length']);

export function validateModelCost(raw: unknown, path: string): PiModelCost {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) refuse('INPUT_INVALID', path);
  const keys = Reflect.ownKeys(raw);
  if (keys.some(key => typeof key !== 'string' || !(MODEL_COST_KEYS as readonly string[]).includes(key))) {
    refuse('INPUT_INVALID', path);
  }
  if (!keys.includes('input') || !keys.includes('output')) {
    refuse('INPUT_INVALID', path);
  }
  const item = object(raw, keys as string[], path);
  for (const key of keys as string[]) {
    const val = item[key];
    if (typeof val !== 'number' || !Number.isFinite(val) || Object.is(val, -0) || val < 0 || val > 1_000_000) {
      refuse('INPUT_INVALID', `${path}/${key}`);
    }
  }
  return freeze(item as unknown as PiModelCost);
}

function validateSamplingParams(raw: unknown, path: string): PiSamplingParams {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) refuse('INPUT_INVALID', path);
  const keys = Object.keys(raw as Record<string, unknown>);
  if (keys.some(key => !(SAMPLING_KEYS as readonly string[]).includes(key))) refuse('INPUT_INVALID', path);
  const item = object(raw, keys, path);
  for (const key of keys) {
    const val = item[key];
    if (typeof val !== 'number' || !Number.isFinite(val) || Object.is(val, -0)) refuse('INPUT_INVALID', `${path}/${key}`);
    if (key === 'top_k' && (!Number.isSafeInteger(val) || val < 0 || val > 100000)) refuse('INPUT_INVALID', `${path}/${key}`);
    if (key !== 'top_k' && (val < -4 || val > 4)) refuse('INPUT_INVALID', `${path}/${key}`);
  }
  return item as unknown as PiSamplingParams;
}

function validateCompat(raw: unknown, path: string): PiCustomModelCompat {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) refuse('INPUT_INVALID', path);
  const keys = Object.keys(raw as Record<string, unknown>);
  if (keys.some(key => !(COMPAT_ALL_KEYS as readonly string[]).includes(key))) refuse('INPUT_INVALID', path);
  const item = object(raw, keys, path);
  for (const key of COMPAT_BOOLEAN_KEYS) {
    if (Object.hasOwn(item, key) && typeof item[key] !== 'boolean') refuse('INPUT_INVALID', `${path}/${key}`);
  }
  if (Object.hasOwn(item, 'maxTokensField') && item.maxTokensField !== 'max_completion_tokens' && item.maxTokensField !== 'max_tokens') {
    refuse('INPUT_INVALID', `${path}/maxTokensField`);
  }
  if (Object.hasOwn(item, 'thinkingFormat') && !(THINKING_FORMATS as readonly string[]).includes(item.thinkingFormat as string)) {
    refuse('INPUT_INVALID', `${path}/thinkingFormat`);
  }
  return item as unknown as PiCustomModelCompat;
}

export function validateCustomProviderConfig(raw: unknown, path: string): PiCustomProviderConfig {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) refuse('INPUT_INVALID', path);
  if (Object.hasOwn(raw, 'oauth') || Object.hasOwn(raw, 'apiKey')) refuse('SEND_PATH_UNSUPPORTED', path);
  const allowed = ['baseUrl', 'authHeader', 'headers', 'contextWindow', 'maxTokens', 'reasoning', 'thinkingLevelMap', 'samplingParams', 'samplingParamsByThinkingLevel', 'compat', 'cost'];
  const keys = Object.keys(raw as Record<string, unknown>);
  if (keys.some(key => !allowed.includes(key))) refuse('INPUT_INVALID', path);
  const item = object(raw, keys, path);
  validateProviderBaseUrl(item.baseUrl, `${path}/baseUrl`);
  if (Object.hasOwn(item, 'authHeader') && typeof item.authHeader !== 'boolean') refuse('INPUT_INVALID', `${path}/authHeader`);
  if (typeof item.reasoning !== 'boolean') refuse('INPUT_INVALID', `${path}/reasoning`);
  integer(item.contextWindow, 1024, 10_000_000, `${path}/contextWindow`);
  integer(item.maxTokens, 1, 1_048_576, `${path}/maxTokens`);
  if (Object.hasOwn(item, 'headers')) {
    if (!item.headers || typeof item.headers !== 'object' || Array.isArray(item.headers)) refuse('INPUT_INVALID', `${path}/headers`);
    const headerKeys = Object.keys(item.headers as Record<string, unknown>);
    if (headerKeys.length > 32) refuse('INPUT_INVALID', `${path}/headers`);
    const hdrs = object(item.headers, headerKeys, `${path}/headers`);
    for (const hKey of headerKeys) {
      const lower = hKey.toLowerCase();
      if (!/^[A-Za-z0-9-]{1,128}$/.test(hKey) || FORBIDDEN_HEADER_NAMES.has(lower)) refuse('INPUT_INVALID', `${path}/headers/${hKey}`);
      const hVal = text(hdrs[hKey], `${path}/headers/${hKey}`, 1024);
      if (/[\r\n]/.test(hVal) || hVal.startsWith('!')) refuse('SEND_PATH_UNSUPPORTED', `${path}/headers/${hKey}`);
    }
  }
  if (Object.hasOwn(item, 'thinkingLevelMap')) {
    if (!item.thinkingLevelMap || typeof item.thinkingLevelMap !== 'object' || Array.isArray(item.thinkingLevelMap)) refuse('INPUT_INVALID', `${path}/thinkingLevelMap`);
    const mapKeys = Object.keys(item.thinkingLevelMap as Record<string, unknown>);
    if (mapKeys.some(k => !(PI_THINKING_LEVELS as readonly string[]).includes(k))) refuse('INPUT_INVALID', `${path}/thinkingLevelMap`);
    const mapObj = object(item.thinkingLevelMap, mapKeys, `${path}/thinkingLevelMap`);
    for (const k of mapKeys) {
      const mapped = mapObj[k];
      if (mapped !== null && (typeof mapped !== 'string' || mapped.length < 1 || mapped.length > 64 || /\s/.test(mapped))) {
        refuse('INPUT_INVALID', `${path}/thinkingLevelMap/${k}`);
      }
    }
  }
  if (Object.hasOwn(item, 'samplingParams')) validateSamplingParams(item.samplingParams, `${path}/samplingParams`);
  if (Object.hasOwn(item, 'samplingParamsByThinkingLevel')) {
    if (!item.samplingParamsByThinkingLevel || typeof item.samplingParamsByThinkingLevel !== 'object' || Array.isArray(item.samplingParamsByThinkingLevel)) {
      refuse('INPUT_INVALID', `${path}/samplingParamsByThinkingLevel`);
    }
    const levelKeys = Object.keys(item.samplingParamsByThinkingLevel as Record<string, unknown>);
    if (levelKeys.some(k => !(PI_THINKING_LEVELS as readonly string[]).includes(k))) refuse('INPUT_INVALID', `${path}/samplingParamsByThinkingLevel`);
    const byLevel = object(item.samplingParamsByThinkingLevel, levelKeys, `${path}/samplingParamsByThinkingLevel`);
    for (const k of levelKeys) validateSamplingParams(byLevel[k], `${path}/samplingParamsByThinkingLevel/${k}`);
  }
  if (Object.hasOwn(item, 'compat')) validateCompat(item.compat, `${path}/compat`);
  if (Object.hasOwn(item, 'cost')) {
    if (item.cost !== undefined) item.cost = validateModelCost(item.cost, `${path}/cost`);
    else delete item.cost;
  }
  return item as unknown as PiCustomProviderConfig;
}

export function validateSelection(raw: unknown, path = '/policy/selection'): PiModelSelection {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) refuse('INPUT_INVALID', path);
  const hasCustom = Object.hasOwn(raw, 'customProvider');
  const selection = object(raw, hasCustom ? ['provider', 'model', 'thinking', 'api', 'customProvider'] : ['provider', 'model', 'thinking', 'api'], path);
  const provider = text(selection.provider, `${path}/provider`, 64);
  if (!/^[a-z0-9][a-z0-9._-]{0,63}$/.test(provider) || provider.includes('..')) refuse('SEND_PATH_UNSUPPORTED', path);
  if (!(PI_WIRE_APIS as readonly string[]).includes(selection.api as string)) refuse('SEND_PATH_UNSUPPORTED', path);
  const model = text(selection.model, `${path}/model`, 128);
  if (/\s/.test(model)) refuse('MODEL_UNAVAILABLE', `${path}/model`);
  const thinking = text(selection.thinking, `${path}/thinking`, 32);
  if (!(PI_THINKING_LEVELS as readonly string[]).includes(thinking)) refuse('THINKING_UNSUPPORTED', `${path}/thinking`);
  if (hasCustom) validateCustomProviderConfig(selection.customProvider, `${path}/customProvider`);
  const typed = selection as unknown as PiModelSelection;
  resolveCatalogModel(typed);
  return typed;
}

export function validatePolicy(input: Json): AdapterPolicy {
  const value = object(input, ['version', 'policyId', 'resourceVersion', 'adapterId', 'adapterVersion', 'runtime', 'selection', 'resources', 'tools', 'mcp', 'context', 'accounting', 'retry', 'extensions', 'privateArtifacts', 'limits'], '/policy');
  exactValue(value.version, 1, '/policy/version'); id(value.policyId, '/policy/policyId'); text(value.resourceVersion, '/policy/resourceVersion', 128);
  if (value.adapterId !== 'pi' || value.adapterVersion !== '0.0.0') refuse('RUNTIME_UNSUPPORTED', '/policy');
  validateRuntime(value.runtime);
  validateSelection(value.selection, '/policy/selection');
  if (!Array.isArray(value.extensions) || value.extensions.length) refuse('EXTENSION_UNSUPPORTED', '/policy/extensions');
  if (value.accounting !== 'soft_only' || value.retry !== 'sender_only') refuse('CAPABILITY_UNSUPPORTED', '/policy');
  if (typeof value.privateArtifacts !== 'boolean') refuse('INPUT_INVALID', '/policy/privateArtifacts');
  if (!Array.isArray(value.tools) || value.tools.length > 6 || new Set(value.tools).size !== value.tools.length) refuse('INPUT_INVALID', '/policy/tools');
  if (value.tools.some(name => !['read', 'bash', 'write', 'edit', 'codemode', 'mcp__workspace__read_file'].includes(name as string))) refuse('TOOL_DENIED', '/policy/tools');
  const mcp = object(value.mcp, ['serverId', 'scriptDigest', 'names', 'effects', 'idleTimeoutSeconds', 'absoluteTimeoutSeconds'], '/policy/mcp');
  if (mcp.serverId !== 'workspace') refuse('CAPABILITY_UNSUPPORTED', '/policy/mcp'); validateDigest(mcp.scriptDigest, '/policy/mcp/scriptDigest');
  if (!Array.isArray(mcp.names) || !Array.isArray(mcp.effects)) refuse('INPUT_INVALID', '/policy/mcp');
  const mcpNames = mcp.names, effects = mcp.effects, tools = value.tools;
  if (mcpNames.length !== effects.length || mcpNames.length > 1 || mcpNames.some((name, index) => name !== 'mcp__workspace__read_file' || effects[index] !== 'read_only' || !tools.includes(name))) refuse('TOOL_DENIED', '/policy/mcp');
  if (value.tools.includes('mcp__workspace__read_file') !== mcp.names.includes('mcp__workspace__read_file')) refuse('TOOL_DENIED', '/policy/tools');
  const idle = integer(mcp.idleTimeoutSeconds, 1, 2, '/policy/mcp/idleTimeoutSeconds'); integer(mcp.absoluteTimeoutSeconds, idle, 10, '/policy/mcp/absoluteTimeoutSeconds');
  const rawContext = value.context as Json;
  if (!rawContext || typeof rawContext !== 'object' || Array.isArray(rawContext)) refuse('INPUT_INVALID', '/policy/context');
  if (!Object.hasOwn(rawContext, 'mode')) rawContext.mode = 'proven_bound';
  const context = object(rawContext, ['mode', 'estimator', 'proofId', 'version', 'evidence', 'workingWindowCeiling', 'maxRequestBytes', 'serviceMargin', 'toolReserve', 'maxOutputTokens'], '/policy/context');
  if (context.mode !== 'proven_bound' && context.mode !== 'estimated_guard') refuse('INPUT_INVALID', '/policy/context/mode');
  if (context.mode === 'proven_bound') refuse('CONTEXT_UNSAFE', '/policy/context/mode');
  exactValue(context.estimator, 'lw-pi-final-json-bytes-v1', '/policy/context/estimator'); exactValue(context.proofId, null, '/policy/context/proofId'); exactValue(context.version, 1, '/policy/context/version'); exactValue(context.evidence, 'estimated', '/policy/context/evidence');
  integer(context.workingWindowCeiling, 1, 98304); integer(context.maxRequestBytes, 1, 65536); integer(context.serviceMargin, 32768, Number.MAX_SAFE_INTEGER); integer(context.toolReserve, 16384, Number.MAX_SAFE_INTEGER); integer(context.maxOutputTokens, 1, 1024);
  const limits = object(value.limits, Object.keys(MAX_LIMITS), '/policy/limits');
  for (const [key, max] of Object.entries(MAX_LIMITS)) integer(limits[key], 1, max, '/policy/limits/' + key);
  for (const key of ['frameBytes', 'pendingResponseBytes']) if (limits[key] !== MAX_LIMITS[key as keyof PiLimits]) refuse('CAPABILITY_UNSUPPORTED', '/policy/limits/' + key);
  if ((limits.diagnosticBytes as number) < 64) refuse('CAPABILITY_UNSUPPORTED', '/policy/limits/diagnosticBytes');
  if (!Array.isArray(value.resources) || value.resources.length > 129) refuse('INPUT_INVALID', '/policy/resources'); value.resources.forEach((item, index) => validateResource(item, '/policy/resources/' + index));
  return value as unknown as AdapterPolicy;
}
export function sameIdentity(left: unknown, right: unknown): boolean { return canonical(left) === canonical(right); }
