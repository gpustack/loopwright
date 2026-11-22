import { execFile, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { constants, existsSync } from 'node:fs';
import { lstat, open, readlink, realpath } from 'node:fs/promises';
import { extname, isAbsolute, join, posix, relative, resolve, sep } from 'node:path';
import { promisify } from 'node:util';
import { LIMITS } from '@loopwright/core';
import { assertDigestLockfileVerified } from './digests.js';
import { collectControlRootSiblingPaths, collectGitHubSiblingPaths } from './sandbox.js';
import {
  collectManifestControlPlanePaths,
  effectiveProtectedPaths,
  headBranchPrefixesCollide,
  IDENTIFIER_PATTERN,
  isGitHubTriggerDeclared,
  normalizeRelativePath,
  parseTaskpackDocument,
  pathCoveredBy,
  pathCoveredByCaseInsensitive,
  validateRfc6901JsonPointer,
  validateTaskpackV2Manifest,
  writableOverlapsMandatoryProtected,
  type Json,
  type ManifestControlPlanePathsSummary,
} from './schema.js';
import { SecretScrubber } from './scrubber.js';
import {
  authorizeRepositoryActor,
  validateCommentGuidance,
} from './taskpack.js';
import {
  DEFAULT_COMMENT_PREFIXES,
  DEFAULT_TASKPACK_SUITE_PATH,
  GITHUB_PROTECTED_AUTOMATION_PATHS,
  LOCAL_PROTECTED_AUTOMATION_PATHS,
  MAX_SUITE_DOMAINS,
  MAX_SUITE_STAGE_READINESS_PROBES,
  MAX_SUITE_STAGE_VERSION_BLOB_BYTES,
  MAX_SUITE_STAGES,
  REPOSITORY_FULL_NAME_PATTERN,
  SUITE_STAGE_READINESS_PROBE_KINDS,
  TASKPACK_COMMENT_COMMANDS,
  TASKPACK_MANIFEST_API_VERSION,
  TASKPACK_MANIFEST_BYTES,
  TASKPACK_SUITE_MANIFEST_BYTES,
  TaskpackError,
  type ExecutionHostPolicy,
  type LoadedTaskpackSuite,
  type LoadedTaskpackSuiteDomain,
  type ParsedSuiteCommentCommand,
  type PolicyProfile,
  type SuiteDisposition,
  type SuiteDomainResolution,
  type SuiteMatrixCell,
  type SuiteResolutionResult,
  type SuiteStageProbeEvaluation,
  type SuiteStageReadinessProbe,
  type SuiteStageReadinessProbeKind,
  type SuiteVersionFromSelector,
  type TargetMatrixCell,
  type TaskpackCommentCommand,
  type TaskpackManifest,
  type TaskpackSuiteDomainDeclaration,
  type TaskpackSuiteDomainMatrix,
  type TaskpackSuiteManifest,
  type TaskpackSuiteStageDeclaration,
} from './types.js';
import {
  buildCleanGitEnv,
  COMMIT_SHA_PATTERN,
  discoverTaskpackUpstreamsV2,
  extractBaselineVersionsFromDocument,
  extractJsonVersionPath,
  fetchBoundedText,
  findOpenManagedPullRequest,
  isPlainRecord,
  isPrereleaseVersionTag,
  MEMORY_PULL_REQUEST_BRANCH_PREFIX,
  resolveGitCommitSha,
  resolveGitExecutable,
  validateGitRemoteSource,
  type ManagedPullRequestInfo,
  type UpstreamHeadersResolver,
  type UpstreamTokenResolver,
} from './upstreams.js';

const execFileAsync = promisify(execFile);

const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
const MAX_STRING = 8_192;
const MAX_SCHEDULE_KEYS = 32;
const MAX_MATRIX_ENTRIES = 16;
const SAFE_GIT_REF_PATTERN = /^[A-Za-z0-9_./@^~{}-]{1,256}$/;
const STRICT_SEMVER_CORE_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

function suiteInvalid(message: string, path: string): never {
  throw new TaskpackError('TASKPACK_MANIFEST_INVALID', message, path);
}

function isObjectRecord(value: unknown): value is Record<string, Json> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto: unknown = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function requireSuiteObject(value: unknown, path: string, fields: readonly string[]): Record<string, Json> {
  if (!isObjectRecord(value)) suiteInvalid('expected an object', path);
  for (const key of Object.keys(value)) {
    if (FORBIDDEN_KEYS.has(key) || !fields.includes(key)) {
      suiteInvalid(`unknown field "${key}"`, path);
    }
  }
  return value;
}

function requireSuiteString(value: unknown, path: string, min: number, max: number): string {
  if (typeof value !== 'string' || value.length < min || value.length > max) {
    suiteInvalid(`expected a string of ${min}..${max} characters`, path);
  }
  if (/[\0\r\n]/.test(value)) suiteInvalid('string contains forbidden control characters', path);
  return value;
}

function requireSuiteBoolean(value: unknown, path: string): boolean {
  if (typeof value !== 'boolean') suiteInvalid('expected a boolean', path);
  return value;
}

function requireSuiteIdentifier(value: unknown, path: string): string {
  const text = requireSuiteString(value, path, 1, 64);
  if (!IDENTIFIER_PATTERN.test(text)) suiteInvalid('expected a lowercase identifier', path);
  return text;
}

function requireSuiteLabel(value: unknown, path: string): string {
  const text = requireSuiteString(value, path, 1, 128);
  if (/[\s\p{C}]/u.test(text)) suiteInvalid('expected a 1..128 character non-whitespace label', path);
  return text;
}

function requireUniqueStringList(value: unknown, path: string, min: number, max: number, maxItemLen = MAX_STRING): readonly string[] {
  if (!Array.isArray(value) || value.length < min || value.length > max) {
    suiteInvalid(`expected an array of ${min}..${max} items`, path);
  }
  const seen = new Set<string>();
  return Object.freeze(value.map((item, idx) => {
    const text = requireSuiteString(item, `${path}/${idx}`, 1, maxItemLen);
    if (seen.has(text)) suiteInvalid(`duplicate entry "${text}"`, `${path}/${idx}`);
    seen.add(text);
    return text;
  }));
}

function deriveControlRoot(relativeManifestPath: string | undefined): string {
  if (relativeManifestPath === undefined) return '.loopwright';
  const dir = posix.dirname(relativeManifestPath);
  return dir === '.' || dir === '' ? '.loopwright' : dir;
}

function validateSuiteHttpSourceUrl(source: string, path: string, allowLoopbackHttp = false): void {
  if (/[\s]/.test(source)) suiteInvalid('http-json source must not contain whitespace', path);
  let parsed: URL;
  try {
    parsed = new URL(source);
  } catch {
    suiteInvalid(`http-json source "${source}" is not a valid URL`, path);
  }
  if (parsed.username !== '' || parsed.password !== '' || parsed.hash !== '') {
    suiteInvalid('http-json source must not embed credentials or fragments', path);
  }
  if (parsed.protocol === 'https:') return;
  if (allowLoopbackHttp && parsed.protocol === 'http:') {
    const host = parsed.hostname.toLowerCase();
    if (host === '127.0.0.1' || host === 'localhost' || host === '[::1]' || host === '::1') return;
  }
  suiteInvalid(
    allowLoopbackHttp
      ? 'http-json source must use https:// (or loopback http://)'
      : 'http-json source must use https://',
    path,
  );
}

function validateSuiteDomainMatrix(raw: unknown, path: string): TaskpackSuiteDomainMatrix {
  if (Array.isArray(raw)) {
    if (raw.length < 1 || raw.length > LIMITS.targets) {
      suiteInvalid(`domain matrix array must contain 1..${LIMITS.targets} cells`, path);
    }
    const seenIds = new Set<string>();
    const cells: TargetMatrixCell[] = raw.map((item, idx) => {
      const cPath = `${path}/${idx}`;
      const cell = requireSuiteObject(item, cPath, ['id', 'platform', 'variant']);
      const id = requireSuiteIdentifier(cell['id'], `${cPath}/id`);
      if (seenIds.has(id)) suiteInvalid(`duplicate matrix cell id "${id}"`, `${cPath}/id`);
      seenIds.add(id);
      const platform = requireSuiteLabel(cell['platform'], `${cPath}/platform`);
      const variant = requireSuiteLabel(cell['variant'], `${cPath}/variant`);
      return Object.freeze({ id, platform, variant });
    });
    return Object.freeze(cells);
  }
  if (isObjectRecord(raw)) {
    const keys = Object.keys(raw);
    if (keys.length < 1 || keys.length > MAX_MATRIX_ENTRIES) {
      suiteInvalid(`domain matrix object must contain 1..${MAX_MATRIX_ENTRIES} entries`, path);
    }
    const out: Record<string, string | number | boolean> = {};
    for (const key of keys) {
      const kPath = `${path}/${key}`;
      if (FORBIDDEN_KEYS.has(key) || !/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(key)) {
        suiteInvalid(`invalid matrix key "${key}"`, kPath);
      }
      const val = raw[key];
      if (typeof val === 'string') {
        out[key] = requireSuiteString(val, kPath, 1, 256);
      } else if (typeof val === 'boolean') {
        out[key] = val;
      } else if (typeof val === 'number') {
        if (!Number.isFinite(val) || Object.is(val, -0)) {
          suiteInvalid('matrix numeric value must be finite and non-negative-zero', kPath);
        }
        out[key] = val;
      } else {
        suiteInvalid('matrix object values must be string, number, or boolean scalars', kPath);
      }
    }
    return Object.freeze(out);
  }
  suiteInvalid('domain matrix must be an array of TargetMatrixCell entries or a scalar record', path);
}

function validateSuiteReadinessProbe(
  raw: unknown,
  path: string,
  domainIds: ReadonlySet<string>,
  seenProbeIds: Set<string>,
  allowLoopbackHttp: boolean,
): SuiteStageReadinessProbe {
  const rec = requireSuiteObject(raw, path, [
    'id', 'kind', 'source', 'versionFrom', 'expectedVersion', 'ref',
    'tagPrefix', 'jsonPointer', 'versionPath', 'allowPrerelease',
  ]);
  let probeId: string | undefined;
  if (Object.hasOwn(rec, 'id') && rec['id'] !== undefined) {
    probeId = requireSuiteIdentifier(rec['id'], `${path}/id`);
    if (seenProbeIds.has(probeId)) suiteInvalid(`duplicate readiness probe id "${probeId}"`, `${path}/id`);
    seenProbeIds.add(probeId);
  }
  const kindStr = requireSuiteString(rec['kind'], `${path}/kind`, 1, 32);
  if (!(SUITE_STAGE_READINESS_PROBE_KINDS as readonly string[]).includes(kindStr)) {
    suiteInvalid(`unsupported readiness probe kind "${kindStr}"`, `${path}/kind`);
  }
  const kind = kindStr as SuiteStageReadinessProbeKind;
  const source = requireSuiteString(rec['source'], `${path}/source`, 1, 512);
  if (kind === 'github-release') {
    if (!REPOSITORY_FULL_NAME_PATTERN.test(source)) {
      suiteInvalid(`github-release readiness probe source "${source}" must match owner/repo`, `${path}/source`);
    }
  } else if (kind === 'http-json') {
    validateSuiteHttpSourceUrl(source, `${path}/source`, allowLoopbackHttp);
  } else if (source.startsWith('-')) {
    suiteInvalid(`${kind} readiness probe source must not start with "-"`, `${path}/source`);
  }

  let versionFrom: SuiteVersionFromSelector | undefined;
  if (Object.hasOwn(rec, 'versionFrom') && rec['versionFrom'] !== undefined) {
    const vfPath = `${path}/versionFrom`;
    const vfRec = requireSuiteObject(rec['versionFrom'], vfPath, ['domain', 'path', 'jsonPointer']);
    const vfDomain = requireSuiteIdentifier(vfRec['domain'], `${vfPath}/domain`);
    if (!domainIds.has(vfDomain)) {
      suiteInvalid(`versionFrom.domain "${vfDomain}" does not exist in spec.domains`, `${vfPath}/domain`);
    }
    const vfRelPath = normalizeRelativePath(vfRec['path'], `${vfPath}/path`);
    let vfPointer: string | undefined;
    if (Object.hasOwn(vfRec, 'jsonPointer') && vfRec['jsonPointer'] !== undefined) {
      validateRfc6901JsonPointer(vfRec['jsonPointer'], `${vfPath}/jsonPointer`);
      vfPointer = vfRec['jsonPointer'] as string;
    }
    versionFrom = Object.freeze({
      domain: vfDomain,
      path: vfRelPath,
      ...(vfPointer !== undefined ? { jsonPointer: vfPointer } : {}),
    });
  }

  let expectedVersion: string | undefined;
  if (Object.hasOwn(rec, 'expectedVersion') && rec['expectedVersion'] !== undefined) {
    if (versionFrom !== undefined) {
      suiteInvalid('readiness probe cannot specify both versionFrom and expectedVersion', `${path}/expectedVersion`);
    }
    expectedVersion = requireSuiteString(rec['expectedVersion'], `${path}/expectedVersion`, 1, 256).trim();
    if (expectedVersion.length === 0) {
      suiteInvalid('expectedVersion must be non-empty', `${path}/expectedVersion`);
    }
  }

  let ref: string | undefined;
  if (Object.hasOwn(rec, 'ref') && rec['ref'] !== undefined) {
    ref = requireSuiteString(rec['ref'], `${path}/ref`, 1, 256);
    if (!SAFE_GIT_REF_PATTERN.test(ref) || ref.startsWith('-')) {
      suiteInvalid(`invalid git ref "${ref}"`, `${path}/ref`);
    }
  }

  let tagPrefix: string | undefined;
  if (Object.hasOwn(rec, 'tagPrefix') && rec['tagPrefix'] !== undefined) {
    tagPrefix = requireSuiteString(rec['tagPrefix'], `${path}/tagPrefix`, 1, 64);
    if (/[\s]/.test(tagPrefix)) suiteInvalid('tagPrefix must not contain whitespace', `${path}/tagPrefix`);
  }

  let jsonPointer: string | undefined;
  if (Object.hasOwn(rec, 'jsonPointer') && rec['jsonPointer'] !== undefined) {
    if (kind !== 'http-json') {
      suiteInvalid('jsonPointer is only supported on http-json readiness probes', `${path}/jsonPointer`);
    }
    validateRfc6901JsonPointer(rec['jsonPointer'], `${path}/jsonPointer`);
    jsonPointer = rec['jsonPointer'] as string;
  }

  let versionPath: string | undefined;
  if (Object.hasOwn(rec, 'versionPath') && rec['versionPath'] !== undefined) {
    if (kind !== 'http-json') {
      suiteInvalid('versionPath is only supported on http-json readiness probes', `${path}/versionPath`);
    }
    if (jsonPointer !== undefined) {
      suiteInvalid('http-json readiness probe cannot specify both jsonPointer and versionPath', `${path}/versionPath`);
    }
    versionPath = requireSuiteString(rec['versionPath'], `${path}/versionPath`, 1, 256);
    for (const forbidden of FORBIDDEN_KEYS) {
      const segRe = new RegExp(`(?:^|[.\\['"])${forbidden}(?:$|[.\\]'"])`);
      if (segRe.test(versionPath)) {
        suiteInvalid(`versionPath must not reference forbidden property "${forbidden}"`, `${path}/versionPath`);
      }
    }
  }

  let allowPrerelease: boolean | undefined;
  if (Object.hasOwn(rec, 'allowPrerelease') && rec['allowPrerelease'] !== undefined) {
    allowPrerelease = requireSuiteBoolean(rec['allowPrerelease'], `${path}/allowPrerelease`);
  }

  return Object.freeze({
    ...(probeId !== undefined ? { id: probeId } : {}),
    kind,
    source,
    ...(versionFrom !== undefined ? { versionFrom } : {}),
    ...(expectedVersion !== undefined ? { expectedVersion } : {}),
    ...(ref !== undefined ? { ref } : {}),
    ...(tagPrefix !== undefined ? { tagPrefix } : {}),
    ...(jsonPointer !== undefined ? { jsonPointer } : {}),
    ...(versionPath !== undefined ? { versionPath } : {}),
    ...(allowPrerelease !== undefined ? { allowPrerelease } : {}),
  });
}

function computeTopologicalStageOrder(stages: readonly TaskpackSuiteStageDeclaration[]): readonly string[] {
  const byId = new Map<string, TaskpackSuiteStageDeclaration>(stages.map(s => [s.id, s]));
  const state = new Map<string, 0 | 1 | 2>();
  const order: string[] = [];

  const visit = (id: string): void => {
    const cur = state.get(id) ?? 0;
    if (cur === 2) return;
    if (cur === 1) {
      suiteInvalid(`spec.stages contains a dependency cycle involving "${id}"`, '/spec/stages');
    }
    state.set(id, 1);
    const stage = byId.get(id)!;
    for (const dep of stage.dependsOn) {
      visit(dep);
    }
    state.set(id, 2);
    order.push(id);
  };

  for (const stage of stages) {
    visit(stage.id);
  }
  return Object.freeze(order);
}

export interface ValidateTaskpackSuiteOptions {
  readonly suitePath?: string | undefined;
  readonly controlRoot?: string | undefined;
  readonly allowLoopbackHttp?: boolean | undefined;
}

/** Validate a parsed `TaskpackSuite` object (including null-prototype records). */
export function validateTaskpackSuiteManifest(
  value: Json,
  options: ValidateTaskpackSuiteOptions = {},
): TaskpackSuiteManifest {
  const allowLoopbackHttp = options.allowLoopbackHttp === true;
  const suitePath = options.suitePath !== undefined
    ? normalizeRelativePath(options.suitePath, '/')
    : undefined;
  const controlRoot = options.controlRoot !== undefined
    ? normalizeRelativePath(options.controlRoot, '/')
    : deriveControlRoot(suitePath);

  const root = requireSuiteObject(value, '/', ['apiVersion', 'kind', 'metadata', 'spec']);
  if (root['apiVersion'] !== TASKPACK_MANIFEST_API_VERSION) {
    suiteInvalid('unsupported apiVersion', '/apiVersion');
  }
  if (root['kind'] !== 'TaskpackSuite') {
    suiteInvalid('kind must be TaskpackSuite', '/kind');
  }

  const metadata = requireSuiteObject(root['metadata'], '/metadata', ['name']);
  const name = requireSuiteIdentifier(metadata['name'], '/metadata/name');

  const spec = requireSuiteObject(root['spec'], '/spec', ['domains', 'stages']);
  const rawDomains = spec['domains'];
  if (!Array.isArray(rawDomains) || rawDomains.length < 1 || rawDomains.length > MAX_SUITE_DOMAINS) {
    suiteInvalid(`spec.domains must contain 1..${MAX_SUITE_DOMAINS} entries`, '/spec/domains');
  }

  const domainIds = new Set<string>();
  const domainPaths = new Set<string>();
  const domains: TaskpackSuiteDomainDeclaration[] = rawDomains.map((item, idx) => {
    const dPath = `/spec/domains/${idx}`;
    const rawDomain = requireSuiteObject(item, dPath, ['id', 'taskpack', 'enabled', 'schedules', 'stage', 'matrix']);
    const id = requireSuiteIdentifier(rawDomain['id'], `${dPath}/id`);
    if (domainIds.has(id)) suiteInvalid(`duplicate domain id "${id}"`, `${dPath}/id`);
    domainIds.add(id);

    const rawTpPath = requireSuiteString(rawDomain['taskpack'], `${dPath}/taskpack`, 1, 1021);
    const normalizedTpPath = normalizeRelativePath(posix.normalize(rawTpPath.replace(/\\/g, '/')), `${dPath}/taskpack`);
    if (!/\.(?:yaml|yml|json)$/i.test(normalizedTpPath)) {
      suiteInvalid('domain taskpack path must end in .yaml, .yml, or .json', `${dPath}/taskpack`);
    }
    if (suitePath !== undefined && normalizedTpPath === suitePath) {
      suiteInvalid('domain taskpack path must not equal the suite manifest path', `${dPath}/taskpack`);
    }
    if (domainPaths.has(normalizedTpPath)) {
      suiteInvalid(`duplicate domain taskpack path "${normalizedTpPath}"`, `${dPath}/taskpack`);
    }
    domainPaths.add(normalizedTpPath);

    const enabled = Object.hasOwn(rawDomain, 'enabled') && rawDomain['enabled'] !== undefined
      ? requireSuiteBoolean(rawDomain['enabled'], `${dPath}/enabled`)
      : true;

    let schedules: readonly string[] | undefined;
    if (Object.hasOwn(rawDomain, 'schedules') && rawDomain['schedules'] !== undefined) {
      schedules = requireUniqueStringList(rawDomain['schedules'], `${dPath}/schedules`, 0, MAX_SCHEDULE_KEYS, 128);
    }

    let stage: string | undefined;
    if (Object.hasOwn(rawDomain, 'stage') && rawDomain['stage'] !== undefined) {
      stage = requireSuiteIdentifier(rawDomain['stage'], `${dPath}/stage`);
    }

    let matrix: TaskpackSuiteDomainMatrix | undefined;
    if (Object.hasOwn(rawDomain, 'matrix') && rawDomain['matrix'] !== undefined) {
      matrix = validateSuiteDomainMatrix(rawDomain['matrix'], `${dPath}/matrix`);
    }

    return Object.freeze({
      id,
      taskpack: normalizedTpPath,
      enabled,
      ...(schedules !== undefined ? { schedules } : {}),
      ...(stage !== undefined ? { stage } : {}),
      ...(matrix !== undefined ? { matrix } : {}),
    });
  });

  let stages: readonly TaskpackSuiteStageDeclaration[] = Object.freeze([]);
  if (Object.hasOwn(spec, 'stages') && spec['stages'] !== undefined) {
    const rawStages = spec['stages'];
    if (!Array.isArray(rawStages) || rawStages.length > MAX_SUITE_STAGES) {
      suiteInvalid(`spec.stages must contain 0..${MAX_SUITE_STAGES} entries`, '/spec/stages');
    }
    const seenStageIds = new Set<string>();
    const parsedStages: TaskpackSuiteStageDeclaration[] = rawStages.map((item, idx) => {
      const sPath = `/spec/stages/${idx}`;
      const rawStage = requireSuiteObject(item, sPath, ['id', 'dependsOn', 'readiness']);
      const id = requireSuiteIdentifier(rawStage['id'], `${sPath}/id`);
      if (seenStageIds.has(id)) suiteInvalid(`duplicate stage id "${id}"`, `${sPath}/id`);
      seenStageIds.add(id);

      let dependsOn: readonly string[] = Object.freeze([]);
      if (Object.hasOwn(rawStage, 'dependsOn') && rawStage['dependsOn'] !== undefined) {
        const deps = requireUniqueStringList(rawStage['dependsOn'], `${sPath}/dependsOn`, 0, MAX_SUITE_STAGES - 1, 64);
        for (const [dIdx, dep] of deps.entries()) {
          requireSuiteIdentifier(dep, `${sPath}/dependsOn/${dIdx}`);
        }
        dependsOn = deps;
      }

      let readiness: readonly SuiteStageReadinessProbe[] = Object.freeze([]);
      if (Object.hasOwn(rawStage, 'readiness') && rawStage['readiness'] !== undefined) {
        const rawProbes = rawStage['readiness'];
        if (!Array.isArray(rawProbes) || rawProbes.length > MAX_SUITE_STAGE_READINESS_PROBES) {
          suiteInvalid(`stage readiness must contain 0..${MAX_SUITE_STAGE_READINESS_PROBES} probes`, `${sPath}/readiness`);
        }
        const seenProbeIds = new Set<string>();
        readiness = Object.freeze(rawProbes.map((probe, pIdx) => (
          validateSuiteReadinessProbe(probe, `${sPath}/readiness/${pIdx}`, domainIds, seenProbeIds, allowLoopbackHttp)
        )));
      }

      return Object.freeze({ id, dependsOn, readiness });
    });

    for (const [idx, stage] of parsedStages.entries()) {
      for (const [dIdx, depId] of stage.dependsOn.entries()) {
        if (depId === stage.id) {
          suiteInvalid(`stage "${stage.id}" cannot depend on itself`, `/spec/stages/${idx}/dependsOn/${dIdx}`);
        }
        if (!seenStageIds.has(depId)) {
          suiteInvalid(`stage "${stage.id}" dependsOn unknown stage "${depId}"`, `/spec/stages/${idx}/dependsOn/${dIdx}`);
        }
      }
    }
    computeTopologicalStageOrder(parsedStages);
    stages = Object.freeze(parsedStages);
  }

  const stageIdSet = new Set(stages.map(s => s.id));
  for (const [idx, domain] of domains.entries()) {
    if (domain.stage !== undefined && !stageIdSet.has(domain.stage)) {
      suiteInvalid(`domain "${domain.id}" references unknown stage "${domain.stage}"`, `/spec/domains/${idx}/stage`);
    }
  }

  const suiteManifest: TaskpackSuiteManifest = {
    apiVersion: TASKPACK_MANIFEST_API_VERSION,
    kind: 'TaskpackSuite',
    metadata: Object.freeze({ name }),
    spec: Object.freeze({
      domains: Object.freeze(domains),
      stages,
    }),
  };
  Object.defineProperty(suiteManifest, 'controlRoot', { value: controlRoot, enumerable: false });
  if (suitePath !== undefined) {
    Object.defineProperty(suiteManifest, 'suitePath', { value: suitePath, enumerable: false });
  }
  return Object.freeze(suiteManifest);
}

/** Parse YAML/JSON bytes and validate as a `TaskpackSuite` (`<= 65_536` bytes). */
export function parseTaskpackSuiteManifest(
  raw: string | Uint8Array,
  options: ValidateTaskpackSuiteOptions & { readonly format?: 'yaml' | 'json' | undefined } = {},
): TaskpackSuiteManifest {
  const bytes = typeof raw === 'string' ? Buffer.from(raw, 'utf8') : raw;
  if (bytes.byteLength > TASKPACK_SUITE_MANIFEST_BYTES) {
    throw new TaskpackError('TASKPACK_MANIFEST_INVALID', `suite manifest exceeds ${TASKPACK_SUITE_MANIFEST_BYTES} bytes`, '/');
  }
  const parsed = parseTaskpackDocument(bytes, options.format ?? 'yaml');
  return validateTaskpackSuiteManifest(parsed, options);
}

// ---------------------------------------------------------------------------
// Safe file loading (O_NOFOLLOW, !isSymbolicLink, isFile, nlink === 1)
// ---------------------------------------------------------------------------

function isContainedInRoot(candidate: string, realRoot: string): boolean {
  if (candidate === realRoot) return true;
  const prefix = realRoot.endsWith(sep) ? realRoot : `${realRoot}${sep}`;
  return candidate.startsWith(prefix);
}

async function resolveSafeRepositoryRoot(repositoryRoot: string): Promise<{ resolvedRoot: string; realRoot: string }> {
  const resolvedRoot = resolve(repositoryRoot);
  const st = await lstat(resolvedRoot).catch(() => null);
  if (st === null || st.isSymbolicLink() || !st.isDirectory()) {
    throw new TaskpackError('TASKPACK_MANIFEST_INVALID', 'repository root must be an existing non-symlink directory', '/');
  }
  const realRoot = await realpath(resolvedRoot).catch(() => {
    throw new TaskpackError('TASKPACK_MANIFEST_INVALID', 'repository root cannot be resolved', '/');
  });
  return { resolvedRoot, realRoot };
}

async function resolveDarwinFdPath(fd: number): Promise<string | null> {
  return new Promise<string | null>(resolvePromise => {
    let settled = false;
    const finish = (value: string | null): void => {
      if (settled) return;
      settled = true;
      resolvePromise(value);
    };
    let child;
    try {
      child = spawn(
        '/usr/bin/perl',
        ['-e', 'open(my $fh, "<&=", 3) or exit 1; my $buf = "\\0" x 4096; fcntl($fh, 50, $buf) or exit 1; $buf =~ s/\\0.*//s; print $buf;'],
        {
          stdio: ['ignore', 'pipe', 'ignore', fd],
          env: { PATH: '/usr/bin:/bin' },
        },
      );
    } catch {
      finish(null);
      return;
    }
    const chunks: Buffer[] = [];
    let total = 0;
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      finish(null);
    }, 5_000);
    timer.unref?.();
    child.stdout?.on('data', (chunk: Buffer) => {
      total += chunk.byteLength;
      if (total > 4096) {
        child.kill('SIGKILL');
        clearTimeout(timer);
        finish(null);
        return;
      }
      chunks.push(chunk);
    });
    child.on('error', () => {
      clearTimeout(timer);
      finish(null);
    });
    child.on('close', code => {
      clearTimeout(timer);
      if (code !== 0) {
        finish(null);
        return;
      }
      const out = Buffer.concat(chunks, total).toString('utf8');
      finish(out.length > 0 ? out : null);
    });
  });
}

async function readSafeControlFileUnderRoot(
  resolvedRoot: string,
  realRoot: string,
  relPath: string,
  maxBytes: number,
  diagPath: string,
): Promise<{ bytes: Buffer; sha256: string }> {
  const normalized = normalizeRelativePath(relPath, diagPath);
  const segments = normalized.split('/');
  const parentDirs: Array<{ readonly path: string; readonly segment: string; readonly dev: number; readonly ino: number }> = [];
  let cursor = resolvedRoot;
  for (let i = 0; i < segments.length; i += 1) {
    const seg = segments[i]!;
    cursor = join(cursor, seg);
    const st = await lstat(cursor).catch(() => null);
    if (st === null) {
      throw new TaskpackError('TASKPACK_MANIFEST_INVALID', `path "${normalized}" does not exist`, diagPath);
    }
    if (st.isSymbolicLink()) {
      throw new TaskpackError('TASKPACK_SCOPE_VIOLATION', `path "${normalized}" must not traverse or target symbolic links`, diagPath);
    }
    if (i < segments.length - 1) {
      if (!st.isDirectory()) {
        throw new TaskpackError('TASKPACK_MANIFEST_INVALID', `parent segment of "${normalized}" is not a directory`, diagPath);
      }
      parentDirs.push({ path: cursor, segment: seg, dev: st.dev, ino: st.ino });
    }
  }
  const realFull = await realpath(cursor).catch(() => {
    throw new TaskpackError('TASKPACK_MANIFEST_INVALID', `path "${normalized}" cannot be resolved`, diagPath);
  });
  if (!isContainedInRoot(realFull, realRoot)) {
    throw new TaskpackError('TASKPACK_SCOPE_VIOLATION', `path "${normalized}" escapes repository root`, diagPath);
  }

  const before = await lstat(cursor).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ELOOP') {
      throw new TaskpackError('TASKPACK_SCOPE_VIOLATION', `symbolic link traversal is forbidden at "${normalized}"`, diagPath);
    }
    throw new TaskpackError('TASKPACK_MANIFEST_INVALID', `file "${normalized}" cannot be inspected`, diagPath);
  });
  if (before.isSymbolicLink()) {
    throw new TaskpackError('TASKPACK_SCOPE_VIOLATION', `file "${normalized}" must not be a symbolic link`, diagPath);
  }
  if (!before.isFile()) {
    throw new TaskpackError('TASKPACK_MANIFEST_INVALID', `path "${normalized}" must be a regular file`, diagPath);
  }
  if (before.nlink !== 1) {
    throw new TaskpackError('TASKPACK_SCOPE_VIOLATION', `hardlinked file "${normalized}" (nlink=${before.nlink}) is forbidden`, diagPath);
  }
  if (before.size > maxBytes) {
    throw new TaskpackError('TASKPACK_MANIFEST_INVALID', `file "${normalized}" exceeds ${maxBytes} bytes`, diagPath);
  }

  const noFollow = 'O_NOFOLLOW' in constants ? constants.O_NOFOLLOW : 0;
  const oDirectory = 'O_DIRECTORY' in constants ? constants.O_DIRECTORY : 0;
  const pinnedParentHandles: Array<{ readonly handle: Awaited<ReturnType<typeof open>>; readonly path: string; readonly dev: number; readonly ino: number }> = [];
  let rootHandle: Awaited<ReturnType<typeof open>> | undefined;
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    if (process.platform === 'linux') {
      rootHandle = await open(realRoot, constants.O_RDONLY | noFollow | oDirectory);
      let currentDirFd = rootHandle.fd;
      for (const parent of parentDirs) {
        let dirHandle: Awaited<ReturnType<typeof open>>;
        try {
          dirHandle = await open(`/proc/self/fd/${currentDirFd}/${parent.segment}`, constants.O_RDONLY | noFollow | oDirectory);
        } catch (error) {
          const code = (error as NodeJS.ErrnoException | null)?.code;
          if (code === 'ELOOP' || code === 'ENOTDIR') {
            throw new TaskpackError('TASKPACK_SCOPE_VIOLATION', `parent directory of "${normalized}" became a symbolic link`, diagPath);
          }
          throw new TaskpackError('TASKPACK_MANIFEST_INVALID', `parent directory of "${normalized}" could not be opened`, diagPath);
        }
        const dirInfo = await dirHandle.stat();
        if (!dirInfo.isDirectory() || dirInfo.dev !== parent.dev || dirInfo.ino !== parent.ino) {
          await dirHandle.close().catch(() => undefined);
          throw new TaskpackError('TASKPACK_SCOPE_VIOLATION', `parent directory of "${normalized}" changed identity before opening`, diagPath);
        }
        pinnedParentHandles.push({ handle: dirHandle, path: parent.path, dev: parent.dev, ino: parent.ino });
        currentDirFd = dirHandle.fd;
      }
      const leafSegment = segments[segments.length - 1]!;
      try {
        handle = await open(`/proc/self/fd/${currentDirFd}/${leafSegment}`, constants.O_RDONLY | noFollow);
      } catch (error) {
        const code = (error as NodeJS.ErrnoException | null)?.code;
        if (code === 'ELOOP') {
          throw new TaskpackError('TASKPACK_SCOPE_VIOLATION', `symbolic link detected while opening "${normalized}"`, diagPath);
        }
        throw new TaskpackError('TASKPACK_MANIFEST_INVALID', `file "${normalized}" could not be opened`, diagPath);
      }
    } else {
      for (const parent of parentDirs) {
        let dirHandle: Awaited<ReturnType<typeof open>>;
        try {
          dirHandle = await open(parent.path, constants.O_RDONLY | noFollow | oDirectory);
        } catch (error) {
          const code = (error as NodeJS.ErrnoException | null)?.code;
          if (code === 'ELOOP' || code === 'ENOTDIR') {
            throw new TaskpackError('TASKPACK_SCOPE_VIOLATION', `parent directory of "${normalized}" became a symbolic link`, diagPath);
          }
          throw new TaskpackError('TASKPACK_MANIFEST_INVALID', `parent directory of "${normalized}" could not be opened`, diagPath);
        }
        const dirInfo = await dirHandle.stat();
        if (!dirInfo.isDirectory() || dirInfo.dev !== parent.dev || dirInfo.ino !== parent.ino) {
          await dirHandle.close().catch(() => undefined);
          throw new TaskpackError('TASKPACK_SCOPE_VIOLATION', `parent directory of "${normalized}" changed identity before opening`, diagPath);
        }
        pinnedParentHandles.push({ handle: dirHandle, path: parent.path, dev: parent.dev, ino: parent.ino });
      }
      try {
        handle = await open(cursor, constants.O_RDONLY | noFollow);
      } catch (error) {
        const code = (error as NodeJS.ErrnoException | null)?.code;
        if (code === 'ELOOP') {
          throw new TaskpackError('TASKPACK_SCOPE_VIOLATION', `symbolic link detected while opening "${normalized}"`, diagPath);
        }
        throw new TaskpackError('TASKPACK_MANIFEST_INVALID', `file "${normalized}" could not be opened`, diagPath);
      }
    }
    const info = await handle.stat();
    if (!info.isFile() || info.nlink !== 1 || info.dev !== before.dev || info.ino !== before.ino) {
      throw new TaskpackError('TASKPACK_SCOPE_VIOLATION', `file "${normalized}" identity or link count changed while opening`, diagPath);
    }
    if (info.size !== before.size || info.size > maxBytes) {
      throw new TaskpackError('TASKPACK_MANIFEST_INVALID', `file "${normalized}" changed size while loading or exceeds ${maxBytes} bytes`, diagPath);
    }
    if (process.platform === 'linux') {
      const fdResolvedPath = await readlink(`/proc/self/fd/${handle.fd}`).catch(() => null);
      if (fdResolvedPath === null || fdResolvedPath !== realFull || !isContainedInRoot(fdResolvedPath, realRoot)) {
        throw new TaskpackError(
          'TASKPACK_SCOPE_VIOLATION',
          `opened file descriptor for "${normalized}" resolved outside repository root`,
          diagPath,
        );
      }
    } else if (process.platform === 'darwin') {
      const fdResolvedPath = await resolveDarwinFdPath(handle.fd);
      if (fdResolvedPath === null || fdResolvedPath !== realFull || !isContainedInRoot(fdResolvedPath, realRoot)) {
        throw new TaskpackError(
          'TASKPACK_SCOPE_VIOLATION',
          `opened file descriptor for "${normalized}" resolved outside repository root`,
          diagPath,
        );
      }
    }
    for (const parent of pinnedParentHandles) {
      const postParent = await lstat(parent.path).catch(() => null);
      const postFdStat = await parent.handle.stat().catch(() => null);
      if (
        postParent === null
        || postFdStat === null
        || postParent.isSymbolicLink()
        || !postParent.isDirectory()
        || postParent.dev !== parent.dev
        || postParent.ino !== parent.ino
        || postFdStat.dev !== parent.dev
        || postFdStat.ino !== parent.ino
      ) {
        throw new TaskpackError(
          'TASKPACK_SCOPE_VIOLATION',
          `parent directory of "${normalized}" changed identity or became a symbolic link while opening`,
          diagPath,
        );
      }
    }
    const postReal = await realpath(cursor).catch(() => null);
    const postLeaf = await lstat(cursor).catch(() => null);
    if (
      postReal === null
      || postReal !== realFull
      || !isContainedInRoot(postReal, realRoot)
      || postLeaf === null
      || postLeaf.isSymbolicLink()
      || postLeaf.dev !== info.dev
      || postLeaf.ino !== info.ino
    ) {
      throw new TaskpackError(
        'TASKPACK_SCOPE_VIOLATION',
        `file "${normalized}" escaped repository root or changed identity during open`,
        diagPath,
      );
    }
    const buf = Buffer.alloc(info.size + 1);
    let size = 0;
    while (size < buf.length) {
      const read = await handle.read(buf, size, buf.length - size, size);
      if (!read.bytesRead) break;
      size += read.bytesRead;
    }
    if (size !== info.size) {
      throw new TaskpackError('TASKPACK_MANIFEST_INVALID', `file "${normalized}" mutated while loading`, diagPath);
    }
    const slice = buf.subarray(0, size);
    const sha256 = createHash('sha256').update(slice).digest('hex');
    return { bytes: slice, sha256 };
  } finally {
    if (handle !== undefined) {
      await handle.close().catch(() => undefined);
    }
    for (const parent of pinnedParentHandles.reverse()) {
      await parent.handle.close().catch(() => undefined);
    }
    if (rootHandle !== undefined) {
      await rootHandle.close().catch(() => undefined);
    }
  }
}

function resolveSuiteRelativePath(repositoryRoot: string, rawSuitePath: string | undefined): string {
  if (rawSuitePath === undefined || rawSuitePath.trim().length === 0) {
    return DEFAULT_TASKPACK_SUITE_PATH;
  }
  const segments = rawSuitePath.split(/[\\/]/);
  if (segments.includes('..')) {
    suiteInvalid('suite path must not contain ".." traversal', '/');
  }
  const resolvedRoot = resolve(repositoryRoot);
  if (isAbsolute(rawSuitePath)) {
    const rel = relative(resolvedRoot, resolve(rawSuitePath));
    if (rel.length === 0 || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
      suiteInvalid('suite path escapes repository root', '/');
    }
    return normalizeRelativePath(rel.split(sep).join('/'), '/');
  }
  return normalizeRelativePath(posix.normalize(rawSuitePath.replace(/\\/g, '/')), '/');
}

function cloneManifestWithAdditionalProtectedPaths(
  manifest: TaskpackManifest,
  additionalProtected: readonly string[],
  controlRoot: string,
  manifestPath: string,
): TaskpackManifest {
  const builtInSet = new Set<string>([...LOCAL_PROTECTED_AUTOMATION_PATHS, ...GITHUB_PROTECTED_AUTOMATION_PATHS]);
  const merged = new Set<string>(manifest.spec.scope.protected);
  for (const entry of additionalProtected) {
    if (!builtInSet.has(entry)) merged.add(entry);
  }
  const nextProtected = Object.freeze([...merged]);
  if (nextProtected.length > LIMITS.patterns) {
    suiteInvalid(`domain "${manifest.metadata.name}" merged protected paths exceed ${LIMITS.patterns} entries`, '/spec/domains');
  }
  const nextSpec: TaskpackManifest['spec'] = Object.freeze({
    ...manifest.spec,
    scope: Object.freeze({
      writable: manifest.spec.scope.writable,
      protected: nextProtected,
    }),
  });
  const cloned: TaskpackManifest = {
    apiVersion: manifest.apiVersion,
    kind: manifest.kind,
    metadata: manifest.metadata,
    spec: nextSpec,
  };
  Object.defineProperty(cloned, 'controlRoot', { value: controlRoot, enumerable: false });
  Object.defineProperty(cloned, 'manifestPath', { value: manifestPath, enumerable: false });
  return Object.freeze(cloned);
}

export interface LoadTaskpackSuiteOptions {
  readonly repositoryRoot: string;
  readonly suitePath?: string | undefined;
  readonly gitRevision?: string | undefined;
  readonly policyProfile?: PolicyProfile | undefined;
  readonly hostPolicy?: ExecutionHostPolicy | undefined;
  readonly enforceHostAuthority?: boolean | undefined;
  readonly allowLoopbackHttp?: boolean | undefined;
  readonly executionMode?: 'pi' | 'delegated' | undefined;
  readonly verifyDigests?: boolean | undefined;
}

/**
 * Load and validate a `TaskpackSuite` manifest (`<= 65_536` bytes) and all declared domain `Taskpack`
 * manifests under `repositoryRoot`, enforcing `O_NOFOLLOW` / `nlink === 1`, unique domain IDs/paths/names,
 * pairwise prefix-disjoint `headBranchPrefix` per `targetBranch`, and the suite-wide mandatory protected
 * path union (`<= 128` patterns, disjoint from every domain's `writable` paths).
 */
export async function loadTaskpackSuite(options: LoadTaskpackSuiteOptions): Promise<LoadedTaskpackSuite> {
  if (options.gitRevision !== undefined && options.verifyDigests === true) {
    throw new TaskpackError(
      'ACTION_INPUT_INVALID',
      'verifyDigests cannot be combined with gitRevision because digest verification inspects the working tree',
      '/',
    );
  }
  const policyProfile: PolicyProfile = options.policyProfile ?? options.hostPolicy?.policyProfile ?? 'local';
  const { resolvedRoot, realRoot } = await resolveSafeRepositoryRoot(options.repositoryRoot);
  const pinnedGitSha = options.gitRevision !== undefined
    ? await resolveGitCommitSha(resolvedRoot, options.gitRevision, 15_000)
    : undefined;
  const readControlFile = async (relPath: string, maxBytes: number, diagPath: string): Promise<{ bytes: Buffer; sha256: string }> => {
    if (pinnedGitSha !== undefined) {
      const bytes = await readOptionalGitBlobBytes(resolvedRoot, pinnedGitSha, relPath, maxBytes, 15_000);
      if (bytes === null) {
        throw new TaskpackError('TASKPACK_MANIFEST_INVALID', `path "${relPath}" does not exist in git revision ${pinnedGitSha}`, diagPath);
      }
      return { bytes, sha256: createHash('sha256').update(bytes).digest('hex') };
    }
    return readSafeControlFileUnderRoot(resolvedRoot, realRoot, relPath, maxBytes, diagPath);
  };
  const suitePath = resolveSuiteRelativePath(resolvedRoot, options.suitePath);
  const suiteExt = extname(suitePath).toLowerCase();
  if (suiteExt !== '.yaml' && suiteExt !== '.yml' && suiteExt !== '.json') {
    suiteInvalid('suite manifest extension must be .yaml, .yml, or .json', '/');
  }
  const suiteControlRoot = deriveControlRoot(suitePath);
  const { bytes: suiteBytes, sha256: suiteSha256 } = await readControlFile(
    suitePath,
    TASKPACK_SUITE_MANIFEST_BYTES,
    '/',
  );
  const effectiveAllowLoopbackHttp = options.allowLoopbackHttp ?? (policyProfile === 'local');
  const suiteManifest = parseTaskpackSuiteManifest(suiteBytes, {
    suitePath,
    controlRoot: suiteControlRoot,
    format: suiteExt === '.json' ? 'json' : 'yaml',
    allowLoopbackHttp: effectiveAllowLoopbackHttp,
  });

  const githubSiblings = policyProfile === 'github'
    ? collectGitHubSiblingPaths({ repositoryRoot: resolvedRoot })
    : Object.freeze<readonly string[]>([]);

  interface RawLoadedDomain {
    readonly decl: TaskpackSuiteDomainDeclaration;
    readonly index: number;
    readonly controlRoot: string;
    readonly manifestSha256: string;
    readonly manifest: TaskpackManifest;
    readonly allowWorkflowWrites: boolean;
    readonly controlPlane: ManifestControlPlanePathsSummary;
  }

  const seenManifestNames = new Map<string, string>();
  const rawDomains: RawLoadedDomain[] = [];

  for (const [idx, decl] of suiteManifest.spec.domains.entries()) {
    const diagPath = `/spec/domains/${idx}/taskpack`;
    const domainExt = extname(decl.taskpack).toLowerCase();
    if (domainExt !== '.yaml' && domainExt !== '.yml' && domainExt !== '.json') {
      suiteInvalid('domain taskpack extension must be .yaml, .yml, or .json', diagPath);
    }
    const { bytes: domainBytes, sha256: manifestSha256 } = await readControlFile(
      decl.taskpack,
      TASKPACK_MANIFEST_BYTES,
      diagPath,
    );
    const domainControlRoot = deriveControlRoot(decl.taskpack);
    const domainManifest = validateTaskpackV2Manifest(
      parseTaskpackDocument(domainBytes, domainExt === '.json' ? 'json' : 'yaml'),
      {
        controlRoot: domainControlRoot,
        manifestPath: decl.taskpack,
        policyProfile,
        hostPolicy: options.hostPolicy,
        enforceHostAuthority: options.enforceHostAuthority,
        allowLoopbackHttp: options.allowLoopbackHttp,
        executionMode: options.executionMode,
        githubSiblings,
      },
    );

    const existingOwner = seenManifestNames.get(domainManifest.metadata.name);
    if (existingOwner !== undefined) {
      suiteInvalid(
        `duplicate taskpack metadata.name "${domainManifest.metadata.name}" across domains "${existingOwner}" and "${decl.id}"`,
        `/spec/domains/${idx}`,
      );
    }
    seenManifestNames.set(domainManifest.metadata.name, decl.id);

    if (options.verifyDigests === true && domainManifest.spec.execution?.digests.pinDigests === true) {
      await assertDigestLockfileVerified(resolvedRoot, domainManifest, domainControlRoot);
    }

    const allowWorkflowWrites = (
      policyProfile === 'github'
      && domainManifest.spec.execution?.capabilities.allowWorkflowWrites === true
      && (options.enforceHostAuthority === false || options.hostPolicy?.allowWorkflowWrites === true)
    );
    const controlPlane = collectManifestControlPlanePaths(domainManifest, {
      policyProfile,
      controlRoot: domainControlRoot,
      manifestPath: decl.taskpack,
      allowWorkflowWrites,
      githubSiblings,
    });

    rawDomains.push({
      decl,
      index: idx,
      controlRoot: domainControlRoot,
      manifestSha256,
      manifest: domainManifest,
      allowWorkflowWrites,
      controlPlane,
    });
  }

  // Pairwise prefix-disjoint headBranchPrefix per targetBranch across all pull_request domains
  const prDomainsByTarget = new Map<string, RawLoadedDomain[]>();
  for (const item of rawDomains) {
    if (item.manifest.spec.publication.mode === 'pull_request') {
      const tb = item.manifest.spec.publication.targetBranch;
      const list = prDomainsByTarget.get(tb) ?? [];
      list.push(item);
      prDomainsByTarget.set(tb, list);
    }
  }
  for (const [targetBranch, list] of prDomainsByTarget.entries()) {
    for (let i = 0; i < list.length; i += 1) {
      for (let j = i + 1; j < list.length; j += 1) {
        const domA = list[i]!;
        const domB = list[j]!;
        const prefA = domA.manifest.spec.publication.mode === 'pull_request' ? domA.manifest.spec.publication.headBranchPrefix : '';
        const prefB = domB.manifest.spec.publication.mode === 'pull_request' ? domB.manifest.spec.publication.headBranchPrefix : '';
        if (headBranchPrefixesCollide(prefA, prefB)) {
          suiteInvalid(
            `domains "${domA.decl.id}" ("${prefA}") and "${domB.decl.id}" ("${prefB}") declare colliding headBranchPrefix values on targetBranch "${targetBranch}"`,
            `/spec/domains/${domB.index}`,
          );
        }
      }
    }
  }

  // Reject colliding carved-out proposal paths across domains or against the suite manifest (case-insensitively)
  const seenCarvedProposals: { readonly domainId: string; readonly path: string; readonly index: number }[] = [];
  for (const item of rawDomains) {
    const propPath = item.controlPlane.carvedOutProposalPath;
    if (propPath === undefined) continue;
    if (pathCoveredByCaseInsensitive(propPath, suitePath) || pathCoveredByCaseInsensitive(suitePath, propPath)) {
      suiteInvalid(
        `domain "${item.decl.id}" carved-out proposal.path "${propPath}" collides with suite manifest "${suitePath}"`,
        `/spec/domains/${item.index}`,
      );
    }
    for (const prev of seenCarvedProposals) {
      if (pathCoveredByCaseInsensitive(propPath, prev.path) || pathCoveredByCaseInsensitive(prev.path, propPath)) {
        suiteInvalid(
          `domains "${prev.domainId}" ("${prev.path}") and "${item.decl.id}" ("${propPath}") declare colliding carved-out proposal.path values`,
          `/spec/domains/${item.index}`,
        );
      }
    }
    seenCarvedProposals.push({ domainId: item.decl.id, path: propPath, index: item.index });
  }

  // Compute suite-wide mandatory protected path union (paths NO domain in the suite may write).
  // Carve-out matching uses exact `pathCoveredBy` to stay aligned with `canCarveOutControlRootProposal`
  // and `collectControlRootSiblingPaths`; case-variant control roots fail closed during overlap checks.
  const carvedOutProposals = seenCarvedProposals.map(entry => entry.path);
  const isRootCarvedByAnyProposal = (dirRoot: string): boolean => (
    carvedOutProposals.some(propPath => pathCoveredBy(propPath, dirRoot))
  );
  const siblingCache = new Map<string, ReturnType<typeof collectControlRootSiblingPaths>>();
  const getControlRootSiblings = (dirRoot: string, propPath: string) => {
    const key = `${dirRoot}\0${propPath}`;
    const cached = siblingCache.get(key);
    if (cached !== undefined) return cached;
    const computed = collectControlRootSiblingPaths({
      repositoryRoot: resolvedRoot,
      controlRoot: dirRoot,
      proposalPath: propPath,
    });
    siblingCache.set(key, computed);
    return computed;
  };

  const suiteDirRaw = posix.dirname(suitePath);
  const hasDedicatedSuiteDir = suiteDirRaw !== '.' && suiteDirRaw !== '';
  const allAllowWorkflowWrites = policyProfile === 'github'
    && rawDomains.length > 0
    && rawDomains.every(d => d.allowWorkflowWrites);
  const builtInAutomation = policyProfile === 'local'
    ? LOCAL_PROTECTED_AUTOMATION_PATHS
    : (allAllowWorkflowWrites
      ? GITHUB_PROTECTED_AUTOMATION_PATHS.filter(entry => entry !== '.github')
      : GITHUB_PROTECTED_AUTOMATION_PATHS);

  const suiteUnionSet = new Set<string>([
    ...builtInAutomation,
    suitePath,
  ]);
  const addSuiteWideCarvedSiblings = (dirRoot: string): void => {
    for (const propPath of carvedOutProposals) {
      if (!pathCoveredBy(propPath, dirRoot)) continue;
      const sibs = getControlRootSiblings(dirRoot, propPath);
      for (const s of sibs.prioritySiblings) {
        if (!isRootCarvedByAnyProposal(s)) suiteUnionSet.add(s);
      }
      for (const s of sibs.regularSiblings) {
        if (!isRootCarvedByAnyProposal(s)) suiteUnionSet.add(s);
      }
    }
  };
  if (hasDedicatedSuiteDir) {
    if (!isRootCarvedByAnyProposal(suiteControlRoot)) {
      suiteUnionSet.add(suiteControlRoot);
    } else {
      suiteUnionSet.add(`${suiteControlRoot}/policies`);
      suiteUnionSet.add(`${suiteControlRoot}/checks`);
      suiteUnionSet.add(`${suiteControlRoot}/scripts`);
      suiteUnionSet.add(`${suiteControlRoot}/memory`);
      suiteUnionSet.add(`${suiteControlRoot}/taskpack.yaml`);
      suiteUnionSet.add(`${suiteControlRoot}/taskpack.yml`);
      suiteUnionSet.add(`${suiteControlRoot}/taskpack.json`);
      suiteUnionSet.add(`${suiteControlRoot}/digests.lock.json`);
      addSuiteWideCarvedSiblings(suiteControlRoot);
    }
  }

  for (const item of rawDomains) {
    if (isRootCarvedByAnyProposal(item.controlRoot)) {
      for (const p of item.controlPlane.explicitWithoutControlRoot) {
        suiteUnionSet.add(p);
      }
      addSuiteWideCarvedSiblings(item.controlRoot);
    } else {
      for (const p of item.controlPlane.compactMandatoryPaths) {
        suiteUnionSet.add(p);
      }
    }
  }

  const suiteProtectedPaths = Object.freeze([...suiteUnionSet]);
  if (suiteProtectedPaths.length > LIMITS.patterns) {
    suiteInvalid(
      `suite-wide mandatory protected path union (${suiteProtectedPaths.length}) exceeds ${LIMITS.patterns} patterns`,
      '/spec/domains',
    );
  }

  const builtInProtectedSet = new Set<string>([...LOCAL_PROTECTED_AUTOMATION_PATHS, ...GITHUB_PROTECTED_AUTOMATION_PATHS]);
  const loadedDomains: LoadedTaskpackSuiteDomain[] = [];

  for (const item of rawDomains) {
    const ownCarvedProposal = item.controlPlane.carvedOutProposalPath;

    // Start with suite-wide invariants, then add peer control roots, peer proposals, and siblings along this domain's own carved-out spine.
    const perDomainSuiteExtra = new Set<string>(suiteProtectedPaths);
    const addOwnCarvedSiblings = (dirRoot: string, propPath: string): void => {
      const sibs = getControlRootSiblings(dirRoot, propPath);
      for (const s of sibs.prioritySiblings) perDomainSuiteExtra.add(s);
      for (const s of sibs.regularSiblings) perDomainSuiteExtra.add(s);
    };
    if (hasDedicatedSuiteDir) {
      if (ownCarvedProposal === undefined || !pathCoveredBy(ownCarvedProposal, suiteControlRoot)) {
        perDomainSuiteExtra.add(suiteControlRoot);
      } else {
        addOwnCarvedSiblings(suiteControlRoot, ownCarvedProposal);
      }
    }
    if (ownCarvedProposal !== undefined && pathCoveredBy(ownCarvedProposal, item.controlRoot)) {
      addOwnCarvedSiblings(item.controlRoot, ownCarvedProposal);
    }
    for (const peer of rawDomains) {
      if (peer.decl.id === item.decl.id) continue;
      if (ownCarvedProposal === undefined || !pathCoveredBy(ownCarvedProposal, peer.controlRoot)) {
        perDomainSuiteExtra.add(peer.controlRoot);
      } else {
        addOwnCarvedSiblings(peer.controlRoot, ownCarvedProposal);
      }
      if (peer.controlPlane.carvedOutProposalPath !== undefined) {
        perDomainSuiteExtra.add(peer.controlPlane.carvedOutProposalPath);
      }
    }

    for (const [wIdx, writablePattern] of item.manifest.spec.scope.writable.entries()) {
      for (const protectedEntry of perDomainSuiteExtra) {
        const isBuiltIn = builtInProtectedSet.has(protectedEntry);
        if (writableOverlapsMandatoryProtected(writablePattern, protectedEntry, item.allowWorkflowWrites, isBuiltIn)) {
          suiteInvalid(
            `domain "${item.decl.id}" writable path "${writablePattern}" overlaps suite mandatory protected path "${protectedEntry}"`,
            `/spec/domains/${item.index}/scope/writable/${wIdx}`,
          );
        }
      }
    }

    const extraList = Object.freeze([...perDomainSuiteExtra]);
    const domainEffectiveProtected = effectiveProtectedPaths(item.manifest.spec.scope.protected, {
      policyProfile,
      controlRoot: item.controlRoot,
      manifestPath: item.decl.taskpack,
      digestsLockfile: item.manifest.spec.execution?.digests.lockfile,
      instructions: [
        ...(item.manifest.spec.instructions ?? []),
        ...(item.manifest.spec.roles ?? []).flatMap(r => r.instructions ?? []),
      ],
      skills: [
        ...(item.manifest.spec.skills ?? []),
        ...(item.manifest.spec.roles ?? []).flatMap(r => r.skills ?? []),
      ],
      preflightScript: item.manifest.spec.preflight?.script,
      proposalPath: ownCarvedProposal,
      extraProtectedPaths: extraList,
      allowWorkflowWrites: item.allowWorkflowWrites,
      githubSiblings,
    });

    if (domainEffectiveProtected.length > LIMITS.patterns) {
      suiteInvalid(
        `domain "${item.decl.id}" effective protected path union (${domainEffectiveProtected.length}) exceeds ${LIMITS.patterns} patterns`,
        `/spec/domains/${item.index}`,
      );
    }

    const augmentedManifest = cloneManifestWithAdditionalProtectedPaths(
      item.manifest,
      extraList,
      item.controlRoot,
      item.decl.taskpack,
    );

    loadedDomains.push(Object.freeze({
      id: item.decl.id,
      taskpackPath: item.decl.taskpack,
      taskpackName: augmentedManifest.metadata.name,
      controlRoot: item.controlRoot,
      manifestSha256: item.manifestSha256,
      enabled: item.decl.enabled,
      ...(item.decl.schedules !== undefined ? { schedules: item.decl.schedules } : {}),
      ...(item.decl.stage !== undefined ? { stage: item.decl.stage } : {}),
      ...(item.decl.matrix !== undefined ? { matrix: item.decl.matrix } : {}),
      manifest: augmentedManifest,
      protectedPaths: domainEffectiveProtected,
    }));
  }

  return Object.freeze({
    manifest: suiteManifest,
    suitePath,
    controlRoot: suiteControlRoot,
    suiteSha256,
    suiteProtectedPaths,
    stageOrder: computeTopologicalStageOrder(suiteManifest.spec.stages),
    domains: Object.freeze(loadedDomains),
  });
}

/** Alias for `loadTaskpackSuite` supporting optional `verifyDigests` check for CLI `suite check`. */
export async function checkTaskpackSuite(options: LoadTaskpackSuiteOptions): Promise<LoadedTaskpackSuite> {
  return loadTaskpackSuite(options);
}

/** Alias validating and loading a `TaskpackSuite` against `repositoryRoot`. */
export async function validateTaskpackSuite(options: LoadTaskpackSuiteOptions): Promise<LoadedTaskpackSuite> {
  return loadTaskpackSuite(options);
}

// ---------------------------------------------------------------------------
// Strictly Git-backed versionFrom reader & stateless stage readiness probes
// ---------------------------------------------------------------------------

function extractByRfc6901Pointer(root: unknown, pointer: string): string | undefined {
  const segments = validateRfc6901JsonPointer(pointer, '/jsonPointer');
  let current: unknown = root;
  for (const seg of segments) {
    if (Array.isArray(current)) {
      if (!/^(?:0|[1-9]\d*)$/.test(seg)) return undefined;
      const idx = Number.parseInt(seg, 10);
      if (!Number.isSafeInteger(idx) || idx < 0 || idx >= current.length) return undefined;
      current = current[idx];
    } else if (isPlainRecord(current)) {
      if (FORBIDDEN_KEYS.has(seg) || !Object.hasOwn(current, seg)) return undefined;
      current = current[seg];
    } else {
      return undefined;
    }
  }
  if (typeof current !== 'string') return undefined;
  if (/[\0\r\n]/.test(current)) {
    throw new TaskpackError('ACTION_INPUT_INVALID', `JSON Pointer "${pointer}" resolved to a multiline or NUL-containing string`);
  }
  const trimmed = current.trim();
  if (trimmed.length === 0 || trimmed.length > 256) return undefined;
  return trimmed;
}

async function readOptionalGitBlobBytes(
  repositoryRoot: string,
  resolvedSha: string,
  relPath: string,
  maxBytes: number,
  timeoutMs: number,
): Promise<Buffer | null> {
  const normalizedPath = normalizeRelativePath(relPath, '/baseline/path');
  const gitBin = resolveGitExecutable();
  const cleanEnv = buildCleanGitEnv();
  const { stdout: lsTreeOut } = await execFileAsync(
    gitBin,
    ['-C', repositoryRoot, '-c', 'core.hooksPath=/dev/null', 'ls-tree', '-z', resolvedSha, '--', normalizedPath],
    { env: cleanEnv, timeout: timeoutMs, maxBuffer: 65_536, encoding: 'utf8' },
  );
  const rows = lsTreeOut.split('\0').filter(Boolean);
  if (rows.length === 0) return null;
  if (rows.length !== 1) {
    throw new TaskpackError('ACTION_INPUT_INVALID', `unexpected git ls-tree entry count for "${normalizedPath}"`);
  }
  const match = /^([0-9]{6}) ([a-z]+) ([0-9a-f]{40}|[0-9a-f]{64})\t(.+)$/s.exec(rows[0]!);
  if (match === null || match[4] !== normalizedPath) {
    throw new TaskpackError('ACTION_INPUT_INVALID', `unexpected git ls-tree entry for "${normalizedPath}"`);
  }
  const mode = match[1]!;
  const objType = match[2]!;
  if (mode === '120000' || objType !== 'blob') {
    throw new TaskpackError(
      'TASKPACK_SCOPE_VIOLATION',
      `baseline path "${normalizedPath}" in commit ${resolvedSha} must be a regular blob (found mode=${mode} type=${objType})`,
    );
  }
  const { stdout: sizeOut } = await execFileAsync(
    gitBin,
    ['-C', repositoryRoot, '-c', 'core.hooksPath=/dev/null', 'cat-file', '-s', `${resolvedSha}:${normalizedPath}`],
    { env: cleanEnv, timeout: timeoutMs, maxBuffer: 4_096, encoding: 'utf8' },
  );
  const byteSize = Number.parseInt(sizeOut.trim(), 10);
  if (!Number.isSafeInteger(byteSize) || byteSize < 0 || byteSize > maxBytes) {
    throw new TaskpackError(
      'ACTION_INPUT_INVALID',
      `baseline blob "${normalizedPath}" (${byteSize} bytes) exceeds ${maxBytes} bytes`,
    );
  }
  const { stdout: blobBuf } = await execFileAsync(
    gitBin,
    ['-C', repositoryRoot, '-c', 'core.hooksPath=/dev/null', 'cat-file', '-p', `${resolvedSha}:${normalizedPath}`],
    { env: cleanEnv, timeout: timeoutMs, maxBuffer: maxBytes + 1_024, encoding: 'buffer' },
  );
  return blobBuf;
}

async function hasLocalGitCommit(
  repositoryRoot: string,
  sha: string,
  timeoutMs: number,
): Promise<boolean> {
  if (!existsSync(join(resolve(repositoryRoot), '.git'))) return false;
  try {
    const gitBin = resolveGitExecutable();
    const cleanEnv = buildCleanGitEnv();
    const { stdout } = await execFileAsync(
      gitBin,
      ['-C', repositoryRoot, '-c', 'core.hooksPath=/dev/null', 'cat-file', '-t', sha],
      { env: cleanEnv, timeout: timeoutMs, maxBuffer: 4_096, encoding: 'utf8' },
    );
    return stdout.trim() === 'commit';
  } catch {
    return false;
  }
}

interface RemoteGitDataCache {
  readonly commitTreeSha: Map<string, Promise<string>>;
  readonly treeDocs: Map<string, Promise<{ readonly entries: readonly Record<string, unknown>[]; readonly truncated: boolean }>>;
  readonly blobBytes: Map<string, Promise<Buffer>>;
  totalCachedBlobBytes: number;
}

const MAX_REMOTE_BLOB_CACHE_BYTES = 4 * 1024 * 1024;

async function fetchGitHubContentsBlobBytes(options: {
  readonly repositoryFullName: string;
  readonly resolvedSha: string;
  readonly relPath: string;
  readonly apiBaseUrl: string;
  readonly githubHeaders: Readonly<Record<string, string>>;
  readonly fetchImpl: typeof globalThis.fetch;
  readonly maxBytes: number;
  readonly timeoutMs: number;
  readonly optional: boolean;
  readonly cache?: RemoteGitDataCache | undefined;
}): Promise<Buffer | null> {
  const normalizedPath = normalizeRelativePath(options.relPath, '/baseline/path');
  const treeEnvelopeLimit = Math.max(MAX_SUITE_STAGE_VERSION_BLOB_BYTES * 4, 4 * 1024 * 1024);
  const blobEnvelopeLimit = Math.ceil((options.maxBytes * 4) / 3) + 65_536;

  // 1. Resolve commit -> root tree SHA via Git Data API so symlinks (mode 120000) are NEVER dereferenced.
  const loadCommitTreeSha = (): Promise<string> => {
    const cacheKey = `${options.repositoryFullName}\0${options.resolvedSha}`;
    const cached = options.cache?.commitTreeSha.get(cacheKey);
    if (cached !== undefined) return cached;
    const promise = (async (): Promise<string> => {
      const commitUrl = `${options.apiBaseUrl}/repos/${options.repositoryFullName}/git/commits/${encodeURIComponent(options.resolvedSha)}`;
      const commitRes = await fetchBoundedProbeResponse(
        commitUrl,
        options.fetchImpl,
        options.githubHeaders,
        options.timeoutMs,
        MAX_SUITE_STAGE_VERSION_BLOB_BYTES,
      );
      if (commitRes.status === 404) {
        throw new TaskpackError(
          'ACTION_INPUT_INVALID',
          `remote commit ${options.resolvedSha} does not exist in "${options.repositoryFullName}"`,
        );
      }
      if (!commitRes.ok) {
        throw new TaskpackError(
          'ACTION_INPUT_INVALID',
          `remote commit lookup for ${options.resolvedSha} failed with HTTP ${commitRes.status}`,
        );
      }
      let commitDoc: unknown;
      try {
        commitDoc = JSON.parse(commitRes.text) as unknown;
      } catch {
        throw new TaskpackError('ACTION_INPUT_INVALID', `remote commit lookup for ${options.resolvedSha} returned invalid JSON`);
      }
      const rootTreeObj = isPlainRecord(commitDoc) && isPlainRecord(commitDoc['tree']) ? commitDoc['tree'] : null;
      const rootTreeSha = typeof rootTreeObj?.['sha'] === 'string' && /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i.test(rootTreeObj['sha'])
        ? rootTreeObj['sha'].toLowerCase()
        : null;
      if (rootTreeSha === null) {
        throw new TaskpackError('ACTION_INPUT_INVALID', `remote commit ${options.resolvedSha} response lacks a valid tree SHA`);
      }
      return rootTreeSha;
    })();
    options.cache?.commitTreeSha.set(cacheKey, promise);
    return promise;
  };
  const rootTreeSha = await loadCommitTreeSha();

  const loadTreeDoc = (treeSha: string): Promise<{ readonly entries: readonly Record<string, unknown>[]; readonly truncated: boolean }> => {
    const cacheKey = `${options.repositoryFullName}\0${treeSha}`;
    const cached = options.cache?.treeDocs.get(cacheKey);
    if (cached !== undefined) return cached;
    const promise = (async (): Promise<{ readonly entries: readonly Record<string, unknown>[]; readonly truncated: boolean }> => {
      const treeUrl = `${options.apiBaseUrl}/repos/${options.repositoryFullName}/git/trees/${encodeURIComponent(treeSha)}`;
      const treeRes = await fetchBoundedProbeResponse(
        treeUrl,
        options.fetchImpl,
        options.githubHeaders,
        options.timeoutMs,
        treeEnvelopeLimit,
      );
      if (!treeRes.ok) {
        throw new TaskpackError(
          'ACTION_INPUT_INVALID',
          `remote tree lookup for ${treeSha} failed with HTTP ${treeRes.status}`,
        );
      }
      let treeDoc: unknown;
      try {
        treeDoc = JSON.parse(treeRes.text) as unknown;
      } catch {
        throw new TaskpackError('ACTION_INPUT_INVALID', `remote tree lookup for ${treeSha} returned invalid JSON`);
      }
      if (!isPlainRecord(treeDoc) || !Array.isArray(treeDoc['tree'])) {
        throw new TaskpackError('ACTION_INPUT_INVALID', `remote tree ${treeSha} response lacks a tree array`);
      }
      const entries: Record<string, unknown>[] = [];
      for (const rawEntry of treeDoc['tree']) {
        if (isPlainRecord(rawEntry)) entries.push(rawEntry);
      }
      return { entries, truncated: treeDoc['truncated'] === true };
    })();
    options.cache?.treeDocs.set(cacheKey, promise);
    return promise;
  };

  // 2. Walk every literal path segment through pinned Git trees, requiring 040000 dirs and 100644/100755 leaf blob.
  const segments = normalizedPath.split('/');
  let currentTreeSha = rootTreeSha;
  let leafBlobSha: string | null = null;
  for (let i = 0; i < segments.length; i += 1) {
    const seg = segments[i]!;
    const isLeaf = i === segments.length - 1;
    const treeDoc = await loadTreeDoc(currentTreeSha);
    let matchedEntry: Record<string, unknown> | null = null;
    for (const rawEntry of treeDoc.entries) {
      if (rawEntry['path'] === seg) {
        matchedEntry = rawEntry;
        break;
      }
    }
    if (matchedEntry === null) {
      if (treeDoc.truncated) {
        throw new TaskpackError(
          'ACTION_INPUT_INVALID',
          `remote tree ${currentTreeSha} was truncated while resolving "${normalizedPath}"`,
        );
      }
      if (options.optional) return null;
      throw new TaskpackError(
        'ACTION_INPUT_INVALID',
        `path "${normalizedPath}" does not exist in remote commit ${options.resolvedSha}`,
      );
    }
    const mode = typeof matchedEntry['mode'] === 'string' ? matchedEntry['mode'] : '';
    const entryType = typeof matchedEntry['type'] === 'string' ? matchedEntry['type'] : '';
    const entrySha = typeof matchedEntry['sha'] === 'string' && /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i.test(matchedEntry['sha'])
      ? matchedEntry['sha'].toLowerCase()
      : null;
    if (entrySha === null) {
      throw new TaskpackError('ACTION_INPUT_INVALID', `remote tree entry "${seg}" lacks a valid SHA`);
    }
    if (!isLeaf) {
      if (mode !== '040000' || entryType !== 'tree') {
        throw new TaskpackError(
          'TASKPACK_SCOPE_VIOLATION',
          `remote path "${normalizedPath}" traverses non-tree segment "${seg}" (mode=${mode} type=${entryType})`,
        );
      }
      currentTreeSha = entrySha;
    } else {
      if ((mode !== '100644' && mode !== '100755') || entryType !== 'blob') {
        throw new TaskpackError(
          'TASKPACK_SCOPE_VIOLATION',
          `remote path "${normalizedPath}" at ${options.resolvedSha} must be a regular blob (found mode=${mode} type=${entryType})`,
        );
      }
      if (typeof matchedEntry['size'] === 'number' && matchedEntry['size'] > options.maxBytes) {
        throw new TaskpackError(
          'ACTION_INPUT_INVALID',
          `remote blob "${normalizedPath}" (${matchedEntry['size']} bytes) exceeds ${options.maxBytes} bytes`,
        );
      }
      leafBlobSha = entrySha;
    }
  }

  if (leafBlobSha === null) return null;

  const blobCacheKey = `${options.repositoryFullName}\0${leafBlobSha}`;
  const cachedBlobPromise = options.cache?.blobBytes.get(blobCacheKey);
  if (cachedBlobPromise !== undefined) {
    const cachedBytes = await cachedBlobPromise;
    if (cachedBytes.byteLength > options.maxBytes) {
      throw new TaskpackError(
        'ACTION_INPUT_INVALID',
        `remote blob "${normalizedPath}" (${cachedBytes.byteLength} bytes) exceeds ${options.maxBytes} bytes`,
      );
    }
    return cachedBytes;
  }

  // 3. Fetch the exact blob by object ID with transport cap sized for base64 JSON envelope,
  //    then enforce maxBytes on the decoded bytes and verify the Git blob SHA-1.
  const fetchBlobPromise = (async (): Promise<Buffer> => {
    const blobUrl = `${options.apiBaseUrl}/repos/${options.repositoryFullName}/git/blobs/${encodeURIComponent(leafBlobSha)}`;
    const blobRes = await fetchBoundedProbeResponse(
      blobUrl,
      options.fetchImpl,
      options.githubHeaders,
      options.timeoutMs,
      blobEnvelopeLimit,
    );
    if (!blobRes.ok) {
      throw new TaskpackError(
        'ACTION_INPUT_INVALID',
        `remote blob lookup for "${normalizedPath}" (${leafBlobSha}) failed with HTTP ${blobRes.status}`,
      );
    }
    let blobDoc: unknown;
    try {
      blobDoc = JSON.parse(blobRes.text) as unknown;
    } catch {
      throw new TaskpackError('ACTION_INPUT_INVALID', `remote blob lookup for "${normalizedPath}" returned invalid JSON`);
    }
    if (!isPlainRecord(blobDoc)) {
      throw new TaskpackError('ACTION_INPUT_INVALID', `remote blob response for "${normalizedPath}" must be an object`);
    }
    if (typeof blobDoc['size'] === 'number' && blobDoc['size'] > options.maxBytes) {
      throw new TaskpackError(
        'ACTION_INPUT_INVALID',
        `remote blob "${normalizedPath}" (${blobDoc['size']} bytes) exceeds ${options.maxBytes} bytes`,
      );
    }
    if (blobDoc['encoding'] !== 'base64' || typeof blobDoc['content'] !== 'string') {
      throw new TaskpackError('ACTION_INPUT_INVALID', `remote blob "${normalizedPath}" lacks base64 content`);
    }
    const bytes = Buffer.from(blobDoc['content'].replace(/\s+/g, ''), 'base64');
    if (bytes.byteLength > options.maxBytes) {
      throw new TaskpackError(
        'ACTION_INPUT_INVALID',
        `remote blob "${normalizedPath}" (${bytes.byteLength} bytes) exceeds ${options.maxBytes} bytes`,
      );
    }
    const hashAlgo = leafBlobSha.length === 64 ? 'sha256' : 'sha1';
    const actualGitBlobSha = createHash(hashAlgo).update(`blob ${bytes.byteLength}\0`).update(bytes).digest('hex');
    if (actualGitBlobSha !== leafBlobSha) {
      throw new TaskpackError(
        'ACTION_INPUT_INVALID',
        `remote blob "${normalizedPath}" ${hashAlgo.toUpperCase()} mismatch (expected ${leafBlobSha}, got ${actualGitBlobSha})`,
      );
    }
    return bytes;
  })();

  const bytes = await fetchBlobPromise;
  if (
    options.cache !== undefined
    && options.cache.totalCachedBlobBytes + bytes.byteLength <= MAX_REMOTE_BLOB_CACHE_BYTES
  ) {
    options.cache.totalCachedBlobBytes += bytes.byteLength;
    options.cache.blobBytes.set(blobCacheKey, Promise.resolve(bytes));
  }
  return bytes;
}

function parseVersionFromBlobBytes(
  blobBuf: Buffer,
  normalizedPath: string,
  selector: SuiteVersionFromSelector,
): string {
  if (blobBuf.byteLength > MAX_SUITE_STAGE_VERSION_BLOB_BYTES) {
    throw new TaskpackError(
      'ACTION_INPUT_INVALID',
      `versionFrom blob "${normalizedPath}" exceeds ${MAX_SUITE_STAGE_VERSION_BLOB_BYTES} bytes`,
    );
  }

  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(blobBuf);
  } catch {
    throw new TaskpackError('ACTION_INPUT_INVALID', `versionFrom blob "${normalizedPath}" is not valid UTF-8`);
  }

  if (selector.jsonPointer !== undefined) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(text) as unknown;
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new TaskpackError('ACTION_INPUT_INVALID', `versionFrom "${normalizedPath}" is not valid JSON: ${detail}`);
    }
    const extracted = extractByRfc6901Pointer(parsed, selector.jsonPointer);
    if (extracted === undefined) {
      throw new TaskpackError(
        'ACTION_INPUT_INVALID',
        `versionFrom pointer "${selector.jsonPointer}" did not resolve to a non-empty string in "${normalizedPath}"`,
      );
    }
    return extracted;
  }

  if (normalizedPath.toLowerCase().endsWith('.json')) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(text) as unknown;
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new TaskpackError('ACTION_INPUT_INVALID', `versionFrom "${normalizedPath}" is not valid JSON: ${detail}`);
    }
    if (typeof parsed === 'string' && !/[\0\r\n]/.test(parsed) && parsed.trim().length > 0 && parsed.trim().length <= 256) {
      return parsed.trim();
    }
    if (
      isPlainRecord(parsed)
      && Object.hasOwn(parsed, 'version')
      && typeof parsed['version'] === 'string'
      && !/[\0\r\n]/.test(parsed['version'])
      && parsed['version'].trim().length > 0
      && parsed['version'].trim().length <= 256
    ) {
      return parsed['version'].trim();
    }
    throw new TaskpackError('ACTION_INPUT_INVALID', `versionFrom "${normalizedPath}" lacks a valid top-level "version" string`);
  }

  const trimmed = text.trim();
  if (trimmed.length === 0 || trimmed.length > 256 || /[\0\r\n]/.test(trimmed)) {
    throw new TaskpackError(
      'ACTION_INPUT_INVALID',
      `versionFrom "${normalizedPath}" must contain a single-line string of 1..256 characters`,
    );
  }
  return trimmed;
}

/**
 * Read a `versionFrom` string strictly from `baseRevision` in Git (`git cat-file -p <sha>:<path>`,
 * capped at `<= 1 MiB` UTF-8, refusing symlinks/trees and never reading the working tree on disk).
 */
export async function readGitRevisionVersionFrom(options: {
  readonly repositoryRoot: string;
  readonly baseRevision: string;
  readonly selector: SuiteVersionFromSelector;
  readonly timeoutMs?: number | undefined;
}): Promise<string> {
  const timeoutMs = options.timeoutMs ?? 15_000;
  const normalizedPath = normalizeRelativePath(options.selector.path, '/versionFrom/path');
  const resolvedSha = await resolveGitCommitSha(options.repositoryRoot, options.baseRevision, timeoutMs);
  const gitBin = resolveGitExecutable();
  const cleanEnv = buildCleanGitEnv();

  const { stdout: lsTreeOut } = await execFileAsync(
    gitBin,
    ['-C', options.repositoryRoot, '-c', 'core.hooksPath=/dev/null', 'ls-tree', '-z', resolvedSha, '--', normalizedPath],
    { env: cleanEnv, timeout: timeoutMs, maxBuffer: 65_536, encoding: 'utf8' },
  );
  const rows = lsTreeOut.split('\0').filter(Boolean);
  if (rows.length !== 1) {
    throw new TaskpackError(
      'ACTION_INPUT_INVALID',
      `versionFrom path "${normalizedPath}" does not exist in commit ${resolvedSha}`,
    );
  }
  const match = /^([0-9]{6}) ([a-z]+) ([0-9a-f]{40}|[0-9a-f]{64})\t(.+)$/s.exec(rows[0]!);
  if (match === null || match[4] !== normalizedPath) {
    throw new TaskpackError('ACTION_INPUT_INVALID', `unexpected git ls-tree entry for "${normalizedPath}"`);
  }
  const mode = match[1]!;
  const objType = match[2]!;
  if (mode === '120000' || objType !== 'blob') {
    throw new TaskpackError(
      'TASKPACK_SCOPE_VIOLATION',
      `versionFrom path "${normalizedPath}" in commit ${resolvedSha} must be a regular blob (found mode=${mode} type=${objType})`,
    );
  }

  const { stdout: sizeOut } = await execFileAsync(
    gitBin,
    ['-C', options.repositoryRoot, '-c', 'core.hooksPath=/dev/null', 'cat-file', '-s', `${resolvedSha}:${normalizedPath}`],
    { env: cleanEnv, timeout: timeoutMs, maxBuffer: 4_096, encoding: 'utf8' },
  );
  const byteSize = Number.parseInt(sizeOut.trim(), 10);
  if (!Number.isSafeInteger(byteSize) || byteSize < 0 || byteSize > MAX_SUITE_STAGE_VERSION_BLOB_BYTES) {
    throw new TaskpackError(
      'ACTION_INPUT_INVALID',
      `versionFrom blob "${normalizedPath}" (${byteSize} bytes) exceeds ${MAX_SUITE_STAGE_VERSION_BLOB_BYTES} bytes`,
    );
  }

  const { stdout: blobBuf } = await execFileAsync(
    gitBin,
    ['-C', options.repositoryRoot, '-c', 'core.hooksPath=/dev/null', 'cat-file', '-p', `${resolvedSha}:${normalizedPath}`],
    {
      env: cleanEnv,
      timeout: timeoutMs,
      maxBuffer: MAX_SUITE_STAGE_VERSION_BLOB_BYTES + 1_024,
      encoding: 'buffer',
    },
  );
  return parseVersionFromBlobBytes(blobBuf, normalizedPath, options.selector);
}

function versionMatchesTag(observedTag: string, expectedVersion: string, explicitTagPrefix: string | undefined): boolean {
  if (observedTag === expectedVersion) return true;
  if (explicitTagPrefix === undefined && STRICT_SEMVER_CORE_PATTERN.test(expectedVersion) && observedTag === `v${expectedVersion}`) {
    return true;
  }
  return false;
}

async function buildProbeAuthHeaders(
  githubToken: UpstreamTokenResolver | undefined,
  authHeaders: UpstreamHeadersResolver | undefined,
  baseHeaders: Readonly<Record<string, string>>,
  scrubber: SecretScrubber,
): Promise<Record<string, string>> {
  const headers: Record<string, string> = { ...baseHeaders };
  const resolvedExtra = typeof authHeaders === 'function' ? await authHeaders() : authHeaders;
  if (resolvedExtra !== undefined) {
    for (const [key, value] of Object.entries(resolvedExtra)) {
      headers[key] = value;
      const lower = key.toLowerCase();
      if (lower === 'authorization' || lower === 'x-api-key' || lower === 'api-key') {
        scrubber.register(value);
        const bearerMatch = /^Bearer\s+(.+)$/i.exec(value);
        if (bearerMatch?.[1]) scrubber.register(bearerMatch[1].trim());
      }
    }
  }
  const resolvedToken = (typeof githubToken === 'function' ? await githubToken() : githubToken)?.trim();
  if (resolvedToken !== undefined && resolvedToken.length > 0) {
    scrubber.register(resolvedToken);
    if (!Object.keys(headers).some(k => k.toLowerCase() === 'authorization')) {
      headers['authorization'] = `Bearer ${resolvedToken}`;
    }
  }
  return headers;
}

export interface SuiteReadinessProbeRunnerInput {
  readonly stageId: string;
  readonly probeIndex: number;
  readonly probe: SuiteStageReadinessProbe;
  readonly expectedVersion?: string | undefined;
  readonly repositoryRoot: string;
  readonly baseRevision: string;
  readonly scrubber: SecretScrubber;
}

export interface SuiteReadinessProbeRunnerResult {
  readonly disposition: 'eligible' | 'deferred' | 'blocked';
  readonly observedVersion?: string | undefined;
  readonly reason: string;
  readonly detail?: string | undefined;
}

const MAX_PROBE_API_PAGES = 10;

function extractSameOriginNextLink(linkHeader: string | null, initialUrl: string): {
  readonly hasLinkHeader: boolean;
  readonly nextUrl?: string | undefined;
  readonly crossOriginError?: string | undefined;
} {
  if (linkHeader === null || linkHeader.trim().length === 0) {
    return { hasLinkHeader: false };
  }
  const initialOrigin = new URL(initialUrl).origin;
  for (const segment of linkHeader.split(',')) {
    const match = /<([^>\r\n]+)>\s*;\s*rel="?next"?(?:\s*;|\s*$)/i.exec(segment.trim());
    if (match?.[1] !== undefined) {
      let parsed: URL;
      try {
        parsed = new URL(match[1]);
      } catch {
        return { hasLinkHeader: true, crossOriginError: `invalid pagination Link URL "${match[1]}"` };
      }
      if (parsed.origin !== initialOrigin) {
        return { hasLinkHeader: true, crossOriginError: `refusing cross-origin pagination Link "${parsed.origin}"` };
      }
      return { hasLinkHeader: true, nextUrl: parsed.toString() };
    }
  }
  return { hasLinkHeader: true };
}

async function fetchBoundedProbeResponse(
  url: string,
  fetchImpl: typeof globalThis.fetch,
  headers: Readonly<Record<string, string>>,
  timeoutMs: number,
  maxResponseBytes: number = MAX_SUITE_STAGE_VERSION_BLOB_BYTES,
): Promise<{
  readonly status: number;
  readonly ok: boolean;
  readonly text: string;
  readonly linkHeader: string | null;
}> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error(`probe request timed out after ${timeoutMs}ms`)), timeoutMs);
  timer.unref?.();
  try {
    const response = await fetchImpl(url, {
      method: 'GET',
      headers,
      redirect: 'error',
      signal: controller.signal,
    });
    const contentLengthHeader = response.headers.get('content-length');
    if (contentLengthHeader !== null) {
      const declared = Number.parseInt(contentLengthHeader, 10);
      if (Number.isFinite(declared) && declared > maxResponseBytes) {
        await response.body?.cancel().catch(() => {});
        throw new Error(`probe response declared content-length ${declared} > ${maxResponseBytes}`);
      }
    }
    const linkHeader = response.headers.get('link');
    if (response.body === null) {
      return { status: response.status, ok: response.ok, text: '', linkHeader };
    }
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxResponseBytes) {
        await reader.cancel().catch(() => {});
        throw new Error(`probe response exceeded ${maxResponseBytes} bytes`);
      }
      chunks.push(value);
    }
    const merged = Buffer.concat(chunks, total);
    const text = new TextDecoder('utf-8', { fatal: true }).decode(merged);
    return { status: response.status, ok: response.ok, text, linkHeader };
  } finally {
    clearTimeout(timer);
  }
}

async function fetchProbeJsonPage(
  label: string,
  url: string,
  initialUrl: string,
  fetchImpl: typeof globalThis.fetch,
  headers: Readonly<Record<string, string>>,
  timeoutMs: number,
  scrubber: SecretScrubber,
): Promise<
  | {
    readonly kind: 'ok';
    readonly data: unknown;
    readonly hasLinkHeader: boolean;
    readonly nextUrl?: string | undefined;
  }
  | { readonly kind: 'result'; readonly outcome: SuiteReadinessProbeRunnerResult }
> {
  const res = await fetchBoundedProbeResponse(url, fetchImpl, headers, timeoutMs);
  if (res.status === 404) {
    return {
      kind: 'result',
      outcome: {
        disposition: 'deferred',
        reason: 'stage_not_ready',
        detail: scrubber.scrub(`${label} returned 404`),
      },
    };
  }
  if (!res.ok) {
    return {
      kind: 'result',
      outcome: {
        disposition: 'blocked',
        reason: 'probe_failed',
        detail: scrubber.scrub(`${label} failed with HTTP ${res.status}: ${res.text.slice(0, 256)}`),
      },
    };
  }
  const linkInfo = extractSameOriginNextLink(res.linkHeader, initialUrl);
  if (linkInfo.crossOriginError !== undefined) {
    return {
      kind: 'result',
      outcome: {
        disposition: 'blocked',
        reason: 'probe_failed',
        detail: scrubber.scrub(`${label}: ${linkInfo.crossOriginError}`),
      },
    };
  }
  try {
    return {
      kind: 'ok',
      data: JSON.parse(res.text) as unknown,
      hasLinkHeader: linkInfo.hasLinkHeader,
      nextUrl: linkInfo.nextUrl,
    };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return {
      kind: 'result',
      outcome: {
        disposition: 'blocked',
        reason: 'probe_invalid_json',
        detail: scrubber.scrub(`${label} returned invalid JSON: ${detail}`),
      },
    };
  }
}

function extractCandidateReleaseTag(item: unknown, allowPrerelease: boolean | undefined): string | undefined {
  if (!isPlainRecord(item) || item['draft'] === true) return undefined;
  if (allowPrerelease !== true && item['prerelease'] === true) return undefined;
  const tag = typeof item['tag_name'] === 'string' && item['tag_name'].length > 0
    ? item['tag_name']
    : (typeof item['name'] === 'string' && item['name'].length > 0 ? item['name'] : undefined);
  if (tag === undefined) return undefined;
  if (allowPrerelease === false && isPrereleaseVersionTag(tag)) return undefined;
  return tag;
}

async function runDefaultReadinessProbe(
  input: SuiteReadinessProbeRunnerInput,
  context: {
    readonly apiBaseUrl: string;
    readonly githubHeaders: Readonly<Record<string, string>>;
    readonly fetchImpl: typeof globalThis.fetch;
    readonly timeoutMs: number;
    readonly allowLoopbackHttp: boolean;
    readonly policyProfile: PolicyProfile;
  },
): Promise<SuiteReadinessProbeRunnerResult> {
  const { probe, expectedVersion, repositoryRoot, scrubber } = input;
  const { apiBaseUrl, githubHeaders, fetchImpl, timeoutMs, allowLoopbackHttp, policyProfile } = context;

  const assertSafeLocalGitProbeSource = async (rawSource: string): Promise<string> => {
    const resolvedSource = resolve(repositoryRoot, rawSource);
    if (policyProfile === 'github') {
      const realRepo = await realpath(resolve(repositoryRoot));
      const realSource = await realpath(resolvedSource);
      if (!isContainedInRoot(realSource, realRepo)) {
        throw new TaskpackError(
          'TASKPACK_SCOPE_VIOLATION',
          `local git probe source "${rawSource}" escapes repository root under github policy profile`,
        );
      }
    }
    return resolvedSource;
  };

  try {
    switch (probe.kind) {
      case 'github-release': {
        const perPage = 30;
        const initialUrl = probe.allowPrerelease === true
          ? `${apiBaseUrl}/repos/${probe.source}/releases?per_page=${perPage}`
          : `${apiBaseUrl}/repos/${probe.source}/releases/latest`;
        let currentUrl = initialUrl;
        let firstObserved: string | undefined;
        let confirmedAbsence = false;

        for (let page = 1; page <= MAX_PROBE_API_PAGES; page += 1) {
          const fetched = await fetchProbeJsonPage(
            `github-release "${probe.source}"`,
            currentUrl,
            initialUrl,
            fetchImpl,
            githubHeaders,
            timeoutMs,
            scrubber,
          );
          if (fetched.kind === 'result') return fetched.outcome;
          const data = fetched.data;

          const pageTags: string[] = [];
          if (Array.isArray(data)) {
            for (const item of data) {
              const tag = extractCandidateReleaseTag(item, probe.allowPrerelease);
              if (tag !== undefined) pageTags.push(tag);
            }
          } else if (isPlainRecord(data)) {
            const tag = extractCandidateReleaseTag(data, probe.allowPrerelease);
            if (tag !== undefined) pageTags.push(tag);
          } else {
            return {
              disposition: 'blocked',
              reason: 'probe_invalid_json',
              detail: scrubber.scrub(`github-release "${probe.source}" payload must be a JSON object or array`),
            };
          }

          if (firstObserved === undefined && pageTags.length > 0) {
            firstObserved = pageTags[0];
          }
          if (expectedVersion !== undefined) {
            const matched = pageTags.find(tag => versionMatchesTag(tag, expectedVersion, probe.tagPrefix));
            if (matched !== undefined) {
              return {
                disposition: 'eligible',
                observedVersion: scrubber.scrub(matched),
                reason: 'probe_ready',
              };
            }
          } else if (pageTags.length > 0) {
            return {
              disposition: 'eligible',
              observedVersion: scrubber.scrub(pageTags[0]!),
              reason: 'probe_ready',
            };
          }

          const hasMore = Array.isArray(data) && (
            fetched.nextUrl !== undefined
            || (!fetched.hasLinkHeader && data.length >= perPage)
          );
          if (!hasMore) {
            confirmedAbsence = true;
            break;
          }
          currentUrl = fetched.nextUrl ?? `${apiBaseUrl}/repos/${probe.source}/releases?per_page=${perPage}&page=${page + 1}`;
        }

        if (!confirmedAbsence) {
          return {
            disposition: 'blocked',
            ...(firstObserved !== undefined ? { observedVersion: scrubber.scrub(firstObserved) } : {}),
            reason: 'probe_pagination_exhausted',
            detail: scrubber.scrub(
              `github-release "${probe.source}" exhausted ${MAX_PROBE_API_PAGES} pages without confirming release absence`,
            ),
          };
        }
        if (firstObserved === undefined) {
          return {
            disposition: 'deferred',
            reason: 'stage_not_ready',
            detail: scrubber.scrub(`github-release "${probe.source}" has no published matching release`),
          };
        }
        return {
          disposition: 'deferred',
          observedVersion: scrubber.scrub(firstObserved),
          reason: 'stage_not_ready',
          detail: scrubber.scrub(`github-release "${probe.source}" observed "${firstObserved}", expected "${expectedVersion ?? ''}"`),
        };
      }

      case 'http-json': {
        try {
          validateSuiteHttpSourceUrl(probe.source, '/readiness/source', allowLoopbackHttp);
        } catch (error) {
          const detail = error instanceof Error ? error.message : String(error);
          return {
            disposition: 'blocked',
            reason: 'probe_url_disallowed',
            detail: scrubber.scrub(detail),
          };
        }
        const fetched = await fetchProbeJsonPage(
          `http-json "${probe.source}"`,
          probe.source,
          probe.source,
          fetchImpl,
          { accept: 'application/json', 'user-agent': 'loopwright-taskpack' },
          timeoutMs,
          scrubber,
        );
        if (fetched.kind === 'result') return fetched.outcome;
        const data = fetched.data;

        let observed: string | undefined;
        if (probe.jsonPointer !== undefined) {
          observed = extractByRfc6901Pointer(data, probe.jsonPointer);
        } else if (probe.versionPath !== undefined) {
          observed = extractJsonVersionPath(data, probe.versionPath);
        } else if (isPlainRecord(data)) {
          for (const key of ['version', 'tag_name', 'latest', 'sha'] as const) {
            const val = data[key];
            if (typeof val === 'string' && !/[\0\r\n]/.test(val) && val.trim().length > 0 && val.trim().length <= 256) {
              observed = val.trim();
              break;
            }
          }
        }

        if (observed === undefined) {
          return {
            disposition: 'deferred',
            reason: 'stage_not_ready',
            detail: scrubber.scrub(`http-json "${probe.source}" did not contain an active version string`),
          };
        }
        if (expectedVersion !== undefined && observed !== expectedVersion) {
          return {
            disposition: 'deferred',
            observedVersion: scrubber.scrub(observed),
            reason: 'stage_not_ready',
            detail: scrubber.scrub(`http-json "${probe.source}" observed "${observed}", expected "${expectedVersion}"`),
          };
        }
        return {
          disposition: 'eligible',
          observedVersion: scrubber.scrub(observed),
          reason: 'probe_ready',
        };
      }

      case 'git-tag': {
        const targetTag = expectedVersion ?? probe.ref;
        if (REPOSITORY_FULL_NAME_PATTERN.test(probe.source)) {
          const perPage = 100;
          const initialUrl = `${apiBaseUrl}/repos/${probe.source}/tags?per_page=${perPage}`;
          let currentUrl = initialUrl;
          let confirmedAbsence = false;

          for (let page = 1; page <= MAX_PROBE_API_PAGES; page += 1) {
            const fetched = await fetchProbeJsonPage(
              `git-tag "${probe.source}"`,
              currentUrl,
              initialUrl,
              fetchImpl,
              githubHeaders,
              timeoutMs,
              scrubber,
            );
            if (fetched.kind === 'result') return fetched.outcome;
            if (!Array.isArray(fetched.data)) {
              return {
                disposition: 'blocked',
                reason: 'probe_invalid_json',
                detail: scrubber.scrub(`git-tag "${probe.source}" payload must be an array`),
              };
            }
            let pageTags: string[] = [];
            for (const item of fetched.data) {
              if (isPlainRecord(item) && typeof item['name'] === 'string' && item['name'].length > 0) {
                pageTags.push(item['name']);
              }
            }
            if (probe.allowPrerelease === false) {
              pageTags = pageTags.filter(t => !isPrereleaseVersionTag(t));
            }
            if (targetTag !== undefined) {
              const matched = pageTags.find(tag => versionMatchesTag(tag, targetTag, probe.tagPrefix));
              if (matched !== undefined) {
                return {
                  disposition: 'eligible',
                  observedVersion: scrubber.scrub(matched),
                  reason: 'probe_ready',
                };
              }
            } else if (pageTags.length > 0) {
              return {
                disposition: 'eligible',
                observedVersion: scrubber.scrub(pageTags[0]!),
                reason: 'probe_ready',
              };
            }

            const hasMore = fetched.nextUrl !== undefined || (!fetched.hasLinkHeader && fetched.data.length >= perPage);
            if (!hasMore) {
              confirmedAbsence = true;
              break;
            }
            currentUrl = fetched.nextUrl ?? `${apiBaseUrl}/repos/${probe.source}/tags?per_page=${perPage}&page=${page + 1}`;
          }

          if (!confirmedAbsence) {
            return {
              disposition: 'blocked',
              reason: 'probe_pagination_exhausted',
              detail: scrubber.scrub(
                `git-tag "${probe.source}" exhausted ${MAX_PROBE_API_PAGES} pages without confirming tag absence`,
              ),
            };
          }
          return {
            disposition: 'deferred',
            reason: 'stage_not_ready',
            detail: scrubber.scrub(
              targetTag !== undefined
                ? `git-tag "${targetTag}" is not present on "${probe.source}"`
                : `no git tags found on "${probe.source}"`,
            ),
          };
        }

        const sourceKind = validateGitRemoteSource(probe.source, repositoryRoot);
        const gitSource = sourceKind === 'local-dir'
          ? await assertSafeLocalGitProbeSource(probe.source)
          : probe.source;
        const gitBin = resolveGitExecutable();
        const protocolArgs = sourceKind === 'local-dir'
          ? ['-c', 'protocol.file.allow=always', '-c', 'protocol.ext.allow=never', '-c', 'protocol.ssh.allow=never']
          : ['-c', 'protocol.ext.allow=never', '-c', 'protocol.ssh.allow=never'];
        const { stdout } = await execFileAsync(
          gitBin,
          [...protocolArgs, 'ls-remote', '--tags', '--refs', '--', gitSource],
          { env: buildCleanGitEnv(), timeout: timeoutMs, maxBuffer: MAX_SUITE_STAGE_VERSION_BLOB_BYTES, encoding: 'utf8' },
        );
        let tags = stdout
          .split(/\r?\n/)
          .map(line => line.trim())
          .filter(Boolean)
          .map(line => {
            const tab = line.indexOf('\t');
            return (tab >= 0 ? line.slice(tab + 1) : line).replace(/^refs\/tags\//, '');
          })
          .filter(Boolean);

        if (probe.allowPrerelease === false) {
          tags = tags.filter(t => !isPrereleaseVersionTag(t));
        }
        if (targetTag !== undefined) {
          const matched = tags.find(tag => versionMatchesTag(tag, targetTag, probe.tagPrefix));
          if (matched === undefined) {
            return {
              disposition: 'deferred',
              reason: 'stage_not_ready',
              detail: scrubber.scrub(`git-tag "${targetTag}" is not present on "${probe.source}"`),
            };
          }
          return {
            disposition: 'eligible',
            observedVersion: scrubber.scrub(matched),
            reason: 'probe_ready',
          };
        }
        if (tags.length === 0) {
          return {
            disposition: 'deferred',
            reason: 'stage_not_ready',
            detail: scrubber.scrub(`no git tags found on "${probe.source}"`),
          };
        }
        return {
          disposition: 'eligible',
          observedVersion: scrubber.scrub(tags[0]!),
          reason: 'probe_ready',
        };
      }

      case 'git-commit': {
        if (REPOSITORY_FULL_NAME_PATTERN.test(probe.source)) {
          if (probe.ref !== undefined && expectedVersion !== undefined) {
            const compareUrl = `${apiBaseUrl}/repos/${probe.source}/compare/${encodeURIComponent(expectedVersion)}...${encodeURIComponent(probe.ref)}`;
            const fetched = await fetchProbeJsonPage(
              `git-commit "${probe.source}"`,
              compareUrl,
              compareUrl,
              fetchImpl,
              githubHeaders,
              timeoutMs,
              scrubber,
            );
            if (fetched.kind === 'result') return fetched.outcome;
            if (!isPlainRecord(fetched.data) || typeof fetched.data['status'] !== 'string') {
              return {
                disposition: 'blocked',
                reason: 'probe_invalid_json',
                detail: scrubber.scrub(`git-commit compare "${probe.source}" payload lacked status string`),
              };
            }
            const cmpStatus = fetched.data['status'];
            const mergeBase = isPlainRecord(fetched.data['merge_base_commit']) && typeof fetched.data['merge_base_commit']['sha'] === 'string'
              ? fetched.data['merge_base_commit']['sha']
              : undefined;
            if (cmpStatus === 'ahead' || cmpStatus === 'identical') {
              return {
                disposition: 'eligible',
                observedVersion: scrubber.scrub(mergeBase ?? expectedVersion),
                reason: 'probe_ready',
              };
            }
            if (cmpStatus === 'behind' || cmpStatus === 'diverged') {
              return {
                disposition: 'deferred',
                ...(mergeBase !== undefined ? { observedVersion: scrubber.scrub(mergeBase) } : {}),
                reason: 'stage_not_ready',
                detail: scrubber.scrub(
                  `git-commit "${expectedVersion}" is not an ancestor of "${probe.ref}" on "${probe.source}" (status=${cmpStatus})`,
                ),
              };
            }
            return {
              disposition: 'blocked',
              reason: 'probe_invalid_json',
              detail: scrubber.scrub(`git-commit compare "${probe.source}" returned unexpected status "${cmpStatus}"`),
            };
          }

          const url = probe.ref !== undefined
            ? `${apiBaseUrl}/repos/${probe.source}/commits?sha=${encodeURIComponent(probe.ref)}&per_page=1`
            : expectedVersion !== undefined
              ? `${apiBaseUrl}/repos/${probe.source}/commits/${encodeURIComponent(expectedVersion)}`
              : `${apiBaseUrl}/repos/${probe.source}/commits?per_page=1`;
          const fetched = await fetchProbeJsonPage(
            `git-commit "${probe.source}"`,
            url,
            url,
            fetchImpl,
            githubHeaders,
            timeoutMs,
            scrubber,
          );
          if (fetched.kind === 'result') return fetched.outcome;
          let sha: string | undefined;
          if (Array.isArray(fetched.data)) {
            if (fetched.data.length === 0) {
              return {
                disposition: 'deferred',
                reason: 'stage_not_ready',
                detail: scrubber.scrub(`git-commit returned empty commit list for "${probe.source}"`),
              };
            }
            if (isPlainRecord(fetched.data[0]) && typeof fetched.data[0]['sha'] === 'string') {
              sha = fetched.data[0]['sha'];
            }
          } else if (isPlainRecord(fetched.data) && typeof fetched.data['sha'] === 'string') {
            sha = fetched.data['sha'];
          }
          if (sha === undefined || sha.length === 0) {
            return {
              disposition: 'blocked',
              reason: 'probe_invalid_json',
              detail: scrubber.scrub(`git-commit "${probe.source}" payload lacked commit sha`),
            };
          }
          if (expectedVersion !== undefined && sha.toLowerCase() !== expectedVersion.toLowerCase()) {
            return {
              disposition: 'deferred',
              observedVersion: scrubber.scrub(sha),
              reason: 'stage_not_ready',
              detail: scrubber.scrub(`git-commit observed "${sha}", expected "${expectedVersion}"`),
            };
          }
          return {
            disposition: 'eligible',
            observedVersion: scrubber.scrub(sha),
            reason: 'probe_ready',
          };
        }

        const sourceKind = validateGitRemoteSource(probe.source, repositoryRoot);
        const gitSource = sourceKind === 'local-dir'
          ? await assertSafeLocalGitProbeSource(probe.source)
          : probe.source;
        const gitBin = resolveGitExecutable();
        const cleanEnv = buildCleanGitEnv();

        if (sourceKind === 'local-dir' && expectedVersion !== undefined && COMMIT_SHA_PATTERN.test(expectedVersion)) {
          // Verify gitSource is a valid Git repository first (otherwise fail closed as blocked).
          await execFileAsync(
            gitBin,
            ['-C', gitSource, 'rev-parse', '--git-dir'],
            { env: cleanEnv, timeout: timeoutMs, maxBuffer: 4_096, encoding: 'utf8' },
          );
          const isGitProcessFailure = (error: unknown): boolean => {
            if (error === null || typeof error !== 'object') return true;
            const err = error as { readonly killed?: unknown; readonly signal?: unknown; readonly code?: unknown };
            return err.killed === true || (err.signal !== null && err.signal !== undefined) || typeof err.code !== 'number';
          };
          const targetRef = probe.ref ?? 'HEAD';
          let refExists = false;
          if (COMMIT_SHA_PATTERN.test(targetRef)) {
            try {
              await execFileAsync(
                gitBin,
                ['-C', gitSource, 'cat-file', '-e', targetRef],
                { env: cleanEnv, timeout: timeoutMs, maxBuffer: 4_096, encoding: 'utf8' },
              );
              const { stdout: targetTypeOut } = await execFileAsync(
                gitBin,
                ['-C', gitSource, 'cat-file', '-t', targetRef],
                { env: cleanEnv, timeout: timeoutMs, maxBuffer: 4_096, encoding: 'utf8' },
              );
              refExists = targetTypeOut.trim() === 'commit';
            } catch (error) {
              const exitCode = (error as { code?: unknown }).code;
              const stderrText = typeof (error as { stderr?: unknown }).stderr === 'string'
                ? (error as { stderr: string }).stderr
                : '';
              if (isGitProcessFailure(error) || exitCode !== 1 || /corrupt|bad object|unable to read/i.test(stderrText)) {
                throw error;
              }
              refExists = false;
            }
          } else if (/[~^@:]/.test(targetRef)) {
            try {
              await execFileAsync(
                gitBin,
                ['-C', gitSource, 'rev-parse', '--verify', '--quiet', '--end-of-options', `${targetRef}^{commit}`],
                { env: cleanEnv, timeout: timeoutMs, maxBuffer: 4_096, encoding: 'utf8' },
              );
              refExists = true;
            } catch (error) {
              const exitCode = (error as { code?: unknown }).code;
              const stderrText = typeof (error as { stderr?: unknown }).stderr === 'string'
                ? (error as { stderr: string }).stderr
                : '';
              if (isGitProcessFailure(error) || (exitCode !== 1 && exitCode !== 128) || /corrupt|bad object|unable to read/i.test(stderrText)) {
                throw error;
              }
              refExists = false;
            }
          } else {
            const candidateRefs: string[] = [];
            if (targetRef === 'HEAD') {
              try {
                const sym = await execFileAsync(
                  gitBin,
                  ['-C', gitSource, 'symbolic-ref', '--quiet', 'HEAD'],
                  { env: cleanEnv, timeout: timeoutMs, maxBuffer: 4_096, encoding: 'utf8' },
                );
                const symRef = sym.stdout.trim();
                if (symRef.length > 0) candidateRefs.push(symRef);
              } catch (error) {
                if (isGitProcessFailure(error) || (error as { code?: unknown }).code !== 1) throw error;
                // Detached HEAD: check `git rev-parse --verify HEAD` directly below.
                refExists = true;
              }
            } else if (targetRef.startsWith('refs/')) {
              candidateRefs.push(targetRef);
            } else {
              candidateRefs.push(`refs/heads/${targetRef}`, `refs/tags/${targetRef}`, `refs/remotes/${targetRef}`);
            }
            if (!refExists) {
              for (const fullRef of candidateRefs) {
                try {
                  await execFileAsync(
                    gitBin,
                    ['-C', gitSource, 'show-ref', '--verify', '--quiet', '--', fullRef],
                    { env: cleanEnv, timeout: timeoutMs, maxBuffer: 4_096, encoding: 'utf8' },
                  );
                  refExists = true;
                  break;
                } catch (error) {
                  if (isGitProcessFailure(error) || (error as { code?: unknown }).code !== 1) throw error;
                }
              }
            }
          }
          if (!refExists) {
            return {
              disposition: 'deferred',
              reason: 'stage_not_ready',
              detail: scrubber.scrub(`git ref "${targetRef}" is not yet available in "${probe.source}"`),
            };
          }
          const { stdout: refShaOut } = await execFileAsync(
            gitBin,
            ['-C', gitSource, 'rev-parse', '--verify', '--end-of-options', `${targetRef}^{commit}`],
            { env: cleanEnv, timeout: timeoutMs, maxBuffer: 4_096, encoding: 'utf8' },
          );
          const refSha = refShaOut.trim().toLowerCase();
          let commitExists = true;
          try {
            await execFileAsync(
              gitBin,
              ['-C', gitSource, 'cat-file', '-e', expectedVersion],
              { env: cleanEnv, timeout: timeoutMs, maxBuffer: 4_096, encoding: 'utf8' },
            );
          } catch (error) {
            const exitCode = (error as { code?: unknown }).code;
            const stderrText = typeof (error as { stderr?: unknown }).stderr === 'string'
              ? (error as { stderr: string }).stderr
              : '';
            if (isGitProcessFailure(error) || exitCode !== 1 || /corrupt|bad object|unable to read/i.test(stderrText)) {
              throw error;
            }
            commitExists = false;
          }
          if (!commitExists) {
            return {
              disposition: 'deferred',
              observedVersion: scrubber.scrub(refSha),
              reason: 'stage_not_ready',
              detail: scrubber.scrub(`commit "${expectedVersion}" is absent from "${probe.source}"`),
            };
          }
          const { stdout: objTypeOut } = await execFileAsync(
            gitBin,
            ['-C', gitSource, 'cat-file', '-t', expectedVersion],
            { env: cleanEnv, timeout: timeoutMs, maxBuffer: 4_096, encoding: 'utf8' },
          );
          if (objTypeOut.trim() !== 'commit') {
            return {
              disposition: 'deferred',
              observedVersion: scrubber.scrub(refSha),
              reason: 'stage_not_ready',
              detail: scrubber.scrub(`object "${expectedVersion}" in "${probe.source}" is not a commit`),
            };
          }
          let isAncestor = true;
          try {
            await execFileAsync(
              gitBin,
              ['-C', gitSource, 'merge-base', '--is-ancestor', expectedVersion, refSha],
              { env: cleanEnv, timeout: timeoutMs, maxBuffer: 4_096, encoding: 'utf8' },
            );
          } catch (error) {
            if (isGitProcessFailure(error) || (error as { code?: unknown }).code !== 1) throw error;
            isAncestor = false;
          }
          if (!isAncestor) {
            return {
              disposition: 'deferred',
              observedVersion: scrubber.scrub(refSha),
              reason: 'stage_not_ready',
              detail: scrubber.scrub(`commit "${expectedVersion}" is not an ancestor of "${targetRef}" in "${probe.source}"`),
            };
          }
          return {
            disposition: 'eligible',
            observedVersion: scrubber.scrub(expectedVersion.toLowerCase()),
            reason: 'probe_ready',
          };
        }

        // Raw `git ls-remote` fallback (generic HTTPS Git URLs or non-hex expectedVersion where full commit-graph ancestry is unavailable: exact advertised ref SHA match)
        const protocolArgs = sourceKind === 'local-dir'
          ? ['-c', 'protocol.file.allow=always', '-c', 'protocol.ext.allow=never', '-c', 'protocol.ssh.allow=never']
          : ['-c', 'protocol.ext.allow=never', '-c', 'protocol.ssh.allow=never'];
        const queryRefs = probe.ref !== undefined ? [probe.ref] : ['HEAD', 'refs/heads/main', 'refs/heads/master'];
        const { stdout } = await execFileAsync(
          gitBin,
          [...protocolArgs, 'ls-remote', '--', gitSource, ...queryRefs],
          { env: cleanEnv, timeout: timeoutMs, maxBuffer: MAX_SUITE_STAGE_VERSION_BLOB_BYTES, encoding: 'utf8' },
        );
        const shas: string[] = [];
        for (const rawLine of stdout.split(/\r?\n/)) {
          const trimmed = rawLine.trim();
          if (!trimmed) continue;
          const parts = trimmed.split(/\s+/);
          if (parts[0]) shas.push(parts[0]);
        }
        if (shas.length === 0) {
          return {
            disposition: 'deferred',
            reason: 'stage_not_ready',
            detail: scrubber.scrub(`git-commit found no matching refs on "${probe.source}"`),
          };
        }
        if (expectedVersion !== undefined) {
          const matched = shas.find(s => s.toLowerCase() === expectedVersion.toLowerCase());
          if (matched === undefined) {
            return {
              disposition: 'deferred',
              observedVersion: scrubber.scrub(shas[0]!),
              reason: 'stage_not_ready',
              detail: scrubber.scrub(`git-commit observed "${shas[0]!}", expected "${expectedVersion}"`),
            };
          }
          return {
            disposition: 'eligible',
            observedVersion: scrubber.scrub(matched),
            reason: 'probe_ready',
          };
        }
        return {
          disposition: 'eligible',
          observedVersion: scrubber.scrub(shas[0]!),
          reason: 'probe_ready',
        };
      }
    }
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return {
      disposition: 'blocked',
      reason: 'probe_transport_error',
      detail: scrubber.scrub(detail),
    };
  }
}

// ---------------------------------------------------------------------------
// Pull-request comment & branch ownership routing
// ---------------------------------------------------------------------------

/**
 * Parse `/loopwright [<domainId>] retry|revise|status [guidance]` (and custom domain `commentPrefixes`).
 * Returns `null` when the comment body does not begin with a configured command prefix and valid command.
 */
export function parseSuiteCommentCommand(
  body: string,
  prefixes: readonly string[] = DEFAULT_COMMENT_PREFIXES,
  commands: readonly TaskpackCommentCommand[] = TASKPACK_COMMENT_COMMANDS,
  knownDomainIds?: ReadonlySet<string>,
): ParsedSuiteCommentCommand | null {
  const lines = body.split('\n');
  const firstLine = lines[0]?.trimEnd() ?? '';
  const trailingLines = lines.slice(1).join('\n');
  const sortedPrefixes = [...new Set(prefixes.length > 0 ? prefixes : DEFAULT_COMMENT_PREFIXES)]
    .sort((a, b) => b.length - a.length);

  const composeGuidance = (inlinePart: string): string => {
    const inline = inlinePart.trim();
    if (inline.length > 0 && trailingLines.length > 0) {
      return `${inline}\n${trailingLines}`;
    }
    return inline.length > 0 ? inline : trailingLines;
  };

  for (const prefix of sortedPrefixes) {
    if (firstLine.trim() === prefix) {
      if (!(commands as readonly string[]).includes('revise')) return null;
      if (trailingLines.trim().length === 0) return null;
      return Object.freeze({ prefix, command: 'revise', guidance: trailingLines });
    }
    if (!firstLine.startsWith(`${prefix} `)) continue;
    const afterPrefix = firstLine.slice(prefix.length).trim();
    if (afterPrefix.length === 0) continue;

    const firstTokenMatch = /^(\S+)(?:\s+(.*))?$/.exec(afterPrefix);
    if (firstTokenMatch === null) continue;
    const tok0 = firstTokenMatch[1]!;
    const afterTok0 = firstTokenMatch[2] ?? '';
    const secondTokenMatch = /^(\S+)(?:\s+(.*))?$/.exec(afterTok0.trim());
    const tok1 = secondTokenMatch?.[1];
    const afterTok1 = secondTokenMatch?.[2] ?? '';

    // `<prefix> <domainId> <command> [guidance]` takes precedence only when tok0 is a known domain ID or NOT itself a command keyword
    const tok0IsCommand = (commands as readonly string[]).includes(tok0);
    const tok0CanBeDomain = knownDomainIds !== undefined
      ? (knownDomainIds.has(tok0) || !tok0IsCommand)
      : !tok0IsCommand;
    if (tok1 !== undefined && (commands as readonly string[]).includes(tok1) && tok0CanBeDomain) {
      return Object.freeze({
        prefix,
        domainId: tok0,
        command: tok1 as TaskpackCommentCommand,
        guidance: composeGuidance(afterTok1),
      });
    }

    // Untargeted `<prefix> <command> [guidance]`
    if ((commands as readonly string[]).includes(tok0)) {
      return Object.freeze({
        prefix,
        command: tok0 as TaskpackCommentCommand,
        guidance: composeGuidance(afterTok0),
      });
    }

    // `<prefix> <knownDomainId>` followed by multiline guidance -> revise
    if (
      tok1 === undefined
      && knownDomainIds?.has(tok0) === true
      && (commands as readonly string[]).includes('revise')
      && trailingLines.trim().length > 0
    ) {
      return Object.freeze({
        prefix,
        domainId: tok0,
        command: 'revise',
        guidance: trailingLines,
      });
    }
  }
  return null;
}

/** Match `(prBaseRef, prHeadRef)` against suite domains declaring `publication.mode === 'pull_request'`. */
export function matchSuitePullRequestDomain(
  domains: readonly LoadedTaskpackSuiteDomain[],
  prHeadRef: string,
  prBaseRef?: string | undefined,
): { readonly matched: LoadedTaskpackSuiteDomain | null; readonly ambiguous: boolean } {
  const candidates: LoadedTaskpackSuiteDomain[] = [];
  for (const domain of domains) {
    const pub = domain.manifest.spec.publication;
    if (pub.mode !== 'pull_request') continue;
    if (prBaseRef !== undefined && pub.targetBranch !== prBaseRef) continue;
    if (
      prHeadRef.startsWith(pub.headBranchPrefix)
      && (pub.headBranchPrefix.startsWith(MEMORY_PULL_REQUEST_BRANCH_PREFIX) || !prHeadRef.startsWith(MEMORY_PULL_REQUEST_BRANCH_PREFIX))
    ) {
      candidates.push(domain);
    }
  }
  if (candidates.length === 1) {
    return { matched: candidates[0]!, ambiguous: false };
  }
  if (candidates.length > 1 && prBaseRef === undefined) {
    const exactBranchMatches = candidates.filter(d => {
      const pub = d.manifest.spec.publication;
      return pub.mode === 'pull_request' && prHeadRef === `${pub.headBranchPrefix}${pub.targetBranch}`;
    });
    if (exactBranchMatches.length === 1) {
      return { matched: exactBranchMatches[0]!, ambiguous: false };
    }
    return { matched: null, ambiguous: true };
  }
  return { matched: null, ambiguous: candidates.length > 1 };
}

export interface SuiteDomainUpdatesStatus {
  readonly status: 'up_to_date' | 'pending_updates' | 'blocked';
  readonly detail?: string | undefined;
}

export interface ResolveTaskpackSuiteOptions extends LoadTaskpackSuiteOptions {
  readonly loadedSuite?: LoadedTaskpackSuite | undefined;
  readonly baseRevision?: string | undefined;
  readonly remoteBaseRevision?: boolean | undefined;
  readonly eventName?: string | undefined;
  readonly eventPayload?: unknown | undefined;
  readonly schedule?: string | undefined;
  readonly domain?: string | undefined;
  readonly domains?: readonly string[] | undefined;
  readonly commentBody?: string | undefined;
  readonly commentPrefixes?: readonly string[] | undefined;
  readonly prHeadRef?: string | undefined;
  readonly prBaseRef?: string | undefined;
  readonly prHeadSha?: string | undefined;
  readonly prHeadRepoFullName?: string | undefined;
  readonly prHeadRepoFork?: boolean | undefined;
  readonly actorLogin?: string | undefined;
  readonly authorAssociation?: string | undefined;
  readonly operatorAllowlist?: readonly string[] | undefined;
  readonly repositoryFullName?: string | undefined;
  readonly apiBaseUrl?: string | undefined;
  readonly githubToken?: UpstreamTokenResolver | undefined;
  readonly authHeaders?: UpstreamHeadersResolver | undefined;
  readonly fetchImpl?: typeof globalThis.fetch | undefined;
  readonly scrubber?: SecretScrubber | undefined;
  readonly env?: NodeJS.ProcessEnv | undefined;
  readonly timeoutMs?: number | undefined;
  readonly discoverUpstreamUpdates?: boolean | undefined;
  readonly allowOfflineStagePrCheck?: boolean | undefined;
  readonly domainPendingUpdates?: Readonly<Record<string, boolean>> | undefined;
  readonly checkDomainUpdates?: ((input: {
    readonly domain: LoadedTaskpackSuiteDomain;
    readonly baseRevision: string;
  }) => Promise<SuiteDomainUpdatesStatus> | SuiteDomainUpdatesStatus) | undefined;
  readonly findOpenPullRequest?: ((input: {
    readonly domain: LoadedTaskpackSuiteDomain;
    readonly repositoryFullName: string;
    readonly targetBranch: string;
    readonly headBranchPrefix: string;
  }) => Promise<ManagedPullRequestInfo | null> | ManagedPullRequestInfo | null) | undefined;
  readonly probeRunner?: ((input: SuiteReadinessProbeRunnerInput) => Promise<SuiteReadinessProbeRunnerResult> | SuiteReadinessProbeRunnerResult) | undefined;
}

function toMatrixCell(
  domain: LoadedTaskpackSuiteDomain,
  baseRevision: string,
  headSha?: string | undefined,
): SuiteMatrixCell {
  return Object.freeze({
    domainId: domain.id,
    taskpackPath: domain.taskpackPath,
    taskpackName: domain.taskpackName,
    manifestSha256: domain.manifestSha256,
    controlRoot: domain.controlRoot,
    baseRevision,
    ...(headSha !== undefined ? { headSha } : {}),
    ...(domain.stage !== undefined ? { stage: domain.stage } : {}),
    ...(domain.matrix !== undefined ? { matrix: domain.matrix } : {}),
    protectedPaths: domain.protectedPaths,
  });
}

async function resolveSuiteBaseRevision(
  repositoryRoot: string,
  rawBaseRevision: string | undefined,
  timeoutMs: number,
  remoteBaseRevision?: boolean | undefined,
): Promise<string> {
  const candidate = rawBaseRevision?.trim() || 'HEAD';
  if (remoteBaseRevision === true && COMMIT_SHA_PATTERN.test(candidate)) {
    return candidate.toLowerCase();
  }
  if (existsSync(join(resolve(repositoryRoot), '.git'))) {
    return resolveGitCommitSha(repositoryRoot, candidate, timeoutMs);
  }
  if (COMMIT_SHA_PATTERN.test(candidate)) {
    return candidate.toLowerCase();
  }
  throw new TaskpackError('ACTION_INPUT_INVALID', `cannot resolve git revision "${candidate}" without a .git repository`);
}

interface ExtractedCommentEventMetadata {
  readonly action?: string | undefined;
  readonly isPlainIssueComment?: boolean | undefined;
  readonly hasPullRequestPayload?: boolean | undefined;
  readonly commentBody?: string | undefined;
  readonly prHeadRef?: string | undefined;
  readonly prBaseRef?: string | undefined;
  readonly prHeadSha?: string | undefined;
  readonly prHeadRepoFullName?: string | undefined;
  readonly prHeadRepoFork?: boolean | undefined;
  readonly prHeadRepoNull?: boolean | undefined;
  readonly prNumber?: number | undefined;
  readonly actorLogin?: string | undefined;
  readonly authorAssociation?: string | undefined;
  readonly isBot?: boolean | undefined;
}

function extractCommentMetadataFromPayload(payload: unknown): ExtractedCommentEventMetadata {
  if (!isPlainRecord(payload)) return {};
  const action = typeof payload['action'] === 'string' ? payload['action'] : undefined;
  const commentObj = isPlainRecord(payload['comment'])
    ? payload['comment']
    : (isPlainRecord(payload['review']) ? payload['review'] : undefined);
  const userObj = commentObj !== undefined && isPlainRecord(commentObj['user']) ? commentObj['user'] : undefined;
  const login = typeof userObj?.['login'] === 'string' ? userObj['login'] : undefined;
  const userType = typeof userObj?.['type'] === 'string' ? userObj['type'] : undefined;
  const isBot = userType === 'Bot' || (login !== undefined && login.toLowerCase().endsWith('[bot]'));
  const commentBody = typeof commentObj?.['body'] === 'string' ? commentObj['body'] : undefined;
  const authorAssociation = typeof commentObj?.['author_association'] === 'string' ? commentObj['author_association'] : undefined;

  const prObj = isPlainRecord(payload['pull_request']) ? payload['pull_request'] : undefined;
  const issueObj = isPlainRecord(payload['issue']) ? payload['issue'] : undefined;
  const isPlainIssueComment = issueObj !== undefined && !isPlainRecord(issueObj['pull_request']) && prObj === undefined;

  const headObj = prObj !== undefined && isPlainRecord(prObj['head']) ? prObj['head'] : undefined;
  const baseObj = prObj !== undefined && isPlainRecord(prObj['base']) ? prObj['base'] : undefined;
  const headRepo = headObj !== undefined && isPlainRecord(headObj['repo']) ? headObj['repo'] : undefined;
  const baseRepo = baseObj !== undefined && isPlainRecord(baseObj['repo']) ? baseObj['repo'] : undefined;
  const prHeadRepoNull = headObj !== undefined && headObj['repo'] === null;
  let prHeadRepoFork: boolean | undefined;
  if (typeof headRepo?.['fork'] === 'boolean') {
    const sameForkRepo = baseRepo !== undefined
      && baseRepo['fork'] === true
      && typeof headRepo['id'] === 'number'
      && headRepo['id'] === baseRepo['id'];
    prHeadRepoFork = sameForkRepo ? false : headRepo['fork'];
  }

  let prNumber: number | undefined;
  if (typeof prObj?.['number'] === 'number' && Number.isSafeInteger(prObj['number']) && prObj['number'] > 0) {
    prNumber = prObj['number'];
  } else if (issueObj !== undefined && isPlainRecord(issueObj['pull_request'])) {
    const num = issueObj['number'];
    if (typeof num === 'number' && Number.isSafeInteger(num) && num > 0) prNumber = num;
  }

  return {
    ...(action !== undefined ? { action } : {}),
    ...(isPlainIssueComment ? { isPlainIssueComment: true } : {}),
    ...(prObj !== undefined ? { hasPullRequestPayload: true } : {}),
    ...(commentBody !== undefined ? { commentBody } : {}),
    ...(typeof headObj?.['ref'] === 'string' ? { prHeadRef: headObj['ref'] } : {}),
    ...(typeof baseObj?.['ref'] === 'string' ? { prBaseRef: baseObj['ref'] } : {}),
    ...(typeof headObj?.['sha'] === 'string' ? { prHeadSha: headObj['sha'] } : {}),
    ...(typeof headRepo?.['full_name'] === 'string' ? { prHeadRepoFullName: headRepo['full_name'] } : {}),
    ...(prHeadRepoFork !== undefined ? { prHeadRepoFork } : {}),
    ...(prHeadRepoNull ? { prHeadRepoNull: true } : {}),
    ...(prNumber !== undefined ? { prNumber } : {}),
    ...(login !== undefined ? { actorLogin: login } : {}),
    ...(authorAssociation !== undefined ? { authorAssociation } : {}),
    ...(isBot ? { isBot: true } : {}),
  };
}

/**
 * Statelessly resolve eligible, deferred, or blocked domain cells for `schedule`, `workflow_dispatch`,
 * PR comment (`issue_comment` / `pull_request_review` / `pull_request_review_comment`), or direct `domain`
 * revalidation without writing any suite state ledger file.
 */
export async function resolveTaskpackSuite(options: ResolveTaskpackSuiteOptions): Promise<SuiteResolutionResult> {
  const scrubber = options.scrubber ?? new SecretScrubber();
  const runtimeEnv = options.env ?? process.env;
  for (const envKey of ['GITHUB_TOKEN', 'GH_TOKEN', 'INPUT_GITHUB-TOKEN']) {
    const val = runtimeEnv[envKey]?.trim();
    if (val !== undefined && val.length > 0) scrubber.register(val);
  }
  const fallbackEnvToken = (
    runtimeEnv['GITHUB_TOKEN']?.trim()
    || runtimeEnv['GH_TOKEN']?.trim()
    || runtimeEnv['INPUT_GITHUB-TOKEN']?.trim()
    || undefined
  );
  const effectiveGithubToken = options.githubToken ?? fallbackEnvToken;
  const rawRepoFullName = options.repositoryFullName?.trim() || runtimeEnv['GITHUB_REPOSITORY']?.trim();
  const effectiveRepoFullName = rawRepoFullName !== undefined && rawRepoFullName.length > 0 ? rawRepoFullName : undefined;
  const timeoutMs = options.timeoutMs ?? 15_000;
  const apiBaseUrl = (options.apiBaseUrl?.trim() || runtimeEnv['GITHUB_API_URL']?.trim() || 'https://api.github.com').replace(/\/+$/, '');
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const githubHeaders = await buildProbeAuthHeaders(
    effectiveGithubToken,
    options.authHeaders,
    { accept: 'application/vnd.github+json', 'user-agent': 'loopwright-taskpack' },
    scrubber,
  );

  const effectivePolicyProfile: PolicyProfile = options.policyProfile ?? options.hostPolicy?.policyProfile ?? 'local';
  const effectiveAllowLoopbackHttp = options.allowLoopbackHttp ?? (effectivePolicyProfile === 'local');
  const suite = options.loadedSuite ?? await loadTaskpackSuite({
    ...options,
    policyProfile: effectivePolicyProfile,
    allowLoopbackHttp: effectiveAllowLoopbackHttp,
  });
  const validDomainIds = Object.freeze(suite.domains.map(d => d.id));
  const domainById = new Map<string, LoadedTaskpackSuiteDomain>(suite.domains.map(d => [d.id, d]));
  const stageById = new Map<string, TaskpackSuiteStageDeclaration>(suite.manifest.spec.stages.map(s => [s.id, s]));

  const inferredEventName = options.eventName
    ?? (options.commentBody !== undefined ? 'issue_comment' : (options.schedule !== undefined ? 'schedule' : 'workflow_dispatch'));

  let resolvedBaseRevision: string;
  try {
    resolvedBaseRevision = await resolveSuiteBaseRevision(
      options.repositoryRoot,
      options.baseRevision,
      timeoutMs,
      options.remoteBaseRevision,
    );
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return Object.freeze({
      suiteName: suite.manifest.metadata.name,
      suitePath: suite.suitePath,
      suiteSha256: suite.suiteSha256,
      eventName: inferredEventName,
      baseRevision: options.baseRevision ?? '',
      disposition: 'blocked',
      reason: 'invalid_base_revision',
      detail: scrubber.scrub(detail),
      code: error instanceof TaskpackError ? error.code : 'ACTION_INPUT_INVALID',
      validDomainIds,
      suiteProtectedPaths: suite.suiteProtectedPaths,
      cells: Object.freeze([]),
      eligibleCells: Object.freeze([]),
      matrix: Object.freeze({ include: Object.freeze([]) }),
    });
  }

  const buildResult = (input: {
    readonly disposition: SuiteDisposition;
    readonly reason: string;
    readonly detail?: string | undefined;
    readonly code?: TaskpackError['code'] | undefined;
    readonly comment?: ParsedSuiteCommentCommand | undefined;
    readonly cells?: readonly SuiteDomainResolution[] | undefined;
  }): SuiteResolutionResult => {
    const cells = Object.freeze(input.cells ?? []);
    const eligibleCells = Object.freeze(
      cells
        .filter(c => c.disposition === 'eligible')
        .map(c => Object.freeze({
          domainId: c.domainId,
          taskpackPath: c.taskpackPath,
          taskpackName: c.taskpackName,
          manifestSha256: c.manifestSha256,
          controlRoot: c.controlRoot,
          baseRevision: c.baseRevision,
          ...(c.headSha !== undefined ? { headSha: c.headSha } : {}),
          ...(c.stage !== undefined ? { stage: c.stage } : {}),
          ...(c.matrix !== undefined ? { matrix: c.matrix } : {}),
          protectedPaths: c.protectedPaths,
        })),
    );
    return Object.freeze({
      suiteName: suite.manifest.metadata.name,
      suitePath: suite.suitePath,
      suiteSha256: suite.suiteSha256,
      eventName: inferredEventName,
      baseRevision: resolvedBaseRevision,
      disposition: input.disposition,
      reason: scrubber.scrub(input.reason),
      ...(input.detail !== undefined ? { detail: scrubber.scrub(input.detail) } : {}),
      ...(input.code !== undefined ? { code: input.code } : {}),
      validDomainIds,
      suiteProtectedPaths: suite.suiteProtectedPaths,
      ...(input.comment !== undefined ? { comment: input.comment } : {}),
      cells,
      eligibleCells,
      matrix: Object.freeze({ include: eligibleCells }),
    });
  };

  // Memoized stage evaluation (topological recursion on acyclic DAG)
  interface StageEvalOutcome {
    readonly disposition: 'eligible' | 'deferred' | 'blocked';
    readonly reason: string;
    readonly detail?: string | undefined;
    readonly probes: readonly SuiteStageProbeEvaluation[];
  }
  const stageCache = new Map<string, Promise<StageEvalOutcome>>();
  const domainUpdatesCache = new Map<string, Promise<SuiteDomainUpdatesStatus>>();
  type OpenPrCheckResult =
    | { readonly ok: true; readonly pr: ManagedPullRequestInfo | null }
    | { readonly ok: false; readonly reason: string; readonly detail: string };
  const openPrCache = new Map<string, Promise<OpenPrCheckResult>>();

  const localCommitAvailabilityPromise = hasLocalGitCommit(options.repositoryRoot, resolvedBaseRevision, timeoutMs);
  const remoteGitDataCache: RemoteGitDataCache = {
    commitTreeSha: new Map(),
    treeDocs: new Map(),
    blobBytes: new Map(),
    totalCachedBlobBytes: 0,
  };
  const versionFromCache = new Map<string, Promise<string>>();
  const readRevisionBlobBytes = async (
    relPath: string,
    maxBytes: number,
    optional: boolean,
  ): Promise<Buffer | null> => {
    if (await localCommitAvailabilityPromise) {
      const localBytes = await readOptionalGitBlobBytes(
        options.repositoryRoot,
        resolvedBaseRevision,
        relPath,
        maxBytes,
        timeoutMs,
      );
      if (localBytes === null && !optional) {
        throw new TaskpackError(
          'ACTION_INPUT_INVALID',
          `path "${relPath}" does not exist in commit ${resolvedBaseRevision}`,
        );
      }
      return localBytes;
    }
    if (effectiveRepoFullName !== undefined && REPOSITORY_FULL_NAME_PATTERN.test(effectiveRepoFullName)) {
      return fetchGitHubContentsBlobBytes({
        repositoryFullName: effectiveRepoFullName,
        resolvedSha: resolvedBaseRevision,
        relPath,
        apiBaseUrl,
        githubHeaders,
        fetchImpl,
        maxBytes,
        timeoutMs,
        optional,
        cache: remoteGitDataCache,
      });
    }
    throw new TaskpackError(
      'ACTION_INPUT_INVALID',
      `commit ${resolvedBaseRevision} is not present locally and no GitHub repository is configured for remote blob lookup of "${relPath}"`,
    );
  };
  const resolveCachedVersionFrom = (selector: SuiteVersionFromSelector): Promise<string> => {
    const normalizedVersionPath = normalizeRelativePath(selector.path, '/versionFrom/path');
    const cacheKey = `${resolvedBaseRevision}\0${normalizedVersionPath}\0${selector.jsonPointer ?? ''}`;
    const existing = versionFromCache.get(cacheKey);
    if (existing !== undefined) return existing;
    const promise = (async (): Promise<string> => (
      (await localCommitAvailabilityPromise)
        ? readGitRevisionVersionFrom({
          repositoryRoot: options.repositoryRoot,
          baseRevision: resolvedBaseRevision,
          selector,
          timeoutMs,
        })
        : parseVersionFromBlobBytes(
          (await readRevisionBlobBytes(normalizedVersionPath, MAX_SUITE_STAGE_VERSION_BLOB_BYTES, false))!,
          normalizedVersionPath,
          selector,
        )
    ))();
    versionFromCache.set(cacheKey, promise);
    return promise;
  };

  const checkUpstreamDomainUpdates = (domain: LoadedTaskpackSuiteDomain): Promise<SuiteDomainUpdatesStatus> => {
    const existing = domainUpdatesCache.get(domain.id);
    if (existing !== undefined) return existing;
    const promise = (async (): Promise<SuiteDomainUpdatesStatus> => {
      if (options.domainPendingUpdates?.[domain.id] === true) {
        return { status: 'pending_updates', detail: `upstream domain "${domain.id}" has pending updates` };
      }
      if (options.checkDomainUpdates !== undefined) {
        try {
          const res = await options.checkDomainUpdates({ domain, baseRevision: resolvedBaseRevision });
          return res.detail !== undefined
            ? { status: res.status, detail: scrubber.scrub(res.detail) }
            : { status: res.status };
        } catch (error) {
          const detail = error instanceof Error ? error.message : String(error);
          return { status: 'blocked', detail: scrubber.scrub(detail) };
        }
      }
      if (options.discoverUpstreamUpdates === true && domain.manifest.spec.upstreams.length > 0) {
        try {
          let gitBaselines: ReadonlyMap<string, string> | undefined;
          const proposal = domain.manifest.spec.proposal;
          const baselineRelPath = proposal !== undefined
            ? (proposal.path.toLowerCase().endsWith('.json') ? proposal.path : null)
            : 'package.json';
          if (baselineRelPath !== null) {
            const rawBlob = await readRevisionBlobBytes(
              baselineRelPath,
              MAX_SUITE_STAGE_VERSION_BLOB_BYTES,
              true,
            );
            if (rawBlob !== null) {
              const parsedDoc = JSON.parse(rawBlob.toString('utf8')) as unknown;
              gitBaselines = extractBaselineVersionsFromDocument(
                domain.manifest,
                parsedDoc,
                proposal !== undefined ? 'proposal' : 'package-json',
              );
            }
          }
          const discovered = await discoverTaskpackUpstreamsV2(domain.manifest, {
            repositoryRoot: options.repositoryRoot,
            apiBaseUrl,
            githubToken: effectiveGithubToken,
            authHeaders: options.authHeaders,
            fetchImpl,
            scrubber,
            env: runtimeEnv,
            timeoutMs,
            baselineVersions: gitBaselines,
            skipWorkingTreeBaselines: true,
          });
          if (discovered.disposition === 'blocked') {
            return { status: 'blocked', detail: scrubber.scrub(discovered.reason) };
          }
          if (discovered.disposition === 'candidate') {
            return { status: 'pending_updates', detail: scrubber.scrub(discovered.reason) };
          }
        } catch (error) {
          const detail = error instanceof Error ? error.message : String(error);
          return { status: 'blocked', detail: scrubber.scrub(detail) };
        }
      }
      return { status: 'up_to_date' };
    })();
    domainUpdatesCache.set(domain.id, promise);
    return promise;
  };

  const checkUpstreamDomainOpenPr = (domain: LoadedTaskpackSuiteDomain): Promise<OpenPrCheckResult> => {
    const existing = openPrCache.get(domain.id);
    if (existing !== undefined) return existing;
    const promise = (async (): Promise<OpenPrCheckResult> => {
      const pub = domain.manifest.spec.publication;
      if (pub.mode !== 'pull_request') {
        return { ok: true, pr: null };
      }
      try {
        if (options.findOpenPullRequest !== undefined) {
          const pr = await options.findOpenPullRequest({
            domain,
            repositoryFullName: effectiveRepoFullName ?? '',
            targetBranch: pub.targetBranch,
            headBranchPrefix: pub.headBranchPrefix,
          });
          return { ok: true, pr };
        }
        if (options.allowOfflineStagePrCheck === true) {
          return { ok: true, pr: null };
        }
        if (effectiveRepoFullName !== undefined && REPOSITORY_FULL_NAME_PATTERN.test(effectiveRepoFullName)) {
          const pr = await findOpenManagedPullRequest({
            repositoryFullName: effectiveRepoFullName,
            targetBranch: pub.targetBranch,
            headBranchPrefix: pub.headBranchPrefix,
            apiBaseUrl,
            githubToken: effectiveGithubToken,
            authHeaders: options.authHeaders,
            fetchImpl,
            scrubber,
            env: runtimeEnv,
            timeoutMs,
          });
          return { ok: true, pr };
        }
        return {
          ok: false,
          reason: 'stage_pr_lookup_unavailable',
          detail: scrubber.scrub(
            `cannot verify open pull requests for upstream domain "${domain.id}" without findOpenPullRequest, repositoryFullName/GITHUB_REPOSITORY, or allowOfflineStagePrCheck: true`,
          ),
        };
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        return { ok: false, reason: 'open_pr_lookup_failed', detail: scrubber.scrub(detail) };
      }
    })();
    openPrCache.set(domain.id, promise);
    return promise;
  };

  const evaluateStage = (stageId: string): Promise<StageEvalOutcome> => {
    const cached = stageCache.get(stageId);
    if (cached !== undefined) return cached;
    const promise = (async (): Promise<StageEvalOutcome> => {
      const stage = stageById.get(stageId);
      if (stage === undefined) {
        return {
          disposition: 'blocked',
          reason: 'unknown_stage',
          detail: `unknown stage "${stageId}"`,
          probes: Object.freeze([]),
        };
      }

      const collectedProbes: SuiteStageProbeEvaluation[] = [];
      const seenProbeKeys = new Set<string>();
      const pushUniqueProbe = (entry: SuiteStageProbeEvaluation): void => {
        const key = `${entry.stageId}\0${entry.probeIndex}`;
        if (seenProbeKeys.has(key)) return;
        seenProbeKeys.add(key);
        collectedProbes.push(entry);
      };
      let upstreamDeferredDetail: string | undefined;

      for (const parentStageId of stage.dependsOn) {
        const parentOutcome = await evaluateStage(parentStageId);
        for (const p of parentOutcome.probes) {
          pushUniqueProbe(p);
        }
        if (parentOutcome.disposition === 'blocked') {
          return {
            disposition: 'blocked',
            reason: parentOutcome.reason,
            detail: parentOutcome.detail ?? `upstream stage "${parentStageId}" is blocked`,
            probes: Object.freeze(collectedProbes),
          };
        }
        if (parentOutcome.disposition === 'deferred' && upstreamDeferredDetail === undefined) {
          upstreamDeferredDetail = parentOutcome.detail ?? `upstream stage "${parentStageId}" is not ready`;
        }

        const parentDomains = suite.domains.filter(d => d.enabled && d.stage === parentStageId);
        for (const parentDomain of parentDomains) {
          const upd = await checkUpstreamDomainUpdates(parentDomain);
          if (upd.status === 'blocked') {
            return {
              disposition: 'blocked',
              reason: 'upstream_stage_blocked',
              detail: upd.detail ?? `upstream domain "${parentDomain.id}" failed update check`,
              probes: Object.freeze(collectedProbes),
            };
          }
          if (upd.status === 'pending_updates' && upstreamDeferredDetail === undefined) {
            upstreamDeferredDetail = upd.detail ?? `upstream domain "${parentDomain.id}" has pending updates`;
          }

          const prCheck = await checkUpstreamDomainOpenPr(parentDomain);
          if (!prCheck.ok) {
            return {
              disposition: 'blocked',
              reason: prCheck.reason,
              detail: prCheck.detail,
              probes: Object.freeze(collectedProbes),
            };
          }
          if (prCheck.pr !== null && upstreamDeferredDetail === undefined) {
            upstreamDeferredDetail = `upstream domain "${parentDomain.id}" has open pull request #${prCheck.pr.number}`;
          }
        }
      }

      let probeBlockedDetail: string | undefined;
      let probeDeferredDetail: string | undefined;

      for (const [probeIndex, probe] of stage.readiness.entries()) {
        let expectedVersion: string | undefined;
        if (probe.versionFrom !== undefined) {
          try {
            const rawVersion = await resolveCachedVersionFrom(probe.versionFrom);
            expectedVersion = probe.tagPrefix !== undefined ? `${probe.tagPrefix}${rawVersion}` : rawVersion;
          } catch (error) {
            const detail = scrubber.scrub(error instanceof Error ? error.message : String(error));
            pushUniqueProbe(Object.freeze({
              stageId,
              probeIndex,
              ...(probe.id !== undefined ? { probeId: probe.id } : {}),
              kind: probe.kind,
              source: scrubber.scrub(probe.source),
              disposition: 'blocked',
              reason: 'version_from_failed',
              detail,
            }));
            probeBlockedDetail ??= detail;
            continue;
          }
        } else if (probe.expectedVersion !== undefined) {
          expectedVersion = probe.tagPrefix !== undefined ? `${probe.tagPrefix}${probe.expectedVersion}` : probe.expectedVersion;
        }

        const runnerInput: SuiteReadinessProbeRunnerInput = {
          stageId,
          probeIndex,
          probe,
          expectedVersion,
          repositoryRoot: options.repositoryRoot,
          baseRevision: resolvedBaseRevision,
          scrubber,
        };
        let outcome: SuiteReadinessProbeRunnerResult;
        try {
          outcome = options.probeRunner !== undefined
            ? await options.probeRunner(runnerInput)
            : await runDefaultReadinessProbe(runnerInput, {
              apiBaseUrl,
              githubHeaders,
              fetchImpl,
              timeoutMs,
              allowLoopbackHttp: effectiveAllowLoopbackHttp,
              policyProfile: effectivePolicyProfile,
            });
        } catch (error) {
          const detail = scrubber.scrub(error instanceof Error ? error.message : String(error));
          outcome = {
            disposition: 'blocked',
            reason: 'probe_transport_error',
            detail,
          };
        }

        const scrubbedReason = scrubber.scrub(outcome.reason);
        const scrubbedDetail = outcome.detail !== undefined ? scrubber.scrub(outcome.detail) : undefined;
        const scrubbedObserved = outcome.observedVersion !== undefined ? scrubber.scrub(outcome.observedVersion) : undefined;

        pushUniqueProbe(Object.freeze({
          stageId,
          probeIndex,
          ...(probe.id !== undefined ? { probeId: probe.id } : {}),
          kind: probe.kind,
          source: scrubber.scrub(probe.source),
          disposition: outcome.disposition,
          ...(expectedVersion !== undefined ? { expectedVersion: scrubber.scrub(expectedVersion) } : {}),
          ...(scrubbedObserved !== undefined ? { observedVersion: scrubbedObserved } : {}),
          reason: scrubbedReason,
          ...(scrubbedDetail !== undefined ? { detail: scrubbedDetail } : {}),
        }));

        if (outcome.disposition === 'blocked') {
          probeBlockedDetail ??= scrubbedDetail ?? scrubbedReason;
        } else if (outcome.disposition === 'deferred') {
          probeDeferredDetail ??= scrubbedDetail ?? scrubbedReason;
        }
      }

      if (probeBlockedDetail !== undefined) {
        return {
          disposition: 'blocked',
          reason: 'stage_probe_blocked',
          detail: probeBlockedDetail,
          probes: Object.freeze(collectedProbes),
        };
      }
      const deferredDetail = upstreamDeferredDetail ?? probeDeferredDetail;
      if (deferredDetail !== undefined) {
        return {
          disposition: 'deferred',
          reason: 'stage_not_ready',
          detail: deferredDetail,
          probes: Object.freeze(collectedProbes),
        };
      }
      return {
        disposition: 'eligible',
        reason: 'ready',
        probes: Object.freeze(collectedProbes),
      };
    })();
    stageCache.set(stageId, promise);
    return promise;
  };

  const evaluateDomainCell = async (
    domain: LoadedTaskpackSuiteDomain,
    headSha?: string | undefined,
  ): Promise<SuiteDomainResolution> => {
    const baseCell = toMatrixCell(domain, resolvedBaseRevision, headSha);
    if (!domain.enabled) {
      return Object.freeze({
        ...baseCell,
        disposition: 'deferred',
        reason: 'domain_disabled',
        detail: `domain "${domain.id}" has enabled: false`,
      });
    }
    if (domain.stage === undefined) {
      return Object.freeze({
        ...baseCell,
        disposition: 'eligible',
        reason: 'ready',
      });
    }
    const stageOutcome = await evaluateStage(domain.stage);
    return Object.freeze({
      ...baseCell,
      disposition: stageOutcome.disposition,
      reason: stageOutcome.reason,
      ...(stageOutcome.detail !== undefined ? { detail: stageOutcome.detail } : {}),
      ...(stageOutcome.probes.length > 0 ? { probes: stageOutcome.probes } : {}),
    });
  };

  // 1. Pull-request comment events (`issue_comment`, `pull_request_review`, `pull_request_review_comment`)
  const isCommentEvent = (
    inferredEventName === 'issue_comment'
    || inferredEventName === 'pull_request_review'
    || inferredEventName === 'pull_request_review_comment'
  );
  if (isCommentEvent) {
    if (options.eventPayload !== undefined && !isPlainRecord(options.eventPayload)) {
      return buildResult({
        disposition: 'blocked',
        reason: 'invalid_event_payload',
        detail: 'eventPayload must be a JSON object',
        code: 'ACTION_INPUT_INVALID',
      });
    }
    const payloadMeta = extractCommentMetadataFromPayload(options.eventPayload);
    if (options.eventPayload !== undefined) {
      if (inferredEventName === 'pull_request_review') {
        if (payloadMeta.action !== undefined && payloadMeta.action !== 'submitted') {
          return buildResult({
            disposition: 'ignored',
            reason: 'non_submitted_review_ignored',
          });
        }
      } else if (payloadMeta.action !== undefined && payloadMeta.action !== 'created') {
        return buildResult({
          disposition: 'ignored',
          reason: 'non_created_comment_ignored',
        });
      }
      if (inferredEventName === 'issue_comment' && payloadMeta.isPlainIssueComment === true) {
        return buildResult({
          disposition: 'ignored',
          reason: 'non_pull_request_comment_ignored',
        });
      }
    }
    if (payloadMeta.isBot === true) {
      return buildResult({
        disposition: 'ignored',
        reason: 'bot_comment_ignored',
      });
    }
    const commentBody = options.commentBody ?? payloadMeta.commentBody;
    if (commentBody === undefined || commentBody.trim().length === 0) {
      return buildResult({
        disposition: 'ignored',
        reason: 'empty_comment_ignored',
      });
    }

    const allPrefixes = new Set<string>(DEFAULT_COMMENT_PREFIXES);
    for (const p of options.commentPrefixes ?? []) allPrefixes.add(p);
    for (const dom of suite.domains) {
      for (const p of dom.manifest.spec.triggers.commentPrefixes) allPrefixes.add(p);
    }
    const knownDomainSet = new Set<string>(validDomainIds);
    const parsedComment = parseSuiteCommentCommand(
      commentBody,
      [...allPrefixes],
      TASKPACK_COMMENT_COMMANDS,
      knownDomainSet,
    );
    if (parsedComment === null) {
      return buildResult({
        disposition: 'ignored',
        reason: 'unrecognized_comment_ignored',
      });
    }

    const actorLogin = (options.actorLogin ?? payloadMeta.actorLogin)?.trim();
    const authorAssociation = (options.authorAssociation ?? payloadMeta.authorAssociation)?.trim();
    const requireCommentAuth = (
      options.eventPayload !== undefined
      || options.actorLogin !== undefined
      || options.authorAssociation !== undefined
    );
    if (requireCommentAuth) {
      if (
        actorLogin === undefined
        || actorLogin.length === 0
        || authorAssociation === undefined
        || authorAssociation.length === 0
      ) {
        return buildResult({
          disposition: 'blocked',
          reason: 'unauthorized_actor',
          detail: 'event payload is missing comment attribution',
          code: 'WEBHOOK_ACTOR_UNAUTHORIZED',
          comment: parsedComment,
        });
      }
      if (!authorizeRepositoryActor(authorAssociation, actorLogin, options.operatorAllowlist)) {
        return buildResult({
          disposition: 'blocked',
          reason: 'unauthorized_actor',
          detail: `actor "${actorLogin}" lacks write access (${authorAssociation})`,
          code: 'WEBHOOK_ACTOR_UNAUTHORIZED',
          comment: parsedComment,
        });
      }
    }

    const guidanceCheck = validateCommentGuidance(parsedComment.guidance);
    if (!guidanceCheck.ok) {
      return buildResult({
        disposition: 'blocked',
        reason: 'invalid_guidance',
        detail: guidanceCheck.detail,
        code: 'WEBHOOK_GUIDANCE_INVALID',
        comment: parsedComment,
      });
    }

    let prHeadRef = options.prHeadRef ?? payloadMeta.prHeadRef;
    let prBaseRef = options.prBaseRef ?? payloadMeta.prBaseRef;
    let prHeadSha = options.prHeadSha ?? payloadMeta.prHeadSha;
    let prHeadRepoFullName = options.prHeadRepoFullName ?? payloadMeta.prHeadRepoFullName;
    let prHeadRepoFork = options.prHeadRepoFork ?? payloadMeta.prHeadRepoFork;
    let prHeadRepoNull = payloadMeta.prHeadRepoNull === true;
    let usedApiPrLookup = false;

    // Fetch missing pull-request metadata via GitHub API when PR payload was omitted (e.g. issue_comment)
    if (
      payloadMeta.hasPullRequestPayload !== true
      && !prHeadRepoNull
      && (
        prHeadRef === undefined
        || prBaseRef === undefined
        || prHeadRepoFullName === undefined
        || prHeadSha === undefined
      )
      && payloadMeta.prNumber !== undefined
      && effectiveRepoFullName !== undefined
      && REPOSITORY_FULL_NAME_PATTERN.test(effectiveRepoFullName)
    ) {
      usedApiPrLookup = true;
      try {
        const res = await fetchBoundedText(
          `${apiBaseUrl}/repos/${effectiveRepoFullName}/pulls/${payloadMeta.prNumber}`,
          fetchImpl,
          githubHeaders,
          timeoutMs,
          scrubber,
        );
        if (!res.ok) {
          return buildResult({
            disposition: 'blocked',
            reason: 'pull_request_lookup_failed',
            detail: `pull request #${payloadMeta.prNumber} lookup failed with HTTP ${res.status}`,
            code: 'ACTION_INPUT_INVALID',
            comment: parsedComment,
          });
        }
        const prData = JSON.parse(res.text) as unknown;
        if (!isPlainRecord(prData)) {
          return buildResult({
            disposition: 'blocked',
            reason: 'pull_request_lookup_failed',
            detail: `pull request #${payloadMeta.prNumber} returned non-object JSON`,
            code: 'ACTION_INPUT_INVALID',
            comment: parsedComment,
          });
        }
        const head = isPlainRecord(prData['head']) ? prData['head'] : undefined;
        const base = isPlainRecord(prData['base']) ? prData['base'] : undefined;
        const headRepo = head !== undefined && isPlainRecord(head['repo']) ? head['repo'] : undefined;
        const baseRepo = base !== undefined && isPlainRecord(base['repo']) ? base['repo'] : undefined;
        const apiHeadRepoNull = head !== undefined && head['repo'] === null;
        const apiHeadRef = typeof head?.['ref'] === 'string' && head['ref'].trim().length > 0 ? head['ref'] : undefined;
        const apiBaseRef = typeof base?.['ref'] === 'string' && base['ref'].trim().length > 0 ? base['ref'] : undefined;
        const apiHeadSha = typeof head?.['sha'] === 'string' && head['sha'].trim().length > 0 ? head['sha'] : undefined;
        const apiHeadRepoFullName = typeof headRepo?.['full_name'] === 'string' && headRepo['full_name'].trim().length > 0
          ? headRepo['full_name']
          : undefined;
        let apiHeadRepoFork: boolean | undefined;
        if (typeof headRepo?.['fork'] === 'boolean') {
          const sameForkRepo = baseRepo !== undefined
            && baseRepo['fork'] === true
            && typeof headRepo['id'] === 'number'
            && headRepo['id'] === baseRepo['id'];
          apiHeadRepoFork = sameForkRepo ? false : headRepo['fork'];
        }

        const pinMismatch = (
          (prHeadRef !== undefined && apiHeadRef !== undefined && prHeadRef.trim() !== apiHeadRef.trim())
          || (prBaseRef !== undefined && apiBaseRef !== undefined && prBaseRef.trim() !== apiBaseRef.trim())
          || (
            prHeadSha !== undefined
            && COMMIT_SHA_PATTERN.test(prHeadSha.trim())
            && apiHeadSha !== undefined
            && COMMIT_SHA_PATTERN.test(apiHeadSha.trim())
            && prHeadSha.trim().toLowerCase() !== apiHeadSha.trim().toLowerCase()
          )
          || (
            prHeadRepoFullName !== undefined
            && apiHeadRepoFullName !== undefined
            && prHeadRepoFullName.trim().toLowerCase() !== apiHeadRepoFullName.trim().toLowerCase()
          )
        );
        if (pinMismatch) {
          return buildResult({
            disposition: 'blocked',
            reason: 'pull_request_snapshot_mismatch',
            detail: 'pull request metadata changed between caller/event payload and GitHub API lookup',
            code: 'TASKPACK_SCOPE_VIOLATION',
            comment: parsedComment,
          });
        }

        prHeadRepoNull = apiHeadRepoNull;
        prHeadRef = apiHeadRef;
        prBaseRef = apiBaseRef;
        prHeadSha = apiHeadSha;
        prHeadRepoFullName = apiHeadRepoFullName;
        prHeadRepoFork = apiHeadRepoFork;
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        return buildResult({
          disposition: 'blocked',
          reason: 'pull_request_lookup_failed',
          detail,
          code: 'ACTION_INPUT_INVALID',
          comment: parsedComment,
        });
      }
    }

    // Enforce fail-closed cross-fork checks whenever resolving from a webhook/API PR or explicit repo metadata
    const requireCrossForkVerification = (
      options.eventPayload !== undefined
      || usedApiPrLookup
      || prHeadRepoFork !== undefined
      || prHeadRepoFullName !== undefined
    );
    if (requireCrossForkVerification) {
      const trimmedHeadRepo = prHeadRepoFullName?.trim();
      if (
        prHeadRepoNull
        || prHeadRepoFork === true
        || trimmedHeadRepo === undefined
        || trimmedHeadRepo.length === 0
        || effectiveRepoFullName === undefined
        || !REPOSITORY_FULL_NAME_PATTERN.test(effectiveRepoFullName)
        || trimmedHeadRepo.toLowerCase() !== effectiveRepoFullName.toLowerCase()
      ) {
        return buildResult({
          disposition: 'blocked',
          reason: 'cross_fork_pull_request',
          detail: 'cross-fork pull request comments are refused',
          code: 'TASKPACK_SCOPE_VIOLATION',
          comment: parsedComment,
        });
      }
    }

    let normalizedHeadSha: string | undefined;
    if (prHeadSha !== undefined) {
      const trimmedSha = prHeadSha.trim();
      if (!COMMIT_SHA_PATTERN.test(trimmedSha)) {
        return buildResult({
          disposition: 'blocked',
          reason: 'invalid_pull_request_head_sha',
          detail: `invalid pull request head SHA "${trimmedSha}"`,
          code: 'ACTION_INPUT_INVALID',
          comment: parsedComment,
        });
      }
      normalizedHeadSha = trimmedSha.toLowerCase();
    }

    if (prHeadRef === undefined || prHeadRef.trim().length === 0) {
      return buildResult({
        disposition: 'blocked',
        reason: 'missing_pull_request_branch',
        detail: `pull request head branch metadata is required to route comment commands; valid domains: ${validDomainIds.join(', ')}`,
        code: 'TASKPACK_SCOPE_VIOLATION',
        comment: parsedComment,
      });
    }

    const ownership = matchSuitePullRequestDomain(suite.domains, prHeadRef, prBaseRef);
    if (ownership.ambiguous) {
      return buildResult({
        disposition: 'blocked',
        reason: 'ambiguous_pull_request_branch',
        detail: `pull request branch "${prHeadRef}" is ambiguous without prBaseRef; valid domains: ${validDomainIds.join(', ')}`,
        code: 'TASKPACK_SCOPE_VIOLATION',
        comment: parsedComment,
      });
    }

    if (parsedComment.domainId !== undefined) {
      const explicitTarget = domainById.get(parsedComment.domainId);
      if (explicitTarget === undefined) {
        return buildResult({
          disposition: 'blocked',
          reason: 'unknown_domain',
          detail: `unknown suite domain "${parsedComment.domainId}"; valid domains: ${validDomainIds.join(', ')}`,
          code: 'TASKPACK_SCOPE_VIOLATION',
          comment: parsedComment,
        });
      }
      if (ownership.matched === null || ownership.matched.id !== explicitTarget.id) {
        return buildResult({
          disposition: 'blocked',
          reason: 'domain_branch_mismatch',
          detail: ownership.matched !== null
            ? `comment targets domain "${explicitTarget.id}" on pull request branch "${prHeadRef}" owned by domain "${ownership.matched.id}"`
            : `comment targets domain "${explicitTarget.id}" on unmanaged pull request branch "${prHeadRef}"; valid domains: ${validDomainIds.join(', ')}`,
          code: 'TASKPACK_SCOPE_VIOLATION',
          comment: parsedComment,
        });
      }
    }

    if (ownership.matched === null) {
      return buildResult({
        disposition: 'blocked',
        reason: 'unmatched_pull_request_branch',
        detail: `pull request branch "${prHeadRef}" does not match any suite domain headBranchPrefix; valid domains: ${validDomainIds.join(', ')}`,
        code: 'TASKPACK_SCOPE_VIOLATION',
        comment: parsedComment,
      });
    }

    const targetDomain = ownership.matched;
    if (options.domain !== undefined && options.domain !== targetDomain.id) {
      return buildResult({
        disposition: 'blocked',
        reason: 'domain_branch_mismatch',
        detail: `explicit domain "${options.domain}" conflicts with pull request branch "${prHeadRef}" owned by domain "${targetDomain.id}"`,
        code: 'TASKPACK_SCOPE_VIOLATION',
        comment: parsedComment,
      });
    }
    if (!targetDomain.enabled) {
      return buildResult({
        disposition: 'blocked',
        reason: 'domain_disabled',
        detail: `suite domain "${targetDomain.id}" is disabled`,
        code: 'TASKPACK_SCOPE_VIOLATION',
        comment: parsedComment,
      });
    }

    const configuredPrefixes = targetDomain.manifest.spec.triggers.commentPrefixes.length > 0
      ? targetDomain.manifest.spec.triggers.commentPrefixes
      : DEFAULT_COMMENT_PREFIXES;
    const effectiveAllowedPrefixes = options.commentPrefixes !== undefined && options.commentPrefixes.length > 0
      ? options.commentPrefixes
      : configuredPrefixes;
    if (!effectiveAllowedPrefixes.includes(parsedComment.prefix)) {
      return buildResult({
        disposition: 'ignored',
        reason: 'comment_prefix_not_configured_for_domain',
        comment: parsedComment,
      });
    }
    const configuredCommands = targetDomain.manifest.spec.triggers.commentCommands;
    if (
      (configuredCommands.length > 0 || options.policyProfile === 'github')
      && !configuredCommands.includes(parsedComment.command)
    ) {
      return buildResult({
        disposition: 'blocked',
        reason: 'comment_command_unsupported',
        detail: `domain "${targetDomain.id}" does not enable comment command "${parsedComment.command}"`,
        code: 'TASKPACK_TRIGGER_UNSUPPORTED',
        comment: parsedComment,
      });
    }

    if (parsedComment.command === 'status') {
      const statusCell: SuiteDomainResolution = Object.freeze({
        ...toMatrixCell(targetDomain, resolvedBaseRevision, normalizedHeadSha),
        disposition: 'eligible',
        reason: 'ready',
      });
      return buildResult({
        disposition: 'eligible',
        reason: 'ready',
        comment: parsedComment,
        cells: [statusCell],
      });
    }

    const cell = await evaluateDomainCell(targetDomain, normalizedHeadSha);
    return buildResult({
      disposition: cell.disposition,
      reason: cell.reason,
      detail: cell.detail,
      code: cell.code,
      comment: parsedComment,
      cells: [cell],
    });
  }

  const payloadSchedule = isPlainRecord(options.eventPayload) && typeof options.eventPayload['schedule'] === 'string'
    ? options.eventPayload['schedule']
    : undefined;
  const scheduleKey = options.schedule ?? payloadSchedule;

  const domainMatchesTriggerAndSchedule = (dom: LoadedTaskpackSuiteDomain): boolean => {
    if (!dom.enabled) return false;
    if (effectivePolicyProfile === 'github') {
      if (inferredEventName === 'release') {
        const releaseAction = isPlainRecord(options.eventPayload) && typeof options.eventPayload['action'] === 'string'
          ? options.eventPayload['action']
          : undefined;
        if (releaseAction !== 'published') {
          return false;
        }
      }
      if (!isGitHubTriggerDeclared(dom.manifest.spec.triggers, { eventName: inferredEventName })) {
        return false;
      }
    }
    if (inferredEventName === 'schedule') {
      if (scheduleKey !== undefined && scheduleKey.length > 0) {
        return dom.schedules !== undefined && dom.schedules.includes(scheduleKey);
      }
      return dom.schedules === undefined || dom.schedules.length > 0;
    }
    return true;
  };

  // 2. Direct single-domain selection / matrix cell revalidation
  if (options.domain !== undefined) {
    let directHeadSha: string | undefined;
    if (options.prHeadSha !== undefined) {
      const trimmedSha = options.prHeadSha.trim();
      if (!COMMIT_SHA_PATTERN.test(trimmedSha)) {
        return buildResult({
          disposition: 'blocked',
          reason: 'invalid_pull_request_head_sha',
          detail: `invalid pull request head SHA "${trimmedSha}"`,
          code: 'ACTION_INPUT_INVALID',
        });
      }
      directHeadSha = trimmedSha.toLowerCase();
    }
    const selected = domainById.get(options.domain);
    if (selected === undefined) {
      return buildResult({
        disposition: 'blocked',
        reason: 'unknown_domain',
        detail: `unknown suite domain "${options.domain}"; valid domains: ${validDomainIds.join(', ')}`,
        code: 'TASKPACK_MANIFEST_INVALID',
      });
    }
    if (!selected.enabled) {
      const cell = await evaluateDomainCell(selected, directHeadSha);
      return buildResult({
        disposition: cell.disposition,
        reason: cell.reason,
        detail: cell.detail,
        code: cell.code,
        cells: [cell],
      });
    }
    if (!domainMatchesTriggerAndSchedule(selected)) {
      const detail = inferredEventName === 'schedule' && scheduleKey !== undefined && scheduleKey.length > 0
        ? `domain "${selected.id}" does not match schedule "${scheduleKey}"`
        : `domain "${selected.id}" does not enable trigger "${inferredEventName}"`;
      const cell: SuiteDomainResolution = Object.freeze({
        domainId: selected.id,
        taskpackPath: selected.taskpackPath,
        taskpackName: selected.manifest.metadata.name,
        manifestSha256: selected.manifestSha256,
        controlRoot: selected.controlRoot,
        baseRevision: resolvedBaseRevision,
        ...(directHeadSha !== undefined ? { headSha: directHeadSha } : {}),
        ...(selected.stage !== undefined ? { stage: selected.stage } : {}),
        ...(selected.matrix !== undefined ? { matrix: selected.matrix } : {}),
        protectedPaths: selected.protectedPaths,
        disposition: 'deferred',
        reason: 'no_matching_domains',
        detail,
      });
      return buildResult({
        disposition: 'deferred',
        reason: 'no_matching_domains',
        detail,
        cells: [cell],
      });
    }
    const cell = await evaluateDomainCell(selected, directHeadSha);
    return buildResult({
      disposition: cell.disposition,
      reason: cell.reason,
      detail: cell.detail,
      code: cell.code,
      cells: [cell],
    });
  }

  // 3. Schedule & workflow_dispatch multi-domain resolution
  const requestedDomainSet = options.domains !== undefined ? new Set<string>(options.domains) : null;
  const candidateDomains = suite.domains.filter(dom => (
    (requestedDomainSet === null || requestedDomainSet.has(dom.id))
    && domainMatchesTriggerAndSchedule(dom)
  ));

  if (candidateDomains.length === 0) {
    return buildResult({
      disposition: 'deferred',
      reason: 'no_matching_domains',
      detail: scheduleKey !== undefined
        ? `no enabled domains matched schedule "${scheduleKey}"`
        : 'no enabled domains matched event',
    });
  }

  const cells: SuiteDomainResolution[] = [];
  for (const dom of candidateDomains) {
    cells.push(await evaluateDomainCell(dom));
  }

  const blockedCell = cells.find(c => c.disposition === 'blocked');
  if (blockedCell !== undefined) {
    return buildResult({
      disposition: 'blocked',
      reason: blockedCell.reason,
      detail: blockedCell.detail,
      code: blockedCell.code,
      cells,
    });
  }

  const hasEligible = cells.some(c => c.disposition === 'eligible');
  if (hasEligible) {
    return buildResult({
      disposition: 'eligible',
      reason: 'ready',
      cells,
    });
  }

  return buildResult({
    disposition: 'deferred',
    reason: 'stage_not_ready',
    detail: cells.find(c => c.detail !== undefined)?.detail,
    cells,
  });
}
