import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { appendFileSync, fsyncSync, openSync, closeSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { configurationFixture } from './config-fixtures.js';
import { setFixture } from './progress-fixtures.js';
export async function cycleFixture(valid: boolean, initialBytes?: Uint8Array) {
  const f = await configurationFixture(), repository = join(f.root, 'repository'), runRoot = join(f.root, 'runs'); await mkdir(repository, { mode: 0o700 });
  const registry = resolve('.claude/s04-qualification/cycle-fixtures.ndjson');
  appendFileSync(registry, JSON.stringify({ version: 1, root: f.root, repository, runRoot, kind: 'real-git-s02-worker-core-check-only' }) + '\n', { mode: 0o600 }); const fd = openSync(registry, 'r'); try { fsyncSync(fd); } finally { closeSync(fd); }
  const git = (args: string[]) => execFileSync('/usr/bin/git', ['-c', 'core.hooksPath=/dev/null', ...args], { cwd: repository, env: { PATH: '/usr/bin:/bin', LANG: 'C', LC_ALL: 'C', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', HOME: '/nonexistent', GIT_TERMINAL_PROMPT: '0' }, timeout: 5000, encoding: 'utf8' });
  git(['init', '-q']); await writeFile(join(repository, 'result.json'), initialBytes ?? JSON.stringify({ ok: valid }), { mode: 0o600 }); git(['add', 'result.json']); git(['-c', 'user.name=Controller Fixture', '-c', 'user.email=fixture@localhost.invalid', 'commit', '-qm', 'freeze inert input']); const revision = git(['rev-parse', 'HEAD']).trim();
  setFixture(f.config, ['spec', 'task', 'spec', 'target', 'baseRevision'], revision); setFixture(f.config, ['spec', 'task', 'spec', 'target', 'sourceRevision'], revision);
  setFixture(f.config, ['spec', 'task', 'spec', 'steps'], [{ id: 'verify', kind: 'check', uses: 'tests', roleId: null, dependsOn: [] }]);
  setFixture(f.config, ['spec', 'profiles', 'steps'], [{ stepId: 'verify', handlerRef: 'tests' }]); setFixture(f.config, ['spec', 'credentials'], []);
  await f.save(); const loaded = await f.load(); assert.equal(loaded.ok, true); if (!loaded.ok) throw new Error('fixture');
  return { ...f, repository, runRoot, loaded: loaded.value };
}
