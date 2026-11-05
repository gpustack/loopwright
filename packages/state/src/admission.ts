import { boolean, checkedAdd, digest, enumeration, equal, exact, hash, id, integer, record, snapshot, text } from './boundary.js';
import { accounting, boundViolation, consistentResolution, dispatchRecord, knownTokens, matchEvidence, operationReceipt, receiptFrom, resolutionReceipt, storedReceiptState } from './receipts.js';
import { fail } from './errors.js';
import type { Data } from './model.js';
import { boundaryInput, requireNewWork } from './ownership.js';
import type { Capability, ClockSample, OperationIntent, ModelIntent, RequestAdmission, RequestRecord, OperationRecord, ExactTotal } from './types.js';
export function admission(input:unknown):RequestAdmission {
  return boundaryInput(()=>{
    const v=record(snapshot(input),['requestId','roleId','nodeId','attemptId','purpose','repair','transportRetryOf','requestDigest','inputUpperBound','outputUpperBound','totalUpperBound','capability','operationId','targetIdentity']);
    const c=record(v.capability,['adapterId','adapterVersion','provider','model','kind','coversAllBillableTokens','enforcesOutputBound']);
    const capability:Capability={adapterId:text(c.adapterId),adapterVersion:text(c.adapterVersion),provider:text(c.provider),model:text(c.model),kind:enumeration(c.kind,['hard_bound','soft_only','unknown']),coversAllBillableTokens:boolean(c.coversAllBillableTokens),enforcesOutputBound:boolean(c.enforcesOutputBound)};
    const inputUpperBound=integer(v.inputUpperBound,'/inputUpperBound',1),outputUpperBound=integer(v.outputUpperBound,'/outputUpperBound',1),totalUpperBound=integer(v.totalUpperBound,'/totalUpperBound',1);
    if(totalUpperBound<checkedAdd(inputUpperBound,outputUpperBound))fail('INVALID_INPUT','/totalUpperBound');
    return {requestId:id(v.requestId),roleId:id(v.roleId),nodeId:id(v.nodeId),attemptId:id(v.attemptId),purpose:enumeration(v.purpose,['task','judge','reviewer','compaction','child']),repair:enumeration(v.repair,['none','format','implementation']),transportRetryOf:v.transportRetryOf===null?null:id(v.transportRetryOf),requestDigest:digest(v.requestDigest),inputUpperBound,outputUpperBound,totalUpperBound,capability,operationId:id(v.operationId),targetIdentity:text(v.targetIdentity,'/targetIdentity',1024)};
  });
}
export function modelIntent(input:RequestAdmission):ModelIntent {return {operationId:input.operationId,nodeId:input.nodeId,attemptId:input.attemptId,effect:'model_call',requestDigest:input.requestDigest,targetIdentity:input.targetIdentity};}
export function intent(input:unknown,allowModel=false):OperationIntent|ModelIntent {
  const v=record(snapshot(input),['operationId','nodeId','attemptId','effect','requestDigest','targetIdentity']);
  return {operationId:id(v.operationId),nodeId:id(v.nodeId),attemptId:id(v.attemptId),effect:enumeration(v.effect,allowModel?['read_only','local_write','external_write','model_call']:['read_only','local_write','external_write']),requestDigest:digest(v.requestDigest),targetIdentity:text(v.targetIdentity,'/targetIdentity',1024)};
}
export function exactValue(input:unknown,signed=false):ExactTotal {const v=record(input,['decimal','safeValue']);if(typeof v.decimal!=='string'||!(signed?/^-?(0|[1-9][0-9]{0,39})$/:/^(0|[1-9][0-9]{0,39})$/).test(v.decimal))fail('INVALID_INPUT');const expected=exact(BigInt(v.decimal));if(!equal(v,expected))fail('INVALID_INPUT');return expected;}
export function checkRole(data:Data,input:RequestAdmission):void {
  const spec=data.identity.lock.spec.contract.spec;const role=spec.roles.find(r=>r.id===input.roleId);
  if(!role)fail('INVALID_INPUT','/roleId');if(!spec.steps.some(step=>step.id===input.nodeId))fail('INVALID_INPUT','/nodeId');
  const c=input.capability;
  if(role.adapter!==c.adapterId||role.provider!==c.provider||role.model!==c.model||data.identity.binding.adapters.find(a=>a.id===role.adapter)?.version!==c.adapterVersion)fail('BINDING_MISMATCH','/capability');
  if(spec.budgets.enforcement.tokens==='hard_admission'&&(c.kind!=='hard_bound'||!c.coversAllBillableTokens||!c.enforcesOutputBound))fail('CAPABILITY_UNSUPPORTED','/capability');
  if(input.outputUpperBound>spec.budgets.perCallOutputTokens)fail('BUDGET_EXHAUSTED','/budgets/perCallOutputTokens');
}
export function reserve(data:Data,now:ClockSample,input:RequestAdmission):{created:boolean;record:RequestRecord} {
  const existing=data.requests.find(r=>r.admission.requestId===input.requestId);
  if(existing){if(!equal(existing.admission,input))fail('IDENTITY_CONFLICT','/requestId');return {created:false,record:existing};}
  if(data.operations.some(o=>o.intent.operationId===input.operationId))fail('IDENTITY_CONFLICT','/operationId');
  requireNewWork(data,now);checkRole(data,input);
  const limits=data.identity.lock.spec.contract.spec.budgets,l=data.ledger;
  if(l.admittedCalls>=limits.maxModelCalls)fail('BUDGET_EXHAUSTED','/budgets/maxModelCalls');
  const total=BigInt(l.chargedTokens.decimal)+BigInt(input.totalUpperBound);
  if(total>BigInt(Number.MAX_SAFE_INTEGER))fail('ARITHMETIC_OVERFLOW','/budgets/totalTokens');
  if(total>BigInt(limits.totalTokens))fail('BUDGET_EXHAUSTED','/budgets/totalTokens');
  if(l.heldSlots>=limits.maxConcurrency)fail('BUDGET_EXHAUSTED','/budgets/maxConcurrency');
  if(input.repair==='format'&&l.formatRepairs>=limits.maxFormatRepairs)fail('BUDGET_EXHAUSTED','/budgets/maxFormatRepairs');
  if(input.repair==='implementation'&&l.implementationRepairs>=limits.maxImplementationRepairs)fail('BUDGET_EXHAUSTED','/budgets/maxImplementationRepairs');
  if(input.transportRetryOf!==null&&l.transportRetries>=limits.maxTransportRetries)fail('BUDGET_EXHAUSTED','/budgets/maxTransportRetries');
  if(input.transportRetryOf!==null){const prior=data.requests.find(r=>r.admission.requestId===input.transportRetryOf);if(!prior)fail('RECORD_NOT_FOUND','/transportRetryOf');
    if(prior.state==='reserved'||prior.state==='released'||prior.admission.nodeId!==input.nodeId||prior.admission.roleId!==input.roleId||prior.admission.attemptId===input.attemptId)fail('TRANSITION_INVALID','/transportRetryOf');}
  if(data.requests.length>=1024)fail('LIMIT_EXCEEDED','/requests');if(data.operations.length>=2048)fail('LIMIT_EXCEEDED','/operations');
  const request={sequence:data.requests.length+1,admission:input,admissionDigest:hash('request-input',input),admissionGeneration:data.owner.generation,state:'reserved' as const,dispatch:null,holdsSlot:true,chargedTokens:exact(BigInt(input.totalUpperBound)),initialObservation:null,resolution:null,unresolvedReason:null,violations:[]};
  const op=modelIntent(input);const operation={sequence:data.operations.length+1,intent:op,intentDigest:hash('operation-intent',op),intentGeneration:data.owner.generation,linkedRequestId:input.requestId,state:'intent' as const,dispatch:null,initialReceipt:null,reconciliation:null,unresolvedReason:null};
  data.requests.push(request);data.operations.push(operation);return {created:true,record:request};
}
export function findRequest(data:Data,requestId:string){const found=data.requests.find(r=>r.admission.requestId===requestId);if(!found)fail('RECORD_NOT_FOUND','/requestId');return found;}
export function findOperation(data:Data,operationId:string){const found=data.operations.find(r=>r.intent.operationId===operationId);if(!found)fail('RECORD_NOT_FOUND','/operationId');return found;}
/** Reconstruct owned, closed records and validate derived state before trusting balances. */
export function storedRequest(input:unknown):RequestRecord {
  const v=record(input,['sequence','admission','admissionDigest','admissionGeneration','state','dispatch','holdsSlot','chargedTokens','initialObservation','resolution','unresolvedReason','violations']);
  const state=enumeration(v.state,['reserved','released','dispatch_authorized','observed','unresolved']);const a=admission(v.admission);const amount=exactValue(v.chargedTokens);const details=storedReceiptState(v);
  const inputDigest=digest(v.admissionDigest);if(!equal(inputDigest,hash('request-input',a)))fail('STORE_CORRUPT');
  const request:RequestRecord={sequence:integer(v.sequence,'',1,1024),admission:a,admissionDigest:inputDigest,admissionGeneration:integer(v.admissionGeneration,'',1),state,chargedTokens:amount,...details};
  if(state==='reserved'||state==='released'){
    if(details.dispatch!==null||details.initialObservation!==null||details.resolution!==null||details.unresolvedReason!==null||details.violations.length!==0||details.holdsSlot!==(state==='reserved')||amount.decimal!==(state==='reserved'?String(a.totalUpperBound):'0'))fail('STORE_CORRUPT');
  }else{
    if(details.dispatch===null)fail('STORE_CORRUPT');
    if(state==='dispatch_authorized'){
      if(details.initialObservation!==null||details.resolution!==null||details.unresolvedReason!==null||details.violations.length!==0||!details.holdsSlot||amount.decimal!==String(a.totalUpperBound))fail('STORE_CORRUPT');
    }else{
      const expected=accounting(request);if(expected.state!==state||expected.holdsSlot!==details.holdsSlot||!equal(expected.chargedTokens,amount))fail('STORE_CORRUPT');
      if(state==='observed'&&details.unresolvedReason!==null)fail('STORE_CORRUPT');
      if(details.initialObservation===null&&details.resolution===null&&details.unresolvedReason===null)fail('STORE_CORRUPT');
      if(details.resolution!==null)consistentResolution(details.initialObservation,details.resolution);
      for(const observation of [details.initialObservation,details.resolution?.kind==='terminal_usage'?details.resolution.observation:null]){
        if(observation===null)continue;if(observation.usage.requestId!==a.requestId)fail('STORE_CORRUPT');
        if(boundViolation(request,observation)&&!details.violations.includes('reservation_exceeded'))fail('STORE_CORRUPT');
        if(knownTokens(observation)>BigInt(Number.MAX_SAFE_INTEGER)&&!details.violations.includes('usage_overflow'))fail('STORE_CORRUPT');
      }
    }
  }
  return request;
}
export function storedOperation(input:unknown):OperationRecord {
  const v=record(input,['sequence','intent','intentDigest','intentGeneration','linkedRequestId','state','dispatch','initialReceipt','reconciliation','unresolvedReason']);const i=intent(v.intent,true);const d=digest(v.intentDigest);if(!equal(d,hash('operation-intent',i)))fail('STORE_CORRUPT');
  return {sequence:integer(v.sequence,'',1,2048),intent:i,intentDigest:d,intentGeneration:integer(v.intentGeneration,'',1),linkedRequestId:v.linkedRequestId===null?null:id(v.linkedRequestId),state:enumeration(v.state,['intent','dispatch_uncertain','confirmed','unresolved','abandoned']),dispatch:dispatchRecord(v.dispatch),initialReceipt:v.initialReceipt===null?null:operationReceipt(v.initialReceipt),reconciliation:v.reconciliation===null?null:operationReceipt(v.reconciliation),unresolvedReason:v.unresolvedReason===null?null:enumeration(v.unresolvedReason,['timeout','cancellation','connection_lost','owner_lost'])};
}
export function validateLinks(data:Data):void {
  for(const [i,request] of data.requests.entries()){
    if(request.sequence!==i+1||request.admissionGeneration>data.owner.generation)fail('STORE_CORRUPT');checkRole(data,request.admission);
    const operation=data.operations.find(o=>o.intent.operationId===request.admission.operationId);
    if(!operation||operation.linkedRequestId!==request.admission.requestId||!equal(operation.intent,modelIntent(request.admission))||operation.intentGeneration!==request.admissionGeneration||!equal(operation.dispatch,request.dispatch))fail('STORE_CORRUPT');
    if(request.dispatch!==null&&(request.dispatch.generation<request.admissionGeneration||request.dispatch.generation>data.owner.generation||request.dispatch.revision>data.revision))fail('STORE_CORRUPT');
    const receipt=request.initialObservation===null?null:receiptFrom(request.initialObservation),reconciliation=request.resolution===null?null:resolutionReceipt(request.resolution);
    const expectedState=request.state==='reserved'?'intent':request.state==='released'?'abandoned':request.state==='dispatch_authorized'?'dispatch_uncertain':receipt!==null||reconciliation!==null?'confirmed':'unresolved';
    if(operation.state!==expectedState||!equal(operation.initialReceipt,receipt)||!equal(operation.reconciliation,reconciliation)||operation.unresolvedReason!==(expectedState==='unresolved'?request.unresolvedReason:null))fail('STORE_CORRUPT');
    if(request.initialObservation!==null)matchEvidence(data,operation,request.initialObservation.evidence);
    if(request.resolution!==null)matchEvidence(data,operation,request.resolution.kind==='terminal_usage'?request.resolution.observation.evidence:request.resolution.evidence);

  }
  const caps=data.identity.lock.spec.contract.spec.budgets;
  const charged=data.requests.reduce((n,r)=>n+BigInt(r.chargedTokens.decimal),0n);
  if(charged>BigInt(caps.totalTokens)&&!data.requests.some(r=>r.violations.includes('budget_exceeded')))fail('STORE_CORRUPT');
  if(data.requests.length>caps.maxModelCalls||data.requests.filter(r=>r.admission.repair==='format').length>caps.maxFormatRepairs||data.requests.filter(r=>r.admission.repair==='implementation').length>caps.maxImplementationRepairs||data.requests.filter(r=>r.admission.transportRetryOf!==null).length>caps.maxTransportRetries||data.requests.filter(r=>r.holdsSlot).length>caps.maxConcurrency)fail('STORE_CORRUPT');
  for(const [i,operation] of data.operations.entries()){
    if(operation.sequence!==i+1||operation.intentGeneration>data.owner.generation)fail('STORE_CORRUPT');
    if(operation.linkedRequestId!==null){if(!data.requests.some(r=>r.admission.requestId===operation.linkedRequestId&&r.admission.operationId===operation.intent.operationId))fail('STORE_CORRUPT');continue;}
    if(operation.intent.effect==='model_call'||!data.identity.lock.spec.contract.spec.steps.some(step=>step.id===operation.intent.nodeId))fail('STORE_CORRUPT');
    if(operation.state==='intent'){
      if(operation.dispatch!==null||operation.initialReceipt!==null||operation.reconciliation!==null||operation.unresolvedReason!==null)fail('STORE_CORRUPT');continue;
    }
    if(operation.dispatch===null||operation.dispatch.generation<operation.intentGeneration||operation.dispatch.generation>data.owner.generation||operation.dispatch.revision>data.revision)fail('STORE_CORRUPT');
    if(operation.state==='dispatch_uncertain'&&(operation.initialReceipt!==null||operation.reconciliation!==null||operation.unresolvedReason!==null))fail('STORE_CORRUPT');
    if(operation.state==='unresolved'&&(operation.initialReceipt!==null||operation.reconciliation!==null||operation.unresolvedReason===null))fail('STORE_CORRUPT');
    if(operation.state==='confirmed'&&(operation.unresolvedReason!==null||(operation.initialReceipt===null&&operation.reconciliation===null)))fail('STORE_CORRUPT');
    if(operation.state==='abandoned')fail('STORE_CORRUPT');
    if(operation.initialReceipt!==null)matchEvidence(data,operation,operation.initialReceipt.evidence);
    if(operation.reconciliation!==null)matchEvidence(data,operation,operation.reconciliation.evidence);
    if(operation.initialReceipt!==null&&operation.reconciliation!==null&&!equal(operation.initialReceipt,operation.reconciliation))fail('STORE_CORRUPT');
  }
}
