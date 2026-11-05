import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { DatabaseSync } from 'node:sqlite';
import { reopenLocalRun, type DispatchResult, type Mutation, type OperationIntent, type OperationReceipt, type OwnerView, type RequestRecord, type RunView, type StateResult } from '../src/index.js';
import { checkpoint, errorCode, evidenceFor, fixture, good, observationFor, request } from './fixtures.js';
import { ownedChild, type Mail } from './child.js';

const crashCases=[
  {name:'before-reserve-commit',phase:'reserveRequest:before_commit',scenario:'reservation',calls:0,charge:'0',slots:0,state:null,revision:1},
  {name:'after-reserve-commit',phase:'reserveRequest:after_commit',scenario:'reservation',calls:1,charge:'100',slots:1,state:'reserved',revision:2},
  {name:'after-dispatch-marker',phase:'authorizeRequestDispatch:after_commit',scenario:'dispatch',calls:1,charge:'100',slots:1,state:'dispatch_authorized',revision:3},
  {name:'before-settlement-commit',phase:'observeRequest:before_commit',scenario:'settlement',calls:1,charge:'100',slots:1,state:'dispatch_authorized',revision:3},
  {name:'after-settlement-commit',phase:'observeRequest:after_commit',scenario:'settlement',calls:1,charge:'15',slots:0,state:'observed',revision:4},
  {name:'after-unknown-observation',phase:'observeRequest:after_commit',scenario:'unknown-observation',calls:1,charge:'100',slots:1,state:'unresolved',revision:4},
  {name:'after-known-termination-unknown-usage',phase:'observeRequest:after_commit',scenario:'known-termination',calls:1,charge:'100',slots:0,state:'unresolved',revision:4},
  {name:'after-checkpoint-commit',phase:'writeCheckpoint:after_commit',scenario:'checkpoint',calls:1,charge:'100',slots:1,state:'dispatch_authorized',revision:4},
] as const;
for(const scenario of crashCases)test(`real process crash ${scenario.name}`,async()=>{
  const f=fixture({},60000);const initial=f.create();const original=good(initial.inspect());initial.close();const child=ownedChild('state-process');let reopened:ReturnType<typeof f.create>|undefined;
  try{await child.wait('ready');child.send({action:'open',input:f.input,watch:scenario.phase});await child.wait('opened');child.send({action:'claim',ownerId:'crash-owner',guard:{expectedGeneration:0,expectedRevision:0}});const owner=good((await child.wait('claimed')).result as StateResult<OwnerView>);child.send({action:'scenario',scenario:scenario.scenario});const reached=await child.wait('barrier');assert.equal(reached.phase,scenario.phase);assert.equal(reached.pid,child.child.pid);assert.equal(reached.storeId,f.input.storeId);assert.equal(reached.runId,f.input.lock.spec.runId);assert.equal(child.child.kill('SIGKILL'),true);const exit=await child.exited;assert.deepEqual([exit.code,exit.signal],[null,'SIGKILL']);reopened=good(reopenLocalRun(f.input));const view=good(reopened.inspect());assert.equal(view.revision,scenario.revision);assert.equal(view.ledger.admittedCalls,scenario.calls);assert.equal(view.ledger.chargedTokens.decimal,scenario.charge);assert.equal(view.ledger.heldSlots,scenario.slots);assert.equal(view.counts.operations,scenario.calls);assert.equal(view.deadlineMs,original.deadlineMs);assert.equal(view.startedAtMs,original.startedAtMs);assert.deepEqual(view.clock.basis,original.clock.basis);assert(BigInt(view.clock.elapsedTaskMs.decimal)>=BigInt(original.clock.elapsedTaskMs.decimal));
    if(scenario.state===null){errorCode(reopened.getRequest('request-1'),'RECORD_NOT_FOUND');errorCode(reopened.getOperation('op-request-1'),'RECORD_NOT_FOUND');}
    else{const record=good(reopened.getRequest('request-1'));assert.equal(record.state,scenario.state);const duplicate=good(reopened.reserveRequest(owner.authority,request()));assert.equal(duplicate.kind,'existing');assert.equal('permit'in duplicate,false);if(record.dispatch!==null){const marker=good(reopened.authorizeRequestDispatch(owner.authority,'request-1'));assert.equal(marker.kind,'existing');assert.equal('permit'in marker,false);}if(scenario.name==='after-settlement-commit'){assert.equal(good(reopened.observeRequest(owner.authority,'request-1',observationFor(reopened))).kind,'existing');assert.equal(good(reopened.getOperation('op-request-1')).state,'confirmed');}}
    if(scenario.name==='after-checkpoint-commit'){const saved=good(reopened.getCheckpoint('checkpoint-1'));const facts=good(reopened.recoveryView(owner.authority,{checkpointId:saved.checkpointId,availableArtifacts:[saved.workspace]}));assert.equal(facts.current.ledger.chargedTokens.decimal,'100');assert.equal(facts.requiresReconciliation,true);assert.deepEqual(saved.clockBasis,original.clock.basis);}
    const db=new DatabaseSync(f.path,{readOnly:true});const physical=db.prepare('SELECT revision,identity_digest,ledger_root FROM run').get();db.close();assert.equal(physical?.revision,scenario.revision);
    console.log(JSON.stringify({case:scenario.name,scope:'same retained local store and process SIGKILL only',barrier:reached,exit,physical,asserted:{calls:scenario.calls,charge:scenario.charge,slots:scenario.slots,revision:scenario.revision,state:scenario.state,originalDeadlineRetained:true,noReplayPermit:true}}));
  }finally{reopened?.close();const exit=await child.stop();assert.deepEqual([exit.code,exit.signal],[null,'SIGKILL']);f.cleanup();}
});

type ResultMessage=StateResult<Mutation<RequestRecord>>;
async function call(child:ReturnType<typeof ownedChild>,message:Record<string,unknown>):Promise<Mail>{child.send({action:'call',...message});return child.wait('called');}
for(const kind of ['last-call','last-token','last-slot','same-id','conflicting-id'] as const)test(`independent reservation contention ${kind}`,async()=>{
  const budgets=kind==='last-call'?{maxModelCalls:1,maxConcurrency:1,maxImplementationRepairs:0,maxTransportRetries:0}:kind==='last-token'?{totalTokens:100}:kind==='last-slot'?{maxConcurrency:1}:{};
  const f=fixture(budgets,60000);const parent=f.create();const owner=good(parent.claim({ownerId:'shared-owner',expectedGeneration:0,expectedRevision:0,mode:'active'}));const a=ownedChild('state-process'),b=ownedChild('state-process');
  try{await Promise.all([a.wait('ready'),b.wait('ready')]);a.send({action:'open',input:f.input});b.send({action:'open',input:f.input});const ready=await Promise.all([a.wait('opened'),b.wait('opened')]);for(const message of ready){const view=message.view as RunView;assert.equal(view.ledger.admittedCalls,0);assert.equal(view.revision,owner.revision);}
    const shared=kind==='same-id'||kind==='conflicting-id';const inputs=[request(shared?'shared-id':'contender-a'),request(shared?'shared-id':'contender-b',kind==='conflicting-id'?{purpose:'judge'}:{})];
    const first=await Promise.all([call(a,{method:'reserveRequest',authority:owner.authority,request:inputs[0]}),call(b,{method:'reserveRequest',authority:owner.authority,request:inputs[1]})]);const results=first.map(m=>m.result as ResultMessage);
    for(let i=0;i<2;i++)if(!results[i]!.ok&&(results[i] as {ok:false;error:{code:string}}).error.code==='STORE_BUSY'){results[i]=(await call(i===0?a:b,{method:'reserveRequest',authority:owner.authority,request:inputs[i]})).result as ResultMessage;}
    const created=results.filter(r=>r.ok&&r.value.kind==='created');assert.equal(created.length,1);
    if(kind==='same-id'){assert.equal(results.filter(r=>r.ok&&r.value.kind==='existing').length,1);}else{const denial=results.find(r=>!r.ok)!;errorCode(denial,kind==='conflicting-id'?'IDENTITY_CONFLICT':'BUDGET_EXHAUSTED');if(!denial.ok&&kind.startsWith('last-'))assert.equal(denial.error.path,kind==='last-call'?'/budgets/maxModelCalls':kind==='last-token'?'/budgets/totalTokens':'/budgets/maxConcurrency');}
    const view=good(parent.inspect());assert.equal(view.ledger.admittedCalls,1);assert.equal(view.ledger.chargedTokens.decimal,'100');assert.equal(view.ledger.heldSlots,1);assert.equal(view.counts.requests,1);assert.equal(view.counts.operations,1);for(const result of results)if(result.ok)assert.equal('permit'in result.value,false);
    console.log(JSON.stringify({case:`contention-${kind}`,directory:f.input.directory,storeId:f.input.storeId,runId:f.input.lock.spec.runId,generation:owner.authority.generation,readyRevision:owner.revision,children:[a.child.pid,b.child.pid],outcomes:results.map(r=>r.ok?r.value.kind:{code:r.error.code,path:r.error.path}),asserted:{calls:1,charge:'100',slots:1,operations:1},revision:view.revision}));
  }finally{parent.close();const exits=await Promise.all([a.stop(),b.stop()]);for(const exit of exits)assert.deepEqual([exit.code,exit.signal],[0,null]);console.log(JSON.stringify({case:`contention-${kind}-exits`,exits}));f.cleanup();}
});

test('independent dispatch and release race cannot both grant and refund one reservation',async()=>{
  const f=fixture({},60000);const parent=f.create();const owner=good(parent.claim({ownerId:'shared-owner',expectedGeneration:0,expectedRevision:0,mode:'active'}));good(parent.reserveRequest(owner.authority,request()));const a=ownedChild('state-process'),b=ownedChild('state-process');
  try{await Promise.all([a.wait('ready'),b.wait('ready')]);a.send({action:'open',input:f.input});b.send({action:'open',input:f.input});await Promise.all([a.wait('opened'),b.wait('opened')]);const outcomes=await Promise.all([call(a,{method:'authorizeRequestDispatch',authority:owner.authority,requestId:'request-1'}),call(b,{method:'releaseReservation',authority:owner.authority,requestId:'request-1'})]);const grant=outcomes[0]!.result as StateResult<DispatchResult<RequestRecord>>,release=outcomes[1]!.result as ResultMessage;assert.equal([grant,release].filter(r=>r.ok).length,1);const record=good(parent.getRequest('request-1'));if(grant.ok){assert.equal(grant.value.kind,'new_dispatch');errorCode(release,'TRANSITION_INVALID');assert.equal(record.chargedTokens.decimal,'100');assert.equal(record.holdsSlot,true);}else{errorCode(grant,'TRANSITION_INVALID');good(release);assert.equal(record.state,'released');assert.equal(record.chargedTokens.decimal,'0');assert.equal(record.holdsSlot,false);}assert.equal(good(parent.inspect()).ledger.admittedCalls,1);console.log(JSON.stringify({case:'dispatch-release-race',children:[a.child.pid,b.child.pid],requestState:record.state,charge:record.chargedTokens.decimal,grants:grant.ok?1:0,refunds:release.ok?1:0}));
  }finally{parent.close();const exits=await Promise.all([a.stop(),b.stop()]);for(const exit of exits)assert.deepEqual([exit.code,exit.signal],[0,null]);console.log(JSON.stringify({case:'dispatch-release-exits',exits}));f.cleanup();}
});


test('live stale owner is fenced from every mutation family after real takeover',async()=>{
  const f=fixture({maxConcurrency:8});const parent=f.create();const old=ownedChild('state-process');
  try{
    await old.wait('ready');old.send({action:'open',input:f.input});await old.wait('opened');old.send({action:'claim',ownerId:'old-owner',guard:{expectedGeneration:0,expectedRevision:0}});
    const first=good((await old.wait('claimed')).result as StateResult<OwnerView>),token=first.authority;
    good(parent.reserveRequest(token,request('reserved')));good(parent.reserveRequest(token,request('dispatched')));good(parent.authorizeRequestDispatch(token,'dispatched'));
    const intent:OperationIntent={operationId:'standalone',nodeId:'build',attemptId:'attempt-1',effect:'external_write',requestDigest:{algorithm:'sha256',hex:'a'.repeat(64)},targetIdentity:'fixture/publisher'};
    good(parent.putIntent(token,intent));good(parent.putIntent(token,{...intent,operationId:'pending'}));good(parent.authorizeOperationDispatch(token,'standalone'));
    const observation=observationFor(parent,'dispatched'),receipt:OperationReceipt={receiptId:'receipt-1',evidence:evidenceFor(parent,'standalone'),outcome:'succeeded'};
    const saved=good(parent.writeCheckpoint(token,checkpoint(good(parent.inspect()).revision))).record;
    const remaining=Number(BigInt(first.leaseUntilMonotonicMs)-process.hrtime.bigint()/1000000n);if(remaining>0)await delay(remaining+10);
    assert(process.hrtime.bigint()/1000000n>=BigInt(first.leaseUntilMonotonicMs));const expired=good(parent.inspect());
    const replacement=good(parent.claim({ownerId:'new-owner',expectedGeneration:expired.owner.generation,expectedRevision:expired.revision,mode:'active'}));
    assert.equal(replacement.authority.generation,2);const before=good(parent.inspect());
    const messages:Record<string,unknown>[]=[
      {method:'renew'},{method:'release'},
      {method:'reserveRequest',request:request('new-request')},
      {method:'authorizeRequestDispatch',requestId:'reserved'},
      {method:'releaseReservation',requestId:'reserved'},
      {method:'markRequestUnresolved',requestId:'dispatched',reason:'owner_lost'},
      {method:'observeRequest',requestId:'dispatched',observation},
      {method:'reconcileRequest',requestId:'dispatched',resolution:{kind:'terminal_usage',observation}},
      {method:'putIntent',intent:{...intent,operationId:'new-operation'}},
      {method:'authorizeOperationDispatch',operationId:'pending'},
      {method:'markOperationUnresolved',operationId:'standalone',reason:'owner_lost'},
      {method:'recordOperationReceipt',operationId:'standalone',receipt},
      {method:'reconcileOperation',operationId:'standalone',receipt},
      {method:'writeCheckpoint',checkpoint:checkpoint(before.revision,'new-checkpoint')},
      {method:'recoveryView',checkpoint:checkpoint(before.revision,saved.checkpointId),availableArtifacts:[saved.workspace]},
    ];
    const results=[];
    for(const message of messages){const reply=await call(old,{...message,authority:token});assert.equal(reply.pid,old.child.pid);assert.equal(reply.alive,true);errorCode(reply.result as StateResult<unknown>,'STALE_OWNER');results.push({method:message.method,code:'STALE_OWNER',pid:reply.pid,alive:reply.alive});}
    const cas=await call(old,{method:'claim',ownerId:'old-owner',guard:{expectedGeneration:expired.owner.generation,expectedRevision:expired.revision}});errorCode(cas.result as StateResult<unknown>,'REVISION_CONFLICT');
    const facts=await call(old,{method:'getRequest',requestId:'reserved'});assert.equal(good(facts.result as StateResult<RequestRecord>).state,'reserved');
    const after=good(parent.inspect());assert.equal(after.revision,before.revision);assert.deepEqual(after.ledger,before.ledger);assert.deepEqual(after.counts,before.counts);assert.deepEqual(good(parent.getCheckpoint(saved.checkpointId)),saved);
    console.log(JSON.stringify({case:'every-live-stale-mutation',pid:old.child.pid,directory:f.input.directory,storeId:before.storeId,runId:before.runId,generation:before.owner.generation,revision:before.revision,expiredLease:first.leaseUntilMonotonicMs,takeover:replacement,results,cas:'REVISION_CONFLICT',factsRemainReadable:true,unchanged:true}));
  }finally{parent.close();const exit=await old.stop();assert.deepEqual([exit.code,exit.signal],[0,null]);console.log(JSON.stringify({case:'every-live-stale-mutation-exit',exit}));f.cleanup();}
});

test('real writer lock returns bounded STORE_BUSY and crash rollback preserves original ledger',async()=>{
  const f=fixture({},60000);const parent=f.create();const child=ownedChild('state-process');
  try{
    await child.wait('ready');child.send({action:'open',input:f.input,watch:'reserveRequest:before_commit'});await child.wait('opened');child.send({action:'claim',ownerId:'locked-owner',guard:{expectedGeneration:0,expectedRevision:0}});const owner=good((await child.wait('claimed')).result as StateResult<OwnerView>);
    child.send({action:'scenario',scenario:'reservation'});const barrier=await child.wait('barrier');const started=process.hrtime.bigint();errorCode(parent.reserveRequest(owner.authority,request('blocked-request')),'STORE_BUSY');const elapsedMs=Number(process.hrtime.bigint()-started)/1e6;
    assert(elapsedMs<3000,'busy_timeout must return rather than wait for parked writer');assert.equal(child.child.kill('SIGKILL'),true);const exit=await child.exited;assert.deepEqual([exit.code,exit.signal],[null,'SIGKILL']);const view=good(parent.inspect());assert.equal(view.revision,owner.revision);assert.equal(view.counts.requests,0);assert.equal(view.ledger.chargedTokens.decimal,'0');assert.equal(view.ledger.admittedCalls,0);
    good(parent.reserveRequest(owner.authority,request('blocked-request')));assert.equal(good(parent.inspect()).ledger.admittedCalls,1);
    console.log(JSON.stringify({case:'real-writer-busy',barrier,elapsedMs,configuredBusyTimeoutMs:250,exit,rollbackRevision:view.revision,retry:'created-once'}));
  }finally{parent.close();const exit=await child.stop();assert.deepEqual([exit.code,exit.signal],[null,'SIGKILL']);f.cleanup();}
});
