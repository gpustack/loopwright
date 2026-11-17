import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { constants as fsConstants, existsSync, lstatSync, statSync } from 'node:fs';
import { open, stat } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { promisify } from 'node:util';
import { createGitHubAppJwt, SecretScrubber } from './token-broker.js';
import {
  GitHubAppError, REPOSITORY_FULL_NAME_PATTERN,
  type GitCommitIdentity, type TaskpackManifest, type TaskpackUpstreamDescriptor,
  type TaskpackUpstreamRecord, type UpstreamAcquisitionStatus,
} from './types.js';

const execFileAsync = promisify(execFile);

const MAX_RESPONSE_BYTES = 1_048_576;
const MAX_PROPOSAL_BYTES = 262_144;
export const COMMIT_SHA_PATTERN = /^[0-9a-f]{40}$/i;
const SAFE_GIT_REF_PATTERN = /^[A-Za-z0-9_./@^~{}-]{1,256}$/;
const SEMVER_TAG_PATTERN = /^v?(\d+(?:\.\d+)*)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/i;
const PRERELEASE_VERSION_TAG_PATTERN = /^v?\d+(?:\.\d+)+(?:[._-]?(?:alpha|beta|rc|dev|pre|preview|nightly|canary)\d*|[ab]\d+)(?:[._-]|$)/i;
const UPSTREAM_STATUSES: ReadonlySet<string> = new Set<UpstreamAcquisitionStatus>([
  'available',
  'up_to_date',
  'failed',
  'blocked',
]);
const GIT_CANDIDATE_PATHS: readonly string[] = Object.freeze([
  '/usr/bin/git',
  '/opt/homebrew/bin/git',
  '/usr/local/bin/git',
]);

export interface DiscoverTaskpackUpstreamsOptions {
  readonly repositoryRoot?: string | undefined;
  readonly apiBaseUrl?: string | undefined;
  readonly githubToken?: string | undefined;
  readonly fetchImpl?: typeof globalThis.fetch | undefined;
  readonly scrubber?: SecretScrubber | undefined;
  readonly upstreamRecordsJson?: string | undefined;
  readonly env?: NodeJS.ProcessEnv | undefined;
  readonly timeoutMs?: number | undefined;
}

export interface FindOpenManagedPullRequestOptions {
  readonly apiBaseUrl?: string | undefined;
  readonly repositoryFullName: string;
  readonly targetBranch: string;
  readonly headBranchPrefix: string;
  readonly githubToken?: string | undefined;
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
  readonly githubToken?: string | undefined;
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
    throw new GitHubAppError(
      'ACTION_INPUT_INVALID',
      'git-author-name must not contain control characters (CR/LF/NUL) or angle brackets (< or >)',
    );
  }
  const trimmed = raw.trim();
  if (trimmed.length === 0 || trimmed.length > MAX_GIT_IDENTITY_FIELD_LENGTH) {
    throw new GitHubAppError(
      'ACTION_INPUT_INVALID',
      `git-author-name must be 1..${MAX_GIT_IDENTITY_FIELD_LENGTH} printable characters`,
    );
  }
  return trimmed;
}

export function validateGitAuthorEmail(raw: string): string {
  if (typeof raw !== 'string' || hasDisallowedGitIdentityChars(raw)) {
    throw new GitHubAppError(
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
    throw new GitHubAppError(
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
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

export function assertNoSymlinkSegments(baseDir: string, targetPath: string): void {
  const resolvedBase = resolve(baseDir);
  const resolvedTarget = resolve(targetPath);
  const rel = relative(resolvedBase, resolvedTarget);
  if (rel.startsWith('..') || isAbsolute(rel)) {
    throw new GitHubAppError('ACTION_INPUT_INVALID', `path "${targetPath}" escapes root "${baseDir}"`);
  }
  const parts = rel.split(sep).filter(part => part.length > 0 && part !== '.');
  let cursor = resolvedBase;
  for (const part of parts) {
    cursor = join(cursor, part);
    const stats = lstatSync(cursor, { throwIfNoEntry: false });
    if (stats === undefined) continue;
    if (stats.isSymbolicLink()) {
      throw new GitHubAppError('ACTION_INPUT_INVALID', `symlink segment disallowed at "${cursor}"`);
    }
  }
}

async function readBoundedLocalFile(baseDir: string, relPath: string, maxBytes: number): Promise<Buffer> {
  const resolvedBase = resolve(baseDir);
  const fullPath = resolve(resolvedBase, relPath);
  assertNoSymlinkSegments(resolvedBase, fullPath);
  const info = await stat(fullPath);
  if (!info.isFile()) {
    throw new GitHubAppError('ACTION_INPUT_INVALID', `expected regular file at "${relPath}"`);
  }
  if (info.size > maxBytes) {
    throw new GitHubAppError('ACTION_INPUT_INVALID', `file "${relPath}" exceeds maximum allowed ${maxBytes} bytes`);
  }
  const handle = await open(fullPath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  try {
    const openedStats = await handle.stat();
    if (!openedStats.isFile() || openedStats.size > maxBytes) {
      throw new GitHubAppError('ACTION_INPUT_INVALID', `file "${relPath}" is not a bounded regular file`);
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
    const reader = response.body?.getReader();
    if (!reader) {
      const text = await response.text();
      if (Buffer.byteLength(text, 'utf8') > MAX_RESPONSE_BYTES) {
        throw new GitHubAppError('ACTION_INPUT_INVALID', `response from "${scrubber.scrub(url)}" exceeded ${MAX_RESPONSE_BYTES} bytes`);
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
        throw new GitHubAppError('ACTION_INPUT_INVALID', `response from "${scrubber.scrub(url)}" exceeded ${MAX_RESPONSE_BYTES} bytes`);
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
    throw new GitHubAppError('ACTION_INPUT_INVALID', `invalid JSON from "${scrubber.scrub(url)}": ${scrubber.scrub(detail)}`);
  }
}

export function parseUpstreamRecordsJson(rawJson: string): readonly TaskpackUpstreamRecord[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawJson);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new GitHubAppError('ACTION_INPUT_INVALID', `upstreamRecordsJson is not valid JSON: ${detail}`);
  }
  if (!Array.isArray(parsed)) {
    throw new GitHubAppError('ACTION_INPUT_INVALID', 'upstreamRecordsJson must be a JSON array');
  }
  const records: TaskpackUpstreamRecord[] = [];
  for (const [index, entry] of parsed.entries()) {
    if (!isPlainRecord(entry)) {
      throw new GitHubAppError('ACTION_INPUT_INVALID', `upstreamRecordsJson[${index}] must be an object`);
    }
    const upstreamId = entry['upstreamId'];
    const status = entry['status'];
    const version = entry['version'];
    const recentVersions = entry['recentVersions'];
    const reason = entry['reason'];
    if (typeof upstreamId !== 'string' || upstreamId.trim().length === 0) {
      throw new GitHubAppError('ACTION_INPUT_INVALID', `upstreamRecordsJson[${index}].upstreamId must be a non-empty string`);
    }
    if (typeof status !== 'string' || !UPSTREAM_STATUSES.has(status)) {
      throw new GitHubAppError('ACTION_INPUT_INVALID', `upstreamRecordsJson[${index}].status is invalid`);
    }
    if (version !== undefined && typeof version !== 'string') {
      throw new GitHubAppError('ACTION_INPUT_INVALID', `upstreamRecordsJson[${index}].version must be a string`);
    }
    if (
      recentVersions !== undefined
      && (!Array.isArray(recentVersions) || recentVersions.some(item => typeof item !== 'string' || item.length === 0))
    ) {
      throw new GitHubAppError('ACTION_INPUT_INVALID', `upstreamRecordsJson[${index}].recentVersions must be an array of non-empty strings`);
    }
    if (reason !== undefined && typeof reason !== 'string') {
      throw new GitHubAppError('ACTION_INPUT_INVALID', `upstreamRecordsJson[${index}].reason must be a string`);
    }
    records.push({
      upstreamId,
      status: status as UpstreamAcquisitionStatus,
      ...(version !== undefined ? { version } : {}),
      ...(recentVersions !== undefined ? { recentVersions: Object.freeze([...(recentVersions as string[])]) } : {}),
      ...(reason !== undefined ? { reason } : {}),
    });
  }
  return Object.freeze(records);
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
    throw new GitHubAppError('ACTION_INPUT_INVALID', `unsafe git upstream source "${source}"`);
  }
  if (source.includes('://') || /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(source)) {
    if (!source.startsWith('https://') || /\s/.test(source)) {
      throw new GitHubAppError('ACTION_INPUT_INVALID', `git upstream source "${source}" uses disallowed scheme`);
    }
    let parsed: URL;
    try {
      parsed = new URL(source);
    } catch {
      throw new GitHubAppError('ACTION_INPUT_INVALID', `git upstream source "${source}" is not a valid https URL`);
    }
    if (parsed.protocol !== 'https:' || parsed.hostname.length === 0) {
      throw new GitHubAppError('ACTION_INPUT_INVALID', `git upstream source "${source}" must be a valid https URL`);
    }
    return 'https';
  }
  const localPath = repositoryRoot !== undefined ? resolve(repositoryRoot, source) : source;
  if (!existsSync(localPath) || !statSync(localPath).isDirectory()) {
    throw new GitHubAppError('ACTION_INPUT_INVALID', `git upstream local source "${source}" must be an existing directory`);
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

// When allowPrerelease === false is explicitly configured and every tag is a prerelease,
// fail closed with ACTION_INPUT_INVALID rather than silently falling back to a prerelease commit SHA.
function selectLatestVersionTag(tags: readonly string[], upstream: TaskpackUpstreamDescriptor): string {
  const candidates = upstream.allowPrerelease === false
    ? tags.filter(tag => !isPrereleaseVersionTag(tag))
    : [...tags];
  if (candidates.length === 0) {
    throw new GitHubAppError('ACTION_INPUT_INVALID', `no non-prerelease tags found for ${upstream.source}`);
  }
  candidates.sort(compareVersionTags);
  return candidates[candidates.length - 1]!;
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
        throw new GitHubAppError('ACTION_INPUT_INVALID', `github-release upstream "${upstream.id}" source "${upstream.source}" must be owner/repo`);
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
        throw new GitHubAppError('ACTION_INPUT_INVALID', `GitHub releases lookup failed (${list.status}) for ${upstream.source}`);
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
          throw new GitHubAppError('ACTION_INPUT_INVALID', `GitHub releases lookup failed (${list30.status}) for ${upstream.source}`);
        }
        const stableTags = collectReleaseTags(list30.data, { allowPrerelease: false, rejectTagPrerelease: true });
        if (stableTags.length > 0) {
          const bestVersion = [...stableTags].sort(compareVersionTags).at(-1)!;
          return {
            version: bestVersion,
            recentVersions: Object.freeze([bestVersion, ...stableTags.filter(item => item !== bestVersion)].slice(0, 20)),
          };
        }
        throw new GitHubAppError('ACTION_INPUT_INVALID', `no non-prerelease releases found for ${upstream.source}`);
      }
      throw new GitHubAppError('ACTION_INPUT_INVALID', `GitHub release lookup failed (${latest.status}) for ${upstream.source}`);
    }

    case 'git-tag': {
      if (REPOSITORY_FULL_NAME_PATTERN.test(upstream.source)) {
        const url = `${apiBaseUrl}/repos/${upstream.source}/tags?per_page=100`;
        const res = await fetchJson(url, fetchImpl, githubHeaders, timeoutMs, scrubber);
        if (!res.ok || !Array.isArray(res.data) || res.data.length === 0) {
          throw new GitHubAppError('ACTION_INPUT_INVALID', `GitHub tags lookup failed (${res.status}) for ${upstream.source}`);
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
        throw new GitHubAppError('ACTION_INPUT_INVALID', `GitHub tags payload lacked tag name for ${upstream.source}`);
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
        throw new GitHubAppError('ACTION_INPUT_INVALID', `git ls-remote returned no tags for ${upstream.source}`);
      }
      return { version: selectLatestVersionTag(tags, upstream) };
    }

    case 'git-commit': {
      if (REPOSITORY_FULL_NAME_PATTERN.test(upstream.source)) {
        const url = `${apiBaseUrl}/repos/${upstream.source}/commits?per_page=1`;
        const res = await fetchJson(url, fetchImpl, githubHeaders, timeoutMs, scrubber);
        if (!res.ok || !Array.isArray(res.data) || res.data.length === 0 || !isPlainRecord(res.data[0])) {
          throw new GitHubAppError('ACTION_INPUT_INVALID', `GitHub commits lookup failed (${res.status}) for ${upstream.source}`);
        }
        const sha = res.data[0]['sha'];
        if (typeof sha === 'string' && sha.length > 0) return { version: sha };
        throw new GitHubAppError('ACTION_INPUT_INVALID', `GitHub commits payload lacked sha for ${upstream.source}`);
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
          throw new GitHubAppError('ACTION_INPUT_INVALID', `git ls-remote HEAD output malformed for ${upstream.source}`);
        }
        if (firstSha === undefined) firstSha = sha;
        const ref = parts[1];
        if (ref) refShas.set(ref, sha);
      }
      const sha = refShas.get('HEAD') ?? refShas.get('refs/heads/main') ?? refShas.get('refs/heads/master') ?? firstSha;
      if (sha === undefined) {
        throw new GitHubAppError('ACTION_INPUT_INVALID', `git ls-remote returned no HEAD for ${upstream.source}`);
      }
      return { version: sha };
    }

    case 'http-json': {
      const res = await fetchJson(
        upstream.source,
        fetchImpl,
        { accept: 'application/json', 'user-agent': 'loopwright-github-app' },
        timeoutMs,
        scrubber,
      );
      if (!res.ok) {
        throw new GitHubAppError('ACTION_INPUT_INVALID', `http-json fetch failed (${res.status}) for ${upstream.id}`);
      }
      if (isPlainRecord(res.data)) {
        for (const key of ['version', 'tag_name', 'latest', 'sha'] as const) {
          const candidate = res.data[key];
          if (typeof candidate === 'string' && candidate.trim().length > 0) {
            return { version: candidate.trim() };
          }
        }
      }
      return { version: createHash('sha256').update(res.rawText, 'utf8').digest('hex').slice(0, 16) };
    }

    case 'custom-table': {
      let rawBytes: Buffer;
      if (upstream.source.startsWith('http://') || upstream.source.startsWith('https://')) {
        let parsedUrl: URL;
        try {
          parsedUrl = new URL(upstream.source);
        } catch {
          throw new GitHubAppError('ACTION_INPUT_INVALID', `custom-table source "${upstream.source}" is not a valid URL`);
        }
        if (parsedUrl.protocol === 'http:') {
          const host = parsedUrl.hostname.toLowerCase();
          const isLoopback = host === '127.0.0.1' || host === 'localhost' || host === '[::1]' || host === '::1';
          if (!isLoopback) {
            throw new GitHubAppError(
              'ACTION_INPUT_INVALID',
              `custom-table source "${upstream.source}" must use https:// (plain http:// is allowed only for loopback hosts)`,
            );
          }
        }
        const res = await fetchBoundedText(
          upstream.source,
          fetchImpl,
          { accept: 'application/json, text/plain;q=0.9', 'user-agent': 'loopwright-github-app' },
          timeoutMs,
          scrubber,
        );
        if (!res.ok) {
          throw new GitHubAppError('ACTION_INPUT_INVALID', `custom-table fetch failed (${res.status}) for ${upstream.id}`);
        }
        rawBytes = Buffer.from(res.text, 'utf8');
      } else {
        if (context.repositoryRoot === undefined) {
          throw new GitHubAppError('ACTION_INPUT_INVALID', `repositoryRoot is required to read local custom-table "${upstream.source}"`);
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
 * Discover upstream states declared by a Taskpack manifest and compare against
 * any existing proposal file under `repositoryRoot`.
 */
export async function discoverTaskpackUpstreams(
  manifest: TaskpackManifest,
  options: DiscoverTaskpackUpstreamsOptions = {},
): Promise<readonly TaskpackUpstreamRecord[]> {
  if (options.upstreamRecordsJson !== undefined && options.upstreamRecordsJson.trim().length > 0) {
    return parseUpstreamRecordsJson(options.upstreamRecordsJson);
  }
  if (manifest.spec.upstreams.length === 0) {
    return Object.freeze([]);
  }

  const scrubber = options.scrubber ?? new SecretScrubber();
  if (options.githubToken) scrubber.register(options.githubToken);

  const apiBaseUrl = defaultApiBaseUrl(options.apiBaseUrl, options.env);
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const timeoutMs = options.timeoutMs ?? 15_000;
  const githubHeaders: Record<string, string> = {
    accept: 'application/vnd.github+json',
    'user-agent': 'loopwright-github-app',
  };
  if (options.githubToken) {
    githubHeaders['authorization'] = `Bearer ${options.githubToken}`;
  }

  let baselines: ReadonlyMap<string, string> = new Map();
  if (options.repositoryRoot !== undefined) {
    try {
      const bytes = await readBoundedLocalFile(options.repositoryRoot, manifest.spec.proposal.path, MAX_PROPOSAL_BYTES);
      const parsed = JSON.parse(bytes.toString('utf8')) as unknown;
      baselines = readBaselineVersions(parsed, manifest.spec.upstreams);
    } catch {
      baselines = new Map();
    }
  }

  const records: TaskpackUpstreamRecord[] = [];
  for (const upstream of manifest.spec.upstreams) {
    try {
      const resolved = await resolveSingleUpstreamDetails(upstream, {
        repositoryRoot: options.repositoryRoot,
        apiBaseUrl,
        githubHeaders,
        fetchImpl,
        timeoutMs,
        scrubber,
      });
      const baseline = baselines.get(upstream.id);
      const isSemverTagKind = upstream.kind === 'github-release' || upstream.kind === 'git-tag';
      const cmp = isSemverTagKind && baseline !== undefined && parseSemverTag(baseline) !== null && parseSemverTag(resolved.version) !== null
        ? compareVersionTags(resolved.version, baseline)
        : null;
      const upToDateBySemver = cmp !== null && (
        cmp < 0
        || (cmp === 0 && !baseline!.includes('+') && !resolved.version.includes('+'))
      );
      const status: UpstreamAcquisitionStatus = baseline !== undefined && (baseline === resolved.version || upToDateBySemver)
        ? 'up_to_date'
        : 'available';
      records.push({
        upstreamId: upstream.id,
        status,
        version: resolved.version,
        ...(resolved.recentVersions !== undefined ? { recentVersions: resolved.recentVersions } : {}),
      });
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      records.push({
        upstreamId: upstream.id,
        status: 'failed',
        reason: scrubber.scrub(detail),
      });
    }
  }
  return Object.freeze(records);
}

export const MEMORY_PULL_REQUEST_BRANCH_PREFIX = 'loopwright/memory/' as const;

export interface FindOpenMemoryPullRequestOptions {
  readonly apiBaseUrl?: string | undefined;
  readonly repositoryFullName: string;
  readonly targetBranch: string;
  readonly memoryBranch: string;
  readonly githubToken?: string | undefined;
  readonly fetchImpl?: typeof globalThis.fetch | undefined;
  readonly scrubber?: SecretScrubber | undefined;
  readonly env?: NodeJS.ProcessEnv | undefined;
  readonly timeoutMs?: number | undefined;
}

/**
 * Look up an open pull request against `targetBranch` whose head ref begins
 * with `headBranchPrefix` (excluding dedicated `loopwright/memory/*` branches
 * unless `headBranchPrefix` itself targets `loopwright/memory/`).
 */
export async function findOpenManagedPullRequest(
  options: FindOpenManagedPullRequestOptions,
): Promise<ManagedPullRequestInfo | null> {
  if (!REPOSITORY_FULL_NAME_PATTERN.test(options.repositoryFullName)) {
    throw new GitHubAppError('ACTION_INPUT_INVALID', `invalid repositoryFullName "${options.repositoryFullName}"`);
  }
  const scrubber = options.scrubber ?? new SecretScrubber();
  if (options.githubToken) scrubber.register(options.githubToken);

  const apiBaseUrl = defaultApiBaseUrl(options.apiBaseUrl, options.env);
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const timeoutMs = options.timeoutMs ?? 15_000;
  const headers: Record<string, string> = {
    accept: 'application/vnd.github+json',
    'user-agent': 'loopwright-github-app',
  };
  if (options.githubToken) {
    headers['authorization'] = `Bearer ${options.githubToken}`;
  }

  for (let page = 1; page <= 5; page += 1) {
    const url = `${apiBaseUrl}/repos/${options.repositoryFullName}/pulls?state=open&base=${encodeURIComponent(options.targetBranch)}&per_page=100&page=${page}`;
    const res = await fetchJson(url, fetchImpl, headers, timeoutMs, scrubber);
    if (!res.ok) {
      throw new GitHubAppError(
        'ACTION_INPUT_INVALID',
        `open pull requests lookup failed (${res.status}) for ${options.repositoryFullName}`,
      );
    }
    if (!Array.isArray(res.data)) {
      throw new GitHubAppError('ACTION_INPUT_INVALID', 'GitHub pulls response must be an array');
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
      break;
    }
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
    throw new GitHubAppError('ACTION_INPUT_INVALID', `invalid repositoryFullName "${options.repositoryFullName}"`);
  }
  const scrubber = options.scrubber ?? new SecretScrubber();
  if (options.githubToken) scrubber.register(options.githubToken);

  const apiBaseUrl = defaultApiBaseUrl(options.apiBaseUrl, options.env);
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const timeoutMs = options.timeoutMs ?? 15_000;
  const headers: Record<string, string> = {
    accept: 'application/vnd.github+json',
    'user-agent': 'loopwright-github-app',
  };
  if (options.githubToken) {
    headers['authorization'] = `Bearer ${options.githubToken}`;
  }

  const slashIndex = options.repositoryFullName.indexOf('/');
  const owner = options.repositoryFullName.slice(0, slashIndex);
  const headQuery = `${owner}:${options.memoryBranch}`;
  let confirmedAbsence = false;

  for (let page = 1; page <= 5; page += 1) {
    const url = `${apiBaseUrl}/repos/${options.repositoryFullName}/pulls?state=open&head=${encodeURIComponent(headQuery)}&base=${encodeURIComponent(options.targetBranch)}&per_page=100&page=${page}`;
    const res = await fetchJson(url, fetchImpl, headers, timeoutMs, scrubber);
    if (!res.ok) {
      throw new GitHubAppError(
        'ACTION_INPUT_INVALID',
        `open memory pull requests lookup failed (${res.status}) for ${options.repositoryFullName}`,
      );
    }
    if (!Array.isArray(res.data)) {
      throw new GitHubAppError('ACTION_INPUT_INVALID', 'GitHub pulls response must be an array');
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
    throw new GitHubAppError(
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
 * Resolve and verify a Git commit reference or SHA against `repositoryRoot` using
 * `git rev-parse --verify` so nonexistent SHAs and missing refs fail closed.
 */
export async function resolveGitCommitSha(
  repositoryRoot: string,
  ref: string,
  timeoutMs = 15_000,
): Promise<string> {
  if (!SAFE_GIT_REF_PATTERN.test(ref) || ref.startsWith('-')) {
    throw new GitHubAppError('ACTION_INPUT_INVALID', `invalid git revision reference "${ref}"`);
  }
  const gitBin = resolveGitExecutable();
  try {
    const { stdout } = await execFileAsync(
      gitBin,
      ['-C', repositoryRoot, 'rev-parse', '--verify', '--end-of-options', `${ref}^{commit}`],
      { timeout: timeoutMs, maxBuffer: 4096, encoding: 'utf8' },
    );
    const sha = stdout.trim().toLowerCase();
    if (!COMMIT_SHA_PATTERN.test(sha)) {
      throw new GitHubAppError('ACTION_INPUT_INVALID', `git rev-parse returned invalid commit sha "${sha}" for "${ref}"`);
    }
    return sha;
  } catch (error) {
    if (error instanceof GitHubAppError) throw error;
    const detail = error instanceof Error ? error.message : String(error);
    throw new GitHubAppError('ACTION_INPUT_INVALID', `failed to resolve git revision "${ref}": ${detail}`);
  }
}

async function resolveGitRevisionSha(repositoryRoot: string, ref: string, timeoutMs: number): Promise<string> {
  if (COMMIT_SHA_PATTERN.test(ref)) {
    return ref.toLowerCase();
  }
  return resolveGitCommitSha(repositoryRoot, ref, timeoutMs);
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
  if (options.githubToken) scrubber.register(options.githubToken);

  const apiBaseUrl = options.apiBaseUrl?.trim() || options.env?.['GITHUB_API_URL']?.trim();
  const normalizedApiBase = apiBaseUrl ? apiBaseUrl.replace(/\/+$/, '') : undefined;
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const timeoutMs = options.timeoutMs ?? 15_000;
  const headers: Record<string, string> = {
    accept: 'application/vnd.github+json',
    'user-agent': 'loopwright-github-app',
  };
  if (options.githubToken) {
    headers['authorization'] = `Bearer ${options.githubToken}`;
  }

  let baseRev = options.baseRevision;
  let sourceRev = options.sourceRevision ?? options.baseRevision;
  const preserveExplicitOnComment = options.eventName === 'issue_comment'
    && options.preserveExplicitSourceRevision === true
    && options.sourceRevision !== undefined
    && options.sourceRevision.trim().length > 0;

  if (!preserveExplicitOnComment && (options.eventName === 'issue_comment' || options.eventName === 'pull_request_review')) {
    const prNumber = extractPrNumberFromPayload(options.eventPayload);
    const payloadPr = isPlainRecord(options.eventPayload) && isPlainRecord(options.eventPayload['pull_request'])
      ? options.eventPayload['pull_request']
      : undefined;

    if (prNumber !== undefined && normalizedApiBase !== undefined) {
      if (!REPOSITORY_FULL_NAME_PATTERN.test(options.repositoryFullName)) {
        throw new GitHubAppError(
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
        throw new GitHubAppError(
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
        throw new GitHubAppError(
          'ACTION_INPUT_INVALID',
          `pull request #${prNumber} response missing valid 40-hex base/head SHAs`,
        );
      }
      baseRev = fetchedBaseSha.toLowerCase();
      sourceRev = fetchedHeadSha.toLowerCase();
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
          throw new GitHubAppError(
            'ACTION_INPUT_INVALID',
            'event pull_request payload base/head SHAs must be 40-hex commit SHAs',
          );
        }
        baseRev = payloadBaseSha.toLowerCase();
        sourceRev = payloadHeadSha.toLowerCase();
      }
    }
  }

  const resolvedBase = await resolveGitRevisionSha(options.repositoryRoot, baseRev, timeoutMs);
  const resolvedSource = sourceRev === baseRev
    ? resolvedBase
    : await resolveGitRevisionSha(options.repositoryRoot, sourceRev, timeoutMs);

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
        throw new GitHubAppError(
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
        throw new GitHubAppError(
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
          'user-agent': 'loopwright-github-app',
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

  // 1) Explicit token input (options.githubToken / INPUT_GITHUB-TOKEN)
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

  // 2) GitHub App credentials (appId + appPrivateKey; installation ID optional via auto-discovery)
  const rawAppId = options.appId !== undefined && (typeof options.appId === 'number' || options.appId.trim().length > 0)
    ? options.appId
    : (options.env?.['INPUT_GITHUB-APP-ID']?.trim() || undefined);
  const rawInstallationId = options.appInstallationId !== undefined
    && (typeof options.appInstallationId === 'number' || options.appInstallationId.trim().length > 0)
    ? options.appInstallationId
    : (options.env?.['INPUT_GITHUB-APP-INSTALLATION-ID']?.trim() || undefined);

  if (rawAppId !== undefined && rawPrivateKey !== undefined) {
    const appId = parsePositiveSafeInt(rawAppId);
    if (appId === null) {
      throw new GitHubAppError('TOKEN_BROKER_CONFIG_INVALID', 'GitHub App ID must be a positive integer');
    }

    let installationId: number | undefined;
    if (rawInstallationId !== undefined) {
      const parsedInstallationId = parsePositiveSafeInt(rawInstallationId);
      if (parsedInstallationId === null) {
        throw new GitHubAppError('TOKEN_BROKER_CONFIG_INVALID', 'GitHub App installation ID must be a positive integer');
      }
      installationId = parsedInstallationId;
    }

    const apiBaseUrl = defaultApiBaseUrl(options.apiBaseUrl, options.env);
    const jwt = createGitHubAppJwt({
      appId,
      privateKeyPem: rawPrivateKey,
      nowSeconds: Math.floor(Date.now() / 1000),
    });
    scrubber.register(jwt);

    let appSlug: string | undefined;
    if (installationId === undefined) {
      const repoFullName = options.repositoryFullName?.trim() ?? '';
      if (!REPOSITORY_FULL_NAME_PATTERN.test(repoFullName)) {
        throw new GitHubAppError(
          'TOKEN_BROKER_CONFIG_INVALID',
          `repositoryFullName matching "owner/repo" is required to auto-discover GitHub App installation (got "${scrubber.scrub(repoFullName)}")`,
        );
      }
      const [owner, repo] = repoFullName.split('/') as [string, string];
      if (owner === '.' || owner === '..' || repo === '.' || repo === '..') {
        throw new GitHubAppError(
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
          'user-agent': 'loopwright-github-app',
        },
        15_000,
        scrubber,
      );
      if (!installRes.ok) {
        throw new GitHubAppError(
          'TOKEN_BROKER_CONFIG_INVALID',
          `failed to discover GitHub App installation for ${repoFullName} (${installRes.status}): ${scrubber.scrub(installRes.text)}`,
        );
      }
      let installParsed: unknown;
      try {
        installParsed = JSON.parse(installRes.text);
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        throw new GitHubAppError(
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
        throw new GitHubAppError(
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
        'user-agent': 'loopwright-github-app',
      },
      15_000,
      scrubber,
      { method: 'POST', body: JSON.stringify(bodyPayload) },
    );
    if (!res.ok) {
      throw new GitHubAppError(
        'TOKEN_BROKER_CONFIG_INVALID',
        `failed to mint installation token (${res.status}): ${scrubber.scrub(res.text)}`,
      );
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(res.text);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new GitHubAppError('TOKEN_BROKER_CONFIG_INVALID', `invalid GitHub App access_tokens JSON: ${scrubber.scrub(detail)}`);
    }
    if (!isPlainRecord(parsed) || typeof parsed['token'] !== 'string' || parsed['token'].length === 0) {
      throw new GitHubAppError('TOKEN_BROKER_CONFIG_INVALID', 'GitHub App access_tokens response missing token');
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
              'user-agent': 'loopwright-github-app',
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

/**
 * Resolve GitHub authentication credentials and a DCO-valid Git commit identity
 * using strict precedence:
 *   1) Explicit token (`githubToken` / `INPUT_GITHUB-TOKEN`)
 *   2) GitHub App credentials (`appId` + `appPrivateKey`, auto-discovering installation ID when omitted)
 *   3) Ambient `GITHUB_TOKEN` environment fallback
 */
export async function resolveGitHubAuth(options: ResolveActionGitHubAuthOptions): Promise<ResolvedActionGitHubAuth> {
  return resolveGitHubAuthInternal(options, true);
}

/**
 * Resolve a GitHub token using strict precedence: explicit token input, GitHub App
 * installation token minting (auto-discovering installation ID when omitted), or
 * ambient `GITHUB_TOKEN` fallback.
 */
export async function resolveGitHubToken(options: ResolveActionGitHubTokenOptions): Promise<string | undefined> {
  const resolved = await resolveGitHubAuthInternal(options, false);
  return resolved.token;
}

export interface CheckManagedPrMatchesOptions {
  readonly repositoryRoot: string;
  readonly repositoryFullName: string;
  readonly manifest: TaskpackManifest;
  readonly openManagedPr: ManagedPullRequestInfo | null;
  readonly records: readonly TaskpackUpstreamRecord[];
  readonly apiBaseUrl?: string | undefined;
  readonly githubToken?: string | undefined;
  readonly fetchImpl?: typeof globalThis.fetch | undefined;
  readonly scrubber?: SecretScrubber | undefined;
  readonly env?: NodeJS.ProcessEnv | undefined;
  readonly timeoutMs?: number | undefined;
}

/**
 * Determine whether an existing open managed PR already carries the discovered
 * upstream versions by reading the proposal file at `openManagedPr.headSha`
 * (via `git show <headSha>:<proposalPath>`, falling back to the GitHub contents
 * API when the PR commit is not fetched locally).
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

  const proposalPath = manifest.spec.proposal.path;
  if (proposalPath.startsWith('-') || proposalPath.includes('..') || proposalPath.includes('\0')) {
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
      if (options.githubToken) scrubber.register(options.githubToken);
      const encodedPath = proposalPath.split('/').map(seg => encodeURIComponent(seg)).join('/');
      const headers: Record<string, string> = {
        accept: 'application/vnd.github.raw+json',
        'user-agent': 'loopwright-github-app',
      };
      if (options.githubToken) {
        headers['authorization'] = `Bearer ${options.githubToken}`;
      }
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
