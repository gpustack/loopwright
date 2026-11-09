/* global Buffer */
import { constants,openSync,closeSync,fstatSync,lstatSync,readSync,opendirSync,readdirSync,readlinkSync,realpathSync } from 'node:fs';
import { open as openAsync } from 'node:fs/promises';
import { join,resolve,posix } from 'node:path';
import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import { createGunzip } from 'node:zlib';
import { TextDecoder } from 'node:util';
import { canonical,sha,same,exclusive,privateDirectory,checkedRef,monotonic,fail } from './native-context.mjs';

export const imageLimits=Object.freeze({entries:65536,links:4096,path:4096,file:134217728,selected:1073741824,metadata:33554432,archive:2147483648,scratch:2147483648,expanded:4294967296,layer:1073741824,layers:256,members:200000,chunk:1048576,buffers:8388608,json:1048576,depth:64,indexDepth:4,shard:524288});
const decoder=new TextDecoder('utf-8',{fatal:true});
const need=(condition,code)=>{if(!condition)fail('QUALIFICATION_IMAGE_'+code);};
function utf8(bytes){try{return decoder.decode(bytes);}catch{fail('QUALIFICATION_IMAGE_UTF8');}}
function identity(stat){return [stat.dev,stat.ino,stat.uid,stat.gid,stat.mode,stat.nlink,stat.size,stat.mtimeNs,stat.ctimeNs].map(String).join(':');}
function regular(stat){return stat.isFile()&&!stat.isSymbolicLink();}
function pathName(value,directory=false){
  need(typeof value==='string'&&Buffer.byteLength(value)<=imageLimits.path&&!value.includes('\0')&&!value.includes('\\'),'PATH');
  if(directory&&(value==='.'||value==='./'))return '';
  const result=directory&&value.endsWith('/')?value.slice(0,-1):value;
  need(result!==''&&!result.startsWith('/')&&result.split('/').every(part=>part!==''&&part!=='.'&&part!=='..')&&posix.normalize(result)===result,'PATH');return result;
}
function linkName(path,target){
  need(typeof target==='string'&&target!==''&&Buffer.byteLength(target)<=imageLimits.path&&!target.startsWith('/')&&!target.includes('\0')&&!target.includes('\\'),'LINK');
  const destination=posix.normalize(posix.join(posix.dirname(path),target));need(destination!=='.'&&!destination.startsWith('../')&&destination!=='..'&&!destination.startsWith('/'),'LINK');return destination;
}
function copied(path){return path==='node_modules'||path.startsWith('node_modules/')||path==='package.json'||path==='package-lock.json'||['core','state','agent-pi'].some(name=>path==='packages/'+name||path.startsWith('packages/'+name+'/'));}
function selected(path){return path.startsWith('opt/loopwright/')&&copied(path.slice(15));}

/** Qualification-only exact pinned-base exception; never retains or executes this nonselected body. */
export function imageRegularFileLimit(path,layerSha256){return path==='usr/local/bin/node'&&layerSha256==='a8095a8cfac3173101d798f43eceff12c9261ea4b1e82ec40dbfeef67a667fd5'?150328456:imageLimits.file;}
export function assertImageRegularFileSize(path,layerSha256,size){need(Number.isSafeInteger(size)&&size>=0&&size<=imageRegularFileLimit(path,layerSha256),'FILE_LIMIT');assertSelectedImageFileSize(path,size);}
export function assertSelectedImageFileSize(path,size){need(Number.isSafeInteger(size)&&size>=0&&(!selected(path)||size<=imageLimits.file),'FILE_LIMIT');}

/** JSON grammar with decoded-key uniqueness and exact safe integer numbers. JSON.parse alone loses duplicates. */
export function uniqueImageJSON(bytes){
  need(bytes.length<=imageLimits.json,'JSON_LIMIT');const text=utf8(bytes);let at=0;
  const space=()=>{while(/[\t\n\r ]/.test(text[at]??'!'))at++;};
  function string(){
    const start=at++;let escaped=false;
    for(;at<text.length;at++){const char=text[at];if(!escaped&&char==='"'){at++;const value=JSON.parse(text.slice(start,at));need(!/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(value),'JSON_SURROGATE');return value;}if(!escaped&&char==='\\')escaped=true;else escaped=false;}
    fail('QUALIFICATION_IMAGE_JSON');
  }
  function value(depth){
    need(depth<=imageLimits.depth,'JSON_DEPTH');space();const char=text[at];
    if(char==='"')return string();
    if(char==='{'||char==='['){const object=char==='{',result=object?Object.create(null):[],keys=new Set();at++;space();if(text[at]===(object?'}':']')){at++;return result;}
      for(;;){space();if(object){need(text[at]==='"','JSON');const key=string();need(!keys.has(key),'JSON_DUPLICATE');keys.add(key);space();need(text[at++]===':','JSON');result[key]=value(depth+1);}else result.push(value(depth+1));space();if(text[at]===(object?'}':']')){at++;return result;}need(text[at++]===',','JSON');}
    }
    for(const [word,result] of [['true',true],['false',false],['null',null]])if(text.startsWith(word,at)){at+=word.length;return result;}
    const number=/^-?(?:0|[1-9][0-9]*)/.exec(text.slice(at));need(number&&number[0]!=='-0','JSON_NUMBER');at+=number[0].length;const result=Number(number[0]);need(Number.isSafeInteger(result),'JSON_NUMBER');return result;
  }
  const result=value(0);space();need(at===text.length,'JSON_TRAILING');return result;
}
function keys(value,allowed,required=[]){need(value&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).every(key=>allowed.includes(key))&&required.every(key=>Object.hasOwn(value,key)),'SCHEMA');}
function digest(value){need(/^sha256:[a-f0-9]{64}$/.test(value),'DIGEST');return value.slice(7);}
function safeInteger(value,max){need(Number.isSafeInteger(value)&&value>=0&&value<=max,'LIMIT');return value;}

/** Original installed bytes only. No execution, symlink traversal, extraction or native activation. */
export function inventoryInstalled(project,directory){
  privateDirectory(directory);project=resolve(project);need(realpathSync(project)===project,'INVENTORY_ROOT');const entries=[],sources=[],totals={entries:0,links:0,regularBytes:0,metadataBytes:0,entryMetadataBytes:0};
  function names(path){const directory=opendirSync(path,{encoding:'latin1',bufferSize:1}),names=[];let bytes=0;try{for(;;){const next=directory.readSync();if(!next)break;const name=utf8(Buffer.from(next.name,'latin1'));bytes+=Buffer.byteLength(name);need(names.length<imageLimits.entries&&bytes<=imageLimits.metadata,'INVENTORY_ENTRIES');names.push(name);}}finally{directory.closeSync();}return names.sort();}
  function accounted(value){totals.metadataBytes+=Buffer.byteLength(canonical(value));need(totals.metadataBytes<=imageLimits.metadata,'INVENTORY_METADATA');}
  function walk(relative){
    pathName(relative);const path=join(project,relative),before=lstatSync(path,{bigint:true});let entry;
    if(before.isSymbolicLink()){const target=utf8(readlinkSync(path,{encoding:'buffer'}));linkName(relative,target);entry={path:relative,kind:'symlink',mode:Number(before.mode&0o777n),target};totals.links++;need(totals.links<=imageLimits.links,'INVENTORY_LINKS');}
    else if(before.isDirectory())entry={path:relative,kind:'directory',mode:Number(before.mode&0o777n)};
    else{
      need(regular(before)&&before.size<=BigInt(imageLimits.file),'INVENTORY_FILE');totals.regularBytes+=Number(before.size);need(totals.regularBytes<=imageLimits.selected,'INVENTORY_BYTES');
      const fd=openSync(path,constants.O_RDONLY|constants.O_NOFOLLOW),hash=createHash('sha256'),buffer=Buffer.alloc(65536);let length=0;
      try{need(identity(fstatSync(fd,{bigint:true}))===identity(before),'INVENTORY_CHANGED');for(;;){const bytes=readSync(fd,buffer,0,buffer.length,null);if(!bytes)break;length+=bytes;need(length<=Number(before.size),'INVENTORY_CHANGED');hash.update(buffer.subarray(0,bytes));}need(length===Number(before.size)&&identity(fstatSync(fd,{bigint:true}))===identity(before),'INVENTORY_CHANGED');}
      finally{closeSync(fd);}
      entry={path:relative,kind:'file',mode:Number(before.mode&0o777n),byteLength:length,sha256:hash.digest('hex')};
    }
    totals.entries++;totals.entryMetadataBytes+=Buffer.byteLength(canonical(entry));accounted(entry);need(totals.entries<=imageLimits.entries,'INVENTORY_METADATA');entries.push(entry);const source={path,identity:identity(before)};accounted(source);sources.push(source);
    if(before.isDirectory()){
      const originalNames=names(path);
      for(const name of originalNames){need(name!=='.'&&name!=='..'&&!name.includes('/'),'PATH');walk(relative+'/'+name);}
      const afterNames=names(path);source.directoryEntries={count:originalNames.length,beforeSha256:sha(canonical(originalNames)),afterSha256:sha(canonical(afterNames))};accounted(source.directoryEntries);need(same(originalNames,afterNames),'INVENTORY_CHANGED');
    }
    need(identity(lstatSync(path,{bigint:true}))===identity(before),'INVENTORY_CHANGED');
  }
  walk('node_modules');
  for(const name of ['core','state','agent-pi']){walk('packages/'+name+'/package.json');walk('packages/'+name+'/dist');if(name==='agent-pi')walk('packages/agent-pi/qualification');}
  walk('package.json');walk('package-lock.json');
  // Builder creates these copied parent directories. Their actual source modes are retained explicitly.
  for(const name of ['core','state','agent-pi']){const path='packages/'+name,stat=lstatSync(join(project,path),{bigint:true});need(stat.isDirectory()&&!stat.isSymbolicLink(),'INVENTORY_DIRECTORY');const entry={path,kind:'directory',mode:Number(stat.mode&0o777n)},source={path:join(project,path),identity:identity(stat)};entries.push(entry);sources.push(source);totals.entries++;totals.entryMetadataBytes+=Buffer.byteLength(canonical(entry));accounted(entry);accounted(source);}
  need(totals.entries<=imageLimits.entries&&totals.metadataBytes<=imageLimits.metadata,'INVENTORY_METADATA');entries.sort((a,b)=>a.path<b.path?-1:a.path>b.path?1:0);
  const shards=[];let batch=[],size=2;
  for(const entry of entries){const bytes=Buffer.byteLength(canonical(entry))+1;if(size+bytes>imageLimits.shard&&batch.length){shards.push(exclusive(join(directory,'inventory-'+shards.length+'.json'),batch));batch=[];size=2;}need(bytes<imageLimits.shard,'INVENTORY_METADATA');batch.push(entry);size+=bytes;}
  if(batch.length)shards.push(exclusive(join(directory,'inventory-'+shards.length+'.json'),batch));
  for(const source of sources){source.afterIdentity=identity(lstatSync(source.path,{bigint:true}));accounted({afterIdentity:source.afterIdentity});need(source.afterIdentity===source.identity,'INVENTORY_CHANGED');}
  const sourceShards=[];let sourceBatch=[],sourceBytes=2;for(const source of sources){const length=Buffer.byteLength(canonical(source))+1;if(sourceBytes+length>imageLimits.shard&&sourceBatch.length){sourceShards.push(exclusive(join(directory,'inventory-source-'+sourceShards.length+'.json'),sourceBatch));sourceBatch=[];sourceBytes=2;}sourceBatch.push(source);sourceBytes+=length;}if(sourceBatch.length)sourceShards.push(exclusive(join(directory,'inventory-source-'+sourceShards.length+'.json'),sourceBatch));
  const index=exclusive(join(directory,'inventory-index.json'),{version:1,recipe:'runtime-image.mjs builder copy recipe',project,totals,shards,sourceShards,entriesDigest:sha(canonical(entries)),scope:'expected current installed bytes; image equality NOT_RUN'});
  return {index,entries,totals,sources};
}
export function readExpectedInventory(ref){
  const index=uniqueImageJSON(checkedRef(ref)),entries=[],seen=new Set();let bytes=0,regularBytes=0,links=0;
  need(index.version===1&&Array.isArray(index.shards)&&index.shards.length<=128&&index.totals?.entries<=imageLimits.entries,'INVENTORY_SCHEMA');
  for(const shard of index.shards){need(Number.isSafeInteger(shard.byteLength)&&shard.byteLength<=imageLimits.shard+1&&bytes+shard.byteLength<=imageLimits.metadata,'INVENTORY_METADATA');bytes+=shard.byteLength;const rows=uniqueImageJSON(checkedRef(shard));need(Array.isArray(rows)&&entries.length+rows.length<=imageLimits.entries,'INVENTORY_ENTRIES');
    for(const row of rows){pathName(row.path);need(copied(row.path)&&!seen.has(row.path)&&(!entries.length||entries.at(-1).path<row.path),'INVENTORY_PATH');seen.add(row.path);need(['directory','file','symlink'].includes(row.kind)&&Number.isSafeInteger(row.mode)&&row.mode>=0&&row.mode<=0o777,'INVENTORY_SCHEMA');
      if(row.kind==='file'){safeInteger(row.byteLength,imageLimits.file);need(/^[a-f0-9]{64}$/.test(row.sha256),'INVENTORY_DIGEST');regularBytes+=row.byteLength;need(regularBytes<=imageLimits.selected,'INVENTORY_BYTES');}
      if(row.kind==='symlink'){linkName(row.path,row.target);need(++links<=imageLimits.links,'INVENTORY_LINKS');}entries.push(row);
    }
  }
  need(sha(canonical(entries))===index.entriesDigest&&entries.length===index.totals.entries&&regularBytes===index.totals.regularBytes&&links===index.totals.links,'INVENTORY_DIGEST');return {index,entries};
}

/** Refresh source identities only; changed metadata requires the original expected bytes to still match. */
export function refreshInventorySourceBindings(ref,directory){
  privateDirectory(directory);const original=readExpectedInventory(ref),index=original.index,expected=new Map(original.entries.map(entry=>[join(index.project,entry.path),entry]));
  need(index.project===resolve('.')&&Array.isArray(index.sourceShards),'INVENTORY_ROOT');const sources=[];let rehashedFiles=0,rehashedBytes=0;
  for(const shard of index.sourceShards)for(const prior of uniqueImageJSON(checkedRef(shard))){
    const entry=expected.get(prior.path);need(entry&&prior.path.startsWith(index.project+'/'),'INVENTORY_PATH');const before=lstatSync(prior.path,{bigint:true});need(Number(before.mode&0o777n)===entry.mode,'INVENTORY_CHANGED');
    if(entry.kind==='directory'){
      need(before.isDirectory()&&!before.isSymbolicLink(),'INVENTORY_CHANGED');if(prior.directoryEntries){const names=readdirSync(prior.path).sort(),digest=sha(canonical(names));need(names.length===prior.directoryEntries.count&&digest===prior.directoryEntries.beforeSha256&&digest===prior.directoryEntries.afterSha256,'INVENTORY_CHANGED');}
    }else if(entry.kind==='symlink')need(before.isSymbolicLink()&&readlinkSync(prior.path)===entry.target,'INVENTORY_CHANGED');
    else{
      need(before.isFile()&&!before.isSymbolicLink()&&before.nlink===1n&&Number(before.size)===entry.byteLength&&before.size<=BigInt(imageLimits.file),'INVENTORY_CHANGED');
      if(identity(before)!==prior.identity){const file=openSync(prior.path,constants.O_RDONLY|constants.O_NOFOLLOW),hash=createHash('sha256'),buffer=Buffer.alloc(65536);let bytes=0;
        try{need(identity(fstatSync(file,{bigint:true}))===identity(before),'INVENTORY_CHANGED');for(;;){const n=readSync(file,buffer,0,buffer.length,null);if(!n)break;bytes+=n;need(bytes<=entry.byteLength,'INVENTORY_CHANGED');hash.update(buffer.subarray(0,n));}need(bytes===entry.byteLength&&hash.digest('hex')===entry.sha256&&identity(fstatSync(file,{bigint:true}))===identity(before),'INVENTORY_CHANGED');}finally{closeSync(file);}rehashedFiles++;rehashedBytes+=bytes;
      }
    }
    const current=identity(lstatSync(prior.path,{bigint:true}));need(current===identity(before),'INVENTORY_CHANGED');sources.push({...prior,identity:current,afterIdentity:current});
  }
  need(sources.length===original.entries.length,'INVENTORY_CHANGED');const sourceShards=[];let batch=[],bytes=2;
  for(const source of sources){const size=Buffer.byteLength(canonical(source))+1;need(size<=imageLimits.shard,'INVENTORY_METADATA');if(bytes+size>imageLimits.shard&&batch.length){sourceShards.push(exclusive(join(directory,'source-'+sourceShards.length+'.json'),batch));batch=[];bytes=2;}batch.push(source);bytes+=size;}
  if(batch.length)sourceShards.push(exclusive(join(directory,'source-'+sourceShards.length+'.json'),batch));
  const result=exclusive(join(directory,'inventory-index.json'),{...index,sourceShards,scope:'original expected image bytes; current identities revalidated, modified metadata rehashed without changing expected bytes'});
  return {index:result,rehashedFiles,rehashedBytes,entries:original.entries.length};
}

class Queue {
  constructor(iterable){this.iterator=iterable[Symbol.asyncIterator]();this.queue=[];this.bytes=0;this.ended=false;this.offset=0;}
  async fill(size){need(size<=imageLimits.chunk,'BUFFER');while(this.bytes<size&&!this.ended){const next=await this.iterator.next();if(next.done){this.ended=true;break;}need(next.value.length<=imageLimits.chunk&&this.bytes+next.value.length<=imageLimits.buffers-2*imageLimits.chunk,'BUFFER');this.queue.push(next.value);this.bytes+=next.value.length;}}
  async read(size){await this.fill(size);need(this.bytes>=size,'TAR_TRUNCATED');const result=Buffer.alloc(size);let at=0;while(at<size){const chunk=this.queue[0],length=Math.min(size-at,chunk.length);chunk.copy(result,at,0,length);at+=length;this.bytes-=length;if(length===chunk.length)this.queue.shift();else this.queue[0]=chunk.subarray(length);}this.offset+=size;return result;}
  async take(size,consume){while(size){const length=Math.min(size,65536);await consume(await this.read(length));size-=length;}}
  async zeroTail(){while(true){await this.fill(512);if(!this.bytes){need(this.ended,'TAR_TRUNCATED');return;}const bytes=await this.read(Math.min(this.bytes,65536));need(bytes.every(value=>value===0),'TAR_TRAILING');}}
}
function tarText(bytes){const zero=bytes.indexOf(0),part=zero<0?bytes:bytes.subarray(0,zero);if(zero>=0)need(bytes.subarray(zero).every(value=>value===0),'TAR_TEXT');return utf8(part);}
function octal(bytes){const text=utf8(bytes);need(/^[ 0]*[0-7]+[\0 ]*$/.test(text),'TAR_NUMBER');const value=Number.parseInt(text.trim().replace(/\0.*$/,''),8);need(Number.isSafeInteger(value)&&value>=0,'TAR_NUMBER');return value;}
function pax(bytes,global){
  const result=Object.create(null);let offset=0;
  while(offset<bytes.length){const end=bytes.indexOf(32,offset);need(end>offset,'PAX');const number=utf8(bytes.subarray(offset,end));need(/^[1-9][0-9]*$/.test(number),'PAX');const length=Number(number);need(Number.isSafeInteger(length)&&length<=65536&&length>end-offset+2&&offset+length<=bytes.length&&bytes[offset+length-1]===10,'PAX');const text=utf8(bytes.subarray(end+1,offset+length-1)),equal=text.indexOf('=');need(equal>0,'PAX');const key=text.slice(0,equal),value=text.slice(equal+1);need(['path','linkpath','size','mtime','uid','gid'].includes(key)&&!Object.hasOwn(result,key)&&(!global||['mtime','uid','gid'].includes(key)),'PAX_KEY');if(['size','uid','gid'].includes(key))need(/^(?:0|[1-9][0-9]*)$/.test(value)&&Number.isSafeInteger(Number(value)),'PAX_NUMBER');if(key==='mtime')need(/^(?:0|[1-9][0-9]*)(?:\.[0-9]{1,9})?$/.test(value),'PAX_NUMBER');result[key]=value;offset+=length;}
  return result;
}
async function tar(iterable,state,consume){
  const queue=new Queue(iterable),seen=new Set();let pending={},globals={},longName=null,longLink=null;
  for(;;){const header=await queue.read(512);if(header.every(value=>value===0)){need((await queue.read(512)).every(value=>value===0),'TAR_END');await queue.zeroTail();need(!Object.keys(pending).length&&longName===null&&longLink===null,'TAR_EXTENSION');return;}
    state.members++;need(state.members<=imageLimits.members,'MEMBERS');const checksum=octal(header.subarray(148,156));let sum=0;for(let i=0;i<512;i++)sum+=i>=148&&i<156?32:header[i];need(sum===checksum,'TAR_CHECKSUM');
    const magic=header.subarray(257,265);need(magic.equals(Buffer.concat([Buffer.from('ustar'),Buffer.from([0]),Buffer.from('00')]))||magic.equals(Buffer.from('ustar  \0')),'TAR_GRAMMAR');
    const rawName=tarText(header.subarray(0,100)),prefix=tarText(header.subarray(345,500)),type=String.fromCharCode(header[156]||48),baseSize=octal(header.subarray(124,136)),base={mode:octal(header.subarray(100,108)),uid:octal(header.subarray(108,116)),gid:octal(header.subarray(116,124))};
    octal(header.subarray(136,148));need(base.mode<=0o7777,'TAR_MODE');
    if(['x','g','L','K'].includes(type)){need(baseSize<=65536,'TAR_EXTENSION');const body=await queue.read(baseSize);await queue.read((512-baseSize%512)%512);if(type==='x'){need(!Object.keys(pending).length,'PAX_DUPLICATE');pending=pax(body,false);}else if(type==='g'){need(!Object.keys(globals).length,'PAX_DUPLICATE');globals=pax(body,true);}else{need(body.at(-1)===0&&body.length<=imageLimits.path+1,'TAR_EXTENSION');const text=utf8(body.subarray(0,-1));if(type==='L'){need(longName===null,'TAR_EXTENSION');longName=text;}else{need(longLink===null,'TAR_EXTENSION');longLink=text;}}continue;}
    need(['0','1','2','5'].includes(type),'TAR_TYPE');need(!(pending.path&&longName!==null)&&!(pending.linkpath&&longLink!==null),'TAR_AMBIGUOUS');
    const attributes={...globals,...pending},literal=attributes.path??longName??(prefix?prefix+'/'+rawName:rawName),path=pathName(literal,type==='5'),link=attributes.linkpath??longLink??tarText(header.subarray(157,257)),size=attributes.size===undefined?baseSize:Number(attributes.size);
    need(!seen.has(path),'TAR_DUPLICATE');seen.add(path);pending={};longName=null;longLink=null;
    const entry={path,literal,type,size,mode:base.mode&0o777,uid:attributes.uid===undefined?base.uid:Number(attributes.uid),gid:attributes.gid===undefined?base.gid:Number(attributes.gid),link,offset:queue.offset};
    need(type==='0'||size===0,'TAR_SIZE');await consume(entry,action=>queue.take(size,action));await queue.read((512-size%512)%512);
  }
}
function openSpool(ref,deadline){
  need(typeof ref.path==='string'&&Number.isSafeInteger(ref.byteLength)&&ref.byteLength>=0&&ref.byteLength<=imageLimits.archive&&/^[a-f0-9]{64}$/.test(ref.sha256),'SPOOL');
  need(deadline===null||typeof deadline==='string'&&/^[0-9]{1,32}$/.test(deadline),'DEADLINE');
  const time=()=>need(deadline===null||monotonic()<BigInt(deadline),'DEADLINE');time();
  const fd=openSync(ref.path,constants.O_RDONLY|constants.O_NOFOLLOW);
  try{const before=fstatSync(fd,{bigint:true});need(regular(before)&&before.size===BigInt(ref.byteLength)&&!(Number(before.mode)&0o077)&&identity(before)===identity(lstatSync(ref.path,{bigint:true})),'SPOOL');
    return {fd,before,time,readBytes:0,check(){time();need(identity(fstatSync(fd,{bigint:true}))===identity(before)&&identity(lstatSync(ref.path,{bigint:true}))===identity(before),'SPOOL_CHANGED');}};
  }catch(error){closeSync(fd);throw error;}
}
async function* range(spool,start,size,hash=null){const bufferSize=65536;for(let offset=0;offset<size;){spool.time();const length=Math.min(bufferSize,size-offset);need(spool.readBytes+length<=3*imageLimits.archive,'READ_LIMIT');spool.readBytes+=length;const buffer=Buffer.alloc(length),bytes=readSync(spool.fd,buffer,0,buffer.length,start+offset);need(bytes===buffer.length,'SPOOL_TRUNCATED');offset+=bytes;if(hash)hash.update(buffer);yield buffer;}}
function blobPath(value){return 'blobs/sha256/'+digest(value);}
function descriptor(value){keys(value,['mediaType','digest','size','platform','annotations'],['mediaType','digest','size']);digest(value.digest);safeInteger(value.size,imageLimits.archive);return value;}
function jsonMember(entries,path){const entry=entries.get(path);need(entry?.body&&entry.body.length<=imageLimits.json,'METADATA_MISSING');return uniqueImageJSON(entry.body);}
function layout(entries,expected){
  let oci=null,docker=null,pinnedDescriptor=false;const associatedAttestations=[];
  if(entries.has('index.json')){
    const marker=jsonMember(entries,'oci-layout');keys(marker,['imageLayoutVersion'],['imageLayoutVersion']);need(marker.imageLayoutVersion==='1.0.0','OCI_LAYOUT');let index=jsonMember(entries,'index.json');
    for(let depth=0;;depth++){
      keys(index,['schemaVersion','mediaType','manifests','annotations'],['schemaVersion','manifests']);need(index.schemaVersion===2&&Array.isArray(index.manifests)&&index.manifests.length>=1&&index.manifests.length<=2&&depth<imageLimits.indexDepth,'OCI_INDEX');
      const descriptors=index.manifests.map(descriptor);let desc=descriptors[0];
      if(descriptors.length===2){
        const selected=descriptors.filter(row=>row.platform?.os==='linux'&&row.platform.architecture==='arm64');need(selected.length===1,'OCI_PLATFORM_AMBIGUOUS');desc=selected[0];
        const side=descriptors.find(row=>row!==desc);need(side.platform?.os==='unknown'&&side.platform.architecture==='unknown'&&side.mediaType==='application/vnd.oci.image.manifest.v1+json','OCI_SIDECAR');
        keys(side.annotations,['vnd.docker.reference.digest','vnd.docker.reference.type'],['vnd.docker.reference.digest','vnd.docker.reference.type']);need(side.annotations['vnd.docker.reference.digest']===desc.digest&&side.annotations['vnd.docker.reference.type']==='attestation-manifest','OCI_SIDECAR');
        const saved=entries.get(blobPath(side.digest));need(saved&&saved.size===side.size&&saved.sha256===digest(side.digest),'DESCRIPTOR');
        const att=jsonMember(entries,blobPath(side.digest));keys(att,['schemaVersion','mediaType','artifactType','config','layers','subject'],['schemaVersion','mediaType','artifactType','config','layers','subject']);
        need(att.schemaVersion===2&&att.mediaType===side.mediaType&&att.artifactType==='application/vnd.docker.attestation.manifest.v1+json'&&same(descriptor(att.subject),{mediaType:desc.mediaType,digest:desc.digest,size:desc.size}),'OCI_SIDECAR');
        keys(att.config,['mediaType','digest','size','data'],['mediaType','digest','size','data']);need(att.config.mediaType==='application/vnd.oci.empty.v1+json'&&att.config.digest==='sha256:'+sha('{}')&&att.config.size===2&&att.config.data==='e30=','OCI_SIDECAR');
        const empty=entries.get(blobPath(att.config.digest));need(empty&&empty.size===2&&empty.sha256===digest(att.config.digest),'DESCRIPTOR');need(Array.isArray(att.layers)&&att.layers.length===1,'OCI_SIDECAR');
        const proof=descriptor(att.layers[0]),proofEntry=entries.get(blobPath(proof.digest));need(proof.mediaType==='application/vnd.in-toto+json'&&proofEntry&&proofEntry.size===proof.size&&proofEntry.sha256===digest(proof.digest),'DESCRIPTOR');
        keys(proof.annotations,['in-toto.io/predicate-type'],['in-toto.io/predicate-type']);need(proof.annotations['in-toto.io/predicate-type']==='https://slsa.dev/provenance/v1','OCI_SIDECAR');
        associatedAttestations.push({descriptor:side,subject:att.subject,scope:'associated opaque metadata only; provenance NOT_VERIFIED'});
      }
      const record=entries.get(blobPath(desc.digest));need(record&&record.size===desc.size&&record.sha256===digest(desc.digest),'DESCRIPTOR');if(desc.digest===expected.image)pinnedDescriptor=true;
      if(desc.platform)need(desc.platform.os==='linux'&&desc.platform.architecture==='arm64'&&(!desc.platform.variant||desc.platform.variant==='v8'),'PLATFORM');
      const body=jsonMember(entries,blobPath(desc.digest));if(['application/vnd.oci.image.index.v1+json','application/vnd.docker.distribution.manifest.list.v2+json'].includes(desc.mediaType)){index=body;continue;}
      need(['application/vnd.oci.image.manifest.v1+json','application/vnd.docker.distribution.manifest.v2+json'].includes(desc.mediaType),'MEDIA');keys(body,['schemaVersion','mediaType','config','layers','annotations'],['schemaVersion','config','layers']);need(body.schemaVersion===2&&Array.isArray(body.layers),'OCI_MANIFEST');const config=descriptor(body.config);need(['application/vnd.oci.image.config.v1+json','application/vnd.docker.container.image.v1+json'].includes(config.mediaType),'MEDIA');
      oci={config:blobPath(config.digest),configDescriptor:config,layers:body.layers.map(row=>({path:blobPath(descriptor(row).digest),descriptor:row})),manifest:desc};break;
    }
  }
  if(entries.has('manifest.json')){
    const manifest=jsonMember(entries,'manifest.json');need(Array.isArray(manifest)&&manifest.length===1,'DOCKER_MANIFEST');const row=manifest[0];keys(row,['Config','RepoTags','Layers'],['Config','Layers']);need(typeof row.Config==='string'&&Array.isArray(row.Layers)&&(row.RepoTags===null||row.RepoTags===undefined||Array.isArray(row.RepoTags)&&row.RepoTags.every(value=>typeof value==='string')),'DOCKER_MANIFEST');pathName(row.Config);need(/^(?:[a-f0-9]{64}\.json|blobs\/sha256\/[a-f0-9]{64})$/.test(row.Config),'CONFIG_PATH');docker={config:row.Config,layers:row.Layers.map(path=>({path:pathName(path)}))};
  }
  need(oci||docker,'LAYOUT');if(oci&&docker)need(oci.config===docker.config&&same(oci.layers.map(row=>row.path),docker.layers.map(row=>row.path)),'LAYOUT_AMBIGUOUS');const chosen=oci??docker,configEntry=entries.get(chosen.config);need(configEntry&&(configEntry.sha256===digest(expected.image)||pinnedDescriptor),'CONFIG_ID');
  if(chosen.configDescriptor)need(chosen.configDescriptor.size===configEntry.size&&digest(chosen.configDescriptor.digest)===configEntry.sha256,'DESCRIPTOR');
  const config=jsonMember(entries,chosen.config);need(config.os==='linux'&&config.architecture==='arm64'&&config.rootfs?.type==='layers'&&Array.isArray(config.rootfs.diff_ids)&&same(config.rootfs.diff_ids,expected.diffIds)&&chosen.layers.length===expected.diffIds.length&&chosen.layers.length<=imageLimits.layers,'ROOTFS');
  need(config.config?.User==='1000:1000'&&same(config.config.Entrypoint,['node'])&&config.config.WorkingDir==='/opt/loopwright'&&config.config.Env?.includes('HOME=/tmp/home')&&config.config.Env?.includes('PI_OFFLINE=1'),'PROFILE');return {...chosen,config,pinnedImage:expected.image,pinnedIdentity:configEntry.sha256===digest(expected.image)?'config':'descriptor',associatedAttestations,format:oci?(docker?'oci+docker':'oci'):'docker'};
}

/** No extraction. Exact input/descriptor/diffID bytes and complete final selected payload; data only. */
export async function inspectImageArchive(ref,expected,directory,deadline=null,cacheIndexRef=null){
  privateDirectory(directory);digest(expected.image);need(Array.isArray(expected.diffIds)&&expected.diffIds.length<=imageLimits.layers,'ROOTFS');for(const id of expected.diffIds)digest(id);
  const spool=openSpool(ref,deadline),state={members:0,links:0,expanded:0,metadata:0,jsonBytes:0,scratch:ref.byteLength,selectedBytes:0,chunkBytes:0,localHardlinkPasses:0,reusedChunkBytes:0,reusedChunks:0},entries=new Map(),chunks=new Map(),filesystem=new Map(),layers=[],report={version:1,scope:'archive data only; no native proof',archive:ref,state,layers,completed:false};
  function metadata(value){spool.time();state.metadata+=Buffer.byteLength(canonical(value));need(state.metadata+state.jsonBytes<=imageLimits.metadata,'METADATA_LIMIT');}
  const reportReserve=3*imageLimits.metadata+imageLimits.json;
  const cachedChunks=new Map();
  if(cacheIndexRef){
    const cacheJSON=ref=>{need(ref.byteLength<=imageLimits.json,'CACHE_IDENTITY');state.jsonBytes+=ref.byteLength;need(state.metadata+state.jsonBytes<=imageLimits.metadata,'METADATA_LIMIT');return uniqueImageJSON(checkedRef(ref));};
    const cached=cacheJSON(cacheIndexRef);need(cached.version===1&&cached.completed===true&&cached.layout?.pinnedImage===expected.image&&Array.isArray(cached.chunks)&&cached.chunks.length<=128,'CACHE_IDENTITY');
    const config=cacheJSON(cached.layout.config);need(same(config.rootfs?.diff_ids,expected.diffIds),'CACHE_IDENTITY');
    const cacheDirectory=resolve(cacheIndexRef.path,'..');
    let cachedBytes=0;for(const shard of cached.chunks)for(const chunk of cacheJSON(shard)){need(chunk.path===join(cacheDirectory,'image-chunk-'+chunk.sha256+'.bin')&&Number.isSafeInteger(chunk.byteLength)&&chunk.byteLength<=65536&&!cachedChunks.has(chunk.sha256)&&cachedChunks.size<imageLimits.entries&&(cachedBytes+=chunk.byteLength)<=imageLimits.selected,'CACHE_IDENTITY');cachedChunks.set(chunk.sha256,chunk);}
  }
  let pendingWrites=[],pendingBytes=0,writeFailure=null;
  async function flushChunks(){
    if(!pendingWrites.length)return;const writes=pendingWrites;pendingWrites=[];await Promise.all(writes);pendingBytes=0;
    const parent=await openAsync(directory,constants.O_RDONLY|constants.O_NOFOLLOW);try{await parent.sync();}finally{await parent.close();}
    if(writeFailure)throw writeFailure;spool.time();
  }
  async function retain(bytes){
    const key=sha(bytes);if(chunks.has(key))return chunks.get(key);
    if(pendingBytes+bytes.length>imageLimits.chunk||pendingWrites.length>=128)await flushChunks();
    need(bytes.length<=imageLimits.chunk&&state.scratch+bytes.length+reportReserve<=imageLimits.scratch&&state.chunkBytes+bytes.length<=imageLimits.selected,'SCRATCH');
    state.scratch+=bytes.length;state.chunkBytes+=bytes.length;
    const cached=cachedChunks.get(key);
    if(cached){need(cached.byteLength===bytes.length&&checkedRef(cached).equals(bytes),'CACHE_IDENTITY');state.reusedChunkBytes+=bytes.length;state.reusedChunks++;chunks.set(key,cached);return cached;}
    const body=Buffer.from(bytes),chunk={path:join(directory,'image-chunk-'+key+'.bin'),byteLength:body.length,sha256:key};chunks.set(key,chunk);pendingBytes+=body.length;
    // <=1MiB and128 concurrent original file writes; every file and the parent are synced before completion.
    const written=(async()=>{const file=await openAsync(chunk.path,constants.O_CREAT|constants.O_EXCL|constants.O_WRONLY|constants.O_NOFOLLOW,0o600);try{await file.writeFile(body);await file.sync();}finally{await file.close();}})().catch(error=>{writeFailure??=error;});
    pendingWrites.push(written);return chunk;
  }
  function save(name,value){const bytes=Buffer.from(canonical(value)+'\n');need(state.scratch+bytes.length<=imageLimits.scratch,'SCRATCH');state.scratch+=bytes.length;return exclusive(join(directory,name),bytes);}
  function rows(prefix,values){const shards=[];let batch=[],size=2;for(const value of values){const bytes=Buffer.byteLength(canonical(value))+1;need(bytes<=imageLimits.shard,'REPORT_RECORD');if(size+bytes>imageLimits.shard&&batch.length){shards.push(save(prefix+'-'+shards.length+'.json',batch));batch=[];size=2;}batch.push(value);size+=bytes;}if(batch.length)shards.push(save(prefix+'-'+shards.length+'.json',batch));return shards;}
  function saveReport(partial){state.spoolReadBytes=spool.readBytes;const prefix=partial?'image-partial':'image-final',layerRefs=rows(prefix+'-layers',layers),payloadRefs=rows(prefix+'-payload',partial?report.partialPayload:report.payload),chunkRefs=rows(prefix+'-chunks',[...chunks.values()]);return save(prefix+'-index.json',{version:1,scope:report.scope,archive:ref,state:{...state},scratchCounterExcludesThisIndex:true,completed:report.completed,error:report.error??null,layout:report.layout??null,layers:layerRefs,payload:payloadRefs,chunks:chunkRefs});}
  try{
    need(ref.byteLength+reportReserve<=imageLimits.scratch,'SCRATCH');
    const originalHash=createHash('sha256');await tar(range(spool,0,ref.byteLength,originalHash),state,async(entry,take)=>{
      need(entry.type==='0'||entry.type==='5','ARCHIVE_TYPE');const hash=createHash('sha256'),parts=[];need(entry.size<=imageLimits.archive,'ARCHIVE_LIMIT');if(entry.size<=imageLimits.json){state.jsonBytes+=entry.size;need(state.metadata+state.jsonBytes<=imageLimits.metadata,'METADATA_LIMIT');}await take(bytes=>{hash.update(bytes);if(entry.size<=imageLimits.json)parts.push(bytes);});const value={...entry,sha256:hash.digest('hex'),body:entry.size<=imageLimits.json?Buffer.concat(parts):null};metadata({...entry,sha256:value.sha256});entries.set(entry.path,value);
    });need(originalHash.digest('hex')===ref.sha256,'ARCHIVE_DIGEST');spool.check();const selectedLayout=layout(entries,expected);report.layout={format:selectedLayout.format,pinnedImage:selectedLayout.pinnedImage,pinnedIdentity:selectedLayout.pinnedIdentity,manifestDescriptor:selectedLayout.manifest??null,configDescriptor:selectedLayout.configDescriptor??null,associatedAttestations:selectedLayout.associatedAttestations,config:save('image-config-original.json',selectedLayout.config),orderedDescriptors:save('image-layer-descriptors.json',selectedLayout.layers)};
    for(let ordinal=0;ordinal<selectedLayout.layers.length;ordinal++){
      const definition=selectedLayout.layers[ordinal],entry=entries.get(definition.path);need(entry?.type==='0'&&entry.size<=imageLimits.layer,'LAYER');if(definition.descriptor)need(entry.size===definition.descriptor.size&&entry.sha256===digest(definition.descriptor.digest),'DESCRIPTOR');
      const magic=Buffer.alloc(2);need(readSync(spool.fd,magic,0,2,entry.offset)===2,'LAYER');const compressed=magic[0]===31&&magic[1]===139;
      if(definition.descriptor){const media=definition.descriptor.mediaType;need(['application/vnd.oci.image.layer.v1.tar','application/vnd.oci.image.layer.v1.tar+gzip','application/vnd.docker.image.rootfs.diff.tar','application/vnd.docker.image.rootfs.diff.tar.gzip'].includes(media)&&compressed===media.endsWith('gzip'),'COMPRESSION');}
      const hash=createHash('sha256'),additions=new Map(),removals=[],opaque=[];let expanded=0;
      const input=Readable.from(range(spool,entry.offset,entry.size)),gunzip=compressed?createGunzip({chunkSize:65536}):null,stream=gunzip?input.pipe(gunzip):input;let streamError=null;
      input.on('error',error=>{streamError=error;if(gunzip)gunzip.destroy(error);});
      async function* uncompressed(){for await(const body of stream){need(body.length<=imageLimits.chunk&&state.expanded+body.length<=imageLimits.expanded&&expanded+body.length<=imageLimits.layer,'EXPANDED');state.expanded+=body.length;expanded+=body.length;hash.update(body);yield body;}}
      try{await tar(uncompressed(),state,async(file,take)=>{
        const path=file.path,base=posix.basename(path),parent=posix.dirname(path);let value;
        for(let ancestor=parent;ancestor!=='.';ancestor=posix.dirname(ancestor)){const node=additions.get(ancestor)??filesystem.get(ancestor);need(!node||node.kind==='directory','PARENT_LINK');}
        if(base.startsWith('.wh.')){need(file.type==='0'&&file.size===0,'WHITEOUT');metadata({kind:'whiteout',path,literal:file.literal,ordinal});if(base==='.wh..wh..opq')opaque.push(parent);else{const name=base.slice(4);need(name&&name!=='.'&&name!=='..','WHITEOUT');removals.push(parent==='.'?name:parent+'/'+name);}await take(()=>{});return;}
        const common={path,mode:file.mode,uid:file.uid,gid:file.gid,origin:{ordinal,literal:file.literal,layer:definition.path}};
        if(file.type==='0'){
          assertImageRegularFileSize(path,entry.sha256,file.size);const bodyHash=createHash('sha256'),refs=[];if(selected(path)){state.selectedBytes+=file.size;need(state.selectedBytes<=imageLimits.selected,'SELECTED_LIMIT');}
          await take(async bytes=>{bodyHash.update(bytes);if(selected(path))refs.push(await retain(bytes));});value={...common,kind:'file',byteLength:file.size,sha256:bodyHash.digest('hex'),chunks:refs,restore:{ordinal,path}};
        }else if(file.type==='5')value={...common,kind:'directory'};
        else if(file.type==='2'){need(++state.links<=imageLimits.links,'LINK_LIMIT');if(!selected(path)&&file.link.startsWith('/'))need(Buffer.byteLength(file.link)<=imageLimits.path&&!file.link.includes('\0')&&!file.link.includes('\\')&&file.link.split('/').slice(1).every(part=>part!==''&&part!=='.'&&part!=='..'),'LINK');else linkName(path,file.link);value={...common,kind:'symlink',target:file.link};}
        else{need(++state.links<=imageLimits.links,'LINK_LIMIT');const target=pathName(file.link),source=additions.get(target)??filesystem.get(target);need(source?.kind==='file','HARDLINK');assertSelectedImageFileSize(path,source.byteLength);if(selected(path)){state.selectedBytes+=source.byteLength;need(state.selectedBytes<=imageLimits.selected,'SELECTED_LIMIT');}value={...common,kind:'file',byteLength:source.byteLength,sha256:source.sha256,chunks:source.chunks,restore:source.restore,lineage:{path:target,origin:source.origin}};}
        metadata(value);additions.set(path,value);
      });if(streamError)throw streamError;if(gunzip)need(gunzip.bytesWritten===entry.size,'GZIP_TRAILING');}
      finally{stream.destroy();input.destroy();if(gunzip)gunzip.destroy();}
      need(hash.digest('hex')===digest(expected.diffIds[ordinal]),'DIFF_ID');
      for(const path of [...filesystem.keys()])if(removals.some(target=>{spool.time();return path===target||path.startsWith(target+'/');})||opaque.some(target=>{spool.time();return target==='.'?path!=='':path.startsWith(target+'/');}))filesystem.delete(path);
      for(const [path,value] of additions){spool.time();const previous=filesystem.get(path);if(previous&&previous.kind!=='directory'||value.kind!=='directory')for(const old of [...filesystem.keys()]){spool.time();if(old.startsWith(path+'/'))filesystem.delete(old);}filesystem.set(path,value);}
      layers.push({ordinal,path:definition.path,storedSha256:entry.sha256,storedBytes:entry.size,diffId:expected.diffIds[ordinal],expanded,removals:rows('image-layer-'+ordinal+'-removals',removals),opaque:rows('image-layer-'+ordinal+'-opaque',opaque),members:additions.size});spool.check();
    }
    const deferred=new Map();
    for(const row of filesystem.values())if(selected(row.path)&&row.kind==='file'&&row.byteLength&&!row.chunks.length){assertSelectedImageFileSize(row.path,row.byteLength);need(row.restore,'HARDLINK_LINEAGE');const key=canonical(row.restore);if(!deferred.has(key))deferred.set(key,[]);deferred.get(key).push(row);}
    if(deferred.size){
      state.localHardlinkPasses=1;
      // Exactly one additional local round, only original layers needed for already-materialized hardlink lineage.
      for(let ordinal=0;ordinal<selectedLayout.layers.length;ordinal++){
        if(![...deferred.keys()].some(key=>JSON.parse(key).ordinal===ordinal))continue;
        const definition=selectedLayout.layers[ordinal],entry=entries.get(definition.path),first=Buffer.alloc(2);readSync(spool.fd,first,0,2,entry.offset);const compressed=first[0]===31&&first[1]===139,input=Readable.from(range(spool,entry.offset,entry.size)),gunzip=compressed?createGunzip({chunkSize:65536}):null,stream=gunzip?input.pipe(gunzip):input,hash=createHash('sha256');let expanded=0;
        input.on('error',error=>{if(gunzip)gunzip.destroy(error);});
        async function* body(){for await(const bytes of stream){need(bytes.length<=imageLimits.chunk&&state.expanded+bytes.length<=imageLimits.expanded&&expanded+bytes.length<=imageLimits.layer,'EXPANDED');state.expanded+=bytes.length;expanded+=bytes.length;hash.update(bytes);yield bytes;}}
        try{await tar(body(),state,async(file,take)=>{const key=canonical({ordinal,path:file.path}),targets=deferred.get(key);if(!targets){await take(()=>{});return;}need(file.type==='0'&&targets.every(target=>target.byteLength===file.size),'HARDLINK_LINEAGE');const chunks=[],hash=createHash('sha256');await take(async bytes=>{hash.update(bytes);chunks.push(await retain(bytes));});const digest=hash.digest('hex');need(targets.every(target=>target.sha256===digest),'HARDLINK_LINEAGE');for(const target of targets){target.chunks=chunks;target.restoredFromOriginal=true;}deferred.delete(key);});if(gunzip)need(gunzip.bytesWritten===entry.size,'GZIP_TRAILING');need(hash.digest('hex')===digest(expected.diffIds[ordinal]),'DIFF_ID');}
        finally{stream.destroy();input.destroy();if(gunzip)gunzip.destroy();}spool.check();
      }
      need(deferred.size===0,'HARDLINK_LINEAGE');
    }
    const payload=[...filesystem.values()].filter(row=>selected(row.path)).map(row=>({...row,path:row.path.slice(15)})).sort((a,b)=>a.path<b.path?-1:a.path>b.path?1:0);need(payload.length<=imageLimits.entries,'ENTRIES');await flushChunks();report.payload=payload;report.chunks=[...chunks.values()];report.completed=true;report.result=saveReport(false);return report;
  }catch(error){await Promise.allSettled(pendingWrites);report.completed=false;report.error=error.message;report.chunks=[...chunks.values()];report.partialPayload=[...filesystem.values()].filter(row=>selected(row.path));report.partial=saveReport(true);error.observation={report:report.partial,state:{...state}};throw error;}
  finally{await Promise.allSettled(pendingWrites);closeSync(spool.fd);}
}
export function compareImagePayload(actual,expected){
  need(Array.isArray(actual)&&Array.isArray(expected)&&actual.length===expected.length,'PAYLOAD_COUNT');
  for(let index=0;index<expected.length;index++){const left=actual[index],right=expected[index];const mode=right.kind==='symlink'?left.mode===0o777:left.mode===right.mode;need(left.path===right.path&&left.kind===right.kind&&mode&&left.uid===0&&left.gid===0,'PAYLOAD_IDENTITY');if(right.kind==='file')need(left.byteLength===right.byteLength&&left.sha256===right.sha256,'PAYLOAD_BYTES');if(right.kind==='symlink')need(left.target===right.target,'PAYLOAD_LINK');}
  return {scope:'complete supplied archive/current inventory data comparison; Linux symbolic-link mode0777, original host mode retained in source inventory',entries:expected.length,digest:sha(canonical(expected))};
}
