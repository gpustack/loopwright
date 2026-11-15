import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { constants as fsConstants, existsSync } from 'node:fs';
import { chmod, link, lstat, mkdir, mkdtemp, open, readdir, readFile, realpath, rename, rm, unlink, writeFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import type { Readable, Writable } from 'node:stream';
import { STANDARD_PI_PROVIDER_ENV } from '@loopwright/agent-pi/catalog';
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
import {
  applyMemoryProposalCAS,
  canonical as canonicalMemory,
  digestEqual,
  finalizeRunMemory,
  isMemoryManagedPath,
  loadMemoryStore,
  memoryDirectoryFor,
  MemoryDiagnosticError,
  memoryIdentifierPattern,
  normalizeMemoryRoot,
  resolveSettledCycleContext,
  type MemoryEntry,
  type ResolvedSettledCycleContext,
} from '@loopwright/memory';
import { buildDefaultAuthorPrompt, insideRoot } from './action.js';
import { LOOPWRIGHT_ACTIVE_PROVIDER_TOKEN_ENV } from './models-config.js';
import { sanitizeReportText } from './output-format.js';
import { IDENTIFIER_PATTERN, normalizeRelativePath } from './schema.js';
import {
  buildUpstreamVersionsMap,
  compileDeclarativeTaskpack,
  compileScopePatterns,
  DEFAULT_HOST_BUDGETS,
  loadDeclarativeTaskpack,
  mergeTaskpackLimits,
  parseActionInputLimits,
  parseLoopwrightEnvLimits,
  resolveManifestControlRoot,
  resolveTaskpackMemoryLocation,
  stageCompiledInstructionResources,
} from './taskpack.js';
import { assertCleanArtifact, SecretScrubber } from './token-broker.js';
import {
  CANONICAL_TASKPACK_STEP_GATE_URL,
  DEFAULT_LOCAL_COMMAND_GATE_ENV,
  GitHubAppError,
  LOCAL_COMMAND_GATE_ENDPOINT_ID,
  PROTECTED_AUTOMATION_PATHS,
  REPOSITORY_FULL_NAME_PATTERN,
  type ActionDelegateOutcome,
  type CompiledLocalCommandGate,
  type GitCommitIdentity,
  type HostGateEndpointPlan,
  type HostPublicationEndpointPlan,
  type TaskpackManifest,
  type TaskpackUpstreamRecord,
  type TurnkeyMemorySummary,
  type WrittenCompiledTaskpack,
} from './types.js';
import {
  assertNoSymlinkSegments,
  buildCleanGitEnv,
  COMMIT_SHA_PATTERN,
  DEFAULT_GIT_COMMIT_IDENTITY,
  discoverTaskpackUpstreams,
  fetchBoundedText,
  findOpenMemoryPullRequest,
  isPlainRecord,
  parseUpstreamRecordsJson,
  resolveGitExecutable,
  resolveRepositoryAndRevisions,
  type ManagedPullRequestInfo,
  validateGitCommitIdentity,
  validateGitRemoteSource,
} from './upstreams.js';
import { serializePrettyYaml } from './yaml.js';

export { CANONICAL_TASKPACK_STEP_GATE_URL };

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
  ...Object.values(STANDARD_PI_PROVIDER_ENV),
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
  const poolMatch = /^(.+)_([1-9]|1[0-6])$/.exec(key);
  if (poolMatch !== null && FORBIDDEN_CHILD_ENV_NAMES.has(poolMatch[1]!)) return true;
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
  const lowerName = name.normalize('NFC').toLowerCase();
  const lowerProtected = snapshot.protectedPaths.map(entry => entry.normalize('NFC').toLowerCase());
  if (isProtectedCandidatePath(lowerName, lowerProtected)) {
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

interface DetailedGitResult {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly timedOut: boolean;
  readonly stdoutOverflow: boolean;
  readonly spawnError: string | null;
  readonly stdout: Buffer;
  readonly stderr: Buffer;
}

async function execGitDetailed(
  repositoryRoot: string,
  args: readonly string[],
  options: ExecGitOptions,
): Promise<DetailedGitResult> {
  const gitBin = resolveGitExecutable();
  const timeoutMs = options.timeoutMs ?? 15_000;
  const maxStdoutBytes = options.maxStdoutBytes ?? MAX_GIT_LIST_BYTES;
  return await new Promise<DetailedGitResult>(resolvePromise => {
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

    const finish = (result: DetailedGitResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolvePromise(result);
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
      finish({
        code: null,
        signal: null,
        timedOut,
        stdoutOverflow,
        spawnError: err.message,
        stdout: Buffer.concat(stdoutChunks),
        stderr: Buffer.concat(stderrChunks),
      });
    });
    child.on('close', (code, signal) => {
      finish({
        code,
        signal,
        timedOut,
        stdoutOverflow,
        spawnError: null,
        stdout: Buffer.concat(stdoutChunks),
        stderr: Buffer.concat(stderrChunks),
      });
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

async function execGit(
  repositoryRoot: string,
  args: readonly string[],
  options: ExecGitOptions,
): Promise<Buffer> {
  const timeoutMs = options.timeoutMs ?? 15_000;
  const maxStdoutBytes = options.maxStdoutBytes ?? MAX_GIT_LIST_BYTES;
  const result = await execGitDetailed(repositoryRoot, args, options);
  if (result.spawnError !== null) {
    throw new GitHubAppError('ACTION_INPUT_INVALID', `git ${args[0] ?? 'command'} failed to spawn: ${result.spawnError}`);
  }
  if (result.stdoutOverflow) {
    throw new GitHubAppError('ACTION_INPUT_INVALID', `git ${args[0] ?? 'command'} output exceeded ${maxStdoutBytes} bytes`);
  }
  if (result.timedOut) {
    throw new GitHubAppError('ACTION_INPUT_INVALID', `git ${args[0] ?? 'command'} timed out after ${timeoutMs}ms`);
  }
  if (result.code !== 0 || result.signal !== null) {
    const stderrText = result.stderr.toString('utf8').trim();
    const detail = stderrText.length > 0 ? `: ${stderrText}` : '';
    throw new GitHubAppError('ACTION_INPUT_INVALID', `git ${args[0] ?? 'command'} exited with ${result.code ?? result.signal}${detail}`);
  }
  return result.stdout;
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
        for (const file of snapshot.files) {
          if (!isAllowedCandidateWrite(file.name, snapshot)) {
            throw new GitHubAppError(
              'TASKPACK_SCOPE_VIOLATION',
              `candidate overlay file "${file.name}" is outside writable scope`,
            );
          }
        }
        for (const rawDeleted of deletedPaths) {
          const deletedName = normalizeCandidateRelativePath(rawDeleted);
          if (!isAllowedCandidateWrite(deletedName, snapshot)) {
            throw new GitHubAppError(
              'TASKPACK_SCOPE_VIOLATION',
              `candidate deleted path "${deletedName}" is outside writable scope`,
            );
          }
        }
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
  readonly openHostSessionAdapter?: typeof openPiHostSessionAdapterV2 | undefined;
}

export function isRetryablePerRequestTimeout(input: {
  readonly cycleOk: boolean;
  readonly reasonCode: string | null;
  readonly observedPiErrorDetail: string | null;
  readonly externalWriteDispatched: boolean;
  readonly elapsedMs: number;
  readonly taskWallTimeMs: number;
}): boolean {
  if (input.cycleOk || input.externalWriteDispatched) return false;
  if (input.taskWallTimeMs < 420_000) return false;
  if (input.elapsedMs + 120_000 >= input.taskWallTimeMs) return false;
  if (input.observedPiErrorDetail === null || !input.observedPiErrorDetail.startsWith('DEADLINE')) {
    return false;
  }
  if (input.observedPiErrorDetail.includes('(tool')) {
    return false;
  }
  return input.reasonCode === 'RECOVERY_REQUIRED' || input.reasonCode === 'DEADLINE';
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
          const boundRoleMapping = options.taskpack.config.spec.profiles.roles.find(
            item => item.roleId === adapterInput.roleId,
          );
          const roleProfile = boundRoleMapping === undefined
            ? undefined
            : options.taskpack.registry.spec.roleProfiles.find(
              item => item.id === boundRoleMapping.profileRef,
            );
          const explicitEntry = hasExplicitMeta
            ? options.taskpack.registry.spec.credentialBindings.find(entry =>
              entry.consumer === 'provider'
              && (
                (typeof bindingMeta.ref === 'string' && entry.id === bindingMeta.ref)
                || (typeof bindingMeta.env === 'string' && entry.environmentNames.includes(bindingMeta.env))
              ))
            : undefined;
          const matchesExplicitMeta =
            bindingMeta.env === LOOPWRIGHT_ACTIVE_PROVIDER_TOKEN_ENV
            || bindingMeta.ref === 'taskpack-provider-token'
            || (explicitEntry?.environmentNames.includes(LOOPWRIGHT_ACTIVE_PROVIDER_TOKEN_ENV) ?? false);
          const matchesRegistryProviderBinding = options.taskpack.registry.spec.credentialBindings.some(entry =>
            entry.consumer === 'provider'
            && entry.destinationRef === binding.provider
            && (roleProfile?.providerCredentialRef === undefined || entry.id === roleProfile.providerCredentialRef)
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

      const adapterFactory = options.openHostSessionAdapter ?? openPiHostSessionAdapterV2;
      const opened = await adapterFactory(wrappedHost, adapterInput, {
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

  const elapsedMs = Math.max(1, Math.round(performance.now() - startedMs));
  const taskWallTimeMs = options.taskpack.config.spec.task.spec.budgets.wallTimeMs;
  const retryableTimeout = isRetryablePerRequestTimeout({
    cycleOk: cycleOutcome.ok,
    reasonCode: cycleOutcome.code,
    observedPiErrorDetail,
    externalWriteDispatched: extraInfo.externalWriteDispatched,
    elapsedMs,
    taskWallTimeMs,
  });

  const retryableProviderFailure = !cycleOutcome.ok
    && (observedRetryablePiFailure || retryableTimeout)
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
    elapsedMs,
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

export interface StageTaskpackForStepOptions {
  readonly taskpackPath: string;
  readonly repositoryRoot: string;
  readonly runRoot: string;
  readonly runId: string;
  readonly mode?: 'candidate' | 'no-change' | undefined;
  readonly runtimeEnv?: NodeJS.ProcessEnv | undefined;
  readonly upstreamRecordsJson?: string | undefined;
  readonly discoverUpstreams?: boolean | undefined;
}

export interface StagedTaskpackForStep {
  readonly stageDir: string;
  readonly configPath: string;
  readonly registryPath: string;
  readonly registrySha256: string;
  readonly signingSecret: string;
  readonly signingEnvName: string;
  readonly localCommandGates: readonly CompiledLocalCommandGate[];
  readonly repositoryRoot: string;
}

export interface OpenStagedTaskpackStepGateOptions {
  readonly runRoot: string;
  readonly runId: string;
  readonly runtimeEnv?: NodeJS.ProcessEnv | undefined;
}

export interface StagedTaskpackStepGateHandle {
  readonly staged: StagedTaskpackForStep;
  readonly environment: (name: string) => string | undefined;
  readonly gateUrlOverrides: Readonly<Record<string, string>>;
  readonly serverUrl?: string | undefined;
  close(): Promise<void>;
}

const MAX_STAGED_SECRETS_BYTES = 65_536;
const STAGED_COMMAND_ENV_NAME_PATTERN = /^[A-Z][A-Z0-9_]{0,63}$/;
const STAGED_FORBIDDEN_KEYS: ReadonlySet<string> = new Set(['__proto__', 'constructor', 'prototype']);
const STAGED_SECRETS_KEYS: ReadonlySet<string> = new Set([
  'version',
  'runId',
  'repositoryRoot',
  'configPath',
  'registryPath',
  'registrySha256',
  'signingSecret',
  'signingEnvName',
  'localCommandGates',
]);
const STAGED_GATE_KEYS: ReadonlySet<string> = new Set([
  'checkId',
  'gateId',
  'endpointRef',
  'script',
  'scriptSha256',
  'timeoutSeconds',
  'allowReadOnlyGitHubToken',
  'env',
]);

async function assertOwnedPrivateDirectory(dirPath: string): Promise<void> {
  let st;
  try {
    st = await lstat(dirPath);
  } catch {
    throw new GitHubAppError('ACTION_INPUT_INVALID', `staged taskpack directory "${dirPath}" could not be inspected`);
  }
  const expectedUid = process.getuid?.();
  if (
    st.isSymbolicLink()
    || !st.isDirectory()
    || (expectedUid !== undefined && st.uid !== expectedUid)
    || (st.mode & 0o777) !== 0o700
  ) {
    throw new GitHubAppError(
      'ACTION_INPUT_INVALID',
      `staged taskpack directory "${dirPath}" must be an owner-only (0o700) non-symlink directory`,
    );
  }
}

async function writeExclusiveFile(path: string, bytes: Buffer, mode: number): Promise<void> {
  let handle;
  try {
    handle = await open(
      path,
      fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY | fsConstants.O_NOFOLLOW,
      mode,
    );
  } catch {
    throw new GitHubAppError('ACTION_INPUT_INVALID', `staged taskpack file "${path}" could not be created exclusively`);
  }
  try {
    await handle.writeFile(bytes);
    await handle.chmod(mode);
  } finally {
    await handle.close();
  }
}

async function readAndValidateStagedTaskpackSecrets(
  stageDir: string,
  expectedRunId: string,
): Promise<StagedTaskpackForStep> {
  await assertOwnedPrivateDirectory(stageDir);
  const secretsPath = join(stageDir, 'secrets.json');
  let secretsLstat;
  try {
    secretsLstat = await lstat(secretsPath);
  } catch {
    throw new GitHubAppError('ACTION_INPUT_INVALID', `staged taskpack secrets.json at "${secretsPath}" is missing or unreadable`);
  }
  const expectedUid = process.getuid?.();
  if (
    secretsLstat.isSymbolicLink()
    || !secretsLstat.isFile()
    || secretsLstat.nlink !== 1
    || (expectedUid !== undefined && secretsLstat.uid !== expectedUid)
    || (secretsLstat.mode & 0o777) !== 0o600
    || secretsLstat.size > MAX_STAGED_SECRETS_BYTES
  ) {
    throw new GitHubAppError('ACTION_INPUT_INVALID', `staged taskpack secrets.json at "${secretsPath}" must be a regular 0o600 file with nlink === 1`);
  }
  let handle;
  try {
    handle = await open(secretsPath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  } catch {
    throw new GitHubAppError('ACTION_INPUT_INVALID', `staged taskpack secrets.json at "${secretsPath}" could not be opened safely`);
  }
  let rawText: string;
  try {
    const info = await handle.stat();
    if (
      !info.isFile()
      || info.nlink !== 1
      || info.dev !== secretsLstat.dev
      || info.ino !== secretsLstat.ino
      || info.size !== secretsLstat.size
      || (expectedUid !== undefined && info.uid !== expectedUid)
      || (info.mode & 0o777) !== 0o600
      || info.size > MAX_STAGED_SECRETS_BYTES
    ) {
      throw new GitHubAppError('ACTION_INPUT_INVALID', `staged taskpack secrets.json at "${secretsPath}" failed ownership, mode, or link verification`);
    }
    const buf = Buffer.alloc(info.size + 1);
    let readBytes = 0;
    while (readBytes < buf.length) {
      const next = await handle.read(buf, readBytes, buf.length - readBytes, readBytes);
      if (next.bytesRead === 0) break;
      readBytes += next.bytesRead;
    }
    const after = await handle.stat();
    const currentLstat = await lstat(secretsPath);
    if (
      readBytes !== info.size
      || after.size !== info.size
      || after.mtimeMs !== info.mtimeMs
      || after.ctimeMs !== info.ctimeMs
      || currentLstat.dev !== info.dev
      || currentLstat.ino !== info.ino
    ) {
      throw new GitHubAppError('ACTION_INPUT_INVALID', `staged taskpack secrets.json at "${secretsPath}" changed during read`);
    }
    rawText = buf.subarray(0, readBytes).toString('utf8');
  } finally {
    await handle.close();
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(rawText);
  } catch {
    throw new GitHubAppError('ACTION_INPUT_INVALID', 'staged taskpack secrets.json is not valid JSON');
  }
  if (!isPlainRecord(parsed) || parsed['version'] !== 1) {
    throw new GitHubAppError('ACTION_INPUT_INVALID', 'staged taskpack secrets.json has unsupported schema');
  }
  for (const key of Object.keys(parsed)) {
    if (STAGED_FORBIDDEN_KEYS.has(key) || !STAGED_SECRETS_KEYS.has(key)) {
      throw new GitHubAppError('ACTION_INPUT_INVALID', `staged taskpack secrets.json contains invalid key "${key}"`);
    }
  }
  const runId = parsed['runId'];
  const repositoryRoot = parsed['repositoryRoot'];
  const configPath = parsed['configPath'];
  const registryPath = parsed['registryPath'];
  const registrySha256 = parsed['registrySha256'];
  const signingSecret = parsed['signingSecret'];
  const signingEnvName = parsed['signingEnvName'];
  const rawGates = parsed['localCommandGates'];
  const expectedConfigPath = join(stageDir, 'config', 'controller.yaml');
  const expectedRegistryPath = join(stageDir, 'registry', 'registry.yaml');
  if (
    runId !== expectedRunId
    || typeof repositoryRoot !== 'string' || repositoryRoot.length === 0 || !isAbsolute(repositoryRoot)
    || configPath !== expectedConfigPath
    || registryPath !== expectedRegistryPath
    || typeof registrySha256 !== 'string' || !SHA256_HEX_PATTERN.test(registrySha256)
    || typeof signingSecret !== 'string' || signingSecret.length < 16
    || typeof signingEnvName !== 'string' || !/^[A-Z][A-Z0-9_]*$/.test(signingEnvName)
    || !Array.isArray(rawGates) || rawGates.length > 32
  ) {
    throw new GitHubAppError('ACTION_INPUT_INVALID', 'staged taskpack secrets.json fields are invalid');
  }

  const localCommandGates: CompiledLocalCommandGate[] = [];
  for (const gate of rawGates) {
    if (!isPlainRecord(gate)) {
      throw new GitHubAppError('ACTION_INPUT_INVALID', 'staged taskpack localCommandGates entry is invalid');
    }
    for (const key of Object.keys(gate)) {
      if (STAGED_FORBIDDEN_KEYS.has(key) || !STAGED_GATE_KEYS.has(key)) {
        throw new GitHubAppError('ACTION_INPUT_INVALID', `staged taskpack localCommandGates entry has invalid key "${key}"`);
      }
    }
    if (
      typeof gate['checkId'] !== 'string' || !IDENTIFIER_PATTERN.test(gate['checkId'])
      || typeof gate['gateId'] !== 'string' || !IDENTIFIER_PATTERN.test(gate['gateId'])
      || (gate['endpointRef'] !== undefined && gate['endpointRef'] !== LOCAL_COMMAND_GATE_ENDPOINT_ID)
      || typeof gate['script'] !== 'string' || gate['script'].length === 0
      || typeof gate['scriptSha256'] !== 'string' || !SHA256_HEX_PATTERN.test(gate['scriptSha256'])
      || typeof gate['timeoutSeconds'] !== 'number'
      || !Number.isSafeInteger(gate['timeoutSeconds'])
      || gate['timeoutSeconds'] < 1
      || gate['timeoutSeconds'] > 3_600
      || !Array.isArray(gate['env'])
      || gate['env'].length > 16
      || gate['env'].some(e => typeof e !== 'string' || !STAGED_COMMAND_ENV_NAME_PATTERN.test(e) || isForbiddenChildEnvName(e))
      || typeof gate['allowReadOnlyGitHubToken'] !== 'boolean'
    ) {
      throw new GitHubAppError('ACTION_INPUT_INVALID', 'staged taskpack localCommandGates entry is invalid');
    }
    let normalizedScript: string;
    try {
      normalizedScript = normalizeCandidateRelativePath(gate['script']);
    } catch {
      throw new GitHubAppError('ACTION_INPUT_INVALID', 'staged taskpack localCommandGates script path is invalid');
    }
    localCommandGates.push({
      checkId: gate['checkId'],
      gateId: gate['gateId'],
      endpointRef: LOCAL_COMMAND_GATE_ENDPOINT_ID,
      script: normalizedScript,
      scriptSha256: gate['scriptSha256'],
      timeoutSeconds: gate['timeoutSeconds'],
      env: Object.freeze([...(gate['env'] as string[])]),
      allowReadOnlyGitHubToken: gate['allowReadOnlyGitHubToken'],
    });
  }

  return {
    stageDir,
    configPath,
    registryPath,
    registrySha256,
    signingSecret,
    signingEnvName,
    localCommandGates: Object.freeze(localCommandGates),
    repositoryRoot,
  };
}

/**
 * Stage a declarative Taskpack for non-blocking `loopwright step next` / `submit`
 * execution (`executionMode: 'delegated'`), reusing existing staged files for the
 * same `(runRoot, runId)` so `TaskLock` and `registrySha256` remain identical across steps.
 */
export async function stageTaskpackForStep(
  options: StageTaskpackForStepOptions,
): Promise<StagedTaskpackForStep> {
  const runId = normalizeControllerRunId(options.runId);
  if (runId !== options.runId) {
    throw new GitHubAppError('ACTION_INPUT_INVALID', `invalid controller runId "${options.runId}"`);
  }
  if (typeof options.repositoryRoot !== 'string' || options.repositoryRoot.trim().length === 0) {
    throw new GitHubAppError('ACTION_INPUT_INVALID', 'repositoryRoot must exist');
  }
  let realRepositoryRoot: string;
  try {
    realRepositoryRoot = await realpath(options.repositoryRoot);
    const repoStat = await lstat(realRepositoryRoot);
    if (!repoStat.isDirectory()) {
      throw new GitHubAppError('ACTION_INPUT_INVALID', 'repositoryRoot must exist');
    }
  } catch (error) {
    if (error instanceof GitHubAppError) throw error;
    throw new GitHubAppError('ACTION_INPUT_INVALID', 'repositoryRoot must exist');
  }

  if (typeof options.runRoot !== 'string' || options.runRoot.trim().length === 0) {
    throw new GitHubAppError('ACTION_INPUT_INVALID', 'runRoot must be a non-symlink directory');
  }
  const resolvedRunRoot = resolve(options.runRoot);
  let anc = resolvedRunRoot;
  let ancStat: Awaited<ReturnType<typeof lstat>>;
  for (;;) {
    try {
      ancStat = await lstat(anc);
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw new GitHubAppError('ACTION_INPUT_INVALID', 'runRoot must be a non-symlink directory');
      }
      const parent = dirname(anc);
      if (parent === anc) {
        throw new GitHubAppError('ACTION_INPUT_INVALID', 'runRoot must be a non-symlink directory');
      }
      anc = parent;
    }
  }
  if (anc === resolvedRunRoot && (ancStat.isSymbolicLink() || !ancStat.isDirectory())) {
    throw new GitHubAppError('ACTION_INPUT_INVALID', 'runRoot must be a non-symlink directory');
  }
  if (!ancStat.isDirectory() && !ancStat.isSymbolicLink()) {
    throw new GitHubAppError('ACTION_INPUT_INVALID', 'runRoot must be a non-symlink directory');
  }
  let realAnc: string;
  try {
    realAnc = await realpath(anc);
    const realAncStat = await lstat(realAnc);
    if (!realAncStat.isDirectory()) {
      throw new GitHubAppError('ACTION_INPUT_INVALID', 'runRoot must be a non-symlink directory');
    }
  } catch (error) {
    if (error instanceof GitHubAppError) throw error;
    throw new GitHubAppError('ACTION_INPUT_INVALID', 'runRoot must be a non-symlink directory');
  }
  const prospectiveRunRoot = anc === resolvedRunRoot ? realAnc : resolve(realAnc, relative(anc, resolvedRunRoot));
  if (
    insideRoot(prospectiveRunRoot, realRepositoryRoot)
    || insideRoot(realRepositoryRoot, prospectiveRunRoot)
    || insideRoot(realRepositoryRoot, join(prospectiveRunRoot, runId))
    || insideRoot(realRepositoryRoot, join(prospectiveRunRoot, `.taskpack-${runId}`))
    || insideRoot(realRepositoryRoot, join(prospectiveRunRoot, 'workspaces'))
  ) {
    throw new GitHubAppError('ACTION_INPUT_INVALID', 'runRoot must live outside the target repository checkout');
  }

  await mkdir(resolvedRunRoot, { recursive: true, mode: 0o700 });
  const createdRunRootStat = await lstat(resolvedRunRoot);
  if (createdRunRootStat.isSymbolicLink() || !createdRunRootStat.isDirectory()) {
    throw new GitHubAppError('ACTION_INPUT_INVALID', 'runRoot must be a non-symlink directory');
  }
  await chmod(resolvedRunRoot, 0o700);
  const realRunRoot = await realpath(resolvedRunRoot);
  if (insideRoot(realRunRoot, realRepositoryRoot) || insideRoot(realRepositoryRoot, realRunRoot)) {
    throw new GitHubAppError('ACTION_INPUT_INVALID', 'runRoot must live outside the target repository checkout');
  }

  const stageDir = join(realRunRoot, `.taskpack-${runId}`);
  const secretsPath = join(stageDir, 'secrets.json');
  let existingStageStat = null;
  try {
    existingStageStat = await lstat(stageDir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw new GitHubAppError('ACTION_INPUT_INVALID', `staged taskpack directory "${stageDir}" could not be inspected`);
    }
  }
  if (existingStageStat !== null) {
    const expectedUid = process.getuid?.();
    if (
      existingStageStat.isSymbolicLink()
      || !existingStageStat.isDirectory()
      || (expectedUid !== undefined && existingStageStat.uid !== expectedUid)
      || (existingStageStat.mode & 0o777) !== 0o700
    ) {
      throw new GitHubAppError(
        'ACTION_INPUT_INVALID',
        `staged taskpack directory "${stageDir}" must be an owner-only (0o700) non-symlink directory`,
      );
    }
    return await readAndValidateStagedTaskpackSecrets(stageDir, runId);
  }

  const runtimeEnv = options.runtimeEnv ?? process.env;
  const scrubber = new SecretScrubber();
  for (const key of ['GITHUB_TOKEN', 'GH_TOKEN', 'INPUT_GITHUB-TOKEN', 'INPUT_GITHUB-APP-PRIVATE-KEY']) {
    const val = runtimeEnv[key];
    if (typeof val === 'string' && val.trim().length > 0) {
      scrubber.register(val.trim());
    }
  }
  const mode = options.mode ?? 'candidate';

  const manifestFullPath = isAbsolute(options.taskpackPath)
    ? resolve(options.taskpackPath)
    : join(realRepositoryRoot, options.taskpackPath);
  const relToRoot = relative(realRepositoryRoot, manifestFullPath);
  if (relToRoot.length === 0 || relToRoot === '..' || relToRoot.startsWith(`..${sep}`) || isAbsolute(relToRoot)) {
    throw new GitHubAppError('TASKPACK_MANIFEST_INVALID', 'taskpack manifest escapes the repository root', '/');
  }
  const relativeTaskpackPath = normalizeRelativePath(relToRoot.split(sep).join('/'), '/');
  const manifest = await loadDeclarativeTaskpack({
    manifestPath: relativeTaskpackPath,
    repositoryRoot: realRepositoryRoot,
  });

  const rawGithubWorkspace = runtimeEnv['GITHUB_WORKSPACE']?.trim();
  let matchesGithubWorkspace = rawGithubWorkspace === undefined || rawGithubWorkspace.length === 0;
  if (!matchesGithubWorkspace && rawGithubWorkspace !== undefined) {
    const realGithubWorkspace = await realpath(rawGithubWorkspace).catch(() => null);
    matchesGithubWorkspace = realGithubWorkspace === realRepositoryRoot;
  }

  const envRepo = runtimeEnv['LOOPWRIGHT_REPOSITORY']?.trim()
    || (matchesGithubWorkspace ? runtimeEnv['GITHUB_REPOSITORY']?.trim() : undefined);
  const repositoryFullName = envRepo !== undefined && REPOSITORY_FULL_NAME_PATTERN.test(envRepo)
    ? envRepo
    : 'local/repo';

  let baseRevision = 'HEAD';
  const envGithubSha = matchesGithubWorkspace ? runtimeEnv['GITHUB_SHA']?.trim() : undefined;
  if (envGithubSha !== undefined && envGithubSha.length > 0) {
    if (COMMIT_SHA_PATTERN.test(envGithubSha)) {
      const existsInRepo = await execGit(
        realRepositoryRoot,
        ['rev-parse', '--verify', '--quiet', '--end-of-options', `${envGithubSha.toLowerCase()}^{commit}`],
        { env: buildCleanGitEnv(), timeoutMs: 5_000 },
      ).then(() => true, () => false);
      if (existsInRepo) {
        baseRevision = envGithubSha.toLowerCase();
      }
    } else {
      baseRevision = envGithubSha;
    }
  }

  const resolvedRepo = await resolveRepositoryAndRevisions({
    repositoryRoot: realRepositoryRoot,
    repositoryFullName,
    baseRevision,
    eventName: 'workflow_dispatch',
    scrubber,
  });

  let upstreamRecords: readonly TaskpackUpstreamRecord[] = [];
  if (options.upstreamRecordsJson !== undefined) {
    upstreamRecords = parseUpstreamRecordsJson(options.upstreamRecordsJson);
  } else if (options.discoverUpstreams !== false && manifest.spec.upstreams.length > 0) {
    upstreamRecords = await discoverTaskpackUpstreams(manifest, {
      repositoryRoot: realRepositoryRoot,
      scrubber,
      env: runtimeEnv,
    });
  }

  const signingSecret = randomBytes(32).toString('hex');
  scrubber.register(signingSecret);
  const signingEnvName = DEFAULT_LOCAL_COMMAND_GATE_ENV;

  const envLimits = parseLoopwrightEnvLimits(runtimeEnv);
  const actionInputLimits = parseActionInputLimits(runtimeEnv);
  const effectiveStepLimits = mergeTaskpackLimits(envLimits, manifest.spec.limits, actionInputLimits);

  const commandChecks = mode === 'candidate'
    ? manifest.spec.verification.localChecks.filter(check => check.implementation === 'command.v1')
    : [];
  const gateEndpoints: HostGateEndpointPlan[] = [];
  if (commandChecks.length > 0) {
    let maxTimeoutSeconds = effectiveStepLimits.commandTimeoutSeconds ?? 30;
    for (const check of commandChecks) {
      const rawTimeout = check.parameters?.['timeoutSeconds'];
      if (typeof rawTimeout === 'number' && Number.isSafeInteger(rawTimeout) && rawTimeout > maxTimeoutSeconds) {
        maxTimeoutSeconds = rawTimeout;
      }
    }
    const timeoutMs = Math.min(3_600_000, Math.max(35_000, maxTimeoutSeconds * 1000 + 15_000));
    const maxPollMs = Math.min(3_600_000, Math.max(50_000, timeoutMs + 15_000));
    gateEndpoints.push({
      id: LOCAL_COMMAND_GATE_ENDPOINT_ID,
      url: CANONICAL_TASKPACK_STEP_GATE_URL,
      signingCredentialRef: 'taskpack-local-command-signing',
      authCredentialRef: null,
      timeoutMs,
      maxPollMs,
      pollInitialMs: 100,
      pollMaxMs: 500,
      jitter: 0,
    });
  }

  const authorPrompt = buildDefaultAuthorPrompt({
    mode,
    repositoryFullName,
    upstreamRecords,
    acceptanceCheckIds: [
      ...manifest.spec.verification.localChecks.map(c => c.id),
      ...manifest.spec.verification.externalGates.map(g => g.id),
    ],
    runtimeEnv,
    scrubber,
  });
  const compiled = await compileDeclarativeTaskpack(manifest, {
    mode,
    executionMode: 'delegated',
    repository: repositoryFullName,
    repositoryRoot: realRepositoryRoot,
    taskpackPath: relativeTaskpackPath,
    baseRevision: resolvedRepo.baseRevision,
    sourceRevision: resolvedRepo.sourceRevision,
    budgets: DEFAULT_HOST_BUDGETS,
    limits: actionInputLimits,
    envLimits,
    gateEndpoints,
    credentialEnvMap: {
      localCommandGate: signingEnvName,
    },
    authorPrompt,
    upstreamRecords,
    scrubber,
  });

  const registryDirectory = join(stageDir, 'registry');
  const configDirectory = join(stageDir, 'config');
  await mkdir(stageDir, { recursive: true, mode: 0o700 });
  await chmod(stageDir, 0o700);
  await assertOwnedPrivateDirectory(stageDir);
  await mkdir(registryDirectory, { recursive: true, mode: 0o700 });
  await chmod(registryDirectory, 0o700);
  await assertOwnedPrivateDirectory(registryDirectory);
  await mkdir(configDirectory, { recursive: true, mode: 0o700 });
  await chmod(configDirectory, 0o700);
  await assertOwnedPrivateDirectory(configDirectory);

  const registryPath = join(registryDirectory, 'registry.yaml');
  const configPath = join(configDirectory, 'controller.yaml');
  const configBytes = Buffer.from(serializePrettyYaml(compiled.config), 'utf8');

  assertCleanArtifact(compiled.registryBytes, scrubber, '/registry');
  assertCleanArtifact(configBytes, scrubber, '/config');
  if (compiled.instructionResources !== undefined && compiled.instructionResources.length > 0) {
    await stageCompiledInstructionResources(registryDirectory, compiled.instructionResources);
    for (const resource of compiled.instructionResources) {
      assertCleanArtifact(resource.bytes, scrubber, `/resources/${resource.id}`);
    }
  }

  await writeExclusiveFile(registryPath, compiled.registryBytes, 0o600);
  await writeExclusiveFile(configPath, configBytes, 0o600);

  const localCommandGates = compiled.localCommandGates ?? [];
  const secretsPayload = Buffer.from(
    `${JSON.stringify({
      version: 1,
      runId,
      repositoryRoot: realRepositoryRoot,
      configPath,
      registryPath,
      registrySha256: compiled.registrySha256,
      signingSecret,
      signingEnvName,
      localCommandGates,
    }, null, 2)}\n`,
    'utf8',
  );
  await writeExclusiveFile(secretsPath, secretsPayload, 0o600);

  return {
    stageDir,
    configPath,
    registryPath,
    registrySha256: compiled.registrySha256,
    signingSecret,
    signingEnvName,
    localCommandGates: Object.freeze([...localCommandGates]),
    repositoryRoot: realRepositoryRoot,
  };
}

/**
 * Open the staged Taskpack step gate handle for `(runRoot, runId)`. Returns `null`
 * when `<runRoot>/.taskpack-<runId>` does not exist, or starts an ephemeral loopback
 * `startLocalCommandGateServer` when `localCommandGates` are staged.
 */
export async function openStagedTaskpackStepGate(
  options: OpenStagedTaskpackStepGateOptions,
): Promise<StagedTaskpackStepGateHandle | null> {
  const runId = normalizeControllerRunId(options.runId);
  if (runId !== options.runId) {
    throw new GitHubAppError('ACTION_INPUT_INVALID', `invalid controller runId "${options.runId}"`);
  }
  let realRunRoot: string;
  try {
    realRunRoot = await realpath(options.runRoot);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return null;
    }
    throw error;
  }

  const stageDir = join(realRunRoot, `.taskpack-${runId}`);
  try {
    await lstat(stageDir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return null;
    }
    throw error;
  }

  const staged = await readAndValidateStagedTaskpackSecrets(stageDir, runId);
  const baseEnv = options.runtimeEnv ?? process.env;
  const environment = (name: string): string | undefined =>
    name === staged.signingEnvName
      ? staged.signingSecret
      : (Object.hasOwn(baseEnv, name) ? baseEnv[name] : undefined);

  if (staged.localCommandGates.length === 0) {
    return {
      staged,
      environment,
      gateUrlOverrides: Object.freeze({}),
      close: async () => undefined,
    };
  }

  const readOnlyGitHubToken = baseEnv['INPUT_GITHUB-TOKEN']?.trim()
    || baseEnv['GITHUB_TOKEN']?.trim()
    || baseEnv['GH_TOKEN']?.trim()
    || undefined;
  const server = await startLocalCommandGateServer({
    runRoot: realRunRoot,
    repositoryRoot: staged.repositoryRoot,
    gates: staged.localCommandGates,
    signingSecret: staged.signingSecret,
    runtimeEnv: baseEnv,
    readOnlyGitHubToken,
    forbiddenEnvNames: new Set([staged.signingEnvName, ...Object.values(STANDARD_PI_PROVIDER_ENV)]),
  });

  return {
    staged,
    environment,
    gateUrlOverrides: Object.freeze({ [LOCAL_COMMAND_GATE_ENDPOINT_ID]: server.url }),
    serverUrl: server.url,
    close: () => server.close(),
  };
}

export interface FinalizeAndPublishTurnkeyMemoryOptions {
  readonly runRoot: string;
  readonly runId: string;
  readonly repositoryRoot: string;
  readonly repositoryFullName: string;
  readonly manifest: TaskpackManifest;
  readonly taskpackPath?: string | undefined;
  readonly baseRevision: string;
  readonly upstreamRecords?: readonly TaskpackUpstreamRecord[] | undefined;
  readonly remoteUrl?: string | undefined;
  readonly apiBaseUrl?: string | undefined;
  readonly githubToken?: string | undefined;
  readonly gitCommitIdentity?: GitCommitIdentity | undefined;
  readonly fetchImpl?: typeof globalThis.fetch | undefined;
  readonly runtimeEnv?: NodeJS.ProcessEnv | undefined;
  readonly scrubber: SecretScrubber;
  readonly nowMs?: number | undefined;
}

const DEFAULT_MEMORY_ENTRY_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const MEMORY_PUBLICATION_JOURNAL_FILE = 'memory-publication.json';
const MEMORY_PUBLICATION_FENCES_DIR = '.memory-publications';
const MAX_MANAGED_MEMORY_FILES = 2_049;
const MAX_MEMORY_INDEX_BLOB_BYTES = MAX_GIT_LIST_BYTES;
const MAX_MEMORY_ENTRY_BLOB_BYTES = 524_288;

export interface TurnkeyMemoryPublicationJournal {
  readonly version: 1;
  readonly state: 'uncertain' | 'push_only' | 'completed';
  readonly stage: 'push' | 'pull_request' | 'reconciled';
  readonly pushState: 'in_flight' | 'committed' | 'not_executed';
  readonly pullRequestState: 'not_started' | 'in_flight' | 'committed' | 'not_executed';
  readonly status: 'published' | 'updated' | 'reconcile_required' | 'skipped';
  readonly repository: string;
  readonly taskpack: string;
  readonly targetBranch: string;
  readonly directory: string;
  readonly proposalId: string;
  readonly entryCount: number;
  readonly rebased: boolean;
  readonly branchName: string;
  readonly headOid: string;
  readonly expectedRemoteOid: string;
  readonly attemptNonce?: string | undefined;
  readonly pullRequestTitle?: string | undefined;
  readonly pullRequestBody?: string | undefined;
  readonly pullRequestUrl: string | null;
  readonly pullRequestNumber: number | null;
  readonly reason: string | null;
  readonly updatedAtMs: number;
}

export interface ReconcileTurnkeyMemoryPublicationOptions {
  readonly runRoot: string;
  readonly runId: string;
  readonly outcome: 'confirmed' | 'not_executed' | 'push_only';
  readonly directory?: string | undefined;
  readonly taskpack?: string | undefined;
  readonly targetBranch?: string | undefined;
  readonly pullRequestNumber?: number | undefined;
  readonly pullRequestUrl?: string | undefined;
  readonly isUpdate?: boolean | undefined;
  readonly scrubber?: SecretScrubber | undefined;
  readonly nowMs?: number | undefined;
}

interface MemoryBranchPublicationFence {
  readonly version: 1;
  readonly repository: string;
  readonly branchName: string;
  readonly runId: string;
  readonly taskpack?: string | undefined;
  readonly targetBranch?: string | undefined;
  readonly directory?: string | undefined;
  readonly proposalId?: string | undefined;
  readonly entryCount?: number | undefined;
  readonly rebased?: boolean | undefined;
  readonly pullRequestTitle?: string | undefined;
  readonly state: 'uncertain' | 'push_only' | 'completed';
  readonly stage: 'push' | 'pull_request' | 'reconciled';
  readonly headOid: string;
  readonly previousConfirmedHeadOid: string | null;
  readonly updatedAtMs: number;
}

function memoryBranchFenceKey(repositoryFullName: string, branchName: string): string {
  return createHash('sha256')
    .update(`${repositoryFullName.toLowerCase()}\0${branchName}`)
    .digest('hex');
}

function isProcessAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

async function resolveSafeRunRootDirectory(runRoot: string, createIfMissing: boolean): Promise<string | null> {
  const absRoot = resolve(runRoot);
  let rootStats = await lstat(absRoot).catch((err: NodeJS.ErrnoException) => {
    if (err.code === 'ENOENT') return null;
    throw err;
  });
  if (rootStats === null) {
    if (!createIfMissing) return null;
    await mkdir(absRoot, { recursive: true, mode: 0o700 });
    rootStats = await lstat(absRoot);
  }
  if (rootStats.isSymbolicLink() || !rootStats.isDirectory()) {
    throw new GitHubAppError('ACTION_INPUT_INVALID', 'runRoot must be a non-symlink directory');
  }
  return absRoot;
}

async function syncDirectoryDurable(dirPath: string): Promise<void> {
  const dirHandle = await open(
    dirPath,
    fsConstants.O_RDONLY | fsConstants.O_DIRECTORY | fsConstants.O_NOFOLLOW,
  );
  try {
    await dirHandle.sync();
  } finally {
    await dirHandle.close();
  }
}

async function ensureMemoryFencesDirectory(runRoot: string, createIfMissing: boolean): Promise<string | null> {
  const absRoot = await resolveSafeRunRootDirectory(runRoot, createIfMissing);
  if (absRoot === null) return null;
  const fencesDir = join(absRoot, MEMORY_PUBLICATION_FENCES_DIR);
  let stats = await lstat(fencesDir).catch((err: NodeJS.ErrnoException) => {
    if (err.code === 'ENOENT') return null;
    throw err;
  });
  if (stats === null) {
    if (!createIfMissing) return null;
    let created = false;
    await mkdir(fencesDir, { mode: 0o700 }).then(
      () => {
        created = true;
      },
      (err: NodeJS.ErrnoException) => {
        if (err.code !== 'EEXIST') throw err;
      },
    );
    stats = await lstat(fencesDir);
    if (created && !stats.isSymbolicLink() && stats.isDirectory()) {
      await syncDirectoryDurable(absRoot);
    }
  }
  if (stats.isSymbolicLink() || !stats.isDirectory()) {
    throw new GitHubAppError('ACTION_INPUT_INVALID', '.memory-publications must be a non-symlink directory');
  }
  return fencesDir;
}

type BoundedRegularJsonReadResult =
  | { readonly exists: false }
  | { readonly exists: true; readonly value: unknown };

async function readRegularJsonFileBounded(
  path: string,
  maxBytes: number,
  label: string,
): Promise<BoundedRegularJsonReadResult> {
  const stats = await lstat(path).catch((err: NodeJS.ErrnoException) => {
    if (err.code === 'ENOENT') return null;
    throw err;
  });
  if (stats === null) return { exists: false };
  if (stats.isSymbolicLink() || !stats.isFile() || stats.size > maxBytes) {
    throw new GitHubAppError('ACTION_INPUT_INVALID', `${label} must be a bounded regular file`);
  }
  const handle = await open(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  let rawBytes: Buffer;
  try {
    rawBytes = await handle.readFile();
  } finally {
    await handle.close();
  }
  try {
    return { exists: true, value: JSON.parse(rawBytes.toString('utf8')) };
  } catch {
    throw new GitHubAppError('ACTION_INPUT_INVALID', `corrupt ${label}; manual reconciliation required`);
  }
}

async function writeAtomicPrivateFile(targetPath: string, payload: Buffer, label: string): Promise<void> {
  const existingStats = await lstat(targetPath).catch((err: NodeJS.ErrnoException) => {
    if (err.code === 'ENOENT') return null;
    throw err;
  });
  if (existingStats !== null && existingStats.isSymbolicLink()) {
    throw new GitHubAppError('ACTION_INPUT_INVALID', `refusing to overwrite symlinked ${label}`);
  }
  const tempPath = `${targetPath}.tmp-${process.pid}-${randomBytes(6).toString('hex')}`;
  const handle = await open(
    tempPath,
    fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY | fsConstants.O_NOFOLLOW,
    0o600,
  );
  try {
    await handle.writeFile(payload);
    await handle.sync();
  } catch (err) {
    await handle.close().catch(() => undefined);
    await unlink(tempPath).catch(() => undefined);
    throw err;
  }
  await handle.close();
  try {
    await rename(tempPath, targetPath);
  } catch (err) {
    await unlink(tempPath).catch(() => undefined);
    throw err;
  }
  await syncDirectoryDurable(dirname(targetPath));
}

interface MemoryBranchFenceLockPayload {
  readonly version: 1;
  readonly pid: number;
  readonly nonce: string;
  readonly runId: string;
  readonly acquiredAtMs: number;
}

interface MemoryFenceEvictionClaimPayload {
  readonly version: 1;
  readonly pid: number;
  readonly nonce: string;
  readonly targetNonce: string;
  readonly createdAtMs: number;
}

function parseMemoryBranchFenceLock(parsed: unknown): MemoryBranchFenceLockPayload {
  if (
    !isPlainRecord(parsed)
    || parsed['version'] !== 1
    || typeof parsed['pid'] !== 'number'
    || !Number.isSafeInteger(parsed['pid'])
    || parsed['pid'] <= 0
    || typeof parsed['nonce'] !== 'string'
    || !/^[0-9a-f]{24}$/.test(parsed['nonce'])
    || typeof parsed['runId'] !== 'string'
    || parsed['runId'].length === 0
    || parsed['runId'].length > 128
    || typeof parsed['acquiredAtMs'] !== 'number'
    || !Number.isSafeInteger(parsed['acquiredAtMs'])
    || parsed['acquiredAtMs'] < 0
  ) {
    throw new GitHubAppError(
      'ACTION_INPUT_INVALID',
      'corrupt or incomplete memory branch fence lock; manual reconciliation required',
    );
  }
  return Object.freeze({
    version: 1,
    pid: parsed['pid'],
    nonce: parsed['nonce'],
    runId: parsed['runId'],
    acquiredAtMs: parsed['acquiredAtMs'],
  });
}

function parseMemoryFenceEvictionClaim(parsed: unknown): MemoryFenceEvictionClaimPayload {
  if (
    !isPlainRecord(parsed)
    || parsed['version'] !== 1
    || typeof parsed['pid'] !== 'number'
    || !Number.isSafeInteger(parsed['pid'])
    || parsed['pid'] <= 0
    || typeof parsed['nonce'] !== 'string'
    || !/^[0-9a-f]{24}$/.test(parsed['nonce'])
    || typeof parsed['targetNonce'] !== 'string'
    || !/^[0-9a-f]{24}$/.test(parsed['targetNonce'])
    || typeof parsed['createdAtMs'] !== 'number'
    || !Number.isSafeInteger(parsed['createdAtMs'])
    || parsed['createdAtMs'] < 0
  ) {
    throw new GitHubAppError(
      'ACTION_INPUT_INVALID',
      'corrupt or incomplete memory branch fence eviction claim; manual reconciliation required',
    );
  }
  return Object.freeze({
    version: 1,
    pid: parsed['pid'],
    nonce: parsed['nonce'],
    targetNonce: parsed['targetNonce'],
    createdAtMs: parsed['createdAtMs'],
  });
}

async function withMemoryBranchFenceLock<T>(
  runRoot: string,
  repositoryFullName: string,
  branchName: string,
  runId: string,
  fn: (fencesDir: string, fencePath: string) => Promise<T>,
): Promise<T> {
  const fencesDir = await ensureMemoryFencesDirectory(runRoot, true);
  if (fencesDir === null) {
    throw new GitHubAppError('ACTION_INPUT_INVALID', 'missing memory fences directory');
  }
  const key = memoryBranchFenceKey(repositoryFullName, branchName);
  const fencePath = join(fencesDir, `${key}.json`);
  const lockPath = join(fencesDir, `${key}.lock`);
  const myNonce = randomBytes(12).toString('hex');
  const stagePath = `${lockPath}.stage-${process.pid}-${myNonce}`;

  const stagePayload = Buffer.from(
    `${JSON.stringify({ version: 1, pid: process.pid, nonce: myNonce, runId, acquiredAtMs: Date.now() })}\n`,
    'utf8',
  );
  const stageHandle = await open(
    stagePath,
    fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY | fsConstants.O_NOFOLLOW,
    0o600,
  );
  try {
    await stageHandle.writeFile(stagePayload);
    await stageHandle.sync();
  } finally {
    await stageHandle.close();
  }

  let acquired = false;
  let acquiredIno = -1;
  try {
    for (let attempt = 0; attempt < 50; attempt += 1) {
      const linked = await link(stagePath, lockPath).then(
        () => true,
        (err: NodeJS.ErrnoException) => {
          if (err.code === 'EEXIST') return false;
          throw err;
        },
      );
      if (linked) {
        const linkedStat = await lstat(lockPath);
        if (linkedStat.isSymbolicLink() || !linkedStat.isFile()) {
          throw new GitHubAppError('ACTION_INPUT_INVALID', 'memory branch fence lock must be a regular file');
        }
        acquiredIno = linkedStat.ino;
        acquired = true;
        break;
      }

      // Fail closed on malformed, incomplete, or unreadable lockfiles; never treat unreadable locks as dead!
      const rawExisting = await readRegularJsonFileBounded(lockPath, 4_096, 'memory branch fence lock');
      if (!rawExisting.exists) {
        continue;
      }
      const existingLock = parseMemoryBranchFenceLock(rawExisting.value);
      if (!isProcessAlive(existingLock.pid)) {
        const evictClaimPath = `${lockPath}.evict-${existingLock.nonce}`;
        const evictNonce = randomBytes(12).toString('hex');
        const evictStagePath = `${evictClaimPath}.stage-${process.pid}-${evictNonce}`;
        const evictPayload = Buffer.from(
          `${JSON.stringify({
            version: 1,
            pid: process.pid,
            nonce: evictNonce,
            targetNonce: existingLock.nonce,
            createdAtMs: Date.now(),
          })}\n`,
          'utf8',
        );
        const evictStageHandle = await open(
          evictStagePath,
          fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY | fsConstants.O_NOFOLLOW,
          0o600,
        );
        try {
          await evictStageHandle.writeFile(evictPayload);
          await evictStageHandle.sync();
        } finally {
          await evictStageHandle.close();
        }

        let linkedEvict = false;
        try {
          linkedEvict = await link(evictStagePath, evictClaimPath).then(
            () => true,
            (err: NodeJS.ErrnoException) => {
              if (err.code === 'EEXIST') return false;
              throw err;
            },
          );
        } finally {
          await unlink(evictStagePath).catch(() => undefined);
        }

        if (linkedEvict) {
          const evictStat = await lstat(evictClaimPath).catch(() => null);
          const evictIno = evictStat !== null && !evictStat.isSymbolicLink() && evictStat.isFile()
            ? evictStat.ino
            : -1;
          try {
            const recheckRaw = await readRegularJsonFileBounded(lockPath, 4_096, 'memory branch fence lock');
            if (recheckRaw.exists) {
              const recheckLock = parseMemoryBranchFenceLock(recheckRaw.value);
              if (recheckLock.nonce === existingLock.nonce && !isProcessAlive(recheckLock.pid)) {
                await unlink(lockPath).catch((err: NodeJS.ErrnoException) => {
                  if (err.code !== 'ENOENT') throw err;
                });
              }
            }
          } finally {
            if (evictIno >= 0) {
              const curEvict = await lstat(evictClaimPath).catch(() => null);
              if (curEvict !== null && !curEvict.isSymbolicLink() && curEvict.ino === evictIno) {
                await unlink(evictClaimPath).catch(() => undefined);
              }
            }
          }
          continue;
        }

        // Another evictor created `.evict-<nonce>`. Reclaim safely if its owner died or left an abandoned 0-byte file.
        const existingClaimStat = await lstat(evictClaimPath).catch((err: NodeJS.ErrnoException) => {
          if (err.code === 'ENOENT') return null;
          throw err;
        });
        if (existingClaimStat === null) {
          continue;
        }
        if (existingClaimStat.isSymbolicLink() || !existingClaimStat.isFile() || existingClaimStat.size > 4_096) {
          throw new GitHubAppError(
            'ACTION_INPUT_INVALID',
            'memory branch fence eviction claim must be a bounded regular file',
          );
        }
        if (existingClaimStat.size === 0) {
          if (Date.now() - existingClaimStat.mtimeMs >= 400) {
            const verifyEmpty = await lstat(evictClaimPath).catch(() => null);
            if (
              verifyEmpty !== null
              && !verifyEmpty.isSymbolicLink()
              && verifyEmpty.ino === existingClaimStat.ino
              && verifyEmpty.size === 0
            ) {
              await unlink(evictClaimPath).catch(() => undefined);
              continue;
            }
          }
        } else {
          const claimRaw = await readRegularJsonFileBounded(
            evictClaimPath,
            4_096,
            'memory branch fence eviction claim',
          );
          if (claimRaw.exists) {
            const parsedClaim = parseMemoryFenceEvictionClaim(claimRaw.value);
            if (!isProcessAlive(parsedClaim.pid)) {
              const verifyDead = await lstat(evictClaimPath).catch(() => null);
              if (verifyDead !== null && !verifyDead.isSymbolicLink() && verifyDead.ino === existingClaimStat.ino) {
                await unlink(evictClaimPath).catch(() => undefined);
                continue;
              }
            }
          }
        }
      }
      await new Promise<void>(resolveDelay => setTimeout(resolveDelay, 40));
    }
  } finally {
    await unlink(stagePath).catch(() => undefined);
  }

  if (!acquired) {
    throw new GitHubAppError(
      'ACTION_INPUT_INVALID',
      `another memory publisher holds the active lock for branch "${branchName}"`,
    );
  }

  try {
    return await fn(fencesDir, fencePath);
  } finally {
    const releaseRaw = await readRegularJsonFileBounded(lockPath, 4_096, 'memory branch fence lock').catch(
      () => ({ exists: false as const }),
    );
    if (
      releaseRaw.exists
      && isPlainRecord(releaseRaw.value)
      && releaseRaw.value['pid'] === process.pid
      && releaseRaw.value['nonce'] === myNonce
    ) {
      const curStat = await lstat(lockPath).catch(() => null);
      if (curStat !== null && !curStat.isSymbolicLink() && curStat.ino === acquiredIno) {
        await unlink(lockPath).catch(() => undefined);
      }
    }
  }
}

function parseMemoryBranchFence(parsed: unknown): MemoryBranchPublicationFence {
  if (
    !isPlainRecord(parsed)
    || parsed['version'] !== 1
    || typeof parsed['repository'] !== 'string'
    || typeof parsed['branchName'] !== 'string'
    || typeof parsed['runId'] !== 'string'
    || (parsed['taskpack'] !== undefined && typeof parsed['taskpack'] !== 'string')
    || (parsed['targetBranch'] !== undefined && typeof parsed['targetBranch'] !== 'string')
    || (parsed['directory'] !== undefined && typeof parsed['directory'] !== 'string')
    || (parsed['proposalId'] !== undefined && typeof parsed['proposalId'] !== 'string')
    || (parsed['entryCount'] !== undefined && (typeof parsed['entryCount'] !== 'number' || !Number.isSafeInteger(parsed['entryCount']) || parsed['entryCount'] < 0))
    || (parsed['rebased'] !== undefined && typeof parsed['rebased'] !== 'boolean')
    || (parsed['pullRequestTitle'] !== undefined && typeof parsed['pullRequestTitle'] !== 'string')
    || (parsed['state'] !== 'uncertain' && parsed['state'] !== 'push_only' && parsed['state'] !== 'completed')
    || (parsed['stage'] !== 'push' && parsed['stage'] !== 'pull_request' && parsed['stage'] !== 'reconciled')
    || typeof parsed['headOid'] !== 'string'
    || (parsed['previousConfirmedHeadOid'] !== null && typeof parsed['previousConfirmedHeadOid'] !== 'string')
    || typeof parsed['updatedAtMs'] !== 'number'
  ) {
    throw new GitHubAppError('ACTION_INPUT_INVALID', 'malformed memory branch fence; manual reconciliation required');
  }
  return Object.freeze({
    version: 1,
    repository: parsed['repository'],
    branchName: parsed['branchName'],
    runId: parsed['runId'],
    ...(parsed['taskpack'] !== undefined ? { taskpack: parsed['taskpack'] } : {}),
    ...(parsed['targetBranch'] !== undefined ? { targetBranch: parsed['targetBranch'] } : {}),
    ...(parsed['directory'] !== undefined ? { directory: parsed['directory'] } : {}),
    ...(parsed['proposalId'] !== undefined ? { proposalId: parsed['proposalId'] } : {}),
    ...(parsed['entryCount'] !== undefined ? { entryCount: parsed['entryCount'] } : {}),
    ...(parsed['rebased'] !== undefined ? { rebased: parsed['rebased'] } : {}),
    ...(parsed['pullRequestTitle'] !== undefined ? { pullRequestTitle: parsed['pullRequestTitle'] } : {}),
    state: parsed['state'],
    stage: parsed['stage'],
    headOid: parsed['headOid'],
    previousConfirmedHeadOid: parsed['previousConfirmedHeadOid'],
    updatedAtMs: parsed['updatedAtMs'],
  });
}

async function inspectSiblingMemoryRunJournals(
  runRoot: string,
  repositoryFullName: string,
  branchName: string,
  currentRunId: string,
): Promise<{
  readonly unresolvedOtherRun: { readonly runId: string; readonly reason: string } | null;
  readonly latestPushOnly: { readonly headOid: string; readonly updatedAtMs: number } | null;
  readonly latestConfirmedOtherRun: {
    readonly runId: string;
    readonly state: 'push_only' | 'completed';
    readonly headOid: string;
    readonly updatedAtMs: number;
  } | null;
}> {
  let unresolvedOtherRun: { readonly runId: string; readonly reason: string } | null = null;
  let latestPushOnly: { readonly headOid: string; readonly updatedAtMs: number } | null = null;
  let latestConfirmedOtherRun: {
    readonly runId: string;
    readonly state: 'push_only' | 'completed';
    readonly headOid: string;
    readonly updatedAtMs: number;
  } | null = null;
  const absRoot = await resolveSafeRunRootDirectory(runRoot, false);
  if (absRoot !== null) {
    const dirents = await readdir(absRoot, { withFileTypes: true });
    let scanned = 0;
    for (const dirent of dirents) {
      if (scanned >= 1_024) break;
      if (!dirent.isDirectory() || dirent.isSymbolicLink() || !IDENTIFIER_PATTERN.test(dirent.name) || dirent.name.length > 128) {
        continue;
      }
      scanned += 1;
      const siblingJournal = await readMemoryPublicationJournal(absRoot, dirent.name);
      if (siblingJournal === null) continue;
      if (siblingJournal.branchName !== branchName) continue;
      if (siblingJournal.repository.toLowerCase() !== repositoryFullName.toLowerCase()) continue;
      if (siblingJournal.state === 'uncertain' && dirent.name !== currentRunId && unresolvedOtherRun === null) {
        unresolvedOtherRun = {
          runId: dirent.name,
          reason: `unresolved memory publication from run "${dirent.name}" (${siblingJournal.stage}) on branch "${branchName}"; reconcile before publishing`,
        };
      }
      if (
        siblingJournal.state === 'push_only'
        && siblingJournal.headOid.length > 0
        && (latestPushOnly === null || siblingJournal.updatedAtMs >= latestPushOnly.updatedAtMs)
      ) {
        latestPushOnly = { headOid: siblingJournal.headOid, updatedAtMs: siblingJournal.updatedAtMs };
      }
      if (
        dirent.name !== currentRunId
        && (siblingJournal.state === 'push_only' || siblingJournal.state === 'completed')
        && siblingJournal.headOid.length > 0
        && (latestConfirmedOtherRun === null || siblingJournal.updatedAtMs >= latestConfirmedOtherRun.updatedAtMs)
      ) {
        latestConfirmedOtherRun = {
          runId: dirent.name,
          state: siblingJournal.state,
          headOid: siblingJournal.headOid,
          updatedAtMs: siblingJournal.updatedAtMs,
        };
      }
    }
  }
  return { unresolvedOtherRun, latestPushOnly, latestConfirmedOtherRun };
}

async function inspectMemoryBranchPublicationFence(
  runRoot: string,
  repositoryFullName: string,
  branchName: string,
  currentRunId: string,
): Promise<{
  readonly unresolvedOtherRun: { readonly runId: string; readonly reason: string } | null;
  readonly confirmedPushOnlyHeadOid: string | null;
}> {
  let unresolvedOtherRun: { readonly runId: string; readonly reason: string } | null = null;
  let confirmedPushOnlyHeadOid: string | null = null;
  let latestConfirmedAtMs = -1;

  const fencesDir = await ensureMemoryFencesDirectory(runRoot, false);
  if (fencesDir !== null) {
    const fencePath = join(fencesDir, `${memoryBranchFenceKey(repositoryFullName, branchName)}.json`);
    const rawFence = await readRegularJsonFileBounded(fencePath, 16_384, 'memory branch fence');
    if (rawFence.exists) {
      const fence = parseMemoryBranchFence(rawFence.value);
      if (fence.state === 'uncertain' && fence.runId !== currentRunId) {
        unresolvedOtherRun = {
          runId: fence.runId,
          reason: `unresolved memory publication from run "${fence.runId}" (${fence.stage}) on branch "${branchName}"; reconcile before publishing`,
        };
      }
      if (fence.state === 'push_only' && fence.headOid.length > 0) {
        confirmedPushOnlyHeadOid = fence.headOid;
        latestConfirmedAtMs = fence.updatedAtMs;
      } else if (fence.state === 'uncertain' && fence.previousConfirmedHeadOid !== null && fence.runId === currentRunId) {
        confirmedPushOnlyHeadOid = fence.previousConfirmedHeadOid;
      }
    }
  }

  const siblings = await inspectSiblingMemoryRunJournals(runRoot, repositoryFullName, branchName, currentRunId);
  if (unresolvedOtherRun === null && siblings.unresolvedOtherRun !== null) {
    unresolvedOtherRun = siblings.unresolvedOtherRun;
  }
  if (siblings.latestPushOnly !== null && siblings.latestPushOnly.updatedAtMs >= latestConfirmedAtMs) {
    confirmedPushOnlyHeadOid = siblings.latestPushOnly.headOid;
  }

  return { unresolvedOtherRun, confirmedPushOnlyHeadOid };
}

async function resolveSafeRunDirectoryForJournal(runRoot: string, runId: string): Promise<string | null> {
  if (!IDENTIFIER_PATTERN.test(runId) || runId.length > 128) {
    throw new GitHubAppError('ACTION_INPUT_INVALID', `invalid runId "${runId}" for memory publication journal`);
  }
  const absRoot = await resolveSafeRunRootDirectory(runRoot, false);
  if (absRoot === null) return null;
  const runDir = join(absRoot, runId);
  const runStats = await lstat(runDir).catch((err: NodeJS.ErrnoException) => {
    if (err.code === 'ENOENT') return null;
    throw err;
  });
  if (runStats === null) return null;
  if (runStats.isSymbolicLink() || !runStats.isDirectory()) {
    throw new GitHubAppError('ACTION_INPUT_INVALID', 'run directory must be a non-symlink directory');
  }
  return runDir;
}

export async function readMemoryPublicationJournal(
  runRoot: string,
  runId: string,
): Promise<TurnkeyMemoryPublicationJournal | null> {
  const runDir = await resolveSafeRunDirectoryForJournal(runRoot, runId);
  if (runDir === null) return null;
  const journalPath = join(runDir, MEMORY_PUBLICATION_JOURNAL_FILE);
  const parsedResult = await readRegularJsonFileBounded(journalPath, 65_536, 'memory-publication.json');
  if (!parsedResult.exists) return null;
  const parsed = parsedResult.value;
  if (!isPlainRecord(parsed) || parsed['version'] !== 1) {
    throw new GitHubAppError('ACTION_INPUT_INVALID', 'malformed memory-publication.json; manual reconciliation required');
  }
  const state = parsed['state'];
  const stage = parsed['stage'];
  const status = parsed['status'];
  const rawPushState = parsed['pushState'];
  const rawPullRequestState = parsed['pullRequestState'];
  const derivedPushState: TurnkeyMemoryPublicationJournal['pushState'] =
    rawPushState === 'in_flight' || rawPushState === 'committed' || rawPushState === 'not_executed'
      ? rawPushState
      : state === 'completed' || state === 'push_only' || stage === 'pull_request'
        ? 'committed'
        : 'in_flight';
  const derivedPrState: TurnkeyMemoryPublicationJournal['pullRequestState'] =
    rawPullRequestState === 'not_started'
    || rawPullRequestState === 'in_flight'
    || rawPullRequestState === 'committed'
    || rawPullRequestState === 'not_executed'
      ? rawPullRequestState
      : state === 'completed'
        ? 'committed'
        : state === 'push_only'
          ? 'not_executed'
          : stage === 'pull_request'
            ? 'in_flight'
            : 'not_started';
  if (
    (state !== 'uncertain' && state !== 'push_only' && state !== 'completed')
    || (stage !== 'push' && stage !== 'pull_request' && stage !== 'reconciled')
    || (status !== 'published' && status !== 'updated' && status !== 'reconcile_required' && status !== 'skipped')
    || (rawPushState !== undefined && rawPushState !== 'in_flight' && rawPushState !== 'committed' && rawPushState !== 'not_executed')
    || (rawPullRequestState !== undefined
      && rawPullRequestState !== 'not_started'
      && rawPullRequestState !== 'in_flight'
      && rawPullRequestState !== 'committed'
      && rawPullRequestState !== 'not_executed')
    || typeof parsed['repository'] !== 'string'
    || parsed['repository'].length === 0
    || typeof parsed['taskpack'] !== 'string'
    || parsed['taskpack'].length === 0
    || typeof parsed['targetBranch'] !== 'string'
    || parsed['targetBranch'].length === 0
    || typeof parsed['directory'] !== 'string'
    || typeof parsed['proposalId'] !== 'string'
    || typeof parsed['entryCount'] !== 'number'
    || !Number.isSafeInteger(parsed['entryCount'])
    || typeof parsed['rebased'] !== 'boolean'
    || typeof parsed['branchName'] !== 'string'
    || typeof parsed['headOid'] !== 'string'
    || typeof parsed['expectedRemoteOid'] !== 'string'
    || (parsed['attemptNonce'] !== undefined && (typeof parsed['attemptNonce'] !== 'string' || !/^[0-9a-f]{24}$/.test(parsed['attemptNonce'])))
    || (parsed['pullRequestTitle'] !== undefined && typeof parsed['pullRequestTitle'] !== 'string')
    || (parsed['pullRequestBody'] !== undefined && typeof parsed['pullRequestBody'] !== 'string')
    || (parsed['pullRequestUrl'] !== null && typeof parsed['pullRequestUrl'] !== 'string')
    || (parsed['pullRequestNumber'] !== null && (typeof parsed['pullRequestNumber'] !== 'number' || !Number.isSafeInteger(parsed['pullRequestNumber'])))
    || (parsed['reason'] !== null && typeof parsed['reason'] !== 'string')
    || typeof parsed['updatedAtMs'] !== 'number'
  ) {
    throw new GitHubAppError('ACTION_INPUT_INVALID', 'malformed memory-publication.json; manual reconciliation required');
  }
  return Object.freeze({
    version: 1,
    state,
    stage,
    pushState: derivedPushState,
    pullRequestState: derivedPrState,
    status,
    repository: parsed['repository'],
    taskpack: parsed['taskpack'],
    targetBranch: parsed['targetBranch'],
    directory: parsed['directory'],
    proposalId: parsed['proposalId'],
    entryCount: parsed['entryCount'],
    rebased: parsed['rebased'],
    branchName: parsed['branchName'],
    headOid: parsed['headOid'],
    expectedRemoteOid: parsed['expectedRemoteOid'],
    ...(parsed['attemptNonce'] !== undefined ? { attemptNonce: parsed['attemptNonce'] } : {}),
    ...(parsed['pullRequestTitle'] !== undefined ? { pullRequestTitle: parsed['pullRequestTitle'] } : {}),
    ...(parsed['pullRequestBody'] !== undefined ? { pullRequestBody: parsed['pullRequestBody'] } : {}),
    pullRequestUrl: parsed['pullRequestUrl'],
    pullRequestNumber: parsed['pullRequestNumber'],
    reason: parsed['reason'],
    updatedAtMs: parsed['updatedAtMs'],
  });
}

function sanitizeJournalRecord(
  journal: TurnkeyMemoryPublicationJournal,
  scrubber: SecretScrubber,
): TurnkeyMemoryPublicationJournal {
  return {
    ...journal,
    repository: scrubber.scrub(journal.repository),
    taskpack: scrubber.scrub(journal.taskpack),
    targetBranch: scrubber.scrub(journal.targetBranch),
    directory: scrubber.scrub(journal.directory),
    proposalId: scrubber.scrub(journal.proposalId),
    branchName: scrubber.scrub(journal.branchName),
    ...(journal.pullRequestTitle !== undefined ? { pullRequestTitle: scrubber.scrub(journal.pullRequestTitle) } : {}),
    ...(journal.pullRequestBody !== undefined ? { pullRequestBody: scrubber.scrub(journal.pullRequestBody) } : {}),
    pullRequestUrl: journal.pullRequestUrl !== null ? scrubber.scrub(journal.pullRequestUrl) : null,
    reason: journal.reason !== null
      ? truncateCodePoints(
        sanitizeReportText(journal.reason, { scrub: text => scrubber.scrub(text), singleLine: true }),
        MAX_REASON_CODEPOINTS,
      )
      : null,
  };
}

async function writeFenceAndJournalUnlocked(
  runRoot: string,
  runId: string,
  fencePath: string,
  existingFence: MemoryBranchPublicationFence | null,
  journal: TurnkeyMemoryPublicationJournal,
  scrubber: SecretScrubber,
  options?: { readonly updateFence?: boolean },
): Promise<void> {
  const runDir = await resolveSafeRunDirectoryForJournal(runRoot, runId);
  if (runDir === null) {
    throw new GitHubAppError('ACTION_INPUT_INVALID', `missing run directory for "${runId}"`);
  }
  const sanitized = sanitizeJournalRecord(journal, scrubber);
  const journalBytes = Buffer.from(`${JSON.stringify(sanitized, null, 2)}\n`, 'utf8');
  assertCleanArtifact(journalBytes, scrubber, `/${MEMORY_PUBLICATION_JOURNAL_FILE}`);

  // Always persist and directory-fsync the per-run journal BEFORE updating the branch fence
  // so a failed journal write never leaves an unreconcilable orphan fence behind.
  await writeAtomicPrivateFile(join(runDir, MEMORY_PUBLICATION_JOURNAL_FILE), journalBytes, MEMORY_PUBLICATION_JOURNAL_FILE);

  if (options?.updateFence !== false) {
    const previousConfirmedHeadOid = existingFence !== null
      ? (existingFence.state === 'push_only' || existingFence.state === 'completed'
        ? existingFence.headOid
        : existingFence.previousConfirmedHeadOid)
      : null;
    const fenceRecord: MemoryBranchPublicationFence = {
      version: 1,
      repository: sanitized.repository,
      branchName: sanitized.branchName,
      runId,
      taskpack: sanitized.taskpack,
      targetBranch: sanitized.targetBranch,
      directory: sanitized.directory,
      proposalId: sanitized.proposalId,
      entryCount: sanitized.entryCount,
      rebased: sanitized.rebased,
      ...(sanitized.pullRequestTitle !== undefined ? { pullRequestTitle: sanitized.pullRequestTitle } : {}),
      state: sanitized.state,
      stage: sanitized.stage,
      headOid: sanitized.headOid,
      previousConfirmedHeadOid,
      updatedAtMs: sanitized.updatedAtMs,
    };
    const fenceBytes = Buffer.from(`${JSON.stringify(fenceRecord, null, 2)}\n`, 'utf8');
    assertCleanArtifact(fenceBytes, scrubber, `/${MEMORY_PUBLICATION_FENCES_DIR}/fence.json`);
    await writeAtomicPrivateFile(fencePath, fenceBytes, 'memory branch fence');
  }
}

async function clearFenceAndDeleteJournalUnlocked(
  runRoot: string,
  runId: string,
  fencePath: string,
  existingFence: MemoryBranchPublicationFence | null,
  scrubber: SecretScrubber,
  nowMs: number,
): Promise<void> {
  await deleteMemoryPublicationJournal(runRoot, runId);
  if (existingFence !== null && existingFence.runId === runId) {
    if (existingFence.previousConfirmedHeadOid !== null && existingFence.previousConfirmedHeadOid.length > 0) {
      const restored: MemoryBranchPublicationFence = {
        version: 1,
        repository: existingFence.repository,
        branchName: existingFence.branchName,
        runId: existingFence.runId,
        ...(existingFence.taskpack !== undefined ? { taskpack: existingFence.taskpack } : {}),
        ...(existingFence.targetBranch !== undefined ? { targetBranch: existingFence.targetBranch } : {}),
        ...(existingFence.directory !== undefined ? { directory: existingFence.directory } : {}),
        ...(existingFence.proposalId !== undefined ? { proposalId: existingFence.proposalId } : {}),
        ...(existingFence.entryCount !== undefined ? { entryCount: existingFence.entryCount } : {}),
        ...(existingFence.rebased !== undefined ? { rebased: existingFence.rebased } : {}),
        ...(existingFence.pullRequestTitle !== undefined ? { pullRequestTitle: existingFence.pullRequestTitle } : {}),
        state: 'push_only',
        stage: 'reconciled',
        headOid: existingFence.previousConfirmedHeadOid,
        previousConfirmedHeadOid: existingFence.previousConfirmedHeadOid,
        updatedAtMs: nowMs,
      };
      const bytes = Buffer.from(`${JSON.stringify(restored, null, 2)}\n`, 'utf8');
      assertCleanArtifact(bytes, scrubber, `/${MEMORY_PUBLICATION_FENCES_DIR}/fence.json`);
      await writeAtomicPrivateFile(fencePath, bytes, 'memory branch fence');
    } else {
      let unlinked = false;
      await unlink(fencePath).then(
        () => {
          unlinked = true;
        },
        () => undefined,
      );
      if (unlinked) {
        await syncDirectoryDurable(dirname(fencePath));
      }
    }
  }
}

async function deleteMemoryPublicationJournal(runRoot: string, runId: string): Promise<void> {
  const runDir = await resolveSafeRunDirectoryForJournal(runRoot, runId);
  if (runDir === null) return;
  const targetPath = join(runDir, MEMORY_PUBLICATION_JOURNAL_FILE);
  const stats = await lstat(targetPath).catch((err: NodeJS.ErrnoException) => {
    if (err.code === 'ENOENT') return null;
    throw err;
  });
  if (stats === null) return;
  if (stats.isSymbolicLink()) {
    throw new GitHubAppError('ACTION_INPUT_INVALID', 'refusing to unlink symlinked memory-publication.json');
  }
  await unlink(targetPath);
  await syncDirectoryDurable(runDir);
}

async function findOrphanMemoryBranchFenceForRun(
  runRoot: string,
  runId: string,
): Promise<MemoryBranchPublicationFence | null> {
  const fencesDir = await ensureMemoryFencesDirectory(runRoot, false);
  if (fencesDir === null) return null;
  const dirents = await readdir(fencesDir, { withFileTypes: true });
  let scanned = 0;
  for (const dirent of dirents) {
    if (scanned >= 1_024) break;
    if (!dirent.isFile() || dirent.isSymbolicLink() || !dirent.name.endsWith('.json')) {
      continue;
    }
    scanned += 1;
    const raw = await readRegularJsonFileBounded(join(fencesDir, dirent.name), 16_384, 'memory branch fence');
    if (!raw.exists) continue;
    const parsed = parseMemoryBranchFence(raw.value);
    if (parsed.runId === runId) {
      return parsed;
    }
  }
  return null;
}

function resolveOrphanFenceMetadata(
  existingFence: MemoryBranchPublicationFence,
  options: ReconcileTurnkeyMemoryPublicationOptions,
  requireVerifiedDirectory: boolean,
): {
  readonly taskpack: string;
  readonly targetBranch: string;
  readonly directory: string;
  readonly proposalId: string;
  readonly entryCount: number;
  readonly rebased: boolean;
  readonly pullRequestTitle?: string | undefined;
} {
  let branchTaskpack: string | null = null;
  let branchTarget: string | null = null;
  const prefix = 'loopwright/memory/';
  if (existingFence.branchName.startsWith(prefix)) {
    const rest = existingFence.branchName.slice(prefix.length);
    const slashIdx = rest.indexOf('/');
    if (slashIdx > 0 && slashIdx < rest.length - 1) {
      branchTaskpack = rest.slice(0, slashIdx);
      branchTarget = rest.slice(slashIdx + 1);
    }
  }

  if (
    existingFence.taskpack !== undefined
    && options.taskpack !== undefined
    && existingFence.taskpack !== options.taskpack
  ) {
    throw new GitHubAppError(
      'ACTION_INPUT_INVALID',
      `orphan fence taskpack "${existingFence.taskpack}" does not match "${options.taskpack}"`,
    );
  }
  if (
    existingFence.targetBranch !== undefined
    && options.targetBranch !== undefined
    && existingFence.targetBranch !== options.targetBranch
  ) {
    throw new GitHubAppError(
      'ACTION_INPUT_INVALID',
      `orphan fence targetBranch "${existingFence.targetBranch}" does not match "${options.targetBranch}"`,
    );
  }
  if (
    existingFence.directory !== undefined
    && options.directory !== undefined
    && existingFence.directory !== options.directory
  ) {
    throw new GitHubAppError(
      'ACTION_INPUT_INVALID',
      `orphan fence directory "${existingFence.directory}" does not match "${options.directory}"`,
    );
  }

  const taskpack = existingFence.taskpack ?? options.taskpack ?? branchTaskpack ?? 'unknown';
  const targetBranch = existingFence.targetBranch ?? options.targetBranch ?? branchTarget ?? 'main';
  if (branchTaskpack !== null && taskpack !== branchTaskpack) {
    throw new GitHubAppError(
      'ACTION_INPUT_INVALID',
      `orphan fence taskpack "${taskpack}" does not match branch "${existingFence.branchName}"`,
    );
  }
  if (branchTarget !== null && targetBranch !== branchTarget) {
    throw new GitHubAppError(
      'ACTION_INPUT_INVALID',
      `orphan fence targetBranch "${targetBranch}" does not match branch "${existingFence.branchName}"`,
    );
  }

  const explicitDirectory = existingFence.directory ?? options.directory ?? null;
  if (explicitDirectory !== null) {
    if (!memoryIdentifierPattern.test(taskpack) || taskpack.length > 128) {
      throw new GitHubAppError('ACTION_INPUT_INVALID', `invalid orphan fence taskpack "${taskpack}"`);
    }
    const expectedSuffix = `/${taskpack}`;
    if (!explicitDirectory.endsWith(expectedSuffix) || explicitDirectory.length <= expectedSuffix.length) {
      throw new GitHubAppError(
        'ACTION_INPUT_INVALID',
        `orphan fence directory "${explicitDirectory}" must end with "/${taskpack}"`,
      );
    }
    let validatedDirectory: string;
    try {
      const rootPart = normalizeMemoryRoot(explicitDirectory.slice(0, explicitDirectory.length - expectedSuffix.length));
      validatedDirectory = memoryDirectoryFor(taskpack, rootPart);
    } catch {
      throw new GitHubAppError('ACTION_INPUT_INVALID', `invalid orphan fence directory "${explicitDirectory}"`);
    }
    if (validatedDirectory !== explicitDirectory) {
      throw new GitHubAppError('ACTION_INPUT_INVALID', `non-canonical orphan fence directory "${explicitDirectory}"`);
    }
    return {
      taskpack,
      targetBranch,
      directory: validatedDirectory,
      proposalId: existingFence.proposalId ?? 'reconciled-orphan-fence',
      entryCount: existingFence.entryCount ?? 0,
      rebased: existingFence.rebased ?? false,
      ...(existingFence.pullRequestTitle !== undefined ? { pullRequestTitle: existingFence.pullRequestTitle } : {}),
    };
  }

  if (requireVerifiedDirectory) {
    throw new GitHubAppError(
      'ACTION_INPUT_INVALID',
      `orphan memory branch fence for run "${options.runId}" lacks verified directory metadata; pass options.directory to reconcile`,
    );
  }

  return {
    taskpack,
    targetBranch,
    directory: taskpack !== 'unknown' ? `.loopwright/memory/${taskpack}` : '.loopwright/memory',
    proposalId: existingFence.proposalId ?? 'reconciled-orphan-fence',
    entryCount: existingFence.entryCount ?? 0,
    rebased: existingFence.rebased ?? false,
    ...(existingFence.pullRequestTitle !== undefined ? { pullRequestTitle: existingFence.pullRequestTitle } : {}),
  };
}

function validateJournalBindingsMatchCurrent(
  journal: TurnkeyMemoryPublicationJournal,
  expected: {
    readonly repositoryFullName: string;
    readonly taskpack: string;
    readonly targetBranch: string;
    readonly memoryDirectory: string;
    readonly memoryBranch: string;
  },
): string | null {
  if (journal.repository.toLowerCase() !== expected.repositoryFullName.toLowerCase()) {
    return `MEMORY_SCOPE_VIOLATION: staged memory publication repository "${journal.repository}" does not match "${expected.repositoryFullName}"`;
  }
  if (journal.taskpack !== expected.taskpack) {
    return `MEMORY_SCOPE_VIOLATION: staged memory publication taskpack "${journal.taskpack}" does not match "${expected.taskpack}"`;
  }
  if (journal.targetBranch !== expected.targetBranch) {
    return `MEMORY_SCOPE_VIOLATION: staged memory publication targetBranch "${journal.targetBranch}" does not match "${expected.targetBranch}"`;
  }
  if (journal.directory !== expected.memoryDirectory) {
    return `MEMORY_SCOPE_VIOLATION: staged memory publication directory "${journal.directory}" does not match "${expected.memoryDirectory}"`;
  }
  if (journal.branchName !== expected.memoryBranch) {
    return `MEMORY_SCOPE_VIOLATION: staged memory publication branch "${journal.branchName}" does not match "${expected.memoryBranch}"`;
  }
  return null;
}

type ClaimPublicationResult =
  | { readonly claimed: true; readonly attemptNonce: string }
  | { readonly claimed: false; readonly summary: TurnkeyMemorySummary };

async function claimMemoryPublicationAttemptUnderLock(options: {
  readonly mode: 'fresh_push' | 'replay_push_only' | 'advance_push_to_pr';
  readonly runRoot: string;
  readonly runId: string;
  readonly existingAttemptNonce?: string | undefined;
  readonly draftJournal: Omit<TurnkeyMemoryPublicationJournal, 'attemptNonce'>;
  readonly scrubber: SecretScrubber;
  readonly verifyUnderLock?: (() => Promise<TurnkeyMemorySummary | null>) | undefined;
}): Promise<ClaimPublicationResult> {
  const { mode, runRoot, runId, existingAttemptNonce, draftJournal, scrubber, verifyUnderLock } = options;
  return await withMemoryBranchFenceLock(
    runRoot,
    draftJournal.repository,
    draftJournal.branchName,
    runId,
    async (_fencesDir, fencePath) => {
      const existingRaw = await readRegularJsonFileBounded(fencePath, 16_384, 'memory branch fence');
      const existingFence = existingRaw.exists ? parseMemoryBranchFence(existingRaw.value) : null;
      const currentJournal = await readMemoryPublicationJournal(runRoot, runId);
      const siblings = await inspectSiblingMemoryRunJournals(
        runRoot,
        draftJournal.repository,
        draftJournal.branchName,
        runId,
      );

      const makeReconcileSummary = (reason: string): TurnkeyMemorySummary => Object.freeze({
        status: 'reconcile_required',
        directory: draftJournal.directory,
        proposalId: currentJournal?.proposalId ?? draftJournal.proposalId,
        entryCount: currentJournal?.entryCount ?? draftJournal.entryCount,
        rebased: currentJournal?.rebased ?? draftJournal.rebased,
        branchName: draftJournal.branchName,
        pullRequestUrl: currentJournal?.pullRequestUrl ?? draftJournal.pullRequestUrl,
        pullRequestNumber: currentJournal?.pullRequestNumber ?? draftJournal.pullRequestNumber,
        reason: truncateCodePoints(
          sanitizeReportText(reason, { scrub: text => scrubber.scrub(text), singleLine: true }),
          MAX_REASON_CODEPOINTS,
        ),
      });

      const makeRefusedSummary = (reason: string): TurnkeyMemorySummary => Object.freeze({
        status: 'refused',
        directory: draftJournal.directory,
        proposalId: currentJournal?.proposalId ?? draftJournal.proposalId,
        entryCount: 0,
        rebased: currentJournal?.rebased ?? draftJournal.rebased,
        branchName: draftJournal.branchName,
        pullRequestUrl: currentJournal?.pullRequestUrl ?? draftJournal.pullRequestUrl,
        pullRequestNumber: currentJournal?.pullRequestNumber ?? draftJournal.pullRequestNumber,
        reason: truncateCodePoints(
          sanitizeReportText(reason, { scrub: text => scrubber.scrub(text), singleLine: true }),
          MAX_REASON_CODEPOINTS,
        ),
      });

      if (currentJournal?.state === 'completed') {
        return {
          claimed: false,
          summary: Object.freeze({
            status: currentJournal.status === 'updated' ? 'updated' : 'published',
            directory: currentJournal.directory,
            proposalId: currentJournal.proposalId,
            entryCount: currentJournal.entryCount,
            rebased: currentJournal.rebased,
            branchName: currentJournal.branchName,
            pullRequestUrl: currentJournal.pullRequestUrl,
            pullRequestNumber: currentJournal.pullRequestNumber,
            reason: null,
          }),
        };
      }

      if (siblings.unresolvedOtherRun !== null) {
        return { claimed: false, summary: makeReconcileSummary(siblings.unresolvedOtherRun.reason) };
      }

      if (mode === 'fresh_push') {
        if (currentJournal !== null) {
          return {
            claimed: false,
            summary: makeReconcileSummary(
              currentJournal.reason ?? 'memory publication already active or unresolved for this run; reconcile before publishing',
            ),
          };
        }
        if (existingFence !== null && existingFence.state === 'uncertain') {
          return {
            claimed: false,
            summary: makeReconcileSummary(
              `unresolved memory publication from run "${existingFence.runId}" (${existingFence.stage}) on branch "${draftJournal.branchName}"; reconcile before publishing`,
            ),
          };
        }
      } else if (mode === 'replay_push_only') {
        if (
          currentJournal === null
          || currentJournal.state !== 'push_only'
          || currentJournal.headOid !== draftJournal.headOid
        ) {
          return {
            claimed: false,
            summary: makeReconcileSummary(
              currentJournal?.reason ?? 'concurrent memory publication recovery already in flight or state changed; reconcile before replaying',
            ),
          };
        }
        if (existingFence !== null && existingFence.state === 'uncertain') {
          return {
            claimed: false,
            summary: makeReconcileSummary(
              `unresolved memory publication from run "${existingFence.runId}" (${existingFence.stage}) on branch "${draftJournal.branchName}"; reconcile before replaying`,
            ),
          };
        }
        if (
          existingFence !== null
          && (
            existingFence.headOid.toLowerCase() !== draftJournal.headOid.toLowerCase()
            || existingFence.state === 'completed'
          )
        ) {
          return {
            claimed: false,
            summary: makeRefusedSummary(
              `MEMORY_CAS_CONFLICT: memory branch "${draftJournal.branchName}" already advanced beyond recovery head`,
            ),
          };
        }
        if (
          siblings.latestConfirmedOtherRun !== null
          && (
            (siblings.latestConfirmedOtherRun.updatedAtMs > currentJournal.updatedAtMs
              && siblings.latestConfirmedOtherRun.headOid.toLowerCase() !== draftJournal.headOid.toLowerCase())
            || (siblings.latestConfirmedOtherRun.state === 'completed'
              && siblings.latestConfirmedOtherRun.headOid.toLowerCase() === draftJournal.headOid.toLowerCase())
          )
        ) {
          return {
            claimed: false,
            summary: makeRefusedSummary(
              `MEMORY_CAS_CONFLICT: memory branch "${draftJournal.branchName}" already superseded by run "${siblings.latestConfirmedOtherRun.runId}"`,
            ),
          };
        }
      } else {
        if (
          currentJournal === null
          || currentJournal.state !== 'uncertain'
          || currentJournal.stage !== 'push'
          || existingAttemptNonce === undefined
          || currentJournal.attemptNonce !== existingAttemptNonce
        ) {
          return {
            claimed: false,
            summary: makeReconcileSummary(
              'memory publication journal changed unexpectedly after branch push; reconcile before continuing',
            ),
          };
        }
      }

      if (verifyUnderLock !== undefined) {
        const refusal = await verifyUnderLock();
        if (refusal !== null) {
          return { claimed: false, summary: refusal };
        }
      }

      const attemptNonce = mode === 'advance_push_to_pr' && existingAttemptNonce !== undefined
        ? existingAttemptNonce
        : randomBytes(12).toString('hex');

      try {
        await writeFenceAndJournalUnlocked(
          runRoot,
          runId,
          fencePath,
          existingFence,
          { ...draftJournal, attemptNonce },
          scrubber,
        );
      } catch (writeErr) {
        // Pre-dispatch write failure (`fresh_push` or `replay_push_only`): roll back partial local
        // artifacts because no external git push or GitHub API call has been dispatched yet.
        if (mode === 'fresh_push') {
          await deleteMemoryPublicationJournal(runRoot, runId).catch(() => undefined);
          if (existingFence !== null) {
            const restoreBytes = Buffer.from(`${JSON.stringify(existingFence, null, 2)}\n`, 'utf8');
            await writeAtomicPrivateFile(fencePath, restoreBytes, 'memory branch fence').catch(() => undefined);
          } else {
            await unlink(fencePath).catch(() => undefined);
          }
        } else if (mode === 'replay_push_only' && currentJournal !== null) {
          const runDir = await resolveSafeRunDirectoryForJournal(runRoot, runId).catch(() => null);
          if (runDir !== null) {
            const restoreJournalBytes = Buffer.from(`${JSON.stringify(currentJournal, null, 2)}\n`, 'utf8');
            await writeAtomicPrivateFile(
              join(runDir, MEMORY_PUBLICATION_JOURNAL_FILE),
              restoreJournalBytes,
              MEMORY_PUBLICATION_JOURNAL_FILE,
            ).catch(() => undefined);
          }
          if (existingFence !== null) {
            const restoreFenceBytes = Buffer.from(`${JSON.stringify(existingFence, null, 2)}\n`, 'utf8');
            await writeAtomicPrivateFile(fencePath, restoreFenceBytes, 'memory branch fence').catch(() => undefined);
          }
        }
        throw writeErr;
      }
      return { claimed: true, attemptNonce };
    },
  );
}

async function settleMemoryPublicationAttemptUnderLock(options: {
  readonly runRoot: string;
  readonly runId: string;
  readonly attemptNonce: string;
  readonly action:
    | { readonly kind: 'write'; readonly journal: Omit<TurnkeyMemoryPublicationJournal, 'attemptNonce'> }
    | { readonly kind: 'rollback_stale_push'; readonly repository: string; readonly branchName: string; readonly nowMs: number };
  readonly scrubber: SecretScrubber;
}): Promise<void> {
  const { runRoot, runId, attemptNonce, action, scrubber } = options;
  const repo = action.kind === 'write' ? action.journal.repository : action.repository;
  const branch = action.kind === 'write' ? action.journal.branchName : action.branchName;
  await withMemoryBranchFenceLock(runRoot, repo, branch, runId, async (_fencesDir, fencePath) => {
    const existingRaw = await readRegularJsonFileBounded(fencePath, 16_384, 'memory branch fence');
    const existingFence = existingRaw.exists ? parseMemoryBranchFence(existingRaw.value) : null;
    const currentJournal = await readMemoryPublicationJournal(runRoot, runId);
    if (
      currentJournal === null
      || currentJournal.state !== 'uncertain'
      || currentJournal.attemptNonce !== attemptNonce
    ) {
      return;
    }
    if (action.kind === 'rollback_stale_push') {
      await clearFenceAndDeleteJournalUnlocked(runRoot, runId, fencePath, existingFence, scrubber, action.nowMs);
      return;
    }
    await writeFenceAndJournalUnlocked(
      runRoot,
      runId,
      fencePath,
      existingFence,
      action.journal.state === 'completed'
        ? action.journal
        : { ...action.journal, attemptNonce },
      scrubber,
      { updateFence: existingFence === null || existingFence.runId === runId },
    );
  });
}

export async function reconcileTurnkeyMemoryPublication(
  options: ReconcileTurnkeyMemoryPublicationOptions,
): Promise<TurnkeyMemorySummary> {
  const scrubber = options.scrubber ?? new SecretScrubber();
  const effectiveNowMs = options.nowMs ?? Date.now();
  if (
    options.outcome === 'confirmed'
    && (
      typeof options.pullRequestNumber !== 'number'
      || !Number.isSafeInteger(options.pullRequestNumber)
      || options.pullRequestNumber <= 0
      || typeof options.pullRequestUrl !== 'string'
      || options.pullRequestUrl.trim().length === 0
    )
  ) {
    throw new GitHubAppError(
      'ACTION_INPUT_INVALID',
      'confirmed memory publication reconciliation requires positive pullRequestNumber and non-empty pullRequestUrl',
    );
  }

  const initialJournal = await readMemoryPublicationJournal(options.runRoot, options.runId);
  const orphanFence = initialJournal === null
    ? await findOrphanMemoryBranchFenceForRun(options.runRoot, options.runId)
    : null;
  if (initialJournal === null && orphanFence === null) {
    throw new GitHubAppError('ACTION_INPUT_INVALID', `no memory publication journal found for run "${options.runId}"`);
  }

  const lockRepository = initialJournal?.repository ?? orphanFence!.repository;
  const lockBranchName = initialJournal?.branchName ?? orphanFence!.branchName;

  return await withMemoryBranchFenceLock(
    options.runRoot,
    lockRepository,
    lockBranchName,
    options.runId,
    async (_fencesDir, fencePath) => {
      const existingRaw = await readRegularJsonFileBounded(fencePath, 16_384, 'memory branch fence');
      const existingFence = existingRaw.exists ? parseMemoryBranchFence(existingRaw.value) : null;
      const journal = await readMemoryPublicationJournal(options.runRoot, options.runId);

      // Orphan fence recovery path: fence exists for `options.runId`, but per-run journal is missing.
      if (journal === null) {
        if (existingFence === null || existingFence.runId !== options.runId) {
          throw new GitHubAppError('ACTION_INPUT_INVALID', `no memory publication journal found for run "${options.runId}"`);
        }
        const synthesizesReplayJournal =
          options.outcome === 'push_only'
          || options.outcome === 'confirmed'
          || (options.outcome === 'not_executed' && existingFence.stage === 'pull_request');
        const inferred = resolveOrphanFenceMetadata(existingFence, options, synthesizesReplayJournal);
        if (
          options.outcome === 'push_only'
          || (options.outcome === 'not_executed' && existingFence.stage === 'pull_request')
        ) {
          const retainedReason = options.outcome === 'push_only'
            ? 'memory branch push confirmed; pull request creation/update pending replay'
            : 'memory pull request reconciled as not_executed; pushed branch head retained for replay';
          const updatedFence: MemoryBranchPublicationFence = {
            version: 1,
            repository: existingFence.repository,
            branchName: existingFence.branchName,
            runId: existingFence.runId,
            taskpack: inferred.taskpack,
            targetBranch: inferred.targetBranch,
            directory: inferred.directory,
            proposalId: inferred.proposalId,
            entryCount: inferred.entryCount,
            rebased: inferred.rebased,
            ...(inferred.pullRequestTitle !== undefined ? { pullRequestTitle: inferred.pullRequestTitle } : {}),
            state: 'push_only',
            stage: 'reconciled',
            headOid: existingFence.headOid,
            previousConfirmedHeadOid: existingFence.previousConfirmedHeadOid,
            updatedAtMs: effectiveNowMs,
          };
          const fenceBytes = Buffer.from(`${JSON.stringify(updatedFence, null, 2)}\n`, 'utf8');
          assertCleanArtifact(fenceBytes, scrubber, `/${MEMORY_PUBLICATION_FENCES_DIR}/fence.json`);
          await writeAtomicPrivateFile(fencePath, fenceBytes, 'memory branch fence');
          const runDir = await resolveSafeRunDirectoryForJournal(options.runRoot, options.runId);
          if (runDir !== null) {
            const synthesizedJournal = sanitizeJournalRecord(
              {
                version: 1,
                repository: existingFence.repository,
                taskpack: inferred.taskpack,
                targetBranch: inferred.targetBranch,
                directory: inferred.directory,
                branchName: existingFence.branchName,
                proposalId: inferred.proposalId,
                entryCount: inferred.entryCount,
                rebased: inferred.rebased,
                ...(inferred.pullRequestTitle !== undefined ? { pullRequestTitle: inferred.pullRequestTitle } : {}),
                headOid: existingFence.headOid,
                expectedRemoteOid: existingFence.previousConfirmedHeadOid ?? '',
                state: 'push_only',
                stage: 'reconciled',
                pushState: 'committed',
                pullRequestState: 'not_executed',
                status: 'skipped',
                pullRequestUrl: null,
                pullRequestNumber: null,
                reason: retainedReason,
                updatedAtMs: effectiveNowMs,
              },
              scrubber,
            );
            const journalBytes = Buffer.from(`${JSON.stringify(synthesizedJournal, null, 2)}\n`, 'utf8');
            assertCleanArtifact(journalBytes, scrubber, `/${MEMORY_PUBLICATION_JOURNAL_FILE}`);
            await writeAtomicPrivateFile(
              join(runDir, MEMORY_PUBLICATION_JOURNAL_FILE),
              journalBytes,
              MEMORY_PUBLICATION_JOURNAL_FILE,
            );
          }
          return Object.freeze({
            status: 'skipped',
            directory: inferred.directory,
            proposalId: inferred.proposalId,
            entryCount: inferred.entryCount,
            rebased: inferred.rebased,
            branchName: existingFence.branchName,
            pullRequestUrl: null,
            pullRequestNumber: null,
            reason: retainedReason,
          });
        }

        if (options.outcome === 'not_executed') {
          await clearFenceAndDeleteJournalUnlocked(
            options.runRoot,
            options.runId,
            fencePath,
            existingFence,
            scrubber,
            effectiveNowMs,
          );
          return Object.freeze({
            status: 'skipped',
            directory: inferred.directory,
            proposalId: null,
            entryCount: 0,
            rebased: false,
            branchName: null,
            pullRequestUrl: null,
            pullRequestNumber: null,
            reason: 'memory publication reconciled as not_executed',
          });
        }

        const resolvedStatus = options.isUpdate === true ? 'updated' : 'published';
        const cleanUrl = scrubber.scrub(options.pullRequestUrl!.trim());
        const settledFence: MemoryBranchPublicationFence = {
          version: 1,
          repository: existingFence.repository,
          branchName: existingFence.branchName,
          runId: existingFence.runId,
          taskpack: inferred.taskpack,
          targetBranch: inferred.targetBranch,
          directory: inferred.directory,
          proposalId: inferred.proposalId,
          entryCount: inferred.entryCount,
          rebased: inferred.rebased,
          ...(inferred.pullRequestTitle !== undefined ? { pullRequestTitle: inferred.pullRequestTitle } : {}),
          state: 'completed',
          stage: 'reconciled',
          headOid: existingFence.headOid,
          previousConfirmedHeadOid: existingFence.previousConfirmedHeadOid,
          updatedAtMs: effectiveNowMs,
        };
        const fenceBytes = Buffer.from(`${JSON.stringify(settledFence, null, 2)}\n`, 'utf8');
        assertCleanArtifact(fenceBytes, scrubber, `/${MEMORY_PUBLICATION_FENCES_DIR}/fence.json`);
        await writeAtomicPrivateFile(fencePath, fenceBytes, 'memory branch fence');
        const runDir = await resolveSafeRunDirectoryForJournal(options.runRoot, options.runId);
        if (runDir !== null) {
          const synthesizedCompleted = sanitizeJournalRecord(
            {
              version: 1,
              repository: existingFence.repository,
              taskpack: inferred.taskpack,
              targetBranch: inferred.targetBranch,
              directory: inferred.directory,
              branchName: existingFence.branchName,
              proposalId: inferred.proposalId,
              entryCount: inferred.entryCount,
              rebased: inferred.rebased,
              ...(inferred.pullRequestTitle !== undefined ? { pullRequestTitle: inferred.pullRequestTitle } : {}),
              headOid: existingFence.headOid,
              expectedRemoteOid: existingFence.previousConfirmedHeadOid ?? '',
              state: 'completed',
              stage: 'reconciled',
              pushState: 'committed',
              pullRequestState: 'committed',
              status: resolvedStatus,
              pullRequestUrl: cleanUrl,
              pullRequestNumber: options.pullRequestNumber!,
              reason: null,
              updatedAtMs: effectiveNowMs,
            },
            scrubber,
          );
          const journalBytes = Buffer.from(`${JSON.stringify(synthesizedCompleted, null, 2)}\n`, 'utf8');
          assertCleanArtifact(journalBytes, scrubber, `/${MEMORY_PUBLICATION_JOURNAL_FILE}`);
          await writeAtomicPrivateFile(
            join(runDir, MEMORY_PUBLICATION_JOURNAL_FILE),
            journalBytes,
            MEMORY_PUBLICATION_JOURNAL_FILE,
          );
        }
        return Object.freeze({
          status: resolvedStatus,
          directory: inferred.directory,
          proposalId: inferred.proposalId,
          entryCount: inferred.entryCount,
          rebased: inferred.rebased,
          branchName: existingFence.branchName,
          pullRequestUrl: cleanUrl,
          pullRequestNumber: options.pullRequestNumber!,
          reason: null,
        });
      }

      const stripNonce = (j: TurnkeyMemoryPublicationJournal): Omit<TurnkeyMemoryPublicationJournal, 'attemptNonce'> => {
        const { attemptNonce: _ignored, ...rest } = j;
        void _ignored;
        return rest;
      };
      const canUpdateFence = existingFence === null || existingFence.runId === options.runId;

      if (options.outcome === 'push_only' || (options.outcome === 'not_executed' && journal.pushState === 'committed')) {
        const retainedReason = options.outcome === 'push_only'
          ? 'memory branch push confirmed; pull request creation/update pending replay'
          : 'memory pull request reconciled as not_executed; pushed branch head retained for replay';
        await writeFenceAndJournalUnlocked(
          options.runRoot,
          options.runId,
          fencePath,
          existingFence,
          {
            ...stripNonce(journal),
            state: 'push_only',
            stage: 'reconciled',
            pushState: 'committed',
            pullRequestState: 'not_executed',
            status: 'skipped',
            reason: retainedReason,
            updatedAtMs: effectiveNowMs,
          },
          scrubber,
          { updateFence: canUpdateFence },
        );
        return Object.freeze({
          status: 'skipped',
          directory: journal.directory,
          proposalId: journal.proposalId,
          entryCount: journal.entryCount,
          rebased: journal.rebased,
          branchName: journal.branchName,
          pullRequestUrl: journal.pullRequestUrl,
          pullRequestNumber: journal.pullRequestNumber,
          reason: retainedReason,
        });
      }

      if (options.outcome === 'not_executed') {
        await clearFenceAndDeleteJournalUnlocked(
          options.runRoot,
          options.runId,
          fencePath,
          existingFence,
          scrubber,
          effectiveNowMs,
        );
        return Object.freeze({
          status: 'skipped',
          directory: journal.directory,
          proposalId: journal.proposalId,
          entryCount: 0,
          rebased: journal.rebased,
          branchName: null,
          pullRequestUrl: null,
          pullRequestNumber: null,
          reason: 'memory publication reconciled as not_executed',
        });
      }

      const resolvedStatus = options.isUpdate === true ? 'updated' : 'published';
      const cleanUrl = scrubber.scrub(options.pullRequestUrl!.trim());
      await writeFenceAndJournalUnlocked(
        options.runRoot,
        options.runId,
        fencePath,
        existingFence,
        {
          ...stripNonce(journal),
          state: 'completed',
          stage: 'reconciled',
          pushState: 'committed',
          pullRequestState: 'committed',
          status: resolvedStatus,
          pullRequestNumber: options.pullRequestNumber!,
          pullRequestUrl: cleanUrl,
          reason: null,
          updatedAtMs: effectiveNowMs,
        },
        scrubber,
        { updateFence: canUpdateFence },
      );
      return Object.freeze({
        status: resolvedStatus,
        directory: journal.directory,
        proposalId: journal.proposalId,
        entryCount: journal.entryCount,
        rebased: journal.rebased,
        branchName: journal.branchName,
        pullRequestUrl: cleanUrl,
        pullRequestNumber: options.pullRequestNumber!,
        reason: null,
      });
    },
  );
}

async function extractOpenMemoryManagedFiles(
  cloneDir: string,
  revision: string,
  taskpack: string,
  memoryRoot: string,
  memoryDirectory: string,
  cleanGitEnv: Record<string, string>,
): Promise<readonly { readonly path: string; readonly bytes: Buffer }[]> {
  const memTree = await listTreeEntriesAtRevision(cloneDir, revision, cleanGitEnv);
  if (hasSymlinkAtOrAbove(memoryDirectory, memTree, memTree)) {
    throw new GitHubAppError('TASKPACK_SCOPE_VIOLATION', `open memory branch contains symlink at or above "${memoryDirectory}"`);
  }
  const managedEntries = [...memTree.entries()].filter(([path]) => isMemoryManagedPath(taskpack, path, memoryRoot));
  if (managedEntries.length === 0 || managedEntries.length > MAX_MANAGED_MEMORY_FILES) {
    throw new GitHubAppError(
      'ACTION_INPUT_INVALID',
      `open memory branch carries an invalid managed file count (${managedEntries.length})`,
    );
  }
  const indexRelPath = `${memoryDirectory}/index.json`;
  const files: Array<{ readonly path: string; readonly bytes: Buffer }> = [];
  for (const [path, entry] of managedEntries) {
    if (entry.type !== 'blob' || entry.mode !== '100644' || hasSymlinkAtOrAbove(path, memTree, memTree)) {
      throw new GitHubAppError('TASKPACK_SCOPE_VIOLATION', `open memory branch carries unsafe entry "${path}"`);
    }
    const maxBlobBytes = path === indexRelPath ? MAX_MEMORY_INDEX_BLOB_BYTES : MAX_MEMORY_ENTRY_BLOB_BYTES;
    const bytes = await execGit(
      cloneDir,
      ['cat-file', 'blob', entry.oid],
      { env: cleanGitEnv, maxStdoutBytes: maxBlobBytes, timeoutMs: 15_000 },
    );
    files.push({ path, bytes });
  }
  return files;
}

async function materializeMemoryFilesInClone(
  cloneDir: string,
  memoryDirectory: string,
  files: readonly { readonly path: string; readonly bytes: Buffer }[],
): Promise<void> {
  await rm(join(cloneDir, memoryDirectory), { recursive: true, force: true });
  await mkdir(join(cloneDir, memoryDirectory, 'entries'), { recursive: true, mode: 0o700 });
  for (const file of files) {
    await mkdir(dirname(join(cloneDir, file.path)), { recursive: true, mode: 0o700 });
    await writeFile(join(cloneDir, file.path), file.bytes, { mode: 0o600 });
  }
}

async function isSquashOrRebaseMergedMemoryBranch(options: {
  readonly cloneDir: string;
  readonly baseRevision: string;
  readonly currentTargetTip: string;
  readonly pinnedRemoteMemoryOid: string;
  readonly remoteRef: string;
  readonly taskpack: string;
  readonly repositoryFullName: string;
  readonly memoryRoot: string;
  readonly memoryDirectory: string;
  readonly cleanGitEnv: Record<string, string>;
}): Promise<boolean> {
  const {
    cloneDir,
    baseRevision,
    currentTargetTip,
    pinnedRemoteMemoryOid,
    remoteRef,
    taskpack,
    repositoryFullName,
    memoryRoot,
    memoryDirectory,
    cleanGitEnv,
  } = options;
  const branchBaseOid = await execGit(
    cloneDir,
    ['merge-base', pinnedRemoteMemoryOid, currentTargetTip],
    { env: cleanGitEnv, timeoutMs: 5_000 },
  ).then(buf => buf.toString('utf8').trim().toLowerCase(), () => '');
  if (!COMMIT_SHA_PATTERN.test(branchBaseOid)) {
    return false;
  }
  const diffRaw = await execGit(
    cloneDir,
    ['diff', '--name-only', branchBaseOid, pinnedRemoteMemoryOid, '--'],
    { env: cleanGitEnv, timeoutMs: 10_000 },
  ).then(buf => buf.toString('utf8'), () => '');
  const diffPaths = diffRaw.split('\n').map(line => line.trim()).filter(Boolean);
  if (diffPaths.length === 0 || diffPaths.some(path => !isMemoryManagedPath(taskpack, path, memoryRoot))) {
    return false;
  }
  try {
    await execGit(cloneDir, ['reset', '--hard', branchBaseOid], { env: cleanGitEnv, timeoutMs: 15_000 });
    await execGit(cloneDir, ['clean', '-fdx'], { env: cleanGitEnv, timeoutMs: 15_000 });
    const branchBaseStore = (await loadMemoryStore(cloneDir, taskpack, repositoryFullName, memoryRoot)).index;

    await execGit(cloneDir, ['reset', '--hard', currentTargetTip], { env: cleanGitEnv, timeoutMs: 15_000 });
    await execGit(cloneDir, ['clean', '-fdx'], { env: cleanGitEnv, timeoutMs: 15_000 });
    const targetTipStore = (await loadMemoryStore(cloneDir, taskpack, repositoryFullName, memoryRoot)).index;

    const remoteFiles = await extractOpenMemoryManagedFiles(
      cloneDir,
      remoteRef,
      taskpack,
      memoryRoot,
      memoryDirectory,
      cleanGitEnv,
    );
    await materializeMemoryFilesInClone(cloneDir, memoryDirectory, remoteFiles);
    const remoteMemStore = (await loadMemoryStore(cloneDir, taskpack, repositoryFullName, memoryRoot)).index;

    if (digestEqual(remoteMemStore.storeDigest, targetTipStore.storeDigest)) {
      return true;
    }
    if (remoteMemStore.entries.length === 0 && remoteMemStore.retired.length === 0) {
      return false;
    }

    const entriesEqual = (candidate: MemoryEntry | undefined, expected: MemoryEntry): boolean =>
      candidate !== undefined && canonicalMemory(candidate) === canonicalMemory(expected);

    const branchBaseRetiredById = new Map<string, (typeof branchBaseStore.retired)[number]>();
    for (const row of branchBaseStore.retired) {
      branchBaseRetiredById.set(row.entry.id, row);
    }
    const targetCurrentById = new Map<string, (typeof targetTipStore.entries)[number]>();
    for (const entry of targetTipStore.entries) {
      targetCurrentById.set(entry.id, entry);
    }
    const targetRetiredById = new Map<string, (typeof targetTipStore.retired)[number]>();
    for (const row of targetTipStore.retired) {
      targetRetiredById.set(row.entry.id, row);
    }
    const remoteCurrentById = new Map<string, (typeof remoteMemStore.entries)[number]>();
    for (const entry of remoteMemStore.entries) {
      remoteCurrentById.set(entry.id, entry);
    }

    for (const entry of remoteMemStore.entries) {
      const exactActiveOnTarget = entriesEqual(targetCurrentById.get(entry.id), entry);
      const targetRetired = targetRetiredById.get(entry.id);
      const landedThenRetiredOnTarget =
        entriesEqual(targetRetired?.entry, entry)
        && !entriesEqual(branchBaseRetiredById.get(entry.id)?.entry, entry);
      if (!exactActiveOnTarget && !landedThenRetiredOnTarget) {
        return false;
      }
    }

    for (const row of remoteMemStore.retired) {
      if (entriesEqual(targetCurrentById.get(row.entry.id), row.entry)) {
        return false;
      }
      const landedRetired = targetRetiredById.get(row.entry.id);
      if (landedRetired === undefined) {
        return false;
      }
      const exactRetiredRecordMatch = canonicalMemory(landedRetired) === canonicalMemory(row);
      const remoteReplacement = remoteCurrentById.get(row.entry.id);
      const replacementLaterRetiredOnTarget =
        remoteReplacement !== undefined && entriesEqual(landedRetired.entry, remoteReplacement);
      if (!exactRetiredRecordMatch && !replacementLaterRetiredOnTarget) {
        return false;
      }
    }
    return true;
  } catch {
    return false;
  } finally {
    await execGit(cloneDir, ['reset', '--hard', baseRevision], { env: cleanGitEnv, timeoutMs: 15_000 }).catch(() => undefined);
    await execGit(cloneDir, ['clean', '-fdx'], { env: cleanGitEnv, timeoutMs: 15_000 }).catch(() => undefined);
  }
}

function validateMemoryPullRequestApiResponse(
  parsedPr: unknown,
  expected: {
    readonly repositoryFullName: string;
    readonly targetBranch: string;
    readonly memoryBranch: string;
    readonly headOid: string;
    readonly existingPrNumber: number | null;
    readonly scrubber: SecretScrubber;
  },
):
  | { readonly ok: true; readonly prNumber: number; readonly prUrl: string }
  | {
    readonly ok: false;
    readonly canConfirmViaReadOnlyGet: boolean;
    readonly prNumber: number | null;
    readonly prUrl: string | null;
    readonly reason: string;
  } {
  if (!isPlainRecord(parsedPr)) {
    return {
      ok: false,
      canConfirmViaReadOnlyGet: false,
      prNumber: null,
      prUrl: null,
      reason: 'memory pull request API returned a 2xx response without a valid JSON object',
    };
  }
  const prUrl = typeof parsedPr['html_url'] === 'string' && parsedPr['html_url'].trim().length > 0
    ? expected.scrubber.scrub(parsedPr['html_url'].trim())
    : null;
  const prNumber = typeof parsedPr['number'] === 'number'
    && Number.isSafeInteger(parsedPr['number'])
    && parsedPr['number'] > 0
    ? parsedPr['number']
    : null;
  if (prUrl === null || prNumber === null) {
    return {
      ok: false,
      canConfirmViaReadOnlyGet: false,
      prNumber: null,
      prUrl: null,
      reason: 'memory pull request API returned a 2xx response without valid JSON number and html_url',
    };
  }
  if (expected.existingPrNumber !== null && prNumber !== expected.existingPrNumber) {
    return {
      ok: false,
      canConfirmViaReadOnlyGet: false,
      prNumber,
      prUrl,
      reason: `memory pull request API returned unexpected PR number #${prNumber} (expected #${expected.existingPrNumber})`,
    };
  }
  if (parsedPr['state'] !== 'open') {
    return {
      ok: false,
      canConfirmViaReadOnlyGet: false,
      prNumber,
      prUrl,
      reason: `memory pull request API returned non-open PR state "${String(parsedPr['state'] ?? '')}"`,
    };
  }
  const head = isPlainRecord(parsedPr['head']) ? parsedPr['head'] : null;
  const base = isPlainRecord(parsedPr['base']) ? parsedPr['base'] : null;
  const headRepo = head !== null && isPlainRecord(head['repo']) ? head['repo'] : null;
  const baseRepo = base !== null && isPlainRecord(base['repo']) ? base['repo'] : null;
  const expectedRepoLower = expected.repositoryFullName.toLowerCase();

  if (
    head === null
    || head['ref'] !== expected.memoryBranch
    || headRepo === null
    || typeof headRepo['full_name'] !== 'string'
    || headRepo['full_name'].toLowerCase() !== expectedRepoLower
  ) {
    return {
      ok: false,
      canConfirmViaReadOnlyGet: false,
      prNumber,
      prUrl,
      reason: `memory pull request API response head binding did not match "${expected.repositoryFullName}:${expected.memoryBranch}"`,
    };
  }
  if (
    base === null
    || base['ref'] !== expected.targetBranch
    || baseRepo === null
    || typeof baseRepo['full_name'] !== 'string'
    || baseRepo['full_name'].toLowerCase() !== expectedRepoLower
  ) {
    return {
      ok: false,
      canConfirmViaReadOnlyGet: false,
      prNumber,
      prUrl,
      reason: `memory pull request API response base binding did not match "${expected.repositoryFullName}:${expected.targetBranch}"`,
    };
  }
  if (
    typeof headRepo['id'] === 'number'
    && typeof baseRepo['id'] === 'number'
    && headRepo['id'] !== baseRepo['id']
  ) {
    return {
      ok: false,
      canConfirmViaReadOnlyGet: false,
      prNumber,
      prUrl,
      reason: 'memory pull request API response head.repo.id did not match base.repo.id',
    };
  }
  if (typeof head['sha'] !== 'string' || !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i.test(head['sha'])) {
    return {
      ok: false,
      canConfirmViaReadOnlyGet: true,
      prNumber,
      prUrl,
      reason: 'memory pull request API response omitted a valid head.sha commit digest',
    };
  }
  if (head['sha'].toLowerCase() !== expected.headOid.toLowerCase()) {
    return {
      ok: false,
      canConfirmViaReadOnlyGet: true,
      prNumber,
      prUrl,
      reason: 'memory pull request API response head.sha did not match pushed memory commit',
    };
  }
  return { ok: true, prNumber, prUrl };
}

function validateRetainedSettledRunBindings(
  settled: Pick<ResolvedSettledCycleContext, 'lock' | 'result'>,
  expected: {
    readonly runId: string;
    readonly repositoryFullName: string;
    readonly taskpack: string;
    readonly baseRevision: string;
  },
): string | null {
  if (settled.lock.spec.runId !== expected.runId) {
    return `MEMORY_SCOPE_VIOLATION: retained run lock runId "${settled.lock.spec.runId}" does not match "${expected.runId}"`;
  }
  const lockedTarget = settled.lock.spec.contract.spec.target;
  if (lockedTarget.repository !== expected.repositoryFullName) {
    return `MEMORY_SCOPE_VIOLATION: retained run repository "${lockedTarget.repository}" does not match publication repository "${expected.repositoryFullName}"`;
  }
  if (settled.lock.spec.contract.spec.taskpack !== expected.taskpack) {
    return `MEMORY_SCOPE_VIOLATION: retained run taskpack "${settled.lock.spec.contract.spec.taskpack}" does not match "${expected.taskpack}"`;
  }
  if (lockedTarget.baseRevision.toLowerCase() !== expected.baseRevision.toLowerCase()) {
    return `MEMORY_SCOPE_VIOLATION: retained run baseRevision "${lockedTarget.baseRevision}" does not match "${expected.baseRevision}"`;
  }
  if (settled.result !== null) {
    const subject = settled.result.spec.subject;
    if (
      subject.lockHash.hex !== settled.lock.spec.lockHash.hex
      || subject.contractHash.hex !== settled.lock.spec.contractHash.hex
      || subject.repository !== expected.repositoryFullName
      || subject.baseRevision.toLowerCase() !== expected.baseRevision.toLowerCase()
    ) {
      return 'MEMORY_SCOPE_VIOLATION: retained RunResult subject does not match retained TaskLock and publication target';
    }
  }
  return null;
}

async function verifyRetainedRunDescriptorIfPresent(
  runRoot: string,
  expected: {
    readonly runId: string;
    readonly repositoryFullName: string;
    readonly taskpack: string;
    readonly baseRevision: string;
  },
): Promise<string | null> {
  const runDir = await resolveSafeRunDirectoryForJournal(runRoot, expected.runId);
  if (runDir === null) return null;
  const rawRunJson = await readRegularJsonFileBounded(join(runDir, 'run.json'), 2 * 1024 * 1024, 'run.json');
  if (!rawRunJson.exists) return null;
  if (!isPlainRecord(rawRunJson.value) || !isPlainRecord(rawRunJson.value['identity'])) {
    return 'MEMORY_SCHEMA_INVALID: retained run.json carries no valid identity record';
  }
  const lockDoc = validateDocument(rawRunJson.value['identity']['lock'], 'TaskLock');
  if (!lockDoc.ok) {
    return 'MEMORY_SCHEMA_INVALID: retained run.json carries no valid TaskLock';
  }
  return validateRetainedSettledRunBindings({ lock: lockDoc.value, result: null }, expected);
}

async function dispatchMemoryPullRequestApi(options: {
  readonly claimMode: 'replay_push_only' | 'advance_push_to_pr';
  readonly existingAttemptNonce?: string | undefined;
  readonly runRoot: string;
  readonly runId: string;
  readonly repositoryFullName: string;
  readonly taskpack: string;
  readonly targetBranch: string;
  readonly memoryBranch: string;
  readonly memoryDirectory: string;
  readonly proposalId: string;
  readonly entryCount: number;
  readonly rebased: boolean;
  readonly headOid: string;
  readonly expectedRemoteOid: string;
  readonly cleanTitle: string;
  readonly cleanBody: string;
  readonly existingOpenMemoryPr: ManagedPullRequestInfo | null;
  readonly apiBaseUrl: string;
  readonly githubToken: string;
  readonly fetchImpl: typeof globalThis.fetch;
  readonly scrubber: SecretScrubber;
  readonly verifyUnderLock?: (() => Promise<TurnkeyMemorySummary | null>) | undefined;
  readonly confirmRemoteHeadOid?: (() => Promise<boolean>) | undefined;
}): Promise<TurnkeyMemorySummary> {
  const {
    claimMode,
    existingAttemptNonce,
    runRoot,
    runId,
    repositoryFullName,
    taskpack,
    targetBranch,
    memoryBranch,
    memoryDirectory,
    proposalId,
    entryCount,
    rebased,
    headOid,
    expectedRemoteOid,
    cleanTitle,
    cleanBody,
    existingOpenMemoryPr,
    apiBaseUrl,
    githubToken,
    fetchImpl,
    scrubber,
    verifyUnderLock,
    confirmRemoteHeadOid,
  } = options;
  const isUpdate = existingOpenMemoryPr !== null;

  const baseJournalRecord = {
    version: 1 as const,
    repository: repositoryFullName,
    taskpack,
    targetBranch,
    directory: memoryDirectory,
    proposalId,
    entryCount,
    rebased,
    branchName: memoryBranch,
    headOid,
    expectedRemoteOid,
    pullRequestTitle: cleanTitle,
    pullRequestBody: cleanBody,
  };

  const claimed = await claimMemoryPublicationAttemptUnderLock({
    mode: claimMode,
    runRoot,
    runId,
    existingAttemptNonce,
    draftJournal: {
      ...baseJournalRecord,
      state: 'uncertain',
      stage: 'pull_request',
      pushState: 'committed',
      pullRequestState: 'in_flight',
      status: 'reconcile_required',
      pullRequestUrl: existingOpenMemoryPr?.htmlUrl ?? null,
      pullRequestNumber: existingOpenMemoryPr?.number ?? null,
      reason: 'memory branch pushed; pull request API request in flight',
      updatedAtMs: Date.now(),
    },
    scrubber,
    verifyUnderLock,
  });
  if (!claimed.claimed) {
    return claimed.summary;
  }
  const { attemptNonce } = claimed;

  const apiHeaders: Record<string, string> = {
    accept: 'application/vnd.github+json',
    'content-type': 'application/json',
    'user-agent': 'loopwright-github-app',
    authorization: `Bearer ${githubToken}`,
  };
  const prEndpoint = existingOpenMemoryPr !== null
    ? `${apiBaseUrl}/repos/${repositoryFullName}/pulls/${existingOpenMemoryPr.number}`
    : `${apiBaseUrl}/repos/${repositoryFullName}/pulls`;

  let prRes: Awaited<ReturnType<typeof fetchBoundedText>>;
  try {
    prRes = await fetchBoundedText(
      prEndpoint,
      fetchImpl,
      apiHeaders,
      15_000,
      scrubber,
      {
        method: isUpdate ? 'PATCH' : 'POST',
        body: JSON.stringify(
          isUpdate
            ? { title: cleanTitle, body: cleanBody }
            : { title: cleanTitle, head: memoryBranch, base: targetBranch, body: cleanBody },
        ),
      },
    );
  } catch (transportErr) {
    const rawMsg = transportErr instanceof Error ? transportErr.message : String(transportErr);
    const transportReason = truncateCodePoints(
      sanitizeReportText(`memory pull request API transport error: ${rawMsg}`, { scrub: text => scrubber.scrub(text), singleLine: true }),
      MAX_REASON_CODEPOINTS,
    );
    await settleMemoryPublicationAttemptUnderLock({
      runRoot,
      runId,
      attemptNonce,
      action: {
        kind: 'write',
        journal: {
          ...baseJournalRecord,
          state: 'uncertain',
          stage: 'pull_request',
          pushState: 'committed',
          pullRequestState: 'in_flight',
          status: 'reconcile_required',
          pullRequestUrl: existingOpenMemoryPr?.htmlUrl ?? null,
          pullRequestNumber: existingOpenMemoryPr?.number ?? null,
          reason: transportReason,
          updatedAtMs: Date.now(),
        },
      },
      scrubber,
    });
    return Object.freeze({
      status: 'reconcile_required',
      directory: memoryDirectory,
      proposalId,
      entryCount,
      rebased,
      branchName: memoryBranch,
      pullRequestUrl: existingOpenMemoryPr?.htmlUrl ?? null,
      pullRequestNumber: existingOpenMemoryPr?.number ?? null,
      reason: transportReason,
    });
  }

  if (!prRes.ok) {
    const httpErrReason = truncateCodePoints(
      sanitizeReportText(
        `memory pull request API failed (${prRes.status}): ${prRes.text}`,
        { scrub: text => scrubber.scrub(text), singleLine: true },
      ),
      MAX_REASON_CODEPOINTS,
    );
    await settleMemoryPublicationAttemptUnderLock({
      runRoot,
      runId,
      attemptNonce,
      action: {
        kind: 'write',
        journal: {
          ...baseJournalRecord,
          state: 'uncertain',
          stage: 'pull_request',
          pushState: 'committed',
          pullRequestState: 'in_flight',
          status: 'reconcile_required',
          pullRequestUrl: existingOpenMemoryPr?.htmlUrl ?? null,
          pullRequestNumber: existingOpenMemoryPr?.number ?? null,
          reason: httpErrReason,
          updatedAtMs: Date.now(),
        },
      },
      scrubber,
    });
    return Object.freeze({
      status: 'reconcile_required',
      directory: memoryDirectory,
      proposalId,
      entryCount,
      rebased,
      branchName: memoryBranch,
      pullRequestUrl: existingOpenMemoryPr?.htmlUrl ?? null,
      pullRequestNumber: existingOpenMemoryPr?.number ?? null,
      reason: httpErrReason,
    });
  }

  let parsedPr: unknown;
  try {
    parsedPr = JSON.parse(prRes.text);
  } catch {
    parsedPr = null;
  }
  let validatedPr = validateMemoryPullRequestApiResponse(parsedPr, {
    repositoryFullName,
    targetBranch,
    memoryBranch,
    headOid,
    existingPrNumber: existingOpenMemoryPr?.number ?? null,
    scrubber,
  });

  if (!validatedPr.ok && validatedPr.canConfirmViaReadOnlyGet && validatedPr.prNumber !== null) {
    // Perform a bounded read-only confirmation check (`GET /repos/.../pulls/:number` + remote ref check)
    // in case GitHub's PR response lagged behind the pushed ref; retain uncertainty unless the pushed
    // `headOid` is strictly confirmed on both the PR object and remote ref!
    const confirmUrl = `${apiBaseUrl}/repos/${repositoryFullName}/pulls/${validatedPr.prNumber}`;
    const readHeaders: Record<string, string> = {
      accept: 'application/vnd.github+json',
      'user-agent': 'loopwright-github-app',
      authorization: `Bearer ${githubToken}`,
    };
    const readRes = await fetchBoundedText(
      confirmUrl,
      fetchImpl,
      readHeaders,
      10_000,
      scrubber,
      { method: 'GET' },
    ).catch(() => null);
    if (readRes !== null && readRes.ok) {
      let parsedGetPr: unknown;
      try {
        parsedGetPr = JSON.parse(readRes.text);
      } catch {
        parsedGetPr = null;
      }
      const revalidated = validateMemoryPullRequestApiResponse(parsedGetPr, {
        repositoryFullName,
        targetBranch,
        memoryBranch,
        headOid,
        existingPrNumber: validatedPr.prNumber,
        scrubber,
      });
      if (revalidated.ok) {
        const remoteStillMatches = confirmRemoteHeadOid !== undefined
          ? await confirmRemoteHeadOid().catch(() => false)
          : true;
        if (remoteStillMatches) {
          validatedPr = revalidated;
        }
      }
    }
  }

  if (!validatedPr.ok) {
    const parseErrReason = validatedPr.reason;
    await settleMemoryPublicationAttemptUnderLock({
      runRoot,
      runId,
      attemptNonce,
      action: {
        kind: 'write',
        journal: {
          ...baseJournalRecord,
          state: 'uncertain',
          stage: 'pull_request',
          pushState: 'committed',
          pullRequestState: 'in_flight',
          status: 'reconcile_required',
          pullRequestUrl: existingOpenMemoryPr?.htmlUrl ?? null,
          pullRequestNumber: existingOpenMemoryPr?.number ?? null,
          reason: parseErrReason,
          updatedAtMs: Date.now(),
        },
      },
      scrubber,
    });
    return Object.freeze({
      status: 'reconcile_required',
      directory: memoryDirectory,
      proposalId,
      entryCount,
      rebased,
      branchName: memoryBranch,
      pullRequestUrl: existingOpenMemoryPr?.htmlUrl ?? null,
      pullRequestNumber: existingOpenMemoryPr?.number ?? null,
      reason: parseErrReason,
    });
  }
  const prUrl = validatedPr.prUrl;
  const prNumber = validatedPr.prNumber;

  const settledStatus = isUpdate ? 'updated' : 'published';
  await settleMemoryPublicationAttemptUnderLock({
    runRoot,
    runId,
    attemptNonce,
    action: {
      kind: 'write',
      journal: {
        ...baseJournalRecord,
        state: 'completed',
        stage: 'pull_request',
        pushState: 'committed',
        pullRequestState: 'committed',
        status: settledStatus,
        pullRequestUrl: prUrl,
        pullRequestNumber: prNumber,
        reason: null,
        updatedAtMs: Date.now(),
      },
    },
    scrubber,
  });

  return Object.freeze({
    status: settledStatus,
    directory: memoryDirectory,
    proposalId,
    entryCount,
    rebased,
    branchName: memoryBranch,
    pullRequestUrl: prUrl,
    pullRequestNumber: prNumber,
    reason: null,
  });
}

/**
 * Fault-isolated post-settlement memory finalization, 5-gate CAS verification in an
 * isolated clone of `targetBranch`, and separate dedicated memory PR publication
 * (`loopwright/memory/<taskpack>/<targetBranch>`). Never mutates `repositoryRoot`,
 * `.git/worktrees`, primary `RunResult`, or the candidate PR branch.
 */
export async function finalizeAndPublishTurnkeyMemory(
  options: FinalizeAndPublishTurnkeyMemoryOptions,
): Promise<TurnkeyMemorySummary> {
  const scrubber = options.scrubber;
  const nowMs = options.nowMs ?? Date.now();
  let memoryDirectory = options.manifest.spec.memory.directory;
  let trackedProposalId: string | null = null;
  let trackedEntryCount = 0;
  let trackedRebased = false;
  let trackedBranchName: string | null = null;
  let trackedPrUrl: string | null = null;
  let trackedPrNumber: number | null = null;
  let mutationDispatched = false;

  try {
    const resolvedLocation = resolveTaskpackMemoryLocation(options.manifest, options.taskpackPath);
    const { controlRoot, memoryRoot } = resolvedLocation;
    memoryDirectory = resolvedLocation.memoryDirectory;
    const { manifestPath } = resolveManifestControlRoot(options.manifest, options.taskpackPath);
    const taskpack = options.manifest.metadata.name;
    const targetBranch = options.manifest.spec.publication.targetBranch;
    const memoryBranch = `loopwright/memory/${taskpack}/${targetBranch}`;

    if (!REPOSITORY_FULL_NAME_PATTERN.test(options.repositoryFullName)) {
      return Object.freeze({
        status: 'skipped',
        directory: memoryDirectory,
        proposalId: null,
        entryCount: 0,
        rebased: false,
        branchName: null,
        pullRequestUrl: null,
        pullRequestNumber: null,
        reason: 'repositoryFullName is not an org/repo slug',
      });
    }

    // 0. Check retained per-run journal AND cross-run branch fence before any replay or external mutation.
    let existingJournal: TurnkeyMemoryPublicationJournal | null = null;
    let fenceSnapshot: Awaited<ReturnType<typeof inspectMemoryBranchPublicationFence>>;
    try {
      existingJournal = await readMemoryPublicationJournal(options.runRoot, options.runId);
      fenceSnapshot = await inspectMemoryBranchPublicationFence(
        options.runRoot,
        options.repositoryFullName,
        memoryBranch,
        options.runId,
      );
    } catch (journalErr) {
      const journalMsg = journalErr instanceof Error ? journalErr.message : String(journalErr);
      return Object.freeze({
        status: 'reconcile_required',
        directory: memoryDirectory,
        proposalId: null,
        entryCount: 0,
        rebased: false,
        branchName: memoryBranch,
        pullRequestUrl: null,
        pullRequestNumber: null,
        reason: truncateCodePoints(
          sanitizeReportText(journalMsg, { scrub: text => scrubber.scrub(text), singleLine: true }),
          MAX_REASON_CODEPOINTS,
        ),
      });
    }

    if (existingJournal !== null) {
      if (existingJournal.state === 'uncertain') {
        return Object.freeze({
          status: 'reconcile_required',
          directory: existingJournal.directory,
          proposalId: existingJournal.proposalId,
          entryCount: existingJournal.entryCount,
          rebased: existingJournal.rebased,
          branchName: existingJournal.branchName,
          pullRequestUrl: existingJournal.pullRequestUrl,
          pullRequestNumber: existingJournal.pullRequestNumber,
          reason: existingJournal.reason ?? 'memory publication outcome is uncertain from a prior attempt; reconcile before replaying',
        });
      }
      const retainedRunMismatch = await verifyRetainedRunDescriptorIfPresent(options.runRoot, {
        runId: options.runId,
        repositoryFullName: options.repositoryFullName,
        taskpack,
        baseRevision: options.baseRevision,
      });
      const bindingMismatchReason = validateJournalBindingsMatchCurrent(existingJournal, {
        repositoryFullName: options.repositoryFullName,
        taskpack,
        targetBranch,
        memoryDirectory,
        memoryBranch,
      }) ?? retainedRunMismatch;
      if (bindingMismatchReason !== null) {
        return Object.freeze({
          status: 'refused',
          directory: existingJournal.directory,
          proposalId: existingJournal.proposalId,
          entryCount: 0,
          rebased: existingJournal.rebased,
          branchName: existingJournal.branchName,
          pullRequestUrl: existingJournal.pullRequestUrl,
          pullRequestNumber: existingJournal.pullRequestNumber,
          reason: truncateCodePoints(
            sanitizeReportText(bindingMismatchReason, { scrub: text => scrubber.scrub(text), singleLine: true }),
            MAX_REASON_CODEPOINTS,
          ),
        });
      }
      if (existingJournal.state === 'completed') {
        return Object.freeze({
          status: existingJournal.status === 'updated' ? 'updated' : 'published',
          directory: existingJournal.directory,
          proposalId: existingJournal.proposalId,
          entryCount: existingJournal.entryCount,
          rebased: existingJournal.rebased,
          branchName: existingJournal.branchName,
          pullRequestUrl: existingJournal.pullRequestUrl,
          pullRequestNumber: existingJournal.pullRequestNumber,
          reason: null,
        });
      }
    }

    if (fenceSnapshot.unresolvedOtherRun !== null) {
      return Object.freeze({
        status: 'reconcile_required',
        directory: memoryDirectory,
        proposalId: existingJournal?.proposalId ?? null,
        entryCount: existingJournal?.entryCount ?? 0,
        rebased: existingJournal?.rebased ?? false,
        branchName: memoryBranch,
        pullRequestUrl: existingJournal?.pullRequestUrl ?? null,
        pullRequestNumber: existingJournal?.pullRequestNumber ?? null,
        reason: truncateCodePoints(
          sanitizeReportText(fenceSnapshot.unresolvedOtherRun.reason, { scrub: text => scrubber.scrub(text), singleLine: true }),
          MAX_REASON_CODEPOINTS,
        ),
      });
    }

    // 0b. Staged recovery replay: when `existingJournal.state === 'push_only'`, the verified commit
    //     `existingJournal.headOid` is already pushed to remote; resume directly at PR creation/update.
    if (existingJournal !== null && existingJournal.state === 'push_only') {
      trackedProposalId = existingJournal.proposalId;
      trackedEntryCount = existingJournal.entryCount;
      trackedRebased = existingJournal.rebased;
      trackedBranchName = existingJournal.branchName;
      trackedPrUrl = existingJournal.pullRequestUrl;
      trackedPrNumber = existingJournal.pullRequestNumber;

      if (options.manifest.spec.publication.mode !== 'pull_request') {
        return Object.freeze({
          status: 'local_only',
          directory: existingJournal.directory,
          proposalId: existingJournal.proposalId,
          entryCount: existingJournal.entryCount,
          rebased: existingJournal.rebased,
          branchName: existingJournal.branchName,
          pullRequestUrl: null,
          pullRequestNumber: null,
          reason: 'publication.mode is disabled; skipping staged memory pull request publication',
        });
      }

      const cleanGitEnv = buildCleanGitEnv();
      const gitAuthEnv = buildGitAuthEnv(options.githubToken);
      let resolvedRemote: string | undefined = options.remoteUrl?.trim() || undefined;
      if (resolvedRemote === undefined) {
        const originUrl = await execGit(
          options.repositoryRoot,
          ['remote', 'get-url', '--', 'origin'],
          { env: cleanGitEnv, timeoutMs: 5_000 },
        ).then(buf => buf.toString('utf8').trim(), () => '');
        if (originUrl.length > 0) resolvedRemote = originUrl;
      }
      let protocolArgs: readonly string[] = ['-c', 'protocol.ext.allow=never', '-c', 'protocol.ssh.allow=never'];
      if (resolvedRemote !== undefined) {
        try {
          const remoteKind = validateGitRemoteSource(resolvedRemote);
          protocolArgs = remoteKind === 'local-dir'
            ? ['-c', 'protocol.file.allow=always', '-c', 'protocol.ext.allow=never', '-c', 'protocol.ssh.allow=never']
            : ['-c', 'protocol.ext.allow=never', '-c', 'protocol.ssh.allow=never'];
        } catch {
          resolvedRemote = undefined;
        }
      }
      const apiBaseUrl = (options.apiBaseUrl?.trim() || options.runtimeEnv?.['GITHUB_API_URL']?.trim() || '').replace(/\/+$/, '');
      const hasGitHubCredentials = typeof options.githubToken === 'string' && options.githubToken.trim().length > 0;
      if (
        options.manifest.spec.memory.apply !== 'separate-pull-request'
        || resolvedRemote === undefined
        || apiBaseUrl.length === 0
        || !hasGitHubCredentials
      ) {
        return Object.freeze({
          status: 'local_only',
          directory: existingJournal.directory,
          proposalId: existingJournal.proposalId,
          entryCount: existingJournal.entryCount,
          rebased: existingJournal.rebased,
          branchName: existingJournal.branchName,
          pullRequestUrl: null,
          pullRequestNumber: null,
          reason: 'GitHub credentials, API URL, or git remote unavailable to complete staged memory PR publication',
        });
      }

      const lsRemoteOut = (
        await execGit(
          options.repositoryRoot,
          [...protocolArgs, 'ls-remote', '--', resolvedRemote, `refs/heads/${existingJournal.branchName}`],
          { env: gitAuthEnv, timeoutMs: 15_000 },
        )
      ).toString('utf8').trim();
      const pinnedRemoteMemoryOid = lsRemoteOut.length > 0
        ? (lsRemoteOut.split(/\s+/)[0] ?? '').toLowerCase()
        : '';
      if (pinnedRemoteMemoryOid !== existingJournal.headOid.toLowerCase()) {
        return Object.freeze({
          status: 'refused',
          directory: existingJournal.directory,
          proposalId: existingJournal.proposalId,
          entryCount: 0,
          rebased: existingJournal.rebased,
          branchName: existingJournal.branchName,
          pullRequestUrl: existingJournal.pullRequestUrl,
          pullRequestNumber: existingJournal.pullRequestNumber,
          reason: `MEMORY_CAS_CONFLICT: remote memory branch "${existingJournal.branchName}" moved away from reconciled push head`,
        });
      }

      // Defense-in-depth: verify in an isolated scratch clone that the three-dot diff of
      // `existingJournal.headOid` against remote `targetBranch` touches ONLY managed memory files!
      const rawReplayScratch = await mkdtemp(join(tmpdir(), 'loopwright-mem-replay-'));
      await chmod(rawReplayScratch, 0o700);
      const replayScratch = await realpath(rawReplayScratch);
      const replayClone = join(replayScratch, 'repo');
      try {
        await execGit(
          replayScratch,
          ['-c', 'protocol.file.allow=always', 'clone', '--shared', '--no-checkout', '--', options.repositoryRoot, replayClone],
          { env: cleanGitEnv, timeoutMs: 25_000 },
        );
        await execGit(
          replayClone,
          [...protocolArgs, 'fetch', '--quiet', '--', resolvedRemote, `refs/heads/${targetBranch}:refs/remotes/replay/target`],
          { env: gitAuthEnv, timeoutMs: 15_000 },
        );
        await execGit(
          replayClone,
          [...protocolArgs, 'fetch', '--quiet', '--', resolvedRemote, `refs/heads/${existingJournal.branchName}:refs/remotes/replay/head`],
          { env: gitAuthEnv, timeoutMs: 15_000 },
        );
        const replayFetchedHead = (
          await execGit(replayClone, ['rev-parse', '--verify', 'refs/remotes/replay/head^{commit}'], { env: cleanGitEnv, timeoutMs: 5_000 })
        ).toString('utf8').trim().toLowerCase();
        if (replayFetchedHead !== pinnedRemoteMemoryOid) {
          return Object.freeze({
            status: 'refused',
            directory: existingJournal.directory,
            proposalId: existingJournal.proposalId,
            entryCount: 0,
            rebased: existingJournal.rebased,
            branchName: existingJournal.branchName,
            pullRequestUrl: existingJournal.pullRequestUrl,
            pullRequestNumber: existingJournal.pullRequestNumber,
            reason: `MEMORY_CAS_CONFLICT: remote memory branch "${existingJournal.branchName}" moved while verifying replay scope`,
          });
        }
        const replayMergeBase = await execGit(
          replayClone,
          ['merge-base', 'refs/remotes/replay/target', 'refs/remotes/replay/head'],
          { env: cleanGitEnv, timeoutMs: 5_000 },
        ).then(buf => buf.toString('utf8').trim().toLowerCase(), () => '');
        if (!COMMIT_SHA_PATTERN.test(replayMergeBase)) {
          return Object.freeze({
            status: 'refused',
            directory: existingJournal.directory,
            proposalId: existingJournal.proposalId,
            entryCount: 0,
            rebased: existingJournal.rebased,
            branchName: existingJournal.branchName,
            pullRequestUrl: existingJournal.pullRequestUrl,
            pullRequestNumber: existingJournal.pullRequestNumber,
            reason: `MEMORY_SCOPE_VIOLATION: staged memory branch "${existingJournal.branchName}" shares no merge-base with target "${targetBranch}"`,
          });
        }
        const replayDiffRaw = (
          await execGit(
            replayClone,
            ['diff', '--name-only', replayMergeBase, 'refs/remotes/replay/head', '--'],
            { env: cleanGitEnv, timeoutMs: 10_000 },
          )
        ).toString('utf8');
        const replayDiffPaths = replayDiffRaw.split('\n').map(line => line.trim()).filter(Boolean);
        if (
          replayDiffPaths.length === 0
          || replayDiffPaths.some(path => !isMemoryManagedPath(taskpack, path, memoryRoot))
        ) {
          return Object.freeze({
            status: 'refused',
            directory: existingJournal.directory,
            proposalId: existingJournal.proposalId,
            entryCount: 0,
            rebased: existingJournal.rebased,
            branchName: existingJournal.branchName,
            pullRequestUrl: existingJournal.pullRequestUrl,
            pullRequestNumber: existingJournal.pullRequestNumber,
            reason: `MEMORY_SCOPE_VIOLATION: staged memory branch diff against "${targetBranch}" touches paths outside "${memoryDirectory}"`,
          });
        }
      } finally {
        await rm(replayScratch, { recursive: true, force: true }).catch(() => undefined);
      }

      const openMemoryPr = await findOpenMemoryPullRequest({
        apiBaseUrl,
        repositoryFullName: options.repositoryFullName,
        targetBranch,
        memoryBranch: existingJournal.branchName,
        githubToken: options.githubToken,
        fetchImpl: options.fetchImpl,
        scrubber,
        env: options.runtimeEnv,
      });
      if (
        openMemoryPr !== null
        && openMemoryPr.headSha.length > 0
        && openMemoryPr.headSha !== '0'.repeat(40)
        && openMemoryPr.headSha.toLowerCase() !== pinnedRemoteMemoryOid
      ) {
        return Object.freeze({
          status: 'refused',
          directory: existingJournal.directory,
          proposalId: existingJournal.proposalId,
          entryCount: 0,
          rebased: existingJournal.rebased,
          branchName: existingJournal.branchName,
          pullRequestUrl: openMemoryPr.htmlUrl,
          pullRequestNumber: openMemoryPr.number,
          reason: `MEMORY_CAS_CONFLICT: open memory pull request #${openMemoryPr.number} head moved concurrently`,
        });
      }

      mutationDispatched = true;
      return await dispatchMemoryPullRequestApi({
        claimMode: 'replay_push_only',
        runRoot: options.runRoot,
        runId: options.runId,
        repositoryFullName: options.repositoryFullName,
        taskpack,
        targetBranch,
        memoryBranch: existingJournal.branchName,
        memoryDirectory: existingJournal.directory,
        proposalId: existingJournal.proposalId,
        entryCount: existingJournal.entryCount,
        rebased: existingJournal.rebased,
        headOid: existingJournal.headOid,
        expectedRemoteOid: existingJournal.expectedRemoteOid,
        cleanTitle: existingJournal.pullRequestTitle ?? `chore(memory): update ${taskpack} memory`,
        cleanBody: existingJournal.pullRequestBody ?? `Automated memory compaction for \`${taskpack}\` (${existingJournal.proposalId}).`,
        existingOpenMemoryPr: openMemoryPr,
        apiBaseUrl,
        githubToken: options.githubToken!,
        fetchImpl: options.fetchImpl ?? globalThis.fetch,
        scrubber,
        verifyUnderLock: async () => {
          const lockedRemote = await execGitDetailed(
            options.repositoryRoot,
            [...protocolArgs, 'ls-remote', '--', resolvedRemote!, `refs/heads/${existingJournal.branchName}`],
            { env: gitAuthEnv, timeoutMs: 10_000 },
          );
          if (
            lockedRemote.spawnError !== null
            || lockedRemote.stdoutOverflow
            || lockedRemote.timedOut
            || lockedRemote.signal !== null
            || lockedRemote.code !== 0
          ) {
            const errDetail = lockedRemote.stderr.toString('utf8').trim();
            return Object.freeze({
              status: 'reconcile_required',
              directory: existingJournal.directory,
              proposalId: existingJournal.proposalId,
              entryCount: existingJournal.entryCount,
              rebased: existingJournal.rebased,
              branchName: existingJournal.branchName,
              pullRequestUrl: openMemoryPr?.htmlUrl ?? existingJournal.pullRequestUrl,
              pullRequestNumber: openMemoryPr?.number ?? existingJournal.pullRequestNumber,
              reason: truncateCodePoints(
                sanitizeReportText(
                  `failed to re-verify remote memory branch under lock${errDetail.length > 0 ? `: ${errDetail}` : ''}`,
                  { scrub: text => scrubber.scrub(text), singleLine: true },
                ),
                MAX_REASON_CODEPOINTS,
              ),
            });
          }
          const lockedOid = lockedRemote.stdout.toString('utf8').trim().split(/\s+/)[0]?.toLowerCase() ?? '';
          if (lockedOid !== existingJournal.headOid.toLowerCase()) {
            return Object.freeze({
              status: 'refused',
              directory: existingJournal.directory,
              proposalId: existingJournal.proposalId,
              entryCount: 0,
              rebased: existingJournal.rebased,
              branchName: existingJournal.branchName,
              pullRequestUrl: openMemoryPr?.htmlUrl ?? existingJournal.pullRequestUrl,
              pullRequestNumber: openMemoryPr?.number ?? existingJournal.pullRequestNumber,
              reason: `MEMORY_CAS_CONFLICT: remote memory branch "${existingJournal.branchName}" moved away from reconciled push head`,
            });
          }
          return null;
        },
        confirmRemoteHeadOid: async () => {
          const checkRemote = await execGitDetailed(
            options.repositoryRoot,
            [...protocolArgs, 'ls-remote', '--', resolvedRemote!, `refs/heads/${existingJournal.branchName}`],
            { env: gitAuthEnv, timeoutMs: 10_000 },
          );
          if (
            checkRemote.spawnError !== null
            || checkRemote.stdoutOverflow
            || checkRemote.timedOut
            || checkRemote.signal !== null
            || checkRemote.code !== 0
          ) {
            return false;
          }
          const observedOid = checkRemote.stdout.toString('utf8').trim().split(/\s+/)[0]?.toLowerCase() ?? '';
          return observedOid === existingJournal.headOid.toLowerCase();
        },
      });
    }

    // 1. Validate working-tree memory path segments on repositoryRoot before cloning so
    //    untracked or working-tree symlinks/case-aliases under custom memoryRoot are refused immediately.
    await loadMemoryStore(options.repositoryRoot, taskpack, options.repositoryFullName, memoryRoot);

    const earlyRetainedMismatch = await verifyRetainedRunDescriptorIfPresent(options.runRoot, {
      runId: options.runId,
      repositoryFullName: options.repositoryFullName,
      taskpack,
      baseRevision: options.baseRevision,
    });
    if (earlyRetainedMismatch !== null) {
      return Object.freeze({
        status: 'refused',
        directory: memoryDirectory,
        proposalId: null,
        entryCount: 0,
        rebased: false,
        branchName: null,
        pullRequestUrl: null,
        pullRequestNumber: null,
        reason: truncateCodePoints(
          sanitizeReportText(earlyRetainedMismatch, { scrub: text => scrubber.scrub(text), singleLine: true }),
          MAX_REASON_CODEPOINTS,
        ),
      });
    }

    // 2. Respect manifest.spec.memory.onNoModelBudget === 'skip' when no curator budget is wired.
    if (options.manifest.spec.memory.onNoModelBudget === 'skip') {
      const skipped = await finalizeRunMemory({
        context: {
          kind: 'run_directory',
          runRoot: options.runRoot,
          runId: options.runId,
          repository: options.repositoryRoot,
        },
        config: {
          taskpack,
          memoryRoot,
          memoryWritable: [options.manifest.spec.memory.directory],
          onNoModelBudget: 'skip',
          curator: null,
          requireCuratorReview: false,
          nowMs,
          ttlMs: DEFAULT_MEMORY_ENTRY_TTL_MS,
          upstreamVersions: buildUpstreamVersionsMap(options.upstreamRecords),
        },
      });
      return Object.freeze({
        status: 'skipped',
        directory: memoryDirectory,
        proposalId: null,
        entryCount: 0,
        rebased: false,
        branchName: null,
        pullRequestUrl: null,
        pullRequestNumber: null,
        reason: scrubber.scrub(skipped.reason ?? 'no_model_budget_skipped'),
      });
    }

    if (!COMMIT_SHA_PATTERN.test(options.baseRevision)) {
      return Object.freeze({
        status: 'failed',
        directory: memoryDirectory,
        proposalId: null,
        entryCount: 0,
        rebased: false,
        branchName: null,
        pullRequestUrl: null,
        pullRequestNumber: null,
        reason: 'baseRevision is not a 40-hex commit SHA',
      });
    }

    const rawScratch = await mkdtemp(join(tmpdir(), 'loopwright-mem-'));
    await chmod(rawScratch, 0o700);
    const memoryScratch = await realpath(rawScratch);
    const cloneDir = join(memoryScratch, 'repo');
    const cleanGitEnv = buildCleanGitEnv();

    try {
      await execGit(
        memoryScratch,
        ['-c', 'protocol.file.allow=always', 'clone', '--shared', '--no-checkout', '--', options.repositoryRoot, cloneDir],
        { env: cleanGitEnv, timeoutMs: 25_000 },
      );
      await execGit(
        cloneDir,
        ['checkout', '--force', options.baseRevision, '--'],
        { env: cleanGitEnv, timeoutMs: 25_000 },
      );

      const settledPre = await resolveSettledCycleContext({
        kind: 'run_directory',
        runRoot: options.runRoot,
        runId: options.runId,
        repository: cloneDir,
      });
      const settledBindingMismatch = validateRetainedSettledRunBindings(settledPre, {
        runId: options.runId,
        repositoryFullName: options.repositoryFullName,
        taskpack,
        baseRevision: options.baseRevision,
      });
      if (settledBindingMismatch !== null) {
        return Object.freeze({
          status: 'refused',
          directory: memoryDirectory,
          proposalId: null,
          entryCount: 0,
          rebased: false,
          branchName: null,
          pullRequestUrl: null,
          pullRequestNumber: null,
          reason: truncateCodePoints(
            sanitizeReportText(settledBindingMismatch, { scrub: text => scrubber.scrub(text), singleLine: true }),
            MAX_REASON_CODEPOINTS,
          ),
        });
      }
      if (settledPre.result?.spec.status === 'reconcile_required') {
        return Object.freeze({
          status: 'skipped',
          directory: memoryDirectory,
          proposalId: null,
          entryCount: 0,
          rebased: false,
          branchName: null,
          pullRequestUrl: null,
          pullRequestNumber: null,
          reason: 'primary_run_reconcile_required',
        });
      }

      const gitAuthEnv = buildGitAuthEnv(options.githubToken);
      let resolvedRemote: string | undefined = options.remoteUrl?.trim() || undefined;
      if (resolvedRemote === undefined) {
        const originUrl = await execGit(
          options.repositoryRoot,
          ['remote', 'get-url', '--', 'origin'],
          { env: cleanGitEnv, timeoutMs: 5_000 },
        ).then(buf => buf.toString('utf8').trim(), () => '');
        if (originUrl.length > 0) {
          resolvedRemote = originUrl;
        }
      }

      const memoryBranchSafe = SAFE_BRANCH_PATTERN.test(memoryBranch) && !memoryBranch.includes('..') && !memoryBranch.startsWith('-');
      const targetBranchSafe = SAFE_BRANCH_PATTERN.test(targetBranch) && !targetBranch.includes('..') && !targetBranch.startsWith('-');
      const apiBaseUrl = (options.apiBaseUrl?.trim() || options.runtimeEnv?.['GITHUB_API_URL']?.trim() || '').replace(/\/+$/, '');
      const hasGitHubCredentials = typeof options.githubToken === 'string' && options.githubToken.trim().length > 0;
      const publicationModeEnabled = options.manifest.spec.publication.mode === 'pull_request'
        && options.manifest.spec.memory.apply === 'separate-pull-request';
      const remotePublicationRequested = publicationModeEnabled && apiBaseUrl.length > 0 && hasGitHubCredentials;

      let remoteKind: 'https' | 'local-dir' | null = null;
      let protocolArgs: readonly string[] = ['-c', 'protocol.ext.allow=never', '-c', 'protocol.ssh.allow=never'];
      if (resolvedRemote !== undefined) {
        try {
          remoteKind = validateGitRemoteSource(resolvedRemote);
          protocolArgs = remoteKind === 'local-dir'
            ? ['-c', 'protocol.file.allow=always', '-c', 'protocol.ext.allow=never', '-c', 'protocol.ssh.allow=never']
            : ['-c', 'protocol.ext.allow=never', '-c', 'protocol.ssh.allow=never'];
        } catch (remoteErr) {
          if (remotePublicationRequested) {
            const detail = remoteErr instanceof Error ? remoteErr.message : String(remoteErr);
            return Object.freeze({
              status: 'failed',
              directory: memoryDirectory,
              proposalId: null,
              entryCount: 0,
              rebased: false,
              branchName: null,
              pullRequestUrl: null,
              pullRequestNumber: null,
              reason: truncateCodePoints(
                sanitizeReportText(detail, { scrub: text => scrubber.scrub(text), singleLine: true }),
                MAX_REASON_CODEPOINTS,
              ),
            });
          }
          resolvedRemote = undefined;
        }
      }

      const canPublishRemote = remotePublicationRequested
        && memoryBranchSafe
        && resolvedRemote !== undefined;

      // Establish remote targetBranch tip before inspecting open memory PRs, pinning remote lease, or running CAS.
      // When publishing remotely, target-fetch failure MUST abort publication rather than silently falling back to baseRevision.
      let currentTargetTip = options.baseRevision;
      if (canPublishRemote && resolvedRemote !== undefined) {
        if (!targetBranchSafe) {
          return Object.freeze({
            status: 'failed',
            directory: memoryDirectory,
            proposalId: null,
            entryCount: 0,
            rebased: false,
            branchName: null,
            pullRequestUrl: null,
            pullRequestNumber: null,
            reason: `targetBranch "${targetBranch}" is not a safe git branch name`,
          });
        }
        const targetFetchRes = await execGitDetailed(
          cloneDir,
          [...protocolArgs, 'fetch', '--quiet', '--', resolvedRemote, `refs/heads/${targetBranch}:refs/remotes/target/tip`],
          { env: gitAuthEnv, timeoutMs: 15_000 },
        );
        if (
          targetFetchRes.spawnError !== null
          || targetFetchRes.stdoutOverflow
          || targetFetchRes.timedOut
          || targetFetchRes.signal !== null
          || targetFetchRes.code !== 0
        ) {
          const stderrText = targetFetchRes.stderr.toString('utf8').trim();
          return Object.freeze({
            status: 'failed',
            directory: memoryDirectory,
            proposalId: null,
            entryCount: 0,
            rebased: false,
            branchName: null,
            pullRequestUrl: null,
            pullRequestNumber: null,
            reason: truncateCodePoints(
              sanitizeReportText(
                `failed to fetch remote target branch "${targetBranch}" for memory CAS${stderrText.length > 0 ? `: ${stderrText}` : ''}`,
                { scrub: text => scrubber.scrub(text), singleLine: true },
              ),
              MAX_REASON_CODEPOINTS,
            ),
          });
        }
        const fetchedTip = (
          await execGit(cloneDir, ['rev-parse', '--verify', 'refs/remotes/target/tip^{commit}'], { env: cleanGitEnv, timeoutMs: 5_000 })
        ).toString('utf8').trim().toLowerCase();
        if (!COMMIT_SHA_PATTERN.test(fetchedTip)) {
          return Object.freeze({
            status: 'failed',
            directory: memoryDirectory,
            proposalId: null,
            entryCount: 0,
            rebased: false,
            branchName: null,
            pullRequestUrl: null,
            pullRequestNumber: null,
            reason: `remote target branch "${targetBranch}" did not resolve to a valid commit SHA`,
          });
        }
        currentTargetTip = fetchedTip;
      } else if (publicationModeEnabled && resolvedRemote !== undefined && targetBranchSafe) {
        const fetchedTip = await execGit(
          cloneDir,
          [...protocolArgs, 'fetch', '--quiet', '--', resolvedRemote, `refs/heads/${targetBranch}:refs/remotes/target/tip`],
          { env: gitAuthEnv, timeoutMs: 15_000 },
        ).then(
          async () => (await execGit(cloneDir, ['rev-parse', '--verify', 'refs/remotes/target/tip^{commit}'], { env: cleanGitEnv, timeoutMs: 5_000 })).toString('utf8').trim().toLowerCase(),
          () => '',
        );
        if (COMMIT_SHA_PATTERN.test(fetchedTip)) {
          currentTargetTip = fetchedTip;
        }
      }

      // Pin expected remote head OID ONCE before reading base store or running CAS.
      // An initially absent remote memory branch stays pinned to `''` (absent-ref expectation).
      let openMemoryPr: ManagedPullRequestInfo | null = null;
      let expectedRemoteOid = '';
      let openMemoryManagedFiles: readonly { readonly path: string; readonly bytes: Buffer }[] | null = null;

      if (canPublishRemote && resolvedRemote !== undefined) {
        trackedBranchName = memoryBranch;
        const lsRemoteOut = (
          await execGit(
            cloneDir,
            [...protocolArgs, 'ls-remote', '--', resolvedRemote, `refs/heads/${memoryBranch}`],
            { env: gitAuthEnv, timeoutMs: 15_000 },
          )
        ).toString('utf8').trim();
        const pinnedRemoteMemoryOid = lsRemoteOut.length > 0
          ? (lsRemoteOut.split(/\s+/)[0] ?? '').toLowerCase()
          : '';
        if (pinnedRemoteMemoryOid.length > 0 && !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(pinnedRemoteMemoryOid)) {
          return Object.freeze({
            status: 'failed',
            directory: memoryDirectory,
            proposalId: null,
            entryCount: 0,
            rebased: false,
            branchName: memoryBranch,
            pullRequestUrl: null,
            pullRequestNumber: null,
            reason: `invalid remote OID for refs/heads/${memoryBranch}`,
          });
        }

        openMemoryPr = await findOpenMemoryPullRequest({
          apiBaseUrl,
          repositoryFullName: options.repositoryFullName,
          targetBranch,
          memoryBranch,
          githubToken: options.githubToken,
          fetchImpl: options.fetchImpl,
          scrubber,
          env: options.runtimeEnv,
        });
        trackedPrUrl = openMemoryPr?.htmlUrl ?? null;
        trackedPrNumber = openMemoryPr?.number ?? null;

        if (openMemoryPr !== null) {
          if (pinnedRemoteMemoryOid.length === 0) {
            return Object.freeze({
              status: 'refused',
              directory: memoryDirectory,
              proposalId: null,
              entryCount: 0,
              rebased: false,
              branchName: memoryBranch,
              pullRequestUrl: openMemoryPr.htmlUrl,
              pullRequestNumber: openMemoryPr.number,
              reason: `MEMORY_CAS_CONFLICT: open memory pull request #${openMemoryPr.number} branch "${memoryBranch}" is missing on remote`,
            });
          }
          if (
            openMemoryPr.headSha.length > 0
            && openMemoryPr.headSha !== '0'.repeat(40)
            && openMemoryPr.headSha.toLowerCase() !== pinnedRemoteMemoryOid
          ) {
            return Object.freeze({
              status: 'refused',
              directory: memoryDirectory,
              proposalId: null,
              entryCount: 0,
              rebased: false,
              branchName: memoryBranch,
              pullRequestUrl: openMemoryPr.htmlUrl,
              pullRequestNumber: openMemoryPr.number,
              reason: `MEMORY_CAS_CONFLICT: open memory pull request #${openMemoryPr.number} head moved concurrently`,
            });
          }

          await execGit(
            cloneDir,
            [...protocolArgs, 'fetch', '--quiet', '--', resolvedRemote, `refs/heads/${memoryBranch}:refs/remotes/memory/open`],
            { env: gitAuthEnv, timeoutMs: 15_000 },
          );
          const fetchedOpenOid = (
            await execGit(cloneDir, ['rev-parse', '--verify', 'refs/remotes/memory/open^{commit}'], { env: cleanGitEnv, timeoutMs: 5_000 })
          ).toString('utf8').trim().toLowerCase();
          if (fetchedOpenOid !== pinnedRemoteMemoryOid) {
            return Object.freeze({
              status: 'refused',
              directory: memoryDirectory,
              proposalId: null,
              entryCount: 0,
              rebased: false,
              branchName: memoryBranch,
              pullRequestUrl: openMemoryPr.htmlUrl,
              pullRequestNumber: openMemoryPr.number,
              reason: `MEMORY_CAS_CONFLICT: open memory branch "${memoryBranch}" moved while fetching`,
            });
          }
          expectedRemoteOid = pinnedRemoteMemoryOid;

          const baseRevStore = (await loadMemoryStore(cloneDir, taskpack, options.repositoryFullName, memoryRoot)).index;
          let targetTipStore = baseRevStore;
          if (currentTargetTip !== options.baseRevision) {
            await execGit(cloneDir, ['reset', '--hard', currentTargetTip], { env: cleanGitEnv, timeoutMs: 15_000 });
            await execGit(cloneDir, ['clean', '-fdx'], { env: cleanGitEnv, timeoutMs: 15_000 });
            targetTipStore = (await loadMemoryStore(cloneDir, taskpack, options.repositoryFullName, memoryRoot)).index;
            await execGit(cloneDir, ['reset', '--hard', options.baseRevision], { env: cleanGitEnv, timeoutMs: 15_000 });
            await execGit(cloneDir, ['clean', '-fdx'], { env: cleanGitEnv, timeoutMs: 15_000 });
          }

          let memPrParentStore = baseRevStore;
          const openParentOid = await execGit(
            cloneDir,
            ['rev-parse', '--verify', 'refs/remotes/memory/open^^{commit}'],
            { env: cleanGitEnv, timeoutMs: 5_000 },
          ).then(buf => buf.toString('utf8').trim().toLowerCase(), () => '');
          if (COMMIT_SHA_PATTERN.test(openParentOid) && openParentOid !== options.baseRevision) {
            await execGit(cloneDir, ['reset', '--hard', openParentOid], { env: cleanGitEnv, timeoutMs: 15_000 });
            await execGit(cloneDir, ['clean', '-fdx'], { env: cleanGitEnv, timeoutMs: 15_000 });
            memPrParentStore = (await loadMemoryStore(cloneDir, taskpack, options.repositoryFullName, memoryRoot)).index;
            await execGit(cloneDir, ['reset', '--hard', options.baseRevision], { env: cleanGitEnv, timeoutMs: 15_000 });
            await execGit(cloneDir, ['clean', '-fdx'], { env: cleanGitEnv, timeoutMs: 15_000 });
          }

          openMemoryManagedFiles = await extractOpenMemoryManagedFiles(
            cloneDir,
            'refs/remotes/memory/open',
            taskpack,
            memoryRoot,
            memoryDirectory,
            cleanGitEnv,
          );
          await materializeMemoryFilesInClone(cloneDir, memoryDirectory, openMemoryManagedFiles);
          const memPrStore = (await loadMemoryStore(cloneDir, taskpack, options.repositoryFullName, memoryRoot)).index;

          if (
            !digestEqual(memPrParentStore.storeDigest, targetTipStore.storeDigest)
            && !digestEqual(memPrStore.storeDigest, targetTipStore.storeDigest)
          ) {
            return Object.freeze({
              status: 'refused',
              directory: memoryDirectory,
              proposalId: null,
              entryCount: 0,
              rebased: false,
              branchName: memoryBranch,
              pullRequestUrl: openMemoryPr.htmlUrl,
              pullRequestNumber: openMemoryPr.number,
              reason: 'MEMORY_CAS_CONFLICT: target branch memory store diverged from open memory pull request; merge or rebase the open memory PR first',
            });
          }
        } else if (pinnedRemoteMemoryOid.length > 0) {
          await execGit(
            cloneDir,
            [...protocolArgs, 'fetch', '--quiet', '--', resolvedRemote, `refs/heads/${memoryBranch}:refs/remotes/memory/remote`],
            { env: gitAuthEnv, timeoutMs: 15_000 },
          );
          const fetchedRemoteOid = (
            await execGit(cloneDir, ['rev-parse', '--verify', 'refs/remotes/memory/remote^{commit}'], { env: cleanGitEnv, timeoutMs: 5_000 })
          ).toString('utf8').trim().toLowerCase();
          if (fetchedRemoteOid !== pinnedRemoteMemoryOid) {
            return Object.freeze({
              status: 'refused',
              directory: memoryDirectory,
              proposalId: null,
              entryCount: 0,
              rebased: false,
              branchName: memoryBranch,
              pullRequestUrl: null,
              pullRequestNumber: null,
              reason: `MEMORY_CAS_CONFLICT: remote memory branch "${memoryBranch}" moved while fetching`,
            });
          }

          const isReconciledPushOnlyHead = fenceSnapshot.confirmedPushOnlyHeadOid !== null
            && pinnedRemoteMemoryOid === fenceSnapshot.confirmedPushOnlyHeadOid.toLowerCase();

          if (isReconciledPushOnlyHead) {
            const baseRevStore = (await loadMemoryStore(cloneDir, taskpack, options.repositoryFullName, memoryRoot)).index;
            let targetTipStore = baseRevStore;
            if (currentTargetTip !== options.baseRevision) {
              await execGit(cloneDir, ['reset', '--hard', currentTargetTip], { env: cleanGitEnv, timeoutMs: 15_000 });
              await execGit(cloneDir, ['clean', '-fdx'], { env: cleanGitEnv, timeoutMs: 15_000 });
              targetTipStore = (await loadMemoryStore(cloneDir, taskpack, options.repositoryFullName, memoryRoot)).index;
              await execGit(cloneDir, ['reset', '--hard', options.baseRevision], { env: cleanGitEnv, timeoutMs: 15_000 });
              await execGit(cloneDir, ['clean', '-fdx'], { env: cleanGitEnv, timeoutMs: 15_000 });
            }
            let pushOnlyParentStore = baseRevStore;
            const pushOnlyParentOid = await execGit(
              cloneDir,
              ['rev-parse', '--verify', 'refs/remotes/memory/remote^^{commit}'],
              { env: cleanGitEnv, timeoutMs: 5_000 },
            ).then(buf => buf.toString('utf8').trim().toLowerCase(), () => '');
            if (COMMIT_SHA_PATTERN.test(pushOnlyParentOid) && pushOnlyParentOid !== options.baseRevision) {
              await execGit(cloneDir, ['reset', '--hard', pushOnlyParentOid], { env: cleanGitEnv, timeoutMs: 15_000 });
              await execGit(cloneDir, ['clean', '-fdx'], { env: cleanGitEnv, timeoutMs: 15_000 });
              pushOnlyParentStore = (await loadMemoryStore(cloneDir, taskpack, options.repositoryFullName, memoryRoot)).index;
              await execGit(cloneDir, ['reset', '--hard', options.baseRevision], { env: cleanGitEnv, timeoutMs: 15_000 });
              await execGit(cloneDir, ['clean', '-fdx'], { env: cleanGitEnv, timeoutMs: 15_000 });
            }
            openMemoryManagedFiles = await extractOpenMemoryManagedFiles(
              cloneDir,
              'refs/remotes/memory/remote',
              taskpack,
              memoryRoot,
              memoryDirectory,
              cleanGitEnv,
            );
            await materializeMemoryFilesInClone(cloneDir, memoryDirectory, openMemoryManagedFiles);
            const pushOnlyStore = (await loadMemoryStore(cloneDir, taskpack, options.repositoryFullName, memoryRoot)).index;
            if (
              !digestEqual(pushOnlyParentStore.storeDigest, targetTipStore.storeDigest)
              && !digestEqual(pushOnlyStore.storeDigest, targetTipStore.storeDigest)
            ) {
              return Object.freeze({
                status: 'refused',
                directory: memoryDirectory,
                proposalId: null,
                entryCount: 0,
                rebased: false,
                branchName: memoryBranch,
                pullRequestUrl: null,
                pullRequestNumber: null,
                reason: 'MEMORY_CAS_CONFLICT: target branch memory store diverged from reconciled push-only memory branch',
              });
            }
            expectedRemoteOid = pinnedRemoteMemoryOid;
          } else {
            const isAncestorOfTarget = await execGit(
              cloneDir,
              ['merge-base', '--is-ancestor', pinnedRemoteMemoryOid, currentTargetTip],
              { env: cleanGitEnv, timeoutMs: 5_000 },
            ).then(() => true, () => false);
            const isLandedInTarget = isAncestorOfTarget || await isSquashOrRebaseMergedMemoryBranch({
              cloneDir,
              baseRevision: options.baseRevision,
              currentTargetTip,
              pinnedRemoteMemoryOid,
              remoteRef: 'refs/remotes/memory/remote',
              taskpack,
              repositoryFullName: options.repositoryFullName,
              memoryRoot,
              memoryDirectory,
              cleanGitEnv,
            });
            if (!isLandedInTarget) {
              return Object.freeze({
                status: 'reconcile_required',
                directory: memoryDirectory,
                proposalId: null,
                entryCount: 0,
                rebased: false,
                branchName: memoryBranch,
                pullRequestUrl: null,
                pullRequestNumber: null,
                reason: `remote memory branch "${memoryBranch}" exists without an open pull request and is not merged into "${targetBranch}"; reconcile before publishing`,
              });
            }
            expectedRemoteOid = pinnedRemoteMemoryOid;
          }
        }
      }

      const upstreamVersions = buildUpstreamVersionsMap(options.upstreamRecords);
      const baseStore = (await loadMemoryStore(cloneDir, taskpack, options.repositoryFullName, memoryRoot)).index;
      const finalized = await finalizeRunMemory({
        context: {
          kind: 'run_directory',
          runRoot: options.runRoot,
          runId: options.runId,
          repository: cloneDir,
        },
        config: {
          taskpack,
          memoryRoot,
          memoryWritable: [options.manifest.spec.memory.directory],
          onNoModelBudget: options.manifest.spec.memory.onNoModelBudget,
          curator: null,
          requireCuratorReview: false,
          nowMs,
          ttlMs: DEFAULT_MEMORY_ENTRY_TTL_MS,
          upstreamVersions,
        },
      });

      if (finalized.status === 'unavailable' || finalized.proposal === null) {
        return Object.freeze({
          status: 'failed',
          directory: memoryDirectory,
          proposalId: null,
          entryCount: 0,
          rebased: false,
          branchName: null,
          pullRequestUrl: null,
          pullRequestNumber: null,
          reason: scrubber.scrub(finalized.reason ?? 'memory finalization unavailable'),
        });
      }

      trackedProposalId = finalized.proposal.proposalId;
      trackedEntryCount = finalized.proposal.operations.length;

      if (finalized.proposal.operations.length === 0) {
        return Object.freeze({
          status: 'no_entries',
          directory: memoryDirectory,
          proposalId: finalized.proposal.proposalId,
          entryCount: 0,
          rebased: false,
          branchName: null,
          pullRequestUrl: null,
          pullRequestNumber: null,
          reason: 'no deterministic memory entries produced for this run',
        });
      }

      if (currentTargetTip !== options.baseRevision) {
        await execGit(cloneDir, ['reset', '--hard', currentTargetTip], { env: cleanGitEnv, timeoutMs: 15_000 });
        await execGit(cloneDir, ['clean', '-fdx'], { env: cleanGitEnv, timeoutMs: 15_000 });
        if (openMemoryManagedFiles !== null) {
          await materializeMemoryFilesInClone(cloneDir, memoryDirectory, openMemoryManagedFiles);
        }
      }

      const settled = await resolveSettledCycleContext({
        kind: 'run_directory',
        runRoot: options.runRoot,
        runId: options.runId,
        repository: cloneDir,
      });

      const userProtectedPatterns = compileScopePatterns(options.manifest.spec.scope.protected, 'protected');
      const userProtectedSet = new Set<string>(userProtectedPatterns);
      const declaredCommandScripts = options.manifest.spec.verification.localChecks.flatMap(check =>
        check.implementation === 'command.v1' && typeof check.parameters?.['script'] === 'string' && check.parameters['script'].length > 0
          ? [check.parameters['script']]
          : [],
      );
      const protectedPaths = [
        ...new Set([
          '.github',
          '.github/**',
          ...PROTECTED_AUTOMATION_PATHS.flatMap(entry => [entry, `${entry}/**`]),
          `${controlRoot}/policies`,
          `${controlRoot}/policies/**`,
          `${controlRoot}/checks`,
          `${controlRoot}/checks/**`,
          `${controlRoot}/taskpack.yaml`,
          `${controlRoot}/taskpack.yml`,
          `${controlRoot}/taskpack.json`,
          ...(manifestPath !== undefined ? [manifestPath] : []),
          ...(options.manifest.spec.instructions ?? []),
          ...declaredCommandScripts,
          ...userProtectedPatterns,
        ]),
      ];
      const compilerAutoMemoryProtected = [
        `${controlRoot}/**`,
        `${controlRoot}/memory/**`,
        `${options.manifest.spec.memory.directory}/**`,
      ].filter(pattern => !userProtectedSet.has(pattern));

      const casResult = await applyMemoryProposalCAS({
        repository: cloneDir,
        taskpack,
        proposal: finalized.proposal,
        lock: settled.lock,
        result: settled.result,
        incident: settled.incident,
        evidence: settled.evidence,
        artifacts: settled.inventory,
        candidateDigest: settled.result?.spec.subject.candidateDigest ?? null,
        secretValues: scrubber.secretValues,
        memoryRoot,
        memoryWritable: [options.manifest.spec.memory.directory],
        protectedPaths,
        exemptContractProtectedPatterns: compilerAutoMemoryProtected,
        targetBranch,
        currentRevision: currentTargetTip,
        baseStore,
        allowRebase: true,
        nowMs,
      });
      trackedRebased = casResult.rebased;

      if (!casResult.applied || casResult.pullRequest === null) {
        const diagText = casResult.refusal?.diagnostics
          .map(diag => `${diag.code} at ${diag.path}: ${diag.detail}`)
          .join('; ') ?? 'memory CAS refused proposal';
        return Object.freeze({
          status: 'refused',
          directory: memoryDirectory,
          proposalId: finalized.proposal.proposalId,
          entryCount: 0,
          rebased: casResult.rebased,
          branchName: null,
          pullRequestUrl: null,
          pullRequestNumber: null,
          reason: scrubber.scrub(diagText),
        });
      }

      if (
        casResult.pullRequest.excludesCodeCandidatePaths !== true
        || casResult.pullRequest.modifiedFiles.some(file => !isMemoryManagedPath(taskpack, file.path, memoryRoot))
      ) {
        return Object.freeze({
          status: 'refused',
          directory: memoryDirectory,
          proposalId: finalized.proposal.proposalId,
          entryCount: 0,
          rebased: casResult.rebased,
          branchName: null,
          pullRequestUrl: null,
          pullRequestNumber: null,
          reason: 'memory pull request specification touched paths outside the managed memory directory',
        });
      }

      if (casResult.pullRequest.modifiedFiles.length === 0) {
        return Object.freeze({
          status: 'no_entries',
          directory: memoryDirectory,
          proposalId: finalized.proposal.proposalId,
          entryCount: 0,
          rebased: casResult.rebased,
          branchName: null,
          pullRequestUrl: null,
          pullRequestNumber: null,
          reason: 'memory store already matches proposed state',
        });
      }

      if (!memoryBranchSafe) {
        return Object.freeze({
          status: 'failed',
          directory: memoryDirectory,
          proposalId: finalized.proposal.proposalId,
          entryCount: finalized.proposal.operations.length,
          rebased: casResult.rebased,
          branchName: null,
          pullRequestUrl: null,
          pullRequestNumber: null,
          reason: `unsafe memory branch name "${memoryBranch}"`,
        });
      }

      if (options.manifest.spec.publication.mode !== 'pull_request') {
        return Object.freeze({
          status: 'local_only',
          directory: memoryDirectory,
          proposalId: finalized.proposal.proposalId,
          entryCount: finalized.proposal.operations.length,
          rebased: casResult.rebased,
          branchName: null,
          pullRequestUrl: null,
          pullRequestNumber: null,
          reason: 'publication.mode is disabled; remote memory branch writes skipped',
        });
      }

      if (
        options.manifest.spec.memory.apply !== 'separate-pull-request'
        || resolvedRemote === undefined
        || apiBaseUrl.length === 0
        || !hasGitHubCredentials
      ) {
        return Object.freeze({
          status: 'local_only',
          directory: memoryDirectory,
          proposalId: finalized.proposal.proposalId,
          entryCount: finalized.proposal.operations.length,
          rebased: casResult.rebased,
          branchName: memoryBranch,
          pullRequestUrl: null,
          pullRequestNumber: null,
          reason: 'GitHub credentials, API URL, or git remote unavailable for separate memory PR publication',
        });
      }

      const commitIdentity = options.gitCommitIdentity !== undefined
        ? validateGitCommitIdentity(options.gitCommitIdentity)
        : DEFAULT_GIT_COMMIT_IDENTITY;

      const memIndexFile = join(memoryScratch, 'mem-index');
      const gitClone = (
        args: readonly string[],
        extraOpts?: { readonly input?: Buffer | string | undefined; readonly timeoutMs?: number | undefined },
      ): Promise<Buffer> => execGit(cloneDir, args, { env: gitAuthEnv, ...extraOpts });
      const gitWithMemIndex = (
        args: readonly string[],
        extraOpts?: { readonly input?: Buffer | string | undefined; readonly timeoutMs?: number | undefined },
      ): Promise<Buffer> => execGit(cloneDir, args, { env: { ...gitAuthEnv, GIT_INDEX_FILE: memIndexFile }, ...extraOpts });

      const baseTreeOid = (
        await gitClone(['rev-parse', '--verify', '--end-of-options', `${currentTargetTip}^{tree}`])
      ).toString('utf8').trim();
      await gitWithMemIndex(['read-tree', `${currentTargetTip}^{tree}`]);
      const baseEntries = await listTreeEntriesAtRevision(cloneDir, currentTargetTip, cleanGitEnv);

      const existingBaseManagedPaths = [...baseEntries.keys()].filter(path => isMemoryManagedPath(taskpack, path, memoryRoot));
      for (const existingPath of existingBaseManagedPaths) {
        if (hasSymlinkAtOrAbove(existingPath, baseEntries, baseEntries)) {
          return Object.freeze({
            status: 'refused',
            directory: memoryDirectory,
            proposalId: finalized.proposal.proposalId,
            entryCount: 0,
            rebased: casResult.rebased,
            branchName: memoryBranch,
            pullRequestUrl: null,
            pullRequestNumber: null,
            reason: `refusing to overwrite symlinked memory path "${existingPath}"`,
          });
        }
      }
      await removePathsFromIndex(cloneDir, memIndexFile, existingBaseManagedPaths, gitAuthEnv);

      // Re-verify post-CAS store on disk and collect all managed memory files (`index.json` + `entries/*.md`),
      // enforcing the exact same count and blob byte ceilings used when importing an open memory branch.
      await loadMemoryStore(cloneDir, taskpack, options.repositoryFullName, memoryRoot);
      const postCasFiles: Array<{ readonly path: string; readonly bytes: Buffer }> = [];
      const indexRelPath = `${memoryDirectory}/index.json`;
      postCasFiles.push({ path: indexRelPath, bytes: await readFile(join(cloneDir, indexRelPath)) });
      const entriesDirAbs = join(cloneDir, memoryDirectory, 'entries');
      if (existsSync(entriesDirAbs)) {
        const entryDirents = (await readdir(entriesDirAbs, { withFileTypes: true }))
          .filter(dirent => dirent.isFile() && dirent.name.endsWith('.md'))
          .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
        for (const dirent of entryDirents) {
          const entryRelPath = `${memoryDirectory}/entries/${dirent.name}`;
          if (isMemoryManagedPath(taskpack, entryRelPath, memoryRoot)) {
            postCasFiles.push({ path: entryRelPath, bytes: await readFile(join(cloneDir, entryRelPath)) });
          }
        }
      }
      if (postCasFiles.length > MAX_MANAGED_MEMORY_FILES) {
        return Object.freeze({
          status: 'refused',
          directory: memoryDirectory,
          proposalId: finalized.proposal.proposalId,
          entryCount: 0,
          rebased: casResult.rebased,
          branchName: memoryBranch,
          pullRequestUrl: null,
          pullRequestNumber: null,
          reason: `managed memory file count (${postCasFiles.length}) exceeds supported ceiling (${MAX_MANAGED_MEMORY_FILES})`,
        });
      }

      const stagedMemoryEntries: Array<{ readonly path: string; readonly mode: '100644'; readonly oid: string }> = [];
      for (const file of postCasFiles) {
        const maxAllowedBytes = file.path === indexRelPath ? MAX_MEMORY_INDEX_BLOB_BYTES : MAX_MEMORY_ENTRY_BLOB_BYTES;
        if (file.bytes.byteLength > maxAllowedBytes) {
          return Object.freeze({
            status: 'refused',
            directory: memoryDirectory,
            proposalId: finalized.proposal.proposalId,
            entryCount: 0,
            rebased: casResult.rebased,
            branchName: memoryBranch,
            pullRequestUrl: null,
            pullRequestNumber: null,
            reason: `managed memory file "${file.path}" (${file.bytes.byteLength} bytes) exceeds supported ceiling (${maxAllowedBytes} bytes)`,
          });
        }
        if (hasSymlinkAtOrAbove(file.path, baseEntries, baseEntries)) {
          return Object.freeze({
            status: 'refused',
            directory: memoryDirectory,
            proposalId: finalized.proposal.proposalId,
            entryCount: 0,
            rebased: casResult.rebased,
            branchName: memoryBranch,
            pullRequestUrl: null,
            pullRequestNumber: null,
            reason: `refusing to overwrite symlinked memory path "${file.path}"`,
          });
        }
        assertCleanArtifact(file.bytes, scrubber, `/${file.path}`);
        const blobOid = (
          await gitClone(['hash-object', '-w', '--stdin'], { input: file.bytes })
        ).toString('utf8').trim();
        if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(blobOid)) {
          throw new GitHubAppError('ACTION_INPUT_INVALID', `git hash-object returned invalid oid for "${file.path}"`);
        }
        stagedMemoryEntries.push({ path: file.path, mode: '100644', oid: blobOid });
      }
      await stageEntriesInIndex(cloneDir, memIndexFile, stagedMemoryEntries, gitAuthEnv);

      const treeOid = (await gitWithMemIndex(['write-tree'])).toString('utf8').trim();
      if (treeOid === baseTreeOid) {
        return Object.freeze({
          status: 'no_entries',
          directory: memoryDirectory,
          proposalId: finalized.proposal.proposalId,
          entryCount: 0,
          rebased: casResult.rebased,
          branchName: memoryBranch,
          pullRequestUrl: openMemoryPr?.htmlUrl ?? null,
          pullRequestNumber: openMemoryPr?.number ?? null,
          reason: 'memory tree already matches target branch',
        });
      }

      if (openMemoryPr !== null) {
        const existingOpenTreeOid = (
          await gitClone(['rev-parse', '--verify', '--end-of-options', 'refs/remotes/memory/open^{tree}'])
        ).toString('utf8').trim();
        const existingOpenParentOid = await gitClone(
          ['rev-parse', '--verify', '--end-of-options', 'refs/remotes/memory/open^^{commit}'],
        ).then(buf => buf.toString('utf8').trim().toLowerCase(), () => '');
        if (treeOid === existingOpenTreeOid && existingOpenParentOid === currentTargetTip) {
          return Object.freeze({
            status: 'no_entries',
            directory: memoryDirectory,
            proposalId: finalized.proposal.proposalId,
            entryCount: 0,
            rebased: casResult.rebased,
            branchName: memoryBranch,
            pullRequestUrl: openMemoryPr.htmlUrl,
            pullRequestNumber: openMemoryPr.number,
            reason: 'open memory pull request already matches proposed tree',
          });
        }
      }

      const cleanTitle = scrubber.scrub(casResult.pullRequest.title).replace(/[\r\n]+/g, ' ').trim();
      const cleanBody = scrubber.scrub(casResult.pullRequest.body).replace(/\r\n?/g, '\n').trim();
      const signoffLine = `Signed-off-by: ${commitIdentity.name} <${commitIdentity.email}>`;
      const hasExactSignoff = cleanBody.split('\n').some(line => line.trim() === signoffLine);
      const commitMessage = hasExactSignoff
        ? `${cleanTitle}\n\n${cleanBody}\n`
        : `${cleanTitle}\n\n${cleanBody}\n\n${signoffLine}\n`;

      const headOid = (
        await gitClone(
          [
            '-c', `user.name=${commitIdentity.name}`,
            '-c', `user.email=${commitIdentity.email}`,
            'commit-tree',
            treeOid,
            '-p',
            currentTargetTip,
          ],
          { input: commitMessage },
        )
      ).toString('utf8').trim();

      trackedBranchName = memoryBranch;
      const pushClaim = await claimMemoryPublicationAttemptUnderLock({
        mode: 'fresh_push',
        runRoot: options.runRoot,
        runId: options.runId,
        draftJournal: {
          version: 1,
          state: 'uncertain',
          stage: 'push',
          pushState: 'in_flight',
          pullRequestState: 'not_started',
          status: 'reconcile_required',
          repository: options.repositoryFullName,
          taskpack,
          targetBranch,
          directory: memoryDirectory,
          proposalId: finalized.proposal.proposalId,
          entryCount: finalized.proposal.operations.length,
          rebased: casResult.rebased,
          branchName: memoryBranch,
          headOid,
          expectedRemoteOid,
          pullRequestTitle: cleanTitle,
          pullRequestBody: cleanBody,
          pullRequestUrl: openMemoryPr?.htmlUrl ?? null,
          pullRequestNumber: openMemoryPr?.number ?? null,
          reason: 'memory branch push in flight',
          updatedAtMs: Date.now(),
        },
        scrubber,
      });
      if (!pushClaim.claimed) {
        return pushClaim.summary;
      }
      const pushAttemptNonce = pushClaim.attemptNonce;
      mutationDispatched = true;

      const pushResult = await execGitDetailed(
        cloneDir,
        [
          ...protocolArgs,
          'push',
          '--porcelain',
          `--force-with-lease=refs/heads/${memoryBranch}:${expectedRemoteOid}`,
          '--',
          resolvedRemote,
          `${headOid}:refs/heads/${memoryBranch}`,
        ],
        { env: gitAuthEnv, timeoutMs: 25_000 },
      );

      if (
        pushResult.spawnError !== null
        || pushResult.stdoutOverflow
        || pushResult.timedOut
        || pushResult.code !== 0
        || pushResult.signal !== null
      ) {
        const expectedTargetRef = `refs/heads/${memoryBranch}`;
        const stdoutLines = pushResult.stdout.toString('utf8').split(/\r?\n/);
        let sawStaleLeaseRefRejection = false;
        let sawAnyRefUpdate = false;
        let sawDoneFooter = false;
        for (const rawLine of stdoutLines) {
          if (rawLine === 'Done') {
            sawDoneFooter = true;
            continue;
          }
          const tabParts = rawLine.split('\t');
          if (tabParts.length >= 3 && tabParts[0]!.length === 1) {
            const flag = tabParts[0]!;
            const fromTo = tabParts[1]!;
            const summary = tabParts.slice(2).join('\t').trim();
            const colonIdx = fromTo.indexOf(':');
            if (flag === ' ' || flag === '+' || flag === '-' || flag === '*' || flag === '=') {
              sawAnyRefUpdate = true;
            } else if (
              flag === '!'
              && colonIdx > 0
              && fromTo.slice(0, colonIdx).toLowerCase() === headOid.toLowerCase()
              && fromTo.slice(colonIdx + 1) === expectedTargetRef
              && /^\[rejected\]\s*\(stale info\)$/i.test(summary)
            ) {
              sawStaleLeaseRefRejection = true;
            }
          }
        }

        let verifiedNotAtHead = false;
        if (
          pushResult.spawnError === null
          && !pushResult.stdoutOverflow
          && !pushResult.timedOut
          && pushResult.signal === null
          && pushResult.code === 1
          && sawStaleLeaseRefRejection
          && sawDoneFooter
          && !sawAnyRefUpdate
        ) {
          const verifyRemote = await execGitDetailed(
            cloneDir,
            [...protocolArgs, 'ls-remote', '--', resolvedRemote, expectedTargetRef],
            { env: gitAuthEnv, timeoutMs: 10_000 },
          );
          if (
            verifyRemote.spawnError === null
            && !verifyRemote.stdoutOverflow
            && !verifyRemote.timedOut
            && verifyRemote.signal === null
            && verifyRemote.code === 0
          ) {
            const observedRemoteOid = verifyRemote.stdout.toString('utf8').trim().split(/\s+/)[0]?.toLowerCase() ?? '';
            if (observedRemoteOid !== headOid.toLowerCase()) {
              verifiedNotAtHead = true;
            }
          }
        }

        if (verifiedNotAtHead) {
          mutationDispatched = false;
          await settleMemoryPublicationAttemptUnderLock({
            runRoot: options.runRoot,
            runId: options.runId,
            attemptNonce: pushAttemptNonce,
            action: {
              kind: 'rollback_stale_push',
              repository: options.repositoryFullName,
              branchName: memoryBranch,
              nowMs: Date.now(),
            },
            scrubber,
          });
          return Object.freeze({
            status: 'refused',
            directory: memoryDirectory,
            proposalId: finalized.proposal.proposalId,
            entryCount: 0,
            rebased: casResult.rebased,
            branchName: memoryBranch,
            pullRequestUrl: openMemoryPr?.htmlUrl ?? null,
            pullRequestNumber: openMemoryPr?.number ?? null,
            reason: 'MEMORY_CAS_CONFLICT: remote memory branch moved concurrently (force-with-lease rejected)',
          });
        }

        const stderrText = pushResult.stderr.toString('utf8').trim();
        const rawPushDetail = pushResult.spawnError !== null
          ? `git push failed to spawn: ${pushResult.spawnError}`
          : pushResult.stdoutOverflow
            ? 'git push output exceeded maximum buffer size'
            : pushResult.timedOut
              ? 'git push timed out after 25000ms'
              : `git push exited with ${pushResult.code ?? pushResult.signal}${stderrText.length > 0 ? `: ${stderrText}` : ''}`;
        const scrubbedPushReason = truncateCodePoints(
          sanitizeReportText(rawPushDetail, { scrub: text => scrubber.scrub(text), singleLine: true }),
          MAX_REASON_CODEPOINTS,
        );
        await settleMemoryPublicationAttemptUnderLock({
          runRoot: options.runRoot,
          runId: options.runId,
          attemptNonce: pushAttemptNonce,
          action: {
            kind: 'write',
            journal: {
              version: 1,
              state: 'uncertain',
              stage: 'push',
              pushState: 'in_flight',
              pullRequestState: 'not_started',
              status: 'reconcile_required',
              repository: options.repositoryFullName,
              taskpack,
              targetBranch,
              directory: memoryDirectory,
              proposalId: finalized.proposal.proposalId,
              entryCount: finalized.proposal.operations.length,
              rebased: casResult.rebased,
              branchName: memoryBranch,
              headOid,
              expectedRemoteOid,
              pullRequestTitle: cleanTitle,
              pullRequestBody: cleanBody,
              pullRequestUrl: openMemoryPr?.htmlUrl ?? null,
              pullRequestNumber: openMemoryPr?.number ?? null,
              reason: scrubbedPushReason,
              updatedAtMs: Date.now(),
            },
          },
          scrubber,
        });
        return Object.freeze({
          status: 'reconcile_required',
          directory: memoryDirectory,
          proposalId: finalized.proposal.proposalId,
          entryCount: finalized.proposal.operations.length,
          rebased: casResult.rebased,
          branchName: memoryBranch,
          pullRequestUrl: openMemoryPr?.htmlUrl ?? null,
          pullRequestNumber: openMemoryPr?.number ?? null,
          reason: scrubbedPushReason,
        });
      }

      return await dispatchMemoryPullRequestApi({
        claimMode: 'advance_push_to_pr',
        existingAttemptNonce: pushAttemptNonce,
        runRoot: options.runRoot,
        runId: options.runId,
        repositoryFullName: options.repositoryFullName,
        taskpack,
        targetBranch,
        memoryBranch,
        memoryDirectory,
        proposalId: finalized.proposal.proposalId,
        entryCount: finalized.proposal.operations.length,
        rebased: casResult.rebased,
        headOid,
        expectedRemoteOid,
        cleanTitle,
        cleanBody,
        existingOpenMemoryPr: openMemoryPr,
        apiBaseUrl,
        githubToken: options.githubToken!,
        fetchImpl: options.fetchImpl ?? globalThis.fetch,
        scrubber,
        confirmRemoteHeadOid: async () => {
          const checkRemote = await execGitDetailed(
            cloneDir,
            [...protocolArgs, 'ls-remote', '--', resolvedRemote!, `refs/heads/${memoryBranch}`],
            { env: gitAuthEnv, timeoutMs: 10_000 },
          );
          if (
            checkRemote.spawnError !== null
            || checkRemote.stdoutOverflow
            || checkRemote.timedOut
            || checkRemote.signal !== null
            || checkRemote.code !== 0
          ) {
            return false;
          }
          const observedOid = checkRemote.stdout.toString('utf8').trim().split(/\s+/)[0]?.toLowerCase() ?? '';
          return observedOid === headOid.toLowerCase();
        },
      });
    } finally {
      await rm(memoryScratch, { recursive: true, force: true }).catch(() => undefined);
    }
  } catch (error) {
    const detail = error instanceof MemoryDiagnosticError
      ? `${error.code} at ${error.path}: ${error.detail}`
      : error instanceof Error
        ? error.message
        : String(error);
    const sanitizedReason = truncateCodePoints(
      sanitizeReportText(detail, { scrub: text => scrubber.scrub(text), singleLine: true }),
      MAX_REASON_CODEPOINTS,
    );
    const isFenceOrLockReconcile = error instanceof GitHubAppError
      && error.code === 'ACTION_INPUT_INVALID'
      && /manual reconciliation required|holds the active lock/i.test(error.message);
    if (mutationDispatched || isFenceOrLockReconcile) {
      return Object.freeze({
        status: 'reconcile_required',
        directory: memoryDirectory,
        proposalId: trackedProposalId,
        entryCount: trackedEntryCount,
        rebased: trackedRebased,
        branchName: trackedBranchName,
        pullRequestUrl: trackedPrUrl,
        pullRequestNumber: trackedPrNumber,
        reason: sanitizedReason,
      });
    }
    const isRefusal = error instanceof MemoryDiagnosticError
      || (error instanceof GitHubAppError && error.code === 'TASKPACK_SCOPE_VIOLATION');
    return Object.freeze({
      status: isRefusal ? 'refused' : 'failed',
      directory: memoryDirectory,
      proposalId: trackedProposalId,
      entryCount: isRefusal ? 0 : trackedEntryCount,
      rebased: trackedRebased,
      branchName: trackedBranchName,
      pullRequestUrl: trackedPrUrl,
      pullRequestNumber: trackedPrNumber,
      reason: sanitizedReason,
    });
  }
}
