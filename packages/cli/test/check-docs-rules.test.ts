import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
        // ignore parse errors
      }
    }
    curr = dirname(curr);
  }
  return resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
}

const REPO_ROOT = findRepositoryRoot();
const CHECK_DOCS_PATH = join(REPO_ROOT, 'scripts', 'check-docs.mjs');

interface CheckDocsResult {
  ok: boolean;
  mode: 'strict' | 'report';
  errors: string[];
  warnings: string[];
  summary: string;
}

type CheckDocsFn = (
  options?: string | { repoRoot?: string; rootDir?: string; mode?: 'strict' | 'report' }
) => CheckDocsResult;

async function loadCheckDocs(): Promise<CheckDocsFn> {
  const mod = (await import(pathToFileURL(CHECK_DOCS_PATH).href)) as {
    checkDocs: CheckDocsFn;
  };
  return mod.checkDocs;
}

interface PageSpec {
  readonly relPath: string;
  readonly title: string;
}

const CANONICAL_PAGES: readonly PageSpec[] = [
  { relPath: 'getting-started/architecture.md', title: 'Architecture' },
  { relPath: 'getting-started/installation.md', title: 'Installation' },
  { relPath: 'operations/github-action.md', title: 'GitHub Action' },
  { relPath: 'operations/github-app.md', title: 'GitHub App' },
  { relPath: 'operations/cli.md', title: 'CLI' },
  { relPath: 'walkthroughs/declarative-taskpack.md', title: 'Declarative Taskpack' },
  { relPath: 'walkthroughs/managed-controller.md', title: 'Managed Controller' },
  { relPath: 'configuration/taskpack.md', title: 'Taskpack' },
  { relPath: 'configuration/task-contract.md', title: 'Task Contract' },
  { relPath: 'configuration/controller-and-registry.md', title: 'Controller and Registry' },
  { relPath: 'configuration/sandbox-backends.md', title: 'Sandbox Backends' },
  { relPath: 'configuration/decision-routing.md', title: 'Decision Routing' },
  { relPath: 'development.md', title: 'Development and Verification' },
  { relPath: 'contribute/internals.md', title: 'Workspace Internals and Boundaries' },
  { relPath: 'contribute/identity.md', title: 'Canonical Identity and Digests' },
  { relPath: 'contribute/evidence.md', title: 'Verification Evidence and Authority' },
  { relPath: 'contribute/state.md', title: 'Persistent Local State Store' },
  { relPath: 'contribute/pi-adapter.md', title: 'Isolated Pi Runtime Adapter' },
  { relPath: 'contribute/runner-taskpack.md', title: 'Runner Taskpack and Offline Parity' },
  { relPath: 'contribute/memory.md', title: 'Reviewed Memory and CAS Compaction' },
  { relPath: 'contribute/github-app-internals.md', title: 'GitHub App Control Plane Internals' },
  { relPath: 'contribute/closure-matrix.md', title: 'Capability Closure Matrix and Failure Semantics' },
  { relPath: 'contribute/adr/0001-local-state-authority.md', title: 'ADR 0001: Local State Authority' },
  { relPath: 'contribute/adr/0002-isolated-pi-sdk.md', title: 'ADR 0002: Isolated Pi SDK' },
];

function writeFileEnsuringDir(filePath: string, content: string): void {
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, content, 'utf8');
}

function buildCleanPageContent(page: PageSpec): string {
  if (page.relPath === 'getting-started/architecture.md') {
    return [
      `# ${page.title}`,
      '',
      'Loopwright executes bounded repository work across four verified stages.',
      '',
      '## Contents',
      '',
      '- [Execution chain](#execution-chain)',
      '- [Step 1: Generate draft configs](#step-1-generate-draft-configs)',
      '',
      '## Execution chain',
      '',
      '![Architecture diagram](../assets/diagrams/architecture-flow.svg)',
      '',
      '<!-- flowchart LR',
      '  admit -> execute -> verify -> publish',
      '-->',
      '',
      'The controller enforces lease fences and independent verification hooks.',
      '',
      '## Step 1: Generate draft configs',
      '',
      '```yaml',
      'apiVersion: loopwright.dev/v1alpha1',
      'kind: ControllerConfig',
      'spec: {}',
      '```',
      '',
      '| Stage | Owner | Boundary |',
      '| --- | --- | --- |',
      '| Admit | StateStore | Lease fence |',
      '',
      '---',
      '',
      '**See also** — [Task Contract](../configuration/task-contract.md) (scope, budgets, and acceptance fields) · [Sandbox Backends](../configuration/sandbox-backends.md) (native OS and container isolation)',
      '',
      '**Next** → [GitHub Action](../operations/github-action.md) — configure the reusable Action in consumer workflows.',
      '',
    ].join('\n');
  }

  const depth = page.relPath.split('/').length - 1;
  const upPrefix = '../'.repeat(depth);
  const archLink = `${upPrefix}getting-started/architecture.md`;
  const contractsLink = `${upPrefix}configuration/task-contract.md`;

  return [
    `# ${page.title}`,
    '',
    'Loopwright enforces explicit schemas and deterministic runtime boundaries.',
    '',
    '## Contents',
    '',
    '- [Overview](#overview)',
    '- [Configuration](#configuration)',
    '',
    '## Overview',
    '',
    'Each module validates inputs before executing state transitions.',
    '',
    '## Configuration',
    '',
    '```yaml',
    'apiVersion: loopwright.dev/v1alpha1',
    'kind: Taskpack',
    'metadata:',
    '  name: sample',
    'spec: {}',
    '```',
    '',
    '| Field | Type | Default |',
    '| --- | --- | --- |',
    '| `name` | `string` | `sample` |',
    '',
    '---',
    '',
    `**See also** — [Architecture](${archLink}) (four-stage execution chain and vocabulary)`,
    '',
    `**Next** → [Task Contract](${contractsLink}) — inspect task contract fields and verification bounds.`,
    '',
  ].join('\n');
}

function buildMinimalRepoFixture(): string {
  const root = mkdtempSync(join(tmpdir(), 'loopwright-check-docs-'));

  const packages = [
    'core',
    'state',
    'agent-pi',
    'controller',
    'taskpack-runner',
    'memory',
    'github-app',
    'decisions',
    'cli',
  ];
  for (const pkg of packages) {
    mkdirSync(join(root, 'packages', pkg), { recursive: true });
  }

  const specFile = 'specs/2026-11-05-task-contracts-and-evidence.md';
  writeFileEnsuringDir(join(root, specFile), '# Spec\n');

  const skills = [
    'loopwright-overview',
    'loopwright-docs',
    'loopwright-code-review',
    'loopwright-issue-pr',
    'loopwright-release',
  ];
  for (const s of skills) {
    writeFileEnsuringDir(
      join(root, '.agents', 'skills', s, 'SKILL.md'),
      `---\nname: ${s}\ndescription: test\n---\n\n# ${s}\n\nSee [index](../../../docs/README.md).\n`
    );
  }

  writeFileEnsuringDir(
    join(root, 'docs', 'assets', 'diagrams', 'architecture-flow.svg'),
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 40"></svg>\n'
  );

  writeFileEnsuringDir(join(root, 'README.md'), '# Loopwright\n\nSee [Documentation](docs/README.md).\n');
  writeFileEnsuringDir(join(root, 'AGENTS.md'), '# Agent Guide\n\nSee [module map](docs/README.md#module-map).\n');
  writeFileEnsuringDir(
    join(root, 'examples', 'controller.md'),
    '# Controller Example\n\n```yaml\napiVersion: loopwright.dev/v1alpha1\nkind: ControllerConfig\nspec: {}\n```\n'
  );

  for (const page of CANONICAL_PAGES) {
    writeFileEnsuringDir(join(root, 'docs', page.relPath), buildCleanPageContent(page));
  }

  writeFileEnsuringDir(
    join(root, 'site', 'data', 'navigation.yaml'),
    [
      'groups:',
      '  - name: Getting Started',
      '    items:',
      '      - /docs/getting-started/architecture/',
      '      - /docs/getting-started/installation/',
      '  - name: Operations',
      '    items:',
      '      - /docs/operations/github-action/',
      '      - /docs/operations/github-app/',
      '      - /docs/operations/cli/',
      '  - name: Walkthroughs',
      '    items:',
      '      - /docs/walkthroughs/declarative-taskpack/',
      '      - /docs/walkthroughs/managed-controller/',
      '  - name: Configuration',
      '    items:',
      '      - /docs/configuration/taskpack/',
      '      - /docs/configuration/task-contract/',
      '      - /docs/configuration/controller-and-registry/',
      '      - /docs/configuration/sandbox-backends/',
      '      - /docs/configuration/decision-routing/',
      'labels:',
      '  /docs/getting-started/architecture/: Architecture',
      '  /docs/getting-started/installation/: Installation',
      '  /docs/operations/github-action/: GitHub Action',
      '  /docs/operations/github-app/: GitHub App',
      '  /docs/operations/cli/: CLI',
      '  /docs/walkthroughs/declarative-taskpack/: Declarative Taskpack',
      '  /docs/walkthroughs/managed-controller/: Managed Controller',
      '  /docs/configuration/taskpack/: Taskpack',
      '  /docs/configuration/task-contract/: Task Contract',
      '  /docs/configuration/controller-and-registry/: Controller and Registry',
      '  /docs/configuration/sandbox-backends/: Sandbox Backends',
      '  /docs/configuration/decision-routing/: Decision Routing',
      '',
    ].join('\n')
  );

  const allPagesRows = CANONICAL_PAGES.map(
    p => `| [${p.title}](${p.relPath}) | ${p.title} reference |`
  ).join('\n');

  const docsIndex = [
    '# Loopwright Documentation',
    '',
    '## Reading paths',
    '',
    '- [Architecture](getting-started/architecture.md)',
    '',
    '## Module map',
    '',
    '### Contracts and Evidence',
    '',
    '- ID: contracts',
    '- Use for: contracts',
    '- Aliases: contracts',
    '- Guides: [configuration/task-contract.md](configuration/task-contract.md), [contribute/identity.md](contribute/identity.md), [contribute/evidence.md](contribute/evidence.md)',
    `- Specs: [Specification](../${specFile})`,
    '- Code: [core](../packages/core/)',
    '- Skills: [overview](../.agents/skills/loopwright-overview/SKILL.md)',
    '',
    '### Persistent State Store',
    '',
    '- ID: state',
    '- Use for: state',
    '- Aliases: state',
    '- Guides: [contribute/state.md](contribute/state.md)',
    `- Specs: [Specification](../${specFile})`,
    '- Code: [state](../packages/state/)',
    '- Skills: [overview](../.agents/skills/loopwright-overview/SKILL.md)',
    '',
    '### Isolated Pi Adapter',
    '',
    '- ID: pi-adapter',
    '- Use for: pi-adapter',
    '- Aliases: pi-adapter',
    '- Guides: [configuration/sandbox-backends.md](configuration/sandbox-backends.md), [contribute/pi-adapter.md](contribute/pi-adapter.md)',
    `- Specs: [Specification](../${specFile})`,
    '- Code: [agent-pi](../packages/agent-pi/)',
    '- Skills: [overview](../.agents/skills/loopwright-overview/SKILL.md)',
    '',
    '### Bounded Controller and CLI',
    '',
    '- ID: controller',
    '- Use for: controller',
    '- Aliases: controller',
    '- Guides: [configuration/controller-and-registry.md](configuration/controller-and-registry.md), [operations/cli.md](operations/cli.md), [contribute/closure-matrix.md](contribute/closure-matrix.md)',
    `- Specs: [Specification](../${specFile})`,
    '- Code: [controller](../packages/controller/)',
    '- Skills: [overview](../.agents/skills/loopwright-overview/SKILL.md)',
    '',
    '### Declarative Taskpacks and Runner Parity',
    '',
    '- ID: taskpacks',
    '- Use for: taskpacks',
    '- Aliases: taskpacks',
    '- Guides: [walkthroughs/declarative-taskpack.md](walkthroughs/declarative-taskpack.md), [contribute/runner-taskpack.md](contribute/runner-taskpack.md)',
    `- Specs: [Specification](../${specFile})`,
    '- Code: [taskpack-runner](../packages/taskpack-runner/)',
    '- Skills: [overview](../.agents/skills/loopwright-overview/SKILL.md)',
    '',
    '### Reviewed Memory and Compaction',
    '',
    '- ID: memory',
    '- Use for: memory',
    '- Aliases: memory',
    '- Guides: [contribute/memory.md](contribute/memory.md)',
    `- Specs: [Specification](../${specFile})`,
    '- Code: [memory](../packages/memory/)',
    '- Skills: [overview](../.agents/skills/loopwright-overview/SKILL.md)',
    '',
    '### GitHub App and Action Control Plane',
    '',
    '- ID: github-app',
    '- Use for: github-app',
    '- Aliases: github-app',
    '- Guides: [operations/github-action.md](operations/github-action.md), [operations/github-app.md](operations/github-app.md), [contribute/github-app-internals.md](contribute/github-app-internals.md)',
    `- Specs: [Specification](../${specFile})`,
    '- Code: [github-app](../packages/github-app/)',
    '- Skills: [overview](../.agents/skills/loopwright-overview/SKILL.md)',
    '',
    '### System-One Decision Routing',
    '',
    '- ID: decisions',
    '- Use for: decisions',
    '- Aliases: decisions',
    '- Guides: [configuration/decision-routing.md](configuration/decision-routing.md)',
    `- Specs: [Specification](../${specFile})`,
    '- Code: [decisions](../packages/decisions/)',
    '- Skills: [overview](../.agents/skills/loopwright-overview/SKILL.md)',
    '',
    '### Development and Release',
    '',
    '- ID: development',
    '- Use for: development',
    '- Aliases: development',
    '- Guides: [development.md](development.md), [contribute/internals.md](contribute/internals.md)',
    `- Specs: [Specification](../${specFile})`,
    '- Code: [cli](../packages/cli/)',
    '- Skills: [overview](../.agents/skills/loopwright-overview/SKILL.md), [docs](../.agents/skills/loopwright-docs/SKILL.md), [code-review](../.agents/skills/loopwright-code-review/SKILL.md), [issue-pr](../.agents/skills/loopwright-issue-pr/SKILL.md), [release](../.agents/skills/loopwright-release/SKILL.md)',
    '',
    '## Specs',
    '',
    '| Specification | Scope |',
    '| --- | --- |',
    `| [2026-11-05-task-contracts-and-evidence.md](../${specFile}) | contracts |`,
    '',
    '## All pages',
    '',
    '| Page | Description |',
    '| --- | --- |',
    allPagesRows,
    '',
  ].join('\n');

  writeFileEnsuringDir(join(root, 'docs', 'README.md'), docsIndex);
  return root;
}

test('expanded loopwright-* skills and openai.yaml exist and satisfy AC-2 contracts', () => {
  const docsSkill = readFileSync(join(REPO_ROOT, '.agents/skills/loopwright-docs/SKILL.md'), 'utf8');
  assert.match(docsSkill, /references\/page-map\.md/);
  assert.match(docsSkill, /references\/conventions\.md/);
  assert.match(docsSkill, /npm run lint:docs/);
  assert.match(docsSkill, /npm run site/);

  const conventions = readFileSync(
    join(REPO_ROOT, '.agents/skills/loopwright-docs/references/conventions.md'),
    'utf8'
  );
  assert.match(conventions, /ASD-STE100/);
  assert.match(conventions, /#5B4B9E/);
  assert.match(conventions, /#3B8EA5/);
  assert.match(conventions, /#D89B48/);
  assert.match(conventions, /\*\*See also\*\* — /);
  assert.match(conventions, /\*\*Next\*\* → /);

  const pageMap = readFileSync(
    join(REPO_ROOT, '.agents/skills/loopwright-docs/references/page-map.md'),
    'utf8'
  );
  for (const page of CANONICAL_PAGES) {
    assert.ok(pageMap.includes(page.relPath), `page-map.md must list ${page.relPath}`);
  }
  assert.match(pageMap, /no \(repo-only\)/);

  const issuePrSkill = readFileSync(join(REPO_ROOT, '.agents/skills/loopwright-issue-pr/SKILL.md'), 'utf8');
  assert.match(issuePrSkill, /\[Bug\]/);
  assert.match(issuePrSkill, /\[Feat\]/);
  assert.match(issuePrSkill, /mcp__github__create_issue/);
  assert.match(issuePrSkill, /Signed-off-by/);

  const releaseSkill = readFileSync(join(REPO_ROOT, '.agents/skills/loopwright-release/SKILL.md'), 'utf8');
  assert.match(releaseSkill, /disable-model-invocation:\s*true/);
  assert.match(releaseSkill, /\^v\[0-9\]\+\\\.\[0-9\]\+\\\.\[0-9\]\+\(-rc\(\\\.\[0-9\]\+\|\[0-9\]\+\)\)\?\$/);
  assert.match(releaseSkill, /closure --verify-failures/);
  assert.match(releaseSkill, /docs\/contribute\/closure-matrix\.md/);

  const openaiYaml = readFileSync(
    join(REPO_ROOT, '.agents/skills/loopwright-release/agents/openai.yaml'),
    'utf8'
  );
  assert.match(openaiYaml, /allow_implicit_invocation:\s*false/);
  assert.match(openaiYaml, /display_name:\s*"Loopwright Release"/);

  const reviewSkill = readFileSync(
    join(REPO_ROOT, '.agents/skills/loopwright-code-review/SKILL.md'),
    'utf8'
  );
  assert.match(reviewSkill, /## Standards/);
  assert.match(reviewSkill, /## Spec/);
  assert.match(reviewSkill, /delete:/);
  assert.match(reviewSkill, /yagni:/);
  assert.match(reviewSkill, /Blocking/);
  assert.match(reviewSkill, /All YAML parsing uses the pinned yaml@2\.9\.0 package/);

  const overviewSkill = readFileSync(join(REPO_ROOT, '.agents/skills/loopwright-overview/SKILL.md'), 'utf8');
  assert.match(overviewSkill, /controller\.draft\.yaml/);
  assert.match(overviewSkill, /registry\.draft\.yaml/);
  assert.match(overviewSkill, /github-app\.yaml/);
  assert.match(overviewSkill, /decisions\.yaml/);
});

test('checkDocs: passes with 0 errors on a clean synthetic repository fixture', async () => {
  const checkDocs = await loadCheckDocs();
  const root = buildMinimalRepoFixture();
  try {
    const result = checkDocs({ repoRoot: root, mode: 'strict' });
    assert.equal(result.ok, true, `Expected clean synthetic repo to pass, got:\n${result.errors.join('\n')}`);
    assert.equal(result.errors.length, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('checkDocs rule 1: enforces heading word/char caps, Step N: <Action> caps, and interrogative bans', async () => {
  const checkDocs = await loadCheckDocs();
  const root = buildMinimalRepoFixture();
  try {
    writeFileEnsuringDir(
      join(root, 'docs', 'configuration', 'task-contract.md'),
      [
        '# Task Contract',
        '',
        'Short intro.',
        '',
        '## Contents',
        '',
        '- [Five words in this heading](#five-words-in-this-heading)',
        '- [Step 1: Execute five words after colon](#step-1-execute-five-words-after-colon)',
        '- [Why contracts matter](#why-contracts-matter)',
        '',
        '## Five words in this heading',
        '',
        'Body text.',
        '',
        '## Step 1: Execute five words after colon',
        '',
        'Body text.',
        '',
        '## Why contracts matter',
        '',
        'Body text.',
        '',
        '---',
        '',
        '**See also** — [Architecture](../getting-started/architecture.md) (execution flow)',
        '',
        '**Next** → [Controller and Registry](controller-and-registry.md) — configure controller drafts.',
        '',
      ].join('\n')
    );

    const result = checkDocs({ repoRoot: root, mode: 'strict' });
    assert.equal(result.ok, false);
    assert.ok(
      result.errors.some(e => e.includes('docs/configuration/task-contract.md') && e.includes('heading exceeds cap')),
      `Expected standard heading cap error, got: ${result.errors.join('\n')}`
    );
    assert.ok(
      result.errors.some(e => e.includes('docs/configuration/task-contract.md') && e.includes('Step heading exceeds cap')),
      `Expected Step heading cap error, got: ${result.errors.join('\n')}`
    );
    assert.ok(
      result.errors.some(e => e.includes('docs/configuration/task-contract.md') && e.includes('interrogative')),
      `Expected interrogative heading error, got: ${result.errors.join('\n')}`
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('checkDocs rule 2: enforces <= 10 H2 sections and page line caps (200 architecture, 220 ADR, 400 standard)', async () => {
  const checkDocs = await loadCheckDocs();
  const root = buildMinimalRepoFixture();
  try {
    const h2Names = Array.from({ length: 11 }, (_, idx) => `Section ${idx + 1}`);
    const tocLines = h2Names.map(name => `- [${name}](#${name.toLowerCase().replace(/\s+/g, '-')})`);
    const bodySections = h2Names.flatMap(name => [`## ${name}`, '', 'Short body.', '']);
    writeFileEnsuringDir(
      join(root, 'docs', 'configuration', 'task-contract.md'),
      [
        '# Task Contract',
        '',
        'Intro text.',
        '',
        '## Contents',
        '',
        ...tocLines,
        '',
        ...bodySections,
        '---',
        '',
        '**See also** — [Architecture](../getting-started/architecture.md) (execution flow)',
        '',
        '**Next** → [Controller and Registry](controller-and-registry.md) — configure controller drafts.',
        '',
      ].join('\n')
    );

    const adrPadding = Array.from({ length: 225 }, (_, i) => `- Bullet item ${i + 1}`);
    writeFileEnsuringDir(
      join(root, 'docs', 'contribute', 'adr', '0001-local-state-authority.md'),
      [
        '# ADR 0001: Local State Authority',
        '',
        'Intro text.',
        '',
        '## Contents',
        '',
        '- [Context](#context)',
        '',
        '## Context',
        '',
        ...adrPadding,
        '',
        '---',
        '',
        '**See also** — [Architecture](../../getting-started/architecture.md) (execution flow)',
        '',
      ].join('\n')
    );

    const result = checkDocs({ repoRoot: root, mode: 'strict' });
    assert.equal(result.ok, false);
    assert.ok(
      result.errors.some(e => e.includes('docs/configuration/task-contract.md') && e.includes('H2 section count exceeds 10')),
      `Expected H2 section cap error, got: ${result.errors.join('\n')}`
    );
    assert.ok(
      result.errors.some(
        e => e.includes('docs/contribute/adr/0001-local-state-authority.md') && e.includes('line count exceeds 220 lines')
      ),
      `Expected ADR 220-line cap error, got: ${result.errors.join('\n')}`
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('checkDocs rule 3: enforces prose paragraph caps (<= 5 lines and <= 500 chars) while excluding trailing reading footer', async () => {
  const checkDocs = await loadCheckDocs();
  const root = buildMinimalRepoFixture();
  try {
    const sixLineParagraph = [
      'Line one of a prose paragraph.',
      'Line two of a prose paragraph.',
      'Line three of a prose paragraph.',
      'Line four of a prose paragraph.',
      'Line five of a prose paragraph.',
      'Line six pushes this paragraph over the five-line cap.',
    ].join('\n');

    writeFileEnsuringDir(
      join(root, 'docs', 'contribute', 'state.md'),
      [
        '# Persistent Local State Store',
        '',
        'Short intro.',
        '',
        '## Contents',
        '',
        '- [Overview](#overview)',
        '',
        '## Overview',
        '',
        sixLineParagraph,
        '',
        '---',
        '',
        '**See also** — [Loopwright Architecture](../getting-started/architecture.md) (execution flow)',
        '',
      ].join('\n')
    );

    const result = checkDocs({ repoRoot: root, mode: 'strict' });
    assert.equal(result.ok, false);
    assert.ok(
      result.errors.some(e => e.includes('docs/contribute/state.md') && e.includes('prose paragraph exceeds cap')),
      `Expected prose paragraph cap error, got: ${result.errors.join('\n')}`
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('checkDocs rule 4: enforces table header word/char caps, banned articles/demonstratives, column counts, and 180-char cells', async () => {
  const checkDocs = await loadCheckDocs();
  const root = buildMinimalRepoFixture();
  try {
    const longCell = 'x'.repeat(185);
    writeFileEnsuringDir(
      join(root, 'docs', 'contribute', 'identity.md'),
      [
        '# Canonical Identity and Digests',
        '',
        'Short intro.',
        '',
        '## Contents',
        '',
        '- [Overview](#overview)',
        '',
        '## Overview',
        '',
        '| The Field | Four Words In Header | Valid |',
        '| --- | --- | --- |',
        `| short | ${longCell} |`,
        '',
        '---',
        '',
        '**See also** — [Loopwright Architecture](../getting-started/architecture.md) (execution flow)',
        '',
      ].join('\n')
    );

    const result = checkDocs({ repoRoot: root, mode: 'strict' });
    assert.equal(result.ok, false);
    assert.ok(
      result.errors.some(e => e.includes('docs/contribute/identity.md') && e.includes('must not use banned word "The"')),
      `Expected banned article error in table header, got: ${result.errors.join('\n')}`
    );
    assert.ok(
      result.errors.some(e => e.includes('docs/contribute/identity.md') && e.includes('table header "Four Words In Header" exceeds cap')),
      `Expected >3 words header cap error, got: ${result.errors.join('\n')}`
    );
    assert.ok(
      result.errors.some(e => e.includes('docs/contribute/identity.md') && e.includes('table row column count (2) does not match header column count (3)')),
      `Expected column count mismatch error, got: ${result.errors.join('\n')}`
    );
    assert.ok(
      result.errors.some(e => e.includes('docs/contribute/identity.md') && e.includes('table cell length (185 chars) exceeds 180 chars')),
      `Expected >180 char cell error, got: ${result.errors.join('\n')}`
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('checkDocs rules 5, 6, 7: enforces banned AI filler, Pretty YAML bans, examples/controller.md JSON ban, reading footer format, and public link boundary (contribute/* and adr/*)', async () => {
  const checkDocs = await loadCheckDocs();
  const root = buildMinimalRepoFixture();
  try {
    writeFileEnsuringDir(
      join(root, 'docs', 'configuration', 'decision-routing.md'),
      [
        '# Decision Routing',
        '',
        'This page describes how operators seamlessly leverage routing.',
        '',
        '## Contents',
        '',
        '- [Overview](#overview)',
        '',
        '## Overview',
        '',
        'See [Development](../development.md), [Internals](../contribute/internals.md), and [ADR 0001](../contribute/adr/0001-local-state-authority.md).',
        '',
        '```yaml',
        'apiVersion: loopwright.dev/v1alpha1',
        '\tkind: DecisionPolicy',
        'rawConfig: |',
        '  {"embedded": true}',
        '```',
        '',
        '---',
        '',
        '**See also** — [Architecture](../getting-started/architecture.md)',
        '',
      ].join('\n')
    );

    writeFileEnsuringDir(
      join(root, 'examples', 'controller.md'),
      '# Controller Example\n\n```json\n{"kind": "ControllerConfig"}\n```\n'
    );

    const result = checkDocs({ repoRoot: root, mode: 'strict' });
    assert.equal(result.ok, false);
    assert.ok(
      result.errors.some(e => e.includes('docs/configuration/decision-routing.md') && e.includes('banned AI filler phrase "this page describes"')),
      `Expected AI filler error for "this page describes", got: ${result.errors.join('\n')}`
    );
    assert.ok(
      result.errors.some(e => e.includes('docs/configuration/decision-routing.md') && e.includes('banned AI filler phrase "seamlessly"')),
      `Expected AI filler error for "seamlessly", got: ${result.errors.join('\n')}`
    );
    assert.ok(
      result.errors.some(e => e.includes('docs/configuration/decision-routing.md') && e.includes('Pretty YAML block must not contain tab characters')),
      `Expected YAML tab error, got: ${result.errors.join('\n')}`
    );
    assert.ok(
      result.errors.some(e => e.includes('docs/configuration/decision-routing.md') && e.includes('Pretty YAML block must not embed multi-line JSON block scalars')),
      `Expected YAML embedded JSON error, got: ${result.errors.join('\n')}`
    );
    assert.ok(
      result.errors.some(e => e.includes('docs/configuration/decision-routing.md') && e.includes('public site page must not link to repository-only contributor page') && e.includes('docs/contribute/internals.md')),
      `Expected public-to-contribute link boundary error, got: ${result.errors.join('\n')}`
    );
    assert.ok(
      result.errors.some(e => e.includes('docs/configuration/decision-routing.md') && e.includes('public site page must not link to repository-only contributor page') && e.includes('docs/contribute/adr/0001-local-state-authority.md')),
      `Expected public-to-adr link boundary error, got: ${result.errors.join('\n')}`
    );
    assert.ok(
      result.errors.some(e => e.includes('docs/configuration/decision-routing.md') && e.includes('"**See also**" item must match "[Title](target) (description)"')),
      `Expected descriptive See also error, got: ${result.errors.join('\n')}`
    );
    assert.ok(
      result.errors.some(e => e.includes('docs/configuration/decision-routing.md') && e.includes('public site page must include "**Next** → [Title](target) — <description>"')),
      `Expected missing Next footer error on public page, got: ${result.errors.join('\n')}`
    );
    assert.ok(
      result.errors.some(e => e.includes('examples/controller.md') && e.includes('examples/controller.md must use Pretty YAML configuration blocks, not json')),
      `Expected examples/controller.md JSON block error, got: ${result.errors.join('\n')}`
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('checkDocs Pretty YAML envelope & Kubernetes metadata rule: enforces per-kind metadata and rejects bare fragments', async () => {
  const checkDocs = await loadCheckDocs();
  const root = buildMinimalRepoFixture();
  try {
    writeFileEnsuringDir(
      join(root, 'README.md'),
      [
        '# Loopwright',
        '',
        'See [Documentation](docs/README.md).',
        '',
        '```yaml',
        'spec:',
        '  sandbox:',
        '    networkMode: none',
        '```',
        '',
      ].join('\n')
    );

    writeFileEnsuringDir(
      join(root, 'docs', 'configuration', 'taskpack.md'),
      [
        '# Taskpack',
        '',
        'Taskpack configures automated repository checks.',
        '',
        '## Contents',
        '',
        '- [Models](#models)',
        '- [Legacy metadata](#legacy-metadata)',
        '- [One-off metadata](#one-off-metadata)',
        '- [Workflow](#workflow)',
        '',
        '## Models',
        '',
        '```yaml',
        'spec:',
        '  models:',
        '    - provider: zai',
        '      id: glm-5.3',
        '```',
        '',
        '## Legacy metadata',
        '',
        '```yaml',
        'apiVersion: loopwright.dev/v1alpha1',
        'kind: Taskpack',
        'metadata:',
        '  id: legacy-id',
        '  name: sample',
        '  version: 1.0.0',
        'spec:',
        '  digest:',
        '    hex: 1111111111111111111111111111111111111111111111111111111111111111 # Required: bad comment',
        '```',
        '',
        '## One-off metadata',
        '',
        '```yaml',
        'apiVersion: loopwright.dev/v1alpha1',
        'kind: DecisionPolicy',
        'metadata:',
        '  name: forbidden',
        'spec: {}',
        '```',
        '',
        '## Workflow',
        '',
        '```yaml',
        'name: loopwright',
        'on:',
        '  workflow_dispatch: {}',
        'jobs:',
        '  taskpack:',
        '    runs-on: ubuntu-latest',
        '    steps:',
        '      - uses: gpustack/loopwright@main',
        '```',
        '',
        '---',
        '',
        '**See also** — [Architecture](../getting-started/architecture.md) (four-stage execution chain)',
        '',
        '**Next** → [Task Contract](task-contract.md) — inspect task contract fields.',
        '',
      ].join('\n')
    );

    writeFileEnsuringDir(
      join(root, 'examples', 'controller.md'),
      '# Controller Example\n\n```yaml\nrequired:\n  - tests\n```\n'
    );

    writeFileEnsuringDir(
      join(root, 'docs', 'assets', 'diagrams', 'architecture-flow.svg'),
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 40"><text>handlers[]</text></svg>\n'
    );

    const result = checkDocs({ repoRoot: root, mode: 'strict' });
    assert.equal(result.ok, false);
    assert.ok(
      result.errors.some(e => e.startsWith('README.md:5:') && e.includes('complete top-level header envelope')),
      `Expected bare spec error in README.md, got: ${result.errors.join('\n')}`
    );
    assert.ok(
      result.errors.some(e => e.startsWith('docs/configuration/taskpack.md:14:') && e.includes('complete top-level header envelope')),
      `Expected bare spec error in docs/configuration/taskpack.md:14, got: ${result.errors.join('\n')}`
    );
    assert.ok(
      result.errors.some(e => e.startsWith('docs/configuration/taskpack.md:23:') && e.includes('metadata must use name only')),
      `Expected metadata.id/version rejection in Taskpack, got: ${result.errors.join('\n')}`
    );
    assert.ok(
      result.errors.some(e => e.includes('Use "hex: <hash>"') && e.includes('docs/configuration/taskpack.md')),
      `Expected dummy 64-hex hash rejection, got: ${result.errors.join('\n')}`
    );
    assert.ok(
      result.errors.some(e => e.includes('YAML comments must only annotate Optional items')),
      `Expected # Required YAML comment rejection, got: ${result.errors.join('\n')}`
    );
    assert.ok(
      result.errors.some(e => e.includes('Inline YAML comment must not contain ": "')),
      `Expected inline ": " YAML comment rejection, got: ${result.errors.join('\n')}`
    );
    assert.ok(
      result.errors.some(e => e.startsWith('docs/configuration/taskpack.md:37:') && e.includes('must omit top-level metadata')),
      `Expected top-level metadata rejection on one-off DecisionPolicy, got: ${result.errors.join('\n')}`
    );
    assert.ok(
      !result.errors.some(e => e.startsWith('docs/configuration/taskpack.md:47:')),
      `Valid GitHub Actions workflow YAML at docs/configuration/taskpack.md:47 must pass, got: ${result.errors.join('\n')}`
    );
    assert.ok(
      result.errors.some(e => e.startsWith('examples/controller.md:3:') && e.includes('complete top-level header envelope')),
      `Expected bare fragment error in examples/controller.md, got: ${result.errors.join('\n')}`
    );
    assert.ok(
      result.errors.some(e => e.includes('docs/assets/diagrams/architecture-flow.svg') && e.includes('must not contain array/object brackets')),
      `Expected SVG bracket rejection, got: ${result.errors.join('\n')}`
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('checkDocs 1:1:1 alignment rule: enforces matching filename slug, navigation.yaml label, and # H1 title', async () => {
  const checkDocs = await loadCheckDocs();
  const root = buildMinimalRepoFixture();
  try {
    writeFileEnsuringDir(
      join(root, 'docs', 'configuration', 'taskpack.md'),
      buildCleanPageContent({ relPath: 'configuration/taskpack.md', title: 'Taskpack Manifest Reference' })
    );

    const result = checkDocs({ repoRoot: root, mode: 'strict' });
    assert.equal(result.ok, false);
    assert.ok(
      result.errors.some(e => e.includes('docs/configuration/taskpack.md') && e.includes('public page filename slug "taskpack.md" must match # H1 title slug')),
      `Expected filename-to-H1 mismatch error, got: ${result.errors.join('\n')}`
    );
    assert.ok(
      result.errors.some(e => e.includes('site/data/navigation.yaml') && e.includes('label "Taskpack" for "/docs/configuration/taskpack/" must match')),
      `Expected navigation.yaml-to-H1 mismatch error, got: ${result.errors.join('\n')}`
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('check-docs.mjs CLI: --report exits 0, strict mode exits 1 on violations, and unknown CLI flags exit 2', () => {
  const root = buildMinimalRepoFixture();
  try {
    writeFileEnsuringDir(
      join(root, 'docs', 'contribute', 'memory.md'),
      [
        '# Reviewed Memory and CAS Compaction',
        '',
        'This document describes how memory seamlessly works.',
        '',
        '## Contents',
        '',
        '- [Overview](#overview)',
        '',
        '## Overview',
        '',
        'Short text.',
        '',
        '---',
        '',
        '**See also** — [Loopwright Architecture](../getting-started/architecture.md) (execution flow)',
        '',
      ].join('\n')
    );

    const reportRun = spawnSync(process.execPath, [CHECK_DOCS_PATH, '--report', root], {
      encoding: 'utf8',
      timeout: 15000,
    });
    assert.equal(reportRun.status, 0, `--report must exit 0, got ${reportRun.status}: ${reportRun.stderr}`);
    assert.match(reportRun.stdout, /=== check-docs report/);
    assert.match(reportRun.stdout, /\[docs\/contribute\/memory\.md\]/);

    const strictRun = spawnSync(process.execPath, [CHECK_DOCS_PATH, root], {
      encoding: 'utf8',
      timeout: 15000,
    });
    assert.equal(strictRun.status, 1, `strict mode must exit 1 on violations, got ${strictRun.status}`);
    assert.match(strictRun.stderr, /banned AI filler phrase/);

    const badFlagRun = spawnSync(process.execPath, [CHECK_DOCS_PATH, '--reprot', root], {
      encoding: 'utf8',
      timeout: 15000,
    });
    assert.equal(badFlagRun.status, 2, `unknown CLI flag must exit 2, got ${badFlagRun.status}`);
    assert.match(badFlagRun.stderr, /Unknown CLI flag: --reprot/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
