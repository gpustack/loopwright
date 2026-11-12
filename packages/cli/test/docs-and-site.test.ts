import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, lstatSync, readFileSync, readlinkSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseDocument } from 'yaml';

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
  assert.ok(rulePaths.has('packages/github-app/**/*.ts'), 'must cover github-app');
  assert.ok(rulePaths.has('packages/cli/**/*.ts'), 'must cover cli');
  assert.ok(rulePaths.has('action.yml'), 'must cover action.yml');
  assert.ok(rulePaths.has('docs/**/*.md'), 'must cover docs');
  assert.ok(rulePaths.has('README.md'), 'must cover README.md');

  // 3. Five repository skills
  const expectedSkills = [
    'loopwright-overview',
    'loopwright-docs',
    'loopwright-code-review',
    'loopwright-issue-pr',
    'loopwright-release'
  ];
  for (const skillName of expectedSkills) {
    const skillFile = join(REPO_ROOT, '.agents', 'skills', skillName, 'SKILL.md');
    assert.ok(existsSync(skillFile), `skill ${skillName}/SKILL.md must exist`);
    const content = readFileSync(skillFile, 'utf8');
    assert.match(content, /^---\n/, `${skillName} must start with frontmatter`);
    assert.match(content, /\nname:\s*[^\n]+/, `${skillName} must declare name in frontmatter`);
    assert.match(content, /\ndescription:\s*[^\n]+/, `${skillName} must declare description in frontmatter`);
  }

  // 4. .claude/skills symlink
  const claudeSkillsPath = join(REPO_ROOT, '.claude', 'skills');
  assert.ok(existsSync(claudeSkillsPath), '.claude/skills must exist');
  const stat = lstatSync(claudeSkillsPath);
  assert.ok(stat.isSymbolicLink(), '.claude/skills must be a symbolic link');
  const target = readlinkSync(claudeSkillsPath);
  assert.ok(target.endsWith('.agents/skills'), `.claude/skills must point to .agents/skills, got: ${target}`);
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

test('hugo site: site.mjs build builds 12-page site, exports markdown, renders reading footers, and verifies zero broken links', () => {
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
  assert.match(build.stdout, /Verified \d+ HTML pages and 12 Markdown exports; 0 broken link\(s\)/);

  const publicDir = join(REPO_ROOT, 'site', 'public');
  assert.ok(existsSync(join(publicDir, 'llms.txt')), 'llms.txt must exist');
  assert.ok(existsSync(join(publicDir, 'site-version.json')), 'site-version.json must exist');
  assert.ok(existsSync(join(publicDir, 'index.json')), 'index.json must exist');

  // Verify llms.txt content
  const llms = readFileSync(join(publicDir, 'llms.txt'), 'utf8');
  const llmsMatches = llms.match(/^-\s+\[[^\]]+\]\(\/docs\/[^)]+\):/gm);
  assert.equal(llmsMatches?.length, 12, 'llms.txt must list exactly 12 docs pages');
  assert.ok(!llms.includes('/docs/development/'), 'llms.txt must not contain /docs/development/');
  assert.ok(!llms.includes('/docs/contribute/'), 'llms.txt must not contain /docs/contribute/');
  assert.ok(!llms.includes('/docs/adr/'), 'llms.txt must not contain /docs/adr/');

  // Verify site-version.json content
  const version = JSON.parse(readFileSync(join(publicDir, 'site-version.json'), 'utf8')) as { version?: string };
  assert.ok(version.version, 'site-version.json must contain version');

  // Verify index.json content
  const index = JSON.parse(readFileSync(join(publicDir, 'index.json'), 'utf8')) as unknown[];
  assert.ok(Array.isArray(index) && index.length >= 12, 'index.json must contain at least 12 pages');

  // Verify 12 markdown and html exports exist under docs/<group>/<slug>/
  const canonicalPages = [
    'getting-started/architecture',
    'getting-started/installation',
    'operations/github-action',
    'operations/github-app',
    'operations/cli',
    'walkthroughs/declarative-taskpack',
    'walkthroughs/managed-controller',
    'configuration/taskpack',
    'configuration/task-contract',
    'configuration/controller-and-registry',
    'configuration/sandbox-backends',
    'configuration/decision-routing'
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

  // Verify excluded Contribute and ADR pages do NOT exist in site/public/docs/
  assert.ok(!existsSync(join(publicDir, 'docs', 'development')), 'docs/development must not exist in site/public');
  assert.ok(!existsSync(join(publicDir, 'docs', 'contribute')), 'docs/contribute must not exist in site/public');
  assert.ok(!existsSync(join(publicDir, 'docs', 'adr')), 'docs/adr must not exist in site/public');

  // Verify subpath SITE_BASE_URL build and verification (GitHub Pages subpath deployment)
  const subpathBuild = spawnSync(process.execPath, [siteScript, 'build'], {
    encoding: 'utf8',
    timeout: 30000,
    cwd: REPO_ROOT,
    env: { ...process.env, SITE_BASE_URL: 'https://docs.gpustack.ai/loopwright/' }
  });
  assert.equal(subpathBuild.status, 0, `subpath site.mjs build failed:\nstdout: ${subpathBuild.stdout}\nstderr: ${subpathBuild.stderr}`);
  assert.match(subpathBuild.stdout, /Verified \d+ HTML pages and 12 Markdown exports; 0 broken link\(s\)/);

  // Restore default "/" build
  const restoreBuild = spawnSync(process.execPath, [siteScript, 'build'], {
    encoding: 'utf8',
    timeout: 30000,
    cwd: REPO_ROOT,
  });
  assert.equal(restoreBuild.status, 0, `restore site.mjs build failed:\nstdout: ${restoreBuild.stdout}\nstderr: ${restoreBuild.stderr}`);
});
