import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import { chmod, lstat, mkdir, mkdtemp, open, readdir, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { STANDARD_PI_PROVIDER_ENV } from '@loopwright/agent-pi/catalog';
import { assertDigestLockfileVerified, computeFileDigest } from './digests.js';
import {
  collectMcpReferencedEnvNames,
  IDENTIFIER_PATTERN,
  normalizeRelativePath,
  parseJsonSubset,
  validateExecutionAuthority,
  type Json,
} from './schema.js';
import { SecretScrubber } from './token-broker.js';
import {
  GitHubAppError,
  type ExecutionHostPolicy,
  type TaskpackManifest,
  type TaskpackV2Manifest,
  type UpstreamAcquisitionStatus,
} from './types.js';
import {
  applyUpstreamGroups,
  attachUpstreamContext,
  evaluateUpstreamIntakeDisposition,
  isPlainRecord,
  loadRepositoryBaselineVersions,
  normalizeHeldBackVersions,
  type UpstreamAcquisitionRecord,
} from './upstreams.js';

export const PREFLIGHT_DEFAULT_TIMEOUT_SECONDS = 60;
export const PREFLIGHT_MAX_TIMEOUT_SECONDS = 3_600;
export const PREFLIGHT_MAX_OUTPUT_JSON_BYTES = 512 * 1024;
export const PREFLIGHT_OUTPUT_MAX_DEPTH = 12;
export const PREFLIGHT_MAX_STDIO_BYTES = 65_536;
export const PREFLIGHT_MAX_PROMPT_RESOURCE_BYTES = 64 * 1024;
export const PREFLIGHT_MAX_PROMPT_RESOURCES_TOTAL_BYTES = 256 * 1024;
export const PREFLIGHT_MAX_WORKSPACE_RESOURCE_BYTES = 128 * 1024 * 1024;
export const PREFLIGHT_MAX_WORKSPACE_RESOURCES_TOTAL_BYTES = 256 * 1024 * 1024;
export const PREFLIGHT_MAX_STAGED_RESOURCES = 64;
export const PREFLIGHT_MAX_UPSTREAMS = 64;
export const PREFLIGHT_MAX_METADATA_KEYS = 32;
export const PREFLIGHT_MAX_METADATA_BYTES = 8_192;
export const PREFLIGHT_SAFE_DEFAULT_PATH = '/usr/local/bin:/usr/bin:/bin';

const STDIO_DRAIN_GRACE_MS = 50;
const UPPERCASE_ENV_REF_PATTERN = /^\$\{([A-Z][A-Z0-9_]{0,63})\}$/;
const UPPERCASE_ENV_NAME_PATTERN = /^[A-Z][A-Z0-9_]{0,63}$/;

export type PreflightDisposition = 'candidate' | 'no_change' | 'blocked';
export type PreflightStagedResourceKind = 'instruction' | 'skill' | 'document';
export type PreflightStagedResourceMount = 'prompt' | 'workspace';

export interface PreflightPromptResource {
  readonly id: string;
  readonly kind: PreflightStagedResourceKind;
  readonly path: string;
  readonly content: string;
  readonly bytes: Buffer;
  readonly sha256: string;
  readonly byteLength: number;
  readonly exposeToChecks: boolean;
}

export interface PreflightWorkspaceResource {
  readonly id: string;
  readonly kind: PreflightStagedResourceKind;
  readonly relativePath: string;
  readonly stagedPath: string;
  readonly checkStagedPath: string | null;
  readonly sha256: string;
  readonly byteLength: number;
  readonly exposeToChecks: boolean;
}

export interface RunTaskpackPreflightOptions {
  readonly manifest: TaskpackManifest | TaskpackV2Manifest;
  readonly repositoryRoot: string;
  /** Caller must explicitly assert actor authorization and SecretScrubber setup already completed. */
  readonly authorized: boolean;
  readonly hostPolicy?: ExecutionHostPolicy | undefined;
  readonly scrubber: SecretScrubber;
  readonly env?: NodeJS.ProcessEnv | undefined;
  /** Explicit operator-brokered env map permitted past credential stripping (cannot override Loopwright preflight paths). */
  readonly brokeredEnv?: Readonly<Record<string, string>> | undefined;
  readonly tempRoot?: string | undefined;
  readonly timeoutMs?: number | undefined;
  readonly signal?: AbortSignal | undefined;
}

export interface RunTaskpackPreflightResult {
  readonly script: string;
  readonly scriptSha256: string;
  readonly disposition: PreflightDisposition;
  readonly reason: string | null;
  readonly upstreams: readonly UpstreamAcquisitionRecord[];
  readonly promptResources: readonly PreflightPromptResource[];
  readonly workspaceResources: readonly PreflightWorkspaceResource[];
  /** Read-only (`0o555`/`0o444`) directory containing all `mount: 'workspace'` resources, or `null` if none. */
  readonly stagedDir: string | null;
  /** Read-only (`0o555`/`0o444`) directory containing ONLY `exposeToChecks: true` workspace resources for `LOOPWRIGHT_STAGED_DIR`, or `null` if none. */
  readonly checkStagedDir: string | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly durationMs: number;
  readonly cleanup: () => Promise<void>;
}

const RESERVED_PREFLIGHT_INJECTED_VARS: ReadonlySet<string> = new Set([
  'LOOPWRIGHT_PREFLIGHT_OUT',
  'LOOPWRIGHT_REPO_ROOT',
  'LOOPWRIGHT_STAGING_DIR',
]);

const FORBIDDEN_CREDENTIAL_ENV_NAMES: ReadonlySet<string> = new Set([
  'GITHUB_TOKEN',
  'GH_TOKEN',
  'GITHUB_APP_PRIVATE_KEY',
  'GITHUB_APP_WEBHOOK_SECRET',
  'GITHUB_APP_ID',
  'GITHUB_APP_INSTALLATION_ID',
  'OPENAI_API_KEY',
  'ANTHROPIC_API_KEY',
  'GEMINI_API_KEY',
  'GOOGLE_API_KEY',
  'TYPESAFE_API_KEY',
  'AWS_ACCESS_KEY_ID',
  'AWS_SECRET_ACCESS_KEY',
  'AWS_SESSION_TOKEN',
  'NPM_TOKEN',
  'NODE_AUTH_TOKEN',
  'AZURE_OPENAI_API_KEY',
  'OPENROUTER_API_KEY',
  'XAI_API_KEY',
  'DEEPSEEK_API_KEY',
  'MISTRAL_API_KEY',
  'COHERE_API_KEY',
  'GROQ_API_KEY',
  'LLM_TOKEN',
  'BASH_ENV',
  'ENV',
  'NODE_OPTIONS',
  ...Object.values(STANDARD_PI_PROVIDER_ENV),
]);

const FORBIDDEN_CREDENTIAL_ENV_PREFIXES: readonly string[] = Object.freeze([
  'LOOPWRIGHT_',
  'GITHUB_APP_',
  'INPUT_',
  'ACTIONS_',
  'RUNNER_',
  'GIT_',
  'LD_',
  'DYLD_',
]);

const FORBIDDEN_CREDENTIAL_ENV_PATTERN = /(?:^|_)(?:TOKEN|SECRET|PASSWORD|PASSWD|API_KEY|APIKEY|PRIVATE_KEY|ACCESS_KEY|ACCESS_KEY_ID|AUTH_KEY|CREDENTIAL|BEARER|COOKIE|SESSION_KEY|SIGNING_KEY|GH_PAT)(?:$|_)/;

const FORBIDDEN_OBJECT_KEYS: ReadonlySet<string> = new Set(['__proto__', 'constructor', 'prototype']);
const ALLOWED_DISPOSITIONS: ReadonlySet<string> = new Set<PreflightDisposition>(['candidate', 'no_change', 'blocked']);
const ALLOWED_UPSTREAM_STATUSES: ReadonlySet<string> = new Set<UpstreamAcquisitionStatus>([
  'available',
  'up_to_date',
  'held_back',
  'blocked',
  'failed',
]);
const ALLOWED_STAGED_KINDS: ReadonlySet<string> = new Set<PreflightStagedResourceKind>(['instruction', 'skill', 'document']);
const ALLOWED_STAGED_MOUNTS: ReadonlySet<string> = new Set<PreflightStagedResourceMount>(['prompt', 'workspace']);

function extractEnvRefName(raw: string | undefined): string | undefined {
  if (typeof raw !== 'string') return undefined;
  const trimmed = raw.trim();
  const wrapped = UPPERCASE_ENV_REF_PATTERN.exec(trimmed);
  if (wrapped !== null) return wrapped[1]!;
  if (UPPERCASE_ENV_NAME_PATTERN.test(trimmed)) return trimmed;
  return undefined;
}

/** Collect every uppercase env-shaped secret/credential binding referenced by a Taskpack manifest. */
export function collectManifestSecretEnvNames(
  manifest: TaskpackManifest | TaskpackV2Manifest,
): ReadonlySet<string> {
  const names = new Set<string>();
  for (const model of manifest.spec.models ?? []) {
    const envName = extractEnvRefName(model.apiKeyEnv);
    if (envName !== undefined) names.add(envName.toUpperCase());
  }
  for (const mcpEnv of collectMcpReferencedEnvNames(manifest.spec.mcp?.servers)) {
    names.add(mcpEnv.toUpperCase());
  }
  for (const gate of manifest.spec.verification.externalGates) {
    const signingEnv = extractEnvRefName(gate.signingCredentialRef);
    if (signingEnv !== undefined) names.add(signingEnv.toUpperCase());
    const authEnv = extractEnvRefName(gate.authCredentialRef);
    if (authEnv !== undefined) names.add(authEnv.toUpperCase());
  }
  return names;
}

/**
 * True when an environment variable name holds Loopwright control-plane, GitHub App, CI/loader
 * runtime injection, manifest-declared credential, or provider secret material that MUST always be
 * stripped from preflight subprocesses unless explicitly passed via an operator-brokered map.
 */
export function isForbiddenPreflightEnvName(
  name: string,
  extraForbidden?: ReadonlySet<string>,
): boolean {
  const upper = name.toUpperCase();
  if (extraForbidden?.has(upper) === true) return true;
  if (FORBIDDEN_CREDENTIAL_ENV_NAMES.has(upper)) return true;
  if (FORBIDDEN_CREDENTIAL_ENV_PREFIXES.some(prefix => upper.startsWith(prefix))) return true;
  if (FORBIDDEN_CREDENTIAL_ENV_PATTERN.test(upper)) return true;
  return false;
}

function isContainedInRoot(candidate: string, root: string): boolean {
  if (candidate === root) return true;
  const prefix = root.endsWith(sep) ? root : `${root}${sep}`;
  return candidate.startsWith(prefix);
}

class BoundedStreamBuffer {
  readonly #maxBytes: number;
  readonly #chunks: Buffer[] = [];
  #totalBytes = 0;
  truncated = false;

  constructor(maxBytes: number) {
    this.#maxBytes = maxBytes;
  }

  append(chunk: Buffer): void {
    if (chunk.byteLength === 0) return;
    if (this.#totalBytes >= this.#maxBytes) {
      this.truncated = true;
      return;
    }
    const remaining = this.#maxBytes - this.#totalBytes;
    if (chunk.byteLength > remaining) {
      this.#chunks.push(chunk.subarray(0, remaining));
      this.#totalBytes += remaining;
      this.truncated = true;
      return;
    }
    this.#chunks.push(chunk);
    this.#totalBytes += chunk.byteLength;
  }

  toString(): string {
    if (this.#chunks.length === 0) return '';
    const text = Buffer.concat(this.#chunks).toString('utf8');
    return this.truncated ? `${text}\n[output truncated]` : text;
  }
}

async function resolveSafeDirectory(
  dirPath: string,
  label: string,
  errorCode: 'TASKPACK_MANIFEST_INVALID' | 'ACTION_INPUT_INVALID' = 'TASKPACK_MANIFEST_INVALID',
): Promise<{ readonly resolved: string; readonly real: string }> {
  const resolved = resolve(dirPath);
  const st = await lstat(resolved).catch(() => null);
  if (st === null || st.isSymbolicLink() || !st.isDirectory()) {
    throw new GitHubAppError(errorCode, `${label} must be an existing non-symlink directory`, '/spec/preflight');
  }
  const real = await realpath(resolved).catch(() => {
    throw new GitHubAppError(errorCode, `${label} cannot be resolved`, '/spec/preflight');
  });
  return { resolved, real };
}

async function openAndReadNoFollowBoundedFile(
  fullPath: string,
  maxBytes: number,
  diagPath: string,
  options?: { readonly requireSingleLink?: boolean | undefined },
): Promise<Buffer> {
  const requireSingleLink = options?.requireSingleLink === true;
  let before;
  try {
    before = await lstat(fullPath);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | null)?.code;
    if (code === 'ELOOP') {
      throw new GitHubAppError('TASKPACK_SCOPE_VIOLATION', `${diagPath}: symbolic link traversal is forbidden`, diagPath);
    }
    throw new GitHubAppError('TASKPACK_MANIFEST_INVALID', `${diagPath}: file does not exist or cannot be inspected`, diagPath);
  }
  if (before.isSymbolicLink()) {
    throw new GitHubAppError('TASKPACK_SCOPE_VIOLATION', `${diagPath}: symbolic links are forbidden`, diagPath);
  }
  if (!before.isFile()) {
    throw new GitHubAppError('TASKPACK_MANIFEST_INVALID', `${diagPath}: path must be a regular file`, diagPath);
  }
  if (requireSingleLink && before.nlink !== 1) {
    throw new GitHubAppError(
      'TASKPACK_SCOPE_VIOLATION',
      `${diagPath}: hardlinked file (nlink=${before.nlink}) is forbidden`,
      diagPath,
    );
  }
  if (before.size > maxBytes) {
    throw new GitHubAppError('TASKPACK_MANIFEST_INVALID', `${diagPath}: file exceeds maximum ${maxBytes} bytes`, diagPath);
  }

  const noFollow = 'O_NOFOLLOW' in fsConstants ? fsConstants.O_NOFOLLOW : 0;
  let handle;
  try {
    handle = await open(fullPath, fsConstants.O_RDONLY | noFollow);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | null)?.code;
    if (code === 'ELOOP') {
      throw new GitHubAppError('TASKPACK_SCOPE_VIOLATION', `${diagPath}: symbolic link detected while opening file`, diagPath);
    }
    throw new GitHubAppError('TASKPACK_MANIFEST_INVALID', `${diagPath}: file could not be opened`, diagPath);
  }

  try {
    const info = await handle.stat();
    if (requireSingleLink && info.nlink !== 1) {
      throw new GitHubAppError(
        'TASKPACK_SCOPE_VIOLATION',
        `${diagPath}: hardlinked file (nlink=${info.nlink}) detected while reading`,
        diagPath,
      );
    }
    if (!info.isFile() || info.size !== before.size || info.size > maxBytes) {
      throw new GitHubAppError('TASKPACK_MANIFEST_INVALID', `${diagPath}: file changed while reading or exceeds ${maxBytes} bytes`, diagPath);
    }
    const buf = Buffer.alloc(info.size + 1);
    let offset = 0;
    while (offset < buf.length) {
      const { bytesRead } = await handle.read(buf, offset, buf.length - offset, offset);
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    if (offset !== info.size) {
      throw new GitHubAppError('TASKPACK_MANIFEST_INVALID', `${diagPath}: file changed size while reading`, diagPath);
    }
    return buf.subarray(0, offset);
  } finally {
    await handle.close();
  }
}

async function resolveNoSymlinkFileInRoot(
  rootResolved: string,
  rootReal: string,
  relPath: string,
  diagPath: string,
): Promise<{ readonly exists: true; readonly fullPath: string; readonly normalizedRel: string } | { readonly exists: false }> {
  const normalizedRel = normalizeRelativePath(relPath, diagPath);
  const segments = normalizedRel.split('/');
  let cursor = rootResolved;
  for (const segment of segments) {
    cursor = join(cursor, segment);
    let st;
    try {
      st = await lstat(cursor);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException | null)?.code;
      if (code === 'ENOENT' || code === 'ENOTDIR') {
        return { exists: false };
      }
      if (code === 'ELOOP') {
        throw new GitHubAppError('TASKPACK_SCOPE_VIOLATION', `${diagPath}: path "${normalizedRel}" traverses a symbolic link`, diagPath);
      }
      const detail = error instanceof Error ? error.message : String(error);
      throw new GitHubAppError('TASKPACK_MANIFEST_INVALID', `${diagPath}: failed to inspect path "${normalizedRel}": ${detail}`, diagPath);
    }
    if (st.isSymbolicLink()) {
      throw new GitHubAppError('TASKPACK_SCOPE_VIOLATION', `${diagPath}: path "${normalizedRel}" traverses or targets a symbolic link`, diagPath);
    }
  }
  const realFull = await realpath(cursor).catch(() => {
    throw new GitHubAppError('TASKPACK_MANIFEST_INVALID', `${diagPath}: path "${normalizedRel}" cannot be resolved`, diagPath);
  });
  if (!isContainedInRoot(realFull, rootReal)) {
    throw new GitHubAppError('TASKPACK_SCOPE_VIOLATION', `${diagPath}: path "${normalizedRel}" escapes root`, diagPath);
  }
  return { exists: true, fullPath: cursor, normalizedRel };
}

async function resolveStagedResourceSource(
  rawPath: string,
  repoRoot: { readonly resolved: string; readonly real: string },
  stagingRoot: { readonly resolved: string; readonly real: string },
  diagPath: string,
): Promise<{ readonly fullPath: string; readonly relativePath: string; readonly sourceRoot: 'staging' | 'repo' }> {
  if (typeof rawPath !== 'string' || rawPath.length === 0 || rawPath.length > 1024 || /[\0\r\n\\]/.test(rawPath)) {
    throw new GitHubAppError('TASKPACK_MANIFEST_INVALID', `${diagPath}: staged resource path is invalid`, diagPath);
  }
  if (rawPath.split('/').some(seg => seg === '..')) {
    throw new GitHubAppError('TASKPACK_SCOPE_VIOLATION', `${diagPath}: staged resource path "${rawPath}" must not traverse parent directories`, diagPath);
  }

  if (isAbsolute(rawPath)) {
    const candidateResolved = resolve(rawPath);
    const tryRoot = async (
      root: { readonly resolved: string; readonly real: string },
      sourceRoot: 'staging' | 'repo',
    ): Promise<{ readonly fullPath: string; readonly relativePath: string; readonly sourceRoot: 'staging' | 'repo' } | null> => {
      const base = isContainedInRoot(candidateResolved, root.real)
        ? root.real
        : isContainedInRoot(candidateResolved, root.resolved)
          ? root.resolved
          : null;
      if (base === null) return null;
      const rel = relative(base, candidateResolved);
      if (rel.length === 0 || rel.startsWith('..') || isAbsolute(rel)) return null;
      const posixRel = rel.split(sep).join('/');
      const found = await resolveNoSymlinkFileInRoot(root.resolved, root.real, posixRel, diagPath);
      if (!found.exists) {
        throw new GitHubAppError('TASKPACK_MANIFEST_INVALID', `${diagPath}: staged resource "${rawPath}" does not exist`, diagPath);
      }
      return { fullPath: found.fullPath, relativePath: found.normalizedRel, sourceRoot };
    };

    const inStaging = await tryRoot(stagingRoot, 'staging');
    if (inStaging !== null) return inStaging;
    const inRepo = await tryRoot(repoRoot, 'repo');
    if (inRepo !== null) return inRepo;
    throw new GitHubAppError('TASKPACK_SCOPE_VIOLATION', `${diagPath}: absolute staged resource path "${rawPath}" escapes allowed roots`, diagPath);
  }

  const normalizedRel = normalizeRelativePath(rawPath, diagPath);
  const inStaging = await resolveNoSymlinkFileInRoot(stagingRoot.resolved, stagingRoot.real, normalizedRel, diagPath);
  if (inStaging.exists) {
    return { fullPath: inStaging.fullPath, relativePath: inStaging.normalizedRel, sourceRoot: 'staging' };
  }
  const inRepo = await resolveNoSymlinkFileInRoot(repoRoot.resolved, repoRoot.real, normalizedRel, diagPath);
  if (inRepo.exists) {
    return { fullPath: inRepo.fullPath, relativePath: inRepo.normalizedRel, sourceRoot: 'repo' };
  }
  throw new GitHubAppError('TASKPACK_MANIFEST_INVALID', `${diagPath}: staged resource "${normalizedRel}" not found in staging directory or repository root`, diagPath);
}

function hasWorkspacePathPrefixCollision(
  candidateRel: string,
  existingRelPaths: ReadonlySet<string>,
): string | null {
  for (const existing of existingRelPaths) {
    if (
      existing === candidateRel
      || candidateRel.startsWith(`${existing}/`)
      || existing.startsWith(`${candidateRel}/`)
    ) {
      return existing;
    }
  }
  return null;
}

async function writeReadOnlyStagedFile(
  rootDir: string,
  relativePath: string,
  bytes: Buffer,
  diagPath: string,
): Promise<string> {
  const destPath = join(rootDir, ...relativePath.split('/'));
  const noFollow = 'O_NOFOLLOW' in fsConstants ? fsConstants.O_NOFOLLOW : 0;
  try {
    await mkdir(dirname(destPath), { recursive: true, mode: 0o700 });
    const outHandle = await open(
      destPath,
      fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | noFollow,
      0o444,
    );
    try {
      await outHandle.writeFile(bytes);
    } finally {
      await outHandle.close();
    }
    await chmod(destPath, 0o444);
    return destPath;
  } catch (error) {
    if (error instanceof GitHubAppError) throw error;
    const detail = error instanceof Error ? error.message : String(error);
    throw new GitHubAppError(
      'TASKPACK_MANIFEST_INVALID',
      `${diagPath}: failed to stage workspace resource "${relativePath}": ${detail}`,
      diagPath,
    );
  }
}

async function chmodTreeReadOnly(dirPath: string): Promise<void> {
  const entries = await readdir(dirPath, { withFileTypes: true });
  for (const entry of entries) {
    const child = join(dirPath, entry.name);
    if (entry.isDirectory()) {
      await chmodTreeReadOnly(child);
    } else if (entry.isFile()) {
      await chmod(child, 0o444);
    }
  }
  await chmod(dirPath, 0o555);
}

/**
 * Restore directory write/execute bits (`0o700`) prior to recursive removal without ever
 * calling `chmod` on regular files (preventing permission mutation of hardlinked inodes).
 */
async function makeWritableAndRemoveTree(dirPath: string): Promise<void> {
  const restoreDirs = async (target: string): Promise<void> => {
    const st = await lstat(target).catch(() => null);
    if (st === null || !st.isDirectory()) return;
    await chmod(target, 0o700).catch(() => undefined);
    const entries = await readdir(target, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      await restoreDirs(join(target, entry.name));
    }
  };
  await restoreDirs(dirPath);
  await rm(dirPath, { recursive: true, force: true });
}

interface ParsedStagedResourceDecl {
  readonly id: string;
  readonly kind: PreflightStagedResourceKind;
  readonly path: string;
  readonly mount: PreflightStagedResourceMount;
  readonly exposeToChecks: boolean;
}

interface ParsedPreflightOutput {
  readonly disposition: PreflightDisposition;
  readonly reason: string | null;
  readonly upstreams: readonly UpstreamAcquisitionRecord[];
  readonly stagedResources: readonly ParsedStagedResourceDecl[];
}

function scrubJsonValue(value: Json, scrub: (text: string) => string, depth = 0): Json {
  if (depth > PREFLIGHT_OUTPUT_MAX_DEPTH) return value;
  if (typeof value === 'string') return scrub(value);
  if (Array.isArray(value)) return value.map(item => scrubJsonValue(item, scrub, depth + 1));
  if (value !== null && typeof value === 'object') {
    const out: Record<string, Json> = Object.create(null) as Record<string, Json>;
    for (const [k, v] of Object.entries(value)) {
      if (FORBIDDEN_OBJECT_KEYS.has(k)) continue;
      const scrubbedKey = scrub(k);
      if (FORBIDDEN_OBJECT_KEYS.has(scrubbedKey)) continue;
      out[scrubbedKey] = scrubJsonValue(v, scrub, depth + 1);
    }
    return Object.freeze(out);
  }
  return value;
}

function parsePreflightOutputDocument(
  rawJson: Json,
  scrub: (text: string) => string,
): ParsedPreflightOutput {
  if (!isPlainRecord(rawJson)) {
    throw new GitHubAppError('TASKPACK_MANIFEST_INVALID', 'preflight output must be a JSON object', '/preflight');
  }
  const allowedTopKeys = new Set(['disposition', 'reason', 'upstreams', 'stagedResources']);
  for (const key of Object.keys(rawJson)) {
    if (FORBIDDEN_OBJECT_KEYS.has(key) || !allowedTopKeys.has(key)) {
      throw new GitHubAppError('TASKPACK_MANIFEST_INVALID', `unknown preflight output field "${key}"`, `/preflight/${key}`);
    }
  }

  const rawDisp = rawJson['disposition'];
  if (typeof rawDisp !== 'string' || !ALLOWED_DISPOSITIONS.has(rawDisp)) {
    throw new GitHubAppError(
      'TASKPACK_MANIFEST_INVALID',
      'preflight output disposition must be "candidate", "no_change", or "blocked"',
      '/preflight/disposition',
    );
  }
  const disposition = rawDisp as PreflightDisposition;

  let reason: string | null = null;
  if (rawJson['reason'] !== undefined && rawJson['reason'] !== null) {
    if (typeof rawJson['reason'] !== 'string' || rawJson['reason'].length > 4096) {
      throw new GitHubAppError('TASKPACK_MANIFEST_INVALID', 'preflight output reason must be a string of at most 4096 characters', '/preflight/reason');
    }
    reason = scrub(rawJson['reason']);
  }

  const upstreams: UpstreamAcquisitionRecord[] = [];
  if (rawJson['upstreams'] !== undefined) {
    const rawUpstreams = rawJson['upstreams'];
    if (!Array.isArray(rawUpstreams) || rawUpstreams.length > PREFLIGHT_MAX_UPSTREAMS) {
      throw new GitHubAppError(
        'TASKPACK_MANIFEST_INVALID',
        `preflight output upstreams must be an array of 0..${PREFLIGHT_MAX_UPSTREAMS} items`,
        '/preflight/upstreams',
      );
    }
    const seenIds = new Set<string>();
    const allowedUpstreamKeys = new Set(['id', 'status', 'version', 'currentVersion', 'reason', 'metadata']);
    for (const [idx, item] of rawUpstreams.entries()) {
      const itemPath = `/preflight/upstreams/${idx}`;
      if (!isPlainRecord(item)) {
        throw new GitHubAppError('TASKPACK_MANIFEST_INVALID', 'preflight upstream entry must be an object', itemPath);
      }
      for (const key of Object.keys(item)) {
        if (FORBIDDEN_OBJECT_KEYS.has(key) || !allowedUpstreamKeys.has(key)) {
          throw new GitHubAppError('TASKPACK_MANIFEST_INVALID', `unknown preflight upstream field "${key}"`, `${itemPath}/${key}`);
        }
      }
      const id = item['id'];
      if (typeof id !== 'string' || id.trim().length === 0 || id.length > 128 || /[\0\r\n]/.test(id)) {
        throw new GitHubAppError('TASKPACK_MANIFEST_INVALID', 'preflight upstream id must be a non-empty string (1..128 chars)', `${itemPath}/id`);
      }
      if (seenIds.has(id)) {
        throw new GitHubAppError('TASKPACK_MANIFEST_INVALID', `duplicate preflight upstream id "${id}"`, `${itemPath}/id`);
      }
      seenIds.add(id);

      const status = item['status'];
      if (typeof status !== 'string' || !ALLOWED_UPSTREAM_STATUSES.has(status)) {
        throw new GitHubAppError('TASKPACK_MANIFEST_INVALID', 'preflight upstream status is invalid', `${itemPath}/status`);
      }

      const rawVersion = item['version'];
      if (rawVersion !== undefined && (typeof rawVersion !== 'string' || rawVersion.trim().length === 0 || rawVersion.length > 256 || /[\0\r\n]/.test(rawVersion))) {
        throw new GitHubAppError('TASKPACK_MANIFEST_INVALID', 'preflight upstream version must be a non-empty string (1..256 chars)', `${itemPath}/version`);
      }

      const rawCurrent = item['currentVersion'];
      if (rawCurrent !== undefined && (typeof rawCurrent !== 'string' || rawCurrent.trim().length === 0 || rawCurrent.length > 256 || /[\0\r\n]/.test(rawCurrent))) {
        throw new GitHubAppError('TASKPACK_MANIFEST_INVALID', 'preflight upstream currentVersion must be a non-empty string (1..256 chars)', `${itemPath}/currentVersion`);
      }

      const rawReason = item['reason'];
      if (rawReason !== undefined && (typeof rawReason !== 'string' || rawReason.length > 2048)) {
        throw new GitHubAppError('TASKPACK_MANIFEST_INVALID', 'preflight upstream reason must be a string (<= 2048 chars)', `${itemPath}/reason`);
      }

      let metadata: Readonly<Record<string, Json>> | undefined;
      if (item['metadata'] !== undefined) {
        if (!isPlainRecord(item['metadata'])) {
          throw new GitHubAppError('TASKPACK_MANIFEST_INVALID', 'preflight upstream metadata must be a plain object', `${itemPath}/metadata`);
        }
        const entries = Object.entries(item['metadata']);
        if (entries.length > PREFLIGHT_MAX_METADATA_KEYS) {
          throw new GitHubAppError('TASKPACK_MANIFEST_INVALID', `preflight upstream metadata exceeds ${PREFLIGHT_MAX_METADATA_KEYS} entries`, `${itemPath}/metadata`);
        }
        const cleaned = scrubJsonValue(item['metadata'] as Json, scrub, 0) as Record<string, Json>;
        if (Buffer.byteLength(JSON.stringify(cleaned), 'utf8') > PREFLIGHT_MAX_METADATA_BYTES) {
          throw new GitHubAppError('TASKPACK_MANIFEST_INVALID', `preflight upstream metadata exceeds ${PREFLIGHT_MAX_METADATA_BYTES} bytes`, `${itemPath}/metadata`);
        }
        metadata = cleaned;
      }

      const typedStatus = status as UpstreamAcquisitionStatus;
      const normalizedVersions = normalizeHeldBackVersions(typedStatus, rawVersion, rawCurrent, undefined);

      upstreams.push(Object.freeze({
        upstreamId: id,
        status: typedStatus,
        ...(normalizedVersions.version !== undefined ? { version: normalizedVersions.version } : {}),
        ...(rawCurrent !== undefined ? { currentVersion: rawCurrent } : {}),
        ...(normalizedVersions.targetVersion !== undefined ? { targetVersion: normalizedVersions.targetVersion } : {}),
        ...(rawReason !== undefined ? { reason: scrub(rawReason) } : {}),
        ...(metadata !== undefined ? { metadata } : {}),
      }));
    }
  }

  const stagedResources: ParsedStagedResourceDecl[] = [];
  if (rawJson['stagedResources'] !== undefined) {
    const rawStaged = rawJson['stagedResources'];
    if (!Array.isArray(rawStaged) || rawStaged.length > PREFLIGHT_MAX_STAGED_RESOURCES) {
      throw new GitHubAppError(
        'TASKPACK_MANIFEST_INVALID',
        `preflight output stagedResources must be an array of 0..${PREFLIGHT_MAX_STAGED_RESOURCES} items`,
        '/preflight/stagedResources',
      );
    }
    const seenIds = new Set<string>();
    const allowedStagedKeys = new Set(['id', 'kind', 'path', 'mount', 'exposeToChecks']);
    for (const [idx, item] of rawStaged.entries()) {
      const itemPath = `/preflight/stagedResources/${idx}`;
      if (!isPlainRecord(item)) {
        throw new GitHubAppError('TASKPACK_MANIFEST_INVALID', 'preflight stagedResource entry must be an object', itemPath);
      }
      for (const key of Object.keys(item)) {
        if (FORBIDDEN_OBJECT_KEYS.has(key) || !allowedStagedKeys.has(key)) {
          throw new GitHubAppError('TASKPACK_MANIFEST_INVALID', `unknown stagedResource field "${key}"`, `${itemPath}/${key}`);
        }
      }
      const id = item['id'];
      if (typeof id !== 'string' || !IDENTIFIER_PATTERN.test(id)) {
        throw new GitHubAppError('TASKPACK_MANIFEST_INVALID', 'stagedResource id must be a valid identifier', `${itemPath}/id`);
      }
      if (seenIds.has(id)) {
        throw new GitHubAppError('TASKPACK_MANIFEST_INVALID', `duplicate stagedResource id "${id}"`, `${itemPath}/id`);
      }
      seenIds.add(id);

      const kindRaw = item['kind'];
      if (typeof kindRaw !== 'string' || !ALLOWED_STAGED_KINDS.has(kindRaw)) {
        throw new GitHubAppError('TASKPACK_MANIFEST_INVALID', 'stagedResource kind must be "instruction", "skill", or "document"', `${itemPath}/kind`);
      }
      const kind = kindRaw as PreflightStagedResourceKind;

      const pathVal = item['path'];
      if (typeof pathVal !== 'string' || pathVal.length === 0 || pathVal.length > 1024 || /[\0\r\n]/.test(pathVal)) {
        throw new GitHubAppError('TASKPACK_MANIFEST_INVALID', 'stagedResource path must be a non-empty string (1..1024 chars)', `${itemPath}/path`);
      }

      let mount: PreflightStagedResourceMount;
      if (item['mount'] === undefined) {
        mount = kind === 'document' ? 'workspace' : 'prompt';
      } else if (typeof item['mount'] === 'string' && ALLOWED_STAGED_MOUNTS.has(item['mount'])) {
        mount = item['mount'] as PreflightStagedResourceMount;
      } else {
        throw new GitHubAppError('TASKPACK_MANIFEST_INVALID', 'stagedResource mount must be "prompt" or "workspace"', `${itemPath}/mount`);
      }

      let exposeToChecks = false;
      if (item['exposeToChecks'] !== undefined) {
        if (typeof item['exposeToChecks'] !== 'boolean') {
          throw new GitHubAppError('TASKPACK_MANIFEST_INVALID', 'stagedResource exposeToChecks must be a boolean', `${itemPath}/exposeToChecks`);
        }
        exposeToChecks = item['exposeToChecks'];
      }

      stagedResources.push(Object.freeze({
        id,
        kind,
        path: pathVal,
        mount,
        exposeToChecks,
      }));
    }
  }

  return {
    disposition,
    reason,
    upstreams: Object.freeze(upstreams),
    stagedResources: Object.freeze(stagedResources),
  };
}

function resolveScriptInvocation(
  scriptFullPath: string,
  fileMode: number,
): { readonly command: string; readonly args: readonly string[] } {
  const lower = scriptFullPath.toLowerCase();
  if (lower.endsWith('.mjs') || lower.endsWith('.js') || lower.endsWith('.cjs')) {
    return { command: process.execPath, args: [scriptFullPath] };
  }
  if ((fileMode & 0o111) !== 0) {
    return { command: scriptFullPath, args: [] };
  }
  return { command: '/bin/sh', args: [scriptFullPath] };
}

/**
 * Format a compact path-and-SHA256 manifest summary of workspace-mounted staged resources
 * suitable for agent prompts without ever reading or concatenating file contents.
 */
export function formatWorkspaceResourcesManifest(
  resources: readonly PreflightWorkspaceResource[],
  stagedRootDir?: string | null,
  scrubber?: SecretScrubber,
): string {
  if (resources.length === 0) return 'workspaceResources: none';
  const normalizedRoot = typeof stagedRootDir === 'string' && stagedRootDir.trim().length > 0
    ? resolve(stagedRootDir)
    : null;
  const scrub = scrubber !== undefined ? (text: string) => scrubber.scrub(text) : (text: string) => text;
  return resources
    .map(res => {
      const readOnlyPointer = normalizedRoot !== null
        ? ` readOnlyPath=${scrub(join(normalizedRoot, ...res.relativePath.split('/')))}`
        : '';
      return `- ${res.id} (${res.kind}): path=${scrub(res.relativePath)}${readOnlyPointer} bytes=${res.byteLength} sha256=${res.sha256} exposeToChecks=${String(res.exposeToChecks)}`;
    })
    .join('\n');
}

/**
 * Execute a manifest-declared `spec.preflight` script on the host with fail-closed preconditions:
 * - Requires explicit `authorized: true` and `SecretScrubber` setup before touching files or spawning.
 * - Enforces dual-key execution authority via `validateExecutionAuthority` and `pinDigests` lockfile verification.
 * - Resolves `spec.preflight.script` strictly inside `repositoryRoot` (no symlinks) and records its SHA-256 digest.
 * - Strips all forbidden GitHub, Loopwright, CI/loader, manifest-declared, and provider credentials regardless of
 *   `allowHostEnv` or `spec.preflight.env`.
 * - Enforces `nlink === 1` on `LOOPWRIGHT_PREFLIGHT_OUT` and `LOOPWRIGHT_STAGING_DIR` resources, parses output
 *   strictly, and partitions `stagedResources` into UTF-8 `promptResources` (scrub-verified) versus binary-safe
 *   read-only disk `workspaceResources` (`stagedDir` and `checkStagedDir`).
 */
export async function runTaskpackPreflight(
  options: RunTaskpackPreflightOptions,
): Promise<RunTaskpackPreflightResult> {
  if (options.authorized !== true) {
    throw new GitHubAppError(
      'WEBHOOK_ACTOR_UNAUTHORIZED',
      'spec.preflight refuses to execute without prior actor authorization (authorized: true)',
      '/spec/preflight',
    );
  }
  if (!(options.scrubber instanceof SecretScrubber)) {
    throw new GitHubAppError(
      'TASKPACK_HOST_BINDING_INVALID',
      'spec.preflight requires an initialized SecretScrubber instance',
      '/spec/preflight',
    );
  }

  validateExecutionAuthority(options.manifest.spec.execution, options.hostPolicy);

  const preflightDecl = options.manifest.spec.preflight;
  if (preflightDecl === undefined) {
    throw new GitHubAppError('TASKPACK_MANIFEST_INVALID', 'manifest does not declare spec.preflight', '/spec/preflight');
  }

  if (preflightDecl.timeoutSeconds !== undefined) {
    if (
      typeof preflightDecl.timeoutSeconds !== 'number'
      || !Number.isSafeInteger(preflightDecl.timeoutSeconds)
      || preflightDecl.timeoutSeconds < 1
      || preflightDecl.timeoutSeconds > PREFLIGHT_MAX_TIMEOUT_SECONDS
    ) {
      throw new GitHubAppError(
        'TASKPACK_MANIFEST_INVALID',
        `spec.preflight.timeoutSeconds must be an integer within 1..${PREFLIGHT_MAX_TIMEOUT_SECONDS}`,
        '/spec/preflight/timeoutSeconds',
      );
    }
  }
  const declaredTimeoutSec = preflightDecl.timeoutSeconds ?? PREFLIGHT_DEFAULT_TIMEOUT_SECONDS;
  const timeoutMs = options.timeoutMs !== undefined
    ? options.timeoutMs
    : declaredTimeoutSec * 1000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > PREFLIGHT_MAX_TIMEOUT_SECONDS * 1000) {
    throw new GitHubAppError(
      'ACTION_INPUT_INVALID',
      `preflight timeoutMs must be within 1..${PREFLIGHT_MAX_TIMEOUT_SECONDS * 1000}`,
      '/spec/preflight/timeoutSeconds',
    );
  }

  const scriptRelPath = normalizeRelativePath(preflightDecl.script, '/spec/preflight/script');
  const repoRoot = await resolveSafeDirectory(options.repositoryRoot, 'repositoryRoot');

  if (options.manifest.spec.execution?.digests.pinDigests === true) {
    await assertDigestLockfileVerified(options.repositoryRoot, options.manifest);
  }

  const scriptLookup = await resolveNoSymlinkFileInRoot(
    repoRoot.resolved,
    repoRoot.real,
    scriptRelPath,
    '/spec/preflight/script',
  );
  if (!scriptLookup.exists) {
    throw new GitHubAppError(
      'TASKPACK_MANIFEST_INVALID',
      `preflight script "${scriptRelPath}" does not exist inside repository root`,
      '/spec/preflight/script',
    );
  }
  const scriptStat = await lstat(scriptLookup.fullPath);
  if (scriptStat.isSymbolicLink()) {
    throw new GitHubAppError('TASKPACK_SCOPE_VIOLATION', `preflight script "${scriptRelPath}" must not be a symbolic link`, '/spec/preflight/script');
  }
  if (!scriptStat.isFile()) {
    throw new GitHubAppError('TASKPACK_MANIFEST_INVALID', `preflight script "${scriptRelPath}" must be a regular file`, '/spec/preflight/script');
  }
  const scriptSha256 = await computeFileDigest(options.repositoryRoot, scriptRelPath);

  let baseTemp: string;
  if (options.tempRoot !== undefined) {
    const resolvedTemp = await resolveSafeDirectory(options.tempRoot, 'tempRoot', 'ACTION_INPUT_INVALID');
    baseTemp = resolvedTemp.real;
  } else {
    baseTemp = tmpdir();
  }

  let workDir: string;
  try {
    workDir = await mkdtemp(join(baseTemp, 'loopwright-preflight-'));
    await chmod(workDir, 0o700);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new GitHubAppError('ACTION_INPUT_INVALID', `failed to create preflight work directory: ${detail}`, '/spec/preflight');
  }

  let stagedDir: string | null = null;
  let checkStagedDir: string | null = null;
  let keepStagedDirs = false;

  try {
    const scratchHome = join(workDir, 'home');
    const scratchTmp = join(workDir, 'tmp');
    const stagingInputDir = join(workDir, 'staging-input');
    const outputJsonPath = join(workDir, 'preflight-out.json');
    await mkdir(scratchHome, { mode: 0o700 });
    await mkdir(scratchTmp, { mode: 0o700 });
    await mkdir(stagingInputDir, { mode: 0o700 });
    const stagingRoot = await resolveSafeDirectory(stagingInputDir, 'preflight staging directory');

    const manifestSecretEnvNames = collectManifestSecretEnvNames(options.manifest);
    const hostEnv = options.env ?? process.env;
    const strippedScrubber = new SecretScrubber();
    for (const [key, val] of Object.entries(hostEnv)) {
      if (typeof val === 'string' && val.length > 0 && isForbiddenPreflightEnvName(key, manifestSecretEnvNames)) {
        strippedScrubber.register(val);
      }
    }
    for (const val of Object.values(options.brokeredEnv ?? {})) {
      if (typeof val === 'string' && val.length > 0) {
        strippedScrubber.register(val);
      }
    }
    const scrubText = (text: string): string => strippedScrubber.scrub(options.scrubber.scrub(text));

    const caps = options.manifest.spec.execution?.capabilities;
    const allowHostEnv = caps?.allowHostEnv === true;
    const allowHostPath = caps?.allowHostPath === true;

    const childEnv: Record<string, string> = {};
    if (allowHostEnv) {
      for (const [key, val] of Object.entries(hostEnv)) {
        if (typeof val !== 'string') continue;
        if (isForbiddenPreflightEnvName(key, manifestSecretEnvNames)) continue;
        childEnv[key] = val;
      }
      if (!allowHostPath) {
        childEnv['PATH'] = PREFLIGHT_SAFE_DEFAULT_PATH;
      } else if (typeof childEnv['PATH'] !== 'string') {
        childEnv['PATH'] = PREFLIGHT_SAFE_DEFAULT_PATH;
      }
      if (typeof childEnv['HOME'] !== 'string') childEnv['HOME'] = scratchHome;
      if (typeof childEnv['TMPDIR'] !== 'string') childEnv['TMPDIR'] = scratchTmp;
    } else {
      childEnv['PATH'] = allowHostPath && typeof hostEnv['PATH'] === 'string'
        ? hostEnv['PATH']
        : PREFLIGHT_SAFE_DEFAULT_PATH;
      childEnv['HOME'] = scratchHome;
      childEnv['TMPDIR'] = scratchTmp;
      childEnv['LANG'] = 'C.UTF-8';
      childEnv['LC_ALL'] = 'C.UTF-8';
      for (const envName of preflightDecl.env ?? []) {
        if (isForbiddenPreflightEnvName(envName, manifestSecretEnvNames)) {
          continue;
        }
        const val = hostEnv[envName];
        if (typeof val === 'string') {
          childEnv[envName] = val;
        }
      }
    }

    if (options.brokeredEnv !== undefined) {
      for (const [key, val] of Object.entries(options.brokeredEnv)) {
        if (RESERVED_PREFLIGHT_INJECTED_VARS.has(key.toUpperCase())) continue;
        childEnv[key] = val;
      }
    }

    childEnv['LOOPWRIGHT_PREFLIGHT_OUT'] = outputJsonPath;
    childEnv['LOOPWRIGHT_REPO_ROOT'] = repoRoot.real;
    childEnv['LOOPWRIGHT_STAGING_DIR'] = stagingRoot.real;

    const invocation = resolveScriptInvocation(scriptLookup.fullPath, scriptStat.mode);
    const startMs = Date.now();

    const execResult = await new Promise<{
      readonly exitCode: number | null;
      readonly signal: NodeJS.Signals | null;
      readonly timedOut: boolean;
      readonly aborted: boolean;
      readonly stdout: string;
      readonly stderr: string;
    }>((resolvePromise, rejectPromise) => {
      if (options.signal?.aborted) {
        rejectPromise(new GitHubAppError('SANDBOX_EXECUTION_FAILED', 'preflight execution aborted before start', '/spec/preflight'));
        return;
      }
      const child = spawn(invocation.command, [...invocation.args], {
        cwd: repoRoot.real,
        env: childEnv,
        detached: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      const stdoutBuf = new BoundedStreamBuffer(PREFLIGHT_MAX_STDIO_BYTES);
      const stderrBuf = new BoundedStreamBuffer(PREFLIGHT_MAX_STDIO_BYTES);
      let timedOut = false;
      let aborted = false;
      let settled = false;
      let exitCode: number | null = null;
      let exitSignal: NodeJS.Signals | null = null;
      let drainTimer: ReturnType<typeof setTimeout> | undefined;

      const killTree = (): void => {
        if (child.pid !== undefined) {
          try {
            process.kill(-child.pid, 'SIGKILL');
            return;
          } catch {
            // Fall through to direct kill.
          }
        }
        try {
          child.kill('SIGKILL');
        } catch {
          // Child already exited.
        }
      };

      const destroyStreams = (): void => {
        child.stdout.destroy();
        child.stderr.destroy();
      };

      const cleanupListeners = (): void => {
        clearTimeout(timer);
        if (drainTimer !== undefined) {
          clearTimeout(drainTimer);
          drainTimer = undefined;
        }
        options.signal?.removeEventListener('abort', onAbort);
      };

      const finish = (code: number | null, sig: NodeJS.Signals | null): void => {
        if (settled) return;
        settled = true;
        killTree();
        cleanupListeners();
        resolvePromise({
          exitCode: code,
          signal: sig,
          timedOut,
          aborted,
          stdout: scrubText(stdoutBuf.toString()),
          stderr: scrubText(stderrBuf.toString()),
        });
      };

      const armDrainDestroy = (): void => {
        if (drainTimer !== undefined) return;
        drainTimer = setTimeout(() => {
          destroyStreams();
          finish(exitCode, exitSignal);
        }, STDIO_DRAIN_GRACE_MS);
        drainTimer.unref?.();
      };

      const onAbort = (): void => {
        aborted = true;
        killTree();
        armDrainDestroy();
      };
      options.signal?.addEventListener('abort', onAbort, { once: true });

      const timer = setTimeout(() => {
        timedOut = true;
        killTree();
        armDrainDestroy();
      }, timeoutMs);
      timer.unref?.();

      child.stdout.on('data', (chunk: Buffer) => stdoutBuf.append(chunk));
      child.stderr.on('data', (chunk: Buffer) => stderrBuf.append(chunk));

      child.on('error', err => {
        if (settled) return;
        settled = true;
        killTree();
        cleanupListeners();
        rejectPromise(new GitHubAppError(
          'SANDBOX_EXECUTION_FAILED',
          `preflight script failed to spawn: ${scrubText(err.message)}`,
          '/spec/preflight',
        ));
      });

      child.on('exit', (code, sig) => {
        exitCode = code;
        exitSignal = sig;
        // Reap any lingering processes in the child's process group before reading output/staging files.
        killTree();
        armDrainDestroy();
      });

      child.on('close', (code, sig) => finish(code, sig));
    });

    const durationMs = Math.max(0, Date.now() - startMs);

    if (execResult.aborted || options.signal?.aborted) {
      throw new GitHubAppError('SANDBOX_EXECUTION_FAILED', 'preflight script execution aborted', '/spec/preflight');
    }

    if (execResult.timedOut) {
      const detail = execResult.stderr.trim() || execResult.stdout.trim();
      throw new GitHubAppError(
        'SANDBOX_EXECUTION_FAILED',
        `preflight script timed out after ${timeoutMs}ms${detail.length > 0 ? `: ${detail}` : ''}`,
        '/spec/preflight',
      );
    }

    if (execResult.exitCode !== 0) {
      const detail = execResult.stderr.trim() || execResult.stdout.trim();
      throw new GitHubAppError(
        'SANDBOX_EXECUTION_FAILED',
        `preflight script exited with status ${String(execResult.exitCode)}${execResult.signal ? ` (signal ${execResult.signal})` : ''}${detail.length > 0 ? `: ${detail}` : ''}`,
        '/spec/preflight',
      );
    }

    const outBytes = await openAndReadNoFollowBoundedFile(
      outputJsonPath,
      PREFLIGHT_MAX_OUTPUT_JSON_BYTES,
      '/preflight/output',
      { requireSingleLink: true },
    );
    if (outBytes.includes(0)) {
      throw new GitHubAppError('TASKPACK_MANIFEST_INVALID', 'preflight output JSON must not contain NUL bytes', '/preflight/output');
    }
    let outText: string;
    try {
      outText = new TextDecoder('utf-8', { fatal: true }).decode(outBytes);
    } catch {
      throw new GitHubAppError('TASKPACK_MANIFEST_INVALID', 'preflight output JSON is not valid UTF-8', '/preflight/output');
    }
    const parsedJson = parseJsonSubset(outText, {
      maxNodes: 8_192,
      maxDepth: PREFLIGHT_OUTPUT_MAX_DEPTH,
      maxCollection: 256,
      maxString: 32_768,
      diagPath: '/preflight',
    });
    const parsedOutput = parsePreflightOutputDocument(parsedJson, scrubText);

    // Enrich upstreams with manifest watchedPaths, load repository baselines when groups exist, and apply lockstep upstreamGroups.
    const enrichedUpstreams = attachUpstreamContext(parsedOutput.upstreams, options.manifest.spec.upstreams);
    const repoBaselines = options.manifest.spec.upstreamGroups !== undefined && options.manifest.spec.upstreamGroups.length > 0
      ? await loadRepositoryBaselineVersions(options.manifest, options.repositoryRoot)
      : undefined;
    const hadAvailableBeforeGroups = enrichedUpstreams.some(record => record.status === 'available');
    const groupedUpstreams = applyUpstreamGroups(enrichedUpstreams, options.manifest.spec.upstreamGroups, repoBaselines);
    const hasAvailableAfterGroups = groupedUpstreams.some(record => record.status === 'available');

    let effectiveDisposition: PreflightDisposition = parsedOutput.disposition;
    let effectiveReason: string | null = parsedOutput.reason;
    if (effectiveDisposition === 'candidate' && hadAvailableBeforeGroups && !hasAvailableAfterGroups) {
      const reevaluated = evaluateUpstreamIntakeDisposition(groupedUpstreams);
      effectiveDisposition = reevaluated.disposition;
      effectiveReason = reevaluated.reason;
    }

    const promptResources: PreflightPromptResource[] = [];
    const workspaceResources: PreflightWorkspaceResource[] = [];
    let promptTotalBytes = 0;
    let workspaceTotalBytes = 0;
    const seenWorkspaceRelPaths = new Set<string>();

    for (const [idx, decl] of parsedOutput.stagedResources.entries()) {
      if (options.signal?.aborted) {
        throw new GitHubAppError('SANDBOX_EXECUTION_FAILED', 'preflight script execution aborted during resource staging', '/spec/preflight');
      }
      const diagPath = `/preflight/stagedResources/${idx}`;
      const resolvedSrc = await resolveStagedResourceSource(decl.path, repoRoot, stagingRoot, diagPath);
      const requireSingleLink = resolvedSrc.sourceRoot === 'staging';

      if (decl.mount === 'prompt') {
        const bytes = await openAndReadNoFollowBoundedFile(
          resolvedSrc.fullPath,
          PREFLIGHT_MAX_PROMPT_RESOURCE_BYTES,
          diagPath,
          { requireSingleLink },
        );
        promptTotalBytes += bytes.byteLength;
        if (promptTotalBytes > PREFLIGHT_MAX_PROMPT_RESOURCES_TOTAL_BYTES) {
          throw new GitHubAppError(
            'TASKPACK_MANIFEST_INVALID',
            `${diagPath}: aggregate prompt-mounted staged resources exceed ${PREFLIGHT_MAX_PROMPT_RESOURCES_TOTAL_BYTES} bytes`,
            diagPath,
          );
        }
        if (bytes.includes(0)) {
          throw new GitHubAppError(
            'TASKPACK_MANIFEST_INVALID',
            `${diagPath}: prompt-mounted staged resource "${decl.id}" must not contain NUL bytes`,
            diagPath,
          );
        }
        let content: string;
        try {
          content = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
        } catch {
          throw new GitHubAppError(
            'TASKPACK_MANIFEST_INVALID',
            `${diagPath}: prompt-mounted staged resource "${decl.id}" is not valid UTF-8`,
            diagPath,
          );
        }
        options.scrubber.assertClean(content, diagPath);
        strippedScrubber.assertClean(content, diagPath);
        const sha256 = createHash('sha256').update(bytes).digest('hex');
        promptResources.push(Object.freeze({
          id: decl.id,
          kind: decl.kind,
          path: resolvedSrc.relativePath,
          content,
          bytes,
          sha256,
          byteLength: bytes.byteLength,
          exposeToChecks: decl.exposeToChecks,
        }));
      } else {
        const collision = hasWorkspacePathPrefixCollision(resolvedSrc.relativePath, seenWorkspaceRelPaths);
        if (collision !== null) {
          throw new GitHubAppError(
            'TASKPACK_MANIFEST_INVALID',
            `${diagPath}: workspace staged resource path "${resolvedSrc.relativePath}" collides with "${collision}"`,
            diagPath,
          );
        }
        seenWorkspaceRelPaths.add(resolvedSrc.relativePath);

        const bytes = await openAndReadNoFollowBoundedFile(
          resolvedSrc.fullPath,
          PREFLIGHT_MAX_WORKSPACE_RESOURCE_BYTES,
          diagPath,
          { requireSingleLink },
        );
        workspaceTotalBytes += bytes.byteLength;
        if (workspaceTotalBytes > PREFLIGHT_MAX_WORKSPACE_RESOURCES_TOTAL_BYTES) {
          throw new GitHubAppError(
            'TASKPACK_MANIFEST_INVALID',
            `${diagPath}: aggregate workspace-mounted staged resources exceed ${PREFLIGHT_MAX_WORKSPACE_RESOURCES_TOTAL_BYTES} bytes`,
            diagPath,
          );
        }
        const sha256 = createHash('sha256').update(bytes).digest('hex');

        if (stagedDir === null) {
          stagedDir = await mkdtemp(join(baseTemp, 'loopwright-staged-'));
          await chmod(stagedDir, 0o700);
        }
        const destPath = await writeReadOnlyStagedFile(stagedDir, resolvedSrc.relativePath, bytes, diagPath);

        let checkDestPath: string | null = null;
        if (decl.exposeToChecks) {
          if (checkStagedDir === null) {
            checkStagedDir = await mkdtemp(join(baseTemp, 'loopwright-check-staged-'));
            await chmod(checkStagedDir, 0o700);
          }
          checkDestPath = await writeReadOnlyStagedFile(checkStagedDir, resolvedSrc.relativePath, bytes, diagPath);
        }

        workspaceResources.push(Object.freeze({
          id: decl.id,
          kind: decl.kind,
          relativePath: resolvedSrc.relativePath,
          stagedPath: destPath,
          checkStagedPath: checkDestPath,
          sha256,
          byteLength: bytes.byteLength,
          exposeToChecks: decl.exposeToChecks,
        }));
      }
    }

    if (options.signal?.aborted) {
      throw new GitHubAppError('SANDBOX_EXECUTION_FAILED', 'preflight script execution aborted before completion', '/spec/preflight');
    }

    if (stagedDir !== null) {
      await chmodTreeReadOnly(stagedDir);
    }
    if (checkStagedDir !== null) {
      await chmodTreeReadOnly(checkStagedDir);
    }
    keepStagedDirs = true;

    const finalStagedDir = stagedDir;
    const finalCheckStagedDir = checkStagedDir;
    const cleanup = async (): Promise<void> => {
      if (finalStagedDir !== null) {
        await makeWritableAndRemoveTree(finalStagedDir);
      }
      if (finalCheckStagedDir !== null) {
        await makeWritableAndRemoveTree(finalCheckStagedDir);
      }
    };

    return Object.freeze({
      script: scriptRelPath,
      scriptSha256,
      disposition: effectiveDisposition,
      reason: effectiveReason,
      upstreams: groupedUpstreams,
      promptResources: Object.freeze(promptResources),
      workspaceResources: Object.freeze(workspaceResources),
      stagedDir: finalStagedDir,
      checkStagedDir: finalCheckStagedDir,
      stdout: execResult.stdout,
      stderr: execResult.stderr,
      durationMs,
      cleanup,
    });
  } finally {
    await makeWritableAndRemoveTree(workDir).catch(() => undefined);
    if (!keepStagedDirs) {
      if (stagedDir !== null) {
        await makeWritableAndRemoveTree(stagedDir).catch(() => undefined);
      }
      if (checkStagedDir !== null) {
        await makeWritableAndRemoveTree(checkStagedDir).catch(() => undefined);
      }
    }
  }
}
