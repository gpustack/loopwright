/// <reference lib="es2023" />
/* global Buffer, process, setTimeout, clearTimeout */
import { constants,openSync,writeSync,fsyncSync,closeSync,lstatSync,realpathSync,readdirSync } from 'node:fs';
import { join,resolve } from 'node:path';
import { spawn,execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { requireNativePreflightActivation } from './native-activation.mjs';
import { NativeLedger } from './native-ledger.mjs';
import { markParentTimeUnavailable,parentTimeState } from './native-lock.mjs';
import { same,exclusive,checkedRef,privateDirectory,localOwner,monotonic,closed,fail } from './native-context.mjs';
import { imageLimits,uniqueImageJSON,readExpectedInventory,inspectImageArchive,compareImagePayload } from './native-image.mjs';
import { bindOriginalIdentity,executableFacts } from './native-preflight-launcher.mjs';
export { executableFacts };

export const preflightRoute=Object.freeze({project:'/Users/thxcode/orca/workspaces/loopwright/loopwright-s04-controller',executable:'/usr/local/bin/docker',socket:'/Users/thxcode/.docker/run/docker.sock',client:'.claude/s03-t0/docker-client',budget:'.claude/s04-qualification/budget.json',image:'sha256:6c52d01f4514b2376422399be1b7909233373b0063d0d10920fbdc98343a7257',recordedBase:'sha256:067b2d425f1204b5a898ae3d3145f7524c1425a4096a62b0f67dd4344a494440',lsof:'/usr/sbin/lsof',workMs:58000,hardMs:60000});
/** @typedef {{path:string,byteLength:number,sha256:string}} Ref */
/** @typedef {ReturnType<typeof localOwner>} Owner */
/** @typedef {{code:number|null,signal:string|null}} Exit */
/** @typedef {import('node:child_process').ChildProcessByStdio<null,import('node:stream').Readable,import('node:stream').Readable>} Child */
function need(value,code){if(!value)fail('QUALIFICATION_PREFLIGHT_'+code);}
/** Data comparator only; original spelling is retained and cannot settle N2 removal. */
export function comparePreflightAbsence(original,identity){
  need(original.code===1&&original.signal===null&&['','[]'].includes(original.stdout.trim()),'ABSENCE');
  const text=original.stderr.trim(),matched=/^error: no such (?:object|container): (.+)$/i.exec(text);need(matched&&matched[1]===identity,'ABSENCE');
  return {identity,original,scope:'supplied exact read result only; no removal/absence capability'};
}
/** Pure comparison; these data cannot issue an activation or authorize a pathname race. */
export function compareExecutableDispatch(original,current,now,deadline){
  need(same(original,current),'EXECUTABLE_CHANGED');need(BigInt(now)<BigInt(deadline),'EXPIRED');return {original,current,postIOMonotonicMs:String(now),deadlineMonotonicMs:String(deadline),scope:'observed path/descriptor consistency only; no host attestation or elimination of all pathname races'};
}
export function comparePreflightDaemon(original,socket){
  need(original.code===0&&original.signal===null&&original.stderr==='','DAEMON');
  const id=original.stdout.trim();need(/^[A-Za-z0-9][A-Za-z0-9:._-]{0,127}$/.test(id)&&socket.path===preflightRoute.socket,'DAEMON');
  return {id,original,socket,historicalEquality:'UNKNOWN',continuity:'NOT_PROVEN',scope:'one new current local consistency anchor only; no historical settlement/removal'};
}
function fixedArgv(args,clientDirectory){return ['--config',clientDirectory??join(preflightRoute.project,preflightRoute.client),'--host','unix://'+preflightRoute.socket,...args];}
// BEGIN PRIVATE ORIGINAL COMMAND STOP: copied tests execute these exact private bodies.
/** Each fixed owner read consumes the same original command deadline. */
function boundedCommandOwner(pid,deadline){
  need(Number.isSafeInteger(pid)&&pid>0&&typeof deadline==='bigint'&&deadline>0n,'OWNER_UNKNOWN');
  const read=(file,args)=>{
    const remaining=deadline-monotonic();need(remaining>0n,'EXPIRED');
    const timeout=Number(remaining<2000n?remaining:2000n);need(Number.isSafeInteger(timeout)&&timeout>0,'EXPIRED');
    const text=execFileSync(file,args,{encoding:'utf8',timeout,maxBuffer:4096,env:{PATH:'/usr/bin:/bin:/usr/sbin',LANG:'C'}}).trim();
    need(monotonic()<deadline,'EXPIRED');return text;
  };
  const birth=read('/bin/ps',['-p',String(pid),'-o','lstart=']),boot=read('/usr/sbin/sysctl',['-n','kern.boottime']);
  need(birth.length>0&&birth.length<=128&&boot.length>0&&boot.length<=256,'OWNER_UNKNOWN');return {pid,birth,boot};
}
/** Private original-registration path only; no exported signal or activation capability. */
function stopOriginalCommand(input,signal){
  /** @type {{signal:string,deadlineMonotonicMs:string,registration:Ref|null,intent:Ref|null,signalSent:boolean,closure:string,error:string|null}} */
  const observation={signal,deadlineMonotonicMs:String(input.hard),registration:input.registration,intent:null,signalSent:false,closure:'UNKNOWN',error:null};
  try{
    need(['SIGTERM','SIGKILL'].includes(signal),'SIGNAL');
    need(typeof input.hard==='bigint'&&input.hard>0n&&monotonic()<input.hard,'EXPIRED');
    need(input.child?.pid&&input.owner&&input.registration&&input.registration.path===join(input.directory,'cli-'+input.ordinal+'-registered.json'),'REGISTRATION_UNKNOWN');
    const registration=JSON.parse(checkedRef(input.registration).toString()),original=JSON.parse(checkedRef(input.intent).toString());
    need(registration.version===1&&registration.pid===input.child.pid&&same(registration.owner,input.owner)&&same(registration.parent,input.parent)&&same(registration.intent,input.intent)&&registration.deadline===String(input.hard)&&original.deadline===String(input.hard)&&same(original.parent,input.parent),'REGISTRATION_CHANGED');
    need(same(boundedCommandOwner(input.child.pid,input.hard),input.owner),'ORIGINAL_OWNER_CHANGED');
    observation.intent=exclusive(join(input.directory,'cli-'+input.ordinal+'-signal-'+input.sequence+'-intent.json'),{version:1,commandIntent:input.intent,registration:input.registration,parent:input.parent,owner:input.owner,signal,deadline:String(input.hard)});
    need(same(boundedCommandOwner(input.child.pid,input.hard),input.owner),'ORIGINAL_OWNER_CHANGED');
    need(monotonic()<input.hard,'EXPIRED');process.kill(-input.child.pid,signal);observation.signalSent=true;
  }catch(value){observation.error=value.message;}
  return observation;
}
// END PRIVATE ORIGINAL COMMAND STOP
export function validateLsofHelp(original){
  const usage=original.stdout+'\n'+original.stderr;
  need([0,1].includes(original.code)&&original.signal===null&&/^lsof [0-9]+\.[0-9]+/m.test(usage)&&/\busage:\s*/i.test(usage)&&['-i','-F','-n','-P'].every(flag=>usage.includes(flag)),'LSOF_HELP');return original;
}
/** Data-only validation shared by the actual route and representative empty/nonempty controls. */
export function validatePreflightClient(client){privateDirectory(client);need(readdirSync(client).length===0,'CLIENT');return client;}
/** Fixed native lower. No caller-supplied callback, executable, env, argv or process factory. */
async function command(directory,ordinal,kind,args,deadline,parent,expectedExecutable,clientDirectory){
  const started=monotonic(),file=kind==='lsof'?preflightRoute.lsof:preflightRoute.executable,argv=kind==='lsof'?['-h']:fixedArgv(args,clientDirectory),binary=kind==='save',hard=BigInt(deadline)<started+2000n||binary?BigInt(deadline):started+2000n,work=hard-(binary?2000n:1000n);
  need(monotonic()<work,'EXPIRED');
  const intent=exclusive(join(directory,'cli-'+ordinal+'-intent.json'),{version:1,file,argv,parent,kind,deadline:String(hard),startedMonotonicMs:String(started),environment:{PATH:'/usr/bin:/bin:/usr/sbin',LANG:'C',HOME:directory}});
  const outputPath=join(directory,'cli-'+ordinal+(binary?'.tar':'.stdout.bin')),stderrPath=join(directory,'cli-'+ordinal+'.stderr.bin'),fd=openSync(outputPath,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600),errFd=openSync(stderrPath,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600),hash=createHash('sha256'),stderrHash=createHash('sha256');
  /** @type {Child|null} */ let child=null;
  /** @type {Owner|null} */ let owner=null;
  /** @type {Ref|null} */ let registration=null;
  /** @type {string|null} */ let error=null;
  /** @type {Exit|null} */ let exit=null;
  /** @type {ReturnType<typeof setTimeout>|null} */ let timer=null;
  /** @type {ReturnType<typeof setTimeout>|null} */ let killTimer=null;
  /** @type {ReturnType<typeof setTimeout>|null} */ let hardTimer=null;
  let stdoutBytes=0,stderrBytes=0,unretainedStdout=0,unretainedStderr=0,closedObserved=false;
  const stops=[];
  const stop=signal=>{const observation=stopOriginalCommand({directory,ordinal,child,owner,registration,intent,parent,hard,sequence:stops.length},signal);stops.push(observation);if(observation.error)error??=observation.error;};
  const refuse=code=>{error??=code;stop('SIGTERM');};
  try{
    const currentExecutable=executableFacts(file),dispatch=compareExecutableDispatch(expectedExecutable,currentExecutable,monotonic(),work);exclusive(join(directory,'cli-'+ordinal+'-dispatch.json'),dispatch);need(monotonic()<work,'EXPIRED');
    child=spawn(file,argv,{stdio:['ignore','pipe','pipe'],detached:true,env:{PATH:'/usr/bin:/bin:/usr/sbin',LANG:'C',HOME:directory}});
    const spawned=child;
    /** @type {Promise<void>} */ const closedChild=new Promise(resolve=>{spawned.once('error',value=>{error??=value.message;});spawned.once('close',(code,signal)=>{exit={code,signal};closedObserved=true;resolve();});});
    child.stdout.on('data',bytes=>{if(bytes.length>imageLimits.chunk||stdoutBytes+bytes.length>(binary?imageLimits.scratch-3*imageLimits.metadata-imageLimits.json:kind==='lsof'?65536:1048576)){unretainedStdout+=bytes.length;refuse('STDOUT_LIMIT');return;}let at=0;try{while(at<bytes.length){const written=writeSync(fd,bytes,at,bytes.length-at);need(written>0,'WRITE_UNKNOWN');hash.update(bytes.subarray(at,at+written));stdoutBytes+=written;at+=written;}}catch(value){unretainedStdout+=bytes.length-at;refuse(value.message);}});
    child.stderr.on('data',bytes=>{if(bytes.length>imageLimits.chunk||stderrBytes+bytes.length>65536){unretainedStderr+=bytes.length;refuse('STDERR_LIMIT');return;}let at=0;try{while(at<bytes.length){const written=writeSync(errFd,bytes,at,bytes.length-at);need(written>0,'WRITE_UNKNOWN');stderrHash.update(bytes.subarray(at,at+written));stderrBytes+=written;at+=written;}}catch(value){unretainedStderr+=bytes.length-at;refuse(value.message);}});
    if(child.pid){try{owner=boundedCommandOwner(child.pid,hard);registration=exclusive(join(directory,'cli-'+ordinal+'-registered.json'),{version:1,intent,parent,owner,pid:child.pid,deadline:String(hard)});}catch(value){error=value.message;refuse('OWNER_UNKNOWN');}}
    timer=setTimeout(()=>{refuse('WORK_DEADLINE');killTimer=setTimeout(()=>stop('SIGKILL'),binary?1000:500);},Math.max(0,Number(work-monotonic())));
    /** @type {Promise<void>} */ const expired=new Promise(resolve=>{hardTimer=setTimeout(()=>{refuse('HARD_DEADLINE');resolve();},Math.max(0,Number(hard-monotonic())));});
    await Promise.race([closedChild,expired]);
    if(!closedObserved){error??='ORIGINAL_CLOSE_UNKNOWN';child.stdout.removeAllListeners('data');child.stderr.removeAllListeners('data');child.stdout.destroy();child.stderr.destroy();}
  }catch(value){error??=value.message;}
  finally{for(const handle of [timer,killTimer,hardTimer])if(handle)clearTimeout(handle);fsyncSync(fd);fsyncSync(errFd);closeSync(fd);closeSync(errFd);}
  const stdout={path:outputPath,byteLength:stdoutBytes,sha256:hash.digest('hex')},stderr={path:stderrPath,byteLength:stderrBytes,sha256:stderrHash.digest('hex')};
  const result={version:1,intent,registration,owner,pid:child?.pid??null,exit,error,closedObserved,unretainedStdout,unretainedStderr,stops,stdout,stderr,completedMonotonicMs:String(monotonic())},ref=exclusive(join(directory,'cli-'+ordinal+'-exit.json'),result);
  if(!owner||!exit||error!==null||!closedObserved)throw Object.assign(new Error('QUALIFICATION_PREFLIGHT_CLI_UNKNOWN'),{observation:{originalCommand:ref}});return {result:{...result,owner,exit},ref};
}
function textResult(value){return {code:value.result.exit.code,signal:value.result.exit.signal,stdout:checkedRef(value.result.stdout).toString(),stderr:checkedRef(value.result.stderr).toString()};}
/** Dormant original route. This hold has no issuer and cannot satisfy either parent/app hold. */
export async function runHeldImagePreflight(activation,input){
  requireNativePreflightActivation(activation);
  const started=monotonic(),budget=join(preflightRoute.project,preflightRoute.budget);let ledger;
  try{ledger=new NativeLedger(budget);}catch(error){markParentTimeUnavailable(budget);throw error;}
  const time=ledger.beginHeldPreflightTime(activation,{phase:'initial',leaf:'image-preflight',directory:input.directory},started);
  return runOriginalPreflight(activation,ledger,time,input,false);
}
/** The original bootstrap/time handle stays in its original Node parent; no serialized adoption. */
export async function runHeldPreparedImagePreflight(activation,ledger,time,input){
  requireNativePreflightActivation(activation);return runOriginalPreflight(activation,ledger,time,input,true);
}
async function runOriginalPreflight(activation,ledger,time,input,prepared){
  requireNativePreflightActivation(activation);ledger.beginOriginalPreflightLifecycle(activation,time);const started=parentTimeState(time).record.startedMonotonicMs;
  /** @type {Ref[]} */ const reads=[];
  /** @type {Ref|null} */ let output=null;
  /** @type {Ref|null} */ let intent=null;
  /** @type {{message:string,observation:unknown}|null} */ let error=null;
  try{
    closed(input,['directory','expectedInventory','expectedBudgetSha256','daemonAnchor','ownedIdentities',...(Object.hasOwn(input,'clientDirectory')?['clientDirectory']:[]),...(Object.hasOwn(input,'parserCache')?['parserCache']:[])]);need(input.daemonAnchor==='new_current'&&resolve('.')===preflightRoute.project,'CWD');privateDirectory(input.directory);
    intent=exclusive(join(input.directory,'preflight-original-intent.json'),{version:1,startedMonotonicMs:String(started),route:preflightRoute,input,parent:localOwner()});
    const timing=prepared?ledger.readPreparedPreflightTime(time):ledger.preparePreflightTime(time);need(timing.original.sha256===input.expectedBudgetSha256,'BUDGET_CHANGED');const originalBudget=JSON.parse(checkedRef(timing.original).toString()),deadline=timing.deadlineMonotonicMs,parent=localOwner();
    need(originalBudget.containers.length===33&&Array.isArray(input.ownedIdentities)&&input.ownedIdentities.length===33,'OWNED_IDENTITIES');
    for(let ordinal=0;ordinal<33;ordinal++){const selected=input.ownedIdentities[ordinal],bound=bindOriginalIdentity(selected.budget,originalBudget.containers[ordinal],ordinal,selected.originalIntent,JSON.parse(checkedRef(selected.originalIntent).toString()));need(selected.budget.sha256===timing.original.sha256&&same(selected,bound),'OWNED_IDENTITY');need(monotonic()<BigInt(deadline),'EXPIRED');}
    const executable=executableFacts(preflightRoute.executable),lsof=executableFacts(preflightRoute.lsof),socket=lstatSync(preflightRoute.socket);need(socket.isSocket()&&realpathSync(preflightRoute.socket)===preflightRoute.socket,'SOCKET');const client=input.clientDirectory??join(preflightRoute.project,preflightRoute.client);if(input.clientDirectory)need(client===join(input.directory,'docker-client'),'CLIENT_BINDING');validatePreflightClient(client);
    const run=async(kind,args)=>{ledger.noteOriginalPreflightCommand(activation,time);const value=await command(input.directory,reads.length,kind,args,deadline,parent,kind==='lsof'?lsof:executable,client);ledger.closeOriginalPreflightCommand(activation,time,value.ref);reads.push(value.ref);return value;};
    const info=textResult(await run('info',['info','--format','{{.ID}}'])),daemon=comparePreflightDaemon(info,{path:preflightRoute.socket,mode:socket.mode,dev:socket.dev,ino:socket.ino});
    const imageResult=textResult(await run('image',['image','inspect',preflightRoute.image])),images=uniqueImageJSON(Buffer.from(imageResult.stdout));need(imageResult.code===0&&imageResult.signal===null&&imageResult.stderr===''&&Array.isArray(images)&&images.length===1,'IMAGE');const image=images[0];need(image.Id===preflightRoute.image&&image.Os==='linux'&&image.Architecture==='arm64'&&image.RootFS?.Type==='layers','IMAGE_IDENTITY');
    const saved=await run('save',['image','save',preflightRoute.image]);need(saved.result.exit.code===0&&saved.result.exit.signal===null&&saved.result.stderr.byteLength===0,'SAVE');
    const archive=await inspectImageArchive(saved.result.stdout,{image:preflightRoute.image,diffIds:image.RootFS.Layers},input.directory,deadline,input.parserCache??null),compared=compareImagePayload(archive.payload,readExpectedInventory(input.expectedInventory).entries);
    /** @type {ReturnType<typeof comparePreflightAbsence>[]} */ const absences=[];
    need(originalBudget.containers.length===33&&new Set(originalBudget.containers.map(row=>row.name)).size===33,'OWNED_IDENTITIES');
    for(const row of input.ownedIdentities)absences.push(comparePreflightAbsence(textResult(await run('absence',['inspect',row.name])),row.name));
    const help=validateLsofHelp(textResult(await run('lsof',[])));
    need(monotonic()<BigInt(deadline),'EXPIRED');output=exclusive(join(input.directory,'preflight-original-result.json'),{version:1,scope:'local image/daemon/payload/exact historical absence only; no SDK/provider/CLI task acceptance',intent,executable,lsof,daemon,socket:{path:preflightRoute.socket,mode:socket.mode,dev:socket.dev,ino:socket.ino},client,reads,image,archive:archive.result,compared,absences,lsofHelp:help,peakRSSKiB:process.resourceUsage().maxRSS,originalUnknownsRetained:13,baseScope:'recorded pinned builder provenance only; no extra base image read',recordedBase:preflightRoute.recordedBase});
  }catch(value){error={message:value.message,observation:value.observation??null};}
  const timed=ledger.completeHeldPreflightTime(activation,time,{intent,output,error,reads,endedMonotonicMs:String(monotonic())});if(error)throw Object.assign(new Error(error.message),{accounting:timed});return {output,...timed};
}
