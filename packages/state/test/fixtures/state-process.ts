import type { ArtifactRef } from '@loopwright/core';
import { reopenLocalRun, type Authority, type CheckpointInput, type LocalRunIdentity, type LocalRunStore as Store, type OperationIntent, type OperationReceipt, type RequestAdmission, type RequestObservation, type RequestResolution, type StateResult, type UnresolvedReason } from '../../src/index.js';
import { LocalRunStore } from '../../src/store.js';
import { openInternal } from '../../src/connection.js';
import { checkpoint, good, observationFor, request } from '../fixtures.js';
let store:Store|undefined;
let token:Authority|undefined;
type Message={action:string;input?:LocalRunIdentity;watch?:string;scenario?:string;ownerId?:string;guard?:{expectedGeneration:number;expectedRevision:number};authority?:Authority;method?:string;requestId?:string;request?:RequestAdmission;operationId?:string;intent?:OperationIntent;observation?:RequestObservation;resolution?:RequestResolution;receipt?:OperationReceipt;checkpoint?:CheckpointInput;reason?:UnresolvedReason;availableArtifacts?:readonly ArtifactRef[]};
function invoke(message:Message):StateResult<unknown>{
  const s=store!,a=message.authority??token!;
  switch(message.method){
    case 'renew':return s.renew(a);
    case 'release':return s.release(a);
    case 'claim':return s.claim({ownerId:message.ownerId!,...message.guard!,mode:'active'});
    case 'reserveRequest':return s.reserveRequest(a,message.request!);
    case 'authorizeRequestDispatch':return s.authorizeRequestDispatch(a,message.requestId!);
    case 'releaseReservation':return s.releaseReservation(a,message.requestId!);
    case 'markRequestUnresolved':return s.markRequestUnresolved(a,message.requestId!,message.reason!);
    case 'observeRequest':return s.observeRequest(a,message.requestId!,message.observation!);
    case 'reconcileRequest':return s.reconcileRequest(a,message.requestId!,message.resolution!);
    case 'putIntent':return s.putIntent(a,message.intent!);
    case 'authorizeOperationDispatch':return s.authorizeOperationDispatch(a,message.operationId!);
    case 'markOperationUnresolved':return s.markOperationUnresolved(a,message.operationId!,message.reason!);
    case 'recordOperationReceipt':return s.recordOperationReceipt(a,message.operationId!,message.receipt!);
    case 'reconcileOperation':return s.reconcileOperation(a,message.operationId!,message.receipt!);
    case 'writeCheckpoint':return s.writeCheckpoint(a,message.checkpoint!);
    case 'recoveryView':return s.recoveryView(a,{checkpointId:message.checkpoint!.checkpointId,availableArtifacts:message.availableArtifacts!});
    case 'getRequest':return s.getRequest(message.requestId!);
    default:throw Error('unknown test RPC');
  }
}
process.on('message',(message:Message)=>{
  try{
    if(message.action==='open'){
      if(message.watch){store=new LocalRunStore(openInternal(message.input!,'reopen',{onBoundary:event=>{if(event.phase===message.watch){process.send?.({kind:'barrier',...event,pid:process.pid,directory:message.input!.directory,clock:{wallMs:Date.now(),monotonicMs:String(process.hrtime.bigint()/1000000n)}});Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0);}}}));}
      else store=good(reopenLocalRun(message.input!));
      process.send?.({kind:'opened',pid:process.pid,view:good(store.inspect()),clock:{wallMs:Date.now(),monotonicMs:String(process.hrtime.bigint()/1000000n)}});
    }else if(message.action==='claim'){
      const result=store!.claim({ownerId:message.ownerId!,...message.guard!,mode:'active'});if(result.ok)token=result.value.authority;process.send?.({kind:'claimed',pid:process.pid,result});
    }else if(message.action==='call'){
      process.send?.({kind:'called',method:message.method,pid:process.pid,alive:true,result:invoke(message)});
    }else if(message.action==='scenario'){
      good(store!.reserveRequest(token!,request()));
      if(message.scenario!=='reservation')good(store!.authorizeRequestDispatch(token!,'request-1'));
      if(message.scenario==='settlement')good(store!.observeRequest(token!,'request-1',observationFor(store!)));
      if(message.scenario==='unknown-observation'||message.scenario==='known-termination')good(store!.observeRequest(token!,'request-1',observationFor(store!,'request-1',{termination:message.scenario==='unknown-observation'?'unknown':'confirmed',outcome:message.scenario==='unknown-observation'?null:'succeeded',usage:{requestId:'request-1',inputTokens:{provenance:'unknown'},outputTokens:{provenance:'unknown'},costMicrousd:{provenance:'unknown'}}})));
      if(message.scenario==='checkpoint')good(store!.writeCheckpoint(token!,checkpoint(good(store!.inspect()).revision)));
      process.send?.({kind:'failure',pid:process.pid,message:'expected transaction barrier was not reached'});
    }else if(message.action==='close'){
      const result=store?.close();process.send?.({kind:'closed',pid:process.pid,result},()=>{process.exitCode=result&&!result.ok?1:0;process.disconnect?.();});
    }
  }catch(error){process.send?.({kind:'failure',pid:process.pid,message:error instanceof Error?error.message:String(error)});}
});
process.send?.({kind:'ready',pid:process.pid});
