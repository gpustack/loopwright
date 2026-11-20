import { spawn, spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { constants as fsConstants, existsSync } from 'node:fs';
import { chmod, lstat, mkdir, mkdtemp, open, readdir, readFile, realpath, rm } from 'node:fs/promises';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import type { Readable, Writable } from 'node:stream';
import { STANDARD_PI_PROVIDER_ENV } from '@loopwright/agent-pi/catalog';
import {
  openPiHostSessionAdapterV2,
  type HostSessionCircuitBreakerOptions,
  type HostSessionProgressEvent,
} from '@loopwright/agent-pi/host-session';
import type { HostMcpRegistry } from '@loopwright/agent-pi/mcp';
import { DECISION_PROVIDER_API_KEY_ENV } from '@loopwright/decisions';
import {
  formatDurationMs,
  formatTokenCount,
  inspectRun,
  loadTrustedConfiguration,
  runCycleWithPorts,
  signGateVerdict,
  signPayload,
  verifySignedPayload,
  type AdvisoryDecisionPort,
  type ControllerPorts,
  type ReportCheckItem,
  type StepMcpServerMetadata,
} from '@loopwright/controller';
import {
  bindSubject,
  digestArtifact,
  isWritablePath,
  LIMITS,
  matchesScopePattern,
  validateDocument,
  validateRelativePath,
  type ArtifactManifest,
  type BaseTreeAnchor,
  type MetricsMap,
  type MetricValue,
  type StructuredFinding,
  type TaskContract,
  type UsageSummary,
} from '@loopwright/core';
import { reopenLocalRun, type LocalRunIdentity, type PageCursor } from '@loopwright/state';
import { buildDefaultAuthorPrompt, createTaskpackDecisionPort, insideRoot } from './action.js';
import { computeDirectoryTreeDigest } from './digests.js';
import { LOOPWRIGHT_ACTIVE_PROVIDER_TOKEN_ENV } from './models-config.js';
import { sanitizeReportText } from './output-format.js';
import {
  collectManifestSecretEnvNames,
  formatWorkspaceResourcesManifest,
  isForbiddenPreflightEnvName,
  PREFLIGHT_MAX_WORKSPACE_RESOURCES_TOTAL_BYTES,
  runTaskpackPreflight,
  type RunTaskpackPreflightResult,
} from './preflight.js';
import { IDENTIFIER_PATTERN, normalizeRelativePath } from './schema.js';
import {
  compileDeclarativeTaskpack,
  DEFAULT_HOST_BUDGETS,
  loadDeclarativeTaskpack,
  mergeTaskpackLimits,
  parseActionInputLimits,
  parseLoopwrightEnvLimits,
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
  type ExecutionHostPolicy,
  type GitCommitIdentity,
  type HostGateEndpointPlan,
  type HostPublicationEndpointPlan,
  type TaskpackUpstreamRecord,
  type WrittenCompiledTaskpack,
} from './types.js';
import {
  assertNoSymlinkSegments,
  buildCleanGitEnv,
  COMMIT_SHA_PATTERN,
  DEFAULT_GIT_COMMIT_IDENTITY,
  discoverTaskpackUpstreamsV2,
  fetchBoundedText,
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
export const MAX_GIT_LIST_BYTES = 16 * 1024 * 1024;
const MAX_SCRIPT_BYTES = 262_144;
const MAX_STDIO_BYTES = 1_048_576;
export const MAX_REASON_CODEPOINTS = 256;
const DEFAULT_LOCAL_COMMAND_SYNC_WAIT_MS = 10_000;
const MAX_LOCAL_COMMAND_SYNC_WAIT_MS = 60_000;
const MAX_SETTLED_GATE_JOBS = 64;
const LOCAL_GATE_HTTP_HEADERS_TIMEOUT_MS = 60_000;
const SHA256_HEX_PATTERN = /^[0-9a-f]{64}$/;
export const SAFE_BRANCH_PATTERN = /^[A-Za-z0-9._/-]{1,200}$/;
export const CONTROLLER_ID_PATTERN = /^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/;
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

export function truncateCodePoints(text: string, maxCodePoints: number): string {
  const chars = Array.from(text);
  return chars.length <= maxCodePoints ? text : chars.slice(0, maxCodePoints).join('');
}

function isForbiddenChildEnvName(key: string, forbiddenEnvNames?: ReadonlySet<string>): boolean {
  if (FORBIDDEN_CHILD_ENV_NAMES.has(key) || forbiddenEnvNames?.has(key) === true) return true;
  const poolMatch = /^(.+)_([1-9]|1[0-6])$/.exec(key);
  if (
    poolMatch !== null
    && (FORBIDDEN_CHILD_ENV_NAMES.has(poolMatch[1]!) || forbiddenEnvNames?.has(poolMatch[1]!) === true)
  ) {
    return true;
  }
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
  if (res.destroyed || res.writableEnded) return;
  const cleaned = stripUndefinedFields(payload);
  const body = Buffer.from(canonicalJson(cleaned), 'utf8');
  const signature = isPlainRecord(cleaned) && cleaned['kind'] === 'gate_verdict'
    ? signGateVerdict(signingSecret, cleaned)
    : signPayload(signingSecret, body);
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
    const directMatch = matchesScopePattern(protectedEntry, name);
    if (directMatch.ok && directMatch.value) return true;
    const clean = normalizeProtectedPrefix(protectedEntry);
    if (clean.length === 0) continue;
    if (!clean.includes('*') && !clean.includes('?')) {
      if (name === clean || name.startsWith(`${clean}/`)) {
        return true;
      }
    } else {
      const subtreeMatch = matchesScopePattern(`${clean}/**`, name);
      if (subtreeMatch.ok && subtreeMatch.value) {
        return true;
      }
    }
  }
  return false;
}

function isAllowedCandidateWrite(
  name: string,
  snapshot: Pick<InspectedCandidateSnapshot, 'contract' | 'protectedPaths'>,
): boolean {
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
    const overlayLimits = validLock.value.spec.contract.spec.budgets.overlay;
    const overlayOpts = overlayLimits !== undefined ? { overlay: overlayLimits } : undefined;
    const validManifest = validateDocument(candidateFilesRaw['manifest'], 'ArtifactManifest', overlayOpts);
    if (!validManifest.ok) {
      throw new GitHubAppError('ACTION_INPUT_INVALID', 'inspected candidate manifest failed ArtifactManifest validation');
    }
    const bound = bindSubject(validLock.value, validManifest.value, overlayOpts);
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

async function makeTreeReadOnly(rootDir: string): Promise<void> {
  const entries = await readdir(rootDir, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    const childPath = join(rootDir, entry.name);
    const st = await lstat(childPath).catch(() => null);
    if (st === null || st.isSymbolicLink()) continue;
    if (st.isDirectory()) {
      await makeTreeReadOnly(childPath);
    } else if (st.isFile()) {
      const mode = (st.mode & 0o111) !== 0 ? 0o555 : 0o444;
      await chmod(childPath, mode);
    }
  }
  await chmod(rootDir, 0o555);
}

async function makeTreeWritableForCleanup(rootDir: string): Promise<void> {
  const st = await lstat(rootDir).catch(() => null);
  if (st === null || st.isSymbolicLink() || !st.isDirectory()) return;
  await chmod(rootDir, 0o700).catch(() => undefined);
  const entries = await readdir(rootDir, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    const childPath = join(rootDir, entry.name);
    const childStat = await lstat(childPath).catch(() => null);
    if (childStat === null || childStat.isSymbolicLink()) continue;
    if (childStat.isDirectory()) {
      await makeTreeWritableForCleanup(childPath);
    } else if (childStat.isFile()) {
      await chmod(childPath, 0o600).catch(() => undefined);
    }
  }
}

async function copyDirectoryTreeReadOnly(
  srcDir: string,
  destDir: string,
  options?: {
    readonly maxFiles?: number | undefined;
    readonly maxTotalBytes?: number | undefined;
    readonly excludeTopLevelLower?: ReadonlySet<string> | undefined;
    readonly skipFinalChmod?: boolean | undefined;
  },
): Promise<void> {
  const maxFiles = options?.maxFiles ?? 4_096;
  const maxTotalBytes = options?.maxTotalBytes ?? 64 * 1024 * 1024;
  const excludeTopLevelLower = options?.excludeTopLevelLower;
  let copiedFiles = 0;
  let copiedBytes = 0;

  const walk = async (curSrc: string, curDest: string, depth: number): Promise<void> => {
    if (depth > 32) {
      throw new GitHubAppError('ACTION_INPUT_INVALID', 'mounted directory exceeds maximum depth 32');
    }
    const srcStat = await lstat(curSrc);
    if (srcStat.isSymbolicLink() || !srcStat.isDirectory()) {
      throw new GitHubAppError('ACTION_INPUT_INVALID', `mounted directory "${curSrc}" must be a non-symlink directory`);
    }
    await mkdir(curDest, { recursive: true, mode: 0o700 });
    const names = (await readdir(curSrc)).sort();
    for (const name of names) {
      if (depth === 0 && excludeTopLevelLower?.has(name.toLowerCase()) === true) {
        continue;
      }
      const childSrc = join(curSrc, name);
      const childDest = join(curDest, name);
      const st = await lstat(childSrc);
      if (st.isSymbolicLink()) {
        throw new GitHubAppError('TASKPACK_SCOPE_VIOLATION', `symlink "${childSrc}" is forbidden inside mounted directory`);
      }
      if (st.isDirectory()) {
        await walk(childSrc, childDest, depth + 1);
      } else if (st.isFile()) {
        copiedFiles += 1;
        if (copiedFiles > maxFiles || copiedBytes + st.size > maxTotalBytes) {
          throw new GitHubAppError('ACTION_INPUT_INVALID', 'mounted directory exceeds file or byte cap');
        }
        const handle = await open(childSrc, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
        let bytes: Buffer;
        let execBit: boolean;
        try {
          const fstat = await handle.stat();
          if (!fstat.isFile() || fstat.size !== st.size) {
            throw new GitHubAppError('ACTION_INPUT_INVALID', `mounted file "${childSrc}" changed during read`);
          }
          execBit = (fstat.mode & 0o111) !== 0;
          bytes = await handle.readFile();
        } finally {
          await handle.close();
        }
        copiedBytes += bytes.byteLength;
        const destHandle = await open(
          childDest,
          fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY | fsConstants.O_NOFOLLOW,
          execBit ? 0o555 : 0o444,
        );
        try {
          await destHandle.writeFile(bytes);
        } finally {
          await destHandle.close();
        }
        await chmod(childDest, execBit ? 0o555 : 0o444);
      }
    }
  };

  await walk(srcDir, destDir, 0);
  if (options?.skipFinalChmod !== true) {
    await makeTreeReadOnly(destDir);
  }
}

const EXCLUDED_READ_ONLY_GIT_TOP_LEVEL: ReadonlySet<string> = new Set([
  'hooks',
  'credentials',
  'config',
  'config.worktree',
]);

const SANITIZED_READ_ONLY_GIT_CONFIG = [
  '[core]',
  '\trepositoryformatversion = 0',
  '\tfilemode = true',
  '\tbare = false',
  '\tlogallrefupdates = false',
  '\thooksPath = /dev/null',
  '\tfsmonitor = false',
  '',
].join('\n');

async function stageSanitizedReadOnlyGitDir(srcGitDir: string, destGitDir: string): Promise<void> {
  await copyDirectoryTreeReadOnly(srcGitDir, destGitDir, {
    excludeTopLevelLower: EXCLUDED_READ_ONLY_GIT_TOP_LEVEL,
    skipFinalChmod: true,
  });
  const configDest = join(destGitDir, 'config');
  const handle = await open(
    configDest,
    fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY | fsConstants.O_NOFOLLOW,
    0o444,
  );
  try {
    await handle.writeFile(Buffer.from(SANITIZED_READ_ONLY_GIT_CONFIG, 'utf8'));
  } finally {
    await handle.close();
  }
  await chmod(configDest, 0o444);
  await makeTreeReadOnly(destGitDir);
}

async function verifyAndStageCommandScriptDir(
  repositoryRoot: string,
  gate: CompiledLocalCommandGate,
  checkDir: string,
): Promise<string> {
  if (!SHA256_HEX_PATTERN.test(gate.scriptSha256)) {
    throw new GitHubAppError('ACTION_INPUT_INVALID', 'gate script sha256 metadata is invalid');
  }
  const cleanScriptRel = normalizeCandidateRelativePath(gate.script);
  const scriptDirRel = gate.scriptDir ?? (() => {
    const slash = cleanScriptRel.lastIndexOf('/');
    return slash > 0 ? cleanScriptRel.slice(0, slash) : '.';
  })();

  if (scriptDirRel !== '.' && scriptDirRel.length > 0) {
    const liveDirDigest = await computeDirectoryTreeDigest(repositoryRoot, scriptDirRel);
    if (gate.scriptDirSha256 !== undefined) {
      if (!SHA256_HEX_PATTERN.test(gate.scriptDirSha256)) {
        throw new GitHubAppError('ACTION_INPUT_INVALID', 'gate scriptDirSha256 metadata is invalid');
      }
      if (liveDirDigest.digest !== gate.scriptDirSha256) {
        throw new GitHubAppError(
          'ACTION_INPUT_INVALID',
          `gate script directory "${scriptDirRel}" sha256 changed on disk`,
        );
      }
    }
    const relInsideDir = cleanScriptRel.slice(scriptDirRel.length + 1);
    await mkdir(checkDir, { recursive: true, mode: 0o700 });
    for (const fileEntry of liveDirDigest.files) {
      const srcPath = resolve(repositoryRoot, scriptDirRel, fileEntry.path);
      assertNoSymlinkSegments(repositoryRoot, srcPath);
      const handle = await open(srcPath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
      let bytes: Buffer;
      let isExec: boolean;
      try {
        const info = await handle.stat();
        if (!info.isFile()) {
          throw new GitHubAppError('ACTION_INPUT_INVALID', `gate helper "${fileEntry.path}" is not a regular file`);
        }
        if (fileEntry.path === relInsideDir && info.size > MAX_SCRIPT_BYTES) {
          throw new GitHubAppError('ACTION_INPUT_INVALID', `gate script "${gate.script}" exceeds ${MAX_SCRIPT_BYTES} bytes`);
        }
        isExec = fileEntry.path === relInsideDir || (info.mode & 0o111) !== 0;
        bytes = await handle.readFile();
      } finally {
        await handle.close();
      }
      const actualDigest = createHash('sha256').update(bytes).digest('hex');
      if (actualDigest !== fileEntry.sha256) {
        throw new GitHubAppError('ACTION_INPUT_INVALID', `gate file "${fileEntry.path}" sha256 changed during copy`);
      }
      if (fileEntry.path === relInsideDir && actualDigest !== gate.scriptSha256) {
        throw new GitHubAppError('ACTION_INPUT_INVALID', `gate script "${gate.script}" sha256 changed on disk`);
      }
      const destPath = resolve(checkDir, fileEntry.path);
      await mkdir(dirname(destPath), { recursive: true, mode: 0o700 });
      const destHandle = await open(
        destPath,
        fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY | fsConstants.O_NOFOLLOW,
        isExec ? 0o555 : 0o444,
      );
      try {
        await destHandle.writeFile(bytes);
      } finally {
        await destHandle.close();
      }
      await chmod(destPath, isExec ? 0o555 : 0o444);
    }
    const mountedScriptPath = resolve(checkDir, relInsideDir);
    if (!existsSync(mountedScriptPath)) {
      throw new GitHubAppError('ACTION_INPUT_INVALID', `gate script "${gate.script}" missing inside "${scriptDirRel}"`);
    }
    await makeTreeReadOnly(checkDir);
    return mountedScriptPath;
  }

  await mkdir(checkDir, { recursive: true, mode: 0o700 });
  const fullPath = resolve(repositoryRoot, cleanScriptRel);
  assertNoSymlinkSegments(repositoryRoot, fullPath);
  const handle = await open(fullPath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  let bytes: Buffer;
  try {
    const info = await handle.stat();
    if (!info.isFile()) {
      throw new GitHubAppError('ACTION_INPUT_INVALID', `gate script "${gate.script}" is not a regular file`);
    }
    if (info.size > MAX_SCRIPT_BYTES) {
      throw new GitHubAppError('ACTION_INPUT_INVALID', `gate script "${gate.script}" exceeds ${MAX_SCRIPT_BYTES} bytes`);
    }
    bytes = await handle.readFile();
    const digest = createHash('sha256').update(bytes).digest('hex');
    if (digest !== gate.scriptSha256) {
      throw new GitHubAppError('ACTION_INPUT_INVALID', `gate script "${gate.script}" sha256 changed on disk`);
    }
  } finally {
    await handle.close();
  }
  const destPath = join(checkDir, basename(cleanScriptRel));
  const destHandle = await open(
    destPath,
    fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY | fsConstants.O_NOFOLLOW,
    0o555,
  );
  try {
    await destHandle.writeFile(bytes);
  } finally {
    await destHandle.close();
  }
  await chmod(destPath, 0o555);
  await makeTreeReadOnly(checkDir);
  return destPath;
}

const CHECK_OUT_LONE_SURROGATE_PATTERN = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u;
const CHECK_OUT_METRIC_KEY_PATTERN = /^[A-Za-z_][A-Za-z0-9._-]*$/;
const MAX_CHECK_OUT_BYTES = 65_536;

interface ValidatedCheckOutPayload {
  readonly detail?: string | null | undefined;
  readonly metrics?: Readonly<Record<string, MetricValue>> | undefined;
  readonly findings?: readonly StructuredFinding[] | undefined;
}

function parseStrictCheckOutJson(source: string): unknown {
  let offset = 0;
  let nodes = 0;
  const skipSpace = (): void => {
    while (offset < source.length && /[\t\n\r ]/.test(source[offset]!)) offset += 1;
  };
  const readJsonString = (): string => {
    const start = offset++;
    while (offset < source.length) {
      const ch = source[offset++];
      if (ch === '\\') {
        offset += 1;
        continue;
      }
      if (ch === '"') {
        const parsed: unknown = JSON.parse(source.slice(start, offset));
        if (typeof parsed !== 'string' || parsed.length > 16_384 || CHECK_OUT_LONE_SURROGATE_PATTERN.test(parsed)) {
          throw new GitHubAppError('ACTION_INPUT_INVALID', 'LOOPWRIGHT_CHECK_OUT string exceeds bounds or contains lone surrogates');
        }
        return parsed;
      }
    }
    throw new GitHubAppError('ACTION_INPUT_INVALID', 'LOOPWRIGHT_CHECK_OUT contains unterminated string');
  };
  const scanValue = (depth: number): void => {
    nodes += 1;
    if (nodes > 8_192 || depth > 32) {
      throw new GitHubAppError('ACTION_INPUT_INVALID', 'LOOPWRIGHT_CHECK_OUT exceeds JSON complexity bounds');
    }
    skipSpace();
    const ch = source[offset];
    if (ch === '"') {
      readJsonString();
      return;
    }
    if (ch === '{' || ch === '[') {
      offset += 1;
      skipSpace();
      const close = ch === '{' ? '}' : ']';
      const seenKeys = new Set<string>();
      let count = 0;
      if (source[offset] === close) {
        offset += 1;
        return;
      }
      for (;;) {
        count += 1;
        if (count > 128) {
          throw new GitHubAppError('ACTION_INPUT_INVALID', 'LOOPWRIGHT_CHECK_OUT collection exceeds 128 items');
        }
        skipSpace();
        if (ch === '{') {
          if (source[offset] !== '"') {
            throw new GitHubAppError('ACTION_INPUT_INVALID', 'LOOPWRIGHT_CHECK_OUT object key must be a string');
          }
          const key = readJsonString();
          if (STAGED_FORBIDDEN_KEYS.has(key) || seenKeys.has(key)) {
            throw new GitHubAppError('ACTION_INPUT_INVALID', `LOOPWRIGHT_CHECK_OUT duplicate or forbidden key "${key}"`);
          }
          seenKeys.add(key);
          skipSpace();
          if (source[offset++] !== ':') {
            throw new GitHubAppError('ACTION_INPUT_INVALID', 'LOOPWRIGHT_CHECK_OUT invalid object syntax');
          }
        }
        scanValue(depth + 1);
        skipSpace();
        const delim = source[offset++];
        if (delim === close) return;
        if (delim !== ',') {
          throw new GitHubAppError('ACTION_INPUT_INVALID', 'LOOPWRIGHT_CHECK_OUT invalid delimiter');
        }
      }
    }
    const lit = /^(?:true|false|null|-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?)/.exec(source.slice(offset));
    if (!lit) {
      throw new GitHubAppError('ACTION_INPUT_INVALID', 'LOOPWRIGHT_CHECK_OUT invalid JSON token');
    }
    offset += lit[0].length;
    if (lit[0] !== 'true' && lit[0] !== 'false' && lit[0] !== 'null') {
      const num = Number(lit[0]);
      if (!Number.isFinite(num)) {
        throw new GitHubAppError('ACTION_INPUT_INVALID', 'LOOPWRIGHT_CHECK_OUT non-finite number');
      }
    }
  };

  scanValue(1);
  skipSpace();
  if (offset !== source.length) {
    throw new GitHubAppError('ACTION_INPUT_INVALID', 'LOOPWRIGHT_CHECK_OUT trailing bytes');
  }
  return JSON.parse(source) as unknown;
}

async function readAndValidateCheckOutFile(
  checkOutPath: string,
  scrubber: SecretScrubber,
): Promise<ValidatedCheckOutPayload | null> {
  let st;
  try {
    st = await lstat(checkOutPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return null;
    }
    throw new GitHubAppError('ACTION_INPUT_INVALID', 'LOOPWRIGHT_CHECK_OUT could not be inspected');
  }
  if (st.isSymbolicLink() || !st.isFile() || st.nlink !== 1 || st.size > MAX_CHECK_OUT_BYTES) {
    throw new GitHubAppError(
      'ACTION_INPUT_INVALID',
      'LOOPWRIGHT_CHECK_OUT must be a regular non-hardlinked file of at most 65536 bytes',
    );
  }
  const handle = await open(checkOutPath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  let rawBytes: Buffer;
  try {
    const fstat = await handle.stat();
    if (!fstat.isFile() || fstat.nlink !== 1 || fstat.size !== st.size || fstat.size > MAX_CHECK_OUT_BYTES) {
      throw new GitHubAppError('ACTION_INPUT_INVALID', 'LOOPWRIGHT_CHECK_OUT changed during read');
    }
    rawBytes = await handle.readFile();
  } finally {
    await handle.close();
  }
  const textContent = new TextDecoder('utf-8', { fatal: true }).decode(rawBytes);
  const parsed = parseStrictCheckOutJson(textContent);
  if (!isPlainRecord(parsed)) {
    throw new GitHubAppError('ACTION_INPUT_INVALID', 'LOOPWRIGHT_CHECK_OUT must be a JSON object');
  }
  for (const key of Object.keys(parsed)) {
    if (key !== 'detail' && key !== 'metrics' && key !== 'findings') {
      throw new GitHubAppError('ACTION_INPUT_INVALID', `LOOPWRIGHT_CHECK_OUT contains unsupported field "${key}"`);
    }
  }

  let detail: string | null | undefined;
  if (Object.hasOwn(parsed, 'detail') && parsed['detail'] !== undefined) {
    if (parsed['detail'] === null) {
      detail = null;
    } else if (
      typeof parsed['detail'] === 'string'
      && parsed['detail'].length >= 1
      && parsed['detail'].length <= LIMITS.string
      && !CHECK_OUT_LONE_SURROGATE_PATTERN.test(parsed['detail'])
    ) {
      const scrubbed = truncateCodePoints(scrubber.scrub(parsed['detail']), 4_096);
      detail = scrubbed.length > 0 ? scrubbed : '[REDACTED]';
    } else {
      throw new GitHubAppError('ACTION_INPUT_INVALID', 'LOOPWRIGHT_CHECK_OUT detail must be a non-empty string or null');
    }
  }

  let metrics: Readonly<Record<string, MetricValue>> | undefined;
  if (Object.hasOwn(parsed, 'metrics') && parsed['metrics'] !== undefined) {
    const rawMetrics = parsed['metrics'];
    if (!isPlainRecord(rawMetrics)) {
      throw new GitHubAppError('ACTION_INPUT_INVALID', 'LOOPWRIGHT_CHECK_OUT metrics must be a plain object');
    }
    const keys = Object.keys(rawMetrics).sort();
    if (keys.length > LIMITS.metricEntries) {
      throw new GitHubAppError('ACTION_INPUT_INVALID', `LOOPWRIGHT_CHECK_OUT metrics exceeds ${LIMITS.metricEntries} entries`);
    }
    const cleanMetrics: Record<string, MetricValue> = {};
    for (const key of keys) {
      if (
        key.length < 1
        || key.length > LIMITS.metricKey
        || STAGED_FORBIDDEN_KEYS.has(key)
        || !CHECK_OUT_METRIC_KEY_PATTERN.test(key)
      ) {
        throw new GitHubAppError('ACTION_INPUT_INVALID', `LOOPWRIGHT_CHECK_OUT metric key "${key}" is invalid`);
      }
      const val = rawMetrics[key];
      if (typeof val === 'number') {
        if (!Number.isFinite(val)) {
          throw new GitHubAppError('ACTION_INPUT_INVALID', `LOOPWRIGHT_CHECK_OUT metric "${key}" must be finite`);
        }
        cleanMetrics[key] = Object.is(val, -0) ? 0 : val;
      } else if (typeof val === 'boolean') {
        cleanMetrics[key] = val;
      } else if (
        typeof val === 'string'
        && val.length <= LIMITS.metricStringValue
        && !CHECK_OUT_LONE_SURROGATE_PATTERN.test(val)
      ) {
        cleanMetrics[key] = truncateCodePoints(scrubber.scrub(val), LIMITS.metricStringValue);
      } else {
        throw new GitHubAppError('ACTION_INPUT_INVALID', `LOOPWRIGHT_CHECK_OUT metric "${key}" value is invalid`);
      }
    }
    metrics = Object.freeze(cleanMetrics);
  }

  let findings: readonly StructuredFinding[] | undefined;
  if (Object.hasOwn(parsed, 'findings') && parsed['findings'] !== undefined) {
    const rawFindings = parsed['findings'];
    if (!Array.isArray(rawFindings) || rawFindings.length > LIMITS.findings) {
      throw new GitHubAppError('ACTION_INPUT_INVALID', `LOOPWRIGHT_CHECK_OUT findings must be an array of at most ${LIMITS.findings} items`);
    }
    const cleanFindings: StructuredFinding[] = [];
    for (const item of rawFindings) {
      if (!isPlainRecord(item)) {
        throw new GitHubAppError('ACTION_INPUT_INVALID', 'LOOPWRIGHT_CHECK_OUT finding must be an object');
      }
      for (const k of Object.keys(item)) {
        if (k !== 'title' && k !== 'severity' && k !== 'evidence' && k !== 'path' && k !== 'line') {
          throw new GitHubAppError('ACTION_INPUT_INVALID', `LOOPWRIGHT_CHECK_OUT finding has unknown key "${k}"`);
        }
      }
      const rawTitle = item['title'];
      const rawSeverity = item['severity'];
      const rawEvidence = item['evidence'];
      if (
        typeof rawTitle !== 'string' || rawTitle.length < 1 || rawTitle.length > LIMITS.findingTitle
        || CHECK_OUT_LONE_SURROGATE_PATTERN.test(rawTitle)
        || (rawSeverity !== 'critical' && rawSeverity !== 'high' && rawSeverity !== 'medium' && rawSeverity !== 'low')
        || typeof rawEvidence !== 'string' || rawEvidence.length < 1 || rawEvidence.length > LIMITS.findingEvidence
        || CHECK_OUT_LONE_SURROGATE_PATTERN.test(rawEvidence)
      ) {
        throw new GitHubAppError('ACTION_INPUT_INVALID', 'LOOPWRIGHT_CHECK_OUT finding fields are invalid');
      }
      const title = truncateCodePoints(scrubber.scrub(rawTitle), LIMITS.findingTitle) || '[REDACTED]';
      const evidence = truncateCodePoints(scrubber.scrub(rawEvidence), LIMITS.findingEvidence) || '[REDACTED]';
      let findingPath: string | null | undefined;
      if (Object.hasOwn(item, 'path') && item['path'] !== undefined) {
        if (item['path'] === null) {
          findingPath = null;
        } else if (typeof item['path'] === 'string' && !CHECK_OUT_LONE_SURROGATE_PATTERN.test(item['path'])) {
          const v = validateRelativePath(item['path']);
          if (!v.ok) {
            throw new GitHubAppError('ACTION_INPUT_INVALID', 'LOOPWRIGHT_CHECK_OUT finding path is invalid');
          }
          findingPath = v.value;
        } else {
          throw new GitHubAppError('ACTION_INPUT_INVALID', 'LOOPWRIGHT_CHECK_OUT finding path must be relative string or null');
        }
      }
      let findingLine: number | null | undefined;
      if (Object.hasOwn(item, 'line') && item['line'] !== undefined) {
        if (item['line'] === null) {
          findingLine = null;
        } else if (typeof item['line'] === 'number' && Number.isSafeInteger(item['line']) && item['line'] >= 1) {
          findingLine = item['line'];
        } else {
          throw new GitHubAppError('ACTION_INPUT_INVALID', 'LOOPWRIGHT_CHECK_OUT finding line must be positive integer or null');
        }
      }
      cleanFindings.push(Object.freeze({
        title,
        severity: rawSeverity,
        ...(findingPath !== undefined ? { path: findingPath } : {}),
        ...(findingLine !== undefined ? { line: findingLine } : {}),
        evidence,
      }));
    }
    findings = Object.freeze(cleanFindings);
  }

  return Object.freeze({
    ...(detail !== undefined ? { detail } : {}),
    ...(metrics !== undefined ? { metrics } : {}),
    ...(findings !== undefined ? { findings } : {}),
  });
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

export interface ExecGitOptions {
  readonly env: Record<string, string>;
  readonly input?: Buffer | string | undefined;
  readonly timeoutMs?: number | undefined;
  readonly maxStdoutBytes?: number | undefined;
}

export interface DetailedGitResult {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly timedOut: boolean;
  readonly stdoutOverflow: boolean;
  readonly spawnError: string | null;
  readonly stdout: Buffer;
  readonly stderr: Buffer;
}

export async function execGitDetailed(
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

export async function execGit(
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
  baseDir: string,
  checkOutPath: string,
  scratchHome: string,
  scratchTmp: string,
  runtimeEnv: NodeJS.ProcessEnv | undefined,
  readOnlyGitHubToken: string | undefined,
  forbiddenEnvNames?: ReadonlySet<string> | undefined,
  resolvedToolchainPaths?: readonly string[] | undefined,
  checkStagedDir?: string | null | undefined,
): Record<string, string> {
  const childEnv: Record<string, string> = {};

  if (gate.allowHostEnv === true && runtimeEnv !== undefined) {
    for (const [key, value] of Object.entries(runtimeEnv)) {
      if (typeof value !== 'string') continue;
      if (
        key === 'PATH' || key === 'HOME' || key === 'TMPDIR' || key === 'LANG' || key === 'LC_ALL'
        || isForbiddenChildEnvName(key, forbiddenEnvNames)
        || isForbiddenPreflightEnvName(key, forbiddenEnvNames)
      ) {
        continue;
      }
      childEnv[key] = value;
    }
  }

  for (const envName of gate.env) {
    if (isForbiddenChildEnvName(envName, forbiddenEnvNames) || isForbiddenPreflightEnvName(envName, forbiddenEnvNames)) {
      throw new GitHubAppError('ACTION_INPUT_INVALID', `forbidden env variable "${envName}" in command.v1 gate`);
    }
    const value = runtimeEnv?.[envName];
    if (typeof value === 'string') {
      childEnv[envName] = value;
    }
  }

  if (gate.envMap !== undefined) {
    for (const [envName, envValue] of Object.entries(gate.envMap)) {
      if (isForbiddenChildEnvName(envName, forbiddenEnvNames) || isForbiddenPreflightEnvName(envName, forbiddenEnvNames)) {
        throw new GitHubAppError('ACTION_INPUT_INVALID', `forbidden envMap variable "${envName}" in command.v1 gate`);
      }
      childEnv[envName] = envValue;
    }
  }

  const hostPath = gate.allowHostPath === true ? runtimeEnv?.['PATH'] : undefined;
  const basePath = typeof hostPath === 'string' && hostPath.trim().length > 0
    ? hostPath.trim()
    : '/usr/local/bin:/usr/bin:/bin';
  const effectivePath = resolvedToolchainPaths !== undefined && resolvedToolchainPaths.length > 0
    ? `${resolvedToolchainPaths.join(':')}:${basePath}`
    : basePath;

  childEnv['PATH'] = effectivePath;
  childEnv['HOME'] = scratchHome;
  childEnv['TMPDIR'] = scratchTmp;
  childEnv['LANG'] = 'C.UTF-8';
  childEnv['LC_ALL'] = 'C.UTF-8';
  childEnv['GIT_CONFIG_NOSYSTEM'] = '1';
  childEnv['GIT_CONFIG_GLOBAL'] = '/dev/null';
  childEnv['LOOPWRIGHT_CANDIDATE_DIR'] = candidateDir;
  childEnv['LOOPWRIGHT_BASE_DIR'] = baseDir;
  childEnv['LOOPWRIGHT_CHECK_ID'] = gate.checkId;
  childEnv['LOOPWRIGHT_CHECK_OUT'] = checkOutPath;
  if (typeof checkStagedDir === 'string' && checkStagedDir.length > 0) {
    childEnv['LOOPWRIGHT_STAGED_DIR'] = checkStagedDir;
  }

  if (gate.allowReadOnlyGitHubToken && typeof readOnlyGitHubToken === 'string' && readOnlyGitHubToken.length > 0) {
    childEnv['GITHUB_TOKEN'] = readOnlyGitHubToken;
  }
  return childEnv;
}

class BoundedTailBuffer {
  readonly #maxBytes: number;
  #chunks: Buffer[] = [];
  #totalBytes = 0;
  overflow = false;

  constructor(maxBytes: number) {
    this.#maxBytes = maxBytes;
  }

  append(chunk: Buffer): void {
    if (chunk.byteLength === 0) return;
    if (chunk.byteLength >= this.#maxBytes) {
      this.overflow = true;
      this.#chunks = [chunk.subarray(chunk.byteLength - this.#maxBytes)];
      this.#totalBytes = this.#maxBytes;
      return;
    }
    this.#chunks.push(chunk);
    this.#totalBytes += chunk.byteLength;
    while (this.#totalBytes > this.#maxBytes && this.#chunks.length > 0) {
      this.overflow = true;
      const excess = this.#totalBytes - this.#maxBytes;
      const head = this.#chunks[0]!;
      if (head.byteLength <= excess) {
        this.#chunks.shift();
        this.#totalBytes -= head.byteLength;
      } else {
        this.#chunks[0] = head.subarray(excess);
        this.#totalBytes -= excess;
      }
    }
  }

  toString(): string {
    if (this.#chunks.length === 0) return '';
    let buf = Buffer.concat(this.#chunks);
    if (this.overflow) {
      let start = 0;
      while (start < buf.byteLength && start < 3 && (buf[start]! & 0xc0) === 0x80) {
        start += 1;
      }
      if (start > 0) buf = buf.subarray(start);
    }
    return buf.toString('utf8');
  }
}

function tailCodePoints(text: string, maxCodePoints: number): string {
  if (maxCodePoints <= 0) return '';
  const chars = Array.from(text);
  if (chars.length <= maxCodePoints) return text;
  if (maxCodePoints <= 3) return chars.slice(chars.length - maxCodePoints).join('');
  return `...${chars.slice(chars.length - (maxCodePoints - 3)).join('')}`;
}

function formatCommandFailureOutput(
  stdoutText: string,
  stderrText: string,
  overflow: boolean,
): string {
  const stdoutClean = stdoutText.replace(/\s+/g, ' ').trim();
  const stderrClean = stderrText.replace(/\s+/g, ' ').trim();
  const suffix = overflow ? ' [output truncated]' : '';
  const budget = Math.max(16, MAX_REASON_CODEPOINTS - 48 - suffix.length);

  if (stderrClean.length === 0 && stdoutClean.length === 0) {
    return overflow ? '[output truncated]' : '';
  }
  if (stderrClean.length === 0) {
    return `${tailCodePoints(stdoutClean, budget)}${suffix}`;
  }
  if (stdoutClean.length === 0) {
    return `${tailCodePoints(stderrClean, budget)}${suffix}`;
  }

  const pairBudget = Math.max(8, budget - 3);
  const stderrLen = Array.from(stderrClean).length;
  const stdoutLen = Array.from(stdoutClean).length;
  const half = Math.floor(pairBudget / 2);
  let stderrBudget: number;
  let stdoutBudget: number;
  if (stderrLen <= half) {
    stderrBudget = stderrLen;
    stdoutBudget = pairBudget - stderrBudget;
  } else if (stdoutLen <= half) {
    stdoutBudget = stdoutLen;
    stderrBudget = pairBudget - stdoutBudget;
  } else {
    stderrBudget = half;
    stdoutBudget = pairBudget - stderrBudget;
  }
  const stderrPart = tailCodePoints(stderrClean, stderrBudget);
  const stdoutPart = tailCodePoints(stdoutClean, stdoutBudget);
  return `${stderrPart} | ${stdoutPart}${suffix}`;
}

interface RunCommandScriptOptions {
  readonly args?: readonly string[] | undefined;
  readonly allowCheckNetwork?: boolean | undefined;
  readonly signal?: AbortSignal | undefined;
  readonly registerKiller?: ((kill: () => void) => () => void) | undefined;
  readonly onLog?: ((line: string) => void) | undefined;
}

const CHECK_NO_NET_SEATBELT_PROFILE = '(version 1)(allow default)(deny network*)';
let cachedLinuxBwrapNetPath: string | null | undefined;

function resolveLinuxBwrapForNoNet(): string | null {
  if (cachedLinuxBwrapNetPath !== undefined) return cachedLinuxBwrapNetPath;
  for (const candidate of ['/usr/bin/bwrap', '/bin/bwrap']) {
    if (!existsSync(candidate)) continue;
    const probe = spawnSync(
      candidate,
      ['--unshare-net', '--die-with-parent', '--ro-bind', '/', '/', '--', '/bin/true'],
      { stdio: 'ignore', timeout: 3_000 },
    );
    if (probe.status === 0 && probe.error === undefined) {
      cachedLinuxBwrapNetPath = candidate;
      return candidate;
    }
  }
  cachedLinuxBwrapNetPath = null;
  return null;
}

async function runCommandScript(
  scriptFullPath: string,
  cwd: string,
  env: Record<string, string>,
  timeoutMs: number,
  options?: RunCommandScriptOptions,
): Promise<{ readonly exitCode: number | null; readonly timedOut: boolean; readonly output: string }> {
  if (options?.signal?.aborted) {
    return {
      exitCode: null,
      timedOut: false,
      output: 'command aborted during server shutdown',
    };
  }
  const shell = resolveShellExecutable();
  const baseArgs = [scriptFullPath, ...(options?.args ?? [])];
  let spawnCmd = shell;
  let spawnArgs = baseArgs;
  if (options?.allowCheckNetwork !== true) {
    let isolated = false;
    if (process.platform === 'darwin' && existsSync('/usr/bin/sandbox-exec')) {
      spawnCmd = '/usr/bin/sandbox-exec';
      spawnArgs = ['-p', CHECK_NO_NET_SEATBELT_PROFILE, shell, ...baseArgs];
      isolated = true;
    } else if (process.platform === 'linux') {
      const bwrapBin = resolveLinuxBwrapForNoNet();
      if (bwrapBin !== null) {
        spawnCmd = bwrapBin;
        spawnArgs = ['--unshare-net', '--die-with-parent', '--bind', '/', '/', '--dev', '/dev', '--proc', '/proc', '--', shell, ...baseArgs];
        isolated = true;
      }
    }
    if (!isolated) {
      options?.onLog?.(
        `warning: command.v1 network isolation unavailable on ${process.platform}; running check without OS network namespace`,
      );
    }
  }
  return await new Promise((resolvePromise, reject) => {
    const child = spawn(spawnCmd, spawnArgs, {
      cwd,
      env,
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    const stdoutBuffer = new BoundedTailBuffer(MAX_STDIO_BYTES);
    const stderrBuffer = new BoundedTailBuffer(MAX_STDIO_BYTES);
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

    const unregisterKiller = options?.registerKiller?.(killProcessGroup);
    const onAbort = (): void => {
      killProcessGroup();
    };
    options?.signal?.addEventListener('abort', onAbort, { once: true });
    if (options?.signal?.aborted) {
      killProcessGroup();
    }

    const timer = setTimeout(() => {
      timedOut = true;
      killProcessGroup();
    }, timeoutMs);
    timer.unref?.();

    const cleanup = (): void => {
      clearTimeout(timer);
      options?.signal?.removeEventListener('abort', onAbort);
      unregisterKiller?.();
    };

    const finish = (code: number | null): void => {
      if (settled) return;
      settled = true;
      cleanup();
      resolvePromise({
        exitCode: code,
        timedOut,
        output: formatCommandFailureOutput(
          stdoutBuffer.toString(),
          stderrBuffer.toString(),
          stdoutBuffer.overflow || stderrBuffer.overflow,
        ),
      });
    };

    child.stdout.on('data', (chunk: Buffer) => stdoutBuffer.append(chunk));
    child.stderr.on('data', (chunk: Buffer) => stderrBuffer.append(chunk));
    child.on('error', err => {
      cleanup();
      if (!settled) {
        settled = true;
        reject(new GitHubAppError('ACTION_INPUT_INVALID', `command.v1 script failed to spawn: ${err.message}`));
      }
    });
    child.on('close', code => finish(code));
  });
}

async function waitForJobOrTimer(
  jobPromise: Promise<void>,
  waitMs: number,
  signal: AbortSignal,
): Promise<void> {
  if (waitMs <= 0 || signal.aborted) return;
  await new Promise<void>(resolveWait => {
    let done = false;
    const finish = (): void => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
      resolveWait();
    };
    const onAbort = (): void => finish();
    const timer = setTimeout(finish, waitMs);
    timer.unref?.();
    signal.addEventListener('abort', onAbort, { once: true });
    void jobPromise.then(finish, finish);
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
  readonly checkStagedDir?: string | null | undefined;
  readonly syncWaitMs?: number | undefined;
  readonly onLog?: ((line: string) => void) | undefined;
}

export interface LocalCommandGateServer {
  readonly url: string;
  readonly signingSecret: string;
  readonly endpointPlan: HostGateEndpointPlan;
  close(): Promise<void>;
}

interface LocalCommandGateJob {
  readonly key: string;
  promise: Promise<void>;
  settled: {
    readonly status: 'approved' | 'denied';
    readonly reason: string | null;
    readonly extra?: ValidatedCheckOutPayload | null | undefined;
  } | null;
}

const DEFAULT_COMMAND_PATH_ENTRIES: ReadonlySet<string> = new Set(['/usr/local/bin', '/usr/bin', '/bin']);

async function validateGateToolchainPath(
  tp: string,
  gate: CompiledLocalCommandGate,
  repositoryRoot: string,
  realTmpRoot: string,
): Promise<{ readonly kind: 'absolute'; readonly realPath: string } | { readonly kind: 'relative'; readonly fullPath: string }> {
  if (tp.startsWith('/')) {
    const tpStat = await lstat(tp).catch(() => null);
    if (tpStat === null || tpStat.isSymbolicLink() || !tpStat.isDirectory()) {
      throw new GitHubAppError('ACTION_INPUT_INVALID', `toolchainPath "${tp}" must be an existing non-symlink directory`);
    }
    const realTp = await realpath(tp);
    if (gate.allowPrivileged !== true) {
      if (
        insideRoot(realTp, realTmpRoot)
        || insideRoot(realTp, '/tmp')
        || insideRoot(realTp, '/private/tmp')
      ) {
        throw new GitHubAppError(
          'ACTION_INPUT_INVALID',
          `absolute toolchainPath "${tp}" under tmpdir is forbidden without allowPrivileged`,
        );
      }
      if ((tpStat.mode & 0o022) !== 0) {
        const defaultPathHint = DEFAULT_COMMAND_PATH_ENTRIES.has(tp)
          ? ' (default command.v1 PATH already includes /usr/local/bin:/usr/bin:/bin)'
          : '';
        throw new GitHubAppError(
          'ACTION_INPUT_INVALID',
          `absolute toolchainPath "${tp}" must not be group- or world-writable without allowPrivileged${defaultPathHint}`,
        );
      }
      const currentUid = typeof process.getuid === 'function' ? process.getuid() : undefined;
      if (currentUid !== undefined && tpStat.uid !== 0 && tpStat.uid !== currentUid) {
        throw new GitHubAppError(
          'ACTION_INPUT_INVALID',
          `absolute toolchainPath "${tp}" must be owned by root or the current user without allowPrivileged`,
        );
      }
    }
    return { kind: 'absolute', realPath: realTp };
  }
  const cleanTp = normalizeCandidateRelativePath(tp);
  const fullTp = resolve(repositoryRoot, cleanTp);
  assertNoSymlinkSegments(repositoryRoot, fullTp);
  const relStat = await lstat(fullTp).catch(() => null);
  if (relStat === null || relStat.isSymbolicLink() || !relStat.isDirectory()) {
    throw new GitHubAppError('ACTION_INPUT_INVALID', `toolchainPath "${tp}" must be an existing non-symlink directory`);
  }
  return { kind: 'relative', fullPath: fullTp };
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

  const realTmpRoot = await realpath(tmpdir()).catch(() => resolve(tmpdir()));
  for (const gate of options.gates) {
    for (const tp of gate.toolchainPaths ?? []) {
      await validateGateToolchainPath(tp, gate, options.repositoryRoot, realTmpRoot);
    }
  }

  const ownedScratch = options.scratchRoot === undefined;
  const rawScratchBase = options.scratchRoot ?? await mkdtemp(join(tmpdir(), 'loopwright-gate-'));
  await chmod(rawScratchBase, 0o700);
  const scratchBase = await realpath(rawScratchBase);

  const syncWaitMs = options.syncWaitMs === undefined || !Number.isFinite(options.syncWaitMs)
    ? DEFAULT_LOCAL_COMMAND_SYNC_WAIT_MS
    : Math.min(MAX_LOCAL_COMMAND_SYNC_WAIT_MS, Math.max(0, Math.trunc(options.syncWaitMs)));

  const host = options.host ?? '127.0.0.1';
  const gateMap = new Map<string, CompiledLocalCommandGate>();
  let maxTimeoutSeconds = 30;
  for (const gate of options.gates) {
    gateMap.set(`${gate.gateId}\0${gate.checkId}`, gate);
    if (gate.timeoutSeconds > maxTimeoutSeconds) maxTimeoutSeconds = gate.timeoutSeconds;
  }
  const verdictTtlMs = Math.min(86_400_000, Math.max(300_000, maxTimeoutSeconds * 1000 + 60_000));

  const jobs = new Map<string, LocalCommandGateJob>();
  const settledOrder: string[] = [];
  const inFlightPromises = new Set<Promise<void>>();
  const activeKillers = new Set<() => void>();
  const baseDirCache = new Map<string, Promise<string>>();
  const cachedBaseDirs = new Set<string>();
  const closeController = new AbortController();
  let closing = false;

  const getOrMaterializeBaseDir = (
    baseRevision: string,
    objectFormat: 'sha1' | 'sha256',
    protectedPaths: readonly string[],
    entries: readonly BaselineRegularEntry[],
    timeoutMs: number,
  ): Promise<string> => {
    const entriesDigest = createHash('sha256')
      .update(entries.map(entry => `${entry.path}\0${entry.mode}\0${entry.oid}`).sort().join('\n'), 'utf8')
      .digest('hex');
    const cacheKey = canonicalJson({ baseRevision, objectFormat, protectedPaths, entriesDigest });
    const existing = baseDirCache.get(cacheKey);
    if (existing !== undefined) return existing;
    const pending = (async () => {
      const dir = await mkdtemp(join(scratchBase, 'base-cache-'));
      cachedBaseDirs.add(dir);
      await chmod(dir, 0o700);
      await materializeBaselineBatchForGate(options.repositoryRoot, objectFormat, entries, dir, timeoutMs);
      await makeTreeReadOnly(dir);
      return dir;
    })();
    baseDirCache.set(cacheKey, pending);
    pending.catch(() => {
      if (baseDirCache.get(cacheKey) === pending) {
        baseDirCache.delete(cacheKey);
      }
    });
    return pending;
  };

  const recordSettled = (
    job: LocalCommandGateJob,
    status: 'approved' | 'denied',
    reason: string | null,
    extra?: ValidatedCheckOutPayload | null,
  ): void => {
    if (job.settled !== null) return;
    job.settled = { status, reason, ...(extra !== undefined ? { extra } : {}) };
    settledOrder.push(job.key);
    while (settledOrder.length > MAX_SETTLED_GATE_JOBS) {
      const oldestKey = settledOrder.shift();
      if (oldestKey !== undefined) {
        const entry = jobs.get(oldestKey);
        if (entry !== undefined && entry.settled !== null) {
          jobs.delete(oldestKey);
        }
      }
    }
  };

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

    const VERDICT_SOFT_BYTE_BUDGET = 64_000;
    const VERDICT_HARD_BYTE_LIMIT = 65_536;
    const makeVerdict = (
      status: 'pending' | 'approved' | 'denied',
      reason: string | null,
      extra?: ValidatedCheckOutPayload | null,
    ) => {
      const includeExtra = status !== 'pending' && extra !== undefined && extra !== null;
      let detail = includeExtra ? extra.detail : undefined;
      let metrics = includeExtra ? extra.metrics : undefined;
      let findings = includeExtra ? extra.findings : undefined;
      const buildObj = (
        d: string | null | undefined,
        m: MetricsMap | undefined,
        f: readonly StructuredFinding[] | undefined,
      ) => ({
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
        reason: status === 'pending' ? null : reason,
        expiresAtMs: String(Date.now() + verdictTtlMs),
        ...(d !== undefined ? { detail: d } : {}),
        ...(m !== undefined ? { metrics: m } : {}),
        ...(f !== undefined ? { findings: f } : {}),
      });
      const serializedBytes = (candidate: unknown): number =>
        Buffer.byteLength(canonicalJson(stripUndefinedFields(candidate)), 'utf8');

      let verdict = buildObj(detail, metrics, findings);
      if (serializedBytes(verdict) > VERDICT_SOFT_BYTE_BUDGET) {
        if (typeof detail === 'string') {
          detail = truncateCodePoints(detail, 512);
          verdict = buildObj(detail, metrics, findings);
        }
        if (serializedBytes(verdict) > VERDICT_SOFT_BYTE_BUDGET && findings !== undefined && findings.length > 0) {
          const trimmedFindings = [...findings];
          while (
            trimmedFindings.length > 0
            && serializedBytes(buildObj(detail, metrics, trimmedFindings)) > VERDICT_SOFT_BYTE_BUDGET
          ) {
            trimmedFindings.pop();
          }
          if (trimmedFindings.length === 0) {
            const first = findings[0]!;
            const compactEvidence = truncateCodePoints(first.evidence, 256);
            if (compactEvidence.length > 0) {
              const compacted = Object.freeze([{ ...first, evidence: compactEvidence }]);
              if (serializedBytes(buildObj(detail, metrics, compacted)) <= VERDICT_SOFT_BYTE_BUDGET) {
                trimmedFindings.push(compacted[0]!);
              }
            }
          }
          findings = trimmedFindings.length > 0 ? Object.freeze(trimmedFindings) : undefined;
          verdict = buildObj(detail, metrics, findings);
        }
        if (serializedBytes(verdict) > VERDICT_SOFT_BYTE_BUDGET && metrics !== undefined) {
          const metricEntries = Object.entries(metrics);
          while (metricEntries.length > 0) {
            metricEntries.pop();
            if (metricEntries.length === 0) {
              metrics = undefined;
              verdict = buildObj(detail, metrics, findings);
              break;
            }
            const nextMap: Record<string, MetricValue> = Object.create(null) as Record<string, MetricValue>;
            for (const [k, v] of metricEntries) {
              nextMap[k] = v;
            }
            const nextMetrics = Object.freeze(nextMap);
            verdict = buildObj(detail, nextMetrics, findings);
            if (serializedBytes(verdict) <= VERDICT_SOFT_BYTE_BUDGET) {
              break;
            }
          }
        }
        if (serializedBytes(verdict) > VERDICT_HARD_BYTE_LIMIT) {
          verdict = buildObj(undefined, undefined, undefined);
        }
      }
      return verdict;
    };

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

    if (closing) {
      writePlainJsonResponse(res, 503, { error: 'server_closing' });
      return;
    }

    const operationKey = canonicalJson({
      storeId,
      runId,
      lockHash,
      operationId,
      dispatchId,
      dispatchGeneration,
      gateId,
      checkId,
      candidateDigest,
    });

    let job = jobs.get(operationKey);
    const isNewJob = job === undefined;
    if (job === undefined) {
      const newJob: LocalCommandGateJob = {
        key: operationKey,
        promise: Promise.resolve(),
        settled: null,
      };
      const runPromise = (async () => {
        let workDir: string | undefined;
        try {
          if (closeController.signal.aborted) {
            recordSettled(newJob, 'denied', sanitizeFailureReason('command gate server closed'));
            return;
          }
          workDir = await mkdtemp(join(scratchBase, 'exec-'));
          await chmod(workDir, 0o700);
          const candidateHolder = join(workDir, 'candidate');
          await mkdir(candidateHolder, { mode: 0o700 });
          const rawRepoName = basename(resolve(options.repositoryRoot));
          const safeRepoName = /^[A-Za-z0-9._-]+$/.test(rawRepoName) && rawRepoName !== '.' && rawRepoName !== '..'
            ? rawRepoName
            : 'repo';
          const candidateDir = gate.preserveRepoDirName === true
            ? join(candidateHolder, safeRepoName)
            : candidateHolder;
          if (candidateDir !== candidateHolder) {
            await mkdir(candidateDir, { mode: 0o700 });
          }
          let baseDir = join(workDir, 'base');
          const outDir = join(workDir, 'out');
          const checkDir = join(workDir, 'check-dir');
          const scratchHome = join(workDir, 'home');
          const scratchTmp = join(workDir, 'tmp');

          await mkdir(baseDir, { mode: 0o700 });
          await mkdir(outDir, { mode: 0o700 });
          await mkdir(scratchHome, { mode: 0o700 });
          await mkdir(scratchTmp, { mode: 0o700 });

          const scriptCopyPath = await verifyAndStageCommandScriptDir(
            options.repositoryRoot,
            gate,
            checkDir,
          );
          const snapshot = await inspectAndVerifyCandidate(options.runRoot, runId, candidateDigest, workDir);
          const gitEnv = buildCleanGitEnv();
          const deletedPaths = snapshot.manifest.spec.deleted ?? [];
          if (snapshot.manifest.spec.baseTree !== undefined) {
            await verifyBaseTreeAnchor(
              options.repositoryRoot,
              snapshot.manifest.spec.baseTree,
              gitEnv,
              snapshot.sourceRevision,
            );
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
          }

          if (snapshot.sourceRevision !== snapshot.baseRevision) {
            if (!COMMIT_SHA_PATTERN.test(snapshot.baseRevision) || !COMMIT_SHA_PATTERN.test(snapshot.sourceRevision)) {
              throw new GitHubAppError('ACTION_INPUT_INVALID', 'baseRevision and sourceRevision must be 40-hex commit SHAs');
            }
            await execGit(
              options.repositoryRoot,
              ['rev-parse', '--verify', '--end-of-options', `${snapshot.baseRevision}^{commit}`],
              { env: gitEnv, timeoutMs: 15_000 },
            );
            await execGit(
              options.repositoryRoot,
              ['rev-parse', '--verify', '--end-of-options', `${snapshot.sourceRevision}^{commit}`],
              { env: gitEnv, timeoutMs: 15_000 },
            );

            const baseTreeMap = await listTreeEntriesAtRevision(options.repositoryRoot, snapshot.baseRevision, gitEnv);
            const sourceTreeMap = await listTreeEntriesAtRevision(options.repositoryRoot, snapshot.sourceRevision, gitEnv);
            const baseRegularEntries = await listBaselineRegularEntries(
              options.repositoryRoot,
              snapshot.baseRevision,
              snapshot.protectedPaths,
            );
            const sourceRegularEntries = await listBaselineRegularEntries(
              options.repositoryRoot,
              snapshot.sourceRevision,
              snapshot.protectedPaths,
            );
            const sourceRegularByPath = new Map(sourceRegularEntries.map(entry => [entry.path, entry] as const));
            const { carryRemovals, carryUpdates } = computeAllowedSourceRevisionCarryDelta(
              snapshot,
              baseTreeMap,
              sourceTreeMap,
            );

            const effectiveBaseline = new Map<string, BaselineRegularEntry>(
              baseRegularEntries.map(entry => [entry.path, entry] as const),
            );
            await applyCarryDeltaToEffectiveBaseline(
              options.repositoryRoot,
              effectiveBaseline,
              sourceRegularByPath,
              carryRemovals,
              carryUpdates,
              gitEnv,
            );

            const baselineModes = new Map<string, '100644' | '100755'>();
            for (const entry of effectiveBaseline.values()) {
              baselineModes.set(entry.path, entry.mode);
            }

            const overlayFilesToMaterialize = snapshot.manifest.spec.baseTree !== undefined
              ? snapshot.files
              : snapshot.files.filter(file => isAllowedCandidateWrite(file.name, snapshot));
            for (const file of overlayFilesToMaterialize) {
              if (hasSymlinkAtOrAbove(file.name, baseTreeMap, sourceTreeMap)) {
                throw new GitHubAppError(
                  'ACTION_INPUT_INVALID',
                  'Refusing to materialize symlinked candidate path during command.v1 verification.',
                );
              }
            }

            const effectiveDeletedPaths: string[] = [];
            if (snapshot.manifest.spec.baseTree !== undefined) {
              for (const rawDeleted of deletedPaths) {
                const deletedName = normalizeCandidateRelativePath(rawDeleted);
                if (!hasSymlinkAtOrAbove(deletedName, baseTreeMap, sourceTreeMap)) {
                  effectiveDeletedPaths.push(deletedName);
                }
              }
            } else {
              if (snapshot.manifest.spec.deleted !== undefined || snapshot.manifest.apiVersion !== 'loopwright.dev/v1alpha1') {
                throw new GitHubAppError(
                  'ACTION_INPUT_INVALID',
                  'candidate manifest missing baseTree in non-classic snapshot mode',
                );
              }
              const candidateNames = new Set(snapshot.files.map(file => file.name));
              for (const [sourceName, sourceEntry] of sourceTreeMap.entries()) {
                if (sourceEntry.mode !== '100644' && sourceEntry.mode !== '100755') continue;
                if (
                  !candidateNames.has(sourceName)
                  && isAllowedCandidateWrite(sourceName, snapshot)
                  && !hasSymlinkAtOrAbove(sourceName, baseTreeMap, sourceTreeMap)
                ) {
                  effectiveDeletedPaths.push(sourceName);
                }
              }
            }

            const deletedSet = new Set(effectiveDeletedPaths);
            const overlayNames = new Set(overlayFilesToMaterialize.map(file => file.name));
            const toMaterialize = Array.from(effectiveBaseline.values()).filter(
              entry => !deletedSet.has(entry.path) && !overlayNames.has(entry.path),
            );
            const objectFormat = snapshot.manifest.spec.baseTree?.objectFormat ?? 'sha1';
            baseDir = await getOrMaterializeBaseDir(
              snapshot.baseRevision,
              objectFormat,
              snapshot.protectedPaths,
              baseRegularEntries,
              Math.max(60_000, gate.timeoutSeconds * 1000),
            );
            await materializeBaselineBatchForGate(
              options.repositoryRoot,
              objectFormat,
              toMaterialize,
              candidateDir,
              Math.max(60_000, gate.timeoutSeconds * 1000),
            );
            await materializeOverlayCandidateFiles(candidateDir, overlayFilesToMaterialize, baselineModes);
            await assertDeletedPathsAbsent(candidateDir, effectiveDeletedPaths);
          } else if (snapshot.manifest.spec.baseTree !== undefined) {
            const baselineEntries = await listBaselineRegularEntries(
              options.repositoryRoot,
              snapshot.manifest.spec.baseTree.commitOid,
              snapshot.protectedPaths,
            );
            const baselineModes = new Map<string, '100644' | '100755'>();
            for (const entry of baselineEntries) {
              baselineModes.set(entry.path, entry.mode);
            }
            const deletedSet = new Set(deletedPaths);
            const overlayNames = new Set(snapshot.files.map(file => file.name));
            const toMaterialize = baselineEntries.filter(
              entry => !deletedSet.has(entry.path) && !overlayNames.has(entry.path),
            );
            baseDir = await getOrMaterializeBaseDir(
              snapshot.manifest.spec.baseTree.commitOid,
              snapshot.manifest.spec.baseTree.objectFormat,
              snapshot.protectedPaths,
              baselineEntries,
              Math.max(60_000, gate.timeoutSeconds * 1000),
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
            if (existsSync(join(options.repositoryRoot, '.git')) && COMMIT_SHA_PATTERN.test(snapshot.baseRevision)) {
              const baselineEntries = await listBaselineRegularEntries(
                options.repositoryRoot,
                snapshot.baseRevision,
                snapshot.protectedPaths,
              );
              baseDir = await getOrMaterializeBaseDir(
                snapshot.baseRevision,
                'sha1',
                snapshot.protectedPaths,
                baselineEntries,
                Math.max(60_000, gate.timeoutSeconds * 1000),
              );
            } else {
              await makeTreeReadOnly(baseDir);
            }
          }

          if (gate.mountReadOnlyGit === true) {
            const srcGitDir = join(options.repositoryRoot, '.git');
            const gitStat = await lstat(srcGitDir).catch(() => null);
            if (gitStat !== null) {
              if (gitStat.isSymbolicLink() || !gitStat.isDirectory()) {
                throw new GitHubAppError('ACTION_INPUT_INVALID', 'repository .git must be a non-symlink directory for mountReadOnlyGit');
              }
              await stageSanitizedReadOnlyGitDir(srcGitDir, join(candidateDir, '.git'));
            }
          }

          const resolvedToolchainPaths: string[] = [];
          const requestTmpRoot = await realpath(tmpdir()).catch(() => resolve(tmpdir()));
          for (const [tpIndex, tp] of (gate.toolchainPaths ?? []).entries()) {
            const validated = await validateGateToolchainPath(tp, gate, options.repositoryRoot, requestTmpRoot);
            if (validated.kind === 'absolute') {
              resolvedToolchainPaths.push(validated.realPath);
            } else {
              const destTp = join(workDir, 'toolchains', String(tpIndex));
              await copyDirectoryTreeReadOnly(validated.fullPath, destTp);
              resolvedToolchainPaths.push(destTp);
            }
          }

          if (closeController.signal.aborted) {
            recordSettled(newJob, 'denied', sanitizeFailureReason('command gate server closed'));
            return;
          }

          const checkOutPath = join(outDir, 'check-out.json');
          const childEnv = buildSandboxedChildEnv(
            gate,
            candidateDir,
            baseDir,
            checkOutPath,
            scratchHome,
            scratchTmp,
            options.runtimeEnv,
            options.readOnlyGitHubToken,
            options.forbiddenEnvNames,
            resolvedToolchainPaths,
            options.checkStagedDir,
          );

          options.onLog?.(scrubber.scrub(
            `check ${gate.checkId}: running ${gate.script} (timeout ${formatDurationMs(gate.timeoutSeconds * 1000)})`,
          ));
          const cmdStarted = performance.now();
          const result = await runCommandScript(
            scriptCopyPath,
            candidateDir,
            childEnv,
            gate.timeoutSeconds * 1000,
            {
              args: gate.args,
              allowCheckNetwork: gate.allowCheckNetwork === true,
              signal: closeController.signal,
              onLog: options.onLog === undefined ? undefined : line => options.onLog?.(scrubber.scrub(line)),
              registerKiller: kill => {
                activeKillers.add(kill);
                return () => {
                  activeKillers.delete(kill);
                };
              },
            },
          );
          const cmdElapsed = Math.max(1, Math.round(performance.now() - cmdStarted));
          const checkOutPayload = await readAndValidateCheckOutFile(checkOutPath, scrubber);
          if (!result.timedOut && result.exitCode === 0) {
            options.onLog?.(scrubber.scrub(`check ${gate.checkId}: passed (${formatDurationMs(cmdElapsed)})`));
            recordSettled(newJob, 'approved', null, checkOutPayload);
          } else {
            const prefix = result.timedOut
              ? `command timed out after ${gate.timeoutSeconds}s`
              : `command exited with status ${result.exitCode ?? 'signal'}`;
            const rawReason = result.output.length > 0 ? `${prefix}: ${result.output}` : prefix;
            const sanitizedReason = sanitizeFailureReason(rawReason);
            options.onLog?.(scrubber.scrub(`check ${gate.checkId}: failed (${formatDurationMs(cmdElapsed)}) — ${sanitizedReason}`));
            recordSettled(newJob, 'denied', sanitizedReason, checkOutPayload);
          }
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          const sanitizedReason = sanitizeFailureReason(message);
          options.onLog?.(scrubber.scrub(`check ${gate.checkId}: failed — ${sanitizedReason}`));
          recordSettled(newJob, 'denied', sanitizedReason);
        } finally {
          if (workDir !== undefined) {
            await makeTreeWritableForCleanup(workDir).catch(() => undefined);
            await rm(workDir, { recursive: true, force: true }).catch(() => undefined);
          }
        }
      })();
      const trackedPromise = runPromise.finally(() => {
        inFlightPromises.delete(trackedPromise);
      });
      inFlightPromises.add(trackedPromise);
      newJob.promise = trackedPromise;
      jobs.set(operationKey, newJob);
      job = newJob;
    }

    if (job.settled === null) {
      const waitMs = isNewJob ? syncWaitMs : Math.min(syncWaitMs, 50);
      await waitForJobOrTimer(job.promise, waitMs, closeController.signal);
    }

    if (job.settled !== null) {
      writeSignedJsonResponse(res, 200, signingSecret, makeVerdict(job.settled.status, job.settled.reason, job.settled.extra));
    } else {
      writeSignedJsonResponse(res, 200, signingSecret, makeVerdict('pending', null));
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
    throw new GitHubAppError('ACTION_INPUT_INVALID', 'local command gate server failed to bind TCP port');
  }

  const url = `http://${host}:${address.port}/${LOCAL_COMMAND_GATE_ENDPOINT_ID}`;
  const timeoutMs = Math.min(3_600_000, Math.max(35_000, syncWaitMs + 15_000, maxTimeoutSeconds * 1000 + 15_000));
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
      closing = true;
      const closePromise = new Promise<void>(resolveClose => server.close(() => resolveClose()));
      closeController.abort();
      for (const kill of [...activeKillers]) {
        kill();
      }
      await Promise.allSettled([...inFlightPromises]);
      server.closeIdleConnections?.();
      await closePromise;
      for (const cachedDir of cachedBaseDirs) {
        await makeTreeWritableForCleanup(cachedDir).catch(() => undefined);
        await rm(cachedDir, { recursive: true, force: true }).catch(() => undefined);
      }
      cachedBaseDirs.clear();
      baseDirCache.clear();
      if (ownedScratch) {
        await makeTreeWritableForCleanup(scratchBase).catch(() => undefined);
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

export interface GitTreeEntry {
  readonly mode: string;
  readonly type: string;
  readonly oid: string;
}

export async function listTreeEntriesAtRevision(
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

export function hasSymlinkAtOrAbove(
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

export interface CarryDeltaEntry {
  readonly path: string;
  readonly mode: '100644' | '100755';
  readonly oid: string;
}

/**
 * Compute writable, symlink-free carry removals and updates between `baseEntries`
 * and `sourceEntries` for a candidate snapshot.
 */
export function computeAllowedSourceRevisionCarryDelta(
  snapshot: Pick<InspectedCandidateSnapshot, 'contract' | 'protectedPaths'>,
  baseEntries: ReadonlyMap<string, GitTreeEntry>,
  sourceEntries: ReadonlyMap<string, GitTreeEntry>,
): {
  readonly carryRemovals: readonly string[];
  readonly carryUpdates: readonly CarryDeltaEntry[];
} {
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

  const carryUpdates: CarryDeltaEntry[] = [];
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

  return { carryRemovals, carryUpdates };
}

/**
 * Apply `carryRemovals` and `carryUpdates` onto `effectiveBaseline`, looking up
 * missing blob sizes via `git cat-file -s` and failing closed on missing objects.
 */
export async function applyCarryDeltaToEffectiveBaseline(
  repositoryRoot: string,
  effectiveBaseline: Map<string, BaselineRegularEntry>,
  sourceRegularByPath: ReadonlyMap<string, BaselineRegularEntry>,
  carryRemovals: readonly string[],
  carryUpdates: readonly CarryDeltaEntry[],
  gitEnv: Record<string, string>,
): Promise<void> {
  for (const removedPath of carryRemovals) {
    effectiveBaseline.delete(removedPath);
  }
  for (const update of carryUpdates) {
    const cleanCarryPath = validateBaselineGitPath(update.path);
    const existing = sourceRegularByPath.get(cleanCarryPath);
    let byteLength: number;
    if (existing !== undefined) {
      byteLength = existing.byteLength;
    } else {
      let sizeRaw: string;
      try {
        sizeRaw = (
          await execGit(
            repositoryRoot,
            ['cat-file', '-s', update.oid],
            { env: gitEnv, timeoutMs: 15_000 },
          )
        ).toString('utf8').trim();
      } catch {
        throw new GitHubAppError(
          'ACTION_INPUT_INVALID',
          `failed to read carried baseline blob size for "${cleanCarryPath}" (${update.oid})`,
        );
      }
      byteLength = Number(sizeRaw);
    }
    if (!Number.isSafeInteger(byteLength) || byteLength < 0) {
      throw new GitHubAppError(
        'ACTION_INPUT_INVALID',
        `invalid carried baseline blob byteLength for "${cleanCarryPath}"`,
      );
    }
    effectiveBaseline.set(cleanCarryPath, {
      path: cleanCarryPath,
      mode: update.mode,
      oid: update.oid,
      byteLength,
    });
  }
}

export async function stageEntriesInIndex(
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

export async function removePathsFromIndex(
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

export function buildGitAuthEnv(gitWriteToken: string | undefined): Record<string, string> {
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
const MAX_PR_NOTES_CODEPOINTS = 2_000;
const MAX_VERSION_TABLE_ENTRIES = 500;
const MAX_MODIFIED_PATHS_INPUT = 10_000;
const HEX_DIGEST_VERSION_PATTERN = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/i;
const RUNNER_ENGINE_KEYS = ['engine_version', 'engineVersion', 'engine'] as const;
const RUNNER_PLUGIN_KEYS = ['plugin_version', 'pluginVersion', 'plugin'] as const;
const RUNNER_SUBSCRIPTION_KEYS = ['status', ...RUNNER_ENGINE_KEYS, ...RUNNER_PLUGIN_KEYS, 'reason'] as const;

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
  readonly stagedPaths?: ReadonlySet<string> | undefined;
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
        const stagedPathSet = new Set(stagedFiles.map(entry => entry.path));
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

        let prBodyFiles: readonly { readonly name: string; readonly bytes: Uint8Array }[] = snapshot.files;
        let baseProposalBytes: Uint8Array | undefined;
        if (options.proposalPath !== undefined && options.proposalPath.trim().length > 0) {
          let cleanProposalPath: string | undefined;
          try {
            cleanProposalPath = normalizeCandidateRelativePath(options.proposalPath.trim().replace(/^(?:\.\/)+/, ''));
          } catch {
            cleanProposalPath = undefined;
          }
          if (cleanProposalPath !== undefined) {
            const baseProposalEntry = baseEntries.get(cleanProposalPath);
            if (
              baseProposalEntry !== undefined
              && (baseProposalEntry.mode === '100644' || baseProposalEntry.mode === '100755')
            ) {
              baseProposalBytes = await readBoundedProposalBlob(baseProposalEntry.oid);
            }
          }
          if (
            cleanProposalPath !== undefined
            && !stagedPathSet.has(cleanProposalPath)
            && !filesToRemove.includes(cleanProposalPath)
          ) {
            const carriedProposal = carriedUpdatesByPath.get(cleanProposalPath);
            if (carriedProposal !== undefined) {
              const proposalBytes = await readBoundedProposalBlob(
                carriedProposal.oid,
                `carried proposal "${cleanProposalPath}"`,
              );
              if (proposalBytes !== undefined) {
                stagedPathSet.add(cleanProposalPath);
                prBodyFiles = [...snapshot.files, { name: cleanProposalPath, bytes: proposalBytes }];
              }
            }
          }
        }
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
  readonly mcpServers?: readonly StepMcpServerMetadata[] | undefined;
  readonly decisions?: AdvisoryDecisionPort | undefined;
  readonly allowWorkflowWrites?: boolean | undefined;
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

function parsePositiveIntEnv(env: NodeJS.ProcessEnv, name: string): number | undefined {
  const raw = env[name]?.trim();
  if (!raw || !/^\d+$/.test(raw)) return undefined;
  const parsed = Number(raw);
  return Number.isSafeInteger(parsed) && parsed >= 1 ? parsed : undefined;
}

/**
 * Format a `HostSessionProgressEvent` into a single human-readable progress log line.
 * Callers must pass the returned string through `SecretScrubber.scrub` before emitting.
 */
export function formatHostSessionProgressLog(
  event: HostSessionProgressEvent,
  context: { readonly cumulativeTokens: number; readonly totalTokenBudget: number },
): string | null {
  if (event.kind === 'request_start') {
    return `turn #${event.turn}: dispatching request to ${event.provider}/${event.model}`;
  }
  if (event.kind === 'request_settled') {
    const inTok = formatTokenCount(event.inputTokens);
    const outTok = formatTokenCount(event.outputTokens);
    const cumTok = formatTokenCount(context.cumulativeTokens);
    const budgetTok = formatTokenCount(context.totalTokenBudget);
    const suffix = event.toolCallNames.length > 0
      ? `tools=[${event.toolCallNames.join(', ')}]`
      : `stop=${event.stopReason}`;
    return `turn #${event.turn}: settled in ${formatDurationMs(event.elapsedMs)} — in ${inTok} / out ${outTok} (cum ${cumTok}/${budgetTok}), ${suffix}`;
  }
  if (event.kind === 'tool_end') {
    const summaryPart = event.summary !== undefined && event.summary.length > 0
      ? ` (${event.summary})`
      : '';
    if (event.errorCode !== undefined) {
      const detail = event.errorPath !== undefined && event.errorPath.length > 0
        ? `${event.errorCode} ${event.errorPath}`
        : event.errorCode;
      return `tool ${event.name}${summaryPart}: denied (${detail}) — ${formatDurationMs(event.elapsedMs)}`;
    }
    return `tool ${event.name}${summaryPart}: ${event.isError ? 'error' : 'ok'} (${formatDurationMs(event.elapsedMs)})`;
  }
  if (event.kind === 'circuit_breaker') {
    return event.message;
  }
  return null;
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
    let resultCheckDetails = new Map<string, string>();
    try {
      const resultRaw = JSON.parse(await readFile(join(tempOutputDir, 'result.json'), 'utf8')) as unknown;
      if (isPlainRecord(resultRaw) && isPlainRecord(resultRaw['spec']) && Array.isArray(resultRaw['spec']['checks'])) {
        resultCheckDetails = new Map(
          resultRaw['spec']['checks'].flatMap(entry =>
            isPlainRecord(entry) && typeof entry['checkId'] === 'string' && typeof entry['detail'] === 'string'
              ? [[entry['checkId'], entry['detail']] as const]
              : []),
        );
      }
    } catch {
      // result.json is optional when incident occurred.
    }
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
                : (resultCheckDetails.get(checkId) ?? null),
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
  const totalTokenBudget = options.taskpack.config.spec.task.spec.budgets.totalTokens;
  let cumulativeTokens = 0;
  const envSource = options.runtimeEnv ?? process.env;
  const maxTurnsRaw = envSource['LOOPWRIGHT_MAX_TURNS']?.trim();
  const maxTurnsOverride = parsePositiveIntEnv(envSource, 'LOOPWRIGHT_MAX_TURNS');
  if (maxTurnsRaw && maxTurnsOverride === undefined) {
    options.onLog?.(scrubber.scrub(`warning: ignoring invalid LOOPWRIGHT_MAX_TURNS=${maxTurnsRaw}; expected positive integer`));
  }
  const maxRepairTurnsRaw = envSource['LOOPWRIGHT_MAX_REPAIR_TURNS']?.trim();
  const maxRepairTurnsOverride = parsePositiveIntEnv(envSource, 'LOOPWRIGHT_MAX_REPAIR_TURNS');
  if (maxRepairTurnsRaw && maxRepairTurnsOverride === undefined) {
    options.onLog?.(scrubber.scrub(`warning: ignoring invalid LOOPWRIGHT_MAX_REPAIR_TURNS=${maxRepairTurnsRaw}; expected positive integer`));
  }
  const compiledBreakerLimits = options.taskpack.circuitBreakerLimits;
  const effectiveMaxTurns = maxTurnsOverride ?? compiledBreakerLimits?.maxTurns;
  const effectiveMaxRepairTurns = maxRepairTurnsOverride ?? compiledBreakerLimits?.maxRepairTurns;
  const circuitBreakerOptions: HostSessionCircuitBreakerOptions | undefined =
    effectiveMaxTurns !== undefined || effectiveMaxRepairTurns !== undefined
      ? {
        ...(effectiveMaxTurns !== undefined ? { maxTurns: effectiveMaxTurns } : {}),
        ...(effectiveMaxRepairTurns !== undefined ? { maxRepairTurns: effectiveMaxRepairTurns } : {}),
      }
      : undefined;

  const effectiveAllowWorkflowWrites = options.allowWorkflowWrites ?? options.taskpack.allowWorkflowWrites;
  const ports: ControllerPorts = {
    ...(effectiveAllowWorkflowWrites !== undefined ? { allowWorkflowWrites: effectiveAllowWorkflowWrites } : {}),
    ...(options.taskpack.roleMcpServers !== undefined ? { roleMcpServers: options.taskpack.roleMcpServers } : {}),
    ...(options.mcpServers !== undefined ? { mcpServers: options.mcpServers } : {}),
    ...(options.decisions !== undefined ? { decisions: options.decisions } : {}),
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
          if (event.kind === 'request_settled') {
            cumulativeTokens += Math.max(0, event.inputTokens) + Math.max(0, event.outputTokens);
          }
          const line = formatHostSessionProgressLog(event, { cumulativeTokens, totalTokenBudget });
          if (line !== null) {
            options.onLog!(scrubber.scrub(line));
          }
        };

      const adapterFactory = options.openHostSessionAdapter ?? openPiHostSessionAdapterV2;
      const opened = await adapterFactory(wrappedHost, adapterInput, {
        ...(options.mcpRegistry !== undefined ? { mcpRegistry: options.mcpRegistry } : {}),
        ...(progressHandler !== undefined ? { onProgress: progressHandler } : {}),
        ...(circuitBreakerOptions !== undefined ? { circuitBreaker: circuitBreakerOptions } : {}),
        scrub: text => scrubber.scrub(text),
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
    let candidateVerifiedNoChange = false;
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
          const verifierMatrixRaw = obsRaw['verifierMatrix'];
          const targetSpec = options.taskpack.config.spec.task.spec.target;
          if (
            runResultStatus === 'blocked'
            && observationsDiagnostic === 'EVIDENCE_UNAVAILABLE'
            && requestedStatus === 'no_change'
            && requestedStatusSource === 'captured_submission'
            && targetSpec.baseRevision === targetSpec.sourceRevision
            && Array.isArray(verifierMatrixRaw)
          ) {
            const rows = verifierMatrixRaw.filter((entry): entry is Record<string, unknown> => isPlainRecord(entry));
            const hasNoChangePassed = rows.some(row => row['implicit'] === 'no_change' && row['status'] === 'passed');
            const hasScopePassed = rows.some(row => row['implicit'] === 'scope' && row['status'] === 'passed');
            const allRowsPassed = rows.every(row => row['status'] === 'passed');
            if (rows.length === verifierMatrixRaw.length && hasNoChangePassed && hasScopePassed && allRowsPassed) {
              candidateVerifiedNoChange = true;
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
    const effectiveOk = passed || candidateVerifiedNoChange;
    return {
      kind: 'settled_result' as const,
      ok: effectiveOk,
      code: effectiveOk ? null : runResultStatus.toUpperCase(),
      detail: candidateVerifiedNoChange
        ? `run ${attemptRunId} settled as no_change (candidate unchanged)`
        : `run ${attemptRunId} settled as ${runResultStatus}`,
      settledStatus: effectiveOk ? null : runResultStatus,
      candidateVerifiedNoChange,
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
  if (cycleOutcome.kind === 'settled_result' && cycleOutcome.candidateVerifiedNoChange) {
    inspectedStatus = 'no_change';
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
  readonly hostPolicy?: import('./types.js').ExecutionHostPolicy | undefined;
  readonly allowPrivileged?: boolean | undefined;
  readonly allowWorkflowWrites?: boolean | undefined;
  readonly runPreflight?: boolean | undefined;
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
  readonly allowWorkflowWrites?: boolean | undefined;
  readonly roleMcpServers?: Readonly<Record<string, readonly string[]>> | undefined;
  readonly mcpServers?: readonly import('@loopwright/controller').StepMcpServerMetadata[] | undefined;
  readonly checkStagedDir?: string | null | undefined;
  readonly workspaceStagedDir?: string | null | undefined;
  readonly digests?: Readonly<Record<string, string>> | undefined;
}

export interface OpenStagedTaskpackStepGateOptions {
  readonly runRoot: string;
  readonly runId: string;
  readonly runtimeEnv?: NodeJS.ProcessEnv | undefined;
  readonly decisionTransport?: import('@loopwright/decisions').DecisionTransport | undefined;
  readonly decisionApiKey?: string | undefined;
}

export interface StagedTaskpackStepGateHandle {
  readonly staged: StagedTaskpackForStep;
  readonly environment: (name: string) => string | undefined;
  readonly gateUrlOverrides: Readonly<Record<string, string>>;
  readonly allowWorkflowWrites?: boolean | undefined;
  readonly roleMcpServers?: Readonly<Record<string, readonly string[]>> | undefined;
  readonly mcpServers?: readonly import('@loopwright/controller').StepMcpServerMetadata[] | undefined;
  readonly decisions?: import('@loopwright/controller').AdvisoryDecisionPort | undefined;
  readonly ports?: Pick<import('@loopwright/controller').ControllerPorts, 'gateUrlOverrides' | 'allowWorkflowWrites' | 'roleMcpServers' | 'mcpServers' | 'decisions'> | undefined;
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
  'manifestPath',
  'configPath',
  'registryPath',
  'registrySha256',
  'signingSecret',
  'signingEnvName',
  'localCommandGates',
  'allowWorkflowWrites',
  'roleMcpServers',
  'mcpServers',
  'checkStagedDir',
  'workspaceStagedDir',
  'digests',
]);
const STAGED_GATE_KEYS: ReadonlySet<string> = new Set([
  'checkId',
  'gateId',
  'endpointRef',
  'script',
  'scriptSha256',
  'scriptDir',
  'scriptDirSha256',
  'args',
  'envMap',
  'toolchainPaths',
  'preserveRepoDirName',
  'mountReadOnlyGit',
  'allowHostEnv',
  'allowHostPath',
  'allowCheckNetwork',
  'allowPrivileged',
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
    const scriptDir = typeof gate['scriptDir'] === 'string' && gate['scriptDir'].length > 0 ? gate['scriptDir'] : undefined;
    const scriptDirSha256 = typeof gate['scriptDirSha256'] === 'string' && SHA256_HEX_PATTERN.test(gate['scriptDirSha256'])
      ? gate['scriptDirSha256']
      : undefined;
    const args = Array.isArray(gate['args']) && gate['args'].every(a => typeof a === 'string')
      ? Object.freeze([...(gate['args'] as string[])])
      : undefined;
    const toolchainPaths = Array.isArray(gate['toolchainPaths']) && gate['toolchainPaths'].every(a => typeof a === 'string')
      ? Object.freeze([...(gate['toolchainPaths'] as string[])])
      : undefined;
    let envMap: Readonly<Record<string, string>> | undefined;
    if (isPlainRecord(gate['envMap'])) {
      const cleanMap: Record<string, string> = {};
      for (const [k, v] of Object.entries(gate['envMap'])) {
        if (!STAGED_COMMAND_ENV_NAME_PATTERN.test(k) || isForbiddenChildEnvName(k) || typeof v !== 'string') {
          throw new GitHubAppError('ACTION_INPUT_INVALID', 'staged taskpack localCommandGates envMap is invalid');
        }
        cleanMap[k] = v;
      }
      envMap = Object.freeze(cleanMap);
    }
    localCommandGates.push({
      checkId: gate['checkId'],
      gateId: gate['gateId'],
      endpointRef: LOCAL_COMMAND_GATE_ENDPOINT_ID,
      script: normalizedScript,
      scriptSha256: gate['scriptSha256'],
      ...(scriptDir !== undefined ? { scriptDir } : {}),
      ...(scriptDirSha256 !== undefined ? { scriptDirSha256 } : {}),
      ...(args !== undefined ? { args } : {}),
      ...(envMap !== undefined ? { envMap } : {}),
      ...(toolchainPaths !== undefined ? { toolchainPaths } : {}),
      ...(typeof gate['preserveRepoDirName'] === 'boolean' ? { preserveRepoDirName: gate['preserveRepoDirName'] } : {}),
      ...(typeof gate['mountReadOnlyGit'] === 'boolean' ? { mountReadOnlyGit: gate['mountReadOnlyGit'] } : {}),
      ...(typeof gate['allowHostEnv'] === 'boolean' ? { allowHostEnv: gate['allowHostEnv'] } : {}),
      ...(typeof gate['allowHostPath'] === 'boolean' ? { allowHostPath: gate['allowHostPath'] } : {}),
      ...(typeof gate['allowCheckNetwork'] === 'boolean' ? { allowCheckNetwork: gate['allowCheckNetwork'] } : {}),
      ...(typeof gate['allowPrivileged'] === 'boolean' ? { allowPrivileged: gate['allowPrivileged'] } : {}),
      timeoutSeconds: gate['timeoutSeconds'],
      env: Object.freeze([...(gate['env'] as string[])]),
      allowReadOnlyGitHubToken: gate['allowReadOnlyGitHubToken'],
    });
  }

  const allowWorkflowWrites = typeof parsed['allowWorkflowWrites'] === 'boolean' ? parsed['allowWorkflowWrites'] : undefined;
  let roleMcpServers: Readonly<Record<string, readonly string[]>> | undefined;
  if (isPlainRecord(parsed['roleMcpServers'])) {
    const cleanRoleMcp: Record<string, readonly string[]> = {};
    for (const [roleId, list] of Object.entries(parsed['roleMcpServers'])) {
      if (STAGED_FORBIDDEN_KEYS.has(roleId) || !Array.isArray(list) || list.some(s => typeof s !== 'string')) {
        throw new GitHubAppError('ACTION_INPUT_INVALID', 'staged taskpack roleMcpServers is invalid');
      }
      cleanRoleMcp[roleId] = Object.freeze([...(list as string[])]);
    }
    roleMcpServers = Object.freeze(cleanRoleMcp);
  }
  let mcpServers: readonly StepMcpServerMetadata[] | undefined;
  if (Array.isArray(parsed['mcpServers'])) {
    const cleanServers: StepMcpServerMetadata[] = [];
    for (const item of parsed['mcpServers']) {
      if (
        !isPlainRecord(item)
        || typeof item['id'] !== 'string'
        || (item['transport'] !== 'stdio' && item['transport'] !== 'http')
        || !Array.isArray(item['toolNames'])
        || item['toolNames'].some(t => typeof t !== 'string')
      ) {
        throw new GitHubAppError('ACTION_INPUT_INVALID', 'staged taskpack mcpServers entry is invalid');
      }
      cleanServers.push(Object.freeze({
        id: item['id'],
        transport: item['transport'],
        toolNames: Object.freeze([...(item['toolNames'] as string[])]),
      }));
    }
    mcpServers = Object.freeze(cleanServers);
  }
  const checkStagedDir = typeof parsed['checkStagedDir'] === 'string' && parsed['checkStagedDir'].length > 0
    ? parsed['checkStagedDir']
    : parsed['checkStagedDir'] === null
      ? null
      : undefined;
  const workspaceStagedDir = typeof parsed['workspaceStagedDir'] === 'string' && parsed['workspaceStagedDir'].length > 0
    ? parsed['workspaceStagedDir']
    : parsed['workspaceStagedDir'] === null
      ? null
      : undefined;
  let digests: Readonly<Record<string, string>> | undefined;
  if (isPlainRecord(parsed['digests'])) {
    const cleanDigests: Record<string, string> = {};
    for (const [k, v] of Object.entries(parsed['digests'])) {
      if (!STAGED_FORBIDDEN_KEYS.has(k) && typeof v === 'string') cleanDigests[k] = v;
    }
    digests = Object.freeze(cleanDigests);
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
    ...(allowWorkflowWrites !== undefined ? { allowWorkflowWrites } : {}),
    ...(roleMcpServers !== undefined ? { roleMcpServers } : {}),
    ...(mcpServers !== undefined ? { mcpServers } : {}),
    ...(checkStagedDir !== undefined ? { checkStagedDir } : {}),
    ...(workspaceStagedDir !== undefined ? { workspaceStagedDir } : {}),
    ...(digests !== undefined ? { digests } : {}),
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
  const hostPolicy: ExecutionHostPolicy = {
    allowPrivileged: options.hostPolicy?.allowPrivileged ?? options.allowPrivileged ?? false,
    allowWorkflowWrites: options.hostPolicy?.allowWorkflowWrites ?? options.allowWorkflowWrites ?? false,
  };
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
    hostPolicy,
    executionMode: 'delegated',
  });

  let preflightResult: RunTaskpackPreflightResult | undefined;
  let persistentCheckStagedDir: string | null = null;
  let persistentWorkspaceStagedDir: string | null = null;
  try {
    const shouldRunPreflight = options.runPreflight ?? (manifest.spec.preflight !== undefined);
    if (shouldRunPreflight && manifest.spec.preflight !== undefined) {
      preflightResult = await runTaskpackPreflight({
        manifest,
        repositoryRoot: realRepositoryRoot,
        authorized: true,
        hostPolicy,
        env: runtimeEnv,
        scrubber,
        tempRoot: realRunRoot,
      });
      if (preflightResult.disposition === 'blocked') {
        const rawReason = preflightResult.reason?.trim();
        const message = rawReason !== undefined && rawReason.length > 0
          ? `preflight blocked: ${rawReason}`
          : 'preflight blocked: blocked by preflight';
        throw new GitHubAppError(
          'ACTION_INPUT_INVALID',
          scrubber.scrub(message),
        );
      }
    }

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

    let upstreamRecords: readonly TaskpackUpstreamRecord[] = preflightResult?.upstreams ?? [];
    if (options.upstreamRecordsJson !== undefined) {
      upstreamRecords = parseUpstreamRecordsJson(options.upstreamRecordsJson);
    } else if (
      options.discoverUpstreams !== false
      && manifest.spec.upstreams.length > 0
      && (preflightResult === undefined || preflightResult.upstreams.length === 0)
    ) {
      const discovered = await discoverTaskpackUpstreamsV2(manifest, {
        repositoryRoot: realRepositoryRoot,
        scrubber,
        env: runtimeEnv,
      });
      upstreamRecords = discovered.records;
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

    if (
      preflightResult?.stagedDir !== undefined
      && preflightResult.stagedDir !== null
      && preflightResult.workspaceResources.length > 0
    ) {
      persistentWorkspaceStagedDir = join(stageDir, 'preflight-workspace');
    }

    const wsResourcesManifestText = preflightResult !== undefined && preflightResult.workspaceResources.length > 0
      ? formatWorkspaceResourcesManifest(
        preflightResult.workspaceResources,
        persistentWorkspaceStagedDir,
        scrubber,
      )
      : undefined;
    const baseAuthorPrompt = buildDefaultAuthorPrompt({
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
    const authorPrompt = wsResourcesManifestText !== undefined && wsResourcesManifestText.length > 0
      ? `${baseAuthorPrompt}\n\n${wsResourcesManifestText}`
      : baseAuthorPrompt;

    const compiled = await compileDeclarativeTaskpack(manifest, {
      mode,
      executionMode: 'delegated',
      hostPolicy,
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
      preflightPromptResources: preflightResult?.promptResources,
      preflightWorkspaceResources: preflightResult?.workspaceResources,
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

    if (preflightResult?.checkStagedDir !== undefined && preflightResult.checkStagedDir !== null) {
      persistentCheckStagedDir = join(stageDir, 'preflight-staged');
      await copyDirectoryTreeReadOnly(preflightResult.checkStagedDir, persistentCheckStagedDir, {
        maxTotalBytes: PREFLIGHT_MAX_WORKSPACE_RESOURCES_TOTAL_BYTES,
      });
    }
    if (
      persistentWorkspaceStagedDir !== null
      && preflightResult?.stagedDir !== undefined
      && preflightResult.stagedDir !== null
    ) {
      await copyDirectoryTreeReadOnly(preflightResult.stagedDir, persistentWorkspaceStagedDir, {
        maxTotalBytes: PREFLIGHT_MAX_WORKSPACE_RESOURCES_TOTAL_BYTES,
      });
    }

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

    const mcpServersMeta: readonly StepMcpServerMetadata[] = Object.freeze(
      (manifest.spec.mcp?.servers ?? []).map(srv => Object.freeze({
        id: srv.id,
        transport: srv.transport,
        toolNames: Object.freeze([] as readonly string[]),
      })),
    );

    const localCommandGates = compiled.localCommandGates ?? [];
    const secretsPayload = Buffer.from(
      `${JSON.stringify({
        version: 1,
        runId,
        repositoryRoot: realRepositoryRoot,
        manifestPath: relativeTaskpackPath,
        configPath,
        registryPath,
        registrySha256: compiled.registrySha256,
        signingSecret,
        signingEnvName,
        localCommandGates,
        ...(compiled.allowWorkflowWrites !== undefined ? { allowWorkflowWrites: compiled.allowWorkflowWrites } : {}),
        ...(compiled.roleMcpServers !== undefined ? { roleMcpServers: compiled.roleMcpServers } : {}),
        ...(mcpServersMeta.length > 0 ? { mcpServers: mcpServersMeta } : {}),
        ...(persistentCheckStagedDir !== null ? { checkStagedDir: persistentCheckStagedDir } : {}),
        ...(persistentWorkspaceStagedDir !== null ? { workspaceStagedDir: persistentWorkspaceStagedDir } : {}),
        ...(compiled.digests !== undefined ? { digests: compiled.digests } : {}),
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
      ...(compiled.allowWorkflowWrites !== undefined ? { allowWorkflowWrites: compiled.allowWorkflowWrites } : {}),
      ...(compiled.roleMcpServers !== undefined ? { roleMcpServers: compiled.roleMcpServers } : {}),
      ...(mcpServersMeta.length > 0 ? { mcpServers: mcpServersMeta } : {}),
      ...(persistentCheckStagedDir !== null ? { checkStagedDir: persistentCheckStagedDir } : {}),
      ...(persistentWorkspaceStagedDir !== null ? { workspaceStagedDir: persistentWorkspaceStagedDir } : {}),
      ...(compiled.digests !== undefined ? { digests: compiled.digests } : {}),
    };
  } finally {
    await preflightResult?.cleanup().catch(() => undefined);
  }
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

  const readOnlyGitHubToken = baseEnv['INPUT_GITHUB-TOKEN']?.trim()
    || baseEnv['GITHUB_TOKEN']?.trim()
    || baseEnv['GH_TOKEN']?.trim()
    || undefined;
  const stepScrubber = new SecretScrubber();
  stepScrubber.register(staged.signingSecret);
  if (readOnlyGitHubToken !== undefined) stepScrubber.register(readOnlyGitHubToken);
  if (typeof options.decisionApiKey === 'string' && options.decisionApiKey.trim().length > 0) {
    stepScrubber.register(options.decisionApiKey.trim());
  }
  const decisionApiKeyEnvs = Object.values(DECISION_PROVIDER_API_KEY_ENV).flat();
  const forbiddenEnvNames = new Set<string>([
    staged.signingEnvName,
    ...Object.values(STANDARD_PI_PROVIDER_ENV),
    ...decisionApiKeyEnvs,
  ]);
  for (const key of [
    'GITHUB_TOKEN',
    'GH_TOKEN',
    'INPUT_GITHUB-TOKEN',
    'INPUT_GITHUB-APP-PRIVATE-KEY',
    'LOOPWRIGHT_GATE_SIGNING_SECRET',
    'LOOPWRIGHT_PUBLICATION_SIGNING_SECRET',
    'LOOPWRIGHT_PUBLICATION_AUTH_TOKEN',
    DEFAULT_LOCAL_COMMAND_GATE_ENV,
    ...Object.values(STANDARD_PI_PROVIDER_ENV),
    ...decisionApiKeyEnvs,
  ]) {
    const val = baseEnv[key];
    if (typeof val === 'string' && val.trim().length > 0) {
      stepScrubber.register(val.trim());
    }
  }

  let decisions: AdvisoryDecisionPort | undefined;
  try {
    const rawSecrets = JSON.parse(await readFile(join(stageDir, 'secrets.json'), 'utf8')) as Record<string, unknown>;
    const manifestRel = typeof rawSecrets['manifestPath'] === 'string' ? rawSecrets['manifestPath'] : '.loopwright/taskpack.yaml';
    const manifestSegments = manifestRel.split(/[\\/]/).filter(Boolean);
    if (manifestRel.length === 0 || isAbsolute(manifestRel) || manifestSegments.includes('..')) {
      throw new GitHubAppError(
        'TASKPACK_SCOPE_VIOLATION',
        `staged taskpack manifest path "${manifestRel}" escapes repository root`,
        '/',
      );
    }
    const realStagedRepoRoot = await realpath(staged.repositoryRoot);
    let cursor = realStagedRepoRoot;
    let manifestExists = true;
    let leafStat: Awaited<ReturnType<typeof lstat>> | null = null;
    for (const seg of manifestSegments) {
      cursor = join(cursor, seg);
      const st = await lstat(cursor).catch((err: NodeJS.ErrnoException) => {
        if (err.code === 'ENOENT') return null;
        throw err;
      });
      if (st === null) {
        manifestExists = false;
        break;
      }
      if (st.isSymbolicLink()) {
        throw new GitHubAppError(
          'TASKPACK_SCOPE_VIOLATION',
          `staged taskpack manifest "${manifestRel}" must not contain symbolic links`,
          '/',
        );
      }
      leafStat = st;
    }
    if (manifestExists) {
      if (leafStat === null || !leafStat.isFile()) {
        throw new GitHubAppError(
          'TASKPACK_SCOPE_VIOLATION',
          `staged taskpack manifest "${manifestRel}" must be a regular non-symlink file`,
          '/',
        );
      }
      const realManifest = await realpath(cursor);
      if (!insideRoot(realManifest, realStagedRepoRoot)) {
        throw new GitHubAppError(
          'TASKPACK_SCOPE_VIOLATION',
          `staged taskpack manifest "${manifestRel}" escapes repository root`,
          '/',
        );
      }
      const loadedManifest = await loadDeclarativeTaskpack({
        manifestPath: manifestRel,
        repositoryRoot: staged.repositoryRoot,
        enforceHostAuthority: false,
        executionMode: 'delegated',
      });
      for (const secretEnvName of collectManifestSecretEnvNames(loadedManifest)) {
        forbiddenEnvNames.add(secretEnvName);
        const val = baseEnv[secretEnvName];
        if (typeof val === 'string' && val.trim().length > 0) {
          stepScrubber.register(val.trim());
        }
      }
      decisions = createTaskpackDecisionPort(loadedManifest, {
        runtimeEnv: baseEnv,
        transport: options.decisionTransport,
        apiKey: options.decisionApiKey,
        scrubber: stepScrubber,
        hasPinnedRoles: (loadedManifest.spec.roles ?? []).length > 0,
      });
    }
  } catch (error) {
    if (error instanceof GitHubAppError) {
      throw error;
    }
    decisions = undefined;
  }

  if (staged.localCommandGates.length === 0) {
    const gateUrlOverrides = Object.freeze({});
    const ports = Object.freeze({
      gateUrlOverrides,
      ...(staged.allowWorkflowWrites !== undefined ? { allowWorkflowWrites: staged.allowWorkflowWrites } : {}),
      ...(staged.roleMcpServers !== undefined ? { roleMcpServers: staged.roleMcpServers } : {}),
      ...(staged.mcpServers !== undefined ? { mcpServers: staged.mcpServers } : {}),
      ...(decisions !== undefined ? { decisions } : {}),
    });
    return {
      staged,
      environment,
      gateUrlOverrides,
      ...(staged.allowWorkflowWrites !== undefined ? { allowWorkflowWrites: staged.allowWorkflowWrites } : {}),
      ...(staged.roleMcpServers !== undefined ? { roleMcpServers: staged.roleMcpServers } : {}),
      ...(staged.mcpServers !== undefined ? { mcpServers: staged.mcpServers } : {}),
      ...(decisions !== undefined ? { decisions } : {}),
      ports,
      close: async () => undefined,
    };
  }

  const server = await startLocalCommandGateServer({
    runRoot: realRunRoot,
    repositoryRoot: staged.repositoryRoot,
    gates: staged.localCommandGates,
    signingSecret: staged.signingSecret,
    runtimeEnv: baseEnv,
    readOnlyGitHubToken,
    scrubber: stepScrubber,
    checkStagedDir: staged.checkStagedDir,
    forbiddenEnvNames,
  });
  const gateUrlOverrides = Object.freeze({ [LOCAL_COMMAND_GATE_ENDPOINT_ID]: server.url });
  const ports = Object.freeze({
    gateUrlOverrides,
    ...(staged.allowWorkflowWrites !== undefined ? { allowWorkflowWrites: staged.allowWorkflowWrites } : {}),
    ...(staged.roleMcpServers !== undefined ? { roleMcpServers: staged.roleMcpServers } : {}),
    ...(staged.mcpServers !== undefined ? { mcpServers: staged.mcpServers } : {}),
    ...(decisions !== undefined ? { decisions } : {}),
  });

  return {
    staged,
    environment,
    gateUrlOverrides,
    ...(staged.allowWorkflowWrites !== undefined ? { allowWorkflowWrites: staged.allowWorkflowWrites } : {}),
    ...(staged.roleMcpServers !== undefined ? { roleMcpServers: staged.roleMcpServers } : {}),
    ...(staged.mcpServers !== undefined ? { mcpServers: staged.mcpServers } : {}),
    ...(decisions !== undefined ? { decisions } : {}),
    ports,
    serverUrl: server.url,
    close: () => server.close(),
  };
}
