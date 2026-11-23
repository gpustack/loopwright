#!/usr/bin/env node
/* global console, process */
import { spawn } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { availableParallelism } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const MAX_ARGS = 64;
const MAX_SHARDS = 64;
const DEFAULT_SUITE_WEIGHT = 4;

const PACKAGES = [
  'core',
  'state',
  'agent-pi',
  'controller',
  'cli',
  'taskpack-runner',
  'memory',
  'decisions',
  'taskpack',
  'github-app',
  'hardware-runner',
  'evolution',
];

const PACKAGE_SET = new Set(PACKAGES);

const EXTRA_TESTS = [
  { pkg: 'agent-pi', path: 'packages/agent-pi/qualification/absence.test.mjs' },
  { pkg: 'agent-pi', path: 'packages/agent-pi/qualification/docker-socket.test.mjs' },
  { pkg: 'controller', path: 'packages/controller/qualification/schedule.test.mjs' },
];

// Calibrated LPT weights (approximate relative cost in seconds) so both multi-core worker queues
// and CI shards schedule heavy integration suites first without tail stragglers.
const PRIORITY_WEIGHTS = new Map([
  ['self-upgrade-taskpack.test.js', 75],
  ['mcp-repair-budgets.test.js', 74],
  ['turnkey-memory.test.js', 65],
  ['parity.test.js', 54],
  ['turnkey-memory-budget.test.js', 50],
  ['tree-overlay.test.js', 46],
  ['step-engine.test.js', 46],
  ['self-upgrade-verifier.test.js', 45],
  ['report-and-t3.test.js', 45],
  ['step-cli-fencing.test.js', 45],
  ['turnkey-action.test.js', 44],
  ['step-cli.test.js', 44],
  ['turnkey-action-app-auth.test.js', 36],
  ['mcp-limits-and-logs.test.js', 36],
  ['turnkey-memory-cas-guards.test.js', 35],
  ['reconcile.test.js', 35],
  ['progress-capacity.test.js', 35],
  ['gate.test.js', 34],
  ['turnkey-action-overlay.test.js', 26],
  ['docs-and-site.test.js', 24],
  ['npm-pack.test.js', 21],
  ['delegated-taskpack.test.js', 20],
  ['service-compile.test.js', 16],
  ['arguments.test.js', 15],
  ['taskpack-intake.test.js', 15],
  ['host-session.test.js', 14],
  ['publication.test.js', 12],
  ['external-mcp.test.js', 10],
  ['scheduling-cycle.test.js', 9],
  ['closure-and-failure-matrix.test.js', 8],
  ['control-plane-action.test.js', 8],
  ['sandbox.test.js', 8],
  ['python-bridge.test.js', 4],
]);

function usageError(message) {
  console.error(`run-tests: ${message}`);
  process.exit(2);
}

function parseShardSpec(raw) {
  const match = /^([1-9]\d*)\/([1-9]\d*)$/.exec(raw);
  if (!match) {
    usageError(`invalid --shard "${raw}"; expected <index>/<total> with 1-based positive integers`);
  }
  const index = Number.parseInt(match[1], 10);
  const total = Number.parseInt(match[2], 10);
  if (!Number.isSafeInteger(index) || !Number.isSafeInteger(total) || index < 1 || index > total || total > MAX_SHARDS) {
    usageError(`out-of-range --shard "${raw}"; expected 1 <= index <= total <= ${String(MAX_SHARDS)}`);
  }
  return { index, total };
}

function parseArgs(argv) {
  if (argv.length > MAX_ARGS) {
    usageError(`too many arguments (${String(argv.length)} > ${String(MAX_ARGS)})`);
  }
  let shard = null;
  const pkgs = new Set();
  let listOnly = false;
  let concurrency = null;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--list') {
      listOnly = true;
      continue;
    }
    if (arg === '--concurrency' || arg.startsWith('--concurrency=')) {
      if (concurrency !== null) usageError('duplicate --concurrency flag');
      const val = arg === '--concurrency' ? argv[++i] : arg.slice('--concurrency='.length);
      if (typeof val !== 'string' || !/^[1-9]\d*$/.test(val)) {
        usageError(`invalid --concurrency "${String(val ?? '')}"; expected positive integer`);
      }
      const parsedCount = Number.parseInt(val, 10);
      if (!Number.isSafeInteger(parsedCount) || parsedCount < 1 || parsedCount > MAX_SHARDS) {
        usageError(`out-of-range --concurrency "${val}"; expected 1..${String(MAX_SHARDS)}`);
      }
      concurrency = parsedCount;
      continue;
    }
    if (arg === '--shard' || arg.startsWith('--shard=')) {
      if (shard !== null) usageError('duplicate --shard flag');
      const val = arg === '--shard' ? argv[++i] : arg.slice('--shard='.length);
      if (typeof val !== 'string' || val.length === 0) usageError('missing value for --shard');
      shard = parseShardSpec(val);
      continue;
    }
    if (arg === '--pkg' || arg.startsWith('--pkg=')) {
      const val = arg === '--pkg' ? argv[++i] : arg.slice('--pkg='.length);
      if (typeof val !== 'string' || !PACKAGE_SET.has(val)) {
        usageError(`unknown --pkg "${String(val ?? '')}"; expected one of: ${PACKAGES.join(', ')}`);
      }
      pkgs.add(val);
      continue;
    }
    usageError(`unknown argument "${arg}"`);
  }

  return { shard, pkgs, listOnly, concurrency };
}

function suiteWeight(filePath) {
  return PRIORITY_WEIGHTS.get(basename(filePath)) ?? DEFAULT_SUITE_WEIGHT;
}

const parsed = parseArgs(process.argv.slice(2));
const selectedPackages = parsed.pkgs.size > 0
  ? PACKAGES.filter(pkg => parsed.pkgs.has(pkg))
  : PACKAGES;
const selectedPkgSet = new Set(selectedPackages);

const discovered = [];
for (const pkg of selectedPackages) {
  const dir = join(REPO_ROOT, '.test-build', 'packages', pkg, 'test');
  const entries = readdirSync(dir)
    .filter(name => name.endsWith('.test.js'))
    .sort((a, b) => a.localeCompare(b, 'en'));
  for (const entry of entries) {
    discovered.push(`.test-build/packages/${pkg}/test/${entry}`);
  }
}
for (const extra of EXTRA_TESTS) {
  if (selectedPkgSet.has(extra.pkg)) {
    discovered.push(extra.path);
  }
}

discovered.sort((a, b) => {
  const wa = suiteWeight(a);
  const wb = suiteWeight(b);
  if (wa !== wb) return wb - wa;
  return a < b ? -1 : a > b ? 1 : 0;
});

let targetFiles = discovered;
if (parsed.shard !== null) {
  const buckets = Array.from({ length: parsed.shard.total }, () => ({ load: 0, files: [] }));
  for (const file of discovered) {
    let bestIdx = 0;
    for (let idx = 1; idx < buckets.length; idx += 1) {
      const candidate = buckets[idx];
      const best = buckets[bestIdx];
      if (
        candidate.load < best.load
        || (candidate.load === best.load && candidate.files.length < best.files.length)
      ) {
        bestIdx = idx;
      }
    }
    buckets[bestIdx].files.push(file);
    buckets[bestIdx].load += suiteWeight(file);
  }
  targetFiles = buckets[parsed.shard.index - 1].files;
}

if (parsed.listOnly) {
  if (targetFiles.length > 0) {
    process.stdout.write(`${targetFiles.join('\n')}\n`);
  }
} else if (targetFiles.length > 0) {
  const requested = parsed.concurrency ?? Number.parseInt(process.env.LW_TEST_CONCURRENCY ?? '', 10);
  const isCi = Boolean(process.env.CI && process.env.CI !== '0' && process.env.CI !== 'false');
  const concurrency = Number.isInteger(requested) && requested >= 1
    ? requested
    : isCi
      ? Math.min(4, Math.max(2, availableParallelism()))
      : Math.min(6, Math.max(2, Math.floor(availableParallelism() / 3)));

  const child = spawn(process.execPath, ['--test', `--test-concurrency=${String(concurrency)}`, ...targetFiles], {
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
}
