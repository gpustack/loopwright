import { execFile, spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { constants as fsConstants, existsSync, lstatSync } from 'node:fs';
import { chmod, mkdir, mkdtemp, open, readFile, realpath, rm } from 'node:fs/promises';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { openPiHostSessionAdapterV2 } from '@loopwright/agent-pi/host-session';
import {
  inspectRun,
  loadTrustedConfiguration,
  runCycleWithPorts,
  signPayload,
  verifySignedPayload,
  type ControllerPorts,
  type ReportCheckItem,
} from '@loopwright/controller';
import { bindSubject, isWritablePath, validateDocument, type ArtifactManifest, type TaskContract, type UsageSummary } from '@loopwright/core';
import { reopenLocalRun, type LocalRunIdentity, type PageCursor } from '@loopwright/state';
import { LOOPWRIGHT_ACTIVE_PROVIDER_TOKEN_ENV } from './models-config.js';
import { sanitizeReportText } from './output-format.js';
import { SecretScrubber } from './token-broker.js';
import {
  GitHubAppError,
  LOCAL_COMMAND_GATE_ENDPOINT_ID,
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

const execFileAsync = promisify(execFile);

const MAX_REQUEST_BODY_BYTES = 262_144;
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

function isProtectedCandidatePath(name: string, protectedPaths: readonly string[]): boolean {
  for (const protectedEntry of protectedPaths) {
    const clean = protectedEntry.endsWith('/**') ? protectedEntry.slice(0, -3) : protectedEntry;
    if (name === clean || name.startsWith(clean.endsWith('/') ? clean : `${clean}/`)) {
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
      await materializeCandidateFiles(candidateDir, snapshot.files);

      const childEnv = buildSandboxedChildEnv(
        gate,
        candidateDir,
        scratchHome,
        scratchTmp,
        options.runtimeEnv,
        options.readOnlyGitHubToken,
        options.forbiddenEnvNames,
      );

      const result = await runCommandScript(scriptCopyPath, candidateDir, childEnv, gate.timeoutSeconds * 1000);
      if (!result.timedOut && result.exitCode === 0) {
        writeSignedJsonResponse(res, 200, signingSecret, makeVerdict('approved', null));
      } else {
        const prefix = result.timedOut
          ? `command timed out after ${gate.timeoutSeconds}s`
          : `command exited with status ${result.exitCode ?? 'signal'}`;
        const rawReason = result.output.length > 0 ? `${prefix}: ${result.output}` : prefix;
        writeSignedJsonResponse(res, 200, signingSecret, makeVerdict('denied', sanitizeFailureReason(rawReason)));
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
  const timeoutMs = maxTimeoutSeconds * 1000 + 5_000;

  return {
    url,
    signingSecret,
    endpointPlan: {
      id: LOCAL_COMMAND_GATE_ENDPOINT_ID,
      url,
      signingCredentialRef: 'taskpack-local-command-signing',
      authCredentialRef: null,
      timeoutMs,
      maxPollMs: timeoutMs + 15_000,
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

async function listRegularFilesAtRevision(
  repositoryRoot: string,
  revision: string,
): Promise<ReadonlyMap<string, string>> {
  const gitBin = resolveGitExecutable();
  const { stdout } = await execFileAsync(
    gitBin,
    ['-C', repositoryRoot, 'ls-tree', '-rz', '--full-tree', revision],
    { env: buildCleanGitEnv(), encoding: 'buffer', maxBuffer: 8 * 1024 * 1024 },
  );
  const entries = new Map<string, string>();
  const parts = stdout.toString('utf8').split('\0');
  for (const part of parts) {
    if (part.length === 0) continue;
    const tabIdx = part.indexOf('\t');
    if (tabIdx <= 0) continue;
    const meta = part.slice(0, tabIdx);
    const path = part.slice(tabIdx + 1);
    const fields = meta.split(' ');
    const mode = fields[0];
    const type = fields[1];
    if (type === 'blob' && (mode === '100644' || mode === '100755')) {
      entries.set(path, mode);
    }
  }
  return entries;
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

/**
 * Start a loopback HTTP server implementing Loopwright's signed publication protocol
 * with a detached temporary `git worktree` (preserving repository `HEAD` and
 * protected paths/symlinks) and `--force-with-lease` push protection.
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

    const workRoot = await mkdtemp(join(scratchBase, 'wt-'));
    await chmod(workRoot, 0o700);
    const worktreeDir = join(workRoot, 'checkout');
    const gitBin = resolveGitExecutable();
    const gitEnv = buildGitAuthEnv(options.gitWriteToken);
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

      await execFileAsync(
        gitBin,
        ['-c', 'core.hooksPath=/dev/null', '-C', options.repositoryRoot, 'worktree', 'add', '--detach', worktreeDir, baseRevision],
        { env: gitEnv, timeout: 15_000 },
      );

      const sourceModes = await listRegularFilesAtRevision(options.repositoryRoot, sourceRevision);
      const candidateNames = new Set<string>();
      const filesToAdd: string[] = [];

      for (const file of snapshot.files) {
        candidateNames.add(file.name);
        if (!isAllowedCandidateWrite(file.name, snapshot)) {
          continue;
        }
        const dest = resolve(worktreeDir, file.name);
        const parent = dirname(dest);
        assertNoSymlinkSegments(worktreeDir, parent);
        await mkdir(parent, { recursive: true });
        assertNoSymlinkSegments(worktreeDir, parent);
        const existingStats = lstatSync(dest, { throwIfNoEntry: false });
        if (existingStats?.isSymbolicLink()) {
          throw new GitHubAppError('ACTION_INPUT_INVALID', `refusing to overwrite symlink "${file.name}"`);
        }
        const mode = sourceModes.get(file.name) === '100755' ? 0o755 : 0o644;
        const handle = await open(
          dest,
          fsConstants.O_CREAT | fsConstants.O_TRUNC | fsConstants.O_WRONLY | fsConstants.O_NOFOLLOW,
          mode,
        );
        try {
          await handle.writeFile(file.bytes);
        } finally {
          await handle.close();
        }
        if (mode === 0o755) {
          await chmod(dest, 0o755);
        }
        filesToAdd.push(file.name);
      }

      if (filesToAdd.length > 0) {
        await execFileAsync(
          gitBin,
          ['-c', 'core.hooksPath=/dev/null', '-C', worktreeDir, 'add', '--', ...filesToAdd],
          { env: gitEnv, timeout: 15_000 },
        );
      }

      const filesToRemove: string[] = [];
      for (const sourceName of sourceModes.keys()) {
        if (!candidateNames.has(sourceName) && isAllowedCandidateWrite(sourceName, snapshot)) {
          filesToRemove.push(sourceName);
        }
      }
      if (filesToRemove.length > 0) {
        await execFileAsync(
          gitBin,
          ['-c', 'core.hooksPath=/dev/null', '-C', worktreeDir, 'rm', '-f', '--ignore-unmatch', '--', ...filesToRemove],
          { env: gitEnv, timeout: 15_000 },
        );
      }

      const { stdout: statusOut } = await execFileAsync(
        gitBin,
        ['-c', 'core.hooksPath=/dev/null', '-C', worktreeDir, 'status', '--porcelain'],
        { env: gitEnv, encoding: 'utf8', timeout: 15_000 },
      );
      if (statusOut.trim().length > 0) {
        await execFileAsync(
          gitBin,
          [
            '-c', 'core.hooksPath=/dev/null',
            '-c', 'user.name=Loopwright Bot',
            '-c', 'user.email=loopwright[bot]@users.noreply.github.com',
            '-C', worktreeDir,
            'commit',
            '-s',
            '-m', title,
          ],
          { env: gitEnv, timeout: 15_000 },
        );
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
        const { stdout: remoteOut } = await execFileAsync(
          gitBin,
          ['-c', 'core.hooksPath=/dev/null', ...protocolArgs, '-C', worktreeDir, 'ls-remote', '--', remote, `refs/heads/${branchName}`],
          { env: gitEnv, encoding: 'utf8', timeout: 15_000 },
        );
        const existingRef = remoteOut.split(/\r?\n/).some(line => line.trim().length > 0);
        if (existingRef) {
          throw new GitHubAppError(
            'ACTION_INPUT_INVALID',
            `refusing to overwrite existing remote branch refs/heads/${branchName} without an associated open managed PR`,
          );
        }
      }

      mutationStarted = true;
      await execFileAsync(
        gitBin,
        [
          '-c', 'core.hooksPath=/dev/null',
          ...protocolArgs,
          '-C', worktreeDir,
          'push',
          `--force-with-lease=refs/heads/${branchName}:${expectedRemoteOid}`,
          '--',
          remote,
          `HEAD:refs/heads/${branchName}`,
        ],
        { env: gitEnv, timeout: 25_000 },
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
        const prBody = `Automated Loopwright update for run \`${runId}\` (\`${candidateDigest.slice(0, 12)}\`).`;
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
      await execFileAsync(
        gitBin,
        ['-c', 'core.hooksPath=/dev/null', '-C', options.repositoryRoot, 'worktree', 'remove', '--force', worktreeDir],
        { env: gitEnv, timeout: 10_000 },
      ).catch(() => undefined);
      await execFileAsync(
        gitBin,
        ['-c', 'core.hooksPath=/dev/null', '-C', options.repositoryRoot, 'worktree', 'prune'],
        { env: gitEnv, timeout: 10_000 },
      ).catch(() => undefined);
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

      const opened = await openPiHostSessionAdapterV2(wrappedHost, adapterInput);
      if (!opened.ok) {
        observedPiErrorDetail = `${opened.error.code} (${opened.error.phase})`;
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
              observedPiErrorDetail = `capture:${res.error.code} (${res.error.phase})`;
            }
            return res;
          },
          close: () => inner.close(),
          cancel: input => inner.cancel(input),
          compact: async input => {
            const res = await inner.compact(input);
            if (!res.ok) {
              observedPiErrorDetail = `${res.error.code} (${res.error.phase})`;
              if (isRetryablePiFailure(res.error)) {
                observedRetryablePiFailure = true;
              }
            } else if (res.value.error !== null) {
              observedPiErrorDetail = `${res.value.error.code} (${res.value.error.phase})`;
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
            const res = await inner.execute(input);
            if (!res.ok) {
              observedPiErrorDetail = `${res.error.code} (${res.error.phase})`;
              if (isRetryablePiFailure(res.error)) {
                observedRetryablePiFailure = true;
              }
            } else if (res.value.error !== null) {
              observedPiErrorDetail = `${res.value.error.code} (${res.value.error.phase})`;
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
        ok: false as const,
        code: cycleResult.error.code,
        detail: scrubber.scrub(`runCycle failed: ${cycleResult.error.code} (${cycleResult.error.phase})`),
      };
    }

    const execution = cycleResult.value;
    if (execution.kind === 'incident') {
      return {
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
    return {
      ok: passed,
      code: passed ? null : runResultStatus.toUpperCase(),
      detail: `run ${attemptRunId} settled as ${runResultStatus}`,
    };
  });

  const rawSummaryHolder = await mkdtemp(join(tmpdir(), 'loopwright-summary-'));
  await chmod(rawSummaryHolder, 0o700);
  const summaryHolder = await realpath(rawSummaryHolder);
  const tempInspectDir = join(summaryHolder, 'bundle');
  let inspectedStatus = cycleOutcome.ok ? 'completed' : 'failed';
  let externalUrl: string | null = null;
  let usage: UsageSummary | null = null;
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
      extraInfo = await inspectRunChecksAndExternalWrites(runRoot, attemptRunId, tempInspectDir);
    }
  } finally {
    await rm(summaryHolder, { recursive: true, force: true }).catch(() => undefined);
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
    detail: cycleOutcome.detail,
    externalUrl,
    usage,
    checks: extraInfo.checks,
    elapsedMs: Math.max(1, Math.round(performance.now() - startedMs)),
    retryableProviderFailure,
  };
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
