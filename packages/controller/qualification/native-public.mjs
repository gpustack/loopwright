/* global process, AbortSignal */
import { resolve, join } from 'node:path';
import { reopenLocalRun } from '@loopwright/state';
import { bindSubject } from '@loopwright/core';
import { readPublicSnapshot } from './native-preload.mjs';
import { bindContext, readPrivate, sha, same, canonical, checkedRef, revoke, fail } from './native-context.mjs';
import { requireNativeAppActivation } from './native-activation.mjs';
const registrations=new WeakMap();
export function freezeAdmission(declared,event,signal,activation=null){
  if(!(signal instanceof AbortSignal)||event.stage!=='admission'||event.runId!==declared.runId)fail('QUALIFICATION_ADMISSION_EVENT');
  const path=join(resolve(declared.runRoot),declared.runId,'run.json'),bytes=readPrivate(path),descriptor=JSON.parse(bytes);
  if(descriptor.version!==1||descriptor.identity.lock.spec.runId!==declared.runId||descriptor.repository!==declared.repository||!same(descriptor.configuration,declared.configuration))fail('QUALIFICATION_ADMISSION_DESCRIPTOR');
  if(sha(readPrivate(declared.configuration.configPath))!==declared.configSha256||sha(readPrivate(declared.configuration.registryPath))!==declared.configuration.registrySha256)fail('QUALIFICATION_ADMISSION_CONFIG_CHANGED');
  const opened=reopenLocalRun(descriptor.identity);if(!opened.ok)fail('QUALIFICATION_ADMISSION_STATE');let view;
  try{view=readPublicSnapshot(opened.value).view;}finally{if(!opened.value.close().ok)fail('QUALIFICATION_ADMISSION_CLOSE');}
  if(view.clockStatus!=='trusted'||view.owner.mode!=='active'||!view.owner.ownerId||view.counts.requests!==0||view.counts.operations!==0||!same(event.lockHash,view.lockHash)||event.deadlineMonotonicMs!==view.clock.basis.taskDeadlineMonotonicMs)fail('QUALIFICATION_ADMISSION_BINDING');
  const work=BigInt(view.clock.basis.taskDeadlineMonotonicMs)-BigInt(declared.drainReserveMs);
  const context=bindContext({mode:declared.mode??'offline',runId:declared.runId,taskId:declared.taskId,dispatchId:declared.dispatchId,sourceDigest:declared.sourceDigest,image:declared.image,identity:{storeId:view.storeId,lockHash:view.lockHash},owner:{id:view.owner.ownerId,generation:view.owner.generation},basis:view.clock.basis,workCutoff:String(work),leafCutoff:declared.leafCutoff,signal,cancelled:()=>signal.aborted,providerEndpoint:declared.providerEndpoint,mcpEndpoint:declared.mcpEndpoint,executable:declared.executable,socket:declared.socket,commands:[]},activation);
  const handle=Object.freeze({});registrations.set(handle,{context,descriptor:JSON.parse(canonical(descriptor)),descriptorRef:{path,byteLength:bytes.length,sha256:sha(bytes)},originalOwner:context.owner});return handle;
}
export function admissionRegistration(handle){const value=registrations.get(handle);if(!value)fail('QUALIFICATION_ADMISSION_REGISTRATION');return value;}
/** Public production API route, callable only inside an original activated native application. */
export async function executePreparedPublicCycle(activation,input){
  requireNativeAppActivation(activation);
  const {loadTrustedConfiguration,compilePlan,runCycle}=await import('@loopwright/controller');
  const loaded=await loadTrustedConfiguration(input.load);if(!loaded.ok)return loaded;
  const compiled=await compilePlan(loaded.value);if(!compiled.ok)return compiled;
  let admission=null;
  return runCycle({configuration:loaded.value,repository:input.repository,runRoot:input.runRoot,runId:input.runId,signal:input.signal,onEvent:async event=>{if(event.stage==='admission'){if(admission)fail('QUALIFICATION_ADMISSION_REPLAY');admission=freezeAdmission(input.declared,event,input.signal,activation);}await input.observe(event,admission);}});
}
export function readRegisteredSnapshot(registration){
  checkedRef(registration.descriptorRef);
  const opened=reopenLocalRun(registration.descriptor.identity);if(!opened.ok)fail('QUALIFICATION_ADMISSION_STATE');
  let snapshot;try{snapshot=readPublicSnapshot(opened.value);}finally{const closed=opened.value.close();if(!closed.ok)fail('QUALIFICATION_ADMISSION_CLOSE');if(snapshot)snapshot.close=closed;}return snapshot;
}
export function publicArtifact(registration,ref,maximum=1048576){
  if(!ref||typeof ref.name!=='string'||!/^[a-z0-9.-]{1,128}$/.test(ref.name)||ref.digest?.algorithm!=='sha256'||!Number.isSafeInteger(ref.byteLength)||ref.byteLength>maximum)fail('QUALIFICATION_PUBLIC_ARTIFACT');
  const path=join(resolve(registration.descriptorRef.path,'..'),'artifacts',ref.name),bytes=readPrivate(path,maximum);
  if(bytes.length!==ref.byteLength||sha(bytes)!==ref.digest.hex)fail('QUALIFICATION_PUBLIC_ARTIFACT');
  return {bytes,ref:{path,byteLength:bytes.length,sha256:sha(bytes)}};
}
/** Consumes original public pages and full immutable artifacts, never repository/model declarations. */
export function deriveStockRole(registration,snapshot){
  revoke(registration.context,snapshot.view);
  if(!Array.isArray(snapshot.records.checkpoints)||snapshot.records.checkpoints.length!==snapshot.view.counts.checkpoints)fail('QUALIFICATION_ROLE_PROGRESS');
  const descriptor=registration.descriptor,checkpoints=snapshot.records.checkpoints.filter(row=>row.additionalArtifacts?.length===4&&same(row.additionalArtifacts[2],descriptor.plan)&&same(row.additionalArtifacts[3],descriptor.source));
  const current=checkpoints.at(-1);if(!current)fail('QUALIFICATION_ROLE_PROGRESS');
  const progressFile=publicArtifact(registration,current.additionalArtifacts[0],65536),progress=JSON.parse(progressFile.bytes),planFile=publicArtifact(registration,descriptor.plan),plan=JSON.parse(planFile.bytes);
  const manifestFile=publicArtifact(registration,progress.candidate.manifest,32768),manifest=JSON.parse(manifestFile.bytes),subject=bindSubject(descriptor.identity.lock,manifest),attempt=progress.attempts.at(-1);
  if(progress.version!==2||progress.runId!==registration.context.runId||progress.sequence!==current.sequence||progress.stage.kind!=='role_pre'||!attempt||attempt.finished!==null
    ||progress.stage.phase!=='role.'+attempt.ordinal+'.pre'||progress.stage.consumed.at(-1)!==progress.stage.phase||!same(progress.stage.watermarks,{requests:current.counts.requests,operations:current.counts.operations})
    ||!subject.ok||!same(subject.value,current.subject)||!same(progress.candidate.digest,current.subject.candidateDigest)||!same(progress.candidate.workspace,current.workspace)||!same(progress.candidate.privateSession,current.privateSession)
    ||!same(progress.previous,checkpoints.length>1?checkpoints.at(-2).additionalArtifacts[0]:null))fail('QUALIFICATION_ROLE_PROGRESS');
  const node=plan.orderedDAG.find(row=>row.id===attempt.nodeId),role=plan.roles.find(row=>row.roleId===node?.roleId);
  if(!node||node.kind!=='agent'||!role||!/^[a-z0-9._-]{1,128}$/.test(attempt.id)||!/^[a-z0-9._-]{1,128}$/.test(attempt.sessionId)||attempt.nativeStepId!==node.id)fail('QUALIFICATION_ROLE_PROGRESS');
  const runtimeRoot=join(resolve(registration.descriptorRef.path,'..'),'runtime'),hostDirectory=join(runtimeRoot,attempt.id);
  return {runtimeRoot,hostDirectory,sessionId:attempt.sessionId,candidate:join(hostDirectory,'sdk-'+attempt.sessionId,'candidate'),attemptId:attempt.id,nodeId:node.id,roleId:role.roleId,operationIds:snapshot.records.operations.map(row=>row.intent.operationId),checkpointId:current.checkpointId,refs:[progressFile.ref,planFile.ref,manifestFile.ref]};
}
export const preparedRuntimeFacts=()=>({mode:'held',platform:process.platform,sourceOnly:true});

/** Read the original incident observation through its committed controller checkpoint, never a filename guess. */
export function terminalObservations(registration,snapshot){
  const last=snapshot.records.checkpoints.filter(row=>row.additionalArtifacts.length===4&&same(row.additionalArtifacts[2],registration.descriptor.plan)&&same(row.additionalArtifacts[3],registration.descriptor.source)).at(-1);
  if(!last)fail('QUALIFICATION_PUBLIC_ARTIFACT');const progress=JSON.parse(publicArtifact(registration,last.additionalArtifacts[0]).bytes),ref=progress.terminalIntent?.observations;
  if(progress.stage.kind!=='terminal_observations'||!ref)fail('QUALIFICATION_PUBLIC_ARTIFACT');return {ref,value:JSON.parse(publicArtifact(registration,ref).bytes)};
}
