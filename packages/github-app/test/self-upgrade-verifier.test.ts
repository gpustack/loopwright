import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { chmod, link, mkdir, readFile, realpath, rm, stat, unlink, writeFile } from 'node:fs/promises';
import http from 'node:http';
import net from 'node:net';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';
import { parseDocument } from 'yaml';
import { loadTrustedConfiguration, stepNext } from '@loopwright/controller';
import {
  CANONICAL_TASKPACK_STEP_GATE_URL,
  compileDeclarativeTaskpack,
  DEFAULT_HOST_BUDGETS,
  DEFAULT_LOCAL_COMMAND_GATE_ENV,
  loadDeclarativeTaskpack,
  LOCAL_COMMAND_GATE_ENDPOINT_ID,
  PREFLIGHT_MAX_WORKSPACE_RESOURCE_BYTES,
  PREFLIGHT_MAX_WORKSPACE_RESOURCES_TOTAL_BYTES,
  resolveRepositoryAndRevisions,
  serializePrettyYaml,
} from '../src/index.js';
import {
  REPO_ROOT,
  CAN_RUN_KERNEL_CONTAINMENT,
  loadPreflightModule,
  withTempDir,
  PI_PACKAGE_NAMES,
  buildUstarTgzBuffer,
  buildSyntheticLockfile,
  createMiniSelfUpgradeRepo,
  stageAndApplyCandidateUpgrade,
  runVerifyScript,
} from './self-upgrade-fixtures.js';

describe('Self-upgrade verifier offline tarballs, hardlink/FIFO guards, and loopback-only runtime isolation', () => {
  it('guards against hardlink chmod mutation, FIFO open blocking, uncommitted HEAD baseline drift, and unverified no-change bypass', async () => {
    const preflight = await loadPreflightModule();

    await withTempDir(async dir => {
      const { repoRoot, headSha } = await createMiniSelfUpgradeRepo(dir);

      // 1) Pre-existing hardlink inside stageDir must NOT have its external target mode mutated during cleanup
      const externalExecPath = join(dir, 'external-tool.sh');
      await writeFile(externalExecPath, '#!/usr/bin/env bash\nexit 0\n', { mode: 0o755 });
      await chmod(externalExecPath, 0o755);
      const stageWithHardlink = join(dir, 'stage-existing-hardlink');
      await mkdir(stageWithHardlink, { recursive: true, mode: 0o700 });
      await link(externalExecPath, join(stageWithHardlink, 'linked-tool.sh'));
      await chmod(stageWithHardlink, 0o555);

      await preflight.stageCandidateBundle({
        repoRoot,
        stageDir: stageWithHardlink,
        targetVersions: preflight.buildTargetVersionsPayload('1.6.0', '2.10.0'),
        lockfileBuilder: async () => Buffer.from(
          buildSyntheticLockfile({ piVersion: '1.6.0', yamlVersion: '2.10.0' }),
          'utf8',
        ),
      });
      const externalMode = (await stat(externalExecPath)).mode & 0o777;
      assert.equal(externalMode, 0o755, `expected external executable mode 0o755 to remain intact, got 0o${externalMode.toString(8)}`);

      // 2) Named FIFO at .auto-sync/proposal.json fails fast without blocking open()
      const proposalPath = join(repoRoot, '.auto-sync/proposal.json');
      const savedProposal = await readFile(proposalPath);
      await unlink(proposalPath);
      const mkfifoProbe = spawnSync('mkfifo', [proposalPath], { stdio: 'ignore' });
      if (mkfifoProbe.status === 0) {
        const fifoPreflight = spawnSync(
          process.execPath,
          [join(REPO_ROOT, 'scripts/prepare-self-upgrade.mjs'), '--repo', repoRoot, '--offline-check'],
          { encoding: 'utf8', timeout: 5_000 },
        );
        assert.equal(fifoPreflight.error, undefined, 'FIFO preflight check must not time out');
        assert.notEqual(fifoPreflight.status, 0);
        assert.equal(fifoPreflight.stderr.includes('Expected regular file'), true);

        const fifoVerify = runVerifyScript(repoRoot, {
          SELF_UPGRADE_REPO_ROOT: repoRoot,
          LOOPWRIGHT_STAGED_DIR: stageWithHardlink,
        });
        assert.notEqual(fifoVerify.status, 0);
        assert.equal(fifoVerify.stderr.includes('regular file') || fifoVerify.stderr.includes('non-regular'), true);
      }
      await rm(proposalPath, { force: true });
      await writeFile(proposalPath, savedProposal, { mode: 0o600 });

      // 3) Coherent uncommitted working-tree and staged index changes are rejected against committed HEAD
      const coherentTarget = preflight.buildTargetVersionsPayload('1.6.0', '2.10.0');
      await writeFile(proposalPath, `${JSON.stringify(coherentTarget, null, 2)}\n`, { mode: 0o600 });
      await writeFile(
        join(repoRoot, 'package-lock.json'),
        buildSyntheticLockfile({ piVersion: '1.6.0', yamlVersion: '2.10.0' }),
        { mode: 0o600 },
      );
      for (const [ws, depUpdates] of Object.entries(coherentTarget.packages)) {
        const wsPkgPath = join(repoRoot, ws, 'package.json');
        const wsPkg = JSON.parse(await readFile(wsPkgPath, 'utf8')) as { dependencies: Record<string, string> };
        wsPkg.dependencies = { ...wsPkg.dependencies, ...depUpdates };
        await writeFile(wsPkgPath, `${JSON.stringify(wsPkg, null, 2)}\n`, { mode: 0o600 });
      }
      await assert.rejects(
        () => preflight.auditBaselineParity(repoRoot),
        /Uncommitted baseline drift/,
      );

      spawnSync('git', ['add', '.'], { cwd: repoRoot, stdio: 'ignore' });
      await assert.rejects(
        () => preflight.auditBaselineParity(repoRoot),
        /Uncommitted staged baseline drift/,
      );
      spawnSync('git', ['reset', '--hard', headSha], { cwd: repoRoot, stdio: 'ignore' });

      // 4) Explicit requestedMode: 'no-change' evaluates discovery and blocks on failed or available upstreams
      const failedNoChange = await preflight.runPrepareSelfUpgrade({
        repoRoot,
        stageDir: join(dir, 'stage-nc-failed'),
        requestedMode: 'no-change',
        registryFixtures: Object.fromEntries(
          preflight.ALL_UPSTREAM_IDS.map(id => [
            id,
            id === 'yaml' ? { __httpStatus: 503 } : { version: '1.5.0' },
          ]),
        ),
      });
      assert.equal(failedNoChange.recommendedMode, 'blocked');
      assert.equal(failedNoChange.upstreamVerified, true);
      assert.equal(failedNoChange.upstreamRecords.some(r => r.upstreamId === 'yaml' && r.status === 'blocked'), true);

      const outdatedNoChange = await preflight.runPrepareSelfUpgrade({
        repoRoot,
        stageDir: join(dir, 'stage-nc-outdated'),
        requestedMode: 'no-change',
        registryFixtures: Object.fromEntries(
          preflight.ALL_UPSTREAM_IDS.map(id => [
            id,
            { version: id === 'yaml' ? '2.10.0' : '1.5.0' },
          ]),
        ),
      });
      assert.equal(outdatedNoChange.recommendedMode, 'blocked');
      assert.equal(outdatedNoChange.upstreamRecords.some(r => r.upstreamId === 'yaml' && r.status === 'blocked'), true);

      const validNoChange = await preflight.runPrepareSelfUpgrade({
        repoRoot,
        stageDir: join(dir, 'stage-nc-valid'),
        requestedMode: 'no-change',
        registryFixtures: Object.fromEntries(
          preflight.ALL_UPSTREAM_IDS.map(id => [
            id,
            { version: id === 'yaml' ? '2.9.0' : '1.5.0' },
          ]),
        ),
      });
      assert.equal(validNoChange.recommendedMode, 'no-change');
      assert.equal(validNoChange.actionMode, 'no-change');
      assert.equal(validNoChange.upstreamVerified, true);

      // Refuse --offline-check combined with LOOPWRIGHT_PREFLIGHT_OUT so synthetic smoke checks cannot feed preflight runs
      const preflightOutRefused = spawnSync(
        process.execPath,
        [
          join(REPO_ROOT, 'scripts/prepare-self-upgrade.mjs'),
          '--repo',
          repoRoot,
          '--offline-check',
        ],
        {
          env: {
            ...process.env,
            LOOPWRIGHT_PREFLIGHT_OUT: join(dir, 'preflight-out.json'),
          },
          encoding: 'utf8',
        },
      );
      assert.notEqual(preflightOutRefused.status, 0);
      assert.equal(preflightOutRefused.stderr.includes('Refusing --offline-check with LOOPWRIGHT_PREFLIGHT_OUT'), true);
    });
  });

  it('warms transitive packed-runtime tarballs in defaultLockfileBuilder and runs verify.sh offline without SELF_UPGRADE_TEST_NODE_MODULES', async () => {
    const preflight = await loadPreflightModule();
    const npmBin = process.platform === 'win32' ? 'npm.cmd' : 'npm';

    await withTempDir(async dir => {
      const { repoRoot } = await createMiniSelfUpgradeRepo(dir);

      // Part A: Start a local loopback mock npm registry where root overrides pin minimatch@11.0.1
      // while @earendil-works/pi-coding-agent@1.6.0 transitively depends on minimatch@^11.0.0 (latest 11.0.3).
      const tarballs = new Map<string, Buffer>();
      const packuments = new Map<string, Record<string, unknown>>();

      const registerPkgVersions = (
        pkgName: string,
        versions: readonly {
          readonly version: string;
          readonly dependencies?: Readonly<Record<string, string>> | undefined;
          readonly extraFiles?: Readonly<Record<string, string>> | undefined;
        }[],
      ): Map<string, { readonly tgz: Buffer; readonly integrity: string }> => {
        const out = new Map<string, { readonly tgz: Buffer; readonly integrity: string }>();
        const versionsObj: Record<string, unknown> = {};
        for (const item of versions) {
          const shortName = pkgName.includes('/') ? pkgName.split('/')[1]! : pkgName;
          const tarballUrlPath = `/${pkgName}/-/${shortName}-${item.version}.tgz`;
          const manifestJson: Record<string, unknown> = {
            name: pkgName,
            version: item.version,
            ...(item.dependencies !== undefined ? { dependencies: item.dependencies } : {}),
          };
          const built = buildUstarTgzBuffer(manifestJson, {
            'package/index.js': 'export default {};\n',
            ...(item.extraFiles ?? {}),
          });
          tarballs.set(tarballUrlPath, built.tgz);
          out.set(item.version, { tgz: built.tgz, integrity: built.integrity });
          versionsObj[item.version] = {
            ...manifestJson,
            dist: {
              tarball: `__REGISTRY_ORIGIN__${tarballUrlPath}`,
              integrity: built.integrity,
              shasum: built.shasum,
            },
          };
        }
        const latestVer = versions[versions.length - 1]!.version;
        packuments.set(pkgName, {
          name: pkgName,
          'dist-tags': { latest: latestVer },
          versions: versionsObj,
        });
        return out;
      };

      const tsBuilt = registerPkgVersions('typescript', [{
        version: '6.0.3',
        extraFiles: { 'package/bin/tsc': '#!/usr/bin/env node\nprocess.exit(0);\n' },
      }]);
      const eslintBuilt = registerPkgVersions('eslint', [{
        version: '10.14.0',
        extraFiles: { 'package/bin/eslint.js': '#!/usr/bin/env node\nprocess.exit(0);\n' },
      }]);
      const eslintJsBuilt = registerPkgVersions('@eslint/js', [{ version: '10.0.1' }]);
      const typesNodeBuilt = registerPkgVersions('@types/node', [{ version: '26.6.6' }]);
      const tsEslintBuilt = registerPkgVersions('typescript-eslint', [{ version: '8.72.1' }]);
      const minimatchBuilt = registerPkgVersions('minimatch', [
        { version: '11.0.1' },
        { version: '11.0.3' },
      ]);
      const yamlBuilt = registerPkgVersions('yaml', [
        { version: '2.9.0' },
        { version: '2.10.0' },
      ]);
      const piBuiltByPkg = new Map<string, Map<string, { readonly tgz: Buffer; readonly integrity: string }>>();
      for (const pkgName of PI_PACKAGE_NAMES) {
        const depsForPi = pkgName === '@earendil-works/pi-coding-agent'
          ? { minimatch: '^11.0.3' }
          : undefined;
        piBuiltByPkg.set(
          pkgName,
          registerPkgVersions(pkgName, [
            { version: '1.5.0', dependencies: depsForPi },
            { version: '1.6.0', dependencies: depsForPi },
          ]),
        );
      }

      // Commit root overrides: { minimatch: "11.0.1" } into the fixture repo so workspace install selects 11.0.1
      const rootPkgPath = join(repoRoot, 'package.json');
      const rootPkg = JSON.parse(await readFile(rootPkgPath, 'utf8')) as Record<string, unknown>;
      rootPkg['overrides'] = { minimatch: '11.0.1' };
      await writeFile(rootPkgPath, `${JSON.stringify(rootPkg, null, 2)}\n`, { mode: 0o600 });
      spawnSync('git', ['add', 'package.json'], { cwd: repoRoot, stdio: 'ignore' });
      spawnSync('git', ['commit', '-m', 'chore: pin minimatch override in fixture'], { cwd: repoRoot, stdio: 'ignore' });

      let registryOrigin = '';
      const registryServer = http.createServer((req, res) => {
        const rawUrl = req.url ?? '/';
        const decodedPath = decodeURIComponent(rawUrl.split('?')[0]!);
        const tgzBuf = tarballs.get(decodedPath);
        if (tgzBuf !== undefined) {
          res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': String(tgzBuf.byteLength) });
          res.end(tgzBuf);
          return;
        }
        const pkgLookup = decodedPath.replace(/^\//, '');
        const packument = packuments.get(pkgLookup);
        if (packument !== undefined) {
          const body = JSON.stringify(packument).replaceAll('__REGISTRY_ORIGIN__', registryOrigin);
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(body);
          return;
        }
        res.writeHead(404, { 'content-type': 'application/json' });
        res.end('{"error":"not_found"}');
      });

      await new Promise<void>((resolveListen, rejectListen) => {
        registryServer.once('error', rejectListen);
        registryServer.listen(0, '127.0.0.1', () => resolveListen());
      });

      const warmCacheDir = join(dir, 'warm-npm-cache');
      await mkdir(warmCacheDir, { recursive: true, mode: 0o700 });
      try {
        const addr = registryServer.address() as net.AddressInfo;
        registryOrigin = `http://127.0.0.1:${String(addr.port)}`;

        // Align baseline lockfile URLs + integrities to the local mock registry before running defaultLockfileBuilder
        const localBaseLock = JSON.parse(await readFile(join(repoRoot, 'package-lock.json'), 'utf8')) as {
          packages: Record<string, Record<string, unknown>>;
        };
        localBaseLock.packages['node_modules/typescript'] = {
          version: '6.0.3',
          resolved: `${registryOrigin}/typescript/-/typescript-6.0.3.tgz`,
          integrity: tsBuilt.get('6.0.3')!.integrity,
          dev: true,
        };
        localBaseLock.packages['node_modules/eslint'] = {
          version: '10.14.0',
          resolved: `${registryOrigin}/eslint/-/eslint-10.14.0.tgz`,
          integrity: eslintBuilt.get('10.14.0')!.integrity,
          dev: true,
        };
        localBaseLock.packages['node_modules/@eslint/js'] = {
          version: '10.0.1',
          resolved: `${registryOrigin}/@eslint/js/-/js-10.0.1.tgz`,
          integrity: eslintJsBuilt.get('10.0.1')!.integrity,
          dev: true,
        };
        localBaseLock.packages['node_modules/@types/node'] = {
          version: '26.6.6',
          resolved: `${registryOrigin}/@types/node/-/node-26.6.6.tgz`,
          integrity: typesNodeBuilt.get('26.6.6')!.integrity,
          dev: true,
        };
        localBaseLock.packages['node_modules/typescript-eslint'] = {
          version: '8.72.1',
          resolved: `${registryOrigin}/typescript-eslint/-/typescript-eslint-8.72.1.tgz`,
          integrity: tsEslintBuilt.get('8.72.1')!.integrity,
          dev: true,
        };
        localBaseLock.packages['node_modules/yaml'] = {
          version: '2.9.0',
          resolved: `${registryOrigin}/yaml/-/yaml-2.9.0.tgz`,
          integrity: yamlBuilt.get('2.9.0')!.integrity,
        };
        for (const pkgName of PI_PACKAGE_NAMES) {
          const shortName = pkgName.split('/')[1]!;
          localBaseLock.packages[`node_modules/${pkgName}`] = {
            version: '1.5.0',
            resolved: `${registryOrigin}/${pkgName}/-${`/${shortName}-1.5.0.tgz`}`,
            integrity: piBuiltByPkg.get(pkgName)!.get('1.5.0')!.integrity,
          };
        }
        await writeFile(join(repoRoot, 'package-lock.json'), `${JSON.stringify(localBaseLock, null, 2)}\n`, { mode: 0o600 });
        spawnSync('git', ['add', 'package-lock.json'], { cwd: repoRoot, stdio: 'ignore' });
        spawnSync('git', ['commit', '-m', 'chore: bind baseline lockfile to local mock registry'], { cwd: repoRoot, stdio: 'ignore' });

        const targetVersions = preflight.buildTargetVersionsPayload('1.6.0', '2.10.0');
        const builtLock = await preflight.defaultLockfileBuilder({
          repoRoot,
          targetVersions,
          npmCacheDir: warmCacheDir,
          registryUrl: registryOrigin,
        });
        const parsedBuiltLock = JSON.parse(builtLock.toString('utf8')) as {
          packages: Record<string, { version?: string }>;
        };
        // Workspace overrides pin minimatch to 11.0.1 in the workspace lockfile
        assert.equal(parsedBuiltLock.packages['node_modules/minimatch']?.version, '11.0.1');
      } finally {
        await new Promise<void>(resolveClose => registryServer.close(() => resolveClose()));
      }

      // Now that the local registry server is CLOSED, verify offline global install of a packed
      // @gpustack/loopwright-style tarball (without overrides -> needs minimatch@11.0.1 AND Pi's minimatch@11.0.3!)
      const packedTarball = buildUstarTgzBuffer({
        name: '@gpustack/loopwright',
        version: '0.1.0-test',
        dependencies: {
          minimatch: '11.0.1',
          yaml: '2.10.0',
          ...Object.fromEntries(PI_PACKAGE_NAMES.map(pkg => [pkg, '1.6.0'])),
        },
      });
      const packedTarballPath = join(dir, 'gpustack-loopwright-0.1.0-test.tgz');
      await writeFile(packedTarballPath, packedTarball.tgz, { mode: 0o600 });
      const offlinePrefix = join(dir, 'offline-global-prefix');
      const offlinePackInstall = spawnSync(
        npmBin,
        [
          'install',
          '-g',
          '--prefix',
          offlinePrefix,
          packedTarballPath,
          '--offline',
          '--ignore-scripts',
          '--no-audit',
          '--no-fund',
          '--cache',
          warmCacheDir,
        ],
        {
          env: {
            PATH: `${dirname(process.execPath)}:/usr/local/bin:/usr/bin:/bin`,
            HOME: dir,
            TMPDIR: tmpdir(),
            npm_config_registry: registryOrigin,
          },
          encoding: 'utf8',
          timeout: 60_000,
        },
      );
      assert.equal(
        offlinePackInstall.status,
        0,
        `expected offline packed runtime install to succeed from warmed cache: ${offlinePackInstall.stderr}`,
      );
      const installedRoot = process.platform === 'win32'
        ? join(offlinePrefix, 'node_modules/@gpustack/loopwright')
        : join(offlinePrefix, 'lib/node_modules/@gpustack/loopwright');
      const topMinimatch = JSON.parse(
        await readFile(join(installedRoot, 'node_modules/minimatch/package.json'), 'utf8'),
      ) as { version: string };
      const nestedMinimatch = JSON.parse(
        await readFile(
          join(installedRoot, 'node_modules/@earendil-works/pi-coding-agent/node_modules/minimatch/package.json'),
          'utf8',
        ),
      ) as { version: string };
      assert.equal(topMinimatch.version, '11.0.1');
      assert.equal(nestedMinimatch.version, '11.0.3');

      // Part B: Exercise real verify.sh WITHOUT SELF_UPGRADE_TEST_NODE_MODULES (full offline npm ci + compile + runtime gates)
      const realOfflineStage = join(dir, 'stage-real-offline-verify');
      const tgzScratch = join(dir, 'tgz-scratch');
      await mkdir(tgzScratch, { recursive: true, mode: 0o700 });

      const targetVersions = preflight.buildTargetVersionsPayload('1.6.0', '2.10.0');
      const lockObj = JSON.parse(buildSyntheticLockfile({ piVersion: '1.6.0', yamlVersion: '2.10.0' })) as {
        packages: Record<string, Record<string, unknown>>;
      };
      lockObj.packages['node_modules/typescript'] = {
        version: '6.0.3',
        resolved: 'https://registry.npmjs.org/typescript/-/typescript-6.0.3.tgz',
        integrity: tsBuilt.get('6.0.3')!.integrity,
        dev: true,
        bin: { tsc: 'bin/tsc' },
      };
      lockObj.packages['node_modules/eslint'] = {
        version: '10.14.0',
        resolved: 'https://registry.npmjs.org/eslint/-/eslint-10.14.0.tgz',
        integrity: eslintBuilt.get('10.14.0')!.integrity,
        dev: true,
        bin: { eslint: 'bin/eslint.js' },
      };
      lockObj.packages['node_modules/@eslint/js'] = {
        version: '10.0.1',
        resolved: 'https://registry.npmjs.org/@eslint/js/-/js-10.0.1.tgz',
        integrity: eslintJsBuilt.get('10.0.1')!.integrity,
        dev: true,
      };
      lockObj.packages['node_modules/@types/node'] = {
        version: '26.6.6',
        resolved: 'https://registry.npmjs.org/@types/node/-/node-26.6.6.tgz',
        integrity: typesNodeBuilt.get('26.6.6')!.integrity,
        dev: true,
      };
      lockObj.packages['node_modules/typescript-eslint'] = {
        version: '8.72.1',
        resolved: 'https://registry.npmjs.org/typescript-eslint/-/typescript-eslint-8.72.1.tgz',
        integrity: tsEslintBuilt.get('8.72.1')!.integrity,
        dev: true,
      };
      lockObj.packages['node_modules/yaml'] = {
        version: '2.10.0',
        resolved: 'https://registry.npmjs.org/yaml/-/yaml-2.10.0.tgz',
        integrity: yamlBuilt.get('2.10.0')!.integrity,
      };
      lockObj.packages['node_modules/minimatch'] = {
        version: '11.0.1',
        resolved: 'https://registry.npmjs.org/minimatch/-/minimatch-11.0.1.tgz',
        integrity: minimatchBuilt.get('11.0.1')!.integrity,
      };
      for (const pkgName of PI_PACKAGE_NAMES) {
        const shortName = pkgName.split('/')[1]!;
        lockObj.packages[`node_modules/${pkgName}`] = {
          version: '1.6.0',
          resolved: `https://registry.npmjs.org/${pkgName}/-/${shortName}-1.6.0.tgz`,
          integrity: piBuiltByPkg.get(pkgName)!.get('1.6.0')!.integrity,
        };
      }

      // Commit matching baseline devDependency integrities into HEAD so immutable toolchain audit matches HEAD
      const headLockObj = JSON.parse(await readFile(join(repoRoot, 'package-lock.json'), 'utf8')) as {
        packages: Record<string, Record<string, unknown>>;
      };
      for (const devKey of [
        'node_modules/typescript',
        'node_modules/eslint',
        'node_modules/@eslint/js',
        'node_modules/@types/node',
        'node_modules/typescript-eslint',
      ]) {
        headLockObj.packages[devKey] = lockObj.packages[devKey]!;
      }
      await writeFile(join(repoRoot, 'package-lock.json'), `${JSON.stringify(headLockObj, null, 2)}\n`, { mode: 0o600 });
      spawnSync('git', ['add', 'package-lock.json'], { cwd: repoRoot, stdio: 'ignore' });
      spawnSync('git', ['commit', '-m', 'chore: align baseline toolchain integrities'], { cwd: repoRoot, stdio: 'ignore' });

      const offlineLockBytes = Buffer.from(`${JSON.stringify(lockObj, null, 2)}\n`, 'utf8');
      const allTgzBuffers: readonly Buffer[] = [
        tsBuilt.get('6.0.3')!.tgz,
        eslintBuilt.get('10.14.0')!.tgz,
        eslintJsBuilt.get('10.0.1')!.tgz,
        typesNodeBuilt.get('26.6.6')!.tgz,
        tsEslintBuilt.get('8.72.1')!.tgz,
        minimatchBuilt.get('11.0.1')!.tgz,
        yamlBuilt.get('2.10.0')!.tgz,
        ...PI_PACKAGE_NAMES.map(pkg => piBuiltByPkg.get(pkg)!.get('1.6.0')!.tgz),
      ];

      const stagedOffline = await preflight.stageCandidateBundle({
        repoRoot,
        stageDir: realOfflineStage,
        targetVersions,
        lockfileBuilder: async ({ npmCacheDir }) => {
          for (let idx = 0; idx < allTgzBuffers.length; idx += 1) {
            const tgzFile = join(tgzScratch, `pkg-${String(idx)}.tgz`);
            await writeFile(tgzFile, allTgzBuffers[idx]!, { mode: 0o600 });
            const cacheAdd = spawnSync(npmBin, ['cache', 'add', tgzFile, '--cache', npmCacheDir], {
              env: {
                PATH: `${dirname(process.execPath)}:/usr/local/bin:/usr/bin:/bin`,
                HOME: tgzScratch,
                TMPDIR: tmpdir(),
              },
              encoding: 'utf8',
            });
            assert.equal(cacheAdd.status, 0, `npm cache add failed: ${cacheAdd.stderr}`);
          }
          return offlineLockBytes;
        },
      });
      const tgzStat = await stat(stagedOffline.npmCacheArchivePath!);
      assert.equal(tgzStat.isFile() && tgzStat.nlink === 1 && tgzStat.size > 0, true, 'expected packed npm-cache.tgz');

      await writeFile(join(repoRoot, '.auto-sync/proposal.json'), `${JSON.stringify(targetVersions, null, 2)}\n`, { mode: 0o600 });
      await writeFile(join(repoRoot, 'package-lock.json'), offlineLockBytes, { mode: 0o600 });
      for (const [ws, depUpdates] of Object.entries(targetVersions.packages)) {
        const wsManifestPath = join(repoRoot, ws, 'package.json');
        const wsManifest = JSON.parse(await readFile(wsManifestPath, 'utf8')) as { dependencies: Record<string, string> };
        wsManifest.dependencies = { ...wsManifest.dependencies, ...depUpdates };
        await writeFile(wsManifestPath, `${JSON.stringify(wsManifest, null, 2)}\n`, { mode: 0o600 });
      }

      // 1) Dedicated GitHub-hosted Actions VM mode (`GITHUB_ACTIONS=true` + `RUNNER_ENVIRONMENT=github-hosted`) unpacks npm-cache.tgz from LOOPWRIGHT_STAGED_DIR without requiring bwrap
      const ghaDirectRes = runVerifyScript(repoRoot, {
        GITHUB_ACTIONS: 'true',
        RUNNER_ENVIRONMENT: 'github-hosted',
        SELF_UPGRADE_REPO_ROOT: repoRoot,
        LOOPWRIGHT_STAGED_DIR: realOfflineStage,
        PYTHON_BIN: existsSync('/usr/bin/python3') ? '/usr/bin/python3' : undefined,
      });
      assert.equal(
        ghaDirectRes.status,
        0,
        `expected GITHUB_ACTIONS=true RUNNER_ENVIRONMENT=github-hosted direct-dedicated offline verify.sh to succeed via LOOPWRIGHT_STAGED_DIR/npm-cache.tgz: ${ghaDirectRes.stderr}`,
      );

      // 1b) Dedicated GitHub-hosted Actions VM mode (`GITHUB_ACTIONS=true` + `RUNNER_ENVIRONMENT=github-hosted`) catches stealth same-UID chmod +
      // same-byte in-place overwrite + nanosecond-exact timestamp restore against a masked file inside build_dir,
      // triggered from an allowed `packages/` file so Phase 1's git HEAD protected-prefix gate passes first.
      const agentPiIndexPath = join(repoRoot, 'packages/agent-pi/src/index.ts');
      const cleanAgentPiIndex = await readFile(agentPiIndexPath, 'utf8');
      await writeFile(
        agentPiIndexPath,
        `import { execFileSync } from 'node:child_process';
import { chmodSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
export const PACKAGE_ID = '@loopwright/agent-pi';
const maskedDir = 'scripts';
const maskedFile = 'scripts/check-docs.mjs';
const dirStat = statSync(maskedDir);
const fileStat = statSync(maskedFile);
const origText = readFileSync(maskedFile, 'utf8');
const tamperedText = origText.replace("'utf8'", "'UTF8'");
if (Buffer.byteLength(tamperedText) !== fileStat.size || tamperedText === origText) {
  process.exit(87);
}
const tmpDir = process.env['TMPDIR'] || '/tmp';
const fileStamp = join(tmpDir, 'masked-file-stamp');
const dirStamp = join(tmpDir, 'masked-dir-stamp');
execFileSync('touch', ['-r', maskedFile, fileStamp]);
execFileSync('touch', ['-r', maskedDir, dirStamp]);
chmodSync(maskedDir, 0o755);
chmodSync(maskedFile, 0o644);
writeFileSync(maskedFile, tamperedText, 'utf8');
execFileSync('touch', ['-r', fileStamp, maskedFile]);
chmodSync(maskedFile, fileStat.mode & 0o777);
execFileSync('touch', ['-r', dirStamp, maskedDir]);
chmodSync(maskedDir, dirStat.mode & 0o777);
`,
        { mode: 0o600 },
      );
      try {
        const ghaStealthTamperRes = runVerifyScript(repoRoot, {
          GITHUB_ACTIONS: 'true',
          RUNNER_ENVIRONMENT: 'github-hosted',
          SELF_UPGRADE_REPO_ROOT: repoRoot,
          LOOPWRIGHT_STAGED_DIR: realOfflineStage,
          PYTHON_BIN: existsSync('/usr/bin/python3') ? '/usr/bin/python3' : undefined,
        });
        assert.notEqual(
          ghaStealthTamperRes.status,
          0,
          'GITHUB_ACTIONS=true RUNNER_ENVIRONMENT=github-hosted must reject same-size + timestamp-restored tamper of masked file',
        );
        assert.equal(
          ghaStealthTamperRes.stderr.includes('masked file modified during stage:'),
          true,
          `expected tamper diagnostic in stderr, got: ${ghaStealthTamperRes.stderr}`,
        );
      } finally {
        await writeFile(agentPiIndexPath, cleanAgentPiIndex, { mode: 0o600 });
      }

      // 2) Local workstation mode (`GITHUB_ACTIONS` unset) AND non-github-hosted Actions (`GITHUB_ACTIONS=true` with
      //    `RUNNER_ENVIRONMENT=self-hosted` or missing `RUNNER_ENVIRONMENT`) enforce OS kernel containment (`sandbox-exec` / `bwrap`)
      if (CAN_RUN_KERNEL_CONTAINMENT) {
        const realOfflineRes = runVerifyScript(repoRoot, {
          SELF_UPGRADE_REPO_ROOT: repoRoot,
          LOOPWRIGHT_STAGED_DIR: realOfflineStage,
          PYTHON_BIN: existsSync('/usr/bin/python3') ? '/usr/bin/python3' : undefined,
        });
        assert.equal(
          realOfflineRes.status,
          0,
          `expected full offline verify.sh (without SELF_UPGRADE_TEST_NODE_MODULES) to succeed: ${realOfflineRes.stderr}`,
        );

        await writeFile(
          agentPiIndexPath,
          `import { chmodSync } from 'node:fs';
export const PACKAGE_ID = '@loopwright/agent-pi';
let kernelDenied = false;
try {
  chmodSync('scripts/check-docs.mjs', 0o644);
} catch (err) {
  const code = err && typeof err === 'object' ? err.code : '';
  if (code === 'EPERM' || code === 'EACCES' || code === 'EROFS') {
    kernelDenied = true;
  }
}
if (!kernelDenied) {
  console.error('OS_CONTAINMENT_BYPASSED');
  process.exit(88);
}
`,
          { mode: 0o600 },
        );
        try {
          for (const nonHostedEnv of [
            { GITHUB_ACTIONS: 'true', RUNNER_ENVIRONMENT: 'self-hosted' },
            { GITHUB_ACTIONS: 'true' },
          ]) {
            const containedRes = runVerifyScript(repoRoot, {
              ...nonHostedEnv,
              SELF_UPGRADE_REPO_ROOT: repoRoot,
              LOOPWRIGHT_STAGED_DIR: realOfflineStage,
              PYTHON_BIN: existsSync('/usr/bin/python3') ? '/usr/bin/python3' : undefined,
            });
            assert.equal(
              containedRes.status,
              0,
              `expected ${JSON.stringify(nonHostedEnv)} to enforce OS kernel containment without bypass: ${containedRes.stderr}`,
            );
            assert.equal(containedRes.stderr.includes('OS_CONTAINMENT_BYPASSED'), false, containedRes.stderr);
          }
        } finally {
          await writeFile(agentPiIndexPath, cleanAgentPiIndex, { mode: 0o600 });
        }
      }

      // 3) Malicious npm-cache.tgz containing a symlink entry is rejected by verify.sh before unpacking
      const evilStageDir = join(dir, 'stage-evil-tgz');
      await mkdir(evilStageDir, { recursive: true, mode: 0o700 });
      for (const rel of ['target-versions.json', 'preflight-metadata.json', 'package-lock.candidate.json']) {
        await writeFile(join(evilStageDir, rel), await readFile(join(realOfflineStage, rel)), { mode: 0o444 });
      }
      const evilTarPy = `
import tarfile, sys
with tarfile.open(sys.argv[1], "w:gz") as tf:
    ti = tarfile.TarInfo(name="evil-link")
    ti.type = tarfile.SYMTYPE
    ti.linkname = "/etc/passwd"
    tf.addfile(ti)
`;
      const mkEvil = spawnSync(existsSync('/usr/bin/python3') ? '/usr/bin/python3' : 'python3', ['-c', evilTarPy, join(evilStageDir, 'npm-cache.tgz')], { encoding: 'utf8' });
      assert.equal(mkEvil.status, 0, mkEvil.stderr);
      const evilRes = runVerifyScript(repoRoot, {
        GITHUB_ACTIONS: 'true',
        RUNNER_ENVIRONMENT: 'github-hosted',
        SELF_UPGRADE_REPO_ROOT: repoRoot,
        LOOPWRIGHT_STAGED_DIR: evilStageDir,
      });
      assert.notEqual(evilRes.status, 0);
      assert.equal(evilRes.stderr.includes('forbidden non-regular entry'), true);
    });
  });

  it('enforces type-strict manifests, nested config & compile-child stage isolation, runtime loopback-only containment, and fork PR ref fetching', async () => {
    const preflight = await loadPreflightModule();
    const hostNodeModules = join(REPO_ROOT, 'node_modules');
    const execGit = (cwd: string, args: readonly string[]): string => {
      const res = spawnSync('git', ['-c', 'core.hooksPath=/dev/null', ...args], {
        cwd,
        encoding: 'utf8',
      });
      assert.equal(res.status, 0, `git ${args.join(' ')} failed in ${cwd}: ${res.stderr}`);
      return (res.stdout ?? '').trim();
    };

    // 1) Workflow contract: Taskpack 2.0 mode: auto + dual-key allow-privileged-execution + issue_comment fork PR fetch
    const workflowRaw = await readFile(join(REPO_ROOT, '.github/workflows/auto-sync.yml'), 'utf8');
    const workflowDoc = parseDocument(workflowRaw, { version: '1.2', schema: 'core', uniqueKeys: true });
    assert.equal(workflowDoc.errors.length, 0, 'auto-sync.yml must parse cleanly as YAML');
    assert.equal(
      workflowRaw.includes('+refs/pull/${PR_NUMBER}/head:refs/remotes/origin/pr/${PR_NUMBER}'),
      true,
    );
    assert.equal(
      workflowRaw.includes('!${{ runner.temp }}/loopwright-auto-sync/**/secrets.json'),
      true,
    );
    assert.equal(
      workflowRaw.includes('!${{ runner.temp }}/loopwright-auto-sync/**/*.sqlite*'),
      true,
    );
    assert.equal(
      workflowRaw.includes("startsWith(github.event.comment.body, '/auto-sync')"),
      true,
    );
    assert.equal(
      workflowRaw.includes('INPUT_TASKPACK-PATH: .auto-sync/taskpack.yaml'),
      true,
    );
    assert.equal(workflowRaw.includes('INPUT_MODE: auto'), true);
    assert.equal(workflowRaw.includes("INPUT_ALLOW-PRIVILEGED-EXECUTION: 'true'"), true);
    assert.equal(workflowRaw.includes('INPUT_ALLOW-WORKFLOW-WRITES'), false);
    assert.equal(workflowRaw.includes('bootstrap-loopwright'), false);
    assert.equal(workflowRaw.includes('92d90440b9e48cac42dd7ef058da1e8c48ec858c'), false);
    assert.equal(workflowRaw.includes('node "${GITHUB_WORKSPACE}/packages/github-app/dist/action.js"'), true);
    assert.equal(workflowRaw.includes('name: Run preflight'), false);
    assert.equal(workflowRaw.includes('name: Resolve mode'), false);
    assert.equal(workflowRaw.includes('name: Verify no-change'), false);
    assert.equal(workflowRaw.includes('pull-requests: read'), true);
    assert.equal(workflowRaw.includes("!endsWith(github.event.comment.user.login, '[bot]')"), true);
    assert.equal(workflowRaw.includes('python3-pytest'), true);

    // 1b) Aligned workspace resource / npm-cache archive ceilings (>= 128 MiB single / 256 MiB total)
    assert.equal(PREFLIGHT_MAX_WORKSPACE_RESOURCE_BYTES, 128 * 1024 * 1024);
    assert.equal(PREFLIGHT_MAX_WORKSPACE_RESOURCES_TOTAL_BYTES, 256 * 1024 * 1024);
    assert.equal(preflight.MAX_NPM_CACHE_ARCHIVE_BYTES, 128 * 1024 * 1024);
    assert.equal(preflight.MAX_WORKSPACE_RESOURCES_TOTAL_BYTES, 256 * 1024 * 1024);
    assert.equal(preflight.MAX_PROMPT_RESOURCES_TOTAL_BYTES, 256 * 1024);

    // 2) Fork-PR issue_comment intake: unfetched fork PR head fails closed; fetching +refs/pull/77/head without checkout succeeds
    await withTempDir(async rawDir => {
      const dir = await realpath(rawDir);
      const originBare = join(dir, 'origin.git');
      await mkdir(originBare, { recursive: true, mode: 0o700 });
      execGit(originBare, ['init', '--bare', '--initial-branch=main']);

      const { repoRoot: seedRepo, headSha: mainSha } = await createMiniSelfUpgradeRepo(join(dir, 'seed'));
      execGit(seedRepo, ['remote', 'add', 'origin', originBare]);
      execGit(seedRepo, ['push', 'origin', 'HEAD:refs/heads/main']);

      // Simulate a fork commit pushed ONLY to refs/pull/77/head (absent from refs/heads/* and refs/tags/*)
      const forkWork = join(dir, 'fork-work');
      execGit(dir, ['clone', '--quiet', '--no-hardlinks', originBare, forkWork]);
      execGit(forkWork, ['config', 'user.name', 'Fork Contributor']);
      execGit(forkWork, ['config', 'user.email', 'fork@example.test']);
      await writeFile(join(forkWork, 'docs/development.md'), '# Fork PR candidate note\n', { mode: 0o600 });
      execGit(forkWork, ['add', 'docs/development.md']);
      execGit(forkWork, ['commit', '-m', 'docs: fork candidate update']);
      const forkHeadSha = execGit(forkWork, ['rev-parse', 'HEAD']);
      assert.notEqual(forkHeadSha, mainSha);
      execGit(forkWork, ['push', 'origin', `${forkHeadSha}:refs/pull/77/head`]);

      // Runner checks out refs/heads/main the exact way actions/checkout@v4 does (+refs/heads/* and +refs/tags/* only, no refs/pull/*)
      const runnerCheckout = join(dir, 'runner-main');
      await mkdir(runnerCheckout, { recursive: true, mode: 0o700 });
      execGit(runnerCheckout, ['init', '--initial-branch=main']);
      execGit(runnerCheckout, ['remote', 'add', 'origin', `file://${originBare}`]);
      execGit(runnerCheckout, [
        'fetch',
        '--no-tags',
        '--no-recurse-submodules',
        'origin',
        '+refs/heads/*:refs/remotes/origin/*',
        '+refs/tags/*:refs/tags/*',
      ]);
      execGit(runnerCheckout, ['checkout', '--quiet', '-B', 'main', 'refs/remotes/origin/main']);
      assert.equal(execGit(runnerCheckout, ['rev-parse', 'HEAD']), mainSha);

      const mockPrFetch: typeof globalThis.fetch = async (input: RequestInfo | URL) => {
        const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
        if (url.endsWith('/repos/gpustack/loopwright/pulls/77')) {
          return new Response(
            JSON.stringify({
              number: 77,
              state: 'open',
              base: { ref: 'main', sha: mainSha },
              head: { ref: 'auto-sync/main', sha: forkHeadSha },
            }),
            { status: 200, headers: { 'content-type': 'application/json' } },
          );
        }
        return new Response('not found', { status: 404 });
      };

      const commentPayload = {
        action: 'created',
        issue: { number: 77, pull_request: { url: 'https://api.github.com/repos/gpustack/loopwright/pulls/77' } },
        comment: { body: '/auto-sync retry', author_association: 'COLLABORATOR' },
        repository: { id: 4242, full_name: 'gpustack/loopwright' },
      };

      const resolved = await resolveRepositoryAndRevisions({
        repositoryRoot: runnerCheckout,
        repositoryFullName: 'gpustack/loopwright',
        baseRevision: mainSha,
        eventName: 'issue_comment',
        eventPayload: commentPayload,
        apiBaseUrl: 'https://api.github.test',
        fetchImpl: mockPrFetch,
      });
      assert.equal(resolved.baseRevision, mainSha);
      assert.equal(resolved.sourceRevision, forkHeadSha);

      const forkRunRoot = join(dir, 'fork-runs');
      const forkCfgDir = join(dir, 'fork-compiled');
      await mkdir(forkRunRoot, { recursive: true, mode: 0o700 });
      await mkdir(forkCfgDir, { recursive: true, mode: 0o700 });

      const hostPolicy = { allowPrivileged: true, allowWorkflowWrites: false } as const;
      const manifest = await loadDeclarativeTaskpack({
        manifestPath: '.auto-sync/taskpack.yaml',
        repositoryRoot: runnerCheckout,
        hostPolicy,
      });
      const compiledFork = await compileDeclarativeTaskpack(manifest, {
        mode: 'candidate',
        executionMode: 'delegated',
        hostPolicy,
        repository: 'gpustack/loopwright',
        baseRevision: resolved.baseRevision,
        sourceRevision: resolved.sourceRevision,
        repositoryRoot: runnerCheckout,
        taskpackPath: '.auto-sync/taskpack.yaml',
        budgets: DEFAULT_HOST_BUDGETS,
        credentialEnvMap: {
          localCommandGate: DEFAULT_LOCAL_COMMAND_GATE_ENV,
        },
        gateEndpoints: [
          {
            id: LOCAL_COMMAND_GATE_ENDPOINT_ID,
            url: CANONICAL_TASKPACK_STEP_GATE_URL,
            signingCredentialRef: 'taskpack-local-command-signing',
            authCredentialRef: null,
            timeoutMs: 915_000,
            maxPollMs: 930_000,
            pollInitialMs: 100,
            pollMaxMs: 500,
            jitter: 0,
          },
        ],
      });
      const configDir = join(forkCfgDir, 'config');
      const registryDir = join(forkCfgDir, 'registry');
      await mkdir(configDir, { recursive: true, mode: 0o700 });
      await mkdir(registryDir, { recursive: true, mode: 0o700 });
      const configPath = join(configDir, 'controller.yaml');
      const registryPath = join(registryDir, 'registry.yaml');
      await writeFile(configPath, serializePrettyYaml(compiledFork.config), { mode: 0o600 });
      await writeFile(registryPath, compiledFork.registryBytes, { mode: 0o600 });
      for (const instr of compiledFork.instructionResources ?? []) {
        const instrFull = join(registryDir, instr.path);
        await mkdir(dirname(instrFull), { recursive: true, mode: 0o700 });
        await writeFile(instrFull, instr.bytes, { mode: 0o600 });
      }

      const gateEnv = (key: string): string | undefined =>
        key === DEFAULT_LOCAL_COMMAND_GATE_ENV ? 'a'.repeat(64) : undefined;
      const prevGateSecret = process.env[DEFAULT_LOCAL_COMMAND_GATE_ENV];
      process.env[DEFAULT_LOCAL_COMMAND_GATE_ENV] = 'a'.repeat(64);
      let loadedForkCfg: Awaited<ReturnType<typeof loadTrustedConfiguration>>;
      try {
        loadedForkCfg = await loadTrustedConfiguration({
          configPath,
          registryPath,
          registrySha256: compiledFork.registrySha256,
          untrustedRoots: [runnerCheckout],
        });
      } finally {
        if (prevGateSecret === undefined) {
          delete process.env[DEFAULT_LOCAL_COMMAND_GATE_ENV];
        } else {
          process.env[DEFAULT_LOCAL_COMMAND_GATE_ENV] = prevGateSecret;
        }
      }
      assert.equal(loadedForkCfg.ok, true, JSON.stringify(loadedForkCfg));
      if (!loadedForkCfg.ok) return;

      // Before fetching +refs/pull/77/head, controller source capture (source.ts:97) fails with TARGET_MISMATCH
      const beforeFetchStep = await stepNext({
        configuration: loadedForkCfg.value,
        repository: runnerCheckout,
        runRoot: forkRunRoot,
        runId: 'fork-before-fetch',
        mode: 'candidate',
        environment: gateEnv,
      });
      assert.equal(beforeFetchStep.ok, false);
      if (!beforeFetchStep.ok) {
        assert.equal(beforeFetchStep.error.code, 'TARGET_MISMATCH');
      }

      // Run workflow's exact fetch-without-checkout step
      execGit(runnerCheckout, [
        'fetch',
        '--no-tags',
        '--no-recurse-submodules',
        'origin',
        '+refs/pull/77/head:refs/remotes/origin/pr/77',
      ]);
      assert.equal(execGit(runnerCheckout, ['rev-parse', '--verify', 'HEAD^{commit}']), mainSha);
      assert.equal(execGit(runnerCheckout, ['status', '--porcelain']), '');
      assert.equal(
        (await readFile(join(runnerCheckout, 'docs/development.md'), 'utf8')).includes('Fork PR candidate note'),
        false,
      );

      // After fetching +refs/pull/77/head into .git/objects, controller source capture succeeds while HEAD stays on main
      const afterFetchStep = await stepNext({
        configuration: loadedForkCfg.value,
        repository: runnerCheckout,
        runRoot: forkRunRoot,
        runId: 'fork-after-fetch',
        mode: 'candidate',
        environment: gateEnv,
      });
      assert.equal(afterFetchStep.ok, true, JSON.stringify(afterFetchStep));
      if (afterFetchStep.ok && afterFetchStep.value.kind === 'step') {
        const capturedDoc = await readFile(join(afterFetchStep.value.candidateDir, 'docs/development.md'), 'utf8');
        assert.equal(capturedDoc.includes('Fork PR candidate note'), true);
      }
    });

    // 3) Phase 1 audit: type-sensitive JSON checks ("private": true -> 1, "schema_version": true) & nested ESLint/tsconfig rejection
    await withTempDir(async dir => {
      const { repoRoot } = await createMiniSelfUpgradeRepo(dir, { emitBuildCanary: true });
      const stageDir = join(dir, 'stage-strict');
      await stageAndApplyCandidateUpgrade({
        preflight,
        repoRoot,
        candidateDir: repoRoot,
        stageDir,
      });

      const cliPkgPath = join(repoRoot, 'packages/cli/package.json');
      const goodCliRaw = await readFile(cliPkgPath, 'utf8');
      const cliMutatedPrivate = JSON.parse(goodCliRaw) as Record<string, unknown>;
      cliMutatedPrivate['private'] = 1;
      await writeFile(cliPkgPath, `${JSON.stringify(cliMutatedPrivate, null, 2)}\n`, { mode: 0o600 });

      const checkOutDir = join(dir, 'check-out');
      await mkdir(checkOutDir, { recursive: true, mode: 0o700 });
      const failCheckOutPath = join(checkOutDir, 'fail-out.json');
      const privateIntRes = runVerifyScript(repoRoot, {
        SELF_UPGRADE_ALLOW_TEST_FIXTURE: '1',
        SELF_UPGRADE_TEST_NODE_MODULES: hostNodeModules,
        SELF_UPGRADE_REPO_ROOT: repoRoot,
        LOOPWRIGHT_STAGED_DIR: stageDir,
        LOOPWRIGHT_CHECK_OUT: failCheckOutPath,
      });
      assert.notEqual(privateIntRes.status, 0);
      assert.equal(privateIntRes.stderr.includes("field 'private' must not be modified"), true);
      assert.equal(privateIntRes.stderr.includes('CANDIDATE_BUILD_EXECUTED_CANARY'), false);
      const failCheckOut = JSON.parse(await readFile(failCheckOutPath, 'utf8')) as {
        detail: string;
        findings: readonly { title: string; severity: string; path?: string; evidence: string }[];
      };
      assert.equal(failCheckOut.findings.length, 1);
      assert.equal(failCheckOut.findings[0]?.severity, 'high');
      assert.equal(failCheckOut.findings[0]?.path, 'packages/cli/package.json');
      assert.equal(failCheckOut.findings[0]?.evidence.includes("field 'private' must not be modified"), true);
      await writeFile(cliPkgPath, goodCliRaw, { mode: 0o600 });

      // Also verify packages/taskpack/package.json type-strict field guard in Phase 1
      const taskpackPkgPath = join(repoRoot, 'packages/taskpack/package.json');
      const goodTaskpackRaw = await readFile(taskpackPkgPath, 'utf8');
      const taskpackMutated = JSON.parse(goodTaskpackRaw) as Record<string, unknown>;
      taskpackMutated['private'] = 1;
      await writeFile(taskpackPkgPath, `${JSON.stringify(taskpackMutated, null, 2)}\n`, { mode: 0o600 });
      const taskpackIntRes = runVerifyScript(repoRoot, {
        SELF_UPGRADE_ALLOW_TEST_FIXTURE: '1',
        SELF_UPGRADE_TEST_NODE_MODULES: hostNodeModules,
        SELF_UPGRADE_REPO_ROOT: repoRoot,
        LOOPWRIGHT_STAGED_DIR: stageDir,
      });
      assert.notEqual(taskpackIntRes.status, 0);
      assert.equal(taskpackIntRes.stderr.includes("field 'private' must not be modified"), true);
      assert.equal(taskpackIntRes.stderr.includes('CANDIDATE_BUILD_EXECUTED_CANARY'), false);
      await writeFile(taskpackPkgPath, goodTaskpackRaw, { mode: 0o600 });

      // Unmanaged manifest "private": true -> 1 rejected
      const corePkgPath = join(repoRoot, 'packages/core/package.json');
      const goodCoreRaw = await readFile(corePkgPath, 'utf8');
      const coreMutated = JSON.parse(goodCoreRaw) as Record<string, unknown>;
      coreMutated['private'] = 1;
      await writeFile(corePkgPath, `${JSON.stringify(coreMutated, null, 2)}\n`, { mode: 0o600 });
      const unmanagedIntRes = runVerifyScript(repoRoot, {
        SELF_UPGRADE_ALLOW_TEST_FIXTURE: '1',
        SELF_UPGRADE_TEST_NODE_MODULES: hostNodeModules,
        SELF_UPGRADE_REPO_ROOT: repoRoot,
        LOOPWRIGHT_STAGED_DIR: stageDir,
      });
      assert.notEqual(unmanagedIntRes.status, 0);
      assert.equal(
        unmanagedIntRes.stderr.includes('protected file') || unmanagedIntRes.stderr.includes('unmanaged manifest'),
        true,
      );
      await writeFile(corePkgPath, goodCoreRaw, { mode: 0o600 });

      // Proposal "schema_version": true rejected
      const proposalPath = join(repoRoot, '.auto-sync/proposal.json');
      const goodProposalRaw = await readFile(proposalPath, 'utf8');
      const boolSchemaProposal = JSON.parse(goodProposalRaw) as Record<string, unknown>;
      boolSchemaProposal['schema_version'] = true;
      await writeFile(proposalPath, `${JSON.stringify(boolSchemaProposal, null, 2)}\n`, { mode: 0o600 });
      const boolSchemaRes = runVerifyScript(repoRoot, {
        SELF_UPGRADE_ALLOW_TEST_FIXTURE: '1',
        SELF_UPGRADE_TEST_NODE_MODULES: hostNodeModules,
        SELF_UPGRADE_REPO_ROOT: repoRoot,
        LOOPWRIGHT_STAGED_DIR: stageDir,
      });
      assert.notEqual(boolSchemaRes.status, 0);
      assert.equal(boolSchemaRes.stderr.includes('schema_version must be 1'), true);
      await writeFile(proposalPath, goodProposalRaw, { mode: 0o600 });

      // Nested packages/cli/eslint.config.mjs rejected before building
      const nestedEslintPath = join(repoRoot, 'packages/cli/eslint.config.mjs');
      await writeFile(nestedEslintPath, 'export default [];\n', { mode: 0o600 });
      const nestedEslintRes = runVerifyScript(repoRoot, {
        SELF_UPGRADE_ALLOW_TEST_FIXTURE: '1',
        SELF_UPGRADE_TEST_NODE_MODULES: hostNodeModules,
        SELF_UPGRADE_REPO_ROOT: repoRoot,
        LOOPWRIGHT_STAGED_DIR: stageDir,
      });
      assert.notEqual(nestedEslintRes.status, 0);
      assert.equal(nestedEslintRes.stderr.includes('unauthorized ESLint configuration'), true);
      assert.equal(nestedEslintRes.stderr.includes('CANDIDATE_BUILD_EXECUTED_CANARY'), false);
      await unlink(nestedEslintPath);

      // Added nested packages/cli/tsconfig.extra.json rejected before building
      const extraTsconfigPath = join(repoRoot, 'packages/cli/tsconfig.extra.json');
      await writeFile(extraTsconfigPath, '{"extends":"../../tsconfig.base.json"}\n', { mode: 0o600 });
      const extraTsconfigRes = runVerifyScript(repoRoot, {
        SELF_UPGRADE_ALLOW_TEST_FIXTURE: '1',
        SELF_UPGRADE_TEST_NODE_MODULES: hostNodeModules,
        SELF_UPGRADE_REPO_ROOT: repoRoot,
        LOOPWRIGHT_STAGED_DIR: stageDir,
      });
      assert.notEqual(extraTsconfigRes.status, 0);
      assert.equal(extraTsconfigRes.stderr.includes('tsconfig*.json'), true);
      assert.equal(extraTsconfigRes.stderr.includes('CANDIDATE_BUILD_EXECUTED_CANARY'), false);
      await unlink(extraTsconfigPath);

      // Refuse fallback to SELF_UPGRADE_STAGE_DIR / /tmp when LOOPWRIGHT_CHECK_ID is set and LOOPWRIGHT_STAGED_DIR is unset
      const shellFailCheckOutPath = join(checkOutDir, 'shell-fail-out.json');
      const missingStagedDirRes = runVerifyScript(repoRoot, {
        SELF_UPGRADE_ALLOW_TEST_FIXTURE: '1',
        SELF_UPGRADE_TEST_NODE_MODULES: hostNodeModules,
        SELF_UPGRADE_REPO_ROOT: repoRoot,
        SELF_UPGRADE_STAGE_DIR: stageDir,
        LOOPWRIGHT_CHECK_OUT: shellFailCheckOutPath,
      });
      assert.notEqual(missingStagedDirRes.status, 0);
      assert.equal(missingStagedDirRes.stderr.includes('LOOPWRIGHT_STAGED_DIR must be set under command.v1'), true);
      assert.equal(missingStagedDirRes.stderr.includes('CANDIDATE_BUILD_EXECUTED_CANARY'), false);
      const shellFailOut = JSON.parse(await readFile(shellFailCheckOutPath, 'utf8')) as {
        detail: string;
        findings: readonly { title: string; severity: string; evidence: string }[];
      };
      assert.equal(shellFailOut.findings[0]?.title, 'Self-upgrade verifier precondition failed');
      assert.equal(shellFailOut.findings[0]?.severity, 'high');

      // Symlinked LOOPWRIGHT_CHECK_OUT is refused cleanly without mutating target or printing a Python traceback
      const symlinkTargetPath = join(checkOutDir, 'protected-target.json');
      await writeFile(symlinkTargetPath, '{"untouched":true}\n', { mode: 0o600 });
      const symlinkCheckOutPath = join(checkOutDir, 'symlink-out.json');
      spawnSync('ln', ['-s', symlinkTargetPath, symlinkCheckOutPath]);
      const symlinkOutRes = runVerifyScript(repoRoot, {
        SELF_UPGRADE_ALLOW_TEST_FIXTURE: '1',
        SELF_UPGRADE_TEST_NODE_MODULES: hostNodeModules,
        SELF_UPGRADE_REPO_ROOT: repoRoot,
        SELF_UPGRADE_STAGE_DIR: stageDir,
        LOOPWRIGHT_CHECK_OUT: symlinkCheckOutPath,
      });
      assert.notEqual(symlinkOutRes.status, 0);
      assert.equal(symlinkOutRes.stderr.includes('Traceback'), false);
      assert.equal(await readFile(symlinkTargetPath, 'utf8'), '{"untouched":true}\n');

      // Oversized failure diagnostic via stdin still prints stderr cleanly and exits 1 without E2BIG abort
      const oversizedStagePath = join(dir, 'missing-stage', 'x'.repeat(200).concat('/', 'y'.repeat(200)));
      const longFailCheckOutPath = join(checkOutDir, 'long-fail-out.json');
      const longFailRes = runVerifyScript(repoRoot, {
        SELF_UPGRADE_ALLOW_TEST_FIXTURE: '1',
        SELF_UPGRADE_TEST_NODE_MODULES: hostNodeModules,
        SELF_UPGRADE_REPO_ROOT: repoRoot,
        LOOPWRIGHT_STAGED_DIR: oversizedStagePath,
        LOOPWRIGHT_CHECK_OUT: longFailCheckOutPath,
      });
      assert.equal(longFailRes.status, 1);
      assert.equal(longFailRes.stderr.includes('trusted stage directory'), true);
      const longFailOut = JSON.parse(await readFile(longFailCheckOutPath, 'utf8')) as {
        findings: readonly { title: string }[];
      };
      assert.equal(longFailOut.findings[0]?.title, 'Self-upgrade verifier precondition failed');

      // no_change staged bundle verifies baseline parity & exits 0 cleanly without running candidate build,
      // and rejects any candidate edit under disposition=no_change
      const { repoRoot: ncRepo } = await createMiniSelfUpgradeRepo(join(dir, 'nc-check'), { emitBuildCanary: true });
      const ncStageDir = join(dir, 'stage-no-change-verify');
      await preflight.stageNoChangeBundle({
        repoRoot: ncRepo,
        stageDir: ncStageDir,
        targetVersions: preflight.buildTargetVersionsPayload('1.5.0', '2.9.0'),
      });
      const ncCheckOutPath = join(checkOutDir, 'nc-out.json');
      const ncPassRes = runVerifyScript(ncRepo, {
        SELF_UPGRADE_REPO_ROOT: ncRepo,
        LOOPWRIGHT_STAGED_DIR: ncStageDir,
        LOOPWRIGHT_CHECK_OUT: ncCheckOutPath,
      });
      assert.equal(ncPassRes.status, 0, `expected no_change verify.sh to exit 0: ${ncPassRes.stderr}`);
      assert.equal(ncPassRes.stderr.includes('CANDIDATE_BUILD_EXECUTED_CANARY'), false);
      const ncCheckOut = JSON.parse(await readFile(ncCheckOutPath, 'utf8')) as {
        detail: string;
        metrics: Record<string, unknown>;
      };
      assert.deepEqual(ncCheckOut.metrics, { disposition: 'no_change', phase3_executed: false });

      await writeFile(join(ncRepo, 'docs/development.md'), '# Modified under no_change\n', { mode: 0o600 });
      const ncEditedRes = runVerifyScript(ncRepo, {
        SELF_UPGRADE_REPO_ROOT: ncRepo,
        LOOPWRIGHT_STAGED_DIR: ncStageDir,
      });
      assert.notEqual(ncEditedRes.status, 0);
      assert.equal(ncEditedRes.stderr.includes('differs from baseline'), true);
    });

    if (!CAN_RUN_KERNEL_CONTAINMENT) {
      return;
    }

    // 4) Compile-stage detached survivor (setsid + pre-opened O_RDWR FD) cannot tamper with RUNTIME_WORK/.test-build
    await withTempDir(async dir => {
      const detachedSurvivorBuildScript = `import { spawn } from 'node:child_process';
import { mkdirSync, openSync, writeFileSync, writeSync } from 'node:fs';
import { dirname, join } from 'node:path';

mkdirSync('packages/cli/dist', { recursive: true });
writeFileSync(
  'packages/cli/dist/main.js',
  'if (process.argv[2] !== "closure" || process.argv[3] !== "--verify-failures") process.exit(1);\\n',
);
const compiledTest = '.test-build/packages/core/test/smoke.test.js';
mkdirSync(dirname(compiledTest), { recursive: true });
writeFileSync(compiledTest, 'export const ok = true;\\n');

// Spawn a setsid-detached background child that survives past compile-and-lint, keeps an open O_RDWR FD
// to BUILD_WORK's compiled test, waits until RUNTIME_WORK (../run) materializes, and attempts to tamper!
const childCode = \`
import fs from 'node:fs';
import path from 'node:path';
const compiledRel = \${JSON.stringify(compiledTest)};
const runtimeTarget = path.join(path.dirname(process.cwd()), 'run', compiledRel);
const fd = fs.openSync(compiledRel, 'r+');
const deadline = Date.now() + 15000;
const timer = setInterval(() => {
  if (fs.existsSync(runtimeTarget)) {
    try { fs.writeSync(fd, 'process.exit(99);\\\\n', 0, 'utf8'); } catch {}
    try { fs.closeSync(fd); } catch {}
    try { fs.writeFileSync(runtimeTarget, 'process.exit(99);\\\\n'); } catch {}
    clearInterval(timer);
    process.exit(0);
  }
  if (Date.now() > deadline) {
    try { fs.closeSync(fd); } catch {}
    clearInterval(timer);
    process.exit(0);
  }
}, 20);
\`;
const child = spawn(process.execPath, ['--input-type=module', '-e', childCode], {
  detached: true,
  stdio: 'ignore',
});
child.unref();
`;

      const delayedRuntimeTestRunner = `import { setTimeout as delay } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

// Wait past the detached compile child's 200ms tamper timer, then execute the compiled test!
await delay(450);
const mod = await import(pathToFileURL(resolve('.test-build/packages/core/test/smoke.test.js')).href);
if (mod.ok !== true) {
  process.exit(98);
}
`;

      const { repoRoot: survivorRepo } = await createMiniSelfUpgradeRepo(dir, {
        buildScriptBody: detachedSurvivorBuildScript,
        testScriptBody: delayedRuntimeTestRunner,
      });
      const stageDir = join(dir, 'stage-survivor');
      await stageAndApplyCandidateUpgrade({
        preflight,
        repoRoot: survivorRepo,
        candidateDir: survivorRepo,
        stageDir,
      });

      const survivorRes = runVerifyScript(survivorRepo, {
        SELF_UPGRADE_ALLOW_TEST_FIXTURE: '1',
        SELF_UPGRADE_TEST_NODE_MODULES: hostNodeModules,
        SELF_UPGRADE_REPO_ROOT: survivorRepo,
        LOOPWRIGHT_STAGED_DIR: stageDir,
      });
      assert.equal(
        survivorRes.status,
        0,
        `expected runtime-gates to stay untampered by detached compile survivor: ${survivorRes.stderr}`,
      );
    });

    // 5) Runtime loopback-only containment: in-sandbox HTTP fixture works while external IP and host Unix socket are kernel-denied
    await withTempDir(async dir => {
      // Short path well below macOS 104-byte sockaddr_un.sun_path limit
      const hostUnixSockPath = `/tmp/lw-u-${randomUUID().slice(0, 8)}.sock`;
      let hostUnixConnections = 0;
      const hostUnixServer = net.createServer(sock => {
        hostUnixConnections += 1;
        sock.end('HOST_UNIX_OK');
      });
      await new Promise<void>((resolveListen, rejectListen) => {
        hostUnixServer.once('error', rejectListen);
        hostUnixServer.listen(hostUnixSockPath, () => resolveListen());
      });

      try {
        // Positive uncontained control: host process reaches hostUnixServer cleanly
        await new Promise<void>((resolveConn, rejectConn) => {
          const client = net.connect({ path: hostUnixSockPath });
          client.once('data', () => {
            client.destroy();
            resolveConn();
          });
          client.once('error', rejectConn);
        });
        assert.equal(hostUnixConnections, 1);
        hostUnixConnections = 0;

        const runtimeNetProbeBody = `import { spawnSync } from 'node:child_process';
import http from 'node:http';
import net from 'node:net';

// A) In-sandbox fixture HTTP server + fetch MUST succeed under loopback-only!
const inSandboxSrv = http.createServer((req, res) => {
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ ok: true, path: req.url }));
});
await new Promise(r => inSandboxSrv.listen(0, '127.0.0.1', r));
const localAddr = inSandboxSrv.address();
if (!localAddr || typeof localAddr === 'string') {
  console.error('IN_SANDBOX_SERVER_ADDRESS_INVALID');
  process.exit(91);
}
const fixtureRes = await fetch('http://127.0.0.1:' + String(localAddr.port) + '/ping');
const fixtureJson = await fixtureRes.json();
await new Promise(r => inSandboxSrv.close(r));
if (fixtureRes.status !== 200 || fixtureJson.ok !== true || fixtureJson.path !== '/ping') {
  console.error('IN_SANDBOX_FIXTURE_HTTP_FAILED');
  process.exit(92);
}

// B) Outbound non-loopback IP (RFC 5737 TEST-NET-1 192.0.2.1:80) MUST be kernel-denied!
const nodeExternalOutcome = await new Promise(resolveOut => {
  const sock = net.connect({ host: '192.0.2.1', port: 80 });
  const timer = setTimeout(() => { sock.destroy(); resolveOut('TIMEOUT'); }, 1500);
  sock.once('connect', () => { clearTimeout(timer); sock.destroy(); resolveOut('CONNECTED'); });
  sock.once('error', err => { clearTimeout(timer); resolveOut('ERR:' + String(err.code ?? err.message)); });
});
if (!/^ERR:(EPERM|EACCES|ENETUNREACH|EHOSTUNREACH)$/.test(String(nodeExternalOutcome))) {
  console.error('EXTERNAL_NODE_TCP_NOT_KERNEL_DENIED=' + String(nodeExternalOutcome));
  process.exit(93);
}

const pyProbe = spawnSync(
  '/usr/bin/python3',
  [
    '-c',
    'import errno, socket, sys\\ntry:\\n  s = socket.create_connection(("192.0.2.1", 80), timeout=1.5)\\n  s.close()\\n  sys.exit(0)\\nexcept OSError as exc:\\n  if exc.errno in (errno.EPERM, errno.EACCES, errno.ENETUNREACH, errno.EHOSTUNREACH):\\n    sys.exit(42)\\n  sys.stderr.write(f"PY_UNEXPECTED_ERR={exc.errno}\\\\n")\\n  sys.exit(2)\\n',
  ],
  { encoding: 'utf8' },
);
if (pyProbe.status !== 42) {
  console.error('EXTERNAL_PYTHON_TCP_NOT_KERNEL_DENIED status=' + String(pyProbe.status) + ' stderr=' + String(pyProbe.stderr));
  process.exit(94);
}

// C) Host Unix domain socket outside WORK_ROOT MUST be kernel-denied!
const unixOutcome = await new Promise(resolveOut => {
  const sock = net.connect({ path: ${JSON.stringify(hostUnixSockPath)} });
  const timer = setTimeout(() => { sock.destroy(); resolveOut('TIMEOUT'); }, 1500);
  sock.once('connect', () => { clearTimeout(timer); sock.destroy(); resolveOut('CONNECTED'); });
  sock.once('error', err => { clearTimeout(timer); resolveOut('ERR:' + String(err.code ?? err.message)); });
});
if (!/^ERR:(EPERM|EACCES|ENOENT)$/.test(String(unixOutcome))) {
  console.error('HOST_UNIX_SOCKET_NOT_DENIED=' + String(unixOutcome));
  process.exit(95);
}
`;

        const { repoRoot: runtimeNetRepo } = await createMiniSelfUpgradeRepo(dir, {
          testScriptBody: runtimeNetProbeBody,
        });
        const stageDir = join(dir, 'stage-runtime-net');
        await stageAndApplyCandidateUpgrade({
          preflight,
          repoRoot: runtimeNetRepo,
          candidateDir: runtimeNetRepo,
          stageDir,
        });

        const verifyOutcome = await new Promise<{ status: number | null; stdout: string; stderr: string }>(
          (resolveProc, rejectProc) => {
            const child = spawn(
              '/bin/bash',
              [join(REPO_ROOT, '.auto-sync/checks/verify.sh')],
              {
                cwd: runtimeNetRepo,
                env: {
                  PATH: '/usr/local/bin:/usr/bin:/bin',
                  NODE_BIN_DIR: dirname(process.execPath),
                  HOME: homedir(),
                  TMPDIR: tmpdir(),
                  LOOPWRIGHT_CANDIDATE_DIR: runtimeNetRepo,
                  LOOPWRIGHT_CHECK_ID: 'self-upgrade-verify',
                  SELF_UPGRADE_ALLOW_TEST_FIXTURE: '1',
                  SELF_UPGRADE_TEST_NODE_MODULES: hostNodeModules,
                  SELF_UPGRADE_REPO_ROOT: runtimeNetRepo,
                  LOOPWRIGHT_STAGED_DIR: stageDir,
                },
                stdio: ['ignore', 'pipe', 'pipe'],
              },
            );
            let out = '';
            let err = '';
            child.stdout.setEncoding('utf8');
            child.stderr.setEncoding('utf8');
            child.stdout.on('data', (chunk: string) => {
              out += chunk;
            });
            child.stderr.on('data', (chunk: string) => {
              err += chunk;
            });
            child.once('error', rejectProc);
            child.once('close', code => resolveProc({ status: code, stdout: out, stderr: err }));
          },
        );
        assert.equal(
          verifyOutcome.status,
          0,
          `expected runtime loopback-only HTTP fixture success + external IP & host Unix socket denial: ${verifyOutcome.stderr}`,
        );
        assert.equal(hostUnixConnections, 0, 'host Unix domain socket must receive zero connections from sandbox');
      } finally {
        await new Promise<void>(resolveClose => hostUnixServer.close(() => resolveClose()));
        await rm(hostUnixSockPath, { force: true });
      }
    });
  });
});
