import assert from 'node:assert/strict';
import { generateKeyPairSync, verify as verifySignature } from 'node:crypto';
import { mkdtemp, readdir, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import { createGitHubAppJwt, INSTALLATION_TOKEN_PROFILES, InstallationTokenBroker, assertTokenScope, assertCleanArtifact, SecretScrubber } from '../src/token-broker.js';
import { qualifyDeploymentHostProfile, validateMcpAuthConfiguration } from '../src/qualification.js';
import { GitHubAppError, type ClockBasis, type ClockSample, type InstallationTokenRequest, type TenantIdentity } from '../src/types.js';

const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const PRIVATE_KEY_PEM = privateKey.export({ type: 'pkcs1', format: 'pem' }).toString();
const PUBLIC_KEY_PEM = publicKey.export({ type: 'spki', format: 'pem' }).toString();
const NOW = 1_700_000_000;
const TENANT: TenantIdentity = { installationId: 42, repositoryId: 7, repositoryFullName: 'octocat/target', taskpackId: 'docs-sync' };

const savedEnv: Record<string, string | undefined> = {};
after(() => {
  for (const [name, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

function decodeSegment(segment: string): Record<string, unknown> {
  return JSON.parse(Buffer.from(segment, 'base64url').toString('utf8')) as Record<string, unknown>;
}

function basisFrom(created: ClockSample): ClockBasis {
  return { clockEpoch: 'test', created: { ...created }, taskDeadlineMonotonicMs: (BigInt(created.monotonicMs) + 1_000_000n).toString() };
}

describe('createGitHubAppJwt (AC-4)', () => {
  it('signs an RS256 JWT with iss/iat/exp claims verifiable against the public key', () => {
    const jwt = createGitHubAppJwt({ appId: 1234, privateKeyPem: PRIVATE_KEY_PEM, nowSeconds: NOW });
    const [headerSegment, payloadSegment, signatureSegment] = jwt.split('.');
    assert.deepEqual(decodeSegment(headerSegment!), { alg: 'RS256', typ: 'JWT' });
    const payload = decodeSegment(payloadSegment!);
    assert.deepEqual(payload, { iss: '1234', iat: NOW - 60, exp: NOW + 540 });
    assert.equal(verifySignature('RSA-SHA256', Buffer.from(`${headerSegment}.${payloadSegment}`), PUBLIC_KEY_PEM, Buffer.from(signatureSegment!, 'base64url')), true);
  });

  it('produces signatures a tampered payload invalidates', () => {
    const jwt = createGitHubAppJwt({ appId: 1234, privateKeyPem: PRIVATE_KEY_PEM, nowSeconds: NOW });
    const [header, payload, signature] = jwt.split('.');
    const forged = Buffer.from(JSON.stringify({ iss: '1234', iat: NOW - 60, exp: NOW + 999_999 })).toString('base64url');
    assert.equal(verifySignature('RSA-SHA256', Buffer.from(`${header}.${payload}`), PUBLIC_KEY_PEM, Buffer.from(signature!, 'base64url')), true);
    assert.equal(verifySignature('RSA-SHA256', Buffer.from(`${header}.${forged}`), PUBLIC_KEY_PEM, Buffer.from(signature!, 'base64url')), false);
  });

  it('refuses invalid PEM keys and non-positive app ids', () => {
    assert.throws(() => createGitHubAppJwt({ appId: 1234, privateKeyPem: 'not-a-pem', nowSeconds: NOW }),
      (error: GitHubAppError) => error.code === 'TOKEN_BROKER_CONFIG_INVALID');
    assert.throws(() => createGitHubAppJwt({ appId: 0, privateKeyPem: PRIVATE_KEY_PEM, nowSeconds: NOW }),
      (error: GitHubAppError) => error.code === 'TOKEN_BROKER_CONFIG_INVALID');
    assert.throws(() => createGitHubAppJwt({ appId: -5, privateKeyPem: PRIVATE_KEY_PEM, nowSeconds: NOW }),
      (error: GitHubAppError) => error.code === 'TOKEN_BROKER_CONFIG_INVALID');
  });
});

describe('InstallationTokenBroker (AC-4)', () => {
  it('binds exactly one repository and the read_only profile on mint', async () => {
    const requests: InstallationTokenRequest[] = [];
    const broker = new InstallationTokenBroker({
      appId: 1234, privateKeyPem: PRIVATE_KEY_PEM, nowSeconds: () => NOW,
      transport: { createInstallationToken: async request => {
        requests.push(request);
        return { token: 'ghs_' + 'a'.repeat(24), expiresAtMs: (NOW + 3_600) * 1000 };
      } },
    });
    const grant = await broker.mint(TENANT, 'read_only');
    assert.equal(grant.profile, 'read_only');
    assert.deepEqual(requests[0]!.repositoryIds, [TENANT.repositoryId]);
    assert.deepEqual(requests[0]!.permissions, { contents: 'read', metadata: 'read' });
    assert.equal(Object.hasOwn(requests[0]!.permissions, 'pull_requests'), false);
  });

  it('maps the publish_pull_request profile to pull-request write permissions', async () => {
    const requests: InstallationTokenRequest[] = [];
    const broker = new InstallationTokenBroker({
      appId: 1234, privateKeyPem: PRIVATE_KEY_PEM, nowSeconds: () => NOW,
      transport: { createInstallationToken: async request => {
        requests.push(request);
        return { token: 'ghs_' + 'b'.repeat(24), expiresAtMs: (NOW + 3_600) * 1000 };
      } },
    });
    await broker.mint(TENANT, 'publish_pull_request');
    assert.deepEqual(requests[0]!.permissions, INSTALLATION_TOKEN_PROFILES.publish_pull_request);
    assert.deepEqual(requests[0]!.permissions, { contents: 'write', pull_requests: 'write', metadata: 'read' });
  });

  it('caches grants and refreshes within the margin', async () => {
    let calls = 0;
    const broker = new InstallationTokenBroker({
      appId: 1234, privateKeyPem: PRIVATE_KEY_PEM, nowSeconds: () => NOW,
      transport: { createInstallationToken: async () => {
        calls += 1;
        return { token: `ghs_${'c'.repeat(24)}`, expiresAtMs: NOW * 1000 + 3600_000 };
      } },
    });
    await broker.mint(TENANT, 'read_only');
    await broker.mint(TENANT, 'read_only');
    assert.equal(calls, 1, 'a valid cached grant must skip the transport');
    await broker.mint(TENANT, 'publish_pull_request');
    assert.equal(calls, 2, 'a different profile must mint separately');
    const constrained = new InstallationTokenBroker({
      appId: 1234, privateKeyPem: PRIVATE_KEY_PEM, nowSeconds: () => NOW,
      transport: { createInstallationToken: async () => ({ token: 'ghs_' + 'd'.repeat(24), expiresAtMs: NOW * 1000 + 100_000 }) },
    });
    await constrained.mint(TENANT, 'read_only');
    await constrained.mint(TENANT, 'read_only');
  });

  it('refuses TTLs above 3600 seconds with TOKEN_TTL_EXCEEDED', async () => {
    const broker = new InstallationTokenBroker({
      appId: 1234, privateKeyPem: PRIVATE_KEY_PEM, nowSeconds: () => NOW,
      transport: { createInstallationToken: async () => ({ token: 'ghs_' + 'e'.repeat(24), expiresAtMs: (NOW + 7_200) * 1000 }) },
    });
    await assert.rejects(broker.mint(TENANT, 'read_only'), (error: GitHubAppError) => error.code === 'TOKEN_TTL_EXCEEDED');
  });

  it('evicts cached tokens on revokeInstallationTokens', async () => {
    let calls = 0;
    const broker = new InstallationTokenBroker({
      appId: 1234, privateKeyPem: PRIVATE_KEY_PEM, nowSeconds: () => NOW,
      transport: { createInstallationToken: async () => {
        calls += 1;
        return { token: `ghs_${calls.toString().padStart(24, '0')}`, expiresAtMs: (NOW + 3_600) * 1000 };
      } },
    });
    await broker.mint(TENANT, 'read_only');
    assert.equal(broker.revokeInstallationTokens(42), 1);
    await broker.mint(TENANT, 'read_only');
    assert.equal(calls, 2);
    assert.equal(broker.revokeInstallationTokens(43), 0);
  });

  it('fails closed on wildcard, multi-repository, and over-broad permission requests', () => {
    assert.throws(() => assertTokenScope({ installationId: 1, repositoryIds: [7, 8], permissions: { contents: 'read', metadata: 'read' } }),
      (error: GitHubAppError) => error.code === 'TOKEN_SCOPE_VIOLATION');
    assert.throws(() => assertTokenScope({ installationId: 1, repositoryIds: [], permissions: { contents: 'read', metadata: 'read' } }),
      (error: GitHubAppError) => error.code === 'TOKEN_SCOPE_VIOLATION');
    assert.throws(() => assertTokenScope({ installationId: 1, repositoryIds: [7], permissions: { contents: 'read', metadata: 'read', administration: 'write' } as unknown as InstallationTokenRequest['permissions'] }),
      (error: GitHubAppError) => error.code === 'TOKEN_SCOPE_VIOLATION');
    assert.throws(() => assertTokenScope({ installationId: 1, repositoryIds: [7], permissions: { contents: 'read', metadata: 'write' } }),
      (error: GitHubAppError) => error.code === 'TOKEN_SCOPE_VIOLATION');
    assert.throws(() => assertTokenScope({ installationId: 1, repositoryIds: [7], permissions: { contents: 'write', metadata: 'read' } }),
      (error: GitHubAppError) => error.code === 'TOKEN_SCOPE_VIOLATION');
  });
});

describe('secret scrubbing and artifact hygiene (AC-4)', () => {
  const token = 'ghs_' + 'f'.repeat(24);

  it('scrubs raw, JSON-escaped, URL-encoded, and base64 forms', () => {
    const scrubber = new SecretScrubber();
    scrubber.register(token);
    const contaminated = JSON.stringify({ nested: { token } });
    const scrubbed = scrubber.scrub(contaminated);
    assert.equal(scrubbed.includes(token), false);
    const encodedForm = encodeURIComponent(token);
    const base64Form = Buffer.from(token).toString('base64');
    const multiForm = `${encodedForm}|${base64Form}|${JSON.stringify(token).slice(1, -1)}`;
    const scrubbedMulti = scrubber.scrub(multiForm);
    assert.equal(scrubbedMulti.includes(encodedForm), false);
    assert.equal(scrubbedMulti.includes(base64Form), false);
  });

  it('throws TOKEN_SECRET_LEAK_DETECTED on contaminated artifacts and passes clean ones', () => {
    const scrubber = new SecretScrubber();
    scrubber.register(token);
    assert.throws(() => scrubber.assertClean({ contract: { note: token } }), (error: GitHubAppError) => error.code === 'TOKEN_SECRET_LEAK_DETECTED');
    assert.throws(() => scrubber.assertClean(Buffer.from(`run log mentions ${token}`), '/run-log'), (error: GitHubAppError) => error.code === 'TOKEN_SECRET_LEAK_DETECTED');
    assert.doesNotThrow(() => scrubber.assertClean({ contract: { note: 'clean value' } }));
    assert.doesNotThrow(() => assertCleanArtifact({ any: 'document' }));
    assert.throws(() => assertCleanArtifact(' leaked ghu_' + '0123456789abcdefghij'), (error: GitHubAppError) => error.code === 'TOKEN_SECRET_LEAK_DETECTED');
    assert.throws(() => assertCleanArtifact('pat github_pat_0123456789abcdefghij'), (error: GitHubAppError) => error.code === 'TOKEN_SECRET_LEAK_DETECTED');
    assert.throws(() => assertCleanArtifact('-----BEGIN RSA PRIVATE KEY-----'), (error: GitHubAppError) => error.code === 'TOKEN_SECRET_LEAK_DETECTED');
  });

  it('catches private key material in raw and JSON-escaped forms via the broker', async () => {
    const broker = new InstallationTokenBroker({
      appId: 1234, privateKeyPem: PRIVATE_KEY_PEM, nowSeconds: () => NOW,
      transport: { createInstallationToken: async () => ({ token, expiresAtMs: (NOW + 3_600) * 1000 }) },
    });
    assert.throws(() => broker.assertCleanArtifact({ log: PRIVATE_KEY_PEM.split('\n')[0] }), (error: GitHubAppError) => error.code === 'TOKEN_SECRET_LEAK_DETECTED');
    const escapedKey = JSON.stringify(PRIVATE_KEY_PEM).slice(1, -1).slice(0, 120);
    assert.throws(() => broker.assertCleanArtifact(`config: "${escapedKey}"`), (error: GitHubAppError) => error.code === 'TOKEN_SECRET_LEAK_DETECTED');
    const grant = await broker.mint(TENANT, 'read_only');
    assert.throws(() => broker.assertCleanArtifact({ token: grant.token }), (error: GitHubAppError) => error.code === 'TOKEN_SECRET_LEAK_DETECTED');
    assert.equal(broker.scrub(`prefix ${grant.token} suffix`).includes(grant.token), false);
  });
});

const QUALIFIED_BASIS = basisFrom({ wallMs: 1_000_000, monotonicMs: '1000' });

describe('qualifyDeploymentHostProfile (AC-5)', () => {
  const qualifiedBase = {
    platform: 'darwin', arch: 'arm64', nodeVersion: process.version, filesystemType: 'apfs',
    storageProfile: 'durable' as const,
    clockBasis: QUALIFIED_BASIS,
    previousClockSample: { wallMs: 1_000_000, monotonicMs: '1000' } as ClockSample,
    currentClockSample: { wallMs: 1_001_000, monotonicMs: '1050' } as ClockSample,
    hasVerifiedCheckpointLedger: true, autoResumeOnHostLossRequested: false,
  };

  it('accepts the qualified allowlist platforms and 26.x runtimes', async () => {
    for (const [platform, arch] of [['darwin', 'arm64'], ['linux', 'arm64'], ['linux', 'x64']] as const) {
      const result = await qualifyDeploymentHostProfile({ ...qualifiedBase, platform, arch });
      assert.deepEqual(result, { ok: true }, `${platform}/${arch} must qualify`);
    }
  });

  it('rejects non-allowlisted platforms, unqualified Node, and network filesystems', async () => {
    for (const overrides of [
      { platform: 'win32', arch: 'x64' },
      { platform: 'darwin', arch: 'x64' },
      { platform: 'sunos', arch: 'arm64' },
      { nodeVersion: 'v25.4.0' },
      { nodeVersion: '18.20.1' },
      { filesystemType: 'nfs' },
      { filesystemType: 'smb' },
      { filesystemType: 'cifs' },
      { filesystemType: 'fuse' },
      { filesystemType: 'sshfs' },
      { filesystemType: 'webdav' },
      { filesystemType: 'tmpfs-ephemeral-unverified' },
    ]) {
      const result = await qualifyDeploymentHostProfile({ ...qualifiedBase, ...overrides });
      assert.equal(result.ok, false, JSON.stringify(overrides));
      assert.equal(result.ok ? '' : result.code, 'HOST_PROFILE_UNQUALIFIED');
    }
  });

  it('rejects drifting or backward clocks with HOST_CLOCK_UNTRUSTED', async () => {
    const drifted = await qualifyDeploymentHostProfile({
      ...qualifiedBase,
      previousClockSample: { wallMs: 1_000_000, monotonicMs: '1000' },
      currentClockSample: { wallMs: 1_006_000, monotonicMs: '1050' },
    });
    assert.equal(drifted.ok ? '' : drifted.code, 'HOST_CLOCK_UNTRUSTED');
    const backward = await qualifyDeploymentHostProfile({
      ...qualifiedBase,
      currentClockSample: { wallMs: 999_000, monotonicMs: '900' },
    });
    assert.equal(backward.ok ? '' : backward.code, 'HOST_CLOCK_UNTRUSTED');
  });

  it('refuses actions-basic budget resets and unverified-ledger resumes with STORAGE_PROFILE_INSUFFICIENT', async () => {
    const actionsBasic = await qualifyDeploymentHostProfile({ ...qualifiedBase, storageProfile: 'actions-basic', autoResumeOnHostLossRequested: true });
    assert.equal(actionsBasic.ok, false);
    if (!actionsBasic.ok) {
      assert.equal(actionsBasic.code, 'STORAGE_PROFILE_INSUFFICIENT');
      assert.equal(actionsBasic.recommendedRunStatus, 'reconcile_required');
    }
    const unverifiedLedger = await qualifyDeploymentHostProfile({
      ...qualifiedBase, storageProfile: 'durable', hasVerifiedCheckpointLedger: false, autoResumeOnHostLossRequested: true,
    });
    assert.equal(unverifiedLedger.ok ? '' : unverifiedLedger.code, 'STORAGE_PROFILE_INSUFFICIENT');
    const durableVerified = await qualifyDeploymentHostProfile({
      ...qualifiedBase, storageProfile: 'durable', hasVerifiedCheckpointLedger: true, autoResumeOnHostLossRequested: true,
    });
    assert.deepEqual(durableVerified, { ok: true });
  });

  it('runs an exclusive, fsynced, atomically renamed probe and removes it before returning', async () => {
    const probeDirectory = await mkdtemp(join(await realpath(tmpdir()), 'loopwright-probe-'));
    try {
      const result = await qualifyDeploymentHostProfile({ ...qualifiedBase, probeDirectory });
      assert.deepEqual(result, { ok: true });
      assert.deepEqual(await readdir(probeDirectory), [], 'probe must leave no residue');
    } finally {
      await rm(probeDirectory, { recursive: true, force: true });
    }
  });
});

describe('validateMcpAuthConfiguration (AC-5)', () => {
  it('refuses OAuth and interactive declarations with MCP_OAUTH_UNSUPPORTED', () => {
    for (const type of ['oauth', 'oauth2', 'browser', 'device_code', 'interactive']) {
      const result = validateMcpAuthConfiguration({ servers: [{ serverId: 'docs', auth: { type } }] });
      assert.equal(result.ok ? '' : result.code, 'MCP_OAUTH_UNSUPPORTED', type);
    }
  });

  it('refuses runtime authentication challenges with MCP_AUTHENTICATION_REQUIRED', () => {
    for (const wwwAuthenticate of ['Bearer realm="x"', 'OAuth realm="x"', 'authorization_uri="https://example.test"']) {
      const result = validateMcpAuthConfiguration({ servers: [], transportChallenge: { status: 401, wwwAuthenticate } });
      assert.equal(result.ok ? '' : result.code, 'MCP_AUTHENTICATION_REQUIRED');
      const forbidden = validateMcpAuthConfiguration({ servers: [], transportChallenge: { status: 403, wwwAuthenticate } });
      assert.equal(forbidden.ok ? '' : forbidden.code, 'MCP_AUTHENTICATION_REQUIRED');
    }
  });

  it('accepts bearer-token configs and non-challenge responses without side effects', () => {
    assert.deepEqual(validateMcpAuthConfiguration({
      servers: [{ serverId: 'workspace', auth: { type: 'bearer' } }, { serverId: 'none' }],
      transportChallenge: { status: 200, wwwAuthenticate: null },
    }), { ok: true });
    assert.deepEqual(validateMcpAuthConfiguration({
      servers: [], transportChallenge: { status: 401, wwwAuthenticate: 'Basic realm="x"' },
    }), { ok: true });
  });
});
