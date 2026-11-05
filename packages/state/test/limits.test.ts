import assert from 'node:assert/strict';
import { test } from 'node:test';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Connection, configure } from '../src/connection.js';
import { LocalRunStore } from '../src/store.js';
import { errorCode, fixture, good, request } from './fixtures.js';

test('real SQLite FULL confirms rollback and retains the last committed ledger',()=>{
  const f=fixture({},60000);let store:LocalRunStore|undefined;
  try{f.create().close();const db=new DatabaseSync(f.path,{timeout:250,allowExtension:false,defensive:true,enableForeignKeyConstraints:true,enableDoubleQuotedStringLiterals:false});configure(db,false);store=new LocalRunStore(new Connection(db,f.input));const owner=good(store.claim({ownerId:'owner-1',expectedGeneration:0,expectedRevision:0,mode:'active'}));const pages=Number(db.prepare('PRAGMA page_count').get()!.page_count);db.exec(`PRAGMA max_page_count=${pages}`);
    let failed:string|null=null;let before=good(store.inspect());
    for(let i=0;i<10;i++){before=good(store.inspect());const key=`full-${i}`;const outcome=store.reserveRequest(owner.authority,request(key,{targetIdentity:'x'.repeat(1024)}));if(!outcome.ok){errorCode(outcome,'STORE_FULL');assert.equal(outcome.error.commit,'not_committed');failed=key;break;}good(store.releaseReservation(owner.authority,key));}
    assert.notEqual(failed,null,'actual bounded SQLite database must hit FULL before the attempt cap');assert.equal(db.isTransaction,false);const after=good(store.inspect());assert.equal(after.revision,before.revision);assert.deepEqual(after.ledger,before.ledger);assert.deepEqual(after.counts,before.counts);db.exec('PRAGMA max_page_count=65536');good(store.reserveRequest(owner.authority,request(failed!,{targetIdentity:'x'.repeat(1024)})));assert.equal(good(store.inspect()).ledger.admittedCalls,before.ledger.admittedCalls+1);
    console.log(JSON.stringify({case:'sqlite-full',pages,failedRequestId:failed,rollbackConfirmed:true,priorRevision:before.revision,retryCommittedOnce:true,scope:'actual owned local SQLite quota fixture; no global disk exhaustion'}));
  }finally{store?.close();f.cleanup();}
});

test('real native auto-rollback before commit is a confirmed unavailable transaction, not an unknown commit',()=>{
  const f=fixture({},60000);let store:LocalRunStore|undefined;
  try{f.create().close();const db=new DatabaseSync(f.path);configure(db,false);let aborted=false;
    store=new LocalRunStore(new Connection(db,f.input,{onBoundary:event=>{if(event.phase==='reserveRequest:before_commit'){try{db.exec('UPDATE OR ROLLBACK store_meta SET singleton=2 WHERE singleton=1');}catch(error){aborted=!db.isTransaction;throw error;}}}}));
    const owner=good(store.claim({ownerId:'owner-1',expectedGeneration:0,expectedRevision:0,mode:'active'}));const before=good(store.inspect());const result=store.reserveRequest(owner.authority,request());assert.equal(aborted,true);errorCode(result,'STORE_UNAVAILABLE');const after=good(store.inspect());assert.equal(after.revision,before.revision);assert.deepEqual(after.ledger,before.ledger);assert.equal(after.counts.requests,0);assert.equal(after.counts.operations,0);
  }finally{store?.close();f.cleanup();}
});

import { openInternal } from '../src/connection.js';
import { checkpoint, observationFor } from './fixtures.js';
import { hash, exact } from '../src/boundary.js';
import { modelIntent } from '../src/admission.js';
import type { OperationIntent } from '../src/index.js';

function controlledStore(budgets:Parameters<typeof fixture>[0]={}){const f=fixture(budgets,60000);const clock=()=>({wallMs:100000,monotonicMs:'10000'});const connection=openInternal(f.input,'create',{clock});const store=new LocalRunStore(connection);const owner=good(store.claim({ownerId:'owner-1',expectedGeneration:0,expectedRevision:0,mode:'active'}));return {f,connection,store,owner};}

test('1024 synthetic pending requests remain retained at the real-store lifetime limit',()=>{
  const c=controlledStore({maxModelCalls:2048,maxConcurrency:2048,totalTokens:204800});try{
    c.connection.mutate('fixture-1024',c.owner.authority,(data)=>{for(let i=0;i<1024;i++){const input=request(`limit-${i}`);const intent=modelIntent(input);const dispatch={generation:data.owner.generation,dispatchId:`dispatch-${i.toString(16).padStart(32,'0')}`,revision:data.revision+1};data.requests.push({sequence:i+1,admission:input,admissionDigest:hash('request-input',input),admissionGeneration:data.owner.generation,state:'dispatch_authorized',dispatch,holdsSlot:true,chargedTokens:exact(100n),initialObservation:null,resolution:null,unresolvedReason:null,violations:[]});data.operations.push({sequence:i+1,intent,intentDigest:hash('operation-intent',intent),intentGeneration:data.owner.generation,linkedRequestId:input.requestId,state:'dispatch_uncertain',dispatch:{...dispatch},initialReceipt:null,reconciliation:null,unresolvedReason:null});}return {changed:true,finish:()=>null};});
    const before=good(c.store.inspect());assert.equal(before.counts.requests,1024);assert.equal(before.ledger.heldSlots,1024);assert.equal(before.ledger.chargedTokens.decimal,'102400');errorCode(c.store.reserveRequest(c.owner.authority,request('overflow')),'LIMIT_EXCEEDED');assert.equal(good(c.store.reserveRequest(c.owner.authority,request('limit-0'))).kind,'existing');errorCode(c.store.releaseReservation(c.owner.authority,'limit-0'),'TRANSITION_INVALID');assert.deepEqual(good(c.store.inspect()).ledger,before.ledger);good(c.store.observeRequest(c.owner.authority,'limit-0',observationFor(c.store,'limit-0')));const after=good(c.store.inspect());assert.equal(after.counts.requests,1024);assert.equal(after.ledger.heldSlots,1023);assert.equal(after.counts.observedRequests,1);
    console.log(JSON.stringify({case:'request-retention-limit',scope:'synthetic valid fixture rows in real SQLite; not 1024 provider admissions',requests:after.counts.requests,pendingSlots:after.ledger.heldSlots,settlementAtLimit:true}));
  }finally{c.store.close();c.f.cleanup();}
});
test('2048 unresolved operations are never pruned and inspection respects count and encoded-byte page limits',()=>{
  const c=controlledStore();try{c.connection.mutate('fixture-2048',c.owner.authority,(data)=>{for(let i=0;i<2048;i++){const intent:OperationIntent={operationId:`limit-${i}`,nodeId:'build',attemptId:'attempt-1',effect:'external_write',requestDigest:{algorithm:'sha256',hex:'a'.repeat(64)},targetIdentity:'x'.repeat(1024)};data.operations.push({sequence:i+1,intent,intentDigest:hash('operation-intent',intent),intentGeneration:data.owner.generation,linkedRequestId:null,state:'unresolved',dispatch:{generation:data.owner.generation,dispatchId:`dispatch-${i.toString(16).padStart(32,'0')}`,revision:data.revision+1},initialReceipt:null,reconciliation:null,unresolvedReason:'owner_lost'});}return {changed:true,finish:()=>null};});
    const before=good(c.store.inspect());errorCode(c.store.putIntent(c.owner.authority,{operationId:'overflow',nodeId:'build',attemptId:'attempt-1',effect:'read_only',requestDigest:{algorithm:'sha256',hex:'a'.repeat(64)},targetIdentity:'fixture'}),'LIMIT_EXCEEDED');const first=good(c.store.listOperations({limit:100,cursor:null}));assert(first.items.length>0&&first.items.length<100);assert(Buffer.byteLength(JSON.stringify(first))<=131072);assert.notEqual(first.next,null);const second=good(c.store.listOperations({limit:100,cursor:first.next}));assert.equal(second.items[0]!.sequence,first.items.at(-1)!.sequence+1);assert.equal(good(c.store.inspect()).counts.unresolvedOperations,2048);assert.equal(good(c.store.inspect()).revision,before.revision);
    console.log(JSON.stringify({case:'operation-retention-limit',scope:'synthetic unresolved fixture rows in real SQLite',operations:2048,firstPageItems:first.items.length,firstPageBytes:Buffer.byteLength(JSON.stringify(first)),secondPageStart:second.items[0]!.sequence}));
  }finally{c.store.close();c.f.cleanup();}
});
test('64 real checkpoint publications reach their fixed lifetime cap without pruning earlier records',()=>{const c=controlledStore();try{for(let i=0;i<64;i++){const view=good(c.store.inspect());good(c.store.writeCheckpoint(c.owner.authority,checkpoint(view.revision,`checkpoint-${i}`)));}const before=good(c.store.inspect());errorCode(c.store.writeCheckpoint(c.owner.authority,checkpoint(before.revision,'overflow')),'LIMIT_EXCEEDED');assert.equal(good(c.store.getCheckpoint('checkpoint-0')).sequence,1);assert.equal(good(c.store.getCheckpoint('checkpoint-63')).sequence,64);assert.equal(good(c.store.inspect()).revision,before.revision);const page=good(c.store.listCheckpoints({limit:100,cursor:null}));assert(page.items.length<=64);assert(Buffer.byteLength(JSON.stringify(page))<=131072);}finally{c.store.close();c.f.cleanup();}});
test('oversized, cyclic and aliased inputs reject before authority or persistent mutation',()=>{const c=controlledStore();try{const before=good(c.store.inspect());const cycle:Record<string,unknown>={};cycle.child=cycle;errorCode(c.store.reserveRequest(c.owner.authority,cycle as never),'INVALID_INPUT');errorCode(c.store.reserveRequest(c.owner.authority,request('oversized',{targetIdentity:'x'.repeat(65537)})),'INVALID_INPUT');const input=checkpoint(before.revision);errorCode(c.store.writeCheckpoint(c.owner.authority,{...input,additionalArtifacts:Array.from({length:17},(_,i)=>({...input.workspace,digest:{...input.workspace.digest},name:`ref-${i}`}))}),'LIMIT_EXCEEDED');errorCode(c.store.writeCheckpoint(c.owner.authority,{...input,privateSession:input.workspace}),'INVALID_INPUT');const after=good(c.store.inspect());assert.equal(after.revision,before.revision);assert.deepEqual(after.counts,before.counts);}finally{c.store.close();c.f.cleanup();}});


test('production configuration verifies and enforces effective SQLite limits on create and reopen',()=>{
  const f=fixture();const path=join(f.parent,'configured.sqlite');
  try{for(const fresh of [true,false]){
    const db=new DatabaseSync(path);
    try{
      configure(db,fresh);
      const effective={length:db.limits.length,sqlLength:db.limits.sqlLength,attach:db.limits.attach};
      assert.deepEqual(effective,{length:2097152,sqlLength:65536,attach:0});
      assert.throws(()=>db.prepare('SELECT ?').get('x'.repeat(2097153)),{errcode:18});
      assert.throws(()=>db.prepare('SELECT 1'+ ' '.repeat(65536)),{errcode:18});
      assert.throws(()=>db.exec("ATTACH DATABASE ':memory:' AS extra"),{errcode:1});
      console.log(JSON.stringify({case:'effective-sqlite-limits',path,mode:fresh?'create':'reopen',effective,scope:'actual native connection through production configure; no synthetic mismatch dependency'}));
    }finally{db.close();}
  }}finally{f.cleanup();}
});
