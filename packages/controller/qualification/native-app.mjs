/* global process, AbortController */
import childProcess from 'node:child_process';
import { identifyManifest } from '@loopwright/core';
import { promisify } from 'node:util';
import { dirname, join } from 'node:path';
import { requireNativeAppActivation } from './native-activation.mjs';
import { readBridgeLeaf, assertLeafClock } from './native-bridge.mjs';
import { checkedRef, canonical, sha, same, exclusive, localOwner, nonce, revoke, fail } from './native-context.mjs';
import { NativeMeter, meterSnapshot } from './native-guards.mjs';
import { ProcessObservations, processEvidence } from './native-observation.mjs';
import { NativeTerminalObserver, nativeTerminal } from './native-terminal.mjs';
import { installPreparedBindings, readOriginalState } from './native-preload.mjs';
import { admissionRegistration, readRegisteredSnapshot, deriveStockRole, publicArtifact, terminalObservations } from './native-public.mjs';
import { StockIntentRegistry } from './native-container.mjs';
import { executePreparedPublicCli, resumePreparedPublicCli } from './native-cli.mjs';
import { startPreparedServices } from './native-cases.mjs';

const expectedStatuses={
  'changed-completed':'completed','false-submitted-pass':'failed','required-check-failed':'failed',
  'declared-and-implicit-no-change':'no_change','missing-binding-blocked':'blocked','captured-first-exhausted-second-zero':'exhausted','blocked-evidence':'blocked',
  'format-only-empty-tools':'completed','implementation-candidate-change':'completed','unactionable-no-repair':'blocked','persistent-repeat-cap':'exhausted','sender-only-retry':'completed',
};
/** Logical candidate entries are backed by source blobs or Pi workspace captures, not store paths. */
export function retainArtifacts(terminal,registration,value,seen=new Set()){
  if(!value||typeof value!=='object')return;
  if(value.kind==='ArtifactManifest'){
    if(!identifyManifest(value).ok)fail('QUALIFICATION_PUBLIC_ARTIFACT');
    return;
  }
  if(!Array.isArray(value)&&same(Object.keys(value).sort(),['artifact','mode','name','oid','ref'])){
    if(value.name!==value.ref?.name||!same(value.ref?.digest,value.artifact?.digest)||value.ref?.byteLength!==value.artifact?.byteLength)fail('QUALIFICATION_PUBLIC_ARTIFACT');
    retainArtifacts(terminal,registration,value.artifact,seen);return;
  }
  if(!Array.isArray(value)&&same(Object.keys(value).sort(),['byteLength','digest','name'])){
    const key=canonical(value);if(seen.has(key))return;seen.add(key);
    const stored=/^([a-z][a-z0-9-]{0,23})-[a-f0-9]{64}\.bin$/.exec(value.name),capture=/^pi-checkpoints\/pi\.[a-f0-9]{40}\.(?:session|workspace)\.ndjson$/.test(value.name);
    if((!stored&&!capture)||value.digest?.algorithm!=='sha256')fail('QUALIFICATION_PUBLIC_ARTIFACT');
    const path=join(dirname(registration.descriptorRef.path),'artifacts',value.name);terminal.retainArtifact(path,value.byteLength,value.digest.hex);
    const structured=new Set(['manifest','native-manifest','source','workspace','progress','index','role-outcome','result','observations','verifier-receipt','verifier-refusal']);
    if(stored&&structured.has(stored[1])){
      const bytes=publicArtifact(registration,value).bytes;let decoded;try{decoded=JSON.parse(bytes);}catch{fail('QUALIFICATION_PUBLIC_ARTIFACT');}
      retainArtifacts(terminal,registration,decoded,seen);
    }
    return;
  }
  for(const item of Object.values(value))retainArtifacts(terminal,registration,item,seen);
}
export function validateNativeCase(item,outcome,snapshot,observations,delta,resume=null){
  if(resume&&(!resume.matched||!resume.stateUnchanged||!same(resume.before,resume.after)))fail('QUALIFICATION_NATIVE_CASE');
  if(item.id==='sender-only-retry'){
    const execution=outcome.value,requests=snapshot.records.requests,ledger=snapshot.view.ledger,first=requests[0],second=requests[1],counts=snapshot.view.counts;
    if(!outcome.ok||execution.kind!=='incident'||execution.incident.code!=='RECOVERY_REQUIRED'||execution.incident.cleanup!=='complete'||observations?.cleanup!=='complete'
      ||!same(snapshot.close,{ok:true,value:{closed:true}})||requests.length!==2||delta.provider!==2||delta.containers!==1||ledger.transportRetries!==1||ledger.unknownTokenRequests!==1
      ||counts.unresolvedRequests!==1||counts.unresolvedOperations!==0||counts.dispatchedRequests!==0||first.state!=='unresolved'||first.initialObservation?.termination!=='confirmed'||first.initialObservation?.outcome!=='failed'
      ||second.state!=='observed'||second.initialObservation?.termination!=='confirmed'||second.initialObservation?.outcome!=='succeeded'||second.admission.transportRetryOf!==first.admission.requestId
      ||first.chargedTokens.decimal!==String(first.admission.totalUpperBound)||ledger.reservedCharge.decimal!==first.chargedTokens.decimal)fail('QUALIFICATION_NATIVE_CASE');return;
  }
  if(!outcome.ok||outcome.value.kind!=='result'||outcome.value.result.spec.status!==expectedStatuses[item.id]||outcome.value.secondary.length)fail('QUALIFICATION_NATIVE_CASE');
  if(!same(snapshot.close,{ok:true,value:{closed:true}})||snapshot.view.counts.unresolvedRequests||snapshot.view.counts.unresolvedOperations||snapshot.view.counts.dispatchedRequests||!observations||observations.cleanup!=='complete')fail('QUALIFICATION_NATIVE_CASE');
  const matrix=observations.verifierMatrix;
  if(item.id==='changed-completed'&&!matrix.some(row=>row.implicit==='no_change'&&row.status==='failed'))fail('QUALIFICATION_NATIVE_CASE');
  if(item.id==='declared-and-implicit-no-change'&&(!observations.selectedNoChangeCheck||!matrix.some(row=>row.implicit===null&&row.checkId===observations.selectedNoChangeCheck&&row.status==='passed')||!matrix.some(row=>row.implicit==='no_change'&&row.status==='passed')))fail('QUALIFICATION_NATIVE_CASE');
  if(item.id==='captured-first-exhausted-second-zero'&&(delta.provider!==1||delta.containers!==1||snapshot.view.ledger.admittedCalls!==1))fail('QUALIFICATION_NATIVE_CASE');
  for(const [id,key,amount] of [['format-only-empty-tools','formatRepairs',1],['implementation-candidate-change','implementationRepairs',2],['sender-only-retry','transportRetries',1],['unactionable-no-repair','implementationRepairs',0],['missing-binding-blocked','implementationRepairs',0]])if(item.id===id&&snapshot.view.ledger[key]!==amount)fail('QUALIFICATION_NATIVE_CASE');
}
/** A closed assertion failure is separate from native protocol/resource closure. */
export function validateNativeQualification(recipe,data){
  if(!Array.isArray(data.results)||!data.results.length||data.results.length>recipe.cases.length)fail('QUALIFICATION_NATIVE_CASE');
  const qualification=data.qualification;
  if(!qualification||!same(Object.keys(qualification).sort(),['failedCase','reason','status'])||!['passed','failed'].includes(qualification.status))fail('QUALIFICATION_NATIVE_CASE');
  const cases=recipe.cases.slice(0,data.results.length);
  if(qualification.status==='passed'&&(cases.length!==recipe.cases.length||qualification.failedCase!==null||qualification.reason!==null))fail('QUALIFICATION_NATIVE_CASE');
  if(qualification.status==='failed'&&(qualification.failedCase!==cases.at(-1).id||qualification.reason!=='QUALIFICATION_NATIVE_CASE'))fail('QUALIFICATION_NATIVE_CASE');
  if(!same(data.results.map(ref=>ref.path.split('/').at(-1)),cases.map(item=>'case-'+item.id+'.json')))fail('QUALIFICATION_NATIVE_CASE');
  return cases;
}
/** Fixed application: both caller and child require original live native capabilities. */
export async function runHeldNativeApplication(activation,input){
  requireNativeAppActivation(activation);
  const recipe=readBridgeLeaf(input.recipe),manifest=input.manifest;if(recipe.mode!=='native'||manifest.context.recipeDigest!==sha(canonical(recipe)))fail('QUALIFICATION_TICKET_RECIPE');
  assertLeafClock(recipe.clock);
  const meter=new NativeMeter(input.ticket),owner=localOwner(),observer=new ProcessObservations(input.directory,owner,meter,{activation,reservationId:manifest.reservationId,recipeDigest:manifest.context.recipeDigest});
  const terminal=new NativeTerminalObserver(activation,observer,meter,input.directory,{reservationId:manifest.reservationId,recipeDigest:manifest.context.recipeDigest}),registries=new WeakMap(),abort=new AbortController(),results=[];
  const terminate=()=>abort.abort();process.once('SIGTERM',terminate);process.once('SIGINT',terminate);
  const savedExec=childProcess.execFile[promisify.custom];let current=null,activeCase=null;
  let qualification={status:'passed',failedCase:null,reason:null};
  if(Object.hasOwn(process.env,'S04_PROVIDER_TOKEN'))fail('QUALIFICATION_AMBIENT_CREDENTIAL');
  const syntheticToken='S04_BRIDGE_SYNTHETIC_'+nonce();process.env.S04_PROVIDER_TOKEN=syntheticToken;
  const resolveCommand=(args,options)=>{
    if(!current)fail('QUALIFICATION_ADMISSION_UNREGISTERED');
    const snapshot=readRegisteredSnapshot(current);let cached=registries.get(current);
    if(!cached){const roles=[];cached={roles,registry:new StockIntentRegistry({runtimeRoot:join(dirname(current.descriptorRef.path),'runtime'),socket:recipe.socket,image:recipe.image,runId:current.context.runId,owner:current.context.owner,roles})};registries.set(current,cached);}
    if(['create','start','info','image'].includes(args[4])){
      const role=deriveStockRole(current,snapshot),index=cached.roles.findIndex(row=>row.attemptId===role.attemptId),old=cached.roles[index];
      if(old&&['hostDirectory','sessionId','candidate','nodeId','roleId'].some(key=>old[key]!==role[key]))fail('QUALIFICATION_ROLE_PROGRESS');
      for(const ref of role.refs)terminal.retainPublic(ref);if(index<0)cached.roles.push(Object.freeze(role));else cached.roles[index]=Object.freeze(role);
    }
    return cached.registry.resolve(args,options);
  };
  const restore=installPreparedBindings({mode:'native',executable:recipe.executable},()=>current,meter,(entry,args)=>{terminal.flushRemovals();if(entry.identity)terminal.captureLease(current,entry);observer.before({...entry,caseId:activeCase.id,runId:current.context.runId},args);},registration=>readOriginalState(registration.descriptorRef.path,registration.descriptorRef.sha256,registration.context),(child,entry)=>observer.after(child,entry),resolveCommand,undefined,activation);
  try{
    for(const item of recipe.cases){
      assertLeafClock(recipe.clock);current=null;activeCase=item;
      const before=meterSnapshot(meter.snapshot()),script=JSON.parse(checkedRef(item.script)),services=await startPreparedServices(activation,{directory:input.directory,caseId:item.id,sourceDigest:recipe.sourceDigest,cap:script.length,script,syntheticToken,observeServer:(server,intent)=>terminal.observeService(server,intent),inspectRequest:()=>{
        if(!current)fail('QUALIFICATION_ADMISSION_UNREGISTERED');const snapshot=readRegisteredSnapshot(current);revoke(current.context,snapshot.view);
        const active=snapshot.records.requests.filter(row=>row.state==='dispatch_authorized'&&row.dispatch!==null);if(active.length!==1)fail('QUALIFICATION_RECEIVER_ATTEMPT');return {version:1,caseId:item.id,runId:item.runId,request:active[0],snapshot};
      }});
      terminal.retainPublic(services.listening);let outcome,closedService=null,resume=null;
      try{
        const declared={mode:'native',...recipe.qualification,runId:item.runId,sourceDigest:recipe.sourceDigest,image:recipe.image,leafCutoff:recipe.clock.workCutoff,runRoot:item.runRoot,repository:item.repository,configuration:{configPath:item.config.path,registryPath:item.registry.path,registrySha256:item.registry.sha256},configSha256:item.config.sha256,drainReserveMs:120000,providerEndpoint:services.endpoint,mcpEndpoint:'http://127.0.0.1:1/mcp',executable:recipe.executable,socket:recipe.socket};
        const executionInput={load:{configPath:item.config.path,registryPath:item.registry.path,registrySha256:item.registry.sha256,untrustedRoots:[item.repository]},repository:item.repository,runRoot:item.runRoot,runId:item.runId,signal:abort.signal,declared,retainCli:async value=>{terminal.retainPublic(exclusive(join(input.directory,'cli-'+item.id+'.json'),value));},observe:async(event,handle)=>{if(handle)current=admissionRegistration(handle);terminal.retainPublic(exclusive(join(input.directory,'event-'+item.id+'-'+event.sequence+'.json'),event));}};
        outcome=await executePreparedPublicCli(activation,executionInput);
        terminal.flushRemovals();
        const before=readRegisteredSnapshot(current),actualBefore=meterSnapshot(meter.snapshot()).actual;
        resume=await resumePreparedPublicCli(activation,{...executionInput,original:outcome,retainCli:async value=>{const ref=exclusive(join(input.directory,'cli-resume-'+item.id+'.json'),value);terminal.retainPublic(ref);return ref;}});
        const after=readRegisteredSnapshot(current),facts=snapshot=>({storeId:snapshot.view.storeId,runId:snapshot.view.runId,lockHash:snapshot.view.lockHash,startedAtMs:snapshot.view.startedAtMs,deadlineMs:snapshot.view.deadlineMs,basis:snapshot.view.clock.basis,counts:snapshot.view.counts,ledger:snapshot.view.ledger,requests:snapshot.records.requests,operations:snapshot.records.operations});
        resume={...resume,before:actualBefore,after:meterSnapshot(meter.snapshot()).actual,stateUnchanged:same(facts(before),facts(after)),original:facts(before),retained:facts(after)};
      }finally{
        const closed=await services.close();terminal.retainPublic(closed.ref);if(closed.value.pending||closed.value.unknown||closed.value.received!==script.length)fail('QUALIFICATION_SERVICE_UNKNOWN');
        closedService=closed.ref;
        const args=['-nP','-iTCP:'+services.observation.listening.port,'-sTCP:LISTEN','-Fpn'],entry={kind:'read',executable:'/usr/sbin/lsof',caseId:item.id,runId:item.runId,argv:args,identity:null},options={timeout:2000,maxBuffer:8192,env:{PATH:'/usr/bin:/bin:/usr/sbin',LANG:'C'}};
        observer.before(entry,args);const pending=savedExec('/usr/sbin/lsof',args,options);observer.after(pending.child,entry);await pending.catch(error=>{if(error.code!==1)throw error;});
        const record=processEvidence(observer).records.at(-1);terminal.observePortAbsence(services.observation,record);
      }
      if(!current)fail('QUALIFICATION_ADMISSION_UNREGISTERED');terminal.flushRemovals();
      const snapshot=readRegisteredSnapshot(current),after=meterSnapshot(meter.snapshot()),delta=Object.fromEntries(['provider','mcp','containers'].map(key=>[key,after.actual[key]-before.actual[key]]));
      const observed=outcome.ok&&outcome.value.kind==='result'&&outcome.value.observations?{ref:outcome.value.observations,value:JSON.parse(publicArtifact(current,outcome.value.observations).bytes)}:terminalObservations(current,snapshot),observations=observed.value,observationsRef=observed.ref;
      const evidence=exclusive(join(input.directory,'case-'+item.id+'.json'),{version:2,id:item.id,descriptor:current.descriptorRef,service:closedService,outcome,snapshot,observations,observationsRef,delta,resume});terminal.retainPublic(evidence);terminal.retainPublic(current.descriptorRef);
      retainArtifacts(terminal,current,current.descriptor);retainArtifacts(terminal,current,snapshot.records.checkpoints);retainArtifacts(terminal,current,outcome);retainArtifacts(terminal,current,observationsRef);
      results.push(evidence);
      try{validateNativeCase(item,outcome,snapshot,observations,delta,resume);}catch(error){
        if(error.message!=='QUALIFICATION_NATIVE_CASE')throw error;
        qualification={status:'failed',failedCase:item.id,reason:error.message};break;
      }
    }
    const processes=await observer.finish();terminal.retainPublic(processes.ref);const proof=nativeTerminal(terminal.finish()),snapshot=meterSnapshot(meter.snapshot());
    const ref=exclusive(join(input.directory,'native-app-terminal.json'),{version:2,binding:proof.binding,graph:proof.ref,snapshot,results,qualification,pending:0});return {ref};
  }finally{restore();delete process.env.S04_PROVIDER_TOKEN;process.removeListener('SIGTERM',terminate);process.removeListener('SIGINT',terminate);}
}
