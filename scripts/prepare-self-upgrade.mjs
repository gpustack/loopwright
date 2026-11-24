#!/usr/bin/env node
import { Buffer } from 'node:buffer';
import { execFile } from 'node:child_process';
import { constants as fsConstants, existsSync, realpathSync } from 'node:fs';
import { chmod, lstat, mkdir, mkdtemp, open, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import process from 'node:process';
import { fileURLToPath, URL } from 'node:url';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export const DEFAULT_STAGE_DIR = '/tmp/loopwright-self-upgrade-stage';
export const MAX_PROPOSAL_BYTES = 64 * 1024;
export const MAX_MANIFEST_BYTES = 64 * 1024;
export const MAX_LOCKFILE_BYTES = 900 * 1024;
export const MAX_HTTP_JSON_BYTES = 1024 * 1024;
export const MAX_PROMPT_RESOURCE_BYTES = 64 * 1024;
export const MAX_PROMPT_RESOURCES_TOTAL_BYTES = 256 * 1024;
export const MAX_PROMPT_PATCH_TOTAL_BYTES = 192 * 1024;
export const MAX_NPM_CACHE_ARCHIVE_BYTES = 128 * 1024 * 1024;
export const MAX_WORKSPACE_RESOURCES_TOTAL_BYTES = 256 * 1024 * 1024;

export const PI_UPSTREAM_MAP = Object.freeze({
  'pi-coding-agent': '@earendil-works/pi-coding-agent',
  'pi-ai': '@earendil-works/pi-ai',
  'pi-agent-core': '@earendil-works/pi-agent-core',
  'pi-mcp': '@earendil-works/pi-mcp',
  'pi-codemode': '@earendil-works/pi-codemode',
  'pi-tui': '@earendil-works/pi-tui',
});
export const YAML_UPSTREAM_MAP = Object.freeze({ yaml: 'yaml' });
export const ALL_UPSTREAM_PACKAGES = Object.freeze({ ...PI_UPSTREAM_MAP, ...YAML_UPSTREAM_MAP });
export const PI_UPSTREAM_IDS = Object.freeze(Object.keys(PI_UPSTREAM_MAP));
export const ALL_UPSTREAM_IDS = Object.freeze(Object.keys(ALL_UPSTREAM_PACKAGES));
export const YAML_WORKSPACES = Object.freeze([
  'packages/cli',
  'packages/controller',
  'packages/decisions',
  'packages/github-app',
  'packages/taskpack',
]);
export const MANAGED_WORKSPACES = Object.freeze(['packages/agent-pi', ...YAML_WORKSPACES]);
export const UNMANAGED_WORKSPACES = Object.freeze([
  'packages/core',
  'packages/state',
  'packages/memory',
  'packages/taskpack-runner',
  'packages/hardware-runner',
  'packages/evolution',
]);

const DEFAULT_UPSTREAM_GROUPS = Object.freeze([
  Object.freeze({ id: 'pi-family', policy: 'lockstep', members: PI_UPSTREAM_IDS }),
]);
const DEFAULT_UPSTREAM_DESCRIPTORS = Object.freeze(
  ALL_UPSTREAM_IDS.map(id => Object.freeze({
    id,
    kind: 'http-json',
    source: `https://registry.npmjs.org/${ALL_UPSTREAM_PACKAGES[id]}/latest`,
    watchedPaths: Object.freeze(id === 'yaml' ? YAML_WORKSPACES.map(ws => `${ws}/package.json`) : ['packages/agent-pi/package.json']),
    allowPrerelease: false,
    versionPath: 'version',
    monotonicSemver: true,
  })),
);

const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
const CANONICAL_SEMVER_RE = /^(0|[1-9][0-9]{0,8})\.(0|[1-9][0-9]{0,8})\.(0|[1-9][0-9]{0,8})$/;

async function loadTaskpackCompilerModule(repoRoot) {
  const distIndexUrl = new URL('../packages/taskpack/dist/index.js', import.meta.url);
  const distPath = fileURLToPath(distIndexUrl);
  if (existsSync(distPath)) return await import(distIndexUrl.href);
  try {
    return await import('@loopwright/taskpack');
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`Missing compiled @loopwright/taskpack at "${relative(repoRoot, distPath)}"; run "npm run build" first (${detail})`, { cause: error });
  }
}

const taskpackModule = await loadTaskpackCompilerModule(process.cwd());

export function isPlainRecord(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) return false;
  return !Object.keys(value).some(key => FORBIDDEN_KEYS.has(key));
}

export function parseCanonicalSemver(value) {
  if (typeof value !== 'string') return null;
  const match = CANONICAL_SEMVER_RE.exec(value);
  if (match === null) return null;
  const major = Number.parseInt(match[1], 10);
  const minor = Number.parseInt(match[2], 10);
  const patch = Number.parseInt(match[3], 10);
  if (!Number.isSafeInteger(major) || !Number.isSafeInteger(minor) || !Number.isSafeInteger(patch)) return null;
  return Object.freeze({ major, minor, patch, raw: value });
}

export function compareCanonicalSemver(left, right) {
  if (parseCanonicalSemver(left) === null || parseCanonicalSemver(right) === null) {
    throw new Error(`Invalid canonical SemVer comparison: "${String(left)}" vs "${String(right)}"`);
  }
  return taskpackModule.compareStrictSemver(left, right);
}

const isInsidePath = (candidate, root) =>
  candidate === root || candidate.startsWith(root.endsWith(sep) ? root : `${root}${sep}`);

const resolveExecutablePath = (candidates, fallback) =>
  candidates.find(c => typeof c === 'string' && c.length > 0 && existsSync(c)) ?? fallback;

const resolveNpmExecutable = () => {
  const npmName = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  return resolveExecutablePath([join(dirname(process.execPath), npmName), '/usr/local/bin/npm', '/opt/homebrew/bin/npm', '/usr/bin/npm'], npmName);
};

const resolveGitExecutable = () =>
  resolveExecutablePath(['/usr/bin/git', '/usr/local/bin/git', '/opt/homebrew/bin/git'], 'git');

const resolvePythonExecutable = () =>
  resolveExecutablePath(['/usr/bin/python3', '/usr/local/bin/python3', '/opt/homebrew/bin/python3'], 'python3');

const buildCleanGitEnv = () => ({
  PATH: process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_TERMINAL_PROMPT: '0',
});

async function runGit(args, opts = {}) {
  return await execFileAsync(
    resolveGitExecutable(),
    ['-c', 'core.hooksPath=/dev/null', ...args],
    { env: buildCleanGitEnv(), timeout: 15_000, maxBuffer: 64 * 1024, ...opts },
  );
}

async function assertNoSymlinkChain(rootDir, relPath) {
  const cleanRel = relPath.split('/').filter(Boolean);
  const rootStat = await lstat(rootDir);
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
    throw new Error(`Repository root "${rootDir}" must be a real directory`);
  }
  let cursor = rootDir;
  for (let idx = 0; idx < cleanRel.length; idx += 1) {
    const segment = cleanRel[idx];
    if (segment === '.' || segment === '..') throw new Error(`Unsafe relative path "${relPath}"`);
    cursor = join(cursor, segment);
    const info = await lstat(cursor);
    if (info.isSymbolicLink()) throw new Error(`Refusing symlink at "${relPath}"`);
    if (idx < cleanRel.length - 1) {
      if (!info.isDirectory()) throw new Error(`Expected directory parent while reading "${relPath}"`);
    } else if (!info.isFile()) {
      throw new Error(`Expected regular file at "${relPath}"`);
    }
  }
  return cursor;
}

async function readRegularFdBounded(fullPath, label, maxBytes) {
  const flags = fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0) | (fsConstants.O_NONBLOCK ?? 0);
  const handle = await open(fullPath, flags);
  try {
    const info = await handle.stat();
    if (!info.isFile()) throw new Error(`Expected regular file at "${label}"`);
    if (info.nlink > 1) throw new Error(`Refusing hardlinked file at "${label}" (nlink=${info.nlink})`);
    if (info.size > maxBytes) throw new Error(`File "${label}" (${info.size} bytes) exceeds limit of ${maxBytes} bytes`);
    return await handle.readFile();
  } finally {
    await handle.close();
  }
}

export async function readBoundedRegularFile(rootDir, relPath, maxBytes) {
  return await readRegularFdBounded(await assertNoSymlinkChain(rootDir, relPath), relPath, maxBytes);
}

async function readBoundedAbsoluteFile(filePath, maxBytes) {
  const resolvedPath = resolve(filePath);
  const preStat = await lstat(resolvedPath);
  if (preStat.isSymbolicLink() || !preStat.isFile()) throw new Error(`Expected regular file at "${resolvedPath}"`);
  return await readRegularFdBounded(resolvedPath, resolvedPath, maxBytes);
}

async function readJsonRegularFile(rootDir, relPath, maxBytes) {
  const bytes = await readBoundedRegularFile(rootDir, relPath, maxBytes);
  let parsed;
  try {
    parsed = JSON.parse(bytes.toString('utf8'));
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`Invalid JSON in "${relPath}": ${detail}`, { cause: error });
  }
  if (!isPlainRecord(parsed)) throw new Error(`Top-level JSON value in "${relPath}" must be a plain object`);
  return { parsed, byteLength: bytes.byteLength };
}

export function validateLockfileExpectedVersions(lockDoc, expectedPackagesMap) {
  if (!isPlainRecord(lockDoc)) throw new Error('package-lock.json must be a plain JSON object');
  if (lockDoc.lockfileVersion !== 3) throw new Error(`package-lock.json lockfileVersion must be 3 (received ${String(lockDoc.lockfileVersion)})`);
  const packagesTable = lockDoc.packages;
  if (!isPlainRecord(packagesTable)) throw new Error('package-lock.json missing plain "packages" table');

  for (const [workspacePath, expectedDeps] of Object.entries(expectedPackagesMap)) {
    const wsEntry = packagesTable[workspacePath];
    if (!isPlainRecord(wsEntry) || !isPlainRecord(wsEntry.dependencies)) {
      throw new Error(`package-lock.json missing workspace entry or dependencies for "${workspacePath}"`);
    }
    for (const [pkgName, expectedVersion] of Object.entries(expectedDeps)) {
      if (wsEntry.dependencies[pkgName] !== expectedVersion) {
        throw new Error(`package-lock.json "${workspacePath}".dependencies["${pkgName}"] is "${String(wsEntry.dependencies[pkgName])}", expected "${expectedVersion}"`);
      }
      const localKey = `${workspacePath}/node_modules/${pkgName}`;
      const resolvedEntry = Object.hasOwn(packagesTable, localKey) ? packagesTable[localKey] : packagesTable[`node_modules/${pkgName}`];
      if (!isPlainRecord(resolvedEntry) || resolvedEntry.version !== expectedVersion) {
        const actual = isPlainRecord(resolvedEntry) ? String(resolvedEntry.version) : 'missing';
        throw new Error(`package-lock.json resolved "${pkgName}" for "${workspacePath}" is "${actual}", expected "${expectedVersion}"`);
      }
    }
  }

  const expectedPiVersions = new Set(Object.values(expectedPackagesMap['packages/agent-pi']));
  if (expectedPiVersions.size !== 1) throw new Error('Expected @earendil-works/pi-* versions in packages/agent-pi must be lockstep');
  const expectedPiVersion = [...expectedPiVersions][0];
  for (const pkgName of Object.values(PI_UPSTREAM_MAP)) {
    const activePi = packagesTable[`packages/agent-pi/node_modules/${pkgName}`] ?? packagesTable[`node_modules/${pkgName}`];
    if (!isPlainRecord(activePi) || activePi.version !== expectedPiVersion) {
      throw new Error(`package-lock.json resolved "${pkgName}" does not match lockstep version "${expectedPiVersion}"`);
    }
  }
}

export function buildExpectedPackagesMap(piVersion, yamlVersion) {
  return Object.freeze({
    'packages/agent-pi': Object.freeze(Object.fromEntries(Object.values(PI_UPSTREAM_MAP).sort().map(p => [p, piVersion]))),
    'packages/cli': Object.freeze({ yaml: yamlVersion }),
    'packages/controller': Object.freeze({ yaml: yamlVersion }),
    'packages/decisions': Object.freeze({ yaml: yamlVersion }),
    'packages/github-app': Object.freeze({ yaml: yamlVersion }),
    'packages/taskpack': Object.freeze({ yaml: yamlVersion }),
  });
}

export function buildTargetVersionsPayload(piVersion, yamlVersion) {
  const upstreams = Object.fromEntries(
    ALL_UPSTREAM_IDS.map(id => [id, Object.freeze({ package: ALL_UPSTREAM_PACKAGES[id], version: id === 'yaml' ? yamlVersion : piVersion })]),
  );
  return Object.freeze({
    schema_version: 1,
    summary: `Loopwright runtime dependency ledger for @earendil-works/pi-* ${piVersion} and yaml ${yamlVersion}.`,
    upstreams: Object.freeze(upstreams),
    packages: buildExpectedPackagesMap(piVersion, yamlVersion),
  });
}

export async function auditBaselineParity(repoRoot) {
  const resolvedRepoRoot = resolve(repoRoot);
  const { parsed: proposal } = await readJsonRegularFile(resolvedRepoRoot, '.auto-sync/proposal.json', MAX_PROPOSAL_BYTES);

  if (proposal.schema_version !== 1) throw new Error(`.auto-sync/proposal.json schema_version must be 1 (received ${String(proposal.schema_version)})`);
  if (typeof proposal.summary !== 'string' || proposal.summary.trim().length === 0) throw new Error('.auto-sync/proposal.json summary must be a non-empty string');
  if (!isPlainRecord(proposal.upstreams) || !isPlainRecord(proposal.packages)) throw new Error('.auto-sync/proposal.json upstreams and packages must be plain objects');
  if (Object.keys(proposal.upstreams).length !== ALL_UPSTREAM_IDS.length || ALL_UPSTREAM_IDS.some(id => !Object.hasOwn(proposal.upstreams, id))) {
    throw new Error(`.auto-sync/proposal.json upstreams must contain exact keys [${ALL_UPSTREAM_IDS.join(', ')}]`);
  }

  const baselineByUpstream = Object.create(null);
  for (const upstreamId of ALL_UPSTREAM_IDS) {
    const entry = proposal.upstreams[upstreamId];
    const expectedPkg = ALL_UPSTREAM_PACKAGES[upstreamId];
    if (!isPlainRecord(entry) || entry.package !== expectedPkg || parseCanonicalSemver(entry.version) === null) {
      throw new Error(`.auto-sync/proposal.json upstreams["${upstreamId}"] must specify package "${expectedPkg}" and canonical X.Y.Z SemVer`);
    }
    baselineByUpstream[upstreamId] = entry.version;
  }

  const piVersions = new Set(PI_UPSTREAM_IDS.map(id => baselineByUpstream[id]));
  if (piVersions.size !== 1) throw new Error(`.auto-sync/proposal.json @earendil-works/pi-* baseline versions are skewed: ${[...piVersions].join(', ')}`);
  const piBaseline = baselineByUpstream['pi-coding-agent'];
  const yamlBaseline = baselineByUpstream.yaml;
  const expectedPackagesMap = buildExpectedPackagesMap(piBaseline, yamlBaseline);

  if (Object.keys(proposal.packages).length !== MANAGED_WORKSPACES.length || MANAGED_WORKSPACES.some(ws => !Object.hasOwn(proposal.packages, ws))) {
    throw new Error(`.auto-sync/proposal.json packages must contain exact keys [${MANAGED_WORKSPACES.join(', ')}]`);
  }

  for (const ws of MANAGED_WORKSPACES) {
    const recordedDeps = proposal.packages[ws];
    const expectedDeps = expectedPackagesMap[ws];
    const expectedDepNames = Object.keys(expectedDeps);
    if (!isPlainRecord(recordedDeps) || Object.keys(recordedDeps).length !== expectedDepNames.length || expectedDepNames.some(dep => recordedDeps[dep] !== expectedDeps[dep])) {
      throw new Error(`.auto-sync/proposal.json packages["${ws}"] drifts from proposal.upstreams`);
    }
    const { parsed: pkgManifest } = await readJsonRegularFile(resolvedRepoRoot, `${ws}/package.json`, MAX_MANIFEST_BYTES);
    if (!isPlainRecord(pkgManifest.dependencies)) throw new Error(`${ws}/package.json missing dependencies object`);
    for (const [depName, expectedVer] of Object.entries(expectedDeps)) {
      if (pkgManifest.dependencies[depName] !== expectedVer) {
        throw new Error(`Baseline drift in ${ws}/package.json: dependencies["${depName}"] is "${String(pkgManifest.dependencies[depName])}", expected "${expectedVer}" from .auto-sync/proposal.json`);
      }
    }
  }

  for (const ws of UNMANAGED_WORKSPACES) {
    const { parsed: pkgManifest } = await readJsonRegularFile(resolvedRepoRoot, `${ws}/package.json`, MAX_MANIFEST_BYTES);
    const deps = isPlainRecord(pkgManifest.dependencies) ? pkgManifest.dependencies : {};
    for (const depName of Object.keys(deps)) {
      if (depName === 'yaml' || depName.startsWith('@earendil-works/pi-')) {
        throw new Error(`Unexpected managed runtime dependency "${depName}" found in unmanaged workspace ${ws}/package.json`);
      }
    }
  }

  const { parsed: lockDoc, byteLength: lockfileBytes } = await readJsonRegularFile(resolvedRepoRoot, 'package-lock.json', MAX_LOCKFILE_BYTES);
  validateLockfileExpectedVersions(lockDoc, expectedPackagesMap);

  try {
    await runGit(['-C', resolvedRepoRoot, 'rev-parse', '--verify', 'HEAD^{commit}']);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`Repository "${resolvedRepoRoot}" must have a committed git HEAD: ${detail}`, { cause: error });
  }

  const auditedBaselinePaths = [
    '.auto-sync/proposal.json',
    'package.json',
    'package-lock.json',
    ...MANAGED_WORKSPACES.map(ws => `${ws}/package.json`),
    ...UNMANAGED_WORKSPACES.map(ws => `${ws}/package.json`),
  ];

  const { stdout: stagedDiffRaw } = await runGit(['-C', resolvedRepoRoot, 'diff', '--cached', '--name-only', '-z', '--', ...auditedBaselinePaths]);
  const stagedBaselineFiles = stagedDiffRaw.split('\0').filter(Boolean);
  if (stagedBaselineFiles.length > 0) {
    throw new Error(`Uncommitted staged baseline drift against HEAD in: ${stagedBaselineFiles.join(', ')}`);
  }

  for (const relPath of auditedBaselinePaths) {
    const maxBytes = relPath === 'package-lock.json' ? MAX_LOCKFILE_BYTES : MAX_MANIFEST_BYTES;
    const diskBytes = await readBoundedRegularFile(resolvedRepoRoot, relPath, maxBytes);
    let headBytes;
    try {
      const { stdout } = await runGit(['-C', resolvedRepoRoot, 'show', `HEAD:${relPath}`], {
        encoding: 'buffer',
        maxBuffer: MAX_LOCKFILE_BYTES + 64 * 1024,
      });
      headBytes = stdout;
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new Error(`Committed git HEAD is missing required baseline file "${relPath}": ${detail}`, { cause: error });
    }
    if (!diskBytes.equals(headBytes)) {
      throw new Error(`Uncommitted baseline drift in "${relPath}": working tree differs from committed HEAD`);
    }
  }

  return Object.freeze({
    proposal,
    baselineByUpstream: Object.freeze({ ...baselineByUpstream }),
    expectedPackagesMap,
    piBaseline,
    yamlBaseline,
    lockfileBytes,
  });
}

export function evaluateUpstreamEligibility({
  baselineByUpstream,
  discoveredRecords,
  force = false,
  upstreamGroups = DEFAULT_UPSTREAM_GROUPS,
}) {
  if (!isPlainRecord(baselineByUpstream)) throw new Error('baselineByUpstream must be a plain record');
  if (!Array.isArray(discoveredRecords)) throw new Error('discoveredRecords must be an array');

  const byId = new Map();
  for (const item of discoveredRecords) {
    if (!isPlainRecord(item) || typeof item.upstreamId !== 'string') {
      throw new Error('Each discovered upstream record must be an object with string upstreamId');
    }
    if (!Object.hasOwn(ALL_UPSTREAM_PACKAGES, item.upstreamId)) throw new Error(`Unknown upstreamId "${item.upstreamId}" in discoveredRecords`);
    if (byId.has(item.upstreamId)) throw new Error(`Duplicate upstreamId "${item.upstreamId}" in discoveredRecords`);
    byId.set(item.upstreamId, item);
  }
  for (const id of ALL_UPSTREAM_IDS) {
    if (!byId.has(id)) throw new Error(`Missing upstreamId "${id}" in discoveredRecords`);
  }

  const normalizedRecords = [];
  const failureById = new Map();
  const reasons = [];

  for (const id of ALL_UPSTREAM_IDS) {
    const baseline = baselineByUpstream[id];
    if (parseCanonicalSemver(baseline) === null) throw new Error(`Invalid baseline SemVer "${String(baseline)}" for "${id}"`);
    const raw = byId.get(id);
    if (raw.status === 'failed' || raw.status === 'blocked' || raw.underlyingStatus === 'failed' || raw.underlyingStatus === 'blocked') {
      const detail = typeof raw.reason === 'string' && raw.reason.trim().length > 0
        ? raw.reason.trim()
        : `upstream acquisition reported status=${String(raw.underlyingStatus ?? raw.status)}`;
      failureById.set(id, { reason: detail });
      reasons.push(`${id}: ${detail}`);
      continue;
    }

    const discoveredVer = typeof raw.targetVersion === 'string' ? raw.targetVersion : raw.version;
    if (typeof discoveredVer !== 'string' || parseCanonicalSemver(discoveredVer) === null) {
      const detail = `non-canonical SemVer "${typeof discoveredVer === 'string' ? discoveredVer : 'missing'}" rejected (expected strict X.Y.Z)`;
      failureById.set(id, { reason: detail });
      reasons.push(`${id}: ${detail}`);
      continue;
    }

    const cmp = compareCanonicalSemver(discoveredVer, baseline);
    if (cmp < 0) {
      const detail = `rollback rejected: discovered ${discoveredVer} is older than baseline ${baseline}`;
      failureById.set(id, { version: discoveredVer, reason: detail });
      reasons.push(`${id}: ${detail}`);
      continue;
    }

    normalizedRecords.push(Object.freeze({
      upstreamId: id,
      status: cmp === 0 ? 'up_to_date' : 'available',
      version: discoveredVer,
      currentVersion: baseline,
      ...(cmp > 0 ? { reason: `eligible upgrade from ${baseline} to ${discoveredVer}` } : {}),
    }));
  }

  const piBaseline = baselineByUpstream['pi-coding-agent'];
  const yamlBaseline = baselineByUpstream.yaml;

  if (failureById.size > 0) {
    const blockedRecords = ALL_UPSTREAM_IDS.map(id => {
      const failure = failureById.get(id);
      if (failure !== undefined) {
        return Object.freeze({
          upstreamId: id,
          status: 'blocked',
          currentVersion: baselineByUpstream[id],
          ...(typeof failure.version === 'string' ? { version: failure.version } : {}),
          reason: failure.reason,
        });
      }
      return Object.freeze({
        upstreamId: id,
        status: 'up_to_date',
        version: baselineByUpstream[id],
        currentVersion: baselineByUpstream[id],
        reason: `held at baseline ${baselineByUpstream[id]} due to rejected upstream metadata`,
      });
    });
    return Object.freeze({
      recommendedMode: 'blocked',
      actionMode: 'candidate',
      piOutcome: 'blocked',
      yamlOutcome: 'blocked',
      targetPiVersion: piBaseline,
      targetYamlVersion: yamlBaseline,
      targetVersions: buildTargetVersionsPayload(piBaseline, yamlBaseline),
      upstreamRecords: Object.freeze(blockedRecords),
      reasons: Object.freeze(reasons),
    });
  }

  const groupedRecords = taskpackModule.applyUpstreamGroups(normalizedRecords, upstreamGroups, baselineByUpstream);
  const intake = taskpackModule.evaluateUpstreamIntakeDisposition(groupedRecords, { force });
  const groupedById = new Map(groupedRecords.map(rec => [rec.upstreamId, rec]));
  const piLead = groupedById.get('pi-coding-agent');
  const yamlRec = groupedById.get('yaml');

  const piOutcome = piLead.status === 'available' ? 'upgrade' : piLead.status === 'held_back' ? 'partial_hold' : 'up_to_date';
  const yamlOutcome = yamlRec.status === 'available' ? 'upgrade' : 'up_to_date';
  const targetPiVersion = piOutcome === 'upgrade' ? piLead.version : piBaseline;
  const targetYamlVersion = yamlOutcome === 'upgrade' ? yamlRec.version : yamlBaseline;

  if (piOutcome === 'partial_hold' && typeof piLead.reason === 'string' && piLead.reason.length > 0) reasons.push(piLead.reason);
  if (force === true && intake.available.length === 0) reasons.push('forced candidate run at baseline');

  const recommendedMode = intake.disposition === 'candidate' ? 'candidate' : intake.disposition === 'no_change' ? 'no-change' : 'blocked';
  return Object.freeze({
    recommendedMode,
    actionMode: recommendedMode === 'no-change' ? 'no-change' : 'candidate',
    piOutcome,
    yamlOutcome,
    targetPiVersion,
    targetYamlVersion,
    targetVersions: buildTargetVersionsPayload(targetPiVersion, targetYamlVersion),
    upstreamRecords: groupedRecords,
    reasons: Object.freeze(reasons),
  });
}

function buildFixtureFetch(upstreamDescriptors, registryFixtures) {
  const bySource = new Map(upstreamDescriptors.map(desc => [desc.source, desc.id]));
  return async url => {
    const id = bySource.get(String(url));
    if (id === undefined || !Object.hasOwn(registryFixtures, id)) {
      return new globalThis.Response(JSON.stringify({ error: `missing registry fixture for ${String(id ?? url)}` }), {
        status: 404,
        headers: { 'content-type': 'application/json' },
      });
    }
    const fixture = registryFixtures[id];
    if (isPlainRecord(fixture) && fixture.__httpStatus !== undefined && fixture.__httpStatus !== 200) {
      return new globalThis.Response(JSON.stringify({ error: `HTTP ${String(fixture.__httpStatus)} from fixture ${id}` }), {
        status: Number(fixture.__httpStatus) || 500,
        headers: { 'content-type': 'application/json' },
      });
    }
    if (!isPlainRecord(fixture)) return new globalThis.Response('invalid fixture payload', { status: 500 });
    return new globalThis.Response(JSON.stringify(fixture), { status: 200, headers: { 'content-type': 'application/json' } });
  };
}

export async function discoverNpmUpstreams({ manifest, baselineByUpstream, fetchImpl = globalThis.fetch, registryFixtures }) {
  const effectiveManifest = manifest ?? { spec: { upstreams: DEFAULT_UPSTREAM_DESCRIPTORS, upstreamGroups: DEFAULT_UPSTREAM_GROUPS } };
  const effectiveFetch = registryFixtures !== undefined
    ? buildFixtureFetch(effectiveManifest.spec.upstreams, registryFixtures)
    : fetchImpl;
  const discovered = await taskpackModule.discoverTaskpackUpstreamsV2(effectiveManifest, {
    baselineVersions: baselineByUpstream,
    fetchImpl: effectiveFetch,
  });
  return discovered.records;
}

async function restoreTreeWritable(targetPath) {
  let info;
  try { info = await lstat(targetPath); } catch { return; }
  if (info.isSymbolicLink() || !info.isDirectory()) return;
  await chmod(targetPath, 0o700).catch(() => undefined);
  for (const entry of await readdir(targetPath)) await restoreTreeWritable(join(targetPath, entry));
}

async function freezeTreeReadOnly(targetPath) {
  const info = await lstat(targetPath);
  if (info.isSymbolicLink()) throw new Error(`Refusing symlink inside stage directory: "${targetPath}"`);
  if (info.isDirectory()) {
    for (const entry of await readdir(targetPath)) await freezeTreeReadOnly(join(targetPath, entry));
    await chmod(targetPath, 0o555);
  } else if (info.isFile()) {
    if (info.nlink > 1) throw new Error(`Refusing hardlinked file inside stage directory: "${targetPath}"`);
    await chmod(targetPath, 0o444);
  } else {
    throw new Error(`Refusing non-regular entry inside stage directory: "${targetPath}"`);
  }
}

function buildSanitizedNpmEnv(cacheDir, registryUrl) {
  const nodeBinDir = dirname(process.execPath);
  return {
    PATH: process.env.PATH ? `${nodeBinDir}:${process.env.PATH}` : `${nodeBinDir}:/usr/local/bin:/usr/bin:/bin`,
    HOME: cacheDir,
    TMPDIR: tmpdir(),
    LANG: 'C.UTF-8',
    LC_ALL: 'C.UTF-8',
    NPM_CONFIG_CACHE: cacheDir,
    npm_config_audit: 'false',
    npm_config_fund: 'false',
    npm_config_ignore_scripts: 'true',
    npm_config_update_notifier: 'false',
    ...(typeof registryUrl === 'string' && registryUrl.length > 0 ? { npm_config_registry: registryUrl } : {}),
  };
}

export async function defaultLockfileBuilder({ repoRoot, targetVersions, npmCacheDir, registryUrl }) {
  const workHolder = await mkdtemp(join(tmpdir(), 'loopwright-self-upgrade-work-'));
  try {
    await writeFile(join(workHolder, 'package.json'), await readBoundedRegularFile(repoRoot, 'package.json', MAX_MANIFEST_BYTES), { mode: 0o600 });
    await writeFile(join(workHolder, 'package-lock.json'), await readBoundedRegularFile(repoRoot, 'package-lock.json', MAX_LOCKFILE_BYTES), { mode: 0o600 });

    const allWorkspaces = [...MANAGED_WORKSPACES, ...UNMANAGED_WORKSPACES];
    for (const ws of allWorkspaces) {
      const wsDir = join(workHolder, ws);
      await mkdir(wsDir, { recursive: true, mode: 0o700 });
      const { parsed: manifest } = await readJsonRegularFile(repoRoot, `${ws}/package.json`, MAX_MANIFEST_BYTES);
      if (Object.hasOwn(targetVersions.packages, ws)) {
        manifest.dependencies = { ...manifest.dependencies, ...targetVersions.packages[ws] };
      }
      await writeFile(join(wsDir, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
    }

    const npmBin = resolveNpmExecutable();
    const npmEnv = buildSanitizedNpmEnv(npmCacheDir, registryUrl);
    const npmOpts = { cwd: workHolder, env: npmEnv, timeout: 300_000, maxBuffer: 16 * 1024 * 1024 };
    await execFileAsync(npmBin, ['install', '--package-lock-only', '--ignore-scripts', '--no-audit', '--no-fund', '--cache', npmCacheDir], npmOpts);
    const candidateLockBytes = await readBoundedRegularFile(workHolder, 'package-lock.json', MAX_LOCKFILE_BYTES);
    await execFileAsync(npmBin, ['ci', '--ignore-scripts', '--no-audit', '--no-fund', '--cache', npmCacheDir], npmOpts);

    const { parsed: rootPkg } = await readJsonRegularFile(repoRoot, 'package.json', MAX_MANIFEST_BYTES);
    const packRuntimeDeps = Object.create(null);
    if (isPlainRecord(rootPkg.overrides)) {
      for (const [depName, depVer] of Object.entries(rootPkg.overrides)) {
        if (typeof depVer === 'string') packRuntimeDeps[depName] = depVer;
      }
    }
    for (const ws of allWorkspaces) {
      const { parsed: wsManifest } = await readJsonRegularFile(workHolder, `${ws}/package.json`, MAX_MANIFEST_BYTES);
      if (isPlainRecord(wsManifest.dependencies)) {
        for (const [depName, depVer] of Object.entries(wsManifest.dependencies)) {
          if (!depName.startsWith('@loopwright/') && typeof depVer === 'string') packRuntimeDeps[depName] = depVer;
        }
      }
    }
    const packWarmDir = join(workHolder, '_pack-cache-warm');
    await mkdir(packWarmDir, { recursive: true, mode: 0o700 });
    await writeFile(
      join(packWarmDir, 'package.json'),
      `${JSON.stringify({ name: 'loopwright-pack-cache-warm', version: '0.0.0', private: true, dependencies: packRuntimeDeps }, null, 2)}\n`,
      { mode: 0o600 },
    );
    await execFileAsync(
      npmBin,
      ['install', '--ignore-scripts', '--no-audit', '--no-fund', '--cache', npmCacheDir],
      { cwd: packWarmDir, env: npmEnv, timeout: 180_000, maxBuffer: 16 * 1024 * 1024 },
    );
    return candidateLockBytes;
  } finally {
    await rm(workHolder, { recursive: true, force: true }).catch(() => undefined);
  }
}

export async function packNpmCacheArchive(npmCacheDir, archivePath) {
  await rm(join(npmCacheDir, '_cacache', 'tmp'), { recursive: true, force: true }).catch(() => undefined);
  const packScript = `
import gzip, os, stat, sys, tarfile
src_root, out_path = os.path.realpath(sys.argv[1]), sys.argv[2]
SKIP_TOP = {"_logs", "_npx", "tmp"}
entries = []
for root, dirs, files in os.walk(src_root, topdown=True, followlinks=False):
    rel_dir = os.path.relpath(root, src_root)
    if rel_dir == ".": dirs[:] = sorted(d for d in dirs if d not in SKIP_TOP)
    elif rel_dir == "_cacache": dirs[:] = sorted(d for d in dirs if d != "tmp")
    else: dirs.sort()
    for dname in dirs:
        full_d = os.path.join(root, dname)
        st_d = os.lstat(full_d)
        if stat.S_ISLNK(st_d.st_mode) or not stat.S_ISDIR(st_d.st_mode):
            raise RuntimeError(f"forbidden symlink or non-directory in npm cache: {full_d}")
    for fname in sorted(files):
        full_f = os.path.join(root, fname)
        st_f = os.lstat(full_f)
        if stat.S_ISLNK(st_f.st_mode) or not stat.S_ISREG(st_f.st_mode):
            raise RuntimeError(f"forbidden symlink or non-regular file in npm cache: {full_f}")
        if st_f.st_nlink > 1:
            raise RuntimeError(f"forbidden hardlink in npm cache: {full_f}")
        entries.append((os.path.relpath(full_f, src_root).replace(os.sep, "/"), full_f, st_f.st_size))
entries.sort(key=lambda item: item[0])
with open(out_path, "wb") as raw_f:
    with gzip.GzipFile(filename="", mode="wb", fileobj=raw_f, compresslevel=6, mtime=0) as gz_f:
        with tarfile.open(fileobj=gz_f, mode="w", format=tarfile.PAX_FORMAT) as tf:
            for rel_f, full_f, size in entries:
                info = tarfile.TarInfo(name=rel_f)
                info.size, info.mode, info.mtime, info.uid, info.gid, info.uname, info.gname = size, 0o644, 0, 0, 0, "", ""
                with open(full_f, "rb") as src_f: tf.addfile(info, src_f)
`;
  await execFileAsync(resolvePythonExecutable(), ['-c', packScript, npmCacheDir, archivePath], {
    env: { PATH: process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin', LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8' },
    timeout: 120_000,
    maxBuffer: 4 * 1024 * 1024,
  });
  const archiveStat = await lstat(archivePath);
  if (archiveStat.isSymbolicLink() || !archiveStat.isFile() || archiveStat.nlink !== 1) {
    throw new Error(`Packed npm-cache archive "${archivePath}" must be a regular single-link file`);
  }
  if (archiveStat.size > MAX_NPM_CACHE_ARCHIVE_BYTES) {
    throw new Error(`Packed npm-cache archive (${archiveStat.size} bytes) exceeds ${MAX_NPM_CACHE_ARCHIVE_BYTES} bytes`);
  }
  return archiveStat.size;
}

export async function computeUnifiedLockfilePatch(baselineLockPath, candidateLockPath) {
  let rawDiff;
  try {
    const { stdout } = await runGit(
      ['diff', '--no-index', '--no-color', '--no-ext-diff', '--unified=3', '--', baselineLockPath, candidateLockPath],
      { timeout: 30_000, maxBuffer: 4 * 1024 * 1024 },
    );
    rawDiff = stdout;
  } catch (error) {
    if (error && typeof error === 'object' && error.code === 1 && typeof error.stdout === 'string') {
      rawDiff = error.stdout;
    } else {
      const detail = error instanceof Error ? error.message : String(error);
      throw new Error(`Failed to compute unified diff for package-lock.json: ${detail}`, { cause: error });
    }
  }
  if (rawDiff.length === 0) return '';
  const lines = rawDiff.split('\n');
  const firstHunkIdx = lines.findIndex(line => line.startsWith('@@ '));
  if (firstHunkIdx < 0) throw new Error('Computed package-lock.json diff did not contain unified diff hunks');
  return `--- a/package-lock.json\n+++ b/package-lock.json\n${lines.slice(firstHunkIdx).join('\n')}`;
}

/**
 * Split a unified diff into ordered UTF-8 slices (`<= maxChunkBytes` each, `<= maxTotalBytes` total),
 * preferring `@@ ` hunk boundaries whenever individual hunks fit within `maxChunkBytes` and falling back
 * to line boundaries for oversized contiguous hunks. Returned slices are ordered byte parts (not standalone
 * patches) and MUST be concatenated in part order (`chunks.join('') === patchText`) before `git apply`,
 * matching `.auto-sync/instructions.md`.
 */
export function splitPromptPatchChunks(
  patchText,
  maxChunkBytes = MAX_PROMPT_RESOURCE_BYTES,
  maxTotalBytes = MAX_PROMPT_PATCH_TOTAL_BYTES,
) {
  if (typeof patchText !== 'string' || patchText.length === 0) return Object.freeze([]);
  const totalBytes = Buffer.byteLength(patchText, 'utf8');
  if (totalBytes > maxTotalBytes) return Object.freeze([]);
  if (totalBytes <= maxChunkBytes) return Object.freeze([patchText]);

  const lines = patchText.match(/[^\n]*\n|[^\n]+$/g) ?? [];
  const hunkSegments = [];
  let currentHunkLines = [];
  let seenFirstHunkHeader = false;
  for (const line of lines) {
    if (line.startsWith('@@ ')) {
      if (seenFirstHunkHeader && currentHunkLines.length > 0) {
        hunkSegments.push(currentHunkLines);
        currentHunkLines = [];
      }
      seenFirstHunkHeader = true;
    }
    currentHunkLines.push(line);
  }
  if (currentHunkLines.length > 0) hunkSegments.push(currentHunkLines);

  const chunks = [];
  let currentParts = [];
  let currentBytes = 0;
  for (const segmentLines of hunkSegments) {
    const segmentText = segmentLines.join('');
    const segmentBytes = Buffer.byteLength(segmentText, 'utf8');
    if (segmentBytes <= maxChunkBytes) {
      if (currentBytes + segmentBytes > maxChunkBytes && currentParts.length > 0) {
        chunks.push(currentParts.join(''));
        currentParts = [];
        currentBytes = 0;
      }
      currentParts.push(segmentText);
      currentBytes += segmentBytes;
    } else {
      for (const line of segmentLines) {
        const lineBytes = Buffer.byteLength(line, 'utf8');
        if (lineBytes > maxChunkBytes) return Object.freeze([]);
        if (currentBytes + lineBytes > maxChunkBytes && currentParts.length > 0) {
          chunks.push(currentParts.join(''));
          currentParts = [];
          currentBytes = 0;
        }
        currentParts.push(line);
        currentBytes += lineBytes;
      }
    }
  }
  if (currentParts.length > 0) chunks.push(currentParts.join(''));
  return Object.freeze(chunks);
}

async function prepareCanonicalStageDir(repoRoot, stageDir, preserveStageDirRoot) {
  const resolvedRepo = await realpath(resolve(repoRoot));
  const absStageDir = resolve(stageDir);
  const stageParent = dirname(absStageDir);
  await mkdir(stageParent, { recursive: true, mode: 0o755 });
  const canonicalStageDir = join(await realpath(stageParent), relative(stageParent, absStageDir));
  if (isInsidePath(canonicalStageDir, resolvedRepo) || isInsidePath(resolvedRepo, canonicalStageDir)) {
    throw new Error(`Stage directory "${canonicalStageDir}" must be disjoint from repository root "${resolvedRepo}"`);
  }
  if (!preserveStageDirRoot) {
    await restoreTreeWritable(canonicalStageDir);
    await rm(canonicalStageDir, { recursive: true, force: true });
    await mkdir(canonicalStageDir, { recursive: true, mode: 0o755 });
  } else {
    await mkdir(canonicalStageDir, { recursive: true, mode: 0o700 });
  }
  return { resolvedRepo, canonicalStageDir };
}

async function finalizeStagePermissions(canonicalStageDir, stagedFiles, preserveStageDirRoot) {
  if (!preserveStageDirRoot) {
    await freezeTreeReadOnly(canonicalStageDir);
  } else {
    for (const stagedFile of stagedFiles) await chmod(stagedFile, 0o444);
  }
}

export async function stageNoChangeBundle({ repoRoot, stageDir, targetVersions, preserveStageDirRoot = false }) {
  const { canonicalStageDir } = await prepareCanonicalStageDir(repoRoot, stageDir, preserveStageDirRoot);
  const targetVersionsPath = join(canonicalStageDir, 'target-versions.json');
  const preflightMetadataPath = join(canonicalStageDir, 'preflight-metadata.json');
  const targetVersionsRaw = `${JSON.stringify(targetVersions, null, 2)}\n`;
  const preflightMetadataRaw = `${JSON.stringify({ schema_version: 1, force: false, disposition: 'no_change' }, null, 2)}\n`;
  const targetVersionsBytes = Buffer.byteLength(targetVersionsRaw, 'utf8');
  const preflightMetadataBytes = Buffer.byteLength(preflightMetadataRaw, 'utf8');
  if (targetVersionsBytes > MAX_PROMPT_RESOURCE_BYTES || preflightMetadataBytes > MAX_PROMPT_RESOURCE_BYTES) {
    throw new Error(`Staged no-change metadata exceeds ${MAX_PROMPT_RESOURCE_BYTES} bytes per-resource ceiling`);
  }
  await writeFile(targetVersionsPath, targetVersionsRaw, { mode: 0o644 });
  await writeFile(preflightMetadataPath, preflightMetadataRaw, { mode: 0o644 });
  await finalizeStagePermissions(canonicalStageDir, [targetVersionsPath, preflightMetadataPath], preserveStageDirRoot);
  return Object.freeze({
    kind: 'no-change',
    stageDir: canonicalStageDir,
    targetVersionsPath,
    preflightMetadataPath,
    candidateLockPath: null,
    lockfilePatchPath: null,
    lockfilePatchPaths: Object.freeze([]),
    npmCacheArchivePath: null,
    candidateLockBytes: 0,
    lockfilePatchBytes: 0,
    npmCacheArchiveBytes: 0,
  });
}

export async function stageCandidateBundle({
  repoRoot,
  stageDir,
  targetVersions,
  force = false,
  lockfileBuilder = defaultLockfileBuilder,
  preserveStageDirRoot = false,
}) {
  if (typeof force !== 'boolean') throw new Error('stageCandidateBundle force option must be a boolean');
  const { resolvedRepo, canonicalStageDir } = await prepareCanonicalStageDir(repoRoot, stageDir, preserveStageDirRoot);

  const npmCacheWorkDir = await mkdtemp(join(tmpdir(), 'loopwright-npm-cache-build-'));
  let candidateLockBytes;
  let npmCacheArchiveBytes;
  const npmCacheArchivePath = join(canonicalStageDir, 'npm-cache.tgz');
  try {
    candidateLockBytes = await lockfileBuilder({ repoRoot: resolvedRepo, targetVersions, npmCacheDir: npmCacheWorkDir });
    if (candidateLockBytes.byteLength > MAX_LOCKFILE_BYTES) {
      throw new Error(`Staged package-lock.candidate.json (${candidateLockBytes.byteLength} bytes) exceeds ${MAX_LOCKFILE_BYTES} bytes`);
    }
    let parsedCandidateLock;
    try {
      parsedCandidateLock = JSON.parse(candidateLockBytes.toString('utf8'));
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new Error(`Staged package-lock.candidate.json is invalid JSON: ${detail}`, { cause: error });
    }
    validateLockfileExpectedVersions(parsedCandidateLock, targetVersions.packages);
    npmCacheArchiveBytes = await packNpmCacheArchive(npmCacheWorkDir, npmCacheArchivePath);
  } finally {
    await rm(npmCacheWorkDir, { recursive: true, force: true }).catch(() => undefined);
  }

  const targetVersionsPath = join(canonicalStageDir, 'target-versions.json');
  const preflightMetadataPath = join(canonicalStageDir, 'preflight-metadata.json');
  const candidateLockPath = join(canonicalStageDir, 'package-lock.candidate.json');
  const targetVersionsRaw = `${JSON.stringify(targetVersions, null, 2)}\n`;
  const preflightMetadataRaw = `${JSON.stringify({ schema_version: 1, force }, null, 2)}\n`;
  const targetVersionsBytes = Buffer.byteLength(targetVersionsRaw, 'utf8');
  const preflightMetadataBytes = Buffer.byteLength(preflightMetadataRaw, 'utf8');
  if (targetVersionsBytes > MAX_PROMPT_RESOURCE_BYTES) {
    throw new Error(`Staged target-versions.json (${targetVersionsBytes} bytes) exceeds ${MAX_PROMPT_RESOURCE_BYTES} bytes`);
  }
  const workspaceTotalBytes = targetVersionsBytes + preflightMetadataBytes + candidateLockBytes.byteLength + npmCacheArchiveBytes;
  if (workspaceTotalBytes > MAX_WORKSPACE_RESOURCES_TOTAL_BYTES) {
    throw new Error(`Staged workspace resources (${workspaceTotalBytes} bytes) exceed ${MAX_WORKSPACE_RESOURCES_TOTAL_BYTES} bytes`);
  }
  await writeFile(targetVersionsPath, targetVersionsRaw, { mode: 0o644 });
  await writeFile(preflightMetadataPath, preflightMetadataRaw, { mode: 0o644 });
  await writeFile(candidateLockPath, candidateLockBytes, { mode: 0o644 });

  const baselineLockPath = await assertNoSymlinkChain(resolvedRepo, 'package-lock.json');
  const patchText = await computeUnifiedLockfilePatch(baselineLockPath, candidateLockPath);
  const patchBytes = Buffer.byteLength(patchText, 'utf8');
  const lockfilePatchPaths = [];
  let lockfilePatchBytes = 0;
  if (patchBytes > 0) {
    if (patchBytes > MAX_PROMPT_PATCH_TOTAL_BYTES) {
      throw new Error(
        `Computed package-lock.json unified diff (${patchBytes} bytes) exceeds ${MAX_PROMPT_PATCH_TOTAL_BYTES} bytes prompt patch ceiling`,
      );
    }
    if (targetVersionsBytes + patchBytes > MAX_PROMPT_RESOURCES_TOTAL_BYTES) {
      throw new Error(
        `Staged prompt resources (${targetVersionsBytes + patchBytes} bytes) exceed ${MAX_PROMPT_RESOURCES_TOTAL_BYTES} bytes`,
      );
    }
    const patchChunks = splitPromptPatchChunks(patchText, MAX_PROMPT_RESOURCE_BYTES, MAX_PROMPT_PATCH_TOTAL_BYTES);
    if (patchChunks.length === 0) {
      throw new Error(
        `Computed package-lock.json unified diff (${patchBytes} bytes) exceeds ${MAX_PROMPT_PATCH_TOTAL_BYTES} bytes or contains a line exceeding ${MAX_PROMPT_RESOURCE_BYTES} bytes`,
      );
    }
    lockfilePatchBytes = patchBytes;
    if (patchChunks.length === 1) {
      const singlePatchPath = join(canonicalStageDir, 'package-lock.patch');
      lockfilePatchPaths.push(singlePatchPath);
      await writeFile(singlePatchPath, patchChunks[0], { mode: 0o644 });
    } else {
      for (let idx = 0; idx < patchChunks.length; idx += 1) {
        const partPath = join(canonicalStageDir, `package-lock.patch.part${idx + 1}`);
        lockfilePatchPaths.push(partPath);
        await writeFile(partPath, patchChunks[idx], { mode: 0o644 });
      }
    }
  }
  const lockfilePatchPath = lockfilePatchPaths.length === 1 ? lockfilePatchPaths[0] : null;

  await finalizeStagePermissions(
    canonicalStageDir,
    [targetVersionsPath, preflightMetadataPath, candidateLockPath, npmCacheArchivePath, ...lockfilePatchPaths],
    preserveStageDirRoot,
  );

  return Object.freeze({
    kind: 'candidate',
    stageDir: canonicalStageDir,
    targetVersionsPath,
    preflightMetadataPath,
    candidateLockPath,
    lockfilePatchPath,
    lockfilePatchPaths: Object.freeze(lockfilePatchPaths),
    npmCacheArchivePath,
    candidateLockBytes: candidateLockBytes.byteLength,
    lockfilePatchBytes,
    npmCacheArchiveBytes,
  });
}

export async function verifyTaskpackOfflineCompilation(repoRoot, { allowMissingVerifyScript = false } = {}) {
  const resolvedRepo = resolve(repoRoot);
  const hostPolicy = { allowPrivileged: true, allowWorkflowWrites: false };
  const manifest = await taskpackModule.loadDeclarativeTaskpack({
    manifestPath: join(resolvedRepo, '.auto-sync/taskpack.yaml'),
    repositoryRoot: resolvedRepo,
    hostPolicy,
  });

  const verifyRelPath = '.auto-sync/checks/verify.sh';
  if (existsSync(join(resolvedRepo, verifyRelPath))) {
    await readBoundedRegularFile(resolvedRepo, verifyRelPath, MAX_HTTP_JSON_BYTES);
  } else if (!allowMissingVerifyScript) {
    throw new Error(`Missing required command.v1 verification script "${verifyRelPath}"`);
  }

  const baseBindings = {
    repository: 'gpustack/loopwright',
    baseRevision: '0'.repeat(40),
    sourceRevision: '0'.repeat(40),
    repositoryRoot: resolvedRepo,
    taskpackPath: '.auto-sync/taskpack.yaml',
    executionMode: 'delegated',
    hostPolicy,
    budgets: taskpackModule.DEFAULT_HOST_BUDGETS,
  };
  return Object.freeze({
    manifest,
    candidateCompiled: await taskpackModule.compileDeclarativeTaskpack(manifest, { ...baseBindings, mode: 'candidate' }),
    noChangeCompiled: await taskpackModule.compileDeclarativeTaskpack(manifest, { ...baseBindings, mode: 'no-change' }),
  });
}

function buildStagedResourceDescriptors(staged) {
  if (staged === null) return [];
  if (staged.kind === 'no-change') {
    return [
      { id: 'target-versions', kind: 'document', path: 'target-versions.json', mount: 'workspace', exposeToChecks: true },
      { id: 'preflight-metadata', kind: 'document', path: 'preflight-metadata.json', mount: 'workspace', exposeToChecks: true },
    ];
  }
  let patchPaths = [];
  if (Array.isArray(staged.lockfilePatchPaths) && staged.lockfilePatchPaths.length > 0) {
    patchPaths = staged.lockfilePatchPaths;
  } else if (typeof staged.lockfilePatchPath === 'string' && staged.lockfilePatchPath.length > 0) {
    patchPaths = [staged.lockfilePatchPath];
  }
  const promptPatchDescriptors = patchPaths.map((stagedFilePath, idx) => {
    const fileName = basename(stagedFilePath);
    const id = fileName === 'package-lock.patch' ? 'package-lock-patch' : `package-lock-patch-part-${idx + 1}`;
    return { id, kind: 'document', path: fileName, mount: 'prompt', exposeToChecks: false };
  });
  return [
    { id: 'target-versions-prompt', kind: 'document', path: 'target-versions.json', mount: 'prompt', exposeToChecks: false },
    ...promptPatchDescriptors,
    { id: 'target-versions', kind: 'document', path: 'target-versions.json', mount: 'workspace', exposeToChecks: true },
    { id: 'preflight-metadata', kind: 'document', path: 'preflight-metadata.json', mount: 'workspace', exposeToChecks: true },
    { id: 'package-lock-candidate', kind: 'document', path: 'package-lock.candidate.json', mount: 'workspace', exposeToChecks: true },
    { id: 'npm-cache-archive', kind: 'document', path: 'npm-cache.tgz', mount: 'workspace', exposeToChecks: true },
  ];
}

export function formatPreflightOutput(result) {
  let disposition = 'blocked';
  if (result.recommendedMode === 'candidate') {
    disposition = 'candidate';
  } else if (result.recommendedMode === 'no-change') {
    disposition = 'no_change';
  }
  const reasons = result.evaluation?.reasons ?? [];
  let reason = 'Self-upgrade preflight blocked.';
  if (reasons.length > 0) {
    reason = reasons.join('; ');
  } else if (disposition === 'no_change') {
    reason = 'All tracked runtime dependencies match baseline.';
  } else if (disposition === 'candidate') {
    const piVer = result.evaluation?.targetPiVersion ?? result.baseline.piBaseline;
    const yamlVer = result.evaluation?.targetYamlVersion ?? result.baseline.yamlBaseline;
    reason = `Staged self-upgrade bundle for @earendil-works/pi-* ${piVer} and yaml ${yamlVer}.`;
  }
  const upstreams = result.upstreamRecords.map(rec => ({
    id: rec.upstreamId,
    status: rec.status,
    ...(typeof rec.version === 'string' ? { version: rec.version } : {}),
    ...(typeof rec.currentVersion === 'string' ? { currentVersion: rec.currentVersion } : {}),
    ...(typeof rec.reason === 'string' && rec.reason.length > 0 ? { reason: rec.reason } : {}),
  }));
  const stagedResources = buildStagedResourceDescriptors(result.staged);

  return Object.freeze({ disposition, reason, upstreams: Object.freeze(upstreams), stagedResources: Object.freeze(stagedResources) });
}

export async function runPrepareSelfUpgrade(options = {}) {
  const repoRoot = resolve(options.repoRoot ?? process.env.LOOPWRIGHT_REPO_ROOT ?? process.cwd());
  const stageDir = resolve(options.stageDir ?? process.env.LOOPWRIGHT_STAGING_DIR ?? process.env.SELF_UPGRADE_STAGE_DIR ?? DEFAULT_STAGE_DIR);
  const requestedMode = options.requestedMode ?? 'auto';
  if (!['auto', 'candidate', 'no-change'].includes(requestedMode)) {
    throw new Error(`Invalid --requested-mode "${String(requestedMode)}" (expected auto, candidate, or no-change)`);
  }
  const force = options.force === true;
  if (force && requestedMode === 'no-change') throw new Error('Refusing --force with --requested-mode no-change');

  const baseline = await auditBaselineParity(repoRoot);
  const makeResult = (overrides) => {
    const effectiveStageDir = overrides.staged ? overrides.staged.stageDir : stageDir;
    return Object.freeze({
      offlineCheck: false,
      upstreamVerified: true,
      stageDir: effectiveStageDir,
      npmCacheArchivePath: join(effectiveStageDir, 'npm-cache.tgz'),
      baseline,
      evaluation: null,
      staged: null,
      ...overrides,
    });
  };

  if (options.offlineCheck === true) {
    const compiled = await verifyTaskpackOfflineCompilation(repoRoot, { allowMissingVerifyScript: true });
    return makeResult({
      offlineCheck: true,
      upstreamVerified: false,
      recommendedMode: 'no-change',
      actionMode: 'no-change',
      taskpackName: compiled.manifest.metadata.name,
      upstreamRecords: Object.freeze(ALL_UPSTREAM_IDS.map(id => Object.freeze({
        upstreamId: id,
        status: 'up_to_date',
        version: baseline.baselineByUpstream[id],
        currentVersion: baseline.baselineByUpstream[id],
        reason: 'synthetic offline smoke check (upstreams not queried)',
      }))),
    });
  }

  const manifestPath = join(repoRoot, '.auto-sync/taskpack.yaml');
  const manifest = existsSync(manifestPath)
    ? await taskpackModule.loadDeclarativeTaskpack({ manifestPath, repositoryRoot: repoRoot, hostPolicy: { allowPrivileged: true, allowWorkflowWrites: false } })
    : undefined;

  const discoveredRecords = options.discoveredRecords !== undefined
    ? options.discoveredRecords
    : await discoverNpmUpstreams({ manifest, baselineByUpstream: baseline.baselineByUpstream, fetchImpl: options.fetchImpl, registryFixtures: options.registryFixtures });

  const evaluation = evaluateUpstreamEligibility({
    baselineByUpstream: baseline.baselineByUpstream,
    discoveredRecords,
    force,
    upstreamGroups: manifest?.spec?.upstreamGroups ?? DEFAULT_UPSTREAM_GROUPS,
  });

  const underPreflightContract = options.stageNoChange === true
    || options.preserveStageDirRoot === true
    || Boolean(process.env.LOOPWRIGHT_PREFLIGHT_OUT)
    || Boolean(process.env.LOOPWRIGHT_STAGING_DIR);

  if (requestedMode === 'no-change' && evaluation.recommendedMode !== 'no-change') {
    const refusedRecords = evaluation.upstreamRecords.map(rec => (
      rec.status === 'available'
        ? Object.freeze({
          upstreamId: rec.upstreamId,
          status: 'blocked',
          currentVersion: rec.currentVersion,
          ...(typeof rec.version === 'string' ? { version: rec.version } : {}),
          reason: `requested no-change mode while eligible upgrade to ${String(rec.version)} is available`,
        })
        : rec
    ));
    return makeResult({ recommendedMode: 'blocked', actionMode: 'no-change', evaluation, upstreamRecords: Object.freeze(refusedRecords) });
  }

  let staged = null;
  if (evaluation.recommendedMode === 'candidate' && options.skipStage !== true) {
    staged = await stageCandidateBundle({
      repoRoot,
      stageDir,
      targetVersions: evaluation.targetVersions,
      force,
      lockfileBuilder: options.lockfileBuilder,
      preserveStageDirRoot: options.preserveStageDirRoot === true,
    });
  } else if (evaluation.recommendedMode === 'no-change' && options.skipStage !== true && underPreflightContract) {
    staged = await stageNoChangeBundle({
      repoRoot,
      stageDir,
      targetVersions: evaluation.targetVersions,
      preserveStageDirRoot: options.preserveStageDirRoot === true,
    });
  }

  return makeResult({
    recommendedMode: evaluation.recommendedMode,
    actionMode: evaluation.actionMode,
    evaluation,
    staged,
    upstreamRecords: evaluation.upstreamRecords,
  });
}

async function readJsonArgOrFile(rawArg, repoRoot) {
  if (rawArg.startsWith('@')) {
    return JSON.parse((await readBoundedAbsoluteFile(resolve(repoRoot, rawArg.slice(1)), MAX_HTTP_JSON_BYTES)).toString('utf8'));
  }
  return JSON.parse(rawArg);
}

const parseBoolEnv = value => value === 'true' || value === '1';

function parseCliArgs(argv) {
  const parsed = {
    repoRoot: process.env.LOOPWRIGHT_REPO_ROOT ?? process.cwd(),
    stageDir: undefined,
    upstreamRecordsRaw: undefined,
    registryJsonRaw: process.env.SELF_UPGRADE_REGISTRY_FIXTURES,
    lockfileFixturePath: process.env.SELF_UPGRADE_LOCKFILE_FIXTURE,
    requestedMode: process.env.LOOPWRIGHT_REQUESTED_MODE ?? process.env.SELF_UPGRADE_REQUESTED_MODE ?? 'auto',
    force: parseBoolEnv(process.env.LOOPWRIGHT_FORCE) || parseBoolEnv(process.env.SELF_UPGRADE_FORCE),
    skipStage: parseBoolEnv(process.env.SELF_UPGRADE_SKIP_STAGE),
    offlineCheck: false,
    json: false,
  };
  const valueFlags = {
    '--repo': 'repoRoot',
    '--stage-dir': 'stageDir',
    '--upstream-records': 'upstreamRecordsRaw',
    '--registry-json': 'registryJsonRaw',
    '--requested-mode': 'requestedMode',
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--offline-check') parsed.offlineCheck = true;
    else if (arg === '--force') parsed.force = true;
    else if (arg === '--skip-stage') parsed.skipStage = true;
    else if (arg === '--json') parsed.json = true;
    else if (Object.hasOwn(valueFlags, arg) && i + 1 < argv.length) {
      i += 1;
      parsed[valueFlags[arg]] = argv[i];
    } else {
      throw new Error(`Unknown or incomplete CLI argument: "${arg}"`);
    }
  }
  return parsed;
}

async function writePreflightOutputFile(outPath, payload) {
  const handle = await open(
    resolve(outPath),
    fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_TRUNC | (fsConstants.O_NOFOLLOW ?? 0),
    0o600,
  );
  try {
    await handle.writeFile(`${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  } finally {
    await handle.close();
  }
}

async function main() {
  const preflightOutPath = process.env.LOOPWRIGHT_PREFLIGHT_OUT;
  const isPreflightMode = typeof preflightOutPath === 'string' && preflightOutPath.trim().length > 0;
  const cli = parseCliArgs(process.argv.slice(2));
  if (cli.offlineCheck && isPreflightMode) {
    throw new Error('Refusing --offline-check with LOOPWRIGHT_PREFLIGHT_OUT; preflight mode requires upstream verification');
  }
  const resolvedRepo = resolve(cli.repoRoot);
  const discoveredRecords = cli.upstreamRecordsRaw !== undefined ? await readJsonArgOrFile(cli.upstreamRecordsRaw, resolvedRepo) : undefined;
  const registryFixtures = cli.registryJsonRaw !== undefined && cli.registryJsonRaw.trim().length > 0 ? await readJsonArgOrFile(cli.registryJsonRaw, resolvedRepo) : undefined;
  const lockfileBuilder = typeof cli.lockfileFixturePath === 'string' && cli.lockfileFixturePath.trim().length > 0
    ? async () => await readBoundedAbsoluteFile(cli.lockfileFixturePath, MAX_LOCKFILE_BYTES)
    : undefined;

  const result = await runPrepareSelfUpgrade({
    repoRoot: resolvedRepo,
    stageDir: cli.stageDir,
    requestedMode: cli.requestedMode,
    force: cli.force,
    skipStage: cli.skipStage,
    offlineCheck: cli.offlineCheck,
    discoveredRecords,
    registryFixtures,
    lockfileBuilder,
    preserveStageDirRoot: isPreflightMode,
    stageNoChange: isPreflightMode,
  });

  if (isPreflightMode) {
    await writePreflightOutputFile(preflightOutPath, formatPreflightOutput(result));
    return;
  }

  if (cli.json || !cli.offlineCheck) {
    process.stdout.write(`${JSON.stringify({
      offlineCheck: result.offlineCheck,
      upstreamVerified: result.upstreamVerified,
      recommendedMode: result.recommendedMode,
      actionMode: result.actionMode,
      stageDir: result.stageDir,
      npmCacheArchivePath: result.npmCacheArchivePath,
      piBaseline: result.baseline.piBaseline,
      yamlBaseline: result.baseline.yamlBaseline,
      upstreamRecords: result.upstreamRecords,
    }, null, 2)}\n`);
  } else {
    process.stdout.write(
      `self-upgrade offline check passed: taskpack=${result.taskpackName} pi=${result.baseline.piBaseline} yaml=${result.baseline.yamlBaseline} mode=${result.recommendedMode}\n`,
    );
  }
}

const isDirectExecution = process.argv[1] !== undefined && (() => {
  const scriptPath = fileURLToPath(import.meta.url);
  try {
    return realpathSync(process.argv[1]) === realpathSync(scriptPath);
  } catch {
    try {
      return resolve(process.argv[1]) === scriptPath;
    } catch {
      return false;
    }
  }
})();

if (isDirectExecution) {
  main().catch(error => {
    const detail = error instanceof Error ? error.message : String(error);
    process.stderr.write(`prepare-self-upgrade failed: ${detail}\n`);
    process.exitCode = 1;
  });
}
