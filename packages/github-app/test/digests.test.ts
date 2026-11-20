import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { GitHubAppError } from '../src/types.js';
import { validateTaskpackV2Manifest, type Json } from '../src/schema.js';
import {
  assertDigestLockfileVerified,
  collectTaskpackDigestTargets,
  computeDirectoryTreeDigest,
  computeFileDigest,
  computeTaskpackDigests,
  readDigestLockfile,
  verifyDigestLockfile,
  writeDigestLockfile,
} from '../src/digests.js';

async function withTempRepo(run: (repoRoot: string, outsideDir: string) => Promise<void>): Promise<void> {
  const base = await mkdtemp(join(tmpdir(), 'loopwright-digests-'));
  const repoRoot = join(base, 'repo');
  const outsideDir = join(base, 'outside');
  await mkdir(repoRoot, { recursive: true });
  await mkdir(outsideDir, { recursive: true });
  try {
    await run(repoRoot, outsideDir);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
}

function sampleTaskpack() {
  return validateTaskpackV2Manifest({
    apiVersion: 'loopwright.dev/v1alpha1',
    kind: 'Taskpack',
    metadata: { name: 'digest-demo' },
    spec: {
      execution: {
        mode: 'strict',
        digests: { pinDigests: true },
      },
      goal: { candidate: 'Sync', noChange: 'Verify' },
      scope: { writable: ['docs/**'], protected: [] },
      instructions: ['.loopwright/instructions/global.md'],
      skills: ['.agents/skills/global/SKILL.md'],
      preflight: {
        script: '.loopwright/scripts/preflight.mjs',
        timeoutSeconds: 30,
      },
      upstreams: [],
      roles: [
        {
          id: 'implementer',
          provider: 'openai',
          model: 'gpt-5',
          instructions: ['.loopwright/instructions/impl.md'],
          skills: ['.agents/skills/impl/SKILL.md'],
        },
      ],
      verification: {
        localChecks: [
          {
            id: 'verify',
            implementation: 'command.v1',
            parameters: { script: '.loopwright/checks/verify.sh' },
          },
        ],
        externalGates: [],
      },
      publication: {
        mode: 'disabled',
        targetBranch: 'main',
        headBranchPrefix: 'sync/',
        titleTemplate: 'sync',
      },
      memory: {
        directory: '.loopwright/memory/demo',
        apply: 'disabled',
      },
      triggers: {
        schedule: false,
        workflowDispatch: true,
        releasePublished: false,
        commentCommands: [],
      },
    },
  } as Json);
}

describe('digests.ts: single-file and whole-directory SHA-256 hashing', () => {
  it('computes exact SHA-256 hex digest for regular files and rejects symlinks and escapes', async () => {
    await withTempRepo(async (repoRoot, outsideDir) => {
      await mkdir(join(repoRoot, '.loopwright', 'scripts'), { recursive: true });
      const content = 'console.log("hello");\n';
      await writeFile(join(repoRoot, '.loopwright', 'scripts', 'preflight.mjs'), content, 'utf8');
      const expected = createHash('sha256').update(content, 'utf8').digest('hex');

      const actual = await computeFileDigest(repoRoot, '.loopwright/scripts/preflight.mjs');
      assert.equal(actual, expected);

      // Escaping symlink refused
      await writeFile(join(outsideDir, 'secret.txt'), 'top-secret', 'utf8');
      await symlink(join(outsideDir, 'secret.txt'), join(repoRoot, '.loopwright', 'scripts', 'escape.mjs'));
      await assert.rejects(
        computeFileDigest(repoRoot, '.loopwright/scripts/escape.mjs'),
        (err: unknown) => err instanceof GitHubAppError,
      );

      // Traversal path refused
      await assert.rejects(
        computeFileDigest(repoRoot, '../outside/secret.txt'),
        (err: unknown) => err instanceof GitHubAppError,
      );

      // Oversized file refused
      await assert.rejects(
        computeFileDigest(repoRoot, '.loopwright/scripts/preflight.mjs', { maxFileBytes: 4 }),
        (err: unknown) => err instanceof GitHubAppError && err.code === 'TASKPACK_MANIFEST_INVALID',
      );
    });
  });

  it('enforces directory tree file-count and byte bounds', async () => {
    await withTempRepo(async repoRoot => {
      const dir = join(repoRoot, '.loopwright', 'checks');
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, 'a.sh'), 'echo a\n', 'utf8');
      await writeFile(join(dir, 'b.sh'), 'echo b\n', 'utf8');

      await assert.rejects(
        computeDirectoryTreeDigest(repoRoot, '.loopwright/checks', { maxTreeFiles: 1 }),
        (err: unknown) => err instanceof GitHubAppError && err.code === 'TASKPACK_MANIFEST_INVALID',
      );
      await assert.rejects(
        computeDirectoryTreeDigest(repoRoot, '.loopwright/checks', { maxTreeBytes: 8 }),
        (err: unknown) => err instanceof GitHubAppError && err.code === 'TASKPACK_MANIFEST_INVALID',
      );
    });
  });

  it('computes deterministic whole-directory tree digests that detect sibling lib.sh edits and refuse symlinks', async () => {
    await withTempRepo(async (repoRoot, outsideDir) => {
      const checksDir = join(repoRoot, '.loopwright', 'checks');
      await mkdir(join(checksDir, 'sub'), { recursive: true });
      await writeFile(join(checksDir, 'verify.sh'), '#!/bin/sh\nsource ./lib.sh\n', 'utf8');
      await writeFile(join(checksDir, 'lib.sh'), 'helper() { echo v1; }\n', 'utf8');
      await writeFile(join(checksDir, 'sub', 'data.txt'), 'alpha\n', 'utf8');

      const first = await computeDirectoryTreeDigest(repoRoot, '.loopwright/checks');
      const second = await computeDirectoryTreeDigest(repoRoot, '.loopwright/checks');
      assert.equal(first.digest, second.digest);
      assert.deepEqual(first.files.map(f => f.path), ['lib.sh', 'sub/data.txt', 'verify.sh']);

      // Editing sibling lib.sh changes the directory tree digest
      await writeFile(join(checksDir, 'lib.sh'), 'helper() { echo v2; }\n', 'utf8');
      const afterEdit = await computeDirectoryTreeDigest(repoRoot, '.loopwright/checks');
      assert.notEqual(afterEdit.digest, first.digest);

      // Adding an escaping symlink inside the check directory fails closed
      await writeFile(join(outsideDir, 'evil.sh'), 'echo pwned\n', 'utf8');
      await symlink(join(outsideDir, 'evil.sh'), join(checksDir, 'evil.sh'));
      await assert.rejects(
        computeDirectoryTreeDigest(repoRoot, '.loopwright/checks'),
        (err: unknown) => err instanceof GitHubAppError,
      );
    });
  });
});

describe('digests.ts: taskpack target collection and digests.lock.json round-trip / drift verification', () => {
  it('collects all tracked files and check parent directories deterministically', () => {
    const taskpack = sampleTaskpack();
    const targets = collectTaskpackDigestTargets(taskpack, '.loopwright');
    assert.deepEqual(targets, [
      { path: '.agents/skills/global/SKILL.md', kind: 'file' },
      { path: '.agents/skills/impl/SKILL.md', kind: 'file' },
      { path: '.loopwright/checks', kind: 'directory' },
      { path: '.loopwright/instructions/global.md', kind: 'file' },
      { path: '.loopwright/instructions/impl.md', kind: 'file' },
      { path: '.loopwright/scripts/preflight.mjs', kind: 'file' },
    ]);
  });

  it('writes, reads, and verifies digests.lock.json and fails closed with exact drift diagnostics', async () => {
    await withTempRepo(async repoRoot => {
      const taskpack = sampleTaskpack();
      await mkdir(join(repoRoot, '.loopwright', 'checks'), { recursive: true });
      await mkdir(join(repoRoot, '.loopwright', 'instructions'), { recursive: true });
      await mkdir(join(repoRoot, '.loopwright', 'scripts'), { recursive: true });
      await mkdir(join(repoRoot, '.agents', 'skills', 'global'), { recursive: true });
      await mkdir(join(repoRoot, '.agents', 'skills', 'impl'), { recursive: true });

      await writeFile(join(repoRoot, '.loopwright', 'checks', 'verify.sh'), '#!/bin/sh\nsource ./lib.sh\n', 'utf8');
      await writeFile(join(repoRoot, '.loopwright', 'checks', 'lib.sh'), 'echo ok\n', 'utf8');
      await writeFile(join(repoRoot, '.loopwright', 'instructions', 'global.md'), '# Global\n', 'utf8');
      await writeFile(join(repoRoot, '.loopwright', 'instructions', 'impl.md'), '# Impl\n', 'utf8');
      await writeFile(join(repoRoot, '.loopwright', 'scripts', 'preflight.mjs'), 'export {};\n', 'utf8');
      await writeFile(join(repoRoot, '.agents', 'skills', 'global', 'SKILL.md'), '# Global Skill\n', 'utf8');
      await writeFile(join(repoRoot, '.agents', 'skills', 'impl', 'SKILL.md'), '# Impl Skill\n', 'utf8');

      const lockfile = await computeTaskpackDigests(repoRoot, taskpack, '.loopwright');
      assert.equal(lockfile.version, 1);
      assert.equal(lockfile.taskpack, 'digest-demo');
      assert.equal(lockfile.entries.length, 6);

      await writeDigestLockfile(repoRoot, '.loopwright/digests.lock.json', lockfile);
      const reloaded = await readDigestLockfile(repoRoot, '.loopwright/digests.lock.json');
      assert.deepEqual(reloaded, lockfile);

      const okResult = await verifyDigestLockfile(repoRoot, taskpack, '.loopwright', '.loopwright/digests.lock.json');
      assert.equal(okResult.ok, true);
      await assert.doesNotReject(assertDigestLockfileVerified(repoRoot, taskpack, '.loopwright', '.loopwright/digests.lock.json'));

      // Drift in sibling lib.sh triggers fail-closed verification naming .loopwright/checks
      await writeFile(join(repoRoot, '.loopwright', 'checks', 'lib.sh'), 'echo drifted\n', 'utf8');
      const driftResult = await verifyDigestLockfile(repoRoot, taskpack, '.loopwright', '.loopwright/digests.lock.json');
      assert.equal(driftResult.ok, false);
      assert.equal(driftResult.drifts.length, 1);
      assert.equal(driftResult.drifts[0]?.path, '.loopwright/checks');
      assert.equal(driftResult.drifts[0]?.kind, 'directory');
      assert.equal(driftResult.drifts[0]?.status, 'drifted');
      assert.match(driftResult.reason, /\.loopwright\/checks/);

      await assert.rejects(
        assertDigestLockfileVerified(repoRoot, taskpack, '.loopwright', '.loopwright/digests.lock.json'),
        (err: unknown) => err instanceof GitHubAppError && err.code === 'TASKPACK_MANIFEST_INVALID',
      );

      // Missing and extra lockfile entries are both named explicitly
      await writeFile(join(repoRoot, '.loopwright', 'checks', 'lib.sh'), 'echo ok\n', 'utf8');
      const tamperedLock = {
        version: 1 as const,
        taskpack: 'digest-demo',
        entries: [
          ...lockfile.entries.filter(e => e.path !== '.loopwright/scripts/preflight.mjs'),
          { path: '.loopwright/stale.md', kind: 'file' as const, sha256: 'a'.repeat(64) },
        ],
      };
      await writeDigestLockfile(repoRoot, '.loopwright/digests.lock.json', tamperedLock);
      const mismatchResult = await verifyDigestLockfile(repoRoot, taskpack, '.loopwright', '.loopwright/digests.lock.json');
      assert.equal(mismatchResult.ok, false);
      assert.equal(mismatchResult.drifts.some(d => d.path === '.loopwright/scripts/preflight.mjs' && d.status === 'missing'), true);
      assert.equal(mismatchResult.drifts.some(d => d.path === '.loopwright/stale.md' && d.status === 'extra'), true);
      assert.match(mismatchResult.reason, /preflight\.mjs/);
      assert.match(mismatchResult.reason, /stale\.md/);
    });
  });

  it('fails closed when digests.lock.json is missing or a symlink', async () => {
    await withTempRepo(async (repoRoot, outsideDir) => {
      const taskpack = sampleTaskpack();
      const missingRes = await verifyDigestLockfile(repoRoot, taskpack, '.loopwright', '.loopwright/digests.lock.json');
      assert.equal(missingRes.ok, false);
      assert.match(missingRes.reason, /digests\.lock\.json/);

      await mkdir(join(repoRoot, '.loopwright'), { recursive: true });
      await writeFile(join(outsideDir, 'fake.lock.json'), '{"version":1,"taskpack":"digest-demo","entries":[]}', 'utf8');
      await symlink(join(outsideDir, 'fake.lock.json'), join(repoRoot, '.loopwright', 'digests.lock.json'));
      await assert.rejects(
        readDigestLockfile(repoRoot, '.loopwright/digests.lock.json'),
        (err: unknown) => err instanceof GitHubAppError,
      );
    });
  });

  it('S5: refuses non-atomic fallback when parent dir is read-only and preserves existing lockfile', async () => {
    if (process.getuid?.() === 0) return;
    await withTempRepo(async repoRoot => {
      const parentDir = join(repoRoot, '.loopwright');
      const lockPath = join(parentDir, 'digests.lock.json');
      await mkdir(parentDir, { recursive: true });
      const original = `${JSON.stringify({ version: 1, taskpack: 'digest-demo', entries: [] }, null, 2)}\n`;
      await writeFile(lockPath, original, { encoding: 'utf8', mode: 0o644 });
      await chmod(parentDir, 0o555);
      try {
        await assert.rejects(
          writeDigestLockfile(repoRoot, '.loopwright/digests.lock.json', {
            version: 1,
            taskpack: 'digest-demo',
            entries: [{ path: '.loopwright/a.md', kind: 'file', sha256: 'b'.repeat(64) }],
          }),
          (err: unknown) => err instanceof GitHubAppError && err.code === 'TASKPACK_MANIFEST_INVALID',
        );
        const after = await readFile(lockPath, 'utf8');
        assert.equal(after, original);
      } finally {
        await chmod(parentDir, 0o755);
      }
    });
  });

  it('S6: rejects duplicate JSON member names in readDigestLockfile', async () => {
    await withTempRepo(async repoRoot => {
      await mkdir(join(repoRoot, '.loopwright'), { recursive: true });
      const dupTop = '{"version":1,"taskpack":"wrong-name","taskpack":"digest-demo","entries":[]}';
      await writeFile(join(repoRoot, '.loopwright', 'digests.lock.json'), dupTop, 'utf8');
      await assert.rejects(
        readDigestLockfile(repoRoot, '.loopwright/digests.lock.json'),
        (err: unknown) => err instanceof GitHubAppError && err.code === 'TASKPACK_MANIFEST_INVALID' && /duplicate/i.test(err.message),
      );

      const dupEntry = `{"version":1,"taskpack":"digest-demo","entries":[{"path":".loopwright/checks","kind":"directory","sha256":"${'0'.repeat(64)}","sha256":"${'a'.repeat(64)}"}]}`;
      await writeFile(join(repoRoot, '.loopwright', 'digests.lock.json'), dupEntry, 'utf8');
      await assert.rejects(
        readDigestLockfile(repoRoot, '.loopwright/digests.lock.json'),
        (err: unknown) => err instanceof GitHubAppError && err.code === 'TASKPACK_MANIFEST_INVALID' && /duplicate/i.test(err.message),
      );
    });
  });

  it('S8: classifies regular directories as TASKPACK_MANIFEST_INVALID rather than TASKPACK_SCOPE_VIOLATION', async () => {
    await withTempRepo(async repoRoot => {
      const taskpack = sampleTaskpack();
      await mkdir(join(repoRoot, '.loopwright', 'checks'), { recursive: true });
      await assert.rejects(
        computeFileDigest(repoRoot, '.loopwright/checks'),
        (err: unknown) => err instanceof GitHubAppError && err.code === 'TASKPACK_MANIFEST_INVALID',
      );
      const dirAsLockfile = await verifyDigestLockfile(repoRoot, taskpack, '.loopwright', '.loopwright/checks');
      assert.equal(dirAsLockfile.ok, false);
    });
  });

  it('P4: fails closed when declared command.v1 script file is missing inside an existing parent directory', async () => {
    await withTempRepo(async repoRoot => {
      const taskpack = validateTaskpackV2Manifest({
        apiVersion: 'loopwright.dev/v1alpha1',
        kind: 'Taskpack',
        metadata: { name: 'missing-script-demo' },
        spec: {
          execution: { mode: 'strict', digests: { pinDigests: true } },
          goal: { candidate: 'Sync', noChange: 'Verify' },
          scope: { writable: ['docs/**'], protected: [] },
          upstreams: [],
          verification: {
            localChecks: [
              {
                id: 'chk',
                implementation: 'command.v1',
                parameters: { script: '.loopwright/checks/nonexistent.sh' },
              },
            ],
            externalGates: [],
          },
          publication: { mode: 'disabled', targetBranch: 'main', headBranchPrefix: 'sync/', titleTemplate: 'sync' },
          memory: { directory: '.loopwright/memory/demo', apply: 'disabled' },
          triggers: { schedule: false, workflowDispatch: true, releasePublished: false, commentCommands: [] },
        },
      } as Json);

      await mkdir(join(repoRoot, '.loopwright', 'checks'), { recursive: true });
      await writeFile(join(repoRoot, '.loopwright', 'checks', 'other.sh'), 'echo ok\n', 'utf8');
      const dirTree = await computeDirectoryTreeDigest(repoRoot, '.loopwright/checks');
      await writeDigestLockfile(repoRoot, '.loopwright/digests.lock.json', {
        version: 1,
        taskpack: 'missing-script-demo',
        entries: [{ path: '.loopwright/checks', kind: 'directory', sha256: dirTree.digest }],
      });

      await assert.rejects(
        computeTaskpackDigests(repoRoot, taskpack, '.loopwright'),
        (err: unknown) => err instanceof GitHubAppError && err.code === 'TASKPACK_MANIFEST_INVALID',
      );
      const verifyResult = await verifyDigestLockfile(repoRoot, taskpack, '.loopwright', '.loopwright/digests.lock.json');
      assert.equal(verifyResult.ok, false);
      assert.match(verifyResult.reason, /nonexistent\.sh/);
    });
  });
});
