import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { constants as fsConstants, existsSync } from 'node:fs';
import { chmod, lstat, mkdir, mkdtemp, open, readFile, realpath, rm } from 'node:fs/promises';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import type { Readable, Writable } from 'node:stream';
import { openPiHostSessionAdapterV2, type HostSessionProgressEvent } from '@loopwright/agent-pi/host-session';
import type { HostMcpRegistry } from '@loopwright/agent-pi/mcp';
import {
  formatDurationMs,
  formatTokenCount,
  inspectRun,
  loadTrustedConfiguration,
  runCycleWithPorts,
  signPayload,
  verifySignedPayload,
  type ControllerPorts,
  type ReportCheckItem,
} from '@loopwright/controller';
import {
  bindSubject,
  digestArtifact,
  isWritablePath,
  LIMITS,
  validateDocument,
  type ArtifactManifest,
  type BaseTreeAnchor,
  type TaskContract,
  type UsageSummary,
} from '@loopwright/core';
import { reopenLocalRun, type LocalRunIdentity, type PageCursor } from '@loopwright/state';
import { LOOPWRIGHT_ACTIVE_PROVIDER_TOKEN_ENV } from './models-config.js';
import { sanitizeReportText } from './output-format.js';
import { SecretScrubber } from './token-broker.js';
import {
  GitHubAppError,
  LOCAL_COMMAND_GATE_ENDPOINT_ID,
  PROTECTED_AUTOMATION_PATHS,
  type ActionDelegateOutcome,
  type CompiledLocalCommandGate,
  type HostGateEndpointPlan,
  type HostPublicationEndpointPlan,
  type WrittenCompiledTaskpack,
} from './types.js';
import {
  assertNoSymlinkSegments,
  buildCleanGitEnv,
  COMMIT_SHA_PATTERN,
  fetchBoundedText,
  isPlainRecord,
  resolveGitExecutable,
  type ManagedPullRequestInfo,
  validateGitRemoteSource,
} from './upstreams.js';

const MAX_REQUEST_BODY_BYTES = 262_144;
const MAX_GIT_LIST_BYTES = 16 * 1024 * 1024;
const MAX_SCRIPT_BYTES = 262_144;
const MAX_STDIO_BYTES = 1_048_576;
const MAX_REASON_CODEPOINTS = 256;
const SHA256_HEX_PATTERN = /^[0-9a-f]{64}$/;
const SAFE_BRANCH_PATTERN = /^[A-Za-z0-9._/-]{1,200}$/;
const CONTROLLER_ID_PATTERN = /^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/;
const BASH_CANDIDATES: readonly string[] = Object.freeze(['/bin/bash', '/usr/bin/bash', '/bin/sh']);

const FORBIDDEN_CHILD_ENV_NAMES: ReadonlySet<string> = new Set([
  'GH_TOKEN',
  'GITHUB_TOKEN',
  'BASH_ENV',
  'ENV',
  'NODE_OPTIONS',
  'PATH',
  'HOME',
  'TMPDIR',
  'LANG',
  'LC_ALL',
  'LLM_TOKEN',
  'ANTHROPIC_API_KEY',
  'OPENAI_API_KEY',
  'GEMINI_API_KEY',
  'GOOGLE_API_KEY',
  'XAI_API_KEY',
  'GROQ_API_KEY',
  'MISTRAL_API_KEY',
  'OPENROUTER_API_KEY',
]);

const FORBIDDEN_CHILD_ENV_PREFIXES: readonly string[] = Object.freeze([
  'LOOPWRIGHT_',
  'INPUT_',
  'GITHUB_APP_',
  'ACTIONS_',
  'RUNNER_',
  'LD_',
  'DYLD_',
  'GIT_',
]);

const RETRYABLE_PI_ERROR_CODES: ReadonlySet<string> = new Set([
  'PROVIDER_RESPONSE_INVALID',
  'RESPONSE_INCOMPLETE',
  'MODEL_UNAVAILABLE',
]);

const NON_RETRYABLE_PI_ERROR_CODES: ReadonlySet<string> = new Set([
  'RECOVERY_REQUIRED',
  'DEADLINE',
  'CANCELLED',
  'CONTAINMENT_MISMATCH',
  'CONTAINMENT_UNAVAILABLE',
  'AUTHORITY_REFUSED',
  'STATE_REFUSED',
  'CLEANUP_FAILED',
]);

type ControllerOpenAdapter = NonNullable<ControllerPorts['openAdapter']>;
type OpenAdapterHost = Parameters<ControllerOpenAdapter>[0];
type OpenAdapterInput = Parameters<ControllerOpenAdapter>[1];

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalJson((value as Record<string, unknown>)[key])}`).join(',')}}`;
}

function truncateCodePoints(text: string, maxCodePoints: number): string {
  const chars = Array.from(text);
  return chars.length <= maxCodePoints ? text : chars.slice(0, maxCodePoints).join('');
}

function isForbiddenChildEnvName(key: string): boolean {
  if (FORBIDDEN_CHILD_ENV_NAMES.has(key)) return true;
  for (const prefix of FORBIDDEN_CHILD_ENV_PREFIXES) {
    if (key.startsWith(prefix)) return true;
  }
  return false;
}

function resolveShellExecutable(): string {
  for (const candidate of BASH_CANDIDATES) {
    if (existsSync(candidate)) return candidate;
  }
  return '/bin/sh';
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
  const body = Buffer.from(canonicalJson(payload), 'utf8');
  const signature = signPayload(signingSecret, body);
  res.writeHead(statusCode, {
    'content-type': 'application/json',
    'content-length': String(body.byteLength),
    'x-loopwright-signature': signature,
  });
  res.end(body);
}

function writePlainJsonResponse(res: ServerResponse, statusCode: number, payload: unknown): void {
  const body = Buffer.from(JSON.stringify(payload), 'utf8');
  res.writeHead(statusCode, {
    'content-type': 'application/json',
    'content-length': String(body.byteLength),
  });
  res.end(body);
}

interface MaterializedCandidateFile {
  readonly name: string;
  readonly bytes: Buffer;
}

interface InspectedCandidateSnapshot {
  readonly lock: Record<string, unknown>;
  readonly contract: TaskContract;
  readonly protectedPaths: readonly string[];
  readonly baseRevision: string;
  readonly sourceRevision: string;
  readonly manifest: ArtifactManifest;
  readonly files: readonly MaterializedCandidateFile[];
}

function normalizeProtectedPrefix(protectedEntry: string): string {
  const withoutGlob = protectedEntry.endsWith('/**') ? protectedEntry.slice(0, -3) : protectedEntry;
  return withoutGlob.replace(/\/+$/, '');
}

function isProtectedCandidatePath(name: string, protectedPaths: readonly string[]): boolean {
  for (const protectedEntry of protectedPaths) {
    if (protectedEntry === '**') return true;
    const clean = normalizeProtectedPrefix(protectedEntry);
    if (clean.length === 0) continue;
    if (name === clean || name.startsWith(`${clean}/`)) {
      return true;
    }
  }
  return false;
}

function isAllowedCandidateWrite(name: string, snapshot: InspectedCandidateSnapshot): boolean {
  if (isProtectedCandidatePath(name, snapshot.protectedPaths)) {
    return false;
  }
  const writableCheck = isWritablePath(snapshot.contract, name);
  return writableCheck.ok && writableCheck.value === true;
}

function normalizeCandidateRelativePath(name: string): string {
  if (
    typeof name !== 'string'
    || name.length === 0
    || name.includes('\0')
    || name.includes('\\')
    || name.startsWith('/')
  ) {
    throw new GitHubAppError('ACTION_INPUT_INVALID', `invalid candidate relative file path "${name}"`);
  }
  const parts = name.split('/');
  for (const part of parts) {
    if (part.length === 0 || part === '.' || part === '..') {
      throw new GitHubAppError('ACTION_INPUT_INVALID', `invalid candidate path segment in "${name}"`);
    }
  }
  return name;
}

async function inspectAndVerifyCandidate(
  runRoot: string,
  runId: string,
  expectedCandidateDigest: string,
  scratchParent: string,
): Promise<InspectedCandidateSnapshot> {
  const realRunRoot = await realpath(runRoot);
  const rawHolder = await mkdtemp(join(scratchParent, 'inspect-'));
  await chmod(rawHolder, 0o700);
  const inspectHolder = await realpath(rawHolder);
  const tempInspectDir = join(inspectHolder, 'bundle');
  try {
    const inspected = await inspectRun({ runRoot: realRunRoot, runId, output: tempInspectDir });
    if (!inspected.ok) {
      throw new GitHubAppError('ACTION_INPUT_INVALID', `inspectRun failed: ${inspected.error.code}`);
    }
    const lockRaw = JSON.parse(await readFile(join(tempInspectDir, 'task.lock.json'), 'utf8')) as unknown;
    const candidateFilesRaw = JSON.parse(await readFile(join(tempInspectDir, 'candidate.files.json'), 'utf8')) as unknown;
    const validLock = validateDocument(lockRaw, 'TaskLock');
    if (!validLock.ok) {
      throw new GitHubAppError('ACTION_INPUT_INVALID', 'inspected task.lock.json failed TaskLock validation');
    }
    if (!isPlainRecord(candidateFilesRaw)) {
      throw new GitHubAppError('ACTION_INPUT_INVALID', 'inspected candidate.files.json is invalid');
    }
    const validManifest = validateDocument(candidateFilesRaw['manifest'], 'ArtifactManifest');
    if (!validManifest.ok) {
      throw new GitHubAppError('ACTION_INPUT_INVALID', 'inspected candidate manifest failed ArtifactManifest validation');
    }
    const bound = bindSubject(validLock.value, validManifest.value);
    if (!bound.ok || bound.value.candidateDigest.hex !== expectedCandidateDigest) {
      throw new GitHubAppError('ACTION_INPUT_INVALID', 'candidate digest binding mismatch against task lock');
    }
    const rawFiles = candidateFilesRaw['files'];
    if (!Array.isArray(rawFiles)) {
      throw new GitHubAppError('ACTION_INPUT_INVALID', 'inspected candidate.files.json missing files array');
    }
    const expectedEntries = new Map(
      validManifest.value.spec.entries.map(entry => [entry.name, entry] as const),
    );
    const seenFileNames = new Set<string>();
    const files: MaterializedCandidateFile[] = [];
    for (const entry of rawFiles) {
      if (!isPlainRecord(entry) || typeof entry['name'] !== 'string' || typeof entry['body'] !== 'string') {
        throw new GitHubAppError('ACTION_INPUT_INVALID', 'candidate file entry malformed');
      }
      const cleanName = normalizeCandidateRelativePath(entry['name']);
      if (seenFileNames.has(cleanName)) {
        throw new GitHubAppError('ACTION_INPUT_INVALID', `duplicate candidate file entry "${cleanName}"`);
      }
      seenFileNames.add(cleanName);
      const expectedEntry = expectedEntries.get(cleanName);
      if (expectedEntry === undefined) {
        throw new GitHubAppError('ACTION_INPUT_INVALID', `candidate file "${cleanName}" is missing from candidate manifest`);
      }
      const bytes = Buffer.from(entry['body'], 'base64');
      const actualDigest = createHash('sha256').update(bytes).digest('hex');
      if (bytes.byteLength !== expectedEntry.byteLength || actualDigest !== expectedEntry.digest.hex) {
        throw new GitHubAppError('ACTION_INPUT_INVALID', `candidate file "${cleanName}" sha256 digest mismatch against manifest`);
      }
      files.push({ name: cleanName, bytes });
    }
    if (seenFileNames.size !== expectedEntries.size) {
      throw new GitHubAppError('ACTION_INPUT_INVALID', 'inspected candidate.files.json missing manifest entries');
    }
    return {
      lock: lockRaw as Record<string, unknown>,
      contract: validLock.value.spec.contract,
      protectedPaths: validLock.value.spec.contract.spec.scope.protected,
      baseRevision: validLock.value.spec.contract.spec.target.baseRevision,
      sourceRevision: validLock.value.spec.contract.spec.target.sourceRevision,
      manifest: validManifest.value,
      files,
    };
  } finally {
    await rm(inspectHolder, { recursive: true, force: true }).catch(() => undefined);
  }
}

async function verifyAndCopyScriptToWorkDir(
  repositoryRoot: string,
  relativeScriptPath: string,
  expectedSha256: string,
  destPath: string,
): Promise<string> {
  if (!SHA256_HEX_PATTERN.test(expectedSha256)) {
    throw new GitHubAppError('ACTION_INPUT_INVALID', 'gate script sha256 metadata is invalid');
  }
  const cleanRel = normalizeCandidateRelativePath(relativeScriptPath);
  const fullPath = resolve(repositoryRoot, cleanRel);
  assertNoSymlinkSegments(repositoryRoot, fullPath);
  const handle = await open(fullPath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  let bytes: Buffer;
  try {
    const info = await handle.stat();
    if (!info.isFile()) {
      throw new GitHubAppError('ACTION_INPUT_INVALID', `gate script "${relativeScriptPath}" is not a regular file`);
    }
    if (info.size > MAX_SCRIPT_BYTES) {
      throw new GitHubAppError('ACTION_INPUT_INVALID', `gate script "${relativeScriptPath}" exceeds ${MAX_SCRIPT_BYTES} bytes`);
    }
    bytes = await handle.readFile();
    const digest = createHash('sha256').update(bytes).digest('hex');
    if (digest !== expectedSha256) {
      throw new GitHubAppError('ACTION_INPUT_INVALID', `gate script "${relativeScriptPath}" sha256 changed on disk`);
    }
  } finally {
    await handle.close();
  }

  const destHandle = await open(
    destPath,
    fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY | fsConstants.O_NOFOLLOW,
    0o700,
  );
  try {
    await destHandle.writeFile(bytes);
  } finally {
    await destHandle.close();
  }
  await chmod(destPath, 0o700);
  return destPath;
}

async function materializeCandidateFiles(
  targetDir: string,
  files: readonly MaterializedCandidateFile[],
): Promise<void> {
  for (const file of files) {
    const dest = resolve(targetDir, file.name);
    const parent = dirname(dest);
    assertNoSymlinkSegments(targetDir, parent);
    await mkdir(parent, { recursive: true, mode: 0o700 });
    assertNoSymlinkSegments(targetDir, parent);
    const handle = await open(
      dest,
      fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY | fsConstants.O_NOFOLLOW,
      0o600,
    );
    try {
      await handle.writeFile(file.bytes);
    } finally {
      await handle.close();
    }
  }
}

interface ExecGitOptions {
  readonly env: Record<string, string>;
  readonly input?: Buffer | string | undefined;
  readonly timeoutMs?: number | undefined;
  readonly maxStdoutBytes?: number | undefined;
}

async function execGit(
  repositoryRoot: string,
  args: readonly string[],
  options: ExecGitOptions,
): Promise<Buffer> {
  const gitBin = resolveGitExecutable();
  const timeoutMs = options.timeoutMs ?? 15_000;
  const maxStdoutBytes = options.maxStdoutBytes ?? MAX_GIT_LIST_BYTES;
  return await new Promise<Buffer>((resolvePromise, reject) => {
    const child = spawn(
      gitBin,
      ['-c', 'core.hooksPath=/dev/null', '-C', repositoryRoot, ...args],
      { env: options.env, stdio: ['pipe', 'pipe', 'pipe'] },
    );
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let settled = false;
    let timedOut = false;
    let stdoutOverflow = false;

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, timeoutMs);
    timer.unref?.();

    const fail = (err: Error): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(err);
    };

    child.stdin.on('error', () => undefined);
    child.stdout.on('data', (chunk: Buffer) => {
      stdoutBytes += chunk.byteLength;
      if (stdoutBytes > maxStdoutBytes) {
        stdoutOverflow = true;
        child.kill('SIGKILL');
        return;
      }
      stdoutChunks.push(chunk);
    });
    child.stderr.on('data', (chunk: Buffer) => {
      if (stderrBytes >= 262_144) return;
      const take = Math.min(chunk.byteLength, 262_144 - stderrBytes);
      stderrBytes += take;
      stderrChunks.push(chunk.subarray(0, take));
    });
    child.on('error', err => {
      fail(new GitHubAppError('ACTION_INPUT_INVALID', `git ${args[0] ?? 'command'} failed to spawn: ${err.message}`));
    });
    child.on('close', (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (stdoutOverflow) {
        reject(new GitHubAppError('ACTION_INPUT_INVALID', `git ${args[0] ?? 'command'} output exceeded ${maxStdoutBytes} bytes`));
        return;
      }
      if (timedOut) {
        reject(new GitHubAppError('ACTION_INPUT_INVALID', `git ${args[0] ?? 'command'} timed out after ${timeoutMs}ms`));
        return;
      }
      if (code !== 0 || signal !== null) {
        const stderrText = Buffer.concat(stderrChunks).toString('utf8').trim();
        const detail = stderrText.length > 0 ? `: ${stderrText}` : '';
        reject(new GitHubAppError('ACTION_INPUT_INVALID', `git ${args[0] ?? 'command'} exited with ${code ?? signal}${detail}`));
        return;
      }
      resolvePromise(Buffer.concat(stdoutChunks));
    });

    if (options.input !== undefined) {
      const payload = Buffer.isBuffer(options.input) ? options.input : Buffer.from(options.input, 'utf8');
      if (payload.byteLength > 0) {
        child.stdin.end(payload);
        return;
      }
    }
    child.stdin.end();
  });
}

async function writeAllStream(stream: Writable, data: Uint8Array): Promise<void> {
  const chunkSize = 65_536;
  for (let offset = 0; offset < data.byteLength; offset += chunkSize) {
    const slice = data.subarray(offset, Math.min(offset + chunkSize, data.byteLength));
    if (stream.destroyed || !stream.writable) break;
    if (!stream.write(slice)) {
      await new Promise<void>((resolvePromise, reject) => {
        const cleanup = () => {
          stream.off('drain', onDrain);
          stream.off('close', onClose);
          stream.off('error', onError);
        };
        const onDrain = () => { cleanup(); resolvePromise(); };
        const onClose = () => { cleanup(); resolvePromise(); };
        const onError = (err: Error) => { cleanup(); reject(err); };
        stream.once('drain', onDrain);
        stream.once('close', onClose);
        stream.once('error', onError);
      });
    }
  }
}

class BatchStreamReader {
  readonly #chunks: Buffer[] = [];
  #headOffset = 0;
  #queuedBytes = 0;
  #ended = false;
  #streamError: Error | null = null;
  #waiter: (() => void) | null = null;

  constructor(private readonly stdout: Readable) {
    stdout.on('data', (part: Buffer) => {
      if (part.byteLength > 0) {
        this.#chunks.push(part);
        this.#queuedBytes += part.byteLength;
        if (this.#queuedBytes >= 4_194_304) stdout.pause();
        this.#notify();
      }
    });
    stdout.on('end', () => {
      this.#ended = true;
      this.#notify();
    });
    stdout.on('error', err => {
      this.#streamError = err;
      this.#ended = true;
      this.#notify();
    });
  }

  #notify(): void {
    if (this.#waiter) {
      const w = this.#waiter;
      this.#waiter = null;
      w();
    }
  }

  async #waitMore(): Promise<boolean> {
    if (this.#streamError) throw this.#streamError;
    if (this.#ended) return false;
    await new Promise<void>(resolvePromise => {
      this.#waiter = resolvePromise;
    });
    if (this.#streamError) throw this.#streamError;
    return this.#chunks.length > 0 || !this.#ended;
  }

  #consumeHead(n: number): void {
    this.#headOffset += n;
    this.#queuedBytes -= n;
    if (this.#headOffset >= this.#chunks[0]!.byteLength) {
      this.#chunks.shift();
      this.#headOffset = 0;
    }
    if (this.#queuedBytes < 1_048_576 && !this.#ended) {
      this.stdout.resume();
    }
  }

  async readLine(maxBytes = 256): Promise<string> {
    const parts: Buffer[] = [];
    let total = 0;
    for (;;) {
      if (this.#chunks.length === 0) {
        if (!(await this.#waitMore())) {
          throw new GitHubAppError('ACTION_INPUT_INVALID', 'unexpected EOF reading git cat-file --batch header');
        }
        continue;
      }
      const head = this.#chunks[0]!;
      const nl = head.indexOf(10, this.#headOffset);
      if (nl !== -1) {
        const piece = head.subarray(this.#headOffset, nl);
        if (total + piece.byteLength > maxBytes) {
          throw new GitHubAppError('ACTION_INPUT_INVALID', 'git cat-file --batch header exceeded maximum length');
        }
        parts.push(piece);
        this.#consumeHead(nl - this.#headOffset + 1);
        return Buffer.concat(parts).toString('utf8');
      }
      const piece = head.subarray(this.#headOffset);
      total += piece.byteLength;
      if (total > maxBytes) {
        throw new GitHubAppError('ACTION_INPUT_INVALID', 'git cat-file --batch header exceeded maximum length');
      }
      parts.push(piece);
      this.#consumeHead(piece.byteLength);
    }
  }

  async streamBytes(length: number, sink: (slice: Buffer) => Promise<void>): Promise<void> {
    let remaining = length;
    while (remaining > 0) {
      if (this.#chunks.length === 0) {
        if (!(await this.#waitMore())) {
          throw new GitHubAppError('ACTION_INPUT_INVALID', 'unexpected EOF reading git cat-file --batch blob body');
        }
        continue;
      }
      const head = this.#chunks[0]!;
      const take = Math.min(remaining, head.byteLength - this.#headOffset);
      await sink(head.subarray(this.#headOffset, this.#headOffset + take));
      this.#consumeHead(take);
      remaining -= take;
    }
  }

  async readExactByte(expected: number): Promise<void> {
    while (this.#chunks.length === 0) {
      if (!(await this.#waitMore())) {
        throw new GitHubAppError('ACTION_INPUT_INVALID', 'unexpected EOF reading git cat-file --batch delimiter');
      }
    }
    if (this.#chunks[0]![this.#headOffset]! !== expected) {
      throw new GitHubAppError('ACTION_INPUT_INVALID', 'malformed delimiter in git cat-file --batch output');
    }
    this.#consumeHead(1);
  }

  async assertExhausted(): Promise<void> {
    while (!this.#ended) {
      await this.#waitMore();
    }
    if (this.#queuedBytes !== 0) {
      throw new GitHubAppError('ACTION_INPUT_INVALID', 'trailing bytes in git cat-file --batch output');
    }
  }
}

interface BaselineRegularEntry {
  readonly path: string;
  readonly mode: '100644' | '100755';
  readonly oid: string;
  readonly byteLength: number;
}

function validateBaselineGitPath(rawPath: string): string {
  const clean = normalizeCandidateRelativePath(rawPath);
  for (const segment of clean.split('/')) {
    if (segment.toLowerCase() === '.git' || Buffer.byteLength(segment, 'utf8') > 255) {
      throw new GitHubAppError('ACTION_INPUT_INVALID', `invalid baseline path segment in "${clean}"`);
    }
  }
  if (!digestArtifact(clean, new Uint8Array()).ok) {
    throw new GitHubAppError('ACTION_INPUT_INVALID', `invalid baseline artifact path "${clean}"`);
  }
  return clean;
}

export async function verifyBaseTreeAnchor(
  repositoryRoot: string,
  baseTree: BaseTreeAnchor,
  gitEnv: Record<string, string>,
  expectedCommitOid?: string,
): Promise<void> {
  const oidPattern = baseTree.objectFormat === 'sha1' ? /^[0-9a-f]{40}$/ : /^[0-9a-f]{64}$/;
  if (!oidPattern.test(baseTree.commitOid) || !oidPattern.test(baseTree.treeOid)) {
    throw new GitHubAppError(
      'ACTION_INPUT_INVALID',
      `baseTree OIDs do not match objectFormat "${baseTree.objectFormat}"`,
    );
  }
  if (expectedCommitOid !== undefined && baseTree.commitOid !== expectedCommitOid) {
    throw new GitHubAppError(
      'ACTION_INPUT_INVALID',
      `baseTree.commitOid "${baseTree.commitOid}" does not match sourceRevision "${expectedCommitOid}"`,
    );
  }
  const actualTreeOid = (
    await execGit(
      repositoryRoot,
      ['rev-parse', '--verify', '--end-of-options', `${baseTree.commitOid}^{tree}`],
      { env: gitEnv, timeoutMs: 15_000 },
    )
  ).toString('utf8').trim();
  if (actualTreeOid !== baseTree.treeOid) {
    throw new GitHubAppError(
      'ACTION_INPUT_INVALID',
      `baseTree.treeOid "${baseTree.treeOid}" does not match ${baseTree.commitOid}^{tree} ("${actualTreeOid}")`,
    );
  }
}

/**
 * List all regular baseline files (`100644`/`100755`) in `commitOid`, skipping
 * only protected `120000`/`160000` specials while rejecting unprotected specials
 * and unsafe `.git` / oversized path segments.
 */
export async function listBaselineRegularEntries(
  repositoryRoot: string,
  commitOid: string,
  protectedPaths: readonly string[] = PROTECTED_AUTOMATION_PATHS,
): Promise<readonly BaselineRegularEntry[]> {
  if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(commitOid)) {
    throw new GitHubAppError('ACTION_INPUT_INVALID', 'baseTree commitOid is invalid');
  }
  const stdout = await execGit(
    repositoryRoot,
    ['ls-tree', '-r', '-l', '-z', '--full-tree', commitOid],
    { env: buildCleanGitEnv(), maxStdoutBytes: MAX_GIT_LIST_BYTES, timeoutMs: 30_000 },
  );
  if (stdout.byteLength > 0 && stdout.at(-1) !== 0) {
    throw new GitHubAppError('ACTION_INPUT_INVALID', 'git ls-tree output exceeded boundary');
  }
  const text = stdout.byteLength > 0 ? new TextDecoder('utf-8', { fatal: true }).decode(stdout) : '';
  const rows = text.length > 0 ? text.split('\0').slice(0, -1) : [];
  const entries: BaselineRegularEntry[] = [];
  for (const row of rows) {
    const symlinkMatch = /^120000 blob ([0-9a-f]{40}|[0-9a-f]{64}) +[0-9-]+\t(.+)$/s.exec(row);
    const gitlinkMatch = /^160000 commit ([0-9a-f]{40}|[0-9a-f]{64}) +-\t(.+)$/s.exec(row);
    const special = symlinkMatch ?? gitlinkMatch;
    if (special !== null) {
      const specialPath = validateBaselineGitPath(special[2]!);
      if (!isProtectedCandidatePath(specialPath, protectedPaths)) {
        throw new GitHubAppError(
          'ACTION_INPUT_INVALID',
          `unsupported unprotected ${symlinkMatch !== null ? 'symlink' : 'gitlink'} "${specialPath}" in baseline tree`,
        );
      }
      continue;
    }
    const match = /^(100644|100755) blob ([0-9a-f]{40}|[0-9a-f]{64}) +([0-9]+)\t(.+)$/s.exec(row);
    if (match === null) {
      throw new GitHubAppError('ACTION_INPUT_INVALID', 'unsupported git ls-tree entry in baseline tree');
    }
    const mode = match[1] as '100644' | '100755';
    const oid = match[2]!;
    const byteLength = Number(match[3]!);
    if (!Number.isSafeInteger(byteLength) || byteLength < 0) {
      throw new GitHubAppError('ACTION_INPUT_INVALID', 'invalid baseline blob byteLength');
    }
    const path = validateBaselineGitPath(match[4]!);
    entries.push({ path, mode, oid, byteLength });
    if (entries.length > LIMITS.baselineEntries) {
      throw new GitHubAppError('ACTION_INPUT_INVALID', `baseline tree exceeds ${LIMITS.baselineEntries} regular files`);
    }
  }
  return entries;
}

async function materializeBaselineBatchForGate(
  repositoryRoot: string,
  objectFormat: 'sha1' | 'sha256',
  entries: readonly BaselineRegularEntry[],
  candidateDir: string,
  timeoutMs: number,
): Promise<void> {
  if (entries.length === 0) return;
  const gitBin = resolveGitExecutable();
  const child = spawn(
    gitBin,
    ['-c', 'core.hooksPath=/dev/null', '-C', repositoryRoot, 'cat-file', '--batch'],
    { env: buildCleanGitEnv(), stdio: ['pipe', 'pipe', 'pipe'] },
  );
  child.stdin.on('error', () => undefined);

  const stderrChunks: Buffer[] = [];
  let stderrBytes = 0;
  child.stderr.on('data', (chunk: Buffer) => {
    if (stderrBytes >= 8192) return;
    const take = Math.min(chunk.byteLength, 8192 - stderrBytes);
    stderrBytes += take;
    stderrChunks.push(chunk.subarray(0, take));
  });

  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    child.kill('SIGKILL');
  }, timeoutMs);
  timer.unref?.();

  const exited = new Promise<{ readonly code: number | null; readonly signal: NodeJS.Signals | null }>((resolvePromise, reject) => {
    child.once('error', err => reject(new GitHubAppError('ACTION_INPUT_INVALID', `git cat-file --batch failed: ${err.message}`)));
    child.once('close', (code, signal) => resolvePromise({ code, signal }));
  });

  const reader = new BatchStreamReader(child.stdout);

  const writeBatch = async (): Promise<void> => {
    let chunk = '';
    let count = 0;
    for (const entry of entries) {
      chunk += `${entry.oid}\n`;
      count += 1;
      if (count >= 256) {
        await writeAllStream(child.stdin, Buffer.from(chunk, 'utf8'));
        chunk = '';
        count = 0;
      }
    }
    if (chunk.length > 0) {
      await writeAllStream(child.stdin, Buffer.from(chunk, 'utf8'));
    }
    child.stdin.end();
  };

  const readBatch = async (): Promise<void> => {
    const checkedDirs = new Set<string>(['']);
    const oidPattern = objectFormat === 'sha1' ? /^[0-9a-f]{40}$/ : /^[0-9a-f]{64}$/;
    for (const entry of entries) {
      const header = await reader.readLine(256);
      const space1 = header.indexOf(' ');
      const space2 = space1 === -1 ? -1 : header.indexOf(' ', space1 + 1);
      if (space1 === -1 || space2 === -1 || header.indexOf(' ', space2 + 1) !== -1) {
        throw new GitHubAppError('ACTION_INPUT_INVALID', 'malformed git cat-file --batch header');
      }
      const oid = header.slice(0, space1);
      const kind = header.slice(space1 + 1, space2);
      const sizeStr = header.slice(space2 + 1);
      if (
        !oidPattern.test(entry.oid)
        || oid !== entry.oid
        || kind !== 'blob'
        || !/^(?:0|[1-9][0-9]*)$/.test(sizeStr)
        || Number(sizeStr) !== entry.byteLength
      ) {
        throw new GitHubAppError('ACTION_INPUT_INVALID', `baseline blob mismatch for "${entry.path}"`);
      }

      const blobHash = createHash(objectFormat).update(`blob ${entry.byteLength}\0`);
      const dest = resolve(candidateDir, entry.path);
      const slash = entry.path.lastIndexOf('/');
      if (slash !== -1) {
        const relDir = entry.path.slice(0, slash);
        if (!checkedDirs.has(relDir)) {
          const parent = dirname(dest);
          assertNoSymlinkSegments(candidateDir, parent);
          await mkdir(parent, { recursive: true, mode: 0o700 });
          assertNoSymlinkSegments(candidateDir, parent);
          let pos = relDir.indexOf('/');
          while (pos !== -1) {
            checkedDirs.add(relDir.slice(0, pos));
            pos = relDir.indexOf('/', pos + 1);
          }
          checkedDirs.add(relDir);
        }
      }

      const fileMode = entry.mode === '100755' ? 0o755 : 0o600;
      const handle = await open(
        dest,
        fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY | fsConstants.O_NOFOLLOW,
        fileMode,
      );
      try {
        await reader.streamBytes(entry.byteLength, async slice => {
          blobHash.update(slice);
          let offset = 0;
          while (offset < slice.byteLength) {
            const { bytesWritten } = await handle.write(slice, offset, slice.byteLength - offset);
            if (bytesWritten <= 0) {
              throw new GitHubAppError('ACTION_INPUT_INVALID', `short write materializing "${entry.path}"`);
            }
            offset += bytesWritten;
          }
        });
        if (blobHash.digest('hex') !== entry.oid) {
          throw new GitHubAppError('ACTION_INPUT_INVALID', `baseline blob digest mismatch for "${entry.path}"`);
        }
        await handle.chmod(fileMode);
      } finally {
        await handle.close();
      }
      await reader.readExactByte(10);
    }
    await reader.assertExhausted();
  };

  try {
    await Promise.all([
      writeBatch().catch(err => {
        child.kill('SIGKILL');
        throw err;
      }),
      readBatch().catch(err => {
        child.kill('SIGKILL');
        throw err;
      }),
    ]);
    const exit = await exited;
    if (timedOut) {
      throw new GitHubAppError('ACTION_INPUT_INVALID', `git cat-file --batch timed out after ${timeoutMs}ms`);
    }
    if (exit.code !== 0 || exit.signal !== null) {
      const stderrText = Buffer.concat(stderrChunks).toString('utf8').trim();
      const detail = stderrText.length > 0 ? `: ${stderrText}` : '';
      throw new GitHubAppError('ACTION_INPUT_INVALID', `git cat-file --batch exited with ${exit.code ?? exit.signal}${detail}`);
    }
  } finally {
    clearTimeout(timer);
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGKILL');
      await exited.catch(() => undefined);
    }
  }
}

async function materializeOverlayCandidateFiles(
  targetDir: string,
  files: readonly MaterializedCandidateFile[],
  baselineModes: ReadonlyMap<string, '100644' | '100755'>,
): Promise<void> {
  const checkedDirs = new Set<string>(['']);
  for (const file of files) {
    const dest = resolve(targetDir, file.name);
    const slash = file.name.lastIndexOf('/');
    if (slash !== -1) {
      const relDir = file.name.slice(0, slash);
      if (!checkedDirs.has(relDir)) {
        const parent = dirname(dest);
        assertNoSymlinkSegments(targetDir, parent);
        await mkdir(parent, { recursive: true, mode: 0o700 });
        assertNoSymlinkSegments(targetDir, parent);
        let pos = relDir.indexOf('/');
        while (pos !== -1) {
          checkedDirs.add(relDir.slice(0, pos));
          pos = relDir.indexOf('/', pos + 1);
        }
        checkedDirs.add(relDir);
      }
    }
    const mode = baselineModes.get(file.name) === '100755' ? 0o755 : 0o600;
    const handle = await open(
      dest,
      fsConstants.O_CREAT | fsConstants.O_TRUNC | fsConstants.O_WRONLY | fsConstants.O_NOFOLLOW,
      mode,
    );
    try {
      await handle.writeFile(file.bytes);
      await handle.chmod(mode);
    } finally {
      await handle.close();
    }
  }
}

async function assertDeletedPathsAbsent(
  candidateDir: string,
  deletedPaths: readonly string[],
): Promise<void> {
  for (const rawRelPath of deletedPaths) {
    const relPath = normalizeCandidateRelativePath(rawRelPath);
    const target = resolve(candidateDir, relPath);
    let exists = true;
    try {
      await lstat(target);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        exists = false;
      } else {
        throw error;
      }
    }
    if (exists) {
      throw new GitHubAppError('ACTION_INPUT_INVALID', `deleted candidate path "${relPath}" is still present`);
    }
  }
}

function buildSandboxedChildEnv(
  gate: CompiledLocalCommandGate,
  candidateDir: string,
  scratchHome: string,
  scratchTmp: string,
  runtimeEnv: NodeJS.ProcessEnv | undefined,
  readOnlyGitHubToken: string | undefined,
  forbiddenEnvNames?: ReadonlySet<string> | undefined,
): Record<string, string> {
  const childEnv: Record<string, string> = {
    PATH: '/usr/local/bin:/usr/bin:/bin',
    HOME: scratchHome,
    TMPDIR: scratchTmp,
    LANG: 'C.UTF-8',
    LC_ALL: 'C.UTF-8',
    LOOPWRIGHT_CANDIDATE_DIR: candidateDir,
    LOOPWRIGHT_CHECK_ID: gate.checkId,
  };

  for (const envName of gate.env) {
    if (isForbiddenChildEnvName(envName) || forbiddenEnvNames?.has(envName) === true) {
      throw new GitHubAppError('ACTION_INPUT_INVALID', `forbidden env variable "${envName}" in command.v1 gate`);
    }
    const value = runtimeEnv?.[envName];
    if (typeof value === 'string') {
      childEnv[envName] = value;
    }
  }

  if (gate.allowReadOnlyGitHubToken && typeof readOnlyGitHubToken === 'string' && readOnlyGitHubToken.length > 0) {
    childEnv['GITHUB_TOKEN'] = readOnlyGitHubToken;
  }
  return childEnv;
}

async function runCommandScript(
  scriptFullPath: string,
  cwd: string,
  env: Record<string, string>,
  timeoutMs: number,
): Promise<{ readonly exitCode: number | null; readonly timedOut: boolean; readonly output: string }> {
  const shell = resolveShellExecutable();
  return await new Promise((resolvePromise, reject) => {
    const child = spawn(shell, [scriptFullPath], {
      cwd,
      env,
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let totalBytes = 0;
    let outputOverflow = false;
    let timedOut = false;
    let settled = false;

    const killProcessGroup = (): void => {
      if (child.pid === undefined) return;
      try {
        process.kill(-child.pid, 'SIGKILL');
      } catch {
        // Group may already have exited.
      }
    };

    const timer = setTimeout(() => {
      timedOut = true;
      killProcessGroup();
    }, timeoutMs);
    timer.unref?.();

    const finish = (code: number | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const stderrText = Buffer.concat(stderrChunks).toString('utf8');
      const stdoutText = Buffer.concat(stdoutChunks).toString('utf8');
      const combined = stderrText.trim().length > 0 ? stderrText : stdoutText;
      resolvePromise({
        exitCode: code,
        timedOut,
        output: outputOverflow ? `${combined} [output truncated]` : combined,
      });
    };

    const appendChunk = (target: Buffer[], chunk: Buffer): void => {
      if (totalBytes >= MAX_STDIO_BYTES) {
        outputOverflow = true;
        return;
      }
      const remaining = MAX_STDIO_BYTES - totalBytes;
      const slice = chunk.byteLength > remaining ? chunk.subarray(0, remaining) : chunk;
      totalBytes += slice.byteLength;
      if (chunk.byteLength > remaining) outputOverflow = true;
      target.push(slice);
    };

    child.stdout.on('data', (chunk: Buffer) => appendChunk(stdoutChunks, chunk));
    child.stderr.on('data', (chunk: Buffer) => appendChunk(stderrChunks, chunk));
    child.on('error', err => {
      clearTimeout(timer);
      if (!settled) {
        settled = true;
        reject(new GitHubAppError('ACTION_INPUT_INVALID', `command.v1 script failed to spawn: ${err.message}`));
      }
    });
    child.on('close', code => finish(code));
  });
}

export interface LocalCommandGateServerOptions {
  readonly runRoot: string;
  readonly repositoryRoot: string;
  readonly gates: readonly CompiledLocalCommandGate[];
  readonly runtimeEnv?: NodeJS.ProcessEnv | undefined;
  readonly readOnlyGitHubToken?: string | undefined;
  readonly scrubber?: SecretScrubber | undefined;
  readonly host?: string | undefined;
  readonly signingSecret?: string | undefined;
  readonly scratchRoot?: string | undefined;
  readonly forbiddenEnvNames?: ReadonlySet<string> | undefined;
  readonly onLog?: ((line: string) => void) | undefined;
}

export interface LocalCommandGateServer {
  readonly url: string;
  readonly signingSecret: string;
  readonly endpointPlan: HostGateEndpointPlan;
  close(): Promise<void>;
}

/**
 * Start a loopback HTTP server implementing Loopwright's `gate.v1` protocol for
 * repository-declared `command.v1` checks against inspected candidate bytes.
 */
export async function startLocalCommandGateServer(
  options: LocalCommandGateServerOptions,
): Promise<LocalCommandGateServer> {
  const scrubber = options.scrubber ?? new SecretScrubber();
  const signingSecret = options.signingSecret ?? randomBytes(32).toString('hex');
  scrubber.register(signingSecret);
  if (options.readOnlyGitHubToken) scrubber.register(options.readOnlyGitHubToken);

  const ownedScratch = options.scratchRoot === undefined;
  const rawScratchBase = options.scratchRoot ?? await mkdtemp(join(tmpdir(), 'loopwright-gate-'));
  await chmod(rawScratchBase, 0o700);
  const scratchBase = await realpath(rawScratchBase);

  const host = options.host ?? '127.0.0.1';
  const gateMap = new Map<string, CompiledLocalCommandGate>();
  let maxTimeoutSeconds = 30;
  for (const gate of options.gates) {
    gateMap.set(`${gate.gateId}\0${gate.checkId}`, gate);
    if (gate.timeoutSeconds > maxTimeoutSeconds) maxTimeoutSeconds = gate.timeoutSeconds;
  }

  const server = createServer(async (req, res) => {
    const pathname = (req.url ?? '/').split('?')[0];
    if (req.method !== 'POST' || pathname !== `/${LOCAL_COMMAND_GATE_ENDPOINT_ID}`) {
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
    const gateId = String(request['gateId'] ?? '');
    const checkId = String(request['checkId'] ?? '');
    const candidateDigest = String(request['candidateDigest'] ?? '');

    const makeVerdict = (status: 'approved' | 'denied', reason: string | null) => ({
      version: 1,
      kind: 'gate_verdict',
      storeId,
      runId,
      lockHash,
      operationId,
      dispatchId,
      dispatchGeneration,
      gateId,
      checkId,
      candidateDigest,
      status,
      reason,
      expiresAtMs: String(Date.now() + 300_000),
    });

    const sanitizeFailureReason = (raw: string): string => {
      const cleaned = sanitizeReportText(raw, {
        scrub: text => scrubber.scrub(text),
        singleLine: true,
      });
      const fallback = cleaned.length > 0 ? cleaned : 'command check failed';
      return truncateCodePoints(fallback, MAX_REASON_CODEPOINTS);
    };

    const gate = gateMap.get(`${gateId}\0${checkId}`);
    if (gate === undefined) {
      writeSignedJsonResponse(res, 200, signingSecret, makeVerdict('denied', sanitizeFailureReason(`unknown command gate ${gateId}/${checkId}`)));
      return;
    }

    const workDir = await mkdtemp(join(scratchBase, 'exec-'));
    await chmod(workDir, 0o700);
    const candidateDir = join(workDir, 'candidate');
    const scratchHome = join(workDir, 'home');
    const scratchTmp = join(workDir, 'tmp');

    try {
      await mkdir(candidateDir, { mode: 0o700 });
      await mkdir(scratchHome, { mode: 0o700 });
      await mkdir(scratchTmp, { mode: 0o700 });

      const scriptCopyPath = await verifyAndCopyScriptToWorkDir(
        options.repositoryRoot,
        gate.script,
        gate.scriptSha256,
        join(workDir, 'gate-script.sh'),
      );
      const snapshot = await inspectAndVerifyCandidate(options.runRoot, runId, candidateDigest, workDir);
      if (snapshot.manifest.spec.baseTree !== undefined) {
        await verifyBaseTreeAnchor(
          options.repositoryRoot,
          snapshot.manifest.spec.baseTree,
          buildCleanGitEnv(),
          snapshot.sourceRevision,
        );
        const baselineEntries = await listBaselineRegularEntries(
          options.repositoryRoot,
          snapshot.manifest.spec.baseTree.commitOid,
          snapshot.protectedPaths,
        );
        const baselineModes = new Map<string, '100644' | '100755'>();
        for (const entry of baselineEntries) {
          baselineModes.set(entry.path, entry.mode);
        }
        const deletedPaths = snapshot.manifest.spec.deleted ?? [];
        const deletedSet = new Set(deletedPaths);
        const overlayNames = new Set(snapshot.files.map(file => file.name));
        const toMaterialize = baselineEntries.filter(
          entry => !deletedSet.has(entry.path) && !overlayNames.has(entry.path),
        );
        await materializeBaselineBatchForGate(
          options.repositoryRoot,
          snapshot.manifest.spec.baseTree.objectFormat,
          toMaterialize,
          candidateDir,
          Math.max(60_000, gate.timeoutSeconds * 1000),
        );
        await materializeOverlayCandidateFiles(candidateDir, snapshot.files, baselineModes);
        await assertDeletedPathsAbsent(candidateDir, deletedPaths);
      } else {
        await materializeCandidateFiles(candidateDir, snapshot.files);
      }

      const childEnv = buildSandboxedChildEnv(
        gate,
        candidateDir,
        scratchHome,
        scratchTmp,
        options.runtimeEnv,
        options.readOnlyGitHubToken,
        options.forbiddenEnvNames,
      );

      options.onLog?.(scrubber.scrub(
        `check ${gate.checkId}: running ${gate.script} (timeout ${formatDurationMs(gate.timeoutSeconds * 1000)})`,
      ));
      const cmdStarted = performance.now();
      const result = await runCommandScript(scriptCopyPath, candidateDir, childEnv, gate.timeoutSeconds * 1000);
      const cmdElapsed = Math.max(1, Math.round(performance.now() - cmdStarted));
      if (!result.timedOut && result.exitCode === 0) {
        options.onLog?.(scrubber.scrub(`check ${gate.checkId}: passed (${formatDurationMs(cmdElapsed)})`));
        writeSignedJsonResponse(res, 200, signingSecret, makeVerdict('approved', null));
      } else {
        const prefix = result.timedOut
          ? `command timed out after ${gate.timeoutSeconds}s`
          : `command exited with status ${result.exitCode ?? 'signal'}`;
        const rawReason = result.output.length > 0 ? `${prefix}: ${result.output}` : prefix;
        const sanitizedReason = sanitizeFailureReason(rawReason);
        options.onLog?.(scrubber.scrub(`check ${gate.checkId}: failed (${formatDurationMs(cmdElapsed)}) — ${sanitizedReason}`));
        writeSignedJsonResponse(res, 200, signingSecret, makeVerdict('denied', sanitizedReason));
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      writeSignedJsonResponse(res, 200, signingSecret, makeVerdict('denied', sanitizeFailureReason(message)));
    } finally {
      await rm(workDir, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  await new Promise<void>((resolvePromise, reject) => {
    server.once('error', reject);
    server.listen(0, host, () => resolvePromise());
  });

  const address = server.address();
  if (address === null || typeof address === 'string') {
    await new Promise<void>(resolveClose => server.close(() => resolveClose()));
    throw new GitHubAppError('ACTION_INPUT_INVALID', 'local command gate server failed to bind TCP port');
  }

  const url = `http://${host}:${address.port}/${LOCAL_COMMAND_GATE_ENDPOINT_ID}`;
  const timeoutMs = Math.min(3_600_000, Math.max(35_000, maxTimeoutSeconds * 1000 + 15_000));
  const maxPollMs = Math.min(3_600_000, Math.max(50_000, timeoutMs + 15_000));

  return {
    url,
    signingSecret,
    endpointPlan: {
      id: LOCAL_COMMAND_GATE_ENDPOINT_ID,
      url,
      signingCredentialRef: 'taskpack-local-command-signing',
      authCredentialRef: null,
      timeoutMs,
      maxPollMs,
      pollInitialMs: 100,
      pollMaxMs: 500,
      jitter: 0,
    },
    close: async () => {
      await new Promise<void>(resolveClose => server.close(() => resolveClose()));
      if (ownedScratch) {
        await rm(scratchBase, { recursive: true, force: true }).catch(() => undefined);
      }
    },
  };
}

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

interface GitTreeEntry {
  readonly mode: string;
  readonly type: string;
  readonly oid: string;
}

async function listTreeEntriesAtRevision(
  repositoryRoot: string,
  revision: string,
  env: Record<string, string>,
): Promise<ReadonlyMap<string, GitTreeEntry>> {
  const stdout = await execGit(
    repositoryRoot,
    ['ls-tree', '-r', '-z', '--full-tree', revision],
    { env, maxStdoutBytes: MAX_GIT_LIST_BYTES, timeoutMs: 30_000 },
  );
  if (stdout.byteLength > 0 && stdout.at(-1) !== 0) {
    throw new GitHubAppError('ACTION_INPUT_INVALID', 'git ls-tree output exceeded boundary');
  }
  const entries = new Map<string, GitTreeEntry>();
  const parts = (stdout.byteLength > 0 ? new TextDecoder('utf-8', { fatal: true }).decode(stdout) : '').split('\0');
  for (const part of parts) {
    if (part.length === 0) continue;
    const tabIdx = part.indexOf('\t');
    if (tabIdx <= 0) continue;
    const meta = part.slice(0, tabIdx);
    const path = part.slice(tabIdx + 1);
    const fields = meta.split(' ');
    const mode = fields[0];
    const type = fields[1];
    const oid = fields[2];
    if (mode !== undefined && type !== undefined && oid !== undefined) {
      entries.set(path, { mode, type, oid });
    }
  }
  return entries;
}

function isSpecialGitTreeEntry(entry: GitTreeEntry | undefined): boolean {
  return entry?.mode === '120000' || entry?.mode === '160000';
}

function hasSymlinkAtOrAbove(
  path: string,
  baseEntries: ReadonlyMap<string, GitTreeEntry>,
  sourceEntries: ReadonlyMap<string, GitTreeEntry>,
): boolean {
  if (isSpecialGitTreeEntry(baseEntries.get(path)) || isSpecialGitTreeEntry(sourceEntries.get(path))) {
    return true;
  }
  let slash = path.indexOf('/');
  while (slash !== -1) {
    const prefix = path.slice(0, slash);
    if (isSpecialGitTreeEntry(baseEntries.get(prefix)) || isSpecialGitTreeEntry(sourceEntries.get(prefix))) {
      return true;
    }
    slash = path.indexOf('/', slash + 1);
  }
  return false;
}

async function stageEntriesInIndex(
  repositoryRoot: string,
  indexFile: string,
  entries: readonly { readonly path: string; readonly mode: '100644' | '100755'; readonly oid: string }[],
  gitEnv: Record<string, string>,
): Promise<void> {
  if (entries.length === 0) return;
  const payload = entries.map(entry => `${entry.mode} blob ${entry.oid}\t${entry.path}\0`).join('');
  await execGit(
    repositoryRoot,
    ['update-index', '-z', '--index-info'],
    { env: { ...gitEnv, GIT_INDEX_FILE: indexFile }, input: payload, timeoutMs: 30_000 },
  );
}

async function removePathsFromIndex(
  repositoryRoot: string,
  indexFile: string,
  paths: readonly string[],
  gitEnv: Record<string, string>,
): Promise<void> {
  if (paths.length === 0) return;
  const payload = paths.map(path => `${path}\0`).join('');
  await execGit(
    repositoryRoot,
    ['update-index', '--force-remove', '-z', '--stdin'],
    { env: { ...gitEnv, GIT_INDEX_FILE: indexFile }, input: payload, timeoutMs: 30_000 },
  );
}

function buildGitAuthEnv(gitWriteToken: string | undefined): Record<string, string> {
  if (gitWriteToken && gitWriteToken.length > 0) {
    const encoded = Buffer.from(`x-access-token:${gitWriteToken}`, 'utf8').toString('base64');
    return buildCleanGitEnv({
      GIT_CONFIG_COUNT: '1',
      GIT_CONFIG_KEY_0: 'http.extraheader',
      GIT_CONFIG_VALUE_0: `AUTHORIZATION: basic ${encoded}`,
    });
  }
  return buildCleanGitEnv();
}

const MAX_PROPOSAL_JSON_BYTES = 2 * 1024 * 1024;
const MAX_PR_BODY_CODEPOINTS = 32_000;
const MAX_PR_TABLE_CELL_CODEPOINTS = 500;

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

function escapeMarkdownTableCell(value: unknown): string {
  if (value === null || value === undefined) return '-';
  const raw = typeof value === 'string'
    ? value
    : typeof value === 'number' || typeof value === 'boolean'
      ? String(value)
      : '';
  const cleaned = stripDisallowedControls(raw, false)
    .replace(/\s+/g, ' ')
    .trim();
  if (cleaned.length === 0) return '-';
  const bounded = truncateCodePoints(cleaned, MAX_PR_TABLE_CELL_CODEPOINTS);
  return bounded.replace(/\\/g, '\\\\').replace(/\|/g, '\\|');
}

function sanitizeProposalLeadText(raw: string): string {
  return stripDisallowedControls(raw.replace(/\r\n?/g, '\n'), true).trim();
}

export function buildNativePullRequestBody(options: {
  readonly runId: string;
  readonly candidateDigest: string;
  readonly proposalPath?: string | undefined;
  readonly files: readonly { readonly name: string; readonly bytes: Uint8Array }[];
  readonly stagedPaths?: ReadonlySet<string> | undefined;
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

  const sections: string[] = [];
  if (typeof parsed['summary'] === 'string') {
    const cleanSummary = sanitizeProposalLeadText(parsed['summary']);
    if (cleanSummary.length > 0) {
      sections.push(cleanSummary);
    }
  }

  const rawSubscriptions = parsed['subscriptions'];
  const subRows: Array<{ readonly name: string; readonly entry: Record<string, unknown> }> = [];
  if (isPlainRecord(rawSubscriptions)) {
    for (const [key, entry] of Object.entries(rawSubscriptions)) {
      if (key.trim().length > 0 && isPlainRecord(entry)) {
        subRows.push({ name: key.trim(), entry });
      }
    }
  } else if (Array.isArray(rawSubscriptions)) {
    for (const item of rawSubscriptions) {
      if (!isPlainRecord(item)) continue;
      const rawName = typeof item['subscription'] === 'string' && item['subscription'].trim().length > 0
        ? item['subscription'].trim()
        : typeof item['id'] === 'string' && item['id'].trim().length > 0
          ? item['id'].trim()
          : typeof item['name'] === 'string' && item['name'].trim().length > 0
            ? item['name'].trim()
            : null;
      if (rawName !== null) {
        subRows.push({ name: rawName, entry: item });
      }
    }
  }

  if (subRows.length > 0) {
    const tableLines: string[] = [
      '| Subscription | Status | Engine | Plugin | Reason |',
      '| --- | --- | --- | --- | --- |',
    ];
    for (const { name, entry } of subRows) {
      const subCell = escapeMarkdownTableCell(name);
      const statusCell = escapeMarkdownTableCell(entry['status']);
      const engineCell = escapeMarkdownTableCell(
        entry['engine_version'] ?? entry['engineVersion'] ?? entry['engine'],
      );
      const pluginCell = escapeMarkdownTableCell(
        entry['plugin_version'] ?? entry['pluginVersion'] ?? entry['plugin'],
      );
      const reasonCell = escapeMarkdownTableCell(entry['reason']);
      tableLines.push(`| ${subCell} | ${statusCell} | ${engineCell} | ${pluginCell} | ${reasonCell} |`);
    }
    sections.push(tableLines.join('\n'));
  }

  if (sections.length === 0) {
    return provenanceFooter;
  }

  const scrubbedLead = options.scrubber.scrub(sections.join('\n\n')).trim();
  if (scrubbedLead.length === 0) {
    return provenanceFooter;
  }
  const footerCodePoints = Array.from(provenanceFooter).length;
  const maxLeadCodePoints = Math.max(1, MAX_PR_BODY_CODEPOINTS - footerCodePoints - 2);
  const boundedLead = truncateCodePoints(scrubbedLead, maxLeadCodePoints);
  return `${boundedLead}\n\n${provenanceFooter}`;
}

/**
 * Start a loopback HTTP server implementing Loopwright's signed publication protocol
 * using pure Git index/tree plumbing over a private temporary `GIT_INDEX_FILE`
 * (preserving repository `HEAD`, working tree, `.git/worktrees`, and protected
 * paths/symlinks) and `--force-with-lease` push protection.
 */
export async function startNativePullRequestPublisherServer(
  options: NativePullRequestPublisherOptions,
): Promise<NativePullRequestPublisherServer> {
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
    const rawTitle = typeof request['title'] === 'string' ? request['title'].trim() : '';
    const expandedTemplate = options.titleTemplate?.trim()
      ? options.titleTemplate.trim()
          .replace(/\$\{repository\}/g, options.repositoryFullName)
          .replace(/\$\{runId\}/g, runId)
          .replace(/\$\{candidateDigest\}/g, candidateDigest.slice(0, 12))
      : '';
    const title = rawTitle.length > 0
      ? rawTitle
      : expandedTemplate.length > 0
        ? expandedTemplate
        : `Loopwright update (${runId})`;
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
      const snapshot = await inspectAndVerifyCandidate(options.runRoot, runId, candidateDigest, workRoot);
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

      if (sourceRevision !== baseRevision) {
        const carryRemovals: string[] = [];
        for (const [path, baseEntry] of baseEntries.entries()) {
          if (baseEntry.mode !== '100644' && baseEntry.mode !== '100755') continue;
          const sourceEntry = sourceEntries.get(path);
          if (sourceEntry !== undefined && (sourceEntry.mode === '100644' || sourceEntry.mode === '100755')) {
            continue;
          }
          if (!isAllowedCandidateWrite(path, snapshot)) continue;
          if (hasSymlinkAtOrAbove(path, baseEntries, sourceEntries)) continue;
          carryRemovals.push(path);
        }
        if (carryRemovals.length > 0) {
          await removePathsFromIndex(options.repositoryRoot, indexFile, carryRemovals, gitEnv);
        }

        const carryUpdates: Array<{ readonly path: string; readonly mode: '100644' | '100755'; readonly oid: string }> = [];
        for (const [path, sourceEntry] of sourceEntries.entries()) {
          if (sourceEntry.mode !== '100644' && sourceEntry.mode !== '100755') continue;
          const baseEntry = baseEntries.get(path);
          if (baseEntry !== undefined && baseEntry.mode === sourceEntry.mode && baseEntry.oid === sourceEntry.oid) {
            continue;
          }
          if (!isAllowedCandidateWrite(path, snapshot)) continue;
          if (hasSymlinkAtOrAbove(path, baseEntries, sourceEntries)) continue;
          carryUpdates.push({ path, mode: sourceEntry.mode, oid: sourceEntry.oid });
        }
        if (carryUpdates.length > 0) {
          await stageEntriesInIndex(options.repositoryRoot, indexFile, carryUpdates, gitEnv);
        }
      }

      const candidateNames = new Set<string>();
      const stagedFiles: Array<{ readonly path: string; readonly mode: '100644' | '100755'; readonly oid: string }> = [];

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
        const blobOid = (
          await gitRepo(['hash-object', '-w', '--stdin'], { input: Buffer.from(file.bytes) })
        ).toString('utf8').trim();
        if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(blobOid)) {
          throw new GitHubAppError('ACTION_INPUT_INVALID', `git hash-object returned invalid oid for "${file.name}"`);
        }
        const mode: '100644' | '100755' =
          (sourceEntries.get(file.name)?.mode ?? baseEntries.get(file.name)?.mode) === '100755'
            ? '100755'
            : '100644';
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
      let headOid = baseRevision;
      if (treeOid !== baseTreeOid) {
        const commitMessage = `${title}\n\nSigned-off-by: Loopwright Bot <loopwright[bot]@users.noreply.github.com>\n`;
        headOid = (
          await gitRepo(
            [
              '-c', 'user.name=Loopwright Bot',
              '-c', 'user.email=loopwright[bot]@users.noreply.github.com',
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
        const stagedPathSet = new Set(stagedFiles.map(entry => entry.path));
        const prBody = buildNativePullRequestBody({
          runId,
          candidateDigest,
          proposalPath: options.proposalPath,
          files: snapshot.files,
          stagedPaths: stagedPathSet,
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
                ? { title, body: prBody }
                : { title, head: branchName, base: targetBranch, body: prBody },
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
      await new Promise<void>(resolveClose => server.close(() => resolveClose()));
      if (ownedScratch) {
        await rm(scratchBase, { recursive: true, force: true }).catch(() => undefined);
      }
    },
  };
}

export interface TurnkeyCycleAttemptSummary {
  readonly attemptSeq: number;
  readonly attemptRunId: string;
  readonly ok: boolean;
  readonly status: string;
  readonly reasonCode: string | null;
  readonly detail: string;
  readonly externalUrl: string | null;
  readonly usage: UsageSummary | null;
  readonly checks: readonly ReportCheckItem[];
  readonly elapsedMs: number;
  readonly retryableProviderFailure: boolean;
}

export interface TurnkeyCycleDelegateOptions {
  readonly runId: string;
  readonly repositoryRoot: string;
  readonly runtimeEnv?: NodeJS.ProcessEnv | undefined;
  readonly ephemeralEnv?: Readonly<Record<string, string>> | undefined;
  readonly scrubber?: SecretScrubber | undefined;
  readonly mcpRegistry?: HostMcpRegistry | undefined;
  readonly onLog?: ((line: string) => void) | undefined;
  readonly onAttemptSettled?: ((summary: TurnkeyCycleAttemptSummary) => void) | undefined;
  readonly signal?: AbortSignal | undefined;
}

export interface ExecuteTurnkeyActionCycleOptions extends TurnkeyCycleDelegateOptions {
  readonly taskpack: WrittenCompiledTaskpack;
  readonly attemptSeq: number;
}

export function normalizeControllerRunId(rawRunId: string): string {
  if (CONTROLLER_ID_PATTERN.test(rawRunId) && rawRunId.length <= 64) {
    return rawRunId;
  }
  const lower = rawRunId.toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^[._-]+|[._-]+$/g, '');
  const prefixed = /^[a-z]/.test(lower) ? lower : `run-${lower.length > 0 ? lower : 'local'}`;
  const collapsed = prefixed.replace(/[._-]{2,}/g, '-').slice(0, 64).replace(/[._-]+$/g, '');
  return CONTROLLER_ID_PATTERN.test(collapsed) ? collapsed : 'run-local';
}

export function makeAttemptRunId(baseRunId: string, attemptSeq: number): string {
  const normalized = normalizeControllerRunId(baseRunId);
  if (attemptSeq === 0) return normalized;
  const suffix = `-a${attemptSeq}`;
  const prefix = normalized
    .slice(0, Math.max(1, 64 - suffix.length))
    .replace(/[._-]+$/g, '');
  return `${prefix.length > 0 ? prefix : 'run'}${suffix}`;
}

async function withTemporaryProcessEnv<T>(
  overrides: Readonly<Record<string, string | undefined>>,
  fn: () => Promise<T>,
): Promise<T> {
  const previous = new Map<string, string | undefined>();
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) continue;
    previous.set(key, process.env[key]);
    process.env[key] = value;
  }
  try {
    return await fn();
  } finally {
    for (const [key, prior] of previous.entries()) {
      if (prior === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = prior;
      }
    }
  }
}

function formatPiErrorDetail(
  error: { readonly code: string; readonly phase: string; readonly path?: string | undefined },
  prefix = '',
): string {
  const pathSuffix = typeof error.path === 'string' && error.path.length > 0 ? ` ${error.path}` : '';
  return `${prefix}${error.code} (${error.phase}${pathSuffix})`;
}

function isRetryablePiFailure(error: {
  readonly code?: string | null | undefined;
  readonly phase?: string | null | undefined;
  readonly retryable?: boolean | undefined;
  readonly stateErrorCode?: string | null | undefined;
}): boolean {
  const code = error.code;
  if (code !== null && code !== undefined && NON_RETRYABLE_PI_ERROR_CODES.has(code)) {
    return false;
  }
  if (code === 'REQUEST_REFUSED') {
    return error.phase === 'dispatch' && error.stateErrorCode == null;
  }
  if (code !== null && code !== undefined && RETRYABLE_PI_ERROR_CODES.has(code)) {
    return true;
  }
  return error.retryable === true;
}

function validateRunIdentity(raw: unknown): LocalRunIdentity | null {
  if (!isPlainRecord(raw)) return null;
  const directory = raw['directory'];
  const storeId = raw['storeId'];
  const policyRaw = raw['policy'];
  const bindingRaw = raw['binding'];
  if (typeof directory !== 'string' || directory.length === 0 || typeof storeId !== 'string' || storeId.length === 0) {
    return null;
  }
  const lockResult = validateDocument(raw['lock'], 'TaskLock');
  if (!lockResult.ok) return null;
  if (!isPlainRecord(policyRaw)) return null;
  const leaseMs = policyRaw['leaseMs'];
  if (policyRaw['version'] !== 1 || typeof leaseMs !== 'number' || !Number.isSafeInteger(leaseMs) || policyRaw['cost'] !== 'observe_only') {
    return null;
  }
  if (!isPlainRecord(bindingRaw)) return null;
  if (
    bindingRaw['coreApiVersion'] !== 'loopwright.dev/v1alpha1'
    || typeof bindingRaw['hostVersion'] !== 'string'
    || typeof bindingRaw['resourceVersion'] !== 'string'
    || typeof bindingRaw['clockEpoch'] !== 'string'
    || !Array.isArray(bindingRaw['adapters'])
  ) {
    return null;
  }
  const adapters: { readonly id: string; readonly version: string }[] = [];
  for (const entry of bindingRaw['adapters']) {
    if (!isPlainRecord(entry) || typeof entry['id'] !== 'string' || typeof entry['version'] !== 'string') {
      return null;
    }
    adapters.push({ id: entry['id'], version: entry['version'] });
  }
  return {
    directory,
    storeId,
    lock: lockResult.value,
    policy: {
      version: 1,
      leaseMs,
      cost: 'observe_only',
    },
    binding: {
      coreApiVersion: 'loopwright.dev/v1alpha1',
      hostVersion: bindingRaw['hostVersion'],
      adapters,
      resourceVersion: bindingRaw['resourceVersion'],
      clockEpoch: bindingRaw['clockEpoch'],
    },
  };
}

async function inspectRunChecksAndExternalWrites(
  runRoot: string,
  runId: string,
  tempOutputDir: string,
): Promise<{
  readonly externalWriteDispatched: boolean;
  readonly checks: readonly ReportCheckItem[];
}> {
  let externalWriteDispatched = true;
  const checks: ReportCheckItem[] = [];

  try {
    const verificationRaw = await readFile(join(tempOutputDir, 'verification.json'), 'utf8');
    const parsed = JSON.parse(verificationRaw) as unknown;
    if (isPlainRecord(parsed)) {
      const spec = isPlainRecord(parsed['spec']) ? parsed['spec'] : parsed;
      const items = Array.isArray(spec['checks']) ? spec['checks'] : Array.isArray(parsed['checks']) ? parsed['checks'] : [];
      for (const entry of items) {
        if (!isPlainRecord(entry)) continue;
        const checkId = typeof entry['checkId'] === 'string'
          ? entry['checkId']
          : typeof entry['id'] === 'string'
            ? entry['id']
            : undefined;
        const status = typeof entry['status'] === 'string' ? entry['status'] : undefined;
        if (checkId !== undefined && status !== undefined) {
          checks.push({
            checkId,
            status,
            code: typeof entry['code'] === 'string' ? entry['code'] : null,
            detail: typeof entry['reason'] === 'string'
              ? entry['reason']
              : typeof entry['detail'] === 'string'
                ? entry['detail']
                : null,
          });
        }
      }
    }
  } catch {
    // verification.json is optional when role failed early.
  }

  if (!existsSync(join(tempOutputDir, 'publication.json'))) {
    try {
      const runJsonRaw = JSON.parse(await readFile(join(runRoot, runId, 'run.json'), 'utf8')) as unknown;
      const runIdentity = isPlainRecord(runJsonRaw) ? validateRunIdentity(runJsonRaw['identity']) : null;
      if (runIdentity !== null) {
        const reopened = reopenLocalRun(runIdentity);
        if (reopened.ok) {
          try {
            let cursor: PageCursor | null = null;
            let allPagesRead = true;
            let sawExternalWrite = false;
            for (let pageCount = 0; pageCount < 1000; pageCount += 1) {
              const ops = reopened.value.listOperations({ limit: 100, cursor });
              if (!ops.ok) {
                allPagesRead = false;
                break;
              }
              for (const op of ops.value.items) {
                if (op.intent.effect === 'external_write' && op.dispatch !== null) {
                  sawExternalWrite = true;
                  break;
                }
              }
              if (sawExternalWrite) break;
              cursor = ops.value.next;
              if (cursor === null) break;
              if (pageCount === 999) {
                allPagesRead = false;
              }
            }
            if (allPagesRead && !sawExternalWrite) {
              externalWriteDispatched = false;
            }
          } finally {
            reopened.value.close();
          }
        }
      }
    } catch {
      // Fail closed with externalWriteDispatched = true.
    }
  }

  return { externalWriteDispatched, checks };
}

/**
 * Execute one Controller cycle attempt against a compiled and written Taskpack
 * using `openPiHostSessionAdapterV2` and `runCycleWithPorts`.
 */
export async function executeTurnkeyActionCycle(
  options: ExecuteTurnkeyActionCycleOptions,
): Promise<TurnkeyCycleAttemptSummary & { readonly outcome: ActionDelegateOutcome }> {
  const startedMs = performance.now();
  const scrubber = options.scrubber ?? new SecretScrubber();
  const attemptRunId = makeAttemptRunId(options.runId, options.attemptSeq);
  const envOverrides: Record<string, string | undefined> = {};

  if (options.runtimeEnv !== undefined) {
    for (const [key, value] of Object.entries(options.runtimeEnv)) {
      if (value !== undefined && process.env[key] === undefined) {
        envOverrides[key] = value;
      }
    }
  }
  if (options.ephemeralEnv !== undefined) {
    for (const [key, value] of Object.entries(options.ephemeralEnv)) {
      envOverrides[key] = value;
      scrubber.register(value);
    }
  }
  const activeToken = process.env[LOOPWRIGHT_ACTIVE_PROVIDER_TOKEN_ENV]
    ?? options.runtimeEnv?.[LOOPWRIGHT_ACTIVE_PROVIDER_TOKEN_ENV];
  if (typeof activeToken === 'string' && activeToken.length > 0) {
    envOverrides[LOOPWRIGHT_ACTIVE_PROVIDER_TOKEN_ENV] = activeToken;
    scrubber.register(activeToken);
  }

  let observedRetryablePiFailure = false;
  let observedPiErrorDetail: string | null = null;
  let roleAttemptSeq = 0;
  let formatRepairDispatches = 0;
  let implRepairDispatches = 0;

  const ports: ControllerPorts = {
    openAdapter: async (host: OpenAdapterHost, adapterInput: OpenAdapterInput) => {
      const wrappedHost: OpenAdapterHost = {
        ...host,
        resolveCredential: async binding => {
          try {
            const bound = await host.resolveCredential(binding);
            if (bound.bearerToken.length > 0) return bound;
          } catch {
            // Fall through to active candidate token only for taskpack provider bindings.
          }
          const bindingMeta = binding as { readonly env?: unknown; readonly ref?: unknown };
          const hasExplicitMeta = bindingMeta.env !== undefined || bindingMeta.ref !== undefined;
          const matchesExplicitMeta =
            bindingMeta.env === LOOPWRIGHT_ACTIVE_PROVIDER_TOKEN_ENV
            || bindingMeta.ref === 'taskpack-provider-token';
          const matchesRegistryProviderBinding = options.taskpack.registry.spec.credentialBindings.some(entry =>
            entry.consumer === 'provider'
            && entry.destinationRef === binding.provider
            && (entry.id === 'taskpack-provider-token' || entry.environmentNames.includes(LOOPWRIGHT_ACTIVE_PROVIDER_TOKEN_ENV)),
          );
          if ((hasExplicitMeta && matchesExplicitMeta) || (!hasExplicitMeta && matchesRegistryProviderBinding)) {
            const active = process.env[LOOPWRIGHT_ACTIVE_PROVIDER_TOKEN_ENV];
            if (typeof active === 'string' && active.length > 0) {
              return { bearerToken: active };
            }
          }
          throw new GitHubAppError('ACTION_INPUT_INVALID', 'missing provider credential for active candidate');
        },
      };

      const progressHandler = options.onLog === undefined
        ? undefined
        : (event: HostSessionProgressEvent): void => {
          if (event.kind === 'request_start') {
            options.onLog!(scrubber.scrub(
              `turn #${event.turn}: dispatching request to ${event.provider}/${event.model}`,
            ));
          } else if (event.kind === 'request_settled') {
            const inTok = formatTokenCount(event.inputTokens);
            const outTok = formatTokenCount(event.outputTokens);
            const suffix = event.toolCallNames.length > 0
              ? `tools=[${event.toolCallNames.join(', ')}]`
              : `stop=${event.stopReason}`;
            options.onLog!(scrubber.scrub(
              `turn #${event.turn}: settled in ${formatDurationMs(event.elapsedMs)} — in ${inTok} / out ${outTok} tokens, ${suffix}`,
            ));
          } else if (event.kind === 'tool_end') {
            if (event.errorCode !== undefined) {
              const detail = event.errorPath !== undefined && event.errorPath.length > 0
                ? `${event.errorCode} ${event.errorPath}`
                : event.errorCode;
              options.onLog!(scrubber.scrub(
                `tool ${event.name}: denied (${detail}) — ${formatDurationMs(event.elapsedMs)}`,
              ));
            } else {
              options.onLog!(scrubber.scrub(
                `tool ${event.name}: ${event.isError ? 'error' : 'ok'} (${formatDurationMs(event.elapsedMs)})`,
              ));
            }
          }
        };

      const opened = await openPiHostSessionAdapterV2(wrappedHost, adapterInput, {
        ...(options.mcpRegistry !== undefined ? { mcpRegistry: options.mcpRegistry } : {}),
        ...(progressHandler !== undefined ? { onProgress: progressHandler } : {}),
      });
      if (!opened.ok) {
        observedPiErrorDetail = formatPiErrorDetail(opened.error);
        if (isRetryablePiFailure(opened.error)) {
          observedRetryablePiFailure = true;
        }
        return opened;
      }

      const inner = opened.value;
      return {
        ok: true,
        value: {
          capabilities: () => inner.capabilities(),
          events: () => inner.events(),
          capture: async input => {
            const res = await inner.capture(input);
            if (!res.ok) {
              observedPiErrorDetail = formatPiErrorDetail(res.error, 'capture:');
            }
            return res;
          },
          close: () => inner.close(),
          cancel: input => inner.cancel(input),
          compact: async input => {
            const res = await inner.compact(input);
            if (!res.ok) {
              observedPiErrorDetail = formatPiErrorDetail(res.error);
              if (isRetryablePiFailure(res.error)) {
                observedRetryablePiFailure = true;
              }
            } else if (res.value.error !== null) {
              observedPiErrorDetail = formatPiErrorDetail(res.value.error);
              if (isRetryablePiFailure(res.value.error)) {
                observedRetryablePiFailure = true;
              }
            } else if (
              res.value.status !== 'execution_settled'
              || res.value.usage !== 'complete'
              || res.value.providerTermination !== 'confirmed'
            ) {
              observedPiErrorDetail = `status=${res.value.status} usage=${res.value.usage} term=${res.value.providerTermination}`;
            }
            return res;
          },
          execute: async input => {
            roleAttemptSeq += 1;
            const isFormatRepair = input.repair === 'format' || adapterInput.policy.tools.length === 0;
            if (roleAttemptSeq > 1) {
              if (isFormatRepair) {
                formatRepairDispatches += 1;
                options.onLog?.(scrubber.scrub(`role dispatch #${roleAttemptSeq}: format repair (tools disabled)`));
              } else if (input.repair === 'implementation') {
                implRepairDispatches += 1;
                options.onLog?.(scrubber.scrub(`role dispatch #${roleAttemptSeq}: implementation repair`));
              } else {
                options.onLog?.(scrubber.scrub(`role dispatch #${roleAttemptSeq}: retry dispatch`));
              }
            }
            const res = await inner.execute(input);
            if (!res.ok) {
              observedPiErrorDetail = formatPiErrorDetail(res.error);
              if (isRetryablePiFailure(res.error)) {
                observedRetryablePiFailure = true;
              }
            } else if (res.value.error !== null) {
              observedPiErrorDetail = formatPiErrorDetail(res.value.error);
              if (isRetryablePiFailure(res.value.error)) {
                observedRetryablePiFailure = true;
              }
            } else if (
              res.value.status !== 'execution_settled'
              || res.value.usage !== 'complete'
              || res.value.providerTermination !== 'confirmed'
            ) {
              observedPiErrorDetail = `status=${res.value.status} usage=${res.value.usage} term=${res.value.providerTermination}`;
            }
            return res;
          },
        },
      };
    },
  };

  const runRoot = dirname(options.taskpack.trustedDirectory);
  await mkdir(runRoot, { recursive: true, mode: 0o700 });
  await chmod(runRoot, 0o700).catch(() => undefined);

  const cycleOutcome = await withTemporaryProcessEnv(envOverrides, async () => {
    const loaded = await loadTrustedConfiguration({
      configPath: options.taskpack.configPath,
      registryPath: options.taskpack.registryPath,
      registrySha256: options.taskpack.registrySha256,
      untrustedRoots: [options.repositoryRoot],
    });
    if (!loaded.ok) {
      return {
        kind: 'early_failure' as const,
        ok: false as const,
        code: loaded.error.code,
        detail: scrubber.scrub(`loadTrustedConfiguration failed: ${loaded.error.code}`),
      };
    }

    const cycleResult = await runCycleWithPorts(
      {
        configuration: loaded.value,
        repository: options.repositoryRoot,
        runRoot,
        runId: attemptRunId,
        ...(options.signal !== undefined ? { signal: options.signal } : {}),
      },
      ports,
    );
    if (!cycleResult.ok) {
      return {
        kind: 'early_failure' as const,
        ok: false as const,
        code: cycleResult.error.code,
        detail: scrubber.scrub(`runCycle failed: ${cycleResult.error.code} (${cycleResult.error.phase})`),
      };
    }

    const execution = cycleResult.value;
    if (execution.kind === 'incident') {
      return {
        kind: 'early_failure' as const,
        ok: false as const,
        code: execution.incident.code,
        detail: scrubber.scrub(
          observedPiErrorDetail !== null
            ? `${execution.incident.code}: ${observedPiErrorDetail}`
            : `incident ${execution.incident.code} at ${execution.incident.stage} (${execution.incident.unavailable.join(',')})`,
        ),
      };
    }

    const runResultStatus = execution.result.spec.status;
    const passed = runResultStatus === 'completed' || runResultStatus === 'no_change';
    let observationsDiagnostic: string | null = null;
    let requestedStatus: string | null = null;
    let requestedStatusSource: string | null = null;
    let publicationDiagnostic: string | null = null;
    if (!passed && execution.observations !== null && /^[a-z0-9._-]+$/i.test(execution.observations.name)) {
      try {
        const obsRaw = JSON.parse(
          await readFile(join(runRoot, attemptRunId, 'artifacts', execution.observations.name), 'utf8'),
        ) as unknown;
        if (isPlainRecord(obsRaw)) {
          if (typeof obsRaw['diagnostic'] === 'string' && obsRaw['diagnostic'].length > 0) {
            observationsDiagnostic = obsRaw['diagnostic'];
          }
          if (typeof obsRaw['requestedStatus'] === 'string' && obsRaw['requestedStatus'].length > 0) {
            requestedStatus = obsRaw['requestedStatus'];
          }
          if (typeof obsRaw['requestedStatusSource'] === 'string' && obsRaw['requestedStatusSource'].length > 0) {
            requestedStatusSource = obsRaw['requestedStatusSource'];
          }
          if (isPlainRecord(obsRaw['publication'])) {
            const pubStatus = obsRaw['publication']['status'];
            const pubReason = obsRaw['publication']['reason'];
            if (typeof pubStatus === 'string' && (pubStatus === 'failed' || pubStatus === 'unresolved')) {
              publicationDiagnostic = typeof pubReason === 'string' && pubReason.length > 0
                ? `${pubStatus}:${pubReason}`
                : pubStatus;
            }
          }
        }
      } catch {
        // Best-effort observations read for operator diagnostic detail.
      }
    }
    const rawSpecReason = (execution.result.spec as Record<string, unknown>)['reason'];
    const specReason = typeof rawSpecReason === 'string' && rawSpecReason.trim().length > 0
      ? rawSpecReason.trim()
      : null;
    return {
      kind: 'settled_result' as const,
      ok: passed,
      code: passed ? null : runResultStatus.toUpperCase(),
      detail: `run ${attemptRunId} settled as ${runResultStatus}`,
      settledStatus: passed ? null : runResultStatus,
      specReason,
      observationsDiagnostic,
      requestedStatus,
      requestedStatusSource,
      publicationDiagnostic,
      maxAttempts: options.taskpack.config.spec.controls.maxAttempts,
      maxFormatRepairs: options.taskpack.config.spec.task.spec.budgets.maxFormatRepairs,
      maxImplRepairs: options.taskpack.config.spec.task.spec.budgets.maxImplementationRepairs,
      maxModelCalls: options.taskpack.config.spec.task.spec.budgets.maxModelCalls,
    };
  });

  const rawSummaryHolder = await mkdtemp(join(tmpdir(), 'loopwright-summary-'));
  await chmod(rawSummaryHolder, 0o700);
  const summaryHolder = await realpath(rawSummaryHolder);
  const tempInspectDir = join(summaryHolder, 'bundle');
  let inspectedStatus = cycleOutcome.ok ? 'completed' : 'failed';
  let externalUrl: string | null = null;
  let usage: UsageSummary | null = null;
  let inspectedLedger: {
    readonly formatRepairs: number;
    readonly implementationRepairs: number;
    readonly modelCalls: number;
  } | null = null;
  let extraInfo: { readonly externalWriteDispatched: boolean; readonly checks: readonly ReportCheckItem[] } = {
    externalWriteDispatched: true,
    checks: [],
  };

  try {
    const inspected = await inspectRun({ runRoot, runId: attemptRunId, output: tempInspectDir });
    if (inspected.ok) {
      inspectedStatus = inspected.value.status.status ?? inspectedStatus;
      externalUrl = inspected.value.externalUrl;
      usage = inspected.value.usage;
      if (inspected.value.status.currentState !== null) {
        inspectedLedger = {
          formatRepairs: inspected.value.status.currentState.ledger.formatRepairs,
          implementationRepairs: inspected.value.status.currentState.ledger.implementationRepairs,
          modelCalls: inspected.value.status.currentState.ledger.admittedCalls,
        };
      }
      extraInfo = await inspectRunChecksAndExternalWrites(runRoot, attemptRunId, tempInspectDir);
    }
  } finally {
    await rm(summaryHolder, { recursive: true, force: true }).catch(() => undefined);
  }

  let effectiveDetail = cycleOutcome.detail;
  if (!cycleOutcome.ok && cycleOutcome.kind === 'settled_result' && cycleOutcome.settledStatus !== null) {
    const diagParts: string[] = [];
    if (cycleOutcome.specReason !== null) {
      diagParts.push(`reason=${cycleOutcome.specReason}`);
    }
    if (cycleOutcome.observationsDiagnostic !== null) {
      diagParts.push(`diagnostic=${cycleOutcome.observationsDiagnostic}`);
    }
    const fmtRepairs = Math.max(inspectedLedger?.formatRepairs ?? 0, formatRepairDispatches);
    const impRepairs = Math.max(inspectedLedger?.implementationRepairs ?? 0, implRepairDispatches);
    diagParts.push(`attempts=${roleAttemptSeq}/${cycleOutcome.maxAttempts}`);
    if (fmtRepairs > 0 || cycleOutcome.requestedStatusSource === 'unavailable') {
      diagParts.push(`formatRepairs=${fmtRepairs}/${cycleOutcome.maxFormatRepairs}`);
    }
    if (impRepairs > 0) {
      diagParts.push(`implRepairs=${impRepairs}/${cycleOutcome.maxImplRepairs}`);
    }
    if (inspectedLedger !== null && (cycleOutcome.settledStatus === 'exhausted' || inspectedLedger.modelCalls >= cycleOutcome.maxModelCalls)) {
      diagParts.push(`modelCalls=${inspectedLedger.modelCalls}/${cycleOutcome.maxModelCalls}`);
    }
    if (cycleOutcome.requestedStatusSource === 'unavailable') {
      diagParts.push('submission=unavailable');
    } else if (cycleOutcome.requestedStatus === 'blocked' || cycleOutcome.requestedStatus === 'failed') {
      diagParts.push(`requestedStatus=${cycleOutcome.requestedStatus}`);
    }
    if (cycleOutcome.publicationDiagnostic !== null) {
      diagParts.push(`publication=${cycleOutcome.publicationDiagnostic}`);
    }
    const nonPassingChecks = extraInfo.checks.filter(c => c.status === 'failed' || c.status === 'blocked');
    if (nonPassingChecks.length > 0) {
      const checkSummary = nonPassingChecks
        .slice(0, 3)
        .map(c => {
          const why = typeof c.detail === 'string' && c.detail.length > 0
            ? `:${truncateCodePoints(c.detail, 120)}`
            : '';
          return `${c.checkId}=${c.status}${why}`;
        })
        .join(', ');
      diagParts.push(`checks=[${checkSummary}]`);
    }
    if (observedPiErrorDetail !== null) {
      diagParts.push(`pi=${observedPiErrorDetail}`);
    }
    if (diagParts.length > 0) {
      const sanitizedDiag = sanitizeReportText(diagParts.join(', '), {
        scrub: text => scrubber.scrub(text),
        singleLine: true,
      });
      if (sanitizedDiag.length > 0) {
        effectiveDetail = scrubber.scrub(
          `run ${attemptRunId} settled as ${cycleOutcome.settledStatus} (${truncateCodePoints(sanitizedDiag, 512)})`,
        );
      }
    }
  }

  const retryableProviderFailure = !cycleOutcome.ok
    && observedRetryablePiFailure
    && !extraInfo.externalWriteDispatched;

  const summary: TurnkeyCycleAttemptSummary = {
    attemptSeq: options.attemptSeq,
    attemptRunId,
    ok: cycleOutcome.ok,
    status: inspectedStatus,
    reasonCode: cycleOutcome.code,
    detail: effectiveDetail,
    externalUrl,
    usage,
    checks: extraInfo.checks,
    elapsedMs: Math.max(1, Math.round(performance.now() - startedMs)),
    retryableProviderFailure,
  };
  options.onLog?.(scrubber.scrub(
    `attempt ${summary.attemptRunId}: ${summary.status} in ${formatDurationMs(summary.elapsedMs)}${summary.externalUrl ? ` — PR ${summary.externalUrl}` : ''}${!summary.ok ? ` (${summary.detail})` : ''}`,
  ));
  options.onAttemptSettled?.(summary);

  return {
    ...summary,
    outcome: {
      ok: summary.ok,
      detail: summary.detail,
      retryableProviderFailure: summary.retryableProviderFailure,
    },
  };
}

/**
 * Create a delegate function suitable for `runGitHubActionEntrypoint` that
 * executes isolated per-attempt Controller cycles (`runId`, `runId-a1`, ...).
 */
export function createTurnkeyCycleDelegate(
  options: TurnkeyCycleDelegateOptions,
): (taskpack: WrittenCompiledTaskpack) => Promise<ActionDelegateOutcome> {
  let nextAttemptSeq = 0;
  return async (taskpack: WrittenCompiledTaskpack): Promise<ActionDelegateOutcome> => {
    const attemptSeq = nextAttemptSeq++;
    const result = await executeTurnkeyActionCycle({
      ...options,
      taskpack,
      attemptSeq,
    });
    return result.outcome;
  };
}
