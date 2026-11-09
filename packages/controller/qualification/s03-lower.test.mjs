/* global process, Buffer, Response, AbortSignal */
import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {PassThrough} from 'node:stream';
import {readFileSync,writeFileSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {promisify} from 'node:util';
import {createLocalRun} from '@loopwright/state';
import {sessionInput} from '../../../.test-build/packages/agent-pi/test/session-fixtures.js';
import {copiedS03Fixture} from './s03-copied-fixture.mjs';
import {installS03Io} from './s03-io.mjs';
import {publicStateObserver,physicalObservation} from './s03-observer.mjs';
import {canonical,exclusive} from './native-context.mjs';
const good=r=>{assert.equal(r.ok,true,JSON.stringify(r));return r.value;};
function child(){const c=new EventEmitter();Object.assign(c,{pid:process.pid,stdout:new PassThrough(),stderr:new PassThrough(),stdin:new PassThrough()});return c;}
function mocks(f,failed=false){
  let lower=0,id='a'.repeat(64),created=null;const launched=[];
  const outcome=(file,args,options)=>{launched.push({file,args,options});lower++;if(args.includes('create')){const name=args[args.indexOf('--name')+1];created={Id:id,Name:'/'+name,Image:f.plan.image,Config:{Labels:{'org.loopwright.owner':'task_33be673484e7','org.loopwright.nonce':'a'.repeat(12)}}};return {pid:process.pid,status:0,signal:null,stdout:id+'\n',stderr:''};}return {pid:process.pid,status:0,signal:null,stdout:'{}',stderr:''};};
  const original={spawnSync:outcome,spawn(file,args,options){outcome(file,args,options);return child();},fork(file,args,options){outcome(file,args,options);return child();},execFile(file,args,options,callback){const result=outcome(file,args,options);if(failed){result.status=1;result.stdout='ORIGINAL_STDOUT';result.stderr='ORIGINAL_STDERR';}const c=child();queueMicrotask(()=>{c.stdout.emit('data',Buffer.from(result.stdout));c.stderr.emit('data',Buffer.from(result.stderr));c.emit('close',result.status,null);callback(failed?Object.assign(new Error('original mock failure'),{code:1}):null,result.stdout,result.stderr);});return c;},fetch(){lower++;return Promise.resolve(new Response('OK'));}};
  const cp={},globals={},io=installS03Io({...f,copied:true,targets:{childProcess:cp,globals,original,containerObserve:()=>({exit:0,signal:null,stdout:JSON.stringify([created]),stderr:''})}});
  return {cp,globals,io,launched,count:()=>lower};
}
/* global queueMicrotask */
test('all five launch variants retain SAME quota and minimal-env Node descendants; bad source/argv/shell deny before lower',async()=>{
  const f=copiedS03Fixture('mcp'),{cp,count,launched}=mocks(f),entry=f.plan.entries[0];
  for(const method of ['spawn','fork']){const c=cp[method](method==='fork'?entry:process.execPath,method==='fork'?[]:[entry],{env:{PATH:'/usr/bin:/bin'}});c.emit('close',0,null);await c.s03Closed;}
  assert.equal(cp.execFileSync(process.execPath,[entry],{env:{PATH:'/usr/bin:/bin'},encoding:'utf8'}),'{}');
  cp.spawnSync(process.execPath,[entry],{env:{}});
  const promised=cp.execFile[promisify.custom](process.execPath,[entry],{env:{}});assert.equal(promised.child.pid,process.pid);await promised;
  assert.equal(count(),5);for(const row of launched){assert.ok(row.options.env.NODE_OPTIONS.includes('s03-count-preload.mjs'));const context=JSON.parse(Buffer.from(row.options.env.S04_S03_SCOPE,'base64url'));assert.equal(context.path,f.path);assert.deepEqual(context.base,f.base);assert.ok(context.key.startsWith('launch:'));}let before=count();
  for(const method of ['spawn','spawnSync','execFile','execFileSync'])assert.throws(()=>cp[method](process.execPath,['-e','process.exit(0)'],{}),/S03/);
  assert.throws(()=>cp.fork(entry,[],{shell:true}),/S03/);assert.equal(count(),before);
  writeFileSync(f.source.path,'changed');assert.throws(()=>cp.execFileSync(process.execPath,[entry],{}),/S03/);assert.equal(count(),before);
});
test('all Docker create variants debit before lower; exhausted original capacity cannot invoke lower',async()=>{
  const f=copiedS03Fixture('session'),{cp,count}=mocks(f);
  // Source-bound legacy identity in a copied lower control; never reaches Docker.
  const create=n=>['--config',f.directory+'/docker-client','--host','unix://'+f.plan.socket,'create','--pull=never','--name','lw-s03-test-'+n,'--label','org.loopwright.owner=task_33be673484e7','--label','org.loopwright.nonce='+'a'.repeat(12),'--network','none','--read-only',f.plan.image,'/fixed'];
  cp.execFileSync('docker',create(1),{});cp.spawnSync('docker',create(2),{});
  await cp.execFile[promisify.custom]('docker',create(3),{});
  const before=count();assert.equal(before,3);assert.throws(()=>cp.spawn('docker',create(4),{}),/S03/);assert.equal(count(),before);
  for(const args of [create(5).map(x=>x==='unix://'+f.plan.socket?'unix:///wrong':x),create(5).map(x=>x===f.plan.image?'sha256:'+'b'.repeat(64):x)])assert.throws(()=>cp.execFileSync('docker',args,{}),/S03/);
  assert.equal(count(),before);
});
test('physical precharge is consumed across permit reuse BEFORE fake lower, not inferred from receiver success',()=>{
  const f=copiedS03Fixture('admission-mutations');f.debit(f.input('provider','precharge',{},8));let lower=0;
  for(let i=0;i<8;i++){physicalObservation(i=>f.debit({...f.base,...i}),'provider','http://127.0.0.1:1/',Buffer.from('fixture'));lower++;}
  assert.throws(()=>{physicalObservation(i=>f.debit({...f.base,...i}),'provider','http://127.0.0.1:1/',Buffer.from('fixture'));lower++;},/S03/);assert.equal(lower,8);
});
test('original Admission guard mutants retain six genuine S02 admissions and exact physical [0,1,1,1,0,2] with precharge',async()=>{
  const f=copiedS03Fixture('admission-mutations');f.plan.precharge.provider=8;f.debit(f.input('provider','precharge',{},8));
  const source=readFileSync(resolve('packages/agent-pi/dist/admission.js'),'utf8'),counts=[],observations=[];
  for(const mutation of ['baseline','current-owner','one-use']){
    const changed=mutation==='current-owner'?source.replace('this.#assertCurrent(value);',''):mutation==='one-use'?source.replace(' || this.#used.has(ticket)',''):source;
    if(mutation!=='baseline')assert.notEqual(changed,source);
    const file=join(f.directory,mutation+'.mjs');exclusive(file,Buffer.from(changed.replaceAll(/from '(\.\/[^']+)'/g,(_,relative)=>'from '+JSON.stringify(pathToFileURL(resolve('packages/agent-pi/dist',relative)).href))));
    const {Admission}=await import(pathToFileURL(file));
    for(const behavior of ['owner-change','concurrent-duplicate']){
      const input=sessionInput(),identity={directory:join(f.directory,mutation+'-'+behavior),storeId:'store-1',lock:input.lock,policy:{version:1,leaseMs:60000,cost:'observe_only'},binding:{coreApiVersion:'loopwright.dev/v1alpha1',hostVersion:'fixture',adapters:[{id:'pi',version:'0.0.0'}],resourceVersion:input.policy.resourceVersion,clockEpoch:'fixture-boot'}};
      const observer=publicStateObserver({plan:f.plan,entry:resolve('packages/agent-pi/qualification/admission-mutations.mjs'),debit:i=>f.debit({...f.base,...i}),check:()=>{},observe:r=>observations.push(r)});
      const store=good(observer.wrap(createLocalRun(identity),identity)),view=good(store.inspect()),authority=good(store.claim({ownerId:'owner-1',expectedGeneration:view.owner.generation,expectedRevision:view.revision,mode:'active'})).authority;
      const body=Buffer.from('controlled request body'),destination='http://127.0.0.1:1/',request={requestId:'request-1',roleId:'builder',nodeId:'build',attemptId:'attempt-1',purpose:'task',repair:'none',transportRetryOf:null,requestDigest:{algorithm:'sha256',hex:'a'.repeat(64)},inputUpperBound:100,outputUpperBound:20,totalUpperBound:120,capability:{adapterId:'pi',adapterVersion:'0.0.0',provider:'github-copilot',model:'claude-sonnet-5.5',kind:'soft_only',coversAllBillableTokens:false,enforcesOutputBound:true},operationId:'operation-1',targetIdentity:destination};
      const {createHash}=await import('node:crypto');request.requestDigest.hex=createHash('sha256').update(body).digest('hex');
      let physical=0;const admission=new Admission({store,authority},{destination,fetch:async()=>{physicalObservation(i=>f.debit({...f.base,...i}),'provider',destination,body);physical++;return new Response('OK');}}),ticket=admission.issue(request,{destination,body,headers:{authorization:'Bearer SYNTHETIC_HOST_SECRET'},signal:AbortSignal.timeout(10000)});
      if(behavior==='owner-change'){good(store.release(authority));const v=good(store.inspect());good(store.claim({ownerId:'replacement',expectedGeneration:v.owner.generation,expectedRevision:v.revision,mode:'active'}));try{await admission.dispatch(ticket);}catch{/* Original guard refusal, not quota denial. */}}
      else await Promise.allSettled([admission.dispatch(ticket),admission.dispatch(ticket)]);
      counts.push(physical);good(store.close());
    }
  }
  assert.deepEqual(counts,[0,1,1,1,0,2]);assert.equal(observations.length,6);
  const book=JSON.parse(readFileSync(f.path)),scope=book.qualificationReservations.entries.at(-1).s03;assert.equal(scope.events.filter(e=>e.kind==='dispatch').length,6);assert.equal(scope.events.filter(e=>e.kind==='physical').length,5);
  assert.equal(scope.events.filter(e=>e.kind==='provider').reduce((n,e)=>n+e.units,0),8);assert.equal(canonical(book).includes('actualSeal'),false);
});

test('original callback and promisify custom retain child, exit, stdout and stderr on failure',async()=>{
  const f=copiedS03Fixture(),{cp}=mocks(f,true),entry=f.plan.entries[0];
  const promised=cp.execFile[promisify.custom](process.execPath,[entry],{encoding:'utf8'});assert.equal(promised.child.pid,process.pid);await assert.rejects(promised,error=>error.code===1&&error.stdout==='ORIGINAL_STDOUT'&&error.stderr==='ORIGINAL_STDERR');
  await new Promise((resolve,reject)=>{const child=cp.execFile(process.execPath,[entry],{encoding:'utf8'},(error,stdout,stderr)=>{try{assert.equal(child.pid,process.pid);assert.equal(error.code,1);assert.equal(stdout,'ORIGINAL_STDOUT');assert.equal(stderr,'ORIGINAL_STDERR');resolve();}catch(e){reject(e);}});});
});

test('the original selectedDaemon guard-docker-client info route preserves original promisify results',async()=>{
  const f=copiedS03Fixture(),{cp,io,count}=mocks(f),args=['--config',f.directory+'/guard-docker-client','--host','unix://'+f.plan.socket,'info','--format','{{.ID}}'];
  const output=await cp.execFile[promisify.custom]('docker',args,{encoding:'utf8'});assert.equal(output.stdout,'{}');assert.equal(output.stderr,'');assert.equal(count(),1);assert.equal(io.scope().entry.s03.events.filter(e=>e.kind==='containers').length,0);
});

test('original shared cleanup uses the held private Docker config and exact owned IDs across launch variants',async()=>{
  const f=copiedS03Fixture('physical-sends'),{cp,count,launched}=mocks(f),id='a'.repeat(64);
  const prefix=['--config',f.directory+'/docker-client','--host','unix://'+f.plan.socket];
  cp.execFileSync('docker',[...prefix,'create','--pull=never','--name','lw-s03-cleanup','--label','org.loopwright.owner=task_33be673484e7','--label','org.loopwright.nonce='+'a'.repeat(12),'--network','none','--read-only',f.plan.image,'/fixed'],{});
  // This original shared path contains historical buildx metadata. Never read or load that config.
  const shared=[...prefix];shared[1]=join(f.plan.project,'.claude/s03-t0/docker-client');
  const original=[...shared,'inspect',id];
  cp.spawnSync('docker',original,{});cp.execFileSync('docker',original,{});
  const spawned=cp.spawn('docker',original,{});spawned.emit('close',0,null);await spawned.s03Closed;
  await cp.execFile[promisify.custom]('docker',original,{});
  assert.equal(original[1],shared[1]);assert.ok(launched.slice(1).every(row=>row.args[1]===f.plan.client));
  const before=count();
  for(const args of [[...shared,'inspect','b'.repeat(64)],[...shared,'info','--format','{{.ID}}'],[...shared,'create',f.plan.image],['--config',shared[1]+'-other',...shared.slice(2),'inspect',id]])assert.throws(()=>cp.spawnSync('docker',args,{}),/S03/);
  assert.equal(count(),before);
});

test('the shared build client normalizes only frozen source create/start/top forms and parses the exact top selector',()=>{
  const f=copiedS03Fixture('session'),{cp,count,launched}=mocks(f),id='a'.repeat(64),tag='a'.repeat(12);
  const shared=['--config',join(f.plan.project,'.claude/s03-t0/docker-client'),'--host','unix://'+f.plan.socket];
  const create=[...shared,'create','--pull=never','--name','lw-s03-watchdog-'+tag,'--label','org.loopwright.owner=task_33be673484e7','--label','org.loopwright.nonce='+tag,'--network','none','--read-only',f.plan.image,'/fixed'];
  cp.execFileSync('docker',create,{});
  assert.equal(launched.at(-1).args[1],f.plan.client);
  cp.spawnSync('docker',[...shared,'start',id],{});
  assert.equal(launched.at(-1).args[1],f.plan.client);
  cp.execFileSync('docker',[...shared,'top',id,'-eo','pid,ppid,args'],{});
  assert.equal(launched.at(-1).args[1],f.plan.client);
  const before=count();
  for(const args of [
    [...shared,'build','.'],
    [...shared,'top',id,'-o','pid,args'],
    [...shared,'top',id],
    [...shared,'top','c'.repeat(64),'-eo','pid,ppid,args'],
    [...shared,'create','--pull=never','--name','lw-s03-watchdog-'+tag,'--label','org.loopwright.owner=task_33be673484e7','--label','org.loopwright.nonce='+tag,'--network','none','--read-only','sha256:'+'c'.repeat(64)],
  ]) assert.throws(()=>cp.spawnSync('docker',args,{}),/S03/);
  assert.equal(count(),before);
});
