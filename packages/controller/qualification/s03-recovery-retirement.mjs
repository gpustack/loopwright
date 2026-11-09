/* global process, Buffer */
// ONE-TIME administrative retirement of held s03 reservation 98904c9d82f40321b157d5d353641a5f (failed recovery
// attempt drained at its original window), approved verbatim by REVIEW-069 R-A
// (/Users/thxcode/Documents/github.com/thxcode/loopwright/.claude/reports/loopwright-harness-architecture/spec-S04/REVIEW-069-recovery-disposition-mcp-calibration-and-envelopes.md,
// sha256 1981a7149f487761c144d036f04d92e6ea364386c220bab6cec75558a76cfe0a). Every precondition is checked against
// the exact recorded bytes and live host absence; any mismatch, rerun, or foreign state refuses before any write.
// This is not a generic disposition route, a refund, a settlement, or a production S02 write.
import {openSync,closeSync,readFileSync,renameSync,unlinkSync,fstatSync,writeSync,fsyncSync,constants} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {join,resolve} from 'node:path';
import {canonical,sha,same,checkedRef,readPrivate,exclusive,localOwner,monotonic,nonce,syncParent,fail} from './native-context.mjs';
import {validateBudget,charges} from './native-ledger.mjs';
const started=monotonic();
const need=value=>{if(!value)fail('QUALIFICATION_RECOVERY_RETIREMENT');};
/** Idempotent evidence write: an existing file must already match the intended bytes exactly, else refuse. */
const exclusiveSame=(path,value)=>{const bytes=Buffer.isBuffer(value)?value:Buffer.from(canonical(value)+'\n');let current=null;try{current=readFileSync(path);}catch(error){if(error.code!=='ENOENT')throw error;}if(current===null)return exclusive(path,value);need(current.equals(bytes));return {path,byteLength:bytes.length,sha256:sha(bytes)};};
const project=resolve('.'),budget=join(project,'.claude/s04-qualification/budget.json');
const pendingPath=budget+'.parent-time-pending.json',attemptPath=budget+'.s03-attempt.json';
const expectedBookSha='562f6260a190494e743145633db9e2ef5dde733327384755def89c3f64a94dfa';
const expectedPendingSha='f9a064edf72f5a98d4aaa95631c49a7f512643f92efdaef67b2c3e16fbfb9ff1';
const expectedAttemptSha='e2a95bc332cdad89857e3bc79238fdf855203d185f33b669696d89dd231d59cf';
const heldId='98904c9d82f40321b157d5d353641a5f',timeId='c051b45a87f0fd8a1a41402e0170a619';
const approvalSource='/Users/thxcode/Documents/github.com/thxcode/loopwright/.claude/reports/loopwright-harness-architecture/spec-S04/REVIEW-069-recovery-disposition-mcp-calibration-and-envelopes.md';
const approvalSha='1981a7149f487761c144d036f04d92e6ea364386c220bab6cec75558a76cfe0a';
const beforeBytes=readPrivate(budget);need(sha(beforeBytes)===expectedBookSha);
const before=JSON.parse(beforeBytes);validateBudget(before);
const pendingBytes=readFileSync(pendingPath);need(sha(pendingBytes)===expectedPendingSha);
const pendingMarker=JSON.parse(pendingBytes);
const attemptBytes=readFileSync(attemptPath);need(sha(attemptBytes)===expectedAttemptSha);
const attemptMarker=JSON.parse(attemptBytes);
const entry=before.qualificationReservations.entries.find(row=>row.id===heldId);
need(entry&&entry.state==='held'&&entry.actual===null&&entry.seal===null&&same(entry.caps,{containers:36,provider:40,mcp:128}));
need(entry.context.dispatchId==='ctx_242594ec6fb9'&&entry.context.runId==='run_316587aa2c7f'&&entry.context.taskId==='task_79ce55c2b3a8');
need(pendingMarker.version===1&&pendingMarker.id===timeId&&pendingMarker.owner.pid===61529&&same(pendingMarker.owner,entry.owner));
const intent=JSON.parse(checkedRef(pendingMarker.intent));need(intent.id===timeId&&intent.phase==='finalPi'&&intent.leaf==='s03-recovery'&&intent.startedMonotonicMs==='295215302'&&same(intent.owner,entry.owner));
need(attemptMarker.version===1&&attemptMarker.id==='52d826e58dee47bc175f7fd664225ee0'&&attemptMarker.pid===61529&&attemptMarker.startedMonotonicMs==='295215302');
const plan=JSON.parse(checkedRef(entry.s03.plan)),directory=plan.directory,events=entry.s03.events;
need(same(plan.owner,entry.owner)&&Array.isArray(entry.s03.occupants)&&entry.s03.occupants.length===0&&Array.isArray(events)&&same(plan.timeIntent,pendingMarker.intent));
// Fresh complete live absence: every recorded pid (including the dead supervisor), container and listener.
// A pid whose lstart now shows a process born AFTER the recorded identity's own birth is proven reuse by a foreign
// process, not liveness of the recorded one; pids without a recorded birth still require strict absence.
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
  reused[pid]={recordedBirth:recorded,liveForeignLstart:lstart};
}
const containers=events.filter(row=>row.kind==='containers');
for(const row of containers){let exit=0,stderr='';try{execFileSync(plan.executable,[...dockerArgs,'inspect',row.identity.id],{encoding:'utf8',timeout:3000,maxBuffer:65536,env:{PATH:'/usr/local/bin:/usr/bin:/bin',LANG:'C'}});fail('QUALIFICATION_RECOVERY_RETIREMENT_LIVE_CONTAINER');}catch(error){exit=error.status;stderr=String(error.stderr??'');}
  need(exit===1&&new RegExp('^error: no such (?:object|container): '+row.identity.id+'$','i').test(stderr.trim()));}
for(const row of events.filter(row=>row.kind==='listener')){let out;try{out=execFileSync('/usr/sbin/lsof',['-nP','-a','-p',String(row.actor.pid),'-iTCP:'+row.identity.port,'-sTCP:LISTEN','-Fp'],{encoding:'utf8',timeout:2000,maxBuffer:4096,env:{PATH:'/usr/sbin:/usr/bin:/bin',LANG:'C'}});}catch(error){out=error.stdout??'';}need(out.trim()==='');}
// Disposition evidence, written once into the attempt directory before the single serialized book mutation.
const approvalBytes=readFileSync(approvalSource);need(sha(approvalBytes)===approvalSha);
const heldBeforeRef=exclusiveSame(join(directory,'held-before-allocation.json'),beforeBytes);
const auditRef=exclusiveSame(join(directory,'original-scope-audit.json'),{plan:entry.s03.plan,events,occupants:[]});
const measuredLastEventSeconds=(Number(events.at(-1).monotonicMs)-Number(intent.startedMonotonicMs))/1000;
const receiptRef=exclusiveSame(join(directory,'native-parent-elapsed-'+timeId+'.json'),{version:3,commandId:timeId,pending:pendingMarker,startedMonotonicMs:intent.startedMonotonicMs,phase:'finalPi',leaf:'s03-recovery',seconds:120,outcome:{exit:null,signal:'SIGTERM',error:'ORIGINAL_S03_FAILED'},fullReservationRetained:true,measuredLastEventSeconds,chargedWindowSeconds:120,actualTail:'UNKNOWN',originalACKReconstructed:false,administrative:'REVIEW-069 R-A'});
const approvalRef=exclusiveSame(join(directory,'approval-retirement-original.bin'),approvalBytes);
const closureRef=exclusiveSame(join(directory,'retirement-closure.json'),{version:1,kind:'s03-recovery-retirement-closure',reservationId:heldId,timeId,verified:{bookSha256:expectedBookSha,pendingSha256:expectedPendingSha,attemptSha256:expectedAttemptSha,approvalSha256:approvalSha,deadPids:[...pids].filter(pid=>reused[String(pid)]===undefined&&reused[pid]===undefined).sort((a,b)=>a-b),reusedForeignPidBirths:reused,containersAbsent:containers.map(row=>row.identity.id).sort(),listenersClosed:events.filter(row=>row.kind==='listener').map(row=>({pid:row.actor.pid,port:row.identity.port}))},closure:'complete original owned closure verified read-only immediately before retirement; killed child tails retained UNKNOWN; original ACK absent and never reconstructed',accounting:'full nonrefundable allocated_unknown; actual use and billing UNKNOWN; original NativeTerminal seal ABSENT'});
const dispositionRef=exclusiveSame(join(directory,'full-allocation.json'),{version:1,kind:'qualification-administrative-allocation',reservationId:heldId,original:heldBeforeRef,caps:entry.caps,owner:entry.owner,nonrefundable:true,originalOutcome:'FAIL',actual:'UNKNOWN',originalSeal:'ABSENT',closure:closureRef,approval:approvalRef});
// One serialized compare-and-commit book mutation carrying both time transitions and the entry transition.
const lock=budget+'.lock',token=nonce(),lockBytes=Buffer.from(canonical({version:1,owner:localOwner(),nonce:token})+'\n');
const fd=openSync(lock,constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW|constants.O_WRONLY,0o600);const heldStat=fstatSync(fd,{bigint:true});
let lockWritten=0;while(lockWritten<lockBytes.length)lockWritten+=writeSync(fd,lockBytes,lockWritten);fsyncSync(fd);
const reconciliationSeconds=Number(monotonic()-started)/1000;
const next=JSON.parse(canonical(before));
const target=next.qualificationReservations.entries.find(row=>row.id===heldId);need(target&&target.state==='held');
target.state='allocated_unknown';target.actual=null;target.seal=null;target.s03={plan:target.s03.plan,audit:auditRef};target.administrative={original:heldBeforeRef,disposition:dispositionRef};
const recoveryTransition={id:timeId,phase:'finalPi',leaf:'s03-recovery',seconds:120,receipt:receiptRef};
const reconciliationId=nonce();
const reconciliationTransition={id:reconciliationId,phase:'initial',leaf:'incident-reconciliation',seconds:reconciliationSeconds,receipt:exclusive(join(directory,'incident-reconciliation-'+reconciliationId+'.json'),{version:3,commandId:reconciliationId,pending:pendingMarker,startedMonotonicMs:String(started),phase:'initial',leaf:'incident-reconciliation',seconds:reconciliationSeconds,outcome:{exit:0,signal:null,error:null,administrative:'REVIEW-069 R-A retirement reconciliation'},fullReservationRetained:true})};
need(!next.qualificationReservations.timeTransitions.some(row=>row.id===recoveryTransition.id||row.id===reconciliationTransition.id));
next.qualificationReservations.timeTransitions.push(recoveryTransition,reconciliationTransition);
next.native.seconds.finalPi+=recoveryTransition.seconds;next.native.leafSeconds['finalPi:s03-recovery']=(next.native.leafSeconds['finalPi:s03-recovery']??0)+recoveryTransition.seconds;
next.native.seconds.initial+=reconciliationTransition.seconds;next.native.leafSeconds['initial:incident-reconciliation']=(next.native.leafSeconds['initial:incident-reconciliation']??0)+reconciliationTransition.seconds;
next.qualificationReservations.revision+=1;
validateBudget(next);
const proposedBytes=Buffer.from(canonical(next)+'\n');
exclusive(budget+'.transition.'+token,{version:2,kind:'administrative-recovery-retirement',owner:localOwner(),nonce:token,before:expectedBookSha,proposed:sha(proposedBytes),approval:approvalRef});
const temporary=budget+'.next.'+token;exclusive(temporary,next);
need(sha(readPrivate(budget))===expectedBookSha);
renameSync(temporary,budget);syncParent(budget);
need(same(JSON.parse(readPrivate(budget)),next));
// Acknowledge the completed administrative parent time exactly like the original route, then archive both markers.
const ack=exclusiveSame(budget+'.parent-time-ack-'+timeId+'.json',{version:1,id:timeId,owner:entry.owner,pending:pendingMarker.intent,transition:recoveryTransition,budgetSha256:sha(proposedBytes)});
renameSync(pendingPath,join(directory,'archived-parent-time-pending.json'));
renameSync(attemptPath,join(directory,'archived-s03-attempt.json'));
syncParent(directory);syncParent(budget);
const lockCurrent=fstatSync(fd,{bigint:true});closeSync(fd);
need(lockCurrent.dev===heldStat.dev&&lockCurrent.ino===heldStat.ino&&lockCurrent.nlink===1n&&lockCurrent.uid===BigInt(process.getuid())&&readPrivate(lock).toString()===lockBytes.toString());
unlinkSync(lock);syncParent(budget);
const after=JSON.parse(readPrivate(budget));validateBudget(after);
process.stdout.write(JSON.stringify({state:'retired',reservationId:heldId,timeId,ack:ack.path,disposition:dispositionRef.path,audit:auditRef.path,charges:charges(after),reconciliationSeconds,verifiedPids:pids.size,verifiedContainers:containers.length})+'\n');
