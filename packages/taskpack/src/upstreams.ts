import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { constants as fsConstants, existsSync, lstatSync, statSync } from 'node:fs';
import { lstat, open, stat } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { promisify } from 'node:util';
import { SecretScrubber } from './scrubber.js';
import { parseJsonSubset, tryNormalizeRelativePath, type Json } from './schema.js';
import {
  REPOSITORY_FULL_NAME_PATTERN, TaskpackError,
  type GitCommitIdentity, type TaskpackManifest, type TaskpackUpstreamDescriptor,
  type TaskpackUpstreamGroupDeclaration, type TaskpackUpstreamRecord,
  type TaskpackV2Manifest, type UpstreamAcquisitionStatus,
} from './types.js';

const execFileAsync = promisify(execFile);

const MAX_RESPONSE_BYTES = 1_048_576;
const MAX_PROPOSAL_BYTES = 262_144;
const MAX_VERSION_PATH_LENGTH = 256;
const MAX_VERSION_PATH_SEGMENTS = 32;
const MAX_RECORD_METADATA_KEYS = 32;
const MAX_RECORD_METADATA_BYTES = 8_192;
export const COMMIT_SHA_PATTERN = /^[0-9a-f]{40}$/i;
const SAFE_GIT_REF_PATTERN = /^[A-Za-z0-9_./@^~{}-]{1,256}$/;
const SEMVER_TAG_PATTERN = /^v?(\d+(?:\.\d+)*)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/i;
const STRICT_SEMVER_PATTERN = /^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;
const PRERELEASE_VERSION_TAG_PATTERN = /^v?\d+(?:\.\d+)+(?:[._-]?(?:alpha|beta|rc|dev|pre|preview|nightly|canary)\d*|[ab]\d+)(?:[._-]|$)/i;
const FORBIDDEN_PATH_KEYS: ReadonlySet<string> = new Set(['__proto__', 'constructor', 'prototype']);
const UPSTREAM_STATUSES: ReadonlySet<string> = new Set<UpstreamAcquisitionStatus>([
  'available',
  'up_to_date',
  'held_back',
  'failed',
  'blocked',
]);
const GIT_CANDIDATE_PATHS: readonly string[] = Object.freeze([
  '/usr/bin/git',
  '/opt/homebrew/bin/git',
  '/usr/local/bin/git',
]);

/** Injectable bearer token string or lazy resolver for upstream API requests. */
export type UpstreamTokenResolver =
  | string
  | (() => Promise<string | undefined> | string | undefined);

/** Injectable extra HTTP headers map or lazy resolver for upstream API requests. */
export type UpstreamHeadersResolver =
  | Readonly<Record<string, string>>
  | (() => Promise<Readonly<Record<string, string>>> | Readonly<Record<string, string>>);

/** Extended upstream acquisition record carrying baseline, watched paths, group, failure provenance, and metadata context. */
export interface UpstreamAcquisitionRecord extends TaskpackUpstreamRecord {
  readonly currentVersion?: string | undefined;
  readonly targetVersion?: string | undefined;
  readonly watchedPaths?: readonly string[] | undefined;
  readonly groupId?: string | undefined;
  readonly underlyingStatus?: 'failed' | 'blocked' | undefined;
  readonly metadata?: Readonly<Record<string, Json>> | undefined;
}

export type UpstreamIntakeDisposition = 'candidate' | 'no_change' | 'blocked';

export interface UpstreamIntakeDispositionResult {
  readonly disposition: UpstreamIntakeDisposition;
  readonly reason: string;
  readonly available: readonly UpstreamAcquisitionRecord[];
  readonly heldBack: readonly UpstreamAcquisitionRecord[];
  readonly upToDate: readonly UpstreamAcquisitionRecord[];
  readonly failures: readonly UpstreamAcquisitionRecord[];
}

export interface DiscoverTaskpackUpstreamsV2Result {
  readonly records: readonly UpstreamAcquisitionRecord[];
  readonly disposition: UpstreamIntakeDisposition;
  readonly reason: string;
  readonly summary: string;
  readonly memoryVersions: Readonly<Record<string, string>>;
}

export interface DiscoverTaskpackUpstreamsOptions {
  readonly repositoryRoot?: string | undefined;
  readonly apiBaseUrl?: string | undefined;
  readonly githubToken?: UpstreamTokenResolver | undefined;
  readonly authHeaders?: UpstreamHeadersResolver | undefined;
  readonly fetchImpl?: typeof globalThis.fetch | undefined;
  readonly scrubber?: SecretScrubber | undefined;
  readonly upstreamRecordsJson?: string | undefined;
  readonly env?: NodeJS.ProcessEnv | undefined;
  readonly timeoutMs?: number | undefined;
  readonly baselineVersions?: Readonly<Record<string, string>> | ReadonlyMap<string, string> | undefined;
  readonly skipWorkingTreeBaselines?: boolean | undefined;
  readonly includeMetadata?: boolean | undefined;
}

export interface FindOpenManagedPullRequestOptions {
  readonly apiBaseUrl?: string | undefined;
  readonly repositoryFullName: string;
  readonly targetBranch: string;
  readonly headBranchPrefix: string;
  readonly githubToken?: UpstreamTokenResolver | undefined;
  readonly authHeaders?: UpstreamHeadersResolver | undefined;
  readonly fetchImpl?: typeof globalThis.fetch | undefined;
  readonly scrubber?: SecretScrubber | undefined;
  readonly env?: NodeJS.ProcessEnv | undefined;
  readonly timeoutMs?: number | undefined;
}

export interface ManagedPullRequestInfo {
  readonly number: number;
  readonly htmlUrl: string;
  readonly headRef: string;
  readonly headSha: string;
  readonly baseRef: string;
  readonly baseSha: string;
  readonly title: string;
  readonly body: string | null;
}

export interface ResolveRepositoryAndRevisionsOptions {
  readonly repositoryRoot: string;
  readonly repositoryFullName: string;
  readonly baseRevision: string;
  readonly sourceRevision?: string | undefined;
  readonly preserveExplicitSourceRevision?: boolean | undefined;
  readonly eventName: string;
  readonly eventPayload?: unknown | undefined;
  readonly apiBaseUrl?: string | undefined;
  readonly githubToken?: UpstreamTokenResolver | undefined;
  readonly authHeaders?: UpstreamHeadersResolver | undefined;
  readonly fetchImpl?: typeof globalThis.fetch | undefined;
  readonly scrubber?: SecretScrubber | undefined;
  readonly env?: NodeJS.ProcessEnv | undefined;
  readonly timeoutMs?: number | undefined;
}

export interface ResolvedRepositoryAndRevisions {
  readonly repositoryId: number;
  readonly baseRevision: string;
  readonly sourceRevision: string;
}

export interface ResolveActionGitHubTokenOptions {
  readonly apiBaseUrl?: string | undefined;
  readonly repositoryFullName?: string | undefined;
  readonly repositoryId?: number | undefined;
  readonly githubToken?: string | undefined;
  readonly appId?: string | number | undefined;
  readonly appPrivateKey?: string | undefined;
  readonly appInstallationId?: string | number | undefined;
  readonly createAppJwt?: ((input: {
    readonly appId: number;
    readonly privateKeyPem: string;
    readonly nowSeconds: number;
  }) => string) | undefined;
  readonly fetchImpl?: typeof globalThis.fetch | undefined;
  readonly scrubber?: SecretScrubber | undefined;
  readonly env?: NodeJS.ProcessEnv | undefined;
  readonly permissions?: Readonly<Record<string, 'read' | 'write'>> | undefined;
}

export interface ResolveActionGitHubAuthOptions extends ResolveActionGitHubTokenOptions {
  readonly gitAuthorName?: string | undefined;
  readonly gitAuthorEmail?: string | undefined;
}

export interface ResolvedActionGitHubAuth {
  readonly token: string | undefined;
  readonly installationId?: number | undefined;
  readonly appSlug?: string | undefined;
  readonly gitCommitIdentity: GitCommitIdentity;
}

export const DEFAULT_GIT_COMMIT_IDENTITY: GitCommitIdentity = Object.freeze({
  name: 'github-actions[bot]',
  email: '41898282+github-actions[bot]@users.noreply.github.com',
});

const MAX_GIT_IDENTITY_FIELD_LENGTH = 256;
const SIMPLE_EMAIL_PATTERN = /^[^\s<>@]+@[^\s<>@]+$/;

async function resolveAuthHeaders(
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
  if (resolvedToken && resolvedToken.length > 0) {
    scrubber.register(resolvedToken);
    if (!Object.keys(headers).some(k => k.toLowerCase() === 'authorization')) {
      headers['authorization'] = `Bearer ${resolvedToken}`;
    }
  }
  return headers;
}

function hasDisallowedGitIdentityChars(text: string): boolean {
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    if (code <= 0x1f || code === 0x7f || code === 0x3c || code === 0x3e) {
      return true;
    }
  }
  return false;
}

export function validateGitAuthorName(raw: string): string {
  if (typeof raw !== 'string' || hasDisallowedGitIdentityChars(raw)) {
    throw new TaskpackError(
      'ACTION_INPUT_INVALID',
      'git-author-name must not contain control characters (CR/LF/NUL) or angle brackets (< or >)',
    );
  }
  const trimmed = raw.trim();
  if (trimmed.length === 0 || trimmed.length > MAX_GIT_IDENTITY_FIELD_LENGTH) {
    throw new TaskpackError(
      'ACTION_INPUT_INVALID',
      `git-author-name must be 1..${MAX_GIT_IDENTITY_FIELD_LENGTH} printable characters`,
    );
  }
  return trimmed;
}

export function validateGitAuthorEmail(raw: string): string {
  if (typeof raw !== 'string' || hasDisallowedGitIdentityChars(raw)) {
    throw new TaskpackError(
      'ACTION_INPUT_INVALID',
      'git-author-email must not contain control characters (CR/LF/NUL) or angle brackets (< or >)',
    );
  }
  const trimmed = raw.trim();
  if (
    trimmed.length === 0
    || trimmed.length > MAX_GIT_IDENTITY_FIELD_LENGTH
    || !SIMPLE_EMAIL_PATTERN.test(trimmed)
  ) {
    throw new TaskpackError(
      'ACTION_INPUT_INVALID',
      `git-author-email must be a valid email address (1..${MAX_GIT_IDENTITY_FIELD_LENGTH} chars without whitespace or angle brackets)`,
    );
  }
  return trimmed;
}

export function validateGitCommitIdentity(identity: GitCommitIdentity): GitCommitIdentity {
  return Object.freeze({
    name: validateGitAuthorName(identity.name),
    email: validateGitAuthorEmail(identity.email),
  });
}

export function parseOptionalGitIdentityInput(
  explicitValue: string | undefined,
  envValue: string | undefined,
  validator: (raw: string) => string,
): string | undefined {
  const raw = explicitValue !== undefined ? explicitValue : envValue;
  if (raw === undefined || raw === '') return undefined;
  return validator(raw);
}

export function resolveGitExecutable(): string {
  for (const candidate of GIT_CANDIDATE_PATHS) {
    if (existsSync(candidate)) return candidate;
  }
  return 'git';
}

export function buildCleanGitEnv(extra?: Readonly<Record<string, string>>): Record<string, string> {
  return {
    PATH: process.env['PATH'] ?? '/usr/local/bin:/usr/bin:/bin',
    HOME: '/nonexistent',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_TERMINAL_PROMPT: '0',
    GIT_PROTOCOL_FROM_USER: '0',
    ...extra,
  };
}

function defaultApiBaseUrl(explicit: string | undefined, env: NodeJS.ProcessEnv | undefined): string {
  const candidate = explicit?.trim() || env?.['GITHUB_API_URL']?.trim() || 'https://api.github.com';
  return candidate.replace(/\/+$/, '');
}

export function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto: unknown = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

export function assertNoSymlinkSegments(baseDir: string, targetPath: string): void {
  const resolvedBase = resolve(baseDir);
  const resolvedTarget = resolve(targetPath);
  const rel = relative(resolvedBase, resolvedTarget);
  if (rel.startsWith('..') || isAbsolute(rel)) {
    throw new TaskpackError('ACTION_INPUT_INVALID', `path "${targetPath}" escapes root "${baseDir}"`);
  }
  const parts = rel.split(sep).filter(part => part.length > 0 && part !== '.');
  let cursor = resolvedBase;
  for (const part of parts) {
    cursor = join(cursor, part);
    const stats = lstatSync(cursor, { throwIfNoEntry: false });
    if (stats === undefined) continue;
    if (stats.isSymbolicLink()) {
      throw new TaskpackError('ACTION_INPUT_INVALID', `symlink segment disallowed at "${cursor}"`);
    }
  }
}

async function readBoundedLocalFile(baseDir: string, relPath: string, maxBytes: number): Promise<Buffer> {
  const resolvedBase = resolve(baseDir);
  const fullPath = resolve(resolvedBase, relPath);
  assertNoSymlinkSegments(resolvedBase, fullPath);
  const info = await stat(fullPath);
  if (!info.isFile()) {
    throw new TaskpackError('ACTION_INPUT_INVALID', `expected regular file at "${relPath}"`);
  }
  if (info.size > maxBytes) {
    throw new TaskpackError('ACTION_INPUT_INVALID', `file "${relPath}" exceeds maximum allowed ${maxBytes} bytes`);
  }
  const handle = await open(fullPath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  try {
    const openedStats = await handle.stat();
    if (!openedStats.isFile() || openedStats.size > maxBytes) {
      throw new TaskpackError('ACTION_INPUT_INVALID', `file "${relPath}" is not a bounded regular file`);
    }
    return await handle.readFile();
  } finally {
    await handle.close();
  }
}

export async function fetchBoundedText(
  url: string,
  fetchImpl: typeof globalThis.fetch,
  headers: Readonly<Record<string, string>>,
  timeoutMs: number,
  scrubber: SecretScrubber,
  requestOptions?: { readonly method?: string | undefined; readonly body?: string | undefined },
): Promise<{ readonly status: number; readonly ok: boolean; readonly text: string }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  timer.unref?.();
  try {
    const response = await fetchImpl(url, {
      method: requestOptions?.method ?? 'GET',
      headers,
      ...(requestOptions?.body !== undefined ? { body: requestOptions.body } : {}),
      redirect: 'error',
      signal: controller.signal,
    });
    const rawContentLength = typeof response.headers?.get === 'function'
      ? response.headers.get('content-length')
      : null;
    if (rawContentLength !== null && /^\d+$/.test(rawContentLength.trim())) {
      const declaredBytes = Number(rawContentLength.trim());
      if (!Number.isSafeInteger(declaredBytes) || declaredBytes > MAX_RESPONSE_BYTES) {
        await response.body?.cancel?.().catch(() => undefined);
        throw new TaskpackError('ACTION_INPUT_INVALID', `response from "${scrubber.scrub(url)}" exceeded ${MAX_RESPONSE_BYTES} bytes`);
      }
    }
    const reader = response.body?.getReader();
    if (!reader) {
      if (typeof response.arrayBuffer === 'function') {
        const buf = Buffer.from(await response.arrayBuffer());
        if (buf.byteLength > MAX_RESPONSE_BYTES) {
          throw new TaskpackError('ACTION_INPUT_INVALID', `response from "${scrubber.scrub(url)}" exceeded ${MAX_RESPONSE_BYTES} bytes`);
        }
        return { status: response.status, ok: response.ok, text: buf.toString('utf8') };
      }
      const text = await response.text();
      if (Buffer.byteLength(text, 'utf8') > MAX_RESPONSE_BYTES) {
        throw new TaskpackError('ACTION_INPUT_INVALID', `response from "${scrubber.scrub(url)}" exceeded ${MAX_RESPONSE_BYTES} bytes`);
      }
      return { status: response.status, ok: response.ok, text };
    }
    const chunks: Buffer[] = [];
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_RESPONSE_BYTES) {
        await reader.cancel().catch(() => undefined);
        throw new TaskpackError('ACTION_INPUT_INVALID', `response from "${scrubber.scrub(url)}" exceeded ${MAX_RESPONSE_BYTES} bytes`);
      }
      chunks.push(Buffer.from(value));
    }
    return { status: response.status, ok: response.ok, text: Buffer.concat(chunks).toString('utf8') };
  } finally {
    clearTimeout(timer);
  }
}

async function fetchJson(
  url: string,
  fetchImpl: typeof globalThis.fetch,
  headers: Readonly<Record<string, string>>,
  timeoutMs: number,
  scrubber: SecretScrubber,
): Promise<{ readonly status: number; readonly ok: boolean; readonly data: unknown; readonly rawText: string }> {
  const result = await fetchBoundedText(url, fetchImpl, headers, timeoutMs, scrubber);
  if (result.text.trim().length === 0) {
    return { status: result.status, ok: result.ok, data: null, rawText: '' };
  }
  try {
    return { status: result.status, ok: result.ok, data: JSON.parse(result.text) as unknown, rawText: result.text };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new TaskpackError('ACTION_INPUT_INVALID', `invalid JSON from "${scrubber.scrub(url)}": ${scrubber.scrub(detail)}`);
  }
}

const MAX_RECORD_METADATA_DEPTH = 12;
const MAX_VERSION_STRING_LENGTH = 256;
const MAX_UPSTREAM_ID_LENGTH = 128;

function sanitizeSingleLine(text: string): string {
  return text.replace(/[\0\r\n]+/g, ' ').trim();
}

function validateVersionStringField(value: unknown, label: string, maxLength = MAX_VERSION_STRING_LENGTH): string {
  if (typeof value !== 'string') {
    throw new TaskpackError('ACTION_INPUT_INVALID', `${label} must be a string`);
  }
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > maxLength || /[\0\r\n]/.test(value)) {
    throw new TaskpackError(
      'ACTION_INPUT_INVALID',
      `${label} must be a single-line non-empty string of at most ${maxLength} characters`,
    );
  }
  return trimmed;
}

/**
 * Normalize `version` / `targetVersion` for `held_back` upstream records so `version` NEVER
 * substitutes a skipped target version into reviewed-memory metadata when `currentVersion` is known
 * (or omits `version` if `currentVersion` is unknown).
 */
export function normalizeHeldBackVersions(
  status: UpstreamAcquisitionStatus,
  version: string | undefined,
  currentVersion: string | undefined,
  targetVersion: string | undefined,
): { readonly version?: string | undefined; readonly targetVersion?: string | undefined } {
  if (status !== 'held_back') {
    return { version, targetVersion };
  }
  if (currentVersion !== undefined) {
    const skipped = targetVersion ?? (version !== undefined && version !== currentVersion ? version : undefined);
    return { version: currentVersion, targetVersion: skipped };
  }
  if (version !== undefined) {
    return { version: undefined, targetVersion: targetVersion ?? version };
  }
  return { version: undefined, targetVersion };
}

function validateBoundedMetadataValue(value: unknown, label: string, depth: number): Json {
  if (depth > MAX_RECORD_METADATA_DEPTH) {
    throw new TaskpackError('ACTION_INPUT_INVALID', `${label} exceeds maximum nesting depth ${MAX_RECORD_METADATA_DEPTH}`);
  }
  if (value === null || typeof value === 'boolean' || typeof value === 'string') {
    return value;
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || Object.is(value, -0)) {
      throw new TaskpackError('ACTION_INPUT_INVALID', `${label} contains non-finite number`);
    }
    return value;
  }
  if (Array.isArray(value)) {
    return Object.freeze(value.map((item, idx) => validateBoundedMetadataValue(item, `${label}[${idx}]`, depth + 1))) as unknown as Json;
  }
  if (isPlainRecord(value)) {
    const out: Record<string, Json> = Object.create(null) as Record<string, Json>;
    for (const key of Object.keys(value)) {
      if (FORBIDDEN_PATH_KEYS.has(key)) {
        throw new TaskpackError('ACTION_INPUT_INVALID', `${label} contains forbidden key "${key}"`);
      }
      out[key] = validateBoundedMetadataValue(value[key], `${label}.${key}`, depth + 1);
    }
    return Object.freeze(out);
  }
  throw new TaskpackError('ACTION_INPUT_INVALID', `${label} contains unsupported non-JSON value`);
}

function validateBoundedMetadataRecord(raw: unknown, label: string): Readonly<Record<string, Json>> {
  if (!isPlainRecord(raw)) {
    throw new TaskpackError('ACTION_INPUT_INVALID', `${label} must be a plain JSON object`);
  }
  const entries = Object.keys(raw);
  if (entries.length > MAX_RECORD_METADATA_KEYS) {
    throw new TaskpackError('ACTION_INPUT_INVALID', `${label} exceeds ${MAX_RECORD_METADATA_KEYS} entries`);
  }
  const out = validateBoundedMetadataValue(raw, label, 1) as Record<string, Json>;
  let serialized: string;
  try {
    serialized = JSON.stringify(out);
  } catch {
    throw new TaskpackError('ACTION_INPUT_INVALID', `${label} is not JSON-serializable`);
  }
  if (Buffer.byteLength(serialized, 'utf8') > MAX_RECORD_METADATA_BYTES) {
    throw new TaskpackError('ACTION_INPUT_INVALID', `${label} exceeds ${MAX_RECORD_METADATA_BYTES} bytes`);
  }
  return out;
}

export function parseUpstreamRecordsJson(rawJson: string): readonly UpstreamAcquisitionRecord[] {
  if (typeof rawJson !== 'string' || Buffer.byteLength(rawJson, 'utf8') > MAX_RESPONSE_BYTES) {
    throw new TaskpackError('ACTION_INPUT_INVALID', `upstreamRecordsJson must be a string of at most ${MAX_RESPONSE_BYTES} bytes`);
  }
  let parsed: Json;
  try {
    parsed = parseJsonSubset(rawJson, {
      maxNodes: 8_192,
      maxDepth: MAX_RECORD_METADATA_DEPTH,
      maxCollection: 256,
      maxString: 32_768,
      diagPath: '/upstreamRecordsJson',
    });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new TaskpackError('ACTION_INPUT_INVALID', `upstreamRecordsJson is not valid JSON: ${detail}`);
  }
  if (!Array.isArray(parsed)) {
    throw new TaskpackError('ACTION_INPUT_INVALID', 'upstreamRecordsJson must be a JSON array');
  }
  const records: UpstreamAcquisitionRecord[] = [];
  for (const [index, entry] of parsed.entries()) {
    if (!isPlainRecord(entry)) {
      throw new TaskpackError('ACTION_INPUT_INVALID', `upstreamRecordsJson[${index}] must be an object`);
    }
    const rawUpstreamId = entry['upstreamId'];
    const status = entry['status'];
    const rawVersion = entry['version'];
    const rawCurrentVersion = entry['currentVersion'];
    const rawTargetVersion = entry['targetVersion'];
    const recentVersions = entry['recentVersions'];
    const watchedPaths = entry['watchedPaths'];
    const rawGroupId = entry['groupId'];
    const rawUnderlyingStatus = entry['underlyingStatus'];
    const reason = entry['reason'];
    const metadata = entry['metadata'];
    const upstreamId = validateVersionStringField(rawUpstreamId, `upstreamRecordsJson[${index}].upstreamId`, MAX_UPSTREAM_ID_LENGTH);
    if (typeof status !== 'string' || !UPSTREAM_STATUSES.has(status)) {
      throw new TaskpackError('ACTION_INPUT_INVALID', `upstreamRecordsJson[${index}].status is invalid`);
    }
    const version = rawVersion !== undefined
      ? validateVersionStringField(rawVersion, `upstreamRecordsJson[${index}].version`)
      : undefined;
    const currentVersion = rawCurrentVersion !== undefined
      ? validateVersionStringField(rawCurrentVersion, `upstreamRecordsJson[${index}].currentVersion`)
      : undefined;
    const targetVersion = rawTargetVersion !== undefined
      ? validateVersionStringField(rawTargetVersion, `upstreamRecordsJson[${index}].targetVersion`)
      : undefined;
    if (
      recentVersions !== undefined
      && (!Array.isArray(recentVersions) || recentVersions.some(item => typeof item !== 'string' || item.trim().length === 0 || item.length > MAX_VERSION_STRING_LENGTH || /[\0\r\n]/.test(item)))
    ) {
      throw new TaskpackError('ACTION_INPUT_INVALID', `upstreamRecordsJson[${index}].recentVersions must be an array of bounded single-line strings`);
    }
    if (
      watchedPaths !== undefined
      && (!Array.isArray(watchedPaths) || watchedPaths.some(item => typeof item !== 'string' || item.length === 0 || item.length > 1024 || /[\0\r\n]/.test(item)))
    ) {
      throw new TaskpackError('ACTION_INPUT_INVALID', `upstreamRecordsJson[${index}].watchedPaths must be an array of non-empty strings`);
    }
    const groupId = rawGroupId !== undefined
      ? validateVersionStringField(rawGroupId, `upstreamRecordsJson[${index}].groupId`, MAX_UPSTREAM_ID_LENGTH)
      : undefined;
    let underlyingStatus: 'failed' | 'blocked' | undefined;
    if (rawUnderlyingStatus !== undefined) {
      if (rawUnderlyingStatus !== 'failed' && rawUnderlyingStatus !== 'blocked') {
        throw new TaskpackError('ACTION_INPUT_INVALID', `upstreamRecordsJson[${index}].underlyingStatus must be "failed" or "blocked"`);
      }
      underlyingStatus = rawUnderlyingStatus;
    }
    if (reason !== undefined && (typeof reason !== 'string' || reason.length > 2048)) {
      throw new TaskpackError('ACTION_INPUT_INVALID', `upstreamRecordsJson[${index}].reason must be a string of at most 2048 characters`);
    }
    const validatedMetadata = metadata !== undefined
      ? validateBoundedMetadataRecord(metadata, `upstreamRecordsJson[${index}].metadata`)
      : undefined;

    const typedStatus = status as UpstreamAcquisitionStatus;
    const normalized = normalizeHeldBackVersions(typedStatus, version, currentVersion, targetVersion);

    records.push({
      upstreamId,
      status: typedStatus,
      ...(normalized.version !== undefined ? { version: normalized.version } : {}),
      ...(currentVersion !== undefined ? { currentVersion } : {}),
      ...(normalized.targetVersion !== undefined ? { targetVersion: normalized.targetVersion } : {}),
      ...(recentVersions !== undefined ? { recentVersions: Object.freeze([...(recentVersions as string[])]) } : {}),
      ...(watchedPaths !== undefined ? { watchedPaths: Object.freeze([...(watchedPaths as string[])]) } : {}),
      ...(groupId !== undefined ? { groupId } : {}),
      ...(underlyingStatus !== undefined ? { underlyingStatus } : {}),
      ...(reason !== undefined ? { reason } : {}),
      ...(validatedMetadata !== undefined ? { metadata: validatedMetadata } : {}),
    });
  }
  return Object.freeze(records);
}

type VersionPathSegment = { readonly kind: 'key'; readonly value: string } | { readonly kind: 'index'; readonly value: number };

function parseVersionPathSegments(versionPath: string): readonly VersionPathSegment[] {
  if (
    typeof versionPath !== 'string'
    || versionPath.length === 0
    || versionPath.length > MAX_VERSION_PATH_LENGTH
    || /[\0\r\n]/.test(versionPath)
  ) {
    throw new TaskpackError('ACTION_INPUT_INVALID', `invalid versionPath selector "${String(versionPath)}"`);
  }

  const segments: VersionPathSegment[] = [];
  let cursor: number;

  if (versionPath.startsWith('$')) {
    cursor = 1;
    if (cursor === versionPath.length) {
      throw new TaskpackError('ACTION_INPUT_INVALID', 'versionPath "$" must select a property or index');
    }
  } else {
    const firstMatch = /^[A-Za-z0-9_-]+/.exec(versionPath);
    if (firstMatch === null) {
      throw new TaskpackError('ACTION_INPUT_INVALID', `invalid versionPath selector "${versionPath}"`);
    }
    const firstKey = firstMatch[0];
    if (FORBIDDEN_PATH_KEYS.has(firstKey)) {
      throw new TaskpackError('ACTION_INPUT_INVALID', `versionPath must not access forbidden property "${firstKey}"`);
    }
    segments.push({ kind: 'key', value: firstKey });
    cursor = firstKey.length;
  }

  while (cursor < versionPath.length) {
    if (segments.length >= MAX_VERSION_PATH_SEGMENTS) {
      throw new TaskpackError('ACTION_INPUT_INVALID', `versionPath exceeds ${MAX_VERSION_PATH_SEGMENTS} segments`);
    }
    const rest = versionPath.slice(cursor);
    if (rest.startsWith('.')) {
      const dotMatch = /^\.([A-Za-z0-9_-]+)/.exec(rest);
      if (dotMatch === null) {
        throw new TaskpackError('ACTION_INPUT_INVALID', `invalid dot segment in versionPath "${versionPath}"`);
      }
      const key = dotMatch[1]!;
      if (FORBIDDEN_PATH_KEYS.has(key)) {
        throw new TaskpackError('ACTION_INPUT_INVALID', `versionPath must not access forbidden property "${key}"`);
      }
      segments.push({ kind: 'key', value: key });
      cursor += dotMatch[0].length;
    } else if (rest.startsWith('[')) {
      const idxMatch = /^\[(\d+)\]/.exec(rest);
      if (idxMatch !== null) {
        const index = Number.parseInt(idxMatch[1]!, 10);
        if (!Number.isSafeInteger(index) || index < 0) {
          throw new TaskpackError('ACTION_INPUT_INVALID', `invalid array index in versionPath "${versionPath}"`);
        }
        segments.push({ kind: 'index', value: index });
        cursor += idxMatch[0].length;
        continue;
      }
      const singleQuoteMatch = /^\['([^'\r\n]+)'\]/.exec(rest);
      if (singleQuoteMatch !== null) {
        const key = singleQuoteMatch[1]!;
        if (FORBIDDEN_PATH_KEYS.has(key)) {
          throw new TaskpackError('ACTION_INPUT_INVALID', `versionPath must not access forbidden property "${key}"`);
        }
        segments.push({ kind: 'key', value: key });
        cursor += singleQuoteMatch[0].length;
        continue;
      }
      const doubleQuoteMatch = /^\["([^"\r\n]+)"\]/.exec(rest);
      if (doubleQuoteMatch !== null) {
        const key = doubleQuoteMatch[1]!;
        if (FORBIDDEN_PATH_KEYS.has(key)) {
          throw new TaskpackError('ACTION_INPUT_INVALID', `versionPath must not access forbidden property "${key}"`);
        }
        segments.push({ kind: 'key', value: key });
        cursor += doubleQuoteMatch[0].length;
        continue;
      }
      throw new TaskpackError('ACTION_INPUT_INVALID', `invalid bracket segment in versionPath "${versionPath}"`);
    } else {
      throw new TaskpackError('ACTION_INPUT_INVALID', `unexpected token in versionPath "${versionPath}" at offset ${cursor}`);
    }
  }

  if (segments.length === 0) {
    throw new TaskpackError('ACTION_INPUT_INVALID', `versionPath "${versionPath}" selects no segments`);
  }
  return segments;
}

/**
 * Safely traverse a parsed JSON value using a bounded dot/bracket `versionPath` selector
 * (e.g. `dist-tags.latest`, `$.data.releases[0].version`, `packages['@scope/pkg'].version`),
 * refusing prototype-chain keys (`__proto__`, `constructor`, `prototype`).
 */
export function extractJsonVersionPath(data: unknown, versionPath: string): string | undefined {
  const segments = parseVersionPathSegments(versionPath);
  let current: unknown = data;
  for (const segment of segments) {
    if (segment.kind === 'index') {
      if (!Array.isArray(current) || segment.value < 0 || segment.value >= current.length) {
        return undefined;
      }
      current = current[segment.value];
    } else {
      if (!isPlainRecord(current) || !Object.hasOwn(current, segment.value)) {
        return undefined;
      }
      current = current[segment.value];
    }
  }
  if (typeof current !== 'string') return undefined;
  if (/[\0\r\n]/.test(current)) {
    throw new TaskpackError(
      'ACTION_INPUT_INVALID',
      `versionPath "${versionPath}" resolved to a multiline or NUL-containing string`,
    );
  }
  const trimmed = current.trim();
  if (trimmed.length === 0) return undefined;
  if (trimmed.length > MAX_VERSION_STRING_LENGTH) {
    throw new TaskpackError(
      'ACTION_INPUT_INVALID',
      `versionPath "${versionPath}" resolved value exceeds ${MAX_VERSION_STRING_LENGTH} characters`,
    );
  }
  return trimmed;
}

interface StrictSemverParts {
  readonly major: bigint;
  readonly minor: bigint;
  readonly patch: bigint;
  readonly prerelease: readonly string[];
}

function parseStrictSemver(raw: string): StrictSemverParts | null {
  const match = STRICT_SEMVER_PATTERN.exec(raw.trim());
  if (match === null) return null;
  return {
    major: BigInt(match[1]!),
    minor: BigInt(match[2]!),
    patch: BigInt(match[3]!),
    prerelease: match[4] !== undefined ? match[4].split('.') : [],
  };
}

/**
 * Compare two strict SemVer 2.0.0 strings (`major.minor.patch[-prerelease][+build]`).
 * Returns `< 0` when `a < b`, `0` when equal precedence, `> 0` when `a > b`, or `null` if either is not strict SemVer.
 */
export function compareStrictSemver(a: string, b: string): number | null {
  const semA = parseStrictSemver(a);
  const semB = parseStrictSemver(b);
  if (semA === null || semB === null) return null;
  if (semA.major !== semB.major) return semA.major < semB.major ? -1 : 1;
  if (semA.minor !== semB.minor) return semA.minor < semB.minor ? -1 : 1;
  if (semA.patch !== semB.patch) return semA.patch < semB.patch ? -1 : 1;
  if (semA.prerelease.length === 0 && semB.prerelease.length === 0) return 0;
  if (semA.prerelease.length === 0) return 1;
  if (semB.prerelease.length === 0) return -1;
  const len = Math.min(semA.prerelease.length, semB.prerelease.length);
  for (let i = 0; i < len; i += 1) {
    const idA = semA.prerelease[i]!;
    const idB = semB.prerelease[i]!;
    const isNumA = /^\d+$/.test(idA);
    const isNumB = /^\d+$/.test(idB);
    if (isNumA && isNumB) {
      const nA = BigInt(idA);
      const nB = BigInt(idB);
      if (nA !== nB) return nA < nB ? -1 : 1;
    } else if (isNumA !== isNumB) {
      return isNumA ? -1 : 1;
    } else if (idA !== idB) {
      return idA < idB ? -1 : 1;
    }
  }
  return semA.prerelease.length - semB.prerelease.length;
}

function normalizePackageJsonVersionSpec(rawSpec: string): string | undefined {
  const trimmed = rawSpec.trim();
  if (
    trimmed.length === 0
    || /[\0\r\n\s<>]|[*xX]|\|\|/.test(trimmed)
    || /^[A-Za-z][A-Za-z0-9+.-]*:/.test(trimmed)
  ) {
    return undefined;
  }
  const stripped = trimmed.replace(/^[~^=]+/, '');
  if (stripped.length === 0 || parseSemverTag(stripped) === null) {
    return undefined;
  }
  return stripped;
}

function extractNpmPackageNameFromSource(source: string): string | undefined {
  try {
    const parsed = new URL(source);
    if (parsed.hostname !== 'registry.npmjs.org') return undefined;
    const rawPath = parsed.pathname.replace(/^\/+|\/+$/g, '');
    if (rawPath.length === 0) return undefined;
    const withoutLatest = rawPath.endsWith('/latest') ? rawPath.slice(0, -'/latest'.length) : rawPath;
    return decodeURIComponent(withoutLatest);
  } catch {
    return undefined;
  }
}

function readPackageJsonBaselineVersions(
  packageJsonRaw: unknown,
  declaredUpstreams: readonly TaskpackUpstreamDescriptor[],
): ReadonlyMap<string, string> {
  const baselines = new Map<string, string>();
  if (!isPlainRecord(packageJsonRaw)) return baselines;
  const deps = new Map<string, string>();
  for (const section of ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies'] as const) {
    const table = packageJsonRaw[section];
    if (!isPlainRecord(table)) continue;
    for (const [pkgName, spec] of Object.entries(table)) {
      if (typeof spec !== 'string' || deps.has(pkgName)) continue;
      const normalized = normalizePackageJsonVersionSpec(spec);
      if (normalized !== undefined) {
        deps.set(pkgName, normalized);
      }
    }
  }
  for (const upstream of declaredUpstreams) {
    const direct = deps.get(upstream.id);
    if (direct !== undefined) {
      baselines.set(upstream.id, direct);
      continue;
    }
    const pkgFromUrl = extractNpmPackageNameFromSource(upstream.source);
    if (pkgFromUrl !== undefined) {
      const fromUrl = deps.get(pkgFromUrl);
      if (fromUrl !== undefined) {
        baselines.set(upstream.id, fromUrl);
      }
    }
  }
  return baselines;
}

function readBaselineVersions(
  proposalRaw: unknown,
  declaredUpstreams?: readonly TaskpackUpstreamDescriptor[],
): ReadonlyMap<string, string> {
  const versions = new Map<string, string>();
  if (!isPlainRecord(proposalRaw)) return versions;

  const upstreamsField = proposalRaw['upstreams'];
  if (Array.isArray(upstreamsField)) {
    for (const item of upstreamsField) {
      if (!isPlainRecord(item)) continue;
      const id = typeof item['id'] === 'string'
        ? item['id']
        : typeof item['upstreamId'] === 'string'
          ? item['upstreamId']
          : undefined;
      const version = item['version'];
      if (id !== undefined && typeof version === 'string' && version.length > 0) {
        versions.set(id, version);
      }
    }
  } else if (isPlainRecord(upstreamsField)) {
    for (const [id, entry] of Object.entries(upstreamsField)) {
      if (typeof entry === 'string' && entry.length > 0) {
        versions.set(id, entry);
      } else if (isPlainRecord(entry) && typeof entry['version'] === 'string' && entry['version'].length > 0) {
        versions.set(id, entry['version']);
      }
    }
  }

  const versionsField = proposalRaw['versions'];
  if (isPlainRecord(versionsField)) {
    for (const [id, entry] of Object.entries(versionsField)) {
      if (typeof entry === 'string' && entry.length > 0 && !versions.has(id)) {
        versions.set(id, entry);
      }
    }
  }

  if (
    versions.size === 0
    && declaredUpstreams !== undefined
    && declaredUpstreams.length === 1
    && typeof proposalRaw['version'] === 'string'
    && proposalRaw['version'].length > 0
  ) {
    versions.set(declaredUpstreams[0]!.id, proposalRaw['version']);
  }
  return versions;
}

export function validateGitRemoteSource(source: string, repositoryRoot?: string): 'https' | 'local-dir' {
  if (
    typeof source !== 'string'
    || source.length === 0
    || /[\0\r\n]/.test(source)
    || source.startsWith('-')
  ) {
    throw new TaskpackError('ACTION_INPUT_INVALID', `unsafe git upstream source "${source}"`);
  }
  if (source.includes('://') || /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(source)) {
    if (!source.startsWith('https://') || /\s/.test(source)) {
      throw new TaskpackError('ACTION_INPUT_INVALID', `git upstream source "${source}" uses disallowed scheme`);
    }
    let parsed: URL;
    try {
      parsed = new URL(source);
    } catch {
      throw new TaskpackError('ACTION_INPUT_INVALID', `git upstream source "${source}" is not a valid https URL`);
    }
    if (parsed.protocol !== 'https:' || parsed.hostname.length === 0) {
      throw new TaskpackError('ACTION_INPUT_INVALID', `git upstream source "${source}" must be a valid https URL`);
    }
    return 'https';
  }
  const localPath = repositoryRoot !== undefined ? resolve(repositoryRoot, source) : source;
  if (!existsSync(localPath) || !statSync(localPath).isDirectory()) {
    throw new TaskpackError('ACTION_INPUT_INVALID', `git upstream local source "${source}" must be an existing directory`);
  }
  return 'local-dir';
}

interface ParsedSemverTag {
  readonly core: readonly number[];
  readonly prerelease: readonly string[];
}

function parseSemverTag(tag: string): ParsedSemverTag | null {
  const match = SEMVER_TAG_PATTERN.exec(tag.trim());
  if (!match) return null;
  const core = match[1]!.split('.').map(part => Number.parseInt(part, 10));
  if (core.some(n => !Number.isSafeInteger(n))) return null;
  const prerelease = match[2] ? match[2].split('.') : [];
  return { core, prerelease };
}

function compareNaturalChunks(a: string, b: string): number {
  const chunksA = a.match(/\d+|\D+/g) ?? [];
  const chunksB = b.match(/\d+|\D+/g) ?? [];
  const len = Math.min(chunksA.length, chunksB.length);
  for (let i = 0; i < len; i += 1) {
    const partA = chunksA[i]!;
    const partB = chunksB[i]!;
    const numA = /^\d+$/.test(partA);
    const numB = /^\d+$/.test(partB);
    if (numA && numB) {
      const valA = BigInt(partA);
      const valB = BigInt(partB);
      if (valA !== valB) return valA < valB ? -1 : 1;
    } else if (partA !== partB) {
      return partA < partB ? -1 : 1;
    }
  }
  return chunksA.length - chunksB.length;
}

export function isPrereleaseVersionTag(tag: string): boolean {
  const coreAndPre = tag.trim().split('+', 1)[0]!;
  return PRERELEASE_VERSION_TAG_PATTERN.test(coreAndPre);
}

export function compareVersionTags(a: string, b: string): number {
  const semA = parseSemverTag(a);
  const semB = parseSemverTag(b);
  if (semA !== null && semB !== null) {
    const maxLen = Math.max(semA.core.length, semB.core.length);
    for (let i = 0; i < maxLen; i += 1) {
      const valA = semA.core[i] ?? 0;
      const valB = semB.core[i] ?? 0;
      if (valA !== valB) return valA - valB;
    }
    if (semA.prerelease.length === 0 && semB.prerelease.length === 0) return 0;
    if (semA.prerelease.length === 0) return 1;
    if (semB.prerelease.length === 0) return -1;
    const preLen = Math.min(semA.prerelease.length, semB.prerelease.length);
    for (let i = 0; i < preLen; i += 1) {
      const idA = semA.prerelease[i]!;
      const idB = semB.prerelease[i]!;
      const isNumA = /^\d+$/.test(idA);
      const isNumB = /^\d+$/.test(idB);
      if (isNumA && isNumB) {
        const nA = BigInt(idA);
        const nB = BigInt(idB);
        if (nA !== nB) return nA < nB ? -1 : 1;
      } else if (isNumA !== isNumB) {
        return isNumA ? -1 : 1;
      } else if (idA !== idB) {
        return idA < idB ? -1 : 1;
      }
    }
    return semA.prerelease.length - semB.prerelease.length;
  }
  return compareNaturalChunks(a, b);
}

async function runGitLsRemote(
  args: readonly string[],
  timeoutMs: number,
  sourceKind: 'https' | 'local-dir',
): Promise<string> {
  const gitBin = resolveGitExecutable();
  const protocolArgs = sourceKind === 'local-dir'
    ? ['-c', 'protocol.file.allow=always', '-c', 'protocol.ext.allow=never', '-c', 'protocol.ssh.allow=never']
    : ['-c', 'protocol.ext.allow=never', '-c', 'protocol.ssh.allow=never'];
  const { stdout } = await execFileAsync(gitBin, [...protocolArgs, ...args], {
    env: buildCleanGitEnv(),
    timeout: timeoutMs,
    maxBuffer: MAX_RESPONSE_BYTES,
    encoding: 'utf8',
  });
  return stdout;
}

function extractReleaseTag(record: Record<string, unknown>): string | undefined {
  if (typeof record['tag_name'] === 'string' && record['tag_name'].length > 0) {
    return record['tag_name'];
  }
  if (typeof record['name'] === 'string' && record['name'].length > 0) {
    return record['name'];
  }
  return undefined;
}

function collectReleaseTags(
  items: readonly unknown[],
  options: { readonly allowPrerelease: boolean; readonly rejectTagPrerelease: boolean },
): string[] {
  const tags: string[] = [];
  for (const item of items) {
    if (!isPlainRecord(item) || item['draft'] === true) continue;
    if (!options.allowPrerelease && item['prerelease'] === true) continue;
    const itemTag = extractReleaseTag(item);
    if (itemTag === undefined) continue;
    if (options.rejectTagPrerelease && isPrereleaseVersionTag(itemTag)) continue;
    if (!tags.includes(itemTag)) tags.push(itemTag);
  }
  return tags;
}

function selectLatestVersionTag(tags: readonly string[], upstream: TaskpackUpstreamDescriptor): string {
  const candidates = upstream.allowPrerelease === false
    ? tags.filter(tag => !isPrereleaseVersionTag(tag))
    : [...tags];
  if (candidates.length === 0) {
    throw new TaskpackError('ACTION_INPUT_INVALID', `no non-prerelease tags found for ${upstream.source}`);
  }
  candidates.sort(compareVersionTags);
  return candidates[candidates.length - 1]!;
}

function validateHttpUpstreamUrl(source: string, kind: 'http-json' | 'custom-table'): URL {
  if (typeof source !== 'string' || source.length === 0 || /[\0\r\n\s]/.test(source)) {
    throw new TaskpackError('ACTION_INPUT_INVALID', `${kind} source "${source}" is not a valid URL`);
  }
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(source);
  } catch {
    throw new TaskpackError('ACTION_INPUT_INVALID', `${kind} source "${source}" is not a valid URL`);
  }
  if (parsedUrl.username.length > 0 || parsedUrl.password.length > 0) {
    throw new TaskpackError('ACTION_INPUT_INVALID', `${kind} source "${source}" must not embed URL credentials`);
  }
  if (parsedUrl.hash.length > 0) {
    throw new TaskpackError('ACTION_INPUT_INVALID', `${kind} source "${source}" must not contain a URL fragment`);
  }
  if (parsedUrl.protocol === 'https:') {
    return parsedUrl;
  }
  if (parsedUrl.protocol === 'http:') {
    const host = parsedUrl.hostname.toLowerCase();
    const isLoopback = host === '127.0.0.1' || host === 'localhost' || host === '[::1]' || host === '::1';
    if (isLoopback) {
      return parsedUrl;
    }
  }
  throw new TaskpackError(
    'ACTION_INPUT_INVALID',
    `${kind} source "${source}" must use https:// (plain http:// is allowed only for loopback hosts)`,
  );
}

async function resolveSingleUpstreamDetails(
  upstream: TaskpackUpstreamDescriptor,
  context: {
    readonly repositoryRoot?: string | undefined;
    readonly apiBaseUrl: string;
    readonly githubHeaders: Readonly<Record<string, string>>;
    readonly fetchImpl: typeof globalThis.fetch;
    readonly timeoutMs: number;
    readonly scrubber: SecretScrubber;
  },
): Promise<{ readonly version: string; readonly recentVersions?: readonly string[] | undefined }> {
  const { apiBaseUrl, githubHeaders, fetchImpl, timeoutMs, scrubber } = context;

  switch (upstream.kind) {
    case 'github-release': {
      if (!REPOSITORY_FULL_NAME_PATTERN.test(upstream.source)) {
        throw new TaskpackError('ACTION_INPUT_INVALID', `github-release upstream "${upstream.id}" source "${upstream.source}" must be owner/repo`);
      }
      const list30Url = `${apiBaseUrl}/repos/${upstream.source}/releases?per_page=30`;
      if (upstream.allowPrerelease === true) {
        const list30 = await fetchJson(list30Url, fetchImpl, githubHeaders, timeoutMs, scrubber);
        if (list30.ok && Array.isArray(list30.data)) {
          const tags = collectReleaseTags(list30.data, { allowPrerelease: true, rejectTagPrerelease: false });
          if (tags.length > 0) {
            return { version: tags[0]!, recentVersions: Object.freeze(tags.slice(0, 20)) };
          }
        }
        const latestUrl = `${apiBaseUrl}/repos/${upstream.source}/releases/latest`;
        const latest = await fetchJson(latestUrl, fetchImpl, githubHeaders, timeoutMs, scrubber);
        if (latest.ok && isPlainRecord(latest.data)) {
          const latestTag = extractReleaseTag(latest.data);
          if (latestTag !== undefined) return { version: latestTag };
        }
        const listUrl = `${apiBaseUrl}/repos/${upstream.source}/releases?per_page=1`;
        const list = await fetchJson(listUrl, fetchImpl, githubHeaders, timeoutMs, scrubber);
        if (list.ok && Array.isArray(list.data) && list.data.length > 0 && isPlainRecord(list.data[0])) {
          const firstTag = extractReleaseTag(list.data[0]);
          if (firstTag !== undefined) return { version: firstTag };
        }
        throw new TaskpackError('ACTION_INPUT_INVALID', `GitHub releases lookup failed (${list.status}) for ${upstream.source}`);
      }

      const rejectTagPrerelease = upstream.allowPrerelease === false;
      const latestUrl = `${apiBaseUrl}/repos/${upstream.source}/releases/latest`;
      const latest = await fetchJson(latestUrl, fetchImpl, githubHeaders, timeoutMs, scrubber);
      let rejectedLatestTag = false;
      if (latest.ok && isPlainRecord(latest.data) && latest.data['prerelease'] !== true) {
        const latestTag = extractReleaseTag(latest.data);
        if (latestTag !== undefined) {
          if (rejectTagPrerelease && isPrereleaseVersionTag(latestTag)) {
            rejectedLatestTag = true;
          } else {
            let recentVersions: readonly string[] | undefined;
            try {
              const list30 = await fetchJson(list30Url, fetchImpl, githubHeaders, timeoutMs, scrubber);
              if (list30.ok && Array.isArray(list30.data)) {
                const tags = collectReleaseTags(list30.data, { allowPrerelease: false, rejectTagPrerelease });
                if (tags.length > 0) {
                  recentVersions = Object.freeze([latestTag, ...tags.filter(item => item !== latestTag)].slice(0, 20));
                }
              }
            } catch {
              // Best-effort history enrichment; primary /releases/latest result stands.
            }
            return recentVersions !== undefined ? { version: latestTag, recentVersions } : { version: latestTag };
          }
        }
      }
      if (rejectedLatestTag) {
        const list30 = await fetchJson(list30Url, fetchImpl, githubHeaders, timeoutMs, scrubber);
        if (!list30.ok || !Array.isArray(list30.data)) {
          throw new TaskpackError('ACTION_INPUT_INVALID', `GitHub releases lookup failed (${list30.status}) for ${upstream.source}`);
        }
        const stableTags = collectReleaseTags(list30.data, { allowPrerelease: false, rejectTagPrerelease: true });
        if (stableTags.length > 0) {
          const bestVersion = [...stableTags].sort(compareVersionTags).at(-1)!;
          return {
            version: bestVersion,
            recentVersions: Object.freeze([bestVersion, ...stableTags.filter(item => item !== bestVersion)].slice(0, 20)),
          };
        }
        throw new TaskpackError('ACTION_INPUT_INVALID', `no non-prerelease releases found for ${upstream.source}`);
      }
      throw new TaskpackError('ACTION_INPUT_INVALID', `GitHub release lookup failed (${latest.status}) for ${upstream.source}`);
    }

    case 'git-tag': {
      if (REPOSITORY_FULL_NAME_PATTERN.test(upstream.source)) {
        const url = `${apiBaseUrl}/repos/${upstream.source}/tags?per_page=100`;
        const res = await fetchJson(url, fetchImpl, githubHeaders, timeoutMs, scrubber);
        if (!res.ok || !Array.isArray(res.data) || res.data.length === 0) {
          throw new TaskpackError('ACTION_INPUT_INVALID', `GitHub tags lookup failed (${res.status}) for ${upstream.source}`);
        }
        const tagNames: string[] = [];
        let fallbackSha: string | undefined;
        for (const item of res.data) {
          if (!isPlainRecord(item)) continue;
          if (typeof item['name'] === 'string' && item['name'].length > 0) {
            tagNames.push(item['name']);
          } else if (fallbackSha === undefined) {
            const commit = isPlainRecord(item['commit']) ? item['commit'] : undefined;
            if (commit && typeof commit['sha'] === 'string' && commit['sha'].length > 0) {
              fallbackSha = commit['sha'];
            }
          }
        }
        if (tagNames.length > 0) {
          return { version: selectLatestVersionTag(tagNames, upstream) };
        }
        if (fallbackSha !== undefined) return { version: fallbackSha };
        throw new TaskpackError('ACTION_INPUT_INVALID', `GitHub tags payload lacked tag name for ${upstream.source}`);
      }
      const sourceKind = validateGitRemoteSource(upstream.source, context.repositoryRoot);
      const gitSource = sourceKind === 'local-dir' && context.repositoryRoot !== undefined
        ? resolve(context.repositoryRoot, upstream.source)
        : upstream.source;
      const stdout = await runGitLsRemote(['ls-remote', '--tags', '--refs', '--', gitSource], timeoutMs, sourceKind);
      const tags = stdout
        .split(/\r?\n/)
        .map(line => line.trim())
        .filter(line => line.length > 0)
        .map(line => {
          const tabIdx = line.indexOf('\t');
          const refPart = tabIdx >= 0 ? line.slice(tabIdx + 1) : line;
          return refPart.replace(/^refs\/tags\//, '');
        })
        .filter(tag => tag.length > 0);
      if (tags.length === 0) {
        throw new TaskpackError('ACTION_INPUT_INVALID', `git ls-remote returned no tags for ${upstream.source}`);
      }
      return { version: selectLatestVersionTag(tags, upstream) };
    }

    case 'git-commit': {
      if (REPOSITORY_FULL_NAME_PATTERN.test(upstream.source)) {
        const url = `${apiBaseUrl}/repos/${upstream.source}/commits?per_page=1`;
        const res = await fetchJson(url, fetchImpl, githubHeaders, timeoutMs, scrubber);
        if (!res.ok || !Array.isArray(res.data) || res.data.length === 0 || !isPlainRecord(res.data[0])) {
          throw new TaskpackError('ACTION_INPUT_INVALID', `GitHub commits lookup failed (${res.status}) for ${upstream.source}`);
        }
        const sha = res.data[0]['sha'];
        if (typeof sha === 'string' && sha.length > 0) return { version: sha };
        throw new TaskpackError('ACTION_INPUT_INVALID', `GitHub commits payload lacked sha for ${upstream.source}`);
      }
      const sourceKind = validateGitRemoteSource(upstream.source, context.repositoryRoot);
      const gitSource = sourceKind === 'local-dir' && context.repositoryRoot !== undefined
        ? resolve(context.repositoryRoot, upstream.source)
        : upstream.source;
      const stdout = await runGitLsRemote(
        ['ls-remote', '--', gitSource, 'HEAD', 'refs/heads/main', 'refs/heads/master'],
        timeoutMs,
        sourceKind,
      );
      const refShas = new Map<string, string>();
      let firstSha: string | undefined;
      for (const rawLine of stdout.split(/\r?\n/)) {
        const trimmed = rawLine.trim();
        if (trimmed.length === 0) continue;
        const parts = trimmed.split(/\s+/);
        const sha = parts[0];
        if (!sha) {
          throw new TaskpackError('ACTION_INPUT_INVALID', `git ls-remote HEAD output malformed for ${upstream.source}`);
        }
        if (firstSha === undefined) firstSha = sha;
        const ref = parts[1];
        if (ref) refShas.set(ref, sha);
      }
      const sha = refShas.get('HEAD') ?? refShas.get('refs/heads/main') ?? refShas.get('refs/heads/master') ?? firstSha;
      if (sha === undefined) {
        throw new TaskpackError('ACTION_INPUT_INVALID', `git ls-remote returned no HEAD for ${upstream.source}`);
      }
      return { version: sha };
    }

    case 'http-json': {
      validateHttpUpstreamUrl(upstream.source, 'http-json');
      const res = await fetchJson(
        upstream.source,
        fetchImpl,
        { accept: 'application/json', 'user-agent': 'loopwright-taskpack' },
        timeoutMs,
        scrubber,
      );
      if (!res.ok) {
        throw new TaskpackError('ACTION_INPUT_INVALID', `http-json fetch failed (${res.status}) for ${upstream.id}`);
      }
      if (upstream.versionPath !== undefined) {
        const extracted = extractJsonVersionPath(res.data, upstream.versionPath);
        if (extracted === undefined) {
          throw new TaskpackError(
            'ACTION_INPUT_INVALID',
            `http-json versionPath "${upstream.versionPath}" did not resolve to a non-empty string for ${upstream.id}`,
          );
        }
        return { version: extracted };
      }
      if (isPlainRecord(res.data)) {
        for (const key of ['version', 'tag_name', 'latest', 'sha'] as const) {
          const candidate = res.data[key];
          if (typeof candidate === 'string' && candidate.trim().length > 0) {
            return { version: validateVersionStringField(candidate, `${upstream.id}.${key}`) };
          }
        }
      }
      return { version: createHash('sha256').update(res.rawText, 'utf8').digest('hex').slice(0, 16) };
    }

    case 'custom-table': {
      let rawBytes: Buffer;
      if (upstream.source.startsWith('http://') || upstream.source.startsWith('https://')) {
        validateHttpUpstreamUrl(upstream.source, 'custom-table');
        const res = await fetchBoundedText(
          upstream.source,
          fetchImpl,
          { accept: 'application/json, text/plain;q=0.9', 'user-agent': 'loopwright-taskpack' },
          timeoutMs,
          scrubber,
        );
        if (!res.ok) {
          throw new TaskpackError('ACTION_INPUT_INVALID', `custom-table fetch failed (${res.status}) for ${upstream.id}`);
        }
        rawBytes = Buffer.from(res.text, 'utf8');
      } else {
        if (context.repositoryRoot === undefined) {
          throw new TaskpackError('ACTION_INPUT_INVALID', `repositoryRoot is required to read local custom-table "${upstream.source}"`);
        }
        rawBytes = await readBoundedLocalFile(context.repositoryRoot, upstream.source, MAX_RESPONSE_BYTES);
      }
      try {
        const parsed = JSON.parse(rawBytes.toString('utf8')) as unknown;
        if (isPlainRecord(parsed) && typeof parsed['version'] === 'string' && parsed['version'].trim().length > 0) {
          return { version: parsed['version'].trim() };
        }
      } catch {
        // Non-JSON custom table: hash content below.
      }
      return { version: createHash('sha256').update(rawBytes).digest('hex').slice(0, 16) };
    }
  }
}

/**
 * Apply declarative `spec.upstreamGroups` (`lockstep` | `independent`) across resolved upstream
 * acquisition records (supports both HTTP-discovered and preflight-supplied records).
 */
export function applyUpstreamGroups(
  records: readonly UpstreamAcquisitionRecord[],
  groups: readonly TaskpackUpstreamGroupDeclaration[] | undefined,
  baselineVersions?: ReadonlyMap<string, string> | Readonly<Record<string, string>> | undefined,
): readonly UpstreamAcquisitionRecord[] {
  if (groups === undefined || groups.length === 0 || records.length === 0) {
    return Object.freeze([...records]);
  }

  const lookupBaseline = (upstreamId: string): string | undefined => {
    if (baselineVersions === undefined) return undefined;
    if (baselineVersions instanceof Map) return baselineVersions.get(upstreamId);
    const val = (baselineVersions as Readonly<Record<string, string>>)[upstreamId];
    return typeof val === 'string' && val.length > 0 ? val : undefined;
  };

  const byId = new Map<string, UpstreamAcquisitionRecord>();
  for (const record of records) {
    byId.set(record.upstreamId, record);
  }

  const overrides = new Map<string, UpstreamAcquisitionRecord>();

  for (const group of groups) {
    if (group.policy === 'independent') {
      for (const memberId of group.members) {
        const member = byId.get(memberId);
        if (member === undefined || member.groupId === group.id) continue;
        overrides.set(member.upstreamId, Object.freeze({
          ...member,
          groupId: group.id,
        }));
      }
      continue;
    }

    const presentMembers: UpstreamAcquisitionRecord[] = [];
    const issueReasons: string[] = [];

    for (const memberId of group.members) {
      const rec = byId.get(memberId);
      if (rec === undefined) {
        issueReasons.push(`missing upstream record for member "${memberId}"`);
      } else {
        presentMembers.push(rec);
      }
    }

    for (const member of presentMembers) {
      if (member.status === 'held_back' || member.status === 'blocked' || member.status === 'failed') {
        const detail = member.reason !== undefined && member.reason.length > 0 ? ` (${sanitizeSingleLine(member.reason)})` : '';
        issueReasons.push(`member "${member.upstreamId}" is ${member.status}${detail}`);
      } else if (typeof member.version !== 'string' || member.version.trim().length === 0) {
        issueReasons.push(`member "${member.upstreamId}" has no resolved target version`);
      }
    }

    if (issueReasons.length === 0) {
      const anyAvailable = presentMembers.some(member => member.status === 'available');
      if (anyAvailable) {
        const distinctTargetVersions = new Set<string>(presentMembers.map(member => member.version!));
        if (distinctTargetVersions.size > 1) {
          const breakdown = presentMembers
            .map(member => `${member.upstreamId}=${member.version ?? 'unknown'}[${member.status}]`)
            .join(', ');
          issueReasons.push(`member target versions disagree (${breakdown})`);
        }
      }
    }

    if (issueReasons.length > 0) {
      const groupReason = `lockstep group "${group.id}" held back: ${issueReasons.join('; ')}`;
      for (const memberId of group.members) {
        const member = byId.get(memberId);
        if (member === undefined) continue;
        const preservedCurrent = member.currentVersion
          ?? lookupBaseline(member.upstreamId)
          ?? (member.status === 'up_to_date' ? member.version : undefined);
        const skippedTarget = member.targetVersion
          ?? (member.status === 'available' ? member.version : undefined);
        const underlyingStatus: 'failed' | 'blocked' | undefined =
          member.status === 'failed' || member.status === 'blocked'
            ? member.status
            : member.underlyingStatus;
        overrides.set(member.upstreamId, Object.freeze({
          upstreamId: member.upstreamId,
          status: 'held_back' as const,
          ...(preservedCurrent !== undefined ? { version: preservedCurrent, currentVersion: preservedCurrent } : {}),
          ...(skippedTarget !== undefined ? { targetVersion: skippedTarget } : {}),
          ...(member.recentVersions !== undefined ? { recentVersions: member.recentVersions } : {}),
          ...(member.watchedPaths !== undefined ? { watchedPaths: member.watchedPaths } : {}),
          ...(member.metadata !== undefined ? { metadata: member.metadata } : {}),
          ...(underlyingStatus !== undefined ? { underlyingStatus } : {}),
          groupId: group.id,
          reason: groupReason,
        }));
      }
    } else {
      for (const member of presentMembers) {
        if (member.groupId === group.id) continue;
        overrides.set(member.upstreamId, Object.freeze({
          ...member,
          groupId: group.id,
        }));
      }
    }
  }

  if (overrides.size === 0) {
    return Object.freeze([...records]);
  }

  return Object.freeze(records.map(record => overrides.get(record.upstreamId) ?? record));
}

/** Propagate declared `watchedPaths` onto resolved upstream acquisition records without mutating inputs. */
export function attachUpstreamContext(
  records: readonly UpstreamAcquisitionRecord[],
  descriptors: readonly TaskpackUpstreamDescriptor[],
): readonly UpstreamAcquisitionRecord[] {
  if (records.length === 0 || descriptors.length === 0) {
    return Object.freeze([...records]);
  }
  const byId = new Map<string, TaskpackUpstreamDescriptor>();
  for (const descriptor of descriptors) {
    byId.set(descriptor.id, descriptor);
  }
  return Object.freeze(records.map(record => {
    const desc = byId.get(record.upstreamId);
    if (desc === undefined || (record.watchedPaths !== undefined && record.watchedPaths.length > 0)) {
      return record;
    }
    return Object.freeze({
      ...record,
      watchedPaths: Object.freeze([...desc.watchedPaths]),
    });
  }));
}

/** Evaluate overall intake disposition across upstream acquisition records. */
export function evaluateUpstreamIntakeDisposition(
  records: readonly UpstreamAcquisitionRecord[],
  options?: {
    readonly force?: boolean | undefined;
    readonly managedPrMatchesDiscoveredState?: boolean | undefined;
  },
): UpstreamIntakeDispositionResult {
  const available = Object.freeze(records.filter(record => record.status === 'available'));
  const heldBack = Object.freeze(records.filter(record => record.status === 'held_back'));
  const upToDate = Object.freeze(records.filter(record => record.status === 'up_to_date'));
  const failures = Object.freeze(records.filter(
    record => record.status === 'failed'
      || record.status === 'blocked'
      || record.underlyingStatus === 'failed'
      || record.underlyingStatus === 'blocked',
  ));

  if (available.length === 0 && failures.length > 0) {
    const failedSummary = failures
      .map(record => {
        const statusLabel = record.underlyingStatus ?? record.status;
        const detail = record.reason !== undefined && record.reason.length > 0 ? `: ${sanitizeSingleLine(record.reason)}` : '';
        return `${record.upstreamId}(${statusLabel}${detail})`;
      })
      .join('; ');
    return Object.freeze({
      disposition: 'blocked',
      reason: `upstream acquisition blocked: ${failedSummary}`,
      available,
      heldBack,
      upToDate,
      failures,
    });
  }

  if (options?.force !== true && available.length === 0) {
    const reason = heldBack.length > 0
      ? `no updates ready; held_back: ${heldBack.map(record => `${record.upstreamId}${record.reason ? ` (${sanitizeSingleLine(record.reason)})` : ''}`).join('; ')}`
      : 'no subscription reports an available update';
    return Object.freeze({
      disposition: 'no_change',
      reason,
      available,
      heldBack,
      upToDate,
      failures,
    });
  }

  if (options?.force !== true && options?.managedPrMatchesDiscoveredState === true) {
    return Object.freeze({
      disposition: 'no_change',
      reason: 'an open managed pull request already matches the discovered state',
      available,
      heldBack,
      upToDate,
      failures,
    });
  }

  const availablePart = available.length > 0
    ? `available: ${available.map(r => `${r.upstreamId}=${sanitizeSingleLine(r.version ?? 'unknown')}`).join(', ')}`
    : 'forced candidate run';
  const heldBackPart = heldBack.length > 0
    ? `; held_back: ${heldBack.map(r => `${r.upstreamId}${r.currentVersion ? `@${sanitizeSingleLine(r.currentVersion)}` : ''}`).join(', ')}`
    : '';

  return Object.freeze({
    disposition: 'candidate',
    reason: `${availablePart}${heldBackPart}`,
    available,
    heldBack,
    upToDate,
    failures,
  });
}

/**
 * Build deterministic sorted `{ upstreamId: version }` metadata for reviewed memory while keeping
 * `held_back` upstreams pinned to `currentVersion` (never substituting a skipped target version).
 */
export function buildUpstreamMemoryVersions(
  records: readonly UpstreamAcquisitionRecord[] | undefined,
): Readonly<Record<string, string>> {
  const out: Record<string, string> = Object.create(null) as Record<string, string>;
  if (records === undefined || records.length === 0) {
    return Object.freeze(out);
  }
  const sorted = [...records].sort((a, b) => (a.upstreamId < b.upstreamId ? -1 : a.upstreamId > b.upstreamId ? 1 : 0));
  let count = 0;
  for (const record of sorted) {
    if (count >= 128) break;
    let chosen: string | undefined;
    if (record.status === 'held_back') {
      chosen = record.currentVersion;
    } else if (record.status === 'failed' || record.status === 'blocked') {
      chosen = record.currentVersion;
    } else {
      chosen = record.version ?? record.currentVersion;
    }
    if (typeof chosen === 'string' && chosen.length > 0 && chosen.length <= 256) {
      out[record.upstreamId] = chosen;
      count += 1;
    }
  }
  return Object.freeze(out);
}

/** Format a concise multi-line upstream summary including `held_back` reasons and `watchedPaths`. */
export function formatUpstreamSummary(
  records: readonly UpstreamAcquisitionRecord[],
  descriptors?: readonly TaskpackUpstreamDescriptor[],
): string {
  const enriched = descriptors !== undefined ? attachUpstreamContext(records, descriptors) : records;
  if (enriched.length === 0) return 'upstreams: none';
  const lines = enriched.map(record => {
    const parts: string[] = [`- ${record.upstreamId}: status=${record.status}`];
    if (record.currentVersion !== undefined) {
      parts.push(`current=${record.currentVersion}`);
    }
    if (record.status === 'held_back') {
      if (record.targetVersion !== undefined) {
        parts.push(`skippedTarget=${record.targetVersion}`);
      }
    } else if (record.version !== undefined) {
      parts.push(`version=${record.version}`);
    }
    if (record.groupId !== undefined) {
      parts.push(`group=${record.groupId}`);
    }
    if (record.watchedPaths !== undefined && record.watchedPaths.length > 0) {
      parts.push(`watchedPaths=[${record.watchedPaths.join(', ')}]`);
    }
    if (record.reason !== undefined && record.reason.length > 0) {
      parts.push(`reason=${sanitizeSingleLine(record.reason)}`);
    }
    return parts.join(' ');
  });
  return lines.join('\n');
}

async function readOptionalLocalJsonFile(
  repositoryRoot: string,
  relPath: string,
  maxBytes: number,
  parseJson: boolean,
): Promise<unknown | undefined> {
  const resolvedBase = resolve(repositoryRoot);
  const fullPath = resolve(resolvedBase, relPath);
  assertNoSymlinkSegments(resolvedBase, fullPath);
  try {
    const info = await lstat(fullPath);
    if (info.isSymbolicLink()) {
      throw new TaskpackError('TASKPACK_SCOPE_VIOLATION', `baseline file "${relPath}" must not be a symbolic link`);
    }
  } catch (error) {
    if (error instanceof TaskpackError) throw error;
    const code = (error as NodeJS.ErrnoException | null)?.code;
    if (code === 'ENOENT') {
      return undefined;
    }
    if (code === 'ELOOP') {
      throw new TaskpackError('TASKPACK_SCOPE_VIOLATION', `baseline file "${relPath}" traverses a symbolic link`);
    }
    const detail = error instanceof Error ? error.message : String(error);
    throw new TaskpackError('ACTION_INPUT_INVALID', `failed to inspect baseline file "${relPath}": ${detail}`);
  }

  let bytes: Buffer;
  try {
    bytes = await readBoundedLocalFile(repositoryRoot, relPath, maxBytes);
  } catch (error) {
    if (error instanceof TaskpackError) throw error;
    const code = (error as NodeJS.ErrnoException | null)?.code;
    if (code === 'ENOENT') {
      return undefined;
    }
    if (code === 'ELOOP') {
      throw new TaskpackError('TASKPACK_SCOPE_VIOLATION', `baseline file "${relPath}" traverses a symbolic link`);
    }
    const detail = error instanceof Error ? error.message : String(error);
    throw new TaskpackError('ACTION_INPUT_INVALID', `failed to read baseline file "${relPath}": ${detail}`);
  }

  if (!parseJson) {
    return undefined;
  }

  try {
    return JSON.parse(bytes.toString('utf8')) as unknown;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new TaskpackError('ACTION_INPUT_INVALID', `baseline file "${relPath}" contains malformed JSON: ${detail}`);
  }
}

export function extractBaselineVersionsFromDocument(
  manifest: TaskpackManifest | TaskpackV2Manifest,
  parsed: unknown,
  sourceKind: 'proposal' | 'package-json',
): ReadonlyMap<string, string> {
  return sourceKind === 'proposal'
    ? readBaselineVersions(parsed, manifest.spec.upstreams)
    : readPackageJsonBaselineVersions(parsed, manifest.spec.upstreams);
}

/**
 * Load baseline upstream versions from `spec.proposal.path` (or `package.json` when `spec.proposal`
 * is omitted), merged with any explicit `baselineVersions` overrides.
 */
export async function loadRepositoryBaselineVersions(
  manifest: TaskpackManifest | TaskpackV2Manifest,
  repositoryRoot?: string | undefined,
  explicitBaselines?: Readonly<Record<string, string>> | ReadonlyMap<string, string> | undefined,
): Promise<ReadonlyMap<string, string>> {
  const baselines = new Map<string, string>();
  if (repositoryRoot !== undefined) {
    const proposal = manifest.spec.proposal;
    if (proposal !== undefined) {
      const isJsonProposal = proposal.path.toLowerCase().endsWith('.json');
      const parsed = await readOptionalLocalJsonFile(repositoryRoot, proposal.path, MAX_PROPOSAL_BYTES, isJsonProposal);
      if (parsed !== undefined) {
        for (const [id, ver] of readBaselineVersions(parsed, manifest.spec.upstreams)) {
          baselines.set(id, ver);
        }
      }
    } else {
      const parsed = await readOptionalLocalJsonFile(repositoryRoot, 'package.json', MAX_PROPOSAL_BYTES, true);
      if (parsed !== undefined) {
        for (const [id, ver] of readPackageJsonBaselineVersions(parsed, manifest.spec.upstreams)) {
          baselines.set(id, ver);
        }
      }
    }
  }
  if (explicitBaselines !== undefined) {
    if (explicitBaselines instanceof Map) {
      for (const [id, ver] of explicitBaselines.entries()) {
        if (typeof ver === 'string' && ver.length > 0) baselines.set(id, ver);
      }
    } else {
      for (const [id, ver] of Object.entries(explicitBaselines)) {
        if (typeof ver === 'string' && ver.length > 0) baselines.set(id, ver);
      }
    }
  }
  return baselines;
}

/**
 * Discover upstream states declared by a Taskpack manifest and compare against
 * any existing proposal file (or `package.json` / explicit `baselineVersions` when `spec.proposal`
 * is omitted), enforcing `http-json` `versionPath`, `monotonicSemver`, and `spec.upstreamGroups`.
 */
export async function discoverTaskpackUpstreams(
  manifest: TaskpackManifest | TaskpackV2Manifest,
  options: DiscoverTaskpackUpstreamsOptions = {},
): Promise<readonly UpstreamAcquisitionRecord[]> {
  if (options.upstreamRecordsJson !== undefined && options.upstreamRecordsJson.trim().length > 0) {
    const parsed = parseUpstreamRecordsJson(options.upstreamRecordsJson);
    const withContext = options.includeMetadata === true
      ? attachUpstreamContext(parsed, manifest.spec.upstreams)
      : parsed;
    const baselines = manifest.spec.upstreamGroups !== undefined && manifest.spec.upstreamGroups.length > 0
      ? await loadRepositoryBaselineVersions(
        manifest,
        options.skipWorkingTreeBaselines === true ? undefined : options.repositoryRoot,
        options.baselineVersions,
      )
      : undefined;
    return applyUpstreamGroups(withContext, manifest.spec.upstreamGroups, baselines);
  }
  if (manifest.spec.upstreams.length === 0) {
    return Object.freeze([]);
  }

  const scrubber = options.scrubber ?? new SecretScrubber();
  const apiBaseUrl = defaultApiBaseUrl(options.apiBaseUrl, options.env);
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const timeoutMs = options.timeoutMs ?? 15_000;
  const githubHeaders = await resolveAuthHeaders(
    options.githubToken,
    options.authHeaders,
    { accept: 'application/vnd.github+json', 'user-agent': 'loopwright-taskpack' },
    scrubber,
  );

  const baselines = await loadRepositoryBaselineVersions(
    manifest,
    options.skipWorkingTreeBaselines === true ? undefined : options.repositoryRoot,
    options.baselineVersions,
  );

  const includeMetadata = options.includeMetadata === true;
  const records: UpstreamAcquisitionRecord[] = [];
  for (const upstream of manifest.spec.upstreams) {
    const baseline = baselines.get(upstream.id);
    try {
      const resolved = await resolveSingleUpstreamDetails(upstream, {
        repositoryRoot: options.repositoryRoot,
        apiBaseUrl,
        githubHeaders,
        fetchImpl,
        timeoutMs,
        scrubber,
      });

      let status: UpstreamAcquisitionStatus;
      let effectiveVersion: string | undefined = resolved.version;
      let targetVersion: string | undefined;
      let reason: string | undefined;

      if (upstream.kind === 'http-json') {
        const monotonic = upstream.monotonicSemver ?? true;
        if (baseline === undefined) {
          status = 'available';
        } else if (baseline === resolved.version) {
          status = 'up_to_date';
        } else if (monotonic) {
          const strictCmp = compareStrictSemver(resolved.version, baseline);
          if (strictCmp !== null && strictCmp < 0) {
            status = 'held_back';
            effectiveVersion = baseline;
            targetVersion = resolved.version;
            reason = `downgrade prevented by monotonicSemver: fetched ${resolved.version} is lower than current ${baseline}`;
          } else if (strictCmp === 0 && !baseline.includes('+') && !resolved.version.includes('+')) {
            status = 'up_to_date';
          } else {
            status = 'available';
          }
        } else {
          status = 'available';
        }
      } else {
        const isSemverTagKind = upstream.kind === 'github-release' || upstream.kind === 'git-tag';
        const cmp = isSemverTagKind && baseline !== undefined && parseSemverTag(baseline) !== null && parseSemverTag(resolved.version) !== null
          ? compareVersionTags(resolved.version, baseline)
          : null;
        const upToDateBySemver = cmp !== null && (
          cmp < 0
          || (cmp === 0 && !baseline!.includes('+') && !resolved.version.includes('+'))
        );
        status = baseline !== undefined && (baseline === resolved.version || upToDateBySemver)
          ? 'up_to_date'
          : 'available';
      }

      const emitMetadata = includeMetadata || status === 'held_back';
      records.push({
        upstreamId: upstream.id,
        status,
        ...(effectiveVersion !== undefined ? { version: effectiveVersion } : {}),
        ...(emitMetadata && baseline !== undefined ? { currentVersion: baseline } : {}),
        ...(targetVersion !== undefined ? { targetVersion } : {}),
        ...(resolved.recentVersions !== undefined ? { recentVersions: resolved.recentVersions } : {}),
        ...(includeMetadata ? { watchedPaths: Object.freeze([...upstream.watchedPaths]) } : {}),
        ...(reason !== undefined ? { reason } : {}),
      });
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      records.push({
        upstreamId: upstream.id,
        status: 'failed',
        ...(includeMetadata && baseline !== undefined ? { currentVersion: baseline } : {}),
        ...(includeMetadata ? { watchedPaths: Object.freeze([...upstream.watchedPaths]) } : {}),
        reason: scrubber.scrub(detail),
      });
    }
  }
  return applyUpstreamGroups(Object.freeze(records), manifest.spec.upstreamGroups, baselines);
}

/**
 * Taskpack 2.0 upstream discovery entrypoint returning enriched records (with `watchedPaths`,
 * `currentVersion`, `targetVersion`, `groupId`), evaluated disposition, prompt summary, and
 * reviewed-memory version map (`held_back` pinned to `currentVersion`).
 */
export async function discoverTaskpackUpstreamsV2(
  manifest: TaskpackManifest | TaskpackV2Manifest,
  options: DiscoverTaskpackUpstreamsOptions & {
    readonly force?: boolean | undefined;
    readonly managedPrMatchesDiscoveredState?: boolean | undefined;
  } = {},
): Promise<DiscoverTaskpackUpstreamsV2Result> {
  const records = await discoverTaskpackUpstreams(manifest, {
    ...options,
    includeMetadata: true,
  });
  const evaluated = evaluateUpstreamIntakeDisposition(records, {
    force: options.force,
    managedPrMatchesDiscoveredState: options.managedPrMatchesDiscoveredState,
  });
  return Object.freeze({
    records,
    disposition: evaluated.disposition,
    reason: evaluated.reason,
    summary: formatUpstreamSummary(records, manifest.spec.upstreams),
    memoryVersions: buildUpstreamMemoryVersions(records),
  });
}

export const MEMORY_PULL_REQUEST_BRANCH_PREFIX = 'loopwright/memory/' as const;

export interface FindOpenMemoryPullRequestOptions {
  readonly apiBaseUrl?: string | undefined;
  readonly repositoryFullName: string;
  readonly targetBranch: string;
  readonly memoryBranch: string;
  readonly githubToken?: UpstreamTokenResolver | undefined;
  readonly authHeaders?: UpstreamHeadersResolver | undefined;
  readonly fetchImpl?: typeof globalThis.fetch | undefined;
  readonly scrubber?: SecretScrubber | undefined;
  readonly env?: NodeJS.ProcessEnv | undefined;
  readonly timeoutMs?: number | undefined;
}

/**
 * Look up an open pull request against `targetBranch` whose head ref begins
 * with `headBranchPrefix`.
 */
export async function findOpenManagedPullRequest(
  options: FindOpenManagedPullRequestOptions,
): Promise<ManagedPullRequestInfo | null> {
  if (!REPOSITORY_FULL_NAME_PATTERN.test(options.repositoryFullName)) {
    throw new TaskpackError('ACTION_INPUT_INVALID', `invalid repositoryFullName "${options.repositoryFullName}"`);
  }
  const scrubber = options.scrubber ?? new SecretScrubber();
  const apiBaseUrl = defaultApiBaseUrl(options.apiBaseUrl, options.env);
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const timeoutMs = options.timeoutMs ?? 15_000;
  const headers = await resolveAuthHeaders(
    options.githubToken,
    options.authHeaders,
    { accept: 'application/vnd.github+json', 'user-agent': 'loopwright-taskpack' },
    scrubber,
  );

  let confirmedAbsence = false;
  for (let page = 1; page <= 5; page += 1) {
    const url = `${apiBaseUrl}/repos/${options.repositoryFullName}/pulls?state=open&base=${encodeURIComponent(options.targetBranch)}&per_page=100&page=${page}`;
    const res = await fetchJson(url, fetchImpl, headers, timeoutMs, scrubber);
    if (!res.ok) {
      throw new TaskpackError(
        'ACTION_INPUT_INVALID',
        `open pull requests lookup failed (${res.status}) for ${options.repositoryFullName}`,
      );
    }
    if (!Array.isArray(res.data)) {
      throw new TaskpackError('ACTION_INPUT_INVALID', 'GitHub pulls response must be an array');
    }

    for (const item of res.data) {
      if (!isPlainRecord(item)) continue;
      const head = isPlainRecord(item['head']) ? item['head'] : undefined;
      const base = isPlainRecord(item['base']) ? item['base'] : undefined;
      const headRepo = head?.['repo'];
      const headRepoValid = headRepo === undefined || headRepo === null || (
        isPlainRecord(headRepo)
        && headRepo['fork'] !== true
        && typeof headRepo['full_name'] === 'string'
        && headRepo['full_name'].toLowerCase() === options.repositoryFullName.toLowerCase()
      );
      if (!headRepoValid) continue;

      const headRef = head?.['ref'];
      const headSha = head?.['sha'];
      const baseRef = base?.['ref'];
      const baseSha = base?.['sha'];
      const prNumber = item['number'];
      const htmlUrl = item['html_url'];
      const title = item['title'];
      const body = item['body'];
      if (
        typeof headRef === 'string'
        && headRef.startsWith(options.headBranchPrefix)
        && (options.headBranchPrefix.startsWith(MEMORY_PULL_REQUEST_BRANCH_PREFIX) || !headRef.startsWith(MEMORY_PULL_REQUEST_BRANCH_PREFIX))
        && typeof headSha === 'string'
        && typeof baseRef === 'string'
        && typeof baseSha === 'string'
        && typeof prNumber === 'number'
        && Number.isSafeInteger(prNumber)
        && prNumber > 0
        && typeof htmlUrl === 'string'
        && typeof title === 'string'
      ) {
        return {
          number: prNumber,
          htmlUrl,
          headRef,
          headSha,
          baseRef,
          baseSha,
          title,
          body: typeof body === 'string' ? body : null,
        };
      }
    }

    if (res.data.length < 100) {
      confirmedAbsence = true;
      break;
    }
  }

  if (!confirmedAbsence) {
    throw new TaskpackError(
      'ACTION_INPUT_INVALID',
      `open pull requests lookup exhausted pagination (500 open pull requests) for ${options.repositoryFullName} without confirming absence`,
    );
  }

  return null;
}

/**
 * Look up an existing open dedicated memory pull request whose same-repository
 * `head.ref` exactly equals `memoryBranch` targeting `targetBranch`.
 */
export async function findOpenMemoryPullRequest(
  options: FindOpenMemoryPullRequestOptions,
): Promise<ManagedPullRequestInfo | null> {
  if (!REPOSITORY_FULL_NAME_PATTERN.test(options.repositoryFullName)) {
    throw new TaskpackError('ACTION_INPUT_INVALID', `invalid repositoryFullName "${options.repositoryFullName}"`);
  }
  const scrubber = options.scrubber ?? new SecretScrubber();
  const apiBaseUrl = defaultApiBaseUrl(options.apiBaseUrl, options.env);
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const timeoutMs = options.timeoutMs ?? 15_000;
  const headers = await resolveAuthHeaders(
    options.githubToken,
    options.authHeaders,
    { accept: 'application/vnd.github+json', 'user-agent': 'loopwright-taskpack' },
    scrubber,
  );

  const slashIndex = options.repositoryFullName.indexOf('/');
  const owner = options.repositoryFullName.slice(0, slashIndex);
  const headQuery = `${owner}:${options.memoryBranch}`;
  let confirmedAbsence = false;

  for (let page = 1; page <= 5; page += 1) {
    const url = `${apiBaseUrl}/repos/${options.repositoryFullName}/pulls?state=open&head=${encodeURIComponent(headQuery)}&base=${encodeURIComponent(options.targetBranch)}&per_page=100&page=${page}`;
    const res = await fetchJson(url, fetchImpl, headers, timeoutMs, scrubber);
    if (!res.ok) {
      throw new TaskpackError(
        'ACTION_INPUT_INVALID',
        `open memory pull requests lookup failed (${res.status}) for ${options.repositoryFullName}`,
      );
    }
    if (!Array.isArray(res.data)) {
      throw new TaskpackError('ACTION_INPUT_INVALID', 'GitHub pulls response must be an array');
    }

    for (const item of res.data) {
      if (!isPlainRecord(item)) continue;
      if (item['state'] !== undefined && item['state'] !== 'open') continue;
      const head = isPlainRecord(item['head']) ? item['head'] : undefined;
      const base = isPlainRecord(item['base']) ? item['base'] : undefined;
      const headRepo = head?.['repo'];
      const baseRepo = base?.['repo'];
      const headRepoValid =
        isPlainRecord(headRepo)
        && typeof headRepo['full_name'] === 'string'
        && headRepo['full_name'].toLowerCase() === options.repositoryFullName.toLowerCase();
      if (!headRepoValid) continue;
      if (baseRepo !== undefined) {
        if (
          !isPlainRecord(baseRepo)
          || typeof baseRepo['full_name'] !== 'string'
          || baseRepo['full_name'].toLowerCase() !== options.repositoryFullName.toLowerCase()
        ) {
          continue;
        }
        if (
          typeof headRepo['id'] === 'number'
          && typeof baseRepo['id'] === 'number'
          && headRepo['id'] !== baseRepo['id']
        ) {
          continue;
        }
      }

      const headRef = head?.['ref'];
      const headSha = head?.['sha'];
      const baseRef = base?.['ref'];
      const baseSha = base?.['sha'];
      const prNumber = item['number'];
      const htmlUrl = item['html_url'];
      const title = item['title'];
      const body = item['body'];
      if (
        typeof headRef === 'string'
        && headRef === options.memoryBranch
        && typeof headSha === 'string'
        && typeof baseRef === 'string'
        && baseRef === options.targetBranch
        && typeof prNumber === 'number'
        && Number.isSafeInteger(prNumber)
        && prNumber > 0
        && typeof htmlUrl === 'string'
      ) {
        return {
          number: prNumber,
          htmlUrl,
          headRef,
          headSha,
          baseRef,
          baseSha: typeof baseSha === 'string' ? baseSha : '',
          title: typeof title === 'string' ? title : '',
          body: typeof body === 'string' ? body : null,
        };
      }
    }

    if (res.data.length < 100) {
      confirmedAbsence = true;
      break;
    }
  }

  if (!confirmedAbsence) {
    throw new TaskpackError(
      'ACTION_INPUT_INVALID',
      `open memory pull requests lookup exhausted pagination (500 open pull requests) for ${options.repositoryFullName} without confirming absence`,
    );
  }

  return null;
}

function extractPrNumberFromPayload(payload: unknown): number | undefined {
  if (!isPlainRecord(payload)) return undefined;
  const pr = payload['pull_request'];
  if (isPlainRecord(pr) && typeof pr['number'] === 'number' && Number.isSafeInteger(pr['number']) && pr['number'] > 0) {
    return pr['number'];
  }
  const issue = payload['issue'];
  if (
    isPlainRecord(issue)
    && isPlainRecord(issue['pull_request'])
    && typeof issue['number'] === 'number'
    && Number.isSafeInteger(issue['number'])
    && issue['number'] > 0
  ) {
    return issue['number'];
  }
  return undefined;
}

function extractRepositoryIdFromPayload(payload: unknown): number | undefined {
  if (!isPlainRecord(payload)) return undefined;
  const repo = payload['repository'];
  if (isPlainRecord(repo) && typeof repo['id'] === 'number' && Number.isSafeInteger(repo['id']) && repo['id'] > 0) {
    return repo['id'];
  }
  return undefined;
}

/**
 * Verify and resolve a Git commit reference or SHA against local `repositoryRoot`
 * using `git rev-parse --verify` so nonexistent SHAs and missing refs fail closed.
 */
export async function resolveGitCommitSha(
  repositoryRoot: string,
  ref: string,
  timeoutMs = 15_000,
): Promise<string> {
  if (!SAFE_GIT_REF_PATTERN.test(ref) || ref.startsWith('-')) {
    throw new TaskpackError('ACTION_INPUT_INVALID', `invalid git revision reference "${ref}"`);
  }
  const gitBin = resolveGitExecutable();
  try {
    const { stdout } = await execFileAsync(
      gitBin,
      ['-C', repositoryRoot, 'rev-parse', '--verify', '--end-of-options', `${ref}^{commit}`],
      { env: buildCleanGitEnv(), timeout: timeoutMs, maxBuffer: 4096, encoding: 'utf8' },
    );
    const sha = stdout.trim().toLowerCase();
    if (!COMMIT_SHA_PATTERN.test(sha)) {
      throw new TaskpackError('ACTION_INPUT_INVALID', `git rev-parse returned invalid commit sha "${sha}" for "${ref}"`);
    }
    return sha;
  } catch (error) {
    if (error instanceof TaskpackError) throw error;
    const detail = error instanceof Error ? error.message : String(error);
    throw new TaskpackError('ACTION_INPUT_INVALID', `failed to resolve git revision "${ref}": ${detail}`);
  }
}

async function resolveGitRevisionSha(repositoryRoot: string, ref: string, timeoutMs: number): Promise<string> {
  if (COMMIT_SHA_PATTERN.test(ref)) {
    return ref.toLowerCase();
  }
  return resolveGitCommitSha(repositoryRoot, ref, timeoutMs);
}

export function shouldPreserveExplicitSourceRevision(options: {
  readonly eventName: string;
  readonly explicitSourceRevision?: string | undefined;
  readonly commentCommand?: string | undefined;
}): boolean {
  return options.eventName === 'issue_comment'
    && options.explicitSourceRevision !== undefined
    && options.explicitSourceRevision.trim().length > 0
    && options.commentCommand === 'retry';
}

/**
 * Resolve `baseRevision` and `sourceRevision` to 40-hex commit SHAs (using PR API
 * on comment/review events when needed and `git rev-parse --verify` locally), and
 * resolve positive `repositoryId`.
 */
export async function resolveRepositoryAndRevisions(
  options: ResolveRepositoryAndRevisionsOptions,
): Promise<ResolvedRepositoryAndRevisions> {
  const scrubber = options.scrubber ?? new SecretScrubber();
  const apiBaseUrl = options.apiBaseUrl?.trim() || options.env?.['GITHUB_API_URL']?.trim();
  const normalizedApiBase = apiBaseUrl ? apiBaseUrl.replace(/\/+$/, '') : undefined;
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const timeoutMs = options.timeoutMs ?? 15_000;
  const headers = await resolveAuthHeaders(
    options.githubToken,
    options.authHeaders,
    { accept: 'application/vnd.github+json', 'user-agent': 'loopwright-taskpack' },
    scrubber,
  );

  let baseRev = options.baseRevision;
  let sourceRev = options.sourceRevision ?? options.baseRevision;
  let resolvedFromPr = false;
  const preserveExplicitOnComment = options.preserveExplicitSourceRevision === true
    && options.sourceRevision !== undefined
    && options.sourceRevision.trim().length > 0;

  if (!preserveExplicitOnComment && (options.eventName === 'issue_comment' || options.eventName === 'pull_request_review')) {
    const prNumber = extractPrNumberFromPayload(options.eventPayload);
    const payloadPr = isPlainRecord(options.eventPayload) && isPlainRecord(options.eventPayload['pull_request'])
      ? options.eventPayload['pull_request']
      : undefined;

    if (prNumber !== undefined && normalizedApiBase !== undefined) {
      if (!REPOSITORY_FULL_NAME_PATTERN.test(options.repositoryFullName)) {
        throw new TaskpackError(
          'ACTION_INPUT_INVALID',
          `invalid repositoryFullName "${options.repositoryFullName}" for pull request lookup`,
        );
      }
      const res = await fetchJson(
        `${normalizedApiBase}/repos/${options.repositoryFullName}/pulls/${prNumber}`,
        fetchImpl,
        headers,
        timeoutMs,
        scrubber,
      );
      if (!res.ok || !isPlainRecord(res.data)) {
        throw new TaskpackError(
          'ACTION_INPUT_INVALID',
          `pull request #${prNumber} lookup failed (${res.status}) for ${options.repositoryFullName}`,
        );
      }
      const baseObj = isPlainRecord(res.data['base']) ? res.data['base'] : undefined;
      const headObj = isPlainRecord(res.data['head']) ? res.data['head'] : undefined;
      const fetchedBaseSha = baseObj?.['sha'];
      const fetchedHeadSha = headObj?.['sha'];
      if (
        typeof fetchedBaseSha !== 'string'
        || !COMMIT_SHA_PATTERN.test(fetchedBaseSha)
        || typeof fetchedHeadSha !== 'string'
        || !COMMIT_SHA_PATTERN.test(fetchedHeadSha)
      ) {
        throw new TaskpackError(
          'ACTION_INPUT_INVALID',
          `pull request #${prNumber} response missing valid 40-hex base/head SHAs`,
        );
      }
      baseRev = fetchedBaseSha.toLowerCase();
      sourceRev = fetchedHeadSha.toLowerCase();
      resolvedFromPr = true;
    } else if (payloadPr !== undefined) {
      const baseObj = isPlainRecord(payloadPr['base']) ? payloadPr['base'] : undefined;
      const headObj = isPlainRecord(payloadPr['head']) ? payloadPr['head'] : undefined;
      const payloadBaseSha = baseObj?.['sha'];
      const payloadHeadSha = headObj?.['sha'];
      if (baseObj !== undefined || headObj !== undefined) {
        if (
          typeof payloadBaseSha !== 'string'
          || !COMMIT_SHA_PATTERN.test(payloadBaseSha)
          || typeof payloadHeadSha !== 'string'
          || !COMMIT_SHA_PATTERN.test(payloadHeadSha)
        ) {
          throw new TaskpackError(
            'ACTION_INPUT_INVALID',
            'event pull_request payload base/head SHAs must be 40-hex commit SHAs',
          );
        }
        baseRev = payloadBaseSha.toLowerCase();
        sourceRev = payloadHeadSha.toLowerCase();
        resolvedFromPr = true;
      }
    }
  }

  const resolvedBase = await resolveGitRevisionSha(options.repositoryRoot, baseRev, timeoutMs);
  const verifyExplicitSourceLocally = !resolvedFromPr
    && options.sourceRevision !== undefined
    && options.sourceRevision.trim().length > 0
    && existsSync(join(options.repositoryRoot, '.git'));
  let resolvedSource: string;
  if (verifyExplicitSourceLocally) {
    resolvedSource = await resolveGitCommitSha(options.repositoryRoot, sourceRev, timeoutMs);
  } else if (sourceRev === baseRev) {
    resolvedSource = resolvedBase;
  } else {
    resolvedSource = await resolveGitRevisionSha(options.repositoryRoot, sourceRev, timeoutMs);
  }

  let repositoryId: number | undefined;
  const envRepoIdRaw = options.env?.['GITHUB_REPOSITORY_ID']?.trim();
  if (envRepoIdRaw !== undefined && /^\d+$/.test(envRepoIdRaw)) {
    const parsed = Number.parseInt(envRepoIdRaw, 10);
    if (Number.isSafeInteger(parsed) && parsed > 0) {
      repositoryId = parsed;
    }
  }
  if (repositoryId === undefined) {
    repositoryId = extractRepositoryIdFromPayload(options.eventPayload);
  }
  if (repositoryId === undefined) {
    if (normalizedApiBase !== undefined) {
      if (!REPOSITORY_FULL_NAME_PATTERN.test(options.repositoryFullName)) {
        throw new TaskpackError(
          'ACTION_INPUT_INVALID',
          `invalid repositoryFullName "${options.repositoryFullName}" for repository ID lookup`,
        );
      }
      const res = await fetchJson(
        `${normalizedApiBase}/repos/${options.repositoryFullName}`,
        fetchImpl,
        headers,
        timeoutMs,
        scrubber,
      );
      if (
        !res.ok
        || !isPlainRecord(res.data)
        || typeof res.data['id'] !== 'number'
        || !Number.isSafeInteger(res.data['id'])
        || res.data['id'] <= 0
      ) {
        throw new TaskpackError(
          'ACTION_INPUT_INVALID',
          `GitHub repository lookup failed (${res.status}) or returned invalid repository id for ${options.repositoryFullName}`,
        );
      }
      repositoryId = res.data['id'];
    } else {
      repositoryId = 1;
    }
  }

  return {
    repositoryId,
    baseRevision: resolvedBase,
    sourceRevision: resolvedSource,
  };
}

function parsePositiveSafeInt(raw: string | number): number | null {
  if (typeof raw === 'number') {
    return Number.isSafeInteger(raw) && raw > 0 ? raw : null;
  }
  const trimmed = String(raw).trim();
  if (!/^\d+$/.test(trimmed)) {
    return null;
  }
  const parsed = Number.parseInt(trimmed, 10);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

async function resolveGitHubAuthInternal(
  options: ResolveActionGitHubAuthOptions,
  resolveCommitIdentity: boolean,
): Promise<ResolvedActionGitHubAuth> {
  const scrubber = options.scrubber ?? new SecretScrubber();
  const explicitName = parseOptionalGitIdentityInput(
    options.gitAuthorName,
    options.env?.['INPUT_GIT-AUTHOR-NAME'],
    validateGitAuthorName,
  );
  const explicitEmail = parseOptionalGitIdentityInput(
    options.gitAuthorEmail,
    options.env?.['INPUT_GIT-AUTHOR-EMAIL'],
    validateGitAuthorEmail,
  );
  const shouldLookupDynamicIdentity = resolveCommitIdentity && (explicitName === undefined || explicitEmail === undefined);
  const finalizeIdentity = (resolved: GitCommitIdentity): GitCommitIdentity => Object.freeze({
    name: explicitName ?? resolved.name,
    email: explicitEmail ?? resolved.email,
  });

  const rawPrivateKey = options.appPrivateKey?.trim() || options.env?.['INPUT_GITHUB-APP-PRIVATE-KEY']?.trim() || undefined;
  if (rawPrivateKey !== undefined) {
    scrubber.register(rawPrivateKey);
  }
  const ambientToken = options.env?.['GITHUB_TOKEN']?.trim() || undefined;
  if (ambientToken !== undefined) {
    scrubber.register(ambientToken);
  }

  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const resolveNoreplyIdentityFromUserEndpoint = async (
    url: string,
    bearerToken: string,
  ): Promise<GitCommitIdentity | undefined> => {
    try {
      const res = await fetchJson(
        url,
        fetchImpl,
        {
          accept: 'application/vnd.github+json',
          authorization: `Bearer ${bearerToken}`,
          'user-agent': 'loopwright-taskpack',
        },
        10_000,
        scrubber,
      );
      if (!res.ok || !isPlainRecord(res.data)) return undefined;
      const id = res.data['id'];
      const login = res.data['login'];
      if (
        typeof id !== 'number'
        || !Number.isSafeInteger(id)
        || id <= 0
        || typeof login !== 'string'
        || login.trim().length === 0
      ) {
        return undefined;
      }
      const cleanLogin = login.trim();
      return validateGitCommitIdentity({
        name: cleanLogin,
        email: `${id}+${cleanLogin}@users.noreply.github.com`,
      });
    } catch {
      return undefined;
    }
  };

  // 1) Explicit token input
  const explicitToken = options.githubToken?.trim() || options.env?.['INPUT_GITHUB-TOKEN']?.trim() || undefined;
  if (explicitToken !== undefined) {
    scrubber.register(explicitToken);
    let resolvedIdentity = DEFAULT_GIT_COMMIT_IDENTITY;
    if (shouldLookupDynamicIdentity) {
      const explicitApiBase = (options.apiBaseUrl?.trim() || options.env?.['GITHUB_API_URL']?.trim())?.replace(/\/+$/, '');
      if (explicitApiBase && explicitApiBase.length > 0) {
        resolvedIdentity = (await resolveNoreplyIdentityFromUserEndpoint(`${explicitApiBase}/user`, explicitToken))
          ?? DEFAULT_GIT_COMMIT_IDENTITY;
      }
    }
    return {
      token: explicitToken,
      gitCommitIdentity: finalizeIdentity(resolvedIdentity),
    };
  }

  // 2) GitHub App credentials via injected JWT signer
  const rawAppId = options.appId !== undefined && (typeof options.appId === 'number' || options.appId.trim().length > 0)
    ? options.appId
    : (options.env?.['INPUT_GITHUB-APP-ID']?.trim() || undefined);
  const rawInstallationId = options.appInstallationId !== undefined
    && (typeof options.appInstallationId === 'number' || options.appInstallationId.trim().length > 0)
    ? options.appInstallationId
    : (options.env?.['INPUT_GITHUB-APP-INSTALLATION-ID']?.trim() || undefined);

  if (rawAppId !== undefined && rawPrivateKey !== undefined) {
    if (options.createAppJwt === undefined) {
      throw new TaskpackError(
        'TOKEN_BROKER_CONFIG_INVALID',
        'createAppJwt callback is required to mint GitHub App installation tokens',
      );
    }
    const appId = parsePositiveSafeInt(rawAppId);
    if (appId === null) {
      throw new TaskpackError('TOKEN_BROKER_CONFIG_INVALID', 'GitHub App ID must be a positive integer');
    }

    let installationId: number | undefined;
    if (rawInstallationId !== undefined) {
      const parsedInstallationId = parsePositiveSafeInt(rawInstallationId);
      if (parsedInstallationId === null) {
        throw new TaskpackError('TOKEN_BROKER_CONFIG_INVALID', 'GitHub App installation ID must be a positive integer');
      }
      installationId = parsedInstallationId;
    }

    const apiBaseUrl = defaultApiBaseUrl(options.apiBaseUrl, options.env);
    const jwt = options.createAppJwt({
      appId,
      privateKeyPem: rawPrivateKey,
      nowSeconds: Math.floor(Date.now() / 1000),
    });
    scrubber.register(jwt);

    let appSlug: string | undefined;
    if (installationId === undefined) {
      const repoFullName = options.repositoryFullName?.trim() ?? '';
      if (!REPOSITORY_FULL_NAME_PATTERN.test(repoFullName)) {
        throw new TaskpackError(
          'TOKEN_BROKER_CONFIG_INVALID',
          `repositoryFullName matching "owner/repo" is required to auto-discover GitHub App installation (got "${scrubber.scrub(repoFullName)}")`,
        );
      }
      const [owner, repo] = repoFullName.split('/') as [string, string];
      if (owner === '.' || owner === '..' || repo === '.' || repo === '..') {
        throw new TaskpackError(
          'TOKEN_BROKER_CONFIG_INVALID',
          `invalid repositoryFullName "${scrubber.scrub(repoFullName)}" for GitHub App installation lookup`,
        );
      }
      const installRes = await fetchBoundedText(
        `${apiBaseUrl}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/installation`,
        fetchImpl,
        {
          accept: 'application/vnd.github+json',
          authorization: `Bearer ${jwt}`,
          'user-agent': 'loopwright-taskpack',
        },
        15_000,
        scrubber,
      );
      if (!installRes.ok) {
        throw new TaskpackError(
          'TOKEN_BROKER_CONFIG_INVALID',
          `failed to discover GitHub App installation for ${repoFullName} (${installRes.status}): ${scrubber.scrub(installRes.text)}`,
        );
      }
      let installParsed: unknown;
      try {
        installParsed = JSON.parse(installRes.text);
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        throw new TaskpackError(
          'TOKEN_BROKER_CONFIG_INVALID',
          `invalid GitHub App installation JSON: ${scrubber.scrub(detail)}`,
        );
      }
      if (
        !isPlainRecord(installParsed)
        || typeof installParsed['id'] !== 'number'
        || !Number.isSafeInteger(installParsed['id'])
        || installParsed['id'] <= 0
      ) {
        throw new TaskpackError(
          'TOKEN_BROKER_CONFIG_INVALID',
          `GitHub App installation response for ${repoFullName} missing positive integer id`,
        );
      }
      installationId = installParsed['id'];
      if (typeof installParsed['app_slug'] === 'string' && installParsed['app_slug'].trim().length > 0) {
        appSlug = installParsed['app_slug'].trim();
      }
    }

    const bodyPayload: Record<string, unknown> = {};
    if (options.permissions !== undefined) {
      bodyPayload['permissions'] = options.permissions;
    }
    if (options.repositoryId !== undefined && Number.isSafeInteger(options.repositoryId) && options.repositoryId > 0) {
      bodyPayload['repository_ids'] = [options.repositoryId];
    } else if (options.repositoryFullName && REPOSITORY_FULL_NAME_PATTERN.test(options.repositoryFullName)) {
      bodyPayload['repositories'] = [options.repositoryFullName.split('/')[1]];
    }

    const res = await fetchBoundedText(
      `${apiBaseUrl}/app/installations/${installationId}/access_tokens`,
      fetchImpl,
      {
        accept: 'application/vnd.github+json',
        authorization: `Bearer ${jwt}`,
        'content-type': 'application/json',
        'user-agent': 'loopwright-taskpack',
      },
      15_000,
      scrubber,
      { method: 'POST', body: JSON.stringify(bodyPayload) },
    );
    if (!res.ok) {
      throw new TaskpackError(
        'TOKEN_BROKER_CONFIG_INVALID',
        `failed to mint installation token (${res.status}): ${scrubber.scrub(res.text)}`,
      );
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(res.text);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new TaskpackError('TOKEN_BROKER_CONFIG_INVALID', `invalid GitHub App access_tokens JSON: ${scrubber.scrub(detail)}`);
    }
    if (!isPlainRecord(parsed) || typeof parsed['token'] !== 'string' || parsed['token'].length === 0) {
      throw new TaskpackError('TOKEN_BROKER_CONFIG_INVALID', 'GitHub App access_tokens response missing token');
    }
    const mintedToken = parsed['token'];
    scrubber.register(mintedToken);

    let resolvedIdentity = DEFAULT_GIT_COMMIT_IDENTITY;
    if (shouldLookupDynamicIdentity) {
      if (appSlug === undefined) {
        try {
          const appRes = await fetchJson(
            `${apiBaseUrl}/app`,
            fetchImpl,
            {
              accept: 'application/vnd.github+json',
              authorization: `Bearer ${jwt}`,
              'user-agent': 'loopwright-taskpack',
            },
            10_000,
            scrubber,
          );
          if (appRes.ok && isPlainRecord(appRes.data) && typeof appRes.data['slug'] === 'string' && appRes.data['slug'].trim().length > 0) {
            appSlug = appRes.data['slug'].trim();
          }
        } catch {
          // Best-effort lookup; fall back to default DCO-valid bot identity.
        }
      }
      if (appSlug !== undefined && appSlug.length > 0) {
        const botLogin = appSlug.endsWith('[bot]') ? appSlug : `${appSlug}[bot]`;
        resolvedIdentity = (await resolveNoreplyIdentityFromUserEndpoint(
          `${apiBaseUrl}/users/${encodeURIComponent(botLogin)}`,
          mintedToken,
        )) ?? DEFAULT_GIT_COMMIT_IDENTITY;
      }
    }

    return {
      token: mintedToken,
      installationId,
      ...(appSlug !== undefined ? { appSlug } : {}),
      gitCommitIdentity: finalizeIdentity(resolvedIdentity),
    };
  }

  // 3) Ambient fallback (env.GITHUB_TOKEN)
  if (ambientToken !== undefined) {
    let resolvedIdentity = DEFAULT_GIT_COMMIT_IDENTITY;
    if (shouldLookupDynamicIdentity) {
      const explicitApiBase = (options.apiBaseUrl?.trim() || options.env?.['GITHUB_API_URL']?.trim())?.replace(/\/+$/, '');
      if (explicitApiBase && explicitApiBase.length > 0) {
        resolvedIdentity = (await resolveNoreplyIdentityFromUserEndpoint(`${explicitApiBase}/user`, ambientToken))
          ?? DEFAULT_GIT_COMMIT_IDENTITY;
      }
    }
    return {
      token: ambientToken,
      gitCommitIdentity: finalizeIdentity(resolvedIdentity),
    };
  }

  return {
    token: undefined,
    gitCommitIdentity: finalizeIdentity(DEFAULT_GIT_COMMIT_IDENTITY),
  };
}

/** Resolve GitHub authentication credentials and a DCO-valid Git commit identity (with injectable `createAppJwt`). */
export async function resolveGitHubAuth(options: ResolveActionGitHubAuthOptions): Promise<ResolvedActionGitHubAuth> {
  return resolveGitHubAuthInternal(options, true);
}

/** Resolve a GitHub token using explicit input, injected GitHub App JWT signer, or ambient `GITHUB_TOKEN`. */
export async function resolveGitHubToken(options: ResolveActionGitHubTokenOptions): Promise<string | undefined> {
  const resolved = await resolveGitHubAuthInternal(options, false);
  return resolved.token;
}

export interface CheckManagedPrMatchesOptions {
  readonly repositoryRoot: string;
  readonly repositoryFullName: string;
  readonly manifest: TaskpackManifest | TaskpackV2Manifest;
  readonly openManagedPr: ManagedPullRequestInfo | null;
  readonly records: readonly TaskpackUpstreamRecord[];
  readonly apiBaseUrl?: string | undefined;
  readonly githubToken?: UpstreamTokenResolver | undefined;
  readonly authHeaders?: UpstreamHeadersResolver | undefined;
  readonly fetchImpl?: typeof globalThis.fetch | undefined;
  readonly scrubber?: SecretScrubber | undefined;
  readonly env?: NodeJS.ProcessEnv | undefined;
  readonly timeoutMs?: number | undefined;
}

/**
 * Determine whether an existing open managed PR already carries the discovered
 * upstream versions by reading the proposal file at `openManagedPr.headSha`.
 */
export async function checkManagedPrMatchesDiscoveredState(
  options: CheckManagedPrMatchesOptions,
): Promise<boolean> {
  const { openManagedPr, manifest, records } = options;
  if (openManagedPr === null || records.length === 0) {
    return false;
  }
  if (!COMMIT_SHA_PATTERN.test(openManagedPr.headSha)) {
    return false;
  }
  if (records.some(record => record.status === 'failed' || record.status === 'blocked')) {
    return false;
  }
  const available = records.filter(record => record.status === 'available');
  if (available.length === 0) {
    return false;
  }

  if (manifest.spec.proposal === undefined) {
    return false;
  }
  const proposalPath = manifest.spec.proposal.path;
  if (tryNormalizeRelativePath(proposalPath) === undefined || proposalPath.startsWith('-')) {
    return false;
  }

  let proposalText: string | undefined;
  const timeoutMs = options.timeoutMs ?? 15_000;
  try {
    const gitBin = resolveGitExecutable();
    const { stdout } = await execFileAsync(
      gitBin,
      ['-C', options.repositoryRoot, 'show', `${openManagedPr.headSha}:${proposalPath}`],
      { env: buildCleanGitEnv(), timeout: timeoutMs, maxBuffer: MAX_PROPOSAL_BYTES, encoding: 'utf8' },
    );
    proposalText = stdout;
  } catch {
    const apiBase = options.apiBaseUrl?.trim() || options.env?.['GITHUB_API_URL']?.trim();
    if (apiBase && REPOSITORY_FULL_NAME_PATTERN.test(options.repositoryFullName)) {
      const scrubber = options.scrubber ?? new SecretScrubber();
      const encodedPath = proposalPath.split('/').map(seg => encodeURIComponent(seg)).join('/');
      const headers = await resolveAuthHeaders(
        options.githubToken,
        options.authHeaders,
        { accept: 'application/vnd.github.raw+json', 'user-agent': 'loopwright-taskpack' },
        scrubber,
      );
      try {
        const res = await fetchBoundedText(
          `${apiBase.replace(/\/+$/, '')}/repos/${options.repositoryFullName}/contents/${encodedPath}?ref=${encodeURIComponent(openManagedPr.headSha)}`,
          options.fetchImpl ?? globalThis.fetch,
          headers,
          timeoutMs,
          scrubber,
        );
        if (res.ok && Buffer.byteLength(res.text, 'utf8') <= MAX_PROPOSAL_BYTES) {
          proposalText = res.text;
        }
      } catch {
        proposalText = undefined;
      }
    }
  }

  if (proposalText === undefined || proposalText.trim().length === 0) {
    return false;
  }

  let parsedProposal: unknown;
  try {
    parsedProposal = JSON.parse(proposalText);
  } catch {
    return false;
  }

  const prVersions = readBaselineVersions(parsedProposal, manifest.spec.upstreams);
  if (prVersions.size === 0) {
    return false;
  }

  for (const record of available) {
    if (typeof record.version !== 'string' || record.version.length === 0) {
      return false;
    }
    if (prVersions.get(record.upstreamId) !== record.version) {
      return false;
    }
  }
  for (const record of records) {
    if (record.status === 'up_to_date' && typeof record.version === 'string' && prVersions.has(record.upstreamId)) {
      if (prVersions.get(record.upstreamId) !== record.version) {
        return false;
      }
    }
  }
  return true;
}
