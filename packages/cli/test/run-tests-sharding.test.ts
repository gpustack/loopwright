import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
const RUNNER_PATH = join(REPO_ROOT, 'scripts', 'run-tests.mjs');

function runRunner(args: readonly string[]) {
  return spawnSync(process.execPath, [RUNNER_PATH, ...args], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    timeout: 10_000,
  });
}

function parseLines(stdout: string): string[] {
  return stdout
    .split('\n')
    .map(line => line.trim())
    .filter(line => line.length > 0);
}

test('run-tests: 3-way sharding forms an exact, duplicate-free, balanced partition of all suites', () => {
  const allRes = runRunner(['--list']);
  assert.equal(allRes.status, 0, allRes.stderr);
  const allFiles = parseLines(allRes.stdout);
  assert.ok(allFiles.length >= 90, `expected >= 90 suites, found ${String(allFiles.length)}`);

  const shardLists: string[][] = [];
  for (const spec of ['1/3', '2/3', '3/3']) {
    const res = runRunner(['--shard', spec, '--list']);
    assert.equal(res.status, 0, res.stderr);
    const list = parseLines(res.stdout);
    assert.ok(list.length >= 20, `expected shard ${spec} to be populated, found ${String(list.length)}`);
    shardLists.push(list);
  }

  const combined = shardLists.flat();
  assert.equal(combined.length, allFiles.length);
  assert.equal(new Set(combined).size, allFiles.length);
  assert.deepEqual([...combined].sort(), [...allFiles].sort());
});

test('run-tests: supports repeatable --pkg filtering and exits 0 cleanly on an empty high shard', () => {
  const pkgRes = runRunner(['--pkg', 'core', '--pkg=agent-pi', '--list']);
  assert.equal(pkgRes.status, 0, pkgRes.stderr);
  const files = parseLines(pkgRes.stdout);
  assert.ok(files.some(f => f.startsWith('.test-build/packages/core/test/')));
  assert.ok(files.some(f => f.startsWith('.test-build/packages/agent-pi/test/')));
  assert.ok(files.includes('packages/agent-pi/qualification/absence.test.mjs'));
  assert.equal(files.some(f => f.includes('/packages/github-app/')), false);
  assert.equal(files.includes('packages/controller/qualification/schedule.test.mjs'), false);

  const emptyShardRes = runRunner(['--pkg', 'decisions', '--shard=20/20']);
  assert.equal(emptyShardRes.status, 0, emptyShardRes.stderr);
  assert.equal(emptyShardRes.stdout, '');
});

test('run-tests: fails closed with exit 2 on malformed shards, unknown packages, unknown flags, and >64 args', () => {
  const invalidCases: readonly (readonly string[])[] = [
    ['--shard', '0/3'],
    ['--shard', '4/3'],
    ['--shard', '1/0'],
    ['--shard', '1/65'],
    ['--shard', 'abc'],
    ['--shard'],
    ['--shard', '1/3', '--shard', '2/3'],
    ['--pkg', 'nonexistent'],
    ['--pkg='],
    ['--unknown-flag'],
    Array.from({ length: 65 }, () => '--list'),
  ];

  for (const argv of invalidCases) {
    const res = runRunner(argv);
    assert.equal(res.status, 2, `expected exit 2 for ${JSON.stringify(argv)}, got ${String(res.status)}`);
  }
});
