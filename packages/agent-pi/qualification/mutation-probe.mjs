/* global process, console, URL */
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
const dir = await mkdtemp(join(tmpdir(), 'lw-s03-mutation-'));
const context = await readFile(new URL('../dist/context.js', import.meta.url), 'utf8');
const response = await readFile(new URL('../dist/response.js', import.meta.url), 'utf8');
const setup = `import assert from 'node:assert/strict'; import {assessFinalRequestContext as assess,checkRequestBytes} from './context.js'; import {TurnFailureLatch} from './response.js'; const selection={modelId:'m',effort:'xhigh',tools:[],contextWindow:1000000,perCallOutputTokens:1024};const body={model:'m',messages:[{role:'user',content:''}],max_tokens:1024,thinking:{type:'adaptive'},output_config:{effort:'xhigh'},stream:true};const bytes=n=>{const size=Buffer.byteLength(JSON.stringify(body));return Buffer.from(JSON.stringify({...body,messages:[{role:'user',content:'x'.repeat(n-size)}]}));};`;
const cases = [
  ['default-mode', context.replace("policy.mode !== 'estimated_guard'", 'false'), response, `assert.equal(assess(bytes(300),{},selection).ok,false);`],
  ['final-byte-cap', context.replace('bytes.byteLength <= 65536', 'true'), response, `assert.equal(checkRequestBytes(bytes(65537)),false);`],
  ['inclusive-inequality', context.replace('integer(total + reserve, 1) <= window', 'integer(total + reserve, 1) < window'), response, `assert.equal(assess(bytes(48128),{mode:'estimated_guard'},selection).ok,true);`],
  ['failure-latch', context, response.replace('this.#failed = true;', 'this.#failed = false;'), `const latch=new TurnFailureLatch();latch.observe({ok:false,code:'MODEL_FAILED'});latch.observe({ok:true,toolCalls:[{id:'call',name:'read'}]});assert.equal(latch.canAdmitTool('call'),false);`],
];
const results = [];
try {
  await writeFile(join(dir, 'package.json'), '{"type":"module"}');
  for (const [name, changedContext, changedResponse, test] of cases) {
    await writeFile(join(dir, 'context.js'), context); await writeFile(join(dir, 'response.js'), response); await writeFile(join(dir, 'check.mjs'), setup + test);
    execFileSync(process.execPath, [join(dir, 'check.mjs')], { timeout: 5000, stdio: 'pipe' });
    assert.ok(changedContext !== context || changedResponse !== response, name);
    await writeFile(join(dir, 'context.js'), changedContext); await writeFile(join(dir, 'response.js'), changedResponse);
    let failed = false; try { execFileSync(process.execPath, [join(dir, 'check.mjs')], { timeout: 5000, stdio: 'pipe' }); } catch (error) { assert.equal(error.status, 1); assert.ok(error.stderr.toString().includes('AssertionError')); failed = true; }
    assert.ok(failed, name); results.push({ name, baselinePassed: true, productionMutationDetectedBehaviorally: true });
  }
  console.log(JSON.stringify({ status: 'passed', results }, null, 2));
} finally { await rm(dir, { recursive: true, force: true }); }
