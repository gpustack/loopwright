/* global process, setTimeout, clearTimeout */
// Builtins only until the original common exclusion/start clock exists.
import {mkdirSync,readdirSync,readFileSync,realpathSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {execFileSync} from 'node:child_process';
const project='/Users/thxcode/orca/workspaces/loopwright/loopwright-s04-controller',nativeRead=execFileSync;
export async function executeS03Group(activation,bootstrap,group){
  const {requireNativeActivation}=await import('./native-activation.mjs');requireNativeActivation(activation);
  const {launcherBootstrapState,finishDeliveryBootstrap}=await import('./native-preflight-launcher.mjs');
  const {NativeLedger,charges}=await import('./native-ledger.mjs'),{s03Groups,s03Caps,s03Budget,s03ActiveIdentity}=await import('./s03-scope.mjs');
  const {exclusive,canonical,sha,readPrivate,checkedRef,localOwner,monotonic,fail,nonce,same}=await import('./native-context.mjs');
  const {parentTimeState}=await import('./native-lock.mjs'),{allowance}=await import('./schedule.mjs');
  const original=launcherBootstrapState(bootstrap),directory=join(project,'.claude/s04-qualification/s03-'+group+'-'+nonce());mkdirSync(directory,{mode:0o700});
  const ledger=new NativeLedger(s03Budget),time=ledger.beginHeldParentTime(activation,{directory,phase:'finalPi',leaf:'s03-'+group},BigInt(original.startedMonotonicMs),bootstrap);
  let io=null,admitted=false;
  try{
    if(!Object.hasOwn(s03Groups,group)||group==='runtime-image')fail('QUALIFICATION_S03_EXISTING_PREFLIGHT_ROW_REQUIRED');
    const book=ledger.read(),available=allowance(book.native,'finalPi','s03-'+group,['recovery','limits'].includes(group)?300:120),hardCutoff=BigInt(original.startedMonotonicMs)+BigInt(Math.floor(available*1000)),workCutoff=hardCutoff-20000n;
    if(monotonic()>=workCutoff)fail('QUALIFICATION_LIMIT');
    const {currentS03Preflight}=await import('./s03-preflight-binding.mjs'),preflight=currentS03Preflight();exclusive(join(directory,'fresh-image-binding.json'),preflight);
    const before=exclusive(join(directory,'before-reservation.json'),readPrivate(s03Budget)),client=join(directory,'docker-client');mkdirSync(client,{mode:0o700});
    const sources=[];const walk=path=>{for(const item of readdirSync(path,{withFileTypes:true}).sort((a,b)=>a.name.localeCompare(b.name))){const file=join(path,item.name);if(item.isDirectory())walk(file);else if(item.isFile()&&/\.(?:mjs|js|json)$/.test(item.name)){const bytes=readFileSync(file);sources.push({path:realpathSync(file),byteLength:bytes.length,sha256:sha(bytes)});}}};
    for(const root of ['packages/controller/qualification','packages/agent-pi/qualification','packages/core/dist','packages/state/dist','packages/agent-pi/dist','.test-build/packages/agent-pi/test','.test-build/packages/agent-pi/src'])walk(join(project,root));
    for(const name of ['package.json','package-lock.json','packages/agent-pi/runtime/seccomp.json']){const file=join(project,name),bytes=readFileSync(file);sources.push({path:realpathSync(file),byteLength:bytes.length,sha256:sha(bytes)});}
    const image=readFileSync(join(project,'.claude/s03-t0/runtime-image.id'),'utf8').trim();if(image!=='sha256:6c52d01f4514b2376422399be1b7909233373b0063d0d10920fbdc98343a7257')fail('QUALIFICATION_S03_IMAGE');
    const entry=join(project,'packages/agent-pi/qualification',s03Groups[group][0]),entries=[entry];
    for(const name of group==='recovery'?['recovery.mjs','lifecycle-controls.mjs','recovery-crashes.mjs','recovery-crash-child.mjs']:group==='dispositions'?['lifecycle-controls.mjs']:group==='limits'?['retained-cost.mjs','lifecycle-controls.mjs','mcp.mjs']:[])entries.push(join(project,'packages/agent-pi/qualification',name));
    const ownership=join(directory,'ownership.json'),cpuLedger=join(project,'.claude/s03-retained-cost'),argv=[entry,ownership,...(group==='session-opus'?['--model','claude-opus-5.5']:group==='limits'?['--ledger-dir',cpuLedger]:[])];
    const precharge={provider:['parser-context-failures','runtime-path'].includes(group)?24:group==='admission-mutations'?8:0,mcp:group==='runtime-path'?8:['mcp','limits'].includes(group)?1:0};
    const git={head:nativeRead('/usr/bin/git',['rev-parse','HEAD'],{encoding:'utf8',timeout:2000}).trim(),tree:nativeRead('/usr/bin/git',['rev-parse','HEAD^{tree}'],{encoding:'utf8',timeout:2000}).trim()};
    const plan={version:1,kind:'s03-quota-v1',group,project,owner:localOwner(),identity:s03ActiveIdentity,git,phase:'finalPi',clock:{workCutoff:String(workCutoff),hardCutoff:String(hardCutoff)},caps:s03Caps(group),before,timeIntent:parentTimeState(time).pending,image,runtime:{socket:preflight.socket,executable:preflight.executable,daemon:preflight.daemon},executable:'/usr/local/bin/docker',socket:'/Users/thxcode/.docker/run/docker.sock',client,directory,ownership,cpuLedger,sources,entries,argv,precharge};
    const planRef=exclusive(join(directory,'plan.json'),plan),context={...s03ActiveIdentity,suite:'s03',sourceDigest:sha(canonical(sources)),runtimeDigest:sha(readFileSync(join(project,'package-lock.json'))),image,leafCutoff:String(workCutoff),qualificationVersion:2,recipeDigest:sha(canonical(plan))};
    const used={containers:0,provider:0,mcp:0},attempted=new Set();
    for(const row of book.qualificationReservations.entries.filter(e=>e.context.suite==='s03')){const previous=JSON.parse(checkedRef(row.s03.plan));attempted.add(previous.group);for(const kind of Object.keys(used))used[kind]+=row.caps[kind];}
    for(const future of Object.keys(s03Groups).filter(key=>key===group||!attempted.has(key)))for(const kind of Object.keys(used))used[kind]+=s03Caps(future)[kind];
    if(used.containers>547||used.provider>568||used.mcp>1480)fail('QUALIFICATION_S03_PROGRAM_ENVELOPE');exclusive(join(directory,'prospective-table.json'),{groups:s03Groups,usedAndRemaining:used,limits:{containers:547,provider:568,mcp:1480}});
    const handle=ledger.reserve(context,plan.caps,planRef),base={reservationId:handle.id,plan:planRef};admitted=true;
    const {installS03Io}=await import('./s03-io.mjs');io=installS03Io({path:s03Budget,base,plan});
    for(const [kind,units]of Object.entries(precharge))if(units)io.debit({kind,key:'fixed-precharge:'+group+':'+kind,units,identity:{group,source:context.sourceDigest,route:kind==='provider'?'frozen-sdk-or-admission-fixture':'frozen-raw-or-trusted-mcp-fixture'}});
    const child=(await import('node:child_process')).spawn(process.execPath,argv,{detached:true,stdio:['ignore','pipe','pipe'],env:{PATH:'/usr/local/bin:/usr/bin:/bin',HOME:directory,LANG:'C.UTF-8'}});
    const owner=localOwner(child.pid);let timer;
    const stop=()=>{let actual;try{actual=localOwner(child.pid);}catch(error){if(error.status===1)return;throw error;}if(!same(actual,owner))fail('QUALIFICATION_S03_PROCESS_IDENTITY');const pgid=nativeRead('/bin/ps',['-p',String(child.pid),'-o','pgid='],{encoding:'utf8',timeout:1000,maxBuffer:128}).trim();if(pgid!==String(child.pid))fail('QUALIFICATION_S03_PROCESS_GROUP');process.kill(-child.pid,'SIGTERM');};
    let result;try{timer=setTimeout(stop,Math.max(1,Number(workCutoff-monotonic())));result=await child.s03Closed;}finally{clearTimeout(timer);}
    const {retainS03Output}=await import('./s03-closure.mjs'),output=retainS03Output(directory,result);
    let parsed=null;try{parsed=JSON.parse(result.stdout);}catch{if(result.code===0)fail('QUALIFICATION_S03_RESULT');}
    if(result.code===0){
      if(parsed.status!=='passed'&&parsed.passed!==true&&group!=='parser-context-failures')fail('QUALIFICATION_S03_RESULT');
      const sdk=group==='parser-context-failures'?parsed:group==='runtime-path'?parsed.receipts?.[0]?.result:null;
      if(sdk&&(!Number.isInteger(sdk.physicalRequests)||sdk.physicalRequests>24||sdk.strictDefaultPhysicalSends!==0||sdk.deniedSecond<1))fail('QUALIFICATION_S03_RAW_BOUND');
      if(group==='admission-mutations'&&(!same(parsed.cases.map(row=>row.physical),[0,1,1,1,0,2])||io.scope().entry.s03.events.filter(row=>row.kind==='physical'&&row.identity.transport==='provider').length!==5))fail('QUALIFICATION_S03_MUTATION_RESULT');
    }
    // Only fresh exact same-image/label/ID residue from THIS original held scope can be drained.
    for(const row of [...io.scope(true).entry.s03.occupants]){
      const {observeS03Container}=await import('./native-lock.mjs'),cp=await import('node:child_process'),args=['--config',plan.client,'--host','unix://'+plan.socket];
      const found=JSON.parse(cp.execFileSync(plan.executable,[...args,'inspect',row.id??row.name],{encoding:'utf8',timeout:2000}))[0];
      const event=io.scope(true).entry.s03.events.find(e=>e.key===row.key);if(found.Name!=='/'+row.name||found.Image!==plan.image||!same(found.Config.Labels,event.identity.labels)||row.id&&found.Id!==row.id)fail('QUALIFICATION_S03_CLEANUP');
      if(!row.id)observeS03Container(s03Budget,base,row.name,found.Id,'bind');
      if(found.State.Running)cp.execFileSync(plan.executable,[...args,'kill',found.Id],{timeout:2000});
      cp.execFileSync(plan.executable,[...args,'rm',found.Id],{timeout:2000});
    }

    const approvalFile='/Users/thxcode/Documents/github.com/thxcode/loopwright/.claude/reports/loopwright-harness-architecture/spec-S04/REVIEW-066-full-s03-row-audit.md',approvalBytes=readFileSync(approvalFile);if(sha(approvalBytes)!=='24fa154ecd0cbbd18be8d459ae3021f3763c0f4e3112af3c7c5ac97fa11467ae')fail('QUALIFICATION_S03_APPROVAL');
    const approval=exclusive(join(directory,'approval-original.bin'),approvalBytes),{collectS03Closure}=await import('./s03-closure.mjs'),closure=collectS03Closure(activation,s03Budget,base,{result:{code:result.code,signal:result.signal},output,approval});
    const allocation=ledger.allocateS03(handle,closure);io.flush();io.restore();io=null;
    const accounting=ledger.completeParentTime(time,{exit:result.code,signal:result.signal,error:result.code===0?null:'ORIGINAL_S03_FAILED'});finishDeliveryBootstrap(bootstrap,accounting,directory);
    return {directory,group,result:result.code===0?'PASS':'FAIL',allocation,accounting,observed:parsed,charges:charges(ledger.read()),scope:'local original S03 assertions; full conservative quota, actual use/billing UNKNOWN; no live provider'};
  }catch(error){
    if(io){try{io.flush();}catch{/* Unknown observation stays unknown. */}io.restore();}
    if(!admitted){try{const accounting=ledger.completeParentTime(time,{exit:null,signal:null,error:error.message});finishDeliveryBootstrap(bootstrap,accounting,directory);}catch(accounting){error.accounting=accounting.message;}}
    // An admitted unknown retains its original scope/time/attempt; never automatically reconcile or retry.
    throw error;
  }
}
if(process.argv[1]&&pathToFileURL(resolve(process.argv[1])).href===import.meta.url){
  if(process.argv.length===6&&process.argv[2]==='--case'&&process.argv[3]==='runtime-image'&&process.argv[4]==='--owner'&&process.argv[5]==='controller'&&resolve('.')===project){
    const {currentS03Preflight}=await import('./s03-preflight-binding.mjs'),{exclusive}=await import('./native-context.mjs'),result={group:'runtime-image',result:'PASS',kind:'existing-pinned-image-verification',preflight:currentS03Preflight()};exclusive(join(project,'.claude/s04-qualification/s03-runtime-image-final-031.json'),result);process.stdout.write(JSON.stringify(result)+'\n');
  }else{
  const launcher=await import('./native-preflight-launcher.mjs'),bootstrap=launcher.beginApprovedS03Bootstrap();
  const {runApprovedS03}=await import('./native-activation.mjs');
  // Finish this module evaluation before the fixed issuer imports its exported executor.
  runApprovedS03(bootstrap).then(result=>{process.stdout.write(JSON.stringify(result)+'\n');if(result.result!=='PASS')process.exitCode=1;},error=>{process.stderr.write(JSON.stringify({error:error.message,accounting:error.accounting??null})+'\n');process.exitCode=1;});
  }
}
