import {canonical,sha,nonce,monotonic,same,fail} from './native-context.mjs';
/** Observes genuine PUBLIC factory/method results; never constructs a permit or replaces a result. */
export function publicStateObserver({plan,entry,debit,check,observe=()=>{}}){
  const cpu=entry===plan.project+'/packages/agent-pi/qualification/retained-cost.mjs',precharged=plan.precharge.provider>0;
  const seen=new WeakSet(),permits=[];
  const wrap=(result,input)=>{
    if(!result.ok)return result;
    const store=result.value;if(seen.has(store))return result;seen.add(store);
    const identity=sha(canonical({directory:input.directory,storeId:input.storeId,runId:input.lock.spec.runId,lock:input.lock.spec.lockHash}));
    for(const [method,transport]of [['authorizeRequestDispatch','provider'],['authorizeOperationDispatch','mcp']]){
      const original=store[method];
      store[method]=function(...args){
        check();if(transport==='provider'&&['parser-context-failures','runtime-path'].includes(plan.group)&&!cpu)fail('QUALIFICATION_S03_UNEXPECTED_HOST_DISPATCH');const answer=Reflect.apply(original,this,args);
        if(answer.ok&&answer.value.kind==='new_dispatch'){
          const value=answer.value,record=value.record;
          const isMcp=transport!=='mcp'||record.intent.attemptId.startsWith('mcp-attempt-');
          if(!cpu){if(permits.length>=256)fail('QUALIFICATION_S03_DISPATCH_CAP');permits.push({store,authority:JSON.parse(canonical(args[0])),transport:isMcp?transport:'operation',record:JSON.parse(canonical(record)),permit:JSON.parse(canonical(value.permit))});}
          if(isMcp){
            observe({kind:'original-dispatch',transport,identity,id:args[1],cpu});
            if(!cpu){
              const dispatch={store:identity,id:args[1],permit:sha(canonical(value.permit)),record:sha(canonical(record))};
              debit({kind:precharged&&transport==='provider'?'dispatch':transport,key:'dispatch:'+transport+':'+identity+':'+args[1],identity:dispatch,units:precharged&&transport==='provider'?0:1});
            }
          }
        }
        check();return answer;
      };
    }
    return result;
  };
  function assertTransport(transport,subject){
    // Read-only denial gate AFTER private counting. It cannot renew, reconstruct or grant production permission.
    if(transport==='provider'&&precharged)return;
    let row;
    if(transport==='provider'){
      // Sender's public requestDigest hashes a complete request envelope, not just transport body bytes.
      // Original Admission still owns exact ticket/body validation. This extra denial gate requires ONE
      // genuine outstanding original dispatch; it never selects/reconstructs a permit for the caller.
      const outstanding=permits.filter(p=>p.transport==='provider').filter(p=>{const current=p.store.getRequest(p.record.admission.requestId);return current.ok&&current.value.state==='dispatch_authorized'&&current.value.dispatch?.dispatchId===p.permit.dispatchId;});
      if(outstanding.length===1)row=outstanding[0];
    }else row=[...permits].reverse().find(p=>p.transport===transport&&(transport==='operation'?p.record.intent.operationId===subject:p.record.intent.targetIdentity==='candidate:'+subject));
    if(!row)fail('QUALIFICATION_S03_ORIGINAL_PERMISSION');
    const current=transport==='provider'?row.store.getRequest(row.record.admission.requestId):row.store.getOperation(row.record.intent.operationId),view=row.store.inspect();
    if(!current.ok||!view.ok)fail('QUALIFICATION_S03_ORIGINAL_PERMISSION');
    const v=view.value,p=row.permit,a=row.authority,r=current.value;
    if(r.state!==(transport==='provider'?'dispatch_authorized':'dispatch_uncertain')||r.dispatch?.dispatchId!==p.dispatchId||r.dispatch.generation!==p.generation||!same(transport==='provider'?r.admission:r.intent,transport==='provider'?row.record.admission:row.record.intent)
      ||v.clockStatus!=='trusted'||v.owner.mode!=='active'||v.owner.ownerId!==a.ownerId||v.owner.generation!==a.generation||p.storeId!==v.storeId||p.runId!==v.runId||!same(p.lockHash,v.lockHash)||p.generation!==a.generation||p.clockEpoch!==v.clock.basis.clockEpoch
      ||v.owner.leaseUntilMonotonicMs===null)fail('QUALIFICATION_S03_ORIGINAL_PERMISSION');
    const deadlines=[BigInt(v.owner.leaseUntilMonotonicMs),BigInt(p.notAfterMonotonicMs),BigInt(v.clock.basis.taskDeadlineMonotonicMs)],now=monotonic();if(deadlines.some(end=>now>=end))fail('QUALIFICATION_S03_ORIGINAL_PERMISSION');
  }
  return {wrap,assertTransport};
}
export function physicalObservation(debit,transport,destination,body){
  if(typeof destination!=='string'||typeof body!=='string'&&!(body instanceof Uint8Array))fail('QUALIFICATION_S03_TRANSPORT');
  return debit({kind:'physical',key:'physical:'+nonce(),units:0,identity:{transport,destination,bodySha256:sha(body)}});
}
