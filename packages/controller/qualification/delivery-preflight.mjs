/* global process */
import { mkdirSync, readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
const project='/Users/thxcode/orca/workspaces/loopwright/loopwright-s04-controller';
const directory=join(project,'.claude/s04-qualification/delivery-preflight-031'),inputPath=join(directory,'input.json');
export async function prepareCurrentPreflight(){
  const {exclusive,sha,readPrivate,canonical}=await import('./native-context.mjs');
  const {bindOriginalIdentity}=await import('./native-preflight-launcher.mjs'),{inventoryInstalled}=await import('./native-image.mjs');
  mkdirSync(directory,{mode:0o700});const clientDirectory=join(directory,'docker-client');mkdirSync(clientDirectory,{mode:0o700});
  // REVIEW-069 R-C: build 3/3 carries calibrated copied payload, so preflight-013 derives a FRESH complete expected
  // inventory from the current tree instead of refreshing the retired pinned-image byte bindings.
  const expected=inventoryInstalled(project,(()=>{const path=join(directory,'expected-current');mkdirSync(path,{mode:0o700});return path;})()),budgetPath=join(project,'.claude/s04-qualification/budget.json'),bookBytes=readPrivate(budgetPath),bookRef=exclusive(join(directory,'budget-before.bin'),bookBytes),book=JSON.parse(bookBytes);
  const ownedIdentities=book.containers.map((row,ordinal)=>{const path=join(row.directory,'container-intent.json'),bytes=readPrivate(path),ref={path,byteLength:bytes.length,sha256:sha(bytes)};return bindOriginalIdentity(bookRef,row,ordinal,ref,JSON.parse(bytes));});
  const source={};for(const name of readdirSync(join(project,'packages/controller/qualification')).filter(name=>name.endsWith('.mjs')).sort())source['packages/controller/qualification/'+name]=sha(readFileSync(join(project,'packages/controller/qualification',name)));
  // REVIEW-070 continuation: the fresh offline decoded cache (oci-actual-6C52-6c52d01f) was completed for derived
  // image 3/3 after the uncached attempt hit its 60s window; the archive inspection now reuses its decoded chunks.
  const parserCache={path:join(project,'.claude/s04-development/oci-actual-6C52-6c52d01f/image-final-index.json'),byteLength:13200,sha256:'1aebabc0f0a655f6ff9e5eaf2007ef34c30b21a6708f24bfc563691c454bcfe0'};
  const input={version:1,attempt:'delivery-preflight-031',directory,expectedInventory:expected.index,expectedBudgetSha256:bookRef.sha256,daemonAnchor:'new_current',clientDirectory,parserCache,inventoryRefresh:{index:expected.index,rehashedFiles:0,rehashedBytes:0,entries:expected.entries.length,totals:expected.totals,freshFromCurrentTree:true},ownedIdentities,source,sourceDigest:sha(canonical(source))};
  return exclusive(inputPath,input);
}
export async function executeCurrentPreflight(activation,bootstrap){
  const {requireNativePreflightActivation}=await import('./native-activation.mjs');requireNativePreflightActivation(activation);
  const {readPrivate,sha,canonical,monotonic,fail}=await import('./native-context.mjs'),{NativeLedger}=await import('./native-ledger.mjs');
  const {launcherBootstrapState,verifyPrivateInventory,finishDeliveryBootstrap}=await import('./native-preflight-launcher.mjs');
  const {runHeldPreparedImagePreflight}=await import('./native-image-inspector.mjs');
  const state=launcherBootstrapState(bootstrap),ledger=new NativeLedger(join(project,'.claude/s04-qualification/budget.json'));
  const time=ledger.beginHeldPreflightTime(activation,{phase:'initial',leaf:'image-preflight',directory},BigInt(state.startedMonotonicMs),bootstrap);
  let handedOff=false;
  try{
    const timing=ledger.preparePreflightTime(time),input=JSON.parse(readPrivate(inputPath));
    if(input.version!==1||input.attempt!=='delivery-preflight-031'||input.directory!==directory||input.expectedBudgetSha256!==timing.original.sha256||sha(canonical(input.source))!==input.sourceDigest)fail('QUALIFICATION_DELIVERY_BINDING');
    for(const [path,digest]of Object.entries(input.source)){if(!path.startsWith('packages/controller/qualification/')||sha(readFileSync(join(project,path)))!==digest||monotonic()>=BigInt(timing.deadlineMonotonicMs))fail('QUALIFICATION_DELIVERY_SOURCE_CHANGED');}
    await verifyPrivateInventory(input.expectedInventory,timing.deadlineMonotonicMs);
    handedOff=true;const result=await runHeldPreparedImagePreflight(activation,ledger,time,{directory,expectedInventory:input.expectedInventory,expectedBudgetSha256:input.expectedBudgetSha256,daemonAnchor:input.daemonAnchor,ownedIdentities:input.ownedIdentities,clientDirectory:input.clientDirectory,parserCache:input.parserCache});finishDeliveryBootstrap(bootstrap,result,directory);return result;
  }catch(error){if(!handedOff){const accounting=ledger.completeHeldPreflightTime(activation,time,{intent:state.attempt,output:null,error:null,failure:{message:error.message,stage:'before fixed Docker reads'},reads:[],endedMonotonicMs:String(monotonic())});finishDeliveryBootstrap(bootstrap,accounting,directory);}else if(error.accounting)finishDeliveryBootstrap(bootstrap,error.accounting,directory);throw error;}
}
if(process.argv[1]&&pathToFileURL(resolve(process.argv[1])).href===import.meta.url){
  if(resolve('.')!==project)throw new Error('QUALIFICATION_DELIVERY_CONTEXT');
  if(process.argv.length===3&&process.argv[2]==='--prepare')prepareCurrentPreflight().then(value=>process.stdout.write(JSON.stringify(value)+'\n'),error=>{process.stderr.write(JSON.stringify({error:error.message})+'\n');process.exitCode=1;});
  else if(process.argv.length===2){
    const launcher=await import('./native-preflight-launcher.mjs'),bootstrap=launcher.beginApprovedDeliveryBootstrap();
    const {runApprovedDeliveryPreflight}=await import('./native-activation.mjs');
    runApprovedDeliveryPreflight(bootstrap).then(value=>process.stdout.write(JSON.stringify(value)+'\n'),error=>{process.stderr.write(JSON.stringify({error:error.message})+'\n');process.exitCode=1;});
  }else throw new Error('QUALIFICATION_DELIVERY_ARGUMENT');
}
