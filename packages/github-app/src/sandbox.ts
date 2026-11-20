import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  closeSync, constants as fsConstants, existsSync, lstatSync, mkdirSync, openSync, readdirSync, realpathSync, statSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, resolve, sep } from 'node:path';
import {
  assertManifestScopeInvariants, effectiveProtectedPaths, isControlRootProposalWritableAllowed,
  normalizeRelativePath, pathCoveredBy, validateExecutionAuthority,
} from './schema.js';
import { collectControlRootSiblingPaths, collectGitHubSiblingPaths, resolveManifestControlRoot } from './taskpack.js';
import { SecretScrubber } from './token-broker.js';
import {
  GitHubAppError, PROTECTED_AUTOMATION_PATHS,
  type CompiledLinuxBwrapCommand, type CompiledMacosSeatbeltProfile, type Digest,
  type NegotiatedSandboxBackend, type SandboxBackendId, type SandboxCapability,
  type SandboxHostEnvironment, type SandboxedCommandInput, type SandboxedCommandResult,
  type SandboxNetworkMode, type SandboxPolicyInput, type TaskpackManifest,
} from './types.js';

export const TRUSTED_SEATBELT_PATHS: readonly string[] = Object.freeze(['/usr/bin/sandbox-exec']);
export const TRUSTED_BWRAP_PATHS: readonly string[] = Object.freeze(['/usr/bin/bwrap', '/bin/bwrap', '/usr/local/bin/bwrap']);
export const TRUSTED_PYTHON_PATHS: readonly string[] = Object.freeze(['/usr/bin/python3', '/bin/python3', '/usr/local/bin/python3']);
export const TRUSTED_DOCKER_PATHS: readonly string[] = Object.freeze(['/usr/local/bin/docker', '/usr/bin/docker', '/opt/homebrew/bin/docker']);

export const DEFAULT_DENIED_HOME_SUBPATHS: readonly string[] = Object.freeze([
  '.ssh', '.aws', '.gnupg', '.kube', '.docker', '.config/gh', '.npmrc', '.pypirc', '.netrc',
]);

export const ALWAYS_PROTECTED_WORKSPACE_SUBPATHS: readonly string[] = Object.freeze([
  '.git', '.github', '.loopwright', '.claude', '.codex', 'AGENTS.md', 'CLAUDE.md',
]);

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

function policyInvalid(message: string, path: string | null = null): never {
  throw new GitHubAppError('SANDBOX_POLICY_INVALID', message, path);
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

/**
 * Canonicalize an absolute path via `realpathSync` when present on disk, or by canonicalizing its
 * nearest existing ancestor and appending the normalized remaining segments.
 */
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

const MAX_GLOB_VISITED_DIRS = 2_048;
const MAX_GLOB_EXPANDED_PATHS = 4_096;

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

interface NormalizedSandboxPaths {
  readonly canonicalWorkspaceRoot: string;
  readonly canonicalScratchDirectory: string | null;
  readonly canonicalWritablePaths: readonly string[];
  readonly canonicalExactWritableFiles: ReadonlySet<string>;
  readonly seatbeltExactFileRegexes: readonly string[];
  readonly canonicalProtectedPaths: readonly string[];
  readonly canonicalDeniedReadPaths: readonly string[];
  readonly canonicalAllowedReadOnlyPaths: readonly string[];
  readonly networkMode: SandboxNetworkMode;
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
  const allowWorkflowWrites = policy.allowWorkflowWrites === true;
  const strictExactFiles = policy.strictExactFiles === true;

  const networkMode: SandboxNetworkMode = policy.networkMode ?? 'none';
  if (networkMode !== 'none' && networkMode !== 'loopback-only' && networkMode !== 'allow-outbound') {
    policyInvalid(`unsupported networkMode "${String(networkMode)}"`, 'networkMode');
  }

  if (!Array.isArray(policy.writablePaths) || policy.writablePaths.length === 0 || policy.writablePaths.length > 128) {
    policyInvalid('writablePaths must be a non-empty array of at most 128 paths', 'writablePaths');
  }

  // Build protected paths first so we can check writable path overlaps against protected automation paths.
  const protectedGlobBudget: GlobExpansionBudget = { visitedDirs: 0, expandedPaths: 0 };
  const callerProtectedRelPaths: string[] = [];
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

  const builtInWorkspaceProtected = allowWorkflowWrites
    ? ALWAYS_PROTECTED_WORKSPACE_SUBPATHS.filter(sub => sub !== '.github')
    : ALWAYS_PROTECTED_WORKSPACE_SUBPATHS;
  const builtInAutomationProtected = allowWorkflowWrites
    ? PROTECTED_AUTOMATION_PATHS.filter(sub => sub !== '.github')
    : PROTECTED_AUTOMATION_PATHS;
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
      ...builtInWorkspaceProtected.filter(
        sub => sub !== '.loopwright' || effectiveControlRoot !== '.loopwright',
      ),
      ...builtInAutomationProtected,
      ...discoveredGitHubSiblings,
      `${effectiveControlRoot}/policies`,
      `${effectiveControlRoot}/checks`,
      `${effectiveControlRoot}/memory`,
      `${effectiveControlRoot}/taskpack.yaml`,
      `${effectiveControlRoot}/taskpack.yml`,
      `${effectiveControlRoot}/taskpack.json`,
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
    ...(omitBareControlRootProtection && effectiveControlRoot === '.loopwright'
      ? builtInWorkspaceProtected.filter(sub => sub !== '.loopwright')
      : builtInWorkspaceProtected),
    ...builtInAutomationProtected,
    ...(omitBareControlRootProtection
      ? [
        `${effectiveControlRoot}/policies`,
        `${effectiveControlRoot}/checks`,
        `${effectiveControlRoot}/memory`,
        `${effectiveControlRoot}/taskpack.yaml`,
        `${effectiveControlRoot}/taskpack.yml`,
        `${effectiveControlRoot}/taskpack.json`,
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
      // Leaf globs emit exact Seatbelt regex rules on macOS and exact existing-file binds/rules on Linux
      // bwrap/Landlock without ever over-granting writable access to the parent directory.
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

  // Build denied read paths from homeDirectory defaults + caller deniedReadPaths.
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

  // Exclude any denied path that is an ancestor of workspaceRoot or scratchDirectory so traversal to the workspace works.
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

  return {
    canonicalWorkspaceRoot,
    canonicalScratchDirectory,
    canonicalWritablePaths,
    canonicalExactWritableFiles,
    seatbeltExactFileRegexes,
    canonicalProtectedPaths,
    canonicalDeniedReadPaths: Object.freeze(filteredDenied),
    canonicalAllowedReadOnlyPaths,
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
    throw new GitHubAppError('SANDBOX_BACKEND_UNAVAILABLE', `untrusted macOS seatbelt executable "${executablePath}"`, 'seatbeltExecutable');
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

  if (normalized.canonicalProtectedPaths.length > 0) {
    lines.push('(deny file-write*');
    for (const protectedPath of normalized.canonicalProtectedPaths) {
      lines.push(`  (subpath "${protectedPath}")`);
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

/**
 * Compute the canonical Linux seccomp BPF syscall filter profile for sandboxed tool execution.
 */
export function computeSandboxSeccompProfile(): { readonly json: string; readonly digest: Digest } {
  const document = {
    defaultAction: 'SCMP_ACT_ALLOW',
    syscalls: [
      {
        names: [...SECCOMP_BLOCKED_SYSCALLS],
        action: 'SCMP_ACT_ERRNO',
        errnoRet: 1,
      },
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
  },
): CompiledLinuxBwrapCommand {
  const env = resolveHostEnvironment(host);
  const executablePath = env.bwrapExecutable ?? TRUSTED_BWRAP_PATHS[0]!;
  if (!TRUSTED_BWRAP_PATHS.includes(executablePath)) {
    throw new GitHubAppError('SANDBOX_BACKEND_UNAVAILABLE', `untrusted Linux bwrap executable "${executablePath}"`, 'bwrapExecutable');
  }
  const normalized = normalizeSandboxPolicy(policy, env);
  if (options?.provisionExactFiles ?? env.probeExecutables) {
    provisionSandboxExactWritablePaths(normalized, { createTargetFile: true });
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

  for (const deniedPath of normalized.canonicalDeniedReadPaths) {
    if (!env.probeExecutables) {
      args.push('--tmpfs', deniedPath, '--remount-ro', deniedPath);
      continue;
    }
    if (!existsSync(deniedPath)) {
      continue;
    }
    if (statSync(deniedPath).isDirectory()) {
      args.push('--tmpfs', deniedPath, '--remount-ro', deniedPath);
    } else {
      args.push('--ro-bind', '/dev/null', deniedPath);
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

  const targetCwd = options?.cwd === undefined
    ? normalized.canonicalWorkspaceRoot
    : canonicalizeAbsolutePath(options.cwd, 'cwd');
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

  const seccomp = computeSandboxSeccompProfile();
  const profilePayload = JSON.stringify({ executablePath, args, seccompDigest: seccomp.digest.hex, networkMode: normalized.networkMode });
  const profileDigest = sha256Digest('loopwright.dev/sandbox-bwrap/v1', profilePayload);

  return Object.freeze({
    backendId: 'linux-bwrap' as const,
    executablePath,
    args: Object.freeze(args),
    seccompProfileJson: seccomp.json,
    seccompDigest: seccomp.digest,
    profileDigest,
    canonicalWorkspaceRoot: normalized.canonicalWorkspaceRoot,
    canonicalWritablePaths: normalized.canonicalWritablePaths,
    canonicalProtectedPaths: normalized.canonicalProtectedPaths,
    canonicalDeniedReadPaths: normalized.canonicalDeniedReadPaths,
    networkMode: normalized.networkMode,
  });
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
    throw new GitHubAppError(
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
      const compiled = compileLinuxBwrapCommand(
        policy,
        { ...env, bwrapExecutable: executable },
        { provisionExactFiles: false },
      );
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
      const executable = validateExecutableChoice(env.pythonExecutable, TRUSTED_PYTHON_PATHS, env.probeExecutables);
      if (executable === null) {
        availabilityFailure ??= `linux-landlock helper binary is missing or untrusted (${env.pythonExecutable ?? TRUSTED_PYTHON_PATHS[0]})`;
        continue;
      }
      const supported = SANDBOX_CAPABILITIES_BY_BACKEND['linux-landlock'];
      const missing = requiredCapabilities.filter(req => !supported.includes(req));
      if (missing.length > 0) {
        capabilityFailure ??= `linux-landlock lacks required capabilities: ${missing.join(', ')}`;
        continue;
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
    throw new GitHubAppError('SANDBOX_CAPABILITY_INSUFFICIENT', capabilityFailure, 'requiredCapabilities');
  }
  throw new GitHubAppError(
    'SANDBOX_BACKEND_UNAVAILABLE',
    availabilityFailure ?? `no compatible sandbox backend available for platform "${env.platform}"`,
    'preferredBackends',
  );
}

const LANDLOCK_BOOTSTRAP_SCRIPT = `import ctypes, json, os, signal, sys

libc = ctypes.CDLL(None, use_errno=True)
PR_SET_PDEATHSIG = 1
PR_SET_NO_NEW_PRIVS = 38
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

cfg = json.loads(sys.argv[1])
cmd = sys.argv[2]
args = sys.argv[3:]

libc.prctl(PR_SET_PDEATHSIG, signal.SIGKILL, 0, 0, 0)
if libc.prctl(PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0) != 0:
    sys.exit(126)

abi = libc.syscall(SYS_landlock_create_ruleset, None, 0, LANDLOCK_CREATE_RULESET_VERSION)
if abi < 1:
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

def add_path_rule(path, access):
    try:
        fd = os.open(path, O_PATH | os.O_CLOEXEC)
    except OSError:
        return
    try:
        actual = access if os.path.isdir(path) else (access & (FS_EXECUTE | FS_READ_FILE | WRITE_FILE_ACCESS))
        if actual == 0:
            return
        rule = PathBeneathAttr(actual, fd)
        libc.syscall(SYS_landlock_add_rule, ruleset_fd, LANDLOCK_RULE_PATH_BENEATH, ctypes.byref(rule), 0)
    finally:
        os.close(fd)

def is_same_or_child(candidate, parent):
    if parent == "/":
        return True
    return candidate == parent or candidate.startswith(parent + "/")

def grant_tree(current, excluded_set, access):
    if current in excluded_set:
        return
    needs_split = any(ex != current and is_same_or_child(ex, current) for ex in excluded_set)
    if not needs_split or not os.path.isdir(current) or os.path.islink(current):
        add_path_rule(current, access)
        return
    try:
        entries = os.listdir(current)
    except OSError:
        return
    for name in entries:
        child = "/" + name if current == "/" else current + "/" + name
        grant_tree(child, excluded_set, access)

denied_reads = {p for p in cfg.get("deniedReadPaths", []) if os.path.exists(p)}
protected_writes = {p for p in cfg.get("protectedPaths", []) if os.path.exists(p)} | denied_reads
writable_paths = cfg.get("writablePaths", [])
exact_writable_files = set(cfg.get("exactWritableFiles", []))

grant_tree("/", denied_reads, READ_ACCESS)
for ro_path in cfg.get("allowedReadOnlyPaths", []):
    if os.path.exists(ro_path):
        add_path_rule(ro_path, READ_ACCESS)
for dev in ("/dev/null", "/dev/zero"):
    add_path_rule(dev, READ_ACCESS | WRITE_FILE_ACCESS)
for wp in writable_paths:
    if wp in exact_writable_files:
        if os.path.isfile(wp) and not os.path.islink(wp):
            add_path_rule(wp, READ_ACCESS | WRITE_FILE_ACCESS)
    elif os.path.exists(wp):
        grant_tree(wp, protected_writes, READ_ACCESS | WRITE_DIR_ACCESS)

if libc.syscall(SYS_landlock_restrict_self, ruleset_fd, 0) != 0:
    os.close(ruleset_fd)
    sys.exit(126)
os.close(ruleset_fd)

cwd = cfg.get("cwd")
if cwd:
    os.chdir(cwd)
env = cfg.get("env")
if env is not None:
    os.environ.clear()
    os.environ.update(env)
os.execvp(cmd, [cmd] + args)
`;

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

  let spawnExecutable: string;
  let spawnArgs: readonly string[];

  if (negotiated.backendId === 'macos-seatbelt') {
    provisionSandboxExactWritablePaths(normalized, { createTargetFile: false });
    const compiled = compileMacosSeatbeltProfile(input.policy, env);
    spawnExecutable = compiled.executablePath;
    spawnArgs = ['-p', compiled.profileText, '--', input.command, ...(input.args ?? [])];
  } else if (negotiated.backendId === 'linux-bwrap') {
    const compiled = compileLinuxBwrapCommand(input.policy, env, {
      cwd: targetCwd,
      env: sanitizedEnv,
      provisionExactFiles: true,
    });
    spawnExecutable = compiled.executablePath;
    spawnArgs = [...compiled.args, '--', input.command, ...(input.args ?? [])];
  } else if (negotiated.backendId === 'linux-landlock') {
    provisionSandboxExactWritablePaths(normalized, { createTargetFile: true });
    spawnExecutable = negotiated.executablePath!;
    const landlockConfig = JSON.stringify({
      workspaceRoot: normalized.canonicalWorkspaceRoot,
      writablePaths: normalized.canonicalWritablePaths,
      exactWritableFiles: [...normalized.canonicalExactWritableFiles],
      protectedPaths: normalized.canonicalProtectedPaths,
      deniedReadPaths: normalized.canonicalDeniedReadPaths,
      allowedReadOnlyPaths: normalized.canonicalAllowedReadOnlyPaths,
      networkMode: normalized.networkMode,
      cwd: targetCwd,
      env: sanitizedEnv,
    });
    spawnArgs = ['-B', '-c', LANDLOCK_BOOTSTRAP_SCRIPT, landlockConfig, input.command, ...(input.args ?? [])];
  } else if (negotiated.backendId === 'direct-dedicated') {
    spawnExecutable = input.command;
    spawnArgs = [...(input.args ?? [])];
  } else {
    throw new GitHubAppError('SANDBOX_BACKEND_UNAVAILABLE', `backend "${negotiated.backendId}" direct command spawn is not supported without container runtime adapter`, 'backendId');
  }

  const started = performance.now();
  return await new Promise<SandboxedCommandResult>((resolvePromise, rejectPromise) => {
    const child = spawn(spawnExecutable, [...spawnArgs], {
      cwd: targetCwd,
      env: sanitizedEnv,
      stdio: ['pipe', 'pipe', 'pipe'],
      detached: true,
    });

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
      finish(null, null, new GitHubAppError('SANDBOX_EXECUTION_FAILED', `sandboxed command failed to spawn: ${err.message}`));
    });

    child.stdout.on('data', (chunk: Buffer) => {
      stdoutBytes += chunk.byteLength;
      if (stdoutBytes > maxOutputBytes) {
        killGroup('SIGKILL');
        finish(null, null, new GitHubAppError('SANDBOX_EXECUTION_FAILED', `sandboxed command stdout exceeded ${maxOutputBytes} bytes`));
        return;
      }
      stdoutChunks.push(chunk);
    });

    child.stderr.on('data', (chunk: Buffer) => {
      stderrBytes += chunk.byteLength;
      if (stderrBytes > maxOutputBytes) {
        killGroup('SIGKILL');
        finish(null, null, new GitHubAppError('SANDBOX_EXECUTION_FAILED', `sandboxed command stderr exceeded ${maxOutputBytes} bytes`));
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
      finish(code, signal);
    });
  });
}

export interface ResolveTaskpackSandboxOptions {
  readonly workspaceRoot: string;
  readonly scratchDirectory?: string | undefined;
  readonly controlRoot?: string | undefined;
  readonly relativeTaskpackPath?: string | undefined;
  readonly env?: NodeJS.ProcessEnv | undefined;
  readonly hostPolicy?: import('./types.js').ExecutionHostPolicy | undefined;
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
  validateExecutionAuthority(manifest.spec.execution, options.hostPolicy);
  const allowWorkflowWrites = manifest.spec.execution?.capabilities.allowWorkflowWrites === true
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
  if (runtimeEnv['GITHUB_ACTIONS'] === 'true') {
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
