import { randomBytes } from 'node:crypto';
import { checkedAdd, equal, hash } from './boundary.js';
import { findOperation } from './admission.js';
import { fail } from './errors.js';
import type { Data } from './model.js';
import { requireNewWork } from './ownership.js';
import { matchEvidence } from './receipts.js';
import { makePermit } from './settlement.js';
import type { ClockSample, DispatchResult, OperationIntent, OperationReceipt, OperationRecord, UnresolvedReason } from './types.js';
export function standalone(data:Data,operationId:string){const op=findOperation(data,operationId);if(op.linkedRequestId!==null||op.intent.effect==='model_call')fail('TRANSITION_INVALID','/linkedRequestId');return op;}
export function put(data:Data,now:ClockSample,input:OperationIntent):{created:boolean;record:OperationRecord} {
  const existing=data.operations.find(o=>o.intent.operationId===input.operationId);
  if(existing){if(existing.linkedRequestId!==null||!equal(existing.intent,input))fail('IDENTITY_CONFLICT','/operationId');return {created:false,record:existing};}
  requireNewWork(data,now);if(!data.identity.lock.spec.contract.spec.steps.some(step=>step.id===input.nodeId))fail('INVALID_INPUT','/nodeId');if(data.operations.length>=2048)fail('LIMIT_EXCEEDED','/operations');
  const operation={sequence:data.operations.length+1,intent:input,intentDigest:hash('operation-intent',input),intentGeneration:data.owner.generation,linkedRequestId:null,state:'intent' as const,dispatch:null,initialReceipt:null,reconciliation:null,unresolvedReason:null};data.operations.push(operation);return {created:true,record:operation};
}
export function authorizeOperation(data:Data,now:ClockSample,operationId:string):{changed:boolean;finish:()=>DispatchResult<OperationRecord>} {
  const op=standalone(data,operationId);if(op.dispatch!==null)return {changed:false,finish:()=>({kind:'existing',revision:data.revision,record:op})};
  if(op.state!=='intent')fail('TRANSITION_INVALID');requireNewWork(data,now);
  op.state='dispatch_uncertain';op.dispatch={generation:data.owner.generation,dispatchId:`dispatch-${randomBytes(16).toString('hex')}`,revision:checkedAdd(data.revision,1)};const permit=makePermit(data,op);
  return {changed:true,finish:()=>({kind:'new_dispatch',revision:data.revision,permit,record:op})};
}
export function unresolvedOperation(data:Data,operationId:string,reason:UnresolvedReason):boolean {
  const op=standalone(data,operationId);if(op.state==='unresolved'){if(op.unresolvedReason!==reason)fail('TRANSITION_INVALID');return false;}
  if(op.state!=='dispatch_uncertain')fail('TRANSITION_INVALID');op.state='unresolved';op.unresolvedReason=reason;return true;
}
export function receiveOperation(data:Data,operationId:string,receipt:OperationReceipt,reconciling:boolean):boolean {
  const op=standalone(data,operationId);if(op.dispatch===null)fail('TRANSITION_INVALID');if(!reconciling&&op.dispatch.generation!==data.owner.generation)fail('EVIDENCE_INSUFFICIENT','/evidence/subject/dispatchGeneration');matchEvidence(data,op,receipt.evidence);
  if(op.state==='confirmed'){if(!equal(op.reconciliation??op.initialReceipt,receipt))fail('RECEIPT_CONFLICT');return false;}
  if(op.state!=='unresolved'&&op.state!=='dispatch_uncertain')fail('TRANSITION_INVALID');
  if(reconciling)op.reconciliation=receipt;else op.initialReceipt=receipt;op.state='confirmed';op.unresolvedReason=null;return true;
}
