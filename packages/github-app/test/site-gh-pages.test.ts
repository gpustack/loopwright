import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

describe('gh-pages multi-version site archive (gpustack/mike alignment)', () => {
  it('sync-gh-pages emits mike-compatible versions.json, .nojekyll, latest/ redirect index.html, and root llms.txt', async () => {
    const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
    const ghPagesDir = await mkdtemp(join(await realpath(tmpdir()), 'lw-gh-pages-test-'));
    try {
      for (const [ver, kind] of [['0.1', 'stable'], ['0.2', 'stable'], ['main', 'development']] as const) {
        const dir = join(ghPagesDir, ver);
        await mkdir(dir, { recursive: true });
        await writeFile(join(dir, 'site-version.json'), JSON.stringify({
          version: ver,
          releaseKind: kind,
          gitSha: 'abcdef0',
        }), 'utf8');
        await writeFile(join(dir, 'llms.txt'), `# Loopwright (${ver})\n`, 'utf8');
      }
      await mkdir(join(ghPagesDir, 'latest'), { recursive: true });
      await writeFile(join(ghPagesDir, 'latest', 'llms.txt'), '# Loopwright (0.2)\n', 'utf8');

      await execFileAsync(process.execPath, [join(repoRoot, 'scripts', 'site.mjs'), 'sync-gh-pages', ghPagesDir]);

      const versions = JSON.parse(await readFile(join(ghPagesDir, 'versions.json'), 'utf8')) as {
        version: string;
        title: string;
        aliases: string[];
      }[];
      assert.deepEqual(versions, [
        { version: '0.2', title: '0.2', aliases: ['latest'] },
        { version: '0.1', title: '0.1', aliases: [] },
        { version: 'main', title: 'main', aliases: [] },
      ]);
      const indexHtml = await readFile(join(ghPagesDir, 'index.html'), 'utf8');
      assert.match(indexHtml, /window\.location\.replace\(\s*"latest\/"/);
      const llmsTxt = await readFile(join(ghPagesDir, 'llms.txt'), 'utf8');
      assert.equal(llmsTxt, '# Loopwright (0.2)\n');
      const nojekyll = await readFile(join(ghPagesDir, '.nojekyll'), 'utf8');
      assert.equal(nojekyll, '');
    } finally {
      await rm(ghPagesDir, { recursive: true, force: true });
    }
  });
});
