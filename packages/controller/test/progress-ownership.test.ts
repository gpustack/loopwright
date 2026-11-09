import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFile, writeFile, lstat } from 'node:fs/promises';
import { join } from 'node:path';
import { ControllerOwner, processBirth, bootIdentity } from '../src/ownership.js';
import { GIT_ENVIRONMENT } from '../src/git-reader.js';
import { privateDirectory } from '../src/storage.js';
import { hash } from '../src/schema.js';
import { ControllerFailure } from '../src/errors.js';
import { configurationFixture } from './config-fixtures.js';
test('the actual fixed Git reader has a durable started record and retains PID/birth across execve', async () => {
  const f = await configurationFixture(), directory = join(f.root, 'retained'); await privateDirectory(directory, [f.taskDirectory]);
  await writeFile(join(directory, 'setup-intent.json'), JSON.stringify({ version: 1, pid: process.pid, birth: await processBirth(process.pid), boot: await bootIdentity(), repository: f.taskDirectory, command: 'git init --template=' }), { mode: 0o600 });
  execFileSync('/usr/bin/git', ['-c', 'core.hooksPath=/dev/null', 'init', '--template=', '--initial-branch=main', f.taskDirectory], { env: GIT_ENVIRONMENT, timeout: 10000, maxBuffer: 65536, stdio: 'pipe' });
  let observed = 0; const observations: { pid: number; birth: string; nonce: string; command: string }[] = [];
  const owner = await ControllerOwner.acquire(directory, 'reader-probe', hash('reader-probe'), { afterGitExec: async identity => {
    const rows = (await readFile(join(directory, 'controller.owner.ndjson'), 'utf8')).trim().split('\n').map(line => JSON.parse(line) as Record<string, unknown>);
    const started = rows.find(row => row.type === 'started' && row.nonce === identity.nonce); assert.ok(started); assert.equal(started.pid, identity.pid); assert.equal(started.birth, identity.birth);
    assert.equal(rows.some(row => row.type === 'exit' && row.nonce === identity.nonce), false);
    assert.equal(await processBirth(identity.pid), identity.birth);
    const command = execFileSync('/bin/ps', ['-p', String(identity.pid), '-o', 'comm='], { timeout: 2000, maxBuffer: 4096, env: { PATH: '/usr/bin:/bin', LANG: 'C', LC_ALL: 'C' }, encoding: 'utf8' }).trim();
    assert.match(command, /(?:^|\/)git$/); observed++; observations.push({ ...identity, command });
  } });
  try {
    const result = await owner.git(f.taskDirectory, ['cat-file', '--batch'], 4096); assert.equal(result.byteLength, 0); assert.equal(observed, 1);
    const rows = (await readFile(owner.path, 'utf8')).trim().split('\n').map(line => JSON.parse(line) as Record<string, unknown>);
    assert.deepEqual(rows.map(row => row.type), ['owner', 'intent', 'started', 'exit']); assert.equal(rows.at(-1)!.code, 0);
    await writeFile(join(directory, 'reader-journal.ndjson'), await readFile(owner.path), { mode: 0o600 });
    await writeFile(join(directory, 'reader-live-observations.json'), JSON.stringify(observations), { mode: 0o600 });
    await writeFile(join(directory, 'reader-result.json'), JSON.stringify({ version: 1, status: 'passed', observed, journalBeforeGit: true, samePidAndBirth: true, closed: true }), { mode: 0o600 });
  } finally {
    await owner.release();
    const guardAbsent = await lstat(owner.path).then(() => false, error => error.code === 'ENOENT'); assert.equal(guardAbsent, true);
    for (const identity of observations) { assert.equal(await processBirth(identity.pid), null); assert.throws(() => process.kill(identity.pid, 0), (error: unknown) => (error as NodeJS.ErrnoException).code === 'ESRCH'); }
    await writeFile(join(directory, 'reader-release.json'), JSON.stringify({ version: 1, guardAbsent, readers: observations.map(identity => ({ pid: identity.pid, birth: identity.birth, absenceConfirmed: true })) }), { mode: 0o600 });
  }
});
test('a live controller owner blocks a second owner despite a separate open attempt', async () => {
  const f = await configurationFixture(), directory = join(f.root, 'retained'); await privateDirectory(directory, [f.taskDirectory]);
  const digest = hash('owner-probe'), first = await ControllerOwner.acquire(directory, 'owner-probe', digest);
  try {
    await assert.rejects(ControllerOwner.acquire(directory, 'owner-probe', digest), (error: unknown) => error instanceof ControllerFailure && error.diagnostic.code === 'OWNER_BUSY');
    await writeFile(join(directory, 'owner-journal.ndjson'), await readFile(first.path), { mode: 0o600 });
    await writeFile(join(directory, 'owner-result.json'), JSON.stringify({ version: 1, secondOwner: 'OWNER_BUSY', livePid: process.pid }), { mode: 0o600 });
  }
  finally { await first.release(); }
});
