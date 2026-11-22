import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { cp, mkdir, mkdtemp, readFile, rm, symlink, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');

const PACKAGES = [
  'core',
  'state',
  'agent-pi',
  'controller',
  'taskpack-runner',
  'memory',
  'decisions',
  'taskpack',
  'github-app',
  'hardware-runner',
  'cli',
] as const;

test('build.mjs: restores deleted dist outputs and invalidates tsbuildinfo when dependency declarations change', async () => {
  const work = await mkdtemp(join(tmpdir(), 'lw-build-inc-'));
  try {
    // Create a minimal 11-package composite workspace using the real scripts/build.mjs and real tsconfig.json layout
    await mkdir(join(work, 'scripts'), { recursive: true });
    await cp(join(REPO_ROOT, 'scripts', 'build.mjs'), join(work, 'scripts', 'build.mjs'));
    await cp(join(REPO_ROOT, 'tsconfig.json'), join(work, 'tsconfig.json'));
    await cp(join(REPO_ROOT, 'tsconfig.test.json'), join(work, 'tsconfig.test.json'));

    // Set up node_modules: symlink typescript & @types/node from REPO_ROOT, create mutable local yaml package
    await mkdir(join(work, 'node_modules', '@types'), { recursive: true });
    await symlink(join(REPO_ROOT, 'node_modules', 'typescript'), join(work, 'node_modules', 'typescript'));
    await symlink(join(REPO_ROOT, 'node_modules', '@types', 'node'), join(work, 'node_modules', '@types', 'node'));

    const yamlModDir = join(work, 'node_modules', 'yaml');
    await mkdir(yamlModDir, { recursive: true });
    await writeFile(
      join(yamlModDir, 'package.json'),
      JSON.stringify({ name: 'yaml', version: '2.9.0', type: 'module', types: './index.d.ts', exports: { '.': { types: './index.d.ts', default: './index.js' } } }, null, 2),
      'utf8',
    );
    await writeFile(join(yamlModDir, 'index.js'), 'export function parseDocument(s) { return { contents: s }; }\n', 'utf8');
    await writeFile(join(yamlModDir, 'index.d.ts'), 'export declare function parseDocument(src: string): { contents: string };\n', 'utf8');

    await writeFile(
      join(work, 'package.json'),
      JSON.stringify({
        name: 'loopwright',
        version: '0.0.0',
        private: true,
        type: 'module',
        devDependencies: { '@types/node': '26.6.6', typescript: '6.0.3' },
      }, null, 2),
      'utf8',
    );
    await writeFile(join(work, 'package-lock.json'), JSON.stringify({ name: 'loopwright', lockfileVersion: 3, packages: { 'node_modules/yaml': { version: '2.9.0' } } }), 'utf8');

    for (const pkg of PACKAGES) {
      const pkgDir = join(work, 'packages', pkg);
      await mkdir(join(pkgDir, 'src'), { recursive: true });
      await cp(join(REPO_ROOT, 'packages', pkg, 'tsconfig.json'), join(pkgDir, 'tsconfig.json'));
      const usesYaml = pkg === 'cli';
      await writeFile(
        join(pkgDir, 'package.json'),
        JSON.stringify({
          name: `@loopwright/${pkg}`,
          version: '0.0.0',
          private: true,
          type: 'module',
          exports: { '.': './dist/index.js' },
          dependencies: usesYaml ? { '@loopwright/core': '0.0.0', yaml: '2.9.0' } : {},
        }, null, 2),
        'utf8',
      );
      if (pkg !== 'cli') {
        await writeFile(join(pkgDir, 'src', 'index.ts'), `export const ${pkg.replace('-', '_').toUpperCase()}_ID = '${pkg}';\n`, 'utf8');
      }
    }

    await mkdir(join(work, 'node_modules', '@loopwright'), { recursive: true });
    for (const pkg of PACKAGES) {
      await symlink(join(work, 'packages', pkg), join(work, 'node_modules', '@loopwright', pkg));
    }
    await writeFile(
      join(work, 'packages', 'cli', 'src', 'index.ts'),
      `import { parseDocument } from 'yaml';\nimport { CORE_ID } from '@loopwright/core';\nexport const CLI_DOC: string = parseDocument(CORE_ID).contents;\n`,
      'utf8',
    );

    const runBuild = (extraArgs: readonly string[] = []) =>
      spawnSync(process.execPath, [join(work, 'scripts', 'build.mjs'), ...extraArgs], {
        cwd: work,
        encoding: 'utf8',
        timeout: 30_000,
      });

    // 1. Initial cold build succeeds
    const cold = runBuild();
    assert.equal(cold.status, 0, cold.stderr);
    assert.equal(existsSync(join(work, 'packages', 'core', 'dist', 'index.js')), true);
    assert.equal(existsSync(join(work, '.test-build', 'tsbuildinfo', 'core.tsbuildinfo')), true);

    // 2. Deleting packages/core/dist/index.js while keeping .tsbuildinfo intact MUST restore it on rebuild AND --ensure
    await unlink(join(work, 'packages', 'core', 'dist', 'index.js'));
    assert.equal(existsSync(join(work, 'packages', 'core', 'dist', 'index.js')), false);

    const ensured = runBuild(['--ensure']);
    assert.equal(ensured.status, 0, ensured.stderr);
    assert.equal(existsSync(join(work, 'packages', 'core', 'dist', 'index.js')), true);

    // Deleting all package dist directories also restores all outputs
    for (const pkg of PACKAGES) {
      await rm(join(work, 'packages', pkg, 'dist'), { recursive: true, force: true });
    }
    const rebuiltAll = runBuild();
    assert.equal(rebuiltAll.status, 0, rebuiltAll.stderr);
    for (const pkg of PACKAGES) {
      assert.equal(existsSync(join(work, 'packages', pkg, 'dist', 'index.js')), true, `missing restored dist for ${pkg}`);
    }

    // 3. Incompatible dependency declaration update + lockfile bump (with zero src/*.ts edits) MUST invalidate cache and fail build
    await writeFile(
      join(yamlModDir, 'index.d.ts'),
      'export declare function parseDocument(src: number): { contents: number };\n',
      'utf8',
    );
    const prevLock = await readFile(join(work, 'package-lock.json'), 'utf8');
    await writeFile(join(work, 'package-lock.json'), prevLock.replace('2.9.0', '2.10.0'), 'utf8');

    const brokenDepBuild = runBuild();
    assert.notEqual(brokenDepBuild.status, 0, 'incompatible dependency declaration must fail build instead of using stale tsbuildinfo');
  } finally {
    await rm(work, { recursive: true, force: true });
  }
});
