/* global Buffer */
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync,writeFileSync,existsSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {allocateCopiedCollectorIncident} from './native-collector-incident.mjs';
import {NativeLedger,charges,validateBudget} from './native-ledger.mjs';
import {canonical,sha,exclusive,localOwner,checkedRef} from './native-context.mjs';
const actual=resolve('.claude/s04-qualification/budget.json'),before=readFileSync(actual);
function fixture(owner){
  const directory=mkdtempSync(resolve('.claude/s04-development/collector-incident-')),path=join(directory,'budget.json'),book=JSON.parse(before);
  const allocated=book.qualificationReservations.entries.find(row=>row.state==='allocated_unknown');if(allocated)Object.assign(book,JSON.parse(checkedRef(allocated.administrative.original)));
  book.qualificationReservations.mode='offline';if(owner)book.qualificationReservations.entries[0].owner=owner;
  const original=Buffer.from(canonical(book)+'\n');writeFileSync(path,original,{mode:0o600});const reservation=book.qualificationReservations.entries[0];
  const approval=exclusive(join(directory,'approval.txt'),'copied control; not real authority'),closure=exclusive(join(directory,'closure.json'),{scope:'copied control only',closed:true});
  return {path,directory,original,reservation,options:{path,directory,bookSha:sha(original),reservationId:reservation.id,owner:reservation.owner,approval},observe:()=>closure};
}

test('administrative allocation retains full caps exactly once, unknown actuals and absent original seal while retiring dead scheduling exclusion',()=>{
  const f=fixture(),initial=charges(validateBudget(JSON.parse(f.original))),result=allocateCopiedCollectorIncident(f.options,f.observe),value=validateBudget(JSON.parse(readFileSync(f.path))),row=value.qualificationReservations.entries[0],planes=charges(value);
  assert.equal(row.state,'allocated_unknown');assert.equal(row.actual,null);assert.equal(row.seal,null);assert.deepEqual(planes.allocated,f.reservation.caps);assert.deepEqual(planes.upper,initial.upper);assert.equal(value.native.seconds.initial,JSON.parse(f.original).native.seconds.initial+result.seconds);
  const next=readFileSync(f.path);assert.throws(()=>allocateCopiedCollectorIncident(f.options,f.observe),/DISPOSITION/);assert.deepEqual(readFileSync(f.path),next);
  const handle=new NativeLedger(f.path).reserve({...f.reservation.context,sourceDigest:'a'.repeat(64)},{provider:1,mcp:0,containers:1});assert.ok(handle);assert.equal(charges(JSON.parse(readFileSync(f.path))).upper.provider,initial.upper.provider+1);
});

test('live or mismatching original owner refuses before disposition and leaves original bytes unchanged',()=>{
  for(const live of [false,true]){const f=fixture(live?localOwner():undefined);if(!live)f.options.owner={...f.options.owner,birth:'wrong birth'};
    assert.throws(()=>allocateCopiedCollectorIncident(f.options,f.observe),/DISPOSITION/);assert.deepEqual(readFileSync(f.path),f.original);assert.equal(existsSync(join(f.directory,'disposition.json')),false);
  }
});

test('partial commit stays fenced before and after rename and cannot admit replacement capacity',()=>{
  for(const point of ['before_commit','after_commit']){const f=fixture();assert.throws(()=>allocateCopiedCollectorIncident(f.options,f.observe,stage=>{if(stage===point)throw Error(point);}),new RegExp(point));assert.equal(existsSync(f.path+'.lock'),true);assert.throws(()=>new NativeLedger(f.path).reserve(f.reservation.context,{provider:1,mcp:0,containers:1}),/LOCK_HELD/);if(point==='before_commit')assert.deepEqual(readFileSync(f.path),f.original);}
});

test('allocated unknown cannot be rewritten as zero actuals or a refunded allocation',()=>{
  const f=fixture();allocateCopiedCollectorIncident(f.options,f.observe);const book=JSON.parse(readFileSync(f.path));book.qualificationReservations.entries[0].actual={provider:0,mcp:0,containers:0};assert.throws(()=>validateBudget(book),/ADMINISTRATIVE/);assert.deepEqual(readFileSync(actual),before);
});
