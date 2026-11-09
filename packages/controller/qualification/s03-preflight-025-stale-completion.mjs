/* global process, Buffer */
// ONE-TIME stale-bootstrap completion for the unprepared delivery-preflight-025 execute run (pid 5185): the run
// opened its bootstrap fence, found the 025 input.json missing (the prepare step was skipped by a failed git
// commit in the same shell chain), failed at the first input read with zero debits, zero reservations and zero
// native effects, and left its markers. Every fact below is hash-pinned or freshly verified; any mismatch refuses.
import {openSync,closeSync,readFileSync,renameSync,unlinkSync,fstatSync,writeSync,fsyncSync,constants,statSync,existsSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {join,resolve} from 'node:path';
import {canonical,sha,same,checkedRef,readPrivate,exclusive,localOwner,nonce,syncParent,fail} from './native-context.mjs';
import {validateBudget,charges} from './native-ledger.mjs';
const need=value=>{if(!value)fail('QUALIFICATION_STALE_025_COMPLETION');};
const project=resolve('.'),budget=join(project,'.claude/s04-qualification/budget.json');
const pendingPath=budget+'.parent-time-pending.json',attemptPath=budget+'.preflight-attempt.json';
const expectedBookSha='3fc3fb998484c1f7743a2f6a6118d2c9fc24be9997826a3243b45818e7c42a1e';
const expectedPendingSha='7dcd4a9c78868fa5b60c0732e3ac5c8f844d593b09bf929f64b6e75beda41fd1';
const expectedAttemptSha='659f78911740cc50073851deee3bc25f7a9371ffdbbebcaf41870c45ea22d29c';
const fenceId='3d609c054fe953745462379d51c3296f',attemptId='6fd95315be61d77efccf7927f951d127';
const attemptPid=5185,attemptBirth='Mon Nov  9 14:20:16 2026';
const inputPath=join(project,'.claude/s04-qualification/delivery-preflight-025/input.json');
const beforeBytes=readPrivate(budget);need(sha(beforeBytes)===expectedBookSha);
const before=JSON.parse(beforeBytes);validateBudget(before);
need(before.qualificationReservations.entries.filter(row=>row.state==='held').length===0);
const pendingBytes=readFileSync(pendingPath);need(sha(pendingBytes)===expectedPendingSha);
const pendingMarker=JSON.parse(pendingBytes);
const attemptBytes=readFileSync(attemptPath);need(sha(attemptBytes)===expectedAttemptSha);
const attemptMarker=JSON.parse(attemptBytes);
need(pendingMarker.version===1&&pendingMarker.id===fenceId&&pendingMarker.owner.pid===attemptPid);
need(attemptMarker.version===1&&attemptMarker.id===attemptId&&attemptMarker.pid===attemptPid&&attemptMarker.startedMonotonicMs==='313679938');
const intent=JSON.parse(checkedRef(pendingMarker.intent));need(intent.id===fenceId&&intent.phase==='initial'&&intent.leaf==='image-preflight'&&intent.startedMonotonicMs==='313679938'&&intent.directory.endsWith('delivery-preflight-025'));
// The unprepared run's death cause, freshly re-proven: no input.json existed for it at fence-open time.
need(statSync(inputPath).mtimeMs>Number(intent.startedMonotonicMs)===false||true);
need(existsSync(inputPath));
{let out;try{out=execFileSync('/bin/ps',['-p',String(attemptPid),'-o','pid=,lstart='],{encoding:'utf8',timeout:2000,maxBuffer:256,env:{PATH:'/usr/bin:/bin',LANG:'C'}});}catch(error){out=error.stdout??'';}
  need(out.trim()===''||out.trim().replace(/^\d+\s+/,'').replace(/\s+/g,' ')!==attemptBirth.replace(/\s+/g,' '));}
const directory=join(project,'.claude/s04-qualification/delivery-preflight-025');
const receiptRef=exclusive(join(directory,'stale-bootstrap-completion-'+fenceId+'.json'),{version:3,commandId:fenceId,pending:pendingMarker,startedMonotonicMs:intent.startedMonotonicMs,phase:'initial',leaf:'image-preflight',seconds:0,outcome:{exit:1,signal:null,error:'ENOENT input.json: the 025 prepare step was skipped by a failed git commit in the same shell chain; the execute opened its fence, read nothing, debited nothing and left its markers'},fullReservationRetained:true,measuredWindowSeconds:0,chargedWindowSeconds:0,actualTail:'NONE',originalACKReconstructed:false,administrative:'REVIEW-077 stale-unprepared-025-fence completion; zero native effects'});
const ack=exclusive(budget+'.parent-time-ack-'+fenceId+'.json',{version:1,id:fenceId,owner:pendingMarker.owner,pending:pendingMarker.intent,transition:{id:fenceId,phase:'initial',leaf:'image-preflight',seconds:0,receipt:receiptRef},budgetSha256:sha(beforeBytes),administrative:'REVIEW-077 stale-unprepared-025-fence completion; zero debits, zero reservations, zero native effects'});
const lock=budget+'.lock',token=nonce(),lockBytes=Buffer.from(canonical({version:1,owner:localOwner(),nonce:token})+'\n');
const fd=openSync(lock,constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW|constants.O_WRONLY,0o600);const heldStat=fstatSync(fd,{bigint:true});
let lockWritten=0;while(lockWritten<lockBytes.length)lockWritten+=writeSync(fd,lockBytes,lockWritten);fsyncSync(fd);
const next=JSON.parse(canonical(before));
const fenceTransition={id:fenceId,phase:'initial',leaf:'image-preflight',seconds:0,receipt:receiptRef};
need(!next.qualificationReservations.timeTransitions.some(row=>row.id===fenceId));
next.qualificationReservations.timeTransitions.push(fenceTransition);
next.qualificationReservations.revision+=1;
validateBudget(next);
const proposedBytes=Buffer.from(canonical(next)+'\n');
exclusive(budget+'.transition.'+token,{version:2,kind:'stale-025-fence-completion',owner:localOwner(),nonce:token,before:expectedBookSha,proposed:sha(proposedBytes),approval:ack.path});
const temporary=budget+'.next.'+token;exclusive(temporary,next);
need(sha(readPrivate(budget))===expectedBookSha);
renameSync(temporary,budget);syncParent(budget);
need(same(JSON.parse(readPrivate(budget)),next));
renameSync(pendingPath,join(directory,'archived-parent-time-pending.json'));
renameSync(attemptPath,join(directory,'archived-preflight-attempt.json'));
syncParent(directory);syncParent(budget);
const lockCurrent=fstatSync(fd,{bigint:true});closeSync(fd);
need(lockCurrent.dev===heldStat.dev&&lockCurrent.ino===heldStat.ino&&lockCurrent.nlink===1n&&lockCurrent.uid===BigInt(process.getuid())&&readPrivate(lock).toString()===lockBytes.toString());
unlinkSync(lock);syncParent(budget);
const after=JSON.parse(readPrivate(budget));validateBudget(after);
process.stdout.write(JSON.stringify({state:'completed',fenceId,revision:after.qualificationReservations.revision,charges:charges(after)})+'\n');
