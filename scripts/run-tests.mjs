#!/usr/bin/env node
/* global process */
import { spawn } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { availableParallelism } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const PACKAGES = [
  'core',
  'state',
  'agent-pi',
  'controller',
  'cli',
  'taskpack-runner',
  'memory',
  'decisions',
  'github-app',
];

const EXTRA_TESTS = [
  'packages/agent-pi/qualification/absence.test.mjs',
  'packages/agent-pi/qualification/docker-socket.test.mjs',
  'packages/controller/qualification/schedule.test.mjs',
];

// Schedule long-pole integration suites first so multi-core workers never stall on tail stragglers.
const PRIORITY_WEIGHTS = new Map([
  ['tree-overlay.test.js', 110],
  ['turnkey-action.test.js', 105],
  ['python-bridge.test.js', 100],
  ['parity.test.js', 95],
  ['progress-checkpoint.test.js', 90],
  ['service-compile.test.js', 85],
  ['npm-pack.test.js', 80],
  ['closure-and-failure-matrix.test.js', 75],
  ['reconcile.test.js', 70],
  ['gate.test.js', 65],
  ['publication.test.js', 60],
  ['cli.test.js', 55],
]);

const discovered = [];
for (const pkg of PACKAGES) {
  const dir = join(REPO_ROOT, '.test-build', 'packages', pkg, 'test');
  const entries = readdirSync(dir)
    .filter(name => name.endsWith('.test.js'))
    .sort((a, b) => a.localeCompare(b, 'en'));
  for (const entry of entries) {
    discovered.push(`.test-build/packages/${pkg}/test/${entry}`);
  }
}
for (const extra of EXTRA_TESTS) {
  discovered.push(extra);
}

discovered.sort((a, b) => {
  const wa = PRIORITY_WEIGHTS.get(basename(a)) ?? 0;
  const wb = PRIORITY_WEIGHTS.get(basename(b)) ?? 0;
  if (wa !== wb) return wb - wa;
  return 0;
});

const requested = Number.parseInt(process.env.LW_TEST_CONCURRENCY ?? '', 10);
const concurrency = Number.isInteger(requested) && requested >= 1
  ? requested
  : Math.min(4, Math.max(2, availableParallelism()));

const child = spawn(process.execPath, ['--test', `--test-concurrency=${String(concurrency)}`, ...discovered], {
  cwd: REPO_ROOT,
  stdio: 'inherit',
});

child.on('exit', (code, signal) => {
  if (signal !== null) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 1);
});
