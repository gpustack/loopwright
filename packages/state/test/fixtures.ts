import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { admitTask, type TaskContract } from '@loopwright/core';
import { contract, value } from '../../core/test/fixtures.js';
import { createLocalRun, type LocalRunIdentity, type StateResult, type StateErrorCode, type RequestAdmission } from '../src/index.js';
export function good<T>(result:StateResult<T>):T {assert.equal(result.ok,true,JSON.stringify(result));if(!result.ok)throw new Error('expected success');return result.value;}
export function errorCode(result:StateResult<unknown>,expected:StateErrorCode):void {assert.equal(result.ok,false);if(result.ok)throw new Error('expected failure');assert.equal(result.error.code,expected);}
export function fixture(budgets:Partial<TaskContract['spec']['budgets']>={},leaseMs=1000){
  const parent=mkdtempSync(join(realpathSync(tmpdir()),'loopwright-state-'));
  const task=contract();task.spec.budgets.wallTimeMs=60000;Object.assign(task.spec.budgets,budgets);
  const lock=value(admitTask(task,{admissionId:'admission-1',runId:'run-1'}));
  const input:LocalRunIdentity={directory:join(parent,'store'),storeId:'store-1',lock,policy:{version:1,leaseMs,cost:'observe_only'},binding:{coreApiVersion:'loopwright.dev/v1alpha1',hostVersion:'fixture',adapters:[{id:'pi',version:'1.5.0'}],resourceVersion:'fixture-host',clockEpoch:'fixture-boot'}};
  return {input,parent,path:join(input.directory,'state.sqlite'),create:()=>good(createLocalRun(input)),cleanup:()=>{rmSync(parent,{recursive:true,force:true});assert.equal(existsSync(parent),false);}};
}

export function request(requestId='request-1',patch:Partial<RequestAdmission>={}):RequestAdmission {return {requestId,roleId:'builder',nodeId:'build',attemptId:`attempt-${requestId}`,purpose:'task',repair:'none',transportRetryOf:null,requestDigest:{algorithm:'sha256',hex:'a'.repeat(64)},inputUpperBound:80,outputUpperBound:20,totalUpperBound:100,capability:{adapterId:'pi',adapterVersion:'1.5.0',provider:'github-copilot',model:'exact-model',kind:'hard_bound',coversAllBillableTokens:true,enforcesOutputBound:true},operationId:`op-${requestId}`,targetIdentity:'provider/request',...patch};}

import type { LocalRunStore, TrustedEvidence, RequestObservation, CheckpointInput } from '../src/index.js';
export function evidenceFor(store:LocalRunStore,operationId:string):TrustedEvidence {
  const op=good(store.getOperation(operationId));if(op.dispatch===null)throw Error('operation has no dispatch');const view=good(store.inspect());
  return {evidenceId:'evidence-1',producerId:'fixture-verifier',method:'synthetic-receipt',subject:{storeId:view.storeId,runId:view.runId,lockHash:{...view.lockHash},operationId,requestId:op.linkedRequestId,intentDigest:{...op.intentDigest},dispatchGeneration:op.dispatch.generation,dispatchId:op.dispatch.dispatchId},artifact:{name:'receipt.log',digest:{algorithm:'sha256',hex:'b'.repeat(64)},byteLength:0}};
}
export function observationFor(store:LocalRunStore,requestId='request-1',patch:Partial<RequestObservation>={}):RequestObservation {
  const item=good(store.getRequest(requestId));return {receiptId:'receipt-1',evidence:evidenceFor(store,item.admission.operationId),termination:'confirmed',outcome:'succeeded',usage:{requestId,inputTokens:{provenance:'reported',value:10},outputTokens:{provenance:'reported',value:5},costMicrousd:{provenance:'unknown'}},...patch};
}

export function checkpoint(expectedRevision:number,checkpointId='checkpoint-1'):CheckpointInput {return {checkpointId,expectedRevision,candidateManifest:{apiVersion:'loopwright.dev/v1alpha1',kind:'ArtifactManifest',metadata:{id:'candidate'},spec:{entries:[]}},workspace:{name:'workspace.patch',digest:{algorithm:'sha256',hex:'a'.repeat(64)},byteLength:0},privateSession:null,additionalArtifacts:[]};}
