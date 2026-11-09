import test from 'node:test';
import assert from 'node:assert/strict';
import { sessionInput } from './session-fixtures.js';
import { effectivePolicyV2, validateHttpEndpoint } from '../src/policy-v2.js';
import { prepareInput } from '../src/preflight.js';
import { constructAdapter, runtimePorts } from '../src/adapter.js';
import { constructAdapterV2 } from '../src/adapter-v2.js';
import type { PiHost } from '../src/types.js';
import type { PiHostV2 } from '../src/types-v2.js';
import type { AdapterPolicyV2 } from '../src/types-v2.js';

function policy(): AdapterPolicyV2 {
  const input = sessionInput();
  return { ...input.policy, version: 2, tools: ['mcp__workspace__read_file'], mcp: { serverId: 'workspace', transport: 'sessionless-http-json-v1',
    destinationRef: 'candidate-mirror', endpoint: 'http://127.0.0.1:39101/mcp', approvedAddresses: ['127.0.0.1'], credentialRef: 'mirror-token',
    names: ['mcp__workspace__read_file'], effects: ['read_only'], idleTimeoutSeconds: 2, absoluteTimeoutSeconds: 10 } };
}
test('v2 preserves v1 rejection and binds every nonsecret destination field without credential material', async () => {
  const original = policy();
  const prepared = await effectivePolicyV2(original);
  assert.equal(prepared.native.version, 1);
  assert.match(prepared.native.policyId, /^v2\.[a-z0-9]+$/);
  assert.ok(prepared.native.policyId.length <= 64);
  assert.equal((await effectivePolicyV2(structuredClone(original))).native.policyId, prepared.native.policyId);
  const changed = structuredClone(original);
  if (!('endpoint' in changed.mcp)) throw new Error('test policy');
  (changed.mcp as { endpoint: string }).endpoint = 'http://127.0.0.1:39102/mcp';
  assert.notEqual((await effectivePolicyV2(changed)).native.policyId, prepared.native.policyId);
  const input = sessionInput();
  assert.throws(() => prepareInput({ ...input, policy: original }));
  await assert.rejects(effectivePolicyV2({ ...original, unknown: true }));
  await assert.rejects(effectivePolicyV2({ ...original, policyId: 'INVALID' }));
});
test('approved MCP endpoint rules refuse aliases, credentials, redirects targets and unbound address lists', () => {
  assert.equal(validateHttpEndpoint('http://127.0.0.1:39101/mcp', ['127.0.0.1']).port, '39101');
  assert.equal(validateHttpEndpoint('https://mirror.loopwright.test/mcp', ['127.0.0.1']).hostname, 'mirror.loopwright.test');
  for (const url of ['http://localhost:39101/mcp', 'http://127.0.0.2:39101/mcp', 'http://127.0.0.1:39101/mcp?other',
    'http://token@127.0.0.1:39101/mcp', 'https://mirror.loopwright.test/other', 'https://mirror.loopwright.test/mcp#next']) assert.throws(() => validateHttpEndpoint(url, ['127.0.0.1']));
  assert.throws(() => validateHttpEndpoint('http://127.0.0.1:39101/mcp', ['127.0.0.2']));
  assert.throws(() => validateHttpEndpoint('https://mirror.loopwright.test/mcp', ['::ffff:127.0.0.1']));
});

test('closed v2 MCP policy refuses server, effect, tool, OAuth and TLS trust overrides before startup', async () => {
  const input = sessionInput();
  const source = policy();
  let effects = 0;
  const host = { store: {}, authority: {}, directory: '/unused', artifactsDirectory: '/unused', dockerExecutable: '/unused', dockerSocket: '/unused',
    runtime: input.policy.runtime, resolveCredential: async () => { effects++; return { bearerToken: 'unused' }; },
    resolveMcpCredential: async () => { effects++; return { bearerToken: 'unused' }; } } as unknown as PiHostV2;
  const ports = { ...runtimePorts, environment: async () => { effects++; throw new Error('UNEXPECTED_STARTUP'); } };
  for (const changed of [
    { ...source.mcp, serverId: 'other' }, { ...source.mcp, effects: ['external_write'] }, { ...source.mcp, names: ['mcp__workspace__denied_write'] },
    { ...source.mcp, ca: 'untrusted' }, { ...source.mcp, rejectUnauthorized: false }, { ...source.mcp, insecure: true }, { ...source.mcp, oauth: {} },
    { ...source.mcp, endpoint: 'http://127.0.0.1:39101/credential-trap' }, { ...source.mcp, destinationRef: 'INVALID' },
  ]) {
    const result = await constructAdapterV2(host, { ...input, version: 2, policy: { ...source, mcp: changed } }, ports);
    assert.equal(result.ok, false);
    assert.equal(effects, 0);
  }
  const legacy = await constructAdapter(host as PiHost, input, ports);
  assert.equal(legacy.ok, false);
  assert.equal(effects, 0);
});
