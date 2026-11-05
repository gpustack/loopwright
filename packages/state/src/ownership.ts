import { randomBytes } from 'node:crypto';
import { addMono, checkedAdd, digest, enumeration, id, integer, record, snapshot, text } from './boundary.js';
import { project } from './clock.js';
import { fail, StateFailure } from './errors.js';
import type { Data } from './model.js';
import type { Authority, ClockSample, OwnerView, OwnerStatus } from './types.js';
export function boundaryInput<T>(read:()=>T):T {try{return read();}catch(error){if(error instanceof StateFailure)throw error;fail('INVALID_INPUT');}}
export function authority(input:unknown):Authority {
  return boundaryInput(()=>{const v=record(snapshot(input),['storeId','runId','lockHash','ownerId','generation','nonce']);const nonce=text(v.nonce);if(!/^[0-9a-f]{64}$/.test(nonce))fail('INVALID_INPUT','/authority/nonce');
    return {storeId:id(v.storeId),runId:id(v.runId),lockHash:digest(v.lockHash),ownerId:id(v.ownerId),generation:integer(v.generation),nonce};});
}
export function claimInput(input:unknown){return boundaryInput(()=>{const v=record(snapshot(input),['ownerId','expectedGeneration','expectedRevision','mode']);return {ownerId:id(v.ownerId),expectedGeneration:integer(v.expectedGeneration),expectedRevision:integer(v.expectedRevision),mode:enumeration(v.mode,['active','recovery'])};});}
export function requireNewWork(data:Data,now:ClockSample):void {
  if(BigInt(now.monotonicMs)>=BigInt(data.basis.taskDeadlineMonotonicMs))fail('DEADLINE_EXCEEDED');
  if(data.owner.mode==='recovery')fail('TRANSITION_INVALID','/owner/mode');
  if(data.ledger.violations.length)fail('RUN_BLOCKED');
}
export function grantOwner(data:Data,now:ClockSample,input:ReturnType<typeof claimInput>):void {
  if(data.owner.ownerId!==null&&data.owner.leaseUntilMonotonicMs!==null&&BigInt(now.monotonicMs)<BigInt(data.owner.leaseUntilMonotonicMs))fail('OWNER_HELD');
  if(input.mode==='active'&&BigInt(now.monotonicMs)>=BigInt(data.basis.taskDeadlineMonotonicMs))fail('DEADLINE_EXCEEDED');
  const expiry=addMono(now.monotonicMs,data.identity.policy.leaseMs);
  data.owner={generation:checkedAdd(data.owner.generation,1),ownerId:input.ownerId,nonce:randomBytes(32).toString('hex'),mode:input.mode,leaseUntilMs:project(data.basis,expiry),leaseGrantedMonotonicMs:now.monotonicMs,leaseUntilMonotonicMs:expiry};
}
export function ownerView(data:Data):OwnerView {
  const o=data.owner;if(o.ownerId===null||o.nonce===null||o.mode===null||o.leaseUntilMs===null||o.leaseGrantedMonotonicMs===null||o.leaseUntilMonotonicMs===null)fail('STORE_CORRUPT');
  return {authority:{storeId:data.identity.storeId,runId:data.identity.lock.spec.runId,lockHash:data.identity.lock.spec.lockHash,ownerId:o.ownerId,generation:o.generation,nonce:o.nonce},revision:data.revision,mode:o.mode,leaseUntilMs:o.leaseUntilMs,leaseGrantedMonotonicMs:o.leaseGrantedMonotonicMs,leaseUntilMonotonicMs:o.leaseUntilMonotonicMs,clockEpoch:data.basis.clockEpoch};
}
export function ownerStatus(data:Data):OwnerStatus {const {nonce:_,...value}=data.owner;void _;return value;}
