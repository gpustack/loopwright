/* global process, Buffer */
// ONE-TIME administrative disposition of the second failed preflight-013 attempt (record
// 9a2d77a76d269396b101e46b2e4ef190 / attempt marker 9cf67fc6d88b0fd845c16b90b4768fcf, pid 591), approved verbatim
// by REVIEW-070 R-2
// (/Users/thxcode/Documents/github.com/thxcode/loopwright/.claude/reports/loopwright-harness-architecture/spec-S04/REVIEW-070-preflight-013-preimage-restoration-and-014-continuation.md,
// sha256 9f5e52f5ce473af31f699b838ca74571b5f4e5c6280a1850e206939d9d05e60e). Preconditions are pinned to the exact
// recorded bytes and live host absence; any mismatch, rerun, or foreign state refuses before any write. Not a
// generic disposition route, refund, settlement, or production S02 write.
import {openSync,closeSync,readFileSync,renameSync,unlinkSync,fstatSync,writeSync,fsyncSync,constants} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {join,resolve} from 'node:path';
import {canonical,sha,same,checkedRef,readPrivate,exclusive,localOwner,monotonic,nonce,syncParent,fail} from './native-context.mjs';
import {validateBudget,charges} from './native-ledger.mjs';
const started=monotonic();
const need=value=>{if(!value)fail('QUALIFICATION_PREFLIGHT_RECONCILIATION');};
const project=resolve('.'),budget=join(project,'.claude/s04-qualification/budget.json');
const pendingPath=budget+'.parent-time-pending.json',attemptPath=budget+'.preflight-attempt.json';
const expectedBookSha='c53eac0b1d646daf8db0dcaf229093e51b694f1b4ed2361f8bc5850fafb37e70';
const expectedPendingSha='8ae81fde239485368ba6a30daec225a9326ba9e2eec58b365d4616adf7f44fe6';
const expectedAttemptSha='27bed0b9934cd71a44d77b9e304d93f600df7db2a91f92d2b47d6087d50c86ab';
const timeId='9a2d77a76d269396b101e46b2e4ef190',attemptId='9cf67fc6d88b0fd845c16b90b4768fcf';
const approvalSource='/Users/thxcode/Documents/github.com/thxcode/loopwright/.claude/reports/loopwright-harness-architecture/spec-S04/REVIEW-070-preflight-013-preimage-restoration-and-014-continuation.md';
const approvalSha='9f5e52f5ce473af31f699b838ca74571b5f4e5c6280a1850e206939d9d05e60e';
const elapsedPath=join(project,'.claude/s04-qualification/delivery-preflight-013/preflight-elapsed-'+timeId+'.json');
const expectedElapsedSha='b7199e0112e2e5e5898bf65f42884c28503dc89dfb5c7c86d14a2c0f9fd495a3';
const beforeBytes=readPrivate(budget);need(sha(beforeBytes)===expectedBookSha);
const before=JSON.parse(beforeBytes);validateBudget(before);
const pendingBytes=readFileSync(pendingPath);need(sha(pendingBytes)===expectedPendingSha);
const pendingMarker=JSON.parse(pendingBytes);
const attemptBytes=readFileSync(attemptPath);need(sha(attemptBytes)===expectedAttemptSha);
const attemptMarker=JSON.parse(attemptBytes);
const elapsedBytes=readFileSync(elapsedPath);need(sha(elapsedBytes)===expectedElapsedSha);
const elapsed=JSON.parse(elapsedBytes);
need(pendingMarker.version===1&&pendingMarker.id===timeId&&pendingMarker.owner.pid===591);
need(attemptMarker.version===1&&attemptMarker.id===attemptId&&attemptMarker.pid===591&&attemptMarker.startedMonotonicMs==='299662618');
const intent=JSON.parse(checkedRef(pendingMarker.intent));need(intent.id===timeId&&intent.phase==='initial'&&intent.leaf==='image-preflight'&&intent.startedMonotonicMs==='299662618'&&intent.owner.pid===591);
need(elapsed.commandId===timeId&&elapsed.seconds===0.077&&elapsed.leaf==='image-preflight'&&elapsed.phase==='initial');
// Live host absence of both failed preflight-013 pids, birth-pinned.
const births={97085:'Mon Nov  9 10:24:09 2026',591:'Mon Nov  9 10:26:39 2026'};
for(const pid of [97085,591]){let out;try{out=execFileSync('/bin/ps',['-p',String(pid),'-o','pid=,lstart='],{encoding:'utf8',timeout:2000,maxBuffer:256,env:{PATH:'/usr/bin:/bin',LANG:'C'}});}catch(error){out=error.stdout??'';}
  if(!out.trim())continue;
  const lstart=out.trim().replace(/^\d+\s+/,'').trim();need(lstart.replace(/\s+/g,' ')!==births[pid].replace(/\s+/g,' '));}
const directory=join(project,'.claude/s04-qualification/delivery-preflight-013');
const approvalBytes=readFileSync(approvalSource);need(sha(approvalBytes)===approvalSha);
const reconciliationId=nonce();
const reconciliationSeconds=Number(monotonic()-started)/1000;
const reconciliationReceiptRef=exclusive(join(directory,'incident-reconciliation-'+reconciliationId+'.json'),{version:3,commandId:reconciliationId,pending:pendingMarker,startedMonotonicMs:String(started),phase:'initial',leaf:'incident-reconciliation',seconds:reconciliationSeconds,outcome:{exit:0,signal:null,error:null,administrative:'REVIEW-070 R-2 disposition of the second failed preflight-013 attempt'},fullReservationRetained:true});
// One serialized compare-and-commit book mutation carrying both time transitions.
const lock=budget+'.lock',token=nonce(),lockBytes=Buffer.from(canonical({version:1,owner:localOwner(),nonce:token})+'\n');
const fd=openSync(lock,constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW|constants.O_WRONLY,0o600);const heldStat=fstatSync(fd,{bigint:true});
let lockWritten=0;while(lockWritten<lockBytes.length)lockWritten+=writeSync(fd,lockBytes,lockWritten);fsyncSync(fd);
const next=JSON.parse(canonical(before));
const imageTransition={id:timeId,phase:'initial',leaf:'image-preflight',seconds:0.077,receipt:{path:elapsedPath,byteLength:elapsedBytes.length,sha256:expectedElapsedSha}};
const reconciliationTransition={id:reconciliationId,phase:'initial',leaf:'incident-reconciliation',seconds:reconciliationSeconds,receipt:reconciliationReceiptRef};
need(!next.qualificationReservations.timeTransitions.some(row=>row.id===timeId||row.id===reconciliationId));
next.qualificationReservations.timeTransitions.push(imageTransition,reconciliationTransition);
next.native.seconds.initial+=imageTransition.seconds+reconciliationTransition.seconds;
next.native.leafSeconds['initial:image-preflight']=(next.native.leafSeconds['initial:image-preflight']??0)+imageTransition.seconds;
next.native.leafSeconds['initial:incident-reconciliation']=(next.native.leafSeconds['initial:incident-reconciliation']??0)+reconciliationTransition.seconds;
next.qualificationReservations.revision+=1;
validateBudget(next);
const proposedBytes=Buffer.from(canonical(next)+'\n');
exclusive(budget+'.transition.'+token,{version:2,kind:'administrative-preflight-013-reconciliation',owner:localOwner(),nonce:token,before:expectedBookSha,proposed:sha(proposedBytes),approval:{path:approvalSource,byteLength:approvalBytes.length,sha256:approvalSha}});
const temporary=budget+'.next.'+token;exclusive(temporary,next);
need(sha(readPrivate(budget))===expectedBookSha);
renameSync(temporary,budget);syncParent(budget);
need(same(JSON.parse(readPrivate(budget)),next));
const ack=exclusive(budget+'.parent-time-ack-'+timeId+'.json',{version:1,id:timeId,owner:pendingMarker.owner,pending:pendingMarker.intent,transition:imageTransition,budgetSha256:sha(proposedBytes)});
renameSync(pendingPath,join(directory,'archived-parent-time-pending-9a2d77a7.json'));
renameSync(attemptPath,join(directory,'archived-preflight-attempt-9cf67fc6.json'));
syncParent(directory);syncParent(budget);
const lockCurrent=fstatSync(fd,{bigint:true});closeSync(fd);
need(lockCurrent.dev===heldStat.dev&&lockCurrent.ino===heldStat.ino&&lockCurrent.nlink===1n&&lockCurrent.uid===BigInt(process.getuid())&&readPrivate(lock).toString()===lockBytes.toString());
unlinkSync(lock);syncParent(budget);
const after=JSON.parse(readPrivate(budget));validateBudget(after);
process.stdout.write(JSON.stringify({state:'reconciled',timeId,attemptId,ack:ack.path,reconciliationSeconds,revision:after.qualificationReservations.revision,leafSeconds:after.native.leafSeconds['initial:image-preflight'],charges:charges(after)})+'\n');
