import { isAbsolute } from 'node:path';
import { types } from 'node:util';
import { LIMITS, OVERLAY_LIMITS, validateDocument, digestArtifact, digestArtifactFromMetadata } from '@loopwright/core';
import { canonical, freeze, id, integer, list, object, snapshot, text, type SnapshotBounds } from './boundary.js';
import { gitBlobOid, resolveCandidateOverlayLimits } from './candidate.js';
import { RAW_AGGREGATE_MAX_BYTES, RAW_ARTIFACT_MAX_BYTES, verifyRegularFileSync } from './cas.js';
import { refuse } from './errors.js';
import { sameIdentity, validateDigest, validatePolicy } from './policy.js';
import { PREAMBLE_IDENTITY, decodePromptResourceUtf8, systemPrompt } from './resources.js';
import type { PiBaselineEntry, PiCandidateArtifactInput, PiCandidateBaseline, PiOpenInput } from './types.js';
const typedArray = Object.getPrototypeOf(Uint8Array.prototype) as object;
const intrinsic = (name: string) => Object.getOwnPropertyDescriptor(typedArray, name)!.get!;
function byteView(input: unknown, path: string): Uint8Array {
  if (!ArrayBuffer.isView(input) || types.isProxy(input)) refuse('INPUT_INVALID', path);
  const prototype: unknown = Object.getPrototypeOf(input);
  if (prototype !== Uint8Array.prototype && prototype !== Buffer.prototype) refuse('INPUT_INVALID', path);
  const buffer = intrinsic('buffer').call(input) as ArrayBuffer;
  if (types.isSharedArrayBuffer(buffer)) refuse('INPUT_INVALID', path);
  const length = intrinsic('byteLength').call(input) as number;
  if (length > RAW_ARTIFACT_MAX_BYTES) refuse('OUTPUT_LIMIT', path);
  return new Uint8Array(buffer, intrinsic('byteOffset').call(input) as number, length);
}

type ParsedCandidateArtifactRaw =
  | { readonly kind: 'raw'; readonly raw: Record<string, unknown> }
  | { readonly kind: 'blob'; readonly raw: Record<string, unknown> };

function parseCandidateArtifactRaw(item: unknown, path: string): ParsedCandidateArtifactRaw {
  if (!item || typeof item !== 'object' || types.isProxy(item)) refuse('INPUT_INVALID', path);
  const proto: unknown = Object.getPrototypeOf(item);
  if (proto !== Object.prototype && proto !== null) refuse('INPUT_INVALID', path);
  const keys = Reflect.ownKeys(item);
  if (keys.some(key => typeof key !== 'string')) refuse('INPUT_INVALID', path);
  const hasBytes = keys.includes('bytes');
  const hasBlobPath = keys.includes('blobPath');
  if (hasBytes && hasBlobPath) refuse('INPUT_INVALID', path);
  if (hasBytes) {
    return { kind: 'raw', raw: object(item, ['name', 'bytes'], path) };
  }
  if (hasBlobPath) {
    return { kind: 'blob', raw: object(item, ['name', 'byteLength', 'digest', 'blobPath'], path) };
  }
  refuse('INPUT_INVALID', path);
}

function validateCandidateBaseline(
  rawBaselineInput: unknown,
  baseTree: import('@loopwright/core').BaseTreeAnchor,
  manifestEntries: readonly import('@loopwright/core').ArtifactRef[],
  manifestDeleted: readonly string[],
  artifacts: readonly PiCandidateArtifactInput[],
  verifiedBlobOids: ReadonlyMap<string, string>,
): PiCandidateBaseline {
  const rawBaseline = object(rawBaselineInput, ['directory', 'entries'], '/candidate/baseline');
  const directory = text(rawBaseline.directory, '/candidate/baseline/directory', 1024);
  if (!isAbsolute(directory) || /[\0\r\n]/.test(directory)) refuse('INPUT_INVALID', '/candidate/baseline/directory');
  const rawEntries = rawBaseline.entries;
  if (!Array.isArray(rawEntries) || types.isProxy(rawEntries) || Object.getPrototypeOf(rawEntries) !== Array.prototype) {
    refuse('INPUT_INVALID', '/candidate/baseline/entries');
  }
  const entryCount = Object.getOwnPropertyDescriptor(rawEntries, 'length')!.value as number;
  if (entryCount > LIMITS.baselineEntries || Reflect.ownKeys(rawEntries).length !== entryCount + 1) {
    refuse('INPUT_INVALID', '/candidate/baseline/entries');
  }
  const oidPattern = baseTree.objectFormat === 'sha1' ? /^[0-9a-f]{40}$/ : /^[0-9a-f]{64}$/;
  const deletedNormSet = new Set(manifestDeleted.map(name => name.normalize('NFC').toLowerCase()));
  const baselineNormSet = new Set<string>();
  const remainingBaselineDirSet = new Set<string>();
  const baselineMap = new Map<string, PiBaselineEntry>();
  const frozenEntries: PiBaselineEntry[] = [];
  let prevName: string | null = null;
  for (let i = 0; i < entryCount; i++) {
    const entryPath = '/candidate/baseline/entries/' + i;
    const descriptor = Object.getOwnPropertyDescriptor(rawEntries, String(i));
    if (!descriptor || !descriptor.enumerable || !('value' in descriptor)) refuse('INPUT_INVALID', entryPath);
    const item = object(descriptor.value, ['name', 'mode', 'oid', 'byteLength'], entryPath);
    if (typeof item.name !== 'string' || !digestArtifact(item.name, new Uint8Array()).ok) {
      refuse('INPUT_INVALID', entryPath + '/name');
    }
    for (const segment of item.name.split('/')) {
      if (segment.toLowerCase() === '.git' || Buffer.byteLength(segment, 'utf8') > 255) {
        refuse('INPUT_INVALID', entryPath + '/name');
      }
    }
    if (prevName !== null && prevName >= item.name) refuse('INPUT_INVALID', entryPath + '/name');
    prevName = item.name;
    const norm = item.name.normalize('NFC').toLowerCase();
    if (baselineNormSet.has(norm)) refuse('INPUT_INVALID', entryPath + '/name');
    baselineNormSet.add(norm);
    if (item.mode !== '100644' && item.mode !== '100755') refuse('INPUT_INVALID', entryPath + '/mode');
    if (typeof item.oid !== 'string' || !oidPattern.test(item.oid)) refuse('INPUT_INVALID', entryPath + '/oid');
    const byteLength = integer(item.byteLength, 0, Number.MAX_SAFE_INTEGER, entryPath + '/byteLength');
    const frozenEntry: PiBaselineEntry = Object.freeze({ name: item.name, mode: item.mode, oid: item.oid, byteLength });
    frozenEntries.push(frozenEntry);
    baselineMap.set(item.name, frozenEntry);
    if (!deletedNormSet.has(norm)) {
      let slash = norm.indexOf('/');
      while (slash !== -1) {
        remainingBaselineDirSet.add(norm.slice(0, slash));
        slash = norm.indexOf('/', slash + 1);
      }
    }
  }
  for (const norm of baselineNormSet) {
    let slash = norm.indexOf('/');
    while (slash !== -1) {
      if (baselineNormSet.has(norm.slice(0, slash))) refuse('INPUT_INVALID', '/candidate/baseline/entries');
      slash = norm.indexOf('/', slash + 1);
    }
  }
  for (const deletedPath of manifestDeleted) {
    if (!baselineMap.has(deletedPath)) refuse('RESOURCE_MISMATCH', '/candidate/manifest/spec/deleted');
  }
  const artifactByName = new Map(artifacts.map(item => [item.name, item]));
  for (const entry of manifestEntries) {
    const baseEntry = baselineMap.get(entry.name);
    if (baseEntry !== undefined) {
      const artifact = artifactByName.get(entry.name);
      if (!artifact) refuse('RESOURCE_MISMATCH', '/candidate/artifacts');
      const oid = 'bytes' in artifact
        ? gitBlobOid(baseTree.objectFormat, artifact.bytes)
        : verifiedBlobOids.get(entry.name);
      if (!oid || oid === baseEntry.oid) {
        refuse('RESOURCE_MISMATCH', '/candidate/artifacts');
      }
    } else {
      const entryNorm = entry.name.normalize('NFC').toLowerCase();
      if (baselineNormSet.has(entryNorm) && !deletedNormSet.has(entryNorm)) {
        refuse('RESOURCE_MISMATCH', '/candidate/artifacts');
      }
      if (remainingBaselineDirSet.has(entryNorm)) {
        refuse('RESOURCE_MISMATCH', '/candidate/artifacts');
      }
      let slash = entryNorm.indexOf('/');
      while (slash !== -1) {
        const prefix = entryNorm.slice(0, slash);
        if (baselineNormSet.has(prefix) && !deletedNormSet.has(prefix)) {
          refuse('RESOURCE_MISMATCH', '/candidate/artifacts');
        }
        slash = entryNorm.indexOf('/', slash + 1);
      }
    }
  }
  return Object.freeze({ directory, entries: Object.freeze(frozenEntries) });
}

export function prepareInput(input: unknown): PiOpenInput {
  const top = object(input, ['version', 'lock', 'roleId', 'stepId', 'sessionId', 'policy', 'candidate', 'resources', 'restore']);
  const hasBaselineKey = top.candidate !== null && typeof top.candidate === 'object' && !types.isProxy(top.candidate) && Object.hasOwn(top.candidate, 'baseline');
  const candidate = object(top.candidate, hasBaselineKey ? ['manifest', 'baseRevision', 'sourceRevision', 'artifacts', 'baseline'] : ['manifest', 'baseRevision', 'sourceRevision', 'artifacts'], '/candidate');
  const parsedArtifacts = list(candidate.artifacts, 4096, '/candidate/artifacts').map((item, index) => parseCandidateArtifactRaw(item, '/candidate/artifacts/' + index));
  const resources = list(top.resources, 128, '/resources').map((item, index) => object(item, ['id', 'kind', 'ref', 'bytes'], '/resources/' + index));
  const restore = top.restore === null ? null : object(top.restore, ['checkpointId', 'workspace', 'session'], '/restore');
  const workspace = restore ? object(restore.workspace, ['ref', 'bytes'], '/restore/workspace') : null;
  const session = restore ? object(restore.session, ['ref', 'bytes'], '/restore/session') : null;

  const rawArtifactViews = new Map<number, Uint8Array>();
  let rawBytesSum = 0;
  parsedArtifacts.forEach((entry, index) => {
    if (entry.kind === 'raw') {
      const view = byteView(entry.raw.bytes, '/artifacts/' + index);
      rawBytesSum += view.byteLength;
      if (rawBytesSum > RAW_AGGREGATE_MAX_BYTES) refuse('OUTPUT_LIMIT', '/artifacts');
      rawArtifactViews.set(index, view);
    }
  });
  const resourceViews = resources.map((item, index) => {
    const view = byteView(item.bytes, '/resources/' + index);
    rawBytesSum += view.byteLength;
    if (rawBytesSum > RAW_AGGREGATE_MAX_BYTES) refuse('OUTPUT_LIMIT', '/artifacts');
    return view;
  });
  const workspaceView = workspace ? byteView(workspace.bytes, '/restore/workspace') : null;
  if (workspaceView) {
    rawBytesSum += workspaceView.byteLength;
    if (rawBytesSum > RAW_AGGREGATE_MAX_BYTES) refuse('OUTPUT_LIMIT', '/artifacts');
  }
  const sessionView = session ? byteView(session.bytes, '/restore/session') : null;
  if (sessionView) {
    rawBytesSum += sessionView.byteLength;
    if (rawBytesSum > RAW_AGGREGATE_MAX_BYTES) refuse('OUTPUT_LIMIT', '/artifacts');
  }

  const baseMeta = snapshot({ version: top.version, lock: top.lock, roleId: top.roleId, stepId: top.stepId, sessionId: top.sessionId, policy: top.policy,
    baseRevision: candidate.baseRevision, sourceRevision: candidate.sourceRevision,
    resources: resources.map(item => ({ id: item.id, kind: item.kind, ref: item.ref })), restore: restore ? { checkpointId: restore.checkpointId, workspace: { ref: workspace!.ref }, session: { ref: session!.ref } } : null }) as Record<string, unknown>;
  if (baseMeta.version !== 1) refuse('INPUT_INVALID', '/version');
  const checkedLock = validateDocument(baseMeta.lock, 'TaskLock'); if (!checkedLock.ok) refuse('INPUT_INVALID', '/lock');
  const lock = checkedLock.value, contract = lock.spec.contract.spec;
  const overlayLimits = resolveCandidateOverlayLimits(contract.budgets.overlay);
  const hasBlobArtifacts = parsedArtifacts.some(entry => entry.kind === 'blob');
  const candidateSnapshotBounds: SnapshotBounds | undefined =
    overlayLimits.maxFiles > OVERLAY_LIMITS.defaultMaxFiles || hasBlobArtifacts
      ? {
          maxArray: Math.max(1024, overlayLimits.maxFiles),
          maxNodes: Math.max(65536, 65536 + overlayLimits.maxFiles * 24),
          maxBytes: Math.max(1048576, overlayLimits.manifestMaxBytes * 2 + parsedArtifacts.length * 1024),
        }
      : undefined;
  const snapshottedManifest = snapshot(candidate.manifest, candidateSnapshotBounds);
  const snapshottedArtifacts = parsedArtifacts.map(entry => snapshot(
    entry.kind === 'raw'
      ? { name: entry.raw.name }
      : {
          name: entry.raw.name,
          byteLength: entry.raw.byteLength,
          digest: entry.raw.digest,
          blobPath: entry.raw.blobPath,
        },
  ));
  const owned = {
    version: baseMeta.version,
    lock: baseMeta.lock,
    roleId: baseMeta.roleId,
    stepId: baseMeta.stepId,
    sessionId: baseMeta.sessionId,
    policy: baseMeta.policy,
    candidate: {
      manifest: snapshottedManifest,
      baseRevision: baseMeta.baseRevision,
      sourceRevision: baseMeta.sourceRevision,
      artifacts: snapshottedArtifacts,
    },
    resources: baseMeta.resources,
    restore: baseMeta.restore,
  } as unknown as PiOpenInput;
  id(owned.roleId, '/roleId'); id(owned.stepId, '/stepId'); id(owned.sessionId, '/sessionId');
  const role = contract.roles.find(item => item.id === owned.roleId), step = contract.steps.find(item => item.id === owned.stepId);
  if (!role || !step || step.kind !== 'agent' || step.roleId !== role.id || role.adapter !== 'pi') refuse('BINDING_MISMATCH', '/roleId');
  if (contract.budgets.enforcement.tokens === 'hard_admission') refuse('CAPABILITY_UNSUPPORTED', '/lock/spec/contract/spec/budgets/enforcement/tokens');
  const policy = validatePolicy(owned.policy as unknown as import('./boundary.js').Json);
  if (policy.selection.provider !== role.provider || policy.selection.model !== role.model || policy.selection.thinking !== role.thinking) refuse('BINDING_MISMATCH', '/policy/selection');
  if (policy.tools.some(name => !role.tools.includes(name))) refuse('TOOL_DENIED', '/policy/tools');
  const manifest = validateDocument(owned.candidate.manifest, 'ArtifactManifest', {
    overlay: { maxFiles: overlayLimits.maxFiles, maxBytes: overlayLimits.maxBytes },
  }); if (!manifest.ok) refuse('INPUT_INVALID', '/candidate/manifest');
  if (owned.candidate.baseRevision !== contract.target.baseRevision || owned.candidate.sourceRevision !== contract.target.sourceRevision) refuse('BINDING_MISMATCH', '/candidate');
  if (owned.candidate.artifacts.length !== manifest.value.spec.entries.length || parsedArtifacts.length > policy.limits.candidateEntries) refuse('RESOURCE_MISMATCH', '/candidate/artifacts');

  for (let i = 0; i < owned.candidate.artifacts.length; i++) {
    const view = rawArtifactViews.get(i);
    if (view) {
      const copy = new Uint8Array(view.byteLength);
      copy.set(view);
      (owned.candidate.artifacts[i] as { bytes: Uint8Array }).bytes = copy;
    }
  }
  owned.resources.forEach((item, index) => {
    const view = resourceViews[index]!;
    const copy = new Uint8Array(view.byteLength);
    copy.set(view);
    (item as { bytes: Uint8Array }).bytes = copy;
  });
  if (owned.restore && workspaceView && sessionView) {
    const wsCopy = new Uint8Array(workspaceView.byteLength);
    wsCopy.set(workspaceView);
    (owned.restore.workspace as { bytes: Uint8Array }).bytes = wsCopy;
    const sessCopy = new Uint8Array(sessionView.byteLength);
    sessCopy.set(sessionView);
    (owned.restore.session as { bytes: Uint8Array }).bytes = sessCopy;
  }

  let admittedResources: readonly (typeof contract.trustedContext.resources)[number][];
  if (role.resourceIds === undefined) {
    const expected = [PREAMBLE_IDENTITY, ...contract.trustedContext.resources];
    if (!sameIdentity(policy.resources, expected) || owned.resources.length !== contract.trustedContext.resources.length) refuse('RESOURCE_MISMATCH', '/resources');
    admittedResources = contract.trustedContext.resources;
  } else {
    const allowedIds = new Set(role.resourceIds);
    const byId = new Map(contract.trustedContext.resources.map(item => [item.id, item] as const));
    if (policy.resources.length !== 1 + allowedIds.size || !sameIdentity(policy.resources[0], PREAMBLE_IDENTITY)) {
      refuse('RESOURCE_MISMATCH', '/resources');
    }
    const seenResourceIds = new Set<string>();
    const resolvedRoleResources: (typeof contract.trustedContext.resources)[number][] = [];
    for (const entry of policy.resources.slice(1)) {
      if (!allowedIds.has(entry.id) || seenResourceIds.has(entry.id)) refuse('RESOURCE_MISMATCH', '/resources');
      const admitted = byId.get(entry.id);
      if (!admitted || !sameIdentity(entry, admitted)) refuse('RESOURCE_MISMATCH', '/resources');
      seenResourceIds.add(entry.id);
      resolvedRoleResources.push(admitted);
    }
    if (owned.resources.length !== resolvedRoleResources.length) refuse('RESOURCE_MISMATCH', '/resources');
    admittedResources = resolvedRoleResources;
  }

  const validateBytes = (ref: import('@loopwright/core').ArtifactRef, bytes: Uint8Array, path: string) => {
    const actual = digestArtifact(ref.name, bytes); if (!actual.ok || !sameIdentity(actual.value, ref)) refuse('RESOURCE_MISMATCH', path);
    if (bytes.byteLength > policy.limits.fileBytes) refuse('OUTPUT_LIMIT', path);
  };

  const manifestByName = new Map(manifest.value.spec.entries.map(entry => [entry.name, entry]));
  const baseTreeFormat = manifest.value.spec.baseTree?.objectFormat;
  const verifiedBlobOids = new Map<string, string>();
  const paths = new Set<string>(), prefixes = new Map<string, string>();
  let candidateLogicalBytes = 0;

  for (const artifact of owned.candidate.artifacts) {
    text(artifact.name, '/candidate/artifacts/name', 1024);
    const ref = manifestByName.get(artifact.name);
    if (!ref || paths.has(artifact.name.toLowerCase())) refuse('RESOURCE_MISMATCH', '/candidate/artifacts');
    paths.add(artifact.name.toLowerCase());

    let prefix = '';
    for (const segment of artifact.name.split('/')) {
      if (segment.length > 255) refuse('INPUT_INVALID', '/candidate/artifacts/name');
      prefix = prefix ? prefix + '/' + segment : segment; const key = prefix.toLowerCase(), previous = prefixes.get(key);
      if (previous !== undefined && previous !== prefix) refuse('RESOURCE_MISMATCH', '/candidate/artifacts'); prefixes.set(key, prefix);
    }

    if ('bytes' in artifact) {
      validateBytes(ref, artifact.bytes, '/candidate/artifacts');
      candidateLogicalBytes += artifact.bytes.byteLength;
    } else {
      const byteLength = integer(artifact.byteLength, 0, Number.MAX_SAFE_INTEGER, '/candidate/artifacts/byteLength');
      validateDigest(artifact.digest, '/candidate/artifacts/digest');
      const blobPath = text(artifact.blobPath, '/candidate/artifacts/blobPath', 4096);
      if (!isAbsolute(blobPath) || /[\0\r\n]/.test(blobPath)) refuse('INPUT_INVALID', '/candidate/artifacts/blobPath');
      if (byteLength > policy.limits.fileBytes) refuse('OUTPUT_LIMIT', '/candidate/artifacts');
      const actualMeta = digestArtifactFromMetadata(artifact.name, { digest: artifact.digest, byteLength });
      if (!actualMeta.ok || !sameIdentity(actualMeta.value, ref)) refuse('RESOURCE_MISMATCH', '/candidate/artifacts');
      const verified = verifyRegularFileSync(blobPath, {
        byteLength,
        sha256Hex: artifact.digest.hex,
        requireReadOnly: false,
        gitObjectFormat: baseTreeFormat,
        structuralCode: 'RESOURCE_MISMATCH',
        contentCode: 'RESOURCE_MISMATCH',
        errorPath: '/candidate/artifacts',
      });
      if (verified.gitOid !== null) {
        verifiedBlobOids.set(artifact.name, verified.gitOid);
      }
      candidateLogicalBytes += byteLength;
    }
  }

  let frozenBaseline: PiCandidateBaseline | undefined;
  if (manifest.value.spec.baseTree === undefined) {
    if (candidate.baseline !== undefined) refuse('INPUT_INVALID', '/candidate/baseline');
  } else {
    const overlayBytes = manifest.value.spec.entries.reduce((sum, entry) => sum + entry.byteLength, 0);
    if (overlayBytes > overlayLimits.maxBytes || Buffer.byteLength(canonical(manifest.value)) > overlayLimits.manifestMaxBytes) {
      refuse('OUTPUT_LIMIT', '/candidate/manifest');
    }
    if (candidate.baseline === undefined) refuse('INPUT_INVALID', '/candidate/baseline');
    frozenBaseline = validateCandidateBaseline(
      candidate.baseline,
      manifest.value.spec.baseTree,
      manifest.value.spec.entries,
      manifest.value.spec.deleted,
      owned.candidate.artifacts,
      verifiedBlobOids,
    );
  }

  owned.resources.forEach((resource, offset) => {
    const admitted = admittedResources[offset]!;
    if (resource.id !== admitted.id || resource.kind !== admitted.kind || resource.ref.name !== admitted.path || !sameIdentity(resource.ref.digest, admitted.digest)) refuse('RESOURCE_MISMATCH', '/resources/' + offset);
    validateBytes(resource.ref, resource.bytes, '/resources/' + offset);
    decodePromptResourceUtf8(resource.bytes, '/resources/' + offset);
  });
  if (owned.restore) { id(owned.restore.checkpointId, '/restore/checkpointId'); validateBytes(owned.restore.workspace.ref, owned.restore.workspace.bytes, '/restore/workspace'); validateBytes(owned.restore.session.ref, owned.restore.session.bytes, '/restore/session'); }
  const resourcesBytes = owned.resources.reduce((sum, resource) => sum + resource.bytes.byteLength, 0);
  const restoreBytes = owned.restore ? owned.restore.workspace.bytes.byteLength + owned.restore.session.bytes.byteLength : 0;
  const aggregate = candidateLogicalBytes + resourcesBytes + restoreBytes;
  if (aggregate > policy.limits.artifactBytes || (!owned.restore && aggregate + policy.limits.sessionBytes > policy.limits.artifactBytes)) refuse('OUTPUT_LIMIT', '/artifacts');
  if (Buffer.byteLength(systemPrompt(owned)) > policy.context.maxRequestBytes) refuse('CONTEXT_UNSAFE', '/resources');
  const frozenCandidate = frozenBaseline
    ? Object.freeze({
        manifest: freeze(manifest.value),
        baseRevision: owned.candidate.baseRevision,
        sourceRevision: owned.candidate.sourceRevision,
        artifacts: freeze(owned.candidate.artifacts),
        baseline: frozenBaseline,
      })
    : freeze({
        manifest: manifest.value,
        baseRevision: owned.candidate.baseRevision,
        sourceRevision: owned.candidate.sourceRevision,
        artifacts: owned.candidate.artifacts,
      });
  return Object.freeze({
    ...owned,
    lock: freeze(lock),
    policy: freeze(policy),
    candidate: frozenCandidate,
    resources: freeze(owned.resources),
    restore: freeze(owned.restore),
  });
}
