/* global process, Buffer */
import {spawnSync} from 'node:child_process';
import {readPrivate,checkedRef,sha,canonical,exclusive,localOwner,same,monotonic,fail} from './native-context.mjs';
import {join} from 'node:path';
import {requireNativeActivation} from './native-activation.mjs';
import {s03Budget,s03DebitScope} from './s03-scope.mjs';
const nativeRead=spawnSync,closures=new WeakMap();
const need=v=>{if(!v)fail('QUALIFICATION_S03_CLOSURE');};
/** Private original-owner closure, not a NativeTerminal, measured use, permit, or serialized grant. */
export function collectS03Closure(activation,path,base,input){requireNativeActivation(activation);return collect(path,base,input,false);}
export function collectCopiedS03Closure(path,base,input){need(path!==s03Budget);return collect(path,base,input,true);}
function collect(path,base,{result,output,approval},copied){
  const scope=s03DebitScope(path,{...base,kind:'observe'},copied,true),{entry,plan}=scope;
  need(same(plan.owner,localOwner())&&entry.s03.occupants.length===0&&result&&(Number.isInteger(result.code)&&result.signal===null||result.code===null&&['SIGTERM','SIGKILL'].includes(result.signal)));
  if(copied)need(!entry.s03.events.some(e=>e.kind==='containers'));
  const envelope=JSON.parse(checkedRef(output));need(envelope.exit===result.code&&envelope.signal===result.signal);
  for(const stream of [envelope.stdout,envelope.stderr]){need(stream&&stream.byteLength<=4194304&&Array.isArray(stream.chunks)&&stream.chunks.length<=8);const buffers=stream.chunks.map(ref=>checkedRef(ref));const bytes=Buffer.concat(buffers);need(bytes.length===stream.byteLength&&sha(bytes)===stream.sha256);}
  const main=entry.s03.events.find(e=>e.kind==='node'&&same(e.actor,plan.owner));need(main?.identity.closed&&main.identity.result.streams==='closed'&&main.identity.result.stdout===envelope.stdout.sha256&&main.identity.result.stderr===envelope.stderr.sha256&&main.identity.result.exit===result.code&&main.identity.result.signal===result.signal);
  const reads=[];
  const read=(file,args)=>{
    s03DebitScope(path,{...base,kind:'observe'},copied,true);
    const left=Number(BigInt(plan.clock.hardCutoff)-monotonic());need(left>0);let observation;
    const original=nativeRead(file,args,{encoding:'utf8',timeout:Math.max(1,Math.min(2000,left)),maxBuffer:1048576,env:{PATH:'/usr/local/bin:/usr/bin:/bin:/usr/sbin',LANG:'C'}});need(original.pid>0&&!original.error);
    observation={pid:original.pid,exit:original.status,signal:original.signal,stdout:original.stdout??'',stderr:original.stderr??''};
    s03DebitScope(path,{...base,kind:'observe'},copied,true);reads.push({file,args,...observation});return observation;
  };
  const daemon=()=>{const result=read(plan.executable,['--config',plan.client,'--host','unix://'+plan.socket,'info','--format','{{.ID}}']);need(result.exit===0&&result.signal===null&&result.stderr===''&&result.stdout.trim()===plan.runtime.daemon.id);};
  if(!copied)daemon();
  const dead=new Set();
  const proveDead=pid=>{if(!dead.has(pid)){const observed=read('/bin/ps',['-p',String(pid),'-o','pid=,lstart=']);need(observed.exit===1&&observed.signal===null&&observed.stdout.trim()===''&&observed.stderr.trim()==='');dead.add(pid);}};
  for(const row of entry.s03.events.filter(e=>['node','process','cleanup-process'].includes(e.kind))){
    if(row.identity.closed===false&&row.identity.child===null&&row.identity.result===null){
      // A synchronous launch whose calling actor the cutoff killed after registerLaunch and before finish; no pid was ever observed.
      need(['process','cleanup-process'].includes(row.kind));proveDead(row.actor.pid);continue; // Retain UNKNOWN exit/tail in unknownExits; never invent an ACK.
    }
    const pid=row.identity.child?.pid??row.identity.result?.pid;need(Number.isSafeInteger(pid)&&pid>0&&pid!==process.pid);
    proveDead(pid);
    if(!row.identity.closed)need(row.identity.child&&dead.has(row.actor.pid)); // Its original owner died; retain UNKNOWN exit/tail, prove OS descriptors gone, never invent an ACK.
  }
  for(const row of entry.s03.events.filter(e=>e.kind==='listener')){
    need(dead.has(row.actor.pid));const observed=read('/usr/sbin/lsof',['-nP','-a','-p',String(row.actor.pid),'-iTCP:'+row.identity.port,'-sTCP:LISTEN','-Fp']);need(observed.exit===1&&observed.signal===null&&observed.stdout.trim()===''&&observed.stderr.trim()==='');
  }
  for(const row of entry.s03.events.filter(e=>e.kind==='node'&&e.identity.entry==='node:daemon-fixture')){
    const pid=row.identity.child?.pid??row.identity.result?.pid;need(dead.has(pid));const observed=read('/usr/sbin/lsof',['-nP','-a','-p',String(pid),'-U','-Fp']);need(observed.exit===1&&observed.signal===null&&observed.stdout.trim()===''&&observed.stderr.trim()==='');
  }
  for(const row of entry.s03.events.filter(e=>e.kind==='containers')){
    const id=row.identity.id;need(/^[a-f0-9]{64}$/.test(id));const observed=read(plan.executable,['--config',plan.client,'--host','unix://'+plan.socket,'inspect',id]);
    const found=/^error: no such (?:object|container): (.+)$/i.exec(observed.stderr.trim());need(observed.exit===1&&observed.signal===null&&['','[]'].includes(observed.stdout.trim())&&found?.[1]===id);
  }
  if(!copied)daemon();
  const ref=exclusive(join(plan.directory,'original-closure.json'),{version:1,kind:'s03-complete-owned-closure',reservationId:entry.id,owner:plan.owner,result,output,approval,scope:entry.s03,reads,unknownExits:entry.s03.events.filter(e=>['node','process','cleanup-process'].includes(e.kind)&&!e.identity.closed).map(e=>e.key),accounting:'full nonrefundable allocated_unknown; actual use and billing UNKNOWN; original NativeTerminal seal ABSENT'});
  const handle=Object.freeze({});closures.set(handle,{mode:copied?'offline':'native',path,id:entry.id,scope:canonical(entry.s03),ref,result,approval,original:exclusive(join(plan.directory,'held-before-allocation.json'),readPrivate(path))});return handle;
}
export function originalS03Closure(handle,path,entry){const value=closures.get(handle);need(value&&value.path===path&&value.id===entry.id&&value.scope===canonical(entry.s03)&&same(localOwner(),entry.owner));return value;}

/** Original captured buffers only; chunking preserves the original four-MiB stream bound. */
export function retainS03Output(directory,result){
  const save=(name,bytes)=>{need(bytes.length<=4194304);const chunks=[];for(let offset=0;offset<bytes.length;offset+=524288)chunks.push(exclusive(join(directory,'original-'+name+'-'+chunks.length+'.bin'),bytes.subarray(offset,offset+524288)));return {byteLength:bytes.length,sha256:sha(bytes),chunks};};
  return exclusive(join(directory,'original-output.json'),{exit:result.code,signal:result.signal,stdout:save('stdout',result.stdout),stderr:save('stderr',result.stderr)});
}
