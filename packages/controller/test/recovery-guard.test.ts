import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, utimes, rename, symlink, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { retainedFixture } from './progress-fixtures.js';
import { ControllerOwner } from '../src/ownership.js';
import { canonical, hash } from '../src/schema.js';
import { ControllerFailure } from '../src/errors.js';
test('a retained recovery guard is never removed merely because its timestamps are old', async () => {
  const f = await retainedFixture();
  try {
    const path = f.owner.path + '.recovery', bytes = Buffer.from(canonical({ version: 1, kind: 'synthetic-unverifiable-recovery-owner' }));
    await writeFile(path, bytes, { mode: 0o600, flag: 'wx' }); await utimes(path, new Date(0), new Date(0));
    await assert.rejects(ControllerOwner.acquire(f.directory, 'run-1', f.plan.planDigest), (error: unknown) => error instanceof ControllerFailure && error.diagnostic.code === 'OWNER_BUSY');
    assert.deepEqual(await readFile(path), bytes);
    await writeFile(join(f.directory, 'retained-recovery-guard-result.json'), canonical({ version: 1, kind: 'synthetic-guard-vector', path, digest: hash(bytes), oldTimestampDidNotAuthorizeRemoval: true, deliberatelyRetained: true }), { mode: 0o600 });
  } finally { await f.close(); }
});
for (const field of ['boot', 'birth'] as const) test('unverifiable previous owner ' + field + ' retains both guards and refuses takeover', async () => {
  const f = await retainedFixture();
  try {
    const original = await readFile(f.owner.path), owner = JSON.parse(original.toString()) as Record<string, unknown>;
    owner[field] = 'unverifiable-unit-' + field; await writeFile(f.owner.path, canonical(owner) + '\n');
    const modified = await readFile(f.owner.path);
    await assert.rejects(ControllerOwner.acquire(f.directory, 'run-1', f.plan.planDigest), (error: unknown) => error instanceof ControllerFailure && error.diagnostic.code === 'RECOVERY_REQUIRED');
    assert.deepEqual(await readFile(f.owner.path), modified); const recovery = await readFile(f.owner.path + '.recovery'); assert.ok(recovery.byteLength > 0);
    await writeFile(join(f.directory, 'unverifiable-owner-result.json'), canonical({ version: 1, kind: 'synthetic-owner-vector', field, originalDigest: hash(original), retainedOwnerDigest: hash(modified), retainedRecoveryDigest: hash(recovery), takeoverRefused: true, recoveryGuardDeliberatelyRetained: true }), { mode: 0o600 });
  } finally { await f.close(); }
});
test('substituting a symlink for the private owner directory refuses before a reader intent or child', async () => {
  const f = await retainedFixture(), moved = join(f.root, 'retained-original'); let substituted = false;
  try {
    const before = await readFile(f.owner.path); await rename(f.directory, moved); await symlink(moved, f.directory); substituted = true;
    await assert.rejects(f.owner.assertCurrent()); await assert.rejects(f.owner.git(f.taskDirectory, ['--version'], 4096));
    assert.deepEqual(await readFile(join(moved, 'controller.owner.ndjson')), before);
  } finally {
    if (substituted) { await unlink(f.directory); await rename(moved, f.directory); }
    await f.close();
  }
});
