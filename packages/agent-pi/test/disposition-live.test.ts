import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawnSync, execFileSync } from 'node:child_process';
import { mkdtemp, rm, writeFile, readFile, realpath, symlink, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
test('live CLI requires explicit estimate and ready-token file without reading ambient auth or starting transport', async () => {
  const directory = await mkdtemp(join(await realpath(tmpdir()), 'loopwright-live-prerequisite-'));
  try {
    const token = join(directory, 'not-a-ready-token'); await writeFile(token, 'invalid', { mode: 0o600 }); const link = join(directory, 'linked-token'), fifo = join(directory, 'fifo-token'); await symlink(token, link); execFileSync('/usr/bin/mkfifo', [fifo]);
    for (const [args, code] of [[[], 'ESTIMATED_GUARD_OPT_IN_REQUIRED'], [['--estimated-guard'], 'READY_TOKEN_REQUIRED'], [['--estimated-guard', '--token-file', token], 'READY_TOKEN_REQUIRED'], [['--estimated-guard', '--token-file', link], 'READY_TOKEN_REQUIRED'], [['--estimated-guard', '--token-file', fifo], 'READY_TOKEN_REQUIRED'], [['--reset'], 'LIVE_ARGUMENTS_INVALID']] as const) {
      const child = spawnSync(process.execPath, ['packages/agent-pi/qualification/live.mjs', ...args], { encoding: 'utf8', timeout: 10000, maxBuffer: 8192, env: { PATH: '/usr/local/bin:/usr/bin:/bin', HOME: directory, LANG: 'C.UTF-8', ANTHROPIC_API_KEY: 'SYNTHETIC_AMBIENT_SECRET', GITHUB_TOKEN: 'SYNTHETIC_AMBIENT_SECRET' } });
      assert.equal(child.status, 2); const row = JSON.parse(child.stdout); assert.equal(row.status, 'blocked'); assert.equal(row.code, code); assert.equal(row.physicalTransportInvocations, 0); assert.equal(row.potentialAttemptsSpent, 0); assert.equal(row.cumulativeAttempts, 'unknown'); assert.ok(!child.stdout.includes('SYNTHETIC_AMBIENT_SECRET')); assert.equal(child.stderr, '');
    }
  } finally { await rm(directory, { recursive: true, force: true }); }
});
test('live allowance retains all eight conservative spends across fresh processes and refuses a ninth', async () => {
  const directory = await mkdtemp(join(await realpath(tmpdir()), 'loopwright-live-counter-')), module = pathToFileURL(resolve('packages/agent-pi/qualification/live-budget.mjs')).href;
  const script = `const {LiveAllowance}=await import(process.argv[1]);const value=new LiveAllowance(process.argv[2],{fixture:'fixed'});await value.start();let code=null;try{await value.take();}catch(error){code=error.code;}console.log(JSON.stringify({used:value.used,code}));await value.close();`;
  try {
    for (let index = 1; index <= 9; index++) { const child = spawnSync(process.execPath, ['--input-type=module', '--eval', script, module, directory], { encoding: 'utf8', timeout: 10000, maxBuffer: 4096 }); assert.equal(child.status, 0, JSON.stringify({ stderr: child.stderr })); const row = JSON.parse(child.stdout); assert.equal(row.used, Math.min(index, 8)); assert.equal(row.code, index === 9 ? 'LIVE_ALLOWANCE_EXHAUSTED' : null); }
    const bytes = await readFile(join(directory, 'allowance.ndjson')); assert.equal(bytes.toString().trimEnd().split('\n').length, 9); assert.ok(bytes.length < 8192);
    const changed = spawnSync(process.execPath, ['--input-type=module', '--eval', script.replace("fixture:'fixed'", "fixture:'changed'"), module, directory], { encoding: 'utf8', timeout: 10000, maxBuffer: 4096 }); assert.notEqual(changed.status, 0); assert.deepEqual(await readFile(join(directory, 'allowance.ndjson')), bytes);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('only an explicit owned ready-token file passes local readiness without exposing its bytes', async () => {
  const directory = await mkdtemp(join(await realpath(tmpdir()), 'loopwright-ready-token-')), path = join(directory, 'ready'), module = pathToFileURL(resolve('packages/agent-pi/qualification/live-budget.mjs')).href;
  const script = `const {readyToken}=await import(process.argv[1]);try{const value=await readyToken(process.argv[2]);console.log(JSON.stringify({ready:true,length:value.length}));}catch(error){console.log(JSON.stringify({ready:false,code:error.code}));}`;
  try {
    const marker = 'SYNTHETIC_READY_TOKEN_ONLY'; await writeFile(path, marker, { mode: 0o600 });
    const invoke = () => { const child = spawnSync(process.execPath, ['--input-type=module', '--eval', script, module, path], { encoding: 'utf8', timeout: 10000, maxBuffer: 4096 }); assert.equal(child.status, 0); assert.ok(!child.stdout.includes(marker)); return JSON.parse(child.stdout); };
    assert.deepEqual(invoke(), { ready: true, length: marker.length }); await chmod(path, 0o644); assert.deepEqual(invoke(), { ready: false, code: 'READY_TOKEN_REQUIRED' });
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('live probe templates validate both fixed models without aliases or changing the shared parent', () => {
  const module = pathToFileURL(resolve('packages/agent-pi/qualification/live-input.mjs')).href, preflight = pathToFileURL(resolve('packages/agent-pi/dist/preflight.js')).href;
  const script = `const {liveInput}=await import(process.argv[1]);const {prepareInput}=await import(process.argv[2]);const inputs=['claude-sonnet-5.5','claude-opus-5.5'].map(model=>prepareInput(liveInput(model)));console.log(JSON.stringify({sameLock:JSON.stringify(inputs[0].lock)===JSON.stringify(inputs[1].lock),selection:inputs.map(input=>input.policy.selection),budget:inputs[0].lock.spec.contract.spec.budgets,roles:inputs.map(input=>input.roleId)}));`;
  const child = spawnSync(process.execPath, ['--input-type=module', '--eval', script, module, preflight], { encoding: 'utf8', timeout: 10000, maxBuffer: 8192 }); assert.equal(child.status, 0, child.stderr); const row = JSON.parse(child.stdout); assert.equal(row.sameLock, true); assert.deepEqual(row.roles, ['builder', 'opus']); assert.equal(row.budget.maxModelCalls, 8); assert.equal(row.budget.perCallOutputTokens, 1024); assert.deepEqual(row.selection.map((value: { thinking: string }) => value.thinking), ['xhigh', 'high']);
});
