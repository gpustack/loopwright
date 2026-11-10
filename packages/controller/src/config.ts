import { dirname, extname, isAbsolute, resolve } from 'node:path';
import { realpath } from 'node:fs/promises';
import { digestArtifact, validateDocument } from '@loopwright/core';
import { readBoundedFile, inside } from './files.js';
import { parseDocumentBytes, DOCUMENT_BYTES } from './parser.js';
import { validateRegistry } from './registry.js';
import { interpolate } from './interpolation.js';
import { credentialDeclarations, createVault, type CredentialVault } from './credentials.js';
import { result, refuse } from './errors.js';
import { digestValue, freeze, hash, id, integer, list, record, same, text } from './schema.js';
import { CONTROLLER_API_VERSION, type ControllerConfiguration, type LoadedConfiguration, type LoadConfigurationInput, type RegistryResource, type PublicationConfig } from './types.js';
interface ApprovedState {
  readonly input: LoadConfigurationInput; readonly vault: CredentialVault;
  readonly resources: readonly { readonly id: string; readonly kind: RegistryResource['kind']; readonly ref: import('@loopwright/core').ArtifactRef; readonly bytes: Uint8Array }[];
}
const approved = new WeakMap<object, ApprovedState>();
export function approvedState(value: LoadedConfiguration): ApprovedState {
  const state = approved.get(value); if (!state) refuse('REGISTRY_UNTRUSTED', '', 'compile'); return state;
}
export interface ConfigurationPorts { readonly environment: (name: string) => string | undefined }
function format(path: string): 'json' | 'yaml' {
  const extension = extname(path); if (extension === '.json') return 'json'; if (['.yml', '.yaml'].includes(extension)) return 'yaml'; refuse('CONFIG_SYNTAX');
}
function publicationBlock(raw: unknown): PublicationConfig {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) refuse('CONFIG_SCHEMA', '/spec/publication');
  const mode = (raw as Record<string, unknown>).mode;
  if (mode === 'disabled') { record(raw, ['mode'], '/spec/publication'); return { mode: 'disabled' }; }
  if (mode !== 'pull_request') refuse('CONFIG_SCHEMA', '/spec/publication/mode');
  const value = record(raw, ['mode', 'endpointRef', 'targetBranch', 'headBranchPrefix', 'titleTemplate'], '/spec/publication');
  id(value.endpointRef, '/spec/publication/endpointRef');
  if (!/^[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$/.test(text(value.targetBranch, '/spec/publication/targetBranch', 128))) refuse('CONFIG_SCHEMA', '/spec/publication/targetBranch');
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,62}$/.test(text(value.headBranchPrefix, '/spec/publication/headBranchPrefix', 64).replace(/\/$/, '')) || /\/\//.test(value.headBranchPrefix as string)) refuse('CONFIG_SCHEMA', '/spec/publication/headBranchPrefix');
  text(value.titleTemplate, '/spec/publication/titleTemplate', 256);
  return { mode: 'pull_request', endpointRef: value.endpointRef as string, targetBranch: value.targetBranch as string, headBranchPrefix: value.headBranchPrefix as string, titleTemplate: value.titleTemplate as string };
}
function authoring(raw: unknown): { top: Record<string, unknown>; spec: Record<string, unknown> } {
  const top = record(raw, ['apiVersion', 'kind', 'metadata', 'spec']);
  if (top.apiVersion !== CONTROLLER_API_VERSION || top.kind !== 'ControllerConfig') refuse('CONFIG_SCHEMA');
  id(record(top.metadata, ['id'], '/metadata').id, '/metadata/id');
  const spec = record(top.spec, ['task', 'registry', 'profiles', 'credentials', 'controls', ...(Object.hasOwn(top.spec as object, 'publication') ? ['publication' as const] : [])], '/spec');
  const binding = record(spec.registry, ['id', 'digest'], '/spec/registry'); id(binding.id); digestValue(binding.digest);
  const profiles = record(spec.profiles, ['roles', 'steps'], '/spec/profiles');
  for (const [kind, identity, reference] of [['roles', 'roleId', 'profileRef'], ['steps', 'stepId', 'handlerRef']] as const) {
    const selected = list(profiles[kind], '/spec/profiles/' + kind, 16).map((item, i) => { const fields = record(item, [identity, reference], '/spec/profiles/' + kind + '/' + i); id(fields[identity]); id(fields[reference]); return fields[identity]; });
    if (new Set(selected).size !== selected.length) refuse('CONFIG_REFERENCE', '/spec/profiles/' + kind);
  }
  const controls = record(spec.controls, ['drainReserveMs', 'maxAttempts', 'repeatFailureLimit', 'submission'], '/spec/controls');
  integer(controls.drainReserveMs, 120000, 300000, '/spec/controls/drainReserveMs'); integer(controls.maxAttempts, 1, 16, '/spec/controls/maxAttempts'); integer(controls.repeatFailureLimit, 2, 2, '/spec/controls/repeatFailureLimit');
  const submission = record(controls.submission, ['mode', 'path'], '/spec/controls/submission');
  if (submission.mode !== 'artifact_or_assistant' || submission.path !== null && !digestArtifact(text(submission.path), new Uint8Array()).ok) refuse('CONFIG_SCHEMA', '/spec/controls/submission');
  spec.publication = publicationBlock(spec.publication === undefined ? { mode: 'disabled' } : spec.publication);
  return { top, spec };
}
/** Internal ports only select the launching environment; public callers cannot inject loaders or transports. */
export function loadConfiguration(unowned: LoadConfigurationInput, ports: ConfigurationPorts) {
  return result(async () => {
    const fields = record(unowned, ['configPath', 'registryPath', 'registrySha256', 'untrustedRoots']);
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
    if (!same(registryBinding, { id: registry.metadata.id, digest: registryDigest })) refuse('CONFIG_REFERENCE', '/spec/registry');
    const declarations = credentialDeclarations(shape.spec.credentials, registry);
    const environment = new Map<string, string | undefined>();
    const expanded = interpolate(raw, registry, name => { if (!environment.has(name)) environment.set(name, ports.environment(name)); return environment.get(name); });
    const checked = authoring(expanded), vault = createVault(checked.spec.credentials, registry);
    checked.spec.credentials = declarations;
    const safe = { ...checked.top, spec: checked.spec };
    vault.assertClean(safe);
    const validated = validateDocument(checked.spec.task, 'TaskContract');
    if (!validated.ok) refuse(validated.errors.some(error => error.code.includes('GRAPH') || error.code.includes('REFERENCE')) ? 'CONFIG_REFERENCE' : 'CONFIG_SCHEMA', '/spec/task');
    checked.spec.task = validated.value;
    const configuration = safe as unknown as ControllerConfiguration;
    if (configuration.spec.controls.drainReserveMs >= validated.value.spec.budgets.wallTimeMs) refuse('CONFIG_SCHEMA', '/spec/controls/drainReserveMs');
    const resources = []; let resourceBytes = 0;
    for (const requested of validated.value.spec.trustedContext.resources) {
      const resource = registry.spec.resources.find(item => item.id === requested.id);
      if (!resource || !same(resource, requested)) refuse('CONFIG_REFERENCE', '/spec/task/spec/trustedContext/resources');
      const bytes = await readBoundedFile(resolve(dirname(registryPath), resource.path), 1048576, true); resourceBytes += bytes.byteLength;
      if (resourceBytes > 1048576 || hash(bytes).hex !== resource.digest.hex) refuse(resourceBytes > 1048576 ? 'CONFIG_LIMIT' : 'CONFIG_REFERENCE', '/spec/task/spec/trustedContext/resources');
      vault.assertClean(bytes);
      const ref = digestArtifact(resource.path, bytes); if (!ref.ok) refuse('CONFIG_REFERENCE', '/spec/task/spec/trustedContext/resources');
      resources.push({ id: resource.id, kind: resource.kind, ref: ref.value, bytes: new Uint8Array(bytes) });
    }
    const loaded: LoadedConfiguration = freeze({ version: 1, configuration, registry, sourceDigest: hash(source), registryDigest });
    vault.assertClean(loaded);
    approved.set(loaded, { input: freeze({ configPath, registryPath, registrySha256, untrustedRoots: roots }), vault, resources });
    return loaded;
  });
}
export function loadTrustedConfiguration(input: LoadConfigurationInput) { return loadConfiguration(input, { environment: name => process.env[name] }); }
