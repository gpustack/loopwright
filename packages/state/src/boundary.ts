import { createHash } from 'node:crypto';
import { isAbsolute } from 'node:path';
import { validateDocument, identifyManifest, type Digest, type ArtifactRef } from '@loopwright/core';
import { fail } from './errors.js';
import type { CompatibilityBinding, ExactTotal, LocalRunIdentity, StatePolicy } from './types.js';

export const STATE_LIMITS = Object.freeze({ requests:1024, operations:2048, checkpoints:64, callBytes:65536,
  recordBytes:16384, checkpointBytes:65536, pageItems:100, pageBytes:131072, depth:32, nodes:8192,
  properties:128, collection:128, driftMs:1000, maxPages:65536 });
export type Json = null | boolean | number | string | Json[] | { [key:string]:Json };
export function record(input: unknown, keys: readonly string[], path=''): Record<string,unknown> {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) fail('INVALID_INPUT',path);
  const proto: unknown = Object.getPrototypeOf(input);
  if (proto !== Object.prototype && proto !== null) fail('INVALID_INPUT',path);
  const actual = Reflect.ownKeys(input);
  if (actual.length > STATE_LIMITS.properties) fail('LIMIT_EXCEEDED',path);
  if (actual.length !== keys.length || actual.some(key => typeof key !== 'string' || !keys.includes(key))) fail('INVALID_INPUT',path);
  const output: Record<string,unknown> = Object.create(null) as Record<string,unknown>;
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(input,key);
    if (!descriptor || !('value' in descriptor) || !descriptor.enumerable) fail('INVALID_INPUT',`${path}/${key}`);
    output[key] = descriptor.value;
  }
  return output;
}
export function text(input: unknown, path='', max=128): string {
  if (typeof input !== 'string' || input.length === 0 || input.length>max || /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(input)) fail('INVALID_INPUT',path);
  return input;
}
export function id(input:unknown,path=''):string {
  const value=text(input,path,64); if(!/^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/.test(value)) fail('INVALID_INPUT',path); return value;
}
export function integer(input:unknown,path='',min=0,max=Number.MAX_SAFE_INTEGER):number {
  if(typeof input!=='number'||!Number.isSafeInteger(input)||Object.is(input,-0)||input<min||input>max) fail('INVALID_INPUT',path);return input;
}
export function enumeration<const T extends string>(input:unknown, choices:readonly T[],path=''):T {
  if(typeof input!=='string'||!choices.includes(input as T)) fail('INVALID_INPUT',path);return input as T;
}
export function boolean(input:unknown,path=''):boolean {if(typeof input!=='boolean')fail('INVALID_INPUT',path);return input;}
export function array(input:unknown,path='',max:number=STATE_LIMITS.collection):readonly unknown[] {
  if(!Array.isArray(input))fail('INVALID_INPUT',path);if(input.length>max)fail('LIMIT_EXCEEDED',path);return input;
}
export function digest(input:unknown,path=''):Digest {
  const v=record(input,['algorithm','hex'],path);if(v.algorithm!=='sha256'||typeof v.hex!=='string'||!/^[0-9a-f]{64}$/.test(v.hex))fail('INVALID_INPUT',path);
  return {algorithm:'sha256',hex:v.hex};
}
export function artifact(input:unknown,path=''):ArtifactRef {
  const result=identifyManifest({apiVersion:'loopwright.dev/v1alpha1',kind:'ArtifactManifest',metadata:{id:'state-reference'},spec:{entries:[input]}});
  if(!result.ok)fail('INVALID_INPUT',path,result.errors);return result.value.manifest.spec.entries[0]!;
}
export function canonical(input: unknown):string {
  if(input===null||typeof input!=='object')return JSON.stringify(input);
  if(Array.isArray(input))return '['+input.map(canonical).join(',')+']';
  const value=input as Record<string,unknown>;return '{'+Object.keys(value).sort().map(key=>JSON.stringify(key)+':'+canonical(value[key])).join(',')+'}';
}
export function hash(kind:string,input:unknown):Digest {return {algorithm:'sha256',hex:createHash('sha256').update(`loopwright.dev/state/v1/${kind}\0`).update(canonical(input)).digest('hex')};}
export function equal(a:unknown,b:unknown):boolean {return canonical(a)===canonical(b);}
export function exact(n:bigint):ExactTotal {return {decimal:String(n),safeValue:n>=-BigInt(Number.MAX_SAFE_INTEGER)&&n<=BigInt(Number.MAX_SAFE_INTEGER)?Number(n):null};}
export function checkedAdd(a:number,b:number):number {if(b>Number.MAX_SAFE_INTEGER-a)fail('ARITHMETIC_OVERFLOW');return a+b;}
export function mono(input:unknown,path=''):string {if(typeof input!=='string'||!/^(0|[1-9][0-9]{0,19})$/.test(input))fail('INVALID_INPUT',path);return input;}
export function addMono(a:string,ms:number):string {const n=String(BigInt(a)+BigInt(ms));if(n.length>20)fail('ARITHMETIC_OVERFLOW');return n;}
export function freeze<T>(input:T):T {
  if(input!==null&&typeof input==='object'){for(const value of Object.values(input))freeze(value);Object.freeze(input);}return input;
}
/** Bound work before serialization; never call ordinary accessors or toJSON. */
export function snapshot(input:unknown, maxBytes:number=STATE_LIMITS.callBytes):Json {
  let nodes=0,bytes=0;const seen=new WeakSet<object>();
  function visit(value:unknown,depth:number):Json {
    if(++nodes>STATE_LIMITS.nodes||depth>STATE_LIMITS.depth)fail('LIMIT_EXCEEDED');
    if(value===null||typeof value==='boolean'||typeof value==='number'||typeof value==='string'){
      if(typeof value==='number')integer(value,'',-Number.MAX_SAFE_INTEGER);if(typeof value==='string')text(value||' ', '',Math.min(maxBytes,16384));
      bytes+=Buffer.byteLength(JSON.stringify(value));if(bytes>maxBytes)fail('LIMIT_EXCEEDED');return value;
    }
    if(typeof value!=='object'||seen.has(value))fail('INVALID_INPUT');seen.add(value);
    if(Array.isArray(value)){
      if(value.length>STATE_LIMITS.collection)fail('LIMIT_EXCEEDED');
      const descriptors=Reflect.ownKeys(value);if(descriptors.length!==value.length+1)fail('INVALID_INPUT');
      bytes+=2+value.length;const out:Json[]=[];
      for(let i=0;i<value.length;i++){const d=Object.getOwnPropertyDescriptor(value,String(i));if(!d||!('value'in d)||!d.enumerable)fail('INVALID_INPUT');out.push(visit(d.value,depth+1));}return out;
    }
    const proto:unknown=Object.getPrototypeOf(value);if(proto!==Object.prototype&&proto!==null)fail('INVALID_INPUT');
    const keys=Reflect.ownKeys(value);if(keys.length>STATE_LIMITS.properties)fail('LIMIT_EXCEEDED');
    const out:Record<string,Json>=Object.create(null) as Record<string,Json>;bytes+=2;
    for(const key of keys){if(typeof key!=='string')fail('INVALID_INPUT');const d=Object.getOwnPropertyDescriptor(value,key);if(!d||!('value'in d)||!d.enumerable)fail('INVALID_INPUT');bytes+=Buffer.byteLength(JSON.stringify(key))+2;if(bytes>maxBytes)fail('LIMIT_EXCEEDED');out[key]=visit(d.value,depth+1);}return out;
  }
  const out=visit(input,1);if(Buffer.byteLength(canonical(out))>maxBytes)fail('LIMIT_EXCEEDED');return out;
}
export function identity(input:unknown):LocalRunIdentity {
  const v=record(input,['directory','storeId','lock','policy','binding']);
  const directory=text(v.directory,'/directory',1024);if(!isAbsolute(directory))fail('INVALID_INPUT','/directory');
  const lock=validateDocument(v.lock,'TaskLock');if(!lock.ok)fail('INVALID_INPUT','/lock',lock.errors);
  const p=record(snapshot(v.policy),['version','leaseMs','cost'],'/policy');
  if(p.version!==1||p.cost!=='observe_only')fail('INVALID_INPUT','/policy');
  const policy:StatePolicy={version:1,leaseMs:integer(p.leaseMs,'/policy/leaseMs',1000,60000),cost:'observe_only'};
  const bindingInput=record(snapshot(v.binding),['coreApiVersion','hostVersion','adapters','resourceVersion','clockEpoch'],'/binding');
  if(bindingInput.coreApiVersion!=='loopwright.dev/v1alpha1')fail('BINDING_MISMATCH','/binding/coreApiVersion');
  const adapters=array(bindingInput.adapters,'/binding/adapters',64).map((entry,i)=>{const a=record(entry,['id','version']);return {id:text(a.id,`/binding/adapters/${i}/id`),version:text(a.version,`/binding/adapters/${i}/version`)};}).sort((a,b)=>a.id<b.id?-1:a.id>b.id?1:0);
  const required=[...new Set(lock.value.spec.contract.spec.roles.map(role=>role.adapter))].sort();
  if(!equal(adapters.map(a=>a.id),required))fail('BINDING_MISMATCH','/binding/adapters');
  const binding:CompatibilityBinding={coreApiVersion:'loopwright.dev/v1alpha1',hostVersion:text(bindingInput.hostVersion),adapters,resourceVersion:text(bindingInput.resourceVersion),clockEpoch:text(bindingInput.clockEpoch)};
  return {directory,storeId:id(v.storeId,'/storeId'),lock:lock.value,policy,binding};
}
export function identityBody(value:LocalRunIdentity):Omit<LocalRunIdentity,'directory'> {return {storeId:value.storeId,lock:value.lock,policy:value.policy,binding:value.binding};}
