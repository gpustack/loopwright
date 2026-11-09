/* global process, Buffer */
// ONE-TIME administrative disposition of held s03 reservation 2b406a650f23327d40045de61eb95162 (limits attempt 2,
// drained at its 280s workCutoff and killed by a debit lock race before accounting), approved by REVIEW-076 R-α
// (the coordinator's reply to HANDBACK-088). Preconditions are pinned to exact recorded bytes and live absence;
// any mismatch, rerun, or foreign state refuses before any write. Not a generic route, refund, settlement, or
// production S02 write. The charge is the measured drained window, never the unused remainder.
import {openSync,closeSync,readFileSync,renameSync,unlinkSync,fstatSync,writeSync,fsyncSync,constants} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {join,resolve} from 'node:path';
import {canonical,sha,same,checkedRef,readPrivate,exclusive,localOwner,monotonic,nonce,syncParent,fail} from './native-context.mjs';
import {validateBudget,charges} from './native-ledger.mjs';
const started=monotonic();
const need=value=>{if(!value)fail('QUALIFICATION_LIMITS_DISPOSITION');};
const project=resolve('.'),budget=join(project,'.claude/s04-qualification/budget.json');
const pendingPath=budget+'.parent-time-pending.json',attemptPath=budget+'.s03-attempt.json';
const expectedBookSha='4c9de9fb3ed9983c1a9bc92f894a903906648592e8cd17b0fff41b7deae1bb47';
const expectedPendingSha='7203138c67fcc8c69f42ffa94cbaa0501001021d869977e2250a751c4c44a766';
const expectedAttemptSha='9567b9a931eb9784b1db4a5e20134761efbec19ce35f85bfa5edf363059ce5f0';
const heldId='2b406a650f23327d40045de61eb95162',timeId='035986db62b6f92eb8b3796f89ee48ba';
const approvalSource='/Users/thxcode/Documents/github.com/thxcode/loopwright/.claude/reports/loopwright-harness-architecture/spec-S04/HANDBACK-088-limits-lock-race-and-continuation.md';
const approvalSha='72e3a54ac62f7bcae1ec1b899461914dfa0e3ae9183332a90755ea5e62306eb1';
const beforeBytes=readPrivate(budget);need(sha(beforeBytes)===expectedBookSha);
const before=JSON.parse(beforeBytes);validateBudget(before);
const pendingBytes=readFileSync(pendingPath);need(sha(pendingBytes)===expectedPendingSha);
const pendingMarker=JSON.parse(pendingBytes);
const attemptBytes=readFileSync(attemptPath);need(sha(attemptBytes)===expectedAttemptSha);
const attemptMarker=JSON.parse(attemptBytes);
const attemptMarkerVersionCheck={id:'14f8ab24299a3a238a6b564e3df07e45',pid:23821,startedMonotonicMs:'309653221'};
const entry=before.qualificationReservations.entries.find(row=>row.id===heldId);
need(entry&&entry.state==='held'&&entry.actual===null&&entry.seal===null&&same(entry.caps,{containers:52,provider:46,mcp:128}));
need(entry.context.dispatchId==='ctx_242594ec6fb9');
need(pendingMarker.version===1&&pendingMarker.id===timeId&&same(pendingMarker.owner,entry.owner));
need(attemptMarker.version===1&&attemptMarker.id===attemptMarkerVersionCheck.id&&attemptMarker.pid===entry.owner.pid);
const intent=JSON.parse(checkedRef(pendingMarker.intent));need(intent.id===timeId&&intent.phase==='finalPi'&&intent.leaf==='s03-limits'&&same(intent.owner,entry.owner));
const plan=JSON.parse(checkedRef(entry.s03.plan)),directory=plan.directory,events=entry.s03.events;
need(same(plan.owner,entry.owner)&&Array.isArray(entry.s03.occupants)&&Array.isArray(events)&&same(plan.timeIntent,pendingMarker.intent));
const startMono=Number(intent.startedMonotonicMs),drainedMono=Number(events.at(-1).monotonicMs);
const measuredWindowSeconds=(drainedMono-startMono)/1000;
// Live host absence: every recorded pid, container and listener.
const dockerArgs=['--config',plan.client,'--host','unix://'+plan.socket];
const births=new Map();
for(const row of events.filter(row=>['node','process','cleanup-process'].includes(row.kind))){
  for(const identity of [row.identity.child,row.identity.result,row.actor])if(identity&&Number.isSafeInteger(identity.pid)&&identity.pid>0&&typeof identity.birth==='string')births.set(identity.pid,identity.birth);
}
const pids=new Set([pendingMarker.owner.pid]);
for(const row of events.filter(row=>['node','process','cleanup-process'].includes(row.kind))){
  for(const candidate of [row.identity.child?.pid,row.identity.result?.pid,row.actor.pid])if(Number.isSafeInteger(candidate)&&candidate>0)pids.add(candidate);
}
const reused={};
for(const pid of pids){let out;try{execFileSync('/bin/ps',['-p',String(pid),'-o','pid=,lstart='],{encoding:'utf8',timeout:2000,maxBuffer:256,env:{PATH:'/usr/bin:/bin',LANG:'C'}});}catch(error){out=error.stdout??'';}
  if(!out.trim())continue;
  const lstart=out.trim().replace(/^\d+\s+/,'').trim(),recorded=births.get(pid);
  need(recorded!==undefined&&lstart.length>0&&lstart.replace(/\s+/g,' ')!==recorded.replace(/\s+/g,' '));
  reused[pid]={recordedBirth:recorded,liveForeignLstart:lstart};}
const containers=events.filter(row=>row.kind==='containers');
for(const row of containers){let exit=0,stderr='';try{execFileSync(plan.executable,[...dockerArgs,'inspect',row.identity.id],{encoding:'utf8',timeout:3000,maxBuffer:65536,env:{PATH:'/usr/local/bin:/usr/bin:/bin',LANG:'C'}});fail('QUALIFICATION_LIMITS_DISPOSITION_LIVE_CONTAINER');}catch(error){exit=error.status;stderr=String(error.stderr??'');}
  need(exit===1&&new RegExp('^error: no such (?:object|container): '+row.identity.id+'$','i').test(stderr.trim()));}
for(const row of events.filter(row=>row.kind==='listener')){let out;try{out=execFileSync('/usr/sbin/lsof',['-nP','-a','-p',String(row.actor.pid),'-iTCP:'+row.identity.port,'-sTCP:LISTEN','-Fp'],{encoding:'utf8',timeout:2000,maxBuffer:4096,env:{PATH:'/usr/sbin:/usr/bin:/bin',LANG:'C'}});}catch(error){out=error.stdout??'';}need(out.trim()==='');}
const exclusiveSame=(path,value)=>{const bytes=Buffer.isBuffer(value)?value:Buffer.from(canonical(value)+'\n');let current=null;try{current=readFileSync(path);}catch(error){if(error.code!=='ENOENT')throw error;}if(current===null)return exclusive(path,value);need(current.equals(bytes));return {path,byteLength:bytes.length,sha256:sha(bytes)};};
const approvalBytes=readFileSync(approvalSource);need(sha(approvalBytes)===approvalSha);
const heldBeforeRef=exclusiveSame(join(directory,'held-before-allocation.json'),beforeBytes);
const auditRef=exclusiveSame(join(directory,'original-scope-audit.json'),{plan:entry.s03.plan,events,occupants:[]});
const receiptRef=exclusive(join(directory,'native-parent-elapsed-'+timeId+'.json'),{version:3,commandId:timeId,pending:pendingMarker,startedMonotonicMs:intent.startedMonotonicMs,phase:'finalPi',leaf:'s03-limits',seconds:measuredWindowSeconds,outcome:{exit:1,signal:null,error:'ORIGINAL_S03_FAILED'},fullReservationRetained:true,measuredLastEventSeconds:(drainedMono-startMono)/1000,chargedWindowSeconds:measuredWindowSeconds,actualTail:'UNKNOWN',originalACKReconstructed:false,administrative:'REVIEW-076 disposition of the lock-race failed limits attempt'});
const approvalRef=exclusiveSame(join(directory,'approval-retirement-original.bin'),approvalBytes);
const closureRef=exclusiveSame(join(directory,'disposition-closure.json'),{version:1,kind:'s03-limits-disposition-closure',reservationId:heldId,timeId,verified:{bookSha256:expectedBookSha,pendingSha256:expectedPendingSha,attemptSha256:expectedAttemptSha,approvalSha256:approvalSha,deadPids:[...pids].filter(pid=>reused[String(pid)]===undefined&&reused[pid]===undefined).sort((a,b)=>a-b),reusedForeignPidBirths:reused,containersAbsent:containers.map(row=>row.identity.id).sort(),listenersClosed:events.filter(row=>row.kind==='listener').map(row=>({pid:row.actor.pid,port:row.identity.port}))},closure:'complete original owned closure verified read-only immediately before disposition; drained-at-workCutoff tail retained UNKNOWN; original ACK absent and never reconstructed',accounting:'full nonrefundable allocated_unknown; actual use and billing UNKNOWN; original NativeTerminal seal ABSENT'});
const dispositionRef=exclusiveSame(join(directory,'full-allocation.json'),{version:1,kind:'qualification-administrative-allocation',reservationId:heldId,original:heldBeforeRef,caps:entry.caps,owner:entry.owner,nonrefundable:true,originalOutcome:'FAIL',actual:'UNKNOWN',originalSeal:'ABSENT',closure:closureRef,approval:approvalRef});
const lock=budget+'.lock',token=nonce(),lockBytes=Buffer.from(canonical({version:1,owner:localOwner(),nonce:token})+'\n');
const fd=openSync(lock,constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW|constants.O_WRONLY,0o600);const heldStat=fstatSync(fd,{bigint:true});
let lockWritten=0;while(lockWritten<lockBytes.length)lockWritten+=writeSync(fd,lockBytes,lockWritten);fsyncSync(fd);
const reconciliationSeconds=Number(monotonic()-started)/1000;
const next=JSON.parse(canonical(before));
const target=next.qualificationReservations.entries.find(row=>row.id===heldId);need(target&&target.state==='held');
target.state='allocated_unknown';target.actual=null;target.seal=null;target.s03={plan:target.s03.plan,audit:auditRef};target.administrative={original:heldBeforeRef,disposition:dispositionRef};
const drainedTransition={id:timeId,phase:'finalPi',leaf:'s03-limits',seconds:measuredWindowSeconds,receipt:receiptRef};
const reconciliationId=nonce();
const reconciliationTransition={id:reconciliationId,phase:'initial',leaf:'incident-reconciliation',seconds:reconciliationSeconds,receipt:exclusive(join(directory,'incident-reconciliation-'+reconciliationId+'.json'),{version:3,commandId:reconciliationId,pending:pendingMarker,startedMonotonicMs:String(started),phase:'initial',leaf:'incident-reconciliation',seconds:reconciliationSeconds,outcome:{exit:0,signal:null,error:null,administrative:'REVIEW-076 disposition reconciliation'},fullReservationRetained:true})};
need(!next.qualificationReservations.timeTransitions.some(row=>row.id===timeId||row.id===reconciliationId));
next.qualificationReservations.timeTransitions.push(drainedTransition,reconciliationTransition);
next.native.seconds.finalPi+=drainedTransition.seconds;next.native.leafSeconds['finalPi:s03-limits']=(next.native.leafSeconds['finalPi:s03-limits']??0)+drainedTransition.seconds;
next.native.seconds.initial+=reconciliationTransition.seconds;next.native.leafSeconds['initial:incident-reconciliation']=(next.native.leafSeconds['initial:incident-reconciliation']??0)+reconciliationTransition.seconds;
next.qualificationReservations.revision+=1;
validateBudget(next);
const proposedBytes=Buffer.from(canonical(next)+'\n');
exclusive(budget+'.transition.'+token,{version:2,kind:'administrative-limits-disposition',owner:localOwner(),nonce:token,before:expectedBookSha,proposed:sha(proposedBytes),approval:approvalRef});
const temporary=budget+'.next.'+token;exclusive(temporary,next);
need(sha(readPrivate(budget))===expectedBookSha);
renameSync(temporary,budget);syncParent(budget);
need(same(JSON.parse(readPrivate(budget)),next));

renameSync(pendingPath,join(directory,'archived-parent-time-pending.json'));
renameSync(attemptPath,join(directory,'archived-s03-attempt.json'));
syncParent(directory);syncParent(budget);
const lockCurrent=fstatSync(fd,{bigint:true});closeSync(fd);
need(lockCurrent.dev===heldStat.dev&&lockCurrent.ino===heldStat.ino&&lockCurrent.nlink===1n&&lockCurrent.uid===BigInt(process.getuid())&&readPrivate(lock).toString()===lockBytes.toString());
unlinkSync(lock);syncParent(budget);
const after=JSON.parse(readPrivate(budget));validateBudget(after);
process.stdout.write(JSON.stringify({state:'reconciled',reservationId:heldId,timeId,ackPath:join(budget+'.parent-time-ack-'+timeId+'.json'),measuredWindowSeconds,reconciliationSeconds,revision:after.qualificationReservations.revision,leafSeconds:after.native.leafSeconds['finalPi:s03-limits'],charges:charges(after)})+'\n');
