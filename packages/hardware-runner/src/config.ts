import { lstat } from 'node:fs/promises';
import { dirname, isAbsolute, resolve, sep } from 'node:path';
import { types } from 'node:util';
import { OVERLAY_LIMITS } from '@loopwright/core';
import {
  parseJsonSubset,
  parseYamlDocument,
  readBoundedRegularFile,
  TaskpackError,
  type Json,
} from '@loopwright/taskpack';
import {
  HardwareRunnerError,
  type HardwareRunnerErrorCode,
  type RelayConfig,
  type RelayServerOptions,
  type RelayTlsConfig,
  type WorkerCapabilities,
  type WorkerConfig,
} from './types.js';

export const MAX_RUNNER_CONFIG_BYTES = 262_144;
export const DEFAULT_RELAY_HOST = '127.0.0.1';
export const DEFAULT_LEASE_TTL_MS = 30_000;
export const DEFAULT_SWEEP_INTERVAL_MS = 5_000;
export const DEFAULT_VERDICT_TTL_MS = 3_600_000;
export const DEFAULT_MAX_JOBS = 1_024;
export const DEFAULT_WORKER_POLL_WAIT_MS = 10_000;
export const DEFAULT_WORKER_HEARTBEAT_INTERVAL_MS = 5_000;
export const DEFAULT_WORKER_REQUEST_TIMEOUT_MS = 30_000;
export const DEFAULT_WORKER_STAGE_TIMEOUT_MS = 300_000;

const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
const LONE_SURROGATE_RE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u;
const ENV_VAR_NAME_RE = /^[A-Z][A-Z0-9_]{0,127}$/;
const WORKER_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const WORKLOAD_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const PRINTABLE_ASCII_RE = /^[\x20-\x7E]+$/;
const CONTROL_OR_SPACE_TRIM_RE = /[\r\n\t\p{C}]/u;
const MIN_SECRET_LENGTH = 8;
export const MAX_SECRET_LENGTH = 4_096;
const DARWIN_ROOT_SYMLINKS = new Set(['/var', '/tmp', '/etc']);

export interface LoadRunnerConfigOptions {
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly maxBytes?: number;
}

export interface ParseRunnerConfigOptions {
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly baseDir?: string;
}

export function hasLoneSurrogate(value: string): boolean {
  return LONE_SURROGATE_RE.test(value);
}

function configInvalid(message: string, path = '/'): never {
  throw new HardwareRunnerError('CONFIG_INVALID', message, path);
}

function failWith(code: HardwareRunnerErrorCode, message: string, path = '/'): never {
  throw new HardwareRunnerError(code, message, path);
}

function isAllowedOsRootSymlink(targetPath: string): boolean {
  return process.platform === 'darwin' && DARWIN_ROOT_SYMLINKS.has(targetPath);
}

/**
 * Reject any symlink at `targetPath` (if `checkLeaf` is true and exists) or any ancestor directory,
 * permitting only standard macOS root firmlinks (`/var`, `/tmp`, `/etc`).
 */
export async function assertNoSymlinkAncestors(
  targetPath: string,
  options: { readonly checkLeaf?: boolean; readonly code?: HardwareRunnerErrorCode; readonly diagPath?: string } = {},
): Promise<void> {
  const code = options.code ?? 'CONFIG_INVALID';
  const diagPath = options.diagPath ?? '/';
  if (
    typeof targetPath !== 'string'
    || targetPath.length === 0
    || targetPath.length > 4096
    || /[\0\r\n]/.test(targetPath)
    || hasLoneSurrogate(targetPath)
    || !isAbsolute(targetPath)
  ) {
    failWith(code, 'path must be a valid absolute filesystem path', diagPath);
  }
  const normalized = resolve(targetPath);
  let current = options.checkLeaf === false ? dirname(normalized) : normalized;
  let depth = 0;
  while (true) {
    if (++depth > 128) {
      failWith(code, 'path exceeds maximum directory depth', diagPath);
    }
    const stat = await lstat(current).catch((err: unknown) => {
      if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') return null;
      failWith(code, 'failed to inspect path metadata', diagPath);
    });
    if (stat !== null) {
      if (stat.isSymbolicLink() && !isAllowedOsRootSymlink(current)) {
        failWith(code, 'symlink paths and symlinked ancestor directories are forbidden', diagPath);
      }
      const isCheckedLeaf = options.checkLeaf !== false && current === normalized;
      if (!isCheckedLeaf && !stat.isDirectory() && !isAllowedOsRootSymlink(current)) {
        failWith(code, 'ancestor path component is not a directory', diagPath);
      }
    }
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
}

export function toNullPrototypeValue(
  input: unknown,
  code: HardwareRunnerErrorCode = 'CONFIG_INVALID',
  path = '/',
  depth = 1,
): Json {
  if (depth > 32) {
    failWith(code, 'value exceeds maximum nesting depth', path);
  }
  if (input === null || typeof input === 'boolean') {
    return input;
  }
  if (typeof input === 'number') {
    if (!Number.isFinite(input) || Object.is(input, -0)) {
      failWith(code, 'numeric value must be finite and not -0', path);
    }
    return input;
  }
  if (typeof input === 'string') {
    if (hasLoneSurrogate(input)) {
      failWith(code, 'string contains lone UTF-16 surrogate', path);
    }
    return input;
  }
  if (Array.isArray(input)) {
    if (types.isProxy(input) || Object.getPrototypeOf(input) !== Array.prototype) {
      failWith(code, 'invalid array prototype', path);
    }
    const lenDesc = Object.getOwnPropertyDescriptor(input, 'length');
    const len = typeof lenDesc?.value === 'number' ? lenDesc.value : 0;
    if (Reflect.ownKeys(input).length !== len + 1) {
      failWith(code, 'sparse or non-standard array properties are forbidden', path);
    }
    const out: Json[] = [];
    for (let idx = 0; idx < len; idx += 1) {
      const desc = Object.getOwnPropertyDescriptor(input, String(idx));
      if (!desc || !('value' in desc) || !desc.enumerable) {
        failWith(code, 'invalid array element descriptor', `${path}/${idx}`);
      }
      out.push(toNullPrototypeValue(desc.value, code, `${path}/${idx}`, depth + 1));
    }
    return out;
  }
  if (typeof input === 'object') {
    if (types.isProxy(input)) {
      failWith(code, 'proxy objects are forbidden', path);
    }
    const proto: unknown = Object.getPrototypeOf(input);
    if (proto !== Object.prototype && proto !== null) {
      failWith(code, 'unsupported object prototype', path);
    }
    const rawKeys = Reflect.ownKeys(input);
    const out: Record<string, Json> = Object.create(null) as Record<string, Json>;
    for (const rawKey of rawKeys) {
      if (typeof rawKey !== 'string') {
        failWith(code, 'symbol keys are forbidden', path);
      }
      if (FORBIDDEN_KEYS.has(rawKey) || hasLoneSurrogate(rawKey)) {
        failWith(code, `forbidden object key "${rawKey}"`, path);
      }
      const desc = Object.getOwnPropertyDescriptor(input, rawKey);
      if (!desc || !('value' in desc) || !desc.enumerable) {
        failWith(code, `accessor or non-enumerable property "${rawKey}" is forbidden`, `${path}/${rawKey}`);
      }
      if (desc.value === undefined) continue;
      out[rawKey] = toNullPrototypeValue(desc.value, code, `${path}/${rawKey}`, depth + 1);
    }
    return out;
  }
  failWith(code, `unsupported value type ${typeof input}`, path);
}

export function expectNullProtoRecord(
  value: unknown,
  allowedKeys: ReadonlySet<string>,
  requiredKeys: readonly string[],
  code: HardwareRunnerErrorCode = 'CONFIG_INVALID',
  path = '/',
): Record<string, Json> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    failWith(code, 'expected an object mapping', path);
  }
  const obj = value as Record<string, Json>;
  for (const reqKey of requiredKeys) {
    if (!Object.hasOwn(obj, reqKey) || obj[reqKey] === undefined) {
      failWith(code, `missing required field "${reqKey}"`, `${path === '/' ? '' : path}/${reqKey}`);
    }
  }
  for (const key of Object.keys(obj)) {
    if (!allowedKeys.has(key)) {
      failWith(code, `unknown field "${key}"`, `${path === '/' ? '' : path}/${key}`);
    }
  }
  const copy: Record<string, Json> = Object.create(null) as Record<string, Json>;
  for (const key of Object.keys(obj)) {
    if (Object.hasOwn(obj, key) && obj[key] !== undefined) {
      copy[key] = obj[key]!;
    }
  }
  return copy;
}

export function parseStrictJsonBytes(
  bytes: Uint8Array,
  maxBytes: number,
  code: HardwareRunnerErrorCode = 'CONFIG_INVALID',
  diagPath = '/',
): Json {
  if (bytes.byteLength > maxBytes) {
    failWith(code, `payload exceeds ${maxBytes} bytes`, diagPath);
  }
  let source: string;
  try {
    source = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    failWith(code, 'payload is not valid UTF-8', diagPath);
  }
  if (hasLoneSurrogate(source)) {
    failWith(code, 'payload contains lone UTF-16 surrogate', diagPath);
  }
  let parsed: Json;
  try {
    parsed = parseJsonSubset(source, {
      maxNodes: 16_384,
      maxDepth: 32,
      maxCollection: 4_096,
      maxString: 16_384,
      diagPath,
    });
  } catch (err: unknown) {
    if (err instanceof TaskpackError) {
      failWith(code, err.message, err.path ?? diagPath);
    }
    failWith(code, 'invalid JSON syntax', diagPath);
  }
  return toNullPrototypeValue(parsed, code, diagPath);
}

export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    if (typeof value === 'number') {
      if (!Number.isFinite(value)) {
        throw new HardwareRunnerError('ARTIFACT_INVALID', 'cannot serialize non-finite number');
      }
      return JSON.stringify(Object.is(value, -0) ? 0 : value);
    }
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return '[' + value.map(item => canonicalJson(item)).join(',') + ']';
  }
  const rec = value as Readonly<Record<string, unknown>>;
  const keys = Object.keys(rec)
    .filter(key => Object.hasOwn(rec, key) && rec[key] !== undefined)
    .sort();
  return '{' + keys.map(key => JSON.stringify(key) + ':' + canonicalJson(rec[key])).join(',') + '}';
}

function expectSafeInt(
  value: unknown,
  min: number,
  max: number,
  path: string,
  code: HardwareRunnerErrorCode = 'CONFIG_INVALID',
): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || Object.is(value, -0) || value < min || value > max) {
    failWith(code, `expected integer in ${min}..${max}`, path);
  }
  return value;
}

function expectPrintableString(
  value: unknown,
  min: number,
  max: number,
  path: string,
  asciiOnly = false,
  code: HardwareRunnerErrorCode = 'CONFIG_INVALID',
): string {
  if (typeof value !== 'string' || value.length < min || value.length > max) {
    failWith(code, `expected string of length ${min}..${max}`, path);
  }
  if (value.trim() !== value || hasLoneSurrogate(value)) {
    failWith(code, 'string must not contain leading/trailing whitespace or lone surrogates', path);
  }
  if (asciiOnly) {
    if (!PRINTABLE_ASCII_RE.test(value)) {
      failWith(code, 'expected printable ASCII string', path);
    }
  } else if (CONTROL_OR_SPACE_TRIM_RE.test(value)) {
    failWith(code, 'string contains forbidden control characters', path);
  }
  return value;
}

function resolveFilesystemPath(raw: unknown, baseDir: string, path: string): string {
  if (typeof raw !== 'string' || raw.trim().length === 0 || raw.length > 4096 || /[\0\r\n]/.test(raw) || hasLoneSurrogate(raw)) {
    configInvalid('invalid filesystem path', path);
  }
  return isAbsolute(raw) ? resolve(raw) : resolve(baseDir, raw);
}

export const RUNNER_SECRET_ENV_FIELDS: readonly string[] = Object.freeze([
  'signingSecretEnv',
  'controllerAuthTokenEnv',
  'workerTokenEnv',
]);

export const RUNNER_SECRET_ENV_LIST_FIELDS: readonly string[] = Object.freeze([
  'workerTokenEnvs',
]);

/**
 * Resolve a credential reference (`ENV_NAME` or `env:ENV_NAME`) from `env` without ever
 * embedding secret values into thrown error messages.
 */
export function resolveEnvSecretRef(
  rawRef: unknown,
  env: Readonly<Record<string, string | undefined>>,
  path: string,
): string {
  if (typeof rawRef !== 'string' || rawRef.length === 0 || rawRef.length > 132 || hasLoneSurrogate(rawRef)) {
    configInvalid('credential reference must be a non-empty env variable name or env:<NAME>', path);
  }
  const envName = rawRef.startsWith('env:') ? rawRef.slice(4) : rawRef;
  if (!ENV_VAR_NAME_RE.test(envName)) {
    configInvalid('invalid credential env reference syntax', path);
  }
  const resolved = Object.hasOwn(env, envName) ? env[envName] : undefined;
  if (
    typeof resolved !== 'string'
    || resolved.trim().length < MIN_SECRET_LENGTH
    || resolved.length > MAX_SECRET_LENGTH
    || hasLoneSurrogate(resolved)
  ) {
    configInvalid(
      `environment variable "${envName}" is unset or outside ${MIN_SECRET_LENGTH}..${MAX_SECRET_LENGTH} characters`,
      path,
    );
  }
  return resolved;
}

function validateSecretValue(secret: unknown, path: string): string {
  if (
    typeof secret !== 'string'
    || secret.trim().length < MIN_SECRET_LENGTH
    || secret.length > MAX_SECRET_LENGTH
    || hasLoneSurrogate(secret)
  ) {
    configInvalid(
      `secret at ${path} must be a valid string of ${MIN_SECRET_LENGTH}..${MAX_SECRET_LENGTH} characters`,
      path,
    );
  }
  return secret;
}

function validateHost(raw: unknown, path: string): string {
  const host = expectPrintableString(raw, 1, 255, path, true);
  if (/[\s/?#@]/.test(host)) {
    configInvalid('invalid host address', path);
  }
  return host;
}

function validateRelayUrl(raw: unknown, path: string): string {
  const str = expectPrintableString(raw, 1, 2048, path, true);
  let parsed: URL;
  try {
    parsed = new URL(str);
  } catch {
    configInvalid('relayUrl must be a valid http:// or https:// URL', path);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    configInvalid('relayUrl protocol must be http: or https:', path);
  }
  if (!parsed.hostname || parsed.username !== '' || parsed.password !== '' || parsed.search !== '' || parsed.hash !== '') {
    configInvalid('relayUrl must not embed credentials, query parameters, or fragments', path);
  }
  if (parsed.port !== '') {
    const portNum = Number(parsed.port);
    if (!Number.isSafeInteger(portNum) || portNum < 1 || portNum > 65535) {
      configInvalid('relayUrl port must be within 1..65535', path);
    }
  }
  const pathname = parsed.pathname === '/' ? '' : parsed.pathname.replace(/\/+$/, '');
  return `${parsed.origin}${pathname}`;
}

function isInsideOrEqual(candidate: string, parent: string): boolean {
  return candidate === parent || candidate.startsWith(parent.endsWith(sep) ? parent : parent + sep);
}

const RELAY_CONFIG_KEYS: ReadonlySet<string> = new Set([
  'kind',
  'host',
  'port',
  'casDir',
  'signingSecretEnv',
  'controllerAuthTokenEnv',
  'workerTokenEnv',
  'workerTokenEnvs',
  'leaseTtlMs',
  'sweepIntervalMs',
  'verdictTtlMs',
  'maxBlobBytes',
  'maxJobs',
  'tls',
]);

const RELAY_TLS_KEYS: ReadonlySet<string> = new Set(['certPath', 'keyPath', 'caPath']);

export function parseRelayConfigObject(
  rawInput: unknown,
  options: ParseRunnerConfigOptions = {},
): RelayConfig {
  const env = options.env ?? process.env;
  const baseDir = options.baseDir !== undefined ? resolve(options.baseDir) : process.cwd();
  const normalized = toNullPrototypeValue(rawInput, 'CONFIG_INVALID', '/');
  const root = expectNullProtoRecord(normalized, RELAY_CONFIG_KEYS, ['port', 'casDir', 'signingSecretEnv'], 'CONFIG_INVALID', '/');

  if (Object.hasOwn(root, 'kind') && root.kind !== 'relay') {
    configInvalid('kind must be "relay"', '/kind');
  }
  const host = Object.hasOwn(root, 'host') ? validateHost(root.host, '/host') : DEFAULT_RELAY_HOST;
  const port = expectSafeInt(root.port, 0, 65535, '/port');
  const casDir = resolveFilesystemPath(root.casDir, baseDir, '/casDir');

  const controllerSigningSecret = resolveEnvSecretRef(root.signingSecretEnv, env, '/signingSecretEnv');
  const controllerAuthToken = Object.hasOwn(root, 'controllerAuthTokenEnv')
    ? resolveEnvSecretRef(root.controllerAuthTokenEnv, env, '/controllerAuthTokenEnv')
    : undefined;

  const workerTokenList: string[] = [];
  if (Object.hasOwn(root, 'workerTokenEnv')) {
    workerTokenList.push(resolveEnvSecretRef(root.workerTokenEnv, env, '/workerTokenEnv'));
  }
  if (Object.hasOwn(root, 'workerTokenEnvs')) {
    const rawEnvs = root.workerTokenEnvs;
    if (!Array.isArray(rawEnvs) || rawEnvs.length < 1 || rawEnvs.length > 64) {
      configInvalid('workerTokenEnvs must be an array of 1..64 env references', '/workerTokenEnvs');
    }
    rawEnvs.forEach((entry, idx) => {
      workerTokenList.push(resolveEnvSecretRef(entry, env, `/workerTokenEnvs/${idx}`));
    });
  }
  const workerTokens = [...new Set(workerTokenList)];
  if (workerTokens.length === 0 || workerTokens.length > 64) {
    configInvalid('at least one worker token env reference (workerTokenEnv or workerTokenEnvs) is required', '/workerTokenEnv');
  }
  for (const token of workerTokens) {
    if (token === controllerSigningSecret || (controllerAuthToken !== undefined && token === controllerAuthToken)) {
      configInvalid('workerTokens must be distinct from controllerSigningSecret and controllerAuthToken', '/workerTokenEnv');
    }
  }

  const leaseTtlMs = Object.hasOwn(root, 'leaseTtlMs')
    ? expectSafeInt(root.leaseTtlMs, 100, 600_000, '/leaseTtlMs')
    : DEFAULT_LEASE_TTL_MS;
  const sweepIntervalMs = Object.hasOwn(root, 'sweepIntervalMs')
    ? expectSafeInt(root.sweepIntervalMs, 50, 300_000, '/sweepIntervalMs')
    : DEFAULT_SWEEP_INTERVAL_MS;
  const verdictTtlMs = Object.hasOwn(root, 'verdictTtlMs')
    ? expectSafeInt(root.verdictTtlMs, 1_000, 86_400_000, '/verdictTtlMs')
    : DEFAULT_VERDICT_TTL_MS;
  const maxBlobBytes = Object.hasOwn(root, 'maxBlobBytes')
    ? expectSafeInt(root.maxBlobBytes, 1, OVERLAY_LIMITS.maxMaxBytes, '/maxBlobBytes')
    : OVERLAY_LIMITS.maxMaxBytes;
  const maxJobs = Object.hasOwn(root, 'maxJobs')
    ? expectSafeInt(root.maxJobs, 1, 10_000, '/maxJobs')
    : DEFAULT_MAX_JOBS;

  let tls: RelayTlsConfig | false = false;
  if (Object.hasOwn(root, 'tls')) {
    if (root.tls === false) {
      tls = false;
    } else {
      const tlsObj = expectNullProtoRecord(root.tls, RELAY_TLS_KEYS, ['certPath', 'keyPath'], 'CONFIG_INVALID', '/tls');
      const certPath = resolveFilesystemPath(tlsObj.certPath, baseDir, '/tls/certPath');
      const keyPath = resolveFilesystemPath(tlsObj.keyPath, baseDir, '/tls/keyPath');
      const caPath = Object.hasOwn(tlsObj, 'caPath')
        ? resolveFilesystemPath(tlsObj.caPath, baseDir, '/tls/caPath')
        : undefined;
      tls = Object.freeze({
        certPath,
        keyPath,
        ...(caPath !== undefined ? { caPath } : {}),
      });
    }
  }

  return Object.freeze({
    host,
    port,
    casDir,
    controllerSigningSecret,
    ...(controllerAuthToken !== undefined ? { controllerAuthToken } : {}),
    workerTokens: Object.freeze(workerTokens),
    leaseTtlMs,
    sweepIntervalMs,
    verdictTtlMs,
    maxBlobBytes,
    maxJobs,
    tls,
  });
}

export function normalizeRelayServerConfig(options: RelayServerOptions): RelayConfig {
  if (options === null || typeof options !== 'object' || Array.isArray(options)) {
    configInvalid('relay server options must be an object', '/');
  }
  const host = options.host !== undefined ? validateHost(options.host, '/host') : DEFAULT_RELAY_HOST;
  const port = expectSafeInt(options.port, 0, 65535, '/port');
  const casDir = resolveFilesystemPath(options.casDir, process.cwd(), '/casDir');
  if (!isAbsolute(options.casDir)) {
    configInvalid('casDir must be an absolute path', '/casDir');
  }
  const controllerSigningSecret = validateSecretValue(options.controllerSigningSecret, '/controllerSigningSecret');
  const controllerAuthToken = options.controllerAuthToken !== undefined
    ? validateSecretValue(options.controllerAuthToken, '/controllerAuthToken')
    : undefined;

  if (!Array.isArray(options.workerTokens) || options.workerTokens.length < 1 || options.workerTokens.length > 64) {
    configInvalid('workerTokens must contain 1..64 valid tokens', '/workerTokens');
  }
  const workerTokens = [...new Set(options.workerTokens.map((t, idx) => validateSecretValue(t, `/workerTokens/${idx}`)))];
  for (const token of workerTokens) {
    if (token === controllerSigningSecret || (controllerAuthToken !== undefined && token === controllerAuthToken)) {
      configInvalid('workerTokens must be distinct from controllerSigningSecret and controllerAuthToken', '/workerTokens');
    }
  }

  const leaseTtlMs = options.leaseTtlMs !== undefined
    ? expectSafeInt(options.leaseTtlMs, 50, 600_000, '/leaseTtlMs')
    : DEFAULT_LEASE_TTL_MS;
  const sweepIntervalMs = options.sweepIntervalMs !== undefined
    ? expectSafeInt(options.sweepIntervalMs, 10, 300_000, '/sweepIntervalMs')
    : DEFAULT_SWEEP_INTERVAL_MS;
  const verdictTtlMs = options.verdictTtlMs !== undefined
    ? expectSafeInt(options.verdictTtlMs, 1_000, 86_400_000, '/verdictTtlMs')
    : DEFAULT_VERDICT_TTL_MS;
  const maxBlobBytes = options.maxBlobBytes !== undefined
    ? expectSafeInt(options.maxBlobBytes, 1, OVERLAY_LIMITS.maxMaxBytes, '/maxBlobBytes')
    : OVERLAY_LIMITS.maxMaxBytes;
  const maxJobs = options.maxJobs !== undefined
    ? expectSafeInt(options.maxJobs, 1, 10_000, '/maxJobs')
    : DEFAULT_MAX_JOBS;
  const maxRetainedTerminalOps = options.maxRetainedTerminalOps !== undefined
    ? expectSafeInt(options.maxRetainedTerminalOps, 1, 1_000_000, '/maxRetainedTerminalOps')
    : undefined;

  let tls: RelayTlsConfig | false = false;
  if (options.tls !== undefined && options.tls !== false) {
    tls = Object.freeze({
      certPath: resolveFilesystemPath(options.tls.certPath, process.cwd(), '/tls/certPath'),
      keyPath: resolveFilesystemPath(options.tls.keyPath, process.cwd(), '/tls/keyPath'),
      ...(options.tls.caPath !== undefined
        ? { caPath: resolveFilesystemPath(options.tls.caPath, process.cwd(), '/tls/caPath') }
        : {}),
    });
  }

  return Object.freeze({
    host,
    port,
    casDir,
    controllerSigningSecret,
    ...(controllerAuthToken !== undefined ? { controllerAuthToken } : {}),
    workerTokens: Object.freeze(workerTokens),
    leaseTtlMs,
    sweepIntervalMs,
    verdictTtlMs,
    maxBlobBytes,
    maxJobs,
    ...(maxRetainedTerminalOps !== undefined ? { maxRetainedTerminalOps } : {}),
    tls,
  });
}

const WORKER_CONFIG_KEYS: ReadonlySet<string> = new Set([
  'kind',
  'workerId',
  'relayUrl',
  'workerTokenEnv',
  'workDir',
  'heldOutWorkloadsDir',
  'sandboxBackend',
  'dockerImage',
  'capabilities',
  'pollWaitMs',
  'heartbeatIntervalMs',
  'requestTimeoutMs',
  'stageATimeoutMs',
  'stageBTimeoutMs',
  'toolchainPaths',
  'probeMode',
  'tlsCaPath',
]);

const WORKER_CAPABILITIES_KEYS: ReadonlySet<string> = new Set([
  'accelerator',
  'isolationModes',
  'deviceCount',
  'driverVersion',
  'topology',
  'workloadIds',
]);

export function validateWorkerCapabilitiesObject(
  raw: unknown,
  code: HardwareRunnerErrorCode = 'CONFIG_INVALID',
  path = '/capabilities',
): WorkerCapabilities {
  const cap = expectNullProtoRecord(
    raw,
    WORKER_CAPABILITIES_KEYS,
    ['accelerator', 'isolationModes', 'deviceCount', 'driverVersion'],
    code,
    path,
  );
  const accelerator = expectPrintableString(cap.accelerator, 1, 64, `${path}/accelerator`, true, code);
  const rawModes = cap.isolationModes;
  if (!Array.isArray(rawModes) || rawModes.length < 1 || rawModes.length > 2) {
    failWith(code, 'isolationModes must contain 1..2 entries', `${path}/isolationModes`);
  }
  const modes: ('whole_device' | 'sliced')[] = [];
  const seenModes = new Set<string>();
  rawModes.forEach((m, idx) => {
    if (m !== 'whole_device' && m !== 'sliced') {
      failWith(code, 'isolationModes entries must be "whole_device" or "sliced"', `${path}/isolationModes/${idx}`);
    }
    if (seenModes.has(m)) {
      failWith(code, `duplicate isolationMode "${m}"`, `${path}/isolationModes/${idx}`);
    }
    seenModes.add(m);
    modes.push(m);
  });

  const deviceCount = expectSafeInt(cap.deviceCount, 1, 64, `${path}/deviceCount`, code);
  const driverVersion = expectPrintableString(cap.driverVersion, 1, 128, `${path}/driverVersion`, false, code);
  const topology = Object.hasOwn(cap, 'topology')
    ? expectPrintableString(cap.topology, 1, 128, `${path}/topology`, false, code)
    : undefined;

  let workloadIds: readonly string[] | undefined;
  if (Object.hasOwn(cap, 'workloadIds')) {
    const rawWorkloads = cap.workloadIds;
    if (!Array.isArray(rawWorkloads) || rawWorkloads.length > 256) {
      failWith(code, 'workloadIds must be an array of at most 256 identifiers', `${path}/workloadIds`);
    }
    const parsedIds: string[] = [];
    const seenIds = new Set<string>();
    rawWorkloads.forEach((item, idx) => {
      const id = expectPrintableString(item, 1, 128, `${path}/workloadIds/${idx}`, true, code);
      if (!WORKLOAD_ID_RE.test(id)) {
        failWith(code, 'invalid workloadId identifier', `${path}/workloadIds/${idx}`);
      }
      if (seenIds.has(id)) {
        failWith(code, `duplicate workloadId "${id}"`, `${path}/workloadIds/${idx}`);
      }
      seenIds.add(id);
      parsedIds.push(id);
    });
    workloadIds = Object.freeze(parsedIds);
  }

  return Object.freeze({
    accelerator,
    isolationModes: Object.freeze(modes),
    deviceCount,
    driverVersion,
    ...(topology !== undefined ? { topology } : {}),
    ...(workloadIds !== undefined ? { workloadIds } : {}),
  });
}

export function parseWorkerConfigObject(
  rawInput: unknown,
  options: ParseRunnerConfigOptions = {},
): WorkerConfig {
  const env = options.env ?? process.env;
  const baseDir = options.baseDir !== undefined ? resolve(options.baseDir) : process.cwd();
  const normalized = toNullPrototypeValue(rawInput, 'CONFIG_INVALID', '/');
  const root = expectNullProtoRecord(
    normalized,
    WORKER_CONFIG_KEYS,
    ['workerId', 'relayUrl', 'workerTokenEnv', 'workDir', 'heldOutWorkloadsDir', 'capabilities'],
    'CONFIG_INVALID',
    '/',
  );

  if (Object.hasOwn(root, 'kind') && root.kind !== 'worker') {
    configInvalid('kind must be "worker"', '/kind');
  }
  const workerId = expectPrintableString(root.workerId, 1, 128, '/workerId', true);
  if (!WORKER_ID_RE.test(workerId)) {
    configInvalid('workerId contains unsupported characters', '/workerId');
  }
  const relayUrl = validateRelayUrl(root.relayUrl, '/relayUrl');
  const workerToken = resolveEnvSecretRef(root.workerTokenEnv, env, '/workerTokenEnv');
  const workDir = resolveFilesystemPath(root.workDir, baseDir, '/workDir');
  const heldOutWorkloadsDir = resolveFilesystemPath(root.heldOutWorkloadsDir, baseDir, '/heldOutWorkloadsDir');
  if (isInsideOrEqual(heldOutWorkloadsDir, workDir) || isInsideOrEqual(workDir, heldOutWorkloadsDir)) {
    configInvalid('workDir and heldOutWorkloadsDir must be disjoint directories', '/heldOutWorkloadsDir');
  }

  let sandboxBackend: 'native_os' | 'docker' = 'native_os';
  if (Object.hasOwn(root, 'sandboxBackend')) {
    if (root.sandboxBackend !== 'native_os' && root.sandboxBackend !== 'docker') {
      configInvalid('sandboxBackend must be "native_os" or "docker"', '/sandboxBackend');
    }
    sandboxBackend = root.sandboxBackend;
  }

  const dockerImage = Object.hasOwn(root, 'dockerImage')
    ? expectPrintableString(root.dockerImage, 1, 256, '/dockerImage', true)
    : undefined;
  if (sandboxBackend === 'docker' && dockerImage === undefined) {
    configInvalid('dockerImage is required when sandboxBackend is "docker"', '/dockerImage');
  }

  const capabilities = validateWorkerCapabilitiesObject(root.capabilities, 'CONFIG_INVALID', '/capabilities');

  const pollWaitMs = Object.hasOwn(root, 'pollWaitMs')
    ? expectSafeInt(root.pollWaitMs, 0, 25_000, '/pollWaitMs')
    : DEFAULT_WORKER_POLL_WAIT_MS;
  const heartbeatIntervalMs = Object.hasOwn(root, 'heartbeatIntervalMs')
    ? expectSafeInt(root.heartbeatIntervalMs, 100, 300_000, '/heartbeatIntervalMs')
    : DEFAULT_WORKER_HEARTBEAT_INTERVAL_MS;
  const requestTimeoutMs = Object.hasOwn(root, 'requestTimeoutMs')
    ? expectSafeInt(root.requestTimeoutMs, 100, 600_000, '/requestTimeoutMs')
    : DEFAULT_WORKER_REQUEST_TIMEOUT_MS;
  const stageATimeoutMs = Object.hasOwn(root, 'stageATimeoutMs')
    ? expectSafeInt(root.stageATimeoutMs, 1_000, 3_600_000, '/stageATimeoutMs')
    : DEFAULT_WORKER_STAGE_TIMEOUT_MS;
  const stageBTimeoutMs = Object.hasOwn(root, 'stageBTimeoutMs')
    ? expectSafeInt(root.stageBTimeoutMs, 1_000, 3_600_000, '/stageBTimeoutMs')
    : DEFAULT_WORKER_STAGE_TIMEOUT_MS;

  const toolchainPaths: string[] = [];
  if (Object.hasOwn(root, 'toolchainPaths')) {
    const rawPaths = root.toolchainPaths;
    if (!Array.isArray(rawPaths) || rawPaths.length > 32) {
      configInvalid('toolchainPaths must be an array of at most 32 paths', '/toolchainPaths');
    }
    rawPaths.forEach((p, idx) => {
      if (typeof p !== 'string' || !isAbsolute(p)) {
        configInvalid('toolchainPaths entries must be absolute paths', `/toolchainPaths/${idx}`);
      }
      toolchainPaths.push(resolveFilesystemPath(p, baseDir, `/toolchainPaths/${idx}`));
    });
  }

  let probeMode: 'physical' | 'synthetic_fixture' = 'physical';
  if (Object.hasOwn(root, 'probeMode')) {
    if (root.probeMode !== 'physical' && root.probeMode !== 'synthetic_fixture') {
      configInvalid('probeMode must be "physical" or "synthetic_fixture"', '/probeMode');
    }
    probeMode = root.probeMode;
  }

  const tlsCaPath = Object.hasOwn(root, 'tlsCaPath')
    ? resolveFilesystemPath(root.tlsCaPath, baseDir, '/tlsCaPath')
    : undefined;

  return Object.freeze({
    workerId,
    relayUrl,
    workerToken,
    workDir,
    heldOutWorkloadsDir,
    sandboxBackend,
    ...(dockerImage !== undefined ? { dockerImage } : {}),
    capabilities,
    pollWaitMs,
    heartbeatIntervalMs,
    requestTimeoutMs,
    stageATimeoutMs,
    stageBTimeoutMs,
    toolchainPaths: Object.freeze(toolchainPaths),
    probeMode,
    ...(tlsCaPath !== undefined ? { tlsCaPath } : {}),
  });
}

async function readAndParseConfigDocument(
  filePath: string,
  maxBytes: number,
): Promise<{ readonly parsed: Json; readonly baseDir: string }> {
  if (typeof filePath !== 'string' || filePath.trim().length === 0 || filePath.length > 4096 || /[\0\r\n]/.test(filePath) || hasLoneSurrogate(filePath)) {
    configInvalid('config file path must be a valid path string', '/');
  }
  const absPath = resolve(filePath);
  await assertNoSymlinkAncestors(absPath, { checkLeaf: true, code: 'CONFIG_INVALID', diagPath: '/' });

  const rawBytes = await readBoundedRegularFile(absPath, maxBytes, message => {
    configInvalid(message, '/');
  });

  if (absPath.toLowerCase().endsWith('.json')) {
    return { parsed: parseStrictJsonBytes(rawBytes, maxBytes, 'CONFIG_INVALID', '/'), baseDir: dirname(absPath) };
  }

  let source: string;
  try {
    source = new TextDecoder('utf-8', { fatal: true }).decode(rawBytes);
  } catch {
    configInvalid('config file bytes are not valid UTF-8', '/');
  }
  if (hasLoneSurrogate(source)) {
    configInvalid('config file contains lone UTF-16 surrogate', '/');
  }
  let doc: Json;
  try {
    doc = parseYamlDocument(source);
  } catch (err: unknown) {
    if (err instanceof TaskpackError) {
      configInvalid(err.message, err.path ?? '/');
    }
    configInvalid('invalid YAML document', '/');
  }
  return { parsed: toNullPrototypeValue(doc, 'CONFIG_INVALID', '/'), baseDir: dirname(absPath) };
}

export async function loadRelayConfig(
  filePath: string,
  options: LoadRunnerConfigOptions = {},
): Promise<RelayConfig> {
  const maxBytes = options.maxBytes ?? MAX_RUNNER_CONFIG_BYTES;
  if (!Number.isSafeInteger(maxBytes) || Object.is(maxBytes, -0) || maxBytes < 1 || maxBytes > MAX_RUNNER_CONFIG_BYTES) {
    configInvalid(`maxBytes must be an integer within 1..${MAX_RUNNER_CONFIG_BYTES}`, '/maxBytes');
  }
  const { parsed, baseDir } = await readAndParseConfigDocument(filePath, maxBytes);
  return parseRelayConfigObject(parsed, {
    baseDir,
    ...(options.env !== undefined ? { env: options.env } : {}),
  });
}

export async function loadWorkerConfig(
  filePath: string,
  options: LoadRunnerConfigOptions = {},
): Promise<WorkerConfig> {
  const maxBytes = options.maxBytes ?? MAX_RUNNER_CONFIG_BYTES;
  if (!Number.isSafeInteger(maxBytes) || Object.is(maxBytes, -0) || maxBytes < 1 || maxBytes > MAX_RUNNER_CONFIG_BYTES) {
    configInvalid(`maxBytes must be an integer within 1..${MAX_RUNNER_CONFIG_BYTES}`, '/maxBytes');
  }
  const { parsed, baseDir } = await readAndParseConfigDocument(filePath, maxBytes);
  return parseWorkerConfigObject(parsed, {
    baseDir,
    ...(options.env !== undefined ? { env: options.env } : {}),
  });
}
