import assert from 'node:assert/strict';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { TaskpackError } from '../src/types.js';
import { parseTaskpackManifest } from '../src/schema.js';
import {
  ALWAYS_PROTECTED_WORKSPACE_SUBPATHS,
  compileLinuxBwrapCommand,
  compileMacosSeatbeltProfile,
  GITHUB_PROTECTED_WORKSPACE_SUBPATHS,
  resolveEffectiveTaskpackSandboxPolicy,
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
});
