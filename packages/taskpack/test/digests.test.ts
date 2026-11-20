import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { link, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { TaskpackError } from '../src/types.js';
import { validateTaskpackV2Manifest, type Json } from '../src/schema.js';
import {
  assertDigestLockfileVerified,
  computeDirectoryTreeDigest,
  computeFileDigest,
  computeTaskpackDigests,
  DIGEST_STREAM_CHUNK_BYTES,
  readDigestLockfile,
  verifyDigestLockfile,
  writeDigestLockfile,
} from '../src/digests.js';

async function withTempRepo(run: (repoRoot: string, outsideDir: string) => Promise<void>): Promise<void> {
  const base = await mkdtemp(join(tmpdir(), 'lw-tp-digests-'));
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

describe('digests.ts: streaming 64 KiB SHA-256 hashing and lockfile verification', () => {
  it('streams multi-chunk regular files and refuses symlinks, hardlinks (nlink > 1), escapes, and oversize files', async () => {
    assert.equal(DIGEST_STREAM_CHUNK_BYTES, 65_536);
    await withTempRepo(async (repoRoot, outsideDir) => {
      await mkdir(join(repoRoot, '.ops', 'scripts'), { recursive: true });
      // Multi-chunk buffer (> 3 * 64 KiB) to exercise streaming loop
      const largeBuf = Buffer.alloc(DIGEST_STREAM_CHUNK_BYTES * 3 + 137, 0x5a);
      largeBuf[0] = 0x01;
      largeBuf[largeBuf.byteLength - 1] = 0xfe;
      const target = join(repoRoot, '.ops', 'scripts', 'bundle.bin');
      await writeFile(target, largeBuf);

      const expected = createHash('sha256').update(largeBuf).digest('hex');
      const actual = await computeFileDigest(repoRoot, '.ops/scripts/bundle.bin');
      assert.equal(actual, expected);

      // Hardlinked file (nlink > 1) refused
      const hardlinkPath = join(repoRoot, '.ops', 'scripts', 'alias.bin');
      await link(target, hardlinkPath);
      await assert.rejects(
        computeFileDigest(repoRoot, '.ops/scripts/bundle.bin'),
        (err: unknown) => err instanceof TaskpackError && err.code === 'TASKPACK_SCOPE_VIOLATION',
      );
      await rm(hardlinkPath);

      // Symlink refused
      await writeFile(join(outsideDir, 'secret.txt'), 'secret', 'utf8');
      await symlink(join(outsideDir, 'secret.txt'), join(repoRoot, '.ops', 'scripts', 'link.txt'));
      await assert.rejects(
        computeFileDigest(repoRoot, '.ops/scripts/link.txt'),
        (err: unknown) => err instanceof TaskpackError && err.code === 'TASKPACK_SCOPE_VIOLATION',
      );

      // Oversize file refused
      await assert.rejects(
        computeFileDigest(repoRoot, '.ops/scripts/bundle.bin', { maxFileBytes: 1024 }),
        (err: unknown) => err instanceof TaskpackError && err.code === 'TASKPACK_MANIFEST_INVALID',
      );
    });
  });

  it('computes deterministic directory tree digests and verifies lockfiles end-to-end', async () => {
    await withTempRepo(async repoRoot => {
      await mkdir(join(repoRoot, '.ops', 'checks'), { recursive: true });
      await writeFile(join(repoRoot, '.ops', 'checks', 'verify.sh'), '#!/bin/sh\nexit 0\n', 'utf8');
      await writeFile(join(repoRoot, '.ops', 'instructions.md'), '# Rules\n', 'utf8');

      const manifest = validateTaskpackV2Manifest({
        apiVersion: 'loopwright.dev/v1alpha1',
        kind: 'Taskpack',
        metadata: { name: 'digest-local' },
        spec: {
          execution: { mode: 'strict', digests: { pinDigests: true } },
          goal: { candidate: 'Sync', noChange: 'Verify' },
          scope: { writable: ['docs/**'], protected: [] },
          instructions: ['.ops/instructions.md'],
          verification: {
            localChecks: [
              { id: 'verify', implementation: 'command.v1', parameters: { script: '.ops/checks/verify.sh' } },
            ],
            externalGates: [],
          },
        },
      } as Json, { controlRoot: '.ops' });

      const tree1 = await computeDirectoryTreeDigest(repoRoot, '.ops/checks');
      const tree2 = await computeDirectoryTreeDigest(repoRoot, '.ops/checks');
      assert.equal(tree1.digest, tree2.digest);
      assert.equal(tree1.files.length, 1);

      const lockfile = await computeTaskpackDigests(repoRoot, manifest, '.ops');
      await writeDigestLockfile(repoRoot, '.ops/digests.lock.json', lockfile);
      const readBack = await readDigestLockfile(repoRoot, '.ops/digests.lock.json');
      assert.deepEqual(readBack, lockfile);

      const verified = await assertDigestLockfileVerified(repoRoot, manifest, '.ops');
      assert.equal(verified.entries.length, 2);

      // Mutate file -> drift detected
      await writeFile(join(repoRoot, '.ops', 'instructions.md'), '# Tampered\n', 'utf8');
      const drifted = await verifyDigestLockfile(repoRoot, manifest, '.ops');
      assert.equal(drifted.ok, false);
      if (!drifted.ok) {
        assert.equal(drifted.drifts.length, 1);
        assert.equal(drifted.drifts[0]?.status, 'drifted');
        assert.equal(drifted.drifts[0]?.path, '.ops/instructions.md');
      }
    });
  });
});
