import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, lstatSync, readFileSync, readlinkSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

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

test('hugo site: site.mjs build builds site, exports markdown, and verifies zero broken links', () => {
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
  assert.match(build.stdout, /Verified \d+ HTML pages and \d+ Markdown exports; 0 broken link\(s\)/);

  const publicDir = join(REPO_ROOT, 'site', 'public');
  assert.ok(existsSync(join(publicDir, 'llms.txt')), 'llms.txt must exist');
  assert.ok(existsSync(join(publicDir, 'site-version.json')), 'site-version.json must exist');
  assert.ok(existsSync(join(publicDir, 'index.json')), 'index.json must exist');

  // Verify llms.txt content
  const llms = readFileSync(join(publicDir, 'llms.txt'), 'utf8');
  const llmsMatches = llms.match(/^-\s+\[[^\]]+\]\(\/docs\/[^)]+\):/gm);
  assert.equal(llmsMatches?.length, 21, 'llms.txt must list exactly 21 docs pages');

  // Verify site-version.json content
  const version = JSON.parse(readFileSync(join(publicDir, 'site-version.json'), 'utf8')) as { version?: string };
  assert.ok(version.version, 'site-version.json must contain version');

  // Verify index.json content
  const index = JSON.parse(readFileSync(join(publicDir, 'index.json'), 'utf8')) as unknown[];
  assert.ok(Array.isArray(index) && index.length >= 21, 'index.json must contain at least 21 pages');

  // Verify 21 markdown and html exports exist under docs/
  const canonicalPages = [
    'getting-started/architecture',
    'operate/github-action',
    'operate/github-app',
    'operate/cli',
    'walkthroughs/declarative-taskpack',
    'contracts',
    'identity',
    'evidence',
    'state',
    'pi-adapter',
    'pi-runtime-evaluation',
    'controller',
    'runner-taskpack',
    'memory',
    'github-app',
    'decisions',
    'closure-matrix',
    'development',
    'contribute/internals',
    'adr/0001-local-state-authority',
    'adr/0002-isolated-pi-sdk'
  ];

  for (const p of canonicalPages) {
    const htmlPath = join(publicDir, 'docs', p, 'index.html');
    const mdPath = join(publicDir, 'docs', p, 'index.md');
    assert.ok(existsSync(htmlPath), `HTML page must exist: ${htmlPath}`);
    assert.ok(existsSync(mdPath), `Markdown export must exist: ${mdPath}`);
  }
});
