/* global process, Buffer */
import test from 'node:test';
import assert from 'node:assert/strict';
import {observeCliJson,executePreparedPublicCli} from './native-cli.mjs';
const write=value=>new Promise((done,reject)=>process.stdout.write(value,error=>error?reject(error):done()));

test('CLI observer preserves original main argv, waits for admission observation, and restores its sink',async()=>{
  const original=process.stdout.write,argv=['run','--json'],events=[];
  const observed=await observeCliJson(async actual=>{
    assert.equal(actual,argv);await write(JSON.stringify({version:1,kind:'event',sequence:1,runId:'test',data:{stage:'admission'}})+'\n');
    assert.deepEqual(events,['admission']);await write(JSON.stringify({version:1,kind:'result',sequence:2,runId:'test',data:{kind:'result'}})+'\n');return 0;
  },argv,async event=>{await Promise.resolve();events.push(event.stage);});
  assert.equal(observed.exit,0);assert.equal(observed.rows.length,2);assert.equal(observed.terminal.kind,'result');assert.equal(process.stdout.write,original);
});

test('CLI observer refuses malformed framing, sequence drift and oversized bytes, restoring stdout after each',async()=>{
  const original=process.stdout.write;
  for(const value of ['{}',JSON.stringify({version:1,kind:'event',sequence:2})+'\n',Buffer.alloc(1048577)]){
    await assert.rejects(observeCliJson(async()=>{await write(value);return 0;},[],()=>{}),/QUALIFICATION_CLI_OUTPUT/);assert.equal(process.stdout.write,original);
  }
});

test('native CLI route requires actual application activation before inspecting inputs or importing main',async()=>{
  let reads=0;await assert.rejects(executePreparedPublicCli({}, {get load(){reads++;throw Error('must not inspect');}}),/NATIVE_ACTIVATION_HELD/);assert.equal(reads,0);
});

test('closed assertion failure accounts only an exact executed prefix and remains failed',async()=>{
  const {validateNativeQualification}=await import('./native-app.mjs'),recipe={cases:[{id:'first'},{id:'second'}]},ref=id=>({path:'/copied/case-'+id+'.json'});
  const data={results:[ref('first')],qualification:{status:'failed',failedCase:'first',reason:'QUALIFICATION_NATIVE_CASE'}};
  assert.deepEqual(validateNativeQualification(recipe,data),[recipe.cases[0]]);
  for(const changed of [
    {...data,qualification:{status:'passed',failedCase:null,reason:null}},
    {...data,qualification:{...data.qualification,failedCase:'second'}},
    {...data,qualification:{...data.qualification,reason:'QUALIFICATION_TERMINAL_UNKNOWN'}},
    {...data,results:[ref('second')]},
    {...data,results:[]},
  ])assert.throws(()=>validateNativeQualification(recipe,changed),/QUALIFICATION_NATIVE_CASE/);
});

test('implementation repair fixture uses two SDK request charges within one repair command',async()=>{
  const {validateNativeCase}=await import('./native-app.mjs'),item={id:'implementation-candidate-change'},outcome={ok:true,value:{kind:'result',result:{spec:{status:'completed'}},secondary:[]}},snapshot={close:{ok:true,value:{closed:true}},view:{counts:{unresolvedRequests:0,unresolvedOperations:0,dispatchedRequests:0},ledger:{implementationRepairs:2}}},observations={cleanup:'complete'};
  assert.doesNotThrow(()=>validateNativeCase(item,outcome,snapshot,observations,{}));snapshot.view.ledger.implementationRepairs=1;assert.throws(()=>validateNativeCase(item,outcome,snapshot,observations,{}),/QUALIFICATION_NATIVE_CASE/);
});
