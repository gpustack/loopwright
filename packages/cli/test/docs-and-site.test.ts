import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseDocument } from 'yaml';
import { installedHandlerDigests } from '@loopwright/controller';
import { parseEvolutionCampaignDocument } from '@loopwright/evolution';
import { validateTaskpackManifest } from '@loopwright/github-app';
import { validateTaskpackManifestObject, validateTaskpackSuiteManifest, type Json } from '@loopwright/taskpack';
import { configurationFixture } from '../../controller/test/config-fixtures.js';
import { setFixture } from '../../controller/test/progress-fixtures.js';

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
const SITE_SCRIPT_PATH = join(REPO_ROOT, 'scripts', 'site.mjs');

interface SiteModule {
  rewriteReferenceMarkdown: (
    content: string,
    options?: { docsPrefix?: string; repoBlobBase?: string; sourceRef?: string }
  ) => string;
  stageReferenceDocs: (options?: {
    rootDir?: string;
    docsDir?: string;
    sourceDir?: string;
    stagingDir?: string;
    docsPrefix?: string;
    repoBlobBase?: string;
    sourceRef?: string;
    rebaseFrom?: string | null;
  }) => string[];
}

async function loadSiteModule(): Promise<SiteModule> {
  return (await import(pathToFileURL(SITE_SCRIPT_PATH).href)) as SiteModule;
}

function assertRgbaPng(filePath: string, expectedWidth = 512, expectedHeight = 512): void {
  assert.ok(existsSync(filePath), `${filePath} must exist`);
  const buf = readFileSync(filePath);
  assert.ok(buf.length >= 29, `${filePath} must be at least 29 bytes`);
  const pngSignature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  assert.ok(buf.subarray(0, 8).equals(pngSignature), `${filePath} must have valid PNG signature`);
  assert.equal(buf.toString('ascii', 12, 16), 'IHDR', `${filePath} must have IHDR chunk`);
  const width = buf.readUInt32BE(16);
  const height = buf.readUInt32BE(20);
  const bitDepth = buf.readUInt8(24);
  const colorType = buf.readUInt8(25);
  assert.equal(width, expectedWidth, `${filePath} width must be ${expectedWidth}`);
  assert.equal(height, expectedHeight, `${filePath} height must be ${expectedHeight}`);
  assert.equal(bitDepth, 8, `${filePath} bit depth must be 8`);
  assert.equal(colorType, 6, `${filePath} color type must be 6 (RGBA)`);
}

test('governance: LICENSE, .github templates, gpustack-aligned workflows, and brand logo assets', () => {
  // 1. Root LICENSE
  const licensePath = join(REPO_ROOT, 'LICENSE');
  assert.ok(existsSync(licensePath), 'LICENSE must exist at repository root');
  const licenseContent = readFileSync(licensePath, 'utf8');
  assert.ok(licenseContent.includes('Apache License'), 'LICENSE must declare Apache License');
  assert.ok(licenseContent.includes('Version 2.0'), 'LICENSE must declare Version 2.0');
  assert.ok(licenseContent.includes('Copyright 2026 The Loopwright Authors'), 'LICENSE must declare Copyright 2026 The Loopwright Authors');

  // 2. Five gpustack-aligned .github/workflows/*.yml files
  const workflowsPath = join(REPO_ROOT, '.github', 'workflows');
  assert.ok(existsSync(workflowsPath), '.github/workflows must exist');
  for (const wf of ['ci.yml', 'test.yml', 'docs.yml', 'code-review.yml', 'site.yml']) {
    const wfPath = join(workflowsPath, wf);
    assert.ok(existsSync(wfPath), `.github/workflows/${wf} must exist`);
    const doc = parseDocument(readFileSync(wfPath, 'utf8'), { version: '1.2', schema: 'core', uniqueKeys: true });
    assert.equal(doc.errors.length, 0, `${wf} must parse cleanly as YAML: ${doc.errors.map(e => e.message).join('; ')}`);
  }

  // 3. .github/PULL_REQUEST_TEMPLATE.md
  const prTemplatePath = join(REPO_ROOT, '.github', 'PULL_REQUEST_TEMPLATE.md');
  assert.ok(existsSync(prTemplatePath), '.github/PULL_REQUEST_TEMPLATE.md must exist');
  const prTemplate = readFileSync(prTemplatePath, 'utf8');
  assert.ok(prTemplate.includes('/kind'), 'PR template must include /kind');
  assert.ok(prTemplate.includes('/area'), 'PR template must include /area');
  assert.ok(prTemplate.includes('Fixes #'), 'PR template must include Fixes #');
  assert.ok(prTemplate.includes('Addresses #'), 'PR template must include Addresses #');
  assert.ok(prTemplate.includes('Relates #'), 'PR template must include Relates #');
  assert.ok(prTemplate.includes('Signed-off-by'), 'PR template must require Signed-off-by DCO');

  // 4. Six .github/ISSUE_TEMPLATE/*.md templates
  const issueTemplates = [
    'BUG_REPORT.md',
    'CLEANUP.md',
    'DOCUMENTATION.md',
    'ENHANCEMENT.md',
    'SUPPORT.md',
    'TODO.md'
  ];
  for (const tpl of issueTemplates) {
    const tplPath = join(REPO_ROOT, '.github', 'ISSUE_TEMPLATE', tpl);
    assert.ok(existsSync(tplPath), `.github/ISSUE_TEMPLATE/${tpl} must exist`);
    const content = readFileSync(tplPath, 'utf8');
    assert.match(content, /^---\n/, `${tpl} must start with YAML frontmatter`);
    assert.match(content, /\nname:\s*[^\n]+/, `${tpl} must declare name in frontmatter`);
    assert.match(content, /\nabout:\s*[^\n]+/, `${tpl} must declare about in frontmatter`);
    assert.match(content, /\ntitle:\s*[^\n]+/, `${tpl} must declare title in frontmatter`);
  }

  // 5. RGBA brand logos
  assertRgbaPng(join(REPO_ROOT, 'site', 'assets', 'images', 'logo.png'), 512, 512);
  assertRgbaPng(join(REPO_ROOT, 'docs', 'assets', 'logo.png'), 512, 512);
  assert.ok(!existsSync(join(REPO_ROOT, 'site', 'assets', 'images', 'logo.svg')), 'site/assets/images/logo.svg must not exist');
});

test('documentation and skills: AGENTS.md, OpenCodeReview rules, and skills exist and match contracts', () => {
  // 1. AGENTS.md
  const agentsPath = join(REPO_ROOT, 'AGENTS.md');
  assert.ok(existsSync(agentsPath), 'AGENTS.md must exist at repository root');
  const agentsContent = readFileSync(agentsPath, 'utf8');
  assert.ok(agentsContent.includes('docs/README.md#module-map'), 'AGENTS.md must link to module map');
  assert.ok(agentsContent.includes('docs/getting-started/architecture.md'), 'AGENTS.md must link to architecture');
  assert.ok(agentsContent.includes('docs/development.md'), 'AGENTS.md must link to development');

  // 2. .opencodereview/rule.json
  const ocrPath = join(REPO_ROOT, '.opencodereview', 'rule.json');
  assert.ok(existsSync(ocrPath), '.opencodereview/rule.json must exist');
  const ocr = JSON.parse(readFileSync(ocrPath, 'utf8')) as {
    include?: string[];
    exclude?: string[];
    rules?: Array<{ path?: string; rule?: string }>;
  };
  assert.ok(Array.isArray(ocr.include) && ocr.include.length > 0, 'ocr.include must be a non-empty array');
  assert.ok(Array.isArray(ocr.exclude), 'ocr.exclude must be an array');
  assert.ok(Array.isArray(ocr.rules) && ocr.rules.length > 0, 'ocr.rules must be a non-empty array');

  const rulePaths = new Set(ocr.rules.map(r => r.path));
  assert.ok(rulePaths.has('packages/core/**/*.ts'), 'must cover core');
  assert.ok(rulePaths.has('packages/state/**/*.ts'), 'must cover state');
  assert.ok(rulePaths.has('packages/agent-pi/**/*.ts'), 'must cover agent-pi');
  assert.ok(rulePaths.has('packages/controller/**/*.ts'), 'must cover controller');
  assert.ok(rulePaths.has('packages/taskpack-runner/**/*.ts'), 'must cover taskpack-runner');
  assert.ok(rulePaths.has('packages/memory/**/*.ts'), 'must cover memory');
  assert.ok(rulePaths.has('packages/decisions/**/*.ts'), 'must cover decisions');
  assert.ok(rulePaths.has('packages/taskpack/**/*.ts'), 'must cover taskpack');
  assert.ok(rulePaths.has('packages/github-app/**/*.ts'), 'must cover github-app');
  assert.ok(rulePaths.has('packages/hardware-runner/**/*.ts'), 'must cover hardware-runner');
  assert.ok(rulePaths.has('packages/evolution/**/*.ts'), 'must cover evolution');
  assert.ok(rulePaths.has('packages/cli/**/*.ts'), 'must cover cli');
  assert.ok(rulePaths.has('action.yml'), 'must cover action.yml');
  assert.ok(rulePaths.has('docs/**/*.md'), 'must cover docs');
  assert.ok(rulePaths.has('README.md'), 'must cover README.md');

  // 3. Six repository skills
  const expectedSkills = [
    'loopwright-overview',
    'loopwright-docs',
    'loopwright-code-review',
    'loopwright-issue-pr',
    'loopwright-release',
    'loopwright-step'
  ];
  for (const skillName of expectedSkills) {
    const skillFile = join(REPO_ROOT, '.agents', 'skills', skillName, 'SKILL.md');
    assert.ok(existsSync(skillFile), `skill ${skillName}/SKILL.md must exist`);
    const content = readFileSync(skillFile, 'utf8');
    assert.match(content, /^---\n/, `${skillName} must start with frontmatter`);
    assert.match(content, /\nname:\s*[^\n]+/, `${skillName} must declare name in frontmatter`);
    assert.match(content, /\ndescription:\s*[^\n]+/, `${skillName} must declare description in frontmatter`);
  }

  // Verify loopwright-step is standalone/portable (zero repo-relative Markdown links)
  const stepSkill = readFileSync(join(REPO_ROOT, '.agents', 'skills', 'loopwright-step', 'SKILL.md'), 'utf8');
  for (const match of stepSkill.matchAll(/!?\[[^\]]*\]\(([^)]+)\)/g)) {
    const target = (match[1] ?? '').trim();
    assert.match(target, /^https:\/\//, `loopwright-step/SKILL.md link must be portable https:// URL, got: ${target}`);
  }

  // Verify Taskpack YAML example in docs/operations/coding-agents.md validates against schema
  const codingAgentsDoc = readFileSync(join(REPO_ROOT, 'docs', 'operations', 'coding-agents.md'), 'utf8');
  const yamlMatch = codingAgentsDoc.match(/```yaml\n([\s\S]*?)\n```/);
  assert.ok(yamlMatch?.[1], 'docs/operations/coding-agents.md must include a YAML Taskpack example');
  const parsedTaskpack = parseDocument(yamlMatch[1], { version: '1.2', schema: 'core', uniqueKeys: true });
  assert.equal(parsedTaskpack.errors.length, 0, 'coding-agents.md YAML must parse cleanly');
  const validated = validateTaskpackManifest(parsedTaskpack.toJS());
  assert.equal(validated.metadata.name, 'multi-role-sync');
  assert.equal(validated.spec.roles?.length, 2);

  // Verify complete Taskpack Macro YAML example in docs/configuration/taskpack.md validates against schema
  const taskpackDoc = readFileSync(join(REPO_ROOT, 'docs', 'configuration', 'taskpack.md'), 'utf8');
  const taskpackYamlMatch = taskpackDoc.match(/## Taskpack\n\n```yaml\n([\s\S]*?)\n```/);
  assert.ok(taskpackYamlMatch?.[1], 'docs/configuration/taskpack.md must include a ## Taskpack YAML example');
  const parsedTaskpackRef = parseDocument(taskpackYamlMatch[1], { version: '1.2', schema: 'core', uniqueKeys: true });
  assert.equal(parsedTaskpackRef.errors.length, 0, 'taskpack.md Macro YAML must parse cleanly');
  const validatedTaskpackRef = validateTaskpackManifest(parsedTaskpackRef.toJS());
  assert.equal(validatedTaskpackRef.metadata.name, 'catalog-sync');
  assert.equal(validatedTaskpackRef.spec.memory.apply, 'separate-pull-request');
  assert.equal(validatedTaskpackRef.spec.memory.onNoModelBudget, 'deterministic-observations-only');
  assert.equal(validatedTaskpackRef.spec.memory.ttlDays, 15);
  assert.equal(validatedTaskpackRef.spec.memory.maxEntries, 128);
  assert.equal(validatedTaskpackRef.spec.memory.maxPromptEntries, 32);
  assert.equal(validatedTaskpackRef.spec.memory.checkCodeFingerprint, false);
  assert.equal(validatedTaskpackRef.spec.memory.checkUpstreamVersions, false);
  assert.equal(validatedTaskpackRef.spec.memory.publishOnFailure, false);
  assert.equal(validatedTaskpackRef.spec.memory.skipCi, true);

  // Verify embedded Taskpack and TaskpackSuite YAML examples in docs/references/bootstrap-interview.md validate against schema
  const bootstrapRefDoc = readFileSync(join(REPO_ROOT, 'docs', 'references', 'bootstrap-interview.md'), 'utf8');
  const bootstrapYamlBlocks = [...bootstrapRefDoc.matchAll(/```yaml\n([\s\S]*?)\n```/g)]
    .map(m => m[1]!)
    .map(raw => {
      const parsed = parseDocument(raw, { version: '1.2', schema: 'core', uniqueKeys: true });
      assert.equal(parsed.errors.length, 0, 'bootstrap-interview.md YAML must parse cleanly');
      return parsed.toJS() as Record<string, Json>;
    });
  const bootstrapTaskpackJs = bootstrapYamlBlocks.find(doc => doc['kind'] === 'Taskpack');
  assert.ok(bootstrapTaskpackJs, 'docs/references/bootstrap-interview.md must include a YAML Taskpack example');
  const validatedBootstrap = validateTaskpackManifest(bootstrapTaskpackJs, {
    controlRoot: '.auto-sync',
    manifestPath: '.auto-sync/charts.taskpack.yaml',
  });
  assert.equal(validatedBootstrap.metadata.name, 'charts-sync');
  assert.deepEqual(validatedBootstrap.spec.scope.writable, ['charts/**']);
  assert.deepEqual(validatedBootstrap.spec.scope.protected, ['.auto-sync/**']);
  assert.equal(validatedBootstrap.spec.publication.headBranchPrefix, 'auto-sync-charts-');
  assert.equal(validatedBootstrap.spec.memory.directory, '.auto-sync/memory/charts-sync');
  assert.equal(validatedBootstrap.spec.baselineAlignment?.policy, 'extract-context');

  const bootstrapSuiteJs = bootstrapYamlBlocks.find(doc => doc['kind'] === 'TaskpackSuite');
  assert.ok(bootstrapSuiteJs, 'docs/references/bootstrap-interview.md must include a YAML TaskpackSuite example');
  const validatedBootstrapSuite = validateTaskpackSuiteManifest(bootstrapSuiteJs);
  assert.equal(validatedBootstrapSuite.metadata.name, 'repo-auto-sync');
  assert.equal(validatedBootstrapSuite.spec.domains.length, 2);
  assert.equal(validatedBootstrapSuite.spec.stages.length, 2);

  // Verify complete EvolutionCampaign Macro YAML example in docs/configuration/evolution-campaign.md validates against schema
  const evoConfigDoc = readFileSync(join(REPO_ROOT, 'docs', 'configuration', 'evolution-campaign.md'), 'utf8');
  const evoConfigYamlMatch = evoConfigDoc.match(/## EvolutionCampaign\n\n```yaml\n([\s\S]*?)\n```/);
  assert.ok(evoConfigYamlMatch?.[1], 'docs/configuration/evolution-campaign.md must include a ## EvolutionCampaign YAML example');
  const evoConfigParsed = parseDocument(evoConfigYamlMatch[1], { version: '1.2', schema: 'core', uniqueKeys: true });
  assert.equal(evoConfigParsed.errors.length, 0, 'evolution-campaign.md YAML must parse cleanly');
  const validatedEvoConfig = parseEvolutionCampaignDocument(evoConfigParsed.toJS() as Record<string, Json>);
  assert.equal(validatedEvoConfig.metadata.name, 'flash-decode-sm90a');
  assert.equal(validatedEvoConfig.spec.targetCellId, 'cuda-h100-whole');
  assert.equal(validatedEvoConfig.spec.stages.mode, 'specialist-then-portfolio');
  assert.equal(validatedEvoConfig.spec.teamEvolution?.enabled, true);

  // Verify embedded Taskpack and EvolutionCampaign YAML examples in docs/walkthroughs/evolutionary-campaign.md validate against schema
  const evoWalkthroughDoc = readFileSync(join(REPO_ROOT, 'docs', 'walkthroughs', 'evolutionary-campaign.md'), 'utf8');
  const evoWalkthroughYamlBlocks = [...evoWalkthroughDoc.matchAll(/```yaml\n([\s\S]*?)\n```/g)]
    .map(m => m[1]!)
    .map(raw => {
      const parsed = parseDocument(raw, { version: '1.2', schema: 'core', uniqueKeys: true });
      assert.equal(parsed.errors.length, 0, 'evolutionary-campaign.md YAML must parse cleanly');
      return parsed.toJS() as Record<string, Json>;
    });
  const evoWalkthroughTaskpack = evoWalkthroughYamlBlocks.find(doc => doc['kind'] === 'Taskpack');
  assert.ok(evoWalkthroughTaskpack, 'docs/walkthroughs/evolutionary-campaign.md must include a YAML Taskpack example');
  const validatedEvoWalkthroughTaskpack = validateTaskpackManifestObject(evoWalkthroughTaskpack, {
    controlRoot: '.loopwright',
    manifestPath: '.loopwright/taskpack.yaml',
  });
  assert.equal(validatedEvoWalkthroughTaskpack.metadata.name, 'kernel-evolve-tp');
  const evoWalkthroughCampaign = evoWalkthroughYamlBlocks.find(doc => doc['kind'] === 'EvolutionCampaign');
  assert.ok(evoWalkthroughCampaign, 'docs/walkthroughs/evolutionary-campaign.md must include a YAML EvolutionCampaign example');
  const validatedEvoWalkthroughCampaign = parseEvolutionCampaignDocument(evoWalkthroughCampaign);
  assert.equal(validatedEvoWalkthroughCampaign.metadata.name, 'flash-decode-sm90a');

  // 4. .claude/skills symlink
  const claudeSkillsPath = join(REPO_ROOT, '.claude', 'skills');
  assert.ok(existsSync(claudeSkillsPath), '.claude/skills must exist');
  const stat = lstatSync(claudeSkillsPath);
  assert.ok(stat.isSymbolicLink(), '.claude/skills must be a symbolic link');
  const target = readlinkSync(claudeSkillsPath);
  assert.ok(target.endsWith('.agents/skills'), `.claude/skills must point to .agents/skills, got: ${target}`);
});

test('site.mjs unit: rewriteReferenceMarkdown rewrites all 6 target classes while preserving exempt code/comment/escaped regions, and stageReferenceDocs prunes stale files and rejects subdirs', async () => {
  const { rewriteReferenceMarkdown, stageReferenceDocs } = await loadSiteModule();

  const sourceMarkdown = [
    '# Sample Reference',
    '',
    '1. Sibling ref: [CLI Ref](cli-and-action-reference.md#cli-subcommands)',
    '2. Public regular: [Taskpack](../configuration/taskpack.md#taskpack-bounds)',
    '3. Public section index: [Config Index](../configuration/_index.md#top) and [Docs Index](../_index.md)',
    '4. Shared asset: ![Flow](../assets/diagrams/architecture-flow.svg)',
    '5. Contribute & README: [Docs Map](../README.md#module-map), [Dev](../development.md), [State](../contribute/state.md#fencing)',
    '6. Repo paths: [Core](../../packages/core/src/index.ts) and [Spec](../../specs/2026-11-05-task-contracts-and-evidence.md)',
    '7. Multiline inline: [Evolution',
    '   Campaign](../walkthroughs/evolutionary-campaign.md#step-1)',
    '8. Escaped & inline code: \\[Escaped](../configuration/taskpack.md) and `[Code](../configuration/taskpack.md)`',
    '',
    '<!-- [Commented](../configuration/taskpack.md) -->',
    '',
    '```yaml',
    '# [Fenced](../configuration/taskpack.md)',
    'spec: {}',
    '```',
    '',
    '    [Indented](../configuration/taskpack.md)',
    '',
    '[ref-public]: ../operations/cli.md#exit-codes',
    '[ref-contrib]: ../contribute/memory.md',
    '',
  ].join('\n');

  const rewritten = rewriteReferenceMarkdown(sourceMarkdown, {
    docsPrefix: '../docs',
    repoBlobBase: 'https://github.com/gpustack/loopwright/blob',
    sourceRef: 'v1.2.0',
  });

  assert.ok(rewritten.includes('[CLI Ref](cli-and-action-reference.md#cli-subcommands)'));
  assert.ok(rewritten.includes('[Taskpack](../docs/configuration/taskpack/index.md#taskpack-bounds)'));
  assert.ok(rewritten.includes('[Config Index](../docs/configuration/index.md#top)'));
  assert.ok(rewritten.includes('[Docs Index](../docs/index.md)'));
  assert.ok(rewritten.includes('![Flow](../docs/assets/diagrams/architecture-flow.svg)'));
  assert.ok(rewritten.includes('[Docs Map](https://github.com/gpustack/loopwright/blob/v1.2.0/docs/README.md#module-map)'));
  assert.ok(rewritten.includes('[Dev](https://github.com/gpustack/loopwright/blob/v1.2.0/docs/development.md)'));
  assert.ok(rewritten.includes('[State](https://github.com/gpustack/loopwright/blob/v1.2.0/docs/contribute/state.md#fencing)'));
  assert.ok(rewritten.includes('[Core](https://github.com/gpustack/loopwright/blob/v1.2.0/packages/core/src/index.ts)'));
  assert.ok(rewritten.includes('[Spec](https://github.com/gpustack/loopwright/blob/v1.2.0/specs/2026-11-05-task-contracts-and-evidence.md)'));
  assert.ok(rewritten.includes('Campaign](../docs/walkthroughs/evolutionary-campaign/index.md#step-1)'));
  assert.ok(rewritten.includes('\\[Escaped](../configuration/taskpack.md)'));
  assert.ok(rewritten.includes('`[Code](../configuration/taskpack.md)`'));
  assert.ok(rewritten.includes('<!-- [Commented](../configuration/taskpack.md) -->'));
  assert.ok(rewritten.includes('# [Fenced](../configuration/taskpack.md)'));
  assert.ok(rewritten.includes('    [Indented](../configuration/taskpack.md)'));
  assert.ok(rewritten.includes('[ref-public]: ../docs/operations/cli/index.md#exit-codes'));
  assert.ok(rewritten.includes('[ref-contrib]: https://github.com/gpustack/loopwright/blob/v1.2.0/docs/contribute/memory.md'));

  assert.throws(
    () => rewriteReferenceMarkdown('[Escape](../../../outside.md)'),
    /link escapes repository root/
  );

  // stageReferenceDocs: fresh mirror, stale file/dir pruning, rebaseFrom, and subdir/overlap rejection
  const tmpDir = mkdtempSync(join(tmpdir(), 'lw-stage-ref-test-'));
  try {
    const srcRefs = join(tmpDir, 'docs', 'references');
    const stageRefs = join(tmpDir, 'site', 'resources', 'references');
    const rootRefs = join(tmpDir, 'gh-pages', 'references');
    mkdirSync(srcRefs, { recursive: true });
    mkdirSync(join(stageRefs, 'obsolete-dir'), { recursive: true });
    writeFileSync(join(stageRefs, 'stale.md'), '# Stale\n');
    writeFileSync(join(stageRefs, 'obsolete-dir', 'old.md'), '# Old\n');
    writeFileSync(join(srcRefs, 'README.md'), '# Hub\n\nSee [Guide](../getting-started/architecture.md).\n');
    writeFileSync(join(srcRefs, 'topic.md'), '# Topic\n\nSee [Hub](README.md) and [Dev](../development.md).\n');

    const stagedNames = stageReferenceDocs({
      sourceDir: srcRefs,
      stagingDir: stageRefs,
      docsPrefix: '../docs',
      sourceRef: 'main',
    });
    assert.deepEqual(stagedNames, ['README.md', 'topic.md']);
    assert.deepEqual(readdirSync(stageRefs).sort(), ['README.md', 'topic.md']);
    assert.ok(
      readFileSync(join(stageRefs, 'README.md'), 'utf8').includes('../docs/getting-started/architecture/index.md')
    );

    const rebasedNames = stageReferenceDocs({
      sourceDir: stageRefs,
      stagingDir: rootRefs,
      rebaseFrom: '../docs',
      docsPrefix: '../latest/docs',
    });
    assert.deepEqual(rebasedNames, ['README.md', 'topic.md']);
    assert.ok(
      readFileSync(join(rootRefs, 'README.md'), 'utf8').includes('../latest/docs/getting-started/architecture/index.md')
    );

    assert.throws(
      () => stageReferenceDocs({ sourceDir: srcRefs, stagingDir: srcRefs }),
      /must not overlap/
    );
    const guardedRoot = join(tmpDir, 'guarded-root');
    mkdirSync(guardedRoot, { recursive: true });
    assert.throws(
      () => stageReferenceDocs({ rootDir: guardedRoot, sourceDir: srcRefs, stagingDir: guardedRoot }),
      /staging directory must not contain the repository, docs, or site root/
    );

    mkdirSync(join(srcRefs, 'nested-subdir'));
    assert.throws(
      () => stageReferenceDocs({ sourceDir: srcRefs, stagingDir: stageRefs }),
      /docs\/references must be flat; found nested subdirectory: nested-subdir/
    );
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('documentation verification: check-docs.mjs passes with zero errors', () => {
  const scriptPath = join(REPO_ROOT, 'scripts', 'check-docs.mjs');
  assert.ok(existsSync(scriptPath), 'scripts/check-docs.mjs must exist');

  const run = spawnSync(process.execPath, [scriptPath, REPO_ROOT], {
    encoding: 'utf8',
    timeout: 15000,
    cwd: REPO_ROOT
  });

  assert.equal(run.status, 0, `check-docs.mjs failed:\nstdout: ${run.stdout}\nstderr: ${run.stderr}`);
  assert.match(run.stdout, /0 error\(s\)/, 'check-docs.mjs must report 0 error(s)');
});

test('hugo site: site.mjs build builds 15-page site, exports three-zone llms.txt + 6 flat references, and verifies zero excluded-zone leaks in sitemap.xml and index.json', () => {
  const siteScript = join(REPO_ROOT, 'scripts', 'site.mjs');
  assert.ok(existsSync(siteScript), 'scripts/site.mjs must exist');

  // Verify Hugo binary availability
  const hugoCandidates = [
    process.env.HUGO_BIN,
    join(REPO_ROOT, '.sbin', 'hugo')
  ];
  let hasHugo = hugoCandidates.some(c => c && existsSync(c));
  if (!hasHugo) {
    const which = spawnSync('which', ['hugo'], { encoding: 'utf8' });
    if (which.status === 0 && which.stdout.trim().length > 0) {
      hasHugo = true;
    }
  }

  if (!hasHugo) {
    // If no Hugo binary is found in environment, skip build execution
    return;
  }

  const build = spawnSync(process.execPath, [siteScript, 'build'], {
    encoding: 'utf8',
    timeout: 30000,
    cwd: REPO_ROOT
  });

  assert.equal(build.status, 0, `site.mjs build failed:\nstdout: ${build.stdout}\nstderr: ${build.stderr}`);
  assert.match(build.stdout, /Verified \d+ HTML pages and 15 Markdown exports; 0 broken link\(s\)/);

  const publicDir = join(REPO_ROOT, 'site', 'public');
  assert.ok(existsSync(join(publicDir, 'llms.txt')), 'llms.txt must exist');
  assert.ok(existsSync(join(publicDir, 'site-version.json')), 'site-version.json must exist');
  assert.ok(existsSync(join(publicDir, 'index.json')), 'index.json must exist');
  assert.ok(existsSync(join(publicDir, 'sitemap.xml')), 'sitemap.xml must exist');

  // Verify llms.txt content across all 3 zones (Public 15 + Reference 6 + Optional 13 [README + 12 Contribute])
  const llms = readFileSync(join(publicDir, 'llms.txt'), 'utf8');
  const llmsPublicMatches = llms.match(/^-\s+\[[^\]]+\]\((?:https?:\/\/[^/]+)?\/docs\/[^)]+\):/gm);
  assert.equal(llmsPublicMatches?.length, 15, 'llms.txt must list exactly 15 public docs pages');
  assert.match(llms, /\/docs\/walkthroughs\/evolutionary-campaign\/index\.md\)/, 'llms.txt must link to singular evolutionary-campaign');

  const expectedRefFiles = [
    'README.md',
    'bootstrap-interview.md',
    'taskpack-and-contract-schema.md',
    'controller-and-registry-schema.md',
    'cli-and-action-reference.md',
    'coding-agent-protocol.md',
  ];
  assert.match(llms, /^## Reference$/m, 'llms.txt must contain ## Reference section');
  for (const refName of expectedRefFiles) {
    assert.ok(
      llms.includes(`/references/${refName}):`),
      `llms.txt ## Reference must include /references/${refName}`
    );
    assert.ok(
      existsSync(join(publicDir, 'references', refName)),
      `site/public/references/${refName} must exist`
    );
  }

  assert.match(llms, /^## Optional$/m, 'llms.txt must contain ## Optional section');
  const optionalGithubMatches = llms.match(/^-\s+\[[^\]]+\]\(https:\/\/github\.com\/gpustack\/loopwright\/blob\/[^/]+\/docs\/[^)]+\):/gm);
  assert.equal(
    optionalGithubMatches?.length,
    13,
    'llms.txt ## Optional must list Repository navigation (docs/README.md) plus all 12 Contribute pages'
  );

  for (const nonGithubLine of llms.split('\n').filter(l => l.startsWith('- ') && !l.includes('https://github.com/'))) {
    assert.ok(!nonGithubLine.includes('/docs/development'), `llms.txt must not leak /docs/development: ${nonGithubLine}`);
    assert.ok(!nonGithubLine.includes('/docs/contribute/'), `llms.txt must not leak /docs/contribute/: ${nonGithubLine}`);
    assert.ok(!nonGithubLine.includes('/docs/adr/'), `llms.txt must not leak /docs/adr/: ${nonGithubLine}`);
    assert.ok(!nonGithubLine.includes('/docs/references/'), `llms.txt must not leak /docs/references/: ${nonGithubLine}`);
  }

  const exportedBootstrapRef = readFileSync(join(publicDir, 'references', 'bootstrap-interview.md'), 'utf8');
  assert.match(exportedBootstrapRef, /\(\.\.\/docs\/walkthroughs\/declarative-taskpack\/index\.md\)/, 'exported bootstrap-interview.md must rewrite doc links');
  assert.ok(!exportedBootstrapRef.includes('](../walkthroughs/'), 'exported bootstrap-interview.md must not retain unrewritten ../<group>/ links');

  // Verify site-version.json content
  const version = JSON.parse(readFileSync(join(publicDir, 'site-version.json'), 'utf8')) as { version?: string };
  assert.ok(version.version, 'site-version.json must contain version');

  // Verify index.json content and 0 excluded-zone leaks
  const index = JSON.parse(readFileSync(join(publicDir, 'index.json'), 'utf8')) as Array<{ url?: string }>;
  assert.ok(Array.isArray(index) && index.length >= 15, 'index.json must contain at least 15 pages');
  for (const entry of index) {
    const u = String(entry.url ?? '');
    assert.ok(
      !/\/(?:references|docs\/references|contribute|docs\/contribute|docs\/adr|development|docs\/development)(?:\/|\.|$)/.test(u),
      `index.json must not leak excluded zone URL: ${u}`
    );
  }

  // Verify sitemap.xml has 0 excluded-zone leaks
  const sitemapXml = readFileSync(join(publicDir, 'sitemap.xml'), 'utf8');
  for (const locMatch of sitemapXml.matchAll(/<loc>([^<]+)<\/loc>/gi)) {
    const loc = locMatch[1] ?? '';
    assert.ok(
      !/\/(?:references|docs\/references|contribute|docs\/contribute|docs\/adr|development|docs\/development)(?:\/|\.|$)/.test(loc),
      `sitemap.xml must not leak excluded zone URL: ${loc}`
    );
  }

  // Verify 15 markdown and html exports exist under docs/<group>/<slug>/
  const canonicalPages = [
    'getting-started/architecture',
    'getting-started/installation',
    'operations/github-action',
    'operations/github-app',
    'operations/cli',
    'operations/coding-agents',
    'walkthroughs/declarative-taskpack',
    'walkthroughs/managed-controller',
    'walkthroughs/evolutionary-campaign',
    'configuration/taskpack',
    'configuration/task-contract',
    'configuration/controller-and-registry',
    'configuration/sandbox-backends',
    'configuration/decision-routing',
    'configuration/evolution-campaign'
  ];

  for (const p of canonicalPages) {
    const htmlPath = join(publicDir, 'docs', p, 'index.html');
    const mdPath = join(publicDir, 'docs', p, 'index.md');
    assert.ok(existsSync(htmlPath), `HTML page must exist: ${htmlPath}`);
    assert.ok(existsSync(mdPath), `Markdown export must exist: ${mdPath}`);
  }

  // Verify gpustack-style reading footer rendering in built HTML
  const contractsHtml = readFileSync(join(publicDir, 'docs', 'configuration', 'task-contract', 'index.html'), 'utf8');
  assert.ok(contractsHtml.includes('<nav class="reading-footer"'), 'task-contract/index.html must render <nav class="reading-footer"');
  assert.ok(contractsHtml.includes('<ul class="related-pages">'), 'task-contract/index.html must render <ul class="related-pages">');
  assert.ok(contractsHtml.includes('<section class="next-page">'), 'task-contract/index.html must render <section class="next-page">');

  // Verify excluded Contribute, ADR, and static reference pages do NOT exist in site/public/docs/
  assert.ok(!existsSync(join(publicDir, 'docs', 'development')), 'docs/development must not exist in site/public');
  assert.ok(!existsSync(join(publicDir, 'docs', 'contribute')), 'docs/contribute must not exist in site/public');
  assert.ok(!existsSync(join(publicDir, 'docs', 'adr')), 'docs/adr must not exist in site/public');
  assert.ok(!existsSync(join(publicDir, 'docs', 'references')), 'docs/references must not exist in site/public');

  // Verify subpath SITE_BASE_URL build and verification (GitHub Pages subpath deployment)
  const subpathBuild = spawnSync(process.execPath, [siteScript, 'build'], {
    encoding: 'utf8',
    timeout: 30000,
    cwd: REPO_ROOT,
    env: { ...process.env, SITE_BASE_URL: 'https://docs.gpustack.ai/loopwright/latest/' }
  });
  assert.equal(subpathBuild.status, 0, `subpath site.mjs build failed:\nstdout: ${subpathBuild.stdout}\nstderr: ${subpathBuild.stderr}`);
  assert.match(subpathBuild.stdout, /Verified \d+ HTML pages and 15 Markdown exports; 0 broken link\(s\)/);
  const subpathLlms = readFileSync(join(publicDir, 'llms.txt'), 'utf8');
  assert.match(
    subpathLlms,
    /\[Bootstrap Interview Reference\]\(https:\/\/docs\.gpustack\.ai\/loopwright\/latest\/references\/bootstrap-interview\.md\)/,
    'subpath llms.txt must emit full absURL for flat reference entries'
  );

  // Restore default "/" build
  const restoreBuild = spawnSync(process.execPath, [siteScript, 'build'], {
    encoding: 'utf8',
    timeout: 30000,
    cwd: REPO_ROOT,
  });
  assert.equal(restoreBuild.status, 0, `restore site.mjs build failed:\nstdout: ${restoreBuild.stdout}\nstderr: ${restoreBuild.stderr}`);
});

test('coding-agents apply snippet: matches loopwright-step skill, handles inspect bundle, classic/overlay deletes, 0755 preservation, and blocks hardlinks/symlinks', () => {
  const docText = readFileSync(join(REPO_ROOT, 'docs', 'references', 'coding-agent-protocol.md'), 'utf8');
  const skillText = readFileSync(join(REPO_ROOT, '.agents', 'skills', 'loopwright-step', 'SKILL.md'), 'utf8');

  const docMatch = docText.match(/node -e '\n([\s\S]*?)\n' "\$INSPECT_DIR" \./);
  const skillMatch = skillText.match(/node -e '\n([\s\S]*?)\n' "\$INSPECT_DIR" <repo-dir>/);
  assert.ok(docMatch?.[1], 'docs/references/coding-agent-protocol.md must include node -e apply snippet');
  assert.ok(skillMatch?.[1], 'loopwright-step/SKILL.md must include node -e apply snippet');
  assert.equal(docMatch[1], skillMatch[1], 'coding-agent-protocol.md and loopwright-step/SKILL.md apply scripts must stay identical');
  const applyScript = docMatch[1];

  const mainJs = fileURLToPath(new URL('../src/main.js', import.meta.url));
  const tmpRoot = realpathSync(mkdtempSync(join(tmpdir(), 'lw-coding-agents-test-')));
  try {
    const repoDir = join(tmpRoot, 'repo');
    const runRoot = join(tmpRoot, 'runs');
    const inspectParent = join(tmpRoot, 'inspect-parent');
    const inspectDir = join(inspectParent, 'bundle');
    mkdirSync(join(repoDir, '.loopwright'), { recursive: true, mode: 0o700 });
    mkdirSync(join(repoDir, '.agents', 'skills', 'demo'), { recursive: true, mode: 0o700 });
    mkdirSync(join(repoDir, '.claude'), { recursive: true, mode: 0o700 });
    mkdirSync(join(repoDir, 'docs', 'obsolete'), { recursive: true, mode: 0o700 });
    mkdirSync(runRoot, { recursive: true, mode: 0o700 });
    mkdirSync(inspectParent, { recursive: true, mode: 0o700 });

    writeFileSync(join(repoDir, 'README.md'), '# Repo\n');
    writeFileSync(join(repoDir, '.agents', 'skills', 'demo', 'SKILL.md'), '# Demo\n');
    symlinkSync('../.agents/skills', join(repoDir, '.claude', 'skills'));
    writeFileSync(join(repoDir, 'docs', 'sync.sh'), '#!/bin/sh\necho old\n', { mode: 0o755 });
    chmodSync(join(repoDir, 'docs', 'sync.sh'), 0o755);
    writeFileSync(join(repoDir, 'docs', 'obsolete', 'legacy.md'), 'remove me\n');
    writeFileSync(
      join(repoDir, '.loopwright', 'taskpack.yaml'),
      [
        'apiVersion: loopwright.dev/v1alpha1',
        'kind: Taskpack',
        'metadata:',
        '  name: apply-test',
        'spec:',
        '  goal:',
        '    candidate: Update docs and proposal.',
        '    noChange: Confirm no changes needed.',
        '  scope:',
        '    writable:',
        '      - docs/**',
        '    protected:',
        '      - .claude/**',
        '  upstreams:',
        '    - id: up',
        '      kind: github-release',
        '      source: gpustack/engine',
        '      watchedPaths:',
        '        - docs',
        '  proposal:',
        '    path: docs/proposal.json',
        '    requiredFields:',
        '      - summary',
        '    schemaVersion: 1',
        '  verification:',
        '    localChecks:',
        '      - id: proposal-check',
        '        implementation: json-artifact.v1',
        '    externalGates: []',
        '  publication:',
        '    mode: pull_request',
        '    targetBranch: main',
        '    headBranchPrefix: auto-sync/',
        '    titleTemplate: "chore: sync"',
        '  memory:',
        '    directory: .loopwright/memory/apply-test',
        '    apply: separate-pull-request',
        '    onNoModelBudget: deterministic-observations-only',
        '  triggers:',
        '    schedule: false',
        '    workflowDispatch: true',
        '    releasePublished: false',
        '    commentCommands: []',
        '',
      ].join('\n'),
    );

    execFileSync('git', ['init', '-b', 'main'], { cwd: repoDir, stdio: 'ignore' });
    execFileSync('git', ['config', 'user.name', 'Test'], { cwd: repoDir, stdio: 'ignore' });
    execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: repoDir, stdio: 'ignore' });
    execFileSync('git', ['add', '.'], { cwd: repoDir, stdio: 'ignore' });
    execFileSync('git', ['commit', '-m', 'init'], { cwd: repoDir, stdio: 'ignore' });
    const baseSha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repoDir, encoding: 'utf8' }).trim();

    const nextRun = spawnSync(
      process.execPath,
      [mainJs, 'step', 'next', '--taskpack', '.loopwright/taskpack.yaml', '--repo', repoDir, '--run-root', runRoot, '--run-id', 'r1', '--json'],
      { encoding: 'utf8', timeout: 20000 },
    );
    assert.equal(nextRun.status, 0, nextRun.stderr || nextRun.stdout);
    const yieldLine = JSON.parse(nextRun.stdout.trim().split('\n').at(-1) ?? '{}') as {
      data: { candidateDir: string; leaseToken: string };
    };
    const { candidateDir, leaseToken } = yieldLine.data;

    // Mutate inside candidateDir: update 0755 script, delete tracked file (classic snapshot!), add proposal.json
    writeFileSync(join(candidateDir, 'docs', 'sync.sh'), '#!/bin/sh\necho updated\n');
    rmSync(join(candidateDir, 'docs', 'obsolete', 'legacy.md'));
    writeFileSync(join(candidateDir, 'docs', 'proposal.json'), JSON.stringify({ schema_version: 1, summary: 'ok' }) + '\n');

    const submitRun = spawnSync(
      process.execPath,
      [mainJs, 'step', 'submit', '--run-root', runRoot, '--run-id', 'r1', '--lease', leaseToken, '--status', 'completed', '--json'],
      { encoding: 'utf8', timeout: 20000 },
    );
    assert.equal(submitRun.status, 0, submitRun.stderr || submitRun.stdout);
    const submitEnv = JSON.parse(submitRun.stdout.trim().split('\n').at(-1) ?? '{}') as {
      kind: string;
      data: { result?: { spec?: { status?: string } } };
    };
    assert.equal(submitEnv.kind, 'result', submitRun.stdout);
    assert.equal(submitEnv.data.result?.spec?.status, 'completed');
    assert.ok(!existsSync(candidateDir), 'terminal step submit cleans up candidateDir');

    // Export to non-existent child path inspectParent/bundle
    const inspectRun = spawnSync(
      process.execPath,
      [mainJs, 'inspect', '--run-root', runRoot, '--run-id', 'r1', '--output', inspectDir, '--json'],
      { encoding: 'utf8', timeout: 20000 },
    );
    assert.equal(inspectRun.status, 0, inspectRun.stderr || inspectRun.stdout);

    const expectApplyRefused = (expectedStderr: RegExp) => {
      const res = spawnSync(process.execPath, ['-e', applyScript, inspectDir, repoDir], { encoding: 'utf8' });
      assert.notEqual(res.status, 0, 'apply script must exit non-zero');
      assert.match(res.stderr, expectedStderr);
    };
    assert.equal(JSON.parse(readFileSync(join(inspectDir, 'result.json'), 'utf8')).spec?.status, 'completed');
    const candidateBundle = JSON.parse(readFileSync(join(inspectDir, 'candidate.files.json'), 'utf8')) as {
      version: number;
      manifest?: { spec?: { baseTree?: unknown } };
      files?: Array<{ name: string; uri?: string; blobPath?: string; sha256?: string }>;
    };
    assert.equal(candidateBundle.version, 2, 'inspect emits v2 CAS pointer candidate.files.json');
    assert.equal(candidateBundle.manifest?.spec?.baseTree, undefined);
    assert.ok(
      candidateBundle.files?.every(f => typeof f.uri === 'string' && f.uri.startsWith('cas://sha256/') && typeof f.blobPath === 'string'),
      'v2 files carry canonical cas://sha256 URI and blobPath',
    );

    // Negative test 1: dirty working tree (tracked edit or untracked file) must be refused
    writeFileSync(join(repoDir, 'README.md'), '# Dirty\n');
    expectApplyRefused(/Error: Refusing apply: working tree is dirty/);
    writeFileSync(join(repoDir, 'README.md'), '# Repo\n');

    writeFileSync(join(repoDir, 'untracked.txt'), 'scratch\n');
    expectApplyRefused(/Error: Refusing apply: working tree is dirty/);
    rmSync(join(repoDir, 'untracked.txt'));

    // Negative test 2: drifted HEAD commit (content, empty, or mode-only) must be refused
    execFileSync('git', ['commit', '--allow-empty', '-m', 'empty-drift'], { cwd: repoDir, stdio: 'ignore' });
    expectApplyRefused(/Error: Refusing apply: HEAD != sourceRevision/);
    execFileSync('git', ['reset', '--hard', baseSha], { cwd: repoDir, stdio: 'ignore' });

    chmodSync(join(repoDir, 'docs', 'sync.sh'), 0o644);
    execFileSync('git', ['commit', '-am', 'mode-drift'], { cwd: repoDir, stdio: 'ignore' });
    expectApplyRefused(/Error: Refusing apply: HEAD != sourceRevision/);
    execFileSync('git', ['reset', '--hard', baseSha], { cwd: repoDir, stdio: 'ignore' });

    // Negative test 3: hardlinked file in clean checkout (matching bytes/mode so git status is clean) must be refused
    const sentinel = join(tmpRoot, 'outside-sentinel.sh');
    writeFileSync(sentinel, '#!/bin/sh\necho old\n', { mode: 0o755 });
    chmodSync(sentinel, 0o755);
    rmSync(join(repoDir, 'docs', 'sync.sh'));
    linkSync(sentinel, join(repoDir, 'docs', 'sync.sh'));
    assert.equal(
      execFileSync('git', ['-C', repoDir, 'status', '--porcelain', '-z', '--untracked-files=all'], { encoding: 'utf8' }),
      '',
      'git status is clean so nlink !== 1 guard is exercised directly',
    );
    expectApplyRefused(/Error: Unsafe target: docs\/sync\.sh/);
    assert.equal(readFileSync(sentinel, 'utf8'), '#!/bin/sh\necho old\n', 'outside hardlink sentinel must remain untouched');

    // Restore normal executable 0755 file in checkout
    rmSync(join(repoDir, 'docs', 'sync.sh'));
    writeFileSync(join(repoDir, 'docs', 'sync.sh'), '#!/bin/sh\necho old\n', { mode: 0o755 });
    chmodSync(join(repoDir, 'docs', 'sync.sh'), 0o755);

    // Apply cleanly: verifies tracked 120000 symlink preservation, classic deletion, dir cleanup, 0755 preservation, and 0644 creation
    const cleanApply = spawnSync(process.execPath, ['-e', applyScript, inspectDir, repoDir], { encoding: 'utf8' });
    assert.equal(cleanApply.status, 0, cleanApply.stderr || cleanApply.stdout);
    assert.ok(lstatSync(join(repoDir, '.claude', 'skills')).isSymbolicLink(), 'tracked 120000 protected symlink preserved');
    assert.ok(!existsSync(join(repoDir, 'docs', 'obsolete', 'legacy.md')), 'deleted file removed in classic snapshot mode');
    assert.ok(!existsSync(join(repoDir, 'docs', 'obsolete')), 'empty parent directory pruned after deletion');
    assert.equal(readFileSync(join(repoDir, 'docs', 'sync.sh'), 'utf8'), '#!/bin/sh\necho updated\n');
    assert.equal(lstatSync(join(repoDir, 'docs', 'sync.sh')).mode & 0o777, 0o755, 'existing 0755 preserved');
    assert.equal(JSON.parse(readFileSync(join(repoDir, 'docs', 'proposal.json'), 'utf8')).summary, 'ok');
    assert.equal(lstatSync(join(repoDir, 'docs', 'proposal.json')).mode & 0o777, 0o644, 'new file written as 0644');
  } finally {
    rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test('coding-agents apply snippet: Managed Controller refuses symbolic classic sourceRevision and rejects empty or mode-only HEAD drift', async () => {
  const repoRoot = findRepositoryRoot();
  const codingAgentsProtocolDoc = readFileSync(join(repoRoot, 'docs', 'references', 'coding-agent-protocol.md'), 'utf8');
  const applyScript = /node -e '([\s\S]*?)' "\$INSPECT_DIR" \./.exec(codingAgentsProtocolDoc)?.[1] ?? '';
  assert.ok(applyScript.length > 0);
  const mainJs = fileURLToPath(new URL('../src/main.js', import.meta.url));

  const f = await configurationFixture();
  try {
    const repository = join(f.root, 'repository');
    const runRoot = join(f.root, 'runs');
    mkdirSync(join(repository, 'packages'), { recursive: true, mode: 0o700 });
    mkdirSync(runRoot, { recursive: true, mode: 0o700 });
    writeFileSync(join(repository, 'packages', 'result.json'), JSON.stringify({ ok: false }) + '\n', { mode: 0o644 });
    writeFileSync(join(repository, 'packages', 'run.sh'), '#!/bin/sh\necho v1\n', { mode: 0o755 });
    chmodSync(join(repository, 'packages', 'run.sh'), 0o755);

    execFileSync('git', ['init', '-b', 'main'], { cwd: repository, stdio: 'ignore' });
    execFileSync('git', ['config', 'user.name', 'Test'], { cwd: repository, stdio: 'ignore' });
    execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: repository, stdio: 'ignore' });
    execFileSync('git', ['add', '.'], { cwd: repository, stdio: 'ignore' });
    execFileSync('git', ['commit', '-m', 'init'], { cwd: repository, stdio: 'ignore' });
    const baseSha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repository, encoding: 'utf8' }).trim();

    const installed = await installedHandlerDigests();
    setFixture(f.config, ['spec', 'task', 'spec', 'scope'], { writable: ['packages/**'], protected: [] });
    setFixture(f.registry, ['spec', 'handlers'], [
      {
        id: 'author.step',
        version: 1,
        digest: installed['pi.agent.v1'],
        kind: 'agent',
        implementation: 'pi.agent.v1',
        parameters: { purpose: 'task', prompt: 'Update packages/result.json and packages/run.sh.' },
        capabilities: ['pi'],
      },
      {
        id: 'tests',
        version: 1,
        digest: installed['json-artifact.v1'],
        kind: 'check',
        implementation: 'json-artifact.v1',
        parameters: { checkId: 'tests', path: 'packages/result.json', required: ['ok'], equals: { ok: true } },
        capabilities: ['inert_bytes', 'read_only'],
      },
      ...f.registry.spec.handlers.filter(h => h.id === 'scope' || h.id === 'no-change').map(h => ({ ...h })),
    ]);
    setFixture(f.registry, ['spec', 'runtimeProfiles'], []);
    setFixture(f.registry, ['spec', 'credentialBindings'], []);
    setFixture(f.registry, ['spec', 'environmentBindings'], []);
    setFixture(f.config, ['spec', 'credentials'], []);
    setFixture(f.registry, ['spec', 'roleProfiles'], [
      {
        id: 'author',
        adapter: 'delegated',
        runtimeRef: null,
        providerCredentialRef: null,
        selection: { provider: 'antigravity', model: 'gemini-4-default', thinking: 'medium' },
        tools: ['read', 'write', 'edit'],
        mcp: null,
      },
    ]);
    setFixture(f.config, ['spec', 'task', 'spec', 'roles'], [
      {
        id: 'author',
        adapter: 'delegated',
        provider: 'antigravity',
        model: 'gemini-4-default',
        thinking: 'medium',
        tools: ['read', 'write', 'edit'],
      },
    ]);
    setFixture(f.config, ['spec', 'profiles', 'roles'], [{ roleId: 'author', profileRef: 'author' }]);
    setFixture(f.config, ['spec', 'task', 'spec', 'steps'], [
      { id: 'author', kind: 'agent', uses: 'author.step', roleId: 'author', dependsOn: [] },
      { id: 'verify', kind: 'check', uses: 'tests', roleId: null, dependsOn: ['author'] },
    ]);
    setFixture(f.config, ['spec', 'profiles', 'steps'], [
      { stepId: 'author', handlerRef: 'author.step' },
      { stepId: 'verify', handlerRef: 'tests' },
    ]);
    setFixture(f.config, ['spec', 'task', 'spec', 'acceptance'], {
      required: ['tests'],
      checks: [{ id: 'tests', allowedEvidenceLevels: ['local_execution'] }],
    });

    const runManaged = async (runId: string, sourceRevision: string) => {
      setFixture(f.config, ['spec', 'task', 'spec', 'target', 'baseRevision'], baseSha);
      setFixture(f.config, ['spec', 'task', 'spec', 'target', 'sourceRevision'], sourceRevision);
      await f.save();
      const nextRes = spawnSync(
        process.execPath,
        [mainJs, 'step', 'next', '--config', f.input.configPath, '--registry', f.input.registryPath, '--registry-sha256', f.input.registrySha256, '--repo', repository, '--run-root', runRoot, '--run-id', runId, '--json'],
        { encoding: 'utf8', timeout: 20000 },
      );
      assert.equal(nextRes.status, 0, nextRes.stderr || nextRes.stdout);
      const stepData = (JSON.parse(nextRes.stdout.trim().split('\n').at(-1) ?? '{}') as {
        data: { candidateDir: string; leaseToken: string };
      }).data;
      writeFileSync(join(stepData.candidateDir, 'packages', 'result.json'), JSON.stringify({ ok: true }) + '\n');
      writeFileSync(join(stepData.candidateDir, 'packages', 'run.sh'), '#!/bin/sh\necho v2\n');
      const subRes = spawnSync(
        process.execPath,
        [mainJs, 'step', 'submit', '--run-root', runRoot, '--run-id', runId, '--lease', stepData.leaseToken, '--status', 'completed', '--json'],
        { encoding: 'utf8', timeout: 20000 },
      );
      assert.equal(subRes.status, 0, subRes.stderr || subRes.stdout);
      const outDir = join(f.root, `inspect-${runId}`);
      const insRes = spawnSync(
        process.execPath,
        [mainJs, 'inspect', '--run-root', runRoot, '--run-id', runId, '--output', outDir, '--json'],
        { encoding: 'utf8', timeout: 20000 },
      );
      assert.equal(insRes.status, 0, insRes.stderr || insRes.stdout);
      assert.equal(JSON.parse(readFileSync(join(outDir, 'result.json'), 'utf8')).spec?.status, 'completed');
      assert.equal(JSON.parse(readFileSync(join(outDir, 'candidate.files.json'), 'utf8')).manifest?.spec?.baseTree, undefined);
      assert.equal(JSON.parse(readFileSync(join(outDir, 'task.lock.json'), 'utf8')).spec?.contract?.spec?.target?.sourceRevision, sourceRevision);
      return outDir;
    };
    const expectManagedRefused = (inspectPath: string, expectedStderr: RegExp) => {
      const res = spawnSync(process.execPath, ['-e', applyScript, inspectPath, repository], { encoding: 'utf8' });
      assert.notEqual(res.status, 0, 'apply script must exit non-zero');
      assert.match(res.stderr, expectedStderr);
    };

    // 1. Symbolic sourceRevision: HEAD in classic mode is refused (even on untouched HEAD, empty commit, or mode-only commit)
    const symInspect = await runManaged('mc-sym', 'HEAD');
    expectManagedRefused(symInspect, /Error: Refusing apply: classic snapshot requires pinned commit OID sourceRevision/);
    execFileSync('git', ['commit', '--allow-empty', '-m', 'empty-after-sym'], { cwd: repository, stdio: 'ignore' });
    expectManagedRefused(symInspect, /Error: Refusing apply: classic snapshot requires pinned commit OID sourceRevision/);
    execFileSync('git', ['reset', '--hard', baseSha], { cwd: repository, stdio: 'ignore' });
    chmodSync(join(repository, 'packages', 'run.sh'), 0o644);
    execFileSync('git', ['commit', '-am', 'mode-only-after-sym'], { cwd: repository, stdio: 'ignore' });
    expectManagedRefused(symInspect, /Error: Refusing apply: classic snapshot requires pinned commit OID sourceRevision/);
    execFileSync('git', ['reset', '--hard', baseSha], { cwd: repository, stdio: 'ignore' });

    // 2. Pinned commit OID sourceRevision rejects empty and mode-only HEAD drift, then applies cleanly on exact baseSha
    const pinnedInspect = await runManaged('mc-pinned', baseSha);
    execFileSync('git', ['commit', '--allow-empty', '-m', 'empty-after-pinned'], { cwd: repository, stdio: 'ignore' });
    expectManagedRefused(pinnedInspect, /Error: Refusing apply: HEAD != sourceRevision/);
    execFileSync('git', ['reset', '--hard', baseSha], { cwd: repository, stdio: 'ignore' });

    chmodSync(join(repository, 'packages', 'run.sh'), 0o644);
    execFileSync('git', ['commit', '-am', 'mode-only-after-pinned'], { cwd: repository, stdio: 'ignore' });
    expectManagedRefused(pinnedInspect, /Error: Refusing apply: HEAD != sourceRevision/);
    execFileSync('git', ['reset', '--hard', baseSha], { cwd: repository, stdio: 'ignore' });

    const cleanManagedApply = spawnSync(process.execPath, ['-e', applyScript, pinnedInspect, repository], { encoding: 'utf8' });
    assert.equal(cleanManagedApply.status, 0, cleanManagedApply.stderr || cleanManagedApply.stdout);
    assert.equal(JSON.parse(readFileSync(join(repository, 'packages', 'result.json'), 'utf8')).ok, true);
    assert.equal(readFileSync(join(repository, 'packages', 'run.sh'), 'utf8'), '#!/bin/sh\necho v2\n');
    assert.equal(lstatSync(join(repository, 'packages', 'run.sh')).mode & 0o777, 0o755);
  } finally {
    await f.cleanup();
  }
});
