/* global process, Buffer */
import {spawnSync} from 'node:child_process';
import {existsSync,renameSync,readFileSync,mkdirSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {canonical,sha,same,readPrivate,checkedRef,exclusive,syncParent,localOwner,nonce,fail} from './native-context.mjs';
import {withBudgetLock} from './native-lock.mjs';
import {validateBudget} from './native-ledger.mjs';
const project='/Users/thxcode/orca/workspaces/loopwright/loopwright-s04-controller',actual=join(project,'.claude/s04-qualification/budget.json'),program='/Users/thxcode/Documents/github.com/thxcode/loopwright/.claude/reports/loopwright-harness-architecture/spec-S04';
const need=(condition)=>{if(!condition)fail('QUALIFICATION_COLLECTOR_DISPOSITION');};
function allocate(options,observe,fault=()=>{}){
  const started=process.hrtime.bigint();return withBudgetLock(options.path,localOwner(),fence=>{
    const bytes=readPrivate(options.path);need(sha(bytes)===options.bookSha);const book=validateBudget(JSON.parse(bytes)),entry=book.qualificationReservations.entries.find(row=>row.id===options.reservationId);
    need(entry?.state==='held'&&entry.actual===null&&entry.seal===null&&same(entry.owner,options.owner));
    try{process.kill(entry.owner.pid,0);need(false);}catch(error){need(error.code==='ESRCH');}
    const closure=observe(entry);checkedRef(closure);const original=exclusive(join(options.directory,'book-original.bin'),bytes),approval=options.approval;checkedRef(approval);
    const disposition=exclusive(join(options.directory,'disposition.json'),{version:1,kind:'qualification-administrative-allocation',reservationId:entry.id,original,caps:entry.caps,owner:entry.owner,closure,approval,actual:'UNKNOWN',originalSeal:'ABSENT',originalOutcome:'FAIL',nonrefundable:true});
    const id=nonce(),seconds=Number(process.hrtime.bigint()-started)/1e9,receipt=exclusive(join(options.directory,'reconciliation-time.json'),{version:1,id,seconds,interval:'entry through original checks and disposition; commit acknowledgements excluded',disposition});
    const next=JSON.parse(bytes),selected=next.qualificationReservations.entries.find(row=>row.id===entry.id);selected.state='allocated_unknown';selected.administrative={original,disposition};next.qualificationReservations.revision++;
    next.qualificationReservations.timeTransitions.push({id,phase:'initial',leaf:'incident-reconciliation',seconds,receipt});next.native.seconds.initial+=seconds;next.native.leafSeconds['initial:incident-reconciliation']=(next.native.leafSeconds['initial:incident-reconciliation']??0)+seconds;validateBudget(next);
    const proposed=Buffer.from(canonical(next)+'\n'),temporary=options.path+'.collector-incident-next-'+id;
    fence.uncertain();exclusive(join(options.directory,'prepared.json'),{version:1,original,disposition,receipt,proposedSha256:sha(proposed)});exclusive(temporary,proposed);fault('before_commit');need(sha(readPrivate(options.path))===options.bookSha);
    renameSync(temporary,options.path);syncParent(options.path);fault('after_commit');need(readPrivate(options.path).equals(proposed));
    const committed=exclusive(join(options.directory,'committed.json'),{version:1,disposition,receipt,budgetSha256:sha(proposed),actual:'UNKNOWN',originalSeal:'ABSENT'});fence.confirmed();return {committed,disposition,seconds,budgetSha256:sha(proposed)};
  });
}
/** Copied controls cannot mutate the actual authority or issue runtime capabilities. */
export function allocateCopiedCollectorIncident(options,observe,fault){need(resolve(options.path)!==actual);return allocate(options,observe,fault);}
export function applyApprovedCollectorIncident004(){
  need(resolve('.')===project);const directory=join(program,'raw/build/incident-004-disposition'),records=[];
  const approvalPath=join(program,'REVIEW-061-native-collector-full-cap-disposition.md'),approvalBytes=readFileSync(approvalPath);
  mkdirSync(directory,{mode:0o700});const approval=exclusive(join(directory,'approval-original.md'),approvalBytes);
  need(sha(readPrivate(join(program,'raw/build/incident-004-native-app-evidence/incident.json')))==='b4a7891088b6b43cf6727044c6886b59277942284fb9365925a7c37ed4f80769');
  const owner={pid:93461,birth:'Sat Nov  7 15:25:14 2026',boot:'{ sec = 1793891543, usec = 870404 } Thu Nov  5 23:12:23 2026'};
  return allocate({path:actual,directory,bookSha:'b1d60a16c932ced4d3dfeb944f78c2c3f3f18f1c6ec14f97355132417c75db42',reservationId:'17e5cd07b0344a6f9469a1d298de51fb',owner,approval},()=>{
    need(!existsSync(actual+'.parent-time-pending.json')&&!existsSync(actual+'.preflight-attempt.json'));
    const started=process.hrtime.bigint(),command=(file,args)=>{need(Number(process.hrtime.bigint()-started)/1e9<15);const r=spawnSync(file,args,{encoding:'utf8',timeout:2000,maxBuffer:16384,env:{PATH:'/usr/local/bin:/usr/bin:/bin:/usr/sbin',LANG:'C',LC_ALL:'C'}}),record={file,args,pid:r.pid,exit:r.status,signal:r.signal,error:r.error?.code??null,stdout:r.stdout,stderr:r.stderr};records.push(record);need(!r.error&&r.signal===null);return record;};
    for(const pid of [93461,93470]){const r=command('/bin/ps',['-p',String(pid),'-o','pid=,lstart=']);need(r.exit===1&&r.stdout===''&&r.stderr==='');try{process.kill(pid,0);need(false);}catch(e){need(e.code==='ESRCH');}}
    const identity=['lw-pi-dbdd4e760ec4da7062b8ea63113a5bfd','6fc9436fd4b761c30a8642af70eab2c7701f0f60944f21d38b52c85e8f7636a3'];
    for(const id of identity){const r=command('/usr/local/bin/docker',['--config',join(project,'.claude/s04-qualification/delivery-preflight-006/docker-client'),'--host','unix:///Users/thxcode/.docker/run/docker.sock','inspect',id]);need(r.exit===1&&r.stdout.trim()==='[]'&&r.stderr.trim().slice(-id.length)===id&&/^error: no such (?:object|container): /i.test(r.stderr));}
    const r=command('/usr/sbin/lsof',['-nP','-iTCP:52696','-sTCP:LISTEN','-Fpn']);need(r.exit===1&&r.stdout===''&&r.stderr==='');
    return exclusive(join(directory,'original-resource-observations.json'),{version:1,scope:'exact original owner/container/listener absence; no cleanup',records});
  });
}
/** Exact second approved incident; identities come only from its frozen original evidence. */
function applyRecordedCollectorIncident(number,reportSha,bookSha,reservationId){
  need(resolve('.')===project);
  const reportPath=join(program,number==='005'?'raw/build/incident-005-repair-assertion/incident.json':number==='006'?'raw/build/incident-006-empty429/incident.json':number==='007'?'raw/build/incident-007-removal-observation-order/incident.json':'raw/build/incident-008-retry-unknown-usage/incident.json'),bytes=readPrivate(reportPath);need(sha(bytes)===reportSha);const report=JSON.parse(bytes);
  const directory=join(program,'raw/build/incident-'+number+'-disposition');mkdirSync(directory,{mode:0o700});
  const approval=exclusive(join(directory,'approval-original.md'),readFileSync(join(program,'REVIEW-062-repair-assertion-disposition-and-accounting.md'))),records=[];
  return allocate({path:actual,directory,bookSha,reservationId,owner:report.reservation.owner,approval},()=>{
    need(!existsSync(actual+'.parent-time-pending.json')&&!existsSync(actual+'.preflight-attempt.json'));
    const started=process.hrtime.bigint(),command=(file,args)=>{need(Number(process.hrtime.bigint()-started)/1e9<20);const r=spawnSync(file,args,{encoding:'utf8',timeout:2000,maxBuffer:16384,env:{PATH:'/usr/local/bin:/usr/bin:/bin:/usr/sbin',LANG:'C',LC_ALL:'C'}}),record={file,args,pid:r.pid,exit:r.status,signal:r.signal,error:r.error?.code??null,stdout:r.stdout,stderr:r.stderr};records.push(record);need(!r.error&&r.signal===null);return record;};
    const bootstrap=JSON.parse(checkedRef(report.bootstrap));
    for(const pid of [report.reservation.owner.pid,bootstrap.hello.owner.pid]){const r=command('/bin/ps',['-p',String(pid),'-o','pid=,lstart=']);need(r.exit===1&&r.stdout===''&&r.stderr==='');try{process.kill(pid,0);need(false);}catch(error){need(error.code==='ESRCH');}}
    for(const row of report.processes.filter(row=>row.kind==='create')){
      const original=JSON.parse(checkedRef(row.ref));need(original.exit.code===0&&original.exit.signal===null&&original.unknown===null);
      const id=Buffer.concat(original.stdoutChunks.map(ref=>checkedRef(ref))).toString().trim();need(/^[a-f0-9]{64}$/.test(id));
      for(const identity of [original.entry.identity.name,id]){const r=command('/usr/local/bin/docker',['--config',join(project,'.claude/s04-qualification/delivery-preflight-006/docker-client'),'--host','unix:///Users/thxcode/.docker/run/docker.sock','inspect',identity]);need(r.exit===1&&r.stdout.trim()==='[]'&&r.stderr.trim().slice(-identity.length)===identity&&/^error: no such (?:object|container): /i.test(r.stderr));}
    }
    for(const item of report.cases){const service=JSON.parse(checkedRef(item.service)),listening=JSON.parse(checkedRef(service.listening));need(service.ownListenerClosed===true&&service.pending===0&&service.unknown===false);const r=command('/usr/sbin/lsof',['-nP','-iTCP:'+listening.address.port,'-sTCP:LISTEN','-Fpn']);need(r.exit===1&&r.stdout===''&&r.stderr==='');}
    return exclusive(join(directory,'original-resource-observations.json'),{version:1,scope:'exact original incident'+number+' owner/container/listener absence; no cleanup',records});
  });
}
export function applyApprovedCollectorIncident005(){return applyRecordedCollectorIncident('005','b8e2c279c7b5ca515f64e2e6ac25f5d2f7370ba554b494412c814b43a8f45ee2','fbb1f8436f5846f02931147724adebad6a02648e057b792d137ba6a3950296a7','0e5aa18ad8477edb91a3019161799216');}
export function applyApprovedCollectorIncident006(){return applyRecordedCollectorIncident('006','453a54cce3a93a00f355f3ca44a5ae8f0b7b9232696542be2030098814ce7f44','305f96cd3aa1000b8372b9282c81f38f9bd0ccc00edf57b9756ba613e737600b','787e69473d87c77bdf3de485c86ab839');}
export function applyApprovedCollectorIncident007(){return applyRecordedCollectorIncident('007','8df0162bd2f6c3f7dbcb107951e6444e0e4f929dcd975ae3b3b30303831d7025','9f85d8165fd224ba7e15cccbcc9db992763ebeb3930183283cc332d444eba469','58c2e593fa5bc2be2be3b3cb6baf7a4a');}
export function applyApprovedCollectorIncident008(){return applyRecordedCollectorIncident('008','15e69c58c6e0744071e72026b40717a3d1f88ddcf66fb226a12bc41ec40a464f','ad7a01585d5d2bac1d87249c873d04278433584c7ad4174568f22b4d6bdb53f0','9f711a4ef7e4d46bd9a57c4a0bf0d339');}
if(process.argv[1]===fileURLToPath(import.meta.url)){need(process.argv.length===3&&['--apply-approved-incident-004','--apply-approved-incident-005','--apply-approved-incident-006','--apply-approved-incident-007','--apply-approved-incident-008'].includes(process.argv[2]));const apply=process.argv[2].endsWith('008')?applyApprovedCollectorIncident008:process.argv[2].endsWith('007')?applyApprovedCollectorIncident007:process.argv[2].endsWith('006')?applyApprovedCollectorIncident006:process.argv[2].endsWith('005')?applyApprovedCollectorIncident005:applyApprovedCollectorIncident004;process.stdout.write(canonical(apply())+'\n');}
