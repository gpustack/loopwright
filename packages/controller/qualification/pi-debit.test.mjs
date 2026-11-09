/* global process, URL */
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,existsSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {execFileSync} from 'node:child_process';
import {charges} from './native-ledger.mjs';
import {debitS03Reservation,observeS03Container,mutateLegacyBudget} from './native-lock.mjs';
import {copiedS03Fixture} from './pi-copied-fixture.mjs';
import {canonical,localOwner} from './native-context.mjs';
const actual=resolve('.claude/s04-qualification/budget.json'),actualBefore=readFileSync(actual);

test('same held scope burns quota once before lower; no cap, original billing or prior allocation changes',()=>{
  const f=copiedS03Fixture(),before=charges(JSON.parse(readFileSync(f.path)));let lower=0;
  const call=()=>{f.debit(f.input('provider','original-dispatch',{id:'opaque'}));lower++;};call();assert.equal(lower,1);assert.equal(f.debit(f.input('provider','original-dispatch',{id:'opaque'})).existing,true);
  f.debit(f.input('provider','second'));assert.throws(()=>{f.debit(f.input('provider','third'));lower++;},/S03_SCOPE/);assert.equal(lower,1);assert.deepEqual(charges(JSON.parse(readFileSync(f.path))),before);assert.throws(()=>mutateLegacyBudget(f.path,localOwner(),v=>v),/PARENT_TIME_PENDING/);
});
test('real nested Node processes debit the same original pending fence and cannot reset its exhausted quota',()=>{
  const f=copiedS03Fixture(),script=join(f.directory,'nested.mjs'),lock=fileURLToPath(new URL('./native-lock.mjs',import.meta.url));
  writeFileSync(script,`import {debitS03Reservation} from ${JSON.stringify(lock)};import {execFileSync} from 'node:child_process';const data=JSON.parse(process.argv[2]);debitS03Reservation(data.path,data.input,{copied:true});if(process.argv[3]!=='leaf')execFileSync(process.execPath,[process.argv[1],JSON.stringify({...data,input:{...data.input,key:'grandchild'}}),'leaf'],{stdio:'pipe'});`,{mode:0o600});
  execFileSync(process.execPath,[script,JSON.stringify({path:f.path,input:f.input('provider','child')})],{timeout:10000,stdio:'pipe'});assert.equal(JSON.parse(readFileSync(f.path)).qualificationReservations.entries.at(-1).s03.events.length,2);assert.throws(()=>f.debit(f.input('provider','after-descendants')),/S03_SCOPE/);
});
test('source change, copied env without live original scope, and missing original fence deny before lower',()=>{
  for(const mode of ['source','pending','owner']){const f=copiedS03Fixture();if(mode==='source')writeFileSync(f.source.path,'changed',{mode:0o600});if(mode==='pending')writeFileSync(f.path+'.parent-time-pending.json','{}',{mode:0o600});if(mode==='owner'){const book=JSON.parse(readFileSync(f.path));book.qualificationReservations.entries.at(-1).owner.birth='wrong';writeFileSync(f.path,canonical(book)+'\n',{mode:0o600});}
    let lower=0;assert.throws(()=>{f.debit(f.input('provider','blocked'));lower++;});assert.equal(lower,0);
  }
});
test('native occupancy needs original inspect binding and exact-ID absence; supplied release data and fifth active deny',()=>{
  const f=copiedS03Fixture('mcp'),rows=[];for(let n=0;n<4;n++){const name='lw-pi-' + String(n).padStart(32,'0'),id=String(n).padStart(64,'a'),labels={'org.loopwright.nonce':String(n).padStart(32,'0')};f.debit(f.input('containers','create-'+n,{name,image:f.plan.image,labels}));rows.push({name,id,labels});}
  assert.throws(()=>f.debit(f.input('containers','fifth',{name:'lw-pi-'+'e'.repeat(32),image:f.plan.image,labels:{}})),/S03_SCOPE/);
  assert.throws(()=>f.debit(f.input('absent','fake',{},0)),/OBSERVATION_REQUIRED/);
  const r=rows[0],observe=()=>({exit:0,signal:null,stdout:JSON.stringify([{Id:r.id,Name:'/'+r.name,Image:f.plan.image,Config:{Labels:r.labels}}]),stderr:''});observeS03Container(f.path,f.base,r.name,r.id,'bind',{copied:true,observe});
  assert.throws(()=>observeS03Container(f.path,f.base,r.name,'f'.repeat(64),'absent',{copied:true,observe:()=>({exit:1,signal:null,stdout:'[]',stderr:'error: no such object: '+'f'.repeat(64)})}),/S03_SCOPE/);
  observeS03Container(f.path,f.base,r.name,r.id,'absent',{copied:true,observe:()=>({exit:1,signal:null,stdout:'[]',stderr:'error: no such object: '+r.id})});assert.equal(JSON.parse(readFileSync(f.path)).qualificationReservations.entries.at(-1).s03.occupants.length,3);
});
test('counter commit uncertainty keeps original exclusion before/after rename and never enables a lower retry',()=>{
  for(const stage of ['before_commit','after_commit']){const f=copiedS03Fixture();assert.throws(()=>debitS03Reservation(f.path,f.input('provider','one'),{copied:true,fault:p=>{if(p===stage)throw Error(stage);}}),new RegExp(stage));assert.equal(existsSync(f.path+'.lock'),true);assert.throws(()=>f.debit(f.input('provider','two')),/LOCK_HELD/);}
  assert.deepEqual(readFileSync(actual),actualBefore);
});
