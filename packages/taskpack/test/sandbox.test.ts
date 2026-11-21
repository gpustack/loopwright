import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { chmod, lstat, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { TaskpackError } from '../src/types.js';
import { parseTaskpackManifest } from '../src/schema.js';
import {
  ALWAYS_PROTECTED_WORKSPACE_SUBPATHS,
  compileLinuxBwrapCommand,
  compileLinuxSeccompBpfBinary,
  compileMacosSeatbeltProfile,
  computeSandboxSeccompProfile,
  DEFAULT_DENIED_HOME_SUBPATHS,
  executeSandboxedCommand,
  GITHUB_PROTECTED_WORKSPACE_SUBPATHS,
  LANDLOCK_BOOTSTRAP_SCRIPT,
  LANDLOCK_HOST_PROBE_SCRIPT,
  MAX_LINUX_BWRAP_ARGS,
  negotiateSandboxBackend,
  provisionAbsentProtectedPlaceholders,
  resolveEffectiveTaskpackSandboxPolicy,
  SECCOMP_BLOCKED_SYSCALLS,
} from '../src/sandbox.js';

async function withWorkspace(run: (workspaceRoot: string) => Promise<void>): Promise<void> {
  const base = await realpath(tmpdir());
  const workspaceRoot = await mkdtemp(join(base, 'lw-tp-sandbox-'));
  try {
    await mkdir(join(workspaceRoot, 'docs'), { recursive: true });
    await mkdir(join(workspaceRoot, '.git'), { recursive: true });
    await mkdir(join(workspaceRoot, '.claude'), { recursive: true });
    await mkdir(join(workspaceRoot, '.github', 'workflows'), { recursive: true });
    await writeFile(join(workspaceRoot, '.github', 'CODEOWNERS'), '* @team\n', 'utf8');
    await writeFile(join(workspaceRoot, 'AGENTS.md'), '# Agents\n', 'utf8');
    await writeFile(join(workspaceRoot, 'CLAUDE.md'), '# Claude\n', 'utf8');
    await run(workspaceRoot);
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true });
  }
}

describe('sandbox.ts: neutral protection masks, profile scoping, and Seatbelt guards', () => {
  it('removes hardcoded .claude/.codex/CLAUDE.md/AGENTS.md and scopes .github protection to github profile', async () => {
    assert.deepEqual(ALWAYS_PROTECTED_WORKSPACE_SUBPATHS, ['.git']);
    assert.deepEqual(GITHUB_PROTECTED_WORKSPACE_SUBPATHS, ['.git', '.github']);

    await withWorkspace(async workspaceRoot => {
      // In default local mode, .claude, .codex, CLAUDE.md, AGENTS.md, and .github/workflows are NOT hardcoded protected
      const localSeatbelt = compileMacosSeatbeltProfile(
        {
          workspaceRoot,
          writablePaths: ['.claude', 'AGENTS.md', '.github/workflows'],
          controlRoot: '.ops',
        },
        { platform: 'darwin', arch: 'arm64', homeDirectory: '/var/empty', probeExecutables: false },
      );
      assert.ok(localSeatbelt.canonicalProtectedPaths.includes(join(workspaceRoot, '.git')));
      assert.ok(localSeatbelt.canonicalProtectedPaths.includes(join(workspaceRoot, '.ops')));
      for (const unhardcoded of ['.claude', '.codex', 'CLAUDE.md', 'AGENTS.md', '.github']) {
        assert.equal(
          localSeatbelt.canonicalProtectedPaths.includes(join(workspaceRoot, unhardcoded)),
          false,
          `local sandbox must not hardcode ${unhardcoded}`,
        );
      }

      // In github profile, .github is protected by default and dual-key allowWorkflowWrites protects non-workflow siblings
      assert.throws(
        () => compileMacosSeatbeltProfile(
          { workspaceRoot, writablePaths: ['.github/workflows'], policyProfile: 'github' },
          { platform: 'darwin', arch: 'arm64', homeDirectory: '/var/empty', probeExecutables: false },
        ),
        (err: unknown) => err instanceof TaskpackError && err.code === 'SANDBOX_POLICY_INVALID',
      );

      const githubUnlocked = compileMacosSeatbeltProfile(
        {
          workspaceRoot,
          writablePaths: ['.github/workflows'],
          policyProfile: 'github',
          allowWorkflowWrites: true,
        },
        { platform: 'darwin', arch: 'arm64', homeDirectory: '/var/empty', probeExecutables: false },
      );
      assert.ok(githubUnlocked.canonicalProtectedPaths.includes(join(workspaceRoot, '.github', 'CODEOWNERS')));

      assert.throws(
        () => compileMacosSeatbeltProfile(
          {
            workspaceRoot,
            writablePaths: ['.github/CODEOWNERS'],
            policyProfile: 'github',
            allowWorkflowWrites: true,
          },
          { platform: 'darwin', arch: 'arm64', homeDirectory: '/var/empty', probeExecutables: false },
        ),
        (err: unknown) => err instanceof TaskpackError && err.code === 'SANDBOX_POLICY_INVALID',
      );
    });
  });

  it('preserves Seatbelt newline/quote guards and deterministic bwrap compilation', async () => {
    await withWorkspace(async workspaceRoot => {
      assert.throws(
        () => compileMacosSeatbeltProfile(
          { workspaceRoot, writablePaths: ['docs/a\nb'] },
          { platform: 'darwin', arch: 'arm64', probeExecutables: false },
        ),
        (err: unknown) => err instanceof TaskpackError && err.code === 'SANDBOX_POLICY_INVALID',
      );
      assert.throws(
        () => compileMacosSeatbeltProfile(
          { workspaceRoot, writablePaths: ['docs/a"b'] },
          { platform: 'darwin', arch: 'arm64', probeExecutables: false },
        ),
        (err: unknown) => err instanceof TaskpackError && err.code === 'SANDBOX_POLICY_INVALID',
      );

      const bwrap = compileLinuxBwrapCommand(
        { workspaceRoot, writablePaths: ['docs'], controlRoot: '.ops' },
        { platform: 'linux', arch: 'x64', homeDirectory: '/var/empty', probeExecutables: false },
      );
      assert.ok(bwrap.args.includes('--unshare-all'));
      assert.ok(bwrap.canonicalProtectedPaths.includes(join(workspaceRoot, '.git')));
      assert.ok(bwrap.canonicalProtectedPaths.includes(join(workspaceRoot, '.ops')));
      assert.equal(bwrap.canonicalProtectedPaths.includes(join(workspaceRoot, '.claude')), false);
    });
  });

  it('resolves sandbox policy from minimal local manifest without GitHub assumptions', async () => {
    await withWorkspace(async workspaceRoot => {
      const manifest = parseTaskpackManifest(`apiVersion: loopwright.dev/v1alpha1
kind: Taskpack
metadata:
  name: local-sandbox
spec:
  goal:
    candidate: Update docs and agent rules.
    noChange: Verify.
  scope:
    writable:
      - docs/**
      - .claude/**
    protected:
      - AGENTS.md
  verification:
    localChecks: []
    externalGates: []
`, { controlRoot: '.ops' });

      const policy = resolveEffectiveTaskpackSandboxPolicy(manifest, {
        workspaceRoot,
        controlRoot: '.ops',
        env: {},
      });
      assert.equal(policy.policyProfile, 'local');
      assert.ok(policy.protectedPaths?.includes('AGENTS.md'));
      assert.equal(policy.protectedPaths?.includes('.claude'), false);
      assert.equal(policy.protectedPaths?.includes('.github'), false);
    });
  });

  it('validates readOnlyBindMounts, emits bwrap --ro-bind after workspace/protected binds, and binds docker profileDigest', async () => {
    await withWorkspace(async workspaceRoot => {
      const parentDir = join(workspaceRoot, '..');
      const externalRepoGitObjects = join(parentDir, 'lw-ext-git-objects-' + Date.now());
      const fakeHome = join(parentDir, 'lw-fake-home-' + Date.now());
      await mkdir(externalRepoGitObjects, { recursive: true });
      await mkdir(join(fakeHome, '.ssh'), { recursive: true });
      await mkdir(join(workspaceRoot, '.git', 'objects'), { recursive: true });
      try {
        const targetGitObjects = join(workspaceRoot, '.git', 'objects');
        const linuxHost = { platform: 'linux', arch: 'x64', homeDirectory: fakeHome, probeExecutables: false } as const;

        const bwrap = compileLinuxBwrapCommand(
          {
            workspaceRoot,
            writablePaths: ['.'],
            controlRoot: '.ops',
            readOnlyBindMounts: [{ sourcePath: externalRepoGitObjects, targetPath: targetGitObjects }],
          },
          linuxHost,
        );

        // Find index of workspace --bind, .git --ro-bind-try, and the explicit --ro-bind <source> <target>
        const findFlagTriplet = (flag: string, first: string, second: string): number => {
          for (let i = 0; i <= bwrap.args.length - 3; i += 1) {
            if (bwrap.args[i] === flag && bwrap.args[i + 1] === first && bwrap.args[i + 2] === second) return i;
          }
          return -1;
        };
        const wsBindIdx = findFlagTriplet('--bind', workspaceRoot, workspaceRoot);
        const gitProtIdx = findFlagTriplet('--ro-bind-try', join(workspaceRoot, '.git'), join(workspaceRoot, '.git'));
        const roMountIdx = findFlagTriplet('--ro-bind', externalRepoGitObjects, targetGitObjects);
        assert.ok(wsBindIdx >= 0, 'workspace --bind present');
        assert.ok(gitProtIdx > wsBindIdx, '.git --ro-bind-try follows workspace --bind');
        assert.ok(roMountIdx > gitProtIdx, 'readOnlyBindMounts --ro-bind follows protected binds');

        // Docker profileDigest incorporates readOnlyBindMounts
        const dockerHost = {
          platform: 'linux',
          arch: 'x64',
          homeDirectory: fakeHome,
          dockerExecutable: '/usr/bin/docker',
          dockerSocket: '/var/run/docker.sock',
          probeExecutables: false,
        } as const;
        const dockerWithout = negotiateSandboxBackend(
          { workspaceRoot, writablePaths: ['docs'], preferredBackends: ['docker'] },
          dockerHost,
        );
        const dockerWith = negotiateSandboxBackend(
          {
            workspaceRoot,
            writablePaths: ['docs'],
            preferredBackends: ['docker'],
            readOnlyBindMounts: [{ sourcePath: externalRepoGitObjects, targetPath: targetGitObjects }],
          },
          dockerHost,
        );
        assert.equal(dockerWith.backendId, 'docker');
        assert.notEqual(dockerWith.profileDigest.hex, dockerWithout.profileDigest.hex);

        // Reject > 16 mounts
        const seventeenMounts = Array.from({ length: 17 }, (_, idx) => ({
          sourcePath: externalRepoGitObjects,
          targetPath: join(workspaceRoot, 'docs', `m-${idx}`),
        }));
        assert.throws(
          () => compileLinuxBwrapCommand({ workspaceRoot, writablePaths: ['docs'], readOnlyBindMounts: seventeenMounts }, linuxHost),
          (err: unknown) => err instanceof TaskpackError && err.code === 'SANDBOX_POLICY_INVALID',
        );

        // Reject sourcePath overlapping DEFAULT_DENIED_HOME_SUBPATHS (both direct ~/.ssh and parent fakeHome)
        assert.ok(DEFAULT_DENIED_HOME_SUBPATHS.includes('.ssh'));
        for (const forbiddenSrc of [join(fakeHome, '.ssh'), fakeHome]) {
          assert.throws(
            () => compileLinuxBwrapCommand(
              {
                workspaceRoot,
                writablePaths: ['docs'],
                readOnlyBindMounts: [{ sourcePath: forbiddenSrc, targetPath: targetGitObjects }],
              },
              linuxHost,
            ),
            (err: unknown) => err instanceof TaskpackError && err.code === 'SANDBOX_POLICY_INVALID',
          );
        }

        // Reject symlink or regular-file sourcePath
        const fileSrc = join(externalRepoGitObjects, 'pack-file');
        await writeFile(fileSrc, 'pack', 'utf8');
        const symSrc = join(parentDir, 'lw-sym-git-objects-' + Date.now());
        await symlink(externalRepoGitObjects, symSrc);
        try {
          for (const badSrc of [fileSrc, symSrc, join(externalRepoGitObjects, 'missing')]) {
            assert.throws(
              () => compileLinuxBwrapCommand(
                {
                  workspaceRoot,
                  writablePaths: ['docs'],
                  readOnlyBindMounts: [{ sourcePath: badSrc, targetPath: targetGitObjects }],
                },
                linuxHost,
              ),
              (err: unknown) => err instanceof TaskpackError && err.code === 'SANDBOX_POLICY_INVALID',
            );
          }
        } finally {
          await rm(symSrc, { force: true });
        }

        // Reject targetPath === workspaceRoot or escaping workspaceRoot
        for (const badTarget of [workspaceRoot, externalRepoGitObjects, `${workspaceRoot}/../escape`]) {
          assert.throws(
            () => compileLinuxBwrapCommand(
              {
                workspaceRoot,
                writablePaths: ['docs'],
                readOnlyBindMounts: [{ sourcePath: externalRepoGitObjects, targetPath: badTarget }],
              },
              linuxHost,
            ),
            (err: unknown) => err instanceof TaskpackError && err.code === 'SANDBOX_POLICY_INVALID',
          );
        }
      } finally {
        await rm(externalRepoGitObjects, { recursive: true, force: true });
        await rm(fakeHome, { recursive: true, force: true });
      }
    });
  });

  it('refuses linux-landlock for loopback-only, hides caller env secrets when inheritSpawnEnv is true, and encodes classic BPF seccomp accurately', async () => {
    await withWorkspace(async workspaceRoot => {
      // R3-6: linux-landlock cannot enforce loopback-only network isolation
      assert.throws(
        () => negotiateSandboxBackend(
          {
            workspaceRoot,
            writablePaths: ['docs'],
            preferredBackends: ['linux-landlock'],
            networkMode: 'loopback-only',
          },
          { platform: 'linux', arch: 'x64', probeExecutables: false },
        ),
        (err: unknown) => err instanceof TaskpackError && err.code === 'SANDBOX_CAPABILITY_INSUFFICIENT',
      );

      await assert.rejects(
        () => executeSandboxedCommand({
          policy: {
            workspaceRoot,
            writablePaths: ['docs'],
            preferredBackends: ['linux-landlock'],
            networkMode: 'loopback-only',
          },
          host: { platform: 'linux', arch: 'x64', probeExecutables: false },
          command: '/bin/true',
        }),
        (err: unknown) => err instanceof TaskpackError && err.code === 'SANDBOX_CAPABILITY_INSUFFICIENT',
      );

      // R3-7 & R4-5: require positive GITHUB_ACTIONS=true AND RUNNER_ENVIRONMENT=github-hosted for direct-dedicated
      const minManifest = parseTaskpackManifest(`apiVersion: loopwright.dev/v1alpha1
kind: Taskpack
metadata:
  name: self-hosted-check
spec:
  goal:
    candidate: Update docs.
    noChange: Verify.
  scope:
    writable:
      - docs/**
    protected: []
  verification:
    localChecks: []
    externalGates: []
`);
      const ghHostedPolicy = resolveEffectiveTaskpackSandboxPolicy(minManifest, {
        workspaceRoot,
        env: { GITHUB_ACTIONS: 'true', RUNNER_ENVIRONMENT: 'github-hosted' },
      });
      assert.deepEqual(ghHostedPolicy.preferredBackends, ['direct-dedicated']);

      const missingRunnerEnvPolicy = resolveEffectiveTaskpackSandboxPolicy(minManifest, {
        workspaceRoot,
        env: { GITHUB_ACTIONS: 'true' },
      });
      assert.equal(missingRunnerEnvPolicy.preferredBackends, undefined);
      assert.notEqual(missingRunnerEnvPolicy.allowDedicatedDirectOverride, true);

      const emptyRunnerEnvPolicy = resolveEffectiveTaskpackSandboxPolicy(minManifest, {
        workspaceRoot,
        env: { GITHUB_ACTIONS: 'true', RUNNER_ENVIRONMENT: '   ' },
      });
      assert.equal(emptyRunnerEnvPolicy.preferredBackends, undefined);
      assert.notEqual(emptyRunnerEnvPolicy.allowDedicatedDirectOverride, true);

      const selfHostedPolicy = resolveEffectiveTaskpackSandboxPolicy(minManifest, {
        workspaceRoot,
        env: { GITHUB_ACTIONS: 'true', RUNNER_ENVIRONMENT: 'self-hosted' },
      });
      assert.equal(selfHostedPolicy.preferredBackends, undefined);
      assert.notEqual(selfHostedPolicy.allowDedicatedDirectOverride, true);

      // R4-1 & R5-7: compileLinuxBwrapCommand distinguishes networkMode "none" vs "loopback-only" and returns effectiveSeccomp
      const bwrapNone = compileLinuxBwrapCommand(
        { workspaceRoot, writablePaths: ['docs'], networkMode: 'none' },
        { platform: 'linux', arch: 'x64', probeExecutables: false },
      );
      const bwrapLoopback = compileLinuxBwrapCommand(
        { workspaceRoot, writablePaths: ['docs'], networkMode: 'loopback-only' },
        { platform: 'linux', arch: 'x64', probeExecutables: false },
      );
      const baseSeccomp = computeSandboxSeccompProfile();
      const ipBlockedSeccomp = computeSandboxSeccompProfile({ blockIpSockets: true });
      assert.equal(bwrapNone.seccompProfileJson, ipBlockedSeccomp.json);
      assert.deepEqual(bwrapNone.seccompDigest, ipBlockedSeccomp.digest);
      assert.equal(bwrapLoopback.seccompProfileJson, baseSeccomp.json);
      assert.deepEqual(bwrapLoopback.seccompDigest, baseSeccomp.digest);
      assert.notEqual(bwrapNone.seccompProfileJson, bwrapLoopback.seccompProfileJson);
      assert.notEqual(ipBlockedSeccomp.digest.hex, baseSeccomp.digest.hex);
      assert.notDeepEqual(bwrapNone.args, bwrapLoopback.args);
      assert.notEqual(bwrapNone.profileDigest.hex, bwrapLoopback.profileDigest.hex);

      // R3-18: inheritSpawnEnv: true omits --clearenv and caller secret env values from bwrap args
      const secretVal = 'ghs_topsecret1234567890123456';
      const inheritedBwrap = compileLinuxBwrapCommand(
        { workspaceRoot, writablePaths: ['docs'] },
        { platform: 'linux', arch: 'x64', probeExecutables: false },
        { env: { SECRET_TOKEN: secretVal, GIT_TERMINAL_PROMPT: '1' }, inheritSpawnEnv: true },
      );
      assert.equal(inheritedBwrap.args.includes('--clearenv'), false);
      assert.equal(inheritedBwrap.args.some(a => a.includes('SECRET_TOKEN')), false);
      assert.equal(inheritedBwrap.args.some(a => a.includes(secretVal)), false);
      const promptIdx = inheritedBwrap.args.findIndex(
        (arg, idx) => arg === '--setenv' && inheritedBwrap.args[idx + 1] === 'GIT_TERMINAL_PROMPT',
      );
      assert.ok(promptIdx > 0 && inheritedBwrap.args[promptIdx + 2] === '0');
    });

    // R3-19 & R4-1: Classic BPF binary instruction encoding, blocked syscalls, and AF_UNIX-only socket check
    assert.equal(SECCOMP_BLOCKED_SYSCALLS.length, 15);
    const x64Bpf = compileLinuxSeccompBpfBinary('x64');
    const arm64Bpf = compileLinuxSeccompBpfBinary('arm64');
    assert.equal(x64Bpf.byteLength, (5 + 15 + 2) * 8);
    assert.equal(arm64Bpf.byteLength, (4 + 15 + 2) * 8);

    const x64NoIpBpf = compileLinuxSeccompBpfBinary('x64', { blockIpSockets: true });
    const arm64NoIpBpf = compileLinuxSeccompBpfBinary('arm64', { blockIpSockets: true });
    assert.equal(x64NoIpBpf.byteLength, (5 + 15 + 3 + 2) * 8);
    assert.equal(arm64NoIpBpf.byteLength, (4 + 15 + 3 + 2) * 8);

    const evaluateBpf = (bpf: Buffer, archVal: number, syscallNr: number, arg0 = 0): number => {
      assert.equal(bpf.byteLength % 8, 0);
      const count = bpf.byteLength / 8;
      let pc = 0;
      let acc = 0;
      for (let steps = 0; steps < 64; steps += 1) {
        assert.ok(pc >= 0 && pc < count, `BPF PC out of range: ${pc}`);
        const off = pc * 8;
        const code = bpf.readUInt16LE(off);
        const jt = bpf.readUInt8(off + 2);
        const jf = bpf.readUInt8(off + 3);
        const k = bpf.readUInt32LE(off + 4);
        if (code === 0x20) {
          acc = k === 4 ? (archVal >>> 0) : k === 0 ? (syscallNr >>> 0) : k === 16 ? (arg0 >>> 0) : 0;
          pc += 1;
        } else if (code === 0x15) {
          pc = pc + 1 + ((acc >>> 0) === (k >>> 0) ? jt : jf);
        } else if (code === 0x35) {
          pc = pc + 1 + ((acc >>> 0) >= (k >>> 0) ? jt : jf);
        } else if (code === 0x06) {
          return k >>> 0;
        } else {
          assert.fail(`unexpected BPF opcode 0x${code.toString(16)}`);
        }
      }
      assert.fail('BPF program did not terminate');
    };

    const x64Blocked = [101, 246, 320, 165, 166, 155, 321, 298, 323, 250, 248, 249, 425, 426, 427];
    for (const nr of x64Blocked) {
      assert.equal(evaluateBpf(x64Bpf, 0xc000003e, nr), 0x00050001, `x64 syscall ${nr} must return SECCOMP_RET_ERRNO | 1`);
      assert.equal(evaluateBpf(x64NoIpBpf, 0xc000003e, nr), 0x00050001, `x64 no-ip syscall ${nr} must return SECCOMP_RET_ERRNO | 1`);
    }
    assert.equal(evaluateBpf(x64Bpf, 0xc000003e, 0x40000000 | 101), 0x00050001, 'x32 ABI syscall must be denied');
    assert.equal(evaluateBpf(x64NoIpBpf, 0xc000003e, 0x40000000 | 41, 1), 0x00050001, 'x32 SYS_socket must be denied');
    assert.equal(evaluateBpf(x64Bpf, 0xc00000b7, 0), 0x00050001, 'wrong arch on x64 filter must be denied');
    for (const allowedNr of [0, 1, 3, 59, 60, 231]) {
      assert.equal(evaluateBpf(x64Bpf, 0xc000003e, allowedNr), 0x7fff0000, `x64 syscall ${allowedNr} must return SECCOMP_RET_ALLOW`);
      assert.equal(evaluateBpf(x64NoIpBpf, 0xc000003e, allowedNr), 0x7fff0000);
    }
    // SYS_socket = 41 on x64
    assert.equal(evaluateBpf(x64Bpf, 0xc000003e, 41, 2), 0x7fff0000, 'default filter allows SYS_socket AF_INET');
    assert.equal(evaluateBpf(x64NoIpBpf, 0xc000003e, 41, 1), 0x7fff0000, 'blockIpSockets allows AF_UNIX (1)');
    for (const blockedDomain of [0, 2, 10, 16, 17]) {
      assert.equal(evaluateBpf(x64NoIpBpf, 0xc000003e, 41, blockedDomain), 0x00050001, `blockIpSockets denies domain ${blockedDomain} on x64`);
    }

    const arm64Blocked = [117, 104, 294, 40, 39, 41, 280, 241, 282, 219, 217, 218, 425, 426, 427];
    for (const nr of arm64Blocked) {
      assert.equal(evaluateBpf(arm64Bpf, 0xc00000b7, nr), 0x00050001, `arm64 syscall ${nr} must return SECCOMP_RET_ERRNO | 1`);
      assert.equal(evaluateBpf(arm64NoIpBpf, 0xc00000b7, nr), 0x00050001, `arm64 no-ip syscall ${nr} must return SECCOMP_RET_ERRNO | 1`);
    }
    assert.equal(evaluateBpf(arm64Bpf, 0xc000003e, 63), 0x00050001, 'wrong arch on arm64 filter must be denied');
    for (const allowedNr of [63, 64, 93, 94, 221]) {
      assert.equal(evaluateBpf(arm64Bpf, 0xc00000b7, allowedNr), 0x7fff0000, `arm64 syscall ${allowedNr} must return SECCOMP_RET_ALLOW`);
      assert.equal(evaluateBpf(arm64NoIpBpf, 0xc00000b7, allowedNr), 0x7fff0000);
    }
    // SYS_socket = 198 on arm64
    assert.equal(evaluateBpf(arm64Bpf, 0xc00000b7, 198, 2), 0x7fff0000, 'default filter allows SYS_socket AF_INET on arm64');
    assert.equal(evaluateBpf(arm64NoIpBpf, 0xc00000b7, 198, 1), 0x7fff0000, 'blockIpSockets allows AF_UNIX (1) on arm64');
    for (const blockedDomain of [0, 2, 10, 16, 17]) {
      assert.equal(evaluateBpf(arm64NoIpBpf, 0xc00000b7, 198, blockedDomain), 0x00050001, `blockIpSockets denies domain ${blockedDomain} on arm64`);
    }

    // R4-2, R5-1, R5-2, & R5-6: LANDLOCK_BOOTSTRAP_SCRIPT & LANDLOCK_HOST_PROBE_SCRIPT block chmod/chown/io_uring syscalls and use O_NOFOLLOW descriptor rules
    assert.ok(LANDLOCK_BOOTSTRAP_SCRIPT.includes('blocked_nrs = [90, 91, 92, 93, 94, 260, 268, 425, 426, 427, 452]'));
    assert.ok(LANDLOCK_BOOTSTRAP_SCRIPT.includes('blocked_nrs = [52, 53, 54, 55, 425, 426, 427, 452]'));
    assert.ok(LANDLOCK_HOST_PROBE_SCRIPT.includes('blocked_nrs = [90, 91, 92, 93, 94, 260, 268, 425, 426, 427, 452]'));
    assert.ok(LANDLOCK_HOST_PROBE_SCRIPT.includes('blocked_nrs = [52, 53, 54, 55, 425, 426, 427, 452]'));
    assert.ok(LANDLOCK_HOST_PROBE_SCRIPT.includes('libc.syscall(425, 1, 0) == -1 and ctypes.get_errno() == errno.EPERM'));
    assert.ok(LANDLOCK_BOOTSTRAP_SCRIPT.includes('O_NOFOLLOW = getattr(os, "O_NOFOLLOW", 0o400000)'));
    assert.ok(LANDLOCK_BOOTSTRAP_SCRIPT.includes('O_DIRECTORY = getattr(os, "O_DIRECTORY", 0o200000)'));
    assert.ok(LANDLOCK_BOOTSTRAP_SCRIPT.includes('stat.S_ISLNK'));
    assert.equal(LANDLOCK_BOOTSTRAP_SCRIPT.includes('SPLIT_DIR_WRITE_ACCESS'), false);
    assert.equal(LANDLOCK_BOOTSTRAP_SCRIPT.includes('grant_writable_tree'), false);

    assert.throws(
      () => compileLinuxSeccompBpfBinary('riscv64'),
      (err: unknown) => err instanceof TaskpackError && err.code === 'SANDBOX_CAPABILITY_INSUFFICIENT',
    );
    await withWorkspace(async workspaceRoot => {
      assert.throws(
        () => negotiateSandboxBackend(
          {
            workspaceRoot,
            writablePaths: ['docs'],
            preferredBackends: ['linux-bwrap'],
            requiredCapabilities: ['filesystemWriteContainment', 'syscallFiltering'],
          },
          { platform: 'linux', arch: 'riscv64', probeExecutables: false },
        ),
        (err: unknown) => err instanceof TaskpackError && err.code === 'SANDBOX_CAPABILITY_INSUFFICIENT',
      );

      // R4-13 & R4-2: Reject unsupported architecture s390x unconditionally (even when requiredCapabilities omits syscallFiltering)
      assert.throws(
        () => negotiateSandboxBackend(
          {
            workspaceRoot,
            writablePaths: ['docs'],
            preferredBackends: ['linux-bwrap'],
          },
          { platform: 'linux', arch: 's390x', probeExecutables: false },
        ),
        (err: unknown) => err instanceof TaskpackError && err.code === 'SANDBOX_BACKEND_UNAVAILABLE',
      );
      assert.throws(
        () => negotiateSandboxBackend(
          {
            workspaceRoot,
            writablePaths: ['docs'],
            preferredBackends: ['linux-landlock'],
          },
          { platform: 'linux', arch: 's390x', probeExecutables: false },
        ),
        (err: unknown) => err instanceof TaskpackError && err.code === 'SANDBOX_BACKEND_UNAVAILABLE',
      );

      // R4-4 & R5-2/R5-3: provisionAbsentProtectedPlaceholders reserves absent protected files (0o000) without mutating existing file modes and rejects symlinked intermediate segments
      const absentProtectedDir = join(workspaceRoot, 'docs', 'nested-absent');
      const absentProtectedFile = join(absentProtectedDir, 'future-protected.txt');
      const existingProtectedFile = join(workspaceRoot, 'AGENTS.md');
      await chmod(existingProtectedFile, 0o644);
      const provisioned = provisionAbsentProtectedPlaceholders({
        canonicalWorkspaceRoot: workspaceRoot,
        canonicalWritablePaths: [workspaceRoot, join(workspaceRoot, 'docs')],
        canonicalExactWritableFiles: new Set<string>(),
        canonicalProtectedPaths: [absentProtectedFile, existingProtectedFile],
      });
      try {
        assert.deepEqual(provisioned.placeholderPaths, [absentProtectedFile]);
        const phStat = await lstat(absentProtectedFile);
        assert.equal(phStat.isFile(), true);
        assert.equal(phStat.size, 0);
        assert.equal(phStat.mode & 0o777, 0o000);
        assert.equal((await lstat(existingProtectedFile)).mode & 0o777, 0o644, 'existing protected file mode must not be mutated');
      } finally {
        provisioned.cleanup();
      }
      assert.equal(existsSync(absentProtectedFile), false, 'placeholder file must be removed on cleanup');
      assert.equal(existsSync(absentProtectedDir), false, 'empty provisioned intermediate directory must be removed on cleanup');

      const symParent = join(workspaceRoot, 'docs', 'sym-parent');
      await symlink(join(workspaceRoot, '.claude'), symParent);
      try {
        assert.throws(
          () => provisionAbsentProtectedPlaceholders({
            canonicalWorkspaceRoot: workspaceRoot,
            canonicalWritablePaths: [join(workspaceRoot, 'docs')],
            canonicalExactWritableFiles: new Set<string>(),
            canonicalProtectedPaths: [join(symParent, 'protected.txt')],
          }),
          (err: unknown) => err instanceof TaskpackError && err.code === 'SANDBOX_POLICY_INVALID',
        );
      } finally {
        await rm(symParent, { force: true });
      }

      // R5-2, R5-3, & R5-8: linux-landlock declines overlapping protectedPaths/deniedReadPaths inside writablePaths and accepts disjoint policies
      const linuxLandlockMockHost = { platform: 'linux', arch: 'x64', homeDirectory: '/var/empty', probeExecutables: false } as const;
      assert.throws(
        () => negotiateSandboxBackend(
          {
            workspaceRoot,
            writablePaths: ['docs'],
            protectedPaths: ['docs/protected.md'],
            preferredBackends: ['linux-landlock'],
          },
          linuxLandlockMockHost,
        ),
        (err: unknown) => err instanceof TaskpackError && err.code === 'SANDBOX_CAPABILITY_INSUFFICIENT',
      );
      assert.throws(
        () => negotiateSandboxBackend(
          {
            workspaceRoot,
            writablePaths: ['docs'],
            deniedReadPaths: [join(workspaceRoot, 'docs', 'secret.md')],
            preferredBackends: ['linux-landlock'],
          },
          linuxLandlockMockHost,
        ),
        (err: unknown) => err instanceof TaskpackError && err.code === 'SANDBOX_CAPABILITY_INSUFFICIENT',
      );
      await assert.rejects(
        () => executeSandboxedCommand({
          policy: {
            workspaceRoot,
            writablePaths: ['docs'],
            protectedPaths: ['docs/protected.md'],
            preferredBackends: ['linux-landlock'],
          },
          host: linuxLandlockMockHost,
          command: '/bin/true',
        }),
        (err: unknown) => err instanceof TaskpackError && err.code === 'SANDBOX_CAPABILITY_INSUFFICIENT',
      );
      const disjointLandlock = negotiateSandboxBackend(
        {
          workspaceRoot,
          writablePaths: ['docs'],
          protectedPaths: ['AGENTS.md'],
          preferredBackends: ['linux-landlock'],
        },
        linuxLandlockMockHost,
      );
      assert.equal(disjointLandlock.backendId, 'linux-landlock');

      // Live OS sandbox check: absent protectedPaths under writable parents cannot be created and remain absent after cleanup
      const siblingAllowedFile = join(workspaceRoot, 'docs', 'sibling-allowed.txt');
      const directAbsentProtected = join(workspaceRoot, 'docs', 'direct-future-protected.txt');
      const policy = {
        workspaceRoot,
        writablePaths: ['docs'],
        protectedPaths: ['docs/direct-future-protected.txt', 'docs/nested-absent/future-protected.txt'],
        networkMode: 'none' as const,
      };
      let canRunHostNestedProtected = false;
      try {
        const neg = negotiateSandboxBackend(policy);
        canRunHostNestedProtected = neg.backendId === 'macos-seatbelt' || neg.backendId === 'linux-bwrap';
      } catch (err) {
        if (!(err instanceof TaskpackError && (err.code === 'SANDBOX_CAPABILITY_INSUFFICIENT' || err.code === 'SANDBOX_BACKEND_UNAVAILABLE'))) {
          throw err;
        }
      }
      if (canRunHostNestedProtected) {
        const blockedDirect = await executeSandboxedCommand({
          policy,
          command: '/bin/sh',
          args: ['-c', 'echo "created" > "$1"', 'sh', directAbsentProtected],
        });
        assert.notEqual(blockedDirect.exitCode, 0, 'creating direct absent protected file must fail');
        assert.equal(existsSync(directAbsentProtected), false, 'direct absent protected file must remain absent');
        assert.equal(existsSync(absentProtectedFile), false, 'nested absent protected file must remain absent');
        assert.equal(existsSync(absentProtectedDir), false, 'nested intermediate dir must remain absent when not created by child');

        const allowedSibling = await executeSandboxedCommand({
          policy,
          command: '/bin/sh',
          args: ['-c', 'printf "sibling-ok\\n" > "$1"', 'sh', siblingAllowedFile],
        });
        assert.equal(allowedSibling.exitCode, 0, allowedSibling.stderr);
        assert.equal(await readFile(siblingAllowedFile, 'utf8'), 'sibling-ok\n');
        assert.equal(existsSync(directAbsentProtected), false);
        assert.equal(existsSync(absentProtectedFile), false);
        assert.equal(existsSync(absentProtectedDir), false);

        const blockedNested = await executeSandboxedCommand({
          policy,
          command: '/bin/sh',
          args: ['-c', 'mkdir -p "$(dirname "$1")" && echo "created" > "$1"', 'sh', absentProtectedFile],
        });
        assert.notEqual(blockedNested.exitCode, 0, 'creating nested absent protected file must fail even after mkdir -p');
        assert.equal(existsSync(absentProtectedFile), false, 'nested absent protected file must still be absent');
      }
    });
  });

  it('enforces R5-4 post-mount deniedReadPaths ordering, R5-5 dynamic protected globs, and R5-13 bwrap argument budget', async () => {
    assert.equal(MAX_LINUX_BWRAP_ARGS, 8_500);
    await withWorkspace(async workspaceRoot => {
      const linuxMockHost = { platform: 'linux', arch: 'x64', homeDirectory: '/var/empty', probeExecutables: false } as const;
      const darwinMockHost = { platform: 'darwin', arch: 'arm64', homeDirectory: '/var/empty', probeExecutables: false } as const;

      // R5-4: deniedReadPaths inside protectedPaths/writablePaths is masked AFTER --ro-bind-try, and writable inside denied fails policy validation
      await mkdir(join(workspaceRoot, 'docs', 'configuration'), { recursive: true });
      const deniedConfigTaskpack = join(workspaceRoot, 'docs', 'configuration', 'taskpack.md');
      await writeFile(deniedConfigTaskpack, 'SECRET_DOC\n', 'utf8');
      const protectedConfigDir = join(workspaceRoot, 'docs', 'configuration');

      const compiledProbeFalse = compileLinuxBwrapCommand(
        {
          workspaceRoot,
          writablePaths: ['docs'],
          protectedPaths: ['docs/configuration'],
          deniedReadPaths: [deniedConfigTaskpack],
        },
        linuxMockHost,
      );
      const findTriplet = (args: readonly string[], flag: string, a: string, b: string): number => {
        for (let i = 0; i <= args.length - 3; i += 1) {
          if (args[i] === flag && args[i + 1] === a && args[i + 2] === b) return i;
        }
        return -1;
      };
      const protIdxFalse = findTriplet(compiledProbeFalse.args, '--ro-bind-try', protectedConfigDir, protectedConfigDir);
      const denyTmpfsIdx = compiledProbeFalse.args.findIndex(
        (arg, idx) => arg === '--tmpfs' && compiledProbeFalse.args[idx + 1] === deniedConfigTaskpack,
      );
      assert.ok(protIdxFalse >= 0, 'protected --ro-bind-try present');
      assert.ok(denyTmpfsIdx > protIdxFalse, 'deniedReadPath mask must appear AFTER --ro-bind-try for parent protectedPath');

      const compiledProbeTrue = compileLinuxBwrapCommand(
        {
          workspaceRoot,
          writablePaths: ['docs'],
          protectedPaths: ['docs/configuration'],
          deniedReadPaths: [deniedConfigTaskpack],
        },
        { platform: 'linux', arch: 'x64', homeDirectory: '/var/empty', bwrapExecutable: '/usr/bin/bwrap', probeExecutables: true },
        { provisionExactFiles: false },
      );
      const protIdxTrue = findTriplet(compiledProbeTrue.args, '--ro-bind-try', protectedConfigDir, protectedConfigDir);
      const denyNullIdx = findTriplet(compiledProbeTrue.args, '--ro-bind', '/dev/null', deniedConfigTaskpack);
      assert.ok(protIdxTrue >= 0);
      assert.ok(denyNullIdx > protIdxTrue, '--ro-bind /dev/null for denied file must follow --ro-bind-try for protected parent');

      for (const badWritable of ['docs', 'docs/sub']) {
        assert.throws(
          () => compileLinuxBwrapCommand(
            { workspaceRoot, writablePaths: [badWritable], deniedReadPaths: ['docs'] },
            linuxMockHost,
          ),
          (err: unknown) => err instanceof TaskpackError && err.code === 'SANDBOX_POLICY_INVALID',
        );
      }

      // R5-5: Dynamic protected globs (e.g. docs/*.generated) emit Seatbelt deny regex and fail closed on Linux bwrap/landlock when overlapping writable dir
      const sbplGlob = compileMacosSeatbeltProfile(
        { workspaceRoot, writablePaths: ['docs'], protectedPaths: ['docs/*.generated'] },
        darwinMockHost,
      );
      const allowWriteIdx = sbplGlob.profileText.indexOf('(allow file-write*');
      const denyWriteAfterIdx = sbplGlob.profileText.lastIndexOf('(deny file-write*');
      assert.ok(denyWriteAfterIdx > allowWriteIdx, 'trailing (deny file-write* ...) present');
      const trailingDenyBlock = sbplGlob.profileText.slice(denyWriteAfterIdx);
      assert.ok(
        trailingDenyBlock.includes('/docs/[^/]*\\.generated(/.*)?$"'),
        `expected Seatbelt regex for docs/*.generated in: ${trailingDenyBlock}`,
      );

      if (process.platform === 'darwin' && existsSync('/usr/bin/sandbox-exec')) {
        const blockedGenFile = join(workspaceRoot, 'docs', 'new.generated');
        const allowedMdFile = join(workspaceRoot, 'docs', 'new.md');
        const dynPolicy = {
          workspaceRoot,
          writablePaths: ['docs'],
          protectedPaths: ['docs/*.generated'],
          networkMode: 'none' as const,
        };
        const genRes = await executeSandboxedCommand({
          policy: dynPolicy,
          command: '/bin/sh',
          args: ['-c', 'echo "nope" > "$1"', 'sh', blockedGenFile],
        });
        assert.notEqual(genRes.exitCode, 0, 'creating docs/new.generated must be blocked by Seatbelt regex');
        assert.equal(existsSync(blockedGenFile), false);

        const mdRes = await executeSandboxedCommand({
          policy: dynPolicy,
          command: '/bin/sh',
          args: ['-c', 'printf "ok\\n" > "$1"', 'sh', allowedMdFile],
        });
        assert.equal(mdRes.exitCode, 0, mdRes.stderr);
        assert.equal(await readFile(allowedMdFile, 'utf8'), 'ok\n');
      }

      assert.throws(
        () => compileLinuxBwrapCommand(
          { workspaceRoot, writablePaths: ['docs'], protectedPaths: ['docs/*.generated'] },
          linuxMockHost,
        ),
        (err: unknown) => err instanceof TaskpackError && err.code === 'SANDBOX_CAPABILITY_INSUFFICIENT',
      );
      for (const backend of ['linux-bwrap', 'linux-landlock'] as const) {
        assert.throws(
          () => negotiateSandboxBackend(
            { workspaceRoot, writablePaths: ['docs'], protectedPaths: ['docs/*.generated'], preferredBackends: [backend] },
            linuxMockHost,
          ),
          (err: unknown) => err instanceof TaskpackError && err.code === 'SANDBOX_CAPABILITY_INSUFFICIENT',
        );
      }

      // R5-13: Glob expanding over 3,001 directories exceeds MAX_LINUX_BWRAP_ARGS (8,500), skipping linux-bwrap cleanly
      const shardsRoot = join(workspaceRoot, 'shards');
      await mkdir(shardsRoot, { recursive: true });
      await Promise.all(
        Array.from({ length: 3_001 }, (_, idx) => mkdir(join(shardsRoot, `s-${String(idx).padStart(4, '0')}`))),
      );
      assert.throws(
        () => compileLinuxBwrapCommand({ workspaceRoot, writablePaths: ['shards/*/**'] }, linuxMockHost),
        (err: unknown) => err instanceof TaskpackError && err.code === 'SANDBOX_CAPABILITY_INSUFFICIENT',
      );
      assert.throws(
        () => negotiateSandboxBackend(
          { workspaceRoot, writablePaths: ['shards/*/**'], preferredBackends: ['linux-bwrap'] },
          linuxMockHost,
        ),
        (err: unknown) => err instanceof TaskpackError && err.code === 'SANDBOX_CAPABILITY_INSUFFICIENT',
      );
      const fallbackNeg = negotiateSandboxBackend(
        { workspaceRoot, writablePaths: ['shards/*/**'], preferredBackends: ['linux-bwrap', 'linux-landlock'] },
        linuxMockHost,
      );
      assert.equal(fallbackNeg.backendId, 'linux-landlock');
    });
  });
});
