import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';
export type Mail={kind:string;[key:string]:unknown};
export function ownedChild(name='owner-process'){
  const before=process.hrtime.bigint()/1000000n;
  const child=fork(fileURLToPath(new URL(`./fixtures/${name}.js`,import.meta.url)),[],{execArgv:[],env:{PATH:process.env.PATH??'',TMPDIR:process.env.TMPDIR??''},stdio:['ignore','pipe','pipe','ipc']});
  const queue:Mail[]=[];const waiting:{kind:string;resolve:(mail:Mail)=>void;reject:(error:Error)=>void;timer:ReturnType<typeof setTimeout>}[]=[];
  let stderr='',exit:{pid:number|undefined;code:number|null;signal:NodeJS.Signals|null}|undefined;
  child.stderr?.on('data',(b:Buffer)=>{stderr+=b.toString();});
  child.on('message',(mail:Mail)=>{const next=waiting.find(w=>w.kind===mail.kind||mail.kind==='failure');if(!next){queue.push(mail);return;}waiting.splice(waiting.indexOf(next),1);clearTimeout(next.timer);if(mail.kind==='failure')next.reject(Error(JSON.stringify(mail)));else next.resolve(mail);});
  child.on('error',error=>{for(const pending of waiting.splice(0)){clearTimeout(pending.timer);pending.reject(error);}});
  const exited=new Promise<{pid:number|undefined;code:number|null;signal:NodeJS.Signals|null}>(resolve=>child.once('exit',(code,signal)=>{exit={pid:child.pid,code,signal};resolve(exit);for(const pending of waiting.splice(0)){clearTimeout(pending.timer);pending.reject(Error(`child exited before ${pending.kind}: ${stderr}`));}}));
  function wait(kind:string):Promise<Mail>{const index=queue.findIndex(m=>m.kind===kind||m.kind==='failure');if(index>=0){const mail=queue.splice(index,1)[0]!;return mail.kind==='failure'?Promise.reject(Error(JSON.stringify(mail))):Promise.resolve(mail);}return new Promise((resolve,reject)=>{const entry={kind,resolve,reject,timer:setTimeout(()=>{waiting.splice(waiting.indexOf(entry),1);reject(Error(`IPC deadline for ${kind}; ${stderr}`));},5000)};waiting.push(entry);});}
  return {child,before,wait,send:(value:Record<string,unknown>)=>child.send(value),exited,
    async stop(){if(!exit){if(child.connected)child.send({action:'close'});const timer=setTimeout(()=>child.kill('SIGKILL'),5000);await exited;clearTimeout(timer);}assert.equal(stderr,'');return exit!;}};
}
