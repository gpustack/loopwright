import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import { chmod, lstat, mkdtemp, open, realpath, rm } from 'node:fs/promises';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { signPayload, verifySignedPayload } from '@loopwright/controller';
import {
  assertNoSymlinkSegments,
  buildGitAuthEnv,
  COMMIT_SHA_PATTERN,
  computeAllowedSourceRevisionCarryDelta,
  CONTROLLER_ID_PATTERN,
  DEFAULT_GIT_COMMIT_IDENTITY,
  execGit,
  fetchBoundedText,
  hasSymlinkAtOrAbove,
  insideRoot,
  inspectAndVerifyCandidate,
  isAllowedCandidateWrite,
  isPlainRecord,
  listTreeEntriesAtRevision,
  MAX_REASON_CODEPOINTS,
  normalizeCandidateRelativePath,
  removePathsFromIndex,
  resolveGitExecutable,
  SAFE_BRANCH_PATTERN,
  sanitizeReportText,
  SecretScrubber,
  stageEntriesInIndex,
  truncateCodePoints,
  validateGitCommitIdentity,
  validateGitRemoteSource,
  verifyBaseTreeAnchor,
  type CarryDeltaEntry,
  type GitCommitIdentity,
  type HostPublicationEndpointPlan,
  type InspectedCandidateFile,
  type ManagedPullRequestInfo,
} from '@loopwright/taskpack';
import { GitHubAppError } from './types.js';

export interface NativePullRequestPublisherOptions {
  readonly runRoot: string;
  readonly repositoryRoot: string;
  readonly repositoryFullName: string;
  readonly targetBranch: string;
  readonly headBranchPrefix: string;
  readonly proposalPath?: string | undefined;
  readonly titleTemplate?: string | undefined;
  readonly openManagedPr?: ManagedPullRequestInfo | null | undefined;
  readonly remoteUrl?: string | undefined;
  readonly apiBaseUrl?: string | undefined;
  readonly gitWriteToken?: string | undefined;
  readonly gitCommitIdentity?: GitCommitIdentity | undefined;
  readonly fetchImpl?: typeof globalThis.fetch | undefined;
  readonly scrubber?: SecretScrubber | undefined;
  readonly signingSecret?: string | undefined;
  readonly authToken?: string | undefined;
  readonly host?: string | undefined;
  readonly scratchRoot?: string | undefined;
}

export interface NativePullRequestPublisherServer {
  readonly url: string;
  readonly signingSecret: string;
  readonly authToken: string;
  readonly endpointPlan: HostPublicationEndpointPlan;
  close(): Promise<void>;
}

const CAS_STREAM_CHUNK_BYTES = 1_048_576; // 1 MiB
const MAX_REQUEST_BODY_BYTES = 262_144;
const LOCAL_GATE_HTTP_HEADERS_TIMEOUT_MS = 60_000;
const MAX_PROPOSAL_JSON_BYTES = 2 * 1024 * 1024;
const MAX_PR_BODY_CODEPOINTS = 32_000;
const MAX_PR_TABLE_CELL_CODEPOINTS = 500;
const MAX_PR_NOTES_CODEPOINTS = 2_000;
const MAX_VERSION_TABLE_ENTRIES = 500;
const MAX_MODIFIED_PATHS_INPUT = 10_000;
const HEX_DIGEST_VERSION_PATTERN = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/i;
const RUNNER_ENGINE_KEYS = ['engine_version', 'engineVersion', 'engine'] as const;
const RUNNER_PLUGIN_KEYS = ['plugin_version', 'pluginVersion', 'plugin'] as const;
const RUNNER_SUBSCRIPTION_KEYS = ['status', ...RUNNER_ENGINE_KEYS, ...RUNNER_PLUGIN_KEYS, 'reason'] as const;

function stripUndefinedFields(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripUndefinedFields);
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>)) {
      const entry = (value as Record<string, unknown>)[key];
      if (entry === undefined) continue;
      out[key] = stripUndefinedFields(entry);
    }
    return out;
  }
  return value;
}

function canonicalJson(value: unknown): string {
  const cleaned = stripUndefinedFields(value);
  const serialize = (node: unknown): string => {
    if (node === null || typeof node !== 'object') {
      if (typeof node === 'number') {
        return JSON.stringify(Object.is(node, -0) ? 0 : node);
      }
      return JSON.stringify(node);
    }
    if (Array.isArray(node)) return `[${node.map(serialize).join(',')}]`;
    return `{${Object.keys(node).sort().map(key => `${JSON.stringify(key)}:${serialize((node as Record<string, unknown>)[key])}`).join(',')}}`;
  };
  return serialize(cleaned);
}

async function readIncomingBody(req: IncomingMessage, maxBytes: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const rawChunk of req) {
    const chunk = Buffer.isBuffer(rawChunk) ? rawChunk : Buffer.from(rawChunk);
    total += chunk.byteLength;
    if (total > maxBytes) {
      throw new GitHubAppError('ACTION_INPUT_INVALID', `request body exceeded ${maxBytes} bytes`);
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

function writeSignedJsonResponse(
  res: ServerResponse,
  statusCode: number,
  signingSecret: string,
  payload: unknown,
): void {
  if (res.destroyed || res.writableEnded) return;
  const cleaned = stripUndefinedFields(payload);
  const body = Buffer.from(canonicalJson(cleaned), 'utf8');
  const signature = signPayload(signingSecret, body);
  res.writeHead(statusCode, {
    'content-type': 'application/json',
    'content-length': String(body.byteLength),
    'x-loopwright-signature': signature,
  });
  res.end(body);
}

function writePlainJsonResponse(res: ServerResponse, statusCode: number, payload: unknown): void {
  if (res.destroyed || res.writableEnded) return;
  const body = Buffer.from(JSON.stringify(payload), 'utf8');
  res.writeHead(statusCode, {
    'content-type': 'application/json',
    'content-length': String(body.byteLength),
  });
  res.end(body);
}

/**
 * Anti-TOCTOU single-FD streaming `git -c core.bigFileThreshold=1m hash-object -w --stdin`:
 * Opens `<realRunRoot>/<runId>/artifacts/blobs/sha256/<file.sha256>` ONCE with `O_RDONLY | O_NOFOLLOW`,
 * verifies inode/mode/nlink/size, computes SHA-256 and expected Git blob OID in bounded `1 MiB` positional
 * reads (leaving the kernel file offset at 0), checks pre-spawn stat stability and SHA-256 equality, then
 * passes the pinned regular-file descriptor directly as `stdin` (`S_ISREG`) so Git streams large blobs
 * directly into a packfile via `index_fd()` -> `stream_to_pack()` in constant O(1) RSS, and finally
 * re-verifies `handle.stat()` stability and Git OID equality.
 */
async function streamVerifiedCasBlobToGitObject(options: {
  readonly realRunRoot: string;
  readonly runId: string;
  readonly repositoryRoot: string;
  readonly objectFormat: 'sha1' | 'sha256';
  readonly file: Extract<InspectedCandidateFile, { readonly kind: 'cas' }>;
  readonly gitEnv: Record<string, string>;
  readonly captureProposalBytes: boolean;
}): Promise<{ readonly oid: string; readonly proposalBytes?: Buffer | undefined }> {
  const { realRunRoot, runId, repositoryRoot, objectFormat, file, gitEnv, captureProposalBytes } = options;
  if (!CONTROLLER_ID_PATTERN.test(runId) || runId.length > 128) {
    throw new GitHubAppError('ACTION_INPUT_INVALID', `invalid controller runId "${runId}"`);
  }
  const expectedCasDir = join(realRunRoot, runId, 'artifacts', 'blobs', 'sha256');
  const canonicalBlobPath = join(expectedCasDir, file.sha256);
  if (file.canonicalBlobPath !== canonicalBlobPath || !insideRoot(canonicalBlobPath, expectedCasDir)) {
    throw new GitHubAppError(
      'ACTION_INPUT_INVALID',
      `CAS blob path for "${file.name}" does not match canonical run blob directory`,
    );
  }
  assertNoSymlinkSegments(realRunRoot, canonicalBlobPath);

  const before = await lstat(canonicalBlobPath).catch((err: NodeJS.ErrnoException) => {
    throw new GitHubAppError(
      'ACTION_INPUT_INVALID',
      `unable to stat CAS blob for "${file.name}": ${err.code ?? err.message}`,
    );
  });
  if (
    before.isSymbolicLink()
    || !before.isFile()
    || before.nlink !== 1
    || (before.mode & 0o222) !== 0
    || before.size !== file.byteLength
  ) {
    throw new GitHubAppError(
      'ACTION_INPUT_INVALID',
      `CAS blob for "${file.name}" failed symlink, nlink, read-only, or size verification`,
    );
  }

  const noFollow = 'O_NOFOLLOW' in fsConstants ? fsConstants.O_NOFOLLOW : 0;
  const handle = await open(canonicalBlobPath, fsConstants.O_RDONLY | noFollow).catch((err: NodeJS.ErrnoException) => {
    throw new GitHubAppError(
      'ACTION_INPUT_INVALID',
      `unable to open CAS blob for "${file.name}": ${err.code ?? err.message}`,
    );
  });

  try {
    const info = await handle.stat();
    if (
      !info.isFile()
      || info.dev !== before.dev
      || info.ino !== before.ino
      || info.size !== file.byteLength
      || info.nlink !== 1
      || (info.mode & 0o222) !== 0
    ) {
      throw new GitHubAppError(
        'ACTION_INPUT_INVALID',
        `CAS blob descriptor for "${file.name}" failed post-open stat verification`,
      );
    }

    const sha256Hasher = createHash('sha256');
    const gitBlobHasher = createHash(objectFormat).update(`blob ${file.byteLength}\0`);
    const shouldCaptureProposal = captureProposalBytes && file.byteLength <= MAX_PROPOSAL_JSON_BYTES;
    const proposalChunks: Buffer[] | null = shouldCaptureProposal ? [] : null;
    const chunkBuf = Buffer.allocUnsafe(Math.min(CAS_STREAM_CHUNK_BYTES, Math.max(1, file.byteLength)));

    let offset = 0;
    while (offset < file.byteLength) {
      const toRead = Math.min(chunkBuf.byteLength, file.byteLength - offset);
      const { bytesRead } = await handle.read(chunkBuf, 0, toRead, offset);
      if (bytesRead <= 0) break;
      const slice = bytesRead === chunkBuf.byteLength ? chunkBuf : chunkBuf.subarray(0, bytesRead);
      offset += bytesRead;
      sha256Hasher.update(slice);
      gitBlobHasher.update(slice);
      if (proposalChunks !== null) {
        proposalChunks.push(Buffer.from(slice));
      }
    }

    const trailingProbe = Buffer.allocUnsafe(1);
    const trailing = await handle.read(trailingProbe, 0, 1, offset);
    const midStat = await handle.stat();
    if (
      offset !== file.byteLength
      || trailing.bytesRead !== 0
      || !midStat.isFile()
      || midStat.dev !== info.dev
      || midStat.ino !== info.ino
      || midStat.size !== file.byteLength
      || midStat.nlink !== 1
      || (midStat.mode & 0o222) !== 0
      || midStat.mtimeMs !== info.mtimeMs
      || midStat.ctimeMs !== info.ctimeMs
    ) {
      throw new GitHubAppError(
        'ACTION_INPUT_INVALID',
        `CAS blob for "${file.name}" mutated or truncated during single-FD read`,
      );
    }

    const actualSha256 = sha256Hasher.digest('hex');
    if (actualSha256 !== file.sha256) {
      throw new GitHubAppError(
        'ACTION_INPUT_INVALID',
        `CAS blob SHA-256 mismatch for "${file.name}" (expected ${file.sha256}, got ${actualSha256})`,
      );
    }
    const expectedGitOid = gitBlobHasher.digest('hex');

    const gitBin = resolveGitExecutable();
    const timeoutMs = Math.min(600_000, Math.max(60_000, Math.ceil(file.byteLength / (4 * 1024 * 1024)) * 1_000 + 30_000));
    const child = spawn(
      gitBin,
      ['-c', 'core.hooksPath=/dev/null', '-c', 'core.bigFileThreshold=1m', '-C', repositoryRoot, 'hash-object', '-w', '--stdin'],
      { env: gitEnv, stdio: [handle.fd, 'pipe', 'pipe'] },
    );

    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let stdoutOverflow = false;
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, timeoutMs);
    timer.unref?.();

    child.stdout?.on('data', (chunk: Buffer) => {
      stdoutBytes += chunk.byteLength;
      if (stdoutBytes > 1024) {
        stdoutOverflow = true;
        child.kill('SIGKILL');
        return;
      }
      stdoutChunks.push(chunk);
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      if (stderrBytes >= 16_384) return;
      const take = Math.min(chunk.byteLength, 16_384 - stderrBytes);
      stderrBytes += take;
      stderrChunks.push(chunk.subarray(0, take));
    });

    const exited = new Promise<{
      readonly code: number | null;
      readonly signal: NodeJS.Signals | null;
      readonly spawnError: string | null;
    }>(resolvePromise => {
      let settled = false;
      const finish = (res: { readonly code: number | null; readonly signal: NodeJS.Signals | null; readonly spawnError: string | null }): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolvePromise(res);
      };
      child.once('error', err => finish({ code: null, signal: null, spawnError: err.message }));
      child.once('close', (code, signal) => finish({ code, signal, spawnError: null }));
    });

    try {
      const exit = await exited;
      if (exit.spawnError !== null) {
        throw new GitHubAppError('ACTION_INPUT_INVALID', `git hash-object failed to spawn: ${exit.spawnError}`);
      }
      if (timedOut) {
        throw new GitHubAppError('ACTION_INPUT_INVALID', `git hash-object timed out after ${timeoutMs}ms for "${file.name}"`);
      }
      if (stdoutOverflow) {
        throw new GitHubAppError('ACTION_INPUT_INVALID', `git hash-object stdout exceeded limit for "${file.name}"`);
      }
      if (exit.code !== 0 || exit.signal !== null) {
        const stderrText = Buffer.concat(stderrChunks).toString('utf8').trim();
        throw new GitHubAppError(
          'ACTION_INPUT_INVALID',
          `git hash-object exited with ${exit.code ?? exit.signal} for "${file.name}"${stderrText ? `: ${stderrText}` : ''}`,
        );
      }

      const afterStat = await handle.stat();
      if (
        !afterStat.isFile()
        || afterStat.dev !== info.dev
        || afterStat.ino !== info.ino
        || afterStat.size !== file.byteLength
        || afterStat.nlink !== 1
        || (afterStat.mode & 0o222) !== 0
        || afterStat.mtimeMs !== info.mtimeMs
        || afterStat.ctimeMs !== info.ctimeMs
      ) {
        throw new GitHubAppError(
          'ACTION_INPUT_INVALID',
          `CAS blob for "${file.name}" mutated during git hash-object`,
        );
      }

      const oidPattern = objectFormat === 'sha1' ? /^[0-9a-f]{40}$/ : /^[0-9a-f]{64}$/;
      const returnedGitOid = Buffer.concat(stdoutChunks).toString('utf8').trim();
      if (!oidPattern.test(returnedGitOid) || returnedGitOid !== expectedGitOid) {
        throw new GitHubAppError(
          'ACTION_INPUT_INVALID',
          `git hash-object OID mismatch for "${file.name}"`,
        );
      }

      return {
        oid: returnedGitOid,
        ...(proposalChunks !== null ? { proposalBytes: Buffer.concat(proposalChunks) } : {}),
      };
    } finally {
      clearTimeout(timer);
      if (child.exitCode === null && child.signalCode === null) {
        child.kill('SIGKILL');
        await exited.catch(() => undefined);
      }
    }
  } finally {
    await handle.close();
  }
}

function compareLexical(a: string, b: string): number {
  if (a === b) return 0;
  return a < b ? -1 : 1;
}

function firstNonEmptyString(...values: readonly unknown[]): string | null {
  for (const value of values) {
    if (typeof value === 'string') {
      const trimmed = value.trim();
      if (trimmed.length > 0) return trimmed;
    }
  }
  return null;
}

function toScalarVersionString(value: unknown): string | null {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return null;
}

function firstDefinedEntryField(entry: Record<string, unknown>, keys: readonly string[]): unknown {
  for (const key of keys) {
    const value = entry[key];
    if (value !== undefined && value !== null) return value;
  }
  return undefined;
}

function stripDisallowedControls(text: string, allowNewline: boolean): string {
  let out = '';
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    if (code === 10 && allowNewline) {
      out += '\n';
    } else if (code === 9 || code === 10 || code === 13) {
      out += ' ';
    } else if (code <= 31 || (code >= 127 && code <= 159)) {
      continue;
    } else {
      out += text[i]!;
    }
  }
  return out;
}

function escapeMarkdownTableCell(value: unknown, scrubber: SecretScrubber): string {
  if (value === null || value === undefined) return '-';
  let raw = '';
  if (typeof value === 'string') {
    raw = scrubber.scrub(value);
  } else if (typeof value === 'number' || typeof value === 'boolean') {
    raw = String(value);
  }
  const cleaned = stripDisallowedControls(raw, false)
    .replace(/\s+/g, ' ')
    .trim();
  if (cleaned.length === 0) return '-';
  const bounded = truncateCodePoints(cleaned, MAX_PR_TABLE_CELL_CODEPOINTS);
  return bounded.replace(/\\/g, '\\\\').replace(/\|/g, '\\|');
}

function escapeInlineCode(raw: string): string {
  return stripDisallowedControls(raw, false).replace(/\s+/g, ' ').trim().replace(/`/g, '\'').replace(/\\/g, '/');
}

function escapeMarkdownInlineProse(raw: string, maxCodePoints: number): string {
  const collapsed = stripDisallowedControls(raw, false).replace(/\s+/g, ' ').trim();
  if (collapsed.length === 0) return '';
  const escaped = collapsed
    .replace(/&/g, '&amp;')
    .replace(/\\/g, '\\\\')
    .replace(/([`*_[\]|])/g, '\\$1')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/^(#+|[-+])/, '\\$1');
  const bounded = truncateCodePoints(escaped, maxCodePoints);
  if (bounded === escaped) return bounded;
  return bounded
    .replace(/&(?:amp|lt|gt|[a-z]{0,3})$/, '')
    .replace(/\\+$/, match => (match.length % 2 === 1 ? match.slice(0, -1) : match))
    .trim();
}

function formatInlineCodeTableCell(raw: string): string {
  const cleaned = escapeInlineCode(raw);
  if (cleaned.length === 0) return '-';
  const bounded = truncateCodePoints(cleaned, MAX_PR_TABLE_CELL_CODEPOINTS);
  return `\`${bounded.replace(/\\/g, '\\\\').replace(/\|/g, '\\|')}\``;
}

function formatVersionTableCell(raw: string | null, scrubber: SecretScrubber): string {
  if (raw === null) return '-';
  const cleaned = stripDisallowedControls(scrubber.scrub(raw), false).replace(/\s+/g, ' ').trim();
  if (cleaned.length === 0) return '-';
  if (HEX_DIGEST_VERSION_PATTERN.test(cleaned)) {
    return `\`${cleaned.slice(0, 12)}\``;
  }
  return formatInlineCodeTableCell(cleaned);
}

function sanitizeProposalLeadText(raw: string): string {
  return stripDisallowedControls(raw.replace(/\r\n?/g, '\n'), true).trim();
}

function findLastStructuralDetailsOpen(text: string): number {
  const blockIdx = text.lastIndexOf('\n<details>\n');
  if (blockIdx !== -1) return blockIdx + 1;
  return text.startsWith('<details>\n') ? 0 : -1;
}

type VersionDiffStatus = 'Added' | 'Removed' | 'Updated' | 'Unchanged' | 'Tracked';

interface VersionDiffRow {
  readonly id: string;
  readonly secondary: string | null;
  readonly previous: string | null;
  readonly target: string | null;
  readonly status: VersionDiffStatus;
}

function computeVersionDiffStatus(
  hasBase: boolean,
  previous: string | null,
  target: string | null,
): VersionDiffStatus {
  if (!hasBase) return 'Tracked';
  if (previous === null) return 'Added';
  if (target === null) return 'Removed';
  return previous !== target ? 'Updated' : 'Unchanged';
}

function renderVersionDiffTable(
  rows: readonly VersionDiffRow[],
  options: {
    readonly primaryHeader: string;
    readonly secondaryHeader: string;
    readonly hasSecondary: boolean;
    readonly hasBase: boolean;
    readonly scrubber: SecretScrubber;
  },
): string {
  const headers: string[] = [options.primaryHeader];
  if (options.hasSecondary) headers.push(options.secondaryHeader);
  if (options.hasBase) headers.push('Previous');
  headers.push('Target');
  if (options.hasBase) headers.push('Status');

  const lines: string[] = [
    `| ${headers.join(' | ')} |`,
    `| ${headers.map(() => '---').join(' | ')} |`,
  ];

  for (const row of rows) {
    const cells: string[] = [formatInlineCodeTableCell(options.scrubber.scrub(row.id))];
    if (options.hasSecondary) {
      cells.push(row.secondary !== null ? formatInlineCodeTableCell(options.scrubber.scrub(row.secondary)) : '-');
    }
    if (options.hasBase) {
      cells.push(formatVersionTableCell(row.previous, options.scrubber));
    }
    cells.push(formatVersionTableCell(row.target, options.scrubber));
    if (options.hasBase) {
      cells.push(row.status);
    }
    lines.push(`| ${cells.join(' | ')} |`);
  }
  return lines.join('\n');
}

function renderVersionChangesSection(
  rows: readonly VersionDiffRow[],
  options: {
    readonly primaryHeader: string;
    readonly secondaryHeader: string;
    readonly hasBase: boolean;
    readonly unchangedLabel: string;
    readonly omittedKeyCount: number;
    readonly scrubber: SecretScrubber;
  },
): string | null {
  if (rows.length === 0) return null;
  const hasSecondary = rows.some(row => row.secondary !== null);
  const tableOpts = {
    primaryHeader: options.primaryHeader,
    secondaryHeader: options.secondaryHeader,
    hasSecondary,
    hasBase: options.hasBase,
    scrubber: options.scrubber,
  };
  let omittedSuffix = '';
  if (options.omittedKeyCount > 0) {
    const entryWord = options.omittedKeyCount === 1 ? 'entry' : 'entries';
    omittedSuffix = `\n\n_...and ${options.omittedKeyCount} additional version ${entryWord} omitted._`;
  }

  if (!options.hasBase) {
    return `## Version Changes\n\n${renderVersionDiffTable(rows, tableOpts)}${omittedSuffix}`;
  }

  const changed = rows.filter(row => row.status !== 'Unchanged');
  const unchanged = rows.filter(row => row.status === 'Unchanged');

  if (changed.length > 0 && unchanged.length > 0) {
    return [
      '## Version Changes',
      '',
      renderVersionDiffTable(changed, tableOpts),
      '',
      '<details>',
      `<summary>Unchanged ${options.unchangedLabel} (${unchanged.length})</summary>`,
      '',
      renderVersionDiffTable(unchanged, tableOpts),
      '</details>',
    ].join('\n') + omittedSuffix;
  }
  if (changed.length === 0 && unchanged.length > 0) {
    return [
      '## Version Changes',
      '',
      `_All ${unchanged.length} ${options.unchangedLabel} match base._`,
      '',
      renderVersionDiffTable(unchanged, tableOpts),
    ].join('\n') + omittedSuffix;
  }
  return `## Version Changes\n\n${renderVersionDiffTable(changed, tableOpts)}${omittedSuffix}`;
}

function extractUpstreamsMap(
  record: Record<string, unknown>,
): Map<string, { readonly pkg: string | null; readonly version: string }> {
  const map = new Map<string, { readonly pkg: string | null; readonly version: string }>();
  const raw = record['upstreams'];
  if (!isPlainRecord(raw)) return map;
  for (const [key, entry] of Object.entries(raw)) {
    if (map.size >= MAX_VERSION_TABLE_ENTRIES) break;
    const id = key.trim();
    if (id.length === 0) continue;
    if (typeof entry === 'string') {
      map.set(id, { pkg: null, version: entry });
    } else if (isPlainRecord(entry)) {
      const version = toScalarVersionString(entry['version']);
      if (version === null) continue;
      const pkg = firstNonEmptyString(entry['package']);
      map.set(id, { pkg, version });
    }
  }
  return map;
}

function extractVersionsMap(
  record: Record<string, unknown>,
): Map<string, string> {
  const map = new Map<string, string>();
  const raw = record['versions'];
  if (!isPlainRecord(raw)) return map;
  for (const [key, val] of Object.entries(raw)) {
    if (map.size >= MAX_VERSION_TABLE_ENTRIES) break;
    const id = key.trim();
    if (id.length === 0) continue;
    const version = toScalarVersionString(val);
    if (version !== null) {
      map.set(id, version);
    }
  }
  return map;
}

function extractSubscriptionEntryName(item: Record<string, unknown>): string | null {
  return firstNonEmptyString(item['subscription'], item['id'], item['name']);
}

function extractSubscriptionSources(
  record: Record<string, unknown> | null,
  out: Map<string, string>,
): void {
  if (record === null) return;
  const raw = record['subscriptions'];
  if (Array.isArray(raw)) {
    for (const item of raw) {
      if (out.size >= MAX_VERSION_TABLE_ENTRIES) break;
      if (!isPlainRecord(item)) continue;
      const id = extractSubscriptionEntryName(item);
      const source = firstNonEmptyString(item['source']);
      if (id !== null && source !== null && !out.has(id)) {
        out.set(id, source);
      }
    }
  } else if (isPlainRecord(raw)) {
    for (const [key, entry] of Object.entries(raw)) {
      if (out.size >= MAX_VERSION_TABLE_ENTRIES) break;
      const id = key.trim();
      if (id.length === 0 || !isPlainRecord(entry)) continue;
      const source = firstNonEmptyString(entry['source']);
      if (source !== null && !out.has(id)) {
        out.set(id, source);
      }
    }
  }
}

function collectBoundedOrderedKeys(
  candidateMap: ReadonlyMap<string, unknown>,
  baseMap: ReadonlyMap<string, unknown>,
): { readonly orderedKeys: readonly string[]; readonly omittedKeyCount: number } {
  const allOrderedKeys: string[] = [...candidateMap.keys()];
  for (const baseKey of baseMap.keys()) {
    if (!candidateMap.has(baseKey)) {
      allOrderedKeys.push(baseKey);
    }
  }
  const orderedKeys = allOrderedKeys.slice(0, MAX_VERSION_TABLE_ENTRIES);
  const omittedKeyCount = Math.max(0, allOrderedKeys.length - MAX_VERSION_TABLE_ENTRIES);
  return { orderedKeys, omittedKeyCount };
}

function hasRunnerSubscriptionFields(entry: Record<string, unknown>): boolean {
  return RUNNER_SUBSCRIPTION_KEYS.some(key => Object.hasOwn(entry, key) && entry[key] !== undefined);
}

export function buildNativePullRequestBody(options: {
  readonly runId: string;
  readonly candidateDigest: string;
  readonly proposalPath?: string | undefined;
  readonly files: readonly { readonly name: string; readonly bytes: Uint8Array }[];
  readonly stagedPaths?: ReadonlySet<string | undefined> | undefined;
  readonly baseProposalBytes?: Uint8Array | undefined;
  readonly modifiedPaths?: readonly string[] | undefined;
  readonly scrubber: SecretScrubber;
}): string {
  const provenanceFooter = options.scrubber.scrub(
    `Automated Loopwright update for run \`${options.runId}\` (\`${options.candidateDigest.slice(0, 12)}\`).`,
  );
  if (options.proposalPath === undefined || options.proposalPath.trim().length === 0) {
    return provenanceFooter;
  }

  let cleanProposalPath: string;
  try {
    cleanProposalPath = normalizeCandidateRelativePath(options.proposalPath.trim().replace(/^(?:\.\/)+/, ''));
  } catch {
    return provenanceFooter;
  }

  if (options.stagedPaths !== undefined && !options.stagedPaths.has(cleanProposalPath)) {
    return provenanceFooter;
  }
  const proposalFile = options.files.find(file => file.name === cleanProposalPath);
  if (
    proposalFile === undefined
    || proposalFile.bytes.byteLength === 0
    || proposalFile.bytes.byteLength > MAX_PROPOSAL_JSON_BYTES
  ) {
    return provenanceFooter;
  }

  let parsed: unknown;
  try {
    const decoded = new TextDecoder('utf-8', { fatal: true }).decode(proposalFile.bytes);
    parsed = JSON.parse(decoded);
  } catch {
    return provenanceFooter;
  }
  if (!isPlainRecord(parsed)) {
    return provenanceFooter;
  }

  let baseParsed: Record<string, unknown> | null = null;
  if (
    options.baseProposalBytes !== undefined
    && options.baseProposalBytes.byteLength > 0
    && options.baseProposalBytes.byteLength <= MAX_PROPOSAL_JSON_BYTES
  ) {
    try {
      const decodedBase = new TextDecoder('utf-8', { fatal: true }).decode(options.baseProposalBytes);
      const candidateBase: unknown = JSON.parse(decodedBase);
      if (isPlainRecord(candidateBase)) {
        baseParsed = candidateBase;
      }
    } catch {
      baseParsed = null;
    }
  }
  const hasBase = baseParsed !== null;

  const sections: string[] = [];

  const summaryParts: string[] = [];
  if (typeof parsed['summary'] === 'string') {
    const cleanSummary = sanitizeProposalLeadText(options.scrubber.scrub(parsed['summary']));
    if (cleanSummary.length > 0) {
      summaryParts.push(cleanSummary);
    }
  }
  const metaBullets: string[] = [];
  if (typeof parsed['stage'] === 'string') {
    const cleanStage = escapeInlineCode(options.scrubber.scrub(parsed['stage']));
    if (cleanStage.length > 0) {
      metaBullets.push(`- **Stage**: \`${cleanStage}\``);
    }
  }
  if (typeof parsed['notes'] === 'string') {
    const cleanNotes = escapeMarkdownInlineProse(
      options.scrubber.scrub(parsed['notes']),
      MAX_PR_NOTES_CODEPOINTS,
    );
    if (cleanNotes.length > 0) {
      metaBullets.push(`- **Notes**: ${cleanNotes}`);
    }
  } else if (Array.isArray(parsed['notes'])) {
    const noteItems: string[] = [];
    for (const item of parsed['notes']) {
      if (noteItems.length >= 10) break;
      if (typeof item !== 'string') continue;
      const cleanNote = escapeMarkdownInlineProse(
        options.scrubber.scrub(item),
        MAX_PR_TABLE_CELL_CODEPOINTS,
      );
      if (cleanNote.length > 0) {
        noteItems.push(cleanNote);
      }
    }
    if (noteItems.length > 0) {
      metaBullets.push('- **Notes**:');
      for (const note of noteItems) {
        metaBullets.push(`  - ${note}`);
      }
    }
  }
  if (metaBullets.length > 0) {
    summaryParts.push(metaBullets.join('\n'));
  }
  if (summaryParts.length > 0) {
    sections.push(`## Summary\n\n${summaryParts.join('\n\n')}`);
  }

  let hasVersionTable = false;
  const candidateUpstreams = extractUpstreamsMap(parsed);
  const baseUpstreams = baseParsed !== null
    ? extractUpstreamsMap(baseParsed)
    : new Map<string, { readonly pkg: string | null; readonly version: string }>();
  if (candidateUpstreams.size > 0 || (hasBase && baseUpstreams.size > 0)) {
    const { orderedKeys, omittedKeyCount } = collectBoundedOrderedKeys(candidateUpstreams, baseUpstreams);
    const rows: VersionDiffRow[] = orderedKeys.map(id => {
      const cand = candidateUpstreams.get(id);
      const base = baseUpstreams.get(id);
      const previous = base?.version ?? null;
      const target = cand?.version ?? null;
      return {
        id,
        secondary: cand?.pkg ?? base?.pkg ?? null,
        previous,
        target,
        status: computeVersionDiffStatus(hasBase, previous, target),
      };
    });
    const versionSection = renderVersionChangesSection(rows, {
      primaryHeader: 'Upstream',
      secondaryHeader: 'Package',
      hasBase,
      unchangedLabel: 'tracked upstream pins',
      omittedKeyCount,
      scrubber: options.scrubber,
    });
    if (versionSection !== null) {
      sections.push(versionSection);
      hasVersionTable = true;
    }
  }

  if (!hasVersionTable) {
    const candidateVersions = extractVersionsMap(parsed);
    const baseVersions = baseParsed !== null
      ? extractVersionsMap(baseParsed)
      : new Map<string, string>();
    if (candidateVersions.size > 0 || (hasBase && baseVersions.size > 0)) {
      const sourceMap = new Map<string, string>();
      extractSubscriptionSources(parsed, sourceMap);
      extractSubscriptionSources(baseParsed, sourceMap);
      const { orderedKeys, omittedKeyCount } = collectBoundedOrderedKeys(candidateVersions, baseVersions);
      const rows: VersionDiffRow[] = orderedKeys.map(id => {
        const previous = baseVersions.get(id) ?? null;
        const target = candidateVersions.get(id) ?? null;
        return {
          id,
          secondary: sourceMap.get(id) ?? null,
          previous,
          target,
          status: computeVersionDiffStatus(hasBase, previous, target),
        };
      });
      const versionSection = renderVersionChangesSection(rows, {
        primaryHeader: 'Component',
        secondaryHeader: 'Source',
        hasBase,
        unchangedLabel: 'tracked versions',
        omittedKeyCount,
        scrubber: options.scrubber,
      });
      if (versionSection !== null) {
        sections.push(versionSection);
        hasVersionTable = true;
      }
    }
  }

  const rawSubscriptions = parsed['subscriptions'];
  const subRows: Array<{ readonly name: string; readonly entry: Record<string, unknown> }> = [];
  if (isPlainRecord(rawSubscriptions)) {
    for (const [key, entry] of Object.entries(rawSubscriptions)) {
      if (subRows.length >= MAX_VERSION_TABLE_ENTRIES) break;
      const rawName = key.trim();
      if (rawName.length > 0 && isPlainRecord(entry)) {
        subRows.push({ name: rawName, entry });
      }
    }
  } else if (Array.isArray(rawSubscriptions)) {
    for (const item of rawSubscriptions) {
      if (subRows.length >= MAX_VERSION_TABLE_ENTRIES) break;
      if (!isPlainRecord(item)) continue;
      const rawName = extractSubscriptionEntryName(item);
      if (rawName !== null) {
        subRows.push({ name: rawName, entry: item });
      }
    }
  }

  if (subRows.length > 0 && (!hasVersionTable || subRows.some(row => hasRunnerSubscriptionFields(row.entry)))) {
    const tableLines: string[] = [
      '## Subscriptions',
      '',
      '| Subscription | Status | Engine | Plugin | Reason |',
      '| --- | --- | --- | --- | --- |',
    ];
    for (const { name, entry } of subRows) {
      const subCell = escapeMarkdownTableCell(name, options.scrubber);
      const statusCell = escapeMarkdownTableCell(entry['status'], options.scrubber);
      const engineCell = escapeMarkdownTableCell(
        firstDefinedEntryField(entry, RUNNER_ENGINE_KEYS),
        options.scrubber,
      );
      const pluginCell = escapeMarkdownTableCell(
        firstDefinedEntryField(entry, RUNNER_PLUGIN_KEYS),
        options.scrubber,
      );
      const reasonCell = escapeMarkdownTableCell(entry['reason'], options.scrubber);
      tableLines.push(`| ${subCell} | ${statusCell} | ${engineCell} | ${pluginCell} | ${reasonCell} |`);
    }
    sections.push(tableLines.join('\n'));
  }

  if (options.modifiedPaths !== undefined && options.modifiedPaths.length > 0) {
    const cleanPaths: string[] = [];
    const seenPaths = new Set<string>();
    const omittedInputCount = Math.max(0, options.modifiedPaths.length - MAX_MODIFIED_PATHS_INPUT);
    for (const rawPath of options.modifiedPaths.slice(0, MAX_MODIFIED_PATHS_INPUT)) {
      const scrubbedPath = options.scrubber.scrub(rawPath);
      const cleaned = stripDisallowedControls(scrubbedPath, false).replace(/\s+/g, ' ').trim();
      if (cleaned.length > 0 && !seenPaths.has(cleaned)) {
        seenPaths.add(cleaned);
        cleanPaths.push(cleaned);
      }
    }
    if (cleanPaths.length > 0) {
      const count = cleanPaths.length;
      const countLabel = omittedInputCount > 0 ? `${count}+` : String(count);
      const fileLines: string[] = [`## Modified Files (${countLabel})`, ''];
      if (count <= 15) {
        for (const p of cleanPaths) {
          fileLines.push(`- \`${escapeInlineCode(p)}\``);
        }
      } else {
        const dirCounts = new Map<string, number>();
        for (const p of cleanPaths) {
          const slashIdx = p.indexOf('/');
          const topDir = slashIdx > 0 ? `${p.slice(0, slashIdx)}/` : '(root)';
          dirCounts.set(topDir, (dirCounts.get(topDir) ?? 0) + 1);
        }
        const sortedDirs = [...dirCounts.entries()].sort((a, b) => compareLexical(a[0], b[0]));
        for (const [dir, dirCount] of sortedDirs) {
          const label = dir === '(root)' ? '`(root)`' : `\`${escapeInlineCode(dir)}\``;
          fileLines.push(`- ${label}: ${dirCount} ${dirCount === 1 ? 'file' : 'files'}`);
        }
        fileLines.push('');
        fileLines.push('<details>');
        fileLines.push(`<summary>View modified files (${countLabel})</summary>`);
        fileLines.push('');
        for (const p of cleanPaths.slice(0, 100)) {
          fileLines.push(`- \`${escapeInlineCode(p)}\``);
        }
        if (cleanPaths.length > 100) {
          fileLines.push(`- ...and ${cleanPaths.length - 100} more`);
        }
        fileLines.push('</details>');
      }
      if (omittedInputCount > 0) {
        const pathWord = omittedInputCount === 1 ? 'path' : 'paths';
        fileLines.push('');
        fileLines.push(`_...and ${omittedInputCount} additional ${pathWord} omitted._`);
      }
      sections.push(fileLines.join('\n'));
    }
  }

  if (sections.length === 0) {
    return provenanceFooter;
  }

  const scrubbedLead = options.scrubber.scrub(sections.join('\n\n')).trim();
  if (scrubbedLead.length === 0) {
    return provenanceFooter;
  }
  const footerWithSeparator = `\n\n---\n\n${provenanceFooter}`;
  const footerCodePoints = Array.from(footerWithSeparator).length;
  const maxLeadCodePoints = Math.max(1, MAX_PR_BODY_CODEPOINTS - footerCodePoints);
  if (Array.from(scrubbedLead).length <= maxLeadCodePoints) {
    return `${scrubbedLead}${footerWithSeparator}`;
  }

  let boundedLead = truncateCodePoints(scrubbedLead, maxLeadCodePoints);
  boundedLead = boundedLead.replace(/<[a-z/!][^>]*$/i, '').trimEnd();
  const openDetails = findLastStructuralDetailsOpen(boundedLead);
  if (openDetails !== -1 && boundedLead.indexOf('\n</details>', openDetails) === -1) {
    boundedLead = boundedLead.slice(0, openDetails).trimEnd();
  }
  if (boundedLead.length === 0) {
    return provenanceFooter;
  }
  return `${boundedLead}${footerWithSeparator}`;
}

/**
 * Start a loopback HTTP server implementing Loopwright's signed publication protocol
 * using pure Git index/tree plumbing over a private temporary `GIT_INDEX_FILE`
 * (preserving repository `HEAD`, working tree, `.git/worktrees`, and protected
 * paths/symlinks), single-FD `1 MiB` streaming `git hash-object -w --stdin`,
 * and `--force-with-lease` push protection.
 */
export async function startNativePullRequestPublisherServer(
  options: NativePullRequestPublisherOptions,
): Promise<NativePullRequestPublisherServer> {
  const commitIdentity = options.gitCommitIdentity !== undefined
    ? validateGitCommitIdentity(options.gitCommitIdentity)
    : DEFAULT_GIT_COMMIT_IDENTITY;
  const scrubber = options.scrubber ?? new SecretScrubber();
  const signingSecret = options.signingSecret ?? randomBytes(32).toString('hex');
  const authToken = options.authToken ?? randomBytes(32).toString('hex');
  scrubber.register(signingSecret);
  scrubber.register(authToken);
  if (options.gitWriteToken) scrubber.register(options.gitWriteToken);

  const ownedScratch = options.scratchRoot === undefined;
  const rawScratchBase = options.scratchRoot ?? await mkdtemp(join(tmpdir(), 'loopwright-pub-'));
  await chmod(rawScratchBase, 0o700);
  const scratchBase = await realpath(rawScratchBase);

  const host = options.host ?? '127.0.0.1';
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;

  interface PublicationReceiptPayload {
    readonly version: 1;
    readonly kind: 'publication_receipt';
    readonly storeId: string;
    readonly runId: string;
    readonly lockHash: unknown;
    readonly operationId: string;
    readonly dispatchId: string;
    readonly dispatchGeneration: unknown;
    readonly idempotencyKey: string;
    readonly outcome: 'succeeded' | 'not_executed' | 'failed';
    readonly externalUrl: string | null;
    readonly reason: string | null;
    readonly candidateDigest: string;
  }

  const receiptCache = new Map<string, PublicationReceiptPayload>();

  const server = createServer(async (req, res) => {
    const pathname = (req.url ?? '/').split('?')[0];
    if (req.method !== 'POST' || pathname !== '/publish') {
      writePlainJsonResponse(res, 404, { error: 'not_found' });
      return;
    }

    let rawBody: Buffer;
    try {
      rawBody = await readIncomingBody(req, MAX_REQUEST_BODY_BYTES);
    } catch {
      writePlainJsonResponse(res, 413, { error: 'payload_too_large' });
      return;
    }

    const signatureHeader = req.headers['x-loopwright-signature'];
    const signature = typeof signatureHeader === 'string' ? signatureHeader : '';
    if (!verifySignedPayload(signingSecret, rawBody, signature)) {
      writePlainJsonResponse(res, 401, { error: 'invalid_signature' });
      return;
    }

    const authHeader = req.headers['authorization'];
    if (authHeader !== `Bearer ${authToken}`) {
      writePlainJsonResponse(res, 401, { error: 'invalid_bearer_token' });
      return;
    }

    let request: unknown;
    try {
      request = JSON.parse(rawBody.toString('utf8'));
    } catch {
      writePlainJsonResponse(res, 400, { error: 'invalid_json' });
      return;
    }
    if (!isPlainRecord(request)) {
      writePlainJsonResponse(res, 400, { error: 'invalid_request' });
      return;
    }

    const storeId = String(request['storeId'] ?? '');
    const runId = String(request['runId'] ?? '');
    const lockHash = request['lockHash'] ?? null;
    const operationId = String(request['operationId'] ?? '');
    const dispatchId = String(request['dispatchId'] ?? '');
    const dispatchGeneration = request['dispatchGeneration'] ?? null;
    const idempotencyKey = String(request['idempotencyKey'] ?? '');
    const candidateDigest = String(request['candidateDigest'] ?? '');
    const cleanRunId = stripDisallowedControls(scrubber.scrub(runId), false).replace(/\s+/g, ' ').trim();
    const rawTitle = typeof request['title'] === 'string'
      ? stripDisallowedControls(scrubber.scrub(request['title']), true).trim()
      : '';
    const expandedTemplate = options.titleTemplate?.trim()
      ? stripDisallowedControls(
          scrubber.scrub(
            options.titleTemplate.trim()
              .replace(/\$\{repository\}/g, options.repositoryFullName)
              .replace(/\$\{runId\}/g, cleanRunId)
              .replace(/\$\{candidateDigest\}/g, candidateDigest.slice(0, 12)),
          ),
          false,
        ).replace(/\s+/g, ' ').trim()
      : '';
    const fallbackTitle = `chore(loopwright): automated update (${truncateCodePoints(cleanRunId || 'run', 34)})`;
    const title = scrubber.scrub(firstNonEmptyString(rawTitle, expandedTemplate) ?? fallbackTitle);
    const prTitle = stripDisallowedControls(title, false).replace(/\s+/g, ' ').trim();
    const targetBranch = String(request['targetBranch'] ?? options.targetBranch);

    if (idempotencyKey.length > 0) {
      const cached = receiptCache.get(idempotencyKey);
      if (cached !== undefined) {
        writeSignedJsonResponse(res, 200, signingSecret, cached);
        return;
      }
    }

    const makeReceipt = (
      outcome: 'succeeded' | 'not_executed' | 'failed',
      externalUrl: string | null,
      reason: string | null,
    ): PublicationReceiptPayload => ({
      version: 1,
      kind: 'publication_receipt',
      storeId,
      runId,
      lockHash,
      operationId,
      dispatchId,
      dispatchGeneration,
      idempotencyKey,
      outcome,
      externalUrl,
      reason,
      candidateDigest,
    });

    const emitReceipt = (receipt: PublicationReceiptPayload): void => {
      if (idempotencyKey.length > 0) {
        receiptCache.set(idempotencyKey, receipt);
      }
      writeSignedJsonResponse(res, 200, signingSecret, receipt);
    };

    const workRoot = await mkdtemp(join(scratchBase, 'idx-'));
    await chmod(workRoot, 0o700);
    const indexFile = join(workRoot, 'index');
    const gitEnv = buildGitAuthEnv(options.gitWriteToken);
    const gitRepo = (
      args: readonly string[],
      extraOpts?: { readonly input?: Buffer | string | undefined; readonly timeoutMs?: number | undefined },
    ): Promise<Buffer> =>
      execGit(options.repositoryRoot, args, { env: gitEnv, ...extraOpts });
    const gitWithIndex = (
      args: readonly string[],
      extraOpts?: { readonly input?: Buffer | string | undefined; readonly timeoutMs?: number | undefined },
    ): Promise<Buffer> =>
      execGit(options.repositoryRoot, args, { env: { ...gitEnv, GIT_INDEX_FILE: indexFile }, ...extraOpts });
    let mutationStarted = false;

    try {
      const realRunRoot = await realpath(options.runRoot);
      const snapshot = await inspectAndVerifyCandidate(realRunRoot, runId, candidateDigest, workRoot);
      const baseRevision = String(request['baseRevision'] ?? snapshot.baseRevision);
      const sourceRevision = String(request['sourceRevision'] ?? snapshot.sourceRevision);
      if (!COMMIT_SHA_PATTERN.test(baseRevision) || !COMMIT_SHA_PATTERN.test(sourceRevision)) {
        throw new GitHubAppError('ACTION_INPUT_INVALID', 'baseRevision and sourceRevision must be 40-hex commit SHAs');
      }

      const branchName = options.openManagedPr?.headRef ?? `${options.headBranchPrefix}${targetBranch}`;
      if (!SAFE_BRANCH_PATTERN.test(branchName) || branchName.includes('..') || branchName.startsWith('-')) {
        throw new GitHubAppError('ACTION_INPUT_INVALID', `unsafe target branch name "${branchName}"`);
      }

      await gitRepo(['rev-parse', '--verify', '--end-of-options', `${baseRevision}^{commit}`]);
      await gitRepo(['rev-parse', '--verify', '--end-of-options', `${sourceRevision}^{commit}`]);
      if (snapshot.manifest.spec.baseTree !== undefined) {
        await verifyBaseTreeAnchor(
          options.repositoryRoot,
          snapshot.manifest.spec.baseTree,
          gitEnv,
          sourceRevision,
        );
      }
      const baseTreeOid = (
        await gitRepo(['rev-parse', '--verify', '--end-of-options', `${baseRevision}^{tree}`])
      ).toString('utf8').trim();

      await gitWithIndex(['read-tree', `${baseRevision}^{tree}`]);

      const baseEntries = await listTreeEntriesAtRevision(options.repositoryRoot, baseRevision, gitEnv);
      const sourceEntries = sourceRevision === baseRevision
        ? baseEntries
        : await listTreeEntriesAtRevision(options.repositoryRoot, sourceRevision, gitEnv);

      const carriedUpdatesByPath = new Map<string, CarryDeltaEntry>();
      let carryRemovalsList: readonly string[] = [];
      if (sourceRevision !== baseRevision) {
        const { carryRemovals, carryUpdates } = computeAllowedSourceRevisionCarryDelta(
          snapshot,
          baseEntries,
          sourceEntries,
        );
        carryRemovalsList = carryRemovals;
        if (carryRemovals.length > 0) {
          await removePathsFromIndex(options.repositoryRoot, indexFile, carryRemovals, gitEnv);
        }
        if (carryUpdates.length > 0) {
          await stageEntriesInIndex(options.repositoryRoot, indexFile, carryUpdates, gitEnv);
          for (const entry of carryUpdates) {
            carriedUpdatesByPath.set(entry.path, entry);
          }
        }
      }

      let cleanProposalPath: string | undefined;
      if (options.proposalPath !== undefined && options.proposalPath.trim().length > 0) {
        try {
          cleanProposalPath = normalizeCandidateRelativePath(options.proposalPath.trim().replace(/^(?:\.\/)+/, ''));
        } catch {
          cleanProposalPath = undefined;
        }
      }

      const objectFormat = snapshot.manifest.spec.baseTree?.objectFormat ?? 'sha1';
      const oidPattern = objectFormat === 'sha1' ? /^[0-9a-f]{40}$/ : /^[0-9a-f]{64}$/;
      const candidateNames = new Set<string>();
      const stagedFiles: Array<{ readonly path: string; readonly mode: '100644' | '100755'; readonly oid: string }> = [];
      let candidateProposalBytes: Uint8Array | undefined;

      for (const file of snapshot.files) {
        candidateNames.add(file.name);
        if (!isAllowedCandidateWrite(file.name, snapshot)) {
          continue;
        }
        if (hasSymlinkAtOrAbove(file.name, baseEntries, sourceEntries)) {
          throw new GitHubAppError(
            'ACTION_INPUT_INVALID',
            'Refusing to overwrite symlinked candidate path during native PR publication.',
          );
        }

        const isTargetProposal = cleanProposalPath !== undefined && file.name === cleanProposalPath;
        let blobOid: string;
        if (file.kind === 'cas') {
          const captureProposalBytes = isTargetProposal && file.byteLength > 0 && file.byteLength <= MAX_PROPOSAL_JSON_BYTES;
          const streamed = await streamVerifiedCasBlobToGitObject({
            realRunRoot,
            runId,
            repositoryRoot: options.repositoryRoot,
            objectFormat,
            file,
            gitEnv,
            captureProposalBytes,
          });
          blobOid = streamed.oid;
          if (streamed.proposalBytes !== undefined) {
            candidateProposalBytes = streamed.proposalBytes;
          }
        } else {
          const computedGitOid = createHash(objectFormat)
            .update(`blob ${file.bytes.byteLength}\0`)
            .update(file.bytes)
            .digest('hex');
          blobOid = (
            await gitRepo(['hash-object', '-w', '--stdin'], { input: Buffer.from(file.bytes) })
          ).toString('utf8').trim();
          if (!oidPattern.test(blobOid) || blobOid !== computedGitOid) {
            throw new GitHubAppError('ACTION_INPUT_INVALID', `git hash-object returned invalid oid for "${file.name}"`);
          }
          if (isTargetProposal && file.bytes.byteLength > 0 && file.bytes.byteLength <= MAX_PROPOSAL_JSON_BYTES) {
            candidateProposalBytes = file.bytes;
          }
        }

        const baselineEntryMode = sourceEntries.get(file.name)?.mode ?? baseEntries.get(file.name)?.mode;
        const mode: '100644' | '100755' = file.kind === 'cas'
          ? file.mode
          : (file.mode ?? (baselineEntryMode === '100755' ? '100755' : '100644'));
        stagedFiles.push({ path: file.name, mode, oid: blobOid });
      }

      const filesToRemove: string[] = [];
      if (snapshot.manifest.spec.baseTree !== undefined) {
        for (const rawDeleted of snapshot.manifest.spec.deleted ?? []) {
          const deletedName = normalizeCandidateRelativePath(rawDeleted);
          if (
            !candidateNames.has(deletedName)
            && isAllowedCandidateWrite(deletedName, snapshot)
            && !hasSymlinkAtOrAbove(deletedName, baseEntries, sourceEntries)
          ) {
            filesToRemove.push(deletedName);
          }
        }
      } else {
        for (const [sourceName, sourceEntry] of sourceEntries.entries()) {
          if (sourceEntry.mode !== '100644' && sourceEntry.mode !== '100755') continue;
          if (
            !candidateNames.has(sourceName)
            && isAllowedCandidateWrite(sourceName, snapshot)
            && !hasSymlinkAtOrAbove(sourceName, baseEntries, sourceEntries)
          ) {
            filesToRemove.push(sourceName);
          }
        }
      }

      if (filesToRemove.length > 0) {
        await removePathsFromIndex(options.repositoryRoot, indexFile, filesToRemove, gitEnv);
      }
      if (stagedFiles.length > 0) {
        await stageEntriesInIndex(options.repositoryRoot, indexFile, stagedFiles, gitEnv);
      }

      const treeOid = (await gitWithIndex(['write-tree'])).toString('utf8').trim();
      if (treeOid === baseTreeOid && (options.openManagedPr === undefined || options.openManagedPr === null)) {
        throw new GitHubAppError(
          'ACTION_INPUT_INVALID',
          'candidate tree matches base tree; refusing to push empty pull request branch',
        );
      }
      let headOid = baseRevision;
      if (treeOid !== baseTreeOid) {
        const signoffLine = `Signed-off-by: ${commitIdentity.name} <${commitIdentity.email}>`;
        const normalizedTitle = title.replace(/\r\n?/g, '\n').trimEnd();
        const hasExactSignoff = normalizedTitle.split('\n').some(line => line.trim() === signoffLine);
        const commitMessage = hasExactSignoff
          ? `${normalizedTitle}\n`
          : `${normalizedTitle}\n\n${signoffLine}\n`;
        headOid = (
          await gitRepo(
            [
              '-c', `user.name=${commitIdentity.name}`,
              '-c', `user.email=${commitIdentity.email}`,
              'commit-tree',
              treeOid,
              '-p',
              baseRevision,
            ],
            { input: commitMessage },
          )
        ).toString('utf8').trim();
      }

      const remote = options.remoteUrl ?? 'origin';
      const remoteKind: 'https' | 'local-dir' = remote === 'origin'
        ? 'https'
        : validateGitRemoteSource(remote);
      const protocolArgs = remoteKind === 'local-dir'
        ? ['-c', 'protocol.file.allow=always', '-c', 'protocol.ext.allow=never', '-c', 'protocol.ssh.allow=never']
        : ['-c', 'protocol.ext.allow=never', '-c', 'protocol.ssh.allow=never'];

      let expectedRemoteOid = '';
      if (options.openManagedPr !== undefined && options.openManagedPr !== null) {
        expectedRemoteOid = options.openManagedPr.headSha;
      } else {
        const remoteOut = (
          await gitRepo([...protocolArgs, 'ls-remote', '--', remote, `refs/heads/${branchName}`])
        ).toString('utf8');
        const existingRef = remoteOut.split(/\r?\n/).some(line => line.trim().length > 0);
        if (existingRef) {
          throw new GitHubAppError(
            'ACTION_INPUT_INVALID',
            `refusing to overwrite existing remote branch refs/heads/${branchName} without an associated open managed PR`,
          );
        }
      }

      mutationStarted = true;
      await gitRepo(
        [
          ...protocolArgs,
          'push',
          `--force-with-lease=refs/heads/${branchName}:${expectedRemoteOid}`,
          '--',
          remote,
          `${headOid}:refs/heads/${branchName}`,
        ],
        { timeoutMs: 25_000 },
      );

      let externalUrl: string | null = null;
      const apiBaseUrl = options.apiBaseUrl?.trim().replace(/\/+$/, '');
      if (apiBaseUrl && apiBaseUrl.length > 0) {
        const apiHeaders: Record<string, string> = {
          accept: 'application/vnd.github+json',
          'content-type': 'application/json',
          'user-agent': 'loopwright-github-app',
        };
        if (options.gitWriteToken) {
          apiHeaders['authorization'] = `Bearer ${options.gitWriteToken}`;
        }
        const stagedPathSet = new Set<string>(stagedFiles.map(entry => entry.path));
        const finalEntryByPath = new Map<string, { readonly mode: '100644' | '100755'; readonly oid: string }>();
        for (const [path, entry] of carriedUpdatesByPath) {
          finalEntryByPath.set(path, { mode: entry.mode, oid: entry.oid });
        }
        for (const entry of stagedFiles) {
          finalEntryByPath.set(entry.path, { mode: entry.mode, oid: entry.oid });
        }
        const modifiedPathSet = new Set<string>();
        for (const removedPath of carryRemovalsList) {
          if (!finalEntryByPath.has(removedPath) && baseEntries.has(removedPath)) {
            modifiedPathSet.add(removedPath);
          }
        }
        for (const removedPath of filesToRemove) {
          finalEntryByPath.delete(removedPath);
          if (baseEntries.has(removedPath)) {
            modifiedPathSet.add(removedPath);
          }
        }
        for (const [path, finalEntry] of finalEntryByPath) {
          const baseEntry = baseEntries.get(path);
          if (baseEntry === undefined || baseEntry.oid !== finalEntry.oid || baseEntry.mode !== finalEntry.mode) {
            modifiedPathSet.add(path);
          }
        }
        const modifiedPaths = [...modifiedPathSet].sort(compareLexical);

        const readBoundedProposalBlob = async (
          oid: string,
          warnLabel?: string,
        ): Promise<Buffer | undefined> => {
          if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(oid)) return undefined;
          try {
            const sizeText = (await gitRepo(['cat-file', '-s', oid])).toString('utf8').trim();
            const byteSize = Number(sizeText);
            if (Number.isSafeInteger(byteSize) && byteSize > 0 && byteSize <= MAX_PROPOSAL_JSON_BYTES) {
              return await execGit(
                options.repositoryRoot,
                ['cat-file', 'blob', oid],
                { env: gitEnv, maxStdoutBytes: MAX_PROPOSAL_JSON_BYTES },
              );
            }
            if (warnLabel !== undefined && Number.isSafeInteger(byteSize) && byteSize > MAX_PROPOSAL_JSON_BYTES) {
              process.stderr.write(
                `${scrubber.scrub(
                  `[loopwright] warning: ${warnLabel} (${byteSize} bytes) exceeds ${MAX_PROPOSAL_JSON_BYTES} byte limit; falling back to provenance footer`,
                )}\n`,
              );
            }
          } catch (error) {
            if (warnLabel !== undefined) {
              const detail = (error instanceof Error ? error.message : String(error)).replace(/[\r\n]+/g, ' ');
              process.stderr.write(
                `${scrubber.scrub(
                  `[loopwright] warning: failed to read ${warnLabel} from ${oid}: ${detail}`,
                )}\n`,
              );
            }
          }
          return undefined;
        };

        let baseProposalBytes: Uint8Array | undefined;
        if (cleanProposalPath !== undefined) {
          const baseProposalEntry = baseEntries.get(cleanProposalPath);
          if (
            baseProposalEntry !== undefined
            && (baseProposalEntry.mode === '100644' || baseProposalEntry.mode === '100755')
          ) {
            baseProposalBytes = await readBoundedProposalBlob(baseProposalEntry.oid);
          }
          if (
            !stagedPathSet.has(cleanProposalPath)
            && !filesToRemove.includes(cleanProposalPath)
          ) {
            const carriedProposal = carriedUpdatesByPath.get(cleanProposalPath);
            if (carriedProposal !== undefined) {
              const carriedBytes = await readBoundedProposalBlob(
                carriedProposal.oid,
                `carried proposal "${cleanProposalPath}"`,
              );
              if (carriedBytes !== undefined) {
                stagedPathSet.add(cleanProposalPath);
                candidateProposalBytes = carriedBytes;
              }
            }
          }
        }

        const prBodyFiles: readonly { readonly name: string; readonly bytes: Uint8Array }[] =
          cleanProposalPath !== undefined && candidateProposalBytes !== undefined
            ? [{ name: cleanProposalPath, bytes: candidateProposalBytes }]
            : [];

        const prBody = buildNativePullRequestBody({
          runId,
          candidateDigest,
          proposalPath: options.proposalPath,
          files: prBodyFiles,
          stagedPaths: stagedPathSet,
          baseProposalBytes,
          modifiedPaths,
          scrubber,
        });
        const isUpdate = options.openManagedPr !== undefined && options.openManagedPr !== null;
        const prUrl = isUpdate
          ? `${apiBaseUrl}/repos/${options.repositoryFullName}/pulls/${options.openManagedPr!.number}`
          : `${apiBaseUrl}/repos/${options.repositoryFullName}/pulls`;
        const prRes = await fetchBoundedText(
          prUrl,
          fetchImpl,
          apiHeaders,
          15_000,
          scrubber,
          {
            method: isUpdate ? 'PATCH' : 'POST',
            body: JSON.stringify(
              isUpdate
                ? { title: prTitle, body: prBody }
                : { title: prTitle, head: branchName, base: targetBranch, body: prBody },
            ),
          },
        );
        if (!prRes.ok) {
          throw new GitHubAppError(
            'ACTION_INPUT_INVALID',
            `pull request API failed (${prRes.status}): ${scrubber.scrub(prRes.text)}`,
          );
        }
        const parsedPr = JSON.parse(prRes.text) as unknown;
        if (isPlainRecord(parsedPr) && typeof parsedPr['html_url'] === 'string') {
          externalUrl = parsedPr['html_url'];
        }
      }

      emitReceipt(makeReceipt('succeeded', externalUrl, null));
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      const scrubbed = truncateCodePoints(
        sanitizeReportText(detail, { scrub: text => scrubber.scrub(text), singleLine: true }),
        MAX_REASON_CODEPOINTS,
      );
      emitReceipt(makeReceipt(
        mutationStarted ? 'failed' : 'not_executed',
        null,
        scrubbed.length > 0 ? scrubbed : 'publication aborted',
      ));
    } finally {
      await rm(workRoot, { recursive: true, force: true }).catch(() => undefined);
    }
  });
  server.requestTimeout = 0;
  server.headersTimeout = LOCAL_GATE_HTTP_HEADERS_TIMEOUT_MS;

  await new Promise<void>((resolvePromise, reject) => {
    server.once('error', reject);
    server.listen(0, host, () => resolvePromise());
  });

  const address = server.address();
  if (address === null || typeof address === 'string') {
    await new Promise<void>(resolveClose => server.close(() => resolveClose()));
    throw new GitHubAppError('ACTION_INPUT_INVALID', 'native pull request publisher server failed to bind TCP port');
  }

  const url = `http://${host}:${address.port}/publish`;

  return {
    url,
    signingSecret,
    authToken,
    endpointPlan: {
      id: 'default',
      url,
      signingCredentialRef: 'taskpack-publication-signing',
      authCredentialRef: 'taskpack-publication-auth',
      timeoutMs: 60_000,
    },
    close: async () => {
      server.closeIdleConnections?.();
      await new Promise<void>(resolveClose => server.close(() => resolveClose()));
      if (ownedScratch) {
        await rm(scratchBase, { recursive: true, force: true }).catch(() => undefined);
      }
    },
  };
}
