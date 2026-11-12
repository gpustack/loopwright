#!/usr/bin/env node
/* global process, console */
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { chmodSync, cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const WORKSPACE_PACKAGES = [
  'core',
  'state',
  'agent-pi',
  'controller',
  'taskpack-runner',
  'memory',
  'decisions',
  'github-app',
  'cli'
];

const SEMVER_REGEX = /^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?$/;

function copyNonSymlinkTree(src, dest) {
  const stat = lstatSync(src);
  if (stat.isSymbolicLink()) {
    throw new Error(`Refusing to bundle symbolic link: ${src}`);
  }
  if (stat.isDirectory()) {
    mkdirSync(dest, { recursive: true });
    for (const entry of readdirSync(src)) {
      copyNonSymlinkTree(join(src, entry), join(dest, entry));
    }
    return;
  }
  if (!stat.isFile()) {
    throw new Error(`Refusing to bundle non-regular entry: ${src}`);
  }
  mkdirSync(dirname(dest), { recursive: true });
  cpSync(src, dest);
}

export function packNpmPackage(options = {}) {
  const repoRoot = resolve(options.repoRoot ?? dirname(dirname(fileURLToPath(import.meta.url))));
  const rootManifest = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8'));
  const rawVersion = String(options.version ?? process.env.NPM_PACKAGE_VERSION ?? rootManifest.version ?? '0.0.0').replace(/^v/, '');
  if (!SEMVER_REGEX.test(rawVersion)) {
    throw new Error(`Invalid SemVer2 version "${rawVersion}"`);
  }

  const outDir = resolve(options.outDir ?? join(repoRoot, 'dist-release'));
  mkdirSync(outDir, { recursive: true });

  const externalDependencies = Object.create(null);
  const overrides = rootManifest.overrides ?? {};
  for (const [name, ver] of Object.entries(overrides)) {
    externalDependencies[name] = ver;
  }

  for (const pkg of WORKSPACE_PACKAGES) {
    const distDir = join(repoRoot, 'packages', pkg, 'dist');
    if (!existsSync(distDir)) {
      throw new Error(`Missing built dist directory for @loopwright/${pkg}: ${distDir} (run "npm run build" first)`);
    }
    const pkgManifest = JSON.parse(readFileSync(join(repoRoot, 'packages', pkg, 'package.json'), 'utf8'));
    if (pkgManifest.private !== true) {
      throw new Error(`Workspace package @loopwright/${pkg} must keep "private": true`);
    }
    for (const [dep, ver] of Object.entries(pkgManifest.dependencies ?? {})) {
      if (!dep.startsWith('@loopwright/')) {
        externalDependencies[dep] = ver;
      }
    }
  }

  const sortedDependencies = Object.fromEntries(
    Object.entries(externalDependencies).sort(([a], [b]) => a.localeCompare(b, 'en'))
  );
  const bundledDependencies = WORKSPACE_PACKAGES.map(pkg => `@loopwright/${pkg}`);

  const stageRoot = mkdtempSync(join(tmpdir(), 'loopwright-npm-stage-'));
  try {
    const pkgDir = join(stageRoot, 'package');
    mkdirSync(join(pkgDir, 'bin'), { recursive: true });
    mkdirSync(join(pkgDir, 'node_modules', '@loopwright'), { recursive: true });

    const publishedManifest = {
      name: '@gpustack/loopwright',
      version: rawVersion,
      description: 'Bounded, verified repository automation harness and CLI',
      license: 'Apache-2.0',
      type: 'module',
      repository: {
        type: 'git',
        url: 'git+https://github.com/gpustack/loopwright.git'
      },
      homepage: 'https://docs.gpustack.ai/loopwright/',
      bugs: {
        url: 'https://github.com/gpustack/loopwright/issues'
      },
      engines: {
        node: '26.x'
      },
      publishConfig: {
        access: 'public',
        provenance: true
      },
      bin: {
        loopwright: './bin/loopwright.js'
      },
      exports: {
        '.': {
          types: './node_modules/@loopwright/cli/dist/index.d.ts',
          import: './node_modules/@loopwright/cli/dist/index.js'
        }
      },
      bundledDependencies,
      dependencies: sortedDependencies
    };

    writeFileSync(join(pkgDir, 'package.json'), `${JSON.stringify(publishedManifest, null, 2)}\n`, 'utf8');

    const binScript = [
      '#!/usr/bin/env node',
      "import { main } from '../node_modules/@loopwright/cli/dist/main.js';",
      'process.exitCode = await main(process.argv.slice(2));',
      ''
    ].join('\n');
    const binPath = join(pkgDir, 'bin', 'loopwright.js');
    writeFileSync(binPath, binScript, { encoding: 'utf8', mode: 0o755 });
    chmodSync(binPath, 0o755);

    copyNonSymlinkTree(join(repoRoot, 'LICENSE'), join(pkgDir, 'LICENSE'));
    copyNonSymlinkTree(join(repoRoot, 'README.md'), join(pkgDir, 'README.md'));
    copyNonSymlinkTree(join(repoRoot, 'package-lock.json'), join(pkgDir, 'package-lock.json'));
    // Preserve exact ../../../package-lock.json relative depth from node_modules/@loopwright/agent-pi/dist/index.js
    copyNonSymlinkTree(join(repoRoot, 'package-lock.json'), join(pkgDir, 'node_modules', 'package-lock.json'));

    for (const pkg of WORKSPACE_PACKAGES) {
      const srcPkgDir = join(repoRoot, 'packages', pkg);
      const destPkgDir = join(pkgDir, 'node_modules', '@loopwright', pkg);
      mkdirSync(destPkgDir, { recursive: true });
      const rawSubManifest = JSON.parse(readFileSync(join(srcPkgDir, 'package.json'), 'utf8'));
      const bundledSubManifest = {
        name: rawSubManifest.name,
        version: rawVersion,
        private: true,
        type: 'module',
        exports: rawSubManifest.exports
      };
      writeFileSync(join(destPkgDir, 'package.json'), `${JSON.stringify(bundledSubManifest, null, 2)}\n`, 'utf8');
      copyNonSymlinkTree(join(srcPkgDir, 'dist'), join(destPkgDir, 'dist'));
      if (existsSync(join(srcPkgDir, 'runtime'))) {
        copyNonSymlinkTree(join(srcPkgDir, 'runtime'), join(destPkgDir, 'runtime'));
      }
      if (existsSync(join(srcPkgDir, 'vendor'))) {
        copyNonSymlinkTree(join(srcPkgDir, 'vendor'), join(destPkgDir, 'vendor'));
      }
    }

    const tarballName = `gpustack-loopwright-${rawVersion}.tgz`;
    const tarballPath = join(outDir, tarballName);
    execFileSync('tar', ['-czf', tarballPath, '-C', stageRoot, 'package'], { stdio: 'pipe' });

    const sha256 = createHash('sha256').update(readFileSync(tarballPath)).digest('hex');
    const sha256Path = `${tarballPath}.sha256`;
    writeFileSync(sha256Path, `${sha256}  ${tarballName}\n`, 'utf8');

    return { version: rawVersion, tarballPath, sha256Path, sha256 };
  } finally {
    rmSync(stageRoot, { recursive: true, force: true });
  }
}

function parseCliArgs(argv) {
  let version;
  let outDir;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--version') {
      version = argv[++i];
    } else if (arg === '--out-dir') {
      outDir = argv[++i];
    } else {
      throw new Error(`Unknown flag: ${arg}`);
    }
  }
  return { version, outDir };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const { version, outDir } = parseCliArgs(process.argv.slice(2));
  const result = packNpmPackage({ version, outDir });
  console.log(`Packed @gpustack/loopwright@${result.version} -> ${result.tarballPath} (sha256:${result.sha256})`);
}
