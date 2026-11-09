import { readFile } from 'node:fs/promises';
import { isIP } from 'node:net';
import { canonical, digest, freeze, id, integer, object, snapshot, type Json } from './boundary.js';
import { refuse } from './errors.js';
import { validatePolicy } from './policy.js';
import type { AdapterPolicy } from './types.js';
import type { AdapterPolicyV2, HttpMcpPolicy } from './types-v2.js';

export function isHttpMcp(value: AdapterPolicyV2['mcp']): value is HttpMcpPolicy {
  return Object.hasOwn(value, 'transport');
}
export function validateHttpEndpoint(endpoint: string, addresses: readonly string[]): URL {
  if (typeof endpoint !== 'string' || endpoint.length > 1024) refuse('INPUT_INVALID', '/policy/mcp/endpoint');
  let url: URL;
  try { url = new URL(endpoint); } catch { refuse('INPUT_INVALID', '/policy/mcp/endpoint'); }
  if (url.href !== endpoint || url.username || url.password || url.hash || url.search || url.pathname !== '/mcp'
    || !Array.isArray(addresses) || addresses.length < 1 || addresses.length > 4 || new Set(addresses).size !== addresses.length) refuse('INPUT_INVALID', '/policy/mcp');
  for (const address of addresses) {
    if (typeof address !== 'string' || !isIP(address) || address !== address.toLowerCase() || address.startsWith('::ffff:')) refuse('INPUT_INVALID', '/policy/mcp/approvedAddresses');
    if (isIP(address) === 6 && new URL('http://[' + address + ']/').hostname !== '[' + address + ']') refuse('INPUT_INVALID', '/policy/mcp/approvedAddresses');
  }
  if (url.protocol === 'http:') {
    if (url.hostname !== '127.0.0.1' || !url.port || addresses.some(address => address !== '127.0.0.1')) refuse('CAPABILITY_UNSUPPORTED', '/policy/mcp/endpoint');
  } else if (url.protocol !== 'https:' || isIP(url.hostname) || !/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/.test(url.hostname)
    || url.hostname.includes('..') || url.hostname.endsWith('.')) refuse('CAPABILITY_UNSUPPORTED', '/policy/mcp/endpoint');
  return url;
}

export async function effectivePolicyV2(raw: unknown): Promise<{ readonly source: AdapterPolicyV2; readonly native: AdapterPolicy; readonly sourceDigest: ReturnType<typeof digest> }> {
  const source = snapshot(raw) as unknown as AdapterPolicyV2;
  const fields = ['version', 'policyId', 'resourceVersion', 'adapterId', 'adapterVersion', 'runtime', 'selection', 'resources', 'tools', 'mcp', 'context', 'accounting', 'retry', 'extensions', 'privateArtifacts', 'limits'];
  object(source, fields, '/policy');
  if (source.version !== 2) refuse('INPUT_INVALID', '/policy/version');
  id(source.policyId, '/policy/policyId');
  let mcp: AdapterPolicy['mcp'];
  if (isHttpMcp(source.mcp)) {
    const value = object(source.mcp, ['serverId', 'transport', 'destinationRef', 'endpoint', 'approvedAddresses', 'credentialRef', 'names', 'effects', 'idleTimeoutSeconds', 'absoluteTimeoutSeconds'], '/policy/mcp');
    if (value.serverId !== 'workspace' || value.transport !== 'sessionless-http-json-v1') refuse('CAPABILITY_UNSUPPORTED', '/policy/mcp');
    id(value.destinationRef); id(value.credentialRef);
    validateHttpEndpoint(source.mcp.endpoint, source.mcp.approvedAddresses);
    const idle = integer(value.idleTimeoutSeconds, 1, 2); integer(value.absoluteTimeoutSeconds, idle, 10);
    mcp = { serverId: 'workspace', scriptDigest: digest(await readFile(new URL('./workspace-mcp.js', import.meta.url))),
      names: source.mcp.names, effects: source.mcp.effects, idleTimeoutSeconds: idle, absoluteTimeoutSeconds: source.mcp.absoluteTimeoutSeconds };
  } else mcp = source.mcp;
  const sourceDigest = digest(Buffer.from('loopwright.dev/pi-policy/v2\0' + canonical(source)));
  // Full SHA256 encoded as a bounded identifier; native v1 snapshots now bind every v2 field without changing their format.
  const policyId = 'v2.' + BigInt('0x' + sourceDigest.hex).toString(36);
  const native = validatePolicy(snapshot({ ...source, version: 1, policyId, mcp }) as Json);
  return freeze({ source, native, sourceDigest });
}
