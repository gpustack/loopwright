import { aggregateUsage, type Quantity, type RequestUsage } from '@loopwright/core';
import { array, artifact, boolean, digest, enumeration, equal, exact, id, integer, record, snapshot, text } from './boundary.js';
import { fail } from './errors.js';
import type { Data } from './model.js';
import type { OperationRecord, OperationReceipt, ReceiptSubject, RequestObservation, RequestRecord, RequestResolution, TrustedEvidence } from './types.js';
export function usage(input:unknown):RequestUsage {
  const v=record(input,['requestId','inputTokens','outputTokens','costMicrousd']);const requestId=id(v.requestId);
  const quantity=(value:unknown):Quantity=>{const result=aggregateUsage([{requestId,inputTokens:value,outputTokens:{provenance:'reported',value:0},costMicrousd:{provenance:'reported',value:0}}]);if(!result.ok)fail('INVALID_INPUT','/usage',result.errors);return {...result.value.requests[0]!.inputTokens};};
  return {requestId,inputTokens:quantity(v.inputTokens),outputTokens:quantity(v.outputTokens),costMicrousd:quantity(v.costMicrousd)};
}
export function evidence(input:unknown):TrustedEvidence {
  const e=record(input,['evidenceId','producerId','method','subject','artifact']);const v=record(e.subject,['storeId','runId','lockHash','operationId','requestId','intentDigest','dispatchGeneration','dispatchId']);
  const subject:ReceiptSubject={storeId:id(v.storeId),runId:id(v.runId),lockHash:digest(v.lockHash),operationId:id(v.operationId),requestId:v.requestId===null?null:id(v.requestId),intentDigest:digest(v.intentDigest),dispatchGeneration:integer(v.dispatchGeneration),dispatchId:text(v.dispatchId)};
  return {evidenceId:id(e.evidenceId),producerId:id(e.producerId),method:text(e.method),subject,artifact:artifact(e.artifact)};
}
export function observation(input:unknown):RequestObservation {
  const v=record(snapshot(input),['receiptId','evidence','termination','outcome','usage']);const termination=enumeration(v.termination,['confirmed','unknown']);const outcome=v.outcome===null?null:enumeration(v.outcome,['succeeded','failed']);
  if((termination==='confirmed')!==(outcome!==null))fail('INVALID_INPUT','/outcome');
  return {receiptId:id(v.receiptId),evidence:evidence(v.evidence),termination,outcome,usage:usage(v.usage)};
}
export function resolution(input:unknown):RequestResolution {
  const outer=snapshot(input);const kind=outer!==null&&typeof outer==='object'&&!Array.isArray(outer)?outer.kind:undefined;
  if(kind==='terminal_usage'){const v=record(outer,['kind','observation']);return {kind,observation:observation(v.observation)};}
  const v=record(outer,['kind','receiptId','evidence']);if(v.kind!=='not_executed')fail('INVALID_INPUT','/kind');return {kind:'not_executed',receiptId:id(v.receiptId),evidence:evidence(v.evidence)};
}
export function operationReceipt(input:unknown):OperationReceipt {const v=record(snapshot(input),['receiptId','evidence','outcome']);return {receiptId:id(v.receiptId),evidence:evidence(v.evidence),outcome:enumeration(v.outcome,['succeeded','failed','not_executed'])};}
export function dispatchRecord(input:unknown):RequestRecord['dispatch'] {
  if(input===null)return null;const v=record(input,['generation','dispatchId','revision']);const dispatchId=text(v.dispatchId);if(!/^dispatch-[0-9a-f]{32}$/.test(dispatchId))fail('INVALID_INPUT');return {generation:integer(v.generation),dispatchId,revision:integer(v.revision,'',1)};
}
export function matchEvidence(data:Data,operation:OperationRecord,input:TrustedEvidence):void {
  const d=operation.dispatch;if(d===null)fail('TRANSITION_INVALID');
  const expected:ReceiptSubject={storeId:data.identity.storeId,runId:data.identity.lock.spec.runId,lockHash:data.identity.lock.spec.lockHash,operationId:operation.intent.operationId,requestId:operation.linkedRequestId,intentDigest:operation.intentDigest,dispatchGeneration:d.generation,dispatchId:d.dispatchId};
  if(!equal(input.subject,expected))fail('EVIDENCE_INSUFFICIENT','/evidence/subject');
}
export function completeReported(value:RequestObservation):boolean {return value.termination==='confirmed'&&value.usage.inputTokens.provenance==='reported'&&value.usage.outputTokens.provenance==='reported';}
export function knownTokens(value:RequestObservation):bigint {return [value.usage.inputTokens,value.usage.outputTokens].reduce((n,q)=>n+(q.provenance==='unknown'?0n:BigInt(q.value)),0n);}
export function boundViolation(request:RequestRecord,value:RequestObservation):boolean {
  return (value.usage.inputTokens.provenance!=='unknown'&&value.usage.inputTokens.value>request.admission.inputUpperBound)||(value.usage.outputTokens.provenance!=='unknown'&&value.usage.outputTokens.value>request.admission.outputUpperBound)||knownTokens(value)>BigInt(request.admission.totalUpperBound);
}
export function receiptFrom(value:RequestObservation):OperationReceipt|null {return value.termination==='confirmed'?{receiptId:value.receiptId,evidence:value.evidence,outcome:value.outcome!}:null;}
export function resolutionReceipt(value:RequestResolution):OperationReceipt {return value.kind==='not_executed'?{receiptId:value.receiptId,evidence:value.evidence,outcome:'not_executed'}:receiptFrom(value.observation)!;}
export function consistentResolution(initial:RequestObservation|null,final:RequestResolution):void {
  if(final.kind==='terminal_usage'&&!completeReported(final.observation))fail('EVIDENCE_INSUFFICIENT','/observation');
  if(initial===null)return;
  if(final.kind==='not_executed'){
    if(initial.termination==='confirmed'||[initial.usage.inputTokens,initial.usage.outputTokens,initial.usage.costMicrousd].some(q=>q.provenance==='reported'&&q.value>0))fail('RECEIPT_CONFLICT');return;
  }
  const observation=final.observation;
  if(initial.termination==='confirmed'&&initial.outcome!==observation.outcome)fail('RECEIPT_CONFLICT');
  for(const metric of ['inputTokens','outputTokens','costMicrousd'] as const){const a=initial.usage[metric],b=observation.usage[metric];if(a.provenance==='reported'&&(b.provenance!=='reported'||a.value!==b.value))fail('RECEIPT_CONFLICT',`/usage/${metric}`);}
}
export function accounting(request:RequestRecord):{state:'observed'|'unresolved';holdsSlot:boolean;chargedTokens:RequestRecord['chargedTokens']} {
  if(request.resolution?.kind==='not_executed')return {state:'observed',holdsSlot:false,chargedTokens:exact(0n)};
  const observation=request.resolution?.kind==='terminal_usage'?request.resolution.observation:request.initialObservation;
  const reservation=BigInt(request.admission.totalUpperBound);
  if(observation===null)return {state:'unresolved',holdsSlot:true,chargedTokens:exact(reservation)};
  const known=knownTokens(observation);const complete=completeReported(observation);
  return {state:complete?'observed':'unresolved',holdsSlot:observation.termination!=='confirmed',chargedTokens:exact(complete?known:known>reservation?known:reservation)};
}
export function storedReceiptState(input:Record<string,unknown>){
  const violations=array(input.violations,'/violations',4).map(v=>enumeration(v,['reservation_exceeded','budget_exceeded','usage_overflow','clock_untrusted']));
  if(new Set(violations).size!==violations.length||!equal([...violations].sort(),violations)||violations.includes('clock_untrusted'))fail('STORE_CORRUPT');
  return {dispatch:dispatchRecord(input.dispatch),holdsSlot:boolean(input.holdsSlot),initialObservation:input.initialObservation===null?null:observation(input.initialObservation),resolution:input.resolution===null?null:resolution(input.resolution),unresolvedReason:input.unresolvedReason===null?null:enumeration(input.unresolvedReason,['timeout','cancellation','connection_lost','owner_lost']),violations};
}
