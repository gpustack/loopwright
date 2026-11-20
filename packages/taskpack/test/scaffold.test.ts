import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { TASKPACK_PACKAGE_NAME } from '../src/index.js';

function findRepositoryRoot(startDir = dirname(fileURLToPath(import.meta.url))): string {
  let curr = resolve(startDir);
  while (curr !== dirname(curr)) {
    const pkg = join(curr, 'package.json');
    if (existsSync(pkg)) {
      try {
        const parsed = JSON.parse(readFileSync(pkg, 'utf8')) as { name?: string };
        if (parsed.name === 'loopwright') return curr;
      } catch {
        // ignore parse errors
      }
    }
    curr = dirname(curr);
  }
  throw new Error('Could not locate loopwright repository root');
}

const REPO_ROOT = findRepositoryRoot();

test('@loopwright/taskpack scaffold exports package identity and isolated workspace boundaries', () => {
  assert.equal(TASKPACK_PACKAGE_NAME, '@loopwright/taskpack');

  const manifest = JSON.parse(
    readFileSync(join(REPO_ROOT, 'packages', 'taskpack', 'package.json'), 'utf8'),
  ) as {
    name?: string;
    private?: boolean;
    type?: string;
    main?: string;
    types?: string;
    files?: string[];
    exports?: Record<string, { types?: string; default?: string }>;
    dependencies?: Record<string, string>;
  };

  assert.equal(manifest.name, '@loopwright/taskpack');
  assert.equal(manifest.private, true);
  assert.equal(manifest.type, 'module');
  assert.equal(manifest.main, './dist/index.js');
  assert.equal(manifest.types, './dist/index.d.ts');
  assert.deepEqual(manifest.files, ['dist']);
  assert.deepEqual(manifest.exports, {
    '.': {
      types: './dist/index.d.ts',
      default: './dist/index.js',
    },
  });

  const deps = manifest.dependencies ?? {};
  for (const requiredDep of [
    '@loopwright/agent-pi',
    '@loopwright/controller',
    '@loopwright/core',
    '@loopwright/decisions',
    '@loopwright/memory',
    '@loopwright/state',
    'yaml',
  ]) {
    assert.ok(Object.hasOwn(deps, requiredDep), `missing dependency ${requiredDep}`);
  }
  assert.equal(Object.hasOwn(deps, '@loopwright/github-app'), false);
  assert.equal(Object.hasOwn(deps, '@loopwright/cli'), false);

  const tsconfig = JSON.parse(
    readFileSync(join(REPO_ROOT, 'packages', 'taskpack', 'tsconfig.json'), 'utf8'),
  ) as {
    compilerOptions?: { composite?: boolean; declaration?: boolean; rootDir?: string; outDir?: string };
    references?: Array<{ path?: string }>;
  };

  assert.equal(tsconfig.compilerOptions?.composite, true);
  assert.equal(tsconfig.compilerOptions?.declaration, true);
  assert.equal(tsconfig.compilerOptions?.rootDir, 'src');
  assert.equal(tsconfig.compilerOptions?.outDir, 'dist');
  const refPaths = new Set((tsconfig.references ?? []).map(ref => ref.path));
  assert.equal(refPaths.has('../github-app'), false);
  assert.equal(refPaths.has('../cli'), false);
});
