import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmod, lstat, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { GitHubAppError, type TaskpackV2Manifest } from '../src/types.js';
import { validateTaskpackV2Manifest, type Json } from '../src/schema.js';
import { SecretScrubber } from '../src/token-broker.js';
import { computeFileDigest, computeTaskpackDigests, writeDigestLockfile } from '../src/digests.js';
import {
  formatWorkspaceResourcesManifest,
  isForbiddenPreflightEnvName,
  PREFLIGHT_MAX_OUTPUT_JSON_BYTES,
  PREFLIGHT_MAX_TIMEOUT_SECONDS,
  runTaskpackPreflight,
} from '../src/preflight.js';

async function withTempDirs(run: (repoRoot: string, outsideDir: string, tempRoot: string) => Promise<void>): Promise<void> {
  const base = await mkdtemp(join(tmpdir(), 'loopwright-preflight-test-'));
  const repoRoot = join(base, 'repo');
  const outsideDir = join(base, 'outside');
  const tempRoot = join(base, 'tmp');
  await mkdir(join(repoRoot, '.loopwright', 'scripts'), { recursive: true });
  await mkdir(outsideDir, { recursive: true });
  await mkdir(tempRoot, { recursive: true });
  try {
    await run(repoRoot, outsideDir, tempRoot);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
}

function makePreflightManifest(overrides: {
  readonly mode?: 'strict' | 'privileged';
  readonly allowHostEnv?: boolean;
  readonly allowHostPath?: boolean;
  readonly pinDigests?: boolean;
  readonly script?: string;
  readonly timeoutSeconds?: number;
  readonly env?: readonly string[];
  readonly upstreams?: readonly Record<string, unknown>[];
  readonly upstreamGroups?: readonly Record<string, unknown>[];
  readonly models?: readonly Record<string, unknown>[];
  readonly mcp?: Record<string, unknown>;
  readonly externalGates?: readonly Record<string, unknown>[];
} = {}): TaskpackV2Manifest {
  const execution: Record<string, unknown> = {
    mode: overrides.mode ?? 'strict',
    ...(overrides.pinDigests !== undefined ? { digests: { pinDigests: overrides.pinDigests } } : {}),
  };
  if (overrides.allowHostEnv !== undefined || overrides.allowHostPath !== undefined) {
    execution['capabilities'] = {
      ...(overrides.allowHostEnv !== undefined ? { allowHostEnv: overrides.allowHostEnv } : {}),
      ...(overrides.allowHostPath !== undefined ? { allowHostPath: overrides.allowHostPath } : {}),
    };
  }
  const preflight: Record<string, unknown> = {
    script: overrides.script ?? '.loopwright/scripts/preflight.mjs',
  };
  if (overrides.timeoutSeconds !== undefined) preflight['timeoutSeconds'] = overrides.timeoutSeconds;
  if (overrides.env !== undefined) preflight['env'] = [...overrides.env];

  return validateTaskpackV2Manifest({
    apiVersion: 'loopwright.dev/v1alpha1',
    kind: 'Taskpack',
    metadata: { name: 'preflight-demo' },
    spec: {
      execution,
      goal: { candidate: 'Sync', noChange: 'Verify' },
      scope: { writable: ['docs/**'], protected: [] },
      preflight,
      upstreams: overrides.upstreams ?? [],
      ...(overrides.upstreamGroups !== undefined ? { upstreamGroups: overrides.upstreamGroups } : {}),
      ...(overrides.models !== undefined ? { models: overrides.models } : {}),
      ...(overrides.mcp !== undefined ? { mcp: overrides.mcp } : {}),
      verification: {
        localChecks: [],
        externalGates: overrides.externalGates ?? [],
      },
      publication: {
        mode: 'disabled',
        targetBranch: 'main',
        headBranchPrefix: 'sync/',
        titleTemplate: 'sync',
      },
      memory: {
        directory: '.loopwright/memory/preflight-demo',
        apply: 'disabled',
      },
      triggers: {
        schedule: false,
        workflowDispatch: true,
        releasePublished: false,
        commentCommands: [],
      },
    },
  } as unknown as Json, overrides.mode === 'privileged' || overrides.allowHostEnv === true || overrides.allowHostPath === true
    ? { hostPolicy: { allowPrivileged: true } }
    : undefined);
}

describe('preflight.ts: authorization & execution authority fail-closed guards', () => {
  it('refuses to execute when authorized !== true before spawning any subprocess', async () => {
    await withTempDirs(async (repoRoot, _outsideDir, tempRoot) => {
      const markerPath = join(tempRoot, 'should-not-exist.txt');
      await writeFile(
        join(repoRoot, '.loopwright', 'scripts', 'preflight.mjs'),
        `import { writeFileSync } from 'node:fs';
writeFileSync(${JSON.stringify(markerPath)}, 'executed');
writeFileSync(process.env.LOOPWRIGHT_PREFLIGHT_OUT, JSON.stringify({ disposition: 'no_change' }));
`,
        'utf8',
      );
      const manifest = makePreflightManifest();
      const scrubber = new SecretScrubber();

      await assert.rejects(
        runTaskpackPreflight({
          manifest,
          repositoryRoot: repoRoot,
          authorized: false,
          scrubber,
          tempRoot,
        }),
        (err: unknown) => err instanceof GitHubAppError && err.code === 'WEBHOOK_ACTOR_UNAUTHORIZED',
      );

      await assert.rejects(stat(markerPath), { code: 'ENOENT' });
    });
  });

  it('refuses mode: privileged without hostPolicy.allowPrivileged: true before spawning', async () => {
    await withTempDirs(async (repoRoot, _outsideDir, tempRoot) => {
      const markerPath = join(tempRoot, 'priv-marker.txt');
      await writeFile(
        join(repoRoot, '.loopwright', 'scripts', 'preflight.mjs'),
        `import { writeFileSync } from 'node:fs';
writeFileSync(${JSON.stringify(markerPath)}, 'executed');
writeFileSync(process.env.LOOPWRIGHT_PREFLIGHT_OUT, JSON.stringify({ disposition: 'no_change' }));
`,
        'utf8',
      );
      const manifest = makePreflightManifest({ mode: 'privileged' });
      const scrubber = new SecretScrubber();

      await assert.rejects(
        runTaskpackPreflight({
          manifest,
          repositoryRoot: repoRoot,
          authorized: true,
          hostPolicy: { allowPrivileged: false },
          scrubber,
          tempRoot,
        }),
        (err: unknown) => err instanceof GitHubAppError && err.code === 'TASKPACK_HOST_BINDING_INVALID',
      );

      await assert.rejects(stat(markerPath), { code: 'ENOENT' });
    });
  });
});

describe('preflight.ts: environment scrubbing & credential isolation', () => {
  it('classifies forbidden credentials accurately', () => {
    assert.equal(isForbiddenPreflightEnvName('GITHUB_TOKEN'), true);
    assert.equal(isForbiddenPreflightEnvName('GH_TOKEN'), true);
    assert.equal(isForbiddenPreflightEnvName('GITHUB_APP_PRIVATE_KEY'), true);
    assert.equal(isForbiddenPreflightEnvName('GITHUB_APP_WEBHOOK_SECRET'), true);
    assert.equal(isForbiddenPreflightEnvName('LOOPWRIGHT_LOCAL_GATE_SECRET'), true);
    assert.equal(isForbiddenPreflightEnvName('OPENAI_API_KEY'), true);
    assert.equal(isForbiddenPreflightEnvName('ANTHROPIC_API_KEY'), true);
    assert.equal(isForbiddenPreflightEnvName('AWS_ACCESS_KEY_ID'), true);
    assert.equal(isForbiddenPreflightEnvName('AWS_SECRET_ACCESS_KEY'), true);
    assert.equal(isForbiddenPreflightEnvName('AWS_SESSION_TOKEN'), true);
    assert.equal(isForbiddenPreflightEnvName('NPM_TOKEN'), true);
    assert.equal(isForbiddenPreflightEnvName('CUSTOM_VENDOR_API_KEY'), true);
    assert.equal(isForbiddenPreflightEnvName('MY_SIGNING_SECRET'), true);
    assert.equal(isForbiddenPreflightEnvName('SERVICE_ACCESS_TOKEN'), true);
    assert.equal(isForbiddenPreflightEnvName('SSH_PRIVATE_KEY'), true);
    assert.equal(isForbiddenPreflightEnvName('CUSTOM_SAFE_FLAG'), false);
    assert.equal(isForbiddenPreflightEnvName('NODE_ENV'), false);
  });

  it('strips all forbidden credentials even under privileged allowHostEnv: true and explicit env allowlist', async () => {
    await withTempDirs(async (repoRoot, _outsideDir, tempRoot) => {
      await writeFile(
        join(repoRoot, '.loopwright', 'scripts', 'preflight.mjs'),
        `import { writeFileSync } from 'node:fs';
const keys = Object.keys(process.env).sort();
writeFileSync(process.env.LOOPWRIGHT_PREFLIGHT_OUT, JSON.stringify({
  disposition: 'no_change',
  reason: JSON.stringify({
    hasGithubToken: 'GITHUB_TOKEN' in process.env,
    hasGhToken: 'GH_TOKEN' in process.env,
    hasAppKey: 'GITHUB_APP_PRIVATE_KEY' in process.env,
    hasWebhookSecret: 'GITHUB_APP_WEBHOOK_SECRET' in process.env,
    hasLoopwrightLeak: 'LOOPWRIGHT_PROVIDER_TOKEN' in process.env,
    hasOpenAi: 'OPENAI_API_KEY' in process.env,
    hasAnthropic: 'ANTHROPIC_API_KEY' in process.env,
    hasCustomSecret: 'ACME_API_KEY' in process.env || 'ACME_TOKEN' in process.env || 'ACME_SECRET' in process.env || 'ACME_PRIVATE_KEY' in process.env,
    safeInherited: process.env.SAFE_HOST_FLAG ?? null,
    brokeredMatched: process.env.BROKERED_API_TOKEN === 'brokered-ok-value',
    brokeredEcho: process.env.BROKERED_API_TOKEN ?? null,
    hasOut: typeof process.env.LOOPWRIGHT_PREFLIGHT_OUT === 'string' && process.env.LOOPWRIGHT_PREFLIGHT_OUT.length > 0,
    hasRepoRoot: typeof process.env.LOOPWRIGHT_REPO_ROOT === 'string' && process.env.LOOPWRIGHT_REPO_ROOT.length > 0,
    hasStagingDir: typeof process.env.LOOPWRIGHT_STAGING_DIR === 'string' && process.env.LOOPWRIGHT_STAGING_DIR.length > 0,
    keysCount: keys.length,
  }),
}));
`,
        'utf8',
      );

      // Construct manifest in privileged mode (allowHostEnv defaults true) and also test an untrusted forged env array
      const baseManifest = makePreflightManifest({ mode: 'privileged', env: ['SAFE_HOST_FLAG'] });
      const manifestWithForgedEnv: TaskpackV2Manifest = {
        ...baseManifest,
        spec: {
          ...baseManifest.spec,
          preflight: {
            ...baseManifest.spec.preflight!,
            env: ['SAFE_HOST_FLAG', 'GITHUB_TOKEN', 'OPENAI_API_KEY', 'LOOPWRIGHT_PROVIDER_TOKEN', 'ACME_SECRET'],
          },
        },
      };

      const scrubber = new SecretScrubber();
      const result = await runTaskpackPreflight({
        manifest: manifestWithForgedEnv,
        repositoryRoot: repoRoot,
        authorized: true,
        hostPolicy: { allowPrivileged: true },
        scrubber,
        tempRoot,
        env: {
          PATH: process.env['PATH'] ?? '/usr/bin:/bin',
          SAFE_HOST_FLAG: 'enabled-123',
          GITHUB_TOKEN: 'ghp_secret_token_should_strip',
          GH_TOKEN: 'ghp_gh_token_should_strip',
          GITHUB_APP_PRIVATE_KEY: '-----BEGIN RSA PRIVATE KEY-----\nabc',
          GITHUB_APP_WEBHOOK_SECRET: 'whsec_1234567890',
          LOOPWRIGHT_PROVIDER_TOKEN: 'sk-loopwright-provider-secret',
          OPENAI_API_KEY: 'sk-openai-secret-1234567890',
          ANTHROPIC_API_KEY: 'sk-ant-secret-1234567890',
          ACME_API_KEY: 'acme-key-12345',
          ACME_TOKEN: 'acme-tok-12345',
          ACME_SECRET: 'acme-sec-12345',
          ACME_PRIVATE_KEY: 'acme-pk-12345',
        },
        brokeredEnv: {
          BROKERED_API_TOKEN: 'brokered-ok-value',
          LOOPWRIGHT_PREFLIGHT_OUT: '/tmp/hijack.json',
        },
      });
      try {
        assert.equal(result.disposition, 'no_change');
        const observed = JSON.parse(result.reason ?? '{}') as Record<string, unknown>;
        assert.equal(observed['hasGithubToken'], false);
        assert.equal(observed['hasGhToken'], false);
        assert.equal(observed['hasAppKey'], false);
        assert.equal(observed['hasWebhookSecret'], false);
        assert.equal(observed['hasLoopwrightLeak'], false);
        assert.equal(observed['hasOpenAi'], false);
        assert.equal(observed['hasAnthropic'], false);
        assert.equal(observed['hasCustomSecret'], false);
        assert.equal(observed['safeInherited'], 'enabled-123');
        assert.equal(observed['brokeredMatched'], true);
        assert.equal(observed['brokeredEcho'], '[scrubbed]');
        assert.equal(observed['hasOut'], true);
        assert.equal(observed['hasRepoRoot'], true);
        assert.equal(observed['hasStagingDir'], true);
      } finally {
        await result.cleanup();
      }
    });
  });

  it('uses minimal env in strict mode and only forwards explicit non-secret spec.preflight.env', async () => {
    await withTempDirs(async (repoRoot, _outsideDir, tempRoot) => {
      await writeFile(
        join(repoRoot, '.loopwright', 'scripts', 'preflight.mjs'),
        `import { writeFileSync } from 'node:fs';
writeFileSync(process.env.LOOPWRIGHT_PREFLIGHT_OUT, JSON.stringify({
  disposition: 'no_change',
  reason: JSON.stringify({
    allowed: process.env.ALLOWED_FLAG ?? null,
    unlisted: process.env.UNLISTED_HOST_VAR ?? null,
    github: process.env.GITHUB_TOKEN ?? null,
  }),
}));
`,
        'utf8',
      );
      const manifest = makePreflightManifest({ mode: 'strict', env: ['ALLOWED_FLAG'] });
      const result = await runTaskpackPreflight({
        manifest,
        repositoryRoot: repoRoot,
        authorized: true,
        scrubber: new SecretScrubber(),
        tempRoot,
        env: {
          ALLOWED_FLAG: 'yes',
          UNLISTED_HOST_VAR: 'should-not-pass',
          GITHUB_TOKEN: 'ghp_12345678901234567890',
        },
      });
      try {
        const expectedSha = await computeFileDigest(repoRoot, '.loopwright/scripts/preflight.mjs');
        assert.equal(result.script, '.loopwright/scripts/preflight.mjs');
        assert.equal(result.scriptSha256, expectedSha);
        const observed = JSON.parse(result.reason ?? '{}') as Record<string, unknown>;
        assert.equal(observed['allowed'], 'yes');
        assert.equal(observed['unlisted'], null);
        assert.equal(observed['github'], null);
      } finally {
        await result.cleanup();
      }
    });
  });
});

describe('preflight.ts: dispositions, upstreams, and split stagedResources', () => {
  it('handles candidate, no_change, and blocked dispositions with held_back upstreams and metadata', async () => {
    await withTempDirs(async (repoRoot, _outsideDir, tempRoot) => {
      const scriptPath = join(repoRoot, '.loopwright', 'scripts', 'preflight.mjs');

      // 1) candidate with mixed available + held_back upstreams
      await writeFile(
        scriptPath,
        `import { writeFileSync } from 'node:fs';
writeFileSync(process.env.LOOPWRIGHT_PREFLIGHT_OUT, JSON.stringify({
  disposition: 'candidate',
  reason: 'pi-ai available; yaml held back',
  upstreams: [
    {
      id: 'pi-ai',
      status: 'available',
      version: '0.62.0',
      currentVersion: '0.61.0',
      reason: 'minor upgrade',
      metadata: { tarballSize: 12345, verified: true },
    },
    {
      id: 'yaml-pkg',
      status: 'held_back',
      version: '3.0.0',
      currentVersion: '2.9.1',
      reason: 'major breaking change held back',
    },
  ],
}));
`,
        'utf8',
      );
      const manifest = makePreflightManifest({
        upstreams: [
          { id: 'pi-ai', kind: 'http-json', source: 'https://registry.npmjs.org/pi-ai', watchedPaths: ['package.json'] },
          { id: 'yaml-pkg', kind: 'http-json', source: 'https://registry.npmjs.org/yaml', watchedPaths: ['packages/github-app/package.json'] },
        ],
      });
      const candidateRes = await runTaskpackPreflight({
        manifest,
        repositoryRoot: repoRoot,
        authorized: true,
        scrubber: new SecretScrubber(),
        tempRoot,
      });
      try {
        assert.equal(candidateRes.disposition, 'candidate');
        assert.equal(candidateRes.upstreams.length, 2);
        assert.equal(candidateRes.upstreams[0]?.upstreamId, 'pi-ai');
        assert.equal(candidateRes.upstreams[0]?.status, 'available');
        assert.equal(candidateRes.upstreams[0]?.version, '0.62.0');
        assert.equal(candidateRes.upstreams[0]?.currentVersion, '0.61.0');
        assert.deepEqual(candidateRes.upstreams[0]?.watchedPaths, ['package.json']);
        assert.deepEqual({ ...candidateRes.upstreams[0]?.metadata }, { tarballSize: 12345, verified: true });

        // held_back preserves currentVersion and does NOT substitute skipped target version into version!
        assert.equal(candidateRes.upstreams[1]?.upstreamId, 'yaml-pkg');
        assert.equal(candidateRes.upstreams[1]?.status, 'held_back');
        assert.equal(candidateRes.upstreams[1]?.currentVersion, '2.9.1');
        assert.equal(candidateRes.upstreams[1]?.version, '2.9.1');
        assert.equal(candidateRes.upstreams[1]?.targetVersion, '3.0.0');
        assert.deepEqual(candidateRes.upstreams[1]?.watchedPaths, ['packages/github-app/package.json']);
      } finally {
        await candidateRes.cleanup();
      }

      // 2) blocked disposition
      await writeFile(
        scriptPath,
        `import { writeFileSync } from 'node:fs';
writeFileSync(process.env.LOOPWRIGHT_PREFLIGHT_OUT, JSON.stringify({
  disposition: 'blocked',
  reason: 'upstream registry unreachable',
}));
`,
        'utf8',
      );
      const blockedRes = await runTaskpackPreflight({
        manifest,
        repositoryRoot: repoRoot,
        authorized: true,
        scrubber: new SecretScrubber(),
        tempRoot,
      });
      try {
        assert.equal(blockedRes.disposition, 'blocked');
        assert.equal(blockedRes.reason, 'upstream registry unreachable');
      } finally {
        await blockedRes.cleanup();
      }

      // 3) lockstep upstreamGroups hold back disagreeing preflight upstreams atomically
      const groupedManifest = makePreflightManifest({
        upstreams: [
          { id: 'pi-ai', kind: 'http-json', source: 'https://registry.npmjs.org/pi-ai', watchedPaths: ['package.json'] },
          { id: 'pi-coding', kind: 'http-json', source: 'https://registry.npmjs.org/pi-coding', watchedPaths: ['package.json'] },
        ],
        upstreamGroups: [
          { id: 'pi-suite', members: ['pi-ai', 'pi-coding'], policy: 'lockstep' },
        ],
      });
      await writeFile(
        scriptPath,
        `import { writeFileSync } from 'node:fs';
writeFileSync(process.env.LOOPWRIGHT_PREFLIGHT_OUT, JSON.stringify({
  disposition: 'candidate',
  upstreams: [
    { id: 'pi-ai', status: 'available', version: '0.62.0', currentVersion: '0.61.0' },
    { id: 'pi-coding', status: 'available', version: '0.61.5', currentVersion: '0.61.0' },
  ],
}));
`,
        'utf8',
      );
      const heldGroupRes = await runTaskpackPreflight({
        manifest: groupedManifest,
        repositoryRoot: repoRoot,
        authorized: true,
        scrubber: new SecretScrubber(),
        tempRoot,
      });
      try {
        assert.equal(heldGroupRes.disposition, 'no_change');
        assert.equal(heldGroupRes.upstreams[0]?.status, 'held_back');
        assert.equal(heldGroupRes.upstreams[0]?.version, '0.61.0');
        assert.equal(heldGroupRes.upstreams[1]?.status, 'held_back');
        assert.equal(heldGroupRes.upstreams[1]?.version, '0.61.0');
      } finally {
        await heldGroupRes.cleanup();
      }
    });
  });

  it('splits stagedResources into prompt (UTF-8 bounded) and workspace (>100KiB lockfile + binary .tgz read-only stagedDir)', async () => {
    await withTempDirs(async (repoRoot, _outsideDir, tempRoot) => {
      await mkdir(join(repoRoot, 'docs'), { recursive: true });
      await writeFile(join(repoRoot, 'docs', 'guide.md'), '# Upgrade Guide\nFollow these rules.\n', 'utf8');

      await writeFile(
        join(repoRoot, '.loopwright', 'scripts', 'preflight.mjs'),
        `import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const staging = process.env.LOOPWRIGHT_STAGING_DIR;
mkdirSync(join(staging, 'cache'), { recursive: true });

// 1) Prompt-mounted skill (default mount for skill -> 'prompt')
writeFileSync(join(staging, 'upgrade-skill.md'), '# Skill\\nAlways run tests.\\n', 'utf8');

// 2) Workspace-mounted >100 KiB lockfile (default mount for document -> 'workspace')
const lockPayload = JSON.stringify({ lockfileVersion: 3, pad: 'x'.repeat(120 * 1024) });
writeFileSync(join(staging, 'package-lock.json'), lockPayload, 'utf8');

// 3) Workspace-mounted binary .tgz with non-UTF-8 bytes & NUL bytes
const binaryTgz = Buffer.from([0x1f, 0x8b, 0x08, 0x00, 0x00, 0xff, 0xfe, 0x80, 0x81, 0x00, 0xde, 0xad, 0xbe, 0xef]);
writeFileSync(join(staging, 'cache', 'pkg-1.0.0.tgz'), binaryTgz);

writeFileSync(process.env.LOOPWRIGHT_PREFLIGHT_OUT, JSON.stringify({
  disposition: 'candidate',
  stagedResources: [
    { id: 'repo-guide', kind: 'instruction', path: 'docs/guide.md' },
    { id: 'dynamic-skill', kind: 'skill', path: 'upgrade-skill.md' },
    { id: 'staged-lockfile', kind: 'document', path: 'package-lock.json', exposeToChecks: true },
    { id: 'tarball-cache', kind: 'document', path: 'cache/pkg-1.0.0.tgz', mount: 'workspace', exposeToChecks: true },
  ],
}));
`,
        'utf8',
      );

      const manifest = makePreflightManifest();
      const result = await runTaskpackPreflight({
        manifest,
        repositoryRoot: repoRoot,
        authorized: true,
        scrubber: new SecretScrubber(),
        tempRoot,
      });
      try {
        assert.equal(result.disposition, 'candidate');
        assert.equal(result.promptResources.length, 2);
        assert.equal(result.promptResources[0]?.id, 'repo-guide');
        assert.equal(result.promptResources[0]?.content, '# Upgrade Guide\nFollow these rules.\n');
        assert.equal(result.promptResources[1]?.id, 'dynamic-skill');
        assert.equal(result.promptResources[1]?.content, '# Skill\nAlways run tests.\n');

        assert.equal(result.workspaceResources.length, 2);
        assert.ok(result.stagedDir !== null);

        const lockRes = result.workspaceResources.find(r => r.id === 'staged-lockfile');
        assert.ok(lockRes !== undefined);
        assert.equal(lockRes.relativePath, 'package-lock.json');
        assert.equal(lockRes.exposeToChecks, true);
        assert.ok(lockRes.byteLength > 100 * 1024);

        const tgzRes = result.workspaceResources.find(r => r.id === 'tarball-cache');
        assert.ok(tgzRes !== undefined);
        assert.equal(tgzRes.relativePath, 'cache/pkg-1.0.0.tgz');
        assert.equal(tgzRes.exposeToChecks, true);
        const expectedBinary = Buffer.from([0x1f, 0x8b, 0x08, 0x00, 0x00, 0xff, 0xfe, 0x80, 0x81, 0x00, 0xde, 0xad, 0xbe, 0xef]);
        assert.equal(tgzRes.byteLength, expectedBinary.byteLength);
        assert.equal(tgzRes.sha256, createHash('sha256').update(expectedBinary).digest('hex'));

        // Verify staged files exist, match exact bytes, and have read-only permissions (0o555 dirs / 0o444 files)
        const stagedTgzBytes = await readFile(tgzRes.stagedPath);
        assert.deepEqual(stagedTgzBytes, expectedBinary);
        const dirMode = (await lstat(result.stagedDir)).mode & 0o777;
        const fileMode = (await lstat(tgzRes.stagedPath)).mode & 0o777;
        assert.equal(dirMode, 0o555);
        assert.equal(fileMode, 0o444);

        // Verify workspace path manifest never embeds file contents and emits exact readOnlyPath when stagedRootDir is provided
        const manifestSummary = formatWorkspaceResourcesManifest(result.workspaceResources);
        assert.match(manifestSummary, /package-lock\.json/);
        assert.match(manifestSummary, /cache\/pkg-1\.0\.0\.tgz/);
        assert.match(manifestSummary, new RegExp(tgzRes.sha256));
        assert.equal(manifestSummary.includes('readOnlyPath='), false);
        assert.equal(manifestSummary.includes('xxxx'), false);

        const pointerScrubber = new SecretScrubber();
        const manifestWithPointers = formatWorkspaceResourcesManifest(result.workspaceResources, result.stagedDir, pointerScrubber);
        assert.equal(manifestWithPointers.includes(`readOnlyPath=${join(result.stagedDir, 'package-lock.json')}`), true);
        assert.equal(manifestWithPointers.includes(`readOnlyPath=${join(result.stagedDir, 'cache', 'pkg-1.0.0.tgz')}`), true);
      } finally {
        await result.cleanup();
      }
      // Verify cleanup removed stagedDir cleanly
      await assert.rejects(stat(result.stagedDir!), { code: 'ENOENT' });
    });
  });

  it('rejects binary or NUL-byte content when mount: prompt is requested', async () => {
    await withTempDirs(async (repoRoot, _outsideDir, tempRoot) => {
      const scriptPath = join(repoRoot, '.loopwright', 'scripts', 'preflight.mjs');

      // Invalid UTF-8 bytes
      await writeFile(
        scriptPath,
        `import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
writeFileSync(join(process.env.LOOPWRIGHT_STAGING_DIR, 'bad.bin'), Buffer.from([0xff, 0xfe, 0x80]));
writeFileSync(process.env.LOOPWRIGHT_PREFLIGHT_OUT, JSON.stringify({
  disposition: 'candidate',
  stagedResources: [{ id: 'bad-utf8', kind: 'instruction', path: 'bad.bin', mount: 'prompt' }],
}));
`,
        'utf8',
      );
      await assert.rejects(
        runTaskpackPreflight({
          manifest: makePreflightManifest(),
          repositoryRoot: repoRoot,
          authorized: true,
          scrubber: new SecretScrubber(),
          tempRoot,
        }),
        (err: unknown) => err instanceof GitHubAppError && err.code === 'TASKPACK_MANIFEST_INVALID',
      );

      // Valid UTF-8 containing a NUL byte
      await writeFile(
        scriptPath,
        `import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
writeFileSync(join(process.env.LOOPWRIGHT_STAGING_DIR, 'nul.txt'), 'hello\\0world', 'utf8');
writeFileSync(process.env.LOOPWRIGHT_PREFLIGHT_OUT, JSON.stringify({
  disposition: 'candidate',
  stagedResources: [{ id: 'nul-text', kind: 'instruction', path: 'nul.txt', mount: 'prompt' }],
}));
`,
        'utf8',
      );
      await assert.rejects(
        runTaskpackPreflight({
          manifest: makePreflightManifest(),
          repositoryRoot: repoRoot,
          authorized: true,
          scrubber: new SecretScrubber(),
          tempRoot,
        }),
        (err: unknown) => err instanceof GitHubAppError && err.code === 'TASKPACK_MANIFEST_INVALID',
      );
    });
  });
});

describe('preflight.ts: symlinks, escaping paths, oversized outputs, duplicate JSON keys, timeout & secret scrubbing', () => {
  it('refuses symlinked preflight script', async () => {
    await withTempDirs(async (repoRoot, outsideDir, tempRoot) => {
      const outsideScript = join(outsideDir, 'evil.mjs');
      await writeFile(
        outsideScript,
        `import { writeFileSync } from 'node:fs';
writeFileSync(process.env.LOOPWRIGHT_PREFLIGHT_OUT, JSON.stringify({ disposition: 'no_change' }));
`,
        'utf8',
      );
      await symlink(outsideScript, join(repoRoot, '.loopwright', 'scripts', 'preflight.mjs'));

      await assert.rejects(
        runTaskpackPreflight({
          manifest: makePreflightManifest(),
          repositoryRoot: repoRoot,
          authorized: true,
          scrubber: new SecretScrubber(),
          tempRoot,
        }),
        (err: unknown) => err instanceof GitHubAppError && err.code === 'TASKPACK_SCOPE_VIOLATION',
      );
    });
  });

  it('refuses symlinked staged resources and escaping staged resource paths', async () => {
    await withTempDirs(async (repoRoot, outsideDir, tempRoot) => {
      const secretFile = join(outsideDir, 'secret.txt');
      await writeFile(secretFile, 'top-secret', 'utf8');
      const scriptPath = join(repoRoot, '.loopwright', 'scripts', 'preflight.mjs');

      // 1) Symlink inside staging dir pointing outside
      await writeFile(
        scriptPath,
        `import { symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
symlinkSync(${JSON.stringify(secretFile)}, join(process.env.LOOPWRIGHT_STAGING_DIR, 'link.txt'));
writeFileSync(process.env.LOOPWRIGHT_PREFLIGHT_OUT, JSON.stringify({
  disposition: 'candidate',
  stagedResources: [{ id: 'sym', kind: 'document', path: 'link.txt', mount: 'workspace' }],
}));
`,
        'utf8',
      );
      await assert.rejects(
        runTaskpackPreflight({
          manifest: makePreflightManifest(),
          repositoryRoot: repoRoot,
          authorized: true,
          scrubber: new SecretScrubber(),
          tempRoot,
        }),
        (err: unknown) => err instanceof GitHubAppError && err.code === 'TASKPACK_SCOPE_VIOLATION',
      );

      // 2) Escaping relative path ../outside/secret.txt
      await writeFile(
        scriptPath,
        `import { writeFileSync } from 'node:fs';
writeFileSync(process.env.LOOPWRIGHT_PREFLIGHT_OUT, JSON.stringify({
  disposition: 'candidate',
  stagedResources: [{ id: 'esc', kind: 'document', path: '../outside/secret.txt', mount: 'workspace' }],
}));
`,
        'utf8',
      );
      await assert.rejects(
        runTaskpackPreflight({
          manifest: makePreflightManifest(),
          repositoryRoot: repoRoot,
          authorized: true,
          scrubber: new SecretScrubber(),
          tempRoot,
        }),
        (err: unknown) => err instanceof GitHubAppError && (err.code === 'TASKPACK_SCOPE_VIOLATION' || err.code === 'TASKPACK_MANIFEST_INVALID'),
      );

      // 3) Escaping absolute path
      await writeFile(
        scriptPath,
        `import { writeFileSync } from 'node:fs';
writeFileSync(process.env.LOOPWRIGHT_PREFLIGHT_OUT, JSON.stringify({
  disposition: 'candidate',
  stagedResources: [{ id: 'abs-esc', kind: 'document', path: ${JSON.stringify(secretFile)}, mount: 'workspace' }],
}));
`,
        'utf8',
      );
      await assert.rejects(
        runTaskpackPreflight({
          manifest: makePreflightManifest(),
          repositoryRoot: repoRoot,
          authorized: true,
          scrubber: new SecretScrubber(),
          tempRoot,
        }),
        (err: unknown) => err instanceof GitHubAppError && err.code === 'TASKPACK_SCOPE_VIOLATION',
      );
    });
  });

  it('refuses oversized outputs, symlinked LOOPWRIGHT_PREFLIGHT_OUT, and duplicate JSON keys', async () => {
    await withTempDirs(async (repoRoot, outsideDir, tempRoot) => {
      const scriptPath = join(repoRoot, '.loopwright', 'scripts', 'preflight.mjs');

      // 1) Oversized output (> 512 KiB)
      await writeFile(
        scriptPath,
        `import { writeFileSync } from 'node:fs';
writeFileSync(process.env.LOOPWRIGHT_PREFLIGHT_OUT, JSON.stringify({
  disposition: 'no_change',
  reason: 'a'.repeat(${PREFLIGHT_MAX_OUTPUT_JSON_BYTES + 1024}),
}));
`,
        'utf8',
      );
      await assert.rejects(
        runTaskpackPreflight({
          manifest: makePreflightManifest(),
          repositoryRoot: repoRoot,
          authorized: true,
          scrubber: new SecretScrubber(),
          tempRoot,
        }),
        (err: unknown) => err instanceof GitHubAppError && err.code === 'TASKPACK_MANIFEST_INVALID',
      );

      // 2) Duplicate JSON keys
      await writeFile(
        scriptPath,
        `import { writeFileSync } from 'node:fs';
writeFileSync(process.env.LOOPWRIGHT_PREFLIGHT_OUT, '{"disposition":"candidate","disposition":"no_change"}');
`,
        'utf8',
      );
      await assert.rejects(
        runTaskpackPreflight({
          manifest: makePreflightManifest(),
          repositoryRoot: repoRoot,
          authorized: true,
          scrubber: new SecretScrubber(),
          tempRoot,
        }),
        (err: unknown) => err instanceof GitHubAppError && err.code === 'TASKPACK_MANIFEST_INVALID',
      );

      // 3) Symlinked LOOPWRIGHT_PREFLIGHT_OUT
      const outsideJson = join(outsideDir, 'out.json');
      await writeFile(outsideJson, JSON.stringify({ disposition: 'no_change' }), 'utf8');
      await writeFile(
        scriptPath,
        `import { symlinkSync } from 'node:fs';
symlinkSync(${JSON.stringify(outsideJson)}, process.env.LOOPWRIGHT_PREFLIGHT_OUT);
`,
        'utf8',
      );
      await assert.rejects(
        runTaskpackPreflight({
          manifest: makePreflightManifest(),
          repositoryRoot: repoRoot,
          authorized: true,
          scrubber: new SecretScrubber(),
          tempRoot,
        }),
        (err: unknown) => err instanceof GitHubAppError && err.code === 'TASKPACK_SCOPE_VIOLATION',
      );
    });
  });

  it('enforces timeout and scrubs secrets from captured stdout, stderr, and error messages', async () => {
    await withTempDirs(async (repoRoot, _outsideDir, tempRoot) => {
      const scriptPath = join(repoRoot, '.loopwright', 'scripts', 'preflight.mjs');
      const secretVal = 'sk-super-secret-preflight-value-987654321';
      const scrubber = new SecretScrubber();
      scrubber.register(secretVal);

      // 1) Scrubs secrets on success in stdout, stderr, and reason
      await writeFile(
        scriptPath,
        `import { writeFileSync } from 'node:fs';
console.log('stdout leaked ${secretVal}');
console.error('stderr leaked ${secretVal}');
writeFileSync(process.env.LOOPWRIGHT_PREFLIGHT_OUT, JSON.stringify({
  disposition: 'no_change',
  reason: 'reason leaked ${secretVal}',
}));
`,
        'utf8',
      );
      const okRes = await runTaskpackPreflight({
        manifest: makePreflightManifest(),
        repositoryRoot: repoRoot,
        authorized: true,
        scrubber,
        tempRoot,
      });
      try {
        assert.equal(okRes.stdout.includes(secretVal), false);
        assert.equal(okRes.stderr.includes(secretVal), false);
        assert.equal((okRes.reason ?? '').includes(secretVal), false);
        assert.match(okRes.stdout, /\[scrubbed\]/);
        assert.match(okRes.stderr, /\[scrubbed\]/);
        assert.match(okRes.reason ?? '', /\[scrubbed\]/);
      } finally {
        await okRes.cleanup();
      }

      // 2) Timeout kills child and scrubs leaked stderr
      await writeFile(
        scriptPath,
        `console.error('timing out with ${secretVal}');
setTimeout(() => {}, 30_000);
`,
        'utf8',
      );
      await chmod(scriptPath, 0o644);
      let caughtError: unknown;
      try {
        await runTaskpackPreflight({
          manifest: makePreflightManifest({ timeoutSeconds: 1 }),
          repositoryRoot: repoRoot,
          authorized: true,
          scrubber,
          tempRoot,
          timeoutMs: 250,
        });
      } catch (err) {
        caughtError = err;
      }
      assert.ok(caughtError instanceof GitHubAppError);
      assert.equal(caughtError.code, 'SANDBOX_EXECUTION_FAILED');
      assert.match(caughtError.message, /timed out/i);
      assert.equal(caughtError.message.includes(secretVal), false);
    });
  });
});

describe('preflight.ts: Review-T7 security & lifecycle hardening regressions', () => {
  it('strips manifest-declared model/MCP/externalGate secrets, SECRET_VAR_KEY_PATTERN keys, and runtime injection vars; scrubs brokeredEnv, deep keys, and promptResources', async () => {
    assert.equal(isForbiddenPreflightEnvName('GATE_HMAC_SIGNING_KEY'), true);
    assert.equal(isForbiddenPreflightEnvName('CUSTOM_LLM_CREDENTIAL'), true);
    assert.equal(isForbiddenPreflightEnvName('OPENAI_APIKEY'), true);
    assert.equal(isForbiddenPreflightEnvName('SERVICE_BEARER'), true);
    assert.equal(isForbiddenPreflightEnvName('AUTH_COOKIE'), true);
    assert.equal(isForbiddenPreflightEnvName('MY_SESSION_KEY'), true);
    assert.equal(isForbiddenPreflightEnvName('GH_PAT'), true);
    assert.equal(isForbiddenPreflightEnvName('ACTIONS_RUNTIME_URL'), true);
    assert.equal(isForbiddenPreflightEnvName('RUNNER_TEMP'), true);
    assert.equal(isForbiddenPreflightEnvName('GIT_SSH_COMMAND'), true);
    assert.equal(isForbiddenPreflightEnvName('LD_PRELOAD'), true);
    assert.equal(isForbiddenPreflightEnvName('DYLD_INSERT_LIBRARIES'), true);
    assert.equal(isForbiddenPreflightEnvName('NODE_OPTIONS'), true);
    assert.equal(isForbiddenPreflightEnvName('BASH_ENV'), true);

    await withTempDirs(async (repoRoot, _outsideDir, tempRoot) => {
      const scriptPath = join(repoRoot, '.loopwright', 'scripts', 'preflight.mjs');
      const brokeredSecret = 'brokered-live-secret-99887766';
      await writeFile(
        scriptPath,
        `import { writeFileSync } from 'node:fs';
// Total JSON depth: root(1) -> upstreams(2) -> [0](3) -> metadata(4) -> d1..d7(11) -> leaf string(12)
const deep = { d1: { d2: { d3: { d4: { d5: { d6: { d7: { ['key_' + process.env.BROKERED_CUSTOM]: 'val_' + process.env.BROKERED_CUSTOM } } } } } } } };
writeFileSync(process.env.LOOPWRIGHT_PREFLIGHT_OUT, JSON.stringify({
  disposition: 'no_change',
  reason: JSON.stringify({
    gateKey: process.env.CUSTOM_GATE_ENV ?? null,
    modelKey: process.env.CUSTOM_MODEL_ENV ?? null,
    mcpKey: process.env.CUSTOM_MCP_ENV ?? null,
    ldPreload: process.env.LD_PRELOAD ?? null,
    actionsVar: process.env.ACTIONS_ID_TOKEN_REQUEST_URL ?? null,
    brokeredLeak: process.env.BROKERED_CUSTOM ?? null,
  }),
  upstreams: [{ id: 'u1', status: 'up_to_date', version: '1.0.0', metadata: deep }],
}));
`,
        'utf8',
      );

      const baseManifest = makePreflightManifest({
        mode: 'privileged',
        models: [{ provider: 'openai', id: 'gpt-5', apiKeyEnv: 'CUSTOM_MODEL_ENV' }],
        mcp: {
          servers: [{
            id: 'docs',
            transport: 'http',
            url: 'https://mcp.example.com/sse',
            bearerTokenEnv: 'CUSTOM_MCP_ENV',
          }],
        },
        externalGates: [{
          id: 'ext',
          gateId: 'g1',
          endpointId: 'ep1',
          required: true,
          signingCredentialRef: 'CUSTOM_GATE_ENV',
        }],
      });
      const manifestWithEnv: TaskpackV2Manifest = {
        ...baseManifest,
        spec: {
          ...baseManifest.spec,
          preflight: {
            ...baseManifest.spec.preflight!,
            env: ['CUSTOM_GATE_ENV', 'CUSTOM_MODEL_ENV', 'CUSTOM_MCP_ENV'],
          },
        },
      };

      const res = await runTaskpackPreflight({
        manifest: manifestWithEnv,
        repositoryRoot: repoRoot,
        authorized: true,
        hostPolicy: { allowPrivileged: true },
        scrubber: new SecretScrubber(),
        tempRoot,
        env: {
          PATH: process.env['PATH'] ?? '/usr/bin:/bin',
          CUSTOM_GATE_ENV: 'hmac-gate-secret-123456',
          CUSTOM_MODEL_ENV: 'model-key-secret-123456',
          CUSTOM_MCP_ENV: 'mcp-bearer-secret-123456',
          LD_PRELOAD: '/tmp/evil.so',
          ACTIONS_ID_TOKEN_REQUEST_URL: 'https://actions.example/oidc',
        },
        brokeredEnv: {
          BROKERED_CUSTOM: brokeredSecret,
        },
      });
      try {
        const obs = JSON.parse(res.reason ?? '{}') as Record<string, unknown>;
        assert.equal(obs['gateKey'], null);
        assert.equal(obs['modelKey'], null);
        assert.equal(obs['mcpKey'], null);
        assert.equal(obs['ldPreload'], null);
        assert.equal(obs['actionsVar'], null);
        // Brokered value was scrubbed from reason AND from depth-10 metadata key & value!
        assert.equal(obs['brokeredLeak'], '[scrubbed]');
        const metaJson = JSON.stringify(res.upstreams[0]?.metadata ?? {});
        assert.equal(metaJson.includes(brokeredSecret), false);
        assert.match(metaJson, /key_\[scrubbed\]/);
        assert.match(metaJson, /val_\[scrubbed\]/);
      } finally {
        await res.cleanup();
      }

      // Prompt-mounted staged resource containing a tracked or brokered secret fails closed!
      await writeFile(
        scriptPath,
        `import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
writeFileSync(join(process.env.LOOPWRIGHT_STAGING_DIR, 'leak.md'), 'secret=' + process.env.BROKERED_CUSTOM, 'utf8');
writeFileSync(process.env.LOOPWRIGHT_PREFLIGHT_OUT, JSON.stringify({
  disposition: 'candidate',
  stagedResources: [{ id: 'leaked-prompt', kind: 'instruction', path: 'leak.md', mount: 'prompt' }],
}));
`,
        'utf8',
      );
      await assert.rejects(
        runTaskpackPreflight({
          manifest: makePreflightManifest(),
          repositoryRoot: repoRoot,
          authorized: true,
          scrubber: new SecretScrubber(),
          tempRoot,
          brokeredEnv: { BROKERED_CUSTOM: brokeredSecret },
        }),
        (err: unknown) => err instanceof GitHubAppError && err.code === 'TOKEN_SECRET_LEAK_DETECTED',
      );
    });
  });

  it('blocks hardlink escapes in LOOPWRIGHT_STAGING_DIR and LOOPWRIGHT_PREFLIGHT_OUT and never chmods hardlinked files on cleanup', async () => {
    await withTempDirs(async (repoRoot, outsideDir, tempRoot) => {
      const hostSecret = join(outsideDir, 'host-secret.txt');
      await writeFile(hostSecret, 'TOP_SECRET_HOST_FILE_CONTENT', 'utf8');
      await chmod(hostSecret, 0o755);

      const scriptPath = join(repoRoot, '.loopwright', 'scripts', 'preflight.mjs');

      // 1) Hardlink inside LOOPWRIGHT_STAGING_DIR rejected with TASKPACK_SCOPE_VIOLATION AND host file mode preserved (0o755)!
      await writeFile(
        scriptPath,
        `import { linkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
linkSync(${JSON.stringify(hostSecret)}, join(process.env.LOOPWRIGHT_STAGING_DIR, 'leaked.txt'));
writeFileSync(process.env.LOOPWRIGHT_PREFLIGHT_OUT, JSON.stringify({
  disposition: 'candidate',
  stagedResources: [{ id: 'hl', kind: 'instruction', path: 'leaked.txt', mount: 'prompt' }],
}));
`,
        'utf8',
      );
      await assert.rejects(
        runTaskpackPreflight({
          manifest: makePreflightManifest(),
          repositoryRoot: repoRoot,
          authorized: true,
          scrubber: new SecretScrubber(),
          tempRoot,
        }),
        (err: unknown) => err instanceof GitHubAppError && err.code === 'TASKPACK_SCOPE_VIOLATION',
      );
      const afterMode = (await lstat(hostSecret)).mode & 0o777;
      assert.equal(afterMode, 0o755);

      // 2) Hardlink at LOOPWRIGHT_PREFLIGHT_OUT rejected with TASKPACK_SCOPE_VIOLATION
      const outsideJson = join(outsideDir, 'outside-out.json');
      await writeFile(outsideJson, JSON.stringify({ disposition: 'no_change' }), 'utf8');
      await writeFile(
        scriptPath,
        `import { linkSync } from 'node:fs';
linkSync(${JSON.stringify(outsideJson)}, process.env.LOOPWRIGHT_PREFLIGHT_OUT);
`,
        'utf8',
      );
      await assert.rejects(
        runTaskpackPreflight({
          manifest: makePreflightManifest(),
          repositoryRoot: repoRoot,
          authorized: true,
          scrubber: new SecretScrubber(),
          tempRoot,
        }),
        (err: unknown) => err instanceof GitHubAppError && err.code === 'TASKPACK_SCOPE_VIOLATION',
      );
    });
  });

  it('does not hang when a detached grandchild inherits stdio FDs and respects AbortSignal', async () => {
    await withTempDirs(async (repoRoot, _outsideDir, tempRoot) => {
      const scriptPath = join(repoRoot, '.loopwright', 'scripts', 'preflight.mjs');
      await writeFile(
        scriptPath,
        `import { spawn } from 'node:child_process';
const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 10000)'], {
  detached: true,
  stdio: 'inherit',
});
child.unref();
setTimeout(() => {}, 10000);
`,
        'utf8',
      );
      const start = Date.now();
      await assert.rejects(
        runTaskpackPreflight({
          manifest: makePreflightManifest(),
          repositoryRoot: repoRoot,
          authorized: true,
          scrubber: new SecretScrubber(),
          tempRoot,
          timeoutMs: 150,
        }),
        (err: unknown) => err instanceof GitHubAppError && err.code === 'SANDBOX_EXECUTION_FAILED' && /timed out/i.test(err.message),
      );
      const elapsed = Date.now() - start;
      assert.ok(elapsed < 2_000, `expected fast timeout settle, took ${elapsed}ms`);

      // AbortSignal cancels cleanly
      const ac = new AbortController();
      setTimeout(() => ac.abort(), 120);
      await assert.rejects(
        runTaskpackPreflight({
          manifest: makePreflightManifest(),
          repositoryRoot: repoRoot,
          authorized: true,
          scrubber: new SecretScrubber(),
          tempRoot,
          timeoutMs: 5_000,
          signal: ac.signal,
        }),
        (err: unknown) => err instanceof GitHubAppError && err.code === 'SANDBOX_EXECUTION_FAILED' && /aborted/i.test(err.message),
      );
    });
  });

  it('verifies digests.lock.json before spawning preflight.script when pinDigests: true', async () => {
    await withTempDirs(async (repoRoot, _outsideDir, tempRoot) => {
      const markerPath = join(tempRoot, 'tampered-ran.txt');
      const scriptPath = join(repoRoot, '.loopwright', 'scripts', 'preflight.mjs');
      await writeFile(
        scriptPath,
        `import { writeFileSync } from 'node:fs';
writeFileSync(process.env.LOOPWRIGHT_PREFLIGHT_OUT, JSON.stringify({ disposition: 'no_change' }));
`,
        'utf8',
      );

      const manifest = makePreflightManifest({ pinDigests: true });
      const lockfile = await computeTaskpackDigests(repoRoot, manifest);
      await writeDigestLockfile(repoRoot, '.loopwright/digests.lock.json', lockfile);

      // Valid lockfile runs cleanly
      const ok = await runTaskpackPreflight({
        manifest,
        repositoryRoot: repoRoot,
        authorized: true,
        scrubber: new SecretScrubber(),
        tempRoot,
      });
      await ok.cleanup();

      // Tamper with preflight.script -> MUST fail closed BEFORE executing!
      await writeFile(
        scriptPath,
        `import { writeFileSync } from 'node:fs';
writeFileSync(${JSON.stringify(markerPath)}, 'tampered');
writeFileSync(process.env.LOOPWRIGHT_PREFLIGHT_OUT, JSON.stringify({ disposition: 'no_change' }));
`,
        'utf8',
      );
      await assert.rejects(
        runTaskpackPreflight({
          manifest,
          repositoryRoot: repoRoot,
          authorized: true,
          scrubber: new SecretScrubber(),
          tempRoot,
        }),
        (err: unknown) => err instanceof GitHubAppError && err.code === 'TASKPACK_MANIFEST_INVALID',
      );
      await assert.rejects(stat(markerPath), { code: 'ENOENT' });
    });
  });

  it('aligns PREFLIGHT_MAX_TIMEOUT_SECONDS to 3600, rejects invalid timeoutSeconds, partitions checkStagedDir, and rejects workspace path-prefix collisions & bad tempRoot', async () => {
    assert.equal(PREFLIGHT_MAX_TIMEOUT_SECONDS, 3_600);

    await withTempDirs(async (repoRoot, _outsideDir, tempRoot) => {
      const scriptPath = join(repoRoot, '.loopwright', 'scripts', 'preflight.mjs');

      // 1) Accepts 900s timeout (no silent clamp / no error for timeoutMs=900_000)
      await writeFile(
        scriptPath,
        `import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
writeFileSync(join(process.env.LOOPWRIGHT_STAGING_DIR, 'visible.bin'), Buffer.from([1, 2, 3]));
writeFileSync(join(process.env.LOOPWRIGHT_STAGING_DIR, 'private.bin'), Buffer.from([4, 5, 6]));
writeFileSync(process.env.LOOPWRIGHT_PREFLIGHT_OUT, JSON.stringify({
  disposition: 'candidate',
  stagedResources: [
    { id: 'for-checks', kind: 'document', path: 'visible.bin', mount: 'workspace', exposeToChecks: true },
    { id: 'agent-only', kind: 'document', path: 'private.bin', mount: 'workspace', exposeToChecks: false },
  ],
}));
`,
        'utf8',
      );

      const res = await runTaskpackPreflight({
        manifest: makePreflightManifest({ timeoutSeconds: 900 }),
        repositoryRoot: repoRoot,
        authorized: true,
        scrubber: new SecretScrubber(),
        tempRoot,
        timeoutMs: 900_000,
      });
      try {
        assert.ok(res.stagedDir !== null);
        assert.ok(res.checkStagedDir !== null);
        assert.notEqual(res.stagedDir, res.checkStagedDir);
        // stagedDir has both files; checkStagedDir has ONLY exposeToChecks: true file!
        assert.deepEqual(await readFile(join(res.stagedDir, 'visible.bin')), Buffer.from([1, 2, 3]));
        assert.deepEqual(await readFile(join(res.stagedDir, 'private.bin')), Buffer.from([4, 5, 6]));
        assert.deepEqual(await readFile(join(res.checkStagedDir, 'visible.bin')), Buffer.from([1, 2, 3]));
        await assert.rejects(stat(join(res.checkStagedDir, 'private.bin')), { code: 'ENOENT' });
        assert.equal((await lstat(res.checkStagedDir)).mode & 0o777, 0o555);
      } finally {
        await res.cleanup();
      }
      await assert.rejects(stat(res.checkStagedDir!), { code: 'ENOENT' });

      // 2) Rejects out-of-range unvalidated timeoutSeconds <= 0 instead of clamping
      const badTimeoutManifest: TaskpackV2Manifest = {
        ...makePreflightManifest(),
        spec: {
          ...makePreflightManifest().spec,
          preflight: { script: '.loopwright/scripts/preflight.mjs', timeoutSeconds: 0 },
        },
      };
      await assert.rejects(
        runTaskpackPreflight({
          manifest: badTimeoutManifest,
          repositoryRoot: repoRoot,
          authorized: true,
          scrubber: new SecretScrubber(),
          tempRoot,
        }),
        (err: unknown) => err instanceof GitHubAppError && err.code === 'TASKPACK_MANIFEST_INVALID',
      );

      // 3) Rejects nonexistent tempRoot with GitHubAppError
      await assert.rejects(
        runTaskpackPreflight({
          manifest: makePreflightManifest(),
          repositoryRoot: repoRoot,
          authorized: true,
          scrubber: new SecretScrubber(),
          tempRoot: join(tempRoot, 'does-not-exist'),
        }),
        (err: unknown) => err instanceof GitHubAppError && err.code === 'ACTION_INPUT_INVALID',
      );

      // 4) Rejects colliding workspace path prefixes (file `foo` vs `foo/bar`) with GitHubAppError
      await mkdir(join(repoRoot, 'foo'), { recursive: true });
      await writeFile(join(repoRoot, 'foo', 'bar'), 'nested', 'utf8');
      await writeFile(
        scriptPath,
        `import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
writeFileSync(join(process.env.LOOPWRIGHT_STAGING_DIR, 'foo'), 'file-at-foo', 'utf8');
writeFileSync(process.env.LOOPWRIGHT_PREFLIGHT_OUT, JSON.stringify({
  disposition: 'candidate',
  stagedResources: [
    { id: 'f1', kind: 'document', path: 'foo', mount: 'workspace' },
    { id: 'f2', kind: 'document', path: 'foo/bar', mount: 'workspace' },
  ],
}));
`,
        'utf8',
      );
      await assert.rejects(
        runTaskpackPreflight({
          manifest: makePreflightManifest(),
          repositoryRoot: repoRoot,
          authorized: true,
          scrubber: new SecretScrubber(),
          tempRoot,
        }),
        (err: unknown) => err instanceof GitHubAppError && err.code === 'TASKPACK_MANIFEST_INVALID',
      );

      // 5) Downgrading candidate after lockstep hold-back returns 'blocked' when a non-grouped sibling failed!
      const groupedWithFailed = makePreflightManifest({
        upstreams: [
          { id: 'pi-ai', kind: 'http-json', source: 'https://registry.npmjs.org/pi-ai', watchedPaths: ['package.json'] },
          { id: 'pi-coding', kind: 'http-json', source: 'https://registry.npmjs.org/pi-coding', watchedPaths: ['package.json'] },
          { id: 'other-err', kind: 'http-json', source: 'https://registry.npmjs.org/other', watchedPaths: ['package.json'] },
        ],
        upstreamGroups: [
          { id: 'pi-suite', members: ['pi-ai', 'pi-coding'], policy: 'lockstep' },
        ],
      });
      await writeFile(
        join(repoRoot, 'package.json'),
        JSON.stringify({ dependencies: { 'pi-ai': '^0.61.0', 'pi-coding': '^0.61.0' } }),
        'utf8',
      );
      await writeFile(
        scriptPath,
        `import { writeFileSync } from 'node:fs';
writeFileSync(process.env.LOOPWRIGHT_PREFLIGHT_OUT, JSON.stringify({
  disposition: 'candidate',
  upstreams: [
    { id: 'pi-ai', status: 'available', version: '0.62.0' },
    { id: 'pi-coding', status: 'available', version: '0.61.5' },
    { id: 'other-err', status: 'failed', reason: 'HTTP 503' },
  ],
}));
`,
        'utf8',
      );
      const blockedAfterHold = await runTaskpackPreflight({
        manifest: groupedWithFailed,
        repositoryRoot: repoRoot,
        authorized: true,
        scrubber: new SecretScrubber(),
        tempRoot,
      });
      try {
        assert.equal(blockedAfterHold.disposition, 'blocked');
        // Also verifies repository package.json baseline was forwarded when preflight omitted currentVersion!
        assert.equal(blockedAfterHold.upstreams[0]?.currentVersion, '0.61.0');
        assert.equal(blockedAfterHold.upstreams[0]?.version, '0.61.0');
      } finally {
        await blockedAfterHold.cleanup();
      }
    });
  });
});
