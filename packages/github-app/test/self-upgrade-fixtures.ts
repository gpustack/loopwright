import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import zlib from 'node:zlib';
import {
  loadDeclarativeTaskpack,
  type TaskpackUpstreamRecord,
} from '../src/index.js';

const THIS_DIR = dirname(fileURLToPath(import.meta.url));
// Works identically from packages/github-app/test/*.ts and .test-build/packages/github-app/test/*.js
export const REPO_ROOT = existsSync(resolve(THIS_DIR, '../../../.loopwright/taskpack.yaml'))
  ? resolve(THIS_DIR, '../../..')
  : resolve(THIS_DIR, '../../../..');

export const CAN_RUN_KERNEL_CONTAINMENT = (() => {
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

export interface TargetVersionsPayload {
  readonly schema_version: number;
  readonly summary: string;
  readonly upstreams: Readonly<Record<string, { readonly package: string; readonly version: string }>>;
  readonly packages: Readonly<Record<string, Readonly<Record<string, string>>>>;
}

export interface EligibilityResult {
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

export interface BaselineParityResult {
  readonly baselineByUpstream: Readonly<Record<string, string>>;
  readonly piBaseline: string;
  readonly yamlBaseline: string;
  readonly lockfileBytes: number;
}

export interface StageResult {
  readonly stageDir: string;
  readonly targetVersionsPath: string;
  readonly candidateLockPath: string;
  readonly npmCacheDir: string;
  readonly candidateLockBytes: number;
}

export interface PrepareSelfUpgradeRunResult {
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

export interface PrepareSelfUpgradeModule {
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
  readonly resolveSelfUpgradeModelConfig: (options?: {
    readonly env?: Readonly<Record<string, string | undefined>> | undefined;
    readonly modelsOutPath?: string | undefined;
  }) => Promise<{
    readonly configured: boolean;
    readonly modelProvider: string;
    readonly modelId: string;
    readonly modelThinking: string;
    readonly modelApi: string;
    readonly modelBaseUrl: string;
    readonly modelsJsonPath: string;
    readonly allowCustomBaseUrl: string;
    readonly providerTokenEnv: string;
  }>;
}

export async function loadPreflightModule(): Promise<PrepareSelfUpgradeModule> {
  const scriptUrl = pathToFileURL(join(REPO_ROOT, 'scripts/prepare-self-upgrade.mjs')).href;
  return (await import(scriptUrl)) as PrepareSelfUpgradeModule;
}

export async function withTempDir(run: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(await realpath(tmpdir()), 'lw-self-upgrade-test-'));
  await chmod(dir, 0o700);
  try {
    await run(dir);
  } finally {
    spawnSync('chmod', ['-R', 'u+w', dir], { stdio: 'ignore' });
    await rm(dir, { recursive: true, force: true });
  }
}

export const PI_PACKAGE_NAMES = [
  '@earendil-works/pi-agent-core',
  '@earendil-works/pi-ai',
  '@earendil-works/pi-codemode',
  '@earendil-works/pi-coding-agent',
  '@earendil-works/pi-mcp',
  '@earendil-works/pi-tui',
] as const;

export const ALL_WORKSPACES = [
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

export function fakeIntegrity(label: string): string {
  return `sha512-${createHash('sha512').update(label, 'utf8').digest('base64')}`;
}

export function buildUstarTgzBuffer(
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

export function buildSyntheticLockfile(options: {
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

export async function createMiniSelfUpgradeRepo(
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
    options?.buildScriptBody ?? `import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
${sideEffectSnippet}if (existsSync('packages/agent-pi/src/index.ts')) {
  await import(pathToFileURL(resolve('packages/agent-pi/src/index.ts')).href);
}
mkdirSync('packages/cli/dist', { recursive: true });
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

export async function stageAndApplyCandidateUpgrade(options: {
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

export function runVerifyScript(
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
