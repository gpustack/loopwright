#!/usr/bin/env node
/* global process */
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const TSC_BIN = join(REPO_ROOT, 'node_modules', 'typescript', 'bin', 'tsc');
const TSBUILDINFO_DIR = join(REPO_ROOT, '.test-build', 'tsbuildinfo');
const INPUTS_DIGEST_PATH = join(TSBUILDINFO_DIR, 'inputs.sha256');

const PACKAGES = [
  'core',
  'state',
  'agent-pi',
  'controller',
  'taskpack-runner',
  'memory',
  'decisions',
  'github-app',
  'cli',
];

const NON_RUNTIME_DEV_PACKAGES = new Set(['eslint', '@eslint/js', 'typescript-eslint']);

function hashFileIfExists(hash, absPath) {
  if (!existsSync(absPath)) return;
  hash.update(relative(REPO_ROOT, absPath));
  hash.update('\0');
  hash.update(readFileSync(absPath));
  hash.update('\0');
}

function walkDependencyDeclarations(hash, dirPath) {
  if (!existsSync(dirPath)) return;
  const entries = readdirSync(dirPath, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name, 'en'));
  for (const entry of entries) {
    if (entry.name === 'node_modules') continue;
    const full = join(dirPath, entry.name);
    if (entry.isDirectory()) {
      walkDependencyDeclarations(hash, full);
    } else if (
      entry.isFile()
      && (
        entry.name === 'package.json'
        || entry.name.endsWith('.d.ts')
        || entry.name.endsWith('.d.mts')
        || entry.name.endsWith('.d.cts')
      )
    ) {
      hashFileIfExists(hash, full);
    }
  }
}

function computeBuildInputsDigest() {
  const hash = createHash('sha256');
  for (const rootFile of ['package.json', 'package-lock.json', 'tsconfig.json', 'tsconfig.test.json']) {
    hashFileIfExists(hash, join(REPO_ROOT, rootFile));
  }
  hashFileIfExists(hash, join(REPO_ROOT, 'node_modules', 'typescript', 'package.json'));

  const externalDeps = new Set();
  const rootPkgPath = join(REPO_ROOT, 'package.json');
  if (existsSync(rootPkgPath)) {
    const rootPkg = JSON.parse(readFileSync(rootPkgPath, 'utf8'));
    for (const dep of [...Object.keys(rootPkg.dependencies ?? {}), ...Object.keys(rootPkg.devDependencies ?? {})]) {
      if (!dep.startsWith('@loopwright/') && dep !== 'typescript' && !NON_RUNTIME_DEV_PACKAGES.has(dep)) {
        externalDeps.add(dep);
      }
    }
  }

  for (const pkg of PACKAGES) {
    const pkgJsonPath = join(REPO_ROOT, 'packages', pkg, 'package.json');
    hashFileIfExists(hash, pkgJsonPath);
    hashFileIfExists(hash, join(REPO_ROOT, 'packages', pkg, 'tsconfig.json'));
    if (existsSync(pkgJsonPath)) {
      const pkgJson = JSON.parse(readFileSync(pkgJsonPath, 'utf8'));
      for (const dep of [...Object.keys(pkgJson.dependencies ?? {}), ...Object.keys(pkgJson.devDependencies ?? {})]) {
        if (!dep.startsWith('@loopwright/') && dep !== 'typescript' && !NON_RUNTIME_DEV_PACKAGES.has(dep)) {
          externalDeps.add(dep);
        }
      }
    }
  }

  for (const dep of [...externalDeps].sort((a, b) => a.localeCompare(b, 'en'))) {
    walkDependencyDeclarations(hash, join(REPO_ROOT, 'node_modules', dep));
  }

  return hash.digest('hex');
}

function listMissingOutputPackages() {
  const missing = [];
  function hasMissingInDir(srcRoot, distRoot, curSrc) {
    if (!existsSync(curSrc)) return false;
    for (const entry of readdirSync(curSrc, { withFileTypes: true })) {
      const fullSrc = join(curSrc, entry.name);
      if (entry.isDirectory()) {
        if (hasMissingInDir(srcRoot, distRoot, fullSrc)) return true;
      } else if (entry.isFile() && entry.name.endsWith('.ts') && !entry.name.endsWith('.d.ts')) {
        const relStem = relative(srcRoot, fullSrc).slice(0, -'.ts'.length);
        if (
          !existsSync(join(distRoot, `${relStem}.js`))
          || !existsSync(join(distRoot, `${relStem}.d.ts`))
        ) {
          return true;
        }
      }
    }
    return false;
  }

  for (const pkg of PACKAGES) {
    const srcRoot = join(REPO_ROOT, 'packages', pkg, 'src');
    const distRoot = join(REPO_ROOT, 'packages', pkg, 'dist');
    if (
      !existsSync(join(TSBUILDINFO_DIR, `${pkg}.tsbuildinfo`))
      || hasMissingInDir(srcRoot, distRoot, srcRoot)
    ) {
      missing.push(pkg);
    }
  }
  return missing;
}

function clearAllBuildInfo() {
  if (!existsSync(TSBUILDINFO_DIR)) return;
  for (const name of readdirSync(TSBUILDINFO_DIR)) {
    if (name.endsWith('.tsbuildinfo') || name === 'inputs.sha256') {
      try {
        unlinkSync(join(TSBUILDINFO_DIR, name));
      } catch {
        // ignore concurrent/absent removal
      }
    }
  }
}

const rawArgs = process.argv.slice(2);
const ensureOnly = rawArgs.includes('--ensure');
const tscExtraArgs = rawArgs.filter(arg => arg !== '--ensure');

mkdirSync(TSBUILDINFO_DIR, { recursive: true });

const currentDigest = computeBuildInputsDigest();
const previousDigest = existsSync(INPUTS_DIGEST_PATH)
  ? readFileSync(INPUTS_DIGEST_PATH, 'utf8').trim()
  : '';
const inputsChanged = currentDigest !== previousDigest;

if (inputsChanged) {
  clearAllBuildInfo();
}

const missingPackages = listMissingOutputPackages();
if (!inputsChanged) {
  for (const pkg of missingPackages) {
    try {
      unlinkSync(join(TSBUILDINFO_DIR, `${pkg}.tsbuildinfo`));
    } catch {
      // ignore if already absent
    }
  }
}

if (ensureOnly && !inputsChanged && missingPackages.length === 0 && tscExtraArgs.length === 0) {
  process.exit(0);
}

await new Promise((resolvePromise, rejectPromise) => {
  const child = spawn(
    process.execPath,
    [TSC_BIN, '-b', join('packages', 'cli', 'tsconfig.json'), ...tscExtraArgs],
    {
      cwd: REPO_ROOT,
      stdio: 'inherit',
    },
  );
  child.on('error', rejectPromise);
  child.on('exit', code => {
    if (code === 0) resolvePromise();
    else rejectPromise(new Error(`tsc -b failed (exit ${String(code)})`));
  });
});

writeFileSync(INPUTS_DIGEST_PATH, `${currentDigest}\n`, 'utf8');
