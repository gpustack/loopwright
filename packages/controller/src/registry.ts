import { isAbsolute } from 'node:path';
import { isIP } from 'node:net';
import { digestArtifact } from '@loopwright/core';
import { CONTROLLER_API_VERSION, type TrustedRegistry, type RoleProfile, type Handler, type Implementation, type GateEndpoint, type PublicationEndpoint } from './types.js';
import { digestValue, id, integer, list, record, same, text, type Scalar } from './schema.js';
import { template } from './interpolation.js';
import { refuse } from './errors.js';
const implementations = ['pi.agent.v1', 'pi.compact.v1', 'scope.v1', 'json-artifact.v1', 'no-change.v1', 'gate.v1'];
function unique(value: readonly { readonly id: string }[], path: string): void { if (new Set(value.map(item => item.id)).size !== value.length) refuse('CONFIG_SCHEMA', path); }
function enumValue(value: unknown, values: readonly string[], path: string): void { if (typeof value !== 'string' || !values.includes(value)) refuse('CONFIG_SCHEMA', path); }
export function validateHandler(raw: unknown, path: string): Handler {
  const value = record(raw, ['id', 'version', 'digest', 'kind', 'implementation', 'parameters', 'capabilities'], path);
  id(value.id, path + '/id'); integer(value.version, 1, 1, path + '/version'); digestValue(value.digest, path + '/digest');
  if (typeof value.implementation !== 'string' || !implementations.includes(value.implementation)) refuse('CAPABILITY_UNSUPPORTED', path + '/implementation');
  const implementation = value.implementation as Implementation, agent = implementation.startsWith('pi.');
  if (value.kind !== (agent ? 'agent' : 'check')) refuse('CONFIG_SCHEMA', path + '/kind');
  const capabilities = list(value.capabilities, path + '/capabilities').map(item => text(item, path + '/capabilities', 64));
  const expected = agent ? implementation === 'pi.compact.v1' ? ['pi', 'compaction'] : ['pi'] : implementation === 'gate.v1' ? ['external_service', 'read_only'] : ['inert_bytes', 'read_only'];
  if (!same(capabilities, expected)) refuse('CAPABILITY_UNSUPPORTED', path + '/capabilities');
  if (implementation === 'pi.agent.v1') {
    const parameters = record(value.parameters, ['prompt', 'purpose'], path + '/parameters'); text(parameters.prompt, path + '/parameters/prompt'); enumValue(parameters.purpose, ['task', 'review'], path + '/parameters/purpose');
  } else if (implementation === 'pi.compact.v1') record(value.parameters, [], path + '/parameters');
  else if (implementation === 'gate.v1') {
    const parameters = record(value.parameters, ['checkId', 'endpointRef', 'gateId'], path + '/parameters');
    id(parameters.checkId, path + '/parameters/checkId'); id(parameters.endpointRef, path + '/parameters/endpointRef'); text(parameters.gateId, path + '/parameters/gateId', 128);
  } else {
    const fields = implementation === 'json-artifact.v1' ? ['checkId', 'path', 'required', 'equals'] : ['checkId'];
    const parameters = record(value.parameters, fields, path + '/parameters');
    if (parameters.checkId !== null) id(parameters.checkId, path + '/parameters/checkId');
    if (implementation === 'json-artifact.v1') {
      if (parameters.checkId === null || !digestArtifact(text(parameters.path, path + '/parameters/path', 1024), new Uint8Array()).ok) refuse('CONFIG_SCHEMA', path + '/parameters');
      const required = list(parameters.required, path + '/parameters/required').map(item => text(item, path + '/parameters/required', 256));
      if (new Set(required).size !== required.length) refuse('CONFIG_SCHEMA', path + '/parameters/required');
      if (!parameters.equals || typeof parameters.equals !== 'object' || Array.isArray(parameters.equals) || Object.keys(parameters.equals).length > 128) refuse('CONFIG_SCHEMA', path + '/parameters/equals');
      for (const [key, scalar] of Object.entries(parameters.equals)) if (key.length > 256 || scalar !== null && !['string', 'boolean', 'number'].includes(typeof scalar) || typeof scalar === 'number' && !Number.isSafeInteger(scalar as Scalar)) refuse('CONFIG_SCHEMA', path + '/parameters/equals');
    }
  }
  return raw as Handler;
}
function context(raw: unknown, path: string): RoleProfile['context'] {
  const keys = ['mode', 'estimator', 'proofId', 'version', 'evidence', 'workingWindowCeiling', 'maxRequestBytes', 'serviceMargin', 'toolReserve', 'maxOutputTokens'];
  const hasMode = raw !== null && typeof raw === 'object' && Object.hasOwn(raw, 'mode');
  const value = record(raw, hasMode ? keys : keys.filter(key => key !== 'mode'), path);
  if (!hasMode) value.mode = 'proven_bound';
  enumValue(value.mode, ['proven_bound', 'estimated_guard'], path + '/mode');
  if (value.estimator !== 'lw-pi-final-json-bytes-v1' || value.proofId !== null || value.version !== 1 || value.evidence !== 'estimated') refuse('CAPABILITY_UNSUPPORTED', path);
  integer(value.workingWindowCeiling, 1, 98304, path); integer(value.maxRequestBytes, 1, 65536, path); integer(value.serviceMargin, 32768, Number.MAX_SAFE_INTEGER, path);
  integer(value.toolReserve, 16384, Number.MAX_SAFE_INTEGER, path); integer(value.maxOutputTokens, 1, 1024, path);
  return value as unknown as RoleProfile['context'];
}
function mcp(raw: unknown, tools: readonly string[], path: string): void {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) refuse('CONFIG_SCHEMA', path);
  const http = Object.hasOwn(raw, 'transport');
  const value = record(raw, http ? ['serverId', 'transport', 'destinationRef', 'endpoint', 'approvedAddresses', 'credentialRef', 'names', 'effects', 'idleTimeoutSeconds', 'absoluteTimeoutSeconds'] : ['serverId', 'scriptDigest', 'names', 'effects', 'idleTimeoutSeconds', 'absoluteTimeoutSeconds'], path);
  if (value.serverId !== 'workspace') refuse('CAPABILITY_UNSUPPORTED', path);
  const names = list(value.names, path + '/names', 1), effects = list(value.effects, path + '/effects', 1);
  if (names.length !== effects.length || names.some((name, index) => name !== 'mcp__workspace__read_file' || effects[index] !== 'read_only') || tools.includes('mcp__workspace__read_file') !== (names.length === 1)) refuse('CAPABILITY_UNSUPPORTED', path);
  const idle = integer(value.idleTimeoutSeconds, 1, 2, path); integer(value.absoluteTimeoutSeconds, idle, 10, path);
  if (!http) { digestValue(value.scriptDigest, path + '/scriptDigest'); return; }
  if (value.transport !== 'sessionless-http-json-v1') refuse('CAPABILITY_UNSUPPORTED', path);
  id(value.destinationRef, path + '/destinationRef'); id(value.credentialRef, path + '/credentialRef');
  const endpoint = text(value.endpoint, path + '/endpoint', 1024), addresses = list(value.approvedAddresses, path + '/approvedAddresses', 4).map(item => text(item, path + '/approvedAddresses', 64));
  if (addresses.length < 1 || new Set(addresses).size !== addresses.length || addresses.some(address => !isIP(address) || address !== address.toLowerCase() || address.startsWith('::ffff:') || isIP(address) === 6 && new URL('http://[' + address + ']/').hostname !== '[' + address + ']')) refuse('CONFIG_SCHEMA', path);
  let url: URL; try { url = new URL(endpoint); } catch { refuse('CONFIG_SCHEMA', path); }
  if (url.href !== endpoint || url.username || url.password || url.hash || url.search || url.pathname !== '/mcp') refuse('CONFIG_SCHEMA', path);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && url.hostname === '127.0.0.1' && url.port && addresses.every(address => address === '127.0.0.1'))) refuse('CAPABILITY_UNSUPPORTED', path);
  if (url.protocol === 'https:' && (isIP(url.hostname) || !/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/.test(url.hostname) || url.hostname.includes('..') || url.hostname.endsWith('.'))) refuse('CAPABILITY_UNSUPPORTED', path);
}
function role(raw: unknown, path: string): RoleProfile {
  const value = record(raw, ['id', 'selection', 'tools', 'context', 'runtimeRef', 'providerCredentialRef', 'mcp'], path);
  id(value.id, path + '/id'); id(value.runtimeRef, path + '/runtimeRef'); if (value.providerCredentialRef !== null) id(value.providerCredentialRef, path + '/providerCredentialRef');
  const selection = record(value.selection, ['provider', 'model', 'thinking', 'api'], path + '/selection');
  if (selection.provider !== 'github-copilot' || selection.api !== 'anthropic-messages' || !['claude-sonnet-5.5', 'claude-opus-5.5'].includes(String(selection.model)) || selection.thinking !== (selection.model === 'claude-sonnet-5.5' ? 'xhigh' : 'high')) refuse('CAPABILITY_UNSUPPORTED', path + '/selection');
  const tools = list(value.tools, path + '/tools', 6).map(item => text(item, path + '/tools', 128));
  if (new Set(tools).size !== tools.length || tools.some(name => !['read', 'bash', 'write', 'edit', 'codemode', 'mcp__workspace__read_file'].includes(name))) refuse('CAPABILITY_UNSUPPORTED', path + '/tools');
  const checkedContext = context(value.context, path + '/context'); mcp(value.mcp, tools, path + '/mcp'); return { ...(raw as RoleProfile), context: checkedContext };
}
/** Outbound endpoints accept exact https URLs or explicit-port loopback http; credentials, query strings and fragments never pass. */
function endpointUrl(raw: unknown, path: string): string {
  const value = text(raw, path, 2048);
  let url: URL; try { url = new URL(value); } catch { refuse('CONFIG_SCHEMA', path); }
  if (url.href !== value || url.username || url.password || url.hash || url.search) refuse('CONFIG_SCHEMA', path);
  const loopback = url.protocol === 'http:' && (url.hostname === '127.0.0.1' || url.hostname === '[::1]') && url.port !== '';
  if (url.protocol !== 'https:' && !loopback) refuse('CONFIG_SCHEMA', path);
  return value;
}
function gateEndpoint(raw: unknown, path: string): GateEndpoint {
  const value = record(raw, ['id', 'url', 'signingCredentialRef', 'authCredentialRef', 'timeoutMs', 'maxPollMs', 'pollInitialMs', 'pollMaxMs', 'jitter'], path);
  id(value.id, path + '/id'); endpointUrl(value.url, path + '/url'); id(value.signingCredentialRef, path + '/signingCredentialRef');
  if (value.authCredentialRef !== null) id(value.authCredentialRef, path + '/authCredentialRef');
  integer(value.timeoutMs, 1000, 60000, path + '/timeoutMs'); integer(value.maxPollMs, 1000, 600000, path + '/maxPollMs');
  integer(value.pollInitialMs, 100, 30000, path + '/pollInitialMs'); integer(value.pollMaxMs, value.pollInitialMs as number, value.maxPollMs as number, path + '/pollMaxMs');
  integer(value.jitter, 0, 1000, path + '/jitter');
  return raw as GateEndpoint;
}
function publicationEndpoint(raw: unknown, path: string): PublicationEndpoint {
  const value = record(raw, ['id', 'url', 'signingCredentialRef', 'authCredentialRef', 'timeoutMs'], path);
  id(value.id, path + '/id'); endpointUrl(value.url, path + '/url'); id(value.signingCredentialRef, path + '/signingCredentialRef');
  if (value.authCredentialRef !== null) id(value.authCredentialRef, path + '/authCredentialRef');
  integer(value.timeoutMs, 1000, 60000, path + '/timeoutMs');
  return raw as PublicationEndpoint;
}
export function validateRegistry(raw: unknown): TrustedRegistry {
  const top = record(raw, ['apiVersion', 'kind', 'metadata', 'spec'], '/registry');
  if (top.apiVersion !== CONTROLLER_API_VERSION || top.kind !== 'TrustedRegistry') refuse('CONFIG_SCHEMA', '/registry');
  id(record(top.metadata, ['id'], '/registry/metadata').id, '/registry/metadata/id');
  const spec = top.spec as Record<string, unknown>, hasGate = Object.hasOwn(spec, 'gateEndpoints'), hasPublication = Object.hasOwn(spec, 'publicationEndpoints');
  const value = record(top.spec, ['version', 'resourceVersion', 'handlers', 'roleProfiles', 'resources', 'runtimeProfiles', 'credentialBindings', 'environmentBindings',
    ...(hasGate ? ['gateEndpoints' as const] : []), ...(hasPublication ? ['publicationEndpoints' as const] : [])], '/registry/spec');
  integer(value.version, 1, 1, '/registry/spec/version'); text(value.resourceVersion, '/registry/spec/resourceVersion', 128);
  const handlers = list(value.handlers).map((item, i) => validateHandler(item, '/registry/spec/handlers/' + i)); unique(handlers, '/registry/spec/handlers');
  const roles = list(value.roleProfiles).map((item, i) => role(item, '/registry/spec/roleProfiles/' + i)); unique(roles, '/registry/spec/roleProfiles');
  for (const item of list(value.runtimeProfiles)) {
    const runtime = record(item, ['id', 'identity', 'dockerExecutable', 'dockerSocket'], '/registry/spec/runtimeProfiles'); id(runtime.id);
    for (const name of ['dockerExecutable', 'dockerSocket']) if (!isAbsolute(text(runtime[name], '/registry/spec/runtimeProfiles', 4096)) || /[\0\r\n,]/.test(runtime[name] as string)) refuse('CONFIG_SCHEMA', '/registry/spec/runtimeProfiles');
    const identity = record(runtime.identity, ['sdkIntegrity', 'graphDigest', 'imageDigest', 'configDigest', 'profile'], '/registry/spec/runtimeProfiles');
    text(identity.sdkIntegrity); digestValue(identity.graphDigest); digestValue(identity.configDigest);
    if (identity.profile !== 'linux/arm64' || !/^sha256:[0-9a-f]{64}$/.test(text(identity.imageDigest))) refuse('CAPABILITY_UNSUPPORTED', '/registry/spec/runtimeProfiles');
  }
  unique(value.runtimeProfiles as readonly { id: string }[], '/registry/spec/runtimeProfiles');
  for (const item of list(value.resources)) {
    const resource = record(item, ['id', 'kind', 'path', 'digest'], '/registry/spec/resources'); id(resource.id); digestValue(resource.digest); enumValue(resource.kind, ['instruction', 'skill', 'document'], '/registry/spec/resources');
    if (!digestArtifact(text(resource.path, '/registry/spec/resources', 1024), new Uint8Array()).ok) refuse('CONFIG_SCHEMA', '/registry/spec/resources');
  }
  unique(value.resources as readonly { id: string }[], '/registry/spec/resources');
  for (const item of list(value.credentialBindings)) {
    const binding = record(item, ['id', 'consumer', 'destinationRef', 'environmentNames', 'template'], '/registry/spec/credentialBindings');
    id(binding.id); id(binding.destinationRef); enumValue(binding.consumer, ['provider', 'mcp', 'gate', 'publisher'], '/registry/spec/credentialBindings');
    const names = list(binding.environmentNames).map(name => text(name)); if (new Set(names).size !== names.length || names.some(name => !/^[A-Za-z_][A-Za-z0-9_]*$/.test(name))) refuse('CONFIG_SCHEMA', '/registry/spec/credentialBindings');
    const parts = template(text(binding.template), '/registry/spec/credentialBindings'), used = parts.flatMap(part => part.name === null ? [] : [part.name]);
    if (!used.length || used.some(name => !names.includes(name))) refuse('CONFIG_SCHEMA', '/registry/spec/credentialBindings');
  }
  unique(value.credentialBindings as readonly { id: string }[], '/registry/spec/credentialBindings');
  const environment = list(value.environmentBindings).map(item => {
    const binding = record(item, ['name', 'classification', 'paths'], '/registry/spec/environmentBindings');
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(text(binding.name))) refuse('CONFIG_SCHEMA', '/registry/spec/environmentBindings');
    enumValue(binding.classification, ['nonsecret', 'credential'], '/registry/spec/environmentBindings');
    const paths = list(binding.paths).map(path => text(path, '/registry/spec/environmentBindings', 1024));
    if (new Set(paths).size !== paths.length || paths.some(path => !path.startsWith('/spec/task/') && !/^\/spec\/credentials\/(?:0|[1-9][0-9]*)\/template$/.test(path) || /[\0\r\n]/.test(path))) refuse('CONFIG_SCHEMA', '/registry/spec/environmentBindings');
    return { name: binding.name, paths };
  });
  if (new Set(environment.map(item => item.name)).size !== environment.length) refuse('CONFIG_SCHEMA', '/registry/spec/environmentBindings');
  const gateEndpoints = (hasGate ? list(value.gateEndpoints, '/registry/spec/gateEndpoints', 16).map((item, i) => gateEndpoint(item, '/registry/spec/gateEndpoints/' + i)) : []);
  const publicationEndpoints = (hasPublication ? list(value.publicationEndpoints, '/registry/spec/publicationEndpoints', 16).map((item, i) => publicationEndpoint(item, '/registry/spec/publicationEndpoints/' + i)) : []);
  unique(gateEndpoints, '/registry/spec/gateEndpoints'); unique(publicationEndpoints, '/registry/spec/publicationEndpoints');
  const checked = raw as TrustedRegistry;
  return { ...checked, spec: { ...checked.spec, roleProfiles: roles, gateEndpoints, publicationEndpoints } };
}
