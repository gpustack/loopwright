#!/usr/bin/env node
/* global process */
import { spawn } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const TSC_BIN = join(REPO_ROOT, 'node_modules', 'typescript', 'bin', 'tsc');

const BUILD_TIERS = [
  ['core'],
  ['state'],
  ['agent-pi'],
  ['controller'],
  ['taskpack-runner', 'memory', 'github-app'],
  ['decisions'],
  ['cli'],
];

function buildPackage(pkg) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(process.execPath, [TSC_BIN, '-p', join('packages', pkg, 'tsconfig.json')], {
      cwd: REPO_ROOT,
      stdio: 'inherit',
    });
    child.on('error', rejectPromise);
    child.on('exit', code => {
      if (code === 0) resolvePromise();
      else rejectPromise(new Error(`tsc failed for packages/${pkg} (exit ${String(code)})`));
    });
  });
}

for (const tier of BUILD_TIERS) {
  await Promise.all(tier.map(pkg => buildPackage(pkg)));
}
