import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, rm, readFile, writeFile, symlink, lstat, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { cycleFixture } from '../../controller/test/scheduling-fixtures.js';
import { parseArguments } from '../src/arguments.js';
import { encoded, diagnosticExit, executionExit } from '../src/main.js';
import { initDraft } from '../src/draft.js';
import type { ControllerDiagnostic, CycleExecution } from '@loopwright/controller';
for (const argv of [[], ['status'], ['status', '--run-root', '/tmp', '--run-id', 'x', '--run-id', 'y'], ['status', '--run-root', '/tmp', '--run-id', 'x', 'extra'], ['check', '--config'], ['run', '--config', 'a', '--registry', 'b', '--registry-sha256', 'c'], ['status', '--run-root', '/tmp', '--run-id', 'x', '--latest'], ['run', '--dry-run', '--config', 'a', '--registry', 'b', '--registry-sha256', 'c', '--repo', '/tmp']]) test('cli: rejects incomplete/duplicate/unknown argument set ' + JSON.stringify(argv), () => assert.throws(() => parseArguments(argv)));
test('cli: accepts every exact documented command flag shape', () => {
  const common = ['--config', '/config', '--registry', '/registry', '--registry-sha256', 'a'.repeat(64)], run = ['--repo', '/repo', '--run-root', '/runs', '--run-id', 'id'];
  for (const args of [['init', '--directory', '/draft', '--force', '--json'], ['check', ...common, '--output', '/plan', '--json'], ['run', ...common, '--dry-run'], ['run', ...common, ...run, '--json'], ['resume', ...common, ...run], ['reconcile', ...common, ...run, '--receipt', '/receipt.json', '--json'], ['status', '--run-root', '/runs', '--run-id', 'id'], ['inspect', '--run-root', '/runs', '--run-id', 'id', '--output', '/export']]) assert.doesNotThrow(() => parseArguments(args));
  assert.throws(() => parseArguments(['reconcile', ...common, ...run]));
});
test('cli: display encodes controls, ANSI, workflow text and line separators', () => {
  const value = '\u001b[31m\n::warning::\r\u0085\u2028'; const output = encoded(value); assert.equal(output.includes('\u001b'), false); assert.equal(output.includes('\n'), false); assert.equal(output.includes('::'), false); assert.equal(output.includes('\u0085'), false); assert.equal(JSON.parse(output), value);
});
test('cli: strict credential-free draft refuses overwrite and force replaces only named regular owned files', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'lw-cli-'))), directory = join(root, 'draft'); await initDraft(directory, false);
  await writeFile(join(directory, 'unowned.txt'), 'retained', { mode: 0o600 }); await assert.rejects(initDraft(directory, false)); await initDraft(directory, true);
  assert.equal(await readFile(join(directory, 'unowned.txt'), 'utf8'), 'retained');
  const draft = JSON.parse(await readFile(join(directory, 'controller.draft.json'), 'utf8')); assert.equal(draft.spec.task.spec.budgets.wallTimeMs, 600000); assert.deepEqual(draft.spec.credentials, []); assert.match(await readFile(join(directory, 'README.draft.md'), 'utf8'), /proven_bound/);
  const linked = join(root, 'linked'); await symlink(directory, linked); await assert.rejects(initDraft(linked, true));
});
test('cli: production subprocess help/version/status perform no credential discovery or admission', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'lw-cli-subprocess-'))), main = fileURLToPath(new URL('../src/main.js', import.meta.url));
  for (const argv of [['--help'], ['--version']]) { const result = spawnSync(process.execPath, [main, ...argv], { encoding: 'utf8', timeout: 5000, env: { PATH: '/usr/bin:/bin' } }); assert.equal(result.status, 0, result.stderr); }
  const result = spawnSync(process.execPath, [main, 'status', '--run-root', join(root, 'runs'), '--run-id', 'missing', '--json'], { encoding: 'utf8', timeout: 5000, env: { PATH: '/usr/bin:/bin' } }); assert.equal(result.status, 8, result.stderr); const envelope = JSON.parse(result.stdout); assert.equal(envelope.kind, 'status'); assert.equal(envelope.data.status, null); assert.equal(envelope.data.source, 'unavailable');
  assert.equal(await lstat(join(root, 'runs')).then(() => true, () => false), false);
});
test('cli: stable terminal and diagnostic exit mapping preserves uncertainty over signal', () => {
  for (const [status, code] of [['completed', 0], ['no_change', 0], ['blocked', 3], ['failed', 4], ['exhausted', 5], ['expired', 6], ['reconcile_required', 7], ['cancelled', 130]] as const) {
    const value = { kind: 'result', result: { spec: { status } } } as CycleExecution; assert.equal(executionExit(value, 'SIGINT'), code); if (status === 'cancelled') assert.equal(executionExit(value, 'SIGTERM'), 143);
  }
  for (const [code, phase, expected] of [['CONFIG_SYNTAX', 'configuration', 2], ['OWNER_BUSY', 'recovery', 7], ['BUDGET_EXHAUSTED', 'recovery', 5], ['DEADLINE', 'recovery', 6], ['RECEIPT_CONFLICT', 'recovery', 7], ['CLEANUP_FAILED', 'recovery', 8]] as const) assert.equal(diagnosticExit({ code, phase } as ControllerDiagnostic), expected);
});

test('cli: real subprocess dry-run, run, resume and inspect share production public controller paths', async () => {
  const f = await cycleFixture(true), main = fileURLToPath(new URL('../src/main.js', import.meta.url));
  const common = ['--config', f.input.configPath, '--registry', f.input.registryPath, '--registry-sha256', f.input.registrySha256];
  const invoke = (args: string[]) => spawnSync(process.execPath, [main, ...args, '--json'], { encoding: 'utf8', timeout: 15000, env: { PATH: '/usr/bin:/bin' } });
  const checked = invoke(['run', '--dry-run', ...common]); assert.equal(checked.status, 0, checked.stdout + checked.stderr); assert.equal(JSON.parse(checked.stdout).kind, 'plan'); assert.equal(await lstat(f.runRoot).then(() => true, () => false), false);
  const run = ['--repo', f.repository, '--run-root', f.runRoot, '--run-id', 'cli-cycle'];
  const first = invoke(['run', ...common, ...run]); assert.equal(first.status, 0, first.stdout + first.stderr);
  const envelopes = first.stdout.trim().split('\n').map(line => JSON.parse(line)); assert.ok(envelopes.some(row => row.kind === 'event')); assert.equal(envelopes.at(-1).kind, 'result'); assert.deepEqual(envelopes.map(row => row.sequence), envelopes.map((_, index) => index + 1));
  const resumed = invoke(['resume', ...common, ...run]); assert.equal(resumed.status, 0, resumed.stdout + resumed.stderr); assert.equal(resumed.stdout.trim().split('\n').length, 1); assert.equal(JSON.parse(resumed.stdout).kind, 'result');
  const inspected = invoke(['inspect', '--run-root', f.runRoot, '--run-id', 'cli-cycle', '--output', join(f.root, 'cli-export')]); assert.equal(inspected.status, 0, inspected.stdout + inspected.stderr); assert.equal(JSON.parse(inspected.stdout).kind, 'inspection');
});

test('cli: human-mode diagnostic writes summary to stderr while --json diagnostic writes envelope to stdout', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'lw-cli-diag-'))), main = fileURLToPath(new URL('../src/main.js', import.meta.url));
  try {
    const badArgs = ['check', '--config', join(root, 'missing.json'), '--registry', join(root, 'missing-reg.json'), '--registry-sha256', 'a'.repeat(64)];
    const human = spawnSync(process.execPath, [main, ...badArgs], { encoding: 'utf8', timeout: 5000, env: { PATH: '/usr/bin:/bin' } });
    assert.equal(human.status, 2); assert.equal(human.stdout, ''); assert.match(human.stderr, /REGISTRY_UNTRUSTED/);
    const json = spawnSync(process.execPath, [main, ...badArgs, '--json'], { encoding: 'utf8', timeout: 5000, env: { PATH: '/usr/bin:/bin' } });
    assert.equal(json.status, 2); assert.equal(json.stderr, ''); assert.equal(JSON.parse(json.stdout).kind, 'diagnostic');
  } finally { await rm(root, { recursive: true, force: true }); }
});
