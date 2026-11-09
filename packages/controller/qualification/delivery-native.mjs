/* global process, Buffer */
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';
import { describePiAdapterFiles } from '@loopwright/agent-pi';
import { loadTrustedConfiguration, compilePlan } from '@loopwright/controller';
import { nativeCases, fixtureDocuments, fixtureReply, fixtureHandlerDigests } from './native-cases.mjs';
import { canonical, sha, exclusive, localOwner, readPrivate, fail } from './native-context.mjs';
const project='/Users/thxcode/orca/workspaces/loopwright/loopwright-s04-controller',book=join(project,'.claude/s04-qualification/budget.json');
export const deliveryQualification=Object.freeze({runId:'run_316587aa2c7f',taskId:'task_79ce55c2b3a8',dispatchId:'ctx_242594ec6fb9'});
const runtime={image:'sha256:6c52d01f4514b2376422399be1b7909233373b0063d0d10920fbdc98343a7257',executable:'/usr/local/bin/docker',socket:'/Users/thxcode/.docker/run/docker.sock',clientDirectory:join(project,'.claude/s03-t0/docker-client'),graphDigest:{algorithm:'sha256',hex:sha(readFileSync(join(project,'package-lock.json')))}};
const dataRoot=join(project,'.claude/s04-qualification/delivery-native-011');
function sourceManifest(directory){
  const hashes={},bodies={};for(const name of readdirSync(join(project,'packages/controller/qualification')).filter(name=>name.endsWith('.mjs')).sort()){const bytes=readFileSync(join(project,'packages/controller/qualification',name));hashes[name]=sha(bytes);bodies[name]=exclusive(join(directory,'source-'+name+'.bin'),bytes);}
  const paths=[join(project,'package-lock.json'),join(project,'package.json')];
  for(const name of ['core','state','agent-pi','controller','cli']){paths.push(join(project,'packages',name,'package.json'));const walk=path=>{for(const entry of readdirSync(path,{withFileTypes:true}).sort((a,b)=>a.name.localeCompare(b.name))){const file=join(path,entry.name);if(entry.isDirectory())walk(file);else if(entry.name.endsWith('.js'))paths.push(file);}};walk(join(project,'packages',name,'dist'));}
  const appBindings={},appBodies={};for(const [index,path]of paths.entries()){const bytes=readFileSync(path);appBindings[path]=sha(bytes);appBodies[path]=exclusive(join(directory,'runtime-'+index+'.bin'),bytes);}
  const value={version:2,hashes,bodies,appBindings,appBodies};return{value,ref:exclusive(join(directory,'source-manifest.json'),value),sourceDigest:sha(canonical(hashes)),runtimeDigest:sha(canonical(appBindings))};
}
export async function prepareNativeFixtures(){
  mkdirSync(dataRoot,{mode:0o700});const outside=realpathSync(mkdtempSync(join(tmpdir(),'loopwright-s04-native-'))),operator=join(outside,'operator'),taskData=join(outside,'task-data');mkdirSync(operator,{mode:0o700});mkdirSync(taskData,{mode:0o700});
  const described=await describePiAdapterFiles();if(!described.ok)fail('QUALIFICATION_DESCRIPTION_'+described.error.code);const files=described.value,digests=fixtureHandlerDigests(),previous=process.env.S04_PROVIDER_TOKEN;process.env.S04_PROVIDER_TOKEN='S04_STATIC_PREPARATION_ONLY';
  const leaves={};
  try{for(const leaf of ['cycle','repair','assertion']){
    const directory=join(dataRoot,leaf);mkdirSync(directory,{mode:0o700});const cases=[];
    for(const id of leaf==='assertion'?nativeCases.cycle:nativeCases[leaf]){
      const fixtureId=leaf==='assertion'&&id==='changed-completed'?'required-check-failed':id;
      const repository=join(outside,'repo-'+leaf+'-'+id),runRoot=join(outside,'runs-'+leaf+'-'+id);mkdirSync(repository,{mode:0o700});mkdirSync(runRoot,{mode:0o700});
      const initial=fixtureDocuments(fixtureId,'unfrozen',files,runtime,digests).initial.bytes;writeFileSync(join(repository,'result.json'),initial,{flag:'wx',mode:0o600});
      const git=args=>execFileSync('/usr/bin/git',['-c','core.hooksPath=/dev/null',...args],{cwd:repository,encoding:'utf8',timeout:5000,maxBuffer:65536,env:{PATH:'/usr/bin:/bin',LANG:'C',LC_ALL:'C',GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:'/dev/null',HOME:'/nonexistent',GIT_TERMINAL_PROMPT:'0'}});
      git(['init','-q']);git(['add','result.json']);git(['-c','user.name=S04 Native Fixture','-c','user.email=fixture@localhost.invalid','commit','-qm','freeze controlled inert bytes']);const revision=git(['rev-parse','HEAD']).trim();
      const docs=fixtureDocuments(fixtureId,revision,files,runtime,digests);docs.config.spec.task.metadata.id='native-'+id;const config=exclusive(join(taskData,leaf+'-'+id+'.json'),Buffer.from(JSON.stringify(docs.config))),registry=exclusive(join(operator,leaf+'-'+id+'.json'),Buffer.from(JSON.stringify(docs.registry))),script=exclusive(join(directory,'script-'+id+'.json'),docs.script),sse=exclusive(join(directory,'sse-'+id+'.json'),docs.script.map((reply,index)=>exclusive(join(directory,'sse-'+id+'-'+index+'.bin'),Buffer.from(fixtureReply(reply,index+1)))));
      const loaded=await loadTrustedConfiguration({configPath:config.path,registryPath:registry.path,registrySha256:registry.sha256,untrustedRoots:[repository]});if(!loaded.ok)fail('QUALIFICATION_STATIC_'+loaded.error.code);const plan=await compilePlan(loaded.value);if(!plan.ok)fail('QUALIFICATION_STATIC_'+plan.error.code);exclusive(join(directory,'plan-'+id+'.json'),plan.value);
      cases.push({id,runId:'s04-cli-011-'+leaf+'-'+id,repository,runRoot,revision,static:false,config,registry,script,sse,initial:exclusive(join(directory,'initial-'+id+'.bin'),initial)});
    }
    const source=sourceManifest(directory),template={version:2,mode:'native',leaf:leaf==='assertion'?'cycle':leaf,qualification:deliveryQualification,sourceDigest:source.sourceDigest,runtimeDigest:source.runtimeDigest,image:runtime.image,executable:runtime.executable,socket:runtime.socket,clientDirectory:runtime.clientDirectory,caps:leaf==='assertion'?{provider:2,mcp:0,containers:1}:{provider:12,mcp:0,containers:10},cases};
    leaves[leaf]={directory,template:exclusive(join(directory,'template.json'),template),source:source.ref};
  }}finally{if(previous===undefined)delete process.env.S04_PROVIDER_TOKEN;else process.env.S04_PROVIDER_TOKEN=previous;}
  return exclusive(join(dataRoot,'fixtures.json'),{version:1,scope:'static public-loader/compiler qualification only; no admission/native calls',outside,owner:localOwner(),leaves});
}
export async function executeNativeLeaf(activation,leaf,phase){
  const {requireNativeActivation}=await import('./native-activation.mjs');requireNativeActivation(activation);
  const {runPreparedNativeParent}=await import('./native-parent.mjs'),prepared=JSON.parse(readPrivate(join(dataRoot,'fixtures.json'))),selected=prepared.leaves[leaf];if(!selected)fail('QUALIFICATION_DELIVERY_LEAF');
  const origin=exclusive(join(selected.directory,'origin-before.json'),readPrivate(book));
  return runPreparedNativeParent(activation,{budget:book,directory:selected.directory,phase,leaf:leaf==='assertion'?'cycle':leaf,preparedTemplate:selected.template,recipe:null,origin,expectedBudgetSha256:origin.sha256});
}
if(process.argv[1]&&pathToFileURL(resolve(process.argv[1])).href===import.meta.url){
  if(resolve('.')!==project)throw new Error('QUALIFICATION_DELIVERY_CONTEXT');
  if(process.argv.length===3&&process.argv[2]==='--prepare')prepareNativeFixtures().then(value=>process.stdout.write(canonical(value)+'\n'),error=>{process.stderr.write(canonical({error:error.message})+'\n');process.exitCode=1;});
  else if(process.argv.length===6&&process.argv[2]==='--case'&&['cycle','repair','assertion'].includes(process.argv[3])&&process.argv[4]==='--phase'&&['initial','finalController'].includes(process.argv[5])){
    const {runApprovedDeliveryLeaf}=await import('./native-activation.mjs');runApprovedDeliveryLeaf(process.argv[3],process.argv[5]).then(value=>{process.stdout.write(canonical(value)+'\n');if(value.qualification?.status!=='passed')process.exitCode=1;},error=>{process.stderr.write(canonical({error:error.message,observation:error.observation??null})+'\n');process.exitCode=1;});
  }else throw new Error('QUALIFICATION_DELIVERY_ARGUMENT');
}
