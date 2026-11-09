/* global process, Buffer */
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { retireCopiedOrphan } from './native-incident.mjs';
import { canonical, exclusive, sha } from './native-context.mjs';
import { allowance, validateUsage } from './schedule.mjs';
function fixture(pid){
  pid ??= spawnSync('/usr/bin/true', [], {timeout:1000}).pid;
  const root=mkdtempSync(join(tmpdir(),'lw-incident-')),path=join(root,'budget.json'),nonce='a'.repeat(32),startedMonotonicMs='100';
  const book={version:1,providerSends:0,mcpAttempts:0,containers:[],native:{version:1,seconds:{t0:0,initial:0,finalPi:0,finalController:0},leafSeconds:{},cleanupSeconds:0}};
  const bookRef=exclusive(path,book),lockRef=exclusive(path+'.lock',{version:1,kind:'preflight-bootstrap',pid,nonce,startedMonotonicMs}),attemptRef=exclusive(path+'.preflight-attempt.json',{version:1,id:nonce,pid,startedMonotonicMs});
  return{path,book,options:{path,bookSha:bookRef.sha256,lockSha:lockRef.sha256,attemptSha:attemptRef.sha256,pid,nonce,startedMonotonicMs,absentPids:[pid],commandId:'copied-test',directory:join(root,'disposition'),approval:{synthetic:true},observation:{synthetic:true}}};
}
test('incident: copied exact dead orphan preserves originals, debits allocation separately and archives fences once',()=>{
  const f=fixture(),before=readFileSync(f.path),result=retireCopiedOrphan(f.options),book=JSON.parse(readFileSync(f.path));
  assert.equal(result.allocationSeconds,61);assert.deepEqual(readFileSync(join(f.options.directory,'book-original.bin')),before);assert.equal(existsSync(f.path+'.lock'),false);assert.equal(existsSync(f.path+'.preflight-attempt.json'),false);assert.equal(existsSync(f.path+'.incident-pending.json'),false);
  assert.equal(book.native.qualificationAllocations.reduce((sum,row)=>sum+row.allocationSeconds,0),61);assert.equal(book.native.seconds.initial,result.measuredSeconds);assert.ok(book.native.seconds.initial<1);assert.doesNotThrow(()=>validateUsage(book.native));assert.equal(allowance(book.native,'initial','cycle',120),120);
  assert.throws(()=>retireCopiedOrphan(f.options),/ALREADY_ATTEMPTED/);assert.equal(sha(readFileSync(f.path)),result.budgetSha256);
});
test('incident: changed identity and live owner each refuse before mutation',()=>{
  const f=fixture();writeFileSync(f.path,Buffer.from(canonical({...f.book,providerSends:1})+'\n'));const before=readFileSync(f.path);assert.throws(()=>retireCopiedOrphan(f.options),/IDENTITY_CHANGED/);assert.deepEqual(readFileSync(f.path),before);assert.equal(existsSync(f.path+'.incident-001.lock'),false);
  const live=fixture(process.pid);assert.throws(()=>retireCopiedOrphan(live.options),/OWNER_LIVE_OR_UNKNOWN/);assert.equal(existsSync(live.path+'.incident-001.lock'),false);
});
test('incident: partial commit retains incident exclusion and rejects blind retry',()=>{
  const f=fixture();assert.throws(()=>retireCopiedOrphan(f.options,stage=>{if(stage==='after_commit')throw new Error('injected lost ack');}),/lost ack/);
  assert.equal(existsSync(f.path+'.incident-pending.json'),true);assert.equal(existsSync(f.path+'.lock'),true);assert.equal(existsSync(join(f.options.directory,'disposition.json')),true);assert.throws(()=>retireCopiedOrphan(f.options),/ALREADY_ATTEMPTED/);
});
test('incident: allocation changes remaining phase/work balances without inventing measured elapsed',()=>{
  const f=fixture(),native=f.book.native;native.seconds.initial=1430;native.leafSeconds['initial:repair']=1430;
  assert.equal(allowance(native,'initial','cycle',120),70);
  native.qualificationAllocations=[{id:'failed-n1',phase:'initial',allocationSeconds:60,kind:'local_qualification_allocation',reason:'tail_unknown',receipt:{path:'/synthetic',byteLength:1,sha256:'a'.repeat(64)}}];
  assert.equal(allowance(native,'initial','cycle',120),10);assert.equal(native.seconds.initial,1430);assert.equal(native.leafSeconds['initial:repair'],1430);
});
