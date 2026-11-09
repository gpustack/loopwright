/* global Buffer */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { gzipSync } from 'node:zlib';
import { canonical, exclusive, sha, checkedRef } from './native-context.mjs';
import { imageRegularFileLimit, assertImageRegularFileSize, assertSelectedImageFileSize, compareImagePayload, inspectImageArchive } from './native-image.mjs';
function tar(rows){return Buffer.concat([...rows.flatMap(row=>{const bytes=Buffer.from(row.body??''),header=Buffer.alloc(512),number=(at,length,value)=>header.write(value.toString(8).padStart(length-1,'0')+'\0',at,length,'ascii');header.write(row.path);number(100,8,row.type==='5'?0o755:0o644);number(108,8,0);number(116,8,0);number(124,12,bytes.length);number(136,12,0);header.fill(32,148,156);header[156]=(row.type??'0').charCodeAt(0);header.write(row.link??'',157,100);Buffer.from([117,115,116,97,114,0,48,48]).copy(header,257);header.write(header.reduce((sum,value)=>sum+value,0).toString(8).padStart(6,'0')+'\0 ',148,8,'ascii');return[header,bytes,Buffer.alloc((512-bytes.length%512)%512)];}),Buffer.alloc(1024)]);}
function fixture(variant='valid'){
  const blobs=[],blob=(value,mediaType)=>{const bytes=Buffer.isBuffer(value)?value:Buffer.from(canonical(value)),digest='sha256:'+sha(bytes);blobs.push({path:'blobs/sha256/'+sha(bytes),body:bytes});return{mediaType,digest,size:bytes.length};};
  const extras=variant==='absolute-selected'?[{path:'opt/loopwright/node_modules/',type:'5'},{path:'opt/loopwright/node_modules/alias',type:'2',link:'/etc/passwd'}]:variant==='ancestor-link'?[{path:'opt/loopwright/node_modules',type:'2',link:'../other'},{path:'opt/loopwright/node_modules/child',body:'x'}]:[{path:'usr/',type:'5'},{path:'usr/alias',type:'2',link:'/proc/kcore'}];
  const raw=tar([{path:'opt/',type:'5'},{path:'opt/loopwright/',type:'5'},{path:'opt/loopwright/package.json',body:'{}'},...extras]),layer=blob(gzipSync(raw),'application/vnd.oci.image.layer.v1.tar+gzip');
  const config=blob({os:'linux',architecture:'arm64',config:{User:'1000:1000',Entrypoint:['node'],WorkingDir:'/opt/loopwright',Env:['HOME=/tmp/home','PI_OFFLINE=1']},rootfs:{type:'layers',diff_ids:['sha256:'+sha(raw)]}},'application/vnd.oci.image.config.v1+json');
  const manifest=blob({schemaVersion:2,mediaType:'application/vnd.oci.image.manifest.v1+json',config,layers:[layer]},'application/vnd.oci.image.manifest.v1+json');
  const empty={...blob({},'application/vnd.oci.empty.v1+json'),data:'e30='},proof={...blob({synthetic:true},'application/vnd.in-toto+json'),annotations:{'in-toto.io/predicate-type':'https://slsa.dev/provenance/v1'}};
  const side=blob({schemaVersion:2,mediaType:'application/vnd.oci.image.manifest.v1+json',artifactType:'application/vnd.docker.attestation.manifest.v1+json',config:empty,layers:[proof],subject:manifest},'application/vnd.oci.image.manifest.v1+json');
  const descriptors=[{...manifest,platform:{os:'linux',architecture:'arm64'}},{...side,platform:{os:'unknown',architecture:'unknown'},annotations:{'vnd.docker.reference.type':'attestation-manifest','vnd.docker.reference.digest':manifest.digest}}];
  if(variant==='ambiguous')descriptors[1]={...descriptors[0]};
  if(variant==='association')descriptors[1].annotations['vnd.docker.reference.digest']='sha256:'+'a'.repeat(64);
  if(variant==='descriptor')descriptors[0].size++;
  if(variant==='config'){const row=blobs.find(row=>row.path.endsWith(config.digest.slice(7)));row.body=Buffer.from('X'.repeat(config.size));}
  const root=blob({schemaVersion:2,mediaType:'application/vnd.oci.image.index.v1+json',manifests:descriptors},'application/vnd.oci.image.index.v1+json');
  return{bytes:tar([{path:'oci-layout',body:'{"imageLayoutVersion":"1.0.0"}'},{path:'index.json',body:canonical({schemaVersion:2,manifests:[root]})},...blobs]),expected:{image:variant==='root'?'sha256:'+'b'.repeat(64):root.digest,diffIds:['sha256:'+sha(raw)]}};
}
async function inspect(fixture){const directory=mkdtempSync(resolve('.claude/s04-development/oci-controls-')),input=exclusive(join(directory,'archive.tar'),fixture.bytes);return inspectImageArchive(input,fixture.expected,directory);}
test('OCI: pinned index binds one arm64 manifest, distinct config and an associated opaque attestation',async()=>{const result=await inspect(fixture());assert.equal(result.completed,true);assert.equal(result.layout.pinnedIdentity,'descriptor');assert.equal(result.layout.associatedAttestations.length,1);assert.match(result.layout.associatedAttestations[0].scope,/NOT_VERIFIED/);});
for(const variant of ['ambiguous','association','descriptor','config','root','absolute-selected','ancestor-link'])test('OCI: rejects '+variant+' substitution',async()=>assert.rejects(inspect(fixture(variant)),/QUALIFICATION_IMAGE_/));
const actual=resolve('.claude/s04-qualification/delivery-preflight-002/cli-2.tar');
test('OCI: actual original retained Docker save parses through exact root/manifest/config/diffID lineage',{skip:!existsSync(actual)},async()=>{
  const info=JSON.parse(readFileSync(resolve('.claude/s04-qualification/delivery-preflight-002/cli-1.stdout.bin')))[0],directory=mkdtempSync(resolve('.claude/s04-development/oci-actual-'));
  const result=await inspectImageArchive({path:actual,byteLength:116688896,sha256:'f1be6cb2de567f31bbd57f389af14b9f4f5c609f51c3a8b58e2b8c1c21556481'},{image:info.Id,diffIds:info.RootFS.Layers},directory,null,{path:resolve('.claude/s04-development/oci-actual-B3HDyb/image-final-index.json'),byteLength:12838,sha256:'cd5f679afaef9b1ad2b74d079579bb6b6af71d53f1c0ff506daf5c34cb128ee3'});
  assert.equal(result.completed,true);assert.equal(result.layout.configDescriptor.digest,'sha256:8c264acc5f2352b1fbc4f6c3f703b8aa6ca53ff4229088265b58a65f7da0dfcc');assert.equal(result.layout.pinnedImage,info.Id);
});

test('OCI: exact Node exception is bounded by path/layer and never extends selected hardlink/deferred payload size',()=>{
  const layer='a8095a8cfac3173101d798f43eceff12c9261ea4b1e82ec40dbfeef67a667fd5';
  assert.equal(imageRegularFileLimit('usr/local/bin/node',layer),150328456);
  assert.doesNotThrow(()=>assertImageRegularFileSize('usr/local/bin/node',layer,150328456));
  assert.throws(()=>assertImageRegularFileSize('usr/local/bin/node',layer,150328457),/FILE_LIMIT/);
  assert.throws(()=>assertImageRegularFileSize('usr/local/bin/other',layer,134217729),/FILE_LIMIT/);
  for(const [path,digest]of [['usr/local/bin/other',layer],['usr/local/bin/node','0'.repeat(64)],['opt/loopwright/node_modules/node',layer]])assert.equal(imageRegularFileLimit(path,digest),134217728);
  assert.doesNotThrow(()=>assertSelectedImageFileSize('opt/loopwright/node_modules/node',134217728));
  assert.throws(()=>assertSelectedImageFileSize('opt/loopwright/node_modules/node',134217729),/FILE_LIMIT/);
  assert.throws(()=>assertSelectedImageFileSize('opt/loopwright/node_modules/node',150328456),/FILE_LIMIT/);
});

test('OCI: immutable decoded data reuse still parses current bytes and refuses wrong image or corrupted cached body',async()=>{
  const f=fixture(),first=await inspect(f),cache=first.result,newDir=()=>mkdtempSync(resolve('.claude/s04-development/oci-cache-control-'));
  const current=newDir(),input=exclusive(join(current,'archive.tar'),f.bytes),again=await inspectImageArchive(input,f.expected,current,null,cache);assert.equal(again.completed,true);assert.ok(again.state.reusedChunks>0);
  const index=JSON.parse(checkedRef(cache)),wrongDir=newDir(),wrong=exclusive(join(wrongDir,'wrong.json'),{...index,layout:{...index.layout,pinnedImage:'sha256:'+'0'.repeat(64)}}),target=newDir();
  await assert.rejects(inspectImageArchive(exclusive(join(target,'archive.tar'),f.bytes),f.expected,target,null,wrong),/CACHE_IDENTITY/);
  const badDir=newDir(),rows=index.chunks.flatMap(ref=>JSON.parse(checkedRef(ref))),changed=rows.map((ref,i)=>{
    const bytes=checkedRef(ref),body=i===0?Buffer.from('X'.repeat(bytes.length)):bytes,copy=exclusive(join(badDir,'image-chunk-'+ref.sha256+'.bin'),body);return{...copy,sha256:ref.sha256};
  }),bad=exclusive(join(badDir,'index.json'),{...index,chunks:[exclusive(join(badDir,'chunks.json'),changed)]}),badTarget=newDir();
  await assert.rejects(inspectImageArchive(exclusive(join(badTarget,'archive.tar'),f.bytes),f.expected,badTarget,null,bad),/QUALIFICATION_(?:EVIDENCE|BYTES|IMAGE_CACHE)/);
});

test('OCI: Docker Linux symlink mode is explicit while target, uid/gid and regular-file mode stay exact',()=>{
  const source={path:'node_modules/link',kind:'symlink',mode:0o755,target:'pkg/file'},image={...source,mode:0o777,uid:0,gid:0};
  assert.doesNotThrow(()=>compareImagePayload([image],[source]));
  assert.throws(()=>compareImagePayload([{...image,mode:0o755}],[source]),/PAYLOAD_IDENTITY/);
  assert.throws(()=>compareImagePayload([{...image,target:'other'}],[source]),/PAYLOAD_LINK/);
  const file={path:'package.json',kind:'file',mode:0o644,byteLength:2,sha256:sha('{}')};
  assert.throws(()=>compareImagePayload([{...file,mode:0o755,uid:0,gid:0}],[file]),/PAYLOAD_IDENTITY/);
});
