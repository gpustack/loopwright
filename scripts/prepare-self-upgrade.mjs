#!/usr/bin/env node
import { Buffer } from 'node:buffer';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { constants as fsConstants, existsSync, readFileSync } from 'node:fs';
import {
  appendFile,
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readdir,
  realpath,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve, sep } from 'node:path';
import process from 'node:process';
import { fileURLToPath, URL } from 'node:url';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export const DEFAULT_STAGE_DIR = '/tmp/loopwright-self-upgrade-stage';
export const MAX_PROPOSAL_BYTES = 64 * 1024;
export const MAX_MANIFEST_BYTES = 64 * 1024;
export const MAX_LOCKFILE_BYTES = 900 * 1024;
export const MAX_HTTP_JSON_BYTES = 256 * 1024;

export const PI_UPSTREAM_MAP = Object.freeze({
  'pi-coding-agent': '@earendil-works/pi-coding-agent',
  'pi-ai': '@earendil-works/pi-ai',
  'pi-agent-core': '@earendil-works/pi-agent-core',
  'pi-mcp': '@earendil-works/pi-mcp',
  'pi-codemode': '@earendil-works/pi-codemode',
  'pi-tui': '@earendil-works/pi-tui',
});

export const YAML_UPSTREAM_MAP = Object.freeze({
  yaml: 'yaml',
});

export const ALL_UPSTREAM_PACKAGES = Object.freeze({
  ...PI_UPSTREAM_MAP,
  ...YAML_UPSTREAM_MAP,
});

export const PI_UPSTREAM_IDS = Object.freeze(Object.keys(PI_UPSTREAM_MAP));
export const ALL_UPSTREAM_IDS = Object.freeze(Object.keys(ALL_UPSTREAM_PACKAGES));

export const YAML_WORKSPACES = Object.freeze([
  'packages/cli',
  'packages/controller',
  'packages/decisions',
  'packages/github-app',
]);

export const MANAGED_WORKSPACES = Object.freeze([
  'packages/agent-pi',
  ...YAML_WORKSPACES,
]);

export const UNMANAGED_WORKSPACES = Object.freeze([
  'packages/core',
  'packages/state',
  'packages/memory',
  'packages/taskpack-runner',
]);

const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
const CANONICAL_SEMVER_RE = /^(0|[1-9][0-9]{0,8})\.(0|[1-9][0-9]{0,8})\.(0|[1-9][0-9]{0,8})$/;

export function isPlainRecord(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) {
    return false;
  }
  for (const key of Object.keys(value)) {
    if (FORBIDDEN_KEYS.has(key)) {
      return false;
    }
  }
  return true;
}

export function parseCanonicalSemver(value) {
  if (typeof value !== 'string') {
    return null;
  }
  const match = CANONICAL_SEMVER_RE.exec(value);
  if (match === null) {
    return null;
  }
  const major = Number.parseInt(match[1], 10);
  const minor = Number.parseInt(match[2], 10);
  const patch = Number.parseInt(match[3], 10);
  if (!Number.isSafeInteger(major) || !Number.isSafeInteger(minor) || !Number.isSafeInteger(patch)) {
    return null;
  }
  return Object.freeze({ major, minor, patch, raw: value });
}

export function compareCanonicalSemver(left, right) {
  const parsedLeft = parseCanonicalSemver(left);
  const parsedRight = parseCanonicalSemver(right);
  if (parsedLeft === null || parsedRight === null) {
    throw new Error(`Invalid canonical SemVer comparison: "${String(left)}" vs "${String(right)}"`);
  }
  if (parsedLeft.major !== parsedRight.major) {
    return parsedLeft.major < parsedRight.major ? -1 : 1;
  }
  if (parsedLeft.minor !== parsedRight.minor) {
    return parsedLeft.minor < parsedRight.minor ? -1 : 1;
  }
  if (parsedLeft.patch !== parsedRight.patch) {
    return parsedLeft.patch < parsedRight.patch ? -1 : 1;
  }
  return 0;
}

function isInsidePath(candidate, root) {
  return candidate === root || candidate.startsWith(root.endsWith(sep) ? root : `${root}${sep}`);
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
    if (segment === '.' || segment === '..') {
      throw new Error(`Unsafe relative path "${relPath}"`);
    }
    cursor = join(cursor, segment);
    const info = await lstat(cursor);
    if (info.isSymbolicLink()) {
      throw new Error(`Refusing symlink at "${relPath}"`);
    }
    if (idx < cleanRel.length - 1) {
      if (!info.isDirectory()) {
        throw new Error(`Expected directory parent while reading "${relPath}"`);
      }
    } else if (!info.isFile()) {
      throw new Error(`Expected regular file at "${relPath}"`);
    }
  }
  return cursor;
}

export async function readBoundedRegularFile(rootDir, relPath, maxBytes) {
  const fullPath = await assertNoSymlinkChain(rootDir, relPath);
  const flags = fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0) | (fsConstants.O_NONBLOCK ?? 0);
  const handle = await open(fullPath, flags);
  try {
    const info = await handle.stat();
    if (!info.isFile()) {
      throw new Error(`Expected regular file at "${relPath}"`);
    }
    if (info.nlink > 1) {
      throw new Error(`Refusing hardlinked file at "${relPath}" (nlink=${info.nlink})`);
    }
    if (info.size > maxBytes) {
      throw new Error(`File "${relPath}" (${info.size} bytes) exceeds limit of ${maxBytes} bytes`);
    }
    return await handle.readFile();
  } finally {
    await handle.close();
  }
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
  if (!isPlainRecord(parsed)) {
    throw new Error(`Top-level JSON value in "${relPath}" must be a plain object`);
  }
  return { parsed, byteLength: bytes.byteLength };
}

export function validateLockfileExpectedVersions(lockDoc, expectedPackagesMap) {
  if (!isPlainRecord(lockDoc)) {
    throw new Error('package-lock.json must be a plain JSON object');
  }
  if (lockDoc.lockfileVersion !== 3) {
    throw new Error(`package-lock.json lockfileVersion must be 3 (received ${String(lockDoc.lockfileVersion)})`);
  }
  const packagesTable = lockDoc.packages;
  if (!isPlainRecord(packagesTable)) {
    throw new Error('package-lock.json missing plain "packages" table');
  }

  for (const [workspacePath, expectedDeps] of Object.entries(expectedPackagesMap)) {
    const wsEntry = packagesTable[workspacePath];
    if (!isPlainRecord(wsEntry)) {
      throw new Error(`package-lock.json missing workspace entry "${workspacePath}"`);
    }
    const wsDeps = wsEntry.dependencies;
    if (!isPlainRecord(wsDeps)) {
      throw new Error(`package-lock.json workspace "${workspacePath}" missing dependencies map`);
    }
    for (const [pkgName, expectedVersion] of Object.entries(expectedDeps)) {
      if (wsDeps[pkgName] !== expectedVersion) {
        throw new Error(
          `package-lock.json "${workspacePath}".dependencies["${pkgName}"] is "${String(wsDeps[pkgName])}", expected "${expectedVersion}"`,
        );
      }
      const localInstallKey = `${workspacePath}/node_modules/${pkgName}`;
      const hoistedInstallKey = `node_modules/${pkgName}`;
      const resolvedEntry = Object.hasOwn(packagesTable, localInstallKey)
        ? packagesTable[localInstallKey]
        : packagesTable[hoistedInstallKey];
      if (!isPlainRecord(resolvedEntry) || resolvedEntry.version !== expectedVersion) {
        const actual = isPlainRecord(resolvedEntry) ? String(resolvedEntry.version) : 'missing';
        throw new Error(
          `package-lock.json resolved "${pkgName}" for "${workspacePath}" is "${actual}", expected "${expectedVersion}"`,
        );
      }
    }
  }

  const expectedPiDeps = expectedPackagesMap['packages/agent-pi'];
  const expectedPiVersions = new Set(Object.values(expectedPiDeps));
  if (expectedPiVersions.size !== 1) {
    throw new Error('Expected @earendil-works/pi-* versions in packages/agent-pi must be lockstep');
  }
  const expectedPiVersion = [...expectedPiVersions][0];
  for (const pkgName of Object.values(PI_UPSTREAM_MAP)) {
    const hoistedPi = packagesTable[`node_modules/${pkgName}`];
    const nestedPi = packagesTable[`packages/agent-pi/node_modules/${pkgName}`];
    const activePi = nestedPi ?? hoistedPi;
    if (!isPlainRecord(activePi) || activePi.version !== expectedPiVersion) {
      throw new Error(`package-lock.json resolved "${pkgName}" does not match lockstep version "${expectedPiVersion}"`);
    }
  }
}

export async function auditBaselineParity(repoRoot) {
  const resolvedRepoRoot = resolve(repoRoot);
  const { parsed: proposal } = await readJsonRegularFile(
    resolvedRepoRoot,
    '.loopwright/proposal.json',
    MAX_PROPOSAL_BYTES,
  );

  if (proposal.schema_version !== 1) {
    throw new Error(`.loopwright/proposal.json schema_version must be 1 (received ${String(proposal.schema_version)})`);
  }
  if (typeof proposal.summary !== 'string' || proposal.summary.trim().length === 0) {
    throw new Error('.loopwright/proposal.json summary must be a non-empty string');
  }
  if (!isPlainRecord(proposal.upstreams)) {
    throw new Error('.loopwright/proposal.json upstreams must be a plain object');
  }
  if (!isPlainRecord(proposal.packages)) {
    throw new Error('.loopwright/proposal.json packages must be a plain object');
  }

  const upstreamKeys = Object.keys(proposal.upstreams);
  if (
    upstreamKeys.length !== ALL_UPSTREAM_IDS.length
    || ALL_UPSTREAM_IDS.some(id => !Object.hasOwn(proposal.upstreams, id))
  ) {
    throw new Error(
      `.loopwright/proposal.json upstreams must contain exact keys [${ALL_UPSTREAM_IDS.join(', ')}]`,
    );
  }

  const baselineByUpstream = Object.create(null);
  for (const upstreamId of ALL_UPSTREAM_IDS) {
    const entry = proposal.upstreams[upstreamId];
    const expectedPkg = ALL_UPSTREAM_PACKAGES[upstreamId];
    if (!isPlainRecord(entry)) {
      throw new Error(`.loopwright/proposal.json upstreams["${upstreamId}"] must be an object`);
    }
    if (entry.package !== expectedPkg) {
      throw new Error(
        `.loopwright/proposal.json upstreams["${upstreamId}"].package must be "${expectedPkg}" (received "${String(entry.package)}")`,
      );
    }
    if (parseCanonicalSemver(entry.version) === null) {
      throw new Error(
        `.loopwright/proposal.json upstreams["${upstreamId}"].version must be canonical X.Y.Z SemVer (received "${String(entry.version)}")`,
      );
    }
    baselineByUpstream[upstreamId] = entry.version;
  }

  const piVersions = new Set(PI_UPSTREAM_IDS.map(id => baselineByUpstream[id]));
  if (piVersions.size !== 1) {
    throw new Error(
      `.loopwright/proposal.json @earendil-works/pi-* baseline versions are skewed: ${[...piVersions].join(', ')}`,
    );
  }
  const piBaseline = baselineByUpstream['pi-coding-agent'];
  const yamlBaseline = baselineByUpstream.yaml;

  const expectedPackagesMap = buildExpectedPackagesMap(piBaseline, yamlBaseline);

  const proposalPkgKeys = Object.keys(proposal.packages);
  if (
    proposalPkgKeys.length !== MANAGED_WORKSPACES.length
    || MANAGED_WORKSPACES.some(ws => !Object.hasOwn(proposal.packages, ws))
  ) {
    throw new Error(
      `.loopwright/proposal.json packages must contain exact keys [${MANAGED_WORKSPACES.join(', ')}]`,
    );
  }

  for (const ws of MANAGED_WORKSPACES) {
    const recordedDeps = proposal.packages[ws];
    const expectedDeps = expectedPackagesMap[ws];
    if (!isPlainRecord(recordedDeps)) {
      throw new Error(`.loopwright/proposal.json packages["${ws}"] must be an object`);
    }
    const expectedDepNames = Object.keys(expectedDeps);
    const recordedDepNames = Object.keys(recordedDeps);
    if (
      recordedDepNames.length !== expectedDepNames.length
      || expectedDepNames.some(dep => recordedDeps[dep] !== expectedDeps[dep])
    ) {
      throw new Error(`.loopwright/proposal.json packages["${ws}"] drifts from proposal.upstreams`);
    }

    const { parsed: pkgManifest } = await readJsonRegularFile(
      resolvedRepoRoot,
      `${ws}/package.json`,
      MAX_MANIFEST_BYTES,
    );
    const manifestDeps = pkgManifest.dependencies;
    if (!isPlainRecord(manifestDeps)) {
      throw new Error(`${ws}/package.json missing dependencies object`);
    }
    for (const [depName, expectedVer] of Object.entries(expectedDeps)) {
      if (manifestDeps[depName] !== expectedVer) {
        throw new Error(
          `Baseline drift in ${ws}/package.json: dependencies["${depName}"] is "${String(manifestDeps[depName])}", expected "${expectedVer}" from .loopwright/proposal.json`,
        );
      }
    }
  }

  for (const ws of UNMANAGED_WORKSPACES) {
    const { parsed: pkgManifest } = await readJsonRegularFile(
      resolvedRepoRoot,
      `${ws}/package.json`,
      MAX_MANIFEST_BYTES,
    );
    const deps = isPlainRecord(pkgManifest.dependencies) ? pkgManifest.dependencies : {};
    for (const depName of Object.keys(deps)) {
      if (depName === 'yaml' || depName.startsWith('@earendil-works/pi-')) {
        throw new Error(`Unexpected managed runtime dependency "${depName}" found in unmanaged workspace ${ws}/package.json`);
      }
    }
  }

  const { parsed: lockDoc, byteLength: lockfileBytes } = await readJsonRegularFile(
    resolvedRepoRoot,
    'package-lock.json',
    MAX_LOCKFILE_BYTES,
  );
  validateLockfileExpectedVersions(lockDoc, expectedPackagesMap);

  const gitEnv = {
    PATH: process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_TERMINAL_PROMPT: '0',
  };
  try {
    await execFileAsync(
      'git',
      ['-c', 'core.hooksPath=/dev/null', '-C', resolvedRepoRoot, 'rev-parse', '--verify', 'HEAD^{commit}'],
      { env: gitEnv, timeout: 15_000, maxBuffer: 64 * 1024 },
    );
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`Repository "${resolvedRepoRoot}" must have a committed git HEAD: ${detail}`, { cause: error });
  }

  const auditedBaselinePaths = [
    '.loopwright/proposal.json',
    'package.json',
    'package-lock.json',
    ...MANAGED_WORKSPACES.map(ws => `${ws}/package.json`),
    ...UNMANAGED_WORKSPACES.map(ws => `${ws}/package.json`),
  ];

  const { stdout: stagedDiffRaw } = await execFileAsync(
    'git',
    ['-c', 'core.hooksPath=/dev/null', '-C', resolvedRepoRoot, 'diff', '--cached', '--name-only', '-z', '--', ...auditedBaselinePaths],
    { env: gitEnv, timeout: 15_000, maxBuffer: 64 * 1024 },
  );
  const stagedBaselineFiles = stagedDiffRaw.split('\0').filter(Boolean);
  if (stagedBaselineFiles.length > 0) {
    throw new Error(
      `Uncommitted staged baseline drift against HEAD in: ${stagedBaselineFiles.join(', ')}`,
    );
  }

  for (const relPath of auditedBaselinePaths) {
    const maxBytes = relPath === 'package-lock.json' ? MAX_LOCKFILE_BYTES : MAX_MANIFEST_BYTES;
    const diskBytes = await readBoundedRegularFile(resolvedRepoRoot, relPath, maxBytes);
    let headBytes;
    try {
      const { stdout } = await execFileAsync(
        'git',
        ['-c', 'core.hooksPath=/dev/null', '-C', resolvedRepoRoot, 'show', `HEAD:${relPath}`],
        { env: gitEnv, encoding: 'buffer', timeout: 15_000, maxBuffer: MAX_LOCKFILE_BYTES + 64 * 1024 },
      );
      headBytes = stdout;
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new Error(`Committed git HEAD is missing required baseline file "${relPath}": ${detail}`, { cause: error });
    }
    if (!diskBytes.equals(headBytes)) {
      throw new Error(
        `Uncommitted baseline drift in "${relPath}": working tree differs from committed HEAD`,
      );
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

export function buildExpectedPackagesMap(piVersion, yamlVersion) {
  return Object.freeze({
    'packages/agent-pi': Object.freeze(
      Object.fromEntries(Object.values(PI_UPSTREAM_MAP).sort().map(pkgName => [pkgName, piVersion])),
    ),
    'packages/cli': Object.freeze({ yaml: yamlVersion }),
    'packages/controller': Object.freeze({ yaml: yamlVersion }),
    'packages/decisions': Object.freeze({ yaml: yamlVersion }),
    'packages/github-app': Object.freeze({ yaml: yamlVersion }),
  });
}

export function evaluateUpstreamEligibility({ baselineByUpstream, discoveredRecords, stageDir }) {
  if (!isPlainRecord(baselineByUpstream)) {
    throw new Error('baselineByUpstream must be a plain record');
  }
  if (!Array.isArray(discoveredRecords)) {
    throw new Error('discoveredRecords must be an array');
  }

  const byId = new Map();
  for (const item of discoveredRecords) {
    if (!isPlainRecord(item) || typeof item.upstreamId !== 'string') {
      throw new Error('Each discovered upstream record must be an object with string upstreamId');
    }
    if (!Object.hasOwn(ALL_UPSTREAM_PACKAGES, item.upstreamId)) {
      throw new Error(`Unknown upstreamId "${item.upstreamId}" in discoveredRecords`);
    }
    if (byId.has(item.upstreamId)) {
      throw new Error(`Duplicate upstreamId "${item.upstreamId}" in discoveredRecords`);
    }
    byId.set(item.upstreamId, item);
  }
  for (const id of ALL_UPSTREAM_IDS) {
    if (!byId.has(id)) {
      throw new Error(`Missing upstreamId "${id}" in discoveredRecords`);
    }
  }

  const classified = new Map();
  let hasHardFailure = false;
  const reasons = [];

  for (const id of ALL_UPSTREAM_IDS) {
    const baseline = baselineByUpstream[id];
    if (parseCanonicalSemver(baseline) === null) {
      throw new Error(`Invalid baseline SemVer "${String(baseline)}" for "${id}"`);
    }
    const raw = byId.get(id);
    if (raw.status === 'failed' || raw.status === 'blocked') {
      const detail = typeof raw.reason === 'string' && raw.reason.trim().length > 0
        ? raw.reason.trim()
        : `upstream acquisition reported status=${String(raw.status)}`;
      classified.set(id, { state: 'invalid', reason: detail });
      reasons.push(`${id}: ${detail}`);
      hasHardFailure = true;
      continue;
    }
    if (typeof raw.version !== 'string' || parseCanonicalSemver(raw.version) === null) {
      const shown = typeof raw.version === 'string' ? raw.version : 'missing';
      const detail = `non-canonical SemVer "${shown}" rejected (expected strict X.Y.Z)`;
      classified.set(id, { state: 'invalid', reason: detail });
      reasons.push(`${id}: ${detail}`);
      hasHardFailure = true;
      continue;
    }
    const cmp = compareCanonicalSemver(raw.version, baseline);
    if (cmp < 0) {
      const detail = `rollback rejected: discovered ${raw.version} is older than baseline ${baseline}`;
      classified.set(id, { state: 'rollback', version: raw.version, reason: detail });
      reasons.push(`${id}: ${detail}`);
      hasHardFailure = true;
      continue;
    }
    if (cmp === 0) {
      classified.set(id, { state: 'up_to_date', version: raw.version });
      continue;
    }
    classified.set(id, { state: 'newer', version: raw.version });
  }

  const piBaseline = baselineByUpstream['pi-coding-agent'];
  const yamlBaseline = baselineByUpstream.yaml;

  if (hasHardFailure) {
    const blockedRecords = ALL_UPSTREAM_IDS.map(id => {
      const entry = classified.get(id);
      if (entry.state === 'invalid' || entry.state === 'rollback') {
        return Object.freeze({
          upstreamId: id,
          status: 'blocked',
          ...(typeof entry.version === 'string' ? { version: entry.version } : {}),
          reason: entry.reason,
        });
      }
      return Object.freeze({
        upstreamId: id,
        status: 'up_to_date',
        version: baselineByUpstream[id],
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

  const piVersionSet = new Set(PI_UPSTREAM_IDS.map(id => classified.get(id).version));
  const anyPiNewer = PI_UPSTREAM_IDS.some(id => classified.get(id).state === 'newer');
  let piOutcome = 'up_to_date';
  let targetPiVersion = piBaseline;
  let piSkewSummary = '';

  if (!anyPiNewer) {
    piOutcome = 'up_to_date';
  } else if (piVersionSet.size === 1) {
    piOutcome = 'upgrade';
    targetPiVersion = classified.get('pi-coding-agent').version;
  } else {
    piOutcome = 'partial_hold';
    piSkewSummary = PI_UPSTREAM_IDS
      .map(id => `${id}=${classified.get(id).version}`)
      .join(', ');
    reasons.push(`partial @earendil-works/pi-* publish (${piSkewSummary})`);
  }

  const yamlEntry = classified.get('yaml');
  const yamlOutcome = yamlEntry.state === 'newer' ? 'upgrade' : 'up_to_date';
  const targetYamlVersion = yamlOutcome === 'upgrade' ? yamlEntry.version : yamlBaseline;

  if (piOutcome !== 'upgrade' && yamlOutcome !== 'upgrade') {
    if (piOutcome === 'partial_hold') {
      const blockedRecords = ALL_UPSTREAM_IDS.map(id => {
        if (id === 'yaml') {
          return Object.freeze({
            upstreamId: 'yaml',
            status: 'up_to_date',
            version: yamlBaseline,
          });
        }
        return Object.freeze({
          upstreamId: id,
          status: 'blocked',
          version: classified.get(id).version,
          reason: `partial @earendil-works/pi-* publish (${piSkewSummary}); awaiting lockstep alignment`,
        });
      });
      return Object.freeze({
        recommendedMode: 'blocked',
        actionMode: 'candidate',
        piOutcome,
        yamlOutcome,
        targetPiVersion,
        targetYamlVersion,
        targetVersions: buildTargetVersionsPayload(targetPiVersion, targetYamlVersion),
        upstreamRecords: Object.freeze(blockedRecords),
        reasons: Object.freeze(reasons),
      });
    }

    const unchangedRecords = ALL_UPSTREAM_IDS.map(id =>
      Object.freeze({
        upstreamId: id,
        status: 'up_to_date',
        version: baselineByUpstream[id],
      }),
    );
    return Object.freeze({
      recommendedMode: 'no-change',
      actionMode: 'no-change',
      piOutcome,
      yamlOutcome,
      targetPiVersion,
      targetYamlVersion,
      targetVersions: buildTargetVersionsPayload(targetPiVersion, targetYamlVersion),
      upstreamRecords: Object.freeze(unchangedRecords),
      reasons: Object.freeze([]),
    });
  }

  const stageNote = typeof stageDir === 'string' && stageDir.length > 0 ? `; stageDir=${stageDir}` : '';
  const candidateRecords = ALL_UPSTREAM_IDS.map(id => {
    const baseline = baselineByUpstream[id];
    if (id === 'yaml') {
      if (yamlOutcome === 'upgrade') {
        return Object.freeze({
          upstreamId: 'yaml',
          status: 'available',
          version: targetYamlVersion,
          reason: `eligible upgrade from ${baseline} to ${targetYamlVersion}${stageNote}`,
        });
      }
      return Object.freeze({
        upstreamId: 'yaml',
        status: 'up_to_date',
        version: baseline,
      });
    }

    if (piOutcome === 'upgrade') {
      return Object.freeze({
        upstreamId: id,
        status: 'available',
        version: targetPiVersion,
        reason: `eligible lockstep upgrade from ${baseline} to ${targetPiVersion}${stageNote}`,
      });
    }
    if (piOutcome === 'partial_hold') {
      return Object.freeze({
        upstreamId: id,
        status: 'up_to_date',
        version: baseline,
        reason: `held at baseline ${baseline} during partial @earendil-works/pi-* publish (${piSkewSummary})`,
      });
    }
    return Object.freeze({
      upstreamId: id,
      status: 'up_to_date',
      version: baseline,
    });
  });

  return Object.freeze({
    recommendedMode: 'candidate',
    actionMode: 'candidate',
    piOutcome,
    yamlOutcome,
    targetPiVersion,
    targetYamlVersion,
    targetVersions: buildTargetVersionsPayload(targetPiVersion, targetYamlVersion),
    upstreamRecords: Object.freeze(candidateRecords),
    reasons: Object.freeze(reasons),
  });
}

export function buildTargetVersionsPayload(piVersion, yamlVersion) {
  const upstreams = Object.fromEntries(
    ALL_UPSTREAM_IDS.map(id => [
      id,
      Object.freeze({
        package: ALL_UPSTREAM_PACKAGES[id],
        version: id === 'yaml' ? yamlVersion : piVersion,
      }),
    ]),
  );
  const packages = buildExpectedPackagesMap(piVersion, yamlVersion);
  return Object.freeze({
    schema_version: 1,
    summary: `Loopwright runtime dependency ledger for @earendil-works/pi-* ${piVersion} and yaml ${yamlVersion}.`,
    upstreams: Object.freeze(upstreams),
    packages,
  });
}

async function fetchHttpJsonLatest(url, fetchImpl, timeoutMs = 15_000) {
  const parsedUrl = new URL(url);
  if (parsedUrl.protocol !== 'https:') {
    throw new Error(`Upstream URL "${url}" must use https://`);
  }
  const controller = new globalThis.AbortController();
  const timer = globalThis.setTimeout(() => controller.abort(), timeoutMs);
  timer.unref?.();
  try {
    const response = await fetchImpl(url, {
      method: 'GET',
      headers: {
        accept: 'application/json',
        'user-agent': 'loopwright-self-upgrade-preflight',
      },
      redirect: 'follow',
      signal: controller.signal,
    });
    if (!response.ok) {
      await response.body?.cancel?.().catch(() => undefined);
      return {
        ok: false,
        reason: `HTTP ${response.status} from ${url}`,
      };
    }
    const contentLengthHeader = response.headers?.get?.('content-length');
    if (typeof contentLengthHeader === 'string' && /^\d+$/.test(contentLengthHeader.trim())) {
      const declaredBytes = Number.parseInt(contentLengthHeader.trim(), 10);
      if (declaredBytes > MAX_HTTP_JSON_BYTES) {
        await response.body?.cancel?.().catch(() => undefined);
        return {
          ok: false,
          reason: `HTTP response from ${url} exceeded ${MAX_HTTP_JSON_BYTES} bytes`,
        };
      }
    }
    let text;
    if (response.body && typeof response.body.getReader === 'function') {
      const reader = response.body.getReader();
      const chunks = [];
      let totalBytes = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        const buf = Buffer.from(value);
        totalBytes += buf.byteLength;
        if (totalBytes > MAX_HTTP_JSON_BYTES) {
          await reader.cancel().catch(() => undefined);
          return {
            ok: false,
            reason: `HTTP response from ${url} exceeded ${MAX_HTTP_JSON_BYTES} bytes`,
          };
        }
        chunks.push(buf);
      }
      text = Buffer.concat(chunks, totalBytes).toString('utf8');
    } else {
      text = await response.text();
      if (Buffer.byteLength(text, 'utf8') > MAX_HTTP_JSON_BYTES) {
        return {
          ok: false,
          reason: `HTTP response from ${url} exceeded ${MAX_HTTP_JSON_BYTES} bytes`,
        };
      }
    }
    let data;
    try {
      data = JSON.parse(text);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      return {
        ok: false,
        reason: `Malformed JSON from ${url}: ${detail}`,
      };
    }
    if (isPlainRecord(data)) {
      for (const key of ['version', 'tag_name', 'latest', 'sha']) {
        const candidate = data[key];
        if (typeof candidate === 'string' && candidate.trim().length > 0) {
          return { ok: true, version: candidate.trim() };
        }
      }
    }
    const fallbackHash = createHash('sha256').update(text, 'utf8').digest('hex').slice(0, 16);
    return { ok: true, version: fallbackHash };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return {
      ok: false,
      reason: `Fetch failed for ${url}: ${detail}`,
    };
  } finally {
    globalThis.clearTimeout(timer);
  }
}

export async function discoverNpmUpstreams({ manifest, baselineByUpstream, fetchImpl = globalThis.fetch, registryFixtures }) {
  const records = [];
  for (const upstream of manifest.spec.upstreams) {
    if (registryFixtures !== undefined) {
      if (!Object.hasOwn(registryFixtures, upstream.id)) {
        records.push({
          upstreamId: upstream.id,
          status: 'failed',
          reason: `missing registry fixture for ${upstream.id}`,
        });
        continue;
      }
      const fixture = registryFixtures[upstream.id];
      if (isPlainRecord(fixture) && fixture.__httpStatus !== undefined && fixture.__httpStatus !== 200) {
        records.push({
          upstreamId: upstream.id,
          status: 'failed',
          reason: `HTTP ${String(fixture.__httpStatus)} from fixture ${upstream.id}`,
        });
        continue;
      }
      if (isPlainRecord(fixture)) {
        let extracted;
        for (const key of ['version', 'tag_name', 'latest', 'sha']) {
          if (typeof fixture[key] === 'string' && fixture[key].trim().length > 0) {
            extracted = fixture[key].trim();
            break;
          }
        }
        const resolvedVersion = extracted
          ?? createHash('sha256').update(JSON.stringify(fixture), 'utf8').digest('hex').slice(0, 16);
        const baseline = baselineByUpstream[upstream.id];
        records.push({
          upstreamId: upstream.id,
          status: resolvedVersion === baseline ? 'up_to_date' : 'available',
          version: resolvedVersion,
        });
        continue;
      }
      records.push({
        upstreamId: upstream.id,
        status: 'failed',
        reason: `invalid fixture payload for ${upstream.id}`,
      });
      continue;
    }

    const fetched = await fetchHttpJsonLatest(upstream.source, fetchImpl);
    if (!fetched.ok) {
      records.push({
        upstreamId: upstream.id,
        status: 'failed',
        reason: fetched.reason,
      });
      continue;
    }
    const baseline = baselineByUpstream[upstream.id];
    records.push({
      upstreamId: upstream.id,
      status: fetched.version === baseline ? 'up_to_date' : 'available',
      version: fetched.version,
    });
  }
  return Object.freeze(records);
}

async function restoreTreeWritable(targetPath) {
  let info;
  try {
    info = await lstat(targetPath);
  } catch {
    return;
  }
  if (info.isSymbolicLink()) {
    return;
  }
  if (info.isDirectory()) {
    await chmod(targetPath, 0o700).catch(() => undefined);
    const entries = await readdir(targetPath);
    for (const entry of entries) {
      await restoreTreeWritable(join(targetPath, entry));
    }
  }
}

async function freezeTreeReadOnly(targetPath) {
  const info = await lstat(targetPath);
  if (info.isSymbolicLink()) {
    throw new Error(`Refusing symlink inside stage directory: "${targetPath}"`);
  }
  if (info.isDirectory()) {
    const entries = await readdir(targetPath);
    for (const entry of entries) {
      await freezeTreeReadOnly(join(targetPath, entry));
    }
    await chmod(targetPath, 0o555);
  } else if (info.isFile()) {
    if (info.nlink > 1) {
      throw new Error(`Refusing hardlinked file inside stage directory: "${targetPath}"`);
    }
    await chmod(targetPath, 0o444);
  } else {
    throw new Error(`Refusing non-regular entry inside stage directory: "${targetPath}"`);
  }
}

function buildSanitizedNpmEnv(cacheDir, registryUrl) {
  const pathVal = process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin';
  return {
    PATH: pathVal,
    HOME: cacheDir,
    TMPDIR: tmpdir(),
    LANG: 'C.UTF-8',
    LC_ALL: 'C.UTF-8',
    NPM_CONFIG_CACHE: cacheDir,
    npm_config_audit: 'false',
    npm_config_fund: 'false',
    npm_config_ignore_scripts: 'true',
    npm_config_update_notifier: 'false',
    ...(typeof registryUrl === 'string' && registryUrl.length > 0
      ? { npm_config_registry: registryUrl }
      : {}),
  };
}

export async function defaultLockfileBuilder({ repoRoot, targetVersions, npmCacheDir, registryUrl }) {
  const workHolder = await mkdtemp(join(tmpdir(), 'loopwright-self-upgrade-work-'));
  try {
    const rootPkgBytes = await readBoundedRegularFile(repoRoot, 'package.json', MAX_MANIFEST_BYTES);
    const rootLockBytes = await readBoundedRegularFile(repoRoot, 'package-lock.json', MAX_LOCKFILE_BYTES);
    await writeFile(join(workHolder, 'package.json'), rootPkgBytes, { mode: 0o600 });
    await writeFile(join(workHolder, 'package-lock.json'), rootLockBytes, { mode: 0o600 });

    const allWorkspaces = [...MANAGED_WORKSPACES, ...UNMANAGED_WORKSPACES];
    for (const ws of allWorkspaces) {
      const wsDir = join(workHolder, ws);
      await mkdir(wsDir, { recursive: true, mode: 0o700 });
      const { parsed: manifest } = await readJsonRegularFile(repoRoot, `${ws}/package.json`, MAX_MANIFEST_BYTES);
      if (Object.hasOwn(targetVersions.packages, ws)) {
        const updatedDeps = { ...manifest.dependencies, ...targetVersions.packages[ws] };
        manifest.dependencies = updatedDeps;
      }
      await writeFile(join(wsDir, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
    }

    const npmBin = process.platform === 'win32' ? 'npm.cmd' : 'npm';
    const npmEnv = buildSanitizedNpmEnv(npmCacheDir, registryUrl);
    await execFileAsync(
      npmBin,
      ['install', '--package-lock-only', '--ignore-scripts', '--no-audit', '--no-fund', '--cache', npmCacheDir],
      { cwd: workHolder, env: npmEnv, timeout: 300_000, maxBuffer: 16 * 1024 * 1024 },
    );

    const candidateLockBytes = await readBoundedRegularFile(workHolder, 'package-lock.json', MAX_LOCKFILE_BYTES);
    await execFileAsync(
      npmBin,
      ['ci', '--ignore-scripts', '--no-audit', '--no-fund', '--cache', npmCacheDir],
      { cwd: workHolder, env: npmEnv, timeout: 300_000, maxBuffer: 16 * 1024 * 1024 },
    );

    // Warm both packument metadata and tarballs in npmCacheDir for packed @gpustack/loopwright runtime
    // dependencies (including un-overridden transitive versions such as Pi's minimatch) so offline
    // global tarball installation (`npm install -g ... --offline`) succeeds with zero network.
    const { parsed: rootPkg } = await readJsonRegularFile(repoRoot, 'package.json', MAX_MANIFEST_BYTES);
    const packRuntimeDeps = Object.create(null);
    if (isPlainRecord(rootPkg.overrides)) {
      for (const [depName, depVer] of Object.entries(rootPkg.overrides)) {
        if (typeof depVer === 'string') {
          packRuntimeDeps[depName] = depVer;
        }
      }
    }
    for (const ws of allWorkspaces) {
      const { parsed: wsManifest } = await readJsonRegularFile(workHolder, `${ws}/package.json`, MAX_MANIFEST_BYTES);
      if (isPlainRecord(wsManifest.dependencies)) {
        for (const [depName, depVer] of Object.entries(wsManifest.dependencies)) {
          if (!depName.startsWith('@loopwright/') && typeof depVer === 'string') {
            packRuntimeDeps[depName] = depVer;
          }
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

export async function stageCandidateBundle({
  repoRoot,
  stageDir,
  targetVersions,
  lockfileBuilder = defaultLockfileBuilder,
}) {
  const resolvedRepo = await realpath(resolve(repoRoot));
  const absStageDir = resolve(stageDir);
  const stageParent = dirname(absStageDir);
  await mkdir(stageParent, { recursive: true, mode: 0o755 });
  const realStageParent = await realpath(stageParent);
  const canonicalStageDir = join(realStageParent, relative(stageParent, absStageDir));

  if (isInsidePath(canonicalStageDir, resolvedRepo) || isInsidePath(resolvedRepo, canonicalStageDir)) {
    throw new Error(`Stage directory "${canonicalStageDir}" must be disjoint from repository root "${resolvedRepo}"`);
  }

  await restoreTreeWritable(canonicalStageDir);
  await rm(canonicalStageDir, { recursive: true, force: true });
  await mkdir(canonicalStageDir, { recursive: true, mode: 0o755 });

  const npmCacheDir = join(canonicalStageDir, 'npm-cache');
  await mkdir(npmCacheDir, { recursive: true, mode: 0o755 });

  const candidateLockBytes = await lockfileBuilder({
    repoRoot: resolvedRepo,
    targetVersions,
    npmCacheDir,
  });

  if (candidateLockBytes.byteLength > MAX_LOCKFILE_BYTES) {
    throw new Error(
      `Staged package-lock.candidate.json (${candidateLockBytes.byteLength} bytes) exceeds ${MAX_LOCKFILE_BYTES} bytes`,
    );
  }
  let parsedCandidateLock;
  try {
    parsedCandidateLock = JSON.parse(candidateLockBytes.toString('utf8'));
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`Staged package-lock.candidate.json is invalid JSON: ${detail}`, { cause: error });
  }
  validateLockfileExpectedVersions(parsedCandidateLock, targetVersions.packages);

  const targetVersionsPath = join(canonicalStageDir, 'target-versions.json');
  const candidateLockPath = join(canonicalStageDir, 'package-lock.candidate.json');
  await writeFile(targetVersionsPath, `${JSON.stringify(targetVersions, null, 2)}\n`, { mode: 0o644 });
  await writeFile(candidateLockPath, candidateLockBytes, { mode: 0o644 });

  await freezeTreeReadOnly(canonicalStageDir);

  return Object.freeze({
    stageDir: canonicalStageDir,
    targetVersionsPath,
    candidateLockPath,
    npmCacheDir,
    candidateLockBytes: candidateLockBytes.byteLength,
  });
}

async function loadTaskpackCompilerModule(repoRoot) {
  const distTaskpackUrl = new URL('../packages/github-app/dist/taskpack.js', import.meta.url);
  const distPath = fileURLToPath(distTaskpackUrl);
  if (!existsSync(distPath)) {
    throw new Error(
      `Missing compiled @loopwright/github-app at "${relative(repoRoot, distPath)}"; run "npm run build" first`,
    );
  }
  return await import(distTaskpackUrl.href);
}

export async function verifyTaskpackOfflineCompilation(repoRoot, { allowMissingVerifyScript = false } = {}) {
  const resolvedRepo = resolve(repoRoot);
  const { loadDeclarativeTaskpack, compileDeclarativeTaskpack, DEFAULT_HOST_BUDGETS } = await loadTaskpackCompilerModule(resolvedRepo);
  const manifestPath = join(resolvedRepo, '.loopwright/taskpack.yaml');
  const manifest = await loadDeclarativeTaskpack({
    manifestPath,
    repositoryRoot: resolvedRepo,
  });

  const verifyRelPath = '.loopwright/checks/verify.sh';
  const verifyExists = existsSync(join(resolvedRepo, verifyRelPath));
  if (!verifyExists && !allowMissingVerifyScript) {
    throw new Error(`Missing required command.v1 verification script "${verifyRelPath}"`);
  }

  let compileRepoRoot = resolvedRepo;
  let tempOverlayRoot = null;
  if (!verifyExists) {
    tempOverlayRoot = await mkdtemp(join(tmpdir(), 'loopwright-self-upgrade-compile-'));
    await mkdir(join(tempOverlayRoot, '.loopwright/checks'), { recursive: true, mode: 0o700 });
    for (const rel of ['.loopwright/taskpack.yaml', '.loopwright/instructions.md', '.loopwright/proposal.json']) {
      const content = await readBoundedRegularFile(resolvedRepo, rel, MAX_PROPOSAL_BYTES);
      await writeFile(join(tempOverlayRoot, rel), content, { mode: 0o600 });
    }
    await writeFile(
      join(tempOverlayRoot, verifyRelPath),
      '#!/usr/bin/env bash\nset -euo pipefail\n',
      { mode: 0o755 },
    );
    compileRepoRoot = tempOverlayRoot;
  } else {
    await readBoundedRegularFile(resolvedRepo, verifyRelPath, MAX_HTTP_JSON_BYTES);
  }

  try {
    const baseBindings = {
      repository: 'gpustack/loopwright',
      baseRevision: '0'.repeat(40),
      sourceRevision: '0'.repeat(40),
      repositoryRoot: compileRepoRoot,
      taskpackPath: '.loopwright/taskpack.yaml',
      executionMode: 'delegated',
      budgets: DEFAULT_HOST_BUDGETS,
    };
    const candidateCompiled = await compileDeclarativeTaskpack(manifest, {
      ...baseBindings,
      mode: 'candidate',
    });
    const noChangeCompiled = await compileDeclarativeTaskpack(manifest, {
      ...baseBindings,
      mode: 'no-change',
    });
    return Object.freeze({
      manifest,
      candidateCompiled,
      noChangeCompiled,
    });
  } finally {
    if (tempOverlayRoot !== null) {
      await rm(tempOverlayRoot, { recursive: true, force: true }).catch(() => undefined);
    }
  }
}

export async function runPrepareSelfUpgrade(options = {}) {
  const repoRoot = resolve(options.repoRoot ?? process.cwd());
  const stageDir = resolve(
    options.stageDir ?? process.env.SELF_UPGRADE_STAGE_DIR ?? DEFAULT_STAGE_DIR,
  );
  const requestedMode = options.requestedMode ?? 'auto';
  if (!['auto', 'candidate', 'no-change'].includes(requestedMode)) {
    throw new Error(`Invalid --requested-mode "${String(requestedMode)}" (expected auto, candidate, or no-change)`);
  }

  const baseline = await auditBaselineParity(repoRoot);

  if (options.offlineCheck === true) {
    const compiled = await verifyTaskpackOfflineCompilation(repoRoot, { allowMissingVerifyScript: true });
    const syntheticRecords = ALL_UPSTREAM_IDS.map(id =>
      Object.freeze({
        upstreamId: id,
        status: 'up_to_date',
        version: baseline.baselineByUpstream[id],
        reason: 'synthetic offline smoke check (upstreams not queried)',
      }),
    );
    return Object.freeze({
      offlineCheck: true,
      upstreamVerified: false,
      recommendedMode: 'no-change',
      actionMode: 'no-change',
      stageDir,
      npmCacheDir: join(stageDir, 'npm-cache'),
      baseline,
      evaluation: null,
      staged: null,
      taskpackName: compiled.manifest.metadata.name,
      upstreamRecords: Object.freeze(syntheticRecords),
    });
  }

  const { manifest } = await verifyTaskpackOfflineCompilation(repoRoot, {
    allowMissingVerifyScript: options.allowMissingVerifyScript === true,
  });

  const discoveredRecords = options.discoveredRecords !== undefined
    ? options.discoveredRecords
    : await discoverNpmUpstreams({
      manifest,
      baselineByUpstream: baseline.baselineByUpstream,
      fetchImpl: options.fetchImpl,
      registryFixtures: options.registryFixtures,
    });

  const evaluation = evaluateUpstreamEligibility({
    baselineByUpstream: baseline.baselineByUpstream,
    discoveredRecords,
    stageDir,
  });

  if (requestedMode === 'no-change') {
    if (evaluation.recommendedMode === 'no-change') {
      return Object.freeze({
        offlineCheck: false,
        upstreamVerified: true,
        recommendedMode: 'no-change',
        actionMode: 'no-change',
        stageDir,
        npmCacheDir: join(stageDir, 'npm-cache'),
        baseline,
        evaluation,
        staged: null,
        upstreamRecords: evaluation.upstreamRecords,
      });
    }
    const refusedRecords = evaluation.upstreamRecords.map(rec => (
      rec.status === 'available'
        ? Object.freeze({
          upstreamId: rec.upstreamId,
          status: 'blocked',
          ...(typeof rec.version === 'string' ? { version: rec.version } : {}),
          reason: `requested no-change mode while eligible upgrade to ${String(rec.version)} is available`,
        })
        : rec
    ));
    return Object.freeze({
      offlineCheck: false,
      upstreamVerified: true,
      recommendedMode: 'blocked',
      actionMode: 'no-change',
      stageDir,
      npmCacheDir: join(stageDir, 'npm-cache'),
      baseline,
      evaluation,
      staged: null,
      upstreamRecords: Object.freeze(refusedRecords),
    });
  }

  let staged = null;
  if (evaluation.recommendedMode === 'candidate' && options.skipStage !== true) {
    staged = await stageCandidateBundle({
      repoRoot,
      stageDir,
      targetVersions: evaluation.targetVersions,
      lockfileBuilder: options.lockfileBuilder,
    });
  }

  const effectiveStageDir = staged !== null ? staged.stageDir : stageDir;
  return Object.freeze({
    offlineCheck: false,
    upstreamVerified: true,
    recommendedMode: evaluation.recommendedMode,
    actionMode: evaluation.actionMode,
    stageDir: effectiveStageDir,
    npmCacheDir: join(effectiveStageDir, 'npm-cache'),
    baseline,
    evaluation,
    staged,
    upstreamRecords: evaluation.upstreamRecords,
  });
}

async function readJsonArgOrFile(rawArg, repoRoot) {
  if (rawArg.startsWith('@')) {
    const filePath = resolve(repoRoot, rawArg.slice(1));
    const preStat = await lstat(filePath);
    if (preStat.isSymbolicLink() || !preStat.isFile()) {
      throw new Error(`Expected regular file at "${filePath}"`);
    }
    const flags = fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0) | (fsConstants.O_NONBLOCK ?? 0);
    const handle = await open(filePath, flags);
    try {
      const info = await handle.stat();
      if (!info.isFile() || info.nlink > 1 || info.size > MAX_HTTP_JSON_BYTES) {
        throw new Error(`Refusing non-regular, hardlinked, or oversized JSON input file "${filePath}"`);
      }
      const text = (await handle.readFile()).toString('utf8');
      return JSON.parse(text);
    } finally {
      await handle.close();
    }
  }
  return JSON.parse(rawArg);
}

const SELF_UPGRADE_PROVIDER_ID_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const SELF_UPGRADE_THINKING_LEVELS = new Set(['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']);
const SELF_UPGRADE_DISALLOWED_OAUTH_PROVIDERS = new Set([
  'github-copilot',
  'openai-codex',
  'claude-code',
  'gemini',
  'google',
  'gemini-cli',
  'google-gemini-cli',
  'google-antigravity',
]);
function snapThinkingToCatalogMap(desiredLevel, providerId, modelId, api) {
  try {
    const dataUrl = new URL(`./providers/data/${providerId}.json`, import.meta.resolve('@earendil-works/pi-ai'));
    const dataPath = fileURLToPath(dataUrl);
    if (!existsSync(dataPath)) return desiredLevel;
    const raw = JSON.parse(String(readFileSync(dataPath, 'utf8')));
    const entry = raw?.[api]?.[`chat:${modelId}`];
    const levelMap = entry?.thinkingLevelMap;
    if (!isPlainRecord(levelMap)) return desiredLevel;
    if (typeof levelMap[desiredLevel] === 'string' && levelMap[desiredLevel].length > 0) {
      return desiredLevel;
    }
    const fallbacksByDesired = {
      off: ['low', 'minimal', 'medium', 'high', 'max'],
      minimal: ['low', 'medium', 'high', 'off', 'max'],
      low: ['medium', 'high', 'minimal', 'max', 'off'],
      medium: ['high', 'low', 'max', 'minimal', 'off'],
      high: ['max', 'medium', 'low', 'xhigh'],
      xhigh: ['high', 'max', 'medium', 'low'],
      max: ['high', 'xhigh', 'medium', 'low'],
    };
    for (const candidate of fallbacksByDesired[desiredLevel] ?? ['low', 'high', 'max', 'off']) {
      if (typeof levelMap[candidate] === 'string' && levelMap[candidate].length > 0) {
        return candidate;
      }
    }
  } catch {
    // ignore missing or non-standard catalog files
  }
  return desiredLevel;
}

function normalizeGatewayBaseUrl(rawUrl) {
  let cleaned = rawUrl.trim();
  while (cleaned.endsWith('/')) {
    cleaned = cleaned.slice(0, -1);
  }
  if (cleaned.toLowerCase().endsWith('/chat/completions')) {
    cleaned = cleaned.slice(0, -'/chat/completions'.length);
    while (cleaned.endsWith('/')) {
      cleaned = cleaned.slice(0, -1);
    }
  }
  if (cleaned.length < 8 || cleaned.length > 2048 || /[\s\0\r\n?#]/.test(cleaned)) {
    throw new Error('LLM gateway URL must be a single-line URL without whitespace, query, or fragment');
  }
  let parsed;
  try {
    parsed = new URL(cleaned);
  } catch {
    throw new Error('LLM gateway URL is invalid');
  }
  if (parsed.username || parsed.password) {
    throw new Error('LLM gateway URL must not embed credentials');
  }
  const isLoopback = parsed.protocol === 'http:' && parsed.hostname === '127.0.0.1' && parsed.port.length > 0;
  if (!(parsed.protocol === 'https:' || isLoopback)) {
    throw new Error('LLM gateway URL must use https:// or http://127.0.0.1:<port>');
  }
  return cleaned;
}

function inferGatewayProviderId(explicitProvider, baseUrl) {
  const trimmed = explicitProvider.trim().toLowerCase();
  if (trimmed.length > 0) {
    if (
      !SELF_UPGRADE_PROVIDER_ID_RE.test(trimmed)
      || trimmed.includes('..')
      || SELF_UPGRADE_DISALLOWED_OAUTH_PROVIDERS.has(trimmed)
    ) {
      throw new Error(`Unsupported LLM provider identifier "${explicitProvider}"`);
    }
    return trimmed;
  }
  const parsed = new URL(baseUrl);
  const host = parsed.hostname.toLowerCase();
  const path = parsed.pathname.toLowerCase();
  if (host === 'open.bigmodel.cn' || host.endsWith('.bigmodel.cn')) {
    return path.includes('/api/coding') ? 'zai-coding-cn' : 'zai-cn';
  }
  if (host === 'api.z.ai' || host.endsWith('.z.ai')) {
    return 'zai';
  }
  const hostMap = {
    'api.anthropic.com': 'anthropic',
    'api.openai.com': 'openai',
    'api.deepseek.com': 'deepseek',
    'openrouter.ai': 'openrouter',
    'api.moonshot.cn': 'moonshotai-cn',
    'api.moonshot.ai': 'moonshotai',
    'api.kimi.com': 'kimi-coding',
    'api.minimaxi.com': 'minimax-cn',
    'api.minimax.io': 'minimax',
    'token-plan.cn-beijing.maas.aliyuncs.com': 'qwen-token-plan-cn',
    'dashscope.aliyuncs.com': 'qwen-token-plan-cn',
    'token-plan.ap-southeast-1.maas.aliyuncs.com': 'qwen-token-plan',
    'dashscope-intl.aliyuncs.com': 'qwen-token-plan',
  };
  return hostMap[host] ?? 'custom-gateway';
}

function resolveGatewayWireApi(protocol, useAnthropic) {
  const proto = protocol.trim().toLowerCase();
  if (proto.length > 0) {
    const map = {
      openai: 'openai-completions',
      'openai-completions': 'openai-completions',
      'openai-responses': 'openai-responses',
      anthropic: 'anthropic-messages',
      'anthropic-messages': 'anthropic-messages',
    };
    if (!Object.hasOwn(map, proto)) {
      throw new Error(`Unsupported LLM wire protocol "${protocol}"`);
    }
    return map[proto];
  }
  const flag = useAnthropic.trim().toLowerCase();
  if (flag === 'true' || flag === '1' || flag === 'yes') return 'anthropic-messages';
  if (flag === '' || flag === 'false' || flag === '0' || flag === 'no') return 'openai-completions';
  throw new Error(`Invalid LLM use-anthropic flag "${useAnthropic}"`);
}

function firstNonEmptyEnv(env, ...keys) {
  for (const key of keys) {
    const val = env[key];
    if (typeof val === 'string' && val.trim().length > 0) {
      return val.trim();
    }
  }
  return '';
}

function isZaiOrGlmTarget(modelId, baseUrl) {
  const lowerModel = modelId.trim().toLowerCase();
  if (lowerModel.startsWith('glm-') || lowerModel.includes('/glm-')) {
    return true;
  }
  try {
    const host = new URL(baseUrl).hostname.toLowerCase();
    return host === 'api.z.ai' || host.endsWith('.z.ai') || host === 'open.bigmodel.cn' || host.endsWith('.bigmodel.cn');
  } catch {
    return false;
  }
}

function resolveGatewayThinking(thinkingRaw, effortRaw, modelId, baseUrl) {
  const think = thinkingRaw.trim().toLowerCase();
  const effort = effortRaw.trim().toLowerCase();
  if (think === 'disabled' || think === 'off') {
    return { level: 'off', reasoning: false };
  }
  if (effort.length > 0) {
    if (!SELF_UPGRADE_THINKING_LEVELS.has(effort) || effort === 'off') {
      throw new Error(`Unsupported reasoning effort "${effortRaw}"`);
    }
    return { level: effort, reasoning: true };
  }
  if (think.length > 0) {
    if (think === 'enabled') return { level: 'low', reasoning: true };
    if (SELF_UPGRADE_THINKING_LEVELS.has(think)) return { level: think, reasoning: think !== 'off' };
    throw new Error(`Unsupported thinking mode "${thinkingRaw}"`);
  }
  if (isZaiOrGlmTarget(modelId, baseUrl)) {
    return { level: 'low', reasoning: true };
  }
  return { level: 'off', reasoning: false };
}

export async function resolveSelfUpgradeModelConfig({ env = process.env, modelsOutPath } = {}) {
  const rawUrl = firstNonEmptyEnv(env, 'CI_GPUSTACK_LOOPWRIGHT_LLM_URL', 'CI_GPUSTACK_CODEREVIEW_LLM_URL');
  const rawModel = firstNonEmptyEnv(env, 'CI_GPUSTACK_LOOPWRIGHT_LLM_MODEL', 'CI_GPUSTACK_CODEREVIEW_LLM_MODEL');
  const rawProvider = firstNonEmptyEnv(env, 'CI_GPUSTACK_LOOPWRIGHT_LLM_PROVIDER');

  if (rawUrl.length === 0 && rawModel.length === 0) {
    return Object.freeze({
      configured: false,
      modelProvider: '',
      modelId: '',
      modelThinking: '',
      modelApi: '',
      modelBaseUrl: '',
      modelsJsonPath: '',
      allowCustomBaseUrl: 'false',
      providerTokenEnv: '',
    });
  }
  if (rawUrl.length === 0 || rawModel.length === 0) {
    throw new Error('Both LLM gateway URL and model must be configured together');
  }
  if (rawModel.length > 128 || /[\s\0\r\n]/.test(rawModel)) {
    throw new Error('LLM model identifier must be 1..128 non-whitespace characters');
  }

  const baseUrl = normalizeGatewayBaseUrl(rawUrl);
  const providerId = inferGatewayProviderId(rawProvider, baseUrl);
  const api = resolveGatewayWireApi(
    firstNonEmptyEnv(env, 'CI_GPUSTACK_LOOPWRIGHT_LLM_PROTOCOL'),
    firstNonEmptyEnv(env, 'CI_GPUSTACK_LOOPWRIGHT_LLM_USE_ANTHROPIC', 'CI_GPUSTACK_CODEREVIEW_LLM_USE_ANTHROPIC'),
  );
  const resolvedThinking = resolveGatewayThinking(
    firstNonEmptyEnv(env, 'SELF_UPGRADE_INPUT_THINKING', 'CI_GPUSTACK_LOOPWRIGHT_LLM_THINKING', 'CI_GPUSTACK_CODEREVIEW_LLM_THINKING'),
    firstNonEmptyEnv(env, 'SELF_UPGRADE_INPUT_REASONING_EFFORT', 'CI_GPUSTACK_LOOPWRIGHT_LLM_REASONING_EFFORT', 'CI_GPUSTACK_CODEREVIEW_LLM_REASONING_EFFORT'),
    rawModel,
    baseUrl,
  );
  const thinkingLevel = resolvedThinking.level === 'off'
    ? 'off'
    : snapThinkingToCatalogMap(resolvedThinking.level, providerId, rawModel, api);
  const reasoning = thinkingLevel !== 'off';

  const isGlm5 = rawModel.toLowerCase().startsWith('glm-5') || rawModel.toLowerCase().includes('/glm-5');
  const rawCtx = firstNonEmptyEnv(env, 'CI_GPUSTACK_LOOPWRIGHT_LLM_CONTEXT_WINDOW_SIZE');
  const contextWindow = rawCtx.length > 0 ? Number.parseInt(rawCtx, 10) : (isGlm5 ? 1_000_000 : 128_000);
  if (!Number.isSafeInteger(contextWindow) || contextWindow < 4096 || contextWindow > 2_000_000) {
    throw new Error('LLM context window must be an integer in [4096, 2000000]');
  }
  const rawMaxTok = firstNonEmptyEnv(env, 'CI_GPUSTACK_LOOPWRIGHT_LLM_MAX_TOKENS');
  const desiredMaxTok = rawMaxTok.length > 0 ? Number.parseInt(rawMaxTok, 10) : (isGlm5 ? 65_536 : 32_768);
  if (!Number.isSafeInteger(desiredMaxTok) || desiredMaxTok < 256 || desiredMaxTok > 262_144) {
    throw new Error('LLM max tokens must be an integer in [256, 262144]');
  }
  const maxTokens = Math.min(desiredMaxTok, contextWindow);

  const samplingParams = {};
  const rawTemp = firstNonEmptyEnv(env, 'CI_GPUSTACK_LOOPWRIGHT_LLM_TEMPERATURE', 'CI_GPUSTACK_CODEREVIEW_LLM_TEMPERATURE');
  if (rawTemp.length > 0) {
    const temp = Number.parseFloat(rawTemp);
    if (!Number.isFinite(temp) || temp < 0 || temp > 2) {
      throw new Error('LLM temperature must be a finite number in [0, 2]');
    }
    samplingParams.temperature = temp;
  }
  const rawTopP = firstNonEmptyEnv(env, 'CI_GPUSTACK_LOOPWRIGHT_LLM_TOP_P', 'CI_GPUSTACK_CODEREVIEW_LLM_TOP_P');
  if (rawTopP.length > 0) {
    const topP = Number.parseFloat(rawTopP);
    if (!Number.isFinite(topP) || topP <= 0 || topP > 1) {
      throw new Error('LLM top_p must be a finite number in (0, 1]');
    }
    samplingParams.top_p = topP;
  }

  const lowerModel = rawModel.toLowerCase();
  const zaiCompat = api === 'openai-completions' && isZaiOrGlmTarget(rawModel, baseUrl)
    ? {
      thinkingFormat: 'zai',
      ...(!(lowerModel.startsWith('glm-4') || lowerModel.includes('/glm-4')) ? { supportsReasoningEffort: true } : {}),
    }
    : undefined;

  const tokenEnvName = 'LOOPWRIGHT_SELF_UPGRADE_LLM_TOKEN';
  const modelEntry = {
    id: rawModel,
    contextWindow,
    maxTokens,
    reasoning,
    ...(Object.keys(samplingParams).length > 0 ? { samplingParams } : {}),
    ...(zaiCompat !== undefined ? { compat: zaiCompat } : {}),
  };
  const modelsDoc = {
    providers: {
      [providerId]: {
        baseUrl,
        api,
        apiKey: `$${tokenEnvName}`,
        models: [modelEntry],
      },
    },
  };

  let writtenModelsPath = '';
  if (typeof modelsOutPath === 'string' && modelsOutPath.trim().length > 0) {
    const resolvedModelsOut = resolve(modelsOutPath);
    await mkdir(dirname(resolvedModelsOut), { recursive: true, mode: 0o700 });
    const flags = fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_TRUNC | (fsConstants.O_NOFOLLOW ?? 0);
    const handle = await open(resolvedModelsOut, flags, 0o600);
    try {
      await handle.writeFile(`${JSON.stringify(modelsDoc, null, 2)}\n`, 'utf8');
    } finally {
      await handle.close();
    }
    writtenModelsPath = resolvedModelsOut;
  }

  return Object.freeze({
    configured: true,
    modelProvider: providerId,
    modelId: rawModel,
    modelThinking: thinkingLevel,
    modelApi: api,
    modelBaseUrl: baseUrl,
    modelsJsonPath: writtenModelsPath,
    allowCustomBaseUrl: 'true',
    providerTokenEnv: tokenEnvName,
  });
}

function formatGithubOutputBlock(key, value) {
  const delimiter = `LOOPWRIGHT_EOF_${createHash('sha256').update(`${key}:${value}`, 'utf8').digest('hex').slice(0, 16)}`;
  return `${key}<<${delimiter}\n${value}\n${delimiter}\n`;
}

async function writeGithubOutputs(outputPath, summary, modelConfig) {
  const blocks = [
    formatGithubOutputBlock('recommended_mode', summary.recommendedMode),
    formatGithubOutputBlock('action_mode', summary.actionMode),
    formatGithubOutputBlock('stage_dir', summary.stageDir),
    formatGithubOutputBlock('npm_cache_dir', summary.npmCacheDir),
    formatGithubOutputBlock('upstream_records', JSON.stringify(summary.upstreamRecords)),
  ];
  if (modelConfig !== undefined) {
    blocks.push(
      formatGithubOutputBlock('model_provider', modelConfig.modelProvider),
      formatGithubOutputBlock('model_id', modelConfig.modelId),
      formatGithubOutputBlock('model_thinking', modelConfig.modelThinking),
      formatGithubOutputBlock('model_api', modelConfig.modelApi),
      formatGithubOutputBlock('model_base_url', modelConfig.modelBaseUrl),
      formatGithubOutputBlock('models_json', modelConfig.modelsJsonPath),
      formatGithubOutputBlock('allow_custom_base_url', modelConfig.allowCustomBaseUrl),
      formatGithubOutputBlock('provider_token_env', modelConfig.providerTokenEnv),
    );
  }
  await appendFile(outputPath, blocks.join(''), 'utf8');
}

function parseCliArgs(argv) {
  const parsed = {
    repoRoot: process.cwd(),
    stageDir: undefined,
    upstreamRecordsRaw: undefined,
    registryJsonRaw: undefined,
    requestedMode: 'auto',
    skipStage: false,
    offlineCheck: false,
    githubOutput: undefined,
    modelsOut: undefined,
    json: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--offline-check') {
      parsed.offlineCheck = true;
    } else if (arg === '--skip-stage') {
      parsed.skipStage = true;
    } else if (arg === '--json') {
      parsed.json = true;
    } else if (arg === '--repo' && i + 1 < argv.length) {
      i += 1;
      parsed.repoRoot = argv[i];
    } else if (arg === '--stage-dir' && i + 1 < argv.length) {
      i += 1;
      parsed.stageDir = argv[i];
    } else if (arg === '--upstream-records' && i + 1 < argv.length) {
      i += 1;
      parsed.upstreamRecordsRaw = argv[i];
    } else if (arg === '--registry-json' && i + 1 < argv.length) {
      i += 1;
      parsed.registryJsonRaw = argv[i];
    } else if (arg === '--requested-mode' && i + 1 < argv.length) {
      i += 1;
      parsed.requestedMode = argv[i];
    } else if (arg === '--github-output' && i + 1 < argv.length) {
      i += 1;
      parsed.githubOutput = argv[i];
    } else if (arg === '--models-out' && i + 1 < argv.length) {
      i += 1;
      parsed.modelsOut = argv[i];
    } else {
      throw new Error(`Unknown or incomplete CLI argument: "${arg}"`);
    }
  }
  return parsed;
}

async function main() {
  const cli = parseCliArgs(process.argv.slice(2));
  if (cli.offlineCheck && cli.githubOutput !== undefined && cli.githubOutput.length > 0) {
    throw new Error('Refusing --github-output with --offline-check; workflow outputs require upstream verification');
  }
  const resolvedRepo = resolve(cli.repoRoot);
  const discoveredRecords = cli.upstreamRecordsRaw !== undefined
    ? await readJsonArgOrFile(cli.upstreamRecordsRaw, resolvedRepo)
    : undefined;
  const registryFixtures = cli.registryJsonRaw !== undefined
    ? await readJsonArgOrFile(cli.registryJsonRaw, resolvedRepo)
    : undefined;

  const modelConfig = cli.modelsOut !== undefined
    ? await resolveSelfUpgradeModelConfig({ env: process.env, modelsOutPath: cli.modelsOut })
    : undefined;

  const result = await runPrepareSelfUpgrade({
    repoRoot: resolvedRepo,
    stageDir: cli.stageDir,
    requestedMode: cli.requestedMode,
    skipStage: cli.skipStage,
    offlineCheck: cli.offlineCheck,
    discoveredRecords,
    registryFixtures,
  });

  if (cli.githubOutput !== undefined && cli.githubOutput.length > 0) {
    await writeGithubOutputs(resolve(cli.githubOutput), result, modelConfig);
  }

  const outputSummary = {
    offlineCheck: result.offlineCheck,
    upstreamVerified: result.upstreamVerified,
    recommendedMode: result.recommendedMode,
    actionMode: result.actionMode,
    stageDir: result.stageDir,
    npmCacheDir: result.npmCacheDir,
    piBaseline: result.baseline.piBaseline,
    yamlBaseline: result.baseline.yamlBaseline,
    upstreamRecords: result.upstreamRecords,
  };

  if (cli.json || !cli.offlineCheck) {
    process.stdout.write(`${JSON.stringify(outputSummary, null, 2)}\n`);
  } else {
    process.stdout.write(
      `self-upgrade offline check passed: taskpack=${result.taskpackName} pi=${result.baseline.piBaseline} yaml=${result.baseline.yamlBaseline} mode=${result.recommendedMode}\n`,
    );
  }
}

const isDirectExecution = process.argv[1] !== undefined && (() => {
  try {
    return resolve(process.argv[1]) === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
})();

if (isDirectExecution) {
  main().catch(error => {
    const detail = error instanceof Error ? error.message : String(error);
    process.stderr.write(`prepare-self-upgrade failed: ${detail}\n`);
    process.exitCode = 1;
  });
}
