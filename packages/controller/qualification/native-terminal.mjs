/* global Buffer */
import { dirname, join, resolve, relative, isAbsolute } from 'node:path';
import { existsSync, realpathSync } from 'node:fs';
import { Server } from 'node:http';
import { canonical, sha, matchesExactAbsence, same, closed, checkedRef, readPrivate, exclusive, privateDirectory, localOwner, fail } from './native-context.mjs';
import { requireNativeAppActivation } from './native-activation.mjs';
import { processEvidence } from './native-observation.mjs';
import { reopenLocalRun } from '@loopwright/state';
import { bindSubject, validateDocument } from '@loopwright/core';
import { readPublicSnapshot } from './native-preload.mjs';
import { PROVIDER_URL } from './native-guards.mjs';
import { stockCreateArguments } from './native-container.mjs';

const removals=new WeakMap(),terminals=new WeakMap();
export function nativeRemoval(handle){const value=removals.get(handle);if(!value)fail('QUALIFICATION_NATIVE_REMOVAL');return value;}
export function nativeTerminal(handle){const value=terminals.get(handle);if(!value)fail('QUALIFICATION_NATIVE_TERMINAL');return value;}
export function fullReferences(value,output=[]){
  if(!value||typeof value!=='object')return output;
  if(!Array.isArray(value)&&same(Object.keys(value).sort(),['byteLength','path','sha256'])){output.push(value);return output;}
  for(const child of Object.values(value))fullReferences(child,output);return output;
}
function allowed(path,roots){const target=resolve(path);return realpathSync(path)===target&&roots.some(root=>{const r=relative(resolve(root),target);return r!==''&&!r.startsWith('..')&&!isAbsolute(r);});}
/** Bounded data graph. Successful validation does not issue native proof. */
export function writeTerminalGraph(directory,binding,refs){
  privateDirectory(directory);if(!Array.isArray(refs)||refs.length>4032)fail('QUALIFICATION_TERMINAL_LIMIT');
  const unique=new Set();for(const ref of refs){checkedRef(ref);if(unique.has(ref.path))fail('QUALIFICATION_TERMINAL_DUPLICATE');unique.add(ref.path);}
  const shards=[];
  for(let offset=0;offset<refs.length;offset+=64)shards.push(exclusive(join(directory,'terminal-index-'+offset+'.json'),{version:1,binding,refs:refs.slice(offset,offset+64)}));
  if(shards.length>64||shards.length+refs.length>4096)fail('QUALIFICATION_TERMINAL_LIMIT');
  return exclusive(join(directory,'terminal-index-root.json'),{version:1,binding,shards});
}
export function validateTerminalGraph(rootRef,expected,roots){
  const root=JSON.parse(checkedRef(rootRef));closed(root,['version','binding','shards']);
  if(root.version!==1||!same(root.binding,expected)||!Array.isArray(root.shards)||root.shards.length>64||!allowed(rootRef.path,roots))fail('QUALIFICATION_TERMINAL_GRAPH');
  const seen=new Map([[rootRef.path,rootRef]]),leaves=[];
  for(const ref of root.shards){
    if(seen.has(ref.path)||!allowed(ref.path,roots))fail('QUALIFICATION_TERMINAL_DUPLICATE');seen.set(ref.path,ref);
    const shard=JSON.parse(checkedRef(ref));closed(shard,['version','binding','refs']);
    if(shard.version!==1||!same(shard.binding,expected)||!Array.isArray(shard.refs)||shard.refs.length>64)fail('QUALIFICATION_TERMINAL_GRAPH');
    for(const leaf of shard.refs){if(seen.has(leaf.path)||!allowed(leaf.path,roots))fail('QUALIFICATION_TERMINAL_DUPLICATE');checkedRef(leaf);seen.set(leaf.path,leaf);leaves.push(leaf);}
  }
  if(seen.size-1>4096)fail('QUALIFICATION_TERMINAL_LIMIT');
  for(const ref of leaves)if(ref.path.endsWith('.json')){
    const original=JSON.parse(checkedRef(ref));for(const nested of fullReferences(original))if(!same(seen.get(nested.path),nested))fail('QUALIFICATION_TERMINAL_DETACHED');
    if(original.kind==='original-artifact'){
      if(original.byteLength>8388608||original.chunks.length>8)fail('QUALIFICATION_TERMINAL_LIMIT');
      const bytes=Buffer.concat(original.chunks.map(chunk=>checkedRef(chunk)));if(bytes.length!==original.byteLength||sha(bytes)!==original.sha256)fail('QUALIFICATION_STREAM_PROOF');
    }
  }
  return {binding:root.binding,refs:leaves,nestedRefs:seen.size-1};
}
export function originalStream(record,stream){
  const refs=record[stream+'Chunks'];if(!Array.isArray(refs)||refs.length>8)fail('QUALIFICATION_STREAM_PROOF');
  const body=Buffer.concat(refs.map(ref=>checkedRef(ref)));
  if(body.length!==record[stream+'Bytes']||sha(body)!==record[stream+'Sha256'])fail('QUALIFICATION_STREAM_PROOF');return body;
}
export function validateRemovalData(input){
  if(!input||!/^\w{32}$/.test(input.nonce)||!/^[a-f0-9]{64}$/.test(input.id)||input.identity?.nonce!==input.nonce||input.running!==false||input.removed!==true
    ||input.cli?.code!==0||input.cli?.signal!==null||!matchesExactAbsence(input.absence,input.id)
    ||!input.attach?.birth||!input.attach?.boot||input.attach.exit?.code!==0||input.attach.exit?.signal!==null)fail('QUALIFICATION_CLEANUP_UNKNOWN');return true;
}
function streamResult(record){return {code:record.exit?.code,signal:record.exit?.signal,stdout:originalStream(record,'stdout').toString(),stderr:originalStream(record,'stderr').toString()};}
function ownRef(path){const bytes=readPrivate(path);return {path,byteLength:bytes.length,sha256:sha(bytes)};}

/** Only an activated original event observer can mint native removal or terminal brands. No parsed-record factory. */
export class NativeTerminalObserver {
  #refs=new Map();#removed=new Set();#leases=new Map();#subjects=new Map();#services=[];
  constructor(activation,observer,meter,directory,binding){
    requireNativeAppActivation(activation);privateDirectory(directory);
    const actual=processEvidence(observer);
    if(actual.mode!=='native'||actual.reservationId!==binding.reservationId||actual.recipeDigest!==binding.recipeDigest)fail('QUALIFICATION_NATIVE_OBSERVER');
    this.observer=observer;this.meter=meter;this.directory=directory;this.binding=JSON.parse(canonical(binding));this.owner=localOwner();
  }
  #retain(ref,depth=0){
    const bytes=checkedRef(ref),old=this.#refs.get(ref.path);if(old){if(!same(old,ref))fail('QUALIFICATION_TERMINAL_CHANGED');return;}
    if(depth>64||this.#refs.size>=4032)fail('QUALIFICATION_TERMINAL_LIMIT');this.#refs.set(ref.path,ref);
    if(ref.path.endsWith('.json'))for(const nested of fullReferences(JSON.parse(bytes)))this.#retain(nested,depth+1);
  }
  retainPublic(ref){this.#retain(ref);}
  retainArtifact(path,byteLength,digest){
    const bytes=readPrivate(path,8388608);if(bytes.length!==byteLength||sha(bytes)!==digest)fail('QUALIFICATION_PUBLIC_ARTIFACT');
    const packetPath=join(this.directory,'artifact-'+sha(path+'\0'+digest)+'.json');if(this.#refs.has(packetPath))return;
    const chunks=[];for(let offset=0;offset<bytes.length;offset+=1048576){const part=join(this.directory,'artifact-'+digest+'-'+offset+'.bin'),ref=this.#refs.get(part)??exclusive(part,bytes.subarray(offset,offset+1048576));this.#retain(ref);chunks.push(ref);}
    this.#retain(exclusive(packetPath,{version:1,kind:'original-artifact',originalPath:path,byteLength,sha256:digest,chunks}));
  }
  captureLease(registration,entry){
    if(entry.kind==='preflight')return;
    const c=registration.context,artifactRoot=join(dirname(registration.descriptorRef.path),'artifacts'),path=join(artifactRoot,'pi-execution-'+sha(canonical({storeId:c.identity.storeId,runId:c.runId}))+'.ndjson');
    const bytes=readPrivate(path);if(bytes.at(-1)!==10)fail('QUALIFICATION_STOCK_LEASE');
    const rows=bytes.toString().slice(0,-1).split('\n').map(row=>JSON.parse(row)),first=rows[0];
    if(first?.type!=='owner'||first.version!==2||!same({pid:first.pid,birth:first.birth,boot:first.boot},this.owner)||first.storeId!==c.identity.storeId||first.runId!==c.runId||!same(first.lockHash,c.identity.lockHash)||!same(first.clockBasis,c.basis)||first.authority.ownerId!==c.owner.id||first.authority.generation!==c.owner.generation||first.daemon.socket!==c.socket)fail('QUALIFICATION_STOCK_LEASE');
    const digest=sha(bytes),archive=join(this.directory,'lease-'+digest+'.bin'),ref=this.#refs.get(archive)??exclusive(archive,bytes);this.#retain(ref);
    this.#subjects.set(c.runId,{runId:c.runId,storeId:c.identity.storeId,lockHash:c.identity.lockHash,basis:c.basis,owner:c.owner});
    for(const row of rows)if(row.type==='attach')this.#leases.set(row.nonce,{ref,rows,owner:first});
  }
  flushRemovals(){
    const data=processEvidence(this.observer);if(data.unknown)fail('QUALIFICATION_PROCESS_UNKNOWN');
    for(const created of data.records.filter(row=>row.kind==='create'&&row.entry.identity)){
      const identity=created.entry.identity;if(this.#removed.has(identity.nonce))continue;
      const home=dirname(created.entry.intent.path),cleanupPath=join(home,'cleanup.json');if(!existsSync(cleanupPath))continue;
      const idRef=ownRef(join(home,'container-id.json')),cleanupRef=ownRef(cleanupPath),id=JSON.parse(checkedRef(idRef)),cleanup=JSON.parse(checkedRef(cleanupRef));
      const matches=data.records.filter(row=>row.entry.identity?.nonce===identity.nonce),attach=matches.find(row=>row.kind==='start'),rm=matches.find(row=>same(row.argv.slice(4),['rm',id.id])&&row.exit?.code===0),absent=matches.filter(row=>same(row.argv.slice(4),['inspect',id.id])&&row.exit?.code===1).at(-1);
      const stopped=matches.filter(row=>same(row.argv.slice(4),['inspect',id.id])&&row.exit?.code===0).map(row=>({row,value:JSON.parse(originalStream(row,'stdout'))[0]})).findLast(item=>item.value.State.Running===false);
      const lease=this.#leases.get(identity.nonce),leaseAttach=lease?.rows.find(row=>row.type==='attach'&&row.nonce===identity.nonce),leaseChild=lease?.rows.find(row=>row.type==='child'&&row.nonce===identity.nonce);
      if(!attach?.owner||!attach.exit||!rm||!absent||!stopped||!leaseAttach||!same(leaseChild&&{name:leaseChild.name,nonce:leaseChild.nonce,labels:leaseChild.labels,image:leaseChild.image},identity)||leaseAttach.pid!==attach.pid||leaseAttach.birth!==attach.owner.birth)fail('QUALIFICATION_STOCK_ATTACH');
      if(id.nonce!==identity.nonce||cleanup.id!==id.id||cleanup.removed!==true||stopped.value.Id!==id.id||stopped.value.Image!==identity.image||stopped.value.Name!=='/'+identity.name||!same(stopped.value.Config.Labels,identity.labels))fail('QUALIFICATION_STOCK_CLEANUP');
      const value={nonce:identity.nonce,id:id.id,identity,running:stopped.value.State.Running,removed:true,cli:rm.exit,absence:streamResult(absent),attach:{...attach.owner,exit:attach.exit}};validateRemovalData(value);
      for(const ref of [created.entry.intent,idRef,cleanupRef,lease.ref])this.#retain(ref);
      const proof=Object.freeze({});removals.set(proof,{...value,reservationId:this.binding.reservationId,recipeDigest:this.binding.recipeDigest});this.meter.removed(proof);this.#removed.add(identity.nonce);
    }
  }
  observeService(server,intent){
    if(!(server instanceof Server))fail('QUALIFICATION_SERVICE_UNKNOWN');
    const value={server,intent,sockets:new Set(),closed:false,listening:null,absence:null};this.#services.push(value);this.#retain(intent);
    server.once('listening',()=>{value.listening=server.address();});server.on('connection',socket=>{value.sockets.add(socket);socket.once('close',()=>value.sockets.delete(socket));});server.once('close',()=>{value.closed=true;});return value;
  }
  observePortAbsence(service,record){
    const original=processEvidence(this.observer).records.find(row=>row.nonce===record.nonce);
    if(!original||original.entry.executable!=='/usr/sbin/lsof'||!same(original.argv,['-nP','-iTCP:'+service.listening?.port,'-sTCP:LISTEN','-Fpn']))fail('QUALIFICATION_SERVICE_UNKNOWN');
    const result=streamResult(original);if(!service.closed||service.server.listening||service.sockets.size||result.code!==1||result.signal!==null||result.stdout!==''||result.stderr!=='')fail('QUALIFICATION_SERVICE_UNKNOWN');service.absence=original.observed;
  }
  finish(){
    this.flushRemovals();const data=processEvidence(this.observer);
    if(data.mode!=='native'||data.pending||data.unknown||data.records.some(row=>!row.owner||!row.exit||!row.observed)||data.records.filter(row=>row.kind==='create').some(row=>!this.#removed.has(row.entry.identity.nonce))||this.#services.some(value=>!value.closed||value.sockets.size||!value.absence))fail('QUALIFICATION_TERMINAL_UNKNOWN');
    for(const ref of fullReferences(data))this.#retain(ref);
    for(const service of this.#services)this.#retain(service.absence);
    const binding={...this.binding,owner:this.owner,subjects:[...this.#subjects.values()]},ref=writeTerminalGraph(this.directory,binding,[...this.#refs.values()]);
    const handle=Object.freeze({});terminals.set(handle,{binding,ref,actualProcesses:data.records.length,streamBytes:data.streamBytes});return handle;
  }
}

function parentNeed(condition,code,observation=null){if(!condition){const error=new Error(code);error.observation=observation;throw error;}}
function graphBytes(ref,graph){parentNeed(graph.refs.some(row=>same(row,ref)),'QUALIFICATION_PARENT_DETACHED',ref);return checkedRef(ref);}
function immutableRequest(row){return {sequence:row.sequence,admission:row.admission,admissionDigest:row.admissionDigest,admissionGeneration:row.admissionGeneration,dispatch:row.dispatch};}
/** Original event bijection, not a set of payload hashes and never a proof-branding factory. */
export function verifyReceiverTrace(recipe,data,graph){
  const trace=data.snapshot.trace,actual=data.snapshot.actual;
  parentNeed(Array.isArray(trace)&&trace.length<=1024&&trace.every((row,index)=>row.ordinal===index+1&&['provider','mcp','containers','container-start'].includes(row.kind)),'QUALIFICATION_PARENT_TRACE');
  parentNeed(actual.mcp===0&&!trace.some(row=>row.kind==='mcp'),'QUALIFICATION_PARENT_MCP');
  const providers=trace.filter(row=>row.kind==='provider'),events=[],requests=new Set();
  for(const item of recipe.cases){
    const caseRef=data.results.find(ref=>ref.path.endsWith('/case-'+item.id+'.json'));parentNeed(caseRef,'QUALIFICATION_PARENT_CASE');
    const saved=JSON.parse(graphBytes(caseRef,graph)),closed=JSON.parse(graphBytes(saved.service,graph)),intent=JSON.parse(graphBytes(closed.intent,graph)),listening=JSON.parse(graphBytes(closed.listening,graph)),directory=dirname(saved.service.path);
    parentNeed(saved.id===item.id&&closed.caseId===item.id&&intent.caseId===item.id&&listening.caseId===item.id&&closed.nonce===intent.nonce&&closed.nonce===listening.nonce&&same(closed.owner,data.binding.owner)&&same(intent.owner,closed.owner)&&same(listening.owner,closed.owner)&&same(listening.intent,closed.intent)&&intent.sourceDigest===recipe.sourceDigest,'QUALIFICATION_PARENT_SERVICE');
    parentNeed(saved.service.path===join(directory,'provider-closed-'+closed.nonce+'.json')&&closed.intent.path===join(directory,'provider-intent-'+closed.nonce+'.json')&&closed.listening.path===join(directory,'provider-listening-'+closed.nonce+'.json')&&intent.bind==='127.0.0.1'&&listening.address.address==='127.0.0.1'&&Number.isSafeInteger(listening.address.port)&&listening.address.port>0&&listening.address.port<=65535,'QUALIFICATION_PARENT_SERVICE');
    parentNeed(closed.pending===0&&closed.unknown===false&&closed.ownListenerClosed===true&&Array.isArray(closed.records)&&closed.records.length===closed.received&&closed.received<=64,'QUALIFICATION_PARENT_RECEIVER');
    const dispatched=saved.snapshot.records.requests.filter(row=>row.dispatch!==null);parentNeed(dispatched.length===closed.received&&saved.delta.provider===closed.received,'QUALIFICATION_PARENT_RECEIVER');
    for(let index=0;index<closed.records.length;index++){
      const row=closed.records[index],subject=JSON.parse(graphBytes(row.subject,graph)),request=subject.request,expected=dispatched[index],ordinal=index+1;
      parentNeed(row.ordinal===ordinal&&row.authorized===true&&row.inputBytes===row.request.byteLength&&row.request.path===join(directory,'provider-request-'+closed.nonce+'-'+ordinal+'.bin')&&row.subject.path===join(directory,'provider-subject-'+closed.nonce+'-'+ordinal+'.json'),'QUALIFICATION_PARENT_EVENT');
      const body=graphBytes(row.request,graph);parentNeed(subject.caseId===item.id&&subject.runId===item.runId&&same(subject.snapshot.close,{ok:true,value:{closed:true}})&&subject.snapshot.view.runId===item.runId&&request.state==='dispatch_authorized'&&request.dispatch!==null&&same(immutableRequest(request),immutableRequest(expected)),'QUALIFICATION_PARENT_ATTEMPT');
      parentNeed(subject.snapshot.records.requests.some(candidate=>same(candidate,request)),'QUALIFICATION_PARENT_ATTEMPT');
      const key=item.id+'\0'+request.admission.attemptId+'\0'+request.admission.requestId;
      parentNeed(!requests.has(key),'QUALIFICATION_PARENT_DUPLICATE');requests.add(key);
      const entry=providers[events.length],digest=sha(canonical({route:PROVIDER_URL,body:sha(body),bytes:body.length}));parentNeed(entry&&entry.digest===digest,'QUALIFICATION_PARENT_COUNTER');
      events.push({caseId:item.id,attemptId:request.admission.attemptId,requestId:request.admission.requestId,requestSequence:request.sequence,eventOrdinal:ordinal,traceOrdinal:entry.ordinal,request:row.request,subject:row.subject});
    }
  }
  parentNeed(events.length===actual.provider&&events.length===providers.length,'QUALIFICATION_PARENT_COUNTER');
  const processRef=graph.refs.find(ref=>ref.path.endsWith('/process-observation-final.json'));parentNeed(processRef,'QUALIFICATION_PARENT_PROCESS');
  const processes=JSON.parse(graphBytes(processRef,graph));parentNeed(!processes.pending&&!processes.unknown&&processes.records.length<=512,'QUALIFICATION_PARENT_PROCESS');
  let streamBytes=0;const creates=[],starts=[];
  for(const record of processes.records){
    parentNeed(record.owner&&record.exit&&record.unknown===null,'QUALIFICATION_PARENT_PROCESS');
    for(const stream of ['stdout','stderr']){const body=originalStream(record,stream);parentNeed(body.length<=(stream==='stdout'?8388608:1048576),'QUALIFICATION_STREAM_PROOF');streamBytes+=body.length;}
    if(!['create','start'].includes(record.kind))continue;
    const item=recipe.cases.find(item=>item.id===record.entry.caseId),identity=record.entry.identity,intent=JSON.parse(graphBytes(record.entry.intent,graph));
    parentNeed(item&&record.entry.runId===item.runId&&identity.labels['org.loopwright.run']===item.runId&&identity.image===recipe.image&&same(identity,{name:intent.name,nonce:intent.nonce,labels:intent.labels,image:intent.image})&&same(record.argv,record.entry.argv),'QUALIFICATION_PARENT_PROCESS_IDENTITY');
    const original=JSON.parse(graphBytes(record.intent,graph)),registered=JSON.parse(graphBytes(record.registered,graph));
    parentNeed(original.argvSha256===sha(canonical(record.argv))&&same(original.identity,identity)&&same(original.originalIntent,record.entry.intent)&&same(original.parent,data.binding.owner)&&same(registered.owner,record.owner)&&same(registered.parent,data.binding.owner)&&same(registered.intent,record.intent),'QUALIFICATION_PARENT_PROCESS_EVENT');
    const home=dirname(record.entry.intent.path),idRef=graph.refs.find(ref=>ref.path===join(home,'container-id.json'));parentNeed(idRef,'QUALIFICATION_PARENT_PROCESS_IDENTITY');
    const id=JSON.parse(graphBytes(idRef,graph));parentNeed(id.nonce===identity.nonce&&/^[a-f0-9]{64}$/.test(id.id)&&same(record.argv.slice(0,4),['--config',join(home,'docker-client'),'--host','unix://'+recipe.socket]),'QUALIFICATION_PARENT_PROCESS_IDENTITY');
    if(record.kind==='create'){
      parentNeed(record.exit.code===0&&record.exit.signal===null&&originalStream(record,'stdout').toString().trim()===id.id,'QUALIFICATION_PARENT_RETURN_ID');
      const caseRef=data.results.find(ref=>ref.path.endsWith('/case-'+item.id+'.json')),saved=JSON.parse(graphBytes(caseRef,graph)),progresses=saved.snapshot.records.checkpoints.filter(cp=>cp.additionalArtifacts.length===4),session=identity.labels['org.loopwright.session'];let expectedCandidate=null;
      for(const cp of progresses){const ref=cp.additionalArtifacts[0];const packet=findOriginalArtifact(item,ref,graph);let progress;try{progress=JSON.parse(packet);}catch{continue;}const attempt=progress.attempts?.find(row=>row.sessionId===session&&home.startsWith(join(item.runRoot,item.runId,'runtime',row.id)+'/'));if(attempt){expectedCandidate=join(item.runRoot,item.runId,'runtime',attempt.id,'sdk-'+session,'candidate');break;}}
      parentNeed(expectedCandidate!==null&&same(record.argv.slice(4),stockCreateArguments({name:intent.name,nonce:intent.nonce,labels:intent.labels,image:intent.image},expectedCandidate,intent.labels['org.loopwright.role']??'sdk')),'QUALIFICATION_PARENT_PROCESS_ARGUMENTS');creates.push(identity);
    }else{parentNeed(same(record.argv.slice(4),['start','--attach','--interactive',id.id]),'QUALIFICATION_PARENT_PROCESS_ARGUMENTS');starts.push(identity);}
  }
  parentNeed(streamBytes<=67108864,'QUALIFICATION_STREAM_PROOF');
  for(const [kind,identities] of [['containers',creates],['container-start',starts]]){const rows=trace.filter(row=>row.kind===kind);parentNeed(rows.length===identities.length&&rows.every((row,index)=>row.digest===sha(canonical(identities[index]))),'QUALIFICATION_PARENT_COUNTER');}
  parentNeed(creates.length===actual.containers,'QUALIFICATION_PARENT_COUNTER');return {receiverEvents:events,creates:creates.length,starts:starts.length,streamBytes};
}
function artifactPath(item,ref){parentNeed(ref&&/^[a-z0-9.-]{1,128}$/.test(ref.name)&&ref.digest?.algorithm==='sha256'&&Number.isSafeInteger(ref.byteLength)&&ref.byteLength>=0&&ref.byteLength<=8388608,'QUALIFICATION_PARENT_ARTIFACT');return join(item.runRoot,item.runId,'artifacts',ref.name);}
export function findOriginalArtifact(item,ref,graph){
  const path=artifactPath(item,ref),packets=[];
  for(const entry of graph.refs)if(entry.path.endsWith('.json')&&entry.path.split('/').at(-1).startsWith('artifact-')){const packet=JSON.parse(checkedRef(entry));if(packet.kind==='original-artifact'&&packet.originalPath===path)packets.push(packet);}
  parentNeed(packets.length===1,'QUALIFICATION_PARENT_ARTIFACT',ref);const packet=packets[0];
  parentNeed(packet.byteLength===ref.byteLength&&packet.sha256===ref.digest.hex&&packet.chunks.length<=8,'QUALIFICATION_PARENT_ARTIFACT');
  const bytes=Buffer.concat(packet.chunks.map(chunk=>graphBytes(chunk,graph))),original=readPrivate(path,8388608);
  parentNeed(bytes.length===ref.byteLength&&sha(bytes)===ref.digest.hex&&bytes.equals(original),'QUALIFICATION_PARENT_ARTIFACT');return bytes;
}
function comparableView(view){return {storeId:view.storeId,runId:view.runId,lockHash:view.lockHash,identityDigest:view.identityDigest,startedAtMs:view.startedAtMs,deadlineMs:view.deadlineMs,revision:view.revision,owner:view.owner,policy:view.policy,binding:view.binding,clockStatus:view.clockStatus,basis:view.clock.basis,ledger:view.ledger,counts:view.counts};}
/** Read original files and the actual public store without claiming, renewing or adopting any owner. */
export function verifyOriginalCase(item,saved,graph){
  const descriptor=JSON.parse(graphBytes(saved.descriptor,graph)),configuration={configPath:item.config.path,registryPath:item.registry.path,registrySha256:item.registry.sha256};
  parentNeed(saved.id===item.id&&descriptor.identity.lock.spec.runId===item.runId&&descriptor.repository===item.repository&&same(descriptor.configuration,configuration)&&same(descriptor.identity.lock.spec.contract,JSON.parse(checkedRef(item.config)).spec.task),'QUALIFICATION_PARENT_CASE');
  const execution=saved.outcome.value;parentNeed(saved.outcome.ok&&['result','incident'].includes(execution.kind)&&(execution.kind==='result'?execution.observations!==null:!!saved.observationsRef)&&same(saved.snapshot.close,{ok:true,value:{closed:true}}),'QUALIFICATION_PARENT_CASE');
  const observationsRef=execution.kind==='result'?execution.observations:saved.observationsRef,observedBytes=findOriginalArtifact(item,observationsRef,graph),observations=JSON.parse(observedBytes);
  parentNeed(same(observations,saved.observations)&&observedBytes.equals(Buffer.from(canonical(observations))),'QUALIFICATION_PARENT_CASE_OBSERVATIONS');
  const opened=reopenLocalRun(descriptor.identity),result={opened:opened.ok?{ok:true,value:{opaqueStore:true}}:opened,current:null,close:null};
  parentNeed(opened.ok,'QUALIFICATION_PARENT_STATE',result);
  try{result.current=readPublicSnapshot(opened.value);}finally{result.close=opened.value.close();}
  parentNeed(same(result.close,{ok:true,value:{closed:true}}),'QUALIFICATION_PARENT_STATE_CLOSE',result);
  const current=result.current;
  parentNeed(current.view.clockStatus==='trusted'&&same(comparableView(current.view),comparableView(saved.snapshot.view))&&same(current.records,saved.snapshot.records),'QUALIFICATION_PARENT_STATE_CHANGED',result);
  const controller=current.records.checkpoints.filter(cp=>cp.additionalArtifacts.length===4&&same(cp.additionalArtifacts[2],descriptor.plan)&&same(cp.additionalArtifacts[3],descriptor.source));let previous=null,last=null;
  for(const checkpoint of controller){
    const progress=JSON.parse(findOriginalArtifact(item,checkpoint.additionalArtifacts[0],graph)),manifest=JSON.parse(findOriginalArtifact(item,progress.candidate.manifest,graph)),subject=bindSubject(descriptor.identity.lock,manifest);
    parentNeed(progress.version===2&&progress.runId===item.runId&&progress.sequence===checkpoint.sequence&&same(progress.previous,previous)&&subject.ok&&same(subject.value,checkpoint.subject)&&same(progress.candidate.digest,checkpoint.subject.candidateDigest)&&same(progress.candidate.workspace,checkpoint.workspace)&&same(progress.candidate.privateSession,checkpoint.privateSession),'QUALIFICATION_PARENT_PROGRESS');
    for(const row of progress.verifierReceipts){if(row.output)findOriginalArtifact(item,row.output,graph);if(row.receipt){const receipt=JSON.parse(findOriginalArtifact(item,row.receipt,graph)),operation=current.records.operations.find(value=>value.intent.operationId===row.operationId);parentNeed(operation&&operation.state==='confirmed'&&same(receipt,operation.reconciliation??operation.initialReceipt),'QUALIFICATION_PARENT_VERIFIER');}}
    previous=checkpoint.additionalArtifacts[0];last=progress;
  }
  parentNeed(last&&last.stage.kind==='terminal_observations'&&last.stage.phase==='terminal.observations'&&same(last.terminalIntent.observations,observationsRef),'QUALIFICATION_PARENT_PROGRESS');
  const originalResult=JSON.parse(findOriginalArtifact(item,last.terminalIntent.result,graph));
  if(execution.kind==='result')parentNeed(validateDocument(originalResult,'RunResult').ok&&same(originalResult,execution.result)&&same(originalResult.spec.subject,controller.at(-1).subject),'QUALIFICATION_PARENT_RESULT');
  else parentNeed(item.id==='sender-only-retry'&&same(originalResult,execution.incident)&&originalResult.version===1&&originalResult.code==='RECOVERY_REQUIRED'&&originalResult.runId===item.runId&&same(originalResult.lockHash,descriptor.identity.lock.spec.lockHash),'QUALIFICATION_PARENT_INCIDENT');
  return {id:item.id,descriptor:saved.descriptor,observations:observationsRef,result:execution.kind==='result'?last.terminalIntent.result:null,incident:execution.kind==='incident'?last.terminalIntent.result:null,read:result,newClockObservation:current.view.clock.sampledNow,earlierClockReconstructed:false};
}
export function verifyNativeParentEvidence(recipe,data,graph){
  const counters=verifyReceiverTrace(recipe,data,graph),cases=[];
  for(const item of recipe.cases){const ref=data.results.find(ref=>ref.path.endsWith('/case-'+item.id+'.json'));parentNeed(ref,'QUALIFICATION_PARENT_CASE');cases.push(verifyOriginalCase(item,JSON.parse(graphBytes(ref,graph)),graph));}
  return {scope:'original counter/artifact/public-state observations; no native brand',counters,cases};
}
