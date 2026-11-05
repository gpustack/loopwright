import { attempt, fail } from './errors.js';
import { assertOwnerIdentity, Connection, openInternal, runView } from './connection.js';
import { admission, reserve, findRequest, findOperation, intent } from './admission.js';
import { authorizeRequest, unresolvedRequest, observe, reconcile } from './settlement.js';
import { authorizeOperation, put, receiveOperation, unresolvedOperation } from './journal.js';
import { checkpointInput, findCheckpoint, publish, recoveryInput, requireArtifacts } from './checkpoint.js';
import { page, pageInput } from './pages.js';
import { observation, operationReceipt, resolution } from './receipts.js';
import { checkedAdd, addMono, id, enumeration } from './boundary.js';
import { project } from './clock.js';
import { authority, boundaryInput, claimInput, grantOwner, ownerView, ownerStatus } from './ownership.js';
import type { LocalRunIdentity, RunView, StateResult, OwnerView, Authority, Mutation, OwnerStatus, RequestAdmission, RequestRecord, OperationRecord, DispatchResult, RequestObservation, RequestResolution, UnresolvedReason, OperationIntent, OperationReceipt, CheckpointInput, CheckpointRecord, RecoveryView, Page, PageCursor } from './types.js';
/** Factory-created local store. SQLite and test seams are absent from the package root. */
export class LocalRunStore {
  readonly #connection:Connection;
  constructor(connection:Connection) {this.#connection=connection;}
   #execute<T>(operation:()=>T):StateResult<T> {return attempt(()=>{this.#connection.assertOpen();return operation();});}
  claim(input:{ownerId:string;expectedGeneration:number;expectedRevision:number;mode:'active'|'recovery'}):StateResult<OwnerView> {
    return this.#execute(()=>{const v=claimInput(input);return this.#connection.mutate('claim',v,(data,now)=>{grantOwner(data,now,v);return {changed:true,finish:()=>ownerView(data)};});});
  }
  renew(input:Authority):StateResult<OwnerView> {
    return this.#execute(()=>this.#connection.mutate('renew',authority(input),(data,now)=>{
      const expiry=addMono(now.monotonicMs,data.identity.policy.leaseMs);data.owner.leaseUntilMs=project(data.basis,expiry);data.owner.leaseGrantedMonotonicMs=now.monotonicMs;data.owner.leaseUntilMonotonicMs=expiry;
      return {changed:true,finish:()=>ownerView(data)};
    }));
  }
  release(input:Authority):StateResult<Mutation<OwnerStatus>> {
    return this.#execute(()=>this.#connection.mutate('release',authority(input),(data)=>{
      data.owner={generation:checkedAdd(data.owner.generation,1),ownerId:null,nonce:null,mode:null,leaseUntilMs:null,leaseGrantedMonotonicMs:null,leaseUntilMonotonicMs:null};
      return {changed:true,finish:()=>({kind:'applied',revision:data.revision,record:ownerStatus(data)})};
    }));
  }
  reserveRequest(inputAuthority:Authority,input:RequestAdmission):StateResult<Mutation<RequestRecord>> {
    return this.#execute(()=>{const guard=authority(inputAuthority),value=admission(input);return this.#connection.mutate<Mutation<RequestRecord>>('reserveRequest',guard,(data,now)=>{const result=reserve(data,now,value);return {changed:result.created,finish:()=>({kind:result.created?'created':'existing',revision:data.revision,record:result.record})};});});
  }
  authorizeRequestDispatch(inputAuthority:Authority,requestId:string):StateResult<DispatchResult<RequestRecord>> {
    return this.#execute(()=>{const guard=authority(inputAuthority),key=boundaryInput(()=>id(requestId));return this.#connection.mutate('authorizeRequestDispatch',guard,(data,now)=>authorizeRequest(data,now,key));});
  }
  markRequestUnresolved(inputAuthority:Authority,requestId:string,reason:UnresolvedReason):StateResult<Mutation<RequestRecord>> {
    return this.#execute(()=>{const guard=authority(inputAuthority),key=boundaryInput(()=>id(requestId)),why=boundaryInput(()=>enumeration(reason,['timeout','cancellation','connection_lost','owner_lost']));return this.#connection.mutate<Mutation<RequestRecord>>('markRequestUnresolved',guard,(data)=>{const changed=unresolvedRequest(data,key,why);return {changed,finish:()=>({kind:changed?'applied':'existing',revision:data.revision,record:findRequest(data,key)})};});});
  }
  observeRequest(inputAuthority:Authority,requestId:string,input:RequestObservation):StateResult<Mutation<RequestRecord>> {
    return this.#execute(()=>{const guard=authority(inputAuthority),key=boundaryInput(()=>id(requestId)),value=boundaryInput(()=>observation(input));return this.#connection.mutate<Mutation<RequestRecord>>('observeRequest',guard,(data)=>{const changed=observe(data,key,value);return {changed,finish:()=>({kind:changed?'applied':'existing',revision:data.revision,record:findRequest(data,key)})};});});
  }
  reconcileRequest(inputAuthority:Authority,requestId:string,input:RequestResolution):StateResult<Mutation<RequestRecord>> {
    return this.#execute(()=>{const guard=authority(inputAuthority),key=boundaryInput(()=>id(requestId)),value=boundaryInput(()=>resolution(input));return this.#connection.mutate<Mutation<RequestRecord>>('reconcileRequest',guard,(data)=>{const changed=reconcile(data,key,value);return {changed,finish:()=>({kind:changed?'applied':'existing',revision:data.revision,record:findRequest(data,key)})};});});
  }
  releaseReservation(inputAuthority:Authority,requestId:string):StateResult<Mutation<RequestRecord>> {
    return this.#execute(()=>{const guard=authority(inputAuthority),key=boundaryInput(()=>id(requestId));return this.#connection.mutate<Mutation<RequestRecord>>('releaseReservation',guard,(data)=>{const request=findRequest(data,key);if(request.state==='released')return {changed:false,finish:()=>({kind:'existing',revision:data.revision,record:request})};if(request.state!=='reserved')fail('TRANSITION_INVALID');
      request.state='released';request.holdsSlot=false;request.chargedTokens={decimal:'0',safeValue:0};findOperation(data,request.admission.operationId).state='abandoned';
      return {changed:true,finish:()=>({kind:'applied',revision:data.revision,record:request})};});});
  }
  getRequest(requestId:string):StateResult<RequestRecord> {return this.#execute(()=>{const key=boundaryInput(()=>id(requestId));return this.#connection.read(data=>findRequest(data,key));});}
  getOperation(operationId:string):StateResult<OperationRecord> {return this.#execute(()=>{const key=boundaryInput(()=>id(operationId));return this.#connection.read(data=>findOperation(data,key));});}
  putIntent(inputAuthority:Authority,input:OperationIntent):StateResult<Mutation<OperationRecord>> {
    return this.#execute(()=>{const guard=authority(inputAuthority),value=boundaryInput(()=>{const v=intent(input);if(v.effect==='model_call')fail('INVALID_INPUT');return v;});return this.#connection.mutate<Mutation<OperationRecord>>('putIntent',guard,(data,now)=>{const result=put(data,now,value);return {changed:result.created,finish:()=>({kind:result.created?'created':'existing',revision:data.revision,record:result.record})};});});
  }
  authorizeOperationDispatch(inputAuthority:Authority,operationId:string):StateResult<DispatchResult<OperationRecord>> {
    return this.#execute(()=>{const guard=authority(inputAuthority),key=boundaryInput(()=>id(operationId));return this.#connection.mutate('authorizeOperationDispatch',guard,(data,now)=>authorizeOperation(data,now,key));});
  }
  markOperationUnresolved(inputAuthority:Authority,operationId:string,reason:UnresolvedReason):StateResult<Mutation<OperationRecord>> {
    return this.#execute(()=>{const guard=authority(inputAuthority),key=boundaryInput(()=>id(operationId)),why=boundaryInput(()=>enumeration(reason,['timeout','cancellation','connection_lost','owner_lost']));return this.#connection.mutate<Mutation<OperationRecord>>('markOperationUnresolved',guard,(data)=>{const changed=unresolvedOperation(data,key,why);return {changed,finish:()=>({kind:changed?'applied':'existing',revision:data.revision,record:findOperation(data,key)})};});});
  }
  recordOperationReceipt(inputAuthority:Authority,operationId:string,input:OperationReceipt):StateResult<Mutation<OperationRecord>> {return this.#receiveOperation('recordOperationReceipt',inputAuthority,operationId,input,false);}
  reconcileOperation(inputAuthority:Authority,operationId:string,input:OperationReceipt):StateResult<Mutation<OperationRecord>> {return this.#receiveOperation('reconcileOperation',inputAuthority,operationId,input,true);}
  #receiveOperation(action:string,inputAuthority:Authority,operationId:string,input:OperationReceipt,reconciling:boolean):StateResult<Mutation<OperationRecord>> {
    return this.#execute(()=>{const guard=authority(inputAuthority),key=boundaryInput(()=>id(operationId)),value=boundaryInput(()=>operationReceipt(input));return this.#connection.mutate<Mutation<OperationRecord>>(action,guard,(data)=>{const changed=receiveOperation(data,key,value,reconciling);return {changed,finish:()=>({kind:changed?'applied':'existing',revision:data.revision,record:findOperation(data,key)})};});});
  }
  writeCheckpoint(inputAuthority:Authority,input:CheckpointInput):StateResult<Mutation<CheckpointRecord>> {
    return this.#execute(()=>{const guard=authority(inputAuthority),value=boundaryInput(()=>checkpointInput(input));return this.#connection.mutate<Mutation<CheckpointRecord>>('writeCheckpoint',guard,(data,now)=>{const result=publish(data,now,value);return {changed:result.created,finish:()=>({kind:result.created?'created':'existing',revision:data.revision,record:result.record})};});});
  }
  getCheckpoint(checkpointId:string):StateResult<CheckpointRecord> {return this.#execute(()=>{const key=boundaryInput(()=>id(checkpointId));return this.#connection.read(data=>findCheckpoint(data,key).record);});}
  listRequests(input:{limit:number;cursor:PageCursor|null}):StateResult<Page<RequestRecord>> {return this.#execute(()=>{const value=boundaryInput(()=>pageInput(input));return this.#connection.read(data=>page(data,'requests',data.requests,value));});}
  listOperations(input:{limit:number;cursor:PageCursor|null}):StateResult<Page<OperationRecord>> {return this.#execute(()=>{const value=boundaryInput(()=>pageInput(input));return this.#connection.read(data=>page(data,'operations',data.operations,value));});}
  listCheckpoints(input:{limit:number;cursor:PageCursor|null}):StateResult<Page<CheckpointRecord>> {return this.#execute(()=>{const value=boundaryInput(()=>pageInput(input));return this.#connection.read(data=>page(data,'checkpoints',data.checkpoints.map(c=>c.record),value));});}
  recoveryView(inputAuthority:Authority,input:{checkpointId:string;availableArtifacts:readonly import('@loopwright/core').ArtifactRef[]}):StateResult<RecoveryView> {
    return this.#execute(()=>{const guard=authority(inputAuthority),value=boundaryInput(()=>recoveryInput(input));return this.#connection.read((data,now)=>{assertOwnerIdentity(data,guard);if(this.#connection.isClockBlocked())fail('CLOCK_UNTRUSTED');if(data.owner.leaseUntilMonotonicMs===null||BigInt(now.monotonicMs)>=BigInt(data.owner.leaseUntilMonotonicMs))fail('OWNER_EXPIRED');const checkpoint=findCheckpoint(data,value.checkpointId).record;requireArtifacts(checkpoint,value.availableArtifacts);const current=runView(data,now,false);return {checkpoint,current,ledgerAdvanced:current.revision>checkpoint.publishedRevision,requiresReconciliation:current.counts.dispatchedRequests>0||current.counts.unresolvedRequests>0||current.counts.unresolvedOperations>0||current.ledger.violations.length>0};});});
  }
  inspect():StateResult<RunView> {return this.#execute(()=>this.#connection.read((data,now)=>runView(data,now,this.#connection.isClockBlocked())));}
  close():StateResult<{closed:true}> {return this.#connection.close();}
}
export function createLocalRun(input:LocalRunIdentity):StateResult<LocalRunStore> {return attempt(()=>new LocalRunStore(openInternal(input,'create')));}
export function reopenLocalRun(input:LocalRunIdentity):StateResult<LocalRunStore> {return attempt(()=>new LocalRunStore(openInternal(input,'reopen')));}
