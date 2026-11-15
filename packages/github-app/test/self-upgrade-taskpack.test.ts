import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { chmod, link, mkdir, mkdtemp, readFile, realpath, rm, stat, unlink, writeFile } from 'node:fs/promises';
import http from 'node:http';
import net from 'node:net';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import zlib from 'node:zlib';
import { loadTrustedConfiguration, stepNext } from '@loopwright/controller';
import { isWritablePath } from '@loopwright/core';
import {
  CANONICAL_TASKPACK_STEP_GATE_URL,
  checkManagedPrMatchesDiscoveredState,
  compileDeclarativeTaskpack,
  DEFAULT_HOST_BUDGETS,
  DEFAULT_LOCAL_COMMAND_GATE_ENV,
  loadDeclarativeTaskpack,
  LOCAL_COMMAND_GATE_ENDPOINT_ID,
  openStagedTaskpackStepGate,
  resolveRepositoryAndRevisions,
  serializePrettyYaml,
  stageTaskpackForStep,
  type TaskpackUpstreamRecord,
} from '../src/index.js';

const THIS_DIR = dirname(fileURLToPath(import.meta.url));
// Works identically from packages/github-app/test/*.ts and .test-build/packages/github-app/test/*.js
const REPO_ROOT = existsSync(resolve(THIS_DIR, '../../../.loopwright/taskpack.yaml'))
  ? resolve(THIS_DIR, '../../..')
  : resolve(THIS_DIR, '../../../..');

const CAN_RUN_KERNEL_CONTAINMENT = (() => {
  if (process.platform === 'darwin') {
    if (!existsSync('/usr/bin/sandbox-exec')) {
      return false;
    }
    const probe = spawnSync(
      '/usr/bin/sandbox-exec',
      [
        '-p',
        '(version 1)\n(allow default)\n(deny file-write* (literal "/System/nonexistent"))\n',
        '/usr/bin/true',
      ],
      { stdio: 'ignore' },
    );
    return probe.status === 0;
  }
  if (process.platform === 'linux') {
    for (const candidate of ['/usr/bin/bwrap', '/bin/bwrap', '/usr/local/bin/bwrap']) {
      if (existsSync(candidate)) {
        const probe = spawnSync(candidate, ['--unshare-all', '--ro-bind', '/', '/', '--', '/bin/true'], {
          stdio: 'ignore',
        });
        if (probe.status === 0) {
          return true;
        }
      }
    }
    return false;
  }
  return false;
})();

interface TargetVersionsPayload {
  readonly schema_version: number;
  readonly summary: string;
  readonly upstreams: Readonly<Record<string, { readonly package: string; readonly version: string }>>;
  readonly packages: Readonly<Record<string, Readonly<Record<string, string>>>>;
}

interface EligibilityResult {
  readonly recommendedMode: 'no-change' | 'candidate' | 'blocked';
  readonly actionMode: 'no-change' | 'candidate';
  readonly piOutcome: string;
  readonly yamlOutcome: string;
  readonly targetPiVersion: string;
  readonly targetYamlVersion: string;
  readonly targetVersions: TargetVersionsPayload;
  readonly upstreamRecords: readonly TaskpackUpstreamRecord[];
  readonly reasons: readonly string[];
}

interface BaselineParityResult {
  readonly baselineByUpstream: Readonly<Record<string, string>>;
  readonly piBaseline: string;
  readonly yamlBaseline: string;
  readonly lockfileBytes: number;
}

interface StageResult {
  readonly stageDir: string;
  readonly targetVersionsPath: string;
  readonly candidateLockPath: string;
  readonly npmCacheDir: string;
  readonly candidateLockBytes: number;
}

interface PrepareSelfUpgradeRunResult {
  readonly offlineCheck: boolean;
  readonly upstreamVerified: boolean;
  readonly recommendedMode: 'no-change' | 'candidate' | 'blocked';
  readonly actionMode: 'no-change' | 'candidate';
  readonly stageDir: string;
  readonly npmCacheDir: string;
  readonly baseline: BaselineParityResult;
  readonly evaluation: EligibilityResult | null;
  readonly staged: StageResult | null;
  readonly upstreamRecords: readonly TaskpackUpstreamRecord[];
}

interface PrepareSelfUpgradeModule {
  readonly PI_UPSTREAM_IDS: readonly string[];
  readonly ALL_UPSTREAM_IDS: readonly string[];
  readonly MAX_HTTP_JSON_BYTES: number;
  readonly buildTargetVersionsPayload: (piVersion: string, yamlVersion: string) => TargetVersionsPayload;
  readonly parseCanonicalSemver: (value: unknown) => { major: number; minor: number; patch: number; raw: string } | null;
  readonly auditBaselineParity: (repoRoot: string) => Promise<BaselineParityResult>;
  readonly evaluateUpstreamEligibility: (input: {
    readonly baselineByUpstream: Readonly<Record<string, string>>;
    readonly discoveredRecords: readonly TaskpackUpstreamRecord[];
    readonly stageDir?: string | undefined;
  }) => EligibilityResult;
  readonly discoverNpmUpstreams: (input: {
    readonly manifest: Awaited<ReturnType<typeof loadDeclarativeTaskpack>>;
    readonly baselineByUpstream: Readonly<Record<string, string>>;
    readonly fetchImpl?: typeof globalThis.fetch | undefined;
    readonly registryFixtures?: Readonly<Record<string, unknown>> | undefined;
  }) => Promise<readonly TaskpackUpstreamRecord[]>;
  readonly defaultLockfileBuilder: (ctx: {
    readonly repoRoot: string;
    readonly targetVersions: TargetVersionsPayload;
    readonly npmCacheDir: string;
    readonly registryUrl?: string | undefined;
  }) => Promise<Buffer>;
  readonly stageCandidateBundle: (input: {
    readonly repoRoot: string;
    readonly stageDir: string;
    readonly targetVersions: TargetVersionsPayload;
    readonly lockfileBuilder?: (ctx: {
      readonly repoRoot: string;
      readonly targetVersions: TargetVersionsPayload;
      readonly npmCacheDir: string;
    }) => Promise<Buffer>;
  }) => Promise<StageResult>;
  readonly runPrepareSelfUpgrade: (options: {
    readonly repoRoot?: string | undefined;
    readonly stageDir?: string | undefined;
    readonly requestedMode?: 'auto' | 'candidate' | 'no-change' | undefined;
    readonly skipStage?: boolean | undefined;
    readonly offlineCheck?: boolean | undefined;
    readonly discoveredRecords?: readonly TaskpackUpstreamRecord[] | undefined;
    readonly registryFixtures?: Readonly<Record<string, unknown>> | undefined;
    readonly lockfileBuilder?: (ctx: {
      readonly repoRoot: string;
      readonly targetVersions: TargetVersionsPayload;
      readonly npmCacheDir: string;
    }) => Promise<Buffer>;
  }) => Promise<PrepareSelfUpgradeRunResult>;
}

async function loadPreflightModule(): Promise<PrepareSelfUpgradeModule> {
  const scriptUrl = pathToFileURL(join(REPO_ROOT, 'scripts/prepare-self-upgrade.mjs')).href;
  return (await import(scriptUrl)) as PrepareSelfUpgradeModule;
}

async function withTempDir(run: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(await realpath(tmpdir()), 'lw-self-upgrade-test-'));
  await chmod(dir, 0o700);
  try {
    await run(dir);
  } finally {
    spawnSync('chmod', ['-R', 'u+w', dir], { stdio: 'ignore' });
    await rm(dir, { recursive: true, force: true });
  }
}

const PI_PACKAGE_NAMES = [
  '@earendil-works/pi-agent-core',
  '@earendil-works/pi-ai',
  '@earendil-works/pi-codemode',
  '@earendil-works/pi-coding-agent',
  '@earendil-works/pi-mcp',
  '@earendil-works/pi-tui',
] as const;

const ALL_WORKSPACES = [
  'packages/core',
  'packages/state',
  'packages/agent-pi',
  'packages/controller',
  'packages/cli',
  'packages/taskpack-runner',
  'packages/github-app',
  'packages/memory',
  'packages/decisions',
] as const;

function fakeIntegrity(label: string): string {
  return `sha512-${createHash('sha512').update(label, 'utf8').digest('base64')}`;
}

function buildUstarTgzBuffer(
  pkgJson: Readonly<Record<string, unknown>>,
  extraFiles: Readonly<Record<string, string>> = {},
): { readonly tgz: Buffer; readonly integrity: string; readonly shasum: string } {
  const entries: Record<string, string> = {
    'package/package.json': `${JSON.stringify(pkgJson, null, 2)}\n`,
    ...extraFiles,
  };
  const blocks: Buffer[] = [];
  for (const [entryPath, content] of Object.entries(entries)) {
    const body = Buffer.from(content, 'utf8');
    const header = Buffer.alloc(512, 0);
    header.write(entryPath, 0, 100, 'utf8');
    header.write('0000755\0', 100, 8, 'utf8');
    header.write('0000000\0', 108, 8, 'utf8');
    header.write('0000000\0', 116, 8, 'utf8');
    header.write(`${body.byteLength.toString(8).padStart(11, '0')}\0`, 124, 12, 'utf8');
    header.write(`${(1_700_000_000).toString(8).padStart(11, '0')}\0`, 136, 12, 'utf8');
    header.write('        ', 148, 8, 'utf8');
    header.write('0', 156, 1, 'utf8');
    header.write('ustar\0', 257, 6, 'utf8');
    header.write('00', 263, 2, 'utf8');
    let checksum = 0;
    for (let i = 0; i < 512; i += 1) {
      checksum += header[i]!;
    }
    header.write(`${checksum.toString(8).padStart(6, '0')}\0 `, 148, 8, 'utf8');
    blocks.push(header, body);
    const remainder = body.byteLength % 512;
    if (remainder !== 0) {
      blocks.push(Buffer.alloc(512 - remainder, 0));
    }
  }
  blocks.push(Buffer.alloc(1024, 0));
  const tgz = zlib.gzipSync(Buffer.concat(blocks));
  const integrity = `sha512-${createHash('sha512').update(tgz).digest('base64')}`;
  const shasum = createHash('sha1').update(tgz).digest('hex');
  return { tgz, integrity, shasum };
}

function buildSyntheticLockfile(options: {
  readonly piVersion: string;
  readonly yamlVersion: string;
  readonly nestedPiTransitiveYamlVersion?: string | undefined;
  readonly directCliYamlOverride?: string | undefined;
  readonly hoistedYamlOverride?: string | undefined;
  readonly forgedTypescriptLinkTarget?: string | undefined;
  readonly forgedYamlResolvedUrl?: string | undefined;
  readonly padBytes?: number | undefined;
}): string {
  const hoistedYamlVer = options.hoistedYamlOverride ?? options.yamlVersion;
  const packages: Record<string, Record<string, unknown>> = {
    '': {
      name: 'loopwright',
      version: '0.0.0',
      workspaces: [...ALL_WORKSPACES],
      devDependencies: {
        '@eslint/js': '10.0.1',
        '@types/node': '26.6.6',
        eslint: '10.14.0',
        typescript: '6.0.3',
        'typescript-eslint': '8.72.1',
      },
    },
    'packages/core': { version: '0.0.0' },
    'packages/state': { version: '0.0.0', dependencies: { '@loopwright/core': '0.0.0' } },
    'packages/memory': { version: '0.0.0', dependencies: { '@loopwright/core': '0.0.0' } },
    'packages/taskpack-runner': { version: '0.0.0', dependencies: { '@loopwright/core': '0.0.0' } },
    'packages/agent-pi': {
      version: '0.0.0',
      dependencies: Object.fromEntries([
        ...PI_PACKAGE_NAMES.map(pkg => [pkg, options.piVersion]),
        ['@loopwright/core', '0.0.0'],
        ['@loopwright/state', '0.0.0'],
      ]),
    },
    'packages/cli': {
      version: '0.0.0',
      dependencies: {
        '@loopwright/core': '0.0.0',
        yaml: options.directCliYamlOverride ?? options.yamlVersion,
      },
    },
    'packages/controller': {
      version: '0.0.0',
      dependencies: { '@loopwright/core': '0.0.0', yaml: options.yamlVersion },
    },
    'packages/decisions': {
      version: '0.0.0',
      dependencies: { '@loopwright/core': '0.0.0', yaml: options.yamlVersion },
    },
    'packages/github-app': {
      version: '0.0.0',
      dependencies: { '@loopwright/core': '0.0.0', yaml: options.yamlVersion },
    },
    'node_modules/typescript': options.forgedTypescriptLinkTarget !== undefined
      ? {
        version: '6.0.3',
        resolved: options.forgedTypescriptLinkTarget,
        link: true,
      }
      : {
        version: '6.0.3',
        resolved: 'https://registry.npmjs.org/typescript/-/typescript-6.0.3.tgz',
        integrity: fakeIntegrity('typescript@6.0.3'),
        dev: true,
      },
    'node_modules/eslint': {
      version: '10.14.0',
      resolved: 'https://registry.npmjs.org/eslint/-/eslint-10.14.0.tgz',
      integrity: fakeIntegrity('eslint@10.14.0'),
      dev: true,
    },
    'node_modules/yaml': {
      version: hoistedYamlVer,
      resolved: options.forgedYamlResolvedUrl ?? `https://registry.npmjs.org/yaml/-/yaml-${hoistedYamlVer}.tgz`,
      integrity: fakeIntegrity(`yaml@${hoistedYamlVer}`),
    },
  };

  for (const ws of ALL_WORKSPACES) {
    const shortName = ws.slice('packages/'.length);
    packages[`node_modules/@loopwright/${shortName}`] = {
      resolved: ws,
      link: true,
    };
  }

  for (const pkgName of PI_PACKAGE_NAMES) {
    const shortPkg = pkgName.split('/')[1]!;
    packages[`node_modules/${pkgName}`] = {
      version: options.piVersion,
      resolved: `https://registry.npmjs.org/${pkgName}/-/${shortPkg}-${options.piVersion}.tgz`,
      integrity: fakeIntegrity(`${pkgName}@${options.piVersion}`),
    };
  }
  if (options.nestedPiTransitiveYamlVersion !== undefined) {
    packages['node_modules/@earendil-works/pi-coding-agent/node_modules/yaml'] = {
      version: options.nestedPiTransitiveYamlVersion,
      resolved: `https://registry.npmjs.org/yaml/-/yaml-${options.nestedPiTransitiveYamlVersion}.tgz`,
      integrity: fakeIntegrity(`nested-yaml@${options.nestedPiTransitiveYamlVersion}`),
    };
  }
  if (options.padBytes !== undefined && options.padBytes > 0) {
    packages['node_modules/__oversized_padding_fixture'] = {
      version: '0.0.1',
      resolved: 'https://registry.npmjs.org/__oversized_padding_fixture/-/__oversized_padding_fixture-0.0.1.tgz',
      integrity: fakeIntegrity('padding'),
      padding: 'x'.repeat(options.padBytes),
    };
  }

  return `${JSON.stringify({
    name: 'loopwright',
    version: '0.0.0',
    lockfileVersion: 3,
    requires: true,
    packages,
  }, null, 2)}\n`;
}

async function createMiniSelfUpgradeRepo(
  parentDir: string,
  options?: {
    readonly emitBuildCanary?: boolean | undefined;
    readonly buildScriptBody?: string | undefined;
    readonly cliMainBody?: string | undefined;
    readonly testScriptBody?: string | undefined;
  },
): Promise<{ readonly repoRoot: string; readonly headSha: string }> {
  const repoRoot = join(parentDir, 'fixture-repo');
  await mkdir(join(repoRoot, '.loopwright/checks'), { recursive: true, mode: 0o700 });
  await mkdir(join(repoRoot, '.agents/skills/loopwright-step'), { recursive: true, mode: 0o700 });
  await mkdir(join(repoRoot, 'scripts'), { recursive: true, mode: 0o700 });
  await mkdir(join(repoRoot, 'docs'), { recursive: true, mode: 0o700 });

  for (const rel of [
    '.loopwright/taskpack.yaml',
    '.loopwright/instructions.md',
    '.loopwright/proposal.json',
    '.loopwright/checks/verify.sh',
  ]) {
    const raw = await readFile(join(REPO_ROOT, rel));
    await writeFile(join(repoRoot, rel), raw, {
      mode: rel.endsWith('.sh') ? 0o755 : 0o600,
    });
  }

  await writeFile(
    join(repoRoot, '.agents/skills/loopwright-step/SKILL.md'),
    '---\nname: loopwright-step\ndescription: fixture\n---\n',
    { mode: 0o600 },
  );
  await writeFile(
    join(repoRoot, 'README.md'),
    '# Fixture Loopwright Repo\n',
    { mode: 0o600 },
  );
  await writeFile(
    join(repoRoot, 'docs/development.md'),
    '# Development\n\nBaseline fixture doc.\n',
    { mode: 0o600 },
  );

  await writeFile(
    join(repoRoot, 'package.json'),
    `${JSON.stringify({
      name: 'loopwright',
      version: '0.0.0',
      private: true,
      type: 'module',
      workspaces: [...ALL_WORKSPACES],
      devDependencies: {
        '@eslint/js': '10.0.1',
        '@types/node': '26.6.6',
        eslint: '10.14.0',
        typescript: '6.0.3',
        'typescript-eslint': '8.72.1',
      },
    }, null, 2)}\n`,
    { mode: 0o600 },
  );

  await writeFile(
    join(repoRoot, 'package-lock.json'),
    buildSyntheticLockfile({ piVersion: '1.5.0', yamlVersion: '2.9.0' }),
    { mode: 0o600 },
  );

  await writeFile(
    join(repoRoot, 'tsconfig.json'),
    `${JSON.stringify({
      compilerOptions: {
        target: 'ES2024',
        module: 'NodeNext',
        moduleResolution: 'NodeNext',
        strict: true,
        noEmit: true,
        skipLibCheck: true,
      },
    }, null, 2)}\n`,
    { mode: 0o600 },
  );
  await writeFile(
    join(repoRoot, 'tsconfig.test.json'),
    `${JSON.stringify({
      extends: './tsconfig.json',
      include: ['packages/*/src/**/*.ts'],
    }, null, 2)}\n`,
    { mode: 0o600 },
  );
  await writeFile(
    join(repoRoot, 'eslint.config.mjs'),
    `export default [{ ignores: ['**/dist/**', 'node_modules/**'] }];\n`,
    { mode: 0o600 },
  );

  const workspaces: Readonly<Record<string, Record<string, string>>> = {
    'packages/core': {},
    'packages/state': { '@loopwright/core': '0.0.0' },
    'packages/memory': { '@loopwright/core': '0.0.0' },
    'packages/taskpack-runner': { '@loopwright/core': '0.0.0' },
    'packages/agent-pi': Object.fromEntries([
      ...PI_PACKAGE_NAMES.map(pkg => [pkg, '1.5.0']),
      ['@loopwright/core', '0.0.0'],
      ['@loopwright/state', '0.0.0'],
    ]),
    'packages/cli': { '@loopwright/core': '0.0.0', yaml: '2.9.0' },
    'packages/controller': { '@loopwright/core': '0.0.0', yaml: '2.9.0' },
    'packages/decisions': { '@loopwright/core': '0.0.0', yaml: '2.9.0' },
    'packages/github-app': { '@loopwright/core': '0.0.0', yaml: '2.9.0' },
  };

  for (const [ws, deps] of Object.entries(workspaces)) {
    await mkdir(join(repoRoot, ws, 'src'), { recursive: true, mode: 0o700 });
    const pkgName = `@loopwright/${ws.slice('packages/'.length)}`;
    await writeFile(
      join(repoRoot, ws, 'package.json'),
      `${JSON.stringify({
        name: pkgName,
        version: '0.0.0',
        private: true,
        type: 'module',
        exports: { '.': './dist/index.js' },
        ...(Object.keys(deps).length > 0 ? { dependencies: deps } : {}),
      }, null, 2)}\n`,
      { mode: 0o600 },
    );
    await writeFile(
      join(repoRoot, ws, 'src/index.ts'),
      `export const PACKAGE_ID = ${JSON.stringify(pkgName)};\n`,
      { mode: 0o600 },
    );
  }
  await writeFile(
    join(repoRoot, 'packages/cli/src/closure.ts'),
    `export const CLOSURE_ROWS = 23;\n`,
    { mode: 0o600 },
  );
  await writeFile(
    join(repoRoot, 'packages/cli/src/failure-matrix.ts'),
    `export const FAILURE_MATRIX = true;\n`,
    { mode: 0o600 },
  );

  const sideEffectSnippet = options?.emitBuildCanary === true
    ? `process.stderr.write('CANDIDATE_BUILD_EXECUTED_CANARY\\n');\n`
    : '';
  const defaultCliMain = `if (process.argv[2] === 'closure' && process.argv[3] === '--verify-failures') { process.exit(0); } process.exit(1);\n`;
  const effectiveCliMain = options?.cliMainBody ?? defaultCliMain;

  await writeFile(
    join(repoRoot, 'scripts/build.mjs'),
    options?.buildScriptBody ?? `import { mkdirSync, writeFileSync } from 'node:fs';
${sideEffectSnippet}mkdirSync('packages/cli/dist', { recursive: true });
writeFileSync('packages/cli/dist/main.js', ${JSON.stringify(effectiveCliMain)});
`,
    { mode: 0o600 },
  );
  await writeFile(
    join(repoRoot, 'scripts/check-docs.mjs'),
    `import { readFileSync } from 'node:fs';
const content = readFileSync('docs/development.md', 'utf8');
if (!content.startsWith('# ')) {
  process.exit(1);
}
`,
    { mode: 0o600 },
  );
  await writeFile(
    join(repoRoot, 'scripts/run-tests.mjs'),
    options?.testScriptBody ?? `import { existsSync, lstatSync } from 'node:fs';
if (!existsSync('packages/agent-pi/src/index.ts')) {
  process.exit(1);
}
if (!lstatSync('.claude/skills').isSymbolicLink()) {
  process.exit(1);
}
`,
    { mode: 0o600 },
  );
  await writeFile(
    join(repoRoot, 'scripts/site.mjs'),
    `process.exit(0);\n`,
    { mode: 0o600 },
  );

  spawnSync('git', ['init'], { cwd: repoRoot, stdio: 'ignore' });
  spawnSync('git', ['config', 'user.name', 'Test Bot'], { cwd: repoRoot, stdio: 'ignore' });
  spawnSync('git', ['config', 'user.email', 'test@loopwright.local'], { cwd: repoRoot, stdio: 'ignore' });
  spawnSync('git', ['add', '.'], { cwd: repoRoot, stdio: 'ignore' });
  spawnSync('git', ['commit', '-m', 'chore: seed self-upgrade fixture'], { cwd: repoRoot, stdio: 'ignore' });
  const headSha = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: repoRoot, encoding: 'utf8' }).stdout.trim();
  return { repoRoot, headSha };
}

async function stageAndApplyCandidateUpgrade(options: {
  readonly preflight: PrepareSelfUpgradeModule;
  readonly repoRoot: string;
  readonly candidateDir: string;
  readonly stageDir: string;
  readonly piVersion?: string | undefined;
  readonly yamlVersion?: string | undefined;
  readonly nestedPiTransitiveYamlVersion?: string | undefined;
}): Promise<StageResult> {
  const piVersion = options.piVersion ?? '1.6.0';
  const yamlVersion = options.yamlVersion ?? '2.10.0';
  const targetVersions = options.preflight.buildTargetVersionsPayload(piVersion, yamlVersion);
  const lockBytes = Buffer.from(
    buildSyntheticLockfile({
      piVersion,
      yamlVersion,
      nestedPiTransitiveYamlVersion: options.nestedPiTransitiveYamlVersion,
    }),
    'utf8',
  );
  const staged = await options.preflight.stageCandidateBundle({
    repoRoot: options.repoRoot,
    stageDir: options.stageDir,
    targetVersions,
    lockfileBuilder: async () => lockBytes,
  });

  await writeFile(
    join(options.candidateDir, '.loopwright/proposal.json'),
    `${JSON.stringify(targetVersions, null, 2)}\n`,
    { mode: 0o600 },
  );
  await writeFile(join(options.candidateDir, 'package-lock.json'), lockBytes, { mode: 0o600 });
  for (const [ws, depUpdates] of Object.entries(targetVersions.packages)) {
    const wsManifestPath = join(options.candidateDir, ws, 'package.json');
    const wsManifest = JSON.parse(await readFile(wsManifestPath, 'utf8')) as {
      dependencies: Record<string, string>;
    };
    wsManifest.dependencies = { ...wsManifest.dependencies, ...depUpdates };
    await writeFile(wsManifestPath, `${JSON.stringify(wsManifest, null, 2)}\n`, { mode: 0o600 });
  }
  return staged;
}

function runVerifyScript(
  candidateDir: string,
  extraEnv: Readonly<Record<string, string | undefined>>,
): { readonly status: number | null; readonly stdout: string; readonly stderr: string } {
  const verifyPath = join(REPO_ROOT, '.loopwright/checks/verify.sh');
  const cleanEnv: Record<string, string> = {
    PATH: '/usr/local/bin:/usr/bin:/bin',
    NODE_BIN_DIR: dirname(process.execPath),
    HOME: candidateDir,
    TMPDIR: tmpdir(),
    LANG: 'C.UTF-8',
    LC_ALL: 'C.UTF-8',
    LOOPWRIGHT_CANDIDATE_DIR: candidateDir,
    LOOPWRIGHT_CHECK_ID: 'self-upgrade-verify',
  };
  for (const [k, v] of Object.entries(extraEnv)) {
    if (v !== undefined) {
      cleanEnv[k] = v;
    }
  }
  const proc = spawnSync('/bin/bash', [verifyPath], {
    cwd: candidateDir,
    env: cleanEnv,
    encoding: 'utf8',
    timeout: 120_000,
  });
  return {
    status: proc.status,
    stdout: proc.stdout ?? '',
    stderr: proc.stderr ?? '',
  };
}

describe('Self-upgrade dogfooding Taskpack, preflight stager, and OS-contained command.v1 gate', () => {
  it('compiles committed .loopwright/taskpack.yaml in candidate and no-change modes with strict scope boundaries', async () => {
    const preflight = await loadPreflightModule();
    await withTempDir(async dir => {
      const { repoRoot } = await createMiniSelfUpgradeRepo(dir);
      const baseline = await preflight.auditBaselineParity(repoRoot);
      assert.equal(baseline.piBaseline, '1.5.0');
      assert.equal(baseline.yamlBaseline, '2.9.0');
      assert.equal(baseline.lockfileBytes <= 900 * 1024, true);
    });

    const manifest = await loadDeclarativeTaskpack({
      manifestPath: '.loopwright/taskpack.yaml',
      repositoryRoot: REPO_ROOT,
    });
    assert.equal(manifest.metadata.name, 'self-upgrade');
    assert.equal(manifest.spec.limits?.commandTimeoutSeconds, 900);
    assert.deepEqual(manifest.spec.triggers.commentCommands, ['retry', 'revise']);
    assert.equal(manifest.spec.upstreams.length, 7);

    const checkEntry = manifest.spec.verification.localChecks.find(c => c.id === 'self-upgrade-verify');
    const allowedEnv = checkEntry?.parameters?.['env'] as readonly string[] | undefined;
    assert.equal(allowedEnv?.includes('SELF_UPGRADE_RUN_ROOT'), true);
    assert.equal(allowedEnv?.includes('SELF_UPGRADE_STAGE_DIR'), true);

    const candidateCompiled = await compileDeclarativeTaskpack(manifest, {
      mode: 'candidate',
      executionMode: 'delegated',
      repository: 'gpustack/loopwright',
      baseRevision: 'a'.repeat(40),
      sourceRevision: 'a'.repeat(40),
      repositoryRoot: REPO_ROOT,
      taskpackPath: '.loopwright/taskpack.yaml',
      budgets: DEFAULT_HOST_BUDGETS,
    });
    const noChangeCompiled = await compileDeclarativeTaskpack(manifest, {
      mode: 'no-change',
      executionMode: 'delegated',
      repository: 'gpustack/loopwright',
      baseRevision: 'a'.repeat(40),
      sourceRevision: 'a'.repeat(40),
      repositoryRoot: REPO_ROOT,
      taskpackPath: '.loopwright/taskpack.yaml',
      budgets: DEFAULT_HOST_BUDGETS,
    });

    assert.equal(candidateCompiled.localCommandGates?.length, 1);
    assert.equal(candidateCompiled.localCommandGates?.[0]?.timeoutSeconds, 900);
    assert.equal(candidateCompiled.localCommandGates?.[0]?.script, '.loopwright/checks/verify.sh');
    assert.deepEqual(noChangeCompiled.config.spec.task.spec.acceptance.required, ['taskpack-no-change']);

    const contract = candidateCompiled.config.spec.task;
    const writablePaths = [
      '.loopwright/proposal.json',
      'package-lock.json',
      'packages/agent-pi/package.json',
      'packages/agent-pi/src/host-session.ts',
      'packages/cli/package.json',
      'packages/controller/src/index.ts',
      'packages/decisions/src/schema.ts',
      'packages/github-app/src/schema.ts',
      'docs/development.md',
    ];
    for (const rel of writablePaths) {
      const check = isWritablePath(contract, rel);
      assert.equal(check.ok && check.value, true, `expected ${rel} to be writable`);
    }

    const protectedPaths = [
      '.loopwright/taskpack.yaml',
      '.loopwright/instructions.md',
      '.loopwright/checks/verify.sh',
      'package.json',
      'scripts/prepare-self-upgrade.mjs',
      'action.yml',
      '.github/workflows/ci.yml',
      'packages/core/src/contracts.ts',
      'packages/state/src/index.ts',
      'packages/memory/src/index.ts',
      'packages/taskpack-runner/src/index.ts',
      'packages/agent-pi/qualification/run.ts',
      'packages/controller/qualification/run.ts',
      'packages/cli/src/closure.ts',
      'packages/cli/src/failure-matrix.ts',
      'docs/contribute/internals.md',
    ];
    for (const rel of protectedPaths) {
      const check = isWritablePath(contract, rel);
      assert.equal(check.ok && check.value, false, `expected ${rel} to be non-writable`);
    }
  });

  it('evaluates all SemVer eligibility, partial publish, rollback, prerelease, missing-version hash, and streaming >256 KiB cap branches', async () => {
    const preflight = await loadPreflightModule();
    const baselineByUpstream: Record<string, string> = {
      'pi-coding-agent': '1.5.0',
      'pi-ai': '1.5.0',
      'pi-agent-core': '1.5.0',
      'pi-mcp': '1.5.0',
      'pi-codemode': '1.5.0',
      'pi-tui': '1.5.0',
      yaml: '2.9.0',
    };
    const makeRecords = (overrides: Readonly<Record<string, string>>): readonly TaskpackUpstreamRecord[] =>
      preflight.ALL_UPSTREAM_IDS.map(id => {
        const version = overrides[id] ?? baselineByUpstream[id]!;
        return {
          upstreamId: id,
          status: version === baselineByUpstream[id] ? 'up_to_date' : 'available',
          version,
        };
      });

    // 1) All up_to_date -> no-change
    const unchanged = preflight.evaluateUpstreamEligibility({
      baselineByUpstream,
      discoveredRecords: makeRecords({}),
      stageDir: '/tmp/stage-test',
    });
    assert.equal(unchanged.recommendedMode, 'no-change');
    assert.equal(unchanged.actionMode, 'no-change');
    assert.equal(unchanged.upstreamRecords.every(r => r.status === 'up_to_date'), true);

    // 2) Aligned Pi bump -> candidate
    const alignedPi = preflight.evaluateUpstreamEligibility({
      baselineByUpstream,
      discoveredRecords: makeRecords(
        Object.fromEntries(preflight.PI_UPSTREAM_IDS.map(id => [id, '1.6.0'])),
      ),
      stageDir: '/tmp/stage-test',
    });
    assert.equal(alignedPi.recommendedMode, 'candidate');
    assert.equal(alignedPi.targetPiVersion, '1.6.0');
    assert.equal(alignedPi.targetYamlVersion, '2.9.0');
    for (const id of preflight.PI_UPSTREAM_IDS) {
      const rec = alignedPi.upstreamRecords.find(r => r.upstreamId === id);
      assert.equal(rec?.status, 'available');
      assert.equal(rec?.version, '1.6.0');
      assert.equal(rec?.reason?.includes('stageDir=/tmp/stage-test'), true);
    }

    // 3) Partial Pi publish + unchanged YAML -> blocked
    const partialPiOnly = preflight.evaluateUpstreamEligibility({
      baselineByUpstream,
      discoveredRecords: makeRecords({
        'pi-coding-agent': '1.6.0',
        'pi-ai': '1.6.0',
        'pi-agent-core': '1.6.0',
        'pi-mcp': '1.6.0',
        'pi-codemode': '1.6.0',
        'pi-tui': '1.5.0',
      }),
      stageDir: '/tmp/stage-test',
    });
    assert.equal(partialPiOnly.recommendedMode, 'blocked');
    assert.equal(partialPiOnly.upstreamRecords.some(r => r.status === 'blocked'), true);

    // 4) Partial Pi publish + YAML bump -> YAML-only candidate (Pi held at baseline)
    const partialPiWithYaml = preflight.evaluateUpstreamEligibility({
      baselineByUpstream,
      discoveredRecords: makeRecords({
        'pi-coding-agent': '1.6.0',
        'pi-ai': '1.5.0',
        yaml: '2.10.0',
      }),
      stageDir: '/tmp/stage-test',
    });
    assert.equal(partialPiWithYaml.recommendedMode, 'candidate');
    assert.equal(partialPiWithYaml.targetPiVersion, '1.5.0');
    assert.equal(partialPiWithYaml.targetYamlVersion, '2.10.0');
    const yamlRec = partialPiWithYaml.upstreamRecords.find(r => r.upstreamId === 'yaml');
    assert.equal(yamlRec?.status, 'available');
    assert.equal(yamlRec?.version, '2.10.0');
    for (const id of preflight.PI_UPSTREAM_IDS) {
      const piRec = partialPiWithYaml.upstreamRecords.find(r => r.upstreamId === id);
      assert.equal(piRec?.status, 'up_to_date');
      assert.equal(piRec?.version, '1.5.0');
    }

    // 5) Aligned rollback -> rejected (blocked)
    const alignedRollback = preflight.evaluateUpstreamEligibility({
      baselineByUpstream,
      discoveredRecords: makeRecords(
        Object.fromEntries(preflight.PI_UPSTREAM_IDS.map(id => [id, '1.4.9'])),
      ),
    });
    assert.equal(alignedRollback.recommendedMode, 'blocked');
    assert.equal(alignedRollback.reasons.some(msg => msg.includes('rollback rejected')), true);

    // 6) Prerelease tag -> rejected (blocked)
    const prerelease = preflight.evaluateUpstreamEligibility({
      baselineByUpstream,
      discoveredRecords: makeRecords({ yaml: '2.10.0-rc.1' }),
    });
    assert.equal(prerelease.recommendedMode, 'blocked');
    assert.equal(prerelease.reasons.some(msg => msg.includes('non-canonical SemVer')), true);

    // 7) Missing-version 16-hex SHA hash from http-json -> rejected (blocked)
    const manifest = await loadDeclarativeTaskpack({
      manifestPath: '.loopwright/taskpack.yaml',
      repositoryRoot: REPO_ROOT,
    });
    const fixturesWithMissingVersion: Record<string, unknown> = Object.fromEntries(
      preflight.ALL_UPSTREAM_IDS.map(id => [
        id,
        id === 'yaml' ? { dist_tag: 'broken-no-version-field' } : { version: '1.5.0' },
      ]),
    );
    const discoveredMissingVersion = await preflight.discoverNpmUpstreams({
      manifest,
      baselineByUpstream,
      registryFixtures: fixturesWithMissingVersion,
    });
    const missingHashEval = preflight.evaluateUpstreamEligibility({
      baselineByUpstream,
      discoveredRecords: discoveredMissingVersion,
    });
    assert.equal(missingHashEval.recommendedMode, 'blocked');
    assert.equal(missingHashEval.reasons.some(msg => msg.includes('non-canonical SemVer')), true);

    // 8) Incremental streaming >256 KiB response cancels mid-stream without buffering full payload
    let chunksPulled = 0;
    let streamCancelled = false;
    const chunkSize = 64 * 1024;
    const totalChunks = 12; // 768 KiB total if uncancelled
    const oversizedFetch: typeof globalThis.fetch = async url => {
      const urlText = String(url);
      if (!urlText.endsWith('/yaml/latest')) {
        return new Response(JSON.stringify({ version: '1.5.0' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      const stream = new ReadableStream<Uint8Array>(
        {
          pull(controller) {
            if (chunksPulled >= totalChunks) {
              controller.close();
              return;
            }
            chunksPulled += 1;
            controller.enqueue(new Uint8Array(chunkSize).fill(0x61));
          },
          cancel() {
            streamCancelled = true;
          },
        },
        { highWaterMark: 0 },
      );
      return new Response(stream, { status: 200 });
    };
    const streamedRecords = await preflight.discoverNpmUpstreams({
      manifest,
      baselineByUpstream,
      fetchImpl: oversizedFetch,
    });
    const yamlStreamRec = streamedRecords.find(r => r.upstreamId === 'yaml');
    assert.equal(yamlStreamRec?.status, 'failed');
    assert.equal(yamlStreamRec?.reason?.includes(`${preflight.MAX_HTTP_JSON_BYTES} bytes`), true);
    assert.equal(streamCancelled, true, 'oversized HTTP stream must be cancelled incrementally');
    assert.equal(chunksPulled <= 5, true, `expected <=5 64KiB chunks read before cancel, got ${chunksPulled}`);
  });

  it('fails nonzero on malformed JSON, invalid schema, or drifted .loopwright/proposal.json and stages read-only candidate bundles', async () => {
    const preflight = await loadPreflightModule();
    await withTempDir(async dir => {
      const { repoRoot, headSha } = await createMiniSelfUpgradeRepo(dir);
      const proposalPath = join(repoRoot, '.loopwright/proposal.json');
      const originalProposalRaw = await readFile(proposalPath, 'utf8');
      const originalProposal = JSON.parse(originalProposalRaw) as Record<string, unknown>;

      // 1) Malformed truncated JSON in .loopwright/proposal.json -> nonzero failure
      await writeFile(proposalPath, '{"schema_version": 1, "summary": "broken"\n', { mode: 0o600 });
      const malformedRun = spawnSync(
        process.execPath,
        [join(REPO_ROOT, 'scripts/prepare-self-upgrade.mjs'), '--repo', repoRoot, '--offline-check'],
        { encoding: 'utf8' },
      );
      assert.notEqual(malformedRun.status, 0);
      assert.equal(malformedRun.stderr.includes('Invalid JSON in ".loopwright/proposal.json"'), true);

      // 2) Invalid schema (schema_version !== 1) in .loopwright/proposal.json -> nonzero failure
      await writeFile(
        proposalPath,
        `${JSON.stringify({ ...originalProposal, schema_version: 2 }, null, 2)}\n`,
        { mode: 0o600 },
      );
      const schemaInvalidRun = spawnSync(
        process.execPath,
        [join(REPO_ROOT, 'scripts/prepare-self-upgrade.mjs'), '--repo', repoRoot, '--offline-check'],
        { encoding: 'utf8' },
      );
      assert.notEqual(schemaInvalidRun.status, 0);
      assert.equal(schemaInvalidRun.stderr.includes('schema_version must be 1'), true);

      // 3) Drift .loopwright/proposal.json yaml version without updating packages/cli/package.json -> nonzero failure
      const driftedProposal = {
        ...originalProposal,
        upstreams: {
          ...(originalProposal['upstreams'] as Record<string, unknown>),
          yaml: { package: 'yaml', version: '2.8.0' },
        },
      };
      await writeFile(proposalPath, `${JSON.stringify(driftedProposal, null, 2)}\n`, { mode: 0o600 });
      const cliDriftRun = spawnSync(
        process.execPath,
        [join(REPO_ROOT, 'scripts/prepare-self-upgrade.mjs'), '--repo', repoRoot, '--offline-check'],
        { encoding: 'utf8' },
      );
      assert.notEqual(cliDriftRun.status, 0);
      assert.equal(cliDriftRun.stderr.includes('drifts from proposal.upstreams'), true);

      // Restore clean proposal and stage a read-only candidate bundle
      await writeFile(proposalPath, originalProposalRaw, { mode: 0o600 });
      const stageDir = join(dir, 'staged-bundle');
      const prepared = await preflight.runPrepareSelfUpgrade({
        repoRoot,
        stageDir,
        registryFixtures: Object.fromEntries(
          preflight.ALL_UPSTREAM_IDS.map(id => [
            id,
            { version: id === 'yaml' ? '2.10.0' : '1.6.0' },
          ]),
        ),
        lockfileBuilder: async ({ targetVersions }) => Buffer.from(
          buildSyntheticLockfile({
            piVersion: targetVersions.upstreams['pi-coding-agent']!.version,
            yamlVersion: targetVersions.upstreams['yaml']!.version,
          }),
          'utf8',
        ),
      });

      assert.equal(prepared.recommendedMode, 'candidate');
      assert.notEqual(prepared.staged, null);
      const targetInfo = await stat(prepared.staged!.targetVersionsPath);
      const lockInfo = await stat(prepared.staged!.candidateLockPath);
      const dirInfo = await stat(prepared.staged!.stageDir);
      assert.equal(targetInfo.mode & 0o222, 0, 'target-versions.json must be read-only');
      assert.equal(lockInfo.mode & 0o222, 0, 'package-lock.candidate.json must be read-only');
      assert.equal(dirInfo.mode & 0o222, 0, 'stage directory must be read-only');

      // Verify checkManagedPrMatchesDiscoveredState matches a committed proposal carrying those versions
      const prHeadProposal = JSON.stringify(prepared.evaluation!.targetVersions, null, 2);
      await writeFile(proposalPath, `${prHeadProposal}\n`, { mode: 0o600 });
      spawnSync('git', ['add', '.loopwright/proposal.json'], { cwd: repoRoot, stdio: 'ignore' });
      spawnSync('git', ['commit', '-m', 'chore: simulated managed PR head'], { cwd: repoRoot, stdio: 'ignore' });
      const prHeadSha = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: repoRoot, encoding: 'utf8' }).stdout.trim();
      spawnSync('git', ['reset', '--hard', headSha], { cwd: repoRoot, stdio: 'ignore' });

      const manifest = await loadDeclarativeTaskpack({
        manifestPath: '.loopwright/taskpack.yaml',
        repositoryRoot: repoRoot,
      });
      const prMatches = await checkManagedPrMatchesDiscoveredState({
        repositoryRoot: repoRoot,
        repositoryFullName: 'gpustack/loopwright',
        manifest,
        openManagedPr: {
          number: 42,
          htmlUrl: 'https://github.com/gpustack/loopwright/pull/42',
          headRef: 'loopwright-self-upgrade-1',
          headSha: prHeadSha,
          baseRef: 'main',
          baseSha: headSha,
          title: 'chore(deps): self-upgrade runtime dependencies',
          body: 'Managed PR fixture',
        },
        records: prepared.upstreamRecords,
      });
      assert.equal(prMatches, true);
    });
  });

  it('enforces verify.sh staged-bundle binding, compiler/git-url lockfile guards, workspace-entry skew, size cap, and GITHUB_ACTIONS refusal', async () => {
    const preflight = await loadPreflightModule();
    await withTempDir(async dir => {
      const { repoRoot } = await createMiniSelfUpgradeRepo(dir, {
        emitBuildCanary: true,
      });
      const hostNodeModules = join(REPO_ROOT, 'node_modules');
      const stageDir = join(dir, 'stage-guards');

      // Stage a valid 1.6.0 / 2.10.0 bundle first
      const baselineProposalRaw = await readFile(join(repoRoot, '.loopwright/proposal.json'), 'utf8');
      const baselineLockRaw = await readFile(join(repoRoot, 'package-lock.json'), 'utf8');
      const baselineCliPkgRaw = await readFile(join(repoRoot, 'packages/cli/package.json'), 'utf8');
      const baselineAgentPiPkgRaw = await readFile(join(repoRoot, 'packages/agent-pi/package.json'), 'utf8');

      // 1) Refuse SELF_UPGRADE_TEST_NODE_MODULES when GITHUB_ACTIONS=true
      const ghActionsRefused = runVerifyScript(repoRoot, {
        GITHUB_ACTIONS: 'true',
        SELF_UPGRADE_ALLOW_TEST_FIXTURE: '1',
        SELF_UPGRADE_TEST_NODE_MODULES: hostNodeModules,
        SELF_UPGRADE_REPO_ROOT: repoRoot,
        SELF_UPGRADE_STAGE_DIR: stageDir,
      });
      assert.notEqual(ghActionsRefused.status, 0);
      assert.equal(ghActionsRefused.stderr.includes('GITHUB_ACTIONS'), true);
      assert.equal(ghActionsRefused.stderr.includes('CANDIDATE_BUILD_EXECUTED_CANARY'), false);

      // 2) Reject unchanged baseline manifests even if someone stages matching baseline target-versions.json
      const unchangedStageDir = join(dir, 'stage-unchanged');
      await preflight.stageCandidateBundle({
        repoRoot,
        stageDir: unchangedStageDir,
        targetVersions: preflight.buildTargetVersionsPayload('1.5.0', '2.9.0'),
        lockfileBuilder: async () => Buffer.from(baselineLockRaw, 'utf8'),
      });
      const unchangedCandidateRes = runVerifyScript(repoRoot, {
        SELF_UPGRADE_ALLOW_TEST_FIXTURE: '1',
        SELF_UPGRADE_TEST_NODE_MODULES: hostNodeModules,
        SELF_UPGRADE_REPO_ROOT: repoRoot,
        SELF_UPGRADE_STAGE_DIR: unchangedStageDir,
      });
      assert.notEqual(unchangedCandidateRes.status, 0);
      assert.equal(unchangedCandidateRes.stderr.includes('do not advance'), true);
      assert.equal(unchangedCandidateRes.stderr.includes('CANDIDATE_BUILD_EXECUTED_CANARY'), false);

      // Prepare valid upgraded candidate state (pi=1.6.0, yaml=2.10.0)
      await stageAndApplyCandidateUpgrade({
        preflight,
        repoRoot,
        candidateDir: repoRoot,
        stageDir,
        piVersion: '1.6.0',
        yamlVersion: '2.10.0',
        nestedPiTransitiveYamlVersion: '2.9.0',
      });
      const validLockRaw = await readFile(join(repoRoot, 'package-lock.json'), 'utf8');
      const validCliPkgRaw = await readFile(join(repoRoot, 'packages/cli/package.json'), 'utf8');
      const validAgentPiPkgRaw = await readFile(join(repoRoot, 'packages/agent-pi/package.json'), 'utf8');

      // 3) Reject scripts/postinstall injection in packages/cli/package.json BEFORE running candidate build
      const tamperedScriptsPkg = {
        ...(JSON.parse(validCliPkgRaw) as Record<string, unknown>),
        scripts: { postinstall: 'echo pwned', test: 'true' },
      };
      await writeFile(join(repoRoot, 'packages/cli/package.json'), `${JSON.stringify(tamperedScriptsPkg, null, 2)}\n`, { mode: 0o600 });
      const scriptTamperRes = runVerifyScript(repoRoot, {
        SELF_UPGRADE_ALLOW_TEST_FIXTURE: '1',
        SELF_UPGRADE_TEST_NODE_MODULES: hostNodeModules,
        SELF_UPGRADE_REPO_ROOT: repoRoot,
        SELF_UPGRADE_STAGE_DIR: stageDir,
      });
      assert.notEqual(scriptTamperRes.status, 0);
      assert.equal(scriptTamperRes.stderr.includes('CANDIDATE_BUILD_EXECUTED_CANARY'), false);
      await writeFile(join(repoRoot, 'packages/cli/package.json'), validCliPkgRaw, { mode: 0o600 });

      // 4) Reject @earendil-works/pi-* version skew in packages/agent-pi/package.json
      const parsedAgentPi = JSON.parse(validAgentPiPkgRaw) as { dependencies: Record<string, string> };
      parsedAgentPi.dependencies['@earendil-works/pi-ai'] = '1.6.1';
      await writeFile(join(repoRoot, 'packages/agent-pi/package.json'), `${JSON.stringify(parsedAgentPi, null, 2)}\n`, { mode: 0o600 });
      const piSkewRes = runVerifyScript(repoRoot, {
        SELF_UPGRADE_ALLOW_TEST_FIXTURE: '1',
        SELF_UPGRADE_TEST_NODE_MODULES: hostNodeModules,
        SELF_UPGRADE_REPO_ROOT: repoRoot,
        SELF_UPGRADE_STAGE_DIR: stageDir,
      });
      assert.notEqual(piSkewRes.status, 0);
      assert.equal(piSkewRes.stderr.includes('CANDIDATE_BUILD_EXECUTED_CANARY'), false);
      await writeFile(join(repoRoot, 'packages/agent-pi/package.json'), validAgentPiPkgRaw, { mode: 0o600 });

      // 5) Reject workspace-entry yaml mismatch (packages["packages/cli"].dependencies.yaml != 2.10.0 while hoisted stays 2.10.0)
      const lockPath = join(repoRoot, 'package-lock.json');
      await writeFile(
        lockPath,
        buildSyntheticLockfile({
          piVersion: '1.6.0',
          yamlVersion: '2.10.0',
          directCliYamlOverride: '2.9.0',
        }),
        { mode: 0o600 },
      );
      const wsEntrySkewRes = runVerifyScript(repoRoot, {
        SELF_UPGRADE_ALLOW_TEST_FIXTURE: '1',
        SELF_UPGRADE_TEST_NODE_MODULES: hostNodeModules,
        SELF_UPGRADE_REPO_ROOT: repoRoot,
        SELF_UPGRADE_STAGE_DIR: stageDir,
      });
      assert.notEqual(wsEntrySkewRes.status, 0);
      assert.equal(wsEntrySkewRes.stderr.includes("packages/cli.dependencies['yaml']"), true);
      assert.equal(wsEntrySkewRes.stderr.includes('CANDIDATE_BUILD_EXECUTED_CANARY'), false);

      // 6) Reject hoisted resolution yaml mismatch (node_modules/yaml=2.9.0 while workspace entry is 2.10.0)
      await writeFile(
        lockPath,
        buildSyntheticLockfile({
          piVersion: '1.6.0',
          yamlVersion: '2.10.0',
          hoistedYamlOverride: '2.9.0',
        }),
        { mode: 0o600 },
      );
      const hoistedSkewRes = runVerifyScript(repoRoot, {
        SELF_UPGRADE_ALLOW_TEST_FIXTURE: '1',
        SELF_UPGRADE_TEST_NODE_MODULES: hostNodeModules,
        SELF_UPGRADE_REPO_ROOT: repoRoot,
        SELF_UPGRADE_STAGE_DIR: stageDir,
      });
      assert.notEqual(hoistedSkewRes.status, 0);
      assert.equal(hoistedSkewRes.stderr.includes('direct resolution for packages/cli -> yaml'), true);
      assert.equal(hoistedSkewRes.stderr.includes('CANDIDATE_BUILD_EXECUTED_CANARY'), false);

      // 7) Reject forged compiler link hijack (node_modules/typescript -> packages/cli/fake-typescript)
      await writeFile(
        lockPath,
        buildSyntheticLockfile({
          piVersion: '1.6.0',
          yamlVersion: '2.10.0',
          forgedTypescriptLinkTarget: 'packages/cli/fake-typescript',
        }),
        { mode: 0o600 },
      );
      const compilerHijackRes = runVerifyScript(repoRoot, {
        SELF_UPGRADE_ALLOW_TEST_FIXTURE: '1',
        SELF_UPGRADE_TEST_NODE_MODULES: hostNodeModules,
        SELF_UPGRADE_REPO_ROOT: repoRoot,
        SELF_UPGRADE_STAGE_DIR: stageDir,
      });
      assert.notEqual(compilerHijackRes.status, 0);
      assert.equal(compilerHijackRes.stderr.includes('unauthorized link entry'), true);
      assert.equal(compilerHijackRes.stderr.includes('CANDIDATE_BUILD_EXECUTED_CANARY'), false);

      // 8) Reject unapproved git+https:// resolved URL in package-lock.json
      await writeFile(
        lockPath,
        buildSyntheticLockfile({
          piVersion: '1.6.0',
          yamlVersion: '2.10.0',
          forgedYamlResolvedUrl: 'git+https://example.invalid/yaml.git#deadbeef',
        }),
        { mode: 0o600 },
      );
      const gitUrlRes = runVerifyScript(repoRoot, {
        SELF_UPGRADE_ALLOW_TEST_FIXTURE: '1',
        SELF_UPGRADE_TEST_NODE_MODULES: hostNodeModules,
        SELF_UPGRADE_REPO_ROOT: repoRoot,
        SELF_UPGRADE_STAGE_DIR: stageDir,
      });
      assert.notEqual(gitUrlRes.status, 0);
      assert.equal(gitUrlRes.stderr.includes('unapproved resolved source'), true);
      assert.equal(gitUrlRes.stderr.includes('CANDIDATE_BUILD_EXECUTED_CANARY'), false);

      // 9) Reject candidate lockfile whose SHA-256 differs from staged package-lock.candidate.json
      await writeFile(
        lockPath,
        buildSyntheticLockfile({
          piVersion: '1.6.0',
          yamlVersion: '2.10.0',
          nestedPiTransitiveYamlVersion: '2.9.1',
        }),
        { mode: 0o600 },
      );
      const shaMismatchRes = runVerifyScript(repoRoot, {
        SELF_UPGRADE_ALLOW_TEST_FIXTURE: '1',
        SELF_UPGRADE_TEST_NODE_MODULES: hostNodeModules,
        SELF_UPGRADE_REPO_ROOT: repoRoot,
        SELF_UPGRADE_STAGE_DIR: stageDir,
      });
      assert.notEqual(shaMismatchRes.status, 0);
      assert.equal(shaMismatchRes.stderr.includes('does not match trusted staged package-lock.candidate.json'), true);
      assert.equal(shaMismatchRes.stderr.includes('CANDIDATE_BUILD_EXECUTED_CANARY'), false);

      // 10) Reject oversized package-lock.json (> 900 KiB)
      await writeFile(
        lockPath,
        buildSyntheticLockfile({
          piVersion: '1.6.0',
          yamlVersion: '2.10.0',
          padBytes: 910 * 1024,
        }),
        { mode: 0o600 },
      );
      const oversizedRes = runVerifyScript(repoRoot, {
        SELF_UPGRADE_ALLOW_TEST_FIXTURE: '1',
        SELF_UPGRADE_TEST_NODE_MODULES: hostNodeModules,
        SELF_UPGRADE_REPO_ROOT: repoRoot,
        SELF_UPGRADE_STAGE_DIR: stageDir,
      });
      assert.notEqual(oversizedRes.status, 0);
      assert.equal(oversizedRes.stderr.includes('CANDIDATE_BUILD_EXECUTED_CANARY'), false);

      // 11) Restore exact staged lockfile (with nested transitive yaml=2.9.0) and verify execution behavior
      await writeFile(lockPath, validLockRaw, { mode: 0o600 });
      const nestedAllowedRes = runVerifyScript(repoRoot, {
        SELF_UPGRADE_ALLOW_TEST_FIXTURE: '1',
        SELF_UPGRADE_TEST_NODE_MODULES: hostNodeModules,
        SELF_UPGRADE_REPO_ROOT: repoRoot,
        SELF_UPGRADE_STAGE_DIR: stageDir,
      });
      if (CAN_RUN_KERNEL_CONTAINMENT) {
        assert.equal(nestedAllowedRes.status, 0, `expected verify.sh to pass: ${nestedAllowedRes.stderr}`);
        assert.equal(nestedAllowedRes.stderr.includes('CANDIDATE_BUILD_EXECUTED_CANARY'), true);
      } else {
        assert.notEqual(nestedAllowedRes.status, 0);
        assert.equal(nestedAllowedRes.stderr.includes('failing closed'), true);
      }

      // Restore baseline files cleanly
      await writeFile(join(repoRoot, '.loopwright/proposal.json'), baselineProposalRaw, { mode: 0o600 });
      await writeFile(lockPath, baselineLockRaw, { mode: 0o600 });
      await writeFile(join(repoRoot, 'packages/cli/package.json'), baselineCliPkgRaw, { mode: 0o600 });
      await writeFile(join(repoRoot, 'packages/agent-pi/package.json'), baselineAgentPiPkgRaw, { mode: 0o600 });
    });
  });

  it('contains candidate execution inside OS sandbox with positive uncontained controls and kernel denial evidence', async () => {
    if (!CAN_RUN_KERNEL_CONTAINMENT) {
      // On hosts where AppArmor blocks unprivileged userns (e.g. unconfigured Linux CI), verify fail-closed refusal.
      const preflight = await loadPreflightModule();
      await withTempDir(async dir => {
        const { repoRoot } = await createMiniSelfUpgradeRepo(dir);
        const stageDir = join(dir, 'stage-fail-closed');
        await stageAndApplyCandidateUpgrade({
          preflight,
          repoRoot,
          candidateDir: repoRoot,
          stageDir,
        });
        const res = runVerifyScript(repoRoot, {
          SELF_UPGRADE_ALLOW_TEST_FIXTURE: '1',
          SELF_UPGRADE_TEST_NODE_MODULES: join(REPO_ROOT, 'node_modules'),
          SELF_UPGRADE_REPO_ROOT: repoRoot,
          SELF_UPGRADE_STAGE_DIR: stageDir,
        });
        assert.notEqual(res.status, 0);
        assert.equal(res.stderr.includes('failing closed'), true);
      });
      return;
    }

    const preflight = await loadPreflightModule();
    const hostNodeModules = join(REPO_ROOT, 'node_modules');

    // Case A: Disjoint runRoot/.taskpack-canary/secrets.json AND real $HOME canary read attempts -> kernel-denied
    await withTempDir(async dir => {
      const disjointRunRoot = await mkdtemp(join(await realpath(tmpdir()), 'lw-disjoint-runroot-'));
      const homeCanaryPath = join(await realpath(homedir()), `.lw-self-upgrade-home-canary-${randomUUID()}`);
      try {
        const canaryDir = join(disjointRunRoot, '.taskpack-canary');
        await mkdir(canaryDir, { recursive: true, mode: 0o700 });
        const runRootSecretPath = join(canaryDir, 'secrets.json');
        await writeFile(runRootSecretPath, '{"secret":"RUNROOT_TOP_SECRET"}\n', { mode: 0o600 });
        await writeFile(homeCanaryPath, 'HOME_CREDENTIAL_CANARY\n', { mode: 0o600 });

        const secretProbeBody = `import { readFileSync } from 'node:fs';
let blockedCount = 0;
for (const [label, p] of [['runroot', ${JSON.stringify(runRootSecretPath)}], ['home', ${JSON.stringify(homeCanaryPath)}]]) {
  try {
    const leaked = readFileSync(p, 'utf8');
    process.stderr.write('LEAKED_' + label + '=' + leaked + '\\n');
    process.exit(0);
  } catch (err) {
    const code = err && typeof err === 'object' && 'code' in err ? String(err.code) : 'UNKNOWN';
    process.stderr.write('CANARY_ERR_CODE_' + label + '=' + code + '\\n');
    blockedCount += 1;
  }
}
process.exit(blockedCount === 2 ? 42 : 0);
`;
        // Positive uncontained control: reading both files succeeds (exits 0 with LEAKED_runroot)
        const uncontainedRead = spawnSync(process.execPath, ['--input-type=module', '-e', secretProbeBody], {
          encoding: 'utf8',
        });
        assert.equal(uncontainedRead.status, 0);
        assert.equal(uncontainedRead.stderr.includes('LEAKED_runroot='), true);

        const { repoRoot: readEscapeRepo } = await createMiniSelfUpgradeRepo(dir, {
          testScriptBody: secretProbeBody,
        });
        const stageDir = join(dir, 'stage-read');
        await stageAndApplyCandidateUpgrade({
          preflight,
          repoRoot: readEscapeRepo,
          candidateDir: readEscapeRepo,
          stageDir,
        });

        const readEscapeRes = runVerifyScript(readEscapeRepo, {
          SELF_UPGRADE_ALLOW_TEST_FIXTURE: '1',
          SELF_UPGRADE_TEST_NODE_MODULES: hostNodeModules,
          SELF_UPGRADE_REPO_ROOT: readEscapeRepo,
          SELF_UPGRADE_STAGE_DIR: stageDir,
          SELF_UPGRADE_RUN_ROOT: disjointRunRoot,
        });
        assert.notEqual(readEscapeRes.status, 0);
        assert.equal(readEscapeRes.stderr.includes('LEAKED_'), false);
        assert.match(readEscapeRes.stderr, /CANARY_ERR_CODE_runroot=(EPERM|EACCES|ENOENT)/);
        assert.match(readEscapeRes.stderr, /CANARY_ERR_CODE_home=(EPERM|EACCES|ENOENT)/);
      } finally {
        await rm(homeCanaryPath, { force: true });
        await rm(disjointRunRoot, { recursive: true, force: true });
      }
    });

    // Case B: Candidate test attempts to mutate README.md in the base repository checkout -> kernel-denied
    await withTempDir(async dir => {
      const targetPlaceholder = '__BASE_README_TARGET__';
      const { repoRoot: writeEscapeRepo } = await createMiniSelfUpgradeRepo(dir, {
        testScriptBody: `import { writeFileSync } from 'node:fs';
try {
  writeFileSync(${JSON.stringify(targetPlaceholder)}, 'mutated-by-candidate\\n');
  process.stderr.write('CHECKOUT_WRITE_SUCCEEDED\\n');
  process.exit(0);
} catch (err) {
  const code = err && typeof err === 'object' && 'code' in err ? String(err.code) : 'UNKNOWN';
  process.stderr.write('CHECKOUT_WRITE_ERR_CODE=' + code + '\\n');
  process.exit(43);
}
`,
      });
      const realBaseReadme = join(writeEscapeRepo, 'README.md');
      const runTestsPath = join(writeEscapeRepo, 'scripts/run-tests.mjs');
      const updatedRunTests = (await readFile(runTestsPath, 'utf8')).replace(targetPlaceholder, realBaseReadme);
      await writeFile(runTestsPath, updatedRunTests, { mode: 0o600 });
      spawnSync('git', ['add', 'scripts/run-tests.mjs'], { cwd: writeEscapeRepo, stdio: 'ignore' });
      spawnSync('git', ['commit', '-m', 'test: attempt checkout write'], { cwd: writeEscapeRepo, stdio: 'ignore' });

      const stageDir = join(dir, 'stage-write');
      await stageAndApplyCandidateUpgrade({
        preflight,
        repoRoot: writeEscapeRepo,
        candidateDir: writeEscapeRepo,
        stageDir,
      });

      const writeEscapeRes = runVerifyScript(writeEscapeRepo, {
        SELF_UPGRADE_ALLOW_TEST_FIXTURE: '1',
        SELF_UPGRADE_TEST_NODE_MODULES: hostNodeModules,
        SELF_UPGRADE_REPO_ROOT: writeEscapeRepo,
        SELF_UPGRADE_STAGE_DIR: stageDir,
      });
      assert.notEqual(writeEscapeRes.status, 0);
      assert.equal(writeEscapeRes.stderr.includes('CHECKOUT_WRITE_SUCCEEDED'), false);
      assert.match(writeEscapeRes.stderr, /CHECKOUT_WRITE_ERR_CODE=(EPERM|EACCES|EROFS|ENOENT)/);
      assert.equal(await readFile(realBaseReadme, 'utf8'), '# Fixture Loopwright Repo\n');
    });

    // Case C: Candidate CLI during `closure --verify-failures` attempts to overwrite `scripts/run-tests.mjs` -> OS read-only denial (S3)
    await withTempDir(async dir => {
      const { repoRoot: rewriteGateRepo } = await createMiniSelfUpgradeRepo(dir, {
        cliMainBody: `import { writeFileSync } from 'node:fs';
try {
  writeFileSync('scripts/run-tests.mjs', 'process.exit(0);\\n');
  process.stderr.write('GATE_REWRITE_SUCCEEDED\\n');
  process.exit(0);
} catch (err) {
  const code = err && typeof err === 'object' && 'code' in err ? String(err.code) : 'UNKNOWN';
  process.stderr.write('GATE_REWRITE_ERR_CODE=' + code + '\\n');
  process.exit(44);
}
`,
        testScriptBody: `process.exit(99);\n`,
      });
      const stageDir = join(dir, 'stage-gate-rewrite');
      await stageAndApplyCandidateUpgrade({
        preflight,
        repoRoot: rewriteGateRepo,
        candidateDir: rewriteGateRepo,
        stageDir,
      });

      const rewriteRes = runVerifyScript(rewriteGateRepo, {
        SELF_UPGRADE_ALLOW_TEST_FIXTURE: '1',
        SELF_UPGRADE_TEST_NODE_MODULES: hostNodeModules,
        SELF_UPGRADE_REPO_ROOT: rewriteGateRepo,
        SELF_UPGRADE_STAGE_DIR: stageDir,
      });
      assert.notEqual(rewriteRes.status, 0);
      assert.equal(rewriteRes.stderr.includes('GATE_REWRITE_SUCCEEDED'), false);
      assert.match(rewriteRes.stderr, /GATE_REWRITE_ERR_CODE=(EROFS|EPERM|EACCES)/);
    });

    // Case D: Controlled reachable host loopback TCP service -> positive uncontained connect succeeds, contained compile-and-lint connect is kernel-denied (S7 + S11)
    await withTempDir(async dir => {
      let connectionHits = 0;
      const hostLoopbackServer = net.createServer(socket => {
        connectionHits += 1;
        socket.end('HOST_SERVICE_OK');
      });
      await new Promise<void>((resolveListen, rejectListen) => {
        hostLoopbackServer.once('error', rejectListen);
        hostLoopbackServer.listen(0, '127.0.0.1', () => resolveListen());
      });
      try {
        const addr = hostLoopbackServer.address();
        assert.equal(addr !== null && typeof addr === 'object', true);
        const hostPort = (addr as net.AddressInfo).port;

        const tcpProbeBody = `import net from 'node:net';
await new Promise((resolveConn, rejectConn) => {
  const socket = net.connect({ host: '127.0.0.1', port: ${String(hostPort)} });
  socket.setTimeout(2500);
  socket.once('data', chunk => {
    process.stderr.write('HOST_LOOPBACK_CONNECTED=' + chunk.toString('utf8') + '\\n');
    socket.destroy();
    resolveConn(undefined);
  });
  socket.once('timeout', () => {
    socket.destroy();
    process.stderr.write('NET_ERR_CODE=ETIMEDOUT\\n');
    rejectConn(new Error('timeout'));
  });
  socket.once('error', err => {
    const code = err && typeof err === 'object' && 'code' in err ? String(err.code) : 'UNKNOWN';
    process.stderr.write('NET_ERR_CODE=' + code + '\\n');
    rejectConn(err);
  });
});
`;
        // Use async spawn so the parent event loop services hostLoopbackServer in real time
        const spawnAsync = (
          cmd: string,
          args: readonly string[],
          opts: { readonly cwd?: string; readonly env?: NodeJS.ProcessEnv },
        ): Promise<{ readonly status: number | null; readonly stdout: string; readonly stderr: string }> =>
          new Promise((resolveProc, rejectProc) => {
            const child = spawn(cmd, args, {
              cwd: opts.cwd,
              env: opts.env,
              stdio: ['ignore', 'pipe', 'pipe'],
            });
            let out = '';
            let err = '';
            child.stdout.setEncoding('utf8');
            child.stderr.setEncoding('utf8');
            child.stdout.on('data', chunk => { out += String(chunk); });
            child.stderr.on('data', chunk => { err += String(chunk); });
            child.once('error', rejectProc);
            child.once('close', code => resolveProc({ status: code, stdout: out, stderr: err }));
          });

        // Positive uncontained control: connecting to 127.0.0.1:hostPort succeeds and delivers data
        const uncontainedNet = await spawnAsync(
          process.execPath,
          ['--input-type=module', '-e', tcpProbeBody],
          { env: process.env },
        );
        assert.equal(uncontainedNet.status, 0);
        assert.equal(uncontainedNet.stderr.includes('HOST_LOOPBACK_CONNECTED'), true);
        assert.equal(connectionHits, 1);

        connectionHits = 0;
        const { repoRoot: netEscapeRepo } = await createMiniSelfUpgradeRepo(dir, {
          buildScriptBody: tcpProbeBody,
        });
        const stageDir = join(dir, 'stage-net');
        await stageAndApplyCandidateUpgrade({
          preflight,
          repoRoot: netEscapeRepo,
          candidateDir: netEscapeRepo,
          stageDir,
        });

        const verifyPath = join(REPO_ROOT, '.loopwright/checks/verify.sh');
        const netEscapeRes = await spawnAsync(
          '/bin/bash',
          [verifyPath],
          {
            cwd: netEscapeRepo,
            env: {
              PATH: '/usr/local/bin:/usr/bin:/bin',
              NODE_BIN_DIR: dirname(process.execPath),
              HOME: netEscapeRepo,
              TMPDIR: tmpdir(),
              LANG: 'C.UTF-8',
              LC_ALL: 'C.UTF-8',
              LOOPWRIGHT_CANDIDATE_DIR: netEscapeRepo,
              LOOPWRIGHT_CHECK_ID: 'self-upgrade-verify',
              SELF_UPGRADE_ALLOW_TEST_FIXTURE: '1',
              SELF_UPGRADE_TEST_NODE_MODULES: hostNodeModules,
              SELF_UPGRADE_REPO_ROOT: netEscapeRepo,
              SELF_UPGRADE_STAGE_DIR: stageDir,
            },
          },
        );
        assert.notEqual(netEscapeRes.status, 0, 'compile-and-lint stage (network_mode=none) must deny loopback TCP inside OS containment');
        assert.equal(connectionHits, 0, 'contained compile-and-lint candidate must not reach host loopback service');
        assert.equal(netEscapeRes.stderr.includes('HOST_LOOPBACK_CONNECTED'), false);
        assert.match(netEscapeRes.stderr, /NET_ERR_CODE=(EPERM|EACCES|ECONNREFUSED|ENETUNREACH)/);
      } finally {
        await new Promise<void>(resolveClose => hostLoopbackServer.close(() => resolveClose()));
      }
    });

    // Case E: Separate host Node process carrying a secret environment canary -> positive uncontained
    // inspection/signaling succeeds, while contained verify.sh execution is kernel-denied (KERN_PROCARGS2 / /proc & kill)
    await withTempDir(async dir => {
      const hostCanarySecret = `HOST_PROC_CANARY_${randomUUID()}`;
      const hostVictim = spawn(
        process.execPath,
        ['-e', 'process.stdout.write("READY\\n"); setInterval(() => {}, 1000);'],
        {
          env: {
            ...process.env,
            HOST_SECRET_ENV_CANARY: hostCanarySecret,
          },
          stdio: ['ignore', 'pipe', 'ignore'],
        },
      );
      await new Promise<void>((resolveReady, rejectReady) => {
        hostVictim.once('error', rejectReady);
        hostVictim.stdout.once('data', () => resolveReady());
      });

      try {
        const victimPid = hostVictim.pid;
        assert.equal(typeof victimPid === 'number' && victimPid > 0, true);

        const procProbeBody = `import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
const targetPid = ${String(victimPid)};
const expectedSecret = ${JSON.stringify(hostCanarySecret)};
let signalAllowed = false;
let signalCode = 'NONE';
try {
  process.kill(targetPid, 0);
  signalAllowed = true;
} catch (err) {
  signalCode = err && typeof err === 'object' && 'code' in err ? String(err.code) : 'ERR';
}

let leakedEnv = false;
if (process.platform === 'darwin') {
  const pyProbe = [
    'import ctypes, sys',
    'pid = int(sys.argv[1])',
    'secret = sys.argv[2].encode("utf-8")',
    'libc = ctypes.CDLL("/usr/lib/libSystem.B.dylib", use_errno=True)',
    'mib = (ctypes.c_int * 3)(1, 49, pid)',
    'size = ctypes.c_size_t(0)',
    'rc = libc.sysctl(mib, 3, None, ctypes.byref(size), None, 0)',
    'if rc == 0 and size.value > 0:',
    '    buf = ctypes.create_string_buffer(size.value)',
    '    rc2 = libc.sysctl(mib, 3, buf, ctypes.byref(size), None, 0)',
    '    if rc2 == 0 and secret in buf.raw:',
    '        print("PROCARGS2_LEAKED")',
    '        sys.exit(0)',
    'print(f"PROCARGS2_DENIED_ERRNO={ctypes.get_errno()}")',
    'sys.exit(1)',
  ].join('\\n');
  const py = spawnSync('/usr/bin/python3', ['-c', pyProbe, String(targetPid), expectedSecret], { encoding: 'utf8' });
  if ((py.stdout || '').includes('PROCARGS2_LEAKED')) {
    leakedEnv = true;
  } else {
    process.stderr.write('PROC_INSPECT_OUT=' + (py.stdout || '').trim() + '\\n');
  }
} else if (process.platform === 'linux') {
  try {
    const raw = readFileSync('/proc/' + String(targetPid) + '/environ');
    if (raw.includes(Buffer.from(expectedSecret, 'utf8'))) {
      leakedEnv = true;
    }
  } catch (err) {
    const code = err && typeof err === 'object' && 'code' in err ? String(err.code) : 'ERR';
    process.stderr.write('PROC_INSPECT_OUT=' + code + '\\n');
  }
}

process.stderr.write('SIGNAL_ALLOWED=' + String(signalAllowed) + ' SIGNAL_CODE=' + signalCode + ' LEAKED_ENV=' + String(leakedEnv) + '\\n');
if (signalAllowed || leakedEnv) {
  process.exit(0);
}
process.exit(45);
`;

        // Positive uncontained control: inspecting and signaling hostVictim succeeds
        const uncontainedProc = spawnSync(process.execPath, ['--input-type=module', '-e', procProbeBody], {
          encoding: 'utf8',
        });
        assert.equal(uncontainedProc.status, 0, `expected uncontained host-process probe to succeed: ${uncontainedProc.stderr}`);
        assert.equal(uncontainedProc.stderr.includes('SIGNAL_ALLOWED=true'), true);
        assert.equal(uncontainedProc.stderr.includes('LEAKED_ENV=true'), true);

        const { repoRoot: procEscapeRepo } = await createMiniSelfUpgradeRepo(dir, {
          testScriptBody: procProbeBody,
        });
        const stageDir = join(dir, 'stage-proc-isolation');
        await stageAndApplyCandidateUpgrade({
          preflight,
          repoRoot: procEscapeRepo,
          candidateDir: procEscapeRepo,
          stageDir,
        });

        const procEscapeRes = runVerifyScript(procEscapeRepo, {
          SELF_UPGRADE_ALLOW_TEST_FIXTURE: '1',
          SELF_UPGRADE_TEST_NODE_MODULES: hostNodeModules,
          SELF_UPGRADE_REPO_ROOT: procEscapeRepo,
          SELF_UPGRADE_STAGE_DIR: stageDir,
        });
        assert.notEqual(procEscapeRes.status, 0, 'contained candidate must be denied cross-process inspection and signaling');
        assert.equal(procEscapeRes.stderr.includes('LEAKED_ENV=true'), false);
        assert.equal(procEscapeRes.stderr.includes('SIGNAL_ALLOWED=true'), false);
        assert.match(procEscapeRes.stderr, /SIGNAL_CODE=(EPERM|ESRCH)/);
        assert.equal(hostVictim.exitCode, null, 'host victim process must remain alive');
      } finally {
        hostVictim.kill('SIGKILL');
      }
    });
  });

  it('completes end-to-end loopwright step next + step submit + inspect in no-change and candidate modes while keeping base repo clean', async () => {
    const preflight = await loadPreflightModule();
    const cliMainPath = join(REPO_ROOT, 'packages/cli/dist/main.js');
    const hostNodeModules = join(REPO_ROOT, 'node_modules');

    await withTempDir(async dir => {
      const { repoRoot } = await createMiniSelfUpgradeRepo(dir);
      const runRoot = join(dir, 'runs');
      await mkdir(runRoot, { recursive: true, mode: 0o700 });

      // 1) --mode no-change settles no_change via no-change.v1
      const noChangePrep = await preflight.runPrepareSelfUpgrade({
        repoRoot,
        stageDir: join(dir, 'stage-no-change'),
        registryFixtures: Object.fromEntries(
          preflight.ALL_UPSTREAM_IDS.map(id => [
            id,
            { version: id === 'yaml' ? '2.9.0' : '1.5.0' },
          ]),
        ),
      });
      assert.equal(noChangePrep.recommendedMode, 'no-change');

      const stagedNoChange = await stageTaskpackForStep({
        taskpackPath: '.loopwright/taskpack.yaml',
        repositoryRoot: repoRoot,
        runRoot,
        runId: 'self-upgrade-no-change-01',
        mode: 'no-change',
        discoverUpstreams: false,
        upstreamRecordsJson: JSON.stringify(noChangePrep.upstreamRecords),
      });
      const loadedNoChange = await loadTrustedConfiguration({
        configPath: stagedNoChange.configPath,
        registryPath: stagedNoChange.registryPath,
        registrySha256: stagedNoChange.registrySha256,
        untrustedRoots: [repoRoot],
      });
      assert.equal(loadedNoChange.ok, true);
      if (!loadedNoChange.ok) return;

      const nextNoChange = await stepNext({
        configuration: loadedNoChange.value,
        repository: repoRoot,
        runRoot,
        runId: 'self-upgrade-no-change-01',
        mode: 'no-change',
      });
      assert.equal(nextNoChange.ok, true);
      if (!nextNoChange.ok || nextNoChange.value.kind !== 'step') {
        assert.fail('expected step yield in no-change mode');
      }

      const submitNoChange = spawnSync(
        process.execPath,
        [
          cliMainPath,
          'step',
          'submit',
          '--run-root',
          runRoot,
          '--run-id',
          'self-upgrade-no-change-01',
          '--lease',
          nextNoChange.value.leaseToken,
          '--status',
          'no_change',
          '--reason',
          'All runtime dependencies match baseline.',
          '--json',
        ],
        {
          cwd: repoRoot,
          env: {
            ...process.env,
            NODE_BIN_DIR: dirname(process.execPath),
            SELF_UPGRADE_REPO_ROOT: repoRoot,
          },
          encoding: 'utf8',
          timeout: 60_000,
        },
      );
      assert.equal(submitNoChange.status, 0, `no-change submit failed: ${submitNoChange.stderr}`);
      const parsedNoChange = JSON.parse(submitNoChange.stdout.trim()) as {
        kind: string;
        data?: { result?: { spec?: { status?: string } } };
      };
      assert.equal(parsedNoChange.kind, 'result');
      assert.equal(parsedNoChange.data?.result?.spec?.status, 'no_change');

      // 2) --mode candidate applies staged upgrade INSIDE yielded candidateDir (leaving repoRoot clean!)
      const stageDir = join(dir, 'stage-candidate');
      const candidatePrep = await preflight.runPrepareSelfUpgrade({
        repoRoot,
        stageDir,
        registryFixtures: Object.fromEntries(
          preflight.ALL_UPSTREAM_IDS.map(id => [
            id,
            { version: id === 'yaml' ? '2.10.0' : '1.6.0' },
          ]),
        ),
        lockfileBuilder: async ({ targetVersions }) => Buffer.from(
          buildSyntheticLockfile({
            piVersion: targetVersions.upstreams['pi-coding-agent']!.version,
            yamlVersion: targetVersions.upstreams['yaml']!.version,
            nestedPiTransitiveYamlVersion: '2.9.0',
          }),
          'utf8',
        ),
      });
      assert.equal(candidatePrep.recommendedMode, 'candidate');
      assert.notEqual(candidatePrep.staged, null);

      const stagedCandidate = await stageTaskpackForStep({
        taskpackPath: '.loopwright/taskpack.yaml',
        repositoryRoot: repoRoot,
        runRoot,
        runId: 'self-upgrade-candidate-01',
        mode: 'candidate',
        discoverUpstreams: false,
        upstreamRecordsJson: JSON.stringify(candidatePrep.upstreamRecords),
      });

      const gateHandle = await openStagedTaskpackStepGate({
        runRoot,
        runId: 'self-upgrade-candidate-01',
      });
      assert.notEqual(gateHandle, null);
      if (gateHandle === null) return;

      let candidateLeaseToken: string;
      let yieldedCandidateDir: string;
      try {
        const prevGateSecret = process.env[DEFAULT_LOCAL_COMMAND_GATE_ENV];
        process.env[DEFAULT_LOCAL_COMMAND_GATE_ENV] = gateHandle.environment(DEFAULT_LOCAL_COMMAND_GATE_ENV);
        try {
          const loadedCandidate = await loadTrustedConfiguration({
            configPath: stagedCandidate.configPath,
            registryPath: stagedCandidate.registryPath,
            registrySha256: stagedCandidate.registrySha256,
            untrustedRoots: [repoRoot],
          });
          assert.equal(loadedCandidate.ok, true);
          if (!loadedCandidate.ok) return;

          const nextCandidate = await stepNext(
            {
              configuration: loadedCandidate.value,
              repository: repoRoot,
              runRoot,
              runId: 'self-upgrade-candidate-01',
              mode: 'candidate',
              environment: gateHandle.environment,
            },
            { gateUrlOverrides: gateHandle.gateUrlOverrides },
          );
          assert.equal(nextCandidate.ok, true);
          if (!nextCandidate.ok || nextCandidate.value.kind !== 'step') {
            assert.fail('expected step yield in candidate mode');
          }
          candidateLeaseToken = nextCandidate.value.leaseToken;
          yieldedCandidateDir = nextCandidate.value.candidateDir;
        } finally {
          if (prevGateSecret === undefined) {
            delete process.env[DEFAULT_LOCAL_COMMAND_GATE_ENV];
          } else {
            process.env[DEFAULT_LOCAL_COMMAND_GATE_ENV] = prevGateSecret;
          }
        }
      } finally {
        await gateHandle.close();
      }

      // Apply staged target-versions.json and package-lock.candidate.json ONLY inside yieldedCandidateDir
      const stagedTargetRaw = await readFile(candidatePrep.staged!.targetVersionsPath, 'utf8');
      const stagedTarget = JSON.parse(stagedTargetRaw) as TargetVersionsPayload;
      const stagedLockRaw = await readFile(candidatePrep.staged!.candidateLockPath);

      await writeFile(join(yieldedCandidateDir, '.loopwright/proposal.json'), stagedTargetRaw, { mode: 0o600 });
      await writeFile(join(yieldedCandidateDir, 'package-lock.json'), stagedLockRaw, { mode: 0o600 });
      for (const [ws, depUpdates] of Object.entries(stagedTarget.packages)) {
        const wsManifestPath = join(yieldedCandidateDir, ws, 'package.json');
        const wsManifest = JSON.parse(await readFile(wsManifestPath, 'utf8')) as {
          dependencies: Record<string, string>;
        };
        wsManifest.dependencies = { ...wsManifest.dependencies, ...depUpdates };
        await writeFile(wsManifestPath, `${JSON.stringify(wsManifest, null, 2)}\n`, { mode: 0o600 });
      }

      const submitCandidate = spawnSync(
        process.execPath,
        [
          cliMainPath,
          'step',
          'submit',
          '--run-root',
          runRoot,
          '--run-id',
          'self-upgrade-candidate-01',
          '--lease',
          candidateLeaseToken,
          '--status',
          'completed',
          '--reason',
          'Upgraded @earendil-works/pi-* to 1.6.0 and yaml to 2.10.0.',
          '--json',
        ],
        {
          cwd: repoRoot,
          env: {
            ...process.env,
            GITHUB_ACTIONS: '',
            NODE_BIN_DIR: dirname(process.execPath),
            SELF_UPGRADE_RUN_ROOT: runRoot,
            SELF_UPGRADE_STAGE_DIR: candidatePrep.staged!.stageDir,
            SELF_UPGRADE_NPM_CACHE: candidatePrep.staged!.npmCacheDir,
            SELF_UPGRADE_REPO_ROOT: repoRoot,
            SELF_UPGRADE_ALLOW_TEST_FIXTURE: '1',
            SELF_UPGRADE_TEST_NODE_MODULES: hostNodeModules,
          },
          encoding: 'utf8',
          timeout: 120_000,
        },
      );

      if (!CAN_RUN_KERNEL_CONTAINMENT) {
        // Without kernel containment (e.g. AppArmor-restricted Linux CI), command.v1 fails closed.
        assert.notEqual(submitCandidate.status, 0);
        return;
      }

      assert.equal(
        submitCandidate.status,
        0,
        `candidate submit failed (stdout=${submitCandidate.stdout}, stderr=${submitCandidate.stderr})`,
      );
      const parsedCandidate = JSON.parse(submitCandidate.stdout.trim()) as {
        kind: string;
        data?: { result?: { spec?: { status?: string } } };
      };
      assert.equal(parsedCandidate.kind, 'result');
      assert.equal(parsedCandidate.data?.result?.spec?.status, 'completed');

      // Base repository checkout must remain 100% clean and at baseline 1.5.0 / 2.9.0
      const baseGitStatus = spawnSync(
        'git',
        ['status', '--porcelain', '-z', '--untracked-files=all'],
        { cwd: repoRoot, encoding: 'utf8' },
      );
      assert.equal(baseGitStatus.stdout, '');
      const baseProposal = JSON.parse(await readFile(join(repoRoot, '.loopwright/proposal.json'), 'utf8')) as TargetVersionsPayload;
      assert.equal(baseProposal.upstreams['pi-coding-agent']?.version, '1.5.0');
      assert.equal(baseProposal.upstreams['yaml']?.version, '2.9.0');

      // Export inspect bundle and verify captured candidate.files.json contains the upgraded versions
      const inspectDir = join(dir, 'inspect-bundle');
      const inspectRun = spawnSync(
        process.execPath,
        [
          cliMainPath,
          'inspect',
          '--run-root',
          runRoot,
          '--run-id',
          'self-upgrade-candidate-01',
          '--output',
          inspectDir,
          '--json',
        ],
        { cwd: repoRoot, encoding: 'utf8', timeout: 30_000 },
      );
      assert.equal(inspectRun.status, 0, `inspect failed: ${inspectRun.stderr}`);

      const exportedBundle = JSON.parse(await readFile(join(inspectDir, 'candidate.files.json'), 'utf8')) as {
        files: readonly { name: string; encoding: string; body: string }[];
      };
      const decodeExportedJson = (name: string): Record<string, unknown> => {
        const entry = exportedBundle.files.find(f => f.name === name);
        assert.notEqual(entry, undefined, `expected ${name} in candidate.files.json`);
        assert.equal(entry!.encoding, 'base64');
        return JSON.parse(Buffer.from(entry!.body, 'base64').toString('utf8')) as Record<string, unknown>;
      };

      const exportedProposal = decodeExportedJson('.loopwright/proposal.json') as unknown as TargetVersionsPayload;
      assert.equal(exportedProposal.upstreams['pi-coding-agent']?.version, '1.6.0');
      assert.equal(exportedProposal.upstreams['yaml']?.version, '2.10.0');

      const exportedAgentPi = decodeExportedJson('packages/agent-pi/package.json') as {
        dependencies: Record<string, string>;
      };
      assert.equal(exportedAgentPi.dependencies['@earendil-works/pi-coding-agent'], '1.6.0');
      assert.equal(exportedAgentPi.dependencies['@earendil-works/pi-tui'], '1.6.0');

      const exportedCli = decodeExportedJson('packages/cli/package.json') as {
        dependencies: Record<string, string>;
      };
      assert.equal(exportedCli.dependencies['yaml'], '2.10.0');

      const exportedLock = decodeExportedJson('package-lock.json') as {
        packages: Record<string, { version?: string }>;
      };
      assert.equal(exportedLock.packages['node_modules/yaml']?.version, '2.10.0');
      assert.equal(exportedLock.packages['node_modules/@earendil-works/pi-coding-agent']?.version, '1.6.0');
    });
  });

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

      // 2) Named FIFO at .loopwright/proposal.json fails fast without blocking open()
      const proposalPath = join(repoRoot, '.loopwright/proposal.json');
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
          SELF_UPGRADE_STAGE_DIR: stageWithHardlink,
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

      // Refuse --offline-check combined with --github-output so synthetic smoke checks cannot feed workflows
      const ghOutRefused = spawnSync(
        process.execPath,
        [
          join(REPO_ROOT, 'scripts/prepare-self-upgrade.mjs'),
          '--repo',
          repoRoot,
          '--offline-check',
          '--github-output',
          join(dir, 'gh-output.txt'),
        ],
        { encoding: 'utf8' },
      );
      assert.notEqual(ghOutRefused.status, 0);
      assert.equal(ghOutRefused.stderr.includes('Refusing --github-output with --offline-check'), true);
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
      if (!CAN_RUN_KERNEL_CONTAINMENT) {
        return;
      }
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

      await preflight.stageCandidateBundle({
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

      await writeFile(join(repoRoot, '.loopwright/proposal.json'), `${JSON.stringify(targetVersions, null, 2)}\n`, { mode: 0o600 });
      await writeFile(join(repoRoot, 'package-lock.json'), offlineLockBytes, { mode: 0o600 });
      for (const [ws, depUpdates] of Object.entries(targetVersions.packages)) {
        const wsManifestPath = join(repoRoot, ws, 'package.json');
        const wsManifest = JSON.parse(await readFile(wsManifestPath, 'utf8')) as { dependencies: Record<string, string> };
        wsManifest.dependencies = { ...wsManifest.dependencies, ...depUpdates };
        await writeFile(wsManifestPath, `${JSON.stringify(wsManifest, null, 2)}\n`, { mode: 0o600 });
      }

      // Execute verify.sh with ZERO SELF_UPGRADE_TEST_NODE_MODULES bypass AND /usr/bin/python3 when present
      const realOfflineRes = runVerifyScript(repoRoot, {
        SELF_UPGRADE_REPO_ROOT: repoRoot,
        SELF_UPGRADE_STAGE_DIR: realOfflineStage,
        PYTHON_BIN: existsSync('/usr/bin/python3') ? '/usr/bin/python3' : undefined,
      });
      assert.equal(
        realOfflineRes.status,
        0,
        `expected full offline verify.sh (without SELF_UPGRADE_TEST_NODE_MODULES) to succeed: ${realOfflineRes.stderr}`,
      );
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

    // 1) Workflow contract: issue_comment fetches +refs/pull/<n>/head without checking out PR head
    const workflowRaw = await readFile(join(REPO_ROOT, '.github/workflows/self-upgrade.yml'), 'utf8');
    assert.equal(workflowRaw.includes('Fetch pull request commit object without checkout'), true);
    assert.equal(
      workflowRaw.includes('+refs/pull/${PR_NUMBER}/head:refs/remotes/origin/pr/${PR_NUMBER}'),
      true,
    );

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
      execGit(dir, ['clone', '--quiet', originBare, forkWork]);
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
              head: { ref: 'loopwright-self-upgrade/main', sha: forkHeadSha },
            }),
            { status: 200, headers: { 'content-type': 'application/json' } },
          );
        }
        return new Response('not found', { status: 404 });
      };

      const commentPayload = {
        action: 'created',
        issue: { number: 77, pull_request: { url: 'https://api.github.com/repos/gpustack/loopwright/pulls/77' } },
        comment: { body: '/loopwright retry', author_association: 'COLLABORATOR' },
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

      const manifest = await loadDeclarativeTaskpack({
        manifestPath: '.loopwright/taskpack.yaml',
        repositoryRoot: runnerCheckout,
      });
      const compiledFork = await compileDeclarativeTaskpack(manifest, {
        mode: 'candidate',
        executionMode: 'delegated',
        repository: 'gpustack/loopwright',
        baseRevision: resolved.baseRevision,
        sourceRevision: resolved.sourceRevision,
        repositoryRoot: runnerCheckout,
        taskpackPath: '.loopwright/taskpack.yaml',
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

      const privateIntRes = runVerifyScript(repoRoot, {
        SELF_UPGRADE_ALLOW_TEST_FIXTURE: '1',
        SELF_UPGRADE_TEST_NODE_MODULES: hostNodeModules,
        SELF_UPGRADE_REPO_ROOT: repoRoot,
        SELF_UPGRADE_STAGE_DIR: stageDir,
      });
      assert.notEqual(privateIntRes.status, 0);
      assert.equal(privateIntRes.stderr.includes("field 'private' must not be modified"), true);
      assert.equal(privateIntRes.stderr.includes('CANDIDATE_BUILD_EXECUTED_CANARY'), false);
      await writeFile(cliPkgPath, goodCliRaw, { mode: 0o600 });

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
        SELF_UPGRADE_STAGE_DIR: stageDir,
      });
      assert.notEqual(unmanagedIntRes.status, 0);
      assert.equal(
        unmanagedIntRes.stderr.includes('protected file') || unmanagedIntRes.stderr.includes('unmanaged manifest'),
        true,
      );
      await writeFile(corePkgPath, goodCoreRaw, { mode: 0o600 });

      // Proposal "schema_version": true rejected
      const proposalPath = join(repoRoot, '.loopwright/proposal.json');
      const goodProposalRaw = await readFile(proposalPath, 'utf8');
      const boolSchemaProposal = JSON.parse(goodProposalRaw) as Record<string, unknown>;
      boolSchemaProposal['schema_version'] = true;
      await writeFile(proposalPath, `${JSON.stringify(boolSchemaProposal, null, 2)}\n`, { mode: 0o600 });
      const boolSchemaRes = runVerifyScript(repoRoot, {
        SELF_UPGRADE_ALLOW_TEST_FIXTURE: '1',
        SELF_UPGRADE_TEST_NODE_MODULES: hostNodeModules,
        SELF_UPGRADE_REPO_ROOT: repoRoot,
        SELF_UPGRADE_STAGE_DIR: stageDir,
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
        SELF_UPGRADE_STAGE_DIR: stageDir,
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
        SELF_UPGRADE_STAGE_DIR: stageDir,
      });
      assert.notEqual(extraTsconfigRes.status, 0);
      assert.equal(extraTsconfigRes.stderr.includes('tsconfig*.json'), true);
      assert.equal(extraTsconfigRes.stderr.includes('CANDIDATE_BUILD_EXECUTED_CANARY'), false);
      await unlink(extraTsconfigPath);
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
        SELF_UPGRADE_STAGE_DIR: stageDir,
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
              [join(REPO_ROOT, '.loopwright/checks/verify.sh')],
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
                  SELF_UPGRADE_STAGE_DIR: stageDir,
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
