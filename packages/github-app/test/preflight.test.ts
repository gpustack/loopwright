import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmod, lstat, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { GitHubAppError, type GitHubAppErrorCode, type TaskpackV2Manifest } from '../src/types.js';
import { validateTaskpackV2Manifest, type Json } from '../src/schema.js';
import { SecretScrubber } from '../src/token-broker.js';
import { computeFileDigest, computeTaskpackDigests, writeDigestLockfile } from '../src/digests.js';
import {
  formatWorkspaceResourcesManifest,
  isForbiddenPreflightEnvName,
  PREFLIGHT_MAX_OUTPUT_JSON_BYTES,
  PREFLIGHT_MAX_TIMEOUT_SECONDS,
  runTaskpackPreflight,
  type RunTaskpackPreflightOptions,
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
    ...(overrides.allowHostEnv !== undefined || overrides.allowHostPath !== undefined
      ? { capabilities: { ...(overrides.allowHostEnv !== undefined ? { allowHostEnv: overrides.allowHostEnv } : {}), ...(overrides.allowHostPath !== undefined ? { allowHostPath: overrides.allowHostPath } : {}) } }
      : {}),
  };
  const preflight: Record<string, unknown> = {
    script: '.loopwright/scripts/preflight.mjs',
    ...(overrides.timeoutSeconds !== undefined ? { timeoutSeconds: overrides.timeoutSeconds } : {}),
    ...(overrides.env !== undefined ? { env: [...overrides.env] } : {}),
  };
  return validateTaskpackV2Manifest({
    apiVersion: 'loopwright.dev/v1alpha1', kind: 'Taskpack', metadata: { name: 'preflight-demo' },
    spec: {
      execution, preflight,
      goal: { candidate: 'Sync', noChange: 'Verify' },
      scope: { writable: ['docs/**'], protected: [] },
      upstreams: overrides.upstreams ?? [],
      ...(overrides.upstreamGroups !== undefined ? { upstreamGroups: overrides.upstreamGroups } : {}),
      ...(overrides.models !== undefined ? { models: overrides.models } : {}),
      ...(overrides.mcp !== undefined ? { mcp: overrides.mcp } : {}),
      verification: { localChecks: [], externalGates: overrides.externalGates ?? [] },
      publication: { mode: 'disabled', targetBranch: 'main', headBranchPrefix: 'sync/', titleTemplate: 'sync' },
      memory: { directory: '.loopwright/memory/preflight-demo', apply: 'disabled' },
      triggers: { schedule: false, workflowDispatch: true, releasePublished: false, commentCommands: [] },
    },
  } as unknown as Json, overrides.mode === 'privileged' || overrides.allowHostEnv === true || overrides.allowHostPath === true
    ? { hostPolicy: { allowPrivileged: true } }
    : undefined);
}

async function expectPreflightError(
  opts: RunTaskpackPreflightOptions,
  codes: GitHubAppErrorCode | readonly GitHubAppErrorCode[],
  msgPattern?: RegExp,
): Promise<void> {
  const allowed = Array.isArray(codes) ? codes : [codes];
  await assert.rejects(
    runTaskpackPreflight(opts),
    (err: unknown) => err instanceof GitHubAppError && allowed.includes(err.code) && (msgPattern === undefined || msgPattern.test(err.message)),
  );
}

describe('preflight.ts: authorization, authority, and digest pinning', () => {
  it('fails closed before spawning when unauthorized, privileged without hostPolicy, or digest-tampered', async () => {
    await withTempDirs(async (repoRoot, _outsideDir, tempRoot) => {
      const marker = join(tempRoot, 'ran.txt');
      const scriptPath = join(repoRoot, '.loopwright', 'scripts', 'preflight.mjs');
      await writeFile(scriptPath, `import { writeFileSync } from 'node:fs'; writeFileSync(${JSON.stringify(marker)}, 'x'); writeFileSync(process.env.LOOPWRIGHT_PREFLIGHT_OUT, '{"disposition":"no_change"}');`, 'utf8');

      await expectPreflightError({ manifest: makePreflightManifest(), repositoryRoot: repoRoot, authorized: false, scrubber: new SecretScrubber(), tempRoot }, 'WEBHOOK_ACTOR_UNAUTHORIZED');
      await expectPreflightError({ manifest: makePreflightManifest({ mode: 'privileged' }), repositoryRoot: repoRoot, authorized: true, hostPolicy: { allowPrivileged: false }, scrubber: new SecretScrubber(), tempRoot }, 'TASKPACK_HOST_BINDING_INVALID');
      await assert.rejects(stat(marker), { code: 'ENOENT' });

      // pinDigests: true runs when matching, fails closed BEFORE spawn when tampered
      await writeFile(scriptPath, `import { writeFileSync } from 'node:fs'; writeFileSync(process.env.LOOPWRIGHT_PREFLIGHT_OUT, '{"disposition":"no_change"}');`, 'utf8');
      const pinned = makePreflightManifest({ pinDigests: true });
      await writeDigestLockfile(repoRoot, '.loopwright/digests.lock.json', await computeTaskpackDigests(repoRoot, pinned));
      const ok = await runTaskpackPreflight({ manifest: pinned, repositoryRoot: repoRoot, authorized: true, scrubber: new SecretScrubber(), tempRoot });
      await ok.cleanup();

      await writeFile(scriptPath, `import { writeFileSync } from 'node:fs'; writeFileSync(${JSON.stringify(marker)}, 'tampered'); writeFileSync(process.env.LOOPWRIGHT_PREFLIGHT_OUT, '{"disposition":"no_change"}');`, 'utf8');
      await expectPreflightError({ manifest: pinned, repositoryRoot: repoRoot, authorized: true, scrubber: new SecretScrubber(), tempRoot }, 'TASKPACK_MANIFEST_INVALID');
      await assert.rejects(stat(marker), { code: 'ENOENT' });
    });
  });
});

describe('preflight.ts: environment scrubbing & credential isolation', () => {
  it('classifies forbidden credentials and injection vars, strips them in strict & privileged modes, and scrubs deep metadata & prompt leaks', async () => {
    for (const forbidden of [
      'GITHUB_TOKEN', 'GH_TOKEN', 'GITHUB_APP_PRIVATE_KEY', 'GITHUB_APP_WEBHOOK_SECRET', 'LOOPWRIGHT_LOCAL_GATE_SECRET',
      'OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'AWS_SESSION_TOKEN', 'NPM_TOKEN',
      'CUSTOM_VENDOR_API_KEY', 'MY_SIGNING_SECRET', 'SERVICE_ACCESS_TOKEN', 'SSH_PRIVATE_KEY', 'GATE_HMAC_SIGNING_KEY',
      'CUSTOM_LLM_CREDENTIAL', 'OPENAI_APIKEY', 'SERVICE_BEARER', 'AUTH_COOKIE', 'MY_SESSION_KEY', 'GH_PAT',
      'ACTIONS_RUNTIME_URL', 'RUNNER_TEMP', 'GIT_SSH_COMMAND', 'LD_PRELOAD', 'DYLD_INSERT_LIBRARIES', 'NODE_OPTIONS', 'BASH_ENV',
    ]) {
      assert.equal(isForbiddenPreflightEnvName(forbidden), true, forbidden);
    }
    assert.equal(isForbiddenPreflightEnvName('CUSTOM_SAFE_FLAG'), false);
    assert.equal(isForbiddenPreflightEnvName('NODE_ENV'), false);

    await withTempDirs(async (repoRoot, _outsideDir, tempRoot) => {
      const scriptPath = join(repoRoot, '.loopwright', 'scripts', 'preflight.mjs');
      const brokeredSecret = 'brokered-live-secret-99887766';

      // Strict mode forwards only explicit non-secret spec.preflight.env
      await writeFile(scriptPath, `import { writeFileSync } from 'node:fs';
writeFileSync(process.env.LOOPWRIGHT_PREFLIGHT_OUT, JSON.stringify({ disposition: 'no_change', reason: JSON.stringify({ allowed: process.env.ALLOWED_FLAG ?? null, unlisted: process.env.UNLISTED_HOST_VAR ?? null, github: process.env.GITHUB_TOKEN ?? null }) }));`, 'utf8');
      const strictRes = await runTaskpackPreflight({
        manifest: makePreflightManifest({ mode: 'strict', env: ['ALLOWED_FLAG'] }),
        repositoryRoot: repoRoot, authorized: true, scrubber: new SecretScrubber(), tempRoot,
        env: { ALLOWED_FLAG: 'yes', UNLISTED_HOST_VAR: 'nope', GITHUB_TOKEN: 'ghp_12345678901234567890' },
      });
      try {
        assert.equal(strictRes.scriptSha256, await computeFileDigest(repoRoot, '.loopwright/scripts/preflight.mjs'));
        assert.deepEqual(JSON.parse(strictRes.reason ?? '{}'), { allowed: 'yes', unlisted: null, github: null });
      } finally {
        await strictRes.cleanup();
      }

      // Privileged mode still strips forbidden/manifest-declared/injection vars and scrubs brokeredEnv across deep metadata keys & values
      await writeFile(scriptPath, `import { writeFileSync } from 'node:fs';
const deep = { d1: { d2: { d3: { d4: { d5: { d6: { d7: { ['key_' + process.env.BROKERED_CUSTOM]: 'val_' + process.env.BROKERED_CUSTOM } } } } } } } };
writeFileSync(process.env.LOOPWRIGHT_PREFLIGHT_OUT, JSON.stringify({
  disposition: 'no_change',
  reason: JSON.stringify({
    leaked: ['GITHUB_TOKEN','OPENAI_API_KEY','LOOPWRIGHT_PROVIDER_TOKEN','CUSTOM_GATE_ENV','CUSTOM_MODEL_ENV','CUSTOM_MCP_ENV','LD_PRELOAD','ACTIONS_ID_TOKEN_REQUEST_URL'].filter(k => k in process.env),
    safe: process.env.SAFE_HOST_FLAG ?? null,
    brokeredEcho: process.env.BROKERED_CUSTOM ?? null,
  }),
  upstreams: [{ id: 'u1', status: 'up_to_date', version: '1.0.0', metadata: deep }],
}));`, 'utf8');

      const basePriv = makePreflightManifest({
        mode: 'privileged',
        models: [{ provider: 'openai', id: 'gpt-5', apiKeyEnv: 'CUSTOM_MODEL_ENV' }],
        mcp: { servers: [{ id: 'docs', transport: 'http', url: 'https://mcp.example.com/sse', bearerTokenEnv: 'CUSTOM_MCP_ENV' }] },
        externalGates: [{ id: 'ext', gateId: 'g1', endpointId: 'ep1', required: true, signingCredentialRef: 'CUSTOM_GATE_ENV' }],
      });
      const forgedPriv: TaskpackV2Manifest = {
        ...basePriv,
        spec: { ...basePriv.spec, preflight: { ...basePriv.spec.preflight!, env: ['SAFE_HOST_FLAG', 'GITHUB_TOKEN', 'CUSTOM_GATE_ENV', 'CUSTOM_MODEL_ENV', 'CUSTOM_MCP_ENV'] } },
      };
      const privRes = await runTaskpackPreflight({
        manifest: forgedPriv, repositoryRoot: repoRoot, authorized: true, hostPolicy: { allowPrivileged: true }, scrubber: new SecretScrubber(), tempRoot,
        env: { PATH: process.env['PATH'] ?? '/usr/bin:/bin', SAFE_HOST_FLAG: 'ok', GITHUB_TOKEN: 'ghp_x', OPENAI_API_KEY: 'sk-x', LOOPWRIGHT_PROVIDER_TOKEN: 'sk-lw', CUSTOM_GATE_ENV: 's1', CUSTOM_MODEL_ENV: 's2', CUSTOM_MCP_ENV: 's3', LD_PRELOAD: '/tmp/x.so', ACTIONS_ID_TOKEN_REQUEST_URL: 'https://oidc' },
        brokeredEnv: { BROKERED_CUSTOM: brokeredSecret, LOOPWRIGHT_PREFLIGHT_OUT: '/tmp/hijack.json' },
      });
      try {
        const obs = JSON.parse(privRes.reason ?? '{}') as Record<string, unknown>;
        assert.deepEqual(obs['leaked'], []);
        assert.equal(obs['safe'], 'ok');
        assert.equal(obs['brokeredEcho'], '[scrubbed]');
        const metaJson = JSON.stringify(privRes.upstreams[0]?.metadata ?? {});
        assert.equal(metaJson.includes(brokeredSecret), false);
        assert.match(metaJson, /key_\[scrubbed\].*val_\[scrubbed\]/);
      } finally {
        await privRes.cleanup();
      }

      // Secret leaked into mount: prompt staged resource fails closed
      await writeFile(scriptPath, `import { writeFileSync } from 'node:fs'; import { join } from 'node:path';
writeFileSync(join(process.env.LOOPWRIGHT_STAGING_DIR, 'leak.md'), 'secret=' + process.env.BROKERED_CUSTOM, 'utf8');
writeFileSync(process.env.LOOPWRIGHT_PREFLIGHT_OUT, JSON.stringify({ disposition: 'candidate', stagedResources: [{ id: 'leaked', kind: 'instruction', path: 'leak.md', mount: 'prompt' }] }));`, 'utf8');
      await expectPreflightError({
        manifest: makePreflightManifest(), repositoryRoot: repoRoot, authorized: true, scrubber: new SecretScrubber(), tempRoot,
        brokeredEnv: { BROKERED_CUSTOM: brokeredSecret },
      }, 'TOKEN_SECRET_LEAK_DETECTED');
    });
  });
});

describe('preflight.ts: dispositions, lockstep groups, and split stagedResources', () => {
  it('handles candidate/blocked/lockstep dispositions and forwards package.json baselines', async () => {
    await withTempDirs(async (repoRoot, _outsideDir, tempRoot) => {
      const scriptPath = join(repoRoot, '.loopwright', 'scripts', 'preflight.mjs');
      await writeFile(join(repoRoot, 'package.json'), JSON.stringify({ dependencies: { 'pi-ai': '^0.61.0', 'pi-coding': '^0.61.0' } }), 'utf8');
      const manifest = makePreflightManifest({
        upstreams: [
          { id: 'pi-ai', kind: 'http-json', source: 'https://registry.npmjs.org/pi-ai', watchedPaths: ['package.json'] },
          { id: 'pi-coding', kind: 'http-json', source: 'https://registry.npmjs.org/pi-coding', watchedPaths: ['package.json'] },
          { id: 'yaml-pkg', kind: 'http-json', source: 'https://registry.npmjs.org/yaml', watchedPaths: ['packages/github-app/package.json'] },
        ],
        upstreamGroups: [{ id: 'pi-suite', members: ['pi-ai', 'pi-coding'], policy: 'lockstep' }],
      });

      // Mixed available + held_back + lockstep mismatch: sibling available -> candidate
      await writeFile(scriptPath, `import { writeFileSync } from 'node:fs';
writeFileSync(process.env.LOOPWRIGHT_PREFLIGHT_OUT, JSON.stringify({
  disposition: 'candidate',
  upstreams: [
    { id: 'pi-ai', status: 'available', version: '0.62.0' },
    { id: 'pi-coding', status: 'available', version: '0.61.5' },
    { id: 'yaml-pkg', status: 'available', version: '2.9.2', currentVersion: '2.9.1', metadata: { verified: true } },
  ],
}));`, 'utf8');
      const res1 = await runTaskpackPreflight({ manifest, repositoryRoot: repoRoot, authorized: true, scrubber: new SecretScrubber(), tempRoot });
      try {
        assert.equal(res1.disposition, 'candidate');
        assert.equal(res1.upstreams[0]?.status, 'held_back');
        assert.equal(res1.upstreams[0]?.currentVersion, '0.61.0');
        assert.equal(res1.upstreams[0]?.version, '0.61.0');
        assert.equal(res1.upstreams[2]?.status, 'available');
        assert.deepEqual(res1.upstreams[2]?.watchedPaths, ['packages/github-app/package.json']);
      } finally {
        await res1.cleanup();
      }

      // Lockstep mismatch + failed sibling -> blocked
      await writeFile(scriptPath, `import { writeFileSync } from 'node:fs';
writeFileSync(process.env.LOOPWRIGHT_PREFLIGHT_OUT, JSON.stringify({
  disposition: 'candidate',
  upstreams: [
    { id: 'pi-ai', status: 'available', version: '0.62.0' },
    { id: 'pi-coding', status: 'available', version: '0.61.5' },
    { id: 'yaml-pkg', status: 'failed', reason: 'HTTP 503' },
  ],
}));`, 'utf8');
      const res2 = await runTaskpackPreflight({ manifest, repositoryRoot: repoRoot, authorized: true, scrubber: new SecretScrubber(), tempRoot });
      try {
        assert.equal(res2.disposition, 'blocked');
      } finally {
        await res2.cleanup();
      }
    });
  });

  it('splits prompt vs read-only workspace stagedResources, partitions checkStagedDir, and rejects invalid prompt bytes or path collisions', async () => {
    assert.equal(PREFLIGHT_MAX_TIMEOUT_SECONDS, 3_600);
    await withTempDirs(async (repoRoot, _outsideDir, tempRoot) => {
      await mkdir(join(repoRoot, 'docs'), { recursive: true });
      await writeFile(join(repoRoot, 'docs', 'guide.md'), '# Guide\n', 'utf8');
      const scriptPath = join(repoRoot, '.loopwright', 'scripts', 'preflight.mjs');
      const expectedBin = Buffer.from([0x1f, 0x8b, 0x08, 0x00, 0x00, 0xff, 0xfe, 0x80, 0x81, 0x00, 0xde, 0xad]);

      await writeFile(scriptPath, `import { mkdirSync, writeFileSync } from 'node:fs'; import { join } from 'node:path';
const s = process.env.LOOPWRIGHT_STAGING_DIR;
mkdirSync(join(s, 'cache'), { recursive: true });
writeFileSync(join(s, 'skill.md'), '# Skill\\n', 'utf8');
writeFileSync(join(s, 'package-lock.json'), JSON.stringify({ lockfileVersion: 3, pad: 'x'.repeat(120 * 1024) }), 'utf8');
writeFileSync(join(s, 'cache', 'pkg.tgz'), Buffer.from(${JSON.stringify([...expectedBin])}));
writeFileSync(join(s, 'agent-only.bin'), Buffer.from([4, 5, 6]));
writeFileSync(process.env.LOOPWRIGHT_PREFLIGHT_OUT, JSON.stringify({
  disposition: 'candidate',
  stagedResources: [
    { id: 'guide', kind: 'instruction', path: 'docs/guide.md' },
    { id: 'skill', kind: 'skill', path: 'skill.md' },
    { id: 'lock', kind: 'document', path: 'package-lock.json', exposeToChecks: true },
    { id: 'tgz', kind: 'document', path: 'cache/pkg.tgz', mount: 'workspace', exposeToChecks: true },
    { id: 'agent-only', kind: 'document', path: 'agent-only.bin', mount: 'workspace', exposeToChecks: false },
  ],
}));`, 'utf8');

      const res = await runTaskpackPreflight({
        manifest: makePreflightManifest({ timeoutSeconds: 900 }), repositoryRoot: repoRoot, authorized: true, scrubber: new SecretScrubber(), tempRoot, timeoutMs: 900_000,
      });
      try {
        assert.deepEqual(res.promptResources.map(r => r.id), ['guide', 'skill']);
        assert.ok(res.stagedDir !== null && res.checkStagedDir !== null && res.stagedDir !== res.checkStagedDir);
        const tgz = res.workspaceResources.find(r => r.id === 'tgz')!;
        assert.equal(tgz.sha256, createHash('sha256').update(expectedBin).digest('hex'));
        assert.deepEqual(await readFile(tgz.stagedPath), expectedBin);
        assert.equal((await lstat(res.stagedDir)).mode & 0o777, 0o555);
        assert.equal((await lstat(tgz.stagedPath)).mode & 0o777, 0o444);
        assert.deepEqual(await readFile(join(res.checkStagedDir, 'cache', 'pkg.tgz')), expectedBin);
        await assert.rejects(stat(join(res.checkStagedDir, 'agent-only.bin')), { code: 'ENOENT' });

        const summary = formatWorkspaceResourcesManifest(res.workspaceResources);
        assert.equal(summary.includes('xxxx'), false);
        assert.equal(summary.includes('readOnlyPath='), false);
        const withPtr = formatWorkspaceResourcesManifest(res.workspaceResources, res.stagedDir, new SecretScrubber());
        assert.equal(withPtr.includes(`readOnlyPath=${join(res.stagedDir, 'cache', 'pkg.tgz')}`), true);
      } finally {
        await res.cleanup();
      }
      await assert.rejects(stat(res.stagedDir!), { code: 'ENOENT' });
      await assert.rejects(stat(res.checkStagedDir!), { code: 'ENOENT' });

      // Invalid UTF-8, NUL byte in mount: prompt, and workspace path-prefix collision rejected
      for (const setup of [
        `writeFileSync(join(process.env.LOOPWRIGHT_STAGING_DIR, 'bad.bin'), Buffer.from([0xff, 0xfe, 0x80]));
         writeFileSync(process.env.LOOPWRIGHT_PREFLIGHT_OUT, JSON.stringify({ disposition: 'candidate', stagedResources: [{ id: 'b', kind: 'instruction', path: 'bad.bin', mount: 'prompt' }] }));`,
        `writeFileSync(join(process.env.LOOPWRIGHT_STAGING_DIR, 'nul.txt'), 'a\\0b', 'utf8');
         writeFileSync(process.env.LOOPWRIGHT_PREFLIGHT_OUT, JSON.stringify({ disposition: 'candidate', stagedResources: [{ id: 'n', kind: 'instruction', path: 'nul.txt', mount: 'prompt' }] }));`,
      ]) {
        await writeFile(scriptPath, `import { writeFileSync } from 'node:fs'; import { join } from 'node:path'; ${setup}`, 'utf8');
        await expectPreflightError({ manifest: makePreflightManifest(), repositoryRoot: repoRoot, authorized: true, scrubber: new SecretScrubber(), tempRoot }, 'TASKPACK_MANIFEST_INVALID');
      }
      await mkdir(join(repoRoot, 'foo'), { recursive: true });
      await writeFile(join(repoRoot, 'foo', 'bar'), 'nested', 'utf8');
      await writeFile(scriptPath, `import { writeFileSync } from 'node:fs'; import { join } from 'node:path';
writeFileSync(join(process.env.LOOPWRIGHT_STAGING_DIR, 'foo'), 'file', 'utf8');
writeFileSync(process.env.LOOPWRIGHT_PREFLIGHT_OUT, JSON.stringify({ disposition: 'candidate', stagedResources: [{ id: 'f1', kind: 'document', path: 'foo', mount: 'workspace' }, { id: 'f2', kind: 'document', path: 'foo/bar', mount: 'workspace' }] }));`, 'utf8');
      await expectPreflightError({ manifest: makePreflightManifest(), repositoryRoot: repoRoot, authorized: true, scrubber: new SecretScrubber(), tempRoot }, 'TASKPACK_MANIFEST_INVALID');
    });
  });
});

describe('preflight.ts: filesystem confinement, output bounds, timeout, and abort', () => {
  it('blocks symlink/hardlink escapes, escaping paths, oversized/duplicate JSON, bad timeoutSeconds/tempRoot', async () => {
    await withTempDirs(async (repoRoot, outsideDir, tempRoot) => {
      const secretFile = join(outsideDir, 'host-secret.txt');
      await writeFile(secretFile, 'TOP_SECRET', 'utf8');
      await chmod(secretFile, 0o755);
      const outsideJson = join(outsideDir, 'out.json');
      await writeFile(outsideJson, '{"disposition":"no_change"}', 'utf8');
      const scriptPath = join(repoRoot, '.loopwright', 'scripts', 'preflight.mjs');

      // Symlinked preflight script
      await symlink(secretFile, scriptPath);
      await expectPreflightError({ manifest: makePreflightManifest(), repositoryRoot: repoRoot, authorized: true, scrubber: new SecretScrubber(), tempRoot }, 'TASKPACK_SCOPE_VIOLATION');
      await rm(scriptPath);

      const cases: Array<{ readonly code: string; readonly expect: GitHubAppErrorCode | readonly GitHubAppErrorCode[] }> = [
        { code: `symlinkSync(${JSON.stringify(secretFile)}, join(process.env.LOOPWRIGHT_STAGING_DIR, 'l.txt')); writeFileSync(process.env.LOOPWRIGHT_PREFLIGHT_OUT, JSON.stringify({ disposition: 'candidate', stagedResources: [{ id: 's', kind: 'document', path: 'l.txt', mount: 'workspace' }] }));`, expect: 'TASKPACK_SCOPE_VIOLATION' },
        { code: `linkSync(${JSON.stringify(secretFile)}, join(process.env.LOOPWRIGHT_STAGING_DIR, 'h.txt')); writeFileSync(process.env.LOOPWRIGHT_PREFLIGHT_OUT, JSON.stringify({ disposition: 'candidate', stagedResources: [{ id: 'h', kind: 'instruction', path: 'h.txt', mount: 'prompt' }] }));`, expect: 'TASKPACK_SCOPE_VIOLATION' },
        { code: `writeFileSync(process.env.LOOPWRIGHT_PREFLIGHT_OUT, JSON.stringify({ disposition: 'candidate', stagedResources: [{ id: 'e', kind: 'document', path: '../outside/host-secret.txt', mount: 'workspace' }] }));`, expect: ['TASKPACK_SCOPE_VIOLATION', 'TASKPACK_MANIFEST_INVALID'] },
        { code: `writeFileSync(process.env.LOOPWRIGHT_PREFLIGHT_OUT, JSON.stringify({ disposition: 'candidate', stagedResources: [{ id: 'a', kind: 'document', path: ${JSON.stringify(secretFile)}, mount: 'workspace' }] }));`, expect: 'TASKPACK_SCOPE_VIOLATION' },
        { code: `symlinkSync(${JSON.stringify(outsideJson)}, process.env.LOOPWRIGHT_PREFLIGHT_OUT);`, expect: 'TASKPACK_SCOPE_VIOLATION' },
        { code: `linkSync(${JSON.stringify(outsideJson)}, process.env.LOOPWRIGHT_PREFLIGHT_OUT);`, expect: 'TASKPACK_SCOPE_VIOLATION' },
        { code: `writeFileSync(process.env.LOOPWRIGHT_PREFLIGHT_OUT, JSON.stringify({ disposition: 'no_change', reason: 'a'.repeat(${PREFLIGHT_MAX_OUTPUT_JSON_BYTES + 1024}) }));`, expect: 'TASKPACK_MANIFEST_INVALID' },
        { code: `writeFileSync(process.env.LOOPWRIGHT_PREFLIGHT_OUT, '{"disposition":"candidate","disposition":"no_change"}');`, expect: 'TASKPACK_MANIFEST_INVALID' },
      ];
      for (const c of cases) {
        await writeFile(scriptPath, `import { linkSync, symlinkSync, writeFileSync } from 'node:fs'; import { join } from 'node:path'; ${c.code}`, 'utf8');
        await expectPreflightError({ manifest: makePreflightManifest(), repositoryRoot: repoRoot, authorized: true, scrubber: new SecretScrubber(), tempRoot }, c.expect);
      }
      // Hardlink rejection must never chmod the host file
      assert.equal((await lstat(secretFile)).mode & 0o777, 0o755);

      const badTimeout: TaskpackV2Manifest = { ...makePreflightManifest(), spec: { ...makePreflightManifest().spec, preflight: { script: '.loopwright/scripts/preflight.mjs', timeoutSeconds: 0 } } };
      await expectPreflightError({ manifest: badTimeout, repositoryRoot: repoRoot, authorized: true, scrubber: new SecretScrubber(), tempRoot }, 'TASKPACK_MANIFEST_INVALID');
      await expectPreflightError({ manifest: makePreflightManifest(), repositoryRoot: repoRoot, authorized: true, scrubber: new SecretScrubber(), tempRoot: join(tempRoot, 'missing') }, 'ACTION_INPUT_INVALID');
    });
  });

  it('scrubs stdout/stderr/errors, settles fast on detached grandchild timeout, and respects AbortSignal', async () => {
    await withTempDirs(async (repoRoot, _outsideDir, tempRoot) => {
      const scriptPath = join(repoRoot, '.loopwright', 'scripts', 'preflight.mjs');
      const secretVal = 'sk-super-secret-preflight-value-987654321';
      const scrubber = new SecretScrubber();
      scrubber.register(secretVal);

      await writeFile(scriptPath, `import { writeFileSync } from 'node:fs';
console.log('out ${secretVal}'); console.error('err ${secretVal}');
writeFileSync(process.env.LOOPWRIGHT_PREFLIGHT_OUT, JSON.stringify({ disposition: 'no_change', reason: 'r ${secretVal}' }));`, 'utf8');
      const ok = await runTaskpackPreflight({ manifest: makePreflightManifest(), repositoryRoot: repoRoot, authorized: true, scrubber, tempRoot });
      try {
        assert.equal(ok.stdout.includes(secretVal) || ok.stderr.includes(secretVal) || (ok.reason ?? '').includes(secretVal), false);
        assert.match(ok.stdout, /\[scrubbed\]/);
      } finally {
        await ok.cleanup();
      }

      // Detached grandchild inheriting stdio must not hang timeout, and stderr secrets stay scrubbed
      await writeFile(scriptPath, `import { spawn } from 'node:child_process';
console.error('hang ${secretVal}');
spawn(process.execPath, ['-e', 'setTimeout(() => {}, 10000)'], { detached: true, stdio: 'inherit' }).unref();
setTimeout(() => {}, 10000);`, 'utf8');
      const t0 = Date.now();
      let caught: unknown;
      try {
        await runTaskpackPreflight({ manifest: makePreflightManifest(), repositoryRoot: repoRoot, authorized: true, scrubber, tempRoot, timeoutMs: 180 });
      } catch (e) { caught = e; }
      assert.ok(caught instanceof GitHubAppError && caught.code === 'SANDBOX_EXECUTION_FAILED' && /timed out/i.test(caught.message));
      assert.equal(caught.message.includes(secretVal), false);
      assert.ok(Date.now() - t0 < 2_000);

      const ac = new AbortController();
      setTimeout(() => ac.abort(), 120);
      await expectPreflightError({ manifest: makePreflightManifest(), repositoryRoot: repoRoot, authorized: true, scrubber, tempRoot, timeoutMs: 5_000, signal: ac.signal }, 'SANDBOX_EXECUTION_FAILED', /aborted/i);
    });
  });
});
