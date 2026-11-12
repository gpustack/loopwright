import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createLocalRun } from '../src/index.js';
import { contract, value } from '../../core/test/fixtures.js';
import { admitTask } from '@loopwright/core';

test('explicit create commits an inspectable authoritative run', () => {
  const parent = mkdtempSync(join(realpathSync(tmpdir()), 'loopwright-state-'));
  const lock = value(admitTask(contract(), {admissionId:'admission-1',runId:'run-1'}));
  try {
    const created = createLocalRun({ directory:join(parent,'store'),storeId:'store-1',lock,
      policy:{version:1,leaseMs:1000,cost:'observe_only'},binding:{coreApiVersion:'loopwright.dev/v1alpha1',hostVersion:'fixture',adapters:[{id:'pi',version:'1.5.0'}],resourceVersion:'fixture-host',clockEpoch:'fixture-boot'} });
    assert.equal(created.ok,true,'create must commit the local run');
    if(created.ok) { assert.equal(created.value.inspect().ok,true); created.value.close(); }
  } finally { rmSync(parent,{recursive:true,force:true}); }
});

import { DatabaseSync } from 'node:sqlite';
import { existsSync, mkdirSync, statSync } from 'node:fs';
import { reopenLocalRun } from '../src/index.js';
import { fixture, good, errorCode } from './fixtures.js';

test('reopen and identical create retry retain original identity, deadline and basis', () => {
  const f=fixture();try{
    const first=f.create();const before=good(first.inspect());good(first.close());
    const reopened=good(reopenLocalRun(f.input));const after=good(reopened.inspect());
    assert.deepEqual(after.clock.basis,before.clock.basis);assert.equal(after.deadlineMs,before.deadlineMs);assert.equal(after.startedAtMs,before.startedAtMs);assert.equal(after.ledger.chargedTokens.decimal,'0');
    assert(Object.isFrozen(after)&&Object.isFrozen(after.clock.basis));good(reopened.close());good(reopened.close());errorCode(reopened.inspect(),'STORE_CLOSED');
    const retry=good(createLocalRun(structuredClone(f.input)));assert.equal(good(retry.inspect()).revision,0);retry.close();
    assert.equal(statSync(f.input.directory).mode&0o777,0o700);assert.equal(statSync(f.path).mode&0o777,0o600);
  }finally{f.cleanup();}
});

test('missing and incomplete stores fail without initialization',()=>{
  const f=fixture();try{
    errorCode(reopenLocalRun(f.input),'STORE_MISSING');assert.equal(existsSync(f.input.directory),false);
    mkdirSync(f.input.directory);errorCode(createLocalRun(f.input),'STORE_INCOMPLETE');assert.equal(existsSync(f.path),false);
    errorCode(reopenLocalRun(f.input),'STORE_MISSING');
  }finally{f.cleanup();}
});

test('changed policy, lock, store and compatibility cannot reset the run',()=>{
  const f=fixture();try{
    const store=f.create();const before=good(store.inspect());store.close();
    errorCode(createLocalRun({...f.input,policy:{...f.input.policy,leaseMs:2000}}),'IDENTITY_CONFLICT');
    errorCode(reopenLocalRun({...f.input,storeId:'store-2'}),'IDENTITY_CONFLICT');
    errorCode(reopenLocalRun({...f.input,binding:{...f.input.binding,clockEpoch:'other-boot'}}),'BINDING_MISMATCH');
    const newLock=value(admitTask(contract(),{admissionId:'admission-2',runId:'run-1'}));errorCode(createLocalRun({...f.input,lock:newLock}),'IDENTITY_CONFLICT');
    const restored=f.create();assert.equal(good(restored.inspect()).deadlineMs,before.deadlineMs);restored.close();
  }finally{f.cleanup();}
});

test('versions, added schema, missing authoritative rows and modified stored facts fail closed',()=>{
  for(const mutation of ["PRAGMA user_version=99","CREATE INDEX unexpected ON run(revision)","DELETE FROM run","UPDATE run SET deadline_ms=deadline_ms+1","UPDATE run SET ledger_json='{}'","UPDATE store_meta SET engine_identity='{}'"]){
    const f=fixture();try{const store=f.create();store.close();const db=new DatabaseSync(f.path);db.exec(mutation);db.close();errorCode(reopenLocalRun(f.input),mutation.includes('user_version')?'FORMAT_UNSUPPORTED':'STORE_CORRUPT');}finally{f.cleanup();}
  }
});

test('configuration is the selected real local SQLite profile',()=>{
  const f=fixture();try{const store=f.create();store.close();const db=new DatabaseSync(f.path);assert.equal(db.prepare('PRAGMA journal_mode').get()?.journal_mode,'delete');assert.equal(db.prepare('PRAGMA page_size').get()?.page_size,4096);assert.equal(db.prepare('PRAGMA user_version').get()?.user_version,1);assert.equal(db.prepare('PRAGMA application_id').get()?.application_id,1280791363);db.close();}finally{f.cleanup();}
});

test('boundary rejects unsafe input without running getters or mutating a store',()=>{
  const f=fixture();try{let called=false;const input={...f.input};Object.defineProperty(input,'policy',{enumerable:true,get(){called=true;throw Error('getter');}});errorCode(createLocalRun(input),'INVALID_INPUT');assert.equal(called,false);assert.equal(existsSync(f.path),false);
    errorCode(createLocalRun({...f.input,policy:{...f.input.policy,leaseMs:999}}),'INVALID_INPUT');
    errorCode(createLocalRun({...f.input,binding:{...f.input.binding,adapters:[]}}),'BINDING_MISMATCH');
  }finally{f.cleanup();}
});

test('adapter binding order is deterministic for all valid core labels',()=>{const f=fixture();try{const task=contract();task.spec.roles[0]!.adapter='Zeta';task.spec.roles.push({...structuredClone(task.spec.roles[0]!),id:'reviewer',adapter:'alpha'});const lock=value(admitTask(task,{admissionId:'admission-1',runId:'run-1'}));const input={...f.input,lock,binding:{...f.input.binding,adapters:[{id:'alpha',version:'1'},{id:'Zeta',version:'1'}]}};const store=good(createLocalRun(input));assert.deepEqual(good(store.inspect()).binding.adapters.map(a=>a.id),['Zeta','alpha']);store.close();const reopened=good(reopenLocalRun({...input,binding:{...input.binding,adapters:[...input.binding.adapters].reverse()}}));reopened.close();}finally{f.cleanup();}});

import { chmodSync } from 'node:fs';
import { ENGINE, matchesEngine } from '../src/schema.js';
test('runtime allowlist rejects unqualified platform, architecture, Node and SQLite profiles',()=>{
  assert.equal(matchesEngine(ENGINE),true);
  for(const ok of [
    {platform:'darwin',architecture:'arm64',node:'v26.13.1',sqlite:'3.54.1'},
    {platform:'linux',architecture:'arm64',node:'v26.13.0',sqlite:'3.54.1'},
    {platform:'linux',architecture:'x64',node:'v26.13.1',sqlite:'3.54.2'},
  ])assert.equal(matchesEngine(ok),true);
  for(const patch of [{platform:'win32'},{platform:'darwin',architecture:'x64'},{node:'v25.0.0'},{sqlite:'2.8.17'},{sqlite:undefined}])assert.equal(matchesEngine({...ENGINE,...patch}),false);
});
test('actual unavailable local-file access remains distinct from exhaustion and missing authority',()=>{assert.notEqual(process.getuid?.(),0,'permission fixture requires the qualified non-root local user');const f=fixture();try{const before=f.create();const deadline=good(before.inspect()).deadlineMs;before.close();chmodSync(f.path,0);try{errorCode(reopenLocalRun(f.input),'STORE_UNAVAILABLE');}finally{chmodSync(f.path,0o600);}const reopened=good(reopenLocalRun(f.input));assert.equal(good(reopened.inspect()).deadlineMs,deadline);reopened.close();}finally{if(existsSync(f.path))chmodSync(f.path,0o600);f.cleanup();}});

test('direct API errors own and freeze diagnostics independently of transport serialization',()=>{const f=fixture();try{const s=f.create();try{const result=s.getRequest('missing');errorCode(result,'RECORD_NOT_FOUND');assert(Object.isFrozen(result));if(!result.ok){assert(Object.isFrozen(result.error));assert(Object.isFrozen(result.error.diagnostics));assert.throws(()=>{(result.error.diagnostics as unknown[]).push({});},TypeError);}}finally{s.close();}}finally{f.cleanup();}});
