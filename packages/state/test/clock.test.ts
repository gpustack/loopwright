import assert from 'node:assert/strict';
import { test } from 'node:test';
import { admitTask } from '@loopwright/core';
import { contract, value } from '../../core/test/fixtures.js';
import { Connection, openInternal } from '../src/connection.js';
import { LocalRunStore } from '../src/store.js';
import type { ClockSample, LocalRunIdentity } from '../src/index.js';
import { fixture, good, errorCode } from './fixtures.js';
function controlled(wallTimeMs=5000,leaseMs=10000){
  const f=fixture();const task=contract();task.spec.budgets.wallTimeMs=wallTimeMs;
  const input:LocalRunIdentity={...f.input,lock:value(admitTask(task,{admissionId:'admission-1',runId:'run-1'})),policy:{...f.input.policy,leaseMs}};
  let now:ClockSample={wallMs:100000,monotonicMs:'10000'};
  const deps={clock:()=>now};
  const connection:Connection=openInternal(input,'create',deps);const store=new LocalRunStore(connection);
  return {f,input,store,set:(wall:number,mono:number)=>{now={wallMs:wall,monotonicMs:String(mono)};},reopen:()=>new LocalRunStore(openInternal(input,'reopen',deps))};
}
test('cumulative drift rejects repeated individually tolerated steps and survives real-store reopen',()=>{
  for(const direction of [100,1900]){
    const c=controlled();try{let s=c.store;const owner=good(s.claim({ownerId:'owner-1',expectedGeneration:0,expectedRevision:0,mode:'active'}));const basis=good(s.inspect()).clock.basis;
      c.set(100000+direction,11000);good(s.renew(owner.authority));s.close();s=c.reopen();assert.deepEqual(good(s.inspect()).clock.basis,basis);
      const revision=good(s.inspect()).revision;c.set(100000+2*direction,12000);errorCode(s.renew(owner.authority),'CLOCK_UNTRUSTED');const blocked=good(s.inspect());assert.equal(blocked.revision,revision);assert.equal(blocked.clockStatus,'blocked');assert.deepEqual(blocked.clock.basis,basis);s.close();
      s=c.reopen();assert.equal(good(s.inspect()).clockStatus,'blocked');errorCode(s.claim({ownerId:'owner-2',expectedGeneration:1,expectedRevision:revision,mode:'recovery'}),'CLOCK_UNTRUSTED');s.close();
    }finally{c.store.close();c.f.cleanup();}
  }
});
test('monotonic task equality rejects active work despite civil lag within the envelope',()=>{
  const c=controlled();try{const owner=good(c.store.claim({ownerId:'owner-1',expectedGeneration:0,expectedRevision:0,mode:'active'}));for(let i=1;i<5;i++){c.set(100000+i*900,10000+i*1000);good(c.store.renew(owner.authority));}
    const released=good(c.store.release(owner.authority));c.set(104500,15000);errorCode(c.store.claim({ownerId:'owner-2',expectedGeneration:released.record.generation,expectedRevision:released.revision,mode:'active'}),'DEADLINE_EXCEEDED');
    const recovery=good(c.store.claim({ownerId:'owner-2',expectedGeneration:released.record.generation,expectedRevision:released.revision,mode:'recovery'}));assert.equal(recovery.mode,'recovery');assert.equal(good(c.store.inspect()).clock.remainingTaskMs.decimal,'0');
  }finally{c.store.close();c.f.cleanup();}
});
test('civil advance does not expire a live monotonic lease; equality does',()=>{
  const c=controlled(5000,1000);try{const first=good(c.store.claim({ownerId:'owner-1',expectedGeneration:0,expectedRevision:0,mode:'active'}));c.set(101500,10900);errorCode(c.store.claim({ownerId:'owner-2',expectedGeneration:1,expectedRevision:1,mode:'active'}),'OWNER_HELD');good(c.store.renew(first.authority));const renewed=good(c.store.inspect());assert.equal(renewed.owner.leaseUntilMonotonicMs,'11900');assert.equal(renewed.owner.leaseUntilMs,101900);
    c.set(101600,11900);errorCode(c.store.renew(first.authority),'OWNER_EXPIRED');const replacement=good(c.store.claim({ownerId:'owner-2',expectedGeneration:1,expectedRevision:2,mode:'active'}));assert.equal(replacement.authority.generation,2);errorCode(c.store.renew(first.authority),'STALE_OWNER');
  }finally{c.store.close();c.f.cleanup();}
});
test('renewal just before expiry keeps task basis; exactly at expiry cannot revive authority',()=>{
  for(const offset of [999,1000]){const c=controlled(5000,1000);try{const first=good(c.store.claim({ownerId:'owner-1',expectedGeneration:0,expectedRevision:0,mode:'active'}));const basis=good(c.store.inspect()).clock.basis;c.set(100900,10000+offset);if(offset===999){const next=good(c.store.renew(first.authority));assert.equal(next.leaseUntilMonotonicMs,'11999');assert.deepEqual(good(c.store.inspect()).clock.basis,basis);}else{errorCode(c.store.renew(first.authority),'OWNER_EXPIRED');good(c.store.claim({ownerId:'owner-2',expectedGeneration:1,expectedRevision:1,mode:'active'}));}}finally{c.store.close();c.f.cleanup();}}
});
test('bounded sampling jitter and cumulative threshold controls use one immutable basis',()=>{
  const c=controlled();try{const owner=good(c.store.claim({ownerId:'owner-1',expectedGeneration:0,expectedRevision:0,mode:'active'}));for(let i=1;i<=20;i++){c.set(100000+i*100+(i%2?2:-2),10000+i*100);good(c.store.renew(owner.authority));}c.set(103098,12100);good(c.store.renew(owner.authority));c.set(103200,12200);good(c.store.renew(owner.authority));const revision=good(c.store.inspect()).revision;c.set(103301,12300);errorCode(c.store.renew(owner.authority),'CLOCK_UNTRUSTED');assert.equal(good(c.store.inspect()).revision,revision);}finally{c.store.close();c.f.cleanup();}
});
test('adjacent civil rollback and monotonic decrease block mutations with no hidden commit',()=>{
  for(const [wall,mono] of [[99999,10001],[100001,9999]]){const c=controlled();try{const owner=good(c.store.claim({ownerId:'owner-1',expectedGeneration:0,expectedRevision:0,mode:'active'}));c.set(wall!,mono!);errorCode(c.store.renew(owner.authority),'CLOCK_UNTRUSTED');assert.equal(good(c.store.inspect()).revision,1);}finally{c.store.close();c.f.cleanup();}}
});
