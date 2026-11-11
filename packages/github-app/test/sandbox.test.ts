import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import {
  ALWAYS_PROTECTED_WORKSPACE_SUBPATHS, compileLinuxBwrapCommand, compileMacosSeatbeltProfile,
  computeSandboxSeccompProfile, executeSandboxedCommand, negotiateSandboxBackend,
  SANDBOX_CAPABILITIES_BY_BACKEND, SECCOMP_BLOCKED_SYSCALLS,
} from '../src/sandbox.js';
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
});
