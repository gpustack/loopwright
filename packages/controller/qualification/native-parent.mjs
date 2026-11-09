/* global process, Buffer, URL, setTimeout, clearTimeout */
import { generateKeyPairSync, sign } from 'node:crypto';
import { spawn, execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { claimReservationObservation, NativeLedger } from './native-ledger.mjs';
import { requireNativeActivation } from './native-activation.mjs';
import { leafClock, sealBridgeLeaf, readBridgeLeaf, reservationContext, assertLeafClock } from './native-bridge.mjs';
import { validateTerminalGraph, originalStream, verifyNativeParentEvidence } from './native-terminal.mjs';
import { parentTimeState, markParentTimeUnavailable } from './native-lock.mjs';
import { ParentLifecycle } from './lifecycle.mjs';
import { allowance } from './schedule.mjs';
import { validateNativeCase, validateNativeQualification } from './native-app.mjs';
import { canonical, sha, matchesExactAbsence, same, nonce, exclusive, checkedRef, readPrivate, localOwner, monotonic, privateDirectory, fail } from './native-context.mjs';
const observed = new WeakMap();
const unchanged=value=>value;
export function parentObservation(handle) { const value = observed.get(handle); if (!value) fail('QUALIFICATION_PARENT_OBSERVATION'); return value; }
/** One authentic parent handle, one owned pre-module child, one ticket. Native app entry remains unavailable. */
export class ObservationParent {
  #reservation; #keys; #started = false; #issued = false;
  constructor(handle, directory) {
    privateDirectory(directory); this.directory = directory; this.#reservation = claimReservationObservation(handle, 'child');
    if (!same(localOwner(), this.#reservation.entry.owner)) fail('QUALIFICATION_PARENT_ONLY');
    this.#keys = generateKeyPairSync('ed25519');
  }
  async start({acknowledge=true,probe='positive',transformBody=unchanged,transformWire=unchanged,recipeRef=null,activation=null} = {}) {
    if (this.#started) fail('QUALIFICATION_TICKET_REISSUE'); this.#started = true;
    const r=this.#reservation.entry, token=nonce(), fixture=fileURLToPath(new URL('./native-bootstrap.mjs',import.meta.url));
    const recipe=recipeRef?readBridgeLeaf(recipeRef):null;
    if(recipe){if(!same(reservationContext(recipe),r.context)||!same(recipe.caps,r.caps))fail('QUALIFICATION_TICKET_RECIPE');if(recipe.mode==='native'){requireNativeActivation(activation);if(this.#reservation.observationMode!=='native'||transformBody!==unchanged||transformWire!==unchanged||probe!=='positive'||!acknowledge)fail('QUALIFICATION_NATIVE_BOOTSTRAP');assertLeafClock(recipe.clock);}}
    else if(r.context.qualificationVersion!==undefined)fail('QUALIFICATION_TICKET_VERSION');
    const sourcePath=join(this.directory,'source-manifest.json'),sourceBytes=readPrivate(sourcePath),source={path:sourcePath,byteLength:sourceBytes.length,sha256:sha(sourceBytes)};
    const manifest = exclusive(join(this.directory,'bootstrap-manifest-'+token+'.json'),{version:recipe?2:1,mode:recipe?.mode??'offline',...(recipe?{recipe:recipeRef}:{}),nonce:token,parent:r.owner,reservationId:r.id,caps:r.caps,context:r.context,source,publicKey:this.#keys.publicKey.export({type:'spki',format:'der'}).toString('base64'),probe,ledger:this.#reservation.ledger});
    const intent=exclusive(join(this.directory,'bootstrap-intent-'+token+'.json'),{version:1,parent:r.owner,nonce:token,manifest,executable:process.execPath,fixture,fixtureSha256:sha((await import('node:fs')).readFileSync(fixture))});
    const child=spawn(process.execPath,[fixture,manifest.path,manifest.sha256,String(manifest.byteLength)],{env:{PATH:'/usr/bin:/bin:/usr/sbin',LANG:'C'},stdio:['pipe','pipe','pipe']});
    const record={version:1,nonce:token,parent:r.owner,reservationId:r.id,manifest,intent,pid:child.pid??null,hello:null,registration:null,wire:null,stdout:'',stderr:'',exit:null,error:null};
    let rejectHello;
    const close = new Promise(resolve=>{child.once('close',(code,signal)=>{record.exit={code,signal};resolve();});child.once('error',error=>{record.error=error.code??'SPAWN_FAILED';});});
    const hello = new Promise((resolve,reject)=>{
      rejectHello=reject;
      child.stdout.on('data',chunk=>{
        record.stdout+=chunk.toString();if(Buffer.byteLength(record.stdout)>32768){record.error='OUTPUT_LIMIT';reject(new Error(record.error));return;}
        const end=record.stdout.indexOf('\n');if(end<0||record.hello)return;
        try{const value=JSON.parse(record.stdout.slice(0,end));if(value.kind!=='bootstrap-hello'||value.nonce!==token||value.owner.pid!==child.pid||!same(localOwner(child.pid),value.owner)||!/^\w{32}$/.test(value.challenge))fail('QUALIFICATION_BOOTSTRAP_HELLO');record.hello=value;resolve(value);}catch(error){record.error=error.message;reject(error);}
      });
    });
    child.stderr.on('data',chunk=>{record.stderr+=chunk.toString();if(Buffer.byteLength(record.stderr)>8192)record.error='OUTPUT_LIMIT';});
    child.once('close',()=>{if(!record.hello)rejectHello(new Error('QUALIFICATION_NO_HELLO'));});
    const kill=signal=>{try{if(record.hello&&!same(localOwner(child.pid),record.hello.owner))fail('QUALIFICATION_CHILD_IDENTITY');child.kill(signal);}catch(error){record.error=error.message;}};
    let workTimer;
    const timer=setTimeout(()=>{record.error='BOOTSTRAP_TIMEOUT';rejectHello(new Error(record.error));kill('SIGKILL');},5000);
    let hardTimer;
    try{
      await hello;
      if(recipe?.mode==='native'){
        clearTimeout(timer);assertLeafClock(recipe.clock);
        workTimer=setTimeout(()=>kill('SIGTERM'),Math.max(0,Number(BigInt(recipe.clock.workCutoff)-monotonic())));
        hardTimer=setTimeout(()=>{record.error='NATIVE_HARD_DEADLINE';kill('SIGKILL');},Math.max(0,Number(BigInt(recipe.clock.hardCutoff)-monotonic())));
      }
      record.registration=exclusive(join(this.directory,'bootstrap-registration-'+token+'.json'),{version:1,nonce:token,challenge:record.hello.challenge,parent:r.owner,child:record.hello.owner,reservationId:r.id,manifest});
      if(acknowledge){
        if(this.#issued)fail('QUALIFICATION_TICKET_REISSUE');this.#issued=true;
        const body=transformBody({version:recipe?2:1,nonce:token,challenge:record.hello.challenge,reservationId:r.id,parent:r.owner,child:record.hello.owner,caps:JSON.parse(canonical(r.caps)),context:JSON.parse(canonical(r.context)),...(recipe?{recipeDigest:r.context.recipeDigest}:{})});
        const wire=transformWire({body,signature:sign(null,Buffer.from(canonical(body)),this.#keys.privateKey).toString('base64'),registration:record.registration});
        record.wire=exclusive(join(this.directory,'bootstrap-ack-'+token+'.json'),wire);
        child.stdin.end(canonical(wire)+'\n');
      }else child.stdin.end();
      await close;
    }catch(error){record.error??=error.message;child.stdin.end();await close;}
    finally{clearTimeout(timer);clearTimeout(workTimer);clearTimeout(hardTimer);record.observed=exclusive(join(this.directory,'bootstrap-exit-'+token+'.json'),record);}
    // These are original observations. Error/no-ACK never creates a new meter, retries or refunds capacity.
    const rows=record.stdout.trim()?record.stdout.trim().split('\n').map(line=>JSON.parse(line)):[];
    record.frames=rows;
    const app=rows.find(row=>row.kind==='bootstrap-observation');
    const nativeApp=rows.find(row=>row.kind==='bootstrap-native-terminal');
    if(recipe?.mode==='native'&&nativeApp&&record.exit?.code===0&&record.exit.signal===null&&!record.error&&!record.stderr){
      requireNativeActivation(activation);
      const data=JSON.parse(checkedRef(nativeApp.ref)),binding=data.binding,executedCases=validateNativeQualification(recipe,data);
      if(data.version!==2||data.pending!==0||binding.reservationId!==r.id||binding.recipeDigest!==r.context.recipeDigest||!same(binding.owner,record.hello.owner)||!same(binding.subjects.map(item=>item.runId),executedCases.map(item=>item.runId)))fail('QUALIFICATION_NATIVE_TERMINAL');
      const roots=[this.directory,...recipe.cases.map(item=>item.runRoot)],graph=validateTerminalGraph(data.graph,binding,roots);
      const processRef=graph.refs.find(ref=>ref.path.endsWith('/process-observation-final.json'));if(!processRef)fail('QUALIFICATION_NATIVE_TERMINAL');
      const processes=JSON.parse(checkedRef(processRef));if(processes.pending||processes.unknown||processes.records.length>512)fail('QUALIFICATION_NATIVE_TERMINAL');
      for(const process of processes.records){if(!process.owner||process.owner.boot!==record.hello.owner.boot||!process.exit||process.unknown)fail('QUALIFICATION_NATIVE_TERMINAL');originalStream(process,'stdout');originalStream(process,'stderr');}
      if(data.snapshot.reservationId!==r.id||!Array.isArray(data.snapshot.trace)||data.snapshot.trace.length>1024)fail('QUALIFICATION_NATIVE_TERMINAL');
      for(const key of ['provider','mcp','containers'])if(!Number.isSafeInteger(data.snapshot.actual[key])||data.snapshot.actual[key]<0||data.snapshot.actual[key]>r.caps[key]||data.snapshot.trace.filter(row=>row.kind===key).length!==data.snapshot.actual[key])fail('QUALIFICATION_NATIVE_TERMINAL');
      if(processes.records.filter(row=>row.kind==='create').length!==data.snapshot.actual.containers)fail('QUALIFICATION_NATIVE_TERMINAL');
      for(const item of executedCases){
        const ref=data.results.find(ref=>ref.path.endsWith('/case-'+item.id+'.json'));if(!ref||!graph.refs.some(leaf=>same(leaf,ref)))fail('QUALIFICATION_NATIVE_TERMINAL');const value=JSON.parse(checkedRef(ref));let failure=null;
        try{if(!value.resume)fail('QUALIFICATION_NATIVE_CASE');validateNativeCase(item,value.outcome,value.snapshot,value.observations,value.delta,value.resume);}catch(error){failure=error.message;}
        if(failure!==(data.qualification.failedCase===item.id?data.qualification.reason:null))fail('QUALIFICATION_NATIVE_CASE');
      }
      const independent=verifyNativeParentEvidence({...recipe,cases:executedCases},data,graph),caseRefs=[];
      for(const item of independent.cases)caseRefs.push(exclusive(join(this.directory,'native-parent-case-'+item.id+'-'+token+'.json'),item));
      const independentRef=exclusive(join(this.directory,'native-parent-counter-'+token+'.json'),{scope:independent.scope,counters:independent.counters,cases:caseRefs});
      const pids=[...new Set(processes.records.map(row=>row.pid))];let absence={argv:[],exit:1,stdout:'',stderr:''};
      if(pids.length){const args=['-p',pids.join(','),'-o','pid=,lstart='];try{absence={argv:['/bin/ps',...args],exit:0,stdout:execFileSync('/bin/ps',args,{encoding:'utf8',timeout:2000,maxBuffer:32768,env:{PATH:'/usr/bin:/bin:/usr/sbin',LANG:'C'}}),stderr:''};}catch(error){absence={argv:['/bin/ps',...args],exit:error.status,stdout:error.stdout??'',stderr:error.stderr??''};}}
      const absenceRef=exclusive(join(this.directory,'native-descendant-absence-'+token+'.json'),absence);
      if(absence.exit!==1||absence.stdout!==''||absence.stderr!=='')fail('QUALIFICATION_NATIVE_TERMINAL');
      const proof=Object.freeze({});observed.set(proof,{reservation:this.#reservation,record:JSON.parse(canonical(record)),snapshot:data.snapshot,nativeGraph:{ref:data.graph,binding,roots,recipe:recipeRef},additionalRefs:[nativeApp.ref,absenceRef,recipeRef,independentRef,...caseRefs]});record.proof=proof;record.qualification=data.qualification;
    }
    if(record.exit?.code===0&&record.exit.signal===null&&!record.error&&!record.stderr&&app&&recipe?.mode!=='native'){
      if(app.reservationId!==r.id||!same(app.context,r.context)||!same(app.caps,r.caps)||!Array.isArray(app.snapshot.trace)||app.snapshot.trace.length>1024)fail('QUALIFICATION_CHILD_OBSERVATION');
      for(const key of ['provider','mcp','containers'])if(!Number.isSafeInteger(app.snapshot.actual[key])||app.snapshot.actual[key]<0||app.snapshot.actual[key]>r.caps[key]||app.snapshot.trace.filter(row=>row.kind===key).length!==app.snapshot.actual[key])fail('QUALIFICATION_CHILD_OBSERVATION');
      if(app.snapshot.reservationId!==r.id||app.pending!==0||app.services!==0||app.containers!==0)fail('QUALIFICATION_CHILD_CLEANUP');
      const proof=Object.freeze({});observed.set(proof,{reservation:this.#reservation,record:JSON.parse(canonical(record)),snapshot:JSON.parse(canonical(app.snapshot))});record.proof=proof;
    }
    return record;
  }
}
/** Pure terminal validator for later native preparation; no process, daemon, service or ledger mutation. */
export function verifyOwnedTerminal(input) {
  if(input.pending!==0||!Array.isArray(input.children)||!Array.isArray(input.containers)||!Array.isArray(input.services))fail('QUALIFICATION_TERMINAL_UNKNOWN');
  for(const child of input.children)if(!child.registered||!child.owner?.birth||!child.owner?.boot||!child.exit||child.exit.signal!==null||child.exit.code!==0)fail('QUALIFICATION_TERMINAL_EXIT');
  for(const c of input.containers)if(!same(c.intent,c.identity)||!c.attach?.birth||!c.attach?.boot||!c.attach.exit||c.running!==false||c.removed!==true||c.cli?.code!==0||c.cli?.signal!==null||!matchesExactAbsence(c.absence,c.id))fail('QUALIFICATION_TERMINAL_CLEANUP');
  for(const service of input.services)if(!service.closed||!service.portAbsent||service.pending!==0)fail('QUALIFICATION_TERMINAL_SERVICE');
  for(const ref of input.refs)checkedRef(ref);return true;
}
export function preparedNativeParent(activation,input){requireNativeActivation(activation);return runPreparedNativeParent(activation,input);}
export async function runPreparedNativeParent(activation,input){
  requireNativeActivation(activation);
  const started=monotonic();let ledger;
  try{ledger=new NativeLedger(input.budget,()=>{},activation);}catch(error){markParentTimeUnavailable(input.budget);throw error;}
  const time=ledger.beginHeldParentTime(activation,{directory:input.directory,phase:input.phase,leaf:input.leaf},started),record=parentTimeState(time);
  let result=null,failure=null,failureObservation=null,handle=null,intent=null,effectiveRecipe=input.recipe??null;
  try{
    privateDirectory(input.directory);
    intent=exclusive(join(input.directory,'native-parent-intent-'+record.record.id+'.json'),{version:3,commandId:record.record.id,owner:localOwner(),recipe:input.recipe??null,pending:record.pending,started:String(started)});
    if(input.preparedTemplate){const template=JSON.parse(checkedRef(input.preparedTemplate)),available=allowance(JSON.parse(readPrivate(input.budget)).native,input.phase,input.leaf,120);effectiveRecipe=sealBridgeLeaf(input.directory,{...template,clock:leafClock(String(started),available)}).ref;}
    const recipe=readBridgeLeaf(effectiveRecipe);if(recipe.mode!=='native'||recipe.leaf!==input.leaf)fail('QUALIFICATION_STATIC_NATIVE');assertLeafClock(recipe.clock);
    const before=readPrivate(input.budget);if(sha(before)!==input.expectedBudgetSha256)fail('QUALIFICATION_ORIGIN');
    if(!JSON.parse(before).qualificationReservations)ledger.migrateHeldNative(activation,input.origin);
    const available=allowance(ledger.read().native,input.phase,recipe.leaf,120);if(available*1000<Number(BigInt(recipe.clock.hardCutoff)-monotonic()))fail('QUALIFICATION_LIMIT');
    handle=ledger.reserve(reservationContext(recipe),recipe.caps);
    result=await new ObservationParent(handle,input.directory).start({recipeRef:effectiveRecipe,activation});
    if(!result.proof||monotonic()>BigInt(recipe.clock.hardCutoff))fail('QUALIFICATION_NATIVE_TERMINAL');
  }catch(error){failure=error.message;failureObservation=error.observation??null;}
  // The shared pending obligation predates all recipe/path/budget preparation. Never use another receipt path.
  const timed=ledger.completeParentTime(time,{intent,exit:result?.exit??null,error:failure,errorObservation:failureObservation,recipe:effectiveRecipe});
  if(failure)fail(failure);
  const proof=new ParentLifecycle(handle,input.directory).sealObserved(result.proof);ledger.settle(handle,proof);return {version:3,qualification:result.qualification,receipt:timed.receipt,timeAck:timed.ack,proof:ledger.read().qualificationReservations.entries.find(row=>row.id===handle.id).seal};
}
