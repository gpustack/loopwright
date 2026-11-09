/* global process, Buffer */
import { constants, readFileSync, readSync, fstatSync, lstatSync, openSync, closeSync, renameSync, unlinkSync, existsSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { canonical, sha, readPrivate, exclusive, syncParent, same } from './native-context.mjs';
import { withBudgetLock } from './native-lock.mjs';
import { localOwner } from './native-context.mjs';
import { validateUsage } from './schedule.mjs';
const project='/Users/thxcode/orca/workspaces/loopwright/loopwright-s04-controller';
const program='/Users/thxcode/Documents/github.com/thxcode/loopwright/.claude/reports/loopwright-harness-architecture/spec-S04';
const actual=join(project,'.claude/s04-qualification/budget.json');
const need=(value,code)=>{if(!value)throw new Error('QUALIFICATION_INCIDENT_'+code);};
function absent(pid){
  const result=spawnSync('/bin/ps',['-p',String(pid),'-o','pid=,ppid=,pgid=,lstart='],{encoding:'utf8',timeout:1000,maxBuffer:4096,env:{PATH:'/usr/bin:/bin',LANG:'C',LC_ALL:'C'}});
  need(result.status===1&&result.signal===null&&!result.error&&result.stdout===''&&result.stderr==='','OWNER_LIVE_OR_UNKNOWN');
  try{process.kill(pid,0);throw new Error('QUALIFICATION_INCIDENT_OWNER_LIVE_OR_UNKNOWN');}catch(error){need(error.code==='ESRCH','OWNER_LIVE_OR_UNKNOWN');}
}
function inspect(path,expected){const bytes=readPrivate(path);need(sha(bytes)===expected,'IDENTITY_CHANGED');const info=lstatSync(path);return{bytes,info};}
/** Exact administrative disposition, not stale-lock recovery or reconstruction of a native capability. */
function retire(options,fault=()=>{}){
  const started=process.hrtime.bigint(),path=options.path,lock=path+'.lock',attempt=path+'.preflight-attempt.json';
  need(!existsSync(path+'.incident-pending.json')&&!existsSync(path+'.incident-001.lock'),'ALREADY_ATTEMPTED');
  const original=inspect(path,options.bookSha),locked=inspect(lock,options.lockSha),attempted=inspect(attempt,options.attemptSha);
  const lockBody=JSON.parse(locked.bytes),attemptBody=JSON.parse(attempted.bytes),book=JSON.parse(original.bytes);
  need(same(lockBody,{version:1,kind:'preflight-bootstrap',pid:options.pid,nonce:options.nonce,startedMonotonicMs:options.startedMonotonicMs})&&same(attemptBody,{version:1,id:options.nonce,pid:options.pid,startedMonotonicMs:options.startedMonotonicMs}),'FENCE_CHANGED');
  need(!existsSync(path+'.parent-time-pending.json')&&!Object.hasOwn(book,'qualificationReservations')&&!book.native.qualificationAllocations,'PENDING_STATE');
  validateUsage(book.native);for(const pid of options.absentPids)absent(pid);
  // A permanent single-use incident record serializes administrative writers; old common lock excludes normal writers.
  const descriptor=openSync(path+'.incident-001.lock',constants.O_CREAT|constants.O_EXCL|constants.O_WRONLY|constants.O_NOFOLLOW,0o600);closeSync(descriptor);syncParent(path);
  exclusive(path+'.incident-pending.json',{version:1,incident:'incident-001',commandId:options.commandId,bookSha:options.bookSha});
  fault('after_pending');
  mkdirSync(options.directory,{mode:0o700});syncParent(options.directory);
  const originals={book:exclusive(join(options.directory,'book-original.bin'),original.bytes),lock:exclusive(join(options.directory,'lock-original.bin'),locked.bytes),attempt:exclusive(join(options.directory,'attempt-original.bin'),attempted.bytes)};
  const disposition=exclusive(join(options.directory,'disposition.json'),{version:1,incident:'incident-001',commandId:options.commandId,originals,approval:options.approval,observation:options.observation,
    previousOutcome:'FAIL',nativeDiagnosticSeconds:0.094,nativeTail:'UNKNOWN',rootSeconds:0.14607020901166834,historicalUnknownReads:13,allocations:[{seconds:60,purpose:'failed_n1'},{seconds:1,purpose:'incident_inspection'}],allocationMeaning:'local qualification allocation only; not measured elapsed, settlement or production S02 semantics'});
  const next=JSON.parse(original.bytes);next.native.qualificationAllocations=[['failed-n1',60,'failed_n1_tail_remains_unknown'],['incident-inspection',1,'inspection_allocation']].map(([id,allocationSeconds,reason])=>({id,phase:'initial',allocationSeconds,kind:'local_qualification_allocation',reason,receipt:disposition}));
  const measuredSeconds=Number(process.hrtime.bigint()-started)/1e9;
  next.native.seconds.initial+=measuredSeconds;next.native.leafSeconds['initial:incident-reconciliation']=(next.native.leafSeconds['initial:incident-reconciliation']??0)+measuredSeconds;validateUsage(next.native);
  const proposed=Buffer.from(canonical(next)+'\n'),temporary=path+'.incident-001.next';exclusive(temporary,proposed);
  exclusive(join(options.directory,'prepared.json'),{version:1,disposition,measuredReconciliation:{seconds:measuredSeconds,interval:'entry through prepared allocation; excludes commit acknowledgements'},proposedSha256:sha(proposed)});
  // Fresh owner and exact inode/byte checks immediately precede the only authoritative mutation.
  for(const pid of options.absentPids)absent(pid);
  for(const [selected,expected,prior] of [[path,options.bookSha,original],[lock,options.lockSha,locked],[attempt,options.attemptSha,attempted]]){const current=inspect(selected,expected);need(current.info.ino===prior.info.ino&&current.info.dev===prior.info.dev,'IDENTITY_CHANGED');}
  need(!existsSync(path+'.parent-time-pending.json'),'PENDING_STATE');fault('before_commit');
  renameSync(temporary,path);syncParent(path);fault('after_commit');need(readPrivate(path).equals(proposed),'COMMIT_UNKNOWN');
  // Originals and disposition exist before either stale active fence is released. Partial actions remain fenced.
  renameSync(attempt,join(options.directory,'attempt-archived.json'));syncParent(attempt);
  renameSync(lock,join(options.directory,'lock-archived.json'));syncParent(lock);fault('after_archive');
  const committed=exclusive(join(options.directory,'committed.json'),{version:1,disposition,budgetSha256:sha(readPrivate(path)),originalLabelConsumed:true,measurementComplete:false,actualOldTail:'UNKNOWN',reconciliationMeasuredSeconds:measuredSeconds});
  unlinkSync(path+'.incident-pending.json');syncParent(path);return{committed,disposition,budgetSha256:sha(proposed),allocationSeconds:61,measuredSeconds};
}
/** Copies only; tests cannot reach the actual authority, and there is no decoded grant. */
export function retireCopiedOrphan(options,fault){need(resolve(options.path)!==actual,'COPY_ONLY');return retire(options,fault);}
export function applyApprovedIncident001(){
  need(resolve('.')===project,'CONTEXT');
  const approvalPath=join(program,'REVIEW-056-native-incident-disposition-and-continuation.md'),observationPath=join(program,'raw/build/delivery-native-incident055/original-incident-observations.json');
  const approvalInfo=lstatSync(approvalPath);need(approvalInfo.isFile()&&approvalInfo.nlink===1&&approvalInfo.uid===process.getuid()&&approvalInfo.size<=65536,'APPROVAL');
  const approval=readFileSync(approvalPath),observation=readPrivate(observationPath);need(sha(observation)==='c1c31c4f8f29d5467dc08ecb53bcb70a99c7d0f246dec12ab9da7550b05ee826','OBSERVATION');
  return retire({path:actual,bookSha:'60d7fa38c682d77f01ad722be2afcd861f07800d6909babeb551809538a3c1e6',lockSha:'84c52d65fae4c5b0f91e673921ba048dcc3c89e2d1d6043208ea0dff43cb416e',attemptSha:'e80ca0f1487cfdc265059786b182aaa2f94a3db014aea219e229ac43c55e7ca7',pid:7797,nonce:'4d35f415467b82f0dd361b32dd8fb6f2',startedMonotonicMs:'134942565',absentPids:[7796,7797],commandId:'19091d3cbc564e02add47aa4467a23e6',directory:join(program,'raw/build/incident-001-disposition'),approval:{path:approvalPath,byteLength:approval.length,sha256:sha(approval)},observation:{path:observationPath,byteLength:observation.length,sha256:sha(observation)}});
}
function verifyOriginalClosedReads(reads,parent,directory){
  for(const [ordinal,ref]of reads.entries()){
    need(ref.path===join(directory,'cli-'+ordinal+'-exit.json'),'RECORD_CHANGED');const record=JSON.parse(readPrivate(ref.path));inspect(ref.path,ref.sha256);
    need(record.closedObserved===true&&record.error===null&&record.exit?.signal===null&&Number.isSafeInteger(record.exit.code)&&record.registration&&record.intent&&record.unretainedStdout===0&&record.unretainedStderr===0,'CLOSURE_UNKNOWN');
    const registered=JSON.parse(inspect(record.registration.path,record.registration.sha256).bytes),intent=JSON.parse(inspect(record.intent.path,record.intent.sha256).bytes);
    need(registered.pid===record.pid&&same(registered.owner,record.owner)&&same(registered.parent,parent)&&same(registered.intent,record.intent)&&same(intent.parent,parent),'CLOSURE_UNKNOWN');
    for(const stream of [record.stdout,record.stderr]){
      need(stream.path.startsWith(directory+'/cli-'+ordinal+'.'),'STREAM_IDENTITY');const before=lstatSync(stream.path),file=openSync(stream.path,constants.O_RDONLY|constants.O_NOFOLLOW),hash=createHash('sha256'),buffer=Buffer.alloc(65536);let length=0;
      try{const held=fstatSync(file);need(held.isFile()&&held.ino===before.ino&&held.dev===before.dev&&held.nlink===1&&held.uid===process.getuid()&&!(held.mode&0o077)&&held.size===stream.byteLength,'STREAM_IDENTITY');for(;;){const n=readSync(file,buffer,0,buffer.length,null);if(!n)break;hash.update(buffer.subarray(0,n));length+=n;need(length<=stream.byteLength,'STREAM_IDENTITY');}const after=fstatSync(file),current=lstatSync(stream.path);need(after.size===held.size&&after.mtimeMs===held.mtimeMs&&after.ctimeMs===held.ctimeMs&&current.ino===held.ino&&current.dev===held.dev&&length===stream.byteLength&&hash.digest('hex')===stream.sha256,'STREAM_IDENTITY');}finally{closeSync(file);}
    }
  }
}
/** REVIEW057 administrative close of the exact already-committed no-Docker failure; never an original ACK. */
function retireKnownRefusal(options,fault=()=>{}){
  const started=process.hrtime.bigint(),path=options.path,label=options.label??'incident-002',marker=path+'.'+label+'.lock';need(!existsSync(marker)&&!existsSync(path+'.lock'),'ALREADY_ATTEMPTED');
  const book=inspect(path,options.bookSha),pending=inspect(path+'.parent-time-pending.json',options.pendingSha),attempt=inspect(path+'.preflight-attempt.json',options.attemptSha);
  const held=JSON.parse(pending.bytes);need(held.id===options.id&&held.owner.pid===options.pid&&held.owner.birth===options.birth,'IDENTITY_CHANGED');
  const intent=inspect(held.intent.path,held.intent.sha256),receipt=inspect(options.receipt.path,options.receipt.sha256),committed=inspect(path+'.committed.'+options.id,options.commitSha);
  const original=JSON.parse(receipt.bytes),commit=JSON.parse(committed.bytes);
  need(original.commandId===options.id&&original.seconds===(options.seconds??0.321)&&commit.id===options.id&&commit.proposed.sha256===options.bookSha&&original.outcome.error.message===(options.message??'QUALIFICATION_PREFLIGHT_CLIENT')&&same(original.outcome.reads,options.reads??[]),'RECORD_CHANGED');
  if(options.reads)verifyOriginalClosedReads(original.outcome.reads,held.owner,options.sourceDirectory);
  absent(options.pid);
  const guard=exclusive(marker,{version:1,incident:label,owner:process.pid,originalCommand:options.id});
  const active=exclusive(path+'.lock',{version:1,kind:'administrative-'+label,guard});fault('after_lock');
  mkdirSync(options.directory,{mode:0o700});syncParent(options.directory);
  const originals={};for(const [name,item]of Object.entries({book,pending,attempt,intent,receipt,committed}))originals[name]=exclusive(join(options.directory,name+'-original.bin'),item.bytes);
  const disposition=exclusive(join(options.directory,'disposition.json'),{version:1,incident:label,approval:options.approval,originals,originalCommand:options.id,originalOutcome:'FAIL',timeAlreadyCharged:options.seconds??0.321,
    noDoubleDebit:true,reason:options.reads?'all original fixed read registrations/exits/streams verified closed; administrative disposition only, not reconstructed original ACK':'coordinator verified original CLIENT control flow before any fixed Docker/lsof command; administrative disposition only, not reconstructed original ACK',historicalUnknownsRetained:13});
  const next=JSON.parse(book.bytes),seconds=Number(process.hrtime.bigint()-started)/1e9;next.native.seconds.initial+=seconds;next.native.leafSeconds['initial:incident-reconciliation']+=seconds;validateUsage(next.native);
  const proposed=Buffer.from(canonical(next)+'\n'),temporary=path+'.'+label+'.next';exclusive(temporary,proposed);exclusive(join(options.directory,'prepared.json'),{version:1,disposition,measuredReconciliationSeconds:seconds,proposedSha256:sha(proposed)});
  absent(options.pid);for(const [selected,expected]of [[path,options.bookSha],[path+'.parent-time-pending.json',options.pendingSha],[path+'.preflight-attempt.json',options.attemptSha]])inspect(selected,expected);
  fault('before_commit');renameSync(temporary,path);syncParent(path);fault('after_commit');need(sha(readPrivate(path))===sha(proposed),'COMMIT_UNKNOWN');
  renameSync(path+'.preflight-attempt.json',join(options.directory,'attempt-archived.json'));syncParent(path);
  renameSync(path+'.parent-time-pending.json',join(options.directory,'pending-archived.json'));syncParent(path);fault('after_archive');
  const done=exclusive(join(options.directory,'committed.json'),{version:1,disposition,originalFailRetained:true,originalTimeRetained:true,newMeasuredReconciliationSeconds:seconds,budgetSha256:sha(proposed),originalACKReconstructed:false});
  inspect(path+'.lock',active.sha256);renameSync(path+'.lock',join(options.directory,'administrative-lock-archived.json'));syncParent(path);return{done,budgetSha256:sha(proposed),seconds};
}
export function retireCopiedKnownRefusal(options,fault){need(resolve(options.path)!==actual,'COPY_ONLY');return retireKnownRefusal(options,fault);}
export function applyApprovedIncident002(){
  need(resolve('.')===project,'CONTEXT');const approvalPath=join(program,'REVIEW-057-known-client-refusal-and-continuation.md'),approvalBytes=readFileSync(approvalPath);
  return retireKnownRefusal({path:actual,bookSha:'a1b1c2f861a351a64361a288e9a8bca2118ea6612b9f1a0888f8e941473327bf',pendingSha:'5073fd7e299737868fb610afbf896d1098b9ba40fd8fdb45fde869371730de61',attemptSha:'94f53d3a9f8e619cbf8c0c317cb16b3c3303d992d0d9d7389a124a4cbfbf3e71',id:'4008d1f5018a4abbf411d2f1e42a0828',pid:20826,birth:'Sat Nov  7 14:19:08 2026',commitSha:'870dde30d3433fa8f30042a612de59184ae4865923872005c455cec7ab10ae9b',
    receipt:{path:join(project,'.claude/s04-qualification/delivery-preflight-001/preflight-elapsed-4008d1f5018a4abbf411d2f1e42a0828.json'),sha256:'cbfce81b96b9db665aa124154c49e9f1b862fa171df206c63cdecaf01cb61137'},directory:join(program,'raw/build/incident-002-disposition'),approval:{path:approvalPath,sha256:sha(approvalBytes),byteLength:approvalBytes.length}});
}
export function applyApprovedIncident003(){
  need(resolve('.')===project,'CONTEXT');const sourceDirectory=join(project,'.claude/s04-qualification/delivery-preflight-002'),approvalPath=join(program,'REVIEW-058-completed-read-failure-and-oci-fix.md'),approvalBytes=readFileSync(approvalPath);
  const reads=[['95b3d4f13c4319953b8aa54441daf9b57defd28d3e3fb6948f623787e165f05a',1305],['94e2bfb96b95f47bc11d6ca9737c1aaf5a902d944fff0684a8833579bdcc16fa',1307],['78807cf0db37f208cdd4f46de65754914b0bc2eea18923ac4fa716a3ee7e2e89',1305]].map(([sha256,byteLength],index)=>({path:join(sourceDirectory,'cli-'+index+'-exit.json'),sha256,byteLength}));
  return retireKnownRefusal({label:'incident-003',path:actual,bookSha:'427babd9b0354b9cf544f0b429c8d515d2126b2322cd8a7573962cc0b0e453f3',pendingSha:'cb39f0605bc946f3b03ce21e89142d8e3e8d97b35d38f229bdb7856bb2bcdcce',attemptSha:'e052d81dd2cde984e970e3937210ba0c24d4079464d1772d693634211277358e',id:'1d29bb3df3c7d5e83d971ad30eee4e75',pid:27434,birth:'Sat Nov  7 14:24:27 2026',commitSha:'821db6f78ab27dc03fd14d0f8f02e9945b89645ae79b2fe3af292c3f502fa21b',seconds:2.038,message:'QUALIFICATION_IMAGE_OCI_INDEX',reads,sourceDirectory,
    receipt:{path:join(sourceDirectory,'preflight-elapsed-1d29bb3df3c7d5e83d971ad30eee4e75.json'),sha256:'ceafd5136fe9998345039fe08467c3b045903d08bb3f1dd9a3129715402629bd'},directory:join(program,'raw/build/incident-003-disposition'),approval:{path:approvalPath,sha256:sha(approvalBytes),byteLength:approvalBytes.length}});
}
export function consumeSettledDelivery003(){
  need(resolve('.')===project,'CONTEXT');const started=process.hrtime.bigint(),id='9182839c0ec810c55434fd0ebc9e4f16',directory=join(program,'raw/build/settled-delivery003-attempt'),source=join(project,'.claude/s04-qualification/delivery-preflight-003');
  const receiptRef={path:join(source,'preflight-elapsed-'+id+'.json'),sha256:'fbdf26933d6fd1673cc95e463e9052c99b72a0edf169997ab04815a478816b83'},ackPath=actual+'.parent-time-ack-'+id+'.json';
  return withBudgetLock(actual,localOwner(),fence=>{
    const book=inspect(actual,'5d77c4c833750298bcfc1fdb3db6350439a455426382a54e09be843ecba78aa5'),receipt=inspect(receiptRef.path,receiptRef.sha256),ack=inspect(ackPath,'9b76593a6c26d4027e6d4ebad1bb8e5ad779eb3f36d918ea72a2f3db7651f5c3');
    const saved=JSON.parse(receipt.bytes),closed=JSON.parse(ack.bytes),intent=inspect(saved.pending.path,saved.pending.sha256),owner=JSON.parse(intent.bytes).owner,attempt=readPrivate(actual+'.preflight-attempt.json'),value=JSON.parse(attempt);
    need(closed.id===id&&closed.budgetSha256===sha(book.bytes)&&saved.commandId===id&&saved.seconds===27.531&&saved.originalLifecycle.knownCompletedReadFailure===true&&same(saved.originalLifecycle.closedCommands,saved.outcome.reads)&&same(closed.transition.receipt,{...receiptRef,byteLength:receipt.bytes.length})&&value.pid===owner.pid&&value.startedMonotonicMs===saved.startedMonotonicMs&&!existsSync(actual+'.parent-time-pending.json'),'RECORD_CHANGED');
    absent(owner.pid);verifyOriginalClosedReads(saved.outcome.reads,owner,source);fence.uncertain();mkdirSync(directory,{mode:0o700});syncParent(directory);
    const originals={book:exclusive(join(directory,'book-original.bin'),book.bytes),receipt:exclusive(join(directory,'receipt-original.bin'),receipt.bytes),ack:exclusive(join(directory,'ack-original.bin'),ack.bytes),attempt:exclusive(join(directory,'attempt-original.bin'),attempt)};
    const disposition=exclusive(join(directory,'disposition.json'),{version:1,scope:'consume exact already-settled failed attempt under REVIEW058 standing authority',id,originals,originalFAIL:'QUALIFICATION_IMAGE_PAYLOAD_IDENTITY',originalSecondsRetained:27.531,originalACKReconstructed:false});
    const next=JSON.parse(book.bytes),seconds=Number(process.hrtime.bigint()-started)/1e9;next.native.seconds.initial+=seconds;next.native.leafSeconds['initial:incident-reconciliation']+=seconds;validateUsage(next.native);const proposed=Buffer.from(canonical(next)+'\n'),temporary=actual+'.settled-delivery003.next';exclusive(temporary,proposed);inspect(actual,sha(book.bytes));renameSync(temporary,actual);syncParent(actual);need(sha(readPrivate(actual))===sha(proposed),'COMMIT_UNKNOWN');
    need(readPrivate(actual+'.preflight-attempt.json').equals(attempt),'ATTEMPT_CHANGED');renameSync(actual+'.preflight-attempt.json',join(directory,'attempt-archived.json'));syncParent(actual);
    const done=exclusive(join(directory,'committed.json'),{version:1,disposition,newMeasuredReconciliationSeconds:seconds,budgetSha256:sha(proposed),originalFailureAndTimeRetained:true});fence.confirmed();return{done,budgetSha256:sha(proposed),seconds};
  });
}
if(process.argv[1]===fileURLToPath(import.meta.url)){need(process.argv.length===3&&['--apply-approved-incident-001','--apply-approved-incident-002','--apply-approved-incident-003','--consume-settled-delivery-003'].includes(process.argv[2]),'ARGUMENT');const selected=process.argv[2]==='--apply-approved-incident-001'?applyApprovedIncident001:process.argv[2]==='--apply-approved-incident-002'?applyApprovedIncident002:process.argv[2]==='--apply-approved-incident-003'?applyApprovedIncident003:consumeSettledDelivery003;process.stdout.write(canonical(selected())+'\n');}
