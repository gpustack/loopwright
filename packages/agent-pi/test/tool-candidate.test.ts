import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink, link, chmod, realpath, stat, lstat, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { digestArtifact } from '@loopwright/core';
import { Candidate, gitBlobOid, materializeCandidateDirectory, pruneEmptyDirectories, setDirectoryTreeMode } from '../src/candidate.js';
import { PiFailure } from '../src/errors.js';
import { canonical } from '../src/boundary.js';
import { sessionInput } from './session-fixtures.js';
async function fixture() {
  const directory = await mkdtemp(join(await realpath(tmpdir()), 'loopwright-candidate-')), root = join(directory, 'candidate'), input = sessionInput();
  const protectedBytes = Buffer.from('PROTECTED_ORIGINAL'), ref = digestArtifact('packages/policy/settings.ts', protectedBytes); assert.equal(ref.ok, true); if (!ref.ok) throw new Error('fixture artifact');
  const raw = structuredClone(input) as unknown as { candidate: { artifacts: { name: string; bytes: Uint8Array }[]; manifest: { spec: { entries: unknown[] } } } }; raw.candidate.artifacts.push({ name: ref.value.name, bytes: protectedBytes }); raw.candidate.manifest.spec.entries.push(ref.value);
  for (const file of raw.candidate.artifacts) { await mkdir(join(root, file.name, '..'), { recursive: true }); await writeFile(join(root, file.name), file.bytes, { mode: 0o444 }); }
  await mkdir(join(directory, 'outside')); const candidate = new Candidate(root, raw as unknown as typeof input);
  const write = async (name: string, content = 'NEW') => { const change = await candidate.prepareWrite(name, content); await candidate.commit(change, () => {}); };
  return { directory, root, candidate, write, cleanup: () => rm(directory, { recursive: true, force: true }) };
}
test('candidate permits a scoped new regular file', async () => {
  const f = await fixture(); try { await f.write('packages/new.ts', 'ALLOWED'); assert.equal(await readFile(join(f.root, 'packages/new.ts'), 'utf8'), 'ALLOWED'); } finally { await f.cleanup(); }
});
test('protected, protected-case aliases and traversal deny before a file effect', async () => {
  for (const name of ['packages/policy/new.ts', 'packages/policy/settings.ts', 'packages/POLICY/new.ts', '../outside/new.ts', 'not-allowed.ts']) {
    const f = await fixture(); try { await assert.rejects(f.write(name)); assert.equal(await readFile(join(f.root, 'packages/policy/settings.ts'), 'utf8'), 'PROTECTED_ORIGINAL'); } finally { await f.cleanup(); }
  }
});
test('an ancestor symlink cannot redirect an allowed new path outside the candidate', async () => {
  const f = await fixture(); try { await symlink(join(f.directory, 'outside'), join(f.root, 'packages/escape')); await assert.rejects(f.write('packages/escape/new.ts')); await assert.rejects(readFile(join(f.directory, 'outside/new.ts'))); } finally { await f.cleanup(); }
});
test('hard-linked existing files are rejected before either link can change', async () => {
  const f = await fixture(); try { const original = await readFile(join(f.root, 'packages/example.ts')); await chmod(join(f.root, 'packages/example.ts'), 0o644); await link(join(f.root, 'packages/example.ts'), join(f.directory, 'outside/linked.ts')); await assert.rejects(f.write('packages/example.ts')); assert.deepEqual(await readFile(join(f.directory, 'outside/linked.ts')), original); } finally { await f.cleanup(); }
});
test('edit commits exact disjoint replacements and publishes the resulting manifest digest', async () => {
  const f = await fixture();
  try {
    const change = await f.candidate.prepareEdit('packages/example.ts', [{ oldText: 'value', newText: 'updated' }, { oldText: '1', newText: '2' }]);
    await f.candidate.commit(change, () => {}); const bytes = await readFile(join(f.root, 'packages/example.ts')); assert.equal(bytes.toString(), 'export const updated = 2;\n');
    const ref = digestArtifact('packages/example.ts', bytes); assert.equal(ref.ok, true); if (ref.ok) assert.deepEqual((await f.candidate.manifest()).spec.entries.find(entry => entry.name === ref.value.name), ref.value);
    await assert.rejects(f.candidate.commit(change, () => {}));
  } finally { await f.cleanup(); }
});
test('guard refusal, changed old bytes and ambiguous edits cannot replace a candidate file', async () => {
  const f = await fixture();
  try {
    const original = await readFile(join(f.root, 'packages/example.ts'));
    const guarded = await f.candidate.prepareWrite('packages/guarded.ts', 'DENIED'); await assert.rejects(f.candidate.commit(guarded, () => { throw new Error('current owner refused'); })); await assert.rejects(readFile(join(f.root, 'packages/guarded.ts')));
    await assert.rejects(f.candidate.prepareEdit('packages/example.ts', [{ oldText: 'value =', newText: 'a' }, { oldText: '= 1', newText: 'b' }])); assert.deepEqual(await readFile(join(f.root, 'packages/example.ts')), original);
    const stale = await f.candidate.prepareWrite('packages/example.ts', 'REPLACEMENT'); await chmod(join(f.root, 'packages/example.ts'), 0o644); await writeFile(join(f.root, 'packages/example.ts'), 'CHANGED_BY_OTHER_OWNER');
    await assert.rejects(f.candidate.commit(stale, () => {})); assert.equal(await readFile(join(f.root, 'packages/example.ts'), 'utf8'), 'CHANGED_BY_OTHER_OWNER');
  } finally { await f.cleanup(); }
});

test('classic delete unlinks writable file, prunes empty subdirectories, and refuses invalid targets', async () => {
  const f = await fixture();
  try {
    await f.write('packages/nested/deep/file.ts', 'TEMP');
    const del = await f.candidate.prepareDelete('packages/nested/deep/file.ts');
    assert.equal(del.deleted, true);
    assert.equal(del.after, null);
    assert.equal(await f.candidate.commit(del, () => {}), null);
    await assert.rejects(lstat(join(f.root, 'packages/nested/deep/file.ts')));
    await assert.rejects(lstat(join(f.root, 'packages/nested/deep')));
    await assert.rejects(lstat(join(f.root, 'packages/nested')));
    assert.ok((await lstat(join(f.root, 'packages'))).isDirectory());
    assert.equal((await f.candidate.manifest()).spec.entries.some(e => e.name === 'packages/nested/deep/file.ts'), false);

    // Refusals: missing file, directory, symlink, protected & case-folded protected, hardlink nlink > 1
    await assert.rejects(
      f.candidate.prepareDelete('packages/missing.ts'),
      err => err instanceof PiFailure && err.detail.code === 'TOOL_DENIED',
    );
    await mkdir(join(f.root, 'packages/subdir'), { recursive: true });
    await assert.rejects(
      f.candidate.prepareDelete('packages/subdir'),
      err => err instanceof PiFailure && err.detail.code === 'TOOL_DENIED',
    );
    await symlink(join(f.directory, 'outside'), join(f.root, 'packages/link'));
    await assert.rejects(
      f.candidate.prepareDelete('packages/link'),
      err => err instanceof PiFailure && err.detail.code === 'TOOL_DENIED',
    );
    await assert.rejects(
      f.candidate.prepareDelete('packages/policy/settings.ts'),
      err => err instanceof PiFailure && err.detail.code === 'TOOL_DENIED',
    );
    await assert.rejects(
      f.candidate.prepareDelete('packages/POLICY/settings.ts'),
      err => err instanceof PiFailure && err.detail.code === 'TOOL_DENIED',
    );
    await chmod(join(f.root, 'packages/example.ts'), 0o644);
    await link(join(f.root, 'packages/example.ts'), join(f.directory, 'outside/linked-del.ts'));
    await assert.rejects(
      f.candidate.prepareDelete('packages/example.ts'),
      err => err instanceof PiFailure && err.detail.code === 'TOOL_DENIED',
    );
  } finally {
    await f.cleanup();
  }
});

async function overlayFixture(options: {
  objectFormat?: 'sha1' | 'sha256';
  extraFiles?: readonly { name: string; content: string; mode?: '100644' | '100755' }[];
} = {}) {
  const objectFormat = options.objectFormat ?? 'sha1';
  const directory = await mkdtemp(join(await realpath(tmpdir()), 'loopwright-overlay-cand-'));
  const root = join(directory, 'candidate');
  const input = sessionInput();
  const baseFiles = [
    { name: 'packages/README.md', content: '# Readme\n', mode: '100644' as const },
    { name: 'packages/nested/deep/old.ts', content: 'export const old = 1;\n', mode: '100644' as const },
    { name: 'packages/package.json', content: '{"name":"pkg"}\n', mode: '100644' as const },
    { name: 'packages/run.sh', content: '#!/bin/sh\necho ok\n', mode: '100755' as const },
    ...(options.extraFiles ?? []).map(f => ({ ...f, mode: f.mode ?? ('100644' as const) })),
  ].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

  const baselineEntries = baseFiles.map(file => {
    const bytes = Buffer.from(file.content);
    return {
      name: file.name,
      mode: file.mode,
      oid: createHash(objectFormat).update(`blob ${bytes.byteLength}\0`).update(bytes).digest('hex'),
      byteLength: bytes.byteLength,
    };
  });
  for (const file of baseFiles) {
    const target = join(root, file.name);
    await mkdir(join(target, '..'), { recursive: true, mode: 0o755 });
    await writeFile(target, file.content);
    await chmod(target, file.mode === '100755' ? 0o555 : 0o444);
  }
  const anchorHex = objectFormat === 'sha1' ? 'a'.repeat(40) : 'a'.repeat(64);
  const overlayInput = {
    ...input,
    candidate: {
      manifest: {
        apiVersion: 'loopwright.dev/v1alpha1' as const,
        kind: 'ArtifactManifest' as const,
        metadata: { id: 'candidate' },
        spec: {
          baseTree: { objectFormat, commitOid: anchorHex, treeOid: anchorHex },
          entries: [],
          deleted: [],
        },
      },
      baseRevision: input.candidate.baseRevision,
      sourceRevision: input.candidate.sourceRevision,
      artifacts: [],
      baseline: { directory: root, entries: baselineEntries },
    },
  };
  const candidate = new Candidate(root, overlayInput as unknown as typeof input);
  await candidate.captureBaselineStats();
  return { directory, root, candidate, input: overlayInput, cleanup: () => rm(directory, { recursive: true, force: true }) };
}

test('tree_overlay verifies Git blob OID on first touch, preserves 100755 under umask 077, and normalizes reverts', async () => {
  const prevUmask = process.umask(0o077);
  const f = await overlayFixture({ objectFormat: 'sha256' });
  try {
    // Untouched baseline read + write + edit + delete work and verify OID
    const read = await f.candidate.checkRead('packages/README.md');
    assert.equal(read.path, 'packages/README.md');
    assert.equal(gitBlobOid('sha256', Buffer.from('# Readme\n')), f.input.candidate.baseline.entries[0]!.oid);

    // Edit 100755 baseline script preserves 0o555 even under umask 077
    const editScript = await f.candidate.prepareEdit('packages/run.sh', [{ oldText: 'echo ok', newText: 'echo v2' }]);
    await f.candidate.commit(editScript, () => {});
    assert.equal((await stat(join(f.root, 'packages/run.sh'))).mode & 0o777, 0o555);

    // Write new 100644 file preserves 0o444 even under umask 077
    const writeNew = await f.candidate.prepareWrite('packages/added.ts', 'export const added = 1;\n');
    await f.candidate.commit(writeNew, () => {});
    assert.equal((await stat(join(f.root, 'packages/added.ts'))).mode & 0o777, 0o444);

    // UTF-16 code-unit sort: README.md ('R'=82) comes before added.ts? Wait: run.sh vs added.ts; let's modify README.md and package.json
    const editReadme = await f.candidate.prepareEdit('packages/README.md', [{ oldText: '# Readme', newText: '# Updated' }]);
    await f.candidate.commit(editReadme, () => {});
    const editPkg = await f.candidate.prepareEdit('packages/package.json', [{ oldText: 'pkg', newText: 'pkg2' }]);
    await f.candidate.commit(editPkg, () => {});

    // Delete nested baseline file prunes empty subdirs and adds to deleted; deleting newly-added file omits from deleted
    const delOld = await f.candidate.prepareDelete('packages/nested/deep/old.ts');
    await f.candidate.commit(delOld, () => {});
    await assert.rejects(lstat(join(f.root, 'packages/nested')));

    const delAdded = await f.candidate.prepareDelete('packages/added.ts');
    await f.candidate.commit(delAdded, () => {});

    const midManifest = await f.candidate.manifest();
    assert.deepEqual(midManifest.spec.entries.map(e => e.name), [
      'packages/README.md',
      'packages/package.json',
      'packages/run.sh',
    ]);
    assert.deepEqual(midManifest.spec.deleted, ['packages/nested/deep/old.ts']);

    // Edit-then-revert back to original baseline bytes removes from entries and updates baseline stat fingerprint
    const revertScript = await f.candidate.prepareEdit('packages/run.sh', [{ oldText: 'echo v2', newText: 'echo ok' }]);
    await f.candidate.commit(revertScript, () => {});
    assert.equal((await stat(join(f.root, 'packages/run.sh'))).mode & 0o777, 0o555);

    // Delete-then-recreate with original baseline bytes removes from deleted and entries and keeps 0o444
    const recreateOld = await f.candidate.prepareWrite('packages/nested/deep/old.ts', 'export const old = 1;\n');
    await f.candidate.commit(recreateOld, () => {});
    assert.equal((await stat(join(f.root, 'packages/nested/deep/old.ts'))).mode & 0o777, 0o444);

    const afterRevertManifest = await f.candidate.manifest();
    assert.deepEqual(afterRevertManifest.spec.entries.map(e => e.name), ['packages/README.md', 'packages/package.json']);
    assert.deepEqual(afterRevertManifest.spec.deleted, []);
  } finally {
    process.umask(prevUmask);
    await f.cleanup();
  }
});

test('tree_overlay detects corrupted baseline OID on first touch and out-of-band tampering via lstat at manifest()', async () => {
  // First-touch OID mismatch on read, write, edit, delete
  for (const op of ['read', 'write', 'edit', 'delete'] as const) {
    const f = await overlayFixture({ objectFormat: 'sha1' });
    try {
      const target = join(f.root, 'packages/README.md');
      await chmod(target, 0o644);
      await writeFile(target, '# Tamper\n'); // exact same length (9 bytes)
      await chmod(target, 0o444);
      if (op === 'read') {
        await assert.rejects(f.candidate.checkRead('packages/README.md'), err => err instanceof PiFailure && err.detail.code === 'RECOVERY_REQUIRED');
      } else if (op === 'write') {
        await assert.rejects(f.candidate.prepareWrite('packages/README.md', 'x'), err => err instanceof PiFailure && err.detail.code === 'RECOVERY_REQUIRED');
      } else if (op === 'edit') {
        await assert.rejects(f.candidate.prepareEdit('packages/README.md', [{ oldText: 'Tamper', newText: 'x' }]), err => err instanceof PiFailure && err.detail.code === 'RECOVERY_REQUIRED');
      } else {
        await assert.rejects(f.candidate.prepareDelete('packages/README.md'), err => err instanceof PiFailure && err.detail.code === 'RECOVERY_REQUIRED');
      }
    } finally {
      await f.cleanup();
    }
  }

  // Out-of-band edit / chmod / unlink / extra file detected at manifest()
  {
    const f = await overlayFixture();
    try {
      const target = join(f.root, 'packages/README.md');
      await chmod(target, 0o644);
      await writeFile(target, '# Tamper\n');
      await chmod(target, 0o444);
      await assert.rejects(f.candidate.manifest(), err => err instanceof PiFailure && err.detail.code === 'RECOVERY_REQUIRED');
    } finally {
      await f.cleanup();
    }
  }
  {
    const f = await overlayFixture();
    try {
      await chmod(join(f.root, 'packages/run.sh'), 0o444);
      await assert.rejects(f.candidate.manifest(), err => err instanceof PiFailure && err.detail.code === 'RECOVERY_REQUIRED');
    } finally {
      await f.cleanup();
    }
  }
  {
    const f = await overlayFixture();
    try {
      await unlink(join(f.root, 'packages/README.md'));
      await assert.rejects(f.candidate.manifest(), err => err instanceof PiFailure && err.detail.code === 'RECOVERY_REQUIRED');
    } finally {
      await f.cleanup();
    }
  }
  {
    const f = await overlayFixture();
    try {
      await writeFile(join(f.root, 'packages/extra.ts'), 'rogue', { mode: 0o444 });
      await assert.rejects(f.candidate.manifest(), err => err instanceof PiFailure && err.detail.code === 'RECOVERY_REQUIRED');
    } finally {
      await f.cleanup();
    }
  }
});

test('tree_overlay lifts 257-entry directory cap for baseline while enforcing 128 overlay/deleted and byte limits', async () => {
  const extraFiles = Array.from({ length: 300 }, (_, i) => ({
    name: `packages/dir-${String(i).padStart(3, '0')}.ts`,
    content: `export const n = ${i};\n`,
  }));
  const f = await overlayFixture({ extraFiles });
  try {
    // Reading, writing, editing, and deleting in a >300-entry directory succeeds
    await f.candidate.checkRead('packages/dir-000.ts');
    const c1 = await f.candidate.prepareWrite('packages/extra-new.ts', 'new');
    await f.candidate.commit(c1, () => {});
    const c2 = await f.candidate.prepareEdit('packages/dir-001.ts', [{ oldText: '1', newText: '999' }]);
    await f.candidate.commit(c2, () => {});
    const c3 = await f.candidate.prepareDelete('packages/dir-002.ts');
    await f.candidate.commit(c3, () => {});

    // > 4 MiB overlay bytes refuses OUTPUT_LIMIT
    await assert.rejects(
      f.candidate.prepareWrite('packages/huge.ts', 'a'.repeat(4_194_305)),
      err => err instanceof PiFailure && err.detail.code === 'OUTPUT_LIMIT',
    );

    // > 128 overlay entries refuses OUTPUT_LIMIT
    for (let i = 2; i < 128; i++) {
      const c = await f.candidate.prepareWrite(`packages/ov-${i}.ts`, 'x');
      await f.candidate.commit(c, () => {});
    }
    await assert.rejects(
      f.candidate.prepareWrite('packages/ov-128.ts', 'x'),
      err => err instanceof PiFailure && err.detail.code === 'OUTPUT_LIMIT',
    );

    // > 128 deleted paths refuses OUTPUT_LIMIT
    for (let i = 3; i < 130; i++) {
      const d = await f.candidate.prepareDelete(`packages/dir-${String(i).padStart(3, '0')}.ts`);
      await f.candidate.commit(d, () => {});
    }
    await assert.rejects(
      f.candidate.prepareDelete('packages/dir-130.ts'),
      err => err instanceof PiFailure && err.detail.code === 'OUTPUT_LIMIT',
    );
  } finally {
    await f.cleanup();
  }

  // Canonical manifest bytes > 32,768 at tool time refuses OUTPUT_LIMIT
  const f2 = await overlayFixture();
  try {
    let hitLimit = false;
    for (let i = 0; i < 128; i++) {
      const name = `packages/${'p'.repeat(230)}-${String(i).padStart(3, '0')}.ts`;
      try {
        const c = await f2.candidate.prepareWrite(name, 'x');
        await f2.candidate.commit(c, () => {});
      } catch (err) {
        if (err instanceof PiFailure && err.detail.code === 'OUTPUT_LIMIT') {
          hitLimit = true;
          break;
        }
        throw err;
      }
    }
    assert.equal(hitLimit, true);
    assert.ok(Buffer.byteLength(canonical(await f2.candidate.manifest())) <= 32_768);
  } finally {
    await f2.cleanup();
  }
});

test('pruneEmptyDirectories returns exact removed resolved paths, stops at first non-empty ancestor, and never removes root', async () => {
  const dir = await mkdtemp(join(await realpath(tmpdir()), 'loopwright-prune-'));
  try {
    await mkdir(join(dir, 'a/b/c'), { recursive: true });
    await writeFile(join(dir, 'a/keep.txt'), 'keep');
    const prunedFirst = await pruneEmptyDirectories(dir, 'a/b/c/file.txt');
    assert.deepEqual([...prunedFirst].sort(), [resolve(dir, 'a/b'), resolve(dir, 'a/b/c')].sort());
    await assert.rejects(lstat(join(dir, 'a/b/c')));
    await assert.rejects(lstat(join(dir, 'a/b')));
    assert.ok((await lstat(join(dir, 'a/keep.txt'))).isFile());
    await unlink(join(dir, 'a/keep.txt'));
    const prunedSecond = await pruneEmptyDirectories(dir, 'a/keep.txt');
    assert.deepEqual([...prunedSecond], [resolve(dir, 'a')]);
    await assert.rejects(lstat(join(dir, 'a')));
    assert.ok((await lstat(dir)).isDirectory());
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('materializeCandidateDirectory enforces strict baseline lstat, rejects extra files, and adopts pre-boot fingerprints', async () => {
  const input = sessionInput();
  const baseBytes = Buffer.from('export const base = 1;\n');
  const makeOverlayInput = (stagingDir: string) => ({
    ...input,
    candidate: {
      manifest: {
        apiVersion: 'loopwright.dev/v1alpha1' as const,
        kind: 'ArtifactManifest' as const,
        metadata: { id: 'candidate' },
        spec: {
          baseTree: { objectFormat: 'sha256' as const, commitOid: 'a'.repeat(64), treeOid: 'b'.repeat(64) },
          entries: [],
          deleted: [],
        },
      },
      baseRevision: input.candidate.baseRevision,
      sourceRevision: input.candidate.sourceRevision,
      artifacts: [],
      baseline: {
        directory: stagingDir,
        entries: [
          { name: 'packages/base.ts', mode: '100644' as const, oid: gitBlobOid('sha256', baseBytes), byteLength: baseBytes.length },
        ],
      },
    },
  }) as unknown as typeof input;

  // Negative checks: wrong mode, extra file, hardlink
  for (const kind of ['wrong-mode', 'extra-file', 'hardlink'] as const) {
    const dir = await mkdtemp(join(await realpath(tmpdir()), 'loopwright-mat-bad-'));
    const staging = join(dir, 'staging');
    const candidateDir = join(dir, 'candidate');
    try {
      await mkdir(join(staging, 'packages'), { recursive: true, mode: 0o755 });
      await writeFile(join(staging, 'packages/base.ts'), baseBytes, { mode: kind === 'wrong-mode' ? 0o644 : 0o444 });
      if (kind === 'extra-file') {
        await writeFile(join(staging, 'packages/unexpected.ts'), 'x', { mode: 0o444 });
      } else if (kind === 'hardlink') {
        await link(join(staging, 'packages/base.ts'), join(dir, 'linked.ts'));
      }
      await assert.rejects(
        materializeCandidateDirectory(candidateDir, makeOverlayInput(staging)),
        err => err instanceof PiFailure && err.detail.code === 'RECOVERY_REQUIRED',
      );
    } finally {
      await setDirectoryTreeMode(candidateDir, 0o755).catch(() => {});
      await rm(dir, { recursive: true, force: true });
    }
  }

  // Positive pre-boot adoption + repeated checkRead
  {
    const dir = await mkdtemp(join(await realpath(tmpdir()), 'loopwright-mat-ok-'));
    const staging = join(dir, 'staging');
    const candidateDir = join(dir, 'candidate');
    try {
      await mkdir(join(staging, 'packages'), { recursive: true, mode: 0o755 });
      await writeFile(join(staging, 'packages/base.ts'), baseBytes, { mode: 0o444 });
      const overlayInput = makeOverlayInput(staging);
      await materializeCandidateDirectory(candidateDir, overlayInput);
      assert.equal((await lstat(candidateDir)).mode & 0o777, 0o555);
      assert.equal((await lstat(join(candidateDir, 'packages'))).mode & 0o777, 0o555);

      const candidate = new Candidate(candidateDir, overlayInput);
      await candidate.captureBaselineStats();
      const r1 = await candidate.checkRead('packages/base.ts');
      const r2 = await candidate.checkRead('packages/base.ts');
      assert.equal(r1.ref.digest.hex, r2.ref.digest.hex);
      assert.ok((await candidate.manifest()).spec.entries.length === 0);
    } finally {
      await setDirectoryTreeMode(candidateDir, 0o755).catch(() => {});
      await rm(dir, { recursive: true, force: true });
    }
  }
});

test('candidate relocks unlocked ancestors on midway unlock refusal and locks created subdirs', async () => {
  const f = await fixture();
  try {
    await setDirectoryTreeMode(f.root, 0o555);
    const createdChange = await f.candidate.prepareWrite('packages/created/sub/new.ts', 'CREATED');
    await f.candidate.commit(createdChange, () => {});
    assert.equal((await lstat(join(f.root, 'packages/created'))).mode & 0o777, 0o555);
    assert.equal((await lstat(join(f.root, 'packages/created/sub'))).mode & 0o777, 0o555);

    const badChange = await f.candidate.prepareWrite('packages/escape/new.ts', 'DENIED');

    // Unlocking stops at symlink packages/escape, and finally still relocks f.root and packages to 0o555
    await chmod(join(f.root, 'packages'), 0o755);
    await symlink(join(f.directory, 'outside'), join(f.root, 'packages/escape'));
    await chmod(join(f.root, 'packages'), 0o555);

    await assert.rejects(
      f.candidate.commit(badChange, () => {}),
      err => err instanceof PiFailure && err.detail.code === 'TOOL_DENIED',
    );
    assert.equal((await lstat(f.root)).mode & 0o777, 0o555);
    assert.equal((await lstat(join(f.root, 'packages'))).mode & 0o777, 0o555);
  } finally {
    await chmod(join(f.root, 'packages'), 0o755).catch(() => {});
    await unlink(join(f.root, 'packages/escape')).catch(() => {});
    await setDirectoryTreeMode(f.root, 0o755).catch(() => {});
    await f.cleanup();
  }
});

test('tree_overlay allows untouched oversize baseline entry (> policy.limits.fileBytes) while refusing read/edit with TOOL_DENIED before reading', async () => {
  const oversizeBytes = Buffer.alloc(9 * 1024 * 1024, 0x41);
  const f = await overlayFixture({
    objectFormat: 'sha256',
    extraFiles: [{ name: 'packages/large.bin', content: oversizeBytes as unknown as string }],
  });
  try {
    await assert.rejects(
      f.candidate.checkRead('packages/large.bin'),
      err => err instanceof PiFailure && err.detail.code === 'TOOL_DENIED',
    );
    await assert.rejects(
      f.candidate.prepareEdit('packages/large.bin', [{ oldText: 'A', newText: 'B' }]),
      err => err instanceof PiFailure && err.detail.code === 'TOOL_DENIED',
    );
    const editSibling = await f.candidate.prepareEdit('packages/README.md', [{ oldText: '# Readme', newText: '# Updated' }]);
    await f.candidate.commit(editSibling, () => {});
    const delSibling = await f.candidate.prepareDelete('packages/nested/deep/old.ts');
    await f.candidate.commit(delSibling, () => {});
    const manifest = await f.candidate.manifest();
    assert.deepEqual(manifest.spec.entries.map(e => e.name), ['packages/README.md']);
    assert.deepEqual(manifest.spec.deleted, ['packages/nested/deep/old.ts']);
  } finally {
    await f.cleanup();
  }
});
