import { canonical, checkedRef, closed, sha, same, monotonic, privateDirectory, exclusive, fail } from './native-context.mjs';
import { nativeCases, fixtureReply } from './native-cases.mjs';
import { requireNativeActivation } from './native-activation.mjs';
import { join } from 'node:path';

export function leafClock(startedMonotonicMs,availableSeconds=120) {
  if (!/^[0-9]{1,32}$/.test(startedMonotonicMs)) fail('QUALIFICATION_LEAF_CLOCK');
  if(!Number.isFinite(availableSeconds)||availableSeconds<=20||availableSeconds>120)fail('QUALIFICATION_LEAF_CLOCK');
  const start=BigInt(startedMonotonicMs),duration=BigInt(Math.floor(availableSeconds*1000));
  return Object.freeze({startedMonotonicMs,workCutoff:String(start+duration-20000n),hardCutoff:String(start+duration)});
}
export function assertLeafClock(clock) {
  if (!same(clock,leafClock(clock.startedMonotonicMs,Number(BigInt(clock.hardCutoff)-BigInt(clock.startedMonotonicMs))/1000)) || monotonic()>=BigInt(clock.workCutoff)) fail('QUALIFICATION_LEAF_EXPIRED');
}
/** Data preparation only: neither a validated recipe nor its hash is an activation or an allowance. */
export function prepareBridgeLeaf(input) {
  closed(input,['version','mode','leaf','qualification','sourceDigest','runtimeDigest','image','executable','socket','clientDirectory','clock','caps','cases']);
  if(input.version!==2||!['offline','native'].includes(input.mode)||!Object.hasOwn(nativeCases,input.leaf))fail('QUALIFICATION_RECIPE_VERSION');
  closed(input.qualification,['runId','taskId','dispatchId']);
  if(Object.values(input.qualification).some(value=>typeof value!=='string'||!/^[a-z0-9._-]{1,128}$/i.test(value)))fail('QUALIFICATION_RECIPE_ID');
  for(const value of [input.sourceDigest,input.runtimeDigest])if(!/^[a-f0-9]{64}$/.test(value))fail('QUALIFICATION_RECIPE_SOURCE');
  if(!/^sha256:[a-f0-9]{64}$/.test(input.image)||[input.executable,input.socket,input.clientDirectory].some(value=>typeof value!=='string'||!value.startsWith('/')))fail('QUALIFICATION_RECIPE_RUNTIME');
  if(![{provider:64,mcp:0,containers:64},{provider:32,mcp:0,containers:16},{provider:12,mcp:0,containers:10},{provider:2,mcp:0,containers:1}].some(caps=>same(input.caps,caps))||!same(input.clock,leafClock(input.clock.startedMonotonicMs,Number(BigInt(input.clock.hardCutoff)-BigInt(input.clock.startedMonotonicMs))/1000)))fail('QUALIFICATION_RECIPE_LIMIT');
  if(!Array.isArray(input.cases)||!same(input.cases.map(item=>item.id),nativeCases[input.leaf]))fail('QUALIFICATION_RECIPE_CASES');
  const runs=new Set();
  for(const item of input.cases){
    closed(item,['id','runId','repository','runRoot','revision','static','config','registry','script','sse','initial']);
    if(!/^[a-z0-9._-]{1,128}$/.test(item.runId)||runs.has(item.runId)||typeof item.static!=='boolean'||!item.revision||[item.repository,item.runRoot].some(value=>typeof value!=='string'||!value.startsWith('/')))fail('QUALIFICATION_RECIPE_CASE');
    runs.add(item.runId);
    const config=JSON.parse(checkedRef(item.config)),registry=JSON.parse(checkedRef(item.registry)),script=JSON.parse(checkedRef(item.script));checkedRef(item.initial);
    if(config.spec.task.metadata.id!=='native-'+item.id||config.spec.task.spec.target.sourceRevision!==item.revision||config.spec.task.spec.target.baseRevision!==item.revision
      ||config.spec.registry.digest.hex!==item.registry.sha256||config.spec.registry.id!==registry.metadata.id||!Array.isArray(script)||script.length<1||script.length>16)fail('QUALIFICATION_RECIPE_BINDING');
    if(input.mode==='native'&&item.static)fail('QUALIFICATION_STATIC_NATIVE');
    const responses=JSON.parse(checkedRef(item.sse));if(!Array.isArray(responses)||responses.length!==script.length)fail('QUALIFICATION_RECIPE_SSE');
    for(let index=0;index<script.length;index++)if(sha(checkedRef(responses[index]))!==sha(fixtureReply(script[index],index+1)))fail('QUALIFICATION_RECIPE_SSE');
  }
  return JSON.parse(canonical(input));
}
export function sealBridgeLeaf(directory,input){privateDirectory(directory);const value=prepareBridgeLeaf(input);return {value,ref:exclusive(join(directory,'bridge-recipe.json'),value),digest:sha(canonical(value))};}
export function readBridgeLeaf(ref){return prepareBridgeLeaf(JSON.parse(checkedRef(ref)));}
export function reservationContext(recipe){return {...recipe.qualification,sourceDigest:recipe.sourceDigest,runtimeDigest:recipe.runtimeDigest,image:recipe.image,leafCutoff:recipe.clock.workCutoff,qualificationVersion:2,recipeDigest:sha(canonical(recipe))};}
/** The native parent body loads only behind the original live parent activation. */
export async function runHeldNativeLeaf(activation,input){
  requireNativeActivation(activation);
  const {runPreparedNativeParent}=await import('./native-parent.mjs');
  return runPreparedNativeParent(activation,input);
}
