/// <reference lib="es2023" />
/* global Buffer, process, structuredClone, setTimeout, clearTimeout */
import './native-image.test.mjs';
import test,{after} from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync,readFileSync,readdirSync,appendFileSync,openSync,fsyncSync,closeSync,chmodSync,symlinkSync,renameSync,existsSync } from 'node:fs';
import { resolve,join } from 'node:path';
import { fork } from 'node:child_process';
import { Script } from 'node:vm';
import { canonical,sha,exclusive,localOwner,monotonic,same } from './native-context.mjs';
import { beginCopiedLauncherBootstrap,launcherBootstrapState,validateLauncherBinding,originalLauncherDeadline,runFixedPreflight,prepareFixedLauncher,verifyFrozenInventory,bindOriginalIdentity,claimLauncherBootstrap,retainCopiedLauncherUnknown } from './native-preflight-launcher.mjs';
import { executableFacts,compareExecutableDispatch,comparePreflightDaemon,runHeldPreparedImagePreflight,preflightRoute } from './native-image-inspector.mjs';
import { NativeLedger } from './native-ledger.mjs';
import { parentTimeState,mutateLegacyBudget } from './native-lock.mjs';
import { leaves } from './schedule.mjs';

const root=mkdtempSync(resolve('.claude/s04-qualification/launcher-source-')),owner=localOwner(),actualBudget=resolve('.claude/s04-qualification/budget.json'),nativeBefore=readFileSync(actualBudget),observations=[];
const program='/Users/thxcode/Documents/github.com/thxcode/loopwright/.claude/reports/loopwright-harness-architecture/spec-S04/raw/build';
const originalInventory={path:resolve('.claude/s04-qualification/image-source-3aICiw/installed-inventory-BH007D/inventory-index.json'),byteLength:6104,sha256:'491037b40ccf5334ceb685cad8e05d91d2b7f83941bd6a395ef7ca2a020034ba'};
const registry=resolve('.claude/s04-qualification/launcher-source-fixtures.ndjson');appendFileSync(registry,canonical({version:1,root,owner,scope:'offline launcher/copied common bootstrap only',originalBudgetSha256:sha(nativeBefore)})+'\n',{mode:0o600});const registryFd=openSync(registry,'r');try{fsyncSync(registryFd);}finally{closeSync(registryFd);}
function capture(name,value){const ref=exclusive(join(root,name+'.json'),{version:1,scope:'offline-only',value});observations.push({name,ref});return ref;}
function attempt(action){try{const value=action();return value===undefined?{ok:true,returnedType:'undefined'}:{ok:true,value};}catch(error){return {ok:false,code:error.message};}}
async function attempted(action){try{return {ok:true,value:await action()};}catch(error){return {ok:false,code:error.message};}}
function directory(prefix){return mkdtempSync(join(root,prefix+'-'));}
function files(directory){return Object.fromEntries(readdirSync(directory,{withFileTypes:true}).filter(row=>row.isFile()).map(row=>{const path=join(directory,row.name),bytes=readFileSync(path);return [path,{byteLength:bytes.length,sha256:sha(bytes),text:bytes.toString()}];}));}
function stall(ms){Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,ms);}
after(()=>{const after=readFileSync(actualBudget);exclusive(join(root,'launcher-source-result.json'),{version:1,root,owner,observations,originalBudgetSha256:sha(nativeBefore),finalBudgetSha256:sha(after),nativeBudgetUnchanged:after.equals(nativeBefore),activation:'HELD',peakRSSKiB:process.resourceUsage().maxRSS});assert.deepEqual(after,nativeBefore);});

test('launcher source: exact private command stop bodies refuse late owner intent and missing registration without physical signals',()=>{
  const path=resolve('packages/controller/qualification/native-image-inspector.mjs'),source=readFileSync(path),text=source.toString(),begin='// BEGIN PRIVATE ORIGINAL COMMAND STOP: copied tests execute these exact private bodies.\n',end='// END PRIVATE ORIGINAL COMMAND STOP',start=text.indexOf(begin),finish=text.indexOf(end);
  assert.ok(start>=0&&finish>start);assert.equal(text.indexOf(begin,start+1),-1);assert.equal(text.indexOf(end,finish+1),-1);
  const bodies=text.slice(start+begin.length,finish),extraction=exclusive(join(root,'private-command-stop-original-body.txt'),Buffer.from(bodies)),rows=[];
  assert.ok(text.includes('const observation=stopOriginalCommand({directory,ordinal,child,owner,registration,intent,parent,hard,sequence:stops.length},signal)'));assert.ok(text.includes('owner=boundedCommandOwner(child.pid,hard);registration=exclusive('));
  for(const kind of ['valid-before-cutoff','expired-entry','slow-first-owner','clipped-ps-no-sysctl','changed-first-owner','unknown-owner','slow-intent','failed-intent','late-second-owner','changed-second-owner','missing-registration','wrong-registration','wrong-intent','invalid-signal','slow-registration','owner-zero-timeout','owner-invalid-deadline','post-owner-cutoff']){
    const dir=directory('private-stop-'+kind),calls=[],clockCalls=[],signals=[],parent={pid:700001,birth:'original parent',boot:'original boot'},originalOwner={pid:700002,birth:'original child',boot:'original boot'},hard=1000n;
    let clock=kind==='expired-entry'?1000n:kind==='clipped-ps-no-sysctl'?999n:0n,reads=0;
    const original={version:1,parent,deadline:kind==='wrong-intent'?'2000':String(hard)},commandIntent=exclusive(join(dir,'cli-0-intent.json'),original),registered={version:1,intent:commandIntent,parent,owner:originalOwner,pid:originalOwner.pid,deadline:String(hard)};
    if(kind==='wrong-registration')registered.parent={...parent,pid:700003};const registration=exclusive(join(dir,'cli-0-registered.json'),registered);
    const input={directory:dir,ordinal:0,child:{pid:originalOwner.pid},owner:originalOwner,registration:kind==='missing-registration'?null:registration,intent:commandIntent,parent,hard,sequence:0},signal=kind==='invalid-signal'?'SIGSTOP':'SIGTERM';
    const originalInput=exclusive(join(dir,'original-input.json'),{kind,input:{...input,hard:String(hard)},signal,originalIntent:original,originalRegistration:registered,initialClock:String(clock),scope:'copied exact private functions; synthetic PID/clock/builtin calls only; zero physical processes/signals/native calls'});
    const bindings={
      monotonic:()=>{if(kind==='post-owner-cutoff'&&clockCalls.length===9)clock=1000n;clockCalls.push(String(clock));return clock;},join,same,need:(value,code)=>{if(!value)throw new Error('QUALIFICATION_PREFLIGHT_'+code);},
      checkedRef:ref=>{calls.push({kind:'checkedRef',ref,at:String(clock)});if(kind==='slow-registration')clock=1000n;const bytes=readFileSync(ref.path);assert.equal(bytes.length,ref.byteLength);assert.equal(sha(bytes),ref.sha256);return bytes;},
      execFileSync:(file,args,options)=>{
        const before=clock;calls.push({kind:'owner',file,args,options,at:String(before)});assert.ok(options.timeout>0&&options.timeout<=2000&&BigInt(options.timeout)<=hard-before);assert.equal(options.maxBuffer,4096);assert.equal(options.encoding,'utf8');assert.deepEqual(JSON.parse(JSON.stringify(options.env)),{PATH:'/usr/bin:/bin:/usr/sbin',LANG:'C'});
        const isPs=file==='/bin/ps';assert.ok(isPs||file==='/usr/sbin/sysctl');assert.deepEqual(Array.from(args),isPs?['-p','700002','-o','lstart=']:['-n','kern.boottime']);const ordinal=reads++;
        if(kind==='unknown-owner')throw new Error('ORIGINAL_OWNER_UNKNOWN');
        if((kind==='slow-first-owner'&&ordinal===0)||(kind==='late-second-owner'&&ordinal===2))clock=1000n;
        if(kind==='clipped-ps-no-sysctl'){assert.equal(options.timeout,1);clock=1000n;}
        if((kind==='changed-first-owner'&&ordinal===0)||(kind==='changed-second-owner'&&ordinal===2))return 'changed birth';
        return isPs?originalOwner.birth:originalOwner.boot;
      },
      exclusive:(path,value)=>{calls.push({kind:'intent',path,value,at:String(clock)});if(kind==='failed-intent')throw new Error('ORIGINAL_SIGNAL_INTENT_WRITE_FAILED');const ref=exclusive(path,value);if(kind==='slow-intent')clock=1000n;return ref;},
      process:{kill:(pid,selected)=>{const value={pid,signal:selected,at:String(clock)};signals.push(value);calls.push({kind:'signal',...value});return true;}}
    };
    const exact=new Script("'use strict';\n"+bodies+'\n({boundedCommandOwner,stopOriginalCommand})',{filename:path+'#exact-private-bodies'}).runInNewContext(bindings,{timeout:1000});
    const result=kind==='owner-zero-timeout'?attempt(()=>exact.boundedCommandOwner(originalOwner.pid,0n)):kind==='owner-invalid-deadline'?attempt(()=>exact.boundedCommandOwner(originalOwner.pid,'invalid')):exact.stopOriginalCommand(input,signal),output=JSON.parse(JSON.stringify(result));
    const outcome={kind,originalInput,source:{path,byteLength:source.length,sha256:sha(source)},extraction,bodyStartByte:Buffer.byteLength(text.slice(0,start+begin.length)),bodyByteLength:Buffer.byteLength(bodies),output,calls,clockCalls,signals,finalClock:String(clock),originalHardDeadline:String(hard),scope:'VM exact production bodies, no physical process/close/daemon evidence'};
    const ref=exclusive(join(dir,'original-outcome.json'),outcome);rows.push({kind,ref});
    if(kind==='valid-before-cutoff'){assert.equal(output.error,null);assert.equal(output.signalSent,true);assert.equal(signals.length,1);assert.equal(signals[0].pid,-originalOwner.pid);assert.equal(signals[0].signal,'SIGTERM');assert.ok(BigInt(signals[0].at)<hard);assert.deepEqual(calls.map(row=>row.kind),['checkedRef','checkedRef','owner','owner','intent','owner','owner','signal']);}
    else{assert.equal(signals.length,0);if(kind.startsWith('owner-'))assert.equal(output.ok,false);else{assert.equal(output.signalSent,false);assert.ok(typeof output.error==='string');}}
    if(!kind.startsWith('owner-')){assert.equal(output.closure,'UNKNOWN');assert.equal(output.deadlineMonotonicMs,String(hard));}
    if(['expired-entry','missing-registration','wrong-registration','wrong-intent','invalid-signal','slow-registration','owner-zero-timeout','owner-invalid-deadline'].includes(kind))assert.equal(reads,0);
    if(['slow-first-owner','clipped-ps-no-sysctl'].includes(kind))assert.equal(reads,1);
    if(kind==='slow-intent')assert.equal(reads,2);if(kind==='late-second-owner')assert.equal(reads,3);
    if(kind==='post-owner-cutoff'){assert.equal(reads,4);assert.equal(clockCalls.length,10);assert.equal(clockCalls.at(-1),'1000');}
    const intents=calls.filter(row=>row.kind==='intent');if(intents.length){assert.equal(intents.length,1);assert.equal(intents[0].value.deadline,String(hard));assert.deepEqual(intents[0].value.registration,registration);assert.deepEqual(intents[0].value.commandIntent,commandIntent);assert.deepEqual(intents[0].value.parent,parent);assert.deepEqual(intents[0].value.owner,originalOwner);}
  }
  capture('private-command-stop-summary',{source:{path,byteLength:source.length,sha256:sha(source)},extraction,rows,physicalChildren:0,physicalSignals:0,nativeCalls:0,closure:'UNKNOWN',scope:'deterministic copied exact private bodies only; actual route HELD'});assert.equal(rows.length,18);
});

test('launcher source: original fixed route owner dispatch source and once-only binding records reject independent substitutions',()=>{
  const project=resolve('.'),main=join(project,'packages/controller/qualification/native-preflight-launcher.mjs'),node={path:'/synthetic/original/node',sha256:'a'.repeat(64)},expected={cwd:project,main,argv:[node.path,'--max-old-space-size=128','--max-semi-space-size=8',main],node,nodeAlias:{path:'/synthetic/alias/node',sha256:node.sha256},parent:{pid:700001,birth:'original parent',boot:'synthetic original boot'},child:{pid:700002,birth:'original child',boot:'synthetic original boot'},taskId:'task_79ce55c2b3a8',dispatchId:'ctx_39ed50870bb7',runId:'run_316587aa2c7f',head:'ea7a47fc66c5f9fe463f2f480255ba0b17905537',sourceManifestSha256:'b'.repeat(64)};
  const rows=[];
  for(const kind of ['positive',...Object.keys(expected),'added-key']){
    const actual=structuredClone(expected);if(kind==='added-key')actual.extra='unapproved';else if(kind!=='positive'){if(kind==='argv')actual.argv=[...actual.argv,'--activate'];else if(['parent','child'].includes(kind))actual[kind]={...actual[kind],pid:700003};else if(['node','nodeAlias'].includes(kind))actual[kind]={...actual[kind],sha256:'c'.repeat(64)};else actual[kind]='changed-'+kind;}
    const input=exclusive(join(root,'binding-input-'+kind+'.json'),{actual,expected,scope:'synthetic original binding; no process or activation'}),output=attempt(()=>validateLauncherBinding(actual,expected));rows.push({kind,input,output});
  }
  capture('binding-matrix',{rows});assert.equal(rows[0].output.ok,true);assert.ok(rows.slice(1).every(row=>!row.output.ok));
  const nonceRows=[],token='a'.repeat(32),image='sha256:2fdbe75954264927676a9a44d0e9c1fcbad9a687a1ae167416b595a06d548543'; // Historical33 original records, independent of current selected image.
  for(const kind of ['direct','label','equal-dual','conflicting-dual','null-direct','empty-direct','invalid-direct','null-label','empty-label','invalid-label','null-labels','missing','intent-nonce','intent-label','intent-name','intent-image','different-labels']){
    const dir=directory('nonce-'+kind),labels={'org.loopwright.nonce':token,'org.loopwright.run':'original-synthetic-run'},row={directory:dir,name:'lw-pi-'+token,image,nonce:token},intent={version:1,name:row.name,image,nonce:token,labels:structuredClone(labels)};
    if(!['direct'].includes(kind))row.labels=structuredClone(labels);if(['label','missing'].includes(kind))delete row.nonce;if(kind==='missing')delete row.labels;
    if(kind==='conflicting-dual')row.nonce='b'.repeat(32);if(kind==='null-direct')row.nonce=null;if(kind==='empty-direct')row.nonce='';if(kind==='invalid-direct')row.nonce='INVALID';
    if(kind==='null-label')row.labels['org.loopwright.nonce']=null;if(kind==='empty-label')row.labels['org.loopwright.nonce']='';if(kind==='invalid-label')row.labels['org.loopwright.nonce']='INVALID';if(kind==='null-labels')row.labels=null;
    if(kind==='intent-nonce')intent.nonce='b'.repeat(32);if(kind==='intent-label')intent.labels['org.loopwright.nonce']='b'.repeat(32);if(kind==='intent-name')intent.name='lw-pi-'+'b'.repeat(32);if(kind==='intent-image')intent.image='sha256:'+'b'.repeat(64);if(kind==='different-labels')row.labels['org.loopwright.run']='changed';
    const budget=exclusive(join(dir,'original-budget.json'),{version:1,containers:[row],scope:'synthetic identity-only input'}),originalIntent=exclusive(join(dir,'container-intent.json'),intent),input=exclusive(join(dir,'original-input.json'),{budget,row,ordinal:0,originalIntent,intent}),output=attempt(()=>bindOriginalIdentity(budget,row,0,originalIntent,intent));nonceRows.push({kind,input,output});
  }
  capture('nonce-representation-matrix',{rows:nonceRows});assert.ok(nonceRows.slice(0,3).every(row=>row.output.ok));assert.ok(nonceRows.slice(3).every(row=>!row.output.ok));assert.equal(nonceRows[1].output.value.nonceSource,'row.labels[org.loopwright.nonce]');
});

test('launcher source: original common bootstrap transfers one Node clock and delayed preparation exhausts allowance before every lower',async()=>{
  const rows=[];
  for(const kind of ['positive','delayed','changed-start']){
    const dir=directory('bootstrap-'+kind),path=join(dir,'budget.json'),before=JSON.parse(nativeBefore.toString());
    if(kind==='delayed'){const near=leaves['image-preflight'][1]-0.01,extra=near-(before.native.leafSeconds['initial:image-preflight']??0);before.native.seconds.initial+=extra;before.native.leafSeconds['initial:image-preflight']=near;if(before.qualificationReservations){before.qualificationReservations.revision++;before.qualificationReservations.timeTransitions.push({id:'e'.repeat(32),phase:'initial',leaf:'image-preflight',seconds:extra,receipt:exclusive(join(dir,'copied-prior-spend.json'),{scope:'synthetic copy-only prior cumulative allocation',seconds:extra})});}}
    exclusive(path,Buffer.from(canonical(before)+'\n'));const beforeBytes=readFileSync(path),bootstrap=beginCopiedLauncherBootstrap(path),opened=launcherBootstrapState(bootstrap),legacyBlocked=attempt(()=>mutateLegacyBudget(path,owner,value=>value)),ledger=new NativeLedger(path),started=BigInt(opened.startedMonotonicMs),beforePreparation=String(monotonic());
    if(kind==='delayed')stall(80);
    const begin=attempt(()=>ledger.beginCopiedPreflightTime({phase:'initial',leaf:'image-preflight',directory:dir},kind==='changed-start'?started+1n:started,bootstrap));
    let lower=0,prepared=null,readPrepared=null,outcome=null,result=null,state=null,repeat=null,duplicate=null,legacyAfter=null;
    if(begin.ok){
      const time=begin.value;duplicate=attempt(()=>claimLauncherBootstrap(bootstrap,path,owner,parentTimeState(time).record));legacyAfter=attempt(()=>mutateLegacyBudget(path,owner,value=>value));assert.equal(legacyAfter.code,'QUALIFICATION_PARENT_TIME_PENDING');prepared=attempt(()=>ledger.preparePreflightTime(time));if(prepared.ok){readPrepared=attempt(()=>ledger.readPreparedPreflightTime(time));lower++;}
      outcome={error:prepared.ok?null:{message:prepared.code},exit:{code:0,signal:null},intent:exclusive(join(dir,'original-work.json'),{kind,lower,scope:'copied no-native lower counter only'})};result=attempt(()=>ledger.completeCopiedPreflightTime(time,outcome));state=parentTimeState(time);
      if(kind==='positive')repeat=attempt(()=>beginCopiedLauncherBootstrap(path));
    }
    const row={kind,directory:dir,path,opened,bootstrapAfter:launcherBootstrapState(bootstrap),beforePreparation,afterPreparation:String(monotonic()),legacyBlocked,legacyAfter,begin:begin.ok?{ok:true,opaqueHandle:'not serialized'}:begin,prepared,readPrepared,outcome,result,state,repeat,duplicate,lower,before:{text:beforeBytes.toString(),sha256:sha(beforeBytes)},after:{text:readFileSync(path).toString(),sha256:sha(readFileSync(path))},files:files(dir)};const ref=capture('bootstrap-'+kind,row);rows.push({kind,ref});
    assert.equal(legacyBlocked.ok,false);assert.equal(legacyBlocked.code,'QUALIFICATION_LOCK_HELD');
    if(kind==='positive'){assert.equal(result.ok,true);assert.equal(duplicate.ok,false);assert.equal(state.record.startedMonotonicMs,opened.startedMonotonicMs);assert.deepEqual(readPrepared.value,prepared.value);assert.equal(lower,1);assert.equal(repeat.ok,false);assert.ok(existsSync(path+'.preflight-attempt.json'));}
    if(kind==='delayed'){assert.equal(lower,0);assert.equal(prepared.code,'QUALIFICATION_PREFLIGHT_EXPIRED');assert.equal(result.ok,false);assert.equal(state.state,'unknown');assert.ok(existsSync(path+'.parent-time-pending.json'));assert.equal(state.record.startedMonotonicMs,opened.startedMonotonicMs);}
    if(kind==='changed-start'){assert.equal(begin.ok,false);assert.equal(lower,0);assert.equal(launcherBootstrapState(bootstrap).state,'unknown');assert.deepEqual(readFileSync(path),beforeBytes);}
  }
  capture('bootstrap-summary',{rows,clock:'ONE original Node process.hrtime start and deadline; Python root clock never crosses',actualBudgetSha256:sha(readFileSync(actualBudget))});
  {
    const dir=directory('expired-before-transfer'),path=join(dir,'budget.json');exclusive(path,nativeBefore);const bootstrap=beginCopiedLauncherBootstrap(path),opened=launcherBootstrapState(bootstrap);stall(30);const expired=attempt(()=>originalLauncherDeadline(opened.startedMonotonicMs,0.01,monotonic())),unknown=retainCopiedLauncherUnknown(bootstrap,expired.code),denial=attempt(()=>mutateLegacyBudget(path,owner,value=>value));capture('expired-before-transfer',{directory:dir,path,opened,expired,unknown,denial,lower:0,files:files(dir)});assert.equal(expired.ok,false);assert.equal(unknown.receiptError,null);assert.equal(denial.ok,false);assert.deepEqual(readFileSync(path),nativeBefore);
  }
  for(const kind of ['lock-substitution','path-substitution']){
    const dir=directory(kind),path=join(dir,'budget.json');exclusive(path,nativeBefore);const bootstrap=beginCopiedLauncherBootstrap(path),opened=launcherBootstrapState(bootstrap),other=join(dir,'other-budget.json');exclusive(other,nativeBefore);
    if(kind==='lock-substitution'){renameSync(path+'.lock',path+'.moved-original-lock');exclusive(path+'.lock',{scope:'planned foreign replacement copied lock'});}
    const selected=kind==='path-substitution'?other:path,returned=attempt(()=>new NativeLedger(selected).beginCopiedPreflightTime({phase:'initial',leaf:'image-preflight',directory:dir},BigInt(opened.startedMonotonicMs),bootstrap)),denial=attempt(()=>mutateLegacyBudget(path,owner,value=>value));
    capture(kind,{directory:dir,path,selected,opened,returned,denial,state:launcherBootstrapState(bootstrap),files:files(dir)});assert.equal(returned.ok,false);assert.equal(denial.ok,false);assert.deepEqual(readFileSync(path),nativeBefore);
  }
  const dir=directory('killed-bootstrap'),path=join(dir,'budget.json');exclusive(path,nativeBefore);const entry=resolve('packages/controller/qualification/native-preflight-bootstrap-fixture.mjs'),intent=exclusive(join(dir,'original-child-intent.json'),{entry,argv:[path],parent:owner,scope:'one copied bootstrap child, killed before opaque transfer'}),child=fork(entry,[path],{execArgv:['--max-old-space-size=128','--max-semi-space-size=8'],stdio:['ignore','pipe','pipe','ipc'],env:{PATH:'/usr/bin:/bin:/usr/sbin',LANG:'C'}});assert.ok(typeof child.pid==='number'&&child.pid>0);const registered=exclusive(join(dir,'original-child-registered.json'),{intent,pid:child.pid,owner:localOwner(child.pid)});
  const buffers={stdout:[],stderr:[]},lengths={stdout:0,stderr:0},unretained={stdout:0,stderr:0};for(const name of ['stdout','stderr'])child[name].on('data',bytes=>{const retained=Math.min(bytes.length,65536-lengths[name]);if(retained){buffers[name].push(Buffer.from(bytes.subarray(0,retained)));lengths[name]+=retained;}unretained[name]+=bytes.length-retained;});
  let closeObserved=false,streamRefs=null;const closed=new Promise(resolveClose=>child.once('close',(code,signal)=>{closeObserved=true;resolveClose({code,signal});}));let timer;
  const retain=()=>{if(streamRefs===null)streamRefs={stdout:exclusive(join(dir,'original-child.stdout.bin'),Buffer.concat(buffers.stdout)),stderr:exclusive(join(dir,'original-child.stderr.bin'),Buffer.concat(buffers.stderr)),unretained,closeObserved};return streamRefs;};
  try{
    const opened=await new Promise((resolveMessage,reject)=>{timer=setTimeout(()=>reject(new Error('COPIED_BOOTSTRAP_READY_TIMEOUT')),2000);child.once('message',resolveMessage);child.once('error',reject);}),registration=JSON.parse(readFileSync(registered.path).toString());clearTimeout(timer);
    assert.ok(same(opened.owner,registration.owner));const killIntent=exclusive(join(dir,'original-kill-intent.json'),{owner:registration.owner,signal:'SIGTERM',intent,registered});assert.ok(same(localOwner(child.pid),registration.owner));const sent=child.kill('SIGTERM'),exit=await closed,denial=attempt(()=>mutateLegacyBudget(path,owner,value=>value)),streams=retain();capture('killed-bootstrap',{directory:dir,path,intent,registered,opened,killIntent,sent,exit,denial,streams,files:files(dir)});assert.equal(sent,true);assert.deepEqual(exit,{code:null,signal:'SIGTERM'});assert.equal(denial.ok,false);assert.ok(existsSync(path+'.lock'));assert.deepEqual(readFileSync(path),nativeBefore);assert.deepEqual(unretained,{stdout:0,stderr:0});
  }finally{clearTimeout(timer);if(child.exitCode===null&&child.signalCode===null&&same(localOwner(child.pid),JSON.parse(readFileSync(registered.path).toString()).owner)){child.kill('SIGTERM');await closed;}retain();}
});

test('launcher source: original canonical executable target replacement post-I/O deadline and new daemon anchor inputs retain exact refusals',()=>{
  const dir=directory('executable'),target=join(dir,'node-fixture'),link=join(dir,'node-link');exclusive(target,Buffer.from('owned synthetic executable\n'));chmodSync(target,0o700);symlinkSync('node-fixture',link);const original=executableFacts(link),same=executableFacts(link),positive=attempt(()=>compareExecutableDispatch(original,same,'1','100'));
  const replacement=join(dir,'replacement');exclusive(replacement,readFileSync(target));chmodSync(replacement,0o700);renameSync(replacement,target);const changed=executableFacts(link),replaced=attempt(()=>compareExecutableDispatch(original,changed,'2','100'));
  const before=monotonic(),deadline=before+10n;stall(30);const afterRead=executableFacts(link),observed=monotonic(),expired=attempt(()=>compareExecutableDispatch(changed,afterRead,observed,deadline));
  capture('executable-boundary',{directory:dir,original,same,changed,positive,replaced,expired,before:String(before),observed:String(observed),deadline:String(deadline),files:files(dir),scope:'actual synthetic file/rename and post-I/O delay; no concurrent-hash native race or process dispatch proof'});assert.equal(positive.ok,true);assert.equal(replaced.code,'QUALIFICATION_PREFLIGHT_EXECUTABLE_CHANGED');assert.equal(expired.code,'QUALIFICATION_PREFLIGHT_EXPIRED');
  const socket={path:preflightRoute.socket,dev:900,ino:901,mode:0o140600},base={code:0,signal:null,stdout:'  NEW:current_engine-1\n',stderr:''},rows=[];
  for(const kind of ['positive','exit','signal','stderr','empty','slash','length','socket']){
    const original={...base},selected={...socket};if(kind==='exit')original.code=1;if(kind==='signal')original.signal='SIGTERM';if(kind==='stderr')original.stderr='warning';if(kind==='empty')original.stdout=' \n';if(kind==='slash')original.stdout='new/foreign';if(kind==='length')original.stdout='a'.repeat(129);if(kind==='socket')selected.path='/foreign/socket';
    const input=exclusive(join(root,'daemon-input-'+kind+'.json'),{original,socket:selected,scope:'synthetic supplied local anchor only'}),output=attempt(()=>comparePreflightDaemon(original,selected));rows.push({kind,input,output});
  }
  capture('daemon-anchor-matrix',{rows});assert.equal(rows[0].output.ok,true);assert.equal(rows[0].output.value.historicalEquality,'UNKNOWN');assert.equal(rows[0].output.value.continuity,'NOT_PROVEN');assert.equal(rows[0].output.value.original.stdout,base.stdout);assert.ok(rows.slice(1).every(row=>!row.output.ok));
});

test('launcher source: unissued holds inert issuer supervisor patches and exact original inventory cannot become data-derived activation',async()=>{
  let reads=0;const holds={fixed:await attempted(()=>runFixedPreflight({})),prepared:await attempted(()=>runHeldPreparedImagePreflight({}, {get path(){reads++;return actualBudget;}},{},{get directory(){reads++;return '/must-not-read';}})),main:await attempted(()=>prepareFixedLauncher()),copiedActual:attempt(()=>beginCopiedLauncherBootstrap(actualBudget))};
  const source=readFileSync('packages/controller/qualification/native-activation.mjs').toString(),patchNames=['n1-launcher-issuer-inert.patch','n1-launcher-supervisor-inert.patch'],patches=patchNames.map(name=>{const path=join(program,name),bytes=readFileSync(path);return {name,ref:{path,byteLength:bytes.length,sha256:sha(bytes)},text:bytes.toString()};});
  const historicalInventory=await attempted(()=>verifyFrozenInventory(originalInventory,String(monotonic()+30000n))),{inventoryInstalled}=await import('./native-image.mjs'),currentInventory=await inventoryInstalled(resolve('.'),directory('current-inventory')),inventory=await (await import('./native-preflight-launcher.mjs')).verifyPrivateInventory(currentInventory.index,String(monotonic()+30000n)),clockPositive=attempt(()=>originalLauncherDeadline('100',1,'1099')),clockExpired=attempt(()=>originalLauncherDeadline('100',1,'1100'));
  capture('holds-inventory-inert-patches',{reads,holds,source:{path:resolve('packages/controller/qualification/native-activation.mjs'),sha256:sha(source)},patches,historicalInventory,currentInventory:currentInventory.index,inventory,clockPositive,clockExpired,actualBudgetSha256:sha(readFileSync(actualBudget)),scope:'patch bytes NOT applied/executed; original inventory NOT regenerated'});
  assert.equal(reads,0);assert.ok(Object.values(holds).every(row=>!row.ok));assert.equal(holds.fixed.code,'NATIVE_PREFLIGHT_ACTIVATION_HELD');assert.equal(holds.prepared.code,'NATIVE_PREFLIGHT_ACTIVATION_HELD');assert.equal((source.match(/new WeakSet/g)??[]).length,3);assert.ok(source.includes('runApprovedS03')&&source.includes('activations.add(activation)'));assert.equal(historicalInventory.ok,false);assert.equal(historicalInventory.code,'QUALIFICATION_LAUNCHER_INVENTORY_CHANGED');assert.ok(patches[0].text.includes('preflights.add(activation)'));assert.ok(patches[1].text.includes('t4-native-image-preflight-once'));assert.equal(inventory.entries,19746);assert.equal(clockPositive.ok,true);assert.equal(clockExpired.ok,false);
});
