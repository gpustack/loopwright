import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fixture, good, request } from './fixtures.js';
test('reservation charges one shared attempt and linked intent without a dispatch permit',()=>{const f=fixture();try{const store=f.create();try{const owner=good(store.claim({ownerId:'owner-1',expectedGeneration:0,expectedRevision:0,mode:'active'}));const reserved=good(store.reserveRequest(owner.authority,request()));assert.equal(reserved.kind,'created');assert.equal('permit'in reserved,false);const view=good(store.inspect());assert.equal(view.ledger.admittedCalls,1);assert.equal(view.counts.operations,1);assert.equal(view.ledger.chargedTokens.decimal,'100');}finally{store.close();}}finally{f.cleanup();}});

import { errorCode } from './fixtures.js';
import { reopenLocalRun, type RequestAdmission, type StateErrorCode } from '../src/index.js';
import { LocalRunStore } from '../src/store.js';
import { openInternal } from '../src/connection.js';

test('identical retry, conflicting reuse and reopen never grant another reservation or permit',()=>{
  const f=fixture({},10000);try{let s=f.create();const owner=good(s.claim({ownerId:'owner-1',expectedGeneration:0,expectedRevision:0,mode:'active'}));const input=request();const first=good(s.reserveRequest(owner.authority,input));const duplicate=good(s.reserveRequest(owner.authority,structuredClone(input)));assert.equal(duplicate.kind,'existing');assert.equal(duplicate.revision,first.revision);assert.equal('permit'in duplicate,false);
    errorCode(s.reserveRequest(owner.authority,{...input,purpose:'judge'}),'IDENTITY_CONFLICT');errorCode(s.reserveRequest(owner.authority,request('request-2',{operationId:input.operationId})),'IDENTITY_CONFLICT');
    assert.equal(good(s.getOperation(input.operationId)).state,'intent');s.close();s=good(reopenLocalRun(f.input));assert.equal(good(s.reserveRequest(owner.authority,input)).kind,'existing');assert.equal(good(s.inspect()).ledger.admittedCalls,1);s.close();
  }finally{f.cleanup();}
});
test('never-dispatched release refunds charge and slot once, while lifetime counters remain',()=>{
  const f=fixture();try{const s=f.create();try{const owner=good(s.claim({ownerId:'owner-1',expectedGeneration:0,expectedRevision:0,mode:'active'}));const input=request();good(s.reserveRequest(owner.authority,input));const released=good(s.releaseReservation(owner.authority,input.requestId));assert.equal(released.record.state,'released');assert.equal(good(s.releaseReservation(owner.authority,input.requestId)).kind,'existing');assert.equal(good(s.getOperation(input.operationId)).state,'abandoned');const view=good(s.inspect());assert.equal(view.ledger.admittedCalls,1);assert.equal(view.ledger.heldSlots,0);assert.equal(view.ledger.chargedTokens.decimal,'0');assert.equal(view.ledger.unknownTokenRequests,0);assert.equal(good(s.reserveRequest(owner.authority,input)).record.state,'released');}finally{s.close();}}finally{f.cleanup();}
});
test('parent call, token and concurrency allowances are shared and failures leave no partial intent',()=>{
  for(const [budgets,expectedPath] of [[{maxModelCalls:2,maxConcurrency:2,maxImplementationRepairs:2},'/budgets/maxModelCalls'],[{totalTokens:250},'/budgets/totalTokens'],[{},'/budgets/maxConcurrency']] as const){
    const f=fixture(budgets);try{const s=f.create();try{const owner=good(s.claim({ownerId:'owner-1',expectedGeneration:0,expectedRevision:0,mode:'active'}));good(s.reserveRequest(owner.authority,request('request-1')));good(s.reserveRequest(owner.authority,request('request-2')));const before=good(s.inspect());const denial=s.reserveRequest(owner.authority,request('request-3'));errorCode(denial,'BUDGET_EXHAUSTED');if(!denial.ok)assert.equal(denial.error.path,expectedPath);const after=good(s.inspect());assert.deepEqual(after.counts,before.counts);assert.deepEqual(after.ledger,before.ledger);assert.equal(after.revision,before.revision);errorCode(s.getRequest('request-3'),'RECORD_NOT_FOUND');errorCode(s.getOperation('op-request-3'),'RECORD_NOT_FOUND');}finally{s.close();}}finally{f.cleanup();}
  }
});
test('all purpose classes and independent repair/retry caps consume the same lifetime allowance',()=>{
  const f=fixture();try{const s=f.create();try{const owner=good(s.claim({ownerId:'owner-1',expectedGeneration:0,expectedRevision:0,mode:'active'}));for(const [i,purpose] of (['task','judge','reviewer','compaction','child'] as const).entries()){const input=request(`purpose-${i}`,{purpose});good(s.reserveRequest(owner.authority,input));good(s.releaseReservation(owner.authority,input.requestId));}assert.equal(good(s.inspect()).ledger.admittedCalls,5);errorCode(s.reserveRequest(owner.authority,request('format',{repair:'format'})),'BUDGET_EXHAUSTED');for(let i=0;i<2;i++){const input=request(`repair-${i}`,{repair:'implementation'});good(s.reserveRequest(owner.authority,input));good(s.releaseReservation(owner.authority,input.requestId));}errorCode(s.reserveRequest(owner.authority,request('repair-3',{repair:'implementation'})),'BUDGET_EXHAUSTED');assert.equal(good(s.inspect()).ledger.implementationRepairs,2);}finally{s.close();}}finally{f.cleanup();}
  const zero=fixture({maxTransportRetries:0});try{const s=zero.create();try{const owner=good(s.claim({ownerId:'owner-1',expectedGeneration:0,expectedRevision:0,mode:'active'}));errorCode(s.reserveRequest(owner.authority,request('retry',{transportRetryOf:'missing'})),'BUDGET_EXHAUSTED');assert.equal(good(s.inspect()).ledger.admittedCalls,0);}finally{s.close();}}finally{zero.cleanup();}
});
test('hard capability, role binding, per-call bounds and arithmetic reject before charging',()=>{
  const f=fixture({enforcement:{wallTime:'hard_admission',tokens:'hard_admission',modelCalls:'hard_admission',concurrency:'hard_admission',formatRepairs:'hard_admission',implementationRepairs:'hard_admission',transportRetries:'hard_admission'}});
  try{const s=f.create();try{const owner=good(s.claim({ownerId:'owner-1',expectedGeneration:0,expectedRevision:0,mode:'active'}));const cases:[Partial<RequestAdmission>,StateErrorCode][]=[
    [{capability:{...request().capability,kind:'unknown'}},'CAPABILITY_UNSUPPORTED'],[{capability:{...request().capability,coversAllBillableTokens:false}},'CAPABILITY_UNSUPPORTED'],[{capability:{...request().capability,enforcesOutputBound:false}},'CAPABILITY_UNSUPPORTED'],[{capability:{...request().capability,model:'wrong-model'}},'BINDING_MISMATCH'],[{outputUpperBound:101,totalUpperBound:181},'BUDGET_EXHAUSTED'],[{roleId:'missing'},'INVALID_INPUT'],[{inputUpperBound:Number.MAX_SAFE_INTEGER,outputUpperBound:1,totalUpperBound:Number.MAX_SAFE_INTEGER},'ARITHMETIC_OVERFLOW']];
    for(const [patch,expected] of cases)errorCode(s.reserveRequest(owner.authority,request('invalid',patch)),expected);assert.equal(good(s.inspect()).ledger.admittedCalls,0);
  }finally{s.close();}}finally{f.cleanup();}
});
test('real transaction rollback keeps reservation, counters and paired intent atomic',()=>{
  const f=fixture({},10000);let failOnce=true;try{const s=new LocalRunStore(openInternal(f.input,'create',{onBoundary:event=>{if(event.phase==='reserveRequest:before_commit'&&failOnce){failOnce=false;throw Error('injected before-commit observation');}}}));try{const owner=good(s.claim({ownerId:'owner-1',expectedGeneration:0,expectedRevision:0,mode:'active'}));const before=good(s.inspect());errorCode(s.reserveRequest(owner.authority,request()),'STORE_UNAVAILABLE');const after=good(s.inspect());assert.equal(after.revision,before.revision);assert.deepEqual(after.ledger,before.ledger);assert.equal(after.counts.operations,0);good(s.reserveRequest(owner.authority,request()));assert.equal(good(s.inspect()).counts.operations,1);}finally{s.close();}}finally{f.cleanup();}
});
test('lost reservation commit acknowledgement poisons handle and retains one durable charge',()=>{
  const f=fixture({},10000);try{const s=new LocalRunStore(openInternal(f.input,'create',{onBoundary:event=>{if(event.phase==='reserveRequest:after_commit')throw Error('synthetic lost acknowledgement');}}));const owner=good(s.claim({ownerId:'owner-1',expectedGeneration:0,expectedRevision:0,mode:'active'}));const outcome=s.reserveRequest(owner.authority,request());errorCode(outcome,'COMMIT_UNKNOWN');if(!outcome.ok)assert.equal(outcome.error.commit,'unknown');errorCode(s.inspect(),'STORE_CLOSED');s.close();const reopened=good(reopenLocalRun(f.input));try{const view=good(reopened.inspect());assert.equal(view.ledger.admittedCalls,1);assert.equal(view.ledger.chargedTokens.decimal,'100');assert.equal(view.counts.operations,1);assert.equal(good(reopened.reserveRequest(owner.authority,request())).kind,'existing');}finally{reopened.close();}}finally{f.cleanup();}
});

test('elapsed task deadline blocks new admission but duplicate lookup and guarded release remain possible',()=>{
  const f=fixture({wallTimeMs:5000},10000);let now={wallMs:100000,monotonicMs:'10000'};try{let s=new LocalRunStore(openInternal(f.input,'create',{clock:()=>now}));const owner=good(s.claim({ownerId:'owner-1',expectedGeneration:0,expectedRevision:0,mode:'active'}));good(s.reserveRequest(owner.authority,request()));s.close();now={wallMs:104500,monotonicMs:'15000'};s=new LocalRunStore(openInternal(f.input,'reopen',{clock:()=>now}));try{const before=good(s.inspect());assert.equal(good(s.reserveRequest(owner.authority,request())).kind,'existing');errorCode(s.reserveRequest(owner.authority,request('late')),'DEADLINE_EXCEEDED');assert.equal(good(s.inspect()).revision,before.revision);good(s.releaseReservation(owner.authority,'request-1'));assert.equal(good(s.inspect()).ledger.admittedCalls,1);assert.equal(good(s.inspect()).ledger.chargedTokens.decimal,'0');}finally{s.close();}}finally{f.cleanup();}
});
test('soft-only capability remains explicit and cannot create a fresh local allowance',()=>{const f=fixture();try{const s=f.create();try{const owner=good(s.claim({ownerId:'owner-1',expectedGeneration:0,expectedRevision:0,mode:'active'}));const admitted=good(s.reserveRequest(owner.authority,request('soft',{capability:{...request().capability,kind:'soft_only',coversAllBillableTokens:false,enforcesOutputBound:false}})));assert.equal(admitted.record.admission.capability.kind,'soft_only');assert.equal(good(s.inspect()).ledger.chargedTokens.decimal,'100');}finally{s.close();}}finally{f.cleanup();}});


function unchangedAdmissionError(store:LocalRunStore,authority:Parameters<LocalRunStore['reserveRequest']>[0],input:RequestAdmission,code:StateErrorCode,path:string):void {
  const before=good(store.inspect()),requests=good(store.listRequests({limit:100,cursor:null})),operations=good(store.listOperations({limit:100,cursor:null}));
  const denied=store.reserveRequest(authority,input);errorCode(denied,code);
  if(!denied.ok){assert.equal(denied.error.path,path);assert.equal(denied.error.commit,'not_committed');}
  const after=good(store.inspect());assert.equal(after.revision,before.revision);assert.deepEqual(after.ledger,before.ledger);assert.deepEqual(after.counts,before.counts);assert.deepEqual(after.owner,before.owner);assert.equal(after.deadlineMs,before.deadlineMs);assert.deepEqual(after.clock.basis,before.clock.basis);
  assert.deepEqual(good(store.listRequests({limit:100,cursor:null})),requests);assert.deepEqual(good(store.listOperations({limit:100,cursor:null})),operations);
}

test('mixed admission precedence rejects insufficient hard capability before the output cap',()=>{
  const f=fixture({enforcement:{wallTime:'hard_admission',tokens:'hard_admission',modelCalls:'hard_admission',concurrency:'hard_admission',formatRepairs:'hard_admission',implementationRepairs:'hard_admission',transportRetries:'hard_admission'}},10000);
  try{const store=f.create();try{
    const owner=good(store.claim({ownerId:'owner-1',expectedGeneration:0,expectedRevision:0,mode:'active'}));
    const soft={...request().capability,kind:'soft_only' as const,coversAllBillableTokens:false,enforcesOutputBound:false};
    unchangedAdmissionError(store,owner.authority,request('mixed',{outputUpperBound:101,totalUpperBound:181,capability:soft}),'CAPABILITY_UNSUPPORTED','/capability');
    unchangedAdmissionError(store,owner.authority,request('capability-only',{capability:soft}),'CAPABILITY_UNSUPPORTED','/capability');
    unchangedAdmissionError(store,owner.authority,request('cap-only',{outputUpperBound:101,totalUpperBound:181}),'BUDGET_EXHAUSTED','/budgets/perCallOutputTokens');
    const first=good(store.reserveRequest(owner.authority,request('valid'))),before=good(store.inspect());
    const duplicate=good(store.reserveRequest(owner.authority,request('valid')));assert.equal(duplicate.kind,'existing');assert.equal(duplicate.revision,first.revision);assert.equal('permit'in duplicate,false);assert.deepEqual(good(store.inspect()).ledger,before.ledger);
  }finally{store.close();}}finally{f.cleanup();}
});

test('mixed admission precedence resolves request and operation identities before recovery mode',()=>{
  const f=fixture({},10000);
  try{const store=f.create();try{
    const firstOwner=good(store.claim({ownerId:'owner-1',expectedGeneration:0,expectedRevision:0,mode:'active'}));const input=request();good(store.reserveRequest(firstOwner.authority,input));
    const released=good(store.release(firstOwner.authority));const owner=good(store.claim({ownerId:'recovery-owner',expectedGeneration:released.record.generation,expectedRevision:released.revision,mode:'recovery'}));
    unchangedAdmissionError(store,owner.authority,request('mixed',{operationId:input.operationId}),'IDENTITY_CONFLICT','/operationId');
    unchangedAdmissionError(store,owner.authority,request('mode-only'),'TRANSITION_INVALID','/owner/mode');
    unchangedAdmissionError(store,owner.authority,{...input,purpose:'judge'},'IDENTITY_CONFLICT','/requestId');
    unchangedAdmissionError(store,firstOwner.authority,request('stale',{operationId:input.operationId}),'STALE_OWNER','');
    const before=good(store.inspect()),priorRequest=good(store.getRequest(input.requestId)),priorOperation=good(store.getOperation(input.operationId));
    const duplicate=good(store.reserveRequest(owner.authority,structuredClone(input)));assert.equal(duplicate.kind,'existing');assert.equal(duplicate.revision,before.revision);assert.equal('permit'in duplicate,false);assert.deepEqual(duplicate.record,priorRequest);assert.deepEqual(good(store.getOperation(input.operationId)),priorOperation);assert.deepEqual(good(store.inspect()).ledger,before.ledger);assert.deepEqual(good(store.inspect()).counts,before.counts);
  }finally{store.close();}}finally{f.cleanup();}
});
