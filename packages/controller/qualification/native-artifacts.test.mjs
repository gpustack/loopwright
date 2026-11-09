/* global Buffer */
import assert from 'node:assert/strict';
import test,{after} from 'node:test';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,rmSync} from 'node:fs';
import {join,dirname} from 'node:path';
import {tmpdir} from 'node:os';
import {retainArtifacts} from './native-app.mjs';
import {sha} from './native-context.mjs';
const root=mkdtempSync(join(tmpdir(),'loopwright-artifact-retention-')),artifacts=join(root,'artifacts');mkdirSync(artifacts,{mode:0o700});after(()=>rmSync(root,{recursive:true}));
const registration={descriptorRef:{path:join(root,'run.json')}},retained=[];
const terminal={retainArtifact(path,byteLength,digest){const bytes=readFileSync(path);assert.equal(bytes.length,byteLength);assert.equal(sha(bytes),digest);retained.push(path);}};
function put(kind,value){const bytes=Buffer.isBuffer(value)?value:Buffer.from(JSON.stringify(value)),name=kind+'-'+sha(bytes)+'.bin';writeFileSync(join(artifacts,name),bytes,{mode:0o600});return {name,byteLength:bytes.length,digest:{algorithm:'sha256',hex:sha(bytes)}};}
const logical=(name,ref)=>({...ref,name});
const manifest=entries=>({apiVersion:'loopwright.dev/v1alpha1',kind:'ArtifactManifest',metadata:{id:'candidate'},spec:{entries}});

test('retain real backing blobs and captures without opening logical candidate paths or parsing file contents',()=>{
  const forged={name:'result.json',byteLength:0,digest:{algorithm:'sha256',hex:sha('')}},blob=put('source-file',forged),candidate=logical('result.json',blob),manifestRef=put('manifest',manifest([candidate]));
  const inventory=put('source',{version:1,manifest:manifestRef,entries:[{name:candidate.name,mode:'100644',oid:'a'.repeat(40),ref:candidate,artifact:blob}]});
  const capture={name:'pi-checkpoints/pi.'+'a'.repeat(40)+'.workspace.ndjson',byteLength:3,digest:{algorithm:'sha256',hex:sha('[]\n')}};
  mkdirSync(dirname(join(artifacts,capture.name)),{mode:0o700});writeFileSync(join(artifacts,capture.name),'[]\n',{mode:0o600});
  retainArtifacts(terminal,registration,{source:inventory,workspace:capture});
  assert.deepEqual(new Set(retained),new Set([inventory.name,manifestRef.name,blob.name,capture.name].map(name=>join(artifacts,name))));
});

test('logical manifest filenames resembling internal artifact names remain logical',()=>{
  const body=put('source-file',Buffer.from('body')),entry=logical('result-'+'f'.repeat(64)+'.bin',body),ref=put('manifest',manifest([entry]));
  const before=retained.length;retainArtifacts(terminal,registration,ref);assert.equal(retained.length,before+1);
});

test('missing actual store refs, traversal paths and mismatched logical-to-blob bindings refuse',()=>{
  const ref={name:'source-'+'e'.repeat(64)+'.bin',byteLength:0,digest:{algorithm:'sha256',hex:sha('')}};
  assert.throws(()=>retainArtifacts(terminal,registration,ref),{code:'ENOENT'});
  assert.throws(()=>retainArtifacts(terminal,registration,{...ref,name:'../result.json'}),/QUALIFICATION_PUBLIC_ARTIFACT/);
  assert.throws(()=>retainArtifacts(terminal,registration,{name:'result.json',mode:'100644',oid:'a'.repeat(40),ref:logical('result.json',ref),artifact:{...ref,byteLength:1}}),/QUALIFICATION_PUBLIC_ARTIFACT/);
});


test('verifier parameters and compiled handler plans are opaque retained bytes',()=>{
  const expected={name:'result.json',byteLength:0,digest:{algorithm:'sha256',hex:sha('')}},refs=[put('verifier-output',{binding:{parameters:{expected}}}),put('plan',{handler:{parameters:{expected}}})];
  const before=retained.length;retainArtifacts(terminal,registration,refs);assert.equal(retained.length,before+2);
});
