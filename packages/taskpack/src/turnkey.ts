import { spawn, spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { accessSync, constants as fsConstants, existsSync, lstatSync, readlinkSync, realpathSync, type Stats } from 'node:fs';
import { chmod, link, lstat, mkdir, mkdtemp, open, opendir, readdir, readFile, realpath, rename, rm, unlink, type FileHandle } from 'node:fs/promises';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { createServer as createNetServer, type Socket } from 'node:net';
import { homedir, tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import type { Readable, Writable } from 'node:stream';
import { STANDARD_PI_PROVIDER_ENV } from '@loopwright/agent-pi/catalog';
import {
  openPiHostSessionAdapterV2,
  type HostSessionCircuitBreakerOptions,
  type HostSessionProgressEvent,
} from '@loopwright/agent-pi/host-session';
import type { HostMcpRegistry } from '@loopwright/agent-pi/mcp';
import {
  formatDurationMs,
  formatTokenCount,
  inspectRun,
  loadTrustedConfiguration,
  parseCasUri,
  resolveCanonicalCasBlobPath,
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
  OVERLAY_LIMITS,
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
import { DECISION_PROVIDER_API_KEY_ENV, type DecisionTransport } from '@loopwright/decisions';
import { reopenLocalRun, type LocalRunIdentity, type PageCursor } from '@loopwright/state';
import { computeDirectoryTreeDigest } from './digests.js';
import { LOOPWRIGHT_ACTIVE_PROVIDER_TOKEN_ENV } from './models-config.js';
import { sanitizeReportText } from './output-format.js';
import {
  collectManifestSecretEnvNames,
  formatWorkspaceResourcesManifest,
  isForbiddenPreflightEnvName,
  PREFLIGHT_MAX_WORKSPACE_RESOURCES_TOTAL_BYTES,
  runTaskpackPreflight,
  STREAM_CHUNK_BYTES,
  type RunTaskpackPreflightResult,
} from './preflight.js';
import { IDENTIFIER_PATTERN, normalizeRelativePath } from './schema.js';
import {
  compileLinuxSeccompBpfBinary,
  DEFAULT_DENIED_HOME_SUBPATHS,
  LANDLOCK_BOOTSTRAP_SCRIPT,
  LANDLOCK_HOST_PROBE_SCRIPT,
  TRUSTED_BWRAP_PATHS,
  TRUSTED_PYTHON_PATHS,
} from './sandbox.js';
import { assertCleanArtifact, SecretScrubber } from './scrubber.js';
import {
  buildDefaultAuthorPrompt,
  compileDeclarativeTaskpack,
  createTaskpackDecisionPort,
  DEFAULT_HOST_BUDGETS,
  insideRoot,
  loadDeclarativeTaskpack,
  mergeTaskpackLimits,
  parseActionInputLimits,
  parseLoopwrightEnvLimits,
  stageCompiledInstructionResources,
} from './taskpack.js';
import {
  CANONICAL_TASKPACK_STEP_GATE_URL,
  DEFAULT_LOCAL_COMMAND_GATE_ENV,
  LOCAL_COMMAND_GATE_ENDPOINT_ID,
  PROTECTED_AUTOMATION_PATHS,
  REPOSITORY_FULL_NAME_PATTERN,
  TaskpackError,
  type ActionDelegateOutcome,
  type CompiledLocalCommandGate,
  type ExecutionHostPolicy,
  type HostGateEndpointPlan,
  type HostPublicationEndpointPlan,
  type PolicyProfile,
  type SandboxNetworkMode,
  type TaskpackUpstreamRecord,
  type TurnkeyMemorySummary,
  type WrittenCompiledTaskpack,
} from './types.js';
import {
  assertNoSymlinkSegments,
  buildCleanGitEnv,
  COMMIT_SHA_PATTERN,
  discoverTaskpackUpstreamsV2,
  isPlainRecord,
  parseUpstreamRecordsJson,
  resolveGitExecutable,
  resolveRepositoryAndRevisions,
} from './upstreams.js';
import { serializePrettyYaml } from './yaml.js';

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
const DEFAULT_COPY_TREE_MAX_FILES = 32_768;
const DEFAULT_COPY_TREE_MAX_BYTES = 1_073_741_824;
const GIT_OBJECTS_MAX_FILES = 65_536;
const GIT_OBJECTS_MAX_BYTES = 4 * 1024 * 1024 * 1024;

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

const ALLOWED_CHILD_RUNNER_ENV_NAMES: ReadonlySet<string> = new Set(['RUNNER_ENVIRONMENT']);

function isForbiddenChildEnvName(key: string, forbiddenEnvNames?: ReadonlySet<string>): boolean {
  if (FORBIDDEN_CHILD_ENV_NAMES.has(key) || forbiddenEnvNames?.has(key) === true) return true;
  const poolMatch = /^(.+)_([1-9]|1[0-6])$/.exec(key);
  if (
    poolMatch !== null
    && (FORBIDDEN_CHILD_ENV_NAMES.has(poolMatch[1]!) || forbiddenEnvNames?.has(poolMatch[1]!) === true)
  ) {
    return true;
  }
  if (ALLOWED_CHILD_RUNNER_ENV_NAMES.has(key)) return false;
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
      throw new TaskpackError('ACTION_INPUT_INVALID', `request body exceeded ${maxBytes} bytes`);
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

export type InspectedCandidateFile =
  | {
    readonly kind: 'cas';
    readonly name: string;
    readonly mode: '100644' | '100755';
    readonly sha256: string;
    readonly byteLength: number;
    readonly uri: string;
    readonly canonicalBlobPath: string;
  }
  | {
    readonly kind: 'inline';
    readonly name: string;
    readonly mode?: '100644' | '100755' | undefined;
    readonly bytes: Buffer;
  };

export interface InspectedCandidateSnapshot {
  readonly lock: Record<string, unknown>;
  readonly contract: TaskContract;
  readonly protectedPaths: readonly string[];
  readonly baseRevision: string;
  readonly sourceRevision: string;
  readonly manifest: ArtifactManifest;
  readonly files: readonly InspectedCandidateFile[];
}

function normalizeProtectedPrefix(protectedEntry: string): string {
  const withoutGlob = protectedEntry.endsWith('/**') ? protectedEntry.slice(0, -3) : protectedEntry;
  return withoutGlob.replace(/\/+$/, '');
}

export function isProtectedCandidatePath(name: string, protectedPaths: readonly string[]): boolean {
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

export function isAllowedCandidateWrite(
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

export function normalizeCandidateRelativePath(name: string): string {
  if (
    typeof name !== 'string'
    || name.length === 0
    || name.includes('\0')
    || name.includes('\\')
    || name.startsWith('/')
  ) {
    throw new TaskpackError('ACTION_INPUT_INVALID', `invalid candidate relative file path "${name}"`);
  }
  const parts = name.split('/');
  for (const part of parts) {
    if (part.length === 0 || part === '.' || part === '..') {
      throw new TaskpackError('ACTION_INPUT_INVALID', `invalid candidate path segment in "${name}"`);
    }
  }
  return name;
}

export async function inspectAndVerifyCandidate(
  runRoot: string,
  runId: string,
  expectedCandidateDigest: string,
  scratchParent: string,
): Promise<InspectedCandidateSnapshot> {
  if (!CONTROLLER_ID_PATTERN.test(runId) || runId.length > 128) {
    throw new TaskpackError('ACTION_INPUT_INVALID', `invalid controller runId "${runId}"`);
  }
  const realRunRoot = await realpath(runRoot);
  const runDir = join(realRunRoot, runId);
  if (!insideRoot(runDir, realRunRoot) || runDir === realRunRoot) {
    throw new TaskpackError('ACTION_INPUT_INVALID', `runId "${runId}" escapes runRoot`);
  }
  const artifactsDir = join(runDir, 'artifacts');

  const rawHolder = await mkdtemp(join(scratchParent, 'inspect-'));
  await chmod(rawHolder, 0o700);
  const inspectHolder = await realpath(rawHolder);
  const tempInspectDir = join(inspectHolder, 'bundle');
  try {
    const inspected = await inspectRun({ runRoot: realRunRoot, runId, output: tempInspectDir });
    if (!inspected.ok) {
      throw new TaskpackError('ACTION_INPUT_INVALID', `inspectRun failed: ${inspected.error.code}`);
    }
    const lockRaw = JSON.parse(await readFile(join(tempInspectDir, 'task.lock.json'), 'utf8')) as unknown;
    const candidateFilesRaw = JSON.parse(await readFile(join(tempInspectDir, 'candidate.files.json'), 'utf8')) as unknown;
    const validLock = validateDocument(lockRaw, 'TaskLock');
    if (!validLock.ok) {
      throw new TaskpackError('ACTION_INPUT_INVALID', 'inspected task.lock.json failed TaskLock validation');
    }
    if (!isPlainRecord(candidateFilesRaw)) {
      throw new TaskpackError('ACTION_INPUT_INVALID', 'inspected candidate.files.json is invalid');
    }
    const overlayLimits = validLock.value.spec.contract.spec.budgets.overlay;
    const overlayOpts = overlayLimits !== undefined ? { overlay: overlayLimits } : undefined;
    const validManifest = validateDocument(candidateFilesRaw['manifest'], 'ArtifactManifest', overlayOpts);
    if (!validManifest.ok) {
      throw new TaskpackError('ACTION_INPUT_INVALID', 'inspected candidate manifest failed ArtifactManifest validation');
    }
    const bound = bindSubject(validLock.value, validManifest.value, overlayOpts);
    if (!bound.ok || bound.value.candidateDigest.hex !== expectedCandidateDigest) {
      throw new TaskpackError('ACTION_INPUT_INVALID', 'candidate digest binding mismatch against task lock');
    }
    const rawFiles = candidateFilesRaw['files'];
    if (!Array.isArray(rawFiles) || rawFiles.length > OVERLAY_LIMITS.maxMaxFiles) {
      throw new TaskpackError('ACTION_INPUT_INVALID', 'inspected candidate.files.json has invalid files array');
    }
    const expectedEntries = new Map(
      validManifest.value.spec.entries.map(entry => [entry.name, entry] as const),
    );
    const seenFileNames = new Set<string>();
    const files: InspectedCandidateFile[] = [];
    const rawVersion = candidateFilesRaw['version'];

    if (rawVersion === 2) {
      for (const entry of rawFiles) {
        if (
          !isPlainRecord(entry)
          || typeof entry['name'] !== 'string'
          || (entry['mode'] !== '100644' && entry['mode'] !== '100755')
          || typeof entry['sha256'] !== 'string'
          || !SHA256_HEX_PATTERN.test(entry['sha256'])
          || typeof entry['byteLength'] !== 'number'
          || !Number.isSafeInteger(entry['byteLength'])
          || entry['byteLength'] < 0
          || typeof entry['uri'] !== 'string'
        ) {
          throw new TaskpackError('ACTION_INPUT_INVALID', 'candidate v2 file entry malformed');
        }
        const cleanName = normalizeCandidateRelativePath(entry['name']);
        if (seenFileNames.has(cleanName)) {
          throw new TaskpackError('ACTION_INPUT_INVALID', `duplicate candidate file entry "${cleanName}"`);
        }
        seenFileNames.add(cleanName);
        const expectedEntry = expectedEntries.get(cleanName);
        if (expectedEntry === undefined) {
          throw new TaskpackError('ACTION_INPUT_INVALID', `candidate file "${cleanName}" is missing from candidate manifest`);
        }
        const sha256 = entry['sha256'];
        const byteLength = entry['byteLength'];
        const uri = entry['uri'];
        let parsedUriSha: string;
        try {
          parsedUriSha = parseCasUri(uri, 'verification');
        } catch {
          throw new TaskpackError('ACTION_INPUT_INVALID', `candidate file "${cleanName}" has invalid CAS URI`);
        }
        if (
          parsedUriSha !== sha256
          || sha256 !== expectedEntry.digest.hex
          || byteLength !== expectedEntry.byteLength
        ) {
          throw new TaskpackError('ACTION_INPUT_INVALID', `candidate file "${cleanName}" metadata mismatch against manifest`);
        }
        const hintedBlobPath = entry['blobPath'] === undefined
          ? undefined
          : (typeof entry['blobPath'] === 'string' ? entry['blobPath'] : '__invalid__');
        let canonicalBlobPath: string;
        try {
          canonicalBlobPath = await resolveCanonicalCasBlobPath(
            artifactsDir,
            sha256,
            hintedBlobPath,
            'verification',
          );
        } catch {
          throw new TaskpackError('ACTION_INPUT_INVALID', `candidate file "${cleanName}" CAS blob path failed canonical verification`);
        }
        files.push({
          kind: 'cas',
          name: cleanName,
          mode: entry['mode'],
          sha256,
          byteLength,
          uri,
          canonicalBlobPath,
        });
      }
    } else if (rawVersion === undefined || rawVersion === 1) {
      for (const entry of rawFiles) {
        if (!isPlainRecord(entry) || typeof entry['name'] !== 'string' || typeof entry['body'] !== 'string') {
          throw new TaskpackError('ACTION_INPUT_INVALID', 'candidate file entry malformed');
        }
        const cleanName = normalizeCandidateRelativePath(entry['name']);
        if (seenFileNames.has(cleanName)) {
          throw new TaskpackError('ACTION_INPUT_INVALID', `duplicate candidate file entry "${cleanName}"`);
        }
        seenFileNames.add(cleanName);
        const expectedEntry = expectedEntries.get(cleanName);
        if (expectedEntry === undefined) {
          throw new TaskpackError('ACTION_INPUT_INVALID', `candidate file "${cleanName}" is missing from candidate manifest`);
        }
        const bytes = Buffer.from(entry['body'], 'base64');
        const actualDigest = createHash('sha256').update(bytes).digest('hex');
        if (bytes.byteLength !== expectedEntry.byteLength || actualDigest !== expectedEntry.digest.hex) {
          throw new TaskpackError('ACTION_INPUT_INVALID', `candidate file "${cleanName}" sha256 digest mismatch against manifest`);
        }
        const mode = entry['mode'] === '100755' || entry['mode'] === '100644' ? entry['mode'] : undefined;
        files.push({ kind: 'inline', name: cleanName, mode, bytes });
      }
    } else {
      throw new TaskpackError('ACTION_INPUT_INVALID', `unsupported candidate.files.json version "${String(rawVersion)}"`);
    }

    if (seenFileNames.size !== expectedEntries.size) {
      throw new TaskpackError('ACTION_INPUT_INVALID', 'inspected candidate.files.json missing manifest entries');
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

export async function makeTreeReadOnly(rootDir: string): Promise<void> {
  const noFollow = 'O_NOFOLLOW' in fsConstants ? fsConstants.O_NOFOLLOW : 0;
  const currentUid = typeof process.getuid === 'function' ? process.getuid() : undefined;
  const entries = await readdir(rootDir, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    const childPath = join(rootDir, entry.name);
    const st = await lstat(childPath).catch(() => null);
    if (st === null) continue;
    if (st.isSymbolicLink()) {
      throw new TaskpackError('TASKPACK_SCOPE_VIOLATION', `symlink "${childPath}" is forbidden inside read-only tree`);
    }
    if (st.isDirectory()) {
      await makeTreeReadOnly(childPath);
    } else if (st.isFile()) {
      if (st.nlink !== 1 || (currentUid !== undefined && st.uid !== currentUid)) {
        throw new TaskpackError('TASKPACK_SCOPE_VIOLATION', `hardlinked or unowned file "${childPath}" is forbidden inside read-only tree`);
      }
      const fh = await open(childPath, fsConstants.O_RDONLY | noFollow);
      try {
        const fst = await fh.stat();
        if (!fst.isFile() || fst.isSymbolicLink() || fst.nlink !== 1 || (currentUid !== undefined && fst.uid !== currentUid)) {
          throw new TaskpackError('TASKPACK_SCOPE_VIOLATION', `file "${childPath}" failed O_NOFOLLOW check before fchmod`);
        }
        const mode = (fst.mode & 0o111) !== 0 ? 0o555 : 0o444;
        await fh.chmod(mode);
      } finally {
        await fh.close();
      }
    }
  }
  const dirFh = await open(rootDir, fsConstants.O_RDONLY | noFollow);
  try {
    const dirSt = await dirFh.stat();
    if (dirSt.isSymbolicLink() || !dirSt.isDirectory() || (currentUid !== undefined && dirSt.uid !== currentUid)) {
      throw new TaskpackError('TASKPACK_SCOPE_VIOLATION', `directory "${rootDir}" failed O_NOFOLLOW check before fchmod`);
    }
    await dirFh.chmod(0o555);
  } finally {
    await dirFh.close();
  }
}

export async function makeTreeWritableForCleanup(rootDir: string): Promise<void> {
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

export async function copySingleRegularFileReadOnly(
  srcPath: string,
  destPath: string,
  expectedSize: number,
  execBit: boolean,
  _disableReflink: boolean,
  expectedParentId?: { readonly dev: number; readonly ino: number } | undefined,
): Promise<number> {
  const targetMode = execBit ? 0o555 : 0o444;
  const noFollow = 'O_NOFOLLOW' in fsConstants ? fsConstants.O_NOFOLLOW : 0;
  const currentUid = typeof process.getuid === 'function' ? process.getuid() : undefined;

  let srcHandle: FileHandle;
  try {
    srcHandle = await open(srcPath, fsConstants.O_RDONLY | noFollow);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | null)?.code;
    if (code === 'ELOOP' || code === 'EMLINK') {
      throw new TaskpackError('TASKPACK_SCOPE_VIOLATION', `symlink "${srcPath}" is forbidden during read-only file copy`);
    }
    const detail = error instanceof Error ? error.message : String(error);
    throw new TaskpackError('ACTION_INPUT_INVALID', `failed to open mounted file "${srcPath}": ${detail}`);
  }

  const destParentDir = dirname(destPath);
  let parentFh: FileHandle | undefined;
  let tmpDestPath: string | null = null;
  let createdTmp = false;
  let tmpHandle: FileHandle | undefined;
  let finalHandle: FileHandle | undefined;
  try {
    try {
      parentFh = await open(destParentDir, fsConstants.O_RDONLY | noFollow);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException | null)?.code;
      if (code === 'ELOOP' || code === 'ENOTDIR') {
        throw new TaskpackError('TASKPACK_SCOPE_VIOLATION', `destination parent "${destParentDir}" failed O_NOFOLLOW check`);
      }
      throw error;
    }
    const parentSt = await parentFh.stat();
    if (parentSt.isSymbolicLink() || !parentSt.isDirectory() || (currentUid !== undefined && parentSt.uid !== currentUid)) {
      throw new TaskpackError('TASKPACK_SCOPE_VIOLATION', `destination parent "${destParentDir}" failed O_NOFOLLOW ownership check`);
    }
    if (expectedParentId !== undefined && (parentSt.dev !== expectedParentId.dev || parentSt.ino !== expectedParentId.ino)) {
      throw new TaskpackError('TASKPACK_SCOPE_VIOLATION', `destination parent "${destParentDir}" did not match expected directory identity`);
    }
    const beforeParentLstat = await lstat(destParentDir);
    if (
      beforeParentLstat.isSymbolicLink()
      || !beforeParentLstat.isDirectory()
      || beforeParentLstat.dev !== parentSt.dev
      || beforeParentLstat.ino !== parentSt.ino
    ) {
      throw new TaskpackError('TASKPACK_SCOPE_VIOLATION', `destination parent "${destParentDir}" changed identity before copy`);
    }

    let existingDest: Stats | null = null;
    try {
      existingDest = await lstat(destPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException | null)?.code !== 'ENOENT') {
        throw error;
      }
    }
    if (existingDest !== null) {
      throw new TaskpackError('ACTION_INPUT_INVALID', `destination file "${destPath}" already exists`);
    }

    const srcBefore = await srcHandle.stat();
    if (
      !srcBefore.isFile()
      || srcBefore.isSymbolicLink()
      || srcBefore.nlink !== 1
      || srcBefore.size !== expectedSize
    ) {
      throw new TaskpackError(
        'TASKPACK_SCOPE_VIOLATION',
        `mounted file "${srcPath}" failed regular single-link/size check (nlink=${srcBefore.nlink}, size=${srcBefore.size})`,
      );
    }

    const streamTmpPath = join(destParentDir, `.lw-stage-${randomBytes(12).toString('hex')}`);
    tmpHandle = await open(
      streamTmpPath,
      fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_RDWR | noFollow,
      0o600,
    );
    tmpDestPath = streamTmpPath;
    createdTmp = true;

    const createdStat = await tmpHandle.stat();
    if (
      !createdStat.isFile()
      || createdStat.isSymbolicLink()
      || createdStat.nlink !== 1
      || (currentUid !== undefined && createdStat.uid !== currentUid)
      || (createdStat.dev === srcBefore.dev && createdStat.ino === srcBefore.ino)
    ) {
      throw new TaskpackError('TASKPACK_SCOPE_VIOLATION', `mounted file "${destPath}" failed temp identity/nlink/ownership check`);
    }

    const srcHash = createHash('sha256');
    const chunk = Buffer.allocUnsafe(Math.min(STREAM_CHUNK_BYTES, Math.max(1, expectedSize)));
    const probe = Buffer.allocUnsafe(1);
    let offset = 0;
    while (offset < expectedSize) {
      const toRead = Math.min(chunk.byteLength, expectedSize - offset);
      const { bytesRead } = await srcHandle.read(chunk, 0, toRead, offset);
      if (bytesRead <= 0) break;
      const slice = chunk.subarray(0, bytesRead);
      srcHash.update(slice);
      let written = 0;
      while (written < bytesRead) {
        const { bytesWritten } = await tmpHandle.write(slice, written, bytesRead - written, offset + written);
        if (bytesWritten <= 0) {
          throw new TaskpackError('ACTION_INPUT_INVALID', `short write copying mounted file "${srcPath}"`);
        }
        written += bytesWritten;
      }
      offset += bytesRead;
    }
    const srcSha256 = srcHash.digest('hex');
    const { bytesRead: extraRead } = await srcHandle.read(probe, 0, 1, offset);
    const srcAfter = await srcHandle.stat();
    if (
      offset !== expectedSize
      || extraRead !== 0
      || srcAfter.dev !== srcBefore.dev
      || srcAfter.ino !== srcBefore.ino
      || srcAfter.nlink !== 1
      || srcAfter.size !== expectedSize
      || srcAfter.mtimeMs !== srcBefore.mtimeMs
      || srcAfter.ctimeMs !== srcBefore.ctimeMs
    ) {
      throw new TaskpackError('TASKPACK_SCOPE_VIOLATION', `mounted file "${srcPath}" changed during stream copy`);
    }

    await tmpHandle.sync();
    const destHash = createHash('sha256');
    let destOffset = 0;
    while (destOffset < expectedSize) {
      const toRead = Math.min(chunk.byteLength, expectedSize - destOffset);
      const { bytesRead } = await tmpHandle.read(chunk, 0, toRead, destOffset);
      if (bytesRead <= 0) break;
      destHash.update(chunk.subarray(0, bytesRead));
      destOffset += bytesRead;
    }
    const { bytesRead: destExtra } = await tmpHandle.read(probe, 0, 1, destOffset);
    const verifiedTmpStat = await tmpHandle.stat();
    const srcAfterVerify = await srcHandle.stat();
    const destSha256 = destHash.digest('hex');
    if (
      destOffset !== expectedSize
      || destExtra !== 0
      || verifiedTmpStat.dev !== createdStat.dev
      || verifiedTmpStat.ino !== createdStat.ino
      || verifiedTmpStat.nlink !== 1
      || (currentUid !== undefined && verifiedTmpStat.uid !== currentUid)
      || verifiedTmpStat.size !== expectedSize
      || srcAfterVerify.dev !== srcBefore.dev
      || srcAfterVerify.ino !== srcBefore.ino
      || srcAfterVerify.nlink !== 1
      || srcAfterVerify.size !== expectedSize
      || srcAfterVerify.mtimeMs !== srcBefore.mtimeMs
      || srcAfterVerify.ctimeMs !== srcBefore.ctimeMs
      || destSha256 !== srcSha256
    ) {
      throw new TaskpackError('TASKPACK_SCOPE_VIOLATION', `mounted file "${destPath}" failed post-stream sha256/stability verification`);
    }

    await tmpHandle.chmod(targetMode);
    await tmpHandle.sync();
    const sealedStat = await tmpHandle.stat();
    if (
      !sealedStat.isFile()
      || sealedStat.isSymbolicLink()
      || sealedStat.nlink !== 1
      || (currentUid !== undefined && sealedStat.uid !== currentUid)
      || sealedStat.dev !== createdStat.dev
      || sealedStat.ino !== createdStat.ino
      || sealedStat.size !== expectedSize
      || (sealedStat.mode & 0o777) !== targetMode
    ) {
      throw new TaskpackError('TASKPACK_SCOPE_VIOLATION', `mounted file "${destPath}" failed post-fchmod verification`);
    }

    await link(streamTmpPath, destPath);
    await unlink(streamTmpPath);
    createdTmp = false;
    tmpDestPath = null;

    const afterParentLstat = await lstat(destParentDir);
    if (
      afterParentLstat.isSymbolicLink()
      || !afterParentLstat.isDirectory()
      || afterParentLstat.dev !== parentSt.dev
      || afterParentLstat.ino !== parentSt.ino
    ) {
      throw new TaskpackError('TASKPACK_SCOPE_VIOLATION', `destination parent "${destParentDir}" changed identity during copy`);
    }

    finalHandle = await open(destPath, fsConstants.O_RDONLY | noFollow);
    const destStat = await finalHandle.stat();
    const tmpAfterPublishStat = await tmpHandle.stat();
    await finalHandle.close();
    finalHandle = undefined;
    await tmpHandle.close();
    tmpHandle = undefined;
    if (
      destStat.isSymbolicLink()
      || !destStat.isFile()
      || destStat.nlink !== 1
      || tmpAfterPublishStat.nlink !== 1
      || tmpAfterPublishStat.dev !== createdStat.dev
      || tmpAfterPublishStat.ino !== createdStat.ino
      || (currentUid !== undefined && destStat.uid !== currentUid)
      || destStat.dev !== createdStat.dev
      || destStat.ino !== createdStat.ino
      || destStat.size !== expectedSize
      || (destStat.mode & 0o777) !== targetMode
    ) {
      throw new TaskpackError('TASKPACK_SCOPE_VIOLATION', `mounted file "${destPath}" failed post-publish nlink/size verification`);
    }
    return offset;
  } catch (error) {
    if (finalHandle !== undefined) {
      await finalHandle.close().catch(() => undefined);
    }
    if (tmpHandle !== undefined) {
      await tmpHandle.close().catch(() => undefined);
    }
    if (createdTmp && tmpDestPath !== null) {
      await unlink(tmpDestPath).catch(() => undefined);
    }
    throw error;
  } finally {
    if (parentFh !== undefined) {
      await parentFh.close().catch(() => undefined);
    }
    await srcHandle.close().catch(() => undefined);
  }
}

export async function copyDirectoryTreeReadOnly(
  srcDir: string,
  destDir: string,
  options?: {
    readonly maxFiles?: number | undefined;
    readonly maxEntries?: number | undefined;
    readonly maxTotalBytes?: number | undefined;
    readonly includeTopLevelLower?: ReadonlySet<string> | undefined;
    readonly excludeTopLevelLower?: ReadonlySet<string> | undefined;
    readonly excludeAnyDepthLower?: ReadonlySet<string> | undefined;
    readonly skipFinalChmod?: boolean | undefined;
    readonly disableReflink?: boolean | undefined;
  },
): Promise<void> {
  const maxFiles = options?.maxFiles ?? DEFAULT_COPY_TREE_MAX_FILES;
  const maxEntries = options?.maxEntries
    ?? (options?.maxFiles !== undefined ? Math.max(options.maxFiles * 2, 16) : DEFAULT_COPY_TREE_MAX_FILES * 2);
  if (!Number.isSafeInteger(maxEntries) || maxEntries < 1) {
    throw new TaskpackError('ACTION_INPUT_INVALID', 'maxEntries must be a positive integer');
  }
  const maxTotalBytes = options?.maxTotalBytes ?? DEFAULT_COPY_TREE_MAX_BYTES;
  const includeTopLevelLower = options?.includeTopLevelLower;
  const excludeTopLevelLower = options?.excludeTopLevelLower;
  const excludeAnyDepthLower = options?.excludeAnyDepthLower;
  const skipFinalChmod = options?.skipFinalChmod === true;
  const disableReflink = options?.disableReflink === true;
  const noFollow = 'O_NOFOLLOW' in fsConstants ? fsConstants.O_NOFOLLOW : 0;
  const currentUid = typeof process.getuid === 'function' ? process.getuid() : undefined;
  let copiedFiles = 0;
  let copiedBytes = 0;
  let visitedEntries = 0;

  const ensureValidAncestorDirectory = async (ancestorDir: string): Promise<void> => {
    let st: Stats | null;
    try {
      st = await lstat(ancestorDir);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException | null)?.code;
      if (code === 'ENOENT') {
        st = null;
      } else if (code === 'ELOOP' || code === 'ENOTDIR') {
        throw new TaskpackError('TASKPACK_SCOPE_VIOLATION', `destination path "${ancestorDir}" traverses a symlink or non-directory`);
      } else {
        throw error;
      }
    }
    if (st === null) {
      await mkdir(ancestorDir, { mode: 0o700 });
      const fh = await open(ancestorDir, fsConstants.O_RDONLY | noFollow);
      try {
        const createdSt = await fh.stat();
        if (createdSt.isSymbolicLink() || !createdSt.isDirectory() || (currentUid !== undefined && createdSt.uid !== currentUid)) {
          throw new TaskpackError('TASKPACK_SCOPE_VIOLATION', `created destination ancestor "${ancestorDir}" failed O_NOFOLLOW verification`);
        }
      } finally {
        await fh.close();
      }
      return;
    }
    if (st.isSymbolicLink() || !st.isDirectory()) {
      throw new TaskpackError('TASKPACK_SCOPE_VIOLATION', `destination ancestor "${ancestorDir}" must be a non-symlink directory`);
    }
  };

  const resolvedDestRoot = resolve(destDir);
  if (resolvedDestRoot === sep) {
    throw new TaskpackError('TASKPACK_SCOPE_VIOLATION', 'copyDirectoryTreeReadOnly refuses root directory destination');
  }
  const destSegments = resolvedDestRoot.split(sep).filter(Boolean);
  let destParentPath: string;
  let canonDestRoot: string;
  if (destSegments.length === 1) {
    destParentPath = sep;
    canonDestRoot = `${sep}${destSegments[0]!}`;
  } else {
    const firstSegPath = `${sep}${destSegments[0]!}`;
    const firstSt = await lstat(firstSegPath).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return null;
      throw error;
    });
    let cursor: string;
    if (firstSt === null) {
      cursor = firstSegPath;
      await ensureValidAncestorDirectory(cursor);
    } else if (firstSt.isSymbolicLink()) {
      cursor = await realpath(firstSegPath);
      const realTopSt = await lstat(cursor);
      if (realTopSt.isSymbolicLink() || !realTopSt.isDirectory()) {
        throw new TaskpackError('TASKPACK_SCOPE_VIOLATION', `destination root ancestor "${firstSegPath}" is not a directory`);
      }
    } else if (firstSt.isDirectory()) {
      cursor = firstSegPath;
    } else {
      throw new TaskpackError('TASKPACK_SCOPE_VIOLATION', `destination root ancestor "${firstSegPath}" is not a directory`);
    }
    for (let i = 1; i < destSegments.length - 1; i += 1) {
      cursor = join(cursor, destSegments[i]!);
      await ensureValidAncestorDirectory(cursor);
    }
    destParentPath = cursor;
    canonDestRoot = join(destParentPath, destSegments[destSegments.length - 1]!);
  }

  let existingDestRootSt: Stats | null;
  try {
    existingDestRootSt = await lstat(canonDestRoot);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | null)?.code;
    if (code === 'ENOENT') {
      existingDestRootSt = null;
    } else if (code === 'ELOOP' || code === 'ENOTDIR') {
      throw new TaskpackError('TASKPACK_SCOPE_VIOLATION', `destination "${canonDestRoot}" traverses a symlink or non-directory`);
    } else {
      throw error;
    }
  }
  if (existingDestRootSt !== null && (existingDestRootSt.isSymbolicLink() || !existingDestRootSt.isDirectory())) {
    throw new TaskpackError('TASKPACK_SCOPE_VIOLATION', `destination "${canonDestRoot}" must be a non-symlink directory`);
  }

  const assertDirLstatMatches = async (
    dirPath: string,
    expectedId: { readonly dev: number; readonly ino: number },
  ): Promise<void> => {
    const curSt = await lstat(dirPath);
    if (
      curSt.isSymbolicLink()
      || !curSt.isDirectory()
      || curSt.dev !== expectedId.dev
      || curSt.ino !== expectedId.ino
    ) {
      throw new TaskpackError('TASKPACK_SCOPE_VIOLATION', `destination directory "${dirPath}" changed identity during copy`);
    }
  };

  const enumerateFilteredSortedNames = async (curSrc: string, depth: number): Promise<readonly string[]> => {
    const dir = await opendir(curSrc);
    const names: string[] = [];
    let rawCount = 0;
    const rawLimit = Math.max(maxEntries * 4, 4_096);
    for await (const dirent of dir) {
      rawCount += 1;
      if (rawCount > rawLimit) {
        throw new TaskpackError('ACTION_INPUT_INVALID', 'mounted directory exceeds entry cap');
      }
      const lowerName = dirent.name.toLowerCase();
      if (depth === 0 && includeTopLevelLower !== undefined && !includeTopLevelLower.has(lowerName)) {
        continue;
      }
      if (depth === 0 && excludeTopLevelLower?.has(lowerName) === true) {
        continue;
      }
      if (excludeAnyDepthLower?.has(lowerName) === true) {
        continue;
      }
      names.push(dirent.name);
      if (names.length > maxEntries - visitedEntries + 64) {
        throw new TaskpackError('ACTION_INPUT_INVALID', 'mounted directory exceeds entry cap');
      }
    }
    names.sort();
    return names;
  };

  const walkHeldTree = async (
    curSrc: string,
    curDest: string,
    depth: number,
    sealSelfAtEnd: boolean,
    preOpenedFh?: FileHandle | undefined,
    preExpectedId?: { readonly dev: number; readonly ino: number } | undefined,
  ): Promise<void> => {
    if (depth > 32) {
      throw new TaskpackError('ACTION_INPUT_INVALID', 'mounted directory exceeds maximum depth 32');
    }
    visitedEntries += 1;
    if (visitedEntries > maxEntries) {
      throw new TaskpackError('ACTION_INPUT_INVALID', 'mounted directory exceeds entry cap');
    }
    const srcStat = await lstat(curSrc);
    if (srcStat.isSymbolicLink() || !srcStat.isDirectory()) {
      throw new TaskpackError('ACTION_INPUT_INVALID', `mounted directory "${curSrc}" must be a non-symlink directory`);
    }

    let curDestFh: FileHandle;
    let shouldCloseCurDestFh = false;
    let wasCreated = false;
    let expectedDirId: { readonly dev: number; readonly ino: number };
    if (preOpenedFh !== undefined && preExpectedId !== undefined) {
      curDestFh = preOpenedFh;
      expectedDirId = preExpectedId;
    } else {
      let existingSt: Stats | null;
      try {
        existingSt = await lstat(curDest);
      } catch (error) {
        const code = (error as NodeJS.ErrnoException | null)?.code;
        if (code === 'ENOENT') {
          existingSt = null;
        } else if (code === 'ELOOP' || code === 'ENOTDIR') {
          throw new TaskpackError('TASKPACK_SCOPE_VIOLATION', `destination path "${curDest}" traverses a symlink or non-directory`);
        } else {
          throw error;
        }
      }
      if (existingSt === null) {
        await mkdir(curDest, { mode: 0o700 });
        wasCreated = true;
      } else if (existingSt.isSymbolicLink() || !existingSt.isDirectory()) {
        throw new TaskpackError('TASKPACK_SCOPE_VIOLATION', `destination "${curDest}" must be a non-symlink directory`);
      }
      curDestFh = await open(curDest, fsConstants.O_RDONLY | noFollow);
      shouldCloseCurDestFh = true;
      const openedSt = await curDestFh.stat();
      if (
        openedSt.isSymbolicLink()
        || !openedSt.isDirectory()
        || (existingSt !== null && (openedSt.dev !== existingSt.dev || openedSt.ino !== existingSt.ino))
        || (currentUid !== undefined && openedSt.uid !== currentUid)
      ) {
        await curDestFh.close().catch(() => undefined);
        throw new TaskpackError('TASKPACK_SCOPE_VIOLATION', `destination directory "${curDest}" failed O_NOFOLLOW ownership/identity check`);
      }
      expectedDirId = Object.freeze({ dev: openedSt.dev, ino: openedSt.ino });
    }

    try {
      const names = await enumerateFilteredSortedNames(curSrc, depth);
      for (const name of names) {
        const childSrc = join(curSrc, name);
        const childDest = join(curDest, name);
        const st = await lstat(childSrc);
        if (st.isSymbolicLink()) {
          throw new TaskpackError('TASKPACK_SCOPE_VIOLATION', `symlink "${childSrc}" is forbidden inside mounted directory`);
        }
        await assertDirLstatMatches(curDest, expectedDirId);
        if (st.isDirectory()) {
          await walkHeldTree(childSrc, childDest, depth + 1, !skipFinalChmod);
          await assertDirLstatMatches(curDest, expectedDirId);
        } else if (st.isFile()) {
          visitedEntries += 1;
          if (visitedEntries > maxEntries) {
            throw new TaskpackError('ACTION_INPUT_INVALID', 'mounted directory exceeds entry cap');
          }
          copiedFiles += 1;
          if (copiedFiles > maxFiles || copiedBytes + st.size > maxTotalBytes) {
            throw new TaskpackError('ACTION_INPUT_INVALID', 'mounted directory exceeds file or byte cap');
          }
          const execBit = (st.mode & 0o111) !== 0;
          const written = await copySingleRegularFileReadOnly(
            childSrc,
            childDest,
            st.size,
            execBit,
            disableReflink,
            expectedDirId,
          );
          copiedBytes += written;
          await assertDirLstatMatches(curDest, expectedDirId);
        }
      }
      if (sealSelfAtEnd && wasCreated && !skipFinalChmod) {
        const endSt = await curDestFh.stat();
        if (
          endSt.isSymbolicLink()
          || !endSt.isDirectory()
          || endSt.dev !== expectedDirId.dev
          || endSt.ino !== expectedDirId.ino
          || (currentUid !== undefined && endSt.uid !== currentUid)
        ) {
          throw new TaskpackError('TASKPACK_SCOPE_VIOLATION', `destination directory "${curDest}" failed O_NOFOLLOW identity check before fchmod`);
        }
        await curDestFh.chmod(0o555);
      }
    } finally {
      if (shouldCloseCurDestFh) {
        await curDestFh.close().catch(() => undefined);
      }
    }
  };

  if (existingDestRootSt === null) {
    const destParentFh = await open(destParentPath, fsConstants.O_RDONLY | noFollow);
    const stageRoot = join(destParentPath, `.lw-tree-${randomBytes(12).toString('hex')}`);
    let stageCreated = false;
    let stagePublished = false;
    let stageRootFh: FileHandle | undefined;
    try {
      const destParentSt = await destParentFh.stat();
      if (
        destParentSt.isSymbolicLink()
        || !destParentSt.isDirectory()
        || (currentUid !== undefined && destParentSt.uid !== currentUid && destParentSt.uid !== 0)
      ) {
        throw new TaskpackError('TASKPACK_SCOPE_VIOLATION', `destination parent "${destParentPath}" failed O_NOFOLLOW ownership check`);
      }
      await mkdir(stageRoot, { mode: 0o700 });
      stageCreated = true;
      stageRootFh = await open(stageRoot, fsConstants.O_RDONLY | noFollow);
      const stageRootSt = await stageRootFh.stat();
      if (
        stageRootSt.isSymbolicLink()
        || !stageRootSt.isDirectory()
        || (currentUid !== undefined && stageRootSt.uid !== currentUid)
      ) {
        throw new TaskpackError('TASKPACK_SCOPE_VIOLATION', `staging directory "${stageRoot}" failed O_NOFOLLOW verification`);
      }
      const stageRootId = Object.freeze({ dev: stageRootSt.dev, ino: stageRootSt.ino });

      await walkHeldTree(srcDir, stageRoot, 0, false, stageRootFh, stageRootId);

      await assertDirLstatMatches(destParentPath, { dev: destParentSt.dev, ino: destParentSt.ino });
      let destCheckBeforeRename: Stats | null = null;
      try {
        destCheckBeforeRename = await lstat(canonDestRoot);
      } catch (err) {
        if ((err as NodeJS.ErrnoException | null)?.code !== 'ENOENT') {
          throw err;
        }
      }
      if (destCheckBeforeRename !== null) {
        throw new TaskpackError('TASKPACK_SCOPE_VIOLATION', `destination "${canonDestRoot}" appeared concurrently during tree staging`);
      }

      await rename(stageRoot, canonDestRoot);
      stagePublished = true;

      await assertDirLstatMatches(destParentPath, { dev: destParentSt.dev, ino: destParentSt.ino });
      await assertDirLstatMatches(canonDestRoot, stageRootId);
      if (!skipFinalChmod) {
        const postRenameSt = await stageRootFh.stat();
        if (
          postRenameSt.isSymbolicLink()
          || !postRenameSt.isDirectory()
          || postRenameSt.dev !== stageRootId.dev
          || postRenameSt.ino !== stageRootId.ino
        ) {
          throw new TaskpackError('TASKPACK_SCOPE_VIOLATION', `published directory "${canonDestRoot}" failed post-rename identity check`);
        }
        await stageRootFh.chmod(0o555);
      }
    } catch (error) {
      if (stageRootFh !== undefined) {
        await stageRootFh.close().catch(() => undefined);
        stageRootFh = undefined;
      }
      if (stageCreated && !stagePublished) {
        const restoreDirsOnly = async (dirTarget: string): Promise<void> => {
          const st = await lstat(dirTarget).catch(() => null);
          if (st === null || st.isSymbolicLink() || !st.isDirectory()) return;
          await chmod(dirTarget, 0o700).catch(() => undefined);
          const entries = await readdir(dirTarget, { withFileTypes: true }).catch(() => []);
          for (const entry of entries) {
            if (entry.isDirectory()) {
              await restoreDirsOnly(join(dirTarget, entry.name));
            }
          }
        };
        await restoreDirsOnly(stageRoot).catch(() => undefined);
        await rm(stageRoot, { recursive: true, force: true }).catch(() => undefined);
      }
      throw error;
    } finally {
      if (stageRootFh !== undefined) {
        await stageRootFh.close().catch(() => undefined);
      }
      await destParentFh.close().catch(() => undefined);
    }
    return;
  }

  const existingRootFh = await open(canonDestRoot, fsConstants.O_RDONLY | noFollow);
  try {
    const openedRootSt = await existingRootFh.stat();
    if (
      openedRootSt.isSymbolicLink()
      || !openedRootSt.isDirectory()
      || openedRootSt.dev !== existingDestRootSt.dev
      || openedRootSt.ino !== existingDestRootSt.ino
      || (currentUid !== undefined && openedRootSt.uid !== currentUid)
    ) {
      throw new TaskpackError('TASKPACK_SCOPE_VIOLATION', `destination directory "${canonDestRoot}" failed O_NOFOLLOW ownership/identity check`);
    }
    const rootId = Object.freeze({ dev: openedRootSt.dev, ino: openedRootSt.ino });
    await walkHeldTree(srcDir, canonDestRoot, 0, false, existingRootFh, rootId);
  } finally {
    await existingRootFh.close().catch(() => undefined);
  }
}

export const ALLOWED_READ_ONLY_GIT_TOP_LEVEL: ReadonlySet<string> = new Set([
  'head',
  'packed-refs',
  'refs',
  'info',
  'index',
  'shallow',
]);

export const FORBIDDEN_READ_ONLY_GIT_ANY_DEPTH: ReadonlySet<string> = new Set([
  'config',
  'config.worktree',
  'credentials',
  '.git-credentials',
  'hooks',
]);

export const EXCLUDED_READ_ONLY_GIT_TOP_LEVEL: ReadonlySet<string> = new Set([
  'hooks',
  'credentials',
  'config',
  'config.worktree',
  'objects',
]);

export const SANITIZED_READ_ONLY_GIT_CONFIG = [
  '[core]',
  '\trepositoryformatversion = 0',
  '\tfilemode = true',
  '\tbare = false',
  '\tlogallrefupdates = false',
  '\thooksPath = /dev/null',
  '\tfsmonitor = false',
  '',
].join('\n');

export interface ReadOnlyGitObjectsBind {
  readonly sourceObjectsDir: string;
  readonly targetObjectsDir: string;
}

export interface StageReadOnlyGitOptions {
  readonly useMountNamespaceBind?: boolean | undefined;
  readonly disableReflink?: boolean | undefined;
}

/**
 * Walk `<repo>/.git/objects` with `lstat` to guarantee zero symbolic links exist anywhere
 * inside the Git object store before bind-mounting or cloning it.
 */
export async function verifyGitObjectsTreeNoSymlinks(
  objectsDir: string,
  options?: { readonly maxFiles?: number | undefined; readonly maxTotalBytes?: number | undefined },
): Promise<void> {
  const maxFiles = options?.maxFiles ?? GIT_OBJECTS_MAX_FILES;
  const maxTotalBytes = options?.maxTotalBytes ?? GIT_OBJECTS_MAX_BYTES;
  let seenFiles = 0;
  let totalBytes = 0;

  const walk = async (cur: string, depth: number): Promise<void> => {
    if (depth > 16) {
      throw new TaskpackError('ACTION_INPUT_INVALID', '.git/objects exceeds maximum directory depth 16');
    }
    const st = await lstat(cur);
    if (st.isSymbolicLink()) {
      throw new TaskpackError('TASKPACK_SCOPE_VIOLATION', `symbolic link "${cur}" is forbidden inside .git/objects`, '/spec/execution/capabilities/mountReadOnlyGit');
    }
    if (!st.isDirectory()) {
      throw new TaskpackError('ACTION_INPUT_INVALID', `.git/objects path "${cur}" must be a directory`);
    }
    const names = (await readdir(cur)).sort();
    for (const name of names) {
      const child = join(cur, name);
      const childStat = await lstat(child);
      if (childStat.isSymbolicLink()) {
        throw new TaskpackError('TASKPACK_SCOPE_VIOLATION', `symbolic link "${child}" is forbidden inside .git/objects`, '/spec/execution/capabilities/mountReadOnlyGit');
      }
      if (childStat.isDirectory()) {
        await walk(child, depth + 1);
      } else if (childStat.isFile()) {
        seenFiles += 1;
        totalBytes += childStat.size;
        if (seenFiles > maxFiles || totalBytes > maxTotalBytes) {
          throw new TaskpackError('ACTION_INPUT_INVALID', '.git/objects exceeds object file or byte ceiling');
        }
      }
    }
  };

  await walk(objectsDir, 0);
}

/**
 * Stage ONLY the lightweight sanitized `.git` skeleton (`HEAD`, `packed-refs`, `refs/**`, `info/**`, `index`)
 * excluding `hooks`, `credentials`, `config`, `config.worktree`, and `objects`, and write `SANITIZED_READ_ONLY_GIT_CONFIG`.
 */
export async function stageSanitizedReadOnlyGitDir(
  srcGitDir: string,
  destGitDir: string,
  options?: { readonly skipFinalChmod?: boolean | undefined; readonly disableReflink?: boolean | undefined },
): Promise<void> {
  await copyDirectoryTreeReadOnly(srcGitDir, destGitDir, {
    includeTopLevelLower: ALLOWED_READ_ONLY_GIT_TOP_LEVEL,
    excludeAnyDepthLower: FORBIDDEN_READ_ONLY_GIT_ANY_DEPTH,
    skipFinalChmod: true,
    disableReflink: options?.disableReflink,
  });
  const noFollow = 'O_NOFOLLOW' in fsConstants ? fsConstants.O_NOFOLLOW : 0;
  const configDest = join(destGitDir, 'config');
  const handle = await open(
    configDest,
    fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY | noFollow,
    0o444,
  );
  try {
    await handle.writeFile(Buffer.from(SANITIZED_READ_ONLY_GIT_CONFIG, 'utf8'));
    await handle.chmod(0o444);
  } finally {
    await handle.close();
  }
  if (options?.skipFinalChmod !== true) {
    await makeTreeReadOnly(destGitDir);
  }
}

/**
 * Hybrid `mountReadOnlyGit`:
 * 1. Stages the sanitized `.git` skeleton (never raw `.git/config`, `credentials`, `config.worktree`, or `hooks`).
 * 2. Verifies `<srcGitDir>/objects` contains zero symbolic links.
 * 3. When `useMountNamespaceBind` is `true` (Linux `bwrap`), creates an empty `0o555` `<destGitDir>/objects`
 *    mountpoint and returns `{ sourceObjectsDir, targetObjectsDir }` for `--ro-bind` with zero object copies.
 * 4. Otherwise (macOS Seatbelt / Linux Landlock / without `bwrap`), clones `.git/objects` via CoW reflink
 *    (`COPYFILE_FICLONE`) first with seamless `1 MiB` (`STREAM_CHUNK_BYTES`) `O_NOFOLLOW` fallback (`nlink === 1`).
 */
export async function stageReadOnlyGitForCommandCheck(
  srcGitDir: string,
  destGitDir: string,
  options?: StageReadOnlyGitOptions,
): Promise<ReadOnlyGitObjectsBind | null> {
  await stageSanitizedReadOnlyGitDir(srcGitDir, destGitDir, {
    skipFinalChmod: true,
    disableReflink: options?.disableReflink,
  });
  const srcObjectsDir = join(srcGitDir, 'objects');
  const objectsStat = await lstat(srcObjectsDir).catch((err: NodeJS.ErrnoException) => {
    if (err.code === 'ENOENT') return null;
    throw err;
  });
  if (objectsStat === null) {
    await makeTreeReadOnly(destGitDir);
    return null;
  }
  await verifyGitObjectsTreeNoSymlinks(srcObjectsDir);

  const destObjectsDir = join(destGitDir, 'objects');
  if (options?.useMountNamespaceBind === true) {
    const realSrcObjects = await realpath(srcObjectsDir);
    await mkdir(destObjectsDir, { recursive: true, mode: 0o555 });
    await makeTreeReadOnly(destGitDir);
    return Object.freeze({
      sourceObjectsDir: realSrcObjects,
      targetObjectsDir: destObjectsDir,
    });
  }

  await copyDirectoryTreeReadOnly(srcObjectsDir, destObjectsDir, {
    maxFiles: GIT_OBJECTS_MAX_FILES,
    maxTotalBytes: GIT_OBJECTS_MAX_BYTES,
    skipFinalChmod: true,
    disableReflink: options?.disableReflink,
  });
  await makeTreeReadOnly(destGitDir);
  return null;
}

async function verifyAndStageCommandScriptDir(
  repositoryRoot: string,
  gate: CompiledLocalCommandGate,
  checkDir: string,
): Promise<string> {
  if (!SHA256_HEX_PATTERN.test(gate.scriptSha256)) {
    throw new TaskpackError('ACTION_INPUT_INVALID', 'gate script sha256 metadata is invalid');
  }
  const cleanScriptRel = normalizeCandidateRelativePath(gate.script);
  const scriptDirRel = gate.scriptDir ?? (() => {
    const slash = cleanScriptRel.lastIndexOf('/');
    return slash > 0 ? cleanScriptRel.slice(0, slash) : '.';
  })();
  const noFollow = 'O_NOFOLLOW' in fsConstants ? fsConstants.O_NOFOLLOW : 0;

  if (scriptDirRel !== '.' && scriptDirRel.length > 0) {
    const liveDirDigest = await computeDirectoryTreeDigest(repositoryRoot, scriptDirRel);
    if (gate.scriptDirSha256 !== undefined) {
      if (!SHA256_HEX_PATTERN.test(gate.scriptDirSha256)) {
        throw new TaskpackError('ACTION_INPUT_INVALID', 'gate scriptDirSha256 metadata is invalid');
      }
      if (liveDirDigest.digest !== gate.scriptDirSha256) {
        throw new TaskpackError(
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
      const srcHandle = await open(srcPath, fsConstants.O_RDONLY | noFollow);
      const destPath = resolve(checkDir, fileEntry.path);
      await mkdir(dirname(destPath), { recursive: true, mode: 0o700 });
      let destHandle;
      try {
        const info = await srcHandle.stat();
        if (!info.isFile()) {
          throw new TaskpackError('ACTION_INPUT_INVALID', `gate helper "${fileEntry.path}" is not a regular file`);
        }
        if (fileEntry.path === relInsideDir && info.size > MAX_SCRIPT_BYTES) {
          throw new TaskpackError('ACTION_INPUT_INVALID', `gate script "${gate.script}" exceeds ${MAX_SCRIPT_BYTES} bytes`);
        }
        const isExec = fileEntry.path === relInsideDir || (info.mode & 0o111) !== 0;
        destHandle = await open(
          destPath,
          fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY | noFollow,
          isExec ? 0o555 : 0o444,
        );
        const hash = createHash('sha256');
        const chunk = Buffer.allocUnsafe(Math.min(STREAM_CHUNK_BYTES, Math.max(1, info.size)));
        let offset = 0;
        while (offset < info.size) {
          const toRead = Math.min(chunk.byteLength, info.size - offset);
          const { bytesRead } = await srcHandle.read(chunk, 0, toRead, offset);
          if (bytesRead <= 0) break;
          const slice = chunk.subarray(0, bytesRead);
          hash.update(slice);
          let written = 0;
          while (written < bytesRead) {
            const { bytesWritten } = await destHandle.write(slice, written, bytesRead - written);
            if (bytesWritten <= 0) {
              throw new TaskpackError('ACTION_INPUT_INVALID', `short write staging gate helper "${fileEntry.path}"`);
            }
            written += bytesWritten;
          }
          offset += bytesRead;
        }
        const actualDigest = hash.digest('hex');
        if (offset !== info.size || actualDigest !== fileEntry.sha256) {
          throw new TaskpackError('ACTION_INPUT_INVALID', `gate file "${fileEntry.path}" sha256 changed during copy`);
        }
        if (fileEntry.path === relInsideDir && actualDigest !== gate.scriptSha256) {
          throw new TaskpackError('ACTION_INPUT_INVALID', `gate script "${gate.script}" sha256 changed on disk`);
        }
        await destHandle.chmod(isExec ? 0o555 : 0o444);
      } finally {
        if (destHandle !== undefined) {
          await destHandle.close().catch(() => undefined);
        }
        await srcHandle.close().catch(() => undefined);
      }
    }
    const mountedScriptPath = resolve(checkDir, relInsideDir);
    if (!existsSync(mountedScriptPath)) {
      throw new TaskpackError('ACTION_INPUT_INVALID', `gate script "${gate.script}" missing inside "${scriptDirRel}"`);
    }
    await makeTreeReadOnly(checkDir);
    return mountedScriptPath;
  }

  await mkdir(checkDir, { recursive: true, mode: 0o700 });
  const fullPath = resolve(repositoryRoot, cleanScriptRel);
  assertNoSymlinkSegments(repositoryRoot, fullPath);
  const handle = await open(fullPath, fsConstants.O_RDONLY | noFollow);
  let bytes: Buffer;
  try {
    const info = await handle.stat();
    if (!info.isFile()) {
      throw new TaskpackError('ACTION_INPUT_INVALID', `gate script "${gate.script}" is not a regular file`);
    }
    if (info.size > MAX_SCRIPT_BYTES) {
      throw new TaskpackError('ACTION_INPUT_INVALID', `gate script "${gate.script}" exceeds ${MAX_SCRIPT_BYTES} bytes`);
    }
    const buf = Buffer.alloc(info.size + 1);
    let offset = 0;
    while (offset < buf.length) {
      const { bytesRead } = await handle.read(buf, offset, buf.length - offset, offset);
      if (bytesRead <= 0) break;
      offset += bytesRead;
    }
    if (offset !== info.size) {
      throw new TaskpackError('ACTION_INPUT_INVALID', `gate script "${gate.script}" changed size on disk`);
    }
    bytes = buf.subarray(0, offset);
    const digest = createHash('sha256').update(bytes).digest('hex');
    if (digest !== gate.scriptSha256) {
      throw new TaskpackError('ACTION_INPUT_INVALID', `gate script "${gate.script}" sha256 changed on disk`);
    }
  } finally {
    await handle.close();
  }
  const destPath = join(checkDir, basename(cleanScriptRel));
  const destHandle = await open(
    destPath,
    fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY | noFollow,
    0o555,
  );
  try {
    await destHandle.writeFile(bytes);
    await destHandle.chmod(0o555);
  } finally {
    await destHandle.close();
  }
  await makeTreeReadOnly(checkDir);
  return destPath;
}

const CHECK_OUT_LONE_SURROGATE_PATTERN = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u;
const CHECK_OUT_METRIC_KEY_PATTERN = /^[A-Za-z_][A-Za-z0-9._-]*$/;
const MAX_CHECK_OUT_BYTES = 65_536;
const STAGED_FORBIDDEN_KEYS: ReadonlySet<string> = new Set(['__proto__', 'constructor', 'prototype']);

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
          throw new TaskpackError('ACTION_INPUT_INVALID', 'LOOPWRIGHT_CHECK_OUT string exceeds bounds or contains lone surrogates');
        }
        return parsed;
      }
    }
    throw new TaskpackError('ACTION_INPUT_INVALID', 'LOOPWRIGHT_CHECK_OUT contains unterminated string');
  };
  const scanValue = (depth: number): void => {
    nodes += 1;
    if (nodes > 8_192 || depth > 32) {
      throw new TaskpackError('ACTION_INPUT_INVALID', 'LOOPWRIGHT_CHECK_OUT exceeds JSON complexity bounds');
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
          throw new TaskpackError('ACTION_INPUT_INVALID', 'LOOPWRIGHT_CHECK_OUT collection exceeds 128 items');
        }
        skipSpace();
        if (ch === '{') {
          if (source[offset] !== '"') {
            throw new TaskpackError('ACTION_INPUT_INVALID', 'LOOPWRIGHT_CHECK_OUT object key must be a string');
          }
          const key = readJsonString();
          if (STAGED_FORBIDDEN_KEYS.has(key) || seenKeys.has(key)) {
            throw new TaskpackError('ACTION_INPUT_INVALID', `LOOPWRIGHT_CHECK_OUT duplicate or forbidden key "${key}"`);
          }
          seenKeys.add(key);
          skipSpace();
          if (source[offset++] !== ':') {
            throw new TaskpackError('ACTION_INPUT_INVALID', 'LOOPWRIGHT_CHECK_OUT invalid object syntax');
          }
        }
        scanValue(depth + 1);
        skipSpace();
        const delim = source[offset++];
        if (delim === close) return;
        if (delim !== ',') {
          throw new TaskpackError('ACTION_INPUT_INVALID', 'LOOPWRIGHT_CHECK_OUT invalid delimiter');
        }
      }
    }
    const lit = /^(?:true|false|null|-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?)/.exec(source.slice(offset));
    if (!lit) {
      throw new TaskpackError('ACTION_INPUT_INVALID', 'LOOPWRIGHT_CHECK_OUT invalid JSON token');
    }
    offset += lit[0].length;
    if (lit[0] !== 'true' && lit[0] !== 'false' && lit[0] !== 'null') {
      const num = Number(lit[0]);
      if (!Number.isFinite(num)) {
        throw new TaskpackError('ACTION_INPUT_INVALID', 'LOOPWRIGHT_CHECK_OUT non-finite number');
      }
    }
  };

  scanValue(1);
  skipSpace();
  if (offset !== source.length) {
    throw new TaskpackError('ACTION_INPUT_INVALID', 'LOOPWRIGHT_CHECK_OUT trailing bytes');
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
    throw new TaskpackError('ACTION_INPUT_INVALID', 'LOOPWRIGHT_CHECK_OUT could not be inspected');
  }
  if (st.isSymbolicLink() || !st.isFile() || st.nlink !== 1 || st.size > MAX_CHECK_OUT_BYTES) {
    throw new TaskpackError(
      'ACTION_INPUT_INVALID',
      'LOOPWRIGHT_CHECK_OUT must be a regular non-hardlinked file of at most 65536 bytes',
    );
  }
  const noFollow = 'O_NOFOLLOW' in fsConstants ? fsConstants.O_NOFOLLOW : 0;
  const handle = await open(checkOutPath, fsConstants.O_RDONLY | noFollow);
  let rawBytes: Buffer;
  try {
    const fstat = await handle.stat();
    if (!fstat.isFile() || fstat.nlink !== 1 || fstat.size !== st.size || fstat.size > MAX_CHECK_OUT_BYTES) {
      throw new TaskpackError('ACTION_INPUT_INVALID', 'LOOPWRIGHT_CHECK_OUT changed during read');
    }
    const buf = Buffer.alloc(fstat.size + 1);
    let offset = 0;
    while (offset < buf.length) {
      const { bytesRead } = await handle.read(buf, offset, buf.length - offset, offset);
      if (bytesRead <= 0) break;
      offset += bytesRead;
    }
    if (offset !== fstat.size) {
      throw new TaskpackError('ACTION_INPUT_INVALID', 'LOOPWRIGHT_CHECK_OUT changed size during read');
    }
    rawBytes = buf.subarray(0, offset);
  } finally {
    await handle.close();
  }
  const textContent = new TextDecoder('utf-8', { fatal: true }).decode(rawBytes);
  const parsed = parseStrictCheckOutJson(textContent);
  if (!isPlainRecord(parsed)) {
    throw new TaskpackError('ACTION_INPUT_INVALID', 'LOOPWRIGHT_CHECK_OUT must be a JSON object');
  }
  for (const key of Object.keys(parsed)) {
    if (key !== 'detail' && key !== 'metrics' && key !== 'findings') {
      throw new TaskpackError('ACTION_INPUT_INVALID', `LOOPWRIGHT_CHECK_OUT contains unsupported field "${key}"`);
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
      throw new TaskpackError('ACTION_INPUT_INVALID', 'LOOPWRIGHT_CHECK_OUT detail must be a non-empty string or null');
    }
  }

  let metrics: Readonly<Record<string, MetricValue>> | undefined;
  if (Object.hasOwn(parsed, 'metrics') && parsed['metrics'] !== undefined) {
    const rawMetrics = parsed['metrics'];
    if (!isPlainRecord(rawMetrics)) {
      throw new TaskpackError('ACTION_INPUT_INVALID', 'LOOPWRIGHT_CHECK_OUT metrics must be a plain object');
    }
    const keys = Object.keys(rawMetrics).sort();
    if (keys.length > LIMITS.metricEntries) {
      throw new TaskpackError('ACTION_INPUT_INVALID', `LOOPWRIGHT_CHECK_OUT metrics exceeds ${LIMITS.metricEntries} entries`);
    }
    const cleanMetrics: Record<string, MetricValue> = {};
    for (const key of keys) {
      if (
        key.length < 1
        || key.length > LIMITS.metricKey
        || STAGED_FORBIDDEN_KEYS.has(key)
        || !CHECK_OUT_METRIC_KEY_PATTERN.test(key)
      ) {
        throw new TaskpackError('ACTION_INPUT_INVALID', `LOOPWRIGHT_CHECK_OUT metric key "${key}" is invalid`);
      }
      const val = rawMetrics[key];
      if (typeof val === 'number') {
        if (!Number.isFinite(val)) {
          throw new TaskpackError('ACTION_INPUT_INVALID', `LOOPWRIGHT_CHECK_OUT metric "${key}" must be finite`);
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
        throw new TaskpackError('ACTION_INPUT_INVALID', `LOOPWRIGHT_CHECK_OUT metric "${key}" value is invalid`);
      }
    }
    metrics = Object.freeze(cleanMetrics);
  }

  let findings: readonly StructuredFinding[] | undefined;
  if (Object.hasOwn(parsed, 'findings') && parsed['findings'] !== undefined) {
    const rawFindings = parsed['findings'];
    if (!Array.isArray(rawFindings) || rawFindings.length > LIMITS.findings) {
      throw new TaskpackError('ACTION_INPUT_INVALID', `LOOPWRIGHT_CHECK_OUT findings must be an array of at most ${LIMITS.findings} items`);
    }
    const cleanFindings: StructuredFinding[] = [];
    for (const item of rawFindings) {
      if (!isPlainRecord(item)) {
        throw new TaskpackError('ACTION_INPUT_INVALID', 'LOOPWRIGHT_CHECK_OUT finding must be an object');
      }
      for (const k of Object.keys(item)) {
        if (k !== 'title' && k !== 'severity' && k !== 'evidence' && k !== 'path' && k !== 'line') {
          throw new TaskpackError('ACTION_INPUT_INVALID', `LOOPWRIGHT_CHECK_OUT finding has unknown key "${k}"`);
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
        throw new TaskpackError('ACTION_INPUT_INVALID', 'LOOPWRIGHT_CHECK_OUT finding fields are invalid');
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
            throw new TaskpackError('ACTION_INPUT_INVALID', 'LOOPWRIGHT_CHECK_OUT finding path is invalid');
          }
          findingPath = v.value;
        } else {
          throw new TaskpackError('ACTION_INPUT_INVALID', 'LOOPWRIGHT_CHECK_OUT finding path must be relative string or null');
        }
      }
      let findingLine: number | null | undefined;
      if (Object.hasOwn(item, 'line') && item['line'] !== undefined) {
        if (item['line'] === null) {
          findingLine = null;
        } else if (typeof item['line'] === 'number' && Number.isSafeInteger(item['line']) && item['line'] >= 1) {
          findingLine = item['line'];
        } else {
          throw new TaskpackError('ACTION_INPUT_INVALID', 'LOOPWRIGHT_CHECK_OUT finding line must be positive integer or null');
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

async function projectVerifiedCasCandidateFile(options: {
  readonly canonicalBlobPath: string;
  readonly destPath: string;
  readonly fileName: string;
  readonly expectedSha256: string;
  readonly expectedByteLength: number;
  readonly targetMode: number;
  readonly disableReflink: boolean;
}): Promise<void> {
  const { canonicalBlobPath, destPath, fileName, expectedSha256, expectedByteLength, targetMode } = options;
  const noFollow = 'O_NOFOLLOW' in fsConstants ? fsConstants.O_NOFOLLOW : 0;
  const currentUid = typeof process.getuid === 'function' ? process.getuid() : undefined;
  const destParentDir = dirname(destPath);
  const before = await lstat(canonicalBlobPath);
  if (before.isSymbolicLink() || !before.isFile() || before.nlink !== 1 || before.size !== expectedByteLength) {
    throw new TaskpackError('ACTION_INPUT_INVALID', `CAS blob for "${fileName}" failed lstat/nlink verification`);
  }

  let existingDest: Stats | null = null;
  try {
    existingDest = await lstat(destPath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException | null)?.code !== 'ENOENT') {
      throw err;
    }
  }
  if (existingDest !== null) {
    throw new TaskpackError('ACTION_INPUT_INVALID', `CAS candidate destination "${fileName}" already exists`);
  }

  const srcHandle = await open(canonicalBlobPath, fsConstants.O_RDONLY | noFollow);
  const streamTmpPath = join(destParentDir, `.lw-stage-${randomBytes(12).toString('hex')}`);
  let createdStreamTmp = false;
  let parentFh: FileHandle | undefined;
  let tmpHandle: FileHandle | undefined;
  let finalHandle: FileHandle | undefined;
  try {
    parentFh = await open(destParentDir, fsConstants.O_RDONLY | noFollow);
    const parentSt = await parentFh.stat();
    if (parentSt.isSymbolicLink() || !parentSt.isDirectory() || (currentUid !== undefined && parentSt.uid !== currentUid)) {
      throw new TaskpackError('ACTION_INPUT_INVALID', `candidate parent directory for "${fileName}" failed O_NOFOLLOW ownership check`);
    }

    const srcInfo = await srcHandle.stat();
    if (
      !srcInfo.isFile()
      || srcInfo.isSymbolicLink()
      || srcInfo.nlink !== 1
      || srcInfo.dev !== before.dev
      || srcInfo.ino !== before.ino
      || srcInfo.size !== expectedByteLength
    ) {
      throw new TaskpackError('ACTION_INPUT_INVALID', `CAS blob for "${fileName}" changed before streaming`);
    }
    tmpHandle = await open(
      streamTmpPath,
      fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_RDWR | noFollow,
      0o600,
    );
    createdStreamTmp = true;
    const createdStat = await tmpHandle.stat();
    if (
      !createdStat.isFile()
      || createdStat.isSymbolicLink()
      || createdStat.nlink !== 1
      || (currentUid !== undefined && createdStat.uid !== currentUid)
      || (createdStat.dev === srcInfo.dev && createdStat.ino === srcInfo.ino)
    ) {
      throw new TaskpackError('ACTION_INPUT_INVALID', `materialized CAS candidate "${fileName}" failed temp identity/nlink/ownership check`);
    }

    const hash = createHash('sha256');
    const chunk = Buffer.allocUnsafe(Math.min(STREAM_CHUNK_BYTES, Math.max(1, expectedByteLength)));
    const probe = Buffer.allocUnsafe(1);
    let offset = 0;
    while (offset < expectedByteLength) {
      const toRead = Math.min(chunk.byteLength, expectedByteLength - offset);
      const { bytesRead } = await srcHandle.read(chunk, 0, toRead, offset);
      if (bytesRead <= 0) break;
      const slice = chunk.subarray(0, bytesRead);
      hash.update(slice);
      let written = 0;
      while (written < bytesRead) {
        const { bytesWritten } = await tmpHandle.write(slice, written, bytesRead - written, offset + written);
        if (bytesWritten <= 0) {
          throw new TaskpackError('ACTION_INPUT_INVALID', `short write materializing CAS candidate "${fileName}"`);
        }
        written += bytesWritten;
      }
      offset += bytesRead;
    }
    const { bytesRead: extraRead } = await srcHandle.read(probe, 0, 1, offset);
    const srcAfter = await srcHandle.stat();
    if (
      offset !== expectedByteLength
      || extraRead !== 0
      || srcAfter.dev !== srcInfo.dev
      || srcAfter.ino !== srcInfo.ino
      || srcAfter.nlink !== 1
      || srcAfter.size !== srcInfo.size
      || srcAfter.mtimeMs !== srcInfo.mtimeMs
      || srcAfter.ctimeMs !== srcInfo.ctimeMs
      || hash.digest('hex') !== expectedSha256
    ) {
      throw new TaskpackError('ACTION_INPUT_INVALID', `CAS candidate "${fileName}" sha256 or stability mismatch`);
    }

    await tmpHandle.sync();
    const verifyHash = createHash('sha256');
    let verifyOffset = 0;
    while (verifyOffset < expectedByteLength) {
      const toRead = Math.min(chunk.byteLength, expectedByteLength - verifyOffset);
      const { bytesRead } = await tmpHandle.read(chunk, 0, toRead, verifyOffset);
      if (bytesRead <= 0) break;
      verifyHash.update(chunk.subarray(0, bytesRead));
      verifyOffset += bytesRead;
    }
    const { bytesRead: verifyExtra } = await tmpHandle.read(probe, 0, 1, verifyOffset);
    const verifiedTmpStat = await tmpHandle.stat();
    const srcAfterVerify = await srcHandle.stat();
    if (
      verifyOffset !== expectedByteLength
      || verifyExtra !== 0
      || verifiedTmpStat.dev !== createdStat.dev
      || verifiedTmpStat.ino !== createdStat.ino
      || verifiedTmpStat.nlink !== 1
      || (currentUid !== undefined && verifiedTmpStat.uid !== currentUid)
      || verifiedTmpStat.size !== expectedByteLength
      || srcAfterVerify.dev !== srcInfo.dev
      || srcAfterVerify.ino !== srcInfo.ino
      || srcAfterVerify.nlink !== 1
      || verifyHash.digest('hex') !== expectedSha256
    ) {
      throw new TaskpackError('ACTION_INPUT_INVALID', `materialized CAS candidate "${fileName}" failed post-stream sha256 verification`);
    }

    await tmpHandle.chmod(targetMode);
    await tmpHandle.sync();
    const sealedStat = await tmpHandle.stat();
    if (
      !sealedStat.isFile()
      || sealedStat.isSymbolicLink()
      || sealedStat.nlink !== 1
      || (currentUid !== undefined && sealedStat.uid !== currentUid)
      || sealedStat.dev !== createdStat.dev
      || sealedStat.ino !== createdStat.ino
      || sealedStat.size !== expectedByteLength
      || (sealedStat.mode & 0o777) !== targetMode
    ) {
      throw new TaskpackError('ACTION_INPUT_INVALID', `materialized CAS candidate "${fileName}" failed post-fchmod verification`);
    }

    await link(streamTmpPath, destPath);
    await unlink(streamTmpPath);
    createdStreamTmp = false;

    const afterParentStat = await lstat(destParentDir);
    if (
      afterParentStat.isSymbolicLink()
      || !afterParentStat.isDirectory()
      || afterParentStat.dev !== parentSt.dev
      || afterParentStat.ino !== parentSt.ino
    ) {
      throw new TaskpackError('ACTION_INPUT_INVALID', `candidate parent directory for "${fileName}" changed during publish`);
    }

    finalHandle = await open(destPath, fsConstants.O_RDONLY | noFollow);
    const destStat = await finalHandle.stat();
    const tmpAfterPublishStat = await tmpHandle.stat();
    await finalHandle.close();
    finalHandle = undefined;
    await tmpHandle.close();
    tmpHandle = undefined;
    if (
      destStat.isSymbolicLink()
      || !destStat.isFile()
      || destStat.nlink !== 1
      || tmpAfterPublishStat.nlink !== 1
      || tmpAfterPublishStat.dev !== createdStat.dev
      || tmpAfterPublishStat.ino !== createdStat.ino
      || (currentUid !== undefined && destStat.uid !== currentUid)
      || destStat.dev !== createdStat.dev
      || destStat.ino !== createdStat.ino
      || destStat.size !== expectedByteLength
      || (destStat.mode & 0o777) !== targetMode
    ) {
      throw new TaskpackError('ACTION_INPUT_INVALID', `materialized CAS candidate "${fileName}" failed post-publish nlink check`);
    }
  } catch (error) {
    if (finalHandle !== undefined) {
      await finalHandle.close().catch(() => undefined);
    }
    if (tmpHandle !== undefined) {
      await tmpHandle.close().catch(() => undefined);
    }
    if (createdStreamTmp) {
      await unlink(streamTmpPath).catch(() => undefined);
    }
    throw error;
  } finally {
    if (parentFh !== undefined) {
      await parentFh.close().catch(() => undefined);
    }
    await srcHandle.close().catch(() => undefined);
  }
}

async function publishInlineCandidateFileAtomic(
  destPath: string,
  bytes: Buffer,
  targetMode: number,
  fileName: string,
): Promise<void> {
  const noFollow = 'O_NOFOLLOW' in fsConstants ? fsConstants.O_NOFOLLOW : 0;
  const currentUid = typeof process.getuid === 'function' ? process.getuid() : undefined;
  const destParentDir = dirname(destPath);
  const tmpPath = join(destParentDir, `.lw-stage-${randomBytes(12).toString('hex')}`);
  let createdTmp = false;
  let handle;
  let finalHandle;
  try {
    handle = await open(
      tmpPath,
      fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY | noFollow,
      0o600,
    );
    createdTmp = true;
    await handle.writeFile(bytes);
    await handle.chmod(targetMode);
    await handle.sync();
    const sealed = await handle.stat();
    await handle.close();
    handle = undefined;

    await link(tmpPath, destPath);
    await unlink(tmpPath);
    createdTmp = false;

    finalHandle = await open(destPath, fsConstants.O_RDONLY | noFollow);
    const finalStat = await finalHandle.stat();
    await finalHandle.close();
    finalHandle = undefined;
    if (
      finalStat.isSymbolicLink()
      || !finalStat.isFile()
      || finalStat.nlink !== 1
      || (currentUid !== undefined && finalStat.uid !== currentUid)
      || finalStat.dev !== sealed.dev
      || finalStat.ino !== sealed.ino
      || finalStat.size !== bytes.byteLength
      || (finalStat.mode & 0o777) !== targetMode
    ) {
      throw new TaskpackError('ACTION_INPUT_INVALID', `inline candidate "${fileName}" failed post-publish verification`);
    }
  } catch (error) {
    if (handle !== undefined) {
      await handle.close().catch(() => undefined);
    }
    if (finalHandle !== undefined) {
      await finalHandle.close().catch(() => undefined);
    }
    if (createdTmp) {
      await unlink(tmpPath).catch(() => undefined);
    }
    throw error;
  }
}

async function materializeCandidateFiles(
  targetDir: string,
  files: readonly InspectedCandidateFile[],
  disableReflink = false,
): Promise<void> {
  for (const file of files) {
    const dest = resolve(targetDir, file.name);
    const parent = dirname(dest);
    assertNoSymlinkSegments(targetDir, parent);
    await mkdir(parent, { recursive: true, mode: 0o700 });
    assertNoSymlinkSegments(targetDir, parent);
    const targetMode = file.mode === '100755' ? 0o755 : 0o600;
    if (file.kind === 'cas') {
      await projectVerifiedCasCandidateFile({
        canonicalBlobPath: file.canonicalBlobPath,
        destPath: dest,
        fileName: file.name,
        expectedSha256: file.sha256,
        expectedByteLength: file.byteLength,
        targetMode,
        disableReflink,
      });
    } else {
      await publishInlineCandidateFileAtomic(dest, file.bytes, targetMode, file.name);
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
    throw new TaskpackError('ACTION_INPUT_INVALID', `git ${args[0] ?? 'command'} failed to spawn: ${result.spawnError}`);
  }
  if (result.stdoutOverflow) {
    throw new TaskpackError('ACTION_INPUT_INVALID', `git ${args[0] ?? 'command'} output exceeded ${maxStdoutBytes} bytes`);
  }
  if (result.timedOut) {
    throw new TaskpackError('ACTION_INPUT_INVALID', `git ${args[0] ?? 'command'} timed out after ${timeoutMs}ms`);
  }
  if (result.code !== 0 || result.signal !== null) {
    const stderrText = result.stderr.toString('utf8').trim();
    const detail = stderrText.length > 0 ? `: ${stderrText}` : '';
    throw new TaskpackError('ACTION_INPUT_INVALID', `git ${args[0] ?? 'command'} exited with ${result.code ?? result.signal}${detail}`);
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
          throw new TaskpackError('ACTION_INPUT_INVALID', 'unexpected EOF reading git cat-file --batch header');
        }
        continue;
      }
      const head = this.#chunks[0]!;
      const nl = head.indexOf(10, this.#headOffset);
      if (nl !== -1) {
        const piece = head.subarray(this.#headOffset, nl);
        if (total + piece.byteLength > maxBytes) {
          throw new TaskpackError('ACTION_INPUT_INVALID', 'git cat-file --batch header exceeded maximum length');
        }
        parts.push(piece);
        this.#consumeHead(nl - this.#headOffset + 1);
        return Buffer.concat(parts).toString('utf8');
      }
      const piece = head.subarray(this.#headOffset);
      total += piece.byteLength;
      if (total > maxBytes) {
        throw new TaskpackError('ACTION_INPUT_INVALID', 'git cat-file --batch header exceeded maximum length');
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
          throw new TaskpackError('ACTION_INPUT_INVALID', 'unexpected EOF reading git cat-file --batch blob body');
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
        throw new TaskpackError('ACTION_INPUT_INVALID', 'unexpected EOF reading git cat-file --batch delimiter');
      }
    }
    if (this.#chunks[0]![this.#headOffset]! !== expected) {
      throw new TaskpackError('ACTION_INPUT_INVALID', 'malformed delimiter in git cat-file --batch output');
    }
    this.#consumeHead(1);
  }

  async assertExhausted(): Promise<void> {
    while (!this.#ended) {
      await this.#waitMore();
    }
    if (this.#queuedBytes !== 0) {
      throw new TaskpackError('ACTION_INPUT_INVALID', 'trailing bytes in git cat-file --batch output');
    }
  }
}

export interface BaselineRegularEntry {
  readonly path: string;
  readonly mode: '100644' | '100755';
  readonly oid: string;
  readonly byteLength: number;
}

function validateBaselineGitPath(rawPath: string): string {
  const clean = normalizeCandidateRelativePath(rawPath);
  for (const segment of clean.split('/')) {
    if (segment.toLowerCase() === '.git' || Buffer.byteLength(segment, 'utf8') > 255) {
      throw new TaskpackError('ACTION_INPUT_INVALID', `invalid baseline path segment in "${clean}"`);
    }
  }
  if (!digestArtifact(clean, new Uint8Array()).ok) {
    throw new TaskpackError('ACTION_INPUT_INVALID', `invalid baseline artifact path "${clean}"`);
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
    throw new TaskpackError(
      'ACTION_INPUT_INVALID',
      `baseTree OIDs do not match objectFormat "${baseTree.objectFormat}"`,
    );
  }
  if (expectedCommitOid !== undefined && baseTree.commitOid !== expectedCommitOid) {
    throw new TaskpackError(
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
    throw new TaskpackError(
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
    throw new TaskpackError('ACTION_INPUT_INVALID', 'baseTree commitOid is invalid');
  }
  const stdout = await execGit(
    repositoryRoot,
    ['ls-tree', '-r', '-l', '-z', '--full-tree', commitOid],
    { env: buildCleanGitEnv(), maxStdoutBytes: MAX_GIT_LIST_BYTES, timeoutMs: 30_000 },
  );
  if (stdout.byteLength > 0 && stdout.at(-1) !== 0) {
    throw new TaskpackError('ACTION_INPUT_INVALID', 'git ls-tree output exceeded boundary');
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
        throw new TaskpackError(
          'ACTION_INPUT_INVALID',
          `unsupported unprotected ${symlinkMatch !== null ? 'symlink' : 'gitlink'} "${specialPath}" in baseline tree`,
        );
      }
      continue;
    }
    const match = /^(100644|100755) blob ([0-9a-f]{40}|[0-9a-f]{64}) +([0-9]+)\t(.+)$/s.exec(row);
    if (match === null) {
      throw new TaskpackError('ACTION_INPUT_INVALID', 'unsupported git ls-tree entry in baseline tree');
    }
    const mode = match[1] as '100644' | '100755';
    const oid = match[2]!;
    const byteLength = Number(match[3]!);
    if (!Number.isSafeInteger(byteLength) || byteLength < 0) {
      throw new TaskpackError('ACTION_INPUT_INVALID', 'invalid baseline blob byteLength');
    }
    const path = validateBaselineGitPath(match[4]!);
    entries.push({ path, mode, oid, byteLength });
    if (entries.length > LIMITS.baselineEntries) {
      throw new TaskpackError('ACTION_INPUT_INVALID', `baseline tree exceeds ${LIMITS.baselineEntries} regular files`);
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
    child.once('error', err => reject(new TaskpackError('ACTION_INPUT_INVALID', `git cat-file --batch failed: ${err.message}`)));
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
    const noFollow = 'O_NOFOLLOW' in fsConstants ? fsConstants.O_NOFOLLOW : 0;
    for (const entry of entries) {
      const header = await reader.readLine(256);
      const space1 = header.indexOf(' ');
      const space2 = space1 === -1 ? -1 : header.indexOf(' ', space1 + 1);
      if (space1 === -1 || space2 === -1 || header.indexOf(' ', space2 + 1) !== -1) {
        throw new TaskpackError('ACTION_INPUT_INVALID', 'malformed git cat-file --batch header');
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
        throw new TaskpackError('ACTION_INPUT_INVALID', `baseline blob mismatch for "${entry.path}"`);
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
        fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY | noFollow,
        fileMode,
      );
      try {
        await reader.streamBytes(entry.byteLength, async slice => {
          blobHash.update(slice);
          let offset = 0;
          while (offset < slice.byteLength) {
            const { bytesWritten } = await handle.write(slice, offset, slice.byteLength - offset);
            if (bytesWritten <= 0) {
              throw new TaskpackError('ACTION_INPUT_INVALID', `short write materializing "${entry.path}"`);
            }
            offset += bytesWritten;
          }
        });
        if (blobHash.digest('hex') !== entry.oid) {
          throw new TaskpackError('ACTION_INPUT_INVALID', `baseline blob digest mismatch for "${entry.path}"`);
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
      throw new TaskpackError('ACTION_INPUT_INVALID', `git cat-file --batch timed out after ${timeoutMs}ms`);
    }
    if (exit.code !== 0 || exit.signal !== null) {
      const stderrText = Buffer.concat(stderrChunks).toString('utf8').trim();
      const detail = stderrText.length > 0 ? `: ${stderrText}` : '';
      throw new TaskpackError('ACTION_INPUT_INVALID', `git cat-file --batch exited with ${exit.code ?? exit.signal}${detail}`);
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
  files: readonly InspectedCandidateFile[],
  baselineModes: ReadonlyMap<string, '100644' | '100755'>,
  disableReflink = false,
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
    const effectiveGitMode = file.mode ?? baselineModes.get(file.name) ?? '100644';
    const mode = effectiveGitMode === '100755' ? 0o755 : 0o600;
    await unlink(dest).catch((err: NodeJS.ErrnoException) => {
      if (err.code !== 'ENOENT') throw err;
    });
    if (file.kind === 'cas') {
      await projectVerifiedCasCandidateFile({
        canonicalBlobPath: file.canonicalBlobPath,
        destPath: dest,
        fileName: file.name,
        expectedSha256: file.sha256,
        expectedByteLength: file.byteLength,
        targetMode: mode,
        disableReflink,
      });
    } else {
      await publishInlineCandidateFileAtomic(dest, file.bytes, mode, file.name);
    }
  }
}

export async function assertDeletedPathsAbsent(
  candidateDir: string,
  deletedPaths: readonly string[],
  overlayFileNames: ReadonlySet<string> = new Set<string>(),
): Promise<void> {
  const normalizedOverlayFiles = new Set<string>();
  const overlayAncestorDirs = new Set<string>();
  for (const rawOverlay of overlayFileNames) {
    const normOverlay = normalizeCandidateRelativePath(rawOverlay);
    normalizedOverlayFiles.add(normOverlay);
    let slash = normOverlay.indexOf('/');
    while (slash !== -1) {
      overlayAncestorDirs.add(normOverlay.slice(0, slash));
      slash = normOverlay.indexOf('/', slash + 1);
    }
  }

  for (const rawRelPath of deletedPaths) {
    const relPath = normalizeCandidateRelativePath(rawRelPath);
    const segments = relPath.split('/');
    for (let i = 0; i < segments.length; i += 1) {
      const prefixRel = segments.slice(0, i + 1).join('/');
      const currentPath = resolve(candidateDir, prefixRel);
      let st: Stats;
      try {
        st = await lstat(currentPath);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
          break;
        }
        throw error;
      }
      if (st.isSymbolicLink()) {
        throw new TaskpackError('ACTION_INPUT_INVALID', `deleted candidate path "${relPath}" traverses a symbolic link`);
      }
      if (i < segments.length - 1) {
        if (st.isDirectory()) {
          continue;
        }
        if (st.isFile() && st.nlink === 1 && normalizedOverlayFiles.has(prefixRel)) {
          break;
        }
        throw new TaskpackError(
          'ACTION_INPUT_INVALID',
          `deleted candidate path "${relPath}" has unexpected non-directory ancestor "${prefixRel}"`,
        );
      }
      if (st.isDirectory() && overlayAncestorDirs.has(relPath)) {
        break;
      }
      throw new TaskpackError('ACTION_INPUT_INVALID', `deleted candidate path "${relPath}" is still present`);
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
      throw new TaskpackError('ACTION_INPUT_INVALID', `forbidden env variable "${envName}" in command.v1 gate`);
    }
    const value = runtimeEnv?.[envName];
    if (typeof value === 'string') {
      childEnv[envName] = value;
    }
  }

  if (gate.envMap !== undefined) {
    for (const [envName, envValue] of Object.entries(gate.envMap)) {
      if (
        envName === 'RUNNER_ENVIRONMENT'
        || envName === 'GITHUB_ACTIONS'
        || isForbiddenChildEnvName(envName, forbiddenEnvNames)
        || isForbiddenPreflightEnvName(envName, forbiddenEnvNames)
      ) {
        throw new TaskpackError('ACTION_INPUT_INVALID', `forbidden envMap variable "${envName}" in command.v1 gate`);
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
  childEnv['TMPPREFIX'] = join(scratchTmp, 'zsh');
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

const COMMAND_DENIED_HOME_SUBPATHS: readonly string[] = Object.freeze([
  ...DEFAULT_DENIED_HOME_SUBPATHS,
  '.gitconfig',
  '.git-credentials',
]);

export const LINUX_COMMAND_POSITIVE_READ_ROOTS: readonly string[] = Object.freeze([
  '/usr',
  '/bin',
  '/sbin',
  '/lib',
  '/lib64',
  '/lib32',
  '/etc/alternatives',
  '/etc/ssl',
  '/etc/ca-certificates',
  '/etc/pki',
  '/etc/ld.so.cache',
  '/etc/ld.so.conf',
  '/etc/ld.so.conf.d',
  '/etc/localtime',
  '/etc/passwd',
  '/etc/group',
  '/etc/hosts',
  '/etc/resolv.conf',
  '/etc/nsswitch.conf',
  '/proc/cpuinfo',
  '/proc/meminfo',
  '/proc/stat',
  '/proc/version',
  '/proc/uptime',
  '/proc/loadavg',
  '/proc/sys/kernel/random',
  '/dev',
  '/sys/devices/system/cpu',
]);

const LINUX_BWRAP_TOP_SYMLINK_DIRS: readonly string[] = Object.freeze([
  '/bin',
  '/sbin',
  '/lib',
  '/lib64',
  '/lib32',
]);

const LINUX_BWRAP_ETC_SYS_READ_PATHS: readonly string[] = Object.freeze([
  '/etc/alternatives',
  '/etc/ssl',
  '/etc/ca-certificates',
  '/etc/pki',
  '/etc/ld.so.cache',
  '/etc/ld.so.conf',
  '/etc/ld.so.conf.d',
  '/etc/localtime',
  '/etc/passwd',
  '/etc/group',
  '/etc/hosts',
  '/etc/resolv.conf',
  '/etc/nsswitch.conf',
  '/sys/devices/system/cpu',
]);

export const DARWIN_COMMAND_POSITIVE_READ_ROOTS: readonly string[] = Object.freeze([
  '/System',
  '/usr',
  '/bin',
  '/sbin',
  '/Library/Apple',
  '/Library/Developer',
  '/Library/Frameworks',
  '/Library/Preferences',
  '/Applications/Xcode.app',
  '/opt/homebrew',
  '/dev',
  '/private/etc',
  '/private/var/db',
  '/private/var/select',
]);

export const BWRAP_LOOPBACK_UP_SCRIPT = [
  'import fcntl, os, socket, struct, sys',
  's = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)',
  'try:',
  "    ifr = struct.pack('16sH14s', b'lo', 0, b'')",
  '    res = fcntl.ioctl(s.fileno(), 0x8913, ifr)',
  "    flags = struct.unpack('16sH14s', res)[1]",
  '    if not (flags & 0x1):',
  "        fcntl.ioctl(s.fileno(), 0x8914, struct.pack('16sH14s', b'lo', flags | 0x1, b''))",
  'finally:',
  '    s.close()',
  'os.execv(sys.argv[1], sys.argv[1:])',
].join('\n');

let cachedLinuxBwrapNetPath: string | null | undefined;
let cachedLinuxBwrapMountPath: string | null | undefined;
let cachedLinuxLandlockInfo: { readonly executable: string; readonly abi: number; readonly seccompAvailable: boolean } | null | undefined;

function resolveLinuxBwrapForNoNet(): string | null {
  if (process.platform !== 'linux') return null;
  if (cachedLinuxBwrapNetPath !== undefined) return cachedLinuxBwrapNetPath;
  for (const candidate of TRUSTED_BWRAP_PATHS) {
    if (!existsSync(candidate)) continue;
    const probe = spawnSync(
      candidate,
      ['--unshare-pid', '--unshare-net', '--die-with-parent', '--ro-bind', '/', '/', '--', '/bin/true'],
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

function resolveLinuxBwrapForMountOnly(): string | null {
  if (process.platform !== 'linux') return null;
  if (cachedLinuxBwrapMountPath !== undefined) return cachedLinuxBwrapMountPath;
  for (const candidate of TRUSTED_BWRAP_PATHS) {
    if (!existsSync(candidate)) continue;
    const probe = spawnSync(
      candidate,
      ['--unshare-pid', '--die-with-parent', '--ro-bind', '/', '/', '--', '/bin/true'],
      { stdio: 'ignore', timeout: 3_000 },
    );
    if (probe.status === 0 && probe.error === undefined) {
      cachedLinuxBwrapMountPath = candidate;
      return candidate;
    }
  }
  cachedLinuxBwrapMountPath = null;
  return null;
}

function resolveLinuxLandlockPython(): { readonly executable: string; readonly abi: number; readonly seccompAvailable: boolean } | null {
  if (process.platform !== 'linux') return null;
  if (cachedLinuxLandlockInfo !== undefined) return cachedLinuxLandlockInfo;
  for (const candidate of TRUSTED_PYTHON_PATHS) {
    if (!existsSync(candidate)) continue;
    const probe = spawnSync(
      candidate,
      ['-I', '-S', '-B', '-c', LANDLOCK_HOST_PROBE_SCRIPT],
      { cwd: '/', encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 3_000 },
    );
    if (probe.status === 0 && probe.error === undefined) {
      const parts = (probe.stdout ?? '').trim().split(':');
      const abi = Number.parseInt(parts[0] ?? '', 10);
      const seccompAvailable = parts[1] === '1';
      if (Number.isSafeInteger(abi) && abi >= 3 && seccompAvailable) {
        cachedLinuxLandlockInfo = Object.freeze({ executable: candidate, abi, seccompAvailable });
        return cachedLinuxLandlockInfo;
      }
    }
  }
  cachedLinuxLandlockInfo = null;
  return null;
}

function canonicalizeCommandContainmentPath(rawPath: string, label: string): string {
  if (typeof rawPath !== 'string' || rawPath.length === 0 || rawPath.length > 1024 || /[\0\r\n"\\]/.test(rawPath)) {
    throw new TaskpackError('SANDBOX_POLICY_INVALID', `${label} is invalid or contains forbidden characters`, label);
  }
  if (!isAbsolute(rawPath)) {
    throw new TaskpackError('SANDBOX_POLICY_INVALID', `${label} must be an absolute path`, label);
  }
  const resolved = resolve(rawPath);
  const suffixSegments: string[] = [];
  let cursor = resolved;
  for (;;) {
    if (existsSync(cursor)) {
      try {
        const realBase = realpathSync(cursor);
        const joined = suffixSegments.length === 0 ? realBase : join(realBase, ...[...suffixSegments].reverse());
        if (/[\0\r\n"\\]/.test(joined)) {
          throw new TaskpackError('SANDBOX_POLICY_INVALID', `${label} resolved to forbidden characters`, label);
        }
        return joined;
      } catch (error) {
        if (error instanceof TaskpackError) throw error;
        // Fall through to parent if cursor is a broken symlink.
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

function isSameOrStrictChildPath(candidate: string, parent: string): boolean {
  if (parent === '/') return true;
  return candidate === parent || candidate.startsWith(`${parent}/`);
}

function isStrictChildPath(candidate: string, parent: string): boolean {
  if (parent === '/') return candidate !== '/' && candidate.startsWith('/');
  return candidate.startsWith(`${parent}/`);
}

function isSameOrStrictChildCaseInsensitive(candidate: string, parent: string): boolean {
  return isSameOrStrictChildPath(candidate.normalize('NFC').toLowerCase(), parent.normalize('NFC').toLowerCase());
}

function sortPathsShortestFirst(paths: Iterable<string>): readonly string[] {
  return Object.freeze(
    [...new Set(paths)].sort((a, b) => a.length - b.length || (a < b ? -1 : a > b ? 1 : 0)),
  );
}

function collectDefaultDeniedHomePaths(): ReadonlySet<string> {
  const out = new Set<string>();
  const rawHome = homedir();
  if (typeof rawHome === 'string' && rawHome.length > 0 && isAbsolute(rawHome) && !/[\0\r\n"\\]/.test(rawHome)) {
    const canonHome = canonicalizeCommandContainmentPath(rawHome, 'homedir');
    if (canonHome !== '/') {
      for (const sub of COMMAND_DENIED_HOME_SUBPATHS) {
        out.add(canonicalizeCommandContainmentPath(join(canonHome, sub), `homedir/${sub}`));
      }
    }
  }
  return out;
}

function tryLstatSync(targetPath: string): Stats | null {
  try {
    return lstatSync(targetPath);
  } catch {
    return null;
  }
}

export interface BuildCommandScriptInvocationOptions {
  readonly args?: readonly string[] | undefined;
  readonly allowCheckNetwork?: boolean | undefined;
  readonly networkMode?: SandboxNetworkMode | undefined;
  readonly readOnlyGitObjectsBind?: ReadOnlyGitObjectsBind | null | undefined;
  readonly writablePaths?: readonly string[] | undefined;
  readonly deniedReadPaths?: readonly string[] | undefined;
  readonly allowedReadOnlyPaths?: readonly string[] | undefined;
  readonly cwd?: string | undefined;
  readonly env?: Readonly<Record<string, string>> | undefined;
  readonly requireFilesystemContainment?: boolean | undefined;
  readonly platform?: NodeJS.Platform | undefined;
  readonly arch?: string | undefined;
  readonly shellExecutable?: string | undefined;
  readonly linuxBwrapExecutable?: string | null | undefined;
  readonly linuxPythonExecutable?: string | null | undefined;
  readonly linuxSeccompAvailable?: boolean | undefined;
  readonly allowDedicatedRunnerLoopbackFallback?: boolean | undefined;
  readonly darwinSeatbeltAvailable?: boolean | undefined;
  readonly darwinSeatbeltHelperSocketPath?: string | undefined;
}

export interface CommandScriptInvocation {
  readonly command: string;
  readonly args: readonly string[];
  readonly networkIsolated: boolean;
  readonly filesystemIsolated: boolean;
  readonly processIsolated: boolean;
  readonly spawnCwd?: string | undefined;
  readonly seccompBpf?: Buffer | undefined;
}

export function buildCommandScriptInvocation(
  scriptFullPath: string,
  options?: BuildCommandScriptInvocationOptions,
): CommandScriptInvocation {
  const platform = options?.platform ?? process.platform;
  const shell = options?.shellExecutable ?? resolveShellExecutable();
  const baseArgs = [scriptFullPath, ...(options?.args ?? [])];
  const networkMode: SandboxNetworkMode = options?.networkMode
    ?? (options?.allowCheckNetwork === true ? 'allow-outbound' : 'none');
  if (networkMode !== 'none' && networkMode !== 'loopback-only' && networkMode !== 'allow-outbound') {
    throw new TaskpackError('SANDBOX_POLICY_INVALID', `unsupported command.v1 networkMode "${String(networkMode)}"`, 'networkMode');
  }
  const allowNet = networkMode === 'allow-outbound';
  const rawGitBind = options?.readOnlyGitObjectsBind ?? null;
  const gitBind = rawGitBind === null
    ? null
    : {
        sourceObjectsDir: canonicalizeCommandContainmentPath(rawGitBind.sourceObjectsDir, 'readOnlyGitObjectsBind.sourceObjectsDir'),
        targetObjectsDir: canonicalizeCommandContainmentPath(rawGitBind.targetObjectsDir, 'readOnlyGitObjectsBind.targetObjectsDir'),
      };
  const hasExplicitWritablePaths = options?.writablePaths !== undefined;
  const requireFs = options?.requireFilesystemContainment ?? hasExplicitWritablePaths;
  const canonicalCwd = options?.cwd !== undefined
    ? canonicalizeCommandContainmentPath(options.cwd, 'cwd')
    : undefined;
  const homeDeniedSet = collectDefaultDeniedHomePaths();

  const writableRawSet = new Set<string>();
  for (const [idx, wp] of (options?.writablePaths ?? []).entries()) {
    const canon = canonicalizeCommandContainmentPath(wp, `writablePaths/${idx}`);
    if (canon === '/') {
      throw new TaskpackError('TASKPACK_SCOPE_VIOLATION', 'command.v1 writablePaths must not include "/"');
    }
    for (const hd of homeDeniedSet) {
      if (isSameOrStrictChildPath(canon, hd) || isSameOrStrictChildCaseInsensitive(canon, hd)) {
        throw new TaskpackError('TASKPACK_SCOPE_VIOLATION', `command.v1 writablePath "${wp}" overlaps denied home secret path "${hd}"`);
      }
    }
    writableRawSet.add(canon);
  }
  const canonicalWritables = sortPathsShortestFirst(writableRawSet);

  const allowedRoRawSet = new Set<string>();
  for (const [idx, ro] of (options?.allowedReadOnlyPaths ?? []).entries()) {
    const canon = canonicalizeCommandContainmentPath(ro, `allowedReadOnlyPaths/${idx}`);
    if (canon === '/') continue;
    for (const hd of homeDeniedSet) {
      if (isSameOrStrictChildPath(canon, hd) || isSameOrStrictChildCaseInsensitive(canon, hd)) {
        throw new TaskpackError('TASKPACK_SCOPE_VIOLATION', `command.v1 allowedReadOnlyPath "${ro}" overlaps denied home secret path "${hd}"`);
      }
    }
    allowedRoRawSet.add(canon);
  }
  const canonicalAllowedRo = sortPathsShortestFirst(allowedRoRawSet);

  const explicitReopenSet = new Set<string>([...canonicalAllowedRo, ...canonicalWritables]);
  const deniedRawSet = new Set<string>();
  for (const [idx, dp] of (options?.deniedReadPaths ?? []).entries()) {
    const canon = canonicalizeCommandContainmentPath(dp, `deniedReadPaths/${idx}`);
    if (canon === '/' || canon === canonicalCwd || explicitReopenSet.has(canon)) {
      continue;
    }
    deniedRawSet.add(canon);
  }
  const canonicalDenied = sortPathsShortestFirst(deniedRawSet);

  if (platform === 'linux') {
    const effectiveArch = options?.arch
      ?? (platform === process.platform ? process.arch : (process.arch === 'arm64' ? 'arm64' : 'x64'));
    const bwrapBin = options?.linuxBwrapExecutable !== undefined
      ? options.linuxBwrapExecutable
      : (
        allowNet
          ? resolveLinuxBwrapForMountOnly()
          : resolveLinuxBwrapForNoNet()
      );
    if (bwrapBin !== null) {
      if (!TRUSTED_BWRAP_PATHS.includes(bwrapBin)) {
        throw new TaskpackError('SANDBOX_BACKEND_UNAVAILABLE', `untrusted Linux bwrap executable "${bwrapBin}"`);
      }
      let seccompBpf: Buffer | undefined;
      if (networkMode === 'none') {
        if (effectiveArch !== 'x64' && effectiveArch !== 'arm64') {
          throw new TaskpackError(
            'SANDBOX_BACKEND_UNAVAILABLE',
            `command.v1 Linux bwrap seccomp filter does not support architecture "${effectiveArch}"`,
          );
        }
        seccompBpf = compileLinuxSeccompBpfBinary(effectiveArch, { blockIpSockets: true });
      }
      const probeHost = platform === process.platform && options?.linuxBwrapExecutable === undefined;
      const bwrapNamespaceFlags: readonly string[] = allowNet
        ? ['--unshare-pid']
        : ['--unshare-pid', '--unshare-net'];
      const bwrapExecTail: readonly string[] = seccompBpf !== undefined
        ? ['--seccomp', '3', '--', shell, ...baseArgs]
        : ['--', shell, ...baseArgs];
      const enforcePositiveMounts = requireFs || hasExplicitWritablePaths;
      const reopenedAll = [
        ...canonicalAllowedRo,
        ...canonicalWritables,
        ...(gitBind !== null ? [gitBind.targetObjectsDir] : []),
      ];

      if (enforcePositiveMounts) {
        const bwrapArgs: string[] = [
          ...bwrapNamespaceFlags,
          '--die-with-parent',
          '--dev', '/dev',
          '--proc', '/proc',
          '--tmpfs', '/tmp',
          '--ro-bind', '/usr', '/usr',
        ];
        for (const sysLinkOrDir of LINUX_BWRAP_TOP_SYMLINK_DIRS) {
          if (probeHost) {
            const st = tryLstatSync(sysLinkOrDir);
            if (st !== null && st.isSymbolicLink()) {
              bwrapArgs.push('--symlink', readlinkSync(sysLinkOrDir), sysLinkOrDir);
            } else if (st !== null) {
              bwrapArgs.push('--ro-bind', sysLinkOrDir, sysLinkOrDir);
            }
          } else {
            bwrapArgs.push('--ro-bind-try', sysLinkOrDir, sysLinkOrDir);
          }
        }
        for (const etcOrSysPath of LINUX_BWRAP_ETC_SYS_READ_PATHS) {
          if (probeHost && !existsSync(etcOrSysPath)) continue;
          bwrapArgs.push('--ro-bind-try', etcOrSysPath, etcOrSysPath);
        }

        const writableSet = new Set(canonicalWritables);
        for (const roPath of canonicalAllowedRo) {
          if (writableSet.has(roPath) || roPath === '/usr') continue;
          if (probeHost && !existsSync(roPath)) continue;
          bwrapArgs.push('--ro-bind', roPath, roPath);
        }

        if (gitBind !== null) {
          bwrapArgs.push('--ro-bind', gitBind.sourceObjectsDir, gitBind.targetObjectsDir);
        }

        for (const wp of canonicalWritables) {
          if (probeHost && !existsSync(wp)) continue;
          bwrapArgs.push('--bind', wp, wp);
        }

        const mountedRoots = [
          '/usr',
          ...canonicalAllowedRo,
          ...canonicalWritables,
          ...(gitBind !== null ? [gitBind.targetObjectsDir] : []),
        ];
        const postMountDenied = sortPathsShortestFirst([...canonicalDenied, ...homeDeniedSet]).filter(
          dp => !explicitReopenSet.has(dp)
            && mountedRoots.some(mr => isStrictChildPath(dp, mr))
            && !reopenedAll.some(rp => isStrictChildPath(rp, dp)),
        );
        const postMaskedDirs: string[] = [];
        for (const deniedPath of postMountDenied) {
          if (postMaskedDirs.some(m => isStrictChildPath(deniedPath, m))) continue;
          const st = tryLstatSync(deniedPath);
          if (probeHost && st === null) continue;
          if (st !== null && !st.isDirectory()) {
            bwrapArgs.push('--ro-bind', '/dev/null', deniedPath);
          } else {
            postMaskedDirs.push(deniedPath);
            bwrapArgs.push('--tmpfs', deniedPath, '--remount-ro', deniedPath);
          }
        }

        if (canonicalCwd !== undefined) {
          bwrapArgs.push('--chdir', canonicalCwd);
        }
        bwrapArgs.push(...bwrapExecTail);
        return {
          command: bwrapBin,
          args: bwrapArgs,
          networkIsolated: !allowNet,
          filesystemIsolated: true,
          processIsolated: true,
          ...(seccompBpf !== undefined ? { seccompBpf } : {}),
        };
      }

      const bwrapArgs: string[] = [
        ...bwrapNamespaceFlags,
        '--die-with-parent',
        '--ro-bind', '/', '/',
        '--dev', '/dev',
        '--proc', '/proc',
      ];

      const preMountDenied = canonicalDenied.filter(
        dp => !reopenedAll.some(rp => isStrictChildPath(dp, rp)),
      );
      const postMountDeniedSet = new Set<string>(
        canonicalDenied.filter(dp => reopenedAll.some(rp => isStrictChildPath(dp, rp))),
      );
      for (const hd of homeDeniedSet) {
        if (reopenedAll.some(rp => isStrictChildPath(hd, rp))) {
          postMountDeniedSet.add(hd);
        }
      }

      const maskedDirs: string[] = [];
      const ancestorTmpfsDirs: string[] = [];
      for (const deniedPath of preMountDenied) {
        if (maskedDirs.some(m => isStrictChildPath(deniedPath, m))) {
          continue;
        }
        const st = tryLstatSync(deniedPath);
        if (probeHost && st === null) {
          continue;
        }
        if (st !== null && !st.isDirectory()) {
          bwrapArgs.push('--ro-bind', '/dev/null', deniedPath);
        } else {
          maskedDirs.push(deniedPath);
          const hasReopenedChild = reopenedAll.some(rp => isStrictChildPath(rp, deniedPath));
          if (hasReopenedChild) {
            bwrapArgs.push('--tmpfs', deniedPath);
            ancestorTmpfsDirs.push(deniedPath);
          } else {
            bwrapArgs.push('--tmpfs', deniedPath, '--remount-ro', deniedPath);
          }
        }
      }

      const writableSet = new Set(canonicalWritables);
      for (const roPath of canonicalAllowedRo) {
        if (writableSet.has(roPath)) continue;
        if (probeHost && !existsSync(roPath)) continue;
        bwrapArgs.push('--ro-bind', roPath, roPath);
      }

      if (gitBind !== null) {
        bwrapArgs.push('--ro-bind', gitBind.sourceObjectsDir, gitBind.targetObjectsDir);
      }

      for (const wp of canonicalWritables) {
        if (probeHost && !existsSync(wp)) continue;
        bwrapArgs.push('--bind', wp, wp);
      }

      for (const deniedPath of sortPathsShortestFirst(postMountDeniedSet)) {
        const st = tryLstatSync(deniedPath);
        if (probeHost && st === null) continue;
        if (st !== null && !st.isDirectory()) {
          bwrapArgs.push('--ro-bind', '/dev/null', deniedPath);
        } else {
          bwrapArgs.push('--tmpfs', deniedPath, '--remount-ro', deniedPath);
        }
      }

      for (const ancDir of [...ancestorTmpfsDirs].reverse()) {
        bwrapArgs.push('--remount-ro', ancDir);
      }

      if (canonicalCwd !== undefined) {
        bwrapArgs.push('--chdir', canonicalCwd);
      }

      bwrapArgs.push(...bwrapExecTail);
      return {
        command: bwrapBin,
        args: bwrapArgs,
        networkIsolated: !allowNet,
        filesystemIsolated: true,
        processIsolated: true,
        ...(seccompBpf !== undefined ? { seccompBpf } : {}),
      };
    }

    if (requireFs) {
      if (gitBind !== null) {
        throw new TaskpackError(
          'SANDBOX_BACKEND_UNAVAILABLE',
          'command.v1 readOnlyGitObjectsBind requires Linux bwrap mount namespaces',
        );
      }
      if (networkMode === 'loopback-only' && options?.allowDedicatedRunnerLoopbackFallback !== true) {
        throw new TaskpackError(
          'SANDBOX_BACKEND_UNAVAILABLE',
          'command.v1 networkMode "loopback-only" on Linux requires bwrap network namespaces',
        );
      }
      if (effectiveArch !== 'x64' && effectiveArch !== 'arm64') {
        throw new TaskpackError(
          'SANDBOX_BACKEND_UNAVAILABLE',
          `command.v1 Linux Landlock seccomp filter does not support architecture "${effectiveArch}"`,
        );
      }
      let pythonBin: string | null = null;
      let seccompAvailable = options?.linuxSeccompAvailable ?? true;
      if (options?.linuxPythonExecutable === null) {
        pythonBin = null;
      } else if (typeof options?.linuxPythonExecutable === 'string') {
        if (!TRUSTED_PYTHON_PATHS.includes(options.linuxPythonExecutable)) {
          throw new TaskpackError('SANDBOX_BACKEND_UNAVAILABLE', `untrusted Linux python3 executable "${options.linuxPythonExecutable}"`);
        }
        pythonBin = options.linuxPythonExecutable;
      } else {
        const probed = resolveLinuxLandlockPython();
        if (probed !== null) {
          pythonBin = probed.executable;
          seccompAvailable = options?.linuxSeccompAvailable ?? probed.seccompAvailable;
        }
      }
      if (pythonBin === null || !seccompAvailable) {
        throw new TaskpackError(
          'SANDBOX_BACKEND_UNAVAILABLE',
          'command.v1 Linux containment unavailable: neither bwrap nor Landlock (ABI >= 3 with seccomp) is available',
        );
      }
      const blockIpSockets = networkMode === 'none';
      const landlockRo = sortPathsShortestFirst([...canonicalAllowedRo, ...canonicalWritables]);
      const landlockDenied = sortPathsShortestFirst([...canonicalDenied, ...homeDeniedSet]).filter(
        dp => !explicitReopenSet.has(dp),
      );
      const landlockNetMode: SandboxNetworkMode = networkMode === 'loopback-only' ? 'allow-outbound' : networkMode;
      const landlockConfig = JSON.stringify({
        workspaceRoot: canonicalCwd ?? '/',
        positiveReadRoots: [...LINUX_COMMAND_POSITIVE_READ_ROOTS],
        writablePaths: [...canonicalWritables],
        exactWritableFiles: [],
        protectedPaths: [],
        deniedReadPaths: [...landlockDenied],
        allowedReadOnlyPaths: [...landlockRo],
        networkMode: landlockNetMode,
        ...(blockIpSockets ? { blockIpSockets: true } : {}),
        ...(canonicalCwd !== undefined ? { cwd: canonicalCwd } : {}),
      });
      return {
        command: pythonBin,
        args: ['-I', '-S', '-B', '-c', LANDLOCK_BOOTSTRAP_SCRIPT, landlockConfig, shell, ...baseArgs],
        networkIsolated: allowNet ? false : blockIpSockets,
        filesystemIsolated: true,
        processIsolated: false,
        spawnCwd: '/',
      };
    }

    if (!allowNet) {
      throw new TaskpackError(
        'SANDBOX_BACKEND_UNAVAILABLE',
        `command.v1 Linux network isolation ("${networkMode}") requires bwrap`,
      );
    }

    return {
      command: shell,
      args: baseArgs,
      networkIsolated: false,
      filesystemIsolated: false,
      processIsolated: false,
    };
  }

  if (platform === 'darwin') {
    const hasSeatbelt = options?.darwinSeatbeltAvailable ?? existsSync('/usr/bin/sandbox-exec');
    if (hasSeatbelt) {
      const effectiveReadablePaths = [...new Set([...canonicalAllowedRo, ...canonicalWritables])].sort();
      const sortedDenied = [...canonicalDenied].sort();
      const sortedWritables = [...canonicalWritables].sort();
      const enforceWriteContainment = requireFs || hasExplicitWritablePaths;
      const helperSockPath = options?.darwinSeatbeltHelperSocketPath !== undefined
        ? canonicalizeCommandContainmentPath(options.darwinSeatbeltHelperSocketPath, 'darwinSeatbeltHelperSocketPath')
        : undefined;

      if (enforceWriteContainment) {
        const ancestors = new Set<string>([
          '/',
          '/etc',
          '/var',
          '/tmp',
          '/private',
          '/private/tmp',
          '/private/var',
        ]);
        if (helperSockPath !== undefined) {
          ancestors.add(helperSockPath);
          let curSock = dirname(helperSockPath);
          while (curSock.length > 0 && curSock !== '/') {
            ancestors.add(curSock);
            const nextSock = dirname(curSock);
            if (nextSock === curSock) break;
            curSock = nextSock;
          }
        }
        const positiveGrants = [...new Set([...DARWIN_COMMAND_POSITIVE_READ_ROOTS, ...effectiveReadablePaths])].sort();
        for (const grantPath of positiveGrants) {
          let cur = dirname(grantPath);
          while (cur.length > 0 && cur !== '/') {
            ancestors.add(cur);
            const next = dirname(cur);
            if (next === cur) break;
            cur = next;
          }
        }

        const lines: string[] = [
          '(version 1)',
          '(allow default)',
          '(deny process-info*)',
          '(allow process-info* (target same-sandbox))',
          '(deny file-read*)',
          '(allow file-read-metadata',
        ];
        for (const anc of [...ancestors].sort()) {
          lines.push(`  (literal "${anc}")`);
        }
        lines.push(')');

        lines.push('(allow file-read*');
        lines.push('  (literal "/")');
        lines.push('  (literal "/etc")');
        lines.push('  (literal "/var")');
        lines.push('  (literal "/tmp")');
        for (const roPath of positiveGrants) {
          const roSt = tryLstatSync(roPath);
          if (roSt !== null && roSt.isFile()) {
            lines.push(`  (literal "${roPath}")`);
          } else {
            lines.push(`  (subpath "${roPath}")`);
          }
        }
        // Apple's /bin/bash and /bin/sh ignore $TMPDIR for <<EOF here-documents and use /private/tmp/sh-thd*.
        lines.push('  (regex #"^/private/tmp/sh-thd[^/]*$")');
        lines.push(')');

        const effectiveReadableSet = new Set(effectiveReadablePaths);
        const postRoDenied = [...new Set([...sortedDenied, ...homeDeniedSet])]
          .filter(dp => !effectiveReadableSet.has(dp) && positiveGrants.some(gr => isStrictChildPath(dp, gr)))
          .sort();
        if (postRoDenied.length > 0) {
          lines.push('(deny file-read*');
          for (const dp of postRoDenied) {
            lines.push(`  (subpath "${dp}")`);
          }
          lines.push(')');
          const nestedReopen = effectiveReadablePaths
            .filter(ro => postRoDenied.some(dp => isStrictChildPath(ro, dp)))
            .sort();
          if (nestedReopen.length > 0) {
            lines.push('(allow file-read*');
            for (const ro of nestedReopen) {
              const roSt = tryLstatSync(ro);
              if (roSt !== null && roSt.isFile()) {
                lines.push(`  (literal "${ro}")`);
              } else {
                lines.push(`  (subpath "${ro}")`);
              }
            }
            lines.push(')');
            const finalDeniedHome = [...homeDeniedSet]
              .filter(hd => nestedReopen.some(ro => isStrictChildPath(hd, ro)))
              .sort();
            if (finalDeniedHome.length > 0) {
              lines.push('(deny file-read*');
              for (const hd of finalDeniedHome) {
                lines.push(`  (subpath "${hd}")`);
              }
              lines.push(')');
            }
          }
        }

        lines.push('(deny file-write*)');
        lines.push('(allow file-write*');
        lines.push('  (literal "/dev/null")');
        lines.push('  (literal "/dev/zero")');
        lines.push('  (literal "/dev/dtracehelper")');
        lines.push('  (literal "/private/tmp")');
        lines.push('  (regex #"^/private/tmp/sh-thd[^/]*$")');
        for (const wp of sortedWritables) {
          lines.push(`  (subpath "${wp}")`);
        }
        lines.push(')');

        if (networkMode === 'none') {
          lines.push('(deny network*)');
        } else if (networkMode === 'loopback-only') {
          lines.push('(deny network*)');
          lines.push('(allow network-outbound (remote ip "localhost:*"))');
          lines.push('(allow network-inbound (local ip "localhost:*"))');
          lines.push('(allow network-bind (local ip "localhost:*"))');
        }
        if (helperSockPath !== undefined && networkMode !== 'allow-outbound') {
          lines.push(`(allow network-outbound (remote unix-socket (path-literal "${helperSockPath}")))`);
        }

        return {
          command: '/usr/bin/sandbox-exec',
          args: ['-p', lines.join('\n'), shell, ...baseArgs],
          networkIsolated: !allowNet,
          filesystemIsolated: true,
          processIsolated: true,
        };
      }

      const ancestors = new Set<string>();
      for (const reopenPath of effectiveReadablePaths) {
        let cur = dirname(reopenPath);
        while (cur.length > 0 && cur !== '/') {
          ancestors.add(cur);
          const next = dirname(cur);
          if (next === cur) break;
          cur = next;
        }
      }

      const lines: string[] = [
        '(version 1)',
        '(allow default)',
        '(deny process-info*)',
        '(allow process-info* (target same-sandbox))',
      ];
      if (sortedDenied.length > 0) {
        lines.push('(deny file-read*');
        for (const deniedPath of sortedDenied) {
          lines.push(`  (subpath "${deniedPath}")`);
        }
        lines.push(')');
      }
      if (ancestors.size > 0) {
        lines.push('(allow file-read-metadata');
        for (const anc of [...ancestors].sort()) {
          lines.push(`  (literal "${anc}")`);
        }
        lines.push(')');
      }
      if (effectiveReadablePaths.length > 0) {
        lines.push('(allow file-read*');
        for (const roPath of effectiveReadablePaths) {
          const roSt = tryLstatSync(roPath);
          if (roSt !== null && roSt.isFile()) {
            lines.push(`  (literal "${roPath}")`);
          } else {
            lines.push(`  (subpath "${roPath}")`);
          }
        }
        lines.push(')');
      }
      const postRoDeniedHome = [...homeDeniedSet]
        .filter(hd => effectiveReadablePaths.some(ro => isStrictChildPath(hd, ro)))
        .sort();
      if (postRoDeniedHome.length > 0) {
        lines.push('(deny file-read*');
        for (const hd of postRoDeniedHome) {
          lines.push(`  (subpath "${hd}")`);
        }
        lines.push(')');
      }
      if (networkMode === 'none') {
        lines.push('(deny network*)');
      } else if (networkMode === 'loopback-only') {
        lines.push('(deny network*)');
        lines.push('(allow network-outbound (remote ip "localhost:*"))');
        lines.push('(allow network-inbound (local ip "localhost:*"))');
        lines.push('(allow network-bind (local ip "localhost:*"))');
      }
      return {
        command: '/usr/bin/sandbox-exec',
        args: ['-p', lines.join('\n'), shell, ...baseArgs],
        networkIsolated: !allowNet,
        filesystemIsolated: false,
        processIsolated: true,
      };
    }
    if (requireFs) {
      throw new TaskpackError(
        'SANDBOX_BACKEND_UNAVAILABLE',
        'command.v1 macOS containment unavailable: /usr/bin/sandbox-exec is missing',
      );
    }
  }

  if (requireFs) {
    throw new TaskpackError(
      'SANDBOX_BACKEND_UNAVAILABLE',
      `command.v1 filesystem containment is unavailable on platform "${platform}"`,
    );
  }

  return {
    command: shell,
    args: baseArgs,
    networkIsolated: allowNet,
    filesystemIsolated: false,
    processIsolated: false,
  };
}

interface RunCommandScriptOptions {
  readonly args?: readonly string[] | undefined;
  readonly allowCheckNetwork?: boolean | undefined;
  readonly networkMode?: SandboxNetworkMode | undefined;
  readonly readOnlyGitObjectsBind?: ReadOnlyGitObjectsBind | null | undefined;
  readonly writablePaths: readonly string[];
  readonly deniedReadPaths: readonly string[];
  readonly allowedReadOnlyPaths: readonly string[];
  readonly allowDedicatedRunnerLoopbackFallback?: boolean | undefined;
  readonly darwinSeatbeltHelperSocketPath?: string | undefined;
  readonly signal?: AbortSignal | undefined;
  readonly registerKiller?: ((kill: () => void) => () => void) | undefined;
  readonly onLog?: ((line: string) => void) | undefined;
}

const BROAD_FORBIDDEN_TOOL_ROOTS: ReadonlySet<string> = new Set([
  '/',
  '/Users',
  '/home',
  '/tmp',
  '/private',
  '/private/tmp',
  '/var',
  '/private/var',
  '/var/folders',
  '/private/var/folders',
  '/opt',
]);

export function collectPositiveRuntimeToolReadRoots(options: {
  readonly childEnv: Readonly<Record<string, string>>;
  readonly gate: CompiledLocalCommandGate;
  readonly canonRepoRoot: string;
  readonly canonRunRoot: string;
  readonly canonScratchBase: string;
  readonly canonTmpDir: string;
  readonly homeDeniedSet: ReadonlySet<string>;
}): readonly string[] {
  const { childEnv, gate, canonRepoRoot, canonRunRoot, canonScratchBase, canonTmpDir, homeDeniedSet } = options;
  const rawHome = homedir();
  const canonHome = typeof rawHome === 'string' && rawHome.length > 0 && isAbsolute(rawHome) && !/[\0\r\n"\\]/.test(rawHome)
    ? canonicalizeCommandContainmentPath(rawHome, 'homedir')
    : null;
  const out = new Set<string>();

  const overlapsHomeDenied = (candidate: string): boolean => {
    for (const hd of homeDeniedSet) {
      if (isSameOrStrictChildPath(candidate, hd) || isSameOrStrictChildCaseInsensitive(candidate, hd)) {
        return true;
      }
    }
    return false;
  };

  const isSafeRuntimeToolDir = (realDir: string): boolean => {
    if (realDir.length === 0 || realDir.length > 1024 || /[\0\r\n"\\]/.test(realDir) || !isAbsolute(realDir)) {
      return false;
    }
    if (BROAD_FORBIDDEN_TOOL_ROOTS.has(realDir)) return false;
    if (canonHome !== null && isSameOrStrictChildPath(canonHome, realDir)) return false;
    if (isSameOrStrictChildPath(realDir, canonRepoRoot) || isSameOrStrictChildPath(canonRepoRoot, realDir)) return false;
    if (isSameOrStrictChildPath(realDir, canonRunRoot) || isSameOrStrictChildPath(canonRunRoot, realDir)) return false;
    if (isSameOrStrictChildPath(realDir, canonScratchBase) || isSameOrStrictChildPath(canonScratchBase, realDir)) return false;
    if (
      isSameOrStrictChildPath(realDir, canonTmpDir)
      || isSameOrStrictChildPath(canonTmpDir, realDir)
      || isSameOrStrictChildPath(realDir, '/tmp')
      || isSameOrStrictChildPath(realDir, '/private/tmp')
      || isSameOrStrictChildPath(realDir, '/var/folders')
      || isSameOrStrictChildPath(realDir, '/private/var/folders')
    ) {
      return false;
    }
    if (overlapsHomeDenied(realDir)) return false;
    const st = tryLstatSync(realDir);
    return st !== null && !st.isSymbolicLink() && st.isDirectory();
  };

  const addToolEntry = (rawCandidate: string, isDirectoryCandidate: boolean): void => {
    if (typeof rawCandidate !== 'string' || rawCandidate.length === 0 || !isAbsolute(rawCandidate)) return;
    let realTarget: string;
    try {
      realTarget = realpathSync(rawCandidate);
    } catch {
      return;
    }
    if (!isDirectoryCandidate && realTarget.includes('/node_modules/npm/')) {
      const npmPkgRoot = `${realTarget.split('/node_modules/npm/')[0]!}/node_modules/npm`;
      if (isSafeRuntimeToolDir(npmPkgRoot)) {
        out.add(npmPkgRoot);
      }
    }
    const binDir = isDirectoryCandidate ? realTarget : dirname(realTarget);
    if (isSafeRuntimeToolDir(binDir)) {
      out.add(binDir);
    }
    if (basename(binDir) === 'bin') {
      const parentDir = dirname(binDir);
      if (canonHome !== null && parentDir === join(canonHome, '.local')) {
        const dotLocalLib = join(parentDir, 'lib');
        if (isSafeRuntimeToolDir(dotLocalLib)) {
          out.add(dotLocalLib);
        }
      } else if (isSafeRuntimeToolDir(parentDir)) {
        out.add(parentDir);
      }
    }
  };

  addToolEntry(process.execPath, false);
  addToolEntry(dirname(process.execPath), true);

  const pathValue = childEnv['PATH'] ?? '';
  for (const rawDir of pathValue.split(':')) {
    const trimmed = rawDir.trim();
    if (trimmed.length === 0 || !isAbsolute(trimmed)) continue;
    addToolEntry(trimmed, true);
    for (const toolName of ['node', 'npm', 'python3', 'git']) {
      const candidateTool = join(trimmed, toolName);
      if (existsSync(candidateTool)) {
        addToolEntry(candidateTool, false);
      }
    }
  }

  if (gate.allowPrivileged === true) {
    const hugoBin = childEnv['HUGO_BIN']?.trim();
    if (hugoBin !== undefined && hugoBin.length > 0 && isAbsolute(hugoBin) && existsSync(hugoBin)) {
      try {
        const realHugo = realpathSync(hugoBin);
        const hugoSt = tryLstatSync(realHugo);
        let hugoExecutable = false;
        if (hugoSt !== null && !hugoSt.isSymbolicLink() && hugoSt.isFile() && (hugoSt.mode & 0o111) !== 0) {
          try {
            accessSync(realHugo, fsConstants.X_OK);
            hugoExecutable = true;
          } catch {
            hugoExecutable = false;
          }
        }
        if (
          hugoExecutable
          && hugoSt !== null
          && hugoSt.nlink === 1
          && realHugo !== '/'
          && realHugo.length <= 1024
          && !/[\0\r\n"\\]/.test(realHugo)
          && !overlapsHomeDenied(realHugo)
          && !isSameOrStrictChildPath(realHugo, canonRepoRoot)
          && !isSameOrStrictChildPath(realHugo, canonRunRoot)
          && !isSameOrStrictChildPath(realHugo, canonScratchBase)
        ) {
          out.add(realHugo);
        }
      } catch {
        // Ignore broken HUGO_BIN.
      }
    }

    if (childEnv['SELF_UPGRADE_ALLOW_TEST_FIXTURE'] === '1') {
      const testNm = childEnv['SELF_UPGRADE_TEST_NODE_MODULES']?.trim();
      if (testNm !== undefined && testNm.length > 0 && isAbsolute(testNm) && existsSync(testNm)) {
        try {
          const realTestNm = realpathSync(testNm);
          const nmSt = tryLstatSync(realTestNm);
          if (
            nmSt !== null
            && !nmSt.isSymbolicLink()
            && nmSt.isDirectory()
            && realTestNm !== '/'
            && !/[\0\r\n"\\]/.test(realTestNm)
            && (canonHome === null || realTestNm !== canonHome)
            && !overlapsHomeDenied(realTestNm)
          ) {
            out.add(realTestNm);
          }
        } catch {
          // Ignore broken test fixture path.
        }
      }
    }
  }

  return [...out];
}

function networkModeRank(mode: SandboxNetworkMode): number {
  if (mode === 'none') return 0;
  if (mode === 'loopback-only') return 1;
  return 2;
}

const MAX_MACOS_SB_HELPER_REQUEST_BYTES = 262_144;
const DEFAULT_MACOS_SB_HELPER_IDLE_TIMEOUT_MS = 5_000;
export const MAX_HELPER_CONNECTIONS = 4;
export const MAX_HELPER_ACTIVE_STAGES = 2;

export async function startMacosStageSeatbeltHelper(options: {
  readonly outerNetworkMode: SandboxNetworkMode;
  readonly outerWritablePaths: readonly string[];
  readonly outerAllowedReadOnlyPaths: readonly string[];
  readonly outerDeniedReadPaths: ReadonlySet<string>;
  readonly homeDeniedSet: ReadonlySet<string>;
  readonly forbiddenEnvNames?: ReadonlySet<string> | undefined;
  readonly idleHeaderTimeoutMs?: number | undefined;
  readonly signal: AbortSignal;
  readonly registerKiller: (kill: () => void) => () => void;
}): Promise<{ readonly socketPath: string; close(): Promise<void> }> {
  const sockDir = await mkdtemp(join('/private/tmp', 'lw-sb-'));
  await chmod(sockDir, 0o700);
  const realSockDir = await realpath(sockDir);
  const socketPath = join(realSockDir, 's');
  const outerPositiveReadRoots = [
    ...DARWIN_COMMAND_POSITIVE_READ_ROOTS,
    ...options.outerAllowedReadOnlyPaths,
  ];
  const idleHeaderTimeoutMs = options.idleHeaderTimeoutMs ?? DEFAULT_MACOS_SB_HELPER_IDLE_TIMEOUT_MS;
  const activeStagePromises = new Set<Promise<void>>();
  const activeHelperSockets = new Set<Socket>();
  let helperClosing = false;
  let activeStageCount = 0;
  const destroyActiveHelperSockets = (): void => {
    helperClosing = true;
    for (const sock of [...activeHelperSockets]) {
      sock.destroy();
    }
  };
  options.signal.addEventListener('abort', destroyActiveHelperSockets, { once: true });

  const helperServer = createNetServer(conn => {
    if (helperClosing || options.signal.aborted || activeHelperSockets.size >= MAX_HELPER_CONNECTIONS) {
      conn.destroy();
      return;
    }
    activeHelperSockets.add(conn);
    const stagePromise = new Promise<void>(resolveStage => {
      let buffer = '';
      let handled = false;
      let killChild: (() => void) | null = null;
      const headerTimer = setTimeout(() => {
        conn.destroy();
      }, idleHeaderTimeoutMs);
      headerTimer.unref?.();

      const sendJsonAndEnd = (payload: Record<string, unknown>): void => {
        clearTimeout(headerTimer);
        try {
          conn.end(`${JSON.stringify(payload)}\n`);
        } catch {
          conn.destroy();
        }
      };

      conn.on('close', () => {
        clearTimeout(headerTimer);
        activeHelperSockets.delete(conn);
        killChild?.();
        resolveStage();
      });
      conn.on('error', () => {
        clearTimeout(headerTimer);
        activeHelperSockets.delete(conn);
        killChild?.();
        resolveStage();
      });

      conn.on('data', (chunk: Buffer) => {
        if (handled) return;
        buffer += chunk.toString('utf8');
        if (Buffer.byteLength(buffer, 'utf8') > MAX_MACOS_SB_HELPER_REQUEST_BYTES) {
          handled = true;
          clearTimeout(headerTimer);
          sendJsonAndEnd({ ok: false, error: 'stage containment request exceeded size limit' });
          return;
        }
        const nl = buffer.indexOf('\n');
        if (nl === -1) return;
        handled = true;
        clearTimeout(headerTimer);
        const line = buffer.slice(0, nl);

        let parsed: unknown;
        try {
          parsed = JSON.parse(line);
        } catch {
          sendJsonAndEnd({ ok: false, error: 'invalid stage containment JSON' });
          return;
        }
        if (!isPlainRecord(parsed)) {
          sendJsonAndEnd({ ok: false, error: 'stage containment request must be an object' });
          return;
        }
        if (parsed['op'] === 'ping') {
          sendJsonAndEnd({ ok: true });
          return;
        }
        if (options.signal.aborted) {
          sendJsonAndEnd({ ok: false, error: 'command gate server aborted' });
          return;
        }

        try {
          const rawArgv = parsed['argv'];
          if (
            !Array.isArray(rawArgv)
            || rawArgv.length < 1
            || rawArgv.length > 256
            || rawArgv.some(a => typeof a !== 'string' || a.length > 8192 || a.includes('\0'))
            || (rawArgv[0] as string).length === 0
          ) {
            sendJsonAndEnd({ ok: false, error: 'invalid stage argv' });
            return;
          }
          const stageArgv = rawArgv as string[];

          if (typeof parsed['cwd'] !== 'string') {
            sendJsonAndEnd({ ok: false, error: 'invalid stage cwd' });
            return;
          }
          const stageCwd = canonicalizeCommandContainmentPath(parsed['cwd'], 'stage.cwd');
          if (!outerPositiveReadRoots.some(r => isSameOrStrictChildPath(stageCwd, r))) {
            sendJsonAndEnd({ ok: false, error: `stage cwd "${stageCwd}" is outside outer readable roots` });
            return;
          }

          const rawNetMode = parsed['networkMode'];
          if (rawNetMode !== 'none' && rawNetMode !== 'loopback-only') {
            sendJsonAndEnd({ ok: false, error: 'stage networkMode must be "none" or "loopback-only"' });
            return;
          }
          if (networkModeRank(rawNetMode) > networkModeRank(options.outerNetworkMode)) {
            sendJsonAndEnd({
              ok: false,
              error: `stage networkMode "${rawNetMode}" exceeds outer gate networkMode "${options.outerNetworkMode}"`,
            });
            return;
          }

          const rawWritables = parsed['writablePaths'];
          if (!Array.isArray(rawWritables) || rawWritables.length > 128 || rawWritables.some(p => typeof p !== 'string')) {
            sendJsonAndEnd({ ok: false, error: 'invalid stage writablePaths' });
            return;
          }
          const stageWritables: string[] = [];
          for (const [idx, wp] of (rawWritables as string[]).entries()) {
            const canonWp = canonicalizeCommandContainmentPath(wp, `stage.writablePaths/${idx}`);
            if (!options.outerWritablePaths.some(outerWp => isSameOrStrictChildPath(canonWp, outerWp))) {
              sendJsonAndEnd({ ok: false, error: `stage writablePath "${canonWp}" exceeds outer writablePaths` });
              return;
            }
            for (const hd of options.homeDeniedSet) {
              if (isSameOrStrictChildPath(canonWp, hd) || isSameOrStrictChildCaseInsensitive(canonWp, hd)) {
                sendJsonAndEnd({ ok: false, error: `stage writablePath "${canonWp}" overlaps denied home path` });
                return;
              }
            }
            stageWritables.push(canonWp);
          }

          const rawAllowedReads = parsed['allowedReadRoots'];
          if (!Array.isArray(rawAllowedReads) || rawAllowedReads.length < 1 || rawAllowedReads.length > 128 || rawAllowedReads.some(p => typeof p !== 'string')) {
            sendJsonAndEnd({ ok: false, error: 'invalid stage allowedReadRoots' });
            return;
          }
          const stageAllowedReads: string[] = [];
          for (const [idx, ar] of (rawAllowedReads as string[]).entries()) {
            const canonAr = canonicalizeCommandContainmentPath(ar, `stage.allowedReadRoots/${idx}`);
            if (!outerPositiveReadRoots.some(outerRo => isSameOrStrictChildPath(canonAr, outerRo))) {
              sendJsonAndEnd({ ok: false, error: `stage allowedReadRoot "${canonAr}" exceeds outer readable roots` });
              return;
            }
            for (const hd of options.homeDeniedSet) {
              if (isSameOrStrictChildPath(canonAr, hd) || isSameOrStrictChildCaseInsensitive(canonAr, hd)) {
                sendJsonAndEnd({ ok: false, error: `stage allowedReadRoot "${canonAr}" overlaps denied home path` });
                return;
              }
            }
            const allowedViaExplicitOuter = options.outerAllowedReadOnlyPaths.some(outerRo => isSameOrStrictChildPath(canonAr, outerRo));
            if (!allowedViaExplicitOuter) {
              for (const dp of options.outerDeniedReadPaths) {
                if (isSameOrStrictChildPath(canonAr, dp)) {
                  sendJsonAndEnd({ ok: false, error: `stage allowedReadRoot "${canonAr}" overlaps outer deniedReadPaths` });
                  return;
                }
              }
            }
            stageAllowedReads.push(canonAr);
          }

          const rawDeniedReads = parsed['deniedReadRoots'] ?? [];
          if (!Array.isArray(rawDeniedReads) || rawDeniedReads.length > 128 || rawDeniedReads.some(p => typeof p !== 'string')) {
            sendJsonAndEnd({ ok: false, error: 'invalid stage deniedReadRoots' });
            return;
          }
          const stageDeniedReads = (rawDeniedReads as string[])
            .map((dp, idx) => canonicalizeCommandContainmentPath(dp, `stage.deniedReadRoots/${idx}`))
            .filter(dp => dp !== '/');

          const rawRoMasks = parsed['readOnlyMasks'] ?? [];
          if (!Array.isArray(rawRoMasks) || rawRoMasks.length > 128 || rawRoMasks.some(p => typeof p !== 'string')) {
            sendJsonAndEnd({ ok: false, error: 'invalid stage readOnlyMasks' });
            return;
          }
          const stageRoMasks = [...new Set(
            (rawRoMasks as string[]).map((rmp, idx) => canonicalizeCommandContainmentPath(rmp, `stage.readOnlyMasks/${idx}`)),
          )].sort();

          const rawEnv = parsed['env'];
          if (!isPlainRecord(rawEnv) || Object.keys(rawEnv).length > 128) {
            sendJsonAndEnd({ ok: false, error: 'invalid stage env' });
            return;
          }
          const stageEnv: Record<string, string> = {
            PATH: '/usr/local/bin:/usr/bin:/bin',
            HOME: options.outerWritablePaths[1] ?? options.outerWritablePaths[0] ?? stageCwd,
            TMPDIR: options.outerWritablePaths[2] ?? options.outerWritablePaths[0] ?? stageCwd,
            LANG: 'C.UTF-8',
            LC_ALL: 'C.UTF-8',
          };
          for (const [k, v] of Object.entries(rawEnv)) {
            if (typeof v !== 'string' || k.includes('\0') || v.includes('\0') || v.length > 16_384) {
              sendJsonAndEnd({ ok: false, error: `invalid stage env entry "${k}"` });
              return;
            }
            if (k === 'GIT_CONFIG_NOSYSTEM' || k === 'GIT_CONFIG_GLOBAL' || k === 'GIT_TERMINAL_PROMPT') {
              continue;
            }
            if (k === 'HOME' || k === 'TMPDIR') {
              const canonDir = canonicalizeCommandContainmentPath(v, `stage.env.${k}`);
              if (!options.outerWritablePaths.some(outerWp => isSameOrStrictChildPath(canonDir, outerWp))) {
                sendJsonAndEnd({ ok: false, error: `stage env "${k}" must reside inside outer writablePaths` });
                return;
              }
              stageEnv[k] = canonDir;
              continue;
            }
            if (k === 'PATH' || k === 'LANG' || k === 'LC_ALL') {
              stageEnv[k] = v;
              continue;
            }
            if (
              k === 'RUNNER_ENVIRONMENT'
              || k === 'GITHUB_ACTIONS'
              || isForbiddenChildEnvName(k, options.forbiddenEnvNames)
              || isForbiddenPreflightEnvName(k, options.forbiddenEnvNames)
            ) {
              sendJsonAndEnd({ ok: false, error: `forbidden stage env variable "${k}"` });
              return;
            }
            stageEnv[k] = v;
          }
          stageEnv['GIT_CONFIG_NOSYSTEM'] = '1';
          stageEnv['GIT_CONFIG_GLOBAL'] = '/dev/null';
          stageEnv['GIT_TERMINAL_PROMPT'] = '0';

          const effectiveStageReads = [...new Set([...stageAllowedReads, ...stageWritables])].sort();
          const positiveGrants = [...new Set([...DARWIN_COMMAND_POSITIVE_READ_ROOTS, ...effectiveStageReads])].sort();
          const ancestors = new Set<string>(['/', '/etc', '/var', '/tmp', '/private', '/private/tmp', '/private/var']);
          for (const gp of positiveGrants) {
            let cur = dirname(gp);
            while (cur.length > 0 && cur !== '/') {
              ancestors.add(cur);
              const next = dirname(cur);
              if (next === cur) break;
              cur = next;
            }
          }

          const profileLines: string[] = [
            '(version 1)',
            '(allow default)',
            '(deny signal)',
            '(allow signal (target same-sandbox))',
            '(deny process-info*)',
            '(allow process-info* (target same-sandbox))',
            '(deny mach-priv-task-port)',
            '(deny sysctl-read',
            '  (sysctl-name "kern.procargs")',
            '  (sysctl-name-prefix "kern.procargs.")',
            '  (sysctl-name "kern.procargs2")',
            '  (sysctl-name-prefix "kern.procargs2.")',
            '  (sysctl-name "kern.proc")',
            '  (sysctl-name-prefix "kern.proc.")',
            ')',
            '(deny file-read*)',
            '(allow file-read-metadata',
          ];
          for (const anc of [...ancestors].sort()) {
            profileLines.push(`  (literal "${anc}")`);
          }
          profileLines.push(')');

          profileLines.push('(allow file-read*');
          profileLines.push('  (literal "/")');
          profileLines.push('  (literal "/etc")');
          profileLines.push('  (literal "/var")');
          profileLines.push('  (literal "/tmp")');
          for (const gp of positiveGrants) {
            const gpSt = tryLstatSync(gp);
            if (gpSt !== null && gpSt.isFile()) {
              profileLines.push(`  (literal "${gp}")`);
            } else {
              profileLines.push(`  (subpath "${gp}")`);
            }
          }
          profileLines.push('  (regex #"^/private/tmp/sh-thd[^/]*$")');
          profileLines.push(')');

          const effectiveStageReadSet = new Set(effectiveStageReads);
          const mergedDenied = [...new Set([
            ...options.outerDeniedReadPaths,
            ...options.homeDeniedSet,
            ...stageDeniedReads,
          ])]
            .filter(dp => !effectiveStageReadSet.has(dp) && positiveGrants.some(gp => isStrictChildPath(dp, gp)))
            .sort();
          if (mergedDenied.length > 0) {
            profileLines.push('(deny file-read*');
            for (const dp of mergedDenied) {
              profileLines.push(`  (subpath "${dp}")`);
            }
            profileLines.push(')');
            const nestedStageReopen = effectiveStageReads
              .filter(sr => mergedDenied.some(dp => isStrictChildPath(sr, dp)))
              .sort();
            if (nestedStageReopen.length > 0) {
              profileLines.push('(allow file-read*');
              for (const sr of nestedStageReopen) {
                const srSt = tryLstatSync(sr);
                if (srSt !== null && srSt.isFile()) {
                  profileLines.push(`  (literal "${sr}")`);
                } else {
                  profileLines.push(`  (subpath "${sr}")`);
                }
              }
              profileLines.push(')');
              const finalDeniedHome = [...options.homeDeniedSet]
                .filter(hd => nestedStageReopen.some(sr => isStrictChildPath(hd, sr)))
                .sort();
              if (finalDeniedHome.length > 0) {
                profileLines.push('(deny file-read*');
                for (const hd of finalDeniedHome) {
                  profileLines.push(`  (subpath "${hd}")`);
                }
                profileLines.push(')');
              }
            }
          }

          profileLines.push('(deny file-write*)');
          profileLines.push('(allow file-write*');
          profileLines.push('  (literal "/dev/null")');
          profileLines.push('  (literal "/dev/zero")');
          profileLines.push('  (literal "/dev/dtracehelper")');
          profileLines.push('  (literal "/private/tmp")');
          profileLines.push('  (regex #"^/private/tmp/sh-thd[^/]*$")');
          for (const wp of [...new Set(stageWritables)].sort()) {
            profileLines.push(`  (subpath "${wp}")`);
          }
          profileLines.push(')');

          if (stageRoMasks.length > 0) {
            profileLines.push('(deny file-write*');
            for (const rmp of stageRoMasks) {
              profileLines.push(`  (subpath "${rmp}")`);
            }
            profileLines.push(')');
          }

          if (rawNetMode === 'none') {
            profileLines.push('(deny network*)');
          } else {
            profileLines.push('(deny network*)');
            profileLines.push('(allow network-outbound (remote ip "localhost:*"))');
            profileLines.push('(allow network-inbound (local ip "localhost:*"))');
            profileLines.push('(allow network-bind (local ip "localhost:*"))');
          }

          if (activeStageCount >= MAX_HELPER_ACTIVE_STAGES) {
            sendJsonAndEnd({
              ok: false,
              error: `concurrent stage limit (${MAX_HELPER_ACTIVE_STAGES}) exceeded`,
            });
            return;
          }
          activeStageCount += 1;
          let stageReleased = false;
          const releaseActiveStage = (): void => {
            if (stageReleased) return;
            stageReleased = true;
            activeStageCount = Math.max(0, activeStageCount - 1);
          };

          let stageChild;
          try {
            stageChild = spawn('/usr/bin/sandbox-exec', ['-p', `${profileLines.join('\n')}\n`, '--', ...stageArgv], {
              cwd: stageCwd,
              env: stageEnv,
              detached: true,
              stdio: ['ignore', 'pipe', 'pipe'],
            });
          } catch (spawnErr) {
            releaseActiveStage();
            throw spawnErr;
          }

          const doKillStage = (): void => {
            if (stageChild.pid !== undefined) {
              try {
                process.kill(-stageChild.pid, 'SIGKILL');
              } catch {
                // Already exited.
              }
            }
          };
          const doForceAbortStage = (): void => {
            doKillStage();
            stageChild.stdout.destroy();
            stageChild.stderr.destroy();
          };
          killChild = doForceAbortStage;
          const unregister = options.registerKiller(doForceAbortStage);
          const onAbort = (): void => doForceAbortStage();
          options.signal.addEventListener('abort', onAbort, { once: true });
          if (options.signal.aborted) doForceAbortStage();

          let drainPending = false;
          const writeBoundedFrame = (stream: 'stdout' | 'stderr', chunk: Buffer): void => {
            if (conn.destroyed || !conn.writable) return;
            const canContinue = conn.write(`${JSON.stringify({ stream, data: chunk.toString('base64') })}\n`);
            if (!canContinue && !drainPending) {
              drainPending = true;
              stageChild.stdout.pause();
              stageChild.stderr.pause();
              conn.once('drain', () => {
                drainPending = false;
                if (!conn.destroyed) {
                  stageChild.stdout.resume();
                  stageChild.stderr.resume();
                }
              });
            }
          };

          stageChild.stdout.on('data', (outChunk: Buffer) => {
            writeBoundedFrame('stdout', outChunk);
          });
          stageChild.stderr.on('data', (errChunk: Buffer) => {
            writeBoundedFrame('stderr', errChunk);
          });
          stageChild.on('error', err => {
            releaseActiveStage();
            options.signal.removeEventListener('abort', onAbort);
            unregister();
            killChild = null;
            sendJsonAndEnd({ ok: false, error: `sandbox-exec spawn failed: ${err.message}` });
          });
          stageChild.on('close', code => {
            doKillStage();
            releaseActiveStage();
            options.signal.removeEventListener('abort', onAbort);
            unregister();
            killChild = null;
            sendJsonAndEnd({ ok: true, done: true, exitCode: code ?? 1 });
          });
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          sendJsonAndEnd({ ok: false, error: msg });
        }
      });
    });
    activeStagePromises.add(stagePromise);
    void stagePromise.finally(() => activeStagePromises.delete(stagePromise));
  });

  await new Promise<void>((resolveListen, rejectListen) => {
    helperServer.once('error', rejectListen);
    helperServer.listen(socketPath, () => resolveListen());
  });
  await chmod(socketPath, 0o600);

  return {
    socketPath,
    close: async () => {
      helperClosing = true;
      options.signal.removeEventListener('abort', destroyActiveHelperSockets);
      const serverClosePromise = new Promise<void>(resolveClose => helperServer.close(() => resolveClose()));
      destroyActiveHelperSockets();
      await Promise.allSettled([...activeStagePromises]);
      await serverClosePromise;
      await rm(realSockDir, { recursive: true, force: true }).catch(() => undefined);
    },
  };
}

async function runCommandScript(
  scriptFullPath: string,
  cwd: string,
  env: Record<string, string>,
  timeoutMs: number,
  options: RunCommandScriptOptions,
): Promise<{ readonly exitCode: number | null; readonly timedOut: boolean; readonly output: string }> {
  if (options.signal?.aborted) {
    return {
      exitCode: null,
      timedOut: false,
      output: 'command aborted during server shutdown',
    };
  }
  const effectiveNetworkMode: SandboxNetworkMode = options.networkMode
    ?? (options.allowCheckNetwork === true ? 'allow-outbound' : 'none');
  const invocation = buildCommandScriptInvocation(scriptFullPath, {
    args: options.args,
    allowCheckNetwork: effectiveNetworkMode === 'allow-outbound',
    networkMode: effectiveNetworkMode,
    readOnlyGitObjectsBind: options.readOnlyGitObjectsBind,
    writablePaths: options.writablePaths,
    deniedReadPaths: options.deniedReadPaths,
    allowedReadOnlyPaths: options.allowedReadOnlyPaths,
    allowDedicatedRunnerLoopbackFallback: options.allowDedicatedRunnerLoopbackFallback,
    darwinSeatbeltHelperSocketPath: options.darwinSeatbeltHelperSocketPath,
    cwd,
    env,
    requireFilesystemContainment: true,
  });
  const dedicatedLoopbackPermitted = effectiveNetworkMode === 'loopback-only'
    && options.allowDedicatedRunnerLoopbackFallback === true
    && invocation.filesystemIsolated;
  if (effectiveNetworkMode !== 'allow-outbound' && !invocation.networkIsolated && !dedicatedLoopbackPermitted) {
    throw new TaskpackError(
      'SANDBOX_BACKEND_UNAVAILABLE',
      `command.v1 network isolation ("${effectiveNetworkMode}") is unavailable on ${process.platform}`,
    );
  }
  return await new Promise((resolvePromise, reject) => {
    const hasSeccomp = invocation.seccompBpf !== undefined;
    const child = spawn(invocation.command, [...invocation.args], {
      cwd: invocation.spawnCwd ?? cwd,
      env,
      detached: true,
      stdio: hasSeccomp ? ['ignore', 'pipe', 'pipe', 'pipe'] : ['ignore', 'pipe', 'pipe'],
    });
    if (invocation.seccompBpf !== undefined) {
      const seccompStream = child.stdio[3] as Writable | null | undefined;
      if (seccompStream !== null && seccompStream !== undefined) {
        seccompStream.on('error', () => undefined);
        seccompStream.end(invocation.seccompBpf);
      }
    }

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

    child.stdout?.on('data', (chunk: Buffer) => stdoutBuffer.append(chunk));
    child.stderr?.on('data', (chunk: Buffer) => stderrBuffer.append(chunk));
    child.on('error', err => {
      cleanup();
      if (!settled) {
        settled = true;
        reject(new TaskpackError('ACTION_INPUT_INVALID', `command.v1 script failed to spawn: ${err.message}`));
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
  readonly disableReflink?: boolean | undefined;
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

export async function validateGateToolchainPath(
  tp: string,
  gate: CompiledLocalCommandGate,
  repositoryRoot: string,
  realTmpRoot: string,
): Promise<{ readonly kind: 'absolute'; readonly realPath: string } | { readonly kind: 'relative'; readonly fullPath: string }> {
  if (tp.startsWith('/')) {
    const tpStat = await lstat(tp).catch(() => null);
    if (tpStat === null || tpStat.isSymbolicLink() || !tpStat.isDirectory()) {
      throw new TaskpackError('ACTION_INPUT_INVALID', `toolchainPath "${tp}" must be an existing non-symlink directory`);
    }
    const realTp = await realpath(tp);
    if (gate.allowPrivileged !== true) {
      if (
        insideRoot(realTp, realTmpRoot)
        || insideRoot(realTp, '/tmp')
        || insideRoot(realTp, '/private/tmp')
      ) {
        throw new TaskpackError(
          'ACTION_INPUT_INVALID',
          `absolute toolchainPath "${tp}" under tmpdir is forbidden without allowPrivileged`,
        );
      }
      if ((tpStat.mode & 0o022) !== 0) {
        const defaultPathHint = DEFAULT_COMMAND_PATH_ENTRIES.has(tp)
          ? ' (default command.v1 PATH already includes /usr/local/bin:/usr/bin:/bin)'
          : '';
        throw new TaskpackError(
          'ACTION_INPUT_INVALID',
          `absolute toolchainPath "${tp}" must not be group- or world-writable without allowPrivileged${defaultPathHint}`,
        );
      }
      const currentUid = typeof process.getuid === 'function' ? process.getuid() : undefined;
      if (currentUid !== undefined && tpStat.uid !== 0 && tpStat.uid !== currentUid) {
        throw new TaskpackError(
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
    throw new TaskpackError('ACTION_INPUT_INVALID', `toolchainPath "${tp}" must be an existing non-symlink directory`);
  }
  return { kind: 'relative', fullPath: fullTp };
}

/**
 * Start a loopback HTTP server implementing Loopwright's `gate.v1` protocol for
 * repository-declared `command.v1` checks against inspected CAS/inline candidate snapshots.
 */
export async function startLocalCommandGateServer(
  options: LocalCommandGateServerOptions,
): Promise<LocalCommandGateServer> {
  const scrubber = options.scrubber ?? new SecretScrubber();
  const signingSecret = options.signingSecret ?? randomBytes(32).toString('hex');
  scrubber.register(signingSecret);
  if (options.readOnlyGitHubToken) scrubber.register(options.readOnlyGitHubToken);

  const startupTmpRoot = await realpath(tmpdir()).catch(() => resolve(tmpdir()));
  for (const gate of options.gates) {
    for (const tp of gate.toolchainPaths ?? []) {
      await validateGateToolchainPath(tp, gate, options.repositoryRoot, startupTmpRoot);
    }
  }

  const ownedScratch = options.scratchRoot === undefined;
  const rawScratchBase = options.scratchRoot ?? await mkdtemp(join(tmpdir(), 'loopwright-gate-'));
  await chmod(rawScratchBase, 0o700);
  const scratchBase = await realpath(rawScratchBase);
  const disableReflink = options.disableReflink === true;

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
        let macosSbHelper: { readonly socketPath: string; close(): Promise<void> } | null = null;
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
                throw new TaskpackError(
                  'TASKPACK_SCOPE_VIOLATION',
                  `candidate overlay file "${file.name}" is outside writable scope`,
                );
              }
            }
            for (const rawDeleted of deletedPaths) {
              const deletedName = normalizeCandidateRelativePath(rawDeleted);
              if (!isAllowedCandidateWrite(deletedName, snapshot)) {
                throw new TaskpackError(
                  'TASKPACK_SCOPE_VIOLATION',
                  `candidate deleted path "${deletedName}" is outside writable scope`,
                );
              }
            }
          }

          if (snapshot.sourceRevision !== snapshot.baseRevision) {
            if (!COMMIT_SHA_PATTERN.test(snapshot.baseRevision) || !COMMIT_SHA_PATTERN.test(snapshot.sourceRevision)) {
              throw new TaskpackError('ACTION_INPUT_INVALID', 'baseRevision and sourceRevision must be 40-hex commit SHAs');
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
                throw new TaskpackError(
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
                throw new TaskpackError(
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
            await materializeOverlayCandidateFiles(candidateDir, overlayFilesToMaterialize, baselineModes, disableReflink);
            await assertDeletedPathsAbsent(candidateDir, effectiveDeletedPaths, overlayNames);
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
            await materializeOverlayCandidateFiles(candidateDir, snapshot.files, baselineModes, disableReflink);
            await assertDeletedPathsAbsent(candidateDir, deletedPaths, overlayNames);
          } else {
            await materializeCandidateFiles(candidateDir, snapshot.files, disableReflink);
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

          let readOnlyGitObjectsBind: ReadOnlyGitObjectsBind | null = null;
          if (gate.mountReadOnlyGit === true) {
            const srcGitDir = join(options.repositoryRoot, '.git');
            const gitStat = await lstat(srcGitDir).catch(() => null);
            if (gitStat !== null) {
              if (gitStat.isSymbolicLink() || !gitStat.isDirectory()) {
                throw new TaskpackError('ACTION_INPUT_INVALID', 'repository .git must be a non-symlink directory for mountReadOnlyGit');
              }
              const gateNetworkMode: SandboxNetworkMode = gate.networkMode
                ?? (gate.allowCheckNetwork === true ? 'allow-outbound' : 'none');
              const bwrapAvailable = process.platform === 'linux' && (
                gateNetworkMode === 'allow-outbound'
                  ? resolveLinuxBwrapForMountOnly() !== null
                  : resolveLinuxBwrapForNoNet() !== null
              );
              readOnlyGitObjectsBind = await stageReadOnlyGitForCommandCheck(
                srcGitDir,
                join(candidateDir, '.git'),
                {
                  useMountNamespaceBind: bwrapAvailable,
                  disableReflink,
                },
              );
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
              await copyDirectoryTreeReadOnly(validated.fullPath, destTp, { disableReflink });
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

          const canonCandidateDir = canonicalizeCommandContainmentPath(candidateDir, 'candidateDir');
          const canonRepoRoot = canonicalizeCommandContainmentPath(options.repositoryRoot, 'repositoryRoot');
          const canonRunRoot = canonicalizeCommandContainmentPath(options.runRoot, 'runRoot');
          const canonScratchBase = canonicalizeCommandContainmentPath(scratchBase, 'scratchBase');
          const canonTmpDir = canonicalizeCommandContainmentPath(tmpdir(), 'tmpdir');
          const homeDeniedSet = collectDefaultDeniedHomePaths();
          const writablePaths = [
            canonicalizeCommandContainmentPath(outDir, 'outDir'),
            canonicalizeCommandContainmentPath(scratchHome, 'scratchHome'),
            canonicalizeCommandContainmentPath(scratchTmp, 'scratchTmp'),
          ];
          const hasCheckStaged = typeof options.checkStagedDir === 'string' && options.checkStagedDir.length > 0;
          const canonCheckStagedDir = hasCheckStaged
            ? canonicalizeCommandContainmentPath(options.checkStagedDir!, 'checkStagedDir')
            : null;
          const runtimeToolReadRoots = collectPositiveRuntimeToolReadRoots({
            childEnv,
            gate,
            canonRepoRoot,
            canonRunRoot,
            canonScratchBase,
            canonTmpDir,
            homeDeniedSet,
          });
          const allowedReadOnlyPaths = [
            ...new Set([
              canonCandidateDir,
              canonicalizeCommandContainmentPath(baseDir, 'baseDir'),
              canonicalizeCommandContainmentPath(checkDir, 'checkDir'),
              ...(canonCheckStagedDir !== null ? [canonCheckStagedDir] : []),
              ...resolvedToolchainPaths.map((tp, idx) => canonicalizeCommandContainmentPath(tp, `toolchainPaths/${idx}`)),
              ...runtimeToolReadRoots,
              ...writablePaths,
            ]),
          ];
          const deniedReadPathSet = new Set<string>([
            canonRepoRoot,
            canonRunRoot,
            canonScratchBase,
            canonTmpDir,
            canonicalizeCommandContainmentPath('/tmp', '/tmp'),
            canonicalizeCommandContainmentPath('/private/tmp', '/private/tmp'),
            canonicalizeCommandContainmentPath('/var/folders', '/var/folders'),
            canonicalizeCommandContainmentPath('/private/var/folders', '/private/var/folders'),
            ...homeDeniedSet,
          ]);
          if (canonCheckStagedDir !== null) {
            deniedReadPathSet.add(canonicalizeCommandContainmentPath(dirname(canonCheckStagedDir), 'checkStagedParent'));
            deniedReadPathSet.add(canonicalizeCommandContainmentPath(dirname(resolve(options.checkStagedDir!)), 'checkStagedRawParent'));
          }
          deniedReadPathSet.delete('/');
          deniedReadPathSet.delete(canonCandidateDir);

          const effectiveGateNetworkMode: SandboxNetworkMode = gate.networkMode
            ?? (gate.allowCheckNetwork === true ? 'allow-outbound' : 'none');
          const registerKiller = (kill: () => void): (() => void) => {
            activeKillers.add(kill);
            return () => {
              activeKillers.delete(kill);
            };
          };
          if (process.platform === 'darwin' && gate.allowPrivileged === true && existsSync('/usr/bin/sandbox-exec')) {
            macosSbHelper = await startMacosStageSeatbeltHelper({
              outerNetworkMode: effectiveGateNetworkMode,
              outerWritablePaths: writablePaths,
              outerAllowedReadOnlyPaths: allowedReadOnlyPaths,
              outerDeniedReadPaths: deniedReadPathSet,
              homeDeniedSet,
              forbiddenEnvNames: options.forbiddenEnvNames,
              signal: closeController.signal,
              registerKiller,
            });
            childEnv['LOOPWRIGHT_MACOS_SB_SOCK'] = macosSbHelper.socketPath;
          }

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
              allowCheckNetwork: effectiveGateNetworkMode === 'allow-outbound',
              networkMode: effectiveGateNetworkMode,
              readOnlyGitObjectsBind,
              writablePaths,
              deniedReadPaths: [...deniedReadPathSet],
              allowedReadOnlyPaths,
              allowDedicatedRunnerLoopbackFallback:
                options.runtimeEnv?.['GITHUB_ACTIONS'] === 'true'
                && options.runtimeEnv?.['RUNNER_ENVIRONMENT'] === 'github-hosted',
              darwinSeatbeltHelperSocketPath: macosSbHelper?.socketPath,
              signal: closeController.signal,
              onLog: options.onLog === undefined ? undefined : line => options.onLog?.(scrubber.scrub(line)),
              registerKiller,
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
          if (macosSbHelper !== null) {
            await macosSbHelper.close().catch(() => undefined);
          }
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
    throw new TaskpackError('ACTION_INPUT_INVALID', 'local command gate server failed to bind TCP port');
  }

  const boundLoopbackHost = host === '127.0.0.1'
    ? '127.0.0.1'
    : (address.address.includes(':') ? `[${address.address}]` : address.address);
  const url = `http://${boundLoopbackHost}:${address.port}/${LOCAL_COMMAND_GATE_ENDPOINT_ID}`;
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
    throw new TaskpackError('ACTION_INPUT_INVALID', 'git ls-tree output exceeded boundary');
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
        throw new TaskpackError(
          'ACTION_INPUT_INVALID',
          `failed to read carried baseline blob size for "${cleanCarryPath}" (${update.oid})`,
        );
      }
      byteLength = Number(sizeRaw);
    }
    if (!Number.isSafeInteger(byteLength) || byteLength < 0) {
      throw new TaskpackError(
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

export interface TurnkeyCycleDelegateOptions {
  readonly runId: string;
  readonly repositoryRoot: string;
  readonly runtimeEnv?: NodeJS.ProcessEnv | undefined;
  readonly ephemeralEnv?: Readonly<Record<string, string>> | undefined;
  readonly scrubber?: SecretScrubber | undefined;
  readonly mcpRegistry?: HostMcpRegistry | undefined;
  readonly mcpServers?: readonly StepMcpServerMetadata[] | undefined;
  readonly decisions?: AdvisoryDecisionPort | undefined;
  readonly policyProfile?: PolicyProfile | undefined;
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

export interface ExecuteTurnkeyCycleOptions extends TurnkeyCycleDelegateOptions {
  readonly taskpack: WrittenCompiledTaskpack;
  readonly attemptSeq: number;
  readonly publisherFactory?: (() => Promise<{
    readonly endpointPlan: HostPublicationEndpointPlan;
    readonly signingSecret: string;
    readonly authToken?: string | undefined;
    readonly signingEnvName?: string | undefined;
    readonly authEnvName?: string | undefined;
    close(): Promise<void>;
  }>) | undefined;
  readonly memoryFinalizer?: ((ctx: {
    readonly runRoot: string;
    readonly runId: string;
    readonly summary: TurnkeyCycleAttemptSummary;
  }) => Promise<TurnkeyMemorySummary>) | undefined;
}

export type ExecuteTurnkeyActionCycleOptions = ExecuteTurnkeyCycleOptions;

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
export async function executeTurnkeyCycle(
  options: ExecuteTurnkeyCycleOptions,
): Promise<TurnkeyCycleAttemptSummary & { readonly outcome: ActionDelegateOutcome; readonly memory?: TurnkeyMemorySummary | undefined }> {
  const startedMs = performance.now();
  const scrubber = options.scrubber ?? new SecretScrubber();
  const attemptRunId = makeAttemptRunId(options.runId, options.attemptSeq);
  const envOverrides: Record<string, string | undefined> = {};

  let publisherHandle: Awaited<ReturnType<NonNullable<ExecuteTurnkeyCycleOptions['publisherFactory']>>> | undefined;
  try {
    if (options.publisherFactory !== undefined) {
      publisherHandle = await options.publisherFactory();
      const signEnv = publisherHandle.signingEnvName ?? 'LOOPWRIGHT_PUBLICATION_SIGNING_SECRET';
      envOverrides[signEnv] = publisherHandle.signingSecret;
      scrubber.register(publisherHandle.signingSecret);
      if (publisherHandle.authToken !== undefined) {
        const authEnv = publisherHandle.authEnvName ?? 'LOOPWRIGHT_PUBLICATION_AUTH_TOKEN';
        envOverrides[authEnv] = publisherHandle.authToken;
        scrubber.register(publisherHandle.authToken);
      }
    }

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

    const effectivePolicyProfile = options.policyProfile ?? options.taskpack.policyProfile;
    const effectiveAllowWorkflowWrites = options.allowWorkflowWrites ?? options.taskpack.allowWorkflowWrites;
    const ports: ControllerPorts = {
      ...(effectivePolicyProfile !== undefined ? { policyProfile: effectivePolicyProfile } : {}),
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
            throw new TaskpackError('ACTION_INPUT_INVALID', 'missing provider credential for active candidate');
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
    let inspectedStatus = cycleOutcome.ok
      ? 'completed'
      : (cycleOutcome.code === 'CANCELLED' ? 'cancelled' : 'failed');
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

    if (cycleOutcome.code !== 'OWNER_BUSY') {
      try {
        const inspected = await inspectRun({ runRoot, runId: attemptRunId, output: tempInspectDir });
        if (inspected.ok) {
          const candidateStatus = inspected.value.status.status;
          if (
            candidateStatus !== null
            && (cycleOutcome.ok || (candidateStatus !== 'completed' && candidateStatus !== 'no_change'))
          ) {
            inspectedStatus = candidateStatus;
          }
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
    } else {
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

    let memory: TurnkeyMemorySummary | undefined;
    if (options.memoryFinalizer !== undefined) {
      memory = await options.memoryFinalizer({ runRoot, runId: attemptRunId, summary });
    }

    return {
      ...summary,
      ...(memory !== undefined ? { memory } : {}),
      outcome: {
        ok: summary.ok,
        detail: summary.detail,
        retryableProviderFailure: summary.retryableProviderFailure,
      },
    };
  } finally {
    if (publisherHandle !== undefined) {
      await publisherHandle.close().catch(() => undefined);
    }
  }
}

export { executeTurnkeyCycle as executeTurnkeyActionCycle };

/**
 * Create a delegate function executing isolated per-attempt Controller cycles (`runId`, `runId-a1`, ...).
 */
export function createTurnkeyCycleDelegate(
  options: TurnkeyCycleDelegateOptions,
): (taskpack: WrittenCompiledTaskpack) => Promise<ActionDelegateOutcome> {
  let nextAttemptSeq = 0;
  return async (taskpack: WrittenCompiledTaskpack): Promise<ActionDelegateOutcome> => {
    const attemptSeq = nextAttemptSeq++;
    const result = await executeTurnkeyCycle({
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
  readonly hostPolicy?: ExecutionHostPolicy | undefined;
  readonly policyProfile?: PolicyProfile | undefined;
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
  readonly policyProfile?: PolicyProfile | undefined;
  readonly allowWorkflowWrites?: boolean | undefined;
  readonly roleMcpServers?: Readonly<Record<string, readonly string[]>> | undefined;
  readonly mcpServers?: readonly StepMcpServerMetadata[] | undefined;
  readonly checkStagedDir?: string | null | undefined;
  readonly workspaceStagedDir?: string | null | undefined;
  readonly digests?: Readonly<Record<string, string>> | undefined;
}

export interface OpenStagedTaskpackStepGateOptions {
  readonly runRoot: string;
  readonly runId: string;
  readonly runtimeEnv?: NodeJS.ProcessEnv | undefined;
  readonly decisionTransport?: DecisionTransport | undefined;
  readonly decisionApiKey?: string | undefined;
}

export interface StagedTaskpackStepGateHandle {
  readonly staged: StagedTaskpackForStep;
  readonly environment: (name: string) => string | undefined;
  readonly gateUrlOverrides: Readonly<Record<string, string>>;
  readonly policyProfile?: PolicyProfile | undefined;
  readonly allowWorkflowWrites?: boolean | undefined;
  readonly roleMcpServers?: Readonly<Record<string, readonly string[]>> | undefined;
  readonly mcpServers?: readonly StepMcpServerMetadata[] | undefined;
  readonly decisions?: AdvisoryDecisionPort | undefined;
  readonly ports?: Pick<ControllerPorts, 'gateUrlOverrides' | 'policyProfile' | 'allowWorkflowWrites' | 'roleMcpServers' | 'mcpServers' | 'decisions'> | undefined;
  readonly serverUrl?: string | undefined;
  close(): Promise<void>;
}

const MAX_STAGED_SECRETS_BYTES = 65_536;
const STAGED_COMMAND_ENV_NAME_PATTERN = /^[A-Z][A-Z0-9_]{0,63}$/;
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
  'policyProfile',
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
  'networkMode',
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
    throw new TaskpackError('ACTION_INPUT_INVALID', `staged taskpack directory "${dirPath}" could not be inspected`);
  }
  const expectedUid = process.getuid?.();
  if (
    st.isSymbolicLink()
    || !st.isDirectory()
    || (expectedUid !== undefined && st.uid !== expectedUid)
    || (st.mode & 0o777) !== 0o700
  ) {
    throw new TaskpackError(
      'ACTION_INPUT_INVALID',
      `staged taskpack directory "${dirPath}" must be an owner-only (0o700) non-symlink directory`,
    );
  }
}

async function writeExclusiveFile(path: string, bytes: Buffer, mode: number): Promise<void> {
  const noFollow = 'O_NOFOLLOW' in fsConstants ? fsConstants.O_NOFOLLOW : 0;
  let handle;
  try {
    handle = await open(
      path,
      fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY | noFollow,
      mode,
    );
  } catch {
    throw new TaskpackError('ACTION_INPUT_INVALID', `staged taskpack file "${path}" could not be created exclusively`);
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
    throw new TaskpackError('ACTION_INPUT_INVALID', `staged taskpack secrets.json at "${secretsPath}" is missing or unreadable`);
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
    throw new TaskpackError('ACTION_INPUT_INVALID', `staged taskpack secrets.json at "${secretsPath}" must be a regular 0o600 file with nlink === 1`);
  }
  const noFollow = 'O_NOFOLLOW' in fsConstants ? fsConstants.O_NOFOLLOW : 0;
  let handle;
  try {
    handle = await open(secretsPath, fsConstants.O_RDONLY | noFollow);
  } catch {
    throw new TaskpackError('ACTION_INPUT_INVALID', `staged taskpack secrets.json at "${secretsPath}" could not be opened safely`);
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
      throw new TaskpackError('ACTION_INPUT_INVALID', `staged taskpack secrets.json at "${secretsPath}" failed ownership, mode, or link verification`);
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
      throw new TaskpackError('ACTION_INPUT_INVALID', `staged taskpack secrets.json at "${secretsPath}" changed during read`);
    }
    rawText = buf.subarray(0, readBytes).toString('utf8');
  } finally {
    await handle.close();
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(rawText);
  } catch {
    throw new TaskpackError('ACTION_INPUT_INVALID', 'staged taskpack secrets.json is not valid JSON');
  }
  if (!isPlainRecord(parsed) || parsed['version'] !== 1) {
    throw new TaskpackError('ACTION_INPUT_INVALID', 'staged taskpack secrets.json has unsupported schema');
  }
  for (const key of Object.keys(parsed)) {
    if (STAGED_FORBIDDEN_KEYS.has(key) || !STAGED_SECRETS_KEYS.has(key)) {
      throw new TaskpackError('ACTION_INPUT_INVALID', `staged taskpack secrets.json contains invalid key "${key}"`);
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
    throw new TaskpackError('ACTION_INPUT_INVALID', 'staged taskpack secrets.json fields are invalid');
  }

  const rawPolicyProfile = parsed['policyProfile'];
  let policyProfile: PolicyProfile;
  if (rawPolicyProfile === undefined) {
    // Legacy secrets.json missing policyProfile defaults conservatively to 'github'.
    policyProfile = 'github';
  } else if (rawPolicyProfile === 'local' || rawPolicyProfile === 'github') {
    policyProfile = rawPolicyProfile;
  } else {
    throw new TaskpackError('ACTION_INPUT_INVALID', 'staged taskpack secrets.json policyProfile is invalid');
  }

  const localCommandGates: CompiledLocalCommandGate[] = [];
  for (const gate of rawGates) {
    if (!isPlainRecord(gate)) {
      throw new TaskpackError('ACTION_INPUT_INVALID', 'staged taskpack localCommandGates entry is invalid');
    }
    for (const key of Object.keys(gate)) {
      if (STAGED_FORBIDDEN_KEYS.has(key) || !STAGED_GATE_KEYS.has(key)) {
        throw new TaskpackError('ACTION_INPUT_INVALID', `staged taskpack localCommandGates entry has invalid key "${key}"`);
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
      throw new TaskpackError('ACTION_INPUT_INVALID', 'staged taskpack localCommandGates entry is invalid');
    }
    let normalizedScript: string;
    try {
      normalizedScript = normalizeCandidateRelativePath(gate['script']);
    } catch {
      throw new TaskpackError('ACTION_INPUT_INVALID', 'staged taskpack localCommandGates script path is invalid');
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
          throw new TaskpackError('ACTION_INPUT_INVALID', 'staged taskpack localCommandGates envMap is invalid');
        }
        cleanMap[k] = v;
      }
      envMap = Object.freeze(cleanMap);
    }
    const rawGateNetworkMode = gate['networkMode'];
    if (
      rawGateNetworkMode !== undefined
      && rawGateNetworkMode !== 'none'
      && rawGateNetworkMode !== 'loopback-only'
      && rawGateNetworkMode !== 'allow-outbound'
    ) {
      throw new TaskpackError('ACTION_INPUT_INVALID', 'staged taskpack localCommandGates networkMode is invalid');
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
      ...(rawGateNetworkMode !== undefined ? { networkMode: rawGateNetworkMode } : {}),
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
        throw new TaskpackError('ACTION_INPUT_INVALID', 'staged taskpack roleMcpServers is invalid');
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
        throw new TaskpackError('ACTION_INPUT_INVALID', 'staged taskpack mcpServers entry is invalid');
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
    policyProfile,
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
    throw new TaskpackError('ACTION_INPUT_INVALID', `invalid controller runId "${options.runId}"`);
  }
  if (typeof options.repositoryRoot !== 'string' || options.repositoryRoot.trim().length === 0) {
    throw new TaskpackError('ACTION_INPUT_INVALID', 'repositoryRoot must exist');
  }
  let realRepositoryRoot: string;
  try {
    realRepositoryRoot = await realpath(options.repositoryRoot);
    const repoStat = await lstat(realRepositoryRoot);
    if (!repoStat.isDirectory()) {
      throw new TaskpackError('ACTION_INPUT_INVALID', 'repositoryRoot must exist');
    }
  } catch (error) {
    if (error instanceof TaskpackError) throw error;
    throw new TaskpackError('ACTION_INPUT_INVALID', 'repositoryRoot must exist');
  }

  if (typeof options.runRoot !== 'string' || options.runRoot.trim().length === 0) {
    throw new TaskpackError('ACTION_INPUT_INVALID', 'runRoot must be a non-symlink directory');
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
        throw new TaskpackError('ACTION_INPUT_INVALID', 'runRoot must be a non-symlink directory');
      }
      const parent = dirname(anc);
      if (parent === anc) {
        throw new TaskpackError('ACTION_INPUT_INVALID', 'runRoot must be a non-symlink directory');
      }
      anc = parent;
    }
  }
  if (anc === resolvedRunRoot && (ancStat.isSymbolicLink() || !ancStat.isDirectory())) {
    throw new TaskpackError('ACTION_INPUT_INVALID', 'runRoot must be a non-symlink directory');
  }
  if (!ancStat.isDirectory() && !ancStat.isSymbolicLink()) {
    throw new TaskpackError('ACTION_INPUT_INVALID', 'runRoot must be a non-symlink directory');
  }
  let realAnc: string;
  try {
    realAnc = await realpath(anc);
    const realAncStat = await lstat(realAnc);
    if (!realAncStat.isDirectory()) {
      throw new TaskpackError('ACTION_INPUT_INVALID', 'runRoot must be a non-symlink directory');
    }
  } catch (error) {
    if (error instanceof TaskpackError) throw error;
    throw new TaskpackError('ACTION_INPUT_INVALID', 'runRoot must be a non-symlink directory');
  }
  const prospectiveRunRoot = anc === resolvedRunRoot ? realAnc : resolve(realAnc, relative(anc, resolvedRunRoot));
  if (
    insideRoot(prospectiveRunRoot, realRepositoryRoot)
    || insideRoot(realRepositoryRoot, prospectiveRunRoot)
    || insideRoot(realRepositoryRoot, join(prospectiveRunRoot, runId))
    || insideRoot(realRepositoryRoot, join(prospectiveRunRoot, `.taskpack-${runId}`))
    || insideRoot(realRepositoryRoot, join(prospectiveRunRoot, 'workspaces'))
  ) {
    throw new TaskpackError('ACTION_INPUT_INVALID', 'runRoot must live outside the target repository checkout');
  }

  await mkdir(resolvedRunRoot, { recursive: true, mode: 0o700 });
  const createdRunRootStat = await lstat(resolvedRunRoot);
  if (createdRunRootStat.isSymbolicLink() || !createdRunRootStat.isDirectory()) {
    throw new TaskpackError('ACTION_INPUT_INVALID', 'runRoot must be a non-symlink directory');
  }
  await chmod(resolvedRunRoot, 0o700);
  const realRunRoot = await realpath(resolvedRunRoot);
  if (insideRoot(realRunRoot, realRepositoryRoot) || insideRoot(realRepositoryRoot, realRunRoot)) {
    throw new TaskpackError('ACTION_INPUT_INVALID', 'runRoot must live outside the target repository checkout');
  }

  const stageDir = join(realRunRoot, `.taskpack-${runId}`);
  const secretsPath = join(stageDir, 'secrets.json');
  let existingStageStat = null;
  try {
    existingStageStat = await lstat(stageDir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw new TaskpackError('ACTION_INPUT_INVALID', `staged taskpack directory "${stageDir}" could not be inspected`);
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
      throw new TaskpackError(
        'ACTION_INPUT_INVALID',
        `staged taskpack directory "${stageDir}" must be an owner-only (0o700) non-symlink directory`,
      );
    }
    return await readAndValidateStagedTaskpackSecrets(stageDir, runId);
  }

  const runtimeEnv = options.runtimeEnv ?? process.env;
  const policyProfile: PolicyProfile = options.policyProfile ?? options.hostPolicy?.policyProfile ?? 'local';
  const hostPolicy: ExecutionHostPolicy = {
    policyProfile,
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
    throw new TaskpackError('TASKPACK_MANIFEST_INVALID', 'taskpack manifest escapes the repository root', '/');
  }
  const relativeTaskpackPath = normalizeRelativePath(relToRoot.split(sep).join('/'), '/');
  const manifest = await loadDeclarativeTaskpack({
    manifestPath: relativeTaskpackPath,
    repositoryRoot: realRepositoryRoot,
    policyProfile,
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
        throw new TaskpackError(
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

    const maxStagedWsBytes = Math.min(
      OVERLAY_LIMITS.maxMaxBytes,
      Math.max(PREFLIGHT_MAX_WORKSPACE_RESOURCES_TOTAL_BYTES, manifest.spec.limits?.overlay?.maxBytes ?? 0),
    );
    if (preflightResult?.checkStagedDir !== undefined && preflightResult.checkStagedDir !== null) {
      persistentCheckStagedDir = join(stageDir, 'preflight-staged');
      await copyDirectoryTreeReadOnly(preflightResult.checkStagedDir, persistentCheckStagedDir, {
        maxTotalBytes: maxStagedWsBytes,
      });
    }
    if (
      persistentWorkspaceStagedDir !== null
      && preflightResult?.stagedDir !== undefined
      && preflightResult.stagedDir !== null
    ) {
      await copyDirectoryTreeReadOnly(preflightResult.stagedDir, persistentWorkspaceStagedDir, {
        maxTotalBytes: maxStagedWsBytes,
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

    const effectivePolicyProfile = compiled.policyProfile ?? policyProfile;
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
        policyProfile: effectivePolicyProfile,
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
      policyProfile: effectivePolicyProfile,
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
    throw new TaskpackError('ACTION_INPUT_INVALID', `invalid controller runId "${options.runId}"`);
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
  const resolvedPolicyProfile: PolicyProfile = staged.policyProfile ?? 'github';
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
      throw new TaskpackError(
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
        throw new TaskpackError(
          'TASKPACK_SCOPE_VIOLATION',
          `staged taskpack manifest "${manifestRel}" must not contain symbolic links`,
          '/',
        );
      }
      leafStat = st;
    }
    if (manifestExists) {
      if (leafStat === null || !leafStat.isFile()) {
        throw new TaskpackError(
          'TASKPACK_SCOPE_VIOLATION',
          `staged taskpack manifest "${manifestRel}" must be a regular non-symlink file`,
          '/',
        );
      }
      const realManifest = await realpath(cursor);
      if (!insideRoot(realManifest, realStagedRepoRoot)) {
        throw new TaskpackError(
          'TASKPACK_SCOPE_VIOLATION',
          `staged taskpack manifest "${manifestRel}" escapes repository root`,
          '/',
        );
      }
      const loadedManifest = await loadDeclarativeTaskpack({
        manifestPath: manifestRel,
        repositoryRoot: staged.repositoryRoot,
        policyProfile: resolvedPolicyProfile,
        hostPolicy: {
          policyProfile: resolvedPolicyProfile,
          allowWorkflowWrites: staged.allowWorkflowWrites === true,
        },
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
    if (error instanceof TaskpackError) {
      throw error;
    }
    decisions = undefined;
  }

  if (staged.localCommandGates.length === 0) {
    const gateUrlOverrides = Object.freeze({});
    const ports = Object.freeze({
      gateUrlOverrides,
      policyProfile: resolvedPolicyProfile,
      ...(staged.allowWorkflowWrites !== undefined ? { allowWorkflowWrites: staged.allowWorkflowWrites } : {}),
      ...(staged.roleMcpServers !== undefined ? { roleMcpServers: staged.roleMcpServers } : {}),
      ...(staged.mcpServers !== undefined ? { mcpServers: staged.mcpServers } : {}),
      ...(decisions !== undefined ? { decisions } : {}),
    });
    return {
      staged,
      environment,
      gateUrlOverrides,
      policyProfile: resolvedPolicyProfile,
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
    policyProfile: resolvedPolicyProfile,
    ...(staged.allowWorkflowWrites !== undefined ? { allowWorkflowWrites: staged.allowWorkflowWrites } : {}),
    ...(staged.roleMcpServers !== undefined ? { roleMcpServers: staged.roleMcpServers } : {}),
    ...(staged.mcpServers !== undefined ? { mcpServers: staged.mcpServers } : {}),
    ...(decisions !== undefined ? { decisions } : {}),
  });

  return {
    staged,
    environment,
    gateUrlOverrides,
    policyProfile: resolvedPolicyProfile,
    ...(staged.allowWorkflowWrites !== undefined ? { allowWorkflowWrites: staged.allowWorkflowWrites } : {}),
    ...(staged.roleMcpServers !== undefined ? { roleMcpServers: staged.roleMcpServers } : {}),
    ...(staged.mcpServers !== undefined ? { mcpServers: staged.mcpServers } : {}),
    ...(decisions !== undefined ? { decisions } : {}),
    ports,
    serverUrl: server.url,
    close: () => server.close(),
  };
}
