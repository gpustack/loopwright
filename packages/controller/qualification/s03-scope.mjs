/* global process, Buffer */
import {readFileSync,lstatSync,realpathSync,readlinkSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {execFileSync} from 'node:child_process';
import {canonical,sha,same,checkedRef,readPrivate,closed,localOwner,monotonic,fail} from './native-context.mjs';
export const s03Groups=Object.freeze({
  'runtime-image':['runtime-image.mjs',0,0,0],session:['session.mjs',3,2,0],'session-opus':['session.mjs',3,2,0],
  'physical-sends':['physical-sends.mjs',6,10,0],'context-guard':['context-probe.mjs',0,0,0],
  'parser-context-failures':['sdk-probe.mjs',2,24,32],'runtime-path':['contained-probe.mjs',4,24,8],
  containment:['tools.mjs',16,12,16],mcp:['mcp.mjs',42,32,128],recovery:['recovery-suite.mjs',36,40,128],
  dispositions:['dispositions.mjs',10,10,0],limits:['limits.mjs',52,46,128],cleanup:['watchdog-probe.mjs',3,0,0],
  mutations:['mutation-probe.mjs',3,0,8],'admission-mutations':['admission-mutations.mjs',0,8,0],
});
export const s03Project='/Users/thxcode/orca/workspaces/loopwright/loopwright-s04-controller';
export const s03Budget=join(s03Project,'.claude/s04-qualification/budget.json');
export const s03Identity=Object.freeze({runId:'run_316587aa2c7f',taskId:'task_79ce55c2b3a8',dispatchId:'ctx_39ed50870bb7'})
export const s03PriorIdentity=Object.freeze({runId:'run_316587aa2c7f',taskId:'task_79ce55c2b3a8',dispatchId:'ctx_dc37d0bdab56'});
export const s03ActiveIdentity=Object.freeze({runId:'run_316587aa2c7f',taskId:'task_79ce55c2b3a8',dispatchId:'ctx_242594ec6fb9'});
export const fixtureGroups=new Set(['physical-sends','containment','mcp','recovery','dispositions','limits','admission-mutations']);
const originalMetadata=execFileSync;
const need=(v)=>{if(!v)fail('QUALIFICATION_S03_SCOPE');};
export function s03Caps(group){const row=s03Groups[group];need(row);return {containers:row[1],provider:row[2],mcp:row[3]};}
const planCache=new Map(),beforeCache=new Map();
function refCacheKey(ref){const stat=lstatSync(ref.path);return [ref.path,ref.byteLength,ref.sha256,stat.dev,stat.ino,stat.size,stat.mtimeMs].join(':');}
export function readS03Plan(ref){
  const key=refCacheKey(ref);if(planCache.has(key))return planCache.get(key);
  const p=readS03PlanParsed(ref);
  if(planCache.size<512)planCache.set(key,p);
  return p;
}
function readS03PlanParsed(ref){
  const p=JSON.parse(checkedRef(ref));closed(p,['version','kind','group','project','owner','identity','git','phase','clock','caps','before','timeIntent','image','runtime','executable','socket','client','directory','ownership','cpuLedger','sources','entries','argv','precharge']);
  need(p.version===1&&p.kind==='s03-quota-v1'&&Object.hasOwn(s03Groups,p.group)&&p.phase==='finalPi'&&same(p.caps,s03Caps(p.group))&&(same(p.identity,s03Identity)||same(p.identity,s03PriorIdentity)||same(p.identity,s03ActiveIdentity)));
  need(typeof p.project==='string'&&p.project.startsWith('/')&&p.owner?.pid>0&&p.clock&&/^\d+$/.test(p.clock.workCutoff)&&/^\d+$/.test(p.clock.hardCutoff)&&BigInt(p.clock.hardCutoff)-BigInt(p.clock.workCutoff)===20000n);
  closed(p.git,['head','tree']);need(/^[a-f0-9]{40}$/.test(p.git.head)&&/^[a-f0-9]{40}$/.test(p.git.tree));
  need(p.executable==='/usr/local/bin/docker'&&p.socket==='/Users/thxcode/.docker/run/docker.sock'&&/^sha256:[a-f0-9]{64}$/.test(p.image));
  need(Array.isArray(p.sources)&&p.sources.length>0&&p.sources.length<=1024&&Array.isArray(p.entries)&&p.entries.length>0&&p.entries.length<=128&&p.entries.every(e=>e.startsWith(p.project+'/')));
  need(p.runtime===null||p.runtime?.socket?.path===p.socket&&p.runtime?.executable?.path===p.executable&&typeof p.runtime?.daemon?.id==='string');
  if(beforeCache.size<512)beforeCache.set(refCacheKey(p.before),JSON.parse(checkedRef(p.before)));checkedRef(p.timeIntent);return p;
}
const planDigestCache=new Map();
export function planDigest(ref){const key=refCacheKey(ref);if(planDigestCache.has(key))return planDigestCache.get(key);const digest=sha(canonical(readS03Plan(ref)));if(planDigestCache.size<512)planDigestCache.set(key,digest);return digest;}
export function validateS03Entry(entry){
  const scope=entry.s03;need(scope&&entry.context.suite==='s03');
  if(entry.state==='held'){
    closed(scope,['plan','events','occupants']);need(Array.isArray(scope.events)&&scope.events.length<=2048&&Array.isArray(scope.occupants)&&scope.occupants.length<=4);
    const keys=new Set(),counts={containers:0,provider:0,mcp:0};
    for(const row of scope.events){closed(row,['key','kind','units','identity','actor','monotonicMs']);need(typeof row.key==='string'&&row.key.length<=256&&!keys.has(row.key)&&(Object.hasOwn(counts,row.kind)||['node','process','cleanup-process','dispatch','physical','listener'].includes(row.kind))&&Number.isSafeInteger(row.units)&&row.units>=(Object.hasOwn(counts,row.kind)?1:0)&&row.units<=128);keys.add(row.key);if(Object.hasOwn(counts,row.kind))counts[row.kind]+=row.units;}
    for(const k of Object.keys(counts))need(counts[k]<=entry.caps[k]);
    for(const row of scope.occupants){closed(row,['name','key','id']);need(typeof row.name==='string'&&row.name.length<=128&&keys.has(row.key));}
  }else{closed(scope,['plan','audit']);const audit=JSON.parse(checkedRef(scope.audit));need(same(audit.plan,scope.plan)&&Array.isArray(audit.events)&&Array.isArray(audit.occupants)&&audit.occupants.length===0);}
  const plan=readS03Plan(scope.plan);need(same(plan.caps,entry.caps)&&same(plan.owner,entry.owner)&&entry.context.recipeDigest===sha(canonical(plan))&&entry.context.leafCutoff===plan.clock.workCutoff&&entry.context.sourceDigest===sha(canonical(plan.sources))&&same({runId:entry.context.runId,taskId:entry.context.taskId,dispatchId:entry.context.dispatchId},plan.identity));return plan;
}
const ancestorCache={value:null};
function ancestor(pid,root){
  if(pid===process.pid&&process.ppid>1&&ancestorCache.value&&ancestorCache.value.root===root&&ancestorCache.value.ppid===process.ppid){
    try{process.kill(root,0);return true;}catch{/* Root process gone: rerun the walk and do not cache. */}
  }
  let found=false;let current=pid;
  for(let depth=0;depth<12;depth++){
    if(current===root){found=true;break;}
    const parent=originalMetadata('/bin/ps',['-p',String(current),'-o','ppid='],{encoding:'utf8',timeout:1000,maxBuffer:128,env:{PATH:'/usr/bin:/bin',LANG:'C'}}).trim();need(/^\d+$/.test(parent));current=Number(parent);if(current<=1)break;
  }
  if(found&&pid===process.pid&&process.ppid>1)ancestorCache.value={root,ppid:process.ppid};
  return found;
}
const sourceCache=new Map();
export function s03ActorArgv(){
  const i=process.execArgv.indexOf('-e');
  return i<0?[resolve(process.argv[1]??''),...process.argv.slice(2)]:['node:daemon-fixture',process.execArgv[i+1],...process.argv.slice(1)];
}
export function verifyS03Actor(plan,{copied=false,cleanup=false,events=[],claimKey=null}={}){
  need(same(localOwner(plan.owner.pid),plan.owner)&&ancestor(process.pid,plan.owner.pid)&&monotonic()<BigInt(cleanup?plan.clock.hardCutoff:plan.clock.workCutoff));
  if(!copied)need(plan.project===s03Project&&resolve('.')===s03Project);
  const actualArgv=s03ActorArgv(),entry=actualArgv[0];
  if(process.pid!==plan.owner.pid&&!copied){
    const argv=sha(canonical(actualArgv)),peer=events.find(row=>row.kind==='node'&&(claimKey?row.key===claimKey:row.identity.child?.pid===process.pid));
    need(peer&&peer.identity.argv===argv&&peer.identity.entry===entry&&same(peer.actor,localOwner(process.ppid))&&(peer.identity.child===null||same(peer.identity.child,localOwner())));
    if(peer.identity.generated){need(peer.identity.cpuOnly&&peer.identity.generated.entry===entry&&peer.identity.generated.files.length===4);for(const row of peer.identity.generated.files)need(sha(readFileSync(row.path))===row.sha256);}
    need(plan.entries.includes(entry)||peer.identity.cpuOnly&&plan.group==='mutations'&&entry.endsWith('/check.mjs')||fixtureGroups.has(plan.group)&&entry==='node:daemon-fixture');
  }else need(entry===resolve(plan.project,'packages/controller/qualification/delivery-s03.mjs')||copied);
  // REVIEW-078: under native runs the same plan sources/socket/executable stat sweep is re-verified at most
  // once per 200ms (3 back-to-back child.stdin.write frames land within <1ms); copied runs sweep every call so
  // writeFileSync probes still fail immediately.
  const sweepKey=!copied?plan.directory+':'+plan.recipeDigest:null;
  const sweepFresh=sweepKey!==null&&nativeSweepCache.key===sweepKey&&monotonic()-nativeSweepCache.at<200n;
  if(!sweepFresh){
  for(const row of plan.sources){
    closed(row,['path','byteLength','sha256']);const info=lstatSync(row.path);need(info.isFile()&&!info.isSymbolicLink()&&info.size===row.byteLength&&realpathSync(row.path)===row.path);
    const identity=[info.dev,info.ino,info.size,info.mtimeMs,info.ctimeMs].join(':');if(sourceCache.get(row.path)!==identity){need(sha(readFileSync(row.path))===row.sha256);sourceCache.set(row.path,identity);}
  }
  if(!copied){
    need(plan.runtime);const s=lstatSync(plan.socket),r=plan.runtime.socket;need(s.isSocket()&&s.dev===r.dev&&s.ino===r.ino&&s.mode===r.mode);
    const identity=v=>[v.dev,v.ino,v.uid,v.gid,v.mode,v.nlink,v.size,v.mtimeNs,v.ctimeNs].map(String).join(':'),original=lstatSync(plan.executable,{bigint:true}),file=realpathSync(plan.executable),target=lstatSync(file,{bigint:true}),expected=plan.runtime.executable;
    need(identity(original)===expected.originalIdentity&&file===expected.canonicalPath&&identity(target)===expected.targetIdentity&&(original.isSymbolicLink()?readlinkSync(plan.executable):null)===expected.literalLink);
  }
    if(!copied){nativeSweepCache.key=sweepKey;nativeSweepCache.at=monotonic();}
  }
  const current=localOwner();need(monotonic()<BigInt(cleanup?plan.clock.hardCutoff:plan.clock.workCutoff));return current;
}
/** The same original time fence must still belong to this reservation's live supervisor. */
export const observeCache=new Map();
const nativeSweepCache={key:null,at:0n};
function observeStatKey(path,input){const bStat=lstatSync(path),pStat=lstatSync(input.plan.path);return [bStat.dev,bStat.ino,bStat.size,bStat.mtimeMs,bStat.ctimeMs,pStat.dev,pStat.ino,pStat.size,pStat.mtimeMs,pStat.ctimeMs,input.reservationId,input.plan.sha256].join(':');}
export function s03DebitScope(path,input,copied=false,cleanup=false){
  if(!copied)need(resolve(path)===s03Budget);else need(resolve(path)!==s03Budget);
  if(input.kind==='observe'&&!copied){const statKey=observeStatKey(path,input);if(observeCache.has(statKey))return observeCache.get(statKey);}
  const value=JSON.parse(readPrivate(path)),entry=value.qualificationReservations?.entries.find(e=>e.id===input.reservationId);need(entry?.state==='held'&&entry.context.suite==='s03'&&same(entry.s03.plan,input.plan));
  const plan=readS03Plan(input.plan);need(same(plan.owner,entry.owner)&&same(plan.caps,entry.caps)&&entry.context.recipeDigest===sha(canonical(plan)));
  const pending=JSON.parse(readPrivate(path+'.parent-time-pending.json'));need(same(pending.owner,plan.owner)&&same(pending.intent,plan.timeIntent));
  const beforeKey=refCacheKey(plan.before),original=beforeCache.has(beforeKey)?beforeCache.get(beforeKey):beforeCache.set(beforeKey,JSON.parse(checkedRef(plan.before))).get(beforeKey),prior={...value,qualificationReservations:{...value.qualificationReservations,revision:original.qualificationReservations.revision,entries:value.qualificationReservations.entries.filter(e=>e.id!==entry.id)}};
  need(same(prior,original));const actor=verifyS03Actor(plan,{copied,cleanup,events:entry.s03.events,claimKey:input.kind==='claim'?input.key:null});
  if(input.kind==='observe'&&!copied){const statKey=observeStatKey(path,input);if(observeCache.size<64)observeCache.set(statKey,{value,entry,plan,actor});}
  return {value,entry,plan,actor};
}
export function applyS03Debit(scope,input){
  closed(input,['reservationId','plan','kind','key','units','identity']);need(['containers','provider','mcp','bind','absent','node','process','cleanup-process','claim','process-bind','node-close','dispatch','physical','listener','listener-close'].includes(input.kind)&&typeof input.key==='string'&&input.key.length<=256&&Number.isSafeInteger(input.units)&&input.units>=0&&Buffer.byteLength(canonical(input.identity))<=4096);
  const {entry,actor}=scope,events=entry.s03.events,occupants=entry.s03.occupants;
  if(['node','process','cleanup-process'].includes(input.kind)){
    const id=input.identity;closed(id,['entry','argv','cpuOnly','generated','child','closed','result']);need(input.units===0&&id.child===null&&id.closed===false&&id.result===null&&(['process','cleanup-process'].includes(input.kind)||scope.plan.entries.includes(id.entry)||fixtureGroups.has(scope.plan.group)&&id.entry==='node:daemon-fixture'||id.cpuOnly&&scope.plan.group==='mutations'&&id.entry.endsWith('/check.mjs'))&&/^[a-f0-9]{64}$/.test(id.argv)&&events.filter(e=>e.kind==='node').length<128&&!events.some(e=>e.key===input.key));
    events.push({key:input.key,kind:input.kind,units:0,identity:id,actor,monotonicMs:String(monotonic())});return {existing:false};
  }
  if(input.kind==='claim'){
    const row=events.find(e=>e.key===input.key&&e.kind==='node');need(row&&same(row.actor,localOwner(process.ppid))&&(!row.identity.child||same(row.identity.child,actor)));row.identity.child=actor;return {existing:false};
  }
  if(input.kind==='process-bind'){
    const row=events.find(e=>e.key===input.key&&['node','process','cleanup-process'].includes(e.kind));need(input.units===0&&row&&same(row.actor,actor)&&!row.identity.closed&&(!row.identity.child||same(row.identity.child,input.identity)));closed(input.identity,['pid','birth','boot']);need(same(localOwner(input.identity.pid),input.identity));row.identity.child=input.identity;return {existing:false};
  }
  if(input.kind==='node-close'){
    const row=events.find(e=>e.key===input.key&&['node','process','cleanup-process'].includes(e.kind));need(row&&same(row.actor,actor)&&!row.identity.closed&&Number.isSafeInteger(input.identity.pid)&&input.identity.pid>0&&(input.identity.signal===null||typeof input.identity.signal==='string')&&(input.identity.exit===null||Number.isSafeInteger(input.identity.exit)));
    if(row.identity.child)need(row.identity.child.pid===input.identity.pid);row.identity.closed=true;row.identity.result=input.identity;return {existing:false};
  }
  if(input.kind==='bind'){
    const p=input.identity;closed(p,['name','id','image','labels']);const row=occupants.find(o=>o.name===p.name),event=events.find(e=>e.key===row?.key);
    need(input.units===0&&row&&/^[a-f0-9]{64}$/.test(p.id)&&p.image===scope.plan.image&&same(p.labels,event.identity.labels)&&(!row.id||row.id===p.id));row.id=p.id;event.identity.id=p.id;return {existing:false};
  }
  if(input.kind==='absent'){
    need(input.units===0&&input.identity&&typeof input.identity.name==='string');
    const proof=input.identity;closed(proof,['name','id','exit','stdout','stderr']);need(/^[a-f0-9]{64}$/.test(proof.id)&&proof.exit===1&&['','[]'].includes(proof.stdout.trim()));const match=/^error: no such (?:object|container): (.+)$/i.exec(proof.stderr.trim());need(match&&match[1]===proof.id);
    const index=occupants.findIndex(r=>r.name===proof.name);need(index>=0&&occupants[index].id===proof.id);occupants.splice(index,1);return {existing:false,remaining:occupants.length};
  }
  if(input.kind==='listener'){
    closed(input.identity,['address','port','closed']);need(input.units===0&&input.identity.closed===false&&['127.0.0.1','0.0.0.0','::1'].includes(input.identity.address)&&Number.isSafeInteger(input.identity.port)&&input.identity.port>0&&input.identity.port<=65535&&!events.some(e=>e.key===input.key)&&events.filter(e=>e.kind==='listener').length<128);
    events.push({key:input.key,kind:'listener',units:0,identity:input.identity,actor,monotonicMs:String(monotonic())});return {existing:false};
  }
  if(input.kind==='listener-close'){
    const row=events.find(e=>e.key===input.key&&e.kind==='listener');need(input.units===0&&row&&same(row.actor,actor)&&!row.identity.closed);row.identity.closed=true;return {existing:false};
  }
  if(['dispatch','physical'].includes(input.kind)){
    need(input.units===0&&!events.some(e=>e.key===input.key)&&events.length<2048);
    if(input.kind==='physical'){
      need(['provider','mcp'].includes(input.identity.transport));
      const spent=events.filter(e=>e.kind===input.identity.transport).reduce((n,e)=>n+e.units,0),physical=events.filter(e=>e.kind==='physical'&&e.identity.transport===input.identity.transport).length;
      need(physical<spent);
    }
    events.push({key:input.key,kind:input.kind,units:0,identity:input.identity,actor,monotonicMs:String(monotonic())});return {existing:false};
  }
  const old=events.find(e=>e.key===input.key);if(old){need(input.kind!=='containers');need(same({kind:old.kind,units:old.units,identity:old.identity},{kind:input.kind,units:input.units,identity:input.identity}));return {existing:true};}
  need(input.units>0&&events.length<2048);const total=events.filter(e=>e.kind===input.kind).reduce((n,e)=>n+e.units,0);need(total+input.units<=entry.caps[input.kind]);
  if(input.kind==='containers'){need(input.units===1&&occupants.length<4&&input.identity?.image===scope.plan.image&&/^(?:lw-pi-(?:(?:tool|mcp|discovery)-)?[a-f0-9]{32}|lw-s03-[a-z0-9-]{1,96})$/.test(input.identity.name)&&!events.some(o=>o.kind==='containers'&&o.identity.name===input.identity.name));occupants.push({name:input.identity.name,key:input.key,id:null});}
  events.push({key:input.key,kind:input.kind,units:input.units,identity:input.identity,actor,monotonicMs:String(monotonic())});return {existing:false};
}
