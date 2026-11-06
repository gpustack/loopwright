/** Historical T1 factory-mutation diagnostic; final coverage uses registered current-source checks instead. */
/* global process, console */
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, readdir, cp, symlink, rm, mkdir } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { execFileSync } from 'node:child_process';
const root = process.cwd(); await mkdir('.claude', { recursive: true }); const directory = await mkdtemp(resolve('.claude/session-mutation-'));
const original = await readFile('packages/agent-pi/dist/preflight.js', 'utf8');
const cases = [
  ['role-model-binding', /if \(policy\.selection\.provider !== role\.provider \|\| policy\.selection\.model !== role\.model \|\| policy\.selection\.thinking !== role\.thinking\)/, 'if (false)',
    `assert.throws(()=>prepareInput({...source,policy:{...source.policy,selection:{...source.policy.selection,model:'claude-opus-5.5',thinking:'high'}}}),error=>error instanceof PiFailure && error.detail.code==='BINDING_MISMATCH');`],
  ['artifact-ownership', /copy = new Uint8Array\(view\.byteLength\)/, 'copy = view',
    `const owned=prepareInput(source);source.candidate.artifacts[0].bytes[0]=0;assert.notEqual(owned.candidate.artifacts[0].bytes[0],0);`],
];
const results = [];
try {
  for (const name of await readdir('packages/agent-pi/dist')) if (name.endsWith('.js')) await cp('packages/agent-pi/dist/' + name, join(directory, name));
  await writeFile(join(directory, 'package.json'), '{"type":"module"}'); await symlink(resolve('node_modules'), join(directory, 'node_modules'), 'dir');
  for (const [name, pattern, replacement, test] of cases) {
    assert.ok(pattern.test(original), name); const changed = original.replace(pattern, replacement); assert.notEqual(changed, original);
    await writeFile(join(directory, 'preflight.js'), original);
    await writeFile(join(directory, 'check.mjs'), `import assert from 'node:assert/strict';import {prepareInput} from './preflight.js';import {PiFailure} from './errors.js';import {sessionInput} from ${JSON.stringify(root + '/.test-build/packages/agent-pi/test/session-fixtures.js')};const source=sessionInput();` + test);
    execFileSync(process.execPath, [join(directory, 'check.mjs')], { timeout: 5000, stdio: 'pipe' });
    await writeFile(join(directory, 'preflight.js'), changed); let detected = false;
    try { execFileSync(process.execPath, [join(directory, 'check.mjs')], { timeout: 5000, stdio: 'pipe' }); }
    catch (error) { assert.equal(error.status, 1); assert.ok(error.stderr.toString().includes('AssertionError')); detected = true; }
    assert.equal(detected, true); results.push({ name, baselinePassed: true, behavioralMutationDetected: true });
  }
  console.log(JSON.stringify({ status: 'passed', results }, null, 2));
} finally { await rm(directory, { recursive: true, force: true }); }
