/* global Buffer */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, lstatSync, chmodSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { exclusive, canonical, sha, monotonic } from './native-context.mjs';
import { verifyPrivateInventory } from './native-preflight-launcher.mjs';
const identity=stat=>[stat.dev,stat.ino,stat.uid,stat.gid,stat.mode,stat.nlink,stat.size,stat.mtimeNs,stat.ctimeNs].map(String).join(':');
function fixture(changed=false){
  const directory=mkdtempSync(resolve('.claude/s04-development/loader-')),path=resolve('package.json'),stat=lstatSync(path,{bigint:true}),bytes=readFileSync(path);
  const entries=[{path:'package.json',kind:'file',mode:Number(stat.mode&0o777n),byteLength:bytes.length,sha256:sha(bytes)}],observed=changed?'changed-source-identity':identity(stat);
  const shard=exclusive(join(directory,'entries.json'),entries),source=exclusive(join(directory,'sources.json'),[{path,identity:observed,afterIdentity:observed}]);
  return exclusive(join(directory,'index.json'),{version:1,project:resolve('.'),shards:[shard],sourceShards:[source],entriesDigest:sha(Buffer.from(canonical(entries))),totals:{entries:1,regularBytes:bytes.length,links:0}});
}
test('private loader: actual Node original reader accepts corrected0600 input bound to a current representative source',async()=>{
  const ref=fixture();assert.equal(Number(lstatSync(ref.path).mode&0o777),0o600);const result=await verifyPrivateInventory(ref,monotonic()+2000n);assert.equal(result.entries,1);
});
test('private loader: actual reader rejects0644 metadata and changed original source identity',async()=>{
  const publicRef=fixture();chmodSync(publicRef.path,0o644);await assert.rejects(verifyPrivateInventory(publicRef,monotonic()+2000n),/ORIGINAL_FILE/);
  await assert.rejects(verifyPrivateInventory(fixture(true),monotonic()+2000n),/INVENTORY_CHANGED/);
});
