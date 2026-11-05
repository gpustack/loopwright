import { appendFileSync } from 'node:fs';
import { reopenLocalRun, type LocalRunIdentity, type LocalRunStore } from '../../src/index.js';
let store:LocalRunStore|undefined;
process.on('message',(message:{action:string;input:LocalRunIdentity;marker:string})=>{
  try{
    if(message.action==='run'){
      const opened=reopenLocalRun(message.input);if(!opened.ok)throw Error(opened.error.code);store=opened.value;
      const claim=store.claim({ownerId:'effect-owner',expectedGeneration:0,expectedRevision:0,mode:'active'});if(!claim.ok)throw Error(claim.error.code);
      const intent=store.putIntent(claim.value.authority,{operationId:'operation-1',nodeId:'build',attemptId:'attempt-1',effect:'local_write',requestDigest:{algorithm:'sha256',hex:'a'.repeat(64)},targetIdentity:message.marker});if(!intent.ok)throw Error(intent.error.code);
      const grant=store.authorizeOperationDispatch(claim.value.authority,'operation-1');if(!grant.ok||grant.value.kind!=='new_dispatch')throw Error('no first dispatch permit');
      appendFileSync(message.marker,JSON.stringify({operationId:'operation-1',dispatchId:grant.value.permit.dispatchId,generation:grant.value.permit.generation})+'\n');
      process.send?.({kind:'effect',phase:'effect-before-receipt',pid:process.pid,owner:claim.value,storeId:message.input.storeId,runId:message.input.lock.spec.runId,revision:grant.value.revision,operationId:'operation-1'});
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0);
    }else if(message.action==='close'){store?.close();process.disconnect?.();process.exitCode=0;}
  }catch(error){process.send?.({kind:'failure',message:error instanceof Error?error.message:String(error),pid:process.pid});}
});
process.send?.({kind:'ready',pid:process.pid});
