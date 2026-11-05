import { bindSubject, validateDocument, type ArtifactRef } from '@loopwright/core';
import { array, artifact, checkedAdd, digest, enumeration, equal, hash, id, integer, record, snapshot } from './boundary.js';
import { exactValue } from './admission.js';
import { clockBasis, clockSample, clockValid } from './clock.js';
import { fail } from './errors.js';
import type { Data, StoredCheckpoint } from './model.js';
import type { CheckpointInput, CheckpointRecord, ClockSample, LedgerView, RecordCounts, Violation } from './types.js';
function uniqueRefs(refs:readonly ArtifactRef[]):void {if(new Set(refs.map(ref=>ref.name)).size!==refs.length)fail('INVALID_INPUT','/artifacts');}
export function checkpointInput(input:unknown):CheckpointInput {
  const v=record(snapshot(input),['checkpointId','expectedRevision','candidateManifest','workspace','privateSession','additionalArtifacts']);
  const manifest=validateDocument(v.candidateManifest,'ArtifactManifest');if(!manifest.ok)fail('INVALID_INPUT','/candidateManifest',manifest.errors);
  const workspace=artifact(v.workspace),privateSession=v.privateSession===null?null:artifact(v.privateSession);
  const additionalArtifacts=array(v.additionalArtifacts,'/additionalArtifacts',16).map(item=>artifact(item));
  uniqueRefs([workspace,...(privateSession===null?[]:[privateSession]),...additionalArtifacts]);
  return {checkpointId:id(v.checkpointId),expectedRevision:integer(v.expectedRevision),candidateManifest:manifest.value,workspace,privateSession,additionalArtifacts};
}
function subject(data:Data,input:CheckpointInput){const result=bindSubject(data.identity.lock,input.candidateManifest);if(!result.ok)fail('INVALID_INPUT','/candidateManifest',result.errors);return result.value;}
export function findCheckpoint(data:Data,checkpointId:string):StoredCheckpoint {const result=data.checkpoints.find(c=>c.record.checkpointId===checkpointId);if(!result)fail('RECORD_NOT_FOUND','/checkpointId');return result;}
export function publish(data:Data,now:ClockSample,input:CheckpointInput):{created:boolean;record:CheckpointRecord} {
  const existing=data.checkpoints.find(c=>c.record.checkpointId===input.checkpointId);
  if(existing){if(!equal(existing.input,input))fail('IDENTITY_CONFLICT','/checkpointId');return {created:false,record:existing.record};}
  if(input.expectedRevision!==data.revision)fail('CHECKPOINT_STALE','/expectedRevision');if(data.checkpoints.length>=64)fail('LIMIT_EXCEEDED','/checkpoints');
  const checkpoint:CheckpointRecord={sequence:data.checkpoints.length+1,checkpointId:input.checkpointId,inputDigest:hash('checkpoint-input',input),subject:subject(data,input),workspace:input.workspace,privateSession:input.privateSession,additionalArtifacts:input.additionalArtifacts,storeId:data.identity.storeId,runId:data.identity.lock.spec.runId,lockHash:data.identity.lock.spec.lockHash,binding:data.identity.binding,formatVersion:1,generation:data.owner.generation,publishedRevision:checkedAdd(data.revision,1),startedAtMs:data.startedAtMs,deadlineMs:data.deadlineMs,clockBasis:data.basis,clockSample:now,ledger:data.ledger,ledgerRoot:data.ledgerRoot,counts:{...data.counts,checkpoints:data.checkpoints.length+1}};
  data.checkpoints.push({input,record:checkpoint});return {created:true,record:checkpoint};
}
export function requiredReferences(checkpoint:CheckpointRecord):readonly ArtifactRef[]{return [checkpoint.workspace,...(checkpoint.privateSession===null?[]:[checkpoint.privateSession]),...checkpoint.additionalArtifacts];}
export function recoveryInput(input:unknown):{checkpointId:string;availableArtifacts:readonly ArtifactRef[]} {
  const v=record(snapshot(input),['checkpointId','availableArtifacts']);const availableArtifacts=array(v.availableArtifacts,'/availableArtifacts',18).map(item=>artifact(item));uniqueRefs(availableArtifacts);return {checkpointId:id(v.checkpointId),availableArtifacts};
}
export function requireArtifacts(checkpoint:CheckpointRecord,available:readonly ArtifactRef[]):void {for(const required of requiredReferences(checkpoint))if(!available.some(a=>a.name===required.name&&equal(a,required)))fail('ARTIFACT_REQUIRED',`/artifacts/${required.name}`);}
function counts(input:unknown):RecordCounts {
  const keys=['requests','operations','checkpoints','reservedRequests','dispatchedRequests','observedRequests','unresolvedRequests','releasedRequests','unresolvedOperations'] as const;const v=record(input,keys);
  const result=Object.fromEntries(keys.map(key=>[key,integer(v[key],'',0,key==='operations'||key==='unresolvedOperations'?2048:key==='checkpoints'?64:1024)])) as Record<keyof RecordCounts,number>;
  if(result.reservedRequests+result.dispatchedRequests+result.observedRequests+result.unresolvedRequests+result.releasedRequests!==result.requests||result.operations<result.requests||result.unresolvedOperations>result.operations||result.unresolvedOperations<result.dispatchedRequests)fail('STORE_CORRUPT');return result;
}
function ledger(input:unknown,data:Data,c:RecordCounts):LedgerView {
  const scalar=['admittedCalls','formatRepairs','implementationRepairs','transportRetries','heldSlots','unknownTokenRequests','unknownCostRequests'] as const;
  const amounts=['reportedTokens','estimatedTokens','reservedCharge','chargedTokens','remainingTokens','reportedCostMicrousd','estimatedCostMicrousd'] as const;
  const v=record(input,[...scalar,...amounts,'violations']);
  const n=Object.fromEntries(scalar.map(key=>[key,integer(v[key],'',0,1024)])) as Record<typeof scalar[number],number>;
  const q=Object.fromEntries(amounts.map(key=>[key,exactValue(v[key],key==='remainingTokens')])) as Record<typeof amounts[number],ReturnType<typeof exactValue>>;
  const violations=array(v.violations,'/violations',3).map(value=>enumeration(value,['reservation_exceeded','budget_exceeded','usage_overflow'])) as Violation[];
  if(new Set(violations).size!==violations.length||!equal(violations,[...violations].sort()))fail('STORE_CORRUPT');
  const result={...n,...q,violations};const limit=BigInt(data.identity.lock.spec.contract.spec.budgets.totalTokens),charged=BigInt(q.chargedTokens.decimal);
  if(n.admittedCalls!==c.requests||n.formatRepairs+n.implementationRepairs>n.admittedCalls||n.transportRetries>n.admittedCalls||n.unknownTokenRequests>n.admittedCalls||n.unknownCostRequests>n.admittedCalls||n.heldSlots<c.reservedRequests+c.dispatchedRequests||n.heldSlots>c.reservedRequests+c.dispatchedRequests+c.unresolvedRequests||BigInt(q.remainingTokens.decimal)!==limit-charged||BigInt(q.reservedCharge.decimal)>charged||BigInt(q.reportedTokens.decimal)+BigInt(q.estimatedTokens.decimal)>charged)fail('STORE_CORRUPT');
  if(charged>limit&&!violations.includes('budget_exceeded'))fail('STORE_CORRUPT');if(amounts.filter(k=>k!=='remainingTokens').some(k=>q[k].safeValue===null)&&!violations.includes('usage_overflow'))fail('STORE_CORRUPT');return result;
}
export function storedCheckpoint(input:unknown,recordInput:unknown,data:Data):StoredCheckpoint {
  const value=checkpointInput(input);const v=record(recordInput,['sequence','checkpointId','inputDigest','subject','workspace','privateSession','additionalArtifacts','storeId','runId','lockHash','binding','formatVersion','generation','publishedRevision','startedAtMs','deadlineMs','clockBasis','clockSample','ledger','ledgerRoot','counts']);
  if(v.formatVersion!==1)fail('FORMAT_UNSUPPORTED','/formatVersion');
  const c=counts(v.counts),l=ledger(v.ledger,data,c),basis=clockBasis(v.clockBasis),sample=clockSample(v.clockSample);
  const result:CheckpointRecord={sequence:integer(v.sequence,'',1,64),checkpointId:id(v.checkpointId),inputDigest:digest(v.inputDigest),subject:subject(data,value),workspace:value.workspace,privateSession:value.privateSession,additionalArtifacts:value.additionalArtifacts,storeId:data.identity.storeId,runId:data.identity.lock.spec.runId,lockHash:data.identity.lock.spec.lockHash,binding:data.identity.binding,formatVersion:1,generation:integer(v.generation,'',1),publishedRevision:integer(v.publishedRevision,'',1),startedAtMs:data.startedAtMs,deadlineMs:data.deadlineMs,clockBasis:basis,clockSample:sample,ledger:l,ledgerRoot:digest(v.ledgerRoot),counts:c};
  if(!equal(recordInput,result)||!equal(result.inputDigest,hash('checkpoint-input',value))||value.checkpointId!==result.checkpointId||result.publishedRevision!==checkedAdd(value.expectedRevision,1)||result.publishedRevision>data.revision||result.generation>data.owner.generation||!equal(basis,data.basis)||!clockValid(basis,basis.created,sample)||BigInt(sample.monotonicMs)>BigInt(data.last.monotonicMs)||sample.wallMs>data.last.wallMs||c.checkpoints!==result.sequence||c.requests>data.requests.length||c.operations>data.operations.length)fail('STORE_CORRUPT');
  return {input:value,record:result};
}
