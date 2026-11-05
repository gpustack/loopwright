import { test } from 'node:test';
import { fixture, good } from './fixtures.js';
test('a fresh run grants one current fenced owner',()=>{const f=fixture();try{const s=f.create();try{const owner=good(s.claim({ownerId:'owner-1',expectedGeneration:0,expectedRevision:0,mode:'active'}));good(s.inspect());if(owner.authority.generation!==1)throw Error('generation must advance');}finally{s.close();}}finally{f.cleanup();}});

import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { ownedChild } from './child.js';
import { type OwnerView, type StateResult } from '../src/index.js';
import { errorCode } from './fixtures.js';

test('owner release fences the old token and every ordinary retry checks current authority',()=>{
  const f=fixture();try{const s=f.create();try{const first=good(s.claim({ownerId:'owner-1',expectedGeneration:0,expectedRevision:0,mode:'active'}));errorCode(s.claim({ownerId:'owner-2',expectedGeneration:1,expectedRevision:1,mode:'active'}),'OWNER_HELD');errorCode(s.claim({ownerId:'owner-2',expectedGeneration:0,expectedRevision:0,mode:'active'}),'REVISION_CONFLICT');
    const released=good(s.release(first.authority));assert.equal(released.record.generation,2);errorCode(s.renew(first.authority),'STALE_OWNER');errorCode(s.release(first.authority),'STALE_OWNER');const second=good(s.claim({ownerId:'owner-2',expectedGeneration:2,expectedRevision:released.revision,mode:'active'}));assert.equal(second.authority.generation,3);assert.notEqual(second.authority.nonce,first.authority.nonce);
  }finally{s.close();}}finally{f.cleanup();}
});

test('two independent claimants behind an IPC barrier cannot both acquire authority',async()=>{
  const f=fixture();const initial=f.create();initial.close();const a=ownedChild(),b=ownedChild();
  try{await Promise.all([a.wait('ready'),b.wait('ready')]);a.send({action:'open',input:f.input});b.send({action:'open',input:f.input});const opened=await Promise.all([a.wait('opened'),b.wait('opened')]);const clockReceipts:unknown[]=[];for(let i=0;i<2;i++){const mail=opened[i]!;assert.equal((mail.result as {ok:boolean}).ok,true);const clock=mail.clock as {wallMs:number;monotonicMs:string};assert(BigInt(clock.monotonicMs)>=(i===0?a.before:b.before));const after=process.hrtime.bigint()/1000000n;assert(BigInt(clock.monotonicMs)<=after);clockReceipts.push({parentBefore:String(i===0?a.before:b.before),child:clock,parentAfter:String(after)});assert(Math.abs((clock.wallMs-Number(clock.monotonicMs))-(Date.now()-Number(process.hrtime.bigint()/1000000n)))<=1000);}
    a.send({action:'claim',ownerId:'owner-a',guard:{expectedGeneration:0,expectedRevision:0}});b.send({action:'claim',ownerId:'owner-b',guard:{expectedGeneration:0,expectedRevision:0}});const results=(await Promise.all([a.wait('claimed'),b.wait('claimed')])).map(m=>m.result as StateResult<OwnerView>);assert.equal(results.filter(r=>r.ok).length,1);for(const r of results)if(!r.ok)assert(['REVISION_CONFLICT','STORE_BUSY'].includes(r.error.code));
    console.log(JSON.stringify({case:'competing-owners',storeId:f.input.storeId,results:results.map(r=>r.ok?'acquired':r.error.code),clockDomain:f.input.binding.clockEpoch,clockReceipts,directory:f.input.directory,children:[a.child.pid,b.child.pid]}));
  }finally{const receipts=await Promise.all([a.stop(),b.stop()]);for(const r of receipts)assert.deepEqual([r.code,r.signal],[0,null]);console.log(JSON.stringify({case:'competing-owner-exits',receipts}));f.cleanup();}
});

test('old process stays alive after real lease expiry and takeover but its mutation fails',async()=>{
  const f=fixture();const parent=f.create();const old=ownedChild();try{await old.wait('ready');old.send({action:'open',input:f.input});await old.wait('opened');old.send({action:'claim',ownerId:'old-owner',guard:{expectedGeneration:0,expectedRevision:0}});const first=good((await old.wait('claimed')).result as StateResult<OwnerView>);
    const waitMs=Number(BigInt(first.leaseUntilMonotonicMs)-process.hrtime.bigint()/1000000n);if(waitMs>0)await delay(waitMs+10);assert(process.hrtime.bigint()/1000000n>=BigInt(first.leaseUntilMonotonicMs));
    const replacement=good(parent.claim({ownerId:'new-owner',expectedGeneration:first.authority.generation,expectedRevision:first.revision,mode:'active'}));old.send({action:'renew'});const stale=await old.wait('renewed');assert.equal(stale.pid,old.child.pid);assert.equal(stale.alive,true);errorCode(stale.result as StateResult<unknown>,'STALE_OWNER');assert.equal(replacement.authority.generation,2);
    console.log(JSON.stringify({case:'live-stale-owner',pid:old.child.pid,result:stale.result,currentGeneration:replacement.authority.generation,revision:replacement.revision,leaseUntilMonotonicMs:first.leaseUntilMonotonicMs,nowMonotonicMs:String(process.hrtime.bigint()/1000000n),directory:f.input.directory}));
  }finally{parent.close();const exit=await old.stop();assert.deepEqual([exit.code,exit.signal],[0,null]);console.log(JSON.stringify({case:'stale-owner-exit',exit}));f.cleanup();}
});

import { DatabaseSync } from 'node:sqlite';
import { canonical, hash } from '../src/boundary.js';
import { reopenLocalRun } from '../src/index.js';
test('generation and revision overflow reject before committing authority changes',()=>{
  for(const column of ['generation','revision']){const f=fixture();try{f.create().close();const db=new DatabaseSync(f.path);const row=db.prepare('SELECT * FROM run').get()!;row[column]=Number.MAX_SAFE_INTEGER;delete row.record_digest;const digest=hash('run-record',row).hex;db.prepare(`UPDATE run SET ${column}=?,record_digest=?`).run(Number.MAX_SAFE_INTEGER,digest);db.close();const store=good(reopenLocalRun(f.input));try{const before=good(store.inspect());errorCode(store.claim({ownerId:'owner-1',expectedGeneration:before.owner.generation,expectedRevision:before.revision,mode:'active'}),'ARITHMETIC_OVERFLOW');const after=good(store.inspect());assert.equal(after.revision,before.revision);assert.equal(canonical(after.owner),canonical(before.owner));}finally{store.close();}}finally{f.cleanup();}}
});
test('closed handles take precedence over invalid mutation input',()=>{const f=fixture();try{const store=f.create();store.close();errorCode(store.claim(null as never),'STORE_CLOSED');errorCode(store.renew(null as never),'STORE_CLOSED');}finally{f.cleanup();}});
