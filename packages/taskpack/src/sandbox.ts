import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  closeSync, constants as fsConstants, existsSync, fstatSync, lstatSync, mkdirSync, openSync, readdirSync, realpathSync, rmdirSync, statSync, unlinkSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, resolve, sep } from 'node:path';
import type { Writable } from 'node:stream';
import {
  assertManifestScopeInvariants, effectiveProtectedPaths, isControlRootProposalWritableAllowed,
  normalizeRelativePath, pathCoveredBy, resolveManifestControlRoot, tryNormalizeRelativePath,
  validateExecutionAuthority,
} from './schema.js';
import { SecretScrubber } from './scrubber.js';
import {
  GITHUB_PROTECTED_AUTOMATION_PATHS, LOCAL_PROTECTED_AUTOMATION_PATHS, TaskpackError,
  type CompiledLinuxBwrapCommand, type CompiledMacosSeatbeltProfile, type Digest,
  type ExecutionHostPolicy, type NegotiatedSandboxBackend, type PolicyProfile,
  type SandboxBackendId, type SandboxCapability, type SandboxHostEnvironment,
  type SandboxedCommandInput, type SandboxedCommandResult, type SandboxNetworkMode,
  type SandboxPolicyInput, type SandboxReadOnlyBindMount, type TaskpackManifest,
} from './types.js';

export const TRUSTED_SEATBELT_PATHS: readonly string[] = Object.freeze(['/usr/bin/sandbox-exec']);
export const TRUSTED_BWRAP_PATHS: readonly string[] = Object.freeze(['/usr/bin/bwrap', '/bin/bwrap', '/usr/local/bin/bwrap']);
export const TRUSTED_PYTHON_PATHS: readonly string[] = Object.freeze(['/usr/bin/python3', '/bin/python3', '/usr/local/bin/python3']);
export const TRUSTED_DOCKER_PATHS: readonly string[] = Object.freeze(['/usr/local/bin/docker', '/usr/bin/docker', '/opt/homebrew/bin/docker']);

export const DEFAULT_DENIED_HOME_SUBPATHS: readonly string[] = Object.freeze([
  '.ssh', '.aws', '.gnupg', '.kube', '.docker', '.config/gh', '.npmrc', '.pypirc', '.netrc',
]);

/** Neutral built-in workspace subpaths protected under `'local'` mode (active controlRoot and manifest paths are added dynamically). */
export const ALWAYS_PROTECTED_WORKSPACE_SUBPATHS: readonly string[] = Object.freeze(['.git']);
/** Built-in workspace subpaths protected under `'github'` mode (`.github/workflows/**` unlocked only via dual-key `allowWorkflowWrites`). */
export const GITHUB_PROTECTED_WORKSPACE_SUBPATHS: readonly string[] = Object.freeze(['.git', '.github']);

export const DEFAULT_REQUIRED_SANDBOX_CAPABILITIES: readonly SandboxCapability[] = Object.freeze([
  'filesystemReadContainment',
  'filesystemWriteContainment',
  'protectedPathReadOnlyMask',
  'networkIsolation',
  'processTreeCleanup',
]);

export const SANDBOX_CAPABILITIES_BY_BACKEND: Readonly<Record<SandboxBackendId, readonly SandboxCapability[]>> = Object.freeze({
  'macos-seatbelt': Object.freeze<readonly SandboxCapability[]>([
    'filesystemReadContainment',
    'filesystemWriteContainment',
    'protectedPathReadOnlyMask',
    'networkIsolation',
    'processTreeCleanup',
  ]),
  'linux-bwrap': Object.freeze<readonly SandboxCapability[]>([
    'filesystemReadContainment',
    'filesystemWriteContainment',
    'protectedPathReadOnlyMask',
    'networkIsolation',
    'processTreeCleanup',
    'syscallFiltering',
  ]),
  'linux-landlock': Object.freeze<readonly SandboxCapability[]>([
    'filesystemReadContainment',
    'filesystemWriteContainment',
    'protectedPathReadOnlyMask',
    'networkIsolation',
    'processTreeCleanup',
  ]),
  'docker': Object.freeze<readonly SandboxCapability[]>([
    'filesystemReadContainment',
    'filesystemWriteContainment',
    'protectedPathReadOnlyMask',
    'networkIsolation',
    'processTreeCleanup',
    'syscallFiltering',
  ]),
  'direct-dedicated': Object.freeze<readonly SandboxCapability[]>([
    'processTreeCleanup',
  ]),
});

export const SECCOMP_BLOCKED_SYSCALLS: readonly string[] = Object.freeze([
  'ptrace', 'kexec_load', 'kexec_file_load', 'mount', 'umount2', 'pivot_root',
  'bpf', 'perf_event_open', 'userfaultfd', 'keyctl', 'add_key', 'request_key',
  'io_uring_setup', 'io_uring_enter', 'io_uring_register',
]);

const DEFAULT_SANDBOX_TIMEOUT_MS = 30_000;
const MAX_SANDBOX_TIMEOUT_MS = 300_000;
const DEFAULT_SANDBOX_OUTPUT_BYTES = 1_048_576;
export const MAX_LINUX_BWRAP_ARGS = 8_500;

export interface ControlRootSiblingSet {
  readonly prioritySiblings: readonly string[];
  readonly regularSiblings: readonly string[];
}

export interface CollectGitHubSiblingPathsOptions {
  readonly repositoryRoot?: string | undefined;
  readonly gitRevisions?: readonly string[] | undefined;
}

/**
 * Enumerate existing sibling entries along the `controlRoot -> dirname(proposalPath)` spine
 * so carved-out control-root proposals preserve protected-sibling semantics.
 */
export function collectControlRootSiblingPaths(options: {
  readonly repositoryRoot?: string | undefined;
  readonly controlRoot: string;
  readonly proposalPath: string;
  readonly gitRevisions?: readonly string[] | undefined;
}): ControlRootSiblingSet {
  const empty: ControlRootSiblingSet = Object.freeze({
    prioritySiblings: Object.freeze([]),
    regularSiblings: Object.freeze([]),
  });
  if (
    options.repositoryRoot === undefined
    || options.repositoryRoot.trim().length === 0
    || options.proposalPath === options.controlRoot
    || !pathCoveredBy(options.proposalPath, options.controlRoot)
  ) {
    return empty;
  }
  const resolvedRoot = resolve(options.repositoryRoot);
  if (!existsSync(resolvedRoot)) {
    return empty;
  }

  const suffix = options.proposalPath.slice(options.controlRoot.length + 1);
  const relSegments = suffix.split('/').filter(Boolean);
  if (relSegments.length === 0) return empty;

  const spineLevels: { readonly dirRel: string; readonly spineChild: string }[] = [];
  let cursorRel = options.controlRoot;
  for (const seg of relSegments) {
    spineLevels.push({ dirRel: cursorRel, spineChild: seg });
    cursorRel = `${cursorRel}/${seg}`;
  }

  const priority = new Set<string>();
  const regular = new Set<string>();

  for (const { dirRel, spineChild } of spineLevels) {
    const dirAbs = join(resolvedRoot, ...dirRel.split('/'));
    let dirStat: ReturnType<typeof lstatSync> | null;
    try {
      dirStat = lstatSync(dirAbs);
    } catch {
      dirStat = null;
    }
    if (dirStat !== null && !dirStat.isSymbolicLink() && dirStat.isDirectory()) {
      const dirents = readdirSync(dirAbs, { withFileTypes: true });
      const lowerSpineChild = spineChild.normalize('NFC').toLowerCase();
      for (const dirent of dirents) {
        if (dirent.name === spineChild) continue;
        const childRel = `${dirRel}/${dirent.name}`;
        if (tryNormalizeRelativePath(childRel) !== childRel) continue;
        const isCaseCollision = dirent.name.normalize('NFC').toLowerCase() === lowerSpineChild;
        if (dirent.isSymbolicLink() || dirent.isDirectory() || !dirent.isFile() || isCaseCollision) {
          priority.add(childRel);
          regular.delete(childRel);
        } else if (!priority.has(childRel)) {
          regular.add(childRel);
        }
      }
    }
  }

  const revisions = [
    ...new Set(
      (options.gitRevisions ?? []).filter(
        rev => typeof rev === 'string' && rev.trim().length > 0 && !rev.startsWith('-'),
      ),
    ),
  ];
  if (revisions.length > 0 && existsSync(join(resolvedRoot, '.git'))) {
    const gitExecutable = existsSync('/usr/bin/git') ? '/usr/bin/git' : 'git';
    for (const rev of revisions) {
      for (const { dirRel, spineChild } of spineLevels) {
        const res = spawnSync(
          gitExecutable,
          ['-c', 'core.hooksPath=/dev/null', 'ls-tree', '-z', `${rev}:${dirRel}`],
          {
            cwd: resolvedRoot,
            env: {
              PATH: '/usr/bin:/bin:/usr/local/bin',
              LANG: 'C',
              LC_ALL: 'C',
              GIT_TERMINAL_PROMPT: '0',
              GIT_CONFIG_NOSYSTEM: '1',
              GIT_CONFIG_GLOBAL: '/dev/null',
              HOME: '/nonexistent',
            },
            timeout: 5_000,
            maxBuffer: 4 * 1024 * 1024,
          },
        );
        if (res.status !== 0 || !res.stdout || res.stdout.byteLength === 0) continue;
        const text = res.stdout.toString('utf8');
        const rows = text.split('\0').filter(Boolean);
        const lowerSpineChild = spineChild.normalize('NFC').toLowerCase();
        for (const row of rows) {
          const parsed = /^([0-9]{6}) ([a-z]+) [0-9a-f]+\t(.+)$/s.exec(row);
          if (parsed === null) continue;
          const mode = parsed[1]!;
          const objType = parsed[2]!;
          const entryName = parsed[3]!;
          if (entryName === spineChild) continue;
          const childRel = `${dirRel}/${entryName}`;
          if (tryNormalizeRelativePath(childRel) !== childRel) continue;
          const isCaseCollision = entryName.normalize('NFC').toLowerCase() === lowerSpineChild;
          if (
            mode === '120000'
            || mode === '160000'
            || mode === '040000'
            || objType === 'tree'
            || objType === 'commit'
            || isCaseCollision
          ) {
            priority.add(childRel);
            regular.delete(childRel);
          } else if (!priority.has(childRel)) {
            regular.add(childRel);
          }
        }
      }
    }
  }

  return Object.freeze({
    prioritySiblings: Object.freeze([...priority].sort()),
    regularSiblings: Object.freeze([...regular].sort()),
  });
}

/**
 * Enumerate existing non-`workflows` sibling entries under `<repositoryRoot>/.github`
 * so `'github'` mode with `allowWorkflowWrites: true` keeps `.github/CODEOWNERS`,
 * templates, and custom actions protected while unlocking `.github/workflows/**`.
 */
export function collectGitHubSiblingPaths(options: CollectGitHubSiblingPathsOptions = {}): readonly string[] {
  if (options.repositoryRoot === undefined || options.repositoryRoot.trim().length === 0) {
    return Object.freeze([]);
  }
  const resolvedRoot = resolve(options.repositoryRoot);
  if (!existsSync(resolvedRoot)) {
    return Object.freeze([]);
  }
  const siblings = new Set<string>();
  const githubAbs = join(resolvedRoot, '.github');
  let dirStat: ReturnType<typeof lstatSync> | null;
  try {
    dirStat = lstatSync(githubAbs);
  } catch {
    dirStat = null;
  }
  if (dirStat !== null && !dirStat.isSymbolicLink() && dirStat.isDirectory()) {
    for (const dirent of readdirSync(githubAbs, { withFileTypes: true })) {
      if (dirent.name.normalize('NFC').toLowerCase() === 'workflows') continue;
      const childRel = `.github/${dirent.name}`;
      if (tryNormalizeRelativePath(childRel) === childRel) {
        siblings.add(childRel);
      }
    }
  }
  const revisions = [
    ...new Set(
      (options.gitRevisions ?? []).filter(
        rev => typeof rev === 'string' && rev.trim().length > 0 && !rev.startsWith('-'),
      ),
    ),
  ];
  if (revisions.length > 0 && existsSync(join(resolvedRoot, '.git'))) {
    const gitExecutable = existsSync('/usr/bin/git') ? '/usr/bin/git' : 'git';
    for (const rev of revisions) {
      const res = spawnSync(
        gitExecutable,
        ['-c', 'core.hooksPath=/dev/null', 'ls-tree', '-z', `${rev}:.github`],
        {
          cwd: resolvedRoot,
          env: {
            PATH: '/usr/bin:/bin:/usr/local/bin',
            LANG: 'C',
            LC_ALL: 'C',
            GIT_TERMINAL_PROMPT: '0',
            GIT_CONFIG_NOSYSTEM: '1',
            GIT_CONFIG_GLOBAL: '/dev/null',
            HOME: '/nonexistent',
          },
          timeout: 5_000,
          maxBuffer: 4 * 1024 * 1024,
        },
      );
      if (res.status !== 0 || !res.stdout || res.stdout.byteLength === 0) continue;
      for (const row of res.stdout.toString('utf8').split('\0').filter(Boolean)) {
        const parsed = /^[0-9]{6} [a-z]+ [0-9a-f]+\t(.+)$/s.exec(row);
        if (parsed === null) continue;
        const entryName = parsed[1]!;
        if (entryName.normalize('NFC').toLowerCase() === 'workflows') continue;
        const childRel = `.github/${entryName}`;
        if (tryNormalizeRelativePath(childRel) === childRel) {
          siblings.add(childRel);
        }
      }
    }
  }
  return Object.freeze([...siblings].sort());
}

function policyInvalid(message: string, path: string | null = null): never {
  throw new TaskpackError('SANDBOX_POLICY_INVALID', message, path);
}

function sha256Digest(domain: string, payload: string): Digest {
  const hex = createHash('sha256').update(`${domain}\0${payload}`, 'utf8').digest('hex');
  return Object.freeze({ algorithm: 'sha256' as const, hex });
}

function assertCleanPathString(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 1024) {
    policyInvalid(`${label} must be a non-empty string of at most 1024 characters`, label);
  }
  if (/[\0\r\n"\\]/.test(value)) {
    policyInvalid(`${label} contains forbidden characters`, label);
  }
  return value;
}

function canonicalizeAbsolutePath(rawPath: string, label: string): string {
  const cleaned = assertCleanPathString(rawPath, label);
  if (!isAbsolute(cleaned)) {
    policyInvalid(`${label} must be an absolute path`, label);
  }
  const resolved = resolve(cleaned);
  const suffixSegments: string[] = [];
  let cursor = resolved;
  while (true) {
    if (existsSync(cursor)) {
      try {
        const realBase = realpathSync(cursor);
        const joined = suffixSegments.length === 0 ? realBase : join(realBase, ...suffixSegments.reverse());
        if (/[\0\r\n"\\]/.test(joined)) policyInvalid(`${label} resolved to a path with forbidden characters`, label);
        return joined;
      } catch {
        // Fall through to parent if a broken symlink was encountered at cursor.
      }
    }
    const parent = dirname(cursor);
    if (parent === cursor) {
      return resolved;
    }
    const base = cursor.slice(parent === '/' ? 1 : parent.length + 1);
    suffixSegments.push(base);
    cursor = parent;
  }
}

function normalizeRelativeSubpath(raw: string, label: string): string {
  const cleaned = assertCleanPathString(raw, label);
  if (cleaned.startsWith('/')) {
    policyInvalid(`${label} must be relative`, label);
  }
  const segments = cleaned.split('/');
  for (const segment of segments) {
    if (segment === '' || segment === '.' || segment === '..' || segment.includes('**')) {
      policyInvalid(`${label} contains disallowed segment "${segment}"`, label);
    }
  }
  return segments.join('/');
}

function normalizeRelativeScopeEntry(
  raw: string,
  label: string,
): { readonly base: string; readonly subtree: boolean; readonly hasGlob: boolean } {
  const cleaned = assertCleanPathString(raw, label);
  const subtree = cleaned.endsWith('/**');
  const baseRaw = subtree ? cleaned.slice(0, -3) : cleaned;
  const base = normalizeRelativeSubpath(baseRaw, label);
  const hasGlob = base.includes('*') || base.includes('?');
  return { base, subtree, hasGlob };
}

function segmentHasGlob(segment: string): boolean {
  return segment.includes('*') || segment.includes('?');
}

function segmentGlobToRegExp(segment: string): RegExp {
  let expr = '^';
  for (let i = 0; i < segment.length; i += 1) {
    const ch = segment[i]!;
    if (ch === '*') expr += '[^/]*';
    else if (ch === '?') expr += '[^/]';
    else if ('\\^$.|+()[]{}'.includes(ch)) expr += `\\${ch}`;
    else expr += ch;
  }
  expr += '$';
  return new RegExp(expr);
}

function escapeSeatbeltRegexLiteral(text: string): string {
  if (/[\r\n]/.test(text)) {
    policyInvalid('sandbox seatbelt regex literal must not contain line breaks');
  }
  return text.replace(/[\\^$.|+()*?[\]{}"]/g, '\\$&');
}

function segmentGlobToSeatbeltRegex(segment: string): string {
  if (/[\r\n]/.test(segment)) {
    policyInvalid('sandbox seatbelt glob segment must not contain line breaks');
  }
  let expr = '';
  for (let i = 0; i < segment.length; i += 1) {
    const ch = segment[i]!;
    if (ch === '*') expr += '[^/]*';
    else if (ch === '?') expr += '[^/]';
    else if ('\\^$.|+()[]{}"'.includes(ch)) expr += `\\${ch}`;
    else expr += ch;
  }
  return expr;
}

function buildSeatbeltRegexForRelativeGlob(
  canonicalWorkspaceRoot: string,
  base: string,
): string {
  const rootPrefix = canonicalWorkspaceRoot === '/'
    ? ''
    : escapeSeatbeltRegexLiteral(canonicalWorkspaceRoot);
  const segments = base.split('/');
  let expr = `^${rootPrefix}/`;
  for (let i = 0; i < segments.length; i += 1) {
    const seg = segments[i]!;
    const isLast = i === segments.length - 1;
    if (!isLast) {
      if (seg === '**') {
        expr += '(?:[^/]+/)*';
      } else {
        expr += `${segmentGlobToSeatbeltRegex(seg)}/`;
      }
    } else if (seg === '**') {
      expr += '.+';
    } else {
      expr += `${segmentGlobToSeatbeltRegex(seg)}(/.*)?`;
    }
  }
  expr += '$';
  return expr;
}

const MAX_GLOB_VISITED_DIRS = 2_048;
const MAX_GLOB_EXPANDED_PATHS = 16_384;
const MAX_READ_ONLY_BIND_MOUNTS = 16;

interface GlobExpansionBudget {
  visitedDirs: number;
  expandedPaths: number;
}

function expandDirectorySegmentsSync(
  workspaceRoot: string,
  segments: readonly string[],
  label: string,
  budget: GlobExpansionBudget,
): readonly string[] {
  if (segments.length === 0) return [workspaceRoot];
  if (!segments.some(segmentHasGlob)) {
    return [canonicalizeAbsolutePath(join(workspaceRoot, ...segments), label)];
  }
  if (!existsSync(workspaceRoot)) return [];
  let currentDirs: string[] = [workspaceRoot];
  for (const segment of segments) {
    const nextDirs: string[] = [];
    if (!segmentHasGlob(segment)) {
      for (const dir of currentDirs) {
        budget.visitedDirs += 1;
        if (budget.visitedDirs > MAX_GLOB_VISITED_DIRS) {
          policyInvalid(`sandbox glob expansion exceeded ${MAX_GLOB_VISITED_DIRS} visited directories`, label);
        }
        const candidate = join(dir, segment);
        let st: ReturnType<typeof lstatSync> | null;
        try {
          st = lstatSync(candidate);
        } catch {
          st = null;
        }
        if (st !== null && !st.isSymbolicLink() && st.isDirectory()) {
          budget.expandedPaths += 1;
          if (budget.expandedPaths > MAX_GLOB_EXPANDED_PATHS) {
            policyInvalid(`sandbox glob expansion exceeded ${MAX_GLOB_EXPANDED_PATHS} expanded paths`, label);
          }
          nextDirs.push(canonicalizeAbsolutePath(candidate, label));
        }
      }
    } else {
      const matcher = segmentGlobToRegExp(segment);
      for (const dir of currentDirs) {
        budget.visitedDirs += 1;
        if (budget.visitedDirs > MAX_GLOB_VISITED_DIRS) {
          policyInvalid(`sandbox glob expansion exceeded ${MAX_GLOB_VISITED_DIRS} visited directories`, label);
        }
        let entries: string[];
        try {
          entries = readdirSync(dir, { encoding: 'utf8' }).sort();
        } catch {
          entries = [];
        }
        for (const name of entries) {
          if (name === '.' || name === '..' || !matcher.test(name)) continue;
          const candidate = join(dir, name);
          let st: ReturnType<typeof lstatSync> | null;
          try {
            st = lstatSync(candidate);
          } catch {
            st = null;
          }
          if (st !== null && !st.isSymbolicLink() && st.isDirectory()) {
            budget.expandedPaths += 1;
            if (budget.expandedPaths > MAX_GLOB_EXPANDED_PATHS) {
              policyInvalid(`sandbox glob expansion exceeded ${MAX_GLOB_EXPANDED_PATHS} expanded paths`, label);
            }
            nextDirs.push(canonicalizeAbsolutePath(candidate, label));
          }
        }
      }
    }
    currentDirs = nextDirs;
    if (currentDirs.length === 0) break;
  }
  return currentDirs;
}

function isSameOrSubpath(candidate: string, root: string): boolean {
  if (root === '/') return true;
  return candidate === root || candidate.startsWith(`${root}${sep}`);
}

function isSameOrSubpathCaseInsensitive(candidate: string, root: string): boolean {
  return isSameOrSubpath(candidate.normalize('NFC').toLowerCase(), root.normalize('NFC').toLowerCase());
}

interface ResolvedHostEnvironment {
  readonly platform: string;
  readonly arch: string;
  readonly homeDirectory: string;
  readonly probeExecutables: boolean;
  readonly seatbeltExecutable?: string | undefined;
  readonly bwrapExecutable?: string | undefined;
  readonly pythonExecutable?: string | undefined;
  readonly dockerExecutable?: string | undefined;
  readonly dockerSocket?: string | undefined;
}

function resolveHostEnvironment(host?: SandboxHostEnvironment): ResolvedHostEnvironment {
  return {
    platform: host?.platform ?? process.platform,
    arch: host?.arch ?? process.arch,
    homeDirectory: host?.homeDirectory ?? process.env.HOME ?? homedir(),
    probeExecutables: host?.probeExecutables ?? true,
    seatbeltExecutable: host?.seatbeltExecutable,
    bwrapExecutable: host?.bwrapExecutable,
    pythonExecutable: host?.pythonExecutable,
    dockerExecutable: host?.dockerExecutable,
    dockerSocket: host?.dockerSocket,
  };
}

interface ProtectedGlobPrefix {
  readonly raw: string;
  readonly staticPrefixDir: string;
}

interface NormalizedSandboxPaths {
  readonly canonicalWorkspaceRoot: string;
  readonly canonicalScratchDirectory: string | null;
  readonly canonicalWritablePaths: readonly string[];
  readonly canonicalExactWritableFiles: ReadonlySet<string>;
  readonly seatbeltExactFileRegexes: readonly string[];
  readonly seatbeltProtectedGlobRegexes: readonly string[];
  readonly protectedGlobPrefixes: readonly ProtectedGlobPrefix[];
  readonly canonicalProtectedPaths: readonly string[];
  readonly canonicalDeniedReadPaths: readonly string[];
  readonly canonicalAllowedReadOnlyPaths: readonly string[];
  readonly canonicalReadOnlyBindMounts: readonly SandboxReadOnlyBindMount[];
  readonly networkMode: SandboxNetworkMode;
}

function findDynamicProtectedGlobOverlap(normalized: NormalizedSandboxPaths): string | null {
  if (normalized.protectedGlobPrefixes.length === 0) return null;
  const writableDirs = normalized.canonicalWritablePaths.filter(wp => !normalized.canonicalExactWritableFiles.has(wp));
  for (const g of normalized.protectedGlobPrefixes) {
    if (writableDirs.some(wp => isSameOrSubpath(g.staticPrefixDir, wp) || isSameOrSubpath(wp, g.staticPrefixDir))) {
      return g.raw;
    }
  }
  return null;
}

function findLandlockWritableOverlap(normalized: NormalizedSandboxPaths): string | null {
  const globOverlap = findDynamicProtectedGlobOverlap(normalized);
  if (globOverlap !== null) {
    return `dynamic protected glob "${globOverlap}"`;
  }
  const writableDirs = normalized.canonicalWritablePaths.filter(wp => !normalized.canonicalExactWritableFiles.has(wp));
  if (writableDirs.length === 0) return null;
  for (const protectedPath of normalized.canonicalProtectedPaths) {
    if (writableDirs.some(wp => isSameOrSubpath(protectedPath, wp))) {
      return `protectedPath "${protectedPath}"`;
    }
  }
  for (const deniedPath of normalized.canonicalDeniedReadPaths) {
    if (writableDirs.some(wp => isSameOrSubpath(deniedPath, wp))) {
      return `deniedReadPath "${deniedPath}"`;
    }
  }
  return null;
}

function provisionSandboxExactWritablePaths(
  normalized: NormalizedSandboxPaths,
  options: { readonly createTargetFile: boolean },
): void {
  if (normalized.canonicalExactWritableFiles.size === 0 || !existsSync(normalized.canonicalWorkspaceRoot)) {
    return;
  }
  const rootStat = lstatSync(normalized.canonicalWorkspaceRoot);
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
    policyInvalid('workspaceRoot must be an existing non-symlink directory', 'workspaceRoot');
  }
  for (const exactFile of normalized.canonicalExactWritableFiles) {
    if (!isSameOrSubpath(exactFile, normalized.canonicalWorkspaceRoot) || exactFile === normalized.canonicalWorkspaceRoot) {
      policyInvalid(`exact writable file "${exactFile}" escapes workspaceRoot`, 'proposalPath');
    }
    const rel = exactFile.slice(normalized.canonicalWorkspaceRoot.length + 1);
    const segments = rel.split(sep).filter(Boolean);
    let cursor = normalized.canonicalWorkspaceRoot;
    for (let i = 0; i < segments.length - 1; i += 1) {
      cursor = join(cursor, segments[i]!);
      let parentStat: ReturnType<typeof lstatSync> | null;
      try {
        parentStat = lstatSync(cursor);
      } catch {
        parentStat = null;
      }
      if (parentStat === null) {
        mkdirSync(cursor, { mode: 0o700 });
      } else if (parentStat.isSymbolicLink() || !parentStat.isDirectory()) {
        policyInvalid(`parent segment of exact writable file "${exactFile}" must be a real directory`, 'proposalPath');
      }
    }
    let targetStat: ReturnType<typeof lstatSync> | null;
    try {
      targetStat = lstatSync(exactFile);
    } catch {
      targetStat = null;
    }
    if (targetStat === null) {
      if (options.createTargetFile) {
        const openFlags = fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY | (fsConstants.O_NOFOLLOW ?? 0);
        const fd = openSync(exactFile, openFlags, 0o600);
        closeSync(fd);
      }
    } else if (targetStat.isSymbolicLink() || !targetStat.isFile() || targetStat.nlink > 1) {
      policyInvalid(`exact writable file "${exactFile}" must be a regular non-hardlinked file`, 'proposalPath');
    }
  }
}

function normalizeSandboxPolicy(policy: SandboxPolicyInput, host?: SandboxHostEnvironment): NormalizedSandboxPaths {
  if (policy === null || typeof policy !== 'object') {
    policyInvalid('policy must be an object', '/policy');
  }
  const env = resolveHostEnvironment(host);
  const canonicalWorkspaceRoot = canonicalizeAbsolutePath(policy.workspaceRoot, 'workspaceRoot');
  const canonicalScratchDirectory = policy.scratchDirectory === undefined
    ? null
    : canonicalizeAbsolutePath(policy.scratchDirectory, 'scratchDirectory');
  const protectGitHub = policy.policyProfile === 'github' || policy.protectGitHubDir === true;
  const allowWorkflowWrites = protectGitHub && policy.allowWorkflowWrites === true;
  const strictExactFiles = policy.strictExactFiles === true;

  const networkMode: SandboxNetworkMode = policy.networkMode ?? 'none';
  if (networkMode !== 'none' && networkMode !== 'loopback-only' && networkMode !== 'allow-outbound') {
    policyInvalid(`unsupported networkMode "${String(networkMode)}"`, 'networkMode');
  }

  if (!Array.isArray(policy.writablePaths) || policy.writablePaths.length === 0 || policy.writablePaths.length > 128) {
    policyInvalid('writablePaths must be a non-empty array of at most 128 paths', 'writablePaths');
  }

  const protectedGlobBudget: GlobExpansionBudget = { visitedDirs: 0, expandedPaths: 0 };
  const callerProtectedRelPaths: string[] = [];
  const seatbeltProtectedGlobRegexSet = new Set<string>();
  const protectedGlobPrefixesList: ProtectedGlobPrefix[] = [];
  if (policy.protectedPaths !== undefined) {
    if (!Array.isArray(policy.protectedPaths) || policy.protectedPaths.length > 128) {
      policyInvalid('protectedPaths must be an array of at most 128 paths', 'protectedPaths');
    }
    for (const [index, entry] of policy.protectedPaths.entries()) {
      const cleaned = assertCleanPathString(entry, `protectedPaths/${index}`);
      if (isAbsolute(cleaned)) {
        const canonicalProtected = canonicalizeAbsolutePath(cleaned, `protectedPaths/${index}`);
        if (!isSameOrSubpath(canonicalProtected, canonicalWorkspaceRoot)) {
          policyInvalid(`protectedPath "${entry}" escapes workspaceRoot`, `protectedPaths/${index}`);
        }
        const rel = canonicalProtected.slice(canonicalWorkspaceRoot.length + 1);
        if (rel.length === 0) policyInvalid('protectedPath must not be workspaceRoot itself', `protectedPaths/${index}`);
        callerProtectedRelPaths.push(normalizeRelativeSubpath(rel.split(sep).join('/'), `protectedPaths/${index}`));
      } else {
        const parsedProtected = normalizeRelativeScopeEntry(cleaned, `protectedPaths/${index}`);
        if (!parsedProtected.hasGlob) {
          callerProtectedRelPaths.push(parsedProtected.base);
        } else {
          const segments = parsedProtected.base.split('/');
          const firstGlobIdx = segments.findIndex(segmentHasGlob);
          const staticPrefixSegments = firstGlobIdx > 0 ? segments.slice(0, firstGlobIdx) : [];
          const staticPrefixDir = staticPrefixSegments.length === 0
            ? canonicalWorkspaceRoot
            : canonicalizeAbsolutePath(join(canonicalWorkspaceRoot, ...staticPrefixSegments), `protectedPaths/${index}`);
          protectedGlobPrefixesList.push(Object.freeze({ raw: cleaned, staticPrefixDir }));
          seatbeltProtectedGlobRegexSet.add(
            buildSeatbeltRegexForRelativeGlob(canonicalWorkspaceRoot, parsedProtected.base),
          );
          if (parsedProtected.subtree) {
            for (const dir of expandDirectorySegmentsSync(canonicalWorkspaceRoot, segments, `protectedPaths/${index}`, protectedGlobBudget)) {
              if (dir !== canonicalWorkspaceRoot && isSameOrSubpath(dir, canonicalWorkspaceRoot)) {
                callerProtectedRelPaths.push(dir.slice(canonicalWorkspaceRoot.length + 1).split(sep).join('/'));
              }
            }
          } else {
            const parentSegments = segments.slice(0, -1);
            const leafSegment = segments[segments.length - 1]!;
            const parentDirs = expandDirectorySegmentsSync(canonicalWorkspaceRoot, parentSegments, `protectedPaths/${index}`, protectedGlobBudget);
            if (!segmentHasGlob(leafSegment)) {
              for (const parentDir of parentDirs) {
                protectedGlobBudget.expandedPaths += 1;
                if (protectedGlobBudget.expandedPaths > MAX_GLOB_EXPANDED_PATHS) {
                  policyInvalid(`sandbox glob expansion exceeded ${MAX_GLOB_EXPANDED_PATHS} expanded paths`, `protectedPaths/${index}`);
                }
                const target = canonicalizeAbsolutePath(join(parentDir, leafSegment), `protectedPaths/${index}`);
                if (target !== canonicalWorkspaceRoot && isSameOrSubpath(target, canonicalWorkspaceRoot)) {
                  callerProtectedRelPaths.push(target.slice(canonicalWorkspaceRoot.length + 1).split(sep).join('/'));
                }
              }
            } else {
              const leafMatcher = segmentGlobToRegExp(leafSegment);
              for (const parentDir of parentDirs) {
                protectedGlobBudget.visitedDirs += 1;
                if (protectedGlobBudget.visitedDirs > MAX_GLOB_VISITED_DIRS) {
                  policyInvalid(`sandbox glob expansion exceeded ${MAX_GLOB_VISITED_DIRS} visited directories`, `protectedPaths/${index}`);
                }
                let names: string[];
                try {
                  names = readdirSync(parentDir, { encoding: 'utf8' }).sort();
                } catch {
                  names = [];
                }
                for (const name of names) {
                  if (name === '.' || name === '..' || !leafMatcher.test(name)) continue;
                  protectedGlobBudget.expandedPaths += 1;
                  if (protectedGlobBudget.expandedPaths > MAX_GLOB_EXPANDED_PATHS) {
                    policyInvalid(`sandbox glob expansion exceeded ${MAX_GLOB_EXPANDED_PATHS} expanded paths`, `protectedPaths/${index}`);
                  }
                  const target = canonicalizeAbsolutePath(join(parentDir, name), `protectedPaths/${index}`);
                  if (target !== canonicalWorkspaceRoot && isSameOrSubpath(target, canonicalWorkspaceRoot)) {
                    callerProtectedRelPaths.push(target.slice(canonicalWorkspaceRoot.length + 1).split(sep).join('/'));
                  }
                }
              }
            }
          }
        }
      }
    }
  }

  const effectiveControlRoot = policy.controlRoot !== undefined
    ? normalizeRelativeSubpath(policy.controlRoot, 'controlRoot')
    : '.loopwright';
  const canonicalControlRoot = canonicalizeAbsolutePath(join(canonicalWorkspaceRoot, effectiveControlRoot), 'controlRoot');
  const normalizedProposalPath = policy.proposalPath !== undefined
    ? normalizeRelativeSubpath(policy.proposalPath, 'proposalPath')
    : undefined;

  const profileWorkspaceProtected = protectGitHub
    ? (allowWorkflowWrites
      ? GITHUB_PROTECTED_WORKSPACE_SUBPATHS.filter(sub => sub !== '.github')
      : GITHUB_PROTECTED_WORKSPACE_SUBPATHS)
    : ALWAYS_PROTECTED_WORKSPACE_SUBPATHS;
  const profileAutomationProtected = protectGitHub
    ? (allowWorkflowWrites
      ? GITHUB_PROTECTED_AUTOMATION_PATHS.filter(sub => sub !== '.github')
      : GITHUB_PROTECTED_AUTOMATION_PATHS)
    : LOCAL_PROTECTED_AUTOMATION_PATHS;
  const discoveredGitHubSiblings = allowWorkflowWrites
    ? collectGitHubSiblingPaths({ repositoryRoot: canonicalWorkspaceRoot })
    : [];

  let omitBareControlRootProtection = false;
  let canonicalProposalFile: string | null = null;
  let discoveredSiblings: { readonly prioritySiblings: readonly string[]; readonly regularSiblings: readonly string[] } = {
    prioritySiblings: [],
    regularSiblings: [],
  };
  if (normalizedProposalPath !== undefined) {
    discoveredSiblings = collectControlRootSiblingPaths({
      repositoryRoot: canonicalWorkspaceRoot,
      controlRoot: effectiveControlRoot,
      proposalPath: normalizedProposalPath,
    });
    const workspaceRelativeWritables: string[] = [];
    for (const [index, entry] of policy.writablePaths.entries()) {
      const cleaned = assertCleanPathString(entry, `writablePaths/${index}`);
      if (cleaned === '.' || cleaned === '**') {
        workspaceRelativeWritables.push(cleaned);
        continue;
      }
      if (isAbsolute(cleaned)) {
        const canonicalEntry = canonicalizeAbsolutePath(cleaned, `writablePaths/${index}`);
        if (isSameOrSubpath(canonicalEntry, canonicalWorkspaceRoot)) {
          if (canonicalEntry === canonicalWorkspaceRoot) {
            workspaceRelativeWritables.push('.');
          } else {
            const rel = canonicalEntry.slice(canonicalWorkspaceRoot.length + 1).split(sep).join('/');
            workspaceRelativeWritables.push(rel);
          }
        }
      } else {
        const parsedWritable = normalizeRelativeScopeEntry(cleaned, `writablePaths/${index}`);
        workspaceRelativeWritables.push(parsedWritable.subtree ? `${parsedWritable.base}/**` : parsedWritable.base);
      }
    }
    const explicitControlProtected: string[] = [
      ...profileWorkspaceProtected,
      ...profileAutomationProtected,
      ...discoveredGitHubSiblings,
      `${effectiveControlRoot}/policies`,
      `${effectiveControlRoot}/checks`,
      `${effectiveControlRoot}/scripts`,
      `${effectiveControlRoot}/memory`,
      `${effectiveControlRoot}/taskpack.yaml`,
      `${effectiveControlRoot}/taskpack.yml`,
      `${effectiveControlRoot}/taskpack.json`,
      `${effectiveControlRoot}/digests.lock.json`,
      ...callerProtectedRelPaths,
      ...discoveredSiblings.prioritySiblings,
    ];
    if (
      !isControlRootProposalWritableAllowed(
        normalizedProposalPath,
        workspaceRelativeWritables,
        effectiveControlRoot,
        explicitControlProtected,
      )
    ) {
      policyInvalid(
        `proposalPath "${policy.proposalPath}" is not permitted as a carved-out control-root writable file`,
        'proposalPath',
      );
    }
    if (existsSync(canonicalWorkspaceRoot)) {
      const segments = normalizedProposalPath.split('/');
      let cursor = canonicalWorkspaceRoot;
      for (let i = 0; i < segments.length; i += 1) {
        cursor = join(cursor, segments[i]!);
        let st: ReturnType<typeof lstatSync> | null;
        try {
          st = lstatSync(cursor);
        } catch {
          st = null;
        }
        if (st === null) break;
        if (st.isSymbolicLink()) {
          policyInvalid(`proposalPath "${policy.proposalPath}" must not traverse or target symbolic links`, 'proposalPath');
        }
        if (i < segments.length - 1) {
          if (!st.isDirectory()) {
            policyInvalid(`parent segment of proposalPath "${policy.proposalPath}" is not a directory`, 'proposalPath');
          }
        } else if (!st.isFile() || st.nlink > 1) {
          policyInvalid(`proposalPath "${policy.proposalPath}" must be a regular non-hardlinked file when present`, 'proposalPath');
        }
      }
    }
    canonicalProposalFile = canonicalizeAbsolutePath(join(canonicalWorkspaceRoot, normalizedProposalPath), 'proposalPath');
    if (!isSameOrSubpath(canonicalProposalFile, canonicalControlRoot) || canonicalProposalFile === canonicalControlRoot) {
      policyInvalid(`proposalPath "${policy.proposalPath}" escapes controlRoot "${effectiveControlRoot}"`, 'proposalPath');
    }
    omitBareControlRootProtection = true;
  }

  const protectedSubpaths = new Set<string>([
    ...profileWorkspaceProtected,
    ...profileAutomationProtected,
    ...(omitBareControlRootProtection
      ? [
        `${effectiveControlRoot}/policies`,
        `${effectiveControlRoot}/checks`,
        `${effectiveControlRoot}/scripts`,
        `${effectiveControlRoot}/memory`,
        `${effectiveControlRoot}/taskpack.yaml`,
        `${effectiveControlRoot}/taskpack.yml`,
        `${effectiveControlRoot}/taskpack.json`,
        `${effectiveControlRoot}/digests.lock.json`,
        ...discoveredSiblings.prioritySiblings,
      ]
      : [effectiveControlRoot]),
    ...callerProtectedRelPaths,
  ]);
  for (const githubSibling of discoveredGitHubSiblings) {
    if (protectedSubpaths.size >= 128) break;
    protectedSubpaths.add(githubSibling);
  }
  if (omitBareControlRootProtection) {
    for (const sibling of discoveredSiblings.regularSiblings) {
      if (protectedSubpaths.size >= 128) break;
      protectedSubpaths.add(sibling);
    }
  }

  const canonicalProtectedSet = new Set<string>();
  for (const rel of protectedSubpaths) {
    canonicalProtectedSet.add(canonicalizeAbsolutePath(join(canonicalWorkspaceRoot, rel), `protectedPaths/${rel}`));
  }
  const canonicalProtectedPaths = Object.freeze([...canonicalProtectedSet].sort());
  const canonicalGitHubDir = canonicalizeAbsolutePath(join(canonicalWorkspaceRoot, '.github'), 'protectedPaths/.github');
  const canonicalWorkflowsDir = canonicalizeAbsolutePath(join(canonicalWorkspaceRoot, '.github', 'workflows'), 'protectedPaths/.github/workflows');

  const assertCanonicalGrantAllowed = (canonicalGrant: string, label: string, checkEncompassedProtected: boolean): void => {
    for (const protectedPath of canonicalProtectedPaths) {
      if (isSameOrSubpath(canonicalGrant, protectedPath)) {
        policyInvalid(`${label} targets protected path "${protectedPath}"`, label);
      }
      if (checkEncompassedProtected && isSameOrSubpath(protectedPath, canonicalGrant)) {
        policyInvalid(`${label} encompasses protected path "${protectedPath}"`, label);
      }
    }
    if (allowWorkflowWrites) {
      if (
        (isSameOrSubpath(canonicalGrant, canonicalGitHubDir) || isSameOrSubpathCaseInsensitive(canonicalGrant, canonicalGitHubDir))
        && !(isSameOrSubpath(canonicalGrant, canonicalWorkflowsDir) || isSameOrSubpathCaseInsensitive(canonicalGrant, canonicalWorkflowsDir))
      ) {
        policyInvalid(`${label} targets protected .github path "${canonicalGrant}" outside .github/workflows`, label);
      }
    }
    if (canonicalProposalFile !== null) {
      if (
        isSameOrSubpath(canonicalControlRoot, canonicalGrant)
        || isSameOrSubpathCaseInsensitive(canonicalControlRoot, canonicalGrant)
      ) {
        policyInvalid(
          `${label} canonicalizes to "${canonicalGrant}", encompassing protected control root "${canonicalControlRoot}"`,
          label,
        );
      }
      if (
        (isSameOrSubpath(canonicalGrant, canonicalControlRoot)
          || isSameOrSubpathCaseInsensitive(canonicalGrant, canonicalControlRoot))
        && canonicalGrant !== canonicalProposalFile
      ) {
        policyInvalid(
          `${label} canonicalizes to "${canonicalGrant}" inside control root "${canonicalControlRoot}" outside "${canonicalProposalFile}"`,
          label,
        );
      }
    }
  };

  if (canonicalProposalFile !== null) {
    for (const protectedPath of canonicalProtectedPaths) {
      if (
        isSameOrSubpath(canonicalProposalFile, protectedPath)
        || isSameOrSubpath(protectedPath, canonicalProposalFile)
        || isSameOrSubpathCaseInsensitive(canonicalProposalFile, protectedPath)
        || isSameOrSubpathCaseInsensitive(protectedPath, canonicalProposalFile)
      ) {
        policyInvalid(`proposalPath "${policy.proposalPath}" overlaps protected path "${protectedPath}"`, 'proposalPath');
      }
    }
  }

  const assertRegularExactFileTarget = (exactTarget: string, label: string): void => {
    if (!existsSync(canonicalWorkspaceRoot)) return;
    let st: ReturnType<typeof lstatSync> | null;
    try {
      st = lstatSync(exactTarget);
    } catch {
      st = null;
    }
    if (st !== null && (st.isSymbolicLink() || !st.isFile() || st.nlink > 1)) {
      policyInvalid(`${label} "${exactTarget}" must be a regular non-hardlinked file when present`, label);
    }
  };

  const canonicalWritableSet = new Set<string>();
  const exactWritableFilesSet = new Set<string>(canonicalProposalFile !== null ? [canonicalProposalFile] : []);
  const seatbeltExactRegexSet = new Set<string>();

  const registerGrant = (canonicalWritable: string, rawEntry: string, label: string, exactFile: boolean): void => {
    const insideWorkspace = isSameOrSubpath(canonicalWritable, canonicalWorkspaceRoot);
    const insideScratch = canonicalScratchDirectory !== null && isSameOrSubpath(canonicalWritable, canonicalScratchDirectory);
    if (!insideWorkspace && !insideScratch) {
      policyInvalid(`writablePath "${rawEntry}" escapes workspaceRoot`, label);
    }
    assertCanonicalGrantAllowed(canonicalWritable, label, false);
    if (exactFile && canonicalWritable !== canonicalWorkspaceRoot) {
      assertRegularExactFileTarget(canonicalWritable, label);
      exactWritableFilesSet.add(canonicalWritable);
    }
    canonicalWritableSet.add(canonicalWritable);
  };

  for (const [index, entry] of policy.writablePaths.entries()) {
    const label = `writablePaths/${index}`;
    const cleaned = assertCleanPathString(entry, label);
    if (cleaned === '.' || cleaned === '**') {
      registerGrant(canonicalWorkspaceRoot, entry, label, false);
      continue;
    }
    if (isAbsolute(cleaned)) {
      const canonicalWritable = canonicalizeAbsolutePath(cleaned, label);
      registerGrant(canonicalWritable, entry, label, strictExactFiles && canonicalWritable !== canonicalWorkspaceRoot);
      continue;
    }

    const parsed = normalizeRelativeScopeEntry(cleaned, label);
    if (!parsed.hasGlob) {
      const canonicalWritable = canonicalizeAbsolutePath(join(canonicalWorkspaceRoot, parsed.base), label);
      const isExact = (strictExactFiles && !parsed.subtree) || canonicalWritable === canonicalProposalFile;
      registerGrant(canonicalWritable, entry, label, isExact);
      continue;
    }

    const globBudget: GlobExpansionBudget = { visitedDirs: 0, expandedPaths: 0 };
    const segments = parsed.base.split('/');
    if (parsed.subtree) {
      for (const dir of expandDirectorySegmentsSync(canonicalWorkspaceRoot, segments, label, globBudget)) {
        registerGrant(dir, entry, label, false);
      }
      continue;
    }

    const parentSegments = segments.slice(0, -1);
    const leafSegment = segments[segments.length - 1]!;
    const parentDirs = expandDirectorySegmentsSync(canonicalWorkspaceRoot, parentSegments, label, globBudget);
    if (!segmentHasGlob(leafSegment)) {
      for (const parentDir of parentDirs) {
        globBudget.expandedPaths += 1;
        if (globBudget.expandedPaths > MAX_GLOB_EXPANDED_PATHS) {
          policyInvalid(`sandbox glob expansion exceeded ${MAX_GLOB_EXPANDED_PATHS} expanded paths`, label);
        }
        const target = canonicalizeAbsolutePath(join(parentDir, leafSegment), label);
        registerGrant(target, entry, label, true);
      }
    } else {
      const leafMatcher = segmentGlobToRegExp(leafSegment);
      const leafRegex = segmentGlobToSeatbeltRegex(leafSegment);
      for (const parentDir of parentDirs) {
        globBudget.visitedDirs += 1;
        if (globBudget.visitedDirs > MAX_GLOB_VISITED_DIRS) {
          policyInvalid(`sandbox glob expansion exceeded ${MAX_GLOB_VISITED_DIRS} visited directories`, label);
        }
        assertCanonicalGrantAllowed(parentDir, label, false);
        seatbeltExactRegexSet.add(`^${escapeSeatbeltRegexLiteral(parentDir)}/${leafRegex}$`);
        let names: string[];
        try {
          names = readdirSync(parentDir, { encoding: 'utf8' }).sort();
        } catch {
          names = [];
        }
        for (const name of names) {
          if (name === '.' || name === '..' || !leafMatcher.test(name)) continue;
          const candidatePath = join(parentDir, name);
          let st: ReturnType<typeof lstatSync> | null;
          try {
            st = lstatSync(candidatePath);
          } catch {
            st = null;
          }
          if (st !== null && !st.isSymbolicLink() && st.isFile() && st.nlink === 1) {
            globBudget.expandedPaths += 1;
            if (globBudget.expandedPaths > MAX_GLOB_EXPANDED_PATHS) {
              policyInvalid(`sandbox glob expansion exceeded ${MAX_GLOB_EXPANDED_PATHS} expanded paths`, label);
            }
            const target = canonicalizeAbsolutePath(candidatePath, label);
            registerGrant(target, entry, label, true);
          }
        }
      }
    }
  }
  if (canonicalScratchDirectory !== null) {
    assertCanonicalGrantAllowed(canonicalScratchDirectory, 'scratchDirectory', true);
    canonicalWritableSet.add(canonicalScratchDirectory);
  }
  const canonicalWritablePaths = Object.freeze([...canonicalWritableSet].sort());
  const canonicalExactWritableFiles: ReadonlySet<string> = exactWritableFilesSet;
  const seatbeltExactFileRegexes = Object.freeze([...seatbeltExactRegexSet].sort());

  const defaultDeniedHomeSet = new Set<string>();
  const deniedSet = new Set<string>();
  if (typeof env.homeDirectory === 'string' && env.homeDirectory.length > 0 && isAbsolute(env.homeDirectory)) {
    const canonicalHome = canonicalizeAbsolutePath(env.homeDirectory, 'homeDirectory');
    for (const subpath of DEFAULT_DENIED_HOME_SUBPATHS) {
      const canonicalDefaultDenied = canonicalizeAbsolutePath(join(canonicalHome, subpath), `homeDirectory/${subpath}`);
      defaultDeniedHomeSet.add(canonicalDefaultDenied);
      deniedSet.add(canonicalDefaultDenied);
    }
  }
  if (policy.deniedReadPaths !== undefined) {
    if (!Array.isArray(policy.deniedReadPaths) || policy.deniedReadPaths.length > 128) {
      policyInvalid('deniedReadPaths must be an array of at most 128 paths', 'deniedReadPaths');
    }
    for (const [index, entry] of policy.deniedReadPaths.entries()) {
      const cleaned = assertCleanPathString(entry, `deniedReadPaths/${index}`);
      if (cleaned.startsWith('~/')) {
        const rel = normalizeRelativeSubpath(cleaned.slice(2), `deniedReadPaths/${index}`);
        const baseHome = isAbsolute(env.homeDirectory) ? canonicalizeAbsolutePath(env.homeDirectory, 'homeDirectory') : canonicalWorkspaceRoot;
        deniedSet.add(canonicalizeAbsolutePath(join(baseHome, rel), `deniedReadPaths/${index}`));
      } else if (isAbsolute(cleaned)) {
        if (cleaned.split('/').some(seg => seg === '..')) {
          policyInvalid(`deniedReadPath "${entry}" must not contain .. traversal`, `deniedReadPaths/${index}`);
        }
        deniedSet.add(canonicalizeAbsolutePath(cleaned, `deniedReadPaths/${index}`));
      } else {
        const rel = normalizeRelativeSubpath(cleaned, `deniedReadPaths/${index}`);
        deniedSet.add(canonicalizeAbsolutePath(join(canonicalWorkspaceRoot, rel), `deniedReadPaths/${index}`));
      }
    }
  }

  const allowedReadOnlySet = new Set<string>();
  if (policy.allowedReadOnlyPaths !== undefined) {
    if (!Array.isArray(policy.allowedReadOnlyPaths) || policy.allowedReadOnlyPaths.length > 64) {
      policyInvalid('allowedReadOnlyPaths must be an array of at most 64 paths', 'allowedReadOnlyPaths');
    }
    for (const [index, entry] of policy.allowedReadOnlyPaths.entries()) {
      const label = `allowedReadOnlyPaths/${index}`;
      const cleaned = assertCleanPathString(entry, label);
      if (!isAbsolute(cleaned) || cleaned.split('/').some(seg => seg === '..')) {
        policyInvalid(`allowedReadOnlyPath "${entry}" must be an absolute path without .. traversal`, label);
      }
      const canonicalAllowed = canonicalizeAbsolutePath(cleaned, label);
      for (const homeDenied of defaultDeniedHomeSet) {
        if (isSameOrSubpath(canonicalAllowed, homeDenied) || isSameOrSubpathCaseInsensitive(canonicalAllowed, homeDenied)) {
          policyInvalid(`allowedReadOnlyPath "${entry}" targets default denied secret path "${homeDenied}"`, label);
        }
      }
      allowedReadOnlySet.add(canonicalAllowed);
    }
  }
  const canonicalAllowedReadOnlyPaths = Object.freeze([...allowedReadOnlySet].sort());

  const readOnlyBindMountList: SandboxReadOnlyBindMount[] = [];
  const seenBindTargets = new Set<string>();
  if (policy.readOnlyBindMounts !== undefined) {
    if (!Array.isArray(policy.readOnlyBindMounts) || policy.readOnlyBindMounts.length > MAX_READ_ONLY_BIND_MOUNTS) {
      policyInvalid(`readOnlyBindMounts must be an array of at most ${MAX_READ_ONLY_BIND_MOUNTS} mounts`, 'readOnlyBindMounts');
    }
    for (const [index, rawMount] of policy.readOnlyBindMounts.entries()) {
      const mountLabel = `readOnlyBindMounts/${index}`;
      if (rawMount === null || typeof rawMount !== 'object' || Array.isArray(rawMount)) {
        policyInvalid('readOnlyBindMount entry must be an object', mountLabel);
      }
      const proto: unknown = Object.getPrototypeOf(rawMount);
      if (proto !== Object.prototype && proto !== null) {
        policyInvalid('readOnlyBindMount entry must be a plain object', mountLabel);
      }
      const sourceLabel = `${mountLabel}/sourcePath`;
      const targetLabel = `${mountLabel}/targetPath`;
      const cleanedSource = assertCleanPathString(rawMount.sourcePath, sourceLabel);
      if (!isAbsolute(cleanedSource) || cleanedSource.split('/').some(seg => seg === '..')) {
        policyInvalid(`readOnlyBindMount sourcePath "${cleanedSource}" must be an absolute path without .. traversal`, sourceLabel);
      }
      const resolvedSource = resolve(cleanedSource);
      let sourceStat: ReturnType<typeof lstatSync> | null;
      try {
        sourceStat = lstatSync(resolvedSource);
      } catch {
        sourceStat = null;
      }
      if (sourceStat === null || sourceStat.isSymbolicLink() || !sourceStat.isDirectory()) {
        policyInvalid(`readOnlyBindMount sourcePath "${cleanedSource}" must be an existing non-symlink directory`, sourceLabel);
      }
      let canonicalSource: string;
      try {
        canonicalSource = realpathSync(resolvedSource);
      } catch {
        policyInvalid(`readOnlyBindMount sourcePath "${cleanedSource}" could not be canonicalized`, sourceLabel);
      }
      if (/[\0\r\n"\\]/.test(canonicalSource)) {
        policyInvalid(`readOnlyBindMount sourcePath "${cleanedSource}" resolved to a path with forbidden characters`, sourceLabel);
      }
      let realSourceStat: ReturnType<typeof lstatSync> | null;
      try {
        realSourceStat = lstatSync(canonicalSource);
      } catch {
        realSourceStat = null;
      }
      if (realSourceStat === null || realSourceStat.isSymbolicLink() || !realSourceStat.isDirectory()) {
        policyInvalid(`readOnlyBindMount sourcePath "${cleanedSource}" must resolve to a directory`, sourceLabel);
      }
      for (const homeDenied of defaultDeniedHomeSet) {
        if (
          isSameOrSubpath(canonicalSource, homeDenied)
          || isSameOrSubpath(homeDenied, canonicalSource)
          || isSameOrSubpathCaseInsensitive(canonicalSource, homeDenied)
          || isSameOrSubpathCaseInsensitive(homeDenied, canonicalSource)
        ) {
          policyInvalid(`readOnlyBindMount sourcePath "${cleanedSource}" overlaps default denied secret path "${homeDenied}"`, sourceLabel);
        }
      }

      const cleanedTarget = assertCleanPathString(rawMount.targetPath, targetLabel);
      if (!isAbsolute(cleanedTarget) || cleanedTarget.split('/').some(seg => seg === '..')) {
        policyInvalid(`readOnlyBindMount targetPath "${cleanedTarget}" must be an absolute path without .. traversal`, targetLabel);
      }
      const canonicalTarget = canonicalizeAbsolutePath(cleanedTarget, targetLabel);
      if (!isSameOrSubpath(canonicalTarget, canonicalWorkspaceRoot) || canonicalTarget === canonicalWorkspaceRoot) {
        policyInvalid(`readOnlyBindMount targetPath "${cleanedTarget}" must be strictly inside workspaceRoot`, targetLabel);
      }
      if (existsSync(canonicalWorkspaceRoot)) {
        const relSegments = canonicalTarget.slice(canonicalWorkspaceRoot.length + 1).split(sep).filter(Boolean);
        let cursor = canonicalWorkspaceRoot;
        for (const seg of relSegments) {
          cursor = join(cursor, seg);
          let segStat: ReturnType<typeof lstatSync> | null;
          try {
            segStat = lstatSync(cursor);
          } catch {
            segStat = null;
          }
          if (segStat === null) break;
          if (segStat.isSymbolicLink()) {
            policyInvalid(`readOnlyBindMount targetPath "${cleanedTarget}" must not traverse or target symbolic links`, targetLabel);
          }
        }
      }
      if (seenBindTargets.has(canonicalTarget)) {
        policyInvalid(`duplicate readOnlyBindMount targetPath "${canonicalTarget}"`, targetLabel);
      }
      seenBindTargets.add(canonicalTarget);
      readOnlyBindMountList.push(Object.freeze({ sourcePath: canonicalSource, targetPath: canonicalTarget }));
    }
  }
  readOnlyBindMountList.sort((a, b) => (a.targetPath < b.targetPath ? -1 : a.targetPath > b.targetPath ? 1 : 0));
  const canonicalReadOnlyBindMounts = Object.freeze(readOnlyBindMountList);

  const filteredDenied = [...deniedSet].filter(deniedPath => {
    if (isSameOrSubpath(canonicalWorkspaceRoot, deniedPath) && deniedPath !== canonicalWorkspaceRoot) {
      return false;
    }
    if (deniedPath === canonicalWorkspaceRoot) {
      policyInvalid('deniedReadPaths must not deny workspaceRoot itself', 'deniedReadPaths');
    }
    if (canonicalScratchDirectory !== null && isSameOrSubpath(canonicalScratchDirectory, deniedPath)) {
      return false;
    }
    return true;
  }).sort();

  for (const wp of canonicalWritablePaths) {
    for (const dp of filteredDenied) {
      if (isSameOrSubpath(wp, dp)) {
        policyInvalid(`writablePath "${wp}" conflicts with deniedReadPath "${dp}"`, 'writablePaths');
      }
    }
  }

  return {
    canonicalWorkspaceRoot,
    canonicalScratchDirectory,
    canonicalWritablePaths,
    canonicalExactWritableFiles,
    seatbeltExactFileRegexes,
    seatbeltProtectedGlobRegexes: Object.freeze([...seatbeltProtectedGlobRegexSet].sort()),
    protectedGlobPrefixes: Object.freeze(protectedGlobPrefixesList),
    canonicalProtectedPaths,
    canonicalDeniedReadPaths: Object.freeze(filteredDenied),
    canonicalAllowedReadOnlyPaths,
    canonicalReadOnlyBindMounts,
    networkMode,
  };
}

function isExecutableFile(candidate: string): boolean {
  try {
    const real = realpathSync(candidate);
    const stats = statSync(real);
    return stats.isFile() && (stats.mode & 0o111) !== 0;
  } catch {
    return false;
  }
}

function validateExecutableChoice(
  configured: string | undefined,
  trustedAllowlist: readonly string[],
  probeExecutables: boolean,
): string | null {
  if (configured !== undefined) {
    if (!trustedAllowlist.includes(configured)) {
      return null;
    }
    if (probeExecutables && !isExecutableFile(configured)) {
      return null;
    }
    return configured;
  }
  if (!probeExecutables) {
    return trustedAllowlist[0] ?? null;
  }
  for (const candidate of trustedAllowlist) {
    if (isExecutableFile(candidate)) return candidate;
  }
  return null;
}

/**
 * Compile a canonical, deterministic macOS Seatbelt (`sandbox-exec`) SBPL profile.
 * Last-match-wins precedence ensures protected paths inside writable directories stay read-only.
 */
export function compileMacosSeatbeltProfile(
  policy: SandboxPolicyInput,
  host?: SandboxHostEnvironment,
): CompiledMacosSeatbeltProfile {
  const env = resolveHostEnvironment(host);
  const executablePath = env.seatbeltExecutable ?? TRUSTED_SEATBELT_PATHS[0]!;
  if (!TRUSTED_SEATBELT_PATHS.includes(executablePath)) {
    throw new TaskpackError('SANDBOX_BACKEND_UNAVAILABLE', `untrusted macOS seatbelt executable "${executablePath}"`, 'seatbeltExecutable');
  }
  const normalized = normalizeSandboxPolicy(policy, env);
  const lines: string[] = [
    '(version 1)',
    '(allow default)',
  ];

  if (normalized.canonicalDeniedReadPaths.length > 0) {
    lines.push('(deny file-read*');
    for (const deniedPath of normalized.canonicalDeniedReadPaths) {
      lines.push(`  (subpath "${deniedPath}")`);
    }
    lines.push(')');
  }

  if (normalized.canonicalAllowedReadOnlyPaths.length > 0) {
    lines.push('(allow file-read*');
    for (const roPath of normalized.canonicalAllowedReadOnlyPaths) {
      lines.push(`  (subpath "${roPath}")`);
    }
    lines.push(')');
  }

  lines.push('(deny file-write*)');
  lines.push('(allow file-write*');
  lines.push('  (literal "/dev/null")');
  lines.push('  (literal "/dev/zero")');
  lines.push('  (literal "/dev/dtracehelper")');
  for (const writablePath of normalized.canonicalWritablePaths) {
    if (normalized.canonicalExactWritableFiles.has(writablePath)) {
      lines.push(`  (require-all (literal "${writablePath}") (vnode-type REGULAR-FILE))`);
    } else {
      lines.push(`  (subpath "${writablePath}")`);
    }
  }
  for (const regexRule of normalized.seatbeltExactFileRegexes) {
    lines.push(`  (require-all (regex #"${regexRule}") (vnode-type REGULAR-FILE))`);
  }
  lines.push(')');

  if (normalized.canonicalProtectedPaths.length > 0 || normalized.seatbeltProtectedGlobRegexes.length > 0) {
    lines.push('(deny file-write*');
    for (const protectedPath of normalized.canonicalProtectedPaths) {
      lines.push(`  (subpath "${protectedPath}")`);
    }
    for (const rx of normalized.seatbeltProtectedGlobRegexes) {
      lines.push(`  (regex #"${rx}")`);
    }
    lines.push(')');
  }

  if (normalized.networkMode === 'none') {
    lines.push('(deny network*)');
  } else if (normalized.networkMode === 'loopback-only') {
    lines.push('(deny network*)');
    lines.push('(allow network-outbound (remote ip "localhost:*"))');
    lines.push('(allow network-inbound (local ip "localhost:*"))');
    lines.push('(allow network-bind (local ip "localhost:*"))');
  }

  const profileText = `${lines.join('\n')}\n`;
  const profileDigest = sha256Digest('loopwright.dev/sandbox-seatbelt/v1', profileText);

  return Object.freeze({
    backendId: 'macos-seatbelt' as const,
    executablePath,
    profileText,
    profileDigest,
    canonicalWorkspaceRoot: normalized.canonicalWorkspaceRoot,
    canonicalWritablePaths: normalized.canonicalWritablePaths,
    canonicalProtectedPaths: normalized.canonicalProtectedPaths,
    canonicalDeniedReadPaths: normalized.canonicalDeniedReadPaths,
    networkMode: normalized.networkMode,
  });
}

const SECCOMP_BLOCKED_SYSCALL_NRS_X64: readonly number[] = Object.freeze([
  101, 246, 320, 165, 166, 155, 321, 298, 323, 250, 248, 249, 425, 426, 427,
]);

const SECCOMP_BLOCKED_SYSCALL_NRS_ARM64: readonly number[] = Object.freeze([
  117, 104, 294, 40, 39, 41, 280, 241, 282, 219, 217, 218, 425, 426, 427,
]);

export interface SeccompFilterOptions {
  readonly blockIpSockets?: boolean | undefined;
}

/**
 * Compile the deterministic classic BPF `struct sock_filter` binary (`bwrap --seccomp <fd>`)
 * enforcing `SECCOMP_BLOCKED_SYSCALLS` (and optional non-`AF_UNIX` `SYS_socket` blocking)
 * on `x64` (`AUDIT_ARCH_X86_64`) and `arm64` (`AUDIT_ARCH_AARCH64`).
 */
export function compileLinuxSeccompBpfBinary(arch: string, options?: SeccompFilterOptions): Buffer {
  let auditArch: number;
  let blockedNrs: readonly number[];
  let sysSocketNr: number;
  let blockX32Abi: boolean;
  if (arch === 'x64') {
    auditArch = 0xc000003e;
    blockedNrs = SECCOMP_BLOCKED_SYSCALL_NRS_X64;
    sysSocketNr = 41;
    blockX32Abi = true;
  } else if (arch === 'arm64') {
    auditArch = 0xc00000b7;
    blockedNrs = SECCOMP_BLOCKED_SYSCALL_NRS_ARM64;
    sysSocketNr = 198;
    blockX32Abi = false;
  } else {
    throw new TaskpackError(
      'SANDBOX_CAPABILITY_INSUFFICIENT',
      `unsupported Linux seccomp architecture "${arch}"`,
      'arch',
    );
  }

  const blockIpSockets = options?.blockIpSockets === true;
  const extraSocketInsns = blockIpSockets ? 3 : 0;

  const instructions: readonly (readonly [number, number, number, number])[] = [
    // 1. Load seccomp_data.arch (offset 4)
    [0x20, 0, 0, 4],
    // 2. If arch == auditArch, skip unexpected-arch deny
    [0x15, 1, 0, auditArch],
    // 3. Deny unexpected architecture with SECCOMP_RET_ERRNO | EPERM (1)
    [0x06, 0, 0, 0x00050001],
    // 4. Load seccomp_data.nr (offset 0)
    [0x20, 0, 0, 0],
    // On x64, also deny x32 ABI syscalls (nr >= 0x40000000), jumping straight to final SECCOMP_RET_ERRNO | 1
    ...(blockX32Abi ? ([[0x35, blockedNrs.length + extraSocketInsns + 1, 0, 0x40000000]] as const) : []),
    // 5. Jump straight past remaining JEQs + optional socket check + RET_ALLOW to final SECCOMP_RET_ERRNO | 1
    ...blockedNrs.map((nr, i): readonly [number, number, number, number] => [
      0x15,
      blockedNrs.length - i + extraSocketInsns,
      0,
      nr,
    ]),
    // 6. When blockIpSockets is enabled, inspect SYS_socket domain (args[0] low 32 bits at offset 16) and allow only AF_UNIX (1)
    ...(blockIpSockets
      ? ([
        [0x15, 0, 2, sysSocketNr],
        [0x20, 0, 0, 16],
        [0x15, 0, 1, 1],
      ] as const)
      : []),
    // 7. Default allow: SECCOMP_RET_ALLOW
    [0x06, 0, 0, 0x7fff0000],
    // 8. Deny matched syscall: SECCOMP_RET_ERRNO | EPERM (1)
    [0x06, 0, 0, 0x00050001],
  ];

  const buf = Buffer.alloc(instructions.length * 8);
  for (let idx = 0; idx < instructions.length; idx += 1) {
    const [code, jt, jf, k] = instructions[idx]!;
    const offset = idx * 8;
    buf.writeUInt16LE(code, offset);
    buf.writeUInt8(jt, offset + 2);
    buf.writeUInt8(jf, offset + 3);
    buf.writeUInt32LE(k >>> 0, offset + 4);
  }
  return buf;
}

/**
 * Compute the canonical Linux seccomp BPF syscall filter profile for sandboxed tool execution.
 */
export function computeSandboxSeccompProfile(options?: SeccompFilterOptions): { readonly json: string; readonly digest: Digest } {
  const document = {
    defaultAction: 'SCMP_ACT_ALLOW',
    syscalls: [
      {
        names: [...SECCOMP_BLOCKED_SYSCALLS],
        action: 'SCMP_ACT_ERRNO',
        errnoRet: 1,
      },
      ...(options?.blockIpSockets === true
        ? [
          {
            names: ['socket'],
            action: 'SCMP_ACT_ERRNO',
            errnoRet: 1,
            args: [{ index: 0, value: 1, op: 'SCMP_CMP_NE' }],
          },
        ]
        : []),
    ],
  };
  const json = JSON.stringify(document);
  const digest = sha256Digest('loopwright.dev/sandbox-seccomp/v1', json);
  return Object.freeze({ json, digest });
}

/**
 * Compile deterministic Linux Bubblewrap (`bwrap`) command-line arguments and seccomp descriptor.
 */
export function compileLinuxBwrapCommand(
  policy: SandboxPolicyInput,
  host?: SandboxHostEnvironment,
  options?: {
    readonly cwd?: string | undefined;
    readonly env?: Readonly<Record<string, string>> | undefined;
    readonly provisionExactFiles?: boolean | undefined;
    readonly inheritSpawnEnv?: boolean | undefined;
  },
): CompiledLinuxBwrapCommand {
  const env = resolveHostEnvironment(host);
  const executablePath = env.bwrapExecutable ?? TRUSTED_BWRAP_PATHS[0]!;
  if (!TRUSTED_BWRAP_PATHS.includes(executablePath)) {
    throw new TaskpackError('SANDBOX_BACKEND_UNAVAILABLE', `untrusted Linux bwrap executable "${executablePath}"`, 'bwrapExecutable');
  }
  const normalized = normalizeSandboxPolicy(policy, env);
  const dynamicGlob = findDynamicProtectedGlobOverlap(normalized);
  if (dynamicGlob !== null) {
    throw new TaskpackError(
      'SANDBOX_CAPABILITY_INSUFFICIENT',
      `linux-bwrap cannot enforce dynamic protected glob "${dynamicGlob}" inside writable directory`,
      'protectedPaths',
    );
  }
  if (options?.provisionExactFiles ?? env.probeExecutables) {
    provisionSandboxExactWritablePaths(normalized, { createTargetFile: true });
  }
  const targetCwd = options?.cwd === undefined
    ? normalized.canonicalWorkspaceRoot
    : canonicalizeAbsolutePath(options.cwd, 'cwd');
  const usesDevShm = [
    normalized.canonicalWorkspaceRoot,
    ...(normalized.canonicalScratchDirectory !== null ? [normalized.canonicalScratchDirectory] : []),
    targetCwd,
    ...normalized.canonicalWritablePaths,
    ...normalized.canonicalProtectedPaths,
    ...normalized.canonicalAllowedReadOnlyPaths,
    ...normalized.canonicalDeniedReadPaths,
    ...normalized.canonicalReadOnlyBindMounts.flatMap(m => [m.sourcePath, m.targetPath]),
  ].some(p => isSameOrSubpath(p, '/dev/shm'));
  const shmRoRoots: string[] = [];
  if (isSameOrSubpath(normalized.canonicalWorkspaceRoot, '/dev/shm') && normalized.canonicalWorkspaceRoot !== '/dev/shm') {
    shmRoRoots.push(normalized.canonicalWorkspaceRoot);
  }
  if (
    isSameOrSubpath(targetCwd, '/dev/shm')
    && targetCwd !== '/dev/shm'
    && !shmRoRoots.some(r => isSameOrSubpath(targetCwd, r))
    && !normalized.canonicalWritablePaths.some(w => isSameOrSubpath(targetCwd, w))
  ) {
    shmRoRoots.push(targetCwd);
  }

  const args: string[] = ['--unshare-all'];
  if (normalized.networkMode === 'allow-outbound') {
    args.push('--share-net');
  }
  args.push(
    '--die-with-parent',
    '--new-session',
    '--ro-bind', '/', '/',
    '--proc', '/proc',
    '--dev', '/dev',
  );
  if (usesDevShm) {
    // Isolate /dev/shm with an empty per-sandbox tmpfs instead of exposing host /dev/shm,
    // bind only the required workspace/policy subpaths, and remount /dev/shm read-only below.
    args.push('--tmpfs', '/dev/shm');
  }
  if (normalized.networkMode === 'none' && (!env.probeExecutables || existsSync('/etc/hosts'))) {
    args.push('--ro-bind-try', '/dev/null', '/etc/hosts');
  }

  const appendDeniedMask = (deniedPath: string): void => {
    if (!env.probeExecutables) {
      args.push('--tmpfs', deniedPath, '--remount-ro', deniedPath);
      return;
    }
    let st: ReturnType<typeof lstatSync> | null;
    try {
      st = existsSync(deniedPath) ? statSync(deniedPath) : null;
    } catch {
      st = null;
    }
    if (st === null) {
      return;
    }
    if (st.isDirectory()) {
      args.push('--tmpfs', deniedPath, '--remount-ro', deniedPath);
    } else {
      args.push('--ro-bind', '/dev/null', deniedPath);
    }
  };
  const allLaterMountTargets = [
    ...shmRoRoots,
    ...normalized.canonicalWritablePaths,
    ...normalized.canonicalProtectedPaths,
    ...normalized.canonicalAllowedReadOnlyPaths,
    ...normalized.canonicalReadOnlyBindMounts.map(m => m.targetPath),
  ];
  const postMountDeniedPaths: string[] = [];
  for (const deniedPath of normalized.canonicalDeniedReadPaths) {
    const reopenedByAllowedRo = normalized.canonicalAllowedReadOnlyPaths.some(
      ro => isSameOrSubpath(ro, deniedPath),
    );
    if (!reopenedByAllowedRo && allLaterMountTargets.some(m => isSameOrSubpath(deniedPath, m))) {
      postMountDeniedPaths.push(deniedPath);
      continue;
    }
    appendDeniedMask(deniedPath);
  }
  for (const shmRoot of shmRoRoots) {
    if (!env.probeExecutables || existsSync(shmRoot)) {
      args.push('--ro-bind', shmRoot, shmRoot);
    }
  }
  for (const writablePath of normalized.canonicalWritablePaths) {
    args.push('--bind', writablePath, writablePath);
  }
  for (const protectedPath of normalized.canonicalProtectedPaths) {
    args.push('--ro-bind-try', protectedPath, protectedPath);
  }
  for (const roPath of normalized.canonicalAllowedReadOnlyPaths) {
    args.push('--ro-bind-try', roPath, roPath);
  }
  for (const mount of normalized.canonicalReadOnlyBindMounts) {
    args.push('--ro-bind', mount.sourcePath, mount.targetPath);
  }
  for (const deniedPath of postMountDeniedPaths) {
    appendDeniedMask(deniedPath);
  }
  if (usesDevShm) {
    args.push('--remount-ro', '/dev/shm');
  }

  if (options?.inheritSpawnEnv === true) {
    args.push('--chdir', targetCwd);
    const pinnedEnv: Record<string, string> = {
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_TERMINAL_PROMPT: '0',
      HOME: normalized.canonicalScratchDirectory ?? normalized.canonicalWorkspaceRoot,
      LANG: 'C.UTF-8',
      TERM: 'dumb',
    };
    for (const key of Object.keys(pinnedEnv).sort()) {
      args.push('--setenv', key, pinnedEnv[key]!);
    }
  } else {
    args.push('--chdir', targetCwd, '--clearenv');
    const safeEnv: Record<string, string> = {
      HOME: normalized.canonicalScratchDirectory ?? normalized.canonicalWorkspaceRoot,
      PATH: '/usr/local/bin:/usr/bin:/bin',
      LANG: 'C.UTF-8',
      TERM: 'dumb',
      ...(options?.env ?? {}),
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_TERMINAL_PROMPT: '0',
    };
    for (const key of Object.keys(safeEnv).sort()) {
      if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
        args.push('--setenv', key, safeEnv[key]!);
      }
    }
  }

  if (args.length > MAX_LINUX_BWRAP_ARGS) {
    throw new TaskpackError(
      'SANDBOX_CAPABILITY_INSUFFICIENT',
      `compiled linux-bwrap policy requires ${args.length} arguments, exceeding max ${MAX_LINUX_BWRAP_ARGS}`,
      'writablePaths',
    );
  }

  const effectiveSeccomp = normalized.networkMode === 'none'
    ? computeSandboxSeccompProfile({ blockIpSockets: true })
    : computeSandboxSeccompProfile();
  const profilePayload = JSON.stringify({
    executablePath,
    args,
    seccompDigest: effectiveSeccomp.digest.hex,
    networkMode: normalized.networkMode,
  });
  const profileDigest = sha256Digest('loopwright.dev/sandbox-bwrap/v1', profilePayload);

  return Object.freeze({
    backendId: 'linux-bwrap' as const,
    executablePath,
    args: Object.freeze(args),
    seccompProfileJson: effectiveSeccomp.json,
    seccompDigest: effectiveSeccomp.digest,
    profileDigest,
    canonicalWorkspaceRoot: normalized.canonicalWorkspaceRoot,
    canonicalWritablePaths: normalized.canonicalWritablePaths,
    canonicalProtectedPaths: normalized.canonicalProtectedPaths,
    canonicalDeniedReadPaths: normalized.canonicalDeniedReadPaths,
    canonicalReadOnlyBindMounts: normalized.canonicalReadOnlyBindMounts,
    networkMode: normalized.networkMode,
  });
}

export const LANDLOCK_HOST_PROBE_SCRIPT = [
  'import ctypes, errno, os, socket, sys',
  'libc = ctypes.CDLL(None, use_errno=True)',
  'libc.prctl.restype = ctypes.c_int',
  'abi = libc.syscall(444, None, 0, 1)',
  'if abi < 3:',
  '    sys.exit(1)',
  'seccomp_ok = 0',
  'machine = os.uname().machine',
  'if machine in ("x86_64", "amd64", "aarch64", "arm64") and libc.prctl(38, 1, 0, 0, 0) == 0:',
  '    if machine in ("x86_64", "amd64"):',
  '        audit_arch = 0xc000003e',
  '        blocked_nrs = [90, 91, 92, 93, 94, 260, 268, 425, 426, 427, 452]',
  '        sys_socket = 41',
  '        block_x32 = True',
  '    else:',
  '        audit_arch = 0xc00000b7',
  '        blocked_nrs = [52, 53, 54, 55, 425, 426, 427, 452]',
  '        sys_socket = 198',
  '        block_x32 = False',
  '    class SockFilter(ctypes.Structure):',
  '        _fields_ = [("code", ctypes.c_uint16), ("jt", ctypes.c_uint8), ("jf", ctypes.c_uint8), ("k", ctypes.c_uint32)]',
  '    class SockFprog(ctypes.Structure):',
  '        _fields_ = [("len", ctypes.c_uint16), ("filter", ctypes.POINTER(SockFilter))]',
  '    n_blocked = len(blocked_nrs)',
  '    raw_insns = [',
  '        (0x20, 0, 0, 4), (0x15, 1, 0, audit_arch), (0x06, 0, 0, 0x00050001), (0x20, 0, 0, 0),',
  '    ]',
  '    if block_x32:',
  '        raw_insns.append((0x35, n_blocked + 4, 0, 0x40000000))',
  '    for idx_nr, nr in enumerate(blocked_nrs):',
  '        raw_insns.append((0x15, (n_blocked - idx_nr) + 3, 0, nr))',
  '    raw_insns.extend([',
  '        (0x15, 0, 2, sys_socket), (0x20, 0, 0, 16), (0x15, 0, 1, 1),',
  '        (0x06, 0, 0, 0x7fff0000), (0x06, 0, 0, 0x00050001),',
  '    ])',
  '    insns = (SockFilter * len(raw_insns))(*(SockFilter(*ins) for ins in raw_insns))',
  '    prog = SockFprog(len(raw_insns), insns)',
  '    if libc.prctl(22, 2, ctypes.byref(prog), 0, 0) == 0:',
  '        try:',
  '            us = socket.socket(socket.AF_UNIX, socket.SOCK_DGRAM)',
  '            us.close()',
  '            chmod_blocked = False',
  '            try:',
  '                os.chmod("/", 0o755)',
  '            except OSError as exc:',
  '                chmod_blocked = (exc.errno == errno.EPERM)',
  '            sock_blocked = False',
  '            try:',
  '                s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)',
  '                s.close()',
  '            except OSError as exc:',
  '                sock_blocked = (exc.errno == errno.EPERM)',
  '            ctypes.set_errno(0)',
  '            uring_blocked = (libc.syscall(425, 1, 0) == -1 and ctypes.get_errno() == errno.EPERM)',
  '            if chmod_blocked and sock_blocked and uring_blocked:',
  '                seccomp_ok = 1',
  '        except OSError:',
  '            pass',
  'sys.stdout.write(f"{abi}:{seccomp_ok}")',
].join('\n');

const cachedLandlockProbesByExecutable = new Map<string, { readonly abi: number; readonly seccompAvailable: boolean } | null>();

function probeLinuxLandlockExecutable(executable: string): { readonly abi: number; readonly seccompAvailable: boolean } | null {
  if (cachedLandlockProbesByExecutable.has(executable)) {
    return cachedLandlockProbesByExecutable.get(executable) ?? null;
  }
  const probe = spawnSync(
    executable,
    ['-I', '-S', '-B', '-c', LANDLOCK_HOST_PROBE_SCRIPT],
    { cwd: '/', encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 3_000 },
  );
  if (probe.status === 0 && probe.error === undefined) {
    const parts = (probe.stdout ?? '').trim().split(':');
    const abi = Number.parseInt(parts[0] ?? '', 10);
    const seccompAvailable = parts[1] === '1';
    if (Number.isSafeInteger(abi) && abi >= 3 && seccompAvailable) {
      const info = Object.freeze({ abi, seccompAvailable });
      cachedLandlockProbesByExecutable.set(executable, info);
      return info;
    }
  }
  cachedLandlockProbesByExecutable.set(executable, null);
  return null;
}

function defaultPreferredBackends(platform: string): readonly SandboxBackendId[] {
  if (platform === 'darwin') return ['macos-seatbelt', 'docker'];
  if (platform === 'linux') return ['linux-bwrap', 'linux-landlock', 'docker'];
  return [];
}

/**
 * Fail-closed sandbox backend negotiation. Never silently downgrades to unsandboxed execution.
 */
export function negotiateSandboxBackend(
  policy: SandboxPolicyInput,
  host?: SandboxHostEnvironment,
): NegotiatedSandboxBackend {
  const env = resolveHostEnvironment(host);
  const normalized = normalizeSandboxPolicy(policy, env);
  const requiredCapabilities: readonly SandboxCapability[] = policy.requiredCapabilities !== undefined
    ? policy.requiredCapabilities
    : DEFAULT_REQUIRED_SANDBOX_CAPABILITIES;

  for (const cap of requiredCapabilities) {
    if (
      cap !== 'filesystemReadContainment' &&
      cap !== 'filesystemWriteContainment' &&
      cap !== 'protectedPathReadOnlyMask' &&
      cap !== 'networkIsolation' &&
      cap !== 'processTreeCleanup' &&
      cap !== 'syscallFiltering'
    ) {
      policyInvalid(`unknown required capability "${String(cap)}"`, 'requiredCapabilities');
    }
  }

  const preferredBackends: readonly SandboxBackendId[] = policy.preferredBackends !== undefined
    ? policy.preferredBackends
    : defaultPreferredBackends(env.platform);

  if (!Array.isArray(preferredBackends) || preferredBackends.length === 0) {
    throw new TaskpackError(
      'SANDBOX_BACKEND_UNAVAILABLE',
      `no sandbox backends are available for platform "${env.platform}"`,
      'preferredBackends',
    );
  }

  let capabilityFailure: string | null = null;
  let availabilityFailure: string | null = null;

  for (const backendId of preferredBackends) {
    if (!Object.hasOwn(SANDBOX_CAPABILITIES_BY_BACKEND, backendId)) {
      policyInvalid(`unknown sandbox backend "${String(backendId)}"`, 'preferredBackends');
    }

    if (backendId === 'macos-seatbelt') {
      if (env.platform !== 'darwin') {
        availabilityFailure ??= 'macos-seatbelt requires platform darwin';
        continue;
      }
      const executable = validateExecutableChoice(env.seatbeltExecutable, TRUSTED_SEATBELT_PATHS, env.probeExecutables);
      if (executable === null) {
        availabilityFailure ??= `macos-seatbelt binary is missing or untrusted (${env.seatbeltExecutable ?? TRUSTED_SEATBELT_PATHS[0]})`;
        continue;
      }
      const supported = SANDBOX_CAPABILITIES_BY_BACKEND['macos-seatbelt'];
      const missing = requiredCapabilities.filter(req => !supported.includes(req));
      if (missing.length > 0) {
        capabilityFailure ??= `macos-seatbelt lacks required capabilities: ${missing.join(', ')}`;
        continue;
      }
      const compiled = compileMacosSeatbeltProfile(policy, { ...env, seatbeltExecutable: executable });
      return Object.freeze({
        backendId: 'macos-seatbelt',
        executablePath: executable,
        capabilities: supported,
        networkMode: normalized.networkMode,
        profileDigest: compiled.profileDigest,
      });
    }

    if (backendId === 'linux-bwrap') {
      if (env.platform !== 'linux') {
        availabilityFailure ??= 'linux-bwrap requires platform linux';
        continue;
      }
      if (env.arch !== 'x64' && env.arch !== 'arm64') {
        if (requiredCapabilities.includes('syscallFiltering')) {
          capabilityFailure ??= `linux-bwrap syscallFiltering is unsupported on architecture "${env.arch}"`;
        } else {
          availabilityFailure ??= `linux-bwrap seccomp filter compiler does not support architecture "${env.arch}"`;
        }
        continue;
      }
      const executable = validateExecutableChoice(env.bwrapExecutable, TRUSTED_BWRAP_PATHS, env.probeExecutables);
      if (executable === null) {
        availabilityFailure ??= `linux-bwrap binary is missing or untrusted (${env.bwrapExecutable ?? TRUSTED_BWRAP_PATHS[0]})`;
        continue;
      }
      if (env.probeExecutables && process.platform === 'linux') {
        const probe = spawnSync(executable, ['--unshare-all', '--ro-bind', '/', '/', '/bin/true'], {
          timeout: 2000,
          stdio: 'ignore',
        });
        if (probe.status !== 0) {
          availabilityFailure ??= 'linux-bwrap runtime namespace creation is blocked on this host';
          continue;
        }
      }
      const supported = SANDBOX_CAPABILITIES_BY_BACKEND['linux-bwrap'];
      const missing = requiredCapabilities.filter(req => !supported.includes(req));
      if (missing.length > 0) {
        capabilityFailure ??= `linux-bwrap lacks required capabilities: ${missing.join(', ')}`;
        continue;
      }
      if (requiredCapabilities.includes('protectedPathReadOnlyMask') || (policy.protectedPaths?.length ?? 0) > 0) {
        const dynamicGlob = findDynamicProtectedGlobOverlap(normalized);
        if (dynamicGlob !== null) {
          capabilityFailure ??= `linux-bwrap cannot enforce dynamic protected glob "${dynamicGlob}" inside writable directory`;
          continue;
        }
      }
      let compiled: CompiledLinuxBwrapCommand;
      try {
        compiled = compileLinuxBwrapCommand(
          policy,
          { ...env, bwrapExecutable: executable },
          { provisionExactFiles: false },
        );
      } catch (err) {
        if (err instanceof TaskpackError && err.code === 'SANDBOX_CAPABILITY_INSUFFICIENT') {
          capabilityFailure ??= err.message;
          continue;
        }
        throw err;
      }
      return Object.freeze({
        backendId: 'linux-bwrap',
        executablePath: executable,
        capabilities: supported,
        networkMode: normalized.networkMode,
        profileDigest: compiled.profileDigest,
      });
    }

    if (backendId === 'linux-landlock') {
      if (env.platform !== 'linux') {
        availabilityFailure ??= 'linux-landlock requires platform linux';
        continue;
      }
      if (env.arch !== 'x64' && env.arch !== 'arm64') {
        availabilityFailure ??= `linux-landlock seccomp filter does not support architecture "${env.arch}"`;
        continue;
      }
      const supported = SANDBOX_CAPABILITIES_BY_BACKEND['linux-landlock'];
      const missing = requiredCapabilities.filter(req => !supported.includes(req));
      if (missing.length > 0) {
        capabilityFailure ??= `linux-landlock lacks required capabilities: ${missing.join(', ')}`;
        continue;
      }
      if (
        normalized.networkMode === 'loopback-only'
        && (requiredCapabilities.includes('networkIsolation') || policy.networkMode === 'loopback-only')
      ) {
        capabilityFailure ??= 'linux-landlock cannot enforce loopback-only network isolation without network namespaces';
        continue;
      }
      if (
        requiredCapabilities.includes('protectedPathReadOnlyMask')
        || requiredCapabilities.includes('filesystemReadContainment')
        || (policy.protectedPaths?.length ?? 0) > 0
        || (policy.deniedReadPaths?.length ?? 0) > 0
      ) {
        const overlap = findLandlockWritableOverlap(normalized);
        if (overlap !== null) {
          capabilityFailure ??= `linux-landlock cannot enforce nested exclusion inside writable directory (${overlap})`;
          continue;
        }
      }
      const executable = validateExecutableChoice(env.pythonExecutable, TRUSTED_PYTHON_PATHS, env.probeExecutables);
      if (executable === null) {
        availabilityFailure ??= `linux-landlock helper binary is missing or untrusted (${env.pythonExecutable ?? TRUSTED_PYTHON_PATHS[0]})`;
        continue;
      }
      if (env.probeExecutables && process.platform === 'linux') {
        const probed = probeLinuxLandlockExecutable(executable);
        if (probed === null || probed.abi < 3 || !probed.seccompAvailable) {
          availabilityFailure ??= 'linux-landlock requires Linux kernel Landlock ABI >= 3 and seccomp filter support';
          continue;
        }
      }
      const profileDigest = sha256Digest(
        'loopwright.dev/sandbox-landlock/v1',
        JSON.stringify({
          executable,
          workspaceRoot: normalized.canonicalWorkspaceRoot,
          writablePaths: normalized.canonicalWritablePaths,
          protectedPaths: normalized.canonicalProtectedPaths,
          deniedReadPaths: normalized.canonicalDeniedReadPaths,
          ...(normalized.canonicalAllowedReadOnlyPaths.length > 0
            ? { allowedReadOnlyPaths: normalized.canonicalAllowedReadOnlyPaths }
            : {}),
          networkMode: normalized.networkMode,
        }),
      );
      return Object.freeze({
        backendId: 'linux-landlock',
        executablePath: executable,
        capabilities: supported,
        networkMode: normalized.networkMode,
        profileDigest,
      });
    }

    if (backendId === 'docker') {
      const executable = validateExecutableChoice(env.dockerExecutable, TRUSTED_DOCKER_PATHS, env.probeExecutables);
      const socketPath = env.dockerSocket ?? '/var/run/docker.sock';
      const socketAvailable = !env.probeExecutables || existsSync(socketPath);
      if (executable === null || !socketAvailable) {
        availabilityFailure ??= 'docker executable or socket is unavailable on this host';
        continue;
      }
      const supported = SANDBOX_CAPABILITIES_BY_BACKEND['docker'];
      const missing = requiredCapabilities.filter(req => !supported.includes(req));
      if (missing.length > 0) {
        capabilityFailure ??= `docker lacks required capabilities: ${missing.join(', ')}`;
        continue;
      }
      const profileDigest = sha256Digest(
        'loopwright.dev/sandbox-docker/v1',
        JSON.stringify({
          executable,
          socketPath,
          workspaceRoot: normalized.canonicalWorkspaceRoot,
          writablePaths: normalized.canonicalWritablePaths,
          protectedPaths: normalized.canonicalProtectedPaths,
          ...(normalized.canonicalReadOnlyBindMounts.length > 0
            ? { readOnlyBindMounts: normalized.canonicalReadOnlyBindMounts }
            : {}),
          networkMode: normalized.networkMode,
        }),
      );
      return Object.freeze({
        backendId: 'docker',
        executablePath: executable,
        capabilities: supported,
        networkMode: normalized.networkMode,
        profileDigest,
      });
    }

    if (backendId === 'direct-dedicated') {
      const supported = SANDBOX_CAPABILITIES_BY_BACKEND['direct-dedicated'];
      const missing = requiredCapabilities.filter(req => !supported.includes(req));
      if (missing.length > 0 && policy.allowDedicatedDirectOverride !== true) {
        capabilityFailure ??= `direct-dedicated backend lacks required isolation capabilities (${missing.join(', ')}) and allowDedicatedDirectOverride is not enabled`;
        continue;
      }
      const profileDigest = sha256Digest(
        'loopwright.dev/sandbox-direct/v1',
        JSON.stringify({ workspaceRoot: normalized.canonicalWorkspaceRoot, networkMode: normalized.networkMode }),
      );
      return Object.freeze({
        backendId: 'direct-dedicated',
        executablePath: null,
        capabilities: supported,
        networkMode: normalized.networkMode,
        profileDigest,
      });
    }
  }

  if (capabilityFailure !== null) {
    throw new TaskpackError('SANDBOX_CAPABILITY_INSUFFICIENT', capabilityFailure, 'requiredCapabilities');
  }
  throw new TaskpackError(
    'SANDBOX_BACKEND_UNAVAILABLE',
    availabilityFailure ?? `no compatible sandbox backend available for platform "${env.platform}"`,
    'preferredBackends',
  );
}

export const LANDLOCK_BOOTSTRAP_SCRIPT = `import ctypes, errno, json, os, signal, stat, sys

libc = ctypes.CDLL(None, use_errno=True)
libc.prctl.restype = ctypes.c_int
PR_SET_PDEATHSIG = 1
PR_SET_SECCOMP = 22
PR_SET_NO_NEW_PRIVS = 38
SECCOMP_MODE_FILTER = 2
SYS_landlock_create_ruleset = 444
SYS_landlock_add_rule = 445
SYS_landlock_restrict_self = 446
LANDLOCK_CREATE_RULESET_VERSION = 1 << 0
LANDLOCK_RULE_PATH_BENEATH = 1

class RulesetAttr(ctypes.Structure):
    _fields_ = [("handled_access_fs", ctypes.c_uint64), ("handled_access_net", ctypes.c_uint64)]

class PathBeneathAttr(ctypes.Structure):
    _pack_ = 1
    _fields_ = [("allowed_access", ctypes.c_uint64), ("parent_fd", ctypes.c_int32)]

class SockFilter(ctypes.Structure):
    _fields_ = [
        ("code", ctypes.c_uint16),
        ("jt", ctypes.c_uint8),
        ("jf", ctypes.c_uint8),
        ("k", ctypes.c_uint32),
    ]

class SockFprog(ctypes.Structure):
    _fields_ = [
        ("len", ctypes.c_uint16),
        ("filter", ctypes.POINTER(SockFilter)),
    ]

cfg = json.loads(sys.argv[1])
cmd = sys.argv[2]
args = sys.argv[3:]

libc.prctl(PR_SET_PDEATHSIG, signal.SIGKILL, 0, 0, 0)
if libc.prctl(PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0) != 0:
    sys.exit(126)

abi = libc.syscall(SYS_landlock_create_ruleset, None, 0, LANDLOCK_CREATE_RULESET_VERSION)
if abi < 3:
    sys.exit(126)

FS_EXECUTE = 1 << 0
FS_WRITE_FILE = 1 << 1
FS_READ_FILE = 1 << 2
FS_READ_DIR = 1 << 3
FS_REMOVE_DIR = 1 << 4
FS_REMOVE_FILE = 1 << 5
FS_MAKE_CHAR = 1 << 6
FS_MAKE_DIR = 1 << 7
FS_MAKE_REG = 1 << 8
FS_MAKE_SOCK = 1 << 9
FS_MAKE_FIFO = 1 << 10
FS_MAKE_BLOCK = 1 << 11
FS_MAKE_SYM = 1 << 12
FS_REFER = 1 << 13 if abi >= 2 else 0
FS_TRUNCATE = 1 << 14 if abi >= 3 else 0

READ_ACCESS = FS_EXECUTE | FS_READ_FILE | FS_READ_DIR
WRITE_FILE_ACCESS = FS_WRITE_FILE | FS_TRUNCATE
WRITE_DIR_ACCESS = (
    FS_WRITE_FILE | FS_REMOVE_DIR | FS_REMOVE_FILE | FS_MAKE_CHAR |
    FS_MAKE_DIR | FS_MAKE_REG | FS_MAKE_SOCK | FS_MAKE_FIFO |
    FS_MAKE_BLOCK | FS_MAKE_SYM | FS_REFER | FS_TRUNCATE
)
HANDLED_FS = READ_ACCESS | WRITE_DIR_ACCESS
HANDLED_NET = ((1 << 0) | (1 << 1)) if (abi >= 4 and cfg.get("networkMode") == "none") else 0

attr = RulesetAttr(HANDLED_FS, HANDLED_NET)
ruleset_fd = libc.syscall(SYS_landlock_create_ruleset, ctypes.byref(attr), ctypes.sizeof(attr), 0)
if ruleset_fd < 0:
    sys.exit(126)

O_PATH = getattr(os, "O_PATH", 0o10000000)
O_NOFOLLOW = getattr(os, "O_NOFOLLOW", 0o400000)
O_DIRECTORY = getattr(os, "O_DIRECTORY", 0o200000)

def open_nofollow_abs(abs_path, leaf_flags, fail_on_symlink_ancestor=False):
    if not isinstance(abs_path, str) or not abs_path.startswith("/"):
        if fail_on_symlink_ancestor:
            sys.exit(126)
        raise OSError(errno.EINVAL, "invalid path")
    if abs_path == "/":
        return os.open("/", leaf_flags | O_NOFOLLOW | os.O_CLOEXEC)
    parts = [p for p in abs_path.split("/") if p]
    cur_fd = os.open("/", os.O_RDONLY | O_NOFOLLOW | O_DIRECTORY | os.O_CLOEXEC)
    try:
        for part in parts[:-1]:
            try:
                nxt_fd = os.open(part, os.O_RDONLY | O_NOFOLLOW | O_DIRECTORY | os.O_CLOEXEC, dir_fd=cur_fd)
            except OSError as exc:
                if fail_on_symlink_ancestor and exc.errno != errno.ENOENT:
                    sys.exit(126)
                raise
            os.close(cur_fd)
            cur_fd = nxt_fd
        try:
            return os.open(parts[-1], leaf_flags | O_NOFOLLOW | os.O_CLOEXEC, dir_fd=cur_fd)
        except OSError as exc:
            if fail_on_symlink_ancestor and exc.errno != errno.ENOENT:
                sys.exit(126)
            raise
    finally:
        os.close(cur_fd)

def add_fd_rule(fd, is_dir, access):
    actual = access if is_dir else (access & (FS_EXECUTE | FS_READ_FILE | WRITE_FILE_ACCESS))
    if actual == 0:
        return True
    rule = PathBeneathAttr(actual, fd)
    return libc.syscall(SYS_landlock_add_rule, ruleset_fd, LANDLOCK_RULE_PATH_BENEATH, ctypes.byref(rule), 0) == 0

def add_path_rule(path, access, dir_fd=None):
    try:
        if dir_fd is not None:
            fd = os.open(path, O_PATH | O_NOFOLLOW | os.O_CLOEXEC, dir_fd=dir_fd)
        else:
            fd = open_nofollow_abs(path, O_PATH, False)
    except OSError:
        return
    try:
        st = os.fstat(fd)
        if stat.S_ISLNK(st.st_mode):
            return
        add_fd_rule(fd, stat.S_ISDIR(st.st_mode), access)
    finally:
        os.close(fd)

def is_same_or_child(candidate, parent):
    if parent == "/":
        return True
    return candidate == parent or candidate.startswith(parent + "/")

def grant_tree(current, excluded_set, access, parent_dir_fd=None, rel_name=None):
    if current in excluded_set:
        return
    target = rel_name if parent_dir_fd is not None else current
    needs_split = any(ex != current and is_same_or_child(ex, current) for ex in excluded_set)
    if not needs_split:
        add_path_rule(target, access, dir_fd=parent_dir_fd)
        return
    try:
        if parent_dir_fd is not None:
            dir_fd = os.open(target, os.O_RDONLY | O_NOFOLLOW | O_DIRECTORY | os.O_CLOEXEC, dir_fd=parent_dir_fd)
        else:
            dir_fd = open_nofollow_abs(current, os.O_RDONLY | O_DIRECTORY, False)
    except OSError as exc:
        if exc.errno == errno.ENOTDIR:
            add_path_rule(target, access, dir_fd=parent_dir_fd)
        return
    try:
        st = os.fstat(dir_fd)
        if not stat.S_ISDIR(st.st_mode):
            return
        entries = sorted(os.listdir(dir_fd))
        for name in entries:
            if name in (".", ".."):
                continue
            child = "/" + name if current == "/" else current + "/" + name
            grant_tree(child, excluded_set, access, parent_dir_fd=dir_fd, rel_name=name)
    finally:
        os.close(dir_fd)

raw_denied_reads = set(cfg.get("deniedReadPaths", []))
denied_reads = {p for p in raw_denied_reads if os.path.lexists(p)}
protected_writes = set(cfg.get("protectedPaths", [])) | raw_denied_reads
writable_paths = cfg.get("writablePaths", [])
exact_writable_files = set(cfg.get("exactWritableFiles", []))
positive_read_roots = cfg.get("positiveReadRoots")
allowed_ro_paths = cfg.get("allowedReadOnlyPaths", [])

if isinstance(positive_read_roots, list):
    ro_excluded = denied_reads - set(allowed_ro_paths)
    for root_path in positive_read_roots:
        grant_tree(root_path, ro_excluded, READ_ACCESS)
    for ro_path in allowed_ro_paths:
        grant_tree(ro_path, ro_excluded, READ_ACCESS)
else:
    grant_tree("/", denied_reads, READ_ACCESS)
    for ro_path in allowed_ro_paths:
        add_path_rule(ro_path, READ_ACCESS)
for dev in ("/dev/null", "/dev/zero"):
    add_path_rule(dev, READ_ACCESS | WRITE_FILE_ACCESS)
for wp in writable_paths:
    if any(is_same_or_child(ex, wp) for ex in protected_writes):
        sys.exit(126)
    if wp in exact_writable_files:
        try:
            wp_fd = open_nofollow_abs(wp, O_PATH, True)
        except OSError:
            sys.exit(126)
        try:
            wp_st = os.fstat(wp_fd)
            if stat.S_ISLNK(wp_st.st_mode) or not stat.S_ISREG(wp_st.st_mode) or wp_st.st_nlink != 1:
                sys.exit(126)
            if not add_fd_rule(wp_fd, False, READ_ACCESS | WRITE_FILE_ACCESS):
                sys.exit(126)
        finally:
            os.close(wp_fd)
    else:
        try:
            wp_fd = open_nofollow_abs(wp, O_PATH, True)
        except OSError as exc:
            if exc.errno == errno.ENOENT:
                continue
            sys.exit(126)
        try:
            wp_st = os.fstat(wp_fd)
            if stat.S_ISLNK(wp_st.st_mode):
                sys.exit(126)
            if stat.S_ISDIR(wp_st.st_mode):
                if not add_fd_rule(wp_fd, True, READ_ACCESS | WRITE_DIR_ACCESS):
                    sys.exit(126)
            elif stat.S_ISREG(wp_st.st_mode) and wp_st.st_nlink == 1:
                if not add_fd_rule(wp_fd, False, READ_ACCESS | WRITE_FILE_ACCESS):
                    sys.exit(126)
            else:
                sys.exit(126)
        finally:
            os.close(wp_fd)

if libc.syscall(SYS_landlock_restrict_self, ruleset_fd, 0) != 0:
    os.close(ruleset_fd)
    sys.exit(126)
os.close(ruleset_fd)

machine = os.uname().machine
if machine in ("x86_64", "amd64"):
    audit_arch = 0xc000003e
    blocked_nrs = [90, 91, 92, 93, 94, 260, 268, 425, 426, 427, 452]
    all_socket_nrs = [41, 42, 43, 49, 50, 53, 288]
    sys_socket = 41
    block_x32 = True
elif machine in ("aarch64", "arm64"):
    audit_arch = 0xc00000b7
    blocked_nrs = [52, 53, 54, 55, 425, 426, 427, 452]
    all_socket_nrs = [198, 199, 200, 201, 202, 203, 242]
    sys_socket = 198
    block_x32 = False
else:
    sys.exit(126)
block_all_sockets = cfg.get("blockAllSockets") is True
if block_all_sockets:
    blocked_nrs = blocked_nrs + all_socket_nrs
block_ip = (not block_all_sockets) and (cfg.get("blockIpSockets") is True)
extra_sock = 3 if block_ip else 0
n_blocked = len(blocked_nrs)
raw_insns = [
    (0x20, 0, 0, 4),
    (0x15, 1, 0, audit_arch),
    (0x06, 0, 0, 0x00050001),
    (0x20, 0, 0, 0),
]
if block_x32:
    raw_insns.append((0x35, n_blocked + extra_sock + 1, 0, 0x40000000))
for idx_nr, nr in enumerate(blocked_nrs):
    raw_insns.append((0x15, (n_blocked - idx_nr) + extra_sock, 0, nr))
if block_ip:
    raw_insns.extend([
        (0x15, 0, 2, sys_socket),
        (0x20, 0, 0, 16),
        (0x15, 0, 1, 1),
    ])
raw_insns.append((0x06, 0, 0, 0x7fff0000))
raw_insns.append((0x06, 0, 0, 0x00050001))
insns = (SockFilter * len(raw_insns))(*(SockFilter(*ins) for ins in raw_insns))
prog = SockFprog(len(raw_insns), insns)
if libc.prctl(PR_SET_SECCOMP, SECCOMP_MODE_FILTER, ctypes.byref(prog), 0, 0) != 0:
    sys.exit(126)
cwd = cfg.get("cwd")
if cwd:
    os.chdir(cwd)
env = cfg.get("env")
if env is not None:
    os.environ.clear()
    os.environ.update(env)
os.execvp(cmd, [cmd] + args)
`;

export interface ProvisionedAbsentProtectedPlaceholders {
  readonly placeholderPaths: readonly string[];
  cleanup(): void;
}

export function provisionAbsentProtectedPlaceholders(
  normalized: Pick<
    NormalizedSandboxPaths,
    | 'canonicalWorkspaceRoot'
    | 'canonicalWritablePaths'
    | 'canonicalExactWritableFiles'
    | 'canonicalProtectedPaths'
  > & { readonly canonicalDeniedReadPaths?: readonly string[] | undefined },
): ProvisionedAbsentProtectedPlaceholders {
  const createdFiles: { readonly path: string; readonly dev: number; readonly ino: number }[] = [];
  const createdDirs: { readonly path: string; readonly dev: number; readonly ino: number }[] = [];
  const writableDirs = normalized.canonicalWritablePaths.filter(wp => !normalized.canonicalExactWritableFiles.has(wp));

  const cleanupCreated = (): void => {
    for (let i = createdFiles.length - 1; i >= 0; i -= 1) {
      const item = createdFiles[i]!;
      try {
        const st = lstatSync(item.path);
        if (!st.isSymbolicLink() && st.isFile() && st.dev === item.dev && st.ino === item.ino && st.size === 0) {
          unlinkSync(item.path);
        }
      } catch {
        // Ignore if already absent.
      }
    }
    for (let i = createdDirs.length - 1; i >= 0; i -= 1) {
      const item = createdDirs[i]!;
      try {
        const st = lstatSync(item.path);
        if (!st.isSymbolicLink() && st.isDirectory() && st.dev === item.dev && st.ino === item.ino) {
          rmdirSync(item.path);
        }
      } catch {
        // Keep directory if non-empty (e.g., sibling allowed file created inside it).
      }
    }
  };

  try {
    if (writableDirs.length > 0 && existsSync(normalized.canonicalWorkspaceRoot)) {
      const sortedProtected = [...normalized.canonicalProtectedPaths].sort(
        (a, b) => a.length - b.length || (a < b ? -1 : a > b ? 1 : 0),
      );
      const coveredRoots: string[] = [];
      for (const protectedPath of sortedProtected) {
        const coveringWritable = writableDirs
          .filter(wp => protectedPath !== wp && isSameOrSubpath(protectedPath, wp))
          .sort((a, b) => b.length - a.length)[0];
        if (coveringWritable === undefined) continue;
        if (coveredRoots.some(r => isSameOrSubpath(protectedPath, r))) continue;

        let cwStat: ReturnType<typeof lstatSync> | null = null;
        try {
          cwStat = lstatSync(coveringWritable);
        } catch (err) {
          if ((err as NodeJS.ErrnoException | null)?.code === 'ENOENT') {
            continue;
          }
          throw err;
        }
        if (cwStat.isSymbolicLink()) {
          policyInvalid(`writable directory "${coveringWritable}" must not be a symbolic link`, 'writablePaths');
        }

        const rel = protectedPath.slice(coveringWritable === '/' ? 1 : coveringWritable.length + 1);
        const segments = rel.split(sep).filter(Boolean);
        let cursor = coveringWritable;
        let parentsValid = true;
        let parentCreated = false;
        for (let i = 0; i < segments.length - 1; i += 1) {
          cursor = join(cursor, segments[i]!);
          let pStat: ReturnType<typeof lstatSync> | null = null;
          let pMissing = false;
          try {
            pStat = lstatSync(cursor);
          } catch (err) {
            if ((err as NodeJS.ErrnoException | null)?.code === 'ENOENT') {
              pMissing = true;
            } else {
              parentsValid = false;
              break;
            }
          }
          if (pMissing) {
            try {
              mkdirSync(cursor, { mode: 0o755 });
              const createdDirStat = lstatSync(cursor);
              if (createdDirStat.isSymbolicLink()) {
                policyInvalid(
                  `protectedPath "${protectedPath}" traverses symbolic link "${cursor}" inside writable directory`,
                  'protectedPaths',
                );
              }
              if (createdDirStat.isDirectory()) {
                createdDirs.push({ path: cursor, dev: createdDirStat.dev, ino: createdDirStat.ino });
                parentCreated = true;
              } else {
                parentsValid = false;
                break;
              }
            } catch (err) {
              if (err instanceof TaskpackError) throw err;
              parentsValid = false;
              break;
            }
          } else if (pStat !== null && pStat.isSymbolicLink()) {
            policyInvalid(
              `protectedPath "${protectedPath}" traverses symbolic link "${cursor}" inside writable directory`,
              'protectedPaths',
            );
          } else if (pStat === null || !pStat.isDirectory()) {
            parentsValid = false;
            break;
          }
        }
        if (!parentsValid) continue;

        let existingStat: ReturnType<typeof lstatSync> | null = null;
        let missing = parentCreated;
        if (!missing) {
          try {
            existingStat = lstatSync(protectedPath);
          } catch (err) {
            if ((err as NodeJS.ErrnoException | null)?.code === 'ENOENT') {
              missing = true;
            }
          }
        }

        if (missing) {
          const openFlags = fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY | (fsConstants.O_NOFOLLOW ?? 0);
          try {
            const fd = openSync(protectedPath, openFlags, 0o000);
            try {
              const st = fstatSync(fd);
              createdFiles.push({ path: protectedPath, dev: st.dev, ino: st.ino });
              coveredRoots.push(protectedPath);
            } finally {
              closeSync(fd);
            }
          } catch (err) {
            if ((err as NodeJS.ErrnoException | null)?.code === 'ELOOP') {
              policyInvalid(`protectedPath "${protectedPath}" targets a symbolic link`, 'protectedPaths');
            }
            // Skip if concurrently created or parent is non-writable.
          }
        } else if (existingStat !== null) {
          coveredRoots.push(protectedPath);
        }
      }
    }
  } catch (err) {
    cleanupCreated();
    throw err;
  }

  return {
    placeholderPaths: Object.freeze(createdFiles.map(f => f.path)),
    cleanup: cleanupCreated,
  };
}

/**
 * Execute a command inside the negotiated OS sandbox with sanitized environment, bounded streams,
 * timeout enforcement, process-group cleanup, and secret scrubbing.
 */
export async function executeSandboxedCommand(input: SandboxedCommandInput): Promise<SandboxedCommandResult> {
  if (typeof input.command !== 'string' || input.command.trim().length === 0 || /[\0\r\n]/.test(input.command)) {
    policyInvalid('command must be a non-empty string without control characters', 'command');
  }
  const env = resolveHostEnvironment(input.host);
  const normalized = normalizeSandboxPolicy(input.policy, env);
  const negotiated = negotiateSandboxBackend(input.policy, env);

  const timeoutMs = input.timeoutMs ?? DEFAULT_SANDBOX_TIMEOUT_MS;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 50 || timeoutMs > MAX_SANDBOX_TIMEOUT_MS) {
    policyInvalid(`timeoutMs must be an integer in 50..${MAX_SANDBOX_TIMEOUT_MS}`, 'timeoutMs');
  }
  const maxOutputBytes = input.maxOutputBytes ?? DEFAULT_SANDBOX_OUTPUT_BYTES;
  if (!Number.isSafeInteger(maxOutputBytes) || maxOutputBytes < 1024 || maxOutputBytes > 16_777_216) {
    policyInvalid('maxOutputBytes must be an integer in 1024..16777216', 'maxOutputBytes');
  }

  const scrubber = new SecretScrubber();
  for (const secret of input.secretsToScrub ?? []) {
    scrubber.register(secret);
  }

  const sanitizedEnv: Record<string, string> = {
    HOME: normalized.canonicalScratchDirectory ?? normalized.canonicalWorkspaceRoot,
    PATH: '/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin',
    LANG: 'C.UTF-8',
    TERM: 'dumb',
    ...(input.env ?? {}),
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_TERMINAL_PROMPT: '0',
  };
  const targetCwd = input.cwd === undefined
    ? normalized.canonicalWorkspaceRoot
    : canonicalizeAbsolutePath(input.cwd, 'cwd');

  let placeholderGuard: ProvisionedAbsentProtectedPlaceholders | null = null;
  try {
    let spawnExecutable: string;
    let spawnArgs: readonly string[];
    let spawnCwd = targetCwd;
    let seccompBpf: Buffer | null = null;

    if (negotiated.backendId === 'macos-seatbelt') {
      provisionSandboxExactWritablePaths(normalized, { createTargetFile: false });
      const compiled = compileMacosSeatbeltProfile(input.policy, env);
      spawnExecutable = compiled.executablePath;
      spawnArgs = ['-p', compiled.profileText, '--', input.command, ...(input.args ?? [])];
    } else if (negotiated.backendId === 'linux-bwrap') {
      const dynamicGlob = findDynamicProtectedGlobOverlap(normalized);
      if (dynamicGlob !== null) {
        throw new TaskpackError(
          'SANDBOX_CAPABILITY_INSUFFICIENT',
          `linux-bwrap cannot enforce dynamic protected glob "${dynamicGlob}" inside writable directory`,
          'protectedPaths',
        );
      }
      placeholderGuard = provisionAbsentProtectedPlaceholders(normalized);
      const compiled = compileLinuxBwrapCommand(input.policy, env, {
        cwd: targetCwd,
        env: sanitizedEnv,
        provisionExactFiles: true,
        inheritSpawnEnv: true,
      });
      seccompBpf = compileLinuxSeccompBpfBinary(env.arch, {
        blockIpSockets: normalized.networkMode === 'none',
      });
      spawnExecutable = compiled.executablePath;
      spawnArgs = [...compiled.args, '--seccomp', '3', '--', input.command, ...(input.args ?? [])];
      if (spawnArgs.length > 8_999) {
        throw new TaskpackError(
          'SANDBOX_CAPABILITY_INSUFFICIENT',
          `linux-bwrap invocation requires ${spawnArgs.length} arguments, exceeding max 8999`,
          'args',
        );
      }
    } else if (negotiated.backendId === 'linux-landlock') {
      if (normalized.networkMode === 'loopback-only') {
        throw new TaskpackError(
          'SANDBOX_CAPABILITY_INSUFFICIENT',
          'linux-landlock cannot enforce loopback-only network isolation without network namespaces',
          'networkMode',
        );
      }
      const overlap = findLandlockWritableOverlap(normalized);
      if (overlap !== null) {
        throw new TaskpackError(
          'SANDBOX_CAPABILITY_INSUFFICIENT',
          `linux-landlock cannot enforce nested exclusion inside writable directory (${overlap})`,
          'protectedPaths',
        );
      }
      provisionSandboxExactWritablePaths(normalized, { createTargetFile: true });
      spawnExecutable = negotiated.executablePath!;
      spawnCwd = '/';
      const landlockConfig = JSON.stringify({
        workspaceRoot: normalized.canonicalWorkspaceRoot,
        writablePaths: normalized.canonicalWritablePaths,
        exactWritableFiles: [...normalized.canonicalExactWritableFiles],
        protectedPaths: normalized.canonicalProtectedPaths,
        deniedReadPaths: normalized.canonicalDeniedReadPaths,
        allowedReadOnlyPaths: normalized.canonicalAllowedReadOnlyPaths,
        networkMode: normalized.networkMode,
        blockIpSockets: normalized.networkMode === 'none',
        cwd: targetCwd,
      });
      spawnArgs = ['-I', '-S', '-B', '-c', LANDLOCK_BOOTSTRAP_SCRIPT, landlockConfig, input.command, ...(input.args ?? [])];
    } else if (negotiated.backendId === 'direct-dedicated') {
      spawnExecutable = input.command;
      spawnArgs = [...(input.args ?? [])];
    } else {
      throw new TaskpackError('SANDBOX_BACKEND_UNAVAILABLE', `backend "${negotiated.backendId}" direct command spawn is not supported without container runtime adapter`, 'backendId');
    }

    const started = performance.now();
    return await new Promise<SandboxedCommandResult>((resolvePromise, rejectPromise) => {
      const child = spawn(spawnExecutable, [...spawnArgs], {
        cwd: spawnCwd,
        env: sanitizedEnv,
        stdio: seccompBpf !== null ? ['pipe', 'pipe', 'pipe', 'pipe'] : ['pipe', 'pipe', 'pipe'],
        detached: true,
      });

      if (seccompBpf !== null) {
        const seccompStream = child.stdio[3] as Writable | null | undefined;
        if (seccompStream !== null && seccompStream !== undefined) {
          seccompStream.on('error', () => undefined);
          seccompStream.end(seccompBpf);
        }
      }

      const killGroup = (signal: NodeJS.Signals): void => {
        try {
          if (child.pid !== undefined) process.kill(-child.pid, signal);
        } catch {
          child.kill(signal);
        }
      };

      const stdoutChunks: Buffer[] = [];
      const stderrChunks: Buffer[] = [];
      let stdoutBytes = 0;
      let stderrBytes = 0;
      let timedOut = false;
      let settled = false;

      const timer = setTimeout(() => {
        timedOut = true;
        killGroup('SIGTERM');
        setTimeout(() => {
          if (!settled) killGroup('SIGKILL');
        }, 200);
      }, timeoutMs);

      const finish = (exitCode: number | null, signal: NodeJS.Signals | null, error?: Error): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (error !== undefined) {
          rejectPromise(error);
          return;
        }
        const rawStdout = Buffer.concat(stdoutChunks).toString('utf8');
        const rawStderr = Buffer.concat(stderrChunks).toString('utf8');
        resolvePromise(Object.freeze({
          backendId: negotiated.backendId,
          profileDigest: negotiated.profileDigest,
          exitCode,
          signal,
          stdout: scrubber.scrub(rawStdout),
          stderr: scrubber.scrub(rawStderr),
          timedOut,
          durationMs: Math.max(1, Math.round(performance.now() - started)),
        }));
      };

      child.on('error', err => {
        finish(null, null, new TaskpackError('SANDBOX_EXECUTION_FAILED', `sandboxed command failed to spawn: ${err.message}`));
      });

      child.stdout.on('data', (chunk: Buffer) => {
        stdoutBytes += chunk.byteLength;
        if (stdoutBytes > maxOutputBytes) {
          killGroup('SIGKILL');
          finish(null, null, new TaskpackError('SANDBOX_EXECUTION_FAILED', `sandboxed command stdout exceeded ${maxOutputBytes} bytes`));
          return;
        }
        stdoutChunks.push(chunk);
      });

      child.stderr.on('data', (chunk: Buffer) => {
        stderrBytes += chunk.byteLength;
        if (stderrBytes > maxOutputBytes) {
          killGroup('SIGKILL');
          finish(null, null, new TaskpackError('SANDBOX_EXECUTION_FAILED', `sandboxed command stderr exceeded ${maxOutputBytes} bytes`));
          return;
        }
        stderrChunks.push(chunk);
      });

      if (input.stdin !== undefined) {
        child.stdin.end(input.stdin);
      } else {
        child.stdin.end();
      }

      child.on('close', (code, signal) => {
        killGroup('SIGKILL');
        finish(code, signal);
      });
    });
  } finally {
    placeholderGuard?.cleanup();
  }
}

export interface ResolveTaskpackSandboxOptions {
  readonly workspaceRoot: string;
  readonly scratchDirectory?: string | undefined;
  readonly controlRoot?: string | undefined;
  readonly relativeTaskpackPath?: string | undefined;
  readonly policyProfile?: PolicyProfile | undefined;
  readonly env?: NodeJS.ProcessEnv | undefined;
  readonly hostPolicy?: ExecutionHostPolicy | undefined;
  readonly allowedReadOnlyPaths?: readonly string[] | undefined;
}

/**
 * Resolve the effective sandbox policy for a declarative Taskpack manifest.
 * Under GitHub Actions (`GITHUB_ACTIONS === 'true'`), omitted `spec.sandbox`
 * defaults to `direct-dedicated` because GitHub-hosted runners already isolate the job.
 */
export function resolveEffectiveTaskpackSandboxPolicy(
  manifest: TaskpackManifest,
  options: ResolveTaskpackSandboxOptions,
): SandboxPolicyInput {
  if (
    options.policyProfile !== undefined
    && options.hostPolicy?.policyProfile !== undefined
    && options.policyProfile !== options.hostPolicy.policyProfile
  ) {
    throw new TaskpackError(
      'TASKPACK_HOST_BINDING_INVALID',
      `conflicting policyProfile "${options.policyProfile}" and hostPolicy.policyProfile "${options.hostPolicy.policyProfile}"`,
      '/policyProfile',
    );
  }
  const policyProfile: PolicyProfile = options.policyProfile ?? options.hostPolicy?.policyProfile ?? 'local';
  validateExecutionAuthority(manifest.spec.execution, options.hostPolicy);
  const allowWorkflowWrites = policyProfile === 'github'
    && manifest.spec.execution?.capabilities.allowWorkflowWrites === true
    && options.hostPolicy?.allowWorkflowWrites === true;
  const allowAgentNetwork = manifest.spec.execution?.capabilities.allowAgentNetwork === true
    && options.hostPolicy?.allowPrivileged === true;
  const resolvedControl = options.controlRoot !== undefined
    ? {
      controlRoot: normalizeRelativePath(options.controlRoot, '/controlRoot'),
      ...(options.relativeTaskpackPath !== undefined
        ? { manifestPath: normalizeRelativePath(options.relativeTaskpackPath, '/relativeTaskpackPath') }
        : manifest.manifestPath !== undefined
          ? { manifestPath: manifest.manifestPath }
          : {}),
    }
    : resolveManifestControlRoot(manifest, options.relativeTaskpackPath);
  const commandScripts = manifest.spec.verification.localChecks
    .flatMap(check => (
      check.implementation === 'command.v1' && typeof check.parameters?.['script'] === 'string' && check.parameters['script'].length > 0
        ? [check.parameters['script']]
        : []
    ));
  const toolchainPaths = manifest.spec.verification.localChecks
    .flatMap(check => (
      check.implementation === 'command.v1' && Array.isArray(check.parameters?.['toolchainPaths'])
        ? check.parameters['toolchainPaths'].filter((entry): entry is string => typeof entry === 'string' && entry.length > 0)
        : []
    ));
  const allInstructions = [
    ...(manifest.spec.instructions ?? []),
    ...(manifest.spec.roles ?? []).flatMap(role => role.instructions ?? []),
  ];
  const allSkills = [
    ...(manifest.spec.skills ?? []),
    ...(manifest.spec.roles ?? []).flatMap(role => role.skills ?? []),
  ];
  const proposalPath = manifest.spec.proposal?.path;
  const controlRootSiblingSet = proposalPath !== undefined
    ? collectControlRootSiblingPaths({
      repositoryRoot: options.workspaceRoot,
      controlRoot: resolvedControl.controlRoot,
      proposalPath,
    })
    : Object.freeze({ prioritySiblings: Object.freeze([]), regularSiblings: Object.freeze([]) });
  const githubSiblings = allowWorkflowWrites
    ? collectGitHubSiblingPaths({ repositoryRoot: options.workspaceRoot })
    : [];
  assertManifestScopeInvariants(manifest, {
    policyProfile,
    controlRoot: resolvedControl.controlRoot,
    manifestPath: resolvedControl.manifestPath,
    commandScripts,
    priorityControlRootSiblings: controlRootSiblingSet.prioritySiblings,
    controlRootSiblings: controlRootSiblingSet.regularSiblings,
    githubSiblings,
    hostPolicy: options.hostPolicy,
    allowWildcardWritableWhenControlRootProtected: true,
  });
  const writablePaths = manifest.spec.scope.writable.length === 0 ||
    (manifest.spec.scope.writable.length === 1 && manifest.spec.scope.writable[0] === '**')
    ? ['.']
    : [...manifest.spec.scope.writable];
  const protectedPaths = effectiveProtectedPaths(manifest.spec.scope.protected, {
    policyProfile,
    controlRoot: resolvedControl.controlRoot,
    manifestPath: resolvedControl.manifestPath,
    digestsLockfile: manifest.spec.execution?.digests?.lockfile,
    instructions: allInstructions.length > 0 ? allInstructions : undefined,
    skills: allSkills.length > 0 ? allSkills : undefined,
    preflightScript: manifest.spec.preflight?.script,
    commandScripts,
    toolchainPaths: toolchainPaths.length > 0 ? toolchainPaths : undefined,
    proposalPath,
    priorityControlRootSiblings: controlRootSiblingSet.prioritySiblings,
    controlRootSiblings: controlRootSiblingSet.regularSiblings,
    allowWorkflowWrites,
    githubSiblings,
  });
  const proposalInControlRoot = proposalPath !== undefined && pathCoveredBy(proposalPath, resolvedControl.controlRoot);

  const basePolicy: SandboxPolicyInput = {
    workspaceRoot: options.workspaceRoot,
    ...(options.scratchDirectory !== undefined ? { scratchDirectory: options.scratchDirectory } : {}),
    writablePaths,
    protectedPaths,
    policyProfile,
    allowWorkflowWrites,
    strictExactFiles: true,
    ...(options.allowedReadOnlyPaths !== undefined && options.allowedReadOnlyPaths.length > 0
      ? { allowedReadOnlyPaths: options.allowedReadOnlyPaths }
      : {}),
    ...(allowAgentNetwork ? { networkMode: 'allow-outbound' as const } : {}),
    ...(proposalInControlRoot && proposalPath !== undefined
      ? {
        controlRoot: resolvedControl.controlRoot,
        proposalPath,
      }
      : {}),
  };

  if (manifest.spec.sandbox !== undefined) {
    const sandbox = manifest.spec.sandbox;
    return {
      ...basePolicy,
      ...(sandbox.preferredBackends?.includes('direct-dedicated') === true ? { allowDedicatedDirectOverride: true } : {}),
      ...(sandbox.preferredBackends !== undefined ? { preferredBackends: sandbox.preferredBackends } : {}),
      ...(sandbox.networkMode !== undefined ? { networkMode: sandbox.networkMode } : {}),
      ...(sandbox.requiredCapabilities !== undefined ? { requiredCapabilities: sandbox.requiredCapabilities } : {}),
      ...(sandbox.deniedReadPaths !== undefined ? { deniedReadPaths: sandbox.deniedReadPaths } : {}),
    };
  }

  const runtimeEnv = options.env ?? process.env;
  const runnerEnv = (runtimeEnv['RUNNER_ENVIRONMENT'] ?? '').trim();
  if (runtimeEnv['GITHUB_ACTIONS'] === 'true' && runnerEnv === 'github-hosted') {
    return {
      ...basePolicy,
      preferredBackends: ['direct-dedicated'],
      networkMode: 'allow-outbound',
      requiredCapabilities: ['processTreeCleanup'],
      allowDedicatedDirectOverride: true,
    };
  }

  return basePolicy;
}
