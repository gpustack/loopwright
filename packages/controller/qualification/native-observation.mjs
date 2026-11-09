/* global Buffer, setTimeout, clearTimeout */
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { canonical, sha, nonce, exclusive, localOwner, privateDirectory, fail } from './native-context.mjs';
import { requireNativeAppActivation } from './native-activation.mjs';
const observers=new WeakMap();
export function processEvidence(observer){const read=observers.get(observer);if(!read)fail('QUALIFICATION_PROCESS_OBSERVER');return read();}
/** Extra private process observations. They never grant a permit, kill a PID, release occupancy or repair an attach. */
export class ProcessObservations {
  #queue=new Map();#pending=new Set();#records=[];#failed=false;#streamBytes=0;
  constructor(directory,parent,meter,native=null){
    privateDirectory(directory);this.directory=directory;this.parent=parent;this.meter=meter;
    if(native)requireNativeAppActivation(native.activation);
    observers.set(this,()=>({mode:native?'native':'offline',reservationId:native?.reservationId??null,recipeDigest:native?.recipeDigest??null,directory,parent,records:JSON.parse(canonical(this.#records)),pending:this.#pending.size,unknown:this.#failed,streamBytes:this.#streamBytes}));
  }
  before(entry,args){
    if(this.#failed||this.#records.length>=512)fail('QUALIFICATION_PROCESS_UNKNOWN');
    const token=nonce(),key=canonical(entry.argv),intent=exclusive(join(this.directory,'process-intent-'+token+'.json'),{version:1,nonce:token,parent:this.parent,kind:entry.kind,identity:entry.identity??null,argvSha256:sha(canonical(args)),originalIntent:entry.intent??null});
    const record={nonce:token,intent,kind:entry.kind,entry:JSON.parse(canonical(entry)),argv:[...args],pid:null,owner:null,exit:null,stdoutBytes:0,stderrBytes:0,unknown:null};this.#records.push(record);
    const values=this.#queue.get(key)??[];values.push(record);this.#queue.set(key,values);
  }
  after(child,entry){
    const record=this.#queue.get(canonical(entry.argv))?.shift();
    if(!record){this.#unknown('MISSING_LOGICAL_INTENT');return;}
    if(!child||!Number.isSafeInteger(child.pid)||child.pid<1){record.unknown='MISSING_ACTUAL_PID';this.#unknown(record.unknown);return;}
    record.pid=child.pid;
    try{record.owner=localOwner(child.pid);record.registered=exclusive(join(this.directory,'process-started-'+record.nonce+'.json'),{version:1,nonce:record.nonce,parent:this.parent,owner:record.owner,intent:record.intent});}
    catch(error){record.unknown=error.message;this.#unknown('MISSING_ACTUAL_BIRTH');}
    const stdout=createHash('sha256'),stderr=createHash('sha256'),bodies={stdout:[],stderr:[]};
    const data=(stream,maximum,hash,chunk)=>{
      const bytes=Buffer.from(chunk);record[stream+'Bytes']+=bytes.length;this.#streamBytes+=bytes.length;
      if(record[stream+'Bytes']>maximum||this.#streamBytes>67108864){record.unknown='STREAM_LIMIT';this.#unknown(record.unknown);return;}
      hash.update(bytes);bodies[stream].push(bytes);
    };
    // Tap original raw pushes before any existing execFile UTF-8 decoder. Do not re-encode decoded data events.
    // The same stream, original chunks/encoding, push return and caller callbacks remain in place.
    const restores=[];
    for(const [name,maximum,hash] of [['stdout',8388608,stdout],['stderr',1048576,stderr]]){
      const stream=child[name];if(!stream||typeof stream.push!=='function'){record.unknown='MISSING_RAW_STREAM';this.#unknown(record.unknown);continue;}
      const original=stream.push,unknown=()=>{record.unknown='RAW_STREAM_ENCODING';this.#unknown(record.unknown);};
      const push=function(chunk,encoding){if(chunk!==null){if(Buffer.isBuffer(chunk)||chunk instanceof Uint8Array)data(name,maximum,hash,chunk);else unknown();}return original.call(this,chunk,encoding);};
      stream.push=push;restores.push(()=>{if(stream.push!==push){unknown();return;}stream.push=original;});
    }
    let complete;
    const pending=new Promise(resolve=>{complete=resolve;});this.#pending.add(pending);
    child.once('error',error=>{record.unknown=error.code??'PROCESS_ERROR';this.#unknown(record.unknown);});
    child.once('close',(code,signal)=>{
      for(const restore of restores)restore();
      record.exit={code,signal};record.stdoutSha256=stdout.digest('hex');record.stderrSha256=stderr.digest('hex');
      try{
        for(const stream of ['stdout','stderr']){
          const bytes=Buffer.concat(bodies[stream]);record[stream+'Chunks']=[];
          for(let offset=0;offset<bytes.length;offset+=1048576)record[stream+'Chunks'].push(exclusive(join(this.directory,'process-'+record.nonce+'-'+stream+'-'+offset+'.bin'),bytes.subarray(offset,offset+1048576)));
        }
        record.observed=exclusive(join(this.directory,'process-exit-'+record.nonce+'.json'),record);
      }catch(error){record.unknown=error.message;this.#unknown('EXIT_RECORDING_UNKNOWN');}
      this.#pending.delete(pending);complete();
    });
  }
  #unknown(){this.#failed=true;this.meter.unknown();}
  async finish(){
    let timer;try{await Promise.race([Promise.all(this.#pending),new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('QUALIFICATION_PROCESS_EXIT_UNKNOWN')),10000);})]);}finally{clearTimeout(timer);}
    const result={version:1,records:this.#records,pending:this.#pending.size,unknown:this.#failed};
    const ref=exclusive(join(this.directory,'process-observation-final.json'),result);
    if(this.#failed||this.#pending.size||[...this.#queue.values()].some(rows=>rows.length)||this.#records.some(row=>!row.registered||!row.observed||!row.exit))fail('QUALIFICATION_PROCESS_UNKNOWN');
    return {ref,value:result};
  }
}
