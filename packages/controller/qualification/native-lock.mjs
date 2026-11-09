/* global process, Buffer */
import { execFileSync } from 'node:child_process';
import { constants, openSync, closeSync, fstatSync, lstatSync, writeFileSync, fsyncSync, unlinkSync, renameSync, existsSync } from 'node:fs';
import { canonical, nonce, same, sha, readPrivate, checkedRef, syncParent, exclusive, fail, localOwner } from './native-context.mjs';
import { s03DebitScope, applyS03Debit } from './pi-scope.mjs';
import { claimLauncherBootstrap,finishLauncherBootstrap } from './native-preflight-launcher.mjs';
const parentTimes=new WeakMap();
const s03Debits=new WeakMap();
const originalS03Reads=execFileSync;
const unavailableTimes=new Set();
function pendingPath(path){return path+'.parent-time-pending.json';}
function hasPending(path){try{lstatSync(pendingPath(path));return true;}catch(error){if(error.code==='ENOENT')return false;throw error;}}
function timeOwner(handle){const value=parentTimes.get(handle);if(!value)fail('QUALIFICATION_PARENT_TIME_HANDLE');return value;}
export function parentTimeState(handle){const value=timeOwner(handle);return JSON.parse(canonical({record:value.record,pending:value.pending,state:value.state,receipt:value.receipt??null,ack:value.ack??null,failure:value.failure??null}));}
export function markParentTimeUnknown(handle,error){const value=timeOwner(handle);value.state='unknown';value.failure=error;}
export function markParentTimeUnavailable(path){unavailableTimes.add(path);}
/** Shared by migration/reservation/time and legacy writers. No waiting, stale deletion or success on uncertain I/O. */
export function withBudgetLock(path, owner, action, timeHandle=null, purpose='work') {
  if(existsSync(path+'.incident-pending.json'))fail('QUALIFICATION_INCIDENT_PENDING');
  const lock=path+'.lock', token=nonce();let file;
  // s03 child and parent debits race on the same book lock; a bounded retry serializes them instead of
  // failing an otherwise valid debit (the exclusion semantics are unchanged - each attempt is still exclusive).
  const attempts=purpose==='s03-debit'?40:1;
  let held,bytes,unlock;
  for(let attempt=0;attempt<attempts;attempt++){
    try{file=openSync(lock,constants.O_CREAT|constants.O_EXCL|constants.O_WRONLY|constants.O_NOFOLLOW,0o600);}catch{file=null;}
    if(file!==null)break;
    if(attempt<attempts-1){const spin=Date.now()+50;while(Date.now()<spin){/* bounded 50ms serialization backoff */}}
  }
  if(file===null)fail('QUALIFICATION_LOCK_HELD');
  held=fstatSync(file);bytes=canonical({version:1,owner,nonce:token})+'\n';unlock=false;
  try{
    writeFileSync(file,bytes);fsyncSync(file);syncParent(lock);unlock=true;
    if(unavailableTimes.has(path))fail('QUALIFICATION_PARENT_TIME_PENDING');
    if(hasPending(path)){
      const time=parentTimes.get(timeHandle);
      if(purpose==='s03-debit'){
        const debit=s03Debits.get(timeHandle);if(!debit||debit.path!==path||!same(debit.owner,owner))fail('QUALIFICATION_PARENT_TIME_PENDING');
        debit.scope=s03DebitScope(path,debit.input,debit.copied,['bind','absent','node-close','listener-close','cleanup-process','process-bind'].includes(debit.input.kind));
      }else if(!time||time.path!==path||!same(time.owner,owner)||sha(readPrivate(pendingPath(path)))!==time.marker.sha256||!(purpose==='work'?time.state==='running':time.state==='finishing'))fail('QUALIFICATION_PARENT_TIME_PENDING');
    }
    else if(purpose==='s03-debit')fail('QUALIFICATION_PARENT_TIME_PENDING');
    return action({token,uncertain(){unlock=false;},confirmed(){unlock=true;}});
  }finally{
    closeSync(file);
    if(unlock){const current=lstatSync(lock);if(current.ino!==held.ino||current.dev!==held.dev||current.nlink!==1||current.uid!==process.getuid()||readPrivate(lock).toString()!==bytes)fail('QUALIFICATION_LOCK_IDENTITY');unlinkSync(lock);syncParent(lock);}
  }
}
/** Revocation only: the marker is not a second time ledger or a serialized grant. */
/** @param {object|null} [bootstrap] */
export function beginParentTimeFence(path,owner,record,bootstrap=null){
  const establish=fence=>{
    fence.uncertain();
    const pending=exclusive(path+'.parent-time-intent-'+record.id+'.json',{version:1,owner,...record}),marker=exclusive(pendingPath(path),{version:1,id:record.id,owner,intent:pending}),handle=Object.freeze({});
    parentTimes.set(handle,{path,owner,record:JSON.parse(canonical(record)),pending,marker,state:'running'});fence.confirmed();return handle;
  };
  if(bootstrap===null)return withBudgetLock(path,owner,establish);
  // The same original process transfers its still-open common exclusion; no file reconstructs it.
  claimLauncherBootstrap(bootstrap,path,owner,record);let confirmed=false;
  try{
    const handle=establish({uncertain(){},confirmed(){}}),value=parentTimes.get(handle);
    // These original byte copies are synced WHILE the original common lock still exists.
    const lockOriginal=exclusive(path+'.bootstrap-lock-original-'+record.id+'.bin',readPrivate(path+'.lock'));
    const markerOriginal=exclusive(path+'.bootstrap-marker-original-'+record.id+'.bin',readPrivate(pendingPath(path)));
    exclusive(path+'.bootstrap-transfer-'+record.id+'.json',{version:1,owner,record,pending:value.pending,originalLockPath:path+'.lock',lockOriginal,originalMarkerPath:pendingPath(path),markerOriginal,order:'original lock held -> intent+pending synced -> these originals synced -> original lock released'});
    confirmed=true;return handle;
  }
  finally{finishLauncherBootstrap(bootstrap,confirmed);}
}
export function sealParentTimeFence(handle,receipt){
  const value=timeOwner(handle);
  if(value.state!=='running')fail('QUALIFICATION_PARENT_TIME_PENDING');
  // Revocation in memory precedes receipt I/O; an uncertain migration lock must not prevent elapsed capture.
  value.state='finishing';value.receipt=receipt;
}
export function retainParentTimeReceipt(handle,receipt){
  const value=timeOwner(handle);
  if(value.state!=='finishing')fail('QUALIFICATION_PARENT_TIME_PENDING');checkedRef(receipt);value.receipt=receipt;
}
export function acknowledgeParentTime(handle,transition,budgetSha256,fault=()=>{}){
  const value=timeOwner(handle);
  return withBudgetLock(value.path,value.owner,fence=>{
    fence.uncertain();fault('before_ack_write');
    const ack=exclusive(value.path+'.parent-time-ack-'+value.record.id+'.json',{version:1,id:value.record.id,owner:value.owner,pending:value.pending,transition,budgetSha256});
    fault('after_ack_write');
    if(sha(readPrivate(value.path))!==budgetSha256)fail('QUALIFICATION_PARENT_TIME_CHANGED');
    unlinkSync(pendingPath(value.path));syncParent(value.path);
    if(hasPending(value.path)||JSON.parse(readPrivate(ack.path)).id!==value.record.id)fail('QUALIFICATION_PARENT_TIME_ACK_UNKNOWN');
    value.ack=ack;value.state='closed';fence.confirmed();return ack;
  },handle,'time');
}
export function mutateLegacyBudget(path,owner,change,fault=()=>{}) {
  return withBudgetLock(path,owner,fence=>{
    const before=existsSync(path)?readPrivate(path):null;
    const value=before?JSON.parse(before):{version:1,providerSends:0,mcpAttempts:0,containers:[]};
    if(Object.hasOwn(value,'qualificationReservations'))fail('NATIVE_RESERVATION_ACTIVATION_HELD');
    const next=change(JSON.parse(canonical(value)));
    if(!next||Object.hasOwn(next,'qualificationReservations'))fail('NATIVE_RESERVATION_ACTIVATION_HELD');
    if(same(next,value)&&before)return next;
    fence.uncertain();
    const temporary=path+'.next.'+fence.token;
    exclusive(path+'.transition.'+fence.token,{version:1,kind:'legacy',owner,nonce:fence.token,before:before?sha(before):null,proposed:sha(canonical(next)+'\n')});
    exclusive(temporary,next);fault('before_commit');
    if(before?sha(readPrivate(path))!==sha(before):existsSync(path))fail('QUALIFICATION_LEDGER_CHANGED');
    renameSync(temporary,path);syncParent(path);fault('after_commit');
    if(!same(JSON.parse(readPrivate(path)),next))fail('QUALIFICATION_COMMIT_UNKNOWN');
    exclusive(path+'.committed.'+fence.token,{version:1,nonce:fence.token,digest:sha(readPrivate(path))});fence.confirmed();return next;
  });
}

/** Closed debit-only pending-fence exception. It cannot write caps, grants, time or any production S02 data. */
function performS03Debit(path,input,{copied=false,fault=()=>{}}={}){
  const owner=localOwner(),handle=Object.freeze({});s03Debits.set(handle,{path,input,copied,owner,scope:null});
  try{return withBudgetLock(path,owner,fence=>{
    const original=readPrivate(path),scope=s03Debits.get(handle).scope;const result=applyS03Debit(scope,input);
    if(result.existing)return result;
    scope.value.qualificationReservations.revision++;const bytes=Buffer.from(canonical(scope.value)+'\n'),temporary=path+'.s03-next-'+fence.token;
    fence.uncertain();exclusive(path+'.s03-transition-'+fence.token,{version:1,kind:'debit-only',before:sha(original),proposed:sha(bytes),reservationId:input.reservationId,key:input.key});
    exclusive(temporary,bytes);fault('before_commit');if(sha(readPrivate(path))!==sha(original))fail('QUALIFICATION_LEDGER_CHANGED');renameSync(temporary,path);syncParent(path);fault('after_commit');
    if(!readPrivate(path).equals(bytes))fail('QUALIFICATION_COMMIT_UNKNOWN');exclusive(path+'.s03-committed-'+fence.token,{version:1,sha256:sha(bytes),reservationId:input.reservationId});fence.confirmed();return result;
  },handle,'s03-debit');}finally{s03Debits.delete(handle);}
}

export function debitS03Reservation(path,input,options={}){
  if(!['containers','provider','mcp','node','process','cleanup-process','claim','process-bind','node-close','dispatch','physical','listener','listener-close'].includes(input.kind))fail('QUALIFICATION_S03_OBSERVATION_REQUIRED');return performS03Debit(path,input,options);
}
/** No supplied-data release: the original fixed native inspect is performed here before the closed debit. */
export function observeS03Container(path,base,name,id,mode,{copied=false,observe=null,fault=()=>{}}={}){
  if(!['bind','absent'].includes(mode)||observe&&!copied||copied&&!observe)fail('QUALIFICATION_S03_OBSERVATION_REQUIRED');
  const {plan}=s03DebitScope(path,{...base,kind:mode},copied,true),args=['--config',plan.client,'--host','unix://'+plan.socket,'inspect',mode==='bind'?name:id];
  let result;if(observe)result=observe(args);else try{result={exit:0,signal:null,stdout:originalS03Reads(plan.executable,args,{encoding:'utf8',timeout:Math.max(1,Math.min(2000,Number(BigInt(plan.clock.hardCutoff)-BigInt(process.hrtime.bigint()/1000000n)))),maxBuffer:65536,env:{PATH:'/usr/local/bin:/usr/bin:/bin',LANG:'C'}}),stderr:''};}catch(error){result={exit:error.status,signal:error.signal??null,stdout:error.stdout??'',stderr:error.stderr??''};}
  let identity;if(mode==='bind'){
    if(result.exit!==0||result.signal!==null)fail('QUALIFICATION_S03_SCOPE');const rows=JSON.parse(result.stdout);if(rows.length!==1||rows[0].Id!==id||rows[0].Name!=='/'+name)fail('QUALIFICATION_S03_SCOPE');identity={name,id,image:rows[0].Image,labels:rows[0].Config.Labels};
  }else{if(result.signal!==null)fail('QUALIFICATION_S03_SCOPE');identity={name,id,exit:result.exit,stdout:result.stdout,stderr:result.stderr};}
  return performS03Debit(path,{...base,kind:mode,key:mode+':'+name,units:0,identity},{copied,fault});
}
