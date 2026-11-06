import { types } from 'node:util';
import { validateDocument, digestArtifact } from '@loopwright/core';
import { freeze, id, list, object, snapshot, text } from './boundary.js';
import { refuse } from './errors.js';
import { sameIdentity, validatePolicy } from './policy.js';
import { PREAMBLE_IDENTITY, systemPrompt } from './resources.js';
import type { PiOpenInput } from './types.js';
const typedArray = Object.getPrototypeOf(Uint8Array.prototype) as object;
const intrinsic = (name: string) => Object.getOwnPropertyDescriptor(typedArray, name)!.get!;
function byteView(input: unknown, path: string): Uint8Array {
  if (!ArrayBuffer.isView(input) || types.isProxy(input)) refuse('INPUT_INVALID', path);
  const prototype: unknown = Object.getPrototypeOf(input);
  if (prototype !== Uint8Array.prototype && prototype !== Buffer.prototype) refuse('INPUT_INVALID', path);
  const buffer = intrinsic('buffer').call(input) as ArrayBuffer;
  if (types.isSharedArrayBuffer(buffer)) refuse('INPUT_INVALID', path);
  const length = intrinsic('byteLength').call(input) as number;
  if (length > 8388608) refuse('OUTPUT_LIMIT', path);
  return new Uint8Array(buffer, intrinsic('byteOffset').call(input) as number, length);
}
export function prepareInput(input: unknown): PiOpenInput {
  const top = object(input, ['version', 'lock', 'roleId', 'stepId', 'sessionId', 'policy', 'candidate', 'resources', 'restore']);
  const candidate = object(top.candidate, ['manifest', 'baseRevision', 'sourceRevision', 'artifacts'], '/candidate');
  const artifacts = list(candidate.artifacts, 256, '/candidate/artifacts').map((item, index) => object(item, ['name', 'bytes'], '/candidate/artifacts/' + index));
  const resources = list(top.resources, 128, '/resources').map((item, index) => object(item, ['id', 'kind', 'ref', 'bytes'], '/resources/' + index));
  const restore = top.restore === null ? null : object(top.restore, ['checkpointId', 'workspace', 'session'], '/restore');
  const workspace = restore ? object(restore.workspace, ['ref', 'bytes'], '/restore/workspace') : null;
  const session = restore ? object(restore.session, ['ref', 'bytes'], '/restore/session') : null;
  const slots = [...artifacts, ...resources, ...(workspace && session ? [workspace, session] : [])];
  const views = slots.map((item, index) => byteView(item.bytes, '/artifacts/' + index));
  if (views.reduce((sum, view) => sum + view.byteLength, 0) > 16777216) refuse('OUTPUT_LIMIT', '/artifacts');
  const metadata = snapshot({ version: top.version, lock: top.lock, roleId: top.roleId, stepId: top.stepId, sessionId: top.sessionId, policy: top.policy,
    candidate: { manifest: candidate.manifest, baseRevision: candidate.baseRevision, sourceRevision: candidate.sourceRevision, artifacts: artifacts.map(item => ({ name: item.name })) },
    resources: resources.map(item => ({ id: item.id, kind: item.kind, ref: item.ref })), restore: restore ? { checkpointId: restore.checkpointId, workspace: { ref: workspace!.ref }, session: { ref: session!.ref } } : null });
  const owned = metadata as unknown as PiOpenInput;
  if (owned.version !== 1) refuse('INPUT_INVALID', '/version');
  const checkedLock = validateDocument(owned.lock, 'TaskLock'); if (!checkedLock.ok) refuse('INPUT_INVALID', '/lock');
  const lock = checkedLock.value, contract = lock.spec.contract.spec;
  id(owned.roleId, '/roleId'); id(owned.stepId, '/stepId'); id(owned.sessionId, '/sessionId');
  const role = contract.roles.find(item => item.id === owned.roleId), step = contract.steps.find(item => item.id === owned.stepId);
  if (!role || !step || step.kind !== 'agent' || step.roleId !== role.id || role.adapter !== 'pi') refuse('BINDING_MISMATCH', '/roleId');
  if (contract.budgets.enforcement.tokens === 'hard_admission') refuse('CAPABILITY_UNSUPPORTED', '/lock/spec/contract/spec/budgets/enforcement/tokens');
  const policy = validatePolicy(owned.policy as unknown as import('./boundary.js').Json);
  if (policy.selection.provider !== role.provider || policy.selection.model !== role.model || policy.selection.thinking !== role.thinking) refuse('BINDING_MISMATCH', '/policy/selection');
  if (policy.tools.some(name => !role.tools.includes(name))) refuse('TOOL_DENIED', '/policy/tools');
  const manifest = validateDocument(owned.candidate.manifest, 'ArtifactManifest'); if (!manifest.ok) refuse('INPUT_INVALID', '/candidate/manifest');
  if (owned.candidate.baseRevision !== contract.target.baseRevision || owned.candidate.sourceRevision !== contract.target.sourceRevision) refuse('BINDING_MISMATCH', '/candidate');
  if (owned.candidate.artifacts.length !== manifest.value.spec.entries.length || artifacts.length > policy.limits.candidateEntries) refuse('RESOURCE_MISMATCH', '/candidate/artifacts');
  let index = 0;
  for (const item of [...owned.candidate.artifacts, ...owned.resources, ...(owned.restore ? [owned.restore.workspace, owned.restore.session] : [])]) {
    const view = views[index++]!, copy = new Uint8Array(view.byteLength); copy.set(view);
    (item as { bytes: Uint8Array }).bytes = copy;
  }
  const expected = [PREAMBLE_IDENTITY, ...contract.trustedContext.resources];
  if (!sameIdentity(policy.resources, expected) || owned.resources.length !== contract.trustedContext.resources.length) refuse('RESOURCE_MISMATCH', '/resources');
  const validateBytes = (ref: import('@loopwright/core').ArtifactRef, bytes: Uint8Array, path: string) => {
    const actual = digestArtifact(ref.name, bytes); if (!actual.ok || !sameIdentity(actual.value, ref)) refuse('RESOURCE_MISMATCH', path);
    if (bytes.byteLength > policy.limits.fileBytes) refuse('OUTPUT_LIMIT', path);
  };
  const paths = new Set<string>(), prefixes = new Map<string, string>();
  for (const artifact of owned.candidate.artifacts) {
    text(artifact.name, '/candidate/artifacts/name', 1024);
    const ref = manifest.value.spec.entries.find(entry => entry.name === artifact.name);
    if (!ref || paths.has(artifact.name.toLowerCase())) refuse('RESOURCE_MISMATCH', '/candidate/artifacts'); paths.add(artifact.name.toLowerCase()); validateBytes(ref, artifact.bytes, '/candidate/artifacts');
    let prefix = '';
    for (const segment of artifact.name.split('/')) {
      if (segment.length > 255) refuse('INPUT_INVALID', '/candidate/artifacts/name');
      prefix = prefix ? prefix + '/' + segment : segment; const key = prefix.toLowerCase(), previous = prefixes.get(key);
      if (previous !== undefined && previous !== prefix) refuse('RESOURCE_MISMATCH', '/candidate/artifacts'); prefixes.set(key, prefix);
    }
  }
  owned.resources.forEach((resource, offset) => {
    const admitted = contract.trustedContext.resources[offset]!;
    if (resource.id !== admitted.id || resource.kind !== admitted.kind || resource.ref.name !== admitted.path || !sameIdentity(resource.ref.digest, admitted.digest)) refuse('RESOURCE_MISMATCH', '/resources/' + offset);
    validateBytes(resource.ref, resource.bytes, '/resources/' + offset); try { new TextDecoder('utf-8', { fatal: true }).decode(resource.bytes); } catch { refuse('RESOURCE_MISMATCH', '/resources/' + offset); }
  });
  if (owned.restore) { id(owned.restore.checkpointId, '/restore/checkpointId'); validateBytes(owned.restore.workspace.ref, owned.restore.workspace.bytes, '/restore/workspace'); validateBytes(owned.restore.session.ref, owned.restore.session.bytes, '/restore/session'); }
  const aggregate = views.reduce((sum, view) => sum + view.byteLength, 0);
  if (aggregate > policy.limits.artifactBytes || !owned.restore && aggregate + policy.limits.sessionBytes > policy.limits.artifactBytes) refuse('OUTPUT_LIMIT', '/artifacts');
  if (Buffer.byteLength(systemPrompt(owned)) > policy.context.maxRequestBytes) refuse('CONTEXT_UNSAFE', '/resources');
  return freeze({ ...owned, lock, policy, candidate: { ...owned.candidate, manifest: manifest.value } });
}
