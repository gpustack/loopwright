import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { link, mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  checkTaskpackSuite,
  compileDeclarativeTaskpack,
  computeTaskpackDigests,
  DEFAULT_HOST_BUDGETS,
  DEFAULT_TASKPACK_SUITE_PATH,
  headBranchPrefixesCollide,
  loadTaskpackSuite,
  matchSuitePullRequestDomain,
  MAX_SUITE_STAGE_VERSION_BLOB_BYTES,
  parseSuiteCommentCommand,
  parseTaskpackSuiteManifest,
  readGitRevisionVersionFrom,
  resolveTaskpackSuite,
  SecretScrubber,
  TASKPACK_SUITE_MANIFEST_BYTES,
  TaskpackError,
  validateRfc6901JsonPointer,
  validateTaskpackSuite,
  validateTaskpackSuiteManifest,
  writeDigestLockfile,
  type Json,
} from '../src/index.js';

const THIS_DIR = dirname(fileURLToPath(import.meta.url));
const TASKPACK_SRC_DIR = resolve(THIS_DIR, '../../../../packages/taskpack/src');

async function withTempDir(run: (root: string, outside: string) => Promise<void>): Promise<void> {
  const base = await mkdtemp(join(tmpdir(), 'lw-tp-suite-'));
  const root = join(base, 'repo');
  const outside = join(base, 'outside');
  await mkdir(root, { recursive: true });
  await mkdir(outside, { recursive: true });
  try {
    await run(root, outside);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
}

function git(cwd: string, args: readonly string[]): string {
  return execFileSync('git', args, {
    cwd,
    env: {
      PATH: process.env['PATH'] ?? '/usr/local/bin:/usr/bin:/bin',
      HOME: '/nonexistent',
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_AUTHOR_NAME: 'Test Bot',
      GIT_AUTHOR_EMAIL: 'bot@example.test',
      GIT_COMMITTER_NAME: 'Test Bot',
      GIT_COMMITTER_EMAIL: 'bot@example.test',
    },
    encoding: 'utf8',
  }).trim();
}

function initGitRepo(repoRoot: string, defaultBranch = 'main'): void {
  git(repoRoot, ['init', '-b', defaultBranch]);
}

function domainManifestYaml(options: {
  readonly name: string;
  readonly writable: readonly string[];
  readonly protectedPaths?: readonly string[];
  readonly instructions?: readonly string[];
  readonly skills?: readonly string[];
  readonly proposalPath?: string;
  readonly localChecks?: readonly { readonly id: string; readonly implementation: string }[];
  readonly pinDigests?: boolean;
  readonly publication?: {
    readonly mode: 'pull_request' | 'disabled';
    readonly targetBranch?: string;
    readonly headBranchPrefix?: string;
    readonly titleTemplate?: string;
  };
  readonly triggers?: {
    readonly schedule?: boolean;
    readonly workflowDispatch?: boolean;
    readonly commentCommands?: readonly string[];
    readonly commentPrefixes?: readonly string[];
  };
}): string {
  const lines: string[] = [
    'apiVersion: loopwright.dev/v1alpha1',
    'kind: Taskpack',
    'metadata:',
    `  name: ${options.name}`,
    'spec:',
  ];
  if (options.pinDigests === true) {
    lines.push('  execution:');
    lines.push('    mode: strict');
    lines.push('    digests:');
    lines.push('      pinDigests: true');
  }
  lines.push(
    '  goal:',
    `    candidate: Update ${options.name}.`,
    `    noChange: Confirm ${options.name} is up to date.`,
    '  scope:',
    '    writable:',
    ...options.writable.map(item => `      - "${item}"`),
    `    protected: [${(options.protectedPaths ?? []).map(p => `"${p}"`).join(', ')}]`,
  );
  if (options.instructions !== undefined && options.instructions.length > 0) {
    lines.push('  instructions:');
    for (const item of options.instructions) lines.push(`    - "${item}"`);
  }
  if (options.skills !== undefined && options.skills.length > 0) {
    lines.push('  skills:');
    for (const item of options.skills) lines.push(`    - "${item}"`);
  }
  if (options.proposalPath !== undefined) {
    lines.push('  proposal:');
    lines.push(`    path: "${options.proposalPath}"`);
    lines.push('    requiredFields: [version]');
    lines.push('    schemaVersion: 1');
  }
  lines.push('  verification:');
  if (options.localChecks !== undefined && options.localChecks.length > 0) {
    lines.push('    localChecks:');
    for (const c of options.localChecks) {
      lines.push(`      - id: ${c.id}`);
      lines.push(`        implementation: ${c.implementation}`);
    }
  } else {
    lines.push('    localChecks: []');
  }
  lines.push('    externalGates: []');
  if (options.publication !== undefined) {
    lines.push('  publication:');
    lines.push(`    mode: ${options.publication.mode}`);
    if (options.publication.targetBranch !== undefined) {
      lines.push(`    targetBranch: "${options.publication.targetBranch}"`);
    }
    if (options.publication.headBranchPrefix !== undefined) {
      lines.push(`    headBranchPrefix: "${options.publication.headBranchPrefix}"`);
    }
    if (options.publication.titleTemplate !== undefined) {
      lines.push(`    titleTemplate: "${options.publication.titleTemplate}"`);
    }
  }
  if (options.triggers !== undefined) {
    lines.push('  triggers:');
    lines.push(`    schedule: ${options.triggers.schedule ?? true}`);
    lines.push(`    workflowDispatch: ${options.triggers.workflowDispatch ?? true}`);
    lines.push('    releasePublished: false');
    const cmds = options.triggers.commentCommands ?? ['retry', 'revise', 'status'];
    lines.push(`    commentCommands: [${cmds.join(', ')}]`);
    if (options.triggers.commentPrefixes !== undefined) {
      lines.push(`    commentPrefixes: [${options.triggers.commentPrefixes.map(p => `"${p}"`).join(', ')}]`);
    }
  }
  return `${lines.join('\n')}\n`;
}

describe('suite.ts: boundary and import hygiene', () => {
  it('maintains zero @loopwright/github-app imports across packages/taskpack/src/**', async () => {
    const entries = await readdir(TASKPACK_SRC_DIR, { withFileTypes: true });
    const tsFiles = entries.filter(e => e.isFile() && e.name.endsWith('.ts')).map(e => e.name);
    assert.equal(tsFiles.includes('suite.ts'), true, 'expected packages/taskpack/src/suite.ts to exist');
    const forbiddenImportRe = /(?:from\s+['"]@loopwright\/github-app(?:\/[^'"]*)?['"]|import\s*\(\s*['"]@loopwright\/github-app(?:\/[^'"]*)?['"]\s*\))/;
    for (const fileName of tsFiles) {
      const content = await readFile(join(TASKPACK_SRC_DIR, fileName), 'utf8');
      assert.equal(
        forbiddenImportRe.test(content),
        false,
        `forbidden @loopwright/github-app import in packages/taskpack/src/${fileName}`,
      );
    }
  });
});

describe('suite.ts: TaskpackSuite schema, bounds, null-prototype records, and O_NOFOLLOW loading', () => {
  it('validates 1..32 domains, acyclic stages, RFC 6901 pointers, and null-prototype objects', async () => {
    assert.equal(DEFAULT_TASKPACK_SUITE_PATH, '.loopwright/suite.yaml');
    assert.equal(TASKPACK_SUITE_MANIFEST_BYTES, 65_536);

    // Null-prototype object tree at every level
    const nullRoot = Object.assign(Object.create(null) as Record<string, unknown>, {
      apiVersion: 'loopwright.dev/v1alpha1',
      kind: 'TaskpackSuite',
      metadata: Object.assign(Object.create(null) as Record<string, unknown>, { name: 'mono-suite' }),
      spec: Object.assign(Object.create(null) as Record<string, unknown>, {
        domains: [
          Object.assign(Object.create(null) as Record<string, unknown>, {
            id: 'core',
            taskpack: '.loopwright/core/taskpack.yaml',
            schedules: ['nightly', '0 3 * * *'],
            stage: 'stage-a',
            matrix: Object.assign(Object.create(null) as Record<string, unknown>, { runner: 'ubuntu-latest', shard: 1, fast: true }),
          }),
          Object.assign(Object.create(null) as Record<string, unknown>, {
            id: 'consumer',
            taskpack: '.loopwright/consumer/taskpack.yaml',
            enabled: true,
            stage: 'stage-b',
          }),
        ],
        stages: [
          Object.assign(Object.create(null) as Record<string, unknown>, {
            id: 'stage-a',
          }),
          Object.assign(Object.create(null) as Record<string, unknown>, {
            id: 'stage-b',
            dependsOn: ['stage-a'],
            readiness: [
              Object.assign(Object.create(null) as Record<string, unknown>, {
                kind: 'github-release',
                source: 'octo/core-pkg',
                versionFrom: Object.assign(Object.create(null) as Record<string, unknown>, {
                  domain: 'core',
                  path: 'packages/core/package.json',
                  jsonPointer: '/version',
                }),
              }),
            ],
          }),
        ],
      }),
    });

    const validated = validateTaskpackSuiteManifest(nullRoot as unknown as Json);
    assert.equal(validated.metadata.name, 'mono-suite');
    assert.equal(validated.spec.domains.length, 2);
    assert.equal(validated.spec.domains[0]?.enabled, true);
    assert.deepEqual(validated.spec.domains[0]?.matrix, { runner: 'ubuntu-latest', shard: 1, fast: true });
    assert.equal(validated.spec.stages.length, 2);
    assert.deepEqual(validated.spec.stages[1]?.dependsOn, ['stage-a']);

    // Load a full 32-domain suite from disk
    await withTempDir(async repoRoot => {
      const domainEntries: string[] = [];
      for (let i = 1; i <= 32; i += 1) {
        const id = `dom-${i}`;
        const dir = join(repoRoot, '.loopwright', id);
        await mkdir(dir, { recursive: true });
        await writeFile(
          join(dir, 'taskpack.yaml'),
          domainManifestYaml({
            name: `tp-${i}`,
            writable: [`packages/${id}/**`],
            publication: {
              mode: 'pull_request',
              targetBranch: 'main',
              headBranchPrefix: `loopwright/${id}/`,
              titleTemplate: `chore(${id}): sync`,
            },
          }),
          'utf8',
        );
        domainEntries.push(`    - id: ${id}\n      taskpack: .loopwright/${id}/taskpack.yaml`);
      }
      const suiteYaml = [
        'apiVersion: loopwright.dev/v1alpha1',
        'kind: TaskpackSuite',
        'metadata:',
        '  name: max-domains-suite',
        'spec:',
        '  domains:',
        ...domainEntries,
      ].join('\n') + '\n';
      await writeFile(join(repoRoot, '.loopwright', 'suite.yaml'), suiteYaml, 'utf8');

      const loaded = await loadTaskpackSuite({ repositoryRoot: repoRoot });
      assert.equal(loaded.domains.length, 32);
      assert.equal(loaded.suitePath, '.loopwright/suite.yaml');
      assert.equal(loaded.suiteProtectedPaths.length <= 128, true);
    });
  });

  it('rejects > 65_536 byte manifests, 0 or 33 domains, 17 stages, duplicate IDs/paths/names, symlinks, and hardlinks', async () => {
    // > 65_536 byte manifest rejected
    const oversized = Buffer.alloc(TASKPACK_SUITE_MANIFEST_BYTES + 1, 0x20);
    assert.throws(
      () => parseTaskpackSuiteManifest(oversized),
      (err: unknown) => err instanceof TaskpackError && err.code === 'TASKPACK_MANIFEST_INVALID',
    );

    // 0 domains rejected
    assert.throws(
      () => parseTaskpackSuiteManifest(`apiVersion: loopwright.dev/v1alpha1\nkind: TaskpackSuite\nmetadata:\n  name: empty\nspec:\n  domains: []\n`),
      (err: unknown) => err instanceof TaskpackError && err.code === 'TASKPACK_MANIFEST_INVALID',
    );

    // 33 domains rejected
    const domains33 = Array.from({ length: 33 }, (_, idx) => ({
      id: `d-${idx + 1}`,
      taskpack: `.loopwright/d-${idx + 1}/taskpack.yaml`,
    }));
    assert.throws(
      () => validateTaskpackSuiteManifest({
        apiVersion: 'loopwright.dev/v1alpha1',
        kind: 'TaskpackSuite',
        metadata: { name: 'too-many-domains' },
        spec: { domains: domains33 },
      } as unknown as Json),
      (err: unknown) => err instanceof TaskpackError && err.code === 'TASKPACK_MANIFEST_INVALID',
    );

    // 17 stages rejected
    const stages17 = Array.from({ length: 17 }, (_, idx) => ({ id: `s-${idx + 1}` }));
    assert.throws(
      () => validateTaskpackSuiteManifest({
        apiVersion: 'loopwright.dev/v1alpha1',
        kind: 'TaskpackSuite',
        metadata: { name: 'too-many-stages' },
        spec: {
          domains: [{ id: 'd1', taskpack: '.loopwright/d1/taskpack.yaml' }],
          stages: stages17,
        },
      } as unknown as Json),
      (err: unknown) => err instanceof TaskpackError && err.code === 'TASKPACK_MANIFEST_INVALID',
    );

    // Duplicate domain.id and duplicate normalized domain.taskpack rejected
    assert.throws(
      () => validateTaskpackSuiteManifest({
        apiVersion: 'loopwright.dev/v1alpha1',
        kind: 'TaskpackSuite',
        metadata: { name: 'dup-id' },
        spec: {
          domains: [
            { id: 'docs', taskpack: '.loopwright/a/taskpack.yaml' },
            { id: 'docs', taskpack: '.loopwright/b/taskpack.yaml' },
          ],
        },
      } as unknown as Json),
      (err: unknown) => err instanceof TaskpackError && err.code === 'TASKPACK_MANIFEST_INVALID',
    );
    assert.throws(
      () => validateTaskpackSuiteManifest({
        apiVersion: 'loopwright.dev/v1alpha1',
        kind: 'TaskpackSuite',
        metadata: { name: 'dup-path' },
        spec: {
          domains: [
            { id: 'docs-a', taskpack: '.loopwright/docs/taskpack.yaml' },
            { id: 'docs-b', taskpack: '.loopwright/docs/taskpack.yaml' },
          ],
        },
      } as unknown as Json),
      (err: unknown) => err instanceof TaskpackError && err.code === 'TASKPACK_MANIFEST_INVALID',
    );

    // RFC 6901 pointer validation & prototype-key rejection (including ~0 / ~1 decoded forms)
    assert.deepEqual(validateRfc6901JsonPointer('/packages/@scope~1pkg~01/version', '/ptr'), ['packages', '@scope/pkg~1', 'version']);
    for (const badPtr of ['', 'version', '/bad~2escape', '/__proto__/polluted', '/constructor/prototype', '/a/prototype']) {
      assert.throws(
        () => validateRfc6901JsonPointer(badPtr, '/ptr'),
        (err: unknown) => err instanceof TaskpackError && err.code === 'TASKPACK_MANIFEST_INVALID',
        `expected ${badPtr} to be rejected`,
      );
    }

    // Duplicate loaded manifest.metadata.name, symlink, and hardlink (nlink > 1) rejected on disk
    await withTempDir(async (repoRoot, outsideDir) => {
      await mkdir(join(repoRoot, '.loopwright', 'a'), { recursive: true });
      await mkdir(join(repoRoot, '.loopwright', 'b'), { recursive: true });
      const sameNameYaml = domainManifestYaml({ name: 'shared-name', writable: ['src/**'] });
      await writeFile(join(repoRoot, '.loopwright', 'a', 'taskpack.yaml'), sameNameYaml, 'utf8');
      await writeFile(join(repoRoot, '.loopwright', 'b', 'taskpack.yaml'), sameNameYaml, 'utf8');
      await writeFile(
        join(repoRoot, '.loopwright', 'suite.yaml'),
        `apiVersion: loopwright.dev/v1alpha1\nkind: TaskpackSuite\nmetadata:\n  name: dup-manifest-name\nspec:\n  domains:\n    - id: a\n      taskpack: .loopwright/a/taskpack.yaml\n    - id: b\n      taskpack: .loopwright/b/taskpack.yaml\n`,
        'utf8',
      );
      await assert.rejects(
        loadTaskpackSuite({ repositoryRoot: repoRoot }),
        (err: unknown) => err instanceof TaskpackError && err.code === 'TASKPACK_MANIFEST_INVALID',
      );

      // Fix name of b, then hardlink b/taskpack.yaml (nlink === 2) -> rejected
      const bPath = join(repoRoot, '.loopwright', 'b', 'taskpack.yaml');
      await writeFile(bPath, domainManifestYaml({ name: 'unique-b', writable: ['docs/**'] }), 'utf8');
      const hardlinkAlias = join(outsideDir, 'hardlinked-taskpack.yaml');
      await link(bPath, hardlinkAlias);
      await assert.rejects(
        loadTaskpackSuite({ repositoryRoot: repoRoot }),
        (err: unknown) => err instanceof TaskpackError && err.code === 'TASKPACK_SCOPE_VIOLATION',
      );
      await rm(hardlinkAlias);

      // Replace b/taskpack.yaml with a symlink -> rejected
      const outsideTarget = join(outsideDir, 'outside-taskpack.yaml');
      await writeFile(outsideTarget, domainManifestYaml({ name: 'unique-b', writable: ['docs/**'] }), 'utf8');
      await rm(bPath);
      await symlink(outsideTarget, bPath);
      await assert.rejects(
        loadTaskpackSuite({ repositoryRoot: repoRoot }),
        (err: unknown) => err instanceof TaskpackError && err.code === 'TASKPACK_SCOPE_VIOLATION',
      );
    });
  });

  it('rejects stage cycles, unknown stage references, and unknown versionFrom domains', () => {
    // 3-stage cycle a -> b -> c -> a
    assert.throws(
      () => validateTaskpackSuiteManifest({
        apiVersion: 'loopwright.dev/v1alpha1',
        kind: 'TaskpackSuite',
        metadata: { name: 'cycle-suite' },
        spec: {
          domains: [{ id: 'd1', taskpack: '.loopwright/d1/taskpack.yaml', stage: 'a' }],
          stages: [
            { id: 'a', dependsOn: ['c'] },
            { id: 'b', dependsOn: ['a'] },
            { id: 'c', dependsOn: ['b'] },
          ],
        },
      } as unknown as Json),
      (err: unknown) => err instanceof TaskpackError && err.code === 'TASKPACK_MANIFEST_INVALID',
    );

    // Unknown dependsOn stage
    assert.throws(
      () => validateTaskpackSuiteManifest({
        apiVersion: 'loopwright.dev/v1alpha1',
        kind: 'TaskpackSuite',
        metadata: { name: 'unknown-dep' },
        spec: {
          domains: [{ id: 'd1', taskpack: '.loopwright/d1/taskpack.yaml', stage: 'a' }],
          stages: [{ id: 'a', dependsOn: ['missing'] }],
        },
      } as unknown as Json),
      (err: unknown) => err instanceof TaskpackError && err.code === 'TASKPACK_MANIFEST_INVALID',
    );

    // Unknown domain.stage
    assert.throws(
      () => validateTaskpackSuiteManifest({
        apiVersion: 'loopwright.dev/v1alpha1',
        kind: 'TaskpackSuite',
        metadata: { name: 'unknown-domain-stage' },
        spec: {
          domains: [{ id: 'd1', taskpack: '.loopwright/d1/taskpack.yaml', stage: 'ghost' }],
          stages: [{ id: 'a' }],
        },
      } as unknown as Json),
      (err: unknown) => err instanceof TaskpackError && err.code === 'TASKPACK_MANIFEST_INVALID',
    );

    // Unknown versionFrom.domain
    assert.throws(
      () => validateTaskpackSuiteManifest({
        apiVersion: 'loopwright.dev/v1alpha1',
        kind: 'TaskpackSuite',
        metadata: { name: 'unknown-vf-domain' },
        spec: {
          domains: [{ id: 'd1', taskpack: '.loopwright/d1/taskpack.yaml', stage: 'a' }],
          stages: [{
            id: 'a',
            readiness: [{
              kind: 'github-release',
              source: 'octo/repo',
              versionFrom: { domain: 'nonexistent', path: 'package.json', jsonPointer: '/version' },
            }],
          }],
        },
      } as unknown as Json),
      (err: unknown) => err instanceof TaskpackError && err.code === 'TASKPACK_MANIFEST_INVALID',
    );
  });
});

describe('suite.ts: suite-wide mandatory protected path union and headBranchPrefix disjointness', () => {
  it('enforces suite-wide protected path union across suite.yaml and peer control-plane files and rejects > 128 overflow', async () => {
    // 1. Peer domain writable overlapping another domain's external instruction file -> TASKPACK_MANIFEST_INVALID
    await withTempDir(async repoRoot => {
      await mkdir(join(repoRoot, '.loopwright', 'docs'), { recursive: true });
      await mkdir(join(repoRoot, '.loopwright', 'runtime'), { recursive: true });
      await mkdir(join(repoRoot, 'rules'), { recursive: true });
      await writeFile(join(repoRoot, 'rules', 'runtime-guide.md'), '# Runtime Rules\n', 'utf8');

      await writeFile(
        join(repoRoot, '.loopwright', 'runtime', 'taskpack.yaml'),
        domainManifestYaml({
          name: 'runtime-pack',
          writable: ['packages/runtime/**'],
          instructions: ['rules/runtime-guide.md'],
        }),
        'utf8',
      );
      await writeFile(
        join(repoRoot, '.loopwright', 'docs', 'taskpack.yaml'),
        domainManifestYaml({
          name: 'docs-pack',
          writable: ['docs/**', 'rules/**'],
        }),
        'utf8',
      );
      await writeFile(
        join(repoRoot, '.loopwright', 'suite.yaml'),
        `apiVersion: loopwright.dev/v1alpha1\nkind: TaskpackSuite\nmetadata:\n  name: overlap-suite\nspec:\n  domains:\n    - id: runtime\n      taskpack: .loopwright/runtime/taskpack.yaml\n    - id: docs\n      taskpack: .loopwright/docs/taskpack.yaml\n`,
        'utf8',
      );

      await assert.rejects(
        loadTaskpackSuite({ repositoryRoot: repoRoot }),
        (err: unknown) => err instanceof TaskpackError && err.code === 'TASKPACK_MANIFEST_INVALID',
      );

      // Fix docs writable to ['docs/**'] -> loads cleanly and injects runtime's rules/runtime-guide.md and .loopwright/suite.yaml into docs protectedPaths & compiled TaskContract
      await writeFile(
        join(repoRoot, '.loopwright', 'docs', 'taskpack.yaml'),
        domainManifestYaml({
          name: 'docs-pack',
          writable: ['docs/**'],
          localChecks: [{ id: 'scope-guard', implementation: 'scope.v1' }],
        }),
        'utf8',
      );
      const loaded = await loadTaskpackSuite({ repositoryRoot: repoRoot });
      const docsDomain = loaded.domains.find(d => d.id === 'docs')!;
      assert.equal(docsDomain.protectedPaths.includes('.loopwright/suite.yaml'), true);
      assert.equal(docsDomain.protectedPaths.includes('rules/runtime-guide.md'), true);
      assert.equal(docsDomain.protectedPaths.includes('.loopwright/runtime'), true);

      const compiled = await compileDeclarativeTaskpack(docsDomain.manifest, {
        mode: 'candidate',
        executionMode: 'delegated',
        repository: 'octo/repo',
        repositoryRoot: repoRoot,
        taskpackPath: docsDomain.taskpackPath,
        baseRevision: 'a'.repeat(40),
        sourceRevision: 'a'.repeat(40),
        budgets: DEFAULT_HOST_BUDGETS,
      });
      const compiledProtected = compiled.config.spec.task.spec.scope.protected;
      assert.equal(
        compiledProtected.some(p => p === '.loopwright/suite.yaml' || p === '.loopwright/suite.yaml/**' || p === '.loopwright/**'),
        true,
      );
      assert.equal(
        compiledProtected.some(p => p === 'rules/runtime-guide.md' || p === 'rules/runtime-guide.md/**'),
        true,
      );
    });

    // 2. Domain attempting to carve out .loopwright/suite.yaml as proposal.path -> TASKPACK_MANIFEST_INVALID
    await withTempDir(async repoRoot => {
      await mkdir(join(repoRoot, '.loopwright'), { recursive: true });
      await writeFile(
        join(repoRoot, '.loopwright', 'taskpack-evil.yaml'),
        domainManifestYaml({
          name: 'evil-pack',
          proposalPath: '.loopwright/suite.yaml',
          writable: ['.loopwright/suite.yaml'],
        }),
        'utf8',
      );
      await writeFile(
        join(repoRoot, '.loopwright', 'suite.yaml'),
        `apiVersion: loopwright.dev/v1alpha1\nkind: TaskpackSuite\nmetadata:\n  name: self-tamper-suite\nspec:\n  domains:\n    - id: evil\n      taskpack: .loopwright/taskpack-evil.yaml\n`,
        'utf8',
      );
      await assert.rejects(
        loadTaskpackSuite({ repositoryRoot: repoRoot }),
        (err: unknown) => err instanceof TaskpackError && err.code === 'TASKPACK_MANIFEST_INVALID',
      );
    });

    // 3. Suite-wide mandatory protected union exceeding 128 patterns -> TASKPACK_MANIFEST_INVALID
    await withTempDir(async repoRoot => {
      await mkdir(join(repoRoot, 'rules'), { recursive: true });
      const domainLines: string[] = [];
      for (let d = 1; d <= 9; d += 1) {
        const id = `dom-${d}`;
        await mkdir(join(repoRoot, '.loopwright', id), { recursive: true });
        const instructions: string[] = [];
        for (let k = 1; k <= 15; k += 1) {
          const rel = `rules/${id}-${k}.md`;
          await writeFile(join(repoRoot, rel), `# Rule ${id}-${k}\n`, 'utf8');
          instructions.push(rel);
        }
        await writeFile(
          join(repoRoot, '.loopwright', id, 'taskpack.yaml'),
          domainManifestYaml({
            name: `pack-${d}`,
            writable: [`src/${id}/**`],
            instructions,
          }),
          'utf8',
        );
        domainLines.push(`    - id: ${id}\n      taskpack: .loopwright/${id}/taskpack.yaml`);
      }
      await writeFile(
        join(repoRoot, '.loopwright', 'suite.yaml'),
        `apiVersion: loopwright.dev/v1alpha1\nkind: TaskpackSuite\nmetadata:\n  name: overflow-protected-suite\nspec:\n  domains:\n${domainLines.join('\n')}\n`,
        'utf8',
      );
      await assert.rejects(
        loadTaskpackSuite({ repositoryRoot: repoRoot }),
        (err: unknown) => err instanceof TaskpackError && err.code === 'TASKPACK_MANIFEST_INVALID',
      );
    });
  });

  it('enforces pairwise prefix-disjoint headBranchPrefix per targetBranch while allowing disjoint or cross-targetBranch prefixes', async () => {
    // Direct helper checks
    assert.equal(headBranchPrefixesCollide('loopwright/docs/', 'loopwright/docs/'), true);
    assert.equal(headBranchPrefixesCollide('loopwright/', 'loopwright/docs/'), true);
    assert.equal(headBranchPrefixesCollide('loopwright/docs', 'loopwright/docs-extra'), true);
    assert.equal(headBranchPrefixesCollide('loopwright/docs', 'loopwright/docs/'), true);
    assert.equal(headBranchPrefixesCollide('loopwright/docs/', 'loopwright/docs-extra/'), false);
    assert.equal(headBranchPrefixesCollide('loopwright/docs/', 'loopwright/runtime/'), false);

    await withTempDir(async repoRoot => {
      await mkdir(join(repoRoot, '.loopwright', 'docs'), { recursive: true });
      await mkdir(join(repoRoot, '.loopwright', 'docs-extra'), { recursive: true });
      await mkdir(join(repoRoot, '.loopwright', 'release-docs'), { recursive: true });

      // Colliding 'loopwright/docs' and 'loopwright/docs-extra' on targetBranch 'main' -> TASKPACK_MANIFEST_INVALID
      await writeFile(
        join(repoRoot, '.loopwright', 'docs', 'taskpack.yaml'),
        domainManifestYaml({
          name: 'docs',
          writable: ['docs/**'],
          publication: { mode: 'pull_request', targetBranch: 'main', headBranchPrefix: 'loopwright/docs', titleTemplate: 'docs: sync' },
        }),
        'utf8',
      );
      await writeFile(
        join(repoRoot, '.loopwright', 'docs-extra', 'taskpack.yaml'),
        domainManifestYaml({
          name: 'docs-extra',
          writable: ['guides/**'],
          publication: { mode: 'pull_request', targetBranch: 'main', headBranchPrefix: 'loopwright/docs-extra', titleTemplate: 'guides: sync' },
        }),
        'utf8',
      );
      await writeFile(
        join(repoRoot, '.loopwright', 'suite.yaml'),
        `apiVersion: loopwright.dev/v1alpha1\nkind: TaskpackSuite\nmetadata:\n  name: branch-suite\nspec:\n  domains:\n    - id: docs\n      taskpack: .loopwright/docs/taskpack.yaml\n    - id: docs-extra\n      taskpack: .loopwright/docs-extra/taskpack.yaml\n`,
        'utf8',
      );
      await assert.rejects(
        loadTaskpackSuite({ repositoryRoot: repoRoot }),
        (err: unknown) => err instanceof TaskpackError && err.code === 'TASKPACK_MANIFEST_INVALID',
      );

      // Disjoint 'loopwright/docs/' and 'loopwright/docs-extra/' on 'main', PLUS 'loopwright/docs/' on 'release/1.x' -> allowed!
      await writeFile(
        join(repoRoot, '.loopwright', 'docs', 'taskpack.yaml'),
        domainManifestYaml({
          name: 'docs',
          writable: ['docs/**'],
          publication: { mode: 'pull_request', targetBranch: 'main', headBranchPrefix: 'loopwright/docs/', titleTemplate: 'docs: sync' },
        }),
        'utf8',
      );
      await writeFile(
        join(repoRoot, '.loopwright', 'docs-extra', 'taskpack.yaml'),
        domainManifestYaml({
          name: 'docs-extra',
          writable: ['guides/**'],
          publication: { mode: 'pull_request', targetBranch: 'main', headBranchPrefix: 'loopwright/docs-extra/', titleTemplate: 'guides: sync' },
        }),
        'utf8',
      );
      await writeFile(
        join(repoRoot, '.loopwright', 'release-docs', 'taskpack.yaml'),
        domainManifestYaml({
          name: 'release-docs',
          writable: ['release-docs/**'],
          publication: { mode: 'pull_request', targetBranch: 'release/1.x', headBranchPrefix: 'loopwright/docs/', titleTemplate: 'docs(1.x): sync' },
        }),
        'utf8',
      );
      await writeFile(
        join(repoRoot, '.loopwright', 'suite.yaml'),
        `apiVersion: loopwright.dev/v1alpha1\nkind: TaskpackSuite\nmetadata:\n  name: branch-suite\nspec:\n  domains:\n    - id: docs\n      taskpack: .loopwright/docs/taskpack.yaml\n    - id: docs-extra\n      taskpack: .loopwright/docs-extra/taskpack.yaml\n    - id: release-docs\n      taskpack: .loopwright/release-docs/taskpack.yaml\n`,
        'utf8',
      );

      const loaded = await loadTaskpackSuite({ repositoryRoot: repoRoot });
      assert.equal(loaded.domains.length, 3);
    });
  });
});

describe('suite.ts: stateless stage promotion, baseRevision versionFrom git reads, probes, and SecretScrubber', () => {
  it('reads versionFrom strictly from committed baseRevision in Git (ignoring dirty working tree) and evaluates all 4 probe kinds', async () => {
    await withTempDir(async (repoRoot, outsideDir) => {
      initGitRepo(repoRoot, 'main');
      const remoteRepo = join(outsideDir, 'upstream-git');
      await mkdir(remoteRepo, { recursive: true });
      initGitRepo(remoteRepo, 'main');
      await writeFile(join(remoteRepo, 'README.md'), 'upstream\n', 'utf8');
      git(remoteRepo, ['add', 'README.md']);
      git(remoteRepo, ['commit', '-m', 'init upstream']);
      const upstreamSha1 = git(remoteRepo, ['rev-parse', 'HEAD']);

      await mkdir(join(repoRoot, '.loopwright', 'stage-a'), { recursive: true });
      await mkdir(join(repoRoot, '.loopwright', 'stage-b'), { recursive: true });
      await mkdir(join(repoRoot, 'packages', 'sdk'), { recursive: true });

      await writeFile(
        join(repoRoot, 'packages', 'sdk', 'package.json'),
        JSON.stringify({ name: '@octo/sdk', version: '1.2.0' }, null, 2) + '\n',
        'utf8',
      );
      await writeFile(join(repoRoot, 'packages', 'sdk', 'UPSTREAM_SHA'), `${upstreamSha1}\n`, 'utf8');
      await writeFile(
        join(repoRoot, '.loopwright', 'stage-a', 'taskpack.yaml'),
        domainManifestYaml({
          name: 'sdk-stage-a',
          writable: ['packages/sdk/**'],
          publication: { mode: 'pull_request', targetBranch: 'main', headBranchPrefix: 'loopwright/stage-a/', titleTemplate: 'chore: stage-a' },
        }),
        'utf8',
      );
      await writeFile(
        join(repoRoot, '.loopwright', 'stage-b', 'taskpack.yaml'),
        domainManifestYaml({
          name: 'consumer-stage-b',
          writable: ['apps/web/**'],
          publication: { mode: 'pull_request', targetBranch: 'main', headBranchPrefix: 'loopwright/stage-b/', titleTemplate: 'chore: stage-b' },
        }),
        'utf8',
      );
      await writeFile(
        join(repoRoot, '.loopwright', 'suite.yaml'),
        [
          'apiVersion: loopwright.dev/v1alpha1',
          'kind: TaskpackSuite',
          'metadata:',
          '  name: two-stage-suite',
          'spec:',
          '  domains:',
          '    - id: stage-a',
          '      taskpack: .loopwright/stage-a/taskpack.yaml',
          '      stage: stage-a',
          '      schedules: [nightly]',
          '    - id: stage-b',
          '      taskpack: .loopwright/stage-b/taskpack.yaml',
          '      stage: stage-b',
          '      schedules: [nightly]',
          '  stages:',
          '    - id: stage-a',
          '    - id: stage-b',
          '      dependsOn: [stage-a]',
          '      readiness:',
          '        - id: gh-rel',
          '          kind: github-release',
          '          source: octo/sdk',
          '          versionFrom:',
          '            domain: stage-a',
          '            path: packages/sdk/package.json',
          '            jsonPointer: /version',
          '        - id: npm-json',
          '          kind: http-json',
          '          source: https://registry.example.test/@octo/sdk/latest',
          '          jsonPointer: /version',
          '          versionFrom:',
          '            domain: stage-a',
          '            path: packages/sdk/package.json',
          '            jsonPointer: /version',
          '        - id: remote-tag',
          '          kind: git-tag',
          `          source: "${remoteRepo}"`,
          '          tagPrefix: v',
          '          versionFrom:',
          '            domain: stage-a',
          '            path: packages/sdk/package.json',
          '            jsonPointer: /version',
          '        - id: remote-commit',
          '          kind: git-commit',
          `          source: "${remoteRepo}"`,
          '          versionFrom:',
          '            domain: stage-a',
          '            path: packages/sdk/UPSTREAM_SHA',
        ].join('\n') + '\n',
        'utf8',
      );

      git(repoRoot, ['add', '.']);
      git(repoRoot, ['commit', '-m', 'commit v1.2.0']);
      const baseSha = git(repoRoot, ['rev-parse', 'HEAD']);

      // Dirty working tree on disk to prove versionFrom NEVER reads uncommitted working-tree files!
      await writeFile(
        join(repoRoot, 'packages', 'sdk', 'package.json'),
        JSON.stringify({ name: '@octo/sdk', version: '9.9.9-uncommitted' }, null, 2) + '\n',
        'utf8',
      );

      // Case 1: Stage A has an open PR -> Stage A is eligible, Stage B is deferred (stage_not_ready)
      const openPrRes = await resolveTaskpackSuite({
        repositoryRoot: repoRoot,
        baseRevision: baseSha,
        eventName: 'schedule',
        schedule: 'nightly',
        repositoryFullName: 'octo/mono',
        findOpenPullRequest: async ({ domain }) => domain.id === 'stage-a'
          ? {
            number: 42,
            htmlUrl: 'https://github.com/octo/mono/pull/42',
            headRef: 'loopwright/stage-a/main',
            headSha: 'b'.repeat(40),
            baseRef: 'main',
            baseSha,
            title: 'chore: stage-a',
            body: null,
          }
          : null,
        fetchImpl: async () => new Response(JSON.stringify({ tag_name: 'v1.2.0', version: '1.2.0' }), { status: 200 }),
      });
      assert.equal(openPrRes.disposition, 'eligible');
      assert.deepEqual(openPrRes.eligibleCells.map(c => c.domainId), ['stage-a']);
      const stageBOpenPr = openPrRes.cells.find(c => c.domainId === 'stage-b')!;
      assert.equal(stageBOpenPr.disposition, 'deferred');
      assert.equal(stageBOpenPr.reason, 'stage_not_ready');

      // Case 2: No open PR, but GitHub release returns 404 -> Stage B deferred (stage_not_ready)
      const release404Res = await resolveTaskpackSuite({
        repositoryRoot: repoRoot,
        baseRevision: baseSha,
        domain: 'stage-b',
        findOpenPullRequest: async () => null,
        fetchImpl: async url => {
          const u = String(url);
          if (u.includes('/releases/latest')) return new Response('{"message":"Not Found"}', { status: 404 });
          return new Response(JSON.stringify({ version: '1.2.0' }), { status: 200 });
        },
      });
      assert.equal(release404Res.disposition, 'deferred');
      assert.equal(release404Res.reason, 'stage_not_ready');

      // Case 3: GitHub release & HTTP JSON match 1.2.0, but git-tag v1.2.0 not pushed to remoteRepo yet -> deferred
      const missingTagRes = await resolveTaskpackSuite({
        repositoryRoot: repoRoot,
        baseRevision: baseSha,
        domain: 'stage-b',
        findOpenPullRequest: async () => null,
        fetchImpl: async url => {
          const u = String(url);
          if (u.includes('/releases/latest')) {
            return new Response(JSON.stringify({ tag_name: 'v1.2.0', draft: false, prerelease: false }), { status: 200 });
          }
          return new Response(JSON.stringify({ version: '1.2.0' }), { status: 200 });
        },
      });
      assert.equal(missingTagRes.disposition, 'deferred');
      assert.equal(missingTagRes.reason, 'stage_not_ready');

      // Case 4: Create tag v1.2.0 in remoteRepo -> all 4 probes match 1.2.0 (NOT 9.9.9-uncommitted!) -> Stage B eligible!
      git(remoteRepo, ['tag', 'v1.2.0']);
      const allReadyRes = await resolveTaskpackSuite({
        repositoryRoot: repoRoot,
        baseRevision: baseSha,
        eventName: 'schedule',
        schedule: 'nightly',
        findOpenPullRequest: async () => null,
        fetchImpl: async url => {
          const u = String(url);
          if (u.includes('/releases/latest')) {
            return new Response(JSON.stringify({ tag_name: 'v1.2.0', draft: false, prerelease: false }), { status: 200 });
          }
          return new Response(JSON.stringify({ version: '1.2.0' }), { status: 200 });
        },
      });
      assert.equal(allReadyRes.disposition, 'eligible');
      assert.deepEqual(allReadyRes.eligibleCells.map(c => c.domainId), ['stage-a', 'stage-b']);
      assert.deepEqual(allReadyRes.matrix.include.map(c => c.domainId), ['stage-a', 'stage-b']);
      assert.equal(allReadyRes.eligibleCells[1]?.baseRevision, baseSha);

      // Case 5: Version mismatch on http-json (1.1.9 vs 1.2.0) -> deferred
      const mismatchRes = await resolveTaskpackSuite({
        repositoryRoot: repoRoot,
        baseRevision: baseSha,
        domain: 'stage-b',
        findOpenPullRequest: async () => null,
        fetchImpl: async url => {
          const u = String(url);
          if (u.includes('/releases/latest')) {
            return new Response(JSON.stringify({ tag_name: 'v1.2.0', draft: false, prerelease: false }), { status: 200 });
          }
          return new Response(JSON.stringify({ version: '1.1.9' }), { status: 200 });
        },
      });
      assert.equal(mismatchRes.disposition, 'deferred');
      assert.equal(mismatchRes.reason, 'stage_not_ready');

      // Case 6: Auth / 5xx / invalid JSON / transport / pagination failures -> fail closed as blocked, with SecretScrubber!
      const scrubber = new SecretScrubber();
      const leakedSecret = 'super-secret-probe-credential-xyz987';
      scrubber.register(leakedSecret);
      const ghpToken = 'ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ123456';

      for (const status of [401, 403, 500]) {
        const errRes = await resolveTaskpackSuite({
          repositoryRoot: repoRoot,
          baseRevision: baseSha,
          domain: 'stage-b',
          scrubber,
          findOpenPullRequest: async () => null,
          fetchImpl: async () => new Response(`auth failed with ${leakedSecret} and ${ghpToken}`, { status }),
        });
        assert.equal(errRes.disposition, 'blocked', `expected HTTP ${status} to block`);
        const serialized = JSON.stringify(errRes);
        assert.equal(serialized.includes(leakedSecret), false, 'registered secret leaked in blocked probe output');
        assert.equal(serialized.includes(ghpToken), false, 'ghp_ token leaked in blocked probe output');
      }

      // Invalid JSON response -> blocked
      const badJsonRes = await resolveTaskpackSuite({
        repositoryRoot: repoRoot,
        baseRevision: baseSha,
        domain: 'stage-b',
        scrubber,
        findOpenPullRequest: async () => null,
        fetchImpl: async () => new Response(`{bad json ${leakedSecret}`, { status: 200 }),
      });
      assert.equal(badJsonRes.disposition, 'blocked');
      assert.equal(JSON.stringify(badJsonRes).includes(leakedSecret), false);

      // Open-PR pagination / API error -> blocked
      const prPaginationErrRes = await resolveTaskpackSuite({
        repositoryRoot: repoRoot,
        baseRevision: baseSha,
        domain: 'stage-b',
        repositoryFullName: 'octo/mono',
        apiBaseUrl: 'https://api.example.test',
        scrubber,
        fetchImpl: async url => {
          const u = String(url);
          if (u.includes('/pulls?')) {
            // Return 100 items on all 5 pages to trigger 500-PR pagination exhaustion in findOpenManagedPullRequest
            return new Response(JSON.stringify(Array.from({ length: 100 }, (_, i) => ({ number: i + 1 }))), { status: 200 });
          }
          return new Response(JSON.stringify({ tag_name: 'v1.2.0', version: '1.2.0' }), { status: 200 });
        },
      });
      assert.equal(prPaginationErrRes.disposition, 'blocked');

      // Verify zero suite state ledger files were created in .loopwright/
      const loopwrightEntries = await readdir(join(repoRoot, '.loopwright'));
      assert.deepEqual(loopwrightEntries.sort(), ['stage-a', 'stage-b', 'suite.yaml']);
    });
  });
});

describe('suite.ts: schedule filtering, matrix binding, and pull-request comment routing', () => {
  it('routes PR comments strictly by explicit domain or (targetBranch, headBranchPrefix) and blocks mismatches or cross-fork PRs', async () => {
    // Comment grammar checks
    assert.deepEqual(
      parseSuiteCommentCommand('/loopwright retry', ['/loopwright']),
      { prefix: '/loopwright', command: 'retry', guidance: '' },
    );
    assert.deepEqual(
      parseSuiteCommentCommand('/loopwright runtime revise\nFix edge case', ['/loopwright']),
      { prefix: '/loopwright', domainId: 'runtime', command: 'revise', guidance: 'Fix edge case' },
    );

    await withTempDir(async repoRoot => {
      initGitRepo(repoRoot, 'main');
      await mkdir(join(repoRoot, '.loopwright', 'docs'), { recursive: true });
      await mkdir(join(repoRoot, '.loopwright', 'runtime'), { recursive: true });

      await writeFile(
        join(repoRoot, '.loopwright', 'docs', 'taskpack.yaml'),
        domainManifestYaml({
          name: 'docs-pack',
          writable: ['docs/**'],
          publication: {
            mode: 'pull_request',
            targetBranch: 'main',
            headBranchPrefix: 'loopwright/docs/',
            titleTemplate: 'docs: sync',
          },
          triggers: {
            schedule: true,
            workflowDispatch: true,
            commentCommands: ['retry', 'revise', 'status'],
          },
        }),
        'utf8',
      );
      await writeFile(
        join(repoRoot, '.loopwright', 'runtime', 'taskpack.yaml'),
        domainManifestYaml({
          name: 'runtime-pack',
          writable: ['packages/runtime/**'],
          publication: {
            mode: 'pull_request',
            targetBranch: 'main',
            headBranchPrefix: 'loopwright/runtime/',
            titleTemplate: 'feat(runtime): sync',
          },
          triggers: {
            schedule: true,
            workflowDispatch: true,
            commentCommands: ['retry', 'revise', 'status'],
          },
        }),
        'utf8',
      );
      await writeFile(
        join(repoRoot, '.loopwright', 'suite.yaml'),
        [
          'apiVersion: loopwright.dev/v1alpha1',
          'kind: TaskpackSuite',
          'metadata:',
          '  name: routing-suite',
          'spec:',
          '  domains:',
          '    - id: docs',
          '      taskpack: .loopwright/docs/taskpack.yaml',
          '      schedules: [hourly]',
          '      matrix:',
          '        os: ubuntu-latest',
          '    - id: runtime',
          '      taskpack: .loopwright/runtime/taskpack.yaml',
          '      schedules: [nightly]',
        ].join('\n') + '\n',
        'utf8',
      );
      git(repoRoot, ['add', '.']);
      git(repoRoot, ['commit', '-m', 'init suite']);
      const baseSha = git(repoRoot, ['rev-parse', 'HEAD']);

      // 1. Schedule filtering ('hourly' -> only docs)
      const hourly = await resolveTaskpackSuite({
        repositoryRoot: repoRoot,
        baseRevision: baseSha,
        eventName: 'schedule',
        schedule: 'hourly',
      });
      assert.equal(hourly.disposition, 'eligible');
      assert.deepEqual(hourly.eligibleCells.map(c => c.domainId), ['docs']);
      assert.equal(hourly.eligibleCells[0]?.taskpackPath, '.loopwright/docs/taskpack.yaml');
      assert.equal(hourly.eligibleCells[0]?.baseRevision, baseSha);
      assert.deepEqual(hourly.eligibleCells[0]?.matrix, { os: 'ubuntu-latest' });

      // 2. Untargeted `/loopwright retry` on `loopwright/docs/main` -> routes strictly to `docs`
      const retryDocs = await resolveTaskpackSuite({
        repositoryRoot: repoRoot,
        baseRevision: baseSha,
        eventName: 'issue_comment',
        commentBody: '/loopwright retry',
        prHeadRef: 'loopwright/docs/main',
        prBaseRef: 'main',
      });
      assert.equal(retryDocs.disposition, 'eligible');
      assert.deepEqual(retryDocs.eligibleCells.map(c => c.domainId), ['docs']);
      assert.equal(retryDocs.comment?.command, 'retry');

      // 3. Explicit matching `/loopwright docs revise` on `loopwright/docs/main` -> routes to `docs`
      const reviseDocs = await resolveTaskpackSuite({
        repositoryRoot: repoRoot,
        baseRevision: baseSha,
        eventName: 'issue_comment',
        commentBody: '/loopwright docs revise\nTighten examples',
        prHeadRef: 'loopwright/docs/main',
        prBaseRef: 'main',
      });
      assert.equal(reviseDocs.disposition, 'eligible');
      assert.deepEqual(reviseDocs.eligibleCells.map(c => c.domainId), ['docs']);
      assert.equal(reviseDocs.comment?.command, 'revise');
      assert.equal(reviseDocs.comment?.guidance, 'Tighten examples');

      // 4. Explicit conflicting `/loopwright runtime revise` on `loopwright/docs/main` -> blocked TASKPACK_SCOPE_VIOLATION
      const conflictComment = await resolveTaskpackSuite({
        repositoryRoot: repoRoot,
        baseRevision: baseSha,
        eventName: 'issue_comment',
        commentBody: '/loopwright runtime revise',
        prHeadRef: 'loopwright/docs/main',
        prBaseRef: 'main',
      });
      assert.equal(conflictComment.disposition, 'blocked');
      assert.equal(conflictComment.code, 'TASKPACK_SCOPE_VIOLATION');
      assert.equal(conflictComment.eligibleCells.length, 0);

      // 5. Cross-fork PR comment -> blocked TASKPACK_SCOPE_VIOLATION
      const crossForkComment = await resolveTaskpackSuite({
        repositoryRoot: repoRoot,
        baseRevision: baseSha,
        repositoryFullName: 'octo/mono',
        eventName: 'issue_comment',
        commentBody: '/loopwright retry',
        prHeadRef: 'loopwright/docs/main',
        prBaseRef: 'main',
        prHeadRepoFullName: 'attacker/mono',
        prHeadRepoFork: true,
      });
      assert.equal(crossForkComment.disposition, 'blocked');
      assert.equal(crossForkComment.code, 'TASKPACK_SCOPE_VIOLATION');

      // 6. Untargeted `/loopwright retry` on unmatched branch -> blocked listing valid domain IDs
      const unmatchedBranch = await resolveTaskpackSuite({
        repositoryRoot: repoRoot,
        baseRevision: baseSha,
        eventName: 'issue_comment',
        commentBody: '/loopwright retry',
        prHeadRef: 'feature/manual-branch',
        prBaseRef: 'main',
      });
      assert.equal(unmatchedBranch.disposition, 'blocked');
      assert.deepEqual(unmatchedBranch.validDomainIds, ['docs', 'runtime']);
      assert.equal((unmatchedBranch.detail ?? unmatchedBranch.reason).includes('docs'), true);
      assert.equal((unmatchedBranch.detail ?? unmatchedBranch.reason).includes('runtime'), true);

      // 7. issue_comment payload lacking branch metadata resolves PR via GitHub API, ignores bots, and blocks unauthorized actors / bad guidance
      const botIgnored = await resolveTaskpackSuite({
        repositoryRoot: repoRoot,
        baseRevision: baseSha,
        eventName: 'issue_comment',
        eventPayload: {
          action: 'created',
          issue: { number: 12, pull_request: {} },
          comment: { body: '/loopwright retry', author_association: 'MEMBER', user: { login: 'dependabot[bot]', type: 'Bot' } },
        },
      });
      assert.equal(botIgnored.disposition, 'ignored');

      const unauthBlocked = await resolveTaskpackSuite({
        repositoryRoot: repoRoot,
        baseRevision: baseSha,
        eventName: 'issue_comment',
        eventPayload: {
          action: 'created',
          issue: { number: 12, pull_request: {} },
          comment: { body: '/loopwright retry', author_association: 'NONE', user: { login: 'outsider', type: 'User' } },
        },
      });
      assert.equal(unauthBlocked.disposition, 'blocked');
      assert.equal(unauthBlocked.code, 'WEBHOOK_ACTOR_UNAUTHORIZED');

      const apiPrLookup = await resolveTaskpackSuite({
        repositoryRoot: repoRoot,
        baseRevision: baseSha,
        repositoryFullName: 'octo/mono',
        apiBaseUrl: 'https://api.example.test',
        eventName: 'issue_comment',
        eventPayload: {
          action: 'created',
          issue: { number: 77, pull_request: {} },
          comment: { body: '/loopwright docs status', author_association: 'MEMBER', user: { login: 'maintainer', type: 'User' } },
        },
        fetchImpl: async url => {
          assert.equal(String(url), 'https://api.example.test/repos/octo/mono/pulls/77');
          return new Response(JSON.stringify({
            number: 77,
            head: { ref: 'loopwright/docs/main', sha: baseSha, repo: { full_name: 'octo/mono', fork: false } },
            base: { ref: 'main', sha: baseSha },
          }), { status: 200 });
        },
      });
      assert.equal(apiPrLookup.disposition, 'eligible');
      assert.deepEqual(apiPrLookup.eligibleCells.map(c => c.domainId), ['docs']);
    });
  });

  it('supports checkTaskpackSuite with verifyDigests, GitHub API git-tag/git-commit probes, pending upstream updates, and > 1 MiB versionFrom caps', async () => {
    await withTempDir(async repoRoot => {
      initGitRepo(repoRoot, 'main');
      await mkdir(join(repoRoot, '.loopwright', 'a'), { recursive: true });
      await mkdir(join(repoRoot, '.loopwright', 'b'), { recursive: true });
      await mkdir(join(repoRoot, 'rules'), { recursive: true });
      await writeFile(join(repoRoot, 'rules', 'a.md'), '# Rule A\n', 'utf8');

      await writeFile(
        join(repoRoot, '.loopwright', 'a', 'taskpack.yaml'),
        domainManifestYaml({
          name: 'pack-a',
          writable: ['packages/a/**'],
          instructions: ['rules/a.md'],
          pinDigests: true,
        }),
        'utf8',
      );
      await writeFile(
        join(repoRoot, '.loopwright', 'b', 'taskpack.yaml'),
        domainManifestYaml({
          name: 'pack-b',
          writable: ['packages/b/**'],
        }),
        'utf8',
      );
      await writeFile(
        join(repoRoot, '.loopwright', 'suite.yaml'),
        [
          'apiVersion: loopwright.dev/v1alpha1',
          'kind: TaskpackSuite',
          'metadata:',
          '  name: extra-checks-suite',
          'spec:',
          '  domains:',
          '    - id: a',
          '      taskpack: .loopwright/a/taskpack.yaml',
          '      stage: stage-a',
          '      matrix:',
          '        - id: linux-arm64',
          '          platform: linux',
          '          variant: arm64',
          '    - id: b',
          '      taskpack: .loopwright/b/taskpack.yaml',
          '      stage: stage-b',
          '  stages:',
          '    - id: stage-a',
          '    - id: stage-b',
          '      dependsOn: [stage-a]',
          '      readiness:',
          '        - kind: git-tag',
          '          source: octo/upstream-tags',
          '          expectedVersion: v2.1.0',
          '        - kind: git-commit',
          '          source: octo/upstream-commits',
          '          ref: main',
          `          expectedVersion: "${'c'.repeat(40)}"`,
        ].join('\n') + '\n',
        'utf8',
      );

      // Sync digest lockfile for domain `a`, then checkTaskpackSuite with verifyDigests: true
      const loadedInitial = await validateTaskpackSuite({ repositoryRoot: repoRoot });
      const domA = loadedInitial.domains.find(d => d.id === 'a')!;
      const digests = await computeTaskpackDigests(repoRoot, domA.manifest, domA.controlRoot);
      await writeDigestLockfile(repoRoot, '.loopwright/a/digests.lock.json', digests);
      const checked = await checkTaskpackSuite({ repositoryRoot: repoRoot, verifyDigests: true });
      assert.equal(checked.domains.length, 2);

      // Oversized > 1 MiB blob in Git fails closed as blocked when referenced by versionFrom
      const hugePath = join(repoRoot, 'packages', 'a', 'huge.json');
      await mkdir(join(repoRoot, 'packages', 'a'), { recursive: true });
      await writeFile(hugePath, Buffer.alloc(MAX_SUITE_STAGE_VERSION_BLOB_BYTES + 16, 0x61));
      git(repoRoot, ['add', '.']);
      git(repoRoot, ['commit', '-m', 'commit with lockfile and huge file']);
      const baseSha = git(repoRoot, ['rev-parse', 'HEAD']);

      // Upstream pending updates on stage-a (with secret in detail) -> stage-a eligible, stage-b deferred & scrubbed!
      const updSecret = 'upd-hook-secret-token-998877';
      const updScrubber = new SecretScrubber();
      updScrubber.register(updSecret);
      const pendingUpd = await resolveTaskpackSuite({
        repositoryRoot: repoRoot,
        baseRevision: baseSha,
        eventName: 'workflow_dispatch',
        scrubber: updScrubber,
        checkDomainUpdates: async ({ domain }) => (
          domain.id === 'a'
            ? { status: 'pending_updates', detail: `pending sync with ${updSecret}` }
            : { status: 'up_to_date' }
        ),
        fetchImpl: async url => {
          const u = String(url);
          if (u.includes('/tags')) return new Response(JSON.stringify([{ name: 'v2.1.0' }]), { status: 200 });
          if (u.includes('/compare/')) {
            return new Response(JSON.stringify({ status: 'identical', merge_base_commit: { sha: 'c'.repeat(40) } }), { status: 200 });
          }
          return new Response(JSON.stringify([{ sha: 'c'.repeat(40) }]), { status: 200 });
        },
      });
      assert.equal(pendingUpd.disposition, 'eligible');
      assert.deepEqual(pendingUpd.eligibleCells.map(c => c.domainId), ['a']);
      assert.equal(pendingUpd.cells.find(c => c.domainId === 'b')?.disposition, 'deferred');
      assert.equal(JSON.stringify(pendingUpd).includes(updSecret), false, 'checkDomainUpdates detail must be scrubbed');

      // Once stage-a is up_to_date and both GitHub git-tag & git-commit /compare/ ('ahead') probes match -> both eligible!
      const bothReady = await resolveTaskpackSuite({
        repositoryRoot: repoRoot,
        baseRevision: baseSha,
        apiBaseUrl: 'https://api.example.test',
        eventName: 'workflow_dispatch',
        fetchImpl: async url => {
          const u = String(url);
          if (u.includes('/tags')) return new Response(JSON.stringify([{ name: 'v2.1.0' }]), { status: 200 });
          if (u.includes('/compare/')) {
            return new Response(JSON.stringify({ status: 'ahead', merge_base_commit: { sha: 'c'.repeat(40) } }), { status: 200 });
          }
          return new Response('unexpected endpoint', { status: 500 });
        },
      });
      assert.equal(bothReady.disposition, 'eligible');
      assert.deepEqual(bothReady.eligibleCells.map(c => c.domainId), ['a', 'b']);

      // GitHub /compare/ 'behind' and 'diverged' -> deferred; unknown status -> blocked
      for (const cmpStatus of ['behind', 'diverged'] as const) {
        const cmpDeferred = await resolveTaskpackSuite({
          repositoryRoot: repoRoot,
          baseRevision: baseSha,
          apiBaseUrl: 'https://api.example.test',
          domain: 'b',
          fetchImpl: async url => {
            const u = String(url);
            if (u.includes('/tags')) return new Response(JSON.stringify([{ name: 'v2.1.0' }]), { status: 200 });
            return new Response(JSON.stringify({ status: cmpStatus }), { status: 200 });
          },
        });
        assert.equal(cmpDeferred.disposition, 'deferred', `expected compare status=${cmpStatus} to defer`);
      }
      const cmpBadStatus = await resolveTaskpackSuite({
        repositoryRoot: repoRoot,
        baseRevision: baseSha,
        apiBaseUrl: 'https://api.example.test',
        domain: 'b',
        fetchImpl: async url => {
          const u = String(url);
          if (u.includes('/tags')) return new Response(JSON.stringify([{ name: 'v2.1.0' }]), { status: 200 });
          return new Response(JSON.stringify({ status: 'unexpected_value' }), { status: 200 });
        },
      });
      assert.equal(cmpBadStatus.disposition, 'blocked');

      // Verify > 1 MiB versionFrom blob blocks cleanly
      await writeFile(
        join(repoRoot, '.loopwright', 'suite.yaml'),
        [
          'apiVersion: loopwright.dev/v1alpha1',
          'kind: TaskpackSuite',
          'metadata:',
          '  name: huge-blob-suite',
          'spec:',
          '  domains:',
          '    - id: a',
          '      taskpack: .loopwright/a/taskpack.yaml',
          '      stage: stage-a',
          '    - id: b',
          '      taskpack: .loopwright/b/taskpack.yaml',
          '      stage: stage-b',
          '  stages:',
          '    - id: stage-a',
          '    - id: stage-b',
          '      dependsOn: [stage-a]',
          '      readiness:',
          '        - kind: github-release',
          '          source: octo/pkg',
          '          versionFrom:',
          '            domain: a',
          '            path: packages/a/huge.json',
          '            jsonPointer: /version',
        ].join('\n') + '\n',
        'utf8',
      );
      const hugeBlocked = await resolveTaskpackSuite({
        repositoryRoot: repoRoot,
        baseRevision: baseSha,
        domain: 'b',
        fetchImpl: async () => new Response(JSON.stringify({ tag_name: 'v1.0.0' }), { status: 200 }),
      });
      assert.equal(hugeBlocked.disposition, 'blocked');
    });
  });

  it('covers carved-out proposals, probe variants, comment edge cases, disabled/unknown domains, and git blob guards', async () => {
    // 1. Comment parser shorthands (bare prefix + multiline guidance, knownDomainId + multiline guidance, inline guidance)
    const known = new Set(['docs', 'runtime']);
    assert.deepEqual(
      parseSuiteCommentCommand('/loopwright\nApply formatting fix', ['/loopwright'], undefined, known),
      { prefix: '/loopwright', command: 'revise', guidance: 'Apply formatting fix' },
    );
    assert.deepEqual(
      parseSuiteCommentCommand('/loopwright docs\nUpdate nav', ['/loopwright'], undefined, known),
      { prefix: '/loopwright', domainId: 'docs', command: 'revise', guidance: 'Update nav' },
    );
    assert.deepEqual(
      parseSuiteCommentCommand('/loopwright docs revise inline note\nsecond line', ['/loopwright'], undefined, known),
      { prefix: '/loopwright', domainId: 'docs', command: 'revise', guidance: 'inline note\nsecond line' },
    );
    assert.equal(parseSuiteCommentCommand('plain comment body', ['/loopwright']), null);
    assert.equal(parseSuiteCommentCommand('/loopwright', ['/loopwright']), null);

    // 2. Schema negative paths for probes, matrix, and paths
    for (const invalidObj of [
      { apiVersion: 'v0', kind: 'TaskpackSuite', metadata: { name: 'x' }, spec: { domains: [] } },
      { apiVersion: 'loopwright.dev/v1alpha1', kind: 'Taskpack', metadata: { name: 'x' }, spec: { domains: [] } },
      {
        apiVersion: 'loopwright.dev/v1alpha1',
        kind: 'TaskpackSuite',
        metadata: { name: 'bad-matrix' },
        spec: { domains: [{ id: 'a', taskpack: '.loopwright/a.yaml', matrix: {} }] },
      },
      {
        apiVersion: 'loopwright.dev/v1alpha1',
        kind: 'TaskpackSuite',
        metadata: { name: 'bad-probe-url' },
        spec: {
          domains: [{ id: 'a', taskpack: '.loopwright/a.yaml', stage: 's1' }],
          stages: [{ id: 's1', readiness: [{ kind: 'http-json', source: 'http://example.com/insecure' }] }],
        },
      },
      {
        apiVersion: 'loopwright.dev/v1alpha1',
        kind: 'TaskpackSuite',
        metadata: { name: 'both-vf-and-expected' },
        spec: {
          domains: [{ id: 'a', taskpack: '.loopwright/a.yaml', stage: 's1' }],
          stages: [{
            id: 's1',
            readiness: [{
              kind: 'github-release',
              source: 'octo/repo',
              versionFrom: { domain: 'a', path: 'package.json' },
              expectedVersion: '1.0.0',
            }],
          }],
        },
      },
      {
        apiVersion: 'loopwright.dev/v1alpha1',
        kind: 'TaskpackSuite',
        metadata: { name: 'self-dep-stage' },
        spec: {
          domains: [{ id: 'a', taskpack: '.loopwright/a.yaml', stage: 's1' }],
          stages: [{ id: 's1', dependsOn: ['s1'] }],
        },
      },
    ]) {
      assert.throws(
        () => validateTaskpackSuiteManifest(invalidObj as unknown as Json),
        (err: unknown) => err instanceof TaskpackError && err.code === 'TASKPACK_MANIFEST_INVALID',
      );
    }

    // 3. Carved-out proposal inside .loopwright/docs/proposal.json, peer overlap rejection, and runtime edge cases
    await withTempDir(async (repoRoot, outsideDir) => {
      initGitRepo(repoRoot, 'main');
      const remoteRepo = join(outsideDir, 'remote-nonhex');
      await mkdir(remoteRepo, { recursive: true });
      initGitRepo(remoteRepo, 'main');
      await writeFile(join(remoteRepo, 'f.txt'), 'v1\n', 'utf8');
      git(remoteRepo, ['add', 'f.txt']);
      git(remoteRepo, ['commit', '-m', 'c1']);
      const c1Sha = git(remoteRepo, ['rev-parse', 'HEAD']);
      // Create an unmerged side branch commit in remoteRepo so merge-base --is-ancestor is false for HEAD
      git(remoteRepo, ['checkout', '-b', 'side']);
      await writeFile(join(remoteRepo, 'side.txt'), 'side\n', 'utf8');
      git(remoteRepo, ['add', 'side.txt']);
      git(remoteRepo, ['commit', '-m', 'side commit']);
      const unmergedSideSha = git(remoteRepo, ['rev-parse', 'HEAD']);
      git(remoteRepo, ['checkout', 'main']);

      await mkdir(join(repoRoot, '.loopwright', 'docs'), { recursive: true });
      await mkdir(join(repoRoot, '.loopwright', 'runtime'), { recursive: true });
      await mkdir(join(repoRoot, '.loopwright', 'disabled-dom'), { recursive: true });
      await mkdir(join(repoRoot, 'packages', 'meta'), { recursive: true });
      await writeFile(join(repoRoot, '.loopwright', 'docs', 'sibling.txt'), 'keep protected\n', 'utf8');
      await writeFile(
        join(repoRoot, 'packages', 'meta', 'releases.json'),
        JSON.stringify({ version: '3.0.0', items: [{ ver: '3.0.0' }] }) + '\n',
        'utf8',
      );
      await symlink('releases.json', join(repoRoot, 'packages', 'meta', 'rel-link.json'));

      // Docs domain carves out .loopwright/docs/proposal.json cleanly
      await writeFile(
        join(repoRoot, '.loopwright', 'docs', 'taskpack.yaml'),
        domainManifestYaml({
          name: 'docs-carved',
          proposalPath: '.loopwright/docs/proposal.json',
          writable: ['.loopwright/docs/proposal.json', 'docs/**'],
          publication: { mode: 'pull_request', targetBranch: 'main', headBranchPrefix: 'loopwright/docs/', titleTemplate: 'docs: sync' },
          triggers: { schedule: true, workflowDispatch: true, commentCommands: ['retry'], commentPrefixes: ['/lw-docs'] },
        }),
        'utf8',
      );
      await writeFile(
        join(repoRoot, '.loopwright', 'runtime', 'taskpack.yaml'),
        domainManifestYaml({
          name: 'runtime-carved-peer',
          writable: ['packages/runtime/**'],
          publication: { mode: 'pull_request', targetBranch: 'release/2.x', headBranchPrefix: 'loopwright/docs/', titleTemplate: 'rt: sync' },
        }),
        'utf8',
      );
      await writeFile(
        join(repoRoot, '.loopwright', 'disabled-dom', 'taskpack.yaml'),
        domainManifestYaml({
          name: 'disabled-pack',
          writable: ['packages/disabled/**'],
          publication: { mode: 'pull_request', targetBranch: 'main', headBranchPrefix: 'loopwright/disabled/', titleTemplate: 'dis: sync' },
        }),
        'utf8',
      );

      await writeFile(
        join(repoRoot, '.loopwright', 'suite.yaml'),
        [
          'apiVersion: loopwright.dev/v1alpha1',
          'kind: TaskpackSuite',
          'metadata:',
          '  name: carved-and-probes-suite',
          'spec:',
          '  domains:',
          '    - id: docs',
          '      taskpack: .loopwright/docs/taskpack.yaml',
          '      schedules: [weekly]',
          '      stage: s-pre',
          '    - id: runtime',
          '      taskpack: .loopwright/runtime/taskpack.yaml',
          '      schedules: [weekly]',
          '      stage: s-post',
          '    - id: disabled-dom',
          '      taskpack: .loopwright/disabled-dom/taskpack.yaml',
          '      enabled: false',
          '  stages:',
          '    - id: s-pre',
          '      readiness:',
          '        - kind: github-release',
          '          source: octo/pre-rel',
          '          allowPrerelease: true',
          '          versionFrom:',
          '            domain: docs',
          '            path: packages/meta/releases.json',
          '        - kind: http-json',
          '          source: http://127.0.0.1:18080/status.json',
          '          versionPath: data.latest',
          '          versionFrom:',
          '            domain: docs',
          '            path: packages/meta/releases.json',
          '            jsonPointer: /items/0/ver',
          '    - id: s-post',
          '      dependsOn: [s-pre]',
          '      readiness:',
          '        - kind: git-commit',
          `          source: "${remoteRepo}"`,
          `          expectedVersion: "${unmergedSideSha}"`,
        ].join('\n') + '\n',
        'utf8',
      );

      git(repoRoot, ['add', '.']);
      git(repoRoot, ['commit', '-m', 'init carved suite']);
      const baseSha = git(repoRoot, ['rev-parse', 'HEAD']);

      const loaded = await loadTaskpackSuite({ repositoryRoot: repoRoot, suitePath: join(repoRoot, '.loopwright/suite.yaml') });
      assert.equal(loaded.domains.length, 3);

      // Ambiguous branch without prBaseRef when two domains share 'loopwright/docs/' across 'main' and 'release/2.x'
      const ambig = matchSuitePullRequestDomain(loaded.domains, 'loopwright/docs/custom-branch');
      assert.equal(ambig.ambiguous, true);
      // Exact synthesized branch name disambiguates cleanly even without prBaseRef
      const exactDisambig = matchSuitePullRequestDomain(loaded.domains, 'loopwright/docs/main');
      assert.equal(exactDisambig.matched?.id, 'docs');

      // readGitRevisionVersionFrom: top-level JSON version without pointer, array pointer, missing path, and symlink rejection
      assert.equal(
        await readGitRevisionVersionFrom({
          repositoryRoot: repoRoot,
          baseRevision: baseSha,
          selector: { domain: 'docs', path: 'packages/meta/releases.json' },
        }),
        '3.0.0',
      );
      assert.equal(
        await readGitRevisionVersionFrom({
          repositoryRoot: repoRoot,
          baseRevision: baseSha,
          selector: { domain: 'docs', path: 'packages/meta/releases.json', jsonPointer: '/items/0/ver' },
        }),
        '3.0.0',
      );
      await assert.rejects(
        readGitRevisionVersionFrom({
          repositoryRoot: repoRoot,
          baseRevision: baseSha,
          selector: { domain: 'docs', path: 'packages/meta/missing.json' },
        }),
      );
      await assert.rejects(
        readGitRevisionVersionFrom({
          repositoryRoot: repoRoot,
          baseRevision: baseSha,
          selector: { domain: 'docs', path: 'packages/meta/rel-link.json' },
        }),
        (err: unknown) => err instanceof TaskpackError && err.code === 'TASKPACK_SCOPE_VIOLATION',
      );

      // Evaluate s-pre (allowPrerelease github-release array + http-json versionPath) -> eligible, while s-post (unmerged side commit) -> deferred!
      const mixed = await resolveTaskpackSuite({
        repositoryRoot: repoRoot,
        loadedSuite: loaded,
        baseRevision: baseSha,
        eventName: 'schedule',
        schedule: 'weekly',
        allowOfflineStagePrCheck: true,
        fetchImpl: async url => {
          const u = String(url);
          if (u.includes('/releases?per_page=30')) {
            return new Response(JSON.stringify([{ tag_name: 'v3.0.0', draft: false, prerelease: true }]), { status: 200 });
          }
          return new Response(JSON.stringify({ data: { latest: '3.0.0' } }), { status: 200 });
        },
      });
      assert.equal(mixed.disposition, 'eligible');
      assert.deepEqual(mixed.eligibleCells.map(c => c.domainId), ['docs']);
      assert.equal(mixed.cells.find(c => c.domainId === 'runtime')?.disposition, 'deferred');

      // Non-matching schedule -> deferred (no_matching_domains)
      const noSched = await resolveTaskpackSuite({
        repositoryRoot: repoRoot,
        loadedSuite: loaded,
        baseRevision: baseSha,
        eventName: 'schedule',
        schedule: 'nonexistent-cron',
      });
      assert.equal(noSched.disposition, 'deferred');
      assert.equal(noSched.reason, 'no_matching_domains');

      // Direct disabled domain -> deferred; unknown domain -> blocked
      const disRes = await resolveTaskpackSuite({
        repositoryRoot: repoRoot,
        loadedSuite: loaded,
        baseRevision: baseSha,
        domain: 'disabled-dom',
      });
      assert.equal(disRes.disposition, 'deferred');
      assert.equal(disRes.reason, 'domain_disabled');

      const unkDomRes = await resolveTaskpackSuite({
        repositoryRoot: repoRoot,
        loadedSuite: loaded,
        baseRevision: baseSha,
        domain: 'nope',
      });
      assert.equal(unkDomRes.disposition, 'blocked');

      // Custom probeRunner throwing -> blocked
      const customRunnerThrow = await resolveTaskpackSuite({
        repositoryRoot: repoRoot,
        loadedSuite: loaded,
        baseRevision: baseSha,
        domain: 'docs',
        probeRunner: async () => {
          throw new Error('synthetic transport timeout');
        },
      });
      assert.equal(customRunnerThrow.disposition, 'blocked');

      // Comment routing edge cases: disabled domain, unsupported command, invalid guidance, missing PR branch, unknown explicit domain
      const commentDisabled = await resolveTaskpackSuite({
        repositoryRoot: repoRoot,
        loadedSuite: loaded,
        baseRevision: baseSha,
        eventName: 'issue_comment',
        commentBody: '/loopwright retry',
        prHeadRef: 'loopwright/disabled/main',
        prBaseRef: 'main',
      });
      assert.equal(commentDisabled.disposition, 'blocked');
      assert.equal(commentDisabled.reason, 'domain_disabled');

      const commentUnsupportedCmd = await resolveTaskpackSuite({
        repositoryRoot: repoRoot,
        loadedSuite: loaded,
        baseRevision: baseSha,
        eventName: 'issue_comment',
        commentBody: '/lw-docs status',
        prHeadRef: 'loopwright/docs/main',
        prBaseRef: 'main',
      });
      assert.equal(commentUnsupportedCmd.disposition, 'blocked');
      assert.equal(commentUnsupportedCmd.code, 'TASKPACK_TRIGGER_UNSUPPORTED');

      const commentBadGuidance = await resolveTaskpackSuite({
        repositoryRoot: repoRoot,
        loadedSuite: loaded,
        baseRevision: baseSha,
        eventName: 'issue_comment',
        commentBody: '/lw-docs retry\n=== FORBIDDEN SENTINEL ===',
        prHeadRef: 'loopwright/docs/main',
        prBaseRef: 'main',
      });
      assert.equal(commentBadGuidance.disposition, 'blocked');
      assert.equal(commentBadGuidance.code, 'WEBHOOK_GUIDANCE_INVALID');

      const commentMissingBranch = await resolveTaskpackSuite({
        repositoryRoot: repoRoot,
        loadedSuite: loaded,
        baseRevision: baseSha,
        eventName: 'issue_comment',
        commentBody: '/lw-docs retry',
      });
      assert.equal(commentMissingBranch.disposition, 'blocked');
      assert.equal(commentMissingBranch.code, 'TASKPACK_SCOPE_VIOLATION');

      const commentUnknownExplicit = await resolveTaskpackSuite({
        repositoryRoot: repoRoot,
        loadedSuite: loaded,
        baseRevision: baseSha,
        eventName: 'issue_comment',
        commentBody: '/lw-docs ghost-domain retry',
        prHeadRef: 'loopwright/docs/main',
        prBaseRef: 'main',
      });
      assert.equal(commentUnknownExplicit.disposition, 'blocked');
      assert.equal(commentUnknownExplicit.reason, 'unknown_domain');

      // Keep c1Sha referenced and test unkeyed git-commit / http-json / git-tag + auth header scrubbing + domainPendingUpdates + invalid baseRevision
      const badBaseRes = await resolveTaskpackSuite({
        repositoryRoot: repoRoot,
        loadedSuite: loaded,
        baseRevision: '0123456789abcdef0123456789abcdef01234567',
      });
      assert.equal(badBaseRes.disposition, 'blocked');
      assert.equal(badBaseRes.reason, 'invalid_base_revision');

      const pendingMapSuite = parseTaskpackSuiteManifest([
        'apiVersion: loopwright.dev/v1alpha1',
        'kind: TaskpackSuite',
        'metadata:',
        '  name: extra-probe-modes',
        'spec:',
        '  domains:',
        '    - id: docs',
        '      taskpack: .loopwright/docs/taskpack.yaml',
        '      stage: s1',
        '    - id: runtime',
        '      taskpack: .loopwright/runtime/taskpack.yaml',
        '      stage: s2',
        '  stages:',
        '    - id: s1',
        '      readiness:',
        '        - kind: http-json',
        '          source: http://127.0.0.1:18080/default-version.json',
        '        - kind: git-tag',
        '          source: octo/any-tag',
        '          allowPrerelease: false',
        '        - kind: git-commit',
        '          source: octo/single-commit',
        `          expectedVersion: "${c1Sha}"`,
        '        - kind: git-commit',
        `          source: "${remoteRepo}"`,
        '          ref: refs/heads/main',
        '    - id: s2',
        '      dependsOn: [s1]',
      ].join('\n') + '\n');
      assert.equal(pendingMapSuite.spec.stages.length, 2);

      const loadedProbeModes = {
        ...loaded,
        manifest: pendingMapSuite,
        domains: loaded.domains.slice(0, 2).map((d, i) => ({
          ...d,
          stage: i === 0 ? 's1' : 's2',
          schedules: undefined,
        })),
      };

      const tokenSecret = 'tok_secret_value_1234567890';
      const headerSecret = 'hdr_secret_value_1234567890';
      const scrubber2 = new SecretScrubber();
      const extraReady = await resolveTaskpackSuite({
        repositoryRoot: repoRoot,
        loadedSuite: loadedProbeModes,
        baseRevision: baseSha,
        eventName: 'schedule',
        allowOfflineStagePrCheck: true,
        githubToken: () => tokenSecret,
        authHeaders: () => ({ 'X-API-Key': headerSecret }),
        domainPendingUpdates: { docs: true },
        scrubber: scrubber2,
        fetchImpl: async url => {
          const u = String(url);
          if (u.includes('default-version.json')) return new Response(JSON.stringify({ version: '1.0.0' }), { status: 200 });
          if (u.includes('/tags')) return new Response(JSON.stringify([{ name: 'v1.0.0-rc.1' }, { name: 'v1.0.0' }]), { status: 200 });
          return new Response(JSON.stringify({ sha: c1Sha }), { status: 200 });
        },
      });
      assert.equal(extraReady.disposition, 'eligible');
      assert.deepEqual(extraReady.eligibleCells.map(c => c.domainId), ['docs']);
      assert.equal(extraReady.cells.find(c => c.domainId === 'runtime')?.disposition, 'deferred');
      assert.equal(scrubber2.containsSecret(tokenSecret), true);
      assert.equal(scrubber2.containsSecret(headerSecret), true);

      // All-deferred schedule outcome (when s1 http-json has no version field yet)
      const allDeferred = await resolveTaskpackSuite({
        repositoryRoot: repoRoot,
        loadedSuite: loadedProbeModes,
        baseRevision: baseSha,
        eventName: 'schedule',
        allowOfflineStagePrCheck: true,
        fetchImpl: async url => {
          const u = String(url);
          if (u.includes('default-version.json')) return new Response(JSON.stringify({ empty: true }), { status: 200 });
          if (u.includes('/tags')) return new Response(JSON.stringify([]), { status: 200 });
          return new Response(JSON.stringify({ sha: 'f'.repeat(40) }), { status: 200 });
        },
      });
      assert.equal(allDeferred.disposition, 'deferred');
      assert.equal(allDeferred.reason, 'stage_not_ready');

      // Additional comment & upstream discovery edge cases: PR API 500 failure, ambiguous branch without baseRef, options.domain mismatch, unconfigured prefix, and discoverUpstreamUpdates
      const prLookup500 = await resolveTaskpackSuite({
        repositoryRoot: repoRoot,
        loadedSuite: loaded,
        baseRevision: baseSha,
        repositoryFullName: 'octo/mono',
        apiBaseUrl: 'https://api.example.test',
        eventName: 'issue_comment',
        eventPayload: {
          action: 'created',
          issue: { number: 88, pull_request: {} },
          comment: { body: '/lw-docs retry', author_association: 'MEMBER', user: { login: 'dev', type: 'User' } },
        },
        fetchImpl: async () => new Response('upstream outage', { status: 502 }),
      });
      assert.equal(prLookup500.disposition, 'blocked');
      assert.equal(prLookup500.reason, 'pull_request_lookup_failed');

      const ambigComment = await resolveTaskpackSuite({
        repositoryRoot: repoRoot,
        loadedSuite: loaded,
        baseRevision: baseSha,
        eventName: 'issue_comment',
        commentBody: '/lw-docs retry',
        prHeadRef: 'loopwright/docs/custom-shared',
      });
      assert.equal(ambigComment.disposition, 'blocked');
      assert.equal(ambigComment.reason, 'ambiguous_pull_request_branch');

      const optDomainConflict = await resolveTaskpackSuite({
        repositoryRoot: repoRoot,
        loadedSuite: loaded,
        baseRevision: baseSha,
        domain: 'runtime',
        eventName: 'issue_comment',
        commentBody: '/lw-docs retry',
        prHeadRef: 'loopwright/docs/main',
        prBaseRef: 'main',
      });
      assert.equal(optDomainConflict.disposition, 'blocked');
      assert.equal(optDomainConflict.code, 'TASKPACK_SCOPE_VIOLATION');

      const wrongPrefixForDomain = await resolveTaskpackSuite({
        repositoryRoot: repoRoot,
        loadedSuite: loaded,
        baseRevision: baseSha,
        eventName: 'issue_comment',
        commentBody: '/loopwright retry',
        prHeadRef: 'loopwright/docs/main',
        prBaseRef: 'main',
      });
      assert.equal(wrongPrefixForDomain.disposition, 'ignored');

      // discoverUpstreamUpdates: true on upstream stage domain declaring an http-json upstream
      const domWithUpstream = {
        ...loadedProbeModes.domains[0]!,
        manifest: {
          ...loadedProbeModes.domains[0]!.manifest,
          spec: {
            ...loadedProbeModes.domains[0]!.manifest.spec,
            upstreams: [{
              id: 'dep-api',
              kind: 'http-json' as const,
              source: 'http://127.0.0.1:18080/upstream-ver.json',
              watchedPaths: ['docs/dep.md'],
            }],
          },
        },
      };
      const suiteWithUpstream = {
        ...loadedProbeModes,
        domains: [domWithUpstream, loadedProbeModes.domains[1]!],
      };
      const discPending = await resolveTaskpackSuite({
        repositoryRoot: repoRoot,
        loadedSuite: suiteWithUpstream,
        baseRevision: baseSha,
        domain: 'runtime',
        discoverUpstreamUpdates: true,
        allowOfflineStagePrCheck: true,
        fetchImpl: async url => {
          const u = String(url);
          if (u.includes('default-version.json')) return new Response(JSON.stringify({ version: '1.0.0' }), { status: 200 });
          if (u.includes('/tags')) return new Response(JSON.stringify([{ name: 'v1.0.0' }]), { status: 200 });
          if (u.includes('/commits')) return new Response(JSON.stringify({ sha: c1Sha }), { status: 200 });
          return new Response(JSON.stringify({ version: '9.0.0' }), { status: 200 });
        },
      });
      assert.equal(discPending.disposition, 'deferred');
      assert.equal(discPending.reason, 'stage_not_ready');

      // Probe transport rejection, github-release draft/mismatch/unpinned, and local git-commit absent sha
      const probeEdgeSuite = parseTaskpackSuiteManifest([
        'apiVersion: loopwright.dev/v1alpha1',
        'kind: TaskpackSuite',
        'metadata:',
        '  name: probe-edges',
        'spec:',
        '  domains:',
        '    - id: docs',
        '      taskpack: .loopwright/docs/taskpack.yaml',
        '      stage: s-edge',
        '  stages:',
        '    - id: s-edge',
        '      readiness:',
        '        - kind: github-release',
        '          source: octo/unpinned-rel',
        '        - kind: github-release',
        '          source: octo/pinned-rel',
        '          expectedVersion: v2.0.0',
        '        - kind: git-commit',
        `          source: "${remoteRepo}"`,
        `          expectedVersion: "${'d'.repeat(40)}"`,
      ].join('\n') + '\n');
      const loadedEdge = {
        ...loaded,
        manifest: probeEdgeSuite,
        domains: [{ ...loaded.domains[0]!, stage: 's-edge' }],
      };

      // Network transport throw -> blocked (probe_transport_error)
      const netErrRes = await resolveTaskpackSuite({
        repositoryRoot: repoRoot,
        loadedSuite: loadedEdge,
        baseRevision: baseSha,
        domain: 'docs',
        fetchImpl: async () => {
          throw new Error('ECONNREFUSED simulated');
        },
      });
      assert.equal(netErrRes.disposition, 'blocked');

      // github-release draft-only, version mismatch, and local absent commit -> deferred
      const draftAndMismatchRes = await resolveTaskpackSuite({
        repositoryRoot: repoRoot,
        loadedSuite: loadedEdge,
        baseRevision: baseSha,
        domain: 'docs',
        fetchImpl: async url => {
          const u = String(url);
          if (u.includes('unpinned-rel')) return new Response(JSON.stringify({ tag_name: 'v1.0.0', draft: true }), { status: 200 });
          return new Response(JSON.stringify({ tag_name: 'v1.5.0', draft: false }), { status: 200 });
        },
      });
      assert.equal(draftAndMismatchRes.disposition, 'deferred');
      assert.equal(draftAndMismatchRes.reason, 'stage_not_ready');

      // 3-stage transitive propagation (s1 -> s2 -> s3) for both deferred and blocked upstream stages + empty comment + non-hex ls-remote expectedVersion
      const threeStageSuite = parseTaskpackSuiteManifest([
        'apiVersion: loopwright.dev/v1alpha1',
        'kind: TaskpackSuite',
        'metadata:',
        '  name: three-stage',
        'spec:',
        '  domains:',
        '    - id: docs',
        '      taskpack: .loopwright/docs/taskpack.yaml',
        '      stage: s1',
        '    - id: runtime',
        '      taskpack: .loopwright/runtime/taskpack.yaml',
        '      stage: s3',
        '  stages:',
        '    - id: s1',
        '      readiness:',
        '        - kind: git-commit',
        `          source: "${remoteRepo}"`,
        '          ref: refs/heads/main',
        '          expectedVersion: non-hex-expected',
        '    - id: s2',
        '      dependsOn: [s1]',
        '    - id: s3',
        '      dependsOn: [s2]',
      ].join('\n') + '\n');
      const loadedThree = {
        ...loaded,
        manifest: threeStageSuite,
        domains: [
          { ...loaded.domains[0]!, stage: 's1' },
          { ...loaded.domains[1]!, stage: 's3' },
        ],
      };

      const transitiveDeferred = await resolveTaskpackSuite({
        repositoryRoot: repoRoot,
        loadedSuite: loadedThree,
        baseRevision: baseSha,
        domain: 'runtime',
        allowOfflineStagePrCheck: true,
      });
      assert.equal(transitiveDeferred.disposition, 'deferred');

      const transitiveBlocked = await resolveTaskpackSuite({
        repositoryRoot: repoRoot,
        loadedSuite: loadedThree,
        baseRevision: baseSha,
        domain: 'runtime',
        allowOfflineStagePrCheck: true,
        probeRunner: async () => ({ disposition: 'blocked', reason: 'upstream_probe_failed', detail: 'bad auth' }),
      });
      assert.equal(transitiveBlocked.disposition, 'blocked');

      const emptyCommentRes = await resolveTaskpackSuite({
        repositoryRoot: repoRoot,
        loadedSuite: loaded,
        baseRevision: baseSha,
        eventName: 'issue_comment',
        commentBody: '   ',
      });
      assert.equal(emptyCommentRes.disposition, 'ignored');
    });
  });

  it('enforces webhook action/attribution guards, cross-fork metadata & headSha wiring, bounded probe pagination, Stage A open-PR availability, comment precedence, carved-out sibling overflow, and versionFrom NUL/multiline guards', async () => {
    // Low #3: untargeted command precedence when guidance starts with a command keyword
    const known = new Set(['docs', 'runtime']);
    assert.deepEqual(
      parseSuiteCommentCommand('/loopwright revise retry the flaky test', ['/loopwright'], undefined, known),
      { prefix: '/loopwright', command: 'revise', guidance: 'retry the flaky test' },
    );
    assert.deepEqual(
      parseSuiteCommentCommand('/loopwright revise retry the flaky test', ['/loopwright']),
      { prefix: '/loopwright', command: 'revise', guidance: 'retry the flaky test' },
    );
    // Domain literally named 'status' still parses `<domainId> <command>` when knownDomainIds contains 'status'
    assert.deepEqual(
      parseSuiteCommentCommand('/loopwright status retry', ['/loopwright'], undefined, new Set(['status'])),
      { prefix: '/loopwright', domainId: 'status', command: 'retry', guidance: '' },
    );

    await withTempDir(async repoRoot => {
      initGitRepo(repoRoot, 'main');
      await mkdir(join(repoRoot, '.loopwright', 'docs'), { recursive: true });
      await mkdir(join(repoRoot, '.loopwright', 'runtime'), { recursive: true });
      await mkdir(join(repoRoot, 'packages', 'meta'), { recursive: true });

      await writeFile(
        join(repoRoot, 'packages', 'meta', 'bad-multiline.json'),
        JSON.stringify({ version: '1.0.0\n2.0.0' }) + '\n',
        'utf8',
      );
      await writeFile(
        join(repoRoot, 'packages', 'meta', 'bad-nul.txt'),
        '1.0.0\0injected\n',
        'utf8',
      );
      await writeFile(
        join(repoRoot, 'packages', 'meta', 'bad-multiline.txt'),
        '1.0.0\n2.0.0\n',
        'utf8',
      );

      await writeFile(
        join(repoRoot, '.loopwright', 'docs', 'taskpack.yaml'),
        domainManifestYaml({
          name: 'docs-pack',
          writable: ['docs/**'],
          publication: {
            mode: 'pull_request',
            targetBranch: 'main',
            headBranchPrefix: 'loopwright/docs/',
            titleTemplate: 'docs: sync',
          },
          triggers: {
            schedule: true,
            workflowDispatch: true,
            commentCommands: ['retry', 'revise', 'status'],
          },
        }),
        'utf8',
      );
      await writeFile(
        join(repoRoot, '.loopwright', 'runtime', 'taskpack.yaml'),
        domainManifestYaml({
          name: 'runtime-pack',
          writable: ['packages/runtime/**'],
          publication: {
            mode: 'pull_request',
            targetBranch: 'main',
            headBranchPrefix: 'loopwright/runtime/',
            titleTemplate: 'rt: sync',
          },
          triggers: {
            schedule: true,
            workflowDispatch: true,
            commentCommands: ['retry', 'revise', 'status'],
          },
        }),
        'utf8',
      );
      await writeFile(
        join(repoRoot, '.loopwright', 'suite.yaml'),
        [
          'apiVersion: loopwright.dev/v1alpha1',
          'kind: TaskpackSuite',
          'metadata:',
          '  name: review-fixes-suite',
          'spec:',
          '  domains:',
          '    - id: docs',
          '      taskpack: .loopwright/docs/taskpack.yaml',
          '      stage: stage-a',
          '    - id: runtime',
          '      taskpack: .loopwright/runtime/taskpack.yaml',
          '      stage: stage-b',
          '  stages:',
          '    - id: stage-a',
          '    - id: stage-b',
          '      dependsOn: [stage-a]',
          '      readiness:',
          '        - kind: git-tag',
          '          source: octo/paginated-tags',
          '          expectedVersion: v2.5.0',
          '        - kind: github-release',
          '          source: octo/paginated-releases',
          '          allowPrerelease: true',
          '          expectedVersion: v2.5.0-rc.1',
        ].join('\n') + '\n',
        'utf8',
      );

      git(repoRoot, ['add', '.']);
      git(repoRoot, ['commit', '-m', 'init review fixes suite']);
      const baseSha = git(repoRoot, ['rev-parse', 'HEAD']);
      const headSha = 'a'.repeat(40);
      const loaded = await loadTaskpackSuite({ repositoryRoot: repoRoot });

      // Low #4: versionFrom rejects multiline and NUL strings in JSON pointer & plain-text blobs
      await assert.rejects(
        readGitRevisionVersionFrom({
          repositoryRoot: repoRoot,
          baseRevision: baseSha,
          selector: { domain: 'docs', path: 'packages/meta/bad-multiline.json', jsonPointer: '/version' },
        }),
        (err: unknown) => err instanceof TaskpackError && err.code === 'ACTION_INPUT_INVALID',
      );
      await assert.rejects(
        readGitRevisionVersionFrom({
          repositoryRoot: repoRoot,
          baseRevision: baseSha,
          selector: { domain: 'docs', path: 'packages/meta/bad-nul.txt' },
        }),
        (err: unknown) => err instanceof TaskpackError && err.code === 'ACTION_INPUT_INVALID',
      );
      await assert.rejects(
        readGitRevisionVersionFrom({
          repositoryRoot: repoRoot,
          baseRevision: baseSha,
          selector: { domain: 'docs', path: 'packages/meta/bad-multiline.txt' },
        }),
        (err: unknown) => err instanceof TaskpackError && err.code === 'ACTION_INPUT_INVALID',
      );

      // Medium #1: non-created issue_comment ('edited', 'deleted'), non-submitted pull_request_review ('edited'), and non-PR issue_comment -> ignored!
      for (const action of ['edited', 'deleted'] as const) {
        const nonCreated = await resolveTaskpackSuite({
          repositoryRoot: repoRoot,
          loadedSuite: loaded,
          baseRevision: baseSha,
          repositoryFullName: 'octo/mono',
          eventName: 'issue_comment',
          eventPayload: {
            action,
            issue: { number: 10, pull_request: {} },
            comment: { body: '/loopwright retry', author_association: 'MEMBER', user: { login: 'dev', type: 'User' } },
          },
        });
        assert.equal(nonCreated.disposition, 'ignored', `expected issue_comment action=${action} to be ignored`);
      }

      const editedReview = await resolveTaskpackSuite({
        repositoryRoot: repoRoot,
        loadedSuite: loaded,
        baseRevision: baseSha,
        repositoryFullName: 'octo/mono',
        eventName: 'pull_request_review',
        eventPayload: {
          action: 'edited',
          pull_request: {
            number: 10,
            head: { ref: 'loopwright/docs/main', sha: headSha, repo: { full_name: 'octo/mono', fork: false } },
            base: { ref: 'main' },
          },
          review: { body: '/loopwright retry', author_association: 'MEMBER', user: { login: 'dev', type: 'User' } },
        },
      });
      assert.equal(editedReview.disposition, 'ignored');

      const plainIssueComment = await resolveTaskpackSuite({
        repositoryRoot: repoRoot,
        loadedSuite: loaded,
        baseRevision: baseSha,
        repositoryFullName: 'octo/mono',
        eventName: 'issue_comment',
        eventPayload: {
          action: 'created',
          issue: { number: 10 },
          comment: { body: '/loopwright retry', author_association: 'MEMBER', user: { login: 'dev', type: 'User' } },
        },
      });
      assert.equal(plainIssueComment.disposition, 'ignored');

      // Medium #1: webhook payload missing actorLogin OR authorAssociation fails closed with WEBHOOK_ACTOR_UNAUTHORIZED!
      for (const badComment of [
        { body: '/loopwright retry', author_association: 'MEMBER', user: { type: 'User' } },
        { body: '/loopwright retry', user: { login: 'dev', type: 'User' } },
      ]) {
        const missingAttr = await resolveTaskpackSuite({
          repositoryRoot: repoRoot,
          loadedSuite: loaded,
          baseRevision: baseSha,
          repositoryFullName: 'octo/mono',
          eventName: 'issue_comment',
          eventPayload: {
            action: 'created',
            issue: { number: 10, pull_request: {} },
            comment: badComment,
          },
        });
        assert.equal(missingAttr.disposition, 'blocked');
        assert.equal(missingAttr.code, 'WEBHOOK_ACTOR_UNAUTHORIZED');
      }

      // Partial CLI attribution (actorLogin without authorAssociation) also blocks strictly
      const partialCliAttr = await resolveTaskpackSuite({
        repositoryRoot: repoRoot,
        loadedSuite: loaded,
        baseRevision: baseSha,
        eventName: 'issue_comment',
        commentBody: '/loopwright retry',
        actorLogin: 'dev',
        prHeadRef: 'loopwright/docs/main',
        prBaseRef: 'main',
      });
      assert.equal(partialCliAttr.disposition, 'blocked');
      assert.equal(partialCliAttr.code, 'WEBHOOK_ACTOR_UNAUTHORIZED');

      // Medium #2: fail closed on null/missing/mismatched head.repo & wire headSha on valid same-repo PR
      for (const badHeadRepo of [
        null,
        {},
        { full_name: 'fork-owner/mono', fork: false },
      ]) {
        const forkBlocked = await resolveTaskpackSuite({
          repositoryRoot: repoRoot,
          loadedSuite: loaded,
          baseRevision: baseSha,
          repositoryFullName: 'octo/mono',
          eventName: 'pull_request_review',
          eventPayload: {
            action: 'submitted',
            pull_request: {
              number: 11,
              head: { ref: 'loopwright/docs/main', sha: headSha, repo: badHeadRepo },
              base: { ref: 'main' },
            },
            review: { body: '/loopwright retry', author_association: 'MEMBER', user: { login: 'dev', type: 'User' } },
          },
        });
        assert.equal(forkBlocked.disposition, 'blocked');
        assert.equal(forkBlocked.code, 'TASKPACK_SCOPE_VIOLATION');
        assert.equal(forkBlocked.reason, 'cross_fork_pull_request');
      }

      // Webhook PR comment with missing repositoryFullName & no GITHUB_REPOSITORY fails closed!
      const missingRepoEnvBlocked = await resolveTaskpackSuite({
        repositoryRoot: repoRoot,
        loadedSuite: loaded,
        baseRevision: baseSha,
        env: {},
        eventName: 'pull_request_review',
        eventPayload: {
          action: 'submitted',
          pull_request: {
            number: 11,
            head: { ref: 'loopwright/docs/main', sha: headSha, repo: { full_name: 'octo/mono', fork: false } },
            base: { ref: 'main' },
          },
          review: { body: '/loopwright retry', author_association: 'MEMBER', user: { login: 'dev', type: 'User' } },
        },
      });
      assert.equal(missingRepoEnvBlocked.disposition, 'blocked');
      assert.equal(missingRepoEnvBlocked.code, 'TASKPACK_SCOPE_VIOLATION');

      // Valid submitted review with GITHUB_REPOSITORY env wires headSha onto cell & eligibleCells!
      const validReviewWithSha = await resolveTaskpackSuite({
        repositoryRoot: repoRoot,
        loadedSuite: loaded,
        baseRevision: baseSha,
        env: { GITHUB_REPOSITORY: 'octo/mono' },
        eventName: 'pull_request_review',
        eventPayload: {
          action: 'submitted',
          pull_request: {
            number: 11,
            head: { ref: 'loopwright/docs/main', sha: headSha.toUpperCase(), repo: { full_name: 'Octo/Mono', fork: false } },
            base: { ref: 'main' },
          },
          review: { body: '/loopwright retry', author_association: 'MEMBER', user: { login: 'dev', type: 'User' } },
        },
      });
      assert.equal(validReviewWithSha.disposition, 'eligible');
      assert.equal(validReviewWithSha.cells[0]?.headSha, headSha);
      assert.equal(validReviewWithSha.eligibleCells[0]?.headSha, headSha);

      // Invalid prHeadSha format blocks cleanly
      const badShaRes = await resolveTaskpackSuite({
        repositoryRoot: repoRoot,
        loadedSuite: loaded,
        baseRevision: baseSha,
        eventName: 'issue_comment',
        commentBody: '/loopwright retry',
        prHeadRef: 'loopwright/docs/main',
        prBaseRef: 'main',
        prHeadSha: 'not-a-40-char-sha',
      });
      assert.equal(badShaRes.disposition, 'blocked');
      assert.equal(badShaRes.code, 'ACTION_INPUT_INVALID');

      // Medium #4: Stage A (mode: pull_request) without findOpenPullRequest, repositoryFullName/GITHUB_REPOSITORY, or allowOfflineStagePrCheck -> blocked!
      const missingPrLookupCtx = await resolveTaskpackSuite({
        repositoryRoot: repoRoot,
        loadedSuite: loaded,
        baseRevision: baseSha,
        env: {},
        domain: 'runtime',
      });
      assert.equal(missingPrLookupCtx.disposition, 'blocked');
      assert.equal(missingPrLookupCtx.reason, 'stage_pr_lookup_unavailable');

      // Medium #3 + #4: GITHUB_REPOSITORY env auto-fallback + bounded pagination on git-tag (> 100 tags, match on page 2) & github-release (Link rel="next", match on page 2) -> eligible!
      let tagPagesFetched = 0;
      let relPagesFetched = 0;
      const page2Eligible = await resolveTaskpackSuite({
        repositoryRoot: repoRoot,
        loadedSuite: loaded,
        baseRevision: baseSha,
        env: { GITHUB_REPOSITORY: 'octo/mono', GITHUB_TOKEN: 'ghs_envFallbackToken123456' },
        apiBaseUrl: 'https://api.example.test',
        domain: 'runtime',
        fetchImpl: async url => {
          const u = String(url);
          if (u.includes('/repos/octo/mono/pulls?')) {
            return new Response(JSON.stringify([]), { status: 200 });
          }
          if (u.includes('/repos/octo/paginated-tags/tags')) {
            tagPagesFetched += 1;
            if (!u.includes('page=2')) {
              const p1 = Array.from({ length: 100 }, (_, i) => ({ name: `v1.0.${i}` }));
              return new Response(JSON.stringify(p1), { status: 200 });
            }
            return new Response(JSON.stringify([{ name: 'v2.5.0' }]), { status: 200 });
          }
          if (u.includes('/repos/octo/paginated-releases/releases')) {
            relPagesFetched += 1;
            if (!u.includes('page=2')) {
              const p1 = Array.from({ length: 30 }, (_, i) => ({ tag_name: `v1.0.${i}`, draft: false, prerelease: false }));
              return new Response(JSON.stringify(p1), {
                status: 200,
                headers: { link: '<https://api.example.test/repos/octo/paginated-releases/releases?per_page=30&page=2>; rel="next"' },
              });
            }
            return new Response(JSON.stringify([{ tag_name: 'v2.5.0-rc.1', draft: false, prerelease: true }]), { status: 200 });
          }
          return new Response('unexpected', { status: 500 });
        },
      });
      assert.equal(page2Eligible.disposition, 'eligible');
      assert.equal(tagPagesFetched, 2);
      assert.equal(relPagesFetched, 2);

      // Medium #3: 10 full pages of tags without match -> fail closed as blocked (probe_pagination_exhausted)!
      let exhaustedTagPages = 0;
      const tagExhausted = await resolveTaskpackSuite({
        repositoryRoot: repoRoot,
        loadedSuite: loaded,
        baseRevision: baseSha,
        findOpenPullRequest: async () => null,
        apiBaseUrl: 'https://api.example.test',
        domain: 'runtime',
        fetchImpl: async url => {
          const u = String(url);
          if (u.includes('/repos/octo/paginated-tags/tags')) {
            exhaustedTagPages += 1;
            return new Response(
              JSON.stringify(Array.from({ length: 100 }, (_, i) => ({ name: `v0.${exhaustedTagPages}.${i}` }))),
              { status: 200 },
            );
          }
          return new Response(JSON.stringify([{ tag_name: 'v2.5.0-rc.1', draft: false, prerelease: true }]), { status: 200 });
        },
      });
      assert.equal(tagExhausted.disposition, 'blocked');
      assert.equal(exhaustedTagPages, 10);
      assert.equal(
        tagExhausted.cells[0]?.probes?.some(p => p.kind === 'git-tag' && p.reason === 'probe_pagination_exhausted'),
        true,
      );

      // Medium #3: 10 pages of releases with Link rel="next" without match -> fail closed as blocked (probe_pagination_exhausted)!
      let exhaustedRelPages = 0;
      const relExhausted = await resolveTaskpackSuite({
        repositoryRoot: repoRoot,
        loadedSuite: loaded,
        baseRevision: baseSha,
        findOpenPullRequest: async () => null,
        apiBaseUrl: 'https://api.example.test',
        domain: 'runtime',
        fetchImpl: async url => {
          const u = String(url);
          if (u.includes('/repos/octo/paginated-tags/tags')) {
            return new Response(JSON.stringify([{ name: 'v2.5.0' }]), { status: 200 });
          }
          exhaustedRelPages += 1;
          return new Response(
            JSON.stringify([{ tag_name: `v0.0.${exhaustedRelPages}`, draft: false, prerelease: false }]),
            {
              status: 200,
              headers: {
                link: `<https://api.example.test/repos/octo/paginated-releases/releases?per_page=30&page=${exhaustedRelPages + 1}>; rel="next"`,
              },
            },
          );
        },
      });
      assert.equal(relExhausted.disposition, 'blocked');
      assert.equal(exhaustedRelPages, 10);
      assert.equal(
        relExhausted.cells[0]?.probes?.some(p => p.kind === 'github-release' && p.reason === 'probe_pagination_exhausted'),
        true,
      );
      // Cross-origin pagination Link header is refused as blocked (never forwards auth headers to another origin)
      const crossOriginLink = await resolveTaskpackSuite({
        repositoryRoot: repoRoot,
        loadedSuite: loaded,
        baseRevision: baseSha,
        findOpenPullRequest: async () => null,
        apiBaseUrl: 'https://api.example.test',
        domain: 'runtime',
        prHeadSha: headSha,
        fetchImpl: async url => {
          const u = String(url);
          if (u.includes('/repos/octo/paginated-tags/tags')) {
            return new Response(JSON.stringify([{ name: 'v0.0.1' }]), {
              status: 200,
              headers: { link: '<https://evil.example.test/steal?page=2>; rel="next"' },
            });
          }
          return new Response(JSON.stringify([{ tag_name: 'v2.5.0-rc.1', draft: false, prerelease: true }]), { status: 200 });
        },
      });
      assert.equal(crossOriginLink.disposition, 'blocked');

      // Direct domain with invalid prHeadSha, non-object eventPayload, and multi-domain schedule with blocked upstream checkDomainUpdates
      const badDirectSha = await resolveTaskpackSuite({
        repositoryRoot: repoRoot,
        loadedSuite: loaded,
        baseRevision: baseSha,
        domain: 'docs',
        prHeadSha: 'bad-sha',
      });
      assert.equal(badDirectSha.disposition, 'blocked');

      const nonObjectPayload = await resolveTaskpackSuite({
        repositoryRoot: repoRoot,
        loadedSuite: loaded,
        baseRevision: baseSha,
        eventName: 'issue_comment',
        eventPayload: 'not-an-object',
      });
      assert.equal(nonObjectPayload.disposition, 'blocked');

      const multiScheduleBlocked = await resolveTaskpackSuite({
        repositoryRoot: repoRoot,
        loadedSuite: loaded,
        baseRevision: baseSha,
        eventName: 'workflow_dispatch',
        findOpenPullRequest: async () => null,
        checkDomainUpdates: async () => {
          throw new Error('upstream check failed');
        },
      });
      assert.equal(multiScheduleBlocked.disposition, 'blocked');
    });

    // Low #1: carved-out proposal inside .loopwright with > 128 sibling files refuses loadTaskpackSuite with TASKPACK_MANIFEST_INVALID!
    await withTempDir(async overflowRoot => {
      initGitRepo(overflowRoot, 'main');
      await mkdir(join(overflowRoot, '.loopwright'), { recursive: true });
      for (let i = 0; i < 130; i += 1) {
        await writeFile(join(overflowRoot, '.loopwright', `sib-${String(i).padStart(3, '0')}.txt`), `s${i}\n`, 'utf8');
      }
      await writeFile(
        join(overflowRoot, '.loopwright', 'carved-pack.yaml'),
        domainManifestYaml({
          name: 'carved-root-pack',
          proposalPath: '.loopwright/proposal.json',
          writable: ['.loopwright/proposal.json', 'docs/**'],
        }),
        'utf8',
      );
      await writeFile(
        join(overflowRoot, '.loopwright', 'suite.yaml'),
        [
          'apiVersion: loopwright.dev/v1alpha1',
          'kind: TaskpackSuite',
          'metadata:',
          '  name: carved-overflow-suite',
          'spec:',
          '  domains:',
          '    - id: docs',
          '      taskpack: .loopwright/carved-pack.yaml',
        ].join('\n') + '\n',
        'utf8',
      );
      await assert.rejects(
        loadTaskpackSuite({ repositoryRoot: overflowRoot }),
        (err: unknown) => err instanceof TaskpackError && err.code === 'TASKPACK_MANIFEST_INVALID',
      );
    });
  });
});
