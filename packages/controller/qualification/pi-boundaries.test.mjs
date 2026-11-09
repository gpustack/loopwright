/* global setTimeout */
/* global process, Buffer, URL */
import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {readFileSync,writeFileSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {mkdirSync,mkdtempSync,rmSync,symlinkSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {generatedCpuActor} from './pi-fixtures.mjs';
import {keepReplacementAlive} from './pi-crash-lease.mjs';
import {createLocalRun} from '../../state/dist/index.js';
import {s03Groups,s03Caps} from './pi-scope.mjs';
import {publicStateObserver} from './pi-observer.mjs';
import {collectCopiedS03Closure,retainS03Output} from './pi-closure.mjs';
import {charges} from './native-ledger.mjs';
import { sessionInput } from '../../../.test-build/packages/agent-pi/test/session-fixtures.js';
import {copiedS03Fixture} from './pi-copied-fixture.mjs';
import {canonical,sha,exclusive,checkedRef} from './native-context.mjs';
const actual=resolve('.claude/s04-qualification/budget.json'),actualBefore=readFileSync(actual);
test('fixed fifteen group envelope matches R066 and independent raw/admission paths have no host dispatch bypass',()=>{
  const total={containers:0,provider:0,mcp:0};assert.equal(Object.keys(s03Groups).length,15);
  for(const group of Object.keys(s03Groups))for(const key of Object.keys(total))total[key]+=s03Caps(group)[key];assert.deepEqual(total,{containers:180,provider:210,mcp:448});
  for(const group of ['parser-context-failures','runtime-path']){let original=0,lower=0;const store={authorizeRequestDispatch(){original++;return {ok:true,value:{kind:'new_dispatch'}};},authorizeOperationDispatch(){}},observer=publicStateObserver({plan:{project:resolve('.'),group,precharge:{provider:24}},entry:resolve('packages/agent-pi/qualification/'+s03Groups[group][0]),check(){},debit(){lower++;}});observer.wrap({ok:true,value:store},{directory:'/cpu',storeId:'copy',lock:{spec:{runId:'copy',lockHash:{}}}});assert.throws(()=>store.authorizeRequestDispatch({},'id'),/UNEXPECTED_HOST_DISPATCH/);assert.equal(original,0);assert.equal(lower,0);}
});
test('original absolute cutoff, changed owner birth/boot and dead original parent deny BEFORE mocked lower',()=>{
  for(const mode of ['clock','birth','boot']){const f=copiedS03Fixture('session',mode==='clock'?-100:100000);if(mode!=='clock'){const book=JSON.parse(readFileSync(f.path));book.qualificationReservations.entries.at(-1).owner[mode]='changed';writeFileSync(f.path,canonical(book)+'\n',{mode:0o600});}let lower=0;assert.throws(()=>{f.debit(f.input('provider','denied'));lower++;});assert.equal(lower,0);}
  const module=fileURLToPath(new URL('./pi-copied-fixture.mjs',import.meta.url)),lock=fileURLToPath(new URL('./native-lock.mjs',import.meta.url)),output=spawnSync(process.execPath,['--input-type=module','-e',`import {copiedS03Fixture} from ${JSON.stringify(module)};const f=copiedS03Fixture();process.stdout.write(JSON.stringify({path:f.path,input:f.input('provider','after-death')}));`],{timeout:10000,encoding:'utf8'});assert.equal(output.status,0,output.stderr);const dead=JSON.parse(output.stdout),probe=spawnSync(process.execPath,['--input-type=module','-e',`import {debitS03Reservation} from ${JSON.stringify(lock)};const f=JSON.parse(process.argv[1]);debitS03Reservation(f.path,f.input,{copied:true});process.stdout.write('LOWER');`,JSON.stringify(dead)],{timeout:10000,encoding:'utf8'});assert.notEqual(probe.status,0);assert.equal(probe.stdout,'');
});
test('copied environment, wrong owner route and decoded records cannot activate actual native work',()=>{
  const f=copiedS03Fixture(),wire=Buffer.from(canonical({path:f.path,base:f.base,key:'unregistered'})).toString('base64url');
  const preload=resolve('packages/controller/qualification/pi-count-preload.mjs'),child=spawnSync(process.execPath,['--import',preload,'-e','process.stdout.write("LOWER")'],{env:{PATH:process.env.PATH,S04_S03_SCOPE:wire},encoding:'utf8',timeout:10000});assert.notEqual(child.status,0);assert.equal(child.stdout,'');
  for(const args of [['--case','unknown','--owner','controller'],['--case','session','--owner','foreign']]){const r=spawnSync(process.execPath,['packages/controller/qualification/delivery-pi.mjs',...args],{encoding:'utf8',timeout:10000});assert.notEqual(r.status,0);assert.equal(r.stdout,'');}
  assert.deepEqual(readFileSync(actual),actualBefore);
});
function closedCpu(){
  const f=copiedS03Fixture('admission-mutations'),entry=f.plan.entries[0],key='original-copy-node';f.debit(f.input('provider','precharge',{},8));
  f.debit(f.input('node',key,{entry,argv:sha(canonical([entry])),cpuOnly:true,generated:null,child:null,closed:false,result:null},0));
  const original=spawnSync(process.execPath,[entry],{timeout:10000});assert.equal(original.status,0,String(original.stderr));
  f.debit(f.input('node-close',key,{pid:original.pid,exit:original.status,signal:original.signal,stdout:sha(original.stdout),stderr:sha(original.stderr),streams:'closed'},0));
  const result={code:original.status,signal:original.signal,stdout:original.stdout,stderr:original.stderr},output=retainS03Output(f.directory,result),approval=exclusive(join(f.directory,'copy-approval.json'),{scope:'synthetic copied closure only; NOT native authority'});return {...f,result,output,approval};
}
test('fresh actual CPU exit/stream/PID closure can only allocate FULL copied caps; actual/seal stay null and fake closure refuses',()=>{
  const f=closedCpu(),before=charges(f.ledger.read());assert.throws(()=>f.ledger.allocateS03({id:f.base.reservationId},{}),/HANDLE/);
  // The original copied reservation handle is retained privately by its fixture, never reconstructed from its id.
  assert.equal(f.ledger.read().qualificationReservations.entries.at(-1).state,'held');
  const closure=collectCopiedS03Closure(f.path,f.base,{result:{code:f.result.code,signal:f.result.signal},output:f.output,approval:f.approval});
  const allocated=f.ledger.allocateS03(f.handle,closure);assert.equal(allocated.state,'allocated_unknown');const after=f.ledger.read(),row=after.qualificationReservations.entries.at(-1);assert.equal(row.actual,null);assert.equal(row.seal,null);assert.deepEqual(charges(after).upper,before.upper);assert.equal(charges(after).allocated.provider-before.allocated.provider,8);assert.equal(row.s03.events,undefined);assert.ok(row.s03.audit);const time=f.ledger.completeParentTime(f.time,{exit:0,signal:null,error:null});assert.equal(JSON.parse(checkedRef(time.receipt)).fullReservationRetained,true);
});
test('missing original stream or lost original node ACK retains full copied hold and cannot allocate',()=>{
  const f=closedCpu(),output=JSON.parse(readFileSync(f.output.path));output.stdout.sha256='b'.repeat(64);const changed=exclusive(join(f.directory,'bad-output.json'),output);assert.throws(()=>collectCopiedS03Closure(f.path,f.base,{result:{code:0,signal:null},output:changed,approval:f.approval}),/CLOSURE/);assert.equal(f.ledger.read().qualificationReservations.entries.at(-1).state,'held');
  assert.throws(()=>f.ledger.allocateS03(f.handle,{}),/CLOSURE/);assert.deepEqual(readFileSync(actual),actualBefore);
});

test('the crash fixture guard keeps the replacement authority renewed while owner-1 expiry stays by design',async()=>{
  const input=sessionInput();
  const identity=lease=>({directory:join(mkdtempSync(resolve('.claude/s04-development')+'/s03-crash-lease-'),'state'),storeId:'store-1',lock:input.lock,policy:{version:1,leaseMs:lease,cost:'observe_only'},binding:{coreApiVersion:'loopwright.dev/v1alpha1',hostVersion:'fixture',adapters:[{id:'pi',version:'0.0.0'}],resourceVersion:input.policy.resourceVersion,clockEpoch:'fixture-boot'}});
  const claimFirst=(store,owner)=>{const view=store.inspect().value;return store.claim({ownerId:owner,expectedGeneration:view.owner.generation,expectedRevision:view.revision,mode:'active'});};
  const opened=createLocalRun(identity(1000));
  keepReplacementAlive(opened.value);
  // REVIEW-074 R-1: the guard mutates the store in place so the StateResult envelope survives the observer wrap.
  const observer=publicStateObserver({plan:{project:resolve('.'),group:'recovery',precharge:{}},entry:resolve('packages/agent-pi/qualification/recovery-crashes.mjs'),check(){},debit(){}});
  const guarded=observer.wrap(opened,identity(1000));
  assert.equal(guarded.ok,true,'the wrapped StateResult keeps its ok envelope');
  const replacement=claimFirst(guarded.value,'replacement');assert.equal(replacement.ok,true);
  const unguarded=createLocalRun(identity(1000)).value;
  const owner1=claimFirst(unguarded,'owner-1');assert.equal(owner1.ok,true);
  await new Promise(resolve=>setTimeout(resolve,1300));
  assert.equal(guarded.value.renew(replacement.value.authority).ok,true,'the guarded replacement authority stays renewed');
  assert.equal(unguarded.renew(owner1.value.authority).ok,false,'the unguarded owner-1 lease expires on schedule');
  guarded.value.release(replacement.value.authority);
  await new Promise(resolve=>setTimeout(resolve,400));
  assert.equal(guarded.value.renew(replacement.value.authority).ok,false,'release ends the renewal after the granted lease lapses');
});
test('simultaneous s03 debits serialize through the bounded lock retry instead of failing',async()=>{
  const f=copiedS03Fixture('recovery');
  const module=resolve('packages/controller/qualification/native-lock.mjs');
  const childScript=`import {debitS03Reservation} from ${JSON.stringify(module)};const f=JSON.parse(process.argv[1]);debitS03Reservation(f.path,{...f.base,kind:'provider',key:f.key,units:1,identity:{}},{copied:true});`;
  const spawnDebit=key=>spawnSync(process.execPath,['--input-type=module','-e',childScript,JSON.stringify({path:f.path,base:f.base,key})],{timeout:20000,encoding:'utf8',cwd:resolve('.')});
  const first=spawnDebit('race-a'),second=spawnDebit('race-b');
  assert.equal(first.status,0,first.stderr);
  assert.equal(second.status,0,second.stderr);
  const store=JSON.parse(readFileSync(f.path,'utf8'));
  const spent=store.qualificationReservations.entries.at(-1).s03.events.filter(row=>row.kind==='provider').reduce((sum,row)=>sum+row.units,0);
  assert.equal(spent,2,'both serialized child debits landed');
  assert.deepEqual(readFileSync(actual),actualBefore);
});

test('generated mutation actors accept the frozen probe raw tmpdir path and still refuse symlinked identities',()=>{
  const plan={group:'mutations',project:resolve('.')};
  const parent=resolve('packages/agent-pi/qualification/mutation-probe.mjs');
  const generator=readFileSync(parent,'utf8');
  const setup=/const setup = `([^`]+)`;/.exec(generator)[1];
  const context=readFileSync(resolve('packages/agent-pi/dist/context.js'),'utf8');
  const response=readFileSync(resolve('packages/agent-pi/dist/response.js'),'utf8');
  const test='assert.equal(assess(bytes(300),{},selection).ok,false);';
  const raw=join(tmpdir(),'lw-s03-mutation-rawcontrol'+process.pid);
  try{
    mkdirSync(raw,{mode:0o700});
    writeFileSync(join(raw,'check.mjs'),setup+test);writeFileSync(join(raw,'package.json'),'{"type":"module"}');
    writeFileSync(join(raw,'context.js'),context);writeFileSync(join(raw,'response.js'),response);
    const entry=join(raw,'check.mjs');
    const generated=generatedCpuActor(plan,parent,entry);
    assert.equal(generated.entry,entry);
    assert.deepEqual(generated.files.map(row=>row.path),[join(raw,'check.mjs'),join(raw,'context.js'),join(raw,'response.js'),join(raw,'package.json')]);
    for(const row of generated.files)assert.equal(sha(readFileSync(row.path)),row.sha256);
    const real=mkdtempSync(resolve('.claude/s04-development')+'/s03-mutation-symlink-');
    try{
      writeFileSync(join(real,'check.mjs'),setup+test);
      const link=join(raw,'linked-check.mjs');
      symlinkSync(join(real,'check.mjs'),link);
      assert.throws(()=>generatedCpuActor(plan,parent,link),/S03_FIXTURE/);
    }finally{rmSync(real,{recursive:true,force:true});}
  }finally{rmSync(raw,{recursive:true,force:true});}
});

test('an unclosed synchronous launch closes via its proven-dead actor while alive-actor and node variants refuse',()=>{
  const entryPath=resolve('packages/controller/qualification/pi-copied-fixture.mjs'),syncIdentity=()=>({entry:entryPath,argv:sha(canonical([entryPath])),cpuOnly:false,generated:null,child:null,closed:false,result:null});
  // Positive: a fixture descendant registers an unclosed synchronous cleanup launch, then dies before closure collects.
  const f=closedCpu();
  const child=spawnSync(process.execPath,['--input-type=module','-e',`import {debitS03Reservation} from ${JSON.stringify(fileURLToPath(new URL('./native-lock.mjs',import.meta.url)))};const f=JSON.parse(process.argv[1]);debitS03Reservation(f.path,{...f.base,kind:'cleanup-process',key:f.key,units:0,identity:f.identity},{copied:true});`,JSON.stringify({path:f.path,base:f.base,key:'sync-launch-cut',identity:syncIdentity()})],{timeout:10000,encoding:'utf8'});
  assert.equal(child.status,0,child.stderr);
  const closure=collectCopiedS03Closure(f.path,f.base,{result:{code:f.result.code,signal:f.result.signal},output:f.output,approval:f.approval});
  const allocated=f.ledger.allocateS03(f.handle,closure);assert.equal(allocated.state,'allocated_unknown');
  const row=f.ledger.read().qualificationReservations.entries.at(-1);assert.equal(row.actual,null);assert.equal(row.seal,null);assert.equal(row.s03.occupants,undefined);assert.ok(row.s03.audit);
  // Negative: the same unclosed synchronous record whose calling actor is still alive refuses.
  const alive=closedCpu();alive.debit(alive.input('cleanup-process','sync-launch-alive',syncIdentity(),0));
  assert.throws(()=>collectCopiedS03Closure(alive.path,alive.base,{result:{code:alive.result.code,signal:alive.result.signal},output:alive.output,approval:alive.approval}),/CLOSURE/);
  // Negative: an unclosed node launch has no provable pid and still refuses.
  const node=closedCpu();node.debit(node.input('node','sync-launch-node',syncIdentity(),0));
  assert.throws(()=>collectCopiedS03Closure(node.path,node.base,{result:{code:node.result.code,signal:node.result.signal},output:node.output,approval:node.approval}),/CLOSURE/);
  assert.deepEqual(readFileSync(actual),actualBefore);
});

async function permissionFixture(kind='provider',leaseMs=60000){
  const {createLocalRun}=await import('@loopwright/state'),{sessionInput}=await import('../../../.test-build/packages/agent-pi/test/session-fixtures.js'),f=copiedS03Fixture('mcp'),input=sessionInput();
  const identity={directory:join(f.directory,'original-public-state'),storeId:'store-1',lock:input.lock,policy:{version:1,leaseMs,cost:'observe_only'},binding:{coreApiVersion:'loopwright.dev/v1alpha1',hostVersion:'readonly-permission-fixture',adapters:[{id:'pi',version:'0.0.0'}],resourceVersion:input.policy.resourceVersion,clockEpoch:'fixture-boot'}};
  const good=r=>{assert.equal(r.ok,true,JSON.stringify(r));return r.value;},observer=publicStateObserver({plan:f.plan,entry:resolve('packages/agent-pi/qualification/mcp.mjs'),debit:i=>f.debit({...f.base,...i}),check(){}}),opened=createLocalRun(identity);assert.equal(observer.wrap(opened,identity),opened);
  const store=good(opened),view=good(store.inspect()),authority=good(store.claim({ownerId:'owner-1',expectedGeneration:view.owner.generation,expectedRevision:view.revision,mode:'active'})).authority,body=Buffer.from('original physical bytes');
  if(kind==='provider'){
    const request={requestId:'request-1',roleId:'builder',nodeId:'build',attemptId:'attempt-1',purpose:'task',repair:'none',transportRetryOf:null,requestDigest:{algorithm:'sha256',hex:sha(Buffer.concat([Buffer.from('composite-request-envelope\0'),body]))},inputUpperBound:100,outputUpperBound:20,totalUpperBound:120,capability:{adapterId:'pi',adapterVersion:'0.0.0',provider:'github-copilot',model:'claude-sonnet-5.5',kind:'soft_only',coversAllBillableTokens:false,enforcesOutputBound:true},operationId:'operation-1',targetIdentity:'http://127.0.0.1:1/'};
    good(store.reserveRequest(authority,request));good(store.authorizeRequestDispatch(authority,request.requestId));
  }else{
    good(store.putIntent(authority,{operationId:'operation-1',nodeId:'build',attemptId:kind==='mcp'?'mcp-attempt-fixture':'tool-attempt-fixture',effect:'read_only',targetIdentity:'candidate:packages/example.ts',requestDigest:{algorithm:'sha256',hex:sha(body)}}));good(store.authorizeOperationDispatch(authority,'operation-1'));
  }
  return {f,store,authority,observer,good,subject:kind==='provider'?sha(body):kind==='mcp'?'packages/example.ts':'operation-1'};
}
test('late public permission reads preserve genuine provider/MCP/tool permits and reject a replacement owner before lower',async()=>{
  for(const kind of ['provider','mcp','operation']){
    const f=await permissionFixture(kind);f.observer.assertTransport(kind,f.subject);f.good(f.store.release(f.authority));const view=f.good(f.store.inspect());f.good(f.store.claim({ownerId:'replacement',expectedGeneration:view.owner.generation,expectedRevision:view.revision,mode:'active'}));let lower=0;assert.throws(()=>{f.observer.assertTransport(kind,f.subject);lower++;},/ORIGINAL_PERMISSION/);assert.equal(lower,0);f.good(f.store.close());
  }
});
test('blocking after durable quota debit cannot extend the original S02 permit or lease',async()=>{
  const f=await permissionFixture('provider',1000);f.observer.assertTransport('provider',f.subject);Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,1100);let lower=0;assert.throws(()=>{f.observer.assertTransport('provider',f.subject);lower++;},/ORIGINAL_PERMISSION/);assert.equal(lower,0);f.good(f.store.close());assert.deepEqual(readFileSync(actual),actualBefore);
});
