import { dirname, extname, isAbsolute, resolve } from 'node:path';
import { realpath } from 'node:fs/promises';
import { digestArtifact, validateDocument } from '@loopwright/core';
import { readBoundedFile, inside } from './files.js';
import { parseDocumentBytes, DOCUMENT_BYTES } from './parser.js';
import { labelValue, validateRegistry } from './registry.js';
import { interpolate } from './interpolation.js';
import { credentialDeclarations, createVault, type CredentialVault } from './credentials.js';
import { result, refuse } from './errors.js';
import { digestValue, freeze, hash, id, integer, list, record, same, text } from './schema.js';
import { CONTROLLER_API_VERSION, type ControllerConfiguration, type LoadedConfiguration, type LoadConfigurationInput, type RegistryResource, type PublicationConfig, type RoleModelOverride, type RoleSelectionOverride } from './types.js';
export interface ApprovedState {
  readonly input: LoadConfigurationInput; readonly vault: CredentialVault;
  readonly resources: readonly { readonly id: string; readonly kind: RegistryResource['kind']; readonly ref: import('@loopwright/core').ArtifactRef; readonly bytes: Uint8Array }[];
}
const approved = new WeakMap<object, ApprovedState>();
export function approvedState(value: LoadedConfiguration): ApprovedState {
  const state = approved.get(value); if (!state) refuse('REGISTRY_UNTRUSTED', '', 'compile'); return state;
}
export function selectRoleResources<T extends { readonly id: string }>(
  all: readonly T[],
  resourceIds: readonly string[] | undefined,
  phase: 'compile' | 'execution',
): readonly T[] {
  if (resourceIds === undefined) return all;
  const seen = new Set<string>();
  const selected: T[] = [];
  for (const resId of resourceIds) {
    if (seen.has(resId)) continue;
    seen.add(resId);
    const found = all.find(item => item.id === resId);
    if (!found) refuse('CONFIG_REFERENCE', '/spec/task/spec/roles', phase);
    selected.push(found);
  }
  return selected;
}
export interface ConfigurationPorts { readonly environment: (name: string) => string | undefined }
function format(path: string): 'json' | 'yaml' {
  const extension = extname(path); if (extension === '.json') return 'json'; if (['.yml', '.yaml'].includes(extension)) return 'yaml'; refuse('CONFIG_SYNTAX');
}
function parseRoleSelectionOverride(raw: unknown, path: string): RoleSelectionOverride {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) refuse('CONFIG_SCHEMA', path);
  const hasThinking = Object.hasOwn(raw, 'thinking');
  const sel = record(raw, hasThinking ? ['provider', 'model', 'thinking'] : ['provider', 'model'], path);
  const provider = labelValue(sel.provider, path + '/provider');
  const model = labelValue(sel.model, path + '/model');
  const thinking = hasThinking && sel.thinking !== undefined ? labelValue(sel.thinking, path + '/thinking') : undefined;
  return thinking !== undefined ? { provider, model, thinking } : { provider, model };
}
function parseRoleModelOverrides(raw: unknown): readonly RoleModelOverride[] | undefined {
  if (raw === undefined) return undefined;
  const items = list(raw, '/roleModelOverrides', Number.MAX_SAFE_INTEGER);
  if (items.length > 8) refuse('CONFIG_LIMIT', '/roleModelOverrides');
  const entries = items.map((item, i) => {
    const path = '/roleModelOverrides/' + i;
    if (item === null || typeof item !== 'object' || Array.isArray(item)) refuse('CONFIG_SCHEMA', path);
    const hasThinking = Object.hasOwn(item, 'thinking');
    const fields = record(item, hasThinking ? ['roleId', 'provider', 'model', 'thinking'] : ['roleId', 'provider', 'model'], path);
    const roleId = id(fields.roleId, path + '/roleId');
    const sel = parseRoleSelectionOverride(
      hasThinking ? { provider: fields.provider, model: fields.model, thinking: fields.thinking } : { provider: fields.provider, model: fields.model },
      path,
    );
    return { roleId, ...sel };
  });
  if (new Set(entries.map(item => item.roleId)).size !== entries.length) refuse('CONFIG_REFERENCE', '/roleModelOverrides');
  if (entries.length === 0) return undefined;
  return entries;
}
function validateHeadBranchPrefix(rawPrefix: unknown): string {
  const hbp = text(rawPrefix, '/spec/publication/headBranchPrefix', 64);
  if (hbp.length < 1 || hbp.startsWith('/') || hbp.includes('//') || hbp.includes('..')) {
    refuse('CONFIG_SCHEMA', '/spec/publication/headBranchPrefix');
  }
  const trimmed = hbp.endsWith('/') ? hbp.slice(0, -1) : hbp;
  if (trimmed.length === 0 || !/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(trimmed)) {
    refuse('CONFIG_SCHEMA', '/spec/publication/headBranchPrefix');
  }
  for (const segment of trimmed.split('/')) {
    if (
      segment.length === 0
      || segment === '.'
      || segment === '..'
      || segment.startsWith('.')
      || segment.endsWith('.lock')
      || !/^[A-Za-z0-9._-]+$/.test(segment)
    ) {
      refuse('CONFIG_SCHEMA', '/spec/publication/headBranchPrefix');
    }
  }
  return hbp;
}
function publicationBlock(raw: unknown): PublicationConfig {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) refuse('CONFIG_SCHEMA', '/spec/publication');
  const mode = (raw as Record<string, unknown>).mode;
  if (mode === 'disabled') { record(raw, ['mode'], '/spec/publication'); return { mode: 'disabled' }; }
  if (mode !== 'pull_request') refuse('CONFIG_SCHEMA', '/spec/publication/mode');
  const value = record(raw, ['mode', 'endpointRef', 'targetBranch', 'headBranchPrefix', 'titleTemplate'], '/spec/publication');
  id(value.endpointRef, '/spec/publication/endpointRef');
  if (!/^[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$/.test(text(value.targetBranch, '/spec/publication/targetBranch', 128))) refuse('CONFIG_SCHEMA', '/spec/publication/targetBranch');
  const headBranchPrefix = validateHeadBranchPrefix(value.headBranchPrefix);
  text(value.titleTemplate, '/spec/publication/titleTemplate', 256);
  return { mode: 'pull_request', endpointRef: value.endpointRef as string, targetBranch: value.targetBranch as string, headBranchPrefix, titleTemplate: value.titleTemplate as string };
}
function authoring(raw: unknown): { top: Record<string, unknown>; spec: Record<string, unknown> } {
  const top = record(raw, ['apiVersion', 'kind', 'spec']);
  if (top.apiVersion !== CONTROLLER_API_VERSION || top.kind !== 'ControllerConfig') refuse('CONFIG_SCHEMA');
  const spec = record(top.spec, ['task', 'registry', 'profiles', 'credentials', 'controls', ...(Object.hasOwn(top.spec as object, 'publication') ? ['publication' as const] : [])], '/spec');
  const binding = record(spec.registry, ['name', 'digest'], '/spec/registry'); id(binding.name, '/spec/registry/name'); digestValue(binding.digest);
  const profiles = record(spec.profiles, ['roles', 'steps'], '/spec/profiles');
  const normalizedRoles = list(profiles.roles, '/spec/profiles/roles', 16).map((item, i) => {
    const path = '/spec/profiles/roles/' + i;
    if (item === null || typeof item !== 'object' || Array.isArray(item)) refuse('CONFIG_SCHEMA', path);
    const hasSelection = Object.hasOwn(item, 'selection');
    const fields = record(item, hasSelection ? ['roleId', 'profileRef', 'selection'] : ['roleId', 'profileRef'], path);
    const roleId = id(fields.roleId, path + '/roleId'), profileRef = id(fields.profileRef, path + '/profileRef');
    const selection = hasSelection && fields.selection !== undefined ? parseRoleSelectionOverride(fields.selection, path + '/selection') : undefined;
    return selection !== undefined ? { roleId, profileRef, selection } : { roleId, profileRef };
  });
  if (new Set(normalizedRoles.map(item => item.roleId)).size !== normalizedRoles.length) refuse('CONFIG_REFERENCE', '/spec/profiles/roles');
  const selectedSteps = list(profiles.steps, '/spec/profiles/steps', 16).map((item, i) => {
    const fields = record(item, ['stepId', 'handlerRef'], '/spec/profiles/steps/' + i);
    id(fields.stepId); id(fields.handlerRef); return fields.stepId;
  });
  if (new Set(selectedSteps).size !== selectedSteps.length) refuse('CONFIG_REFERENCE', '/spec/profiles/steps');
  spec.profiles = { roles: normalizedRoles, steps: profiles.steps };
  const controls = record(spec.controls, ['drainReserveMs', 'maxAttempts', 'repeatFailureLimit', 'submission'], '/spec/controls');
  integer(controls.drainReserveMs, 5000, 600000, '/spec/controls/drainReserveMs'); integer(controls.maxAttempts, 1, 64, '/spec/controls/maxAttempts'); integer(controls.repeatFailureLimit, 2, 2, '/spec/controls/repeatFailureLimit');
  const submission = record(controls.submission, ['mode', 'path'], '/spec/controls/submission');
  if (submission.mode !== 'artifact_or_assistant' || submission.path !== null && !digestArtifact(text(submission.path), new Uint8Array()).ok) refuse('CONFIG_SCHEMA', '/spec/controls/submission');
  spec.publication = publicationBlock(spec.publication === undefined ? { mode: 'disabled' } : spec.publication);
  return { top, spec };
}
/** Internal ports only select the launching environment; public callers cannot inject loaders or transports. */
export function loadConfiguration(unowned: LoadConfigurationInput, ports: ConfigurationPorts) {
  return result(async () => {
    const hasOverrides = unowned !== null && typeof unowned === 'object' && Object.hasOwn(unowned, 'roleModelOverrides');
    const fields = record(unowned, hasOverrides ? ['configPath', 'registryPath', 'registrySha256', 'untrustedRoots', 'roleModelOverrides'] : ['configPath', 'registryPath', 'registrySha256', 'untrustedRoots']);
    const roleModelOverrides = parseRoleModelOverrides(fields.roleModelOverrides);
    const configPath = resolve(text(fields.configPath)), registryPath = text(fields.registryPath), registrySha256 = text(fields.registrySha256);
    if (!isAbsolute(registryPath) || !/^[0-9a-f]{64}$/.test(registrySha256)) refuse('REGISTRY_UNTRUSTED', '/registry');
    const roots = [resolve(process.cwd()), dirname(configPath), ...list(fields.untrustedRoots).map(root => resolve(text(root)))];
    for (const root of [...roots]) { try { roots.push(await realpath(root)); } catch { /* Missing future writable roots remain excluded by their absolute declared path. */ } }
    if (roots.some(root => inside(registryPath, root))) refuse('REGISTRY_UNTRUSTED', '/registry');
    const registryBytes = await readBoundedFile(registryPath, DOCUMENT_BYTES, true), registryDigest = hash(registryBytes);
    if (registryDigest.hex !== registrySha256) refuse('REGISTRY_UNTRUSTED', '/registry');
    const registry = validateRegistry(parseDocumentBytes(registryBytes, format(registryPath)));
    const source = await readBoundedFile(configPath, DOCUMENT_BYTES, false), raw = parseDocumentBytes(source, format(configPath));
    const shape = authoring(raw), registryBinding = shape.spec.registry;
    if (!same(registryBinding, { name: registry.metadata.name, digest: registryDigest })) refuse('CONFIG_REFERENCE', '/spec/registry');
    const declarations = credentialDeclarations(shape.spec.credentials, registry);
    const environment = new Map<string, string | undefined>();
    const expanded = interpolate(raw, registry, name => { if (!environment.has(name)) environment.set(name, ports.environment(name)); return environment.get(name); });
    const checked = authoring(expanded), vault = createVault(checked.spec.credentials, registry);
    checked.spec.credentials = declarations;
    const safe = { ...checked.top, spec: checked.spec };
    vault.assertClean(safe);
    const validated = validateDocument(checked.spec.task, 'TaskContract');
    if (!validated.ok) refuse(validated.errors.some(error => error.code.includes('GRAPH') || error.code.includes('REFERENCE')) ? 'CONFIG_REFERENCE' : 'CONFIG_SCHEMA', '/spec/task');
    let finalTask = validated.value;
    const profileRoles = (checked.spec.profiles as { readonly roles: readonly { readonly roleId: string; readonly profileRef: string; readonly selection?: RoleSelectionOverride }[] }).roles;
    const knownRoleIds = new Set(finalTask.spec.roles.map(role => role.id));
    for (const item of profileRoles) {
      if (item.selection !== undefined && !knownRoleIds.has(item.roleId)) refuse('CONFIG_REFERENCE', '/spec/profiles/roles');
    }
    if (roleModelOverrides !== undefined) {
      for (const item of roleModelOverrides) {
        if (!knownRoleIds.has(item.roleId)) refuse('CONFIG_REFERENCE', '/roleModelOverrides');
      }
    }
    if (profileRoles.some(item => item.selection !== undefined) || (roleModelOverrides !== undefined && roleModelOverrides.length > 0)) {
      const updatedRoles = finalTask.spec.roles.map(role => {
        let provider = role.provider, model = role.model, thinking = role.thinking;
        const profSel = profileRoles.find(item => item.roleId === role.id)?.selection;
        if (profSel !== undefined) {
          provider = profSel.provider;
          model = profSel.model;
          if (profSel.thinking !== undefined) thinking = profSel.thinking;
        }
        const cliSel = roleModelOverrides?.find(item => item.roleId === role.id);
        if (cliSel !== undefined) {
          provider = cliSel.provider;
          model = cliSel.model;
          if (cliSel.thinking !== undefined) thinking = cliSel.thinking;
        }
        return { ...role, provider, model, thinking };
      });
      const revalidated = validateDocument(
        { ...finalTask, spec: { ...finalTask.spec, roles: updatedRoles } },
        'TaskContract',
        finalTask.spec.budgets.overlay ? { overlay: finalTask.spec.budgets.overlay } : undefined,
      );
      if (!revalidated.ok) refuse(revalidated.errors.some(error => error.code.includes('GRAPH') || error.code.includes('REFERENCE')) ? 'CONFIG_REFERENCE' : 'CONFIG_SCHEMA', '/spec/task');
      finalTask = revalidated.value;
    }
    checked.spec.task = finalTask;
    const configuration = safe as unknown as ControllerConfiguration;
    if (configuration.spec.controls.drainReserveMs >= finalTask.spec.budgets.wallTimeMs) refuse('CONFIG_SCHEMA', '/spec/controls/drainReserveMs');
    const resources = []; let resourceBytes = 0;
    for (const requested of finalTask.spec.trustedContext.resources) {
      const resource = registry.spec.resources.find(item => item.id === requested.id);
      const requestedIdentity = { id: requested.id, kind: requested.kind, path: requested.path, digest: requested.digest };
      if (!resource || !same(resource, requestedIdentity)) refuse('CONFIG_REFERENCE', '/spec/task/spec/trustedContext/resources');
      const bytes = await readBoundedFile(resolve(dirname(registryPath), resource.path), 4194304, true); resourceBytes += bytes.byteLength;
      if (resourceBytes > 4194304 || hash(bytes).hex !== resource.digest.hex) refuse(resourceBytes > 4194304 ? 'CONFIG_LIMIT' : 'CONFIG_REFERENCE', '/spec/task/spec/trustedContext/resources');
      vault.assertClean(bytes);
      const ref = digestArtifact(resource.path, bytes); if (!ref.ok) refuse('CONFIG_REFERENCE', '/spec/task/spec/trustedContext/resources');
      resources.push({ id: resource.id, kind: resource.kind, ref: ref.value, bytes: new Uint8Array(bytes) });
    }
    const loaded: LoadedConfiguration = freeze({ version: 1, configuration, registry, sourceDigest: hash(source), registryDigest });
    vault.assertClean(loaded);
    approved.set(loaded, { input: freeze({ configPath, registryPath, registrySha256, untrustedRoots: roots, ...(roleModelOverrides !== undefined ? { roleModelOverrides } : {}) }), vault, resources });
    return loaded;
  });
}
export function loadTrustedConfiguration(input: LoadConfigurationInput) { return loadConfiguration(input, { environment: name => process.env[name] }); }
