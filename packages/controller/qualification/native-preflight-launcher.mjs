/// <reference lib="es2023" />
/* global process, Buffer, setTimeout, clearTimeout */
// The bootstrap imports BUILTINS ONLY. Its future main delta is separately reviewed inert bytes.
import { constants,openSync,closeSync,writeSync,readSync,readFileSync,lstatSync,fstatSync,fsyncSync,unlinkSync,renameSync,realpathSync,mkdirSync,readdirSync,readlinkSync } from 'node:fs';
import { randomBytes,createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { resolve,dirname,join } from 'node:path';
import { pathToFileURL } from 'node:url';

const project='/Users/thxcode/orca/workspaces/loopwright/loopwright-s04-controller';
const actualBudget=join(project,'.claude/s04-qualification/budget.json');
const main=join(project,'packages/controller/qualification/native-preflight-launcher.mjs');
const nodeEntry='/opt/homebrew/bin/node';
const program='/Users/thxcode/Documents/github.com/thxcode/loopwright/.claude/reports/loopwright-harness-architecture/spec-S04';
/** @typedef {{path:string,byteLength:number,sha256:string}} Ref */
/** @typedef {{path:string,lock:string,fd:number|null,started:string,state:string,held:import('node:fs').BigIntStats,nonce:string,bytes:Buffer|null,attempt:Ref|null}} Bootstrap */
/** @type {WeakMap<object,Bootstrap>} */
const bootstraps=new WeakMap();
/** @type {object|null} */
let activeBootstrap=null;
let fixedContext=null;
const canonical=value=>value===null||typeof value!=='object'?JSON.stringify(value):Array.isArray(value)?'['+value.map(canonical).join(',')+']':'{'+Object.keys(value).sort().map(key=>JSON.stringify(key)+':'+canonical(value[key])).join(',')+'}';
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const now=()=>process.hrtime.bigint()/1000000n;
const identity=value=>[value.dev,value.ino,value.uid,value.gid,value.mode,value.nlink,value.size,value.mtimeNs,value.ctimeNs].map(String).join(':');
/** @param {unknown} value @param {string} code @returns {asserts value} */
function need(value,code){if(!value)throw new Error('QUALIFICATION_LAUNCHER_'+code);}
function currentUid(){need(typeof process.getuid==='function','OWNER_UID');return process.getuid();}
function syncDirectory(path){const fd=openSync(dirname(path),constants.O_RDONLY|constants.O_NOFOLLOW);try{fsyncSync(fd);}finally{closeSync(fd);}}
function writeAll(fd,bytes){let offset=0;while(offset<bytes.length){const count=writeSync(fd,bytes,offset,bytes.length-offset);need(count>0,'WRITE_UNKNOWN');offset+=count;}fsyncSync(fd);}
function exclusive(path,value){const bytes=Buffer.from(canonical(value)+'\n'),fd=openSync(path,constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW|constants.O_WRONLY,0o600);try{writeAll(fd,bytes);}finally{closeSync(fd);}syncDirectory(path);return {path,byteLength:bytes.length,sha256:sha(bytes)};}
function readOriginalFile(path,maximum=1048576,privateFile=true){
  const before=lstatSync(path,{bigint:true});need(before.isFile()&&!before.isSymbolicLink()&&before.nlink===1n&&before.size<=BigInt(maximum)&&(!privateFile||before.uid===BigInt(currentUid())&&(before.mode&0o077n)===0n),'ORIGINAL_FILE');
  const fd=openSync(path,constants.O_RDONLY|constants.O_NOFOLLOW);try{need(identity(fstatSync(fd,{bigint:true}))===identity(before),'ORIGINAL_CHANGED');const bytes=readFileSync(fd);need(bytes.length<=maximum&&identity(fstatSync(fd,{bigint:true}))===identity(before)&&identity(lstatSync(path,{bigint:true}))===identity(before),'ORIGINAL_CHANGED');return bytes;}finally{closeSync(fd);}
}
function readOriginalRef(ref){need(ref&&typeof ref.path==='string'&&ref.byteLength<=1048576,'ORIGINAL_REF');const bytes=readOriginalFile(ref.path);need(bytes.length===ref.byteLength&&sha(bytes)===ref.sha256,'ORIGINAL_REF');return bytes;}
function originalOwner(pid=process.pid){
  need(Number.isSafeInteger(pid)&&pid>0,'OWNER');const options={timeout:1000,maxBuffer:4096,env:{PATH:'/usr/bin:/bin:/usr/sbin',LANG:'C'}};
  const birth=execFileSync('/bin/ps',['-p',String(pid),'-o','lstart='],{...options,encoding:'utf8'}).trim(),boot=execFileSync('/usr/sbin/sysctl',['-n','kern.boottime'],{...options,encoding:'utf8'}).trim();need(birth&&boot,'OWNER');return {pid,birth,boot};
}
/** Builtin-only original executable reader, shared by the bootstrap and dormant inspector. */
export function executableFacts(path){
  const check=(value,code)=>{if(!value)throw new Error('QUALIFICATION_PREFLIGHT_'+code);};
  const original=lstatSync(path,{bigint:true}),canonicalPath=realpathSync(path),before=lstatSync(canonicalPath,{bigint:true});
  check(before.isFile()&&(Number(before.mode)&0o111)!==0&&before.size<=134217728n,'EXECUTABLE');
  const fd=openSync(canonicalPath,constants.O_RDONLY|constants.O_NOFOLLOW),hash=createHash('sha256'),buffer=Buffer.alloc(65536);let length=0;
  try{check(identity(fstatSync(fd,{bigint:true}))===identity(before),'EXECUTABLE_CHANGED');for(;;){const size=readSync(fd,buffer,0,buffer.length,null);if(!size)break;length+=size;check(length<=Number(before.size),'EXECUTABLE_CHANGED');hash.update(buffer.subarray(0,size));}check(length===Number(before.size)&&identity(fstatSync(fd,{bigint:true}))===identity(before)&&identity(lstatSync(path,{bigint:true}))===identity(original)&&realpathSync(path)===canonicalPath&&identity(lstatSync(canonicalPath,{bigint:true}))===identity(before),'EXECUTABLE_CHANGED');}
  finally{closeSync(fd);}
  return {path,canonicalPath,literalLink:original.isSymbolicLink()?readlinkSync(path):null,originalIdentity:identity(original),targetIdentity:identity(before),mode:Number(before.mode)&0o777,byteLength:length,sha256:hash.digest('hex')};
}
function freezeData(value,depth=0){need(depth<=32,'PROFILE_DEPTH');if(value&&typeof value==='object'){for(const child of Object.values(value))freezeData(child,depth+1);Object.freeze(value);}return value;}
/** Presence is significant: an invalid direct field can never fall back to a label. Data only. */
export function bindOriginalIdentity(budget,row,ordinal,originalIntent,intent){
  const valid=value=>typeof value==='string'&&/^[a-f0-9]{32}$/.test(value),direct=Object.hasOwn(row,'nonce'),hasLabels=Object.hasOwn(row,'labels');
  need(!hasLabels||row.labels!==null&&typeof row.labels==='object'&&!Array.isArray(row.labels),'IDENTITY_LABELS');
  const labelled=hasLabels&&Object.hasOwn(row.labels,'org.loopwright.nonce');
  need(!direct||valid(row.nonce),'IDENTITY_NONCE');need(!labelled||valid(row.labels['org.loopwright.nonce']),'IDENTITY_NONCE');need(direct||labelled,'IDENTITY_NONCE');
  need(!(direct&&labelled)||row.nonce===row.labels['org.loopwright.nonce'],'IDENTITY_CONFLICT');
  const nonce=direct?row.nonce:row.labels['org.loopwright.nonce'];
  need(Number.isSafeInteger(ordinal)&&ordinal>=0&&ordinal<33&&budget.byteLength>0&&/^[a-f0-9]{64}$/.test(budget.sha256),'IDENTITY_ORIGIN');
  need(typeof row.name==='string'&&/^lw-pi-(?:(?:tool|mcp)-)?[a-f0-9]{32}$/.test(row.name)&&row.name.endsWith(nonce)&&row.image==='sha256:2fdbe75954264927676a9a44d0e9c1fcbad9a687a1ae167416b595a06d548543','IDENTITY_NAME_IMAGE');
  need(intent&&valid(intent.nonce)&&intent.labels&&valid(intent.labels['org.loopwright.nonce'])&&intent.nonce===intent.labels['org.loopwright.nonce']&&intent.nonce===nonce&&intent.name===row.name&&intent.image===row.image,'IDENTITY_INTENT');
  need(!hasLabels||canonical(row.labels)===canonical(intent.labels),'IDENTITY_LABELS');
  need(originalIntent.path===join(row.directory,'container-intent.json')&&originalIntent.byteLength>0&&/^[a-f0-9]{64}$/.test(originalIntent.sha256),'IDENTITY_ORIGIN');
  return {budget,ordinal,pointer:'/containers/'+ordinal,rawRow:row,rawLabels:hasLabels?row.labels:null,nonceSource:direct?'row.nonce':'row.labels[org.loopwright.nonce]',nonce,name:row.name,image:row.image,labels:intent.labels,originalIntent,originalIntentBody:intent};
}

/** Minimal common exclusion BEFORE file-module/source/owner/inventory preparation. No native issuer. */
function openBootstrap(path,kind='preflight'){
  try{lstatSync(path+'.incident-pending.json');throw new Error('QUALIFICATION_INCIDENT_PENDING');}catch(error){if(error.code!=='ENOENT')throw error;}
  for(const marker of ['.preflight-attempt.json','.s03-attempt.json']){try{lstatSync(path+marker);throw new Error('QUALIFICATION_ATTEMPT_PENDING');}catch(error){if(error.code!=='ENOENT')throw error;}}
  const started=now(),lock=path+'.lock',fd=openSync(lock,constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW|constants.O_WRONLY,0o600),handle=Object.freeze({});
  /** @type {Bootstrap} */
  const value={path,lock,fd,started:String(started),state:'opening',held:fstatSync(fd,{bigint:true}),nonce:randomBytes(16).toString('hex'),bytes:null,attempt:null};bootstraps.set(handle,value);
  try{
    value.bytes=Buffer.from(canonical({version:1,kind:kind+'-bootstrap',pid:process.pid,nonce:value.nonce,startedMonotonicMs:value.started})+'\n');writeAll(fd,value.bytes);syncDirectory(lock);
    // An uncertain prior marker/attempt is never replaced, interpreted as a grant, or replayed.
    try{lstatSync(path+'.parent-time-pending.json');throw new Error('QUALIFICATION_PARENT_TIME_PENDING');}catch(error){if(error.code!=='ENOENT')throw error;}
    value.attempt=exclusive(path+'.'+kind+'-attempt.json',{version:1,id:value.nonce,pid:process.pid,startedMonotonicMs:value.started});value.state='open';return handle;
  }catch(error){value.state='unknown';closeSync(fd);value.fd=null;throw error;}
}
/** New original Node-only bootstrap for the approved delivery attempt; historical inputs stay immutable. */
export function beginApprovedDeliveryBootstrap(){
  need(resolve('.')===project&&resolve(process.argv[1]??'')===join(project,'packages/controller/qualification/delivery-preflight.mjs')&&process.argv.length===2,'CONTEXT');
  return openBootstrap(actualBudget);
}
/** Same original common lock/time path, fixed S03 owner route only; no environment grants. */
export function beginApprovedS03Bootstrap(){
  need(resolve('.')===project&&resolve(process.argv[1]??'')===join(project,'packages/controller/qualification/delivery-s03.mjs')&&process.argv.length===6&&process.argv[2]==='--case'&&process.argv[4]==='--owner'&&process.argv[5]==='controller','CONTEXT');
  need(['runtime-image','session','session-opus','physical-sends','context-guard','parser-context-failures','runtime-path','containment','mcp','recovery','dispositions','limits','cleanup','mutations','admission-mutations'].includes(process.argv[3]),'CONTEXT');
  return openBootstrap(actualBudget,'s03');
}
/** Consume only this original process's settled one-use attempt; UNKNOWN accounting keeps every blocker. */
export function finishDeliveryBootstrap(handle,accounting,directory){
  const value=bootstraps.get(handle);need(value&&value.path===actualBudget&&value.state==='transferred'&&value.attempt&&['delivery-preflight.mjs','delivery-s03.mjs'].some(name=>resolve(process.argv[1]??'')===join(project,'packages/controller/qualification',name)),'BOOTSTRAP_STATE');
  const ack=JSON.parse(readOriginalRef(accounting.ack)),receipt=JSON.parse(readOriginalRef(accounting.receipt));
  need(ack.id===receipt.commandId&&canonical(ack.transition.receipt)===canonical(accounting.receipt)&&canonical(ack.pending)===canonical(receipt.pending)&&receipt.startedMonotonicMs===value.started&&ack.owner.pid===process.pid,'SETTLED_IDENTITY');
  const lock=value.path+'.lock',fd=openSync(lock,constants.O_CREAT|constants.O_EXCL|constants.O_WRONLY|constants.O_NOFOLLOW,0o600);let complete=false;
  try{
    writeAll(fd,Buffer.from(canonical({version:1,kind:'consume-settled-original-attempt',pid:process.pid,nonce:value.nonce})+'\n'));syncDirectory(lock);
    try{lstatSync(value.path+'.parent-time-pending.json');throw new Error('QUALIFICATION_PARENT_TIME_PENDING');}catch(error){if(error.code!=='ENOENT')throw error;}
    need(sha(readOriginalFile(value.path))===ack.budgetSha256,'BUDGET_CHANGED');readOriginalRef(value.attempt);
    exclusive(join(directory,'attempt-consumed-'+value.nonce+'.json'),{version:1,attempt:value.attempt,receipt:accounting.receipt,ack:accounting.ack,scope:'original settled attempt consumed; source result remains separately PASS or FAIL'});
    renameSync(value.attempt.path,join(directory,'attempt-original-'+value.nonce+'.json'));syncDirectory(value.attempt.path);value.state='closed';complete=true;
  }finally{closeSync(fd);if(complete){unlinkSync(lock);syncDirectory(lock);}}
}
/** Synthetic COPY ONLY. No serialized data can construct an actual bootstrap. */
export function beginCopiedLauncherBootstrap(path){const selected=resolve(path);need(selected!==actualBudget,'ACTIVATION_HELD');const before=lstatSync(selected);need(realpathSync(dirname(selected))===dirname(selected)&&before.isFile()&&!before.isSymbolicLink()&&before.nlink===1,'COPIED_PATH');return openBootstrap(selected);}
export function launcherBootstrapState(handle){const value=bootstraps.get(handle);need(value,'BOOTSTRAP_HANDLE');return JSON.parse(canonical({path:value.path,startedMonotonicMs:value.started,state:value.state,attempt:value.attempt}));}
/** Same-process opaque transfer into the EXISTING common-lock/time machinery; never decoded. */
export function claimLauncherBootstrap(handle,path,owner,record){
  const value=bootstraps.get(handle);
  try{
    need(value&&value.state==='open'&&value.fd!==null&&value.bytes!==null&&value.path===path&&record.startedMonotonicMs===value.started&&owner.pid===process.pid,'BOOTSTRAP_IDENTITY');
    const descriptor=fstatSync(value.fd,{bigint:true});need(descriptor.dev===value.held.dev&&descriptor.ino===value.held.ino&&descriptor.nlink===1n&&descriptor.uid===BigInt(currentUid()),'BOOTSTRAP_LOCK');
    need(identity(lstatSync(value.lock,{bigint:true}))===identity(descriptor)&&readFileSync(value.lock).equals(value.bytes),'BOOTSTRAP_LOCK');
    value.state='claimed';return {fd:value.fd,lock:value.lock,nonce:value.nonce,attempt:value.attempt};
  }catch(error){if(value&&value.fd!==null){value.state='unknown';closeSync(value.fd);value.fd=null;}throw error;}
}
export function finishLauncherBootstrap(handle,confirmed){
  const value=bootstraps.get(handle);need(value&&value.state==='claimed'&&value.fd!==null&&value.bytes!==null,'BOOTSTRAP_STATE');
  try{
    if(confirmed){const descriptor=fstatSync(value.fd,{bigint:true});need(descriptor.dev===value.held.dev&&descriptor.ino===value.held.ino&&descriptor.nlink===1n&&identity(lstatSync(value.lock,{bigint:true}))===identity(descriptor)&&readFileSync(value.lock).equals(value.bytes),'BOOTSTRAP_LOCK');unlinkSync(value.lock);syncDirectory(value.lock);value.state='transferred';}
    else value.state='unknown';
  }finally{closeSync(value.fd);value.fd=null;}
}
function retainBootstrapUnknown(handle,error){
  const value=bootstraps.get(handle);need(value,'BOOTSTRAP_HANDLE');const ended=now(),directory=value.path===actualBudget?join(program,'raw/build/native-preflight-original'):dirname(value.path);
  const observation={version:1,startedMonotonicMs:value.started,observedMonotonicMs:String(ended),secondsObserved:Number(ended-BigInt(value.started))/1000,error:String(error),attempt:value.attempt,state:'unknown',bootstrapStateBefore:value.state,budgetTimeUpdate:'UNKNOWN here; original book/elapsed/ack remain authoritative; no replay or new grant',commonLockPath:value.lock,pendingPath:value.path+'.parent-time-pending.json',tail:'later accounting/cleanup time remains unknown, never zero'};
  let receipt=null,receiptError=null;
  try{receipt=exclusive(join(directory,'bootstrap-unknown-original.json'),observation);}catch(failure){receiptError=String(failure);}
  finally{value.state='unknown';if(value.fd!==null){closeSync(value.fd);value.fd=null;}}
  return {observation,receipt,receiptError};
}
/** Copied original unknown outcome only; cannot write the actual native book or choose another directory. */
export function retainCopiedLauncherUnknown(handle,error){const value=bootstraps.get(handle);need(value&&value.path!==actualBudget,'ACTIVATION_HELD');return retainBootstrapUnknown(handle,error);}

/** Pure data comparator. Original observations remain data and cannot mint native membership. */
export function validateLauncherBinding(original,expected){
  need(Object.keys(original).sort().join(',')===['cwd','main','argv','node','nodeAlias','parent','child','taskId','dispatchId','runId','head','sourceManifestSha256'].sort().join(','),'BINDING_KEYS');
  need(Object.keys(original).sort().join(',')===Object.keys(expected).sort().join(','),'BINDING_KEYS');
  for(const key of Object.keys(expected))need(canonical(original[key])===canonical(expected[key]),'BINDING_'+key.toUpperCase());
  need(original.cwd===project&&original.main===main&&original.argv[0]===original.node.path&&original.argv.length===4&&original.argv[1]==='--max-old-space-size=128'&&original.argv[2]==='--max-semi-space-size=8'&&original.argv[3]===main,'ROUTE');
  need(original.taskId==='task_79ce55c2b3a8'&&original.dispatchId==='ctx_39ed50870bb7'&&original.runId==='run_316587aa2c7f','DISPATCH');
  return {original,scope:'supplied original binding only; no activation'};
}
export function originalLauncherDeadline(started,availableSeconds,observed){
  need(Number.isFinite(availableSeconds)&&availableSeconds>0&&availableSeconds<=60,'ALLOWANCE');
  const deadline=BigInt(started)+BigInt(Math.floor(availableSeconds*1000));need(BigInt(observed)<deadline,'EXPIRED');
  return {startedMonotonicMs:String(started),deadlineMonotonicMs:String(deadline),observedMonotonicMs:String(observed),clock:'original Node process.hrtime only; Python root clock is never converted'};
}
/** Reuse the exact frozen expectation. No regenerated inventory or imported package execution. */
export async function verifyFrozenInventory(ref,deadline){
  need(ref.path===join(project,'.claude/s04-qualification/image-source-3aICiw/installed-inventory-BH007D/inventory-index.json')&&ref.byteLength===6104&&ref.sha256==='491037b40ccf5334ceb685cad8e05d91d2b7f83941bd6a395ef7ca2a020034ba','INVENTORY_TARGET');
  return verifyPrivateInventory(ref,deadline);
}
/** Shared original0600 reader for fresh, explicitly bound delivery inputs; data-only, no issuer. */
export async function verifyPrivateInventory(ref,deadline){
  const index=JSON.parse(readOriginalRef(ref).toString());need(index.version===1&&index.project===project&&Array.isArray(index.shards)&&index.shards.length<=128&&Array.isArray(index.sourceShards)&&index.sourceShards.length<=128,'INVENTORY');
  const entries=[],expected=new Map(),seen=new Set();let bytes=ref.byteLength,regularBytes=0,links=0;
  for(const shard of index.shards){
    need(shard.byteLength<=524289&&(bytes+=shard.byteLength)<=33554432&&now()<BigInt(deadline),'INVENTORY');
    const rows=JSON.parse(readOriginalRef(shard).toString());need(Array.isArray(rows)&&entries.length+rows.length<=65536,'INVENTORY');
    for(const row of rows){need(typeof row.path==='string'&&!row.path.startsWith('/')&&!row.path.split('/').some(part=>['','.','..'].includes(part))&&Buffer.byteLength(row.path)<=4096&&!expected.has(join(project,row.path)),'INVENTORY_PATH');entries.push(row);expected.set(join(project,row.path),row);if(row.kind==='file')regularBytes+=row.byteLength;if(row.kind==='symlink')links++;}
  }
  need(sha(Buffer.from(canonical(entries)))===index.entriesDigest&&entries.length===index.totals.entries&&regularBytes===index.totals.regularBytes&&regularBytes<=1073741824&&links===index.totals.links&&links<=4096,'INVENTORY');
  for(const shard of index.sourceShards){
    need(shard.byteLength<=524289&&(bytes+=shard.byteLength)<=33554432,'INVENTORY');const rows=JSON.parse(readOriginalRef(shard).toString());need(Array.isArray(rows),'INVENTORY');
    for(const row of rows){
      need(now()<BigInt(deadline),'EXPIRED');const entry=expected.get(row.path);need(entry&&!seen.has(row.path)&&row.identity===row.afterIdentity,'INVENTORY_IDENTITY');seen.add(row.path);
      const before=lstatSync(row.path,{bigint:true});need(identity(before)===row.identity&&Number(before.mode&0o777n)===entry.mode,'INVENTORY_CHANGED');
      if(entry.kind==='symlink')need(before.isSymbolicLink()&&readlinkSync(row.path)===entry.target,'INVENTORY_CHANGED');
      if(row.directoryEntries){const names=readdirSync(row.path).sort();need(before.isDirectory()&&names.length===row.directoryEntries.count&&sha(Buffer.from(canonical(names)))===row.directoryEntries.beforeSha256&&row.directoryEntries.beforeSha256===row.directoryEntries.afterSha256,'INVENTORY_CHANGED');}
      need(identity(lstatSync(row.path,{bigint:true}))===row.identity&&now()<BigInt(deadline),'INVENTORY_CHANGED');
    }
  }
  need(seen.size===entries.length,'INVENTORY');return {index:ref,sourceShards:index.sourceShards,entries:entries.length,totals:index.totals,scope:'exact frozen original index/shards and current source identities; builtin-only reuse, no regeneration or fresh source-byte/image equality claim'};
}

async function originalAck(deadline){
  return await new Promise((resolveAck,reject)=>{
    /** @type {Buffer[]} */ const buffers=[];let bytes=0,done=false;
    const finish=(error,value)=>{if(done)return;done=true;clearTimeout(timer);process.stdin.removeListener('data',onData);process.stdin.removeListener('end',onEnd);process.stdin.removeListener('error',onError);process.stdin.pause();if(error)reject(error);else resolveAck(value);};
    const onEnd=()=>finish(new Error('QUALIFICATION_LAUNCHER_ACK_MISSING'));
    const onError=error=>finish(error);
    const onData=chunk=>{bytes+=chunk.length;if(bytes>4096)return finish(new Error('QUALIFICATION_LAUNCHER_ACK_LIMIT'));buffers.push(chunk);const raw=Buffer.concat(buffers);if(raw.includes(10)){try{need(raw.at(-1)===10&&raw.indexOf(10)===raw.length-1,'ACK_FORMAT');need(now()<BigInt(deadline),'EXPIRED');finish(null,JSON.parse(raw.toString()));}catch(error){finish(error);}}};
    const timer=setTimeout(()=>finish(new Error('QUALIFICATION_LAUNCHER_ACK_TIMEOUT')),Math.max(0,Number(BigInt(deadline)-now())));process.stdin.on('data',onData);process.stdin.once('end',onEnd);process.stdin.once('error',onError);process.stdin.resume();
  });
}

/** Fixed future pre-issuer preparation. A forged record cannot create activeBootstrap. */
export async function prepareFixedLauncher(){
  need(activeBootstrap!==null&&typeof process.argv[1]==='string'&&resolve('.')===project&&resolve(process.argv[1])===main,'CONTEXT');
  const bootstrap=launcherBootstrapState(activeBootstrap);need(bootstrap.path===actualBudget&&bootstrap.state==='open','CONTEXT');
  const before=readOriginalFile(actualBudget);need(sha(before)==='60d7fa38c682d77f01ad722be2afcd861f07800d6909babeb551809538a3c1e6','BUDGET_CHANGED');
  // This exact frozen original book has allowance60. The existing ledger clips/checks it again before effects.
  const budget=JSON.parse(before.toString()),timing=originalLauncherDeadline(bootstrap.startedMonotonicMs,60,now());
  const directory=join(program,'raw/build/native-preflight-original');mkdirSync(directory,{mode:0o700});syncDirectory(directory);
  const child=originalOwner(),node=executableFacts(process.execPath),nodeAlias=executableFacts(nodeEntry);need(nodeAlias.canonicalPath===node.canonicalPath&&nodeAlias.targetIdentity===node.targetIdentity&&nodeAlias.sha256===node.sha256,'NODE_IDENTITY');originalLauncherDeadline(bootstrap.startedMonotonicMs,60,now());
  const ready=exclusive(join(directory,'launcher-ready.json'),{version:1,child,bootstrap,timing,node,nodeAlias});process.stdout.write(canonical({kind:'preflight-ready',ready})+'\n');
  const ack=await originalAck(timing.deadlineMonotonicMs);need(ack.kind==='original-supervisor-ack','ACK_KIND');
  const profile=JSON.parse(readOriginalFile(join(program,'raw/build/native-preflight-launch-profile.json')).toString()),intent=JSON.parse(readOriginalRef(profile.originalSupervisorIntent).toString()),originalIntent=JSON.parse(readOriginalRef(intent.originalIntent).toString());
  need(ack.commandId===intent.commandId&&originalIntent.commandId===intent.commandId&&canonical(ack.ready)===canonical(ready)&&canonical(originalOwner(process.ppid))===canonical(intent.owner)&&canonical(child)===canonical(intent.child)&&intent.owner.pid===originalIntent.parentPid,'SUPERVISOR_OWNER');
  need(canonical(originalIntent.argv)===canonical([nodeEntry,'--max-old-space-size=128','--max-semi-space-size=8',main])&&originalIntent.cwd===project&&originalIntent.taskId===profile.taskId&&originalIntent.dispatchId===profile.dispatchId&&originalIntent.runId===profile.runId,'ORIGINAL_INTENT');
  need(Object.keys(profile.source).length<=1024&&profile.helpers.length<=64&&profile.sourceManifestSha256===sha(Buffer.from(canonical(profile.source)))&&profile.originalBudgetSha256===sha(before),'SOURCE_MANIFEST');
  for(const [path,digest] of Object.entries(profile.source)){need(!path.startsWith('/')&&!path.split('/').includes('..'),'SOURCE_PATH');need(sha(readOriginalFile(join(project,path),16777216,false))===digest,'SOURCE_CHANGED');need(now()<BigInt(timing.deadlineMonotonicMs),'EXPIRED');}
  for(const ref of profile.helpers){need(ref.path.startsWith(program+'/raw/build/')&&ref.byteLength<=1048576,'HELPER_PATH');readOriginalRef(ref);need(now()<BigInt(timing.deadlineMonotonicMs),'EXPIRED');}
  need(budget.containers.length===33&&profile.ownedIdentities.length===33,'OWNED_IDENTITIES');
  for(let ordinal=0;ordinal<33;ordinal++){
    const row=budget.containers[ordinal],selected=profile.ownedIdentities[ordinal],original=JSON.parse(readOriginalRef(selected.originalIntent).toString()),bound=bindOriginalIdentity(selected.budget,row,ordinal,selected.originalIntent,original);
    need(selected.budget.sha256===sha(before)&&canonical(bound)===canonical(selected),'OWNED_IDENTITY');need(now()<BigInt(timing.deadlineMonotonicMs),'EXPIRED');
  }
  validateLauncherBinding({cwd:realpathSync('.'),main:realpathSync(process.argv[1]),argv:[process.execPath,...process.execArgv,...process.argv.slice(1)],node,nodeAlias,parent:intent.owner,child,taskId:profile.taskId,dispatchId:profile.dispatchId,runId:profile.runId,head:profile.head,sourceManifestSha256:profile.sourceManifestSha256},profile.binding);
  need(profile.head==='ea7a47fc66c5f9fe463f2f480255ba0b17905537'&&originalIntent.head===profile.head&&originalIntent.sourceManifestSha256===profile.sourceManifestSha256,'ORIGINAL_INTENT');
  need(canonical(node)===canonical(executableFacts(process.execPath))&&canonical(nodeAlias)===canonical(executableFacts(nodeEntry)),'NODE_IDENTITY');originalLauncherDeadline(bootstrap.startedMonotonicMs,60,now());
  const inventory=await verifyFrozenInventory(profile.expectedInventory,timing.deadlineMonotonicMs);exclusive(join(directory,'launcher-inventory-original.json'),inventory);
  // No file module has been imported before complete source/helper/payload-identity verification.
  fixedContext=freezeData({profile,directory,node,nodeAlias,parent:intent.owner,child,timing});return {ready,scope:'validated original launcher data only; no activation'};
}
export async function requireFixedLauncherContext(){
  need(activeBootstrap!==null&&fixedContext!==null&&typeof process.argv[1]==='string'&&resolve('.')===project&&resolve(process.argv[1])===main,'CONTEXT');
  need(canonical(originalOwner())===canonical(fixedContext.child)&&canonical(originalOwner(process.ppid))===canonical(fixedContext.parent),'OWNER');
  need(canonical(fixedContext.node)===canonical(executableFacts(process.execPath))&&canonical(fixedContext.nodeAlias)===canonical(executableFacts(nodeEntry)),'NODE_IDENTITY');need(now()<BigInt(fixedContext.timing.deadlineMonotonicMs),'EXPIRED');return fixedContext;
}
/** Future fixed lower only. Empty activation set denies BEFORE reading the inactive bootstrap/profile. */
export async function runFixedPreflight(activation){
  const {requireNativePreflightActivation}=await import('./native-activation.mjs');requireNativePreflightActivation(activation);
  const context=await requireFixedLauncherContext(),{NativeLedger}=await import('./native-ledger.mjs'),{runHeldPreparedImagePreflight}=await import('./native-image-inspector.mjs');
  const {profile,directory}=context,bootstrap=launcherBootstrapState(activeBootstrap),ledger=new NativeLedger(actualBudget);
  const time=ledger.beginHeldPreflightTime(activation,{phase:'initial',leaf:'image-preflight',directory},BigInt(bootstrap.startedMonotonicMs),activeBootstrap);
  let handedOff=false;
  try{
    const timing=ledger.preparePreflightTime(time);need(timing.original.sha256===profile.originalBudgetSha256,'BUDGET_CHANGED');originalLauncherDeadline(bootstrap.startedMonotonicMs,timing.availableSeconds,now());
    handedOff=true;return await runHeldPreparedImagePreflight(activation,ledger,time,{directory,expectedInventory:profile.expectedInventory,expectedBudgetSha256:profile.originalBudgetSha256,daemonAnchor:'new_current',ownedIdentities:profile.ownedIdentities});
  }catch(error){if(!handedOff)ledger.completeHeldPreflightTime(activation,time,{error:{message:error.message},intent:bootstrap.attempt,output:null,reads:[],endedMonotonicMs:String(now())});throw error;}
}

// The ONLY main entry is held. A later exact main/issuer/supervisor patch is an inert review artifact.
if(process.argv[1]&&pathToFileURL(resolve(process.argv[1])).href===import.meta.url){
  activeBootstrap=openBootstrap(actualBudget);
  // Deliberately no top-level await: file-module imports can reference this already evaluated module.
  const originalMain=async()=>{
    await prepareFixedLauncher();
    const {runApprovedImagePreflight}=await import('./native-activation.mjs');
    const result=await runApprovedImagePreflight();
    const receipt=exclusive(join(program,'raw/build/native-preflight-original/launcher-completed.json'),{version:1,owner:originalOwner(),result});
    process.stdout.write(canonical({kind:'preflight-completed',receipt})+'\n');
  };
  originalMain().catch(error=>{const unknown=retainBootstrapUnknown(activeBootstrap,error.message);process.stderr.write(canonical({kind:'preflight-unknown',error:error.message,unknown})+'\n');process.exitCode=1;});
}
