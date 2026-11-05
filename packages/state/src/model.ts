import type { Digest, RequestUsage, Quantity } from '@loopwright/core';
import { exact, hash } from './boundary.js';
import type { ClockBasis, ClockSample, LocalRunIdentity, LedgerView, RecordCounts, RequestRecord, OperationRecord, CheckpointRecord, CheckpointInput, Violation } from './types.js';
export type Mutable<T> = T extends readonly (infer U)[] ? Mutable<U>[] : T extends object ? {-readonly [K in keyof T]:Mutable<T[K]>} : T;
export type Owner = {generation:number;ownerId:string|null;nonce:string|null;mode:'active'|'recovery'|null;leaseUntilMs:number|null;leaseGrantedMonotonicMs:string|null;leaseUntilMonotonicMs:string|null};
export type StoredCheckpoint = {input:CheckpointInput;record:CheckpointRecord};
export interface Data {
  identity:Omit<LocalRunIdentity,'directory'>;identityDigest:Digest;
  startedAtMs:number;deadlineMs:number;revision:number;owner:Owner;basis:ClockBasis;last:ClockSample;
  requests:Mutable<RequestRecord>[];operations:Mutable<OperationRecord>[];checkpoints:StoredCheckpoint[];
  ledger:LedgerView;counts:RecordCounts;ledgerRoot:Digest;
}
export function effectiveUsage(request:RequestRecord):RequestUsage|null {
  if(request.state==='released'||request.resolution?.kind==='not_executed')return {requestId:request.admission.requestId,inputTokens:{provenance:'reported',value:0},outputTokens:{provenance:'reported',value:0},costMicrousd:{provenance:'reported',value:0}};
  return request.resolution?.kind==='terminal_usage'?request.resolution.observation.usage:request.initialObservation?.usage??null;
}
// shortcut: bounded whole-run verification; revisit incremental indexes only if the fixed retention profile expands.
export function summaries(data:Pick<Data,'identity'|'requests'|'operations'|'checkpoints'>):{ledger:LedgerView;counts:RecordCounts;ledgerRoot:Digest} {
  let reported=0n,estimated=0n,reportedCost=0n,estimatedCost=0n,unknown=0,unknownCost=0,reserved=0n,charged=0n,slots=0,format=0,implementation=0,retries=0;
  const violations=new Set<Violation>();
  for(const request of data.requests){
    const charge=BigInt(request.chargedTokens.decimal);charged+=charge;if(request.state!=='observed'&&request.state!=='released')reserved+=charge;
    if(request.holdsSlot)slots++;if(request.admission.repair==='format')format++;if(request.admission.repair==='implementation')implementation++;if(request.admission.transportRetryOf!==null)retries++;
    const usage=effectiveUsage(request);
    if(!usage){unknown++;unknownCost++;}else{
      const quantities:Quantity[]=[usage.inputTokens,usage.outputTokens];if(quantities.some(q=>q.provenance==='unknown'))unknown++;
      for(const q of quantities){if(q.provenance==='reported')reported+=BigInt(q.value);if(q.provenance==='estimated')estimated+=BigInt(q.value);}
      if(usage.costMicrousd.provenance==='unknown')unknownCost++;else if(usage.costMicrousd.provenance==='reported')reportedCost+=BigInt(usage.costMicrousd.value);else estimatedCost+=BigInt(usage.costMicrousd.value);
    }
    for(const violation of request.violations)violations.add(violation);
  }
  const limit=BigInt(data.identity.lock.spec.contract.spec.budgets.totalTokens);
  const ledger:LedgerView={admittedCalls:data.requests.length,formatRepairs:format,implementationRepairs:implementation,transportRetries:retries,heldSlots:slots,
    reportedTokens:exact(reported),estimatedTokens:exact(estimated),unknownTokenRequests:unknown,reservedCharge:exact(reserved),chargedTokens:exact(charged),remainingTokens:exact(limit-charged),reportedCostMicrousd:exact(reportedCost),estimatedCostMicrousd:exact(estimatedCost),unknownCostRequests:unknownCost,violations:[...violations].sort()};
  const counts:RecordCounts={requests:data.requests.length,operations:data.operations.length,checkpoints:data.checkpoints.length,
    reservedRequests:data.requests.filter(r=>r.state==='reserved').length,dispatchedRequests:data.requests.filter(r=>r.state==='dispatch_authorized').length,
    observedRequests:data.requests.filter(r=>r.state==='observed').length,unresolvedRequests:data.requests.filter(r=>r.state==='unresolved').length,
    releasedRequests:data.requests.filter(r=>r.state==='released').length,unresolvedOperations:data.operations.filter(o=>o.state==='unresolved'||o.state==='dispatch_uncertain').length};
  const ledgerRoot=hash('ledger',{identity:data.identity,requests:data.requests,operations:data.operations,ledger});
  return {ledger,counts,ledgerRoot};
}
