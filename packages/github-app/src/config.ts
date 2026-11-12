import { dirname, extname, join, resolve } from 'node:path';
import { normalizeRelativePath, parseTaskpackDocument, type Json } from './schema.js';
import { startGitHubAppControlPlane, type ControlPlaneHandle } from './service.js';
import { loadDeclarativeTaskpack } from './taskpack.js';
import { createGitHubRestTokenTransport, InstallationTokenBroker, SecretScrubber } from './token-broker.js';
import { readBoundedRegularFile } from './yaml.js';
import {
  DEFAULT_TOKEN_REFRESH_MARGIN_MS, GITHUB_APP_CONFIG_API_VERSION, GITHUB_APP_CONFIG_BYTES, GitHubAppError,
  type GitHubAppConfigDocument, type GitHubAppListenConfig, type LoadedGitHubAppConfig,
  type TaskpackCommentCommand,
} from './types.js';

export {
  GITHUB_APP_CONFIG_API_VERSION, GITHUB_APP_CONFIG_BYTES,
  type GitHubAppConfigDocument, type GitHubAppListenConfig, type LoadedGitHubAppConfig,
};

const ENV_NAME_PATTERN = /^[A-Z][A-Z0-9_]*$/;
const APP_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

function validateApiBaseUrl(rawUrl: string): void {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    configInvalid('spec.apiBaseUrl must be a valid URL', '/spec/apiBaseUrl');
  }
  const isLoopback = url.hostname === '127.0.0.1'
    || url.hostname === 'localhost'
    || url.hostname === '[::1]'
    || url.hostname === '::1';
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && isLoopback)) {
    configInvalid('spec.apiBaseUrl must use https:// (or loopback http:// for local tests)', '/spec/apiBaseUrl');
  }
}

function configInvalid(message: string, path: string | null = '/'): never {
  throw new GitHubAppError('GITHUB_APP_CONFIG_INVALID', message, path);
}

function requireObject(value: unknown, path: string, fields: readonly string[]): Record<string, Json> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    configInvalid('expected an object', path);
  }
  const record = value as Record<string, Json>;
  for (const key of Object.keys(record)) {
    if (!fields.includes(key)) configInvalid(`unknown field "${key}"`, path);
  }
  return record;
}

function requireString(value: unknown, path: string, min: number, max: number): string {
  if (typeof value !== 'string' || value.length < min || value.length > max) {
    configInvalid(`expected a string of ${min}..${max} characters`, path);
  }
  if (/[\0\r\n\t\v\f]/.test(value)) configInvalid('string contains forbidden control characters', path);
  return value;
}

function requireInteger(value: unknown, path: string, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max) {
    configInvalid(`expected an integer in [${min}, ${max}]`, path);
  }
  return value;
}

/**
 * Parse and validate a `GitHubAppConfig` document (`loopwright.dev/v1alpha1`) from raw YAML or JSON bytes.
 */
export function parseGitHubAppConfigDocument(bytes: Uint8Array, format: 'yaml' | 'json'): GitHubAppConfigDocument {
  if (bytes.byteLength > GITHUB_APP_CONFIG_BYTES) {
    configInvalid(`config exceeds ${GITHUB_APP_CONFIG_BYTES} bytes`, '/');
  }
  let raw: Json;
  try {
    raw = parseTaskpackDocument(bytes, format);
  } catch (error) {
    if (error instanceof GitHubAppError) {
      configInvalid(error.message, error.path);
    }
    configInvalid('failed to parse GitHubAppConfig document', '/');
  }
  const root = requireObject(raw, '/', ['apiVersion', 'kind', 'spec']);
  if (root['apiVersion'] !== GITHUB_APP_CONFIG_API_VERSION) {
    configInvalid(`unsupported apiVersion, expected ${GITHUB_APP_CONFIG_API_VERSION}`, '/apiVersion');
  }
  if (root['kind'] !== 'GitHubAppConfig') {
    configInvalid('kind must be GitHubAppConfig', '/kind');
  }

  const spec = requireObject(root['spec'], '/spec', [
    'appId', 'webhookSecretEnv', 'privateKeyEnv', 'apiBaseUrl',
    'listen', 'tokenTtlSeconds', 'maxPayloadBytes', 'taskpackPath', 'operatorAllowlist',
  ]);
  const rawAppId = spec['appId'];
  const appId = typeof rawAppId === 'number' && Number.isSafeInteger(rawAppId) && rawAppId > 0
    ? String(rawAppId)
    : requireString(rawAppId, '/spec/appId', 1, 64);
  if (!APP_ID_PATTERN.test(appId)) {
    configInvalid('spec.appId must be a non-empty numeric or identifier string', '/spec/appId');
  }

  const webhookSecretEnv = requireString(spec['webhookSecretEnv'], '/spec/webhookSecretEnv', 1, 128);
  if (!ENV_NAME_PATTERN.test(webhookSecretEnv)) {
    configInvalid('spec.webhookSecretEnv must match ^[A-Z][A-Z0-9_]*$', '/spec/webhookSecretEnv');
  }

  const privateKeyEnv = requireString(spec['privateKeyEnv'], '/spec/privateKeyEnv', 1, 128);
  if (!ENV_NAME_PATTERN.test(privateKeyEnv)) {
    configInvalid('spec.privateKeyEnv must match ^[A-Z][A-Z0-9_]*$', '/spec/privateKeyEnv');
  }

  const specObj: {
    appId: string;
    webhookSecretEnv: string;
    privateKeyEnv: string;
    apiBaseUrl?: string;
    listen?: GitHubAppListenConfig;
    tokenTtlSeconds?: number;
    maxPayloadBytes?: number;
    taskpackPath?: string;
    operatorAllowlist?: readonly string[];
  } = { appId, webhookSecretEnv, privateKeyEnv };

  if (spec['apiBaseUrl'] !== undefined) {
    const apiBaseUrl = requireString(spec['apiBaseUrl'], '/spec/apiBaseUrl', 1, 512);
    validateApiBaseUrl(apiBaseUrl);
    specObj.apiBaseUrl = apiBaseUrl;
  }

  if (spec['listen'] !== undefined) {
    const rawListen = requireObject(spec['listen'], '/spec/listen', ['enabled', 'host', 'port', 'webhookPath']);
    let enabled: boolean | undefined;
    if (rawListen['enabled'] !== undefined) {
      if (typeof rawListen['enabled'] !== 'boolean') {
        configInvalid('expected a boolean', '/spec/listen/enabled');
      }
      enabled = rawListen['enabled'];
    }
    const host = requireString(rawListen['host'], '/spec/listen/host', 1, 256);
    const port = requireInteger(rawListen['port'], '/spec/listen/port', 0, 65_535);
    const listenObj: { enabled?: boolean; host: string; port: number; webhookPath?: string } = {
      ...(enabled === undefined ? {} : { enabled }),
      host,
      port,
    };
    if (rawListen['webhookPath'] !== undefined) {
      const webhookPath = requireString(rawListen['webhookPath'], '/spec/listen/webhookPath', 1, 256);
      if (!webhookPath.startsWith('/')) {
        configInvalid('spec.listen.webhookPath must start with /', '/spec/listen/webhookPath');
      }
      if (webhookPath === '/healthz' || webhookPath.startsWith('/tenants/')) {
        configInvalid('spec.listen.webhookPath must not collide with reserved routes (/healthz or /tenants/*)', '/spec/listen/webhookPath');
      }
      listenObj.webhookPath = webhookPath;
    }
    specObj.listen = Object.freeze(listenObj);
  }

  if (spec['tokenTtlSeconds'] !== undefined) {
    specObj.tokenTtlSeconds = requireInteger(spec['tokenTtlSeconds'], '/spec/tokenTtlSeconds', 60, 3_600);
  }

  if (spec['maxPayloadBytes'] !== undefined) {
    specObj.maxPayloadBytes = requireInteger(spec['maxPayloadBytes'], '/spec/maxPayloadBytes', 1_024, 26_214_400);
  }

  if (spec['taskpackPath'] !== undefined) {
    try {
      specObj.taskpackPath = normalizeRelativePath(spec['taskpackPath'], '/spec/taskpackPath');
    } catch (error) {
      if (error instanceof GitHubAppError) configInvalid(error.message, '/spec/taskpackPath');
      configInvalid('invalid spec.taskpackPath', '/spec/taskpackPath');
    }
  }

  if (spec['operatorAllowlist'] !== undefined) {
    const rawAllowlist = spec['operatorAllowlist'];
    if (!Array.isArray(rawAllowlist) || rawAllowlist.length < 1 || rawAllowlist.length > 64) {
      configInvalid('spec.operatorAllowlist must be an array of 1..64 strings', '/spec/operatorAllowlist');
    }
    const logins = rawAllowlist.map((item, idx) => {
      const login = requireString(item, `/spec/operatorAllowlist/${idx}`, 1, 64);
      if (/\s/.test(login)) {
        configInvalid('operator login must not contain whitespace', `/spec/operatorAllowlist/${idx}`);
      }
      return login;
    });
    specObj.operatorAllowlist = Object.freeze(logins);
  }

  return Object.freeze({
    apiVersion: GITHUB_APP_CONFIG_API_VERSION,
    kind: 'GitHubAppConfig',
    spec: Object.freeze(specObj),
  });
}

/**
 * Load a `github-app.yaml` (`.yml` / `.json`) file using bounded `O_NOFOLLOW` non-symlink reads,
 * and optionally resolve `webhookSecret` and `privateKeyPem` from `options.env`.
 */
export async function loadGitHubAppConfig(
  configPath: string,
  options?: { readonly env?: NodeJS.ProcessEnv | undefined },
): Promise<LoadedGitHubAppConfig> {
  if (typeof configPath !== 'string' || configPath.length === 0 || configPath.split(/[\\/]/).includes('..')) {
    configInvalid('config path must be a non-empty path without .. traversal', '/');
  }
  const full = resolve(configPath);
  const ext = extname(full).toLowerCase();
  if (ext !== '.yaml' && ext !== '.yml' && ext !== '.json') {
    configInvalid('config extension must be .yaml, .yml, or .json', '/');
  }
  const bytes = await readBoundedRegularFile(full, GITHUB_APP_CONFIG_BYTES, message => configInvalid(message, '/'));
  const document = parseGitHubAppConfigDocument(bytes, ext === '.json' ? 'json' : 'yaml');
  if (options?.env !== undefined) {
    const webhookSecret = options.env[document.spec.webhookSecretEnv];
    if (typeof webhookSecret !== 'string' || webhookSecret.trim().length === 0) {
      configInvalid(`missing or empty environment variable ${document.spec.webhookSecretEnv}`, '/spec/webhookSecretEnv');
    }
    const privateKeyPem = options.env[document.spec.privateKeyEnv];
    if (typeof privateKeyPem !== 'string' || privateKeyPem.trim().length === 0) {
      configInvalid(`missing or empty environment variable ${document.spec.privateKeyEnv}`, '/spec/privateKeyEnv');
    }
    return Object.freeze({ document, webhookSecret, privateKeyPem });
  }
  return Object.freeze({ document });
}

/**
 * Load a `github-app.yaml` configuration and start the turnkey HTTP control plane when
 * `spec.listen.enabled === true`. Resident HTTP listener mode is disabled by default.
 */
export async function startConfiguredGitHubApp(
  configPath: string,
  options?: {
    readonly env?: NodeJS.ProcessEnv | undefined;
    readonly fetchImpl?: typeof fetch | undefined;
    readonly repoRoot?: string | undefined;
  },
): Promise<ControlPlaneHandle> {
  const effectiveEnv = options?.env ?? process.env;
  const loaded = await loadGitHubAppConfig(configPath, { env: effectiveEnv });
  if (loaded.document.spec.listen?.enabled !== true) {
    throw new GitHubAppError(
      'GITHUB_APP_CONFIG_INVALID',
      'resident HTTP listener is disabled by default; set spec.listen.enabled: true to run app-serve',
      '/spec/listen/enabled',
    );
  }
  const webhookSecret = loaded.webhookSecret;
  if (typeof webhookSecret !== 'string' || webhookSecret.length === 0) {
    configInvalid(`missing or empty environment variable ${loaded.document.spec.webhookSecretEnv}`, '/spec/webhookSecretEnv');
  }
  const privateKeyPem = loaded.privateKeyPem;
  if (typeof privateKeyPem !== 'string' || privateKeyPem.length === 0) {
    configInvalid(`missing or empty environment variable ${loaded.document.spec.privateKeyEnv}`, '/spec/privateKeyEnv');
  }
  const appId = Number(loaded.document.spec.appId);
  if (!Number.isSafeInteger(appId) || appId <= 0) {
    configInvalid('spec.appId must be a positive safe integer to start app-serve', '/spec/appId');
  }
  const scrubber = new SecretScrubber();
  const transport = createGitHubRestTokenTransport({
    appId,
    privateKeyPem,
    apiBaseUrl: loaded.document.spec.apiBaseUrl,
    fetchImpl: options?.fetchImpl,
  });
  const refreshMarginMs = loaded.document.spec.tokenTtlSeconds === undefined
    ? DEFAULT_TOKEN_REFRESH_MARGIN_MS
    : Math.min(DEFAULT_TOKEN_REFRESH_MARGIN_MS, Math.max(0, Math.floor((loaded.document.spec.tokenTtlSeconds * 1000) / 2)));
  const maxTtlMs = loaded.document.spec.tokenTtlSeconds !== undefined
    ? loaded.document.spec.tokenTtlSeconds * 1000
    : undefined;
  const tokenBroker = new InstallationTokenBroker({
    appId,
    privateKeyPem,
    transport,
    refreshMarginMs,
    maxTtlMs,
    scrubber,
  });

  const repoRoot = resolve(options?.repoRoot ?? dirname(resolve(configPath)));
  let taskpackId: string | undefined;
  let commentPrefixes: readonly string[] | undefined;
  let commentCommands: readonly TaskpackCommentCommand[] | undefined;

  if (loaded.document.spec.taskpackPath !== undefined) {
    let manifest;
    try {
      manifest = await loadDeclarativeTaskpack({
        manifestPath: join(repoRoot, loaded.document.spec.taskpackPath),
        repositoryRoot: repoRoot,
      });
    } catch (error) {
      throw new GitHubAppError(
        'GITHUB_APP_CONFIG_INVALID',
        error instanceof Error ? error.message : 'invalid taskpackPath',
        '/spec/taskpackPath',
      );
    }
    taskpackId = manifest.metadata.name;
    commentPrefixes = manifest.spec.triggers.commentPrefixes;
    commentCommands = manifest.spec.triggers.commentCommands;
  }

  const operatorAllowlist = loaded.document.spec.operatorAllowlist
    ?? effectiveEnv['LOOPWRIGHT_OPERATOR_ALLOWLIST']?.split(',').map(s => s.trim()).filter(s => s.length > 0);

  return startGitHubAppControlPlane({
    host: loaded.document.spec.listen.host,
    port: loaded.document.spec.listen.port,
    webhookPath: loaded.document.spec.listen.webhookPath,
    maxPayloadBytes: loaded.document.spec.maxPayloadBytes,
    webhookSecret,
    tokenBroker,
    scrubber,
    taskpackId,
    commentPrefixes,
    commentCommands,
    operatorAllowlist,
  });
}
