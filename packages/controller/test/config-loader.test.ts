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
    assert.deepEqual(plan.capacity, { A: 3, N: 1, I: 2, C: 3, V: 4, J: 12, D: 37, additionalRefs: 4, requiredRefs: 6, checkpointBytes: 40960 });
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
  assert.equal(checkpointCapacity(3, 1, 2, 3).D, 37); assert.equal(checkpointCapacity(2, 1, 1, 9).D, 64);
  assert.throws(() => checkpointCapacity(3, 1, 0, 13)); assert.throws(() => checkpointCapacity(16, 1, 2, 3));
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
