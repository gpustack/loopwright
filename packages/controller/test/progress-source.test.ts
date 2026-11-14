import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { appendFile, readFile, writeFile, lstat } from 'node:fs/promises';
import { join } from 'node:path';
import type { TaskContract } from '@loopwright/core';
import { retainedFixture } from './progress-fixtures.js';
import { freezeSource, verifySource, restoreSource } from '../src/source.js';
import { GIT_ENVIRONMENT } from '../src/git-reader.js';
import { canonical, hash } from '../src/schema.js';
import { ControllerFailure } from '../src/errors.js';
import { processBirth } from '../src/ownership.js';

// Trusted local plumbing builds inert fixture objects; it never checks out or runs candidate code.
async function repository(f: Awaited<ReturnType<typeof retainedFixture>>) {
  const intent = join(f.directory, 'git-fixture-commands.ndjson'), repository = f.taskDirectory;
  const git = async (args: string[], input?: Uint8Array): Promise<Buffer> => {
    await appendFile(intent, canonical({ type: 'intent', args, inputDigest: input ? hash(input) : null }) + '\n', { mode: 0o600 });
    const output = execFileSync('/usr/bin/git', ['-c', 'core.hooksPath=/dev/null', '-C', repository, ...args], {
      env: { ...GIT_ENVIRONMENT, GIT_AUTHOR_NAME: 'Controller Fixture', GIT_AUTHOR_EMAIL: 'fixture@invalid', GIT_COMMITTER_NAME: 'Controller Fixture', GIT_COMMITTER_EMAIL: 'fixture@invalid', GIT_AUTHOR_DATE: '2000-01-01T00:00:00Z', GIT_COMMITTER_DATE: '2000-01-01T00:00:00Z' },
      input, timeout: 10000, maxBuffer: 1048576,
    });
    await appendFile(intent, canonical({ type: 'exit', args, code: 0, outputDigest: hash(output) }) + '\n'); return output;
  };
  await git(['init', '--template=', '--initial-branch=main']);
  const blob = async (bytes: Uint8Array) => (await git(['hash-object', '-w', '--stdin'], bytes)).toString().trim();
  const tree = async (entries: { mode: string; type: string; oid: string; name: string }[]) => (await git(['mktree', '-z', '--missing'], Buffer.from(entries.map(row => `${row.mode} ${row.type} ${row.oid}\t${row.name}\0`).join('')))).toString().trim();
  const commit = async (tree: string, ref = 'refs/heads/source') => {
    const oid = (await git(['commit-tree', tree], Buffer.from('trusted inert fixture\n'))).toString().trim(); await git(['update-ref', ref, oid]); return oid;
  };
  const task = (oid: string): TaskContract => ({ ...f.plan.task, spec: { ...f.plan.task.spec, target: { ...f.plan.task.spec.target, baseRevision: oid, sourceRevision: 'refs/heads/source' } } });
  return { git, blob, tree, commit, task };
}
test('ordinary no-hook source reads complete committed bytes and rejects changed source refs without executing Git hooks or filters', async () => {
  const f = await retainedFixture();
  try {
    const r = await repository(f), bytes = Buffer.from('frozen source bytes\n'), oid = await r.commit(await r.tree([{ mode: '100644', type: 'blob', oid: await r.blob(bytes), name: 'example.ts' }]));
    const marker = join(f.directory, 'UNAUTHORIZED_EFFECT'), script = join(f.directory, 'trap.sh');
    await writeFile(script, '#!/bin/sh\nprintf unauthorized > "' + marker + '"\nexit 1\n', { mode: 0o700 });
    await r.git(['config', 'core.fsmonitor', script]); await r.git(['config', 'core.hooksPath', f.directory]);
    await r.git(['config', 'filter.trap.smudge', script]); await r.git(['config', 'filter.trap.clean', script]); await r.git(['config', 'credential.helper', script]);
    await writeFile(join(f.taskDirectory, '.gitattributes'), '* filter=trap\n', { mode: 0o600 });
    const frozen = await freezeSource(f.taskDirectory, r.task(oid), f.owner, f.artifacts);
    assert.equal(f.owner.ports.afterGitExec, undefined); assert.equal(frozen.baseObject, oid); assert.equal(frozen.sourceObject, oid);
    assert.deepEqual(frozen.artifacts.map(file => ({ name: file.name, bytes: Buffer.from(file.bytes) })), [{ name: 'example.ts', bytes }]);
    const restored = await restoreSource(f.taskDirectory, r.task(oid), f.owner, f.artifacts, frozen.inventory, frozen.workspace);
    assert.equal(canonical(restored), canonical(frozen));
    const beforeCorruption = JSON.parse(Buffer.from(await f.artifacts.read(frozen.inventory)).toString()) as { entries: { artifact: { name: string } }[] };
    const bodyPath = join(f.artifacts.directory, beforeCorruption.entries[0]!.artifact.name), originalBody = await readFile(bodyPath);
    await writeFile(bodyPath, Buffer.from('changed retained body'));
    await assert.rejects(restoreSource(f.taskDirectory, r.task(oid), f.owner, f.artifacts, frozen.inventory, frozen.workspace)); await writeFile(bodyPath, originalBody);
    await verifySource(frozen, r.task(oid), f.owner); assert.equal(await lstat(marker).then(() => true, error => error.code !== 'ENOENT'), false);
    const changed = await r.commit(await r.tree([{ mode: '100644', type: 'blob', oid: await r.blob(Buffer.from('changed\n')), name: 'example.ts' }])); assert.notEqual(changed, oid);
    await assert.rejects(verifySource(frozen, r.task(oid), f.owner), (error: unknown) => error instanceof ControllerFailure && error.diagnostic.code === 'TARGET_MISMATCH');
    const rows = (await readFile(f.owner.path, 'utf8')).trim().split('\n').map(line => JSON.parse(line) as { type: string; nonce?: string; code?: number; signal?: unknown; pid?: number; birth?: string });
    const started = rows.filter(row => row.type === 'started'), exited = rows.filter(row => row.type === 'exit');
    assert.ok(started.length >= 10); assert.equal(started.length, exited.length); assert.ok(exited.every(row => row.code === 0 && row.signal === null));
    for (const row of started) { assert.equal(await processBirth(row.pid!), null); assert.throws(() => process.kill(row.pid!, 0), (error: unknown) => (error as NodeJS.ErrnoException).code === 'ESRCH'); }
    await writeFile(join(f.directory, 'source-result.json'), canonical({ version: 1, kind: 'ordinary-production-no-hook', sourceObject: oid, changedObject: changed, inventory: frozen.inventory, workspace: frozen.workspace, byteDigest: hash(bytes), readerStarts: started.length, readerExits: exited.length, unauthorizedMarkerAbsent: true }), { mode: 0o600 });
  } finally { await f.close(); }
});
test('source topology refuses symlinks, submodules and case collisions before materializing bodies', async () => {
  const f = await retainedFixture();
  try {
    const r = await repository(f), blob = await r.blob(Buffer.from('inert')), base = await r.commit(await r.tree([{ mode: '100644', type: 'blob', oid: blob, name: 'base' }]));
    for (const entries of [
      [{ mode: '120000', type: 'blob', oid: blob, name: 'link' }],
      [{ mode: '160000', type: 'commit', oid: base, name: 'module' }],
      [{ mode: '100644', type: 'blob', oid: blob, name: 'Name' }, { mode: '100644', type: 'blob', oid: blob, name: 'name' }],
    ]) {
      await r.commit(await r.tree(entries));
      const before = (await readFile(f.owner.path, 'utf8')).split('\n').length;
      await assert.rejects(freezeSource(f.taskDirectory, r.task(base), f.owner, f.artifacts), (error: unknown) => error instanceof ControllerFailure && ['CAPABILITY_UNSUPPORTED', 'ARTIFACT_INVALID'].includes(error.diagnostic.code));
      const rows = (await readFile(f.owner.path, 'utf8')).trim().split('\n').slice(before - 1).map(line => JSON.parse(line) as { type: string });
      // Exactly top-level, two commit resolutions and full tree: no body read after a topology refusal.
      assert.equal(rows.filter(row => row.type === 'intent').length, 4);
    }
  } finally { await f.close(); }
});
test('source inventory switches to version 2 tree_overlay beyond the 128-file or 4-MiB classic thresholds', async () => {
  const f = await retainedFixture();
  try {
    const r = await repository(f), blob = await r.blob(Buffer.from('inert'));
    const crowded = await r.commit(await r.tree(Array.from({ length: 257 }, (_, index) => ({ mode: '100644', type: 'blob', oid: blob, name: 'f' + String(index).padStart(3, '0') }))));
    const crowdedFrozen = await freezeSource(f.taskDirectory, r.task(crowded), f.owner, f.artifacts);
    assert.equal(crowdedFrozen.version, 2);
    assert.equal(crowdedFrozen.baselineEntries?.length, 257);
    assert.equal(crowdedFrozen.artifacts.length, 0);
    assert.ok(crowdedFrozen.manifest.spec.baseTree !== undefined);
    const large = await r.commit(await r.tree([{ mode: '100644', type: 'blob', oid: await r.blob(Buffer.alloc(4194305, 97)), name: 'large' }]));
    const largeFrozen = await freezeSource(f.taskDirectory, r.task(large), f.owner, f.artifacts);
    assert.equal(largeFrozen.version, 2);
    assert.deepEqual(largeFrozen.baselineEntries?.map(item => item.name), ['large']);
    assert.equal(largeFrozen.artifacts.length, 0);
  } finally { await f.close(); }
});
