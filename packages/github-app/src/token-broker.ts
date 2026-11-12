import { createPrivateKey, createSign, type KeyObject } from 'node:crypto';
import {
  DEFAULT_TOKEN_REFRESH_MARGIN_MS, GitHubAppError, INSTALLATION_TOKEN_TTL_LIMIT_MS,
  type CreateGitHubAppJwtInput, type InstallationTokenPermissions, type InstallationTokenProfile,
  type InstallationTokenGrant, type InstallationTokenRequest, type InstallationTokenTransport, type TenantIdentity,
} from './types.js';

const GENERIC_SECRET_PATTERNS: readonly RegExp[] = Object.freeze([
  /ghs_[A-Za-z0-9]{20,}/g,
  /ghu_[A-Za-z0-9]{20,}/g,
  /github_pat_[A-Za-z0-9_]{20,}/g,
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/g,
]);
const MIN_FORM_LENGTH = 8;

function parsePrivateKey(privateKeyPem: string): KeyObject {
  try {
    return createPrivateKey(privateKeyPem);
  } catch {
    throw new GitHubAppError('TOKEN_BROKER_CONFIG_INVALID', 'privateKeyPem is not a parseable PEM private key');
  }
}

/**
 * Sign a GitHub App JWT (`alg: 'RS256'`, `iat: nowSeconds - 60`, `exp: nowSeconds + 540`) with
 * `node:crypto`; invalid PEM keys or non-positive app ids are refused.
 */
export function createGitHubAppJwt({ appId, privateKeyPem, nowSeconds }: CreateGitHubAppJwtInput): string {
  if (typeof appId !== 'number' || !Number.isSafeInteger(appId) || appId <= 0) {
    throw new GitHubAppError('TOKEN_BROKER_CONFIG_INVALID', 'appId must be a positive integer');
  }
  const key = parsePrivateKey(privateKeyPem);
  const encode = (value: object): string => Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
  const header = encode({ alg: 'RS256', typ: 'JWT' });
  const payload = encode({ iss: String(appId), iat: nowSeconds - 60, exp: nowSeconds + 540 });
  const signer = createSign('RSA-SHA256');
  signer.update(`${header}.${payload}`);
  const signature = signer.sign(key).toString('base64url');
  return `${header}.${payload}.${signature}`;
}

/** Fixed least-privilege permission profiles, keyed by the two supported broker profiles. */
export const INSTALLATION_TOKEN_PROFILES: Readonly<Record<InstallationTokenProfile, InstallationTokenPermissions>> = Object.freeze({
  read_only: Object.freeze({ contents: 'read', metadata: 'read' }),
  publish_pull_request: Object.freeze({ contents: 'write', pull_requests: 'write', metadata: 'read' }),
});

/**
 * Fail-closed scope guard for a raw installation-token request: exactly one positive repository id and no
 * permission outside the two fixed profiles. Wildcard, multi-repository, or broad requests are refused.
 */
export function assertTokenScope(request: InstallationTokenRequest): void {
  if (!Array.isArray(request.repositoryIds) || request.repositoryIds.length !== 1
    || typeof request.repositoryIds[0] !== 'number' || !Number.isSafeInteger(request.repositoryIds[0]) || request.repositoryIds[0] <= 0) {
    throw new GitHubAppError('TOKEN_SCOPE_VIOLATION', 'installation tokens must bind exactly one positive repository id');
  }
  const allowed: Readonly<Record<string, readonly string[]>> = {
    contents: ['read', 'write'], metadata: ['read'], pull_requests: ['write', 'read'],
  };
  for (const [permission, value] of Object.entries(request.permissions)) {
    const accepted = allowed[permission];
    if (accepted === undefined) {
      throw new GitHubAppError('TOKEN_SCOPE_VIOLATION', `permission "${permission}" exceeds the broker profiles`);
    }
    if (!(accepted as readonly string[]).includes(String(value))) {
      throw new GitHubAppError('TOKEN_SCOPE_VIOLATION', `permission "${permission}" value "${String(value)}" exceeds the broker profiles`);
    }
  }
  if (request.permissions['metadata'] !== 'read') {
    throw new GitHubAppError('TOKEN_SCOPE_VIOLATION', 'metadata permission must stay read-only');
  }
  if (request.permissions['contents'] === 'write' && request.permissions['pull_requests'] !== 'write') {
    throw new GitHubAppError('TOKEN_SCOPE_VIOLATION', 'contents write is only valid with the publish_pull_request profile');
  }
}

/** Tracks credential material in raw, JSON-escaped, URL-encoded, and base64 forms and scrubs every form. */
export class SecretScrubber {
  readonly #forms = new Set<string>();

  register(secret: string): void {
    if (typeof secret !== 'string' || secret.length === 0) return;
    const forms = [
      secret,
      JSON.stringify(secret).slice(1, -1),
      encodeURIComponent(secret),
      Buffer.from(secret, 'utf8').toString('base64'),
    ];
    for (const form of forms) {
      if (form.length >= MIN_FORM_LENGTH) this.#forms.add(form);
    }
  }

  /** Replace every tracked credential form and generic token pattern with `[scrubbed]`. */
  scrub(text: string): string {
    let output = text;
    for (const form of this.#forms) {
      output = output.split(form).join('[scrubbed]');
    }
    for (const pattern of GENERIC_SECRET_PATTERNS) {
      output = output.replace(new RegExp(pattern.source, 'g'), '[scrubbed]');
    }
    return output;
  }

  /** Throw `TOKEN_SECRET_LEAK_DETECTED` when any tracked form or generic pattern appears in a value. */
  assertClean(value: string | Uint8Array | object, path = '/artifact'): void {
    const serialized = value instanceof Uint8Array
      ? Buffer.from(value).toString('utf8')
      : typeof value === 'string' ? value : JSON.stringify(value);
    for (const form of this.#forms) {
      if (form.length >= MIN_FORM_LENGTH && serialized.includes(form)) {
        throw new GitHubAppError('TOKEN_SECRET_LEAK_DETECTED', `artifact contains tracked credential material at ${path}`);
      }
    }
    for (const pattern of GENERIC_SECRET_PATTERNS) {
      if (new RegExp(pattern.source).test(serialized)) {
        throw new GitHubAppError('TOKEN_SECRET_LEAK_DETECTED', `artifact contains a credential-shaped token at ${path}`);
      }
    }
  }
}

export interface InstallationTokenBrokerOptions {
  readonly appId: number;
  readonly privateKeyPem: string;
  readonly transport: InstallationTokenTransport;
  readonly refreshMarginMs?: number;
  readonly maxTtlMs?: number | undefined;
  readonly nowSeconds?: () => number;
  readonly scrubber?: SecretScrubber;
}

interface CachedToken {
  readonly token: string;
  readonly expiresAtMs: number;
  readonly profile: InstallationTokenProfile;
  readonly repositoryId: number;
}

/** Short-lived, single-repository installation token broker with TTL rotation and secret scrubbing. */
export class InstallationTokenBroker {
  readonly #appId: number;
  readonly #jwtPrivateKey: KeyObject;
  readonly #transport: InstallationTokenTransport;
  readonly #refreshMarginMs: number;
  readonly #maxTtlMs: number | undefined;
  readonly #nowSeconds: () => number;
  readonly #scrubber: SecretScrubber;
  readonly #cache = new Map<string, CachedToken>();

  constructor(options: InstallationTokenBrokerOptions) {
    if (typeof options.appId !== 'number' || !Number.isSafeInteger(options.appId) || options.appId <= 0) {
      throw new GitHubAppError('TOKEN_BROKER_CONFIG_INVALID', 'appId must be a positive integer');
    }
    this.#appId = options.appId;
    this.#jwtPrivateKey = parsePrivateKey(options.privateKeyPem);
    this.#transport = options.transport;
    this.#refreshMarginMs = options.refreshMarginMs ?? DEFAULT_TOKEN_REFRESH_MARGIN_MS;
    if (!Number.isSafeInteger(this.#refreshMarginMs) || this.#refreshMarginMs < 0 || this.#refreshMarginMs > INSTALLATION_TOKEN_TTL_LIMIT_MS) {
      throw new GitHubAppError('TOKEN_BROKER_CONFIG_INVALID', `refreshMarginMs must be within 0..${INSTALLATION_TOKEN_TTL_LIMIT_MS}`);
    }
    if (options.maxTtlMs !== undefined) {
      if (typeof options.maxTtlMs !== 'number' || !Number.isSafeInteger(options.maxTtlMs) || options.maxTtlMs < 1_000 || options.maxTtlMs > INSTALLATION_TOKEN_TTL_LIMIT_MS) {
        throw new GitHubAppError('TOKEN_BROKER_CONFIG_INVALID', `maxTtlMs must be within 1000..${INSTALLATION_TOKEN_TTL_LIMIT_MS}`);
      }
      this.#maxTtlMs = options.maxTtlMs;
    }
    this.#nowSeconds = options.nowSeconds ?? (() => Math.floor(Date.now() / 1000));
    this.#scrubber = options.scrubber ?? new SecretScrubber();
    this.#scrubber.register(options.privateKeyPem.split('\n')[0] ?? '');
    this.#scrubber.register(options.privateKeyPem);
  }

  get scrubber(): SecretScrubber {
    return this.#scrubber;
  }

  async mint(tenant: TenantIdentity, profile: InstallationTokenProfile): Promise<InstallationTokenGrant> {
    if (profile !== 'read_only' && profile !== 'publish_pull_request') {
      throw new GitHubAppError('TOKEN_SCOPE_VIOLATION', `unsupported token profile ${String(profile)}`);
    }
    if (typeof tenant.repositoryId !== 'number' || !Number.isSafeInteger(tenant.repositoryId) || tenant.repositoryId <= 0
      || typeof tenant.installationId !== 'number' || !Number.isSafeInteger(tenant.installationId) || tenant.installationId <= 0) {
      throw new GitHubAppError('TOKEN_SCOPE_VIOLATION', 'mint requires a tenant with positive installation and repository ids');
    }
    const nowMs = this.#nowSeconds() * 1000;
    const cacheKey = `${tenant.installationId}:${tenant.repositoryId}:${profile}`;
    const cached = this.#cache.get(cacheKey);
    if (cached !== undefined && cached.expiresAtMs - nowMs > this.#refreshMarginMs) {
      return { token: cached.token, expiresAtMs: cached.expiresAtMs, profile, installationId: tenant.installationId, repositoryId: tenant.repositoryId };
    }
    const permissions: InstallationTokenPermissions = INSTALLATION_TOKEN_PROFILES[profile];
    const request: InstallationTokenRequest = {
      installationId: tenant.installationId,
      repositoryIds: [tenant.repositoryId],
      permissions: { ...permissions },
    };
    assertTokenScope(request);
    const response = await this.#transport.createInstallationToken(request);
    if (typeof response.token !== 'string' || response.token.length === 0) {
      throw new GitHubAppError('TOKEN_SCOPE_VIOLATION', 'transport returned an empty installation token');
    }
    const ttlMs = response.expiresAtMs - nowMs;
    if (!Number.isSafeInteger(response.expiresAtMs) || ttlMs <= 0 || ttlMs > INSTALLATION_TOKEN_TTL_LIMIT_MS) {
      throw new GitHubAppError('TOKEN_TTL_EXCEEDED', `installation token TTL ${ttlMs}ms must be positive and at most ${INSTALLATION_TOKEN_TTL_LIMIT_MS}ms`);
    }
    const effectiveExpiresAtMs = this.#maxTtlMs === undefined
      ? response.expiresAtMs
      : Math.min(response.expiresAtMs, nowMs + this.#maxTtlMs);
    this.#scrubber.register(response.token);
    this.#cache.set(cacheKey, { token: response.token, expiresAtMs: effectiveExpiresAtMs, profile, repositoryId: tenant.repositoryId });
    return { token: response.token, expiresAtMs: effectiveExpiresAtMs, profile, installationId: tenant.installationId, repositoryId: tenant.repositoryId };
  }

  revokeInstallationTokens(installationId: number): number {
    let evicted = 0;
    for (const key of [...this.#cache.keys()]) {
      if (key.startsWith(`${installationId}:`)) {
        this.#cache.delete(key);
        evicted += 1;
      }
    }
    return evicted;
  }

  /** Evict cached tokens for the given repositories of one installation; siblings stay cached. */
  revokeRepositoryTokens(installationId: number, repositoryIds: readonly number[]): number {
    const removed = new Set(repositoryIds);
    let evicted = 0;
    for (const key of [...this.#cache.keys()]) {
      const [cachedInstallation, cachedRepository] = key.split(':');
      if (cachedInstallation === String(installationId) && cachedRepository !== undefined && removed.has(Number(cachedRepository))) {
        this.#cache.delete(key);
        evicted += 1;
      }
    }
    return evicted;
  }

  /** Sign an App JWT bound to this broker's credentials (offline tests verify it with the public key). */
  createAppJwt(nowSeconds = this.#nowSeconds()): string {
    const signer = createSign('RSA-SHA256');
    const encode = (value: object): string => Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
    const header = encode({ alg: 'RS256', typ: 'JWT' });
    const payload = encode({ iss: String(this.#appId), iat: nowSeconds - 60, exp: nowSeconds + 540 });
    signer.update(`${header}.${payload}`);
    return `${header}.${payload}.${signer.sign(this.#jwtPrivateKey).toString('base64url')}`;
  }

  scrub(text: string): string {
    return this.#scrubber.scrub(text);
  }

  assertCleanArtifact(value: string | Uint8Array | object, path?: string): void {
    this.#scrubber.assertClean(value, path);
  }
}

/** Stand-alone leak check against generic credential patterns plus an optional scrubber's tracked forms. */
export function assertCleanArtifact(value: string | Uint8Array | object, scrubber?: SecretScrubber, path = '/artifact'): void {
  if (scrubber === undefined) {
    new SecretScrubber().assertClean(value, path);
    return;
  }
  scrubber.assertClean(value, path);
}

export interface GitHubRestTokenTransportOptions {
  readonly appId: number;
  readonly privateKeyPem: string;
  readonly apiBaseUrl?: string | undefined;
  readonly fetchImpl?: typeof fetch | undefined;
  readonly nowSeconds?: (() => number) | undefined;
}

/**
 * Create a GitHub REST API `InstallationTokenTransport` that signs an RS256 App JWT and calls
 * `POST ${baseUrl}/app/installations/${installationId}/access_tokens`.
 */
export function createGitHubRestTokenTransport(options: GitHubRestTokenTransportOptions): InstallationTokenTransport {
  if (typeof options.appId !== 'number' || !Number.isSafeInteger(options.appId) || options.appId <= 0) {
    throw new GitHubAppError('TOKEN_BROKER_CONFIG_INVALID', 'appId must be a positive integer');
  }
  parsePrivateKey(options.privateKeyPem);
  const rawBaseUrl = options.apiBaseUrl ?? 'https://api.github.com';
  let parsedBaseUrl: URL;
  try {
    parsedBaseUrl = new URL(rawBaseUrl);
  } catch {
    throw new GitHubAppError('TOKEN_BROKER_CONFIG_INVALID', 'apiBaseUrl must be a valid URL');
  }
  const isLoopback = parsedBaseUrl.hostname === '127.0.0.1'
    || parsedBaseUrl.hostname === 'localhost'
    || parsedBaseUrl.hostname === '[::1]'
    || parsedBaseUrl.hostname === '::1';
  if (parsedBaseUrl.protocol !== 'https:' && !(parsedBaseUrl.protocol === 'http:' && isLoopback)) {
    throw new GitHubAppError('TOKEN_BROKER_CONFIG_INVALID', 'apiBaseUrl must use https:// (or loopback http:// for local tests)');
  }
  const baseUrl = rawBaseUrl.replace(/\/+$/, '');
  const fetchFn = options.fetchImpl ?? globalThis.fetch;
  const nowSeconds = options.nowSeconds ?? (() => Math.floor(Date.now() / 1000));

  return {
    async createInstallationToken(request: InstallationTokenRequest) {
      const jwt = createGitHubAppJwt({
        appId: options.appId,
        privateKeyPem: options.privateKeyPem,
        nowSeconds: nowSeconds(),
      });
      let response: Response;
      try {
        response = await fetchFn(`${baseUrl}/app/installations/${request.installationId}/access_tokens`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${jwt}`,
            Accept: 'application/vnd.github+json',
            'X-GitHub-Api-Version': '2022-11-28',
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            repository_ids: [...request.repositoryIds],
            permissions: request.permissions,
          }),
          signal: AbortSignal.timeout(10_000),
        });
      } catch {
        throw new GitHubAppError('TOKEN_BROKER_CONFIG_INVALID', `failed to reach GitHub installation token endpoint for installation ${request.installationId}`);
      }
      if (!response.ok) {
        throw new GitHubAppError('TOKEN_BROKER_CONFIG_INVALID', `GitHub installation token endpoint returned HTTP ${response.status} for installation ${request.installationId}`);
      }
      let parsed: unknown;
      try {
        parsed = await response.json();
      } catch {
        throw new GitHubAppError('TOKEN_BROKER_CONFIG_INVALID', 'GitHub installation token response was not valid JSON');
      }
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new GitHubAppError('TOKEN_BROKER_CONFIG_INVALID', 'GitHub installation token response must be a JSON object');
      }
      const record = parsed as Record<string, unknown>;
      const token = record['token'];
      const expiresAtRaw = record['expires_at'];
      if (typeof token !== 'string' || token.length === 0 || typeof expiresAtRaw !== 'string' || expiresAtRaw.length === 0) {
        throw new GitHubAppError('TOKEN_BROKER_CONFIG_INVALID', 'GitHub installation token response missing token or expires_at');
      }
      const expiresAtMs = Date.parse(expiresAtRaw);
      if (!Number.isSafeInteger(expiresAtMs) || expiresAtMs <= 0) {
        throw new GitHubAppError('TOKEN_BROKER_CONFIG_INVALID', 'GitHub installation token response contains invalid expires_at timestamp');
      }
      return { token, expiresAtMs };
    },
  };
}
