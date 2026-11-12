import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

function findRepositoryRoot(startDir = dirname(fileURLToPath(import.meta.url))): string {
  let curr = resolve(startDir);
  while (curr !== dirname(curr)) {
    const pkg = join(curr, 'package.json');
    if (existsSync(pkg)) {
      try {
        const parsed = JSON.parse(readFileSync(pkg, 'utf8')) as { name?: string };
        if (parsed.name === 'loopwright') return curr;
      } catch {
        // ignore
      }
    }
    curr = dirname(curr);
  }
  return resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
}

const REPO_ROOT = findRepositoryRoot();

interface PackNpmResult {
  readonly version: string;
  readonly tarballPath: string;
  readonly sha256Path: string;
  readonly sha256: string;
}

test('pack-npm: builds single @gpustack/loopwright tarball, keeps workspace packages private, and installs functional global CLI', async () => {
  const packMod = (await import(pathToFileURL(join(REPO_ROOT, 'scripts', 'pack-npm.mjs')).href)) as {
    packNpmPackage: (options: { repoRoot: string; version: string; outDir: string }) => PackNpmResult;
  };

  const sandbox = realpathSync(mkdtempSync(join(tmpdir(), 'loopwright-npm-pack-test-')));
  try {
    const outDir = join(sandbox, 'out');
    const packed = packMod.packNpmPackage({ repoRoot: REPO_ROOT, version: '0.1.0-rc1', outDir });
    assert.equal(packed.version, '0.1.0-rc1');
    assert.ok(existsSync(packed.tarballPath), 'tarball must exist');
    assert.ok(existsSync(packed.sha256Path), 'sha256 file must exist');
    assert.equal(
      createHash('sha256').update(readFileSync(packed.tarballPath)).digest('hex'),
      packed.sha256,
      'sha256 must match packed tarball bytes'
    );

    const prefixDir = join(sandbox, 'global-prefix');
    try {
      execFileSync('npm', ['install', '-g', '--prefix', prefixDir, packed.tarballPath, '--offline', '--no-audit', '--no-fund'], {
        stdio: 'pipe',
        timeout: 60000
      });
    } catch (error) {
      const stderr = error !== null && typeof error === 'object' && 'stderr' in error && Buffer.isBuffer(error.stderr)
        ? error.stderr.toString('utf8')
        : String(error);
      if (!stderr.includes('ENOTCACHED')) throw error;
      execFileSync('npm', ['install', '-g', '--prefix', prefixDir, packed.tarballPath, '--prefer-offline', '--no-audit', '--no-fund'], {
        stdio: 'pipe',
        timeout: 60000
      });
    }

    const installedPkgRoot = join(prefixDir, 'lib', 'node_modules', '@gpustack', 'loopwright');
    const installedManifest = JSON.parse(readFileSync(join(installedPkgRoot, 'package.json'), 'utf8')) as {
      name: string;
      version: string;
      bundledDependencies: string[];
      dependencies: Record<string, string>;
    };
    assert.equal(installedManifest.name, '@gpustack/loopwright');
    assert.equal(installedManifest.version, '0.1.0-rc1');
    assert.equal(installedManifest.bundledDependencies.length, 9);
    assert.equal(installedManifest.dependencies['minimatch'], '11.0.1');

    const binPath = join(prefixDir, 'bin', 'loopwright');
    assert.ok(existsSync(binPath), 'installed global loopwright binary must exist');

    const versionRun = spawnSync(process.execPath, [binPath, '--version'], { encoding: 'utf8', timeout: 10000 });
    assert.equal(versionRun.status, 0, `loopwright --version failed: ${versionRun.stderr}`);
    assert.equal(versionRun.stdout.trim(), '0.1.0-rc1');

    const helpRun = spawnSync(process.execPath, [binPath, '--help'], { encoding: 'utf8', timeout: 10000 });
    assert.equal(helpRun.status, 0, `loopwright --help failed: ${helpRun.stderr}`);
    assert.match(helpRun.stdout, /^loopwright 0\.1\.0-rc1\n/);
    assert.match(helpRun.stdout, /app-serve --config FILE/);

    const draftDir = join(sandbox, 'drafts');
    const initRun = spawnSync(process.execPath, [binPath, 'init', '--directory', draftDir, '--json'], {
      encoding: 'utf8',
      timeout: 10000
    });
    assert.equal(initRun.status, 0, `loopwright init failed: ${initRun.stderr}`);
    assert.ok(existsSync(join(draftDir, 'controller.draft.yaml')), 'controller.draft.yaml must be generated');
    assert.ok(existsSync(join(draftDir, 'registry.draft.yaml')), 'registry.draft.yaml must be generated');

    const registrySha = createHash('sha256').update(readFileSync(join(draftDir, 'registry.draft.yaml'))).digest('hex');
    const checkRun = spawnSync(
      process.execPath,
      [
        binPath,
        'check',
        '--config',
        join(draftDir, 'controller.draft.yaml'),
        '--registry',
        join(draftDir, 'registry.draft.yaml'),
        '--registry-sha256',
        registrySha,
        '--json'
      ],
      { encoding: 'utf8', timeout: 10000 }
    );
    // Draft contains REVIEW_REQUIRED profileRef placeholder -> exits 2 at compile phase after loading YAML & handler digests cleanly
    assert.equal(checkRun.status, 2, `expected draft placeholder refusal exit 2, got ${checkRun.status}: ${checkRun.stderr}`);
    assert.match(checkRun.stdout, /"kind":"diagnostic"/);
  } finally {
    rmSync(sandbox, { recursive: true, force: true });
  }
});
