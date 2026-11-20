import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { lstat, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import {
  ALWAYS_PROTECTED_WORKSPACE_SUBPATHS, compileLinuxBwrapCommand, compileMacosSeatbeltProfile,
  computeSandboxSeccompProfile, executeSandboxedCommand, negotiateSandboxBackend,
  resolveEffectiveTaskpackSandboxPolicy, SANDBOX_CAPABILITIES_BY_BACKEND, SECCOMP_BLOCKED_SYSCALLS,
} from '../src/sandbox.js';
import { loadDeclarativeTaskpack } from '../src/taskpack.js';
import { GitHubAppError, type SandboxBackendId } from '../src/types.js';

async function withTempWorkspace(run: (workspaceRoot: string, scratchDir: string) => Promise<void>): Promise<void> {
  const base = await realpath(tmpdir());
  const workspaceRoot = await mkdtemp(join(base, 'lw-sandbox-ws-'));
  const scratchDir = await mkdtemp(join(base, 'lw-sandbox-scratch-'));
  try {
    await mkdir(join(workspaceRoot, 'docs'), { recursive: true });
    await mkdir(join(workspaceRoot, '.git'), { recursive: true });
    await writeFile(join(workspaceRoot, '.git', 'config'), '[core]\nrepositoryformatversion = 0\n', 'utf8');
    await writeFile(join(workspaceRoot, 'AGENTS.md'), '# Agents\n', 'utf8');
    await run(workspaceRoot, scratchDir);
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true });
    await rm(scratchDir, { recursive: true, force: true });
  }
}

describe('macOS Seatbelt SBPL profile compiler (AC-1)', () => {
  it('compiles deterministic SBPL with realpath normalization, write allowlist, and post-allowlist protected-path re-denial', async () => {
    await withTempWorkspace(async (workspaceRoot, scratchDir) => {
      const first = compileMacosSeatbeltProfile(
        {
          workspaceRoot,
          writablePaths: ['docs'],
          protectedPaths: ['docs/protected-notes.md'],
          deniedReadPaths: ['~/.ssh'],
          scratchDirectory: scratchDir,
          networkMode: 'none',
        },
        { platform: 'darwin', arch: 'arm64', homeDirectory: '/var/empty', probeExecutables: false },
      );
      const second = compileMacosSeatbeltProfile(
        {
          workspaceRoot,
          writablePaths: ['docs'],
          protectedPaths: ['docs/protected-notes.md'],
          deniedReadPaths: ['~/.ssh'],
          scratchDirectory: scratchDir,
          networkMode: 'none',
        },
        { platform: 'darwin', arch: 'arm64', homeDirectory: '/var/empty', probeExecutables: false },
      );

      assert.equal(first.backendId, 'macos-seatbelt');
      assert.equal(first.executablePath, '/usr/bin/sandbox-exec');
      assert.equal(first.profileText, second.profileText);
      assert.deepEqual(first.profileDigest, second.profileDigest);
      assert.equal(first.profileDigest.hex.length, 64);

      const globalDenyWriteIdx = first.profileText.indexOf('(deny file-write*)');
      const allowWritableIdx = first.profileText.indexOf(`(subpath "${join(workspaceRoot, 'docs')}")`);
      const reDenyProtectedIdx = first.profileText.lastIndexOf(`(subpath "${join(workspaceRoot, 'docs', 'protected-notes.md')}")`);
      const reDenyGitIdx = first.profileText.lastIndexOf(`(subpath "${join(workspaceRoot, '.git')}")`);
      assert.ok(globalDenyWriteIdx > 0, 'must include global (deny file-write*)');
      assert.ok(allowWritableIdx > globalDenyWriteIdx, 'writable subpath grant must follow global write denial');
      assert.ok(reDenyProtectedIdx > allowWritableIdx, 'protected subpath write denial must follow writable grant (last-match-wins)');
      assert.ok(reDenyGitIdx > allowWritableIdx, '.git write denial must follow writable grant');
      assert.ok(first.profileText.includes('(deny network*)'));
    });
  });

  it('emits localhost-only rules for loopback-only networkMode and omits network denial for allow-outbound', async () => {
    await withTempWorkspace(async workspaceRoot => {
      const loopback = compileMacosSeatbeltProfile(
        { workspaceRoot, writablePaths: ['docs'], networkMode: 'loopback-only' },
        { platform: 'darwin', arch: 'arm64', probeExecutables: false },
      );
      assert.ok(loopback.profileText.includes('(deny network*)'));
      assert.ok(loopback.profileText.includes('(allow network-outbound (remote ip "localhost:*"))'));
      assert.ok(loopback.profileText.includes('(allow network-inbound (local ip "localhost:*"))'));

      const outbound = compileMacosSeatbeltProfile(
        { workspaceRoot, writablePaths: ['docs'], networkMode: 'allow-outbound' },
        { platform: 'darwin', arch: 'arm64', probeExecutables: false },
      );
      assert.equal(outbound.profileText.includes('(deny network*)'), false);
    });
  });

  it('rejects invalid policies: escaping writable paths, quote injection, or writable targeting protected paths', async () => {
    await withTempWorkspace(async workspaceRoot => {
      assert.throws(
        () => compileMacosSeatbeltProfile({ workspaceRoot, writablePaths: ['../outside'] }, { platform: 'darwin', arch: 'arm64', probeExecutables: false }),
        (err: unknown) => err instanceof GitHubAppError && err.code === 'SANDBOX_POLICY_INVALID',
      );
      assert.throws(
        () => compileMacosSeatbeltProfile({ workspaceRoot, writablePaths: ['docs"injected'] }, { platform: 'darwin', arch: 'arm64', probeExecutables: false }),
        (err: unknown) => err instanceof GitHubAppError && err.code === 'SANDBOX_POLICY_INVALID',
      );
      assert.throws(
        () => compileMacosSeatbeltProfile({ workspaceRoot, writablePaths: ['.github/workflows'] }, { platform: 'darwin', arch: 'arm64', probeExecutables: false }),
        (err: unknown) => err instanceof GitHubAppError && err.code === 'SANDBOX_POLICY_INVALID',
      );
      assert.throws(
        () => compileMacosSeatbeltProfile({ workspaceRoot, writablePaths: ['.codex'] }, { platform: 'darwin', arch: 'arm64', probeExecutables: false }),
        (err: unknown) => err instanceof GitHubAppError && err.code === 'SANDBOX_POLICY_INVALID',
      );
      assert.throws(
        () => compileMacosSeatbeltProfile({ workspaceRoot, writablePaths: ['.codex/config.toml'] }, { platform: 'darwin', arch: 'arm64', probeExecutables: false }),
        (err: unknown) => err instanceof GitHubAppError && err.code === 'SANDBOX_POLICY_INVALID',
      );
      const codexSeatbelt = compileMacosSeatbeltProfile(
        { workspaceRoot, writablePaths: ['docs'] },
        { platform: 'darwin', arch: 'arm64', probeExecutables: false },
      );
      assert.ok(
        codexSeatbelt.canonicalProtectedPaths.includes(join(workspaceRoot, '.codex')),
        'macOS Seatbelt profile must protect .codex by default',
      );
      assert.throws(
        () => compileMacosSeatbeltProfile({ workspaceRoot, writablePaths: ['docs'] }, { platform: 'darwin', arch: 'arm64', seatbeltExecutable: '/tmp/fake-sandbox-exec', probeExecutables: false }),
        (err: unknown) => err instanceof GitHubAppError && err.code === 'SANDBOX_BACKEND_UNAVAILABLE',
      );
    });
  });
});

describe('Linux Bubblewrap and seccomp compiler (AC-2)', () => {
  it('compiles deterministic bwrap arguments with namespace isolation and read-only protected masks after writable binds', async () => {
    await withTempWorkspace(async (workspaceRoot, scratchDir) => {
      const compiled = compileLinuxBwrapCommand(
        {
          workspaceRoot,
          writablePaths: ['docs'],
          protectedPaths: ['docs/protected-notes.md'],
          deniedReadPaths: ['~/.ssh'],
          scratchDirectory: scratchDir,
          networkMode: 'none',
        },
        { platform: 'linux', arch: 'x64', homeDirectory: '/var/empty/runner-home', probeExecutables: false },
      );

      assert.equal(compiled.backendId, 'linux-bwrap');
      assert.equal(compiled.executablePath, '/usr/bin/bwrap');
      assert.ok(compiled.args.includes('--unshare-all'));
      assert.equal(compiled.args.includes('--share-net'), false);
      assert.ok(compiled.args.includes('--die-with-parent'));
      assert.ok(compiled.args.includes('--new-session'));
      assert.equal(
        compiled.args.some((arg, idx) => arg === '--tmpfs' && compiled.args[idx + 1] === '/tmp'),
        false,
        'must not mount unconditional writable tmpfs over /tmp',
      );
      const expectedSshPath = compiled.canonicalDeniedReadPaths.find(p => p.endsWith('/.ssh'));
      assert.ok(expectedSshPath !== undefined);
      const deniedSshIdx = compiled.args.findIndex(
        (arg, idx) =>
          arg === '--tmpfs' &&
          compiled.args[idx + 1] === expectedSshPath &&
          compiled.args[idx + 2] === '--remount-ro' &&
          compiled.args[idx + 3] === expectedSshPath,
      );
      assert.ok(deniedSshIdx > 0, 'must emit read-only tmpfs mask for denied paths when probeExecutables is false');

      const bindDocsIdx = compiled.args.findIndex(
        (arg, idx) => arg === '--bind' && compiled.args[idx + 1] === join(workspaceRoot, 'docs'),
      );
      const roMaskProtectedIdx = compiled.args.findIndex(
        (arg, idx) => arg === '--ro-bind-try' && compiled.args[idx + 1] === join(workspaceRoot, 'docs', 'protected-notes.md'),
      );
      const roMaskGitIdx = compiled.args.findIndex(
        (arg, idx) => arg === '--ro-bind-try' && compiled.args[idx + 1] === join(workspaceRoot, '.git'),
      );
      assert.ok(bindDocsIdx > 0, 'must bind writable docs directory');
      assert.ok(roMaskProtectedIdx > bindDocsIdx, '--ro-bind-try for protected path must follow --bind');
      assert.ok(roMaskGitIdx > bindDocsIdx, '--ro-bind-try for .git must follow --bind');

      for (const builtIn of ALWAYS_PROTECTED_WORKSPACE_SUBPATHS) {
        assert.ok(
          compiled.canonicalProtectedPaths.includes(join(workspaceRoot, builtIn)),
          `missing built-in protected path ${builtIn}`,
        );
      }
      assert.ok(
        compiled.canonicalProtectedPaths.includes(join(workspaceRoot, '.codex')),
        'linux-bwrap policy must protect .codex by default',
      );

      const seccomp = computeSandboxSeccompProfile();
      assert.equal(compiled.seccompProfileJson, seccomp.json);
      assert.deepEqual(compiled.seccompDigest, seccomp.digest);
      const parsedSeccomp = JSON.parse(seccomp.json) as { defaultAction: string; syscalls: { names: string[]; action: string }[] };
      assert.equal(parsedSeccomp.defaultAction, 'SCMP_ACT_ALLOW');
      assert.deepEqual(parsedSeccomp.syscalls[0]?.names, [...SECCOMP_BLOCKED_SYSCALLS]);
    });
  });

  it('adds --share-net only when networkMode is allow-outbound and refuses untrusted bwrap paths', async () => {
    await withTempWorkspace(async workspaceRoot => {
      const outbound = compileLinuxBwrapCommand(
        { workspaceRoot, writablePaths: ['docs'], networkMode: 'allow-outbound' },
        { platform: 'linux', arch: 'arm64', probeExecutables: false },
        { env: { GIT_TERMINAL_PROMPT: '1', GIT_CONFIG_GLOBAL: '/tmp/custom' } },
      );
      assert.ok(outbound.args.includes('--share-net'));
      const promptIdx = outbound.args.findIndex((arg, idx) => arg === '--setenv' && outbound.args[idx + 1] === 'GIT_TERMINAL_PROMPT');
      assert.ok(promptIdx > 0 && outbound.args[promptIdx + 2] === '0', 'must pin GIT_TERMINAL_PROMPT=0 over caller env');
      const globalIdx = outbound.args.findIndex((arg, idx) => arg === '--setenv' && outbound.args[idx + 1] === 'GIT_CONFIG_GLOBAL');
      assert.ok(globalIdx > 0 && outbound.args[globalIdx + 2] === '/dev/null', 'must pin GIT_CONFIG_GLOBAL=/dev/null over caller env');

      assert.throws(
        () => compileLinuxBwrapCommand(
          { workspaceRoot, writablePaths: ['docs'] },
          { platform: 'linux', arch: 'arm64', bwrapExecutable: '/tmp/untrusted-bwrap', probeExecutables: false },
        ),
        (err: unknown) => err instanceof GitHubAppError && err.code === 'SANDBOX_BACKEND_UNAVAILABLE',
      );
    });
  });

  it('masks existing denied directories with read-only tmpfs, existing denied files with /dev/null, and skips missing denied paths when probing', async () => {
    await withTempWorkspace(async (workspaceRoot, scratchDir) => {
      const deniedRoot = await mkdtemp(join(await realpath(tmpdir()), 'lw-sandbox-denied-'));
      try {
        const existingDeniedDir = join(deniedRoot, 'ssh-dir');
        const existingDeniedFile = join(deniedRoot, 'netrc-file');
        const missingDeniedPath = join(deniedRoot, 'does-not-exist');
        await mkdir(existingDeniedDir, { recursive: true });
        await writeFile(existingDeniedFile, 'machine api.github.com\n', 'utf8');

        const compiled = compileLinuxBwrapCommand(
          {
            workspaceRoot,
            writablePaths: ['docs'],
            scratchDirectory: scratchDir,
            deniedReadPaths: [existingDeniedDir, existingDeniedFile, missingDeniedPath],
          },
          { platform: 'linux', arch: 'x64', homeDirectory: '/var/empty/nonexistent-home', probeExecutables: true },
        );

        const dirMaskIdx = compiled.args.findIndex(
          (arg, idx) =>
            arg === '--tmpfs' &&
            compiled.args[idx + 1] === existingDeniedDir &&
            compiled.args[idx + 2] === '--remount-ro' &&
            compiled.args[idx + 3] === existingDeniedDir,
        );
        assert.ok(dirMaskIdx > 0, 'existing denied directory must be masked with read-only tmpfs');

        const fileMaskIdx = compiled.args.findIndex(
          (arg, idx) =>
            arg === '--ro-bind' &&
            compiled.args[idx + 1] === '/dev/null' &&
            compiled.args[idx + 2] === existingDeniedFile,
        );
        assert.ok(fileMaskIdx > 0, 'existing denied file must be masked with /dev/null');

        assert.equal(compiled.args.includes(missingDeniedPath), false, 'missing denied path must be skipped');
      } finally {
        await rm(deniedRoot, { recursive: true, force: true });
      }
    });
  });
});

describe('fail-closed sandbox backend negotiation (AC-3)', () => {
  it('selects macos-seatbelt on darwin and linux-bwrap or linux-landlock on linux when capabilities match', async () => {
    await withTempWorkspace(async workspaceRoot => {
      const darwinNegotiated = negotiateSandboxBackend(
        { workspaceRoot, writablePaths: ['docs'] },
        { platform: 'darwin', arch: 'arm64', probeExecutables: false },
      );
      assert.equal(darwinNegotiated.backendId, 'macos-seatbelt');
      assert.deepEqual(darwinNegotiated.capabilities, SANDBOX_CAPABILITIES_BY_BACKEND['macos-seatbelt']);

      const linuxBwrapNegotiated = negotiateSandboxBackend(
        { workspaceRoot, writablePaths: ['docs'], requiredCapabilities: ['filesystemWriteContainment', 'syscallFiltering'] },
        { platform: 'linux', arch: 'x64', probeExecutables: false },
      );
      assert.equal(linuxBwrapNegotiated.backendId, 'linux-bwrap');

      const linuxLandlockNegotiated = negotiateSandboxBackend(
        { workspaceRoot, writablePaths: ['docs'], preferredBackends: ['linux-landlock'] },
        { platform: 'linux', arch: 'x64', probeExecutables: false },
      );
      assert.equal(linuxLandlockNegotiated.backendId, 'linux-landlock');
    });
  });

  it('fails closed with SANDBOX_CAPABILITY_INSUFFICIENT when macos-seatbelt is asked for syscallFiltering or direct-dedicated lacks override', async () => {
    await withTempWorkspace(async workspaceRoot => {
      assert.throws(
        () => negotiateSandboxBackend(
          {
            workspaceRoot,
            writablePaths: ['docs'],
            preferredBackends: ['macos-seatbelt'],
            requiredCapabilities: ['filesystemWriteContainment', 'syscallFiltering'],
          },
          { platform: 'darwin', arch: 'arm64', probeExecutables: false },
        ),
        (err: unknown) => err instanceof GitHubAppError && err.code === 'SANDBOX_CAPABILITY_INSUFFICIENT',
      );

      assert.throws(
        () => negotiateSandboxBackend(
          {
            workspaceRoot,
            writablePaths: ['docs'],
            preferredBackends: ['direct-dedicated'],
          },
          { platform: 'darwin', arch: 'arm64', probeExecutables: false },
        ),
        (err: unknown) => err instanceof GitHubAppError && err.code === 'SANDBOX_CAPABILITY_INSUFFICIENT',
      );

      const overridden = negotiateSandboxBackend(
        {
          workspaceRoot,
          writablePaths: ['docs'],
          preferredBackends: ['direct-dedicated'],
          allowDedicatedDirectOverride: true,
        },
        { platform: 'darwin', arch: 'arm64', probeExecutables: false },
      );
      assert.equal(overridden.backendId, 'direct-dedicated');
      assert.equal(overridden.executablePath, null);
    });
  });

  it('fails closed with SANDBOX_BACKEND_UNAVAILABLE on platform mismatch or missing binaries', async () => {
    await withTempWorkspace(async workspaceRoot => {
      assert.throws(
        () => negotiateSandboxBackend(
          { workspaceRoot, writablePaths: ['docs'], preferredBackends: ['linux-bwrap'] },
          { platform: 'darwin', arch: 'arm64', probeExecutables: false },
        ),
        (err: unknown) => err instanceof GitHubAppError && err.code === 'SANDBOX_BACKEND_UNAVAILABLE',
      );

      assert.throws(
        () => negotiateSandboxBackend(
          { workspaceRoot, writablePaths: ['docs'], preferredBackends: ['macos-seatbelt'] },
          { platform: 'linux', arch: 'x64', probeExecutables: false },
        ),
        (err: unknown) => err instanceof GitHubAppError && err.code === 'SANDBOX_BACKEND_UNAVAILABLE',
      );
    });
  });
});

describe('real OS kernel sandbox execution (AC-1)', () => {
  const canRunLinuxBwrap =
    process.platform === 'linux' &&
    existsSync('/usr/bin/bwrap') &&
    spawnSync('/usr/bin/bwrap', ['--unshare-all', '--ro-bind', '/', '/', '/bin/true'], {
      timeout: 2000,
      stdio: 'ignore',
    }).status === 0;
  const canRunLinuxLandlock =
    process.platform === 'linux' &&
    existsSync('/usr/bin/python3');
  const canRunKernelSandbox =
    (process.platform === 'darwin' && existsSync('/usr/bin/sandbox-exec')) ||
    canRunLinuxBwrap ||
    canRunLinuxLandlock;

  async function verifyKernelSandboxContainment(preferredBackends?: readonly SandboxBackendId[]): Promise<void> {
    await withTempWorkspace(async (workspaceRoot, scratchDir) => {
      const secretDir = join(scratchDir, 'denied-secrets');
      await mkdir(secretDir, { recursive: true });
      const secretFile = join(secretDir, 'id_rsa');
      await writeFile(secretFile, 'TOP_SECRET_KEY', 'utf8');
      const standaloneSecretFile = join(scratchDir, 'denied-token.txt');
      await writeFile(standaloneSecretFile, 'TOP_SECRET_FILE_VALUE', 'utf8');

      const policy = {
        workspaceRoot,
        writablePaths: ['docs'],
        protectedPaths: ['docs/protected-notes.md'],
        deniedReadPaths: [secretDir, standaloneSecretFile],
        networkMode: 'none' as const,
        ...(preferredBackends !== undefined ? { preferredBackends } : {}),
      };

      // 1. Writing inside approved writable path (docs/allowed.txt) succeeds even when protected subpath does not exist yet.
      const allowedTarget = join(workspaceRoot, 'docs', 'allowed.txt');
      const allowedRes = await executeSandboxedCommand({
        policy,
        command: '/bin/sh',
        args: ['-c', 'printf "ok-token-ghs_1234567890abcdefghijklmnop" > "$1" && cat "$1"', 'sh', allowedTarget],
        secretsToScrub: ['custom-secret-value'],
      });
      assert.equal(allowedRes.exitCode, 0, allowedRes.stderr);
      if (preferredBackends !== undefined && preferredBackends.length === 1) {
        assert.equal(allowedRes.backendId, preferredBackends[0]);
      }
      assert.equal(await readFile(allowedTarget, 'utf8'), 'ok-token-ghs_1234567890abcdefghijklmnop');
      assert.equal(allowedRes.stdout, 'ok-token-[scrubbed]');

      // 2. Writing outside workspace (into scratchDir when scratchDir is not in writablePaths) fails.
      const outsideTarget = join(scratchDir, 'escaped.txt');
      const outsideRes = await executeSandboxedCommand({
        policy,
        command: '/bin/sh',
        args: ['-c', 'echo "escaped" > "$1"', 'sh', outsideTarget],
      });
      assert.notEqual(outsideRes.exitCode, 0);
      assert.equal(existsSync(outsideTarget), false);

      // 3. Writing to .git/config, .github/workflows/ci.yml, AGENTS.md, or an existing protected subpath inside docs/ is blocked.
      const gitConfigTarget = join(workspaceRoot, '.git', 'config');
      const gitBefore = await readFile(gitConfigTarget, 'utf8');
      const gitRes = await executeSandboxedCommand({
        policy: { ...policy, writablePaths: ['.'] },
        command: '/bin/sh',
        args: ['-c', 'echo "malicious" >> "$1"', 'sh', gitConfigTarget],
      });
      assert.notEqual(gitRes.exitCode, 0);
      assert.equal(await readFile(gitConfigTarget, 'utf8'), gitBefore);

      const agentsTarget = join(workspaceRoot, 'AGENTS.md');
      const agentsRes = await executeSandboxedCommand({
        policy: { ...policy, writablePaths: ['.'] },
        command: '/bin/sh',
        args: ['-c', 'echo "tampered" > "$1"', 'sh', agentsTarget],
      });
      assert.notEqual(agentsRes.exitCode, 0);
      assert.equal(await readFile(agentsTarget, 'utf8'), '# Agents\n');

      const protectedNotesTarget = join(workspaceRoot, 'docs', 'protected-notes.md');
      await writeFile(protectedNotesTarget, 'IMMUTABLE_NOTE\n', 'utf8');
      const protectedNotesRes = await executeSandboxedCommand({
        policy,
        command: '/bin/sh',
        args: ['-c', 'echo "tampered" > "$1"', 'sh', protectedNotesTarget],
      });
      assert.notEqual(protectedNotesRes.exitCode, 0);
      assert.equal(await readFile(protectedNotesTarget, 'utf8'), 'IMMUTABLE_NOTE\n');

      const workflowDir = join(workspaceRoot, '.github', 'workflows');
      const workflowRes = await executeSandboxedCommand({
        policy,
        command: '/bin/sh',
        args: ['-c', 'mkdir -p "$1" && echo "pwn" > "$1/ci.yml"', 'sh', workflowDir],
      });
      assert.notEqual(workflowRes.exitCode, 0);
      assert.equal(existsSync(join(workflowDir, 'ci.yml')), false);

      // 4. Reading denied credential directories and files is blocked or masked by the kernel.
      const readDeniedRes = await executeSandboxedCommand({
        policy,
        command: '/bin/cat',
        args: [secretFile],
      });
      assert.notEqual(readDeniedRes.exitCode, 0);
      assert.equal(readDeniedRes.stdout.includes('TOP_SECRET_KEY'), false);

      const readDeniedFileRes = await executeSandboxedCommand({
        policy,
        command: '/bin/cat',
        args: [standaloneSecretFile],
      });
      assert.equal(readDeniedFileRes.stdout.includes('TOP_SECRET_FILE_VALUE'), false);
    });
  }

  it('enforces allowed workspace writes, blocks outside-workspace writes, blocks protected-path writes, and blocks denied credential reads', { skip: !canRunKernelSandbox }, async () => {
    await verifyKernelSandboxContainment();
  });

  it('enforces containment explicitly under linux-landlock on Linux hosts', { skip: !canRunLinuxLandlock }, async () => {
    await verifyKernelSandboxContainment(['linux-landlock']);
  });

  it('enforces containment explicitly under linux-bwrap when user namespaces are permitted on Linux hosts', { skip: !canRunLinuxBwrap }, async () => {
    await verifyKernelSandboxContainment(['linux-bwrap']);
  });

  it('falls back from blocked linux-bwrap to linux-landlock and fails closed when only linux-bwrap is allowed', { skip: !(process.platform === 'linux' && !canRunLinuxBwrap && canRunLinuxLandlock) }, async () => {
    await withTempWorkspace(async workspaceRoot => {
      const negotiated = negotiateSandboxBackend({ workspaceRoot, writablePaths: ['docs'] });
      assert.equal(negotiated.backendId, 'linux-landlock');

      assert.throws(
        () => negotiateSandboxBackend({ workspaceRoot, writablePaths: ['docs'], preferredBackends: ['linux-bwrap'] }),
        (err: unknown) => err instanceof GitHubAppError && err.code === 'SANDBOX_BACKEND_UNAVAILABLE',
      );
    });
  });

  it('enforces command timeouts inside the sandbox', { skip: !canRunKernelSandbox }, async () => {
    await withTempWorkspace(async workspaceRoot => {
      const result = await executeSandboxedCommand({
        policy: { workspaceRoot, writablePaths: ['docs'] },
        command: '/bin/sleep',
        args: ['5'],
        timeoutMs: 150,
      });
      assert.equal(result.timedOut, true);
    });
  });

  it('resolves and enforces sandbox policy for explicit proposal file inside .auto-sync and .loopwright control roots', async () => {
    await withTempWorkspace(async workspaceRoot => {
      for (const controlRoot of ['.auto-sync', '.loopwright'] as const) {
        await mkdir(join(workspaceRoot, controlRoot, 'checks'), { recursive: true });
        await mkdir(join(workspaceRoot, 'pack', 'cann'), { recursive: true });
        const instructionsRel = `${controlRoot}/instructions.md`;
        const taskpackRel = `${controlRoot}/taskpack.yaml`;
        const proposalRel = `${controlRoot}/proposal.json`;
        const otherRel = `${controlRoot}/other.json`;
        const checkRel = `${controlRoot}/checks/verify.sh`;

        await writeFile(join(workspaceRoot, instructionsRel), '# Immutable instructions\n', 'utf8');
        await writeFile(join(workspaceRoot, otherRel), '{"untouched":true}\n', 'utf8');
        await writeFile(join(workspaceRoot, checkRel), '#!/usr/bin/env bash\nexit 0\n', { mode: 0o755 });
        const taskpackYaml = `apiVersion: loopwright.dev/v1alpha1
kind: Taskpack
metadata:
  name: sandbox-control-proposal
spec:
  goal:
    candidate: Sync pack and proposal.
    noChange: Confirm no change.
  instructions:
    - ${instructionsRel}
  scope:
    writable:
      - ${proposalRel}
      - pack/cann/**
    protected: []
  upstreams:
    - id: cann
      kind: github-release
      source: gpustack/cann
      watchedPaths:
        - pack/cann
  proposal:
    path: ${proposalRel}
    requiredFields:
      - summary
    schemaVersion: 1
  verification:
    localChecks:
      - id: proposal-json
        implementation: json-artifact.v1
        parameters:
          path: ${proposalRel}
      - id: verify-pack
        implementation: command.v1
        parameters:
          script: ${checkRel}
    externalGates: []
  publication:
    mode: disabled
    targetBranch: main
    headBranchPrefix: loopwright-sync/
    titleTemplate: "chore: sync"
  memory:
    directory: ${controlRoot}/memory/sync
    apply: separate-pull-request
    onNoModelBudget: deterministic-observations-only
  triggers:
    schedule: true
    workflowDispatch: true
    releasePublished: false
    commentCommands: []
`;
        await writeFile(join(workspaceRoot, taskpackRel), taskpackYaml, 'utf8');

        const manifest = await loadDeclarativeTaskpack({
          manifestPath: taskpackRel,
          repositoryRoot: workspaceRoot,
        });
        const policy = resolveEffectiveTaskpackSandboxPolicy(manifest, {
          workspaceRoot,
          relativeTaskpackPath: taskpackRel,
          env: {},
        });
        assert.equal(policy.controlRoot, controlRoot);
        assert.equal(policy.proposalPath, proposalRel);
        assert.deepEqual(policy.writablePaths, [proposalRel, 'pack/cann/**']);
        assert.equal(policy.protectedPaths?.includes(controlRoot), false);
        assert.equal(policy.protectedPaths?.includes(taskpackRel), true);
        assert.equal(policy.protectedPaths?.includes(instructionsRel), true);
        assert.equal(policy.protectedPaths?.includes(`${controlRoot}/checks`), true);
        assert.equal(policy.protectedPaths?.includes(`${controlRoot}/memory`), true);
        assert.equal(policy.protectedPaths?.includes(`${controlRoot}/policies`), true);

        const seatbelt = compileMacosSeatbeltProfile(
          policy,
          { platform: 'darwin', arch: 'arm64', probeExecutables: false },
        );
        const canonicalProposalAbs = join(workspaceRoot, proposalRel);
        assert.equal(seatbelt.canonicalWritablePaths.includes(canonicalProposalAbs), true);
        assert.equal(seatbelt.canonicalProtectedPaths.includes(join(workspaceRoot, controlRoot)), false);
        assert.equal(seatbelt.canonicalProtectedPaths.includes(join(workspaceRoot, taskpackRel)), true);
        assert.equal(seatbelt.canonicalProtectedPaths.includes(join(workspaceRoot, instructionsRel)), true);
        assert.equal(seatbelt.canonicalProtectedPaths.includes(join(workspaceRoot, otherRel)), true);
        assert.match(seatbelt.profileText, new RegExp(`\\(require-all \\(literal "${canonicalProposalAbs.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"\\) \\(vnode-type REGULAR-FILE\\)\\)`));
        assert.equal(seatbelt.profileText.includes(`(subpath "${canonicalProposalAbs}")`), false);

        const bwrap = compileLinuxBwrapCommand(
          policy,
          { platform: 'linux', arch: 'x64', probeExecutables: false },
        );
        assert.equal(bwrap.canonicalWritablePaths.includes(canonicalProposalAbs), true);
        assert.equal(bwrap.canonicalProtectedPaths.includes(join(workspaceRoot, controlRoot)), false);
        assert.equal(bwrap.canonicalProtectedPaths.includes(join(workspaceRoot, taskpackRel)), true);
        assert.equal(bwrap.args.includes('--bind-try'), false);
        const bindIdx = bwrap.args.findIndex(
          (arg, idx) => arg === '--bind' && bwrap.args[idx + 1] === canonicalProposalAbs && bwrap.args[idx + 2] === canonicalProposalAbs,
        );
        assert.notEqual(bindIdx, -1, 'expected --bind for exact proposal file');

        // Provisioning for bwrap creates absent proposal file safely as 0o600 regular file
        assert.equal(existsSync(canonicalProposalAbs), false);
        compileLinuxBwrapCommand(
          policy,
          { platform: 'linux', arch: 'x64', probeExecutables: false },
          { provisionExactFiles: true },
        );
        assert.equal(existsSync(canonicalProposalAbs), true);
        await rm(canonicalProposalAbs, { force: true });

        const negotiated = negotiateSandboxBackend(
          policy,
          { platform: 'darwin', arch: 'arm64', probeExecutables: false },
        );
        assert.equal(negotiated.backendId, 'macos-seatbelt');

        // Symlink alias and scratchDirectory bypass attempts reopening controlRoot or siblings are rejected
        const controlAlias = join(workspaceRoot, 'alias-control');
        const siblingAlias = join(workspaceRoot, 'alias-sibling');
        await symlink(join(workspaceRoot, controlRoot), controlAlias);
        await symlink(join(workspaceRoot, otherRel), siblingAlias);
        for (const badPolicy of [
          { ...policy, writablePaths: [proposalRel, 'alias-control'] },
          { ...policy, writablePaths: [proposalRel, 'alias-sibling'] },
          { ...policy, scratchDirectory: join(workspaceRoot, controlRoot) },
          { ...policy, scratchDirectory: controlAlias },
        ]) {
          assert.throws(
            () => compileMacosSeatbeltProfile(
              badPolicy,
              { platform: 'darwin', arch: 'arm64', probeExecutables: false },
            ),
            (err: unknown) => err instanceof GitHubAppError && err.code === 'SANDBOX_POLICY_INVALID',
          );
        }
        await rm(controlAlias, { force: true });
        await rm(siblingAlias, { force: true });

        // Direct policy without proposalPath opt-in keeps .loopwright protected
        if (controlRoot === '.loopwright') {
          assert.throws(
            () => compileMacosSeatbeltProfile(
              { workspaceRoot, writablePaths: ['.loopwright/proposal.json'] },
              { platform: 'darwin', arch: 'arm64', probeExecutables: false },
            ),
            (err: unknown) => err instanceof GitHubAppError && err.code === 'SANDBOX_POLICY_INVALID',
          );
          assert.throws(
            () => compileMacosSeatbeltProfile(
              {
                workspaceRoot,
                writablePaths: ['.'],
                controlRoot: '.loopwright',
                proposalPath: '.loopwright/proposal.json',
              },
              { platform: 'darwin', arch: 'arm64', probeExecutables: false },
            ),
            (err: unknown) => err instanceof GitHubAppError && err.code === 'SANDBOX_POLICY_INVALID',
          );
        }

        // Symlinked proposalPath on disk is rejected by normalizeSandboxPolicy
        await symlink(join(workspaceRoot, otherRel), join(workspaceRoot, proposalRel));
        assert.throws(
          () => compileMacosSeatbeltProfile(
            policy,
            { platform: 'darwin', arch: 'arm64', probeExecutables: false },
          ),
          (err: unknown) => err instanceof GitHubAppError && err.code === 'SANDBOX_POLICY_INVALID',
        );
        await rm(join(workspaceRoot, proposalRel), { force: true });

        if (canRunKernelSandbox) {
          const proposalAbs = join(workspaceRoot, proposalRel);
          // Absent proposal: directory and symlink creation at proposalRel are denied by kernel
          const mkdirAbsent = await executeSandboxedCommand({
            policy,
            command: '/bin/sh',
            args: ['-c', 'mkdir "$1" && touch "$1/evil.sh"', 'sh', proposalAbs],
          });
          assert.notEqual(mkdirAbsent.exitCode, 0, 'expected kernel sandbox to block mkdir at proposalPath');
          assert.equal(existsSync(join(proposalAbs, 'evil.sh')), false);
          if (mkdirAbsent.backendId === 'macos-seatbelt') {
            assert.equal(existsSync(proposalAbs), false);
          } else {
            const st = await lstat(proposalAbs);
            assert.equal(st.isFile(), true);
            assert.equal(st.isDirectory(), false);
            assert.equal(st.isSymbolicLink(), false);
            assert.equal(st.size, 0);
            await rm(proposalAbs, { force: true });
          }

          const symlinkAbsent = await executeSandboxedCommand({
            policy,
            command: '/bin/sh',
            args: ['-c', 'ln -s /etc/hosts "$1"', 'sh', proposalAbs],
          });
          assert.notEqual(symlinkAbsent.exitCode, 0, 'expected kernel sandbox to block symlink at proposalPath');
          if (symlinkAbsent.backendId === 'macos-seatbelt') {
            assert.equal(existsSync(proposalAbs), false);
          } else {
            const st = await lstat(proposalAbs);
            assert.equal(st.isFile(), true);
            assert.equal(st.isDirectory(), false);
            assert.equal(st.isSymbolicLink(), false);
            assert.equal(st.size, 0);
          }

          // Absent proposal: regular file creation succeeds
          const createProposal = await executeSandboxedCommand({
            policy,
            command: '/bin/sh',
            args: ['-c', 'printf \'{"summary":"created"}\\n\' > "$1"', 'sh', proposalAbs],
          });
          assert.equal(createProposal.exitCode, 0, createProposal.stderr);
          assert.equal(await readFile(proposalAbs, 'utf8'), '{"summary":"created"}\n');

          // Nested proposal under missing parent directory inside controlRoot succeeds without opening sibling writes
          const nestedProposalRel = `${controlRoot}/output/proposal.json`;
          const nestedProposalAbs = join(workspaceRoot, nestedProposalRel);
          const nestedSiblingAbs = join(workspaceRoot, `${controlRoot}/output/sibling.json`);
          const nestedPolicy = {
            ...policy,
            writablePaths: [nestedProposalRel, 'pack/cann/**'],
            proposalPath: nestedProposalRel,
          };
          const createNested = await executeSandboxedCommand({
            policy: nestedPolicy,
            command: '/bin/sh',
            args: ['-c', 'printf \'{"summary":"nested"}\\n\' > "$1"', 'sh', nestedProposalAbs],
          });
          assert.equal(createNested.exitCode, 0, createNested.stderr);
          assert.equal(await readFile(nestedProposalAbs, 'utf8'), '{"summary":"nested"}\n');
          const blockedNestedSibling = await executeSandboxedCommand({
            policy: nestedPolicy,
            command: '/bin/sh',
            args: ['-c', 'printf \'{"evil":1}\\n\' > "$1"', 'sh', nestedSiblingAbs],
          });
          assert.notEqual(blockedNestedSibling.exitCode, 0, 'expected sibling inside nested controlRoot subdir to stay blocked');
          assert.equal(existsSync(nestedSiblingAbs), false);

          // Existing proposal: overwrite succeeds, but rm + mkdir subtree replacement is denied
          const writeProposal = await executeSandboxedCommand({
            policy,
            command: '/bin/sh',
            args: ['-c', 'printf \'{"summary":"updated"}\\n\' > "$1"', 'sh', join(workspaceRoot, proposalRel)],
          });
          assert.equal(writeProposal.exitCode, 0, writeProposal.stderr);
          assert.equal(await readFile(join(workspaceRoot, proposalRel), 'utf8'), '{"summary":"updated"}\n');

          const replaceWithDir = await executeSandboxedCommand({
            policy,
            command: '/bin/sh',
            args: ['-c', 'rm -f "$1" && mkdir "$1" && touch "$1/evil.sh"', 'sh', join(workspaceRoot, proposalRel)],
          });
          assert.notEqual(replaceWithDir.exitCode, 0, 'expected Seatbelt to block replacing proposal file with directory');
          assert.equal(existsSync(join(workspaceRoot, proposalRel, 'evil.sh')), false);

          for (const blockedRel of [otherRel, taskpackRel, instructionsRel]) {
            const target = join(workspaceRoot, blockedRel);
            const before = await readFile(target, 'utf8');
            const blockedRes = await executeSandboxedCommand({
              policy,
              command: '/bin/sh',
              args: ['-c', 'printf "tampered" > "$1"', 'sh', target],
            });
            assert.notEqual(blockedRes.exitCode, 0, `expected kernel sandbox to deny writing ${blockedRel}`);
            assert.equal(await readFile(target, 'utf8'), before);
          }
        }
      }
    });
  });
});

describe('Sandbox networkMode preservation, bounded glob traversal, and Linux leaf-glob exact binds', () => {
  it('preserves allowAgentNetwork -> allow-outbound when spec.sandbox omits networkMode', async () => {
    await withTempWorkspace(async workspaceRoot => {
      await mkdir(join(workspaceRoot, '.loopwright'), { recursive: true });
      await writeFile(
        join(workspaceRoot, '.loopwright', 'taskpack.yaml'),
        `apiVersion: loopwright.dev/v1alpha1
kind: Taskpack
metadata:
  name: net-preserve
spec:
  execution:
    mode: privileged
    capabilities:
      allowAgentNetwork: true
  sandbox:
    preferredBackends:
      - macos-seatbelt
  goal:
    candidate: Update docs.
    noChange: No change.
  scope:
    writable:
      - docs/**
    protected: []
  upstreams: []
  verification:
    localChecks: []
    externalGates: []
  publication:
    mode: disabled
    targetBranch: main
    headBranchPrefix: lw/
    titleTemplate: "chore: docs"
  memory:
    directory: .loopwright/memory
    apply: disabled
    onNoModelBudget: deterministic-observations-only
  triggers:
    schedule: true
    workflowDispatch: true
    releasePublished: false
    commentCommands: []
`,
        'utf8',
      );

      const loaded = await loadDeclarativeTaskpack({
        manifestPath: '.loopwright/taskpack.yaml',
        repositoryRoot: workspaceRoot,
        hostPolicy: { allowPrivileged: true },
      });
      assert.equal(loaded.spec.sandbox?.networkMode, undefined);

      const policy = resolveEffectiveTaskpackSandboxPolicy(loaded, {
        workspaceRoot,
        relativeTaskpackPath: '.loopwright/taskpack.yaml',
        hostPolicy: { allowPrivileged: true },
        env: {},
      });
      assert.equal(policy.networkMode, 'allow-outbound');
      assert.deepEqual(policy.preferredBackends, ['macos-seatbelt']);
    });
  });

  it('fails closed with SANDBOX_POLICY_INVALID when glob expansion exceeds directory traversal budget', async () => {
    await withTempWorkspace(async workspaceRoot => {
      const fanRoot = join(workspaceRoot, 'fan');
      await mkdir(fanRoot, { recursive: true });
      // Create 2,060 directories (> MAX_GLOB_VISITED_DIRS = 2,048) under fan/
      const batch: Promise<string | undefined>[] = [];
      for (let i = 0; i < 2_060; i += 1) {
        batch.push(mkdir(join(fanRoot, `d${String(i).padStart(4, '0')}`), { recursive: true }));
        if (batch.length >= 200) {
          await Promise.all(batch.splice(0, batch.length));
        }
      }
      if (batch.length > 0) await Promise.all(batch);

      assert.throws(
        () => compileMacosSeatbeltProfile(
          { workspaceRoot, writablePaths: ['fan/*/sub/**'] },
          { platform: 'darwin', arch: 'arm64', probeExecutables: false },
        ),
        (err: unknown) => err instanceof GitHubAppError && err.code === 'SANDBOX_POLICY_INVALID' && /exceeded/.test(err.message),
      );
    });
  });

  it('binds only exact existing regular files for leaf globs on Linux bwrap without over-granting parent directories or symlinks', async () => {
    await withTempWorkspace(async workspaceRoot => {
      await mkdir(join(workspaceRoot, 'packages', 'core'), { recursive: true });
      await mkdir(join(workspaceRoot, 'packages', 'cli'), { recursive: true });
      const corePkg = join(workspaceRoot, 'packages', 'core', 'package.json');
      const coreSrc = join(workspaceRoot, 'packages', 'core', 'index.ts');
      const cliPkg = join(workspaceRoot, 'packages', 'cli', 'package.json');
      await writeFile(corePkg, '{"name":"core"}\n', 'utf8');
      await writeFile(coreSrc, 'export const x = 1;\n', 'utf8');
      await writeFile(cliPkg, '{"name":"cli"}\n', 'utf8');
      await writeFile(join(workspaceRoot, 'docs', 'existing.md'), '# ok\n', 'utf8');
      await writeFile(join(workspaceRoot, 'docs', 'other.txt'), 'secret\n', 'utf8');
      await symlink(join(workspaceRoot, 'AGENTS.md'), join(workspaceRoot, 'docs', 'linked.md'));

      const bwrap = compileLinuxBwrapCommand(
        { workspaceRoot, writablePaths: ['packages/*/package.json', 'docs/*.md'] },
        { platform: 'linux', arch: 'x64', probeExecutables: false },
      );

      const boundPaths: string[] = [];
      for (let i = 0; i < bwrap.args.length; i += 1) {
        if (bwrap.args[i] === '--bind' && bwrap.args[i + 1] !== undefined) {
          boundPaths.push(bwrap.args[i + 1]!);
        }
      }
      assert.equal(boundPaths.includes(corePkg), true, 'must bind exact matched packages/core/package.json');
      assert.equal(boundPaths.includes(cliPkg), true, 'must bind exact matched packages/cli/package.json');
      assert.equal(boundPaths.includes(join(workspaceRoot, 'docs', 'existing.md')), true, 'must bind exact matched docs/existing.md');
      assert.equal(boundPaths.includes(join(workspaceRoot, 'packages', 'core')), false, 'must NOT bind parent dir packages/core');
      assert.equal(boundPaths.includes(join(workspaceRoot, 'docs')), false, 'must NOT bind parent dir docs');
      assert.equal(boundPaths.includes(coreSrc), false, 'must NOT bind non-matching sibling packages/core/index.ts');
      assert.equal(boundPaths.includes(join(workspaceRoot, 'docs', 'other.txt')), false, 'must NOT bind non-matching sibling docs/other.txt');
      assert.equal(boundPaths.includes(join(workspaceRoot, 'docs', 'linked.md')), false, 'must NOT bind symlinked leaf match');
    });
  });

  it('keeps allowedReadOnlyPaths readable (and non-writable) even under a deniedReadPaths ancestor across Seatbelt, bwrap, and Landlock', async () => {
    await withTempWorkspace(async (workspaceRoot, scratchDir) => {
      const deniedParent = join(scratchDir, 'denied-parent');
      const siblingSecret = join(deniedParent, 'sibling-secret.txt');
      const stagedReadOnlyDir = join(deniedParent, 'loopwright-staged-ro');
      const stagedFile = join(stagedReadOnlyDir, 'artifact.json');
      await mkdir(stagedReadOnlyDir, { recursive: true });
      await writeFile(siblingSecret, 'DENIED_SIBLING_SECRET', 'utf8');
      await writeFile(stagedFile, '{"ok":true}\n', 'utf8');

      const policy = {
        workspaceRoot,
        writablePaths: ['docs'],
        deniedReadPaths: [deniedParent],
        allowedReadOnlyPaths: [stagedReadOnlyDir],
        networkMode: 'none' as const,
      };

      const seatbelt = compileMacosSeatbeltProfile(policy, { platform: 'darwin', arch: 'arm64', probeExecutables: false });
      const denyIdx = seatbelt.profileText.indexOf(`(subpath "${deniedParent}")`);
      const allowIdx = seatbelt.profileText.indexOf(`(allow file-read*\n  (subpath "${stagedReadOnlyDir}")`);
      assert.ok(denyIdx >= 0, 'Seatbelt must deny parent');
      assert.ok(allowIdx > denyIdx, 'Seatbelt must allow allowedReadOnlyPaths after deny file-read*');

      const bwrap = compileLinuxBwrapCommand(policy, { platform: 'linux', arch: 'x64', probeExecutables: false });
      const roBindIdx = bwrap.args.findIndex((arg, idx) => arg === '--ro-bind-try' && bwrap.args[idx + 1] === stagedReadOnlyDir);
      assert.ok(roBindIdx >= 0, 'bwrap must bind allowedReadOnlyPaths read-only');

      // Default home secrets (e.g. ~/.ssh) can never be unlocked via allowedReadOnlyPaths
      assert.throws(
        () => compileMacosSeatbeltProfile(
          { workspaceRoot, writablePaths: ['docs'], allowedReadOnlyPaths: ['/Users/tester/.ssh/id_ed25519'] },
          { platform: 'darwin', arch: 'arm64', homeDirectory: '/Users/tester', probeExecutables: false },
        ),
        (err: unknown) => err instanceof GitHubAppError && err.code === 'SANDBOX_POLICY_INVALID',
      );

      const seatbeltLive = process.platform === 'darwin'
        && existsSync('/usr/bin/sandbox-exec')
        && spawnSync('/usr/bin/sandbox-exec', ['-p', '(version 1)\n(allow default)\n', '/usr/bin/true'], { stdio: 'ignore' }).status === 0;
      if (seatbeltLive) {
        const readAllowed = await executeSandboxedCommand({
          policy: { ...policy, preferredBackends: ['macos-seatbelt'] },
          command: '/bin/cat',
          args: [stagedFile],
        });
        assert.equal(readAllowed.exitCode, 0, readAllowed.stderr);
        assert.equal(readAllowed.stdout.trim(), '{"ok":true}');

        const readSibling = await executeSandboxedCommand({
          policy: { ...policy, preferredBackends: ['macos-seatbelt'] },
          command: '/bin/cat',
          args: [siblingSecret],
        });
        assert.notEqual(readSibling.exitCode, 0, 'sibling under deniedParent must remain unreadable');

        const writeAllowed = await executeSandboxedCommand({
          policy: { ...policy, preferredBackends: ['macos-seatbelt'] },
          command: '/bin/sh',
          args: ['-c', 'echo mutated > "$1"', 'sh', stagedFile],
        });
        assert.notEqual(writeAllowed.exitCode, 0, 'allowedReadOnlyPaths must remain non-writable');
      }
    });
  });

  it('refuses double quotes and line breaks in Seatbelt writable glob segments with SANDBOX_POLICY_INVALID', async () => {
    await withTempWorkspace(async workspaceRoot => {
      assert.throws(
        () => compileMacosSeatbeltProfile(
          { workspaceRoot, writablePaths: ['docs/quote"*.md'] },
          { platform: 'darwin', arch: 'arm64', probeExecutables: false },
        ),
        (err: unknown) => err instanceof GitHubAppError && err.code === 'SANDBOX_POLICY_INVALID',
      );
      assert.throws(
        () => compileMacosSeatbeltProfile(
          { workspaceRoot, writablePaths: ['docs/bad\n*.md'] },
          { platform: 'darwin', arch: 'arm64', probeExecutables: false },
        ),
        (err: unknown) => err instanceof GitHubAppError && err.code === 'SANDBOX_POLICY_INVALID',
      );
    });
  });
});
