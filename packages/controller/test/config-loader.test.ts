import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, writeFile, symlink, link, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { stringify } from 'yaml';
import { compilePlan, checkpointCapacity } from '../src/compile.js';
import { approvedState } from '../src/config.js';
import type { ControllerResult } from '../src/errors.js';
import type { LoadedConfiguration } from '../src/types.js';
import { hash } from '../src/schema.js';
import { configurationFixture, TOKEN } from './config-fixtures.js';
import { installedHandlerDigests } from '../src/handlers.js';
function good<T>(result: ControllerResult<T>): T { assert.equal(result.ok, true, result.ok ? '' : JSON.stringify(result.error)); if (!result.ok) throw new Error('expected success'); return result.value; }
function set(value: unknown, path: readonly (string | number)[], replacement: unknown): void {
  let parent = value as Record<string | number, unknown>;
  for (const key of path.slice(0, -1)) parent = parent[key] as Record<string | number, unknown>;
  parent[path.at(-1)!] = replacement;
}
test('trusted static compilation binds exact bytes, profile grants and the complete checkpoint schedule without admission', async () => {
  const f = await configurationFixture();
  try {
    const loaded = good(await f.load()), plan = good(await compilePlan(loaded));
    assert.equal(plan.admission, 'not_performed'); assert.equal(plan.runId, null); assert.equal(plan.lock, null); assert.equal(plan.effectfulReadiness, 'not_checked');
    assert.deepEqual(plan.capacity, { A: 3, N: 1, I: 2, C: 3, V: 4, J: 12, D: 37, publication: false, additionalRefs: 4, requiredRefs: 6, checkpointBytes: 40960 });
    assert.equal(plan.orderedDAG[0]!.handler.id, 'package.patch'); assert.equal(plan.roles[0]!.policy.context.mode, 'estimated_guard'); assert.ok(Object.isFrozen(plan));
    assert.ok(!JSON.stringify({ loaded, plan }).includes(TOKEN)); assert.ok(!JSON.stringify(plan).includes(hash(TOKEN).hex));
    assert.deepEqual(f.lookedUp, ['PROVIDER_TOKEN']);
    assert.deepEqual(good(await compilePlan(loaded)), plan);
    const fake = await compilePlan(JSON.parse(JSON.stringify(loaded)) as LoadedConfiguration); assert.equal(fake.ok, false); if (!fake.ok) assert.equal(fake.error.code, 'REGISTRY_UNTRUSTED');
  } finally { await f.cleanup(); }
});
test('parse then single-pass interpolation preserves quotes, newlines, escaping, arrays and inserted expressions as data', async () => {
  const f = await configurationFixture();
  try {
    set(f.config, ['spec', 'task', 'spec', 'goal'], 'before ${LABEL} after $${UNREAD} $$ $BARE');
    set(f.config, ['spec', 'task', 'spec', 'roles', 0, 'tools'], ['${TOOL}']);
    set(f.registry, ['spec', 'environmentBindings'], [...f.registry.spec.environmentBindings,
      { name: 'LABEL', classification: 'nonsecret', paths: ['/spec/task/spec/goal'] }, { name: 'TOOL', classification: 'nonsecret', paths: ['/spec/task/spec/roles/0/tools/0'] }]);
    f.environment.LABEL = 'quoted"\n${PROVIDER_TOKEN}'; f.environment.TOOL = 'read'; await f.save();
    const loaded = good(await f.load()); assert.equal(loaded.configuration.spec.task.spec.goal, 'before quoted"\n${PROVIDER_TOKEN} after ${UNREAD} $ $BARE');
    assert.deepEqual(loaded.configuration.spec.task.spec.roles[0]!.tools, ['read']); assert.deepEqual(f.lookedUp, ['LABEL', 'TOOL', 'PROVIDER_TOKEN']);
    assert.ok(!JSON.stringify(loaded).includes(TOKEN));
  } finally { await f.cleanup(); }
});
test('unapproved or malformed references are rejected before any environment lookup and unknown names stay private', async () => {
  for (const value of ['${UNAPPROVED_PRIVATE_NAME}', '${PROVIDER_TOKEN}', '${LABEL:-default}', '${}', '${LABEL']) {
    const f = await configurationFixture();
    try {
      set(f.config, ['spec', 'task', 'spec', 'goal'], value); await f.save();
      const result = await f.load(); assert.equal(result.ok, false); assert.deepEqual(f.lookedUp, []); assert.ok(!JSON.stringify(result).includes('UNAPPROVED_PRIVATE_NAME'));
    } finally { await f.cleanup(); }
  }
});
test('a secret-class binding cannot authorize a task field even when its path appears in the registry', async () => {
  const f = await configurationFixture();
  try {
    set(f.config, ['spec', 'task', 'spec', 'goal'], '${PROVIDER_TOKEN}');
    set(f.registry, ['spec', 'environmentBindings', 0, 'paths'], ['/spec/task/spec/goal', '/spec/credentials/0/template']); await f.save();
    const result = await f.load(); assert.equal(result.ok, false); assert.deepEqual(f.lookedUp, []); if (!result.ok) assert.equal(result.error.code, 'CONFIG_ENV_DENIED');
  } finally { await f.cleanup(); }
});
test('missing and empty auth refuse before execution without exposing environment values or token fingerprints', async () => {
  for (const token of [undefined, '', 'bad\r\nheader', 'x'.repeat(4097)]) {
    const f = await configurationFixture();
    try {
      f.environment.PROVIDER_TOKEN = token; const result = await f.load(); assert.equal(result.ok, false);
      if (!result.ok) assert.equal(result.error.code, token === undefined ? 'CONFIG_ENV_MISSING' : 'CONFIG_CREDENTIAL_INVALID');
      assert.ok(!JSON.stringify(result).includes('bad'));
    } finally { await f.cleanup(); }
  }
});
test('nonsecret empty substitution remains a string and substituted output still has a finite string bound', async () => {
  const f = await configurationFixture();
  try {
    set(f.registry, ['spec', 'environmentBindings'], [...f.registry.spec.environmentBindings, { name: 'LABEL', classification: 'nonsecret', paths: ['/spec/task/spec/goal'] }]);
    set(f.config, ['spec', 'task', 'spec', 'goal'], 'prefix${LABEL}suffix'); f.environment.LABEL = ''; await f.save();
    assert.equal(good(await f.load()).configuration.spec.task.spec.goal, 'prefixsuffix');
    f.environment.LABEL = 'x'.repeat(16385); const result = await f.load(); assert.equal(result.ok, false); if (!result.ok) assert.equal(result.error.code, 'CONFIG_LIMIT');
  } finally { await f.cleanup(); }
});
test('registry approval, ownership permissions and external root are checked before environment access', async () => {
  for (const mode of ['hash', 'file-mode', 'directory-mode', 'inside-root', 'hardlink', 'symlink'] as const) {
    const f = await configurationFixture();
    try {
      if (mode === 'hash') f.input.registrySha256 = '0'.repeat(64);
      if (mode === 'file-mode') await chmod(f.input.registryPath, 0o644);
      if (mode === 'directory-mode') await chmod(f.operator, 0o755);
      if (mode === 'inside-root') f.input.untrustedRoots.push(f.operator);
      if (mode === 'hardlink') await link(f.input.registryPath, join(f.operator, 'second.json'));
      if (mode === 'symlink') { await symlink(f.input.registryPath, join(f.operator, 'alias.json')); f.input.registryPath = join(f.operator, 'alias.json'); }
      const result = await f.load(); assert.equal(result.ok, false); assert.deepEqual(f.lookedUp, []); if (!result.ok) assert.equal(result.error.code, 'REGISTRY_UNTRUSTED');
    } finally { await f.cleanup(); }
  }
});
test('source duplicate keys and unknown fields cannot bypass the closed configuration envelope', async () => {
  const f = await configurationFixture();
  try {
    await writeFile(f.input.configPath, '{"apiVersion":"one","apiVersion":"two"}');
    const duplicate = await f.load(); assert.equal(duplicate.ok, false); if (!duplicate.ok) assert.equal(duplicate.error.code, 'CONFIG_DUPLICATE_KEY');
    set(f.config, ['SECRET_UNKNOWN_FIELD'], '${PROVIDER_TOKEN}'); await f.save();
    const unknown = await f.load(); assert.equal(unknown.ok, false); assert.ok(!JSON.stringify(unknown).includes('SECRET_UNKNOWN_FIELD')); assert.deepEqual(f.lookedUp, []);
  } finally { await f.cleanup(); }
});
test('handler, role grant, DAG cycle, strict default, hard tokens and unknown native transport refuse statically', async () => {
  for (const mode of ['handler', 'grant', 'cycle', 'strict', 'missing-mode', 'hard', 'oauth', 'shell'] as const) {
    const f = await configurationFixture();
    try {
      if (mode === 'handler') set(f.registry, ['spec', 'handlers', 0, 'digest', 'hex'], '0'.repeat(64));
      if (mode === 'grant') set(f.config, ['spec', 'task', 'spec', 'roles', 0, 'tools'], ['bash']);
      if (mode === 'cycle') set(f.config, ['spec', 'task', 'spec', 'steps', 0, 'dependsOn'], ['build']);
      if (mode === 'strict') set(f.registry, ['spec', 'roleProfiles', 0, 'context', 'mode'], 'proven_bound');
      if (mode === 'missing-mode') set(f.registry, ['spec', 'roleProfiles', 0, 'context'], Object.fromEntries(Object.entries(f.registry.spec.roleProfiles[0]!.context).filter(([key]) => key !== 'mode')));
      if (mode === 'hard') set(f.config, ['spec', 'task', 'spec', 'budgets', 'enforcement', 'tokens'], 'hard_admission');
      if (mode === 'oauth') set(f.registry, ['spec', 'roleProfiles', 0, 'mcp', 'oauth'], {});
      if (mode === 'shell') set(f.registry, ['spec', 'handlers', 0, 'implementation'], 'shell.test.v1');
      await f.save(); const loaded = await f.load(); const result = loaded.ok ? await compilePlan(loaded.value) : loaded; assert.equal(result.ok, false);
      if (mode === 'shell' && !result.ok) assert.equal(result.error.code, 'CAPABILITY_UNSUPPORTED');
      if (mode === 'missing-mode' && loaded.ok) assert.equal(loaded.value.registry.spec.roleProfiles[0]!.context.mode, 'proven_bound');
      assert.ok(!JSON.stringify(result).includes(TOKEN));
    } finally { await f.cleanup(); }
  }
});
test('the complete YAML configuration follows the same trusted loader and compilation path', async () => {
  const f = await configurationFixture();
  try {
    f.input.configPath = join(f.taskDirectory, 'task.yaml'); await writeFile(f.input.configPath, stringify(f.config), { mode: 0o600 });
    const loaded = good(await f.load()), plan = good(await compilePlan(loaded)); assert.equal(plan.task.spec.goal, f.config.spec.task.spec.goal);
    assert.equal(plan.effectfulReadiness, 'not_checked'); assert.ok(!JSON.stringify(plan).includes(TOKEN));
  } finally { await f.cleanup(); }
});
test('approved resource bytes are retained exactly and changed bytes refuse before admission', async () => {
  const f = await configurationFixture();
  try {
    const bytes = Buffer.from('trusted instructions\n'), resource = { id: 'guide', kind: 'document' as const, path: 'guide.txt', digest: hash(bytes) };
    set(f.registry, ['spec', 'resources'], [resource]); set(f.config, ['spec', 'task', 'spec', 'trustedContext', 'resources'], [resource]);
    await writeFile(join(f.operator, resource.path), bytes, { mode: 0o600 }); await f.save();
    const loaded = good(await f.load()), plan = good(await compilePlan(loaded)); assert.equal(plan.resources[0]!.ref.digest.hex, resource.digest.hex);
    assert.deepEqual(approvedState(loaded).resources[0]!.bytes, new Uint8Array(bytes));
    await writeFile(join(f.operator, resource.path), 'changed instructions\n'); const refused = await f.load(); assert.equal(refused.ok, false); if (!refused.ok) assert.equal(refused.error.code, 'CONFIG_REFERENCE');
  } finally { await f.cleanup(); }
});
test('MCP credentials use a dedicated exact-destination binding and never enter the compiled plan', async () => {
  const f = await configurationFixture();
  try {
    const mcpToken = 'S04_MCP_CONFIG_CANARY_Ff46Gg37Hh28'; f.environment.MCP_TOKEN = mcpToken;
    set(f.registry, ['spec', 'credentialBindings'], [...f.registry.spec.credentialBindings, { id: 'mirror-token', consumer: 'mcp', destinationRef: 'mirror', environmentNames: ['MCP_TOKEN'], template: '${MCP_TOKEN}' }]);
    set(f.registry, ['spec', 'environmentBindings'], [...f.registry.spec.environmentBindings, { name: 'MCP_TOKEN', classification: 'credential', paths: ['/spec/credentials/1/template'] }]);
    set(f.config, ['spec', 'credentials'], [...f.config.spec.credentials, { ref: 'mirror-token', template: '${MCP_TOKEN}' }]);
    const tools = ['read', 'mcp__workspace__read_file']; set(f.registry, ['spec', 'roleProfiles', 0, 'tools'], tools); set(f.config, ['spec', 'task', 'spec', 'roles', 0, 'tools'], tools);
    set(f.registry, ['spec', 'roleProfiles', 0, 'mcp'], { serverId: 'workspace', transport: 'sessionless-http-json-v1', destinationRef: 'mirror', endpoint: 'http://127.0.0.1:39101/mcp', approvedAddresses: ['127.0.0.1'], credentialRef: 'mirror-token', names: ['mcp__workspace__read_file'], effects: ['read_only'], idleTimeoutSeconds: 2, absoluteTimeoutSeconds: 10 });
    await f.save(); const loaded = good(await f.load()), plan = good(await compilePlan(loaded));
    const resolvers = approvedState(loaded).vault.bind({ runId: 'run-1', roleId: 'builder', stepId: 'build', providerCredentialRef: 'copilot', selection: plan.roles[0]!.policy.selection, mcp: plan.roles[0]!.policy.mcp });
    const binding = { serverId: 'workspace' as const, transport: 'sessionless-http-json-v1' as const, destinationRef: 'mirror', endpoint: 'http://127.0.0.1:39101/mcp', method: 'POST' as const, credentialRef: 'mirror-token', runId: 'run-1', roleId: 'builder', stepId: 'build', purpose: 'task' as const, parentRequestId: 'req-1', managementOperationId: null, notAfterMonotonicMs: '1000', signal: new AbortController().signal };
    assert.equal((await resolvers.resolveMcpCredential(binding)).bearerToken, mcpToken);
    await assert.rejects(resolvers.resolveMcpCredential({ ...binding, endpoint: 'http://127.0.0.1:39102/mcp' }));
    await assert.rejects(resolvers.resolveMcpCredential({ ...binding, destinationRef: 'other' }));
    await assert.rejects(resolvers.resolveMcpCredential({ ...binding, credentialRef: 'copilot' }));
    assert.ok(!JSON.stringify({ loaded, plan }).includes(mcpToken)); assert.ok(!JSON.stringify(plan).includes(hash(mcpToken).hex));
  } finally { await f.cleanup(); }
});
test('actual plan compilation accepts 64 scheduled records and refuses 65 before admission', async () => {
  for (const exact of [true, false]) {
    const f = await configurationFixture();
    try {
      const prototype = f.registry.spec.handlers.find(handler => handler.implementation === 'json-artifact.v1')!;
      const checkIds = Array.from({ length: exact ? 7 : 11 }, (_, index) => index ? 'tests-' + index : 'tests');
      set(f.registry, ['spec', 'handlers'], [...f.registry.spec.handlers.filter(handler => handler !== prototype), ...checkIds.map(id => ({ ...prototype, id, parameters: { ...prototype.parameters, checkId: id } }))]);
      set(f.config, ['spec', 'task', 'spec', 'acceptance'], { required: checkIds, checks: checkIds.map(id => ({ id, allowedEvidenceLevels: ['local_execution'] })) });
      set(f.config, ['spec', 'controls', 'maxAttempts'], exact ? 2 : 3); set(f.config, ['spec', 'task', 'spec', 'budgets', 'maxImplementationRepairs'], exact ? 1 : 0);
      await f.save(); const compiled = await compilePlan(good(await f.load()));
      if (exact) assert.equal(good(compiled).capacity.D, 64);
      else { assert.equal(compiled.ok, false); if (!compiled.ok) assert.equal(compiled.error.code, 'CONFIG_LIMIT'); }
    } finally { await f.cleanup(); }
  }
});
test('the complete checkpoint calculation preserves the worked, exact-fit and one-over cases', () => {
  assert.equal(checkpointCapacity(3, 1, 2, 3, false).D, 37); assert.equal(checkpointCapacity(2, 1, 1, 9, false).D, 64);
  assert.equal(checkpointCapacity(3, 1, 2, 3, true).D, 40); assert.throws(() => checkpointCapacity(2, 1, 1, 9, true));
  assert.throws(() => checkpointCapacity(3, 1, 0, 13, false)); assert.throws(() => checkpointCapacity(16, 1, 2, 3, false));
});
test('credential rotation retains the same plan identity and resolver refuses a changed destination', async () => {
  const f = await configurationFixture();
  try {
    const first = good(await f.load()), plan = good(await compilePlan(first));
    f.environment.PROVIDER_TOKEN = 'S04_CONTROLLER_ROTATED_CANARY_Dd64Ee55';
    const second = good(await f.load()), next = good(await compilePlan(second)); assert.deepEqual(next, plan);
    const callback = approvedState(second).vault.bind({ runId: 'run-1', roleId: 'builder', stepId: 'build', providerCredentialRef: 'copilot', selection: plan.roles[0]!.policy.selection, mcp: plan.roles[0]!.policy.mcp }).resolveCredential;
    const binding = { provider: 'github-copilot', model: 'claude-sonnet-5.5', destination: 'https://api.individual.githubcopilot.com/v1/messages?beta=true', purpose: 'task' as const,
      runId: 'run-1', roleId: 'builder', stepId: 'build', notAfterMonotonicMs: '1000', signal: new AbortController().signal };
    assert.equal((await callback(binding)).bearerToken, f.environment.PROVIDER_TOKEN);
    await assert.rejects(callback({ ...binding, destination: 'http://127.0.0.1/other' }));
    assert.ok(!JSON.stringify(next).includes(f.environment.PROVIDER_TOKEN));
    assert.equal((await readFile(f.input.configPath, 'utf8')).includes(TOKEN), false);
  } finally { await f.cleanup(); }
});

test('untrusted config path symlink reports CONFIG_SYNTAX at /config instead of REGISTRY_UNTRUSTED at /registry', async () => {
  const f = await configurationFixture();
  try {
    await symlink(f.input.configPath, join(f.taskDirectory, 'config-link.json'));
    f.input.configPath = join(f.taskDirectory, 'config-link.json');
    const result = await f.load();
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.error.code, 'CONFIG_SYNTAX');
      assert.equal(result.error.path, '/config');
    }
  } finally { await f.cleanup(); }
});

const GATE_SECRET = 'S05_GATE_SIGNING_CANARY_Aa11Bb22Cc33', PUBLISHER_SECRET = 'S05_PUBLISHER_SIGNING_CANARY_Dd44Ee55Ff66', PUBLISHER_TOKEN = 'S05_PUBLISHER_AUTH_CANARY_Gg77Hh88Ii99';
async function gateFixture(f: Awaited<ReturnType<typeof configurationFixture>>, options: { publication?: boolean } = {}) {
  f.environment.GATE_SECRET = GATE_SECRET; f.environment.PUBLISHER_SECRET = PUBLISHER_SECRET; f.environment.PUBLISHER_TOKEN = PUBLISHER_TOKEN;
  set(f.registry, ['spec', 'credentialBindings'], [...f.registry.spec.credentialBindings,
    { id: 'gate-signer', consumer: 'gate', destinationRef: 'gate-service', environmentNames: ['GATE_SECRET'], template: '${GATE_SECRET}' },
    { id: 'publisher-signer', consumer: 'publisher', destinationRef: 'publisher-service', environmentNames: ['PUBLISHER_SECRET'], template: '${PUBLISHER_SECRET}' },
    { id: 'publisher-auth', consumer: 'publisher', destinationRef: 'publisher-service', environmentNames: ['PUBLISHER_TOKEN'], template: '${PUBLISHER_TOKEN}' }]);
  set(f.registry, ['spec', 'environmentBindings'], [...f.registry.spec.environmentBindings,
    { name: 'GATE_SECRET', classification: 'credential', paths: ['/spec/credentials/1/template'] },
    { name: 'PUBLISHER_SECRET', classification: 'credential', paths: ['/spec/credentials/2/template'] },
    { name: 'PUBLISHER_TOKEN', classification: 'credential', paths: ['/spec/credentials/3/template'] }]);
  set(f.config, ['spec', 'credentials'], [...f.config.spec.credentials, { ref: 'gate-signer', template: '${GATE_SECRET}' }, { ref: 'publisher-signer', template: '${PUBLISHER_SECRET}' }, { ref: 'publisher-auth', template: '${PUBLISHER_TOKEN}' }]);
  set(f.registry, ['spec', 'gateEndpoints'], [{ id: 'ci-gate', url: 'http://127.0.0.1:8443/gate', signingCredentialRef: 'gate-signer', authCredentialRef: null, timeoutMs: 5000, maxPollMs: 60000, pollInitialMs: 200, pollMaxMs: 8000, jitter: 100 }]);
  set(f.registry, ['spec', 'publicationEndpoints'], [{ id: 'pr-publisher', url: 'https://publisher.example.internal/publish', signingCredentialRef: 'publisher-signer', authCredentialRef: 'publisher-auth', timeoutMs: 10000 }]);
  const installed = await installedHandlerDigests();
  set(f.registry, ['spec', 'handlers'], [...f.registry.spec.handlers, { id: 'approval', kind: 'check', implementation: 'gate.v1', version: 1, digest: installed['gate.v1'], parameters: { checkId: 'approval', endpointRef: 'ci-gate', gateId: 'merge-gate' }, capabilities: ['external_service', 'read_only'] }]);
  set(f.config, ['spec', 'task', 'spec', 'steps'], [...f.config.spec.task.spec.steps, { id: 'approval', kind: 'check', uses: 'approval', roleId: null, dependsOn: ['build'] }]);
  set(f.config, ['spec', 'profiles', 'steps'], [...f.config.spec.profiles.steps, { stepId: 'approval', handlerRef: 'approval' }]);
  set(f.config, ['spec', 'task', 'spec', 'acceptance'], { required: ['tests'], checks: [...f.config.spec.task.spec.acceptance.checks, { id: 'approval', allowedEvidenceLevels: ['external_service'] }] });
  if (options.publication) set(f.config, ['spec', 'publication'], { mode: 'pull_request', endpointRef: 'pr-publisher', targetBranch: 'main', headBranchPrefix: 'loopwright/', titleTemplate: 'Loopwright run publication' });
  await f.save();
}
test('gate and publication endpoints, consumers, and the publication block validate and compile', async () => {
  const f = await configurationFixture();
  try {
    await gateFixture(f, { publication: true });
    const loaded = good(await f.load()), plan = good(await compilePlan(loaded));
    assert.deepEqual(loaded.registry.spec.gateEndpoints, [{ id: 'ci-gate', url: 'http://127.0.0.1:8443/gate', signingCredentialRef: 'gate-signer', authCredentialRef: null, timeoutMs: 5000, maxPollMs: 60000, pollInitialMs: 200, pollMaxMs: 8000, jitter: 100 }]);
    assert.deepEqual(plan.publication, { mode: 'pull_request', endpointRef: 'pr-publisher', targetBranch: 'main', headBranchPrefix: 'loopwright/', titleTemplate: 'Loopwright run publication' });
    assert.deepEqual(plan.capacity, { A: 3, N: 1, I: 2, C: 4, V: 4, J: 16, D: 48, publication: true, additionalRefs: 4, requiredRefs: 6, checkpointBytes: 40960 });
    const slot = plan.verifierSlots.find(slot => slot.checkId === 'approval');
    assert.ok(slot); assert.equal(slot.handler.implementation, 'gate.v1'); assert.equal(slot.implicit, null);
    assert.ok(!JSON.stringify({ loaded, plan }).includes(GATE_SECRET)); assert.ok(!JSON.stringify({ loaded, plan }).includes(PUBLISHER_SECRET)); assert.ok(!JSON.stringify({ loaded, plan }).includes(PUBLISHER_TOKEN));
    assert.ok(!JSON.stringify(plan).includes(hash(GATE_SECRET).hex));
  } finally { await f.cleanup(); }
});
test('omitted endpoint tables default to empty and publication defaults to disabled', async () => {
  const f = await configurationFixture();
  try {
    const loaded = good(await f.load());
    assert.deepEqual(loaded.registry.spec.gateEndpoints, []); assert.deepEqual(loaded.registry.spec.publicationEndpoints, []);
    assert.deepEqual(good(await compilePlan(loaded)).publication, { mode: 'disabled' });
  } finally { await f.cleanup(); }
});
test('endpoint URL policy, capability vocabulary, and compile cross-references refuse before admission', async () => {
  const cases = {
    'public-http': { path: ['spec', 'gateEndpoints', 0, 'url'], registry: 'http://10.1.2.3/gate', stage: 'load', code: 'CONFIG_SCHEMA' },
    userinfo: { path: ['spec', 'gateEndpoints', 0, 'url'], registry: 'http://user:pass@127.0.0.1:8443/gate', stage: 'load', code: 'CONFIG_SCHEMA' },
    query: { path: ['spec', 'gateEndpoints', 0, 'url'], registry: 'https://gate.example.internal/gate?x=1', stage: 'load', code: 'CONFIG_SCHEMA' },
    fragment: { path: ['spec', 'gateEndpoints', 0, 'url'], registry: 'https://gate.example.internal/gate#frag', stage: 'load', code: 'CONFIG_SCHEMA' },
    relative: { path: ['spec', 'gateEndpoints', 0, 'url'], registry: 'gate/relative', stage: 'load', code: 'CONFIG_SCHEMA' },
    scheme: { path: ['spec', 'gateEndpoints', 0, 'url'], registry: 'ftp://gate.example.internal/gate', stage: 'load', code: 'CONFIG_SCHEMA' },
    capabilities: { path: ['spec', 'handlers', 4, 'capabilities'], registry: ['inert_bytes', 'read_only'], stage: 'load', code: 'CAPABILITY_UNSUPPORTED' },
    provider: { path: ['spec', 'credentialBindings', 2, 'consumer'], registry: 'filesystem', stage: 'load', code: 'CONFIG_SCHEMA' },
    level: { path: ['spec', 'task', 'spec', 'acceptance', 'checks', 1, 'allowedEvidenceLevels'], config: ['local_execution'], stage: 'compile', code: 'CONFIG_SCHEMA' },
    'endpoint-ref': { path: ['spec', 'handlers', 4, 'parameters'], registry: { checkId: 'approval', endpointRef: 'missing', gateId: 'merge-gate' }, stage: 'compile', code: 'CONFIG_REFERENCE' },
    'publication-endpoint': { path: ['spec', 'publication'], config: { mode: 'pull_request', endpointRef: 'missing', targetBranch: 'main', headBranchPrefix: 'loopwright/', titleTemplate: 'Loopwright run publication' }, stage: 'compile', code: 'CONFIG_REFERENCE' },
    'publication-credentials': { path: ['spec', 'publicationEndpoints', 0, 'signingCredentialRef'], registry: 'gate-signer', stage: 'compile', code: 'CONFIG_REFERENCE' },
  } as const;
  for (const [mode, mutation] of Object.entries(cases)) {
    const f = await configurationFixture();
    try {
      await gateFixture(f, { publication: true });
      const root = 'registry' in mutation ? f.registry as unknown as Record<string | number, unknown> : f.config as unknown as Record<string | number, unknown>;
      set(root, mutation.path, 'registry' in mutation ? mutation.registry : mutation.config);
      await f.save();
      const loaded = await f.load(), result = loaded.ok ? await compilePlan(loaded.value) : loaded;
      assert.equal(result.ok, false, mode); if (!result.ok) assert.equal(result.error.code, mutation.code, mode);
      assert.ok(!JSON.stringify(result).includes(GATE_SECRET), mode);
    } finally { await f.cleanup(); }
  }
});
test('the publication block requires pull_request credentials present in the configuration', async () => {
  const f = await configurationFixture();
  try {
    await gateFixture(f, { publication: true });
    set(f.config, ['spec', 'credentials'], f.config.spec.credentials.filter(entry => entry.ref !== 'publisher-auth'));
    await f.save();
    const loaded = good(await f.load()), result = await compilePlan(loaded);
    assert.equal(result.ok, false); if (!result.ok) assert.equal(result.error.code, 'CONFIG_REFERENCE');
  } finally { await f.cleanup(); }
});
