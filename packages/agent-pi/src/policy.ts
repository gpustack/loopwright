import type { PiLimits } from './types.js';
export const MAX_LIMITS: PiLimits = Object.freeze({ promptBytes: 16384, diagnosticBytes: 1024, responseBytes: 1048576,
  frameBytes: 65536, eventBytes: 4096, pendingResponseBytes: 262144, eventQueue: 128, eventQueueBytes: 524288,
  toolArgsBytes: 65536, toolResultBytes: 65536, sessionBytes: 8388608, artifactBytes: 16777216, candidateEntries: 256,
  fileBytes: 8388608, toolWallMs: 10000, requests: 1024, operations: 2048, checkpoints: 64 });
import { canonical, id, integer, object, text, type Json } from './boundary.js';
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
export function validatePolicy(input: Json): AdapterPolicy {
  const value = object(input, ['version', 'policyId', 'resourceVersion', 'adapterId', 'adapterVersion', 'runtime', 'selection', 'resources', 'tools', 'mcp', 'context', 'accounting', 'retry', 'extensions', 'privateArtifacts', 'limits'], '/policy');
  exactValue(value.version, 1, '/policy/version'); id(value.policyId, '/policy/policyId'); text(value.resourceVersion, '/policy/resourceVersion', 128);
  if (value.adapterId !== 'pi' || value.adapterVersion !== '0.0.0') refuse('RUNTIME_UNSUPPORTED', '/policy');
  validateRuntime(value.runtime);
  const selection = object(value.selection, ['provider', 'model', 'thinking', 'api'], '/policy/selection');
  if (selection.provider !== 'github-copilot' || selection.api !== 'anthropic-messages') refuse('SEND_PATH_UNSUPPORTED', '/policy/selection');
  if (selection.model !== 'claude-sonnet-5.5' && selection.model !== 'claude-opus-5.5') refuse('MODEL_UNAVAILABLE', '/policy/selection/model');
  if (selection.thinking !== (selection.model === 'claude-sonnet-5.5' ? 'xhigh' : 'high')) refuse('THINKING_UNSUPPORTED', '/policy/selection/thinking');
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
