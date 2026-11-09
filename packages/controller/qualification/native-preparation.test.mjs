/* global Buffer, AbortController, process */
import './native-offline.test.mjs';
import assert from 'node:assert/strict';
import test,{before as beforeTests,after} from 'node:test';
import {mkdtempSync,readFileSync,readdirSync,mkdirSync,writeFileSync,renameSync,appendFileSync,openSync,fsyncSync,closeSync,realpathSync} from 'node:fs';
import {resolve,join,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {tmpdir} from 'node:os';
import {promisify} from 'node:util';
import {admitTask} from '@loopwright/core';
import {createLocalRun} from '@loopwright/state';
import {describePiAdapterFiles} from '@loopwright/agent-pi';
import {checkedRef,canonical,sha,nonce,localOwner,monotonic,exclusive,readPrivate,bindContext} from './native-context.mjs';
import {NativeLedger,createOfflineLedger,charges} from './native-ledger.mjs';
import {NativeMeter,processShims} from './native-guards.mjs';
import {ObservationParent,verifyOwnedTerminal,parentObservation,preparedNativeParent} from './native-parent.mjs';
import {ParentLifecycle} from './lifecycle.mjs';
import {mutateLegacyBudget,withBudgetLock} from './native-lock.mjs';
import {StockIntentRegistry,stockCreateArguments} from './native-container.mjs';
import {freezeAdmission,admissionRegistration,executePreparedPublicCycle} from './native-public.mjs';
import {installPreparedBindings} from './native-preload.mjs';
import {fixtureDocuments,prepareNativeRecipe,fixtureResponse,fixtureWriteResponse,startPreparedServices} from './native-cases.mjs';
import {ProcessObservations} from './native-observation.mjs';

const priorStaticToken=process.env.S04_PROVIDER_TOKEN;
beforeTests(()=>{process.env.S04_PROVIDER_TOKEN='S04_OFFLINE_SYNTHETIC_FIXTURE_ONLY';});
after(()=>{if(priorStaticToken===undefined)delete process.env.S04_PROVIDER_TOKEN;else process.env.S04_PROVIDER_TOKEN=priorStaticToken;});
const real=resolve('.claude/s04-qualification/budget.json'),before=readFileSync(real),original=JSON.parse(JSON.parse(before).qualificationReservations?checkedRef(JSON.parse(before).qualificationReservations.origin):before),owner=localOwner();
const root=mkdtempSync(resolve('.claude/s04-qualification/preparation-')),observations=[];
const sources=Object.fromEntries(readdirSync(resolve('packages/controller/qualification')).filter(name=>name.endsWith('.mjs')).sort().map(name=>[name,sha(readFileSync(resolve('packages/controller/qualification',name)))]));
const bodies=Object.fromEntries(Object.keys(sources).map(name=>[name,exclusive(join(root,'source-'+name+'.bin'),readFileSync(resolve('packages/controller/qualification',name)))]));
const appFiles=['package-lock.json',...['core','state','agent-pi','controller'].map(name=>'packages/'+name+'/package.json')];
for(const name of ['core','state','agent-pi','controller']){const visit=path=>{for(const entry of readdirSync(path,{withFileTypes:true}).sort((a,b)=>a.name<b.name?-1:1)){const file=join(path,entry.name);if(entry.isDirectory())visit(file);else if(entry.name.endsWith('.js'))appFiles.push(file);}};visit(dirname(fileURLToPath(import.meta.resolve('@loopwright/'+name))));}
const appBindings=Object.fromEntries(appFiles.map(path=>[resolve(path),sha(readFileSync(path))])),appBodies=Object.fromEntries(appFiles.map((path,index)=>[resolve(path),exclusive(join(root,'app-source-'+index+'.bin'),readFileSync(path))]));
const registry=resolve('.claude/s04-qualification/preparation-fixtures.ndjson');appendFileSync(registry,canonical({version:1,root,owner,originalBudgetSha256:sha(before),scope:'offline-copies-mocks-public-S02-bounded-bootstrap'})+'\n',{mode:0o600});const fd=openSync(registry,'r');try{fsyncSync(fd);}finally{closeSync(fd);}
const capture=(name,value)=>{const ref=exclusive(join(root,name+'.json'),{version:1,scope:'offline-only',value});JSON.parse(readPrivate(ref.path));observations.push({name,ref});return value;};
const attempt=action=>{try{return {ok:true,value:action()};}catch(error){return {ok:false,code:error.message};}};
function fixture(fault){const directory=mkdtempSync(join(root,'ledger-')),path=join(directory,'budget.json'),origin=exclusive(join(directory,'original-native-budget.bin'),original);createOfflineLedger(path,original);exclusive(join(directory,'source-manifest.json'),{version:1,hashes:sources,bodies,appBindings,appBodies});const context={runId:'run-unit',taskId:'task-unit',dispatchId:'dispatch-unit',sourceDigest:sha(canonical(sources)),runtimeDigest:sha(canonical(appBindings)),image:'sha256:'+'a'.repeat(64),leafCutoff:String(monotonic()+15000n)},ledger=new NativeLedger(path,fault);return {directory,path,origin,context,ledger,reserve:()=>ledger.reserve(context,{provider:2,mcp:0,containers:4})};}
after(()=>{const final=readFileSync(real);exclusive(join(root,'preparation-result.json'),{version:1,root,owner,sources,observations,originalBudgetSha256:sha(before),finalBudgetSha256:sha(final),nativeBudgetUnchanged:before.equals(final),nativeActivation:'HELD',scope:'offline-only'});assert.deepEqual(final,before);});

test('preparation: one signed registered child meter, no parent duplication, opaque replay and parent-only settlement',async()=>{
  const f=fixture(),handle=f.reserve(),parent=new ObservationParent(handle,f.directory),duplicateParent=attempt(()=>new NativeMeter(handle)),child=await parent.start({probe:'duplicate'}),again=await parent.start().then(value=>({ok:true,value}),error=>({ok:false,code:error.message}));
  const raw=child.frames.find(row=>row.kind==='bootstrap-observation'),decoded=attempt(()=>new NativeMeter(JSON.parse('{}'))),lifecycle=new ParentLifecycle(handle,f.directory),proof=lifecycle.sealObserved(child.proof),first=f.ledger.settle(handle,proof),second=f.ledger.settle(handle,proof);
  capture('ticket-positive',{f:{directory:f.directory,path:f.path},child,duplicateParent,again,decoded,raw,first,second,value:f.ledger.read()});
  assert.equal(child.exit.code,0);assert.ok(child.proof);assert.equal(duplicateParent.ok,false);assert.equal(again.ok,false);assert.equal(decoded.ok,false);assert.equal(raw.probes.length,3);assert.ok(raw.probes.every(item=>!item.ok));assert.equal(first,'settled');assert.equal(second,'existing');assert.deepEqual(charges(f.ledger.read()).held,{provider:0,mcp:0,containers:0});
});
for(const variant of ['foreign-child','replacement-parent','widened','altered','stale','no-ack','refund'])test('preparation: original bootstrap isolates '+variant+' without reissue or child refund',async()=>{
  const f=fixture();if(variant==='stale')f.context.leafCutoff=String(monotonic()+250n);const handle=f.reserve();
  const parent=new ObservationParent(handle,f.directory),options={probe:variant==='refund'?'refund':'positive'};
  if(variant==='foreign-child')options.transformBody=body=>({...body,child:{...body.child,pid:body.child.pid+1}});
  if(variant==='replacement-parent')options.transformBody=body=>({...body,parent:{...body.parent,birth:'foreign original-parent birth'}});
  if(variant==='widened')options.transformBody=body=>({...body,caps:{...body.caps,provider:body.caps.provider+1}});
  if(variant==='altered')options.transformWire=wire=>({...wire,signature:Buffer.alloc(64,1).toString('base64')});
  if(variant==='stale')options.transformWire=wire=>{const until=BigInt(wire.body.context.leafCutoff);const remaining=until-monotonic();if(remaining>0n)Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,Number(remaining)+1);return wire;};
  if(variant==='no-ack')options.acknowledge=false;
  const child=await parent.start(options),again=await parent.start().then(value=>({ok:true,value}),error=>({ok:false,code:error.message})),forged=attempt(()=>parentObservation(JSON.parse('{}'))),held=charges(f.ledger.read()).held;
  capture('ticket-'+variant,{directory:f.directory,child,again,forged,held});
  assert.equal(again.ok,false);assert.equal(forged.ok,false);assert.deepEqual(held,{provider:2,mcp:0,containers:4});
  if(variant==='refund'){const row=child.frames.find(item=>item.kind==='bootstrap-observation');assert.equal(child.exit.code,0);assert.equal(row.probes[0].code,'QUALIFICATION_RESERVATION_HANDLE');}
  else if(variant==='no-ack'){assert.equal(child.exit.code,72);assert.equal(child.frames.some(item=>item.kind==='bootstrap-observation'),false);}
  else{const row=child.frames.find(item=>item.kind==='bootstrap-refusal');assert.equal(child.exit.code,76);assert.equal(row.code,variant==='widened'?'QUALIFICATION_TICKET_CAPS':variant==='altered'?'QUALIFICATION_TICKET_SIGNATURE':variant==='stale'?'QUALIFICATION_TICKET_EXPIRED':'QUALIFICATION_TICKET_IDENTITY');}
});

test('preparation: copied migration preserves complete original budget and native-time provenance with idempotent transitions',()=>{
  const f=fixture(),migration=f.ledger.migrateCopied(f.origin),receipt=exclusive(join(f.directory,'time-receipt.json'),{version:1,commandId:nonce(),seconds:0.125,exit:0}),row={id:nonce(),phase:'initial',leaf:'cycle',seconds:0.125,receipt},first=f.ledger.recordTime(row),second=f.ledger.recordTime(row),value=f.ledger.read(),legacy=attempt(()=>mutateLegacyBudget(f.path,owner,input=>({...input,providerSends:0})));
  capture('migration-time',{directory:f.directory,origin:f.origin,migration,row,first,second,value,legacy});assert.equal(migration,'migrated');assert.equal(first,'recorded');assert.equal(second,'existing');assert.equal(value.providerSends,21);assert.equal(value.mcpAttempts,59);assert.deepEqual(value.containers,original.containers);assert.deepEqual(value.native.seconds,{...original.native.seconds,initial:original.native.seconds.initial+0.125});assert.equal(value.qualificationReservations.timeTransitions.length,1);assert.equal(legacy.ok,false);
});
for(const operation of ['migration','time'])for(const phase of ['before_commit','after_commit'])test('preparation: copied '+operation+' '+phase+' uncertainty retains originals and lock, with no new grant',()=>{
  const f=fixture();if(operation==='time')f.ledger.migrateCopied(f.origin);
  const ledger=new NativeLedger(f.path,stage=>{if(stage===phase)throw new Error('injected-'+operation+'-'+phase);}),receipt=exclusive(join(f.directory,'original-time-input.json'),{id:nonce(),seconds:0.125}),input={id:nonce(),phase:'initial',leaf:'cycle',seconds:0.125,receipt};
  const returned=attempt(()=>operation==='migration'?ledger.migrateCopied(f.origin):ledger.recordTime(input)),reopen=attempt(()=>new NativeLedger(f.path).read()),grant=attempt(f.reserve),raw=readFileSync(f.path),next=readdirSync(f.directory).filter(name=>name.startsWith('budget.json.next.')).map(name=>({path:join(f.directory,name),bytes:readFileSync(join(f.directory,name)).toString()}));
  capture(operation+'-'+phase,{directory:f.directory,input,returned,reopen,grant,raw:{byteLength:raw.length,sha256:sha(raw),value:JSON.parse(raw)},next,lock:readPrivate(f.path+'.lock').toString()});assert.equal(returned.ok,false);assert.equal(reopen.ok,false);assert.equal(grant.ok,false);assert.equal(JSON.parse(raw).providerSends,21);assert.equal(JSON.parse(raw).mcpAttempts,59);assert.deepEqual(JSON.parse(raw).containers,original.containers);
});
test('preparation: legacy and reservation/time writers share actual exclusive lock in both directions',()=>{
  const f=fixture(),results=[];
  const migration=new NativeLedger(f.path,stage=>{if(stage==='before_commit')results.push({point:'migration-holds',returned:attempt(()=>mutateLegacyBudget(f.path,owner,v=>v))});});migration.migrateCopied(f.origin);
  results.push({point:'migrated-old-writer',returned:attempt(()=>mutateLegacyBudget(f.path,owner,v=>({...v,providerSends:0})))});
  const directory=mkdtempSync(join(root,'legacy-')),path=join(directory,'budget.json');exclusive(path,original);
  const changed=mutateLegacyBudget(path,owner,value=>({...value,providerSends:value.providerSends+1}),stage=>{if(stage==='before_commit')results.push({point:'legacy-holds',returned:attempt(()=>new NativeLedger(path).migrateCopied(f.origin))});});
  const busy=withBudgetLock(path,owner,()=>attempt(()=>mutateLegacyBudget(path,owner,v=>v)));
  capture('shared-writers',{directory:f.directory,legacyDirectory:directory,results,changed,busy});assert.ok(results.every(row=>!row.returned.ok));assert.match(results[0].returned.code,/LOCK_HELD/);assert.match(results[1].returned.code,/ACTIVATION_HELD/);assert.match(results[2].returned.code,/LOCK_HELD/);assert.equal(changed.providerSends,22);assert.equal(busy.ok,false);
});

function stockFixture(){
  const directory=mkdtempSync(join(root,'stock-')),runtimeRoot=join(directory,'runtime'),host=join(runtimeRoot,'attempt.one'),home=join(host,'sdk-session-one'),candidate=join(home,'candidate');for(const path of [runtimeRoot,host,home,join(home,'docker-client'),candidate])mkdirSync(path,{mode:0o700});
  const labels={'org.loopwright.generation':'1','org.loopwright.run':'run-unit','org.loopwright.session':'session-one','org.loopwright.nonce':nonce()},identity={name:'',nonce:labels['org.loopwright.nonce'],labels,image:'sha256:'+'a'.repeat(64)};identity.name='lw-pi-'+identity.nonce;
  exclusive(join(home,'container-intent.json'),Buffer.from(JSON.stringify({version:1,...identity})));const registration={runtimeRoot,socket:'/private/frozen/docker.sock',image:identity.image,runId:'run-unit',owner:{id:'unit-owner',generation:1},roles:[{hostDirectory:host,sessionId:'session-one',candidate}]},registry=new StockIntentRegistry(registration),args=['--config',join(home,'docker-client'),'--host','unix://'+registration.socket,...stockCreateArguments(identity,candidate,'sdk')],options={env:{PATH:'/usr/local/bin:/usr/bin:/bin',HOME:home,LANG:'C.UTF-8'},timeout:10000,maxBuffer:1048576};
  exclusive(join(directory,'original-stock-input.json'),{identity,registration,args,options});
  return {directory,runtimeRoot,host,home,candidate,identity,registration,registry,args,options};
}
test('preparation: exact dynamic stock intent and returned identity, socket/profile/env/source drift refuse without Docker calls',()=>{
  const f=stockFixture(),accepted=f.registry.resolve(f.args,f.options),denials=[];
  for(const index of [3,f.args.indexOf('--memory')+1,f.args.indexOf('--mount')+1,f.args.indexOf(f.identity.image)]){const args=[...f.args];args[index]='altered';denials.push({index,args,returned:attempt(()=>f.registry.resolve(args,f.options))});}
  const changedEnv={env:{...f.options.env,HOME:f.directory}};denials.push({kind:'env',options:changedEnv,returned:attempt(()=>f.registry.resolve(f.args,changedEnv))});
  exclusive(join(f.home,'container-id.json'),{id:'b'.repeat(64),nonce:f.identity.nonce});const start=['--config',join(f.home,'docker-client'),'--host','unix://'+f.registration.socket,'start','--attach','--interactive','b'.repeat(64)],started=f.registry.resolve(start,{env:f.options.env,stdio:['pipe','pipe','pipe']});
  const path=join(f.home,'container-intent.json'),originalIntent=exclusive(join(f.directory,'original-intent.bin'),readFileSync(path));writeFileSync(path,'\n'+readFileSync(path).toString(),{mode:0o600,flush:true});const changedIntent=exclusive(join(f.directory,'actual-changed-intent.bin'),readFileSync(path));denials.push({kind:'changed-intent',input:changedIntent,returned:attempt(()=>f.registry.resolve(start,{env:f.options.env}))});
  capture('stock-intent',{directory:f.directory,registration:f.registration,args:f.args,options:f.options,originalIntent,accepted,started,denials});assert.equal(accepted.kind,'create');assert.equal(started.kind,'start');assert.ok(denials.every(row=>!row.returned.ok));assert.equal(denials.at(-1).returned.code,'QUALIFICATION_STOCK_INTENT_CHANGED');
});
test('preparation: missing stock intent and original source replacement refuse independently',()=>{
  const f=stockFixture(),path=join(f.home,'container-intent.json'),moved=path+'.missing-original';renameSync(path,moved);const missing=attempt(()=>f.registry.resolve(f.args,f.options));capture('stock-missing',{directory:f.directory,moved,missing});assert.equal(missing.ok,false);assert.match(missing.code,/ENOENT/);assert.ok(missing.code.includes(path));
});

test('preparation: terminal validation isolates missing exit, attach, cleanup, service closure and original proof bytes',()=>{
  const f=fixture(),ref=exclusive(join(f.directory,'terminal-input.json'),{original:true}),input={pending:0,children:[{registered:true,owner,exit:{code:0,signal:null}}],containers:[{id:'c'.repeat(64),intent:{nonce:'a'},identity:{nonce:'a'},attach:{birth:owner.birth,boot:owner.boot,exit:{code:0,signal:null}},running:false,removed:true,cli:{code:0,signal:null},absence:{code:1,signal:null,stdout:'',stderr:'Error: No such container: '+'c'.repeat(64)}}],services:[{closed:true,portAbsent:true,pending:0}],refs:[ref]},valid=verifyOwnedTerminal(input),denials=[];
  for(const kind of ['exit','attach','cleanup','service','pending']){const value=JSON.parse(canonical(input));if(kind==='exit')value.children[0].exit=null;if(kind==='attach')value.containers[0].attach=null;if(kind==='cleanup')value.containers[0].removed=false;if(kind==='service')value.services[0].closed=false;if(kind==='pending')value.pending=1;const saved=exclusive(join(f.directory,'negative-'+kind+'.json'),value);denials.push({kind,input:saved,returned:attempt(()=>verifyOwnedTerminal(value))});}
  capture('terminal-closure',{directory:f.directory,input,valid,denials});assert.equal(valid,true);assert.ok(denials.every(row=>!row.returned.ok));
});

test('preparation: deferred ESM-ready bindings require original admission before saved Docker/provider calls and restore exact functions',()=>{
  const f=fixture(),meter=new NativeMeter(f.reserve());let active=null,lower=0;const original=()=>{lower++;return {pid:123};},custom=()=>{lower++;return {child:{pid:123}};};Object.defineProperty(original,promisify.custom,{value:custom});const targets={globals:{fetch:original},childProcess:{execFile:original,spawn:original},http:{request:original},https:{request:original}},restore=installPreparedBindings({mode:'offline',executable:'/private/frozen/docker'},()=>active,meter,()=>{},()=>{},()=>{},()=>{},targets);
  const unregistered=[attempt(()=>targets.childProcess.spawn('/private/frozen/docker',[],{})),attempt(()=>targets.globals.fetch('url',{}))],delegated=targets.childProcess.spawn('/bin/ps',['-p','1'],{});active=null;restore();restore();
  capture('deferred-bindings',{unregistered,lower,delegated,restored:{fetch:targets.globals.fetch===original,spawn:targets.childProcess.spawn===original,custom:targets.childProcess.execFile[promisify.custom]===custom}});assert.ok(unregistered.every(row=>!row.ok));assert.equal(lower,1);assert.equal(targets.childProcess.execFile,original);assert.equal(targets.globals.fetch,original);
});
test('preparation: missing actual process identity retains logical intent, original return and full unknown capacity',async()=>{
  const f=fixture(),meter=new NativeMeter(f.reserve()),observer=new ProcessObservations(f.directory,owner,meter),entry={kind:'create',argv:['fixed','create'],identity:null};observer.before(entry,entry.argv);const actual={pid:undefined};observer.after(actual,entry);const finished=await observer.finish().then(value=>({ok:true,value}),error=>({ok:false,code:error.message})),counter=attempt(()=>meter.snapshot());capture('process-identity-unknown',{directory:f.directory,entry,returnedOriginal:true,finished,counter,held:charges(f.ledger.read()).held});assert.equal(finished.ok,false);assert.equal(counter.ok,false);assert.deepEqual(charges(f.ledger.read()).held,{provider:2,mcp:0,containers:4});
});
test('preparation: public installed handler/config recipe stays inert and native routes are unconditionally held',async()=>{
  const described=await describePiAdapterFiles();capture('public-description-return',described);assert.equal(described.ok,true);if(!described.ok)return;
  const files=described.value,rootDirectory=mkdtempSync(join(realpathSync(tmpdir()),'loopwright-native-plan-')),operator=join(rootDirectory,'operator'),taskRoot=join(rootDirectory,'task');mkdirSync(operator,{mode:0o700});mkdirSync(taskRoot,{mode:0o700});
  const documents=fixtureDocuments('format-only-empty-tools','frozen-revision',files,{executable:'/usr/local/bin/docker',socket:'/private/frozen/docker.sock',image:'sha256:'+'a'.repeat(64),graphDigest:{algorithm:'sha256',hex:sha(readFileSync('package-lock.json'))}}),registryPath=join(operator,'registry.json'),configPath=join(taskRoot,'task.json');exclusive(registryPath,Buffer.from(JSON.stringify(documents.registry)));exclusive(configPath,Buffer.from(JSON.stringify(documents.config)));
  const {loadTrustedConfiguration,compilePlan}=await import('@loopwright/controller'),load={configPath,registryPath,registrySha256:sha(readFileSync(registryPath)),untrustedRoots:[taskRoot]},loaded=await loadTrustedConfiguration(load);capture('public-load-return',{rootDirectory,load,loaded});assert.equal(loaded.ok,true);if(!loaded.ok)return;
  const compiled=await compilePlan(loaded.value);capture('public-compile-return',{rootDirectory,compiled});assert.equal(compiled.ok,true);
  const native=await executePreparedPublicCycle({},{}).then(value=>({ok:true,value}),error=>({ok:false,code:error.message})),parent=attempt(preparedNativeParent),services=attempt(startPreparedServices),recipe=prepareNativeRecipe('cycle'),sse=fixtureResponse('synthetic submission'),write=fixtureWriteResponse('result.json','{"ok":true}');capture('prepared-held',{native,parent,services,recipe,sse,write});assert.equal(native.code,'NATIVE_ACTIVATION_HELD');assert.equal(parent.ok,false);assert.equal(services.ok,false);assert.equal(recipe.caps.mcp,0);
});

test('preparation: original public admission binds expected owner and descriptor, never a later replacement',()=>{
  const f=fixture(),directory=join(f.directory,'run-unit');mkdirSync(directory,{mode:0o700});let ordinal=0;
  const good=value=>{exclusive(join(f.directory,'original-public-result-'+(++ordinal)+'.json'),value.ok&&typeof value.value?.inspect==='function'?{ok:true,value:{opaqueStore:true}}:value);assert.equal(value.ok,true);return value.value;};
  const task=fixtureDocuments('format-only-empty-tools','frozen-revision',{localMcpScriptDigest:{algorithm:'sha256',hex:'a'.repeat(64)},sdkIntegrity:'unit',restrictionDigest:{algorithm:'sha256',hex:'a'.repeat(64)}},{executable:'/private/frozen/docker',socket:'/private/frozen/docker.sock',image:f.context.image,graphDigest:{algorithm:'sha256',hex:'a'.repeat(64)}},Object.fromEntries(['pi.agent.v1','pi.compact.v1','scope.v1','json-artifact.v1','no-change.v1'].map(name=>[name,{algorithm:'sha256',hex:'a'.repeat(64)}]))).config.spec.task;
  const lock=good(admitTask(task,{runId:'run-unit',admissionId:'unit-admission'})),identity={directory:join(directory,'state'),storeId:'unit-store',lock,policy:{version:1,leaseMs:1000,cost:'observe_only'},binding:{coreApiVersion:'loopwright.dev/v1alpha1',hostVersion:'offline',adapters:[{id:'pi',version:'0.0.0'}],resourceVersion:'native-fixture-v1',clockEpoch:'boot.'+sha(owner.boot).slice(0,32)}},store=good(createLocalRun(identity)),initial=good(store.inspect()),authority=good(store.claim({ownerId:'original-owner',expectedGeneration:initial.owner.generation,expectedRevision:initial.revision,mode:'active'})).authority,view=good(store.inspect());
  const configRef=exclusive(join(f.directory,'frozen-task.json'),task),registryRef=exclusive(join(f.directory,'frozen-registry.json'),{version:1,frozen:true}),configuration={configPath:configRef.path,registryPath:registryRef.path,registrySha256:registryRef.sha256},descriptor={version:1,identity,repository:'/private/frozen/repository',configuration};exclusive(join(directory,'run.json'),descriptor);
  const declared={...f.context,configSha256:configRef.sha256,runRoot:f.directory,repository:descriptor.repository,configuration,drainReserveMs:120000,providerEndpoint:'http://127.0.0.1:19080/messages',mcpEndpoint:'http://127.0.0.1:19081/mcp',executable:'/private/frozen/docker',socket:'/private/frozen/docker.sock'},event={stage:'admission',runId:'run-unit',lockHash:view.lockHash,deadlineMonotonicMs:view.clock.basis.taskDeadlineMonotonicMs},signal=new AbortController().signal;
  try{const registration=admissionRegistration(freezeAdmission(declared,event,signal));good(store.release(authority));const released=good(store.inspect());good(store.claim({ownerId:'replacement',expectedGeneration:released.owner.generation,expectedRevision:released.revision,mode:'active'}));const current=good(store.inspect()),meter=new NativeMeter(f.reserve());let lower=0;const entry={kind:'create',identity:{nonce:nonce(),name:'invalid'},argv:['--config','/fixed','--host','unix://'+declared.socket],environment:{}};const context=bindContext({...registration.context,commands:[entry]}),wrapped=processShims(context,meter,{spawn:()=>{lower++;}},()=>{},()=>current),refused=attempt(()=>wrapped.spawn(declared.executable,entry.argv,{env:{}}));const {signal:registeredSignal,cancelled,...contextData}=registration.context;const retainedRegistration={...registration,context:contextData,revocation:{sampledAtMonotonicMs:String(monotonic()),signalIsOriginal:registeredSignal===signal,signalAborted:registeredSignal.aborted,cancelled:cancelled()}};capture('admission-original',{directory,declared,event,descriptor,registration:retainedRegistration,current,refused,lower});assert.equal(registration.originalOwner.id,'original-owner');assert.equal(refused.ok,false);assert.match(refused.code,/AUTHORITY/);assert.equal(lower,0);}finally{good(store.close());}
});
