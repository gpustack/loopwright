/* global Buffer, AbortController, structuredClone */
import './native-preparation.test.mjs';
import assert from 'node:assert/strict';
import test,{after} from 'node:test';
import {mkdtempSync,readFileSync,readdirSync,mkdirSync,realpathSync,appendFileSync,openSync,fsyncSync,closeSync,existsSync} from 'node:fs';
import {resolve,join,dirname} from 'node:path';
import {tmpdir} from 'node:os';
import {fileURLToPath} from 'node:url';
import childProcess from 'node:child_process';
import {promisify} from 'node:util';
import {admitTask,bindSubject,digestArtifact,constructRunResult} from '@loopwright/core';
import {createLocalRun,reopenLocalRun} from '@loopwright/state';
import {describePiAdapterFiles} from '@loopwright/agent-pi';
import {loadTrustedConfiguration,compilePlan} from '@loopwright/controller';
import {checkedRef,canonical,sha,nonce,monotonic,localOwner,exclusive,readPrivate,bindContext} from './native-context.mjs';
import {nativeCases,fixtureDocuments,fixtureReply,startPreparedServices} from './native-cases.mjs';
import {prepareBridgeLeaf,sealBridgeLeaf,reservationContext,leafClock,assertLeafClock,runHeldNativeLeaf} from './native-bridge.mjs';
import {runHeldNativeApplication} from './native-app.mjs';
import {ObservationParent,runPreparedNativeParent} from './native-parent.mjs';
import {NativeLedger,createOfflineLedger,charges,observeCopiedReservations} from './native-ledger.mjs';
import {NativeMeter,meterSnapshot,providerShim,PROVIDER_URL} from './native-guards.mjs';
import {ParentLifecycle} from './lifecycle.mjs';
import {ProcessObservations,processEvidence} from './native-observation.mjs';
import {NativeTerminalObserver,nativeRemoval,nativeTerminal,writeTerminalGraph,validateTerminalGraph,validateRemovalData,originalStream,verifyReceiverTrace,verifyOriginalCase} from './native-terminal.mjs';
import {deriveStockRole} from './native-public.mjs';
import {readPublicSnapshot} from './native-preload.mjs';
import {mutateLegacyBudget,parentTimeState} from './native-lock.mjs';

const nativePath=resolve('.claude/s04-qualification/budget.json'),nativeBefore=readFileSync(nativePath),original=JSON.parse(JSON.parse(nativeBefore).qualificationReservations?checkedRef(JSON.parse(nativeBefore).qualificationReservations.origin):nativeBefore),owner=localOwner();
const root=mkdtempSync(resolve('.claude/s04-qualification/bridge-')),externalRoot=mkdtempSync(join(realpathSync(tmpdir()),'loopwright-native-bridge-')),observations=[],cases=new Map();
const sources=Object.fromEntries(readdirSync(resolve('packages/controller/qualification')).filter(name=>name.endsWith('.mjs')).sort().map(name=>[name,sha(readFileSync(resolve('packages/controller/qualification',name)))]));
const bodies=Object.fromEntries(Object.keys(sources).map(name=>[name,exclusive(join(root,'source-'+name+'.bin'),readFileSync(resolve('packages/controller/qualification',name)))]));
const appFiles=['package-lock.json',...['core','state','agent-pi','controller'].map(name=>'packages/'+name+'/package.json')];
for(const name of ['core','state','agent-pi','controller']){const visit=path=>{for(const entry of readdirSync(path,{withFileTypes:true}).sort((a,b)=>a.name<b.name?-1:1)){const file=join(path,entry.name);if(entry.isDirectory())visit(file);else if(entry.name.endsWith('.js'))appFiles.push(file);}};visit(dirname(fileURLToPath(import.meta.resolve('@loopwright/'+name))));}
const appBindings=Object.fromEntries(appFiles.map(path=>[resolve(path),sha(readFileSync(path))])),appBodies=Object.fromEntries(appFiles.map((path,index)=>[resolve(path),exclusive(join(root,'app-source-'+index+'.bin'),readFileSync(path))]));
const registry=resolve('.claude/s04-qualification/bridge-fixtures.ndjson');appendFileSync(registry,canonical({version:1,root,externalRoot,owner,originalBudgetSha256:sha(nativeBefore),scope:'offline-public-static-no-native'})+'\n',{mode:0o600});const registryFd=openSync(registry,'r');try{fsyncSync(registryFd);}finally{closeSync(registryFd);}
function capture(name,value){const ref=exclusive(join(root,name+'.json'),{version:1,scope:'offline-only',value});JSON.parse(readPrivate(ref.path));observations.push({name,ref});return value;}
function attempt(action){try{const value=action();return value===undefined?{ok:true,returnedType:'undefined'}:{ok:true,value};}catch(error){return {ok:false,code:error.message};}}
async function refused(action){try{await action();return {ok:true};}catch(error){return {ok:false,code:error.message};}}
function fixture(fault){const directory=mkdtempSync(join(root,'ledger-')),path=join(directory,'budget.json'),origin=exclusive(join(directory,'origin.bin'),original);createOfflineLedger(path,original);exclusive(join(directory,'source-manifest.json'),{version:1,hashes:sources,bodies,appBindings,appBodies});return {directory,path,origin,ledger:new NativeLedger(path,fault)};}
function recipe(leaf='cycle'){return {version:2,mode:'offline',leaf,qualification:{runId:'bridge-qualification',taskId:'task-unit',dispatchId:'dispatch-unit'},sourceDigest:sha(canonical(sources)),runtimeDigest:sha(canonical(appBindings)),image:'sha256:'+'a'.repeat(64),executable:'/private/frozen/docker',socket:'/private/frozen/docker.sock',clientDirectory:'/private/frozen/docker-client',clock:leafClock(String(monotonic())),caps:{provider:64,mcp:0,containers:64},cases:nativeCases[leaf].map(id=>cases.get(id).item)};}
after(()=>{const final=readFileSync(nativePath);exclusive(join(root,'bridge-result.json'),{version:1,root,externalRoot,owner,sources,appBindings,observations,staticCases:[...cases.keys()],nativeActivation:'HELD',originalBudgetSha256:sha(nativeBefore),finalBudgetSha256:sha(final),nativeBudgetUnchanged:nativeBefore.equals(final),scope:'offline-only'});assert.deepEqual(final,nativeBefore);});

for(const id of Object.values(nativeCases).flat())test('bridge static recipe: '+id,async()=>{
  const directory=join(externalRoot,id),operator=join(directory,'operator'),task=join(directory,'task');mkdirSync(directory,{mode:0o700});mkdirSync(operator,{mode:0o700});mkdirSync(task,{mode:0o700});
  const described=await describePiAdapterFiles();capture('static-'+id+'-description',described);assert.equal(described.ok,true);if(!described.ok)return;
  const documents=fixtureDocuments(id,'static-only-frozen-revision',described.value,{executable:'/private/frozen/docker',socket:'/private/frozen/docker.sock',image:'sha256:'+'a'.repeat(64),graphDigest:{algorithm:'sha256',hex:sha(readFileSync('package-lock.json'))}});
  const registryRef=exclusive(join(operator,'registry.json'),Buffer.from(JSON.stringify(documents.registry))),configRef=exclusive(join(task,'task.json'),Buffer.from(JSON.stringify(documents.config))),scriptRef=exclusive(join(directory,'sse-script.json'),documents.script),initialRef=exclusive(join(directory,'initial-result.bin'),documents.initial.bytes);
  const responses=documents.script.map((reply,index)=>exclusive(join(directory,'response-'+index+'.bin'),Buffer.from(fixtureReply(reply,index+1)))),sseRef=exclusive(join(directory,'responses.json'),responses);
  const load={configPath:configRef.path,registryPath:registryRef.path,registrySha256:registryRef.sha256,untrustedRoots:[task]},loaded=await loadTrustedConfiguration(load);capture('static-'+id+'-load',{load,loaded});assert.equal(loaded.ok,true);if(!loaded.ok)return;
  const compiled=await compilePlan(loaded.value),item={id,runId:'native-'+id,repository:join(directory,'static-repository'),runRoot:join(directory,'static-runs'),revision:'static-only-frozen-revision',static:true,config:configRef,registry:registryRef,script:scriptRef,sse:sseRef,initial:initialRef};capture('static-'+id+'-compile',{item,compiled,expected:documents.expected,readiness:'static-only'});assert.equal(compiled.ok,true);if(!compiled.ok)return;
  if(id==='sender-only-retry')assert.equal(documents.script[0].status,429);
  if(id==='declared-and-implicit-no-change'){assert.equal(compiled.value.noChangeEligibility.checkId,'tests');assert.equal(compiled.value.verifierSlots.filter(slot=>slot.handler.implementation==='no-change.v1').length,2);}
  if(id==='missing-binding-blocked')assert.equal(compiled.value.noChangeEligibility.available,false);
  cases.set(id,{item,plan:compiled.value,documents});
});

test('bridge: parent and app holds precede lower preparation effects',async()=>{
  let reads=0;const input={get directory(){reads++;return '/must-not-read';}};
  const results=[];for(const action of [()=>runHeldNativeLeaf({},input),()=>runPreparedNativeParent({},input),()=>runHeldNativeApplication({},input),()=>startPreparedServices({},input)])results.push(await refused(action));
  capture('holds',{inputProjection:{directoryAccessor:true},results,accessorReads:reads});assert.equal(reads,0);assert.ok(results.every(row=>!row.ok&&row.code==='NATIVE_ACTIVATION_HELD'));
});
test('bridge: v2 sealed recipe and signed envelope bind originals while version and digest drift refuse',async()=>{
  const positive=fixture(),sealed=sealBridgeLeaf(positive.directory,recipe()),handle=positive.ledger.reserve(reservationContext(sealed.value),sealed.value.caps),parent=new ObservationParent(handle,positive.directory),result=await parent.start({recipeRef:sealed.ref});
  capture('envelope-positive',{directory:positive.directory,recipe:sealed.ref,result});assert.equal(result.exit.code,0);assert.ok(result.proof);positive.ledger.settle(handle,new ParentLifecycle(handle,positive.directory).sealObserved(result.proof));
  const negatives=[];for(const kind of ['version','digest']){const f=fixture(),value=sealBridgeLeaf(f.directory,recipe()),h=f.ledger.reserve(reservationContext(value.value),value.value.caps),p=new ObservationParent(h,f.directory),out=await p.start({recipeRef:value.ref,transformBody:body=>({...body,...(kind==='version'?{version:1}:{recipeDigest:'f'.repeat(64)})})});negatives.push({kind,directory:f.directory,recipe:value.ref,result:out,held:charges(f.ledger.read()).held});}
  const native=structuredClone(sealed.value);native.mode='native';const substitution=attempt(()=>prepareBridgeLeaf(native));capture('envelope-negative',{negatives,staticNativeSubstitution:substitution});assert.ok(negatives.every(row=>row.result.exit.code===76));assert.equal(substitution.code,'QUALIFICATION_STATIC_NATIVE');
});
test('bridge: absent ACK consumes one child allocation and cannot reissue or reconstruct a meter',async()=>{
  const f=fixture(),sealed=sealBridgeLeaf(f.directory,recipe()),h=f.ledger.reserve(reservationContext(sealed.value),sealed.value.caps),p=new ObservationParent(h,f.directory),out=await p.start({recipeRef:sealed.ref,acknowledge:false}),again=await refused(()=>p.start({recipeRef:sealed.ref})),meter=attempt(()=>new NativeMeter(h)),reconstructed=attempt(()=>new NativeMeter({id:h.id}));capture('no-reissue',{directory:f.directory,recipe:sealed.ref,out,again,meter,reconstructed,held:charges(f.ledger.read()).held});assert.equal(out.exit.code,72);assert.equal(again.code,'QUALIFICATION_TICKET_REISSUE');assert.equal(meter.ok,false);assert.equal(reconstructed.ok,false);
});
test('bridge: actual public checkpoint and complete hashed progress bind only the original unfinished role',()=>{
  const directory=mkdtempSync(join(root,'state-')),artifacts=join(directory,'artifacts');mkdirSync(artifacts,{mode:0o700});let n=0;
  const good=result=>{capture('role-public-'+(++n),result.ok&&typeof result.value?.inspect==='function'?{ok:true,value:{opaqueStore:true}}:result);assert.equal(result.ok,true);return result.value;};
  const plan=cases.get('changed-completed').plan,lock=good(admitTask(plan.task,{admissionId:'bridge-admission',runId:'bridge-run'})),identity={directory:join(directory,'state'),storeId:'bridge-store',lock,policy:{version:1,leaseMs:60000,cost:'observe_only'},binding:{coreApiVersion:'loopwright.dev/v1alpha1',hostVersion:'offline-static',adapters:[{id:'pi',version:'0.0.0'}],resourceVersion:'native-fixture-v1',clockEpoch:'boot.'+sha(owner.boot).slice(0,32)}},store=good(createLocalRun(identity));
  const initial=good(store.inspect()),authority=good(store.claim({ownerId:'bridge-owner',expectedGeneration:0,expectedRevision:initial.revision,mode:'active'})).authority;
  const artifact=(kind,value)=>{const bytes=Buffer.from(canonical(value)),name=kind+'-'+sha(bytes)+'.bin';exclusive(join(artifacts,name),bytes);return good(digestArtifact(name,bytes));};
  try{
    const file=good(digestArtifact('result.json',Buffer.from('{"ok":false}'))),manifest={apiVersion:'loopwright.dev/v1alpha1',kind:'ArtifactManifest',metadata:{id:'candidate'},spec:{entries:[file]}},subject=good(bindSubject(lock,manifest)),manifestRef=artifact('manifest',manifest),workspace=artifact('workspace',{offline:true}),planRef=artifact('plan',plan),sourceRef=artifact('source',{offline:true}),command=artifact('command',{offline:true}),indexRef=artifact('index',{offline:true});
    const progress={version:2,runId:'bridge-run',lockHash:lock.spec.lockHash,sequence:1,previous:null,stage:{kind:'role_pre',phase:'role.1.pre',capacity:plan.capacity,consumed:['role.1.pre'],watermarks:{requests:0,operations:0}},nodes:[{id:'build',state:'running'}],attempts:[{ordinal:1,id:'attempt-one',nodeId:'build',nativeStepId:'build',sessionId:'session-one',purpose:'task',repair:'none',command,before:{requests:0,operations:0},finished:null}],nativeCheckpoints:[],submission:null,candidate:{manifest:manifestRef,digest:subject.candidateDigest,generation:0,workspace,privateSession:null},failures:[],verifierReceipts:[],verifierRefusals:[],eventSequence:0,terminalIntent:null},progressRef=artifact('progress',progress),view=good(store.inspect());
    good(store.writeCheckpoint(authority,{checkpointId:'bridge-role-pre',expectedRevision:view.revision,candidateManifest:manifest,workspace,privateSession:null,additionalArtifacts:[progressRef,indexRef,planRef,sourceRef]}));
    const snapshot=readPublicSnapshot(store),descriptor={version:1,identity,plan:planRef,source:sourceRef,repository:'/private/static/repository',configuration:{configPath:cases.get('changed-completed').item.config.path,registryPath:cases.get('changed-completed').item.registry.path,registrySha256:cases.get('changed-completed').item.registry.sha256}},descriptorRef=exclusive(join(directory,'run.json'),descriptor),signal=new AbortController().signal,context=bindContext({mode:'offline',runId:'bridge-run',taskId:'task-unit',dispatchId:'dispatch-unit',sourceDigest:sha(canonical(sources)),image:'sha256:'+'a'.repeat(64),identity:{storeId:identity.storeId,lockHash:lock.spec.lockHash},owner:{id:'bridge-owner',generation:authority.generation},basis:snapshot.view.clock.basis,workCutoff:String(BigInt(snapshot.view.clock.basis.taskDeadlineMonotonicMs)-120000n),leafCutoff:String(monotonic()+15000n),signal,cancelled:()=>signal.aborted,providerEndpoint:'http://127.0.0.1:19080/messages',mcpEndpoint:'http://127.0.0.1:19081/mcp',executable:'/private/frozen/docker',socket:'/private/frozen/docker.sock',commands:[]}),registration={context,descriptor,descriptorRef},accepted=deriveStockRole(registration,snapshot),altered=structuredClone(snapshot);
    altered.records.checkpoints[0].additionalArtifacts[0].byteLength++;const bad=attempt(()=>deriveStockRole(registration,altered));good(store.release(authority));const released=good(store.inspect());good(store.claim({ownerId:'replacement',expectedGeneration:released.owner.generation,expectedRevision:released.revision,mode:'active'}));const replacement=readPublicSnapshot(store),wrongOwner=attempt(()=>deriveStockRole(registration,replacement));
    const {signal:originalSignal,cancelled,...contextData}=context;capture('role-binding',{directory,identity,descriptorRef,context:contextData,captureRevocation:{signalIsOriginal:originalSignal===signal,signalAborted:originalSignal.aborted,cancelled:cancelled(),sampledAtMonotonicMs:String(monotonic())},snapshot,accepted,altered,bad,replacement,wrongOwner,scope:'real public S02 synthetic checkpoint; no product controller or SDK'});assert.equal(accepted.attemptId,'attempt-one');assert.equal(bad.ok,false);assert.equal(wrongOwner.code,'QUALIFICATION_AUTHORITY');
  }finally{capture('role-close',{directory,result:store.close()});}
});
test('bridge: original fixed Node process streams cannot mint native proof from supplied data',async()=>{
  let originalPromise;
  const execute=promisify(childProcess.execFile),f=fixture(),context={runId:'fixed-node',taskId:'task-unit',dispatchId:'dispatch-unit',sourceDigest:sha(canonical(sources)),image:'sha256:'+'a'.repeat(64),leafCutoff:String(monotonic()+10000n)},h=f.ledger.reserve(context,{provider:0,mcp:0,containers:0}),meter=new NativeMeter(h),observer=new ProcessObservations(f.directory,owner,meter),life=new ParentLifecycle(h,f.directory),out=await life.handshake({launch:(file,args,options)=>{const entry={kind:'fixture',argv:args,identity:null};observer.before(entry,args);originalPromise=execute(file,args,{env:options.env,timeout:4000,maxBuffer:8192});observer.after(originalPromise.child,entry);return originalPromise;}}),reply=await originalPromise,finished=await observer.finish(),data=processEvidence(observer),stdout=originalStream(data.records[0],'stdout').toString(),native=attempt(()=>new NativeTerminalObserver({},observer,meter,f.directory,{reservationId:h.id,recipeDigest:'a'.repeat(64)})),forged=[attempt(()=>nativeRemoval(finished)),attempt(()=>nativeTerminal(finished))];capture('original-process',{directory:f.directory,out,finished,data,stdout,originalReply:{stdout:reply.stdout,stderr:reply.stderr,stdoutType:typeof reply.stdout,childPid:originalPromise.child.pid},native,forged});assert.equal(out.exit.code,0);assert.ok(stdout.includes('app-start'));assert.equal(reply.stdout,stdout);assert.equal(typeof reply.stdout,'string');assert.equal(data.mode,'offline');assert.equal(native.code,'NATIVE_ACTIVATION_HELD');assert.ok(forged.every(row=>!row.ok));
});
test('bridge: held native migration and copied write faults preserve original budget and exclusion',()=>{
  const held=fixture(),before=sha(readPrivate(held.path)),native=attempt(()=>held.ledger.migrateHeldNative({},held.origin)),rows=[];
  for(const phase of ['before_commit','after_commit']){const f=fixture(stage=>{if(stage===phase)throw new Error('bridge-injected-'+phase);}),result=attempt(()=>f.ledger.migrateCopied(f.origin)),writer=attempt(()=>mutateLegacyBudget(f.path,owner,value=>value)),grant=attempt(()=>f.ledger.reserve({},{provider:0,mcp:0,containers:0}));rows.push({phase,directory:f.directory,origin:f.origin,result,writer,grant,actual:JSON.parse(readPrivate(f.path))});}
  capture('migration',{directory:held.directory,origin:held.origin,native,before,after:sha(readPrivate(held.path)),rows});assert.equal(native.code,'NATIVE_ACTIVATION_HELD');assert.equal(sha(readPrivate(held.path)),before);assert.ok(rows.every(row=>!row.result.ok&&row.writer.code==='QUALIFICATION_LOCK_HELD'&&row.grant.code==='QUALIFICATION_LOCK_HELD'));
});
test('bridge: copied time and reconciliation retain separate held upper planes and grant nothing',()=>{
  const f=fixture();f.ledger.migrateCopied(f.origin);const receipt=exclusive(join(f.directory,'fixture-elapsed.json'),{scope:'synthetic copied time',seconds:0.25}),transition={id:nonce(),phase:'initial',leaf:'cycle',seconds:0.25,receipt};const first=f.ledger.recordTime(transition),again=f.ledger.recordTime(transition),value=recipe(),h=f.ledger.reserve(reservationContext(value),value.caps),planes=observeCopiedReservations(f.path),next=attempt(()=>f.ledger.reserve(reservationContext(value),value.caps)),actual=attempt(()=>observeCopiedReservations(nativePath));capture('reconciliation',{directory:f.directory,origin:f.origin,transition,first,again,reservationId:h.id,planes,next,actual,ledger:f.ledger.read()});assert.equal(first,'recorded');assert.equal(again,'existing');assert.equal(planes.legacy.provider,21);assert.equal(planes.held.provider,64);assert.equal(planes.upper.provider,85);assert.equal(planes.capacityGrant,'none');assert.equal(next.code,'QUALIFICATION_PRIOR_UNRESOLVED');assert.equal(actual.code,'NATIVE_ACTIVATION_HELD');
});
test('bridge: complete terminal graph and stream bounds reject detached duplicate foreign and oversized proof',()=>{
  const directory=mkdtempSync(join(root,'graph-')),binding={reservationId:nonce(),recipeDigest:'a'.repeat(64),owner},raw=exclusive(join(directory,'original.bin'),Buffer.from([0,255,10,13])),graph=writeTerminalGraph(directory,binding,[raw]),valid=validateTerminalGraph(graph,binding,[directory]),duplicate=attempt(()=>writeTerminalGraph(directory,binding,[raw,raw])),large=attempt(()=>exclusive(join(directory,'must-not-exist.bin'),Buffer.alloc(1048577))),foreign=attempt(()=>validateTerminalGraph(graph,binding,[join(directory,'other')]));
  const detachedRef=exclusive(join(directory,'detached.json'),{original:raw}),shard=exclusive(join(directory,'bad-shard.json'),{version:1,binding,refs:[detachedRef]}),detachedRoot=exclusive(join(directory,'bad-root.json'),{version:1,binding,shards:[shard]}),detached=attempt(()=>validateTerminalGraph(detachedRoot,binding,[directory]));
  const stream={stdoutBytes:5,stdoutSha256:raw.sha256,stdoutChunks:[raw]},drift=attempt(()=>originalStream(stream,'stdout')),fake={nonce:'a'.repeat(32),id:'b'.repeat(64),identity:{nonce:'a'.repeat(32)},running:false,removed:true,cli:{code:0,signal:null},absence:{code:1,signal:null,stdout:'',stderr:'Error: No such container: '+'b'.repeat(64)},attach:{birth:owner.birth,boot:owner.boot,exit:{code:0,signal:null}}},pure=validateRemovalData(fake),native=attempt(()=>nativeRemoval(fake));capture('terminal-graph',{directory,binding,raw,graph,valid,duplicate,large,foreign,detachedRef,shard,detachedRoot,detached,stream,drift,fake,pure,native});assert.equal(pure,true);assert.ok([duplicate,large,foreign,detached,drift,native].every(row=>!row.ok));
});
test('bridge: original work and hard clocks do not reset after blocking preparation',()=>{
  const clock=leafClock(String(monotonic()-99900n)),before=attempt(()=>assertLeafClock(clock)),sampleBefore=String(monotonic());Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,180);const sampleAfter=String(monotonic()),after=attempt(()=>assertLeafClock(clock)),reset=attempt(()=>assertLeafClock({...clock,workCutoff:String(monotonic()+100000n)}));let lower=0;if(after.ok)lower++;capture('leaf-clock',{clock,before,sampleBefore,sampleAfter,after,reset,lower});assert.equal(before.ok,true);assert.equal(after.code,'QUALIFICATION_LEAF_EXPIRED');assert.equal(reset.code,'QUALIFICATION_LEAF_EXPIRED');assert.equal(lower,0);
});

function parentAttempt(action){try{return {ok:true,value:action()};}catch(error){return {ok:false,code:error.message,observation:error.observation??null};}}

test('parent closure: equal payloads remain distinct original receiver events and same-count substitutions refuse',()=>{
  const f=fixture(),context={runId:'counter-run',taskId:'task-unit',dispatchId:'dispatch-unit',sourceDigest:sha(canonical(sources)),image:'sha256:'+'a'.repeat(64),leafCutoff:String(monotonic()+10000n)},h=f.ledger.reserve(context,{provider:2,mcp:0,containers:0}),meter=new NativeMeter(h),calls=[];
  const prior=JSON.parse(readPrivate(observations.find(row=>row.name==='role-binding').ref.path)).value,signal=new AbortController().signal;
  const caller=bindContext({...prior.context,workCutoff:prior.snapshot.view.clock.basis.taskDeadlineMonotonicMs,leafCutoff:String(monotonic()+10000n),signal,cancelled:()=>false}),body=Buffer.from('{"same":"payload"}'),options={method:'POST',headers:{},body,signal,redirect:'error'};
  const lower=providerShim(caller,meter,(url,value)=>{calls.push({url,optionsIsOriginal:value===options,bodyIsOriginal:value.body===body,bodySha256:sha(value.body),byteLength:value.body.length});return 'mock-return';});
  const replies=[lower(PROVIDER_URL,options),lower(PROVIDER_URL,options)],originalSnapshot=meterSnapshot(meter.snapshot()),originalCalls=exclusive(join(f.directory,'original-mocked-sends.json'),{scope:'mocked lower only; no listener or network',calls,replies,snapshot:originalSnapshot});
  function receiver(kind){
    const directory=mkdtempSync(join(f.directory,'receiver-')),refs=[],put=(name,value)=>{const ref=exclusive(join(directory,name),value);refs.push(ref);return ref;},token=nonce(),item={id:'counter-only',runId:'counter-run'},recipe={sourceDigest:context.sourceDigest,cases:[item]},requests=[];
    const intent=put('provider-intent-'+token+'.json',{caseId:item.id,nonce:token,owner,sourceDigest:recipe.sourceDigest,bind:'127.0.0.1'}),listening=put('provider-listening-'+token+'.json',{caseId:item.id,nonce:token,owner,intent,address:{address:'127.0.0.1',port:19080}}),records=[];
    for(let index=0;index<2;index++){
      const ordinal=index+1,event=kind==='duplicate'?1:ordinal,request={sequence:event,admission:{attemptId:'mock-attempt-'+event,requestId:'mock-request-'+event},admissionDigest:'mock-'+event,admissionGeneration:1,dispatch:{mock:'original-'+event},state:'dispatch_authorized'};
      requests.push({...request,state:'observed'});const raw=put('provider-request-'+token+'-'+ordinal+'.bin',body),subject=put('provider-subject-'+token+'-'+ordinal+'.json',{version:1,caseId:item.id,runId:item.runId,request,snapshot:{view:{runId:item.runId},records:{requests:[request]},close:{ok:true,value:{closed:true}}}});
      records.push({ordinal,authorized:true,inputBytes:body.length,request:raw,subject});
    }
    if(kind==='swapped')records.reverse();
    const service=put('provider-closed-'+token+'.json',{caseId:item.id,nonce:token,owner,intent,listening,pending:0,unknown:false,ownListenerClosed:true,records,received:2}),result=put('case-'+item.id+'.json',{id:item.id,service,snapshot:{records:{requests}},delta:{provider:2}});
    put('process-observation-final.json',{pending:0,unknown:false,records:[]});
    const snapshot=structuredClone(originalSnapshot);if(kind==='altered')snapshot.trace[1].digest='f'.repeat(64);
    if(kind==='missing')snapshot.actual.containers=1;
    const input={recipe,data:{binding:{owner},results:[result],snapshot},graph:{refs}},inputRef=put('checker-original-input.json',{...input,scope:'synthetic receiver/process data; real copied meter trace; no native proof'}),output=parentAttempt(()=>verifyReceiverTrace(recipe,input.data,input.graph));
    return {kind,directory,input:inputRef,output};
  }
  const rows=['positive','altered','swapped','duplicate','missing'].map(receiver);capture('n0-counter-bijection',{directory:f.directory,originalCalls,rows,scope:'offline mocked sends and synthetic receiver records only'});
  assert.equal(originalSnapshot.trace[0].digest,originalSnapshot.trace[1].digest);assert.ok(calls.every(row=>row.optionsIsOriginal&&row.bodyIsOriginal));
  assert.equal(rows[0].output.ok,true);assert.equal(rows[0].output.value.receiverEvents.length,2);assert.notEqual(rows[0].output.value.receiverEvents[0].attemptId,rows[0].output.value.receiverEvents[1].attemptId);
  assert.deepEqual(rows.slice(1).map(row=>row.output.code),['QUALIFICATION_PARENT_COUNTER','QUALIFICATION_PARENT_EVENT','QUALIFICATION_PARENT_DUPLICATE','QUALIFICATION_PARENT_COUNTER']);
});

test('parent closure: complete original product artifacts bind duplicates and a fresh public S02 read closes before comparison',()=>{
  const directory=mkdtempSync(join(root,'original-case-')),runRoot=join(directory,'runs'),runId='original-case',artifacts=join(runRoot,runId,'artifacts');mkdirSync(artifacts,{recursive:true,mode:0o700});const refs=[],publicResults=[];
  const good=value=>{publicResults.push(value.ok&&typeof value.value?.inspect==='function'?{ok:true,value:{opaqueStore:true}}:value);assert.equal(value.ok,true,value.ok?undefined:canonical(value));return value.value;};
  const base=cases.get('missing-binding-blocked'),item={...base.item,id:'original-case',runId,runRoot},lock=good(admitTask(base.plan.task,{admissionId:'original-admission',runId})),identity={directory:join(directory,'state'),storeId:'original-store',lock,policy:{version:1,leaseMs:60000,cost:'observe_only'},binding:{coreApiVersion:'loopwright.dev/v1alpha1',hostVersion:'offline-original-case',adapters:[{id:'pi',version:'0.0.0'}],resourceVersion:'n0-fixture-v1',clockEpoch:'boot.'+sha(owner.boot).slice(0,32)}},store=good(createLocalRun(identity));
  const initial=good(store.inspect()),authority=good(store.claim({ownerId:'original-owner',expectedRevision:initial.revision,expectedGeneration:0,mode:'active'})).authority;
  const artifact=(kind,value)=>{
    const bytes=Buffer.from(canonical(value)),name=kind+'-'+sha(bytes)+'.bin',path=join(artifacts,name);exclusive(path,bytes);const ref=good(digestArtifact(name,bytes)),chunks=[];
    for(let offset=0;offset<bytes.length;offset+=1048576){const chunk=exclusive(join(directory,'raw-'+nonce()+'.bin'),bytes.subarray(offset,offset+1048576));refs.push(chunk);chunks.push(chunk);}
    refs.push(exclusive(join(directory,'artifact-'+nonce()+'.json'),{version:1,kind:'original-artifact',originalPath:path,byteLength:bytes.length,sha256:sha(bytes),chunks}));return ref;
  };
  let saved,descriptorRef,originalClose;
  try{
    const candidate=artifact('candidate',{offline:true}),manifest={apiVersion:'loopwright.dev/v1alpha1',kind:'ArtifactManifest',metadata:{id:'candidate'},spec:{entries:[candidate]}},subject=good(bindSubject(lock,manifest)),manifestRef=artifact('manifest',manifest),workspace=artifact('workspace',{offline:true}),planRef=artifact('plan',base.plan),sourceRef=artifact('source',{offline:true}),indexRef=artifact('index',{offline:true});
    const result=good(constructRunResult({trusted:{expectedLock:lock,candidateManifest:manifest,eligibleEvidence:[],usage:[],externalEffects:'none',noChange:null},candidate:{status:'blocked',checks:[],memory:{status:'not_requested',reason:null}}},[])),resultRef=artifact('result',result),observed={scope:'synthetic product packet; actual public S02; no SDK/controller execution',status:'blocked',events:[{ordinal:1,reason:'missing binding'}]},observedRef=artifact('observations',observed);
    const progress={version:2,runId,lockHash:lock.spec.lockHash,sequence:1,previous:null,stage:{kind:'terminal_observations',phase:'terminal.observations'},attempts:[],candidate:{manifest:manifestRef,digest:subject.candidateDigest,workspace,privateSession:null},verifierReceipts:[],terminalIntent:{result:resultRef,observations:observedRef}},progressRef=artifact('progress',progress),view=good(store.inspect());
    good(store.writeCheckpoint(authority,{checkpointId:'original-terminal',expectedRevision:view.revision,candidateManifest:manifest,workspace,privateSession:null,additionalArtifacts:[progressRef,indexRef,planRef,sourceRef]}));
    const descriptor={version:1,identity,repository:item.repository,configuration:{configPath:item.config.path,registryPath:item.registry.path,registrySha256:item.registry.sha256},plan:planRef,source:sourceRef};descriptorRef=exclusive(join(directory,'run.json'),descriptor);refs.push(descriptorRef);
    saved={id:item.id,descriptor:descriptorRef,snapshot:readPublicSnapshot(store),outcome:{ok:true,value:{kind:'result',result,observations:observedRef}},observations:observed};
  }finally{originalClose=store.close();publicResults.push(originalClose);}
  saved.snapshot.close=originalClose;
  const graph={refs},input=exclusive(join(directory,'original-input.json'),{item,saved,graph,publicResults,scope:'synthetic artifacts, public S02 APIs, no native brand'}),positive=parentAttempt(()=>verifyOriginalCase(item,saved,graph)),altered=structuredClone(saved);altered.observations.events[0].reason='same count changed duplicate';
  const duplicate=parentAttempt(()=>verifyOriginalCase(item,altered,graph)),differentResult=structuredClone(saved);differentResult.outcome.value.result.spec.status='failed';const resultMismatch=parentAttempt(()=>verifyOriginalCase(item,differentResult,graph));
  const reopened=good(reopenLocalRun(identity));let mutation,close;try{mutation=reopened.release(authority);}finally{close=reopened.close();}const changed=parentAttempt(()=>verifyOriginalCase(item,saved,graph));
  capture('n0-original-case',{directory,input,positive,altered,duplicate,differentResult,resultMismatch,mutation,close,changed,publicResults});
  assert.equal(positive.ok,true);assert.equal(positive.value.earlierClockReconstructed,false);assert.deepEqual(positive.value.read.close,{ok:true,value:{closed:true}});assert.notDeepEqual(positive.value.newClockObservation,saved.snapshot.view.clock.sampledNow);
  assert.equal(duplicate.code,'QUALIFICATION_PARENT_CASE_OBSERVATIONS');assert.equal(resultMismatch.code,'QUALIFICATION_PARENT_RESULT');assert.equal(mutation.ok,true);assert.equal(close.ok,true);assert.equal(changed.code,'QUALIFICATION_PARENT_STATE_CHANGED');assert.deepEqual(changed.observation.close,{ok:true,value:{closed:true}});
});

test('parent closure: original copied elapsed and acknowledgement failures block every legacy or reservation grant without resetting bytes',()=>{
  const rows=[],context={runId:'time-run',taskId:'task-unit',dispatchId:'dispatch-unit',sourceDigest:sha(canonical(sources)),image:'sha256:'+'a'.repeat(64),leafCutoff:String(monotonic()+10000n)},caps={provider:0,mcp:0,containers:0};
  const files=directory=>Object.fromEntries(readdirSync(directory).filter(name=>!name.endsWith('.json')||name!=='source-manifest.json').filter(name=>!['state'].includes(name)).map(name=>{const path=join(directory,name),bytes=readFileSync(path);return [path,{byteLength:bytes.length,sha256:sha(bytes),text:bytes.toString()}];}));
  for(const kind of ['legacy-before-migration','unavailable-directory','positive','before_elapsed_write','after_elapsed_write','before_time_write','after_time_write','before_ack_write','after_ack_write']){
    let f;
    if(['legacy-before-migration','unavailable-directory'].includes(kind)){const directory=mkdtempSync(join(root,'legacy-time-')),path=join(directory,'budget.json');exclusive(path,original);f={directory,path,ledger:new NativeLedger(path)};}
    else{f=fixture();f.ledger.migrateCopied(f.origin);}
    const before=readFileSync(f.path),recordDirectory=kind==='unavailable-directory'?join(f.directory,'unavailable'):f.directory,handle=f.ledger.beginCopiedParentTime({directory:recordDirectory,phase:'initial',leaf:'cycle'}),work=parentAttempt(()=>{if(kind==='legacy-before-migration')readPrivate(join(f.directory,'missing-original-recipe.json'));return {exit:{code:0,signal:null}};}),outcome={intent:exclusive(join(f.directory,'original-work-intent.json'),{scope:'copied no-native timing',kind}),exit:work.ok?work.value.exit:null,error:work.ok?null:work.code,errorObservation:work.observation??null};
    const result=parentAttempt(()=>f.ledger.completeParentTime(handle,outcome,point=>{if(point===kind)throw new Error('n0-injected-'+point);})),state=parentTimeState(handle),after=readFileSync(f.path),repeat=kind==='positive'?parentAttempt(()=>f.ledger.completeParentTime(handle,outcome)):null;
    const grants=kind==='positive'?null:{same:attempt(()=>f.ledger.reserve(context,caps)),fresh:attempt(()=>new NativeLedger(f.path).reserve(context,caps)),legacy:attempt(()=>mutateLegacyBudget(f.path,owner,value=>value))};
    rows.push({kind,directory:f.directory,path:f.path,recordDirectory,before:{sha256:sha(before),text:before.toString()},after:{sha256:sha(after),text:after.toString()},work,outcome,result,state,repeat,grants,pendingExists:existsSync(f.path+'.parent-time-pending.json'),files:files(f.directory)});
  }
  capture('n0-parent-time',{rows,actualBudgetSha256:sha(readFileSync(nativePath)),scope:'copied ledgers and actual local injected failures only; no native accounting'});
  const positive=rows.find(row=>row.kind==='positive');assert.equal(positive.result.ok,true);assert.equal(positive.result.value.state,'recorded');assert.equal(positive.repeat.value.state,'existing');assert.equal(positive.pendingExists,false);assert.equal(JSON.parse(positive.after.text).qualificationReservations.timeTransitions.length,1);assert.equal(positive.state.state,'closed');
  for(const row of rows.filter(row=>row!==positive)){assert.equal(row.result.ok,false);assert.equal(row.state.state,'unknown');assert.equal(row.pendingExists,true);assert.ok(Object.values(row.grants).every(grant=>!grant.ok&&['QUALIFICATION_PARENT_TIME_PENDING','QUALIFICATION_LOCK_HELD'].includes(grant.code)));}
  for(const row of rows.slice(0,2))assert.equal(row.before.sha256,row.after.sha256);
  assert.equal(rows[0].result.code,'QUALIFICATION_PARENT_TIME_MIGRATION_REQUIRED');assert.equal(rows[0].work.ok,false);assert.ok(Object.keys(rows[0].files).some(path=>path.includes('native-parent-elapsed-')));
  assert.equal(rows[1].state.receipt,null);assert.ok(!Object.keys(rows[1].files).some(path=>path.includes('native-parent-elapsed-')));
  for(const row of rows.slice(3)){const count=JSON.parse(row.after.text).qualificationReservations.timeTransitions.length;assert.equal(count,['after_time_write','before_ack_write','after_ack_write'].includes(row.kind)?1:0);}
});
