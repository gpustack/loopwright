import { join, resolve } from 'node:path';
import { lstat } from 'node:fs/promises';
import { admitTask, validateDocument } from '@loopwright/core';
import type { LocalRunIdentity } from '@loopwright/state';
import { approvedState, loadConfiguration } from './config.js';
import { compilePlan } from './compile.js';
import { readBoundedFile, canonicalComponents } from './files.js';
import { checkedRef, readArtifact, type ArtifactReader } from './storage.js';
import { parsePrivateJson } from './parser.js';
import { freeze, hash, id, isRecord, list, record, same, text } from './schema.js';
import { labelValue } from './registry.js';
import { ControllerFailure, refuse, type ControllerDiagnostic } from './errors.js';
import { bootIdentity } from './ownership.js';
import type { ControllerPorts, RunDescriptor } from './controller.js';
import type { HostPathProtectionOptions } from './source.js';
import type {
  CompiledPlan,
  ControllerPolicyProfile,
  LoadedConfiguration,
  PersistedHostPolicy,
  RoleModelOverride,
} from './types.js';

export interface RetainedRunInput { readonly runRoot: string; readonly runId: string }

export const CONSERVATIVE_LEGACY_HOST_POLICY: PersistedHostPolicy = freeze({
  policyProfile: 'github',
  allowWorkflowWrites: false,
});

export function parsePersistedHostPolicy(
  raw: unknown,
  path: string,
  phase: ControllerDiagnostic['phase'] = 'recovery',
): PersistedHostPolicy {
  if (!isRecord(raw)) refuse('RECOVERY_REQUIRED', path, phase);
  const fields = record(raw, ['policyProfile', 'allowWorkflowWrites'], path);
  if (
    (fields.policyProfile !== 'local' && fields.policyProfile !== 'github') ||
    typeof fields.allowWorkflowWrites !== 'boolean'
  ) {
    refuse('RECOVERY_REQUIRED', path, phase);
  }
  return freeze({
    policyProfile: fields.policyProfile as ControllerPolicyProfile,
    allowWorkflowWrites: fields.allowWorkflowWrites,
  });
}

export function effectiveRunHostPolicy(descriptor: Pick<RunDescriptor, 'hostPolicy'>): PersistedHostPolicy {
  return descriptor.hostPolicy ?? CONSERVATIVE_LEGACY_HOST_POLICY;
}

export function hostProtectionFromPolicy(policy: PersistedHostPolicy): HostPathProtectionOptions {
  return {
    enforceGitHubWorkflowProtection: policy.policyProfile === 'github',
    allowWorkflowWrites: policy.allowWorkflowWrites,
  };
}

export function validatePortPolicyFields(ports: ControllerPorts, phase: ControllerDiagnostic['phase']): void {
  if (ports.policyProfile !== undefined && ports.policyProfile !== 'local' && ports.policyProfile !== 'github') {
    refuse('CONFIG_SCHEMA', '/policyProfile', phase);
  }
  if (ports.allowWorkflowWrites !== undefined && typeof ports.allowWorkflowWrites !== 'boolean') {
    refuse('CONFIG_SCHEMA', '/allowWorkflowWrites', phase);
  }
}

export function validatePortsAgainstHostPolicy(
  ports: ControllerPorts,
  persisted: PersistedHostPolicy,
  phase: ControllerDiagnostic['phase'] = 'recovery',
): ControllerPorts {
  validatePortPolicyFields(ports, phase);
  if (ports.policyProfile !== undefined && ports.policyProfile !== persisted.policyProfile) {
    refuse('RECOVERY_REQUIRED', '/policyProfile', phase);
  }
  if (ports.allowWorkflowWrites !== undefined && ports.allowWorkflowWrites !== persisted.allowWorkflowWrites) {
    refuse('RECOVERY_REQUIRED', '/allowWorkflowWrites', phase);
  }
  return {
    ...ports,
    policyProfile: persisted.policyProfile,
    allowWorkflowWrites: persisted.allowWorkflowWrites,
  };
}

export function resolveStoreLeaseMs(configuration: LoadedConfiguration, plan: CompiledPlan): number {
  let maxEndpointDurationMs = 0;
  for (const slot of plan.verifierSlots) {
    if (slot.handler.implementation !== 'gate.v1' && slot.handler.implementation !== 'benchmark-gate.v1') continue;
    const ep = configuration.registry.spec.gateEndpoints.find(item => item.id === slot.handler.parameters.endpointRef);
    if (!ep) continue;
    const durationMs = slot.handler.implementation === 'benchmark-gate.v1' ? Math.max(ep.timeoutMs, ep.maxPollMs) : ep.timeoutMs;
    if (durationMs > maxEndpointDurationMs) maxEndpointDurationMs = durationMs;
  }
  return maxEndpointDurationMs > 58000 ? Math.min(3700000, maxEndpointDurationMs + 30000) : 60000;
}

function retainedRoleModelOverrides(raw: unknown): readonly RoleModelOverride[] | undefined {
  if (raw === undefined) return undefined;
  const items = list(raw, '/configuration/roleModelOverrides', Number.MAX_SAFE_INTEGER);
  if (items.length > 8) refuse('RECOVERY_REQUIRED', '/configuration/roleModelOverrides', 'recovery');
  const entries = items.map((item, index) => {
    const path = '/configuration/roleModelOverrides/' + index;
    if (item === null || typeof item !== 'object' || Array.isArray(item)) refuse('RECOVERY_REQUIRED', path, 'recovery');
    const hasThinking = Object.hasOwn(item, 'thinking');
    const fields = record(item, hasThinking ? ['roleId', 'provider', 'model', 'thinking'] : ['roleId', 'provider', 'model'], path);
    const roleId = id(fields.roleId, path + '/roleId');
    const provider = labelValue(fields.provider, path + '/provider');
    const model = labelValue(fields.model, path + '/model');
    const thinking = hasThinking && fields.thinking !== undefined ? labelValue(fields.thinking, path + '/thinking') : undefined;
    return thinking !== undefined ? { roleId, provider, model, thinking } : { roleId, provider, model };
  });
  if (new Set(entries.map(item => item.roleId)).size !== entries.length) refuse('RECOVERY_REQUIRED', '/configuration/roleModelOverrides', 'recovery');
  return entries;
}

/** Read only: never mkdir, claim, discover configuration, inspect Docker or resolve credentials. */
export async function readRetained(input: RetainedRunInput) {
  const root = resolve(text(input.runRoot)), runId = id(input.runId), directory = join(root, runId);
  for (const path of [root, directory, join(directory, 'artifacts')]) {
    await canonicalComponents(path); const info = await lstat(path);
    if (!info.isDirectory() || info.uid !== process.getuid?.() || info.mode & 0o077) refuse('ARTIFACT_INVALID', '', 'recovery');
  }
  const parsedRun = parsePrivateJson(await readBoundedFile(join(directory, 'run.json'), 1048576, true), 1048576);
  const hasHostPolicy = isRecord(parsedRun) && Object.hasOwn(parsedRun, 'hostPolicy') && parsedRun.hostPolicy !== undefined;
  const raw = record(parsedRun, [
    'version',
    'identity',
    'plan',
    'source',
    'sourceWorkspace',
    'configuration',
    'repository',
    ...(hasHostPolicy ? ['hostPolicy' as const] : []),
  ]);
  const identity = record(raw.identity, ['directory', 'storeId', 'lock', 'policy', 'binding']), lock = validateDocument(identity.lock, 'TaskLock');
  if (raw.version !== 1 || !lock.ok || lock.value.spec.runId !== runId || identity.directory !== join(directory, 'state')) refuse('RECOVERY_REQUIRED', '', 'recovery');
  const hasOverrides = raw.configuration !== null && typeof raw.configuration === 'object' && !Array.isArray(raw.configuration) && Object.hasOwn(raw.configuration, 'roleModelOverrides');
  const configuration = record(raw.configuration, hasOverrides ? ['configPath', 'registryPath', 'registrySha256', 'roleModelOverrides'] : ['configPath', 'registryPath', 'registrySha256']);
  text(configuration.configPath); text(configuration.registryPath); if (!/^[a-f0-9]{64}$/.test(text(configuration.registrySha256))) refuse('RECOVERY_REQUIRED', '', 'recovery');
  const roleModelOverrides = hasOverrides ? retainedRoleModelOverrides(configuration.roleModelOverrides) : undefined;
  const parsedHostPolicy = hasHostPolicy ? parsePersistedHostPolicy(raw.hostPolicy, '/hostPolicy', 'recovery') : undefined;
  const descriptor: RunDescriptor = {
    version: 1,
    identity: identity as unknown as LocalRunIdentity,
    plan: checkedRef(raw.plan),
    source: checkedRef(raw.source),
    sourceWorkspace: checkedRef(raw.sourceWorkspace),
    configuration: {
      configPath: text(configuration.configPath),
      registryPath: text(configuration.registryPath),
      registrySha256: text(configuration.registrySha256),
      ...(roleModelOverrides !== undefined ? { roleModelOverrides } : {}),
    },
    repository: text(raw.repository),
    ...(parsedHostPolicy !== undefined ? { hostPolicy: parsedHostPolicy } : {}),
  };
  const hostPolicy = effectiveRunHostPolicy(descriptor);
  const artifacts: ArtifactReader = { read: (ref, maximum) => readArtifact(join(directory, 'artifacts'), ref, maximum) };
  const plan = parsePrivateJson(await artifacts.read(descriptor.plan, 4194304), 4194304) as unknown as CompiledPlan;
  if (plan.version !== 1 || !same(plan.task, lock.value.spec.contract)) refuse('RECOVERY_REQUIRED', '', 'recovery');
  return { directory, descriptor, hostPolicy, plan, lock: lock.value, artifacts };
}

export async function admitRetainedRun(input: {
  readonly runRoot: string;
  readonly runId: string;
  readonly configuration?: LoadedConfiguration;
  readonly repository?: string;
  readonly environment?: (name: string) => string | undefined;
  readonly phase?: ControllerDiagnostic['phase'];
}) {
  const phase = input.phase ?? 'recovery';
  const retained = await readRetained({ runRoot: input.runRoot, runId: input.runId });
  const { directory, descriptor, lock } = retained;
  const envFn = input.environment ?? (name => process.env[name]);
  let effectiveConfig = input.configuration;
  if (!effectiveConfig) {
    const loaded = await loadConfiguration(
      {
        configPath: descriptor.configuration.configPath,
        registryPath: descriptor.configuration.registryPath,
        registrySha256: descriptor.configuration.registrySha256,
        untrustedRoots: [descriptor.repository],
        ...(descriptor.configuration.roleModelOverrides !== undefined ? { roleModelOverrides: descriptor.configuration.roleModelOverrides } : {}),
      },
      { environment: envFn },
    );
    if (!loaded.ok) throw new ControllerFailure(loaded.error);
    effectiveConfig = loaded.value;
  } else {
    const state0 = approvedState(effectiveConfig);
    if (descriptor.configuration.roleModelOverrides !== undefined && state0.input.roleModelOverrides === undefined) {
      const reloaded = await loadConfiguration({ ...state0.input, roleModelOverrides: descriptor.configuration.roleModelOverrides }, { environment: envFn });
      if (!reloaded.ok) throw new ControllerFailure(reloaded.error);
      effectiveConfig = reloaded.value;
    }
  }
  const state = approvedState(effectiveConfig);
  const compiled = await compilePlan(effectiveConfig);
  if (!compiled.ok) throw new ControllerFailure(compiled.error);
  const plan = compiled.value;
  const admitted = admitTask(plan.task, { admissionId: 'admission.' + hash('loopwright.dev/controller/admission/v1\0' + input.runId + '\0' + plan.planDigest.hex).hex.slice(0, 40), runId: input.runId });
  if (!admitted.ok || !same(admitted.value, lock) || !same(plan, retained.plan) || (input.repository !== undefined && descriptor.repository !== resolve(input.repository))
    || !same(descriptor.configuration, { configPath: state.input.configPath, registryPath: state.input.registryPath, registrySha256: state.input.registrySha256, ...(state.input.roleModelOverrides !== undefined ? { roleModelOverrides: state.input.roleModelOverrides } : {}) })) refuse('RECOVERY_REQUIRED', '', phase);
  const adapters = [...new Set(plan.task.spec.roles.map(role => role.adapter))].sort().map(id => ({ id, version: '0.0.0' }));
  const expected = { directory: join(directory, 'state'), storeId: 'store.' + hash('loopwright.dev/controller/store/v1\0' + input.runId).hex.slice(0, 40), lock,
    policy: { version: 1, leaseMs: resolveStoreLeaseMs(effectiveConfig, plan), cost: 'observe_only' }, binding: { coreApiVersion: 'loopwright.dev/v1alpha1', hostVersion: 's04-controller-v1', adapters, resourceVersion: plan.task.spec.trustedContext.revision, clockEpoch: 'boot.' + hash(await bootIdentity()).hex.slice(0, 40) } };
  if (!same(descriptor.identity, expected)) refuse('RECOVERY_REQUIRED', '', phase);
  return { ...retained, effectiveConfig, state, plan };
}
