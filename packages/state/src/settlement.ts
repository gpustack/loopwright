import { randomBytes } from 'node:crypto';
import { checkedAdd, equal } from './boundary.js';
import { findOperation, findRequest } from './admission.js';
import { project } from './clock.js';
import { fail } from './errors.js';
import { summaries, type Data, type Mutable } from './model.js';
import { requireNewWork } from './ownership.js';
import { accounting, boundViolation, consistentResolution, knownTokens, matchEvidence, receiptFrom, resolutionReceipt } from './receipts.js';
import type { ClockSample, DispatchPermit, DispatchResult, OperationRecord, RequestObservation, RequestRecord, RequestResolution, UnresolvedReason, Violation } from './types.js';

export function authorizeRequest(data:Data,now:ClockSample,requestId:string):{changed:boolean;finish:()=>DispatchResult<RequestRecord>} {
  const request=findRequest(data,requestId);
  if(request.dispatch!==null)return {changed:false,finish:()=>({kind:'existing',revision:data.revision,record:request})};
  if(request.state!=='reserved')fail('TRANSITION_INVALID');requireNewWork(data,now);
  const operation=findOperation(data,request.admission.operationId);if(operation.state!=='intent'||operation.dispatch!==null)fail('STORE_CORRUPT');
  const dispatch={generation:data.owner.generation,dispatchId:`dispatch-${randomBytes(16).toString('hex')}`,revision:checkedAdd(data.revision,1)};
  request.state='dispatch_authorized';request.dispatch=dispatch;operation.state='dispatch_uncertain';operation.dispatch={...dispatch};
  const permit=makePermit(data,operation);
  return {changed:true,finish:()=>({kind:'new_dispatch',revision:data.revision,permit,record:request})};
}
export function makePermit(data:Data,operation:OperationRecord):DispatchPermit {
  if(operation.dispatch===null||data.owner.leaseUntilMonotonicMs===null)fail('STORE_CORRUPT');
  const lease=BigInt(data.owner.leaseUntilMonotonicMs),task=BigInt(data.basis.taskDeadlineMonotonicMs);const expires=String(lease<task?lease:task);
  return {storeId:data.identity.storeId,runId:data.identity.lock.spec.runId,lockHash:data.identity.lock.spec.lockHash,operationId:operation.intent.operationId,requestId:operation.linkedRequestId,generation:operation.dispatch.generation,dispatchId:operation.dispatch.dispatchId,authorizedRevision:operation.dispatch.revision,clockEpoch:data.basis.clockEpoch,notAfterMonotonicMs:expires,notAfterMs:project(data.basis,expires)};
}
export function unresolvedRequest(data:Data,requestId:string,reason:UnresolvedReason):boolean {
  const request=findRequest(data,requestId);
  if(request.state==='unresolved'){if(request.unresolvedReason!==reason)fail('TRANSITION_INVALID');return false;}
  if(request.state!=='dispatch_authorized')fail('TRANSITION_INVALID');
  request.state='unresolved';request.unresolvedReason=reason;const operation=findOperation(data,request.admission.operationId);operation.state='unresolved';operation.unresolvedReason=reason;return true;
}
function ensureObservation(data:Data,request:RequestRecord,observation:RequestObservation):void {
  matchEvidence(data,findOperation(data,request.admission.operationId),observation.evidence);
  if(observation.usage.requestId!==request.admission.requestId)fail('EVIDENCE_INSUFFICIENT','/usage/requestId');
}
function applyAccounting(data:Data,request:Mutable<RequestRecord>):void {
  Object.assign(request,accounting(request));if(request.state==='observed')request.unresolvedReason=null;
  const flags=new Set<Violation>(request.violations);
  const observations=[request.initialObservation,request.resolution?.kind==='terminal_usage'?request.resolution.observation:null].filter((o):o is RequestObservation=>o!==null);
  for(const observation of observations){if(boundViolation(request,observation))flags.add('reservation_exceeded');if(knownTokens(observation)>BigInt(Number.MAX_SAFE_INTEGER))flags.add('usage_overflow');}
  const summary=summaries(data).ledger;
  if(BigInt(summary.chargedTokens.decimal)>BigInt(data.identity.lock.spec.contract.spec.budgets.totalTokens))flags.add('budget_exceeded');
  if([summary.chargedTokens,summary.reportedTokens,summary.estimatedTokens,summary.reportedCostMicrousd,summary.estimatedCostMicrousd].some(q=>q.safeValue===null))flags.add('usage_overflow');
  request.violations=[...flags].sort();
  const operation=findOperation(data,request.admission.operationId);
  operation.initialReceipt=request.initialObservation===null?null:receiptFrom(request.initialObservation);
  operation.reconciliation=request.resolution===null?null:resolutionReceipt(request.resolution);
  if(operation.reconciliation!==null||operation.initialReceipt!==null){operation.state='confirmed';operation.unresolvedReason=null;}
  else{operation.state='unresolved';operation.unresolvedReason=request.unresolvedReason;}
}
export function observe(data:Data,requestId:string,observation:RequestObservation):boolean {
  const request=findRequest(data,requestId);if(request.dispatch===null)fail('TRANSITION_INVALID');
  if(request.dispatch.generation!==data.owner.generation)fail('EVIDENCE_INSUFFICIENT','/evidence/subject/dispatchGeneration');
  ensureObservation(data,request,observation);
  if(request.initialObservation!==null){if(!equal(request.initialObservation,observation))fail('RECEIPT_CONFLICT');return false;}
  if(request.resolution!==null){if(request.resolution.kind==='terminal_usage'&&equal(request.resolution.observation,observation))return false;fail('RECEIPT_CONFLICT');}
  request.initialObservation=observation;applyAccounting(data,request);return true;
}
export function reconcile(data:Data,requestId:string,resolution:RequestResolution):boolean {
  const request=findRequest(data,requestId);if(request.dispatch===null)fail('TRANSITION_INVALID');
  const operation=findOperation(data,request.admission.operationId);
  if(resolution.kind==='terminal_usage')ensureObservation(data,request,resolution.observation);else matchEvidence(data,operation,resolution.evidence);
  if(request.resolution!==null){if(!equal(request.resolution,resolution))fail('RECEIPT_CONFLICT');return false;}
  if(request.state==='observed'){if(resolution.kind==='terminal_usage'&&equal(resolution.observation,request.initialObservation))return false;fail('RECEIPT_CONFLICT');}
  consistentResolution(request.initialObservation,resolution);
  request.resolution=resolution;applyAccounting(data,request);return true;
}
