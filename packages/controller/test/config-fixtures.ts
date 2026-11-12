import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readFile } from 'node:fs/promises';
import { describePiAdapterFiles } from '@loopwright/agent-pi';
import { validateDocument } from '@loopwright/core';
import { contract } from '../../core/test/fixtures.js';
import { installedHandlerDigests } from '../src/handlers.js';
import { hash } from '../src/schema.js';
import { loadConfiguration } from '../src/config.js';
import type { TrustedRegistry, ControllerConfiguration } from '../src/types.js';
export const TOKEN = 'S04_CONTROLLER_PRIVATE_CANARY_Aa91Bb82Cc73';
export async function configurationFixture() {
  const root = await mkdtemp(join(await realpath(tmpdir()), 'loopwright-controller-'));
  const operator = join(root, 'operator'), taskDirectory = join(root, 'task'); await mkdir(operator, { mode: 0o700 }); await mkdir(taskDirectory, { mode: 0o700 });
  const described = await describePiAdapterFiles(); assert.equal(described.ok, true); if (!described.ok) throw new Error('fixture');
  const files = described.value, installed = await installedHandlerDigests(), task = contract();
  task.spec.roles[0]!.model = 'claude-sonnet-5.5'; task.spec.roles[0]!.thinking = 'xhigh'; task.spec.roles[0]!.tools = ['read'];
  task.spec.budgets.wallTimeMs = 600000; task.spec.budgets.perCallOutputTokens = 1024; task.spec.budgets.totalTokens = 100000;
  const validated = validateDocument(task, 'TaskContract'); assert.equal(validated.ok, true); if (!validated.ok) throw new Error('fixture');
  const registry: TrustedRegistry = { apiVersion: 'loopwright.dev/v1alpha1', kind: 'TrustedRegistry', metadata: { name: 'operator' }, spec: {
    version: 1, resourceVersion: 'context-1', handlers: [
      { id: 'package.patch', kind: 'agent', implementation: 'pi.agent.v1', version: 1, digest: installed['pi.agent.v1'], parameters: { prompt: 'Produce one structured submission for the frozen candidate.', purpose: 'task' }, capabilities: ['pi'] },
      { id: 'tests', kind: 'check', implementation: 'json-artifact.v1', version: 1, digest: installed['json-artifact.v1'], parameters: { checkId: 'tests', path: 'result.json', required: ['ok'], equals: { ok: true } }, capabilities: ['inert_bytes', 'read_only'] },
      { id: 'scope', kind: 'check', implementation: 'scope.v1', version: 1, digest: installed['scope.v1'], parameters: { checkId: null }, capabilities: ['inert_bytes', 'read_only'] },
      { id: 'no-change', kind: 'check', implementation: 'no-change.v1', version: 1, digest: installed['no-change.v1'], parameters: { checkId: null }, capabilities: ['inert_bytes', 'read_only'] },
    ], roleProfiles: [{ id: 'builder', runtimeRef: 'docker', providerCredentialRef: 'copilot', selection: { provider: 'github-copilot', model: 'claude-sonnet-5.5', thinking: 'xhigh', api: 'anthropic-messages' },
      tools: ['read'], context: { mode: 'estimated_guard', estimator: 'lw-pi-final-json-bytes-v1', proofId: null, version: 1, evidence: 'estimated', workingWindowCeiling: 98304, maxRequestBytes: 65536, serviceMargin: 32768, toolReserve: 16384, maxOutputTokens: 1024 },
      mcp: { serverId: 'workspace', scriptDigest: files.localMcpScriptDigest, names: [], effects: [], idleTimeoutSeconds: 2, absoluteTimeoutSeconds: 10 } }],
    runtimeProfiles: [{ id: 'docker', dockerExecutable: '/usr/local/bin/docker', dockerSocket: '/private/declared/docker.sock', identity: { sdkIntegrity: files.sdkIntegrity, graphDigest: hash(await readFile(new URL('../../../package-lock.json', import.meta.resolve('@loopwright/agent-pi')))), configDigest: files.restrictionDigest, imageDigest: 'sha256:' + 'a'.repeat(64), profile: 'linux/arm64' } }],
    resources: [], credentialBindings: [{ id: 'copilot', consumer: 'provider', destinationRef: 'github-copilot', environmentNames: ['PROVIDER_TOKEN'], template: '${PROVIDER_TOKEN}' }],
    environmentBindings: [{ name: 'PROVIDER_TOKEN', classification: 'credential', paths: ['/spec/credentials/0/template'] }],
    gateEndpoints: [], publicationEndpoints: [],
  } };
  const config: ControllerConfiguration = { apiVersion: 'loopwright.dev/v1alpha1', kind: 'ControllerConfig', spec: {
    task: structuredClone(validated.value), registry: { name: 'operator', digest: hash('') }, profiles: { roles: [{ roleId: 'builder', profileRef: 'builder' }], steps: [{ stepId: 'build', handlerRef: 'package.patch' }] },
    credentials: [{ ref: 'copilot', template: '${PROVIDER_TOKEN}' }], controls: { maxAttempts: 3, drainReserveMs: 120000, repeatFailureLimit: 2, submission: { mode: 'artifact_or_assistant', path: null } },
    publication: { mode: 'disabled' },
  } };
  const input = { configPath: join(taskDirectory, 'task.json'), registryPath: join(operator, 'registry.json'), registrySha256: '', untrustedRoots: [taskDirectory] };
  const environment: Record<string, string | undefined> = { PROVIDER_TOKEN: TOKEN }, lookedUp: string[] = [];
  const save = async () => {
    const bytes = JSON.stringify(registry); input.registrySha256 = hash(bytes).hex;
    (config.spec as { registry: ControllerConfiguration['spec']['registry'] }).registry = { name: registry.metadata.name, digest: hash(bytes) };
    await writeFile(input.registryPath, bytes, { mode: 0o600 }); await writeFile(input.configPath, JSON.stringify(config), { mode: 0o600 });
  };
  await save();
  return { root, operator, taskDirectory, registry, config, input, environment, lookedUp, save,
    load: () => loadConfiguration(input, { environment: name => { lookedUp.push(name); return environment[name]; } }),
    cleanup: () => rm(root, { recursive: true, force: true }) };
}
